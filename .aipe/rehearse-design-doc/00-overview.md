# Design docs — blooming insights

Six RFCs. Each documents a decision already made in the codebase, written the way it should have been written when it was made — for a skeptical reviewer who will ask "why this and not the obvious thing?"

This is not a backfill of every choice the repo contains. Most of what's in this codebase is the obvious default for a Next.js + MCP + Claude app. These six are the ones where a reviewer will stop, push back, and ask for the alternatives matrix.

## The decisions

```
  ┌─────────────────────────────────────────────────────────────────────┐
  │  RFC-001  No database — encrypted cookie is the session store        │
  │           Rejected: Redis (Upstash), Postgres + sessions table,      │
  │                     Vercel KV, signed JWTs                            │
  │           Why it's RFC-worthy: hard to reverse (the entire OAuth     │
  │           flow is shaped around the cookie); cross-cutting (every    │
  │           authenticated route touches it); a reviewer's first        │
  │           question on seeing the architecture                         │
  ├─────────────────────────────────────────────────────────────────────┤
  │  RFC-002  NDJSON over fetch+ReadableStream (not SSE, not WebSocket) │
  │           Rejected: EventSource/SSE, WebSocket, long-poll, plain    │
  │                     JSON-after-completion                            │
  │           Why it's RFC-worthy: SSE is the obvious default for       │
  │           server push; the decision to reject it depends on a       │
  │           specific load-bearing fact (the GET triggers a ~115s     │
  │           non-idempotent agent run); easy to undo by mistake        │
  ├─────────────────────────────────────────────────────────────────────┤
  │  RFC-003  Deterministic supervisor in code (not an LLM supervisor)  │
  │           Rejected: LangGraph-style LLM supervisor, agent-router    │
  │                     framework, single mega-agent with all tools     │
  │           Why it's RFC-worthy: "make it multi-agent with a          │
  │           supervisor" is the path of least resistance in 2026;     │
  │           justifying the simpler shape requires naming what's       │
  │           bought and what's avoided                                 │
  ├─────────────────────────────────────────────────────────────────────┤
  │  RFC-004  Next 16 + React 19 runtime, decline their data-fetch      │
  │           primitives (no RSC, no Suspense, no use(), no Server      │
  │           Actions, no SWR/React Query, no global store)             │
  │           Rejected: RSC + Suspense + use(promise) everywhere,       │
  │                     SWR/React Query for the streams, global store, │
  │                     mixed RSC-for-static + stream-for-live          │
  │           Why it's RFC-worthy: "you're on React 19, why no          │
  │           Suspense?" is the literal first reviewer question; the    │
  │           uniform `'use client'` stance shapes every page; the      │
  │           non-adoption is deliberate, not framework illiteracy      │
  ├─────────────────────────────────────────────────────────────────────┤
  │  RFC-005  DataSource seam + adapter pattern at the backend boundary │
  │           Rejected: per-backend route handlers, agents coupled to   │
  │                     McpClient directly, a generic ORM abstraction,  │
  │                     framework-supplied tool registry                │
  │           Why it's RFC-worthy: this seam already survived three     │
  │           adapter swaps in production (Olist added, Olist removed,  │
  │           Synthetic added) without changing one caller surface;     │
  │           a reviewer who hasn't seen the history will ask "why not  │
  │           just call BloomreachDataSource directly?" — the answer    │
  │           is the receipts                                            │
  ├─────────────────────────────────────────────────────────────────────┤
  │  RFC-006  AptKit primitives + Blooming-owned adapter boundary       │
  │           Rejected: keep the hand-rolled runAgentLoop forever,      │
  │                     vendor AptKit-the-library directly into routes, │
  │                     adopt LangChain / LangGraph instead, build our  │
  │                     own ModelProvider / ToolRegistry primitives     │
  │           Why it's RFC-worthy: the agent loop is the hottest        │
  │           load-bearing logic in the codebase. Moving it from        │
  │           Blooming-owned code to a generic library is the kind of   │
  │           dependency call a reviewer interrogates; the legacy path  │
  │           is preserved at `base-legacy.ts` as the receipt that the  │
  │           swap was a substitution, not a rewrite                    │
  └─────────────────────────────────────────────────────────────────────┘
```

## Why these six (and not others)

A design doc is expensive attention. The test for "warrants a doc" is four-part — every one of these clears all four:

```
  Test                       001  002  003  004  005  006
  ─────────────────────────  ───  ───  ───  ───  ───  ───
  hard to reverse            yes  yes  yes  yes  yes  yes
  a real alternative existed yes  yes  yes  yes  yes  yes
  cross-cutting impact       yes  yes  yes  yes  yes  yes
  reviewer will ask "why?"   yes  yes  yes  yes  yes  yes
```

The candidates that DIDN'T make the cut (and why):

- **Provider abstraction (`McpCaller` / `McpTransport`)** — folded INTO RFC-005. The internal `McpCaller` type (now `Pick<DataSource, 'callTool'>` at `lib/agents/base.ts:14` and `base-legacy.ts:24`) and the `McpTransport` test seam are sub-pieces of the same boundary RFC-005 defends. Keeping them as separate RFCs would split the same decision across three documents.

- **Schema-gated coverage** — a clever pattern, well-named, and a real win in the briefing route. But it's a *local* decision (one stage of one route), not cross-cutting. It does not change how the rest of the codebase is written.

- **AES-256-GCM specifically (vs HMAC-signed cookie, vs JWE)** — folded into RFC-001 because the choice of *cookie as the store* dominates the choice of *how the cookie is protected*. If you accept the no-DB stance you're already most of the way to AES-GCM; the alternatives below the cookie boundary are not what a reviewer will fight you about.

- **Vercel as the host** — not actually a decision in the repo; inherited from the Next.js scaffold. RFC-worthy decisions are decisions someone could have made differently; this one is upstream of the codebase.

- **The session-keyed insights map (`lib/state/insights.ts`)** — a real bug fix (the concurrent-user wipe) and structurally important, but the fix lives inside the no-database stance RFC-001 already defends. It's noted as a *resolved* open question on RFC-001 rather than its own RFC.

- **The NDJSON kernel extraction (`lib/streaming/ndjson.ts`)** — the shared `readNdjson` consumed by all four streaming surfaces. Architecturally significant, but it's the cleanup payoff of RFC-002 and RFC-004 (it closes their "two/three consumer copies" tradeoff). Noted in those RFCs rather than promoted to its own.

- **Page decomposition (`useBriefingStream` / `useDemoCapture` / `useReconnectPolicy`)** — `app/page.tsx` dropped from 817 → 461 LOC by extracting three hooks. Real shipped work, but it's the implementation of an existing software-design verdict, not a contested design decision. Lives in `study-software-design/`.

- **The Eval flywheel (built and retired)** — Phase 3 stood up a 4-pillar eval suite (detection precision/recall, diagnosis 5-criterion rubric, recommendation 3-criterion rubric, regression capture-and-score), calibrated by 8/8 and 3/3 manual spot-check agreement, surfaced 3 real bugs, and was retired with the Olist substrate (PR #8). Retired-on-purpose isn't an active design decision — it's a closed chapter. Its lessons inform a future eval-substrate RFC if/when the substrate question reopens.

- **Deferring the eval substrate** — flagged by the recon audit. Real decision, real cost. But deferring isn't hard-to-reverse architecturally; adding evals is additive, not migrational. Lives in the cleanup-and-readiness layer.

## How to use these docs

Each RFC follows the canonical spine — context, goals/non-goals, the decision, alternatives, tradeoffs, risks, rollout, open questions. The voice is direct. Hedging is not a virtue when you're trying to align a room.

The "Open questions" section at the end of each doc is not a weakness — it's the most useful section for a reviewer. It tells them what's not yet decided, where the decision could plausibly move, and what evidence would force a re-think. Read it first if you're reviewing under time pressure.

## On the size of this collection

Six RFCs is right for *this* codebase as of today. blooming insights is one engineer building one product on one host with one upstream API. Most of its choices are defaults that don't need defending in writing.

The four original RFCs (no database, NDJSON over the alternatives, deterministic supervisor over the LLM-supervisor default, framework runtime adopted but data-fetch primitives declined) are still the four where the architecture would have to change shape if any one were reversed.

The two newer RFCs (RFC-005, RFC-006) document the load-bearing design moves of Phase 2: the DataSource seam that lets a non-trivial adapter (Synthetic, in-process, 516 LOC) ride the same caller surface as the Bloomreach one, and the AptKit primitive migration that moved the agent loop's runtime out of Blooming-owned code while keeping every Blooming-owned concern (model provider, tool registry, trace sink) at the boundary. Both pivots survived a real cycle of "add an adapter / retire an adapter" — the receipt is in the diff history (the deleted Olist adapter that the seam survived).

A team-scale codebase would generate more RFCs over time. Until then, these are the six.
