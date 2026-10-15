import { test } from "node:test";
import assert from "node:assert/strict";
import { recordPoll, feedUrls } from "../gates/step0/src/extract.js";
import { buildXml, swfoDown } from "./xml.js";

test("step 0 recorder keeps the poll fields and does not fetch on its own", () => {
  const now = 1_700_000_100_000;
  const xml = buildXml({ timestamp: now - 30_000, dishes: [swfoDown({ debug: "DATA ON" })] });
  const first = recordPoll({ status: 200, body: xml, previousTimestamp: null, now });
  assert.equal(first.status, 200);
  assert.equal(first.bytes, Buffer.byteLength(xml));
  assert.equal(first.accepted, true);
  assert.equal(first.snapshotAgeMs, 30_000);
  assert.equal(first.timestampAdvanced, false);
  assert.ok(first.dishCount >= 10);
  assert.ok(first.activeDownlinkSpacecraftIDs.includes(-231));
  assert.ok(first.activityStrings.includes("DATA ON"));

  const next = recordPoll({ status: 200, body: buildXml({ timestamp: now, dishes: [swfoDown()] }), previousTimestamp: first.timestamp, now });
  assert.equal(next.timestampAdvanced, true);
  const urls = feedUrls(now);
  assert.equal(urls.plain.includes("?"), false);
  assert.match(urls.cacheBust, /dsn\.xml\?r=\d+/);
});
