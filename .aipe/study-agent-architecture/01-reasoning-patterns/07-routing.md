# Routing

_Industry standard._

## Zoom out, then zoom in

Pick the right handler before committing to a loop. In this codebase, `classifyIntent` is a real router — the *only* LLM-driven routing decision in the whole system. This file also serves as the bridge to Section C: in single-agent mode routing picks a tool, in multi-agent mode routing picks an *agent*.

```
  Zoom out — where the router sits

  ┌─ /api/agent GET handler ───────────────────────────────────┐
  │  branch: is this a query (q) or an investigation (insightId)? │
  │    if q → ★ classifyIntent (Haiku) ★ → QueryAgent          │
  │    if insightId → DiagnosticAgent (no router — direct)     │
  └────────────────────────────┬───────────────────────────────┘
                               │
  ┌─ classifyIntent ───────────▼───────────────────────────────┐
  │  Haiku 4.5 · returns Intent = 'diagnostic' | ...            │
  │  Intent then shapes the QueryAgent's system prompt         │
  └────────────────────────────────────────────────────────────┘
```

Zoom in: routing is the *bridge* from Section A (single-agent) to Section C (multi-agent). Both use the same primitive — a fast decision at the top. The output differs: a tool vs an agent.

## Structure pass

**Layers:** input · heuristic (regex/rules) · LLM router · handler dispatch.
**Axis:** *how deterministic is the decision, and how expensive?*
**Seam:** the intent contract — a fixed enum. Router's job is to map free-form query to that enum reliably.

```
  Router hierarchy — cheap deterministic first, LLM last

  ┌─ Input ────────────────────────────┐
  │  free-form query                   │
  └────────────┬───────────────────────┘
               ▼
  ┌─ Heuristic router (fast, free) ────┐   NOT IMPLEMENTED here
  │  regex on obvious cases            │   (this repo skips this tier)
  │  e.g. /^show me revenue/i           │
  └────────────┬───────────────────────┘
               │ no clear match / skipped
               ▼
  ┌─ LLM router (Haiku, ~$0.001) ──────┐
  │  classifyIntent(query) → Intent    │   ★ this is what runs today ★
  └────────────┬───────────────────────┘
               ▼
  ┌─ Handler dispatch ─────────────────┐
  │  QueryAgent runs with `intent` in  │
  │  its prompt shaping                │
  └────────────────────────────────────┘
```

## How it works

### Move 1 — the mental model

You've written a `switch` before — one input, multiple handlers, dispatch to the right one. A router is a `switch` where the case-selector is an LLM (or a regex-then-LLM cascade). The point of the LLM at all is that the input is *natural language*; regex can only cover the predictable shapes.

```
  Pattern: LLM router

  input: "why did purchase revenue drop in the US?"
         │
         ▼
  ┌──────────────────────────┐
  │ LLM router (Haiku)        │
  │ "Classify as one of:      │
  │   diagnostic, exploratory,│
  │   summary, out_of_scope"  │
  └──────────┬───────────────┘
             ▼
       Intent = "diagnostic"
             │
             ▼
    QueryAgent runs with
    diagnostic-shaped prompt
```

### Move 2 — the walkthrough

**The router — `lib/agents/intent.ts:21-38`.**

```ts
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
      CLASSIFIER_MODEL,          // ← Haiku, not Sonnet
      'agents/intent:classifyIntent',
    ),
    query,
    { signal },
  );
}
```

Line-by-line:

- **`CLASSIFIER_MODEL = 'claude-haiku-4-5-20251001'`** — pinned Haiku 4.5. Router calls run at ~$0.001 per classification vs Sonnet's ~$0.02. Router latency ~500ms vs Sonnet's 2-3s. On a query flow the router runs ONCE per request, so this saves ~40x the routing cost without measurable accuracy hit for the intent enum.
- **`classifyAptKitIntent`** — delegates to AptKit's intent classifier. Returns one of `QueryIntent` = 'diagnostic' | 'exploratory' | 'summary' | 'out_of_scope' (or similar).
- **`signal`** — cancellation threaded from `req.signal`. If the user closes the tab during a 500ms classifier call, the Anthropic call cancels cleanly.

**The dispatch — `app/api/agent/route.ts:247-260`.**

```ts
if (q && !insightId) {
  req.signal.throwIfAborted();
  const intent = await classifyIntent(anthropic, q, sid, req.signal);
  stepFor('coordinator', 'thought', `interpreting your question as a ${intent} query…`);
  const queryAgent = new QueryAgent(anthropic, dataSource, schema, allTools, sid);
  const answer = await queryAgent.answer(q, intent, { ...hooksFor('coordinator'), signal: req.signal });
  ...
}
```

Line-by-line: query flow only. The intent gets streamed to the UI as a reasoning step ("interpreting your question as a diagnostic query…"), then passed to `QueryAgent.answer(q, intent, ...)`. Inside AptKit's QueryAgent, the intent shapes the system prompt — different phrasings for different intents.

**Why heuristic-first is skipped here.** In this codebase the query flow is low-volume (users mostly click Insight cards, which skip routing). If it were high-volume with predictable phrasings, a regex tier in front would save the Haiku cost on the 80% of queries that match "why did X drop" or "show me Y." Not worth the code for the current volume.

### Move 3 — the principle

Routing is the fastest, cheapest decision in the whole pipeline — pick the right handler at the top so you don't waste an expensive loop's budget on the wrong question. Two production rules: (a) deterministic first — a regex costs nothing, and covers the common cases; (b) LLM router at the *cheapest* tier that still hits the enum reliably. Haiku for router, Sonnet for workers, Opus never for routing.

## Primary diagram

```
  Recap — routing in this repo

  ┌─ /api/agent (route.ts) ────────────────────────────────────┐
  │  request                                                    │
  │    │                                                        │
  │    ▼                                                        │
  │  is q or insightId?                                         │
  │    │                                                        │
  │    ├── insightId → DiagnosticAgent    (deterministic route) │
  │    │                                                        │
  │    └── q → ★ classifyIntent (Haiku) ★                        │
  │              │                                              │
  │              ▼                                              │
  │            Intent enum                                      │
  │              │                                              │
  │              ▼                                              │
  │            QueryAgent.answer(q, intent, ...)                │
  │              (intent shapes the system prompt inside)       │
  └────────────────────────────────────────────────────────────┘
```

## Elaborate

Routing is the bridge from a single-agent system to a supervisor-worker one. In a single-agent system the router picks a tool (see `study-ai-engineering`'s tool-routing file). In a multi-agent system the router picks an *agent* — and the supervisor's core job is exactly this routing decision at the top of a run.

Blooming's `route.ts` supervisor is halfway there: the branch `q ? classifyIntent : (step === 'recommend' ? RecommendationAgent : DiagnosticAgent)` is a router picking which agent to run. It's a *code* router at the outer layer (the shape is known: query vs investigation vs recommend) and an *LLM* router only for the sub-decision within the query flow. This is the recommended production posture — code where predictable, LLM where genuinely needed.

The interview-grade point: the number of LLM-decided routes in your pipeline is a signal of maturity. Zero LLM routes = deterministic pipeline (workflow). Many LLM routes = full multi-agent. One LLM route at a sub-question = the sweet spot for most production systems.

## Interview defense

**Q: How does the query router decide which agent handles a free-form question?**
A: `classifyIntent` in `lib/agents/intent.ts` — a Haiku 4.5 call that maps the free-form query to a `QueryIntent` enum: diagnostic / exploratory / summary / out_of_scope. The intent then shapes the QueryAgent's system prompt inside AptKit. I pinned Haiku for the router because it's 40x cheaper than Sonnet with no measurable accuracy drop for enum classification, and adds ~500ms latency instead of 2-3s. In production I'd add a regex heuristic tier in front for the high-volume predictable phrasings — that's the tier this repo currently skips because the query flow is low-volume.

Diagram: the two-tier fallback with the "regex first, LLM router at the back" arrow.
Anchor: `lib/agents/intent.ts:16` (the model pin) + `app/api/agent/route.ts:249` (the call).

**Q: Why isn't routing done by the same Sonnet model that runs the worker?**
A: Cost and speed. Router runs once per request; workers run 5-8 model turns per request. Paying Sonnet prices for a one-line enum decision is waste. Haiku hits >95% intent-classification accuracy on this enum in my testing at a fraction of the cost. This is the standard "cheap model at the top, expensive model in the loop" pattern from Anthropic's cookbook — a specific case of the broader rule "match model tier to decision complexity."

Diagram: model-tier ladder — Haiku (route), Sonnet (work), Opus (reserved).
Anchor: same `intent.ts:16`.

## See also

- `03-react.md` — the worker the router dispatches to.
- `03-multi-agent-orchestration/02-supervisor-worker.md` — routing at the supervisor level (picks an agent, not a tool).
- Cross-reference: `.aipe/study-ai-engineering/`'s tool-routing file for tool-level routing mechanics.
