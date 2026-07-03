# Agent memory

## Subtitle

Short-term (in-context) + long-term (retrieved) memory — Industry standard.

## Zoom out, then zoom in

blooming's agents have **short-term memory** — the accumulated messages in the current agent loop — and no long-term memory. Once an investigation finishes, its diagnosis is saved (`lib/state/investigations.ts`) but the *next* investigation doesn't retrieve it. That's a live limitation and a named future feature (see the retrieval sub-section).

```
  Zoom out — two memory layers

  ┌─ Short-term (in-context) ─── LIVE ────────────────────┐
  │  messages array grows turn-by-turn                     │
  │  disappears when agent loop terminates                 │
  │  bounded by context window (200k for Sonnet 4.6)       │
  └────────────────────────────────────────────────────────┘

  ┌─ Long-term (retrieved) ─── NOT LIVE ──────────────────┐
  │  would retrieve past investigations from an index      │
  │  see 03-retrieval-and-rag/B3.11 for the shipped-feature│
  │  exercise                                              │
  └────────────────────────────────────────────────────────┘
```

Zoom in: the two-layer split is the standard shape. Short-term is what fits in the current context; long-term is what you retrieve from persistent storage per-turn.

## Structure pass

- **Layers:** current turn messages → agent's message accumulator → context window → (would-be) long-term retrieval. Four bands.
- **Axis: durability.** Short-term dies with the loop; long-term persists across sessions.
- **Seam:** the retrieval step. Not built yet in blooming; would sit between "compose system prompt" and "call model."

## How it works

### Move 1 — the mental model

Short-term memory in an agent is the growing message list. Every model turn, the messages get one longer — the model's response and the tool results feed back in.

```
  Short-term memory — how it grows

  turn 1:  [user]                                            (1 msg)
  turn 2:  [user, assistant, user (tool_result)]             (3 msgs)
  turn 3:  [user, asst, user (tool_result), asst, user (tr)] (5 msgs)
  ...
  turn N: bounded by the 200k-token context window
```

Long-term memory is different: at each turn, you retrieve `k` relevant items from a persistent store (past investigations, past decisions, past conversations) and inject them into the system prompt or as few-shot examples.

### Move 2 — the step-by-step walkthrough

**Short-term in blooming — what it captures.** Every tool call's args and results, every model turn's text, every observation. By turn 10 of a diagnostic, the agent's short-term memory is a running record of what's been tried and what came back. That's why aptkit's loop doesn't re-run identical EQL queries — the memory is right there, the model sees it.

**Where short-term breaks.** At the context ceiling. If a single investigation runs so long that messages accumulate past ~150k tokens, the oldest messages start getting pushed out or the model starts losing attention on mid-context content (see **../02-context-and-prompts/02-lost-in-the-middle.md**). Blooming's observed run lengths (5–10 turns, 20–40k tokens) are far from that ceiling.

**Long-term — the design blueprint.** Once past-investigation memory (see `03-retrieval-and-rag/11-rag.md` exercise `B3.11`) lands, the shape is:

- On investigation complete, embed `anomaly + diagnosis` and store in the index.
- On new investigation start, embed the incoming anomaly, retrieve top-3 past investigations from the index, inject as few-shot into the system prompt.

That's RAG applied to the memory problem. The retrieval step is stateless per-invocation; the storage step happens once per completed investigation.

```
  Short-term (live) vs long-term (planned)

  ┌─ SHORT-TERM (live) ───────────────────────────────────┐
  │  messages: [system, user, assistant, user (tool_res),  │
  │              assistant, user (tool_res), ...]          │
  │  visible to every model turn                            │
  │  dies at loop end                                       │
  └────────────────────────────────────────────────────────┘

  ┌─ LONG-TERM (not built) ───────────────────────────────┐
  │  persistent index of past investigations               │
  │  retrieved per invocation, injected as few-shot         │
  │  survives across sessions                              │
  │  see B3.11                                              │
  └────────────────────────────────────────────────────────┘
```

**Session memory in QueryAgent.** `lib/agents/query.ts` runs a similar short-term memory for a single query — the free-form conversation may span multiple turns but is bounded to one HTTP round-trip. There's no chat-history-across-sessions today.

### Move 3 — the principle

Short-term memory is free (it's just the messages array); long-term memory has a cost (embedding, storage, retrieval per invocation). Add long-term only when the per-invocation cost is justified by the value of remembering across sessions.

## Primary diagram

```
  Agent memory in blooming — full frame

  ┌─ Turn 1 ─────────────────────────────────────────────┐
  │  messages: [ system, user "diagnose X" ]              │
  └───────────────────────┬──────────────────────────────┘
                          │  after model turn
                          ▼
  ┌─ Turn 2 ─────────────────────────────────────────────┐
  │  messages: [ system, user, assistant, user (tool_res)]│
  └───────────────────────┬──────────────────────────────┘
                          │  ... grows ...
                          ▼
  ┌─ Turn N ─────────────────────────────────────────────┐
  │  messages: [ ... ~40k tokens accumulated ... ]        │
  └───────────────────────┬──────────────────────────────┘
                          │  final turn: submit_diagnosis
                          ▼
  ┌─ Loop terminates ────────────────────────────────────┐
  │  short-term memory discarded                          │
  │  diagnosis saved to lib/state/investigations.ts       │
  │  (NOT re-embedded / not indexed)                      │
  └──────────────────────────────────────────────────────┘

  Future (B3.11):
  ┌─ Long-term memory ───────────────────────────────────┐
  │  on save: embed(anomaly + diagnosis) → index          │
  │  on new investigation: retrieve top-3 similar         │
  │  → inject as few-shot in system prompt                │
  └──────────────────────────────────────────────────────┘
```

## Elaborate

The two-layer memory model is standard — short-term as "what fits in context" and long-term as "what you retrieve." The distinction matters for design: short-term is where sub-second-latency reasoning happens; long-term is where you accept 10–100ms retrieval latency in exchange for knowledge that couldn't fit in-context.

Chat-style memory (persistent conversation across sessions) is a specialized long-term form — retrieve prior turns of *this user*'s conversation, inject into system prompt. blooming's QueryBox doesn't do this yet; the sessions modal in the UI is per-session only.

Related: **03-react-pattern.md** (short-term is embedded in the loop), **../03-retrieval-and-rag/11-rag.md** (long-term is RAG), **../03-retrieval-and-rag/12-graphrag.md** (a specialized long-term shape).

## Project exercises

### B4.5 · Ship investigation-memory long-term retrieval

- **Exercise ID:** B4.5 (Case B — depends on B3.11 aggregate exercise)
- **What to build:** The concrete "long-term memory for agents" feature. On investigation save: embed `anomaly + diagnosis`, store in `.investigation-index.json`. On new investigation: retrieve top-3, inject as few-shot in the diagnostic agent's system prompt. Aggregates B3.1 through B3.10 into an agent-facing feature.
- **Why it earns its place:** Turns "we have short-term memory" into "we have two-layer memory." Directly measurable via baseline rerun — does the `root_cause_plausibility` pass rate improve when the agent has prior investigations to reference?
- **Files to touch:** All files in the `03-retrieval-and-rag/` sub-section's B3.11 aggregate.
- **Done when:** the diagnostic agent's system prompt includes retrieved past-investigation context on runs where the index has ≥3 relevant entries; the baseline rerun shows measurable impact.
- **Estimated effort:** `≥1 week`.

## Interview defense

**Q: Why doesn't blooming have long-term memory yet?**

Corpus. Long-term memory needs a corpus of past investigations to retrieve from. The codebase writes investigations to state but doesn't accumulate cross-session yet. Adding memory before the corpus is scaffolding for a load that doesn't exist. Load-bearing: I know exactly what to build (`B4.5`) and I know when to build it (after enough investigations accumulate that retrieval would return non-trivial matches).

**Q: What about short-term memory within a single agent?**

That's live. The `messages` array grows turn-by-turn inside the aptkit loop; the model sees the whole thing every turn. Bounded by the 200k context window, but blooming's investigations use 20–40k, so there's 5× headroom. Where it would break: if a tool result exploded to 100kB, one call could blow the window. Mitigation named in `B2.1` — bound tool_result size.

## See also

- [03-react-pattern.md](03-react-pattern.md) — where short-term memory feeds every turn.
- [../03-retrieval-and-rag/11-rag.md](../03-retrieval-and-rag/11-rag.md) — the shape long-term memory would take.
- [../02-context-and-prompts/01-context-window.md](../02-context-and-prompts/01-context-window.md) — the ceiling short-term memory competes for.
