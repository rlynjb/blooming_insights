# Performance audit — 8 lenses

Pass 1 of the two-pass discipline. Every lens walked against the current code. Where a lens earns a dedicated walkthrough, it cross-links to the pattern file in Pass 2.

## performance-budget

The repo has **three explicit budgets** and they are all named in code with the reasoning attached.

- **Route budget — 300s.** `app/api/agent/route.ts:22` and `app/api/briefing/route.ts:19` both set `export const maxDuration = 300`. The comment explains why: Hobby's 60s cannot fit a 6-call investigation behind the ~1 req/s MCP floor. This is Vercel Pro's maximum.
- **Per-MCP-call budget — 30s.** `lib/mcp/transport.ts:38` sets `TOOL_TIMEOUT_MS = 30_000` and composes it with `req.signal` via `AbortSignal.any` (`lib/mcp/transport.ts:131,150`). Whichever fires first wins. A single hung MCP call cannot eat the whole 300s.
- **Per-agent tool-call cap.** Set inside `@aptkit/core`: monitoring 6, diagnostic 6, recommendation 4, query 6 (`node_modules/@aptkit/core/.../monitoring-agent.js:56`, etc.). The kill-switch the model cannot escape. The legacy mirror lives at `lib/agents/{diagnostic,recommendation,monitoring,query}-legacy.ts`.

There is no user-visible perf budget (no LCP target, no INP target). The user-visible contract is "the stream starts within hundreds of ms even when the total run is 30-90s" — see `04-progressive-ndjson-stream.md`.

→ see `01-vercel-route-budget.md` for the deep walk of the 300s ceiling and how the code defends it.

## measurement-baselines-and-profiling

There is **no flamegraph, no profiler, no RUM**. The measurement surface is a single per-request structured log line emitted in the `finally` block of both routes:

```
  app/api/briefing/route.ts:317  console.log(JSON.stringify({
                                   route: '/api/briefing',
                                   sessionId, mode, totalMs, phases, aborted
                                 }));
  app/api/agent/route.ts:331     // same shape, route: '/api/agent'
```

Phases are recorded via `recordPhase(phase, started)` (`app/api/briefing/route.ts:205`, `app/api/agent/route.ts:217`). The shape is deliberately shared so a single Vercel filter — e.g. `phases.phase = "schema_bootstrap"` — reads across both endpoints.

Anthropic per-call `usage` is logged per model call at `lib/agents/aptkit-adapters.ts:60` with the call-site tag `agents/<agent>:aptkit-model`. That is the cost meter.

Baselines are documented in the route comments (`/api/agent` route: "live investigation runs ~100-115s under the ~1 req/s MCP limit") and in `00-overview.md`. There is no committed benchmark suite or before/after evidence file. **Naming this as a gap is the honest move** — the project has phase logs and Anthropic usage logs, but no profiling pipeline.

## latency-throughput-and-tail-behavior

This is a low-throughput, high-latency system. There is no concurrent request fan-in; each route serves one user's investigation at a time. The interesting tail behavior lives on the **upstream side**:

- The Bloomreach alpha server states its own rate-limit window in error text — observed as `(1 per 1 second)` AND `(1 per 10 second)`. `BloomreachDataSource.callTool` parses the stated window (`lib/data-source/bloomreach-data-source.ts:64-71`) and retries against it; falls back to `retryDelayMs = 10_000` exponential backoff when nothing parseable is there.
- Worst-case single-call tail: `maxRetries: 3` × `retryCeilingMs: 20_000` = 60s on one stuck call. The 30s per-call timeout (`lib/mcp/transport.ts:38`) is a separate ceiling for transport-level hangs.
- No p50/p95/p99 collection. The phase log produces a stream of single observations; aggregation lives in Vercel's log search, not in code.

→ see `02-mcp-spacing-and-retry.md` for the spacing-vs-retry teardown.

## cpu-memory-and-allocation

Not yet exercised in any deep way. A few real moves:

- **Bounded tool-result size.** `lib/agents/base-legacy.ts:33` truncates each tool result to `MAX_TOOL_RESULT_CHARS = 16_000` before feeding it back to the model — keeps the prompt token budget from runaway growth on a chatty tool.
- **Bounded NDJSON event payloads.** Both routes truncate per-event result payloads to 4000 chars via `trunc()` (`app/api/agent/route.ts:97-101`, `app/api/briefing/route.ts:71-75`) before emitting them on the wire. The full result still hits the server log; the wire stays small.
- **Bounded schema summary.** `schemaSummary` (`lib/agents/monitoring.ts:19-60`) caps to 20 events × 10 properties + 30 customer properties before injecting `{schema}` into the system prompt. Without this cap, the 112KB raw schema would dominate every Claude turn.

There is no profiling of GC pressure, no allocation tracking, no streaming-of-large-blobs work. This is a stateless serverless app; memory pressure is not the live failure mode.

## io-network-and-database-bottlenecks

**There is no database.** State lives in in-memory maps (`lib/state/insights.ts`, `lib/state/investigations.ts`); dev persists to gitignored JSON files. The I/O bottlenecks are all **upstream API**:

- **MCP transport.** `@modelcontextprotocol/sdk`'s `StreamableHTTPClientTransport` over HTTPS to `loomi-mcp-alpha.bloomreach.com/mcp`. Every tool call is one round-trip. The 1.1s spacing dominates wall-clock far more than per-call HTTP latency does.
- **Anthropic API.** Two models: `claude-sonnet-4-6` for agents, `claude-haiku-4-5-20251001` for intent classification (the intent classifier is the only place a cheaper model is used).
- **Schema bootstrap — 4 sequential MCP calls.** `bootstrapSchema` (`lib/mcp/schema.ts:186-209`) runs `get_event_schema`, `get_customer_property_schema`, `list_catalogs`, `get_project_overview` in order. The sequential shape is required because `BloomreachDataSource.minIntervalMs = 1100` would serialize parallel calls anyway. With the in-process schema cache (`lib/mcp/schema.ts:131`), bootstrap is sub-ms after the first call within the same Node process.

The dominant I/O cost is the MCP server's rate limit, not network latency.

→ see `03-ttl-cache-no-cache-on-error.md` for the 60s response cache.

## caching-batching-and-backpressure

Three distinct caching mechanisms, no batching, no real backpressure:

- **60s TTL response cache** in `BloomreachDataSource` (`lib/data-source/bloomreach-data-source.ts:122,144-148`). Keyed by `name+args`. Critically: returns BEFORE writing when `isError === true` (line 179). A transient 429 cannot poison the cache.
- **In-process schema cache.** `bootstrapSchema` memoizes the whole `WorkspaceSchema` in a module-level `let cached` (`lib/mcp/schema.ts:131,190,200`). Test-only `_resetSchemaCache()`. Within one warm Vercel function instance, the 4-call bootstrap collapses to sub-ms.
- **Investigation cache.** `lib/state/investigations.ts` — in-memory map + dev file. Demo seed lives at `lib/state/demo-investigations.json` (3,487 lines). The `/api/agent` route checks this cache first (`app/api/agent/route.ts:125`) and replays the captured stream to the client without re-running the agents.

**No batching** — MCP calls are issued one at a time (the 1.1s spacing forces serialization).

**No true backpressure.** `minIntervalMs = 1100` is rate-limit compliance — a fixed proactive delay. Backpressure would mean "downstream is slow → upstream sees that signal and slows down accordingly." Here, upstream (the agent) just sleeps before every call regardless of downstream state. The distinction matters — see `02-mcp-spacing-and-retry.md` for the full teaching point.

The synthetic data source (`lib/data-source/synthetic-data-source.ts`) is the **bypass** for both the cache and the spacing — `live-synthetic` mode keeps the real agent loop but uses a deterministic in-process tool catalog. No network, no spacing, no cache pressure. The killer demo path.

→ see `03-ttl-cache-no-cache-on-error.md`.

## rendering-client-and-mobile-performance

Mostly **not yet exercised** as deliberate performance work, but the basics are honest:

- **No `React.memo`, no `useMemo`, no `useCallback`** in `components/` or `app/`. Grep returns zero matches. The component tree is small (`max-w-5xl` container, a handful of cards, a streaming trace panel) and the renders are cheap.
- **No virtualization.** The trace panel renders all events as a flat list. Demo investigations cap around 60-80 events; live runs cap at ~6-10 tool calls × a few text turns. Virtualization would be premature.
- **No bundle analysis script.** No `@next/bundle-analyzer`, no LCP/INP measurement, no Lighthouse pipeline committed to the repo.
- **No image work.** No `<Image>` usage; the only images are `favicon.ico`.
- **Tailwind v4 CSS-first.** Custom keyframes (`bi-fade-up`, `bi-progress`, `bi-dots`) live in `app/globals.css`; design tokens are CSS custom properties. No CSS-in-JS runtime cost.

The honest framing: client-side perf is not where the bottlenecks live. The user's perceived latency is dominated by the server stream (see `04-progressive-ndjson-stream.md`), and that is correctly optimized. Calling this lens out as a deliberate non-investment is more honest than inventing findings.

## performance-red-flags-audit

Ranked by consequence. Each row names the **evidence** — either a baseline or an explicitly missing measurement.

```
  rank  risk                                   evidence
  ────  ─────────────────────────────────────  ────────────────────────────────
  1     a single hung MCP call could blow      bounded — TOOL_TIMEOUT_MS = 30_000
        the entire 300s route budget           in lib/mcp/transport.ts:38
                                               + AbortSignal composition

  2     a transient 429 poisoning the cache,   bounded — early return BEFORE the
        making subsequent calls return the     cache write at
        429 envelope from cache for 60s        lib/data-source/bloomreach-data-source.ts:179

  3     in-process schema cache surviving      bounded by Vercel's serverless
        too long after the workspace mutates   isolation — each cold function
                                               instance re-bootstraps. Risk only
                                               within a warm instance lifetime.

  4     bootstrap (4 sequential MCP calls)     ~4.4s floor in the cold path; sub-ms
        adds ≥4.4s to every cold request       in the warm path via the in-process
                                               cache. Phase log: schema_bootstrap.

  5     the alpha MCP server revokes tokens    handled by the page's auto-reconnect
        after minutes — a long-running         (app/page.tsx + useReconnectPolicy);
        investigation can race the revocation  one-shot guard prevents loops.

  6     no profiler, no RUM, no committed      GAP — the only signal is the
        before/after benchmarks                per-request phase log read in Vercel.
                                               Anthropic res.usage is logged per call
                                               at lib/agents/aptkit-adapters.ts:60.

  7     no p95/p99 aggregation in code         GAP — phase log emits single
                                               observations; aggregation is left to
                                               whoever reads the Vercel log.

  8     replay delays (REPLAY_DELAY_MS 140 /   not a risk — perceived-performance
        180) extend demo wall-clock by         choice. The replay would otherwise
        seconds                                dump the whole snapshot in one flush.

  9     bundle size unmeasured                 GAP — no analyzer script. The
                                               surface is small (5 page routes, a
                                               handful of components) so unlikely
                                               to be load-bearing today.
```

The top three are **already bounded** in code — the risk is real, the mitigation is named and visible. The bottom three are **measurement gaps**, not behavioral risks. The honest framing: the bounding mechanics exist; the observability does not.
