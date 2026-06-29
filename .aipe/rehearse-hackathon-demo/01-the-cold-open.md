# Chapter 01 — The cold open (0:00–1:00, 1 minute)

You have sixty seconds. The room is half-warm from the last demo, half-checking their phones. Inside this minute they decide whether to pay attention or to start drafting their next email. The job of the cold open is to make that decision easy: they look up because something on screen is *already happening,* and they hear the one-liner that tells them what they're looking at. Not what you built. What it does.

The failure mode you are training against is the slow on-ramp — the title slide, the self-introduction, the problem-statement framing, the "so I wanted to build something that…" The room does not need any of it yet. Open with the thing working.

  ## The time-budget bar

```
  ┌────────────────────────────────────────────────────────────────┐
  │ ▓▓▓▓░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │
  │ 0:00 ── 1:00 ──────────────────────────────────────────── 10:00 │
  │       THE COLD OPEN — you own 0:00 to 1:00 (60 seconds)         │
  └────────────────────────────────────────────────────────────────┘
```

Sixty seconds to get the room's attention and tell them what they're watching. That's it. Move on.

  ## The chapter-opening diagram — the room's attention curve

The room's attention is not a flat line. It is highest in the first ten seconds — they are choosing whether to listen — then drops, then climbs back if you give them a reason. The cold open's only job is to keep that opening peak from collapsing.

```
  ATTENTION CURVE IN THE FIRST 60 SECONDS

  high │    ●●●                                                    .●
       │   ●   ●                                                  ●
       │  ●     ●●                                              ●●
       │ ●        ●●●                                       ●●●
       │●            ●●●●                              ●●●●●
       │                 ●●●●●●●●●●●●●●●●●●●●●●●●●●●●●
  low  │
       └──────────────────────────────────────────────────────────────
       0s    5s   10s     20s     30s     40s     50s     60s
            ↑                                              ↑
       opening peak                                hand-off to demo
       (the thing                                  (the room is now
       on screen)                                   leaning in or gone)

       The slow-on-ramp opening collapses the peak by 0:15.
       The cold open here PROTECTS the peak through 0:60.
```

The strong opening keeps the peak alive long enough to get to the one-liner. The weak opening (title slide → name → "today I'm going to show you…") collapses it before you ever say what the project does.

  ## Beat 1 — The hook (0:00–0:30)

The hook is the screen the room walks into. You do not have an animation. You have an actual product that does the thing. Open on **the feed with one anomaly card already painted** — `usa purchase_revenue · -38.4%` — and the streaming trace beside it frozen mid-scroll. The room sees a real result before you have said a single word.

| SHOW (on screen)                                                | SAY (out loud)                                            |
|-----------------------------------------------------------------|-----------------------------------------------------------|
| browser already on `localhost:3000`; the feed loaded; one card visible: `● usa purchase_revenue · -38.4%`; status log frozen mid-trace on the right | *(silent for ~3 seconds — let them see it)* "this is a marketing analyst's screen 30 seconds into their morning." |
| zoom mouse to the trace column on the right                     | "everything on the right is the agent's actual thinking — the queries it ran, the hypotheses it tested, the numbers it pulled." |
| zoom mouse to the card on the left                              | "everything on the left is what it concluded — and why it matters for the business."  |

The room is now looking at something that exists. They have not heard your name, the problem statement, or the agenda. Good. Hand them the one-liner.

  ## Beat 2 — The one-liner (0:30–0:60)

The one-liner is the sentence that, if the wifi died right now, would still tell the room what your project is. One sentence. Pattern: *X is a Y that does Z for W.*

```
  ┃ "Blooming insights is a multi-agent AI analyst for a Bloomreach
  ┃  workspace — it runs the loop a human analyst runs (what changed,
  ┃  why, what to do), and it streams its reasoning so you see how
  ┃  it got there, not just the answer."
```

That's the keeper. Say it close to verbatim. The second pull quote is the tag — the line that compresses the differentiator into something the room can repeat:

```
  ┃ "An analyst that shows its work."
```

Five words. Repeat it once at the end of the demo (chapter 02, money shot moment) and once in the close (chapter 05). Three plants total.

  ## Strong vs. weak — the cold open move

The contrast between the wrong and right opening is the whole teaching here. Both are sixty seconds. One collapses the attention curve. One protects it.

```
  WEAK OPEN                              STRONG OPEN
  ────────────────────────────────       ───────────────────────────────
  title slide: "blooming insights"       browser already on the feed
                                         with a real card painted
  "hi, I'm [you], thanks for             *(silent 3 seconds — let them
   having me, I'm excited to              see it)*
   share what I've been working on"
                                         "this is a marketing analyst's
  "so a lot of marketers have this        screen 30 seconds into their
   problem where they look at             morning"
   dashboards and..."
                                         (mouse highlights trace column)
  → first 30 seconds are about YOU         "the right side is the agent's
  → next 30 are about THE PROBLEM           actual thinking"
  → the product hasn't shown up yet
                                         → first 30 seconds are about
  attention curve is already                THE PRODUCT
   collapsed by 0:25                       → second 30 are the one-liner
                                            and the tag

                                         attention curve held through 0:60
```

The strong open buys you the rest of the demo. The weak open spends it on framing.

  ## The IF-IT-BREAKS box

╔══════════════════════════════════════════════════════════════════╗
║ IF IT BREAKS                                                       ║
║ The feed didn't paint, or the page is white, or the dev server     ║
║ won't start.                                                       ║
║                                                                    ║
║ → Open the second tab pre-loaded with `?demo=cached` (mode =       ║
║   `demo`, committed snapshot, instant). Same screen, same card,    ║
║   no agent call.                                                   ║
║ → Say: "let me pull this up from earlier — same workspace, same    ║
║   numbers" and run the same SAY track over it. The room does not   ║
║   know you switched tabs.                                          ║
║ → Do NOT apologize twice. One brief acknowledgment, then keep      ║
║   the energy up. Speed of recovery is itself a credibility signal. ║
╚══════════════════════════════════════════════════════════════════╝

The reason the snapshot path exists at all is that the alpha Bloomreach server revokes tokens after minutes and the conference wifi will be hostile. You built `demo` mode for exactly this moment. Use it without flinching.

  ## The "tighten it" cut

If you're running ten seconds long out of the cold open (you will, the first three times you rehearse), drop the second mouse highlight ("everything on the left is what it concluded"). The room will figure that out from context once you start the demo. Floor: **you must say the one-liner.** Never cut the one-liner. The room can lose anything else and still know what your project is; without it they are watching a screen they don't have a frame for.

  ## The one-page run sheet — cold open

```
  ╭──────────────────────────────────────────────────────────────────╮
  │ RUN SHEET — 01 THE COLD OPEN              0:00–1:00 (60 seconds) │
  │                                                                  │
  │ STATE BEFORE: browser on localhost:3000, mode = live-synthetic   │
  │               OR mode = demo, feed loaded with 1+ cards visible  │
  │                                                                  │
  │ 0:00–0:05   silent — let them see the painted feed               │
  │                                                                  │
  │ 0:05–0:15   "this is a marketing analyst's screen 30 seconds     │
  │              into their morning"                                 │
  │                                                                  │
  │ 0:15–0:30   mouse highlights trace column → "the right side is   │
  │              the agent's actual thinking"                        │
  │              mouse highlights card → "the left is what it        │
  │              concluded and why it matters"                       │
  │                                                                  │
  │ 0:30–0:55   THE ONE-LINER (say close to verbatim):               │
  │              "Blooming insights is a multi-agent AI analyst for  │
  │              a Bloomreach workspace — it runs the loop a human   │
  │              analyst runs (what changed, why, what to do), and   │
  │              it streams its reasoning so you see how it got      │
  │              there, not just the answer."                        │
  │                                                                  │
  │ 0:55–1:00   THE TAG: "an analyst that shows its work"            │
  │              → hand off to demo                                  │
  │                                                                  │
  │ NAIL THIS:  the one-liner. Never cut it.                         │
  │ IF BREAKS:  switch to demo-mode tab. Same SAY track. No apology. │
  │ TIGHTEN:    drop the second mouse highlight.                     │
  ╰──────────────────────────────────────────────────────────────────╯
```
