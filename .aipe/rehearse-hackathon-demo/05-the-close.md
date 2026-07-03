# Chapter 05 — The close (8:45–9:30, 45 seconds)

You have 45 seconds. The demo landed, the technical beat earned trust, the build story proved receipts. The room is ready to move on — the last thing they need from you is a beat that gives them the sentence to repeat to each other, the ask that names what happens next, and a clean stop before the buffer.

The single most common close failure: trailing off. "Yeah, so, that's kind of it, um, thanks?" is the sound of a demo losing the last thirty seconds it just spent five minutes earning. You are going to end on a beat.

Three beats: **what's next** (clearly framed as future — never demoed as if it exists), **the ask** (what you want from the room), and **the last line** (the one sentence you want them repeating).

  ## The time-budget bar

  You own 45 seconds, then a 30-second buffer before the ten-minute mark. The buffer is real — do not eat it.

```
  ┌──────────────────────────────────────────────────────────┐
  │ ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░▓▓▓░░░░░░░  │
  │ 0:00 ── 1:00 ─────────────── 6:00 ─ 8:00 8:45 9:30 ─ 10:00 │
  │        THE CLOSE — you own 8:45 to 9:30 (45 seconds)       │
  │                          buffer 9:30–10:00 (30 seconds)    │
  └──────────────────────────────────────────────────────────┘
```

  ## The three beats

  Not a diagram this time. A shape — a curve. This is what your close looks like on the attention curve.

```
  The close — three beats, one climb

    high  │                                          ▲
          │                                        ╱
          │                       what's         ╱  the ask
  mid     │                        next    ▲   ╱     lands
          │                                 ╲╱
          │                                                 ▲
          │                                                ╱ ← last line
  low     ├───────────────────────────────────────────────╯   lands
          │
          └────────────────────────────────────────────────
              8:45         9:00          9:15          9:30
              ▲            ▲             ▲             ▲
              open the     future        ask           mic drop
              close        state         one thing     one line
              beat         (10s)         (10s)         (5s)
```

  Notice the shape: the first two beats sit at mid attention because you're setting up the punch; the last line spikes. Do not deliver the last line at low energy.

  ## Beat 1 — what's next (8:45–9:00)

  Where the project goes from here. Clearly framed as future — never demoed as if it exists. Two things to name, and stop. Do not list five directions; a hackathon close that promises everything sounds like a hackathon close that shipped nothing.

  The two things worth naming:

  → **A blind human calibration pass** on the eval flywheel — Chapter 06 has the full answer, but the seed goes here. You already have the worksheet; the pass is 30-60 minutes of a human rater going through blind. That gives you the interview-defensible number.

  → **A smoother OAuth reconnect** for `live-mcp` mode. The synthetic path is the demo path because it's reliable. The MCP path is the production path — already built, with three auth strategies (Bloomreach OAuth, bearer, anonymous) and a live-swap settings modal already shipped. What ships next is a cleaner reconnect flow when the alpha Bloomreach server revokes tokens mid-session.

  What is **not** on this list because it already shipped: swappable MCP servers, the eval flywheel, prompt caching, the regression gate, the fault harness. Do not accidentally promise a capability the room just watched work.

```
  SHOW (on screen)                    SAY (out loud)
  ────────────────────────            ──────────────────────────
  return to browser feed              "what's next — two things.
  page (a familiar picture             a blind human calibration
  from the money shot)                 pass on the eval to give me
                                       an interview-defensible
                                       number. and a smoother OAuth
                                       reconnect for live-mcp when
                                       the alpha bloomreach server
                                       revokes tokens mid-session.
                                       swappable MCP is already
                                       shipped — you just watched
                                       it."
  ────────────────────────            ──────────────────────────
```

  Notice what's *not* in that list: "productionize," "scale," "add more agents." Those would collapse the moment a judge asked "what does that actually mean." Two things, both concrete, both anchored to work you can start Monday.

  ## Beat 2 — the ask (9:00–9:15)

  This is the sentence that names what you want from the room. Judges in a hackathon are used to hearing "please vote for us." That's the weak version. You have a stronger one.

  The strong ask is specific and singular: **one conversation**. You want to talk to someone who runs analytics on a Bloomreach workspace and would use this as a daily tool. Not a hundred votes, not a demo signup, not "check out our repo." One right conversation.

```
  SHOW (on screen)                    SAY (out loud)
  ────────────────────────            ──────────────────────────
  (still on feed page)                "what i want from this room —
                                       one conversation. if you run
                                       analytics on a Bloomreach
                                       workspace, or you know
                                       someone who does, find me
                                       after. that's the ask."
  ────────────────────────            ──────────────────────────
```

  ┃ "One conversation. If you run analytics on a Bloomreach workspace, find me after."

  ## Beat 3 — the last line (9:15–9:30)

  This is the sentence they repeat to each other in the ten seconds before the next demo starts. It has to be short. It has to be memorable. It has to close the loop with the cold open.

  The cold open said "this is my agent doing that live." The last line closes it:

  ┃ "An analyst that shows its work — end to end, in the browser you already have open."

  Then you stop. You do not say "thank you" — the beat is stronger without it. You look at the room, you hold for one count, and you sit down (or step back from the mic). That silence is the mic drop.

  ## Strong vs weak — the trail-off failure mode

  This is the classic close failure. Every judge has watched it. Do not do it.

```
  ┌── weak (do not) ───────────────┬── strong (do this) ────────────┐
  │                                 │                                 │
  │ "yeah, so, that's blooming      │ "one conversation. if you run   │
  │  insights. we could definitely  │  analytics on a Bloomreach       │
  │  add more agents, and we're     │  workspace, find me after."     │
  │  thinking about production, and │                                 │
  │  maybe multi-tenant, and — um,  │ (one beat)                       │
  │  yeah. thanks?"                 │                                 │
  │                                 │ "an analyst that shows its       │
  │  25 seconds of trailing         │  work — end to end, in the       │
  │  attention drops off a cliff    │  browser you already have open." │
  │  before the "thanks" lands      │                                 │
  │                                 │ (hold, step back)                │
  │                                 │                                 │
  │                                 │  25 seconds of climbing         │
  │                                 │  attention curve peaks on the   │
  │                                 │  last line and holds through    │
  │                                 │  the silence                    │
  │                                 │                                 │
  └─────────────────────────────────┴─────────────────────────────────┘
```

  Two rules for the close: no "so, yeah." No "um, thanks." The beat is stronger with silence than with a courtesy.

  ## IF IT BREAKS — the no-browser backup

  This chapter has one on-screen anchor — returning to the feed page. If localhost is dead by minute nine (it happens), the fallback is a black slide with the last-line text.

```
  ╔══════════════════════════════════════════════════════════════════╗
  ║ IF IT BREAKS                                                       ║
  ║                                                                    ║
  ║ Localhost is dead / browser tab lost:                              ║
  ║   → cut to a black slide with the last-line text pre-rendered      ║
  ║   → deliver Beat 1 and Beat 2 without a screen anchor              ║
  ║   → close on the last-line slide — the text on screen carries the  ║
  ║      beat while your voice delivers it                             ║
  ║                                                                    ║
  ║ No slide backup available:                                         ║
  ║   → deliver all three beats verbally, no screen                    ║
  ║   → look at the room, not at the dead screen                       ║
  ║   → the last line lands the same way regardless of the picture     ║
  ║                                                                    ║
  ╚══════════════════════════════════════════════════════════════════╝
```

  ## The "tighten it" cut

  If the whole slot ran long and you enter this chapter at 8:55 instead of 8:45, cut here first.

```
  Running long — drop these beats, in this order:

    1. drop Beat 1 (what's next) entirely
       skip straight from Chapter 04's handoff to Beat 2 (the ask)
       cost: 15 seconds saved. the ask and the last line still land.

    2. drop the specificity in Beat 2
       "one conversation — find me after" instead of the full
       Bloomreach analytics framing
       cost: 5 seconds saved. weaker but still ends on a beat.

  Floor:
    → the last line. always deliver the last line verbatim.
      "an analyst that shows its work — end to end, in the
      browser you already have open." this is non-negotiable.
      even if the buzzer starts, say the last line, then sit
      down. never trail off.
```

  ## One-page run sheet — the close

  This is what you hold on stage during the 45-second close.

```
  ╭─ RUN SHEET · CHAPTER 05 · THE CLOSE ─────────────────────╮
  │                                                           │
  │  Budget:     8:45–9:30 (45 seconds)                       │
  │  Buffer:     9:30–10:00 (30 seconds — do not eat)         │
  │                                                           │
  │  Pre-flight:                                              │
  │    → localhost feed page still open in tab                │
  │    → black last-line slide ready in second window         │
  │                                                           │
  │  Beats:                                                   │
  │    8:45  back to browser feed page                        │
  │    8:45  "what's next — two things"                       │
  │           → blind calibration pass on the eval            │
  │           → smoother OAuth reconnect for live-mcp         │
  │             (swappable MCP already shipped — do NOT       │
  │             list as future)                               │
  │    9:00  the ask: "one conversation. if you run           │
  │           analytics on a Bloomreach workspace, find       │
  │           me after."                                      │
  │    9:15  the last line:                                   │
  │           "an analyst that shows its work — end to        │
  │            end, in the browser you already have open."    │
  │    9:20  hold one count                                   │
  │    9:25  step back from the mic; silence to 9:30          │
  │                                                           │
  │  The two lines to nail (verbatim):                        │
  │    → "one conversation. if you run analytics on a         │
  │       Bloomreach workspace, find me after."               │
  │    → "an analyst that shows its work — end to end,        │
  │       in the browser you already have open."              │
  │                                                           │
  │  IF IT BREAKS:                                            │
  │    → localhost dead → last-line slide + verbal beats      │
  │    → no slide → verbal only, eyes on the room             │
  │                                                           │
  │  Tighten-it:                                              │
  │    1. drop "what's next" beat (−15s)                      │
  │    2. shorten the ask (−5s)                               │
  │                                                           │
  │  Floor:                                                   │
  │    → deliver the last line verbatim. never trail off.     │
  │    → no "so, yeah." no "um, thanks."                      │
  │                                                           │
  ╰──────────────────────────────────────────────────────────╯
```
