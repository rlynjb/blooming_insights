# Agent memory

**Industry name(s):** short-term (working) vs long-term agent memory, conversation state, snapshot replay vs semantic recall
**Type:** Industry standard · Language-agnostic

> blooming insights has two memory layers: short-term is the `messages` array accumulated within a single `runAgentLoop` run (gone when the run ends), and long-term is exact-keyed investigation snapshot replay (`getCachedInvestigation`: memory → dev file → demo seed). There is no semantic / vector recall — that is the RAG-inside-an-agent pattern, deliberately deferred.

**See also:** → 01-agents-vs-chains.md · → 03-react-pattern.md · → 06-error-recovery.md · → ../03-retrieval-and-rag/ · → ../../study-system-design-dsa/01-system-design/06-multi-agent-orchestration.md · → ../../study-system-design-dsa/01-system-design/04-caching-and-rate-limiting.md

---

## Why care

You have two kinds of state in a React app. The first lives in a component's `useState` — it accumulates while the component is mounted and vanishes on unmount; it is *working* state, scoped to one interaction. The second lives in a `localStorage` key or a database row — it survives reloads, sessions, and deploys; it is *durable* state, retrieved by a key. An agent has the exact same split: working memory that lives for one run, and durable memory that survives across runs. Confusing the two — expecting a run's working memory to persist, or treating a durable store as if it adapts within a run — is where agent systems leak and surprise.

The question this file answers: what does an agent remember within a single run, what does it remember across runs, and how is each stored?

**Answering it matters because the kind of memory you have determines the kind of behavior you can build.** Short-term memory is what lets the agent build a diagnosis over six tool calls instead of re-querying from scratch each turn — it is the substrate of multi-step reasoning. Long-term memory is what lets a second visit to an investigation be instant instead of re-running the whole agent. But the *shape* of the long-term store decides what is possible: blooming insights stores exact snapshots keyed by `insightId`, so it can replay a known investigation perfectly — and it cannot answer "have we seen an anomaly like this before?" because that requires semantic recall, which it does not have. Knowing which memory you have, and which you do not, is the difference between promising a feature and shipping one.

```
Short-term (working)                    Long-term (durable)
────────────────────────────────       ──────────────────────────────────
useState while mounted                  localStorage / DB row by key
= messages[] in one runAgentLoop        = getCachedInvestigation(insightId)
gone when the run returns               survives across runs (mem → file → seed)
substrate of multi-step reasoning       exact replay, NOT semantic recall
```

One-line summary: **short-term memory is the `messages` array within one run; long-term memory is exact-keyed snapshot replay; there is no semantic memory, and that is an honest, deliberate gap.**

---

## How it works

**Mental model.** Short-term memory is an array you append to across turns and discard when the function returns — `useState` for one render lifecycle. Long-term memory is a keyed lookup with a fallback chain — `localStorage.getItem(key) ?? defaultValue`, except the chain has three tiers (process memory, a dev file, a committed seed). Neither layer is semantic: the short-term array is the literal conversation, and the long-term store is keyed by an exact `insightId` string, not by meaning.

```
SHORT-TERM (one run)                     LONG-TERM (across runs)
─────────────────────────────────       ─────────────────────────────────
messages: MessageParam[]                 getCachedInvestigation(insightId)
[0] user: prompt                           1. mem.get(insightId)        ← process Map
[1] assistant: tool_use                    2. readJson(CACHE_FILE)      ← dev file
[2] user: tool_result   ← grows            3. readJson(DEMO_FILE)       ← committed seed
[3] assistant: text (final)                return first hit ?? null
discarded when runAgentLoop returns      exact-key match, no similarity
```

The short-term array is *built fresh* every run (`base.ts` L79) and never persisted as a conversation. The long-term store persists *events* (the streamed trace), not the conversation — so "replaying an investigation" replays the rendered output, not the model's internal `messages`.

---

### Short-term memory — the messages array within one run

`runAgentLoop` initializes `messages` with the user prompt (`base.ts` L79–L81) and grows it across turns: each assistant turn is appended (L105), and each batch of tool results is appended as a user turn (L171). The model sees the *entire* array on every `anthropic.messages.create` call (L99), which is why it can reason over its own prior queries and their results.

```
base.ts — messages accumulation
─────────────────────────────────────────────────────────────
 messages = [{ role:'user', content: userPrompt }]      L79–81  ← born here
 for turn in maxTurns:
   res = create({ ..., messages })                      L99/102  ← model sees ALL of it
   messages.push({ role:'assistant', content: res.content })  L105
   ... run tools ...
   messages.push({ role:'user', content: toolResults }) L171   ← Observation appended
 return { finalText, toolCalls }                         L123/175 ← messages discarded
```

The lifecycle is the whole point: `messages` is a local `const` inside `runAgentLoop`. When the function returns, the array is garbage-collected. There is no persistence of the conversation, no carry-over to the next run, no shared scratchpad between agents. The diagnostic agent's `messages` and the recommendation agent's `messages` are entirely separate arrays — the only thing that crosses between them is the `diagnosis` object the route passes as an argument (01-agents-vs-chains.md). Short-term memory is per-run, per-agent, and ephemeral.

```
working-memory lifecycle
─────────────────────────────────────────────────────────────
 investigate() run:   messages = [...]  ──grows──→ returns → GC'd
 propose() run:        messages = [...]  ← brand new, knows nothing of the above
 (handoff is the `diagnosis` argument, not shared memory)
```

---

### Long-term memory — exact-keyed snapshot replay

`lib/state/investigations.ts` is the durable layer. It stores the *streamed event list* of a completed investigation, keyed by `insightId`, and replays it on a later request. `getCachedInvestigation` (L22–L28) is a three-tier fallback lookup:

```
investigations.ts — getCachedInvestigation(insightId)   (L22–L28)
─────────────────────────────────────────────────────────────
 1. if mem.has(insightId)  return mem.get(insightId)      ← in-process Map (L23)
 2. fromFile = PERSIST ? readJson(CACHE_FILE)[insightId]  ← dev file, dev only (L24)
 3. fromDemo = readJson(DEMO_FILE)[insightId]             ← committed seed (L26)
 return fromDemo ?? null                                   ← exact key or nothing (L27)
```

`saveInvestigation` (L30–L41) writes to the in-process `Map` always, and to the dev cache file only when `PERSIST` (`NODE_ENV === 'development'`, L7) — because serverless filesystems are read-only in production. The route writes the collected events only after the *combined* `step==null` capture run completes (`route.ts` L254 — the split live steps hand off via the client's sessionStorage instead) and replays them on a cache hit (`route.ts` L127–L141), filtering the snapshot to the requested step via `filterByStep(cached, step)` (L129) and pacing each event by `REPLAY_DELAY_MS = 180` (L105) so the replayed trace looks like a live run.

```
route.ts — replay branch   (L127–L141)
─────────────────────────────────────────────────────────────
 cached = getCachedInvestigation(insightId)            L127
 if cached:
   events = step ? filterByStep(cached, step) : cached  L129  ← per-step slice
   for e of events:
     enqueue(encodeEvent(e))                            L134
     await sleep(REPLAY_DELAY_MS = 180)                 L135  ← paced replay
```

The key property: this is **exact-keyed snapshot replay**. The lookup is `mem.get(insightId)` — a hash lookup on an exact string. There is no notion of "similar" `insightId`s, no ranking, no distance. Either the exact `insightId` was investigated before (hit, instant replay) or it was not (miss, run live). It is `localStorage` semantics, not search semantics.

---

### Cross-step memory — the diagnosis handed across HTTP requests

There is a *third* memory location, distinct from both the per-run `messages` array and the long-term snapshot store: the diagnosis the two-step investigation carries from step 2 (diagnose) to step 3 (recommend). The two steps are separate HTTP requests — `?step=diagnose` then `?step=recommend` — so the diagnosis cannot live in the agent's in-loop `messages` (that array is GC'd when the diagnose request returns) and is not yet in the long-term store (the disk write only fires on the combined `step==null` capture run, `route.ts` L254). It lives, for the span between two requests, in the browser's `sessionStorage`.

```
cross-step handoff (live two-step path)
─────────────────────────────────────────────────────────────────
 REQUEST 1  GET /api/agent?step=diagnose
   route runs DiagnosticAgent.investigate → sends {type:'diagnosis'}
   client (useInvestigation.ts) on 'done':
     sessionStorage['bi:diag:<id>'] = JSON.stringify({ diagnosis })   L138–139
                       │  diagnosis serialized, survives route change
                       ▼
 REQUEST 2  GET /api/agent?step=recommend&diagnosis=<…>
   route: parseDiagnosis(diagnosisParam) ← re-hydrated from the client  L227
   RecommendationAgent.propose(inv, diagnosis)   ← step 3 reads step 2

 (demo path) cached snapshot replayed FILTERED to the step:
   getCachedInvestigation(id) → filterByStep(cached, step)   L127/L129
```

This is agent memory carried *across HTTP requests and a route change*, not within an agent loop. In-loop message memory (the `messages` array above) is the model reasoning over its own turns inside one request; this is the orchestration layer persisting one node's typed output so the next node — running in a *later* request, after the user has advanced to step 3 — can consume it. On the demo path there is no live agent at all: the cached snapshot is replayed `filterByStep(cached, step)` (`route.ts` L129) so step 3 replays only the recommendation slice. So the diagnosis crosses the step boundary by exactly one of two routes — `sessionStorage` re-hydration on the live path, or a step-filtered snapshot replay on the demo path — neither of which is the agent's working memory. It is the chain's handoff (01-agents-vs-chains.md) made durable across the gap between two requests.

---

### What is NOT here — semantic memory

There is no vector store, no embeddings, no cosine similarity, no "retrieve relevant past investigations." An analyst cannot ask "have we seen a mobile-conversion drop like this before?" and have the system surface a similar prior investigation, because nothing maps an anomaly to its *neighbors* — only to its exact-key replay or a fresh run.

```
what exists                          what does NOT exist
─────────────────────────────       ─────────────────────────────────
getCachedInvestigation(id)           findSimilarInvestigations(anomaly)
  exact key → snapshot                 embed(anomaly) → top-k by cosine
  hit or miss, no ranking              "we saw this on mobile in March…"
```

This is the **RAG-inside-an-agent** pattern — giving an agent semantic recall over its own history — and blooming insights deliberately does not have it. The honest framing: the codebase chose live MCP retrieval + exact-key caching over an embedding store, the same "no RAG until a feature needs it" decision documented in ../03-retrieval-and-rag/. Semantic memory is the primary buildable target in the exercises below.

---

### Current state vs future state

Today, long-term memory serves one job: make a repeat visit to a known investigation instant and demo-able (the committed `DEMO_FILE` seed means the demo works with no API key). It does not serve learning — the agent does not get smarter from past investigations, because it cannot retrieve them by similarity. The future state is a semantic layer: embed each anomaly + diagnosis, store the vectors, and on a new anomaly retrieve the k most similar past investigations to seed the diagnostic agent's prompt. That turns durable memory from a replay cache into an experience base — and it is exactly the RAG pattern, which is why it lives at the boundary of this section and ../03-retrieval-and-rag/.

---

### The principle

**Match the memory's storage shape to the access pattern you actually need.** blooming insights needs "show me this exact investigation again, instantly" — an exact-key lookup — so it uses a keyed `Map`/file, the simplest thing that serves that access pattern. It does *not* yet need "find me investigations like this one," so it does not pay for a vector store. The mistake is reaching for semantic memory because it sounds powerful; the discipline is using exact-key storage until a feature genuinely requires similarity. Short-term memory follows the same rule: the `messages` array is the simplest structure that serves multi-step reasoning, and it is discarded the moment the run that needs it ends.

---

## Agent memory — diagram

The diagram spans three layers. The Agent layer holds short-term memory (the per-run `messages` array). The State layer holds long-term memory (the three-tier keyed store). The Route layer is where they meet — it reads long-term on entry and writes it on completion, and it never sees short-term memory (which lives and dies inside the agent).

```
┌──────────────────────────────────────────────────────────────────────┐
│  ROUTE LAYER   app/api/agent/route.ts                                 │
│                                                                       │
│  on entry:  cached = getCachedInvestigation(insightId)  L127         │
│             if hit → filterByStep(cached, step), replay  L129–135     │
│                      (paced 180ms)                       ← long-term   │
│             if miss → run agents live (per ?step)                     │
│  on done:   if step==null: saveInvestigation(id, …)  L254  ← write    │
└───────────┬───────────────────────────────────────┬───────────────────┘
   write/read│ (long-term)             run live      │
┌───────────▼───────────────────────┐  ┌─────────────▼───────────────────┐
│  STATE LAYER (LONG-TERM)           │  │  AGENT LAYER (SHORT-TERM)        │
│  lib/state/investigations.ts       │  │  lib/agents/base.ts runAgentLoop │
│                                    │  │                                  │
│  getCachedInvestigation(insightId):│  │  messages: MessageParam[]        │
│   1. mem.get(id)   ← process Map   │  │  [0] user prompt        L79      │
│   2. CACHE_FILE    ← dev file      │  │  [+] assistant turns    L105     │
│   3. DEMO_FILE     ← committed seed │  │  [+] user tool_results  L171     │
│   exact key → snapshot OR null     │  │  model sees ALL each turn L99    │
│                                    │  │  discarded on return    L123/175 │
│  (NO embeddings, NO similarity)    │  │  (per-run, per-agent, ephemeral) │
└────────────────────────────────────┘  └──────────────────────────────────┘
```

A reader who sees only this diagram should grasp: short-term memory lives inside the agent and dies with the run; long-term memory is an exact-keyed snapshot store in the State layer; there is no semantic layer.

---

## In this codebase

**Case A (partial).** Short-term and exact-key long-term memory are implemented; semantic/vector memory is not.

### Short-term memory (per-run conversation)

- **File:** `lib/agents/base.ts`
- **Function / class:** `runAgentLoop` — the `messages` array
- **Line range:** initialized L79–L81; assistant turn appended L105; tool results appended L171; discarded at return L123 / L175
- **Role:** The working memory the model reasons over within one run; local to the function, garbage-collected on return, never shared across agents or runs.

### Long-term memory (exact-keyed snapshot replay)

- **File:** `lib/state/investigations.ts`
- **Function / class:** `getCachedInvestigation` (read) + `saveInvestigation` (write)
- **Line range:** read L22–L28 (three-tier: `mem` → `CACHE_FILE` → `DEMO_FILE`); write L30–L41 (`mem` always, file only when `PERSIST`, L7/L32)
- **Role:** Persists and replays the streamed event list keyed by exact `insightId`; the durable layer across runs.

### Where long-term memory is read and written

- **File:** `app/api/agent/route.ts`
- **Function / class:** `GET` — replay branch + save call
- **Line range:** replay L127–L141 (`filterByStep(cached, step)` L129; `REPLAY_DELAY_MS = 180` at L105/L135); save L254 (gated on `step == null`)
- **Role:** Reads the cache on entry (instant per-step replay on hit) and writes the collected events on completion of the combined capture run.

### What is NOT implemented

- **Not yet implemented.** blooming insights stores investigations by exact `insightId` and retrieves them with a hash lookup; it has no embeddings, vector store, or similarity search, so it cannot recall "investigations like this one." Semantic memory would live in a new `lib/state/investigation-memory.ts` (embed anomaly+diagnosis, store vectors, retrieve top-k) alongside `lib/state/investigations.ts`, and feed the diagnostic agent's prompt — the RAG-inside-an-agent pattern (see ../03-retrieval-and-rag/).

**Pseudocode — both memory layers** (`base.ts` + `investigations.ts`):

```typescript
// SHORT-TERM (base.ts): grows within one run, then gone
const messages = [{ role: 'user', content: userPrompt }];   // L79
for (let turn = 0; turn < maxTurns; turn++) {
  const res = await create({ messages, ... });              // L102 — sees all
  messages.push({ role: 'assistant', content: res.content });  // L105
  messages.push({ role: 'user', content: toolResults });   // L171
}                                                            // messages GC'd on return

// LONG-TERM (investigations.ts): exact key, three-tier fallback
function getCachedInvestigation(insightId) {                // L22
  if (mem.has(insightId)) return mem.get(insightId);        // L23 process Map
  const f = PERSIST ? readJson(CACHE_FILE)[insightId] : undefined;  // L24 dev file
  if (f) return f;
  return readJson(DEMO_FILE)[insightId] ?? null;            // L26-27 seed or null
}
```

---

## Elaborate

### Where this pattern comes from

The short-term / long-term split is the standard agent-memory taxonomy, formalized in agent frameworks (LangChain's `ConversationBufferMemory` vs `VectorStoreRetrieverMemory`) and in cognitive-architecture analogies (working memory vs episodic/semantic memory). Short-term as "the conversation buffer" is universal: every tool-use loop accumulates a message list the model re-reads each turn. Long-term-as-exact-key-cache is the simplest durable layer; long-term-as-vector-recall is the more powerful one that frameworks add via a retriever. blooming insights implements the first two and names the third as the open extension.

### The deeper principle

Memory shape is destiny for behavior. An exact-key store can only answer "have I seen *this* before"; a vector store can answer "have I seen something *like* this." You cannot retrofit similarity onto a hash map — the storage decision made early constrains the features available later. This is why naming the absence honestly matters: a team that believes it "has memory" because it caches investigations will be surprised when asked for "similar past anomalies" and finds the store cannot answer. The discipline is to know exactly which question your memory can answer and to build the storage that the *required* question demands — not the most impressive-sounding one.

### Where this breaks down

The short-term array grows unbounded within a run — every tool result (truncated to 16k, `base.ts` L29) is appended, so a long investigation's `messages` can approach the context window; the `maxToolCalls` budget is what indirectly bounds it (06-error-recovery.md). The long-term store breaks under serverless: the in-process `Map` does not survive cold starts, and the dev `CACHE_FILE` is dev-only (`PERSIST`, L7) because production filesystems are read-only — so in production, long-term memory is effectively just the committed `DEMO_FILE` seed plus whatever the current warm instance holds. And the absence of semantic memory means the system cannot improve from experience; every new anomaly is investigated from scratch even if an identical one was diagnosed last week under a different `insightId`.

### What to explore next

- **Vector memory** (`VectorStoreRetrieverMemory`, pgvector, Pinecone) — embed and retrieve past investigations by similarity; the RAG-inside-an-agent pattern (cross-link ../03-retrieval-and-rag/).
- **Memory consolidation / summarization** — compressing a long `messages` array into a summary to stay under the context window; the production answer to unbounded short-term growth.
- **Durable session stores** (Redis, Durable Objects) — replacing the in-process `Map` with a store that survives cold starts and coordinates across instances (cross-link to the caching/rate-limiting system-design file).

---

## Tradeoffs

### Comparison: exact-key snapshot memory vs semantic memory

| Dimension | This codebase (exact-key + per-run buffer) | Vector/semantic memory | No long-term memory at all |
|---|---|---|---|
| "Show this exact investigation again" | Instant replay | Possible but overkill | Re-run live every time |
| "Find similar past investigations" | Impossible — no similarity | Native — top-k by cosine | Impossible |
| Setup complexity | Trivial — `Map` + JSON files | High — embed model + vector DB | None |
| Survives cold start | No (Map) / seed-only (file) | Yes (external store) | N/A |
| Cost | Near zero | Embedding + storage per investigation | Re-compute cost every visit |

**What we gave up.** Learning from experience. Because the store is exact-keyed, the agent cannot benefit from past investigations of similar anomalies — two visually identical mobile-conversion drops with different `insightId`s are investigated independently, from scratch, every time. We accept this because the current product need is "make a repeat visit instant and demo-able," which exact-key replay serves perfectly, and the embedding infrastructure for similarity is unjustified until a "similar investigations" feature is actually on the roadmap.

**What the alternative would have cost.** A vector store would have added an embedding model call per investigation, a vector database to operate, an embedding-staleness story (re-embed when the schema changes), and a similarity-threshold tuning problem — substantial infrastructure for a feature no one has asked for. The "no RAG until a feature needs it" decision (../03-retrieval-and-rag/) applies identically to agent memory: defer the semantic layer until similarity is a requirement, not a guess.

**The breakpoint.** Exact-key memory is right while the access pattern is "retrieve this specific investigation." It stops being right the moment a feature requires "retrieve investigations like this one" — recommended-next-investigations, dedup of recurring anomalies, or seeding the diagnostic prompt with prior conclusions. At that point you add the vector layer beside the exact-key store; you do not replace it (exact-key replay stays the right tool for the repeat-visit case).

---

## Tech reference (industry pairing)

### In-process Map + JSON files (exact-key long-term store)

- **Codebase uses:** `mem` `Map`, `CACHE_FILE`, `DEMO_FILE` three-tier lookup in `lib/state/investigations.ts` (L22–L41).
- **Why it's here:** It is the simplest durable store that serves exact-key replay and works with a committed demo seed.
- **Leading today:** Keyed caches (Redis, in-memory + file) are the adoption-leading exact-key store in 2026; durable session stores lead for cross-instance.
- **Why it leads:** Trivial, debuggable, zero dependencies for the single-instance case.
- **Runner-up:** Redis / Durable Objects — survive cold starts and coordinate across instances; needed at scale.

### Conversation buffer (short-term memory)

- **Codebase uses:** The `messages: MessageParam[]` array in `runAgentLoop` (`base.ts` L79–L171).
- **Why it's here:** The model needs its full prior turns each call to reason over multi-step evidence.
- **Leading today:** In-context conversation buffers are the adoption-leading short-term memory in 2026.
- **Why it leads:** It is the native mechanism — the model reasons over what is in its context, nothing else.
- **Runner-up:** Summarized / windowed buffers — compress old turns to stay under the context window for long runs.

### Vector memory (the absent semantic layer)

- **Codebase uses:** Not used — named as the extension for "similar past investigations."
- **Why it's here:** It is the standard way to give an agent semantic recall over its own history.
- **Leading today:** pgvector and Pinecone are the adoption-leading vector stores for agent memory in 2026.
- **Why it leads:** Mature similarity search, metadata filtering, and managed scaling.
- **Runner-up:** Qdrant / Weaviate — strong open-source options with hybrid search.

---

## Project exercises

### Build a "similar past investigations" semantic memory

- **Exercise ID:** C4.5 (adapted to blooming insights; aligns with the C2.x RAG builds)
- **What to build:** A `lib/state/investigation-memory.ts` that, on `saveInvestigation`, embeds the anomaly + diagnosis conclusion and stores the vector; and a `findSimilar(anomaly, k)` that returns the top-k prior investigations by cosine similarity. Surface the matches on the investigate page as "we have seen this before."
- **Why it earns its place:** This is the RAG-inside-an-agent pattern end to end — the highest-signal agent-memory build, demonstrating you can add semantic recall to an exact-key system.
- **Files to touch:** new `lib/state/investigation-memory.ts`; `lib/state/investigations.ts` (hook into `saveInvestigation` L30); `app/api/agent/route.ts` (call `findSimilar` before the `step=diagnose` live run, ~L231–L238); `app/investigate/[id]/page.tsx` (render matches).
- **Done when:** Investigating a new anomaly similar to a stored one surfaces the prior investigation above a tunable similarity threshold, verified with a fixture pair of near-duplicate anomalies.
- **Estimated effort:** 1–2 days

### Seed the diagnostic prompt with the most similar prior conclusion

- **Exercise ID:** C4.5 (adapted to blooming insights)
- **What to build:** Using the semantic memory above, inject the single most-similar past diagnosis conclusion into the diagnostic agent's system prompt as a "prior finding to consider or rule out," so the agent reasons with experience instead of from scratch.
- **Why it earns its place:** Shows long-term memory feeding short-term — the closed loop that turns a replay cache into an experience base.
- **Files to touch:** `lib/agents/diagnostic.ts` (L46–L49 system construction); `lib/agents/prompts/diagnostic.md` (a `{prior_finding}` slot); `lib/state/investigation-memory.ts`.
- **Done when:** A diagnosis of a recurring anomaly cites or explicitly rules out the prior finding, and a novel anomaly's prompt contains no prior-finding text.
- **Estimated effort:** 1–4hr

---

## Summary

blooming insights has two memory layers and lacks a third. Short-term memory is the `messages` array inside one `runAgentLoop` run (`base.ts` L79–L171) — the model reasons over its full prior turns each call, and the array is discarded when the run returns. Long-term memory is exact-keyed snapshot replay: `getCachedInvestigation` (`investigations.ts` L22–L28) looks up an `insightId` across a process `Map`, a dev file, and a committed seed, and the route replays the stored events — sliced to the requested step by `filterByStep` — paced at 180ms (`route.ts` L127–L141). There is no semantic / vector memory — the store answers "this exact investigation" but not "investigations like this one," a deliberate deferral matching the codebase's "no RAG until a feature needs it" stance.

Key points:
- Short-term memory = the per-run `messages` array; it is the substrate of multi-step reasoning and is garbage-collected on return.
- Agents do not share short-term memory; the only handoff is the `diagnosis` argument the route passes.
- Long-term memory = exact-keyed snapshot replay (`Map` → dev file → demo seed), `localStorage` semantics, not search semantics.
- There is no embeddings/vector recall — "similar past investigations" is impossible today and is the primary buildable target.
- Memory shape is destiny: an exact-key store cannot answer similarity questions; choose storage by the question you must answer.

---

## Interview defense

### What an interviewer is really asking

"How does your agent remember things?" tests whether you distinguish working memory (the conversation buffer) from durable memory (a keyed store), and whether you know the difference between exact-key replay and semantic recall. The senior signal is naming the absence — "we have exact-key memory, not semantic; here is why that is the right call today" — rather than overclaiming.

### Likely questions

**[mid] "What does the agent remember within a single investigation, and where is it stored?"**

The `messages` array in `runAgentLoop` (`base.ts` L79). It starts with the user prompt and grows with each assistant turn (L105) and each batch of tool results (L171). The model sees the whole array on every call (L102), which is how it builds a diagnosis over multiple tool calls. The array is a local `const`; when the run returns (L123/L175) it is discarded — nothing persists.

```
messages[]: prompt → asst(tool_use) → user(tool_result) → asst(text)
              grows each turn, model re-reads all, GC'd on return
```

**[senior] "Two identical mobile-conversion drops come in with different insightIds. Does the second one benefit from the first investigation?"**

No. Long-term memory is keyed by exact `insightId` (`investigations.ts` L23, `mem.get(insightId)`), so a different id is a cache miss and runs live from scratch. The system has no similarity layer — it cannot recognize the two anomalies as alike. Benefiting from the first would require semantic memory (embed the anomaly, retrieve neighbors), which the codebase deliberately does not have. The honest answer is "no, and here is the exact reason and the exact thing I would build."

```
investigation 1: insightId=A → diagnosed, stored under A
investigation 2: insightId=B (identical anomaly) → mem.get(B) = miss → run live again
no similarity lookup → no benefit
```

**[arch] "Your long-term store is an in-process Map plus a file. What survives a serverless cold start?"**

Almost nothing of the live cache. The `mem` `Map` is per-process and dies with the instance; the `CACHE_FILE` write is gated on `PERSIST` (`NODE_ENV === 'development'`, L7) because production filesystems are read-only. So in production, durable memory across cold starts is effectively the committed `DEMO_FILE` seed plus whatever the current warm instance accumulated. A real durable layer (Redis, Durable Objects) is the fix when cross-instance, cold-start-surviving memory is required.

```
warm instance:  mem Map (this run + recent)  ← lost on cold start
prod file:      read-only → only DEMO_FILE seed survives
fix:            external store (Redis) for true durability
```

### The question candidates always dodge

**"Does your agent have memory?"**

The dodge is to say "yes" because there is a cache. The honest answer is "it has working memory and exact-key durable memory; it does not have semantic memory." Those are three different things, and conflating "we cache investigations" with "the agent remembers and learns" oversells the system. The cache makes a repeat visit instant; it does not make the agent smarter about new-but-similar anomalies. Naming exactly which memory exists — and which does not — is the answer that survives follow-up questions.

### One-line anchors

- `lib/agents/base.ts` L79 — `messages` born here; short-term memory for one run.
- `lib/agents/base.ts` L171 — tool results appended; the Observation enters short-term memory.
- `lib/state/investigations.ts` L22–L28 — `getCachedInvestigation` — exact-key, three-tier long-term lookup.
- `lib/state/investigations.ts` L7 — `PERSIST = NODE_ENV === 'development'` — why the file cache is dev-only.
- `app/api/agent/route.ts` L254 — `if (step == null) saveInvestigation(insightId, collected)` — where long-term memory is written (combined capture run only).

---

## Validate

### Level 1 — Reconstruct

From memory, draw both layers: (a) the short-term `messages` array's lifecycle (born, grows, discarded) with the line that appends tool results; (b) the long-term three-tier lookup (`mem` → dev file → demo seed). Mark which survives a run and which does not, and write "NO semantic layer" where the vector store would go.

### Level 2 — Explain

Out loud: explain why the model needs the *full* `messages` array on every call, not just the latest tool result, and why long-term memory storing exact snapshots cannot answer "similar past investigations."

### Level 3 — Apply

Scenario: a PM asks for a "you investigated something like this last month" banner. What does the codebase support today, and what is missing? Check `lib/state/investigations.ts` L22–L28 — the lookup is `mem.get(insightId)`, an exact-key hash lookup with no similarity. Explain that the banner requires a new semantic layer (embed + top-k), name where it would live (`lib/state/investigation-memory.ts`), and reference ../03-retrieval-and-rag/ for the retrieval mechanics.

### Level 4 — Defend

A colleague says: "Just add a vector DB now so the agent can learn from history." Defend the current exact-key store for the repeat-visit use case, name the access pattern the vector DB would actually serve, and state the breakpoint (a real "similar investigations" feature) at which adding it becomes correct rather than speculative.

### Quick check — code reference test

In `getCachedInvestigation`, what are the three sources checked in order, and what is returned on a complete miss? (Answer: in-process `mem` Map → dev `CACHE_FILE` (only when `PERSIST`) → committed `DEMO_FILE`; returns `null` on a miss — `lib/state/investigations.ts` L22–L28.)

---
Updated: 2026-05-28 — Refreshed the long-term refs for the rewritten route: replay is now `step`-filtered (`filterByStep`, L127–141) and `saveInvestigation` (L254) fires only on the combined `step==null` capture run; the split live steps hand off via sessionStorage.

---
Updated: 2026-05-29 — Added a "cross-step memory" sub-section (with diagram) on the two-step investigation's diagnosis handoff: step 2 serializes to `sessionStorage['bi:diag:<id>']` (useInvestigation.ts L138–139), step 3 re-hydrates via `parseDiagnosis` (route.ts L227); demo path replays the snapshot `filterByStep` (route.ts L129). Framed as memory carried across HTTP requests, distinct from in-loop message memory.
