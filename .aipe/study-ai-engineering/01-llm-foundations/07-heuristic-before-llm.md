# Heuristic before LLM

## Subtitle

Fast-path routing / two-stage classification — Industry standard.

## Zoom out, then zoom in

Not every user query needs the full agent loop. When a user types into the QueryBox, the codebase runs a **cheap classifier first** (Haiku 4.5, one shot, ~500 input tokens, $0.0005/call), then only calls the expensive agent path if the intent warrants it. The classifier is one layer above the agents; the *schema coverage gate* is another. Both are "heuristic before LLM" applied at different granularities.

```
  Zoom out — two heuristic gates before expensive LLM work

  ┌─ UI ────────────────────────────────────────────────┐
  │  QueryBox                                            │
  └───────────────────────┬──────────────────────────────┘
                          │  free-form text
                          ▼
  ┌─ Route ────────────────────────────────────────────┐
  │  Gate 1 (cheap):  classifyIntent (Haiku)            │ ← LLM but small
  │  Gate 2 (rules):  runnableCategories(schema)        │ ← pure code
  └───────────────────────┬──────────────────────────────┘
                          │  only if intent + coverage pass
                          ▼
  ┌─ Agent (expensive) ────────────────────────────────┐
  │  Sonnet 4.6, multi-turn, tool-using                 │
  └────────────────────────────────────────────────────┘
```

Zoom in: at every layer, the codebase asks "can we answer this with less?" before spending on more. The intent classifier is heuristic-before-LLM applied to *routing*. The coverage gate is applied to *tool selection*.

## Structure pass

- **Layers:** UI → route → cheap gate → expensive gate → agent. Five bands.
- **Axis: cost per gate.** UI: free. Route: free. Cheap gate: $0.0005/call. Expensive agent: $0.09/call. Order matters — you gate cheapest-first.
- **Seams:** `classifyIntent()` (LLM classifier) and `runnableCategories()` (pure function). Both filter; both are cheap-relative-to-the-agent.

## How it works

### Move 1 — the mental model

The pattern has two shapes in this codebase.

**Shape A — cheap LLM classifier.** For the QueryBox, the intent isn't obvious from surface form ("what happened to conversions last week" vs "recommend an experiment" vs "explain this chart"). A rules-based router would need N regex patterns and would drift. A cheap LLM classifier (Haiku, $0.0005) picks the right agent tier.

**Shape B — pure-code coverage gate.** For the monitoring scan, some anomaly categories require tools or event streams the workspace doesn't have. Running the agent to discover it can't answer is wasteful. `runnableCategories()` in `lib/agents/categories.ts` filters *before* the agent runs.

```
  The pattern — two shapes of the same idea

  Input
    │
    ▼
  ┌───────────────────────┐
  │  cheap gate           │  free (rules) or nearly free (Haiku)
  │  can we skip / route  │
  │  the expensive path?  │
  └───────────┬───────────┘
              │
       ┌──────┴──────┐
       │             │
       ▼ yes         ▼ no / needs it
   short-circuit   expensive agent path
   (return early)  (Sonnet, tools, loop)
```

### Move 2 — the step-by-step walkthrough

**The intent classifier.** `lib/agents/intent.ts:19` — one function, `classifyIntent(anthropic, query, sessionId, signal)`. It calls into aptkit's `classifyAptKitIntent`, which uses Haiku 4.5, returns a `QueryIntent` label:

```ts
// lib/agents/intent.ts:16
const CLASSIFIER_MODEL = 'claude-haiku-4-5-20251001';

export async function classifyIntent(
  anthropic: Anthropic, query: string, sessionId?: string, signal?: AbortSignal,
): Promise<Intent> {
  return classifyAptKitIntent(
    new AnthropicModelProviderAdapter(anthropic, 'coordinator', sessionId,
      CLASSIFIER_MODEL, 'agents/intent:classifyIntent'),
    query, { signal },
  );
}
```

Two things to notice: (1) same `AnthropicModelProviderAdapter` as the expensive agents — the provider abstraction is uniform. (2) `parseIntent()` in `lib/agents/intent.ts:11` defaults to `'diagnostic'` when the model returns garbage; the default is the safest agent to reach for.

**The coverage gate.** `lib/agents/categories.ts:26-27` — `coverageFor()` and `runnableCategories()`:

```ts
// lib/agents/categories.ts (schemaCapabilities + runnableCategories from aptkit)
// runnableCategories(schema): AnomalyCategory[] returns only categories
// whose `requires` list is entirely present in the workspace's schemaCapabilities.
```

Categories with `requires: ["purchase", "checkout"]` filter through only if the workspace exposes both events. This is pure code — a set intersection — running before the monitoring agent starts. It's exactly the "regex prefix" version of heuristic-before-LLM, applied to tool availability instead of user input.

**Where the fast-path win shows up.** In the monitoring briefing, roughly 3–5 of the 12 defined ecommerce categories get gated out for a partially-schema'd workspace. The agent doesn't waste tool calls looking for `payment_failure_rate` when the schema doesn't have `payment_failure` events.

Execution trace of a query flowing through both gates:

```
  Query flow — two gates

  user types: "why did revenue drop last week"
    │
    ▼
  classifyIntent → "diagnostic"   ← Haiku, ~200ms, $0.0005
    │
    ▼
  route branch on intent:
    · "diagnostic" → construct DiagnosticAgent
    · "chat" → construct QueryAgent
    · other → error path
    │
    ▼
  DiagnosticAgent.investigate:
    │
    ▼
  agent picks tools; runnableCategories already filtered
  the schema down to what's answerable
    │
    ▼
  ~10 Sonnet turns, ~$0.09
```

### Move 3 — the principle

Route on cost gradient. Start with free rules. Move to cheap LLM classifiers only when rules don't suffice. Move to expensive agent loops only when the classifier says "yes, this needs it." The wrong order — running the expensive path first and short-circuiting later — is the default trap because it feels simpler.

## Primary diagram

```
  Heuristic-before-LLM in this codebase — full frame

  ┌─ UI: QueryBox or briefing trigger ─────────────────────┐
  │                                                        │
  └──────────────────────┬─────────────────────────────────┘
                         │
                         ▼
  ┌─ Gate 1 (route level) ─────────────────────────────────┐
  │  QueryBox → classifyIntent()  ← Haiku, $0.0005          │
  │    lib/agents/intent.ts:19                              │
  │  Briefing → runnableCategories(schema)  ← pure code     │
  │    lib/agents/categories.ts                             │
  └──────────────────────┬─────────────────────────────────┘
                         │  survivors of the gate
                         ▼
  ┌─ Gate 2 (per-agent) ───────────────────────────────────┐
  │  DiagnosticAgent picks tools via filterToolSchemas()    │
  │    lib/agents/tool-schemas.ts:9                         │
  │  (filters MCP tools down to agent-relevant subset)      │
  └──────────────────────┬─────────────────────────────────┘
                         │
                         ▼
  ┌─ Expensive path ───────────────────────────────────────┐
  │  Sonnet 4.6 multi-turn agent loop                       │
  │  ~$0.09/case observed                                   │
  └────────────────────────────────────────────────────────┘
```

## Elaborate

The classic version of this pattern is a regex prefix check ("if the input starts with `/` treat it as a command"). This codebase runs a fancier variant because the input surface (free text) makes regex brittle. But the shape is the same: cheap gate → expensive path, with the option of the cheap gate short-circuiting.

Drift is the risk. When the input distribution shifts (users start asking things the classifier hasn't seen), the classifier's accuracy drops silently. Mitigations: log the classifier's outputs, occasionally spot-check against the agent's expensive answer, retrain / re-prompt on drift. This codebase doesn't yet log intent-classifier decisions (a gap).

Related: **05-evals-and-observability/01-eval-set-types.md** (an intent-classifier golden set would catch drift). **04-agents-and-tool-use/04-tool-routing.md** (the tool-level version of this pattern).

## Project exercises

### B1.7 · Log intent classifier decisions and add a golden set

- **Exercise ID:** B1.7
- **What to build:** Wire `classifyIntent()` output into the receipts pipeline so every classifier call becomes a receipt row (`{query, predictedIntent, expensivePathTaken, actualDiagnosis?}`). Then curate 20 QueryBox-style queries with hand-labeled intents as a golden set.
- **Why it earns its place:** Closes the "we can detect drift" loop. Right now the cheap gate is unmeasured; adding the receipt + golden pair makes it a real production surface.
- **Files to touch:** `lib/agents/intent.ts` (log receipt row), `app/api/agent/route.ts` (thread the log), new `eval/intent-goldens/`, extend `eval/run.eval.ts` to score classifier accuracy.
- **Done when:** the golden set runs alongside the existing 10-case eval; per-intent precision/recall show up in the report.
- **Estimated effort:** `1–2 days`.

## Interview defense

**Q: Why not just use the expensive agent for everything?**

Cost. A diagnostic run at ~$0.09 × 10k invocations/month = $900/month; the same volume at Haiku-classifier + selective routing is ~$50/month for the classifier + $900 × (proportion that actually need it) for the agent. If half of QueryBox traffic is out-of-scope or trivially answerable ("what's the total customer count?" — no agent needed), the cheap gate saves half the agent cost. Load-bearing: measuring the routing hit rate so you know the savings are real.

**Q: What happens when the Haiku classifier is wrong?**

Two failure modes. (1) It says "diagnostic" when it should have said "chat" — the expensive agent runs, over-spends but gets an answer. Cost mistake, not a correctness mistake. (2) It says "chat" when it should have said "diagnostic" — the QueryAgent tries to answer without the full investigation tools, may return a shallow answer. Correctness mistake, worse. Mitigation: `parseIntent()` biases to `'diagnostic'` on unparseable output (`lib/agents/intent.ts:11`), and the intent-golden exercise (`B1.7`) would surface the confusion matrix.

## See also

- [../04-agents-and-tool-use/04-tool-routing.md](../04-agents-and-tool-use/04-tool-routing.md) — the same idea at the tool level.
- [../05-evals-and-observability/01-eval-set-types.md](../05-evals-and-observability/01-eval-set-types.md) — the golden-set pattern that would keep the classifier honest.
- [06-token-economics.md](06-token-economics.md) — the numbers behind the "save 5×" claim.
