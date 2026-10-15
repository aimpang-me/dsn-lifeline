import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { createHarness, callTool, KEY, TOPIC, TOKEN, mcpRequest, liveBody, step } from "./harness.js";
import { readFileSync, readdirSync } from "node:fs";
import { INJECTED } from "./xml.js";
import { buildXml, swfoDown } from "./xml.js";

function spyEnv(env) {
  let calls = 0;
  env.LIFELINE = {
    idFromName() { calls += 1; return "main"; },
    get() { calls += 1; return { fetch() { calls += 1; throw new Error("DO called"); } }; },
  };
  return () => calls;
}

test("C-S1: ten bad keys return 401 and make zero DO calls", async () => {
  const h = createHarness();
  const calls = spyEnv(h.env);
  for (let i = 0; i < 10; i++) {
    const req = mcpRequest("tools/call", { name: "source_status", arguments: {} }, null, {
      Authorization: `Bearer ${"nope".padEnd(20, "x")}${i}`,
    });
    const res = await worker.fetch(req, h.env);
    assert.equal(res.status, 401);
  }
  assert.equal(calls(), 0);
});

test("an unauthenticated caller does not learn that the server is unconfigured", async () => {
  const cases = [
    { env: { API_KEY: "x".repeat(19) }, headers: { Authorization: "Bearer someone-else-key!!" } },
    { env: { API_KEY: "" }, headers: {} },
    { env: { API_KEY: "" }, headers: { Authorization: "Bearer api-key-sentinel-value!!" } },
  ];
  for (const item of cases) {
    const h = createHarness({ env: item.env });
    const calls = spyEnv(h.env);
    const res = await worker.fetch(mcpRequest("tools/call", { name: "source_status", arguments: {} }, null, item.headers), h.env);
    assert.equal(res.status, 401);
    assert.equal((await res.text()).includes("NOT_CONFIGURED"), false);
    assert.equal(calls(), 0);
  }
});

test("a valid key with a bad timezone still returns NOT_CONFIGURED", async () => {
  const h = createHarness({ env: { DEFAULT_TZ: "Not/AZone" } });
  const calls = spyEnv(h.env);
  const res = await worker.fetch(mcpRequest("tools/call", { name: "source_status", arguments: {} }, h.env), h.env);
  const body = await res.json();
  assert.equal(body.result.structuredContent.error, "NOT_CONFIGURED");
  assert.equal(calls(), 0);
});

test("C-S2: a 19 character key is 401 and does not reveal the config", async () => {
  const h = createHarness({ env: { API_KEY: "x".repeat(19) } });
  const calls = spyEnv(h.env);
  const res = await worker.fetch(mcpRequest("tools/call", { name: "source_status", arguments: {} }, h.env), h.env);
  assert.equal(res.status, 401);
  assert.equal((await res.text()).includes("NOT_CONFIGURED"), false);
  assert.equal(calls(), 0);
});

test("C-S3: a 16385 byte body is rejected", async () => {
  const h = createHarness();
  const calls = spyEnv(h.env);
  const res = await worker.fetch(new Request("https://dsn.example/mcp", {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: "x".repeat(16385),
  }), h.env);
  assert.ok(res.status === 413 || res.status === 400);
  const text = await res.text();
  assert.ok(text.includes("INVALID_INPUT") || res.status === 413);
  assert.equal(calls(), 0);
});

test("C-S4 and C-N10 and C-N11: feed text, topic, and token never appear in outputs or logs", async () => {
  const h = createHarness();
  const lines = [];
  const original = console.log;
  console.log = (...args) => { lines.push(args.map(String).join(" ")); };
  try {
    h.life.health.configAt = h.clock.now();
    h.feed.body = () => buildXml({
      timestamp: h.clock.now(),
      dishes: [swfoDown({ spacecraft: INJECTED, debug: INJECTED })],
    });
    await step(h);
    h.feed.body = () => buildXml({
      timestamp: h.clock.now(),
      dishes: [swfoDown({ spacecraft: INJECTED, debug: INJECTED })],
    });
    await step(h);
    const now = await callTool(h, "dsn_now", { watched_only: false });
    const status = await callTool(h, "source_status");
    const alerts = await callTool(h, "pending_alerts");
    const blob = JSON.stringify({ now, status, alerts, logs: h.logs, lines });
    assert.equal(blob.includes(INJECTED), false);
    assert.equal(blob.includes(TOPIC), false);
    assert.equal(blob.includes(TOKEN), false);
  } finally {
    console.log = original;
  }
});

test("C-S5: outbound calls use only eyes.nasa.gov", async () => {
  const h = createHarness();
  h.feed.body = liveBody(h, ["eurc"]);
  await step(h);
  await step(h);
  const hosts = [...new Set(h.fetches.map((f) => new URL(f.url).host))].sort();
  assert.deepEqual(hosts, ["eyes.nasa.gov"]);
});

test("C-N11 and C-D2: source has no ntfy host, topic, or token", () => {
  const root = new URL("../src/", import.meta.url);
  const files = readdirSync(root).filter((name) => name.endsWith(".js"));
  assert.equal(files.includes("ntfy.js"), false);
  const blob = files.map((name) => readFileSync(new URL(name, root), "utf8")).join("\n");
  assert.equal(blob.includes("ntfy.sh"), false);
  assert.equal(blob.includes("NTFY_TOPIC"), false);
  assert.equal(blob.includes("NTFY_TOKEN"), false);
  assert.equal(blob.includes(TOPIC), false);
  assert.equal(blob.includes(TOKEN), false);
});

test("X-API-Key is accepted the same way as Bearer", async () => {
  const h = createHarness();
  h.bind();
  const req = mcpRequest("tools/call", { name: "watchlist", arguments: {} }, null, { "X-API-Key": KEY });
  const res = await worker.fetch(req, h.env);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.result.isError, undefined);
});
