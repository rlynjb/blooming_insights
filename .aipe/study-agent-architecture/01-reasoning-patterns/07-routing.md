# Routing

**Industry standard.** Pick the right handler before committing to a loop. The bridge from single-agent reasoning to multi-agent orchestration.

## Zoom out, then zoom in

Routing sits *in front of* the agent loop. It's a single-shot decision (or a cascade of single-shot decisions) that picks which loop runs.

```
  Zoom out — where this concept lives

  ┌─ UI layer ──────────────────────────────────────┐
  │  QueryBox  →  fetch /api/agent?q=...             │
  └────────────────────────────┬────────────────────┘
                               │
  ┌─ Orchestration layer ─────▼────────────────────┐
  │  ★ classifyIntent (the router) ★                │ ← we are here
  │  (Haiku, single-shot, no loop)                   │
  └────────────────────────────┬────────────────────┘
              ┌──────────────────┴──────────────────┐
              ▼ intent=query                        ▼ intent=diagnostic
        QueryAgent.answer                  (today: routes to QueryAgent;
        (one ReAct loop)                    diagnostic intent is for
                                            future routing, not yet wired)
```

This repo runs *one* level of routing — the intent classifier in `lib/agents/intent.ts`. There's no second level (no supervisor picking which sub-agent to run inside an agent), because the orchestration above the agents is deterministic code, not an LLM router.

## Structure pass

Layers: heuristic router (fast, deterministic — regex, rules) → LLM router (slower, model-decided, for ambiguous input) → the agent that handles the matched route.

**Axis traced — "what decides the route?":** in this repo it's the model (Haiku) for one decision; everything else is code. There's no heuristic-first cascade.

**Seam:** the typed `Intent` value (`'query' | 'diagnostic'`) is the handoff between the router and the downstream agent dispatch. The router's job is to produce that value; the dispatcher's job is to wire the right agent based on it.

## How it works

### Move 1 — the mental model

You know the pattern from a frontend `Router` component — match the URL, dispatch to the right page component. The agent version is the same shape, with a model where the URL matcher would be: the model reads free-form input and emits a typed intent the dispatcher can switch on.

```
  Routing — the model as a typed dispatch

  user types: "what's our top product this week?"
          │
          ▼
  ┌─ classifyIntent (Haiku) ────────────────────────┐
  │  one model call, no tools, no loop              │
  │  system prompt: "classify this question…"        │
  │  output: 'query' | 'diagnostic'                 │
  └──────────────────────┬──────────────────────────┘
                         │  intent
                         ▼
  ┌─ deterministic dispatch (route handler) ─────────┐
  │  switch (intent):                                │
  │    case 'query': run QueryAgent                  │
  │    case 'diagnostic': … (no path yet)            │
  └──────────────────────────────────────────────────┘
```

The model isn't in the loop after the routing decision. The dispatch is plain `if`/`switch` code in `app/api/agent/route.ts:247-260`.

### Move 2 — step by step

#### The classifier — one model call, no tools, no loop

Open `lib/agents/intent.ts`:

```ts
// lib/agents/intent.ts:21-38
const CLASSIFIER_MODEL = 'claude-haiku-4-5-20251001';

export async function classifyIntent(
  anthropic: Anthropic,
  query: string,
  sessionId?: string,
  signal?: AbortSignal,
): Promise<Intent> {
  return classifyAptKitIntent(
    new AnthropicModelProviderAdapter(
      anthropic,
      'coordinator',
      sessionId,
      CLASSIFIER_MODEL,           // ← Haiku, not Sonnet
      'agents/intent:classifyIntent',
    ),
    query,
    { signal },
  );
}
```

Three properties matter here:

1. **Haiku, not Sonnet.** Routing decisions are cheap; the classifier model is the small/fast one. The agent that handles the route uses the bigger model. Cost ratio is roughly 10x — Haiku at ~$0.001/1K input tokens vs Sonnet at ~$0.003/1K + Haiku is faster end-to-end.
2. **No loop.** `classifyAptKitIntent` (from `@aptkit/core`) is single-shot — one `model.complete` call, parse the output, return. No `runAgentLoop`. The skeleton from `02-agent-loop-skeleton.md` is the same shape with `maxTurns=1`.
3. **Returns a typed value.** `Intent` is `QueryIntent` from AptKit — a small union. `parseIntent` (line 12 of `intent.ts`) handles the case where the model emits something off-format, defaulting to `'diagnostic'`. That default is the "fail-open" choice — when the classifier is uncertain, route to the more capable agent (the one with broader tools).

#### The dispatch — deterministic `if` code

```ts
// app/api/agent/route.ts:247-260 (abridged)
if (q && !insightId) {
  req.signal.throwIfAborted();
  const intent = await classifyIntent(anthropic, q, sid, req.signal);
  stepFor('coordinator', 'thought', `interpreting your question as a ${intent} query…`);
  const queryAgent = new QueryAgent(anthropic, dataSource, schema, allTools, sid);
  const answer = await queryAgent.answer(q, intent, { ...hooksFor('coordinator'), signal: req.signal });
  stepFor('coordinator', 'conclusion', answer);
  send({ type: 'done' });
  return;
}
```

Today the dispatch is "always run QueryAgent, but pass the intent down so the agent's prompt can adapt to it." This is route-but-don't-fork: the same agent class handles both intents; the intent flavors the prompt inside `QueryAgent.answer` (line 25 of `lib/agents/query.ts`).

A fuller routing implementation would dispatch to different agent classes per intent (e.g. `case 'diagnostic': run DiagnosticAgent against a synthesized anomaly`). The repo doesn't yet — the QueryBox is the only free-form-input entry point and the QueryAgent covers both shapes with its 33-tool allowlist.

#### The bridge to multi-agent

In a single-agent system, routing picks a *tool* (or here, a flavor of prompt). In a multi-agent system, the same pattern picks which *agent* handles the request — that's the supervisor's core job. The skill transfers directly: `classifyIntent` today picks one agent's prompt flavor; a supervisor in a multi-agent system would pick which agent to dispatch to.

```
  Routing's role in two topologies

  Single-agent (today):                Multi-agent (future):

  input ──► classify ──► agent         input ──► supervisor (classifies)
                          ▲                            │
                          │                       ┌────┼────┐
                  one agent always                ▼    ▼    ▼
                  receives the                  agent agent agent
                  matched intent                  A    B    C
```

The supervisor IS a router that also synthesizes — it picks who runs, the picked agent runs, the supervisor merges the result. The repo doesn't have this layer yet (orchestration is deterministic code, not a supervisor). See `03-multi-agent-orchestration/02-supervisor-worker.md`.

#### The production pattern — heuristic at the front, LLM at the back

This repo doesn't have a heuristic-first layer, but the production pattern is worth knowing: a regex or rule-based router handles the high-volume predictable routes (e.g. anything matching `/^show me top \w+$/` → `query` intent, no model call needed), and the LLM router handles the long tail of ambiguous phrasings. The win is cost — for an interface with 1000 queries/day, if 80% match a heuristic, you've saved 800 classifier calls. The cost — adding the heuristic — is one regex table.

For this repo's QueryBox volume (low; one user at a time during a demo), the heuristic layer isn't worth adding. The Haiku classifier costs ~$0.0001 per call; the engineering cost of maintaining a regex table exceeds the model cost at this volume.

### Move 3 — the principle

**Routing is the cheapest way to compose capabilities.** Instead of building one mega-agent that handles every input type with one giant prompt and one bloated tool allowlist, you build N small agents each specialized for one input type and put a router in front. The router's cost is one cheap model call; each downstream agent is simpler, smaller, and easier to test. The interview-grade move: lead with the routing decision when describing an agent system, not the agents. The routing is what makes the agents composable.

## Primary diagram

```
  Routing in the QueryBox path — one shot, then the agent

  ┌─ UI ────────────────────────────────────────────────────────┐
  │  QueryBox  →  GET /api/agent?q=<encoded query>              │
  └─────────────────────────────┬───────────────────────────────┘
                                │
                                ▼
  ┌─ /api/agent route handler ─────────────────────────────────┐
  │  if (q && !insightId):                                      │
  │    req.signal.throwIfAborted()                              │
  │                                                              │
  │    ┌─ classifyIntent (Haiku, single call) ──────────────┐   │
  │    │  AnthropicModelProviderAdapter                       │   │
  │    │   ─► claude-haiku-4-5-20251001                        │   │
  │    │  one model.complete, no tools                        │   │
  │    │  output: 'query' | 'diagnostic'                      │   │
  │    │  (parseIntent defaults to 'diagnostic' on parse fail)│   │
  │    └────────────────────┬──────────────────────────────────┘   │
  │                         │  intent                                │
  │                         ▼                                        │
  │    ┌─ dispatch (today: always QueryAgent, pass intent) ─┐    │
  │    │  new QueryAgent(...).answer(q, intent, hooks)        │    │
  │    │   ─► runAgentLoop with 33-tool allowlist              │    │
  │    │  intent flavors the system prompt inside QueryAgent  │    │
  │    └────────────────────┬──────────────────────────────────┘    │
  │                         │  answer                                 │
  │                         ▼                                         │
  │    stepFor('coordinator', 'conclusion', answer)                  │
  │    send({ type: 'done' })                                        │
  └──────────────────────────────────────────────────────────────────┘
```

## Elaborate

The routing pattern shows up at three altitudes in a mature agent system:

1. **Above the agents** (covered above) — pick which agent runs.
2. **Inside an agent's loop** — the model picks which tool to call. That's already what ReAct's `tool_use` block is. The model is routing per-turn.
3. **Inside a tool** — the called tool might itself route between sub-tools or data sources. The MCP layer in this repo is a single source so this altitude doesn't apply, but a multi-source retrieval router (vector DB + SQL + web search) would be exactly this.

All three are the same pattern — typed input, typed routing decision, typed dispatch — at different altitudes.

The classifier model choice matters more than people credit. A common mistake: use the same Sonnet model for routing that you use for the agent. That doubles the per-request cost for no quality gain — routing is a coarse decision (5-10 categories typical) that a small model handles fine. The repo's choice of Haiku for the classifier is the right one: the savings compound over volume.

The "fail-open" default in `parseIntent` (defaulting to `'diagnostic'` when the model emits an unrecognized intent) is a small but load-bearing call. The alternative would be fail-closed: throw an error and surface a 500. Fail-open lets the request through to a capable agent; the worst case is the request goes to a slightly-wrong-but-still-tooled agent, not a hard failure. For user-facing agent systems this is almost always the right call.

## Interview defense

> **Q: Walk through how the QueryBox handles a free-form question.**
>
> Three stages. UI fires `GET /api/agent?q=...`. The route handler in `app/api/agent/route.ts:247-260` runs `classifyIntent`, which is a single-shot Haiku call that maps the question to `'query' | 'diagnostic'`. Then it dispatches: today, always to `QueryAgent` (`lib/agents/query.ts`), with the intent passed down so the agent's prompt can adapt. `QueryAgent.answer` runs `runAgentLoop` with the broad 33-tool allowlist, the model picks which MCP tools to call, and the final text streams back as a `reasoning_step` event of kind `conclusion`. The whole path is two model invocations — one Haiku for the intent, one or more Sonnet calls inside the agent loop.
>
> Anchor: `lib/agents/intent.ts:21-38` (classifier) → `app/api/agent/route.ts:247-260` (dispatch) → `lib/agents/query.ts` (agent).

> **Q: Why is the classifier a separate Haiku call instead of just letting Sonnet handle it?**
>
> Cost and latency. Haiku is ~10x cheaper per token than Sonnet and meaningfully faster for short outputs. Routing is a coarse decision — the model only needs to pick between two categories — so a small model handles it fine. If we routed through Sonnet, every query would pay Sonnet pricing for the routing step plus Sonnet pricing for the answer step, doubling the cost floor. The classifier model is configurable at the `AnthropicModelProviderAdapter` constructor (`lib/agents/aptkit-adapters.ts:31-37`) so swapping isn't a code-change-the-loop operation — it's one constructor argument.

> **Q: Where would routing escalate in this system?**
>
> Two places. First, if the QueryBox grew more intent types — "explore the schema," "build a custom anomaly category," "compare two time windows" — and each needed a meaningfully different agent (different tool allowlist, different prompt), then today's "always run QueryAgent" dispatch becomes a real `switch` over intent → agent class. Second, if the briefing flow grew dynamic ("sometimes monitor anomalies, sometimes run a deep dive on one customer segment, sometimes summarize the catalog"), the deterministic pipeline in `app/api/briefing/route.ts` becomes a supervisor that classifies the user's session intent and dispatches to one of several pipelines. The first escalation is one-level routing; the second is a supervisor-worker topology.

## See also

- → `02-agent-loop-skeleton.md` — the loop the router dispatches to (with `maxTurns=1` for the router itself)
- → `02-agentic-retrieval/03-retrieval-routing.md` — routing applied to picking a data source
- → `03-multi-agent-orchestration/02-supervisor-worker.md` — routing applied to picking an agent
- → cross-reference (when generated): `study-ai-engineering`'s tool-routing file — the per-call mechanics of structured outputs for routing
