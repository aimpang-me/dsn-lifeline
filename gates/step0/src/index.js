import { DurableObject } from "cloudflare:workers";
import { feedUrls, recordPoll } from "./extract.js";

/**
 * Throwaway gate worker. It polls the live feed for one hour.
 * Do not deploy or run it against NASA unless the user asks. v1 tests do not start it.
 */
export class Gate extends DurableObject {
  /** @param {DurableObjectState} ctx @param {Record<string, string>} env */
  constructor(ctx, env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS poll (id INTEGER PRIMARY KEY AUTOINCREMENT, record TEXT NOT NULL)");
      this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS raw (id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL)");
      this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
    });
  }

  async alarm() {
    try {
      await this.sample();
    } finally {
      await this.ctx.storage.setAlarm(Date.now() + 60_000);
    }
  }

  async sample() {
    const now = Date.now();
    const urls = feedUrls(now);
    const plainDone = this.ctx.storage.sql.exec("SELECT v FROM meta WHERE k = 'plain'").toArray().length > 0;
    if (!plainDone) {
      const plain = await fetch(urls.plain, { signal: AbortSignal.timeout(8000) });
      const plainBody = await plain.text();
      const plainRecord = recordPoll({ status: plain.status, body: plainBody, previousTimestamp: null, now });
      this.ctx.storage.sql.exec("INSERT INTO poll (record) VALUES (?)", JSON.stringify({ ...plainRecord, plain: true }));
      this.ctx.storage.sql.exec("INSERT INTO meta (k, v) VALUES ('plain', '1')");
    }
    const previous = this.ctx.storage.sql.exec("SELECT v FROM meta WHERE k = 'timestamp'").toArray()[0];
    const previousTimestamp = previous ? Number(previous.v) : null;
    const res = await fetch(urls.cacheBust, { signal: AbortSignal.timeout(8000) });
    const body = await res.text();
    const record = recordPoll({ status: res.status, body, previousTimestamp, now });
    this.ctx.storage.sql.exec("INSERT INTO poll (record) VALUES (?)", JSON.stringify(record));
    if (record.timestamp != null) {
      this.ctx.storage.sql.exec("INSERT INTO meta (k, v) VALUES ('timestamp', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", String(record.timestamp));
    }
    const rawCount = Number(this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM raw").toArray()[0]?.n ?? 0);
    if (res.ok && rawCount < 5) this.ctx.storage.sql.exec("INSERT INTO raw (body) VALUES (?)", body);
  }

  /** @param {Request} request */
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ ok: true, gate: "step0" });
    if ((await this.ctx.storage.getAlarm()) == null) await this.ctx.storage.setAlarm(Date.now() + 60_000);
    const rows = this.ctx.storage.sql.exec("SELECT record FROM poll ORDER BY id").toArray();
    return Response.json({ polls: rows.map((row) => JSON.parse(String(row.record))) });
  }
}

export default {
  /** @param {Request} request @param {{ GATE: DurableObjectNamespace<Gate> }} env */
  async fetch(request, env) {
    const stub = env.GATE.get(env.GATE.idFromName("step0"));
    return stub.fetch(request);
  },
};
