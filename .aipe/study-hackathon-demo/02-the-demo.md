# 02 — The demo   (1:00–6:00, 5 minutes)

  ## Opening hook

This is the chapter that decides whether you win. You have five
minutes and exactly one job: make the room watch the multi-agent
pipeline run live and react when the diagnosis lands. Everything
else in this demo — the feed, the coverage grid, the
recommendation cards — is the frame around that single moment.

You also have the largest budget you'll get, and the most ways
to waste it. The wasteful patterns: narrating clicks, explaining
the architecture inside the demo, hovering over UI to point out
"isn't this nice." Don't. The architecture has its own chapter
(03). Inside chapter 2 the rule is brutal: every beat either
moves the click-path forward or earns the money shot.

The money shot lands at ~3:00 — the diagnostic agent's
reasoning trace materializes line-by-line on the right, real
analytics queries run in front of the room, and a typed
Diagnosis with a real conclusion crystalizes in the main panel.
The whole rest of the chapter exists to set that up and to land
softly after it.

  ## The time-budget bar

Five minutes. Half the slot. The money shot lands at the 3:00
mark — that's the 2-minute point inside this chapter.

```
  ┌──────────────────────────────────────────────────────────┐
  │ ░░░░▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │
  │ 0:00 ─── 1:00 ─★3:00★ ─── 6:00 ────────────────────10:00 │
  │   THE DEMO — you own 1:00 to 6:00 · ★ money shot ~3:00   │
  └──────────────────────────────────────────────────────────┘
```

  ## The chapter-opening diagram — the choreographed click-path

The exact path you walk through the app, with timing and the
money-shot marker. Memorize this; everything else in the chapter
is the script for executing it.

```
  the click-path · 1:00 → 6:00

  1:00   FEED (app/page.tsx)
   │     ↓ point at the coverage grid
   │     ↓ point at the top-of-list critical card
   │
  1:30   ★ CLICK the critical insight card
   │           → navigates to /investigate/[id]
   │
  1:35   INVESTIGATE PAGE (app/investigate/[id]/page.tsx)
   │     ↓ status log opens on the right · empty
   │     ↓ "diagnosing the issue…" appears
   │     ↓ ProcessStepper shows step 2 active
   │
  1:50   the agent starts streaming reasoning steps
   │     ↓ a "thought" line appears
   │     ↓ a tool_call_start renders · "execute_analytics_eql"
   │     ↓ the actual EQL query text fills the status log
   │
  2:30   tool_call_end · result appears · next thought streams
   │     ↓ second query fires · third · hypothesis line
   │
  3:00   ★★★ MONEY SHOT ★★★
   │     ↓ the Diagnosis materializes in EvidencePanel:
   │       · the conclusion in the main callout
   │       · evidence array filled with the real numbers
   │       · confidence pill (high/medium/low) lights up
   │       · GapChart renders if timeSeries is present
   │     ↓ "cause identified" replaces "diagnosing the issue…"
   │     ↓ "see recommendations →" button activates
   │
  3:30   pause · 3-second silence · let the room read the
   │     ↓ conclusion
   │
  3:45   CLICK "see recommendations →"
   │           → navigates to /investigate/[id]/recommend
   │
  3:50   DECIDE PAGE (.../recommend/page.tsx)
   │     ↓ three recommendation cards stream in
   │     ↓ each card has: bloomreach feature · steps ·
   │       estimated impact · confidence · effort
   │
  5:30   navigate back to /  (browser back, or "feed" link)
   │     ↓ show the second/third cards briefly · they exist
   │       and behave the same way
   │
  6:00   end of chapter 2 · hand off to chapter 3
```

The marker at 3:00 is non-negotiable. Rehearse with a timer
until you can hit it within ten seconds. If you can't, the demo
mode replay is fast enough — the briefing snapshot streams at
~140ms per event, the investigation replay at ~180ms per event,
so the timing is predictable.

  ## Beat 1 — the feed orientation   (1:00–1:30)

You ended the cold open hovering over the critical card. Now you
spend thirty seconds making the room understand what the feed
IS, then you click.

```
  SHOW (on screen)                  SAY (out loud)
  ──────────────────────────        ───────────────────────────
  point at the coverage grid        "the agent doesn't guess what
   (the 10-tile checklist above       to look for. it checks ten
    the cards)                        ecommerce anomaly categories
                                      — conversion drops, cart
                                      abandonment, revenue moves,
                                      churn — and the green ones
                                      are the ones it can actually
                                      run against this workspace's
                                      data."
  ──────────────────────────        ───────────────────────────
  point at a faded/ghost tile       "the faded ones are categories
   if any are present                 the workspace can't support
                                      yet — no return events, no
                                      utm tracking. honest about
                                      what it can and can't see."
  ──────────────────────────        ───────────────────────────
  drop back to the top card         "and here are the three things
                                      it flagged. let's pull on
                                      this one."
```

That coverage-grid line is doing real work. It signals that the
agent is gated, not guessing. Judges notice. Don't skip it.

Then click.

  ## Beat 2 — the click that starts the money shot   (1:30–3:00)

The click is the moment the demo actually starts. After this
you talk less — the screen does the talking. Your job for
ninety seconds is to point at things and let the room read.

```
  SHOW (on screen)                  SAY (out loud)
  ──────────────────────────        ───────────────────────────
  CLICK the critical card           "watch the right side."
   ↓ navigates to investigate
  ──────────────────────────        ───────────────────────────
  status log appears · empty        (point at the right panel · 2
   "connecting to the agent…"         seconds silent)
  ──────────────────────────        ───────────────────────────
  first reasoning step streams      "that's the diagnostic agent.
   "reading the workspace schema…"    it's thinking out loud — and
                                      every blue line is a real
                                      tool call to bloomreach."
  ──────────────────────────        ───────────────────────────
  first tool_call_start renders     "this is the actual analytics
   "execute_analytics_eql"            query language it just
   the EQL query text fills the       wrote and ran against the
   status line                        live workspace."
  ──────────────────────────        ───────────────────────────
  tool result lands · next          (silent · let them read the
   reasoning step                     query and the result)
   "checking session_start counts
    across the same window…"
  ──────────────────────────        ───────────────────────────
  second tool fires · third         "every query is the agent
                                      testing a hypothesis. it's
                                      not retrieving a saved
                                      answer — it's investigating."
```

The discipline here: do not narrate the clicks. Do not say "okay
so now it's running another query." The status log already says
that. Your job is to interpret, not duplicate.

  ## Beat 3 — the money shot   (3:00–3:30)   ★★★

This is the moment. Stop talking. Let it land.

```
  SHOW (on screen)                  SAY (out loud)
  ──────────────────────────        ───────────────────────────
  the Diagnosis materializes        (silent · 3 seconds)
   in EvidencePanel:
   • conclusion callout fills
   • evidence list renders
   • confidence pill colors in
   • the GapChart bars appear
  ──────────────────────────        ───────────────────────────
  the diagnostic step in            "there it is."
   ProcessStepper flips green,
   "cause identified"
  ──────────────────────────        ───────────────────────────
  cursor moves to the conclusion    "the agent investigated four
   text                                hypotheses, ran four real
                                      queries against bloomreach,
                                      and concluded — with high
                                      confidence — that this is
                                      double-firing of checkout
                                      events. it didn't just spot
                                      the anomaly. it figured out
                                      WHY."
```

```
  ┃ "it didn't just spot the anomaly. it figured out WHY."
```

That line is the money-shot line. Say it once, with weight.
Don't qualify it. Don't add "kind of" or "we think." Either it
figured it out or it didn't, and on this insight in demo mode it
did. The cached snapshot is from a real run. The conclusion is
the conclusion the live agent actually produced.

  ## Beat 4 — the action layer   (3:45–5:30)

The money shot is the payoff for the click. The action layer is
the payoff for the product. Without it you've shown a diagnosis
tool; with it you've shown an agent that closes the loop.

```
  SHOW (on screen)                  SAY (out loud)
  ──────────────────────────        ───────────────────────────
  CLICK "see recommendations →"     "and because it knows what's
   ↓ /investigate/[id]/recommend      wrong, it can propose what
                                      to do about it."
  ──────────────────────────        ───────────────────────────
  three RecommendationCard          "three recommendations. each
   skeletons render briefly,          one tied to a bloomreach
   then fill in (or replay              feature the workspace already
   instantly in demo mode)             has — a segment, a campaign,
                                      a scenario."
  ──────────────────────────        ───────────────────────────
  point at the "estimated impact"   "and they're sized. high
   pill on a card                     confidence, low effort, this
                                      one takes 20 minutes to set
                                      up. the agent isn't just
                                      saying 'fix it' — it's saying
                                      'fix it this way, here's how
                                      long it'll take, here's what
                                      you'll get back.'"
```

  ## Beat 5 — the soft landing   (5:30–6:00)

Navigate back to the feed. Show that the other cards are real
and behave the same way. This is the "yes there are more, this
is a system not a script" beat.

```
  SHOW (on screen)                  SAY (out loud)
  ──────────────────────────        ───────────────────────────
  click "← feed" or browser back    "and there are two more
   ↓ back at /                        anomalies on the feed,
                                      ready to investigate the
                                      same way."
  ──────────────────────────        ───────────────────────────
  hover over the second card,       (silent · 2 seconds · let
   then the third                     them read the headlines)
                                     "every one of these is the
                                      same flow. click, watch,
                                      decide."
  ──────────────────────────        ───────────────────────────
  hand off to chapter 3              "now let me show you how
                                      that actually works."
```

That last line is your transition into under-the-hood. Don't
fumble it; you want momentum into chapter 3.

  ## The script lines to nail

Three lines, verbatim. The money-shot line is the most important
single sentence in the entire ten minutes.

```
  ┃ "watch the right side."
```

```
  ┃ "it didn't just spot the anomaly. it figured out WHY."
```

```
  ┃ "every one of these is the same flow. click, watch, decide."
```

  ## Strong vs weak — the demo move that kills demos

The single most common failure inside a hackathon demo is the
presenter narrating the clicks while the screen is doing the
exact same narration in real time. The room hears it twice and
disengages.

```
  WEAK DEMO MOVE                    STRONG DEMO MOVE
  ─────────────────────────────     ─────────────────────────────
  "okay so now i'm clicking on      (CLICK · then silent for 2s)
   the critical card here, and       "watch the right side."
   you can see it's loading…
   and now there's a tool call,     (silent · let the trace
   and another tool call, and        stream)
   here's the query it ran…"
                                    "that's the actual analytics
                                     query language it just
                                     wrote."
  ─────────────────────────────     ─────────────────────────────
  presenter and screen say the      presenter interprets · screen
  same thing simultaneously         shows · room reads · both win
  ─────────────────────────────     ─────────────────────────────
  room disengages by 2:30           room is leaning in at 3:00
```

Your hands click. The screen narrates. Your voice interprets.
Three jobs, three sources, no overlap.

  ## ╔══════════════════════════════════════════════════════════╗
  ## ║ IF IT BREAKS — the demo                                   ║
  ## ║                                                            ║
  ## ║ Demo mode by default. The mode toggle in the feed header  ║
  ## ║ is set to "demo" and the snapshot replay is captured from ║
  ## ║ a real live run, so it shows real EQL queries with real   ║
  ## ║ results. The judges cannot tell it from live (and they    ║
  ## ║ shouldn't have to — it IS what the live agent does).      ║
  ## ║                                                            ║
  ## ║ The investigate page hangs → switch tabs to the recorded  ║
  ## ║ screen capture, scrub to the money-shot frame, say "let   ║
  ## ║ me show you the diagnosis from a fresh run earlier today,"║
  ## ║ deliver the money-shot line over the recording, and       ║
  ║ continue to beat 4 from the live app once it recovers.        ║
  ## ║                                                            ║
  ## ║ The diagnosis text is blank → the EvidencePanel handles    ║
  ## ║ this — it shows "no diagnosis yet" rather than a crash.    ║
  ## ║ If it appears in front of the judges, say: "the cached    ║
  ## ║ replay just hiccuped — here's what it produced in the run  ║
  ## ║ behind this snapshot," and screen-switch to the recording. ║
  ## ║                                                            ║
  ## ║ A judge interrupts mid-stream with "is this live?" → say  ║
  ## ║ "this is a replay of a real run from this morning; the    ║
  ║ live mode is the same flow against the live workspace. I can ║
  ## ║ toggle it after the demo if you want to see." Then keep    ║
  ## ║ going. Do NOT try to toggle live mid-demo.                 ║
  ## ╚══════════════════════════════════════════════════════════╝

  ## Tighten it — if you're running long

The chapter has three cuts, in priority order:

```
  cut 1   skip beat 5 (the soft landing back at the feed)
            saves ~30s · costs the "system not a script" beat

  cut 2   shorten beat 4 (recommendations) — show ONE card
            instead of all three, name the bloomreach-feature
            field, move on. saves ~30s · costs nothing
            critical.

  cut 3   skip beat 1's coverage-grid commentary — go straight
            from "here are three flagged anomalies" to the
            click. saves ~20s · costs the gated/honest framing.
```

The floor: the money shot at beat 3 is sacred. You cut from any
beat before doing anything to the money shot. If you have ninety
seconds left in chapter 2 and you're still in beat 1, jump
straight to the click and ride the money shot in. The room
remembers the money shot. The room does not remember the feed
orientation.

  ## ────────────── RUN SHEET — chapter 2 ─────────────────────

```
  ┌───────────────────────────────────────────────────────────┐
  │ THE DEMO · 1:00–6:00 · 5 minutes · ★ money shot ~3:00     │
  ├───────────────────────────────────────────────────────────┤
  │ 1:00   point at coverage grid · "ten categories, gated"   │
  │ 1:15   "faded ones = can't support yet"                   │
  │ 1:25   "let's pull on this one"                           │
  │ 1:30   ★ CLICK the critical card                          │
  │ 1:35   "watch the right side."                            │
  │ 1:50   "that's the diagnostic agent. blue lines = real    │
  │         tool calls to bloomreach."                        │
  │ 2:10   "this is the actual analytics query language…"     │
  │ 2:30   (let the trace stream · silent)                    │
  │ 3:00   ★★★ MONEY SHOT — diagnosis materializes ★★★         │
  │ 3:10   "there it is."                                     │
  │ 3:15   THE MONEY-SHOT LINE (verbatim):                    │
  │         "it didn't just spot the anomaly. it figured out  │
  │          WHY."                                            │
  │ 3:30   3-second silence · let them read                   │
  │ 3:45   click "see recommendations →"                      │
  │ 4:00   "three actions, each tied to a bloomreach          │
  │         feature."                                         │
  │ 4:30   point at confidence + effort pill                  │
  │ 5:00   click "← feed"                                     │
  │ 5:30   "every one of these is the same flow. click,       │
  │         watch, decide."                                   │
  │ 5:50   bridge: "now let me show you how that works."      │
  ├───────────────────────────────────────────────────────────┤
  │ MUST NAIL   money-shot line · 3s silence at 3:30          │
  │ IF BREAKS   recorded clip · narrate money shot from it    │
  │ TIGHTEN     cut beat 5 → beat 4 → beat 1's coverage line  │
  │             NEVER cut the money shot                      │
  └───────────────────────────────────────────────────────────┘
```

Read chapter 3 next.
