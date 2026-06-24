# Spacing gate as rate-limit compliance

**Industry name(s):** spacing gate · request pacing · rate-limit compliance · pre-call throttle
**Type:** Industry standard (the pattern) · Project-specific (the not-backpressure distinction)

> The five lines at `lib/mcp/client.ts:148-152` are the single most misread piece of code in the perf surface. It computes `elapsed = Date.now() - lastCallAt` and, if `elapsed < minIntervalMs` (1100ms), sleeps the difference before making the actual HTTPS call. **This looks like throttling, looks like backpressure, looks like rate limiting** — but it's none of those. It's **rate-limit compliance**: a deterministic floor that says "stay under Bloomreach's 1 req/s/user contract." It fires *every* call regardless of load (not load-conditional like backpressure). It has *no queue* (single-flight by await chain, not a multi-producer/multi-consumer system). It has *no upward signal* (it can't tell a producer to stop, because there's only one producer). The distinction matters because mistaking it for backpressure would let you ship parallel fan-out code thinking the gate would protect you — it wouldn't.

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Three different patterns live at the provider/transport layer and everyone confuses them: *rate limiting* (the server says "no more than N per period"), *throttling* (the client says "I'll send at most N per period to be a good citizen"), and *backpressure* (the consumer signals the producer to slow down when the queue fills). They look similar at first glance — all three involve some form of "wait before sending more" — but they solve different problems and require different machinery. blooming insights has the second one (client-side throttling / rate-limit compliance) and does not have the third (backpressure). The first one is enforced by Bloomreach upstream, not by us. Naming them correctly is what lets you reason about what would break under what conditions.

```
  Zoom out — where the spacing gate lives

  ┌─ Agent loop ─────────────────────────────────────┐
  │  one tool call at a time (sequential, awaited)   │
  │  no fan-out, no parallel producers                │
  └────────────────────────┬──────────────────────────┘
                           │
  ┌─ Provider/transport ──▼──────────────────────────┐
  │  McpClient.liveCall                              │
  │    ★ spacing gate (this concept) ★               │  ← we are here
  │    │  elapsed = now - lastCallAt                  │
  │    │  if elapsed < 1100ms: sleep the diff         │
  │    └─ deterministic; fires every call             │
  │                                                    │
  │  HTTPS POST → Bloomreach                         │
  │  lastCallAt = now                                 │
  └────────────────────────┬──────────────────────────┘
                           │
  ┌─ External ────────────▼──────────────────────────┐
  │  Bloomreach: 1 req/s/user GLOBAL                  │
  │  (enforces the upstream rate limit)               │
  └───────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question is: *what does the spacing gate do, what does it NOT do, and what would change if the system ever fanned out?* The answer is *it enforces a 1.1s floor between consecutive MCP calls to stay under Bloomreach's per-user GLOBAL rate limit; it does NOT have a queue, a semaphore, or an upward signal; if the system ever fans out (parallel agents), the gate alone wouldn't suffice — proper backpressure would need to be added.* Below, you'll see the gate's kernel, the four things it deliberately lacks, and the fan-out scenario that would force a real backpressure pattern to exist.

---

## Structure pass

**Layers.** The gate sits at the provider/transport band — between the agent loop above (the producer of tool calls) and the Bloomreach MCP server below (the consumer). It's invisible to the agent (which just awaits the result) and invisible to Bloomreach (which just sees calls arrive paced).

**Axis: failure mode prevented.** Hold one question constant across the candidate patterns (rate limiting, throttling, backpressure): *what specific failure mode does this prevent, and what failure mode does it NOT prevent?* Failure mode is the right axis because three patterns with the same code shape (some form of "wait before sending") solve three different problems. The wrong choice means you "fix" the wrong failure mode and ship a bug.

**Seams.** Three load-bearing.

- **S1: enforced ↔ self-enforced.** Bloomreach's rate limit is *enforced* by the server (it returns 429s); our spacing gate is *self-enforced* by the client (it sleeps). Both are about the same number (1 req/s), opposite mechanisms.
- **S2: deterministic ↔ conditional.** The gate fires *every* call (deterministic) regardless of whether the rate limit is currently saturated. Backpressure fires *only when the queue is full* (load-conditional). Different triggers, different state machines.
- **S3: single-flight ↔ multi-producer.** The gate works because there's only one producer (one agent's tool call) at a time, serialized through the await chain. Add a second producer (a parallel agent) and the gate alone doesn't suffice — there's no queue to bound, no semaphore to grant, no signal to send back.

```
  Structure pass — Spacing gate as rate-limit compliance

  ┌─ 1. LAYERS ──────────────────────────────────────┐
  │  Agent loop · Provider/transport · External       │
  │  (gate sits at provider/transport)                │
  └────────────────────────┬─────────────────────────┘
                           │  pick the axis
  ┌─ 2. AXIS ─────────────▼──────────────────────────┐
  │  failure mode prevented:                          │
  │  what does this prevent? what does it NOT?        │
  └────────────────────────┬─────────────────────────┘
                           │  trace it across candidates
  ┌─ 3. SEAMS ────────────▼──────────────────────────┐
  │  S1: enforced ↔ self-enforced                     │
  │  S2: deterministic ↔ conditional                  │
  │  S3: single-flight ↔ multi-producer   ★ load-bearing │
  └────────────────────────┬─────────────────────────┘
                           ▼
                   Block 4 — How it works
```

The skeleton is mapped — the rest walks the gate kernel, the absent backpressure machinery, and the fan-out scenario that would force it.

---

## How it works

### Move 1 — the mental model

You've debounced an `onChange` handler to fire at most once per 300ms — same shape as a spacing gate, smaller scale. The handler doesn't care if anyone's listening; it just decides "did the last fire happen long enough ago to fire again?" If not, wait. The spacing gate is exactly that pattern, applied to outgoing network calls instead of input events, with the timer set by an *external* contract (Bloomreach's rate limit) instead of a *UX* concern (avoiding handler spam). Backpressure looks similar at a glance but is fundamentally different — it involves a queue, multiple producers, and a signal *back* to the producer when the consumer can't keep up.

```
  Pattern — the spacing gate's kernel (4 parts, all minimal)

   STATE       lastCallAt: number      (timestamp of last call's completion)

   GATE        on each call:
                 elapsed = now - lastCallAt
                 if elapsed < minIntervalMs:
                   sleep(minIntervalMs - elapsed)

   ACTUAL      HTTPS POST to Bloomreach
   CALL

   UPDATE      lastCallAt = now

   what breaks if a part is missing:
     no STATE: gate has no memory; every call sleeps the full minIntervalMs
     no GATE:  no compliance; first call fast, second 200ms later hits 429
     no UPDATE: lastCallAt never advances; gate sleeps every call regardless
     no ACTUAL: nothing happens (no call made)

   what is NOT here (deliberately):
     no QUEUE       (no multi-producer to bound)
     no SEMAPHORE   (no concurrency to limit)
     no SIGNAL OUT  (no producer to tell to stop)
```

The model: **the gate is a sleep with a memory**. The memory is one number (`lastCallAt`); the sleep is bounded above by `minIntervalMs`. Nothing about it scales to multiple producers because nothing about it tries to.

---

### Move 2 — the gate kernel, the things it deliberately lacks, and the fan-out scenario

#### Move 2.1 — the kernel: sleep before the call, update after

The whole gate is five lines. Walk it once forward.

```
  Pattern — the gate, one operation at a time

   on liveCall(name, args):
     elapsed = Date.now() - this.lastCallAt          ← STATE READ
                                                      (how long since last call ended)

     if elapsed < this.minIntervalMs:                ← GATE
       await sleep(this.minIntervalMs - elapsed)     ← sleep the difference

     try:
       result = await this.transport.callTool(...)   ← ACTUAL CALL
       this.lastCallAt = Date.now()                  ← UPDATE
       return result
     catch (err):
       this.lastCallAt = Date.now()                  ← update even on error
       throw err

   if elapsed == 0 (instant after prior call): sleep 1100ms (full floor)
   if elapsed == 500ms:                       sleep 600ms (partial)
   if elapsed > 1100ms:                       sleep 0ms (prior call already paid it)
```

The boundary: **the prior call's tail can cover the spacing**. If the prior call took 2000ms (network was slow), `elapsed = 2000ms > 1100ms` and this call sleeps 0ms. The spacing isn't *additive* with network time — it's the *floor*. Only fast network responses pay the spacing cost; slow ones already covered it.

#### Move 2.2 — what the gate does NOT have (and why each absence is deliberate)

This is the load-bearing section. Four things the gate doesn't have:

```
  Pattern — what's NOT in the spacing gate (and why)

  ─── NOT a queue ─────────────────────────────────────────────────────
   why not: there's only ever one tool call in flight per agent.
            the agent loop awaits each tool result before issuing the
            next tool_use. there's no buffer of pending calls to manage.
   if added: it would be empty most of the time (premature complexity).
   when'd you add one: if you ever had multiple agents firing in parallel,
                       each producing tool calls into a shared queue.

  ─── NOT a semaphore ─────────────────────────────────────────────────
   why not: concurrency is already 1 by the await chain. there's no
            second concurrent call to grant a permit to.
   if added: it would be a 1-permit semaphore, which is just a mutex,
            which is what await already provides.
   when'd you add one: if you wanted to allow K concurrent calls (e.g. K=2
                       if Bloomreach raised the per-user limit to 2/sec).

  ─── NOT an upward signal ────────────────────────────────────────────
   why not: there's no producer to signal. the agent IS the producer,
            and it's the same call stack as the consumer (the await chain).
            it can't signal itself to slow down — it just awaits.
   if added: it would be a no-op. there's no second producer to receive it.
   when'd you add one: if a SUPERVISOR were spawning multiple agents,
                       the supervisor would want a signal: "queue's full,
                       stop spawning new agents."

  ─── NOT load-conditional ────────────────────────────────────────────
   why not: backpressure fires only when the consumer is overwhelmed.
            the spacing gate's purpose isn't to react to overwhelm — it's
            to PREVENT overwhelm by always staying under the contract.
            it fires every call, not just under stress.
   if added: it would be wrong. you can't "skip the sleep when traffic is
            low" because Bloomreach's rate limit doesn't care about your
            traffic level — it cares about request RATE.
   when'd you add one: never (for this specific concern). load-conditional
                       behavior would be for backpressure, not compliance.
```

The principle: **the things the gate lacks are exactly the things backpressure requires**. Mistaking the gate for backpressure means you ship parallel code thinking the gate will protect you — and it won't, because the gate has no concept of "multiple producers" or "consumer overwhelmed."

#### Move 2.3 — what would happen if a parallel-agent feature shipped today

This is the breaking scenario. Imagine someone ships a feature that runs the 10 monitoring categories *in parallel* sub-agents (today they run sequentially in one agent's loop). What breaks:

```
  Pattern — the fan-out scenario (what the gate doesn't catch)

   today (sequential):
     agent → tool call 1 (gate sleeps 1.1s) → execute → result
                                            ↓
                            agent → tool call 2 (gate sleeps 1.1s) → ...

     gate sees ONE call at a time. lastCallAt updates after each call.
     everything works. 6 calls × 1.1s = 6.6s of spacing per agent.


   parallel (fan-out):
     supervisor → spawn 10 sub-agents in Promise.all
                     │
                     ├─ sub-agent 1 → call 1 (gate: elapsed=∞, sleep 0ms)
                     ├─ sub-agent 2 → call 1 (gate: elapsed=0ms,
                     │                          sleep 1100ms — wait, this works?)
                     │
                     ★ HERE'S WHERE IT FAILS subtly ★
                     │
                     │   the gate IS in-process — both sub-agents share
                     │   the same McpClient instance, so both see the
                     │   same lastCallAt. They serialize through the
                     │   await sleep().
                     │
                     │   ★ but they ALL stack up at the gate at once ★
                     │
                     │   sub-agent 1's call returns at t=1.5s
                     │   sub-agent 2's call returns at t=2.6s
                     │   sub-agent 3's call returns at t=3.7s
                     │   ...
                     │   sub-agent 10's call returns at t=10.5s
                     │
                     │   meanwhile, the supervisor has 10 stacks in
                     │   the await chain, holding 10 messages arrays,
                     │   10 tool_use responses, 10 partial agent states.
                     │   nothing tells the supervisor to STOP spawning
                     │   sub-agents if it tried to spawn 100 of them.
                     │
                     ★ memory grows; nothing signals upstream ★


   what backpressure would add (the missing pieces):
     - a semaphore: only K sub-agents can be in-flight at once (K=1 or 2)
     - a bounded queue: max M waiting sub-agents (M=10 for the monitoring scan)
     - an upward signal: if queue is full, supervisor refuses to spawn
                          new sub-agents and surfaces the saturation up

   the gate alone provides NONE of these.
```

The boundary: **the gate's sleep DOES serialize the calls correctly** (because it's single-flight via await), so calls don't actually exceed 1/sec. But the supervisor has no way to know "10 sub-agents are queued at the gate; don't spawn more." Memory grows; latency spikes; if the supervisor tried to spawn 1000 sub-agents, they'd all sit in the await chain holding their state. *That* is the backpressure failure mode the gate doesn't prevent.

---

### Move 3 — the principle

**Same code shape, different semantic, different failure mode.** The lesson isn't "spacing gates are bad" or "always add backpressure" — it's "name what your code actually does." The spacing gate at `lib/mcp/client.ts:148-152` is the *correct* compliance solution for a single-flight rate-limited consumer. It would be the *wrong* backpressure solution for a fan-out consumer because it has no queue and no signal. Naming it accurately ("rate-limit compliance, not backpressure") makes the limitation visible: the day someone ships parallel agents, *they need to add the queue + semaphore + signal* — the gate alone won't catch them. The general principle: **same code shape ≠ same pattern**. Always name the failure mode the code prevents, not just the code's surface behavior.

---

## Primary diagram

The full picture — the gate kernel, what it has, what it deliberately lacks, what would change with fan-out.

```
  blooming insights — the spacing gate in context

  ┌─ TODAY: sequential, single-flight ─────────────────────────────────┐
  │                                                                     │
  │  agent loop                                                         │
  │     │  awaits tool 1                                                │
  │     ▼                                                                │
  │  McpClient.callTool                                                 │
  │     │  (cache check, MISS path)                                     │
  │     ▼                                                                │
  │  McpClient.liveCall (THE GATE — lib/mcp/client.ts:148-152)         │
  │     elapsed = now - lastCallAt                                      │
  │     if elapsed < 1100:                                              │
  │       sleep(1100 - elapsed)        ← THE FLOOR (deterministic)      │
  │     transport.callTool(...)        ← actual HTTPS                   │
  │     lastCallAt = now               ← update state                   │
  │     │                                                                │
  │     ▼                                                                │
  │  return to agent loop                                               │
  │     │  awaits tool 2 (gate fires again)                             │
  │     ▼  serialized by await chain                                    │
  │                                                                     │
  │  state: { lastCallAt: number }    ← that's it. one number.          │
  │                                                                     │
  │  ★ everything works. 6 calls × ~1.1s = ~6.6s spacing per agent ★    │
  └────────────────────────────────────────────────────────────────────┘

  ┌─ WHAT THE GATE IS NOT ─────────────────────────────────────────────┐
  │                                                                     │
  │  NOT a queue       (single-flight, no buffer of pending calls)     │
  │  NOT a semaphore   (concurrency is already 1 via await)             │
  │  NOT an upward     (no producer to signal — agent IS producer)     │
  │     signal                                                          │
  │  NOT load-         (fires every call, regardless of load)           │
  │     conditional                                                     │
  └────────────────────────────────────────────────────────────────────┘

  ┌─ TOMORROW: parallel fan-out (the failure mode) ───────────────────┐
  │                                                                     │
  │  supervisor                                                         │
  │     │  Promise.all([ sub-agent 1, sub-agent 2, ..., sub-agent N ]) │
  │     ▼                                                                │
  │  sub-agents (all in flight at once, sharing one McpClient)         │
  │     │                                                                │
  │     │  ALL call McpClient.callTool concurrently                     │
  │     │  all serialize at the gate (await sleep)                      │
  │     │                                                                │
  │     ▼                                                                │
  │  gate processes one at a time, lastCallAt updates serially         │
  │  ★ calls still correctly spaced ★                                   │
  │                                                                     │
  │  BUT:                                                               │
  │  ★ memory grows: N stacks holding N agent states                    │
  │  ★ no signal back to supervisor: "queue's full, stop spawning"     │
  │  ★ latency = N × 1.1s for the last sub-agent's first call          │
  │                                                                     │
  │  what BACKPRESSURE would add:                                       │
  │  - semaphore: K concurrent permits (K=1 or 2)                       │
  │  - bounded queue: max M waiting (M=10 for the scan)                 │
  │  - upward signal: if queue full, supervisor refuses to spawn        │
  │                                                                     │
  │  cross-ref: study-agent-architecture/05-production-serving/        │
  │             02-fan-out-backpressure.md                              │
  └────────────────────────────────────────────────────────────────────┘
```

---

## Implementation in codebase

### Use cases — where the spacing gate appears (and doesn't)

- **Every MCP call.** Every `McpClient.callTool` invocation that misses the cache routes through `liveCall`, which runs the gate. Bootstrap chain (4-6 calls), agent loops (4-6 calls per agent × 2 agents per investigation), debug routes — all of them.
- **NOT for cache hits.** A cache hit at `lib/mcp/client.ts:102-110` short-circuits before `liveCall` is reached. The gate's sleep is skipped entirely.
- **NOT for Anthropic calls.** The gate is McpClient-specific. Anthropic calls (`anthropic.messages.create`) have no spacing — Anthropic's per-key rate limit is much higher and isn't observed at this scale.
- **Not yet exercised: a fan-out producer.** No code in the codebase spawns parallel agents; if it did, the gate alone wouldn't be enough.

### Code side by side

**The gate itself — five lines.**

```
  lib/mcp/client.ts  (lines 148–163)

  private async liveCall(name: string, args: Record<string, unknown>): Promise<unknown> {
    const elapsed = Date.now() - this.lastCallAt;             ← STATE READ
    if (elapsed < this.minIntervalMs) {                       ← GATE check
      await new Promise((r) => setTimeout(r, this.minIntervalMs - elapsed));  ← SLEEP
    }
    try {
      const result = await this.transport.callTool(name, args);  ← ACTUAL CALL
      this.lastCallAt = Date.now();                              ← UPDATE
      return result;
    } catch (err) {
      this.lastCallAt = Date.now();                              ← update even on error
      throw err;
    }
  }
        │
        └─ FIVE LINES of logic (the elapsed-check, the sleep, the call, the update).
           NOTHING ELSE. No queue, no semaphore, no signal, no state beyond
           one timestamp. That's the entire compliance mechanism — and that's
           exactly what makes it NOT backpressure.
```

**Where the gate's interval is configured — outside the McpClient.**

```
  lib/mcp/connect.ts  (line 92)

  const mcp = new McpClient(transport, {
    minIntervalMs: 1100,           ← 1000ms (the contract) + 100ms (headroom)
    maxRetries: 3,
    retryDelayMs: 1000,
    retryCeilingMs: 20_000,
  });
        │
        └─ 1100ms = 1000ms (Bloomreach's "1 req/s" contract) + 100ms (slack
           for clock skew, network jitter). The exact number is set by the
           upstream contract, not by performance considerations on our end.
           If Bloomreach raised the per-user limit to 2/sec, this would drop
           to 550ms; if it dropped to 1/2sec, this would rise to 2100ms.
```

**The agent loop's await chain — the reason "no queue" works today.**

```
  lib/agents/base.ts  (lines 100–150-ish, abbreviated)

  // ... inside the loop ...
  const res = await this.anthropic.messages.create(params);   ← await Anthropic
  // ... parse tool_use blocks ...
  for (const block of res.content) {
    if (block.type === 'tool_use') {
      const { result, durationMs, fromCache } =
        await this.mcp.callTool(block.name, block.input);     ← await each tool call
      // ... append to tool_results ...
    }
  }
  // ... append assistant + tool_results to messages, loop continues ...
        │
        └─ NOTICE: every tool call is `await`ed. The agent doesn't fire two
           tool calls concurrently — Claude returns one or more tool_use
           blocks, the loop iterates them one at a time. So the spacing gate
           sees ONE call at a time. There is no buffer of pending calls
           because the agent doesn't produce them in parallel. The serial
           await chain IS the queue, and it's depth-1 by construction.
```

**Why the gate is in-process (and what that means for cross-process).**

```
  // ── Important nuance, not in the source — worth naming ──
  //
  // McpClient is instantiated per request via lib/mcp/connect.ts:71.
  // Two CONCURRENT requests on the same Vercel function instance can
  // share the SAME process but they get DIFFERENT McpClient instances.
  // So the spacing gate is per-McpClient-instance, NOT per-process.
  //
  // Cross-instance (different Vercel functions, different processes):
  // each instance has its own gate, but each instance also has its
  // own user's OAuth token, so Bloomreach sees them as different
  // request streams. The PER-USER rate limit on Bloomreach's side
  // is what actually enforces compliance across instances.
  //
  // Net effect: the gate is correct for ONE request to one user;
  // multiple concurrent requests to DIFFERENT users have separate gates
  // (correct); multiple concurrent requests to the SAME user (unlikely
  // but possible) would each have their own gate — both would think
  // "elapsed is large" and both would try to call. The retry loop
  // (lib/mcp/client.ts:121-132) catches the 429 from Bloomreach.
```

---

## Elaborate

**Where this pattern comes from.** Client-side rate-limit compliance shows up in every SDK that talks to a rate-limited API — AWS SDK's adaptive retry, Google API client's per-quota throttle, GitHub's API client's `X-RateLimit-Remaining`-aware throttle. The simplest form is exactly this codebase's: a "min interval between calls" floor, enforced with a sleep. The more complex forms (token bucket, leaky bucket, sliding window counter) add memory of recent calls and budget over windows — but for a flat 1-per-second contract, a min-interval floor is the minimum viable mechanism.

**Why "compliance" is the right word and "throttling" is misleading.** Throttling usually implies a *limiting* function: "drop calls beyond N per second." Compliance is *preventive*: "never issue more than N per second." The spacing gate doesn't drop anything; it just paces. Throttling would also typically be reactive (you throttle in response to seeing 429s); compliance is proactive (you never see the 429 because you stayed under the limit). The distinction matters when reasoning about edge cases — a throttling system that loses its rate-limit state (e.g. after a process restart) might overshoot; a compliance system just paces deterministically from the next call.

**Why the not-backpressure framing is load-bearing.** The most common mistake in production systems is shipping a "throttle" and assuming it solves the consumer-overrun problem. It doesn't. Throttling protects the *consumer* (the server you're calling); backpressure protects the *system as a whole* (the producer that would otherwise pile work into an unbounded queue). The spacing gate protects Bloomreach from being overrun; it does NOT protect blooming insights from piling up agent state if the supervisor spawned 1000 sub-agents. Recognizing this distinction is what lets you know *when to reach for backpressure*: not today, because we have no fan-out; tomorrow, the moment a parallel-agent feature ships.

**Connection to adjacent concepts.** `02-ttl-cache-with-no-cache-on-error.md` covers the cache that lets you skip the gate's sleep on a hit. `01-300s-vercel-budget-as-hard-ceiling.md` covers the route ceiling that the gate's spacing contributes to. `study-agent-architecture/05-production-serving/02-fan-out-backpressure.md` is the explicit cross-link for "what backpressure would look like if it had to exist here." `study-distributed-systems` (sibling guide) covers the upstream-rate-limit-as-contract concept more generally.

---

## Interview defense

### Q: The spacing gate sleeps 1.1s before every MCP call. Is that backpressure?

**Answer:** No. Same code shape (sleep before send), opposite semantic. Backpressure has three things the spacing gate doesn't: a queue with bounded depth, a semaphore granting K concurrent permits, and an upward signal telling the producer to stop when the queue fills. The spacing gate has none of those — it's single-flight (no queue), runs one-at-a-time via the await chain (no semaphore needed), and fires every call deterministically (no signal logic). Its purpose is *rate-limit compliance* — stay under Bloomreach's 1 req/s/user contract by spacing out outgoing calls. Backpressure's purpose is *consumer protection* — bound memory and dropped work when producers are faster than consumers. blooming insights has the first concern; it doesn't have the second, because there's no fan-out and no second producer. The day someone ships parallel monitoring agents, backpressure becomes a separate problem the gate doesn't solve.

```
  spacing gate vs backpressure — at a glance

  SPACING GATE (we have)         BACKPRESSURE (we don't need yet)
  ─────────────────────          ──────────────────────────────
  await sleep(N - elapsed)        await sleep + semaphore + queue
  purpose: obey rate limit        purpose: bound queue + signal producer
  trigger: every call             trigger: when queue depth → cap
  queue:   none                   queue:   bounded (depth M)
  signal:  none                   signal:  yes (stop spawning)
  needs:   rate limit             needs:   fan-out topology
```

### Q: What does the spacing gate actually do, mechanically? Walk me through it.

**Answer:** Five lines at `lib/mcp/client.ts:148-152`. State: one timestamp `lastCallAt` per McpClient instance. On each call: compute `elapsed = Date.now() - lastCallAt`; if `elapsed < minIntervalMs` (1100ms), sleep the difference; then make the actual HTTPS POST to Bloomreach; then update `lastCallAt = Date.now()`. The 1100ms = 1000ms (Bloomreach's contract) + 100ms (slack). The interesting case is when the prior call was slow: if `elapsed = 2000ms`, the sleep is 0ms (the prior call's tail already paid the spacing). The other interesting case is back-to-back calls: if `elapsed = 0ms`, sleep is the full 1100ms. The gate is one timestamp and one sleep — that's it. It's not stateful beyond that.

### Q: Suppose someone ships a feature where the monitoring agent fans out 10 categories in parallel. What changes?

**Answer:** Three things. (1) The spacing gate still *correctly serializes* the calls — because it's in-process and the `await sleep()` chain forces one call at a time — so Bloomreach still sees ≤1 req/s. So far so good. (2) BUT the supervisor (the code spawning the 10 sub-agents) has no way to know "you have 10 sub-agents queued at the gate; don't spawn more." If it tried to spawn 1000 sub-agents, they'd all pile up in the await chain holding their state — memory grows, nothing signals back to stop. (3) Per-sub-agent latency degrades: the 10th sub-agent waits ~10 × 1.1s = ~11s just for its first call (because the gate serializes them). The fix is real backpressure: a semaphore limiting concurrent in-flight calls, a bounded queue limiting depth, and an upward signal back to the supervisor when the queue is full. The gate alone wouldn't be enough — naming what it actually does (compliance, not backpressure) is what tells you that.

---

---

## See also

- `audit.md` — the lens-level findings, including this pattern in `caching-batching-and-backpressure`
- `01-300s-vercel-budget-as-hard-ceiling.md` — the budget the gate's spacing contributes to
- `02-ttl-cache-with-no-cache-on-error.md` — the cache that skips the gate entirely on a hit
- `04-synthesize-as-cost-concentration.md` — the unmeasured cost line that the gate doesn't help with
- `.aipe/study-agent-architecture/05-production-serving/02-fan-out-backpressure.md` — the topology that would force backpressure to exist
Updated: 2026-06-24 — Stripped `## Validate` block per spec v1.68.3 (the Validate primitive was removed from the per-concept template; block 10 is now `See also`).
