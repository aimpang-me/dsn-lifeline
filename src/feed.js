import { MINUTE } from "./time.js";

const FIVE_MIN = 5 * MINUTE;

export class Feed {
  /**
   * @param {{ timestamp: number, stationCount: number, dishCount: number }} snapshot
   * @param {number | null} lastTimestamp
   * @param {number} now
   */
  static judge(snapshot, lastTimestamp, now) {
    const age = now - snapshot.timestamp;
    if (age > FIVE_MIN || age < 0) return false;
    if (lastTimestamp != null && snapshot.timestamp <= lastTimestamp) return false;
    if (snapshot.stationCount !== 3) return false;
    if (snapshot.dishCount < 10) return false;
    return true;
  }
}
