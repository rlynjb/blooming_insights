# Overview — the ten-minute run-of-show

You built a multi-agent AI analyst for Bloomreach. In the demo slot you have exactly one job: get the room to see it thinking, and get them there before the two-minute mark. Everything else is scaffolding around that moment.

This book is the choreography. Six chapters, one per beat of the slot, plus this overview and a Q&A prep chapter that runs after the clock. Read it front-to-back to rehearse. On the day, you're holding the one-page run sheets from each chapter — nothing else.

  ## What you are actually demoing

  blooming insights runs the loop a human data analyst runs — **what changed, why, what to do** — and streams the agents' reasoning to the UI as a first-class surface. The room does not just see the answer; they see the queries, the hypotheses, the tool calls, and the moment the agent commits to a diagnosis. That live trace is the differentiator.

  You also ship a full evaluation flywheel around it. Not a demo of a demo — a real one, with 10 golden cases, per-dimension pass rates, a committed baseline at `eval/baseline.json`, a regression gate that blocks PRs on any dim regressed more than 10pp, and a fault-injection load harness that seeds a PRNG so a judge can replay the exact failure sequence. That flywheel is your L5 senior-signal chapter and it earns its own beat late in the demo.

  ## The whole slot on one timeline

  Here is the ten minutes, with every chapter's budget and the money-shot marker in place. When you're on stage this is the picture in your head.

```
  THE TEN-MINUTE RUN-OF-SHOW

  0:00 ┌────────────────────────────────────────────────────────┐
       │ 01  COLD OPEN — the hook + the one-liner    0:00–1:00   │  1:00
  1:00 ├────────────────────────────────────────────────────────┤
       │ 02  THE DEMO — live-synthetic run           1:00–6:00   │  5:00
       │        ★ MONEY SHOT at ~2:30 — the trace fills the      │
       │          screen with real reasoning + tool calls        │
       │        ★ side-quest at ~5:00 — eval:load fault receipt  │
       │          → cut to eval:report money-shot table          │
  6:00 ├────────────────────────────────────────────────────────┤
       │ 03  UNDER THE HOOD — the DataSource seam    6:00–8:00   │  2:00
  8:00 ├────────────────────────────────────────────────────────┤
       │ 04  BUILD STORY — five phases, receipts     8:00–8:45   │  0:45
  8:45 ├────────────────────────────────────────────────────────┤
       │ 05  CLOSE — the ask + the last line         8:45–9:30   │  0:45
  9:30 ├────────────────────────────────────────────────────────┤
       │     buffer                                  9:30–10:00   │  0:30
 10:00 └────────────────────────────────────────────────────────┘

       06  Q&A  ← prep only; runs after the clock; never eats it
```

  Two things about that timeline. The money shot lands inside the first third — you never bury it. And the demo has a floor: the room has to see the agent actually reason. Everything else is a ceiling and cuts before the demo does.

  ## The demo path — `bi:mode = live-synthetic`

  You have three modes. `demo` replays a committed snapshot (fastest, but the room sees a canned result). `live-bloomreach` runs against the real MCP server (rate-limited, tokens revoke after minutes, wifi-dependent). `live-synthetic` is the one you rehearse and the one you present: real Claude, real agent reasoning, in-process deterministic ecommerce data, no creds, no upstream dependency.

  This is the demo path because it is honest and reliable at once. The fake is the data, not the agent behavior. When a judge asks "isn't synthetic just fake data," Chapter 06 has the verbatim answer.

  ## The master demo picture

  Here is the shape the room sees. Feed on the left, streaming reasoning on the right, the trace filling the panel with real tool calls as the agent works. Return to this picture in Chapter 02.

```
  What the room sees — the split-panel live trace

  ┌─ browser (max-w-5xl, dark mode) ──────────────────────────────┐
  │                                                                │
  │  header:  blooming insights / your workspace, in bloom         │
  │           workspace stats · [ mode toggle: live-synthetic ]    │
  │                                                                │
  │  ┌─ Col 1 (2/3) ──────────────┐ ┌─ Col 2 (1/3) ─────────────┐ │
  │  │                             │ │  StatusLog (sticky)        │ │
  │  │  InsightCard  · critical    │ │                            │ │
  │  │    usa purchase_revenue     │ │  ► monitoring agent        │ │
  │  │    −38.4%                   │ │    reasoning: "the drop is │ │
  │  │    prior 145k → now 89k     │ │     concentrated in usa…"  │ │
  │  │    via execute_analytics_eql│ │                            │ │
  │  │                             │ │  ► tool: execute_eql       │ │
  │  │  InsightCard  · warning     │ │    duration 1.2s  ✓        │ │
  │  │    session_start · −12.1%   │ │                            │ │
  │  │                             │ │  ► diagnostic agent        │ │
  │  │  InsightCard  · info        │ │    "hypothesis 2 supported │ │
  │  │    view_item conversion     │ │     by evidence…"          │ │
  │  │                             │ │                            │ │
  │  └─────────────────────────────┘ └────────────────────────────┘ │
  │                                                                │
  │  QueryBox  [ ask anything about your workspace… ]              │
  │                                                                │
  └────────────────────────────────────────────────────────────────┘

  ★ Money shot: at ~2:30, the right panel is streaming a diagnostic
    trace live and the room sees the agent form a hypothesis, run a
    tool call, and commit to a diagnosis in real time.
```

  ## The five demoable receipts

  Between the live trace and the eval flywheel, you have five concrete demoable receipts. Each one appears in the demo or Q&A. Know all five cold — one of them is the answer to almost every judge probe.

```
  ┌── receipt ─────────────┬── what it proves ──────────────────────┐
  │ 1. live agent trace    │ this is not a mocked demo; the agent   │
  │    (streaming UI)      │ reasons in front of you                │
  ├────────────────────────┼────────────────────────────────────────┤
  │ 2. npm run eval        │ shipped eval flywheel: 10 goldens,     │
  │    (~$1.30, ~46 min)   │ 2 rubrics × 4 dims × 5-pt scale        │
  ├────────────────────────┼────────────────────────────────────────┤
  │ 3. npm run eval:load   │ fault injection through DataSource     │
  │    (FAULT_*=0.1)       │ seam; 9 faults / 3 investigations /    │
  │                        │ 0 failures; seeded PRNG replays it     │
  ├────────────────────────┼────────────────────────────────────────┤
  │ 4. npm run eval:gate   │ regression gate: any dim regressed     │
  │                        │ >10pp blocks the PR; CI-ready          │
  ├────────────────────────┼────────────────────────────────────────┤
  │ 5. npm run eval:report │ per-phase p50/p95/p99 + per-case cost  │
  │                        │ (~$0.09); cache_read pattern visible   │
  └────────────────────────┴────────────────────────────────────────┘
```

  In the slot, receipt 1 is the money shot. Receipt 3 (the fault side-quest) and receipt 5 (the p50/p95/p99 table) are your closing moves inside Chapter 02. Receipts 2 and 4 come up in Chapter 04 and Chapter 06. Do not try to demo all five live — pick two, tell the story of the other three from the terminal output.

  ## The rehearsal order

  You rehearse this in three passes. Not more, not less.

```
  Rehearsal pass 1 — end-to-end with a timer
  ──────────────────────────────────────────
  → Read chapters 01 → 06 in order
  → Run the whole demo once with a stopwatch
  → Note where you overshoot; cut with the "tighten it" boxes

  Rehearsal pass 2 — run sheets only
  ──────────────────────────────────
  → Close the book; hold just the one-page run sheets
  → Run it again; if you reach for the book, mark the beat
  → Any beat you reach for is a beat that isn't rehearsed

  Rehearsal pass 3 — night-before / morning-of
  ────────────────────────────────────────────
  → Read only the run sheets and the SAY lines
  → Time the money shot from cold to on-screen
  → If money shot > 2:45, cut Chapter 01 opening prose
```

  ## The book shape

  Seven files, read in order. Each chapter opens with its time-budget bar so you always know where you are against the clock.

```
  .aipe/rehearse-hackathon-demo/
    00-overview.md          ← this file
    01-the-cold-open.md     ← 0:00–1:00 · hook + one-liner
    02-the-demo.md          ← 1:00–6:00 · centerpiece + money shot
    03-under-the-hood.md    ← 6:00–8:00 · DataSource seam + agent loop
    04-the-build-story.md   ← 8:00–8:45 · five phases, receipt-backed
    05-the-close.md         ← 8:45–9:30 · the ask + the last line
    06-the-qa.md            ← after the clock · verbatim judge answers
```

  ## Connection to the rest of the study system

  This book presents the project. When the demo ends and the room asks "how does it actually work" — the interview defense book in `.aipe/rehearse-interview-defense/` carries those answers. The concept files in `.aipe/study-*/` are the deepest layer, when a judge drills into one specific mechanism and you need the full walkthrough behind the answer. This book stays demo-shallow on purpose. Do not try to defend the whole architecture inside the ten-minute slot.

  ┃ "The demo shows you the thing working. The interview defense book answers the questions after."

  ## What must not slip

  Three rules govern everything downstream. Everything else can flex.

  → The money shot lands by 2:30. Cut opening prose before you delay it.

  → The demo path is `live-synthetic`. Not `demo`, not `live-bloomreach`. If the terminal has creds cached and it's tempting to switch to `live-bloomreach` because "the real thing is more impressive," resist — token revocation on the alpha MCP server has killed a demo before, and it will kill this one.

  → The eval flywheel is shipped, not aspirational. Every time you mention `eval:report`, `eval:gate`, or `eval:load`, you can point at `eval/baseline.json` in the repo and at a receipt in `eval/receipts/`. Never say "we plan to add" — you already did.
