# 12 — GraphRAG

**Subtitle:** Graph-traversal retrieval (entities + relations) · Industry standard (Case B)

## Zoom out, then zoom in

**Case B.** Where plain RAG searches by semantic similarity, GraphRAG
extracts entities and relationships from the corpus upfront, builds a
graph, and traverses it at query time. Beats vector RAG when the answer
depends on *connections* between docs that don't share vocabulary.

```
  Zoom out — GraphRAG sits parallel to vector RAG

  ┌─ ingest ──────────────────────────────────────┐
  │  for each doc:                                │
  │    extract entities (LLM)                     │
  │    extract relations (LLM)                    │
  │    store in graph DB                          │  ← we are here
  │    also: embed → store in vector index        │   (Case B)
  └───────────────────────────────────────────────┘

  ┌─ query ───────────────────────────────────────┐
  │  identify entities in query                   │
  │  walk graph from entities                     │
  │  return docs connected to relevant entities   │
  └───────────────────────────────────────────────┘
```

## Structure pass

  → **One axis to trace — relational depth.** Vector RAG asks "what docs
    are semantically similar to this query?" GraphRAG asks "what docs
    are connected to entities mentioned in this query?" The two are
    different questions; some queries need one, some need the other.

## How it works

### Move 1 — the mental model

Vector RAG is fuzzy match. GraphRAG is JOIN. Combining them is what
production systems (Microsoft's GraphRAG paper, 2024; LlamaIndex
KnowledgeGraph) actually ship.

```
  User asks: "What did we decide about auth in the design meetings about
              session management?"

  ┌─ Vector RAG ──────────────────────────────────┐
  │  embed query → cosine search                  │
  │  may miss meetings that didn't mention "auth" │
  │  verbatim, even though they decided things    │
  │  about auth                                    │
  └────────────────────────────────────────────────┘

  ┌─ GraphRAG ────────────────────────────────────┐
  │  entities in query: "auth", "session mgmt",   │
  │                     "design meeting"           │
  │  walk graph:                                  │
  │    [auth] —relates_to→ [session mgmt]         │
  │    [session mgmt] —discussed_in→ [meeting #3] │
  │    [meeting #3] —contains→ [chunks]            │
  │  retrieve those chunks                         │
  └────────────────────────────────────────────────┘
```

### Move 2 — the step-by-step walkthrough

**For blooming insights' hypothetical RAG, would GraphRAG add value?**
Maybe. Investigations have natural entities:

  - Metrics (`purchase_revenue`, `conversion_rate`)
  - Scopes (`global`, `usa`, `mobile`)
  - Bloomreach features (`scenario`, `segment`, `campaign`)
  - Severity levels

A graph would link investigations that touch the same metrics or scopes,
even when their text doesn't share embeddings. Useful for "show me past
investigations that touched the same metric I'm investigating now" —
exactly the diagnosis-grounding use case from `11-rag.md`.

But the investigation corpus has structured fields *already*
(`Anomaly.metric`, `Anomaly.scope`). You don't need an LLM to extract
entities; they're literally typed fields. A SQL query like
`WHERE metric = ?` does the same thing as a graph walk, faster and more
reliably.

This is the test for GraphRAG: do the entities and relations already
exist as structured fields? If yes, skip GraphRAG and use the database.
If no (the corpus is unstructured prose), extraction + graph traversal
becomes the move.

**Build cost.** GraphRAG's expensive step is the ingestion: an LLM call
per doc to extract entities + relations. Microsoft's GraphRAG paper
showed this costs significantly more upfront than vector RAG but
produces better answers on questions that require "global" understanding
of the corpus (summarize the themes, find the connections, etc.).

**Hypothetical implementation for this codebase (which we wouldn't
actually build — see above):**

```typescript
// lib/rag/graph.ts (Case B — and probably overkill)
async function extractEntities(text: string): Promise<{
  entities: string[];
  relations: Array<{ from: string; to: string; type: string }>;
}> {
  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1000,
    system: 'Extract entities and relations from the text...',
    messages: [{ role: 'user', content: text }],
  });
  // parse via parseAgentJson (same lenient extractor as elsewhere)
  return parseAgentJson(textOf(response)) as ReturnType<typeof extractEntities>;
}
```

### Move 3 — the principle

**GraphRAG wins when relevance depends on connections that don't share
vocabulary. It loses when the relations are already structured fields you
can query directly.** For investigations with typed `metric` / `scope`
fields, the database query beats the graph walk. For a wiki-style prose
corpus where you need to find "everything connected to X," GraphRAG is
the right shape.

## Primary diagram

```
  When to reach for GraphRAG (decision tree)

  question:
    do the entities + relations exist as structured fields?
    │
    ├── yes (this codebase)
    │     → use SQL / structured query
    │     → skip GraphRAG
    │
    └── no (wiki, transcripts, free-form notes)
          │
          ├── do queries need global summarization?
          │     ("what are the main themes")
          │     → GraphRAG wins
          │
          ├── do queries need traversal between docs?
          │     ("what decisions led to X")
          │     → GraphRAG wins
          │
          └── do queries need top-k similar?
                ("find docs like this")
                → vector RAG wins
```

## Elaborate

GraphRAG hit the mainstream with Microsoft's 2024 paper ("From Local to
Global: A Graph RAG Approach to Query-Focused Summarization"). The
paper's key insight: for "global" questions ("what does this corpus say
about X overall?") vector RAG underperforms because it returns local
chunks, missing the synthesis. The graph + community detection produces
better summaries.

For "local" questions ("find the doc about X"), vector RAG is still
competitive and much cheaper to build.

For blooming insights, the corpus has natural local structure (each
investigation is self-contained, with typed metadata). The questions are
local ("find similar past anomalies"). Vector RAG (or just SQL) is the
right fit; GraphRAG would be over-engineering.

## Project exercises

### Exercise — skip GraphRAG, write a doc explaining why

  → **Exercise ID:** `study-ai-eng-03-12.1`
  → **What to build:** Don't build GraphRAG. Instead, write a short
    `docs/rag-decisions.md` that lays out why this codebase uses
    vector + sparse retrieval (with optional rerank) and explicitly
    does NOT use GraphRAG, citing the "entities already exist as
    structured fields" argument.
  → **Why it earns its place:** "What you chose NOT to build" is real
    interview signal. Demonstrates judgment about when a pattern doesn't
    fit, even when it's trendy.
  → **Files to touch:** new `docs/rag-decisions.md`.
  → **Done when:** Doc exists, names the alternative considered, names
    the test (do structured fields already exist?), names the answer
    (yes, so skip).
  → **Estimated effort:** `<1hr`

## Interview defense

**Q: Have you considered GraphRAG for this codebase?**

Considered and skipped. GraphRAG wins when relevance depends on
*connections* between docs that don't share vocabulary — wiki-style
corpora, transcripts, knowledge bases. For this codebase's
investigations, the entities and relations that matter (`metric`,
`scope`, `severity`, `bloomreachFeature`) are already typed fields. A
SQL `WHERE metric = ?` does what a graph walk would do — faster, cheaper,
no LLM extraction step.

```
  test: do the entities exist as structured fields?
    yes (this codebase) → SQL / structured query
    no (free-form prose) → consider GraphRAG
```

**Anchor line:** "GraphRAG wins on unstructured corpora with relational
questions. Our investigations have typed metadata — SQL beats it."

**Q: When would GraphRAG actually be the right move?**

When the corpus is unstructured prose (meeting transcripts, design docs,
internal wikis) AND the questions are global ("what are the recurring
themes in our engineering decisions") or traversal-shaped ("what
decisions led to the current architecture"). The Microsoft GraphRAG
paper showed measurable wins on those question shapes. For local
"find similar" questions, vector RAG is still competitive and much
cheaper.

## See also

  → `11-rag.md` — the alternative
  → `05-dense-vs-sparse.md` — the alternative-to-the-alternative
