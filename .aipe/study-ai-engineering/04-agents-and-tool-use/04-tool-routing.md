# 04 — tool routing

**Subtitle:** Heuristic-vs-LLM tool picking · Industry standard (this codebase: heuristic)

## Zoom out, then zoom in

blooming insights uses **heuristic tool routing** — per-agent allowlists in
`lib/mcp/tools.ts` filter the set of tools each agent can see. The model
then picks from its filtered set; that picking is LLM routing inside the
allowlist. Both patterns layered: hard gate first, model choice second.

```
  Zoom out — routing at two layers

  ┌─ Heuristic layer (Blooming) ────────────────────────┐
  │  per-agent allowlist filter:                        │
  │    monitoringTools (13)                             │  ← we are here
  │    diagnosticTools (17)                             │   (the gate)
  │    recommendationTools (8)                          │
  │    queryTools (union)                               │
  └────────────────────┬────────────────────────────────┘
                       │ filtered tool list
                       ▼
  ┌─ LLM layer (model picks from filtered list) ────────┐
  │  model emits tool_use block selecting one tool      │  ← the choice
  └─────────────────────────────────────────────────────┘
```

## Structure pass

  → **One axis to trace — who picks which tools are even available.**
    Above the seam (allowlist), Blooming picks. Below the seam, the LLM
    picks (from what's available). The axis flips at the boundary
    between `lib/mcp/tools.ts` (Blooming's hand-curated lists) and
    AptKit's tool-passing (the model sees only filtered tools).

## How it works

### Move 1 — the mental model

Same shape as IAM role permissions: the role defines what a user *can*
do; the user picks within that. Here the role is the agent allowlist;
the user is the model.

```
  Two routing strategies, layered

  Heuristic routing (Blooming — deterministic):
    if agent === 'monitoring': tools = monitoringTools
    elif agent === 'diagnostic': tools = diagnosticTools
    elif agent === 'recommendation': tools = recommendationTools
    elif agent === 'query': tools = queryTools (union)

  LLM routing (model — within allowlist):
    model sees its agent's tool list
    model emits tool_use block with name + input
    AptKit dispatches; result goes back as observation

  Combined: heuristic filters; LLM picks within filter
```

### Move 2 — the step-by-step walkthrough

**The allowlists** live in `lib/mcp/tools.ts`:

```typescript
// Bloomreach (EQL-shaped) ↓
const monitoringToolsBloomreach = [
  'list_dashboards', 'get_dashboard',
  'list_trends', 'get_trend',
  'list_funnels', 'get_funnel',
  'list_running_aggregates', 'get_running_aggregate',
  'list_reports', 'get_report',
  'execute_analytics', 'execute_analytics_eql',
  'get_customer_prediction_score',
] as const;

const diagnosticToolsBloomreach = [
  'execute_analytics', 'execute_analytics_eql',
  'get_funnel', 'get_event_segmentation',
  'list_customers', 'list_customer_events',
  'list_customers_in_segment', 'list_segmentations',
  'list_email_campaigns', 'list_sms_campaigns',
  'list_in_app_messages', 'list_banners',
  'list_experiments', 'list_scenarios',
  'list_catalog_items', 'get_catalog_item',
  'get_customer_prediction_score',
] as const;

const recommendationToolsBloomreach = [
  'list_scenarios', 'get_scenario',
  'list_initiatives', 'get_initiative_items',
  'list_recommendations', 'get_recommendation',
  'list_segmentations', 'list_email_campaigns',
  'list_voucher_pools',
  'get_frequency_policies',
] as const;
```

The pattern:
  - **monitoring** = read-only analytics tools (dashboards, trends,
    funnels, ad-hoc EQL). Cannot list campaigns or scenarios.
  - **diagnostic** = analytics + customer/campaign lookups. Can list
    campaigns (to test the hypothesis "did campaign X cause this?")
    but cannot list scenarios (out of scope).
  - **recommendation** = feature-discovery tools (existing scenarios,
    segments, vouchers). Cannot run ad-hoc analytics — already has the
    diagnosis as input.
  - **query** = union of all three. Free-form Q&A can need anything.

**Why these specific subsets.** Each agent's job determines what data it
needs:

  → Monitoring detects anomalies → needs analytics queries.
  → Diagnostic tests hypotheses → needs analytics + the customer / campaign
    surface to localize causes.
  → Recommendation proposes actions → needs to see what features already
    exist (so it doesn't propose duplicate scenarios).

**The bootstrap tools** (`lib/mcp/tools.ts:55-59`) are a separate list:

```typescript
export const bootstrapTools = [
  'list_cloud_organizations', 'list_projects',
  'get_event_schema', 'get_customer_property_schema',
  'list_catalogs', 'get_project_overview',
] as const;
```

These are called BEFORE any agent runs (deterministic, no LLM
involvement). No agent's allowlist includes them — the LLM never picks
them.

**The synthetic data source uses the same lists.** Looking at
`lib/data-source/synthetic-data-source.ts`, the per-agent tool lists
are mirrored — the synthetic adapter (`SyntheticDataSource`) exposes
only the tools each agent should see, matching the Bloomreach allowlist
structure. The heuristic gating works identically across data sources.

**Coverage gating as a second heuristic.** Inside the monitoring agent
specifically, `runnableCategories(available)` from
`lib/agents/categories.ts` filters the *category checklist* (not the
tools) down to ones whose required signals are in the schema. See
`01-llm-foundations/07-heuristic-before-llm.md` for the full
walkthrough. This is heuristic routing one level deeper — the model
sees not just allowed tools but allowed *targets* for those tools.

**The LLM-routing layer.** Within the filtered set, the model picks
freely. It can emit `tool_use` for any tool in its allowlist; it can
chain tool calls; it can decide not to call any tools and just emit
its final answer. The prompts shape its preferences ("use
`execute_analytics_eql` first to check volume…") but don't enforce
choices.

### Move 3 — the principle

**Layer heuristic routing over LLM routing: hard gate what the model can
even see, then let the model pick within that.** The heuristic gate is
your defense in depth — if a prompt-injection attempt tells the model
to call an unexpected tool, the allowlist prevents it. The LLM layer
is your flexibility — the model can pick the right tool for the
specific query without you having to enumerate every case in code.

## Primary diagram

```
  Per-agent allowlists + LLM picking — the full routing pipeline

  request arrives at /api/agent
       │
       ▼  agent shape determined by step / classifyIntent
  ┌─ Heuristic gate: which agent? ───────────┐
  │   step === 'diagnose'  → DiagnosticAgent  │
  │   step === 'recommend' → RecommendationAgent│
  │   q && !insightId      → QueryAgent       │
  │   /api/briefing        → MonitoringAgent  │
  └────────────────────┬─────────────────────┘
                       │
                       ▼  agent passes its allowlist
  ┌─ Allowlist filter (lib/mcp/tools.ts) ────┐
  │   monitoringTools  /  diagnosticTools     │
  │   recommendationTools  /  queryTools      │
  └────────────────────┬─────────────────────┘
                       │  filtered tool list
                       ▼
  ┌─ Tool definitions passed to model ───────┐
  │   each: { name, description, inputSchema }│
  └────────────────────┬─────────────────────┘
                       │
                       ▼  model picks freely within allowlist
  ┌─ Model emits tool_use blocks ────────────┐
  │   selects from its visible tool list      │
  │   (cannot pick a tool it can't see)       │
  └───────────────────────────────────────────┘
```

## Elaborate

The "narrow per-agent allowlists" pattern is what makes a multi-agent
system tractable. Without per-agent narrowing, every agent sees every
tool (~30+ for this codebase), and the prompts have to explicitly say
"don't use list_email_campaigns even though you can." Inevitably the
model occasionally ignores the negative constraint and picks the wrong
tool. With narrowing, the wrong tool isn't visible — the model can't
pick it.

This is also a token-economics move (see
`01-llm-foundations/06-token-economics.md`). Tool definitions are
re-shipped every turn; 8 recommendation tools vs 22 union tools is
~1.4k saved tokens per turn. Across a 4-turn recommendation loop,
that's ~5.6k tokens saved, or ~$0.017 per investigation. Small but
real.

## Project exercises

### Exercise — measure per-tool usage per agent + prune unused tools

  → **Exercise ID:** `study-ai-eng-04-04.1`
  → **What to build:** Add a per-tool counter to `BloomingTraceSinkAdapter`
    that accumulates calls per (agent, toolName) pair. Emit a daily
    summary log line. After a week of usage, identify tools that no
    agent has called — remove them from the relevant allowlist.
  → **Why it earns its place:** Data-driven tool pruning. Today the
    allowlists are hand-curated; usage data tells you which entries
    are dead weight.
  → **Files to touch:** `lib/agents/aptkit-adapters.ts:100-141`,
    `lib/mcp/tools.ts` (after analysis, prune unused).
  → **Done when:** Per-tool usage stats are logged; allowlists trimmed
    by ≥1 tool with no behavior change.
  → **Estimated effort:** `1–4hr` (plus a week of waiting on data).

## Interview defense

**Q: How does blooming insights decide which tools each agent gets?**

Hand-curated per-agent allowlists in `lib/mcp/tools.ts`. Four lists:
  - `monitoringTools` (13) — analytics only
  - `diagnosticTools` (17) — analytics + customer/campaign lookups
  - `recommendationTools` (8) — feature discovery
  - `queryTools` (union of all)

The list is the heuristic gate. The model picks from the filtered list;
the LLM-routing happens within the gate. Defense in depth:
prompt-injection can't make a monitoring agent call
`list_email_campaigns` because it's not in `monitoringTools`.

```
  layered routing:

   1. heuristic: which agent for this request?
      → step='diagnose' → DiagnosticAgent (Blooming code decides)

   2. heuristic: which tools does that agent see?
      → diagnosticTools (Blooming allowlist filters)

   3. LLM: which tool to call now?
      → model picks from filtered list (within allowlist)
```

**Anchor line:** "Allowlist gate + model pick. The gate makes
prompt-injection impossible to exfiltrate beyond the agent's scope."

**Q: What would change if you wanted to let one agent call any tool?**

The query agent already does — `queryTools` is the union. The pattern
is: when intent is genuinely flexible (free-form Q&A), union allowlist;
when intent is bounded (specific role), narrow allowlist. The downside
of union is the model has more options to pick badly from, so the
prompt has to work harder to steer.

## See also

  → `02-tool-calling.md` — how the picked tool actually runs
  → `01-llm-foundations/07-heuristic-before-llm.md` — heuristic-before-LLM
    pattern at multiple layers
  → `01-llm-foundations/06-token-economics.md` — what narrow allowlists save
