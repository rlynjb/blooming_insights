# Spec: Enrich the Three UI Surfaces with Business-Owner Value

## Context

`blooming insights` is a multi-agent AI analyst for a Bloomreach Engagement ecommerce workspace. The current UI surfaces three stages — **monitoring → diagnosis → recommendation** — but every surface is light on the details an ecommerce business owner actually needs to take an action with confidence. Today's cards show the *fact* of a change; they don't translate it into money, customer impact, effort, or confidence.

This spec adds those translations across all three surfaces. The principle is **don't add data the agents haven't already computed** — every enrichment below derives from values already present in the `Insight`, `Anomaly`, `Diagnosis`, or `Recommendation` types, or from values computable from the existing tool-call evidence. No new agent prompts, no new MCP tools.

The goal is to make a hackathon demo where a judge looks at one card and immediately understands: **what's broken, how much it costs, who's affected, what to do, how long it takes, and how to tell if it worked.** That story is what wins the "Problem Relevance & Clarity" and "Execution Quality & Feasibility" rubric items.

---

## Goal

Add three tiers of business-owner detail to `InsightCard`, the diagnosis page, and `RecommendationCard`. Tier 1 (required) gives the demo its credibility. Tier 2 (recommended) adds analytical depth. Tier 3 (stretch) is post-hackathon.

Three reference mockups are bundled at the bottom of this spec — implement the visual structure and density they show, adapted to the project's existing dark-mode design tokens (`lib/design/tokens.ts`).

---

## What changes per surface

### 1. `InsightCard` (`components/feed/InsightCard.tsx`)

The card currently shows: severity dot + headline + summary + why-it-matters + scope + prior→now comparison + via-tool footer. Add:

**Tier 1 — required**
- **Revenue impact in dollars.** Compute from the evidence: `current - prior` in absolute dollars for revenue metrics. Render as a 3-tile metric strip at the top of the card body (revenue lost · AOV · customers affected). For non-revenue metrics (sessions, conversions), substitute appropriate units but keep the 3-tile pattern.
- **AOV (average order value).** Derived: `sum(purchase.total_price) / count(purchase)` from the same evidence object. If both current and prior AOV are present, label the second line "stable vs prior" / "down N%" / "up N%".
- **Customers affected.** Use `Diagnosis.affectedCustomers.count` if a diagnosis already exists for this insight (it usually will, since the feed pre-runs them in the demo path). If not, fall back to "—".
- **Funnel-leak chip.** A 4-tile horizontal strip showing the % change of view / cart / checkout / purchase events for the same window. Highlight the leak point (largest negative or the metric that's the subject of this anomaly) with the danger color. Use the monitoring agent's existing multi-event query results.
- **Time-since-detection.** A small `<i class="ti ti-clock">started ~N days ago</i>` line next to the severity badge. Derive `N` from `Insight.timestamp` (or, when present, from the gap between the current and prior window where the divergence began — start with the simpler timestamp version).

**Tier 2 — recommended**
- **12-week sparkline** above the funnel chip. Use a small inline SVG (no chart lib) plotting the weekly metric value. Source: an additional `select count event <metric> by week` query on the monitoring agent's existing budget, or — if budget is tight — derive from the cached 90d/180d series the agent already pulls. Cache the sparkline data on `Insight.history?: number[]`.
- **Footer status pill.** "diagnosis ready · 3 actions proposed" if both downstream stages have been pre-computed for this insight (true in demo mode). Hides the user from clicking through to an empty page.

**Tier 3 — skip for hackathon**
- Year-over-year benchmark line.
- Category / device sub-localization beyond country.

**Data model changes**
- Add to `Insight` (`lib/mcp/types.ts`) as **optional** fields so older demo snapshots still validate:
  - `revenueImpact?: { lostUsd: number; expectedUsd: number; currency: 'USD' }`
  - `aov?: { current: number; prior: number }`
  - `funnel?: { view: number; cart: number; checkout: number; purchase: number }` (each is a % change vs prior, signed)
  - `affectedCustomers?: number` (denormalized copy from `Diagnosis.affectedCustomers.count` for feed rendering without joining)
  - `history?: number[]` (12 weekly values, oldest first)
  - `downstreamReady?: { diagnosis: boolean; recommendations: number }`
- Populate them in the monitoring agent's anomaly→insight mapping (`lib/state/insights.ts::anomalyToInsight`) by reading from the existing `Anomaly.evidence[]` payload. Where a value isn't computable, leave the field undefined and let the UI fall back to existing layout — no `--` strings in the model.

**Visual reference:** mockup 1 below.

---

### 2. Diagnosis page (`app/investigate/[id]/page.tsx` + `components/investigation/EvidencePanel.tsx`)

Currently: subject banner + `EvidencePanel` (conclusion, affected-customers callout, evidence list, collapsible hypotheses) + "see recommendations" button. Add:

**Tier 1 — required**
- **Confidence tile.** Two-tile strip at the top (confidence · customers affected). Confidence is `high` / `medium` / `low`, derived as: high = all hypotheses tested and one supported; medium = at least one supported but some untested due to budget/rate limits; low = no hypothesis supported or the agent fell back to insufficient-data. Compute this in `lib/agents/diagnostic.ts` or a pure helper next to it; store on `Diagnosis.confidence: 'high' | 'medium' | 'low'` (new optional field).
- **Hypothesis chips with supported/ruled-out badges.** Replace the collapsible list with an always-visible vertical list of pill rows: a colored "supported" / "ruled out" badge + the hypothesis text. Most users will not click to expand — show this state inline. The reasoning text can stay behind a per-row expand if helpful.
- **Data quality note.** A muted strip near the bottom that surfaces how many tool calls succeeded vs. failed/rate-limited. Source: count the agent's `ToolCall[]` for `error`-present items. Render only when `errors > 0` so it doesn't add noise to clean investigations. This makes the "agent shows its work" pitch land harder and pre-empts a judge asking about reliability.

**Tier 2 — recommended**
- **"Where the gap landed" chart.** A simple inline SVG bar chart (no chart lib) showing daily values of the anomalous metric over the last 14 days, with the diagnosed gap window annotated. The diagnostic agent's existing queries already segment the metric over windows; capture the per-day series when the agent runs `select count event <metric> by week/day` and store on `Diagnosis.timeSeries?: { day: string; value: number }[]`. If a particular investigation didn't compute a daily series, hide the chart — don't render an empty placeholder.

**Tier 3 — skip**
- A funnel diagram on this page (the InsightCard already shows it).

**Data model changes**
- Add to `Diagnosis` (`lib/mcp/types.ts`), all optional:
  - `confidence?: 'high' | 'medium' | 'low'`
  - `timeSeries?: { day: string; value: number }[]`
- `affectedCustomers` already exists — start surfacing it as a first-class tile, not buried in a callout.

**Visual reference:** mockup 2 below.

---

### 3. `RecommendationCard` (`components/investigation/RecommendationCard.tsx`)

Currently: feature chip + confidence dot + title + rationale + numbered steps + qualitative impact callout. Add:

**Tier 1 — required**
- **Estimated impact in dollars.** Replace the qualitative impact string with a prominent dollar range, plus the assumption that produced it on the second line (e.g. "assumes 15–25% reactivation of ~340 buyers at $1,124 AOV"). Compute this in the recommendation agent's synthesis step from the diagnosis's affected-customer count × AOV × the qualitative percentage range. Store on `Recommendation.estimatedImpact` as a richer shape (see model change below), and **keep the existing string form as a fallback** so older snapshots render.
- **Effort + time-to-set-up + time-to-result tiles.** A 3-tile strip below the impact callout. Source these from the agent — add explicit prompt instructions to emit `effort: 'low' | 'medium' | 'high'`, `timeToSetUpMinutes: number`, and `readResultInDays: number`.
- **Prerequisites strip.** Lists what must be true to run this action (e.g. "email channel active · voucher pool optional"). Source: the recommendation agent's check against `list_scenarios`, `list_segmentations`, `list_voucher_pools`, etc. — it already runs these. Convert each into a green check (present) or amber dot (needed) tag.
- **Success metric.** One sentence at the bottom answering: "what number tells us in N days whether this worked?" Add as `Recommendation.successMetric: string` to the agent's emit schema and prompt.

**Tier 2 — recommended**
- **"Highest impact" badge** on the first card in the array (the agent already sorts by impact). Subtle, not a starburst.
- **"Open in Bloomreach" link** as a secondary button on each card. Builds the deep link from the feature + project_id (e.g. scenario → `https://app.bloomreach.com/projects/<id>/scenarios`).

**Tier 3 — skip**
- 2x2 effort-vs-impact view across all three recommendations.
- Cohort lifetime-value impact.

**Data model changes**
- Update `Recommendation` (`lib/mcp/types.ts`):
  - Change `estimatedImpact: string` to `estimatedImpact: { range: string; rangeUsd?: { low: number; high: number }; assumption: string }` — keep `range` as the human-readable fallback for old snapshots. Update `isRecommendationArray` validator accordingly (loosen to accept either the old or new shape during migration).
  - Add `effort?: 'low' | 'medium' | 'high'`
  - Add `timeToSetUpMinutes?: number`
  - Add `readResultInDays?: number`
  - Add `prerequisites?: { label: string; satisfied: boolean }[]`
  - Add `successMetric?: string`
- Update `lib/agents/prompts/recommendation.md` to instruct the model to emit all new fields. The dollar-impact range should be computed by the model from the diagnosis's affected-customer count and the project's typical AOV (which is now in the insight payload it can see).
- Update the synthesis fallback in `recommendation.ts` to populate the same fields.

**Visual reference:** mockup 3 below.

---

## Demo snapshot considerations

The demo snapshots in `lib/state/demo-insights.json` and `lib/state/demo-investigations.json` are the demo's reliability path. All new fields must be **optional** so old snapshots still render. Then regenerate the snapshots once via the dev-only "capture this as the demo snapshot" button (`app/page.tsx`) after the agents emit the new fields. Commit the regenerated snapshots in the same PR as the UI changes — the demo must look like the mockups when it runs.

---

## Out of scope

- New MCP tools or new agents.
- Changes to the streaming `AgentEvent` NDJSON contract or `ProcessStepper`, `StatusLog`, `ReasoningTrace` (the agent-visibility surfaces stay as-is).
- Changes to auth, the MCP client cache/rate-limit logic, or the per-investigation latency budget.
- Light mode — the project is dark-mode only and these mockups must be adapted to the project's tokens (`colors.bg`, `colors.text`, `colors.accent` from `lib/design/tokens.ts`).

---

## Suggested order

1. `InsightCard` tier 1 — highest ROI, single component, no agent prompt changes (just an evidence reader).
2. Diagnosis page tier 1 — hypothesis chips + confidence + data-quality note. Pure UI rearrangement plus one derived field.
3. `RecommendationCard` tier 1 — needs the recommendation prompt updated and the validator loosened, so it lands last.
4. Tier 2 items in the same order, only if time permits before the demo.
5. Regenerate demo snapshots; verify the feed and both investigate pages render identically to the mockups in demo mode.

---

## Acceptance

- The feed, diagnosis page, and recommendation page each render the new fields when present, and fall back gracefully when they're not (no broken layouts on old snapshots).
- A demo replay (`?demo=cached`) for the `usa purchase_revenue −58.3%` insight visibly matches the three mockups below in structure and density.
- All `Insight` / `Diagnosis` / `Recommendation` type changes are additive and optional; `isAnomalyArray`, `isDiagnosis`, `isRecommendationArray` validators still accept both old and new shapes.
- No new `AgentEvent` types and no changes to streaming format.
- Dark mode renders correctly throughout.

---

## Reference mockups

> These were rendered on a light-mode design system. Adapt the visual structure, density, and information hierarchy to this project's dark-mode tokens. Color semantics (danger = revenue loss, success = positive impact, amber = warning / why-it-matters callout) should be preserved.

### Mockup 1 — Enriched `InsightCard`

Severity row with started-N-days-ago · headline + signed % change · one-line summary · **3-tile metric strip (revenue lost · AOV · customers affected)** · **funnel-leak chip (view / cart / checkout / purchase % deltas with leak point highlighted)** · scope chips · why-it-matters callout · footer with investigate button and "diagnosis ready · N actions proposed" status.

### Mockup 2 — Enriched diagnosis page

Investigating subject row with query count · headline conclusion · **2-tile strip (confidence · customers affected)** · conclusion callout · **"where the gap landed" 14-day bar chart with the gap window annotated** · **hypothesis chips (supported / ruled out badges, always visible)** · key evidence list · **data quality note (when errors > 0)** · footer with see-recommendations and export buttons.

### Mockup 3 — Enriched `RecommendationCard`

Feature chip + "action 1 of 3 · highest impact" + confidence dot · title · one-line rationale · **expected-impact callout in dollars with the assumption that produced it** · **3-tile strip (effort · time to set up · read result in)** · **prerequisites strip with satisfied/needed indicators** · setup steps (numbered) · **success metric line** · footer with prepare-brief and open-in-Bloomreach buttons.
