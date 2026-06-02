# Design docs — blooming insights

Three RFCs. Each documents a decision already made in the codebase, written the way it should have been written when it was made — for a skeptical reviewer who will ask "why this and not the obvious thing?"

This is not a backfill of every choice the repo contains. Most of what's in this codebase is the obvious default for a Next.js + MCP + Claude app. These three are the ones where a reviewer will stop, push back, and ask for the alternatives matrix.

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
  └─────────────────────────────────────────────────────────────────────┘
```

## Why these three (and not others)

A design doc is expensive attention. The test for "warrants a doc" is four-part — every one of these clears all four:

```
  Test                          RFC-001    RFC-002    RFC-003
  ─────────────────────────     ───────    ───────    ───────
  hard to reverse               yes        yes        yes
  a real alternative existed    yes        yes        yes
  cross-cutting impact          yes        yes        yes
  reviewer will ask "why?"      yes        yes        yes
```

The candidates that DIDN'T make the cut (and why):

- **Provider abstraction (`McpCaller` / `McpTransport`)** — a real decision, but the alignment story is internal to the test suite. `.aipe/study-system-design/03-provider-abstraction.md` already defends it for an interview reader. A team aligning on architecture would treat it as a default ("we own our interface, not the vendor's") rather than a contested choice.

- **Schema-gated coverage** — a clever pattern, well-named, and a real win in the briefing route. But it's a *local* decision (one stage of one route), not cross-cutting. It does not change how the rest of the codebase is written.

- **AES-256-GCM specifically (vs HMAC-signed cookie, vs JWE)** — folded into RFC-001 because the choice of *cookie as the store* dominates the choice of *how the cookie is protected*. If you accept the no-DB stance you're already most of the way to AES-GCM; the alternatives below the cookie boundary are not what a reviewer will fight you about.

- **Vercel as the host** — not actually a decision in the repo; inherited from the Next.js scaffold. RFC-worthy decisions are decisions someone could have made differently; this one is upstream of the codebase.

## How to use these docs

Each RFC follows the canonical spine — context, goals/non-goals, the decision, alternatives, tradeoffs, risks, rollout, open questions. The voice is direct. Hedging is not a virtue when you're trying to align a room.

The "Open questions" section at the end of each doc is not a weakness — it's the most useful section for a reviewer. It tells them what's not yet decided, where the decision could plausibly move, and what evidence would force a re-think. Read it first if you're reviewing under time pressure.

## On the size of this collection

Three RFCs is light for a production codebase; it's right for *this* codebase. blooming insights is one engineer building one product on one host with one upstream API. Most of its choices are defaults that don't need defending in writing. The three that do need defending are the three above — and the load-bearing test is honest: if any one of them were reversed, the architecture would have to change in a way the others wouldn't survive.

A team-scale codebase would generate more RFCs over time as more decisions earn the bar. Until then, these are the three.
