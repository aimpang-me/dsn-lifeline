import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { checkRuntime } from "./runtime-check.js";

test("Node 22 is pinned and node:sqlite loads", async () => {
  const nvmrc = readFileSync(new URL("../.nvmrc", import.meta.url), "utf8").trim();
  const nodeVersion = readFileSync(new URL("../.node-version", import.meta.url), "utf8").trim();
  assert.equal(nvmrc, "22");
  assert.equal(nodeVersion, "22");
  const engines = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).engines.node;
  assert.equal(engines, ">=22");
  const sqlite = checkRuntime(process.versions.node, () => createRequire(import.meta.url)("node:sqlite"));
  assert.equal(typeof sqlite.DatabaseSync, "function");
  await import("../src/index.js");
});
