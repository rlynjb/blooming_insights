# Fan-out backpressure

**Industry standard.** Concurrency caps when a fan-out topology can spawn faster than the provider serves. **Not exercised** in the multi-agent fan-out sense — but the underlying primitive (`minIntervalMs` spacing in `BloomreachDataSource`) is the same one a fan-out cap would use.

## Zoom out, then zoom in

Sits at the boundary between the agent (or orchestrator) that emits concurrent work and the provider that has finite serving capacity. Without a cap, the agent can pile up requests faster than the provider can answer; the result is a queue of 429 rate-limit errors.

```
  Zoom out — where this concept lives

  ┌─ Orchestration layer ───────────────────────────┐
  │  (today: sequential; would fan-out N workers)    │
  └────────────────────────┬────────────────────────┘
                           │ many concurrent calls
                           ▼
  ┌─ Backpressure layer ──────────────────────────────┐
  │  ★ concurrency cap (semaphore / token bucket) ★  │ ← we are here
  └────────────────────────┬────────────────────────┘
                           ▼
  ┌─ Provider ──────────────────────────────────────┐
  │  Anthropic + Bloomreach MCP (each rate-limited) │
  └─────────────────────────────────────────────────┘
```

## Structure pass

Layers: spawner (the supervisor / fan-out caller) → concurrency limiter (semaphore over outbound calls) → provider (the rate-limited service) → upward backpressure (when the queue grows, the spawner stops spawning).

**Axis traced — "what's preventing the runaway?":** the concurrency cap at the limiter and the backpressure signal back to the spawner. Without both, "spawn N then process the queue" turns into "spawn N then watch 429s pile up."

**Seam:** the limiter's queue. Pop up to N concurrent; queue the rest. When the queue overruns a threshold, signal upstream.

## How it works

### Move 1 — the mental model

You know `Promise.all` with a concurrency cap — "run 200 requests, but no more than 10 at a time." That's the canonical pattern. The agent version adds two wrinkles: the unit of concurrent work is an agent call (not a single HTTP request), and the spawner is sometimes another agent (a supervisor that can keep dispatching workers as long as the queue accepts).

```
  Fan-out backpressure — the shape

  Supervisor decomposes → 12 worker calls at once
                       │
                       ▼
  ┌───────────────────────────────────────────────┐
  │  Concurrency limiter (semaphore)              │
  │   pop up to N concurrent (N = 4)              │
  │   queue the rest                              │
  └────────────────────┬──────────────────────────┘
                       ▼
  ┌───────────────────────────────────────────────┐
  │  Provider — receives at most N at a time      │
  └───────────────────────────────────────────────┘
```

### Move 2 — step by step

#### What this repo has — the proactive spacing primitive

Open `lib/data-source/bloomreach-data-source.ts:190-205`:

```ts
private async liveCall(name, args, signal?): Promise<unknown> {
  const elapsed = Date.now() - this.lastCallAt;
  if (elapsed < this.minIntervalMs) {           // 200ms default
    await new Promise((r) => setTimeout(r, this.minIntervalMs - elapsed));
  }
  // ... actual transport call ...
}
```

`minIntervalMs = 200` enforces at least 200ms between MCP wire calls *per data-source instance*. This is the rate-limit-anticipation primitive — it works even when the agent loop fires tool calls without spacing because the data source enforces the floor regardless.

Why this matters: Bloomreach's loomi connect server is per-user rate-limited at roughly 1 request per second. The 200ms floor is conservative against that ceiling — agents can issue calls aggressively without immediately triggering 429s. When they do (which still happens; see `01-cross-turn-caching.md` and `03-per-tool-circuit-breaking.md`), the retry ladder handles it.

This is the same primitive a fan-out concurrency cap would use. If the repo grew a parallel-worker topology, the natural implementation would be: wrap each worker's call sequence in a `p-limit`-style semaphore (or use an in-process token bucket), with the semaphore's max-concurrency tuned to the provider's rate. The `minIntervalMs` is the per-call-spacing form of the same backpressure idea.

#### What's missing — true fan-out backpressure

Since the repo doesn't run fan-out, the *upward* backpressure signal isn't implemented. The full pattern needs:

1. **Concurrency cap on outbound calls.** Present in the form of `minIntervalMs` spacing.
2. **Queue depth visibility.** A spawning supervisor needs to know how deep the limiter's queue is so it can decide whether to keep spawning. Not present.
3. **Upstream cancellation.** When the queue exceeds a threshold, the supervisor should pause decomposing further work. Not present.

The supervisor isn't part of this repo (the orchestration is deterministic), so the upward backpressure isn't needed. If the repo escalated to supervisor-worker with fan-out, all three pieces would land together.

#### The tradeoff that's sharper for agents than for one-off calls

The spec calls out: "a low concurrency cap protects the provider but serializes the fan-out (you lose the parallel-latency win that made fan-out worth it)." This is exactly the breakpoint analysis.

For this repo: even if fan-out were added, the effective concurrency is bounded by the MCP per-user rate limit. Two agents fanning out 4 calls each at the same instant would still pace at 1 req/s per user — the parallelism gain on the wire is zero. The win would only manifest at the *model-call* layer, where Anthropic's per-account rate limit is higher (tens of requests per second) and concurrent model calls can serve concurrent reasoning steps.

So the fan-out's actual win in this repo's domain wouldn't be wire concurrency (still bounded by MCP); it would be *reasoning concurrency* — two agents thinking about different sub-anomalies at the same time, each issuing sequential MCP calls. The supervisor's job becomes "split the work so each worker's MCP queue is independent" rather than "fire 12 MCP calls in parallel and pray."

#### When the spawner needs to stop spawning

The supervisor's reasoning is the runaway risk. A supervisor that keeps decomposing work as it sees previous work complete can spawn unbounded work. The mitigation: a global per-run worker cap. Whatever the supervisor's loop says, the orchestrator should refuse to spawn worker N+1 once N is at the cap. This is the multi-agent version of the single-agent budget exit from `01-reasoning-patterns/02-agent-loop-skeleton.md`.

### Move 3 — the principle

**The cap protects the provider; the backpressure protects the system.** Without the cap, you flood the provider and accumulate 429s. Without the backpressure, the cap fills up and the spawning agent keeps queuing more work — eventually OOMing the orchestrator or burning the route's wall-clock budget on queued work that will never reach the provider in time. Both halves are needed for fan-out to be safe at scale.

If you need more throughput than the provider's rate limit allows, the answer is *request a higher limit or batch* — not a higher local concurrency cap that just trades queueing for 429s. The cap can't manufacture provider capacity.

## Primary diagram

```
  Backpressure in this repo today (sequential) and in a hypothetical fan-out

  CURRENT (sequential, no fan-out):

  agent loop → tool_use → tools.callTool → BloomreachDataSource
                                                   │
                                          ┌────────▼────────┐
                                          │ liveCall:       │
                                          │  spacing check  │
                                          │  (minIntervalMs)│
                                          │   ─► wait if    │
                                          │      needed     │
                                          │  ─► transport   │
                                          │     call        │
                                          └─────────────────┘
                                                   │
                                                   ▼
                                          MCP wire (1 call at a time
                                          per data-source instance)


  HYPOTHETICAL fan-out with backpressure (not implemented):

  Supervisor decomposes task → 12 worker calls
              │
              ▼
  ┌─ Concurrency limiter (semaphore, N=4) ──────────┐
  │  pop 4 → run concurrently                       │
  │  queue 8                                         │
  │  when queue.length > threshold:                  │
  │     emit backpressure → supervisor pauses        │
  │     decomposing further work                     │
  └────────────────────────┬─────────────────────────┘
                           ▼
              4 worker agents in parallel
              each: own runAgentLoop + own
                    BloomreachDataSource
                    (each enforces 200ms
                     spacing for its own calls)
                           │
                           ▼
                   MCP wire (rate-limited
                   per user globally, so
                   effective parallelism
                   is roughly 1 req/s
                   across all workers)
```

## Elaborate

The "request a higher limit or batch" rule from the spec is the production realization that local concurrency caps can't manufacture provider capacity. A team that hits 429s and responds by raising their local concurrency cap is solving the wrong problem — the cap controls *their* outbound rate, not the provider's serving rate. The right responses are (a) negotiate a higher rate limit with the provider (Anthropic has tier programs; Bloomreach has enterprise tiers), (b) batch operations where the protocol supports it, or (c) reduce the work-rate at the spawner.

For this repo, the MCP rate-limit ceiling is the structural constraint. Even with perfect fan-out infrastructure, the per-user MCP limit caps effective throughput. The win from fan-out would be on the *reasoning* side (concurrent model calls thinking about different sub-problems), not on the *wire* side (concurrent MCP calls would still serialize). This is a useful reframe: fan-out's win isn't always wire parallelism; sometimes it's reasoning parallelism with serialized data access.

The Anthropic SDK's per-account rate limit is hierarchical — input tokens per minute, output tokens per minute, requests per minute. Hitting any of these triggers a 429 with a `retry-after` header. A fan-out backpressure system needs to listen to all three signals; reacting only to RPS misses TPM-driven throttling. This repo's BloomreachDataSource handles the analogous MCP rate-limit retry by parsing the server's retry-after window (`bloomreach-data-source.ts:64-71`); a model-layer equivalent would parse Anthropic's headers and back off accordingly.

## Interview defense

> **Q: Does this codebase have fan-out backpressure?**
>
> Not in the multi-agent fan-out sense — there's no parallel topology. But the underlying primitive — `BloomreachDataSource.minIntervalMs=200ms` proactive spacing between MCP calls — is the same one a fan-out cap would use. The data source enforces at least 200ms between wire calls per instance, which is conservative against Bloomreach's per-user rate limit (~1 req/s). If the repo escalated to fan-out, the natural implementation would wrap workers in a `p-limit`-style semaphore with a max-concurrency tuned to the provider's rate, and add an upward backpressure signal so the spawning supervisor pauses when the queue exceeds a threshold.

> **Q: Why does the local concurrency cap matter even when the provider rate-limits?**
>
> Local caps protect against your own queue from blowing up. The provider's rate limit kicks in via 429 retries — without a local cap, your code might queue 200 calls, send all 200 at once, get 196 of them rejected, and burn the route's wall-clock budget on retries that mostly fail. With a local cap, only N concurrent calls are in flight at a time; the queue drains at the provider's actual serving rate; you don't waste budget on retries the provider was always going to reject. Both layers (local cap + provider retry) are needed. Local cap as the first defense, retry as the recovery when the cap miscalculates.

> **Q: If you needed more throughput than the MCP rate limit allows, what would you do?**
>
> Three answers, in priority order. First: negotiate a higher rate limit with Bloomreach. Enterprise tiers have higher per-user limits; the alpha server's ~1 req/s ceiling isn't representative of production tiers. Second: batch where the protocol supports it. Some MCP servers expose batched operations (e.g. `execute_analytics_eql_batch`); a single batched call counts as one against the rate limit but covers N queries. The current Bloomreach loomi connect doesn't expose batched EQL, but it's a path. Third: reduce the work-rate at the spawner. If the supervisor's decomposition can produce 50 sub-tasks for a question that the user is fine getting an answer to in 30s, but the provider can only serve 20 in 30s, the supervisor should prefer 20 high-value sub-tasks over decomposing into 50 medium-value ones. Raising the local concurrency cap doesn't help — it just trades queueing for 429s.

## See also

- → `03-multi-agent-orchestration/04-parallel-fan-out.md` — the topology this backpressure would protect
- → `03-per-tool-circuit-breaking.md` — the retry side of the rate-limit story
- → `01-cross-turn-caching.md` — caching reduces the call volume that fan-out would amplify
- → cross-reference (when generated): `study-ai-engineering`'s rate-limit / backpressure file — the single-call mechanics this builds on
