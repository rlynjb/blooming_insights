# Design docs — blooming insights

Four RFCs. Each documents a decision already made in the codebase, written the way it should have been written when it was made — for a skeptical reviewer who will ask "why this and not the obvious thing?"

This is not a backfill of every choice the repo contains. Most of what's in this codebase is the obvious default for a Next.js + MCP + Claude app. These four are the ones where a reviewer will stop, push back, and ask for the alternatives matrix.

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
  └─────────────────────────────────────────────────────────────────────┘
```

## Why these four (and not others)

A design doc is expensive attention. The test for "warrants a doc" is four-part — every one of these clears all four:

```
  Test                          RFC-001    RFC-002    RFC-003    RFC-004
  ─────────────────────────     ───────    ───────    ───────    ───────
  hard to reverse               yes        yes        yes        yes
  a real alternative existed    yes        yes        yes        yes
  cross-cutting impact          yes        yes        yes        yes
  reviewer will ask "why?"      yes        yes        yes        yes
```

The candidates that DIDN'T make the cut (and why):

- **Provider abstraction (`McpCaller` / `McpTransport`)** — a real decision, but the alignment story is internal to the test suite. `.aipe/study-system-design/03-provider-abstraction.md` already defends it for an interview reader. A team aligning on architecture would treat it as a default ("we own our interface, not the vendor's") rather than a contested choice.

- **Schema-gated coverage** — a clever pattern, well-named, and a real win in the briefing route. But it's a *local* decision (one stage of one route), not cross-cutting. It does not change how the rest of the codebase is written.

- **AES-256-GCM specifically (vs HMAC-signed cookie, vs JWE)** — folded into RFC-001 because the choice of *cookie as the store* dominates the choice of *how the cookie is protected*. If you accept the no-DB stance you're already most of the way to AES-GCM; the alternatives below the cookie boundary are not what a reviewer will fight you about.

- **Vercel as the host** — not actually a decision in the repo; inherited from the Next.js scaffold. RFC-worthy decisions are decisions someone could have made differently; this one is upstream of the codebase.

- **Deferring the eval substrate** — flagged by the recon audit and the eval-substrate refactor notebook. Real decision, real cost (the recon places the repo at L1-with-one-L2-spike specifically because of the missing eval harness). But deferring isn't hard-to-reverse architecturally; adding evals is additive, not migrational. Lives in the cleanup-and-readiness layer, not the design-doc layer.

## How to use these docs

Each RFC follows the canonical spine — context, goals/non-goals, the decision, alternatives, tradeoffs, risks, rollout, open questions. The voice is direct. Hedging is not a virtue when you're trying to align a room.

The "Open questions" section at the end of each doc is not a weakness — it's the most useful section for a reviewer. It tells them what's not yet decided, where the decision could plausibly move, and what evidence would force a re-think. Read it first if you're reviewing under time pressure.

## On the size of this collection

Four RFCs is right for *this* codebase. blooming insights is one engineer building one product on one host with one upstream API. Most of its choices are defaults that don't need defending in writing. The four that do — no database, NDJSON over the alternatives, deterministic supervisor over the LLM-supervisor default, framework runtime adopted but data-fetch primitives declined — are the four where the architecture would have to change shape if any one were reversed.

The honest framing: 3 was the right number until the FE-engineering audit (2026-06-03) surfaced the framework-underuse decision as a load-bearing one — every routed page is `'use client'`, no Server Components, no Suspense, no use(), no Server Actions, no React Query / SWR, no global store, and the non-adoption is uniform and deliberate. That decision shapes every page; it's the literal first thing a React 19 reviewer asks about. Adding it as RFC-004 reflects the codebase's actual architecture; not adding it would mean the most cross-cutting decision in the frontend lives only in an audit observation.

A team-scale codebase would generate more RFCs over time as more decisions earn the bar. Until then, these are the four.

---

**Updated:** 2026-06-03 — added RFC-004 (framework runtime adopted, data-fetch primitives declined); revised "3 is right" → "4 is right" with the honest delta against the FE-engineering audit.
