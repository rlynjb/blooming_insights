# Agent memory

**Industry name(s):** short-term (working) vs long-term agent memory, conversation state, snapshot replay vs semantic recall
**Type:** Industry standard · Language-agnostic

> blooming insights has two memory layers: short-term is the `messages` array accumulated within a single `runAgentLoop` run (gone when the run ends), and long-term is exact-keyed investigation snapshot replay (`getCachedInvestigation`: memory → dev file → demo seed). There is no semantic / vector recall — that is the RAG-inside-an-agent pattern, deliberately deferred.


---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Agent memory splits across two layers. Short-term memory is the `messages` array inside `runAgentLoop` (`lib/agents/base.ts` L79–L81, grows through L105 and L171) — working state for one run. Long-term memory is the keyed snapshot store: `saveInvestigation`/`getCachedInvestigation` in `lib/state/investigations.ts` plus the mem→file→seed lookup chain — exact replay across runs. Semantic memory ("have we seen an anomaly like this before?") would need an embedding store and does not exist.

```
  Zoom out — where each memory tier lives

  ┌─ Agent loop (SHORT-TERM, one run) ───────────────┐  ← we are here
  │  ★ messages[] grows turn by turn ★               │
  │    init L79–81, asst L105, tool_results L171     │
  │  gone when runAgentLoop returns                  │
  └─────────────────────────┬────────────────────────┘
                            │  saveInvestigation(insightId, events)
  ┌─ State layer (LONG-TERM, exact replay) ──────────┐  ← we are here
  │  ★ mem Map → file snapshot → seed ★               │
  │  lib/state/investigations.ts                     │
  │  retrieved by exact insightId only                │
  └─────────────────────────┬────────────────────────┘
                            │
  ┌─ (Semantic memory — would-be) ───────────────────┐
  │  embedding index of past investigations / lessons │
  │  "have we seen this before?"  ← NOT implemented   │
  │  see → ../03-retrieval-and-rag/                   │
  └──────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question is: what does an agent remember within a single run, what does it remember across runs, and how is each stored? Short-term is the substrate of multi-step reasoning (six tool calls building one diagnosis); long-term is what makes re-opening an investigation instant. The shape of each store decides what behavior is possible — exact-key snapshot replay can replay a known run perfectly but cannot answer "similar to" questions. How it works walks each tier, the mem→file→seed lookup chain, and the honest gap where semantic memory would go.

---

## Structure pass

**Layers.** Three memory layers — two real and one would-be: short-term (the `messages` array inside `runAgentLoop`, gone when the run ends), long-term (the keyed snapshot store with mem→file→seed lookup chain), and semantic (an embedding index of past investigations — not implemented).

**Axis: lifecycle.** When does each layer's state exist, and when is it discarded? This axis is the right lens because the file's whole frame is *per-run vs across-runs vs semantic recall* — a temporal/scope distinction. State is downstream of lifecycle (the *shape* of state depends on how long it lives); the upstream question is "when does this thing get garbage collected."

**Seams.** The cosmetic seam is within the long-term tier (mem → file → seed are three steps of the *same* exact-key lookup). The load-bearing seam is between short-term and long-term: lifecycle flips here from "scoped to one run, append-only, then discarded" to "scoped across runs, keyed by `insightId`, persistent." A second WOULD-BE seam sits beyond long-term — between exact-key snapshot replay and semantic recall: lifecycle stays the same but *retrieval mode* flips from "exact match only" to "similarity match" (the latter is what an embedding index would enable).

```
  Structure pass — agent memory

  ┌─ 1. LAYERS ───────────────────────────────────┐
  │  short-term (messages[] inside one run)        │
  │  long-term (keyed snapshot: mem→file→seed)     │
  │  semantic (embedding recall — would be)        │
  └────────────────────────┬───────────────────────┘
                           │  pick the axis
  ┌─ 2. AXIS ─────────────▼────────────────────────┐
  │  lifecycle: when does each layer's state exist │
  │  and when is it discarded?                     │
  └────────────────────────┬───────────────────────┘
                           │  trace across layers, find flips
  ┌─ 3. SEAMS ────────────▼────────────────────────┐
  │  mem↔file↔seed: cosmetic (one lookup)          │
  │  short↔long: LOAD-BEARING                      │
  │    one-run scope → across-runs scope           │
  │  long↔semantic: LOAD-BEARING (would be)        │
  │    exact-key replay → similarity recall        │
  └────────────────────────┬───────────────────────┘
                           ▼
                   Block 4 — How it works
```

The skeleton is mapped — the rest of this file walks the mechanics that hang off it.

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

The short-term array is *built fresh* every run and never persisted as a conversation. The long-term store persists *events* (the streamed trace), not the conversation — so "replaying an investigation" replays the rendered output, not the model's internal `messages`.

---

### Short-term memory — the messages array within one run

The shared agent loop initializes `messages` with the user prompt and grows it across turns: each assistant turn is appended, and each batch of tool results is appended as a user turn. The model sees the *entire* array on every `messages.create` call, which is why it can reason over its own prior queries and their results.

```
messages accumulation in the agent loop
─────────────────────────────────────────────────────────────
 messages = [{ role: "user", content: userPrompt }]  ← born here
 for turn in maxTurns:
   res = create({ ..., messages })                   ← model sees ALL of it
   messages.push({ role: "assistant", content: res.content })
   ... run tools ...
   messages.push({ role: "user", content: toolResults })   ← Observation appended
 return { finalText, toolCalls }                     ← messages discarded
```

The lifecycle is the whole point: `messages` is a local `const` inside the agent loop. When the function returns, the array is garbage-collected. There is no persistence of the conversation, no carry-over to the next run, no shared scratchpad between agents. The diagnostic agent's `messages` and the recommendation agent's `messages` are entirely separate arrays — the only thing that crosses between them is the `diagnosis` object the route passes as an argument (01-agents-vs-chains.md). Short-term memory is per-run, per-agent, and ephemeral.

```
working-memory lifecycle
─────────────────────────────────────────────────────────────
 investigate() run:   messages = [...]  ──grows──→ returns → GC'd
 propose() run:        messages = [...]  ← brand new, knows nothing of the above
 (handoff is the `diagnosis` argument, not shared memory)
```

---

### Long-term memory — exact-keyed snapshot replay

The investigations state module is the durable layer. It stores the *streamed event list* of a completed investigation, keyed by `insightId`, and replays it on a later request. The cached-investigation lookup is a three-tier fallback:

```
  function get_cached_investigation(insightId):
      if mem.has(insightId):                                  ← in-process Map
          return mem.get(insightId)
      fromFile = (PERSIST ? readJson(CACHE_FILE)[insightId]   ← dev file, dev only
                          : undefined)
      if fromFile:
          return fromFile
      return readJson(DEMO_FILE)[insightId] ?? null           ← committed seed, or null
```

The save path writes to the in-process `Map` always, and to the dev cache file only when `PERSIST` (the dev-mode flag) is true — because serverless filesystems are read-only in production. The route writes the collected events only after the *combined* `step==null` capture run completes (the split live steps hand off via the client's sessionStorage instead) and replays them on a cache hit, filtering the snapshot to the requested step via a per-step filter and pacing each event by `REPLAY_DELAY_MS = 180` so the replayed trace looks like a live run.

```
the route's replay branch
─────────────────────────────────────────────────────────────
 cached = get_cached_investigation(insightId)
 if cached:
     events = step ? filterByStep(cached, step) : cached   ← per-step slice
     for e in events:
         enqueue(encode_event(e))
         await sleep(REPLAY_DELAY_MS = 180)                ← paced replay
```

The key property: this is **exact-keyed snapshot replay**. The lookup is `mem.get(insightId)` — a hash lookup on an exact string. There is no notion of "similar" `insightId`s, no ranking, no distance. Either the exact `insightId` was investigated before (hit, instant replay) or it was not (miss, run live). It is `localStorage` semantics, not search semantics.

---

### Cross-step memory — the diagnosis handed across HTTP requests

There is a *third* memory location, distinct from both the per-run `messages` array and the long-term snapshot store: the diagnosis the two-step investigation carries from step 2 (diagnose) to step 3 (recommend). The two steps are separate HTTP requests — `?step=diagnose` then `?step=recommend` — so the diagnosis cannot live in the agent's in-loop `messages` (that array is GC'd when the diagnose request returns) and is not yet in the long-term store (the disk write only fires on the combined `step==null` capture run). It lives, for the span between two requests, in the browser's `sessionStorage`.

```
cross-step handoff (live two-step path)
─────────────────────────────────────────────────────────────────
 REQUEST 1  GET /api/agent?step=diagnose
   route runs DiagnosticAgent.investigate → sends {type:'diagnosis'}
   client (the investigation hook) on 'done':
     sessionStorage['bi:diag:<id>'] = JSON.stringify({ diagnosis })
                       │  diagnosis serialized, survives route change
                       ▼
 REQUEST 2  GET /api/agent?step=recommend&diagnosis=<…>
   route: parse_diagnosis(diagnosisParam) ← re-hydrated from the client
   RecommendationAgent.propose(inv, diagnosis)   ← step 3 reads step 2

 (demo path) cached snapshot replayed FILTERED to the step:
   get_cached_investigation(id) → filterByStep(cached, step)
```

This is agent memory carried *across HTTP requests and a route change*, not within an agent loop. In-loop message memory (the `messages` array above) is the model reasoning over its own turns inside one request; this is the orchestration layer persisting one node's typed output so the next node — running in a *later* request, after the user has advanced to step 3 — can consume it. On the demo path there is no live agent at all: the cached snapshot is replayed step-filtered so step 3 replays only the recommendation slice. So the diagnosis crosses the step boundary by exactly one of two routes — `sessionStorage` re-hydration on the live path, or a step-filtered snapshot replay on the demo path — neither of which is the agent's working memory. It is the chain's handoff (01-agents-vs-chains.md) made durable across the gap between two requests.

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

This is the **RAG-inside-an-agent** pattern — giving an agent semantic recall over its own history — and this system deliberately does not have it. The honest framing: the codebase chose live tool retrieval + exact-key caching over an embedding store, the same "no RAG until a feature needs it" decision documented in ../03-retrieval-and-rag/. Semantic memory is the primary buildable target in the exercises below.

---

### Current state vs future state

Today, long-term memory serves one job: make a repeat visit to a known investigation instant and demo-able (the committed demo-snapshot seed means the demo works with no API key). It does not serve learning — the agent does not get smarter from past investigations, because it cannot retrieve them by similarity. The future state is a semantic layer: embed each anomaly + diagnosis, store the vectors, and on a new anomaly retrieve the k most similar past investigations to seed the diagnostic agent's prompt. That turns durable memory from a replay cache into an experience base — and it is exactly the RAG pattern, which is why it lives at the boundary of this section and ../03-retrieval-and-rag/.

---

### The principle

**Match the memory's storage shape to the access pattern you actually need.** You need "show me this exact investigation again, instantly" — an exact-key lookup — so you use a keyed `Map` / file, the simplest thing that serves that access pattern. You do *not* yet need "find me investigations like this one," so you do not pay for a vector store. The mistake is reaching for semantic memory because it sounds powerful; the discipline is using exact-key storage until a feature genuinely requires similarity. Short-term memory follows the same rule: the `messages` array is the simplest structure that serves multi-step reasoning, and it is discarded the moment the run that needs it ends.

---

## Agent memory — diagram

The diagram spans three layers. The Agent layer holds short-term memory (the per-run `messages` array). The State layer holds long-term memory (the three-tier keyed store). The Route layer is where they meet — it reads long-term on entry and writes it on completion, and it never sees short-term memory (which lives and dies inside the agent).

```
┌──────────────────────────────────────────────────────────────────────┐
│  ROUTE LAYER   app/api/agent/route.ts                                 │
│                                                                       │
│  on entry:  cached = getCachedInvestigation(insightId)               │
│             if hit → filterByStep(cached, step), replay               │
│                      (paced 180ms)                       ← long-term   │
│             if miss → run agents live (per ?step)                     │
│  on done:   if step==null: saveInvestigation(id, …)  ← write    │
└───────────┬───────────────────────────────────────┬───────────────────┘
   write/read│ (long-term)             run live      │
┌───────────▼───────────────────────┐  ┌─────────────▼───────────────────┐
│  STATE LAYER (LONG-TERM)           │  │  AGENT LAYER (SHORT-TERM)        │
│  lib/state/investigations.ts       │  │  lib/agents/base.ts runAgentLoop │
│                                    │  │                                  │
│  getCachedInvestigation(insightId):│  │  messages: MessageParam[]        │
│   1. mem.get(id)   ← process Map   │  │  [0] user prompt                 │
│   2. CACHE_FILE    ← dev file      │  │  [+] assistant turns             │
│   3. DEMO_FILE     ← committed seed │  │  [+] user tool_results           │
│   exact key → snapshot OR null     │  │  model sees ALL each turn        │
│                                    │  │  discarded on return              │
│  (NO embeddings, NO similarity)    │  │  (per-run, per-agent, ephemeral) │
└────────────────────────────────────┘  └──────────────────────────────────┘
```

A reader who sees only this diagram should grasp: short-term memory lives inside the agent and dies with the run; long-term memory is an exact-keyed snapshot store in the State layer; there is no semantic layer.

---

## Implementation in codebase

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

## See also

→ 01-agents-vs-chains.md · → 03-react-pattern.md · → 06-error-recovery.md · → ../03-retrieval-and-rag/ · → ../../study-system-design/06-multi-agent-orchestration.md · → ../../study-system-design/04-caching-and-rate-limiting.md
