# 08 — query rewriting and HyDE

**Subtitle:** LLM-augmented query → better retrieval · Industry standard (Case B)

## Zoom out, then zoom in

**Case B.** Two patterns for the same problem: user queries are short and
ambiguous; documents are long and specific; their embedding spaces don't
always align. Run an LLM step BEFORE retrieval to bridge the gap.

```
  Zoom out — query rewriting sits in front of retrieval

  ┌─ user query (short, ambiguous) ───────────┐
  │  "fix the auth thing"                      │
  └────────────┬───────────────────────────────┘
               │
               ▼  ★ LLM rewrite OR HyDE ★      ← we are here
               │                                (Case B)
               ▼
  ┌─ retrieve over better query ──────────────┐
  │  embedding aligned with doc-space          │
  └────────────────────────────────────────────┘
```

## Structure pass

  → **One axis to trace — cost vs recall.** Extra LLM call per query
    (~$0.001 with haiku, ~50-200ms latency) in exchange for measurable
    recall lift. Earns its place when recall@k is poor for short queries.

## How it works

### Move 1 — the mental model

Two approaches:

**Query rewriting:** the LLM expands the query into something more
retrievable.

```
  query:    "fix the auth thing"
            ↓ LLM rewrite
  rewrite:  "how to debug authentication token verification errors"
            ↓ embed → cosine search
            (matches docs about auth debugging)
```

**HyDE (Hypothetical Document Embeddings):** the LLM generates a
*hypothetical answer* to the query, then you embed that answer and
search for similar real docs.

```
  query:    "fix the auth thing"
            ↓ LLM generates hypothetical answer
  hyde:     "To debug authentication, check the JWT signature against
             the secret in env. Verify the token isn't expired…"
            ↓ embed the hypothetical answer → cosine search
            (matches real docs about JWT debugging)
```

### Move 2 — the step-by-step walkthrough

**Why both work.** Embedding spaces are biased toward the kind of text
they were trained on. Documents in your corpus are long, descriptive,
specific. User queries are short, vague, often missing terms. The
embedding of a short query lands in a different part of the space than
the embedding of a long descriptive doc — even when they're
semantically about the same thing.

Rewriting and HyDE both produce embeddings that look more like the
*documents* you want to retrieve, so cosine search lands in the right
region.

**For blooming insights' hypothetical RAG, would either help?** Mixed
answer:

  → If the queries are anomalies (`anomaly.metric + anomaly.scope`),
    they're already structured — short but specific. Probably don't need
    rewriting.
  → If the queries are user-typed free-form ("show me past investigations
    similar to this checkout drop"), rewriting could help. HyDE might
    overshoot — generating a hypothetical past investigation could mix
    facts that don't apply to the user's actual context.

**Cost-benefit.** An extra haiku call adds ~$0.0003 and ~50ms. On a corpus
of ~100 items, the recall lift is likely small (cosine search already
covers most of the space). On a corpus of ~100k items, the lift is
real because the search is more targeted.

**Hypothetical implementation:**

```typescript
// lib/rag/rewrite.ts (Case B)
async function rewriteQuery(rawQuery: string): Promise<string> {
  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 200,
    system: 'Rewrite the user query into a longer, more specific search query that would match documentation about the topic.',
    messages: [{ role: 'user', content: rawQuery }],
  });
  return response.content
    .filter((c): c is Anthropic.Messages.TextBlock => c.type === 'text')
    .map(c => c.text)
    .join(' ');
}
```

### Move 3 — the principle

**Bridge the query-document embedding gap by augmenting the query, not
the corpus.** Rewriting and HyDE are both cheap (one extra small LLM
call) and don't require re-embedding anything. Reach for them when
recall on short queries is the bottleneck.

## Primary diagram

```
  Query rewriting vs HyDE — same goal, two paths

  ┌─ Rewriting ────────────────────────────────┐
  │  short query → LLM rewrites to be longer/  │
  │  more specific → embed rewrite → search    │
  │                                             │
  │  preserves query INTENT                     │
  │  pads with retrieval-friendly terms        │
  └─────────────────────────────────────────────┘

  ┌─ HyDE ─────────────────────────────────────┐
  │  short query → LLM generates HYPOTHETICAL  │
  │  answer → embed the hypothetical → search  │
  │                                             │
  │  matches doc-shape (long, descriptive)     │
  │  RISK: hypothetical may invent facts        │
  └─────────────────────────────────────────────┘
```

## Elaborate

The HyDE pattern was introduced in "Precise Zero-Shot Dense Retrieval
without Relevance Labels" (Gao et al., 2022). The clever bit: even when
the hypothetical answer is partially wrong, its *embedding* still lands
in the right neighborhood for retrieval. The wrongness gets corrected by
the actual retrieved doc.

Query rewriting is the older pattern (predates LLMs as
synonym-expansion). With LLMs the rewriting can be much smarter —
adding implicit terms, expanding acronyms, normalizing phrasing.

In production, the choice between them is often empirical. Rewriting
tends to be safer (preserves intent); HyDE tends to be more powerful
(matches document shape). Some systems use both.

## Project exercises

### Exercise — A/B test rewriting on the labeled fixture set

  → **Exercise ID:** `study-ai-eng-03-08.1`
  → **What to build:** Add `lib/rag/rewrite.ts` with an LLM rewrite
    function. Run recall@5 on the labeled fixture (from exercise 07.1)
    with and without rewriting. If lift > 5pp, ship it; if not, don't.
  → **Why it earns its place:** Demonstrates "I don't ship retrieval
    enhancements without measuring." Empirical, not hopeful.
  → **Files to touch:** new `lib/rag/rewrite.ts`, `test/rag/recall.test.ts`
    (add A/B comparison).
  → **Done when:** Recall numbers documented; ship/skip decision made
    based on measurement.
  → **Estimated effort:** `1–4hr`

## Interview defense

**Q: Have you used query rewriting or HyDE?**

Not in this codebase — there's no RAG to put it in front of. The
patterns are: rewriting (LLM expands a short query into a longer
retrieval-friendly one); HyDE (LLM generates a hypothetical answer, you
embed *that* and search for similar real docs). Both add one cheap LLM
call before retrieval; both earn their place when short-query recall is
the bottleneck.

For this codebase's hypothetical diagnosis-grounding RAG, rewriting
might help on user-typed free-form queries; HyDE is probably overkill
because the corpus is small and the bias-toward-doc-shape problem only
shows up at scale.

**Anchor line:** "Bridge the query-document embedding gap by augmenting
the query, not the corpus. Cheap, no re-embedding needed."

**Q: Why does HyDE work even when the hypothetical is wrong?**

The hypothetical answer's *embedding* still lands in the right
neighborhood semantically, even when specific facts are wrong. You're
retrieving real docs whose embeddings are close to the hypothetical;
the wrongness gets corrected by what you actually retrieve. It's
counter-intuitive but it's the empirical finding from the HyDE paper.

## See also

  → `01-embeddings.md` — the bias-toward-training-distribution that this fixes
  → `11-rag.md` — the pipeline this sits in front of
