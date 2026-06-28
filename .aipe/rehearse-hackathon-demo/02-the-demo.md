# Chapter 2 — The demo   (1:00 – 6:00, 5 minutes)

## Opening hook

This is the chapter. Half the slot. The room is going to remember exactly two things from the entire ten minutes — the **money shot** at 2:00, and whether the click-path that follows it felt real or staged. Everything else in the book is in service of these five minutes landing.

The trap of a five-minute live demo is the temptation to show every feature. **Don't.** You are showing one path — the analyst loop end-to-end on one anomaly — and the path was chosen because every screen on it earns the next one. The discipline is to resist the half-finished settings page, the secondary tab, the "oh and we also have…" detour. Five screens. One narrative. Hands off the keyboard at 6:00.

The mode is `live-synthetic`. Repeat that out loud to yourself before you walk on. Not `demo` (no live agents), not `live-bloomreach` (alpha tokens revoke). `live-synthetic` runs the real four-agent loop, real Claude model, real reasoning trace, against in-process synthetic ecommerce data. Creds-free, deterministic, 30 to 90 seconds for a full briefing. **This mode exists because of this room.**

## The time-budget bar

Five minutes. The money shot is at 2:00. By 6:00 your hands are off the keyboard.

```
  1:00 ┌─────────────────────────────────────────────────────────────┐
       │ ░░░░▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░░░░░░░ │
       │                                                              │
       │ 02  THE DEMO  ← you are here                   1:00 – 6:00   │
       │                                                              │
       │     ★ money shot lands at 2:00 (trace fills the sidebar)     │
       │     first insight card appears ~3:30                         │
       │     recommendation lands ~5:30                                │
  6:00 └─────────────────────────────────────────────────────────────┘
```

The money shot is **the moment the streaming reasoning trace fills the right column with the agent's actual queries, hypotheses, and numbers.** Not the first card. Not the recommendation. The trace itself. That is the thing nobody else is shipping and the thing the room reacts to first.

## The click-path — five screens on one diagram

This is the choreography. Memorize it. Every left-column event is something you do; every right-column event is what fills the screen and what you say.

```
THE DEMO CLICK-PATH — five screens, five minutes

  ┌─ SCREEN 1 ─ feed (empty) ─────────────────────┐   YOU: click "start briefing"
  │  empty cards column, sticky StatusLog right    │   ▼  trace begins streaming
  └────────────────────────────────────────────────┘
                       │
                       ▼  ~30 seconds of agent reasoning streams in
  ┌─ SCREEN 1' ─ feed (trace filling) ────────────┐   ★ MONEY SHOT at ~2:00 ★
  │  empty cards still | trace rolling in right    │   The room sees the agent's
  │  - "scanning purchase events 90d vs prior 90d" │   actual work — queries,
  │  - tool call: execute_analytics_eql (running)  │   numbers, hypotheses
  │  - "purchase_revenue dropped 38% in USA"       │
  │  - tool call complete (847ms)                  │
  └────────────────────────────────────────────────┘
                       │
                       ▼  monitoring done → cards render
  ┌─ SCREEN 2 ─ feed (cards) ─────────────────────┐   YOU: pause; let the room
  │  3 InsightCards: severity dot, headline,       │   read one card
  │  summary, why it matters, prior→now bars       │   ▼  click the critical one
  └────────────────────────────────────────────────┘
                       │
                       ▼  navigate to investigate/[id]
  ┌─ SCREEN 3 ─ investigate (step 2) ─────────────┐   diagnostic agent runs
  │  InvestigationSubject banner top               │   trace streams right
  │  EvidencePanel: conclusion, evidence,          │   YOU: read the conclusion
  │  hypotheses, affected-customers callout        │   line out loud
  │  "see recommendations →" button bottom         │   ▼
  └────────────────────────────────────────────────┘
                       │
                       ▼  click "see recommendations →"
  ┌─ SCREEN 4 ─ investigate (step 3) ─────────────┐   recommendation agent
  │  RecommendationCards: feature chip,            │   runs, lands ~5:30
  │  confidence dot, numbered steps,               │   YOU: point at the
  │  highlighted "expected impact" callout         │   "expected impact" box
  └────────────────────────────────────────────────┘
                       │
                       ▼  6:00 — hands off
                  HAND OFF TO CHAPTER 03
```

Five screens. Notice the second screen is the same as the first — the *change* is the trace filling in. That is on purpose. The money shot is not a navigation. It is the right column coming alive while the left column is still empty.

## The body — the five beats walked

### Beat 1 — start the briefing   (1:00 – 1:30)

You are coming out of the cold open with the cursor already on "start briefing." The trace begins immediately. You stop talking and let the first three lines stream in before you say anything else.

```
  SHOW (on screen)                  SAY (out of your mouth)
  ────────────────────────────────  ──────────────────────────────────────
  trace line: "monitoring agent      "There it is — the monitoring agent is
   scanning purchase events…"        scanning the workspace for what changed
                                      in the last 90 days."
  tool_call_start: execute_eql       "Every line you see is the agent's
                                      actual reasoning streaming live —"
  tool_call_end (847ms) →            "— and every tool call is real EQL
                                      hitting the data, with the latency."
```

The trick: you are **labeling what the room is already watching**, not predicting it. The trace moves first; your sentence describes what just appeared.

### Beat 2 — the money shot   (~2:00)

This is the moment. By around 2:00 the right column has five to eight trace lines visible, two or three tool calls expanded, real numbers showing, and the left column still empty. **Stop talking for three full seconds and let the room read it.**

```
  SHOW (on screen)                  SAY (out of your mouth)
  ────────────────────────────────  ──────────────────────────────────────
  trace fills sidebar with real       [silence — three seconds]
  reasoning + numbers + tool calls
                                      "This is the product. An analyst
                                       that shows its work."
```

The script line you nail verbatim, after the silence:

```
┃ "This is the product. An analyst that shows its work."
```

That sentence is the entire pitch in eight words. You will hear yourself want to add to it. **Do not.** The silence + the eight words is the money shot. The room is doing the work of being impressed; you are not in the way.

### Beat 3 — the cards land   (2:30 – 3:30)

Monitoring finishes. Three `InsightCard`s render into the left column with severity dots, the headline like `usa purchase_revenue · -38.4%`, the agent-written "why it matters" line, and the prior-vs-now comparison bars. You pause again. Let the room scan one card.

```
  SHOW (on screen)                  SAY (out of your mouth)
  ────────────────────────────────  ──────────────────────────────────────
  3 InsightCards render               "Three anomalies, ranked by severity.
                                       The agent wrote the headline, wrote
                                       why it matters for the business,
                                       and showed the prior-vs-now numbers."
  hover the top card                  "I'm going to drill into the worst
                                       one — USA purchase revenue down 38%."
```

You do not read every card. You point at one. The card is `components/feed/InsightCard.tsx`; the agent wrote everything on it including the impact line.

### Beat 4 — diagnosis   (3:30 – 5:00)

Click the card. The page navigates to `app/investigate/[id]/page.tsx`. A second agent — the diagnostic — picks up where monitoring left off. Trace streams again, this time forming and testing hypotheses against the data. The `EvidencePanel` lands.

```
  SHOW (on screen)                  SAY (out of your mouth)
  ────────────────────────────────  ──────────────────────────────────────
  investigate page loads,             "A second agent picks up — diagnostic.
   subject banner top                  Same workspace, different job."
  trace streaming hypotheses          "Watch — it's forming hypotheses,
                                       testing each one against the data,
                                       sizing the affected customer segment."
  EvidencePanel renders               "Conclusion, evidence list, what it
                                       ruled out, and how many customers
                                       are in the segment that's hurting."
  hover the conclusion line           [read the one-sentence conclusion
                                       verbatim from the screen]
```

The streaming hypotheses moment is the second-strongest beat in the demo. The trace shows the agent saying "maybe it's the checkout funnel — checking" then "no, conversion's flat — what about traffic?" — actual reasoning steps the room can read.

### Beat 5 — recommendation   (5:00 – 6:00)

Click "see recommendations →." Third agent runs — the recommendation agent — and gets the diagnosis handed to it. `RecommendationCard`s land with the Bloomreach feature chip, numbered steps, and the highlighted "expected impact" callout.

```
  SHOW (on screen)                  SAY (out of your mouth)
  ────────────────────────────────  ──────────────────────────────────────
  recommend page loads                "Third agent — recommendation. Gets
                                       the diagnosis handed to it."
  trace streaming                     "It proposes Bloomreach actions —
                                       scenarios, segments, campaigns —"
  RecommendationCards land            "— each with steps a marketer can run,
                                       a confidence dot, and —"
  point at "expected impact" box      "— an expected impact, so they know
                                       what they're buying."
  pause — hands off keyboard at 6:00  [silence — hand off to chapter 03]
```

The closing script line for the demo chapter:

```
┃ "Three agents, one continuous trace. What changed. Why. What to do."
```

Hands off the keyboard at 6:00. The screen stays on the recommendation. You walk into chapter 03 with the recommendation card still visible behind you.

## Weak demo move versus strong demo move

This is the failure pattern this chapter trains against. Both columns describe the same five screens; only the talk track differs.

```
WEAK MOVE                             STRONG MOVE (yours)
──────────────────────────────────    ──────────────────────────────────
narrates the clicks:                  speaks value while hands click:
"I'm clicking the start button…"      "Every line is the agent's actual
"now I'm hovering over the card…"      reasoning, streaming live."
"this navigates to investigate…"       "A second agent picks up — same
                                       workspace, different job."
talks over the trace                   pauses for the trace to fill
fills every silence                    lets the screen do the work
0:00 of silent reading time            ~12s of silent reading time across
                                       the five beats — the moments the
                                       room is doing the impressing
```

The narrate-the-clicks failure is so common it's almost a reflex. The SAY column in every beat above exists to give your mouth somewhere else to go.

## If it breaks

The demo has three failure modes. Each one has a backup.

```
╔══════════════════════════════════════════════════════════════════════════╗
║ IF IT BREAKS — the three failure modes                                    ║
║                                                                            ║
║  1. Anthropic API returns a 5xx or rate-limits mid-trace                  ║
║     → trace stalls past 15 seconds. Flip toggle to `demo` (top-right),    ║
║       reload. The cached snapshot replays the same screens with the same  ║
║       trace. Say: "I'm switching to a cached run so we don't burn the     ║
║       clock — same agents, same outputs, just from earlier today."         ║
║                                                                            ║
║  2. Dev server crashed / page won't load                                  ║
║     → `cmd-tab` to the recorded 90-second screen capture (saved in        ║
║       ~/Desktop/blooming-demo-clip.mov). Say: "let me show you the run   ║
║       from this morning" and narrate the same five beats over the clip.   ║
║                                                                            ║
║  3. Money shot doesn't land — trace is too sparse, room isn't reacting    ║
║     → don't try to rescue it with words. Skip to clicking the first       ║
║       card. The cards landing is the second-best money shot. Say:         ║
║       "and here's what it found" and keep moving.                         ║
║                                                                            ║
║ Rule: never apologize twice. Never explain the error in detail. Keep      ║
║ moving forward. The recovery line + the next click is enough.              ║
╚══════════════════════════════════════════════════════════════════════════╝
```

The `demo` mode backup is the load-bearing one. Test it the morning of by toggling and reloading — it should serve in under a second from `lib/state/demo-*.json`. If `demo` mode is broken, you should know that an hour before you walk on, not in beat 2.

## Tighten it

This is the chapter with the most fat. If the slot is 5 minutes instead of 10, you cut here first.

- **First cut: beat 5 to 30 seconds.** Show only the first RecommendationCard, point at the impact line, hand off.
- **Second cut: beat 3 to 30 seconds.** Three cards render — point at one, skip the prior-vs-now bars, click straight in.
- **Floor — never cut below:** start click → trace fills sidebar → click a card → diagnosis EvidencePanel lands → click → first RecommendationCard. That's the irreducible path that proves the loop runs end-to-end. Three minutes minimum. Below that, the room doesn't see the agents do their thing, and there is no point in any other chapter.

## The one-page run sheet

This is what you hold on stage.

```
╭─────────────────────── THE DEMO — RUN SHEET ─────────────────────────╮
│ Budget: 1:00 – 6:00 (5 min)       Money shot: ~2:00                   │
│ Mode: live-synthetic              Hands off keyboard: 6:00            │
│                                                                        │
│ FIVE BEATS in order:                                                   │
│   1. (1:00) start click → "monitoring agent is scanning…"             │
│   2. (2:00) ★ PAUSE 3 SECONDS ★ "This is the product. An analyst      │
│        that shows its work."                                           │
│   3. (3:00) cards land → point at one → "drill into the worst one"    │
│   4. (3:30) click card → diagnostic runs → read conclusion verbatim   │
│   5. (5:00) "see recommendations →" → point at expected impact box    │
│                                                                        │
│ CLOSE: "Three agents, one continuous trace. What changed. Why.        │
│         What to do." [silence — walk into chapter 03]                  │
│                                                                        │
│ IF IT BREAKS:                                                          │
│   - trace stalls > 15s → toggle to `demo`, reload                     │
│   - server crashed → cmd-tab to recorded clip                          │
│   - money shot flat → skip to cards landing, keep moving               │
│                                                                        │
│ TIGHTEN IT:                                                            │
│   cut order: beat 5 → beat 3 → beat 4 prior-vs-now hover               │
│   FLOOR: start → trace → click card → diagnosis → recommendation       │
╰────────────────────────────────────────────────────────────────────────╯
```
