/**
 * @typedef {{ name: string, description: string, inputSchema: Record<string, unknown>, run: (args: Record<string, unknown>) => unknown }} ToolDef
 * @typedef {{ id?: unknown, method?: string, params?: { name?: string, arguments?: Record<string, unknown>, protocolVersion?: string } }} RpcNote
 */

const VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

export class McpProtocol {
  /** @type {Map<string, (protocol: McpProtocol, note: RpcNote) => unknown>} */
  static #methods = new Map(/** @type {[string, (protocol: McpProtocol, note: RpcNote) => unknown][]} */ ([
    ["initialize", (protocol, note) => protocol.#initialize(note)],
    ["ping", (_protocol, note) => ({ jsonrpc: "2.0", id: note.id ?? null, result: {} })],
    ["tools/list", (protocol, note) => ({ jsonrpc: "2.0", id: note.id ?? null, result: { tools: protocol.#list() } })],
    ["notifications/initialized", () => null],
    ["tools/call", (protocol, note) => protocol.#call(note)],
  ]));

  /**
   * @param {ToolDef[]} tools
   * @param {(tool: ToolDef, args: Record<string, unknown>) => Promise<unknown>} execute
   */
  constructor(tools, execute) {
    /** @type {Map<string, ToolDef>} */
    this.#tools = new Map(tools.map((tool) => [tool.name, tool]));
    this.#execute = execute;
  }

  /** @type {Map<string, ToolDef>} */
  #tools;
  /** @type {(tool: ToolDef, args: Record<string, unknown>) => Promise<unknown>} */
  #execute;

  /** @param {unknown} message */
  async rpc(message) {
    if (message == null || typeof message !== "object" || Array.isArray(message)) {
      return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } };
    }
    const note = /** @type {RpcNote} */ (message);
    if (typeof note.method === "string" && note.method.startsWith("notifications/") && !Object.hasOwn(note, "id")) return null;
    const handler = McpProtocol.#methods.get(String(note.method));
    if (!handler) return { jsonrpc: "2.0", id: note.id ?? null, error: { code: -32601, message: "Method not found" } };
    return handler(this, note);
  }

  #list() {
    return [...this.#tools.values()].map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
  }

  /** @param {RpcNote} note */
  #initialize(note) {
    const offered = note.params?.protocolVersion;
    const protocolVersion = typeof offered === "string" && VERSIONS.includes(offered) ? offered : VERSIONS[0];
    return {
      jsonrpc: "2.0",
      id: note.id ?? null,
      result: {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "dsn-lifeline", version: "1.0.1" },
        instructions: "Call dsn_now to see who is talking. Call pending_alerts every few minutes, tell the user, then ack_alerts.",
      },
    };
  }

  /** @param {RpcNote} note */
  async #call(note) {
    const name = String(note.params?.name ?? "");
    const args = note.params?.arguments ?? {};
    const tool = this.#tools.get(name);
    const result = tool
      ? await this.#execute(tool, args)
      : { content: [{ type: "text", text: "Unknown tool" }], isError: true };
    return { jsonrpc: "2.0", id: note.id ?? null, result };
  }
}
