import { test } from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import worker from "../src/index.js";
import { createHarness, KEY, mcpRequest } from "./harness.js";

const TOOLS = ["dsn_now", "watchlist", "watch_craft", "unwatch_craft", "mute_craft", "source_status", "pending_alerts", "ack_alerts", "test_alert"];

test("T8 and C-X3: the MCP client can call every tool", async () => {
  const h = createHarness();
  h.bind();
  const transport = new StreamableHTTPClientTransport(new URL("https://dsn.example/mcp"), {
    fetch: (url, init) => worker.fetch(new Request(url, init), h.env),
    requestInit: { headers: { Authorization: `Bearer ${KEY}` } },
  });
  const client = new Client({ name: "dsn-lifeline-test", version: "1.0.0" });
  await client.connect(transport);
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map((tool) => tool.name), TOOLS);

  const now = await client.callTool({ name: "dsn_now", arguments: { watched_only: true } });
  assert.equal(now.isError, undefined);
  assert.ok(now.structuredContent.crafts.some((c) => c.code === "eurc" && c.name === "Europa Clipper"));

  const list = await client.callTool({ name: "watchlist", arguments: {} });
  assert.equal(list.structuredContent.crafts.find((c) => c.code === "eurc").favourite, true);

  const watched = await client.callTool({ name: "watch_craft", arguments: { code: "imap", favourite: true } });
  assert.equal(watched.structuredContent.crafts.find((c) => c.code === "imap").favourite, true);

  const muted = await client.callTool({ name: "mute_craft", arguments: { code: "imap", hours: 2 } });
  assert.equal(typeof muted.structuredContent.mute_end, "number");

  const removed = await client.callTool({ name: "unwatch_craft", arguments: { code: "imap" } });
  assert.equal(removed.structuredContent.crafts.some((c) => c.code === "imap"), false);

  const status = await client.callTool({ name: "source_status", arguments: {} });
  assert.equal(status.structuredContent.spec_version, 2);

  const listedAlerts = await client.callTool({ name: "pending_alerts", arguments: {} });
  assert.deepEqual(listedAlerts.structuredContent.alerts, []);
  const acked = await client.callTool({ name: "ack_alerts", arguments: { ids: ["missing-id"] } });
  assert.deepEqual(acked.structuredContent.acked, []);
  const push = await client.callTool({ name: "test_alert", arguments: {} });
  assert.equal(push.structuredContent.queued, true);
  await client.close();
});

const ACCEPTED_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

test("initialize falls back to a protocol version it accepts", async () => {
  const h = createHarness();
  h.bind();
  for (const params of [{ protocolVersion: "1999-01-01" }, { protocolVersion: "2025-11-25" }, {}]) {
    const res = await worker.fetch(mcpRequest("initialize", params, h.env), h.env);
    const body = await res.json();
    assert.ok(ACCEPTED_VERSIONS.includes(body.result.protocolVersion), body.result.protocolVersion);
    assert.equal(body.result.instructions.includes(["Al", "vin"].join("")), false);
    assert.match(body.result.instructions, /the user/);
  }
  for (const protocolVersion of ACCEPTED_VERSIONS) {
    const res = await worker.fetch(mcpRequest("initialize", { protocolVersion }, h.env), h.env);
    const body = await res.json();
    assert.equal(body.result.protocolVersion, protocolVersion);
  }
});

test("initialize serverInfo.version matches package.json", async () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const h = createHarness();
  h.bind();
  const res = await worker.fetch(mcpRequest("initialize", {}, h.env), h.env);
  const body = await res.json();
  assert.equal(body.result.serverInfo.version, pkg.version);
});
