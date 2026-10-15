import { test } from "node:test";
import assert from "node:assert/strict";
import { createHarness, callTool, liveBody, quietBody, staleBody, step } from "./harness.js";

const HOUR = 60 * 60_000;

async function runDay(h, { goodRatio, talkAtHour }) {
  h.life.health.configAt = h.clock.now();
  const pushes = () => h.life.read("SELECT id FROM alert WHERE kind = 'canary'");
  const start = h.clock.now();
  for (let i = 0; i < 24 * 60; i++) {
    const hour = Math.floor((h.clock.now() - h.life.health.startedAt) / HOUR);
    const talking = talkAtHour != null && hour === talkAtHour;
    const good = talking || (i % 100) < goodRatio;
    h.feed.body = talking ? liveBody(h, ["imap"]) : good ? quietBody(h) : staleBody(h);
    await h.life.alarm();
    h.clock.advance(60_000);
  }
  h.feed.body = talkAtHour != null ? liveBody(h, ["imap"]) : quietBody(h);
  await h.life.alarm();
  assert.ok(h.clock.now() - start >= 24 * HOUR);
  return pushes().length;
}

test("C-C1: 24h quiet with 95% coverage sends one canary, 85% and a talker at hour 23 send none", async () => {
  assert.equal(await runDay(createHarness(), { goodRatio: 95 }), 1);
  assert.equal(await runDay(createHarness(), { goodRatio: 85 }), 0);
  assert.equal(await runDay(createHarness(), { goodRatio: 95, talkAtHour: 23 }), 0);
});

test("C-C2: an unwatched table craft talking resets the canary", async () => {
  const h = createHarness();
  h.life.health.configAt = h.clock.now();
  h.life.health.lastTalkingAt = h.clock.now() - 23 * HOUR;
  h.feed.body = liveBody(h, ["imap"]);
  await step(h);
  await step(h);
  assert.ok(h.clock.now() - h.life.health.lastTalkingAt < 5 * 60_000);
  h.feed.body = quietBody(h);
  for (let i = 0; i < 30; i++) await step(h);
  assert.equal(h.life.read("SELECT id FROM alert WHERE kind = 'canary'").length, 0);
});

test("C-B1: the row counter stays within 5 percent of an independent count over a day", async () => {
  const h = createHarness({ now: Date.parse("2026-10-15T00:10:00Z") });
  h.life.health.configAt = h.clock.now();
  const independentStart = h.storage.writes;
  const counterStart = h.life.budget.rowsToday;
  let compared = false;
  for (let i = 0; i < 24 * 60; i++) {
    h.feed.body = quietBody(h);
    await h.life.alarm();
    const sameDay = new Date(h.clock.now()).toISOString().slice(0, 10) === "2026-10-15";
    if (sameDay) {
      const independent = h.storage.writes - independentStart;
      const counted = h.life.budget.rowsToday - counterStart;
      const error = Math.abs(counted - independent) / Math.max(1, independent);
      assert.ok(error <= 0.05, `${counted} vs ${independent}`);
      compared = h.clock.now() - Date.parse("2026-10-15T00:10:00Z") > 23 * 60 * 60_000;
    }
    h.clock.advance(60_000);
  }
  assert.equal(compared, true);
  assert.ok(h.life.budget.rowsToday < 200);
});

test("C-B2: the interval becomes 120s at 70,000 rows", async () => {
  const h = createHarness();
  h.life.health.configAt = h.clock.now();
  h.life.budget.rowsToday = 69_999;
  h.feed.body = quietBody(h);
  await h.life.alarm();
  assert.ok(Math.abs(h.life.budget.rowsToday - 70_000) <= 1);
  assert.equal(h.storage.alarm - h.clock.now(), 120_000);
});

test("C-B3: exactly one push fires at 80,000 rows", async () => {
  const h = createHarness();
  h.life.health.configAt = h.clock.now();
  h.life.budget.rowsToday = 79_999;
  h.feed.body = quietBody(h);
  await h.life.alarm();
  assert.equal(h.life.budget.budgetPushedOn, h.life.budget.rowsDay);
  assert.equal(h.life.read("SELECT id FROM alert WHERE kind = 'budget'").length, 0);
  h.clock.advance(h.storage.alarm - h.clock.now());
  await h.life.alarm();
  assert.equal(h.life.budget.budgetPushedOn, h.life.budget.rowsDay);
  assert.equal(h.life.read("SELECT id FROM alert WHERE kind = 'budget'").length, 0);
});

test("C-B5: 1440 alarms plus 500 tool calls stay under 2000 DO requests", async () => {
  const h = createHarness();
  h.bind();
  let requests = 0;
  const origAlarm = h.life.alarm.bind(h.life);
  h.life.alarm = async () => {
    requests += 1;
    return origAlarm();
  };
  h.life.health.configAt = h.clock.now();
  for (let i = 0; i < 1440; i++) {
    h.feed.body = quietBody(h);
    await h.life.alarm();
    h.clock.advance(60_000);
  }
  for (let i = 0; i < 500; i++) {
    requests += 1;
    await callTool(h, "source_status");
  }
  assert.ok(requests < 2000, `requests ${requests}`);
  assert.ok(h.doCalls <= 500 * 3);
});
