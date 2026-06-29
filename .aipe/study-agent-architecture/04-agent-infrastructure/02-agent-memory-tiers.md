# Agent memory tiers

**Industry standard.** Memory as a dedicated component, separate from the context window. This repo runs **working memory only** — no episodic, no long-term.

## Zoom out, then zoom in

Sits outside the agent loop as a persistent store the agent can read from across turns and (in richer tiers) across runs. Distinct from the context window — the window is the working buffer, memory is the durable substrate.

```
  Zoom out — where this concept lives

  ┌─ Agent context ─────────────────────────────────┐
  │  ★ working memory (in-context, this run) ★      │ ← this repo
  └─────────────────────────────────────────────────┘
  ┌─ Episodic memory (recent sessions) ─────────────┐
  │  (not in this repo)                              │
  └─────────────────────────────────────────────────┘
  ┌─ Long-term memory (persistent knowledge) ────────┐
  │  (not in this repo)                              │
  └─────────────────────────────────────────────────┘
```

## Structure pass

Layers: working memory (the current run's accumulated messages) → episodic memory (summaries of past runs/conversations, retrieved by relevance) → long-term memory (durable facts, decisions, preferences, stored in a vector or graph DB).

**Axis traced — "what survives the current run?":** in this repo, nothing. The conversation ends, the messages array is garbage-collected, the next investigation starts fresh.

**Seam:** the retrieval boundary at each tier transition. Episodic memory only works if the right past summary is retrieved at the right time, which is RAG inside the agent.

## How it works

### Move 1 — the mental model

You know the difference between RAM, an SSD, and cold storage. RAM holds what you're working on right now; the SSD holds your recent files; cold storage holds the archive. Working memory is the RAM equivalent — the message buffer that lives in this run's context. Episodic memory is the SSD — summaries of recent runs, retrieved when relevant. Long-term memory is cold storage — durable facts that survive everything.

```
  The three tiers

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

### Move 2 — step by step

#### Working memory — what this repo has

The working memory IS the message accumulator from `02-agent-loop-skeleton.md` — the `messages = [{ role: 'user', content: userPrompt }]` array in `run-agent-loop.js:22`. Every turn appends; the next `model.complete` reads the full array.

The lifecycle: created when `runAgentLoop` is called, lives in JavaScript memory for the duration of that one call (~50-120s for a typical investigation), garbage-collected when the function returns. The route handler's final `controller.close()` ends the stream, the closure capturing the messages array dereferences, the memory is freed.

That's it. There's no flush-to-disk, no save-to-store, no "your last 5 investigations are available." The next time the diagnostic agent runs (whether it's a new investigation or the same anomaly investigated again), it starts with an empty messages array and re-derives everything from scratch.

#### What the 60s tool-call cache IS and ISN'T

`BloomreachDataSource` (`lib/data-source/bloomreach-data-source.ts:122-188`) keeps a 60-second TTL cache keyed by `name:JSON.stringify(args)`. This looks like memory but isn't memory in the agent-memory sense — it's a *tool-result cache* scoped to the data source, not an *agent context* store.

The difference matters. The cache helps when the same agent run (or two concurrent runs) issues the same EQL query — the second issuance returns the cached result instead of re-calling MCP. That's a performance/cost optimization. It doesn't help the agent *remember* what it found — the agent's messages array is still empty at the start of each new run; only the underlying tool results happen to be cached for a minute.

Concretely: two diagnostic investigations of the same anomaly run a minute apart would each construct fresh agent contexts (new messages arrays, new ReAct loops). The model would re-derive the diagnosis from scratch. But the tool calls those investigations make would hit the data-source cache, saving the MCP round-trip cost. The cache lives at the wrong layer to be "memory."

#### Episodic memory — what this repo doesn't have

The episodic version would store a structured summary of each completed investigation:

```ts
// hypothetical lib/memory/episodic.ts (not implemented)
interface EpisodicMemory {
  insightId: string;
  anomaly: Anomaly;
  diagnosis: Diagnosis;
  recommendations: Recommendation[];
  summary: string;  // model-generated tldr
  embedding: number[];  // for similarity search
  createdAt: string;
}
```

When a new diagnostic investigation starts, the agent (or a wrapper around it) would embed the anomaly's metric + scope + change shape, retrieve the top-3 most similar past episodic entries, and prepend their summaries to the agent's system prompt as "you've investigated similar anomalies before — here's what they found."

The win: the model says "this looks like the post-Black-Friday revenue dip we saw 4 weeks ago — the cause was X" instead of re-deriving from scratch. The cost: the vector store dependency the architecture has avoided, plus the embedding pipeline + retention/cleanup policy.

#### Long-term memory — what this repo really doesn't have

The long-term version is the agent's accumulated knowledge that survives across all runs, all users, all time. Customer preferences ("this user wants detailed evidence"), system facts ("the team's revenue threshold for an anomaly is 10%"), learned playbooks ("when this category fires, always check the funnel breakdown first").

For this product, long-term memory would be useful for cross-user personalization (each marketer/analyst gets diagnoses tuned to their attention) or cross-time learning (the system gets better at finding causes after seeing many similar anomalies). Neither is on the roadmap. The closest current substitute is the AptKit category definitions — they're hard-coded preferences about which anomaly types to scan and how (`@aptkit/agent-anomaly-monitoring/.../categories.js`), shipped as code rather than learned per-user.

#### The retrieval problem is the load-bearing one

For episodic and long-term memory, the *storage* is straightforward (vector DB or graph DB; pick one). The hard part is retrieval — the right past summary has to come back at the right time, with the right context. That's RAG inside the agent: embed the current task, search the memory store, pick the top-k, place them in the agent's context.

The retrieval problem inherits all of `02-agentic-retrieval/`'s patterns — agentic RAG (the agent decides to query memory mid-loop), self-corrective RAG (grade the memory chunks for relevance before trusting them), retrieval routing (pick which memory tier to query). Adding memory means adding a retrieval substrate, which means adding agentic-RAG complexity. The "tier" framing makes it look like a storage decision; the implementation is mostly a retrieval decision.

### Move 3 — the principle

**Memory is a tiered storage decision dressed as an architecture decision.** Working memory is mandatory (you can't have a multi-turn loop without an accumulator). Episodic and long-term memory are escalations that earn their cost when cross-run reuse is real. For this product (one-off investigations, no cross-user personalization, no learned playbooks), working-memory-only is the right call. The escalation point: when users start noticing the agent re-derives the same conclusions across similar anomalies, episodic memory pays for itself. When users want personalization, long-term memory does.

## Primary diagram

```
  Memory tiers in this repo (only the first is live)

  ┌─ Working memory (LIVE) ───────────────────────────────────────┐
  │  messages: Anthropic.MessageParam[]                           │
  │   - lives in runAgentLoop closure                             │
  │   - grows turn by turn (assistant + user/tool_result blocks)  │
  │   - garbage-collected when the loop returns                   │
  │   - capped indirectly via maxTurns (8) and per-turn maxTokens │
  │  Anchor: run-agent-loop.js:22, run-agent-loop.js:48,104       │
  └───────────────────────────────────────────────────────────────┘

  ┌─ Episodic memory (NOT IN REPO — what it would look like) ─────┐
  │  vector store of past completed investigations                 │
  │   - per-investigation summary + diagnosis + recommendations    │
  │   - embedded for similarity search                             │
  │   - retrieved at start of new investigation: top-3 similar     │
  │     past entries prepended to system prompt                    │
  │  Anchor: hypothetical lib/memory/episodic.ts                   │
  └───────────────────────────────────────────────────────────────┘

  ┌─ Long-term memory (NOT IN REPO — what it would look like) ────┐
  │  durable knowledge store (vector or graph)                     │
  │   - per-user preferences (verbosity, focus areas)              │
  │   - learned playbooks (which queries answered past anomalies)  │
  │   - system facts (custom thresholds, business definitions)     │
  │  Anchor: hypothetical lib/memory/longterm.ts                   │
  └───────────────────────────────────────────────────────────────┘

  Note: BloomreachDataSource's 60s tool-call cache is NOT memory —
  it's a data-source-layer cache that helps with repeat tool calls
  within ~1 minute. The agent's context starts empty on every run.
```

## Elaborate

The three-tier model is the standard agent-memory taxonomy in production systems (LangChain's `ConversationBufferMemory` / `ConversationSummaryMemory` / vector-store retrieval roughly maps to the three tiers; LangGraph's checkpointing is closer to working + episodic; CrewAI's `EntityMemory` is the long-term equivalent). The cross-framework convergence on this taxonomy is meaningful — the same problem keeps producing the same answer.

The two-layer split (working + long-term) you sometimes see in older agent literature is a simplification that elides episodic. The episodic tier matters specifically when "remembering recent sessions" is a different problem from "remembering durable facts" — for chat agents (each conversation is one session you want to recall in context across messages) and for personal assistants (last week's preferences matter more than last year's). For task agents like this repo (each investigation is one-off, no within-conversation memory across turns at the user-facing level), episodic is the tier that would matter first.

The retention/cleanup policy is the unsexy but critical part of any memory implementation. Working memory cleans itself up automatically (garbage collection). Episodic memory needs a TTL or a size cap to prevent unbounded growth. Long-term memory needs a relevance-based eviction policy (drop facts the model has never retrieved). Forgetting to design retention is how memory implementations turn into unbounded vector stores nobody cleans up.

## Interview defense

> **Q: How does this codebase handle memory?**
>
> Working memory only. Every agent run's context is the messages array inside `runAgentLoop` — created at the start of the call, grown turn by turn with assistant responses and tool results, garbage-collected when the loop returns. There's no episodic store (no "recent investigations summary"), no long-term store (no user preferences, no learned playbooks). The 60s tool-call cache in `BloomreachDataSource` looks like memory but isn't agent memory — it's a data-source-layer cache that helps with repeat tool calls within ~1 minute. The agent's context starts empty on every new run regardless of the cache.

> **Q: Why no episodic memory?**
>
> Two reasons. The architecture intentionally avoids a vector store dependency — adding episodic memory means adding the vector pipeline. And the use case hasn't surfaced as a measured problem yet. If users started reporting "the agent re-derives the same conclusions across similar anomalies every time," that's the signal to add episodic memory — embed past `Diagnosis` outputs, retrieve top-3 similar past investigations at the start of a new one, prepend their summaries to the agent's system prompt. The implementation cost is moderate (one vector store + one retrieval call); the win compounds over time as the corpus of past investigations grows.

> **Q: What's the retrieval problem that makes memory hard?**
>
> Storage is easy — vector DB or graph DB, pick one. The hard part is the right past summary coming back at the right time. That's RAG inside the agent — embed the current task, search the memory store, pick the top-k, place them in the context. Adding memory inherits every problem from agentic retrieval — the chunks might be irrelevant (need self-corrective RAG), the right memory tier might not be obvious (need retrieval routing), the agent might re-derive instead of trusting the memory (need prompt-level instruction about how to use memory). The framing "memory is storage" hides that the implementation is mostly a retrieval problem.

## See also

- → `01-context-engineering.md` — working memory IS the context engineering boundary for one run
- → `02-agentic-retrieval/01-agentic-rag.md` — what retrieving from episodic / long-term memory looks like
- → `02-agentic-retrieval/03-retrieval-routing.md` — how an agent picks which memory tier to query
- → cross-reference (when generated): `study-ai-engineering`'s agent-memory file — the two-layer short/long split this file extends
