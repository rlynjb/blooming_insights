# Retry and circuit breaker

## Subtitle

Transient-failure retry / sustained-failure circuit breaker — Industry standard.

## Zoom out, then zoom in

**Retry with backoff** is live in `BloomreachDataSource` for 429 responses (see **04-rate-limiting-backpressure.md**). **Circuit breaker** is not — sustained provider outages currently degrade individual investigations rather than tripping a global fast-fail. That's an accepted risk given the workload (interactive, low QPS); a shipped circuit breaker would earn its place if the codebase grew batch or scheduled workloads.

```
  Zoom out — where each pattern fits

  ┌─ Retry with backoff (LIVE) ─────────────────────────┐
  │  handles transient failures                          │
  │  · 429 rate limit                                    │
  │  · occasional 500 / connection drop                  │
  │  · bounded by retryCeilingMs = 20_000                │
  └─────────────────────────────────────────────────────┘

  ┌─ Circuit breaker (NOT LIVE) ────────────────────────┐
  │  would handle sustained failures                     │
  │  · provider outage                                   │
  │  · repeated 5xx across sessions                      │
  │  · fast-fail instead of hammering                    │
  └─────────────────────────────────────────────────────┘
```

## Structure pass

- **Layers:** attempt → retry → wait ceiling → give up. Retry pattern. And: consecutive failures → open circuit → fast-fail → half-open probe → close. Circuit-breaker pattern.
- **Axis: failure duration.** Retry handles seconds-long transients. Circuit breaker handles minutes-long outages.
- **Seam:** the retry code lives in the DataSource. A circuit breaker would sit above it, wrapping the DataSource.

## How it works

### Move 1 — the mental model

Two patterns for two shapes of failure:

```
  Retry — transient failure

    attempt 1 fails
       │
       ▼ wait 1s
    attempt 2 fails
       │
       ▼ wait 2s
    attempt 3 fails
       │
       ▼ wait 4s (bounded by retryCeilingMs)
    give up → tool_result is_error: true

  Circuit breaker — sustained failure

    N consecutive failures observed
       │
       ▼ "open" the circuit
    all requests fail fast for T seconds
       │
       ▼ "half-open" — try one
       │
    ┌──┴──┐
    │     │
    ▼ ok  ▼ still fails
   close  open again
```

### Move 2 — the step-by-step walkthrough

**Retry — live implementation.** `BloomreachDataSource` (via the shim `lib/mcp/client.ts` → `lib/data-source/bloomreach-data-source.ts`) has a retry ladder for 429 responses:

- Parse `Retry-After` header if present.
- Fall back to exponential backoff (1s, 2s, 4s) if not.
- Track total wait time; bail if it exceeds `retryCeilingMs = 20_000`.
- On bail, throw `McpToolError`; the registry catches it and wraps as `tool_result { is_error: true }` (see **../04-agents-and-tool-use/06-error-recovery.md**).

**Retry is only for rate limits.** The retry ladder does NOT retry semantic errors (400, 401 auth failure, etc). Those are hard failures — retrying them would only burn rate slots. `McpClient.callTool` in `lib/data-source/bloomreach-data-source.ts` distinguishes retryable (429) from non-retryable (everything else).

**Circuit breaker — not live, when it would earn its place.**

Consider what happens if Bloomreach's server is down for 10 minutes:

- Current: every investigation attempts, fails at 30s timeout (per call) × several tools = 2 min per investigation before the whole thing collapses. If 5 users try during the outage, that's 10 min of wasted server-side work.
- With circuit breaker: after 3 consecutive failures across the app, "open" the circuit. All subsequent requests fail fast (in ~10ms) for 60 seconds. After 60s, half-open — try one probe. If it succeeds, close. If it fails, re-open for another 60s.

The value is capped waste during outages. blooming doesn't have this because the workload is low enough that the waste is bounded — a handful of users, an interactive UI. If the codebase grew a scheduled hourly refresh across many workspaces, the circuit breaker would earn its place.

**No retry on the model API.** Anthropic occasionally returns transient errors too, but the SDK handles most of them internally. blooming doesn't wrap the Anthropic call with a retry ladder; the SDK's internal retry is sufficient. If it weren't, adding retry at the `AnthropicModelProviderAdapter.complete()` boundary would be the place.

Diagram of the retry ladder in one call:

```
  Retry ladder — one call under rate-limit pressure

  t=0.0   callTool("execute_analytics_eql", {...})
    │
    ▼
  t=0.0   HTTP dispatch
  t=0.4   429 { Retry-After: 3 }
    │
    ▼ sleep 3s
  t=3.4   retry HTTP dispatch
  t=3.6   429 { Retry-After: 5 }
    │
    ▼ sleep 5s (running total: 8s)
  t=8.6   retry HTTP dispatch
  t=8.7   429 { Retry-After: 10 }
    │
    ▼ sleep would exceed 20s ceiling
    ▼ throw McpToolError
    │
    ▼ registry wraps as tool_result is_error: true
    │
    ▼ agent turn sees error, tries different tool
```

### Move 3 — the principle

Retry handles noise; circuit breaker handles outage. Both have hard caps that prevent them from consuming their parent budget (route timeout, user attention span). The right pattern for the load — blooming's interactive low-QPS shape earns retry but not circuit breaker; a batch or scheduled workload would earn both.

## Primary diagram

```
  Retry + would-be circuit breaker — full frame

  ┌─ Agent call ─────────────────────────────────────────────┐
  │  registry.execute(tool_use)                               │
  └──────────────────────┬───────────────────────────────────┘
                         │
                         ▼
  ┌─ [WOULD BE] Circuit breaker ─────────────────────────────┐
  │  if circuit open: fail fast → is_error                    │
  │  if half-open: allow probe                                │
  │  currently: not implemented; each call attempts           │
  └──────────────────────┬───────────────────────────────────┘
                         │  circuit closed / not in circuit
                         ▼
  ┌─ BloomreachDataSource retry ladder (LIVE) ───────────────┐
  │                                                            │
  │  attempt 1                                                 │
  │    │  on 429                                                │
  │    ▼                                                       │
  │  wait per Retry-After (or 1s, 2s, 4s exp backoff)          │
  │    │                                                       │
  │    ▼                                                       │
  │  attempt 2                                                 │
  │    │  ...                                                   │
  │    ▼                                                       │
  │  if total wait > 20s: bail → McpToolError                  │
  │                                                            │
  └──────────────────────┬───────────────────────────────────┘
                         │
                         ▼
  ┌─ Tool result to model ────────────────────────────────────┐
  │  either { is_error: false, ... } or is_error: true         │
  │  agent handles either gracefully                           │
  └───────────────────────────────────────────────────────────┘
```

## Elaborate

Retry and circuit breaker are the twin patterns for reliability against unreliable dependencies. Retry (with backoff and jitter) handles the noise floor — transient network hiccups, brief rate spikes, occasional 5xx. Circuit breaker handles the outage floor — sustained failure that would otherwise cause the client to hammer the failing service and burn its own budget.

The "half-open" state in a circuit breaker is what lets it recover automatically without human intervention. Without it, someone has to manually close the circuit; the half-open probe pattern discovers when the dependency is healthy again.

Related: **04-rate-limiting-backpressure.md** (the sibling flow-control pattern), **../04-agents-and-tool-use/06-error-recovery.md** (where failures ride into the agent as observations).

## Project exercises

### B6.5 · Add a simple circuit breaker to the DataSource

- **Exercise ID:** B6.5 (Case B — not yet implemented)
- **What to build:** Wrap `BloomreachDataSource` with a circuit-breaker decorator (mirroring `FaultInjectingDataSource`'s pattern). Track consecutive failures; open the circuit at 3 failures; fast-fail for 60s; half-open probe.
- **Why it earns its place:** Turns "individual calls fail gracefully" into "sustained outages fast-fail globally." Small, testable, uses the existing decorator pattern.
- **Files to touch:** New `lib/data-source/circuit-breaker.ts` (mirrors `fault-injecting.ts`), extend `lib/data-source/index.ts` to wrap.
- **Done when:** synthetic test that sends 5 failing calls trips the breaker; the 6th call fast-fails within 10ms; after 60s idle, the 7th call attempts and closes the breaker.
- **Estimated effort:** `1–4hr`.

## Interview defense

**Q: Why retry but no circuit breaker?**

Workload shape. blooming is interactive, low-QPS — a handful of users, one investigation at a time. During an outage, the wasted work is bounded by the 300s route budget × concurrent users. A circuit breaker would be strictly better, but the marginal value at this scale is small. If the codebase grew a scheduled or batch workload, the circuit breaker would earn its place immediately (see `B6.5`).

**Q: What happens if Bloomreach is down for 10 minutes?**

Currently: each investigation attempts, fails at 30s timeout × several tools = ~2 min per investigation before the agent gives up cleanly (all tool_results are is_error: true, so the agent produces a "cannot diagnose" output rather than crashing). Multiple concurrent investigations each burn their own budget. Not ideal, but bounded — the route timeout prevents runaway. The circuit breaker would cut waste from ~2 min to ~10 ms per attempt during the outage.

## See also

- [04-rate-limiting-backpressure.md](04-rate-limiting-backpressure.md) — the sibling flow-control pattern.
- [../04-agents-and-tool-use/06-error-recovery.md](../04-agents-and-tool-use/06-error-recovery.md) — where retry exhaustion surfaces to the agent.
- [../04-agents-and-tool-use/02-tool-calling.md](../04-agents-and-tool-use/02-tool-calling.md) — the tool_result path is_error rides.
