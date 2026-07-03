# 03 — Chunking strategies

**Type:** Industry standard. Also called: text splitting, document segmentation.

## Zoom out, then zoom in

**Not exercised in this codebase.** If RAG were added, the natural chunk unit for this repo would be one whole `Diagnosis.conclusion` (short prose paragraph) or one `hypothesisConsidered` entry — semantic units, not arbitrary token windows.

```
  Zoom out — chunking would happen before embedding

  ┌─ Would-be RAG pipeline ───────────────────────────────────────────┐
  │  raw text (past investigations)                                   │
  │     │                                                             │
  │     ▼  ★ CHUNKING ★                                                │
  │  chunk 1: "Conclusion: payment processor timeout on mobile SP…"   │
  │  chunk 2: "Hypothesis 1: UX regression — supported: false…"       │
  │     │                                                             │
  │     ▼  embed each chunk                                           │
  │  vectors ──► store                                                 │
  └───────────────────────────────────────────────────────────────────┘
```

Zoom in. Chunk size and boundary choice determine retrieval quality — too small = missing context, too large = diluted relevance. In this codebase's would-be RAG, the natural chunk is a structural unit from the `Diagnosis` schema, not fixed-token windows.

## Structure pass

**Layers:**
- Outer: retrieval quality (does the right chunk come back?)
- Middle: chunk size + boundary discipline
- Inner: text-splitter mechanics (fixed / sentence / structural)

**Axis: coherence per chunk.**
- Fixed windows: cheap but boundaries land mid-sentence (poor coherence)
- Sentence windows: better boundaries, sometimes too small
- Structural (per Diagnosis field, per markdown heading): highest coherence

**Seam:** the chunker function — text in, chunks out. Above: the corpus. Below: the embedding call.

## How it works

### Move 1 — the mental model

You've written a `.split('\n')` on a big string and had a bug because it split inside a code block. Chunking is that class of decision at scale — where to cut has semantic consequences.

```
  Three chunking shapes

  ┌─ Fixed-size ──────────┐   ┌─ Sentence-window ─┐  ┌─ Structural ──┐
  │  every N tokens      │   │  split on . ! ?    │  │  per heading  │
  │  boundaries: dumb    │   │  boundaries: clean │  │  per field    │
  │  coherence: variable │   │  coherence: prose  │  │  coherence:   │
  │                      │   │                    │  │    highest   │
  └──────────────────────┘   └────────────────────┘  └───────────────┘
```

### Move 2 — walk the mechanism (as it would apply)

**Fixed-size chunking (200-500 tokens).**
Baseline. Split every N tokens. Sometimes with overlap (last 50 tokens of chunk N repeat as first 50 of chunk N+1) to avoid cutting a key phrase in half. Simple. Boundaries can land mid-sentence, mid-word. Fine for large homogeneous corpora; poor for structured data.

**Sentence-window chunking.**
Split on sentence boundaries, then group K sentences per chunk. Cleaner boundaries. Better for prose (news articles, docs). Loses on data with paragraph-level cohesion (e.g. a diagnosis conclusion is one sentence — chunking within is nonsensical).

**Structural chunking (the right fit for this repo).**
Use the document's structure. For markdown, one chunk per section under an H2. For JSON like `Diagnosis`, one chunk per hypothesis, one for the conclusion, one for evidence. Coherence is high — every chunk is a self-contained semantic unit — but you need a structural parser per format.

**What would fit this codebase.**
`Diagnosis` is already structured. Chunk it as:
- Chunk 1: `conclusion` (~200 tokens)
- Chunk 2-4: each `hypothesesConsidered[i]` entry (~150 tokens each)
- Chunk 5: `evidence` summary (~500 tokens)

Retrieval could pull "the conclusion of a similar past diagnosis" separately from "a hypothesis that was ruled out in a similar past diagnosis." Two useful retrieval targets.

### Move 3 — the principle

Chunk at the document's natural seams. If the document has structure (markdown headings, JSON fields, code function boundaries), use it. Fixed-size is the fallback when nothing else is available. Small semantic chunks beat large fixed-size chunks on retrieval quality every time.

## Primary diagram

```
  Structural chunking of a Diagnosis (proposed shape)

  {
    conclusion: "…",           ← chunk 1 (200 tokens)
    hypothesesConsidered: [
      {hypothesis: A, ...},    ← chunk 2 (150 tokens)
      {hypothesis: B, ...},    ← chunk 3 (150 tokens)
      {hypothesis: C, ...},    ← chunk 4 (150 tokens)
    ],
    evidence: [...],           ← chunk 5 (500 tokens)
  }

  each chunk: self-contained semantic unit
  cross-chunk retrieval: "find similar hypotheses" independent of
  "find similar conclusions"
```

## Elaborate

For long unstructured text (books, transcripts), state-of-the-art chunkers use small LMs to find semantic boundaries — a huggingface `SemanticChunker` or LangChain's `RecursiveCharacterTextSplitter` with markdown-aware fallbacks. That's overkill for this codebase's shape.

For code corpora, chunking on function or class boundaries is standard. GitHub Copilot's retrieval uses AST-based chunking. Not applicable here — no code corpus.

## Project exercises

### Exercise — structural chunking of Diagnosis objects

- **Exercise ID:** C2.6-B · Case B (RAG not exercised).
- **What to build:** if `01-embeddings.md`'s Case B is taken, chunk each stored diagnosis as `{conclusion, per-hypothesis, evidence}` rather than concatenating to one blob. Store `{investigationId, chunkKind, text, vector}`.
- **Why it earns its place:** proves you chunk at semantic seams, not by naive token windows. Interviewer signal: "I chunked by the schema's structure, not by tokens."
- **Files to touch:** `lib/rag/chunk.ts` (new), `lib/rag/embed.ts` (call chunker before embedding).
- **Done when:** running the embed step on 10 diagnoses produces ~50 chunks (5 per diagnosis) with distinct `chunkKind` fields.
- **Estimated effort:** <1hr on top of the embed exercise.

## Interview defense

**Q: What chunk size do you use?**

Depends on the corpus's structure. For structured data (JSON schemas, markdown with headings), I chunk on the natural boundary — one chunk per section or field. For unstructured prose, 200-500 tokens with sentence-aware splitting. Fixed-size token windows are the last resort.

**Q: Why not just embed the whole document as one chunk?**

Because retrieval works on cosine similarity between the query and each chunk vector. If the whole doc is one chunk, you get one relevance score for a doc that might contain 10 semantically different sections. Chunking lets retrieval find the relevant SECTION, not just the relevant doc.

**Q: Overlap?**

Fixed-size chunking often uses 10-20% overlap to avoid cutting key phrases in half. Structural chunking usually skips overlap — the boundaries are already semantic. This codebase's would-be corpus is structured, so overlap doesn't add value.

## See also

- `01-embeddings.md` — what each chunk becomes
- `04-vector-databases.md` — where the chunks live
- `07-reranking.md` — the two-stage retrieval that lets you use small chunks
