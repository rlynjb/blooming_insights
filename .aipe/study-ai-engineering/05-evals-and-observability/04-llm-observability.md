# 04 — LLM observability

**Subtitle:** Traces, spans, replay · Industry standard (partial in this codebase)

## Zoom out, then zoom in

**Partially exercised.** Today's observability is `console.log` lines:
per-call `usage` (from the model adapter) and per-route phase summary
(from the route handler). Both go to Vercel logs. There's no tracing
platform, no per-call DB rows, no replay capability beyond the demo
snapshots.

```
  Zoom out — three pillars; current state per pillar

  ┌─ Traces (per-request: model, tokens, latency, cost) ──┐
  │  PRESENT: console.log in adapter + route summary     │  ← partial
  │  MISSING: aggregation, dashboard, alerting           │
  └────────────────────────────────────────────────────────┘
  ┌─ Spans (sub-steps within a request) ──────────────────┐
  │  PRESENT: per-phase wall-clock in route summary      │  ← partial
  │  MISSING: per-tool-call span, per-turn span          │
  └────────────────────────────────────────────────────────┘
  ┌─ Replay (re-run saved trace, swap config) ────────────┐
  │  PRESENT: demo snapshots (lib/state/demo-*.json)     │  ← partial
  │  MISSING: replay with different prompt / model        │
  └────────────────────────────────────────────────────────┘
```

## Structure pass

  → **One axis to trace — completeness.** What gets logged vs what gets
    aggregated vs what's queryable. Today: logged but not aggregated
    (Vercel log search is the query interface). Production-grade:
    logged → aggregated → dashboarded → alerted.

## How it works

### Move 1 — the mental model

Same shape as service observability — distributed tracing without the
distribution. One LLM call is one trace; sub-operations (tool calls,
agent turns) are spans within it. Replay is "given the trace, re-run
with a different config and see if the outcome changes."

```
  Three pillars

  ┌─ Traces ─────────────────────────────────────────┐
  │  per request: input, output, latency, tokens,    │
  │  cost, model, prompt version                     │
  └──────────────────────────────────────────────────┘

  ┌─ Spans ──────────────────────────────────────────┐
  │  sub-steps within one request: each agent turn,  │
  │  each tool call, each retrieval — so you can find│
  │  the slow link                                   │
  └──────────────────────────────────────────────────┘

  ┌─ Replay ─────────────────────────────────────────┐
  │  re-run a saved trace with different prompt /    │
  │  model / config — verify a fix without shipping  │
  └──────────────────────────────────────────────────┘
```

### Move 2 — the step-by-step walkthrough

**Trace today:** `AnthropicModelProviderAdapter.complete()` logs per
call (`lib/agents/aptkit-adapters.ts:57-61`):

```typescript
console.log(JSON.stringify({
  site: this.logSite,                  // e.g. "agents/diagnostic:aptkit-model"
  sessionId: this.sessionId,
  usage: response.usage,               // {input_tokens, output_tokens,
                                       //  cache_creation_input_tokens,
                                       //  cache_read_input_tokens}
}));
```

Plus the route handler logs a per-request summary
(`app/api/agent/route.ts:331-338`):

```typescript
console.log(JSON.stringify({
  route: '/api/agent',
  sessionId: sid,
  mode,
  totalMs: Math.round(performance.now() - t0),
  phases,                              // array of {phase, durationMs}
  aborted: req.signal.aborted,
}));
```

These two streams in Vercel logs let you reconstruct:
  - How many model calls per request (count adapter logs by sessionId).
  - Total tokens used per request (sum `usage`).
  - Wall-clock per phase (read `phases` from the route summary).
  - Cancellation rate (look at `aborted: true` ratio).

What's missing for production: aggregation. A query like "p95 latency
for diagnostic investigations over the last 7 days, grouped by
workspace" requires reading every log line, parsing, aggregating —
which is what tools like Langfuse, LangSmith, Phoenix, Helicone do
automatically.

**Spans today:** the `phases` array in the route summary is span-shaped:

```typescript
const phases: Array<{ phase: string; durationMs: number }> = [];
phases.push({ phase: 'schema_bootstrap', durationMs: ... });
phases.push({ phase: 'list_tools', durationMs: ... });
phases.push({ phase: 'diagnostic_investigate', durationMs: ... });
phases.push({ phase: 'recommendation_propose', durationMs: ... });
```

Coarse — phases are at the agent-step level, not the per-turn or
per-tool level. To find "the slow tool call in turn 4 of the diagnostic
investigation," you'd have to grep adapter logs by timestamp. A real
tracing platform would expose this as a flame graph.

**Replay today:** demo snapshots are *event replay*, not trace replay.
The demo replay re-streams the captured `AgentEvent[]` to the UI
without re-running the agent. Useful for presentation; useless for
"what would happen if I changed the prompt?"

True replay would require:
  1. Saving the inputs (anomaly, schema, tools, prompt version).
  2. Saving the deterministic seed (the same prompt + sampling at
     temperature=0 should reproduce — but Blooming runs at default
     sampling, so this isn't true today).
  3. Re-running the agent against the saved inputs with the new
     prompt / model / config.

For the diagnostic agent's eval-rerun shape, this is essentially what
the eval harness in `01-eval-set-types.md`'s exercise does — re-runs
the agent on golden inputs and scores. Trace replay generalizes it.

**The minimum viable upgrade.** Add a per-call row to a database
(SQLite in dev, Postgres in prod). Schema:

```sql
CREATE TABLE llm_call (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  request_id TEXT,                 -- groups calls from one /api/agent invocation
  agent TEXT,                      -- 'monitoring' | 'diagnostic' | ...
  turn INTEGER,                    -- which turn in the loop
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_creation_tokens INTEGER,
  duration_ms INTEGER,
  model TEXT,
  ts TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

`AnthropicModelProviderAdapter` writes one row per call. The route
handler emits a `done_request` log with the `request_id`. Queries
become trivial: total tokens per request, p95 per agent, cache hit
rate, etc.

### Move 3 — the principle

**Log structured data first, then aggregate, then dashboard, then
alert. Each layer makes the next possible.** Today this codebase has
layer 1 (structured log lines). The next move is layer 2 (DB row per
call) which unlocks layer 3 (dashboard) and layer 4 (alert on
regression).

## Primary diagram

```
  Observability layers — current vs target

  ┌─ Layer 1: structured logs ────────────────────────────┐
  │  PRESENT                                              │
  │   - per-call usage log (adapter)                      │
  │   - per-route phase summary (route)                   │
  │   - Vercel log search is the query interface          │
  └────────────────────────────────────────────────────────┘
                            │  upgrade
                            ▼
  ┌─ Layer 2: per-call DB rows ───────────────────────────┐
  │  MISSING                                              │
  │   - llm_call table with tokens, duration, model       │
  │   - written from AnthropicModelProviderAdapter        │
  │   - SQLite in dev, Postgres in prod                   │
  └────────────────────────────────────────────────────────┘
                            │  upgrade
                            ▼
  ┌─ Layer 3: dashboard ──────────────────────────────────┐
  │  MISSING                                              │
  │   - p50/p95 latency per agent over time               │
  │   - daily cost per agent                              │
  │   - cache hit rate                                    │
  │   - cancellation rate                                  │
  └────────────────────────────────────────────────────────┘
                            │  upgrade
                            ▼
  ┌─ Layer 4: alerting ───────────────────────────────────┐
  │  MISSING                                              │
  │   - p95 latency regressed > 20%                       │
  │   - cost per investigation up > 30%                   │
  │   - cache hit rate dropped > 15 pp                    │
  └────────────────────────────────────────────────────────┘
```

## Elaborate

The choice between rolling your own observability and adopting a
platform (Langfuse, LangSmith, Phoenix, Helicone, Arize) depends on
team size and product stage. For blooming insights at current scope
(one engineer, one workspace), `console.log` to Vercel is the right
call — adding a platform now is premature optimization. The minimum
upgrade (add a DB row per call) is the right next step if usage grows
past "one user testing."

Anthropic's own observability features (prompt caching metrics shipped
in `response.usage` natively) are already being captured in the
existing logs but always show as zero because caching isn't enabled
(see `06-production-serving/01-llm-caching.md`'s exercise). Enabling
caching makes that data immediately useful for measuring cache hit
rate.

## Project exercises

### Exercise — add per-call SQLite logging

  → **Exercise ID:** `study-ai-eng-05-04.1`
  → **What to build:** Add `lib/observability/llm-log.ts` exporting an
    `LlmLogger` class that writes one row per LLM call to a local
    `.llm-log.sqlite`. Schema: id, session_id, request_id, agent, turn,
    input_tokens, output_tokens, cache_read_tokens,
    cache_creation_tokens, duration_ms, model, ts. Wire from
    `AnthropicModelProviderAdapter`. Add `/api/debug/cost` route that
    queries the table and returns a JSON cost dashboard.
  → **Why it earns its place:** Layer 2 upgrade. Unlocks "what does each
    user / agent / day cost?" without grepping logs.
  → **Files to touch:** new `lib/observability/llm-log.ts`,
    `lib/agents/aptkit-adapters.ts:57-71` (write to log), new
    `app/api/debug/cost/route.ts`, `package.json` (`better-sqlite3`).
  → **Done when:** A live investigation produces N rows in
    `.llm-log.sqlite`; `/api/debug/cost?days=7` returns a JSON summary.
  → **Estimated effort:** `1–4hr`

### Exercise — wire one of Langfuse / LangSmith / Phoenix for free-tier traces

  → **Exercise ID:** `study-ai-eng-05-04.2`
  → **What to build:** Add a tracing-platform integration. Pick one
    (Langfuse self-hosted or hosted free tier is the easiest). In
    `AnthropicModelProviderAdapter.complete()`, emit trace + span data
    in parallel with the existing console.log. Visit the dashboard,
    inspect a trace, take a screenshot.
  → **Why it earns its place:** Demonstrates fluency with a real
    tracing platform — the answer to "how do you trace LLM calls in
    production?" lands much harder when you have a screenshot.
  → **Files to touch:** `lib/agents/aptkit-adapters.ts:57-71`, env
    vars, README.
  → **Done when:** Live investigation produces traces in the platform;
    you can navigate from a slow investigation → spans → individual
    tool calls.
  → **Estimated effort:** `1–4hr`

## Interview defense

**Q: How does this codebase observe LLM behavior?**

Today: two `console.log` streams to Vercel.

  1. Per-call `usage` from `AnthropicModelProviderAdapter`
     (`lib/agents/aptkit-adapters.ts:57-61`).
  2. Per-route phase summary from the route handler
     (`app/api/agent/route.ts:331-338`).

Vercel log search is the query interface. That's enough to reconstruct
per-request token count, per-phase wall-clock, cancellation rate. It's
not enough for aggregation — "p95 latency for diagnostic agents over
the last week" needs a DB row per call.

The phased upgrade:
  - Layer 2: SQLite row per call (next step).
  - Layer 3: dashboard (`/api/debug/cost`).
  - Layer 4: alerting on regression.

**Anchor line:** "Structured logs to Vercel today; the next upgrade is
a per-call DB row to unlock real aggregation."

**Q: What's missing for production-grade observability?**

Three things, in order of impact:
  1. Per-call DB rows (so you can query aggregates without grepping).
  2. A real tracing platform (Langfuse / Phoenix / LangSmith) or a
     hand-built dashboard.
  3. True trace replay — re-run a saved investigation against a new
     prompt or model and see if the outcome changes.

For now, `console.log` + Vercel covers the bases. Layer 2 is the
next meaningful step.

## See also

  → `01-eval-set-types.md` — replay's natural companion (re-run on eval set)
  → `01-llm-foundations/06-token-economics.md` — what the cost data is for
  → `04-agents-and-tool-use/06-error-recovery.md` — what error data feeds
    cancellation / failure metrics
