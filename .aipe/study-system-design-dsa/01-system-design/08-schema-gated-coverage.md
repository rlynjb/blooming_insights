# Schema-gated coverage

**Industry name(s):** capability gating / graceful degradation, schema-driven feature flags, progressive disclosure of a streamed result
**Type:** Industry standard · Language-agnostic

> A pipeline stage that tests a fixed checklist against the live data schema before doing any work, then streams the per-item verdict to the UI so the grid fills tile-by-tile and shows honest "no data" placeholders for what the workspace can't support.


---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Schema-gated coverage is a stage in the briefing route that sits *between* schema bootstrap and `MonitoringAgent.scan`, and the gate's verdict is streamed out as `coverage_item` events while the runnable subset is handed forward to the agent. The pure functions live in `lib/agents/categories.ts` (the DSA primitive is `../02-dsa/07-coverage-gate.md`); the orchestration lives in `app/api/briefing/route.ts`; the UI consumer is `components/feed/CoverageGrid.tsx`. It is a cross-cutting concept: one upstream computation (the schema check) produces two downstream outputs (UI state for the grid, runnable subset for the agent).

```
Zoom out — where schema-gated coverage lives

┌─ UI ───────────────────────────────────────────┐
│  CoverageGrid.tsx (10 tiles, fills tile-by-tile)│
│  app/page.tsx (accumulates coverage_item events)│
└─────────────────────▲──────────────────────────┘
                      │  NDJSON: coverage_item per category
┌─ Route handler ─────┴──────────────────────────┐
│  app/api/briefing/route.ts                     │
│  bootstrapSchema(mcp) → schema                 │
│         │                                       │
│  ★ schemaCapabilities(schema) → Set<string> ★ │ ← we are here
│  ★ coverageReport(set) → 10 items (UI) ★      │
│  ★ runnableCategories(set) → subset (agent) ★ │
│         │                                       │
│         ▼                                       │
│  MonitoringAgent.scan(hooks, runnable)         │
└─────────────────────┬──────────────────────────┘
                      │
┌─ Agent + Provider wrappers ────────────────────┐
│  spends ~1 req/s budget on runnable only       │
└────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question is: how does a pipeline decide *what work is even possible* for this particular workspace, do it before spending a constrained budget, and tell the user honestly which parts couldn't run? The answer is a three-function gate (`schemaCapabilities` flattens the schema into a `Set<string>` of capability tokens; `coverageReport` classifies all 10 categories as `full`/`limited`/`unavailable`; `runnableCategories` keeps the non-`unavailable` ones), run *before* `runAgentLoop` ever fires. One computation, two consumers: the report drives the grid (including ghost tiles for unsupported categories), the runnable subset bounds the agent's `maxToolCalls: 6` budget. The next sections walk the stage, the streaming reveal, and how the three tile states map to three UI vocabularies.

---

## How it works

### Mental model

Three stages, one request. **Gate:** flatten the bootstrapped schema into a capability set and classify the 10-category checklist against it (this is the pure operation in `../02-dsa/07-coverage-gate.md`). **Run:** hand the agent only the runnable categories so it never queries the impossible. **Stream:** emit the verdict one category at a time over the same NDJSON channel the agent's trace uses, so the grid fills progressively instead of popping in whole. The gate is the cheap filter that protects the expensive stage and feeds the UI.

```
 schema (bootstrapped)
        │  gate  (free, in-memory)
        ▼
 coverageReport[10]  ──stream per item──►  CoverageGrid (tiles fill in)
 runnableCategories ──►  MonitoringAgent.scan(hooks, runnable)  (spends budget on the possible)
```

The gate sits between "we know the schema" and "we spend the budget" — the same slot a feature flag occupies between config and render.

---

### Where it sits in the request

In the briefing route handler the live path bootstraps the schema, then — before listing tools or constructing the agent — computes the gate and emits its verdict. Only then does the monitoring agent run, scoped to the runnable set.

```
 /api/briefing  (live)
   bootstrapSchema(mcp)                         → schema
        │
        ▼  ── coverage gate (new stage) ──────────────────────────
   schemaCapabilities(schema)                   → Set<string>
   coverageReport(capabilities)                 → CoverageItem[10]
   runnableCategories(capabilities)             → AnomalyCategory[]
        │   send checklist steps + one coverage_item per category
        ▼  ──────────────────────────────────────────────────────
   agent.scan(hooks, runnable)                  → anomalies (only runnable categories)
   anomalies.map(anomalyToInsight) → insights → stream → done
```

The gate is upstream of the shared agent loop — it changes *which* categories the monitoring agent is told to check (a prompt-level checklist), not how the shared loop runs. See `06-multi-agent-orchestration.md`.

---

### Streaming the verdict (progressive disclosure)

The gate's output isn't sent as one blob — it's streamed one category at a time so the grid fills in step with a per-category checklist log. The briefing uses a local superset event type so the shared `AgentEvent` contract stays untouched (see `05-streaming-ndjson.md`):

```
 BriefingEvent =
   | AgentEvent
   | { type: 'workspace';     workspace }
   | { type: 'coverage_item'; item: CoverageItem }   ← one category's verdict
   | { type: 'coverage';      coverage }              ← bulk form (plain-JSON fallback)
```

Per category, the route emits a reasoning step (the checklist log line) and a `coverage_item` (the tile), so log and tile land together:

```
 for each category in coverageReport:
     send reasoning_step  "conversion rate drop · monitored"
     send coverage_item   { category:'conversion_drop', coverage:'full' }
                                        │
 client (feed page) accumulates ───────┘
     setCoverage(prev => prev.has(item) ? prev : [...prev, item])
                                        │
 CoverageGrid renders ──────────────────┘
     tile reported?  → resolved tile (clear / limited / firing)
     not yet + loading? → pending "checking…" skeleton tile
```

In demo mode the same sequence replays from the captured snapshot at a fixed delay (around 140 ms) between events, so the creds-free demo discloses exactly like a live run (see `01-request-flow.md`'s demo hop).

---

### Graceful degradation as UI state

The three gate verdicts map to three honest tile states. The grid renders all 10 categories from the fixed registry, so a workspace's *gaps* are visible, not hidden:

```
 coverage   tile                         meaning
 ────────   ──────────────────────────   ────────────────────────────────────────
 full       clear / firing               runnable; fired an anomaly → coral, click-through
 limited    amber "limited"              runnable, reduced confidence (a soft dep missing)
 unavailable dashed "no data source"     can't run — required event not emitted here
 (pending)  pulsing "checking…"          gate hasn't reported this category yet (loading)
```

A coverage note ("checked N of 10 … skipped search failure, fraud detection — the required events aren't emitted here") closes the loop in words. The user sees the whole checklist and *why* parts are dark — the opposite of silently dropping unsupported features.

---

## Schema-gated coverage — diagram

Primary recap, labelled by layer.

```
┌─ UI layer (app/page.tsx · components/feed/CoverageGrid.tsx) ───────────────────┐
│   CoverageGrid: 10 tiles from the fixed registry                               │
│     reported → clear / amber / firing / ghost     not-yet → "checking…" pulse  │
│     accumulates coverage_item events: setCoverage(prev => […prev, item])       │
└───────────────────────────────▲────────────────────────────────────────────────┘
                                 │  NDJSON: coverage_item per category (+ checklist log)
─────────────────────────────────│──── Network boundary (chunked NDJSON stream) ──
┌─ Route / Service layer (app/api/briefing/route.ts) ────────────────────────────┐
│   bootstrapSchema → schema                                                      │
│        │                                                                        │
│   ┌─ coverage gate (lib/agents/categories.ts) ───────────────────────────┐     │
│   │  schemaCapabilities(schema) → Set<string>                            │     │
│   │  coverageReport(set)      → CoverageItem[10]  ──► stream to UI        │     │
│   │  runnableCategories(set)  → AnomalyCategory[] ──┐                     │     │
│   └─────────────────────────────────────────────────│─────────────────────┘     │
│        │                                             ▼                           │
│   MonitoringAgent.scan(hooks, runnable)  ── spends ~1 req/s budget on the       │
│        │                                     runnable categories only            │
│        ▼                                                                         │
│   anomalies → insights → stream → done                                          │
└──────────────────────────────────────│──────────────────────────────────────────┘
                                        ▼  Provider layer
                          Bloomreach MCP (events/properties/catalogs = the schema)
```

The gate is a free, in-memory checkpoint that does two jobs at once: it bounds the expensive downstream stage, and it produces the UI's coverage state. Both fall out of the same classification.

---

## Implementation in codebase

**File:** `app/api/briefing/route.ts` (gate + stream), `lib/agents/categories.ts` (the gate functions), `components/feed/CoverageGrid.tsx` (the UI), `app/page.tsx` (the client accumulator)
**Function / class:** the `GET` handler's coverage stage; `schemaCapabilities` / `coverageReport` / `runnableCategories`; `CoverageGrid`; the briefing `handle()` switch
**Line range:**
- `app/api/briefing/route.ts` L23 (`REPLAY_DELAY_MS`), L54–L58 (`BriefingEvent` superset), L113–L117 (demo per-category emit), L202–L204 (gate), L208–L211 (live checklist + `coverage_item`), L223 (`scan(hooks, runnable)`)
- `lib/agents/categories.ts` L116–L160 (the gate — see `../02-dsa/07-coverage-gate.md`)
- `components/feed/CoverageGrid.tsx` L61–L74 (`loading`, `byCat`, `settling`), L117–L124 (pending tile), L156 (ghost), L198 (firing)
- `app/page.tsx` L333–L339 (`coverage_item` accumulator), L624 (`<CoverageGrid … loading={…} />`)

The gate stage in the live route (L202–L211):

```ts
const capabilities = schemaCapabilities(schema);
const coverage = coverageReport(capabilities);
const runnable = runnableCategories(capabilities);

step('matching the workspace schema to the 10-category anomaly checklist…');
const coverageLines = coverageChecklistSteps(coverage);
coverage.forEach((item, i) => {
  step(coverageLines[i]);             // checklist log line  → status panel
  send({ type: 'coverage_item', item }); // tile             → coverage grid
});
// …then: agent.scan(hooks, runnable)  (L223) — runnable categories only
```

The client accumulates one tile at a time (`app/page.tsx` L333–L339):

```ts
case 'coverage_item':
  setCoverage((prev) =>
    prev.some((c) => c.category === evt.item.category) ? prev : [...prev, evt.item],
  );
  break;
```

The grid renders pending tiles for not-yet-reported categories while loading (`CoverageGrid.tsx` L117–L124, gated by `loading`).

GitHub: https://github.com/rlynjb/blooming_insights/blob/main/app/api/briefing/route.ts#L202-L223

---

## Elaborate

### Where it comes from

This is the server-side cousin of progressive enhancement. On the front end you feature-detect (`'IntersectionObserver' in window`) and degrade the UI; here the route feature-detects the *workspace schema* and degrades the *checklist*, then ships the degradation verdict to the client as data. The "fill tile-by-tile" reveal is progressive disclosure — the same idea as a skeleton screen resolving section by section, except each section's resolution is a real classification result, not a timer.

It is also a feature flag evaluated against runtime facts instead of a config file: "is category X enabled?" becomes "does this workspace's schema satisfy category X's requirements?"

### The deeper principle

Compute the cheap gate before the expensive work, and let one computation serve two masters. The schema check costs nothing (in-memory set membership); the monitoring agent costs real budget (network calls under a rate limit, bounded by a 300 s ceiling). Doing the free filter first means the expensive stage never wastes a call on the impossible. And because the gate's verdict is exactly what the UI needs to render coverage, you don't compute it twice — the same `coverageReport` that scopes the agent *is* the grid's data.

```
 cheap gate (in-memory)  ──┬──► scopes the expensive stage (budget protection)
                           └──► is the UI's coverage state (no second computation)
```

### Where it breaks down

**Bursty reveal vs network.** Streaming one `coverage_item` per category gives a tile-by-tile fill — but only the *demo* path paces it (`REPLAY_DELAY_MS`). On a live run the gate is instant, so all 10 items flush back-to-back and the grid effectively resolves at once; the progressive reveal is a demo-replay property, not an inherent live one. The honest framing: live's slow, visible work is the EQL phase that follows, not the gate.

**Declared ≠ populated.** The gate green-lights a category whose events the schema *declares*; whether the window has data is a separate runtime check the agent does. A `full` tile can still produce no anomaly (a "clear" tile), which is correct but can read as "nothing happened" when it sometimes means "monitored, no data this window."

**Registry drift.** The 10 categories and their dep tokens are hard-coded. A workspace using non-standard event names reads as `unavailable` (see the exact-string coupling in `../02-dsa/07-coverage-gate.md`). The gate is only as good as the registry's vocabulary matching the schema's.

### What to explore next

- **Persist the coverage report** alongside insights so the investigate page and exports can show "this briefing covered 7/10 categories" without recomputing.
- **Onboarding nudges** — invert the gate (capability → categories it would unlock) to tell a workspace "emit `search` events to unlock search-failure monitoring."
- **Per-category budget hints** — fold each category's expected EQL cost into the gate so the agent can prioritise under a tight 300 s ceiling, not just include/exclude.

---

## Interview defense

**What they are really asking.** Whether you'd do the cheap check before the expensive work, whether you understand reusing one computation for two purposes, and whether you can defend honest degradation over a prettier fake.

---

**[mid] Why gate the checklist before running the agent instead of running all categories and ignoring the empty results?**

Because the work is budget-bound. Each category the agent runs is a network call under a ~1 req/s limit inside a 300 s function ceiling. Querying a category whose required event the workspace never emits spends a call to learn nothing. The gate is an in-memory set check — effectively free — so filtering first means every spent call is on a category that *can* produce a result.

```
 gate (free)  → 7 runnable        → 7 budgeted calls, all useful
 no gate      → 10 queried        → 3 guaranteed-empty calls wasted under the limit
```

---

**[senior] You stream `coverage_item` per category. Why not just send the whole `coverageReport` in one event?**

Two reasons. First, progressive disclosure: paired with the per-category checklist log, the grid fills tile-by-tile so the user watches the checklist being worked through instead of a grid popping in whole (this is what the demo replay paces). Second, it keeps the briefing's event vocabulary consistent — everything is an incremental NDJSON event on one channel. The bulk `coverage` form still exists for the plain-JSON fallback path, but the streaming path accumulates items.

```
 one blob:   …                          ──► grid appears at once
 per item:   coverage_item × 10  ──► grid fills tile-by-tile (log + tile together)
```

---

**[arch] A category is gated `full`, the agent runs it, and it returns no anomaly. Has anything gone wrong, and how does the UI represent it?**

Nothing's wrong — `full` means *runnable*, not *will-fire*. The gate proves the schema declares the events; whether the window holds an anomaly is the agent's job. The grid represents this as a "clear" tile (monitored, no anomaly this window) — distinct from a ghost ("no data source", can't run) and from a firing tile (anomaly found, coral, click-through). The three-plus-one tile vocabulary exists precisely so "ran and found nothing" doesn't look like "couldn't run."

```
 full + anomaly   → firing (coral, click-through)
 full + none      → clear  (monitored, quiet)
 limited          → amber  (runs, reduced confidence)
 unavailable      → ghost  (can't run — required event absent)
```

---

**The dodge: "isn't streaming the tiles one-by-one just a cosmetic animation?"**

On a live run, largely yes — the gate is instant, so the items flush back-to-back and the grid resolves at once; the paced reveal is a demo-replay behavior (`REPLAY_DELAY_MS`). That's the honest position: we do *not* fake a delay on live data. What's genuinely incremental on a live run is the EQL trace that follows the gate — the agent's real per-query work, streamed as it happens. The coverage stream's real value isn't the animation; it's that the verdict (including ghosts) is first-class data the client renders honestly.

---

**Anchors (cite these in your answer)**

- `app/api/briefing/route.ts` L202–L204: the gate stage (`schemaCapabilities` → `coverageReport` → `runnableCategories`).
- `app/api/briefing/route.ts` L208–L211: per-category checklist log + `coverage_item` stream.
- `app/api/briefing/route.ts` L223: `agent.scan(hooks, runnable)` — the budget is spent only on runnable categories.
- `components/feed/CoverageGrid.tsx` L117–L124, L156, L198: pending / ghost / firing tile states.
- `app/page.tsx` L333–L339: the client accumulates `coverage_item`s into the grid.

---

## Validate your understanding

### Level 1 — Reconstruct

Without looking, draw the briefing pipeline from `bootstrapSchema` to `done`, placing the coverage gate as its own stage and showing both its outputs (the streamed `coverage_item`s to the UI, the `runnable` subset to `scan`). Then compare to the primary diagram above and to `app/api/briefing/route.ts` L189–L223. The gate must sit *before* `scan`, and `coverageReport` must feed both consumers.

### Level 2 — Explain

Walk a workspace that supports 7 of 10 categories through the live path. State, in order: what `bootstrapSchema` returns, what the gate computes, what gets streamed (how many `coverage_item`s, how many checklist steps), what `scan` receives, and what the grid shows for the 3 unsupported categories. Cite `app/api/briefing/route.ts` L202–L211 and `components/feed/CoverageGrid.tsx` L156 (ghost tile).

### Level 3 — Apply

**Scenario:** Product wants the demo feed to *visibly* fill tile-by-tile, but a live run resolves the grid instantly. Explain precisely why, where the difference lives in the code, and why we deliberately do NOT add the same delay to the live path. Then propose one honest way to give a live run a sense of progress without faking the gate's timing. Check your reasoning against `app/api/briefing/route.ts` L23 (`REPLAY_DELAY_MS`), L113–L117 (demo emit with delay), L208–L211 (live emit, no delay), and the demo hop in `01-request-flow.md`.

### Level 4 — Defend

Your PM says: "The ghost tiles look broken — just hide categories the workspace can't support so the grid only shows green." Counter-argue or agree. Consider: what a judge/user learns from seeing the full 10-category checklist with honest gaps, the product's stance on cosmetic vs. real, and whether hiding gaps changes the gate logic or only the render. Reference the `[arch]` answer and the coverage note.

### Quick check

- Which two outputs does the gate produce from one `coverageReport`, and who consumes each? `app/api/briefing/route.ts` L202–L223.
- Why is the gate run *before* `agent.scan` rather than after? Name the budget it protects.
- What event type carries one category's verdict, and why isn't it added to the shared `AgentEvent` union? (See `05-streaming-ndjson.md`.)
- What are the four tile states the grid can render, and which one is *not* a gate verdict?
- On a live run, is the tile-by-tile reveal real? What *is* the genuinely incremental work that follows the gate?

## See also

→ 01-request-flow.md · → 05-streaming-ndjson.md · → 06-multi-agent-orchestration.md · → ../02-dsa/07-coverage-gate.md
Updated: 2026-05-30 — Migrated to study.md v1.47 template (Phase 1+2 mechanical): removed Tradeoffs / Tech reference / Summary sections; renamed "In this codebase" → "Implementation in codebase"; moved See also to a bottom block. "Why care" preserved pending Phase 3 (Zoom out, then zoom in + LAYERS diagram) authoring.
Updated: 2026-05-30 — Phase 3 of study.md v1.47 migration: replaced "Why care" block with "Zoom out, then zoom in" (LAYERS diagram + zoom-in paragraph) per format.md.
Updated: 2026-05-31 — Applied study.md v1.48: scrubbed "How it works" of file paths, line refs, and real-code fences; replaced with generic role labels + pseudocode per format.md. Codebase-specific anchoring lives exclusively in "Implementation in codebase".
