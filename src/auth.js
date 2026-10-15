import { timingSafeEqual } from "node:crypto";

const MIN_KEY = 20;

export class Auth {
  /** @param {{ API_KEY?: string, DEFAULT_TZ?: string }} env */
  constructor(env) {
    this.apiKey = typeof env.API_KEY === "string" ? env.API_KEY : "";
    this.keyOk = this.apiKey.length >= MIN_KEY;
    this.timeZone = env.DEFAULT_TZ || "America/Toronto";
    this.zoneOk = Auth.isZone(this.timeZone);
  }

  get configured() {
    return this.keyOk && this.zoneOk;
  }

  /** @param {string} timeZone */
  static isZone(timeZone) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone });
      return true;
    } catch {
      return false;
    }
  }

  /** @param {string} given @param {string} expected */
  static async keysMatch(given, expected) {
    const enc = new TextEncoder();
    const [left, right] = await Promise.all([
      crypto.subtle.digest("SHA-256", enc.encode(given)),
      crypto.subtle.digest("SHA-256", enc.encode(expected)),
    ]);
    return timingSafeEqual(Buffer.from(left), Buffer.from(right));
  }

  /** @param {Request} request */
  static presentedKey(request) {
    const header = request.headers.get("X-API-Key");
    if (header) return header;
    const auth = request.headers.get("Authorization") ?? "";
    return auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
  }
}
