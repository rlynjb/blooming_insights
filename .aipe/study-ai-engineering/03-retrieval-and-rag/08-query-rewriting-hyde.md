# 08 — Query rewriting and HyDE

**Type:** Industry standard. Also called: query expansion, hypothetical document embeddings.

## Zoom out, then zoom in

**Not exercised in this codebase.** User queries are usually short; docs are long. Rewriting closes the query-doc size gap.

## Structure pass

Axis: what does the query look like to the embedding model? Short and ambiguous is hard to match against long dense docs. Rewrite or hypothetical-doc-generation closes the gap.

## How it works

### Move 1

The query "fix auth thing" is short and vague. Docs about authentication debugging are long and specific. Embedding both maps them to different regions of vector space. Rewriting or HyDE bridges this.

```
  Two approaches

  query rewriting: query → LLM → longer retrievable query
    "fix auth thing" → "how to debug authentication token verification errors"
    embed the rewritten query, retrieve.

  HyDE (Hypothetical Document Embeddings):
    query → LLM → hypothetical answer paragraph
    embed the hypothetical, retrieve docs similar to it.
```

### Move 2

**Query rewriting.** Short LLM call: "expand this query into a longer, more retrievable form." Result: same intent, longer, more terms overlapping with docs.

**HyDE.** LLM writes a hypothetical answer to the query. Embed that hypothetical, retrieve docs similar to it. The hypothetical is a "doc-shaped query" — closer to what real docs look like in embedding space.

**Cost.** Both add an LLM call per query. That's ~$0.001-0.005 with Sonnet, or ~$0.0001-0.0005 with Haiku. Fine if retrieval quality is the bottleneck; wasteful if it isn't.

### Move 3

Add when measured. If your recall@k drops on short queries but climbs on long queries, rewriting or HyDE gives you the long-query behavior on all queries.

## Primary diagram

```
  Query rewriting

  short user query
        │
        ▼
    LLM rewrite (~$0.001)
        │
        ▼
    longer, more retrievable query
        │
        ▼
    embed → retrieve

  HyDE

  short user query
        │
        ▼
    LLM generate hypothetical answer (~$0.005)
        │
        ▼
    "hypothetical" text
        │
        ▼
    embed → retrieve docs similar to it
```

## Elaborate

HyDE was published in 2022 (Gao et al.). It works because the embedding space's structure captures "what real docs look like" more than "what short user queries look like." The hypothetical mimics the shape of real docs and lands closer to real docs in the space.

## Project exercises

### Exercise — query rewriting on the past-investigation RAG

- **Exercise ID:** C2.11-B · Case B (RAG not exercised).
- **What to build:** if the RAG stack from `01-04` is present, add a Haiku call that rewrites the current anomaly's description into a longer, more retrievable form BEFORE embedding it for the "similar past investigations" panel. Measure recall@3 with and without.
- **Why it earns its place:** shows you know the query-doc size gap is a real problem. Interviewer signal: "I bridged the query-doc gap when recall was low on short queries."
- **Files to touch:** `lib/rag/rewrite.ts` (new), `lib/rag/retrieve.ts` (chain).
- **Done when:** report shows recall@3 with and without rewriting on 10 queries.
- **Estimated effort:** 1-4hr.

## Interview defense

**Q: Rewriting vs HyDE?**

Rewriting is safer — it's still a query, just longer. HyDE is more aggressive — it's a hypothetical answer, which can hallucinate and pull retrieval off-topic if the LLM guesses wrong. I'd default to rewriting and reach for HyDE only when rewriting doesn't move the needle.

**Q: Extra cost per query worth it?**

Depends on the miss rate. If recall@k is already 90%, no. If it's 60% because queries are short, yes — the extra ~$0.001 is trivial relative to a real recall win.

**Q: Where does this fit relative to hybrid retrieval?**

Orthogonal. Rewrite the query first, then hybrid-retrieve. Both moves target different failure modes (dense-only vs short-query).

## See also

- `05-dense-vs-sparse.md` — the retrieval this feeds
- `01-llm-foundations/07-heuristic-before-llm.md` — same "cheap LLM in front" pattern
