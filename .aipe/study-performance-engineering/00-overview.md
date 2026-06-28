# Performance engineering — overview

The whole performance surface in one frame, with the three ceilings that bound every live run.

## Zoom out — where the wall-clock goes

```
  Live investigation request — one timeline, four cost zones

  ┌─ UI (React/Next.js) ───────────────────────────────────────────────────────┐
  │  page → fetch /api/agent?step=diagnose&live=1                              │
  │  reads NDJSON via readNdjson() → renders trace lines as they arrive        │
  └───────────────────────────────────┬────────────────────────────────────────┘
                                      │  HTTP (streaming response)
  ┌─ Vercel route ─────────────────────▼───────────────────────────────────────┐
  │  app/api/agent/route.ts   maxDuration = 300s   ← CEILING #1                │
  │  bootstrap → listTools → DiagnosticAgent → (optional) RecommendationAgent  │
  │  emits AgentEvent NDJSON as work happens                                    │
  └───────────────────────────────────┬────────────────────────────────────────┘
                                      │  callTool (in-process)
  ┌─ DataSource adapter ───────────────▼───────────────────────────────────────┐
  │  BloomreachDataSource.callTool                                              │
  │  - 60s TTL response cache (per name+args)                                   │
  │  - minIntervalMs = 1100 spacing      ← CEILING #2 (the ~1 req/s floor)     │
  │  - retry on server-stated 429 window                                        │
  │  - AbortSignal: client cancel OR 30s per-call timeout                       │
  └───────────────────────────────────┬────────────────────────────────────────┘
                                      │  HTTP (MCP streamable HTTP transport)
  ┌─ Bloomreach MCP (alpha) ───────────▼───────────────────────────────────────┐
  │  loomi-mcp-alpha.bloomreach.com/mcp                                         │
  │  rate-limit: 1 per ~10s (server-stated), token-revokes after minutes        │
  └────────────────────────────────────────────────────────────────────────────┘

  in parallel, the model call:
  ┌─ Anthropic ─────────────────────────────────────────────────────────────┐
  │  claude-sonnet-4-6 (agents) / claude-haiku-4-5 (intent classifier)      │
  │  res.usage logged at agents/aptkit-adapters.ts:60                       │
  └─────────────────────────────────────────────────────────────────────────┘
```

The diagnostic agent makes ≤6 tool calls; recommendation makes ≤4; monitoring makes ≤6; query makes ≤6 (defaults set inside `@aptkit/core`). Multiply by ~1.1s of forced spacing and add per-call MCP round-trips and Anthropic latency: a real diagnose+recommend investigation lands in the ~100–115s zone. The 300s ceiling exists because Hobby's 60s can't fit a 6-call investigation behind the ~1 req/s floor.

## The three ceilings — and the third lever

```
  CEILING #1 — the Vercel route budget
    app/api/agent/route.ts:22         export const maxDuration = 300;
    app/api/briefing/route.ts:19      export const maxDuration = 300;
    300s = Vercel Pro max. Hobby's 60s would not fit one live investigation.

  CEILING #2 — the MCP spacing floor
    lib/mcp/connect.ts:97             minIntervalMs: 1100
    Proactive 1.1s spacing between calls. Bloomreach rate-limits ~1 req/s
    globally per user; spacing at the FULL 10s window would cost ~60s for a
    6-call investigation and blow the budget by itself.

  CEILING #3 — the per-agent tool-call cap
    @aptkit/core: monitoring=6, diagnostic=6, recommendation=4, query=6
    The kill-switch that bounds work the model can spend per phase.
    Hits before the route budget does, by design.

  LEVER — the synthetic data path
    lib/data-source/synthetic-data-source.ts
    SyntheticDataSource.callTool: in-process, no network, no rate limit.
    Removes ceiling #2 entirely. Real model + real loop, fake data.
    Total wall-clock collapses to Anthropic-only time.
```

## Where the budget actually goes — phase log

Both routes emit a single per-request line in their `finally` block so a Vercel filter on `phases.phase` reads across both:

```
  /api/briefing phases:
    schema_bootstrap     — 4 sequential MCP calls (≥4 × 1.1s = ≥4.4s floor)
    coverage_gate        — pure, in-process, sub-ms
    list_tools           — one MCP call
    monitoring_scan      — up to 6 tool calls × spacing + model latency

  /api/agent phases:
    schema_bootstrap     — same 4 calls (in-process schema cache hits when warm)
    list_tools           — one MCP call
    intent_classify      — Anthropic only (query flow)
    diagnostic_investigate — up to 6 tool calls × spacing + model latency
    recommendation_propose — up to 4 tool calls × spacing + model latency
```

The two routes deliberately share this shape. One Vercel filter — `phases.phase = "schema_bootstrap"` — reads bootstrap latency across both endpoints without splitting the query.

## Top findings — ranked

1. **The 300s route ceiling is real and load-bearing.** Both routes emit a phase log on every request (including the failure path) so you can see how much of the budget was burned before a timeout. The 30s per-MCP-call cap (`lib/mcp/transport.ts:38`) is the first defence against a single hung call eating the whole budget.

2. **`minIntervalMs = 1100` is not backpressure — it is rate-limit compliance.** Backpressure means a downstream-pressure signal slowing an upstream producer. This is a fixed proactive sleep that schedules calls just inside the upstream's penalty window. The distinction matters for the interview defense — calling this "backpressure" is wrong and a senior engineer will catch it. See `02-mcp-spacing-and-retry.md`.

3. **The 60s response cache holds errors safely.** `BloomreachDataSource.callTool` returns BEFORE writing the cache when `isError === true` (`lib/data-source/bloomreach-data-source.ts:179`). A transient 429 cannot poison the cache; the next call hits the live server and gets a real answer. The cache is shaped as a small bug-prevention move.

4. **The synthetic adapter is the demo escape hatch.** `live-synthetic` mode keeps the real model + real agent loop, removes the network entirely. Wall-clock collapses from ~100s to model-only time. This is the lever to reach for when the alpha MCP server is misbehaving and the demo cannot afford another reset. See `audit.md` → `caching-batching-and-backpressure`.

5. **Demo replays use a deliberate paced pause.** `REPLAY_DELAY_MS = 140` (briefing) and `180` (agent) are intentional — replays would otherwise dump the whole snapshot in one flush. The pause is a perceived-performance choice, not a measurement floor. See `04-progressive-ndjson-stream.md`.

## What is NOT yet exercised

The audit lens for **rendering-client-and-mobile-performance** finds the basics — no `React.memo`, no `useMemo`/`useCallback` in `components/` or `app/`, no bundle analysis pipeline, no LCP/INP measurement, no virtualization. The UI is small enough that none of these are load-bearing today; calling them out as a deliberate non-investment is the honest move. The audit names this directly.

There is **no profiler, no flamegraph, no real RUM**. The only baseline is the per-request phase log emitted to `console.log` and read in Vercel. Naming this as a measurement gap rather than pretending the project has observability is the staff-engineer move.

## Migration / phase notes

The legacy agent path (`lib/agents/*-legacy.ts`) carried the forced-synthesis turn — a "stop calling tools and emit JSON" final turn that bounded cost concentration when the model wouldn't stop exploring. That mechanism is preserved in the legacy files but is NOT on the active path. The active path delegates to `@aptkit/core`'s agent loops, which carry their own per-agent caps (monitoring=6, diagnostic=6, recommendation=4, query=6). When someone asks "how do you bound a runaway model?", the answer is: the per-agent cap is enforced inside aptkit; the historical synthesize-turn mechanism is in the legacy files for reference.
