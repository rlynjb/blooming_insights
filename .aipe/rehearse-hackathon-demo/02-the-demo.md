# Chapter 02 — The demo (1:00–6:00, five minutes)

This is the centerpiece. Five minutes, the largest slice of the slot, and the chapter that decides whether the room walks out remembering the product or the pitch. The money shot lands inside the first ninety seconds of this chapter — at ~2:30 on the master clock, well inside the first third of the slot — and everything from there compounds.

You have three beats: the **live-synthetic investigation** (the money shot), the **fault-injection side-quest** (the receipt), and the **eval:report money table** (the closing punch). The demo path is `live-synthetic` end to end. Not `demo`, not `live-bloomreach`. Rehearse this until the muscle memory is automatic.

  ## The time-budget bar

  You own the largest chunk of the slot. The money shot lands early. The two closing receipts land late. Nothing in between is filler.

```
  ┌──────────────────────────────────────────────────────────┐
  │ ░░░░░▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  │
  │ 0:00 ── 1:00 ─────────────── 6:00 ────────────────── 10:00 │
  │        THE DEMO — you own 1:00 to 6:00 (5 minutes)         │
  │                    ★ money shot lands at ~2:30             │
  └──────────────────────────────────────────────────────────┘
```

  ## The click-path — the whole demo on one diagram

  Here is the exact click-path you rehearse. Every arrow is a click or a keystroke; every box is what the room sees on screen. If you can walk this diagram without the page in front of you, you can present it under stress.

```
  The click-path — five minutes, three beats, one money shot

  ┌── 1:00 ─────────────────────────────────────────────────────┐
  │                                                              │
  │  Feed page, StatusLog streaming from the cold open           │
  │  Three anomaly cards render into Col 1 as the trace          │
  │  finishes (from `/api/briefing` NDJSON)                      │
  │                                                              │
  │      ▼ click the top card (critical: usa purchase_revenue)   │
  │                                                              │
  ├── 1:15 ─────────────────────────────────────────────────────┤
  │                                                              │
  │  Investigate page (step 2 — "investigating the issue")       │
  │  InvestigationSubject banner at top                          │
  │  EvidencePanel loading; StatusLog right-hand column starts   │
  │  streaming diagnostic agent reasoning (from `/api/agent`)    │
  │                                                              │
  │      ▼ (do not click — let the trace stream)                 │
  │                                                              │
  ├── 2:30 ────────────────────────────── ★ MONEY SHOT ─────────┤
  │                                                              │
  │  Diagnostic conclusion renders in Col 1                      │
  │  Right panel shows the tool_call blocks (execute_analytics_  │
  │  eql), the hypotheses considered, and the affected-customers │
  │  callout. The trace has visible reasoning steps in the       │
  │  agent's own voice ("hypothesis 2 is supported by…")         │
  │                                                              │
  │      ▼ click "see recommendations →"                         │
  │                                                              │
  ├── 3:00 ─────────────────────────────────────────────────────┤
  │                                                              │
  │  Recommend page (step 3 — "decision & recommendation")       │
  │  RecommendationCards render with feature chip, confidence    │
  │  dot, numbered steps, expected impact callout                │
  │                                                              │
  │      ▼ cmd-tab to terminal                                   │
  │                                                              │
  ├── 4:00 ─── SIDE QUEST ─────────────────────────────────────┤
  │                                                              │
  │  Terminal already has this command pre-typed (do not type    │
  │  live; every second typing is a second lost):                │
  │                                                              │
  │    LOAD_N=5 FAULT_TIMEOUT=0.1 FAULT_MALFORMED_JSON=0.1 \     │
  │      FAULT_SEED=42 npm run eval:load                         │
  │                                                              │
  │      ▼ press Enter                                           │
  │                                                              │
  │  Output scrolls: fault injections annotated, 3 investigations│
  │  complete cleanly, final line reads "9 faults injected,      │
  │  3/3 investigations succeeded"                               │
  │                                                              │
  │      ▼ cmd-tab (or new pane) → run:                          │
  │                                                              │
  ├── 5:00 ─── CLOSING PUNCH ──────────────────────────────────┤
  │                                                              │
  │  Terminal:  npm run eval:report                              │
  │                                                              │
  │  The p50/p95/p99 table renders — per-phase latency and       │
  │  per-case cost from `eval/receipts/`                         │
  │                                                              │
  │      ▼ deliver the closing line                              │
  │                                                              │
  └── 6:00 ─────────────────────────────────────────────────────┘
       Hand off to Chapter 03 — Under the hood
```

  ## Beat 1 — the investigation (1:00–3:00)

  You are landing the money shot. Two clicks: the anomaly card, then wait. The wait is the demo. Do not fill silence — the room's eyes go to the right-hand StatusLog panel where the diagnostic agent's reasoning is streaming, and every word out of your mouth should point at what they're seeing, not narrate the interface.

```
  SHOW (on screen)                    SAY (out loud)
  ────────────────────────            ──────────────────────────
  three anomaly cards visible;        "so — the monitoring agent
  top card is `usa                     ran a period-over-period
  purchase_revenue · −38.4%           scan and flagged three
  · critical`                         changes it thinks matter.
                                       ranked by severity."
  ────────────────────────            ──────────────────────────
  click the top card                  "let's dig into the biggest
                                       one."
  ────────────────────────            ──────────────────────────
  investigate page loads;             "now the diagnostic agent is
  StatusLog on right starts            forming hypotheses. what
  streaming reasoning + tool           you're seeing on the right
  calls in real time                   is not a mock — that's the
                                       actual model output. each
                                       tool call runs EQL against
                                       the workspace and comes back
                                       with real numbers."
  ────────────────────────            ──────────────────────────
  ★ 2:30 — diagnostic                 "there it is — hypothesis 2
  conclusion renders; hypothesis      is supported, hypothesis 1
  section fills; affected-             is not. it sized the affected
  customers callout appears           segment, cited its evidence,
                                       and named a diagnosis. that's
                                       the money shot for me."
  ────────────────────────            ──────────────────────────
```

  ┃ "That is not a mock. What you just watched is the actual model reasoning against real numbers."

  The money-shot line is the one you nail verbatim. Rehearse it until it lands the same way every time.

  ## Beat 2 — the recommendation (3:00–4:00)

  A quick beat. Click through, let the RecommendationCards render, name the "expected impact" callout. Do not linger — the room is still processing the money shot, and this beat is the payoff, not a second climax.

```
  SHOW (on screen)                    SAY (out loud)
  ────────────────────────            ──────────────────────────
  click "see recommendations →"       "the third agent takes the
                                       diagnosis and turns it into a
                                       Bloomreach action —"
  ────────────────────────            ──────────────────────────
  RecommendationCards render          "— a scenario, or a segment,
  with feature chip, confidence       or a campaign. each carries
  dot, numbered steps, expected       a confidence level and an
  impact callout                      expected impact. it doesn't
                                       just tell you what happened.
                                       it tells you what to do about
                                       it."
  ────────────────────────            ──────────────────────────
```

  ┃ "It doesn't just tell you what happened. It tells you what to do about it."

  ## Beat 3 — the fault-injection side quest (4:00–5:00)

  This is where you shift from "look at the product" to "look at the receipts behind the product." You cmd-tab to a terminal that already has the command pre-typed. This detail matters — typing live is a stumble tax you cannot afford.

```
  SHOW (on screen)                    SAY (out loud)
  ────────────────────────            ──────────────────────────
  cmd-tab to terminal, command        "one quick side-quest —
  pre-typed:                          because judges always ask
                                       'yeah but does it handle
   LOAD_N=5 FAULT_TIMEOUT=0.1 \       failure?'"
   FAULT_MALFORMED_JSON=0.1 \
   FAULT_SEED=42                      
   npm run eval:load
  ────────────────────────            ──────────────────────────
  press Enter                         "i'm injecting a 10% timeout
                                       rate and a 10% malformed-JSON
                                       rate into the DataSource
                                       seam. seeded PRNG, so this is
                                       replayable."
  ────────────────────────            ──────────────────────────
  output scrolls; fault-injection     "the agent loop presents each
  annotations visible; final line:    fault to the model as a tool
  "9 faults injected,                 error. the model reads it,
  3/3 investigations succeeded"       reasons around it, retries or
                                       pivots. that's not error
                                       handling — that's the model
                                       negotiating with failure."
  ────────────────────────            ──────────────────────────
```

  ┃ "That's not error handling. That's the model negotiating with failure."

  ## Beat 4 — the eval:report closing punch (5:00–5:45)

  The final punch is a table. You have said the trace is real. You have said the receipts are real. Now you show the numbers.

```
  SHOW (on screen)                    SAY (out loud)
  ────────────────────────            ──────────────────────────
  terminal:  npm run eval:report      "and this is what those runs
                                       cost."
  ────────────────────────            ──────────────────────────
  table renders — per-phase           "per-phase p50, p95, p99
  p50/p95/p99, per-case cost,         latency, per-case cost around
  cost breakdown from                  nine cents. the numbers you're
  eval/receipts/                       looking at are from the eval
                                       receipts committed to the
                                       repo. not aspirational."
  ────────────────────────            ──────────────────────────
```

  ┃ "The numbers you're looking at are from the eval receipts committed to the repo. Not aspirational."

  Hand off to Chapter 03. Do not close on the terminal — pivot to the diagram.

  ## Strong vs weak — the narration failure

  This is the second most common demo failure, right after the cold-open one. Judges have watched it a hundred times. Do not do it.

```
  ┌── weak (do not) ───────────────┬── strong (do this) ────────────┐
  │                                 │                                 │
  │ "so I'm clicking here on the    │ "the monitoring agent ran a     │
  │  top card, and now it's         │  period-over-period scan and    │
  │  loading — you can see the      │  flagged three changes it       │
  │  spinner — and now the page     │  thinks matter."                │
  │  is loading, and here we go,    │                                 │
  │  and — okay so now on the       │ "now the diagnostic agent is    │
  │  right you can see the panel    │  forming hypotheses. what you   │
  │  and it's streaming stuff…"     │  see on the right is the actual │
  │                                 │  model output — each tool call  │
  │  the SAY track is describing    │  runs EQL against the workspace"│
  │  the SHOW track; the room       │                                 │
  │  learns nothing new             │  the SAY track is talking about │
  │                                 │  what the product IS while the  │
  │                                 │  hands do the clicking          │
  │                                 │                                 │
  └─────────────────────────────────┴─────────────────────────────────┘
```

  The rule: the SAY track never describes the SHOW track. They run in parallel — the SAY track speaks value while the hands do the clicking. Narrating clicks makes a demo feel like a tutorial.

  ## IF IT BREAKS — three recovery boxes for three failure points

  The demo has three places it can fail live. Each has its own backup. Rehearse each one.

```
  ╔══════════════════════════════════════════════════════════════════╗
  ║ IF IT BREAKS — the investigation trace stalls                      ║
  ║                                                                    ║
  ║ StatusLog stops streaming for >10s after clicking the card:        ║
  ║   → do NOT click the card again                                    ║
  ║   → say: "let me pull up the run I captured earlier — this one is  ║
  ║      identical, same data"                                         ║
  ║   → toggle mode to `demo` (top-right); the snapshot replays        ║
  ║      instantly from `lib/state/demo-investigations.json`           ║
  ║   → the replay is real captured events, filtered per step          ║
  ║   → keep SAY track identical from this point on                    ║
  ║                                                                    ║
  ╚══════════════════════════════════════════════════════════════════╝

  ╔══════════════════════════════════════════════════════════════════╗
  ║ IF IT BREAKS — the fault-injection side quest fails                ║
  ║                                                                    ║
  ║ eval:load doesn't produce clean output (missing deps, node error): ║
  ║   → say: "here's the receipt from the last run I did"              ║
  ║   → have a screenshot open in a second monitor / second tab:       ║
  ║      `eval/load-receipts/latest.txt` — a real receipt from a       ║
  ║      previous run showing "9 injected faults / 3 investigations /  ║
  ║      0 failures"                                                   ║
  ║   → the receipt is in the repo; not slideware                      ║
  ║                                                                    ║
  ║ Cut the side-quest entirely if it fails twice — never a third try  ║
  ║                                                                    ║
  ╚══════════════════════════════════════════════════════════════════╝

  ╔══════════════════════════════════════════════════════════════════╗
  ║ IF IT BREAKS — the eval:report table fails                         ║
  ║                                                                    ║
  ║ eval:report throws or renders empty:                               ║
  ║   → say: "the receipts from the last committed run —"              ║
  ║   → cat the file directly:  cat eval/baseline.json | head -40      ║
  ║   → point at `perDimensionPassRate` and per-phase timings          ║
  ║   → close on: "these are the numbers, committed to the repo"       ║
  ║                                                                    ║
  ╚══════════════════════════════════════════════════════════════════╝
```

  ## The "tighten it" cut

  If Chapter 01 ran long and you enter this chapter behind clock, cut in this order.

```
  Running long — drop these beats, in this order:

    1. drop the RecommendationCard beat (Beat 2).
       skip the click on "see recommendations →"; stay on the
       diagnosis page and pivot to the terminal.
       cost: 60 seconds saved. keeps the money shot intact.

    2. drop the eval:report closing punch (Beat 4).
       stop at "9 faults injected, 3/3 succeeded" and hand off.
       cost: 45 seconds saved. weakens the close but keeps
       the fault receipt.

    3. drop the fault-injection side quest (Beat 3).
       cut straight from money shot to Chapter 03.
       cost: 60 seconds saved. this is your last cut — after
       this you are cutting into the demo floor.

  Floor:
    → the money shot must land. the room must see the agent
      reason live. everything else is negotiable; the money
      shot is not.
```

  ## One-page run sheet — the demo

  This is what you hold on stage during the five-minute centerpiece.

```
  ╭─ RUN SHEET · CHAPTER 02 · THE DEMO ─────────────────────╮
  │                                                          │
  │  Budget:     1:00–6:00 (5 minutes)                       │
  │  Money-shot marker:  ~2:30 (diagnostic conclusion        │
  │                       renders + hypotheses fill)         │
  │                                                          │
  │  Pre-flight (before slot starts):                        │
  │    → localhost tab on feed page, mode = live-synthetic   │
  │    → terminal pane 1: command pre-typed for eval:load    │
  │    → terminal pane 2: eval:report ready                  │
  │    → screenshot of load receipt open in second monitor   │
  │                                                          │
  │  Click-path:                                             │
  │    1:00  click top anomaly card (critical / usa)         │
  │    1:15  wait — StatusLog streams the trace              │
  │    2:30  ★ conclusion + hypotheses render (money shot)   │
  │    3:00  click "see recommendations →"                   │
  │    3:30  RecommendationCards render                      │
  │    4:00  cmd-tab to terminal; press Enter (eval:load)    │
  │    5:00  run:  npm run eval:report                       │
  │    5:45  deliver closing line, hand to Chapter 03        │
  │                                                          │
  │  The three lines to nail:                                │
  │    → "that is not a mock. that's the actual model        │
  │       reasoning against real numbers."                   │
  │    → "that's not error handling. that's the model        │
  │       negotiating with failure."                         │
  │    → "the numbers you're looking at are committed to     │
  │       the repo. not aspirational."                       │
  │                                                          │
  │  IF IT BREAKS (any beat):                                │
  │    → trace stall → toggle mode to `demo`, snapshot       │
  │       replays instantly, keep SAY identical              │
  │    → eval:load fails → open receipt screenshot           │
  │    → eval:report fails → cat eval/baseline.json head     │
  │                                                          │
  │  Tighten-it (in order):                                  │
  │    1. drop RecommendationCards beat (−60s)               │
  │    2. drop eval:report closing (−45s)                    │
  │    3. drop fault-injection side quest (−60s)             │
  │                                                          │
  │  Floor:                                                  │
  │    → the room must see the agent reason live.            │
  │       everything else is negotiable.                     │
  │                                                          │
  ╰─────────────────────────────────────────────────────────╯
```
