# Query rewriting and HyDE

## Subtitle

Query augmentation for retrieval / hypothetical document embeddings — Industry standard.

## Zoom out, then zoom in

User queries are short and ambiguous ("fix the auth thing"). Documents are long and specific. The embedding-space distance between them is often larger than it should be. Two mitigations: **query rewriting** (LLM expands the query to something more retrievable) and **HyDE** (LLM writes a hypothetical answer, embeds that, retrieves docs close to it).

```
  Zoom out — where these live

  ┌─ Query ─────────────────────────────────────────┐
  │  "fix the auth thing" ← short, ambiguous         │
  └──────────┬──────────────────────────────────────┘
             │
             ▼
  ┌─ Rewrite OR HyDE ★ ─────────────────────────────┐ ← we are here
  │  · rewrite: LLM expands to a fuller query        │
  │  · HyDE:    LLM writes a hypothetical doc,       │
  │             embed that instead                    │
  └──────────┬──────────────────────────────────────┘
             │
             ▼
  ┌─ Retrieval (embed + cosine or hybrid) ──────────┐
  └─────────────────────────────────────────────────┘
```

## Structure pass

- **Layers:** raw query → augmentation LLM → retrieval → docs. Four bands.
- **Axis: closeness in embedding space.** Raw query embeds far from doc embeddings; augmented query embeds closer.
- **Seam:** the augmentation LLM call. It's a cheap Haiku-tier call that bridges the query/doc mismatch.

## How it works

### Move 1 — the mental model

**Query rewrite.** Ask an LLM: "expand this query with related terms and specifics." Take the expanded text, embed *that*, retrieve.

**HyDE.** Ask an LLM: "write a hypothetical answer to this query." Embed the hypothetical answer, retrieve docs whose embeddings are close to the hypothetical answer's embedding.

```
  Two augmentation shapes — sketched

  raw:  "fix the auth thing"

  rewrite:
    LLM → "how to debug authentication token verification errors"
    embed rewrite, retrieve

  HyDE:
    LLM → "To debug auth, check the token signature against the JWT
           secret in the env file. Common causes include expired
           tokens, mismatched clock skew, and misconfigured issuers."
    embed HyDE output, retrieve
```

HyDE wins when queries are short and answers are long — the answer embedding lands in the same region of the space as real answer docs.

### Move 2 — the step-by-step walkthrough

**Cost.** Every query pays for one extra LLM call (~$0.0005 on Haiku). At high query rate, the added cost adds up; at low query rate, it's noise.

**Where blooming would use rewrite.** The QueryBox — free-form user text like "why did revenue drop." Rewrite could add "conversion_rate purchase revenue period-over-period 90d" as retrievable EQL terms. But this only helps if there's a retrieval step to help; today there isn't.

**Where blooming would use HyDE.** Rare in this codebase's would-be shape. HyDE works when queries and docs have different vocabularies (user question vs internal doc); investigation memory has similarly-shaped input on both sides.

**Implementation shape.**

```
  rewriteQuery(rawQuery):
    prompt = "Expand this analytics query with related metric names,
              event types, and time-range terms. Return only the
              expanded query."
    return anthropic.messages.create(model=haiku, prompt=[rawQuery, ...])

  hydeRetrieve(rawQuery, index, k=3):
    hypotheticalAnswer = anthropic.messages.create(
      model=haiku,
      prompt="Write a paragraph that would answer this query: " + rawQuery
    )
    return index.search(embed(hypotheticalAnswer), k)
```

### Move 3 — the principle

Query augmentation is worthwhile only when measured retrieval quality is poor. It's a Haiku-cost knob that trades a small per-query cost for measurable recall improvement. Add it after you can prove the baseline retrieval isn't good enough.

## Primary diagram

```
  Query augmentation — full frame

  ┌─ Raw query ────────────────────────────────────────┐
  │  "why did mobile revenue drop"                      │
  └────────┬───────────────────────────────────────────┘
           │
    ┌──────┴──────┐
    ▼             ▼
  rewrite path  HyDE path

  rewrite:                          HyDE:
    → LLM rewrites w/ metric names   → LLM writes hypothetical answer
    → embed rewrite                  → embed hypothetical
    → retrieve                       → retrieve

  Both add: latency (one Haiku call, ~200ms), cost (~$0.0005).
  Both earn: measurable recall improvement on ambiguous queries.
```

## Elaborate

HyDE was proposed by Gao et al. 2022. Query rewriting predates it by decades in classical IR. Both patterns are cheap to implement and easy to measure — the key discipline is measuring before adding.

Related: **05-dense-vs-sparse.md** (sparse doesn't need query augmentation — it works on token overlap directly), **11-rag.md** (where augmentation feeds).

## Project exercises

### B3.8 · Add query rewrite to the QueryBox path

- **Exercise ID:** B3.8 (Case B — depends on retrieval landing)
- **What to build:** Once retrieval lands (e.g., investigation memory per B3.1), add a Haiku rewrite step for QueryBox queries before retrieval. Compare hit@3 before and after on 30 hand-labeled queries.
- **Why it earns its place:** Cheap, measurable augmentation. Interview payoff: "here's how I'd measure whether it earns its place."
- **Files to touch:** `lib/agents/query.ts`, new `lib/agents/rewrite.ts` (Haiku-only helper).
- **Done when:** the rewrite step is A/B-comparable via env flag; the eval reports hit@3 delta.
- **Estimated effort:** `1–2 days`.

## Interview defense

**Q: Rewrite or HyDE — which would you pick?**

Depends on the mismatch shape. If queries and docs have similar vocabulary (they're both diagnoses), rewrite wins because it stays in the same shape. If queries are questions and docs are answers, HyDE wins because it transforms the query into the doc shape. Measure both if you can.

**Q: What if the LLM rewrite invents wrong terms?**

Real risk. If the rewrite adds terms that aren't in the corpus, retrieval fetches nothing or the wrong things. Mitigations: constrain the rewrite prompt with domain vocabulary ("only use terms from: [event names, metric names]"), or use the raw query as a fallback if the rewrite retrieves nothing.

## See also

- [11-rag.md](11-rag.md) — the pipeline this feeds.
- [07-reranking.md](07-reranking.md) — the sibling knob at the other end of the pipeline.
- [05-dense-vs-sparse.md](05-dense-vs-sparse.md) — the sparse alternative that avoids augmentation altogether.
