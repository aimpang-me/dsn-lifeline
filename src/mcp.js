import { Json } from "./json.js";

export class Mcp {
  /** @param {string} code */
  static error(code) {
    return { isError: true, content: [{ type: "text", text: code }], structuredContent: { error: code } };
  }

  /** @param {string} text @param {Record<string, unknown>} data */
  static ok(text, data) {
    return { content: [{ type: "text", text }], structuredContent: data };
  }

  /** @param {unknown} id @param {number} code @param {string} message @param {number} [status] */
  static rpcError(id, code, message, status = 200) {
    return Json.response({ jsonrpc: "2.0", id, error: { code, message } }, status);
  }

  /** @param {string} body */
  static messageId(body) {
    try {
      const parsed = JSON.parse(body);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !("id" in parsed)) return null;
      return parsed.id;
    } catch {
      return null;
    }
  }

  /** @param {string} body @param {string} code */
  static toolError(body, code) {
    return Json.response({ jsonrpc: "2.0", id: Mcp.messageId(body), result: Mcp.error(code) });
  }
}
