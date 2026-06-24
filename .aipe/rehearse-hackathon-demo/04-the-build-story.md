# 04 — The build story   (8:00–8:45, 45 seconds)

  ## Opening hook

Forty-five seconds. Two beats. What you shipped, and the one
hard thing you cracked. This chapter exists for two reasons:
prove the build is real, not a Figma mock, and give the room a
specific engineering moment to remember you by.

The temptation here is to list features — "we built the feed,
the investigate page, the recommendation flow, the auth, the
streaming…" Don't. Lists are forgettable. One concrete shipped
thing plus one concrete hard thing is what lands.

The hard part you crack in this chapter is **schema-gated
coverage** — the runtime check that compares the workspace's
real event schema against the ten anomaly categories and only
runs the agent on the ones the data can actually support. It's
real, it's in `lib/agents/categories.ts`, it's gated at three
layers (route, agent prompt, coverage grid UI), and it's the
thing that turns the demo from "look at the agent" into "look at
the agent being honest about what it can and can't see."

  ## The time-budget bar

Forty-five seconds. Tight. You'll feel rushed; that's correct.

```
  ┌──────────────────────────────────────────────────────────┐
  │ ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░▓▓░░░░░░░░░░░░░░ │
  │ 0:00 ───────────────────────── 8:00 8:45 ─────────10:00  │
  │   BUILD STORY — you own 8:00 to 8:45 (45 seconds)        │
  └──────────────────────────────────────────────────────────┘
```

  ## The chapter-opening diagram — the schema gate

The hard part, drawn. This is what you point at while you talk.

```
  schema-gated coverage · the runtime gate

    workspace                       AnomalyCategory[]
     schema                          (the 10-category
       │                              registry in
       │                              lib/agents/categories.ts)
       │                                   │
       ▼                                   ▼
    ┌─────────────────┐             ┌──────────────────────┐
    │ events:         │             │ id: 'conversion_drop'│
    │  view_item      │             │ requires:            │
    │  checkout       │             │   ['view_item',      │
    │  purchase       │             │    'checkout',       │
    │  session_start  │             │    'purchase']       │
    │  cart_update    │             │ enriches: undefined  │
    │                 │             │                      │
    │ catalogs:       │             │ id: 'campaign_perf'  │
    │  products       │             │ requires:            │
    └────────┬────────┘             │   ['session_start']  │
             │                      │ enriches:            │
             ▼                      │  ['session_start.    │
    ┌─────────────────────┐         │      utm_source']    │
    │ schemaCapabilities()│         └──────────┬───────────┘
    │ builds a Set:       │                    │
    │  'view_item'        │                    │
    │  'view_item.brand'  │                    ▼
    │  'session_start'    │            ┌────────────────────┐
    │  'session_start.    │            │ coverageFor(cat,   │
    │     utm_source'     │            │  available):       │
    │  'catalog:products' │            │  full · limited ·  │
    │  …                  │            │  unavailable       │
    └──────────┬──────────┘            └──────────┬─────────┘
               │                                  │
               └──────────────┬───────────────────┘
                              ▼
                  ┌─────────────────────────┐
                  │ coverageReport(available)│
                  │  → 10 tiles, one per cat │
                  │                           │
                  │ runnableCategories(…)     │
                  │  → ONLY the runnable ones │
                  │    are passed into the    │
                  │    monitoring agent       │
                  └────────────┬──────────────┘
                               │
                               ▼
                  ┌─────────────────────────┐
                  │ monitoring agent prompt  │
                  │  {categories} placeholder│
                  │  ← injected only with    │
                  │    runnable categories   │
                  └──────────────────────────┘
```

Three pure functions — `schemaCapabilities`, `coverageFor`,
`coverageReport` — plus one filter, `runnableCategories`. The
whole subsystem is one file. It's the reason the agent never
spends its budget on a category it can't actually run.

  ## Beat 1 — what shipped   (8:00–8:20)

Twenty seconds. Three concrete things. Numbers.

```
  ┃ "built end-to-end in the hackathon window: four agents
  ┃  driving a real bloomreach MCP integration with oauth,
  ┃  three streaming Next.js routes, and a schema-gated
  ┃  ten-category anomaly checklist that runs against the
  ┃  workspace data the user actually has."
```

That sentence carries weight because every part of it is in the
repo. Four agents (monitoring, diagnostic, recommendation,
query — one file each in `lib/agents/`). Three streaming routes
(`/api/briefing`, `/api/agent`, and the OAuth callback chain in
`/api/mcp/`). Schema-gated checklist (the categories diagram
above). No invented features.

  ## Beat 2 — the hard part   (8:20–8:45)

Twenty-five seconds. One concrete obstacle. One concrete move.

```
  SHOW (on screen)                  SAY (out loud)
  ──────────────────────────        ───────────────────────────
  the coverage-grid diagram         "the hard part was teaching
   from above (or the running         the agent to be honest
   coverage grid in the feed)         about what it CAN'T see."
  ──────────────────────────        ───────────────────────────
  point at a faded tile (or a       "the first version would
   ghost tile in the grid)            cheerfully run a 'cart
                                      abandonment' check on a
                                      workspace that didn't even
                                      emit cart events. it
                                      'found' nothing, but it
                                      wasted the call, and the
                                      ui told the user it
                                      monitored cart — when it
                                      didn't."
  ──────────────────────────        ───────────────────────────
  point at the runnable tiles       "the fix is three pure
                                      functions that compare the
                                      live schema to each
                                      category's required and
                                      enriching events. green
                                      tiles are runnable.
                                      faded tiles are honestly
                                      missing. the agent only
                                      ever gets handed the
                                      runnable list."
```

```
  ┃ "the hard part was teaching the agent to be honest about
  ┃  what it CAN'T see."
```

That line is the chapter's anchor. It's also true — every other
hard part in the build (rate limits, OAuth across ephemeral
serverless instances, NDJSON streaming, prompt synthesis when
the model won't stop calling tools) is engineering. The
schema-gated coverage is the one that's a product idea.

  ## The script lines to nail

Two lines. The first is the "what shipped" line, the second is
the "hard part" line.

```
  ┃ "built end-to-end in the hackathon window: four agents
  ┃  driving a real bloomreach MCP integration with oauth,
  ┃  three streaming Next.js routes, and a schema-gated
  ┃  ten-category anomaly checklist."
```

```
  ┃ "the hard part was teaching the agent to be honest about
  ┃  what it CAN'T see."
```

  ## Strong vs weak — the build-story trap

The trap is laundry-listing features instead of naming one
specific engineering moment.

```
  WEAK BUILD STORY                  STRONG BUILD STORY
  ─────────────────────────────     ─────────────────────────────
  "we built the feed page, the      "we built four agents, three
   investigate page, the             streaming routes, and a
   recommendation page, the          schema gate. the hard part
   coverage grid, the streaming      was teaching the agent to
   route, the OAuth flow, the        be honest about what it
   demo mode, the toggle…"           CAN'T see."
  ─────────────────────────────     ─────────────────────────────
  vague · forgettable · the         specific · memorable · the
  judges can't repeat it back        judges can repeat it back
                                     verbatim
  ─────────────────────────────     ─────────────────────────────
  no engineering moment              one specific engineering
  for the judges to grab onto        moment they can grab onto
```

Judges remember the line they could repeat at the table after
the demos. "Schema-gated coverage" is repeatable. "We built a
bunch of pages" is not.

  ## ╔══════════════════════════════════════════════════════════╗
  ## ║ IF IT BREAKS — the build story                            ║
  ## ║                                                            ║
  ## ║ No live interaction here — this is mostly spoken. The      ║
  ║ only risk is a judge interrupting with "did you build this    ║
  ## ║ during the hackathon or is this from a previous project?". ║
  ## ║                                                            ║
  ## ║ Answer it once, briefly, in chapter 4 voice: "everything   ║
  ║ you've seen was built in this window — the agents, the gate,  ║
  ## ║ the streaming routes. the static auth scaffolding came      ║
  ║ from the next.js scaffold." Then continue. Do NOT defend.     ║
  ║ Do NOT over-explain. The Q&A chapter handles the deeper       ║
  ║ version of this question.                                     ║
  ## ║                                                            ║
  ║ The screen shows the wrong thing (you tried to navigate to    ║
  ║ a categories.ts code view and it failed) — DON'T try to show  ║
  ║ source code on stage. The chapter works fine narrated over    ║
  ║ the coverage-grid diagram. Point at the diagram, say the      ║
  ║ lines, move on.                                               ║
  ## ╚══════════════════════════════════════════════════════════╝

  ## Tighten it — if you're running long

You have 45 seconds for this chapter, and you might be borrowing
from it. Three cuts in order:

```
  cut 1   drop the third sentence of beat 2 ("the fix is three
            pure functions…"). keep "the hard part was teaching
            the agent to be honest" and the example. saves 10s.

  cut 2   drop beat 1 (what shipped). go straight to the hard
            part. saves 20s · costs the "scope of work" framing
            but keeps the memorable line.

  cut 3   collapse the whole chapter to ONE line:
            "the hard part was teaching the agent to be honest
             about what it can't see — green tiles are runnable,
             faded tiles are honestly missing."
            saves 35s · costs everything except the anchor.
```

The floor: the hard-part line. If you have ten seconds left in
chapter 4, say that one line and move to chapter 5.

  ## ────────────── RUN SHEET — chapter 4 ─────────────────────

```
  ┌───────────────────────────────────────────────────────────┐
  │ BUILD STORY · 8:00–8:45 · 45 seconds                      │
  ├───────────────────────────────────────────────────────────┤
  │ 8:00   "built end-to-end in the hackathon window: four    │
  │         agents, three streaming routes, a schema-gated    │
  │         ten-category checklist."                          │
  │ 8:20   point at the coverage-grid diagram (or the live    │
  │         grid in the feed if it's still on screen)         │
  │ 8:25   "the hard part was teaching the agent to be        │
  │         honest about what it CAN'T see."                  │
  │ 8:35   point at a faded tile · "would 'check' for cart    │
  │         events on a workspace that didn't have them"      │
  │ 8:42   bridge: "here's where this goes next."             │
  ├───────────────────────────────────────────────────────────┤
  │ MUST NAIL   the hard-part line                            │
  │ IF BREAKS   say the hard-part line over any screen ·       │
  │             don't try to show source code on stage        │
  │ TIGHTEN     drop "the fix is three pure functions…" →     │
  │             drop beat 1 → collapse to one line             │
  └───────────────────────────────────────────────────────────┘
```

Read chapter 5 next.
