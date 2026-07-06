# Exercise 07 — RAG track  ← SKIPPED (this repo is not a RAG app)

## verdict up front

This exercise does not apply to `blooming_insights`. Skip it. Read this
file once so you know *why* it's skipped and what the equivalent
evaluation problem is in your architecture (it's Exercise 08, the agent
track).

## why skipped — the shape check

Per the spec, Exercise 07 applies only if the repo has a **retrieval
seam**: embedding + ANN over a vector store + a generator that reads
retrieved chunks. The whole exercise is about grading the two halves
(retrieval, generation) separately so a wrong answer tells you which
half broke.

Your repo does not have that shape. Discovery reads:

- **No vector store.** No pgvector, no Pinecone, no Weaviate, no
  Qdrant, no ChromaDB. Grep for imports comes back empty.
- **No embedding step.** No `text-embedding-*`, no `voyage-*`, no
  `cohere.embed`. No `.embed(...)` calls in `lib/`.
- **No `retrieve` primitive.** The `DiagnosticAgent` does not consult a
  vector index before generating. It picks tools and calls them.
- **Retrieval-shaped work IS present, but it's tool use, not RAG.** The
  agent calls MCP tools (`execute_analytics_eql`,
  `list_customer_properties`, etc.) against Bloomreach's loomi-connect
  server. Tool selection + argument construction + response marshaling
  is *agentic retrieval*, not embedding-based retrieval.

**The distinction matters for evaluation** — a retriever failure is
graded by relevance metrics (recall@k, precision@k) against
human-labeled relevance judgments per query. A tool-use failure is
graded by *whether the right tool was called, in the right order, with
the right arguments*. Same conceptual layer ("did the agent get the
right context to generate from?"), different measurement instrument.

## if this were a RAG app — what the exercise would ask

For reference so you can recognize this pattern in other systems:

```
  RAG evaluation — two numbers, not one

  query ─► retriever ─► top-K chunks ─► generator ─► answer

           ▲ eval half 1              ▲ eval half 2
             precision@k / recall@k     faithfulness rubric
             against human-labeled      (grounded in retrieved
             relevance judgments        chunks vs inventing)

  retrieval good + answer bad  → generator/prompt problem
  retrieval bad  + answer bad  → fix the retriever FIRST
  retrieval bad  + answer good → got lucky; will break silently
```

The human artifact for RAG eval: for each query, label which documents
from your corpus *should have* been retrieved. That's the relevance
judgment. AI cannot write this for you — it's a domain call about
what's relevant.

## where the analogous concern lives in YOUR repo

The two-halves-graded-separately pattern DOES exist for your architecture,
but in Exercise 08 (agent track). The two halves are:

- **Half 1: diagnosis** (analogous to retrieval — did the agent gather the right evidence?)
- **Half 2: recommendation** (analogous to generation — given the evidence, did the agent produce the right action?)

Your rubrics already grade these separately (`diagnosis-quality.ts` vs
`recommendation-quality.ts`). Your baseline reports them separately
(`baseline.json` — 4 dims for diagnosis, 4 for recommendation). Your
`diagnosis_response` dim on the rec rubric is exactly the
"did the second half act on what the first half found?" question that
RAG eval asks between retriever and generator.

**Move 3 was a failure at that seam** — the recommendation acted on a
hypothesis the diagnosis had explicitly rejected. Same shape of
failure as "retrieval good, generation bad." Same lesson: grade the
halves separately or you can't tell where the break is.

## what to do

- **Skip this exercise.** Move directly to Exercise 08.
- **If you ever add a vector store** (AdvntrCue is your other project
  that runs this shape — but blooming does not), come back here. The
  RAG track applies to embedding-based retrieval, not tool-call
  retrieval.
- **Notice the pattern lives in Exercise 08** — the retrieval/generation
  split is the diagnose/recommend split in your architecture, and the
  same "grade the halves separately" discipline applies.

## ⑦ done when

- You can name why this repo is not a RAG app (no vector store, no embeddings, no ANN retrieval).
- You can name the analogous "grade the halves separately" pattern in your architecture (the diagnosis/recommendation seam) and where it's already being measured (`baseline.json` reports both rubrics' pass rates side by side).
- You've moved on to Exercise 08.
