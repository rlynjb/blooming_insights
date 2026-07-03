# Chapter 01 — The cold open (0:00–1:00, 60 seconds)

You have sixty seconds. The room is deciding whether to pay attention or check their phones. The single biggest mistake a hackathon demo makes here is spending this minute on a title slide, a self-introduction, or a problem definition the room could have read in the program. You are going to open on the thing working. Then, once the eyes are up, you name what they're looking at.

Two beats: the **hook** (open cold on the trace streaming) and the **one-liner** (the sentence they repeat to each other in the hallway).

  ## The time-budget bar

  You own the first sixty seconds. When the clock hits 1:00 the cold open is done and the demo begins.

```
  ┌──────────────────────────────────────────────────────────┐
  │ ▓▓▓▓▓░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  │
  │ 0:00 ── 1:00 ─────────────── 6:00 ────────────────── 10:00 │
  │        THE COLD OPEN — you own 0:00 to 1:00 (60 seconds)   │
  └──────────────────────────────────────────────────────────┘
```

  ## The room's attention curve

  This is what a hackathon room's attention actually does across a ten-minute slot. Sketch it in your head before you rehearse — you're not "starting a presentation," you're catching a curve at its lowest point.

```
  Room attention across a ten-minute slot

  high  │       ╭─────────╮                    ╭────╮
        │      ╱           ╲                  ╱      ╲
        │     ╱             ╲                ╱        ╲
  low   ├────╯               ╲──────────────╯          ╲──
        │
        └────────────────────────────────────────────────
             0:15         2:30                8:30  9:30
             ▲            ▲                   ▲
             │            │                   │
     hook lands    money shot lands    close lands
     (this        (Chapter 02)         (Chapter 05)
     chapter)

  The gap in the middle is real. You cannot hold peak attention
  for ten minutes. The job of the cold open is to spike attention
  fast enough that the money shot at 2:30 lands on an already-open
  room.
```

  ## Beat 1 — the hook (0:00–0:30)

  You start with a live browser tab already open on `localhost:3000`. Not a slide. Not "hi, I'm Rein." The tab is open, the mode toggle reads `live-synthetic`, and the feed page is already loaded but sitting quiet. Your first action is a click — the "run monitoring" trigger — and the right-hand StatusLog panel starts streaming.

  You do not narrate the click. You speak value while the click happens.

```
  SHOW (on screen)                    SAY (out loud)
  ────────────────────────            ──────────────────────────
  browser: feed page, quiet,          (silent — let the room notice
  mode toggle set to                   the toggle for one beat)
  `live-synthetic`
  ────────────────────────            ──────────────────────────
  click → StatusLog panel             "when a metric moves on
  starts streaming;                    Bloomreach — a revenue drop,
  reasoning steps appear               a conversion dip — a human
  in real time                         analyst has to notice it,
                                       hunt for the cause, and
                                       figure out which feature
                                       to reach for."
  ────────────────────────            ──────────────────────────
  first tool_call block renders,      "watch. this is my agent
  status dot spinning                  doing that live."
  ────────────────────────            ──────────────────────────
```

  The room is now looking at a panel with visible reasoning and a spinning tool call. That is your hook. You have thirty seconds of budget left.

  ┃ "This is my agent doing that live."

  ## Beat 2 — the one-liner (0:30–1:00)

  Now name what they're looking at. One sentence. This is the sentence you want the judges repeating to each other in the ten seconds between demos. It has to be short enough to land on tired ears at 4pm on a Sunday.

  The one-liner is a specific format: **X is a Y that does Z for W.** You fill it in from the codebase.

```
  ┃ "blooming insights is a multi-agent AI analyst
  ┃  for a Bloomreach Engagement workspace that
  ┃  runs what-changed / why / what-to-do —
  ┃  and streams the agents' reasoning to the UI
  ┃  as a first-class surface."
```

  Then one anchor line for the trace they can see moving:

  ┃ "You are watching that surface right now."

  That is your sixty seconds. Do not add a third sentence. Do not say "and today I want to show you…" — the demo has already started.

  ## Strong vs weak — the cold-open failure mode

  This is the single most common demo failure. Every judge has watched it happen. Do not do it.

```
  ┌── weak (do not) ───────────────┬── strong (do this) ────────────┐
  │                                 │                                 │
  │ "Hi, I'm Rein. I'm a software   │ (click — trace starts streaming)│
  │  engineer pivoting into AI.     │                                 │
  │  Today I want to talk about a   │ "when a metric moves on         │
  │  problem I noticed while working│  Bloomreach, a human analyst    │
  │  on ecommerce products —        │  has to notice it, hunt for     │
  │  marketers struggle to figure   │  the cause, and figure out      │
  │  out why metrics move. So I     │  which feature to reach for.    │
  │  built…"                        │  watch — this is my agent doing │
  │                                 │  that live."                    │
  │  ~90 seconds gone; nothing on   │                                 │
  │  screen yet; room is looking    │  ~30 seconds gone; trace on     │
  │  at their phones                │  screen; room is watching       │
  │                                 │                                 │
  └─────────────────────────────────┴─────────────────────────────────┘
```

  The weak version spends the room's most valuable minute setting up the problem. The strong version puts the problem *inside* the demo — the trace on screen is the problem statement.

  ## IF IT BREAKS — the cold-open backup

  The trace not streaming in the first ten seconds is the single scariest failure in this slot. Have a backup ready.

```
  ╔══════════════════════════════════════════════════════════════════╗
  ║ IF IT BREAKS                                                       ║
  ║                                                                    ║
  ║ Trace doesn't start streaming within 5s of the click:              ║
  ║   → do NOT click again (double-click can cascade)                  ║
  ║   → say: "the network is being polite today — let me show you the ║
  ║      last run I captured"                                          ║
  ║   → hit the mode toggle to `demo` (top-right) and the committed    ║
  ║      snapshot renders instantly from `lib/state/demo-*.json`       ║
  ║   → the trace panel replays real captured events, not a mock       ║
  ║   → keep the SAY track identical — do not apologize twice          ║
  ║                                                                    ║
  ║ Localhost itself is dead (`ECONNREFUSED`):                         ║
  ║   → open the 30-second recorded screen capture (open in a second   ║
  ║      tab before the slot starts)                                   ║
  ║   → say: "I'm going to walk you through a run I did earlier"       ║
  ║   → deliver the one-liner over the recording                       ║
  ║                                                                    ║
  ║ Never say: "sorry, this usually works" — that phrase costs you     ║
  ║ the room's trust for the whole ten minutes.                        ║
  ╚══════════════════════════════════════════════════════════════════╝
```

  ## The "tighten it" cut

  If your rehearsal timer says the money shot is landing past 2:45, the cut here is the first-beat opening pause.

```
  Running long — drop this beat:
    → the silent one-beat pause before the click
    → go straight to the click on 0:00
    → save 5 seconds; money shot moves earlier

  Do not cut:
    → the one-liner (this is the sentence they repeat)
    → the anchor line "you are watching that surface right now"

  Floor:
    → the room must see the trace streaming before the one-liner.
      if they hear the pitch before they see the mechanism,
      you sound like a slide deck. keep the demo leading.
```

  ## One-page run sheet — the cold open

  This is what you hold on stage during the first minute.

```
  ╭─ RUN SHEET · CHAPTER 01 · THE COLD OPEN ────────────────╮
  │                                                          │
  │  Budget:     0:00–1:00 (60 seconds)                      │
  │  Setup:      localhost tab open, mode = live-synthetic,  │
  │              feed page loaded, StatusLog empty           │
  │                                                          │
  │  Money-shot marker:  N/A (money shot is in Chapter 02)   │
  │                                                          │
  │  SAY (in order):                                         │
  │    → (silent beat, notice the toggle)                    │
  │    → click                                               │
  │    → "when a metric moves on Bloomreach, a human         │
  │       analyst has to notice it, hunt for the cause,      │
  │       and figure out which feature to reach for."        │
  │    → "watch. this is my agent doing that live."          │
  │    → "blooming insights is a multi-agent AI analyst      │
  │       for a Bloomreach Engagement workspace that runs    │
  │       what-changed / why / what-to-do — and streams      │
  │       the agents' reasoning to the UI as a first-class   │
  │       surface."                                          │
  │    → "you are watching that surface right now."          │
  │                                                          │
  │  The one line to nail:                                   │
  │    "this is my agent doing that live."                   │
  │                                                          │
  │  IF IT BREAKS:                                           │
  │    → toggle mode to `demo`; snapshot renders instantly   │
  │    → keep SAY track identical; do not apologize twice    │
  │                                                          │
  │  Tighten-it:                                             │
  │    → drop the silent opening pause; click on 0:00        │
  │                                                          │
  ╰─────────────────────────────────────────────────────────╯
```
