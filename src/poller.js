import { CRAFTS } from "./crafts.js";
import { DsnScanner } from "./parser.js";
import { Feed } from "./feed.js";
import { Talking } from "./talking.js";
import { Http } from "./http.js";
import { ROW_SLOW } from "./budget.js";
import { Time, MINUTE, HOUR, DAY } from "./time.js";

const FEED = "https://eyes.nasa.gov/dsn/data/dsn.xml";
const CONFIG = "https://eyes.nasa.gov/dsn/config.xml";
const FAV_CAP = 6;
const SYS_CAP = 10;

export class FeedPoller {
  /**
   * @param {{ clock: { now: () => number, delay: (ms: number, fn: () => void) => { clear: () => void } }, host: { fetchImpl: typeof fetch }, auth: { timeZone: string }, health: import("./health.js").FeedHealth, budget: import("./budget.js").RowBudget, alerts: import("./alerts.js").AlertQueue, contacts: import("./contacts.js").ContactTracker, watchlist: import("./watch.js").WatchList, state: import("./state.js").LifelineState, store: import("./store.js").Store, owners: import("./state.js").Owners }} deps
   */
  constructor(deps) {
    this.clock = deps.clock;
    this.host = deps.host;
    this.auth = deps.auth;
    this.health = deps.health;
    this.budget = deps.budget;
    this.alerts = deps.alerts;
    this.contacts = deps.contacts;
    this.watchlist = deps.watchlist;
    this.state = deps.state;
    this.store = deps.store;
    this.owners = deps.owners;
  }

  interval() {
    return this.health.backoff(this.budget.baseInterval(), this.clock.now());
  }

  async poll() {
    const now = this.clock.now();
    const today = Time.utcDate(now);
    if (this.alerts.prunedOn !== today) {
      this.alerts.prunedOn = today;
      this.alerts.prune(now);
    }
    this.watchlist.reload();
    await this.maybeConfig();
    await this.fetchFeed();
    this.maybeStale();
    this.maybeCanary();
    if (this.budget.note()) this.budget.persist(this.state, this.owners, this.store, this.clock.now(), true);
    this.alerts.dropExpired();
    this.budget.persist(this.state, this.owners, this.store, this.clock.now(), false);
  }

  async maybeConfig() {
    const now = this.clock.now();
    if (this.health.configAttemptAt != null && now - this.health.configAttemptAt < DAY) return;
    if (this.health.configAt != null && now - this.health.configAt < DAY) return;
    this.health.configAttemptAt = now;
    try {
      const page = await Http.fetch(this.host.fetchImpl, this.clock, CONFIG, 8000);
      if (!page.ok) return;
    } catch {
      return;
    }
    this.health.configAt = now;
  }

  async fetchFeed() {
    const minute = Math.floor(this.clock.now() / MINUTE);
    /** @type {{ ok: boolean, text: string }} */
    let page;
    try {
      page = await Http.fetch(this.host.fetchImpl, this.clock, `${FEED}?r=${minute}`, 8000);
    } catch {
      this.health.noteFailure(this.clock.now());
      return;
    }
    if (!page.ok) {
      this.health.noteFailure(this.clock.now());
      return;
    }
    await this.acceptSnapshot(page.text);
  }

  /** @param {string} xml */
  async acceptSnapshot(xml) {
    const parsed = DsnScanner.parse(xml);
    if (!parsed.ok) {
      if (parsed.reason === "SHAPE") this.health.noteShape(this.clock.now(), () => this.queueShape());
      else this.health.noteFailure(this.clock.now());
      return { accepted: false };
    }
    if (!Feed.judge(parsed.snapshot, this.health.lastTimestamp, this.clock.now())) {
      this.health.noteFailure(this.clock.now());
      return { accepted: false };
    }
    this.onGood(parsed.snapshot);
    return { accepted: true };
  }

  /** @param {import("./parser.js").Snapshot} snapshot */
  onGood(snapshot) {
    this.health.noteGood(snapshot.timestamp, this.clock.now());
    const talking = Talking.codes(snapshot, CRAFTS);
    if (talking.size > 0) {
      this.health.lastTalkingAt = this.clock.now();
      this.health.canarySent = false;
    }
    for (const [code, place] of Talking.locations(snapshot)) this.health.place.set(code, place);
    for (const craft of CRAFTS) {
      if (this.contacts.observe(craft.code, talking.has(craft.code), this.clock.now())) this.maybeFavourite(craft.code);
    }
    if (this.budget.rowsToday >= ROW_SLOW) this.budget.slowLatched = true;
    this.budget.persist(this.state, this.owners, this.store, this.clock.now(), true);
  }

  queueShape() {
    const now = this.clock.now();
    this.alerts.enqueueOnce({ key: `sys:shape:${Time.localDate(now, this.auth.timeZone)}`, kind: "shape", craft: null, cap: SYS_CAP });
  }

  /** @param {string} code */
  maybeFavourite(code) {
    const watch = this.watchlist.get(code);
    const contact = this.contacts.contacts[code];
    if (!watch?.favourite || !contact?.open || this.watchlist.muted(code, this.clock.now())) return;
    const date = Time.localDate(this.clock.now(), this.auth.timeZone);
    this.alerts.enqueueOnce({ key: `fav:${code}:${date}`, kind: "fav", craft: code, cap: FAV_CAP });
  }

  maybeStale() {
    if (this.health.lastGoodAt == null) return;
    if (this.clock.now() - this.health.lastGoodAt < 6 * HOUR) return;
    const key = `sys:stale:${this.health.lastGoodAt}`;
    if (this.health.staleAnchor === this.health.lastGoodAt && !this.alerts.has(key)) return;
    this.alerts.enqueueOnce({ key, kind: "stale", craft: null, cap: SYS_CAP });
    if (this.alerts.has(key)) this.health.staleAnchor = this.health.lastGoodAt;
  }

  maybeCanary() {
    const anchor = this.health.lastTalkingAt ?? this.health.startedAt;
    const quietFor = this.clock.now() - anchor;
    const coverage = this.health.coverage24();
    if (quietFor < DAY || coverage == null || coverage < 90) return;
    const key = `sys:canary:${anchor}`;
    if (this.health.canarySent && !this.alerts.has(key)) return;
    this.alerts.enqueueOnce({ key, kind: "canary", craft: null, cap: SYS_CAP });
    if (this.alerts.has(key)) this.health.canarySent = true;
  }
}
