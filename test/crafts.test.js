import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CRAFTS } from "../src/crafts.js";

test("production craft table is four unverified negative spacecraft IDs", () => {
  assert.deepEqual(
    CRAFTS.map((craft) => [craft.code, craft.spacecraftID, craft.verified]),
    [
      ["eurc", -159, false],
      ["psyc", -255, false],
      ["imap", -43, false],
      ["swfo", -231, false],
    ],
  );
  const src = readFileSync(new URL("../src/crafts.js", import.meta.url), "utf8");
  assert.equal(src.includes("slot"), false);
});
