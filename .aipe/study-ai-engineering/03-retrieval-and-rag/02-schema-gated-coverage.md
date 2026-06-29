# Schema-gated coverage

*Project-specific — capability gating before agent run*

## Zoom out — where this concept lives

The monitoring agent runs against a 10-category anomaly checklist. But not every workspace can support every category — a workspace without a `purchase` event can't have `revenue_drop`; one without `session_start` can't have `conversion_drop`. The gating layer filters the checklist *before* the agent runs, so the agent never spends an EQL budget on a category it can't possibly evaluate.

```
  Zoom out — where the gate sits

  ┌─ Bootstrap (schema retrieved + cached) ──────────────────┐
  │  WorkspaceSchema { events, customerProperties, catalogs }│
  └──────────────────────┬───────────────────────────────────┘
                         │  schemaCapabilities(schema)
                         ▼
  ┌─ ★ The gate ★ (lib/agents/categories.ts:24-46) ──────────┐ ← we are here
  │  for each of the 10 categories:                          │
  │    does the workspace expose this category's required    │
  │    events / properties?                                  │
  │  result: CoverageReport (full / limited / unavailable)   │
  │          + runnableCategories[]                          │
  └──────────────────────┬───────────────────────────────────┘
                         │  runnable subset only
                         ▼
  ┌─ MonitoringAgent.scan(hooks, runnableCategories) ────────┐
  │  agent sees only categories that can actually be checked │
  └──────────────────────────────────────────────────────────┘
```

**Zoom in.** This is *capability gating* — set-intersection between "what the agent could check" and "what the workspace supports." It's structurally retrieval-shaped (decide what's available before asking the LLM), but the decision is rules-based, not similarity-based.

## Structure pass — layers · axes · seams

**Layers:** schema → capabilities set → coverage decision → runnable subset → agent.

**Axis: who decides which categories run?** RULES decide (set intersection). The LLM never sees a category it can't check.

**Seam:** the `runnableCategories(available: Set<string>): AnomalyCategory[]` function at `lib/agents/categories.ts:46`. That's where the filter happens.

## How it works

### Move 1 — the mental model

You know how a feature flag enables/disables UI based on whether the user's plan supports it? Same idea, but the "feature" is an anomaly category and the "plan check" is "does this workspace's schema expose the events this category needs?"

```
  Schema-gated coverage — set intersection before agent run

  ┌─ The full 10-category checklist ─────────────────────────┐
  │  conversion_drop   needs: session_start, purchase         │
  │  cart_abandonment  needs: cart_update, checkout, purchase │
  │  revenue_drop      needs: purchase                         │
  │  product_demand    needs: view_item                        │
  │  customer_churn    needs: customer.last_purchase_at        │
  │  inventory         needs: inventory_level catalog          │
  │  campaign_perf     needs: email_open, campaign_id          │
  │  search_failure    needs: search, search.result_count     │
  │  return_spike      needs: return                           │
  │  fraud             needs: payment_failure                  │
  └──────────────────────────────────────────────────────────┘

  ┌─ This workspace's schema (example) ──────────────────────┐
  │  events:  purchase, view_item, session_start, cart_update,│
  │           checkout, search, email_open, return,           │
  │           payment_failure, voucher_redeemed                │
  │  cprops:  ..., last_purchase_at, ...                      │
  │  catalogs: products, inventory_level                       │
  └──────────────────────────────────────────────────────────┘

  ┌─ The gate (set intersection) ────────────────────────────┐
  │  Required signals present? → full coverage                │
  │  Required present but enriching missing? → limited        │
  │  Required missing? → unavailable                          │
  └──────────────────────────────────────────────────────────┘
                         │
                         ▼
  Runnable categories: only the ones marked full or limited
```

### Move 2 — the step-by-step walkthrough

**Part 1 — the schema becomes a capabilities set.**

`schemaCapabilities(schema)` (imported from `@aptkit/core`, re-exported at `lib/agents/categories.ts:8`) walks the schema and emits a `Set<string>` of "this workspace exposes signal X" tokens. Signals are things like:

  → `event:purchase`
  → `event:purchase.total_price`
  → `cprop:customer.last_purchase_at`
  → `catalog:inventory_level`

The library function knows how to read these from the `WorkspaceSchema` shape. The set is the structured representation of "what's available in this workspace."

**Part 2 — each category declares what it requires.**

The `AnomalyCategory` interface at `lib/agents/categories.ts:16-23`:

```typescript
export interface AnomalyCategory {
  id: CategoryId;
  label: string;
  requires: string[];          // hard requirements — without these, can't run
  enriches?: string[];         // soft signals — enhance but not required
  whyItMatters: string;
  eql: (projectId: string) => string;
  thresholds: { critical: number; warning: number };
}
```

`requires` is the hard bar — every name in this list must be in the capabilities set for the category to be runnable. `enriches` is the soft bar — these enhance the category's analysis if present, but absence doesn't disqualify.

**Part 3 — coverage is computed per category.**

`coverageFor()` at `lib/agents/categories.ts:24` is a 3-way result:

```typescript
export function coverageFor(category: AnomalyCategory, available: Set<string>): CategoryCoverage {
  const [coverage] = aptKitCoverageReport([toAptKitCategory(category)], available);
  return coverage?.coverage ?? 'unavailable';
}
```

The values (per `lib/mcp/types.ts:21-22`):

  → `'full'` — every `requires` AND every `enriches` is present
  → `'limited'` — every `requires` is present, but some `enriches` is missing
  → `'unavailable'` — at least one `requires` is missing

**Part 4 — runnable categories are full + limited.**

`runnableCategories()` at `lib/agents/categories.ts:46` filters to the runnable subset:

```typescript
export function runnableCategories(available: Set<string>): AnomalyCategory[] {
  return aptKitRunnableCategories(CATEGORIES.map(toAptKitCategory), available).map(toBloomingCategory);
}
```

Only categories marked `full` or `limited` are returned. `unavailable` categories are excluded — the agent never sees them in its prompt's checklist.

**Part 5 — the briefing route uses both the runnable list (for the agent) and the full coverage report (for the UI).**

From `app/api/briefing/route.ts:233-243`:

```typescript
const capabilities = schemaCapabilities(schema);
const coverage = coverageReport(capabilities);                  // full report → UI grid
const runnable = runnableCategories(capabilities);              // filtered subset → agent

step('matching the workspace schema to the 10-category anomaly checklist…');
const coverageLines = coverageChecklistSteps(coverage);
coverage.forEach((item, i) => {
  step(coverageLines[i]);
  send({ type: 'coverage_item', item });                        // narrate per-tile
});
// ...
const anomalies = await agent.scan({ ...hooks, signal: req.signal }, runnable);
//                                                                  ^^^^^^^^
//                                                  runnable subset passed to agent
```

Two consumers of the same gate, different shapes: the UI gets the full 10-tile coverage grid (so the user sees what was checked AND what was skipped, with honest reasons); the agent gets only the runnable subset.

### Move 3 — the principle

**Decide what's possible before you ask the LLM what to do.** Capability gating is the structural analog to retrieval — both narrow the agent's choice space before the agent burns tokens. Schema-gated coverage is a hard filter (rule-based, set intersection); vector retrieval is a soft filter (similarity-based, top-k). Both serve the same role: "the agent shouldn't have to figure this out from scratch on every call."

## Primary diagram — the full recap

```
  Schema-gated coverage end to end

  ┌─ Cached WorkspaceSchema ─────────────────────────────────────┐
  │  events, customerProperties, catalogs                        │
  └──────────────────────┬───────────────────────────────────────┘
                         │  schemaCapabilities(schema)
                         ▼
  ┌─ Capabilities Set<string> ───────────────────────────────────┐
  │  { 'event:purchase', 'event:purchase.total_price',           │
  │    'cprop:customer.last_purchase_at',                        │
  │    'catalog:inventory_level', ... }                          │
  └──────────────────────┬───────────────────────────────────────┘
                         │
                         ▼
  ┌─ Per-category check (set intersection) ──────────────────────┐
  │  for each of 10 CATEGORIES at lib/agents/categories.ts:26:   │
  │    coverage = 'full' if every (requires ∪ enriches) ⊂ caps   │
  │             = 'limited' if requires ⊂ caps but enriches not  │
  │             = 'unavailable' if requires ⊄ caps               │
  └─────────────────┬────────────────────────────────────┬───────┘
                    │                                    │
                    ▼ runnable (full + limited)          ▼ all 10 (for UI grid)
  ┌─ MonitoringAgent.scan(hooks, runnable) ──────┐  ┌─ coverage_item events ───┐
  │  agent sees only categories it can check     │  │  UI renders 10-tile grid │
  │  no EQL budget spent on unavailable ones     │  │  with honest "skipped"   │
  └──────────────────────────────────────────────┘  └──────────────────────────┘
```

## Elaborate

**Why a hard filter, not a soft hint.** Two reasons:

  1. **The 6-call budget is precious.** Each unrunnable category the agent considered would burn a tool call exploring "do we have this event type?" before concluding "no." With a hard filter, the agent only ever sees the categories it can actually evaluate.
  2. **Honesty in the UI.** The full coverage report (`coverageReport()`) is what powers the 10-tile coverage grid on the feed. Users see which categories were *skipped* and why ("no data source — needs purchase event"), which is more useful than silently dropping them.

**The two consumers, by design.** The agent gets the filtered subset (runnable); the UI gets the full report (all 10 categories with their coverage). Same gate, two outputs, one for the LLM and one for the human. The UI is honest about what the agent didn't even try, which is unusual product polish for an LLM app.

**Where this stops being enough.** If a future version added 50 anomaly categories (not 10), the gating logic stays linear — set intersection scales fine. But the *coverage grid* visually breaks at 50 tiles. At that point, the UI surface needs grouping (by domain area, by data source) and the gating story stays the same.

## Project exercises

### Exercise — Per-category "explain my unavailability" diagnostic

  → **Exercise ID:** B3.2
  → **What to build:** Add a "show me why this is unavailable" affordance to each `unavailable` tile in the coverage grid. On hover/click, fetch a per-category breakdown showing which `requires` are missing and which `enriches` are missing. Today, the coverage report carries a `missing[]` array — surface it in the UI inline rather than only in the trace.
  → **Why it earns its place:** turns the honest "skipped" tile from a dead-end into actionable feedback. Users (especially Bloomreach implementation engineers) learn what to instrument in the workspace to unlock the missing categories.
  → **Files to touch:** `components/feed/CoverageGrid.tsx` (if it exists; otherwise the tile rendering in the feed), `lib/agents/categories.ts` (the `missing` field is already there at line 39 — ensure it's serialized through to `CoverageItem`), `test/agents/categories.test.ts` (cover the missing-signal narration shape).
  → **Done when:** clicking an `unavailable` tile reveals "missing: event:purchase, event:purchase.total_price" inline, the data path doesn't add any extra MCP calls, and the existing coverage tests still pass.
  → **Estimated effort:** 1–4hr.

## Interview defense

**Q: "How do you decide which monitoring categories run?"**

Capability gating against the workspace schema, before the agent runs. Each of the 10 anomaly categories declares `requires` (hard) and `enriches` (soft) signal names. The workspace schema gets compressed into a capabilities `Set<string>`. Set intersection produces three states per category: `full`, `limited`, `unavailable`. The agent only sees `full` + `limited` — never burns a tool call exploring whether `payment_failure` exists.

The UI gets the full 10-category report including `unavailable` ones, so users see *what was skipped* and *why* (e.g. "needs purchase event"). One gate, two consumers.

*Anchor: "Set intersection: capabilities ∩ category requirements. Runnable subset to the agent; full report to the UI."*

**Q: "Why hard-filter instead of letting the agent decide?"**

The 6-call budget is tight — every unrunnable category the agent considered would burn at least one tool call exploring whether the workspace exposes that signal. With the hard filter, the agent's tool calls are all spent on real anomaly evaluation, not on capability discovery. The capability discovery is structural (one set intersection) and runs before the LLM is even invoked.

*Anchor: "Budget discipline. The LLM is for decisions the schema can't make; capability gating is one the schema CAN make."*

## See also

  → `01-schema-as-retrieval.md` — the retrieval pattern this sits on top of
  → `04-agents-and-tool-use/04-tool-routing.md` — adjacent: filtering tools by intent
  → `study-system-design/09-schema-gated-coverage.md` — the same pattern from the system-design lens
