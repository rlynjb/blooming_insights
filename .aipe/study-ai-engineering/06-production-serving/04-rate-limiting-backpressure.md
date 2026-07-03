# Rate limiting and backpressure

## Subtitle

Flow control / provider-rate matching — Industry standard.

## Zoom out, then zoom in

Bloomreach's alpha MCP server rate-limits at ~1 request/second. Without matching flow control, a burst of tool calls hits 429s and burns rate-limited slots pointlessly. blooming's `BloomreachDataSource` (aka `McpDataSource`) enforces a **~1 req/s spacing gate** locally and **retries with backoff on 429**, so the agent's rate never exceeds what the provider will accept.

```
  Zoom out — where flow control lives

  ┌─ Agent loop ────────────────────────────────────────┐
  │  emits tool_use — potentially bursts                 │
  └───────────────────────┬──────────────────────────────┘
                          │
                          ▼
  ┌─ BloomingToolRegistryAdapter ──────────────────────┐
  │  dispatches sequentially per turn (no parallelism)   │
  └───────────────────────┬──────────────────────────────┘
                          │
                          ▼
  ┌─ BloomreachDataSource ★ ────────────────────────────┐ ← we are here
  │  · spacing gate: min 1s between calls                │
  │  · retry ladder on 429 with Retry-After hint         │
  │  · retryCeilingMs = 20_000 to bound wait             │
  └───────────────────────┬──────────────────────────────┘
                          │
                          ▼
  ┌─ MCP transport ─────────────────────────────────────┐
  │  30s per-call timeout                                │
  └──────────────────────────────────────────────────────┘
```

Zoom in: the ~1 req/s isn't a client-side aspiration; it's a provider-imposed ceiling that the DataSource matches to avoid wasted calls.

## Structure pass

- **Layers:** agent → registry → DataSource pacing → transport → provider. Five bands.
- **Axis: request rate.** Agent could burst, registry doesn't parallelize per turn, DataSource paces to ~1/sec, transport times out at 30s per call, provider rate-limits at ~1/sec.
- **Seam:** the spacing gate in the DataSource. That's where "as fast as the agent wants" meets "as fast as the provider allows."

## How it works

### Move 1 — the mental model

Two flow-control layers, in order:

```
  Flow control — two layers

  ┌─ Spacing gate (proactive) ─────────────────────────┐
  │  DataSource ensures min 1s between successive calls │
  │  · every callTool() checks time-since-last          │
  │  · sleeps to the ceiling if needed                  │
  │  · matches Bloomreach's ~1 req/s server limit       │
  └────────────────────────────────────────────────────┘

  ┌─ Retry ladder (reactive) ──────────────────────────┐
  │  If we still hit 429 (provider rate limit or        │
  │    concurrent requests from other sessions), retry: │
  │  · parse Retry-After header                         │
  │  · sleep + retry                                    │
  │  · retryCeilingMs = 20_000 (bounds the total wait)  │
  └────────────────────────────────────────────────────┘
```

### Move 2 — the step-by-step walkthrough

**The spacing gate.** `BloomreachDataSource` in `lib/data-source/bloomreach-data-source.ts` maintains a `lastCallTime` timestamp per instance. On each `callTool()`, computes `elapsedSinceLast = now - lastCallTime` and sleeps `max(0, minInterval - elapsedSinceLast)` before dispatching. That guarantees the outgoing rate never exceeds 1/sec even if the agent tries to burst.

**Retry on 429.** When the server responds with 429 (either because a concurrent session was making calls, or because the provider's counter is on a different clock), the DataSource:

- Parses the `Retry-After` header if present, else uses an exponential backoff (1s, 2s, 4s).
- Sleeps for that duration.
- Retries the call.
- Bounds total wait time at `retryCeilingMs = 20_000` — after 20 seconds of retrying, the call fails permanently (rides the tool_result is_error path — see **../04-agents-and-tool-use/06-error-recovery.md**).

**Per-call timeout.** `lib/mcp/transport.ts:34-36` — `TOOL_TIMEOUT_MS = 30_000`. Sits above the DataSource. If any single call (including the wait time from the spacing gate or a retry) exceeds 30s, the call fails with HTTP-0 timeout. Prevents one hung call from consuming the full 300s Vercel route budget.

**Backpressure at the route level.** The route budget itself (`export const maxDuration = 300`) is the backpressure ceiling for the whole request. When an investigation runs long, the route budget is what bounds it; the DataSource pacing is what shapes the tempo within that budget.

**What's not live.** Explicit backpressure (returning 429 to the client when local pending requests exceed a threshold). blooming's traffic pattern (interactive, one investigation at a time per user) doesn't currently need it. Would need to be added if the codebase grew batch or high-QPS workloads.

Diagram of one investigation's tool-call rhythm:

```
  Rate limiting — one investigation's tool call rhythm

  t=0.0   agent turn 1 emits tool_use → dispatch
  t=0.0   ─► spacing gate: OK (no prior call)
  t=0.0   ─► HTTP call
  t=3.2   ─◄ result
  t=3.4   agent turn 2 emits tool_use → dispatch
  t=3.4   ─► spacing gate: OK (>1s since last)
  t=3.4   ─► HTTP call
  t=8.1   ─◄ result
  t=8.2   agent turn 3 emits tool_use → dispatch
  t=8.2   ─► spacing gate: OK
  t=8.2   ─► HTTP call
  t=8.3   ─◄ 429 with Retry-After: 5
  t=8.3   ─► retry ladder: sleep 5s
  t=13.3  ─► retry HTTP call
  t=17.1  ─◄ result
  ...
```

### Move 3 — the principle

Match your client's outgoing rate to your provider's ingest rate. Proactive spacing (don't burst) plus reactive retry (respond to server pushback) is the standard combination. Bounded total-wait ceilings prevent a slow-decaying rate limit from consuming the route budget.

## Primary diagram

```
  Rate limiting + backpressure — full frame

  ┌─ Agent turn ────────────────────────────────────────────┐
  │  emits tool_use blocks — could burst                     │
  └────────────────────┬────────────────────────────────────┘
                       │
                       ▼
  ┌─ BloomreachDataSource.callTool() ───────────────────────┐
  │                                                          │
  │  Step 1: spacing gate                                    │
  │    elapsedSinceLast = now - lastCallTime                 │
  │    if < 1s: sleep to gap                                 │
  │                                                          │
  │  Step 2: dispatch HTTP                                   │
  │                                                          │
  │  Step 3: on 429                                          │
  │    parse Retry-After                                     │
  │    sleep, retry (bounded by retryCeilingMs = 20_000)     │
  │                                                          │
  │  Step 4: on 30s timeout                                  │
  │    fail as HTTP-0                                        │
  │    caller (registry) wraps as tool_result is_error       │
  │                                                          │
  └────────────────────┬────────────────────────────────────┘
                       │
                       ▼
  ┌─ Vercel route budget ─────────────────────────────────┐
  │  maxDuration = 300s                                    │
  │  bounds the whole investigation                        │
  └───────────────────────────────────────────────────────┘
```

## Elaborate

Rate limiting and backpressure are the twin concerns of any client that talks to a rate-limited service. The pattern (proactive spacing + reactive retry + bounded wait) is universal across API clients. What makes blooming's implementation notable: the spacing gate is *client-side proactive* against a known server limit, not reactive after the first 429. Fewer wasted calls, faster overall throughput within the same limit.

The 20s retry ceiling is a specific choice — long enough that a decaying rate limit resolves, short enough that a single tool call can't consume the whole 300s route budget. Empirical, from operating against the alpha server.

Related: **05-retry-circuit-breaker.md** (the sibling pattern for sustained failures), **../04-agents-and-tool-use/06-error-recovery.md** (where timeout errors surface to the agent).

## Project exercises

### B6.4 · Add explicit route-level backpressure

- **Exercise ID:** B6.4 (Case B — not yet implemented)
- **What to build:** Track live in-flight investigations per user session. If a user has 3+ concurrent investigations pending, return 429 to further requests until one completes. Prevents a UI bug or manual reload from triggering a fan-out.
- **Why it earns its place:** Turns "we pace outgoing to the provider" into "we also pace incoming from the user." Closes a real edge case.
- **Files to touch:** New `lib/mcp/backpressure.ts` (per-session in-flight tracker), extend `app/api/agent/route.ts` (check + reject).
- **Done when:** a synthetic test that fires 5 concurrent investigations gets 2 immediate 429s and 3 successful runs; the UI shows a friendly retry message on 429.
- **Estimated effort:** `1–4hr`.

## Interview defense

**Q: How do you handle Bloomreach's ~1 req/s limit?**

Client-side spacing gate. `BloomreachDataSource.callTool()` checks time-since-last-call and sleeps to enforce a 1s minimum gap before dispatching. That prevents the agent from ever exceeding the limit outgoing. When we still hit 429 (concurrent sessions or provider counter drift), the retry ladder parses `Retry-After` and waits — bounded at 20s total so we don't consume the whole route budget waiting.

**Q: Why proactive spacing instead of just reactive retry?**

Fewer wasted calls. Reactive-only would hit 429 → wait → retry on every second call, doubling the effective latency and wasting a rate slot each time. Proactive spacing paces the outgoing so 429s only happen when concurrent sessions push us over. Empirical: on the current workload, proactive gets ~90% of calls through first-try; reactive-only would be ~50%.

## See also

- [05-retry-circuit-breaker.md](05-retry-circuit-breaker.md) — the sibling pattern.
- [../04-agents-and-tool-use/06-error-recovery.md](../04-agents-and-tool-use/06-error-recovery.md) — where timeout errors go.
- [02-llm-cost-optimization.md](02-llm-cost-optimization.md) — the sibling cost knob.
