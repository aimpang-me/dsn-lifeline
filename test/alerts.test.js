import { test } from "node:test";
import assert from "node:assert/strict";
import { CRAFTS } from "../src/crafts.js";
import { createHarness, callTool, liveBody, quietBody, step } from "./harness.js";
import { buildXml } from "./xml.js";

const MIN = 60_000;
const HOUR = 60 * MIN;

async function confirm(h, codes) {
  h.feed.body = liveBody(h, codes);
  await step(h);
  h.feed.body = liveBody(h, codes);
  await step(h);
}

async function pending(h) {
  const res = await callTool(h, "pending_alerts");
  assert.equal(res.error, undefined);
  return res.data.alerts;
}

test("pending_alerts returns one favourite and the worker does not call ntfy", async () => {
  const h = createHarness();
  h.life.health.configAt = h.clock.now();
  await confirm(h, ["eurc"]);
  const alerts = await pending(h);
  assert.equal(alerts.length, 1);
  const alert = alerts[0];
  assert.equal(alert.kind, "fav");
  assert.equal(alert.craft, "Europa Clipper");
  assert.equal(alert.dish, "DSS14");
  assert.equal(alert.station, "Goldstone");
  assert.match(alert.id, /^fav:eurc:/);
  assert.match(alert.time, /^\d{1,2}:\d{2} (AM|PM)$/);
  assert.equal(h.fetches.some((f) => f.url.includes("ntfy.sh")), false);
  await confirm(h, ["eurc"]);
  assert.equal((await pending(h)).length, 1);
});

test("ack_alerts clears pending ids and ignores an unknown id", async () => {
  const h = createHarness();
  h.life.health.configAt = h.clock.now();
  await confirm(h, ["eurc"]);
  const id = (await pending(h))[0].id;
  const unknown = await callTool(h, "ack_alerts", { ids: ["missing-id"] });
  assert.deepEqual(unknown.data.acked, []);
  assert.equal((await pending(h)).length, 1);
  const acked = await callTool(h, "ack_alerts", { ids: [id, "missing-id"] });
  assert.deepEqual(acked.data.acked, [id]);
  assert.deepEqual(await pending(h), []);
  const again = await callTool(h, "ack_alerts", { ids: [id] });
  assert.deepEqual(again.data.acked, []);
});

test("ack_alerts rejects an empty id list", async () => {
  const h = createHarness();
  assert.equal((await callTool(h, "ack_alerts", { ids: [] })).error, "INVALID_INPUT");
  assert.equal((await callTool(h, "ack_alerts", {})).error, "INVALID_INPUT");
  assert.equal((await callTool(h, "pending_alerts", { extra: true })).error, "INVALID_INPUT");
});

test("an unacked favourite drops at 20 minutes and one retry is queued while it is still talking", async () => {
  const h = createHarness();
  h.life.health.configAt = h.clock.now();
  await confirm(h, ["eurc"]);
  const first = (await pending(h))[0];
  const row = h.life.read("SELECT at, expire_at FROM alert WHERE id = ?", first.id)[0];
  const expireAt = Number(row.expire_at);
  assert.equal(expireAt - Number(row.at), 20 * MIN);
  while (h.clock.now() < expireAt) {
    h.clock.advance(Math.min(MIN, expireAt - h.clock.now()));
    h.feed.body = liveBody(h, ["eurc"]);
    await h.life.alarm();
  }
  assert.deepEqual(await pending(h), []);
  const dropped = h.life.read("SELECT status FROM alert WHERE id = ?", first.id);
  assert.equal(String(dropped[0].status), "dropped");
  assert.ok(h.logs.some((line) => line.event === "alert_dropped"));
  h.clock.advance(MIN);
  h.feed.body = liveBody(h, ["eurc"]);
  await h.life.alarm();
  const alerts = await pending(h);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].id, `${first.id}:retry`);
  h.clock.advance(MIN);
  h.feed.body = liveBody(h, ["eurc"]);
  await h.life.alarm();
  assert.equal((await pending(h)).length, 1);
  assert.equal(h.fetches.some((f) => f.url.includes("ntfy.sh")), false);
});

test("the pending queue stays at 100 by dropping the oldest alert", async () => {
  const h = createHarness();
  h.life.health.configAt = h.clock.now();
  const expire = h.clock.now() + 20 * MIN;
  for (let i = 0; i < 100; i++) {
    h.life.write(
      "INSERT INTO alert (id, kind, craft, dish, station, at, expire_at, status, day) VALUES (?, 'shape', NULL, NULL, NULL, ?, ?, 'pending', ?)",
      `sys:shape:fill:${String(i).padStart(3, "0")}`,
      h.clock.now(),
      expire,
      "2026-10-15",
    );
  }
  await confirm(h, ["eurc"]);
  const alerts = await pending(h);
  assert.equal(alerts.length, 100);
  assert.equal(alerts.some((alert) => alert.kind === "fav"), true);
  assert.equal(alerts.some((alert) => alert.id === "sys:shape:fill:000"), false);
  const oldest = h.life.read("SELECT status FROM alert WHERE id = ?", "sys:shape:fill:000");
  assert.equal(String(oldest[0].status), "dropped");
});

test("test_alert enqueues one alert and does not count as a favourite", async () => {
  const h = createHarness();
  const res = await callTool(h, "test_alert");
  assert.equal(res.data.queued, true);
  const alerts = await pending(h);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].kind, "test");
  assert.equal(alerts[0].craft, null);
  assert.equal(alerts[0].dish, null);
  assert.equal(alerts[0].station, null);
  assert.equal(h.life.read("SELECT id FROM alert WHERE kind = 'fav'").length, 0);
  assert.equal(h.fetches.some((f) => f.url.includes("ntfy.sh")), false);
});

test("watch, mute, and unwatch do not enqueue alerts", async () => {
  const h = createHarness();
  await callTool(h, "watch_craft", { code: "imap", favourite: false });
  await callTool(h, "mute_craft", { code: "eurc", hours: 1 });
  await callTool(h, "unwatch_craft", { code: "psyc" });
  assert.equal(h.life.read("SELECT id FROM alert").length, 0);
});

test("stale, canary, and shape alerts are queued once", async () => {
  const stale = createHarness();
  stale.life.health.configAt = stale.clock.now();
  stale.life.health.lastGoodAt = stale.clock.now() - 6 * HOUR;
  stale.feed.status = 500;
  await stale.life.alarm();
  await stale.life.alarm();
  const staleAlerts = await pending(stale);
  assert.equal(staleAlerts.filter((alert) => alert.kind === "stale").length, 1);

  const shape = createHarness();
  shape.life.health.configAt = shape.clock.now();
  shape.feed.body = () => "<dsn><timestamp>nope</timestamp></dsn>";
  for (let i = 0; i < 4; i++) {
    await shape.life.alarm();
    shape.clock.advance(MIN);
  }
  assert.equal((await pending(shape)).filter((alert) => alert.kind === "shape").length, 1);

  const canary = createHarness();
  canary.life.health.configAt = canary.clock.now();
  canary.life.health.startedAt = canary.clock.now() - 24 * HOUR;
  canary.life.health.lastTalkingAt = null;
  canary.feed.body = quietBody(canary);
  await canary.life.alarm();
  await canary.life.alarm();
  assert.equal((await pending(canary)).filter((alert) => alert.kind === "canary").length, 1);
  assert.equal(canary.fetches.some((f) => f.url.includes("ntfy.sh")), false);
});

function favouriteIds(h) {
  return h.life.read("SELECT id FROM alert WHERE kind = 'fav'")
    .map((row) => String(row.id))
    .filter((id) => !id.endsWith(":retry"));
}

test("C-N1: one favourite push per local day, then one more after local midnight", async () => {
  const h = createHarness({ now: Date.parse("2026-10-16T02:00:00Z") });
  h.life.health.configAt = h.clock.now();
  for (let contact = 0; contact < 3; contact++) {
    await confirm(h, ["eurc"]);
    h.feed.body = quietBody(h);
    for (let i = 0; i < 3 + 16; i++) await step(h);
  }
  assert.equal(favouriteIds(h).length, 1);
  while (h.clock.now() < Date.parse("2026-10-16T04:10:00Z")) {
    h.feed.body = quietBody(h);
    await step(h);
  }
  await confirm(h, ["eurc"]);
  assert.equal(favouriteIds(h).length, 2);
});

test("C-N2: two crafts talking on the same day send two pushes whose keys contain the craft code", async () => {
  const h = createHarness();
  h.life.health.configAt = h.clock.now();
  await confirm(h, ["eurc", "psyc"]);
  const fav = h.life.read("SELECT id FROM alert WHERE kind = 'fav'").map((row) => String(row.id));
  assert.equal(fav.length, 2);
  assert.ok(fav.some((id) => id.includes("eurc")));
  assert.ok(fav.some((id) => id.includes("psyc")));
  assert.equal(favouriteIds(h).length, 2);
});

test("C-N3: chat and tool lines stay inside the fixed template", async () => {
  const h = createHarness();
  h.life.health.configAt = h.clock.now();
  await confirm(h, ["eurc"]);
  h.life.health.startedAt = h.clock.now() - 24 * HOUR;
  h.life.health.lastTalkingAt = null;
  h.feed.body = quietBody(h);
  await h.life.alarm();
  h.feed.body = () => buildXml({ timestamp: h.clock.now(), dishes: [{ name: "DSS14", signals: [{ dir: "down", spacecraftID: "nope" }] }] });
  for (let i = 0; i < 3; i++) {
    await h.life.alarm();
    h.clock.advance(MIN);
  }
  h.feed.status = 500;
  h.life.health.lastGoodAt = h.clock.now() - 6 * HOUR;
  await h.life.alarm();
  await callTool(h, "test_alert");
  const pending = await callTool(h, "pending_alerts");
  const now = await callTool(h, "dsn_now", { watched_only: true });
  const status = await callTool(h, "source_status");
  const muted = await callTool(h, "mute_craft", { code: "eurc", hours: 1 });
  const cleared = await callTool(h, "mute_craft", { code: "eurc", hours: 0 });
  const removed = await callTool(h, "unwatch_craft", { code: "eurc" });
  assert.deepEqual(pending.data.alerts.map((alert) => alert.kind).sort(), ["canary", "fav", "shape", "stale", "test"]);
  assert.equal(pending.text, JSON.stringify(pending.data.alerts));
  const blob = [pending.text, now.text, status.text, muted.text, cleared.text, removed.text].join("\n");
  assert.equal(/https?:|www\./i.test(blob), false);
  assert.equal(/\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/.test(blob), false);
  for (const alert of pending.data.alerts) {
    assert.equal(typeof alert.id, "string");
    assert.equal(typeof alert.kind, "string");
    assert.ok("craft" in alert && "dish" in alert && "station" in alert && "time" in alert);
    for (const value of [alert.id, alert.kind, alert.craft, alert.dish, alert.station, alert.time]) {
      if (value == null) continue;
      assert.equal(typeof value, "string");
      assert.equal(/https?:|www\./i.test(value), false, `${alert.kind} ${value}`);
    }
  }
});

test("C-N4: the push is at most 120s after the first active snapshot", async () => {
  const h = createHarness();
  h.life.health.configAt = h.clock.now();
  const first = h.clock.now();
  h.feed.body = liveBody(h, ["eurc"]);
  await step(h);
  h.feed.body = liveBody(h, ["eurc"]);
  await h.life.alarm();
  assert.equal(favouriteIds(h).length, 1);
  assert.ok(h.clock.now() - first <= 120_000);
});

test("C-N5: twenty favourite events send 6 pushes and never 7", async () => {
  const h = createHarness();
  h.life.health.configAt = h.clock.now();
  for (const craft of CRAFTS.slice(0, 20)) {
    h.storage.sql.exec(
      "INSERT INTO watch (code, favourite, mute_until) VALUES (?, 1, NULL) ON CONFLICT(code) DO UPDATE SET favourite = 1",
      craft.code,
    );
  }
  h.life.reloadWatch();
  const codes = CRAFTS.slice(0, 20).map((c) => c.code);
  await confirm(h, codes);
  for (let i = 0; i < 10; i++) await step(h);
  assert.equal(h.life.read("SELECT id FROM alert WHERE kind = 'fav'").length, 6);
});

test("C-N6: a favourite stays pending until 20 minutes, then drops, with no outbound retry", async () => {
  const h = createHarness();
  h.life.health.configAt = h.clock.now();
  h.feed.body = liveBody(h, ["eurc"]);
  await h.life.alarm();
  h.clock.advance(60_000);
  h.feed.body = liveBody(h, ["eurc"]);
  await h.life.alarm();
  const row = h.life.read("SELECT id, at, expire_at, status FROM alert WHERE kind = 'fav'")[0];
  assert.equal(String(row.status), "pending");
  assert.equal(Number(row.expire_at) - Number(row.at), 20 * MIN);
  const hostsBefore = h.fetches.length;
  while (h.clock.now() + MIN < Number(row.expire_at)) {
    h.clock.advance(MIN);
    h.feed.body = quietBody(h);
    await h.life.alarm();
    assert.equal(String(h.life.read("SELECT status FROM alert WHERE id = ?", row.id)[0].status), "pending");
  }
  h.clock.advance(Number(row.expire_at) - h.clock.now());
  h.feed.body = quietBody(h);
  await h.life.alarm();
  assert.equal(String(h.life.read("SELECT status FROM alert WHERE id = ?", row.id)[0].status), "dropped");
  assert.ok(h.logs.some((line) => line.event === "alert_dropped"));
  assert.equal(h.fetches.slice(hostsBefore).some((f) => f.url.includes("ntfy.sh")), false);
  assert.equal(h.fetches.some((f) => f.url.includes("ntfy.sh")), false);
});

test("C-N7: watch, unwatch, and mute do not enqueue alerts", async () => {
  const h = createHarness();
  const watched = await callTool(h, "watch_craft", { code: "imap", favourite: false });
  const muted = await callTool(h, "mute_craft", { code: "eurc", hours: 1 });
  const removed = await callTool(h, "unwatch_craft", { code: "psyc" });
  assert.equal(watched.error, undefined);
  assert.equal(muted.text, "Muted Europa Clipper.");
  assert.equal(removed.error, undefined);
  assert.equal(h.life.read("SELECT id FROM alert").length, 0);
});

test("C-N8: the 11th watch is refused, the 11th mute works, the 31st mute is refused", async () => {
  const h = createHarness();
  for (let i = 0; i < 10; i++) {
    const res = await callTool(h, "watch_craft", { code: "imap", favourite: i % 2 === 0 });
    assert.equal(res.error, undefined);
  }
  const refused = await callTool(h, "watch_craft", { code: "imap", favourite: true });
  assert.equal(refused.error, "RATE_LIMITED");
  for (let i = 0; i < 10; i++) {
    const res = await callTool(h, "mute_craft", { code: "eurc", hours: i % 2 === 0 ? 1 : 0 });
    assert.equal(res.error, undefined);
  }
  const eleventh = await callTool(h, "mute_craft", { code: "eurc", hours: 1 });
  assert.equal(eleventh.error, undefined);
  for (let i = 12; i <= 30; i++) {
    const res = await callTool(h, "mute_craft", { code: "eurc", hours: 1 });
    assert.equal(res.error, undefined, `mute ${i}`);
  }
  const thirtyFirst = await callTool(h, "mute_craft", { code: "eurc", hours: 1 });
  assert.equal(thirtyFirst.error, "RATE_LIMITED");
});

test("C-N9: a one hour mute suppresses a push at 59 minutes and allows one at 61", async () => {
  const h = createHarness();
  h.life.health.configAt = h.clock.now();
  await callTool(h, "mute_craft", { code: "eurc", hours: 1 });
  h.clock.advance(57 * MIN);
  h.feed.body = liveBody(h, ["eurc"]);
  await h.life.alarm();
  h.clock.advance(MIN);
  h.feed.body = liveBody(h, ["eurc"]);
  await h.life.alarm();
  assert.equal(favouriteIds(h).length, 0);
  h.clock.advance(3 * MIN);
  h.feed.body = liveBody(h, ["eurc"]);
  await h.life.alarm();
  assert.equal(favouriteIds(h).length, 1);
});
