# Changelog

## Unreleased

A non-numeric `dataRate`, such as `NaN` on one TGO signal, is stored as null instead of discarding the whole snapshot. Frequency and power are no longer read, so they cannot fail a snapshot. A non-numeric `spacecraftID`, target id, or timestamp is still a SHAPE failure.

## 1.0.1

The Worker default export is a fetch handler object, so Cloudflare serves `/health` and `/mcp`. A class with only a static `fetch` was ignored, and every request returned the platform 404. An unknown protocol version falls back to one the server accepts. A caller without a valid key gets 401 and is not told whether the server is configured. A malformed Content-Length is rejected before the body is buffered. The `serverInfo.version` reported at initialize now matches `package.json`.

## 1.0.0

`ack_alerts` updates ids in batches of 100 so a long list fits the Durable Object parameter cap. An alert table from before the `day` column counts those rows toward today's cap.

First draft of DSN Lifeline. One Worker, one SQLite Durable Object, and MCP tools for the watchlist plus a pull alert queue. Spacecraft IDs are negative and were unverified at that point.

Favourite, stale, canary, shape, and test alerts stay relevant for 20 minutes after they are queued. The pending queue holds at most 100 alerts. An assistant routine polls `pending_alerts` and calls `ack_alerts`. The tool text is the same JSON the structured result carries, so a text-only client can ack.

A restart keeps the last good snapshot, the stale-feed clock, and the canary anchor. A dropped favourite, stale, shape, or canary alert may be queued once more while that condition still holds. Muting or unwatching a craft drops its pending favourite alerts.

Daily caps count every alert created that local day, including dropped rows. Alert rows older than 2 days are deleted once each UTC day, and that delete does not raise the same stale or canary alert again.
