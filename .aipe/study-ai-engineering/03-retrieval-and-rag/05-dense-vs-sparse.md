# 05 — dense vs sparse retrieval

**Subtitle:** Cosine on embeddings vs BM25 on terms · Industry standard (Case B)

## Zoom out, then zoom in

**Case B.** Dense retrieval uses embeddings + cosine similarity. Sparse
retrieval uses term frequency (BM25). They catch different things; the
best production systems combine both (see `06-hybrid-retrieval-rrf.md`).

```
  Zoom out — two parallel paths to top-k

  ┌─ query ─────────────────────────────────────────┐
  │                                                 │
  │  ┌─ dense ──────────┐    ┌─ sparse ──────────┐  │  ← we are here
  │  │  embed(query)    │    │  tokenize         │  │   (Case B)
  │  │  cosine search   │    │  BM25 term lookup │  │
  │  └────────┬─────────┘    └────────┬──────────┘  │
  │           ▼                       ▼              │
  │   top-k by semantic         top-k by keyword     │
  │   similarity                overlap              │
  └──────────────────────────────────────────────────┘
```

## Structure pass

  → **One axis to trace — query intent.** "find docs that *mean* what I
    asked" → dense. "find docs that *contain* the terms I asked" →
    sparse. The two answer different questions; combining them is what
    production needs.

## How it works

### Move 1 — the mental model

Dense is paraphrase-tolerant: searching for "auth bug" finds "login
broken." Sparse is term-strict: searching for "CVE-2024-1234" finds the
single doc that mentions exactly that string. They're complements.

```
  Dense (embeddings)             Sparse (BM25)
  ─────────────────              ──────────────
  query → embed → vector         query → tokens → ["fix", "auth"]
                                            │
                                            ▼
  cosine similarity in           term frequency × inverse
  high-dim space                 document frequency

  great at: paraphrases,         great at: exact terms,
  semantic match                 rare words, identifiers,
                                 product codes
  weak at:  rare identifiers,    weak at:  synonyms,
            exact term matches              paraphrases
```

### Move 2 — the step-by-step walkthrough

**Dense retrieval — what we've been building up to.** Already covered in
`01-embeddings.md`, `04-vector-databases.md`, `11-rag.md`:

```typescript
const queryVec = await embed(query);
const top10 = await store.cosineSearch(queryVec, { topK: 10 });
```

**Sparse retrieval — BM25.** Built on classic information-retrieval math
(TF-IDF generalized). For each query term, compute how often it appears
in each document, weighted by how rare the term is overall. Sum across
terms. Top-k by score.

```typescript
// hypothetical lib/rag/sparse.ts
interface SparseIndex {
  index(id: string, text: string): void;
  search(query: string, opts: { topK: number }): Array<{ id: string; score: number }>;
}
```

Implementations: SQLite's `FTS5` (Full-Text Search) ships with most
SQLite distributions and supports BM25 ranking. For larger corpora,
Elasticsearch or Tantivy.

**For blooming insights' hypothetical RAG, sparse adds value on**:
specific metric names ("purchase_revenue", "customer.country"), error
strings, brand names, currency codes, country names — anything that's
literally repeated across investigations.

Concrete example: user asks "investigate the BRL drop." Dense embedding
might rank: investigations about Brazilian currency (loose semantic match
to "BRL") AND investigations about other currency drops. Sparse on BM25
would rank: investigations whose text contains "BRL" — exact-match wins,
much higher precision for the specific term.

**When dense alone fails.** "Show me past investigations of CVE-2024-1234"
— if the embedding model never saw that CVE during training (it's recent),
the vector for "CVE-2024-1234" is near-random. Cosine search returns
unrelated investigations. Sparse on the literal term lands it instantly.

**When sparse alone fails.** "Show me past investigations where users
struggled to checkout" — no investigation literally says "users struggled
to checkout"; they say "conversion dropped" or "cart abandonment rose."
BM25 finds nothing meaningful; dense finds the semantically related ones.

### Move 3 — the principle

**Dense matches meaning; sparse matches terms. Real corpora need both
because real queries mix both.** A query like "fix the BRL drop" has a
semantic part ("fix the X drop" — paraphrase tolerant) AND a literal part
("BRL" — exact-term sensitive). One retrieval method handles one half.
The hybrid pattern (next file) handles both.

## Primary diagram

```
  When each retrieval type wins

  ┌─ Query: "fix the auth bug" ─────────────────────┐
  │                                                  │
  │  dense:  finds "Debugging JWT verification"     │ ✓ win
  │          finds "Login issues with OAuth"        │ ✓ win
  │  sparse: finds nothing (no literal "auth bug"   │ ✗
  │          string in corpus)                       │
  │                                                  │
  ├─ Query: "CVE-2024-1234" ────────────────────────┤
  │                                                  │
  │  dense:  finds random unrelated investigations  │ ✗
  │          (model never saw this CVE)             │
  │  sparse: finds the ONE doc with this CVE        │ ✓ win
  │                                                  │
  ├─ Query: "BRL revenue drop" ─────────────────────┤
  │                                                  │
  │  dense:  finds currency drops in general        │ ½
  │          + Brazilian investigations              │
  │  sparse: finds docs with "BRL" literally        │ ½
  │                                                  │
  │  → hybrid wins clearly (see 06-hybrid-...)       │
  └──────────────────────────────────────────────────┘
```

## Elaborate

The dense-vs-sparse debate was contentious in the 2020-2022 era when
dense embeddings were ascendant and people declared sparse dead. The
production reality, settled by 2023, is that hybrid systems consistently
beat either alone on most retrieval benchmarks (BEIR, MTEB-retrieval).
Modern production search infrastructure (Elasticsearch's "neural search,"
Vespa, Weaviate's hybrid mode) ships both side by side.

For small corpora, sparse alone can be surprisingly strong because exact
terms dominate. For large corpora with diverse query intents, hybrid is
the move.

## Project exercises

### Exercise — add a `SqliteFtsStore` for sparse retrieval

  → **Exercise ID:** `study-ai-eng-03-05.1`
  → **What to build:** Add a `SparseIndex` interface alongside the
    `VectorStore` interface from `04-vector-databases.md`'s exercise.
    Implement `SqliteFtsStore` using SQLite FTS5 + BM25 ranking. Index
    the same investigations the vector store indexes. Add a separate
    query method `searchSparse(query, {topK})`.
  → **Why it earns its place:** Sets up the hybrid pattern in
    `06-hybrid-retrieval-rrf.md`. SQLite FTS is free with the existing
    SQLite dependency.
  → **Files to touch:** new `lib/rag/sparse.ts`, `lib/rag/store.ts`
    (parallel `SparseIndex`), `lib/state/investigations.ts` (upsert to
    both indices), tests.
  → **Done when:** Searching for a literal term (e.g. "BRL") returns
    investigations whose text contains it; searching for a paraphrase
    returns nothing useful (which is the expected weakness — dense
    handles those).
  → **Estimated effort:** `1–4hr`

## Interview defense

**Q: Why have both dense and sparse in a RAG system?**

They catch different things. Dense (embeddings) handles paraphrases —
"auth bug" finds "login broken." Sparse (BM25) handles exact terms —
"CVE-2024-1234" finds the one doc with that string. Production queries
mix both intents, so production systems combine both.

```
  Query "fix the BRL drop":
    dense:  Brazilian investigations (good semantic match) ½
    sparse: docs literally containing "BRL"               ½
    hybrid: both → top-k from each → fuse via RRF         ✓
```

**Anchor line:** "Dense matches meaning, sparse matches terms. Real queries
mix both; real systems combine both."

**Q: For this codebase's hypothetical RAG, would sparse add real value?**

Yes. The corpus contains specific metric names (`purchase_revenue`,
`customer.country`), currency codes, country names, event types — exactly
the things sparse handles well. A user asking "show me past BRL revenue
drops" wants the literal term match. SQLite FTS5 is free with the
existing SQLite dependency, so adding sparse alongside dense is cheap.

## See also

  → `06-hybrid-retrieval-rrf.md` — how to combine the two top-k lists
  → `01-embeddings.md` — the dense side's substrate
