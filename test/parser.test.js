import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DsnScanner } from "../src/parser.js";
import { Talking } from "../src/talking.js";
import { CRAFTS } from "../src/crafts.js";
import { recordPoll } from "../gates/step0/src/extract.js";
import { buildXml, swfoDown, INJECTED } from "./xml.js";

const TS = 1_700_000_000_000;

function load(name) {
  return readFileSync(new URL(`./fixtures/${name}.xml`, import.meta.url), "utf8");
}

test("C-P5 and T1: twelve fixtures parse, 300 KB is rejected, 7 KB median is advisory", () => {
  const swfo = DsnScanner.parse(load("swfo-rate0"));
  assert.equal(swfo.ok, true);
  assert.equal(swfo.snapshot.signals.find((s) => s.spacecraftID === -231 && s.type === "downlink").dataRate, 0);
  assert.equal(swfo.snapshot.signals.find((s) => s.spacecraftID === -231 && s.type === "downlink").active, true);

  const two = DsnScanner.parse(load("dss56-two-signals"));
  assert.equal(two.ok, true);
  assert.deepEqual([...Talking.codes(two.snapshot, CRAFTS)].sort(), ["swfo"]);

  const dup = DsnScanner.parse(load("duplicate-signal"));
  assert.equal(dup.ok, true);
  assert.deepEqual([...Talking.codes(dup.snapshot, CRAFTS)], ["swfo"]);

  const hand1 = DsnScanner.parse(load("handover-1"));
  const hand2 = DsnScanner.parse(load("handover-2"));
  assert.equal(hand1.ok, true);
  assert.equal(hand2.ok, true);
  assert.deepEqual([...Talking.codes(hand1.snapshot, CRAFTS)], ["swfo"]);
  assert.deepEqual([...Talking.codes(hand2.snapshot, CRAFTS)], ["swfo"]);
  assert.notEqual(dishOf(hand1.snapshot, -231), dishOf(hand2.snapshot, -231));

  const eurc = DsnScanner.parse(load("eurc-inactive"));
  assert.equal(eurc.ok, true);
  assert.equal(Talking.codes(eurc.snapshot, CRAFTS).size, 0);

  const stale = DsnScanner.parse(load("stale-ts"));
  assert.equal(stale.ok, true);
  assert.equal(stale.snapshot.timestamp, 1_600_000_000_000);

  const none = DsnScanner.parse(load("no-stations"));
  assert.equal(none.ok, true);
  assert.equal(none.snapshot.stationCount, 0);

  const bad = DsnScanner.parse(load("bad-numbers"));
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, "SHAPE");

  const huge = DsnScanner.parse("x".repeat(300 * 1024));
  assert.equal(huge.ok, false);
  assert.equal(huge.reason, "TOO_LARGE");

  const injected = DsnScanner.parse(load("injected-name"));
  assert.equal(injected.ok, true);
  assert.equal(JSON.stringify(Talking.codes(injected.snapshot, CRAFTS)).includes(INJECTED), false);

  const neg = DsnScanner.parse(load("swfo-negation"));
  assert.equal(neg.ok, true);
  assert.deepEqual([...Talking.codes(neg.snapshot, CRAFTS)], ["swfo"]);
  assert.equal(neg.snapshot.signals.some((s) => s.spacecraftID === -231), true);
  assert.equal(neg.snapshot.targets.some((t) => t.id === -231), false);
  assert.equal(neg.snapshot.signals.some((s) => s.spacecraftID === -999), false);

  const escb = DsnScanner.parse(load("escb-negation"));
  assert.equal(escb.ok, true);
  assert.equal(escb.snapshot.signals.some((s) => s.spacecraftID === -80), true);
  assert.equal(escb.snapshot.signals.some((s) => s.spacecraftID === -9), false);
  assert.equal(Talking.codes(escb.snapshot, CRAFTS).has("swfo"), false);

  const seven = buildXml({ timestamp: TS, dishes: [swfoDown()] });
  const padded = `${seven}<!--${"a".repeat(7000)}-->`;
  assert.ok(Buffer.byteLength(padded) >= 7000);
  const samples = [];
  for (let i = 0; i < 21; i++) {
    const t0 = performance.now();
    const parsed = DsnScanner.parse(padded);
    samples.push(performance.now() - t0);
    assert.equal(parsed.ok, true);
  }
  samples.sort((a, b) => a - b);
  const median = samples[10];
  console.log(JSON.stringify({ check: "C-P5", median_ms: Number(median.toFixed(3)), advisory_under_ms: 2 }));
  assert.equal(DsnScanner.parse(padded).reason, undefined);
});

test("comments and processing instructions do not hide the snapshot", () => {
  const xml = `<?xml version="1.0"?><!-- kept out of the snapshot -->${buildXml({ timestamp: TS })}`;
  const parsed = DsnScanner.parse(xml);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.snapshot.timestamp, TS);
  assert.equal(JSON.stringify(parsed.snapshot).includes("kept out"), false);
});

test("dish activity is copied onto its signals, including two active downSignals at dataRate 0", () => {
  const live = DsnScanner.parse(load("live-dish-activity"));
  assert.equal(live.ok, true);
  const eurc = live.snapshot.signals.filter((s) => s.type === "downlink" && s.spacecraftID === -159 && s.active);
  assert.equal(eurc.length, 2);
  assert.ok(eurc.every((s) => s.dataRate === 0));
  assert.ok(eurc.every((s) => s.activity === "MSPA"));
  assert.deepEqual([...Talking.codes(live.snapshot, CRAFTS)].sort(), ["eurc", "psyc"]);
  const psyche = live.snapshot.signals.find((s) => s.spacecraftID === -255 && s.type === "downlink");
  assert.equal(psyche.activity, "Downlink");
  assert.equal(psyche.dataRate, 0);
  assert.equal(psyche.active, true);
  const recorded = recordPoll({ status: 200, body: load("live-dish-activity"), previousTimestamp: null, now: 1792080000000 });
  assert.ok(recorded.activityStrings.includes("MSPA"));
  assert.ok(recorded.activityStrings.includes("Downlink"));

  const imap = DsnScanner.parse(load("live-dish-downlink"));
  assert.equal(imap.ok, true);
  const downs = imap.snapshot.signals.filter((s) => s.type === "downlink" && s.spacecraftID === -43 && s.active);
  assert.equal(downs.length, 2);
  assert.ok(downs.every((s) => s.dataRate === 0 && s.activity === "Downlink"));
  assert.equal(Talking.codes(imap.snapshot, CRAFTS).has("imap"), true);
});

test("23000 unterminated timestamp tags parse in well under 100 ms", () => {
  const xml = "<timestamp>".repeat(23000);
  assert.ok(Buffer.byteLength(xml) <= 256 * 1024);
  const t0 = performance.now();
  const parsed = DsnScanner.parse(xml);
  const elapsed = performance.now() - t0;
  assert.equal(parsed.ok, false);
  assert.ok(elapsed < 100, `elapsed ${elapsed}`);
});

function dishOf(snapshot, spacecraftID) {
  return snapshot.dishes.find((d) => d.signals.some((s) => s.spacecraftID === spacecraftID && s.active))?.name;
}
