import { CRAFTS, CRAFT_BY_CODE } from "./crafts.js";
import { Mcp } from "./mcp.js";
import { ROW_CAP } from "./budget.js";
import { Time, MINUTE, HOUR } from "./time.js";

const CODE_RE = /^[a-z0-9]{2,12}$/;

/**
 * @typedef {import("./lifeline.js").Lifeline} Life
 * @typedef {import("./protocol.js").ToolDef} ToolDef
 * @typedef {{ name: string, description: string, inputSchema: Record<string, unknown>, fields: string[], bucket: "watch" | "mute" | "unwatch", limit: number, invalid?: (args: Record<string, unknown>) => string | null, blocked: (life: Life, code: string, args: Record<string, unknown>) => string | null, act: (life: Life, code: string, args: Record<string, unknown>) => unknown }} CraftSpec
 */

/** @param {Life} life @returns {ToolDef[]} */
export function toolSpecs(life) {
  return [
    spec("dsn_now", "List watched crafts, or every talking craft, from the local table.", { type: "object", properties: { watched_only: { type: "boolean" } }, required: ["watched_only"], additionalProperties: false }, (args) => dsnNow(life, args)),
    spec("watchlist", "Show watched crafts, favourite flags, and mute end times.", { type: "object", properties: {}, additionalProperties: false }, (args) => watchlist(life, args)),
    craft(life, {
      name: "watch_craft",
      description: "Watch a craft from the local table.",
      inputSchema: { type: "object", properties: { code: { type: "string" }, favourite: { type: "boolean" } }, required: ["code", "favourite"], additionalProperties: false },
      fields: ["code", "favourite"],
      bucket: "watch",
      limit: 10,
      invalid: (args) => (typeof args.favourite !== "boolean" ? "INVALID_INPUT" : null),
      blocked: (host, code) => (!host.watchlist.has(code) && host.watchlist.size >= 12 ? "TOO_MANY_WATCHED" : null),
      act: (host, code, args) => {
        host.store.write("INSERT INTO watch (code, favourite, mute_until) VALUES (?, ?, NULL) ON CONFLICT(code) DO UPDATE SET favourite = excluded.favourite", code, args.favourite ? 1 : 0);
        host.watchlist.reload();
        return Mcp.ok("watchlist", { crafts: host.watchlist.view() });
      },
    }),
    craft(life, {
      name: "unwatch_craft",
      description: "Stop watching a craft.",
      inputSchema: { type: "object", properties: { code: { type: "string" } }, required: ["code"], additionalProperties: false },
      fields: ["code"],
      bucket: "unwatch",
      limit: 30,
      blocked: (host, code) => (host.watchlist.has(code) ? null : "NOT_WATCHED"),
      act: (host, code) => {
        host.store.write("DELETE FROM watch WHERE code = ?", code);
        host.watchlist.reload();
        host.alerts.dropPendingFavourites(code);
        return Mcp.ok("watchlist", { crafts: host.watchlist.view() });
      },
    }),
    craft(life, {
      name: "mute_craft",
      description: "Mute talking alerts for a watched craft. Hours from 0 to 720. Zero clears the mute.",
      inputSchema: { type: "object", properties: { code: { type: "string" }, hours: { type: "integer", minimum: 0, maximum: 720 } }, required: ["code", "hours"], additionalProperties: false },
      fields: ["code", "hours"],
      bucket: "mute",
      limit: 30,
      invalid: (args) => (typeof args.hours !== "number" || !Number.isInteger(args.hours) || args.hours < 0 || args.hours > 720 ? "INVALID_INPUT" : null),
      blocked: (host, code) => (host.watchlist.has(code) ? null : "NOT_WATCHED"),
      act: (host, code, args) => {
        const hours = /** @type {number} */ (args.hours);
        const muteUntil = hours === 0 ? null : host.clock.now() + hours * HOUR;
        host.store.write("UPDATE watch SET mute_until = ? WHERE code = ?", muteUntil, code);
        host.watchlist.reload();
        if (hours > 0) host.alerts.dropPendingFavourites(code);
        const name = CRAFT_BY_CODE.get(code)?.name ?? code;
        const body = hours === 0 ? `Mute cleared for ${name}.` : `Muted ${name}.`;
        return Mcp.ok(body, { code, mute_end: muteUntil });
      },
    }),
    spec("source_status", "Report feed freshness, coverage, backoff, and the row budget.", { type: "object", properties: {}, additionalProperties: false }, (args) => sourceStatus(life, args)),
    spec("pending_alerts", "List unacknowledged alerts. Each has id, kind, craft, dish, station, and time.", { type: "object", properties: {}, additionalProperties: false }, (args) => pendingAlerts(life, args)),
    spec("ack_alerts", "Mark alerts acknowledged by id after they have been told to the user.", { type: "object", properties: { ids: { type: "array", items: { type: "string" } } }, required: ["ids"], additionalProperties: false }, (args) => ackAlerts(life, args)),
    spec("test_alert", "Queue one fixed test alert. It does not count as a favourite alert.", { type: "object", properties: {}, additionalProperties: false }, (args) => testAlert(life, args)),
  ];
}

/**
 * @param {string} name
 * @param {string} description
 * @param {Record<string, unknown>} inputSchema
 * @param {(args: Record<string, unknown>) => unknown} run
 * @returns {ToolDef}
 */
function spec(name, description, inputSchema, run) {
  return { name, description, inputSchema, run };
}

/** @param {Life} life @param {CraftSpec} tool @returns {ToolDef} */
function craft(life, tool) {
  return spec(tool.name, tool.description, tool.inputSchema, (args) => {
    if (badShape(args, tool.fields)) return Mcp.error("INVALID_INPUT");
    const invalid = tool.invalid?.(args);
    if (invalid) return Mcp.error(invalid);
    const bad = craftCode(args.code);
    if (bad) return Mcp.error(bad);
    const code = String(args.code);
    const blocked = life.limiter.take(tool.bucket, tool.limit, () => tool.blocked(life, code, args));
    if (blocked) return Mcp.error(blocked);
    return tool.act(life, code, args);
  });
}

/** @param {Record<string, unknown>} args @param {string[]} allowed */
function badShape(args, allowed) {
  return Object.keys(args).some((key) => !allowed.includes(key));
}

/** @param {unknown} code */
function craftCode(code) {
  if (typeof code !== "string" || !CODE_RE.test(code)) return "INVALID_INPUT";
  if (!CRAFT_BY_CODE.has(code)) return "UNKNOWN_CRAFT";
  return null;
}

/** @param {Life} life @param {Record<string, unknown>} args */
function dsnNow(life, args) {
  if (badShape(args, ["watched_only"]) || typeof args.watched_only !== "boolean") return Mcp.error("INVALID_INPUT");
  const talking = new Set(Object.entries(life.contacts.contacts).filter(([, contact]) => contact.open).map(([code]) => code));
  const wanted = CRAFTS.filter((craftRow) => life.watchlist.has(craftRow.code) || (!args.watched_only && talking.has(craftRow.code)));
  const crafts = wanted.map((craftRow) => {
    const place = life.health.place.get(craftRow.code);
    return {
      code: craftRow.code,
      name: craftRow.name,
      dish: place?.dish ?? null,
      complex: place?.complex ?? null,
      talking: talking.has(craftRow.code) ? "yes" : "no",
    };
  });
  return Mcp.ok(crafts.map((craftRow) => [craftRow.code, craftRow.name, craftRow.dish ?? "", craftRow.complex ?? "", craftRow.talking].join(" ")).join("\n"), {
    snapshot_age_seconds: life.health.ageSeconds(life.clock.now()),
    crafts,
  });
}

/** @param {Life} life @param {Record<string, unknown>} args */
function watchlist(life, args) {
  if (badShape(args, [])) return Mcp.error("INVALID_INPUT");
  return Mcp.ok("watchlist", { crafts: life.watchlist.view() });
}

/** @param {Life} life @param {Record<string, unknown>} args */
function sourceStatus(life, args) {
  if (badShape(args, [])) return Mcp.error("INVALID_INPUT");
  const gap = life.poller.interval();
  const backoff = gap >= 15 * MINUTE ? "15m" : gap >= 5 * MINUTE ? "5m" : "60s";
  return Mcp.ok("status", {
    spec_version: 2,
    last_good_snapshot_age_seconds: life.health.ageSeconds(life.clock.now()),
    coverage_24h: life.health.coverage24(),
    failures: life.health.consecutiveFailures,
    backoff,
    rows_today: life.budget.rowsToday,
    budget_percent: (life.budget.rowsToday / ROW_CAP) * 100,
    canary: life.health.canarySent ? "sent" : "armed",
    last_config_fetch: life.health.configAt,
  });
}

/** @param {Life} life @param {Record<string, unknown>} args */
function pendingAlerts(life, args) {
  if (badShape(args, [])) return Mcp.error("INVALID_INPUT");
  const alerts = life.alerts.pending().map((row) => alertView(life, row));
  return Mcp.ok(JSON.stringify(alerts), { alerts });
}

/** @param {Life} life @param {Record<string, unknown>} row */
function alertView(life, row) {
  const code = row.craft == null ? null : String(row.craft);
  return {
    id: String(row.id),
    kind: String(row.kind),
    craft: code == null ? null : (CRAFT_BY_CODE.get(code)?.name ?? code),
    dish: row.dish == null ? null : String(row.dish),
    station: row.station == null ? null : String(row.station),
    time: Time.format(Number(row.at), life.auth.timeZone),
  };
}

/** @param {Life} life @param {Record<string, unknown>} args */
function ackAlerts(life, args) {
  if (badShape(args, ["ids"]) || !Array.isArray(args.ids) || args.ids.length === 0) return Mcp.error("INVALID_INPUT");
  if (args.ids.some((id) => typeof id !== "string" || id.length === 0 || id.length > 80)) return Mcp.error("INVALID_INPUT");
  const acked = life.alerts.ack(/** @type {string[]} */ (args.ids));
  return Mcp.ok(JSON.stringify({ acked }), { acked });
}

/** @param {Life} life @param {Record<string, unknown>} args */
function testAlert(life, args) {
  if (badShape(args, [])) return Mcp.error("INVALID_INPUT");
  if (!life.auth.configured) return Mcp.error("NOT_CONFIGURED");
  const now = life.clock.now();
  const key = `sys:test:${life.limiter.testPushes}:${now}`;
  const queued = life.alerts.insert(key, "test", null, now, now + 20 * MINUTE);
  return Mcp.ok(JSON.stringify({ queued }), { queued });
}
