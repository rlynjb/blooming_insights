# Retrieval routing

_Industry standard._

## Zoom out, then zoom in

Route the query to the right knowledge source before retrieving. Vector store for paraphrase queries, relational store for exact lookups, live search for freshness. **Partially applicable to blooming_insights** — this repo *does* route across tools (analytical EQL vs metadata listings vs prediction scores), but it's not routing across *retrieval* sources; there is no retrieval source at all. Covered for pattern-recognition.

```
  Zoom out — retrieval-source routing (not present here)

  ┌─ Query ─────────────────────────────────────────────────┐
  │  "why did purchase revenue drop in the US?"             │
  └────────────┬────────────────────────────────────────────┘
               ▼
  ┌─ Router (which source?) ────────────────────────────────┐
  │  vector DB (paraphrase queries)                          │
  │  relational DB (exact lookups)                           │
  │  web search (fresh data)                                 │
  └────────────┬────────────────────────────────────────────┘
               │  In this repo: no vector DB, no web search.
               │  The analog is the MODEL routing across MCP tools.
               ▼
  ┌─ TOOL routing (what this repo does) ────────────────────┐
  │  execute_analytics_eql (EQL for revenue trends)         │
  │  list_scenarios (metadata)                              │
  │  get_customer_prediction_score (ML output)              │
  └─────────────────────────────────────────────────────────┘
```

Zoom in: the pattern is *same shape, different destinations*. The model choosing between EQL tool and metadata-list tool at each turn is retrieval-routing, just against analytical tools instead of retrieval sources.

## Structure pass

**Layers:** query · router · sources · combined result.
**Axis:** *which store's shape fits this query?*
**Seam:** the source contract — each source has a different query language / result shape. The router must pick the right one.

```
  Source characteristics — why routing matters

  vector DB       │ semantic paraphrase, top-k         │ noisy
  relational DB   │ exact match, joins, aggregates      │ deterministic
  web search      │ freshest, unstructured              │ latency
  analytical query│ ad-hoc aggregates, time-windowed    │ this repo
                     ↑ what Blooming has: EQL over Bloomreach
```

## How it works

### Move 1 — the mental model

You've built a `switch` on `contentType` before — JSON goes to the parser, XML to a different parser, plain text to nothing. Retrieval routing is the same: query shape decides destination. The router can be a heuristic (regex, keywords) or an LLM (short classifier call).

```
  Pattern: retrieval routing

  query
    │
    ▼
  ┌────────────────────────┐
  │ router: which source?  │
  └──────────┬─────────────┘
        ┌────┼──────┐
        ▼    ▼      ▼
     vector  SQL   web
     (para)  (exact)(fresh)
        │    │      │
        └────┼──────┘
             ▼
        combined
        (each source's chunks
         merged; sometimes reranked)
```

### Move 2 — the walkthrough

**What Blooming has — tool routing done by the LLM, not by an explicit router.** In the DiagnosticAgent's ReAct loop, the model picks WHICH tool to call each turn from the 11-tool allowlist. That's implicit routing:

```js
// from node_modules/@aptkit/.../diagnostic-agent.js:8-23
export const diagnosticInvestigationToolPolicy = {
  capabilityId: 'diagnostic-investigation-agent',
  allowedTools: [
    'execute_analytics_eql',           // analytical
    'get_event_segmentation',           // aggregate
    'list_email_campaigns',             // metadata
    'list_experiments',                 // metadata
    'list_scenarios',                   // metadata
    'list_banners',                     // metadata
    'list_customers',                   // customer state
    'get_customer_prediction_score',    // ML output
    'get_metric_timeseries',            // pre-aggregated series
    'get_segments',                     // segmentation
    'get_anomaly_context',              // event context
  ],
};
```

Line-by-line: 11 tools grouped by shape — analytical (EQL) vs metadata listings vs pre-aggregated ML outputs. The model, when investigating a revenue drop, decides "EQL for the funnel shape, then get_metric_timeseries for the trend, then list_scenarios to see what campaigns might have changed." That's routing across tool categories, driven by the *content* of the investigation — same pattern as retrieval-source routing, different destination.

**Where explicit source routing would land.** If a doc corpus got added, the pattern would need a *pre-loop* router: given the query, decide vector DB vs SQL vs web BEFORE the ReAct loop starts. Reason: the loop's system prompt has to know which tools are relevant, or the model will waste turns trying tools that don't apply.

Hypothetical:
```ts
// hypothetical query-flow with a real retrieval router
async function answer(query: string) {
  const source = await routeToSource(query);
  // source: 'workspace-data' | 'playbook-corpus' | 'live-help-docs'
  const toolPolicy = TOOL_POLICIES[source];
  return runAgentLoop({ ...baseConfig, toolSchemas: toolPolicy });
}
```

Line-by-line: `routeToSource` is one Haiku call at the top. The tool policy for the ReAct loop is scoped to that source's tools only — no wasted turns exploring irrelevant sources.

**The interview-grade point.** A single vector store is rarely the whole answer in production. Routing between vector (paraphrase), relational (exact), and web (freshness) is what production retrieval looks like — the "just add pgvector" architecture works for demos and dies at the "compare this quarter's numbers to what we did last quarter" query.

### Move 3 — the principle

Match source to query. Semantic queries → vector. Exact queries → relational. Fresh queries → web. This repo's version is the tool-selection substrate — the model routes across analytical tools instead of retrieval sources. The pattern is identical; the destinations differ.

## Primary diagram

```
  Recap — routing in this repo vs standard retrieval routing

  STANDARD (retrieval routing):
  query → router → vector | SQL | web → retrieve → generate

  THIS REPO (tool routing, inside ReAct loop):
  query → DiagnosticAgent
              │
              ▼
      ┌──────────────────┐
      │ ReAct step:      │
      │ model picks tool │  ← implicit routing per turn
      └────────┬─────────┘
    ┌─────────┼──────────┐
    ▼         ▼          ▼
  execute_    list_       get_metric_
  analytics_  scenarios   timeseries
  eql         (metadata)  (ML output)
  (analytical)
```

## Elaborate

Retrieval routing at the query-source level is the standard production pattern named cleanly in LangGraph's "adaptive RAG" docs and the "AdaptiveRAG" paper (Jeong et al. 2024). The observation motivating it: even a great vector store has a shape it fits (paraphrase, semantic proximity); routing acknowledges that shape and dispatches other queries elsewhere.

The interesting version of this pattern in Blooming is that routing is done *by the model, per turn, inside the loop* rather than *by code, once, before the loop*. That's a subtler choice — it lets the model dynamically switch tool categories mid-investigation ("I checked the EQL trend; now let me see if a campaign changed"). The tradeoff: the loop has more freedom (more powerful) at the cost of unpredictable tool sequences (harder to debug). Blooming picks freedom because the domain is exploratory.

## Interview defense

**Q: Does blooming_insights route queries to different retrieval sources?**
A: Not to retrieval sources — there aren't any. What it does route is *tool choice inside the ReAct loop*. The model picks from 11 allowed tools per turn — analytical (EQL), metadata (list_scenarios), ML output (get_customer_prediction_score). That's the same shape as retrieval routing, applied to tools instead of stores. If a doc corpus got added, I'd add a pre-loop router (Haiku classifier) picking which tool-policy to use for the whole loop.

Diagram: the two shapes side-by-side.
Anchor: `diagnostic-agent.js:8-23` (the tool allowlist).

**Q: Why is the routing implicit (LLM-per-turn) instead of explicit (code-once-at-top)?**
A: Exploratory domain. In a workspace investigation, the model doesn't know which tool it'll need on turn 3 until it sees turn 2's result. A pre-loop router that picked one tool category would over-constrain — the model would waste turns hitting the wrong tool. Implicit routing per turn lets the model adapt. The cost: harder to debug (no single point that logs "this went to vector, that went to SQL"). Mitigation: the trace sink emits every tool_call_start event, so the sequence is visible in `StatusLog`.

Diagram: the fork — "predictable tool per query → explicit router; exploratory → implicit."
Anchor: `lib/agents/aptkit-adapters.ts:157-166` for the trace sink.

## See also

- `01-agentic-rag.md` — the loop this routing lives at the top of.
- `01-reasoning-patterns/07-routing.md` — routing patterns generally.
- `03-multi-agent-orchestration/02-supervisor-worker.md` — routing at the agent level.
