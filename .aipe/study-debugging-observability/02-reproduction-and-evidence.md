# Reproduction and evidence

**Industry name(s):** minimal reproduction, deterministic replay, evidence collection, hypothesis testing
**Type:** Industry standard · Language-agnostic

> blooming insights has an unusually strong reproduction primitive: a captured investigation replays from `lib/state/demo-investigations.json` deterministically, with no MCP/Anthropic credentials needed, paced at 180ms per event so the UI animates identically to a live run. That means a bug in the investigation flow can be re-created on any machine, off network, in the exact event order it originally occurred. The flake-fix in commit `e83a8e0` is the canonical worked example of "reproduce, isolate, verify" in this repo.

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Reproduction sits at the boundary between "the bug happened" and "I can show you the bug." In blooming insights, that boundary is unusually thin because the investigation cache stores the entire event stream — not just the final output. You don't need the user's account, the user's data, or even the network; you replay the captured `AgentEvent[]` and watch it happen again.

```
  Zoom out — where reproduction sits in the flow

  ┌─ UI (the user clicks "investigate") ─────────────┐
  │  useInvestigation hydrates from sessionStorage    │
  │  OR fetches /api/agent?insightId=…                │
  └─────────────────────────▲────────────────────────┘
                            │  NDJSON stream
  ┌─ Route handler ─────────┴────────────────────────┐
  │  cache-first: getCachedInvestigation → replay     │
  │  else: live agent run → saveInvestigation         │
  └─────────────────────────▲────────────────────────┘
                            │
  ┌─ Reproduction surface ──┴────────────────────────┐  ← we are here
  │  ★ lib/state/demo-investigations.json (seed) ★    │
  │  ★ .investigation-cache.json (dev) ★              │
  │  ★ mem map (process) ★                            │
  └──────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** Reproduction = re-creating the conditions that produced the bug, with the smallest possible delta from the real run. In a typical web app that means: same data, same auth, same browser, same network. In blooming insights, all of that collapses to "load the right `insightId` and the cache replays the recorded events." The strength is the demo seed (committed, always present). The gap is everything that doesn't go through the investigation cache — the briefing flow uses a separate replay path, and the free-form query flow has no replay at all.

---

## Structure pass

**Layers.** Three layers carry reproduction: (1) the live run that captures the trace, (2) the cache that stores it, (3) the replay that streams it back. Each layer can fail independently.

**Axis: control (who decides what evidence gets recorded?).** Trace it across the layers and watch the answer flip. Live run: the agent loop decides (every hook fire = one event captured). Cache: the route handler decides (`saveInvestigation` is called only on the combined-run path, not the split-step path — see `app/api/agent/route.ts:254`). Replay: the cached seed decides (whatever was captured, replays). The control axis shifts hands at each layer — the bugs that bite are the ones where control was *supposed* to record but didn't (the most common: forgetting to wrap a path in `saveInvestigation`).

**Seams.** The load-bearing one is between live run and cache: `saveInvestigation(insightId, collected)` is the single function call that lifts the trace out of request scope. Without it, the run dies with the request and reproduction is impossible. A second seam, cosmetic-looking but actually load-bearing: the 180ms `REPLAY_DELAY_MS` between cached events (`route.ts:105`). Without it, the cached events would fire all at once and the UI's "watching the agent think" experience would be gone — replay would look like a static result, not a re-creation.

```
  Structure pass — reproduction and evidence

  ┌─ 1. LAYERS ───────────────────────────────────┐
  │  live run · cache · replay                     │
  └────────────────────────┬───────────────────────┘
                           │  pick the axis
  ┌─ 2. AXIS ─────────────▼────────────────────────┐
  │  control: who decides what evidence is         │
  │  recorded at this layer?                       │
  └────────────────────────┬───────────────────────┘
                           │  trace, find flips
  ┌─ 3. SEAMS ────────────▼────────────────────────┐
  │  live↔cache:  agent loop → route → snapshot    │
  │    (LOAD-BEARING: saveInvestigation IS the     │
  │     bridge)                                    │
  │  cache↔replay: file → ReadableStream + 180ms   │
  │    (LOAD-BEARING: pacing keeps replay realistic)│
  └────────────────────────┬───────────────────────┘
                           ▼
                   Block 4 — How it works
```

Skeleton mapped — now walk the reproduction loop.

---

## How it works

**Mental model.** A reproduction is a *recording you can re-play*, like the `record/replay` mode in Chrome's network tab or the time-travel debugger in Redux DevTools. Capture the inputs and the intermediate steps; replay them deterministically; watch the bug recur in the exact order it originally occurred. The primitive is the captured event stream; the discipline is asking "what's the smallest set of inputs that triggers this?"

```
  Pattern — the reproduction loop

  ┌─ 1. CAPTURE ──┐    ┌─ 2. STORE ──┐    ┌─ 3. REPLAY ──┐
  │  live run     │ →  │  seed file   │ →  │  stream back │
  │  events[]     │    │  + mem cache │    │  paced ticks │
  └───────────────┘    └─────────────┘    └──────┬───────┘
                                                  │
                            ┌─────────────────────┘
                            ▼
                     ┌──────────────┐
                     │  4. OBSERVE  │  watch the bug recur in
                     │              │  the same event order
                     └──────┬───────┘
                            │
                            ▼
                     ┌──────────────┐
                     │  5. HYPOTHESIS  ← "the failure is at event N
                     │     + DELTA   │     because X was wrong"
                     └──────┬───────┘
                            │  smallest possible change
                            ▼
                     ┌──────────────┐
                     │  6. RE-RUN   │  isolate the change; re-replay
                     └──────┬───────┘
                            │
                            ▼
                     ┌──────────────┐
                     │  7. CONFIRM  │  bug gone → root cause found
                     └──────────────┘            bug still there → loop
```

The loop's strength comes from steps 3–6: replay → observe → hypothesize → re-run. If any of those steps requires *real* infrastructure (live network, real creds, the user's data), the loop slows down by orders of magnitude.

### Move 2 — walk the loop

#### Capture — the live run records every event

The reader anchor: you've used `JSON.stringify` to dump a request body into a log file for later inspection. Same shape — but instead of one snapshot, every step of the agent run is captured in order. The capture is *cheap*: `collected.push(e)` next to `controller.enqueue(...)`. Both happen inside the `send(e)` closure.

What happens: the route handler defines `collected: AgentEvent[] = []` at stream start. Every `send(e)` does two things — push to the array and emit on the wire. When the stream finishes cleanly (`done` event), `saveInvestigation(insightId, collected)` is called *only on the combined-run path* (the recommendation+diagnostic combined run captured for the demo). Split steps (the live investigate flow that runs diagnose and recommend separately) don't get saved — they're handed off via the client's `sessionStorage` instead.

Boundary: if the agent throws before `done`, the route emits an `error` event but does NOT save. So a *failed* investigation is not reproducible from the cache — you have to re-run it live with the same `insightId` and hope it fails the same way. This is the first real reproduction gap.

```
  Capture — the dual-write

  agent emits event           send(e) runs:
  ─────────────────           ─────────────────────────────
  reasoning_step              collected.push(e)         ← for snapshot
                              controller.enqueue(line)  ← for live UI

  tool_call_start             collected.push(e)
                              controller.enqueue(line)

  …                           …

  done                        collected.push(e)
                              controller.enqueue(line)
                              if (step == null)
                                saveInvestigation(id, collected)  ← snapshot lands here
```

#### Store — the mem→file→seed chain

The reader anchor: you've used `localStorage` as a write-through cache backed by a fetch. Same shape, three rungs. Mem is the live process; the file is the dev escape hatch (serverless filesystems are read-only in prod); the committed seed is the canonical demo store.

What happens: `getCachedInvestigation` reads in this order — mem first, then the dev file if `NODE_ENV === 'development'`, then the committed `demo-investigations.json`. The first hit wins. `saveInvestigation` writes to mem always, and to the dev file in dev only. The committed seed is never written at runtime — it's a `git add`-ed artifact.

Boundary: in production on Vercel, every request can land on a different function instance, so the mem cache is per-instance and trivially cold. The only persistent layer in prod is the committed seed. This is *fine* for the demo — the seed has the captured runs — but it means a live run captured on instance A is invisible to instance B. The committed seed is the only cross-instance reproduction surface.

```
  Store — the read chain (getCachedInvestigation)

  insightId ──► mem map (this process)?              ─► hit: return
                       │ miss
                       ▼
                .investigation-cache.json (dev only)? ─► hit: return
                       │ miss in dev / always miss in prod
                       ▼
                lib/state/demo-investigations.json   ─► hit: return
                       │ miss
                       ▼
                       null   ← live agent run required
```

#### Replay — the paced stream

The reader anchor: you've written a `setTimeout(fn, ms)` to throttle UI updates. The replay loop is exactly that — `await new Promise(r => setTimeout(r, 180))` between each enqueued event. The 180ms isn't decoration; it's what makes the replay *feel* like a live run.

What happens: when `getCachedInvestigation` returns events, the route opens a `ReadableStream`, walks the events in order, encodes each, enqueues it, and waits 180ms before the next. The UI's `useInvestigation` hook reads the stream identically to a live run — it has no idea it's a replay.

Boundary: the pacing is a hard-coded constant. If a captured run had bursty timing (3 events in 50ms, then a 10s pause), the replay smooths it to 180ms ticks. You lose original timing fidelity in exchange for a watchable replay. For a debugging session you'd want timing fidelity; for a demo you want pacing. The current code chose pacing.

```
  Replay — the loop

  for (const e of events) {
    controller.enqueue(encoder.encode(encodeEvent(e)))   ← one NDJSON line
    await sleep(180)                                      ← pace the replay
  }
  controller.close()                                      ← stream ends → UI's "done"
```

#### Observe → hypothesis → re-run — the actual debugging loop

The reader anchor: you've used Chrome's network tab "replay XHR" and stared at the response to figure out why the page broke. Same workflow — except instead of one HTTP request, you replay the whole multi-step agent run, scrub to the event where it went wrong, and hypothesize about *that one event*.

What happens in practice for a real bug: the user reports "the diagnosis was wrong." You load their `insightId`. The cache hits (if it's a captured demo run) or you re-run live (if it's a free run). You read the trace top-to-bottom. You spot the `tool_call_end` whose `result` doesn't match what the diagnosis concluded — that's your event N. Hypothesis: "the diagnostic agent over-weighted tool call X." Delta: edit the diagnostic agent's system prompt to down-weight X. Re-run live; if the new run produces a better diagnosis, the hypothesis was right.

Boundary: the loop only works because the trace shows *intermediate evidence*, not just the final output. If you only had the final diagnosis text, you couldn't form a hypothesis about which step was wrong — you'd just see "the answer is bad."

#### Move 3 — the principle

The fastest reproductions are the ones where you didn't have to *recreate* the environment — you just *replayed* what was already captured. blooming insights took this seriously at the agent layer (every step is captured in the AgentEvent stream). The lesson generalises: capture more than you think you need, store it cheaply, and design every captured payload to be replayable in isolation. The repo would be substantially harder to debug if the cache stored only the final diagnosis instead of the full event stream — and substantially more powerful if the same pattern extended to the briefing flow and the free-form query flow, neither of which currently does this.

---

## Primary diagram

The full reproduction loop, with the file:line owners for each stage labelled.

```
  Reproduction and evidence — the full loop

  ┌─ Live run ────────────────────────────────────────────────┐
  │  app/api/agent/route.ts L171–195                           │
  │    collected: AgentEvent[] = []                            │
  │    send(e) → collected.push(e) + enqueue NDJSON            │
  │  app/api/agent/route.ts L254                               │
  │    if (step == null) saveInvestigation(insightId,collected)│
  └─────────────────────────▲─────────────────────────────────┘
                            │ snapshot lands in mem + dev file
  ┌─ Store ─────────────────┴─────────────────────────────────┐
  │  lib/state/investigations.ts L11      mem map              │
  │  lib/state/investigations.ts L8       .investigation-      │
  │                                       cache.json (dev)     │
  │  lib/state/investigations.ts L9       demo-investigations  │
  │                                       .json (committed)    │
  │  read chain: mem → dev-file → seed (getCachedInvestigation)│
  └─────────────────────────▲─────────────────────────────────┘
                            │ next request: cache-first path
  ┌─ Replay ────────────────┴─────────────────────────────────┐
  │  app/api/agent/route.ts L127–141                           │
  │    if (cached) { for (const e of events) { enqueue +       │
  │                  await sleep(REPLAY_DELAY_MS=180) } }      │
  └─────────────────────────▲─────────────────────────────────┘
                            │ UI reads stream, can't tell live vs replay
  ┌─ Observe → hypothesise → re-run ──────────────────────────┐
  │  read trace top-down                                       │
  │  spot the failing event (the tool_call_end with bad result │
  │  or the reasoning_step with the wrong conclusion)          │
  │  edit one variable (prompt / threshold / code path)        │
  │  re-run live → confirm                                     │
  └───────────────────────────────────────────────────────────┘
```

---

## Implementation in codebase

### Use cases

Three real moments reproduction gets used:

- **Demo offline.** No MCP creds, no Anthropic key — `lib/state/demo-investigations.json` plus `demo-insights.json` plus the cache-first path in `route.ts:127–141` give you a fully working demo on a plane. The committed seed *is* the reproduction surface for the happy-path runs you care about showing.

- **Reproducing a captured bug.** A captured `insightId` produced a bad diagnosis. You replay it (cache hits), scrub the trace, identify the event where the agent went off the rails, change one thing (prompt, tool description, evidence weighting), re-run live with the same `insightId` to see if the change fixed it. The 180ms pacing makes the replay watchable; the dev-file cache means subsequent live runs are also captured.

- **The flake-fix workflow (commit `e83a8e0`).** Different shape of reproduction — not an agent bug, a *test* flake. The bug was "the auth crypto test fails ~1-in-N runs." Reproduction was: run vitest enough times in parallel to trigger the env-var leak. Isolation was: switch `process.env.AUTH_SECRET = ...` to `vi.stubEnv('AUTH_SECRET', …)` + `vi.unstubAllEnvs()` in `afterEach`. Verification was: 157 tests pass across repeated runs (commit message). This is the worked example in `07-incident-analysis-and-prevention.md`.

### Code side by side, with a line-by-line read

The capture point — the dual-write that turns one stream into two artifacts (live wire + replayable snapshot):

```
  app/api/agent/route.ts  (lines 171–195, abbreviated)

  const collected: AgentEvent[] = [];                                  ← buffer for the snapshot
  const send = (e: AgentEvent) => {
    collected.push(e);                                                 ← write to buffer (replay surface)
    controller.enqueue(encoder.encode(encodeEvent(e)));                ← write to wire (live surface)
  };

  …  agents run, calling send(e) repeatedly via hooks  …

  send({ type: 'done' });                                              ← clean termination signal
  if (step == null) saveInvestigation(insightId!, collected);          ← snapshot ONLY on combined-run path
        │
        └─ load-bearing: drop the `collected.push` and replay dies;
           drop the `enqueue` and the live UI dies. Both writes
           required, both done on every send call. The `if step==null`
           is the deliberate gap — split steps hand off via sessionStorage
           instead, so they're not cached server-side.
```

The store — three rungs of the read chain in 17 lines:

```
  lib/state/investigations.ts  (lines 7–28)

  const PERSIST = process.env.NODE_ENV === 'development';              ← dev-only file persistence
  const CACHE_FILE = join(process.cwd(), '.investigation-cache.json'); ← rung 2: dev file
  const DEMO_FILE  = join(process.cwd(),                               ← rung 3: committed seed
                          'lib/state/demo-investigations.json');

  const mem = new Map<string, AgentEvent[]>();                         ← rung 1: in-process map

  export function getCachedInvestigation(insightId: string): AgentEvent[] | null {
    if (mem.has(insightId)) return mem.get(insightId)!;                ← rung 1 hit
    const fromFile = PERSIST ? readJson(CACHE_FILE)[insightId]         ← rung 2 (dev only)
                             : undefined;
    if (fromFile) return fromFile;
    const fromDemo = readJson(DEMO_FILE)[insightId];                   ← rung 3 always tried
    return fromDemo ?? null;
  }
        │
        └─ mem is the only rung that survives within a process;
           CACHE_FILE only exists in dev (Vercel FS is read-only in prod);
           DEMO_FILE is the canonical cross-instance reproduction surface.
           This 3-rung chain IS why you can demo blooming insights with
           no creds on any machine.
```

The replay — the paced stream that re-creates the live experience:

```
  app/api/agent/route.ts  (lines 127–141)

  const cached = insightId && !live ? getCachedInvestigation(insightId) : null;
  if (cached) {
    const events = step ? filterByStep(cached, step) : cached;         ← per-step replay (diagnose/recommend)
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const e of events) {
          controller.enqueue(encoder.encode(encodeEvent(e)));          ← same NDJSON line as live
          await new Promise((r) => setTimeout(r, REPLAY_DELAY_MS));    ← 180ms pacing — makes it watchable
        }
        controller.close();
      },
    });
    return new Response(stream, { headers: NDJSON_HEADERS });          ← UI can't tell live vs replay
  }
        │
        └─ this is what makes the demo seed a real reproduction primitive,
           not just a static dump. The 180ms is the difference between
           "replay" and "result". Drop it and the run feels canned.
```

---

## Elaborate

The reproduction pattern blooming insights uses — capture-store-replay — is the same shape as Chrome's network HAR export, Redux DevTools time travel, and Datadog's session replay. The common thread: capture *intermediate* state (not just the final output), store it cheaply, and design replay so the consumer can't tell live from cached. Datadog session replay reconstructs DOM mutations; Redux time-travel reconstructs state transitions; blooming insights reconstructs agent events. Same primitive, three different abstraction layers.

What this repo gets right that even bigger systems often miss: the storage tier is *typed*. `AgentEvent` is a discriminated union, so a captured event is impossible to misinterpret on replay — there's no schema ambiguity, no version drift, no "what did the v2 format mean again." The TypeScript compiler enforces shape parity between capture and replay. That's a small thing that prevents a whole class of replay-time bugs.

What's missing — and worth naming — is *event-level annotation*. A captured event has the data the agent emitted; it does NOT have provenance metadata (timestamp wall-clock, model version, prompt hash, cache hit/miss for the tool call). Adding those would make the cache useful for regression analysis ("did our prompt change degrade this case?"), not just live replay. The hook signature would need to grow; the AgentEvent union would need a `meta` field. Not hard, just not built.

---

## Interview defense

**Q1. How does blooming insights make an investigation reproducible without re-running it live?**

Every event the agent emits is captured in a `collected: AgentEvent[]` buffer next to the wire write, and saved via `saveInvestigation(insightId, collected)` when the run completes cleanly. The next request for the same `insightId` reads the captured stream from a 3-rung cache (mem → dev file → committed seed) and replays it with a 180ms tick per event. The UI consumes the replay identically to a live run — the cache-first path in `app/api/agent/route.ts:127–141` is transparent.

```
  capture: collected.push(e)  ← next to controller.enqueue
  store:   saveInvestigation → mem + dev file
  replay:  for (e of events) { enqueue; sleep(180) }
```

**Anchor:** the dual-write in `send(e)` is the load-bearing line. Drop it and reproduction dies.

**Q2. What kind of bug would this reproduction scheme NOT help with?**

A bug in the live run that fails *before* `done` is emitted. The route saves only on the `done` path (`app/api/agent/route.ts:254`), so a thrown error short-circuits the snapshot. You can re-run live with the same `insightId`, but if the failure is non-deterministic (e.g. an Anthropic API stutter), you can't replay the original failure — only re-attempt it.

```
  agent runs → throws partway → catch emits error event → finally
                                                            │
                                                            └─ NO saveInvestigation here
                                                               (the snapshot would be incomplete)

  → mitigation: capture-on-error (push to a separate "broken runs" file)
    is the obvious extension; not built yet.
```

**Anchor:** the snapshot is gated on clean termination — this is a deliberate choice, not an oversight, because half-snapshots would corrupt the replay path. Naming what the scheme *doesn't* do is half the credibility.

---

## Validate

1. **Reconstruct.** Without looking, draw the capture-store-replay loop and name the file:line for each of the three stages.
2. **Explain.** Why is `REPLAY_DELAY_MS = 180` load-bearing rather than cosmetic? Anchor: `app/api/agent/route.ts:105`.
3. **Apply to a scenario.** A captured run produced a recommendation whose `rationale` references a tool result that isn't in the trace. Walk the reproduction loop: where do you look first, what hypothesis does that point at, and what's the minimum change to test it?
4. **Defend the decision.** Why does the snapshot live in three rungs (mem / dev file / committed seed) instead of just one? Argue for collapsing it to one rung and counter-argue from the deployment reality (serverless FS read-only in prod).

---

## See also

- `05-traces-and-request-lifecycles.md` — the trace IS the captured artifact; this file owns the capture/replay mechanics.
- `06-state-snapshots-and-debugging-boundaries.md` — `saveInvestigation` and the mem→file→seed chain in full.
- `07-incident-analysis-and-prevention.md` — the flake-fix in `e83a8e0` walked as a worked reproduction example.
- `.aipe/study-testing/` — the test discipline around vitest parallel workers and env stubbing.
