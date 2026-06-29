# demo-replay-as-reliability

## Demo snapshot as the reliable default (project-specific)

The demo path is not a marketing fallback or a "no-credentials shortcut" — it's the *reliable presentation default*. A committed JSON snapshot (`lib/state/demo-insights.json`, `lib/state/demo-investigations.json`) is replayed by the same routes as a synthetic NDJSON stream, complete with delays between events to match the live cadence. The mode toggle (`bi:mode` in `localStorage`) defaults to `'demo'`. The architecture is shaped by the fact that the live upstream (alpha Bloomreach loomi connect) is unreliable enough that the demo path has to be presentation-grade.

## Zoom out — where this pattern lives

The demo path is a *branch* inside the same routes the live path uses. The UI is identical for both; only the data source and the producer differ.

```
  Zoom out — demo as a branch in the same routes

  ┌─ UI layer ──────────────────────────────────────────────────────────┐
  │  useBriefingStream     useInvestigation     useDemoCapture (dev-only)│
  │     │                          │                       │             │
  │     │ all consume NDJSON the same way                                 │
  │     ▼                          ▼                                     │
  │  page.tsx · investigate/[id]/page.tsx · investigate/[id]/recommend   │
  └────────────────────────────┬────────────────────────────────────────┘
                               │
  ┌─ Service layer ───────────▼─────────────────────────────────────────┐
  │  /api/briefing  /api/agent                                           │
  │  ┌─────────────────────────────────────────────────────────────────┐ │
  │  │ if (?demo=cached && file exists)                                │ │
  │  │   → ★ DEMO BRANCH ★ — replay JSON snapshot as NDJSON stream     │ │ ← we are here
  │  │ else                                                             │ │
  │  │   → live branch — makeDataSource → agent.scan → emit events     │ │
  │  └─────────────────────────────────────────────────────────────────┘ │
  └─────────────────────────────────────────────────────────────────────┘
```

The demo path's job: replay a captured live run with the same event order, the same delays, the same wire contract — *without* needing any auth, any MCP server, any LLM. Same UI, same stream, different data source. From the consumer's point of view, the only difference is the URL contains `?demo=cached` instead of `?mode=…`.

## Structure pass

Three layers carry this pattern: the **capture** layer (dev-only, writes the snapshot from a live run), the **storage** layer (the committed JSON files), the **replay** layer (the route's demo branch). One axis worth tracing: **what generates the events?**

```
  Axis: what generates the events on the wire?

  ┌─ live path ───────────────┐    LLM + DataSource per event
  │  agent.scan loop          │   ═════╪═════►
  │  + tool calls in hooks    │
  └────────────────────────────┘
       ┌─ demo path ───────────────┐    file read + setTimeout per event
       │  for each item in JSON:    │   ═════╪═════►
       │    emit event              │
       │    await sleep(140ms)      │
       └────────────────────────────┘
            ┌─ capture path (dev) ──┐    runs live, writes JSON
            │  drain NDJSON from    │
            │  /api/agent into file │
            └────────────────────────┘
```

The axis flips at the route's demo branch — same wire output, fundamentally different generator. The seam is invisible to the consumer; the kernel of the pattern is "the replayer emits the same events the live producer emits, in the same order, at a similar cadence."

## How it works

### Move 1 — the mental model

You've used a recorded VHS tape. It plays back the same thing every time — frame for frame, sound for sound — without needing the original cameras or actors. The recording is the *artifact*; the original production was the *one-time event* that made the recording possible. For most playback purposes the recording is *better* than the original event would be: it's always there, it doesn't fail, it doesn't surprise you.

The demo snapshot is the recording. The capture path is the camera. The live path is the original production. For the default user-facing experience — opening the app for the first time, doing a presentation, showing a colleague — the recording is the right thing to play, because it can't fail.

```
  The pattern: capture once, replay forever

  ┌─ CAPTURE (dev-only, manual, periodic) ──────────────────────────┐
  │  1. run live briefing                                            │
  │  2. drain NDJSON events into memory                              │
  │  3. write to lib/state/demo-insights.json                        │
  │  4. for each insight: run live investigation                     │
  │  5. write each to lib/state/demo-investigations.json             │
  │  6. commit the JSON files                                        │
  └─────────────────────────────────────────────────────────────────┘

  ┌─ REPLAY (every demo request) ────────────────────────────────────┐
  │  1. browser sends ?demo=cached                                   │
  │  2. route reads the JSON                                         │
  │  3. for each event in the captured trace:                        │
  │       controller.enqueue(JSON.stringify(event) + '\n')            │
  │       await sleep(REPLAY_DELAY_MS)                               │
  │  4. consumer reads it as a normal NDJSON stream                  │
  └─────────────────────────────────────────────────────────────────┘
```

The capture is rare and intentional; the replay is the common case.

### Move 2 — the step-by-step walkthrough

#### the route's demo branch — replays JSON as NDJSON

The route inspects `?demo=cached` *before* it commits to any expensive path:

```ts
// app/api/briefing/route.ts:77-86
export async function GET(req: NextRequest) {
  const demo = req.nextUrl.searchParams.get('demo') === 'cached';

  // Demo mode: replay the pre-captured snapshot as an NDJSON stream (creds-free),
  // mirroring the live event order so the feed reveals progressively — the
  // coverage checklist narrates into the status panel, the grid resolves, then
  // the recorded EQL trace and the insight cards stream in (the agent route
  // replays investigations the same way). The client routes any non-NDJSON
  // response down a plain-JSON fallback, so a malformed file still degrades.
  if (demo && existsSync(DEMO_FILE)) {
    …
  }
```

If the file exists, the route opens a `ReadableStream` and *manually emits* the captured events with deliberate spacing between them:

```ts
// app/api/briefing/route.ts:94-145 (condensed)
const stream = new ReadableStream<Uint8Array>({
  async start(controller) {
    const emit = async (e: BriefingEvent) => {
      controller.enqueue(encoder.encode(JSON.stringify(e) + '\n'));
      await new Promise((r) => setTimeout(r, REPLAY_DELAY_MS));            // 140ms
    };
    …
    if (snap.workspace) await emit({ type: 'workspace', workspace: snap.workspace });
    if (coverage.length > 0) {
      await emit(stepEvt('matching the workspace schema to the 10-category anomaly checklist…'));
      // one category per tick: log line + its tile resolve together
      const lines = coverageChecklistSteps(coverage);
      for (let i = 0; i < coverage.length; i++) {
        controller.enqueue(encoder.encode(JSON.stringify(stepEvt(lines[i])) + '\n'));
        controller.enqueue(encoder.encode(JSON.stringify({ type: 'coverage_item', item: coverage[i] }) + '\n'));
        await new Promise((r) => setTimeout(r, REPLAY_DELAY_MS));
      }
    }
    // replay the recorded monitoring trace (the agent's real EQL queries)
    for (const t of trace) {
      if (t.kind === 'tool') {
        const toolName = t.toolName ?? 'execute_analytics_eql';
        await emit({ type: 'tool_call_start', toolName, agent: 'monitoring' });
        await emit({ type: 'tool_call_end', toolName, agent: 'monitoring',
                     durationMs: t.durationMs ?? 0, result: t.result, error: t.error });
      } else if (t.content) {
        await emit(stepEvt(t.content));
      }
    }
    for (const insight of insights) await emit({ type: 'insight', insight });
    await emit({ type: 'done' });
  },
});
```

Three load-bearing details:

- **`REPLAY_DELAY_MS = 140`** — the constant that makes the replay feel like a live scan. Without it, all events would fire in one tick and the UI would have nothing to render progressively. With it, the user sees the coverage grid fill tile-by-tile, the status panel update line-by-line, the cards appear one-by-one. The 140ms is a presentation-engineering choice — fast enough to feel responsive, slow enough that the agent's reasoning is readable as it scrolls past.
- **Same event order as live.** The replay sends `workspace` first, then the coverage checklist + grid tiles, then the monitoring tool-call trace, then the insights, then `done`. This is exactly the order the live route emits. The consumer doesn't have to special-case demo.
- **Same wire contract.** Each `emit(...)` calls `encoder.encode(JSON.stringify(e) + '\n')` — the same NDJSON framing the live producer uses. The consumer's `readNdjson` kernel doesn't know it's reading a replay. → see `06-streaming-ndjson.md`.

```
  Pattern — the replay loop, one event at a time

  for each captured event in order:
    enqueue(encode(JSON.stringify(event) + '\n'))   ← put bytes on wire
    await sleep(140ms)                              ← pace for the UI
  end:
    enqueue({ type: 'done' })
    close()
```

#### the snapshot file shape

The captured file is a superset of `BriefingResponse`:

```ts
// app/api/briefing/route.ts:28-36
type DemoTraceItem =
  | { kind: 'step'; content?: string }
  | { kind: 'tool'; toolName?: string; result?: unknown; durationMs?: number; error?: string };

type DemoSnapshot = {
  workspace?: BriefingWorkspace;
  coverage?: CoverageReport;
  trace?: DemoTraceItem[];
  insights?: Insight[];
};
```

Four top-level keys. `workspace` and `coverage` carry the briefing-only opening events. `trace` carries the monitoring agent's tool calls and text steps in order. `insights` carries the final result. The replay loop iterates `coverage` (with its checklist), then `trace` (with the tool calls), then `insights`. Each captured event lights up its corresponding live event type.

The investigation snapshot is the same shape per investigation:

```
  lib/state/demo-investigations.json (sketch)
  {
    "<insightId-1>": [
      { "type": "reasoning_step", "step": {...} },
      { "type": "tool_call_start", "toolName": "...", "agent": "diagnostic" },
      { "type": "tool_call_end", ... },
      { "type": "reasoning_step", ... },
      { "type": "diagnosis", "diagnosis": {...} },
      { "type": "reasoning_step", ... },
      { "type": "recommendation", "recommendation": {...} },
      { "type": "done" }
    ],
    "<insightId-2>": [...],
    ...
  }
```

The agent route's demo branch filters per step: when the request asks for `step=diagnose`, the replay emits only the diagnostic events (reasoning + tool calls + the `diagnosis` event + `done`). When the request asks for `step=recommend`, the replay emits only the recommendation events. The same file backs both step-2 and step-3.

#### the dev-only capture flow — three phases

`useDemoCapture` (`lib/hooks/useDemoCapture.ts`, 146 LOC) is the recording side. It runs only in dev (gated at the call site by `NODE_ENV !== 'production' && !isDemo`). Three sequential phases:

```
  Pattern — the dev-only capture, three phases

  ┌─ Phase 1: capture the live briefing ────────────────┐
  │  POST /api/mcp/capture-demo                         │
  │    (server-side: run live briefing, write           │
  │     lib/state/demo-insights.json with the           │
  │     workspace + coverage + trace + insights)        │
  └──────────────┬──────────────────────────────────────┘
                 │
                 ▼
  ┌─ Phase 2: capture each investigation ───────────────┐
  │  for each insight (sequentially, rate-limit):       │
  │    fetch /api/agent (live mode, step=null)          │
  │    drain NDJSON via readNdjson                      │
  │    server writes to lib/state/demo-investigations…  │
  └──────────────┬──────────────────────────────────────┘
                 │
                 ▼
  ┌─ Phase 3: bundle ──────────────────────────────────┐
  │  POST /api/mcp/capture-demo again                  │
  │    (server-side: re-bundle now that investigations │
  │     are cached, so the briefing JSON has both      │
  │     the feed and the per-card replays)             │
  └─────────────────────────────────────────────────────┘
```

The capture is *one click* in the dev UI. After capture, `git diff` shows changes to two committed JSON files; commit them, and the demo path is permanently updated.

The sequential phase 2 is the rate-limit-aware piece — running investigations in parallel would blow the Bloomreach upstream's `~1 req/s` ceiling. The `readNdjson` kernel drains each investigation's events fully before starting the next, so the capture honours the spacing the live system enforces.

#### the integrated path — the same UI handles both

```
  Layers-and-hops — the same hook reads live and demo

  ┌─ page.tsx ────┐  state: mode = 'demo' | 'live-bloomreach' | 'live-synthetic'
  └──────┬────────┘
         │
         │  useBriefingStream(mode, ready, callbacks)
         ▼
  ┌─ hook ────────────────────────────────────────────────┐
  │  url = isDemo ? '/api/briefing?demo=cached'            │
  │                : `/api/briefing?mode=${mode}`           │
  │                                                         │
  │  fetch(url)                                             │
  │    ├─ status 401 → redirect to authUrl                  │
  │    ├─ ct != ndjson → plain JSON fallback (snapshot)     │
  │    └─ readNdjson(body, handle, {cancelOn})              │
  └──────────────────────────────────────────────────────────┘
```

The hook is *identical* for demo and live. The URL differs; the response handling does not. The 9-case event dispatcher inside `handle` does not check `mode`. The UI does not know which branch served the response.

The fallback at "content-type != ndjson" exists for the case where the snapshot file is somehow malformed and the route fell back to plain JSON. The hook still parses it, still renders the cards. Triple fallback: NDJSON stream → plain JSON → empty state with an error.

#### the trade — what the demo path *doesn't* do

The demo path is explicit about what's been replayed and what hasn't. The `QueryBox` (the free-form "ask anything" surface) is *inert* in demo — it shows the input with a "switch to live to use" placeholder but doesn't submit (`SHOW_QUERY_BOX = false` even hides it entirely today). Investigations replay only the captured trace, so card-clicks always show the same answer for the same insight; if a user clicked an insight that wasn't captured (impossible in the current shape, but allowed by the data model), the demo branch would 404 the investigation and the UI would surface an error. The demo is honest about being a recording, not a simulation.

### Move 3 — the principle

A demo path that *shares the wire contract* with the live path is a presentation-grade default. The contract is the same NDJSON stream the live path emits; the only difference is the producer. Because the consumer is contract-driven (it reads any `AgentEvent` on the wire and renders), the demo path costs nothing on the consumer side and gives back complete presentation reliability on the producer side.

The transferable lesson: when an upstream is flaky, the wrong move is "wrap the upstream in retries until it's reliable." The right move is "capture a known-good run as an artifact, replay the artifact when reliability matters more than freshness." This works for any system where (a) the output is reproducible from inputs you can capture, and (b) the consumer is shape-driven, not source-driven. Demos and presentations are the obvious cases; integration tests are another (record once, replay forever, no flake).

## Primary diagram

```
  demo-replay-as-reliability — full picture

  ┌─ Capture (dev-only, periodic, manual) ────────────────────────────────┐
  │                                                                        │
  │  page.tsx (dev) → useDemoCapture(insights, workspace, traceItems)      │
  │                                                                        │
  │  Phase 1: POST /api/mcp/capture-demo                                   │
  │    → server runs live briefing                                         │
  │    → writes lib/state/demo-insights.json {                             │
  │         workspace, coverage, trace, insights }                         │
  │                                                                        │
  │  Phase 2: for each insight (sequential, rate-limit-aware):             │
  │    → fetch /api/agent live, step=null (combined run, used by capture)  │
  │    → readNdjson drains the events                                      │
  │    → server caches the run in lib/state/demo-investigations.json       │
  │                                                                        │
  │  Phase 3: POST /api/mcp/capture-demo again                             │
  │    → re-bundles so demo-insights.json has all card replays ready       │
  │                                                                        │
  │  git diff lib/state/demo-*.json → commit                               │
  └────────────────────────────────────────────────────────────────────────┘

  ┌─ Storage (committed) ──────────────────────────────────────────────────┐
  │  lib/state/demo-insights.json                                          │
  │    { workspace?, coverage?, trace?, insights? }                        │
  │                                                                        │
  │  lib/state/demo-investigations.json                                    │
  │    { "<insightId>": AgentEvent[] }   per insight                       │
  └────────────────────────────────────────────────────────────────────────┘

  ┌─ Replay (every demo request) ──────────────────────────────────────────┐
  │                                                                        │
  │  GET /api/briefing?demo=cached                                         │
  │    if file exists:                                                     │
  │      open ReadableStream                                               │
  │      for each captured event in order:                                 │
  │        controller.enqueue(encode(JSON.stringify(event) + '\n'))         │
  │        await sleep(REPLAY_DELAY_MS = 140)                              │
  │      controller.enqueue({ type: 'done' })                              │
  │                                                                        │
  │  POST /api/agent (with insightId, step=diagnose|recommend)             │
  │    if mode=demo + investigation cached:                                │
  │      open ReadableStream                                               │
  │      filter events by `agent` field matching the step                  │
  │      replay with the same spacing                                      │
  │                                                                        │
  │  Same NDJSON contract on the wire as the live path                     │
  │  Same readNdjson kernel on the consumer side                           │
  │  UI does not know which branch served it                               │
  └────────────────────────────────────────────────────────────────────────┘
```

## Elaborate

**Why `REPLAY_DELAY_MS = 140`.** The number is a presentation-engineering choice. At 0ms, all events fire in one tick; the UI renders the final state instantly and the progressive-reveal experience is lost. At 1000ms, the replay feels artificially slow. 140ms lands in the readable-but-responsive band — the coverage tiles resolve at about 7Hz, which matches the rough cadence of human attention scanning a grid; the status log lines flow past at a readable speed; the cards appear one-by-one with enough time to register but not enough to feel padded.

**The artifact is a teaching surface.** The committed `demo-*.json` files are also documentation of "what a real run looks like." A reader who wants to know the wire contract concretely can open `lib/state/demo-insights.json`, scroll through `trace`, see the actual EQL queries the monitoring agent ran on a real Bloomreach workspace, see what `Insight` shapes the system produces. That's pedagogically valuable; integration tests can also load these files as fixtures.

**Why not generate the demo data programmatically.** A `SyntheticDataSource` does exist (516 LOC of fixtures), and `live-synthetic` is the mode you'd pick to test the agent loop without Bloomreach. But the demo path is *not* `live-synthetic` — the demo path is a *recording of a real run*. Synthetic data is too clean; real data has the small inconsistencies and surprises that make the demo feel honest. The choice to commit a real recording rather than generate fakes is the choice to ship the truth of one specific run.

**Demo as the default mode.** `'demo'` is the default value of `bi:mode` (`app/page.tsx:62`). The first time anyone opens the app, they see the demo. This is the strongest possible vote of confidence in the demo path: it is what we show first, not what we fall back to. The honest framing in the comment block on `page.tsx:54-60` makes it explicit: "Demo serves the cached snapshot — instant + reliable, ideal for a presentation and the default."

**The `NEXT_PUBLIC_DEMO_ONLY` lock.** `app/page.tsx:61, 69-70` shows a deployment-time hard lock — set `NEXT_PUBLIC_DEMO_ONLY=1` and the UI hides the live toggle entirely. This is the architectural acknowledgement that some deployments (a public-facing demo URL, a portfolio piece, a hackathon entry) should *never* even try the live path. The seam supports it because the mode is a runtime branch, not a build-time choice.

## Interview defense

**Q: Why is the demo the *default* mode and not just a fallback?**

> Because the live upstream — Bloomreach's loomi connect alpha — is presentation-hostile. It rate-limits at ~1 req/s, sometimes at 1-per-10s, and revokes OAuth tokens after a few minutes. A first-time visitor or a demo audience can't be the one to discover that the auth has rotted or the rate limit is angry. The demo path replays a committed JSON snapshot as if it were a live NDJSON stream — same event order, same wire contract, 140ms spacing between events so the progressive UX matches the live cadence. It's instant, requires no auth, can't fail. So we set `bi:mode` default to `'demo'` and give the user a runtime toggle when they want to see the real thing. The deeper architectural decision: the demo is shaped by the *contract*, not by the data — it reuses the same NDJSON wire and the same `readNdjson` consumer, so the UI is identical for both. That's why it earns "default" instead of "fallback."

```
  the contract-driven shape

  live producer      ──┐
  demo replay        ──┤── same NDJSON wire ──► same readNdjson ──► same UI
                       │
  (consumer doesn't know which branch served it)
```

**Anchor:** `app/api/briefing/route.ts:77-152`, `app/page.tsx:62`, `lib/state/demo-insights.json` (committed).

**Q: What's the load-bearing piece of the demo branch — what would break the replay if it went wrong?**

> The `REPLAY_DELAY_MS` spacing and the captured event order. The spacing is what makes the replay look like a live scan — without it, all events fire in one tick and the UI renders the final state instantly, losing the progressive-reveal experience that's the actual product pitch ("watch the agent work"). The event order is what makes the replay *correct* — the demo branch emits `workspace` first, then the coverage checklist with grid tiles, then the monitoring trace, then the insights, then `done`, which is the same order the live route emits. If those two pieces drift from the live producer, the UI either renders nothing for 30 seconds or renders something the consumer doesn't expect. Beyond those two, everything else (the file format, the JSON parsing, the `done` event) is hardening — the replay would work without `cache-control: no-store` or the trailing flush, but it wouldn't *feel* live.

```
  the kernel

  REPLAY_DELAY_MS = 140                  ← spacing makes replay feel live
  event order matches live producer       ← consumer special-cases nothing

  hardening (not the kernel):
    cache-control headers, content-type, file existence check
```

**Anchor:** `app/api/briefing/route.ts:23-26, 109-140`.

**Q: How do you keep the demo snapshot in sync with the live system as the code evolves?**

> Two mechanisms. First, the wire contract — `AgentEvent` in `lib/mcp/events.ts` is a TypeScript union with eight cases, and both producers (live route and demo replay) emit instances of that union. A new required field on `Insight` or a new event type breaks both code paths at compile time; the demo branch and the live branch will be updated together or fail together. Second, the dev-only capture flow — `useDemoCapture` is one click in the dev UI; it runs the live briefing, runs each investigation, and rewrites `lib/state/demo-*.json`. So when the agent prompts change or the schema evolves, you re-capture, commit the new JSON, and the demo updates. The capture is deliberate, not automatic — that's the trade. An automatic capture on every commit would drift unnoticed; a manual capture is a deliberate "yes, this is the demo we want to ship" decision.

```
  the sync mechanisms

  static:  AgentEvent union → TypeScript breaks both branches together
  dynamic: useDemoCapture → one-click rebuild of demo-*.json from a live run
           git commit demo-*.json → demo is updated for everyone
```

**Anchor:** `lib/mcp/events.ts:4-12`, `lib/hooks/useDemoCapture.ts:9-28`.

## See also

- `06-streaming-ndjson.md` — the wire format the demo branch reuses
- `07-in-memory-state-ownership.md` — the demo snapshots as the durable fallback
- `05-framework-runtime-only.md` — the `ReadableStream` body shape used by both branches
- `01-request-flow.md` — the live branch the demo branch replaces
