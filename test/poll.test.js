import { test } from "node:test";
import assert from "node:assert/strict";
import { createHarness, liveBody, quietBody, settle, step } from "./harness.js";

test("C-P2: one alarm does at most one feed fetch and one config fetch", async () => {
  const h = createHarness();
  h.feed.body = liveBody(h, ["eurc", "psyc"]);
  await step(h);
  await step(h);
  h.fetches.length = 0;
  h.life.health.configAt = 0;
  await h.life.alarm();
  const hosts = h.fetches.map((f) => new URL(f.url).host);
  const feed = h.fetches.filter((f) => f.url.includes("dsn.xml"));
  const config = h.fetches.filter((f) => f.url.includes("config.xml"));
  assert.equal(feed.length, 1);
  assert.ok(feed[0].url.includes("dsn.xml?r="));
  assert.equal(h.fetches.filter((f) => f.url.includes("ntfy.sh")).length, 0);
  assert.ok(config.length <= 1);
  assert.ok(h.fetches.length <= 2);
  assert.ok(hosts.every((host) => host === "eyes.nasa.gov"));
});

test("C-P3: hanging feed and config fail at 8s and the alarm re-arms", async () => {
  const feed = createHarness();
  feed.life.health.configAt = feed.clock.now();
  feed.feed.hang = (url) => url.includes("dsn.xml");
  const feedRun = feed.life.alarm();
  await settle(feed);
  const feedDelay = feed.clock.pendingDelay();
  assert.ok(feedDelay != null && Math.abs(feedDelay - 8000) <= 500, `feed delay ${feedDelay}`);
  feed.clock.advance(feedDelay);
  await feedRun;
  assert.ok(feed.storage.alarm != null && feed.storage.alarm - feed.clock.now() <= 130_000);

  const config = createHarness();
  config.feed.hang = (url) => url.includes("config.xml");
  config.feed.body = quietBody(config);
  const configRun = config.life.alarm();
  await settle(config);
  const configDelay = config.clock.pendingDelay();
  assert.ok(configDelay != null && Math.abs(configDelay - 8000) <= 500, `config delay ${configDelay}`);
  config.clock.advance(configDelay);
  await configRun;
  assert.ok(config.storage.alarm != null && config.storage.alarm - config.clock.now() <= 130_000);
});

function stallingBody(status) {
  return new Response(new ReadableStream({
    pull() {
      return new Promise(() => {});
    },
  }), { status });
}

async function settles(run) {
  let settled = false;
  const done = run.then(() => { settled = true; return "done"; }, () => { settled = true; return "done"; });
  const hung = new Promise((resolve) => setTimeout(() => resolve(settled ? "done" : "hung"), 200));
  return Promise.race([done, hung]);
}

test("a feed body that never closes times out and the alarm re-arms", async () => {
  const h = createHarness();
  h.life.health.configAt = h.clock.now();
  h.life.fetchImpl = async (url, init) => {
    h.fetches.push({ url: String(url), headers: init?.headers, body: init?.body });
    return stallingBody(200);
  };
  const run = h.life.alarm();
  await settle(h);
  const delay = h.clock.pendingDelay();
  assert.ok(delay != null && Math.abs(delay - 8000) <= 500, `feed body delay ${delay}`);
  h.clock.advance(delay);
  assert.equal(await settles(run), "done");
  assert.ok(h.storage.alarm != null && h.storage.alarm - h.clock.now() <= 130_000);
});

test("a config body that never closes times out and the alarm re-arms", async () => {
  const h = createHarness();
  h.feed.body = quietBody(h);
  h.life.fetchImpl = async (url, init) => {
    const u = String(url);
    h.fetches.push({ url: u, headers: init?.headers, body: init?.body });
    if (u.includes("config.xml")) return stallingBody(200);
    const body = typeof h.feed.body === "function" ? h.feed.body() : h.feed.body;
    return new Response(body, { status: 200 });
  };
  const run = h.life.alarm();
  await settle(h);
  const delay = h.clock.pendingDelay();
  assert.ok(delay != null && Math.abs(delay - 8000) <= 500, `config body delay ${delay}`);
  h.clock.advance(delay);
  assert.equal(await settles(run), "done");
  assert.ok(h.storage.alarm != null && h.storage.alarm - h.clock.now() <= 130_000);
  assert.equal(h.life.health.configAt, null);
});

test("C-P4: a thrown alarm still leaves an alarm within 130s, and a tool call arms a missing one", async () => {
  const h = createHarness();
  h.life.health.configAt = h.clock.now();
  h.feed.body = () => { throw new Error("feed exploded"); };
  h.fetchBoom = true;
  const original = h.life.fetchImpl;
  h.life.fetchImpl = async () => { throw new Error("feed exploded"); };
  await h.life.alarm();
  assert.ok(h.storage.alarm != null);
  assert.ok(h.storage.alarm - h.clock.now() <= 130_000);
  assert.ok(h.storage.alarm >= h.clock.now());
  h.life.fetchImpl = original;

  const fresh = createHarness();
  fresh.storage.alarm = null;
  fresh.bind();
  const { callTool } = await import("./harness.js");
  await callTool(fresh, "watchlist");
  assert.ok(fresh.storage.alarm != null);
  assert.ok(fresh.storage.alarm - fresh.clock.now() <= 130_000);
});
