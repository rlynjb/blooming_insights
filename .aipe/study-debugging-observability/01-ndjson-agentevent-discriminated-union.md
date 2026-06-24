# NDJSON AgentEvent discriminated union

**Industry name(s):** discriminated union, tagged union, sum type, typed event protocol, NDJSON event stream
**Type:** Industry standard · Language-agnostic · Project-specific (the 8 variants are this repo's vocabulary)

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** This 8-line union is the spine of the entire observability story. Every layer of the system — the agent loop that emits, the route handler that transports, the React UI that renders, the cache that persists, the replay path that re-emits — speaks the same closed set of typed events. If you rebuild this codebase from scratch, this file is what you write first.

```
  Zoom out — where the union sits in the system

  ┌─ UI layer ───────────────────────────────────────┐
  │  useInvestigation switch(e.type)                  │
  │  ReasoningTrace · ToolCallBlock · StatusLog       │
  │  → reads AgentEvent variants                      │
  └─────────────────────────▲────────────────────────┘
                            │  NDJSON line per event
  ┌─ Route handler ─────────┴────────────────────────┐
  │  send(e: AgentEvent) closure                      │
  │  → encodeEvent(e) → enqueue                       │
  │  → collected.push(e) for snapshot                 │
  └─────────────────────────▲────────────────────────┘
                            │
  ┌─ Agent loop ────────────┴────────────────────────┐  ← we are here
  │  hooks emit AgentEvent on every step              │
  │  ★ AgentEvent type = lib/mcp/events.ts:4-12 ★    │
  │  ★ encodeEvent           = lib/mcp/events.ts:15-17 │
  └──────────────────────────────────────────────────┘
                            │
  ┌─ Cache (snapshot + replay) ─────────────────────┐
  │  saveInvestigation(id, AgentEvent[])              │
  │  getCachedInvestigation → AgentEvent[]            │
  │  → for (e of events) enqueue(encodeEvent(e))      │
  └──────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** A discriminated union is a closed set of typed shapes that share a single discriminator field. Here the discriminator is `type`, and the union has exactly 8 variants. Each variant is a different message the agent layer can emit; together they form the complete vocabulary of "what the agent did during one investigation." `encodeEvent` is one line — `JSON.stringify(e) + '\n'` — and it's the entire serialization layer. NDJSON is the transport because it's line-delimited (one JSON object per line, no partial parses, naturally streamable), which means the carrier preserves order and every line is independently parseable.

The 8 variants split cleanly into three groups: **annotations** (`reasoning_step`), **span boundaries** (`tool_call_start`, `tool_call_end`), and **outputs/terminals** (`insight`, `diagnosis`, `recommendation`, `done`, `error`). That trichotomy is what makes the stream a real trace, not just a log.

---

## Structure pass

**Layers.** Three: the variant declarations (the closed set of shapes), the encode function (one line, NDJSON terminator), and the consumers (every layer that reads `e.type` and switches on it).

**Axis: trust (can you depend on this evidence's shape, fields, and meaning?).** Trace the trust axis across the layers. At the declaration layer: TypeScript guarantees the union is closed — any code trying to construct a 9th variant fails `tsc`. At the encode layer: trust is total — one line of `JSON.stringify`, no opportunity for shape drift. At the consumer layer: trust is high but conditional — the `switch (e.type)` in `useInvestigation` is checked by the compiler for exhaustiveness, so adding a 9th variant to the union forces every consumer to handle it. Trust *never* drops as you move down the stack, which is the rare and load-bearing property.

**Seams.** One load-bearing seam — and it's *vertical*, not horizontal:

- **Closed-union ↔ everything-else.** Inside the union, every emitter and consumer is type-safe. Outside the union (the 4× `console.error` catches, the freeform `message: string` field on the `error` variant), trust drops to "stringified `e` of unknown shape." The seam matters because it's where typed evidence flips to untyped — the moment you're crossing it, you've lost type safety on what you're recording.

A second seam, *cosmetic-looking but load-bearing*: the boundary between `encodeEvent` and the wire. NDJSON's `\n` terminator is what lets the consumer read partial bytes and emit completed events one-by-one. Drop the `\n` and the stream becomes one large unterminated JSON blob — you'd have to wait for the entire response to parse anything. That single character is the difference between "streamable trace" and "monolithic dump."

```
  Structure pass — the union

  ┌─ 1. LAYERS ───────────────────────────────────┐
  │  variants · encoder · consumers                │
  └────────────────────────┬───────────────────────┘
                           │  pick the axis
  ┌─ 2. AXIS ─────────────▼────────────────────────┐
  │  trust: depend on shape, fields, meaning?      │
  └────────────────────────┬───────────────────────┘
                           │  trace, find flips
  ┌─ 3. SEAMS ────────────▼────────────────────────┐
  │  closed-union ↔ outside: typed → untyped       │
  │    (LOAD: the type system stops here)          │
  │  encodeEvent ↔ wire: '\n' is the framing       │
  │    (LOAD: drop it, lose streamability)         │
  └────────────────────────┬───────────────────────┘
                           ▼
                   Block 4 — How it works
```

Skeleton mapped. Now walk the union, the encoder, and what the consumers do with it.

---

## How it works

**Mental model.** A discriminated union is a *closed menu* of typed shapes, each tagged with a discriminator the consumer can switch on. It's the same idea as Redux actions (one `type` field, payload varies), GraphQL union types, or Rust enums — but here the consumer guarantees come from TypeScript's exhaustiveness checking. Combined with NDJSON, the union becomes a *wire protocol*: a closed set of messages, each independently parseable, ordered by emission. The picture is simpler than its description.

```
  Pattern — the closed-union event stream

  emitter side                                       consumer side
  ──────────────────────────                         ──────────────────────────
  build typed event                                  read one NDJSON line
        │                                                 │
        ▼                                                 ▼
  e: AgentEvent                                      JSON.parse(line) as AgentEvent
        │                                                 │
        ▼                                                 ▼
  JSON.stringify(e) + '\n'                           switch (e.type) {
        │                                              case 'reasoning_step': …
        ▼                                              case 'tool_call_start': …
  enqueue on stream                                    case 'tool_call_end':   …
        │                                              case 'diagnosis':       …
        ▼                                              case 'recommendation':  …
  ── wire ──                                           case 'done':            …
        │                                              case 'error':           …
        ▼                                              case 'insight':         …
  one NDJSON line                                    }   ← exhaustive (tsc enforces)
```

### Move 2 — walk the parts

#### The 8 variants — the closed set

The reader anchor: you've used Redux actions. Same shape. The discriminator (Redux's `type`, TypeScript's `kind`/`type`) is the field the consumer switches on; the rest of each variant is its payload. The 8 variants here aren't arbitrary — each one represents a distinct *kind of thing the agent did*, and the trichotomy (annotation, span boundary, output/terminal) is what makes the union behave like a trace.

What each variant means:

- **`reasoning_step`** — annotation between spans. The agent's free-form text emission, scoped by `agent` (which agent was talking) and `kind` (thought / hypothesis / conclusion). This is the "what was the agent thinking right here?" channel.
- **`tool_call_start`** — span open. Marks the moment the agent dispatched a tool. Carries `toolName` and `agent` — no `durationMs` yet because the call hasn't returned.
- **`tool_call_end`** — span close. The pair to `tool_call_start`. Carries `durationMs` (measured wall-clock by the MCP client), the (truncated) `result`, and an optional `error`.
- **`insight`** — briefing output. Each insight produced by the monitoring agent gets its own event.
- **`diagnosis`** — diagnostic-agent output. Emitted once per investigation, closes the diagnose phase.
- **`recommendation`** — recommendation-agent output. Emitted once per recommendation (multiple per investigation).
- **`done`** — clean terminal. The contract that lets the consumer flip `complete = true`. Triggers `saveInvestigation` on the combined-run path.
- **`error`** — failure terminal. Carries a freeform `message: string` — the one place inside the union where evidence is untyped. The seam between typed event and unstructured exception lives in this field.

Boundary: adding a 9th variant is *not* a casual change. The discriminator is exhaustively switched in `useInvestigation`, in the UI's render code, in the briefing route's extended `BriefingEvent`, and in any future consumer. TypeScript flags the gaps at compile time — that's the *feature*, not a friction. The closed set is what makes the trace contract usable.

```
  The 8 variants — the closed set

  group         variant              role                       payload shape
  ────────────  ───────────────────  ─────────────────────────  ───────────────────────────────────
  annotation    reasoning_step       agent text between spans   step: ReasoningStep
                                                                  {id, agent, kind, content}

  span          tool_call_start      span OPEN                  toolName, agent
                tool_call_end        span CLOSE (+ timing)      toolName, agent, durationMs,
                                                                  result?, error?

  output        insight              briefing output            insight: Insight
                diagnosis            diagnose phase output      diagnosis: Diagnosis
                recommendation       recommend phase output     recommendation: Recommendation

  terminal      done                 clean termination          ─ (no payload)
                error                failure termination        message: string
```

#### encodeEvent — one line, two responsibilities

The reader anchor: you've called `JSON.stringify` on an object and shipped it as a request body. Same shape — but here the function does two things in one line: serialize, and frame.

What it does:

```
  encodeEvent(e: AgentEvent): string
    return JSON.stringify(e) + '\n'    ← framing: '\n' is the NDJSON terminator
                              ▲
                              └─ this single character is what makes the stream parseable
                                 one event at a time. Drop it and the consumer can't tell
                                 where one event ends and the next begins until close().
```

Boundary: there's no error handling here. `JSON.stringify` can throw on circular references or `BigInt` payloads — neither of which appear in `AgentEvent` because the union forbids them at compile time. The function relies on the union's closed-shape guarantee to skip the defensive coding.

#### The consumer side — exhaustive switch

The reader anchor: you've written a switch on Redux action types and watched the compiler tell you which actions you forgot to handle. Same shape. Every consumer of `AgentEvent` runs a `switch (e.type)` against the discriminator; TypeScript's exhaustiveness check ensures none of the 8 variants is dropped.

What the consumers do, in three places:

- **UI hook (`useInvestigation`).** Switches on `e.type`, updates React state accordingly. `reasoning_step` pushes a `TraceItem` of kind `reasoning`; `tool_call_start` pushes a `TraceItem` of kind `tool` with `status: 'running'`; `tool_call_end` calls `replaceRunningTool` to find and close the matching open span.
- **Route handler `send` closure.** Doesn't switch — just dual-writes: `collected.push(e)` (for snapshot) and `controller.enqueue(encodeEvent(e))` (for wire). The type is opaque to the closure; it relies on the union's closed shape to mean every emission is valid.
- **Cache replay path.** Iterates `AgentEvent[]`, re-encodes each event with the same `encodeEvent`, paces with 180ms ticks. The replay layer never inspects the variants — it just preserves order.

Boundary: the *positional* nature of consumer behavior (UI uses position-based matching for span pairing in `replaceRunningTool`) is the one place the closed-shape guarantee isn't enough. If two `tool_call_start` events for the same `toolName` are open simultaneously (parallel tool dispatch), the matching ambiguates. The latent fix is a `spanId` field; the union accepts the extension cleanly because the closed-shape discipline is intact.

```
  Consumer side — exhaustive switch on the discriminator

  switch (e.type) {
    case 'reasoning_step':
      items.push({ kind:'reasoning', agent: e.step.agent, content: e.step.content })
      break
    case 'tool_call_start':
      items.push({ kind:'tool', toolName: e.toolName, agent: e.agent, status:'running' })
      break
    case 'tool_call_end':
      replaceRunningTool(items, e)        ← scan-back to match the open span
      break
    case 'diagnosis':    setDiag(e.diagnosis); break
    case 'recommendation': setRecs(prev => [...prev, e.recommendation]); break
    case 'insight':      setInsights(prev => [...prev, e.insight]); break
    case 'done':         setComplete(true); break
    case 'error':        setError(e.message); break
  }
  // tsc enforces: if you added a 9th variant and missed it here, compile fails
```

#### Move 3 — the principle

Type your trace events as a closed discriminated union *before the first one ships*. Once the union is locked, every layer (emit, transport, render, replay) follows the same shape and the trace becomes a real artifact, not just an instrumented log. The lesson generalises far beyond this codebase: any time you're designing a wire protocol or a cross-layer event stream, the closed-set + discriminator + exhaustiveness-check combination buys you compile-time guarantees that no amount of integration testing replicates. The 8-line file is the smallest credible version of this discipline — and it's load-bearing for *every* observability surface in the app.

---

## Primary diagram

The full union laid out, with the trichotomy and the consumer points marked.

```
  The AgentEvent discriminated union — full picture

  ┌─ Declaration (lib/mcp/events.ts:4-12) ─────────────────────────────────┐
  │                                                                         │
  │  export type AgentEvent =                                               │
  │    │── annotation ──                                                    │
  │    │   reasoning_step { step: ReasoningStep }                           │
  │    │                                                                    │
  │    │── span boundary ──                                                 │
  │    │   tool_call_start { toolName, agent }                              │
  │    │   tool_call_end   { toolName, agent, durationMs, result?, error? }│
  │    │                                                                    │
  │    │── output ──                                                        │
  │    │   insight        { insight: Insight }                              │
  │    │   diagnosis      { diagnosis: Diagnosis }                          │
  │    │   recommendation { recommendation: Recommendation }                │
  │    │                                                                    │
  │    │── terminal ──                                                      │
  │        done           { }                                               │
  │        error          { message: string }                               │
  └─────────────────────────▲───────────────────────────────────────────────┘
                            │
  ┌─ Encoder (lib/mcp/events.ts:15-17) ──────────────────────────────────┐
  │  encodeEvent(e) = JSON.stringify(e) + '\n'                            │
  │  decodeEvent(line) = JSON.parse(line) as AgentEvent                   │
  └─────────────────────────▲────────────────────────────────────────────┘
                            │  NDJSON line on the wire
  ┌─ Consumers ─────────────┴────────────────────────────────────────────┐
  │                                                                       │
  │  emitter: send(e) in app/api/agent/route.ts:172-175                   │
  │    collected.push(e)                                                  │
  │    controller.enqueue(encoder.encode(encodeEvent(e)))                 │
  │                                                                       │
  │  hooks: hooksFor(agent) in app/api/agent/route.ts:181-195             │
  │    onToolCall  → send({type:'tool_call_start', toolName, agent})      │
  │    onToolResult → send({type:'tool_call_end', durationMs, ...})       │
  │                                                                       │
  │  UI: useInvestigation handle() in lib/hooks/useInvestigation.ts       │
  │    switch (e.type) { …8 cases, exhaustive… }                          │
  │                                                                       │
  │  replay: app/api/agent/route.ts:127-141                               │
  │    for (e of events) enqueue(encodeEvent(e)); sleep(180)              │
  │                                                                       │
  │  snapshot: saveInvestigation in lib/state/investigations.ts:30-41     │
  │    mem.set(id, events: AgentEvent[])                                  │
  └───────────────────────────────────────────────────────────────────────┘
```

---

## Implementation in codebase

### Use cases

Three real moments the union earns its keep:

- **Adding a new agent or output kind.** When you wire `lib/agents/coordinator.ts` or extend the categories, the union tells you exactly what changes: add a variant if there's a new *kind* of output (e.g. `coordinator_plan`); reuse `reasoning_step` if it's just more agent text. Every downstream consumer is forced by the compiler to handle the new variant — there's no place to forget. The compiler is the lint rule.

- **Replaying a captured investigation.** The cache stores `AgentEvent[]`. The replay path iterates the array and calls `encodeEvent(e)` on each one — same function used live. There's no replay-specific code path that could drift; the union enforces shape parity. This is what makes the seed file (`lib/state/demo-investigations.json`) a *real* fixture rather than a brittle JSON blob.

- **The briefing route extends the vocabulary.** `BriefingEvent` (declared locally in `app/api/briefing/route.ts:54–58`) is `AgentEvent` plus three extra variants (`coverage_item`, `insight`, `workspace`). The extension is clean because the shared union stays closed and the extras are scoped to the route. No conflict, no shape drift; the discriminator distinguishes everything.

- **AptKit traces converge onto this same surface.** `BloomingTraceSinkAdapter` (`lib/agents/aptkit-adapters.ts:100`) implements AptKit's `CapabilityTraceSink`. It receives AptKit's `CapabilityEvent`s (`step` / `tool_call_start` / `tool_call_end`) and calls Blooming's existing `onText`/`onToolCall`/`onToolResult` hooks — which emit `reasoning_step`/`tool_call_start`/`tool_call_end` variants on the same NDJSON stream. The system grew a new agent runtime but did NOT grow a new observability surface. One stream, multiple producers; the closed union is what makes that work — AptKit had to map its event types into ours rather than co-existing as a parallel format.

### Code side by side, with a line-by-line read

The declaration — 8 variants, 2 helpers, one file:

```
  lib/mcp/events.ts  (lines 4-22)

  export type AgentEvent =
    | { type: 'reasoning_step'; step: ReasoningStep }                          ← annotation between spans
    | { type: 'tool_call_start'; toolName: string; agent: AgentName }          ← span OPEN
    | { type: 'tool_call_end'; toolName: string; agent: AgentName;             ← span CLOSE + timing
        durationMs: number; result?: unknown; error?: string }
    | { type: 'insight'; insight: Insight }                                    ← briefing output
    | { type: 'diagnosis'; diagnosis: Diagnosis }                              ← diagnostic agent output
    | { type: 'recommendation'; recommendation: Recommendation }               ← recommendation agent output
    | { type: 'done' }                                                         ← clean termination
    | { type: 'error'; message: string };                                      ← failure termination

  /** Encode one event as a single NDJSON line (JSON + '\n'). */
  export function encodeEvent(e: AgentEvent): string {
    return JSON.stringify(e) + '\n';                                           ← framing: one line per event
  }

  /** Decode one NDJSON line into an AgentEvent. */
  export function decodeEvent(line: string): AgentEvent {
    return JSON.parse(line) as AgentEvent;                                     ← consumer trusts the type
  }
        │
        └─ this 8-line union + 3-line helpers IS the protocol. Every layer
           above and below speaks AgentEvent. Drop any variant and you drop
           a row from the observability map — there's nowhere else it's
           recorded. The '\n' terminator in encodeEvent is what makes the
           stream parseable one event at a time.
```

The emitter — where the union becomes wire bytes:

```
  app/api/agent/route.ts  (lines 168-195, abbreviated)

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const collected: AgentEvent[] = [];                                      ← buffer typed as the union
      const send = (e: AgentEvent) => {                                        ← single emission closure
        collected.push(e);                                                     ← write to snapshot buffer
        controller.enqueue(encoder.encode(encodeEvent(e)));                    ← write to wire (NDJSON)
      };
      const stepFor = (agent, kind, content) =>
        send({ type: 'reasoning_step', step: {id, agent, kind, content} });
      const hooksFor = (agent: AgentName) => ({
        onText: (t) => { if (t.trim()) stepFor(agent, 'thought', t); },        ← text → reasoning_step
        onToolCall: (tc) =>
          send({ type: 'tool_call_start', toolName: tc.toolName, agent }),     ← span OPEN
        onToolResult: (tc) =>
          send({                                                                ← span CLOSE
            type: 'tool_call_end',
            toolName: tc.toolName,
            agent,
            durationMs: tc.durationMs ?? 0,                                    ← timing from McpClient
            result: trunc(tc.result),                                          ← capped to 4000 chars
            error: tc.error,
          }),
      });
        │
        └─ every emission is type-checked against the union. The compiler
           rejects any object shape that doesn't match a variant. This is
           what makes the contract enforceable across the route ↔ agent ↔
           UI ↔ cache boundary.
```

The consumer — exhaustive switch in the UI hook:

```
  lib/hooks/useInvestigation.ts  (handle function, abbreviated)

  const handle = (e: AgentEvent) => {
    switch (e.type) {
      case 'reasoning_step':                                                   ← annotation
        setItems(prev => [...prev, toReasoningTraceItem(e.step)]);
        break;
      case 'tool_call_start':                                                  ← span OPEN
        setItems(prev => [...prev, toRunningToolTraceItem(e)]);
        break;
      case 'tool_call_end':                                                    ← span CLOSE
        setItems(prev => replaceRunningTool(prev, e));                         ← positional match
        break;
      case 'diagnosis':       setDiagnosis(e.diagnosis); break;
      case 'recommendation':  setRecs(prev => [...prev, e.recommendation]); break;
      case 'insight':         setInsights(prev => [...prev, e.insight]); break;
      case 'done':            setComplete(true); /* stash to sessionStorage */ break;
      case 'error':           setError(e.message); break;
    }
  };
        │
        └─ tsc enforces exhaustiveness — adding a 9th variant to the union
           breaks compilation here until a case is added. The compiler IS
           the lint rule that keeps every consumer in sync with every emitter.
```

---

## Elaborate

The closed-union + discriminator + exhaustiveness-check combination is the same primitive that underpins Redux/Redux-Toolkit's action types, the Elm Architecture's `Msg` type, Rust's `enum`, Haskell's algebraic data types, and GraphQL's union types. The choice of TypeScript over a runtime validator (Zod, Ajv) trades two things: you get compile-time guarantees (no runtime validator overhead, no schema drift from declaration), at the cost of trusting the JSON parser to deliver well-formed data. The repo accepts that trade because the producer and consumer are *both* this codebase — there's no external producer that could send a malformed event.

What this protocol gets right that ad-hoc event streams miss: the discriminator is *required at the type level*. There's no "untyped fallback" variant that swallows unknown events — if the wire ever delivered a 9th type, `JSON.parse` would still succeed, but the consumer's switch wouldn't handle it (silently dropping the event in production). The exhaustiveness check at compile time prevents this drift entirely — provided every change to the union is paired with a change to the consumers. The git history of `lib/mcp/events.ts` is short because the union has been stable.

What's missing — and worth naming — is *schema versioning*. The captured `AgentEvent[]` in `lib/state/demo-investigations.json` has no version field. If the union grows a required field on an existing variant (say `tool_call_end` gains a mandatory `spanId`), the committed seed deserializes with `spanId: undefined`, which TypeScript can't catch at the boundary because `JSON.parse` lies about the type. The defensive move is either (a) keep all new fields optional, or (b) add a top-level `schemaVersion` to the cache envelope. Today the seed relies on convention (a); the cache provenance envelope discussed in `audit.md` Top-3 finding 3 would fix (b).

NDJSON as the carrier is worth noting separately. SSE (Server-Sent Events) would also work — it has its own event-typing, retry support, and is a W3C standard. NDJSON wins here for one reason: it's lighter (no `event:`/`data:` framing overhead, no reconnection complexity) and it's symmetric (the same shape lives in the cache file). SSE would force a translation layer between live (SSE frames) and replay (JSON array). NDJSON keeps the protocol identical across both paths.

---

## Interview defense

**Q1. Walk me through the AgentEvent union and explain why it's load-bearing.**

8 variants, one discriminator. Three groups: annotations (`reasoning_step`), span boundaries (`tool_call_start`/`tool_call_end`), outputs/terminals (`insight`, `diagnosis`, `recommendation`, `done`, `error`). It's load-bearing because *every observability surface in the app* — live UI render, NDJSON wire transport, cache snapshot, replay path, briefing route extension — consumes or produces the same shape. The compile-time exhaustiveness check (every `switch (e.type)` must cover all 8) is what enforces cross-layer consistency. If I added a 9th variant and forgot to handle it in `useInvestigation`, `tsc` would block the merge. There's no runtime fallback that could silently drop events.

```
  what would break if you dropped this union?
  ───────────────────────────────────────────
  - the trace would become a freeform log (no span pairing, no exhaustive UI render)
  - replay would need a runtime validator (today: cache hits parse without checks)
  - the briefing route's BriefingEvent extension would have no base to extend
  - the route↔UI contract would become "any object with a 'type' field"
                                  ▲
                                  └─ the closed union is what makes this a real protocol
```

**Anchor:** "the compiler IS the lint rule — every consumer is forced into sync with every emitter."

**Q2. NDJSON over SSE — why?**

Two reasons. First, NDJSON is symmetric: the same `JSON.stringify(e) + '\n'` shape lives in the cache file (`lib/state/demo-investigations.json` is a `Record<insightId, AgentEvent[]>`) and on the wire. The replay path iterates the cached array and `encodeEvent`s each one — identical to live. SSE would force a translation layer between SSE frames (live) and a JSON array (cache). Second, NDJSON has no framing overhead (no `event:`/`data:` prefixes, no reconnection protocol), which keeps the encoder one line. The cost: no built-in retry semantics. Acceptable here because the consumer (`useInvestigation`) handles a closed stream as terminal — there's no auto-reconnect to design around.

```
  NDJSON                          SSE
  ─────────────────────────       ───────────────────────────
  {"type":"reasoning_step",…}\n   event: reasoning_step
                                  data: {...}
                                  \n\n

  symmetric with cache file       requires live↔replay translation
  one-line encoder                framing + reconnect logic
  no retry semantics built-in     auto-reconnect on EventSource
```

**Anchor:** the cache file shape is the symmetry argument. "Replay and live speak the same bytes."

---

---

## See also

- `audit.md` — the broader lens audit; this union is named in observability-map and traces-and-request-lifecycles.
- `02-replay-from-snapshot-with-paced-emission.md` — the cache replay path that consumes the same union.
- `03-three-rung-mem-file-seed-store.md` — the persistence layer that stores `AgentEvent[]`.
- `04-dual-write-send-to-stream-and-store.md` — the route handler's `send` closure that emits the union to two destinations at once.
- `06-eval-result-paper-trail.md` (RETIRED) — once a fourth observability surface where eval transcripts post-hoc serialized this same `AgentEvent[]` shape at K-iteration scope. The Olist pipeline that produced those transcripts was removed in PR #8 / 62c24d7; the file is preserved as a historical record of the pattern.
- `.aipe/study-ai-engineering/05-evals-and-observability/04-llm-observability.md` — the same union from the LLM-telemetry angle.
- `.aipe/study-system-design/05-streaming-ndjson.md` — NDJSON as the transport (system-design angle).

---
