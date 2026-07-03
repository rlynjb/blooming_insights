# Agentic RAG

*Industry name: agentic RAG · Language-agnostic*

## Zoom out

```
  Zoom out — retrieval as a loop, not a step

  ┌─ static RAG (one shot) ─────────────────────┐
  │  query → retrieve → stuff → generate         │
  └─────────────────────────────────────────────┘
              ↓ escalation
  ┌─ ★ AGENTIC RAG (a loop) ★ ──────────────────┐ ← we are here
  │  agent decides when/what to retrieve         │
  │  evaluates result, re-retrieves if needed    │
  └─────────────────────────────────────────────┘
```

## Zoom in

Static RAG is one call: embed the query, pull top-K chunks, stuff into the prompt, generate. Agentic RAG is a loop: the agent decides *what* to retrieve, *whether* the result is good enough, and *whether* to try again with a refined query. It's ReAct whose primary tool happens to be retrieval.

In this repo the "retrieval tool" isn't a vector store — it's `execute_analytics_eql`. Same pattern, different substrate. The mechanics of vector retrieval live in `.aipe/study-ai-engineering/03-retrieval-and-rag/`; this file covers the control-loop shift.

## Structure pass

Layers: **query decomposition** — **per-sub-query retrieval** — **evaluation** — **re-retrieval or generate**.

Axis to hold constant: **who decides which retrieval to run?**

```
  Who decides retrieval — static vs agentic

  static RAG:  code decides (one-shot embed + ANN + top-K)
  agentic RAG: agent decides (which sub-query, which source,
                              whether to retry, when to stop)
```

## How it works

### Move 1 — the shape

You've written a `while (result.length < threshold) { widen(); retry(); }` before. Agentic RAG is that shape where "widen" and "retry" are model-chosen refinements to the query, not code-written rules.

```
  Agentic RAG — a loop over retrieval

  ┌───────────────────────────────────────────────┐
  │  decompose query into sub-questions            │
  └────────────────────┬──────────────────────────┘
                       ▼
  ┌───────────────────────────────────────────────┐
  │  retrieve for each (route to the right source)│
  └────────────────────┬──────────────────────────┘
                       ▼
  ┌───────────────────────────────────────────────┐
  │  evaluate: is this enough to answer?          │
  └──────────┬─────────────────────┬──────────────┘
             ▼ no                  ▼ yes
        re-retrieve            generate answer
        (refine query)
             │
             └──── loop (cap iterations)
```

### Move 2 — how it maps to tool-driven retrieval

**The reframe for this repo.** All agentic RAG is agentic AI; not all agentic AI does retrieval. In this repo, "retrieval" means "run an EQL query against the workspace data" — every EQL is a form of retrieval (pulling rows the agent then reasons over). The loop is identical to vector agentic RAG:

```
  Agentic RAG in this repo — tool-driven, not vector-driven

  input: Anomaly ("USA purchase_revenue · -38.4%")
    │
    ▼
  ┌───────────────────────────────────────────────┐
  │  decompose: what sub-questions do I need?     │
  │  1. Is this concentrated in a specific state? │
  │  2. Is it concentrated in a product category? │
  │  3. Is it concentrated in a customer segment? │
  └────────────────────┬──────────────────────────┘
                       ▼
  ┌───────────────────────────────────────────────┐
  │  for each sub-question:                       │
  │    → execute_analytics_eql(…)                 │
  │  observe results                              │
  └────────────────────┬──────────────────────────┘
                       ▼
  ┌───────────────────────────────────────────────┐
  │  evaluate: enough to conclude?                │
  │  (aptkit's decision, prompt-shaped)           │
  └──────────┬─────────────────────┬──────────────┘
             ▼ no                  ▼ yes
        refine query          emit Diagnosis
        (different EQL,       (final structured
        different group-by)   output)
```

**Where the loop lives in code.** Same place as ReAct: `lib/agents/diagnostic.ts` → aptkit's `DiagnosticInvestigationAgent`. The agent doesn't distinguish between "retrieval tools" and "action tools" — they're all just tools. That's actually the point: agentic RAG in a tool-calling agent is just ReAct where the tool happens to be a retrieval endpoint.

**The tradeoff vs static RAG.** Steep — roughly **3-10x token cost** and **2-5x latency** over one-shot retrieval. Every re-retrieval is another turn (model call + tool call). Use the loop only when one-shot retrieval measurably fails on multi-step or cross-source queries.

For this repo, "one-shot retrieval" isn't an option — the diagnostic task is inherently multi-step (form hypothesis, test, re-hypothesize). So the loop is the baseline, not the escalation. But if you were building a Q&A over documentation, you'd start with static RAG and escalate to agentic only when queries needed decomposition or cross-source synthesis.

**The termination guard, again.** The loop needs the same budget exit as any agent loop (`01-reasoning-patterns/02-agent-loop-skeleton.md`) — nothing guarantees the model will decide "enough evidence" if the data is weird. Every agentic RAG loop in production carries a max-iterations cap; in this repo it's aptkit's iteration cap plus the `BudgetTracker`.

### Move 3 — the principle

Retrieval-as-a-loop is not a new class of pattern; it's the agent kernel with a retrieval tool. What earns "agentic RAG" a name is the *deliberate decomposition* — the model decides which sub-question to answer with which retrieval, then decides when the accumulated evidence is enough. Vector store or SQL query, the shape is the same.

## Primary diagram

```
  Agentic RAG — the loop, and how this repo instantiates it

  ┌─ Agent (ReAct with retrieval-shaped tools) ─────────────────┐
  │                                                              │
  │  turn 1: decompose query mentally                            │
  │          → execute_analytics_eql (sub-query 1)               │
  │          ← result (rows)                                     │
  │                                                              │
  │  turn 2: read result, form next hypothesis                   │
  │          → execute_analytics_eql (sub-query 2, refined)      │
  │          ← result (rows)                                     │
  │                                                              │
  │  turn 3: enough evidence?                                    │
  │          → yes: emit final Diagnosis (structured output)     │
  │          → no:  refine query, → execute_analytics_eql        │
  │                                                              │
  │  guards: iteration cap + BudgetTracker.exceeded()            │
  │                                                              │
  └──────────────────────────────────────────────────────────────┘

  Substrate difference from vector agentic RAG:
    vector version: retrieval = embed + ANN + top-K chunks
    this repo:      retrieval = EQL query returning rows
    Loop shape:     identical.
```

## Elaborate

The term "agentic RAG" came into use around late 2023 as teams noticed that static top-K retrieval hit a ceiling on multi-hop questions (HotpotQA, MuSiQue). LangGraph's `Adaptive RAG` and LlamaIndex's `Sub Question Query Engine` were early productions of the pattern.

The interesting frontier now is **agentic RAG with multiple retrieval sources** — routing per sub-question to vector DB vs SQL DB vs web search vs a proprietary API (see `03-retrieval-routing.md`). The multi-source case is where the pattern earns its complexity budget: one retrieval loop that spans heterogeneous knowledge sources is genuinely hard to build as a chain, and the agent decomposition pays for itself.

## Interview defense

**Q: Do you do agentic RAG?**

Yes — but tool-driven, not vector-driven. Every EQL query the diagnostic agent runs is a retrieval step; the agent decomposes the anomaly into sub-hypotheses, runs an EQL per hypothesis, evaluates whether the accumulated evidence supports a conclusion, and either re-queries with a refined EQL or emits the final Diagnosis. Same loop shape as vector agentic RAG, different retrieval endpoint.

The reason there's no vector store: the workspace data is inherently structured (customer events, revenue, segments) and EQL is the right query language for it. A vector store would only make sense if I were retrieving over unstructured Bloomreach documentation — that's a possible future extension, not a current need.

*Anchor visual:* the retrieve-observe-refine loop above.

**Q: When wouldn't you use agentic RAG?**

When one-shot retrieval works. If the queries are single-hop and the top-K static retrieval gets the answer 90%+ of the time, the 3-10x cost of the loop buys nothing. Agentic RAG is warranted specifically when multi-step or cross-source retrieval is measurably better than static.

For this repo, the diagnostic task is inherently multi-step, so the loop is the baseline. But for a documentation Q&A, I'd start static and escalate.

## See also

- **`02-self-corrective-rag.md`** — the retrieval loop with a relevance grader inline.
- **`03-retrieval-routing.md`** — routing to the right source before retrieval.
- **`01-reasoning-patterns/03-react.md`** — the base pattern this instantiates.
- **`.aipe/study-ai-engineering/03-retrieval-and-rag/`** — vector retrieval mechanics (embeddings, chunking, ANN).
