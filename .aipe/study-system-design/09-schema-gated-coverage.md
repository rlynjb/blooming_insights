# Schema-gated coverage — only run categories the workspace can answer

**Industry name:** capability-based feature gating · Project-specific (ecommerce monitoring shape)

## Zoom out, then zoom in

The monitoring agent has a fixed checklist of 10 ecommerce anomaly
categories (`conversion_drop`, `cart_abandonment`, `product_demand`,
`revenue_drop`, `customer_churn`, `inventory`, `campaign_perf`,
`search_failure`, `return_spike`, `fraud`). Each requires specific events
to be present in the workspace's schema. Before the agent runs, the route
computes which categories this workspace can answer — and only those
reach the agent.

You know how a feature flag prevents a feature from running if the
backend doesn't support it? Same shape here, but the gate is computed
from the workspace's actual event schema, not from a static flag. The
agent never even sees the categories that can't be answered, so it can't
waste a single MCP call trying.

```
  Zoom out — where the schema gate lives

  ┌─ Service layer ──────────────────────────────────────────────────────┐
  │                                                                       │
  │  /api/briefing                                                        │
  │   schema bootstrap → workspace                                        │
  │           │                                                            │
  │           ▼                                                            │
  │   schemaCapabilities(schema) → Set<string> of available event types   │
  │           │                                                            │
  │           ▼                                                            │
  │   coverageReport(...)        → CoverageItem[] (the UI grid)           │
  │   runnableCategories(...)    → AnomalyCategory[] (what monitoring runs)│
  │           │                                                            │
  │           ▼                                                            │
  │   ★ ONLY runnable categories reach MonitoringAgent.scan(...) ★         │ ← we are here
  │                                                                       │
  └──────────────────────────────────────────────────────────────────────┘
```

This is the cheapest defence in the whole codebase — a few hundred
microseconds of set arithmetic that saves several seconds of EQL budget
per briefing.

## Structure pass — layers, axis, seams

**Layers:** Workspace schema → capability extraction → coverage report →
monitoring agent.

**Axis (held constant): "what does this workspace have, and what does
the category need?"** This is the right axis because the whole gate is
a set-intersection problem.

```
  Axis: what's in the workspace vs what each category needs?

  ┌─ workspace.events  (set A) ────────────────────────────────────┐
  │  { 'purchase', 'view_item', 'session_start', 'cart_update',     │
  │    'checkout', ... }                                            │
  └────────────────────────────────────────────────────────────────┘

  ┌─ category.requires  (set B per category) ──────────────────────┐
  │  conversion_drop: { 'view_item', 'cart_update', 'purchase' }   │
  │  cart_abandonment: { 'cart_update', 'checkout' }               │
  │  ... 8 more                                                     │
  └────────────────────────────────────────────────────────────────┘

  decision: B ⊆ A ?
    full       — all required + all enriching present
    limited    — required present, some enriching missing
    unavailable — at least one required absent
```

**Seams (boundaries where the gate flips behavior):**

- **Schema → capabilities** — workspace events become a `Set<string>`.
  Set membership is O(1); the dozens of intersections that follow are
  cheap.
- **Capabilities → coverage** — each category gets a `CategoryCoverage`
  label (`full` | `limited` | `unavailable`). UI shows all three; agent
  runs only the first two.
- **Coverage → agent input** — only `full` and `limited` categories
  reach the agent (`runnableCategories`). The `unavailable` ones never
  consume a Bloomreach call.

## How it works

### Move 1 — the mental model

The shape is a fixed checklist with per-row capability tests. Each row
is one anomaly category; each test is "do you have the events I need?"

```
  Pattern — capability-based feature gating

  for each category in CATEGORIES:               UI shows this regardless
     coverage = test(category, workspace.events)
     ───────────────────────────────────────
     full        → render tile + run agent
     limited     → render tile + run agent (with caveat)
     unavailable → render tile (greyed) + skip agent

  monitoringAgent.scan(runnableCategories)       ← agent never sees the rest
```

The gate is two-faced: the UI shows the FULL checklist (so the user
understands what the system would monitor with more data) AND the agent
gets the FILTERED list (so it doesn't burn budget on impossible
queries). Same source of truth, two consumers.

### Move 2 — the step-by-step walkthrough

#### Step 1 — the 10-category checklist

The categories live in AptKit (`@aptkit/core@0.3.0`) under
`ECOMMERCE_ANOMALY_CATEGORIES`. Blooming wraps them with a
compatibility shape that older callers expect (`eql(projectId)` as a
function instead of a static `queryRecipe` string):

```typescript
// lib/agents/categories.ts:14-24
export interface AnomalyCategory {
  id: CategoryId;
  label: string;
  requires: string[];               // ← event types that MUST be in the workspace
  enriches?: string[];              // ← event types that improve quality (optional)
  whyItMatters: string;
  eql: (projectId: string) => string;
  thresholds: { critical: number; warning: number };
}

export const CATEGORIES: AnomalyCategory[] = ECOMMERCE_ANOMALY_CATEGORIES.map(toBloomingCategory);
```

The 10 categories (from `lib/mcp/types.ts:8-18`):

```
  CategoryId (lib/mcp/types.ts:8-18)
  ───────────────────────────────
  conversion_drop       cart_abandonment    product_demand
  revenue_drop          customer_churn       inventory
  campaign_perf         search_failure       return_spike
  fraud
```

Each has a required-events set and an optional enriching-events set.
`conversion_drop` needs `view_item`, `cart_update`, `purchase`;
`fraud` needs `payment_failure`. If a workspace doesn't emit
`payment_failure`, fraud is `unavailable` and no agent call gets
made for it.

#### Step 2 — extracting capabilities from the schema

`schemaCapabilities` (re-exported from AptKit via
`lib/agents/categories.ts:10`) takes the `WorkspaceSchema` and returns a
`Set<string>` of available event type names:

```typescript
// (logical body — implementation in @aptkit/core)
function schemaCapabilities(schema: WorkspaceSchema): Set<string> {
  return new Set(schema.events.map((e) => e.name));
}
```

This is the lookup table for everything that follows. A `Set` (rather
than an array) because the next step does dozens of membership tests
(`.has(...)`), and `O(1)` matters when you're testing 10 categories ×
~10 required+enriching each.

#### Step 3 — building the coverage report

`coverageReport` walks every category, intersects its `requires` +
`enriches` against the available set, and labels each as `full` |
`limited` | `unavailable`:

```typescript
// lib/agents/categories.ts:35-42
export function coverageReport(available: Set<string>): CoverageReport {
  return aptKitCoverageReport(CATEGORIES.map(toAptKitCategory), available).map((item) => ({
    category: item.category as CategoryId,
    label: item.label,
    coverage: item.coverage,            // 'full' | 'limited' | 'unavailable'
    ...(item.missing && item.missing.length ? { missing: item.missing } : {}),
  }));
}
```

The result is the data structure the UI's coverage grid renders. Each
item carries `missing: string[]` listing the absent required/enriching
events — surfaced in the UI tile so the user knows *why* a category is
unavailable.

```
  Execution trace — one category's coverage check

  state                                              value
  ─────                                              ─────
  category = conversion_drop
  requires = ['view_item', 'cart_update', 'purchase']
  enriches = []  (none in this example)
  available = {'purchase', 'view_item', 'session_start', 'cart_update',
               'checkout', 'search', 'email_open', 'voucher_redeemed',
               'return', 'payment_failure'}

  test 1: every (requires) in available?
          'view_item' ∈ available  →  true
          'cart_update' ∈ available →  true
          'purchase' ∈ available    →  true
          → all present → not 'unavailable'

  test 2: every (enriches) in available?
          [] → vacuously true
          → coverage = 'full'

  missing = []
  return { category: 'conversion_drop', label: '...', coverage: 'full' }
```

#### Step 4 — filtering down to runnable categories

`runnableCategories` is the gate that actually feeds the agent:

```typescript
// lib/agents/categories.ts:44-46
export function runnableCategories(available: Set<string>): AnomalyCategory[] {
  return aptKitRunnableCategories(CATEGORIES.map(toAptKitCategory), available).map(toBloomingCategory);
}
```

In practice, this returns the categories whose coverage is `full` or
`limited` — anything where the REQUIRED events are present (enriching
events can be missing without disqualifying the category).

#### Step 5 — the route's three-step gate

The /api/briefing route uses all three functions in sequence:

```typescript
// app/api/briefing/route.ts:234-246 (abridged)
const t_coverage = performance.now();
const capabilities = schemaCapabilities(schema);
const coverage = coverageReport(capabilities);
const runnable = runnableCategories(capabilities);

step('matching the workspace schema to the 10-category anomaly checklist…');
const coverageLines = coverageChecklistSteps(coverage);
coverage.forEach((item, i) => {
  step(coverageLines[i]);
  send({ type: 'coverage_item', item });    // ← UI gets EVERY category, tile by tile
});
recordPhase('coverage_gate', t_coverage);
// ...
step(`checking ${runnable.length} of 10 anomaly categories against this workspace…`);
const anomalies = await agent.scan({ ... }, runnable);    // ← agent only sees RUNNABLE
```

The split here is the load-bearing part. The UI receives all 10
categories via `coverage_item` events (so the grid renders all 10
tiles, each with its coverage state); the agent receives only the
runnable subset (so it never sees a category it can't answer).

```
  Pattern — split fan-out: UI sees all, agent sees subset

  schemaCapabilities ─► coverage  ─►  ┌─ send 'coverage_item' for each (UI side)
                                       │
                                       └─ runnableCategories ─► agent.scan(runnable)
                                                                 (agent side)
```

#### Step 6 — what this saves

The Bloomreach side rate-limits at ~1 req/s globally per user. Each
category the agent investigates costs at least one EQL call (often
more, when the agent decides to drill into subsegments). On a
workspace where only 6 of 10 categories are runnable, the gate saves
~4-12 EQL calls per briefing — at ~1-2 seconds each (cached or not),
that's 4-24 seconds of route budget that's NOT spent on impossible
queries.

The 300s `maxDuration` ceiling makes this meaningful — without the
gate, a workspace with poor schema coverage could burn enough budget
on unrunnable categories that the categories which SHOULD work get
cut off mid-scan.

### Move 3 — the principle

**Gate at the cheapest layer.** This gate is set arithmetic — a few
hundred microseconds of work. The alternative (let the agent try
every category and discover at tool-call time that there's no data) is
seconds of work for the same negative answer. When you can compute a
"don't bother" answer from static metadata, do it as early as possible
in the request pipeline.

The general principle: **separate capability discovery from
execution.** Capability discovery is cheap, deterministic, and
testable; execution is expensive, non-deterministic, and racy. The
gate moves a yes/no decision from execution time (expensive) to
discovery time (cheap), and that's the whole win.

You'll see the same pattern in any system with a fixed-feature catalog
gated by per-instance capability: SQL DBMS query planners that prune
unindexed tables, Kubernetes admission controllers that reject pods
that can't be scheduled, browser feature-detection that swaps
implementations before calling a missing API. The shape is always:
"compute the answer cheaply, route around the expensive failure
before it happens."

## Primary diagram

```
  Schema-gated coverage — one full briefing's gate pass

  ┌─ schema bootstrap (4 Bloomreach calls) ────────────────────────────────┐
  │  WorkspaceSchema { events: [{name, properties, eventCount}, ...], ... }│
  └──────────────────────────────────┬─────────────────────────────────────┘
                                     │
  ┌─ schemaCapabilities(schema) ─────▼─────────────────────────────────────┐
  │  return new Set(schema.events.map(e => e.name))                         │
  │  → Set { 'purchase', 'view_item', 'session_start', ... }                │
  └──────────────────────────────────┬─────────────────────────────────────┘
                                     │
  ┌─ coverageReport(capabilities) ───▼─────────────────────────────────────┐
  │  for each category in CATEGORIES (10 total):                            │
  │     missing = [...requires, ...enriches].filter(d => !cap.has(d))       │
  │     if any required missing → 'unavailable'                              │
  │     else if any enriching missing → 'limited'                            │
  │     else → 'full'                                                        │
  │  → CoverageReport [10 items, each with coverage label + missing[]]      │
  └──────────────────────────────────┬─────────────────────────────────────┘
                                     │
              ┌──────────────────────┴─────────────────────┐
              │                                              │
              ▼                                              ▼
  ┌─ to UI (all 10 tiles) ─────────────┐    ┌─ runnableCategories ─────────────┐
  │  coverage.forEach(item =>            │    │  filter(c => c.coverage !==       │
  │    send({type:'coverage_item',item}))│    │    'unavailable')                 │
  │  → grid fills tile-by-tile           │    │  → AnomalyCategory[] (e.g. 6 of 10)│
  └──────────────────────────────────────┘    └──────────────────────┬─────────┘
                                                                     │
                                                                     ▼
                                              ┌─ MonitoringAgent.scan(runnable) ─┐
                                              │  agent never sees the other 4    │
                                              │  → saves ~4-12 EQL calls          │
                                              │  → saves ~4-24s of route budget   │
                                              └───────────────────────────────────┘
```

## Elaborate

**Where this pattern comes from.** Two parents:

  → **Feature flags** (Etsy, ~2010; LaunchDarkly, ~2014) — gave us
    the "compute a yes/no decision before running the feature" frame,
    typically driven by a static configuration store.
  → **Capability-based security / capability discovery** (E rights,
    Plan 9 file capabilities; HTTP `Allow:` header; SQL `INFORMATION_
    SCHEMA`) — gave us the "compute capability from observable state"
    frame, where the decision input is what the system actually has,
    not a flag.

The combination here — static category catalog + runtime capability
discovery — is the pragmatic shape for any system where the feature
set is bounded but the data shape is per-instance variable. SaaS apps
with optional integrations, multi-tenant analytics tools, ETL pipelines
with per-source schemas all fit this shape.

**The deeper principle.** Compute negation cheaply. Knowing what you
DON'T have (the missing event types) is structurally easier than
finding out what you DO have (running every query and seeing which
ones return data). The schema is the description; the queries are the
discovery. The schema is fast; the queries are slow. Compute the
"don't bother" answer from the description, not the discovery.

**Where it breaks.**

- **Schema cache staleness.** The workspace schema is module-cached
  (`lib/mcp/schema.ts:138`). If the customer's Bloomreach project
  adds a new event type mid-deploy, our gate sees it as
  `unavailable` until the next instance cold-start. Acceptable
  for an alpha product; would need a TTL or webhook invalidation
  for a real one.
- **Required vs enriching is binary.** A category that needs 3
  required events and 5 enriching events is `limited` whether 1
  enriching is missing or all 5. We don't surface the QUALITY
  gradient — only the binary "all required + all enriching" vs
  "all required + some enriching missing." This is fine for the
  current UI but limits future "this category will be lower
  quality" messaging.
- **The category requires aren't validated.** If a category's
  `requires: ['foo']` mentions a non-existent event type, the
  category is always `unavailable` and nothing in the system
  notices. Same shape as a typo in a feature flag name —
  silently disables the feature.
- **Coverage runs once per briefing, not per query.** A workspace
  whose schema changes WITHIN a briefing (e.g. an event type
  starts emitting halfway through a 60-second scan) won't have
  its categories upgraded mid-scan. The gate decision is locked
  at briefing start.

**What to explore next.**

- `07-multi-agent-orchestration.md` — the agent that consumes
  the runnable list
- `01-request-flow.md` — where the gate sits in the route pipeline
- `05-caching-and-rate-limiting.md` — what the gate's savings buy
- `study-data-modeling` — the `WorkspaceSchema` shape this gate reads

## Interview defense

#### Q: "Why gate before the agent runs instead of letting it skip unavailable categories itself?"

Two reasons. **One**: the model would burn tokens and tool calls
just discovering "there's no `payment_failure` event" — and at
~1 req/s, that discovery is several seconds of route budget for an
answer the schema already has statically. **Two**: the UI needs to
show all 10 categories regardless (greyed out for unavailable), and
the gate's output is the natural data structure for that — same
source of truth, two consumers.

```
  Gate at request edge                 Let the agent decide
  ───────────────────                  ────────────────────
  computed in microseconds             computed in seconds (model + tool call)
  deterministic                        non-deterministic (model may or may not skip)
  saves route budget                   burns route budget on negative discovery
  UI consumes same data                UI would need separate computation
```

**Surface:** "static answer beats discovered answer, every time."
**Probe:** if pressed, name the `runnable` array passed to
`MonitoringAgent.scan(runnable)` as the proof that the agent never
sees the unavailable categories — it can't even decide to try them.

#### Q: "What's the load-bearing part — what breaks if you remove this gate?"

The `runnableCategories(capabilities)` → `agent.scan(runnable)` wire.
It's the kernel: without filtering, the agent gets the full 10-category
catalog and tries each. At ~1 second per EQL call (cached) and 1-3
calls per category, that's an extra 4-12 seconds per briefing on a
poorly-covered workspace — and on a 300s budget with retry storms, it
could push the briefing past the ceiling.

Other load-bearing parts:

  → `schemaCapabilities` returning a `Set<string>` — O(1) membership
    is what makes the 10 × ~10 intersection cheap. An array would
    work but for the wrong reason; the contract is "set membership,
    cheap"
  → the `requires` vs `enriches` distinction per category — without
    it, a missing optional event would disqualify a category from
    running at all, when actually we want to run it with a caveat
  → splitting `coverage` (10 items, all → UI) from `runnable` (subset
    → agent) — without it, the UI loses the "this category is
    available but not in your workspace" messaging

Optional hardening:

  → the `missing: string[]` field on each CoverageItem — surfaces
    WHY a category is unavailable; the gate works without it but the
    UX gets less informative
  → the live narration (`coverageChecklistSteps`) — quality-of-life;
    streams one line per category as the gate runs

#### Q: "Could the categories themselves be data-driven instead of code?"

Yes, and that's the natural evolution. Today the categories live in
`@aptkit/core` (`ECOMMERCE_ANOMALY_CATEGORIES`) — code on a fixed
deploy cycle. A real product would put them in a config (JSON, YAML,
a CMS) so non-engineers could add new categories without a deploy.
The shape doesn't change; only the source.

The reason we haven't moved them is the validation question: a
data-driven catalog needs schema validation, version-pinning, and a
review workflow before it ships. Today's small catalog + code-as-config
is the right tradeoff; once we have 30+ categories or non-engineer
contributors, it'd flip.

A latent concern: the EQL query for each category (the actual
analytics expression the agent runs) is also in
`ECOMMERCE_ANOMALY_CATEGORIES`. Moving this to data means treating
EQL strings as user-supplied — which raises injection concerns even
though Bloomreach validates EQL server-side. Worth weighing.

## See also

- `00-overview.md` — where this sits in the system
- `07-multi-agent-orchestration.md` — the monitoring agent that
  consumes the runnable list
- `01-request-flow.md` — the route pipeline that runs the gate
- `05-caching-and-rate-limiting.md` — what the saved budget buys
- `study-data-modeling` — the `WorkspaceSchema` shape this reads
- `study-ai-engineering` — pre-flight gating vs in-loop discovery
