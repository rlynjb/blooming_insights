# 05 — agent memory

**Subtitle:** Short-term (in-context) vs long-term (retrieved) · Industry standard (partial)

## Zoom out, then zoom in

blooming insights has only **short-term** memory — the per-turn
conversation history that AptKit's agent loop maintains. **Long-term**
memory (across sessions, retrieved from a corpus) would land in
`03-retrieval-and-rag/11-rag.md`-style RAG over past investigations.

```
  Zoom out — two memory layers

  ┌─ Short-term: in-context conversation ─────────────────┐  ← we have this
  │  per agent loop: messages[] grows each turn           │
  │  disappears when the agent.investigate() returns      │
  └────────────────────────────────────────────────────────┘

  ┌─ Long-term: retrieved from corpus (Case B) ───────────┐  ← we don't
  │  past investigations stored on disk                   │
  │  retrieved per query and stuffed into context         │
  │  (would need vector store + embed step)               │
  └────────────────────────────────────────────────────────┘
```

## Structure pass

  → **One axis to trace — persistence boundary.** Short-term memory is
    bounded by one `agent.investigate()` call; it dies when the call
    returns. Long-term memory is bounded by your retention policy and
    must be retrieved-into-context per use.

## How it works

### Move 1 — the mental model

The model is stateless. "Memory" is something *you* hold and present to
the model each turn. Two scopes:

```
  Short-term: bounded by one agent call
  ┌────────────────────────────────────────────────┐
  │  messages = [                                  │
  │    {role: 'user', content: 'the anomaly'},     │
  │    {role: 'assistant', content: [thought,      │
  │                                  tool_use]},   │
  │    {role: 'user', content: [tool_result]},     │
  │    … grows each turn …                         │
  │  ]                                             │
  │  ↑ this IS the memory; AptKit holds it         │
  │  ↓ disappears when investigate() returns        │
  └────────────────────────────────────────────────┘

  Long-term: bounded by retention + corpus
  ┌────────────────────────────────────────────────┐
  │  vectorStore.cosineSearch(currentQuery, top=3) │
  │  → 3 past investigations                       │
  │  → prepend to next prompt as "previous similar"│
  │  ↑ retrieved fresh per agent call              │
  └────────────────────────────────────────────────┘
```

### Move 2 — the step-by-step walkthrough

**Short-term memory IS the messages array.** Every turn of AptKit's loop
appends to `messages[]`: the model's output becomes the next turn's
input. By turn 6 of a diagnostic loop, `messages` contains:

  - Turn 1 user message: the initial prompt + anomaly context.
  - Turn 1 assistant: thought + tool_use 1.
  - Turn 2 user: tool_result 1.
  - Turn 2 assistant: thought + tool_use 2.
  - ... continuing through turn 6 ...
  - Turn 6 assistant: final text (the JSON output).

This is all the "memory" the model has. AptKit doesn't trim, summarize,
or compress — it ships the full history every turn. See
`02-context-and-prompts/01-context-window.md` for the token budget
implications (typically <10% of the window).

**The bound is the agent call.** When `diagAgent.investigate(anomaly)`
returns, the AptKit instance is garbage-collected; the `messages` array
is gone. The next investigation starts from an empty history. There's
no cross-investigation continuity.

**What's saved long-term (but not used as memory).** Per investigation,
the route handler saves the full event tape via `saveInvestigation` in
`lib/state/investigations.ts`. This is for *demo replay*, not for
*future agent context*. The agent doesn't read past investigations
during a fresh run.

**Where long-term memory WOULD land.** The Case B refactor outlined in
`03-retrieval-and-rag/11-rag.md`:

  1. On each investigation save, embed the diagnosis text.
  2. On each new investigation, query the vector store for top-3 similar
     past investigations.
  3. Pass them to the diagnostic agent as a `priorContext` block.

The agent then "remembers" — not via in-context history (which still
resets per call), but via retrieved-into-context (which is fresh per
call but draws from the persistent corpus). That's the long-term memory
pattern.

**The conversation memory in QueryBox.** The free-form `QueryAgent`
doesn't keep history across user queries either. Each `?q=...` request
to `/api/agent` starts a fresh QueryAgent with empty history. If the
user asks a follow-up like "what about last month?", the agent has no
idea what "last month" refers to. Long-term memory at this layer would
mean session-scoped history (keep the last N user/assistant turns
across requests) — not implemented today.

### Move 3 — the principle

**Short-term memory is free (you already have the messages array).
Long-term memory costs you a corpus, an index, and a retrieve step per
call. Add long-term only when "the agent forgot what we already
discussed" is a real complaint.** For one-shot investigations,
short-term is enough. For multi-turn user conversation, long-term
becomes the move.

## Primary diagram

```
  Memory layers in this codebase

  ┌─ /api/agent (one investigation) ───────────────────┐
  │                                                    │
  │  short-term memory (AptKit holds): messages[]      │  ← ACTIVE
  │    grows turn 1 → turn 6                            │
  │    disappears when investigate() returns           │
  │                                                    │
  │  long-term memory (RAG): not exercised             │  ← Case B
  │    would: vectorStore.cosineSearch(anomaly)        │
  │    pass top-3 past diagnoses as priorContext       │
  │                                                    │
  └────────────────────────────────────────────────────┘

  Across investigations TODAY:
    nothing is remembered.
    each /api/agent call starts fresh.
    the demo snapshot is for replay, not agent context.
```

## Elaborate

The short-term-only design is appropriate for one-shot investigations
where each anomaly is independent. The lack of long-term memory becomes
a real product limitation only when:

  → The same anomaly recurs and the user wants the agent to remember
    "we saw this before and the resolution was X."
  → The user has follow-up questions in QueryBox that depend on prior
    turns.
  → The agent should learn from corrected diagnoses (when the user
    says "actually it was checkout, not pricing," the agent should
    remember for next time).

Each of these is a separate enhancement. The diagnosis-recurrence case
is the strongest fit for RAG over past investigations. The QueryBox
follow-up case is best solved with session-scoped conversation memory
(keep last N turns per session). The learning-from-corrections case is
the hardest — it's essentially feedback-driven prompt evolution or
fine-tuning, neither cheap nor obvious.

For the current product surface (one-shot investigation per anomaly),
short-term memory is sufficient. The exercises name the lift paths.

## Project exercises

### Exercise — add session-scoped conversation memory to QueryAgent

  → **Exercise ID:** `study-ai-eng-04-05.1`
  → **What to build:** Add a `conversationId` (cookie- or URL-scoped)
    that lets QueryAgent retain the last N user/assistant turns across
    requests. Store in `sessionStorage` on the client and pass to
    `/api/agent?q=...&conversationId=...`. Server merges history into
    the prompt.
  → **Why it earns its place:** Unlocks "what about last month?"
    follow-ups. Today every query is one-shot.
  → **Files to touch:** `app/api/agent/route.ts` (read conversationId,
    fetch+save history), new `lib/state/conversations.ts`,
    `lib/agents/query.ts` (accept history), `components/chat/QueryBox.tsx`
    (manage conversationId).
  → **Done when:** Asking "what's our purchase trend?" then "what about
    mobile only?" — the second query understands "purchase trend on
    mobile."
  → **Estimated effort:** `1–2 days`

### Exercise — diagnosis grounding via RAG (long-term memory)

  → **Exercise ID:** `study-ai-eng-04-05.2`
  → **What to build:** Same as `03-retrieval-and-rag/11-rag.md` exercise
    1: wire embeddings + vector store + retrieve-on-diagnose. The agent
    gains long-term memory of past investigations via retrieved
    `priorContext`.
  → **Why it earns its place:** Cross-references the RAG section; lands
    long-term memory of the same shape as production multi-agent
    systems.
  → **Files to touch:** Same as `03-retrieval-and-rag/11-rag.md`
    exercise 1.
  → **Done when:** Same as that exercise.
  → **Estimated effort:** `≥1 week`

## Interview defense

**Q: Does this codebase have agent memory?**

Short-term only. Each `agent.investigate()` call has its own
`messages[]` history that grows turn-by-turn; when the call returns,
it's gone. There's no long-term memory across investigations or across
QueryBox conversations.

```
  short-term: messages[] within one agent.investigate() call
              free, automatic, bounded by one call

  long-term:  retrieve past investigations as priorContext
              Case B — not implemented; the exercise wires it
```

**Anchor line:** "Short-term is free; long-term costs a corpus + an
embedding step. We don't pay yet because one-shot investigations don't
need it."

**Q: When would long-term memory become urgent?**

Three triggers, in priority order:

  1. Diagnosis recurrence: "we saw this exact anomaly last week and the
     fix was X" — the agent should remember.
  2. QueryBox follow-ups: "what about mobile?" should understand the
     prior query's context.
  3. Correction learning: when a user fixes an LLM-generated wrong
     diagnosis, the agent should not repeat the mistake.

For #1 and #2, RAG over investigations + session-scoped conversation
history covers it. For #3, you're into fine-tuning or prompt-evolution
territory — much harder, not on the near-term roadmap.

## See also

  → `02-context-and-prompts/01-context-window.md` — the budget short-term
    memory lives in
  → `03-retrieval-and-rag/11-rag.md` — the long-term refactor
