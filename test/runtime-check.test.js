import { test } from "node:test";
import assert from "node:assert/strict";
import { checkRuntime } from "./runtime-check.js";

test("Node 20 is refused with a clear Node.js 22 message", () => {
  assert.throws(
    () => checkRuntime("20.11.1", () => ({ DatabaseSync: function DatabaseSync() {} })),
    /Node\.js 22 or newer[\s\S]*20\.11\.1/,
  );
});

test("a Node 22 runtime without node:sqlite is refused with a clear message", () => {
  assert.throws(
    () => checkRuntime("22.14.0", () => { throw new Error("Cannot find module 'node:sqlite'"); }),
    /node:sqlite[\s\S]*22\.14\.0/,
  );
});

test("Node 22 with node:sqlite passes the runtime check", () => {
  const sqlite = checkRuntime("22.14.0", () => ({ DatabaseSync: function DatabaseSync() {} }));
  assert.equal(typeof sqlite.DatabaseSync, "function");
});
