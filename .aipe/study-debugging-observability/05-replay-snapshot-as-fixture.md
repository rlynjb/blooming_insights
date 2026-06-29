# 05 — Replay snapshot as fixture

*Industry standard pattern: record-and-replay (capture a real production trace as a committed fixture, replay it deterministically over the same wire contract)*

## Zoom out — where this concept lives

The same NDJSON stream that observes a live run (file 01) also reproduces a recorded one. The recording is a JSON file (`lib/state/demo-insights.json` and `lib/state/demo-investigations.json`) committed to the repo. The replay is the same route, the same encoder, the same `AgentEvent` union — driven by `?demo=cached` (briefing) or by a cache-hit (agent). One observability surface, two sources: live data or recorded data, indistinguishable to the UI.

```
  Zoom out — replay, in the stack

  ┌─ UI layer ────────────────────────────────────────────────┐
  │  StatusLog + ReasoningTrace (cannot tell live from replay) │
  └────────────────────────┬───────────────────────────────────┘
                           │  NDJSON (same wire contract either way)
  ┌─ Service layer ────────▼───────────────────────────────────┐
  │  /api/briefing, /api/agent                                  │
  │  ┌─ branch 1: live ──┐  ┌─ branch 2: ★ REPLAY ★ ─────────┐  │
  │  │ run agents,        │  │ readFileSync(demo-*.json),    │  │ ← we are here
  │  │ encodeEvent(e),    │  │ filterByStep, encodeEvent(e), │  │
  │  │ enqueue            │  │ enqueue, REPLAY_DELAY_MS pause│  │
  │  └────────────────────┘  └───────────────────────────────┘  │
  └─────────────────────────────────────────────────────────────┘
  ┌─ Storage layer ───────────────────────────────────────────┐
  │  lib/state/demo-insights.json (committed)                  │
  │  lib/state/demo-investigations.json (committed)            │
  └────────────────────────────────────────────────────────────┘
```

Zoom in — the concept. The capture path (`app/api/mcp/capture-demo/route.ts`, dev-only) runs the live briefing + each investigation once and writes the resulting `AgentEvent[]` to two JSON files. The replay path reads those files and re-emits the events through the same NDJSON encoder, with `REPLAY_DELAY_MS` pauses between events so the UI reveals progressively. The per-step filter (`filterByStep`) lets the investigation route replay just the diagnose or just the recommend portion of a combined recording.

## Structure pass

Axis: **what is the source of truth for what the UI shows?**

- Live mode: the source is the agent's actual reasoning, generated turn-by-turn against real Bloomreach + Anthropic.
- Replay mode: the source is a captured `AgentEvent[]` array in a committed JSON file.

Seam: the boundary where the answer flips is *inside* the route, at the top of `start(controller)`. The route checks the `?demo=cached` query param (briefing) or `getCachedInvestigation(insightId)` returning non-null (agent) and branches into the replay path. Below that branch, both paths emit the same `AgentEvent` shape, with the same encoder, into the same `controller.enqueue`. The UI cannot tell which branch it's reading.

## How it works

### Move 1 — the mental model

You know how Cypress's `cy.intercept` can record real API responses and replay them later for deterministic tests? Same idea, except the "intercept" is the route itself, the "recording" is a committed JSON file, and the "playback" is rendered into the production UI — so a presentation demo doesn't need live credentials.

```
  Pattern — record and replay, with the wire format as the recording format

  capture run (dev only):
    live route emits  ─┐
                       │
    const collected = []
    const send = (e) => { collected.push(e); enqueue(encodeEvent(e)) }
                       │
                       ▼
    on done: saveInvestigation(id, collected)
                       │
                       ▼
    .investigation-cache.json (dev cache)
                       │
                       │  manually committed via capture-demo route
                       ▼
    lib/state/demo-investigations.json (committed)

  replay run (any time, no creds):
    GET /api/agent?insightId=foo
                       │
                       ▼
    const cached = getCachedInvestigation(insightId)
    if (cached) {
      for (e of filterByStep(cached, step)) {
        enqueue(encodeEvent(e))                ← same encoder as live
        await sleep(REPLAY_DELAY_MS)            ← preserve pacing
      }
    }
```

The trick: the wire format IS the recording format. There is no separate "fixture format" with adapter code in between. `encodeEvent` is the canonical serializer for both the live wire and the replay wire; the events stored in the JSON file are exactly the events that would have been emitted live.

### Move 2 — step by step

#### The captured shape — the `AgentEvent[]` array

`lib/state/investigations.ts:30-41`:

```ts
export function saveInvestigation(insightId: string, events: AgentEvent[]): void {
  mem.set(insightId, events);
  if (PERSIST) {
    const all = readJson(CACHE_FILE);
    all[insightId] = events;
    try { writeFileSync(CACHE_FILE, JSON.stringify(all)); } catch {}
  }
}
```

The cache file shape is `Record<insightId, AgentEvent[]>` — a flat map from insight ID to the array of events emitted during that investigation. The same shape applies to `demo-investigations.json` (the committed version) and `.investigation-cache.json` (the gitignored dev version).

Bridge: this is just "stringify the wire and dump it to disk." If you've ever recorded a chat transcript by appending each message to a JSON file, this is the same idea — except the "messages" are the agent's reasoning steps + tool calls, and the file format is a typed array.

What breaks if the shape drifts: the demo replay starts emitting events with unknown variants and the UI's `switch` hits the `default: break` case at `lib/hooks/useInvestigation.ts:148-150`. The trace is partial; some events are silently dropped. The contract that protects this is the `AgentEvent` union itself — every captured event must round-trip through `decodeEvent → encodeEvent` without loss. The codec round-trip tests at `test/mcp/events.test.ts:11-41` are the guard.

#### The dual-write closure — how live runs become recordings

`app/api/agent/route.ts:186-190`:

```ts
const collected: AgentEvent[] = [];
const send = (e: AgentEvent) => {
  collected.push(e);
  controller.enqueue(encoder.encode(encodeEvent(e)));
};
```

Three lines that make replay possible. Every event the route emits to the wire is also pushed into `collected`. At the end of a combined investigation run, `saveInvestigation(insightId!, collected)` (`app/api/agent/route.ts:302`) writes the buffer to the dev cache. The next time the same insight is requested, the cache-first branch at `app/api/agent/route.ts:124-142` serves from `collected`.

The condition `if (step == null) saveInvestigation(…)` is the load-bearing detail. Only the *combined* run (diagnose + recommend in one go, used by the capture path) is saved. The per-step runs (the normal user flow, where the user clicks "investigate" and then later "see recommendations") are NOT saved — they're handed off via the client's sessionStorage instead. This avoids saving partial recordings; only complete captures land in the cache.

What breaks if `collected` and `enqueue` drift: the recording diverges from the wire. The demo replay shows events the live run wouldn't, or omits events it would. The closure shape (push-and-enqueue in one function) is what prevents drift — every emission goes through `send`, every `send` does both.

#### The cache-first branch — the replay path

`app/api/agent/route.ts:124-142`:

```ts
const cached = insightId && !live ? getCachedInvestigation(insightId) : null;
if (cached) {
  const events = step ? filterByStep(cached, step) : cached;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const e of events) {
        if (req.signal.aborted) break;
        controller.enqueue(encoder.encode(encodeEvent(e)));
        await new Promise((r) => setTimeout(r, REPLAY_DELAY_MS));
      }
      controller.close();
    },
  });
  return new Response(stream, { headers: NDJSON_HEADERS });
}
```

Four moves:

1. Look up the cached events for this insight ID. Hits in memory first, then the dev cache file, then `lib/state/demo-investigations.json` (committed).
2. If a step filter is present, narrow the events with `filterByStep`. Otherwise serve the combined recording.
3. Iterate the events, encoding each through the same `encodeEvent`, enqueuing into the controller. The encoder is identical to the live path's.
4. Sleep `REPLAY_DELAY_MS` (180ms) between events so the UI reveals progressively instead of dumping the entire trace in one frame.

The cancellation check (`req.signal.aborted`) inside the loop is what makes the replay respect a tab close — otherwise a closed tab would keep the replay iterating server-side until the array is exhausted.

What breaks if `REPLAY_DELAY_MS` is zero: the entire trace arrives in one tick. The UI's progressive-reveal animations don't fire, scroll position lurches, and the demo looks worse than the live version. The pacing preserves the *feel* of a live run; without it, the replay is technically correct but experientially wrong.

#### The per-step replay filter — `filterByStep`

`app/api/agent/route.ts:64-82`:

```ts
function filterByStep(events: AgentEvent[], step: Step): AgentEvent[] {
  return events.filter((e) => {
    const agent =
      e.type === 'reasoning_step' ? e.step.agent
      : e.type === 'tool_call_start' || e.type === 'tool_call_end' ? e.agent
      : null;
    if (step === 'diagnose') {
      if (e.type === 'recommendation') return false;
      if (agent === 'recommendation') return false;
      return true;
    }
    if (e.type === 'diagnosis') return false;
    if (agent && agent !== 'recommendation') return false;
    return true;
  });
}
```

The snapshot is a combined diagnose+recommend stream (the only thing the capture path records). The user's flow is two separate steps — step 2 is diagnose, step 3 is recommend. The filter splits the combined recording into the per-step slices.

The filter's discriminator is the `agent` field on the events that carry one. `diagnostic` and `coordinator` events belong to the diagnose step; `recommendation` events belong to the recommend step. The terminal `diagnosis` and `recommendation` payload events are bucketed to their respective steps (a `recommendation` event is filtered OUT of the diagnose stream; a `diagnosis` event is filtered OUT of the recommend stream).

Bridge: this is just `array.filter` with a discriminator. The discriminator is interesting because it derives the agent from three different event shapes — the closure inside `.filter` does the variant-narrowing work the union enables.

What breaks if the discriminator misses a variant: a new event type that doesn't carry an agent field gets bucketed to BOTH steps (the function's default is `return true` in the diagnose branch). The fix is to update the filter when the `AgentEvent` union grows — there's no compile-time enforcement, just the integration tests.

#### The briefing replay — a slightly different shape

`app/api/briefing/route.ts:86-152`. The briefing snapshot is richer than just `AgentEvent[]` — it includes the workspace summary, the coverage report, the trace items (with a custom `kind` field), and the final insights. The replay emits these in a specific order to match the live event sequence:

1. `workspace` event (with `projectName`, `totalCustomers`, `totalEvents`).
2. A reasoning step narrating the schema-gate decision, then alternating `reasoning_step` + `coverage_item` events for each category (so the coverage grid fills in step with the checklist).
3. The recorded trace items — `tool_call_start` + `tool_call_end` for each captured EQL call, interleaved with reasoning steps for the agent's prose.
4. One `insight` event per recorded insight.
5. A final `done` event.

The replay path's `REPLAY_DELAY_MS` is 140ms (slightly faster than agent's 180ms). The faster pace matches the briefing's higher event count — without it the briefing replay would feel slow.

### Move 3 — the principle

**When the wire format is stable enough to serve as a fixture format, recording becomes free.** The temptation is to invent a separate "test fixture" or "demo data" format and adapter code in between. The cost is that the fixture drifts from the wire, and a wire format change requires an adapter update. By using the wire format as the fixture format, every wire format change forces a fixture update (because the captured events stop round-tripping cleanly) — and every captured live run is a future fixture for free. The constraint is that the wire format must be type-stable and side-effect-free; the payoff is that the same code path serves both production and recording.

## Primary diagram

```
  record and replay, end to end

  ───── PHASE A: capture (dev only, one-off via /api/mcp/capture-demo) ─────
  live agent run
   │
   ▼
  send = (e) => { collected.push(e); enqueue(encodeEvent(e)) }
   │
   ▼  on done event
  saveInvestigation(insightId, collected)
   │
   ▼
  writeFileSync(.investigation-cache.json, …)        ← dev cache
   │
   ▼  manual: copy to committed snapshot
  git add lib/state/demo-investigations.json

  ───── PHASE B: replay (any time, no creds) ─────
  GET /api/agent?insightId=foo&step=diagnose
   │
   ▼
  getCachedInvestigation(foo)
    → mem.get('foo')                ← in-memory hit (same warm instance)
    → .investigation-cache.json     ← dev cache hit
    → demo-investigations.json      ← committed snapshot hit
   │
   ▼
  filterByStep(events, 'diagnose')   ← drop recommendation-phase events
   │
   ▼
  for each event:
    if (req.signal.aborted) break
    controller.enqueue(encoder.encode(encodeEvent(e)))   ← same encoder as live
    await sleep(REPLAY_DELAY_MS)                          ← preserve pacing
   │
   ▼
  Response { Content-Type: application/x-ndjson }
   │
   ▼
  UI: indistinguishable from a live run
```

## Elaborate

Where this pattern comes from: record-and-replay is older than HTTP — JVM bytecode replay debuggers, gdb's `record` command, Mozilla's `rr`. The web version comes from VCR (Ruby), VCRPy (Python), Nock + nock-record (Node), Polly.js — all of them solve "save real API responses, replay them in tests." This repo's variant uses the wire format itself (NDJSON of `AgentEvent`) as the recording format, which means no adapter code and no fixture-vs-wire drift. The cost is that the wire format becomes load-bearing for the test fixtures too; the payoff is that the contract collapses.

Adjacent concepts: the dev cache (`.investigation-cache.json`) is the "scratch" version of this pattern — used during development to avoid re-running a slow live investigation when you're iterating on UI code. The committed snapshot (`lib/state/demo-*.json`) is the "release" version — locked in for demos and presentations. The two layers serve different audiences but share the same shape.

What to read next: the dev capture-demo route at `app/api/mcp/capture-demo/route.ts` is the third half of this — it's the script that orchestrates a fresh capture. It runs the live briefing, then for each insight runs a combined investigation, writes both files to the committed paths, and is invoked by the dev-only "capture this as the demo snapshot" button in the UI. The complete record-and-replay loop is: button → capture-demo route → commit → demo replay.

## Interview defense

**Q: Why not use vitest snapshot tests for the demo data?**

Snapshot tests are for regression detection — "did this output change unexpectedly?" The demo snapshots are for *use* — "let the UI render this exact recording as the default presentation mode." Different purpose, different audience. Vitest snapshots are gitignored in many setups (or committed but rarely read); the demo snapshots are first-class production data that the route reads on every demo request. Also, the demo data is loaded at *runtime* (in the route handler), not at test-discovery time, so the snapshot system doesn't apply. Anchors: `lib/state/demo-investigations.json` (committed), `app/api/agent/route.ts:124-142` (runtime load).

**Q: What happens if the AgentEvent union grows a new variant and the committed snapshot is now stale?**

Three outcomes possible:

```
  scenario                            what happens
  ──────────────────────────────────  ──────────────────────────────
  new variant has optional fields     replay still works; old events
  only (additive change)              don't carry the new field, UI's
                                      switch case is added but its
                                      branch never fires for old events

  new variant added to union          replay still works; the case
  (e.g. 'cache_hit')                  never fires (no old event has
                                      type:'cache_hit'); UI handles
                                      future events but old ones still
                                      replay fine

  existing variant renamed or its     replay BREAKS; the UI's switch
  required fields changed             hits the wrong case or its case
                                      reads missing fields → TypeError
                                      or silent UI miss
```

The first two are safe — they're the normal evolution of a type union. The third is a breaking change and requires a fresh capture. The "what must not change" list in the project's AGENTS.md context explicitly names the `AgentEvent` NDJSON contract as a load-bearing surface — that's the constraint that protects the snapshot's longevity. Anchors: `lib/mcp/events.ts:4-12`, project context note "The `AgentEvent` NDJSON contract (route producers + UI consumers depend on it)."

**Q: Why is the recording path NOT used in the per-step user flow — only in the combined capture?**

Because the per-step user flow already has a faster handoff: sessionStorage. When the user clicks "investigate" on the feed, the diagnose step runs live and stashes its result in `bi:inv:diagnose:<id>` in sessionStorage. When the user then clicks "see recommendations," the recommend step runs with the stashed diagnosis passed forward — no need to re-run diagnose. The `useInvestigation` hook at `lib/hooks/useInvestigation.ts:51-62` reads from this stash on re-mount and back-nav.

Saving each per-step run to the investigation cache would *also* work, but it's not necessary for the UX (the sessionStorage path is faster) and it's not necessary for the demo (the demo runs the combined path that does save). Adding it would mean two cache write paths and two reasons to invalidate; one path is simpler. Anchors: `app/api/agent/route.ts:300-302` (only combined runs save), `lib/hooks/useInvestigation.ts:51-145` (sessionStorage handoff).

## See also

- `01-ndjson-reasoning-trace.md` — the wire contract that this file's recording rides on. The recording shape *is* the wire shape.
- `02-per-request-phase-log.md` — the phase log is the one signal that does NOT appear in replays (replay deliberately doesn't fake server work). When debugging a UI bug from a replay, the phase log won't help; when debugging from a live run, it will.
- `lib/state/investigations.ts` — the dev cache + committed snapshot read/write layer.
- `app/api/mcp/capture-demo/route.ts` — the orchestrator that produces fresh snapshots.
- `study-system-design/08-demo-replay-as-reliability.md` — the same mechanism viewed through the system-design lens (the *where* in the architecture, not the *evidence* it produces).
