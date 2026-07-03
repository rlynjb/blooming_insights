# Self-corrective RAG

*Industry names: self-corrective RAG / CRAG · Language-agnostic*

## Zoom out

```
  Zoom out — a grader between retrieval and generation

  ┌─ agentic RAG ────────────────────────────────┐
  │  retrieve → generate                          │
  │             (or loop)                         │
  └───────────────┬──────────────────────────────┘
                  ▼
  ┌─ ★ self-corrective RAG ★ ────────────────────┐ ← we are here
  │  retrieve → grade → generate | fall back      │
  │  the grader is the gate that catches the gap  │
  └──────────────────────────────────────────────┘
```

## Zoom in

Retrieval success (a chunk came back) is not answer success (the chunk is relevant and the answer is grounded in it). Self-corrective RAG adds a **relevance grader** between retrieval and generation, with a fallback path when the retrieval fails the grade. Not currently used inline in this repo; the closest thing is the diagnostic agent's own hypothesis-refinement step.

## Structure pass

Layers: **retriever** — **grader** — **either generator (pass) or fallback (fail)**.

Axis to hold constant: **what happens on a bad retrieval?**

The failure mode this pattern fixes is silent: retrieval "worked" (got results), but the results aren't relevant, so the generation hallucinates on top of them. Without the grader, you never notice.

## How it works

### Move 1 — the shape

You've written a `fetch → validate → use OR error-recover` chain before. Self-corrective RAG is that shape where "validate" is a model call scoring relevance, and "error-recover" is a query rewrite, wider search, or escalation to a different source.

```
  Self-corrective RAG — the grader is a gate

  retrieve → ┌─────────────────────────┐
             │ grade each chunk/result: │
             │ relevant? grounded?      │
             └──────────┬──────────────┘
              ┌──────────┴──────────┐
              ▼ relevant            ▼ not relevant
          generate            fall back:
                              rewrite query / widen
                              search / escalate
```

### Move 2 — the mechanics, and where it would fit here

**The grader is an LLM call.** The classic implementation uses a small model with a prompt like "Is this chunk relevant to the query? Answer yes/no with a confidence." Cheap (a few hundred tokens), fast (small model). The confidence lets you set a threshold — high-confidence pass generates, low-confidence pass or high-confidence fail triggers fallback.

**Not-yet-implemented in this repo.** No inline grader today. The gap this would close in the diagnostic agent: when `execute_analytics_eql` returns a shape the model didn't expect (schema drift, sparse data, empty result set), the model tries to reason over it anyway. A grader would say "this EQL result doesn't answer the sub-question" and force a refinement.

**Where it would go.** Between the tool call and the state update in `lib/agents/aptkit-adapters.ts` — the `BloomingToolRegistryAdapter.executeToolCall()` hook. You'd add:

```
  Where the grader would fit — in the tool result path

  agent picks EQL          ← current
       │
       ▼
  DataSource.callTool      ← current
       │
       ▼
  ┌──── grader (new) ──────────────┐
  │  Haiku: "does this result       │
  │  answer the sub-question?"      │
  └──────┬──────────────────────────┘
   pass  │ fail
         ▼
  fallback: rewrite EQL,
  widen scope, or emit
  "insufficient data" note
```

**Cost of adding this.** Every tool result gets a grader call — for a 4-turn diagnostic that's +4 model calls, roughly +$0.02 per case. In exchange, silent-hallucination-on-bad-retrieval becomes recoverable. Whether it's worth adding depends on how often the current diagnostic agent produces confident conclusions from weak evidence — a metric worth measuring.

**Contrast with reflexion.** Reflexion (`01-reasoning-patterns/05-reflexion-self-critique.md`) is a critic on the final output; self-corrective RAG is a critic on each intermediate retrieval. Complementary, not overlapping. The self-corrective grader catches "we're building a wrong conclusion on bad data" *before* the model commits; reflexion catches "the final answer looks wrong" *after* it commits.

**The failure mode this teaches.** Retrieval success is not answer success. The chunk came back; the chunk is off-topic; the model dutifully answers using the off-topic chunk. Without the grader, this is silent. The grader turns it into an observation the model can act on.

### Move 3 — the principle

The gap between "retrieval returned something" and "the something is relevant" is the source of most RAG hallucinations. A grader closes the gap at the cost of one extra small-model call per retrieval. When the stakes justify grounded answers, this is the cheapest fix.

## Primary diagram

```
  Self-corrective RAG — the full loop with fallback paths

  ┌─ retrieve ──────────────────────────────────┐
  │  vector store, SQL, or (in this repo) EQL   │
  └────────────────────┬────────────────────────┘
                       │ chunks / rows
                       ▼
  ┌─ grader (new) ──────────────────────────────┐
  │  small model, prompt: "relevant? grounded?" │
  │  → { relevant: bool, confidence: 0-1 }      │
  └────────────────────┬────────────────────────┘
                       │
        ┌──────────────┴──────────────┐
        ▼ relevant                    ▼ not relevant
   ┌──────────┐              ┌─────────────────────┐
   │ generate │              │ fallback:            │
   └──────────┘              │  1. rewrite query    │
                             │  2. widen search     │
                             │  3. try alt source   │
                             │  4. emit "insufficient│
                             │     data" note        │
                             └─────────────────────┘
```

## Elaborate

Self-corrective RAG (CRAG — Corrective Retrieval-Augmented Generation) was named by Yan et al. (2024) — the paper's contribution was formalizing the grader + fallback as a first-class step, not a hidden retry inside retrieval. LangGraph ships a reference implementation as `Corrective-RAG`.

The related pattern is **Self-RAG** (Asai et al., 2023) — a fine-tuned model that emits "reflection tokens" indicating whether to retrieve, whether the retrieval is relevant, and whether the generated answer is supported. Same intuition (grade before trust), different mechanism (baked into the model vs a separate call).

## Interview defense

**Q: How do you catch bad retrievals?**

Not with an inline grader today. My diagnostic loop relies on the model's own next-turn reasoning to catch it — if turn 1's EQL returned weird data, the model's turn 2 reasoning usually says "that didn't answer the question, let me try …". That works most of the time because the model can see the raw result.

Where I'd add a self-corrective grader: if I noticed the model producing confident conclusions from weak evidence. A cheap Haiku call between the tool result and the state update — "does this EQL result answer the sub-question?" — with a low-confidence fallback to query rewrite. Estimated cost: +$0.02 per diagnostic case. I'd add it after measuring how often silent-bad-retrieval fires — no point paying the tax if it's rare.

*Anchor visual:* the grader-in-the-tool-result-path diagram above.

**Q: What's the failure mode this fixes?**

Silent hallucination on off-topic retrieval. Vector store returns chunks that came up top-K but aren't actually about the question; the model uses them anyway; the answer is confidently wrong. Static RAG has no defense — the grader is the only one that catches it.

## See also

- **`01-agentic-rag.md`** — the base pattern this refines.
- **`03-retrieval-routing.md`** — the fallback often *is* routing to a different source.
- **`01-reasoning-patterns/05-reflexion-self-critique.md`** — critic on final output; complementary to this file's critic on intermediate retrieval.
- **`.aipe/study-ai-engineering/03-retrieval-and-rag/`** — RAG mechanics.
