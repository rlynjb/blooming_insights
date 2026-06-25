# 01 — The cold open   (0:00–1:00, 1 minute)

  ## Opening hook

You have sixty seconds before the room has decided whether to
listen properly. Most demos burn forty of them on a title slide,
the team intro, and a problem statement nobody asked for. You
won't. You open with the app already on screen, you say one
sentence about what it does, and you start clicking.

The cold open is two beats. Eight seconds of orientation while
the room finds the screen, then a hook that lands. The hook is
not the pitch. The hook is the working surface — the live feed
of anomalies the agent already found, with severity badges and
real numbers. The room sees data immediately and the question
in their head shifts from "what am I looking at?" to "how did
that get there?" That shift is the only thing the cold open has
to do.

  ## The time-budget bar

This minute is the room deciding whether to lean in. Don't waste
any of it on setup the audience can infer.

```
  ┌──────────────────────────────────────────────────────────┐
  │ ▓▓▓▓░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │
  │ 0:00 ─── 1:00 ──────────────────────────────────────10:00 │
  │   THE COLD OPEN — you own 0:00 to 1:00 (1 minute)         │
  └──────────────────────────────────────────────────────────┘
```

  ## The chapter-opening diagram — the room's attention curve

The shape of the first minute. The room's attention starts low,
rises sharply when they see real data on screen, and you have
forty seconds left to deliver the one-liner before they drift.

```
  attention
       ▲
  high │                        ┌────────────────────●
       │                        │
       │                        │  ← one-liner lands here
       │              ┌─────────┘     (~0:20)
       │              │
       │              │  ← feed appears, real numbers visible
       │              │     (~0:10)
  low  └──────────────┴──────────────────────────────────►
       0:00         0:08      0:20             1:00       time

  the gap before 0:08 is your enemy
  the climb after 0:08 is your work
```

The climb is steeper than you think. The cliff if you fumble the
first beat is also steeper than you think.

  ## Beat 1 — the open   (0:00–0:10)

The screen is already showing the running app. You do not open a
slide deck. You do not introduce yourself. You stand, you let
the URL bar disappear, and you let the room see the page.

```
  SHOW (on screen)                  SAY (out loud)
  ──────────────────────────        ───────────────────────────
  the feed, already loaded:         (silent for 2 seconds — let
   • the workspace header             them read)
     "ecommerce workspace ·          ↓
      ~1,200 customers"               "this is an ecommerce workspace.
   • the coverage grid (10 tiles)     an agent ran against it just
     mostly green/teal                now and flagged three things
   • three insight cards,             you'd want to know."
     critical/critical/warning,
     real headlines with %s
```

The framing "ran against it just now" is honest for live-synthetic —
the agent really did run against the in-process DataSource right
before the demo started. Don't say "this morning"; that was the old
Bloomreach-cached-snapshot framing. Live-synthetic means it ran on
THIS load.

The two-second silence is load-bearing. It gives the room time
to register that they are looking at something real before you
talk over it. Practice the silence. Most presenters can't hold
it; you have to.

  ## Beat 2 — the one-liner   (0:10–0:30)

Now the line. One sentence. Subject, verb, object. No throat
clearing. No "so basically what we built is…"

```
  ┃ "blooming insights watches an ecommerce workspace and
  ┃  tells the business owner what changed, why, and what to
  ┃  do about it — without you ever opening an analytics tool."
```

That is the entire pitch. "X is a Y that does Z for W" — the
agent (Y) watches the workspace (Z) for the owner (W). Say it
once. Don't restate. Don't pad. Move to beat 3.

  ## Beat 3 — the bridge into the demo   (0:30–1:00)

You now have thirty seconds to set up the click without
explaining the architecture. The mistake here is starting to
narrate the technology — "it uses Anthropic and MCP and…" — when
the room hasn't asked. Don't. Point at the cards. Name what they
are. Tell the room what you're about to do.

```
  SHOW (on screen)                  SAY (out loud)
  ──────────────────────────        ───────────────────────────
  hover over the critical card      "each of these is an anomaly
   "purchases outnumber sessions      the agent found by running its
    2:1"                              own queries against this
                                      workspace's analytics — not a
                                      static dashboard."
  ──────────────────────────        ───────────────────────────
  cursor pauses on the card,        "and when i click one, you
  hand hovers (don't click yet)       get to watch it figure out
                                      WHY in real time."
```

That last sentence is the promise. The money shot in chapter 2
is the payoff. Make the promise here so the room is leaning
toward the click, not just watching it.

  ## The script lines to nail

Two lines, verbatim. Practice them until they're muscle memory.

```
  ┃ "blooming insights watches an ecommerce workspace and tells
  ┃  the business owner what changed, why, and what to do about
  ┃  it — without you ever opening an analytics tool."
```

```
  ┃ "and when i click one, you get to watch it figure out WHY
  ┃  in real time."
```

  ## Strong vs weak — what the first minute usually looks like

The contrast worth teaching against. The weak open is the
default for ninety percent of hackathon demos. The strong open
is what wins.

```
  WEAK COLD OPEN                    STRONG COLD OPEN
  ─────────────────────────────     ─────────────────────────────
  "hi everyone, i'm rein, and       (silent · the app is on
   today i want to show you           screen · real data visible)
   a project i built called…"
                                    "this is an ecommerce workspace.
  title slide for 20 seconds         an agent ran against it just
                                     now and flagged three things
  "the problem is that business      you'd want to know."
   owners spend hours looking
   at dashboards trying to…"        (one-liner · then bridge into
                                     the demo)
  problem slide for 30 seconds

  finally opens the app at 1:10     judges are leaning in at 0:30
  judges have drifted               app is doing the talking
```

The weak open spends the first ninety seconds telling the room
what the app is going to do. The strong open lets the app do it.

  ## ╔══════════════════════════════════════════════════════════╗
  ## ║ IF IT BREAKS — the cold open                              ║
  ## ║                                                            ║
  ## ║ The feed doesn't load → DO NOT troubleshoot live. Switch  ║
  ## ║ to the recorded screen capture (tab pre-opened, paused at  ║
  ## ║ the feed view). Say: "let me show you a recording from    ║
  ## ║ this morning's run." Then deliver the one-liner over the   ║
  ## ║ frozen frame, scrub to the click moment, and continue into ║
  ## ║ chapter 2. The recovery costs you ~10 seconds, not a       ║
  ## ║ minute. Never apologize twice. Never say "the wifi…".      ║
  ## ║                                                            ║
  ## ║ The toggle is on live-bloomreach (broken auth, rate-limit ║
  ## ║ block) → click "live · synthetic" in the header. Same      ║
  ## ║ agents, same UI, runs in-process. If even that hangs       ║
  ## ║ (model latency), click "demo" — the cached snapshot is     ║
  ## ║ built from a real captured run and looks identical.        ║
  ## ╚══════════════════════════════════════════════════════════╝

  ## Tighten it — if you're running long

Cut beat 3's hover-and-promise. Go straight from the one-liner
into the click. You lose the foreshadowing of the money shot,
but you save fifteen seconds for chapter 2.

The floor: never cut the one-liner or the two-second silence at
the open. Those are the load-bearing parts. The bridge is
optional; the hook isn't.

  ## ────────────── RUN SHEET — chapter 1 ─────────────────────

```
  ┌───────────────────────────────────────────────────────────┐
  │ COLD OPEN · 0:00–1:00 · 1 minute                          │
  ├───────────────────────────────────────────────────────────┤
  │ pre-roll  app on screen · feed loaded · live-synthetic    │
  │           mode active (real agents · no creds)            │
  │ 0:00      stand · 2-second silence · let them read        │
  │ 0:08      "this is an ecommerce workspace…"               │
  │ 0:15      "an agent ran against it just now and           │
  │            flagged three things you'd want to know."      │
  │ 0:20      THE ONE-LINER (verbatim, once)                  │
  │ 0:35      hover the critical card · name it               │
  │ 0:50      "and when i click one, you get to watch it      │
  │            figure out WHY in real time."                  │
  │ 0:58      pause · ready to click · chapter 2              │
  ├───────────────────────────────────────────────────────────┤
  │ MUST NAIL   the one-liner · the silence · the bridge      │
  │ IF BREAKS   recorded clip · narrate from memory · move on │
  │ TIGHTEN     drop the bridge · click straight from the     │
  │             one-liner (saves ~15s)                         │
  └───────────────────────────────────────────────────────────┘
```

Read chapter 2 next.
