# schema-gated-coverage

## Capability-gated work (project-specific)

A 10-category anomaly checklist (the `CategoryId` union in `lib/mcp/types.ts`) is matched against the live workspace's event schema *before* the monitoring agent runs. Categories whose required signals aren't present are surfaced honestly in the UI as `no data source` or `limited` and the agent never spends an EQL query on them. The gate runs in the briefing route between the schema bootstrap and the agent scan; it both shapes the user-visible coverage grid and trims the work the agent is allowed to do.

## Zoom out — where this pattern lives

The gate sits inside the briefing route, after the schema is loaded and before the agent is built.

```
  Zoom out — the gate as a junction between schema and agent

  ┌─ Service layer (briefing route) ────────────────────────────────────┐
  │                                                                      │
  │  bootstrap → WorkspaceSchema  (events, customer properties, …)       │
  │       │                                                              │
  │       ▼                                                              │
  │  ★ SCHEMA-GATED COVERAGE ★                                           │ ← we are here
  │    schemaCapabilities(schema) → Set<signal>                          │
  │    coverageReport(capabilities) → CoverageReport (UI grid + log)     │
  │    runnableCategories(capabilities) → AnomalyCategory[] (agent input)│
  │       │                                                              │
  │       ▼                                                              │
  │  MonitoringAgent.scan(runnable)   ← agent never sees skipped cats    │
  │                                                                      │
  └──────────────────────────────────────────────────────────────────────┘
```

The gate is the *junction* between the schema (the workspace's reality) and the agent (the work to do). Without it, the monitoring agent would spend rate-limit budget on EQL queries for categories the workspace can't answer (no `purchase` events → no revenue category) and the UI would show inferred-not-real answers.

## Structure pass

Three layers carry this pattern: the **schema** layer (the workspace shape from Bloomreach), the **gate** layer (the three pure functions in `lib/agents/categories.ts`), the **agent** layer (the scan that runs only on runnable categories). One axis worth tracing: **what does the system promise about each category?**

```
  Axis: what does the system promise per category?

  ┌─ schema layer ───────────────┐    raw signals (event names, properties)
  │  WorkspaceSchema             │   ═════╪═════►
  │    events[], customerProps[] │
  └──────────────────────────────┘
       ┌─ gate layer ──────────────┐    one promise per category:
       │  full / limited /         │      full → answer with confidence
       │  unavailable               │      limited → answer with caveat
       └────────────────────────────┘      unavailable → cannot answer
            ┌─ agent layer ─────────┐    runs only runnable (full + limited)
            │  scan(runnable)        │    unavailable: surfaced, not asked
            └────────────────────────┘
```

The axis flips at the gate: above it, the schema is just raw signals; below it, every category has a definite promise the system honours. The seam is the `CategoryCoverage` enum (`'full' | 'limited' | 'unavailable'`) — three categories of promise that drive both UI rendering and agent input.

## How it works

### Move 1 — the mental model

You've used a feature-detection pattern in the browser — `if ('serviceWorker' in navigator) { … }`. Capability check first, then run the feature. Schema-gated coverage is the same shape, applied to a *checklist* of features. The system has 10 anomaly categories (the checklist). Each category requires certain event types and properties (its capabilities). The schema gate asks, for each category, "does this workspace emit what I need?" — and routes the answer into one of three buckets.

```
  The pattern: feature detection per category, three buckets

  10 anomaly categories (the checklist):
    conversion_drop · cart_abandonment · product_demand · revenue_drop ·
    customer_churn · inventory · campaign_perf · search_failure ·
    return_spike · fraud

  for each category:
    if all required signals present + all enriching signals present:
      bucket = 'full'        → grid tile green, runnable
    else if all required signals present but enriching missing:
      bucket = 'limited'     → grid tile amber, runnable with caveat
    else (a required signal absent):
      bucket = 'unavailable' → grid tile gray, NOT runnable

  runnable = { 'full', 'limited' }  → input to MonitoringAgent.scan
  unavailable → never reaches the agent, surfaced in coverage grid only
```

### Move 2 — the step-by-step walkthrough

#### the inputs — `CategoryId`, `AnomalyCategory`, the 10-category list

The checklist is fixed in code, sourced from `@aptkit/core` as `ECOMMERCE_ANOMALY_CATEGORIES`. The Blooming compatibility shape is in `lib/agents/categories.ts`:

```ts
// lib/agents/categories.ts:14-24
export interface AnomalyCategory {
  id: CategoryId;
  label: string;
  requires: string[];                              // required signals (e.g. ['purchase', 'customer.country'])
  enriches?: string[];                             // enriching signals (soft-fail to 'limited' if missing)
  whyItMatters: string;                            // business-language reason
  eql: (projectId: string) => string;              // the EQL recipe to run
  thresholds: { critical: number; warning: number };
}

export const CATEGORIES: AnomalyCategory[] = ECOMMERCE_ANOMALY_CATEGORIES.map(toBloomingCategory);
```

The `CategoryId` union (`lib/mcp/types.ts:8-18`) enumerates the ten:

```ts
export type CategoryId =
  | 'conversion_drop' | 'cart_abandonment' | 'product_demand' | 'revenue_drop'
  | 'customer_churn' | 'inventory' | 'campaign_perf' | 'search_failure'
  | 'return_spike' | 'fraud';
```

Each category names what it `requires` (must have to even attempt the category) and what it `enriches` (would refine the answer if present). The `requires` vs `enriches` split is the load-bearing piece — it's what lets the coverage be three-bucket instead of two-bucket.

#### the gate — three pure functions

The gate has three entry points, all pure functions:

```ts
// lib/agents/categories.ts:10
export { schemaCapabilities };     // re-exported from @aptkit/core

// lib/agents/categories.ts:35-46
export function coverageReport(available: Set<string>): CoverageReport {
  return aptKitCoverageReport(CATEGORIES.map(toAptKitCategory), available).map((item) => ({
    category: item.category as CategoryId,
    label: item.label,
    coverage: item.coverage,
    ...(item.missing && item.missing.length ? { missing: item.missing } : {}),
  }));
}

export function runnableCategories(available: Set<string>): AnomalyCategory[] {
  return aptKitRunnableCategories(CATEGORIES.map(toAptKitCategory), available).map(toBloomingCategory);
}
```

Three functions, three jobs:

- **`schemaCapabilities(schema)`** — extracts the `Set<signal>` from the workspace schema. The signals are strings like `'purchase'`, `'customer.country'`, `'cart_update.cart_value'`. The library owns the extraction logic; this repo just re-exports.
- **`coverageReport(capabilities)`** — for the UI. Returns one `CoverageItem` per category with its bucket and (if any) the missing signals. Drives the coverage grid + the checklist log.
- **`runnableCategories(capabilities)`** — for the agent. Returns only the categories whose `requires` are met (the `'full'` and `'limited'` buckets). The `'unavailable'` bucket is dropped.

The two outputs are *consistent* — every category in `runnableCategories` appears as `'full'` or `'limited'` in `coverageReport`; every category in `'unavailable'` in `coverageReport` is absent from `runnableCategories`. The two come from the same underlying check; the API just exposes both views.

```
  Pattern — one check, two views

  schemaCapabilities(schema) → Set<signal>
                │
       ┌────────┴────────┐
       │                 │
       ▼                 ▼
  coverageReport()   runnableCategories()
   for UI grid        for agent scan
   { full, limited,    [ {AnomalyCategory}, … ]
     unavailable }     only full + limited

   both consistent: same underlying check, different shapes
```

#### the route — calls all three in sequence

The briefing route calls the gate between schema bootstrap and agent scan:

```ts
// app/api/briefing/route.ts:234-246
const t_coverage = performance.now();
const capabilities = schemaCapabilities(schema);
const coverage = coverageReport(capabilities);
const runnable = runnableCategories(capabilities);
// narrate the gate as a per-category checklist, resolving each tile as
// its line is logged (the grid fills in step with the checklist).
step('matching the workspace schema to the 10-category anomaly checklist…');
const coverageLines = coverageChecklistSteps(coverage);
coverage.forEach((item, i) => {
  step(coverageLines[i]);
  send({ type: 'coverage_item', item });
});
recordPhase('coverage_gate', t_coverage);
```

Three observations on this block:

- **The narration is part of the contract.** Each `step(...)` call emits a `reasoning_step` event; each `send({ type: 'coverage_item', ... })` emits a coverage tile. Both stream to the UI immediately. The user *sees* the gate happening, line by line and tile by tile, in the live status panel. → see `06-streaming-ndjson.md`.
- **`coverageChecklistSteps`** (`app/api/briefing/route.ts:40-48`) turns each `CoverageItem` into a human-readable line: `revenue · monitored`, `cart abandonment · limited — missing cart_value`, `fraud · no data source — needs payment_event, …`. The line is the per-category truth, no hedging.
- **Phase is timed.** `recordPhase('coverage_gate', t_coverage)` adds the gate's wall-clock to the request log. The gate is fast (it's all in-process set operations against the schema), so the timing is mostly for proportionality with the slower phases (`schema_bootstrap`, `monitoring_scan`).

#### the agent receives only the runnable categories

The agent's `scan` method takes the runnable list:

```ts
// app/api/briefing/route.ts:259-281 (key call)
const anomalies = await agent.scan({
  onToolCall: (tc) => { send({ type: 'tool_call_start', toolName: tc.toolName, agent: 'monitoring' }); … },
  onToolResult: (tc) => send({ type: 'tool_call_end', … }),
  onText: (t) => { if (t.trim()) step(t.trim()); },
  signal: req.signal,
}, runnable);
```

```ts
// lib/agents/monitoring.ts:82-93
async scan(hooks?: MonitorHooks, categories: AnomalyCategory[] = []): Promise<Anomaly[]> {
  const toolRegistry = new BloomingToolRegistryAdapter(this.dataSource, this.allTools);
  const agent = new AptKitAnomalyMonitoringAgent({
    model: new AnthropicModelProviderAdapter(this.anthropic, 'monitoring', this.sessionId),
    tools: toolRegistry,
    workspace: this.schema,
    trace: new BloomingTraceSinkAdapter(hooks ?? {}, 'monitoring'),
    categories: categories.length ? toAptKitCategories(categories, this.schema.projectId) : [],
  });
  return (await agent.scan({ signal: hooks?.signal })).map(toBloomingAnomaly);
}
```

The library agent never sees the `'unavailable'` categories. The agent's prompt mentions only the categories it can answer, the agent's tool loop runs only EQL the schema supports, and the rate-limit budget is spent only on work that can produce results.

```
  Layers-and-hops — gate trims the agent's input

  ┌─ schema ──────┐  10 categories total
  │  WorkspaceSchema│ ─────────────────────────┐
  └────────────────┘                            │
                                                ▼
                              ┌─ gate ─────────────────────────┐
                              │  schemaCapabilities → 6 signals │
                              │  coverageReport  → 10 items     │
                              │  runnableCategories → 7         │
                              └─────────────┬───────────────────┘
                                            │  hop: only runnable goes forward
                                            ▼
                              ┌─ agent ─────────────────────────┐
                              │  agent.scan(runnable)            │
                              │  prompt mentions only 7          │
                              │  EQL spent only on 7             │
                              └─────────────┬───────────────────┘
                                            │
                                            ▼
                              ┌─ result ────────────────────────┐
                              │  anomalies for runnable subset   │
                              │  3 unavailable: visible in UI    │
                              │   coverage grid, NOT in agent log│
                              └──────────────────────────────────┘
```

#### the three buckets — what the user sees and what the system does

```
  Comparison — three buckets, what each means in practice

  ┌─ 'full' ─────────────────────────┬─ tile color ─┬─ agent runs? ─┬─ caveat ──┐
  │ all required + all enriching     │ green        │ yes           │ none       │
  │ "revenue · monitored"            │              │               │            │
  ├──────────────────────────────────┼──────────────┼───────────────┼────────────┤
  │ 'limited'                        │              │               │            │
  │ all required, some enriching     │ amber        │ yes           │ "limited —│
  │ missing                          │              │               │ missing X" │
  │ "cart_abandonment · limited"     │              │               │            │
  ├──────────────────────────────────┼──────────────┼───────────────┼────────────┤
  │ 'unavailable'                    │              │               │            │
  │ a required signal missing        │ gray         │ NO            │ "no data   │
  │ "fraud · no data source"         │              │               │  source —  │
  │                                  │              │               │  needs X"  │
  └──────────────────────────────────┴──────────────┴───────────────┴────────────┘
```

The three buckets are the entire surface of the gate. Three categories of UX, three categories of agent behavior, all encoded in one enum.

#### the gate's invariants — what guarantees what

Two invariants make this work:

1. **Determinism.** `schemaCapabilities` is a pure function of the schema; `coverageReport` and `runnableCategories` are pure functions of the capability set. The same schema produces the same coverage every time. This is why the demo path can simply *write the coverage into the snapshot* and replay it identically — there's no live "what's available right now" element.
2. **Consistency between the two outputs.** A category surfaces as `'unavailable'` in the UI grid *exactly when* it's absent from the agent's input. The user can never see "revenue is unavailable" in the grid while the agent's log shows the agent running a revenue query. The gate is the single source of truth for both.

### Move 3 — the principle

When work is parameterised by capabilities of an external system, check capabilities *first* and only then dispatch work. The check produces two artifacts: a *narration* for the user (what we can and can't do, why, with what's missing named honestly), and a *filter* for the system (the trimmed input the worker actually runs against). Both come from one decision; both are consistent because they share the decision.

The transferable lesson: capability gating beats request-and-recover for any expensive or rate-limited workload. The naive shape is "ask the agent to scan all 10 categories; the agent's tool calls fail when the schema doesn't support them; the agent moves on." That shape burns rate-limit budget on calls that can't succeed and produces a "we tried everything" UX that's worse than "we knew not to try X." The gated shape is "check what's possible, run only that, tell the user about the gaps." The user gets an honest answer faster.

## Primary diagram

```
  schema-gated-coverage — full picture

  ┌─ Inputs ──────────────────────────────────────────────────────────────┐
  │                                                                        │
  │  WorkspaceSchema (from bootstrap)                                      │
  │    { projectId, events[], customerProperties[], … }                    │
  │                                                                        │
  │  CATEGORIES (the fixed 10-category checklist)                          │
  │    from @aptkit/core ECOMMERCE_ANOMALY_CATEGORIES                      │
  │    each: { id, label, requires[], enriches[], whyItMatters, eql,      │
  │            thresholds }                                                │
  └────────────────────────────┬──────────────────────────────────────────┘
                               │
  ┌─ Gate (lib/agents/categories.ts) ─▼──────────────────────────────────┐
  │                                                                        │
  │  schemaCapabilities(schema) → Set<signal>                              │
  │     e.g. { 'purchase', 'view_item', 'customer.country',                │
  │            'cart_update.cart_value', 'session_start' }                 │
  │                                                                        │
  │  coverageReport(capabilities) → CoverageReport                         │
  │     [                                                                  │
  │       { category: 'revenue_drop',     coverage: 'full' },              │
  │       { category: 'cart_abandonment', coverage: 'limited',             │
  │         missing: ['cart_value'] },                                     │
  │       { category: 'fraud',            coverage: 'unavailable',         │
  │         missing: ['payment_event', 'chargeback_event'] },              │
  │       …                                                                │
  │     ]                                                                  │
  │                                                                        │
  │  runnableCategories(capabilities) → AnomalyCategory[]                  │
  │     only 'full' + 'limited' — 'unavailable' dropped                    │
  └────────────────────────────┬──────────────────────────────────────────┘
                               │
  ┌─ Outputs ─────────────────▼──────────────────────────────────────────┐
  │                                                                        │
  │  to UI (via NDJSON):                                                   │
  │    coverage_item events → fill the grid tile-by-tile                   │
  │    reasoning_step events → narrate the checklist line-by-line          │
  │                                                                        │
  │  to agent (in-process):                                                │
  │    runnable list → MonitoringAgent.scan(runnable)                      │
  │    agent prompt + tool loop see ONLY the runnable categories           │
  │    EQL budget spent only on categories the schema supports             │
  └────────────────────────────────────────────────────────────────────────┘
```

## Elaborate

**The `requires` vs `enriches` split.** Many categories have a *core* signal that determines whether the category can be checked at all (`purchase` for revenue, `cart_update` for cart abandonment) and *enriching* signals that refine the answer (`payment_type` for fraud-flavored breakdowns of revenue drops, `cart_value` for cart-abandonment dollar exposure). The split lets the gate be three-bucket: enriching-missing is *limited* (run with a caveat), required-missing is *unavailable* (don't run). A two-bucket gate would either over-trim (drop categories that could still produce useful answers without the enrichment) or over-trust (run categories that produce wrong answers from missing inputs).

**Why fixed-in-code categories.** The category list is not data — it's code, defined in `@aptkit/core` and re-exported here. The reason: the category determines the EQL recipe, the thresholds, the business-language explanation, and the agent prompt context. A category isn't just a string; it's a bundle of behavior. Making it data would push that behavior into a config file with no type checks; making it code lets TypeScript catch typos and forces the prompt-writers to update behavior when adding a category. The trade is that a new category requires a code change — which is the correct cost because adding a category is rarely a config-shaped task.

**The narration is the audit.** A user looking at the coverage grid sees, for each of 10 tiles, exactly what the system can and cannot do for them. `fraud · no data source — needs payment_event, chargeback_event` tells the user *what data they would have to add* to unlock the category. This is the "shows its work" pitch applied to capability gating — the gate isn't a hidden filter; it's a visible commitment.

**Demo replay of the gate.** The demo snapshot captures the coverage grid (`snapshot.coverage`) at capture time. On replay, the route emits the captured coverage tile-by-tile (`app/api/briefing/route.ts:111-121`). There's no live gate decision; the demo replays the gate that ran when the snapshot was captured. This is why the demo path can show a realistic coverage grid without any schema bootstrap.

## Interview defense

**Q: Why gate the agent's work against the schema before the scan? Why not let the agent figure out which categories are answerable?**

> Three reasons. First, cost — the Bloomreach upstream rate-limits at ~1 req/s; an agent that runs all 10 categories and lets the tool calls fail on missing data burns budget on calls that can't succeed. Second, honesty — the user looking at the coverage grid sees "revenue · monitored" or "fraud · no data source — needs payment_event" up front, not "we tried fraud, here are some inferences." Third, prompt clarity — the agent's system prompt mentions only the runnable categories, so the model isn't tempted to fabricate an answer for one that's gated out. The gate is one function, three pure operations: `schemaCapabilities(schema)` returns the available signals, `coverageReport` produces the UI grid, `runnableCategories` produces the agent's input. Both outputs come from the same underlying check, so the user-facing story always matches what the agent did.

```
  cost-honesty-clarity triad

  cost      → rate-limit budget not spent on impossible work
  honesty   → user sees what's missing, not "best guess"
  clarity   → agent prompt sees only categories it can answer
```

**Anchor:** `lib/agents/categories.ts:35-46`, `app/api/briefing/route.ts:234-246`.

**Q: What's the load-bearing distinction between `requires` and `enriches`? What changes if you collapse them?**

> The three-bucket coverage. `requires` is the *can we attempt this at all* signal — the EQL recipe will produce nothing useful without the required event types and properties. `enriches` is the *would this make the answer richer* signal — the recipe runs, the answer is correct, but a refinement is missing. If you collapse them into one list, the gate becomes two-bucket: either you treat every missing signal as fatal (over-trim, lose categories that would still produce useful answers) or you treat every missing signal as a caveat (over-trust, run categories whose core inputs are absent and watch the agent fabricate). The split gives you three buckets and three honest UX strings: `'full'` (run, no caveat), `'limited'` (run with named caveat), `'unavailable'` (don't run, name the missing inputs the user would have to add). It's a small distinction that's load-bearing for the UX.

```
  the three-bucket gate

  required ∪ enriching all present     → 'full'         → run
  required present, enriching missing  → 'limited'      → run, narrate caveat
  required missing                     → 'unavailable'  → don't run, narrate gap
```

**Anchor:** `lib/agents/categories.ts:14-22` (the `requires` / `enriches` split on `AnomalyCategory`).

**Q: How does the demo snapshot interact with the gate?**

> The demo path *replays* the gate's output from the captured snapshot — it doesn't re-decide. When the live capture runs, the route runs the real gate (schema → coverage → runnable), emits each `coverage_item` event, and writes the resulting `CoverageReport` into the snapshot file. When the demo branch replays, it reads `snapshot.coverage` and emits the same tile events with the same spacing. So the demo's coverage grid is whatever the gate said at capture time, not a live decision against a synthetic schema. That's correct semantically — the demo is a recording of a real run; the gate's decision was part of that run, so it gets replayed verbatim. If the underlying gate logic changes (a new category added, a `requires` set tightened), the demo doesn't reflect the change until someone re-captures.

```
  gate in the live vs demo path

  LIVE:  schema → gate → coverage_item events + agent scan
  DEMO:  snapshot.coverage → emit same events (no live gate)
                ↑
                captured when the demo was recorded
```

**Anchor:** `app/api/briefing/route.ts:96, 111-121` (the demo branch reading `snapshot.coverage`).

## See also

- `01-request-flow.md` — where the gate runs in the briefing pipeline (phase 2)
- `04-aptkit-primitive-boundary.md` — `MonitoringAgent` receives the runnable list
- `06-streaming-ndjson.md` — the `coverage_item` events the gate emits on the wire
- `08-demo-replay-as-reliability.md` — how the gate's output rides into the demo snapshot
