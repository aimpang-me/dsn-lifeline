import { Sql, Store } from "./store.js";
import { MINUTE } from "./time.js";

export const ROW_SLOW = 70_000;
export const ROW_FLAG = 80_000;
export const ROW_CAP = 100_000;
const PERSIST_EVERY = 30 * MINUTE;

export class RowBudget {
  constructor() {
    this.rowsToday = 0;
    this.rowsDay = "";
    this.budgetPushedOn = /** @type {string | null} */ (null);
    this.lastBudgetPersist = 0;
    this.slowLatched = false;
  }

  get slow() {
    return this.rowsToday >= ROW_SLOW;
  }

  charge() {
    this.rowsToday += 1;
  }

  /** @param {string} day */
  roll(day) {
    if (this.rowsDay === day) return;
    this.rowsDay = day;
    this.rowsToday = 0;
    this.budgetPushedOn = null;
    this.slowLatched = false;
  }

  baseInterval() {
    return this.slow ? 120_000 : 60_000;
  }

  note() {
    let force = false;
    if (this.rowsToday >= ROW_SLOW && !this.slowLatched) {
      this.slowLatched = true;
      force = true;
    }
    if (this.rowsToday < ROW_FLAG || this.budgetPushedOn === this.rowsDay) return force;
    this.budgetPushedOn = this.rowsDay;
    return true;
  }

  /**
   * @param {import("./state.js").LifelineState} state
   * @param {import("./state.js").Owners} owners
   * @param {Store} store
   * @param {number} now
   * @param {boolean} force
   */
  persist(state, owners, store, now, force) {
    if (!force && now - this.lastBudgetPersist < PERSIST_EVERY) return;
    const payload = state.toJSON(owners);
    payload.rowsToday = this.rowsToday + 1;
    state.mark(owners);
    this.lastBudgetPersist = now;
    store.write(Sql.upsert("meta", "k", ["v"]), "state", JSON.stringify(payload));
  }
}
