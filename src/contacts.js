import { LifelineState } from "./state.js";

/**
 * @typedef {{ id: string, open: boolean, openedAt: number, closedAt: number | null, pollsSinceClose: number, pushed: boolean }} Contact
 */

export class ContactTracker {
  /**
   * @param {(event: Record<string, string>) => void} log
   * @param {(code: string, contact: Contact) => void} persist
   */
  constructor(log, persist) {
    this.log = log;
    this.persist = persist;
    this.contacts = /** @type {Record<string, Contact>} */ ({});
    this.streak = /** @type {Record<string, number>} */ ({});
    this.miss = /** @type {Record<string, number>} */ ({});
  }

  /** @param {Record<string, unknown>[]} rows */
  load(rows) {
    for (const row of rows) {
      LifelineState.guard(() => {
        const parsed = ContactTracker.parse(row);
        this.contacts[parsed.code] = parsed.contact;
      }, this.log);
    }
  }

  /** @param {Record<string, unknown>} row */
  static parse(row) {
    const code = String(row.code ?? "");
    const id = String(row.id ?? "");
    if (!/^[a-z0-9]{2,12}$/.test(code) || id.length === 0) throw new Error("contact");
    const openedAt = Number(row.opened_at);
    if (!Number.isFinite(openedAt)) throw new Error("contact");
    const closedAt = row.closed_at == null ? null : Number(row.closed_at);
    if (closedAt != null && !Number.isFinite(closedAt)) throw new Error("contact");
    const pollsSinceClose = Number(row.polls_since_close);
    if (!Number.isFinite(pollsSinceClose)) throw new Error("contact");
    return {
      code,
      contact: {
        id,
        open: Number(row.open) === 1,
        openedAt,
        closedAt,
        pollsSinceClose,
        pushed: Number(row.pushed) === 1,
      },
    };
  }

  /**
   * Two active snapshots open a contact. Three misses close it.
   * A reopen inside 15 good polls does not raise a favourite.
   * @param {string} code
   * @param {boolean} isTalking
   * @param {number} now
   */
  observe(code, isTalking, now) {
    if (isTalking) return this.seen(code, now);
    return this.missed(code, now);
  }

  /** @param {string} code @param {number} now */
  seen(code, now) {
    this.streak[code] = (this.streak[code] ?? 0) + 1;
    this.miss[code] = 0;
    const contact = this.contacts[code];
    if (contact?.open) return true;
    if ((this.streak[code] ?? 0) < 2) return false;
    if (contact && !contact.open && contact.pollsSinceClose <= 15) {
      contact.open = true;
      contact.closedAt = null;
      this.persist(code, contact);
      return false;
    }
    this.contacts[code] = { id: `${code}:${now}`, open: true, openedAt: now, closedAt: null, pollsSinceClose: 0, pushed: false };
    this.persist(code, this.contacts[code]);
    return true;
  }

  /** @param {string} code @param {number} now */
  missed(code, now) {
    this.streak[code] = 0;
    const contact = this.contacts[code];
    if (contact?.open) {
      const miss = (this.miss[code] ?? 0) + 1;
      this.miss[code] = miss;
      if (miss >= 3) {
        contact.open = false;
        contact.closedAt = now;
        contact.pollsSinceClose = 0;
        this.miss[code] = 0;
        this.persist(code, contact);
      }
      return false;
    }
    if (contact && !contact.open) contact.pollsSinceClose += 1;
    return false;
  }
}
