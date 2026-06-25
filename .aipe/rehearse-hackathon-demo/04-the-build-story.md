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

You have two strong candidates for the hard part now:

```
  CANDIDATE A — schema-gated coverage
    the runtime gate in lib/agents/categories.ts that compares
    the workspace's event schema to each anomaly category's
    required deps. green = runnable; faded = honestly missing.
    the agent never wastes a call on a category it can't run.
    GOOD: visual (the coverage grid on screen) · concrete · the
    line "honest about what it can't see" is sticky.

  CANDIDATE B — the eval flywheel (built, used, retired)
    built a 4-pillar eval suite with K=10 and an LLM-as-judge
    calibrated 8/8 + 3/3, ran it against the agents, surfaced
    three real bugs (BRL cents-vs-Reais, binary calibration,
    conclusion instability), fixed them, then retired the whole
    substrate when the synthetic adapter shipped because the
    in-process shape was cleaner. "Built, used in anger,
    refactored away when it stopped earning its keep."
    GOOD: shows engineering maturity senior judges respect ·
    "shipped an eval pipeline and then deleted it" is the kind
    of story that lands at a senior interview.
```

Default to A for a general hackathon crowd (visual, concrete,
ties to what's on screen). Switch to B if the judges are senior
engineers or if you sense they're probing for engineering depth.
The chapter below walks both options — the run sheet defaults
to A but flags the B substitution.

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
  ┃ "five agents wrapping a published agent-loop library i
  ┃  also wrote, a DataSource seam with two live adapters —
  ┃  real bloomreach MCP and in-process synthetic — three
  ┃  streaming Next.js routes, a schema-gated ten-category
  ┃  anomaly checklist, 221 tests."
```

That sentence carries weight because every part of it is in the
repo. Five agents (monitoring, diagnostic, recommendation,
query, intent — one file each in `lib/agents/`, all built on
`@aptkit/core@0.3.0`). DataSource seam (`lib/data-source/types.ts`
with `bloomreach-data-source.ts` and `synthetic-data-source.ts`
implementations). Three streaming routes (`/api/briefing`,
`/api/agent`, OAuth callback chain in `/api/mcp/`). Schema gate
(`lib/agents/categories.ts`). 221 tests across `*.test.ts`. No
invented features.

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

  ## Beat 2 ALT — the eval flywheel (for senior judges)   (8:20–8:45)

If the judges read senior, swap beat 2 for this. Same 25 seconds.
Same anchor pattern (one obstacle, one move). The story is "built
an eval pipeline, used it in anger, learned three real bugs,
deleted it when a cleaner shape arrived."

```
  ┃ "the hard part wasn't shipping the agent — it was deciding
  ┃  whether to trust it. so i built a 4-pillar eval suite,
  ┃  K=10, with an LLM-as-judge calibrated against my own labels
  ┃  8 of 8 and 3 of 3. it surfaced three real bugs: BRL prices
  ┃  in cents getting reported as Reais, binary calibration
  ┃  fooling the confidence rating, and conclusion instability
  ┃  across reruns. i fixed all three. then i retired the whole
  ┃  substrate because the in-process synthetic adapter shipped
  ┃  and made the eval pipeline the wrong shape. the discipline
  ┃  stayed; the scaffolding didn't."
```

```
  ┃ "i built an eval pipeline, found three real bugs, fixed
  ┃  them, then deleted the pipeline when a cleaner shape
  ┃  arrived. the discipline stayed; the scaffolding didn't."
```

That alt-line is the senior-judge anchor. Most hackathon builds
don't have evals at all; very few have an eval pipeline the
presenter chose to retire. The story signals "I know when
infrastructure has stopped earning its keep" — which is a
staff-engineer move.

You can't use both beats in 25 seconds. Pick one before the
slot starts. Default to schema-gate; swap to eval flywheel if
the room reads senior.

  ## The script lines to nail

Two lines. The first is the "what shipped" line, the second is
the "hard part" line (pick A or B before the slot).

```
  ┃ "five agents wrapping a published agent-loop library, a
  ┃  DataSource seam with two live adapters, three streaming
  ┃  routes, a schema gate, 221 tests."
```

```
  ┃  (A — default) "the hard part was teaching the agent to be
  ┃                 honest about what it CAN'T see."
```

```
  ┃  (B — senior)  "i built an eval pipeline, found three real
  ┃                 bugs, fixed them, then deleted the pipeline
  ┃                 when a cleaner shape arrived. the discipline
  ┃                 stayed; the scaffolding didn't."
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
  │ 8:00   "five agents wrapping a published agent-loop       │
  │         library, a DataSource seam with two live          │
  │         adapters, three streaming routes, a schema gate,  │
  │         221 tests."                                       │
  │ 8:20   point at the coverage-grid diagram (or the live    │
  │         grid in the feed if it's still on screen)         │
  │ 8:25   ── pick one ──                                     │
  │         (A) "the hard part was teaching the agent to be   │
  │              honest about what it CAN'T see."             │
  │         (B) "i built an eval pipeline, found three real   │
  │              bugs, fixed them, then deleted it when a     │
  │              cleaner shape arrived."                      │
  │ 8:35   (A) point at a faded tile · "cart events the       │
  │             workspace doesn't emit"                       │
  │         (B) "the synthetic adapter made the eval pipeline │
  │             the wrong shape · so it had to go"            │
  │ 8:42   bridge: "here's where this goes next."             │
  ├───────────────────────────────────────────────────────────┤
  │ PRE-PICK    A (default for general audience)              │
  │             B (senior engineers · staff-engineer signal)  │
  │ MUST NAIL   whichever hard-part line you chose            │
  │ IF BREAKS   say the line over any screen · don't try to   │
  │             show source code on stage                     │
  │ TIGHTEN     drop the third sentence → drop beat 1 →       │
  │             collapse to one line                          │
  └───────────────────────────────────────────────────────────┘
```

Read chapter 5 next.
