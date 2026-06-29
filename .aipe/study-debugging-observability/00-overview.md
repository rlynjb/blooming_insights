# Overview — debugging & observability in blooming_insights

The verdict first: **this repo's observability story is unusually well-shaped for its size, because the live trace is a product feature, not an afterthought.** The user *sees* the agent's reasoning, the EQL queries it ran, and the tool results — so the evidence to debug a wrong answer is the same evidence the UI renders. That single design choice does most of the work. Three smaller mechanisms ride on top: a structured per-request phase log, token redaction at the error edge, and committed JSON snapshots that replay the live wire format. Together they cover the "explain unknown behavior with evidence" question end-to-end inside the repo. They do *not* cover cross-service correlation, metrics, alerting, or production tracing — none of those exist yet, and several wouldn't earn their keep until the system grows past a single Vercel deployment.

## The three observability surfaces

```
  Surfaces, by who emits and who reads

  ┌─ surface ─────────────┬─ emitter ────────────────┬─ reader ─────────────────────┐
  │ 1. live trace         │ /api/briefing,           │ the UI (StatusLog +          │
  │    (NDJSON over fetch)│ /api/agent — every       │ ReasoningTrace) — also       │
  │                       │ phase, every tool call,  │ the dev who opens the        │
  │                       │ every agent step         │ network panel               │
  ├───────────────────────┼──────────────────────────┼──────────────────────────────┤
  │ 2. vitest output      │ test/**.test.ts          │ the dev running `npm test`  │
  │    (test runner)      │ (221 tests, 24 files)    │ — also CI when it lands     │
  ├───────────────────────┼──────────────────────────┼──────────────────────────────┤
  │ 3. dev cache files    │ saveInvestigation,       │ the dev who opens the file  │
  │    (gitignored JSON)  │ auth-cache.json,         │ — survives hot reload, so   │
  │                       │ committed demo-*.json    │ state is inspectable at rest│
  └───────────────────────┴──────────────────────────┴──────────────────────────────┘
```

The live trace is the load-bearing surface — it's what the user pays attention to *and* what the developer reaches for first when something is wrong. Tests are the second-strongest signal (they prove a change didn't break anything, but only against scenarios someone wrote down). Dev cache files are a fallback for state-at-rest inspection.

What is not here, and would matter if it were: metrics (a counter on `tool_call_end.error`), alerting (a page when `monitoring_scan.durationMs` crosses a budget), distributed tracing (a `traceparent` header propagating across the Bloomreach hop), production log aggregation beyond Vercel's built-in retention. Those become relevant only as the system grows past a single Vercel deployment talking to a single Bloomreach project.

## Ranked findings — by consequence

1. **The discriminated union (`AgentEvent`) is the wire contract for both the UI render and the debugging signal at once.** `lib/mcp/events.ts:4-12`. Eight variants: `reasoning_step | tool_call_start | tool_call_end | insight | diagnosis | recommendation | done | error`. Strip this and the UI breaks, the dev's network-panel debugging breaks, the demo-replay reproduction breaks, the test-replay sister hook (`test/api/_helpers.ts`) breaks. One contract, four consumers. → see `01-ndjson-reasoning-trace.md`.

2. **The per-request phase log fires in `finally`, so the budget record survives the failure.** `app/api/briefing/route.ts:317-324`, `app/api/agent/route.ts:331-338`. One `console.log(JSON.stringify(…))` line per request, shared shape across both routes (`route`, `sessionId`, `mode`, `totalMs`, `phases[]`, `aborted`). When the 300s Vercel ceiling fires mid-`monitoring_scan`, the log still records how much budget each completed phase burned. → see `02-per-request-phase-log.md`.

3. **Token redaction happens BEFORE the log line, not after.** `lib/mcp/transport.ts:66-76`, called from every `console.error` site in the routes. Bearer headers and OAuth body tokens are stripped at the moment the error is formatted, not at log ingestion. This is the right place — Vercel's log retention can never hold a token that was never written to the log. → see `03-redaction-at-the-error-edge.md`.

4. **The capturing fetch records each non-OK MCP response body so the thrown error carries the REAL server detail.** `lib/mcp/transport.ts:103-118` + `SdkTransport.callTool` at `lib/mcp/transport.ts:129-146`. Without this, the SDK surfaces "Unauthorized" with no body and a debugger can't tell `invalid_token` from `expired_token` from `rate_limited`. → see `04-server-error-body-capture.md`.

5. **The demo snapshot replays as NDJSON over the SAME wire contract.** `app/api/briefing/route.ts:86-152`, `app/api/agent/route.ts:125-142`. The committed `lib/state/demo-*.json` files are not just static JSON — they're replayed event-by-event through the same `AgentEvent` encoder the live run uses, with a `REPLAY_DELAY_MS` pause so the UI reveals progressively. The same stream that observes a live run reproduces a recorded one. → see `05-replay-snapshot-as-fixture.md`.

## What's missing — honest

- **No metrics.** No counter on errors per minute, no histogram on `tool_call_end.durationMs`, no gauge on cache hit rate. The phase log captures latency *per request*, but nothing aggregates across requests.
- **No alerting.** The 300s ceiling has no SLO around it. The `aborted: true` field in the phase log is the only signal that a client cancellation or a budget timeout happened, and nothing watches for it.
- **No cross-service correlation.** A request has a `sessionId` (the cookie) but no per-request `requestId`. The Bloomreach hop is opaque — no `traceparent`, no trace continuation. When a Bloomreach error happens, the only correlation is timestamp + sessionId in two log streams.
- **No production log aggregation.** The repo writes to `console.log` / `console.error`, and Vercel retains the lines. There is no Datadog, no Sentry, no OpenTelemetry collector. Search is grep-by-substring inside Vercel's UI.
- **No runbook.** When OAuth tokens revoke (the alpha-server scar tissue: tokens die after minutes), the UI auto-reconnects (`app/page.tsx` reconnect button) but there is no document for "what to do when monitoring_scan times out" or "what to do when capture-demo fails." The reconnect button is the only operational lever.

These are real gaps, not gaps the repo should pretend to have filled. Several would not earn their keep at the current scale (one Vercel deployment, one Bloomreach project, no users beyond the demo). Tracing would matter if a second backend were added; metrics would matter if budgets started being missed regularly; alerting would matter if anyone other than the developer cared when a request fails.

## Reading order from here

→ `audit.md` — the 8-lens walk against this repo's evidence
→ Pattern files in order, `01` through `05` — each names a mechanism and walks why it earns its place
