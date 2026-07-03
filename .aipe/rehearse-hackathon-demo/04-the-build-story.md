# Chapter 04 — The build story (8:00–8:45, 45 seconds)

You have 45 seconds. This is the shortest chapter in the book. The job is to prove the demo you just showed is a real build with real receipts — not a pitch deck, not a weekend prototype dressed up in slides. You do that by naming the five phases of what actually shipped and the one hard part you cracked.

You do not tour every phase. You name the arc, spotlight one, and get out. The receipts you're pointing at are already visible in the terminal from Chapter 02 — the eval flywheel, the fault-injection numbers, the baseline. This chapter connects the demo back to the codebase.

  ## The time-budget bar

  You own 45 seconds. This is a compressed chapter by design — the build story earns its place, but it does not deserve two minutes of a ten-minute slot.

```
  ┌──────────────────────────────────────────────────────────┐
  │ ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░▓▓▓░░░░░░░░░░░░░  │
  │ 0:00 ── 1:00 ─────────────── 6:00 ── 8:00 ── 8:45 ── 10:00 │
  │        BUILD STORY — you own 8:00 to 8:45 (45 seconds)     │
  └──────────────────────────────────────────────────────────┘
```

  ## The one diagram — the five-phase build arc

  This is the picture you flash on screen for 45 seconds. Not read aloud — flashed. The room glances at it while you speak two sentences.

```
  Five phases — the build arc

  ┌── Phase 1 ────────────┐
  │ hand-rolled agent loop │
  │ (runAgentLoop)         │  needed maxToolCalls budget +
  │                        │  forced synthesis turn —
  │  lib/agents/base-       │  off-the-shelf loops didn't
  │  legacy.ts (kept)       │  give me that
  └──────────┬────────────┘
             │
             ▼
  ┌── Phase 2 ────────────┐
  │ own MCP server         │
  │ + DataSource seam      │  first use of the seam:
  │                        │  proved it by USING it,
  │  lib/data-source/       │  not by talking about it
  │  {bloomreach,synthetic} │
  └──────────┬────────────┘
             │
             ▼
  ┌── Phase 3 (retired) ──┐
  │ eval flywheel on       │
  │ Olist SQLite substrate │  surfaced 3 real bugs.
  │                        │  RETIRED — substrate was
  │  substrate retired;     │  wrong; the receipts moved
  │  learnings kept         │  forward to Phase 5
  └──────────┬────────────┘
             │
             ▼
  ┌── Phase 4 ────────────┐
  │ migrate to             │
  │ @aptkit/core           │  three adapter classes;
  │                        │  legacy loop at
  │  lib/agents/            │  base-legacy.ts as
  │  aptkit-adapters.ts     │  rollback receipt
  └──────────┬────────────┘
             │
             ▼
  ┌── Phase 5 ──────────────┐
  │ portfolio hardening      │  ★ THIS IS THE CHAPTER
  │ end-to-end               │
  │                          │  shipped, measured, gated,
  │  Sessions A–D:           │  demoable via one command.
  │   A prompt caching live  │
  │   B env-driven MCP url   │  A: cuts input tokens on
  │   C fault + gate + CI    │     repeated turns
  │   D per-request UI       │  B: MCP_URL env instead
  │     override (settings)  │     of hard-coded
  │                          │  C: budget cap, 9/3/0
  │  eval/ + eval:report     │     fault receipt, CI gate
  │  + eval:load + eval:gate │     at >10pp
  │                          │  D: settings modal +
  │                          │     x-bi-mcp-config header
  │                          │     — live swap on stage
  └──────────────────────────┘
```

  ## The verbatim script — 45 seconds

  You are pointing at the diagram. Two sentences on the arc, one on the hard part, one on the receipts. Four beats. Do not extend.

```
  SHOW (on screen)                    SAY (out loud)
  ────────────────────────            ──────────────────────────
  flash the five-phase                "five phases got me here.
  diagram; do NOT walk each           i hand-rolled the agent loop
  box                                  because i needed a
                                       maxToolCalls budget and a
                                       forced synthesis turn.
                                       then i built my own MCP
                                       server and put a seam in
                                       front of it — the
                                       DataSource port you just
                                       saw."
  ────────────────────────            ──────────────────────────
  (still on diagram)                  "phase three was an eval
                                       flywheel on a wrong
                                       substrate — i retired it,
                                       kept the learnings, and
                                       rebuilt it right in phase
                                       five. that's the flywheel
                                       you watched run."
  ────────────────────────            ──────────────────────────
  (still on diagram)                  "the hard part was proving
                                       the seam by USING it —
                                       three adapters, one
                                       decorator, all live. that's
                                       what makes the fault
                                       injection receipt honest."
  ────────────────────────            ──────────────────────────
  hand to Chapter 05                  "prompt caching, the budget
                                       cap, the fault harness at
                                       9/3/0, the regression gate
                                       wired into CI, and the
                                       swappable MCP config you
                                       just watched — all shipped,
                                       measured, and demoable in
                                       one command."
  ────────────────────────            ──────────────────────────
```

  ┃ "Shipped, measured, and demoable in one command."

  That line is the sentence you nail. It is the whole point of the chapter compressed to nine words.

  ## The one hard part — the DataSource seam receipts

  If a judge asks in Q&A "what was the actual hard part," this is the answer you rehearse. It's already in Chapter 06 too, but the seed goes here.

  The seam is easy to build. It is hard to *prove*. Anyone can define an interface and one adapter. What made this seam load-bearing is that it has **five independent uses** — each receipt-backed. The MCP adapter runs in `live-mcp` and hits real OAuth (Bloomreach), or a bearer token, or anonymous — three auth strategies over the same port. The synthetic adapter runs as the default at page load (`live-synthetic`) and drives the demo. The decorator runs in `eval:load` and produces the "9 faults / 3 investigations / 0 failures" receipt. And Session D's settings-modal override lets a visitor swap the URL live via the `x-bi-mcp-config` base64 header — no rebuild, no fork. Each use is a different failure mode; each proved the seam carries the contract.

  ┃ "Anyone can define an interface. Five uses is what makes it load-bearing."

  If you have to cut the hard-part line for time, drop it — but keep the "shipped, measured, demoable" line above. That one is the closer for this chapter.

  ## Strong vs weak — the build story failure mode

  The failure mode here is tour-guiding the whole arc. In 45 seconds you cannot walk five phases. You can name them and spotlight one.

```
  ┌── weak (do not) ───────────────┬── strong (do this) ────────────┐
  │                                 │                                 │
  │ "so first i built the agent     │ "five phases got me here."      │
  │  loop, then i built the MCP     │                                 │
  │  server, then i built the       │ (flash diagram, no walk)        │
  │  eval flywheel, then i migrated │                                 │
  │  to aptkit, then i shipped the  │ spotlight phase 5:              │
  │  hardening plan…"               │  "shipped, measured, gated,     │
  │                                 │   and demoable in one command." │
  │  four minutes gone; room is     │                                 │
  │  scrolling; you're only halfway │  45 seconds; room saw the arc,  │
  │  through and the buzzer is      │  heard the L5 signal, ready for │
  │  coming                         │  the close                      │
  │                                 │                                 │
  └─────────────────────────────────┴─────────────────────────────────┘
```

  The rule: the diagram tours the arc. Your mouth spotlights one phase. Five phases in 45 seconds means the diagram does 4/5 of the work.

  ## IF IT BREAKS — the no-slide backup

  This chapter has one on-screen beat: the five-phase diagram flashed on screen. If the slide fails, the fallback is verbal.

```
  ╔══════════════════════════════════════════════════════════════════╗
  ║ IF IT BREAKS                                                       ║
  ║                                                                    ║
  ║ Slide fails to render:                                             ║
  ║   → skip the diagram, deliver the SAY track from memory            ║
  ║   → the SAY track works standalone — the diagram is a glance,      ║
  ║      not a walkthrough                                              ║
  ║   → close on "shipped, measured, and demoable in one command"      ║
  ║      exactly as scripted                                           ║
  ║                                                                    ║
  ╚══════════════════════════════════════════════════════════════════╝
```

  ## The "tighten it" cut

  This chapter is already the shortest in the book. If you enter it behind clock, cut ruthlessly.

```
  Running long — drop these beats, in this order:

    1. drop the "hard part" sentence
       (the paragraph about three uses of the seam)
       cost: 15 seconds saved. the receipts stay implied.

    2. drop the "phase three retired" sentence
       cost: 10 seconds saved.

    3. skip the diagram entirely; deliver the closing line only
       "five phases. shipped, measured, and demoable in one command."
       cost: 30 seconds saved. this is the floor.

  Floor:
    → the closing line must land. "shipped, measured, and demoable
      in one command" is the whole payoff. drop below that and
      this chapter contributes nothing.
```

  ## One-page run sheet — the build story

  This is what you hold on stage during the 45-second build-story beat.

```
  ╭─ RUN SHEET · CHAPTER 04 · THE BUILD STORY ───────────────╮
  │                                                           │
  │  Budget:     8:00–8:45 (45 seconds)                       │
  │  Money-shot marker:  N/A                                  │
  │                                                           │
  │  Pre-flight:                                              │
  │    → five-phase diagram slide ready                       │
  │                                                           │
  │  Beats:                                                   │
  │    8:00  flash the diagram                                │
  │    8:05  "five phases got me here."                       │
  │    8:10  spotlight P1 (hand-rolled loop) + P2 (seam)      │
  │    8:20  P3 retired + rebuilt in P5 (Sessions A–D)        │
  │    8:30  hard part: "five uses is what makes it           │
  │           load-bearing"                                    │
  │    8:40  "shipped, measured, and demoable in one command" │
  │           → hand to Chapter 05                             │
  │                                                           │
  │  The one line to nail:                                    │
  │    → "shipped, measured, and demoable in one command."    │
  │                                                           │
  │  IF IT BREAKS:                                            │
  │    → slide fails → verbal SAY track only                  │
  │                                                           │
  │  Tighten-it:                                              │
  │    1. drop hard-part sentence (−15s)                      │
  │    2. drop P3 retired sentence (−10s)                     │
  │    3. skip diagram; closer only (−30s)                    │
  │                                                           │
  │  Floor:                                                   │
  │    → "shipped, measured, and demoable in one command"     │
  │                                                           │
  ╰──────────────────────────────────────────────────────────╯
```
