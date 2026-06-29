# Tool routing

*Industry standard — heuristic + LLM-decided routing*

## Zoom out — where this concept lives

This codebase routes work in two layers. **Intent routing**: which agent handles a free-form question (cheap Haiku classifier). **Tool routing**: within an agent, which tool the LLM picks (constrained by the per-agent allowlist). Heuristic up front (allowlist filter), LLM at the back (per-call tool choice from the filtered list).

```
  Zoom out — two-layer routing

  ┌─ User free-form query ──────────────────────────────────┐
  │  "why did revenue drop in USA?"                          │
  └──────────────────────┬──────────────────────────────────┘
                         │
                         ▼
  ┌─ Layer 1: Intent routing ★ (cheap LLM) ─────────────────┐ ← we are here
  │  classifyIntent (Haiku) → 'diagnostic'                  │
  │  picks the downstream agent                              │
  └──────────────────────┬──────────────────────────────────┘
                         │  invokes QueryAgent
                         ▼
  ┌─ Layer 2: Tool routing (allowlist + LLM) ───────────────┐
  │  QueryAgent gets the union allowlist (37 tools)         │
  │  LLM picks tools from that surface, per iteration       │
  └─────────────────────────────────────────────────────────┘
```

**Zoom in.** Heuristic-before-LLM at both layers — the allowlist is the heuristic; the LLM-driven pick is the model's job. The pattern repeats at two altitudes.

## Structure pass — layers · axes · seams

**Layers:** intent layer → agent layer → tool layer.

**Axis: who decides?** Intent: cheap LLM (Haiku). Agent: chain (route's hardcoded sequence). Tool: filtered allowlist + LLM pick.

**Seam:** the allowlist at `lib/mcp/tools.ts`. That's where the routing surface is narrowed before the LLM ever sees it.

## How it works

### Move 1 — the mental model

You know how a load balancer routes by hostname before any backend gets the request? Same idea at two altitudes. Intent classification picks which agent (which "backend") handles the request; the per-agent allowlist picks which tools that agent is allowed to use.

```
  Two-layer routing — picture

  user query                         allowlist (intent)
       │                                  │
       ▼                                  │
  ┌─ Intent classify (Haiku) ─────────────┘
  │                                  │
  ▼                                  ▼
  monitoring                  diagnostic           recommendation
  agent                       agent                agent
  ├ tool allowlist [13]       ├ tool allowlist [17] ├ tool allowlist [7]
  │  ─ execute_analytics_eql  │  ─ execute_analytics_eql ─ list_scenarios
  │  ─ list_dashboards        │  ─ get_funnel       │  ─ list_segmentations
  │  ─ ...                    │  ─ list_customers   │  ─ list_voucher_pools
  │                           │  ─ ...              │  ─ ...
  │
  ▼  per agent iteration:
  LLM picks from its filtered allowlist
```

### Move 2 — the step-by-step walkthrough

**Part 1 — intent routing happens at the route boundary.**

`app/api/agent/route.ts:247-253` only fires the intent classifier on the free-form `q` path:

```typescript
if (q && !insightId) {
  const intent = await classifyIntent(anthropic, q, sid, req.signal);
  stepFor('coordinator', 'thought', `interpreting your question as a ${intent} query…`);
  const queryAgent = new QueryAgent(anthropic, dataSource, schema, allTools, sid);
  const answer = await queryAgent.answer(q, intent, { ...hooksFor('coordinator'), signal: req.signal });
}
```

When the user clicks a card (anomaly investigation), there's no classifier — the route already knows the agent path (diagnose → recommend). The classifier exists only for the chat surface.

**Part 2 — the QueryAgent receives the intent.**

`lib/agents/query.ts:24-32`:

```typescript
async answer(query: string, intent: Intent, hooks: AgentHooks = {}): Promise<string> {
  const agent = new AptKitQueryAgent({
    model: new AnthropicModelProviderAdapter(this.anthropic, 'coordinator', this.sessionId),
    tools: new BloomingToolRegistryAdapter(this.dataSource, this.allTools),
    workspace: this.schema,
    trace: new BloomingTraceSinkAdapter(hooks, 'coordinator'),
  });

  return agent.answer(query, { intent, signal: hooks.signal });
}
```

The `intent` is passed to AptKit's QueryAgent as a hint — the library uses it to shape its prompt (e.g. "you're answering a diagnostic-style question" vs "you're answering a monitoring-style question"). The TOOL surface is still the full union (37 tools) because the QueryAgent needs broad reach.

**Part 3 — tool allowlists are per-agent, defined in one file.**

`lib/mcp/tools.ts` carries the four allowlists:

```typescript
const monitoringToolsBloomreach = [13 tool names...] as const;
const diagnosticToolsBloomreach = [17 tool names...] as const;
const recommendationToolsBloomreach = [7 tool names...] as const;

// The union for the query agent (37 deduplicated).
export const queryTools = [
  ...new Set<string>([...monitoringTools, ...diagnosticTools, ...recommendationTools]),
] as const;
```

The allowlists are pinned constants. Adding a tool to an agent's surface is a one-line change. Removing one is also one line.

**Part 4 — the filter wraps the live MCP tool list.**

`lib/agents/tool-schemas.ts:9-21` is the filter that runs at agent construction:

```typescript
export function filterToolSchemas(
  all: McpToolDef[],
  allowed: readonly string[],
): Anthropic.Messages.Tool[] {
  const set = new Set(allowed);
  return all
    .filter((t) => set.has(t.name))
    .map((t) => ({
      name: t.name,
      description: t.description ?? '',
      input_schema: t.inputSchema as Anthropic.Messages.Tool['input_schema'],
    }));
}
```

Set membership check. The MCP server might expose 50 tools; the agent only sees the ones in its allowlist. Important: the model can ONLY pick tools whose schemas are in its `tools[]` array — the SDK rejects `tool_use` blocks for unknown tool names.

This means the allowlist is a *hard* constraint, not a hint. The recommendation agent literally cannot emit a `tool_use` for `execute_analytics_eql` — the schema isn't shipped to it.

### Move 3 — the principle

**Constrain the choice space before the LLM picks.** Heuristic routing isn't necessarily a regex or a rule — it's any structural narrowing that runs before the model gets the input. Intent classification narrows agents; allowlists narrow tools. Both layers apply the same principle: don't let the LLM choose from options it shouldn't have.

## Primary diagram — the full recap

```
  Two-layer routing in this codebase

  ┌─ User typed query ───────────────────────────────────────────┐
  │  "why did revenue drop in USA?"                              │
  └──────────────────────┬───────────────────────────────────────┘
                         │  POST /api/agent?q=…
                         ▼
  ┌─ Layer 1: Intent routing ─────────────────────────────────────┐
  │  classifyIntent (Haiku, ~$0.0003)                            │
  │  parseIntent fallback: 'diagnostic'                           │
  │   → 'monitoring' | 'diagnostic' | 'recommendation' | 'generic'│
  └──────────────────────┬───────────────────────────────────────┘
                         │  passes intent into QueryAgent
                         ▼
  ┌─ Agent selection (chain-decided per intent) ─────────────────┐
  │  QueryAgent (with union allowlist)                            │
  │   OR if user clicked card: DiagnosticAgent → RecommendationAgent│
  └──────────────────────┬───────────────────────────────────────┘
                         │  filterToolSchemas at construction time
                         ▼
  ┌─ Layer 2: Tool surface ──────────────────────────────────────┐
  │  filtered tools[] handed to model                            │
  │  monitoring: 13   diagnostic: 17   recommendation: 7   query:37│
  └──────────────────────┬───────────────────────────────────────┘
                         │  per ReAct iteration
                         ▼
  ┌─ LLM picks ──────────────────────────────────────────────────┐
  │  model emits tool_use(name) ∈ filtered tools                  │
  │  (schemas the model never saw cannot be picked)               │
  └──────────────────────────────────────────────────────────────┘
```

## Elaborate

**Why two layers, not one.** A single-layer router would have to know about every tool every agent might call — that's 37 tools and a much harder routing problem ("which TOOL handles this query?" instead of "which AGENT handles this query?"). The two-layer split pushes the heavy decision (broad agent surface) to the cheap classifier and keeps the precise decision (per-iteration tool pick) inside the agent loop where the LLM has full context.

**Why heuristic at the allowlist layer, LLM at the per-call layer.** Each agent's tool set is fixed at deployment time — it's a structural property of the system. Hard-coding it as an allowlist is the right move. Per-call tool choice depends on the specific anomaly + the conversation so far — too dynamic for a hardcoded rule. LLM decides.

**Where this codebase doesn't push routing further.** Inside the monitoring loop, each tool call's *arguments* (the specific EQL string) are LLM-decided. A more aggressive routing pattern would hard-code first-call EQL per category (the `B1.7` exercise) — pushing more routing into the heuristic layer to save LLM calls.

## Project exercises

### Exercise — Add a regex fast-path to the intent classifier

  → **Exercise ID:** B4.4
  → **What to build:** Before the Haiku intent call, check the user's query against a small set of keyword regexes — `/why\b|why did|what caused/i → 'diagnostic'`, `/show me|list|how many/i → 'monitoring'`, `/recommend|what should/i → 'recommendation'`. If a regex matches, skip the Haiku call entirely and return the regex's intent. Fall back to Haiku otherwise.
  → **Why it earns its place:** ~50%+ of free-form queries match these patterns. Skipping the Haiku call saves ~150ms per matched query and a tiny per-call cost — small individually, real in aggregate on a chat surface. Pure heuristic-before-LLM at the intent layer.
  → **Files to touch:** `lib/agents/intent.ts` (add a regex pre-check), `test/agents/intent.test.ts` (cover regex matches, fallthrough to Haiku).
  → **Done when:** the per-phase log shows `intent_classify` taking ~0ms for queries matching the regex (vs ~150-300ms for fallthrough), the regex coverage is documented, and the existing intent tests pass.
  → **Estimated effort:** <1hr.

## Interview defense

**Q: "How does your system decide which agent runs?"**

Two layers. First, the chain layer in the route — if the user clicked a card, the diagnostic agent runs (then the recommendation agent on the next click). No LLM involved. Second, for free-form questions, an intent classifier (Haiku, ~$0.0003) picks one of `'monitoring' | 'diagnostic' | 'recommendation' | 'generic'`. The QueryAgent then runs with that intent as a hint. Both layers apply heuristic-before-LLM at their altitude.

*Anchor: "Chain decides for clicks; cheap classifier decides for typed questions."*

**Q: "Why doesn't every agent get every tool?"**

Three reasons. (1) Token budget — each tool's schema in the prompt costs ~50-100 tokens. 37 tools × 70 tokens ≈ 2600 tokens of schema in every prompt. Per-agent allowlists save ~50-70% of that. (2) Decision latency — fewer choices makes faster decisions. The monitoring agent doesn't need 17 tools; it needs the 13 that touch dashboards/trends/EQL. (3) Structural safety — the recommendation agent literally can't call `execute_analytics_eql` because the schema isn't shipped. That's structural prompt-injection defense: even a perfectly-injected prompt couldn't get the recommendation agent to run an EQL.

*Anchor: "Tokens + latency + safety. The allowlist is structural, not advisory."*

## See also

  → `02-tool-calling.md` — the per-tool mechanics this routes into
  → `01-llm-foundations/07-heuristic-before-llm.md` — the intent classifier from the cheap-LLM lens
  → `06-production-serving/03-prompt-injection.md` — the structural-safety property the allowlist provides
