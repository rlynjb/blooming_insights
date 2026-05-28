# Dense vs. sparse retrieval (meaning vs. exact terms)

**Industry name(s):** dense retrieval (embeddings), sparse retrieval (BM25 / keyword / lexical), lexical vs. semantic search
**Type:** Industry standard · Language-agnostic

> Dense retrieval matches on *meaning* (embedding cosine) and sparse retrieval matches on *exact terms* (keyword/BM25 over a structured field); each fails where the other wins, and blooming insights' EQL queries are pure structured/keyword retrieval — the sparse end of the spectrum, with no dense side at all.

**See also:** → 01-embeddings.md · → 06-hybrid-retrieval-rrf.md · → 07-reranking.md · → 11-rag.md

---

## Why care

Every retrieval blooming insights does today is sparse. When the diagnostic agent runs `execute_analytics_eql` (`lib/mcp/tools.ts` L16), it sends an exact, structured query — specific event names, specific property filters, an exact time window — and gets back exactly the rows that match those terms. There is no "find me events *similar to* checkout"; there is only "find me rows *where* `event = checkout_started`." That is the sparse, lexical end of the retrieval spectrum, and it is the only end the codebase uses.

The question dense-vs-sparse answers is: when you look something up, do you match on exact terms or on meaning — and which one does your query actually need?

**The pivot: exact-term matching nails identifiers and fails synonyms; meaning matching nails synonyms and blurs identifiers — and choosing wrong silently returns the unhelpful neighbor.** A query for `event_4471` must match `event_4471` exactly; a dense embedding would happily return `event_4472` as "close." A query for "abandoned purchases" must find the `checkout_started`-without-`purchase` pattern; a sparse keyword search finds neither word. The two methods have opposite strengths, and most real questions need both.

Before understanding the split:
- You assume "retrieval" means embeddings (dense) and reach for them reflexively
- An exact-ID or exact-event-name lookup returns a near-miss neighbor
- Or: you keyword-search a meaning question and get nothing

After:
- You classify the query: exact term (sparse) or meaning (dense)?
- EQL/keyword for exact event names, IDs, filters; embeddings for synonyms and paraphrase
- The hard cases that need both are routed to hybrid (`06-hybrid-retrieval-rrf.md`)

It is the same distinction as `array.find(x => x.id === id)` (exact) versus `nearestByCosine(embed(query))` (meaning) — and EQL is firmly the `===` side.

---

## How it works

**Mental model.** Think of two index shapes. A *sparse* index maps each term to the documents containing it — a `Map<term, docId[]>`, mostly empty per document (a document "contains" only a few hundred of the millions of possible terms, so its term-vector is almost all zeros: *sparse*). A *dense* index maps each document to a short float array where nearly every entry is non-zero (*dense*). Sparse matches by shared terms; dense matches by vector closeness.

```
  sparse (keyword / EQL)              dense (embedding)
  ──────────────────────────         ──────────────────────────
  "checkout_started" → [doc 3, 7]    doc 3 → [0.2, -0.1, 0.5, ...]
  match = shares the exact term       match = small cosine angle
  "checkout" ≠ "purchase" (no match)  "checkout" ≈ "purchase" (close)
  exact, explainable                  fuzzy, opaque
```

The body walks each side and where each breaks.

---

### Sparse retrieval: exact terms (EQL, BM25, keyword)

Sparse retrieval scores documents by the query terms they contain, classically with BM25 (term frequency, weighted by how rare the term is across the corpus). Its structured cousin — and the only retrieval blooming insights does — is a query language that filters by exact field values. EQL (`execute_analytics_eql`, `lib/mcp/tools.ts` L11/L16) is exactly this: you name the event, the properties, the window, and the engine returns the rows that *exactly* match.

```
  EQL-style sparse query
  ──────────────────────────────────────────────
  SELECT count() WHERE event = 'checkout_started'
                   AND  device = 'mobile'
                   AND  ts > now() - 90d
  ──────────────────────────────────────────────
  returns: EXACTLY the matching rows (no "similar" rows)
```

Sparse retrieval is exact, fast, explainable (you can read why a row matched), and perfect for identifiers, enums, and filters. It is blind to meaning: ask for `purchase` and it will never volunteer `sale` or `transaction_completed`.

### Dense retrieval: meaning (embeddings)

Dense retrieval embeds the query and the documents and ranks by cosine similarity (`01-embeddings.md`). It matches paraphrases and synonyms because closeness is in meaning-space, not term-space.

```
  dense query
  ──────────────────────────────────────────────
  embed("abandoned purchases") = q
  rank docs by cosine(q, doc_vec)
  ──────────────────────────────────────────────
  returns: docs ABOUT cart abandonment, even with no shared words
```

Dense retrieval is fuzzy, captures intent, and survives spelling/vocabulary mismatch. It is bad at exact identity (blurs near-identical IDs) and opaque (no readable reason for a match).

### The strengths are mirror images

```
  query type                  sparse (EQL/BM25)   dense (embedding)
  ────────────────────────    ─────────────────   ─────────────────
  exact event name            ✓ exact             ~ may drift
  exact ID / enum             ✓ exact             ✗ blurs neighbors
  numeric/time filter         ✓ native            ✗ not its job
  synonym / paraphrase        ✗ misses            ✓ matches
  "things like X"             ✗ no notion          ✓ native
  rare exact keyword          ✓ BM25 weights it   ~ may underweight
```

Where one column has a ✓ the other tends to have an ✗. This mirror-image property is the entire motivation for hybrid retrieval (`06-hybrid-retrieval-rrf.md`): run both and fuse, so a query gets the exact-term hits *and* the meaning hits.

### Why EQL alone is the right call for blooming insights' data

blooming insights queries *analytics* — counts, conversion rates, funnels over named events in a known schema. Those questions are exact by nature: "how many `checkout_started` on mobile in the last 90 days" has one correct answer, retrievable only by exact-term filtering. There is no "documents similar to this count." Dense retrieval has nothing to add to an exact aggregate, and would *hurt* (a "close" event is the wrong event). Sparse/structured EQL is not a limitation here — it is the correct match for the data.

```
  analytics question          retrieval that fits
  ──────────────────────────  ──────────────────────────────
  "count of event X"          EQL exact filter (sparse) ✓
  "conversion on mobile"      EQL exact filter (sparse) ✓
  "investigations LIKE this"  embedding (dense) — a DIFFERENT feature
```

The dense side only becomes relevant for a *different* feature — semantic search over past investigation narratives — which is the deferred RAG decision in `11-rag.md`.

### The principle

Retrieval has two axes — exact terms and meaning — and they fail on opposite inputs, so the method must match the query's nature: identifiers, enums, and filters want exact (sparse) matching; synonyms and paraphrase want meaning (dense) matching. blooming insights' analytics questions are exact, so sparse EQL is not a gap to fill but the correct tool; the dense side is reserved for the genuinely fuzzy question — "what past work resembles this?" — and added only when that feature exists.

---

## Dense vs. sparse — diagram

This diagram spans the Service layer (the two retrieval paths) and shows where blooming insights sits (sparse only). A reader who sees only this should grasp that the two methods have mirror-image strengths and that EQL is pure sparse.

```
┌──────────────────────────────────────────────────────────────────────┐
│  SERVICE LAYER  (retrieval methods)                                  │
│                                                                      │
│   query                                                              │
│     ├──────────────────────────┬─────────────────────────────────┐  │
│     ▼                          ▼                                  │  │
│  SPARSE (exact terms)       DENSE (meaning)                       │  │
│  EQL / BM25 / keyword       embedding cosine                      │  │
│  ┌────────────────────┐     ┌────────────────────┐               │  │
│  │ event = 'purchase' │     │ embed(q) · doc_vec │               │  │
│  │ device = 'mobile'  │     │ rank by closeness  │               │  │
│  │ exact, explainable │     │ fuzzy, opaque      │               │  │
│  └─────────┬──────────┘     └─────────┬──────────┘               │  │
│            │                          │                          │  │
│   ✓ IDs/enums/filters         ✓ synonyms/paraphrase             │  │
│   ✗ synonyms                  ✗ exact IDs (blurs)               │  │
│     │                                                            │  │
│     └── blooming insights uses ONLY this side (execute_analytics_eql)│
│         the analytics questions are exact by nature              │  │
└──────────────────────────────────────────────────────────────────────┘
```

The two columns are mirror images; blooming insights lives entirely in the left column because its data demands exact answers.

---

## In this codebase

**Not yet implemented (dense side).** blooming insights retrieves live via MCP tool calls + EQL against Bloomreach — pure structured/keyword (sparse-like) querying — and has no embedding/dense retrieval at all.

The honest analog is that EQL *is* the sparse end of the spectrum, fully present and correct. The diagnostic and monitoring agents call `execute_analytics_eql` (`lib/mcp/tools.ts` L11 for monitoring, L16 for diagnostic) and `execute_analytics` to ask exact, structured questions — named events, property filters, time windows — and receive exactly the matching aggregates. That is sparse/lexical retrieval by another name: matching on exact terms, not meaning. There is deliberately no dense counterpart, because analytics questions have exact answers and a "similar" event is the wrong event. A dense retrieval path would only appear for a semantic-search-over-past-investigations feature, living alongside `lib/state/investigations.ts`. The `Project exercises` block below is the primary buildable target for that dense side.

---

## Elaborate

### Where this pattern comes from

Sparse retrieval is the older discipline — the inverted index (term → document list) is the foundation of every search engine since the 1960s, refined into TF-IDF and then BM25 (Robertson & Walker, 1994), still the strongest pure-lexical ranker. Dense retrieval arrived with learned embeddings: DPR (Dense Passage Retrieval, 2020) showed embeddings could beat BM25 on open-domain QA, and the RAG wave made dense the default. The field then rediscovered that BM25 still wins on exact-term and rare-term queries, producing the now-standard hybrid (`06`). Learned-sparse models (SPLADE) sit in between — sparse vectors with learned term weights.

### The deeper principle

```
  axis                what it matches        fails on
  ─────────────────   ────────────────────   ─────────────────────
  sparse (lexical)    exact terms            synonyms, paraphrase
  dense (semantic)    meaning / intent       exact IDs, rare terms
  hybrid              both (fused)           more compute, tuning
```

Neither axis dominates; they are complementary because their failure modes do not overlap. The mature retrieval system runs both and fuses — but only after confirming the data actually has a meaning-axis to exploit, which analytics aggregates do not.

### Where this breaks down

1. **Sparse misses vocabulary mismatch.** EQL cannot answer "abandoned purchases" if the schema names it `checkout_started` without `purchase` — the words do not match. For analytics this is fine (the agent knows the schema names); for free-text it is a real gap dense fills.

2. **Dense blurs exact identity.** An embedding ranks `event_4471` and `event_4472` as near-identical. For ID lookup this is a correctness bug, not a fuzziness feature. Never use dense alone where exactness is required.

3. **Sparse over rare terms can be brittle, dense over rare terms can be weak.** A rare but critical keyword (a specific error code) is BM25's strength (rare = high weight) but a weak embedding signal (under-represented in training). This is a classic hybrid-wins case.

### What to explore next

- **Hybrid retrieval + RRF** (`06-hybrid-retrieval-rrf.md`): run both and fuse the rankings — the production default when a corpus has both exact and fuzzy queries.
- **Reranking** (`07-reranking.md`): a second-stage scorer over the merged candidates.
- **Embeddings** (`01-embeddings.md`): the mechanism behind the dense side.

---

## Tradeoffs

### Sparse-only (current, EQL) vs. dense-only vs. hybrid

| Dimension | Sparse only (EQL, current) | Dense only (embeddings) | Hybrid |
|---|---|---|---|
| Exact event/ID/filter | Exact | Blurs neighbors | Exact (sparse leg) |
| Synonym / paraphrase | Misses | Matches | Matches (dense leg) |
| Explainability | High (readable filter) | Low (opaque vector) | Medium |
| Infrastructure | None beyond the query engine | Embedding + vector store | Both + fusion |
| Right for analytics aggregates | Yes — exact by nature | No — wrong "close" answer | Overkill |
| Right for free-text past work | No — vocabulary mismatch | Yes | Best |

**What we gave up (by being sparse-only).** Nothing for the analytics use case — EQL's exactness is exactly right for counts, rates, and funnels, where a "similar" event is simply the wrong event. The only thing forgone is meaning-based retrieval over *free text*, which the product does not currently do; there is no free-text corpus to retrieve.

**What the alternative would have cost.** Adding dense retrieval to the analytics path would be actively harmful: an embedding's "close" event is the wrong event for an exact aggregate, and you would pay embedding + vector-store cost to introduce errors. Dense earns its place only on a fuzzy corpus (past investigation narratives), not on structured analytics.

**The breakpoint.** Sparse-only is correct as long as every retrieval is an exact analytics question. It needs a dense complement the moment the product retrieves over *natural-language* content — "find past investigations similar to this one" — where vocabulary mismatch (synonyms, paraphrase) makes exact-term matching miss, and that is precisely the deferred-RAG threshold in `11-rag.md`.

---

## Tech reference (industry pairing)

### sparse / lexical retrieval

- **Codebase uses:** EQL via `execute_analytics_eql` (`lib/mcp/tools.ts` L11/L16) and `execute_analytics` — exact structured querying, the sparse end fully present.
- **Why it's here:** analytics questions have exact answers retrievable only by exact-term/field filtering; a "similar" event is the wrong event.
- **Leading today:** BM25 (via Elasticsearch/OpenSearch) leads lexical retrieval; SPLADE leads learned-sparse (2026).
- **Why it leads:** BM25's rarity weighting nails exact and rare-term queries that dense underweights; learned-sparse adds semantics while staying invertible.
- **Runner-up:** plain TF-IDF — simpler than BM25, still effective for small lexical corpora.

### dense / semantic retrieval

- **Codebase uses:** nothing — no embeddings or cosine retrieval.
- **Why it's here (absent):** there is no free-text corpus whose meaning must be matched; analytics is exact.
- **Leading today:** embedding retrieval over a vector index (text-embedding-3 / Voyage + Qdrant/pgvector) leads semantic search (2026).
- **Why it leads:** matches synonyms and paraphrase that lexical search misses entirely.
- **Runner-up:** DPR-style dual-encoder retrieval — the research lineage, now generalized by hosted embedding models.

---

## Project exercises

### Add a dense retrieval path for past investigations (alongside sparse EQL)

- **Exercise ID:** B2A.6 / B2A.10 (adapted) — the primary buildable target.
- **What to build:** embed past-investigation chunks (`03-chunking-strategies.md`) and expose `searchInvestigations(query, k)` that ranks by cosine — the dense complement to the agents' sparse EQL. Keep the analytics path purely sparse; the dense path serves only the free-text "similar past work" question.
- **Why it earns its place:** demonstrates you place dense retrieval only where meaning-matching is needed (free text) and keep exact analytics on sparse EQL — the discriminating judgment.
- **Files to touch:** new `lib/mcp/retrieval.ts` (`searchInvestigations`), `lib/mcp/embeddings.ts` + `lib/mcp/vector-store.ts` (from earlier files), `lib/state/investigations.ts` (source documents), new `test/mcp/retrieval.test.ts`.
- **Done when:** a paraphrased query ("mobile cart issues") retrieves a past investigation about `checkout_started` drops on mobile that shares no exact keyword, while the analytics agents still use only `execute_analytics_eql`.
- **Estimated effort:** 1–2 days

### Demonstrate the mirror-image failure modes with a side-by-side harness

- **Exercise ID:** C2.4 (adapted) — dense-vs-sparse contrast.
- **What to build:** a small harness that runs the same query set through both a sparse (keyword over investigation text) and a dense (embedding) retriever and tabulates which queries each gets right — exact-ID/event-name queries (sparse wins) vs. synonym/paraphrase queries (dense wins).
- **Why it earns its place:** shows you can articulate and *measure* the complementary failure modes, the prerequisite for justifying hybrid (`06`).
- **Files to touch:** new `scripts/dense-vs-sparse.ts` (the harness), `lib/mcp/retrieval.ts` (both retrievers), `test/mcp/retrieval.test.ts`.
- **Done when:** the table shows an exact-event-name query where sparse wins and dense drifts, and a paraphrase query where dense wins and sparse returns nothing.
- **Estimated effort:** 1–4hr

---

## Summary

Retrieval has two axes: sparse (exact terms — keyword, BM25, EQL) and dense (meaning — embedding cosine), and they fail on opposite inputs, so the method must match the query's nature. blooming insights is pure sparse: every retrieval is an `execute_analytics_eql` call asking an exact, structured analytics question, which is the correct tool because aggregates have exact answers and a "similar" event is the wrong event. The dense side has nothing to add to analytics and is reserved for a genuinely fuzzy feature — semantic search over past investigations — which is the deferred-RAG decision elsewhere in this section.

**Key points:**
- Sparse matches exact terms (IDs, enums, filters); dense matches meaning (synonyms, paraphrase).
- Their failure modes are mirror images, which is why hybrid exists.
- EQL is pure sparse/structured retrieval — and it is correct for exact analytics.
- Dense retrieval would *hurt* exact aggregates (a "close" event is the wrong event).
- The dense axis earns its place only on a free-text corpus, not on structured analytics.

---

## Interview defense

### What an interviewer is really asking

"Dense or sparse retrieval?" tests whether you match the method to the query's nature rather than reflexively reaching for embeddings. The senior signal is naming the mirror-image failure modes, recognizing structured/keyword querying (EQL) as the sparse end, and defending sparse-only as *correct* for exact analytics rather than as a missing feature.

### Likely questions

**[mid] What's the difference between dense and sparse retrieval?**

Sparse matches exact terms — keyword/BM25 or a structured filter like EQL; a row matches if it contains the query's terms. Dense embeds query and documents and matches by cosine closeness in meaning-space, so synonyms and paraphrase match even with no shared words. Sparse is exact and explainable; dense is fuzzy and opaque.

```
sparse: event='purchase' → exact rows
dense:  embed("sales") ≈ "purchase" → close docs
```

**[senior] Why is blooming insights sparse-only, and is that a gap?**

Not a gap — a fit. Every retrieval is an exact analytics question (count of an event, conversion on mobile) answerable only by exact-term filtering via `execute_analytics_eql` (`lib/mcp/tools.ts` L16). A dense "close" event is the wrong event for an exact aggregate, so dense would introduce errors, not improve recall. Dense earns its place only on a free-text corpus.

```
analytics aggregate → exact answer → sparse EQL (correct)
"similar past work" → fuzzy → dense (a different feature)
```

**[arch] When would you add the dense side, and how would the two coexist?**

When the product retrieves over natural language — "find past investigations like this." Then run dense (embedding cosine over investigation narratives) for the fuzzy question and keep sparse EQL for exact analytics; they serve different queries, not the same one. If a single query needs both exact and fuzzy matching, fuse them with RRF (`06`).

```
exact analytics  → EQL (sparse)
free-text recall → embeddings (dense)
both in one query → hybrid + RRF
```

### The question candidates always dodge

**"Isn't sparse-only just a limitation you haven't fixed yet?"** No — and treating every sparse-only system as deficient is the tell. For exact analytics, sparse is not the floor, it is the ceiling: a meaning-based "close" answer to "how many checkouts" is simply wrong. The senior move is defending sparse-only as the correct tool for exact data and naming the specific (free-text) case where dense would add value.

### One-line anchors

- `lib/mcp/tools.ts` L11/L16 — `execute_analytics_eql`: exact structured querying, the sparse end.
- Sparse matches exact terms; dense matches meaning; failure modes are mirror images.
- EQL is sparse and *correct* for analytics — a "similar" event is the wrong event.
- Dense blurs exact IDs — a correctness bug, not a fuzziness feature.
- The dense axis earns its place only on a free-text corpus (past investigations).

---

## Validate

### Level 1 — Reconstruct

From memory, draw the two retrieval columns (sparse: exact terms; dense: meaning) and fill in three query types where each wins and each loses.

### Level 2 — Explain

Out loud: why are dense and sparse failure modes mirror images? Why would adding dense retrieval to an exact analytics query *hurt* rather than help?

### Level 3 — Apply

Scenario: a PM wants "find past investigations similar to this one." Open `lib/mcp/tools.ts` L15–L25 (the diagnostic agent's sparse EQL tools) and `lib/state/investigations.ts` (the free-text corpus). Explain why this new feature needs the dense axis (paraphrase/synonym) while the existing analytics agents must stay sparse, and where the dense retriever would live.

### Level 4 — Defend

A colleague says "embeddings are strictly more powerful than keyword search, replace EQL with a vector search." Argue why this breaks exact analytics (a "close" event is the wrong event, IDs blur), and why EQL's exactness is the correct tool for aggregates. Then concede the one place dense belongs (free-text past-investigation search).

### Quick check — code reference test

What kind of retrieval does blooming insights do, and which tool is the evidence? (Answer: pure sparse/structured retrieval — exact-term querying via `execute_analytics_eql` (`lib/mcp/tools.ts` L11 monitoring, L16 diagnostic) and `execute_analytics`; there is no dense/embedding retrieval, and sparse is the correct tool for exact analytics aggregates.)
