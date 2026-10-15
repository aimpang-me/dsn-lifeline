import { test } from "node:test";
import assert from "node:assert/strict";
import { Clock } from "../src/clock.js";

test("Clock.now tracks the wall clock and delay runs the callback", async () => {
  const clock = new Clock();
  const before = Date.now();
  const now = clock.now();
  assert.ok(now >= before && now - before < 1000);
  await new Promise((resolve) => {
    clock.delay(15, () => resolve(undefined));
  });
});
