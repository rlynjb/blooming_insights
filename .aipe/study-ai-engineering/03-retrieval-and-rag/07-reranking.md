# Reranking (a second-stage scorer that fixes the order)

**Industry name(s):** reranking, cross-encoder reranking, two-stage retrieval (retrieve-then-rerank)
**Type:** Industry standard · Language-agnostic

> Reranking is a precise but slow second-stage scorer (a cross-encoder) that re-orders the top-N candidates a fast first-stage retriever returned — you retrieve broadly for recall, then rerank narrowly for precision, putting the best document first where the model actually reads it; blooming insights does no retrieval ranking, so this is study material and a buildable target.


---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Reranking is the *second pass* in a retrieval pipeline — it sits between the fast retriever (or hybrid fusion) and the LLM context. The first stage optimizes recall over thousands; the reranker optimizes precision over the top ~20. blooming insights has neither retriever nor reranker; this is the layer that would directly mitigate lost-in-the-middle (→ ../02-context-and-prompts/02-lost-in-the-middle.md) by ensuring the genuinely-best evidence lands at position 1 of what enters the prompt.

```
  Zoom out — where the reranker sits (WOULD BE)

  ┌─ Retriever / hybrid fusion ──────────────────────┐
  │  fast first stage → top-20 candidates             │
  │  scores query and docs INDEPENDENTLY (cheap)      │
  └─────────────────────────┬────────────────────────┘
                            │  top-20 (good set, rough order)
  ┌─ Reranker (second pass) ▼────────────────────────┐  ← we are here
  │  ★ cross-encoder: score (query, doc) TOGETHER ★   │
  │  one model pass per candidate                    │
  │  accurate, but only affordable over a short list  │
  └─────────────────────────┬────────────────────────┘
                            │  top-3 (best first)
  ┌─ LLM context ───────────▼────────────────────────┐
  │  best evidence at position 1 → not lost-in-middle │
  └──────────────────────────────────────────────────┘

  In this codebase: Not yet implemented — String.includes
  intent matching in lib/agents/intent.ts is what exists
  instead; tool results are appended in tool-call order with
  no relevance reorder before they enter the model context.
```

**Zoom in — narrow to the concept.** The question is: given a good-but-roughly-ordered candidate set from a fast retriever, how do you put the genuinely most relevant item first before the LLM reads it? Cosine and BM25 score query and document independently — fast but coarse. A reranker (a cross-encoder) scores them *together* in one model pass — far more accurate, far too slow over thousands, exactly right over twenty. How it works walks the bi-encoder/cross-encoder split, why cross-encoding is more accurate, and the lost-in-the-middle payoff of putting the best result first.

---

## Structure pass

**Layers.** Three WOULD-BE layers in a two-stage retrieval pipeline: the fast first-stage retriever (recall over thousands, scores query and doc *independently*), the second-stage reranker (precision over ~20, scores them *together* in one model pass), and the LLM context that finally consumes the reordered top-3. Each stage has opposite tradeoffs and exists because the other can't do both jobs.

**Axis: cost.** What does each layer pay per candidate, and over how many candidates is that price paid? This axis is the right lens because the entire two-stage shape is a *cost-vs-precision* division of labor — the cheap stage handles volume, the expensive stage handles the short list. The load-bearing question is "how many candidates can I afford to run this scorer over?"

**Seams.** The cosmetic seam is between retriever and reranker as ranked-list pipes — both produce ordered candidates. The load-bearing WOULD-BE seam is *inside* that transition: cost-per-candidate flips from cheap-independent (cosine/BM25) to expensive-joint (cross-encoder). This is the seam that makes two-stage retrieval cheaper than running the cross-encoder over everything. A second consequence sits sideways — reranking's payoff is lost-in-the-middle mitigation (best result at position 1), connecting back to → ../02-context-and-prompts/02-lost-in-the-middle.md.

```
  Structure pass — reranking (WOULD BE)

  ┌─ 1. LAYERS ───────────────────────────────────┐
  │  first-stage retriever (cheap, over thousands) │
  │  reranker / cross-encoder (precise, over ~20)  │
  │  LLM context (best result at position 1)       │
  └────────────────────────┬───────────────────────┘
                           │  pick the axis
  ┌─ 2. AXIS ─────────────▼────────────────────────┐
  │  cost: what does each layer pay per candidate, │
  │  over how many candidates?                     │
  └────────────────────────┬───────────────────────┘
                           │  trace across layers, find flips
  ┌─ 3. SEAMS ────────────▼────────────────────────┐
  │  retriever↔reranker pipe: cosmetic             │
  │  cheap-independent ↔ expensive-joint:          │
  │    LOAD-BEARING                                │
  │    division of labor: volume vs precision      │
  │    payoff: best at pos 1 (mitigates middle)    │
  └────────────────────────┬───────────────────────┘
                           ▼
                   Block 4 — How it works
```

The skeleton is mapped — the rest of this file walks the mechanics that hang off it.

## How it works

**Mental model.** Two stages with opposite tradeoffs. Stage 1 (retrieval) is a cheap filter run over everything: like `array.filter()` narrowing a million rows to 20. Stage 2 (rerank) is an expensive precise sort run only over those 20: like an `array.sort()` whose comparator calls an API. You would never run the expensive comparator over a million; you run it over the short list the cheap filter produced.

```
  Stage 1: RETRIEVE (fast, recall)        Stage 2: RERANK (slow, precision)
  ──────────────────────────────────      ──────────────────────────────────
  scan millions, score independently      score top-20 query+doc together
  embedding cosine / BM25 / hybrid        cross-encoder, one pass each
  → top-20 (right docs, rough order)      → top-20 reordered, best first
       │                                       │
       └──────────── feed 20 into ────────────┘ → keep top-3 for the prompt
```

The body walks why the two stages must differ and how the reranker scores.

---

### Stage 1 vs. Stage 2: bi-encoder vs. cross-encoder

The first-stage retriever is a *bi-encoder*: it embeds the query and each document *separately* into vectors, then compares the vectors. Separate encoding is what makes it fast — documents are pre-embedded once and the query is embedded once, so retrieval is just cosine math. But the document never "sees" the query during encoding, so the comparison is coarse.

```
  bi-encoder (Stage 1, retrieval)
  query ──embed──▶ q
  doc   ──embed──▶ d   (precomputed)
  score = cosine(q, d)        ← query and doc encoded SEPARATELY
                                  fast, scannable, coarse
```

The reranker is a *cross-encoder*: it feeds the query and one candidate document *together* into the model and outputs a single relevance score. The document sees the query, so the score captures fine interactions (does this passage actually answer *this* question?). But you must run the model once per candidate — far too slow for millions, fine for 20.

```
  cross-encoder (Stage 2, rerank)
  [query + doc] ──▶ model ──▶ relevance score   ← encoded TOGETHER
                                  accurate, slow (one pass per candidate)
```

### Retrieve broad, rerank narrow

The pattern's whole economy is: retrieve *more* than you need (top-20) so the right document is somewhere in the set (recall), then rerank to surface it (precision), then keep only what fits the prompt (top-3).

```
  millions ──retrieve top-20──▶ 20 candidates ──rerank──▶ reordered ──keep top-3──▶ prompt
            (recall: right docs    (rough order)  (precision:        (fits budget)
             are in the set)                       best first)
```

If the retriever's recall is bad (the right doc is not even in the top-20), reranking cannot save you — it only reorders what it is given. Recall is stage 1's job; precision is stage 2's.

### Why order matters: lost-in-the-middle

Reranking is not only about *which* documents — it is about *position*. A model attends most to the beginning and end of its context and least to the middle (`../02-context-and-prompts/02-lost-in-the-middle.md`). Putting the best-reranked document first (or last) means the model actually reads the evidence that matters; leaving it mid-list risks the model skimming past it even though it is present.

```
  attention across context position
  high │█                          █
       │█                          █
       │ █                        █
       │  █                      █
  low  │    ████████████████████
       └──────────────────────────────▶ position
        start      MIDDLE (dead)    end
        ▲ put the best-reranked doc HERE (and/or end)
```

So the reranked order feeds directly into a placement decision: best document at a high-attention position, not buried in the dead zone.

### The principle

Separate recall from precision into two stages with opposite cost profiles: a cheap independent-scoring retriever that gets the right candidates *into* a short list, then an expensive joint-scoring reranker that orders that short list correctly. Run the accurate-but-slow scorer only where it is affordable — over the handful the cheap filter produced — and then place the winner where the model will actually read it. It is the universal "filter cheap, sort expensive, present carefully" pipeline.

---

## Reranking — diagram

This diagram spans the Service layer (two-stage pipeline) into the prompt placement. A reader who sees only this should grasp the retrieve-broad / rerank-narrow / place-carefully flow.

```
┌──────────────────────────────────────────────────────────────────────┐
│  SERVICE LAYER  (would live in lib/mcp/retrieval.ts)                │
│                                                                      │
│  STAGE 1  retrieve (bi-encoder, fast, recall)                       │
│    query ──▶ cosine/BM25/hybrid over corpus ──▶ top-20 candidates   │
│                       │ (right docs, rough order)                   │
│  STAGE 2  rerank (cross-encoder, slow, precision)                   │
│    for each candidate: score([query + doc]) ──▶ reorder top-20      │
│                       │ (best first)                               │
│           keep top-3 that fit the prompt budget                    │
│                       ▼                                            │
└──────────────────────────┬───────────────────────────────────────────┘
                           │ placement
┌──────────────────────────▼───────────────────────────────────────────┐
│  PROMPT (lib/agents/prompts/*.md or schemaSummary)                  │
│   best-reranked doc at a HIGH-ATTENTION position (start/end),       │
│   not buried in the lost-in-the-middle dead zone                    │
└──────────────────────────────────────────────────────────────────────┘
```

Stage 1 gets the right docs in; stage 2 orders them right; placement puts the winner where the model reads.

---

## Implementation in codebase

**Not yet implemented.** blooming insights retrieves live via single-path sparse EQL with no candidate ranking step — there is no first-stage retriever returning a candidate set and no reranker reordering one.

There is one honest placement-side analog, though no reranker. `MonitoringAgent.scan` sorts its *output* anomalies by severity and truncates — `SEV_RANK` ordering then `.slice(0, 10)` (`lib/agents/monitoring.ts` L50, L92) — which is a "rank then keep top-k" shape, but it ranks *results by a fixed field*, not *retrieved candidates by query relevance*; it is not a cross-encoder rerank. Real reranking would sit between the dense/hybrid retriever (`05`/`06`) and the prompt assembly in a `lib/mcp/retrieval.ts`, and would inform where retrieved evidence lands in the prompt (the lost-in-the-middle placement). The `Project exercises` block below is the primary buildable target.

---

## Elaborate

### Where this pattern comes from

Two-stage retrieve-then-rerank is classic information retrieval: a cheap recall-oriented first pass (BM25) followed by an expensive precision-oriented re-scorer, long before neural models. The neural version arrived with cross-encoder rerankers (BERT-based, e.g. the MS MARCO rerankers, 2019) that score query+passage jointly. The RAG wave made it standard: retrieve with embeddings/hybrid, rerank with a dedicated model (Cohere Rerank, Voyage rerank, or an open cross-encoder), then feed the top few into the LLM. LLM-as-reranker (asking a chat model to score candidates) is a newer, costlier variant.

### The deeper principle

```
  stage         encoding            speed     accuracy   run over
  ──────────    ─────────────────   ───────   ────────   ──────────
  retrieve      bi (separate)       fast      coarse     millions
  rerank        cross (joint)       slow      precise    top-N (~20)
  rule          cheap for recall, expensive for precision, only on the short list
```

The pattern generalizes any time an accurate scorer is too slow to run over everything: filter to a candidate set with a cheap proxy, then apply the accurate scorer to the survivors. Reranking is that pattern applied to retrieval.

### Where this breaks down

1. **Rerankers cannot fix bad recall.** If the right document is not in the top-20 the retriever returned, the reranker never sees it. Reranking improves precision *within* the retrieved set; it cannot add documents. Recall is stage 1's responsibility.

2. **Latency and cost per candidate.** A cross-encoder runs one model pass per candidate — rerank 20 and you pay 20 inferences. Over-retrieving for recall (top-100) multiplies the rerank cost. The N you rerank is a recall/cost tradeoff.

3. **Reordering is wasted if placement ignores it.** Reranking the candidates and then dumping them all into the middle of a long prompt squanders the precision — the model still skims the dead zone. The reranked order only pays off if the top item lands at a high-attention position.

### What to explore next

- **Lost in the middle** (`../02-context-and-prompts/02-lost-in-the-middle.md`): why reranked order must drive prompt placement, not just truncation.
- **Hybrid retrieval** (`06-hybrid-retrieval-rrf.md`): the standard stage-1 feeding a reranker.
- **Reranking models:** Cohere Rerank, Voyage rerank, and open cross-encoders — the off-the-shelf stage-2 scorers.

---

## Project exercises

### Add a cross-encoder rerank stage over retrieved past investigations

- **Exercise ID:** B2A.11 (adapted) — the primary buildable target.
- **What to build:** between the dense/hybrid retriever (`05`/`06`) and prompt assembly, add `rerank(query, candidates, k)` that scores each retrieved candidate jointly with the query (a cross-encoder API or self-hosted model) and returns the top-k reordered. Then place the top-ranked evidence at a high-attention prompt position.
- **Why it earns its place:** demonstrates the retrieve-broad / rerank-narrow split and that you connect reranked order to prompt placement (lost-in-the-middle) — the full precision story.
- **Files to touch:** new `lib/mcp/retrieval.ts` (`rerank`), `lib/mcp/vector-store.ts` (stage-1 candidates), the prompt-assembly path (place best-first), new `test/mcp/retrieval.test.ts`.
- **Done when:** a query where the bi-encoder ranks the best document at position 5 has it promoted to position 1 after rerank, and that document is placed at a high-attention slot in the prompt.
- **Estimated effort:** 1–2 days

### Measure precision@3 with and without reranking

- **Exercise ID:** C2.6 (adapted) — quantify the rerank gain.
- **What to build:** a harness over labeled query→best-investigation pairs that reports precision@3 for retrieve-only vs. retrieve+rerank, plus the per-query latency cost of the rerank stage.
- **Why it earns its place:** shows you justify the reranker's added latency/cost with a measured precision gain, not a vibe.
- **Files to touch:** new `scripts/rerank-eval.ts`, `lib/mcp/retrieval.ts` (toggle rerank), `test/mcp/retrieval.test.ts`.
- **Done when:** the report shows a precision@3 improvement from reranking and the added latency, with a recommendation on whether the gain justifies the cost at current scale.
- **Estimated effort:** 1–4hr

---

## Interview defense

### What an interviewer is really asking

"What is reranking and why two stages?" tests whether you understand the recall-vs-precision split and the bi-encoder/cross-encoder cost asymmetry. The senior signal is explaining why the accurate scorer runs only on the short list, that reranking cannot rescue bad recall, and that reranked order must feed prompt placement (lost in the middle), not just truncation.

### Likely questions

**[mid] Why not just use the retriever's cosine order directly?**

Because the bi-encoder scores query and document *separately* — fast but coarse. The genuinely-best match can sit at position 5. A cross-encoder scores them *together* and reorders accurately, so the best document reaches position 1 where it fits the prompt budget.

```
bi-encoder: separate encoding → fast, coarse order
cross-encoder: joint encoding → slow, precise order
```

**[senior] Why can't you just rerank the whole corpus and skip retrieval?**

Because a cross-encoder runs one model pass per document — infeasible over millions per query. The first stage exists to cut the corpus to ~20 candidates the reranker can afford. It is the universal "cheap filter, expensive sort on the survivors" pattern. Reranking also cannot add documents the retriever missed — recall is stage 1's job.

```
cross-encoder over corpus → millions of inferences (infeasible)
retrieve 20, rerank 20 → 20 inferences (affordable)
```

**[arch] You reranked the candidates. How does that change what you put in the prompt?**

Reranked order drives *placement*, not just truncation. Models attend to the start and end of context and skim the middle, so the top-reranked evidence goes to a high-attention slot — not buried mid-prompt where it gets skimmed even though it is present. Reordering without placement wastes the precision.

```
reranked best doc → prompt start/end (high attention)
not → prompt middle (lost-in-the-middle dead zone)
```

### The question candidates always dodge

**"What does reranking *not* fix?"** Recall. Candidates skip the trap of thinking a reranker improves the result set — it only reorders what stage 1 retrieved. If the right document is not in the top-20, no reranker can surface it. Naming recall as stage 1's job and precision as stage 2's is the senior distinction.

### One-line anchors

- `lib/agents/monitoring.ts` L50, L92 — `SEV_RANK` sort + `slice(0,10)`: ranks results by a field, not a query-relevance reranker.
- Stage 1 bi-encoder (recall, fast) → Stage 2 cross-encoder (precision, slow).
- Retrieve broad, rerank narrow; run the accurate scorer only on the short list.
- Reranking cannot fix bad recall — it only reorders the retrieved set.
- Reranked order must drive prompt placement (lost in the middle), not just truncation.

---

## See also

→ 06-hybrid-retrieval-rrf.md · → 01-embeddings.md · → ../02-context-and-prompts/02-lost-in-the-middle.md · → 11-rag.md
