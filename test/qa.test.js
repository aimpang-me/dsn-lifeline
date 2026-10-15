import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { Lifeline } from "../src/index.js";
import { DsnScanner } from "../src/parser.js";
import { Talking } from "../src/talking.js";
import { CRAFTS } from "../src/crafts.js";
import { createHarness, callTool, liveBody, quietBody, KEY } from "./harness.js";
import { INJECTED } from "./xml.js";

const MIN = 60_000;

function favouriteIds(h) {
  return h.life.read("SELECT id FROM alert WHERE kind = 'fav'").map((row) => String(row.id));
}

function spyEnv(env) {
  let calls = 0;
  env.LIFELINE = {
    idFromName() { calls += 1; return "main"; },
    get() { calls += 1; return { fetch() { calls += 1; throw new Error("DO called"); } }; },
  };
  return () => calls;
}

test("real-shape dsn.xml with an injected spacecraftID -231 detects swfo", () => {
  const xml = [
    '<?xml version="1.0" encoding="utf-8"?>',
    "<dsn>",
    '<station name="Goldstone" friendlyName="Goldstone">',
    '<dish name="DSS14" azimuthAngle="10" elevationAngle="20" windSpeed="0">',
    `<target name="${INJECTED}" id="-999" uplegRange="-1" downlegRange="-1" rtlt="-1"/>`,
    `<downSignal signalType="data" signalTypeDebug="${INJECTED}" dataRate="0" frequency="8440000000" power="-190" spacecraft="${INJECTED}" spacecraftID="-231" active="true"/>`,
    `<upSignal signalType="none" signalTypeDebug="IDLE" dataRate="-1" frequency="-1" power="-1" spacecraft="${INJECTED}" spacecraftID="-231" active="false"/>`,
    "</dish>",
    "</station>",
    '<station name="Canberra" friendlyName="Canberra"></station>',
    '<station name="Madrid" friendlyName="Madrid"></station>',
    "<timestamp>1700000000000</timestamp>",
    "</dsn>",
  ].join("");
  assert.ok(xml.indexOf("<timestamp>") > xml.lastIndexOf("</station>"));
  assert.equal(xml.includes("spacecraftId="), false);
  assert.equal((xml.match(/<station /g) ?? []).length, 3);
  const parsed = DsnScanner.parse(xml);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.snapshot.signals.find((s) => s.type === "downlink" && s.active)?.spacecraftID, -231);
  assert.deepEqual([...Talking.codes(parsed.snapshot, CRAFTS)], ["swfo"]);
  assert.equal(JSON.stringify([...Talking.codes(parsed.snapshot, CRAFTS)]).includes(INJECTED), false);
});

test("QA mute of 1h still sends a favourite push at 61 minutes", async () => {
  const h = createHarness();
  h.life.health.configAt = h.clock.now();
  const start = h.clock.now();
  await callTool(h, "mute_craft", { code: "eurc", hours: 1 });
  h.feed.body = liveBody(h, ["eurc"]);
  await h.life.alarm();
  h.clock.advance(MIN);
  h.feed.body = liveBody(h, ["eurc"]);
  await h.life.alarm();
  assert.equal(h.life.contacts.contacts.eurc.open, true);
  h.clock.advance(start + 59 * MIN - h.clock.now());
  h.feed.body = liveBody(h, ["eurc"]);
  await h.life.alarm();
  assert.equal(favouriteIds(h).length, 0);
  h.clock.advance(2 * MIN);
  h.feed.body = liveBody(h, ["eurc"]);
  await h.life.alarm();
  assert.equal(favouriteIds(h).length, 1);
  const row = h.life.read("SELECT status, at, expire_at FROM alert WHERE kind = 'fav'")[0];
  assert.equal(String(row.status), "pending");
  assert.equal(Number(row.expire_at) - Number(row.at), 20 * MIN);
});

test("QA a favourite added mid-contact retries from queue time", async () => {
  const h = createHarness();
  h.life.health.configAt = h.clock.now();
  h.feed.body = liveBody(h, ["imap"]);
  await h.life.alarm();
  h.clock.advance(MIN);
  h.feed.body = liveBody(h, ["imap"]);
  await h.life.alarm();
  const opened = h.life.contacts.contacts.imap.openedAt;
  h.clock.advance(25 * MIN);
  await callTool(h, "watch_craft", { code: "imap", favourite: true });
  const queuedAt = h.clock.now();
  h.feed.body = liveBody(h, ["imap"]);
  await h.life.alarm();
  const row = h.life.read("SELECT status, at, expire_at FROM alert WHERE kind = 'fav'")[0];
  assert.ok(row);
  assert.equal(String(row.status), "pending");
  assert.equal(Number(row.at), queuedAt);
  assert.equal(Number(row.expire_at), queuedAt + 20 * MIN);
  assert.notEqual(Number(row.at), opened);
});

test("config fetch uses https://eyes.nasa.gov/dsn/config.xml", async () => {
  const h = createHarness();
  h.life.health.configAt = 0;
  h.feed.body = quietBody(h);
  await h.life.alarm();
  const config = h.fetches.filter((f) => f.url.includes("config"));
  assert.equal(config.length, 1);
  assert.equal(config[0].url, "https://eyes.nasa.gov/dsn/config.xml");
});

function revive(h) {
  h.life = new Lifeline({
    storage: h.storage,
    clock: h.clock,
    fetchImpl: h.life.fetchImpl,
    log: (entry) => h.logs.push(entry),
  }, h.env);
  return h.life;
}

test("a normal accept persists freshness before any row-budget guard", async () => {
  const h = createHarness();
  h.feed.body = quietBody(h);
  await h.life.alarm();
  assert.ok(h.life.budget.rowsToday < 70_000);
  assert.equal(h.life.read("SELECT v FROM meta WHERE k = 'state'").length, 1);
  const stamp = h.life.health.lastTimestamp;
  const goodAt = h.life.health.lastGoodAt;
  const startedAt = h.life.health.startedAt;
  const revived = revive(h);
  assert.equal(revived.health.lastTimestamp, stamp);
  assert.equal(revived.health.lastGoodAt, goodAt);
  assert.equal(revived.health.startedAt, startedAt);
  const writes = h.storage.sqlWrites;
  await revived.acceptSnapshot(quietBody(h)().replace(/<timestamp>[^<]*<\/timestamp>/, `<timestamp>${stamp}</timestamp>`));
  assert.equal(h.storage.sqlWrites, writes);
});

test("restarts every 10 minutes keep freshness, the stale push, and the canary anchor", async () => {
  const fresh = createHarness();
  fresh.life.health.configAt = fresh.clock.now();
  const startedAt = fresh.life.health.startedAt;
  fresh.feed.body = liveBody(fresh, ["imap"]);
  await fresh.life.alarm();
  await fresh.life.alarm();
  const talkingAt = fresh.life.health.lastTalkingAt;
  assert.ok(talkingAt != null);
  for (let i = 0; i < 24; i++) {
    fresh.clock.advance(10 * MIN);
    fresh.feed.body = quietBody(fresh);
    await fresh.life.alarm();
    const stamp = fresh.life.health.lastTimestamp;
    const goodAt = fresh.life.health.lastGoodAt;
    revive(fresh);
    assert.equal(fresh.life.health.lastTimestamp, stamp);
    assert.equal(fresh.life.health.lastGoodAt, goodAt);
    assert.equal(fresh.life.health.startedAt, startedAt);
    assert.equal(fresh.life.health.lastTalkingAt, talkingAt);
    assert.equal(fresh.life.read("SELECT v FROM meta WHERE k = 'state'").length, 1);
  }

  const stale = createHarness();
  stale.life.health.configAt = stale.clock.now();
  stale.feed.body = quietBody(stale);
  await stale.life.alarm();
  const goodAt = stale.life.health.lastGoodAt;
  stale.feed.status = 500;
  for (let i = 0; i < 24; i++) {
    stale.clock.advance(20 * MIN);
    revive(stale);
    await stale.life.alarm();
  }
  assert.equal(stale.life.health.lastGoodAt, goodAt);
  const staleRows = stale.life.read("SELECT id FROM alert WHERE kind = 'stale'");
  assert.equal(staleRows.filter((row) => !String(row.id).endsWith(":retry")).length, 1);
  assert.equal(staleRows.filter((row) => String(row.id).endsWith(":retry")).length, 1);

  const canary = createHarness();
  canary.life.health.configAt = canary.clock.now();
  const canaryStart = canary.life.health.startedAt;
  for (let i = 0; i < 24 * 6; i++) {
    canary.feed.body = quietBody(canary);
    await canary.life.alarm();
    canary.clock.advance(10 * MIN);
    revive(canary);
    assert.equal(canary.life.health.startedAt, canaryStart);
  }
  assert.ok(canary.clock.now() - canaryStart >= 24 * 60 * MIN);
  canary.feed.body = quietBody(canary);
  await canary.life.alarm();
  assert.equal(canary.life.read("SELECT id FROM alert WHERE kind = 'canary'").length, 1);
});

test("an authed body of null is JSON-RPC -32600", async () => {
  const h = createHarness();
  const res = await h.life.fetch(new Request("https://lifeline/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "null",
  }));
  const body = await res.json();
  assert.equal(body.error.code, -32600);
});

test("the durable object returns JSON-RPC -32700 for a body that is not JSON", async () => {
  const h = createHarness();
  const res = await h.life.fetch(new Request("https://lifeline/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "not-json",
  }));
  const body = await res.json();
  assert.equal(body.error.code, -32700);
});

test("a bad key is 401 before an oversized body is 413", async () => {
  const h = createHarness();
  const calls = spyEnv(h.env);
  const res = await worker.fetch(new Request("https://dsn.example/mcp", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${"n".repeat(24)}`,
      "content-type": "application/json",
      "content-length": "16385",
    },
    body: "x".repeat(16385),
  }), h.env);
  assert.equal(res.status, 401);
  assert.equal(calls(), 0);
});

test("configAt is set only after a successful config fetch", async () => {
  const h = createHarness();
  h.feed.configStatus = 500;
  h.feed.body = quietBody(h);
  await h.life.alarm();
  assert.equal(h.life.health.configAt, null);
  h.feed.configStatus = 200;
  await h.life.alarm();
  assert.equal(h.life.health.configAt, null);
  assert.equal(h.fetches.filter((f) => f.url.includes("config")).length, 1);
  h.clock.advance(24 * 60 * MIN);
  h.feed.body = quietBody(h);
  await h.life.alarm();
  assert.equal(h.life.health.configAt, h.clock.now());
  h.fetches.length = 0;
  await h.life.alarm();
  assert.equal(h.fetches.filter((f) => f.url.includes("config")).length, 0);
});

test("a failed config fetch is attempted at most once across 120 alarms", async () => {
  for (const status of [500, 404]) {
    const h = createHarness();
    h.feed.configStatus = status;
    for (let i = 0; i < 120; i++) {
      h.clock.advance(MIN);
      h.feed.body = quietBody(h);
      await h.life.alarm();
    }
    const configs = h.fetches.filter((f) => f.url.includes("config.xml"));
    assert.equal(configs.length, 1, `status ${status} fetched ${configs.length}`);
    assert.equal(h.life.health.configAt, null);
  }
});

test("a corrupt meta state row does not brick the constructor", () => {
  for (const raw of ["{", "null"]) {
    const h = createHarness();
    h.storage.sql.exec("INSERT INTO meta (k, v) VALUES ('state', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", raw);
    const revived = new Lifeline({ storage: h.storage, clock: h.clock, fetchImpl: h.life.fetchImpl, log: (entry) => h.logs.push(entry) }, h.env);
    assert.equal(revived.health.lastTimestamp, null);
    assert.equal(revived.health.configAt, null);
    assert.equal(revived.health.lastGoodAt, null);
  }
});

test("a restart keeps tool, push, and watch caps", async () => {
  const tools = createHarness();
  for (let i = 0; i < 60; i++) assert.equal((await callTool(tools, "watchlist")).error, undefined);
  revive(tools);
  const cappedWrites = tools.storage.sqlWrites;
  assert.equal((await callTool(tools, "watchlist")).error, "RATE_LIMITED");
  assert.equal(tools.storage.sqlWrites, cappedWrites);

  const pushes = createHarness();
  for (let i = 0; i < 3; i++) assert.equal((await callTool(pushes, "test_alert")).data.queued, true);
  revive(pushes);
  assert.equal((await callTool(pushes, "test_alert")).error, "RATE_LIMITED");

  const watches = createHarness();
  for (let i = 0; i < 10; i++) {
    const favourite = i % 2 === 0;
    assert.equal((await callTool(watches, "watch_craft", { code: "eurc", favourite })).error, undefined);
  }
  revive(watches);
  assert.equal((await callTool(watches, "watch_craft", { code: "eurc", favourite: true })).error, "RATE_LIMITED");

  const mutes = createHarness();
  for (let i = 0; i < 30; i++) assert.equal((await callTool(mutes, "mute_craft", { code: "eurc", hours: 1 })).error, undefined);
  revive(mutes);
  assert.equal((await callTool(mutes, "mute_craft", { code: "eurc", hours: 1 })).error, "RATE_LIMITED");

  const unwatches = createHarness();
  assert.equal((await callTool(unwatches, "unwatch_craft", { code: "eurc" })).error, undefined);
  revive(unwatches);
  assert.equal(unwatches.life.limiter.daily.unwatch, 1);
  assert.equal((await callTool(unwatches, "unwatch_craft", { code: "psyc" })).error, undefined);
  assert.equal(unwatches.life.limiter.daily.unwatch, 2);
});

test("a restart keeps backoff and shape counters", async () => {
  const backoff = createHarness();
  backoff.life.health.configAt = backoff.clock.now();
  backoff.feed.status = 500;
  for (let i = 0; i < 4; i++) {
    await backoff.life.alarm();
    backoff.clock.advance(backoff.storage.alarm - backoff.clock.now());
  }
  const started = backoff.life.health.failureStartedAt;
  revive(backoff);
  backoff.life.health.configAt = backoff.clock.now();
  await backoff.life.alarm();
  assert.equal(backoff.life.health.consecutiveFailures, 5);
  assert.equal(backoff.life.health.failureStartedAt, started);
  assert.equal(backoff.storage.alarm - backoff.clock.now(), 5 * MIN);

  const shape = createHarness();
  shape.life.health.configAt = shape.clock.now();
  shape.feed.body = () => "<dsn><timestamp>nope</timestamp></dsn>";
  await shape.life.alarm();
  shape.clock.advance(MIN);
  await shape.life.alarm();
  assert.equal(shape.life.health.shapeTimes.length, 2);
  revive(shape);
  shape.life.health.configAt = shape.clock.now();
  shape.feed.body = () => "<dsn><timestamp>nope</timestamp></dsn>";
  await shape.life.alarm();
  assert.equal(shape.life.health.shapeTimes.length, 3);
  assert.equal(shape.life.read("SELECT id FROM alert WHERE kind = 'shape'").length, 1);
});

test("an unknown notification with no id gets an empty 202", async () => {
  const h = createHarness();
  h.bind();
  const res = await worker.fetch(new Request("https://dsn.example/mcp", {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress" }),
  }), h.env);
  assert.equal(res.status, 202);
  assert.equal(await res.text(), "");
});

test("a body with no Content-Length is capped before the rest is buffered", async () => {
  const h = createHarness();
  h.bind();
  const chunk = new Uint8Array(16385);
  chunk.fill(120);
  let extraReads = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (extraReads === 0) {
        extraReads += 1;
        controller.enqueue(chunk);
        return;
      }
      extraReads += 1;
      return new Promise(() => {});
    },
  });
  const run = worker.fetch(new Request("https://dsn.example/mcp", {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: stream,
    duplex: "half",
  }), h.env);
  let settled = false;
  const done = run.then((res) => { settled = true; return res; });
  const hung = new Promise((resolve) => setTimeout(() => resolve(settled ? null : "hung"), 200));
  const res = await Promise.race([done, hung]);
  assert.notEqual(res, "hung");
  assert.equal(res.status, 413);
  assert.ok(extraReads < 3, `reads ${extraReads}`);
});

test("onGood throwing logs alarm_error and the alarm re-arms", async () => {
  const h = createHarness();
  h.life.health.configAt = h.clock.now();
  h.feed.body = quietBody(h);
  h.life.poller.onGood = () => { throw new Error("onGood boom"); };
  await h.life.alarm();
  assert.ok(h.logs.some((entry) => entry.event === "alarm_error"));
  assert.ok(h.storage.alarm != null && h.storage.alarm - h.clock.now() <= 130_000);
});

test("a UTC day roll clears the slow-interval latch", async () => {
  const h = createHarness({ now: Date.parse("2026-10-15T23:50:00Z") });
  h.life.health.configAt = h.clock.now();
  h.life.budget.rowsToday = 70_000;
  h.clock.advance(20 * MIN);
  h.feed.body = quietBody(h);
  await h.life.alarm();
  assert.equal(h.life.budget.rowsDay, "2026-10-16");
  assert.equal(h.life.budget.slow, false);
});

test("mute and watch do not enqueue alerts", async () => {
  const h = createHarness();
  await callTool(h, "mute_craft", { code: "eurc", hours: 1 });
  await callTool(h, "watch_craft", { code: "imap", favourite: false });
  assert.equal(h.life.read("SELECT id FROM alert").length, 0);
});

test("a dropped favourite gets one fresh attempt while the contact is still talking", async () => {
  const h = createHarness();
  h.life.health.configAt = h.clock.now();
  h.feed.body = liveBody(h, ["eurc"]);
  await h.life.alarm();
  h.clock.advance(MIN);
  h.feed.body = liveBody(h, ["eurc"]);
  await h.life.alarm();
  const queuedAt = Number(h.life.read("SELECT at FROM alert WHERE kind = 'fav'")[0].at);
  while (h.clock.now() < queuedAt + 20 * MIN) {
    h.clock.advance(MIN);
    h.feed.body = liveBody(h, ["eurc"]);
    await h.life.alarm();
  }
  const dropped = h.life.read("SELECT status FROM alert WHERE kind = 'fav'");
  assert.equal(dropped.length, 1);
  assert.equal(String(dropped[0].status), "dropped");
  h.clock.advance(MIN);
  h.feed.body = liveBody(h, ["eurc"]);
  await h.life.alarm();
  const retried = h.life.read("SELECT status FROM alert WHERE kind = 'fav'");
  assert.equal(retried.length, 2);
  assert.equal(retried.filter((row) => String(row.status) === "pending").length, 1);
  h.clock.advance(MIN);
  h.feed.body = liveBody(h, ["eurc"]);
  await h.life.alarm();
  assert.equal(h.life.read("SELECT id FROM alert WHERE kind = 'fav'").length, 2);
});

test("a malformed or non-finite Content-Length is rejected or capped", async () => {
  for (const length of ["nope", "NaN", "Infinity", "-1", ""]) {
    const h = createHarness();
    const calls = spyEnv(h.env);
    const chunk = new Uint8Array(16385);
    let reads = 0;
    const stream = new ReadableStream({
      pull(controller) {
        reads += 1;
        if (reads === 1) {
          controller.enqueue(chunk);
          return;
        }
        return new Promise(() => {});
      },
    });
    const run = worker.fetch(new Request("https://dsn.example/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}`, "content-type": "application/json", "content-length": length },
      body: stream,
      duplex: "half",
    }), h.env);
    let settled = false;
    const done = run.then((res) => { settled = true; return res; });
    const hung = new Promise((resolve) => setTimeout(() => resolve(settled ? null : "hung"), 200));
    const res = await Promise.race([done, hung]);
    assert.notEqual(res, "hung", length);
    assert.equal(res.status, 413, length);
    assert.ok(reads < 3, `${length} reads ${reads}`);
    assert.equal(calls(), 0, length);
  }
});

test("Content-Length above 16384 is rejected before the body is parsed", async () => {
  const h = createHarness();
  const calls = spyEnv(h.env);
  const res = await worker.fetch(new Request("https://dsn.example/mcp", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${KEY}`,
      "content-type": "application/json",
      "content-length": "16385",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
  }), h.env);
  assert.equal(res.status, 413);
  const text = await res.text();
  assert.ok(text.includes("INVALID_INPUT"));
  assert.equal(calls(), 0);
});
