# 00 — Overview · the run-of-show

You have ten minutes. The judges have watched four demos before
yours and will watch eight more after. They are tired. They are
making a decision in the first ninety seconds about whether to
listen properly, and another decision at the buzzer about whether
to remember you.

This book is the choreography for those ten minutes. Read it
front-to-back once to rehearse. Hold the one-page run sheets at
the end of each chapter while you present. The money shot is
named. The cut lines are named. The recovery for every on-screen
beat is named.

  ## The whole slot on one timeline

The shape of the presentation, every chapter against the clock,
with the money-shot marker at 3:00. Look at this once a day until
the demo.

```
  THE TEN-MINUTE RUN-OF-SHOW

  0:00 ┌───────────────────────────────────────────────────────────┐
       │ 01  COLD OPEN + ONE-LINER                  0:00–1:00      │  1:00
  1:00 ├───────────────────────────────────────────────────────────┤
       │ 02  THE DEMO (centerpiece)                 1:00–6:00      │  5:00
       │       ★ MONEY SHOT lands at ~3:00 ★                       │
  6:00 ├───────────────────────────────────────────────────────────┤
       │ 03  UNDER THE HOOD                         6:00–8:00      │  2:00
  8:00 ├───────────────────────────────────────────────────────────┤
       │ 04  BUILD STORY                            8:00–8:45      │  0:45
  8:45 ├───────────────────────────────────────────────────────────┤
       │ 05  THE CLOSE + ASK                        8:45–9:30      │  0:45
  9:30 ├───────────────────────────────────────────────────────────┤
       │     buffer / breathing room                9:30–10:00     │  0:30
 10:00 └───────────────────────────────────────────────────────────┘

       06  THE Q&A  ← prep only, runs after the clock
```

The demo owns half the slot. Everything else is the frame around
it. When you run long, you cut from chapters 3, 4, 5 first — in
that order — never from the demo.

  ## The master demo diagram — what blooming insights does

One picture of the whole product, so the judges have a mental
home for everything you show them. This recurs in chapter 2; come
back here when you forget the shape.

```
  blooming insights — what the user actually does

  ┌─ feed ──────────────────────────────────────────────────────┐
  │  monitoring agent ran against the workspace schema           │
  │                                                              │
  │  10-category coverage grid  →  ✓ ✓ ✓ ◐ — — ◐ ✓ — ✓          │
  │                                  (gated by what events       │
  │                                   the workspace emits)       │
  │                                                              │
  │  insight cards (anomalies the agent actually flagged)        │
  │    [critical]  purchases outnumber sessions 2:1              │
  │    [critical]  revenue inflated 10× vs comparable period     │
  │    [warning]   checkout-to-purchase = 89.7% (impossibly high)│
  │       click ▼                                                │
  └─────────────────────────────┬────────────────────────────────┘
                                │
  ┌─ investigate ───────────────▼────────────────────────────────┐
  │  diagnostic agent runs LIVE — reasoning + tool calls stream  │
  │                                                              │
  │  status log (left)             │  diagnosis (right)           │
  │   • thought                    │   conclusion                 │
  │   • tool: execute_analytics_eql│   evidence: 4 queries        │
  │     query: select count event… │   confidence: high           │
  │   • tool: get_event_schema     │   hypotheses tested: 3       │
  │   • hypothesis                 │                              │
  │   • conclusion                 │                              │
  │                                                              │
  │   ★ MONEY SHOT: this whole thing materializes live ★         │
  │       click ▼ "see recommendations"                          │
  └─────────────────────────────┬────────────────────────────────┘
                                │
  ┌─ decide ────────────────────▼────────────────────────────────┐
  │  recommendation agent: 3 typed actions, each with             │
  │  bloomreach feature + steps + estimated impact + confidence  │
  └──────────────────────────────────────────────────────────────┘
```

Three surfaces, three agents, one straight line: see → diagnose →
act. The judges see the line in their first thirty seconds with
your app open, before you say a word about architecture.

  ## What this is — and what it is not

Blooming insights is an AI agent that watches an ecommerce
workspace and surfaces anomalies the business owner should care
about. It runs a real monitoring loop against the live Bloomreach
MCP server, calls real analytics tools, parses real schemas, and
fires a diagnostic agent live when the user clicks a card. The
money shot is the diagnostic agent's reasoning + tool calls
materializing in front of the judges while a structured Diagnosis
crystalizes on the right.

It is not a SaaS product. It is not a multi-tenant deployment.
The judges will assume both. Don't oversell. Demo what is real
and frame what is next in chapter 5.

  ## The rehearsal order

```
  pass 1   read every chapter front to back              ~40 min
           run the demo once end-to-end with a timer

  pass 2   read only the one-page run sheets             ~15 min
           run the demo again, hold the sheets while you go
           confirm the money shot lands at ~3:00

  pass 3   night before / morning of                     ~10 min
           run sheets only · say the money-shot line out loud
           open the recorded clip in a tab as the recovery
```

If you have time for only one pass, make it pass 2. The sheets
are what you actually hold. The chapters teach you why each beat
exists; the sheets are what you do.

  ## How this book connects to the rest of the study system

```
  .aipe/rehearse-hackathon-demo/   ← this book — present the project
                                     (run-of-show, choreography, recovery)

  .aipe/rehearse-interview-defense/ ← answer "how does it actually work?"
                                     (the follow-up after the buzzer)

  .aipe/study-system-design/   ← the deepest follow-ups
  .aipe/study-agent-architecture/    (open these if a judge presses on
  .aipe/study-ai-engineering/        the agent loop, the MCP protocol,
  .aipe/study-prompt-engineering/    or the prompt design)
```

The defense book and the concept files are not your job during
the ten minutes. They are your job for the ninety seconds of Q&A
after — read chapter 6 of THIS book for the prepped answers, and
fall back to the defense book if a judge follows up harder than
expected.

  ## The non-negotiables you carry into the room

```
  → the demo runs in DEMO mode, not LIVE, by default
       (instant · creds-free · same UI as live)
  → the money shot is the diagnostic agent streaming live
       on the investigate page, NOT the coverage grid
  → never narrate clicks ("now I click here")
       speak value while the hands do the clicking
  → if something breaks, switch to the recorded clip and
       keep moving — never apologize twice
  → end on the close line, not on "yeah so that's it"
```

Read chapter 1 next.
