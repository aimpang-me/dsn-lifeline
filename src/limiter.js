import { HOUR, Time } from "./time.js";

export class ToolLimiter {
  /** @param {{ now: () => number }} clock @param {string} timeZone */
  constructor(clock, timeZone) {
    this.clock = clock;
    this.timeZone = timeZone;
    this.toolHour = /** @type {number | null} */ (null);
    this.toolCalls = 0;
    this.testPushes = 0;
    this.callDay = /** @type {string | null} */ (null);
    this.daily = { watch: 0, mute: 0, unwatch: 0 };
  }

  /** @param {string} name */
  allow(name) {
    const hour = Math.floor(this.clock.now() / HOUR);
    if (this.toolHour !== hour) {
      this.toolHour = hour;
      this.toolCalls = 0;
      this.testPushes = 0;
    }
    if (this.toolCalls >= 60) return false;
    if (name === "test_alert" && this.testPushes >= 3) return false;
    this.toolCalls += 1;
    if (name === "test_alert") this.testPushes += 1;
    return true;
  }

  /**
   * Spend one daily call, or return the error code and leave the counter alone.
   * @param {"watch" | "mute" | "unwatch"} bucket
   * @param {number} limit
   * @param {() => string | null} [blocked]
   * @returns {string | null}
   */
  take(bucket, limit, blocked = () => null) {
    const day = Time.localDate(this.clock.now(), this.timeZone);
    if (this.callDay !== day) {
      this.callDay = day;
      this.daily = { watch: 0, mute: 0, unwatch: 0 };
    }
    if (this.daily[bucket] >= limit) return "RATE_LIMITED";
    const reason = blocked();
    if (reason) return reason;
    this.daily[bucket] += 1;
    return null;
  }
}
