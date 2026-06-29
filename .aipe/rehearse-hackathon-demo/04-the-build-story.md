# Chapter 04 — The build story (8:00–8:45, 45 seconds)

You have 45 seconds. The room has seen the product (chapter 02) and the architecture (chapter 03). What they don't yet know is whether you *built* this or whether you bolted three open-source components together and called it a project. The build story is the chapter where you prove it shipped — and, more importantly, the chapter where you teach the room how to read the rough edges.

The temptation here is to lead with what works. Resist it. Lead with the **arc** — shipped, learned, retired — because that arc is what reads as senior engineering. A junior demo says "I built X." A senior demo says "I built X, used it to find three bugs, learned the next thing should be Y, retired X." The room is grading on judgment, not on line count. 45 seconds is enough to make that judgment visible if you say it tight.

  ## The time-budget bar

```
  ┌────────────────────────────────────────────────────────────────┐
  │ ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░▓▓▓░░░░░░░░░░░░░░░░ │
  │ 0:00 ───────────────── 8:00 ── 8:45 ──────────────────── 10:00 │
  │           THE BUILD STORY — you own 8:00 to 8:45 (45 seconds)  │
  └────────────────────────────────────────────────────────────────┘
```

45 seconds. The arc. Two sentences per phase. Move.

  ## The chapter-opening diagram — the build arc

This is the picture of the build, not a feature list. Four phases on a timeline; the third phase has a "retired" stamp on it on purpose.

```
  THE BUILD ARC — SHIPPED, LEARNED, RETIRED, MIGRATED

  ┌──────────┐    ┌──────────┐    ┌──────────────┐    ┌──────────┐
  │ PHASE 1  │───▶│ PHASE 2  │───▶│  PHASE 3     │───▶│ PHASE 4  │
  │          │    │          │    │              │    │          │
  │ hand-    │    │ own MCP  │    │  4-pillar    │    │ migrate  │
  │ rolled   │    │ server   │    │  eval suite  │    │ runtime  │
  │ loop +   │    │ over     │    │  against     │    │ to       │
  │ Bloom-   │    │ second   │    │  seeded      │    │ @aptkit/ │
  │ reach    │    │ data     │    │  anomalies   │    │ core,    │
  │ MCP      │    │ substrate│    │              │    │ 3-class  │
  │          │    │ + Data-  │    │  surfaced 3  │    │ adapter  │
  │ proved   │    │ Source   │    │  real bugs   │    │ bridge   │
  │ the 4-   │    │ seam     │    │              │    │          │
  │ agent    │    │          │    │ ╔══════════╗ │    │ legacy   │
  │ shape    │    │ proved   │    │ ║ retired  ║ │    │ kept at  │
  │          │    │ the seam │    │ ║ with the ║ │    │ base-    │
  │          │    │ by USING │    │ ║ substrate║ │    │ legacy   │
  │          │    │ it       │    │ ║ that     ║ │    │ .ts as a │
  │          │    │          │    │ ║ scored   ║ │    │ rollback │
  │          │    │          │    │ ║ against  ║ │    │ receipt  │
  │          │    │          │    │ ╚══════════╝ │    │          │
  └──────────┘    └──────────┘    └──────────────┘    └──────────┘
                                                            │
                                                            ▼
                                                  ┌──────────────────┐
                                                  │ TODAY            │
                                                  │ live-synthetic   │
                                                  │ on stage         │
                                                  └──────────────────┘
```

The retired stamp on phase 3 is deliberate. It is the strongest signal in the diagram.

  ## The beat — one continuous arc spoken in 30 seconds, 15 to land

This chapter has no SAY/SHOW table because it has no on-screen click. You are looking at the room, not at the screen. Stand still. Deliver it like a paragraph.

```
  ┃ "I built this in four phases. First I hand-rolled the agent
  ┃  loop on top of Bloomreach's MCP server — that proved the
  ┃  four-agent shape. Then I built my own MCP server over a
  ┃  second data substrate and introduced a DataSource seam —
  ┃  which I proved by actually USING it, not just claiming it.
  ┃  Then I built a four-pillar eval suite that surfaced three
  ┃  real bugs in the agents — and when I retired the substrate
  ┃  it scored against, I retired the eval pipeline with it.
  ┃  And then I migrated the agent runtime to @aptkit/core in
  ┃  three adapter classes. The hand-rolled loop is still in
  ┃  the repo at base-legacy.ts as a rollback receipt."
```

That's the whole chapter. ~30 seconds spoken at a normal pace.

The remaining 15 seconds is the **rough edge** — name one thing you didn't finish, with the confidence of someone who shipped, then hand off:

```
  ┃ "The eval pipeline is the obvious rebuild target — same
  ┃  four pillars, scored against synthetic this time. Not
  ┃  built yet. That's what's next."
```

Then move to chapter 05.

  ## Why the arc lands — what each phase is actually proving

You don't say this part on stage. This is the unspoken structure underneath what you said. Keep it in your head so the words above come out steady.

```
  ┌──────────────────────────────────────────────────────────────────┐
  │ PHASE 1   proves you can build the feature end-to-end. Real      │
  │           4-agent loop against a real MCP server. Junior-shaped  │
  │           proof: "the thing works."                              │
  ├──────────────────────────────────────────────────────────────────┤
  │ PHASE 2   proves you can ABSTRACT after the first version. A     │
  │           seam introduced because it earned itself, not because  │
  │           a tutorial said to add one. Mid-shaped proof: "the     │
  │           shape is the right shape."                             │
  ├──────────────────────────────────────────────────────────────────┤
  │ PHASE 3   proves you can MEASURE your own work and find the      │
  │           bugs nobody asked you to look for. Three real bugs —   │
  │           BRL units, binary calibration, conclusion instability  │
  │           — make this the chapter's strongest single anecdote    │
  │           if Q&A asks. Senior-shaped proof: "I held the work     │
  │           to a bar."                                             │
  ├──────────────────────────────────────────────────────────────────┤
  │ PHASE 4   proves you can RETIRE your own work when a better      │
  │           shape arrives. The library wins, your loop preserved   │
  │           as a receipt. Staff-shaped proof: "I know when to      │
  │           stop owning code."                                     │
  └──────────────────────────────────────────────────────────────────┘
```

A junior tells the room about phase 1. A senior tells them about all four, in 30 seconds, and trusts them to read the arc.

  ## Strong vs. weak — the build-story move

```
  WEAK VERSION                            STRONG VERSION
  ────────────────────────────────        ───────────────────────────────
  "I built a multi-agent AI               "I built this in four phases:
   analyst using Anthropic and             hand-rolled, abstracted,
   the Bloomreach MCP server"              evaluated, migrated. I
                                           retired one of the phases
  → 1 sentence, no arc                     because the eval pipeline
  → reads as: "I wired things together"    it depended on came with
                                           a substrate I no longer
                                           needed."

                                          → 4 phases visible in
                                            30 seconds
                                          → reads as: "I made
                                            decisions"
```

The weak version is the default thing presenters say in this slot. The strong version is 5 seconds longer and a full level of seniority above it. Use the strong version.

  ## The IF-IT-BREAKS box

╔══════════════════════════════════════════════════════════════════╗
║ IF IT BREAKS                                                       ║
║ You lose your place in the arc, or you start the third phase and  ║
║ blank on which substrate the eval ran against.                    ║
║                                                                    ║
║ → If you blank mid-sentence: skip to "I migrated the runtime to    ║
║   @aptkit/core in three adapter classes — the hand-rolled loop is  ║
║   still in the repo as a rollback receipt." That single sentence   ║
║   carries the arc by itself.                                       ║
║ → DO NOT try to recover the dropped phase mid-arc. Land the        ║
║   phase you remember, then move to chapter 05. The room cannot     ║
║   tell what you skipped.                                           ║
║ → If you blank entirely: drop chapter 04. Go straight to the       ║
║   close. The demo and the architecture have already done the       ║
║   credibility work.                                                ║
╚══════════════════════════════════════════════════════════════════╝

  ## The "tighten it" cut

If you are at 8:15 and chapter 03 ran long, **cut the rough-edge sentence about the eval rebuild.** Land only the arc. The rough edge is a bonus credibility signal, not the chapter's job — the arc is the job.

If you are at 8:30 and very tight, **cut phase 3** from the spoken arc ("eval suite, three bugs, retired with the substrate"). Land phases 1 → 2 → 4 only: hand-rolled, seam, library migration. You lose the strongest single anecdote, but you keep the arc shape. Floor: **say at least three of the four phases in order.** Two phases is "I built this in two steps" — not an arc.

  ## The one-page run sheet — the build story

```
  ╭──────────────────────────────────────────────────────────────────╮
  │ RUN SHEET — 04 THE BUILD STORY            8:00–8:45 (45 seconds) │
  │                                                                  │
  │ STATE BEFORE: stop touching the laptop. Look at the room.        │
  │                                                                  │
  │ 8:00–8:30  THE ARC (one paragraph, 30 seconds, no clicks):       │
  │             phase 1: hand-rolled loop + Bloomreach MCP →         │
  │                      proved the 4-agent shape                    │
  │             phase 2: own MCP server over a second substrate +    │
  │                      DataSource seam → proved by USING it        │
  │             phase 3: 4-pillar eval suite → surfaced 3 real       │
  │                      bugs → retired with the substrate           │
  │             phase 4: migrated runtime to @aptkit/core in 3       │
  │                      adapter classes → legacy at base-legacy.ts  │
  │                      as a rollback receipt                       │
  │                                                                  │
  │ 8:30–8:45  THE ROUGH EDGE (15 seconds):                          │
  │             "the eval pipeline is the obvious rebuild target —   │
  │              same four pillars, scored against synthetic this    │
  │              time. Not built yet. That's what's next."           │
  │             → hand off to chapter 05                             │
  │                                                                  │
  │ NAIL THIS:  the four-phase arc, in order, in 30 seconds.         │
  │ IF BREAKS:  drop to one sentence: "migrated the runtime to       │
  │             @aptkit/core in 3 adapters; legacy preserved as a    │
  │             rollback receipt."                                   │
  │ TIGHTEN:    cut the rough-edge sentence. Keep the arc.           │
  ╰──────────────────────────────────────────────────────────────────╯
```
