# 05 — Agent memory

**Type:** Industry standard. Also called: conversation memory, short-term vs long-term memory.

## Zoom out, then zoom in

Two layers of memory in this codebase. Short-term (the messages array within one investigation). Long-term (session storage, demo snapshots — human-scale persistence, not RAG retrieval).

```
  Zoom out — memory layers

  ┌─ Short-term (in-context, this turn) ──────────────────────────────┐
  │  messages array — grows across the ReAct loop                     │
  │  disappears when the investigation ends                            │
  └───────────────────────────────────────────────────────────────────┘

  ┌─ Long-term (persisted, across investigations) ────────────────────┐
  │  sessionStorage (per browser tab) — useInvestigation hook stash    │
  │  demo snapshot (committed lib/state/demo-*.json)                   │
  │  NOT retrieved by the agent — accessible only via UI               │
  └───────────────────────────────────────────────────────────────────┘
```

Zoom in. Short-term memory is standard — every LLM app has it (the messages array). Long-term memory in this codebase is HUMAN-facing (the user navigates back to a completed investigation) but NOT AGENT-facing (the diagnostic agent doesn't retrieve past investigations at runtime). The RAG-shaped long-term memory would be Case B (see `03-retrieval-and-rag/11-rag.md`).

## Structure pass

**Layers:**
- Outer: what the AGENT can access at runtime
- Middle: what the APP persists across sessions
- Inner: what the UI shows the user

**Axis: who accesses this memory?**
- Short-term messages array: the model (during the loop)
- Session storage: the UI (navigation, refresh)
- Demo snapshot: the UI + capture tooling (committed as source of truth for demo mode)
- (missing) Long-term retrieved memory: would be agent-accessible via RAG

**Seam:** the boundary between "in the loop's messages" and "on disk." The agent only sees what's in messages. Everything else is UI persistence.

## How it works

### Move 1

You've distinguished between "state in a React component" (short-term, dies with the component) and "state in localStorage" (long-term, survives reload). Same shape for agent memory: what's in the messages array is short-term (dies with the loop); what's in sessionStorage / demo snapshot is long-term (survives the investigation).

```
  Two memory layers

  ┌─ Short-term ──────────────────────────────────────┐
  │  the messages array — everything the model sees    │
  │  dies at loop end                                  │
  └───────────────────────────────────────────────────┘

  ┌─ Long-term (this codebase — not retrieved) ───────┐
  │  sessionStorage per-tab   (useInvestigation)       │
  │  demo snapshot on disk    (lib/state/demo-*.json)  │
  │  UI hydrates from these; agent does NOT            │
  └───────────────────────────────────────────────────┘
```

### Move 2

**Short-term: the messages array.**

Every model turn re-sends the whole history. That's the entire "memory" during the loop. See `02-context-and-prompts/01-context-window.md` for the mechanics. Dies at investigation end — the diagnostic agent's next invocation on a different anomaly starts fresh.

**Long-term type 1: sessionStorage.**

`lib/hooks/useInvestigation.ts` (per project context) stashes the diagnosis + recommendations in `sessionStorage`. Purpose: the user can navigate back to step 2 or forward to step 3 without re-running the agent. Survives StrictMode double-mount. Dies when the tab closes.

**Long-term type 2: the demo snapshot.**

`lib/state/demo-insights.json` and `lib/state/demo-investigations.json`. Committed. Captured once locally via the dev-only capture button; replayed by `?demo=cached`. Instant, no auth, no live agents. This is the "reliable presentation path" — same NDJSON events the live path emits, replayed from disk.

**Why no retrieved long-term memory (RAG-shaped) today.**

Two reasons: (1) volume of past investigations is low; (2) the diagnostic agent has strong tool-call grounding to CURRENT DATA, so retrieving prior reasoning is additive not necessary. See `03-retrieval-and-rag/11-rag.md` for the shape it would take if added.

**The retrieval question, if it were added.**

Would look like: on `DiagnosticAgent.investigate(anomaly)`, first embed the anomaly, retrieve top-3 similar past diagnoses from a vector store, prepend their conclusions to the initial user message as "context from similar past cases." Same ReAct loop; enriched initial context. Case B exercise below.

### Move 3

Short-term memory is unavoidable — it IS the messages array. Long-term memory is a design decision: what's worth persisting, who accesses it (UI or agent), how it's retrieved (direct lookup or similarity). This codebase persists for UI navigation but not for agent access. That's a shape, not a limitation.

## Primary diagram

```
  Memory layers in this codebase

  ┌─ Loop-scoped (short-term) ────────────────────────────────────────┐
  │                                                                   │
  │  messages array                                                   │
  │    [system, user(anomaly), asst, user(tool_result), asst, ...]    │
  │    grows across ~5-10 turns                                       │
  │    dies at DiagnosticAgent.investigate() return                    │
  │                                                                   │
  └───────────────────────────────────────────────────────────────────┘

  ┌─ Browser-tab-scoped (medium-term) ────────────────────────────────┐
  │                                                                   │
  │  sessionStorage (useInvestigation hook)                            │
  │    stashes {trace, diagnosis, recommendations} keyed by insight id │
  │    survives navigation between step 2 and step 3                   │
  │    dies at tab close                                               │
  │                                                                   │
  └───────────────────────────────────────────────────────────────────┘

  ┌─ Repo-scoped (permanent, committed) ──────────────────────────────┐
  │                                                                   │
  │  lib/state/demo-insights.json                                     │
  │  lib/state/demo-investigations.json                               │
  │    committed snapshots; replay engine                             │
  │    used by ?demo=cached for auth-free demo path                   │
  │                                                                   │
  └───────────────────────────────────────────────────────────────────┘

  ┌─ (missing) Agent-retrievable long-term memory ────────────────────┐
  │                                                                   │
  │  Vector store over past diagnoses (Case B)                        │
  │  Agent-side retrieval on each new investigation                    │
  │  Would let agent "remember" similar past cases                    │
  │                                                                   │
  └───────────────────────────────────────────────────────────────────┘
```

## Elaborate

The industry pattern for agent long-term memory:
- **Episodic memory** — full conversation logs, retrieved by similarity to current query.
- **Semantic memory** — extracted facts / claims / preferences, indexed and retrieved.
- **Working memory** — the current loop's messages array (short-term).

Modern agent frameworks (LangGraph, CrewAI) bake all three in as first-class concepts. AptKit today ships working memory (the messages array) and lets the caller layer episodic / semantic on top. This codebase uses only working memory + UI persistence; no retrieved memory of any shape.

## Project exercises

### Exercise — retrieved episodic memory over past investigations

- **Exercise ID:** C4.5-B · Case B (short-term exercised; long-term retrieval not).
- **What to build:** if the RAG stack from `03-retrieval-and-rag/*` is present, wire the diagnostic agent to retrieve top-3 similar past diagnoses at the start of each investigation and prepend them to the initial user message.
- **Why it earns its place:** turns the codebase's long-term memory from UI-persistence into agent-accessible. Interviewer signal: "my agents can remember; here's the retrieval that enables it."
- **Files to touch:** `lib/agents/diagnostic.ts` (accept optional retrieved context), `lib/rag/retrieve.ts` (call before invoke), `eval/run.eval.ts` (measure quality with vs without).
- **Done when:** enabling retrieved memory shows measurable per-dim quality change on the 10-case eval.
- **Estimated effort:** 1 week (assumes RAG stack from earlier exercises is built).

## Interview defense

**Q: What memory do the agents have?**

Only the current investigation's messages array — short-term, in-context. When an investigation ends, the messages array is discarded. Long-term persistence in this repo is UI-side (sessionStorage for navigation, committed demo snapshots for the demo path); the agents don't retrieve from it.

```
  short-term:  messages array (dies at loop end)
  medium-term: sessionStorage (dies at tab close)
  long-term:   demo snapshot (committed, UI-only)
  retrieved:   (missing — Case B RAG add)
```

**Q: What would agent-side long-term memory look like?**

RAG over past diagnoses. Embed each conclusion; on new investigation, retrieve top-3 similar past cases; prepend to initial user message. Would let the agent apply prior reasoning. Not built today because past-investigation volume is low and the tool-call grounding already gives the agent strong current-data access.

**Q: Why the sessionStorage stash?**

Because the two-page product flow (investigate step 2 → step 3) needs to survive navigation without re-running the ~225s agent chain. Stashing lets step 3 hydrate instantly with the diagnosis from step 2. Not a "memory" the agent uses — it's a UX cache.

## See also

- `02-context-and-prompts/01-context-window.md` — the mechanics of short-term memory
- `03-retrieval-and-rag/11-rag.md` — what agent-side long-term memory would look like
- `lib/hooks/useInvestigation.ts` — the medium-term stash
