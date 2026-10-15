import { test } from "node:test";
import assert from "node:assert/strict";
import * as mod from "../src/index.js";
import { createHarness, mcpRequest } from "./harness.js";

test("workerd serves GET /health and POST /mcp from the default export", async () => {
  assert.equal(typeof mod.default, "object");
  assert.ok(mod.default);
  assert.equal(typeof mod.default.fetch, "function");

  const health = await mod.default.fetch.call(undefined, new Request("https://dsn.example/health"), {});
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true, spec_version: 2 });

  const h = createHarness();
  h.bind();
  const mcp = await mod.default.fetch.call(undefined, mcpRequest("tools/list", {}, h.env), h.env);
  assert.equal(mcp.status, 200);
  const rpc = await mcp.json();
  assert.equal(rpc.result.tools.length, 9);
  assert.equal(rpc.result.tools[0].name, "dsn_now");
});

test("GET /health and POST /mcp work when default.fetch is called with this unbound", async () => {
  const fetch = mod.default.fetch;
  assert.equal(typeof fetch, "function");

  const health = await fetch.call(undefined, new Request("https://dsn.example/"), {});
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true, spec_version: 2 });

  const h = createHarness();
  h.bind();
  const mcp = await fetch.call(undefined, mcpRequest("ping", {}, h.env), h.env);
  assert.equal(mcp.status, 200);
  const rpc = await mcp.json();
  assert.deepEqual(rpc.result, {});
});
