# 03 — chunking strategies

**Subtitle:** Fixed / sentence / structural splits · Industry standard (Case B)

## Zoom out, then zoom in

**Case B.** A chunk is the unit of retrieval. The choice affects every
downstream metric. For blooming insights' hypothetical RAG, the natural
chunk is **one investigation = one chunk** — no fancy chunking needed.

```
  Zoom out — chunking sits between corpus and index

  ┌─ Corpus (lib/state/investigations.ts) ──────┐
  │  Investigation { insightId, diagnosis, … }  │
  └────────────────┬────────────────────────────┘
                   │  ★ CHUNK ★ (1 inv = 1 chunk)  ← we are here
                   ▼                              (Case B; natural unit)
  ┌─ Index (sqlite-vec / pgvector) ─────────────┐
  │  { insightId, embedding, conclusion }       │
  └─────────────────────────────────────────────┘
```

## Structure pass

  → **One axis to trace — coherence.** A good chunk is semantically
    coherent (one topic, one decision) and bounded in length (~200-500
    tokens). For investigations, each one is naturally that shape.
    For arbitrary prose, you have to engineer it.

## How it works

### Move 1 — the mental model

Same shape as picking the granularity for a unit test or a database row:
too small and you lose context, too big and you dilute relevance.

```
  Three approaches in order of sophistication

  ┌─ Fixed-size chunking ──────────────────────────┐
  │  Split every N tokens. Boundaries land mid-    │
  │  sentence often. Quality: variable.            │
  └────────────────────────────────────────────────┘

  ┌─ Sentence-window chunking ─────────────────────┐
  │  Split on sentence boundaries, group N         │
  │  sentences. Boundaries are clean. Quality:     │
  │  good for prose, weak for tables / code.       │
  └────────────────────────────────────────────────┘

  ┌─ Structural chunking ──────────────────────────┐
  │  Split on document structure (markdown         │
  │  headings, code blocks, JSON nesting).         │
  │  Quality: highest, but requires parsing.       │
  └────────────────────────────────────────────────┘

  ┌─ Natural-unit chunking (blooming's case) ──────┐
  │  Each input record IS one chunk. No splitting. │
  │  Best of all worlds — when the corpus has      │
  │  natural per-row boundaries.                   │
  └────────────────────────────────────────────────┘
```

### Move 2 — the step-by-step walkthrough

**For blooming insights' diagnosis-grounding RAG:** each `Investigation`
record is one chunk. Combine `diagnosis.conclusion` + `diagnosis.evidence` +
optionally first-few `recommendations` titles into a single embedding text:

```typescript
// hypothetical lib/rag/embed.ts
function investigationToChunkText(inv: Investigation): string {
  const conclusion = inv.diagnosis.conclusion;
  const evidence = inv.diagnosis.evidence.join('\n');
  const topRec = inv.recommendations[0]?.title ?? '';
  return [conclusion, evidence, topRec].filter(Boolean).join('\n');
}
```

Typical length: 200-600 tokens. Comfortably under the 8192-token embedding
input cap. No chunking needed.

**Where you'd actually need chunking in this codebase.** Hypothetical: if
you decided to also RAG over the long-form `lib/agents/legacy-prompts/*.md`
files (which exceed 4000 chars each), you'd split them on markdown headings
(`## Hard rules`, `## Investigation approach`, etc.) — structural chunking.
But that corpus is so small (4 files) that a sorted list would beat RAG —
RAG isn't justified for that case.

**Rule of thumb sizes:**
  → Prose paragraphs: 200-500 tokens
  → Code blocks: one function or one logical block
  → Structured data (JSON, EQL queries): one record / one query
  → Long markdown docs: one ## heading section

**The overlap pattern.** When splitting long prose, add ~50 tokens of
overlap between adjacent chunks so that information at chunk boundaries
isn't lost to either chunk. Not needed for natural-unit chunking.

### Move 3 — the principle

**Match chunk granularity to the natural shape of your data. Don't split if
your data already has good boundaries — investigations, customer records,
log entries, dashboard widgets all have natural per-row chunk shapes.** Only
reach for splitting strategies when your input is genuinely long-form prose
without natural boundaries.

## Primary diagram

```
  Chunking decision tree for blooming insights

  what's the input shape?
       │
       ├── per-record (Investigation, Recommendation, etc.)
       │       │
       │       └─► natural-unit chunking (1 record = 1 chunk)
       │           NO splitting, NO overlap
       │
       ├── long markdown (prompts, docs)
       │       │
       │       └─► structural chunking on headings
       │
       └── arbitrary prose (notes, transcripts, articles)
               │
               └─► sentence-window chunking + 50-token overlap
                   chunk_size = 400 tokens, stride = 350
```

## Elaborate

The chunking literature is enormous; the practical reality is small.
"Sentence-window with 400-token target and 50-token overlap" covers ~80%
of prose-RAG use cases. Structural chunking wins when the document has
*real* structure (heading hierarchy, table boundaries, code fences) and
that structure is queryable as-is. Fixed-size chunking is the dumb
fallback when you have nothing else.

For per-record corpora (which is most enterprise RAG), the answer is
"don't chunk." A customer record, an order, a support ticket, an
investigation — each is its own chunk. Save yourself the engineering and
the index complexity.

## Project exercises

### Exercise — define `investigationToChunkText` and write a sizing test

  → **Exercise ID:** `study-ai-eng-03-03.1`
  → **What to build:** In `lib/rag/embed.ts` (already created by the
    11-rag exercise), add `investigationToChunkText(inv)` and a unit test
    that asserts the produced string is between 100 and 1500 tokens for
    all fixtures in `lib/state/demo-investigations.json`.
  → **Why it earns its place:** Locks the chunking contract before
    embedding starts. If a future investigation grows to 5000+ tokens
    (unlikely but possible), the test fires.
  → **Files to touch:** `lib/rag/embed.ts`, `test/rag/embed.test.ts`,
    `package.json` (a tokenizer dep for the size assertion — could use
    `@dqbd/tiktoken` or just char/4 as approximation).
  → **Done when:** Test passes against all demo investigations; future
    investigations are validated when added.
  → **Estimated effort:** `1–4hr`

## Interview defense

**Q: How would you chunk for this codebase's RAG?**

I wouldn't. Each `Investigation` record is a natural chunk — 200-600
tokens, semantically coherent (one anomaly's diagnosis), comfortably
under the embedding model's input cap. Natural-unit chunking beats
splitting strategies when your input already has good boundaries.

```
  Investigation = one chunk:
    diagnosis.conclusion        ~50 tokens
    diagnosis.evidence (joined) ~200-400 tokens
    optional: top recommendation title ~20 tokens
                                ─────
    total per chunk             200-500 tokens
```

**Anchor line:** "Natural-unit chunking. The Investigation type is already
the right granularity — splitting it would just dilute the embedding."

**Q: When would you reach for sentence-window or structural chunking?**

When the input is genuinely long-form prose without per-record boundaries.
For this codebase, that'd be the markdown prompts in
`lib/agents/legacy-prompts/` if you decided to RAG over them — structural
chunking on `##` headings. But there are only four such files; a sorted
list would beat RAG. Don't add RAG to features that work without it.

## See also

  → `01-embeddings.md` — what each chunk becomes after embedding
  → `11-rag.md` — the full pipeline this fits into
