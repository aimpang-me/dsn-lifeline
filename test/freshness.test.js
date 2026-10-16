import { test } from "node:test";
import assert from "node:assert/strict";
import { createHarness, liveBody, quietBody, staleBody, step, callTool } from "./harness.js";
import { buildXml } from "./xml.js";

async function openEurc(h) {
  h.life.health.configAt = h.clock.now();
  h.feed.body = liveBody(h, ["eurc"]);
  await step(h);
  await step(h);
  return h.life.contacts.contacts.eurc;
}

test("C-F1: stale, repeated, no-stations, and 9-dish snapshots are rejected with no state change", async () => {
  const h = createHarness();
  const contact = await openEurc(h);
  const before = structuredClone(h.life.contacts.contacts);
  const writes = h.storage.sqlWrites;
  const cases = [
    () => buildXml({ timestamp: h.clock.now() - 10 * 60 * 1000 }),
    () => buildXml({ timestamp: h.life.health.lastTimestamp }),
    () => buildXml({ timestamp: h.clock.now(), stationCount: 0, dishCount: 0 }),
    () => buildXml({ timestamp: h.clock.now(), dishCount: 9 }),
  ];
  for (const body of cases) {
    h.feed.body = body;
    await h.life.alarm();
    h.clock.advance(60_000);
  }
  assert.equal(JSON.stringify(h.life.contacts.contacts), JSON.stringify(before));
  assert.equal(h.life.contacts.contacts.eurc.id, contact.id);
  assert.equal(h.life.contacts.contacts.eurc.open, true);
  assert.equal(h.storage.sqlWrites, writes + 4);
});

test("C-F2: ten rejected polls leave a talking contact open", async () => {
  const h = createHarness();
  await openEurc(h);
  h.feed.body = staleBody(h);
  for (let i = 0; i < 10; i++) {
    await h.life.alarm();
    h.clock.advance(60_000);
  }
  assert.equal(h.life.contacts.contacts.eurc.open, true);
});

test("C-F3: backoff is 60s, then 5 min after 5 failures, then 15 min after 60 min, then 60s", async () => {
  const h = createHarness();
  h.life.health.configAt = h.clock.now();
  h.feed.status = 500;
  h.feed.body = "nope";
  const intervals = [];
  for (let i = 0; i < 4; i++) {
    await h.life.alarm();
    intervals.push(h.storage.alarm - h.clock.now());
    h.clock.advance(h.storage.alarm - h.clock.now());
  }
  assert.ok(intervals.every((ms) => ms === 60_000), intervals.join(","));
  await h.life.alarm();
  assert.equal(h.storage.alarm - h.clock.now(), 5 * 60_000);
  const start = h.life.health.failureStartedAt;
  while (h.clock.now() - start < 60 * 60_000) {
    h.clock.advance(h.storage.alarm - h.clock.now());
    await h.life.alarm();
  }
  assert.equal(h.storage.alarm - h.clock.now(), 15 * 60_000);
  h.feed.status = 200;
  h.feed.body = quietBody(h);
  h.clock.advance(h.storage.alarm - h.clock.now());
  await h.life.alarm();
  assert.equal(h.storage.alarm - h.clock.now(), 60_000);
});

test("C-F4: six hours without a good snapshot sends exactly one system push", async () => {
  const h = createHarness();
  h.life.health.configAt = h.clock.now();
  h.feed.body = quietBody(h);
  await h.life.alarm();
  const goodAt = h.life.health.lastGoodAt;
  h.feed.status = 500;
  let seenAt = null;
  for (let i = 0; i < 40; i++) {
    h.clock.advance(h.storage.alarm - h.clock.now());
    await h.life.alarm();
    const stale = h.life.read("SELECT id FROM alert WHERE kind = 'stale'");
    if (stale.length === 1 && seenAt == null) seenAt = h.clock.now();
  }
  const stale = h.life.read("SELECT id FROM alert WHERE kind = 'stale'").map((row) => String(row.id));
  assert.equal(stale.filter((id) => !id.endsWith(":retry")).length, 1);
  assert.ok(stale.length <= 2);
  assert.ok(Math.abs(seenAt - (goodAt + 6 * 60 * 60_000)) <= 15 * 60_000);
  h.feed.status = 200;
  h.feed.body = quietBody(h);
  h.clock.advance(h.storage.alarm - h.clock.now());
  await h.life.alarm();
  h.feed.status = 500;
  const before = new Set(h.life.read("SELECT id FROM alert WHERE kind = 'stale'").map((row) => String(row.id)));
  while (h.clock.now() - h.life.health.lastGoodAt < 6 * 60 * 60_000 + 20 * 60_000) {
    h.clock.advance(h.storage.alarm - h.clock.now());
    await h.life.alarm();
  }
  const again = h.life.read("SELECT id FROM alert WHERE kind = 'stale'").filter((row) => !before.has(String(row.id)));
  assert.equal(again.filter((row) => !String(row.id).endsWith(":retry")).length, 1);
  assert.ok(again.length <= 2);
});

test("C-F5: three shape errors in 60 minutes send exactly one push", async () => {
  const h = createHarness();
  h.life.health.configAt = h.clock.now();
  h.feed.body = () => buildXml({ timestamp: h.clock.now(), dishes: [{ name: "DSS14", signals: [{ dir: "down", spacecraftID: "nope" }] }] });
  for (let i = 0; i < 3; i++) {
    await h.life.alarm();
    h.clock.advance(60_000);
  }
  const shape = () => h.life.read("SELECT id FROM alert WHERE kind = 'shape'");
  assert.equal(shape().length, 1);
  await h.life.alarm();
  assert.equal(shape().length, 1);
});

test("C-F6: coverage over the last 24 hours is within 2 points of the fake run", async () => {
  const h = createHarness();
  h.life.health.configAt = h.clock.now();
  let good = 0;
  const total = 48;
  for (let i = 0; i < total; i++) {
    const accept = i % 2 === 0;
    h.feed.body = accept ? quietBody(h) : staleBody(h);
    if (accept) good += 1;
    await h.life.alarm();
    h.clock.advance(60_000);
  }
  const status = await callTool(h, "source_status");
  const expected = (good / total) * 100;
  assert.ok(Math.abs(status.data.coverage_24h - expected) < 2, `${status.data.coverage_24h} vs ${expected}`);
});

test("C-F7: replaying the same snapshot writes 0 rows", async () => {
  const h = createHarness();
  h.life.health.configAt = h.clock.now();
  const xml = buildXml({ timestamp: h.clock.now(), dishes: [swfoDish()] });
  h.feed.body = xml;
  await h.life.acceptSnapshot(xml);
  const writes = h.storage.sqlWrites;
  await h.life.acceptSnapshot(xml);
  assert.equal(h.storage.sqlWrites, writes);
  assert.equal(h.life.health.lastTimestamp, h.clock.now());
});

function swfoDish() {
  return {
    name: "DSS14",
    targets: [{ id: "-231", name: "SWFO-L1" }],
    signals: [
      { dir: "down", signalType: "data", active: "true", debug: "DATA", dataRate: "0", spacecraft: "SWFO-L1", spacecraftID: "-231" },
      { dir: "up", signalType: "none", active: "false", debug: "IDLE", dataRate: "-1", spacecraft: "SWFO-L1", spacecraftID: "-231" },
    ],
  };
}
