import { createRequire } from "node:module";
import { checkRuntime } from "./runtime-check.js";
import worker, { Lifeline } from "../src/index.js";

const { DatabaseSync } = checkRuntime(process.versions.node, () => createRequire(import.meta.url)("node:sqlite"));
import { CRAFTS, CRAFT_BY_CODE, CODE_BY_ID } from "../src/crafts.js";
import { buildXml, withTimestamp, swfoDown } from "./xml.js";

export const KEY = "api-key-sentinel-value!!";
export const TOPIC = "topic-sentinel-dsn-lifeline-v1-ok";
export const TOKEN = "token-sentinel-dsn-lifeline-v1-xx";

export class FakeClock {
  /** @param {number} start */
  constructor(start) {
    this._now = start;
    /** @type {{ at: number, fn: () => void, cleared: boolean }[]} */
    this.timers = [];
  }
  now() {
    return this._now;
  }
  /** @param {number} ms @param {() => void} fn */
  delay(ms, fn) {
    const timer = { at: this._now + ms, fn, cleared: false };
    this.timers.push(timer);
    return { clear() { timer.cleared = true; } };
  }
  /** @param {number} ms */
  advance(ms) {
    const target = this._now + ms;
    for (;;) {
      const due = this.timers
        .filter((t) => !t.cleared && t.at <= target)
        .sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this._now = due.at;
      due.cleared = true;
      due.fn();
    }
    this._now = target;
  }
  pendingDelay() {
    const live = this.timers.filter((t) => !t.cleared).sort((a, b) => a.at - b.at)[0];
    return live ? live.at - this._now : null;
  }
}

export class FakeStorage {
  constructor() {
    const db = new DatabaseSync(":memory:");
    this.alarm = /** @type {number | null} */ (null);
    this.sqlWrites = 0;
    this.alarmWrites = 0;
    this.sql = {
      /** @param {string} query @param {...unknown} args */
      exec: (query, ...args) => {
        if (args.length > 100) throw new Error(`too many SQL parameters: ${args.length}`);
        if (!/^\s*select\b/i.test(query)) this.sqlWrites += 1;
        const rows = db.prepare(query).all(...args).map((row) => ({ ...row }));
        return { toArray: () => rows };
      },
    };
  }
  async getAlarm() {
    return this.alarm;
  }
  /** @param {number} t */
  async setAlarm(t) {
    this.alarm = t;
    this.alarmWrites += 1;
  }
  get writes() {
    return this.sqlWrites + this.alarmWrites;
  }
}

export function createHarness(overrides = {}) {
  /** @type {object[]} */
  const logs = [];
  /** @type {{ url: string, headers?: unknown, body?: unknown }[]} */
  const fetches = [];
  const clock = new FakeClock(overrides.now ?? Date.parse("2026-10-15T16:00:00Z"));
  const storage = new FakeStorage();
  const feed = {
    status: 200,
    /** @type {string | (() => string)} */
    body: "<dsn><timestamp>0</timestamp></dsn>",
    /** @type {((url: string) => boolean) | null} */
    hang: null,
    configStatus: 200,
  };
  const env = {
    API_KEY: KEY,
    DEFAULT_TZ: "America/Toronto",
    ...(overrides.env ?? {}),
  };
  /** @type {typeof fetch} */
  const fetchImpl = async (url, init) => {
    const u = String(url);
    fetches.push({ url: u, headers: init?.headers, body: init?.body });
    if (feed.hang && feed.hang(u)) {
      return await new Promise((resolve, reject) => {
        const fail = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        if (init?.signal?.aborted) fail();
        else init?.signal?.addEventListener("abort", fail, { once: true });
      });
    }
    if (u.includes("config.xml")) return new Response("<config/>", { status: feed.configStatus });
    const body = typeof feed.body === "function" ? feed.body() : feed.body;
    return new Response(body, { status: feed.status });
  };
  const life = new Lifeline({ storage, clock, fetchImpl, log: (entry) => logs.push(entry) }, env);
  const harness = {
    life,
    clock,
    storage,
    feed,
    fetches,
    logs,
    env,
    doCalls: 0,
  };
  let bound = false;
  harness.bind = () => {
    if (bound) return harness;
    bound = true;
    harness.env.LIFELINE = {
      idFromName(name) {
        harness.doCalls += 1;
        return name;
      },
      get() {
        harness.doCalls += 1;
        return {
          fetch(input, init) {
            harness.doCalls += 1;
            return harness.life.fetch(new Request(input, init));
          },
        };
      },
    };
    return harness;
  };
  return harness;
}

export async function callTool(h, name, args) {
  h.bind();
  const res = await worker.fetch(mcpRequest("tools/call", { name, arguments: args ?? {} }, h.env), h.env);
  const rpc = await res.json();
  const result = rpc.result;
  return {
    status: res.status,
    rpc,
    result,
    text: result?.content?.[0]?.text,
    data: result?.structuredContent,
    error: result?.structuredContent?.error,
    isError: result?.isError === true,
  };
}

export function mcpRequest(method, params, env, extraHeaders = {}) {
  const headers = { "content-type": "application/json", ...extraHeaders };
  if (env?.API_KEY && !headers.Authorization && !headers["X-API-Key"]) headers.Authorization = `Bearer ${env.API_KEY}`;
  return new Request("https://dsn.example/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

export async function settle(h) {
  for (let i = 0; i < 20; i++) {
    if (h.clock.pendingDelay() != null) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** Drive one alarm, then move the fake clock to the armed time. */
export async function step(h) {
  await h.life.alarm();
  if (h.storage.alarm != null && h.storage.alarm > h.clock.now()) h.clock.advance(h.storage.alarm - h.clock.now());
}

export function installTestCrafts() {
  for (let n = 5; n <= 20; n += 1) {
    const num = String(n).padStart(2, "0");
    const code = `slot${num}`;
    if (CRAFT_BY_CODE.has(code)) continue;
    const craft = { code, name: `Slot ${num}`, spacecraftID: -(90000 + n), verified: false };
    CRAFTS.push(craft);
    CRAFT_BY_CODE.set(code, craft);
    CODE_BY_ID.set(craft.spacecraftID, code);
  }
}

installTestCrafts();

export function idOf(code) {
  const craft = CRAFTS.find((c) => c.code === code);
  if (!craft) throw new Error(`missing craft ${code}`);
  return String(craft.spacecraftID);
}

export function liveBody(h, craftCodes, { dataRate = "0" } = {}) {
  const dishes = craftCodes.map((code, i) => swfoDown({
    dish: IDLE_DISH(i),
    spacecraftID: idOf(code),
    spacecraft: "feed-name-must-not-leak",
    targetId: "-1",
    dataRate,
    active: "true",
  }));
  return () => buildXml({ timestamp: h.clock.now(), dishes });
}

function IDLE_DISH(i) {
  return ["DSS14", "DSS24", "DSS25", "DSS26", "DSS34", "DSS35", "DSS36", "DSS43", "DSS54", "DSS55", "DSS63", "DSS65"][i];
}

export function quietBody(h) {
  return () => buildXml({ timestamp: h.clock.now() });
}

export function staleBody(h) {
  return () => buildXml({ timestamp: h.clock.now() - 10 * 60 * 1000 });
}

export { worker, buildXml, withTimestamp, CRAFTS };
