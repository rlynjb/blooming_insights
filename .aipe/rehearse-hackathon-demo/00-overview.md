# Overview — the run of show

This book is the demo script for **blooming insights** — the multi-agent Bloomreach analyst that streams its reasoning to the screen. Seven files. One overview, six chapters, read front-to-back to rehearse and held as run sheets on stage. The clock is the boss of every page in here.

You are not preparing a talk. You are preparing a **ten-minute live demo** where a room of judges decides in the first ninety seconds whether the thing on screen is real. The book exists to make sure that decision goes your way.

## The whole slot on one timeline

Here is the entire ten-minute window with every chapter sitting in its slice. The money shot lands at **2:00** — inside the first third, where it belongs.

```
THE TEN-MINUTE RUN OF SHOW

  0:00 ┌─────────────────────────────────────────────────────────────┐
       │ 01  COLD OPEN + ONE-LINER                       0:00 – 1:00 │  1:00
  1:00 ├─────────────────────────────────────────────────────────────┤
       │ 02  THE DEMO  (centerpiece)                     1:00 – 6:00 │  5:00
       │      ★ MONEY SHOT — the trace fills the sidebar at 2:00 ★    │
       │      (first anomaly card lands ~3:30; recommendation ~5:30) │
  6:00 ├─────────────────────────────────────────────────────────────┤
       │ 03  UNDER THE HOOD                              6:00 – 8:00 │  2:00
       │      (the 4-agent loop + the DataSource seam, one diagram)  │
  8:00 ├─────────────────────────────────────────────────────────────┤
       │ 04  THE BUILD STORY  (Phases 1–4)               8:00 – 8:45 │  0:45
  8:45 ├─────────────────────────────────────────────────────────────┤
       │ 05  THE CLOSE + THE ASK                         8:45 – 9:30 │  0:45
  9:30 ├─────────────────────────────────────────────────────────────┤
       │     BUFFER (breathing room, do not fill)        9:30 –10:00 │  0:30
 10:00 └─────────────────────────────────────────────────────────────┘

       06  THE Q&A  ← runs AFTER the clock. Prep only. Never eats the slot.
```

Two things to internalize before any other reading. The demo owns half the slot — every other beat exists to make that five minutes land harder. And there is **thirty seconds of buffer**. You are not planning to use the full ten minutes. You are planning to finish at 9:30, hands off the keyboard, the last sentence hanging.

## The master picture — what the app does

This is the one diagram you mentally hold while you present. Everything in chapter 02 is the audience watching this diagram come to life left-to-right.

```
WHAT BLOOMING INSIGHTS DOES — the analyst loop on one screen

  ┌─ 1. MONITORING ─────────┐  ┌─ 2. DIAGNOSIS ────────┐  ┌─ 3. RECOMMENDATION ─────┐
  │  scans 90-day windows    │  │  picks one anomaly,   │  │  proposes Bloomreach    │
  │  finds anomalies         │  │  forms hypotheses,    │  │  scenario / segment /   │
  │  ranks by severity       │  │  tests against data,  │  │  campaign / voucher /   │
  │  states why it matters   │  │  cites evidence       │  │  experiment + impact    │
  └────────────┬─────────────┘  └───────────┬───────────┘  └─────────────┬───────────┘
               │                            │                            │
               ▼                            ▼                            ▼
  ┌─────────────────────────────────────────────────────────────────────────────────┐
  │  STREAMING REASONING TRACE — every step, every tool call, every number, live    │
  │  (this is the product differentiator — "an analyst that shows its work")        │
  └─────────────────────────────────────────────────────────────────────────────────┘
```

If a judge remembers one thing tomorrow morning, you want it to be that bottom band. The trace is the thing nobody else is shipping.

## The mode you are demoing in

Three modes exist in the codebase. **You are using `live-synthetic`.** Memorize this.

```
THE THREE MODES — pick one and stop second-guessing

  ┌─ demo ──────────────────┬─ live-bloomreach ───────┬─ live-synthetic ────────┐
  │  cached snapshot         │  real Bloomreach + OAuth│  real agents + Claude    │
  │  sub-second              │  alpha tokens revoke     │  in-process synthetic    │
  │  no real agent work      │  unsafe on stage         │  creds-free, ~30–90s     │
  │  ✗ no live reasoning     │  ✗ judges see auth fail  │  ★ THE DEMO PATH ★      │
  └──────────────────────────┴──────────────────────────┴──────────────────────────┘
```

`live-synthetic` is what wins this room. It runs real agents, real Claude model, real reasoning trace — against in-process synthetic ecommerce data. No OAuth handshake. No upstream that can go down. **The fake is the data, not the agent behavior.** That distinction is the heart of the demo and you will say it out loud in chapter 02.

`demo` is your fallback if Anthropic returns a 5xx on stage. `live-bloomreach` you do not touch in a room of judges.

## How to rehearse — three passes

You rehearse this book in three passes, escalating from comprehension to muscle memory.

**Pass 1 — read it through.** Chapters 01 → 06 in order, in one sitting. No timer. The point is to learn the shape of the run and what each chapter is teaching you to do differently.

**Pass 2 — run it end-to-end with a timer.** Open the app at `localhost:3000` in `live-synthetic`, hit start, run through every chapter's SAY/SHOW tracks out loud, look at the clock at every chapter boundary. If you are over time at any boundary, the chapter's "tighten it" treatment tells you the line to drop. Do this **at least three times** before the day of.

**Pass 3 — night before and morning of.** Read only the **one-page run sheets** at the bottom of each chapter. Run the demo once on the morning, timed, in `live-synthetic`, in the venue's wifi if you can get there early. The run sheets are what you hold on stage.

## The relationship to the rest of the book family

This book is in a family. Each one is for a different room.

```
THE THREE ROOMS

  ┌─ /aipe:study ────────┬─ /aipe:rehearse-interview-defense ─┬─ THIS BOOK ─────┐
  │  understand the work │  defend the work                    │  show the work   │
  │  (you, alone, deep)  │  (one interviewer, technical depth) │  (room + clock) │
  └──────────────────────┴─────────────────────────────────────┴──────────────────┘
```

This book lands the wow. The interview defense book — `.aipe/rehearse-interview-defense/` — answers the "okay so how does it actually work" questions that come after. Chapter 06 here is the **stage Q&A** subset (3 minutes of questions after the buzzer); the defense book is for the 45-minute follow-up loop.

If you only read one thing the night before: **chapter 02's run sheet**. The demo is the chapter that wins or loses this for you. Everything else is in service of it.
