import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CRAFTS } from "../src/crafts.js";
import { createHarness, callTool, liveBody, quietBody } from "./harness.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

async function confirm(h, codes) {
  h.feed.body = liveBody(h, codes);
  await h.life.alarm();
  h.clock.advance(MIN);
  h.feed.body = liveBody(h, codes);
  await h.life.alarm();
}

function systemRows(h) {
  return h.life.read("SELECT id, kind, status FROM alert WHERE kind IN ('stale', 'canary', 'shape')");
}

test("pending_alerts text is the alerts JSON so a text client can ack", async () => {
  const h = createHarness();
  h.life.health.configAt = h.clock.now();
  await confirm(h, ["eurc"]);
  const pending = await callTool(h, "pending_alerts");
  const alerts = JSON.parse(pending.text);
  assert.ok(Array.isArray(alerts));
  assert.deepEqual(alerts, pending.data.alerts);
  assert.equal(alerts.length, 1);
  for (const field of ["id", "kind", "craft", "dish", "station", "time"]) {
    assert.equal(Object.hasOwn(alerts[0], field), true, field);
  }
  assert.equal(alerts[0].kind, "fav");
  assert.equal(alerts[0].craft, "Europa Clipper");
  const ack = await callTool(h, "ack_alerts", { ids: [alerts[0].id] });
  assert.deepEqual(JSON.parse(ack.text), { acked: [alerts[0].id] });
  assert.deepEqual(JSON.parse(ack.text), ack.data);
  const queued = await callTool(h, "test_alert");
  assert.deepEqual(JSON.parse(queued.text), { queued: true });
  assert.deepEqual(JSON.parse(queued.text), queued.data);
});

test("a dropped stale alert is queued once more while the feed is still stale", async () => {
  const h = createHarness();
  h.life.health.configAt = h.clock.now();
  h.life.health.lastGoodAt = h.clock.now() - 6 * HOUR;
  h.feed.status = 500;
  await h.life.alarm();
  const first = h.life.read("SELECT id, expire_at FROM alert WHERE kind = 'stale'")[0];
  assert.ok(first);
  while (h.clock.now() < Number(first.expire_at)) {
    h.clock.advance(Math.min(MIN, Number(first.expire_at) - h.clock.now()));
    await h.life.alarm();
  }
  assert.equal(String(h.life.read("SELECT status FROM alert WHERE id = ?", first.id)[0].status), "dropped");
  await h.life.alarm();
  const rows = h.life.read("SELECT id FROM alert WHERE kind = 'stale'");
  assert.equal(rows.length, 2);
  assert.ok(rows.some((row) => String(row.id) === `${first.id}:retry`));
  await h.life.alarm();
  assert.equal(h.life.read("SELECT id FROM alert WHERE kind = 'stale'").length, 2);
});

test("a dropped shape alert is queued once more while the feed shape is still wrong", async () => {
  const h = createHarness();
  h.life.health.configAt = h.clock.now();
  h.feed.body = () => "<dsn><timestamp>nope</timestamp></dsn>";
  for (let i = 0; i < 3; i++) {
    await h.life.alarm();
    h.clock.advance(MIN);
  }
  const first = h.life.read("SELECT id, expire_at FROM alert WHERE kind = 'shape'")[0];
  assert.ok(first);
  while (h.clock.now() < Number(first.expire_at)) {
    h.clock.advance(Math.min(MIN, Number(first.expire_at) - h.clock.now()));
    await h.life.alarm();
  }
  assert.equal(String(h.life.read("SELECT status FROM alert WHERE id = ?", first.id)[0].status), "dropped");
  await h.life.alarm();
  const rows = h.life.read("SELECT id FROM alert WHERE kind = 'shape'");
  assert.equal(rows.length, 2);
  assert.ok(rows.some((row) => String(row.id) === `${first.id}:retry`));
  await h.life.alarm();
  assert.equal(h.life.read("SELECT id FROM alert WHERE kind = 'shape'").length, 2);
});

test("a dropped canary is queued once more while the quiet spell still holds", async () => {
  const h = createHarness();
  h.life.health.configAt = h.clock.now();
  h.life.health.startedAt = h.clock.now() - 24 * HOUR;
  h.life.health.lastTalkingAt = null;
  h.feed.body = quietBody(h);
  await h.life.alarm();
  const first = h.life.read("SELECT id, expire_at FROM alert WHERE kind = 'canary'")[0];
  assert.ok(first);
  while (h.clock.now() < Number(first.expire_at)) {
    h.clock.advance(Math.min(MIN, Number(first.expire_at) - h.clock.now()));
    h.feed.body = quietBody(h);
    await h.life.alarm();
  }
  assert.equal(String(h.life.read("SELECT status FROM alert WHERE id = ?", first.id)[0].status), "dropped");
  h.feed.body = quietBody(h);
  await h.life.alarm();
  const rows = h.life.read("SELECT id FROM alert WHERE kind = 'canary'");
  assert.equal(rows.length, 2);
  assert.ok(rows.some((row) => String(row.id) === `${first.id}:retry`));
  await h.life.alarm();
  assert.equal(h.life.read("SELECT id FROM alert WHERE kind = 'canary'").length, 2);
});

test("mute and unwatch drop pending favourite alerts for that craft", async () => {
  const h = createHarness();
  h.life.health.configAt = h.clock.now();
  await confirm(h, ["eurc", "psyc"]);
  await callTool(h, "mute_craft", { code: "eurc", hours: 1 });
  const afterMute = await callTool(h, "pending_alerts");
  assert.equal(afterMute.data.alerts.some((alert) => alert.craft === "Europa Clipper"), false);
  assert.equal(afterMute.data.alerts.some((alert) => alert.craft === "Psyche"), true);
  await callTool(h, "unwatch_craft", { code: "psyc" });
  const afterUnwatch = await callTool(h, "pending_alerts");
  assert.equal(afterUnwatch.data.alerts.some((alert) => alert.kind === "fav"), false);
  assert.equal(h.life.read("SELECT id FROM alert WHERE kind = 'fav' AND status = 'dropped'").length, 2);
});

test("the daily favourite cap counts dropped alerts", async () => {
  const h = createHarness();
  h.life.health.configAt = h.clock.now();
  const codes = CRAFTS.slice(0, 6).map((craft) => craft.code);
  for (const code of codes) {
    h.storage.sql.exec(
      "INSERT INTO watch (code, favourite, mute_until) VALUES (?, 1, NULL) ON CONFLICT(code) DO UPDATE SET favourite = 1",
      code,
    );
  }
  h.life.reloadWatch();
  await confirm(h, codes);
  assert.equal(h.life.read("SELECT id FROM alert WHERE kind = 'fav'").length, 6);
  const expireAt = Math.max(...h.life.read("SELECT expire_at FROM alert WHERE kind = 'fav'").map((row) => Number(row.expire_at)));
  while (h.clock.now() < expireAt) {
    h.clock.advance(Math.min(MIN, expireAt - h.clock.now()));
    h.feed.body = liveBody(h, codes);
    await h.life.alarm();
  }
  h.clock.advance(MIN);
  h.feed.body = liveBody(h, codes);
  await h.life.alarm();
  assert.equal(h.life.read("SELECT id FROM alert WHERE kind = 'fav'").length, 6);
});

test("the daily system cap counts dropped stale alerts and canary alerts", async () => {
  const h = createHarness();
  h.life.health.configAt = h.clock.now();
  h.life.health.startedAt = h.clock.now() - 24 * HOUR;
  h.life.health.lastTalkingAt = null;
  h.feed.body = quietBody(h);
  await h.life.alarm();
  assert.equal(h.life.read("SELECT id FROM alert WHERE kind = 'canary'").length, 1);
  h.feed.status = 500;
  for (let i = 0; i < 9; i++) {
    h.clock.advance(MIN);
    h.life.health.lastGoodAt = h.clock.now() - 6 * HOUR;
    await h.life.alarm();
  }
  assert.equal(systemRows(h).length, 10);
  h.clock.advance(MIN);
  h.life.health.lastGoodAt = h.clock.now() - 6 * HOUR;
  await h.life.alarm();
  assert.equal(systemRows(h).length, 10);

  const dropped = createHarness();
  dropped.life.health.configAt = dropped.clock.now();
  dropped.feed.status = 500;
  for (let i = 0; i < 10; i++) {
    dropped.clock.advance(MIN);
    dropped.life.health.lastGoodAt = dropped.clock.now() - 6 * HOUR;
    await dropped.life.alarm();
  }
  assert.equal(dropped.life.read("SELECT id FROM alert WHERE kind = 'stale'").length, 10);
  const expireAt = Math.max(...dropped.life.read("SELECT expire_at FROM alert WHERE kind = 'stale'").map((row) => Number(row.expire_at)));
  dropped.clock.advance(expireAt - dropped.clock.now());
  await dropped.life.alarm();
  dropped.clock.advance(MIN);
  dropped.life.health.lastGoodAt = dropped.clock.now() - 6 * HOUR;
  await dropped.life.alarm();
  assert.equal(dropped.life.read("SELECT id FROM alert WHERE kind = 'stale'").length, 10);
});

test("two test_alert calls at the same time each queue a row", async () => {
  const h = createHarness();
  const first = await callTool(h, "test_alert");
  const second = await callTool(h, "test_alert");
  assert.equal(first.data.queued, true);
  assert.equal(second.data.queued, true);
  assert.equal(h.life.read("SELECT id FROM alert WHERE kind = 'test'").length, 2);
});

test("alert rows older than 2 days are pruned once a day", async () => {
  const h = createHarness();
  h.life.health.configAt = h.clock.now();
  await callTool(h, "test_alert");
  const oldId = h.life.read("SELECT id FROM alert WHERE kind = 'test'")[0].id;
  h.life.write("UPDATE alert SET at = ? WHERE id = ?", h.clock.now() - 3 * DAY, oldId);
  h.clock.advance(MIN);
  await callTool(h, "test_alert");
  const freshId = h.life.read("SELECT id FROM alert WHERE kind = 'test' AND id != ?", oldId)[0].id;
  h.feed.body = quietBody(h);
  await h.life.alarm();
  const ids = () => h.life.read("SELECT id FROM alert").map((row) => String(row.id));
  assert.equal(ids().includes(String(oldId)), false);
  assert.equal(ids().includes(String(freshId)), true);
  h.life.write("UPDATE alert SET at = ? WHERE id = ?", h.clock.now() - 3 * DAY, freshId);
  await h.life.alarm();
  assert.equal(ids().includes(String(freshId)), true);
  const nextUtcDay = Date.parse("2026-10-16T00:00:00Z");
  h.clock.advance(nextUtcDay - h.clock.now());
  h.feed.body = quietBody(h);
  await h.life.alarm();
  assert.equal(ids().includes(String(freshId)), false);
});

test("the routine prompt skips a missing dish or station and documents local midnight", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const routine = readme.slice(readme.indexOf("## Assistant routine"), readme.indexOf("## Safety"));
  assert.match(routine, /dish or station is missing/);
  assert.match(routine, /is talking at <time>\./);
  assert.match(readme, /local midnight/);
  assert.match(readme, /new local day/);
});
