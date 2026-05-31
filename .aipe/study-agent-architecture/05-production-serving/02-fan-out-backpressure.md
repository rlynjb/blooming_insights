# Fan-out backpressure

**Industry name(s):** Fan-out backpressure, concurrency-bounded queue, semaphore + queue, upward backpressure, parallel topology rate control
**Type:** Industry standard · Language-agnostic

> When a topology fans out — one supervisor spawns many workers in parallel — the workers can fire concurrent tool calls faster than the provider's rate limit allows; backpressure is the discipline of bounding that concurrency with a semaphore and signaling the supervisor to stop spawning when the queue fills. blooming insights has *no fan-out*: the agents are sequential and user-gated. The 1.1s inter-call spacing in `McpClient.liveCall` (set by `minIntervalMs: 1100` in `lib/mcp/connect.ts` L92) is serial rate-limit compliance for *one* call chain, not concurrency backpressure.


---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Fan-out backpressure would sit at the Pipeline coordinator band — a semaphore + queue holding N concurrent workers, plus an upward signal that tells the supervisor to stop decomposing when the queue fills. In blooming insights, the Pipeline band is sequential (one agent at a time, user-gated), so there's nothing to fan out and no backpressure needed. What this codebase has instead is *serial spacing* in the Provider wrappers (`lib/llm/rate-limit.ts`, token bucket) — same upstream-protection intent, different shape. The diagram below shows the fan-out shape on top and blooming insights' sequential shape underneath.

```
  Zoom out — where fan-out backpressure WOULD live

  ┌─ Pipeline coordinator ──────────────────────────┐  ← we are here
  │  ★ FAN-OUT BACKPRESSURE shape (★ THIS ★, absent): │
  │    supervisor ──► [semaphore: 4 in flight]        │
  │                   [queue: bounded depth]          │
  │                   [signal upward when full]       │
  │  ── absent in blooming insights ──                │
  │                                                   │
  │  blooming insights' actual shape:                 │
  │    sequential pipeline — one agent runs at a time │
  │    no parallel workers, no queue, no backpressure │
  └─────────────────────────┬────────────────────────┘
                            │  every model call
  ┌─ Provider wrappers ─────▼────────────────────────┐
  │  lib/llm/rate-limit.ts (token-bucket spacing)    │
  │  closest analog: serial protection, not fan-out   │
  └──────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question is: when a topology can produce work faster than the system can consume it, what holds the rate? The fix has two layers — a semaphore bounds *outbound* concurrency, an upward signal stops the *inbound* producer from piling into an unbounded queue. Most implementations only get the first; without the upward signal, the queue grows silently while the supervisor keeps spawning. blooming insights' sequential topology doesn't need either yet. Below, you'll see both layers, the silent-queue failure mode, and the breakpoint where this codebase would need to add backpressure.

---

## How it works

**The mental model: a worker pool with a queue in front and a stop signal pointing back at the producer.** You've written this on the frontend whenever you've had more outbound calls than the API tolerates. The semaphore admits up to N concurrent calls; new requests queue when N is in flight; the queue has a max depth. When the queue is full, *something* needs to tell the upstream producer (the code firing requests) to stop adding more — otherwise the producer happily piles into an unbounded queue.

```
The mental model — semaphore + queue + upward signal

  supervisor (the producer)
       │
       ▼  spawns N workers
  ┌────────────────────────────────────────┐
  │ bounded queue (max depth M)            │
  │   pending workers wait here            │
  └─────────────────┬──────────────────────┘
                    ▼  semaphore admits ≤K concurrent
  ┌────────────────────────────────────────┐
  │  K worker slots                        │
  │  each calls tools, hits upstream       │
  └────────────────────────────────────────┘
                    ▲
                    │ upward signal: queue depth → M
                    │ → tell supervisor to STOP spawning
                    │
  supervisor sees "queue full" → stops decomposing further
  (multi-agent version of the producer pausing)
```

The strategy in plain English: **two bounds, not one.** The semaphore bounds outbound concurrency (what hits the upstream). The queue bound + upward signal bounds inbound production (what the supervisor adds). Without the second bound, the first one is just a bottleneck that hides an unbounded queue behind it.

### Bound #1: the semaphore — outbound concurrency cap

The technical thing: a counting semaphore (or a `Promise.all` with a concurrency cap, same idea). At most K calls in flight at any moment; new calls wait until a slot frees.

If you're coming from frontend, this is exactly the pattern you've used to keep `Promise.all` from blowing the upstream:

```
Promise.all with a concurrency cap (the canonical frontend pattern)

  async function mapWithCap<T, R>(items: T[], k: number, fn: (t: T) => Promise<R>) {
    const results: R[] = [];
    const inFlight: Set<Promise<unknown>> = new Set();
    for (const item of items) {
      if (inFlight.size >= k) await Promise.race(inFlight);
      const p = fn(item).then((r) => { results.push(r); inFlight.delete(p); });
      inFlight.add(p);
    }
    await Promise.all(inFlight);
    return results;
  }

  // semaphore = the "if (inFlight.size >= k) await" line
  // works for fetches; works for worker agents
```

The practical consequence: the upstream sees at most K concurrent calls. If the upstream's limit is M requests/sec and each call takes ~T seconds, set K ≈ M·T to stay just under the limit. Higher K → faster fan-out completion → more 429s. Lower K → no 429s → longer wall-clock time. The cap is the dial.

The condition under which it works (and doesn't): the cap protects the upstream only if there's no *other* source of outbound calls hitting the same limit. Two services sharing one upstream limit, each capping at K independently, will collectively send 2K — both think they're being polite, the upstream sees a flood. Mitigation: a shared rate-limit token bucket external to both services, or a single rate-limit-aware proxy in front of the upstream.

### Bound #2: the upward signal — producer pause

The technical thing: when the queue depth reaches its max M, the producer (the supervisor agent) gets a signal — "queue is full, stop spawning" — and pauses decomposition until the queue drains.

If you're coming from frontend, this is `useDeferredValue` or a manual "if there's a fetch in flight, don't fire another one." The upstream is sending you "I'm busy"; your producer notices and slows down.

```
Upward backpressure — the producer notices

  supervisor: "let me decompose this question..."
       │
       ▼
  ┌──────────────────────────────────┐
  │ queue depth: 80 / 100 (capacity) │   ◄── signal threshold (~80%)
  └──────────────┬───────────────────┘
                 ▼
         queue.signalFull()
                 │
                 ▼
  supervisor's decomposition loop sees the signal
       │
       └─► pause decomposition; wait for queue to drain to <50%
            (or escalate: cap the task size, return partial,
             hand off to a different system)
```

The practical consequence: a runaway supervisor that keeps decomposing into more sub-questions is the multi-agent version of an unbounded queue. Without the signal, "the supervisor decomposed into 200 sub-questions and the system is processing them slowly" is indistinguishable (in the metric dashboard) from "the system is working fine" — until you notice the queue depth never drops. The signal is what makes runaway visible at the producer's layer.

The condition under which it works: the producer has to actually act on the signal. An LLM-based supervisor needs the signal surfaced as part of its observation context — something like "queue is at 87 / 100, prefer narrower decomposition." Without that, the model spawns optimistically and the signal lands in a metric the human reads after the incident.

### Provider rate limit ÷ per-call latency — sizing the cap

The technical thing: the right concurrency cap is *the provider's stated rate limit divided by the per-call average duration*. If the upstream allows 10 requests/sec and each call averages 500 ms, the cap is 10 · 0.5 = 5 concurrent — anything higher and you'll exceed the rate limit on average.

If you're coming from frontend, this is Little's Law applied to API politeness. Concurrency × throughput inverse = arrival rate; arrival rate ≤ limit → no 429s.

```
Sizing the cap — the rule

  cap K ≈ rate_limit (req/s) × per_call_latency (s)

  examples:
    10 req/s × 0.5s per call  =  K ≈ 5    concurrent
    1 req/s × 1.0s per call   =  K ≈ 1    (effectively serial!)
    100 req/s × 0.1s per call =  K ≈ 10
```

The practical consequence — and this is the part that matters for blooming insights: if the upstream's rate limit is ~1 req/s (Bloomreach's per-user limit) and the per-call duration is order-of-seconds, the cap is *one* — there is no concurrency to bound. The right behavior reduces to "wait for the previous call to finish, plus a small spacing buffer," which is exactly serial spacing. The fan-out backpressure pattern collapses to single-call rate limiting when the cap is 1.

The condition under which the cap-of-one collapse is honest: there has to actually be only one chain at a time. The moment two chains share the upstream concurrently — two users running investigations, two agents in a topology firing tools in parallel — the cap-of-one ceases to be enough and a real semaphore is needed.

### What blooming insights has — serial spacing, not fan-out backpressure

The technical thing: the MCP client wrapper's live-call path enforces a fixed minimum interval between outbound calls. The interval is set to 1100 ms via a constructor option, satisfying Bloomreach's ~1 req/s per-user limit. There's no semaphore, no queue, no upward signal — just one timestamp (`last_call_at`) and a sleep when needed.

If you're coming from frontend, this is `debounce` for a backend caller: track the last send time, wait until enough has passed, send. It assumes one caller, serial calls, no concurrency.

```
live_call — serial spacing, not backpressure (pseudocode)

  live_call(name, args):
    elapsed = now() - last_call_at
    if elapsed < min_interval_ms:
      await sleep(min_interval_ms - elapsed)
    result = transport.call_tool(name, args)
    last_call_at = now()
    return result

  No semaphore. No queue. No upward signal.
  One caller, sequential calls, 1100 ms gap.
```

The practical consequence: a single user's investigation chain — diagnostic → recommendation, each one a shared-loop run executing 4–6 tool calls — never exceeds ~1 call/sec to Bloomreach. The agents are sequential at the topology layer (the route picks the next agent) and the tool calls within an agent are serial inside the shared loop. There's no point where K parallel calls happen, so K-bounded concurrency control isn't needed.

The condition under which this is enough: the topology stays sequential and the deployment target stays one user-investigation at a time. The instant two users investigate in parallel against the same MCP transport (or one user runs two investigations concurrently from two tabs), serial spacing is no longer sufficient — `last_call_at` is a per-instance field, and two MCP-client instances each sending one call per second is *two* calls per second from Bloomreach's perspective.

### Why "1.1s inter-call spacing is rate-limit compliance, not backpressure"

The technical distinction matters: serial spacing answers "how do I slow one caller down?" Fan-out backpressure answers "how do I bound many concurrent callers AND tell the producer to stop spawning when the queue fills?" They are the same family of problem (don't overwhelm the upstream) at two different topology shapes (one chain vs many concurrent chains).

```
Two patterns, two topologies

  Single chain (this codebase)      Parallel fan-out (not in this codebase)
  ─────────────────────────         ────────────────────────────────────
  one caller                         many concurrent callers from one task
  serial calls, one at a time        K-bounded concurrent calls
  spacing: lastCallAt + interval     semaphore: at most K in flight
  no queue (next call waits in       bounded queue: M pending
   the call site)                    upward signal: producer pauses at queue full
  pattern: fixed-interval throttle   pattern: fan-out backpressure
  RIGHT for: one user, serial chains RIGHT for: parallel topology, multi-tenant
```

The practical consequence — and this is the honest claim about this codebase: the 1.1s spacing satisfies the rate limit for the topology that exists (sequential, one user). It doesn't *implement* the fan-out backpressure pattern; it implements the simpler pattern that's correct for the simpler topology. Calling them "the same thing because both are about rate limits" obscures the place where the simpler pattern stops working.

The condition under which the absence of fan-out backpressure is correct: the topology stays sequential. Cross-reference: when (and if) the codebase moves to a parallel fan-out topology (described in `../03-multi-agent-orchestration/04-parallel-fan-out.md`), the absent semaphore + queue + upward signal become real gaps — not because the rate limit changed, but because the topology started producing concurrent calls the serial spacer can't bound.

### Phase A vs Phase B — where the semaphore would slot in

Right now the topology is sequential and serial spacing is enough. Naming what would change in Phase B clarifies what the upgrade actually buys.

```
       Phase A (now — sequential, serial spacing)
┌────────────────────────────────────────────────────────────┐
│ the route picks agents in order: monitoring → diagnostic → │
│   recommendation                                            │
│   │                                                          │
│   ▼  one chain, one call at a time                          │
│ shared agent loop ─► tool_use ─► mcp_client.call_tool       │
│                                ▼                             │
│   ┌──────────────────────────────────────┐                  │
│   │ live_call: 1100 ms spacing           │                  │
│   └──────────────────────────────────────┘                  │
│   No semaphore, no queue, no upward signal — not needed     │
└────────────────────────────────────────────────────────────┘

       Phase B (parallel fan-out, semaphore + queue + signal)
┌────────────────────────────────────────────────────────────┐
│ supervisor agent decomposes into N workers                  │
│   │                                                          │
│   ▼  fan-out, concurrent calls                              │
│ ┌──────────────────────────────────────┐                     │
│ │ bounded queue (depth ≤ M)            │                     │
│ └──────────────────┬───────────────────┘                     │
│                    ▼                                         │
│ ┌──────────────────────────────────────┐                     │
│ │ semaphore: K slots                   │                     │
│ │   (K = rate_limit × per_call_time)   │                     │
│ │   K could be 1 here → still serial   │                     │ ←
│ │   but the SHAPE is parallel          │                     │
│ └──────────────────┬───────────────────┘                     │
│                    ▲                                         │
│                    │ upward signal: queue full → supervisor  │
│                    │ pauses decomposition                    │
└────────────────────────────────────────────────────────────┘
   the upgrade isn't just "more concurrent" — it's the
   THREE pieces (semaphore, queue, upward signal) the
   serial spacing version doesn't have
```

*Phase A (now):* sequential topology, serial spacing. Correct, simple, ships.

*Phase B (parallel):* a parallel topology demands the three new pieces. Even when the rate limit forces K=1 (which would be the case here unless Bloomreach's limit changed), the *shape* is different — the semaphore + queue + signal pattern is needed to coordinate the supervisor's decomposition with the upstream's capacity. The semaphore at K=1 looks like serial spacing from the outside, but it differs in handling concurrent producers, queue depth visibility, and producer signaling.

The takeaway: **the rate-limit math determines K; the topology determines whether you need a semaphore + queue + upward signal.** Today the topology is sequential, the K-math gives K=1, and serial spacing is enough. The day the topology becomes parallel, the K-math may still give K=1 (if Bloomreach's limit hasn't moved), but the three structural pieces of backpressure become necessary because the producer is now concurrent.

This is what people mean when they say "rate limiting is easy; backpressure is hard." Rate limiting is the throttle on the wire. Backpressure is the conversation between the producer and the throttle so the producer doesn't pile work into a queue the throttle can't drain.

The full picture is below.

---

## Fan-out backpressure — diagram

```
The canonical fan-out backpressure shape — and where this codebase sits

  TASK (e.g., research a multi-part question)
       │
       ▼
  ┌─────────────────────────────────────────────────────────────────┐
  │ SUPERVISOR — decomposes into N workers                           │
  └────────────┬────────────────────────────────────────────────────┘
               ▼
  ┌─────────────────────────────────────────────────────────────────┐
  │ BOUNDED QUEUE (depth M)                                          │
  │   pending workers wait here                                       │
  │   on full: upward signal → supervisor pauses decomposition       │ ◄── ABSENT
  └────────────┬────────────────────────────────────────────────────┘     here (no
               ▼                                                            fan-out)
  ┌─────────────────────────────────────────────────────────────────┐
  │ SEMAPHORE (K slots)                                              │
  │   at most K worker tool calls in flight                          │ ◄── ABSENT
  │   K ≈ provider_rate_limit × per_call_latency                     │     here
  └────────────┬────────────────────────────────────────────────────┘
               ▼
  ┌─────────────────────────────────────────────────────────────────┐
  │ PROVIDER / UPSTREAM (Bloomreach via MCP)                         │
  │   sees at most K concurrent calls                                 │
  │   rate-limit budget: ~1 req/s per user                            │
  └─────────────────────────────────────────────────────────────────┘

  WHAT THIS CODEBASE HAS INSTEAD (sequential topology):

       Sequential agent chain (the route handler)
            │
            ▼
       ┌───────────────────────────────────────┐
       │ shared agent loop (one agent at a time)│
       │   tool_use blocks, one per turn       │
       └────────────┬──────────────────────────┘
                    ▼
       ┌───────────────────────────────────────┐
       │ mcp_client.call_tool                  │
       │   intra-run cache, then live_call     │
       └────────────┬──────────────────────────┘
                    ▼
       ┌───────────────────────────────────────┐
       │ live_call                             │
       │   elapsed = now − last_call_at        │
       │   if elapsed < 1100 ms: sleep diff    │
       │   transport.call_tool(...)            │
       │   last_call_at = now                  │
       └────────────┬──────────────────────────┘
                    ▼
       Bloomreach: at most ~1 req/s/user (serial)

  THE DIFFERENCE:
    serial spacing  : 1 call chain, slow it down — what's here
    fan-out backpr. : N parallel chains, bound concurrency + signal
                       upward to the producer — not here, not yet needed
```

---

## Implementation in codebase

**Case B — fan-out backpressure is not implemented; the topology is sequential and user-gated.** The honest sentence: the agents run one at a time in a chain (route picks the next agent), and within each agent the tool calls are serial inside `runAgentLoop` — there's no point where K parallel calls happen, so the semaphore + queue + upward signal pattern doesn't apply yet.

What exists adjacent (the simpler pattern for the simpler topology):

**Serial inter-call spacing**
**File:** `lib/mcp/client.ts`
**Function / class:** `McpClient.liveCall`
**Line range:** L148–L163 (the spacing gate at L149–L151; transport call at L154; `lastCallAt` update at L155)

The 1100 ms minimum interval between outbound MCP calls. Single-instance field `lastCallAt` (L81) tracks the last send; every live call waits the remainder of `minIntervalMs` before hitting the transport. This is fixed-interval rate-limit compliance for one serial call chain.

**Spacing configuration**
**File:** `lib/mcp/connect.ts`
**Function / class:** `connectMcp`'s `McpClient` constructor call
**Line range:** L89–L96 (the options object: `minIntervalMs: 1100`)

Where the spacing value is set. Bloomreach's per-user rate limit is ~1 req/s; 1100 ms gives a small buffer so the spacing window doesn't sit on the exact boundary.

**Sequential agent topology**
**File:** `app/api/agent/route.ts`
**Function / class:** the `GET` stream's `start()` body
**Line range:** L224–L249 (diagnostic → recommendation; the `if`-ladder that picks the next agent)

The topology that makes serial spacing sufficient. Each investigation runs monitoring → diagnostic → recommendation in order; no parallel worker agents fan out from a supervisor.

**Where the semaphore + queue would slot in (if a parallel topology shipped)**
**Sketch:** between the supervisor's worker-spawning call and the workers' tool calls. The supervisor's decomposition output would feed a queue; each worker's `runAgentLoop` would acquire a semaphore slot before its first `mcp.callTool`; the queue's full-state would surface as an observation in the supervisor's next turn.

```
shape (not full impl):
  // TODAY — serial spacing (client.ts L148–L163)
  private async liveCall(name, args) {
    const elapsed = Date.now() - this.lastCallAt;
    if (elapsed < this.minIntervalMs) await sleep(this.minIntervalMs - elapsed);
    const result = await this.transport.callTool(name, args);
    this.lastCallAt = Date.now();
    return result;
  }

  // PHASE B — fan-out backpressure (not here):
  const sem = new Semaphore(K);            // K = rate_limit * per_call_time
  const queue = new BoundedQueue(M);
  const workers = supervisor.decompose(task);
  await Promise.all(workers.map(async (w) => {
    await queue.enqueue(w);                 // upward signal on full
    await sem.acquire();
    try { return await runAgentLoop(w); } finally { sem.release(); }
  }));
```

---

## Elaborate

### Where this pattern comes from

Backpressure as a named concept comes from streaming systems work (Reactive Streams in JVM, Akka, RxJS) — the producer-consumer feedback loop that prevents a fast producer from flooding a slow consumer. The fan-out variant came into agent serving around 2023–2024 when multi-agent topologies (LangGraph's parallel branches, AutoGen's group chats, supervisor-worker frameworks) made it possible for one task to spawn many concurrent LLM/tool calls. The single-call rate limit pattern (covered in `../../study-ai-engineering/06-production-serving/04-rate-limiting-backpressure.md`) was the first half of the answer; the upward signal was the missing half production teams kept rediscovering.

### The deeper principle

Rate limiting protects the *upstream* from the downstream caller. Backpressure protects the *system* from itself — it's the conversation between the consumer (your tool dispatcher) and the producer (the agent decomposing the task) so the producer pauses when the consumer can't keep up. Without backpressure, "we have a rate limit" turns into "we have an unbounded queue behind the rate limit and the producer is happy until the queue exhausts memory or the user's session times out."

```
  rate limiting     │  throttle on the wire (don't send too fast)
  backpressure      │  signal back to the producer (don't ASK to send too fast)
  the gap           │  unbounded queue between them; the producer never learns
                     │  it's too fast
```

### Where this breaks down

Even with the full pattern, fan-out backpressure has a sharp edge: the upward signal has to be *actionable* by an LLM-based supervisor. A semaphore can pause a `Promise.all`, but pausing an LLM supervisor means surfacing the queue-full state as an observation the model reads. If the model ignores it (or doesn't see it because the context window dropped it), the signal might as well not exist. Mitigation: structural — return synthetic errors to the supervisor's decomposition calls when the queue is full, so the model sees "this sub-question couldn't be queued" and adjusts.

### What to explore next
- Parallel fan-out (multi-agent topology): `../03-multi-agent-orchestration/04-parallel-fan-out.md` → the topology this pattern exists for
- Single-call rate limiting (the simpler pattern): `../../study-ai-engineering/06-production-serving/04-rate-limiting-backpressure.md` → the spacing pattern this codebase implements
- Per-tool circuit breaking: `03-per-tool-circuit-breaking.md` → the related failure-control discipline (rate-limit vs sustained outage)

---

## Interview defense

### What an interviewer is really asking
When an interviewer asks "how does your system handle rate limits under load," they're testing whether you can name the topology you have and the rate-control pattern that matches it. The strong signal is naming the serial vs parallel split honestly and saying which one your code reflects. The weak signal is calling serial spacing "backpressure" because both involve a wait.

### Likely questions

[mid] Q: How does this system stay under Bloomreach's rate limit?

A: `McpClient.liveCall` enforces a 1100 ms minimum interval between outbound MCP calls (`lib/mcp/client.ts` L148–L163, configured in `lib/mcp/connect.ts` L92). One `lastCallAt` timestamp, one sleep when needed. The agents run sequentially — `route.ts` picks monitoring → diagnostic → recommendation in order, and `runAgentLoop` issues tool calls serially within an agent. So at any moment there's one call in flight, max one call per ~1100 ms, well under Bloomreach's ~1 req/s per-user limit.

Diagram:
```
  liveCall:
    elapsed = now − lastCallAt
    if elapsed < 1100 ms → sleep diff
    transport.callTool(...)
    lastCallAt = now
```

[senior] Q: Why isn't that fan-out backpressure?

A: Because the pattern this file describes solves a different problem — coordinating *concurrent* producers against an upstream limit. Fan-out backpressure is three pieces: a semaphore bounding K concurrent calls, a bounded queue for pending calls, and an upward signal so the producer (typically a supervisor agent) pauses when the queue fills. The serial spacer has none of those. It has one timestamp and a sleep. The reason that's enough today is the topology: sequential agents, one user-investigation at a time, no supervisor decomposing into parallel workers. The math also helps: Bloomreach's rate limit is ~1 req/s, calls take ~1s, so K = rate × time ≈ 1 — even the parallel version would have a concurrency cap of one. But the *shape* differs even with K=1: the parallel version coordinates a producer, the serial spacer just slows one chain.

Diagram:
```
   Serial spacing (here)              Fan-out backpressure (not here)
   ─────────────────────              ──────────────────────────────
   1 call chain                       N concurrent chains from 1 task
   lastCallAt + sleep                 semaphore + queue + upward signal
   shape: throttle one caller         shape: coordinate producer ↔ consumer
   right for: sequential topology     right for: parallel topology
```

[arch] Q: At 10x investigation volume, what breaks first — the rate limit or the backpressure?

A: The rate limit, but in a structural way. Today, each user investigation runs its own `McpClient` instance with its own `lastCallAt`, and Bloomreach's limit is per-user — so 10 users each running their own serial chain is fine *in isolation*. The break is when ONE user's session spawns multiple concurrent investigations (two tabs, parallel UI actions) — their two `McpClient`s each space at 1.1s but each is unaware of the other, so the user collectively sends 2 req/s and Bloomreach 429s them. The fix is either (a) move from per-instance `lastCallAt` to a shared spacer for that user (modest refactor), or (b) introduce the full fan-out backpressure pattern with a shared semaphore. The breakpoint where (b) wins is also the day a parallel topology ships — at that point the semaphore+queue+signal pattern is needed for both reasons (multi-tab AND parallel agents).

Diagram:
```
   Today, 1 user:       1 McpClient × 1.1s spacing = OK
   Today, 1 user × 2 tabs: 2 McpClients × 1.1s each = 2 req/s, breaks
   10× scale, sequential: same problem amplified
   Fix: shared spacer per user; or shared semaphore for parallel topology
```

### The question candidates always dodge
Q: You're explaining this as "we didn't need backpressure because the topology is sequential." But isn't that just dressing up the absence of a feature?

A: Honest answer: the absence isn't a bug; the *risk* is that the rationale stays unstated and the next engineer adds a parallel topology without realizing the spacer doesn't generalize. The serial spacing is genuinely correct for a sequential chain — `liveCall`'s 1.1s gap satisfies Bloomreach's rate limit when there's one call at a time. Where I'd push back on "we didn't need it" is the multi-tenant case: even today, two browser tabs from one user collapse the assumption that "one `McpClient` is enough" because two `McpClient` instances don't coordinate. So the honest version is: serial spacing is sufficient for the sequential topology with the assumption of one investigation at a time, the assumption holds in the user-gated UI, and the moment either changes — parallel topology OR concurrent investigations from the same user — the simpler pattern stops being enough and the semaphore + queue + upward signal earn their place.

Diagram:
```
   today's assumption                 day it breaks
   ──────────────────                 ─────────────────────────────────
   1 user × 1 investigation at a time 1 user × 2 tabs (concurrent)
   spacing is sufficient              OR supervisor + parallel workers
                                      → semaphore + queue + signal needed
```

### One-line anchors
- "Backpressure is two bounds: outbound concurrency (semaphore) AND inbound production (upward signal to the producer)."
- "Serial spacing is the simpler pattern for the simpler topology; it's not a smaller backpressure."
- "K ≈ rate_limit × per_call_time; for Bloomreach that's K≈1, but the structural difference between serial and backpressure is the producer signal, not the cap value."
- "Breakpoint: the day a supervisor decomposes into parallel workers (or one user runs concurrent investigations) — both make the absent semaphore real."

---

## Validate your understanding

### Level 1 — Reconstruct the diagram
Close this file. Draw fan-out backpressure: supervisor → bounded queue (upward signal) → semaphore (K slots) → upstream. Beside it, draw what this codebase has: serial agent chain → `runAgentLoop` (serial tool calls) → `liveCall` (1100 ms spacing) → Bloomreach. Mark the three pieces (semaphore, queue, signal) the canonical pattern has and this codebase doesn't.

Open the file. Compare.

✓ Pass: you drew the three canonical pieces and the upstream they protect, drew the serial spacer with `lastCallAt` and the sleep, and labelled the topology difference (sequential vs parallel)
✗ Fail: re-read How it works, wait 10 minutes, try again

### Level 2 — Explain it out loud
A colleague asks "isn't the 1.1s spacing already backpressure?" No notes. Under 90 seconds.

Checkpoints — did you:
- Name the two layers of canonical backpressure (semaphore + upward signal) and which one the serial spacer lacks?
- Distinguish "throttle one caller" (spacing) from "coordinate producer-consumer across concurrent callers" (backpressure)?
- Cite the K = rate_limit × per_call_time math and note that Bloomreach's limit gives K≈1?
- Name the topology breakpoint (parallel fan-out OR concurrent investigations from one user) where serial spacing stops being sufficient?

If you skipped any: you described it, you didn't understand it.

### Level 3 — Apply it to a new scenario
A new feature ships: a supervisor agent decomposes a question into 5 parallel sub-investigations, each running its own `runAgentLoop`. Without opening the code: which of the three backpressure pieces (semaphore, queue, signal) does the codebase need first? What value of K would you pick against Bloomreach's ~1 req/s limit, and what happens to the parallel-latency win if K=1?

Write your answer (4–6 sentences). Then open `lib/mcp/client.ts` L80–L95 (where `lastCallAt` and `minIntervalMs` live) to see what would have to change.

### Level 4 — Defend the decision you'd change
"You said today's 1.1s spacing handles one user's serial chain. If a user opens two browser tabs and runs two investigations simultaneously, what exactly breaks in `McpClient`? Would you fix it with a shared `lastCallAt` (one spacer per user across instances) or with a semaphore? Walk the cost of each."

Reference the code: point to `McpClient`'s constructor (`client.ts` L79–L95) and `liveCall` (`client.ts` L148–L163), and describe how `lastCallAt`'s per-instance scope causes the failure.

### Quick check — code reference test
Without opening any files:
- What file holds `McpClient.liveCall` and what line range?
- What's the `minIntervalMs` value used in `connectMcp`, and where is it set?
- What's the K-sizing rule for concurrency (the math)?

Open and verify. ✓ File + function names matter; line numbers drifting is fine.

## See also

→ 01-cross-turn-caching.md · → 03-per-tool-circuit-breaking.md · → `../03-multi-agent-orchestration/04-parallel-fan-out.md` · → single-call rate limiting: `../../study-ai-engineering/06-production-serving/04-rate-limiting-backpressure.md`

---
Updated: 2026-05-29 — created
Updated: 2026-05-30 — Migrated to study.md v1.47 template (Phase 1+2 mechanical): removed Tradeoffs / Tech reference / Summary sections; renamed "In this codebase" → "Implementation in codebase"; moved See also to a bottom block. "Why care" preserved pending Phase 3 (Zoom out, then zoom in + LAYERS diagram) authoring.
Updated: 2026-05-30 — Phase 3 of study.md v1.47 migration: replaced "Why care" block with "Zoom out, then zoom in" (LAYERS diagram + zoom-in paragraph) per format.md.
Updated: 2026-05-31 — Applied study.md v1.48: scrubbed "How it works" of file paths, line refs, and real-code fences; replaced with generic role labels + pseudocode per format.md. Codebase-specific anchoring lives exclusively in "Implementation in codebase".
