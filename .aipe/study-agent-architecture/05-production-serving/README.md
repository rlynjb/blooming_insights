# 05 — Production serving for agents

What changes about caching, rate limiting, and failure handling once the unit of execution is no longer one LLM call but a loop (single-agent) or a topology (multi-agent) that issues many calls — often repeatedly against the same tool. The single-call mechanics for each (caching, rate-limit/backpressure, retry/circuit-breaker) live in the AI engineering guide; this sub-section covers the agent-architecture angle, where the same problem compounds across turns and across concurrent agents.

> The seam is clean: per-call serving (one request, one response) sits in `../../study-ai-engineering/06-production-serving/`. Per-loop / per-topology serving (many turns, possibly concurrent agents) sits here. Each file in this sub-section cross-references its ai-eng counterpart for the single-call mechanics it extends.

## Reading order

| # | File | What it covers | Case |
|---|------|----------------|------|
| 1 | [01-cross-turn-caching.md](01-cross-turn-caching.md) | Three cache scopes — per-turn (provider prefix), intra-run (memoize within one task), cross-run (semantic across tasks) — plus a whole-run replay. blooming insights builds intra-run (60s TTL `Map` in `McpClient`) and whole-run replay (the demo). Cross-run semantic is skipped on purpose because a stale hit poisons the whole trajectory, not one response. | A (partial — two of three layers) |
| 2 | [02-fan-out-backpressure.md](02-fan-out-backpressure.md) | Semaphore + bounded queue + upward signal so a supervisor pauses decomposition when the queue fills. blooming insights doesn't fan out — agents are sequential and user-gated. The 1.1s inter-call spacing in `McpClient.liveCall` is serial rate-limit compliance for one call chain, NOT concurrency backpressure. | B (not implemented — topology is sequential) |
| 3 | [03-per-tool-circuit-breaking.md](03-per-tool-circuit-breaking.md) | Per-tool circuit breaker with closed/open/half-open state, AND the agent-specific extension: feed open-state back to the agent as an observation so the model routes around the dead tool. blooming insights has bounded exponential-backoff retry (10s base / 20s ceiling / 3 max) but no breaker and no agent-observation feedback path. | B (partial — retry built, breaker + observation missing) |

## How this sub-section relates to the ai-eng guide

Each file here extends a single-call pattern covered in the ai-eng guide. The split:

```
  per-call (ai-eng)                      per-loop / topology (this section)
  ───────────────────                    ───────────────────────────────────
  prompt-prefix cache                    intra-run memoization +
  exact-match response cache             whole-run replay +
                                          cross-run semantic (skipped)
                                          (01-cross-turn-caching.md)

  request spacing,                       semaphore + bounded queue +
  client throttling                      upward signal to producer
                                          (02-fan-out-backpressure.md)

  bounded retry,                         per-tool breaker +
  exponential backoff,                   agent-observation feedback
  Retry-After honoring                   so the model routes around
                                          dead tools
                                          (03-per-tool-circuit-breaking.md)
```

The ai-eng files cover the *mechanics*; the files here cover what *changes* once those mechanics are wrapped in an autonomous loop. Read both when the question is "how does this work" — the single-call file for the building block, the agent-architecture file for the loop-level discipline.

## What this codebase actually does

blooming insights is a sequential multi-agent system (the chain-of-agents shape covered in `../01-reasoning-patterns/01-chains-vs-agents.md`):

- **Caching:** intra-run `Map` over MCP tool calls (60s TTL, keyed on `name:JSON.stringify(args)`) + whole-run replay for the demo. No prompt-prefix cache. No cross-run semantic cache (skipped on purpose).
- **Rate-limit compliance:** 1100 ms fixed-interval spacing in `McpClient.liveCall` against Bloomreach's ~1 req/s per-user limit. No semaphore, no queue, no upward signal — the topology is sequential so backpressure doesn't apply yet.
- **Failure handling:** bounded exponential-backoff retry (3 attempts, 10s base, 20s ceiling, Retry-After-honoring) on rate-limit errors. No per-tool circuit breaker. No path that surfaces "tool down" state back to the agent for routing.

Each of these is the right floor for the current topology. The breakpoint where each gap matters is named in its file — and they're not all the same breakpoint. Cross-run semantic caching becomes a real question when data is provably slow-moving; fan-out backpressure becomes a real question the day a parallel topology ships; the per-tool breaker becomes a real question when sustained outages become a recurring failure mode.

## Cross-references

- `../../study-ai-engineering/06-production-serving/01-llm-caching.md` — per-call caching mechanics (prompt-prefix, exact-match)
- `../../study-ai-engineering/06-production-serving/04-rate-limiting-backpressure.md` — single-call rate limiting, the spacing pattern the codebase uses
- `../../study-ai-engineering/06-production-serving/05-retry-circuit-breaker.md` — single-call retry and breaker mechanics
- `../01-reasoning-patterns/01-chains-vs-agents.md` — why this topology is sequential, not parallel
- `../03-multi-agent-orchestration/04-parallel-fan-out.md` — the topology that would activate the fan-out backpressure pattern
- `../03-multi-agent-orchestration/09-coordination-failure-modes.md` — the broader failure-mode catalog the per-tool breaker bounds

---
