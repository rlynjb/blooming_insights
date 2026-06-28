# Agent memory tiers

*Industry name: agent memory / working / episodic / long-term memory — Industry standard.*

Memory as a dedicated component, separate from the context window. This repo has **only working memory** (in-context, per-run) plus a thin episodic cache for replay purposes (`lib/state/investigations.ts`). No long-term memory, no embeddings, no cross-session retrieval.

## Zoom out — where this concept lives

Memory tiers sit between the agent and the data layer — they're the storage for "what does this agent know across turns / runs / sessions." In this repo, the only durable storage is the demo-snapshot file and the in-memory state maps; everything else is the per-run context.

```
  Where memory lives in blooming insights

  ┌─ Per-run (working memory) ────────────────────────────┐
  │  Anthropic message array (the agent loop's history)    │ ← we are here
  │  AptKit accumulates per turn; lives in process memory   │
  │  GONE when the run ends                                 │
  └────────────────────────────────────────────────────────┘
  ┌─ Per-session (thin episodic) ─────────────────────────┐
  │  lib/state/insights.ts (in-memory map, sid-scoped)     │ ← also we are here
  │  lib/state/investigations.ts (in-memory map + dev file)│
  │  CLEARED on Vercel instance recycle                     │
  └────────────────────────────────────────────────────────┘
  ┌─ Per-deploy (committed snapshot) ─────────────────────┐
  │  lib/state/demo-insights.json + demo-investigations    │ ← also we are here
  │  Git-tracked; used for demo mode replay                 │
  └────────────────────────────────────────────────────────┘
  ┌─ Long-term (NOT IMPLEMENTED) ─────────────────────────┐
  │  No vector store. No embeddings. No semantic recall.   │ ← gap
  └────────────────────────────────────────────────────────┘
```

## Structure pass

The axis: **how long does this memory live?**

```
  Tier        Lifetime           In this repo                   Use
  ──────      ──────────         ────────────                   ───
  Working     one run            Anthropic message array         loop history
  Episodic    one session        lib/state/* maps + dev file     UI hydration,
                                                                  replay
  Long-term   forever (durable)  NONE                            past investigations,
                                                                  semantic recall
  Snapshot    forever (git)      lib/state/demo-*.json           demo mode
```

## How it works

### Move 1 — the mental model

You know the cache hierarchy — L1 (per-request, tiny, fast) → L2 (per-session, medium) → L3 (per-deploy, durable). Agent memory tiers are the same shape:

- **Working memory** = L1. The current run's context. Lives in the model's window. Gone when the run ends.
- **Episodic memory** = L2. Summaries of past runs/conversations, retrieved by relevance to the current task. In this repo, just per-session caches for the UI.
- **Long-term memory** = L3. Durable facts, decisions, preferences. Stored in a vector DB or graph. Unbounded. **Not in this repo.**

```
  Memory tiers — by lifetime

  ┌─ Working (in-context) ─────────────────────────┐
  │  The current task's context. Lives in the      │
  │  window. Gone when the run ends.               │
  └────────────────────────────────────────────────┘
  ┌─ Episodic (recent sessions) ───────────────────┐
  │  Summaries of past runs/conversations.          │
  │  Retrieved by relevance to the current task.    │
  └────────────────────────────────────────────────┘
  ┌─ Long-term (persistent knowledge) ─────────────┐
  │  Durable facts, decisions, preferences. Stored │
  │  in a vector DB / graph. Unbounded.             │
  └────────────────────────────────────────────────┘
```

### Move 2 — walk this repo's actual memory layers

**Tier 1: Working memory (the loop's message array).**

Every agent's `runAgentLoop` keeps a `messages: Anthropic.Messages.MessageParam[]` array — that's the working memory. It accumulates the user prompt, each assistant turn, each tool result. From `base-legacy.ts:107-138` (and identically in AptKit's runtime):

```typescript
const messages: Anthropic.Messages.MessageParam[] = [
  { role: 'user', content: userPrompt },
];
// each turn:
messages.push({ role: 'assistant', content: res.content });
// after tool execution:
messages.push({ role: 'user', content: toolResults });
```

Lifetime: one run (one HTTP request, one `agent.scan()` call). Bounded by `maxTurns` and `maxToolCalls`. Gone when the function returns.

This is the only memory most agents have, and for ReAct it's enough — the model can recall every prior tool call within the same loop.

**Tier 2: Episodic cache (per-session in-memory maps + dev file).**

For UI hydration and demo capture, the route handler stores finished investigations in `lib/state/investigations.ts`. Two purposes:

1. **Cache combined runs.** When `step === null` (capture path), the route saves the full collected event array to a per-session map keyed by `insightId`. Replaying that map serves the investigation back instantly without re-running the agents.
2. **Persist for the user's session.** When the user navigates between feed and investigation pages, the in-memory map serves the cached investigation (until the Vercel instance recycles).

The "thin" qualifier is critical: this isn't a true episodic memory in the agent sense. The cached investigation isn't *retrieved by relevance to a new task* — it's keyed by exact `insightId`. It's a UI cache that happens to hold past agent outputs, not a tier the agents themselves consult.

In dev, the map also persists to a gitignored file (`.investigation-cache.json`) so investigations survive restart. In production on Vercel, it's purely in-memory and lost on instance recycle.

**Tier 3: Snapshot (committed demo files).**

`lib/state/demo-insights.json` and `demo-investigations.json` are git-tracked snapshots of one captured live run. The demo mode replays these files as if they were live agent output — the only purpose is presentation reliability (`bi:mode === 'demo'`). The agents themselves never read these files.

**Tier 4: Long-term memory — NOT IMPLEMENTED.**

There is no vector store, no embedding pipeline, no semantic-recall layer. The agents on each new investigation start from scratch — they don't know what past anomalies looked like, what past diagnoses concluded, or what past recommendations the user followed.

The natural case for adding it: a feature like "have we seen this kind of anomaly before?" or "what did we recommend last time conversion dropped 18% on mobile?" Both would benefit from a semantic search over past investigations. The implementation would be:

- Embed each finished investigation (anomaly + diagnosis + recommendations) at the time of save
- Store in pgvector (adds Postgres — currently no DB at all)
- Add a `vector_search` tool to the DiagnosticAgent's tool grant
- Update the prompt to encourage "check past investigations first"

The cost: one new dependency (pgvector + Postgres), one new pipeline (embed-on-save), the maintenance of the corpus (re-embed when the embedding model changes). The win: each investigation can ground in prior ones; the system gets smarter over time.

### Move 2.5 — current state vs the three-tier model

The product as it is now is at the *minimum viable* point on the memory axis — only working memory + thin episodic for UI. The next step toward "three-tier model" is adding long-term memory.

```
  Current state vs full three-tier

  TODAY:
  ┌─ working (per-run) ──────────┐  ← all agent reasoning lives here
  │  Anthropic message array      │
  └───────────────────────────────┘
  ┌─ episodic (UI cache only) ────┐  ← not agent-readable; just UI hydration
  │  per-session in-memory map     │
  └────────────────────────────────┘
  ┌─ long-term ───────────────────┐
  │  NOT IMPLEMENTED               │
  └────────────────────────────────┘

  HYPOTHETICAL (full three-tier):
  ┌─ working (per-run) ──────────┐
  │  Anthropic message array      │  same as today
  └───────────────────────────────┘
  ┌─ episodic (cross-session) ────┐
  │  pgvector index over past      │  upgrade: agent-readable, not just UI
  │  investigations                 │
  │  retrieved by similarity to     │
  │  current anomaly                │
  └────────────────────────────────┘
  ┌─ long-term (durable facts) ───┐
  │  pgvector index over Bloomreach│
  │  product docs + marketer guides│
  └────────────────────────────────┘
```

### Move 3 — the principle

The retrieval problem is the load-bearing one. Long-term memory only works if the right thing is retrieved at the right time — which is RAG inside the agent (see `../02-agentic-retrieval/01-agentic-rag.md`). Adding a memory tier without the retrieval discipline gives you a write-heavy store nobody reads.

The right way to think about memory tiers: each tier is a tradeoff between freshness (working is hottest, long-term is coldest) and coverage (working sees one run, long-term sees everything). The product question is which freshness/coverage point your task lives at.

## In this codebase

**Partial.** Working memory is in the kernel; episodic exists as a UI cache (not agent-readable); long-term doesn't exist.

The case for adding cross-session episodic memory (semantic recall over past investigations): when the product needs to ground new investigations in prior ones — "we've seen this kind of revenue drop before and the cause was X." Today every investigation starts from zero. Adding the tier would change "an analyst who restarts every conversation" into "an analyst who remembers patterns" — that's the qualitative shift it would unlock.

What would change in the codebase:
1. Add Postgres + pgvector (currently no DB)
2. Embed-on-save hook in `lib/state/investigations.ts`
3. New tool: `search_past_investigations(query, top_k)` in the DiagnosticAgent's tool grant
4. Prompt update: "check past investigations first" instruction

## Primary diagram

The four tiers in this repo with what each holds:

```
  Memory in blooming insights — by tier

  ┌─ Tier 1: working memory ─────────────────────────────────┐
  │  Anthropic message array inside runAgentLoop              │
  │  contents: user prompt, assistant turns, tool results     │
  │  lifetime: one run                                        │
  │  bounded by: maxTurns + maxToolCalls                      │
  │  agent-readable: YES (this IS the agent's context)        │
  └──────────────────────────────────────────────────────────┘

  ┌─ Tier 2: episodic cache (UI hydration only) ──────────────┐
  │  lib/state/insights.ts + investigations.ts (in-memory map) │
  │  contents: collected AgentEvent arrays per insightId       │
  │  lifetime: one Vercel instance / one dev session           │
  │  bounded by: nothing (LRU not implemented)                 │
  │  agent-readable: NO (UI cache, not agent input)            │
  └──────────────────────────────────────────────────────────┘

  ┌─ Tier 3: snapshot (committed) ────────────────────────────┐
  │  lib/state/demo-*.json                                     │
  │  contents: one captured live run, replayed as demo         │
  │  lifetime: git                                             │
  │  agent-readable: NO (presentation reliability, not memory) │
  └──────────────────────────────────────────────────────────┘

  ┌─ Tier 4: long-term memory ─ NOT IMPLEMENTED ──────────────┐
  │  Would need: vector store, embedding pipeline, vector_search│
  │              tool, prompt update                            │
  │  Use case: ground new investigations in past similar ones   │
  └──────────────────────────────────────────────────────────┘
```

## Interview defense

**Q: "What memory does your agent system have?"**

A: Working memory only, plus a thin per-session UI cache. The agent loop's message array is the working memory — every assistant turn and tool result accumulates within one run, bounded by `maxTurns + maxToolCalls`, gone when the run returns. The per-session cache in `lib/state/investigations.ts` is *not* agent-readable — it's a UI hydration cache for instant page loads, not a memory tier the agents themselves consult. No long-term memory, no embeddings, no cross-session recall. Every investigation starts from scratch.

The case for adding long-term memory: when "have we seen this kind of anomaly before" becomes a feature. Today every investigation is independent — adding semantic recall over past investigations would let the diagnostic agent ground its hypotheses in prior cases. The implementation would be pgvector + an embed-on-save hook + a `search_past_investigations` tool in the DiagnosticAgent's grant. The cost is real (one new dependency, one new pipeline, corpus maintenance); the win is qualitative (an analyst that remembers vs an analyst that restarts).

Diagram I'd sketch:

```
  what we have:        what we'd add:
  ┌─ working ─┐        ┌─ episodic (cross-session, agent-readable) ─┐
  │ per-run   │        │ pgvector over past investigations          │
  │ in-context│        │ retrieved by similarity to current anomaly │
  └───────────┘        └────────────────────────────────────────────┘

  ┌─ UI cache ─┐       ┌─ long-term (corpus) ─────────────────────┐
  │ per-session│       │ pgvector over Bloomreach docs + guides   │
  │ NOT agent- │       │ retrieved as reference knowledge          │
  │ readable   │       └───────────────────────────────────────────┘
  └────────────┘
```

Anchor: "the load-bearing decision isn't 'add memory' — it's 'add RAG over memory.' A write-heavy memory store with no retrieval discipline is just a log nobody reads. The agent has to be able to ask for it."

## See also

- [`01-context-engineering.md`](./01-context-engineering.md) — memory tiers determine what's available to inject into context
- [`../02-agentic-retrieval/01-agentic-rag.md`](../02-agentic-retrieval/01-agentic-rag.md) — the retrieval discipline that makes memory useful
- ai-engineering's `agent-memory` file (cross-ref) — the two-layer short/long split; this file extends it to three tiers
