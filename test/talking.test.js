import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DsnScanner } from "../src/parser.js";
import { Talking } from "../src/talking.js";
import { CRAFTS } from "../src/crafts.js";
import { createHarness, liveBody, quietBody, staleBody, step } from "./harness.js";
import { buildXml, withTimestamp } from "./xml.js";

function load(name) {
  return readFileSync(new URL(`./fixtures/${name}.xml`, import.meta.url), "utf8");
}

test("C-T1: six fixtures classify from the signal spacecraftID", () => {
  const expectCodes = (name, codes) => {
    const parsed = DsnScanner.parse(load(name));
    assert.equal(parsed.ok, true, name);
    assert.deepEqual([...Talking.codes(parsed.snapshot, CRAFTS)].sort(), codes, name);
  };
  expectCodes("swfo-rate0", ["swfo"]);
  expectCodes("dss56-two-signals", ["swfo"]);
  expectCodes("duplicate-signal", ["swfo"]);
  expectCodes("swfo-negation", ["swfo"]);
  expectCodes("escb-negation", []);
  const first = Talking.codes(DsnScanner.parse(load("handover-1")).snapshot, CRAFTS);
  const second = Talking.codes(DsnScanner.parse(load("handover-2")).snapshot, CRAFTS);
  assert.deepEqual([...first], ["swfo"]);
  assert.deepEqual([...second], ["swfo"]);
});

test("C-T1 handover keeps one contact when the dish changes", async () => {
  const h = createHarness();
  h.life.health.configAt = h.clock.now();
  h.storage.sql.exec("INSERT INTO watch (code, favourite, mute_until) VALUES ('swfo', 1, NULL)");
  h.life.reloadWatch();
  const a = withTimestamp(load("handover-1"), h.clock.now());
  h.feed.body = a;
  await step(h);
  const b = withTimestamp(load("handover-2"), h.clock.now());
  h.feed.body = b;
  await step(h);
  assert.equal(h.life.contacts.contacts.swfo.open, true);
  assert.equal(h.life.read("SELECT id FROM alert WHERE id LIKE 'fav:swfo:%'").length, 1);
  const id = h.life.contacts.contacts.swfo.id;
  h.feed.body = withTimestamp(load("handover-1"), h.clock.now());
  await step(h);
  assert.equal(h.life.contacts.contacts.swfo.id, id);
  assert.equal(h.life.read("SELECT id FROM alert WHERE id LIKE 'fav:swfo:%'").length, 1);
});

test("C-T2: inactive signals and uplink-only are not talking", () => {
  assert.equal(Talking.codes(DsnScanner.parse(load("eurc-inactive")).snapshot, CRAFTS).size, 0);
  assert.equal(Talking.codes(DsnScanner.parse(load("uplink-only")).snapshot, CRAFTS).size, 0);
});

test("C-T3: a gap of 14 good polls merges, 16 does not, and rejected polls do not count", async () => {
  const merged = await reopenAfter("eurc", 14, 0);
  assert.equal(merged.same, true);
  const split = await reopenAfter("psyc", 16, 0);
  assert.equal(split.same, false);
  const withRejects = await reopenAfter("eurc", 14, 5);
  assert.equal(withRejects.same, true);
});

async function reopenAfter(code, quietPolls, rejectedInside) {
  const h = createHarness();
  h.life.health.configAt = h.clock.now();
  h.feed.body = liveBody(h, [code]);
  await step(h);
  await step(h);
  const id = h.life.contacts.contacts[code].id;
  h.feed.body = quietBody(h);
  for (let i = 0; i < 3; i++) await step(h);
  assert.equal(h.life.contacts.contacts[code].open, false);
  for (let i = 0; i < quietPolls; i++) {
    h.feed.body = quietBody(h);
    await step(h);
    if (i === 2) {
      for (let r = 0; r < rejectedInside; r++) {
        h.feed.body = staleBody(h);
        await h.life.alarm();
        h.clock.advance(60_000);
      }
    }
  }
  h.feed.body = liveBody(h, [code]);
  await step(h);
  await step(h);
  return { same: h.life.contacts.contacts[code].id === id };
}

test("C-T4: 1440 quiet alarms persist one freshness row each and stay under 70,000", async () => {
  const h = createHarness();
  h.life.health.configAt = h.clock.now();
  h.feed.body = quietBody(h);
  await h.life.alarm();
  const start = h.storage.writes;
  for (let i = 0; i < 1440; i++) {
    // Advance first so each of the 1440 alarms accepts a new timestamp.
    h.clock.advance(60_000);
    h.feed.body = quietBody(h);
    await h.life.alarm();
  }
  const delta = h.storage.writes - start;
  assert.ok(delta >= 1440 * 2, `rows ${delta}`);
  assert.ok(delta <= 1440 * 2 + 50, `rows ${delta}`);
  assert.ok(h.life.budget.rowsToday < 70_000);
});

test("C-T5: a restart mid-contact does not send a second push", async () => {
  const h = createHarness();
  h.life.health.configAt = h.clock.now();
  h.feed.body = liveBody(h, ["eurc"]);
  await step(h);
  await step(h);
  assert.equal(h.life.read("SELECT id FROM alert WHERE kind = 'fav'").length, 1);
  const { Lifeline } = await import("../src/index.js");
  const revived = new Lifeline({ storage: h.storage, clock: h.clock, fetchImpl: h.life.fetchImpl, log: (e) => h.logs.push(e) }, h.env);
  revived.health.configAt = h.clock.now();
  h.life = revived;
  h.feed.body = liveBody(h, ["eurc"]);
  await step(h);
  await step(h);
  assert.equal(h.life.read("SELECT id FROM alert WHERE kind = 'fav'").length, 1);
});

test("C-T6: the bench prints median and p99 and does not assert a threshold", () => {
  const xml = buildXml({ timestamp: Date.now(), dishes: [{
    name: "DSS14",
    targets: [{ id: "-231", name: "SWFO-L1" }],
    signals: [{ dir: "down", signalType: "data", active: "true", dataRate: "0", spacecraftID: "-231", spacecraft: "SWFO-L1" }],
  }] });
  const samples = [];
  for (let i = 0; i < 30; i++) {
    const t0 = performance.now();
    const parsed = DsnScanner.parse(xml);
    Talking.codes(parsed.snapshot, CRAFTS);
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)];
  const p99 = samples[Math.min(samples.length - 1, Math.ceil(samples.length * 0.99) - 1)];
  console.log(JSON.stringify({ check: "C-T6", median_ms: Number(median.toFixed(3)), p99_ms: Number(p99.toFixed(3)) }));
  assert.equal(typeof median, "number");
  assert.equal(typeof p99, "number");
});
