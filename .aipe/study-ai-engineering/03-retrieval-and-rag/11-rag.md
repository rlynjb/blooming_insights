# RAG — and why blooming insights retrieves live instead

**Industry name(s):** Retrieval-Augmented Generation (RAG), retrieve-then-generate, grounding via retrieval
**Type:** Industry standard · Language-agnostic

> RAG grounds a model's answer in retrieved context — classically by embedding a document corpus and pulling the nearest chunks into the prompt; blooming insights does the *retrieval* but not the *embedding index*: it retrieves live via MCP tool calls + EQL against Bloomreach, a deliberate "no RAG until a feature provably needs it" decision because the data is a fresh live API with exact analytics, where an embedding index would be stale and lossy.


---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** RAG is the whole *grounding pipeline* — the discipline of putting the right specific context in the prompt at query time so the model answers from real data rather than training-time priors. Classic RAG builds an Indexer → Vector store → Retriever chain. blooming insights uses a *different retriever* — live MCP tool calls (`lib/mcp/tools.ts`, `lib/agents/base.ts` L144) that hit the Bloomreach API and put the live result back into the context. Same shape, different retriever: a fresh live query instead of a cached embedding.

```
  Zoom out — the two retrieval roads (RAG vs live tools)

  CLASSIC RAG (WOULD BE)              LIVE TOOL RETRIEVAL (this codebase)
  ┌─ Query ──────────────────┐         ┌─ Query ──────────────────┐
  └──────────┬───────────────┘         └──────────┬───────────────┘
             │                                    │
  ┌─ Indexer ▼ embed + chunk ┐         ┌─ Agent loop ▼ pick tool ┐
  ┌─ Vector store ───────────┐         │  runAgentLoop  base.ts L102│
  ┌─ Retriever (cosine) ─────┐         ┌─ Tools (MCP) ────────────┐
  │  top-k chunks            │         │  ★ execute_analytics_eql ★│
  └──────────┬───────────────┘         │  mcp.callTool  base.ts L144│
             │                          └──────────┬───────────────┘
  ┌─ LLM context ▼───────────┐         ┌─ LLM context ▼───────────┐
  │  retrieved chunks + query│         │  live tool result + query │
  └──────────────────────────┘         └──────────────────────────┘

  In this codebase: Not yet implemented — String.includes
  intent matching in lib/agents/intent.ts is what exists for
  schema-lookup, and EQL tool calls are the codebase's
  retrieval discipline (RAG with a live tool as the retriever).
```

**Zoom in — narrow to the concept.** This is the file to read first in the sub-section, because it is the one that explains why the other eleven describe a road blooming insights deliberately did not take. The question RAG answers is: how does a model answer questions about data it was never trained on? The grounding has to come from retrieval, and the only real choice is *how* — from a pre-built embedding index, or live from the source. How it works walks the trade between the two retrievers and the conditions under which the codebase's choice (live tools) would tip back toward embedding-RAG.

---

## How it works

**Mental model.** Strip RAG to its essence and it is two steps: *retrieve* relevant context, then *generate* an answer conditioned on that context. The famous version uses an embedding index as the retriever. But "retriever" is an interface, not an implementation — anything that returns relevant context for a query qualifies. A live tool call is a retriever. So is an embedding index. This system swapped the retriever implementation, not the RAG shape.

```
  RAG, abstractly
  ──────────────────────────────────────────────────────────
  query ──▶ [ RETRIEVER ] ──▶ context ──▶ [ LLM ] ──▶ answer
                  │
        ┌─────────┴──────────────────────────┐
        ▼                                     ▼
  embedding index (classic RAG)         live tool call (this system)
  embed + nearest chunks                execute_analytics_eql → result
  cached snapshot                       fresh source query
```

The body contrasts the two retrievers and defends the choice.

---

### Classic RAG: the embedding-index retriever

The textbook pipeline (the subject of files 01–10 in this section): chunk a document corpus, embed each chunk, store the vectors in an index, and at query time embed the query, retrieve the nearest chunks, and put them in the prompt.

```
  INDEXING (offline, once)              QUERY (online, per request)
  ─────────────────────────             ───────────────────────────────
  docs → chunk → embed → index          query → embed → nearest-k chunks
       (03)    (01)    (04)                  (01)        (04/06/07)
                                             │
                                        chunks → prompt → LLM → answer
```

This is the right tool when the knowledge lives in a *static document corpus* — manuals, past tickets, policy docs — that the model was not trained on and that does not change every second. The index makes retrieval fast and semantic.

### This system's RAG: the live-tool retriever

This system replaces the embedding index with a live query. The shared agent loop (→ ../04-agents-and-tool-use/02-tool-calling.md) lets the model emit a `tool_use` block; the loop runs the analytics query tool against the source and feeds the *fresh result* back as the grounding context. There is no index, no embedding, no chunk — just a live read of the source.

```
  query ──▶ model decides EQL ──▶ loop runs the analytics query tool ──▶ fresh result
                                            │
                                       result → next prompt turn → grounded answer
```

The "retrieved context" is the live analytics result. It is current to the second (modulo the 60-second TTL cache, `09`), exact (an aggregate, not a fuzzy nearest-neighbor), and never stale.

### Why live retrieval is the right retriever here

Three properties of the data make the live tool the correct retriever and the embedding index the wrong one:

```
  property of the data           live tool        embedding index
  ───────────────────────────    ─────────────    ──────────────────────
  freshness (changes constantly) always current   stale until re-embedded (09)
  exactness (counts, rates)      exact aggregate  fuzzy nearest-neighbor (05)
  source IS a queryable API      read directly    a lossy COPY to maintain
```

The data is a live analytics API returning exact aggregates. An embedding index would be a *copy* of that data — immediately stale (`09`), lossy (an embedding of "1,432 checkouts" is a fuzzy point, not the number), and an operational burden (incremental indexing, `10`) to keep in sync with a source you could just query directly. Live retrieval has none of these costs: no staleness, no index to maintain, exact numbers.

### The threshold rule: add RAG only when a feature provably needs it

The decision is not "RAG is bad." It is "RAG earns its place only when a feature's data is *not* a fresh, exact, queryable API." The one feature that would cross that threshold is **semantic search over past investigations** — free-text narratives, not live aggregates, where a fuzzy "find work similar to this" query needs embeddings (`05`, `08`). That feature, and only that feature, would justify building the index described in files 01–10. Until then, adding RAG would be solving a problem the codebase does not have.

```
  feature's data shape              retriever
  ────────────────────────────────  ──────────────────────────────
  fresh, exact, queryable API       live tool call (current choice)
  static free-text corpus, fuzzy    embedding RAG (add WHEN this exists)
  rule: no embedding index until a feature provably needs fuzzy recall
```

### The principle

RAG is retrieve-then-generate, and "retrieve" is an interface with two implementations: a live source query and a pre-built embedding index. Choose the retriever by the data's shape — fresh, exact, queryable data wants a live query; static, fuzzy, free-text data wants an embedding index. You chose live retrieval because the data is a fresh, exact, queryable API, where an embedding index would be a stale, lossy copy to maintain. The discipline is to add the embedding index only when a feature's data is the kind an index is actually for.

---

## RAG — diagram

This diagram spans the Service layer (the two retriever choices) and shows blooming insights' path. A reader who sees only this should grasp that RAG is retrieve-then-generate, that the retriever is swappable, and that the codebase chose the live-tool retriever.

```
┌──────────────────────────────────────────────────────────────────────┐
│  RAG = retrieve-then-generate  (retriever is the swappable part)     │
│                                                                      │
│  query                                                               │
│    │                                                                 │
│    ▼                                                                 │
│  ┌──────────────────────────┐      ┌──────────────────────────────┐ │
│  │ CLASSIC RAG retriever     │      │ BLOOMING INSIGHTS retriever  │ │
│  │ embedding index           │      │ live tool call               │ │
│  │ embed query → nearest-k   │      │ model → EQL → execute_       │ │
│  │ chunks (01/04/06/07)      │      │ analytics_eql (tools.ts)     │ │
│  │ → cached, fuzzy, can stale│      │ → fresh, exact, no staleness │ │
│  └────────────┬─────────────┘      └──────────────┬───────────────┘ │
│               │  context                          │  context        │
│               └────────────────┬──────────────────┘                 │
│                                ▼                                     │
│                   LLM generates grounded answer                     │
│                   (runAgentLoop, base.ts)                          │
│                                                                      │
│  blooming insights uses the RIGHT path because the data is a fresh, │
│  exact, queryable API — an index would be a stale, lossy copy.     │
└──────────────────────────────────────────────────────────────────────┘
```

Both columns are RAG; the codebase chose the live-tool retriever because its data demands fresh, exact retrieval.

---

## Implementation in codebase

**Not yet implemented (embedding-RAG); implemented as live-tool retrieval.** blooming insights retrieves live via MCP tool calls + EQL against Bloomreach, not embeddings or a vector store — a deliberate "no RAG until a feature provably needs it" decision.

The retrieval-augmented generation *shape* is fully present, with a live tool as the retriever. The agent loop (`lib/agents/base.ts`, the tool-calling round-trip in `../04-agents-and-tool-use/02-tool-calling.md`) lets the model decide what to retrieve; the loop runs `execute_analytics_eql` / `execute_analytics` (`lib/mcp/tools.ts` L11 monitoring, L16 diagnostic) against the live Bloomreach source; the result is fed back as grounding context and the model generates a diagnosis or recommendation conditioned on it. The 60-second TTL cache (`lib/mcp/client.ts`) bounds how fresh the retrieved data is. What is absent is the *embedding-index retriever* — no chunking, no embeddings, no vector store, no cosine — because the data is a fresh, exact, queryable API where an index would be stale and lossy. The embedding-RAG path would live in `lib/mcp/` + `lib/state/` and is warranted only for the semantic-search-over-past-investigations feature. The `Project exercises` block below is the primary buildable target for that one threshold-crossing feature.

---

## Elaborate

### Where this pattern comes from

RAG was named by Lewis et al. (2020) — retrieve passages with a dense retriever, condition generation on them — as a fix for two LLM failures: hallucination (answering from priors) and stale knowledge (frozen training cutoff). It became the dominant pattern for grounding LLMs in private/current data. The live-tool variant emerged with tool-use/function-calling and the Model Context Protocol (MCP): instead of pre-indexing a corpus, let the model call a live API at query time. Both ground the answer in retrieved context; they differ only in whether the retriever reads a cached index or a live source. Anthropic's "Building effective agents" frames tool-use retrieval as the agentic counterpart to RAG.

### The deeper principle

```
  grounding need                 best retriever
  ─────────────────────────────  ─────────────────────────────
  current, exact, queryable      live tool call (read the source)
  static, fuzzy, free-text       embedding index (RAG)
  both in one corpus             hybrid (live + index)
  rule: the retriever follows the DATA's shape, not fashion
```

The senior insight is that "RAG" is not synonymous with "embedding index." RAG is retrieve-then-generate; the retriever is a pluggable choice driven by the data. Treating embedding-RAG as mandatory for any AI feature is the over-engineering trap this codebase avoided.

### Where this breaks down

1. **Live retrieval has latency and rate limits.** Each retrieval is a network call to Bloomreach, rate-limited to ~1 req/sec (`lib/mcp/connect.ts`), so an agent makes 6–13 sequential calls per investigation. An embedding index answers in microseconds. For high-QPS fuzzy search, live retrieval is too slow — but blooming insights' workload is a handful of deep investigations, not high-QPS search.

2. **Live retrieval cannot do semantic recall.** "Find investigations *like* this" is a fuzzy query over free text — exactly what an embedding index does and a live exact API cannot. This is the one threshold where RAG is warranted.

3. **No grounding corpus of its own.** blooming insights has no document knowledge base to answer from; it answers purely from live analytics. If the product needed to ground answers in static docs (a playbook, past write-ups), that corpus would need an embedding index — live tools cannot retrieve from a corpus that is not a queryable API.

### What to explore next

- **Tool calling** (`../04-agents-and-tool-use/02-tool-calling.md`): the live-retriever mechanism — `tool_use` → run → `tool_result`.
- **Dense vs. sparse** (`05-dense-vs-sparse.md`): why live EQL is sparse/exact and embedding-RAG is dense/fuzzy.
- **GraphRAG** (`12-graphrag.md`): the graph-shaped retrieval the Bloomreach schema would suit.
- **Stale embeddings** (`09-stale-embeddings.md`): the freshness cost an index adds that live retrieval avoids.

---

## Project exercises

### Build the one threshold-crossing feature: semantic search over past investigations

- **Exercise ID:** C2.1 pipeline (adapted) — the primary buildable target and the *only* feature that justifies embedding-RAG here.
- **What to build:** the full classic-RAG pipeline, scoped to past investigations only: chunk them (`03`), embed the chunks (`01`) with a chosen model (`02`), store vectors in a Tier-0/1 index (`04`), and answer "find investigations similar to this" by retrieving the nearest chunks and grounding the model's summary in them. Keep all analytics retrieval on live tools — RAG applies only to the free-text narratives.
- **Why it earns its place:** demonstrates you can build a complete RAG pipeline *and* that you scoped it precisely to the one feature whose data (static free-text narratives) actually needs it, leaving exact analytics on live tools — the judgment that separates "RAG everything" from "RAG where it earns its place."
- **Files to touch:** new `lib/mcp/retrieval.ts` (the RAG pipeline), `lib/mcp/embeddings.ts` + `lib/mcp/vector-store.ts` + `lib/mcp/chunking.ts` (from earlier files), `lib/state/investigations.ts` (source corpus), a new route or branch in `app/api/agent/route.ts`, new `test/mcp/retrieval.test.ts`.
- **Done when:** "find past investigations like this mobile-checkout issue" retrieves a relevant prior investigation phrased in different words and grounds a summary in it, while every analytics question still goes through `execute_analytics_eql`.
- **Estimated effort:** 1–2 days

### Write the decision record: live retrieval vs. embedding-RAG

- **Exercise ID:** C2.1 (adapted) — defend the architecture.
- **What to build:** a short architecture decision record (ADR) that states, for blooming insights' data, why live tool retrieval is the chosen retriever (fresh, exact, queryable API) and embedding-RAG is deferred (would be stale, lossy, and an operational burden), naming the single threshold (semantic search over past investigations) that would flip the decision.
- **Why it earns its place:** the ability to *defend* a no-RAG decision with the data's properties — not fashion — is the senior signal this whole sub-section exists to produce.
- **Files to touch:** new `docs/adr/retrieval-strategy.md` (the decision record), cross-referencing `lib/mcp/tools.ts`, `lib/mcp/client.ts`, and `lib/agents/base.ts`.
- **Done when:** the ADR names the three data properties (freshness, exactness, queryable source), maps each to why live retrieval wins, and states the one feature that would justify adding embedding-RAG.
- **Estimated effort:** <1hr

---

## Interview defense

### What an interviewer is really asking

"How does your system do RAG?" tests whether you understand RAG as retrieve-then-generate with a pluggable retriever — and whether you can *defend* not using an embedding index. The senior signal is naming the live-tool retriever, explaining why the data's shape (fresh, exact, queryable) makes an embedding index the wrong copy-of-a-source, and naming the exact threshold (fuzzy free-text recall) that would flip the decision. "We don't use RAG" is a junior answer; "we do retrieval-augmented generation with a live tool because our data is a fresh exact API, and we'd add an embedding index only for semantic search over past investigations" is the senior one.

### Likely questions

**[mid] What is RAG and why does an LLM need it?**

RAG retrieves relevant context at query time and puts it in the prompt so the model answers from real data, not frozen training-time priors. An LLM's weights know nothing about your current, specific data, so without retrieval it hallucinates. blooming insights retrieves live analytics via a tool and grounds the diagnosis in the result.

```
no retrieval → answer from priors → hallucination
retrieve (live tool) → ground in real data → correct
```

**[senior] Why no embedding index — isn't that "real" RAG?**

Because RAG is retrieve-then-generate, and the retriever is a choice. The data is a live analytics API returning exact aggregates. An embedding index would be a *copy* of that — stale until re-embedded (`09`), lossy (an embedding of "1,432" is a fuzzy point, not the number), and an operational burden (incremental indexing, `10`) to keep in sync with a source you can just query. Live retrieval is fresh, exact, and index-free.

```
embedding index = stale + lossy + maintained copy of a live exact API
live tool       = fresh + exact + nothing to maintain
```

**[arch] When would you add an embedding index?**

For exactly one feature: semantic search over past investigations — "find work like this." That data is static free-text narratives, not a live exact API, so a fuzzy nearest-neighbor query is the right tool and the embedding index earns its place. Until that feature exists, an index solves a problem the codebase does not have. The rule: no embedding index until a feature provably needs fuzzy recall over non-API data.

```
exact analytics question → live tool (current)
"find similar past work"  → embedding RAG (add WHEN built)
```

### The question candidates always dodge

**"Isn't not using a vector database just an excuse for not building RAG?"** No — and conflating "RAG" with "vector database" is the tell. The codebase *does* retrieval-augmented generation; it grounds every answer in retrieved context via live tools. What it declines is the embedding-index *implementation* of the retriever, for a defensible reason: the data is a fresh, exact, queryable API, so an index would be a stale lossy copy. The senior move is defending the retriever choice on the data's properties and naming the one threshold that flips it — not apologizing for a missing vector DB.

### One-line anchors

- `lib/mcp/tools.ts` L11/L16 — `execute_analytics_eql`: the live-tool retriever.
- `lib/agents/base.ts` — the agent loop that runs retrieval and grounds generation.
- `lib/mcp/client.ts` — the 60s TTL: how fresh the live retrieval is (and why no staleness, `09`).
- RAG = retrieve-then-generate; the retriever is pluggable (live tool vs. embedding index).
- No embedding index until a feature provably needs fuzzy recall over non-API data.

---

## Validate

### Level 1 — Reconstruct

From memory, draw RAG as retrieve-then-generate with the retriever as a swappable box, and fill in the two implementations (embedding index, live tool). State which one blooming insights uses and the three data properties that justify it.

### Level 2 — Explain

Out loud: why is "we don't use RAG" the wrong way to describe blooming insights? Why would an embedding index over the analytics data be a stale, lossy copy?

### Level 3 — Apply

Scenario: a PM asks for "find past investigations similar to this one." Open `lib/mcp/tools.ts` L11/L16 (the live retriever) and `lib/state/investigations.ts` (the free-text corpus). Explain why this single feature crosses the threshold to embedding-RAG while every analytics question stays on live tools, and which earlier files (`01`, `03`, `04`) you would build for it.

### Level 4 — Defend

A reviewer says "every serious AI product uses a vector database; add one." Defend live-tool retrieval using the data's properties (fresh, exact, queryable), the costs an index would add (staleness `09`, lossiness, incremental indexing `10`), and the precise threshold (fuzzy free-text recall) that would actually justify the index. Then concede what live retrieval gives up (semantic recall, microsecond latency) and why it does not bite the workload.

### Quick check — code reference test

Does blooming insights do RAG, and what is its retriever? (Answer: yes — it does retrieval-augmented generation with a *live tool* as the retriever: the agent loop runs `execute_analytics_eql` / `execute_analytics` (`lib/mcp/tools.ts` L11/L16) against Bloomreach and grounds the answer in the fresh result; it deliberately has no embedding-index retriever because the data is a fresh, exact, queryable API where an index would be stale and lossy.)

## See also

→ ../04-agents-and-tool-use/02-tool-calling.md · → 05-dense-vs-sparse.md · → 09-stale-embeddings.md · → 12-graphrag.md · → 01-embeddings.md

---
Updated: 2026-05-28 — corrected one stale ref: `maxDuration: 60` → `maxDuration = 300`. Case-B rationale (live tool retrieval over embedding-RAG) unchanged.
Updated: 2026-05-30 — Migrated to study.md v1.47 template (Phase 1+2 mechanical): removed Tradeoffs / Tech reference / Summary sections; renamed "In this codebase" → "Implementation in codebase"; moved See also to a bottom block. "Why care" preserved pending Phase 3 (Zoom out, then zoom in + LAYERS diagram) authoring.
Updated: 2026-05-30 — Phase 3 of study.md v1.47 migration: replaced "Why care" block with "Zoom out, then zoom in" (LAYERS diagram + zoom-in paragraph) per format.md.
Updated: 2026-05-31 — Applied study.md v1.48: scrubbed "How it works" of file paths, line refs, and real-code fences; replaced with generic role labels + pseudocode per format.md. Codebase-specific anchoring lives exclusively in "Implementation in codebase".
