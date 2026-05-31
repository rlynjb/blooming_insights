# Rate limiting + backpressure

**Industry name(s):** client-side throttling / request spacing, fixed-interval rate limiting, backpressure, load shedding, concurrency-bounded queue
**Type:** Industry standard · Language-agnostic

> `McpClient.liveCall` enforces a fixed minimum interval between outbound calls — set to 1100 ms in `connectMcp` to satisfy Bloomreach's ~1 req/s/user limit — but this is serial spacing for ONE user's call chain, not a real request queue with backpressure or load-shedding when many users share the limit. (The routes do wrap the pre-stream setup — `getOrCreateSessionId` + `connectMcp` — in a try/catch that returns the real error JSON instead of a bare 500.)


---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Rate limiting + backpressure is the Provider wrappers band — the spacing logic between the Agent loop's outbound tool calls and the Tools + MCP transport that hits Bloomreach. blooming insights' `McpClient.liveCall` enforces a per-instance ~1100 ms minimum gap on every live call, so a single agent's 6–13 sequential EQL queries never bunch up at the upstream's ~1 req/s ceiling. There is no shared queue, no backpressure signal, no load-shedding — concurrent users in the same process share only the spacer.

```
  Zoom out — where the spacer sits

  ┌─ Agent loop ─────────────────────────────────────┐
  │  6–13 sequential tool calls per run               │
  └─────────────────────────┬────────────────────────┘
                            │
  ┌─ Provider wrappers ─────▼────────────────────────┐  ← we are here
  │  ★ liveCall: minIntervalMs = 1100ms spacer ★     │
  │  per-instance; serial; no queue                   │
  │                                                   │
  │  ABSENT here:                                     │
  │    - shared queue across concurrent runs          │
  │    - backpressure signal to upstream              │
  │    - load shedding under burst                    │
  └─────────────────────────┬────────────────────────┘
                            │  ~1 req/s
  ┌─ Tools + MCP transport ─▼────────────────────────┐
  │  HTTPS → Bloomreach (~1 req/s per-user quota)     │
  │  429 = Too many requests = run killed             │
  └──────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question is: how does one client stay under a hard upstream limit, and what happens when many clients share that one limit at once? Spacing one caller's calls is easy — a timestamp and a sleep. Coordinating *many* callers against a shared limit (queue? reject? shed?) is the hard part most implementations skip. blooming insights solves the first half well via `liveCall`'s minimum-gap spacer; the second half is honest gap. How it works walks the spacer, why minimum-gap differs from a token bucket, and what changes when "concurrent users" arrives.

---

## How it works

**Mental model.** Rate limiting is "don't send faster than X." There are two sub-problems. **Spacing** answers "how do I slow one caller down?" — track the last send time, wait until enough has passed. **Backpressure** answers "what do I do when more demand arrives than the limit allows?" — queue it (with a bound), reject it (load-shed), or block the producer. blooming insights implements spacing and skips backpressure, because its deployment target is one user at a time.

```
 spacing (built)                     backpressure (absent)
 ──────────────────────────         ────────────────────────────────
 one caller, serial calls            many callers, shared limit
 wait until lastCallAt + interval    queue / shed / block under burst
 timestamp + sleep                   bounded queue + rejection policy
```

The gap matters because spacing assumes calls arrive *one at a time*. The instant two call chains run concurrently against the same per-user limit, spacing alone is insufficient — and there is no queue to serialize them.

---

### Fixed-interval spacing (`liveCall`)

Every live MCP call goes through `liveCall`, which is the single place the transport is touched. Before each call it measures how long since the last one and sleeps the remainder of the minimum interval.

```
 liveCall(name, args):                          lib/mcp/client.ts L148–L163
   elapsed = Date.now() - lastCallAt            L149
   if elapsed < minIntervalMs:                  L150
     await sleep(minIntervalMs - elapsed)       L151
   result = transport.callTool(name, args)      L154
   lastCallAt = Date.now()                       L155
   return result
```

`lastCallAt` is a single instance field on `McpClient` (`lib/mcp/client.ts` L81). Every live call — whether a cache miss or a retry — updates it after the transport returns, so two back-to-back calls always have at least `minIntervalMs` between their network hits.

```
time ─────────────────────────────────────────────────────────────▶
  call A                          call B
    │                               │
    ▼                               ▼
  liveCall A                      liveCall B
  elapsed = ∞ → no wait           elapsed = 300ms < 1100
  network @ T₀                    wait 800ms ─────────┐
  lastCallAt = T₀                 network @ T₀+1100 ◀─┘
    │◀──────── 1100 ms minimum ──────────▶│  lastCallAt = T₁
```

This is a *strict* throttle: at most one call per `minIntervalMs`. Unlike a token bucket, it never lets an idle client accumulate credit to burst — every call waits its full gap.

---

### The interval — 1100 ms for Bloomreach's ~1 req/s

The interval is set where the client is constructed. The default in `McpClient` is 200 ms (`lib/mcp/client.ts` L88), but `connectMcp` overrides it to 1100 ms for the real Bloomreach connection.

```
 connectMcpInner(sessionId):                    lib/mcp/connect.ts L66–L107
   ...
   // Bloomreach rate-limits per user GLOBALLY  L81–L88 (comment)
   return {
     ok: true,
     mcp: new McpClient(new SdkTransport(client, httpErrors),
                        { minIntervalMs: 1100, retryDelayMs: 10_000,
                          retryCeilingMs: 20_000, maxRetries: 3 }),  ← L91–L96
   };
```

The 1100 ms (just over one second) is deliberate headroom over Bloomreach's documented ~1 req/s/user ceiling. Combined with the 60s tool cache (`01-llm-caching.md`), this keeps a single user's agent run under the limit: even a 13-call briefing spaces out to ~14 seconds of network time, comfortably inside the `maxDuration = 300` route budget (`app/api/agent/route.ts` L20).

```
  Bloomreach limit:  ~1 req / 1 sec / user
  spacing chosen:    1100 ms  (10% headroom)
  13-call run:       ~14.3 sec of spaced network calls < 300s budget
```

---

### What spacing does NOT do — no queue, no backpressure

Spacing assumes a *serial* caller. The agent loop is serial within one run — it awaits each tool call before issuing the next — so within a single investigation, `lastCallAt` correctly gaps every call. But there are two scenarios spacing alone does not cover.

```
 SERIAL (covered):                  CONCURRENT (NOT covered):
 run 1: A→B→C→D                     run 1: A → C → ...
   each awaits the prior            run 2:   B → D → ...
   lastCallAt gaps them             both share one McpClient.lastCallAt?
                                     → they interleave, but there is NO
                                       queue ordering them; whoever calls
                                       liveCall first wins the slot,
                                       the other waits — no fairness,
                                       no bound on how many wait
```

There is no request queue. If N call chains run concurrently against one `McpClient`, they all contend on the same `lastCallAt` field — each `liveCall` waits, but there is no ordering, no fairness, and no bound on how many can pile up waiting. Worse, each `connectMcp` call creates a *new* `McpClient` with its own `lastCallAt` (`lib/mcp/connect.ts` L91–L96), so two concurrent users get two independent spacers and can both hit Bloomreach at once — 2 req/s against a 1 req/s per-user limit if they share a quota, or simply uncoordinated load.

And there is no **load shedding**: under a burst, the system does not reject excess work or signal backpressure to the producer. It just makes everyone wait, unbounded.

---

### Current state vs future state

```
            built                          absent
            ──────────────────────         ────────────────────────────
spacing     fixed 1100ms interval           —
            (liveCall, one serial caller)
queue       —                              concurrency-bounded queue
backpressure —                             reject / block when full
shedding    —                              drop excess under burst
coordination per-instance lastCallAt        shared limiter across users
```

The absent pieces are all about *contention*: a queue to serialize concurrent callers fairly, a bound on queue depth, a backpressure signal when the bound is hit, and cross-instance coordination so N users sharing a limit do not collectively exceed it.

---

### The principle

Spacing controls one caller's rate; backpressure controls a *system's* behavior under contention. A timestamp-and-sleep throttle is the right tool when calls are serial and single-tenant — which is exactly blooming insights' deployment shape. It stops being sufficient the moment multiple callers share one limit: then you need a queue (to order them), a bound (to cap pending work), and a shedding policy (to fail fast instead of letting latency grow unbounded). The lesson generalizes: rate limiting is easy for one; the engineering is in what happens to the (N-1)th caller.

---

## Rate limiting + backpressure — diagram

This diagram spans the Agent, Service (McpClient), and Provider layers. The spacing gate is built (solid); the queue/backpressure layer is the gap (dashed).

```
  ┌────────────────────────────────────────────────────────────────────┐
  │  AGENT LAYER   lib/agents/  — serial within one run                  │
  │                                                                     │
  │  run 1: callTool A → (await) → callTool B → (await) → callTool C    │
  │  run 2 (concurrent): callTool D → ...                               │
  │       │                                                             │
  │  ╎ GAP  no queue ordering concurrent runs; no depth bound ╎          │
  └───────┼──────────────────────────────────────────────────────────────┘
          │
  ┌───────▼──────────────────────────────────────────────────────────────┐
  │  SERVICE LAYER   lib/mcp/client.ts                                    │
  │                                                                       │
  │  ┌──────────────────────────────────────────────────┐               │
  │  │  liveCall — spacing gate  (BUILT)                  │               │
  │  │  elapsed = now - lastCallAt   L149                 │               │
  │  │  elapsed < 1100 ? await (1100 - elapsed) L150–151  │               │
  │  │  lastCallAt = now   L155                           │               │
  │  └──────────────────────────────────────────────────┘               │
  │       │ minIntervalMs = 1100 set in connectMcp L91–L96               │
  │                                                                       │
  │  ╎ GAP  no backpressure: under burst everyone waits, unbounded ╎      │
  │  ╎ GAP  lastCallAt is per-instance — concurrent users uncoordinated ╎ │
  └───────┼──────────────────────────────────────────────────────────────┘
          │  NETWORK / PROVIDER BOUNDARY
  ┌───────▼──────────────────────────────────────────────────────────────┐
  │  PROVIDER   Bloomreach MCP server                                     │
  │  limit: ~1 req / 1 sec / user GLOBALLY  (connect.ts L81–L88 comment)  │
  └───────────────────────────────────────────────────────────────────────┘
```

A reader who sees only this diagram should grasp: one serial caller is correctly spaced at 1100 ms; concurrent callers and burst load have no queue, bound, or shedding.

---

## Implementation in codebase

Partially implemented — fixed-interval spacing is built; queueing, backpressure, and load-shedding are not.

### Fixed-interval inter-call spacing (Case A)

**File:** `lib/mcp/client.ts`
**Function / class:** `McpClient.liveCall`
**Line range:** L148–L163 (`elapsed` L149, sleep gate L150–L151, transport call L154, `lastCallAt = Date.now()` L155). State field `lastCallAt` at L81; default `minIntervalMs = 200` at L88.

### The 1100 ms interval for Bloomreach (Case A)

**File:** `lib/mcp/connect.ts`
**Function / class:** `connectMcpInner`
**Line range:** L66–L107; the rate-limit comment at L81–L88 and the `{ minIntervalMs: 1100, retryDelayMs: 10_000, retryCeilingMs: 20_000, maxRetries: 3 }` construction at L91–L96. The route's `maxDuration = 300` budget that this spacing must fit inside is at `app/api/agent/route.ts` L20.

Note: both routes now guard the pre-stream setup. In `app/api/agent/route.ts` L155–L165 (and the parallel `app/api/briefing/route.ts` L62–L72), `getOrCreateSessionId()` + `connectMcp()` run inside a `try/catch` that returns the real error JSON (`/api/agent setup · <message>`, status 500) instead of a bare 500 — so a setup throw (e.g. a missing `AUTH_SECRET` breaking cookie encryption in production) surfaces the actual cause. The 401 `needsAuth`/`authUrl` response follows a successful connect.

### Request queue + backpressure + load shedding (Case B — Not yet implemented)

**Not yet implemented.** blooming insights spaces a single serial caller with a timestamp-and-sleep (`liveCall`) but has no request queue, no depth bound, no backpressure signal, and no load-shedding — concurrent call chains contend on `lastCallAt` with no ordering, and each `connectMcp` builds a fresh per-instance spacer (`lib/mcp/connect.ts` L91–L96) so multiple users are uncoordinated.

Where it would live: a concurrency-bounded queue would wrap `liveCall` inside `McpClient` (`lib/mcp/client.ts` L148), serializing all callers through one ordered queue with a max depth that triggers backpressure (reject or block) when full. Cross-user coordination would require a shared limiter (a Redis/Upstash sliding window keyed per Bloomreach user) constructed in `connectMcp` (`lib/mcp/connect.ts` L91) instead of a per-instance field.

---

## Elaborate

### Where this pattern comes from

**Client-side rate limiting** enforces the limit at the caller before the server has to reject — the `debounce`/`throttle` family from frontend land, applied to backend calls. **Fixed-interval throttling** is the strictest variant: at most one call per interval, no bursts. It contrasts with the **token bucket** (allows bursts up to a bucket size, refilling at a steady rate) and the **leaky bucket** (smooths a burst into a steady output). **Backpressure** comes from flow-control theory and Reactive Streams: when a consumer cannot keep up, it signals the producer to slow or stop, rather than letting an unbounded buffer grow. **Load shedding** is the failure-mode sibling: when you cannot serve all demand, reject some of it fast rather than degrade everyone.

### The deeper principle

```
  one caller                         many callers
  ──────────────────────────         ──────────────────────────────
  spacing: timestamp + sleep         queue: order + bound the contention
  strict throttle (no burst)         backpressure: reject/block when full
  per-instance state ok              shared limiter required
  blooming insights: BUILT           blooming insights: ABSENT
```

The transition from "one" to "many" is where rate limiting becomes a systems problem. For one serial caller, a field and a sleep are provably correct. For many, you need an ordering structure (queue), a resource bound (max depth), a policy for exceeding it (shed/block), and shared state (so independent instances do not each think they are compliant while collectively violating the limit).

### Where this breaks down

Per-instance `lastCallAt` does not coordinate across instances. Each `connectMcp` builds a new `McpClient` (`lib/mcp/connect.ts` L91–L96); on serverless, each cold-started function instance has its own `lastCallAt = 0` and can fire immediately, so two instances serving one user can send 2 req/s against a 1 req/s quota. Even within one process, concurrent call chains contend on `lastCallAt` with no fairness — a later caller can win the slot a earlier one was waiting for. And there is no bound: under a burst, the number of callers parked in `await sleep(...)` grows without limit, so latency climbs unboundedly instead of the system shedding excess work and failing fast.

### What to explore next

- `p-queue` / `p-limit` — a concurrency-bounded queue that orders callers and caps in-flight work, replacing the bare `lastCallAt` field
- `Bottleneck` — a Node rate limiter with reservoir, priority, and clustering (Redis-backed) support for multi-instance coordination
- Backpressure policies — reject-when-full (429 to the caller) vs block-the-producer vs drop-oldest
- Upstash Rate Limit — a Redis sliding-window limiter keyed per Bloomreach user for cross-instance correctness

---

## Project exercises

### Concurrency-bounded queue with backpressure

- **Exercise ID:** B5.1 (adapted) — provenance C5.4 (rate-limiting).
- **What to build:** Replace the bare `lastCallAt` spacing in `McpClient` with a concurrency-bounded queue (e.g. `p-queue` with `concurrency: 1` + `interval`/`intervalCap`) that serializes ALL callers through one ordered queue, caps queue depth, and applies backpressure — rejecting (or signaling) excess work when the depth bound is hit instead of letting waiters pile up unbounded.
- **Why it earns its place:** it shows you understand the difference between spacing one caller and coordinating many, and that you have a load-shedding policy rather than unbounded latency growth.
- **Files to touch:** `lib/mcp/client.ts` (wrap `liveCall` at L148 in the queue; the `callTool` path at L113/L131 routes through it), `test/mcp/client.test.ts` (extend the spacing tests to cover concurrent callers and a full queue).
- **Done when:** N concurrent `callTool` invocations on one `McpClient` are ordered and spaced at ≥1100 ms with a bounded number in flight, and exceeding the depth bound triggers the chosen backpressure policy — verified by a test firing a burst.
- **Estimated effort:** 1–2 days.

### Cross-instance shared limiter for concurrent users

- **Exercise ID:** B5.1 (adapted) — provenance C5.4 (rate-limiting, distributed).
- **What to build:** Construct a shared limiter (Upstash/Redis sliding window keyed per Bloomreach user) in `connectMcp` so that two serverless instances serving the same user collectively stay under ~1 req/s, instead of each running an independent per-instance spacer.
- **Why it earns its place:** demonstrates you recognized that per-instance state is the failure mode under horizontal scaling and chose the correct distributed fix.
- **Files to touch:** `lib/mcp/connect.ts` (construct the shared limiter at L91 instead of the per-instance `minIntervalMs`), `lib/mcp/client.ts` (consult the shared limiter in `liveCall` L148).
- **Done when:** two `McpClient` instances for the same user, sharing the limiter, collectively respect the ~1 req/s ceiling — verified with a fake shared store in a test.
- **Estimated effort:** 1–2 days.

---

## Interview defense

### What an interviewer is really asking

"How do you rate-limit calls to an upstream?" tests whether you know the difference between throttling one caller and coordinating many under a shared limit. The weak answer is "I add a delay between calls." The strong answer names spacing as the easy half, then identifies the queue, the bound, the shedding policy, and cross-instance coordination as the parts that make it a systems problem.

### Likely questions

**[mid] How does blooming insights stay under Bloomreach's ~1 req/s limit?**

`liveCall` (`lib/mcp/client.ts` L148–L163) measures `Date.now() - lastCallAt` and sleeps the remainder of `minIntervalMs` (1100 ms, set in `connectMcp` L91–L96) before each network call, updating `lastCallAt` after. A serial call chain is gapped at ≥1100 ms.

```
  call ─► liveCall ─► wait until lastCallAt+1100 ─► network ─► lastCallAt = now
```

**[senior] Two users run investigations at the same time. Is the limit still respected?**

Not reliably. Each `connectMcp` builds a separate `McpClient` with its own `lastCallAt` (`lib/mcp/connect.ts` L91–L96), so the two spacers are independent and can both fire — 2 req/s if they share a per-user quota. And there is no queue ordering them.

```
  user A: McpClient.lastCallAt = 0 ─► fire @ T₀
  user B: McpClient.lastCallAt = 0 ─► fire @ T₀   ← uncoordinated
```

**[arch] Under a burst of concurrent callers, what happens, and what should happen?**

What happens: callers all park in `await sleep(...)` contending on one `lastCallAt` — latency grows unbounded, no fairness, no rejection. What should happen: a bounded queue orders them and, when depth is exceeded, sheds load (reject/429) so the system fails fast instead of degrading everyone.

```
  current:  burst → N waiters, unbounded latency
  desired:  burst → queue(bound) → shed excess (fail fast)
```

### The question candidates always dodge

**"Why a fixed delay instead of a token bucket?"**

For one serial caller they are functionally identical — the caller never accumulates burst credit because the agent loop awaits each call. The honest answer is that the fixed delay is the simplest thing that is correct for the deployment shape (single serial caller), and the *real* missing piece is not the bucket algorithm but the absence of a queue and backpressure for the multi-caller case. Reaching for a token bucket would be optimizing the wrong axis.

### One-line anchors

- `lib/mcp/client.ts` L148–L163 — `liveCall`, the spacing gate
- `lib/mcp/client.ts` L81 — `lastCallAt`, the per-instance spacing state
- `lib/mcp/connect.ts` L91–L96 — `minIntervalMs: 1100` for Bloomreach's ~1 req/s
- `lib/mcp/connect.ts` L81–L88 — the rate-limit comment documenting the ceiling
- `app/api/agent/route.ts` L20 — `maxDuration = 300`, the budget spacing must fit inside

---

## Validate

### Level 1 — Reconstruct

From memory, write the four lines of `liveCall`'s spacing logic (measure elapsed, compare to interval, sleep the difference, update the timestamp). Then state the two things spacing does NOT provide (queue ordering, backpressure/shedding) and why each matters under concurrency.

### Level 2 — Explain

Out loud: explain why per-instance `lastCallAt` is correct for one serial caller but breaks for two concurrent serverless instances serving the same user. What state would have to be shared to fix it?

### Level 3 — Apply

Scenario: traffic grows and multiple users investigate at once. Open `lib/mcp/connect.ts` L91–L96 — each call builds a new `McpClient`. Explain precisely why this means the ~1 req/s/user limit is no longer guaranteed, and name the minimum change (a shared per-user limiter constructed at L91) that restores it.

### Level 4 — Defend

A teammate wants to replace the fixed delay with a token bucket to "handle bursts better." Defend the position that the bucket is the wrong fix: for a single serial caller it is functionally identical to the fixed delay, and the actual gap is the absence of a queue and load-shedding for concurrent callers — cite `lib/mcp/client.ts` L148–L163 and explain what a bounded queue adds that a bucket does not.

### Quick check — code reference test

What value is `minIntervalMs` set to for the live Bloomreach connection, and on which line? (Answer: 1100 ms, `lib/mcp/connect.ts` L92, in the construction at L91–L96.)

## See also

→ 05-retry-circuit-breaker.md · → 01-llm-caching.md · → ../04-agents-and-tool-use/README.md

---
Updated: 2026-05-28 — maxDuration 60→300 (route.ts L20); re-derived liveCall refs (client.ts L148–L163, lastCallAt L81) and connectMcp construction (connect.ts L91–L96, comment L81–L88); added the pre-stream setup try/catch note (both routes return real error JSON, not a bare 500).
Updated: 2026-05-30 — Migrated to study.md v1.47 template (Phase 1+2 mechanical): removed Tradeoffs / Tech reference / Summary sections; renamed "In this codebase" → "Implementation in codebase"; moved See also to a bottom block. "Why care" preserved pending Phase 3 (Zoom out, then zoom in + LAYERS diagram) authoring.
Updated: 2026-05-30 — Phase 3 of study.md v1.47 migration: replaced "Why care" block with "Zoom out, then zoom in" (LAYERS diagram + zoom-in paragraph) per format.md.
