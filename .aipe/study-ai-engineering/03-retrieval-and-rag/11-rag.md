# RAG — retrieval-augmented generation

## Subtitle

Retrieval + generation pipeline — Industry standard.

## Zoom out, then zoom in

RAG is the composite pattern: retrieve relevant chunks, stuff them into the LLM's prompt, generate. The retrieval brings in specific knowledge the model doesn't have; generation composes it into an answer. blooming does not do RAG today — the concept file explains the pattern and names the concrete places where it would fit.

```
  Zoom out — the RAG pipeline

  ┌─ User question ─────────────────────────────────────┐
  └──────────────────┬──────────────────────────────────┘
                     ▼
  ┌─ Retrieve ★ ────────────────────────────────────────┐ ← we are here
  │  embed query → nearest neighbors in vector index    │
  │  (optionally hybrid + rerank)                        │
  └──────────────────┬──────────────────────────────────┘
                     │  top-k chunks
                     ▼
  ┌─ Augment ───────────────────────────────────────────┐
  │  stuff chunks into system prompt                     │
  └──────────────────┬──────────────────────────────────┘
                     ▼
  ┌─ Generate ──────────────────────────────────────────┐
  │  LLM produces answer, cites retrieved chunks         │
  └──────────────────────────────────────────────────────┘
```

## Structure pass

- **Layers:** question → retrieve → augment → generate → answer. Five bands.
- **Axis: knowledge source.** Retrieval brings *fresh, specific* knowledge; the model provides *general reasoning*. The split is the whole point.
- **Seam:** the augment step — where retrieved chunks enter the prompt. That's the boundary between retrieval quality and generation quality.

## How it works

### Move 1 — the mental model

Standard RAG has three moves: retrieve, augment, generate. The retrieval is agnostic to the model; the model treats the augmented context as ground truth.

```
  RAG — the three moves

  User: "why did mobile revenue drop last week"
     │
     ▼
  Retrieve: find top-3 past investigations for similar anomalies
     │  [investigation-42 (payment_failure), investigation-58 (a/b),
     │   investigation-71 (holiday-effect)]
     ▼
  Augment: system prompt now includes the 3 investigations as
           "here's what we found on similar anomalies:"
     │
     ▼
  Generate: agent runs with the augmented context;
            answer references the retrieved investigations
```

### Move 2 — the step-by-step walkthrough

**Above-threshold rule.** Don't add RAG to features that work without it. In blooming, the diagnostic agent works on today's live data with schema summary + tool calls — no retrieval needed for the primary path. RAG earns its place when the *history* becomes valuable — investigation memory, EQL query library, catalog search.

**Where RAG would fit — three surfaces.**

1. **Past-investigation memory** (see **01-embeddings.md** `B3.1`). Retrieve top-3 past investigations for similar anomalies, inject as few-shot context. The diagnostic prompt gets: "here's what we found on similar anomalies. Use them as guidance, not gospel."

2. **EQL query library.** As working EQL patterns accumulate, retrieve the top-3 most similar queries when the monitoring agent composes a new one. The agent sees canonical examples instead of composing from scratch.

3. **Catalog search** (see **03-chunking-strategies.md** `B3.3`). New MCP tool `retrieve_catalog(query)` that returns matching products by embedding similarity. The agent uses it exactly like any other tool.

**Where RAG shouldn't go.**

- The primary diagnostic loop. Live workspace data is already retrieved via MCP tools; adding an embedding-based retrieval layer duplicates the work.
- The recommendation agent's core reasoning. Recommendations should stay grounded in the diagnosis, not in a similar-recs-from-history retrieval — that would risk copying past recs that were wrong for the new context.

**Cost math for the memory case.** Adding RAG adds: one embed per query ($0.00003), one embed per new investigation ($0.00003), storage (~60 MB for 10k vectors), retrieval latency (~10ms). All negligible against the ~$0.09/case agent cost.

Diagram of the augmented prompt shape:

```
  Augment step — what the prompt looks like after retrieval

  ┌─ system prompt ─────────────────────────────────────┐
  │  You are a data analyst investigating an anomaly.   │
  │  ...(unchanged)                                      │
  │                                                     │
  │  ┌── injected retrieved context ──────────────────┐ │
  │  │ Related past investigations (top-3 by          │ │
  │  │ semantic similarity to the current anomaly):   │ │
  │  │                                                 │ │
  │  │ #1  investigation-42, mobile checkout drop,    │ │
  │  │     conclusion: payment processor failure.     │ │
  │  │                                                 │ │
  │  │ #2  investigation-58, similar timeframe...     │ │
  │  │                                                 │ │
  │  │ #3  investigation-71, holiday anomaly false    │ │
  │  │     positive.                                   │ │
  │  │                                                 │ │
  │  │ Use these as guidance; verify against current  │ │
  │  │ data before concluding.                         │ │
  │  └───────────────────────────────────────────────┘  │
  └─────────────────────────────────────────────────────┘
```

### Move 3 — the principle

RAG earns its place when the model needs knowledge it doesn't have (private data, freshness, sheer volume). It doesn't earn its place when the same information is already available through direct tool calls or a bounded prefix. Measure retrieval quality before you measure generation quality — bad retrieval produces bad answers regardless of model.

## Primary diagram

```
  RAG — full frame

  ┌─ User question ─────────────────────────────────────┐
  │  "why did mobile revenue drop last week"             │
  └──────────────────┬──────────────────────────────────┘
                     │
                     ▼
  ┌─ (optional) Query augmentation ─────────────────────┐
  │  rewrite or HyDE (see 08)                            │
  └──────────────────┬──────────────────────────────────┘
                     │
                     ▼
  ┌─ Retrieval ─────────────────────────────────────────┐
  │  hybrid (dense + sparse) → RRF → top-10              │
  │  (optional) cross-encoder rerank → top-3             │
  └──────────────────┬──────────────────────────────────┘
                     │  3 chunks
                     ▼
  ┌─ Augment ───────────────────────────────────────────┐
  │  inject chunks into system prompt as bounded context │
  └──────────────────┬──────────────────────────────────┘
                     │
                     ▼
  ┌─ Generate (agent runs) ─────────────────────────────┐
  │  DiagnosticAgent uses retrieved context + live tools │
  │  → Diagnosis (cites which retrieved chunks helped)   │
  └─────────────────────────────────────────────────────┘
```

## Elaborate

RAG (Lewis et al. 2020, "Retrieval-Augmented Generation") started as a specific model architecture and became the industry shorthand for any retrieve-then-generate pipeline. The pattern predates the term — search + summarize was a common shape before it had a name.

The above-threshold rule is worth restating: adding RAG to a feature that works without retrieval usually makes it worse, not better. The retrieval layer adds latency, cost, and a new failure mode (bad chunks in context confuse the model).

Related: **../04-agents-and-tool-use/05-agent-memory.md** (the memory-tool version of retrieval), **../05-evals-and-observability/01-eval-set-types.md** (how to measure retrieval quality with hit@k).

## Project exercises

### B3.11 · Ship past-investigation memory as an end-to-end RAG feature

- **Exercise ID:** B3.11 (Case B — the aggregate exercise)
- **What to build:** Combine B3.1, B3.2, B3.4, B3.7, B3.9, B3.10 into one shipped feature: past-investigation memory as a retrieval layer over the diagnostic agent. Includes: embedding on save, in-memory + JSON index, hit@k eval, staleness tracking, full-rebuild endpoint.
- **Why it earns its place:** The single largest interview payoff in this sub-section. Turns "we discussed RAG" into "we shipped RAG, measured its impact on the existing baseline, and can defend every layer choice."
- **Files to touch:** All files named in B3.1 through B3.10. Baseline rerun with the memory enabled.
- **Done when:** rerunning the eval baseline with memory enabled shows a measurable change in `root_cause_plausibility` pass rate (up or down — both are learnings); the receipt shows retrieval latency + count per case.
- **Estimated effort:** `≥1 week`.

## Interview defense

**Q: Why doesn't blooming have RAG today?**

The primary path — diagnostic agent over live workspace data — doesn't need it. The workspace schema fits in a bounded summary. Data is retrieved via MCP tools that are already RAG-shaped (query → get top-k results). Adding an embedding-based retrieval layer would duplicate the work. The load-bearing answer: knowing when *not* to add RAG is as much of a signal as knowing when to add it.

**Q: When would RAG earn its place here?**

Investigation memory. When the codebase has accumulated hundreds of prior investigations, retrieving 3 similar ones as few-shot context for a new investigation is measurable value. The setup cost is low (~200 LOC, one endpoint, one JSON file); the impact is measurable via the existing eval baseline. See B3.11 for the shipped-feature exercise.

## See also

- [01-embeddings.md](01-embeddings.md) — the primitive.
- [12-graphrag.md](12-graphrag.md) — the graph-traversal variant.
- [../04-agents-and-tool-use/05-agent-memory.md](../04-agents-and-tool-use/05-agent-memory.md) — the memory shape RAG powers.
