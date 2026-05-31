# Capability gating

**Industry name(s):** capability gating / schema-driven feature detection, scope-before-spend, graceful degradation by availability
**Type:** Industry standard · Language-agnostic

> Before the monitoring agent runs, blooming insights classifies a fixed 10-category anomaly checklist against the live workspace schema and hands the agent only the categories the data can actually support — so a rate-limited agent never spends a query on data the workspace doesn't emit, and the UI shows honest "no data source" tiles for the rest.


---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Capability gating sits *between* the Per-agent definitions and the Tools layer: a cheap in-memory check of the live `WorkspaceSchema` decides which categories the monitoring agent is even *offered*. The gate (`schemaCapabilities` → `coverageReport` → `runnableCategories` in `lib/agents/categories.ts`) runs in the Briefing route *before* `MonitoringAgent.scan` is called, and the runnable set is passed in as the agent's checklist (`scan(hooks?, categories=[])` at `lib/agents/monitoring.ts` L69, injected via `{categories}` slot at L73–L86).

```
  Zoom out — where the gate sits

  ┌─ Route (briefing) ───────────────────────────────┐
  │  bootstrapSchema(conn.mcp) → WorkspaceSchema      │
  │  schemaCapabilities(schema) → Set                 │
  │  coverageReport → runnableCategories              │  ← we are here
  │    app/api/briefing/route.ts L202–204             │
  └─────────────────────────┬────────────────────────┘
                            │  runnable[] (subset of 10)
  ┌─ Per-agent ─────────────▼────────────────────────┐
  │  ★ scan(hooks, runnable) ★                        │
  │  builds per-category checklist into {categories}  │
  │  prompt slot   monitoring.ts L73–86, L69          │
  └─────────────────────────┬────────────────────────┘
                            │
  ┌─ Agent loop + Tools ────▼────────────────────────┐
  │  model only sees & queries the runnable categories│
  │  → no wasted budget on unsupported categories      │
  └──────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question is: when an agent's work is a list of independent checks, and each check needs specific data, how do you stop the agent from spending an expensive, rate-limited budget on checks the data cannot support? The fix is not a better prompt — the agent cannot know what the schema holds until it queries. The fix is *scope before spend*: run a free in-memory check against the schema first, and hand the agent only the runnable subset. How it works walks the three-stage gate (capabilities → coverage → runnable), and how the same computation produces both the agent's checklist and the UI's coverage grid.

---

## How it works

**Mental model.** The gate sits between "you know the schema" and "you spend the budget," exactly where a feature flag sits between config and render. It is a pure function: flatten the workspace schema into a set of capability tokens, then classify each of the ten registry categories by testing its declared dependencies against that set. Three outcomes — `full`, `limited`, `unavailable` — map to three things: which categories the agent runs, and (for the UI) which tiles render as live, degraded, or ghost.

```
GATE (free, in-memory, before the agent)        AGENT (expensive, rate-limited, after the gate)
─────────────────────────────────────────       ───────────────────────────────────────────────
schema (events + properties + catalogs)          agent.scan(hooks, runnable)
   │ schemaCapabilities → Set<string>              runs ONLY the runnable categories
   ▼                                               each = ~1 req/s MCP call, maxToolCalls-capped
coverageReport: classify 10 categories
   │  requires ⊆ caps? enriches ⊆ caps?
   ├─► runnableCategories (full + limited) ──────► fed into the prompt as a checklist
   └─► full report (incl. unavailable) ──────────► CoverageGrid tiles + "no data" ghosts
```

The gate decides *what the agent is allowed to attempt*; the agent decides *what's actually anomalous* within that. The narrowing is by data availability — distinct from `04-tool-routing.md`'s narrowing by agent role. Both shrink the decision space before a model call; this one shrinks it against the live schema.

---

### Building the capability set

`schemaCapabilities` (`lib/agents/categories.ts` L116–L127) flattens the workspace schema into one flat `Set<string>` whose only job is fast membership. Three token shapes: an event name (`"purchase"`), an event property (`"session_start.utm_source"`), and a catalog (`"catalog:inventory_level"`).

```
schemaCapabilities(schema)   (categories.ts L116–127)
─────────────────────────────────────────────────────────────
 for each event e:   set.add(e.name)                  "purchase"
                     for each property p:  set.add(`${e.name}.${p}`)
 for each catalog c: set.add(`catalog:${c.name}`)     "catalog:inventory_level"
 → Set<string>   (event names + event.property + catalog:<name>)
```

One pass over the schema. The output is the haystack every category's dependencies are tested against with O(1) `has()`.

---

### Classifying each category

The ten categories live in `CATEGORIES` (L19–L112). Each declares `requires` (hard deps — event names) and optional `enriches` (soft deps — properties/catalogs that improve the check). `coverageFor` (L131–L136) is the whole gate in three lines: miss any hard dep → `unavailable`; have the hard deps but miss a soft one → `limited`; all present → `full`.

```
coverageFor(cat, caps)   (categories.ts L131–136)
─────────────────────────────────────────────────────────────
 if NOT cat.requires.every(in caps):                    → 'unavailable'
 if cat.enriches?.length AND NOT enriches.every(in caps): → 'limited'
 else:                                                   → 'full'

 conversion_drop  requires[view_item,checkout,purchase] ✓        → full
 campaign_perf    requires[session_start]✓ enriches[utm_source]✗ → limited
 search_failure   requires[search]✗                              → unavailable
```

`coverageReport` (L144–L155) maps this over all ten in registry order (stable for the UI grid). `runnableCategories` (L158–L160) is the same walk filtered to the non-`unavailable` set — the list handed to the agent.

---

### Feeding the agent only the runnable set

`app/api/briefing/route.ts` runs the gate immediately after bootstrapping the schema, before constructing or running the monitoring agent (L202–L204), then passes the runnable subset into `agent.scan` (L223).

```
app/api/briefing/route.ts   (L202–223)
─────────────────────────────────────────────────────────────
 const capabilities = schemaCapabilities(schema);        L202
 const coverage     = coverageReport(capabilities);      L203  → streamed to the grid
 const runnable     = runnableCategories(capabilities);  L204
   … emit one coverage_item per category (the grid) …
 const anomalies = await agent.scan(hooks, runnable);    L223  ← gated work
```

`MonitoringAgent.scan(hooks?, categories: AnomalyCategory[] = [])` (`lib/agents/monitoring.ts` L69) takes that list and builds it into the prompt as a per-category checklist (L73–L86, via a `{categories}` slot in `prompts/monitoring.md`). So the agent is gated twice over: it's told to check only these categories *and* it only has the tools `monitoringTools` allows (`04-tool-routing.md`). The gate is upstream of `runAgentLoop` — it changes *what* the agent is asked to do, not *how* the shared loop runs.

---

### The principle

**Run the cheap check before the expensive actor.** The schema classification costs nothing — set construction plus thirty-ish membership tests, all in memory, no network. The agent costs real budget — rate-limited calls under a hard ceiling. Doing the free filter first means every spent call is on a category that *can* produce a result. And because the gate's verdict is exactly what the UI needs (live / degraded / ghost tiles), the same `coverageReport` that scopes the agent *is* the grid's data — one computation, two consumers. This is feature detection for an agent: detect what the environment supports, then degrade the work to fit, instead of attempting everything and discarding the failures.

---

## Capability gating — diagram

The diagram spans three layers. The Route layer runs the gate. The Agent layer receives only the runnable subset. The UI layer renders the full verdict. The gate is the cheap checkpoint that protects the expensive agent and feeds the grid.

```
┌──────────────────────────────────────────────────────────────────────┐
│  UI LAYER   components/feed/CoverageGrid.tsx                          │
│   10 tiles from the fixed registry:                                  │
│     full → clear/firing   limited → amber   unavailable → ghost      │
│   fed by coverage_item events streamed per category                  │
└───────────────────────────────▲───────────────────────────────────────┘
                                │  coverage (all 10, incl. ghosts)
┌───────────────────────────────┴───────────────────────────────────────┐
│  ROUTE LAYER   app/api/briefing/route.ts                             │
│   schema ──schemaCapabilities──→ Set<string>   (categories.ts L116)  │
│            ──coverageReport────→ CoverageItem[10]  L203 ─► UI         │
│            ──runnableCategories→ AnomalyCategory[]  L204 ─┐           │
└───────────────────────────────────────────────────────────│───────────┘
                                                            │ runnable (full+limited)
┌───────────────────────────────────────────────────────────▼───────────┐
│  AGENT LAYER   lib/agents/monitoring.ts                              │
│   scan(hooks, runnable)  L69  ── builds {categories} checklist L73-86 │
│     → runAgentLoop spends ~1 req/s MCP budget ONLY on runnable        │
│       (never queries the 3 categories the schema can't support)      │
└──────────────────────────────────────────────────────────────────────┘
```

A reader who sees only this diagram should grasp: one cheap schema classification both scopes the rate-limited agent (runnable subset) and renders the coverage grid (full report) — gate before spend.

---

## Implementation in codebase

**Case A — implemented.**

### The category registry + the gate functions

- **File:** `lib/agents/categories.ts`
- **Function / class:** `AnomalyCategory` (interface) · `CATEGORIES` · `schemaCapabilities` · `coverageFor` · `missingFor` · `coverageReport` · `runnableCategories`
- **Line range:** `AnomalyCategory` L7–L15 · `CATEGORIES` L19–L112 (10 categories) · `schemaCapabilities` L116–L127 · `coverageFor` L131–L136 · `missingFor` L139–L141 · `coverageReport` L144–L155 · `runnableCategories` L158–L160
- **Role:** Declares each category's `requires`/`enriches` deps; flattens the schema to a capability `Set`; classifies each category full/limited/unavailable; returns the full report (UI) and the runnable subset (agent).

### Where the gate runs and feeds the agent

- **File:** `app/api/briefing/route.ts`
- **Function / class:** `GET` handler — the coverage stage
- **Line range:** L202–L204 (`schemaCapabilities` → `coverageReport` → `runnableCategories`); L209–L212 (stream one `coverage_item` per category to the grid); L223 (`agent.scan(hooks, runnable)`)
- **Role:** Runs the gate after schema bootstrap and before the agent; streams the verdict to the UI; hands the agent only the runnable categories.

### Where the runnable set enters the prompt

- **File:** `lib/agents/monitoring.ts`
- **Function / class:** `MonitoringAgent.scan`
- **Line range:** L69 (signature `scan(hooks?, categories: AnomalyCategory[] = [])`); L73–L86 (builds the per-category checklist into the prompt's `{categories}` slot)
- **Role:** Turns the runnable list into the checklist the agent works through; with no list it falls back to an empty checklist (the default `[]`).

**Pseudocode — the gate stage** (`categories.ts` + `briefing/route.ts`):

```typescript
// categories.ts — the pure gate
function coverageFor(cat, caps) {                          // L131
  const has = d => caps.has(d);
  if (!cat.requires.every(has)) return 'unavailable';      // hard dep missing
  if (cat.enriches?.length && !cat.enriches.every(has)) return 'limited';
  return 'full';
}
function runnableCategories(caps) {                        // L158
  return CATEGORIES.filter(c => coverageFor(c, caps) !== 'unavailable');
}

// briefing/route.ts — scope before spend
const caps     = schemaCapabilities(schema);               // L202  free, in-memory
const coverage = coverageReport(caps);                     // L203  → grid
const runnable = runnableCategories(caps);                 // L204
const anomalies = await agent.scan(hooks, runnable);       // L223  spends budget on runnable only
```

GitHub: https://github.com/rlynjb/blooming_insights/blob/main/lib/agents/categories.ts#L116-L160

---

## Elaborate

### Where this pattern comes from

This is the **principle of least capability** applied to an agent's task list, and it is the server-side cousin of front-end progressive enhancement. On the web you feature-detect (`'share' in navigator`) and only offer what the browser supports; here you feature-detect the *workspace schema* and only run the checks the data supports. It is also a guard clause in the classic sense — `if (!canDoThis) return;` — lifted above an expensive actor so the actor never attempts the impossible. The cheap-check-before-expensive-actor ordering is the same instinct as validating a form with a regex before calling a verification API (see `04-tool-routing.md`'s heuristic-before-LLM router — same shape, different layer).

### The deeper principle

There are two ways to handle an action the environment can't support: *attempt it and handle the failure*, or *detect it's unsupported and never attempt it*. The second is strictly cheaper here because the expensive resource — the rate-limited, ceiling-bounded agent budget — is spent at attempt time, not failure time. Attempting search-failure detection on a workspace with no `search` events doesn't error; it returns an empty result after spending a real call. Detecting "no `search` event" up front costs a `Set.has`. Spend the microsecond, save the second. And the gate's output does double duty: the same `coverageReport` that scopes the agent renders the UI's three tile states, so availability detection and UI state are one computation, not two.

### Where this breaks down

The gate matches dependencies by **exact string**. `requires: ['purchase']` tested against a workspace whose event is named `purchases` finds no member and reports `unavailable` — a naming mismatch is indistinguishable from genuinely-missing data, with no alias or normalization layer. It is also a **static, declared** gate: a category's `requires` list is hand-authored, so a category whose real data need isn't captured in `requires`/`enriches` can be mis-gated. And membership proves an event is *declared* in the schema, not that the query *window* holds data — the gate prevents querying the impossible (no `search` event ever), but the agent's own volume check (`prompts/monitoring.md` — bail on an empty 90-day window) is a separate, later guard against the merely-empty.

### What to explore next

- **Alias / normalization layer** — lower-case and alias event names before building the set, so `Purchase` / `purchases` / `purchase` resolve together; trades exact-match precision for resilience to schema naming drift.
- **Weighted / ranked gating** — instead of a binary runnable/not, score each category `met/total` deps and have the agent prioritise the strongest signals first under a tight `maxToolCalls` budget (cross-link `../06-production-serving/02-llm-cost-optimization.md`).
- **Reverse index for onboarding** — map each capability token → the categories it would unlock, to tell a workspace "emit `search` events to unlock search-failure monitoring."

---

## Project exercises

### Cache the coverage report instead of recomputing per request

- **Exercise ID:** C5.3 (adapted to blooming insights)
- **What to build:** The gate recomputes `schemaCapabilities` + `coverageReport` on every briefing. The schema changes rarely. Memoize the report keyed by a cheap schema fingerprint (e.g., projectId + event-name count + a hash of event names) so a warm instance reuses it; recompute only when the fingerprint changes.
- **Why it earns its place:** A token/cost-economics signal — it removes a per-request computation that's identical across calls, and forces you to reason about what invalidates a capability set.
- **Files to touch:** `lib/agents/categories.ts` (add a memoized `coverageReportCached(schema)`); `app/api/briefing/route.ts` (L202–L204 call site); `test/agents/categories.test.ts` (assert recompute-on-fingerprint-change).
- **Done when:** Two briefings against the same schema compute the report once (verified by a spy/fake), and a changed event set recomputes it.
- **Estimated effort:** 1–4hr

### Add a normalization layer so schema naming drift doesn't read as "unavailable"

- **Exercise ID:** C4.9 (adapted to blooming insights; the "when not to gate-out" edge of "when not to use an agent")
- **What to build:** Today `coverageFor` matches event names by exact string, so a workspace emitting `purchases` (plural) against a `requires: ['purchase']` category reports `unavailable`. Add a normalization step (lower-case + a small alias map) applied both when building the capability `Set` and when reading a category's deps, so near-miss names resolve.
- **Why it earns its place:** Demonstrates you can locate the gate's brittle edge (exact-string coupling) and harden it without changing the gate's shape — and that you know when a category *should* run but the gate wrongly excludes it.
- **Files to touch:** `lib/agents/categories.ts` (`schemaCapabilities` + `coverageFor`); `test/agents/categories.test.ts` (a fixture workspace with a pluralized/cased event name that should still resolve to `full`).
- **Done when:** A workspace whose event is named `Purchases` classifies the `purchase`-dependent categories as `full`/`limited`, not `unavailable`, and the existing exact-match tests still pass.
- **Estimated effort:** 1–4hr

---

## Interview defense

### What an interviewer is really asking

"How do you stop the agent wasting calls on data that isn't there?" tests whether you reach for a prompt ("I tell it to skip empty categories") or for a pre-run check ("I gate the categories against the schema before it runs"). The senior answer is the gate — because the agent can't know what the schema holds until it queries, so a prompt instruction can't prevent the wasted query. "Why not just run everything and ignore empties?" tests whether you know what the agent's scarce resource is (the rate-limited, ceiling-bounded budget) and that it's spent at attempt time.

### Likely questions

**[mid] "How does the monitoring agent avoid querying a category the workspace has no data for?"**

It never gets the category. `app/api/briefing/route.ts` (L202–L204) runs `runnableCategories(schemaCapabilities(schema))` before the agent, and passes only the runnable subset into `agent.scan` (L223). A category like `search_failure` whose required `search` event isn't in the schema is classified `unavailable` by `coverageFor` and filtered out, so it's not in the checklist the agent works through. The prevention is structural — the agent isn't told "skip it," it's never asked to do it.

```
schema (no `search` event) ──coverageFor(search_failure)──→ unavailable
runnableCategories filters it out → agent.scan(hooks, [7 runnable]) → never queries search
```

**[senior] "Why gate before the agent runs instead of letting the agent decide what to check?"**

Two reasons. Cost: the gate is a `Set.has` per dependency, in memory, free; an agent self-selecting spends a reasoning turn and a slice of the `maxToolCalls` budget on a decision a membership test answers. Reliability: the agent can't actually *see* whether the data exists until it queries, so asking it to judge availability invites it to attempt the query anyway — the exact waste the gate prevents. The gate knows from the schema; the agent would only know from spending.

```
gate:  Set.has(dep)         → free, deterministic, knows from schema
agent: "should I check X?"  → costs a turn, probabilistic, can't see availability
```

**[arch] "The category dependencies are hand-authored exact-string lists. When does that stop working?"**

When schemas drift from the registry's vocabulary or the catalog grows. Exact-match means `purchases` ≠ `purchase` — a naming mismatch reads as `unavailable`, silently excluding a category that should run. The first fix is a normalization/alias layer applied to both the capability set and the deps. The second pressure is scale: ten hand-authored categories are tractable; hundreds aren't, and a static binary gate can't prioritise under a tight budget — at which point the gate becomes a weighted score (`met/total` deps) feeding a ranked, budget-aware run order.

```
today:  exact-string deps, binary runnable/not, 10 hand-authored categories
scale:  normalized matching + weighted score → ranked run order under maxToolCalls
```

### The question candidates always dodge

**"Does a `full` classification mean the category will find an anomaly?"**

No — and conflating the two is the dodge. `full` means *runnable*: the schema declares the events the category needs. Whether the 90-day window actually holds an anomaly is the agent's job, and whether it holds *any* data is a separate guard — the monitoring prompt does a volume check first and bails on an empty window. The gate prevents querying the *impossible* (no `search` event ever); the volume check prevents reporting on the *empty* (no purchases this window). A `full` tile that finds nothing renders as "clear," not "no data source" — and knowing that distinction is the senior signal.

### One-line anchors

- `lib/agents/categories.ts` L116–L127 — `schemaCapabilities`: flatten the schema to a capability `Set`.
- `lib/agents/categories.ts` L131–L136 — `coverageFor`: the three-valued gate (requires → enriches → full).
- `lib/agents/categories.ts` L158–L160 — `runnableCategories`: the non-`unavailable` subset handed to the agent.
- `app/api/briefing/route.ts` L202–L204, L223 — the gate runs, then `agent.scan(hooks, runnable)`.
- `lib/agents/monitoring.ts` L69 — `scan(hooks?, categories=[])`: the runnable set becomes the prompt checklist.

---

## Validate

### Level 1 — Reconstruct

From memory, draw the gate stage: schema → `schemaCapabilities` (Set) → `coverageReport` (10 classified) → the split into `runnableCategories` (to the agent) and the full report (to the grid). Label the gate as "free, in-memory, before the agent" and `agent.scan` as "expensive, rate-limited, after."

### Level 2 — Explain

Out loud: explain why a prompt instruction ("skip categories with no data") cannot prevent the wasted query, and why the gate can — anchor it to the fact that the agent can't see the schema's contents until it spends a call.

### Level 3 — Apply

Scenario: a workspace emits `view_item`, `cart_update`, `checkout`, `purchase`, `session_start` but no `search`, `return`, or `payment_failure` events, and has no inventory catalog. Walk the ten categories through `coverageFor` (`lib/agents/categories.ts` L131–L136 + the `CATEGORIES` deps L19–L112): how many are `full`, `limited`, `unavailable`? Which does `runnableCategories` (L158) hand to the agent, and what does the grid show for the rest? (Check: 5 full, 2 limited — `inventory` and `campaign_perf` miss a soft dep — 3 unavailable.)

### Level 4 — Defend

A reviewer says: "Delete the gate — just run all ten categories and ignore the empty results. Less code." Defend the gate using the agent's scarce resource (the ~1 req/s budget under a 300s ceiling, `maxToolCalls`-capped) and the silent-waste failure mode, then concede the condition under which the reviewer is right (a tiny, unmetered, latency-insensitive data source where the wasted calls cost nothing).

### Quick check — code reference test

What two outputs does the gate produce from a single `coverageReport`, and who consumes each? (Answer: `runnableCategories` → the monitoring agent's checklist via `agent.scan` at `briefing/route.ts` L223; the full `coverageReport` → the `CoverageGrid` via per-category `coverage_item` events at L209–L212. One computation, two consumers.)

## See also

→ 04-tool-routing.md · → 01-agents-vs-chains.md · → ../06-production-serving/02-llm-cost-optimization.md · → ../06-production-serving/04-rate-limiting-backpressure.md · → ../../study-system-design-dsa/01-system-design/08-schema-gated-coverage.md · → ../../study-system-design-dsa/02-dsa/07-coverage-gate.md

---
Updated: 2026-05-29 — created (the anomaly-coverage schema gate: scope the monitoring agent's category checklist against the live schema before spending the rate-limited budget)
Updated: 2026-05-30 — Migrated to study.md v1.47 template (Phase 1+2 mechanical): removed Tradeoffs / Tech reference / Summary sections; renamed "In this codebase" → "Implementation in codebase"; moved See also to a bottom block. "Why care" preserved pending Phase 3 (Zoom out, then zoom in + LAYERS diagram) authoring.
Updated: 2026-05-30 — Phase 3 of study.md v1.47 migration: replaced "Why care" block with "Zoom out, then zoom in" (LAYERS diagram + zoom-in paragraph) per format.md.
