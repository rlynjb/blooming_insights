# Audit — debugging & observability (blooming_insights)

The 8-lens walk against current evidence. Each `##` section is one lens; cross-links into the pattern files point to the deep walks.

## observability-map

The evidence map: what can be observed at each important boundary.

```
  blooming_insights observability map

  ┌─ UI layer ────────────────────────────────────────────────┐
  │  StatusLog (sticky sidebar) → ReasoningTrace               │
  │  shows: every reasoning_step, every tool_call_start/end    │
  │  reads: NDJSON over fetch (live), or replayed (demo)       │
  └────────────────────────┬───────────────────────────────────┘
                           │  AgentEvent (the wire contract)
  ┌─ Service layer ────────▼───────────────────────────────────┐
  │  /api/briefing, /api/agent — emit AgentEvent[] + a single  │
  │  console.log({route, sessionId, phases[], totalMs, aborted})│
  │  per request, in `finally` so it survives a thrown phase   │
  └────────────────────────┬───────────────────────────────────┘
                           │  callTool / listTools (with signal)
  ┌─ Storage layer ────────▼───────────────────────────────────┐
  │  BloomreachDataSource — emits durationMs + fromCache per    │
  │  call; throws McpToolError tagged with toolName + detail   │
  └────────────────────────┬───────────────────────────────────┘
                           │  HTTP (StreamableHTTPClientTransport)
  ┌─ Provider boundary ────▼───────────────────────────────────┐
  │  Bloomreach loomi connect MCP server — opaque to us; the   │
  │  capturing fetch records non-OK response bodies so the      │
  │  error reaching console.error carries the REAL server text │
  └────────────────────────────────────────────────────────────┘
```

What's observable per boundary:

- **UI → Service.** Browser DevTools network panel sees the NDJSON stream byte-for-byte (`Content-Type: application/x-ndjson`); each `AgentEvent` JSON line is readable as it arrives. `lib/streaming/ndjson.ts` is the kernel.
- **Service → DataSource.** Per-phase wall-clock at `app/api/briefing/route.ts:215-218` and `app/api/agent/route.ts:215-219` (the closure `recordPhase`). One JSON log line per request in `finally`. Cancellation reason is recorded as `aborted: req.signal.aborted`.
- **DataSource → Bloomreach.** `BloomreachDataSource.callTool` returns `{ result, durationMs, fromCache }` (`lib/data-source/bloomreach-data-source.ts:36`). The rate-limit retry ladder logs no telemetry of its own — a retry is silent on the wire and only visible through the elongated `durationMs`.
- **Bloomreach error path.** `makeCapturingFetch` (`lib/mcp/transport.ts:103-118`) records the body of each non-OK response into `HttpErrorHolder`; `SdkTransport.callTool` (`lib/mcp/transport.ts:129-146`) attaches the captured body to the thrown error. → see `04-server-error-body-capture.md`.
- **Test runner.** Vitest writes to stdout/stderr; integration tests at `test/api/briefing.integration.test.ts:91` and `test/api/agent.integration.test.ts` actually exercise the error-event path with the same `console.error` and phase-log lines that production emits.

Verdict: the map is dense at UI → Service → DataSource → Bloomreach. It is empty above the UI layer (no browser-side error reporting, no client-side performance telemetry) and empty across multiple requests (no aggregation, no metrics).

## reproduction-and-evidence

Minimal reproduction, hypotheses, controlled experiments, and evidence collection.

The reproduction story here is unusually good for one reason: **the live wire format is the recording format.** A demo capture (`app/api/mcp/capture-demo/route.ts`) records a full briefing + each per-insight investigation as `AgentEvent[]` and writes it to `lib/state/demo-investigations.json` + `lib/state/demo-insights.json`. The demo replay route reads those files back and re-emits them as NDJSON, byte-compatible with the live stream. → see `05-replay-snapshot-as-fixture.md`.

Practical consequences:

- **Reproducing a UI rendering bug** doesn't require live credentials. Run with `?demo=cached` and the same trace plays back deterministically. The `REPLAY_DELAY_MS` constants (`app/api/briefing/route.ts:25`, `app/api/agent/route.ts:103`) preserve the *pacing* so timing-dependent UI bugs (progressive reveal, scroll-into-view) reproduce.
- **Reproducing an agent-loop bug** is harder. The captured snapshot records only what the agent emitted, not what it *thought*. Re-running needs live Bloomreach + Anthropic credentials, which are non-deterministic (the model output varies turn to turn).
- **Reproducing a Bloomreach error** uses the integration tests: `test/api/_helpers.ts` and `test/api/briefing.integration.test.ts:91-93` set up a fake Anthropic that throws (e.g. "Anthropic API: 529 overloaded") and verifies the route emits an `error` event AND prints the phase-log line. This is the regression guard for the error path.

What's missing: there is no "Bloomreach response fixtures" library — when a new MCP error shape shows up in the wild, capturing it as a test fixture requires hand-copying the (already-redacted) error body out of Vercel logs into a test.

## structured-logs-and-correlation

Events, levels, context, correlation IDs, redaction, and searchable fields.

Structured logging is partial. Two shapes:

- **Per-request summary** (the strongest signal). `console.log(JSON.stringify({ route, sessionId, mode, totalMs, phases, aborted }))` at `app/api/briefing/route.ts:317-324` and `app/api/agent/route.ts:331-338`. Shared shape across both routes, so a single Vercel log filter (e.g. `phases.phase = "schema_bootstrap"`) reads across them. → see `02-per-request-phase-log.md`.
- **Per-Anthropic-call usage** (narrower signal). `console.log(JSON.stringify({ site, sessionId, usage }))` from `AnthropicModelProviderAdapter.complete` at `lib/agents/aptkit-adapters.ts:57-61`, with `site` resolved per agent (e.g. `agents/monitoring:aptkit-model`, `agents/intent:classifyIntent`). Tracks token usage per agent per session.

Error logs use a *prefix-tag* convention rather than structured JSON: `[briefing]`, `[agent]`, `[mcp-call]`, etc. These ride alongside the structured `console.log`. The trade-off is honest: humans grep by tag; machines parse the JSON line.

Correlation ID: **`sessionId` (the `bi_session` cookie) is the only correlation key.** `lib/mcp/session.ts:18-25` creates one if absent. It joins all the per-request log lines for one user across both routes. There is no per-request `requestId` — when a user generates two briefings in 30 seconds, their phase logs are correlated by `sessionId` and disambiguated by `totalMs` + position in the log stream.

Redaction: token-shaped substrings are stripped *before* the log write. `TOKEN_PATTERNS` at `lib/mcp/transport.ts:55-61` covers `Bearer`, `access_token`, `refresh_token`, `id_token`, `code_verifier`. `formatError` (`lib/mcp/transport.ts:82-97`) walks the `err.cause` chain so nested cause tokens are also redacted. → see `03-redaction-at-the-error-edge.md`.

Verdict: structured-and-correlated for the per-request summary; ad-hoc for everything else. The single `sessionId` correlation key is sufficient at current scale; it stops being sufficient the moment cross-service tracing is added.

## metrics-slis-slos-and-alerts

Signals, service-level indicators, objectives, alerts, and actionable thresholds.

`not yet exercised`.

There are no metrics emitters, no SLIs, no SLOs, no alerts. The per-phase timings in the phase log carry the raw data that *would* feed an SLI (e.g. "p95 `monitoring_scan` < 60s") but no aggregator reads them. The 300s Vercel ceiling is a hard ceiling, not an SLO with headroom.

When this becomes relevant: the moment more than one developer cares whether a request succeeded, or the moment a user other than the developer relies on a briefing landing in <2 minutes. At single-user demo scale, the absence is correct.

The pre-existing hooks for adding metrics: every `recordPhase()` call site is a natural histogram emission point. Wiring them to OpenTelemetry would replace `console.log` with `tracer.startActiveSpan` and add no new instrumentation surface.

## traces-and-request-lifecycles

Request lifecycles, spans, causal chains, and latency attribution.

The per-request phase log *is* the request lifecycle trace, flattened into a single line. `app/api/briefing/route.ts:317-324`:

```
  { route: '/api/briefing',
    sessionId: 'abc-...',
    mode: 'live-bloomreach',
    totalMs: 87432,
    phases: [
      { phase: 'schema_bootstrap',   durationMs: 4210 },
      { phase: 'coverage_gate',      durationMs: 12 },
      { phase: 'list_tools',         durationMs: 380 },
      { phase: 'monitoring_scan',    durationMs: 82800 },
    ],
    aborted: false }
```

The shape is shared with `/api/agent` (`phases: ['schema_bootstrap', 'list_tools', 'intent_classify' | 'diagnostic_investigate' | 'recommendation_propose', …]`), so a single filter reads both routes.

What this gives you: latency attribution per phase within a request. What it does not give you: a span tree (each phase is flat, no parent-child), trace continuation across the Bloomreach hop (no `traceparent` propagated), or per-tool-call timing (Bloomreach `callTool` durations are inside `monitoring_scan` but not broken out — they live in the live trace as `tool_call_end.durationMs`, not in the phase log).

The `AgentEvent` stream *does* carry per-tool-call timing in `tool_call_end.durationMs` — that's where the per-call latency lives. It's just not aggregated into the phase log. → see `01-ndjson-reasoning-trace.md`.

Verdict: request-lifecycle attribution works inside a single Vercel function. Trace continuation across services does not exist; it would require adding `traceparent` to the MCP transport's outbound HTTP headers and surfacing it in the phase log.

## state-snapshots-and-debugging-boundaries

State inspection, network traces, error output, and before/after snapshots.

Three places state can be inspected at rest:

1. **Dev cache files** (gitignored). `.investigation-cache.json` at the repo root (written by `saveInvestigation` in `lib/state/investigations.ts:30-41`, dev only — `PERSIST = process.env.NODE_ENV === 'development'`). `.auth-cache.json` at the repo root (written by the dev auth backend at `lib/mcp/auth.ts:34-36`). Both survive Next's hot reload, so an OAuth flow or a captured investigation is inspectable mid-development. **In production they don't exist** — Vercel's filesystem is read-only and state lives in encrypted cookies + in-memory maps.

2. **Committed demo snapshots.** `lib/state/demo-insights.json` + `lib/state/demo-investigations.json`. These are the captured "good state" that the demo path replays. Versioned in git; a regression in rendering shows up as a diff against a committed snapshot. → see `05-replay-snapshot-as-fixture.md`.

3. **Network-tab snapshots.** Because the live trace is NDJSON over `fetch`, the browser's network panel shows every `AgentEvent` byte-for-byte. Save-as-HAR captures the full stream. This is the "before/after" surface for UI rendering bugs.

Error output: `console.error` calls everywhere are prefixed by route tag (`[briefing] error: …`) with the full redacted stack chain via `formatError`. The chain-walking matters — a Bloomreach error wrapped in an SDK error wrapped in `McpToolError` would otherwise lose the root cause to `String(e)`. → see `03-redaction-at-the-error-edge.md`.

Before/after snapshots are not formalized for tests — vitest's default assertion error is the diff. Snapshot tests would be a natural addition for the AgentEvent[] arrays that demo replays produce, but they're not in place today.

## incident-analysis-and-prevention

Root cause, contributing conditions, remediation, regression guards, and runbooks.

The repo has a small portfolio of named incidents that left scar tissue in code comments:

- **The 300s Vercel ceiling incident.** A live investigation runs ~100-115s under the ~1 req/s MCP limit; 60s (Hobby) cannot fit it. Documented at `app/api/agent/route.ts:20-22` and `app/api/briefing/route.ts:17-19`. Prevention: hard-coded `export const maxDuration = 300` so the route doesn't silently truncate. The phase log is the diagnostic — when `totalMs` approaches 300_000 and `aborted: true`, the budget was the failure mode.

- **The cross-tenant feed wipe.** A single warm Vercel instance serves many users concurrently, so module-level Maps would bleed between sessions — and `putInsights`' clear() would wipe another user's feed mid-briefing. Documented at `lib/state/insights.ts:8-12`. Remediation: each session gets its own sub-feed map keyed by sessionId; the outer map is never cleared by a request. Regression guard: `test/state/insights.test.ts`.

- **The Bloomreach token revocation incident.** The alpha MCP server revokes tokens after minutes; without recovery, every refresh requires re-auth. Remediation: auto-reconnect on `invalid_token` (the feed in `app/page.tsx` catches the 401, resets auth, reloads once with a guard). The capturing fetch in `lib/mcp/transport.ts` is the upstream half — without it, the SDK's generic "Unauthorized" wouldn't surface `invalid_token` to the client recovery path. → see `04-server-error-body-capture.md`.

- **The rate-limit penalty window.** Bloomreach's observed window is ~10s ("1 per 10 second"); a sub-second retry just burned the attempt inside the same window. Remediation: parse the server-stated window from the error text, fall back to backoff, cap at `retryCeilingMs: 20_000`. Documented at `lib/data-source/bloomreach-data-source.ts:131-136`. Regression guard: `test/mcp/client.test.ts`.

- **The StrictMode mid-stream cancel.** React StrictMode in dev mounts → cleans up → re-mounts; cancelling the in-flight fetch on the first cleanup, with the started-guard blocking the re-mount, aborted the stream and left the logs empty. Remediation: the `useInvestigation` hook deliberately does NOT cancel on cleanup. Documented at `lib/hooks/useInvestigation.ts:32-37`.

Runbook: **none formalized.** The closest thing is the comments in the route files explaining the budget and the recovery semantics. A new developer reading them gets the *what* and the *why* but no operational playbook for "monitoring_scan exceeded budget — what to do next." At single-developer scale this is correct; the moment a second developer joins, the runbook is the next gap to close.

Prevention discipline: regression tests cover the named incidents. `test/state/insights.test.ts` guards the cross-tenant wipe. `test/mcp/client.test.ts` guards the rate-limit retry. `test/mcp/transport.test.ts` guards the redaction + body capture. `test/api/briefing.integration.test.ts:91` guards the error-event path under a thrown Anthropic call. Each incident has a test; the prevention loop is closed.

## debugging-observability-red-flags-audit

Ranked by consequence; each verdict carries its evidence.

1. **No per-request correlation ID beyond `sessionId`.** `lib/mcp/session.ts:18-25`. When one user generates two briefings inside 30 seconds, their phase logs are correlated by `sessionId` and disambiguated by position + `totalMs`. Adding a `requestId = crypto.randomUUID()` at the top of each route handler and threading it into every `console.log` is a 10-line change with high diagnostic payoff once log volume grows.

2. **Rate-limit retries are silent on the wire.** `lib/data-source/bloomreach-data-source.ts:163-174`. When `BloomreachDataSource.callTool` waits 10-20s for a rate-limit window to clear, the only surface is the elongated `durationMs` returned to the caller. No `tool_call_end.event` distinguishes "took 12s because of a retry" from "took 12s because the EQL was complex." The UI shows a single tool call running for 12s with no hint that 10s of it was a retry wait.

3. **No metrics or alerting.** Already named under the metrics lens. At current scale the absence is correct; the risk is that the *moment* a real user starts depending on the system, there is no signal to catch a regression. The 60s → 300s `maxDuration` decision was reversible because the developer is also the only user; the next budget surprise won't be.

4. **The Bloomreach error body is captured but never schematized.** `lib/mcp/transport.ts:103-118`. The error text reaches `console.error` as a free-form string. A growing taxonomy of Bloomreach errors (`invalid_token`, `expired_token`, `rate_limit_exceeded`, `eql_parse_error`, …) would benefit from a typed error shape so the UI can render distinct recovery affordances. Today only `invalid_token` triggers a specific UI path (the reconnect button) — every other Bloomreach error renders as generic.

5. **`console.log` is the only structured log sink.** Vercel retains the lines, and grep-by-substring inside Vercel's UI is the only query interface. This is fine while there's one route and one user; it stops being fine the moment a developer wants to ask "what's my p95 `monitoring_scan` over the last 7 days." That question cannot be answered with the current setup.

6. **No fixture library for Bloomreach error responses.** Integration tests exist (`test/api/_helpers.ts`), but new Bloomreach error shapes are not captured as test fixtures when they're encountered in the wild. The path of least resistance when an error surfaces is to redact a Vercel log line and hand-paste it into a new test — there is no `test/fixtures/bloomreach-errors/` directory feeding parameterised tests.

7. **`StatusLog`'s scroll position is not preserved across reasoning_step floods.** `components/shared/StatusLog.tsx:36-46`. The trace is `overflowY: 'auto'` with `maxHeight: 'calc(100vh - 96px)'`. As events stream in, the user's manual scroll-up is fighting the natural append. This is a debugging-quality issue: when a developer is mid-investigation reading a `tool_call_end` payload, the next event can shift it. Auto-scroll-pinned-to-bottom *or* a scroll-position lock would help.

8. **No `not yet exercised` formal documentation of the gaps.** This audit is the closest thing. There is no `OBSERVABILITY.md` in the repo root that says "we deliberately do not run metrics; here's when that flips." A new contributor inherits the gaps without inheriting the reasoning.
