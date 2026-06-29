# Interview defense book — blooming insights

This is the book you read before you walk into the room. It is not a substitute for the concept files under `.aipe/study-system-design/` and `.aipe/study-ai-engineering/` — those prepare you for the deep dive when an interviewer drills into one decision. This book prepares you for the wide opener: the moment they ask "walk me through what you built."

Eight chapters, read in order at least once. After that, treat it as a reference — the one-page summary at the end of each chapter is what you re-read the night before.

## The system at a glance

Before any chapter, anchor on the picture. Every chapter returns to some slice of this.

```
  blooming insights — the system at a glance

  ┌─ User (browser) ─────────────────────────────────────────────┐
  │  app/page.tsx (feed) · /investigate/[id] · /recommend         │
  │  ProcessStepper (3 steps)   QueryBox (free-form Q&A)          │
  └──────────────┬───────────────────────────────────────┬────────┘
                 │ fetch (NDJSON)                        │ fetch
                 ▼                                       ▼
  ┌─ Service (Next 16 App Router on Vercel) ───────────────────────┐
  │  /api/briefing     /api/agent     /api/mcp/{callback,reset,…}  │
  │  bootstraps inside the stream · maxDuration = 300              │
  └──────────────┬─────────────────────────────────────────────────┘
                 │ runs the agent loop (AptKit)
                 ▼
  ┌─ Agent loop (library) ────────────────────────────────────────┐
  │  @aptkit/core@0.3.0 owns iterate → tool_use → tool_result      │
  │  3 adapters (lib/agents/aptkit-adapters.ts, 206 LOC):          │
  │  AnthropicModelProvider · ToolRegistry · TraceSink             │
  └──────────────┬─────────────────────────────────────────────────┘
                 │ callTool() through the DataSource seam
                 ▼
  ┌─ DataSource (lib/data-source/types.ts) ───────────────────────┐
  │  BloomreachDataSource  ◄── HTTPS + OAuth + ~1 req/s cap        │
  │  SyntheticDataSource   ◄── 516 LOC, in-process, no network     │
  └──────────────┬─────────────────────────────────────────────────┘
                 │
                 ▼
       Bloomreach Engagement (loomi connect MCP, alpha)
```

Four moving parts. UI streams NDJSON it consumes with one shared kernel (`readNdjson`). Service bootstraps inside the stream and runs the agent loop. The loop lives in a library; this app owns three small adapter classes. The data source is a seam — same caller surface whether the backend is Bloomreach or a 516-LOC in-process synthetic.

## The eight chapters

The book is **read sequentially the first time** — each chapter assumes the picture the previous one drew. After that, dip in as needed.

  1. **The pitch** — the first 60 seconds of every interview. Three lengths (10s, 30s, 90s). The discipline of compression.
  2. **The architecture** — walk me through the system, at a whiteboard, in 90 seconds. Where they'll interrupt and what to say.
  3. **The choices** — defense of every load-bearing technology choice. Next 16, AptKit primitives, the DataSource seam, NDJSON, in-memory state, Sonnet 4.6.
  4. **The scale story** — what breaks first as load grows. Three scenarios: 10× concurrent users, 100× insights persisted, 10× Bloomreach calls.
  5. **The failure story** — what happens when things go wrong. Token revocation, rate-limit overruns, malformed tool results, AbortError under StrictMode, the bare 500.
  6. **The hard parts** — three reflections, in your voice. The hardest bug (StrictMode double-fetch), the part you're proudest of (the AptKit migration with legacy preserved), the part you're least confident defending (the retired eval flywheel).
  7. **The counterfactuals** — what you'd reconsider. No DB. Demo-replay as a reliability path. Fixed 1.1s call spacing. Exact-match coverage deps.
  8. **The AI question** — the 2026 meta-question. Three decision modes (deliberate / evaluated-and-accepted / defaulted-to), four bugs AI got wrong, one thing AI helped with.

```
  How the chapters compose

  ┌─ orient ────────────┐    ┌─ defend ──────────────────┐    ┌─ own ─┐
  │ 1 pitch · 2 arch    │ →  │ 3 choices · 4 scale ·     │ →  │ 7 cf  │
  │                     │    │ 5 failure · 6 hard parts  │    │ 8 AI  │
  └─────────────────────┘    └───────────────────────────┘    └───────┘
```

  ## How to use this book

  **First read.** One chapter per sitting, in order. Read the prose. Look at the diagrams. Read the callouts. The chapter is a continuous narrative — don't skim.

  **Second read.** Skim each chapter's pull quotes and the one-page summary at the end. These are the lines you'll carry in.

  **Night before.** Read only the one-page summaries. Eight pages. Twenty minutes.

  **In the room.** You won't recall any specific line of this book under pressure. What you'll recall is the *picture* — the four-box diagram above. Start every answer by re-drawing it (literally on the whiteboard, mentally if remote). Every defense in this book hangs on that picture.

## The relationship to the concept files

This book is the project-level defense. When an interviewer asks "tell me about a project" — read this book. When they drill into one pattern ("explain your DataSource seam" / "explain the agent loop"), read the matching concept file under `.aipe/study-system-design/` or `.aipe/study-ai-engineering/`. The Interview defense blocks inside those concept files defend one decision in depth. This book defends the whole project at a wide angle.

Pair them. The book without the concept files leaves you fluent on the surface and frozen on the first real follow-up. The concept files without the book leave you deep on one pattern and unable to walk the system.

## A note on the 2026 reality

You built this with significant AI assistance. The interviewer knows it. They will ask. What separates the strong answer from the weak one is not whether you used AI — that's table stakes — but whether you understood what you shipped well enough to own it. Chapter 8 treats that question directly. But the AI-honest posture runs through every chapter. When a decision was AI-suggested and you accepted it, the book teaches you to say so. When AI's default became a real bug, the book teaches you to name the bug and the fix.

The strongest answer is grounded. The weakest is evasive. There is no in-between.
