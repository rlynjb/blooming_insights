# Chapter 4 — The build story   (8:00 – 8:45, 45 seconds)

## Opening hook

Forty-five seconds. This is the smallest chapter and the most leveraged one. The room has now seen the thing work and seen the architecture. What they have not seen is **proof you built it, you learned from it, and you had the judgment to retire what wasn't earning its place**. That last clause is the part that separates a hackathon entry from a senior-engineer hackathon entry.

You have a four-phase arc in this codebase that is genuinely interview-gold material — shipped, used, learned from, retired. The temptation in a hackathon room is to talk about the new shiny thing. The stronger move is to **show the arc**, because the arc proves you have shipped under a clock multiple times. **Phases, not features.** Each phase gets one sentence. The retire move is the punchline.

## The time-budget bar

```
  8:00 ┌─────────────────────────────────────────────────────────────┐
       │ ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░▓▓▓░░░░░░░░░░░░ │
       │                                                              │
       │ 04  THE BUILD STORY  ← you are here          8:00 – 8:45     │
       │                                                              │
       │     four phases in four sentences                            │
  8:45 └─────────────────────────────────────────────────────────────┘
```

## The chapter-opening diagram — the four phases

This is on screen behind you. It is the visual the room sees while you walk the arc.

```
THE BUILD ARC — four phases, one diagram

  ┌─ Phase 1 ──────┐  ┌─ Phase 2 ──────┐  ┌─ Phase 3 ──────┐  ┌─ Phase 4 ──────┐
  │  hand-rolled    │  │  the SWAP       │  │  the EVAL       │  │  the MIGRATION  │
  │  agent loop +   │  │  authored own   │  │  4-pillar eval  │  │  to @aptkit/core │
  │  Bloomreach MCP │  │  MCP over Olist │  │  surfaced 3     │  │  via 3 adapter   │
  │                 │  │  + added         │  │  REAL bugs      │  │  classes         │
  │  4-agent shape  │  │  DataSource     │  │                 │  │                  │
  │  proved out     │  │  seam            │  │  ─ BRL cents    │  │  library owns    │
  │                 │  │                 │  │  ─ binary cal   │  │  the loop;       │
  │                 │  │  proved the     │  │  ─ instability  │  │  legacy preserved│
  │                 │  │  seam by USING  │  │                 │  │  at base-legacy  │
  │                 │  │  it             │  │  RETIRED with   │  │                  │
  │                 │  │                 │  │  Olist (PR #8)  │  │                  │
  └─────────────────┘  └─────────────────┘  └─────────────────┘  └─────────────────┘
   "what shape works"   "is the seam real"   "what does the eval   "is the loop a
                                              actually catch"        library yet"

                              ★ each phase shipped, was used, taught something ★
```

The diagram is on screen for the full 45 seconds. You point at the phases in order. **One sentence per phase. No more.**

## The body — one sentence per phase

This is the most rehearsed paragraph in the book. You will say it the same way every time. The cadence is what makes it land.

### Phase 1 — hand-rolled (one sentence)

```
  SHOW (on screen)                  SAY (out of your mouth)
  ────────────────────────────────  ──────────────────────────────────────
  point at Phase 1                   "First I hand-rolled the agent loop
                                      against Bloomreach's MCP server to
                                      prove the four-agent shape worked."
```

### Phase 2 — the swap (one sentence)

```
  SHOW (on screen)                  SAY (out of your mouth)
  ────────────────────────────────  ──────────────────────────────────────
  point at Phase 2                   "Then I authored a second MCP server
                                      over an open ecommerce dataset and
                                      added a DataSource seam — proved the
                                      seam by using it."
```

That "proved the seam by using it" clause is load-bearing. Most people add a seam and never substitute behind it. You did, and that is the only proof a seam is real.

### Phase 3 — the eval (one sentence)

```
  SHOW (on screen)                  SAY (out of your mouth)
  ────────────────────────────────  ──────────────────────────────────────
  point at Phase 3                   "I built a four-pillar eval suite —
                                      it surfaced three real bugs, including
                                      one where the agent reported a $26K
                                      average order value because it forgot
                                      Brazilian reais are quoted in cents."
```

The BRL-cents bug is the anecdote. Concrete number, real failure, the agent confidently wrong. **Mention it by name** — judges remember bugs with stories attached. The other two (binary calibration, conclusion instability) you keep in your back pocket for Q&A.

### Phase 4 — migration + retire (one sentence + the punchline)

```
  SHOW (on screen)                  SAY (out of your mouth)
  ────────────────────────────────  ──────────────────────────────────────
  point at Phase 4                   "Then I migrated the agent runtime to
                                      `@aptkit/core` — three adapter classes,
                                      the legacy preserved at base-legacy.ts
                                      as the rollback receipt."
  pause                              ──── [breath] ────
  hand sweeps back to Phase 3        "And I retired the eval pipeline with
                                      the dataset it scored against —
                                      shipping it taught me what it needed
                                      to be when I rebuild it."
```

The script line you nail verbatim — this is the chapter's pull quote:

```
┃ "Shipped, used, learned, retired. Four phases in eight weeks."
```

Say it slowly. Land on "retired." Then walk into chapter 05.

## Weak move versus strong move — the retire move

This is the chapter where the failure mode is *overclaiming*. Most demos hide the parts that didn't survive. You name them.

```
WEAK MOVE                             STRONG MOVE (yours)
──────────────────────────────────    ──────────────────────────────────
"I built a four-agent system using    "I hand-rolled it first, then swapped
 the latest framework with full        the data source, then built the eval,
 production architecture."             then migrated to a library — and I
                                       retired the eval when I retired the
                                       dataset it scored against."
hides the iterations                   shows the iterations
overclaims completeness                names what was retired and why
sounds like a pitch                    sounds like an engineer who has
                                       shipped things and let things go
```

The retire-with-receipts move is the L5 signal. Most candidates can build things. Fewer can *let things go on purpose*. You did both, and the legacy file preserved at `base-legacy.ts` is the receipt that it was retire-on-purpose, not abandon.

## If it breaks

Nothing on screen is running. The only thing that breaks is you forgetting the cadence and turning four sentences into eight.

```
╔══════════════════════════════════════════════════════════════════════════╗
║ IF IT BREAKS                                                              ║
║ You feel yourself elaborating mid-phase →                                 ║
║   1. Cut the elaboration. Land on the verb of the phase ("shipped",      ║
║      "swapped", "evaled", "migrated").                                    ║
║   2. Move to the next phase.                                              ║
║   3. The Q&A chapter has all the elaboration. Save it.                   ║
║ The four-sentence cadence IS the move. Eight sentences kills it.          ║
╚══════════════════════════════════════════════════════════════════════════╝
```

## Tighten it

If you are over the slot when you arrive at this chapter, you cut:

- **First cut:** drop the migration sentence's elaboration ("three adapter classes, legacy preserved"). Just say "migrated to @aptkit/core." Save the detail for Q&A.
- **Floor:** the four-phase frame stays. "I hand-rolled it, swapped the data source, built and retired an eval, migrated to a library." One sentence covering all four if you have to. The shape of the arc is the chapter; the elaboration is the polish.

## The one-page run sheet

```
╭──────────────────── BUILD STORY — RUN SHEET ─────────────────────────╮
│ Budget: 8:00 – 8:45 (45s)         One sentence per phase              │
│                                                                        │
│ FOUR PHASES — say each one and move:                                  │
│                                                                        │
│   1. "First I hand-rolled the agent loop against Bloomreach's MCP     │
│       to prove the four-agent shape worked."                          │
│                                                                        │
│   2. "Then I authored a second MCP server over an open ecommerce      │
│       dataset and added a DataSource seam — proved the seam by        │
│       using it."                                                      │
│                                                                        │
│   3. "I built a four-pillar eval suite — surfaced three real bugs,    │
│       including one where the agent reported a $26K AOV because it    │
│       forgot Brazilian reais are quoted in cents."                    │
│                                                                        │
│   4. "Then migrated the agent runtime to @aptkit/core — three adapter │
│       classes, legacy preserved at base-legacy.ts as the rollback     │
│       receipt. And I retired the eval pipeline with the dataset it    │
│       scored against."                                                │
│                                                                        │
│ CLOSE: "Shipped, used, learned, retired. Four phases in eight weeks." │
│         [breath; walk into 05]                                         │
│                                                                        │
│ IF IT BREAKS: cut elaboration mid-phase, land on the verb, move on.   │
│                                                                        │
│ TIGHTEN IT: drop adapter-classes detail; floor is the four-verb arc.  │
╰────────────────────────────────────────────────────────────────────────╯
```
