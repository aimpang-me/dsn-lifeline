import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { CRAFTS } from "../src/crafts.js";
import { createHarness, callTool, mcpRequest } from "./harness.js";

test("C-X1 and C-X6: each error code is returned, including an unknown field", async () => {
  const h = createHarness();
  assert.equal((await callTool(h, "watch_craft", { code: "eurc", favourite: true, extra: 1 })).error, "INVALID_INPUT");
  assert.equal((await callTool(h, "watch_craft", { code: "notacraft", favourite: true })).error, "UNKNOWN_CRAFT");
  assert.equal((await callTool(h, "unwatch_craft", { code: "imap" })).error, "NOT_WATCHED");
  for (const code of CRAFTS.map((c) => c.code).slice(0, 12)) {
    h.storage.sql.exec(
      "INSERT INTO watch (code, favourite, mute_until) VALUES (?, 0, NULL) ON CONFLICT(code) DO NOTHING",
      code,
    );
  }
  h.life.reloadWatch();
  const thirteenth = CRAFTS[12].code;
  assert.equal((await callTool(h, "watch_craft", { code: thirteenth, favourite: false })).error, "TOO_MANY_WATCHED");

  const misconfigured = createHarness({ env: { DEFAULT_TZ: "Not/AZone" } });
  assert.equal((await callTool(misconfigured, "source_status")).error, "NOT_CONFIGURED");

  const limited = createHarness();
  for (let i = 0; i < 60; i++) assert.equal((await callTool(limited, "watchlist")).error, undefined);
  assert.equal((await callTool(limited, "watchlist")).error, "RATE_LIMITED");
});

test("C-X2: the 61st tool call and the 4th test_alert are RATE_LIMITED", async () => {
  const h = createHarness();
  for (let i = 0; i < 60; i++) await callTool(h, "source_status");
  assert.equal((await callTool(h, "source_status")).error, "RATE_LIMITED");

  const alerts = createHarness();
  for (let i = 0; i < 3; i++) {
    const res = await callTool(alerts, "test_alert");
    assert.equal(res.data.queued, true);
  }
  assert.equal((await callTool(alerts, "test_alert")).error, "RATE_LIMITED");
});

test("C-X3: source_status spec_version is the integer 2", async () => {
  const h = createHarness();
  const res = await callTool(h, "source_status");
  assert.equal(res.data.spec_version, 2);
  assert.equal(typeof res.data.spec_version, "number");
});

test("C-X4: dsn_now median over 50 calls is under 500ms", async () => {
  const h = createHarness();
  const samples = [];
  for (let i = 0; i < 50; i++) {
    const t0 = performance.now();
    const res = await callTool(h, "dsn_now", { watched_only: true });
    samples.push(performance.now() - t0);
    assert.equal(res.error, undefined);
    assert.ok(res.data.crafts.some((c) => c.code === "eurc"));
  }
  samples.sort((a, b) => a - b);
  const median = samples[25];
  assert.ok(median < 500, `median ${median}`);
});

test("C-X5: test_alert queues one alert and does not change the favourite counter", async () => {
  const h = createHarness();
  const before = h.life.read("SELECT id FROM alert WHERE kind = 'fav'").length;
  const res = await callTool(h, "test_alert");
  assert.equal(res.data.queued, true);
  const pending = await callTool(h, "pending_alerts");
  assert.equal(pending.data.alerts.length, 1);
  assert.equal(pending.data.alerts[0].kind, "test");
  assert.equal(h.fetches.some((f) => String(f.url).includes("ntfy.sh")), false);
  const after = h.life.read("SELECT id FROM alert WHERE kind = 'fav'").length;
  assert.equal(after, before);
});

test("C-D1: a missing API key is 401 and does not say the server is unconfigured", async () => {
  const h = createHarness({ env: { API_KEY: "" } });
  const res = await callTool(h, "dsn_now", { watched_only: true });
  assert.equal(res.status, 401);
  assert.equal(JSON.stringify(res.rpc).includes("NOT_CONFIGURED"), false);
  assert.equal(h.doCalls, 0);
});

test("GET /health returns 200 and does not touch the DO", async () => {
  const h = createHarness();
  let calls = 0;
  h.env.LIFELINE = { idFromName() { calls += 1; }, get() { calls += 1; } };
  const res = await worker.fetch(new Request("https://dsn.example/health"), h.env);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.spec_version, 2);
  assert.equal(calls, 0);
  assert.equal(JSON.stringify(body).includes("topic-sentinel"), false);
});

test("a tool path with no key returns 401", async () => {
  const h = createHarness();
  const req = mcpRequest("tools/call", { name: "source_status", arguments: {} }, null);
  const res = await worker.fetch(req, h.env);
  assert.equal(res.status, 401);
});
