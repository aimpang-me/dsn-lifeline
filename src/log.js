const KEYS = ["event", "key", "kind", "status"];

export class Log {
  /**
   * @param {Record<string, string>} event
   * @param {(entry: Record<string, string>) => void} [sink]
   */
  static emit(event, sink) {
    /** @type {Record<string, string>} */
    const safe = {};
    for (const key of KEYS) {
      if (typeof event[key] === "string") safe[key] = event[key];
    }
    sink?.(safe);
    console.log(JSON.stringify(safe));
  }
}
