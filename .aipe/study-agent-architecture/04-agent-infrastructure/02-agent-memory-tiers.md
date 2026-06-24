# Agent memory tiers

**Industry name(s):** Working / episodic / long-term memory, agent memory tiers, three-tier memory model
**Type:** Industry standard · Language-agnostic

> Memory as a dedicated component, separate from the context window — split into working, episodic, and long-term tiers by how durable each one is. blooming insights has the first tier (the per-run `messages[]` array) and a partial second (per-investigation cache + sessionStorage handoff). The third tier (semantic/vector long-term) is honestly not built.


---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Agent memory tiers cut across the whole request: working memory lives inside the Shared agent loop (the `messages[]` array growing turn by turn); episodic memory lives between stages of the Pipeline coordinator (the typed `Diagnosis` handed forward, or the cross-request `sessionStorage` + URL handoff); long-term memory would sit *orthogonal* to the request flow entirely (a persistent store outside any band). In blooming insights, the first two are explicit and named; the third is absent — there's no persistent user-preference store, so the agent is amnesic across sessions by design.

```
  Zoom out — where the memory tiers live

  ┌─ Pipeline coordinator ──────────────────────────┐  ← we are here (episodic)
  │  lib/agents/pipeline.ts                          │
  │  ★ episodic memory ★: typed Diagnosis flows from │
  │  stage to stage (in-process function arg, or     │
  │  cross-request sessionStorage + URL handoff)     │
  └─────────────────────────┬────────────────────────┘
                            │
  ┌─ Shared agent loop ─────▼────────────────────────┐  ← we are here (working)
  │  runAgentLoop                                     │
  │  ★ working memory ★: messages[] grows per turn    │
  │  (gone the moment the loop returns)               │
  └──────────────────────────────────────────────────┘

  Orthogonal (NOT in the request flow):
  ┌─ Long-term memory ──────────────────────────────┐  ← absent
  │  ★ THIS ★ (absent in blooming insights)           │
  │  Would be: persistent user-preference store,      │
  │  retrievable by relevance across sessions.        │
  │  Today: agent is amnesic between sessions.        │
  └──────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question is: how do you split an agent's memory so the right thing is remembered at the right scope? Same instinct you use for React state vs sessionStorage vs localStorage — pick the tier by how long the fact needs to live, not by what's easiest to grab. Wrong tier and you either lose data the user expected to keep, or you persist data that should have been ephemeral. Below, you'll see the three tiers, what blooming insights has wired today (working + episodic), and what changes when the third tier (long-term) becomes a requirement.

---

## Structure pass

**Layers.** Three tiers stack by durability and a fourth band sits orthogonal: **Working memory** (the `messages[]` array inside `runAgentLoop` — alive for one run, gone the moment the loop returns), **Episodic memory** (between-stage handoff and between-request stash — the typed `Diagnosis` carried as a function arg or as `sessionStorage` + URL param, alive for one investigation), **Long-term memory** (a persistent semantic / vector store — absent in this codebase, would live outside any request band), and the **Retrieval mechanism** that pulls from each tier (free for working — it's already in the array; cheap for episodic — function arg or storage lookup; a network call for long-term — vector search).

**Axis: lifecycle.** When does each piece of memory come into existence, how long does it live, and when is it discarded? This is the right axis because the entire three-tier model is *durability-stratified* — the only reason to split memory into tiers at all is that different facts need different lifetimes. Cost is correlated (retrieval gets more expensive as you go deeper) but cost is the *consequence* of durability — you pay more to keep things longer. State-ownership is incidental (each tier obviously has its own owner); lifecycle is the discriminator.

**Seams.** Two seams matter, and they map onto the tier boundaries. Seam 1 sits between working and episodic — lifetime flips from "this run" (gone at loop return) to "this investigation" (survives a stage handoff and sometimes a page navigation). Seam 2 sits between episodic and long-term — lifetime flips from "hours to days, scoped to one investigation/session" to "persistent, retrieved across sessions by relevance." Seam 2 is the load-bearing one: it's the boundary where the system stops being amnesic, and it's the boundary blooming insights chose *not* to cross — which is why the agent has no memory of you between sessions, by design.

```
  Structure pass — Agent memory tiers

  ┌─ 1. LAYERS ───────────────────────────────────┐
  │  Working (messages[] in agent loop)            │
  │  Episodic (typed handoff + sessionStorage)     │
  │  Long-term (semantic / vector — absent here)   │
  │  Retrieval (free / cheap / network)            │
  └────────────────────────┬───────────────────────┘
                           │  pick the axis
  ┌─ 2. AXIS ─────────────▼────────────────────────┐
  │  lifecycle: when does each tier live and die?  │
  └────────────────────────┬───────────────────────┘
                           │  trace across layers, find flips
  ┌─ 3. SEAMS ────────────▼────────────────────────┐
  │  Seam 1: working ↔ episodic                    │
  │          (one run → one investigation)         │
  │  Seam 2: episodic ↔ long-term                  │
  │          (one session → persistent across)     │
  │          ★ load-bearing — crossing it is the   │
  │          "we have memory of you" boundary      │
  └────────────────────────┬───────────────────────┘
                           ▼
                   Block 4 — How it works
```

The skeleton is mapped — the rest of this file walks each tier, what blooming insights has wired, and what changes when the long-term tier becomes a requirement.

---

## How it works

**The mental model: three tiers stacked by durability — working (this run), episodic (between runs, short-lived), long-term (persistent, retrieved by relevance).** Every fact an agent reasons about belongs in exactly one tier. The further down the stack a fact lives, the more durable and the more expensive it is to retrieve (a `messages[]` push is free; a vector search is a network call). The decision rule is the same as for browser storage: pick the tier by lifetime, not convenience.

```
Three tiers, stacked by durability (mental model)

  ┌─ working (in-context) ───────────────────────────┐
  │  the current turn's scratchpad                   │
  │  lifetime: one run                                │
  │  blooming insights: messages[] in base.ts         │  ✓ built
  └───────────────────────────────────────────────────┘
  ┌─ episodic (recent sessions) ─────────────────────┐
  │  past runs/conversations, retrievable             │
  │  lifetime: hours to days                          │
  │  blooming insights: cache + sessionStorage stash  │  ~ partial
  └───────────────────────────────────────────────────┘
  ┌─ long-term (persistent) ─────────────────────────┐
  │  durable facts, decisions, preferences            │
  │  lifetime: until evicted                          │
  │  blooming insights: NOT built                     │  ✗ absent
  └───────────────────────────────────────────────────┘
```

The strategy in plain English: **lifetime decides tier, and retrieval decides cost.** Working memory is free to write and free to read because it's just an array in memory. Episodic memory is cheap (exact-key lookup by `insightId`), useful because *the right key* is knowable at access time. Long-term memory is the expensive tier — every read is a semantic search, every write is an embedding compute — and it earns its keep only when the access pattern is "I don't know exactly what I'm looking for, just what it's similar to." blooming insights doesn't have that access pattern yet, so the third tier is honestly absent.

### Move 1 — Working memory: the per-run `messages[]` array

The technical thing: **the message history that grows turn by turn inside a single agent run.** Every `tool_use` and `tool_result` lands here; the model reads this whole array on every turn; it's discarded when the run returns.

If you're coming from frontend, this is React state inside a single component instance — `useState<Message[]>([...])` with `setMessages([...prev, next])` on every update. It survives the next render (the next `messages.create` call) but not the unmount (the function returning). Lifetime: this render tree.

```
working memory — pseudocode

  messages = [
    { role: 'user', content: user_prompt },
  ]

  for turn in 0..max_turns:
    res = await model.create({ ..., messages })
    messages.push({ role: 'assistant', content: res.content })
    # ... run tools ...
    messages.push({ role: 'user', content: tool_results })
  # function returns → messages goes out of scope → memory is gone
```

The practical consequence: every turn the model gets the full reasoning trail of *this* run. It remembers it queried `purchase` count two turns ago, so it doesn't re-query. It knows what the diagnostic plan was, so it stays on it. But the *next* run of the same agent starts with `messages = [{role:'user', content: userPrompt}]` — empty otherwise. There's no carry-over.

The condition under which it works: working memory is right when the task fits in one run and what you remembered isn't needed afterward. The 6-call investigation pattern fits this — by the time the diagnostic agent finishes, every tool result it cared about is already reflected in its final JSON conclusion. There's nothing to keep around.

### Move 2 — Episodic memory: the cache + sessionStorage handoff

The technical thing: **a keyed snapshot of past runs that *another* run can pull back by exact id.** Not vector search — exact lookup. blooming insights has two layers of this glued together: the server-side cache (`getCachedInvestigation`) and the client-side stash (`sessionStorage`), with a special handoff key for the cross-step diagnosis.

If you're coming from frontend, this is the multi-step form pattern: when the user finishes step 2, you stash `{ formStep2: data }` in `sessionStorage` keyed by the form's draft id, so step 3 can read it back if the user navigates between them. Lifetime: this tab's session. Access: exact key.

```
episodic memory — two layers glued at the route boundary

  server side: the in-process state map
  ┌────────────────────────────────────────────────────┐
  │  mem = new Map<insight_id, agent_event[]>()        │
  │  save_investigation(insight_id, collected)          │
  │  get_cached_investigation(insight_id): replay later │
  └────────────────────────────────────────────────────┘

  client side: the investigation hook
  ┌────────────────────────────────────────────────────┐
  │  stash_key(step, id)    = `bi:inv:${step}:${id}`    │
  │  diag_handoff_key(id)   = `bi:diag:${id}`           │
  │  on 'done': session_storage.set(stash_key, ...)     │
  │  step=='diagnose' && c_diag: handoff to step 3      │
  └────────────────────────────────────────────────────┘
```

The practical consequence: the user opens an anomaly, the diagnostic runs (working memory inside the shared agent loop), the final diagnosis is sent over NDJSON, the route's save-investigation call snapshots it server-side and the investigation hook stashes it client-side. When the user clicks "next step" to see the recommendation, the client reads `bi:diag:<id>` from session storage and posts it back to the route as the `diagnosis` param — the recommendation agent now has working memory pre-seeded with the diagnosis it would have re-run otherwise. **Episodic memory turns a cross-step problem into a cross-key lookup.**

The condition under which it works: the access pattern has to be "I know exactly which past run I want." The user clicks a specific anomaly's "recommend" button — that's the exact `insightId`. There's no "find me a past run *like* this one"; the access is point-lookup. That's the whole reason the cache can be a `Map` instead of a vector store.

```
the cross-step handoff in one picture

  step 2 (diagnose)                 step 3 (recommend)
  ┌────────────────────┐            ┌────────────────────┐
  │ runAgentLoop +     │            │ load diagnosis from│
  │ produces diagnosis │            │ bi:diag:<id>       │
  │   ▼                │            │   ▼                │
  │ saveInvestigation  │            │ inject as          │
  │ (server map)       │            │ recAgent.propose() │
  │   ▼                │            │   input             │
  │ sessionStorage     │ ─────────► │ (no re-run of      │
  │ bi:diag:<id>       │  handoff   │  diagnostic!)       │
  └────────────────────┘            └────────────────────┘
```

The honest caveat: the server-side state map lives in the function instance — it survives within one warm container, but a cold start or a different lambda invocation comes up with an empty map. A dev-only file cache and the committed demo seed cover that gap in development and the seed flow. For real cross-instance persistence you'd want Redis or a row store; right now the cross-instance gap is filled by the client stash, which is more durable than the server cache.

### Move 3 — Long-term memory: NOT built, and that's a real decision

The technical thing: **a persistent store the agent retrieves from by *relevance*, not exact key.** The classical shape is "embed the new fact, store it in a vector DB, on a future run embed the current task and pull the most similar past facts." Lifetime: until evicted by retention policy.

If you're coming from frontend, this would be a `localStorage` with full-text search — except instead of `LIKE %query%`, the matching is semantic similarity. You can recall something even if you don't remember the exact key it was stored under.

```
long-term memory — what it would look like (NOT in this codebase)

  ┌─────────────────────────────────────────────┐
  │ on a finished run:                           │
  │   embed(summary) → vector DB                 │
  │     fact: "user prefers monthly windows"     │
  │     fact: "Q4 traffic dip was expected"      │
  └─────────────────────────────────────────────┘
  ┌─────────────────────────────────────────────┐
  │ on a new run:                                │
  │   embed(currentTask) → vector DB             │
  │     retrieve top-k similar past facts        │
  │     inject into the system prompt slot       │
  └─────────────────────────────────────────────┘

  In this codebase: this entire path does not exist.
  No embeddings. No vector store. No long-term recall.
```

The practical consequence — what the agent *can't* do today: it can't remember that this user, last week, asked the same question. It can't carry preferences across investigations. It can't learn "this workspace's Q4 dip is annual and expected" from a past run's resolution. Every run is a fresh slate above the episodic layer.

Why it's not built (the honest reason): the access pattern that would justify it doesn't exist yet. The current jobs — detect, diagnose, recommend, query — are all *workspace-scoped* and *task-scoped*. The relevant context is in the schema (which is fetched fresh each run) and in the current anomaly (which is point-looked-up). There's no "user history across workspaces" yet because there isn't multi-user state yet. The day the product gains "remember my preferences across investigations" or "learn what anomalies I keep dismissing," the third tier earns its build cost.

### Move 4 — Where each fact actually lives (the routing decision)

The architectural decision boils down to: **for each kind of fact, which tier?** blooming insights' answer:

```
fact → tier routing in this codebase

  this turn's tool calls + results  →  working (messages[])
  the just-produced diagnosis        →  episodic (cache + bi:diag)
  the full investigation trace       →  episodic (cache + bi:inv:<step>)
  the workspace schema               →  working (re-fetched each run)
  one-off auto-reconnect flag        →  episodic (a session-storage flag)
  user preferences across runs       →  ✗ no tier
  "anomaly X was dismissed by user"  →  ✗ no tier
  cross-investigation patterns       →  ✗ no tier
```

The reframe to hand the reader: every "the agent should remember…" feature request is really a "which tier does this belong in" question. If the answer is working or episodic, the codebase has the slot; if the answer is long-term, the tier doesn't exist yet and adding it is real work (embeddings, vector store, retrieval policy, eviction).

### The principle

Memory in an agent is the same problem as storage in a frontend app: pick the tier by lifetime, accept the access pattern that tier implies. Working memory is free to read but evaporates; episodic memory is cheap to read by exact key but useless for "anything like this"; long-term memory is the only tier that supports relevance retrieval, and it pays for that with embedding cost and a retrieval policy that has to be designed, not defaulted. The discipline is to map every fact to one tier and never reach for a tier you don't have — silently faking long-term memory by stuffing more into working memory is how agents end up with bloated, slow, context-poisoned runs.

The full picture is below.

---

## Agent memory tiers — diagram

```
The three tiers, mapped to this codebase

  ┌─────────────────── WORKING (in-context) ──────────────────────┐
  │ the shared agent loop                                          │
  │   messages = [...]                                              │
  │   messages.push({ role: 'assistant', ... })                     │
  │   messages.push({ role: 'user', ... })                          │
  │ lifetime: one agent-loop invocation. dies on return.            │
  └───────────────────────────────────────────────────────────────┘
                              │
                              │ run ends → final result is captured
                              ▼
  ┌─────────────────── EPISODIC (recent sessions) ────────────────┐
  │ server: the in-process state map                               │
  │   mem = new Map<string, agent_event[]>()                       │
  │   save_investigation(insight_id, collected)                    │
  │   get_cached_investigation(insight_id)                         │
  │                                                                │
  │ client: the investigation hook                                 │
  │   stash_key(step, id) = `bi:inv:${step}:${id}`                 │
  │   diag_handoff_key(id) = `bi:diag:${id}`                       │
  │   session_storage.set(stash_key, ...)                          │
  │   diag handoff for step 3                                       │
  │                                                                │
  │ access: EXACT KEY by insight_id/step. lifetime: warm instance /│
  │         tab session. no relevance retrieval.                   │
  └───────────────────────────────────────────────────────────────┘
                              │
                              │ no embedding step → no upper tier
                              ▼
  ┌─────────────────── LONG-TERM (persistent) ────────────────────┐
  │ NOT IMPLEMENTED.                                               │
  │ No vector DB, no embeddings, no semantic recall.               │
  │ The access pattern that justifies it (cross-run, by relevance) │
  │ does not exist in this product yet.                            │
  └───────────────────────────────────────────────────────────────┘
```

---

## Implementation in codebase

**Working memory (Case A — built):**
**File:** `lib/agents/base.ts`
**Function:** `runAgentLoop()` — the `messages` array initialised at L79 and pushed at L105/L171
**Line range:** L79–L172

Every tool call's result is `truncate`d (L150) and pushed into `messages` (L171). The array dies when the function returns; there is no carry-over to the next call.

**Episodic memory (Case A — partial, exact-key only):**
**Server cache file:** `lib/state/investigations.ts`
**Function:** `saveInvestigation()` / `getCachedInvestigation()`
**Line range:** L11 (the Map), L22 (read), L30 (write)

**Client stash file:** `lib/hooks/useInvestigation.ts`
**Function:** the `stashKey` / `diagHandoffKey` helpers and the `'done'` event handler
**Line range:** L18–L19 (key helpers), L133–L143 (write on done, including the cross-step diagnosis handoff)

The cross-step diagnosis handoff is the load-bearing case: step 2's diagnosis is stashed in `sessionStorage` at key `bi:diag:<insightId>` and read back by step 3 (`useInvestigation.ts` ~L138 + the route param at `app/api/agent/route.ts` L227).

**Long-term memory (Case B — Not yet implemented):**
There is no semantic / vector long-term memory in this codebase. The honest reason: every current job (detect / diagnose / recommend / query) is workspace-scoped and task-scoped, and the relevant context is either in the live schema (re-fetched each run) or in a point-looked-up anomaly id (the episodic tier handles it). A cross-run retrieval pattern would need a user model and a persistent store, neither of which exists yet.

```
shape (not full impl):
  // WORKING — base.ts L79
  const messages: MessageParam[] = [{ role: 'user', content: userPrompt }];

  // EPISODIC server — investigations.ts L11/L22/L30
  const mem = new Map<string, AgentEvent[]>();
  export function saveInvestigation(id, events) { mem.set(id, events); }
  export function getCachedInvestigation(id) { return mem.get(id) ?? null; }

  // EPISODIC client handoff — useInvestigation.ts L19/L138
  const diagHandoffKey = (id) => `bi:diag:${id}`;
  if (step === 'diagnose' && cDiag) {
    sessionStorage.setItem(diagHandoffKey(id), JSON.stringify({ diagnosis: cDiag }));
  }

  // LONG-TERM — not present in the repo.
```

---

## Elaborate

### Where this pattern comes from

The three-tier model — working / episodic / long-term — borrows its names from cognitive science (where the terms have been standard for decades) and was applied to AI agents through frameworks like MemGPT (2023) and the LangGraph memory work that followed. The motivating observation was that context windows alone don't model how a useful assistant remembers: a useful assistant remembers different things at different scopes, and the system has to make those scopes explicit instead of cramming everything into the window.

### The deeper principle

**Storage layering by durability is universal.** Every system with state eventually grows tiers because not all state has the same lifetime. Browsers have React state / sessionStorage / localStorage / IndexedDB. Servers have request locals / session stores / DBs. Agents have working / episodic / long-term. The principle in every case: pick the cheapest tier that matches the lifetime, and accept that tier's access pattern as a constraint.

```
  Lifetime needed    →  Tier             →  Access pattern
  one render          →  React state       →  read by reference
  one tab session     →  sessionStorage    →  read by key
  cross-session       →  localStorage / DB →  read by key / query

  one agent run       →  working           →  read full history
  cross-run, point    →  episodic          →  read by exact key
  cross-run, fuzzy    →  long-term         →  read by relevance
```

### Where this breaks down

Episodic memory breaks down when the access pattern stops being point-lookup — when a user wants "any past investigation about this kind of anomaly," not "the past investigation with id X." At that point the `Map` keyed by `insightId` can't help and either a tag-indexed store (cheap) or a vector store (more flexible) has to replace it. Working memory breaks down when a single task's scratchpad exceeds the window — that's covered by `01-context-engineering.md`'s truncation; at the limit, the agent has to summarise its own working memory mid-run.

### What to explore next
- Context engineering (`01-context-engineering.md`) → memory has to fit *into* the curated window
- Agentic RAG (`../02-agentic-retrieval/01-agentic-rag.md`) → what long-term memory looks like when it's a control loop, not a fixed retrieval step
- Two-layer memory mechanics (`../../study-ai-engineering/04-agents-and-tool-use/05-agent-memory.md`) → the codebase-level walk of the short/long split; this file extends to the three-tier model

---

## Interview defense

### What an interviewer is really asking
When an interviewer asks "how does your agent remember things," they're testing two things: (1) do you know there are multiple kinds of memory, and (2) did you build the right tiers for your access patterns, or did you reflexively reach for a vector DB because "agents need memory." The strong signal is naming the access pattern that justifies each tier (or doesn't); the weak signal is "we use Pinecone."

### Likely questions

[mid] Q: What does the agent actually remember inside one run?

A: The `messages[]` array in `runAgentLoop` (`lib/agents/base.ts` L79). Every tool call's truncated result is pushed back into it (L171), so the model sees the full reasoning trail of this run on every turn. It's working memory in the cognitive-science sense: lives in the window, gone when the function returns. Across runs, none of it survives — the next call starts with `messages = [user prompt]` and nothing else.

Diagram:
```
   turn 0: messages = [user]
                ▼  push assistant + tool_results
   turn 1: messages = [user, asst, tool_result, ...]
                ▼  ...
   turn N: model emits final JSON → return → messages garbage-collected
```

[senior] Q: How does the diagnosis from step 2 reach step 3, given the route is stateless?

A: Episodic memory at two layers. The route saves the whole investigation trace to a server-side `Map` keyed by `insightId` (`lib/state/investigations.ts` L30), and the client stashes the same trace plus a special `bi:diag:<id>` key for the diagnosis in `sessionStorage` on the `done` event (`lib/hooks/useInvestigation.ts` L133, L138). When the user clicks step 3, the client reads `bi:diag:<id>` and posts the diagnosis back as a query param; the route hands it directly to `recAgent.propose()` instead of re-running the diagnostic agent. The server `Map` is a per-instance optimisation; the sessionStorage stash is the durable half because the server cache can vanish on cold start.

Diagram:
```
   step 2                       client                    step 3
   route.ts                     sessionStorage             route.ts
   ──────────                   ──────────────             ──────────
   saveInvestigation  ────►     bi:inv:diagnose:<id>
                                                          read bi:diag:<id>
                                bi:diag:<id>     ────►    inject as
                                  (diagnosis)             recAgent.propose()
                                                          input — no re-run
```

[arch] Q: At 10× users with cross-investigation features (dismissals, preferences, "compare to past"), what changes in the memory layer?

A: Tier 3 has to exist. The current episodic layer is exact-key only and won't help when the access pattern becomes "find me past runs *like* this one" or "did this user dismiss anything like this before?" The cheapest move is `pgvector` (assuming Postgres is in the stack by then) with embeddings on the diagnosis summaries and the user-action log; that gives semantic recall without standing up a new vector service. The other thing that has to change is the server-side cache: today it's a per-instance `Map`; at 10× users with stateful access patterns it has to be Redis or a row store so warm-cache state survives cold starts. The working tier (the `messages[]` array) doesn't change at all — that scales horizontally because it's per-run.

Diagram:
```
  ┌ Working (messages[])        ── unchanged ──────────────┐
  ┌ Episodic server (Map)       ◄── BREAKS: per-instance,  │
  │                               replace with Redis        │
  ┌ Episodic client (stash)     ── unchanged ──────────────┐
  ┌ Long-term (vector DB)       ◄── BUILDS: new tier,      │
  │                               pgvector first choice     │
  └ Retrieval policy            ◄── DESIGN WORK: what to    │
                                  embed, when to recall    ─┘
```

### The question candidates always dodge
Q: Doesn't a "real" agent need long-term memory? Isn't shipping without a vector store kind of half-built?

A: Honest answer: yes, a "real" agent for many use cases needs long-term memory — but this codebase doesn't yet have the access pattern that would justify one. Every job today is workspace- and task-scoped: the schema is fetched fresh each run, the anomaly is point-looked-up by id, the diagnosis is handed forward by exact key. There's no place in the product surface where "find me a past run similar to this" is the question. Building a vector store before that question exists would mean designing a retrieval policy for a problem I don't have — and a vector store with a wrong retrieval policy is worse than no vector store, because it confidently surfaces stale or off-topic facts that poison the trajectory. The mature move is to ship the two tiers that match the access patterns I have, name the absent tier honestly, and add it the day the access pattern shows up (probably with dismissals or cross-investigation comparisons). I can point at `lib/state/investigations.ts` and `lib/hooks/useInvestigation.ts` for what's built, and at the absent `pgvector` dependency for what's not.

Diagram:
```
   Build now (chosen)              Build now anyway (suggested)
   ┌────────────────────────┐     ┌────────────────────────┐
   │ exact-key episodic     │     │ vector store + embed    │
   │ matches access pattern │     │ pipeline + retrieval    │
   │   ▼                    │     │ policy design           │
   │ 0 stale-recall risk    │     │   ▼                     │
   │ 0 infra cost            │     │ silent stale-recall    │
   │ 0 retrieval-policy bug │     │ poisons trajectories    │
   └────────────────────────┘     └────────────────────────┘
       Add tier 3 the day the access pattern arrives, not before.
```

### One-line anchors
- "Memory tiers are storage layering by lifetime — same instinct as React state / sessionStorage / localStorage."
- "Working = `messages[]`. Episodic = `Map` + `sessionStorage`. Long-term = absent, on purpose."
- "Exact-key lookup is enough until the access pattern becomes 'find me one *like* this.'"
- "The `bi:diag:<id>` handoff is the load-bearing episodic case — cross-step memory across a stateless route."
- "A vector store designed for the wrong access pattern is worse than no vector store."

---

## See also

→ `01-context-engineering.md` · → `03-tool-calling-and-mcp.md` · → mechanics: `../../study-ai-engineering/04-agents-and-tool-use/05-agent-memory.md`

---
Updated: 2026-05-29 — created
Updated: 2026-05-30 — Migrated to study.md v1.47 template (Phase 1+2 mechanical): removed Tradeoffs / Tech reference / Summary sections; renamed "In this codebase" → "Implementation in codebase"; moved See also to a bottom block. "Why care" preserved pending Phase 3 (Zoom out, then zoom in + LAYERS diagram) authoring.
Updated: 2026-05-30 — Phase 3 of study.md v1.47 migration: replaced "Why care" block with "Zoom out, then zoom in" (LAYERS diagram + zoom-in paragraph) per format.md.
Updated: 2026-05-31 — Applied study.md v1.48: scrubbed "How it works" of file paths, line refs, and real-code fences; replaced with generic role labels + pseudocode per format.md. Codebase-specific anchoring lives exclusively in "Implementation in codebase".
Updated: 2026-05-31 — Applied study.md v1.50: added Structure pass block (layers · axis · seams) between Zoom out and How it works per format.md's new Block 3.
Updated: 2026-06-24 — Stripped `## Validate` block per spec v1.68.3 (the Validate primitive was removed from the per-concept template; block 10 is now `See also`).
