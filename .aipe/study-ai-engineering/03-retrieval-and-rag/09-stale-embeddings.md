# Stale embeddings (the index drifts from the source it was built from)

**Industry name(s):** embedding staleness / index freshness, re-indexing, embedding drift, source-of-truth lag
**Type:** Industry standard · Language-agnostic

> An embedding is a snapshot of a document at the moment it was embedded; when the source changes, the vector is stale and retrieval returns yesterday's answer — so an index needs a freshness policy (TTL, change-detection, or a `embedding_stale_at` marker); blooming insights has no embeddings, but its 60-second TTL cache is the exact freshness/staleness mechanism, and `embedding_stale_at` ↔ cache expiry is a direct parallel.


---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Stale embeddings is a *freshness policy* on the Vector store, parallel to the TTL policy `McpClient` already enforces on tool results (`expiresAt` check at `lib/mcp/client.ts` L40, set at L65, no-cache-on-error at L58–L60). An embedding is a cache of a document's meaning at embed-time, so the same instinct applies — it goes stale when the source changes. blooming insights has no vector store and so no staleness problem, but the *pattern* it would use is already in the codebase, applied to a different payload.

```
  Zoom out — where staleness sits (WOULD BE; parallel to TTL cache)

  ┌─ Source document ────────────────────────────────┐
  │  e.g. past investigation, re-run with new data    │
  └─────────────────────────┬────────────────────────┘
                            │  changes
  ┌─ Vector store ──────────▼────────────────────────┐  ← we are here
  │  ★ embedding_stale_at? / source_version match? ★  │
  │  parallel to McpClient's expiresAt > Date.now()   │
  │  parallel to no-cache-on-error                    │
  └─────────────────────────┬────────────────────────┘
                            │
  ┌─ Retriever ─────────────▼────────────────────────┐
  │  stale? → re-embed or skip                        │
  │  fresh? → return                                  │
  └──────────────────────────────────────────────────┘

  In this codebase: Not yet implemented — String.includes
  intent matching in lib/agents/intent.ts is what exists
  instead. The same freshness shape IS in the codebase for
  TTL caching (lib/mcp/client.ts L40, L65) — different payload.
```

**Zoom in — narrow to the concept.** The question is: an embedding was computed from a document at one instant — when the document changes, how does the index avoid serving the now-wrong vector? Unlike a TTL cache, nothing expires an embedding automatically, so a changed document silently keeps returning its old vector forever. The model reads outdated content and answers confidently wrong with no error anywhere. How it works walks the three freshness signals (TTL, source-version hash, change-feed invalidation), why no-cache-on-error transfers directly, and the rule that "fresh enough" is a policy decision, not a constant.

---

## How it works

**Mental model.** An embedding index *is* a cache: `Map<docId, vector>` where each vector is a derived value computed from a source document. Every truth you know about caches applies — cache invalidation is the hard part, stale reads are silent, and you need an expiry or invalidation rule. The codebase's `McpClient.cache` (`Map<key, {result, expiresAt}>`, `lib/mcp/client.ts` L18) is the same structure with the same problem already solved for tool results.

```
  McpClient cache (tool results)        embedding index (vectors)
  ──────────────────────────────        ──────────────────────────────
  Map<key, {result, expiresAt}>         Map<docId, {vector, staleAt?}>
  serve if expiresAt > Date.now()       trust if source unchanged
  expires after 60s → re-fetch          source changes → re-embed
  PROBLEM SOLVED                        SAME PROBLEM, must solve
```

The body walks how an embedding goes stale and the three freshness policies.

---

### How an embedding goes stale

A vector is computed once from a document's text. Three independent events make it stale, and none of them touch the vector:

```
  1. SOURCE CHANGED   document edited / re-run with new data
                      → vector describes the OLD text
  2. MODEL CHANGED    embedding model swapped (02-embedding-model-choice)
                      → vector lives in the OLD model's space; cosines meaningless
  3. SCHEMA/CHUNKING  chunk boundaries changed (03-chunking-strategies)
                      → vector covers a DIFFERENT slice than the index assumes
```

Case 1 is the everyday one; case 2 is catastrophic (the *whole* index is stale — a model swap means re-embed everything, the breakpoint from `02`); case 3 happens on any re-chunking. The danger across all three: the vector still *works* (cosine returns a number), so there is no error — just a wrong answer.

### Policy A: TTL (exactly `McpClient`'s approach)

The simplest policy is the one the codebase already runs for tool results: stamp each vector with an expiry and re-embed on read after it lapses. `embedding_stale_at` is the literal analog of `expiresAt`.

```
  embed doc → { vector, embedding_stale_at: now + TTL }   ← like expiresAt L65
  on read:
    embedding_stale_at > now ?  → trust the vector
                                → else re-embed before use
```

TTL is blunt — it re-embeds documents that did not change (wasteful) and serves changed documents until the TTL lapses (briefly stale). But it is dead simple and bounds staleness to the TTL window, exactly as the 60-second cache bounds tool-result staleness.

### Policy B: change-detection (content hash / version)

Better: re-embed only when the source actually changed. Store a content hash (or a source version) alongside the vector; on update, compare hashes and re-embed only on mismatch. This is what incremental indexing (`10-incremental-indexing.md`) builds on.

```
  stored:  { vector, sourceHash: "a1b2" }
  on source update:
    hash(newText) == sourceHash ?  → vector still valid, skip
                                   → else re-embed, update hash + mark fresh
```

Change-detection re-embeds the minimum — only genuinely changed documents — at the cost of tracking a hash per vector and a write-time comparison.

### Policy C: no-stale-on-error (the codebase's other half)

`McpClient` does not only expire — it refuses to cache errors (`lib/mcp/client.ts` L58–L60) so a failure cannot poison future reads. The embedding analog: if re-embedding fails (the embedding API errors), do *not* overwrite the existing vector with a bad/empty one and do *not* mark it fresh — keep the last-good vector and leave it marked stale to retry. A failed re-embed must not corrupt the index, exactly as a failed tool call must not corrupt the cache.

```
  re-embed attempt fails (API error)
    → keep last-good vector
    → leave embedding_stale_at in the past (retry next read)
    → never store an empty/error vector
  (mirrors no-cache-on-error: failures don't poison the index)
```

### The principle

An embedding index is a cache of derived values, so it inherits every caching discipline: invalidation is the hard part, stale reads are silent and dangerous, and you need an explicit freshness policy — a TTL, a change-detector, or both — plus a no-poison-on-error rule. blooming insights already implemented all of this for tool results in `McpClient`; an embedding index would re-implement the identical pattern, with `embedding_stale_at` playing the exact role of `expiresAt`.

---

## Stale embeddings — diagram

This diagram spans the State layer (the index as a cache) and shows the direct parallel to `McpClient`'s TTL cache. A reader who sees only this should grasp that an embedding is a cached snapshot and needs the same expiry/no-poison policy.

```
┌──────────────────────────────────────────────────────────────────────┐
│  STATE LAYER  — the index IS a cache (parallel to McpClient.cache)  │
│                                                                      │
│  McpClient.cache (lib/mcp/client.ts L18, L40, L58–60, L65)         │
│    Map<key, {result, expiresAt}>                                    │
│    read:  expiresAt > now ? serve : refetch                        │
│    error: NOT cached (no poison)                                    │
│         ║  same shape  ║                                            │
│         ▼              ▼                                            │
│  embedding index (would live in lib/state/)                        │
│    Map<docId, {vector, embedding_stale_at, sourceHash}>            │
│    read:  fresh ? trust : re-embed       ◀── embedding_stale_at    │
│    update: hash changed ? re-embed : skip   ↕ ↔ expiresAt          │
│    re-embed error: keep last-good, stay stale (no poison)          │
└──────────────────────────────────────────────────────────────────────┘
```

`embedding_stale_at` is `expiresAt` for vectors; the no-poison-on-error rule is `no-cache-on-error` for the index. The codebase already wrote both — for tool results.

---

## Implementation in codebase

**Not yet implemented (embedding staleness).** blooming insights retrieves live via MCP tool calls + EQL, so there is no embedding index to go stale — and notably, *live retrieval has no staleness problem at all*, which is a core reason for the no-RAG decision (`11-rag.md`): a fresh tool call always returns current data, where an embedding index would lag.

The honest analog is exact and present: the 60-second TTL cache in `McpClient` *is* the freshness/staleness mechanism, fully implemented. Every cached tool result carries `expiresAt = Date.now() + 60_000` (`lib/mcp/client.ts` L65); the read path serves it only while `cached.expiresAt > Date.now()` (L40); and error results are never cached (L58–L60) so a failure cannot poison the cache. `embedding_stale_at` would be the direct analog of `expiresAt`, and the no-stale-on-error policy the direct analog of no-cache-on-error. An embedding index's freshness policy would live in `lib/state/` and reuse this exact thinking. The `Project exercises` block below is the primary buildable target.

---

## Elaborate

### Where this pattern comes from

Embedding staleness is cache invalidation wearing a new hat — "there are only two hard things in computer science: cache invalidation and naming things" applies directly. Search engines have managed index freshness for decades (incremental crawl + re-index). The RAG era re-discovered it: teams shipped embedding indexes, the source documents changed, and retrieval silently served old vectors. The responses are the classic cache responses — TTL, content-hash change-detection, and event-driven invalidation (re-embed on a source-changed event) — plus the RAG-specific catastrophe of a model swap invalidating the *entire* index at once.

### The deeper principle

```
  cache concern              tool-result cache (HAS)       embedding index (would need)
  ────────────────────────   ───────────────────────────   ────────────────────────────
  expiry                     expiresAt (60s)               embedding_stale_at
  no poison on failure       no-cache-on-error (L58–60)    keep last-good vector
  invalidate on change       TTL lapse → refetch           hash mismatch → re-embed
  catastrophic invalidation  (n/a — stateless calls)       model swap → re-embed ALL
```

The first three rows are the same problem the codebase solved for `McpClient`. The fourth is unique to embeddings: because vectors from different models are incomparable (`02`), changing the model invalidates everything at once — there is no partial migration.

### Where this breaks down

1. **TTL re-embeds the unchanged.** A pure-TTL policy re-embeds documents that never changed when their TTL lapses, wasting embedding-API calls. Change-detection (hashing) avoids this but adds per-vector bookkeeping.

2. **Silent staleness has no error.** Unlike a 429 (which `isRateLimited` catches), a stale embedding throws nothing — cosine returns a number, retrieval succeeds, the answer is just wrong. Staleness is invisible without an explicit freshness marker, which is why the marker is mandatory.

3. **Model-swap invalidation is all-or-nothing.** You cannot mix old-model and new-model vectors in one index (their cosines are meaningless), so a model upgrade forces re-embedding the entire corpus before any query works — the costliest staleness event.

### What to explore next

- **Incremental indexing** (`10-incremental-indexing.md`): how change-detection drives selective re-embedding without a full rebuild.
- **Embedding model choice** (`02-embedding-model-choice.md`): the model swap that invalidates the whole index.
- **Caching + rate-limiting** (`../../study-system-design-dsa/01-system-design/04-caching-and-rate-limiting.md`): the `McpClient` TTL + no-cache-on-error policy this file parallels.

---

## Project exercises

### Add an `embedding_stale_at` freshness policy modeled on the TTL cache

- **Exercise ID:** B2A.2 / B2A.4 (adapted) — the primary buildable target.
- **What to build:** when the embedding index exists, store each vector with `embedding_stale_at` (the `expiresAt` analog) and a `sourceHash`; on read, trust the vector if fresh else re-embed; on a source update, re-embed only when the hash changed; on re-embed failure, keep the last-good vector and leave it stale (the no-cache-on-error analog). Reuse the exact shape from `lib/mcp/client.ts`.
- **Why it earns its place:** demonstrates you recognize an embedding index as a cache and apply the codebase's own proven freshness + no-poison policy to it — the cache-invalidation interview signal.
- **Files to touch:** new `lib/state/embedding-index.ts` (the index with `embedding_stale_at` + `sourceHash`), `lib/mcp/embeddings.ts` (re-embed-on-stale), new `test/state/embedding-index.test.ts` (TTL expiry, hash-change re-embed, no-poison-on-error — mirroring `test/mcp/client.test.ts`).
- **Done when:** a changed document's vector is re-embedded on next read, an unchanged document's vector is reused, and a re-embed failure leaves the last-good vector intact and still marked stale.
- **Estimated effort:** 1–2 days

### Handle the model-swap full-invalidation case

- **Exercise ID:** C2.11 (adapted) — catastrophic staleness.
- **What to build:** tag the index with the embedding model id/version; on a model change, detect the mismatch and mark the *entire* index stale (since cross-model cosines are meaningless), then re-embed all documents before serving any query with the new model.
- **Why it earns its place:** shows you know the worst staleness event — a model swap invalidates everything, with no partial migration — the senior gotcha from `02`.
- **Files to touch:** `lib/state/embedding-index.ts` (model-version tag + bulk invalidation), `lib/mcp/embeddings.ts`, `test/state/embedding-index.test.ts`.
- **Done when:** changing the configured embedding model forces a full re-embed and queries never mix old-model and new-model vectors.
- **Estimated effort:** 1–4hr

---

## Interview defense

### What an interviewer is really asking

"How do you keep an embedding index fresh?" tests whether you recognize the index as a cache and reach for cache-invalidation discipline. The senior signal is naming TTL vs. change-detection, the silent-failure danger (no error on a stale read), the model-swap full-invalidation gotcha, and — for this codebase — pointing at `McpClient`'s `expiresAt` + no-cache-on-error as the exact pattern to reuse.

### Likely questions

**[mid] What makes an embedding go stale, and why is it dangerous?**

The source document changes but the vector is not recomputed, so retrieval returns a vector describing the old text. It is dangerous because it is silent — cosine still returns a number, retrieval succeeds, and the model reads outdated content. There is no error to catch; only an explicit freshness marker surfaces it.

```
source changes → vector unchanged → stale read → wrong answer (no error)
```

**[senior] How would you keep the index fresh, reusing what's already in the codebase?**

The same way `McpClient` keeps tool results fresh: a freshness marker (`embedding_stale_at`, the `expiresAt` analog at `lib/mcp/client.ts` L65) plus a no-poison-on-error rule (the no-cache-on-error analog at L58–L60). Better than TTL, store a content hash and re-embed only on mismatch. A failed re-embed keeps the last-good vector and stays marked stale.

```
embedding_stale_at ↔ expiresAt
hash mismatch → re-embed; re-embed error → keep last-good
```

**[arch] What's the worst staleness event?**

A model swap. Vectors from different embedding models live in incomparable spaces, so changing the model makes every existing vector's cosine meaningless — the *entire* index is stale at once, with no partial migration. You must re-embed the whole corpus before any new-model query works. Tag the index with the model version to detect it.

```
old-model vectors + new-model query → meaningless cosines
fix: re-embed ALL (no mixing models)
```

### The question candidates always dodge

**"How do you even know a vector is stale?"** You don't — that is the trap. Unlike a rate-limit error, staleness throws nothing; the cosine succeeds and the answer is silently wrong. The only way to know is to *make* it visible with an explicit freshness marker (`embedding_stale_at`) or a source-hash comparison. Admitting that staleness is invisible by default — and that the marker is what makes it detectable — is the senior signal.

### One-line anchors

- `lib/mcp/client.ts` L65 — `expiresAt = Date.now() + ttl`: the `embedding_stale_at` analog.
- `lib/mcp/client.ts` L40 — `expiresAt > Date.now()`: the freshness check to mirror.
- `lib/mcp/client.ts` L58–L60 — no-cache-on-error: the no-poison-on-re-embed-error analog.
- An embedding index is a cache; staleness is silent; you need an explicit freshness marker.
- A model swap invalidates the whole index — re-embed everything, no mixing.

---

## Validate

### Level 1 — Reconstruct

From memory, draw the embedding index as a cache parallel to `McpClient.cache` and label the three corresponding pieces: `embedding_stale_at` ↔ `expiresAt`, freshness check ↔ TTL read check, no-poison-on-error ↔ no-cache-on-error. State the three events that make an embedding stale.

### Level 2 — Explain

Out loud: why is a stale embedding more dangerous than a rate-limit error? Why does a model swap invalidate the entire index rather than just the changed documents?

### Level 3 — Apply

Scenario: past investigations are re-run with fresh data and their embeddings drift. Open `lib/mcp/client.ts` L40, L58–L60, L65 (the TTL + no-cache-on-error policy) and explain how you would port each piece to an embedding index: where `embedding_stale_at` goes, how change-detection avoids re-embedding the unchanged, and how a failed re-embed avoids poisoning the index.

### Level 4 — Defend

A colleague says "embeddings don't go stale, they're just math." Argue why an embedding is a cached snapshot that drifts from its source, why the failure is silent (no error), and why live tool retrieval avoids the problem entirely (always fresh) — making the staleness burden a real cost in the no-RAG decision.

### Quick check — code reference test

What freshness/staleness mechanism does blooming insights already implement, and what is the embedding analog of `expiresAt`? (Answer: the 60-second TTL cache in `McpClient` — `expiresAt = Date.now() + 60_000` written at `lib/mcp/client.ts` L65, checked at L40, with error results never cached at L58–L60; the embedding analog of `expiresAt` is `embedding_stale_at`, and no-cache-on-error is the analog of keeping the last-good vector on a failed re-embed.)

## See also

→ 10-incremental-indexing.md · → 04-vector-databases.md · → 02-embedding-model-choice.md · → 11-rag.md
Updated: 2026-05-30 — Migrated to study.md v1.47 template (Phase 1+2 mechanical): removed Tradeoffs / Tech reference / Summary sections; renamed "In this codebase" → "Implementation in codebase"; moved See also to a bottom block. "Why care" preserved pending Phase 3 (Zoom out, then zoom in + LAYERS diagram) authoring.
Updated: 2026-05-30 — Phase 3 of study.md v1.47 migration: replaced "Why care" block with "Zoom out, then zoom in" (LAYERS diagram + zoom-in paragraph) per format.md.
