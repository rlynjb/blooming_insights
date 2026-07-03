# queues-streams-ordering-and-backpressure

*Client-side rate limiting · Streaming NDJSON · Backpressure · Concurrency semaphore · Industry standard*

## Zoom out — where this concept lives

There are two flow-control mechanisms in this repo, and both are
in-process. The proactive spacing gate on `BloomreachDataSource` is
client-side rate limiting against the alpha server. The NDJSON
`ReadableStream` in the routes is your outbound flow-control primitive
for the browser. And the load harness has a semaphore-based concurrency
limiter for eval runs. Everything else — real message queues, pub/sub,
event streams, consumer groups — is `not yet exercised`.

```
  Zoom out — flow-control primitives, service-layer only

  ┌─ Client layer ─────────────────────────────────────────┐
  │  fetch() reader consumes NDJSON at its own pace        │
  │  → backpressure via HTTP-level flow control            │
  └────────────────────────┬───────────────────────────────┘
                           │
  ┌─ Service layer ────────▼───────────────────────────────┐
  │  ★ THREE FLOW-CONTROL MECHANISMS ★                     │ ← we are here
  │                                                        │
  │  1. NDJSON ReadableStream out to browser (outbound)    │
  │  2. minIntervalMs=1100 spacing gate (outbound to MCP)  │
  │  3. LOAD_CONCURRENCY semaphore (eval harness only)     │
  │                                                        │
  │  no inbound queue — every request is a fresh call      │
  │  no message queue between service and providers        │
  └────────────────────────┬───────────────────────────────┘
                           │
  ┌─ Provider layer ────────────────────────────────────────┐
  │  Bloomreach — rate-limits per user, no queue offered    │
  │  Anthropic  — no queue at our layer                     │
  └────────────────────────────────────────────────────────┘
```

## Structure pass

### Layers of "who paces the work?"

```
  "who decides how fast work happens at each layer?"

  ┌───────────────────────────────────────────────┐
  │ browser reader                                 │
  │   paces via: HTTP-level backpressure           │  reader pulls;
  │              (fetch stream reader)              │  writer waits when
  │                                                │  buffer is full
  └───────────────────────────────────────────────┘
      ┌───────────────────────────────────────────────┐
      │ NDJSON writer (route handler)                 │
      │   paces via: awaiting controller.enqueue      │  yields when
      │              between events                    │  buffer is full;
      │                                                │  REPLAY_DELAY_MS in
      │                                                │  demo mode                │
      └───────────────────────────────────────────────┘
          ┌───────────────────────────────────────────┐
          │ BloomreachDataSource                       │
          │   paces via: minIntervalMs=1100 sleep     │  proactive;
          │              retry ladder wait             │  reactive;
          │                                            │  client-side rate limit
          └───────────────────────────────────────────┘
              ┌───────────────────────────────────────┐
              │ eval load harness                      │
              │   paces via: LOAD_CONCURRENCY workers │  semaphore-of-N
              │              (queue.shift() until      │  pattern
              │              exhausted)                │
              └───────────────────────────────────────┘
```

The pacing question has a different answer at every layer. That's fine
— each layer has a different bottleneck. The load-bearing insight: the
spacing gate is CLIENT-SIDE rate limiting, which is a specific kind of
backpressure ("I know you'll 429 me if I go too fast, so I'll go slower
than the ceiling").

### One axis — "what happens when the consumer is slow?"

```
  "when the downstream can't keep up, what happens?"

  ┌───────────────────────────────────────────────┐
  │ browser reads NDJSON slowly                    │
  │   → HTTP flow control: writer awaits           │  correct backpressure
  │     controller.enqueue; whole stream slows     │  via TCP
  └───────────────────────────────────────────────┘
      ┌───────────────────────────────────────────────┐
      │ Bloomreach can only take 1 req/s              │
      │   → spacing gate sleeps before each call      │  proactive; PLUS
      │   → retry ladder waits after 429              │  reactive
      └───────────────────────────────────────────────┘
          ┌───────────────────────────────────────────┐
          │ Anthropic rate-limits                     │
          │   → SDK-side retry (opaque to us)         │  handled by
          │                                            │  Anthropic SDK
          └───────────────────────────────────────────┘
              ┌───────────────────────────────────────┐
              │ eval load harness: K workers only     │
              │   → other work waits in queue          │  bounded concurrency
              └───────────────────────────────────────┘
```

Every layer has a different backpressure mechanism, and each is
correctly-sized for its bottleneck. The consumer-slow story is what
distinguishes real backpressure ("wait, don't drop") from queue overflow
("buffer full, drop"). This repo does WAIT, never DROP.

### Seams

- **`controller.enqueue(...)` seam** — every NDJSON write in the routes
  goes through this. `ReadableStream` is the flow-control primitive.
  A reader that reads slowly causes the controller's buffer to fill,
  and `enqueue` blocks the writer until the reader catches up. This is
  the TCP-level backpressure surfaced as a JavaScript primitive.

- **`this.lastCallAt` seam** in `BloomreachDataSource` — the mutable
  timestamp that IS the spacing gate's state. Every liveCall reads and
  writes it (`bloomreach-data-source.ts:191, 197, 200`). Correctness
  hinges on writing it in BOTH the success and error branches — see
  file 02 band 1.

- **The load harness's `queue.shift()`** at `eval/load.eval.ts:176-207`
  — the shared queue array is the semaphore. Workers pull from it
  until it's empty; when they can't shift anymore, they exit. Bounded
  concurrency without locks (single-threaded JS makes the shift-and-
  check pattern atomic).

## How it works

### Move 1 — the mental model: three primitives, one repo

You know how `pipe()` in shell pauses the writer when the reader can't
keep up? Same primitive across the three flow-control mechanisms here:

```
  Three flow-control primitives in this repo

  1. NDJSON stream OUT to browser
     writer ──enqueue─► buffer ──read─► reader
                       (bounded)
     when reader is slow, buffer fills, writer awaits

  2. Spacing gate BEFORE Bloomreach call
     caller ──callTool─► BloomreachDataSource
                              │
                              ▼
                         if (elapsed < 1100) sleep
                              │
                              ▼
                         transport.callTool
     client-side rate limiter: known-slow-consumer, slow yourself down

  3. Load harness worker semaphore
     [ index 0, index 1, ... , index N-1 ]  ← shared queue
                    ▲
             ┌──────┼──────┐
             │      │      │
         worker 0 worker 1 worker K-1     ← K workers pull until empty
     bounded concurrency at K without locks (JS single-thread makes
     queue.shift() atomic)
```

Different primitives, same idea: **prevent the writer from overrunning
the reader**. Each is at the right layer for its bottleneck.

### Move 2 — walk the mechanism

#### The proactive spacing gate — client-side rate limiting

Section 02 walked this from the partial-failure angle. Here it's
recast as backpressure: **the client (this app) throttles itself
because it knows the server would otherwise 429 it.**

```typescript
// lib/data-source/bloomreach-data-source.ts:190-201
private async liveCall(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  const elapsed = Date.now() - this.lastCallAt;
  if (elapsed < this.minIntervalMs) {
    await new Promise((r) => setTimeout(r, this.minIntervalMs - elapsed));
  }
  try {
    const result = await this.transport.callTool(name, args, { signal });
    this.lastCallAt = Date.now();
    return result;
  } catch (err) {
    this.lastCallAt = Date.now();
    throw new McpToolError(name, errorDetail(err), { cause: err });
  }
}
```

Bridge: this is the same shape as a token-bucket rate limiter with
bucket size = 1 and refill rate = 1 per 1100ms. Or equivalently, a
leaky bucket of the same size. The mechanism is one line of arithmetic;
the discipline is remembering to reset `lastCallAt` on both branches
(happy and error).

**Load-bearing part: the sleep is per-DataSource-instance.** Each
warm instance's `BloomreachDataSource` has its own `lastCallAt`. If two
warm instances serve the same user concurrently (rare but possible),
they can EACH send a call at t=0 without one blocking the other —
they're independent rate limiters. This is why band 3 (the retry
ladder) exists as the reactive backstop: proactive rate limiting is
best-effort when it's per-instance; the retry ladder catches what
leaked through.

#### The NDJSON stream — TCP flow control surfaced as JS

Both long routes wrap their work in a `ReadableStream` and emit events
as they come:

```typescript
// app/api/agent/route.ts:184-190 (excerpt)
const encoder = new TextEncoder();
const stream = new ReadableStream<Uint8Array>({
  async start(controller) {
    const collected: AgentEvent[] = [];
    const send = (e: AgentEvent) => {
      collected.push(e);
      controller.enqueue(encoder.encode(encodeEvent(e)));
    };
```

The `controller.enqueue(...)` is where flow control happens. The
platform gives you an internal buffer; when it fills, `enqueue`
doesn't throw — it yields. If the browser is a slow reader (say, the
user is on a bad connection), the writer pauses. When the browser
catches up, the writer resumes.

Bridge: this is exactly the same primitive as Node's
`writable.write()` returning `false` to signal backpressure. Or the
Fetch `Response.body` on the server side of edge functions. The
`ReadableStream` interface is the flow-control primitive; each
`.enqueue` is one write into the flow-controlled buffer.

**Two demo-mode-only tweaks are interesting:**

```typescript
// app/api/briefing/route.ts:24-26
// Pause between replayed demo events, so the snapshot reveals at a readable
// pace instead of all at once (matches the agent route's investigation replay).
const REPLAY_DELAY_MS = 140;
```

The demo path is deterministically paced — a `setTimeout(140ms)`
between events (`app/api/briefing/route.ts:102-104, 119`). This
turns the demo into a "reveal on human-readable timescale" not "flush
all events at once." That's not backpressure; that's UX-shaped pacing.
Named for what it is.

#### The abort signal is the "stop paying" backpressure

If the reader closes early (user navigates away), `req.signal.aborted`
flips. The route reads it at every phase boundary:

```typescript
// app/api/agent/route.ts:130-138 (excerpt, replay path)
for (const e of events) {
  // Client cancelled mid-replay — break out so we don't keep enqueuing
  // bytes into an already-closed reader.
  if (req.signal.aborted) break;
  controller.enqueue(encoder.encode(encodeEvent(e)));
  await new Promise((r) => setTimeout(r, REPLAY_DELAY_MS));
}
```

And more importantly for live paths, at
`app/api/agent/route.ts:226, 237, 248, 274, 290`:

```typescript
req.signal.throwIfAborted();
```

Bridge: this is the same idea as checking `AbortController.signal.aborted`
in a long-running loop — the check is cheap; the abort is meaningful.
The load-bearing insight: **aborting the reader propagates all the way
down through `composeSignals` to the MCP transport and to Anthropic**
(see file 02, band 2). The client's "stop" is one hop away from every
outbound call.

#### The eval load harness — bounded concurrency without a queue system

`eval/load.eval.ts:171-211` runs N investigations at concurrency K
using nothing but an array and K worker functions:

```typescript
// eval/load.eval.ts:171-208 (excerpt)
const indices = Array.from({ length: LOAD_N }, (_, i) => i);
const queue = [...indices];

async function worker(workerId: number): Promise<void> {
  while (queue.length > 0) {
    const index = queue.shift();
    if (index == null) return;
    // ... run one investigation
  }
}

const workers = Array.from({ length: LOAD_CONCURRENCY }, (_, i) => worker(i));
await Promise.all(workers);
```

Bridge: this is the "semaphore of N" pattern implemented via a shared
queue. In multi-threaded languages this needs a lock; in
single-threaded JS, `queue.shift()` returns atomically without a
race. The K workers pull from the same array until it's empty, and
`Promise.all` waits for all of them.

**Load-bearing part: `queue.shift()` returns `undefined` when the queue
is empty**, which the worker treats as "I'm done" (`if (index == null)
return`). Without that guard, the worker would loop-check
`queue.length > 0` on every iteration, race with other workers, and
occasionally re-enter the loop after the check but before the shift.
In JS the race isn't a real hazard (single-threaded), but the pattern
is defensive and correct as an idiom.

This is how you get bounded concurrency for `LOAD_N=50 LOAD_CONCURRENCY=5`
without introducing a real queue library. The tradeoff: no dead-letter
queue, no visibility beyond the worker's own console.log, no retry.
For a load harness that's fine — the point is to measure, not to
guarantee delivery.

#### What's absent: message queues, event streams, consumer groups

Zero. There is no Kafka, no Redis Streams, no BullMQ, no Cloud Tasks,
no Bloomreach webhook consumer. Every request enters the system via
an HTTP handler and exits via an HTTP response. Ordering is
per-request-in-the-agent-loop, which is trivially sequential (one
model turn at a time, one tool call at a time within a turn).

When any of this becomes load-bearing:

- **Bloomreach webhook receiver** — if we started listening to real-time
  events from Bloomreach, we'd need a durable queue on our side to
  absorb bursts and dedup. Redis Streams or Vercel KV pub/sub.
- **Background reconciliation** — if we grew persistent state and it
  needed periodic sync, we'd need a job queue and a worker. BullMQ or
  Vercel Cron.
- **Multi-user shared workspace** — fan-out to N users when one user
  triggers a briefing. Would need a pub/sub or fanout queue.

Named honestly in file 09.

### The skeleton — what backpressure reduces to

Isolate the kernel: **whichever consumer is slowest paces the whole
chain, and every layer either waits or is designed to wait.**

What breaks without each part:

- **Drop the spacing gate** — every call goes at maximum speed, ~99% of
  them get 429s, the retry ladder fires on every call, latency
  triples. Bloomreach's rate-limit budget is burned by us instead of
  saved.
- **Drop the NDJSON writer's implicit flow control** (say, by pushing
  into an unbounded array instead of `controller.enqueue`) — a slow
  reader causes unbounded memory growth in the writer's process.
  Vercel eventually kills the function.
- **Drop the load harness's semaphore** — N investigations start at
  once, all hit Anthropic and Bloomreach simultaneously, latencies
  spike, budget explodes. Or: if the underlying providers deny the
  burst, you learn nothing about steady-state behavior.
- **Drop `req.signal.throwIfAborted()`** — closed tabs continue burning
  work server-side. Cost, cost, cost.

### Optional hardening layered on top

- **`REPLAY_DELAY_MS` for demo paths** — deterministic 140-180ms
  between demo events (`agent/route.ts:103`, `briefing/route.ts:25`).
  Not backpressure; UX pacing. Named as such.
- **`AptKit prompt caching`** at `aptkit-adapters.ts:85-89` — reduces
  input tokens on repeated model calls in one investigation, which
  reduces Anthropic API cost but ALSO reduces the effective load per
  turn. Not primary flow control; secondary effect.
- **Vercel's `maxDuration = 300`** on both routes — the hard ceiling.
  A single request can't exceed 300s regardless of what's happening
  inside. Fail-safe backstop.

### Move 3 — the principle

**Backpressure IS the coordination primitive between mismatched
speeds.** When one side is 1 req/s and the other is 100 req/s, the
1 req/s side wins — either by design (spacing gate slows the fast
side) or by force (429s force the slow-down reactively). The mature
version does both, at the right layers: proactive when you can
predict the ceiling, reactive when you can't. This repo does both,
and each mechanism is at the right layer. That's the shape of a
system that has actually met partial failure, not a system built
around what a distributed-systems textbook says you need.

## Primary diagram — the flow-control picture

```
  Backpressure + flow control in one frame

  ┌─ Client (browser reader) ───────────────────────────────────────────┐
  │                                                                      │
  │   fetch(url).body.getReader()                                        │
  │       reads NDJSON at browser-controlled pace                        │
  │       ← HTTP flow control pauses the server if reader falls behind   │
  │                                                                      │
  └──────────────────────────┬──────────────────────────────────────────┘
                             │
                             ▼
  ┌─ Route handler stream ──────────────────────────────────────────────┐
  │                                                                      │
  │   ReadableStream<Uint8Array>                                         │
  │       controller.enqueue(...)  ← writer awaits when buffer is full   │
  │       REPLAY_DELAY_MS 140-180ms in demo paths only                   │
  │                                                                      │
  │       req.signal.throwIfAborted() at each phase boundary            │
  │       (reader closes → whole downstream chain stops)                │
  │                                                                      │
  └──────────────────────────┬──────────────────────────────────────────┘
                             │
                             ▼
  ┌─ Agent loop (AptKit runtime) ───────────────────────────────────────┐
  │                                                                      │
  │   loop iteration → model turn → optional tool calls → next iter     │
  │       sequential; no parallel tool dispatch                          │
  │                                                                      │
  └──────────────────────────┬──────────────────────────────────────────┘
                             │
                             ▼
  ┌─ BloomreachDataSource ──────────────────────────────────────────────┐
  │                                                                      │
  │   Band 0: cache check                                                │
  │   Band 1: spacing gate ──────► sleep(1100 - elapsed)                 │  ← proactive
  │   Band 2: transport call ────► composeSignals(req.signal, 30_000)    │
  │   Band 3: retry ladder ──────► sleep(hint + 500ms), max 3x           │  ← reactive
  │   isError guard: no cache write                                      │
  │                                                                      │
  └──────────────────────────┬──────────────────────────────────────────┘
                             │  hop B (rate-limited)
                             ▼
  ┌─ Bloomreach ────────────────────────────────────────────────────────┐
  │  ~1 req/s per user; 429 with stated window on overrun               │
  └─────────────────────────────────────────────────────────────────────┘

  What's NOT here:
    ✗ inbound message queue
    ✗ pub/sub / event streams
    ✗ consumer groups
    ✗ dead-letter queue
    ✗ ordered event log
```

## Elaborate

The three-primitive story (stream, spacing gate, semaphore) is a
common shape in the "one long route + one rate-limited external system"
architecture. Where you'd see the same shape:

- **Vercel AI SDK apps** — same NDJSON stream shape; usually a token
  bucket for the LLM API
- **RAG chatbots** — often a semaphore around vector-search + LLM to
  bound cost per request
- **Streaming data-processing** — Node streams' built-in backpressure
  is the same primitive as the ReadableStream flow control here

Where a real queue system becomes necessary:

- **When you can't afford to lose a message** — persistent queue with
  durability (Kafka, Redis Streams with persistence, SQS)
- **When consumers are separate processes** — the in-process shift-and-
  check pattern only works within one Node process; cross-process
  needs a shared queue
- **When ordering matters across users** — global ordering requires
  a single-writer log; the natural fit is an event log with partitions
  by user id

None of these are here. The audit call is honest — if the product
grew a "listen to Bloomreach webhooks" feature or a "reconcile every
customer's history nightly" feature, all three would be needed.

## Interview defense

### Q: "How do you handle backpressure in this app?"

Sketch this:

```
     3 primitives, one repo

     NDJSON stream out ──► TCP flow control (writer awaits reader)
     spacing gate       ──► client-side rate limit (proactive)
     load-harness sema  ──► bounded concurrency K
```

"Three primitives at three layers. Outbound to the browser, an NDJSON
ReadableStream — `controller.enqueue` yields when the buffer is full,
so a slow reader pauses the whole chain. Outbound to Bloomreach, a
proactive spacing gate at `minIntervalMs=1100` — we know their ceiling
is ~1 req/s, so we throttle ourselves before they 429 us. And in the
eval load harness, a semaphore-of-K via a shared queue and K workers
that shift until it's empty. Each primitive is at the right layer for
its bottleneck. No queues, no pub/sub — every request enters via HTTP
and exits via HTTP."

Anchors: `bloomreach-data-source.ts:190-201` (spacing gate),
`app/api/agent/route.ts:184-190` (ReadableStream), `eval/load.eval.ts:171-208`
(load harness).

### Q: "What's the difference between proactive and reactive backpressure?"

"Proactive is 'I know the ceiling, slow myself down before they
enforce it' — the spacing gate. Reactive is 'they told me to stop,
I stop and wait it out' — the retry ladder's parsed-hint wait. Both
exist because they defend different failure modes. Proactive prevents
429s in the common case. Reactive absorbs 429s when proactive isn't
enough (say, two warm instances share the alpha's rate-limit budget)."

### Q: "When would you introduce a real message queue?"

"Three cases:

- if we started listening to Bloomreach webhooks (durable inbound
  events, need to absorb bursts and dedup)
- if we grew background reconciliation (job queue + worker; BullMQ
  or Vercel Cron)
- if we grew multi-user shared workspaces (fan-out from one trigger
  to N users; pub/sub)

Nothing today needs it. The current shape — one user, one request,
one investigation, one long stream — doesn't have the failure modes a
queue defends against. Introducing one now would be complexity for
its own sake."

## See also

- 02-partial-failure-timeouts-and-retries.md — the spacing gate as
  proactive rate limiting; the retry ladder as reactive
- 05-replication-partitioning-and-quorums.md — no queues means no
  ordered log, no partition keys for messages
- 09-distributed-systems-red-flags-audit.md — when queues become
  load-bearing
