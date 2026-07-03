# Routing

*Industry names: intent routing / semantic router · Language-agnostic*

## Zoom out

```
  Zoom out — routing picks the right handler BEFORE committing to a loop

  ┌─ UI ──────────────────────────────────┐
  │  QueryBox: "why did revenue drop?"     │
  └───────────────────┬───────────────────┘
                      │ /api/agent?q=…
  ┌─ Route ──────────▼────────────────────┐
  │  ★ ROUTING (classifyIntent) ★         │ ← we are here
  │  → Intent = 'diagnostic'              │
  └───────────────────┬───────────────────┘
                      ▼
  ┌─ Worker ───────────────────────────────┐
  │  QueryAgent with diagnostic tuning     │
  └────────────────────────────────────────┘
```

## Zoom in

Pick the right handler before committing to a loop. In this repo, `classifyIntent(anthropic, q)` in `lib/agents/intent.ts` uses Haiku 4.5 to classify a free-form query into an `Intent` — the QueryAgent then tunes its prompt to that intent. This is the pattern that bridges from single-agent (routing to a tool) to multi-agent (routing to an agent).

## Structure pass

Layers: **heuristic router** (deterministic, fast) — **LLM router** (fallback for ambiguity) — **handler** (the tool, agent, or chain that runs).

Axis to hold constant: **who decides which handler to run?**

```
  Routing — where the decision lives

  ┌─ heuristic router ──────────┐   ← rules / regex / exact match
  │  fast, deterministic         │      (deterministic — code decides)
  └────────┬────────────────────┘
           │ no clear match
           ▼
  ┌─ LLM router ────────────────┐   ← classify intent, pick handler
  │  Haiku call, ~50-100ms       │      (LLM decides — cheap and fast)
  └────────┬────────────────────┘
           │
           ▼
  ┌─ handler ───────────────────┐   ← the tool / agent / chain
  │  what actually runs          │      picked by the router
  └─────────────────────────────┘
```

## How it works

### Move 1 — the shape

You've written a React router before — the URL path picks the component. Same instinct here: the "URL" is the query intent, the "component" is the agent tuned to that intent.

### Move 2 — the routing this repo actually does

**The LLM router.** Open `lib/agents/intent.ts`:

```ts
// lib/agents/intent.ts (LLM router)
const CLASSIFIER_MODEL = 'claude-haiku-4-5-20251001';

export async function classifyIntent(
  anthropic: Anthropic,
  query: string,
  sessionId?: string,
  signal?: AbortSignal,
): Promise<Intent> {
  return classifyAptKitIntent(
    new AnthropicModelProviderAdapter(anthropic, 'coordinator', sessionId,
      CLASSIFIER_MODEL, 'agents/intent:classifyIntent'),
    query,
    { signal },
  );
}
```

The choice of Haiku is deliberate — classification is a cheap task; using Sonnet would 5x the cost with no accuracy gain on a well-bounded label set (`diagnostic` | `monitoring` | `recommendation`). This is the "expensive supervisor, cheap workers" rule (`03-multi-agent-orchestration/09-coordination-failure-modes.md`) applied in the small: expensive for hard decisions, cheap for routing.

**Where the intent is used.** In `app/api/agent/route.ts:255`:

```ts
const intent = await classifyIntent(anthropic, q, sid, req.signal);
stepFor('coordinator', 'thought', `interpreting your question as a ${intent} query…`);
const queryAgent = new QueryAgent(anthropic, dataSource, schema, allTools, sid);
```

The QueryAgent then shapes its behavior around the intent — different system prompts, different tool-selection preferences. This is routing at the *prompt-shaping* level, not the *agent-picking* level. But the pattern is the same.

**Where routing would be an agent-picker.** Two hypothetical extensions:

1. **The Q&A path could route to different agents.** Instead of one QueryAgent that adapts, three specialized agents: a MonitoringQueryAgent, a DiagnosticQueryAgent, a RecommendationQueryAgent. The router (classifyIntent) picks one. Trade-off: simpler prompts per agent, more code to maintain.
2. **The whole product could have an LLM supervisor route the stages.** Instead of the code sequence `monitor → diagnose → recommend`, an LLM supervisor could decide "this anomaly might need re-monitoring before diagnosis." That's the escalation from code-routed supervisor to LLM-routed supervisor (see `00-overview.md`'s comparison). For this product, not worth it — the stages are stable.

**The heuristic-first pattern for the production version.** Real production routing is heuristic at the front, LLM at the back:

```
  Production routing — layered

  request
    │
    ▼
  ┌─ heuristic router ──────────────────────┐
  │  if query starts with "why " → diagnostic│  ← 60% traffic
  │  if query starts with "what" → query     │  ← 25% traffic
  │  else → LLM router                       │  ← 15% traffic
  └────────────────┬────────────────────────┘
                   │ (only 15% needs LLM)
                   ▼
  ┌─ LLM router (Haiku) ────────────────────┐
  │  classify into: diagnostic | monitoring | │
  │  recommendation                          │
  └────────────────┬────────────────────────┘
                   ▼
              QueryAgent(intent)
```

This repo skips the heuristic layer because query volume is low (portfolio project, no cost pressure yet) and Haiku is cheap enough. If traffic scaled up, adding regex/keyword heuristics in front would cut 60-80% of Haiku calls with no quality loss on the predictable routes.

### Move 3 — the principle

Routing is the bridge from SECTION A to SECTION C: in a single-agent system it picks a tool; in a multi-agent system the same pattern picks which agent handles the request (the supervisor's core job). Production routing is layered — deterministic front, LLM back — so the LLM only sees the ambiguous cases.

## Primary diagram

```
  Routing — the pattern in this repo, and where it would scale

  ┌─ Client (browser) ─────────────────────────────┐
  │  QueryBox → fetch('/api/agent?q=…')            │
  └─────────────────────┬──────────────────────────┘
                        │
  ┌─ Route: app/api/agent/route.ts ────────────────┐
  │                                                │
  │  ┌── (future) heuristic router ─────────────┐  │
  │  │  regex / keyword match                    │  │  ← would cut
  │  │  → intent (fast path)                     │  │    Haiku calls
  │  └──────────────────┬───────────────────────┘  │
  │                     │ no match                 │
  │                     ▼                          │
  │  ┌── classifyIntent (Haiku 4.5) ────────────┐  │
  │  │  lib/agents/intent.ts                    │  │
  │  │  → Intent = diagnostic|monitoring|recomm.│  │
  │  └──────────────────┬───────────────────────┘  │
  │                     │                          │
  │                     ▼                          │
  │  ┌── QueryAgent(intent) ────────────────────┐  │
  │  │  ReAct loop, prompt tuned by intent      │  │
  │  └──────────────────────────────────────────┘  │
  └────────────────────────────────────────────────┘
```

## Elaborate

The router pattern is old — early NLP pipelines used intent classifiers before neural models (Dialogflow, Rasa, Alexa's ASK). LLM-based routing is the same shape at a higher accuracy ceiling. The current state of the art has three variants:

- **Zero-shot classifier** (this repo — Haiku with a prompt describing the intent set).
- **Embedding-based semantic router** (embed the query, cosine-sim against labeled prototype queries — no LLM per request, cheaper at scale). LangChain's `semantic-router` package is the reference implementation.
- **Fine-tuned classifier** (a small model fine-tuned on labeled examples — cheapest per call but requires training data).

For this repo's traffic volume, zero-shot with Haiku is correct. For a production system serving 1M+ requests/day, the semantic-router variant becomes worth the setup cost.

The related pattern is **retrieval routing** — routing a query to the right knowledge source (vector DB vs SQL vs web search). See `02-agentic-retrieval/03-retrieval-routing.md`.

## Interview defense

**Q: How do you route free-form questions to the right agent?**

Haiku 4.5 classifier as an intent router — `lib/agents/intent.ts` — classifies into `diagnostic | monitoring | recommendation`. The QueryAgent then shapes its behavior around the intent. I picked Haiku because classification is a cheap task; Sonnet would 5x the cost for no accuracy gain on this label set.

The pattern I didn't ship yet is heuristic-first — for high-volume predictable routes, regex/keyword rules in front would cut 60-80% of Haiku calls with no quality loss. Skipped it because query volume is low today and the Haiku bill is negligible; if traffic scaled, that's the next lever.

*Anchor visual:* the two-layer heuristic-then-LLM diagram above.

**Q: How does this scale to multi-agent routing?**

Same pattern, different target. Today, routing picks a tuning for one QueryAgent. In a multi-agent supervisor system, the same classifier picks *which agent* runs. The trade-off then becomes: do you want the router LLM to be the supervisor (LLM-routed), or is the router just picking from a fixed set of code-routed sequences? For this product, I'd stay code-routed — the three stages are stable enough that adding an LLM supervisor buys nothing and costs ~$0.05 per decision.

## See also

- **`02-agentic-retrieval/03-retrieval-routing.md`** — routing at the retrieval layer.
- **`03-multi-agent-orchestration/02-supervisor-worker.md`** — routing is the supervisor's core job in this topology.
- **`.aipe/study-ai-engineering/04-agents-and-tool-use/04-tool-routing.md`** — tool-routing mechanics inside a single agent.
