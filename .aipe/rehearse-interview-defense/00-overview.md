# Overview — how to use this book

This book has one job: get you ready to defend **blooming insights** in a senior-engineering interview without freezing, without rambling, and without overclaiming. It is paired with the comprehension guides under `.aipe/study-system-design/` and `.aipe/study-ai-engineering/`. Those teach you the patterns deeply, one at a time. This book teaches you to *speak* them — at the project level, under pressure, with an interviewer who will interrupt you.

You used AI heavily to build this project. So did everyone else interviewing in 2026. The interview doesn't reward pretending otherwise; it rewards owning what you shipped. Every chapter in this book is built on that posture. Chapter 8 is dedicated to the meta-question, but the AI-honest framing runs through the whole book.

## The system at a glance — the recurring map

Every chapter returns to this picture. Burn it into memory; it's the diagram you'll redraw on every whiteboard.

```
  blooming insights — system at a glance

  ┌─ UI layer (Next.js 16 App Router + React 19) ────────────────────────┐
  │  app/page.tsx (feed)         app/investigate/[id]/{,recommend}/      │
  │   ▲          ▲                                                       │
  │   │ NDJSON   │ NDJSON                                                │
  └───┼──────────┼───────────────────────────────────────────────────────┘
      │          │
  ┌─ Service layer (Next.js route handlers, maxDuration=300s) ────────────┐
  │  /api/briefing       /api/agent (step=diagnose|recommend|null)        │
  │           │                              │                            │
  │           ▼                              ▼                            │
  │  agents: monitoring · diagnostic · recommendation · query · intent    │
  │  thin wrappers over @aptkit/core@0.3.0                                │
  │           │                              │                            │
  │           └──────────► lib/agents/aptkit-adapters.ts ◄────────────────┤
  │                       (3 Blooming-owned adapter classes, 206 LOC)     │
  │                       Anthropic · ToolRegistry · TraceSink            │
  │                              │                                        │
  └──────────────────────────────┼────────────────────────────────────────┘
                                 │  (the seam — adapters either side)
  ┌─ Data layer ─────────────────▼────────────────────────────────────────┐
  │  lib/data-source/types.ts  ── DataSource interface                    │
  │     ├─ BloomreachDataSource  (HTTPS + OAuth PKCE + ~1.1s spacing)     │
  │     └─ SyntheticDataSource   (516 LOC in-process deterministic)       │
  └───────────────────────────────────────────────────────────────────────┘
                                 │
  ┌─ Provider layer ─────────────▼────────────────────────────────────────┐
  │  Anthropic API (Sonnet 4.6 + Haiku for intent)                        │
  │  Bloomreach loomi connect MCP (alpha)                                 │
  └───────────────────────────────────────────────────────────────────────┘

  bi:mode  = 'demo' | 'live-bloomreach' | 'live-synthetic'  (default demo)
```

That's the whole system. Three flips down the stack worth tattooing on the inside of your eyelids:

- **The agent boundary.** AptKit owns the loop; you own the boundary. Three small adapter classes (~200 LOC). Legacy hand-rolled `runAgentLoop` preserved at `lib/agents/base-legacy.ts:86-176`.
- **The data-source seam.** Two adapters today. The seam has survived two adapter swaps without changing the caller surface.
- **The streaming kernel.** One `readNdjson` at `lib/streaming/ndjson.ts` (64 lines) consumed by four streaming surfaces.

## The chapters

```
  01 — The pitch                10s / 30s / 90s. Compression discipline.
  02 — The architecture         The whiteboard walk. End-to-end request flow.
  03 — The choices              Five load-bearing decisions and their costs.
  04 — The scale story          What breaks at 10×, 100×, 10× latency.
  05 — The failure story        Token revoke, rate-limit, partial writes.
  06 — The hard parts           Three real bugs. The proudest part. Least confident.
  07 — The counterfactuals      Four decisions to reconsider; four to keep.
  08 — The AI question          Decisions mine, AI typed faster. Owned.
```

## How to read it

```
  First read              Review (1 hour)         Night before
  ────────────            ─────────────────       ──────────────
  one chapter             skim chapter            one-page summary
  per sitting             openings + pull         at the end of
  front to back           quotes + boxes          each chapter
                          re-draw the map         re-draw the map
```

The visual treatments do most of the work. If you only have an hour, skim the chapter-opening diagrams, the **WHAT THEY'RE REALLY ASKING** callouts, the strong-vs-weak side-by-sides, the double-bordered **WHEN YOU DON'T KNOW** boxes, and the pull quotes. That gets you ~70% of the book. The prose is for the deeper passes.

## How this book composes with the rest

The concept files under `.aipe/study-system-design/` and `.aipe/study-ai-engineering/` each carry their own Interview defense block — that's where you go for the **one-decision deep dive** (the OAuth boundary, the streaming kernel, the multi-agent orchestration). This book is for the **wide opener** — the moment the interviewer says "walk me through what you built." The concept files are the depth; this book is the breadth.

Use both. The concept files prepare you for the drill-down. This book prepares you for the opener — and for the seven-to-ten chapter-shaped territories that follow it.

## One pull quote to anchor the whole book

```
  ┃ "I own the boundary; AptKit owns the loop. Three small
  ┃  adapter classes, around 200 lines of code, and the legacy
  ┃  loop is preserved for the day I need to peel back to it."
```

Read that twice. If you can defend why every word is in it — why "boundary," why "loop," why "preserved," why "the day I need" — you can defend most of this project.
