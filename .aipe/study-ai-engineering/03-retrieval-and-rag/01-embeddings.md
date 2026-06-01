# Embeddings (turning text into a vector you can compare)

**Industry name(s):** text embeddings, dense vector representations, semantic vectors
**Type:** Industry standard · Language-agnostic

> An embedding is a function from a string to a fixed-length array of floats where geometric closeness encodes semantic similarity; blooming insights does not use them — it fuzzy-matches schema terms with exact substring checks and hands the model a truncated `schemaSummary`, so this is study material and a buildable target, not a present feature.


---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Embeddings would sit at the *front* of a retrieval pipeline that does not yet exist in blooming insights: an Indexer turns each schema string into a vector, a Vector store holds the index, a Retriever embeds the query and pulls nearest neighbors, and the result feeds the LLM's context. The codebase has none of these layers — the closest thing it does is exact substring matching in `lib/agents/intent.ts` and a truncated `schemaSummary` (`lib/agents/monitoring.ts` L15–L48) handed to the model in full.

```
  Zoom out — where embeddings would live (WOULD BE)

  ┌─ Indexer (offline, one-time per schema) ─────────┐  ← we are here
  │  for each schema term:                            │
  │  ★ embed(term) → fixed-length float vector ★      │
  └─────────────────────────┬────────────────────────┘
                            │  vectors
  ┌─ Vector store ──────────▼────────────────────────┐
  │  { term → vector }   ANN index                   │
  └─────────────────────────┬────────────────────────┘
                            │
  ┌─ Retriever (per query) ─▼────────────────────────┐
  │  embed(query) → cosine-nearest neighbors          │
  └─────────────────────────┬────────────────────────┘
                            │  top-k relevant terms
  ┌─ LLM context ───────────▼────────────────────────┐
  │  pack only the relevant schema slice in the prompt│
  └──────────────────────────────────────────────────┘

  In this codebase: Not yet implemented — String.includes
  intent matching in lib/agents/intent.ts is what exists
  instead (plus a truncated schemaSummary handed to the model).
```

**Zoom in — narrow to the concept.** The question is: how do you compute "these two strings mean similar things" as a number, when the strings share no characters? An embedding maps each string to a point in a high-dimensional space (384–3072 dims typically) where geometric closeness encodes semantic similarity — `purchase` lands near `sale` even though `"sale".includes("purchase")` is false. How it works walks the function shape, cosine similarity, and the one-shot offline cost vs the per-query lookup cost.

---

## Structure pass

**Layers.** Four WOULD-BE layers in a retrieval pipeline that doesn't yet exist here: the indexer that runs `embed(term)` once per schema term (offline, build-time), the vector store that holds `{ term → vector }`, the per-query retriever that runs `embed(query)` then cosine-nearest, and the LLM context that gets only the relevant slice. blooming insights has none of these — its closest analog is `String.includes` matching in `parseIntent`.

**Axis: lifecycle.** When does each layer's work happen — build-time (once per schema), per-query (every request), or never? This axis is the right lens for a Case B WOULD-BE file because the whole point of embeddings is *moving expensive work from per-query to build-time*. Cost is downstream; the upstream design move is the temporal split: embed once, scan many times. Control doesn't flip (CODE owns both stages).

**Seams.** The cosmetic seam is between the vector store and the retriever — both are query-time but neither flips lifecycle. The load-bearing WOULD-BE seam is between the indexer (build-time, runs once per term) and the retriever (per-query, runs on every request): lifecycle flips here from "amortized cost paid once" to "small cost paid per request." This is the seam that justifies the whole architecture — if you can't pay the build-time cost or the index goes stale (→ 09-stale-embeddings.md), embeddings stop earning their place. In blooming insights this seam doesn't exist; the schema is hand-truncated and re-handed-in on every request.

```
  Structure pass — embeddings (WOULD BE)

  ┌─ 1. LAYERS ───────────────────────────────────┐
  │  indexer (embed(term), build-time)             │
  │  vector store ({term → vector})                │
  │  retriever (embed(query) + cosine, per-query)  │
  │  LLM context (relevant slice)                  │
  └────────────────────────┬───────────────────────┘
                           │  pick the axis
  ┌─ 2. AXIS ─────────────▼────────────────────────┐
  │  lifecycle: when does each layer's work        │
  │  happen — build-time or per-query?             │
  └────────────────────────┬───────────────────────┘
                           │  trace across layers, find flips
  ┌─ 3. SEAMS ────────────▼────────────────────────┐
  │  store↔retriever: cosmetic (both per-query)    │
  │  indexer↔retriever: LOAD-BEARING (would be)    │
  │    build-time (once) → per-query (every call)  │
  │    today: this seam doesn't exist              │
  └────────────────────────┬───────────────────────┘
                           ▼
                   Block 4 — How it works
```

The skeleton is mapped — the rest of this file walks the mechanics that hang off it.

## How it works

**Mental model.** Think of an embedding as a hash function with one critical difference from the hashes you use for `Map` keys — and blooming insights uses *none* of this; the codebase substitutes a truncated `schemaSummary` plus the model's own fuzzy matching for what embeddings would do. A normal hash (`JSON.stringify(args)` as in `McpClient`'s `cacheKey`) is designed so that *similar* inputs produce *wildly different* outputs — that is what makes it a good hash. An embedding is the opposite: it is designed so that *similar meanings* produce *similar outputs*. Two near-synonyms hash to nearby points; two unrelated words hash to distant points. The "distance" is then a real number you can sort on.

```
  hash (for Map keys)              embedding (for similarity)
  ─────────────────────           ──────────────────────────
  "purchase" → 0x9f3a             "purchase" → [0.21, -0.08, 0.55, ...]
  "purchases"→ 0x1c07             "purchases"→ [0.20, -0.07, 0.54, ...]
   similar input,                   similar input,
   DISTANT output (good hash)       NEARBY output (good embedding)
```

The body below builds up from one string to a comparison.

---

### A string becomes a fixed-length float array

The embedding model is a neural network (the same transformer family as the chat model, usually a smaller encoder-only variant) that reads a string and emits one vector. The vector length is fixed per model — every input, whether one word or a paragraph, yields the same number of floats.

```
  "view_item"  ──▶ [ embedding model ] ──▶ [0.11, -0.42, 0.07, ..., 0.33]
                                                └──── 1536 floats ────┘
  "product page view" ──▶ [ same model ] ──▶ [0.13, -0.40, 0.05, ..., 0.31]
                                                  near the first vector
```

The output is dense — almost every float is non-zero and carries information. This is the defining property of a *dense* representation, and it is the contrast that `05-dense-vs-sparse.md` develops: a sparse representation (keyword counts) has mostly zeros.

### Closeness is cosine similarity

Once two strings are vectors, "how similar?" is the cosine of the angle between them — the dot product divided by the product of magnitudes. It ranges from -1 (opposite) through 0 (unrelated) to 1 (identical direction). For normalized embeddings (magnitude 1, which most models emit) cosine similarity is just the dot product.

```
  cosine(a, b) = (a · b) / (|a| · |b|)

           ▲ dim 2
           │      b "sale"
           │     ╱
           │    ╱  small angle → cosine ≈ 0.9 → similar
           │   ╱
           │  ╱  a "purchase"
           │ ╱___________________________________________________
           │╱  c "password_reset"   large angle → cosine ≈ 0.05
           └─────────────────────────────────────────────────────▶ dim 1
```

The arithmetic is trivial — a `for` loop over the two arrays multiplying and summing. The intelligence is entirely in the model that placed the points; the comparison itself is grade-school math.

### Nearest-neighbor over a set

To find the schema events closest to a query term, embed the query once, then compute its cosine similarity against every pre-embedded event name and sort descending. For 80 event names this is 80 dot products — microseconds.

```
  query "sales" ──▶ embed ──▶ q
  for each event name e (pre-embedded as v_e):
      score[e] = cosine(q, v_e)
  sort by score descending, take top k

  purchase          0.71  ◀── top match (no shared characters with "sales")
  checkout_started  0.58
  add_to_cart       0.49
  view_item         0.22
  password_reset    0.04  ◀── correctly ignored
```

This is the inner loop of every retrieval system. At 80 items you scan them all (brute force); at a million you need an index (`04-vector-databases.md`).

### The principle

An embedding converts a fuzzy human judgment — "do these mean the same thing?" — into a sortable number, by relocating both strings into a space where geometric distance *is* semantic distance. Once meaning is coordinates, every comparison problem becomes a distance problem, and distance problems have fast, well-understood solutions. The hard part is the model that assigns coordinates; everything downstream is arithmetic.

---

## Embeddings — diagram

This diagram spans the Service layer (where embedding would happen) and the State layer (where vectors would be stored). A reader who sees only this should grasp that text goes in, a fixed float array comes out, and comparison is a distance computation over those arrays.

```
┌──────────────────────────────────────────────────────────────────────┐
│  SERVICE LAYER  (would live in lib/mcp/, alongside schema.ts)        │
│                                                                      │
│  schema.events[].name        query term ("sales")                   │
│        │                            │                               │
│   embed each once             embed once                            │
│        ▼                            ▼                               │
│   [v_purchase]               q = [0.21, -0.08, ...]                 │
│   [v_add_to_cart]                  │                                │
│   [v_view_item]                    │  cosine(q, v_e) for each e     │
│        │                           │                                │
│        └───────────┬───────────────┘                               │
│                    ▼                                                │
│         sort by similarity → top-k event names                     │
└──────────────────────────┬───────────────────────────────────────────┘
                           │  embeddings persisted (so we embed once)
┌──────────────────────────▼───────────────────────────────────────────┐
│  STATE LAYER  (would live in lib/state/, like investigations.ts)    │
│   Map<eventName, Float32Array>   ← the "index"                      │
│   built at bootstrap, reused across requests                        │
└──────────────────────────────────────────────────────────────────────┘
```

The model assigns coordinates once; the State layer caches them; the Service layer does cheap distance math on every query.

---

## Implementation in codebase

**Not yet implemented.** blooming insights retrieves live via MCP tool calls + EQL against Bloomreach, not embeddings or a vector store — there is no embedding model call, no vector, and no cosine similarity anywhere in the repo.

The closest present behavior is two things, both honest non-embedding analogs. First, schema *delivery*: `schemaSummary` (`lib/agents/monitoring.ts` L15–L48) hands the model a truncated text list of the top-20 events and their properties, and the *model* — not code — does the fuzzy "which events are relevant" judgment in its head. Second, term *matching*: `parseIntent` (`lib/agents/intent.ts` L6–L12) does the crudest possible semantic match — `t.includes('monitoring')` — which is exactly the substring matching that embeddings exist to replace. An embedding layer would live next to `lib/mcp/schema.ts` (it already produces the `WorkspaceSchema.events[].name` list that is the natural thing to embed) with the vector store in `lib/state/`. The `Project exercises` block below is the primary buildable target.

---

## Elaborate

### Where this pattern comes from

Embeddings descend from distributional semantics — the linguistics observation (Firth, 1957) that "you shall know a word by the company it keeps." word2vec (Mikolov, 2013) made it practical: train a shallow network to predict a word from its neighbors and the hidden layer becomes a usable vector. Modern sentence/text embeddings (Sentence-BERT, OpenAI `text-embedding-3`, Cohere `embed-v3`, Voyage) are transformer encoders fine-tuned with contrastive objectives so that paraphrases land close and unrelated text lands far. The output dimension is a model design choice: 384 (small, fast), 1536 (`text-embedding-3-small`), 3072 (`text-embedding-3-large`).

### The deeper principle

```
  problem type            classic solution        embedding solution
  ──────────────────────  ──────────────────────  ──────────────────────
  exact match             hash table / index      n/a (use the hash)
  prefix / substring      trie / .includes        n/a
  fuzzy spelling          Levenshtein distance     embedding (overkill)
  same MEANING            ??? (no string op works) embedding (the point)
```

Every string-comparison tool you already use solves a *surface* problem. Embeddings are the only tool that solves the *meaning* problem, and they do it by giving up on strings entirely — converting to geometry first, then comparing.

### Where this breaks down

1. **Embeddings blur exact distinctions.** `event_id_4471` and `event_id_4472` are different things but near-identical strings, so they embed to nearly the same point. For exact-ID matching, embeddings are worse than `===`. They help with meaning, not with identity.

2. **Out-of-domain terms embed poorly.** A model trained on general web text places `purchase` and `sale` correctly but may have no useful position for a company-specific event like `bx_loyalty_tier_upgraded`. Domain jargon needs either a domain-tuned model or the surrounding context embedded with it.

3. **The vector is opaque.** When `embed("sales")` ranks `password_reset` above `purchase`, there is no log line to read. Debugging a bad match means inspecting 1536 floats that mean nothing to a human. A substring match, by contrast, is trivially explainable.

### What to explore next

- **Embedding model choice** (`02-embedding-model-choice.md`): dimension, cost, and domain fit are the real decisions.
- **Vector databases** (`04-vector-databases.md`): where the pre-embedded vectors live and how nearest-neighbor scales past brute force.
- **Dense vs. sparse** (`05-dense-vs-sparse.md`): when the embedding's blurring is a liability and keyword matching wins.

---

## Project exercises

### Embed the workspace schema for code-level fuzzy term matching

- **Exercise ID:** B2A.1 / B2A.6 (adapted) — the primary buildable target.
- **What to build:** at bootstrap, embed every `WorkspaceSchema.events[].name` (and customer-property name) once, cache the vectors, and expose `nearestSchemaTerms(query: string, k: number)` that embeds the query and returns the top-k event/property names by cosine similarity. Use it to pre-filter `schemaSummary` to the slice relevant to the user's question.
- **Why it earns its place:** demonstrates you can turn a meaning-matching problem into a distance problem and know the difference between fuzzy spelling (`Levenshtein`) and fuzzy meaning (embeddings) — the foundational RAG skill.
- **Files to touch:** new `lib/mcp/embeddings.ts` (embed + cosine + `nearestSchemaTerms`), `lib/mcp/schema.ts` (call the embedder after `parseWorkspaceSchema`), `lib/agents/monitoring.ts` (`schemaSummary` accepts a relevant-terms filter), new `test/mcp/embeddings.test.ts`.
- **Done when:** `nearestSchemaTerms("sales", 3)` returns `purchase` ahead of `password_reset` against the real schema, with the vectors built once and reused across requests.
- **Estimated effort:** 1–2 days

### Replace the `parseIntent` substring heuristic with an embedding fallback

- **Exercise ID:** C2.1 (adapted) — embeddings vs. substring matching.
- **What to build:** keep `parseIntent`'s exact substring check as the fast path, but when it falls through to the default, compute the query's cosine similarity to three pre-embedded intent exemplars ("what changed", "why did it happen", "what should I do") and route by the nearest — a free-tier-then-embedding ladder.
- **Why it earns its place:** shows you understand embeddings as the layer *above* substring matching, and that you do not pay for them when the cheap check already answers.
- **Files to touch:** `lib/agents/intent.ts` (add the embedding fallback before defaulting), `lib/mcp/embeddings.ts` (reuse the embedder), `test/agents/intent.test.ts`.
- **Done when:** a paraphrase like "what's behind the drop" routes to `diagnostic` via the embedding fallback even though it contains none of the substring keywords, and the substring path still short-circuits exact matches with no embed call.
- **Estimated effort:** 1–4hr

---

## Interview defense

### What an interviewer is really asking

"What is an embedding?" tests whether you can explain *why* a float array beats a string for similarity — that the model relocates text into a space where distance is meaning. The senior signal is naming the contrast with hashing (similar→nearby, not similar→distant), citing cosine similarity as the comparison, and knowing when embeddings are the wrong tool (exact IDs).

### Likely questions

**[mid] Why can't you just use `String.includes` to find related schema terms?**

Because `includes` only finds shared *characters*. The user says "sales" but the event is `purchase` — zero shared substring, zero match. Embeddings map both to nearby points in meaning-space so a cosine comparison ranks them as similar.

```
"sales".includes in [purchase, ...] → no match
embed("sales") · embed("purchase") → 0.71 → match
```

**[senior] How does the similarity comparison actually work once you have vectors?**

Cosine similarity: the dot product of the two vectors divided by the product of their magnitudes — the cosine of the angle between them. For normalized embeddings it is just the dot product, a single `for` loop. You embed the query once, score it against every pre-embedded candidate, and sort.

```
score[e] = Σ q[i]·v_e[i]   (unit vectors)
sort desc → top-k
```

**[arch] When are embeddings the wrong choice?**

For exact identity. `event_4471` and `event_4472` are different things but near-identical strings, so they embed to nearly the same point — an embedding will confuse them where `===` never would. Use embeddings for meaning, hashes/equality for identity. Also: opaque debugging — a bad match is 1536 floats with no readable cause.

```
exact ID match   → === / hash (embedding blurs)
substring        → .includes (embedding overkill)
same meaning     → embedding (the only tool that works)
```

### The question candidates always dodge

**"What dimension should the embedding be?"** It is a real tradeoff, not a detail: higher dimensions (3072) capture finer distinctions but cost more storage and compute per comparison; lower dimensions (384) are faster and cheaper but blur more. The honest answer is "measure retrieval quality at each dimension on your own data and pick the smallest that holds the quality" — `text-embedding-3` even lets you truncate dimensions to tune this. Naming the tradeoff is the signal.

### One-line anchors

- `lib/agents/intent.ts` L6–L12 — `parseIntent`'s `t.includes(...)`: the substring matching embeddings replace.
- `lib/agents/monitoring.ts` L15–L48 — `schemaSummary`: schema as text for the model to fuzzy-match, no embeddings.
- An embedding is a hash whose *similar inputs map to nearby outputs*.
- Comparison is cosine similarity = dot product over unit vectors.
- Embeddings blur exact distinctions — wrong for IDs, right for meaning.

---

## Validate

### Level 1 — Reconstruct

From memory, draw a string going into an embedding model and out as a fixed-length float array, then two such arrays compared by the angle between them. State what cosine similarity returns for identical, unrelated, and opposite meanings (1, ~0, -1).

### Level 2 — Explain

Out loud: why is an embedding the *opposite* of a hash function you would use for a `Map` key? Why does that opposition make it useful for similarity and useless for exact lookup?

### Level 3 — Apply

Scenario: a user query "checkout abandonment" must select relevant events from the real schema. Open `lib/mcp/schema.ts` L91–L99 (where `events[].name` is built) and `lib/agents/monitoring.ts` L15–L48 (`schemaSummary`). Name exactly where you would embed the event names, where you would cache the vectors, and how `nearestSchemaTerms` would feed `schemaSummary`. Explain why `checkout_started` would rank high even though "abandonment" appears in no event name.

### Level 4 — Defend

A colleague says "just embed everything, embeddings are always better than string matching." Argue back using two cases from this codebase where they are wrong: matching an exact event ID, and the current `parseIntent` exact keyword check that should stay a substring match for speed.

### Quick check — code reference test

Does blooming insights compute any vector similarity, and what does the only term-matching code in the repo use instead? (Answer: no vector similarity exists; `parseIntent` in `lib/agents/intent.ts` L6–L12 uses exact `String.includes` substring checks — the surface-level matching embeddings exist to replace.)

## See also

→ 02-embedding-model-choice.md · → 05-dense-vs-sparse.md · → 11-rag.md · → ../04-agents-and-tool-use/04-tool-routing.md
Updated: 2026-05-30 — Migrated to study.md v1.47 template (Phase 1+2 mechanical): removed Tradeoffs / Tech reference / Summary sections; renamed "In this codebase" → "Implementation in codebase"; moved See also to a bottom block. "Why care" preserved pending Phase 3 (Zoom out, then zoom in + LAYERS diagram) authoring.
Updated: 2026-05-30 — Phase 3 of study.md v1.47 migration: replaced "Why care" block with "Zoom out, then zoom in" (LAYERS diagram + zoom-in paragraph) per format.md.
Updated: 2026-05-31 — Applied study.md v1.50: added Structure pass block (layers · axis · seams) between Zoom out and How it works per format.md's new Block 3.
Updated: 2026-05-31 — Applied study.md v1.52 voice trait (verdict first, then rank what matters) — clarity edit to Move 1 (Mental model now names the blooming insights contrast — uses none of this; truncated schemaSummary + model's own fuzzy matching — before unpacking the hash analogy).
