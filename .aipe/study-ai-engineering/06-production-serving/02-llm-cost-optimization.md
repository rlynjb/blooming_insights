# 02 — LLM cost optimization

**Subtitle:** Model routing + caching + batching · Industry standard (partial)

## Zoom out, then zoom in

**Partially exercised.** One model-routing move is in place: intent
classification uses `claude-haiku-4-5` (~10x cheaper than sonnet). The
*next* model-routing opportunity — running early diagnostic turns on
haiku and only synthesis on sonnet — isn't built yet.

```
  Zoom out — cost optimization is a stack of levers

  ┌─ Patterns ──────────────────────────────────────┐
  │  prompt caching (06-01)                         │  ← Case B
  │  model routing (THIS FILE)                      │  ← partial
  │  truncation + shorter prompts                   │  ← present
  │  batch processing                               │  ← Case B (low value here)
  │  cheaper embeddings (if RAG)                    │  ← Case B (no RAG)
  └─────────────────────────────────────────────────┘
```

## Structure pass

  → **One axis to trace — quality vs cost.** Cheaper models save money
    but produce lower-quality outputs. Model routing is the discipline
    of "use the cheap model when it's good enough, fall back to the
    expensive one when it isn't."

## How it works

### Move 1 — the mental model

```
  Routing pattern: cheap-first, expensive-second

   request
     │
     ▼
  ┌─ cheap model attempt ─┐  ← haiku or gpt-4o-mini
  │  (90% of cases work)   │
  └─────────┬──────────────┘
            │
       ┌────┴────┐
       │ good    │
       │ enough? │
       └────┬────┘
            │
       ┌────┴─────┐
       │          │
       ▼ yes      ▼ no
   return     ┌─ expensive model fallback ─┐
              │  (sonnet, gpt-4)            │
              └─────────────────────────────┘
```

### Move 2 — the step-by-step walkthrough

**Already in place: intent classifier on haiku.** `lib/agents/intent.ts:16`
defines:

```typescript
const CLASSIFIER_MODEL = 'claude-haiku-4-5-20251001';
```

The classifier is constructed with this model passed to the adapter
(`lib/agents/intent.ts:27-34`):

```typescript
return classifyAptKitIntent(
  new AnthropicModelProviderAdapter(
    anthropic,
    'coordinator',
    sessionId,
    CLASSIFIER_MODEL,                    // ← haiku, not sonnet
    'agents/intent:classifyIntent',
  ),
  query,
  { signal },
);
```

  → **Why this works.** Intent classification is a one-shot, no-tools,
    ~500 tokens-in / ~50 tokens-out task. Haiku 4.5 handles it well;
    sonnet would be overkill at 10x the cost.

  → **The cost difference per classify.** Haiku ~$0.0003 vs sonnet
    ~$0.003. At 1000 classifies/day, that's ~$2.70 vs ~$27 — meaningful
    if free-form queries become common.

**Not yet built: per-turn model routing within agent loops.** AptKit's
agent classes accept a single `model` provider. To run *some* turns on
haiku and *others* on sonnet, you'd need:

  1. AptKit upstream to accept a `model` per call (not per agent), OR
  2. Blooming to subclass / wrap AptKit's agent and swap providers
     mid-loop.

The natural place for this in blooming insights:

  → **Diagnostic loop turns 1-3** (exploration — running tool calls,
    not synthesizing) → haiku is enough.
  → **Diagnostic loop turn 4+ or synthesis turn** (final JSON
    diagnosis) → sonnet for quality.

If the model-routing exercise from `01-llm-foundations/08-provider-abstraction.md`
landed, you could also route across providers (e.g. gpt-4o-mini for
intent, claude-sonnet for diagnostic).

**Other levers, ranked by current applicability:**

  → **Truncation (present).** `schemaSummary()` trims the schema from
    ~30k tokens to ~1.5k. See `01-llm-foundations/02-tokenization.md`.
    The biggest savings already in place.

  → **Prompt caching (Case B).** `06-production-serving/01-llm-caching.md`
    — biggest remaining lever.

  → **Batch processing (Case B).** Anthropic's Message Batches API lets
    you submit N requests and get results within 24 hours at 50%
    discount. Useful for offline workloads (running evals on a golden
    set overnight). Not useful for live agent loops where users are
    waiting.

  → **Smaller embeddings.** N/A — there's no RAG.

  → **Lower `max_tokens`.** Currently `4096`. The diagnostic agent's
    synthesis turn typically emits ~1000-2000 tokens. Lowering
    `max_tokens` to ~3000 wouldn't change behavior; the truncation
    bound on output isn't currently binding.

### Move 3 — the principle

**Match model to task. The intent classifier proves the pattern works —
haiku for triage, sonnet for synthesis. The natural extension is to
push it INSIDE the agent loop: cheap models for exploration turns,
expensive ones for final synthesis. The blocker is AptKit's per-agent
(not per-turn) model selection.**

## Primary diagram

```
  Cost optimization stack — what's done, what's next

  ┌─ Already in place ──────────────────────────────┐
  │  ✓ haiku for intent classify (~10x cheaper)    │
  │  ✓ schemaSummary truncation (~20x cheaper)     │
  │  ✓ per-agent tool allowlists (smaller tool defs)│
  │  ✓ hard tool-call caps in prompts (6 / 4)       │
  └─────────────────────────────────────────────────┘

  ┌─ Next levers ───────────────────────────────────┐
  │  □ Anthropic prompt caching (06-01) — ~20% loop │
  │  □ per-turn model routing (haiku→sonnet)       │
  │  □ batch API for eval / offline                 │
  └─────────────────────────────────────────────────┘
```

## Elaborate

The "cheap model for triage, expensive model for synthesis" pattern is
widely used (it's how Cursor and Copilot route between fast small
models for autocomplete and slower large models for chat). For agent
loops specifically, the literature shows haiku-class models can handle
~70-80% of tool-routing decisions just as well as sonnet-class — the
quality drop shows up in synthesis (the final answer prose).

The decision to keep model routing per-AGENT today (haiku for intent,
sonnet for everything else) rather than per-TURN reflects implementation
cost — AptKit doesn't expose per-turn model selection. The exercise
below names the upstream change.

## Project exercises

### Exercise — per-turn model routing in the diagnostic loop

  → **Exercise ID:** `study-ai-eng-06-02.1`
  → **What to build:** Upstream PR to `@rlynjb/aptkit-core` to expose a
    `modelSelector(turn, context) -> ModelProvider` option on
    `DiagnosticInvestigationAgent`. Downstream: `DiagnosticAgent.investigate`
    passes a selector that returns the haiku adapter for turns 1-3 and
    the sonnet adapter for turn 4+. Measure cost reduction over a
    golden-set eval run.
  → **Why it earns its place:** Demonstrates "I know when model
    routing is worth the implementation cost." Real cost reduction
    (~30-40% per investigation if 5/6 turns can use haiku).
  → **Files to touch:** AptKit core (upstream),
    `lib/agents/diagnostic.ts:35-44` (construct two adapters, pass
    selector), `package.json` (bump aptkit version),
    `test/agents/diagnostic.test.ts`.
  → **Done when:** A live investigation runs first 3 turns on haiku,
    last 3 on sonnet (verified via the `model` field in
    `response.usage` logs); golden-set eval quality stays within 5%
    of all-sonnet baseline.
  → **Estimated effort:** `≥1 week`

### Exercise — use Anthropic Message Batches for the eval suite

  → **Exercise ID:** `study-ai-eng-06-02.2`
  → **What to build:** Once the eval suite from
    `05-evals-and-observability/01-eval-set-types.md` exercise 1
    exists, modify it to submit the 10-20 golden-set evals as a
    batch instead of sequentially. Anthropic processes within 24h at
    50% discount; suitable for offline nightly evals.
  → **Why it earns its place:** Shows fluency with batch APIs — a
    pattern most candidates know exists but few have used.
  → **Files to touch:** `test/evals/diagnosis.eval.ts`,
    `package.json` (`@anthropic-ai/sdk` is already on
    `^0.99.0` which supports batch API).
  → **Done when:** Eval suite runs via batch API at 50% reduced cost;
    completes within 24h.
  → **Estimated effort:** `1–2 days`

## Interview defense

**Q: What cost optimizations are in place in this codebase?**

Four are active, two are next:

```
  Active:
   1. haiku for intent classify (10x cheaper than sonnet)
   2. schemaSummary truncation (~30k → ~1.5k tokens, 20x)
   3. per-agent tool allowlists (8-17 tools vs union of 22+)
   4. hard tool-call caps in prompts (6 / 4)

  Next:
   5. Anthropic prompt caching (one config flag, ~20% on 6-turn loops)
   6. per-turn model routing inside diagnostic loop (haiku for
      exploration turns, sonnet for synthesis)
```

The pattern at every layer: pick the cheapest tool that meets the
quality bar. Haiku for triage; sonnet for synthesis. Truncated
summary instead of full schema. Narrow allowlist instead of union.

**Anchor line:** "Match model to task. Truncate inputs. Cap loop
iterations. Each move is a different gear on the same machine."

**Q: Why is haiku safe for intent classify but you wouldn't use it
for diagnostic synthesis?**

Two different shape requirements. Intent classify is a one-shot
4-class enum output — pattern matching, no reasoning chain. Haiku
handles it well. Diagnostic synthesis is a multi-paragraph structured
JSON output that has to weave evidence and hypotheses into a coherent
conclusion — the reasoning quality difference between haiku and sonnet
shows up here. The cheap model is enough for the easy task and not
enough for the hard one.

For the *exploration* turns of a diagnostic loop (running tool calls,
not synthesizing), haiku is probably good enough — that's the per-turn
routing the next exercise lands.

## See also

  → `01-llm-foundations/06-token-economics.md` — where the dollar amounts come from
  → `01-llm-caching.md` — the parallel cost-reduction lever
  → `01-llm-foundations/08-provider-abstraction.md` — the seam that makes
    multi-provider model routing possible
