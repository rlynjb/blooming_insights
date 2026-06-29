# Study — debugging & observability (blooming_insights)

This folder is the per-repo debugging & observability guide. It answers a single question: **when behavior is wrong, what evidence exists to explain it quickly and prevent recurrence?**

Three observability surfaces exist in this repo today:

1. **The live trace** — the discriminated union (`AgentEvent`) streamed as NDJSON over `/api/briefing` and `/api/agent`, rendered into `StatusLog` in the UI. This is the first-class observability surface — the product literally is "an analyst that shows its work."
2. **The vitest output** — 221 unit + integration tests; the test runner's own output is what proves a behavior change.
3. **The dev cache files** — `.investigation-cache.json` + `.auth-cache.json` (gitignored, dev only); committed `lib/state/demo-*.json` snapshots. These persist state across the dev server's hot reloads so an OAuth flow or a captured investigation can be inspected at rest.

The eval/results paper trail described in older versions of this guide was retired along with the Olist data adapter — it is not part of the repo today.

## Reading order

Open in this order — each file leans on the orientation the previous one set.

1. **`00-overview.md`** — one-page map. The three surfaces, who emits to each, who reads it, what each is good at, what's missing. Read first; skim only this if you have five minutes.
2. **`audit.md`** — the 8-lens audit. One section per debugging-and-observability lens, each with `file:line` evidence or an honest `not yet exercised`.
3. **Pattern files (`01-` through `05-`)** — the patterns this repo actually exercises. Each named after the pattern, not the lens. Each uses the standard concept-file shape (zoom out → structure pass → how it works → primary diagram → elaborate → interview defense → see also).

## Pattern files

| # | File | What it teaches |
|---|------|-----------------|
| 01 | `01-ndjson-reasoning-trace.md` | The first-class observability surface — the discriminated union (`AgentEvent`) streamed over NDJSON and rendered as the live trace in `StatusLog`. The product *is* the observability surface. |
| 02 | `02-per-request-phase-log.md` | One structured JSON log line per request from `/api/briefing` and `/api/agent`, emitted in `finally` so it survives the route's 300s ceiling and any thrown phase — the budget-accounting record. |
| 03 | `03-redaction-at-the-error-edge.md` | `redactSecrets` + `formatError` walking the `err.cause` chain before anything reaches `console.error` — the redaction sits *before* the log line, not after, so Vercel's log retention can never hold a Bearer token. |
| 04 | `04-server-error-body-capture.md` | The capturing fetch (`makeCapturingFetch` + `HttpErrorHolder`) records each non-OK MCP response body so the thrown error carries the REAL Bloomreach detail instead of the SDK's generic "Unauthorized". |
| 05 | `05-replay-snapshot-as-fixture.md` | Committed `demo-insights.json` + `demo-investigations.json` snapshots replayed as NDJSON over the same `AgentEvent` contract — the same stream that observes a live run also reproduces a recorded one. |

## Cross-links to neighboring guides

The partition between debugging-and-observability and its neighbors is sharp.

- **`study-testing`** — owns the *prevention* side: 221 tests catch known regressions before merge. The redaction logic, the NDJSON kernel, the per-request log shape, the demo replay path each have dedicated tests (`test/mcp/transport.test.ts`, `test/streaming/ndjson.test.ts`, `test/api/briefing.integration.test.ts`, `test/api/agent.integration.test.ts`). This folder owns *explanation* — what evidence exists to diagnose an unknown failure.
- **`study-performance-engineering`** — owns the *measurement* side: the per-phase timings written by the phase log feed any latency-budget analysis (`schema_bootstrap` vs `monitoring_scan` vs `recommendation_propose` against the 300s ceiling). This folder owns the wiring of *that* signal into a single line per request; the budget work itself lives there.
- **`study-distributed-systems`** — owns the *coordination* side: the rate-limit retry ladder, the OAuth token-revocation recovery, the per-call 30s `AbortSignal.timeout`. This folder explains how those failures *surface* (the `tool_call_end` event carrying `error`, the typed `McpToolError` thrown from the adapter); the coordination logic itself lives there.

## On UPDATE

- Add a pattern file when a new debugging mechanism shows up (e.g. a structured request-id correlation across services, a metrics emitter, a tracer that crosses service boundaries).
- Update an existing pattern file when the implementation changes (e.g. the redaction grows a new token pattern, the phase log adds a field, the `AgentEvent` union grows a variant).
- Remove a pattern file only when the mechanism is genuinely gone from the codebase — not when it's refactored. The `eval/results/` paper trail removal is the precedent: gone with Olist, so no file.
- Regenerate `audit.md` against current evidence on every run.
