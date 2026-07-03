# Agent memory tiers

*Industry names: agent memory tiers / short-term-vs-long-term memory · Industry standard*

## Zoom out

```
  Zoom out — memory as a component, not just "big context window"

  ┌─ context engineering (superset) ──────────────┐
  │  ★ MEMORY TIERS ★                              │ ← we are here
  │    working (in-context)                        │
  │    episodic (recent sessions)                  │
  │    long-term (persistent knowledge)            │
  └───────────────────────────────────────────────┘
```

## Zoom in

Memory is a dedicated component, separate from the context window. Three tiers: **working** (the current task's context — lives in the window), **episodic** (summaries of past runs, retrieved by relevance), **long-term** (durable facts, decisions, preferences, stored in a vector DB or graph). This repo uses working memory only; episodic and long-term are not yet implemented. Cross-refs `.aipe/study-ai-engineering/`'s agent-memory file for the two-layer split; this file extends to three tiers plus the cross-session retrieval problem.

## Structure pass

Layers: **working** (fastest, smallest, transient) — **episodic** (medium, session-scoped summaries) — **long-term** (slowest, largest, durable).

Axis to hold constant: **what happens when the task ends?**

```
  What survives task end — the axis that flips per tier

  Working memory:    gone (window discarded)
  Episodic memory:   summary persists per session
  Long-term memory:  durable across all sessions
```

## How it works

### Move 1 — the shape

You've reasoned about storage tiers before — CPU cache vs RAM vs disk. Same instinct. Working memory is the register, episodic is RAM, long-term is disk. Each tier trades speed for capacity + durability.

```
  Three tiers — capacity, cost, durability trade

  ┌─ Working (in-context) ─────────────────────────┐
  │  The current task's context. Lives in the      │
  │  window. Gone when the run ends.               │
  │  ~50k tokens, cost = per-turn input tokens     │
  └────────────────────────────────────────────────┘
  ┌─ Episodic (recent sessions) ───────────────────┐
  │  Summaries of past runs/conversations.          │
  │  Retrieved by relevance to the current task.    │
  │  ~KB per session, cost = one summary call +    │
  │  one retrieval per session                      │
  └────────────────────────────────────────────────┘
  ┌─ Long-term (persistent knowledge) ─────────────┐
  │  Durable facts, decisions, preferences. Stored │
  │  in a vector DB / graph. Unbounded.             │
  │  MB-GB, cost = embed + store + retrieve         │
  └────────────────────────────────────────────────┘
```

### Move 2 — what this repo has today, and what would come next

**Today: working memory only.**

Each agent run has one context — the aptkit `ModelMessage[]` accumulated across turns of the ReAct loop. When the run ends (Diagnosis emitted, budget exhausted, or cancelled), the context is discarded. Nothing survives between investigations.

That's a deliberate scope decision. The product's unit of work is one investigation — start with an anomaly, end with recommendations. Cross-investigation state ("what did we conclude last week about the same metric?") isn't in the current product design.

The one thing that DOES cross investigation boundaries: the **committed demo snapshot** (`lib/state/demo-insights.json`). But that's not agent memory — it's a captured trajectory replayed for the demo/reliability path. Different concern.

**Where episodic memory would fit.** A useful escalation would be "the diagnostic agent recognizes it's investigating the same anomaly for the third time this week and short-circuits." Requires:

```
  Episodic memory — the hypothetical addition

  ┌── new: EpisodicStore ────────────────────────┐
  │  On investigation done, emit summary:         │
  │    {                                          │
  │      timestamp,                               │
  │      anomaly: { metric, scope, change },      │
  │      diagnosis: { conclusion, evidence },     │
  │      recommendations: [...],                  │
  │      outcome: 'applied' | 'ignored' | null    │
  │    }                                          │
  │  Store in Postgres or KV                      │
  └───────────────┬───────────────────────────────┘
                  │
                  ▼
  On new investigation start:
    - retrieve top-K similar past investigations
    - prepend "Prior investigation of this metric: ..."
      to the DiagnosticAgent's context
```

Would need a durable store (this repo has none today — no database), an embedding model for similarity, and a retrieval step. The pattern is essentially agentic RAG (`02-agentic-retrieval/01-agentic-rag.md`) over an internal history.

**Where long-term memory would fit.** Longer-term facts about the workspace: "This workspace's revenue drops on the third Friday every month due to a known payment provider maintenance window." Not something a single investigation would learn — something that persists across many.

Long-term memory is where the "retrieval problem" gets sharp: the memory only works if the *right thing* is retrieved at the *right time*. That's RAG inside the agent. Cross-refs `.aipe/study-ai-engineering/`'s memory file for the two-layer split; the three-tier model here adds the intermediate episodic layer.

**The reason NOT to add these tiers preemptively.**

- **Cost.** Every episodic/long-term retrieval is another turn of the loop, another tool call, more tokens. If the current investigation doesn't need cross-session context to be good, adding memory is complexity + cost with no quality gain.
- **Poison risk.** Bad memory poisons future retrievals. A misclassified past diagnosis gets retrieved as "similar to this one" and biases the current run. Requires memory hygiene: confidence tracking, staleness, retrieval quality checks.
- **Product-shape mismatch.** The user's mental model is "one anomaly, one investigation." Silently pulling in past investigations changes what the answer means — and if the user can't see what past context was used, trust drops.

**When memory would be worth it.** When cross-investigation patterns are load-bearing to the answer quality — e.g., a workspace with strong seasonality where each investigation should reference prior similar ones. Not there yet.

### Move 2.5 — the bridge to storage layering

The three-tier memory model maps to a storage-layering discipline the reader has already built in other projects: canonical local + retrieved context. Working memory is the "current view"; episodic is "recent local state"; long-term is "durable canonical." Same instinct at higher altitude. The load-bearing part is deciding which tier a given piece of information should live in — trying to store everything in long-term makes retrieval slower; storing everything in working blows the window. Tier assignment is the actual design work.

### Move 3 — the principle

Memory tiers separate speed from durability. Working memory is fast and transient; long-term is durable and slow. Episodic is the middle. The retrieval problem is the load-bearing one — long-term memory only works if the *right thing* is retrieved at the *right time*. That's why cross-session memory is really "RAG inside the agent" — same mechanics as any other retrieval, applied to the agent's own history.

## Primary diagram

```
  Memory tiers — what this repo has and what's next

  ┌─ Working memory (SHIPPED) ────────────────────────────┐
  │  aptkit ModelMessage[] per agent per run              │
  │  ~50k tokens                                          │
  │  gone when run ends                                    │
  │  cost: per-turn input tokens                           │
  └────────────────────────────────────────────────────────┘

  ┌─ Episodic memory (not yet) ───────────────────────────┐
  │  would be: EpisodicStore                              │
  │    schema: { anomaly, diagnosis, recommendations,     │
  │              timestamp, outcome }                     │
  │    retrieval: embed anomaly, top-K similar past runs  │
  │    injection: prepend "Prior similar: ..." to context │
  │  cost: summary call + retrieval + embed               │
  │  when: cross-investigation patterns matter            │
  └────────────────────────────────────────────────────────┘

  ┌─ Long-term memory (not yet) ──────────────────────────┐
  │  would be: durable workspace facts                    │
  │    "revenue dips 3rd Friday due to payment window"    │
  │    "TX customers churn on price sensitivity"          │
  │  store: vector DB / graph                              │
  │  retrieval: RAG over the fact store                    │
  │  cost: embed + store + retrieve + memory hygiene       │
  │  when: workspace-level patterns are load-bearing       │
  └────────────────────────────────────────────────────────┘

  The retrieval problem is the load-bearing one —
  long-term only works if the right thing is retrieved
  at the right time. That's RAG inside the agent.
```

## Elaborate

The tiered-memory model for LLM agents crystallized around 2024. MemGPT (Packer et al., 2023) introduced hierarchical memory as a first-class concept; ChatGPT's "memory" feature (2024) productionized long-term memory for a consumer product; frameworks like LangChain's `Memory` and LlamaIndex's `Memory` interfaces standardized the API surface.

The frontier is **learned memory hygiene** — memory that self-cleans (staleness detection, confidence decay, conflict resolution when new observations contradict stored facts). This is where the memory problem becomes agent-shaped — the agent itself has to reason about what to remember, forget, and retrieve. See Reflexion (Shinn et al., 2023) for the earliest production of "agent maintaining its own memory."

## Interview defense

**Q: Do you have long-term memory?**

Not yet. Today the repo has working memory only — aptkit's `ModelMessage[]` per agent per run, discarded when the run ends. Deliberate scope choice: the product's unit of work is one investigation. Cross-investigation state isn't in the current design.

Where I'd add it: episodic first, if I noticed the diagnostic agent redoing the same investigation for a recurring anomaly. The pattern would be an EpisodicStore (Postgres), embed the current anomaly, retrieve top-K similar past investigations, prepend them to context. Long-term (workspace facts) only makes sense after episodic proves useful.

The reason I don't have it: cost + poison risk. Every retrieval is another turn; bad memory poisons future runs. Adding memory before the product needs it is complexity for no gain.

*Anchor visual:* the three-tier diagram above.

**Q: What's the hardest part of long-term memory?**

Retrieval. Storing is trivial (write to a vector DB). Retrieving the *right* fact at the *right* moment is the whole problem — same as any RAG system, just applied to the agent's own history instead of external documents. That's why "agent memory" is really "agentic RAG over an internal store" — the mechanics are the same.

The second-hardest part is memory hygiene — staleness, confidence decay, conflict resolution when observations contradict stored facts. A stored fact "Texas customers churn on price sensitivity" that becomes obsolete needs to be flagged, not silently retrieved into a new investigation.

## See also

- **`01-context-engineering.md`** — memory is one source context engineering pulls from.
- **`02-agentic-retrieval/01-agentic-rag.md`** — memory retrieval IS agentic RAG.
- **`.aipe/study-ai-engineering/`** agent-memory file — the two-layer short/long split.
