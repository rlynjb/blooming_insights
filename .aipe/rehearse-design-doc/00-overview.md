# blooming insights — design docs (RFCs)

The six load-bearing decisions in this repo, written as ADR-shape RFCs. One file per decision. Each follows Context → Decision → Alternatives → Consequences → Open Questions, grounded in the real files that ship the decision.

These are not aspirational designs. Every one is already in `main`. The docs exist so a reviewer can read the *why* without having to reverse-engineer the *what* — and so when someone asks "why didn't you use Server Components?" or "why isn't there a database?" the answer doesn't depend on the right person being in the room.

---

## How to read these

Each RFC names the standard industry term first and the local file/symbol in parens — "the port (`DataSource`)", "the kernel (`readNdjson`)", "the adapter (`BloomreachDataSource`)". On first mention the parens bind the term to the repo; after that the local name stands alone.

The shape is the same in every doc:

```
  RFC chapter shape

  ┌─ Context ───────────────────────────────┐
  │  what forced the decision —             │
  │  real constraints from the repo         │
  └────────────────────┬────────────────────┘
                       │
  ┌─ Decision ─────────▼────────────────────┐
  │  the chosen design, named at the top    │
  │  one diagram of the shape               │
  └────────────────────┬────────────────────┘
                       │
  ┌─ Alternatives ─────▼────────────────────┐
  │  2–3 options that were on the table     │
  │  each with why it lost                  │
  └────────────────────┬────────────────────┘
                       │
  ┌─ Consequences ─────▼────────────────────┐
  │  what this costs, owned without         │
  │  flinching — and what it bought         │
  └────────────────────┬────────────────────┘
                       │
  ┌─ Open Questions ───▼────────────────────┐
  │  what's still undecided                 │
  └─────────────────────────────────────────┘
```

Skip directly to whichever decision you're being pressed on. They don't depend on each other in reading order, but the dependencies between the decisions themselves are real — and named below.

---

## Ranked — which decisions warrant a doc, and why

Six made the bar. Ranked by *blast radius* (how much of the system the decision pins) — not by how clever the decision is.

| # | Decision | Why it warranted a doc |
|---|----------|------------------------|
| 1 | No database | Pins the entire reliability story. Demo snapshot is the path that always works; live is the recovery-oriented path. Reversing this would touch session, capture, deploy, and the "instant demo" pitch. |
| 2 | NDJSON over `fetch` stream, not SSE | Four streaming surfaces share one 64-LOC kernel. Picking SSE or WebSockets here would have meant a different transport in the browser, a different infrastructure boundary on Vercel, and a different debugging story. |
| 3 | Deterministic supervisor (not LLM router) | The route file IS the supervisor. An LLM "coordinator agent" was the obvious move and was deliberately not taken. |
| 4 | Framework runtime without data primitives | Next.js 16 is the runtime; React Server Components, Suspense, `use(promise)`, React Query, and SWR are not used. The 30–90s NDJSON stream IS the product. Most reviewers will assume the opposite default. |
| 5 | DataSource seam + adapter pattern | The port (`DataSource`) survived two adapter swaps without changing caller surface. That's the receipt; the doc explains the shape so future swaps don't relitigate it. |
| 6 | AptKit primitives + Blooming adapter boundary | Hand-rolled agent loop replaced with `@aptkit/core@0.3.0`; three Blooming adapter classes carry the boundary. Legacy lives at `*-legacy.ts` as the rollback receipt. Reversing this means owning the loop again. |

The order is *roughly* outside-in: reliability story first, then the transport that delivers it, then the orchestration shape, then the framework posture, then the data-source seam, then the model-loop seam.

---

## Dependencies between the decisions

These docs are independent reads, but the decisions themselves stack. The shape:

```
  How the six decisions depend on each other

  ┌─ 01: No database ─────────────────────────┐
  │  encrypted-cookie session + in-memory     │
  │  session-keyed state + demo snapshot      │
  └────────────────────┬──────────────────────┘
                       │  the session boundary
                       │  it pins → drives:
  ┌─ 04: Framework runtime ▼──────────────────┐
  │  Next.js as a stream host, not as a       │
  │  data primitive — no RSC, no Suspense,    │
  │  no React Query / SWR                     │
  └────────────────────┬──────────────────────┘
                       │  the stream is the product →
                       │  shared transport kernel:
  ┌─ 02: NDJSON kernel ▼──────────────────────┐
  │  one `readNdjson` (64 LOC) consumed by    │
  │  4 streaming surfaces                     │
  └────────────────────┬──────────────────────┘
                       │  what the stream carries →
                       │  agent reasoning + tool calls:
  ┌─ 03: Deterministic supervisor ▼───────────┐
  │  sequential pipeline (route code) +       │
  │  intent router (haiku) as ROUTE code      │
  └────────────────────┬──────────────────────┘
                       │  agents need a data backend
                       │  AND a model loop:
            ┌──────────┴─────────────────┐
            ▼                            ▼
  ┌─ 05: DataSource seam ──┐   ┌─ 06: AptKit boundary ──┐
  │  port + adapters       │   │  AptKit owns the loop  │
  │  factory by `bi:mode`  │   │  Blooming owns 3       │
  │  2 adapters today      │   │  adapter classes       │
  └────────────────────────┘   └────────────────────────┘
```

01 sets the session boundary. 04 keeps the framework out of the data path so the stream survives Vercel cold starts. 02 is the actual transport that gets the agents' work to the UI. 03 decides who decides what runs next. 05 and 06 are the two seams that let the rest of the system stay stable while the *insides* change — one swapped twice, one migrated once, neither broke its callers.

---

## What's NOT in this set

A decision earns a doc when it's hard to reverse, had a real alternative, and a reviewer will ask "why this way?". A few choices were considered and dropped *below* the bar:

- **Tailwind v4 + dark-mode-only.** Cosmetic. No data-layer or contract impact. Easy to swap.
- **AES-256-GCM cookie store specifically.** This is an implementation detail under decision 01 (no database) — the doc covers the encrypted-cookie session as the *kind* of session store, not the cipher choice.
- **`maxDuration = 300` on Vercel Pro.** A platform constant, not a decision. The choice it implies (long-running stream over short-lived request + queue) is covered under decisions 01 and 04.
- **Markdown export.** Useful, not load-bearing. No alternative was on the table.

If any of these become contentious later, they get a doc *then*. Premature documentation is its own debt.

---

## A note on the "weak" decisions

Two of the six (decisions 03 and 04) push *against* the default move a reviewer would make. They're the ones to read first if you're preparing for scrutiny:

- **Decision 03 (deterministic supervisor).** The popular pattern is "supervisor LLM agent." This repo intentionally did not do that. The doc owns why — and where the limit lives.
- **Decision 04 (no Server Components / no Suspense / no React Query).** Next.js 16's selling point includes patterns this repo doesn't reach for. The doc explains why the stream itself replaces them, and where that breaks down.

The other four are easier to defend. Read in any order.
