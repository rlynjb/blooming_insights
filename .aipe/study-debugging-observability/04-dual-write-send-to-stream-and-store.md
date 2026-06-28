# Dual-write: send to stream and store

**Industry name(s):** tee / fan-out / dual-write; the streaming-data analogue of `tee(1)`. Some call it *write-through observability* or *interceptor logging*. **Type:** Industry standard pattern, language-agnostic.

## Zoom out — where this concept lives

The route's `send` function does two things at once: enqueue bytes into the live HTTP stream *and* push the event into an in-memory array that will be persisted on `done`. One function call, two destinations. That's the seam that keeps the live wire and the saved snapshot in lockstep — without it, the replay would drift from the live experience.

```
  Zoom out — dual-write at the service layer, fanning to wire + storage

  ┌─ UI layer ─────────────────────────────────────────────────┐
  │  client reads NDJSON stream live                            │
  └────────────────────▲────────────────────────────────────────┘
                       │ encoded bytes
  ┌─ Service layer ────┼──────────────────────────────────────────┐
  │   ┌────────────────────────────────────────┐                  │
  │   │ send(e: AgentEvent) — dual writer       │                  │
  │   │                                          │                  │
  │   │   ┌─────────────────────────────────┐    │                  │
  │   │   │ ★ collected.push(e)             │ ──►│─► saved on 'done' │
  │   │   ╞══════════════════════════════════╡    │                  │
  │   │   │ ★ controller.enqueue(            │ ──►│─► live wire     │
  │   │   │     encoder.encode(encodeEvent(e)))│  │                  │
  │   │   └─────────────────────────────────┘    │                  │
  │   └────────────────────────────────────────┘                  │
  │                       │                                       │
  └───────────────────────┼───────────────────────────────────────┘
                          │ on 'done': saveInvestigation(id, collected)
                          ▼
  ┌─ Storage layer ──────────────────────────────────────────────┐
  │  in-memory Map → .investigation-cache.json (dev only)         │
  └───────────────────────────────────────────────────────────────┘
```

**Zoom in.** `send` is a 4-line closure with two writes: array-push first, then stream-enqueue. Every emit site in the route calls `send` instead of touching the controller directly — so the array always sees what the wire sees, in the same order, no exceptions. On `done`, the array is handed to `saveInvestigation` and becomes the next demo replay.

The question this pattern answers: *"how do we guarantee the saved snapshot is byte-equivalent to the live stream, without running the agent twice?"*

## Structure pass

**Layers.** One closure (the `send` function) sitting between the agent loop and two sinks (the HTTP wire + the in-memory array). The closure is the *only* writer that touches the stream from inside the route — every emit site (the four agent hooks, the route's direct sends, the `done` and `error` events) calls `send`.

**Axis: invariant ordering.** Hold *"are the two sinks always in lockstep?"* constant.

```
  Trace "are the wire and the store in the same order?" across emit sites

  emit site                          wire receives    store receives
  ─────────                          ─────────────    ──────────────
  diagnostic onText hook  → send →   yes (immediately) yes (synchronous push first)
  diagnostic onToolCall   → send →   yes              yes
  recommendation onText   → send →   yes              yes
  step-by-step stepFor()  → send →   yes              yes
  diagnosis event         → send →   yes              yes
  done event              → send →   yes              yes
                                     
                                     ▲                ▲
                                     │                │
                          same closure → both happen in the same tick,
                                          push BEFORE enqueue
```

Push-before-enqueue is the *invariant* — it means a writer error inside the controller (back-pressure, closed stream) won't leave the array short an event relative to the wire. The opposite order would: enqueue first, then push — and an enqueue throw skips the push.

**Seams.**

1. **Closure ↔ wire.** Contract: `controller.enqueue` accepts encoded bytes. Break it (close the controller mid-stream) → `enqueue` throws; the array has the event but the wire didn't. Detection: surrounding try/catch in the stream-start function.
2. **Closure ↔ store.** Contract: `collected.push` always succeeds (JS arrays are unbounded). No failure mode worth handling.
3. **Closure ↔ caller (the agent loop).** Contract: every emit site calls `send`, never the controller directly. Break it (one site forgets and calls `controller.enqueue` directly) → that event goes to the wire but NOT to the store; replay loses it. Discipline: code review + the fact that `controller` is shadowed inside the closure scope (not exposed to the hooks).

Skeleton mapped.

## How it works

### Move 1 — the mental model

You've used `console.log` and watched it print to the terminal *and* to the browser DevTools. That's a tee: one source, two sinks, in lockstep. The Unix `tee(1)` command does the same for pipelines (`some_cmd | tee out.log | next_cmd` — `next_cmd` sees the same bytes that landed in `out.log`).

This route is the same idea inside one function: every event goes to the wire (the next stage of the pipeline, the client) AND to the array (the log file). The trick is that **both writes happen at the same call site** — there's no "log on completion" separate pass, no "send to a logger queue and hope it flushes." Push-then-enqueue, atomically, every time.

```
  The pattern — one source, two sinks, same call site

      emit site (agent hook, route step, terminal event)
                  │
                  ▼
        send(e: AgentEvent) {
          collected.push(e);        ──┐
          controller.enqueue(         │  both happen
            encoder.encode(           │  in this tick,
              encodeEvent(e)));     ──┘  in this order
        }
                  │
            ┌─────┴─────┐
            ▼           ▼
        wire sink   store sink
        (live)      (saved on 'done')
```

### Move 2.1 — the dual-write closure

Six lines at **`app/api/agent/route.ts:186-190`**:

```typescript
// app/api/agent/route.ts:186-190
const collected: AgentEvent[] = [];                          // ← the second sink, declared inside stream start
const send = (e: AgentEvent) => {
  collected.push(e);                                          // ← rung 1 of dual write: array push (cannot fail)
  controller.enqueue(encoder.encode(encodeEvent(e)));         // ← rung 2 of dual write: stream enqueue
};
```

**Reading the choice of order.** `collected.push` first, `controller.enqueue` second. If `enqueue` throws (e.g. controller already closed because the client navigated away), the array still has the event. That keeps the captured snapshot complete even if the wire failed at the very end. Saving a complete-but-not-quite-wire-perfect array is more useful than saving an array that's *missing* the events that didn't make it onto a broken wire.

**The collection is scoped to one request.** `collected` is declared inside the `start(controller)` callback at line 185, so each request gets its own array. No cross-request bleed.

### Move 2.2 — the helper closures that use `send`

Every emit site routes through `send`. Two helper closures wrap it, at **`app/api/agent/route.ts:191-210`**:

```typescript
// app/api/agent/route.ts:191-210 (condensed; full version covers all 3 step kinds and 3 hook kinds)
const stepFor = (
  agent: AgentName,
  kind: 'thought' | 'hypothesis' | 'conclusion',
  content: string,
) => send({ type: 'reasoning_step', step: { id: crypto.randomUUID(), agent, kind, content } });

const hooksFor = (agent: AgentName) => ({
  onText: (t: string) => {
    if (t.trim()) stepFor(agent, 'thought', t);
  },
  onToolCall: (tc: ToolCall) => send({ type: 'tool_call_start', toolName: tc.toolName, agent }),
  onToolResult: (tc: ToolCall) =>
    send({
      type: 'tool_call_end',
      toolName: tc.toolName,
      agent,
      durationMs: tc.durationMs ?? 0,
      result: trunc(tc.result),
      error: tc.error,
    }),
});
```

**`stepFor` builds a reasoning_step event and routes through `send`.** The `crypto.randomUUID()` is what makes the step replayable — every event has a stable ID that the UI uses for React keys *and* that the replay can preserve.

**`hooksFor(agent)` returns the three hooks the agent loop expects.** Each hook builds the matching `AgentEvent` variant and routes through `send`. The agent loop has no idea any of this is happening — it just calls `onText`, `onToolCall`, `onToolResult` as it runs, and those calls each fan to both sinks.

**Note `trunc(tc.result)` at line 207.** The result payload is truncated to 4000 chars (`TRUNC = 4000` at line 97). This applies to both the wire AND the store — the dual-write doesn't distinguish. So a huge EQL result is small in both places, consistently. That's important: the saved snapshot is *not* a richer artifact than the wire; it's exactly the same.

### Move 2.3 — the persist-on-done call

The pattern only pays off if the array becomes durable. That happens once, at **`app/api/agent/route.ts:299-302`**:

```typescript
send({ type: 'done' });                                       // ← the last event hits both sinks
// Only the combined run (capture) is cached to disk; the split steps are
// handed off via the client's sessionStorage.
if (step == null) saveInvestigation(insightId!, collected);   // ← `collected` is the snapshot — fed to the three-rung store
```

**Reading the gate `if (step == null)`.** Only combined runs (no `?step=` param — the capture flow) get persisted. Per-step runs (the user investigating step 2 or step 3 separately) don't write to the cache, because the cache is keyed by `insightId` and storing per-step would mean partial snapshots that can't be replayed as a whole. The single-write-per-insight rule means rung 2 holds *complete combined runs only*, which is exactly what the replay branch expects.

**`saveInvestigation` is the bridge to the three-rung store** (→ `03-three-rung-mem-file-seed-store.md`). It writes to rung 1 always, rung 2 in dev. So the live request's `collected` array becomes the next request's cached fixture, transparently.

### Move 2.4 — load-bearing skeleton

Three parts. Drop any one and the dual-write contract breaks in a named way.

**1. Isolate the kernel.**

```
  dual-write kernel (pseudocode)

  per-request:
    collected := []                                    // local to the request
    send(e) :=
      collected.push(e)                                // sink A: in-process array
      controller.enqueue(encode(e))                    // sink B: wire stream

  on terminal event:
    send({type: 'done'})
    if condition_for_persisting:
      saveInvestigation(id, collected)                  // hand collected to durable store
```

**2. Name each part by what BREAKS when it is missing.**

| Part | What breaks if removed |
| --- | --- |
| `const collected = []` declared per-request inside the closure | shared array across requests → events from request N leak into request M's saved snapshot |
| `collected.push(e)` BEFORE `controller.enqueue` | enqueue throw (closed controller) skips the push → saved snapshot missing the final events |
| every emit site routes through `send` (not direct `enqueue`) | a forgotten site emits to wire only → saved snapshot is missing those events → replay diverges from the live experience for THAT investigation type |
| `saveInvestigation(id, collected)` after `send({type:'done'})` | the array exists but is never persisted → cache never warms, every replay is a miss |
| the `step == null` gate before `saveInvestigation` | per-step runs would overwrite the combined-run snapshot with a partial one → the replay branch's filter has nothing valid to slice |

**3. Separate skeleton from optional hardening.**

The kernel is "one closure, two sinks, persist on terminal." Optional hardening (all currently present): the `trunc(tc.result)` to bound payload size at 4000 chars; the abort check in the replay branch but NOT in the live branch (live `send` calls always enqueue, even after abort, because the controller's own close handles that); the `try/catch` around `writeFileSync` inside `saveInvestigation` (the dual-write itself never sees the disk error).

### Move 2.5 — the sequence

What actually happens, in time, for one tool call event.

```
  Sequence — one tool_call_end event through dual-write

  agent loop                  hooksFor('diagnostic').onToolResult(tc)
   │                                       │
   │  tool completes                       │
   │  (durationMs measured)                │
   │ ───────────────────────────────────► │
   │                                       │
   │                                       │  builds event:
   │                                       │  { type: 'tool_call_end',
   │                                       │    toolName, agent: 'diagnostic',
   │                                       │    durationMs, result: trunc(...), error }
   │                                       │
   │                                       │  calls send(event)
   │                                       │
   │                          send(e):     │
   │                          ─────────────│
   │                                       │── collected.push(e)        [sink A: array]
   │                                       │
   │                                       │── encoded := encodeEvent(e) // JSON + '\n'
   │                                       │── bytes := encoder.encode(encoded)
   │                                       │── controller.enqueue(bytes) [sink B: wire]
   │                                       │
   │  ◄─── returns ─────────────────────── │
   │                                       │
   │  (agent loop continues)               │
   │                                       │
                                          
                                  ▲                          ▲
                          collected[i] = e          wire has the bytes
                          (sink A complete)         (sink B complete)
                          
  on terminal:
    send({type:'done'})  → both sinks
    saveInvestigation(insightId, collected) → rung 1 (mem.set) + rung 2 (writeFileSync, dev)
```

Both sinks complete inside the same synchronous tick. There's no async window between the array having the event and the wire having the bytes. That's why the snapshot is byte-equivalent: same encoder, same source, same order, no possible drift.

### Move 3 — the principle

The general principle: **when one event needs to land in two places, build the tee at the smallest possible scope.** Not a logger queue (asynchronous, can lose events under back-pressure). Not an after-the-fact replay (the agent ran once, you can't re-run it for the snapshot). One synchronous closure that pushes both sinks at the same call site, every time.

The corollary: **route every emit site through the closure.** The discipline is the safety. The moment one emit site calls `controller.enqueue` directly, the saved snapshot is incomplete for that case, and the replay starts lying — and the failure is silent because the live wire is fine.

A reader of the route will notice that the closure does the work of *both* an observability concern (capture the event for later) and a transport concern (send the event now). That coupling is on purpose. Separating them ("emit to wire; observability is downstream") would introduce the async window — and that's exactly what makes saved snapshots drift from live experience.

## Primary diagram

The full picture — one `send`, two sinks, terminal persist.

```
  Dual-write — every event goes to wire AND store, at the same call site

  ┌─ agent layer ────────────────────────────────────────────────────┐
  │  DiagnosticAgent.investigate(…, hooksFor('diagnostic'))           │
  │    │                                                              │
  │    ├─ onText(t)        → stepFor('diagnostic','thought',t)        │
  │    ├─ onToolCall(tc)   → send({type:'tool_call_start',…})         │
  │    └─ onToolResult(tc) → send({type:'tool_call_end',…,trunc(res)})│
  │                                                                   │
  │  RecommendationAgent.propose(…, hooksFor('recommendation'))       │
  │    │ (same three hooks, agent: 'recommendation')                  │
  └────┼──────────────────────────────────────────────────────────────┘
       │                          ┌─ Route-level direct emits ──────┐
       │                          │  stepFor('diagnostic','thought',│
       │                          │    'investigating …')           │
       │                          │  send({type:'diagnosis', …})    │
       │                          │  send({type:'recommendation',…})│
       │                          │  send({type:'done'})            │
       │                          │  send({type:'error', message:…})│
       │                          └────┬────────────────────────────┘
       │                               │
       └───────────────┬───────────────┘
                       ▼
  ┌─ the dual-write closure ──────────────────────────────────────────┐
  │  const collected: AgentEvent[] = [];   // per-request, in scope    │
  │  const send = (e: AgentEvent) => {                                  │
  │    collected.push(e);                  // SINK A first              │
  │    controller.enqueue(                  // SINK B second             │
  │      encoder.encode(encodeEvent(e))                                  │
  │    );                                                                │
  │  };                                                                  │
  └─────────┬──────────────────────────────────────┬────────────────────┘
            │                                       │
            ▼ rung 1: array push (cannot fail)      ▼ rung 2: bytes on wire
  ┌─ in-process array ───────┐         ┌─ HTTP chunked response ──────┐
  │ AgentEvent[]              │         │ NDJSON, content-type         │
  │   ↓ on 'done'             │         │ application/x-ndjson         │
  │ saveInvestigation(id,     │         │   ↓                          │
  │   collected)              │         │ readNdjson on UI consumer    │
  │   ↓                       │         │   ↓                          │
  │ three-rung store          │         │ switch (e.type) → React      │
  │ (mem.set + dev file)      │         │ state                        │
  └───────────────────────────┘         └──────────────────────────────┘
```

## Elaborate

The dual-write pattern is everywhere because the alternative (emit-then-log-from-the-pipeline) introduces an asynchronous failure mode. The Unix `tee(1)` is the same idea at the OS level. Datadog/Honeycomb client libraries that batch-buffer log lines under back-pressure are an *anti-pattern* version of the same need: they trade durability for throughput by promising "we'll get to it" — fine for most logs, broken for "this log IS the artifact."

The closest distributed-systems analog is the **transactional outbox pattern**: write to the DB and to an outbox table in one transaction; a worker reads the outbox and publishes to a message bus. Same principle (atomic dual-write to two destinations), more machinery (because the destinations are separate systems). This codebase has the in-process version: the array IS the outbox, `saveInvestigation` IS the worker.

The **collected.push BEFORE enqueue** ordering is the bit that's easy to get wrong. Most code does it in the obvious "emit, then record" order — which means a failure in emit leaves the record short. Reversing it is the kind of safety lesson you learn by losing one important snapshot.

The **per-step gate before persist** (`if (step == null)`) is the operational discipline that keeps the cache valid. Without it, partial step runs would overwrite combined runs, and the replay branch's filter would have nothing valid to slice. The capture flow runs combined; the user flow runs split; only the capture path persists.

**Adjacent concepts:**
- **`tee(1)`** — the Unix command that named the pattern.
- **Reactor pattern's onNext + onComplete callbacks** — pushing through one observable callback to N subscribers.
- **Transactional outbox** — the durable-message-bus version.
- **`console.log` interceptors / monkey-patched loggers** — the "log to console AND ship to a backend" version most JS apps run.
- **Write-through cache** — the storage version (write to cache and DB at once).

**Read next:**
- `01-ndjson-agent-event-discriminated-union.md` — what gets dual-written.
- `02-replay-from-snapshot-with-paced-emission.md` — what the saved snapshot becomes.
- `03-three-rung-mem-file-seed-store.md` — where `saveInvestigation` ends up.

## Interview defense

**Q: Why push-then-enqueue and not enqueue-then-push?**
A: Push is safer (JS arrays don't throw on a successful push). Enqueue can throw (closed controller, back-pressure). If enqueue throws, the surrounding try/catch catches it — but if we enqueued *first*, the push never ran and the saved snapshot is missing that event. Pushing first means the saved snapshot is *complete or strictly larger* than the wire experience, never smaller. For a snapshot that's going to become a replay fixture, "more complete" is the right error mode.

> *Sketch:* the closure with arrows showing the order, plus a callout "if enqueue throws here, the push already happened."

**Anchor:** "Push first; the array is the safer sink."

**Q: Why is `collected` declared inside the stream-start callback?**
A: Per-request scope. If `collected` were at module level, request A's events would leak into request B's saved snapshot — a serverless instance serving concurrent requests would corrupt every cache write. Declaring it inside the `start(controller)` closure scopes it to one request. Same reason `lib/state/insights.ts:14` uses per-session sub-maps instead of one global Map.

> *Sketch:* the closure scope highlighted, two concurrent request boxes with their own `collected` arrays.

**Anchor:** "Scope per request; module-level is a leak."

**Q: How do you guarantee every emit site goes through `send`?**
A: Discipline + scope. The `controller` is shadowed inside the `start` callback — no outer code has a reference. Inside, every emit site either calls `send` directly, calls `stepFor` (which calls `send`), or calls `hooksFor(agent)` which builds the three hooks (which call `send`). The agent loop only sees the hooks — it doesn't even know about the controller. The only place to forget the dual-write is inside the route file itself, on direct calls to `send`-vs-`controller.enqueue`. Code review catches it; the safer move would be to never bind `controller` to a name visible inside `start` — but that's a separate refactor.

> *Sketch:* the closure scope with `send` inside, `controller` shadowed, all emit sites going through `send`.

**Anchor:** "Hide the controller; expose only the dual-writer."

**Q: Why does only the combined run get persisted?**
A: The replay branch's per-step filter slices a combined-run snapshot into diagnose / recommend views. If a per-step run overwrote the combined snapshot, the next replay would be a partial that the filter can't slice into the other step. The `if (step == null)` gate at `app/api/agent/route.ts:302` means: only the capture flow (which runs combined) writes the cache. User-driven per-step runs read from cache but don't write. One-direction data flow keeps the cache consistent.

> *Sketch:* combined run → write; per-step run → read-only.

**Anchor:** "Combined writes; split reads. Cache stays sliceable."

**Q: What happens if the client closes the tab mid-stream?**
A: The agent loop is signaled (`req.signal.aborted` becomes true; the threaded signal cancels the in-flight Anthropic call and the in-flight MCP call). The catch block at `app/api/agent/route.ts:308-310` checks for `DOMException` `AbortError` and returns without sending an error event (no consumer to read it). The `finally` block still fires the phase summary log to Vercel logs *and* runs `disposeDataSource`. The `collected` array exists but is partial; `saveInvestigation` isn't called (we never reached the `done` send). So the cache stays clean — no half-runs persisted. The cost is that the budget burned on a cancelled run is visible only in the phase log line, not as a saved artifact.

> *Sketch:* the abort path: client close → req.signal → loop bail → catch → finally → no saveInvestigation.

**Anchor:** "Abort doesn't write a partial cache."

## See also

- `01-ndjson-agent-event-discriminated-union.md` — the schema being dual-written.
- `02-replay-from-snapshot-with-paced-emission.md` — what the saved array becomes.
- `03-three-rung-mem-file-seed-store.md` — where `saveInvestigation` deposits it.
- `audit.md` § 1 (observability-map), § 2 (reproduction-and-evidence).
