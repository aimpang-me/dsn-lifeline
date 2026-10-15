import { Time, MINUTE, DAY } from "./time.js";

const QUEUE_CAP = 100;
const SQL_PARAMS = 100;
const RELEVANCE = 20 * MINUTE;

export class AlertQueue {
  /**
   * @param {import("./store.js").Store} store
   * @param {{ now: () => number }} clock
   * @param {string} timeZone
   * @param {Map<string, { dish: string | null, complex: string | null }>} place
   * @param {(event: Record<string, string>) => void} log
   */
  constructor(store, clock, timeZone, place, log) {
    this.store = store;
    this.clock = clock;
    this.timeZone = timeZone;
    this.place = place;
    this.log = log;
    this.prunedOn = /** @type {string | null} */ (null);
  }

  ensure() {
    this.store.write("CREATE TABLE IF NOT EXISTS alert (id TEXT PRIMARY KEY, kind TEXT NOT NULL, craft TEXT, dish TEXT, station TEXT, at INTEGER NOT NULL, expire_at INTEGER NOT NULL, status TEXT NOT NULL, day TEXT NOT NULL)");
    const cols = this.store.read("PRAGMA table_info(alert)");
    if (cols.some((col) => String(col.name) === "day")) return;
    this.store.write("ALTER TABLE alert ADD COLUMN day TEXT NOT NULL DEFAULT ''");
    const legacy = this.store.read("SELECT id, at FROM alert WHERE day = ''");
    for (const row of legacy) {
      this.store.write("UPDATE alert SET day = ? WHERE id = ?", Time.localDate(Number(row.at), this.timeZone), String(row.id));
    }
  }

  /**
   * One insert, or one :retry after a drop, while the cap still has room.
   * @param {{ key: string, kind: string, craft: string | null, cap: number }} spec
   */
  enqueueOnce({ key, kind, craft, cap }) {
    const retryKey = `${key}:retry`;
    if (this.has(retryKey)) return;
    const now = this.clock.now();
    const existing = this.store.read("SELECT status FROM alert WHERE id = ?", key);
    if (existing.length > 0) {
      if (String(existing[0].status) !== "dropped") return;
      if (this.count(kind) >= cap) return;
      this.insert(retryKey, kind, craft, now, now + RELEVANCE);
      return;
    }
    if (this.count(kind) >= cap) return;
    this.insert(key, kind, craft, now, now + RELEVANCE);
  }

  /** @param {string} kind */
  count(kind) {
    const date = Time.localDate(this.clock.now(), this.timeZone);
    if (kind === "fav") return this.favouriteCount(date);
    return this.systemCount(date);
  }

  /** @param {string} date */
  favouriteCount(date) {
    const rows = this.store.read("SELECT COUNT(*) AS n FROM alert WHERE kind = 'fav' AND day = ?", date);
    return Number(rows[0]?.n ?? 0);
  }

  /** @param {string} date */
  systemCount(date) {
    const rows = this.store.read("SELECT COUNT(*) AS n FROM alert WHERE day = ? AND kind IN ('stale', 'shape', 'canary')", date);
    return Number(rows[0]?.n ?? 0);
  }

  /**
   * @param {string} key
   * @param {string} kind
   * @param {string | null} craft
   * @param {number} queuedAt
   * @param {number} expireAt
   */
  insert(key, kind, craft, queuedAt, expireAt) {
    if (this.has(key)) return false;
    this.dropExpired();
    this.makeRoom();
    const place = craft ? this.place.get(craft) : null;
    this.store.write(
      "INSERT INTO alert (id, kind, craft, dish, station, at, expire_at, status, day) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)",
      key,
      kind,
      craft,
      place?.dish ?? null,
      place?.complex ?? null,
      queuedAt,
      expireAt,
      Time.localDate(queuedAt, this.timeZone),
    );
    return true;
  }

  /** @param {string} key */
  has(key) {
    return this.store.read("SELECT id FROM alert WHERE id = ?", key).length > 0;
  }

  dropExpired() {
    const now = this.clock.now();
    const rows = this.store.read("SELECT id, kind FROM alert WHERE status = 'pending' AND expire_at <= ?", now);
    for (const row of rows) this.drop(String(row.id), String(row.kind));
  }

  /** @param {string} key @param {string} kind */
  drop(key, kind) {
    this.store.write("UPDATE alert SET status = 'dropped' WHERE id = ?", key);
    this.log({ event: "alert_dropped", key, kind });
  }

  makeRoom() {
    const pending = this.store.read("SELECT id, kind FROM alert WHERE status = 'pending' ORDER BY at ASC, id ASC");
    const extra = pending.length - (QUEUE_CAP - 1);
    for (let i = 0; i < extra; i++) this.drop(String(pending[i].id), String(pending[i].kind));
  }

  /** @param {string} code */
  dropPendingFavourites(code) {
    const rows = this.store.read("SELECT id FROM alert WHERE status = 'pending' AND kind = 'fav' AND craft = ?", code);
    for (const row of rows) this.drop(String(row.id), "fav");
  }

  /**
   * Delete rows older than two days. A no-op delete would still spend a budget row, so skip it.
   * @param {number} now
   */
  prune(now) {
    const cutoff = now - 2 * DAY;
    const old = this.store.read("SELECT id FROM alert WHERE at < ? LIMIT 1", cutoff);
    if (old.length === 0) return;
    this.store.write("DELETE FROM alert WHERE at < ?", cutoff);
  }

  pending() {
    this.dropExpired();
    return this.store.read("SELECT id, kind, craft, dish, station, at FROM alert WHERE status = 'pending' ORDER BY at ASC, id ASC");
  }

  /** @param {string[]} ids */
  ack(ids) {
    /** @type {Set<string>} */
    const got = new Set();
    for (let i = 0; i < ids.length; i += SQL_PARAMS) {
      const batch = ids.slice(i, i + SQL_PARAMS);
      const marks = batch.map(() => "?").join(", ");
      const rows = this.store.write(
        `UPDATE alert SET status = 'acked' WHERE id IN (${marks}) AND status = 'pending' RETURNING id`,
        ...batch,
      );
      for (const row of rows) got.add(String(row.id));
    }
    return ids.filter((id) => got.delete(id));
  }
}
