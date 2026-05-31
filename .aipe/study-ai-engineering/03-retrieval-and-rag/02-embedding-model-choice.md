# Embedding model choice (dimension, cost, domain fit)

**Industry name(s):** embedding model selection, retrieval model benchmarking (MTEB), dimension/cost tradeoff
**Type:** Industry standard · Language-agnostic

> Choosing an embedding model is choosing three numbers — dimension, per-token cost, and domain-fit on *your* data — and the right model is the smallest, cheapest one that holds retrieval quality on your own corpus; blooming insights embeds nothing, so this is study material and a buildable target.


---

## Why care

You already pick models by tier in this codebase: `claude-haiku-4-5` for the cheap one-word intent classification, `claude-sonnet-4-6` for the analyst agents (`lib/agents/intent.ts` L14, `lib/agents/base.ts` L9). That decision — small/cheap model for the easy job, large/capable model for the hard job — is exactly the embedding-model decision, applied to a different model family. You would not run the intent classifier on Sonnet; you should not reflexively reach for the 3072-dimension embedding model either.

The question this answers is: of the dozen available embedding models, which one do you embed your schema terms with — and on what evidence?

**The pivot: a bigger embedding model is not automatically a better one for your data, and every extra dimension is paid for on every comparison, forever.** A 3072-dimension model stores 8× the floats of a 384-dimension model, costs more per embed call, and makes every cosine computation 8× longer — and if your terms are short event names that a 384-dimension model already separates cleanly, you bought nothing. The choice is a measurement, not a default.

Before a deliberate choice:
- You pick the model with the highest benchmark number on a leaderboard
- The leaderboard tested news articles; your data is event names like `add_to_cart`
- You pay for 3072 dimensions and get the same retrieval quality 384 would have given

After:
- You evaluate two or three candidates on *your* event/property names
- You pick the smallest dimension that holds retrieval quality on that set
- Cost and latency drop with no quality loss

It is the haiku-vs-sonnet tiering decision, made for the embedding model family.

---

## How it works

**Mental model.** Three knobs, traded against each other, decided by measuring on your own data:

```
  dimension ───────── higher = finer distinctions, more storage + slower cosine
  cost/token ──────── per-embed price (or zero, if self-hosted)
  domain fit ──────── how well the model's training matches YOUR text
       │
       └── pick the smallest/cheapest model that holds quality on YOUR corpus
```

There is no globally best embedding model, the same way there is no globally best chat model — `claude-haiku-4-5` is *better* than Sonnet for the 16-token intent classification because it is cheaper and fast enough. The body below walks each knob.

---

### Dimension: the storage-and-speed knob

Dimension is the length of the float array. It is paid three times: storage (floats per vector), bandwidth (moving vectors), and compute (every cosine is a loop of that length).

```
  dimension   floats/vector   storage @ 80 terms   cosine ops/comparison
  ─────────   ─────────────   ──────────────────   ─────────────────────
     384            384          ~123 KB                 384 mults
    1536           1536          ~492 KB                1536 mults
    3072           3072          ~983 KB                3072 mults
```

At 80 schema terms every option is trivial. At a million chunks the dimension is the difference between a 1.5 GB and a 6 GB index. Higher dimension captures finer semantic distinctions — but only if your data *has* distinctions that fine. Short event names rarely do. `text-embedding-3` even supports truncating its output dimension (Matryoshka representation), so you can train at 3072 and serve at 512.

### Cost: per-token, or zero

Hosted embedding models bill per token embedded, like the chat models. Self-hosted open-weight models (`bge`, `nomic-embed`) cost only the GPU/CPU you run them on — zero marginal per-call cost, at the price of operating the model.

```
  hosted (OpenAI/Cohere/Voyage)        self-hosted (bge/nomic)
  ─────────────────────────────        ───────────────────────
  $ per million tokens embedded        $0 per call
  no infra to run                      you run the model
  data leaves your boundary            data stays in your boundary
```

For a one-time schema embed (80 terms, embedded once at bootstrap and cached) cost is rounding error either way. For continuously re-embedding a large changing corpus, cost dominates the choice.

### Domain fit: measured on YOUR data, not a leaderboard

The MTEB benchmark ranks embedding models on standard datasets (retrieval, clustering, classification). It is a starting filter, not the answer — the leaderboard's retrieval tasks are mostly prose documents, and your data is short structured identifiers (`checkout_started`, `bx_loyalty_tier`). A model that tops MTEB on news retrieval may separate your event names no better than a 384-dimension general model.

```
  leaderboard quality          your-corpus quality
  ──────────────────────       ──────────────────────────────
  tested on Wikipedia/news     tested on YOUR event names
  ranks model A #1             model A and B tie on your terms
       │                            │
       └── starting filter          └── the actual decision
```

The right procedure: take a handful of query→expected-term pairs from your own schema (e.g. "sales"→`purchase`), embed with each candidate, and measure recall@k. Pick the smallest model that gets them all right.

### The principle

Model selection — for chat or embeddings — is choosing the *cheapest sufficient* model for the specific job, verified by measurement on the actual data, not by leaderboard rank or by reflexively maxing capability. The codebase already lives this with haiku-vs-sonnet; the embedding choice is the same discipline in a different model family.

---

## Embedding model choice — diagram

This diagram spans the decision (Service layer, where the embedder is configured) and the consequence (State layer, where dimension determines index size). A reader who sees only this should grasp that the choice is a measured tradeoff among dimension, cost, and domain fit.

```
┌──────────────────────────────────────────────────────────────────────┐
│  SERVICE LAYER  (lib/mcp/embeddings.ts — the embedder config)        │
│                                                                      │
│   candidates: [ small-384, std-1536, large-3072, self-hosted-768 ]  │
│        │                                                             │
│   evaluate on YOUR corpus:                                          │
│     query→expected pairs from schema ("sales"→purchase, ...)        │
│        │                                                             │
│   measure recall@k + cost + cosine latency                         │
│        │                                                             │
│   pick smallest dimension that holds recall                        │
│        ▼                                                             │
│   chosen: std-1536  (recall 1.0, acceptable cost)                  │
└──────────────────────────┬───────────────────────────────────────────┘
                           │ dimension flows downstream
┌──────────────────────────▼───────────────────────────────────────────┐
│  STATE LAYER  (lib/state/ — the vector cache)                       │
│   Map<term, Float32Array(1536)>                                      │
│   index size, storage, and every cosine op scale with dimension     │
└──────────────────────────────────────────────────────────────────────┘
```

The dimension chosen in the Service layer is paid forever in the State layer's storage and in every comparison's compute.

---

## Implementation in codebase

**Not yet implemented.** blooming insights retrieves live via MCP tool calls + EQL against Bloomreach, not embeddings — so there is no embedding model selected, no dimension, and no retrieval benchmark.

The honest analog is the *model-tiering decision the codebase already makes for chat models*: `CLASSIFIER_MODEL = 'claude-haiku-4-5-20251001'` (`lib/agents/intent.ts` L14) is the cheap small model for the easy 16-token classification, while `AGENT_MODEL = 'claude-sonnet-4-6'` (`lib/agents/base.ts` L9) is the capable model for the analyst agents. That is the same "smallest sufficient model for the job" logic the embedding choice requires — applied to a different family. When embeddings are added, the model would be configured in a new `lib/mcp/embeddings.ts` and the chosen dimension would propagate into the `lib/state/` vector cache. The `Project exercises` block below is the primary buildable target.

---

## Elaborate

### Where this pattern comes from

Embedding model selection matured alongside the MTEB benchmark (Massive Text Embedding Benchmark, 2022), which standardized comparison across retrieval, clustering, and classification tasks. Before MTEB, teams picked whatever embedding their LLM provider shipped. After it, "which embedding model" became a measurable question — though the field quickly learned that leaderboard rank does not transfer to narrow domains, which produced the now-standard advice: filter by leaderboard, decide by your-own-data evaluation. Matryoshka representation learning (2022) added the dimension-truncation trick that decouples "train large" from "serve small."

### The deeper principle

```
  decision           cheap/small option       capable/large option
  ─────────────────  ───────────────────────  ────────────────────────
  chat model         haiku (intent, 16 tok)   sonnet (analyst agents)
  embedding model    384-dim general          3072-dim domain-tuned
  rule               smallest model that holds quality on YOUR data
```

The same selection discipline spans both model families. The mistake — in both — is choosing by raw capability instead of by sufficiency-for-the-job verified on real inputs. The codebase gets it right for chat; the embedding choice is the same call.

### Where this breaks down

1. **Leaderboard overfit.** A model fine-tuned to top MTEB may be tuned to the benchmark's quirks. On your short structured terms it can underperform a plain general model. Always re-measure on your corpus.

2. **Dimension truncation has a floor.** Matryoshka lets you serve fewer dimensions, but below some point (model-dependent) retrieval quality collapses. The "smallest that holds quality" has a hard bottom you must find by measuring.

3. **Mixing models across an index is fatal.** Vectors from different models live in incompatible spaces — a cosine between a `text-embedding-3` vector and a `bge` vector is meaningless. Changing the embedding model means re-embedding the *entire* index (`09-stale-embeddings.md`), not just new items.

### What to explore next

- **Stale embeddings** (`09-stale-embeddings.md`): switching models forces a full re-index, the costliest consequence of the choice.
- **Dense vs. sparse** (`05-dense-vs-sparse.md`): sometimes the right "embedding model" is no embedding model — keyword search wins on exact terms.
- **Vector databases** (`04-vector-databases.md`): dimension directly sizes the index and the ANN structure.

---

## Project exercises

### Benchmark two embedding models on the real schema and pick by recall@k

- **Exercise ID:** B2A.3 / B2B.2 (adapted) — the primary buildable target.
- **What to build:** assemble ~15 query→expected-term pairs from the real `WorkspaceSchema` (e.g. "sales"→`purchase`, "cart"→`add_to_cart`), embed the schema terms with two candidate models (one small ~384-dim, one large ~1536-dim), and compute recall@3 for each. Output a one-page comparison of recall, vector size, and cosine latency, and pick the model with a written justification.
- **Why it earns its place:** demonstrates you choose models by measured sufficiency on your own data, not leaderboard rank — the same discipline the codebase shows with haiku-vs-sonnet.
- **Files to touch:** new `lib/mcp/embeddings.ts` (pluggable model param), new `scripts/bench-embeddings.ts` (the harness), new `test/mcp/embeddings.bench.test.ts` (recall assertions on the chosen model).
- **Done when:** both models hit recall@3 = 1.0 on the pair set and you have selected the smaller one with a recorded rationale (it holds quality at lower cost/latency).
- **Estimated effort:** 1–4hr

### Make the embedding dimension configurable and measure the quality floor

- **Exercise ID:** C2.2 (adapted) — dimension/cost tradeoff.
- **What to build:** using a Matryoshka-capable model, truncate the chosen model's output to 256, 512, and full dimension; measure recall@3 at each on the same pair set; record the smallest dimension that still holds recall 1.0.
- **Why it earns its place:** shows you understand dimension as a paid-forever knob with a measurable quality floor, not a fixed model property.
- **Files to touch:** `lib/mcp/embeddings.ts` (dimension param + truncation), `scripts/bench-embeddings.ts` (sweep dimensions), `test/mcp/embeddings.bench.test.ts`.
- **Done when:** the report shows recall at each truncated dimension and names the smallest dimension that holds quality, with the vector cache sized accordingly.
- **Estimated effort:** 1–4hr

---

## Interview defense

### What an interviewer is really asking

"How do you pick an embedding model?" tests whether you treat it as a measured tradeoff or a leaderboard lookup. The senior signal is naming the three knobs (dimension, cost, domain fit), insisting on evaluation against your own data, and knowing that switching models forces a full re-index — plus connecting it to the cheap/capable model-tiering the codebase already does.

### Likely questions

**[mid] Why not always use the highest-ranked model on the leaderboard?**

Because the leaderboard tested prose; your data may be short structured terms a small model separates just as well. The bigger model then costs more storage and slower cosines for zero quality gain. Filter by leaderboard, decide by recall@k on your own terms.

```
leaderboard: ranks on Wikipedia retrieval
your data:   "add_to_cart", "purchase" → small model already separates
→ measure on YOUR pairs, not the board
```

**[senior] What does picking a higher dimension actually cost?**

Dimension is paid three times: storage (floats per vector), bandwidth, and compute — every cosine is a loop of that length. 3072 vs. 384 is 8× on all three, forever. Higher dimension only helps if your data has distinctions that fine; short terms rarely do. Matryoshka models let you serve fewer dimensions than you trained.

```
384  → 384 mults/cosine, ~1.5KB/vector
3072 → 3072 mults/cosine, ~12KB/vector
gain only if data needs the resolution
```

**[arch] You shipped with model A; benchmarks say model B is better. What's the migration cost?**

A full re-index. Vectors from A and B live in incompatible spaces — a cosine between them is noise. You must re-embed every item in the corpus with B before any B-query works, and you cannot mix A and B vectors in one index. That cost is why the initial choice is high-stakes.

```
index = [A-vectors]   query embedded with B → meaningless cosines
fix: re-embed ALL items with B (full reprocess)
```

### The question candidates always dodge

**"Can you mix embeddings from two models in one index?"** No — and it is the trap. Each model defines its own geometry; a cosine between a model-A vector and a model-B vector is meaningless. Even "just embed new items with the better model" silently corrupts the index. Knowing that model choice is locked in until a full re-index is the senior signal.

### One-line anchors

- `lib/agents/intent.ts` L14 — `claude-haiku-4-5`: cheap small model for the easy job (the tiering analog).
- `lib/agents/base.ts` L9 — `claude-sonnet-4-6`: capable model for the hard job.
- Pick the *smallest sufficient* embedding model, verified on your own data.
- Dimension is paid forever — storage, bandwidth, and every cosine.
- Switching models forces a full re-index; vectors across models are incompatible.

---

## Validate

### Level 1 — Reconstruct

From memory, list the three knobs an embedding-model choice trades and state the decision rule (smallest/cheapest model that holds retrieval quality on your own corpus). Note what each extra dimension costs.

### Level 2 — Explain

Out loud: why is "highest MTEB rank" the wrong final criterion? Why does choosing a model lock you in until a full re-index?

### Level 3 — Apply

Scenario: you are adding the schema-term embedding from `01-embeddings.md`. Open `lib/mcp/schema.ts` L91–L99 (the event names you would embed) and `lib/agents/intent.ts` L14 / `lib/agents/base.ts` L9 (the chat-model tiering to mirror). Name two candidate embedding models, the query→term pairs you would measure on, and the decision rule. Justify why a 384-dimension model might suffice for these short names.

### Level 4 — Defend

A colleague wants to default to a 3072-dimension model "to never be limited later." Argue the cost (8× storage and cosine compute for terms that may not need it) and propose the measured alternative (recall@k on your own pairs, pick the smallest that holds). Then state the one scenario where their instinct is right (long natural-language past-investigation documents).

### Quick check — code reference test

What model-selection discipline does blooming insights already demonstrate, and where? (Answer: cheap-small-vs-capable tiering — `claude-haiku-4-5` for the 16-token intent classification in `lib/agents/intent.ts` L14, `claude-sonnet-4-6` for the analyst agents in `lib/agents/base.ts` L9 — the same "smallest sufficient model" logic the embedding choice requires.)

## See also

→ 01-embeddings.md · → 04-vector-databases.md · → 09-stale-embeddings.md · → 11-rag.md
Updated: 2026-05-30 — Migrated to study.md v1.47 template (Phase 1+2 mechanical): removed Tradeoffs / Tech reference / Summary sections; renamed "In this codebase" → "Implementation in codebase"; moved See also to a bottom block. "Why care" preserved pending Phase 3 (Zoom out, then zoom in + LAYERS diagram) authoring.
