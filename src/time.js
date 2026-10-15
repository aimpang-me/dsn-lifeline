export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export class Time {
  /** @param {number} ms @param {string} timeZone */
  static localDate(ms, timeZone) {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(ms));
    return `${Time.part(parts, "year")}-${Time.part(parts, "month")}-${Time.part(parts, "day")}`;
  }

  /** @param {number} ms @param {string} timeZone */
  static format(ms, timeZone) {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit", hour12: true }).formatToParts(new Date(ms));
    const dayPeriod = /pm/i.test(Time.part(parts, "dayPeriod")) ? "PM" : "AM";
    return `${Time.part(parts, "hour")}:${Time.part(parts, "minute")} ${dayPeriod}`;
  }

  /** @param {number} ms */
  static utcDate(ms) {
    return new Date(ms).toISOString().slice(0, 10);
  }

  /** @param {Intl.DateTimeFormatPart[]} parts @param {string} type */
  static part(parts, type) {
    return parts.find((part) => part.type === type)?.value ?? "";
  }
}
