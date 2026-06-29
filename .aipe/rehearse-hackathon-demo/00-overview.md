# Overview — the ten-minute run-of-show

You have ten minutes. Your project is **blooming insights** — a multi-agent AI analyst that watches a Bloomreach Engagement workspace, notices what changed, hunts the cause, and proposes the Bloomreach action to take. The pitch is one sentence: *an analyst that shows its work.* The differentiator is the streaming reasoning trace — the agent's queries, hypotheses, and tool calls scrolling beside the answer in real time. That trace **is** the wow. The whole demo is engineered to land it on a clock.

This overview is the run-of-show: every chapter, every minute, the money shot scheduled by name. Read it once before rehearsing. Hold the one-page run sheets at the back of each chapter while presenting.

  ## The whole slot on one timeline

```
  THE TEN-MINUTE RUN-OF-SHOW

  0:00 ┌────────────────────────────────────────────────────────────┐
       │ 01  COLD OPEN + ONE-LINER                  0:00–1:00 │  1:00 │
  1:00 ├────────────────────────────────────────────────────────────┤
       │ 02  THE DEMO (centerpiece)                 1:00–6:00 │  5:00 │
       │       ★ money shot: streaming trace fills the right column  │
       │         while a real anomaly card paints on the left, 2:30  │
  6:00 ├────────────────────────────────────────────────────────────┤
       │ 03  UNDER THE HOOD (the 4-agent loop + DataSource seam)     │
       │                                            6:00–8:00 │  2:00 │
  8:00 ├────────────────────────────────────────────────────────────┤
       │ 04  THE BUILD STORY (shipped + learned + retired)           │
       │                                            8:00–8:45 │  0:45 │
  8:45 ├────────────────────────────────────────────────────────────┤
       │ 05  THE CLOSE + THE ASK                    8:45–9:30 │  0:45 │
  9:30 ├────────────────────────────────────────────────────────────┤
       │     buffer / breathing room                9:30–10:00 │ 0:30 │
 10:00 └────────────────────────────────────────────────────────────┘

       06  THE Q&A  ← prep only; runs after the clock,
                       never counts against the ten minutes
```

The demo owns half the slot. The money shot lands at **2:30** — inside the first third. If you're at 3:00 and the room hasn't gone "oh" yet, you're behind; cut to the recorded clip and recover (see chapter 02 IF-IT-BREAKS).

  ## The master demo diagram — what the app does in one screen

```
  ┌──────────────────────────────────────────────────────────────────┐
  │  blooming insights                                                │
  │  your workspace, in bloom               synthetic blooming · 18k  │
  │  ┌─────────────────────────────────────┐ ┌────────────────────┐ │
  │  │ 1 monitoring  → 2 investigate  → 3 decide      (stepper)   │ │
  │  └─────────────────────────────────────┘ └────────────────────┘ │
  │  ┌─────────────────────────────────────┐ ┌────────────────────┐ │
  │  │  ● usa purchase_revenue ▼ −38.4%    │ │ status log         │ │
  │  │  ┌──────────────────────────────┐   │ │ ▸ scanning events  │ │
  │  │  │ summary: usa revenue dropped │   │ │ ▸ tool: count      │ │
  │  │  │ why it matters: ...          │   │ │ ▸ tool: revenue eql│ │
  │  │  │ scope: usa  ·  prior → now   │   │ │ ▸ found anomaly    │ │
  │  │  │ ████░░░░  via execute_eql    │   │ │ ▸ query 4 / 6 ...  │ │
  │  │  └──────────────────────────────┘   │ │ ────────────────── │ │
  │  │                                     │ │ each line = one    │ │
  │  │  ● eu session_start ▲ +12.1%        │ │   step the agent   │ │
  │  │  ┌──────────────────────────────┐   │ │   actually took    │ │
  │  │  │ ...                          │   │ │                    │ │
  │  │  └──────────────────────────────┘   │ │                    │ │
  │  └─────────────────────────────────────┘ └────────────────────┘ │
  │       left: anomaly cards (the answer)        right: the trace  │
  │                                              (the differentiator) │
  └──────────────────────────────────────────────────────────────────┘
```

The room will see this same screen four times — during the cold open (frozen on the answer), during the demo (alive, painting), in the under-the-hood diagram (with the agent loop overlaid), and once more in your close. Make it the picture they remember.

  ## The mode switch — which path you run on stage

There are three modes the app can run in (the `bi:mode` toggle, persisted in `localStorage`):

```
  demo               ← committed snapshot, instant, no auth, no model call
  live-synthetic     ← real agents · real Claude · deterministic fake data
  live-bloomreach    ← real agents · real Claude · real Bloomreach workspace
```

**Stage path: `live-synthetic`.** Real Claude. Real agent loop. Real streaming trace. No OAuth dance, no token revocation, no network surprises. The data is Blooming-owned synthetic ecommerce (purchase, view_item, session_start, cart_update events). The fake is the data, not the behavior — which is exactly what a demo needs.

**Why not `live-bloomreach` on stage?** The alpha server revokes tokens after a few minutes and rate-limits to ~1 req/s. You will be mid-money-shot when a `401` lands. Don't.

**Why keep `demo` warm in the other tab?** Sub-second time-to-first-event guarantee. If `live-synthetic` is slow on the conference wifi, you switch tabs and the same screen paints from the snapshot. Same shape, same trace, instantly.

  ## How to rehearse this book

```
  ┌─────────────────────────────────────────────────────────────────┐
  │ FIRST PASS    Read chapters 01 → 06 front to back. Run the      │
  │               demo once end-to-end with a timer. Note where     │
  │               you ran long.                                     │
  ├─────────────────────────────────────────────────────────────────┤
  │ SECOND PASS   Run it again holding ONLY the one-page run        │
  │               sheets at the back of each chapter. The prose     │
  │               should already be in your head.                   │
  ├─────────────────────────────────────────────────────────────────┤
  │ NIGHT BEFORE  Skim the run sheets. Time the money shot. Pull    │
  │               the recorded fallback clip up in a tab and        │
  │               leave it there.                                   │
  ├─────────────────────────────────────────────────────────────────┤
  │ MORNING OF    Run the demo once on the actual stage wifi if     │
  │               you can. Confirm the synthetic mode boots inside  │
  │               90 seconds end-to-end. If it doesn't, demo from   │
  │               the committed snapshot — that's exactly what it   │
  │               is for.                                           │
  └─────────────────────────────────────────────────────────────────┘
```

  ## Reading order across the rehearsal family

This book teaches you to **show** the project on a clock. Its sibling at `.aipe/rehearse-interview-defense/` teaches you to **defend** the project under one-on-one probing — the "why this architecture, not that one" questions that come after the demo. The Q&A chapter (06) here covers the room-level probes; the interview defense book covers the deeper dive. Different rooms, different clocks, different jobs.

  ## The four things that absolutely have to happen

```
  ┌─────────────────────────────────────────────────────────────────┐
  │ 1. The room sees the streaming trace paint in real time.        │
  │    This is the money shot. Without it, you have a generic       │
  │    "AI tells me what changed" demo. With it, you have the       │
  │    differentiator.                                              │
  ├─────────────────────────────────────────────────────────────────┤
  │ 2. The one-liner lands in the first 60 seconds.                 │
  │    "Blooming insights is an analyst that shows its work for     │
  │    a Bloomreach workspace." If the room doesn't hear that       │
  │    sentence early, they don't know what they're watching.       │
  ├─────────────────────────────────────────────────────────────────┤
  │ 3. You name the rough edges before judges find them.            │
  │    The eval pipeline that shipped and then got retired. The     │
  │    legacy hand-rolled loop preserved as a rollback receipt.     │
  │    Owning these reads as senior; hiding them reads as junior.   │
  ├─────────────────────────────────────────────────────────────────┤
  │ 4. You end on a beat, not a trail-off.                          │
  │    The last line is the line they repeat to each other in       │
  │    the hallway. Plan it. Say it. Stop.                          │
  └─────────────────────────────────────────────────────────────────┘
```
