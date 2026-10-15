import { HOUR } from "./time.js";

export class FeedHealth {
  constructor() {
    this.configAttemptAt = /** @type {number | null} */ (null);
    this.coverage = /** @type {{ hour: number, good: number, expected: number }[]} */ ([]);
    this.place = /** @type {Map<string, { dish: string | null, complex: string | null }>} */ (new Map());
    this.lastTimestamp = /** @type {number | null} */ (null);
    this.lastGoodAt = /** @type {number | null} */ (null);
    this.failureStartedAt = /** @type {number | null} */ (null);
    this.consecutiveFailures = 0;
    this.configAt = /** @type {number | null} */ (null);
    this.canarySent = false;
    this.staleAnchor = /** @type {number | null} */ (null);
    this.lastTalkingAt = /** @type {number | null} */ (null);
    this.startedAt = 0;
    this.shapeTimes = /** @type {number[]} */ ([]);
  }

  /** @param {number} now */
  ageSeconds(now) {
    if (this.lastTimestamp == null) return null;
    return Math.max(0, Math.round((now - this.lastTimestamp) / 1000));
  }

  /** @param {number} now */
  noteFailure(now) {
    if (this.failureStartedAt == null) this.failureStartedAt = now;
    this.consecutiveFailures += 1;
    this.addCoverage(false, now);
  }

  /**
   * @param {number} now
   * @param {() => void} onBurst
   */
  noteShape(now, onBurst) {
    this.noteFailure(now);
    this.shapeTimes.push(now);
    this.shapeTimes = this.shapeTimes.filter((t) => now - t <= HOUR);
    if (this.shapeTimes.length >= 3) onBurst();
  }

  /** @param {number} timestamp @param {number} now */
  noteGood(timestamp, now) {
    this.lastTimestamp = timestamp;
    this.lastGoodAt = now;
    this.consecutiveFailures = 0;
    this.failureStartedAt = null;
    this.addCoverage(true, now);
  }

  /** @param {boolean} good @param {number} now */
  addCoverage(good, now) {
    const hour = Math.floor(now / HOUR);
    let bucket = this.coverage.find((row) => row.hour === hour);
    if (!bucket) {
      bucket = { hour, good: 0, expected: 0 };
      this.coverage.push(bucket);
    }
    bucket.expected += 1;
    if (good) bucket.good += 1;
    const cut = hour - 24;
    this.coverage = this.coverage.filter((row) => row.hour >= cut);
  }

  coverage24() {
    const expected = this.coverage.reduce((sum, row) => sum + row.expected, 0);
    if (!expected) return null;
    const good = this.coverage.reduce((sum, row) => sum + row.good, 0);
    return (good / expected) * 100;
  }

  /** @param {number} base @param {number} now */
  backoff(base, now) {
    const failedFor = this.failureStartedAt == null ? 0 : now - this.failureStartedAt;
    if (failedFor >= HOUR) return Math.max(base, 15 * 60_000);
    if (this.consecutiveFailures >= 5) return Math.max(base, 5 * 60_000);
    return base;
  }
}
