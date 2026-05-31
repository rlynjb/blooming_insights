# Chunking strategies (splitting text so retrieval finds the right piece)

**Industry name(s):** chunking, text splitting, passage segmentation, chunk-size/overlap tuning
**Type:** Industry standard · Language-agnostic

> Chunking decides the unit of retrieval — too large and one chunk dilutes its own meaning, too small and it loses the context to be understood — and the unit must match the question; blooming insights does not chunk for retrieval, but `schemaSummary` is a crude truncate-the-schema "chunk," so this is study material grounded in a real analog.


---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Chunking is what the Indexer does *before* embedding — it decides what counts as one retrievable unit. blooming insights has no retrieval pipeline, but it already faces the chunking problem in spirit: `schemaSummary` (`lib/agents/monitoring.ts` L15–L48) slices a 112KB schema by rank (top-20 events, top-10 props, top-30 cprops), and `truncate` (`lib/agents/base.ts` L31–L34) cuts tool results at 16,000 chars without regard for structure. Those are chunking-by-truncation; deliberate chunking would split at meaning boundaries before anything is embedded.

```
  Zoom out — where chunking sits (WOULD BE)

  ┌─ Source documents (too large to embed whole) ───┐
  │  past investigations / docs / schema             │
  └─────────────────────────┬────────────────────────┘
                            │
  ┌─ Indexer — chunking ────▼────────────────────────┐  ← we are here
  │  ★ split into chunks (size + overlap) ★          │
  │    fixed-window? semantic? structural?           │
  │  each chunk = the atomic unit of retrieval       │
  └─────────────────────────┬────────────────────────┘
                            │  chunks
  ┌─ Indexer — embedding ───▼────────────────────────┐
  │  embed(chunk) → vector                           │
  └─────────────────────────┬────────────────────────┘
                            │
  ┌─ Vector store + Retriever ──▼───────────────────┐
  │  query → top-k chunks → LLM context              │
  └──────────────────────────────────────────────────┘

  In this codebase: Not yet implemented — String.includes
  intent matching in lib/agents/intent.ts is what exists
  instead; the closest cousins are schemaSummary rank-truncation
  and base.ts truncate (char-offset cut, structure-blind).
```

**Zoom in — narrow to the concept.** The question is: when a document is too large to embed or retrieve as one unit, how do you split it so a query reliably lands on the piece that contains the answer? The chunk is the atomic unit of retrieval — you can only ever get back a *whole* chunk — so the chunk boundary decides whether the answer is retrievable at all. Too small and meaning fragments across chunks; too big and the embedding averages a dozen topics into a blurry point. How it works walks fixed-window vs semantic chunking, the overlap parameter, and the difference between `text.slice(0, 16_000)` and a paragraph-boundary split.

---

## How it works

**Mental model.** A chunk is a `key` in a retrieval index — and like a React list `key`, it must be *stable and meaningful*. The retriever can only return whole chunks, so the chunk boundary is the resolution of your search. Picking chunk size is picking the granularity at which questions can be answered: coarse chunks answer "what is this document about," fine chunks answer "what does it say about X."

```
  one big chunk                    many small chunks
  ─────────────────────────        ─────────────────────────────
  embeds to a blurry average       each embeds to a sharp point
  matches everything weakly        matches its topic strongly
  retrieves too much context       may lose surrounding context
       │                                │
       └── tune size + overlap to the question granularity ──┘
```

The body walks the strategies from crudest (what the schema summary does) to context-aware.

---

### Fixed-size chunking (the crude baseline)

Split every N characters (or tokens), optionally with a fixed overlap. The agent loop's `truncate` is this in degenerate form — it keeps the first 16k characters and drops the rest, a single chunk with everything after the boundary discarded.

```
  document: [================================================]
  fixed 1000-char chunks with 100-char overlap:
            [chunk 0........]
                     [chunk 1........]
                              [chunk 2........]
                     └─ overlap ─┘
```

Overlap exists because a fixed boundary cuts blindly — it can sever a sentence whose first half is the question's keyword and second half is the answer. Overlap re-includes the boundary region in both neighbors so the answer survives in at least one whole chunk. Fixed-size is fast and simple; it ignores meaning entirely.

### Truncate-by-rank (what the schema summary actually does)

The schema-summary helper is a chunking variant: it keeps the *most important* slice rather than the *first* slice. Events are pre-sorted by event count descending, then sliced to keep the top 20, with each event's properties capped at 10 and customer properties at 30.

```
  schema.events (sorted by eventCount desc)
  [ purchase(50k), add_to_cart(40k), ..., #20, #21(dropped), #80(dropped) ]
                                            └── MAX_EVENTS = 20 ──┘
  each kept event: properties.slice(0, 10)
  customerProperties.slice(0, 30)
```

This is smarter than first-N (it keeps the *active* events, which are usually the relevant ones) but it is still a blind cut: a low-volume event that is exactly what the user asked about (#21) is dropped before the model ever sees it. Rank-truncation trades recall for a fixed budget.

### Semantic / structural chunking (the upgrade)

Split at meaning boundaries — paragraphs, sections, or in structured data, per record. For a past investigation, the natural chunk is *per finding* or *per section* (diagnosis, each hypothesis, each recommendation), because those are the units a future query asks about.

```
  past investigation document
  ┌──────────────────────────────────────────────┐
  │ ## Diagnosis: mobile conversion dropped 18%   │ ──▶ chunk A (one topic)
  ├──────────────────────────────────────────────┤
  │ ## Hypothesis: checkout latency               │ ──▶ chunk B
  ├──────────────────────────────────────────────┤
  │ ## Recommendation: A/B test the funnel        │ ──▶ chunk C
  └──────────────────────────────────────────────┘
  each chunk = one coherent topic → one sharp embedding
```

Each chunk embeds to a sharp point because it covers one topic. A query "what did we conclude about mobile checkout?" retrieves chunk A cleanly, not a blurry whole-document average.

### Size and overlap are the two tuned knobs

```
  chunk too LARGE        chunk too SMALL         tuned
  ─────────────────      ─────────────────       ─────────────────────
  averages many topics   loses surrounding       one topic + a little
  vague embedding        context to be read      context via overlap
  retrieves noise        retrieves fragments     retrieves the answer
```

The right size depends on the question granularity and the embedding model's effective context. Overlap (typically 10–20% of chunk size) protects answers that straddle a boundary. Both are measured on retrieval quality, not guessed.

### The principle

The chunk is the atomic unit you can retrieve, so the boundary *is* the search resolution: split at the granularity of the questions you expect, because a query can only ever recover a whole chunk and never half of one. Whether the cut is by character (fixed), by rank (`schemaSummary`), or by meaning (semantic), the failure mode is identical — the answer lives across a boundary or is averaged into noise, and the retriever cannot get it.

---

## Chunking strategies — diagram

This diagram spans the Service layer (where a document is split) and the State layer (where chunks become indexed vectors). A reader who sees only this should grasp that splitting decides the unit of retrieval, and that the current `schemaSummary` is a rank-truncation special case.

```
┌──────────────────────────────────────────────────────────────────────┐
│  SERVICE LAYER  (would live next to lib/mcp/schema.ts)              │
│                                                                      │
│   CURRENT: schemaSummary                    │
│     full schema ──▶ sort by eventCount ──▶ slice(0,20) ──▶ text     │
│                       (rank-truncation: one cut, drop the tail)     │
│                                                                      │
│   PROPOSED: chunk a past investigation                             │
│     document ──▶ split at section/finding boundaries ──▶ chunks     │
│                  └─ size + overlap tuned to question granularity ─┘ │
│        │                                                            │
│        ▼                                                            │
│   embed each chunk (01-embeddings.md)                              │
└──────────────────────────┬───────────────────────────────────────────┘
                           │ chunks → vectors
┌──────────────────────────▼───────────────────────────────────────────┐
│  STATE LAYER  (lib/state/ — the vector index)                       │
│   [chunk A vec][chunk B vec][chunk C vec] ...                        │
│   a query retrieves WHOLE chunks — the boundary is the resolution   │
└──────────────────────────────────────────────────────────────────────┘
```

The split decided in the Service layer fixes, permanently, the smallest piece any query can ever retrieve.

---

## Implementation in codebase

**Not yet implemented.** blooming insights retrieves live via MCP tool calls + EQL against Bloomreach, not embeddings over chunked documents — there is no document corpus and no retrieval-time chunking.

The honest analog is `schemaSummary` (`lib/agents/monitoring.ts` L15–L48): it is a crude truncate-the-schema "chunking." Faced with a schema too large for the prompt, it sorts events by `eventCount` (`lib/mcp/schema.ts` L99) and keeps a fixed slice — `MAX_EVENTS = 20`, `MAX_PROPS_PER_EVENT = 10`, `MAX_CPROPS = 30` — discarding the rest. That is a chunking decision (which slice survives the budget) made by rank-truncation, with the same failure mode as any chunker: the relevant item below the cut is silently lost. A second, even cruder analog is `truncate` (`lib/agents/base.ts` L31–L34), which keeps the first 16k characters of a tool result and appends `…[truncated]`. Real retrieval chunking would live where past investigations are stored (`lib/state/investigations.ts`) when the "search past investigations" feature is built. The `Project exercises` block below is the primary buildable target.

---

## Elaborate

### Where this pattern comes from

Chunking emerged as the practical bottleneck of RAG once teams discovered that retrieval quality is dominated by chunk design, not embedding-model rank. The early default was fixed-size character splitting (LangChain's `CharacterTextSplitter`); the field then moved to recursive splitting (split on paragraphs, then sentences, then characters, preserving structure as long as possible — LangChain's `RecursiveCharacterTextSplitter`) and structure-aware splitters (Markdown headers, code functions). The current frontier is semantic chunking — using an embedding model to detect topic shifts and cut there — and "small-to-big" / parent-document retrieval, where you embed small chunks for precision but return their larger parent for context.

### The deeper principle

```
  what you optimize        chunk strategy
  ───────────────────      ────────────────────────────────
  speed / simplicity       fixed-size + overlap
  fixed token budget       rank-truncation (schemaSummary)
  precise retrieval        semantic / per-record chunks
  precision + context      small-to-big (embed small, return parent)
```

Every strategy is a different answer to "what is the atomic retrievable unit," and the right one is dictated by the shape of the expected questions, not by a universal best practice.

### Where this breaks down

1. **Rank-truncation drops the long tail.** `schemaSummary` keeping the top-20 events by volume means a rare-but-relevant event (a new feature's event, fired few times) is invisible. The cut optimizes for the common question and silently fails the specific one.

2. **Fixed-size severs meaning.** A boundary at character 1000 can land mid-table or mid-sentence, splitting a fact across two chunks so neither holds it whole. Overlap mitigates but does not eliminate this.

3. **Over-chunking destroys context.** Splitting per sentence makes each chunk's embedding precise but strips the surrounding text needed to interpret it — "it dropped 18%" is useless without the chunk that says what "it" is.

### What to explore next

- **Incremental indexing** (`10-incremental-indexing.md`): when a document changes, which chunks must be re-embedded.
- **Vector databases** (`04-vector-databases.md`): chunks are what the index stores; chunk count drives index size.
- **Reranking** (`07-reranking.md`): over-retrieving small chunks then reranking is a common fix for the precision/context tension.

---

## Project exercises

### Chunk past investigations per finding for retrieval

- **Exercise ID:** B2A.5 / B2B.1 (adapted) — the primary buildable target.
- **What to build:** when the "search past investigations" feature is added, write a chunker that splits a stored investigation (`lib/state/investigations.ts`) into per-section chunks — the diagnosis conclusion, each hypothesis, each recommendation — with a small overlap, ready to embed. Each chunk carries metadata (`insightId`, section type) so a retrieved chunk traces back to its investigation.
- **Why it earns its place:** demonstrates you split at question-granularity meaning boundaries, not blind character offsets, and that you preserve traceability — the core chunking judgment.
- **Files to touch:** new `lib/mcp/chunking.ts` (the splitter), `lib/state/investigations.ts` (expose investigations as documents), `lib/mcp/types.ts` (a `Chunk` type with metadata), new `test/mcp/chunking.test.ts`.
- **Done when:** a real demo investigation splits into coherent single-topic chunks (one per finding), each carrying its `insightId` and section type, with verified overlap at boundaries.
- **Estimated effort:** 1–2 days

### Replace `schemaSummary` rank-truncation with query-driven schema chunks

- **Exercise ID:** C2.3 (adapted) — fix the long-tail recall hole.
- **What to build:** instead of statically keeping the top-20 events, treat each event (name + properties) as a chunk, embed them (from `01-embeddings.md`), and at scan time retrieve the events semantically nearest the user's question to build a *query-relevant* schema summary — so a low-volume but relevant event below the rank cut is still included.
- **Why it earns its place:** shows you found the rank-truncation recall hole and replaced a static cut with query-driven retrieval, the exact chunking-vs-retrieval upgrade.
- **Files to touch:** `lib/mcp/chunking.ts` (per-event chunks), `lib/mcp/embeddings.ts` (embed chunks), `lib/agents/monitoring.ts` (`schemaSummary` becomes query-aware), `test/agents/monitoring.test.ts`.
- **Done when:** a question about a deliberately low-volume event (ranked below #20) still surfaces that event in the summary, where the old `slice(0, 20)` dropped it.
- **Estimated effort:** 1–2 days

---

## Interview defense

### What an interviewer is really asking

"How do you chunk documents for RAG?" tests whether you understand that the chunk is the unit of retrieval and that boundary placement decides recall. The senior signal is naming the size/overlap tradeoff, splitting at meaning boundaries for the expected question granularity, and recognizing rank-truncation (like `schemaSummary`) as a chunking strategy with a long-tail recall hole.

### Likely questions

**[mid] What goes wrong if chunks are too big or too small?**

Too big: the chunk averages many topics, its embedding is a vague point that matches everything weakly, and retrieval returns noise. Too small: the chunk loses the surrounding context needed to interpret it — "it dropped 18%" without what "it" is. Tune size to question granularity, add overlap for boundaries.

```
big   → blurry average → noise
small → fragment → no context
tuned → one topic + a little context
```

**[senior] `schemaSummary` keeps the top-20 events by volume. What's the failure mode?**

It is rank-truncation chunking, and it drops the long tail. A low-volume but relevant event (a new feature's event, ranked #21) is cut before the model ever sees it, so a question about it silently fails. The fix is query-driven retrieval: embed each event and retrieve the ones relevant to the question, not the highest-volume ones.

```
events sorted by count → slice(0,20) → #21 relevant event DROPPED
fix: embed events, retrieve by query relevance
```

**[arch] How would you chunk a past investigation for a "find similar past work" feature?**

Per finding — split into the diagnosis conclusion, each hypothesis, each recommendation — because those are the units a future query asks about, and each is one coherent topic that embeds to a sharp point. Carry `insightId` metadata on every chunk so a retrieved chunk traces back. Add small overlap if findings reference each other.

```
investigation → [diagnosis][hyp 1][hyp 2][rec 1][rec 2]
each chunk: one topic + insightId metadata
```

### The question candidates always dodge

**"What's the right chunk size?"** There is no universal number — and claiming one (the "512 tokens" reflex) is the tell. The right size is measured on retrieval quality for *your* questions and *your* embedding model. The honest answer is "I'd sweep a few sizes, measure recall@k on real query→chunk pairs, and pick the smallest that holds quality," exactly the measurement discipline from `02-embedding-model-choice.md`.

### One-line anchors

- `lib/agents/monitoring.ts` L15–L48 — `schemaSummary`: rank-truncation chunking (top-20 events).
- `lib/mcp/schema.ts` L99 — events pre-sorted by `eventCount`, which drives the truncation.
- `lib/agents/base.ts` L31–L34 — `truncate`: first-16k-char single-chunk cut.
- The chunk is the atomic retrievable unit; the boundary is the search resolution.
- Rank-truncation drops the long tail — the relevant rare item is lost below the cut.

---

## Validate

### Level 1 — Reconstruct

From memory, draw a document split three ways: fixed-size with overlap, rank-truncation (keep the top slice), and semantic (split at section boundaries). State the failure mode of each.

### Level 2 — Explain

Out loud: why is the chunk boundary the "resolution" of a search? Why does a too-large chunk produce a blurry embedding?

### Level 3 — Apply

Scenario: build a chunker for past investigations. Open `lib/state/investigations.ts` (stored events per investigation) and `lib/mcp/types.ts` L68–L77 (the `Investigation` shape). Name the natural chunk boundaries (diagnosis, hypotheses, recommendations), the metadata each chunk must carry to trace back, and where overlap helps. Contrast with `schemaSummary`'s rank-truncation in `lib/agents/monitoring.ts` L15–L48.

### Level 4 — Defend

A colleague says "just make each whole investigation one chunk — simpler." Argue the cost (its embedding averages a dozen topics into a vague point that matches everything weakly) and propose per-finding chunking with traceability metadata. Then name when the one-chunk approach is actually fine (very short investigations).

### Quick check — code reference test

What chunking strategy does blooming insights use today, where, and what does it silently drop? (Answer: rank-truncation — `schemaSummary` in `lib/agents/monitoring.ts` L15–L48 sorts events by `eventCount` and keeps the top 20 (`MAX_EVENTS`), 10 properties each, 30 customer properties — silently dropping every relevant event below the volume cut.)

## See also

→ 01-embeddings.md · → 04-vector-databases.md · → 10-incremental-indexing.md · → 11-rag.md
Updated: 2026-05-30 — Migrated to study.md v1.47 template (Phase 1+2 mechanical): removed Tradeoffs / Tech reference / Summary sections; renamed "In this codebase" → "Implementation in codebase"; moved See also to a bottom block. "Why care" preserved pending Phase 3 (Zoom out, then zoom in + LAYERS diagram) authoring.
Updated: 2026-05-30 — Phase 3 of study.md v1.47 migration: replaced "Why care" block with "Zoom out, then zoom in" (LAYERS diagram + zoom-in paragraph) per format.md.
Updated: 2026-05-31 — Applied study.md v1.48: scrubbed "How it works" of file paths, line refs, and real-code fences; replaced with generic role labels + pseudocode per format.md. Codebase-specific anchoring lives exclusively in "Implementation in codebase".
