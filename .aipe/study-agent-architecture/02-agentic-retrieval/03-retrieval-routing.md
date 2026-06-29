# Retrieval routing

**Industry standard.** When there are multiple knowledge sources, route the query to the right one before retrieving. Partially exercised in this repo at the tool-allowlist level.

## Zoom out, then zoom in

Sits in front of retrieval. The router picks the source; the retrieval runs against the picked source; the agent's loop continues.

```
  Zoom out — where this concept lives

  ┌─ Agent loop ─────────────────────────────────────┐
  │  model emits tool_use ◄── router lives here in   │ ← we are here
  │  this repo (the model picks within its allow-     │
  │  list; no separate router model)                  │
  └────────────────────────────┬─────────────────────┘
                               │
  ┌─ Tool registry ───────────▼─────────────────────┐
  │  per-agent allowedTools list filters which       │
  │  tools the model sees (4 / 11 / 14 / 33 tools)   │
  └────────────────────────────┬─────────────────────┘
                               │
  ┌─ Knowledge sources ───────▼─────────────────────┐
  │  Bloomreach MCP server (the only source)         │
  │  ~33 tools exposed; agent picks via tool_use     │
  └──────────────────────────────────────────────────┘
```

The classic retrieval-routing diagram has 2-3 different storage substrates (vector DB, SQL, web search) and a router that picks among them. This repo has *one* substrate (Bloomreach MCP), so the routing collapses to a single layer — the per-agent tool allowlist that filters which subset of the 33 MCP tools each agent can call.

## Structure pass

Layers: query (model-emitted) → router decision (which source?) → retrieval against that source → result back into the loop.

**Axis traced — "what decides the source?":** in a canonical multi-source system, a router model. Here, the model picks a tool from the allowlist directly — there's no separate routing model.

**Seam:** the per-agent `allowedTools` list (in each AptKit agent's policy). That's the coarse routing: monitoring sees 4 tools, diagnostic sees 11, recommendation sees 14, query sees 33. The model picks within its allowed surface.

## How it works

### Move 1 — the mental model

You know the difference between using one database and using three. Single-source retrieval just queries the one source. Multi-source retrieval has to first ask "which source has the answer to this kind of question?" — vector DB for paraphrase-like questions, relational DB for exact lookups, web search for freshness. The router is the layer that picks before retrieving.

```
  Multi-source retrieval routing (the canonical shape)

  query ──► ┌─ router: which source? ──┐
            └──────────┬───────────────┘
          ┌────────────┼────────────┐
          ▼            ▼            ▼
       vector DB    SQL DB     web search
       (semantic)   (exact)    (fresh)
```

This repo's substrate is one MCP server with ~33 tools; the canonical multi-source pattern collapses to **per-agent capability gating**: instead of routing across substrates, each agent is *constructed* with a narrower allowlist of which tools it can see.

```
  This repo's routing — at the allowlist boundary

  agent class is constructed                       
  with a fixed allowedTools list:
  
    monitoring:    [execute_analytics_eql,
                    get_metric_timeseries,
                    get_segments,
                    get_anomaly_context]  (4 tools)
    
    diagnostic:    [execute_analytics_eql,
                    get_event_segmentation,
                    list_email_campaigns,
                    list_experiments,
                    list_scenarios,
                    list_banners,
                    list_customers,
                    get_customer_prediction_score,
                    + 3 more]  (11 tools)
    
    recommendation: [list_scenarios, get_scenario,
                     list_initiatives, list_recommendations,
                     get_recommendation, list_segmentations,
                     list_email_campaigns, list_voucher_pools,
                     get_frequency_policies,
                     + 5 more]  (14 tools)
    
    query:         [all of the above plus dashboards,
                    trends, funnels, reports,
                    customer events, catalog items,
                    SMS / in-app / banners, …]  (33 tools)
  
  Within its allowlist, the model picks via tool_use.
  Across allowlists, the agent class is the router —
  the deterministic orchestrator picks which agent.
```

The route handlers in `app/api/briefing/route.ts` and `app/api/agent/route.ts` are the cross-agent router; the `allowedTools` policy is the within-agent constraint.

### Move 2 — step by step

#### How the allowlists are enforced

Open `node_modules/@aptkit/core/node_modules/@aptkit/agent-anomaly-monitoring/dist/src/monitoring-agent.d.ts`:

```ts
export declare const anomalyMonitoringToolPolicy: {
    capabilityId: string;
    allowedTools: readonly [
      "execute_analytics_eql",
      "get_metric_timeseries",
      "get_segments",
      "get_anomaly_context"
    ];
};
```

That `allowedTools` array is the routing surface. In `monitoring-agent.js:40`:

```js
const toolSchemas = filterToolsForPolicy(allTools, anomalyMonitoringToolPolicy);
```

`filterToolsForPolicy` (in `@aptkit/tools`) takes the full 33-tool surface from the data source and filters down to the 4 the monitoring agent is allowed to see. Those 4 are what get passed as `toolSchemas` to `runAgentLoop`, which means those 4 are what the model can emit `tool_use` blocks for. The other 29 are invisible — the model can't pick them.

Same shape for the other three agents — each AptKit agent class has its own `*ToolPolicy.allowedTools` constant filtered before the loop starts.

#### Why this *is* routing, even though there's no router model

The routing decision is made *before* the agent loop starts — at agent-class construction time, by the deterministic orchestrator. When `app/api/briefing/route.ts` constructs a `MonitoringAgent`, it's effectively routing "this is a monitoring task, send it to the agent that can only see the 4 anomaly-scanning tools." When `app/api/agent/route.ts` constructs a `DiagnosticAgent`, it's routing "this is a diagnostic task, send it to the agent that can see the 11 evidence-gathering tools."

The route handler is the router, the agent class is the routed-to handler. No router model is needed because the *task* dictates the agent class deterministically: a briefing is always monitoring, an investigation step 2 is always diagnostic, step 3 is always recommendation. The model decisions happen *within* each agent's allowlist, not across them.

#### Why intent classification doesn't count as multi-source routing

The QueryBox path runs `classifyIntent` (`lib/agents/intent.ts`) before dispatching, but today it always dispatches to `QueryAgent` regardless of the classified intent. The intent flavors the prompt inside `QueryAgent.answer` — it doesn't pick a different agent class. So it's *routing within one agent's prompt*, not routing across knowledge sources.

If the codebase grew to dispatch differently per intent (`case 'diagnostic': run DiagnosticAgent against a synthesized anomaly`), that would be true intent-driven routing across agents. The classifier is in place; the differentiated dispatch isn't.

#### What this *would* look like with a second data source

The repo doesn't have one today, but the shape is worth sketching. If the team added a second source — say, an internal documentation MCP server for explaining Bloomreach features — the routing would need a layer:

```ts
// hypothetical lib/data-source/composite.ts (not implemented)
class CompositeDataSource implements DataSource {
  constructor(
    private bloomreach: BloomreachDataSource,
    private docs: DocsDataSource,
    private router: ModelProvider,  // Haiku-class router
  ) {}

  async callTool(name, args, options) {
    // delegate to whichever data source exposes this tool
    if (this.bloomreach.exposes(name)) return this.bloomreach.callTool(name, args, options);
    if (this.docs.exposes(name)) return this.docs.callTool(name, args, options);
    throw new Error(`No source for tool: ${name}`);
  }

  async listTools(options) {
    // union of both sources' tools
    const [a, b] = await Promise.all([
      this.bloomreach.listTools(options),
      this.docs.listTools(options),
    ]);
    return { tools: [...a.tools, ...b.tools] };
  }
}
```

In that world the model would emit `tool_use` blocks for tools from either source; the `CompositeDataSource` dispatches based on which source exposes the named tool. The "router" isn't a separate model — it's a name-based dispatch inside the composite. The model still picks the source implicitly by picking the tool.

A truly router-model-driven version would have the composite consult a model first ("here's a query; should I route this to Bloomreach or the docs?") and only expose the picked source's tools. That's heavier and only worth it when the source decision is genuinely ambiguous — when tool names overlap or when picking the wrong source wastes meaningful budget.

### Move 3 — the principle

**Retrieval routing is capability gating at the source granularity.** The point isn't to be clever about which source — it's to scope each agent (or each call) to the narrowest surface that can answer the question. In a single-source world (this repo today), that gating shows up as per-agent tool allowlists. In a multi-source world, it shows up as a router picking which source. The mechanism differs; the principle (narrow before retrieving) is the same.

The production realization that single-vector-store retrieval rarely covers production needs maps to this repo's pattern: even with one substrate (Bloomreach), the 33 tools span semantically different *capabilities* (analytics queries, scenario reads, segment lookups, recommendation reads, customer event reads). Treating them as one undifferentiated surface and letting every agent see all 33 would mean every model call carries 33 tool definitions in its system prompt — wasted tokens and a worse picker (the model is more likely to pick a tangentially-related tool when the choice space is wider).

## Primary diagram

```
  This repo's routing — capability gating at agent-class construction

  ┌─ orchestrator (route handler) ──────────────────────────────────┐
  │  briefing/route.ts:                                              │
  │     new MonitoringAgent(...)        ←── routes to monitoring     │
  │                                                                   │
  │  agent/route.ts:                                                  │
  │     if step is null or 'diagnose':                                │
  │       new DiagnosticAgent(...)      ←── routes to diagnostic      │
  │     if step is null or 'recommend':                               │
  │       new RecommendationAgent(...)  ←── routes to recommendation  │
  │     if q (free-form):                                             │
  │       classifyIntent → new QueryAgent(...)  ←── routes to query   │
  └──────────────────────────────┬──────────────────────────────────┘
                                 │
       ┌─────────────────────────┼───────────────────────────────┐
       ▼                         ▼                               ▼
  ┌────────────┐          ┌────────────┐                  ┌────────────┐
  │ Monitoring │          │ Diagnostic │  ...             │   Query    │
  │  4 tools   │          │  11 tools  │                  │  33 tools  │
  │  allowed   │          │  allowed   │                  │  allowed   │
  └─────┬──────┘          └─────┬──────┘                  └─────┬──────┘
        │                       │                                │
        │    each agent runs runAgentLoop; model picks tool_use │
        │    within its allowlist via filterToolsForPolicy       │
        ▼                       ▼                                ▼
  ┌──────────────────────────────────────────────────────────────────┐
  │  BloomreachDataSource (single source — one MCP server)            │
  │  callTool dispatches by name; cache → spacing → wire → retry      │
  └──────────────────────────────────────────────────────────────────┘
```

## Elaborate

The retrieval-routing pattern in canonical agentic RAG is about source heterogeneity — different storage substrates with different retrieval profiles (semantic for vector, exact for SQL, fresh for web). The single-substrate version this repo runs collapses the source decision but keeps the *capability* decision (which subset of tools fits this task).

The cost of the bigger-allowlist approach (just give every agent all 33 tools and let the model pick) is real and measurable:

- **Token cost per turn.** Tool schemas live in the system prompt. 33 tool schemas at ~200 tokens each = ~6,600 tokens of overhead per turn. With 4-7 turns per investigation, that's 25K-50K wasted input tokens. Per-agent narrowing cuts that to 1-3K tokens of overhead per turn.
- **Picking quality.** Models are better at picking from a small menu of relevant tools than a large menu of mostly-irrelevant ones. The narrower the allowlist, the less likely the model picks a tangentially-related tool. This is a well-documented effect; the agent SDK guides all recommend narrowing tool surfaces per task.

The per-agent policies are baked into AptKit's package design — each `agent-*` package ships its policy as a const. That's the right place: the policy belongs to the capability, not to the deploying app. The Blooming repo gets the policies for free by using AptKit's agent classes; if Blooming added a custom agent it would define its own policy alongside.

## Interview defense

> **Q: How does this codebase route retrieval?**
>
> Capability gating at the agent-class boundary, not source routing. There's one knowledge source (Bloomreach MCP, ~33 tools). Each agent class is constructed with a fixed `allowedTools` allowlist — monitoring sees 4 tools, diagnostic 11, recommendation 14, query 33 — via `filterToolsForPolicy`. The deterministic route handler picks which agent class to instantiate based on the task; within the agent, the model picks tools from its narrowed allowlist via `tool_use` blocks. The route handler is the cross-agent router; the allowlist is the within-agent constraint.
>
> Anchor: `node_modules/.../@aptkit/agent-anomaly-monitoring/.../monitoring-agent.js:40` (the `filterToolsForPolicy` call) → each agent's `*ToolPolicy.allowedTools` const.

> **Q: Why narrow the allowlist instead of giving every agent all 33 tools?**
>
> Two costs. First, tokens: tool schemas live in the system prompt, ~200 tokens each, ~6.6K tokens per turn if all 33 are exposed. Per-agent narrowing cuts that 4-6x. Second, picking quality: the model is better at picking from a small menu of relevant tools than a large menu with most irrelevant. The narrower surface produces sharper picks and reduces the "tangentially related tool" misroute. The pattern is industry-standard — every agent SDK guide recommends narrowing per task.

> **Q: What would change if you added a second knowledge source?**
>
> A composite `DataSource` adapter that fans out across both sources, with the routing collapsed into name-based dispatch (which source exposes this tool). The agents wouldn't need to change — they call through the `DataSource` port, the composite handles the source-picking. The agent's allowlist still narrows the capability surface; the composite handles "which substrate" given the picked tool name. A router model would only be necessary if tool names overlapped across sources or if the source decision was genuinely ambiguous — neither would be true in the obvious "add a docs MCP server" expansion.
>
> Anchor: hypothetical `lib/data-source/composite.ts` implementing the `DataSource` interface from `lib/data-source/types.ts`.

> **Q: Where does the intent classifier fit in this routing story?**
>
> One level up from the data-source routing. `classifyIntent` (`lib/agents/intent.ts`) decides *intent* (`query` | `diagnostic`) on the QueryBox path; today the dispatch always runs `QueryAgent` and just flavors its prompt with the intent. If the dispatch grew to pick *different agent classes* per intent — `case 'diagnostic': run a DiagnosticAgent` — that would be true intent-driven agent routing. The classifier is in place; the differentiated dispatch isn't. The cross-agent routing for the investigation path (briefing → diagnose → recommend) doesn't need a classifier because the task dictates the agent deterministically.

## See also

- → `01-agentic-rag.md` — the loop that runs after the routing decision
- → `01-reasoning-patterns/07-routing.md` — the broader routing pattern at the agent-class level
- → `04-agent-infrastructure/03-tool-calling-and-mcp.md` — the tool definitions the allowlist filters
- → `04-agent-infrastructure/05-guardrails-and-control.md` — the allowlist as a security/control mechanism
