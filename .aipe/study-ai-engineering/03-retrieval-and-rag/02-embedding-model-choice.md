# 02 — Embedding model choice

**Type:** Industry standard. Also called: embedding provider selection, embedding decision matrix.

## Zoom out, then zoom in

**Not exercised in this codebase.** If RAG were added, picking an embedding model would be a one-way decision — swap later means re-embedding the entire corpus.

```
  Zoom out — where this decision would land

  ┌─ RAG add (proposed) ──────────────────────────────────────────────┐
  │                                                                   │
  │  past diagnoses ─embed─► vectors ─cosine─► retrieval               │
  │                    │                                              │
  │                    │  ★ CHOOSE THIS ★                              │
  │                    │  (locked once picked)                        │
  │                    ▼                                              │
  │            OpenAI / Cohere / Voyage / local ST                    │
  └───────────────────────────────────────────────────────────────────┘
```

Zoom in. The choice is a decision tree: English vs multilingual, hosted vs local, general vs domain-specific, cost sensitivity. For this codebase (a solo demo, English-only text, low volume), OpenAI `text-embedding-3-small` is the default answer — cheap, hosted, high-quality for English.

## Structure pass

**Layers:**
- Outer: product need (language, privacy, corpus type)
- Middle: model catalog (OpenAI, Cohere, local ST, Voyage)
- Inner: per-model attributes (dimensions, cost, latency, license)

**Axis: cost of switching.**
- Small corpus (< 100K docs): re-embed is cheap; low switching cost
- Large corpus: re-embed is expensive; high switching cost

**Seam:** the embedding client — the call site that turns text into vectors. Above: the corpus and retrieval. Below: whichever vendor's SDK.

## How it works

### Move 1 — the mental model

You've picked a database (Postgres vs MySQL vs SQLite) and had to live with the choice. Same shape here — schema of the vector, dimensions, similarity metric all tied to the model.

```
  Decision tree — what to embed with

  what's the use case?
    │
    ├── English, general, hosted OK
    │   → text-embedding-3-small (OpenAI)
    │
    ├── Multilingual or domain
    │   → embed-v3 (Cohere), BGE, multilingual MiniLM
    │
    ├── Privacy-critical, on-device
    │   → sentence-transformers (local)
    │
    └── Code, technical text
        → text-embedding-3-large (OpenAI), Voyage code-2
```

### Move 2 — walk the mechanism

**The main options (as of 2026).**

- **OpenAI `text-embedding-3-small`** (1536-dim, $0.02/MTok): the pragmatic default. Fast, cheap, high quality for English. Used broadly in production.
- **OpenAI `text-embedding-3-large`** (3072-dim, $0.13/MTok): higher quality on hard retrieval tasks (code, technical text). 6× the cost of small.
- **Cohere `embed-v3` (multilingual)**: strong on non-English. ~$0.10/MTok.
- **Voyage `voyage-large-2` / `voyage-code-2`**: strong on domain-specific, particularly code. Similar cost to OpenAI large.
- **`sentence-transformers` (local)**: free, runs on CPU/GPU on your infra. Smaller and slower than hosted, but private.

**Cost math for this codebase (hypothetical corpus).**

If we embedded every past investigation's `conclusion` (~200 tokens each) and there are 10K investigations, that's 2M tokens. At OpenAI small pricing ($0.02/MTok), that's $0.04 total. Even a full re-embed is under $0.10. Switching cost is essentially free at this scale.

At real scale (100K, 1M docs) it grows — but embedding is still cheap relative to LLM inference.

**Why the decision matters more than the cost implies.**

Switching mid-flight requires re-embedding EVERYTHING. Not just cost — coordination. You either:
- Snapshot the corpus, embed with new model, swap the index (downtime or dual-serve)
- Version each doc with `embedding_version`, backfill lazily (complexity)

Both are fine at 10K docs; both are hard at 100M.

### Move 3 — the principle

Pick once, commit. The scale where embedding is "just re-run it" ends fast. Prefer a model with a clear roadmap (OpenAI's `text-embedding-3` family is a stable line) over the flavor of the month. For this codebase's shape (small English text), OpenAI small is the boring right answer.

## Primary diagram

```
  What the decision would look like for this codebase

  need: past-diagnosis similarity retrieval
    │
    ├── language:      English (Bloomreach data, agent text)
    ├── volume:         low (< 10K past diagnoses in any horizon)
    ├── privacy:        moderate (data is Bloomreach's)
    ├── domain:         general prose + numbers, some technical
    │
    ▼
  pick: OpenAI text-embedding-3-small
    · $0.02/MTok — trivial at this volume
    · 1536-dim — fine for cosine similarity
    · hosted — no infra to manage
    · stable family — future OpenAI updates are drop-in
```

## Elaborate

Embedding models diverge fast. Between 2022 and 2026 the frontier moved from OpenAI's `text-embedding-ada-002` (1536-dim, mid-quality) through Cohere, BGE, Voyage, then OpenAI's v3 family, with Voyage and Cohere competing on specific verticals. The move to smaller-and-cheaper `text-embedding-3-small` was a genuine step up on cost-per-quality. Expect another step-up cycle in 2027.

Fine-tuned embedding models are a separate discipline. If you had 100K+ labeled query-document pairs and retrieval quality was the bottleneck, you could fine-tune an embedding model on your own data. That's a real project — not applicable here.

## Project exercises

### Exercise — commit to `text-embedding-3-small` for the RAG add

- **Exercise ID:** C2.5-B · Case B (RAG not exercised).
- **What to build:** if `01-embeddings.md`'s Case B is picked, use OpenAI `text-embedding-3-small`. Document the choice in a small `docs/rag-decisions.md` with the tradeoff (why not multilingual, why not local).
- **Why it earns its place:** shows you know the decision is a one-way door. Interviewer signal: "I picked with the exit in mind."
- **Files to touch:** `lib/rag/embed.ts` (fixed model constant), `docs/rag-decisions.md` (new).
- **Done when:** the model is hard-coded in one place; the decision doc lists the alternatives considered.
- **Estimated effort:** <1hr for the decision + doc; 1-4hr including the initial embed.

## Interview defense

**Q: Why OpenAI small over large?**

For this corpus: 10× cost, ~5-10% quality gain on hard cases, no obvious wins on English prose. Small is the default; go to large only if you measure a real recall gap. I wouldn't guess at that up front.

**Q: What about local (sentence-transformers)?**

If Bloomreach's data privacy required on-device, local wins. In this codebase the data already leaves the user's device (goes to Bloomreach's servers, goes to Anthropic's servers), so local embedding doesn't buy privacy — it just adds ops burden.

**Q: What breaks if you swap embedding models?**

Every stored vector is worthless. You either re-embed the whole corpus (may be expensive at scale) or dual-serve (write vectors for both models until the migration completes). Neither is hard at 10K docs; both are real at 100M docs. That's why picking is a one-way decision above a certain scale.

## See also

- `01-embeddings.md` — the primitive being committed to
- `04-vector-databases.md` — where the vectors land
- `09-stale-embeddings.md` — the ongoing maintenance surface
