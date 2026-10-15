import { writeFileSync } from "node:fs";
import { buildXml, swfoDown, INJECTED } from "../test/xml.js";

const TS = 1_700_000_000_000;
const out = new URL("../test/fixtures/", import.meta.url);

const files = {
  "swfo-rate0": buildXml({ timestamp: TS, dishes: [swfoDown({ dataRate: "0", active: "true" })] }),
  "dss56-two-signals": buildXml({
    timestamp: TS,
    dishes: [{
      name: "DSS56",
      targets: [{ id: "-999", name: "SWFO-L1" }, { id: "-159", name: "EURC" }],
      signals: [
        { dir: "down", signalType: "data", active: "true", debug: "DATA", dataRate: "0", spacecraft: "SWFO-L1", spacecraftID: "-231" },
        { dir: "down", signalType: "none", active: "false", debug: "IDLE", dataRate: "-1", spacecraft: "EURC", spacecraftID: "-159" },
      ],
    }],
  }),
  "duplicate-signal": buildXml({
    timestamp: TS,
    dishes: [swfoDown({ dish: "DSS14" }), swfoDown({ dish: "DSS43" })],
  }),
  "handover-1": buildXml({ timestamp: TS, dishes: [swfoDown({ dish: "DSS14" })] }),
  "handover-2": buildXml({ timestamp: TS + 60_000, dishes: [swfoDown({ dish: "DSS43" })] }),
  "eurc-inactive": buildXml({
    timestamp: TS,
    dishes: [{
      name: "DSS43",
      targets: [{ id: "-159", name: "EURC" }],
      signals: [
        { dir: "down", signalType: "none", active: "false", debug: "IDLE", dataRate: "0", spacecraft: "EURC", spacecraftID: "-159" },
        { dir: "up", signalType: "none", active: "false", debug: "IDLE", dataRate: "-1", spacecraft: "EURC", spacecraftID: "-159" },
      ],
    }],
  }),
  "stale-ts": buildXml({ timestamp: 1_600_000_000_000 }),
  "no-stations": buildXml({ timestamp: TS, stationCount: 0, dishCount: 0 }),
  "bad-numbers": buildXml({
    timestamp: TS,
    dishes: [{ name: "DSS14", signals: [{ dir: "down", dataRate: "nope", spacecraftID: "-231", spacecraft: "SWFO-L1" }] }],
  }),
  "injected-name": buildXml({
    timestamp: TS,
    dishes: [swfoDown({ spacecraft: INJECTED, debug: INJECTED })],
  }),
  "swfo-negation": buildXml({ timestamp: TS, dishes: [swfoDown({ targetId: "-999", spacecraftID: "-231" })] }),
  "escb-negation": buildXml({
    timestamp: TS,
    dishes: [{
      name: "DSS63",
      targets: [{ id: "-9", name: "ESCB" }],
      signals: [
        { dir: "down", signalType: "data", active: "true", debug: "DATA", dataRate: "10", spacecraft: "ESCB", spacecraftID: "-80" },
      ],
    }],
  }),
  "uplink-only": buildXml({
    timestamp: TS,
    dishes: [{
      name: "DSS14",
      targets: [{ id: "-159", name: "EURC" }],
      signals: [
        { dir: "down", signalType: "none", active: "false", debug: "IDLE", dataRate: "-1", spacecraft: "EURC", spacecraftID: "-159" },
        { dir: "up", signalType: "data", active: "true", debug: "UP", dataRate: "20", spacecraft: "EURC", spacecraftID: "-159" },
      ],
    }],
  }),
};

for (const [name, xml] of Object.entries(files)) writeFileSync(new URL(`${name}.xml`, out), xml);
console.log(`wrote ${Object.keys(files).length} fixtures`);
