# Replay from snapshot with paced emission

**Industry name(s):** record-and-replay (R&R), trace replay, deterministic test fixture. The pacing wrinkle is sometimes called *time-dilated replay*. **Type:** Industry standard pattern with a project-specific twist.

## Zoom out — where this concept lives

The product's demo path *is* the production debugging fixture. Same route, same NDJSON wire, same UI consumer. The only difference is the byte source: instead of an agent producing events live, the route reads a committed JSON file and emits its events on a pacer.

```
  Zoom out — replay sits at the service layer, swapping the event source

  ┌─ UI layer ─────────────────────────────────────────────────┐
  │  StatusLog / ReasoningTrace  (consumer doesn't know which)  │
  │       ▲                                                     │
  └───────┼─────────────────────────────────────────────────────┘
          │ readNdjson<AgentEvent>(body, handle)
  ┌─ Service layer ──────────────────────────────────────────────┐
  │  /api/agent · /api/briefing  (decides: live or replay?)      │
  │       │                                                       │
  │       ├── live branch ──► agent loop → encodeEvent → stream  │
  │       │                                                       │
  │       └── ★ REPLAY branch ★ ─► read JSON → filterByStep →    │
  │           pace 180ms/event → encodeEvent → stream            │
  │                            ▲                                  │
  │                            │                                  │
  └────────────────────────────┼──────────────────────────────────┘
                               │
  ┌─ Storage layer ────────────▼──────────────────────────────────┐
  │  lib/state/demo-investigations.json  (committed seed)          │
  │  .investigation-cache.json            (dev-only saved runs)    │
  │  in-memory Map                        (this-process saves)     │
  └────────────────────────────────────────────────────────────────┘
```

**Zoom in.** Replay is "read the JSON file, walk the saved `AgentEvent[]`, encode each one back onto the wire, sleep 180ms between." A consumer can't tell whether the events came from an agent or a fixture — same bytes, same order, same kernel. The pacing is what makes it *feel* live; without it the whole investigation would arrive in one chunk and the "watch the agent think" UX collapses.

The question this pattern answers: *"how do we get a reproducible debugging fixture for every investigation without inventing a separate replay format?"*

## Structure pass

**Layers.** Three: the JSON file on disk (storage), the route's replay branch (service), the UI consumer (UI). The wire format (`AgentEvent` + NDJSON) is the same across all three layers and across both live and replay branches.

**Axis: control.** Hold the *"who decides when the next event fires?"* question constant across layers.

```
  Trace "who decides timing?" across live vs replay

  layer            live branch                    replay branch
  ─────            ───────────                    ─────────────
  storage          (n/a — no storage upstream)    JSON.parse the file
  service          agent loop decides (LLM        for-loop with await sleep(180ms)
                    + MCP call latency)            decides
  network          chunked transport, no buffer   chunked transport, no buffer
  UI               renders on arrival             renders on arrival
                                                  
                   ▲                              ▲
                   │                              │
              REAL latency drives             SYNTHETIC delay drives
              the cadence                     the cadence
```

The control axis flips at one seam — the service layer. Upstream of the service, live reads from agent + MCP; replay reads from a file. Downstream of the service, both look identical to network + UI. **That symmetry is the whole point.**

**Seams.**

1. **Source seam (live vs replay).** Decided per-request by `demo=cached` (briefing) or by *cache hit + not `live=1`* (agent). At `app/api/briefing/route.ts:78-86` and `app/api/agent/route.ts:125-127`. Break the decision logic (e.g. always-replay) → live is unreachable.
2. **Pace seam (the sleep).** `REPLAY_DELAY_MS = 140` (briefing) and `180` (agent) at `app/api/briefing/route.ts:25` and `app/api/agent/route.ts:103`. Drop the sleep → the whole snapshot arrives in one tick; the UI shows the full trace but the *reasoning effect* is gone (no "I see the agent thinking"). Make it too long → the demo feels staged.
3. **Filter seam (per-step replay).** `filterByStep(events, step)` at `app/api/agent/route.ts:64-82` strips out events not belonging to the requested step. Break the filter → step 2 shows recommendation-phase events.

The filter is the load-bearing piece that lets one captured run serve as two fixtures (step 2 diagnose, step 3 recommend). Skeleton mapped.

## How it works

### Move 1 — the mental model

You've used React Testing Library — `render(<App/>); fireEvent.click(button); expect(…)`. The trick is that `fireEvent` synthesizes a real DOM event so the component sees something indistinguishable from a user click. Replay-from-snapshot is the server-side version: synthesize NDJSON bytes indistinguishable from a real agent run, send them through the same wire, let the same UI consume them.

The pacer is what makes it indistinguishable in *time*, not just structure.

```
  The pattern — replay = same wire, different source, paced emission

       saved AgentEvent[]                          live agent loop
       (JSON.parse a file)                         (LLM + MCP)
              │                                          │
              │                                          │
              ▼                                          ▼
       for event in events:                       for event from loop:
         encodeEvent(event)                         encodeEvent(event)
         await sleep(PACE)                          (real latency)
         stream.enqueue(bytes)                      stream.enqueue(bytes)
              │                                          │
              └─────────────────┬────────────────────────┘
                                │
                                ▼
                  same NDJSON stream out
                  same readNdjson on the UI
                  same switch (e.type) handling
                  
                  (consumer cannot tell which branch produced the bytes)
```

### Move 2.1 — the source branch decision

The route picks live or replay at the request boundary. Two different shapes.

**Briefing (`app/api/briefing/route.ts:78-86`).** Replay is opted into by query string:

```typescript
// app/api/briefing/route.ts:77-86
export async function GET(req: NextRequest) {
  const demo = req.nextUrl.searchParams.get('demo') === 'cached';

  if (demo && existsSync(DEMO_FILE)) {
    // ... load DEMO_FILE, build NDJSON ReadableStream that replays it, return Response
```

**Agent (`app/api/agent/route.ts:125-142`).** Replay is *cache-first* — if a cached investigation exists and the caller didn't opt into `live=1`, replay it:

```typescript
// app/api/agent/route.ts:125-142
const cached = insightId && !live ? getCachedInvestigation(insightId) : null;
if (cached) {
  const events = step ? filterByStep(cached, step) : cached;        // ← per-step filter, see Move 2.3
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const e of events) {
        if (req.signal.aborted) break;                                // ← bail if client closed
        controller.enqueue(encoder.encode(encodeEvent(e)));           // ← same encodeEvent the live branch uses
        await new Promise((r) => setTimeout(r, REPLAY_DELAY_MS));     // ← the pacer
      }
      controller.close();
    },
  });
  return new Response(stream, { headers: NDJSON_HEADERS });           // ← same headers, same content-type
}
```

The cached lookup walks the three-rung store at `lib/state/investigations.ts:22-28` — in-memory → dev file → committed seed. So the same replay branch serves "demo user with no auth" and "developer reproducing a saved live run." → see `03-three-rung-mem-file-seed-store.md`.

**The two routes have slightly different policies.** Briefing's replay is opt-in (only when `?demo=cached`); agent's replay is opt-out (any cached investigation replays unless `live=1` is set). Briefing is the orientation step (one snapshot per workspace); agent is the investigation step (one snapshot per insight). Different policies because the cache identity is different.

### Move 2.2 — the pacer

One line at the heart of replay. **`app/api/agent/route.ts:136`:**

```typescript
await new Promise((r) => setTimeout(r, REPLAY_DELAY_MS));   // REPLAY_DELAY_MS = 180
```

**Why 180ms?** Eyeball-calibrated to feel like a thinking agent. A real diagnostic investigation takes 60-120 seconds; a 30-event snapshot at 180ms = 5.4 seconds. That's fast enough to demo without losing patience, slow enough that you can read each line as it lands.

**Comment at `app/api/briefing/route.ts:23-25`** names the design intent:

> "Pause between replayed demo events, so the snapshot reveals at a readable pace instead of all at once (matches the agent route's investigation replay)."

**What breaks if you remove it.** The route would dump every event in one tick. The UI consumer (the same `readNdjson` loop) would receive all bytes in (effectively) one chunk, parse them all, dispatch them all — and React would batch the state updates so the user sees the entire trace appear in one frame. Functionally correct, demo-wise dead.

**A subtle interaction: `cancelOn` polling.** The consumer polls `cancelOn()` between reads at `lib/streaming/ndjson.ts:32-36`. The 180ms pacer means the consumer's reads are spaced out, which means cancellation lands within ~180ms of the user navigating away. Acceptable.

### Move 2.3 — the per-step replay filter

The combined-run snapshot is two phases (diagnose + recommend) recorded as one event stream. The investigate UI runs them as two separate page visits. So the snapshot has to be sliceable.

**The filter, at `app/api/agent/route.ts:64-82`:**

```typescript
function filterByStep(events: AgentEvent[], step: Step): AgentEvent[] {
  return events.filter((e) => {
    const agent =
      e.type === 'reasoning_step'
        ? e.step.agent                                       // ← the agent field on a reasoning_step lives at e.step.agent
        : e.type === 'tool_call_start' || e.type === 'tool_call_end'
          ? e.agent                                          // ← on tool events it's at e.agent
          : null;
    if (step === 'diagnose') {
      if (e.type === 'recommendation') return false;         // ← drop recommendation results
      if (agent === 'recommendation') return false;          // ← drop recommendation-phase reasoning + tools
      return true;                                           // ← keep everything else (diagnostic + coordinator)
    }
    // recommend: only recommendation-phase activity + recommendations + done
    if (e.type === 'diagnosis') return false;                // ← drop the diagnosis (already shown on step 2)
    if (agent && agent !== 'recommendation') return false;   // ← drop diagnostic-phase activity
    return true;
  });
}
```

**The agent tag is the slice key.** Every `reasoning_step` carries `step.agent` ∈ `coordinator | monitoring | diagnostic | recommendation`. Every `tool_call_*` carries `agent: AgentName`. The filter reads those tags. → this is why `01-ndjson-agent-event-discriminated-union.md` calls the `agent` field load-bearing.

**The result events have their own filter.** `diagnosis` events are dropped on the recommend step (shown via handoff from sessionStorage instead, see `lib/hooks/useInvestigation.ts:73-85`). `recommendation` events are dropped on the diagnose step. `done` survives both filters — it's the universal end-of-stream marker.

**Execution trace — what happens to one snapshot under each filter:**

```
  Captured snapshot (combined run, simplified):
    [reasoning_step{agent:'diagnostic'},   tool_call_start{agent:'diagnostic'},
     tool_call_end{agent:'diagnostic'},    diagnosis{…},
     reasoning_step{agent:'recommendation'}, tool_call_start{agent:'recommendation'},
     tool_call_end{agent:'recommendation'}, recommendation{…}, done]

  filterByStep(events, 'diagnose') →
    [reasoning_step{diagnostic}, tool_call_start{diagnostic},
     tool_call_end{diagnostic}, diagnosis{…}, done]
                                                          ↑
                                          (recommendation, recommendation-phase events all dropped)

  filterByStep(events, 'recommend') →
    [reasoning_step{recommendation}, tool_call_start{recommendation},
     tool_call_end{recommendation}, recommendation{…}, done]
                                                          ↑
                                  (diagnosis, diagnostic-phase events all dropped)
```

Same source bytes, two views. The capture writes once; the replay slices on demand. **No fixture maintenance** — adding a new investigation means recording one combined run, and both step fixtures fall out of it.

### Move 2.4 — the briefing-only refinement: tile-by-tile coverage

The briefing replay has one extra detail worth seeing. It emits the 10-category coverage grid one tile at a time, paired with its log line, instead of all at once.

**At `app/api/briefing/route.ts:113-120`:**

```typescript
// one category per tick: log line + its tile resolve together, so
// the grid fills in step with the checklist instead of all at once.
const lines = coverageChecklistSteps(coverage);
for (let i = 0; i < coverage.length; i++) {
  controller.enqueue(encoder.encode(JSON.stringify(stepEvt(lines[i])) + '\n'));
  controller.enqueue(encoder.encode(JSON.stringify({ type: 'coverage_item', item: coverage[i] }) + '\n'));
  await new Promise((r) => setTimeout(r, REPLAY_DELAY_MS));
}
```

Two events per iteration (the step text + the coverage tile), one sleep. The pairing means the grid tile and its narration appear in the same UI frame. This is replay-as-product-design — the pacer is doing double duty as a UX timing primitive.

### Move 2.5 — abort handling during replay

A user navigating away mid-replay needs the route to stop enqueuing bytes. Two abort surfaces.

**Mid-replay abort at `app/api/agent/route.ts:134`:**

```typescript
if (req.signal.aborted) break;
```

The for-loop bails out on the *next iteration* after the user closes the tab — bounded by the 180ms pacer (next check ≤ 180ms after the abort lands). The `controller.close()` after the loop releases the stream cleanly.

**Consumer-side cancel.** `useBriefingStream.ts:289-300` flips `cancelledRef.current = true` on effect cleanup; `readNdjson` polls it at `lib/streaming/ndjson.ts:32-36` and calls `reader.cancel()`. That propagates back to the server's `req.signal`. So cancellation is *bidirectional* without any explicit messaging — the standard `fetch` + `ReadableStream` plumbing does it.

### Move 3 — the principle

The general principle: **make replay use the same path as live.** When the fixture format diverges from the production format, the fixture stops covering what production does — it tests the fixture loader, not the real consumer. When the route layer is the only thing that knows the difference, every consumer downstream gets free coverage.

The pacing is the surprising bit. Most replay tools fire as fast as they can (deterministic playback for tests). This one pacings the emission *because the consumer is a human watching a UI*. The same fixture, fired as fast as possible, would still work for an automated test — the pacer is a property of the *replay route*, not the *replay format*. That separation is what lets the same `lib/state/demo-investigations.json` serve both purposes (live-feeling demo + repeatable test seed).

## Primary diagram

The full picture — capture, store, replay, slice, pace.

```
  Replay-from-snapshot — capture once, slice and pace on demand

  ┌─ capture (one-time, dev-only) ─────────────────────────────────────┐
  │                                                                     │
  │  user clicks "capture this as demo snapshot" in app/page.tsx        │
  │           │                                                          │
  │           ▼                                                          │
  │  /api/briefing (live)  ──collected──►  lib/state/demo-insights.json │
  │  /api/agent (live, combined run, per insight)                       │
  │           │                                                          │
  │           ├── send(e) → controller.enqueue (live wire)               │
  │           └── collected.push(e) at agent/route.ts:188               │
  │                       │                                              │
  │                       ▼ on 'done'                                    │
  │       saveInvestigation(insightId, collected) at agent/route.ts:302 │
  │                       │                                              │
  └───────────────────────┼──────────────────────────────────────────────┘
                          │
                          ▼
  ┌─ storage (three rungs) ────────────────────────────────────────────┐
  │  in-memory Map  →  .investigation-cache.json (dev) → demo-*.json   │
  │                                                       (committed)   │
  └─────────────────────────┬──────────────────────────────────────────┘
                            │
  ┌─ replay (every demo request) ──────────────────────────────────────┐
  │                            ▼                                        │
  │  /api/agent?insightId=X (cache hit, no live=1)                     │
  │            │                                                        │
  │            ├── getCachedInvestigation(X) → AgentEvent[]            │
  │            ├── filterByStep(events, step)  ← agent/route.ts:64-82  │
  │            └── for each e: encodeEvent → enqueue → sleep 180ms     │
  │                                                                     │
  │  /api/briefing?demo=cached                                          │
  │            │                                                        │
  │            ├── readFileSync(DEMO_FILE) → DemoSnapshot               │
  │            └── replay workspace + paced coverage tiles + trace +    │
  │                insights (140ms/event), close on 'done'              │
  └─────────────────────────┬──────────────────────────────────────────┘
                            │ NDJSON over chunked HTTP (same headers
                            │ as live: 'application/x-ndjson; charset=utf-8',
                            │ 'cache-control: no-store, no-transform')
                            ▼
  ┌─ UI (consumer is identical to live path) ──────────────────────────┐
  │  readNdjson<AgentEvent>(body, handle) → switch (e.type) → state    │
  │  StatusLog + ReasoningTrace + InsightCard re-render on every event │
  └────────────────────────────────────────────────────────────────────┘
```

## Elaborate

Record-and-replay has a long history — `rr` (Mozilla's reverse-debugger), JFR for the JVM, `tcpdump`+`tcpreplay` for networks, Chrome's tracing, Cypress's network replay. Every one of them lands on the same hard call: *what's the granularity of the recording?* If you record at the bytes-on-the-wire layer you get exact reproduction but can't slice it. If you record at the high-level event layer you can slice, but you have to keep the schema stable.

This codebase chose the high-level layer (the `AgentEvent` union) and pays the cost of schema stability — every new variant has to land in the producer, the consumer's switch, *and* the filter logic if it carries an agent tag. The win is that one capture file at 200KB serves as both step-2 and step-3 fixture for every insight in the snapshot.

The pacer detail is closer to **time-dilated replay** in distributed-systems literature — replaying a captured trace at a different speed than the original. Real systems use it to find latency-sensitive bugs (replay at 10x speed to see if the race condition was a happens-before issue). This codebase uses it to *slow down* (capture takes 60-120s, replay paces at 5-6s) for human-watching reasons. Same primitive, opposite direction.

**Adjacent concepts:**
- **Golden master testing / snapshot testing** — Jest `toMatchSnapshot`. Same idea (recorded output is the assertion), but the snapshot is the *test artifact*, not a runtime fixture serving a real route.
- **VCR / Polly.js** — record HTTP requests in tests, replay on subsequent runs. Same record-once-replay-many shape; bytes-on-wire instead of high-level events.
- **Event sourcing** — every state change is a stored event; rebuilding state is a replay. Same primitive (event log), different purpose (state derivation vs UI reproduction).

**Read next:**
- `04-dual-write-send-to-stream-and-store.md` — the producer-side coupling that makes the capture happen at all.
- `03-three-rung-mem-file-seed-store.md` — where the captured snapshots live.

## Interview defense

**Q: Why pace replay at 180ms instead of firing as fast as possible?**
A: The consumer is a human watching a "show your work" UI, not a test runner. Firing all events in one tick collapses the UX — the trace appears in a single frame and the "watch the agent think" effect is gone. 180ms is eyeball-calibrated: a 30-event investigation snapshot replays in ~5.4s, fast enough to demo, slow enough to read each line. The pacer is a property of the *route*, not the *snapshot format* — automated tests can read the same file and skip the sleep.

> *Sketch:* the pacer pseudocode loop with a comment "this sleep is for humans, not for correctness."

**Anchor:** "Pacing is route policy, not data."

**Q: How does one captured snapshot serve as two separate fixtures?**
A: The capture is a combined diagnose+recommend run, written as one `AgentEvent[]` to `lib/state/demo-investigations.json`. The per-step filter at `app/api/agent/route.ts:64-82` reads the `agent` tag on each event (`step.agent` for reasoning_step, `e.agent` for tool calls) and keeps only the events belonging to the requested step. Diagnostic-phase tool calls survive the diagnose filter; recommendation-phase calls survive the recommend filter. Drop the agent tag and the filter can't work — step 2 would show step 3's tools.

> *Sketch:* the execution trace from Move 2.3 showing the two filtered slices side by side.

**Anchor:** "One capture, two slices, agent tag is the key."

**Q: How does the consumer not need to know whether it's replay or live?**
A: Same wire (`AgentEvent` NDJSON), same content-type header (`application/x-ndjson`), same kernel (`readNdjson`). The route is the only layer that branches. From the UI's perspective, `useInvestigation` does `fetch('/api/agent?…').body → readNdjson → switch (e.type)` regardless of source. The seam is the route's `if (cached) { … return Response }` early-return at `app/api/agent/route.ts:126`. This means every UI feature gets free coverage on both paths.

> *Sketch:* the layers diagram, with replay and live merging at the wire layer.

**Anchor:** "Service decides; UI doesn't know."

**Q: What happens if the user navigates away mid-replay?**
A: Two abort surfaces, both fire. The consumer side: effect cleanup in `useBriefingStream` flips `cancelledRef.current = true`; `readNdjson` polls it between reads (`lib/streaming/ndjson.ts:32-36`) and calls `reader.cancel()`. That propagates to the server as `req.signal.aborted`. The replay loop checks it at `app/api/agent/route.ts:134` and breaks. Worst-case latency from navigate-to-stop is one pacer tick (~180ms) — acceptable. The `controller.close()` after the loop runs whether the loop broke or completed.

> *Sketch:* the abort path from React effect cleanup → fetch reader → server req.signal → loop break.

**Anchor:** "Abort is the standard fetch plumbing; replay just respects it."

**Q: Why is this in the route layer instead of a separate `/api/replay` endpoint?**
A: To keep the live and replay paths *one URL*. The client doesn't pick "demo or live mode" per fetch — it sends one fetch and the route decides. That means the client has no `if (mode === 'demo') fetch('/replay/…') else fetch('/agent/…')` branching, no two URLs to keep in sync, no chance of one drifting. The cost is that the route's stream-start function has two branches at the top. The benefit is that every URL parameter (`?insightId=`, `?step=`, `?live=1`) works uniformly. Branching at the route is cheap; branching at the client and server compounds.

> *Sketch:* one URL with the route's branching marked inside.

**Anchor:** "One URL, server decides — fewer places for drift."

## See also

- `01-ndjson-agent-event-discriminated-union.md` — the wire format replay reuses.
- `03-three-rung-mem-file-seed-store.md` — where the snapshot files live.
- `04-dual-write-send-to-stream-and-store.md` — how the capture happens.
- `audit.md` § 2 (reproduction-and-evidence), § 6 (state-snapshots-and-debugging-boundaries).
