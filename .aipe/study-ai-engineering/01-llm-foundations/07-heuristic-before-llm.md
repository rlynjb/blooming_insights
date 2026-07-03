# 07 — Heuristic-before-LLM

**Type:** Industry standard. Also called: rule-then-model, tiered classification, cheap-path routing.

## Zoom out, then zoom in

The routing pattern that skips the expensive model when a cheap rule can decide. This repo exercises the SHAPE (a cheap cheap-model classifier that routes to an expensive one) but not the strictest version (regex-then-LLM).

```
  Zoom out — the routing seam in this repo

  ┌─ Query input (free-form user text) ───────────────────────────────┐
  └─────────────────────────────┬─────────────────────────────────────┘
                                │
  ┌─ Intent classifier (Haiku 4.5, cheap) ─────────────────────────────┐
  │  classifyIntent(anthropic, query, sessionId)                       │
  │  ★ PARTIALLY THIS CONCEPT ★  — cheap-LLM, not regex                │
  └────────────────┬──────────────────────────┬────────────────────────┘
                   │                          │
                   ▼                          ▼
        ┌─────────────────┐        ┌─────────────────┐
        │  Diagnostic     │        │  Query          │
        │  agent (Sonnet) │        │  agent (Sonnet) │
        │  expensive path │        │  expensive path │
        └─────────────────┘        └─────────────────┘
```

Zoom in. The full heuristic-before-LLM pattern has two tiers below the expensive model: a deterministic rule (regex, keyword match) that resolves obvious cases, THEN a cheap-LLM fallback for ambiguous ones, THEN the expensive LLM for the remaining hard cases. In this codebase we skip the first tier — go straight to a cheap LLM (Haiku) to classify intent, then route to the expensive agent. That's a partial version of the pattern; the Case B exercise below adds the missing tier.

## Structure pass

**Layers:**
- Outer: reader input (free-form query)
- Middle: intent classification (currently Haiku)
- Inner: destination agent (Sonnet-powered)

**Axis: cost per decision.**
- Regex layer (missing): ~free, milliseconds
- Haiku classify: ~$0.0001-0.0005, ~1s
- Sonnet agent: ~$0.05, ~50-100s

**Seam:** `classifyIntent` returns an `Intent`; the route handler switches on it. Above the seam, callers pass in free-form text; below, the destination-agent code takes over.

## How it works

### Move 1 — the mental model

You've written a route handler that checks `if (path.startsWith('/api/'))` before doing something heavier. Same shape: cheap check first, expensive work only when needed. The LLM is the "expensive work"; the check is what you can decide without asking it.

```
  Tiered classification — cheap deciders first

  input
    │
    ▼
  ┌────────────┐  match?   ┌─────────────┐
  │ regex/rule │──────yes──►│ return direct│  ← ~0 cost
  └─────┬──────┘            └─────────────┘
        │ no
        ▼
  ┌────────────┐  confident? ┌────────────┐
  │ cheap LLM  │───────yes──►│ return     │  ← ~$0.0001
  │ (Haiku)    │             │            │
  └─────┬──────┘             └────────────┘
        │ unsure
        ▼
  ┌────────────┐
  │ expensive  │  ~ $0.05
  │ (Sonnet)   │
  └────────────┘
```

### Move 2 — walk the mechanism

**What this repo has today.**

The intent classifier at `lib/agents/intent.ts:21-38`. Anthropic Haiku 4.5 classifies a free-form query into an `Intent` before the request routes to the diagnostic or query agent.

```typescript
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
      CLASSIFIER_MODEL,               // ← Haiku, not Sonnet
      'agents/intent:classifyIntent',
    ),
    query,
    { signal },
  );
}
```

The Haiku pass is ~5× cheaper than Sonnet on input, ~3× cheaper on output, and much faster (Haiku 4.5 is roughly 2-3× throughput of Sonnet). For a one-turn classification with a short prompt, that's ~$0.0001-0.0005 per call vs Sonnet's ~$0.001-0.005 per equivalent call.

**What the strictest pattern would add — a regex tier.**

Many queries have obvious hints. A message like "why did conversion drop?" contains "why" and a metric name — high-confidence signal for the diagnostic route. A message like "how do I set up a scenario?" contains "how" + a Bloomreach feature — high-confidence signal for the query route. A regex/keyword tier could resolve maybe 40-70% of queries at zero LLM cost, leaving Haiku only for the ambiguous "the numbers look weird lately" cases.

**Why we don't have that tier today.**

Honest answer: query volume is low (this is a demo app, not production traffic), so the Haiku cost is negligible. Adding the regex tier is Case B — a next-step exercise, not a current-state limitation. The pattern SHAPE (cheap-first, expensive-fallback) is exercised; the strictest form is not.

**The measured drift risk.**

Heuristics rot. If we DID have a regex tier and the query patterns shifted (users adopt slang, new feature vocabulary), the regex would silently over-classify to one branch. Mitigation from the spec: log every heuristic-routed case, occasionally sample it through the LLM to detect drift. This codebase already logs every classification via `AnthropicModelProviderAdapter`'s per-call log — extending that to a heuristic tier would be trivial.

### Move 3 — the principle

Route by cost. Deterministic rules are ~free, cheap models are almost free, expensive models are the resource to conserve. Structure your classification tiers so each layer only sees inputs the layer above couldn't resolve. The failure mode of skipping tiers isn't wrong output — it's paying 10× more than you had to for the same decision.

## Primary diagram

The routing pipeline this repo has, and the tier it's missing.

```
  Current state (missing regex tier)

  free-form user query
         │
         ▼
  ┌─────────────────────────┐
  │ classifyIntent (Haiku)  │  every query hits this
  │ ~$0.0001-$0.0005/call   │  ~1s
  └─────────┬───────────────┘
            │
       ┌────┴────┐
       ▼         ▼
  Diagnostic   Query
  agent        agent
  (Sonnet)     (Sonnet)


  Case B target (heuristic tier added)

  free-form user query
         │
         ▼
  ┌─────────────────────────┐
  │ regex/keyword rules     │  ~40-70% resolved here
  │ ~0 cost, ~1ms           │  logged for drift check
  └─────┬───────────────────┘
        │ ambiguous?
        ▼
  ┌─────────────────────────┐
  │ classifyIntent (Haiku)  │  only ambiguous cases
  └─────────┬───────────────┘
            │
            ▼
       agent switch
```

## Elaborate

The strictest deployment of this pattern combines the regex tier with an ONLINE-DRIFT-CHECK — take 1-5% of heuristic-routed cases, ALSO run them through the LLM, compare. If the LLM disagrees on more than X% of samples, alert. This is anomaly detection on your router's decision distribution, and it prevents the failure mode where the regex silently mis-classifies a growing chunk of traffic while looking fine on the pass rate.

Related industry patterns: intent classification with a lightweight fine-tuned model (BERT-scale, not LLM); routing agents with tool calls where the tool is "classify_intent"; and the "cascading models" literature (small → medium → large, gated by confidence at each step). The heuristic-before-LLM pattern here is the simplest form of that cascade.

## Project exercises

### Exercise — add the regex tier

- **Exercise ID:** C1.7-B · Case B (pattern partially present; strictest tier missing).
- **What to build:** a small `heuristicIntent(query: string): Intent | null` in `lib/agents/intent.ts` that returns a confident `Intent` when the query matches known patterns (contains a metric name + "why/dropped/spike" → diagnostic; contains "how/set up" + a bloomreachFeature name → query; else null). Wire it BEFORE `classifyIntent` in the route handler. Log every routed decision with `{decidedBy: 'heuristic' | 'llm', intent, query}`.
- **Why it earns its place:** the strictest form of a routing pattern this repo already partially exercises. Interviewer signal: "I know the cheap path; here's how I extended it to cheaper, with logging so I can measure how often the cheap path actually decides."
- **Files to touch:** `lib/agents/intent.ts` (add heuristic layer), `app/api/agent/route.ts` (call heuristic first), `__tests__/intent.test.ts` (test both tiers).
- **Done when:** running the query endpoint against 10 canonical queries logs `decidedBy: 'heuristic'` on at least 7/10, and drops the Haiku classifier's call count proportionally.
- **Estimated effort:** <1hr for a first cut; 1-4hr with tests and logging.

## Interview defense

**Q: Why is the intent classifier a Haiku call and not a regex?**

Because query volume is low and I haven't measured the Haiku cost as material. The pattern SHAPE — cheap-first, expensive-fallback — is exercised: I don't use Sonnet for intent classification, I use Haiku, which is ~5× cheaper on input. The strictest form would add a regex tier BEFORE Haiku for obvious queries. That's a next-step exercise. Both tiers use the same principle: don't pay for what a cheaper layer could decide.

```
  today:       [Haiku classify] → agent
  strictest:   [regex] → [Haiku] → agent
                 ~70% here, rest fall through
```

**Q: How would you know if a regex tier was over-classifying?**

Sample. Take 1-5% of regex-routed queries, ALSO run them through Haiku, compare intents. If the disagreement rate on a rolling 100-sample window exceeds a threshold (say 10%), alert. That's drift detection on your router. The heuristic-before-LLM pattern's known failure mode is silent misrouting when input patterns shift — the shadow sample is the check.

**Q: Where else does this pattern show up?**

Any tiered classification: cheap-then-expensive is the same shape as CDN cache-then-origin, memoization-then-recompute, in-memory-cache-then-DB. LLM cost just makes the multiplier bigger — the difference between the cheap and expensive path is 10-100×, not 2-5×, so the incentive to tier is stronger.

## See also

- `06-production-serving/02-llm-cost-optimization.md` — the Haiku/Sonnet cost split
- `04-agents-and-tool-use/04-tool-routing.md` — a related routing decision inside an agent loop
- `lib/agents/intent.ts` — the current cheap-LLM tier
