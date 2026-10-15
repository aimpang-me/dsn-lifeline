import { DsnScanner } from "../../../src/parser.js";

/**
 * Turn one fetch result into the step 0 poll record. No CPU timing: a Worker cannot time itself.
 * @param {{ status: number, body: string, previousTimestamp: number | null, now: number }} input
 */
export function recordPoll({ status, body, previousTimestamp, now }) {
  const bytes = Buffer.byteLength(body ?? "");
  const parsed = DsnScanner.parse(body ?? "");
  const snapshot = parsed.ok ? parsed.snapshot : null;
  const timestamp = snapshot?.timestamp ?? null;
  const active = [];
  const activities = new Set();
  if (snapshot) {
    for (const dish of snapshot.dishes) {
      for (const signal of dish.signals) {
        if (signal.activity) activities.add(signal.activity);
        if (signal.type === "downlink" && signal.active && signal.spacecraftID != null) active.push(signal.spacecraftID);
      }
    }
  }
  return {
    status,
    bytes,
    accepted: Boolean(parsed.ok && snapshot && snapshot.stationCount === 3 && snapshot.dishCount >= 10),
    snapshotAgeMs: timestamp == null ? null : now - timestamp,
    timestamp,
    timestampAdvanced: previousTimestamp != null && timestamp != null && timestamp > previousTimestamp,
    dishCount: snapshot?.dishCount ?? 0,
    activeDownlinkSpacecraftIDs: [...new Set(active)],
    activityStrings: [...activities],
  };
}

/** @param {number} now */
export function feedUrls(now) {
  const minute = Math.floor(now / 60_000);
  return {
    plain: "https://eyes.nasa.gov/dsn/data/dsn.xml",
    cacheBust: `https://eyes.nasa.gov/dsn/data/dsn.xml?r=${minute}`,
  };
}
