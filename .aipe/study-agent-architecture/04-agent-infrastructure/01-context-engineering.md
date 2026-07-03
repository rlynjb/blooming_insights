# Context engineering

*Industry name: context engineering · Industry standard*

## Zoom out

```
  Zoom out — context engineering is the discipline everything else nests in

  ┌─ prompt engineering ────────────────────────┐
  │  the words in the prompt                     │
  └─────────────────────────────────────────────┘
              ⊂
  ┌─ RAG ───────────────────────────────────────┐
  │  what gets retrieved                         │
  └─────────────────────────────────────────────┘
              ⊂
  ┌─ ★ CONTEXT ENGINEERING (superset) ★ ────────┐ ← we are here
  │  EVERYTHING the model sees at inference time │
  └─────────────────────────────────────────────┘
```

## Zoom in

Prompt engineering + RAG + agent memory + tool outputs + conversation history + user profile — all of it lives inside "the context window at inference time." **Context engineering** is the discipline of deciding what fills that window for the next step, and — in a multi-agent system — which agent sees what. Prompt engineering gets the first good output; context engineering keeps the thousandth good.

## Structure pass

Layers: **the window** (finite space) — **what goes in** (choice of contents) — **what stays out** (curation) — **who sees what** (per-agent scoping in multi-agent).

Axis to hold constant: **what does this specific model call SEE this turn?**

```
  The window's contents — the axis worth mapping

  system prompt         → the role definition
  tool descriptions     → the available tools
  conversation history  → what happened before
  retrieved chunks      → knowledge fetched this turn
  user profile          → who's asking
  memory summaries      → what happened across sessions
  tool outputs          → what the last tool call returned
  → all packed into ONE window with a hard token limit
```

## How it works

### Move 1 — the shape

You've squeezed data into a React state object with a size budget before — deciding what stays, what gets summarized, what gets dropped. Same instinct, higher stakes: the window is the model's entire consciousness for this turn.

```
  Context engineering — everything the model sees

  ┌───────────────────────────────────────────────┐
  │            Context engineering                 │
  │  (everything the model sees at inference time) │
  │                                                │
  │   ┌─────────────┐  ┌─────────────┐             │
  │   │   prompt    │  │     RAG     │             │
  │   │ engineering │  │ (retrieval) │             │
  │   └─────────────┘  └─────────────┘             │
  │   ┌─────────────┐  ┌─────────────┐             │
  │   │   memory    │  │ tool outputs│             │
  │   └─────────────┘  └─────────────┘             │
  │   ┌─────────────┐  ┌─────────────┐             │
  │   │ history      │  │ user profile│             │
  │   └─────────────┘  └─────────────┘             │
  └───────────────────────────────────────────────┘
```

### Move 2 — how context is curated in this repo

**The system prompt is stable and cached.** Every agent role has a system prompt shipped inside aptkit (each agent's own prompt file). The prompt is wrapped in `cache_control: 'ephemeral'` in `lib/agents/aptkit-adapters.ts`:

```ts
// lib/agents/aptkit-adapters.ts — the ephemeral cache breakpoint
// Phase-3 prompt caching. The system prompt is stable across every call
// within an investigation (all ~5-15 ReAct-loop iterations reuse it) and
// is the largest fixed prefix in the payload.
```

The observed effect: first call is a cache_creation (~1.25× normal input cost), every subsequent call within 5 minutes is a cache_read (~0.1× normal). Live logs show 3168-token cache_read hits. That's context engineering as a *cost* discipline — the stable prefix is deliberately stable so the provider can cache it. This is covered mechanically in `05-production-serving/01-cross-turn-caching.md`.

**Schema summary, not full schema.** The `WorkspaceSchema` for the ecommerce workspace is ~112KB of raw data (events, properties, catalogs, customer properties, timestamps). That would blow the window and drown the model in noise. `schemaSummary()` in `lib/agents/monitoring.ts:26-59` produces a compact, token-bounded projection:

```ts
// lib/agents/monitoring.ts (schema summary — context curation in action)
const MAX_EVENTS = 20;
const MAX_PROPS_PER_EVENT = 10;
const eventsText = schema.events
  .slice(0, MAX_EVENTS)
  .map((e) => {
    const props = e.properties.slice(0, MAX_PROPS_PER_EVENT).join(', ');
    return `  - ${e.name} (${e.eventCount}): ${props || '(no properties)'}`;
  })
  .join('\n');
```

Top 20 events, 10 properties each, top 30 customer properties. Everything else is dropped. The signal-to-noise ratio in the model's window is dramatically higher than "just paste the whole schema." This is the load-bearing move: shape the context so the model sees what it needs, not what's available.

**Per-agent context routing.** Each worker sees only what its role needs — not the free-form Q&A history, not other workers' traces, not tool results from a previous investigation. The route curates:

```
  Per-agent context routing

  MonitoringAgent      sees: schema summary + category list
                       NOT:  free-form queries, prior diagnoses

  DiagnosticAgent      sees: schema summary + one Anomaly
                       NOT:  monitoring's full trace, prior recommendations

  RecommendationAgent  sees: schema summary + one Anomaly + one Diagnosis
                       NOT:  diagnostic's full trace (only its output)

  QueryAgent           sees: schema summary + user query + intent
                       NOT:  investigation traces
```

This is `03-multi-agent-orchestration/08-shared-state-and-message-passing.md` in action — the coordination layer is message passing, and each message is context-curated.

**Where context bloat WOULD kick in.** If the pipeline grew a fifth stage that needed the diagnostic's full ReAct trace (not just the final Diagnosis), you'd have to decide: pass the full trace (context bloat, lost-in-the-middle risk) or summarize it (extra summarization pass, potentially lossy). The current shape avoids this by making the Diagnosis structured enough that recommendation doesn't need the trace.

**The three levers context engineering controls.**

```
  Context engineering — the three levers

  1. WHAT enters the window
     → schema summary, not full schema
     → structured Diagnosis, not full trace

  2. HOW the entered content is ordered
     → stable prefix first (cacheable)
     → user's turn last (fresh)
     → tool_result blocks in message order (aptkit)

  3. WHAT stays across turns
     → aptkit message history (conversation)
     → cache_control on system prompt (persists 5min)
     → BudgetTracker (persists across agents)
```

Every one of these has a specific implementation in this repo. Context engineering is not "prompt tuning" — it's the whole discipline of curating what the model sees at every step.

### Move 3 — the principle

Most agent failures are not model failures — they are **context failures**: stale retrieval, lost-in-the-middle on a bloated context, no user state loaded, the wrong tool outputs in the window. Bigger context windows do not solve this — they make room for more noise. The job is curating what fills the window for the next step, and in a multi-agent system, which agent sees what.

## Primary diagram

```
  Context engineering — the levers and where each lives in this repo

  ┌─ WHAT enters the window ──────────────────────────────────────┐
  │                                                                │
  │  ┌─ system prompt (aptkit per role) ─────────────────┐         │
  │  │  cache_control:'ephemeral' → 3168-token cache hits │         │
  │  └─────────────────────────────────────────────────── ┘         │
  │  ┌─ schema summary (lib/agents/monitoring.ts:26) ────┐         │
  │  │  top 20 events, 10 props each, 30 customer props  │         │
  │  │  ~2KB vs 112KB raw                                │         │
  │  └─────────────────────────────────────────────────── ┘         │
  │  ┌─ tool descriptions ───────────────────────────────┐         │
  │  │  from listTools; ~12 MCP tools                    │         │
  │  └─────────────────────────────────────────────────── ┘         │
  │  ┌─ role-specific payload ───────────────────────────┐         │
  │  │  Anomaly, or Anomaly+Diagnosis, or query+intent   │         │
  │  └─────────────────────────────────────────────────── ┘         │
  │                                                                │
  └────────────────────────────────────────────────────────────────┘
                          ▼
  ┌─ HOW it's ordered ─────────────────────────────────────────────┐
  │  system prompt (cached) → tool defs → conversation → user turn │
  └────────────────────────────────────────────────────────────────┘
                          ▼
  ┌─ WHAT stays across turns ──────────────────────────────────────┐
  │  aptkit message history (accumulate) — see agent loop skeleton │
  │  cache_control 5min TTL (provider-side)                        │
  │  BudgetTracker (shared across agents)                          │
  └────────────────────────────────────────────────────────────────┘
```

## Elaborate

The term "context engineering" was coined around 2024 by practitioners noticing that "prompt engineering" was too narrow — the prompt is one input, but the full context window has many. Simon Willison, Andrej Karpathy, and the LangChain team all popularized the framing that "prompt engineering" is a subset of "context engineering."

The frontier is **automated context curation** — a small model (or a heuristic layer) that shapes the context for each agent turn, dropping irrelevant history and pulling in relevant memory. LangChain's `MessagesPlaceholder` + trim strategy, LlamaIndex's `ContextChatEngine`, and Anthropic's own extended thinking with context caching all point in this direction. This repo does it manually via curated route-level routing; automated curation is the next frontier.

## Interview defense

**Q: What's the difference between prompt engineering and context engineering?**

Prompt engineering is the words in the prompt. Context engineering is everything the model sees at inference time — prompt, retrieved chunks, tool outputs, memory, history, user profile. The prompt is one input; context is the full window.

Most agent failures I see are context failures, not prompt failures. Stale retrieval, lost-in-the-middle on a bloated context, wrong tool outputs in the window. Bigger context windows don't fix this — they make room for more noise. Context engineering is the discipline of deciding what fills the window for the next step.

In this repo: schema summary (not full schema), per-agent context routing (each worker sees only what its role needs), stable prefix for prompt caching, structured Diagnosis handoff (not full trace). Each is a specific context engineering decision.

*Anchor visual:* the WHAT / HOW / WHAT-stays diagram above.

**Q: What breaks when context engineering is wrong?**

Two shapes. First, model output degrades — it misses information buried in a bloated window (lost-in-the-middle). Second, cost balloons — every unnecessary token is per-call spend, and in a multi-turn loop it compounds. The `schemaSummary()` in `lib/agents/monitoring.ts` is the specific mitigation: 2KB projection instead of the 112KB raw workspace schema. Same signal, 50x cheaper per turn.

## See also

- **`02-agent-memory-tiers.md`** — memory is one of the sources context engineering pulls from.
- **`03-multi-agent-orchestration/08-shared-state-and-message-passing.md`** — context routing is per-agent message passing.
- **`05-production-serving/01-cross-turn-caching.md`** — the cache mechanism that makes stable prefixes cheap.
- **`.aipe/study-ai-engineering/`** — context window mechanics and lost-in-the-middle.
- **`.aipe/study-prompt-engineering/`** — the prompt subset of context engineering.
