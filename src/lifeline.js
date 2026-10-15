import { Auth } from "./auth.js";
import { Clock } from "./clock.js";
import { Log } from "./log.js";
import { Json } from "./json.js";
import { Mcp } from "./mcp.js";
import { Sql, Store } from "./store.js";
import { RowBudget } from "./budget.js";
import { FeedHealth } from "./health.js";
import { ToolLimiter } from "./limiter.js";
import { AlertQueue } from "./alerts.js";
import { ContactTracker } from "./contacts.js";
import { WatchList } from "./watch.js";
import { LifelineState } from "./state.js";
import { FeedPoller } from "./poller.js";
import { McpProtocol } from "./protocol.js";
import { toolSpecs } from "./tools.js";
import { Time } from "./time.js";

/**
 * @typedef {import("./contacts.js").Contact} Contact
 */

export class Lifeline {
  /**
   * @param {{ storage: { sql: { exec: (q: string, ...a: unknown[]) => { toArray: () => Record<string, unknown>[] } }, getAlarm: () => Promise<number | null>, setAlarm: (t: number) => Promise<void> }, clock?: { now: () => number, delay: (ms: number, fn: () => void) => { clear: () => void } }, fetchImpl?: typeof fetch, log?: (entry: Record<string, string>) => void }} ctx
   * @param {{ API_KEY?: string, DEFAULT_TZ?: string }} env
   */
  constructor(ctx, env) {
    this.storage = ctx.storage;
    this.clock = ctx.clock ?? new Clock();
    this.fetchImpl = ctx.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.sink = ctx.log;
    this.auth = new Auth(env);
    this.budget = new RowBudget();
    this.health = new FeedHealth();
    this.limiter = new ToolLimiter(this.clock, this.auth.timeZone);
    this.store = new Store(this.storage, this.budget);
    const log = (/** @type {Record<string, string>} */ event) => Log.emit(event, this.sink);
    this.alerts = new AlertQueue(this.store, this.clock, this.auth.timeZone, this.health.place, log);
    this.contacts = new ContactTracker(log, (code, contact) => this.persistContact(code, contact));
    this.watchlist = new WatchList(this.store, log);
    this.state = new LifelineState();
    this.owners = { budget: this.budget, health: this.health, limiter: this.limiter, alerts: this.alerts };
    this.state.init(this.owners, this.clock.now());
    this.poller = new FeedPoller({
      clock: this.clock,
      host: this,
      auth: this.auth,
      health: this.health,
      budget: this.budget,
      alerts: this.alerts,
      contacts: this.contacts,
      watchlist: this.watchlist,
      state: this.state,
      store: this.store,
      owners: this.owners,
    });
    this.protocol = new McpProtocol(toolSpecs(this), (tool, args) => this.execute(tool, args));
    this.ensureSchema();
    this.watchlist.reload();
    this.contacts.load(this.store.read("SELECT * FROM contact"));
    this.loadState();
  }

  ensureSchema() {
    this.store.write("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
    this.store.write("CREATE TABLE IF NOT EXISTS watch (code TEXT PRIMARY KEY, favourite INTEGER NOT NULL, mute_until INTEGER)");
    this.store.write("CREATE TABLE IF NOT EXISTS contact (code TEXT PRIMARY KEY, id TEXT NOT NULL, open INTEGER NOT NULL, opened_at INTEGER NOT NULL, closed_at INTEGER, polls_since_close INTEGER NOT NULL, pushed INTEGER NOT NULL)");
    this.alerts.ensure();
    if (this.store.read("SELECT code FROM watch").length === 0) {
      this.store.write("INSERT INTO watch (code, favourite, mute_until) VALUES ('eurc', 1, NULL)");
      this.store.write("INSERT INTO watch (code, favourite, mute_until) VALUES ('psyc', 1, NULL)");
    }
  }

  loadState() {
    const rows = this.store.read("SELECT v FROM meta WHERE k = 'state'");
    if (!rows[0]) return;
    this.state.restore(String(rows[0].v), this.owners, (event) => Log.emit(event, this.sink));
  }

  /** @param {string} code @param {Contact} contact */
  persistContact(code, contact) {
    this.store.write(
      Sql.upsert("contact", "code", ["id", "open", "opened_at", "closed_at", "polls_since_close", "pushed"]),
      code,
      contact.id,
      contact.open ? 1 : 0,
      contact.openedAt,
      contact.closedAt,
      contact.pollsSinceClose,
      contact.pushed ? 1 : 0,
    );
  }

  /** @param {string} sql @param {...unknown} args */
  read(sql, ...args) {
    return this.store.read(sql, ...args);
  }

  /** @param {string} sql @param {...unknown} args */
  write(sql, ...args) {
    return this.store.write(sql, ...args);
  }

  reloadWatch() {
    this.watchlist.reload();
  }

  interval() {
    return this.poller.interval();
  }

  /** @param {string} xml */
  acceptSnapshot(xml) {
    return this.poller.acceptSnapshot(xml);
  }

  async alarm() {
    try {
      this.budget.roll(Time.utcDate(this.clock.now()));
      this.budget.charge();
      await this.poller.poll();
    } catch {
      Log.emit({ event: "alarm_error" }, this.sink);
    } finally {
      if (this.state.dirty(this.owners)) this.budget.persist(this.state, this.owners, this.store, this.clock.now(), true);
      await this.storage.setAlarm(this.clock.now() + this.poller.interval());
    }
  }

  async ensureAlarm() {
    if ((await this.storage.getAlarm()) == null) {
      this.budget.roll(Time.utcDate(this.clock.now()));
      this.budget.charge();
      await this.storage.setAlarm(this.clock.now() + this.poller.interval());
    }
  }

  /** @param {Request} request */
  async fetch(request) {
    await this.ensureAlarm();
    let message;
    try {
      message = await request.json();
    } catch {
      return Mcp.rpcError(null, -32700, "Parse error");
    }
    try {
      return Json.response(await this.protocol.rpc(message));
    } catch {
      return Mcp.rpcError(null, -32600, "Invalid Request");
    }
  }

  /** @param {import("./protocol.js").ToolDef} tool @param {Record<string, unknown>} args */
  async execute(tool, args) {
    if (!this.limiter.allow(tool.name)) return Mcp.error("RATE_LIMITED");
    const result = await tool.run(args);
    if (this.state.dirty(this.owners)) this.budget.persist(this.state, this.owners, this.store, this.clock.now(), true);
    return result;
  }
}
