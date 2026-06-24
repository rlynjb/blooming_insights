# Dual-write — send to stream and store

**Industry name(s):** dual-write, tee, fan-out write, capture + emit, send-to-many
**Type:** Industry standard · Project-specific (the specific two destinations are this repo's choice)

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** This pattern is one closure — `send(e: AgentEvent)` in `app/api/agent/route.ts:172-175` — that writes every emitted event to two destinations in one call. One destination is the wire (`controller.enqueue(encodeEvent(e))`), feeding the live UI. The other is an in-process buffer (`collected.push(e)`), feeding the snapshot persisted at `done`. Both writes happen for every event; both are required for the system to work; neither knows about the other.

```
  Zoom out — where the dual-write sits in the request flow

  ┌─ Agent loop ──────────────────────────────────────┐
  │  hooks fire on every step                          │
  │  onText / onToolCall / onToolResult                │
  └─────────────────────────▲─────────────────────────┘
                            │ calls send(e: AgentEvent)
  ┌─ Route handler ─────────┴─────────────────────────┐  ← we are here
  │  ★ send(e) = collected.push(e) + enqueue(encode(e)) ★ │
  │  one closure, two writes, on every call             │
  └────┬────────────────────────────────────────┬──────┘
       │ write 1: in-process buffer              │ write 2: wire
       ▼                                         ▼
  ┌─ collected[] ──────────┐               ┌─ controller (NDJSON stream) ─┐
  │  request-scoped array  │               │  enqueued bytes              │
  │  → saveInvestigation   │               │  → UI parses, renders        │
  │    on send({done})     │               │  → cache replays from same   │
  └────────────────────────┘               └─────────────────────────────┘
       │                                         │
       ▼                                         ▼
  serves the REPLAY surface                 serves the LIVE surface
  (cache, fixture, demo)                    (current request)
```

**Zoom in — narrow to the concept.** A dual-write is one call that produces two artifacts. The art is making it look like one operation to the caller — every emitter in the agent loop calls `send(e)` once, and the closure handles the fan-out. The two destinations have *very different* lifetimes: the wire bytes are gone the moment the stream closes (request-scoped); the in-process buffer survives until the route's `finally` clause and gets snapshotted on success. The dual-write is what makes the same trace serve BOTH the live UI AND the replayable snapshot — without it, you'd either lose replay (drop the push) or lose the live render (drop the enqueue). Both load-bearing.

---

## Structure pass

**Layers.** Three: the `send` closure (the dual-write itself), the two destinations (wire and buffer), and the consumers (the live client reading the wire, the cache replay reading the persisted buffer).

**Axis: state (where does this evidence live, and how long does it survive?).** Trace it across the writes. The wire write: bytes live in the stream queue until consumed, then in browser process React state for as long as the page is mounted. The buffer write: events live in `collected[]` until the route's `finally` clause; at `done`, `saveInvestigation` lifts them into the 3-rung store (mem → dev file → committed seed). Same event, two trajectories — one ephemeral and consumer-bound, one persistent and reproduction-bound.

**Seams.** Two load-bearing:

- **Closure ↔ each destination.** `send` is the join point. Internally, the dual-write happens *atomically from the closure's perspective* (no `await` between push and enqueue), so an event that lands in the buffer always also lands on the wire. Drop the symmetry and you get partial truths: an event in the snapshot but not on the live wire (broken UI), or an event on the wire but not in the snapshot (broken replay).
- **Buffer ↔ snapshot.** Crossed once per request, conditionally. `saveInvestigation(insightId, collected)` only runs on the `done` event AND when `step == null` (combined-run path only). The seam matters because it's the gate between "captured during this request" and "available for replay forever after." Crossing it persists; not crossing it (an error before `done`, or a split-step run) leaves the snapshot in request memory only.

A *cosmetic-looking but actually load-bearing* third seam: the `send` closure is defined *inside* the `start(controller)` callback. It captures `collected` and `controller` from its lexical scope. There's no `send` outside the stream's lifetime — that's by design, because both destinations only make sense inside the stream's life.

```
  Structure pass — dual-write

  ┌─ 1. LAYERS ───────────────────────────────────┐
  │  send closure · destinations · consumers       │
  └────────────────────────┬───────────────────────┘
                           │  pick the axis
  ┌─ 2. AXIS ─────────────▼────────────────────────┐
  │  state: where does this live, how long?        │
  └────────────────────────┬───────────────────────┘
                           │  trace, find flips
  ┌─ 3. SEAMS ────────────▼────────────────────────┐
  │  closure ↔ each dest: atomic from caller (LOAD)│
  │  buffer ↔ snapshot:   conditional gate (LOAD)  │
  │  closure scope = stream lifetime (cosmetic-LOAD)│
  └────────────────────────┬───────────────────────┘
                           ▼
                   Block 4 — How it works
```

Skeleton mapped. Now walk the closure, the two destinations, and the snapshot gate.

---

## How it works

**Mental model.** A dual-write is a *tee* — one input, two outputs, the caller doesn't know there are two. Same shape as Unix's `tee` (read stdin, write stdout AND a file), `WriteStream.pipe` to two destinations, or any logger that ships to multiple sinks. The kernel is two lines: append to a buffer, push to a stream. Both lines run for every event; the caller calls one function.

```
  Pattern — the tee (one call, two destinations)

           ┌───────────────┐
           │  send(e)      │   ← single closure called by every emitter
           └──────┬────────┘
                  │
        ┌─────────┴─────────┐
        │                   │
        ▼                   ▼
  ┌──────────────┐    ┌──────────────────────────────┐
  │ collected[]  │    │ controller.enqueue(          │
  │ .push(e)     │    │   encoder.encode(            │
  │              │    │     encodeEvent(e)))         │
  │ (buffer)     │    │ (wire)                       │
  └──────┬───────┘    └──────────┬───────────────────┘
         │                       │
         ▼                       ▼
   on send({done}):       UI reads NDJSON line,
   saveInvestigation       renders into TraceItem[]
   (id, collected)         (live render)
         │
         ▼
   snapshot persisted
   to 3-rung store
   (replay surface)
```

### Move 2 — walk the parts

#### The send closure — two lines that ARE the dual-write

The reader anchor: you've written a helper function that wraps a side effect (`const log = (msg) => { console.log(msg); store.push(msg) }`). Same shape. The closure has no return value — it's pure side effect — and it does the same two things in the same order on every call.

What happens: every emitter in the agent loop calls `send(e)` with one typed event. The closure runs `collected.push(e)` first (writes the buffer), then `controller.enqueue(encoder.encode(encodeEvent(e)))` (writes the wire). The order matters at one specific failure mode: if `enqueue` throws (e.g. the consumer disconnected mid-stream), the buffer write has already happened, so the snapshot is still complete from the buffer's perspective. Pushing first preserves the snapshot's integrity.

Boundary: the closure is synchronous — no `await`. This is deliberate: if there were an `await` between the two writes, the loop could observe an event in the buffer that wasn't yet on the wire. The synchronous-tee guarantee is what makes the dual-write feel atomic to the caller.

```
  Send closure — two writes, one call

  app/api/agent/route.ts:172-175

  const send = (e: AgentEvent) => {
    collected.push(e);                                   ← write 1: in-process buffer
    controller.enqueue(encoder.encode(encodeEvent(e)));  ← write 2: wire bytes
  };
                              ▲
                              │
                              └─ no return, no await, synchronous tee.
                                 Caller sees one function; closure does
                                 two writes. Push first so a failed enqueue
                                 doesn't leave the buffer inconsistent.
```

#### Destination 1 — the wire (live UI)

The reader anchor: you've used `Response.body.getReader()` to stream a fetch response. Same shape — but here the server is the producer, calling `controller.enqueue` with one NDJSON line per event. The bytes ride a `ReadableStream` until the consumer reads them or the stream closes.

What happens: `encodeEvent(e)` returns `JSON.stringify(e) + '\n'` (string). `encoder.encode(...)` converts it to `Uint8Array`. `controller.enqueue(...)` hands the bytes to the stream's internal queue. The bytes sit there until the consumer's reader pulls them. The HTTP response uses `Content-Type: application/x-ndjson` so the consumer (`useInvestigation`) reads with a streaming `TextDecoder` + `split('\n')`.

Boundary: the wire bytes are *request-scoped*. Once the response stream closes (either `controller.close()` in `finally`, or the consumer disconnects, or the function times out at `maxDuration=300`), the bytes are gone. Replay never comes from the wire — it comes from the buffer's snapshot. This is why the dual-write exists: the wire alone isn't replayable.

#### Destination 2 — the buffer (snapshot source)

The reader anchor: you've used `Array.prototype.push` to accumulate items during a process. Same shape, with one wrinkle: this buffer is the *single source of truth* for the snapshot. Whatever is in `collected[]` at `done` time is what gets persisted; if an event is missing from the buffer, it's missing from the snapshot.

What happens: `collected: AgentEvent[] = []` is declared at the top of `start(controller)`. Every `send(e)` pushes to it. When `send({type: 'done'})` runs, the next line in the route is `if (step == null) saveInvestigation(insightId!, collected)` — the array is passed by reference to `saveInvestigation`, which writes mem (always) and the dev file (in dev). The buffer's lifetime ends with the `finally { controller.close() }` after the agent run completes.

Boundary: the buffer is *not* deep-cloned at save time. `saveInvestigation` writes the same array reference to mem (no copy) and serializes via `JSON.stringify` for the dev file (which IS a copy). If anything in the route code mutated `collected[]` after the save (it doesn't — the save is the last meaningful operation), mem would see the mutation. Today the order is "send done → save → close," so the buffer is effectively frozen at save time.

```
  The two destinations — different lifetimes, different consumers

  destination 1: wire                     destination 2: buffer
  ─────────────────────────────────       ─────────────────────────────────
  controller.enqueue(bytes)               collected.push(e)
        │                                       │
        ▼                                       ▼
  HTTP response stream                    in-process array
        │                                       │
        ▼                                       ▼
  consumer: UI                            consumer: saveInvestigation
        │                                       │
        ▼                                       ▼
  React state (page mount)                3-rung store (mem→file→seed)
        │                                       │
        ▼                                       ▼
  rendered DOM                            available for replay forever
  (current request only)                  (across deploys via seed rung)

  lifetime:  request-scoped               lifetime:  scoped to the snapshot's rung
  consumer:  the user, right now          consumer:  future requests, including demo
```

#### The snapshot gate — conditional persistence

The reader anchor: you've written `if (condition) commit()` at the end of a transaction. Same shape — the snapshot is the commit, and the condition has two parts.

What happens: `app/api/agent/route.ts:251-254` calls `send({type: 'done'})` first (the dual-write fires — `done` lands in the buffer and on the wire), then evaluates `if (step == null) saveInvestigation(insightId!, collected)`. The `step == null` check is what gates the snapshot to the combined-run path; split-step runs (`step='diagnose'` or `step='recommend'`) skip the save. The other implicit gate is that this code only runs if the `try` block completed without throwing — error paths skip the save.

Boundary: the snapshot is gated on *both* contractual termination (the `done` event) AND the combined-run path (`step == null`). Drop either gate and the cache contents change. Drop the `done` gate: half-finished runs replay as if complete. Drop the `step == null` gate: split-step runs cache, which conflicts with the client's sessionStorage handoff and creates two sources of truth for the cross-step state.

```
  Snapshot gate — when the buffer becomes a snapshot

  send({type: 'done'})              ← dual-write fires (buffer + wire)
        │
        ▼
  if (step == null)                 ← gate 1: combined run only
    saveInvestigation(              ← (split steps use sessionStorage)
      insightId, collected          ← buffer passed by reference
    )
        │
        ▼  3-rung write: mem always, dev file if PERSIST

  NOT triggered:
    - send({type:'error'})          ← the catch path emits error,
                                       skips save (no half-snapshots)
    - throw before send({done})     ← finally runs, controller closes,
                                       collected[] is garbage-collected
                                       with no save
    - step='diagnose'|'recommend'   ← split-step path skips save
                                       (sessionStorage handles handoff)
```

#### Move 3 — the principle

A dual-write is a *fan-out at the source*: every event has two trajectories, and the caller doesn't know. The lesson generalises: when one stream serves both a live consumer and a future consumer (replay, audit, analytics), capture the events at the source — not after the wire. The temptation is to capture downstream ("the UI will save what it renders" or "I'll log lines I see on the wire"); downstream capture is lossy because intermediaries can drop, reorder, or transform events. Capturing at the source guarantees parity between live and replay — and the typed union (`AgentEvent`) guarantees the captured shape matches the wire shape. The two-line `send` closure is the smallest credible version of this discipline.

---

## Primary diagram

The full dual-write with the gate and both consumer paths labelled.

```
  Dual-write — full picture

  ┌─ Agent loop ────────────────────────────────────────────────┐
  │  hooksFor(agent) — onText, onToolCall, onToolResult          │
  │  fires once per agent action                                 │
  └─────────────────────────▲───────────────────────────────────┘
                            │ each hook calls send(e)
  ┌─ Send closure (app/api/agent/route.ts:172-175) ─────────────┐
  │  const send = (e: AgentEvent) => {                            │
  │    collected.push(e);                                ─────────┼─► destination 1: buffer
  │    controller.enqueue(encoder.encode(encodeEvent(e)));───────┼─► destination 2: wire
  │  };                                                           │
  └─────────────────────────────────────────────────────────────┘
            │                                            │
            │ write 1 (sync, no await)                   │ write 2 (sync, no await)
            ▼                                            ▼
  ┌─ collected: AgentEvent[] ─────┐         ┌─ controller queue (Uint8Array) ──┐
  │  request-scoped               │         │  NDJSON bytes                     │
  │  one entry per event          │         │  one line per event               │
  │  declared at start(controller)│         │  consumed by HTTP response stream │
  └─────────────▲─────────────────┘         └─────────────▲────────────────────┘
                │                                          │
                │  when send({done}) fires + step==null    │  read by consumer
                │  (route.ts:251-254)                      │  (browser, fetch.body)
                ▼                                          ▼
  ┌─ saveInvestigation ──────────────────┐    ┌─ useInvestigation (UI) ───────┐
  │  mem.set(id, collected)               │    │  TextDecoder + split('\n')   │
  │  if PERSIST: writeFileSync(dev-file)  │    │  for each line:               │
  │  → 3-rung store                        │    │    JSON.parse → handle(e)     │
  └─────────────▲─────────────────────────┘    │    switch (e.type) { … }      │
                │                              └─────────────▲─────────────────┘
                │ available for replay                       │
                │ (any future request,                       │ render: TraceItem[]
                │  including demo seed                       │         → React state
                │  if committed)                             │         → rendered DOM
                ▼                                            ▼
  REPLAY surface (cache hits this)                LIVE surface (this request)
  → 02-replay-from-snapshot-with-paced-emission   → for this user, right now
  → 03-three-rung-mem-file-seed-store
```

---

## Implementation in codebase

### Use cases

Three real moments the dual-write is doing visible work:

- **Live render during a fresh investigation.** The user clicks "investigate" on an insight that's never been cached. The route hits the live path, the agent loop emits, `send(e)` writes to both destinations. The wire bytes stream to the UI; `useInvestigation` parses lines, dispatches into React state, the `ReasoningTrace` component renders each event with a timestamp and agent badge. Simultaneously, `collected[]` is filling up server-side. At `done`, `saveInvestigation` fires and the buffer becomes a persistent snapshot. The user is none the wiser — they just saw a smooth live trace.

- **Same trace, demo replay.** Now another user (or the same user another day) requests the same `insightId`. The route's cache-first gate hits, `getCachedInvestigation` returns the captured `AgentEvent[]` from the seed rung. The replay path iterates the same events through `encodeEvent` and `enqueue`, the wire bytes look identical, the UI renders identically. The dual-write made this possible — without `collected.push(e)`, the original run would have been gone with the request.

- **Capturing the demo seed.** A developer wants a new seed for a new insight. They run dev (`NODE_ENV=development` → `PERSIST=true`), trigger a combined-run live, `send(e)` writes to both destinations, `saveInvestigation` writes mem AND `.investigation-cache.json`. They then copy the relevant entry into `lib/state/demo-investigations.json` and commit. The dev file IS the workflow's capture surface; without it, you'd have to instrument the route specifically for capture.

### Code side by side, with a line-by-line read

The closure — the two-line dual-write itself:

```
  app/api/agent/route.ts  (lines 168-175)

  const encoder = new TextEncoder();                                            ← shared encoder
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const collected: AgentEvent[] = [];                                       ← buffer declaration
      const send = (e: AgentEvent) => {                                          ← the closure
        collected.push(e);                                                       ← write 1: in-process buffer
        controller.enqueue(encoder.encode(encodeEvent(e)));                      ← write 2: wire bytes
      };
        │
        └─ two writes, one call. Synchronous (no await between them) so
           an event can't end up in the buffer without also being on the
           wire. Push first because if enqueue throws (consumer disconnect),
           the buffer is still consistent for the snapshot.
```

The hooks that call `send` from the agent loop:

```
  app/api/agent/route.ts  (lines 181-195)

  const hooksFor = (agent: AgentName) => ({
    onText: (t: string) => {
      if (t.trim()) stepFor(agent, 'thought', t);                              ← stepFor → send (reasoning_step)
    },
    onToolCall: (tc: ToolCall) =>
      send({ type: 'tool_call_start', toolName: tc.toolName, agent }),         ← span OPEN via send
    onToolResult: (tc: ToolCall) =>
      send({                                                                    ← span CLOSE via send
        type: 'tool_call_end',
        toolName: tc.toolName,
        agent,
        durationMs: tc.durationMs ?? 0,                                        ← timing measured by McpClient
        result: trunc(tc.result),
        error: tc.error,
      }),
  });
        │
        └─ every agent action → one send call → two destinations.
           hooksFor curries the agent label, so each event is correctly
           attributed. The agent loop never knows about the dual-write —
           it just calls hooks; the hooks call send; send tees.
```

The phase outputs and the terminal — same `send`, same dual-write:

```
  app/api/agent/route.ts  (lines 222-254, abbreviated)

  // STEP 2 (diagnose)
  stepFor('diagnostic', 'thought', `investigating "${inv.metric}"…`);          ← send via stepFor
  diagnosis = await diagAgent.investigate(inv, hooksFor('diagnostic'));        ← hooks call send
  send({ type: 'diagnosis', diagnosis });                                      ← phase output via send

  // STEP 3 (recommend)
  if (step !== 'diagnose') {
    stepFor('recommendation', 'thought', 'proposing actions…');
    const recommendations = await recAgent.propose(inv, diagnosis!,
                                                    hooksFor('recommendation'));
    for (const r of recommendations) send({ type: 'recommendation',            ← N recs, N send calls
                                            recommendation: r });
  }

  send({ type: 'done' });                                                      ← terminal via send
  // Only the combined run (capture) is cached to disk; the split steps are
  // handed off via the client's sessionStorage.
  if (step == null) saveInvestigation(insightId!, collected);                  ← gate + persist
        │
        └─ every emit goes through send. The buffer fills up; the wire
           emits. At done, the buffer is passed by reference to
           saveInvestigation. The step==null gate scopes the snapshot
           to the combined-run path.
```

The error path — `send` for the typed channel, `console.error` for the untyped one:

```
  app/api/agent/route.ts  (lines 255-260)

  } catch (e) {
    console.error('[agent] error:', e);                                        ← UNTYPED log (stdout)
    send({                                                                      ← TYPED channel (dual-write)
      type: 'error',
      message: `/api/agent · ${e instanceof Error ? e.message : String(e)}`,
    });
  } finally {
    controller.close();
  }
        │
        └─ the catch fires the dual-write for the typed error event —
           the buffer captures `error` and the wire emits it. NOTE:
           the snapshot is NOT saved on this path (step==null check
           is unreached after a throw). The error event lives in the
           wire and the buffer, but the buffer is garbage-collected
           without persistence. That's the "broken runs aren't
           replayable" gap named in audit.md.
```

---

## Elaborate

The dual-write pattern is the same shape as Unix's `tee` (read input, write to stdout AND a named file), Kafka's "audit log + downstream consumer" architecture (every event into the log AND into the live pipeline), and the Redux DevTools' state-snapshot-per-action discipline (every action dispatched AND captured for time-travel). The common thread: capture at the source, not downstream, so the captured shape exactly matches what the live consumer saw. Downstream capture (e.g. parsing the wire bytes back into events for storage) is lossy because intermediaries can drop, reorder, or transform events. Source capture guarantees parity.

What this pattern gets right that ad-hoc capture approaches miss: the dual-write is *synchronous*. The push and the enqueue happen in the same JS tick — no `await` between them, no chance for the loop to observe a buffer entry without a wire entry (or vice versa). Most ad-hoc capture systems use a different shape ("emit, then async-batch to a sink"), which introduces races and partial-state windows. The synchronous-tee here is what makes the snapshot's contents *exactly* match the wire's contents — same events, same order, no missing tail.

What's missing — and worth naming — is *capture on error*. The dual-write fires for the typed `error` event, but the snapshot is only persisted on `done` (gated by the route's `if (step == null) saveInvestigation`). A run that throws partway through has `error` in `collected[]` but the buffer is garbage-collected without `saveInvestigation` ever being called. A small extension would be a `try/finally` around the dual-write that *always* persists the buffer (perhaps to a separate "broken runs" rung) — at the cost of growing the cache with half-runs that need filtering on read. Today the trade-off is "no broken runs in the replay path" at the cost of "broken runs aren't replayable at all." Naming the gap is the move.

Worth a note on the closure pattern itself. The dual-write *has* to be a closure (not a top-level function) because both destinations (`collected` and `controller`) are scoped to one request's `start(controller)` callback. There's no `send` outside the stream's lifetime — and that's correct, because a `send` outside the stream couldn't do anything meaningful. The closure scope is what enforces "every emission is request-bound." If you ever wanted to share emission logic across routes (e.g. between `/api/agent` and `/api/briefing`), you'd extract a `createSender(controller, collected, encoder)` factory — but the route-local closure is simpler when there's only one route shape to support.

---

## Interview defense

**Q1. Walk me through what would break if you dropped one half of the dual-write.**

Drop `collected.push(e)`: replay dies. The wire still works (the live UI renders correctly), but `saveInvestigation` writes an empty array on `done`. Next request for the same `insightId` reads the cache, finds `[]`, and the replay loop iterates over nothing — the stream closes immediately, the UI sits at "running" forever (the `done` event was never enqueued). The seed becomes useless because there's nothing to seed with.

Drop `controller.enqueue(...)`: live UI dies. The buffer fills up correctly server-side, `saveInvestigation` writes a complete snapshot, *future* replay works fine. But the current request has nothing on the wire — the consumer's `fetch()` returns an empty body, the UI never sees an event, the page stays blank. The first run of any new investigation looks broken even though the snapshot was captured cleanly.

Both writes are load-bearing. The push serves replay (and the demo seed); the enqueue serves the user, right now.

```
  what breaks if you drop:
  ───────────────────────────────────────
  push only:    replay dies, current UI works
                → next user sees empty replay
  enqueue only: live UI dies, snapshot is fine
                → current user sees blank page
                → future users get a clean replay
  both:         the route emits nothing observable
```

**Anchor:** "name the two consumers — current user (wire) vs future users including demo (snapshot). Both load-bearing."

**Q2. Why is the dual-write synchronous (no await between the writes)?**

Two reasons. (1) **Consistency.** If there were an `await` between `collected.push(e)` and `controller.enqueue(...)`, another microtask could observe the buffer holding event N before the wire has it — or worse, the loop could continue and call `send(e+1)` and end up with events out of order on the wire while the buffer is in order. Synchronous-tee makes the dual-write atomic from the caller's perspective. (2) **Performance.** Both operations are cheap (one array push, one stream enqueue) — adding async coordination would add overhead with no benefit. The closure is a hot path (called once per event, potentially hundreds of events per investigation), so keeping it sync is correct.

The order of the writes also matters: push first, enqueue second. If `enqueue` throws (the consumer disconnected, the stream is closed, etc.), the buffer is still consistent — the event is captured even if the wire ate it. This is what preserves the snapshot's integrity in the rare disconnect case.

```
  why sync (no await):
  ──────────────────────────────────────────
  (1) consistency: caller can't observe a buffer entry without a wire entry
  (2) performance: hot path, both writes are cheap, no coord overhead
  (3) order: push first → enqueue-failure leaves buffer consistent
```

**Anchor:** "synchronous-tee = atomic from the caller; push-first = snapshot-resilient under disconnect."

---

---

## See also

- `audit.md` — the broader lens audit; this pattern is named in observability-map and reproduction-and-evidence.
- `01-ndjson-agentevent-discriminated-union.md` — the typed shape both writes preserve.
- `02-replay-from-snapshot-with-paced-emission.md` — the consumer that reads the persisted buffer.
- `03-three-rung-mem-file-seed-store.md` — where the buffer lands after `saveInvestigation`.
- `06-eval-result-paper-trail.md` (RETIRED) — the eval runner once did its own dual-write conceptually (candidate output → judge call + on-disk JSON); the seam between live-emission and post-hoc-measurement was where the offline surface attached. The runner is gone (PR #8 / 62c24d7); the pattern still teaches the source-capture-into-two-destinations discipline at offline scope.
- `.aipe/study-system-design/05-streaming-ndjson.md` — the wire half of the dual-write (system-design angle).

---
Updated: 2026-06-19 — cross-link to `06-` retained with RETIRED hint after PR #8 removed the Olist eval pipeline; this dual-write is now the only place the trace gets captured-while-emitted in the repo.
Updated: 2026-06-24 — Stripped `## Validate` block per spec v1.68.3 (the Validate primitive was removed from the per-concept template; block 10 is now `See also`).
