import { test } from "node:test";
import assert from "node:assert/strict";
import { Lifeline } from "../src/lifeline.js";
import { createHarness, liveBody, step } from "./harness.js";

const MIN = 60_000;
const HOUR = 60 * MIN;

function insertPending(h, id) {
  h.life.write(
    "INSERT INTO alert (id, kind, craft, dish, station, at, expire_at, status, day) VALUES (?, 'test', NULL, NULL, NULL, ?, ?, 'pending', '2026-10-15')",
    id,
    h.clock.now(),
    h.clock.now() + 20 * MIN,
  );
}

test("ack_alerts of 101 ids stays inside the 100 parameter cap", () => {
  const h = createHarness();
  const ids = Array.from({ length: 101 }, (_, i) => `batch-${i}`);
  for (const id of ids) insertPending(h, id);
  const before = h.life.budget.rowsToday;
  const acked = h.life.alerts.ack(ids);
  assert.deepEqual(acked, ids);
  assert.equal(h.life.budget.rowsToday - before, 2);
  assert.equal(h.life.read("SELECT id FROM alert WHERE status = 'pending'").length, 0);
});

test("ack_alerts of 250 ids acks every id in batches of 100", () => {
  const h = createHarness();
  const ids = Array.from({ length: 250 }, (_, i) => `wide-${i}`);
  for (const id of ids) insertPending(h, id);
  const before = h.life.budget.rowsToday;
  const acked = h.life.alerts.ack(ids);
  assert.deepEqual(acked, ids);
  assert.equal(h.life.budget.rowsToday - before, 3);
  assert.equal(h.life.read("SELECT id FROM alert WHERE status = 'acked'").length, 250);
});

test("six legacy favourites count toward today's cap after the day column is added", async () => {
  const h = createHarness();
  h.life.write("DROP TABLE alert");
  h.life.write(
    "CREATE TABLE alert (id TEXT PRIMARY KEY, kind TEXT NOT NULL, craft TEXT, dish TEXT, station TEXT, at INTEGER NOT NULL, expire_at INTEGER NOT NULL, status TEXT NOT NULL)",
  );
  for (let i = 0; i < 6; i++) {
    h.life.write(
      "INSERT INTO alert (id, kind, craft, dish, station, at, expire_at, status) VALUES (?, 'fav', 'eurc', NULL, NULL, ?, ?, 'pending')",
      `legacy-${i}`,
      h.clock.now(),
      h.clock.now() + 20 * MIN,
    );
  }
  h.life = new Lifeline(
    { storage: h.storage, clock: h.clock, fetchImpl: h.life.fetchImpl, log: (entry) => h.logs.push(entry) },
    h.env,
  );
  h.life.health.configAt = h.clock.now();
  h.feed.body = liveBody(h, ["eurc"]);
  await step(h);
  h.feed.body = liveBody(h, ["eurc"]);
  await step(h);
  assert.equal(h.life.read("SELECT id FROM alert WHERE kind = 'fav'").length, 6);
});

test("a corrupt meta row, contact row, and watch row each log state_reset and continue", () => {
  const meta = createHarness();
  meta.storage.sql.exec("INSERT INTO meta (k, v) VALUES ('state', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", "{");
  const metaLife = new Lifeline(
    { storage: meta.storage, clock: meta.clock, fetchImpl: meta.life.fetchImpl, log: (entry) => meta.logs.push(entry) },
    meta.env,
  );
  assert.ok(meta.logs.some((entry) => entry.event === "state_reset"));
  assert.equal(metaLife.health.lastTimestamp, null);

  const contacts = createHarness();
  contacts.life.write(
    "INSERT INTO contact (code, id, open, opened_at, closed_at, polls_since_close, pushed) VALUES ('eurc', 'eurc:1', 1, ?, NULL, 0, 0)",
    contacts.clock.now(),
  );
  contacts.life.write(
    "INSERT INTO contact (code, id, open, opened_at, closed_at, polls_since_close, pushed) VALUES ('psyc', '', 1, ?, NULL, 0, 0)",
    contacts.clock.now(),
  );
  const contactLife = new Lifeline(
    { storage: contacts.storage, clock: contacts.clock, fetchImpl: contacts.life.fetchImpl, log: (entry) => contacts.logs.push(entry) },
    contacts.env,
  );
  assert.ok(contacts.logs.some((entry) => entry.event === "state_reset"));
  assert.equal(contactLife.contacts.contacts.eurc.open, true);
  assert.equal(contactLife.contacts.contacts.psyc, undefined);

  const watch = createHarness();
  watch.life.write("INSERT INTO watch (code, favourite, mute_until) VALUES ('!!!', 1, NULL)");
  const watchLife = new Lifeline(
    { storage: watch.storage, clock: watch.clock, fetchImpl: watch.life.fetchImpl, log: (entry) => watch.logs.push(entry) },
    watch.env,
  );
  assert.ok(watch.logs.some((entry) => entry.event === "state_reset"));
  assert.equal(watchLife.watchlist.rows.has("eurc"), true);
  assert.equal(watchLife.watchlist.rows.has("!!!"), false);
});

test("crossing 70,000 rows on a dead feed still saves the slow interval", async () => {
  const h = createHarness();
  h.life.health.configAt = h.clock.now();
  h.life.budget.rowsToday = 69_999;
  h.life.budget.lastBudgetPersist = h.clock.now();
  h.feed.status = 500;
  await h.life.alarm();
  const saved = JSON.parse(String(h.life.read("SELECT v FROM meta WHERE k = 'state'")[0].v));
  assert.ok(saved.rowsToday >= 70_000);
  const revived = new Lifeline(
    { storage: h.storage, clock: h.clock, fetchImpl: h.life.fetchImpl, log: (entry) => h.logs.push(entry) },
    h.env,
  );
  assert.equal(revived.interval(), 120_000);
});
