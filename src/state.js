import { ROW_SLOW } from "./budget.js";
import { Time } from "./time.js";

/**
 * @typedef {import("./budget.js").RowBudget} RowBudget
 * @typedef {import("./health.js").FeedHealth} FeedHealth
 * @typedef {import("./limiter.js").ToolLimiter} ToolLimiter
 * @typedef {import("./alerts.js").AlertQueue} AlertQueue
 * @typedef {{ budget: RowBudget, health: FeedHealth, limiter: ToolLimiter, alerts: AlertQueue }} Owners
 * @typedef {"number" | "number?" | "string" | "string?" | "boolean" | "numbers"} FieldKind
 * @typedef {{ key: string, kind: FieldKind, default: unknown | ((now: number) => unknown), limit?: boolean, owner: keyof Owners, get?: (owners: Owners) => unknown, set?: (owners: Owners, value: unknown) => void }} Field
 */

/** @type {Field[]} */
export const FIELDS = [
  { key: "rowsToday", kind: "number", default: 0, owner: "budget" },
  { key: "rowsDay", kind: "string", default: (/** @type {number} */ now) => Time.utcDate(now), owner: "budget" },
  { key: "budgetPushedOn", kind: "string?", default: null, owner: "budget" },
  { key: "configAt", kind: "number?", default: null, owner: "health" },
  { key: "lastGoodAt", kind: "number?", default: null, owner: "health" },
  { key: "lastTimestamp", kind: "number?", default: null, owner: "health" },
  { key: "lastTalkingAt", kind: "number?", default: null, owner: "health" },
  { key: "startedAt", kind: "number", default: (/** @type {number} */ now) => now, owner: "health" },
  { key: "canarySent", kind: "boolean", default: false, owner: "health" },
  { key: "staleAnchor", kind: "number?", default: null, owner: "health" },
  { key: "consecutiveFailures", kind: "number", default: 0, limit: true, owner: "health" },
  { key: "failureStartedAt", kind: "number?", default: null, limit: true, owner: "health" },
  { key: "shapeTimes", kind: "numbers", default: () => /** @type {number[]} */ ([]), limit: true, owner: "health" },
  { key: "toolHour", kind: "number?", default: null, limit: true, owner: "limiter" },
  { key: "toolCalls", kind: "number", default: 0, limit: true, owner: "limiter" },
  { key: "testPushes", kind: "number", default: 0, limit: true, owner: "limiter" },
  { key: "callDay", kind: "string?", default: null, limit: true, owner: "limiter" },
  { key: "watchCalls", kind: "number", default: 0, limit: true, owner: "limiter", get: (o) => o.limiter.daily.watch, set: (o, value) => { o.limiter.daily.watch = /** @type {number} */ (value); } },
  { key: "muteCalls", kind: "number", default: 0, limit: true, owner: "limiter", get: (o) => o.limiter.daily.mute, set: (o, value) => { o.limiter.daily.mute = /** @type {number} */ (value); } },
  { key: "unwatchCalls", kind: "number", default: 0, limit: true, owner: "limiter", get: (o) => o.limiter.daily.unwatch, set: (o, value) => { o.limiter.daily.unwatch = /** @type {number} */ (value); } },
  { key: "prunedOn", kind: "string?", default: null, owner: "alerts" },
];

export class LifelineState {
  constructor() {
    this.saved = "";
  }

  /** @param {Owners} owners @param {number} now */
  init(owners, now) {
    for (const field of FIELDS) this.put(owners, field, initial(field, now));
    this.mark(owners);
  }

  /**
   * @param {string} raw
   * @param {Owners} owners
   * @param {(event: Record<string, string>) => void} log
   */
  restore(raw, owners, log) {
    LifelineState.guard(() => {
      const parsed = JSON.parse(raw);
      this.apply(parsed, owners);
    }, log);
    this.mark(owners);
  }

  /** @param {() => void} load @param {(event: Record<string, string>) => void} log */
  static guard(load, log) {
    try {
      load();
    } catch {
      log({ event: "state_reset" });
    }
  }

  /** @param {unknown} raw @param {Owners} owners */
  apply(raw, owners) {
    if (raw == null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("state");
    const row = /** @type {Record<string, unknown>} */ (raw);
    for (const field of FIELDS) this.put(owners, field, coerce(field.kind, row[field.key], this.read(owners, field)));
    owners.budget.slowLatched = owners.budget.rowsToday >= ROW_SLOW;
  }

  /** @param {Owners} owners */
  toJSON(owners) {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const field of FIELDS) out[field.key] = this.read(owners, field);
    return out;
  }

  /** @param {Owners} owners */
  limitSnapshot(owners) {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const field of FIELDS) {
      if (!field.limit) continue;
      out[field.key] = this.read(owners, field);
    }
    return JSON.stringify(out);
  }

  /** @param {Owners} owners */
  mark(owners) {
    this.saved = this.limitSnapshot(owners);
  }

  /** @param {Owners} owners */
  dirty(owners) {
    return this.limitSnapshot(owners) !== this.saved;
  }

  /** @param {Owners} owners @param {Field} field */
  read(owners, field) {
    if (field.get) return field.get(owners);
    return bag(owners[field.owner])[field.key];
  }

  /** @param {Owners} owners @param {Field} field @param {unknown} value */
  put(owners, field, value) {
    if (field.set) {
      field.set(owners, value);
      return;
    }
    bag(owners[field.owner])[field.key] = value;
  }
}

/** @param {Owners[keyof Owners]} owner */
function bag(owner) {
  return /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (owner));
}

/** @param {Field} field @param {number} now */
function initial(field, now) {
  const value = typeof field.default === "function" ? field.default(now) : field.default;
  return Array.isArray(value) ? [...value] : value;
}

/** @param {FieldKind} kind @param {unknown} value @param {unknown} fallback */
function coerce(kind, value, fallback) {
  switch (kind) {
    case "number":
      return typeof value === "number" ? value : fallback;
    case "number?":
      if (value === undefined) return fallback;
      return value === null || typeof value === "number" ? value : fallback;
    case "string":
      return typeof value === "string" ? value : fallback;
    case "string?":
      if (value === undefined) return fallback;
      return value === null || typeof value === "string" ? value : fallback;
    case "boolean":
      return typeof value === "boolean" ? value : fallback;
    case "numbers":
      if (!Array.isArray(value) || !value.every((item) => typeof item === "number")) return fallback;
      return value;
    default: {
      const never = kind;
      throw new Error(never);
    }
  }
}
