import { LifelineState } from "./state.js";

/**
 * @typedef {{ favourite: boolean, muteUntil: number | null }} WatchRow
 */

export class WatchList {
  /**
   * @param {import("./store.js").Store} store
   * @param {(event: Record<string, string>) => void} log
   */
  constructor(store, log) {
    this.store = store;
    this.log = log;
    this.rows = /** @type {Map<string, WatchRow>} */ (new Map());
  }

  get size() {
    return this.rows.size;
  }

  /** @param {string} code */
  has(code) {
    return this.rows.has(code);
  }

  /** @param {string} code */
  get(code) {
    return this.rows.get(code);
  }

  /** @param {string} code @param {number} now */
  muted(code, now) {
    const row = this.rows.get(code);
    return row?.muteUntil != null && row.muteUntil > now;
  }

  reload() {
    const loaded = this.store.read("SELECT code, favourite, mute_until FROM watch");
    /** @type {Map<string, WatchRow>} */
    const next = new Map();
    for (const row of loaded) {
      LifelineState.guard(() => {
        const parsed = WatchList.parse(row);
        next.set(parsed.code, parsed.row);
      }, this.log);
    }
    this.rows = next;
  }

  view() {
    return [...this.rows.entries()].map(([code, row]) => ({
      code,
      favourite: row.favourite,
      mute_end: row.muteUntil,
    }));
  }

  /** @param {Record<string, unknown>} row */
  static parse(row) {
    const code = String(row.code ?? "");
    if (!/^[a-z0-9]{2,12}$/.test(code)) throw new Error("watch");
    const favourite = Number(row.favourite);
    if (favourite !== 0 && favourite !== 1) throw new Error("watch");
    const muteUntil = row.mute_until == null ? null : Number(row.mute_until);
    if (muteUntil != null && !Number.isFinite(muteUntil)) throw new Error("watch");
    return { code, row: { favourite: favourite === 1, muteUntil } };
  }
}
