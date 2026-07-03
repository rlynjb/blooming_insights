# Fan-out backpressure

*Industry names: concurrency cap / bounded parallelism / upward backpressure · Industry standard*

## Zoom out

```
  Zoom out — the guard fan-out needs at the topology layer

  ┌─ SECTION C: parallel fan-out ─────────────────┐
  │  the topology (04-parallel-fan-out.md)         │
  └─────────────────┬─────────────────────────────┘
                    ▼
  ┌─ ★ FAN-OUT BACKPRESSURE (this file) ★ ─────────┐ ← we are here
  │  the guard that keeps fan-out from becoming    │
  │  a runaway supervisor                           │
  └────────────────────────────────────────────────┘
```

## Zoom in

A single LLM call has one outbound request to rate-limit. A fan-out topology fires many concurrent calls from one task — and a supervisor spawning workers can fan out faster than the provider's rate limit allows. Two mechanisms are required: **concurrency cap** (bounded parallelism) and **upward backpressure** (stop decomposing when the queue grows). This repo doesn't currently do fan-out; the guards below would be required the day it does.

## Structure pass

Layers: **supervisor** (decomposes) — **worker queue** (bounded) — **provider** (rate-limited).

Axis to hold constant: **who decides to stop spawning?**

```
  Backpressure — the axis that flips per implementation

  No backpressure:      supervisor spawns unlimited workers,
                        queue grows unbounded, provider 429s
  Concurrency cap:      workers dispatch up to N at a time,
                        rest queue (bounded)
  Upward backpressure:  supervisor SEES queue depth, stops
                        decomposing when past threshold
```

## How it works

### Move 1 — the shape

You've written `Promise.all([...])` with a concurrency cap before (`p-limit`, `p-queue`, semaphore). Same instinct at the agent altitude — plus the upward move where the *decomposer* itself has to slow down when the queue is full.

```
  Fan-out backpressure — two layers

  Supervisor decomposes → 12 worker calls at once
                       │
                       ▼
  ┌───────────────────────────────────────────────┐
  │  Concurrency limiter (semaphore)              │  ← LAYER 1: cap
  │   pop up to N concurrent (N = 4)              │
  │   queue the rest                              │
  └────────────────────┬──────────────────────────┘
                       ▼
  ┌───────────────────────────────────────────────┐
  │  Provider — receives at most N at a time      │
  └───────────────────────────────────────────────┘

  BUT — supervisor is ALSO producing more work:
  ┌───────────────────────────────────────────────┐
  │  Supervisor should observe queue depth        │  ← LAYER 2: upward
  │  When queue > threshold: STOP decomposing     │
  │  (this prevents unbounded queue growth)       │
  └───────────────────────────────────────────────┘
```

### Move 2 — the mechanics, and why they matter for this repo

**The DataSource-level spacing is the first defense.** `BloomreachDataSource` already enforces ~1 req/s spacing per session (via `minIntervalMs: 200`, though effectively serialized by Bloomreach's ~1 req/s server-side limit). This is a *single-caller* rate limit — it bounds requests from one agent instance. If fan-out spawned three concurrent aptkit agents each making tool calls, all three share the same DataSource, so all three share the ~1 req/s spacing. The DataSource layer serializes; no explicit fan-out backpressure is needed at that layer *today*.

**The Anthropic-level spacing is the second defense.** Every model call goes to Anthropic; if fan-out fired three parallel diagnostic branches, each would issue model calls independently. Anthropic's per-key rate limit (thousands of req/min at Tier 3+) is not an immediate constraint at current volume, but is finite.

**Where explicit backpressure would enter this repo.** The refactor to add parallel hypothesis testing (`03-multi-agent-orchestration/04-parallel-fan-out.md`) would be the first place:

```
  Fan-out diagnostic — the guards it needs

  ┌─ hypothetical: diagnostic supervisor ─────────────────┐
  │  generates hypotheses [A, B, C, D, E]                 │
  │  → wants to test in parallel                          │
  │                                                       │
  │  ┌── LAYER 1: concurrency cap ────────────┐            │
  │  │  semaphore, N=3                          │            │
  │  │  hypotheses A, B, C start                │            │
  │  │  D, E queue                              │            │
  │  └──────────────────────────────────────── ┘            │
  │                                                       │
  │  ┌── LAYER 2: upward backpressure ────────┐            │
  │  │  supervisor checks: is queue growing?  │            │
  │  │  yes → don't generate hypothesis F      │            │
  │  │        (runaway supervisor prevention)  │            │
  │  └──────────────────────────────────────── ┘            │
  │                                                       │
  │  Also: shared BudgetTracker check per worker           │
  └───────────────────────────────────────────────────────┘
```

**The bridge that lands the pattern.** This is `Promise.all()` with a concurrency cap — the same thing you reach for when you have 200 independent requests but don't want to open 200 connections at once. The agent version adds upward backpressure: **when the worker queue grows past a threshold, the supervisor should stop decomposing further rather than queue unbounded work**. A runaway supervisor that keeps spawning workers is the multi-agent version of an unbounded queue.

**The tradeoff that shapes N.** A low concurrency cap protects the provider but serializes the fan-out (you lose the parallel-latency win that made fan-out worth it). The breakpoint is the provider's rate limit divided by per-call duration:

```
  Concurrency cap math

  provider rate limit:      X req/s (e.g. Bloomreach ~1 req/s per user)
  per-call duration:        Y seconds average (e.g. EQL ~3s p50)
  optimal concurrency:      X × Y (Little's law: throughput = concurrency / duration)

  For Bloomreach: 1 × 3 = 3 concurrent calls maxes out the rate
  before 429s start.

  For a higher-limit provider: could go higher.
```

If the task needs more throughput than the provider allows, the answer is: **request a higher rate limit, or batch calls, or use a different provider**. Not a higher local cap — that just trades queueing for 429s.

**Anthropic-level parallelism doesn't hit this issue at current scale.** The Anthropic Messages API's rate limits (Tier 3+: many thousand req/min) don't constrain typical agent fan-out at 3-5 concurrent branches. The MCP DataSource is the tighter constraint for this repo.

### Move 3 — the principle

Fan-out backpressure has two layers: a concurrency cap at the worker level, and upward backpressure to stop the supervisor from generating unbounded work. Missing either is a production risk. The concurrency cap is standard `p-limit`-style; upward backpressure is the multi-agent-specific move that most codebases underweight.

## Primary diagram

```
  Fan-out backpressure — two layers, both required

  ┌─ Supervisor (would-be, in future fan-out) ───────────────────────┐
  │                                                                  │
  │  generates hypotheses [A, B, C, D, ...]                          │
  │                                                                  │
  │  BEFORE spawning worker N+1:                                     │
  │    check queueDepth() vs threshold                               │
  │      if queueDepth > threshold: STOP decomposing                 │
  │      → upward backpressure kicks in                              │
  │                                                                  │
  └──────────────────────┬───────────────────────────────────────────┘
                         │
                         ▼ dispatch worker
  ┌─ Concurrency limiter (semaphore, N=3) ───────────────────────────┐
  │                                                                  │
  │  pop up to N concurrent, queue the rest                          │
  │  N = provider rate limit × per-call duration (Little's law)      │
  │                                                                  │
  └──────────────────────┬───────────────────────────────────────────┘
                         │
                         ▼ dispatch to shared DataSource
  ┌─ DataSource-level spacing (already shipped) ─────────────────────┐
  │  ~1 req/s per session (BloomreachDataSource minIntervalMs=200)   │
  │  This is the last-line defense — even if higher layers misfire,  │
  │  the DataSource serializes.                                      │
  └──────────────────────┬───────────────────────────────────────────┘
                         │
                         ▼
                    Provider (rate-limited)

  Missing either backpressure layer:
    - only concurrency cap:  queue grows unbounded if supervisor
                             faster than workers can drain it
    - only upward backpressure:  no bound on concurrent work
                                 (rate-limits from provider start)
  Both are needed.
```

## Elaborate

Backpressure as a first-class pattern comes from stream processing (Reactive Streams spec, RxJS, Node.js streams) and message queues (Kafka's producer flow control, RabbitMQ's publisher confirms). The distinguishing move of the agent version is *upward* backpressure — the decomposer itself has to slow down, not just the workers. In a data-processing pipeline, the source is usually external (a Kafka topic); in a multi-agent system, the source IS the supervisor, so backpressure has to travel one hop further.

The interesting frontier is **adaptive concurrency** — the concurrency cap adjusts based on observed latency and error rates (AIMD / TCP-style congestion control at the agent layer). Netflix's concurrency-limits library implements this at HTTP-service scale; the same discipline applied to agent fan-out would let a system with fluctuating provider capacity auto-tune its parallelism.

## Interview defense

**Q: How does this repo handle fan-out backpressure?**

Today, doesn't need to — there's no fan-out. The DataSource enforces ~1 req/s spacing per session at the `BloomreachDataSource` layer (`minIntervalMs: 200`), which is the last-line defense against runaway concurrency. Even if an aptkit agent tried to fire 10 EQLs in a burst, the DataSource serializes them.

Where backpressure would be required: the day I parallelize diagnostic hypothesis testing. Two guards needed. First, a concurrency limiter (semaphore) at N ≈ provider_rate × per_call_duration — for Bloomreach ~3 concurrent. Second, upward backpressure — the diagnostic supervisor checks queue depth before spawning the next hypothesis. Without upward backpressure, a supervisor generating hypotheses faster than workers drain them creates an unbounded queue.

*Anchor visual:* the two-layer backpressure diagram above.

**Q: What's the tradeoff on the concurrency cap?**

Low cap protects the provider but serializes the fan-out — you lose the parallel-latency win that made fan-out worth building. The breakpoint is Little's law: N = provider rate × per-call duration. For Bloomreach that's ~3 concurrent. Going higher just trades queueing for 429s.

If the task needs more throughput than the provider allows, the answer is: request a higher rate limit, batch calls, or use a different provider — not a higher local cap.

**Q: What's the multi-agent-specific move most codebases miss?**

Upward backpressure. Standard concurrency caps (`p-limit`, semaphores) exist in every language, and every backend engineer knows to add one. But the supervisor generating more work faster than workers can drain it is a shape that only appears in multi-agent systems — and it's easy to miss because "the supervisor is just running once, spawning workers" hides the fact that spawning IS the unbounded work.

## See also

- **`03-multi-agent-orchestration/04-parallel-fan-out.md`** — the topology this backpressure guards.
- **`03-multi-agent-orchestration/09-coordination-failure-modes.md`** — tool-call cascade is the failure mode this prevents.
- **`03-per-tool-circuit-breaking.md`** — the sibling protection for tool-level failures.
- **`.aipe/study-ai-engineering/`** section 06 rate-limiting and backpressure for single calls.
