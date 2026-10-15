import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Lifeline } from "../src/lifeline.js";
import { createHarness, callTool, quietBody } from "./harness.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

test("an alert table from before the day column still queues a new alert", async () => {
  const h = createHarness();
  h.life.write("DROP TABLE alert");
  h.life.write(
    "CREATE TABLE alert (id TEXT PRIMARY KEY, kind TEXT NOT NULL, craft TEXT, dish TEXT, station TEXT, at INTEGER NOT NULL, expire_at INTEGER NOT NULL, status TEXT NOT NULL)",
  );
  h.life.write(
    "INSERT INTO alert (id, kind, craft, dish, station, at, expire_at, status) VALUES ('old-fav', 'fav', 'eurc', NULL, NULL, ?, ?, 'pending')",
    h.clock.now(),
    h.clock.now() + 20 * MIN,
  );
  h.life = new Lifeline(
    { storage: h.storage, clock: h.clock, fetchImpl: async () => new Response("", { status: 500 }), log: () => {} },
    h.env,
  );
  const names = h.life.read("PRAGMA table_info(alert)").map((row) => String(row.name));
  assert.ok(names.includes("day"));
  const queued = await callTool(h, "test_alert");
  assert.equal(queued.data.queued, true);
  assert.equal(h.life.read("SELECT id FROM alert WHERE kind = 'test'").length, 1);
});

test("pruning a stale alert does not raise that same anchor again", async () => {
  const h = createHarness();
  h.life.health.configAt = h.clock.now();
  h.life.health.lastGoodAt = h.clock.now() - 6 * HOUR;
  h.feed.status = 500;
  await h.life.alarm();
  assert.equal(h.life.read("SELECT id FROM alert WHERE kind = 'stale'").length, 1);
  h.life.write("UPDATE alert SET at = ? WHERE kind = 'stale'", h.clock.now() - 3 * DAY);
  h.clock.advance(Date.parse("2026-10-16T00:00:00Z") - h.clock.now());
  h.feed.status = 500;
  await h.life.alarm();
  assert.equal(h.life.read("SELECT id FROM alert WHERE kind = 'stale'").length, 0);
});

test("pruning a canary alert does not raise that same quiet spell again", async () => {
  const h = createHarness();
  h.life.health.configAt = h.clock.now();
  h.life.health.startedAt = h.clock.now() - 24 * HOUR;
  h.life.health.lastTalkingAt = null;
  h.feed.body = quietBody(h);
  await h.life.alarm();
  assert.equal(h.life.read("SELECT id FROM alert WHERE kind = 'canary'").length, 1);
  h.life.write("UPDATE alert SET at = ? WHERE kind = 'canary'", h.clock.now() - 3 * DAY);
  h.clock.advance(Date.parse("2026-10-16T00:00:00Z") - h.clock.now());
  h.feed.body = quietBody(h);
  await h.life.alarm();
  assert.equal(h.life.read("SELECT id FROM alert WHERE kind = 'canary'").length, 0);
});

test("the Limits section documents prune and local midnight", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const limits = readme.slice(readme.indexOf("## Limits"));
  assert.match(limits, /older than 2 days/);
  assert.match(limits, /local midnight/);
  assert.match(limits, /does not queue that stale or canary alert again/);
});
