# Chapter 1 — The cold open   (0:00 – 1:00, 60 seconds)

## Opening hook

The first sixty seconds is the only minute of the demo where the room is making a binary decision: **is this real, or is this a pitch deck?** They will not say it out loud and they will not give you a second chance to set that frame. You set it by opening on the thing already moving. No title slide, no "hi, I'm Rein," no five-sentence problem setup. The browser is on the screen when you start talking, the start button is under your cursor, and the one-liner comes out of your mouth as you click it.

Hackathon judges have sat through forty demos by the time you walk up. The cohort of presenters who burn ninety seconds on a self-introduction and a problem slide is so large that you win the room just by **not being one of them**. Open in motion, anchor the value in one sentence, and let the trace fill the screen while you finish the sentence.

## The time-budget bar

This is your slice. Sixty seconds. One hook, one sentence, the start button gets clicked at 0:45.

```
  0:00 ┌─────────────────────────────────────────────────────────────┐
       │ ▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │
       │                                                              │
       │ 01  COLD OPEN  ← you are here                  0:00 – 1:00   │
       │ 02  THE DEMO                                                  │
       │ 03  UNDER THE HOOD                                            │
       │ 04  THE BUILD STORY                                           │
       │ 05  THE CLOSE                                                 │
  1:00 └─────────────────────────────────────────────────────────────┘
```

By 1:00 the browser shows the running app, the reasoning trace is rolling in the right column, and you are mid-sentence into the value claim.

## The attention curve

This is what you are bending. Most demos lose the room at second 12. You climb past it by starting in motion.

```
THE ROOM'S ATTENTION — the first sixty seconds

  attention
  high  │
        │     ★ ─────────── (you keep climbing because the trace is moving)
        │    ╱
        │   ╱    typical demo loses it here, around 0:12
        │  ╱     ▼
        │ ╱   ╭──────────────╮
        │╱    │ "Hi I'm Rein,│ ← talking head, no motion on screen
        │     │ today I'll   │
        │     │ talk about…" │
        │     ╰──────────────╯
  low   │                                                     time →
        └──────────────────────────────────────────────────────────
        0:00      0:15           0:30           0:45        1:00
                                                              ▲
                                                       start clicked
```

The shape you are drawing is *up and to the right from second one*. Anything else and you spend the next four minutes climbing out of a hole.

## The two beats

There are exactly two beats in the cold open. The hook and the one-liner. You will rehearse them until they are reflex.

### Beat 1 — the hook (0:00 – 0:30)

The browser is already on screen, on `localhost:3000`, mode toggle on `live-synthetic`, the empty feed waiting. You do not introduce yourself. You name the problem in one short sentence with one number in it, and you do it while looking at the screen, not at the judges.

```
  SHOW (on screen)                  SAY (out of your mouth)
  ────────────────────────────────  ──────────────────────────────────────
  empty feed, mode toggle visible    "A marketer on Bloomreach has to notice
  on `live-synthetic`                 a metric moved, hunt for the cause, then
                                      pick which feature to reach for —
                                      three jobs, one person."
```

The script line:

```
┃ "A marketer on Bloomreach has to notice a metric moved, hunt for the
┃ cause, then pick which feature to reach for — three jobs, one person."
```

Notice what is **not** in there. No "in today's data-driven world." No "businesses struggle to." No "we built." Just the work the person actually does, in one breath. The hook earns the next sentence by being concrete.

### Beat 2 — the one-liner + the click (0:30 – 1:00)

Now you look up. The one-liner is the X-is-a-Y-that-does-Z sentence, and it lands while your cursor is moving to the start button. You hit start **mid-sentence**, not after. The trace begins streaming into the right column as you finish.

```
  SHOW (on screen)                  SAY (out of your mouth)
  ────────────────────────────────  ──────────────────────────────────────
  cursor moving to "start briefing"  "Blooming insights is a multi-agent
                                      analyst that does all three —"
  click — trace starts streaming     "— and it shows you its work
                                      while it does them."
  trace lines appearing in right     [pause; let the trace fill three lines
  column                              before you speak again]
```

The script line you nail verbatim:

```
┃ "Blooming insights is a multi-agent analyst that does all three —
┃  and it shows you its work while it does them."
```

That pause at the end is load-bearing. The room is reading the trace. You are not narrating what they can already see. You are letting the screen do the work for two beats and then handing into chapter 02.

## Weak open versus strong open

This is the single most-repeated demo failure in hackathon history. Put it side by side so you never do it.

```
WEAK OPEN                             STRONG OPEN (yours)
──────────────────────────────────    ──────────────────────────────────
"Hi, I'm Rein, and I'd like to        [browser already on screen]
 walk you through a project I built   "A marketer on Bloomreach has to
 over the past few months called      notice a metric moved, hunt for
 blooming insights. So the problem    the cause, then pick which feature
 we're trying to solve is…"           to reach for — three jobs, one
                                       person."
0:00 – 0:30 spent on intro             0:00 spent on the work
0:30 – 0:60 spent on problem framing   0:30 spent on the one-liner
1:00: app not visible yet              1:00: trace streaming live
room: "is this a pitch?"               room: "wait, is that running?"
```

The weak open leaves the screen static for the entire first minute. The strong open has the trace moving by 0:50. That is the whole difference.

## If it breaks

The cold open's only on-screen risk is the start-button click failing — auth error, Anthropic timeout, dev server not responding. You have one backup.

```
╔══════════════════════════════════════════════════════════════════════════╗
║ IF IT BREAKS                                                              ║
║ Start button click returns an error or hangs past 5 seconds →             ║
║   1. Flip the mode toggle from `live-synthetic` to `demo` (top-right).    ║
║   2. Reload. The cached snapshot serves instantly — same UI, same trace.  ║
║   3. Say: "I'm switching to the cached run from this morning so we don't  ║
║      eat the clock — same screens, same agents, just yesterday's data."   ║
║ Do not apologize twice. Do not explain the error. Keep the energy up.     ║
╚══════════════════════════════════════════════════════════════════════════╝
```

The cached `demo` mode is *exactly* the same UI rendering *exactly* the same agent outputs as the live run — it just replays a committed snapshot from `lib/state/demo-*.json` instead of running the agents. The room cannot tell the difference. **Use this if anything looks slow before the start click.**

## Tighten it

You are unlikely to run long on a sixty-second beat, but if the slot is shorter than ten minutes (some hackathons give five), you compress the cold open this way:

- **Cut the hook to one clause.** "Marketers on Bloomreach do three jobs to find what changed." Skip the period-and-rest, push straight into the one-liner.
- **Floor:** the one-liner stays. You never cut the X-is-a-Y-that-does-Z sentence. Drop the hook before you drop the one-liner.

## The one-page run sheet

Glance at this on stage. Nothing else.

```
╭─────────────────────── COLD OPEN — RUN SHEET ────────────────────────╮
│ Budget: 0:00 – 1:00 (60s)         Start click: 0:45                   │
│                                                                        │
│ SAY in order:                                                          │
│   1. (0:00) "A marketer on Bloomreach has to notice a metric moved,    │
│      hunt for the cause, then pick which feature to reach for —        │
│      three jobs, one person."                                          │
│   2. (0:30) "Blooming insights is a multi-agent analyst that does all  │
│      three — and it shows you its work while it does them."            │
│   3. (0:45) [click start — pause — let trace fill three lines]         │
│                                                                        │
│ SHOW: localhost:3000, mode = `live-synthetic`, empty feed → cursor →   │
│       start → trace streaming in right column                          │
│                                                                        │
│ Money shot anchor: trace must be visibly moving by 1:00                │
│                                                                        │
│ IF IT BREAKS: flip toggle to `demo`, reload, say "I'm switching to     │
│   the cached run from this morning so we don't eat the clock."          │
│                                                                        │
│ TIGHTEN IT: cut the hook to one clause; the one-liner is the floor.    │
╰────────────────────────────────────────────────────────────────────────╯
```
