# Heuristic-before-LLM

*Industry standard — heuristic-before-LLM routing · here: intent-layer variant*

## Zoom out — where this concept lives

The classic pattern uses a regex or rule to skip the LLM when an input is predictable. This codebase applies the pattern at a higher altitude: not skipping the LLM, but choosing between a *cheap* LLM (Haiku) for intent classification and the *expensive* LLM (Sonnet) for the actual answer. Same shape, different layer.

```
  Zoom out — heuristic-before-LLM at the intent layer

  ┌─ Browser ────────────────────────────────────────────────┐
  │  user types into QueryBox                                │
  └──────────────────────┬───────────────────────────────────┘
                         │  fetch('/api/agent?q=…')
                         ▼
  ┌─ Route (app/api/agent/route.ts:250) ─────────────────────┐
  │  ┌─ Intent classify ─────────────────────────────────┐  │
  │  │  ★ CHEAP: claude-haiku-4-5  ★                     │  │ ← we are here
  │  │  ~500 input tokens, ~10 output, ~$0.0003          │  │
  │  │  → 'monitoring' | 'diagnostic' | 'recommendation' │  │
  │  │    | 'generic'                                    │  │
  │  └──────────────────────┬────────────────────────────┘  │
  └─────────────────────────┼──────────────────────────────────┘
                            ▼  routes to the right Sonnet agent
  ┌─ ★ EXPENSIVE: claude-sonnet-4-6 ★ ───────────────────────┐
  │  the matching agent runs the full tool loop              │
  └──────────────────────────────────────────────────────────┘
```

**Zoom in.** The classifier is the only non-Sonnet call in the codebase. It exists for two reasons: pick the right downstream agent (routing), and avoid spinning up Sonnet on generic questions (cost).

## Structure pass — layers · axes · seams

**Layers:** user input → routing decision → downstream agent.

**Axis: who decides?** Classic heuristic-before-LLM has CODE (regex) decide the easy cases. This codebase has a CHEAP LLM decide the routing — but the underlying tradeoff is the same: do the cheap thing first, only spend the expensive thing when needed.

**Seam:** the `Intent` return value at `lib/agents/intent.ts:8`. Once classified, the route's switch (`leadAgent` selection at `app/api/agent/route.ts:228-229`) picks the downstream agent. The seam is small and one-directional.

## How it works

### Move 1 — the mental model

You know how a load balancer in front of expensive backends routes requests cheaply before any backend pays the cost? Intent classification is that, for LLM agents. Cheap router up front; the expensive agent only runs once we know which one should run.

```
  Cheap-first routing pattern

  user query
       │
       ▼
  ┌─ Cheap classifier ─────────────────────┐
  │  Haiku, ~500 input tokens              │  ~$0.0003 per call
  │  → fast: <500ms p50                    │
  │  → constrained output: 4-way enum       │
  └────────────┬───────────────────────────┘
               │
               ▼
        ┌──── intent ────┐
        │                │
        ▼ monitoring     ▼ diagnostic, recommendation, or generic
   MonitoringAgent   the matching Sonnet agent
   (full tool loop)  (full tool loop)
```

### Move 2 — the step-by-step walkthrough

**Part 1 — the classifier is one small file.**

`lib/agents/intent.ts` is 38 lines total. The Haiku call lives at line 16:

```typescript
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
      'coordinator',                                  // agent label for logs
      sessionId,
      CLASSIFIER_MODEL,                               // ← Haiku override
      'agents/intent:classifyIntent',                 // distinct logSite
    ),
    query,
    { signal },
  );
}
```

Two things to notice:

  → `CLASSIFIER_MODEL` is hard-coded — the classifier is contractually cheap. If you ever wanted to A/B Sonnet vs Haiku for intent, this is the seam.
  → `'agents/intent:classifyIntent'` is the distinct log site, so Vercel filters separate intent costs from agent costs cleanly.

**Part 2 — the route fires it only on the free-form path.**

The intent classifier runs only when the user supplies a free-form `q` (the chat surface), not when they click an anomaly card. From `app/api/agent/route.ts:247-253`:

```typescript
if (q && !insightId) {                                 // free-form path only
  req.signal.throwIfAborted();
  const t_intent = performance.now();
  const intent = await classifyIntent(anthropic, q, sid, req.signal);
  recordPhase('intent_classify', t_intent);            // wall-clock log
  stepFor('coordinator', 'thought', `interpreting your question as a ${intent} query…`);
  const queryAgent = new QueryAgent(anthropic, dataSource, schema, allTools, sid);
  // ... QueryAgent.answer(q, intent, hooks)
}
```

When the user clicked a card, the route already knows the agent path (diagnose, then recommend). No classify needed. When the user types a question, the classifier picks the right downstream tool surface.

**Part 3 — the parser is forgiving.**

Haiku is fast and cheap but occasionally returns text that's not a clean enum value. `parseIntent()` at `lib/agents/intent.ts:13` defends:

```typescript
export function parseIntent(raw: string): Intent {
  return parseAptKitIntent(raw);                     // defaults to 'diagnostic'
                                                      //  if no match
}
```

The default of `'diagnostic'` is deliberate: when Haiku is ambiguous, treat the query as needing investigation (the safer assumption than treating it as generic).

**Part 4 — the savings shape.**

```
  Cost shape: with vs without intent classifier

  ┌── Without classifier ──────────────────────────┐
  │  every query → query agent (Sonnet)             │
  │  generic "hi" → ~$0.005 (small Sonnet call)     │
  │  legit query → ~$0.05  (full Sonnet investigation)│
  └─────────────────────────────────────────────────┘

  ┌── With classifier ──────────────────────────────┐
  │  every query → Haiku classify (~$0.0003)        │
  │   → 'generic' → small Sonnet  (~$0.005)         │
  │   → 'monitoring' / 'diagnostic' / etc.          │
  │     → matching Sonnet agent (~$0.05)            │
  │                                                 │
  │  Marginal cost of classifier: $0.0003 per query │
  │  Marginal value: routing + safety default       │
  │  Cost saved on "generic" path: nothing — the   │
  │   savings here are routing (right agent), not  │
  │   skipping the LLM entirely                     │
  └─────────────────────────────────────────────────┘
```

Important honesty: the classifier doesn't *skip* the expensive LLM. It picks *which* expensive LLM call to make. The "cost saved" framing only applies if you compare to a baseline where the wrong agent runs first, fails, then the right agent runs as a fallback — which isn't what the without-classifier path looks like.

### Move 3 — the principle

**Use a cheap call when you need a quick decision; use the expensive call when you need the answer.** Two altitudes of the same pattern. Classic heuristic-before-LLM uses code for the decision; this codebase uses a cheap LLM. Either works as long as the cheap layer's failure modes are cheap to recover from (here: the parser defaults safely).

## Primary diagram — the full recap

```
  The intent-classifier seam end to end

  ┌─ Browser ─────────────────────────────────────────────┐
  │  QueryBox: user types "why did revenue drop in USA?"  │
  └──────────────────────┬────────────────────────────────┘
                         │  GET /api/agent?q=…
                         ▼
  ┌─ Route ───────────────────────────────────────────────┐
  │  if (q && !insightId):                                │
  │    classifyIntent(anthropic, q, sid, signal)          │
  │      → new AnthropicModelProviderAdapter(             │
  │          anthropic, 'coordinator', sid,               │
  │          CLASSIFIER_MODEL (Haiku),                    │
  │          'agents/intent:classifyIntent')              │
  │      → classifyAptKitIntent(adapter, q, { signal })   │
  │      ────────────────────────────────                 │
  │      log line: { site:'agents/intent:classifyIntent',│
  │                  sessionId, usage:{ input_tokens:~500│
  │                                     output_tokens:~10│
  │                                   } }                 │
  │                                                       │
  │    intent = 'diagnostic'                              │
  │    stepFor('coordinator', 'thought',                  │
  │      'interpreting your question as a diagnostic q…')│
  │                                                       │
  │    new QueryAgent(...).answer(q, intent, hooks)       │
  └──────────────────────┬────────────────────────────────┘
                         │  Sonnet, full tool loop
                         ▼
  ┌─ Anthropic API: Sonnet ───────────────────────────────┐
  │  the matching agent runs                              │
  └───────────────────────────────────────────────────────┘

  One Haiku call + one Sonnet investigation,
   instead of a single Sonnet call that has to
   first decide which kind of question this is.
```

## Elaborate

**Why a cheap LLM and not a regex.** Three reasons:

  1. **Intent labels need natural-language understanding.** "Show me the revenue trend" is monitoring; "why did revenue drop" is diagnostic; "what should I do about it" is recommendation. Regex on keywords would get most of these but fail on rewrites ("revenue went down" vs "revenue declined").
  2. **The intent classifier already exists in AptKit.** `classifyAptKitIntent` is a library function; this codebase pays the integration cost (the `CLASSIFIER_MODEL` override + the log site) rather than building its own classifier.
  3. **Cost is genuinely negligible.** ~$0.0003 per query is below the rate of any cost concern. The classifier saves nothing in dollars; it saves *errors* (routing to the wrong agent).

**Where this codebase doesn't apply the pattern.** Inside the monitoring agent's 6-call tool loop, every tool selection is made by Sonnet. A heuristic-before-LLM pattern *inside* the loop — for example, "if the user's anomaly is `revenue_drop`, the first tool call should be `execute_analytics_eql` with a hard-coded recipe" — isn't wired. The agent decides every tool every time.

That's a deliberate gap. The 10-category checklist + `runnableCategories()` filter at `lib/agents/categories.ts:46` is the closest analog: the *categories* are gated by rules, but the *queries within a category* are agent-decided.

## Project exercises

### Exercise — Pre-cache first-tool-call for the monitoring agent

  → **Exercise ID:** B1.7
  → **What to build:** For the monitoring agent's *first* tool call per category, skip the LLM entirely. The category's `eql(projectId)` recipe at `lib/agents/categories.ts:53` already names the canonical query. Run that query directly, hand the result to the agent as a pre-populated first `tool_result`, and let the model decide what to do from there.
  → **Why it earns its place:** cuts one full LLM call per category from the monitoring scan. With ~6 categories runnable typically, that's 6 LLM calls saved per scan — ~50% of the input cost. Same idea as the intent classifier, applied inside the agent loop.
  → **Files to touch:** `lib/agents/monitoring.ts` (pre-populate the AptKit agent's initial message history with synthetic `tool_use` + `tool_result` pairs), or extend the AptKit agent surface to accept "starter context", `test/agents/monitoring.test.ts` (assert the first LLM call sees the pre-populated context and skips the redundant query).
  → **Done when:** `usage.input_tokens` on the first model call of each category drops by the size of the pre-populated tool result while still showing a valid scan output, and an integration test confirms the EQL recipe matches what the LLM would have called anyway.
  → **Estimated effort:** 1–2 days.

## Interview defense

**Q: "Why do you have a Haiku call in front of your Sonnet agents?"**

Two reasons, both at the *intent* layer. First, routing: the user's free-form question could be a monitoring question, a diagnostic, a recommendation, or generic. Haiku picks the right downstream agent at ~$0.0003 per call. Second, structural safety: the parser defaults to `'diagnostic'` if Haiku returns ambiguous output, so even a misclassification routes to a safe agent that can investigate.

The classifier doesn't *skip* an expensive LLM — it picks *which* expensive LLM. The cost framing is honest about that.

*Anchor: "Cheap router up front; expensive agent only runs once we know which one should run. `lib/agents/intent.ts:16`."*

**Q: "When would you push more rules in front of the LLM?"**

When two conditions are true: the rule's hit rate is high (covers >50% of cases), and the rule's failure mode is cheap to recover from. The first-tool-call-per-monitoring-category exercise hits both — the category's `eql()` recipe is the right query 90%+ of the time, and the fallback (let the agent override) is exactly what would have happened without the pre-cache.

*Anchor: "High-coverage, cheap-recovery rule → push in front of the LLM. Otherwise let the agent decide."*

## See also

  → `04-agents-and-tool-use/04-tool-routing.md` — the broader tool-routing story this slots into
  → `06-production-serving/02-llm-cost-optimization.md` — the cost-optimization framing this contributes to
  → `01-what-an-llm-is.md` — the function this pattern decides whether to invoke
