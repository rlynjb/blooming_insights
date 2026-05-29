# spec — anomaly coverage grid

> add a category layer to monitoring. today the monitoring agent scans for "any significant recent
> change," which surfaces data-integrity artifacts (e.g. `revenue_sum_integrity +963.8%`) rather than
> the anomalies a store owner actually watches for. this feature gives monitoring a fixed checklist of
> **10 ecommerce anomaly categories**, runs only the ones this workspace's event schema can support,
> and renders the full set as a coverage grid on the feed — supported categories live, unsupported
> ones as blank "planned" tiles so the intent is visible without faking data.

scoped change. system-design first; UI last. **additive only** — the `ProcessStepper`, the NDJSON
`AgentEvent` contract, steps 2 & 3, `McpClient`, auth, and the demo snapshot keys do not change.

---

## layer 0 — intent

the product's loop is *what changed → why → what to do*. this feature upgrades the "what changed"
stage from open-ended scanning to a **systematic checklist**, and makes the checklist a first-class
surface. the pitch shifts from "found some anomalies" to "ran the analyst's full checklist — here's
where each of 10 categories stands, and which I couldn't check on this workspace and why."

categories aren't gated by *which MCP tool exists* — almost everything runs through
`execute_analytics_eql`. they're gated by **whether the workspace emits the events the category
needs**. the gate is `category.requires ∩ WorkspaceSchema.events`. this reuses the schema read the
monitoring agent already does ("reading the workspace schema…").

---

## layer 1 — constraints

- additive to step 1 only. steps 2 & 3 unchanged.
- new type fields are **optional** (older demo snapshots must still validate — see "what must not change").
- gate categories **before** the agent loop so monitoring never spends EQL budget on unsupported
  categories. respect the ~6-query budget + ~1 req/s limit; one efficient EQL per category (current +
  prior in a single query where possible).
- skipped categories are a **deliberate output**, not a failure — surface them.
- dark mode only; `max-w-5xl`; Tailwind v4 + existing CSS tokens; reuse `bi-fade-up` keyframe.
- copy lowercase.
- **QueryBox: hidden, not removed.** render it behind a flag (off for now). leave `components/chat/`,
  `lib/agents/query.ts`, `intent.ts`, and the query branch of `app/api/agent/route.ts` in place.

---

## layer 2 — data model

### category registry — `lib/agents/categories.ts` (new)

```ts
import type { Severity } from "@/lib/mcp/types";

type CategoryId =
  | "conversion_drop" | "cart_abandonment" | "product_demand" | "revenue_drop"
  | "customer_churn" | "inventory" | "campaign_perf"
  | "search_failure" | "return_spike" | "fraud";

type AnomalyCategory = {
  id: CategoryId;
  label: string;                 // lowercase display, e.g. "conversion rate drop"
  requires: string[];            // hard deps — missing any → unavailable (ghost)
  enriches?: string[];           // soft deps — present-core-but-missing-these → "limited"
  whyItMatters: string;          // framing the agent expands with real numbers
  eql: (projectId: string) => string; // period-over-period recipe, 90d vs prior 90d
  thresholds: { critical: number; warning: number }; // |%change| gates
};

type CategoryCoverage = "full" | "limited" | "unavailable";

export const CATEGORIES: AnomalyCategory[] = [ /* the 10, below */ ];
```

### the gate — pure, testable

```ts
// missing a hard dep → unavailable; missing only soft deps → limited; else full
export function coverageFor(cat: AnomalyCategory, schemaEvents: string[]): CategoryCoverage {
  const has = (e: string) => schemaEvents.includes(e.split(".")[0]); // property deps gate on the event
  if (!cat.requires.every(has)) return "unavailable";
  if (cat.enriches && !cat.enriches.every(has)) return "limited";
  return "full";
}
```

### type deltas — `lib/mcp/types.ts` (additive, optional)

```ts
// add to Anomaly and Insight — OPTIONAL so old snapshots validate
category?: CategoryId;

// briefing response gains a coverage summary
type CoverageReport = {
  category: CategoryId;
  label: string;
  coverage: CategoryCoverage;
  missing?: string[];   // which required/enriching events were absent
}[];
```

`change.direction` + `severity` already exist; a "positive" severity (your union has it) drives the
"spike" styling for `product_demand`.

### the 10 categories (events use your schema names: `view_item`, `cart_update`, `checkout`, `session_start`, `purchase`)

| id | label | requires | enriches | resolves to (on wobbly-ukulele) |
|---|---|---|---|---|
| conversion_drop | conversion rate drop | view_item, checkout, purchase | — | full |
| cart_abandonment | cart abandonment | cart_update, checkout, purchase | — | full |
| product_demand | product demand spike | purchase | catalog:product | full |
| revenue_drop | revenue drop | purchase | — | full |
| customer_churn | customer churn | purchase, session_start | — | full |
| inventory | inventory problems | purchase | catalog:inventory_level | **limited** (velocity ok, no stock level) |
| campaign_perf | campaign performance | session_start | session_start.utm_source | **limited** (traffic ok, no source) |
| search_failure | search failure | search | — | **unavailable** |
| return_spike | product return spike | return | — | **unavailable** |
| fraud | fraud detection | — (needs device/payment_failure/ip, not Engagement signals) | — | **unavailable** |

> these resolutions are **inferred** from context.md. the gate computes them at runtime from the live
> `WorkspaceSchema.events`; confirm the real event names (esp. whether `session_start` carries a
> `utm_source` property and whether the catalog exposes an inventory level) and the table self-corrects.

---

## layer 3 — monitoring agent change

`lib/agents/monitoring.ts` + `lib/agents/prompts/monitoring.md`.

- **before the loop:** read `WorkspaceSchema`, run `coverageFor` over `CATEGORIES`, split into
  `runnable = full|limited` and `skipped = unavailable`. pass only `runnable` recipes into the agent.
- **prompt rewrite:** replace "scan for significant recent changes" with: "you are checking a fixed
  list of ecommerce anomaly categories. for each provided category, run its recipe (90d vs prior 90d),
  decide if the change clears its threshold, and if so emit an `Anomaly` stamped with its `category`,
  with a `why it matters` written from the real numbers. do not invent categories; do not query data
  for categories not in the list." keep the existing `Anomaly` output shape; only `category` is new.
- **emit coverage:** the briefing response includes `CoverageReport` (runnable + skipped, with
  `missing` events) alongside `insights`. this is what the grid's ghost tiles and coverage note read.
- **streaming:** unchanged `AgentEvent` types. the per-category reasoning naturally flows as existing
  `reasoning_step` events ("checking conversion rate drop…"), which the StatusLog already renders.

no new MCP tool. no change to `runAgentLoop`, the tool-use loop, or the EQL tool.

---

## layer 4 — feature: coverage grid

- **data model:** consumes the briefing's `CoverageReport` + the `Insight[]` (to attach live findings
  to `full`/`limited` categories by matching `insight.category`).
- **what changes:** new `CoverageGrid` renders at the **top of Col 1 on `app/page.tsx`**, above the
  `InsightCard` list. step 1 only.
- **behaviour:**
  - one tile per category, all 10 always present, registry order.
  - tile state derived from coverage + any matching insight:
    - **anomaly** (coral) / **spike** (mint, positive severity) — a matching insight fired. **clickable** → routes into investigation exactly like an `InsightCard` (reuse the existing card-click handler that stashes the insight and opens `investigate/[id]`).
    - **clear** (mint) — `full`/`limited` coverage, no matching insight. not clickable.
    - **limited** (amber) — `limited` coverage. shows what's missing. not clickable.
    - **planned** (ghost) — `unavailable`. dashed, dimmed, names the missing event. not clickable.
  - hovering a firing tile may highlight its `InsightCard` below (optional polish).
  - in **demo mode** the grid defaults open; consider a collapsed summary line in live if height crowds the cards.
- **ui (match the existing aesthetic):**
  - responsive grid, `repeat(auto-fill, minmax(190px, 1fr))`, ~12px gap.
  - tile: icon (lucide) in a tinted square, status dot + label (critical dot pulses), category name (mono), one-line finding (sans).
  - ghost tile: dashed border, ~0.6 opacity, "no data source", and `planned · needs <event>` underneath.
  - header row: "anomaly coverage" + `10 categories · N monitored · M firing · K no data source`, plus a small legend (anomaly / clear / limited / planned).
  - coverage note under the grid (mono, dim): "checked N of 10 categories against this workspace's event schema. skipped <labels> — the required events aren't emitted here." (mirrors the StatusLog "shows its work" voice.)
  - colors/tokens: bg `#0a0f16`, tile `#121821`, border `#1e2730`, mint `#34d399`, coral `#fb7185`, amber `#fbbf24`, ghost text `#3a4651`. fonts: JetBrains Mono (structure/labels), Inter (prose). use existing design tokens rather than re-declaring.
- **constraints:** renders from the briefing response only (no extra agent calls). ghost tiles are inert. firing tiles must reuse the existing insight-click handler — do **not** fork a second routing path.

### `InsightCard` change — `components/feed/InsightCard.tsx`
add a small **category chip** beside the severity dot (sits next to the existing `scope global` pill),
reading `insight.category`'s label. this reconciles the two zoom levels: a firing tile and its card
show the same category. chip hidden if `category` is absent (old snapshots).

### `app/page.tsx` change
- render `<CoverageGrid coverage={…} insights={…} />` at the top of Col 1.
- gate `<QueryBox>` behind a flag (`const SHOW_QUERY_BOX = false`) — keep the import and component, just don't render. Col 2 / StatusLog unchanged.

---

## what must not change (from project context)

- `AgentEvent` NDJSON contract (producers + UI consumers depend on it). new per-category reasoning rides existing event types.
- `McpClient` return shape + no-cache-on-error / rate-limit-retry.
- `Insight`/`Anomaly`/`Diagnosis`/`Recommendation` field names; **new fields optional** so older demo snapshots validate.
- demo snapshot keys (`insights`, `workspace`, `trace`) + per-step replay filter. (add `coverage` as a *new optional* snapshot key; absence = grid shows all `full`/firing, no ghost tiles, no coverage note.)
- the MCP result envelope handling; tool calls always carry `project_id`; ~1 req/s.

---

## build order

1. `categories.ts` registry (10 entries) + `coverageFor` gate. unit-test the gate against fake schemas (TDD, no network) — this is the load-bearing logic.
2. type deltas: optional `category` on `Anomaly`/`Insight`, `CoverageReport`, optional `coverage` snapshot key + validator (new field optional).
3. monitoring agent: pre-loop gate + prompt rewrite + emit `CoverageReport`. test the loop with injected fakes (your existing pattern).
4. re-capture a demo snapshot so `coverage` + per-insight `category` exist in the committed JSON.
5. `CoverageGrid` component; wire into Col 1; reuse the insight-click handler for firing tiles.
6. `InsightCard` category chip.
7. hide `QueryBox` behind the flag.
8. polish: tile↔card hover sync, collapsed-in-live behavior, empty/skeleton states for the grid.

## acceptance criteria

- all 10 categories always render; `unavailable` ones are ghost tiles naming the missing event.
- `coverageFor` is pure and unit-tested; resolutions are computed from the live schema, not hardcoded in the UI.
- monitoring queries only `full`/`limited` categories; the briefing returns a `CoverageReport` listing skipped categories + why.
- a firing tile and its `InsightCard` show the same `category`; clicking a firing tile routes via the existing handler (no second routing path).
- old demo snapshots (no `category`, no `coverage`) still validate and render (chip hidden, no ghost tiles).
- `ProcessStepper`, steps 2 & 3, NDJSON contract, `McpClient`, auth: untouched.
- QueryBox is absent from the rendered feed but present in the codebase behind the flag.
