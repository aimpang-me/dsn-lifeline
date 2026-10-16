import { Bytes } from "./bytes.js";

const MAX_BYTES = 256 * 1024;

/**
 * @typedef {{ type: string, active: boolean, dataRate: number | null, spacecraftID: number | null, activity: string }} Signal
 * @typedef {{ id: number | null, name: string }} Target
 * @typedef {{ name: string, station: string | null, activity: string, targets: Target[], signals: Signal[] }} Dish
 * @typedef {{ timestamp: number, stationCount: number, dishCount: number, dishes: Dish[], signals: Signal[], targets: Target[] }} Snapshot
 * @typedef {{ name: string, attrs: Record<string, string> }} Tag
 */

export class DsnScanner {
  /** @param {string} text */
  constructor(text) {
    this.text = text;
    this.i = 0;
    this.shape = false;
    this.stationCount = 0;
    this.dishCount = 0;
    this.timestamp = /** @type {number | null} */ (null);
    this.sawTimestamp = false;
    this.timestampCloseExhausted = false;
    this.currentStation = /** @type {string | null} */ (null);
    this.currentDish = /** @type {Dish | null} */ (null);
    this.dishes = /** @type {Dish[]} */ ([]);
    this.signals = /** @type {Signal[]} */ ([]);
    this.targets = /** @type {Target[]} */ ([]);
  }

  scan() {
    const text = this.text;
    while (this.i < text.length) {
      if (text[this.i] !== "<") {
        this.i += 1;
        continue;
      }
      if (text.startsWith("<!--", this.i)) {
        const end = text.indexOf("-->", this.i + 4);
        this.i = end === -1 ? text.length : end + 3;
        continue;
      }
      if (text.startsWith("<?", this.i)) {
        const end = text.indexOf("?>", this.i + 2);
        this.i = end === -1 ? text.length : end + 2;
        continue;
      }
      const closing = text[this.i + 1] === "/";
      let j = closing ? this.i + 2 : this.i + 1;
      const nameStart = j;
      while (j < text.length && /[A-Za-z0-9_:-]/.test(text[j])) j += 1;
      const name = text.slice(nameStart, j);
      const gt = text.indexOf(">", j);
      if (gt === -1) break;
      const attrs = DsnScanner.parseAttrs(text.slice(j, gt).replace(/\/\s*$/, ""));
      this.i = gt + 1;
      if (closing) {
        this.onClose(name);
        continue;
      }
      this.dispatch({ name, attrs });
    }
  }

  /** @param {Tag} tag */
  dispatch(tag) {
    switch (tag.name) {
      case "timestamp":
        this.onTimestamp();
        break;
      case "station":
        this.onStation(tag);
        break;
      case "dish":
        this.onDish(tag);
        break;
      case "target":
        this.onTarget(tag);
        break;
      case "downSignal":
      case "upSignal":
      case "signal":
        this.onSignal(tag);
        break;
      default:
        break;
    }
  }

  /** @param {string} name */
  onClose(name) {
    if (name === "dish") this.currentDish = null;
    if (name === "station") this.currentStation = null;
  }

  onTimestamp() {
    this.sawTimestamp = true;
    if (this.timestampCloseExhausted) {
      this.shape = true;
      return;
    }
    const end = this.text.indexOf("</timestamp>", this.i);
    if (end === -1) {
      this.timestampCloseExhausted = true;
      this.shape = true;
      return;
    }
    const num = DsnScanner.parseNum(this.text.slice(this.i, end).trim());
    if (!num.ok || num.value == null) this.shape = true;
    else this.timestamp = num.value;
  }

  /** @param {Tag} tag */
  onStation(tag) {
    this.stationCount += 1;
    this.currentStation = tag.attrs.friendlyName || tag.attrs.name || null;
  }

  /** @param {Tag} tag */
  onDish(tag) {
    this.dishCount += 1;
    this.currentDish = {
      name: tag.attrs.name || "",
      station: this.currentStation,
      activity: tag.attrs.activity || "",
      targets: [],
      signals: [],
    };
    this.dishes.push(this.currentDish);
  }

  /** @param {Tag} tag */
  onTarget(tag) {
    if (!this.currentDish) return;
    const id = DsnScanner.parseNum(tag.attrs.id ?? "");
    if (!id.ok) this.shape = true;
    const target = { id: id.value, name: tag.attrs.name || "" };
    this.currentDish.targets.push(target);
    this.targets.push(target);
  }

  /** @param {Tag} tag */
  onSignal(tag) {
    if (!this.currentDish) return;
    const rate = DsnScanner.parseNum(tag.attrs.dataRate ?? "");
    const id = DsnScanner.parseNum(tag.attrs.spacecraftID ?? tag.attrs.spacecraftId ?? "");
    // parseNum yields null for a malformed dataRate. Only an unreadable spacecraftID breaks the snapshot.
    if (!id.ok) this.shape = true;
    const active = tag.attrs.active != null
      ? tag.attrs.active === "true"
      : tag.attrs.signalType === "data" || tag.attrs.signalType === "carrier";
    const type = tag.name === "upSignal" || tag.attrs.type === "uplink" ? "uplink" : "downlink";
    const signal = {
      type,
      active,
      dataRate: rate.value,
      spacecraftID: id.value,
      activity: tag.attrs.signalTypeDebug || tag.attrs.activity || this.currentDish.activity || "",
    };
    this.currentDish.signals.push(signal);
    this.signals.push(signal);
  }

  snapshot() {
    if (this.shape || !this.sawTimestamp || this.timestamp == null) return null;
    return {
      timestamp: this.timestamp,
      stationCount: this.stationCount,
      dishCount: this.dishCount,
      dishes: this.dishes,
      signals: this.signals,
      targets: this.targets,
    };
  }

  /** @param {string | null | undefined} raw */
  static parseNum(raw) {
    if (raw == null || raw === "") return { ok: true, value: /** @type {number | null} */ (null) };
    if (!/^-?\d+(\.\d+)?$/.test(raw)) return { ok: false, value: null };
    const value = Number(raw);
    if (!Number.isFinite(value)) return { ok: false, value: null };
    if (value === -1) return { ok: true, value: null };
    return { ok: true, value };
  }

  /** @param {string} source */
  static parseAttrs(source) {
    /** @type {Record<string, string>} */
    const attrs = {};
    let i = 0;
    while (i < source.length) {
      while (i < source.length && /\s/.test(source[i])) i += 1;
      if (i >= source.length || source[i] === "/") break;
      let name = "";
      while (i < source.length && source[i] !== "=" && !/\s/.test(source[i])) {
        name += source[i];
        i += 1;
      }
      while (i < source.length && /\s/.test(source[i])) i += 1;
      if (source[i] !== "=") break;
      i += 1;
      while (i < source.length && /\s/.test(source[i])) i += 1;
      const quote = source[i];
      if (quote !== '"' && quote !== "'") break;
      i += 1;
      let value = "";
      while (i < source.length && source[i] !== quote) {
        value += source[i];
        i += 1;
      }
      i += 1;
      if (name) attrs[name] = value;
    }
    return attrs;
  }

  /**
   * Hand-rolled DSN XML scanner. Feed text stays on the snapshot and is not copied out.
   * @param {string} input
   * @returns {{ ok: true, snapshot: Snapshot } | { ok: false, reason: string }}
   */
  static parse(input) {
    const text = typeof input === "string" ? input : "";
    if (Bytes.length(text) > MAX_BYTES) return { ok: false, reason: "TOO_LARGE" };
    const scanner = new DsnScanner(text);
    scanner.scan();
    const snapshot = scanner.snapshot();
    if (!snapshot) return { ok: false, reason: "SHAPE" };
    return { ok: true, snapshot };
  }
}
