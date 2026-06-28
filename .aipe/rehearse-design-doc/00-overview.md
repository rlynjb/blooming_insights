# Design docs — overview

Six RFCs covering every load-bearing decision in `blooming_insights`. Each one
is a real choice the code made, written the way it should have been written
*before* the code went in — so a reviewer, a future-you, or a promo committee
can read the decision in five minutes and understand the cost.

This is the **coach voice** version of the book: lead with the decision; do not
bury it in alternatives; own the tradeoff in one sentence; surface what is
still unresolved.

```
  How these six fit together — the architectural spine

  ┌─ Runtime + state ────────────────────────────────┐
  │  RFC 1  no database                              │ session-keyed in-memory
  │  RFC 4  framework as runtime, not data layer     │ Next.js 16 carries
  └──────────────────────────────────────────────────┘ nothing but the request
                       │
                       │ produces a 30–90s stream
                       ▼
  ┌─ Transport ──────────────────────────────────────┐
  │  RFC 2  NDJSON over fetch, not SSE               │ one kernel, four
  └──────────────────────────────────────────────────┘ consumers
                       │
                       │ feeds a multi-agent pipeline
                       ▼
  ┌─ Agent topology ─────────────────────────────────┐
  │  RFC 3  deterministic supervisor, not LLM router │ ROUTE is code,
  │  RFC 6  AptKit primitives + adapter boundary     │ AGENT is loop
  └──────────────────────────────────────────────────┘
                       │
                       │ talks to one of several backends
                       ▼
  ┌─ Backend seam ───────────────────────────────────┐
  │  RFC 5  DataSource interface + adapter pattern   │ proven across
  └──────────────────────────────────────────────────┘ 2 swaps
```

## Which decisions earned a doc

The rule: a decision earns an RFC if it was **hard to reverse, had a real
alternative on the table, and a reviewer will ask "why this way?"** Defaults
get one-liners, not docs.

| # | Decision | Reversal cost | Real alternative? |
|---|---|---|---|
| 1 | No database; session-keyed in-memory state | Medium (schema + migrations) | Yes — Vercel KV, Postgres |
| 2 | NDJSON over fetch (not SSE / WebSocket) | High (4 consumers + 2 producers) | Yes — SSE was the obvious choice |
| 3 | Deterministic supervisor, not LLM router | High (changes the failure model) | Yes — coordinator agent calling sub-agents |
| 4 | Next.js 16 as runtime, no data primitives | Low per surface, high in aggregate | Yes — React Server Components + Suspense |
| 5 | DataSource interface + adapter pattern | High (two adapters depend on it) | Yes — direct `McpClient` everywhere |
| 6 | AptKit primitives + Blooming adapter boundary | Medium (rollback receipt preserved) | Yes — keep the hand-rolled loop |

Six docs is the ceiling for a project this size. Anything else (Tailwind v4,
the `bi:mode` enum, the dark-mode-only call) is a default — write it down
inline in the code, not in a doc.

## How to read these

Each doc is one chapter, one decision, the canonical RFC shape:

1. **Title + one-line summary** — the verdict in a sentence
2. **Context / problem** — what forced the call
3. **Goals & non-goals** — what's in scope, what's explicitly out
4. **The decision** — the chosen design with a diagram
5. **Alternatives considered** — 2–3 options that were on the table, each
   with why it lost
6. **Tradeoffs accepted** — what this costs, named without flinching
7. **Risks & mitigations** — what could go wrong, what guards it
8. **Rollout / migration** — how it shipped, what changed for callers
9. **Open questions** — what's still undecided

Read them in numeric order on first pass. After that they stand alone.

## Coach notes — the framings that hold under scrutiny

These show up in every doc. They are the verbal moves that earn a senior
reviewer's "okay, you've thought about this."

  → **"I chose X, accepting Y."** Never "unfortunately we had to use X."
    The decision was deliberate. Own it.
  → **Verdict before the matrix.** A reviewer who reads the first sentence
    should already know which option you picked. Then walk the alternatives.
  → **Name the load-bearing part.** The session-keying of `lib/state/insights.ts`;
    the trailing-buffer flush in `readNdjson`; the `maxToolCalls` budget; the
    `bootstrap` branch inside `makeDataSource`. The part a casual reader
    misses is the part you spotlight.
  → **Surface the open question.** A doc with no open questions reads as
    polished marketing, not as engineering. Every one of these docs ends with
    real unresolved decisions.
