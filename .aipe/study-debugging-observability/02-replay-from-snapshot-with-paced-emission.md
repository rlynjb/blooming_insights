# Replay from snapshot with paced emission

**Industry name(s):** deterministic replay, snapshot replay, paced re-emission, fixture-driven replay, time-travel debugging, demo-mode
**Type:** Industry standard · Project-specific (180ms pacing is this repo's choice)

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Replay sits at the *transparent* boundary between live and recorded: the consumer can't tell the difference. In blooming insights, that boundary is `app/api/agent/route.ts:127-141`. When the route receives a request for an `insightId` that's already in the cache, it skips the entire agent loop (no Anthropic call, no MCP call, no creds required) and instead opens a `ReadableStream` that re-emits the captured `AgentEvent[]` at 180ms ticks. The UI consumes it identically to a live run — same hook, same render, same NDJSON parse.

```
  Zoom out — where replay sits in the request flow

  ┌─ UI ──────────────────────────────────────────────┐
  │  useInvestigation fetches /api/agent?insightId=…  │
  │  parses NDJSON, dispatches events                  │
  │  (does NOT know it's replay)                       │
  └─────────────────────────▲─────────────────────────┘
                            │  NDJSON stream
  ┌─ Route handler ─────────┴─────────────────────────┐  ← we are here
  │  cached = getCachedInvestigation(insightId)        │
  │  if (cached) {                                     │
  │    for (e of cached) {                             │
  │      enqueue(encodeEvent(e))                       │
  │      sleep(REPLAY_DELAY_MS = 180)                  │
  │    }                                               │
  │    return ← short-circuit, no live run             │
  │  }                                                 │
  │  else: live agent run + saveInvestigation          │
  └─────────────────────────▲─────────────────────────┘
                            │
  ┌─ Cache (3-rung store) ──┴─────────────────────────┐
  │  mem → .investigation-cache.json → demo seed       │
  │  (read order: first non-null wins)                 │
  └───────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** Replay is a captured event sequence re-emitted on a fresh stream with the same shape, in the same order, on a paced clock. Three properties are non-negotiable for it to count as replay: **typed shape preserved** (same `AgentEvent` variants, no translation), **order preserved** (event N still precedes N+1), and **consumer-transparent** (the consumer's code path doesn't branch on live-vs-replay). The 180ms pacing is the *fourth* property that turns "replay" into "watchable demo" — without it, the cached events would fire all at once and the user-visible experience would be a static result, not a re-creation.

---

## Structure pass

**Layers.** Three: the cache read (`getCachedInvestigation`), the paced re-emit loop (`for (e of events) { enqueue; await sleep(180) }`), and the consumer-transparent carrier (NDJSON over HTTP with the same headers as live).

**Axis: control (who decides what evidence is recorded vs played back?).** Trace it across the layers. At the cache-read layer: the snapshot decides — whatever was captured determines what plays back. At the paced re-emit layer: the constant `REPLAY_DELAY_MS = 180` decides — the original wall-clock timing of the live run is *discarded*, replaced with uniform pacing. At the carrier layer: the carrier decides nothing — it just preserves the bytes. Control shifts dramatically at the seam between cache and replay: the snapshot's original timing is lost; the demo experience is what remains.

**Seams.** Two load-bearing:

- **Cache ↔ paced re-emit.** This is where stored events become a stream again. The cache provides ordered events; the loop adds a pacing clock. The seam matters because *the choice of clock* is what defines what the replay is — paced (uniform 180ms) for demo, instant for a regression test, original-timing for a fidelity-sensitive debug session. Today the codebase chose paced.
- **Re-emit ↔ consumer.** The replay response uses the same `NDJSON_HEADERS` (`Content-Type: application/x-ndjson; charset=utf-8`, `Cache-Control: no-cache, no-transform`) and the same `encodeEvent` as the live path. This is what makes the consumer-transparent guarantee work — there's no header, no protocol marker, no field on any event that says "this is a replay." The UI literally cannot tell.

A *cosmetic-looking but actually load-bearing* third seam: the cache returns `null` for unknown insightIds, and the route falls through to the live run path. That fallthrough is what makes the cache-first pattern non-breaking — adding a new insightId Just Works, it just won't replay until it's been captured at least once.

```
  Structure pass — replay from snapshot

  ┌─ 1. LAYERS ───────────────────────────────────┐
  │  cache read · paced re-emit · carrier          │
  └────────────────────────┬───────────────────────┘
                           │  pick the axis
  ┌─ 2. AXIS ─────────────▼────────────────────────┐
  │  control: who decides what plays back and      │
  │  on what clock?                                │
  └────────────────────────┬───────────────────────┘
                           │  trace, find flips
  ┌─ 3. SEAMS ────────────▼────────────────────────┐
  │  cache ↔ re-emit: stored → streamed (LOAD)     │
  │    the clock choice IS the replay character    │
  │  re-emit ↔ consumer: same NDJSON (LOAD)        │
  │    consumer-transparency guarantee             │
  │  cache miss → live: graceful fallthrough       │
  └────────────────────────┬───────────────────────┘
                           ▼
                   Block 4 — How it works
```

Skeleton mapped. Now walk the replay loop end to end.

---

## How it works

**Mental model.** Replay is *deterministic re-emission of a captured sequence*. The pattern is the same as `requestAnimationFrame` stepping through a pre-recorded animation, Redux DevTools playing back actions, or VCR.py's cassettes replaying HTTP responses. The kernel is three steps: read the captured array, iterate in order, emit each item on a paced clock. The clock choice (paced vs instant vs original-timing) determines whether you've built a demo, a regression test, or a fidelity-replay debugger.

```
  Pattern — the replay loop (kernel)

  read captured array
        │
        ▼
  ┌──────────────────────────┐
  │ for (item of captured):  │   ← order preserved (the array is the order)
  │   emit(item)              │   ← consumer-transparent carrier
  │   await tick()            │   ← the clock IS the character of the replay
  │ close()                   │   ← clean terminal (same as live's controller.close)
  └──────────────────────────┘
        │
        ▼
  consumer renders identically to live (zero branch on live-vs-replay)

  the kernel is six lines. Drop any of them:
    - drop the iteration → no replay
    - drop the order     → not replay, random sample
    - drop the emit      → not replay, silent
    - drop the tick      → replay, but unwatchable (instant flush)
    - drop the close     → consumer stuck "running" forever
    - drop transparency  → not replay, separate code path
```

### Move 2 — walk the parts

**Use cases.** Three real moments replay carries the load:

- **Demo offline.** No Anthropic key, no Bloomreach OAuth, no network. A captured `insightId` from `lib/state/demo-investigations.json` replays cleanly because the route short-circuits before any auth/key check. This is the *whole point* of the demo seed rung — you can clone the repo, `npm run dev`, click the seeded insight, and watch the full investigation play out at the same pace it originally ran.

- **Reproducing a captured bug.** A captured `insightId` produced a bad diagnosis. You replay it (cache hits), scrub the trace, identify the event where the agent went off the rails, change one thing (prompt, tool description, evidence weighting), re-run *live* with the same `insightId` (passing `?live=1`) to see if the change fixed it. The replay path is the diagnosis tool; the `live=1` escape hatch is the verification tool.

- **The split-step UX.** The user clicks "investigate" and the route replays the diagnose-phase events only (`step=diagnose` applies `filterByStep`). Later they click "recommend" and the route replays the recommend-phase events from the *same* cached run. Two requests, one cache hit per request, same `insightId`. The filter inside the replay path makes this work without re-capturing or splitting the cache.

#### The cache-first short-circuit — replay wins when cache hits

The reader anchor: you've written `if (cache.has(key)) return cache.get(key)`. Same shape — but here the "value" being returned is an entire ordered event stream, not a single result. The short-circuit happens *before* any agent setup: no Anthropic key required, no MCP connection required, no auth required. The route's first decision after parsing the query string is "do we have a cached run for this insightId?"

What happens: `getCachedInvestigation(insightId)` reads the 3-rung store (mem → dev file → committed seed). First non-null wins. The route checks `cached && !live` — the `live=1` query param is an escape hatch that forces a fresh run even when the cache would hit, useful for re-capturing or for testing the live path. If `cached` is null (or `live=1`), the route falls through to the full live setup.

Boundary: the cache-first check happens before `process.env.ANTHROPIC_API_KEY` validation. That's deliberate — it's what makes the demo seed work *with no API keys at all*. A fresh clone of the repo can run `npm run dev`, open the app, click a seeded insight, and see a full investigation replay without any credentials. This is the *whole point* of the cache rung.

```
  Cache-first short-circuit — the gate

  request arrives                                    decision
  ───────────────────────────────                    ────────────────────────────────
  GET /api/agent?insightId=ins-7                     cached = getCachedInvestigation(ins-7)
                                                            │
                                                            ▼
  live=1 in query?                                   if (cached && !live) → replay path
                                                     else                  → live run
                                                            │
                                                            ▼
                                                     (no auth check before this point —
                                                      replay needs no creds)
```

**Code in this codebase — the gate.** The first decision after parsing the query:

```
  app/api/agent/route.ts  (lines 125-141)

  // Cache-first: replay a precomputed investigation (no auth/key needed),
  // filtered to the requested step. Query results are never cached.
  const cached = insightId && !live ? getCachedInvestigation(insightId) : null;  ← the gate
  if (cached) {
    const events = step ? filterByStep(cached, step) : cached;                   ← optional slice
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const e of events) {                                                 ← order preserved
          controller.enqueue(encoder.encode(encodeEvent(e)));                    ← same encoder as live
          await new Promise((r) => setTimeout(r, REPLAY_DELAY_MS));              ← 180ms tick
        }
        controller.close();                                                       ← clean terminal
      },
    });
    return new Response(stream, { headers: NDJSON_HEADERS });                    ← same headers as live
  }
        │
        └─ this 15-line block IS the replay. It short-circuits before
           ANTHROPIC_API_KEY validation, before MCP setup, before agent
           construction — nothing past line 141 runs on a cache hit.
```

**Code in this codebase — the cache read it relies on.** First non-null wins across 3 rungs:

```
  lib/state/investigations.ts  (lines 22-28)

  export function getCachedInvestigation(insightId: string): AgentEvent[] | null {
    if (mem.has(insightId)) return mem.get(insightId)!;                          ← rung 1: process mem
    const fromFile = PERSIST ? readJson(CACHE_FILE)[insightId] : undefined;      ← rung 2: dev file
    if (fromFile) return fromFile;
    const fromDemo = readJson(DEMO_FILE)[insightId];                             ← rung 3: committed seed
    return fromDemo ?? null;                                                      ← null → live run path
  }
        │
        └─ returns AgentEvent[] (typed) or null. The null path is what
           lets the replay gate fall through to the live setup. The
           typed return is what lets the for-loop iterate without
           runtime validation — TypeScript trusts the cache shape
           because the union is closed.
```

#### The paced re-emit loop — six lines that ARE the replay

The reader anchor: you've used `setTimeout` inside a loop to throttle work. Same shape — but here the consumer is a `ReadableStream`'s controller, not a local function, and the work is "emit one NDJSON line every 180ms."

What happens: a fresh `ReadableStream` is created with an async `start(controller)` callback. Inside, a for-loop iterates the cached events. Each event is encoded with the same `encodeEvent` the live path uses (`JSON.stringify(e) + '\n'`), encoded again as `Uint8Array` via `TextEncoder`, enqueued on the controller, and the loop awaits a 180ms `setTimeout` before the next iteration. When the array exhausts, `controller.close()` ends the stream.

Boundary: the 180ms is hard-coded. A captured run that had bursty original timing (3 events in 50ms, then a 10s pause) replays as uniform 180ms ticks. Original timing fidelity is lost. For a *demo* this is correct (the user wants a watchable pace, not the real timing). For a *debugging session* where the original pause was diagnostically interesting, it's wrong. There's no toggle today; a small extension would be `REPLAY_FIDELITY = 'paced' | 'original'` driven by a query param.

```
  Paced re-emit loop — the kernel

  app/api/agent/route.ts:131-138

  async start(controller) {
    for (const e of events) {                                 ← order preserved
      controller.enqueue(encoder.encode(encodeEvent(e)))     ← same encoder as live
      await new Promise(r => setTimeout(r, REPLAY_DELAY_MS)) ← 180ms tick
    }
    controller.close()                                        ← clean terminal
  }
                              ▲
                              │
                              └─ six lines. Drop the await and you have
                                 "instant flush" — UI sees a wall of events
                                 in one tick, looks broken. The 180ms is
                                 what makes it look like a real run.
```

**Code in this codebase — the constant that defines the replay's character:**

```
  app/api/agent/route.ts  (line 105)

  const REPLAY_DELAY_MS = 180;
                          │
                          └─ 180ms isn't a hyperparameter to tune for
                             performance — it's a UX choice. Faster
                             feels canned, slower feels laggy. Drop the
                             await entirely and the cached events flush
                             in one tick; the UI looks broken.
```

#### Optional step filtering — replay a slice of the run

The reader anchor: you've used `Array.prototype.filter` to slice a list. Same shape — applied to the cached events when the request asks for a specific step (`step=diagnose` or `step=recommend`).

What happens: if the query string has `step`, the route applies `filterByStep(cached, step)` before iterating. The filter scopes the replay to just the diagnose-phase events or just the recommend-phase events. This is what powers the split-step UX in the UI — the user clicks "investigate" and the diagnose phase replays alone; later they click "recommend" and the recommend phase replays from the same cached run.

Boundary: filtering breaks ordering only in the sense that the events from the other phase are absent. Within a filtered slice, original order is preserved. The `done` event is shared across both phases (it's the terminal of the combined run), so `filterByStep` includes it in both — this is what lets the UI's `complete = true` flip work on either step path.

#### The carrier — same NDJSON, same headers, same encoder

The reader anchor: you've returned a `Response` with `Content-Type: text/event-stream` for SSE. Replay does the same shape with `application/x-ndjson` — and uses the *exact* same constant (`NDJSON_HEADERS`) the live path uses. There's no replay-specific Content-Type, no `X-Replay: true` header, no marker on the wire.

What happens: `return new Response(stream, { headers: NDJSON_HEADERS })`. The consumer's `fetch().body.getReader()` works identically. The `TextDecoder` + `split('\n')` parse path runs the same. The `JSON.parse(line) as AgentEvent` cast trusts the type the same. Every layer downstream of the route is unchanged.

Boundary: this transparency is the *feature*. If a future requirement asks the UI to render a "replaying captured run from <date>" banner, you'd need to either embed metadata in the events (the snapshot provenance envelope from `audit.md` Top-3 finding 3) or add an out-of-band header. Today, the consumer-transparent guarantee is intact; there's no in-band signal that this is replay.

```
  Carrier — wire bytes, live vs replay

  live:                                          replay:
  ─────────────────────────────────              ─────────────────────────────────
  send(e) → push + enqueue                       for (e of cached)
                                                   enqueue(encodeEvent(e))
                                                   await sleep(180)
                                                 close()

  Response headers (live):                       Response headers (replay):
    'Content-Type':                                'Content-Type':
      'application/x-ndjson; charset=utf-8'          'application/x-ndjson; charset=utf-8'
    'Cache-Control':                               'Cache-Control':
      'no-cache, no-transform'                       'no-cache, no-transform'

  IDENTICAL. The consumer cannot distinguish.
```

**Code in this codebase — the shared headers.** The consumer-transparency guarantee made explicit:

```
  app/api/agent/route.ts  (lines 107-110)

  const NDJSON_HEADERS = {
    'Content-Type': 'application/x-ndjson; charset=utf-8',                       ← used by BOTH live and replay
    'Cache-Control': 'no-cache, no-transform',                                   ← same in both paths
  };
        │
        └─ the constant is named NDJSON_HEADERS (not LIVE_HEADERS or
           REPLAY_HEADERS) because it's the same headers either way.
           The naming itself is the transparency guarantee.
```

#### Move 3 — the principle

Replay earns its name when the consumer can't tell. That guarantee — same shape, same order, same carrier — is what separates *replay* from *re-run* or *show-me-a-fixture*. The 180ms pacing is a deliberate stylistic choice for *this* codebase's demo character; the choice itself is interchangeable, but the discipline of having one clock policy and applying it uniformly is non-negotiable. The lesson generalises: design replay-from-snapshot so the consumer's code path is the same as live. Once it is, the snapshot becomes a true reproduction primitive — any bug you can capture, you can replay; any demo you've recorded, you can ship in a JSON file.

---

## Primary diagram

The full replay path, gate-to-close, with file:line markers.

```
  Replay from snapshot — full path

  request: GET /api/agent?insightId=ins-7
  ──────────────────────────────────────────────────────────────────────────

  ┌─ Gate (app/api/agent/route.ts:125-127) ──────────────────────────────┐
  │  cached = insightId && !live ? getCachedInvestigation(insightId) : null │
  │                          ▲                                              │
  │                          └─ ?live=1 query param forces fresh run        │
  └─────────────────────────▲────────────────────────────────────────────┘
                            │ cache hit
  ┌─ Optional step filter (route.ts:129) ────────────────────────────────┐
  │  events = step ? filterByStep(cached, step) : cached                  │
  │                  ▲                                                     │
  │                  └─ "diagnose" or "recommend" slices the array        │
  └─────────────────────────▲────────────────────────────────────────────┘
                            │
  ┌─ Re-emit loop (route.ts:131-138) ────────────────────────────────────┐
  │  stream = new ReadableStream({                                        │
  │    async start(controller) {                                          │
  │      for (const e of events) {                                        │
  │        controller.enqueue(encoder.encode(encodeEvent(e)))             │
  │        await new Promise(r => setTimeout(r, 180))   ← REPLAY_DELAY_MS │
  │      }                                                                │
  │      controller.close()                                               │
  │    },                                                                 │
  │  })                                                                   │
  └─────────────────────────▲────────────────────────────────────────────┘
                            │ NDJSON over HTTP, same headers as live
  ┌─ Response (route.ts:140) ────────────────────────────────────────────┐
  │  return new Response(stream, { headers: NDJSON_HEADERS })             │
  └─────────────────────────▲────────────────────────────────────────────┘
                            │
  ┌─ Consumer (lib/hooks/useInvestigation.ts) ──────────────────────────┐
  │  fetch().body.getReader() → TextDecoder → split('\n')                │
  │  for each line: JSON.parse → handle(e: AgentEvent)                   │
  │  switch (e.type) { … 8 cases, identical to live … }                  │
  │  → CANNOT distinguish live vs replay                                  │
  └──────────────────────────────────────────────────────────────────────┘
```

---

## Elaborate

The replay-from-snapshot pattern blooming insights uses is the same shape as VCR.py's cassette tapes (HTTP requests captured to YAML, replayed in tests), Redux DevTools' time-travel (action sequence replayed against a fresh reducer), and Chrome DevTools' HAR import (network requests replayed as if they fired now). The common thread: capture a *typed sequence* at a chosen boundary, store it portably, and design the consumer so it can't tell capture from replay. VCR uses HTTP requests as the boundary; Redux uses actions; blooming insights uses `AgentEvent`s.

What this pattern gets right that even bigger systems often miss: the clock policy is *explicit*. The 180ms tick is a named constant (`REPLAY_DELAY_MS`) in one place; if you ever wanted to change the policy, you change one line. Many replay systems either inherit the original timing (which is sometimes too fast or too jittery) or flush instantly (which is sometimes unwatchable). Choosing a *uniform* paced policy and naming it as a constant is a deliberate UX move — it says "this is a watchable demo, not a fidelity-replay debugger."

What's missing — and worth naming — is *original-timing replay* as an option. A captured run with a 10s pause between events (e.g. an agent waiting for a slow MCP call) loses that pause information on replay. A `REPLAY_FIDELITY = 'paced' | 'original'` query param would close this gap; the implementation would record `tsRelative: number` on each captured event (delta from start) and replace the `setTimeout(180)` with `setTimeout(e.tsRelative - prevTs)`. The schema change is the cache provenance envelope (`audit.md` Top-3 finding 3); the runtime change is one branch in the loop.

Worth noting separately: replay here is *server-side*. The route handler iterates and paces; the client just consumes the stream. An alternative architecture would be *client-side* replay — ship the full `AgentEvent[]` as a JSON payload, let the client iterate and pace. The server-side choice is correct for this repo because (a) the same `useInvestigation` hook reads live and replay (no client-side replay logic needed), and (b) the 180ms pacing is a *server-enforced* property — clients can't accidentally render the whole array at once if the server controls the clock. Two reasons; both load-bearing.

---

## Interview defense

**Q1. Walk me through what makes this replay rather than just "loading a fixture."**

Three properties. (1) **Typed shape preserved** — replay emits the same `AgentEvent` variants the live path emits, encoded with the same `encodeEvent`. No translation, no replay-specific shape. (2) **Order preserved** — the for-loop iterates the cached array in order; event N still precedes N+1. (3) **Consumer-transparent** — the route returns the same `Content-Type: application/x-ndjson` headers, the UI's `useInvestigation` hook runs the same `switch (e.type)`, no branch anywhere checks "am I replaying?". Plus a fourth UX property: **paced re-emission** — a 180ms `setTimeout` between events makes the replay *watchable* (the live experience), rather than a static result. Drop the pacing and the cached events flush in one tick; drop the transparency and it becomes a separate code path that drifts.

```
  fixture (NOT replay)              replay
  ──────────────────────────        ──────────────────────────────────
  return cached as JSON             return ReadableStream
  client renders all at once        client renders one event at a time
  separate "fixture view" code      same useInvestigation handle()
  no order guarantee                for (e of events) ← order = array order
  no pacing                         await sleep(180)
                                    ▲
                                    └─ pacing IS the watchable-demo property
```

**Anchor:** "the consumer can't tell live from replay — that's the whole guarantee."

**Q2. The 180ms pacing erases original timing. Defend or attack that choice.**

Defend: the cache is a *demo* primitive first. A user clicking "investigate" expects to *watch the agent think*; uniform 180ms ticks deliver that experience reliably regardless of what the original wall-clock timing was. Captured runs with bursty original timing (3 events in 50ms, then a 10s pause) would replay as either a confusing flash or an apparently-hung tab — neither is a good demo. The 180ms choice is consciously UX-first.

Attack: for *debugging* a captured run, the original pause IS the diagnostic signal. "The agent paused 30s here" tells you something the uniform replay erases. A `REPLAY_FIDELITY = 'paced' | 'original'` query param would close this gap; the implementation is one new optional field on the snapshot (`tsRelative: number`) and one branch in the loop. The current code chose pacing because the dominant use case is demo, not debug — but the choice is *one line of code* away from being configurable. Naming the trade-off and the small cost-to-flip is the credibility signal.

```
  current (paced)                   proposed (configurable)
  ─────────────────────────         ──────────────────────────────────
  await sleep(180)                  await sleep(
                                      fidelity === 'original'
                                        ? e.tsRelative - prevTs
                                        : 180
                                    )
  cost: one constant                cost: one new field on the snapshot
                                          + one branch in the loop
```

**Anchor:** name the dominant use case (demo) and the small cost-to-flip — that's the difference between "deferred for a reason" and "broken by oversight."

---

---

## See also

- `audit.md` — the broader lens audit; this pattern is named in reproduction-and-evidence and traces-and-request-lifecycles.
- `01-ndjson-agentevent-discriminated-union.md` — the typed shape replay preserves.
- `03-three-rung-mem-file-seed-store.md` — the cache the replay reads from.
- `04-dual-write-send-to-stream-and-store.md` — the dual-write that produced the snapshot the replay consumes.
- `06-eval-result-paper-trail.md` (RETIRED) — replay-from-snapshot operates on ONE request's events; the eval surface once operated on K iterations of the same shape across a fixture. Same primitive, different scope. The eval surface is gone from this repo (PR #8 / 62c24d7); the pattern teaches the K-iteration scope.
- `.aipe/study-ai-engineering/05-evals-and-observability/04-llm-observability.md` — same replay flow from the LLM-observability angle.
- `.aipe/study-system-design/05-streaming-ndjson.md` — the NDJSON carrier (system-design angle).

---
