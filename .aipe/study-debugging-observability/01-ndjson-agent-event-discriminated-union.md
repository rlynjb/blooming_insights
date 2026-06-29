# NDJSON `AgentEvent` discriminated union

**Industry name(s):** newline-delimited JSON wire format (NDJSON) + discriminated union (a.k.a. tagged union, sum type — `AgentEvent` is the TypeScript instance here). **Type:** Industry standard format, language-agnostic pattern.

## Zoom out — where this concept lives

This one concept is the spine of the entire observability story. It's the contract that makes the *same data* appear in the UI, in the dev cache, in the committed seed, and (in summary form) in Vercel logs.

```
  Zoom out — the AgentEvent contract sits at the service/UI boundary

  ┌─ UI layer ─────────────────────────────────────────────────┐
  │  StatusLog · ReasoningTrace · StreamingResponse             │
  │       ▲          ▲                ▲                         │
  │       │          │                │                         │
  │       └──── readNdjson<AgentEvent>(res.body, handle) ───┐   │
  └─────────────────────────────────────────────────────────┼───┘
                                                            │
  ┌─ Service layer ────────────────────────────────────────▼───┐
  │  /api/briefing      /api/agent      (NDJSON producers)     │
  │       │                  │                                  │
  │       ▼                  ▼                                  │
  │  ╔═══════════════════════════════════════════════╗         │
  │  ║  ★ AgentEvent (8 variants) — encodeEvent ★    ║ ← we are │
  │  ╚═══════════════════════════════════════════════╝   here   │
  │       │                  │                                  │
  │       │                  └─► collected.push(e) → save        │
  │       │                                                      │
  └───────┼──────────────────────────────────────────────────────┘
          │
  ┌─ Storage layer ──▼──────────────────────────────────────────┐
  │  .investigation-cache.json · demo-investigations.json        │
  │  (both files hold AgentEvent[] — same shape as the wire)     │
  └──────────────────────────────────────────────────────────────┘
```

**Zoom in.** The discriminated union (`AgentEvent`) has 8 variants. Each variant has a `type` literal that picks one case (`'reasoning_step' | 'tool_call_start' | …`). The wire encoding is one JSON object per line, terminated with `'\n'`. Producers call the event encoder (`encodeEvent`); consumers call the NDJSON reader (`readNdjson<AgentEvent>(body, handle)`) and a `switch (e.type)` decides what to do with each event.

The question this contract answers: *"how do four different consumers stay in lockstep with two different producers — and with a JSON file on disk — without inventing a separate schema for each pair?"*

## Structure pass

Read the skeleton before the mechanics.

**Layers.** Two stacked: the wire format (NDJSON — bytes on a stream, one JSON object per `'\n'`) on top of the schema (`AgentEvent` — the 8 cases). Each layer is independently substitutable: you could swap NDJSON for Server-Sent Events without touching the union, or extend the union with a 9th variant without touching the byte-framing.

**Axis: state ownership.** Hold one question constant — *"who owns the event's interpretation?"* Producers (the route) emit a raw discriminator + payload. Consumers (UI, save-to-disk, replay) each interpret the same event differently. The wire is **dumb** (just bytes); both ends are smart and independent.

```
  Trace the "who owns interpretation?" axis across the layers

  ┌─ producer (route) ──────────┐
  │  knows: how to emit         │ ← author of the event
  │  decides: when/what/order   │
  └─────────────┬───────────────┘
                │  AgentEvent (just JSON)
  ┌─ wire (NDJSON) ─────────────▼───────────────┐
  │  knows: nothing — it's bytes                 │ ← the seam
  │  guarantees: one event per '\n'-terminated   │
  │              line, in producer order         │
  └─────────────┬────────────────────────────────┘
                │
  ┌─ consumer (UI / store / replay) ────────────▼┐
  │  knows: how to react to each variant         │ ← author of the reaction
  │  decides: render / save / pace               │
  └──────────────────────────────────────────────┘
```

**Seams.** Two load-bearing boundaries:

1. **Producer → wire.** Contract: `encodeEvent(e)` returns one JSON object + `'\n'`. Break it (forget the newline) → consumer's split-on-`'\n'` buffers the event until the *next* event arrives, so the UI freezes. The trailing-buffer flush in `readNdjson` at `lib/streaming/ndjson.ts:52-60` is the hardening for the "last event has no newline" case — a no-op when producers behave, but the safety net.
2. **Wire → consumer.** Contract: `switch (e.type)` must handle every variant. Break it (a new producer-side variant the consumer doesn't `case`) → the event is silently ignored. TypeScript's exhaustiveness check is the design-time guard; the consumer's `default: break` at `lib/hooks/useInvestigation.ts:149-150` is the runtime guard.

The seam's *contract* is the discriminator field. Pick a different field name on either side and the union breaks at runtime with no compile error (because both sides type the field as `string`). The convention here is `type` — see every variant in `lib/mcp/events.ts:4-12`.

Skeleton mapped. Now the mechanics.

## How it works

### Move 1 — the mental model

You've used a tagged switch in a reducer (`case 'ADD_TODO': … case 'TOGGLE': …`). A discriminated union is the type-level version of that: the union *type* is "one of these 8 shapes," and the runtime *value* carries the tag that says which shape it actually is. Then `switch (e.type)` is exhaustively type-checked — drop a case, TypeScript yells.

NDJSON is the wire shape that pairs with this: one JSON object per `'\n'`-terminated line. Not a JSON array (which would require buffering the whole stream before parsing). Not Server-Sent Events (which adds an event-name framing layer this design doesn't need). Just `JSON.stringify(e) + '\n'` per event, line by line.

```
  The pattern — discriminated union over NDJSON

  producer side                wire                consumer side
  ─────────────                ────                ─────────────
                                                                
     event A     ─encodeEvent─►  {"type":"step",…}\n  ─split('\n')─►  parse → switch
     event B     ─encodeEvent─►  {"type":"tool",…}\n  ─split('\n')─►  parse → switch
     event C     ─encodeEvent─►  {"type":"done"}\n    ─split('\n')─►  parse → switch
                                                                
        ▲                              ▲                              ▲
        │                              │                              │
   author of intent             dumb byte framing            author of reaction
   (chooses variant)           (one event per line)           (one case per variant)
```

### Move 2.1 — the union itself

Eight variants live in **`lib/mcp/events.ts:4-12`**:

```typescript
// lib/mcp/events.ts:4-12
export type AgentEvent =
  | { type: 'reasoning_step'; step: ReasoningStep }                                                          // ← the agent talking to itself
  | { type: 'tool_call_start'; toolName: string; agent: AgentName }                                          // ← about to hit MCP
  | { type: 'tool_call_end'; toolName: string; agent: AgentName; durationMs: number; result?: unknown; error?: string }  // ← MCP returned (or errored)
  | { type: 'insight'; insight: Insight }                                                                    // ← monitoring produced one
  | { type: 'diagnosis'; diagnosis: Diagnosis }                                                              // ← diagnostic concluded
  | { type: 'recommendation'; recommendation: Recommendation }                                               // ← recommendation produced one
  | { type: 'done' }                                                                                          // ← end-of-stream sentinel
  | { type: 'error'; message: string };                                                                       // ← terminal failure on this stream
```

**Reading the design choices, line by line.** Every variant carries exactly the data its case needs and *nothing the consumer has to look up elsewhere*. `tool_call_end` carries `durationMs` so the UI doesn't need a timer; `insight` carries the full `Insight` object so the consumer can render it directly. The wire is self-contained — there's no "fetch the result by ID" round trip.

The `done` variant is a sentinel: zero payload, just the signal that the producer is finished. The `error` variant is the *terminal* failure marker (the stream ends after one) — distinct from a `tool_call_end` whose `error` field is set (a single tool failed, the stream continues).

**The `agent` field on tool events is the load-bearing tag for replay filtering.** Without it, the per-step filter at `app/api/agent/route.ts:64-82` cannot separate diagnostic-phase tool calls from recommendation-phase tool calls in a combined-run snapshot. Drop the field → the replay shows both phases on step 2 instead of just diagnose. → see `02-replay-from-snapshot-with-paced-emission.md` for the filter that depends on this.

### Move 2.2 — encode / decode

Two helpers, three lines each, at **`lib/mcp/events.ts:15-22`**:

```typescript
export function encodeEvent(e: AgentEvent): string {
  return JSON.stringify(e) + '\n';                  // ← '\n' is mandatory; without it the consumer buffers indefinitely
}

export function decodeEvent(line: string): AgentEvent {
  return JSON.parse(line) as AgentEvent;             // ← the cast trusts the producer; readNdjson catches JSON.parse throws
}
```

This is the entire wire format. Three lines. The brevity is the point — the contract surface is small enough that a new producer or consumer can't accidentally diverge.

### Move 2.3 — the kernel (load-bearing skeleton)

Move 2 variant — this concept has an irreducible kernel: the `readNdjson` loop at **`lib/streaming/ndjson.ts:17-64`**. One reader, one decoder, one buffer, one split, one parse. Five parts. Drop any one and the loop breaks in a specific named way.

**1. Isolate the kernel.**

```
  readNdjson kernel (pseudocode)

  reader := body.getReader()
  decoder := new TextDecoder()
  buf := ""
  loop:
    if cancelOn() then reader.cancel(); return
    {value, done} := reader.read()
    if done then break
    buf += decoder.decode(value, {stream: true})       // accumulate raw bytes
    lines := buf.split('\n')                            // chop on newline
    buf := lines.pop()                                  // keep the trailing partial as next buffer
    for each line in lines:
      if line is empty then continue
      try:
        onEvent(JSON.parse(line))
      catch err:
        onMalformed(line, err)                          // opt-in observability
  flush:
    if buf is non-empty then JSON.parse(buf); onEvent(it)
```

**2. Name each part by what BREAKS when it is missing.**

| Part | What breaks if removed |
| --- | --- |
| `reader.cancel()` on `cancelOn()` | unmounted consumer keeps draining the body; server keeps producing into a dead reader → memory + budget leak |
| `decoder.decode(value, {stream: true})` | a multi-byte UTF-8 char split across chunks decodes as garbled bytes → `JSON.parse` throws on a corrupted line |
| `buf += …; lines = buf.split('\n'); buf = lines.pop()` | the rotating-buffer dance. Drop the `buf = lines.pop()` and a chunk that ends mid-event (because TCP doesn't respect your `'\n'`s) loses the trailing partial → that event is malformed and dropped |
| `for each line in lines: JSON.parse(line)` | the actual work. Drop the empty-line guard and an empty trailing line from a producer that double-newlines throws on `JSON.parse("")` |
| trailing flush at `ndjson.ts:52-60` | a producer that forgets the final `'\n'` (or a future producer that omits trailing newlines deliberately) loses the last event — this is hardening that's currently a no-op |

The buffer rotation is the part newcomers miss. It's not "split, parse all" — it's "split, keep the trailing partial, parse the rest, repeat." That single line `buf = lines.pop() ?? ''` is the load-bearing piece nobody remembers.

**3. Separate skeleton from optional hardening.**

The kernel: reader + decoder + buf + split + parse-and-dispatch. Everything else is hardening. The optional `cancelOn` callback is hardening for component unmount. The optional `onMalformed` is hardening for observability (the consumer can opt in to noticing bad lines — none of the four real consumers do, see audit rank 6). The trailing-buffer flush is hardening for newline-less producers.

### Move 2.4 — the layers-and-hops

How an event travels from agent to UI, with every hop labeled.

```
  Layers-and-hops — one AgentEvent's journey

  ┌─ MCP layer ────────────────────────────────────────────────┐
  │  Bloomreach tool result returns                             │
  │  durationMs measured inside dataSource.callTool            │
  └─────────────────────────┬──────────────────────────────────┘
                            │ hop 1: { result, durationMs, fromCache }
                            ▼
  ┌─ Service layer ────────────────────────────────────────────┐
  │  agent loop hooks → onToolResult(tc)                        │
  │  builds AgentEvent { type:'tool_call_end', toolName,        │
  │                      agent, durationMs, result, error }    │
  └─────────────────────────┬──────────────────────────────────┘
                            │ hop 2: send(e) at route.ts → push to collected,
                            │        encodeEvent(e), enqueue bytes
                            ▼
  ┌─ Network boundary ─────────────────────────────────────────┐
  │  HTTP/1.1 chunked response body, content-type ndjson        │
  │  one JSON object + '\n' per chunk (or batched)              │
  └─────────────────────────┬──────────────────────────────────┘
                            │ hop 3: chunked bytes over TLS
                            ▼
  ┌─ UI layer ─────────────────────────────────────────────────┐
  │  fetch(...).body → readNdjson<AgentEvent>(body, handle)    │
  │  switch (e.type) { case 'tool_call_end': setItems(…) }     │
  │  React re-renders → ToolCallBlock shows the duration        │
  └────────────────────────────────────────────────────────────┘
```

Every hop is labeled with what travels. The service layer does the encoding; the network is dumb byte transport; the UI does the dispatch. State ownership flips at hops 2 and 3 — the route owns "when to emit"; the UI owns "what to do with it."

### Move 2.5 — the consumer-side `switch`

The pattern repeats at every consumer. Here's the canonical instance at **`lib/hooks/useInvestigation.ts:98-152`**:

```typescript
// lib/hooks/useInvestigation.ts:98-152 (condensed)
const handle = (e: AgentEvent) => {
  switch (e.type) {
    case 'reasoning_step': {                          // ← agent talking to itself
      const it: TraceItem = { kind: 'step', id: e.step.id, agent: e.step.agent, … };
      cItems.push(it);                                // ← collected for stash on 'done'
      setItems((p) => [...p, it]);                    // ← live UI update
      break;
    }
    case 'tool_call_start': {                         // ← spinner appears
      const it: TraceItem = { kind: 'tool', toolName: e.toolName, status: 'running', … };
      cItems.push(it); setItems((p) => [...p, it]);
      break;
    }
    case 'tool_call_end':                             // ← spinner becomes result
      replaceRunningTool(cItems, e);                  // ← walks list backwards to flip the matching 'running' to 'done'
      setItems((p) => replaceRunningTool([...p], e));
      break;
    case 'diagnosis':   cDiag = e.diagnosis;  setDiagnosis(e.diagnosis); break;
    case 'recommendation': cRecs.push(e.recommendation); setRecommendations((p) => [...p, e.recommendation]); break;
    case 'done':        setComplete(true); /* stash cItems+cDiag+cRecs */ break;
    case 'error':       setError(e.message); break;
    default:            break;                        // ← runtime guard for unknown future variants
  }
};
```

**The `default: break` is the survival hatch.** A consumer compiled against an older `AgentEvent` definition meets a producer that ships a new variant — without the default case the switch is a runtime no-op, with `default: break` the new event is gracefully ignored (and TypeScript-side, the exhaustiveness check at compile time catches the missing case the *next* time the consumer is rebuilt).

The `replaceRunningTool` walks backwards because tool calls can nest (rare) or overlap (the run sends multiple `tool_call_start` before any `tool_call_end` if the agent batches). Walking backwards finds the most recently-started matching tool — the heuristic is correct for the sequential agent loop and acceptable for the rare batched case.

### Move 3 — the principle

The discriminated union + NDJSON pattern works because it **collapses the divergence problem.** Any system with "live UI" + "saved log" + "test fixtures" + "replay tool" normally invents four schemas — and they drift. One schema, one wire format, one set of consumers means a new variant lands in all four places at once or it doesn't compile.

The general lesson: when you have N consumers and M producers of the same conceptual data, define the schema *between* them as a discriminated union and let every site exhaustively switch over it. The exhaustiveness check is the cheapest type-safety guarantee in TypeScript and the one most often skipped.

## Primary diagram

The full picture — every producer, every consumer, every storage hop.

```
  AgentEvent — one schema, two producers, four consumers, two storage paths

  ┌─ producers ─────────────────────────────────────────────────────────┐
  │                                                                       │
  │  app/api/briefing/route.ts        app/api/agent/route.ts             │
  │   (monitoring scan)                (diagnostic, recommendation,       │
  │                                     free-form query, demo replay)    │
  │           │                                  │                        │
  │           └──────────┬───────────────────────┘                        │
  │                      ▼                                                │
  │              encodeEvent(e: AgentEvent) → JSON + '\n'                 │
  │                      │                                                │
  └──────────────────────┼────────────────────────────────────────────────┘
                         │ NDJSON over chunked HTTP
                         ▼
  ┌─ wire ──────────────────────────────────────────────────────────────┐
  │ {"type":"reasoning_step","step":{…}}\n                                │
  │ {"type":"tool_call_start","toolName":"execute_analytics_eql","…"}\n  │
  │ {"type":"tool_call_end",…,"durationMs":1834}\n                       │
  │ {"type":"insight","insight":{…}}\n                                   │
  │ {"type":"done"}\n                                                    │
  └───────────────────────┬───────────────────────┬─────────────────────┘
                          │                       │
       ┌──────────────────┘                       └────────────────────┐
       │ readNdjson<AgentEvent>(body, handle, …)                       │
       ▼                                                                ▼
  ┌─ four UI consumers ─────────────┐    ┌─ server-side dual-write ──────┐
  │  useBriefingStream.ts            │    │  collected.push(e) inside     │
  │  useInvestigation.ts             │    │  /api/agent's stream start    │
  │  useDemoCapture.ts               │    │            │                  │
  │  StreamingResponse.tsx           │    │            ▼                  │
  │     │                            │    │  saveInvestigation(id,        │
  │     │ each runs:                 │    │                    collected) │
  │     │   switch (e.type) { … }    │    │            │                  │
  │     ▼                            │    │            ▼                  │
  │  React state → StatusLog,        │    │  in-mem Map → .investigation- │
  │  ReasoningTrace, InsightCard     │    │  cache.json (dev) →           │
  │                                  │    │  demo-investigations.json     │
  └──────────────────────────────────┘    │  (committed seed, on capture) │
                                          └───────────────────────────────┘
```

## Elaborate

Discriminated unions are an old idea — they're algebraic data types from ML / Haskell, sum types in Rust (`enum`), `Either` / `Result` in functional languages. TypeScript's version is structural and runtime-erased, so the *value* needs a discriminator field at runtime (the `type` literal) because the type information isn't there to inspect.

NDJSON is a 2010s deliberate non-standard: line-delimited JSON, one record per line. The point is that you can stream-parse it incrementally (the consumer doesn't need to wait for `]` to know the array is done), while a JSON array can't be parsed until the closing bracket arrives. Anything that wants append-only logs with cheap-to-parse semantics ends up at NDJSON: jsonlines.org, BigQuery exports, Vercel function logs, Anthropic streaming responses (in the SSE shape, which is NDJSON + the `data: ` prefix).

The choice not to use Server-Sent Events here is deliberate. SSE adds a framing layer (`event: name\ndata: payload\n\n`) and reconnect semantics; this app doesn't want auto-reconnect (a reconnect to a per-request stream is meaningless — the agent run is gone) and it doesn't need named event channels because the discriminator is *in the JSON object*. NDJSON is the minimum that works.

**Adjacent concepts:**
- **JSON-RPC** — also a discriminated union (`method` is the discriminator), but request/response shaped, not streaming.
- **Protobuf `oneof`** — the wire-efficient version when you control both ends and you care about bytes.
- **Redux actions** — the same pattern in a single process: `{type, payload}` switched in a reducer.

**Read next:**
- `02-replay-from-snapshot-with-paced-emission.md` — how the saved `AgentEvent[]` becomes a fixture.
- `04-dual-write-send-to-stream-and-store.md` — the seam between the live stream and the saved snapshot.

## Interview defense

**Q: Why NDJSON over Server-Sent Events?**
A: SSE adds framing (`event:` + `data:` + double-newline) and reconnect semantics this app doesn't want. A per-request agent run can't be reconnected — the LLM state is gone. The discriminator I need is *inside* the JSON object as the `type` field. NDJSON is the minimum: `JSON.stringify(e) + '\n'`, three-line encode at `lib/mcp/events.ts:15-17`.

> *Sketch:* the four-box layers diagram above, point at the wire layer.

**Anchor:** "We didn't need event names because the discriminator is in the payload."

**Q: What's the one part of `readNdjson` people forget?**
A: The buffer rotation — `buf = lines.pop() ?? ''` at `lib/streaming/ndjson.ts:40-41`. Without it, a chunk boundary in the middle of an event splits the JSON across two iterations and `JSON.parse` throws on both halves. The fix is to *keep* the trailing partial as the seed for the next iteration. It's one line that looks incidental; remove it and the loop is silently lossy.

> *Sketch:* the kernel pseudocode above, circle the `buf = lines.pop()` line.

**Anchor:** "The pop is the load-bearing line."

**Q: How does TypeScript stop you from forgetting a case?**
A: Exhaustiveness check on the discriminator. Inside `switch (e.type)`, TypeScript narrows `e` to the matching variant per case. If you assign the switch result to a `never` (or use a helper like `assertNever`), TypeScript fails to compile when a new variant lands without a case. The `default: break` in `useInvestigation.ts:149-150` is the *runtime* guard for the version-skew case (consumer built against an older union meets a newer producer); the *compile-time* guard is the type narrowing.

> *Sketch:* the union from `events.ts:4-12` and a switch with `assertNever(e)` in the default.

**Anchor:** "Discriminator at runtime, exhaustiveness at compile time."

**Q: Why does the wire carry `agent` on tool events?**
A: Replay filter. The combined-run snapshot in `lib/state/demo-investigations.json` holds both diagnostic and recommendation phases. The per-step replay at `app/api/agent/route.ts:64-82` filters by `e.step.agent` (for reasoning_step) and `e.agent` (for tool_call_start/end). Drop the field and step 2 (diagnose) would replay the recommendation-phase tool calls too.

> *Sketch:* the `filterByStep` function, point at the `agent === 'recommendation'` check.

**Anchor:** "The `agent` field is the slice key for cached replay."

**Q: What happens if a producer ships a new variant the UI doesn't know about?**
A: At runtime, the `default: break` in the consumer's switch silently ignores it — the trace just doesn't show that event. At compile time, the next rebuild of the UI fails the exhaustiveness check and forces the new case. So the runtime is *forgiving* (won't crash a deployed UI when the route ships ahead) and the dev cycle is *strict* (won't let you commit the gap). That asymmetry is intentional.

> *Sketch:* "old client | new server" boxes with the new variant flowing through.

**Anchor:** "Forgiving at runtime, strict at compile."

## See also

- `02-replay-from-snapshot-with-paced-emission.md` — uses the wire format as a fixture.
- `03-three-rung-mem-file-seed-store.md` — where the captured `AgentEvent[]` lives.
- `04-dual-write-send-to-stream-and-store.md` — the producer-side coupling that keeps the wire and the disk in sync.
- `audit.md` § 1 (observability-map), § 3 (structured-logs-and-correlation).
