import { test } from "node:test";
import assert from "node:assert/strict";
import { createHarness, callTool } from "./harness.js";
import { CRAFTS } from "../src/crafts.js";
import { buildXml, swfoDown, INJECTED } from "./xml.js";

test("C-W1: an injected feed name never becomes push text", async () => {
  const h = createHarness();
  h.life.health.configAt = h.clock.now();
  await callTool(h, "watch_craft", { code: "swfo", favourite: true });
  h.feed.body = () => buildXml({
    timestamp: h.clock.now(),
    dishes: [swfoDown({ spacecraft: INJECTED, debug: INJECTED, dataRate: "0" })],
  });
  await h.life.alarm();
  h.clock.advance(60_000);
  h.feed.body = () => buildXml({
    timestamp: h.clock.now(),
    dishes: [swfoDown({ spacecraft: INJECTED, debug: INJECTED, dataRate: "0" })],
  });
  await h.life.alarm();
  const alerts = await callTool(h, "pending_alerts");
  const blob = JSON.stringify(alerts) + JSON.stringify(h.logs);
  assert.equal(blob.includes(INJECTED), false);
  assert.match(alerts.data.alerts.map((alert) => alert.craft).join(" "), /SWFO-L1/);
});

test("C-W3: a fresh watchlist has eurc and psyc as favourites", async () => {
  const h = createHarness();
  const res = await callTool(h, "watchlist");
  const byCode = Object.fromEntries(res.data.crafts.map((c) => [c.code, c]));
  assert.equal(byCode.eurc.favourite, true);
  assert.equal(byCode.psyc.favourite, true);
  assert.equal(byCode.imap, undefined);
  assert.equal(byCode.swfo, undefined);
});

test("C-W4: the 13th watch_craft returns TOO_MANY_WATCHED", async () => {
  const h = createHarness();
  const codes = CRAFTS.map((c) => c.code);
  assert.ok(codes.length >= 13);
  for (const code of codes.slice(0, 12)) {
    h.storage.sql.exec(
      "INSERT INTO watch (code, favourite, mute_until) VALUES (?, 0, NULL) ON CONFLICT(code) DO NOTHING",
      code,
    );
  }
  h.life.reloadWatch();
  const res = await callTool(h, "watch_craft", { code: codes[12], favourite: false });
  assert.equal(res.error, "TOO_MANY_WATCHED");
});

test("C-W5: twenty invalid codes are rejected and write 0 rows", async () => {
  const h = createHarness();
  await callTool(h, "watchlist");
  const before = h.storage.sqlWrites;
  const inputs = [
    "EURC", "a".repeat(13), "", "euro pa", "eurc!", "ünicode", "a", "has space",
    "eurc\n", "../etc", "eurc ", "craft-name", "name.with", "swfo/1", " psyc",
    "im ap", "X", "notacraft", "unknowncraft", "zzzz",
  ];
  assert.equal(inputs.length, 20);
  for (const code of inputs) {
    const res = await callTool(h, "watch_craft", { code, favourite: true });
    assert.ok(res.error === "INVALID_INPUT" || res.error === "UNKNOWN_CRAFT", `${code} -> ${res.error}`);
  }
  const codes = h.life.read("SELECT code FROM watch").map((row) => String(row.code)).sort();
  assert.deepEqual(codes, ["eurc", "psyc"]);
  assert.equal(h.storage.sqlWrites, before + 20);
});

test("seed table lists the four named crafts", () => {
  for (const code of ["eurc", "psyc", "imap", "swfo"]) {
    const craft = CRAFTS.find((c) => c.code === code);
    assert.ok(craft);
    assert.equal(typeof craft.spacecraftID, "number");
    assert.equal(craft.verified, false);
  }
});
