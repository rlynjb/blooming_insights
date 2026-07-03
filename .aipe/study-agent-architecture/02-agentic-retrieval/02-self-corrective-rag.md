# Self-corrective RAG

_Industry standard._

## Zoom out, then zoom in

Add a relevance grader between retrieval and generation, with a fallback path. **Not implemented.** No retrieval to grade. Covered for pattern-recognition and to name the shape that would arrive if RAG got introduced.

```
  Zoom out — where the grader would sit

  ┌─ Retrieval tool ─────────────────────────────────────────┐
  │  retrieve(query, k=5) → chunks[]                          │
  └───────────────────────┬──────────────────────────────────┘
                          │
  ┌─ Grader (NOT PRESENT) ▼──────────────────────────────────┐
  │  chunk[i] → relevant? grounded?                           │
  │  drop irrelevant · fall back if all irrelevant           │
  └───────────────────────┬──────────────────────────────────┘
                          ▼
                     generate answer
```

Zoom in: this file's job is to name the distinction between "retrieval success" (chunk came back) and "answer success" (chunk was actually relevant). The grader catches the gap.

## Structure pass

**Layers:** retrieve · grade (per chunk) · fallback (all irrelevant) · generate.
**Axis:** *what does relevant mean here?*
**Seam:** the grader's decision — cheap deterministic (BM25 score threshold?) or LLM (does this chunk address the query?).

```
  Retrieval success vs answer success

  chunk came back  ────────►  answer is grounded in it?
                                        │
                              ┌─────────┴─────────┐
                              ▼                   ▼
                            YES                  NO
                        generate           the grader would
                        (as usual)         drop this chunk
```

## How it works

### Move 1 — the mental model

You've built a fetch with a validation step before — `const res = await fetch(url); if (!isValid(res)) fallback();`. Self-corrective RAG is the same: retrieve first, validate the results, fallback to a different retrieval strategy if validation fails.

```
  Pattern: self-corrective RAG

  retrieve top-k ─────►  grade each chunk
                              │
                     ┌────────┴────────┐
                     ▼ relevant        ▼ not relevant
                 keep + generate    fallback:
                                      - rewrite query
                                      - widen search (k=20)
                                      - route to different source
                                      - escalate to human
```

### Move 2 — the walkthrough

**In this codebase — not implemented.** No retrieval, no grading.

**The closest analogous check.** `diagnosticInvestigationToolPolicy` in `node_modules/@aptkit/.../diagnostic-agent.js:8-23` is a tool *allowlist* — a static gate on which tools can even be called. That's more like input validation than a grader on the output. The output-side equivalent doesn't exist here.

**Where it would land.** If Blooming added `retrieve_similar_investigations` as a tool, the grader would be a post-retrieval Haiku call:

Hypothetical:
```ts
// hypothetical
async function retrieveWithGrader(query: string): Promise<Chunk[]> {
  const chunks = await vectorStore.search(query, { k: 5 });
  const graded = await Promise.all(chunks.map(chunk =>
    grader.grade(query, chunk)   // Haiku: {relevant: bool, reason: string}
  ));
  const relevant = chunks.filter((_, i) => graded[i].relevant);
  if (relevant.length === 0) {
    // fallback: rewrite query and retry, or route to web search
    const rewritten = await queryRewriter.rewrite(query);
    return vectorStore.search(rewritten, { k: 10 });
  }
  return relevant;
}
```

Line-by-line: `vectorStore.search` returns top-k by embedding similarity — same as static RAG. `grader.grade` is where the pattern diverges — a per-chunk relevance call that catches the "high similarity, low relevance" case (paraphrase matches, wrong intent, stale content). On zero-relevant, the fallback rewrites the query. This is *one* of many fallback shapes (see also: escalate, widen k, route to a different source).

**Why grading is load-bearing.** Retrieval scores rank *similarity*, not *answer utility*. A chunk with 0.87 cosine similarity to the query may still not answer it — think "how do I reset my password?" retrieving a chunk about password *policies*. The grader is the check that catches that gap.

**The failure mode this pattern exposes.** LLM graders are noisy. A cheap grader (Haiku) is fine at "is this chunk topically related" but bad at "does this chunk *contain* the answer." A high-precision grader is Sonnet-level cost, at which point the grader cost approaches the generator cost — you're paying twice for one answer. Mitigation: use the grader as a *filter, not a scorer* — binary keep/drop, not weighted rank.

### Move 3 — the principle

Retrieval success is not answer success. The grader is the gate between them. Adopt it when your one-shot RAG measurably fails on "topically related but not answering" chunks — that's the specific failure mode the grader fixes. If your failure is "wrong topic entirely," a better embedding is cheaper. Match the pattern to the failure.

## Primary diagram

```
  Recap — the four-branch shape of self-corrective RAG

  query
    │
    ▼
  retrieve top-k
    │
    ▼
  grade each ─────────► relevant chunks
    │                        │
    │ all irrelevant         ▼
    ▼                    generate
  fallback:              (as static RAG)
    - rewrite query
    - widen k
    - route to different source
    - escalate to human
```

## Elaborate

Self-corrective RAG (also called CRAG) was named in Yan et al. 2024. Its main claim: the grader catches the failure that plain RAG can't detect until the generator produces a hallucination. In practice teams reach for it when they see "retrieval succeeded but answer is wrong" in their eval traces — the diagnostic marker that grading would help.

Adjacent shapes: **reranking** is a graded ranking (not just keep/drop); **hybrid retrieval + rerank** is the production standard for high-stakes RAG. See `study-ai-engineering.md` for the mechanics of both.

## Interview defense

**Q: Does this codebase grade retrieval relevance?**
A: No — there's no retrieval to grade. The DiagnosticAgent's tools are analytical (EQL, list scenarios, etc.), not retrievers. What exists that's analogous is a static tool *allowlist* at the input side, not a post-retrieval grader on the output side. If the product added a playbook corpus, self-corrective RAG would be the shape I'd introduce — a Haiku grader between retrieval and the diagnostic loop, with a fallback that rewrites the query on zero-relevant.

Diagram: the four-branch shape from the recap.
Anchor: hypothetical, references the actual tool-policy allowlist for the closest existing pattern.

**Q: Why not use the LLM as the grader in every case?**
A: Cost and noise. A cheap grader (Haiku per chunk) is fine at "topically related" but poor at "actually answers the question." A high-precision grader is Sonnet-level cost, which means you're paying generator cost twice. The production trick is to keep the grader binary (keep/drop, not scored) and cheap — use it as a filter, not a ranker. If you need ranking, you want a real reranker (cross-encoder), not an LLM.

Diagram: cost vs precision quadrant for grader model choice.
Anchor: general reasoning; refers to `study-ai-engineering.md`.

## See also

- `01-agentic-rag.md` — the loop this pattern lives inside.
- `03-retrieval-routing.md` — the routing tier above retrieval.
- Cross-reference: `.aipe/study-ai-engineering/03-retrieval-and-rag/` for the retrieval mechanics.
