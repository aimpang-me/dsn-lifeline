import { Auth } from "./auth.js";
import { Bytes } from "./bytes.js";
import { Json } from "./json.js";
import { Mcp } from "./mcp.js";
import { Lifeline } from "./lifeline.js";

export { Lifeline };

const MAX_BODY = 16 * 1024;

/**
 * Parse a Content-Length header. Returns null when absent and NaN when malformed.
 * @param {string | null} header
 * @returns {number | null}
 */
function parseLength(header) {
  if (header == null) return null;
  return /^[0-9]+$/.test(header) ? Number(header) : Number.NaN;
}

/**
 * Stop once the unread stream passes the cap, so a missing Content-Length cannot buffer the rest.
 * @param {Request} request
 * @param {number} max
 * @returns {Promise<string | null>}
 */
async function readCapped(request, max) {
  const reader = request.body?.getReader();
  if (!reader) return "";
  /** @type {Uint8Array[]} */
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    buf.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(buf);
}

export default {
  /**
   * @param {Request} request
   * @param {{ API_KEY?: string, DEFAULT_TZ?: string, LIFELINE?: { idFromName: (name: string) => unknown, get: (id: unknown) => { fetch: (input: Request | string, init?: RequestInit) => Promise<Response> } } }} env
   */
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && (url.pathname === "/health" || url.pathname === "/")) {
      return Json.response({ ok: true, spec_version: 2 });
    }
    if (url.pathname !== "/mcp") return Json.text("Not found", 404);
    if (request.method !== "POST") return Json.text("Method not allowed", 405);

    const auth = new Auth(env);
    if (!auth.keyOk || !(await Auth.keysMatch(Auth.presentedKey(request), auth.apiKey))) {
      return Mcp.rpcError(null, -32001, "Unauthorized", 401);
    }
    if (!auth.configured) return Mcp.toolError("", "NOT_CONFIGURED");
    const length = parseLength(request.headers.get("content-length"));
    if (length != null && (!Number.isSafeInteger(length) || length > MAX_BODY)) {
      return Mcp.rpcError(null, -32600, "INVALID_INPUT", 413);
    }
    const body = length == null ? await readCapped(request, MAX_BODY) : await request.text();
    if (body == null || Bytes.length(body) > MAX_BODY) return Mcp.rpcError(null, -32600, "INVALID_INPUT", 413);
    if (!env.LIFELINE) return Mcp.toolError(body, "NOT_CONFIGURED");
    const stub = env.LIFELINE.get(env.LIFELINE.idFromName("main"));
    return stub.fetch("https://lifeline/mcp", { method: "POST", headers: { "content-type": "application/json" }, body });
  },
};
