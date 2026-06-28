# Chapter 3 — Under the hood   (6:00 – 8:00, 2 minutes)

## Opening hook

You just spent five minutes letting the room watch the thing work. Now you have two minutes to convince them you understand **why** it works — to earn the credibility that turns "neat demo" into "real engineer." Two minutes. Not three. Not an architecture tour. **One diagram, three sentences of value per part, and you walk off the lectern at 8:00.**

The single biggest failure mode of this chapter is going one level too deep. The room does not need the full agent loop pseudocode. They need to see that there are multiple agents, that they talk to each other, that the data they ran against in the demo had a clean substitution boundary behind it, and that the streaming trace they just watched is the same shape on every screen. That's it. **Go exactly one level deep and stop.**

## The time-budget bar

Two minutes. Two halves. One diagram on the screen the whole time.

```
  6:00 ┌─────────────────────────────────────────────────────────────┐
       │ ░░░░░░░░░░░░░░░░░░░░░░░░░▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░ │
       │                                                              │
       │ 03  UNDER THE HOOD  ← you are here             6:00 – 8:00   │
       │                                                              │
       │     half 1 (60s): the four-agent loop                        │
       │     half 2 (60s): the DataSource seam                        │
  8:00 └─────────────────────────────────────────────────────────────┘
```

## The chapter-opening diagram

This is the only diagram you put on the screen for the entire chapter. It carries both halves. Practice pointing at the boxes; you will not narrate the whole thing — you will point at the parts as you talk.

```
UNDER THE HOOD — the architecture in one frame

  ┌─ UI layer ─────────────────────────────────────────────────────────┐
  │   app/page.tsx → useBriefingStream → reads NDJSON from /api/briefing│
  │                                                                     │
  │                  the streaming trace renders here, live              │
  └────────────────────────────┬────────────────────────────────────────┘
                               │  NDJSON over ReadableStream
  ┌─ Service layer ────────────▼────────────────────────────────────────┐
  │                                                                     │
  │   ┌─ INTENT ROUTER ─┐   ┌─ MONITORING ──┐                          │
  │   │  Haiku-4.5      │──▶│  Sonnet-4.6   │ ─ finds anomalies         │
  │   └─────────────────┘   └───────┬───────┘                          │
  │                                 │                                   │
  │                                 ▼                                   │
  │                         ┌─ DIAGNOSTIC ──┐                          │
  │                         │  Sonnet-4.6   │ ─ tests hypotheses        │
  │                         └───────┬───────┘                          │
  │                                 │                                   │
  │                                 ▼                                   │
  │                         ┌─ RECOMMEND ───┐                          │
  │                         │  Sonnet-4.6   │ ─ proposes actions        │
  │                         └───────┬───────┘                          │
  │                                                                     │
  │   all four run on @aptkit/core@0.3.0 — library owns the loop        │
  │                                 │                                   │
  └─────────────────────────────────┼───────────────────────────────────┘
                                    │  asks for data via …
  ┌─ DataSource SEAM ────────────────▼──────────────────────────────────┐
  │                                                                     │
  │   ┌─ SyntheticDataSource ─┐    ┌─ BloomreachDataSource ─┐           │
  │   │  in-process, det.      │ OR │  MCP + OAuth, alpha    │           │
  │   │  events on demand      │    │  rate-limited 1 req/s  │           │
  │   └────────────────────────┘    └────────────────────────┘           │
  │                                                                     │
  │   ★ THIS BOUNDARY IS THE PRODUCT'S SECRET WEAPON ★                 │
  └─────────────────────────────────────────────────────────────────────┘
```

One screen. You will point at three parts of this diagram in order: the four-agent stack, the `@aptkit/core` label, and the DataSource boundary. Each point is one sentence.

## The body — two halves, sixty seconds each

### Half 1 — the four agents and the runtime   (6:00 – 7:00)

Point at the agent boxes in the diagram. You are not explaining what each agent does — the demo just did that. You are naming the **shape** and naming **who runs the loop**.

```
  SHOW (on screen)                  SAY (out of your mouth)
  ────────────────────────────────  ──────────────────────────────────────
  point at the intent router box    "Intent router classifies what came in
                                     — briefing, investigation, or free-form
                                     question."
  point at the three Sonnet agents  "Three task agents — monitoring,
                                     diagnostic, recommendation — each runs
                                     a Claude tool-use loop until it's done."
  point at the @aptkit/core label   "The loop itself isn't mine — it's
                                     `@aptkit/core@0.3.0`, a library I
                                     authored. I own the boundary; the
                                     library owns the loop."
```

That last sentence is the credibility move. You built the library that the demo runs on, and you can name the file — `lib/agents/aptkit-adapters.ts`, three adapter classes, around 200 lines. **Mention the line count out loud** — it makes the claim concrete.

The script line for this half:

```
┃ "Three task agents on a runtime I authored. The library owns the
┃  loop; I own the boundary."
```

### Half 2 — the DataSource seam   (7:00 – 8:00)

Point at the DataSource boundary at the bottom of the diagram. This is the part that earns you the strongest engineering credit, and it is the part most demos cannot show because most demos do not have it.

```
  SHOW (on screen)                  SAY (out of your mouth)
  ────────────────────────────────  ──────────────────────────────────────
  point at the two DataSource boxes  "The agents don't talk to Bloomreach.
                                      They talk to a DataSource — one
                                      interface, two adapters."
  point at SyntheticDataSource       "What you just watched was running
                                      against the synthetic adapter —
                                      in-process, deterministic, creds-free.
                                      Real agents, fake data."
  point at BloomreachDataSource      "Same agents, different adapter, hit
                                      Bloomreach over MCP and OAuth. The
                                      agent code didn't change. The seam
                                      survived two adapter swaps already."
```

That last clause — "the seam survived two adapter swaps already" — is the proof. You don't have to elaborate; if a judge wants to know what got swapped, they'll ask in Q&A and you have the answer ready (Olist arrived, Olist left, Synthetic arrived — see chapter 04).

The script line for this half:

```
┃ "Real agents, fake data. The seam is the thing that lets that be true."
```

That sentence is the second-strongest line in the whole demo. Make it land.

## Strong move versus weak move — the depth knob

This is the chapter where engineers overshoot. The strong-vs-weak contrast is about how deep to go.

```
WEAK MOVE (too deep)                  STRONG MOVE (one level, stops)
──────────────────────────────────    ──────────────────────────────────
opens up the file, scrolls            stays on the diagram the whole time
through aptkit-adapters.ts
"so the AdapterClass implements       "I own the boundary; the library
 the AgentRuntime interface which      owns the loop."
 wraps the Claude SDK's tool-use…"
runs over budget into chapter 04      finishes at 7:55, walks into 04
loses the room at minute 7             keeps the room through to the close
```

The discipline is to go to **one** level of detail and stop. Not zero (you'd be back in the demo). Not two (you'd lose the room). Exactly one. The diagram is the level. Point at boxes. Stop.

## If it breaks

The screen is not running anything in this chapter. The diagram is static. The only failure mode is you, going long. The recovery is internal.

```
╔══════════════════════════════════════════════════════════════════════════╗
║ IF IT BREAKS                                                              ║
║ You feel the urge to keep explaining past 8:00 →                          ║
║   1. Stop mid-sentence if you have to.                                    ║
║   2. Say: "I'll go deeper in Q&A — let me show you what got built."       ║
║   3. Walk straight into chapter 04.                                       ║
║ The judge who wants more depth will ask. The room that didn't ask doesn't ║
║ want it. Going over here costs you the close.                             ║
╚══════════════════════════════════════════════════════════════════════════╝
```

## Tighten it

If the slot is short and you only have 60 seconds for this chapter:

- **Drop half 1. Keep half 2.** The DataSource seam is the more impressive of the two and the harder of the two to fake. The four-agent loop is visible from the demo's trace; the seam is invisible without you saying it.
- **Floor:** the seam sentence — "real agents, fake data — the seam is the thing that lets that be true." If you cut this chapter to one line, that's the line.

## The one-page run sheet

```
╭─────────────────── UNDER THE HOOD — RUN SHEET ───────────────────────╮
│ Budget: 6:00 – 8:00 (2 min)       Diagram on screen the whole time    │
│                                                                        │
│ TWO HALVES:                                                            │
│   1. (6:00) point at agents → "Intent router. Three task agents.       │
│        Each runs a Claude tool-use loop." Then point at @aptkit/core:  │
│        "Three task agents on a runtime I authored. The library owns    │
│        the loop; I own the boundary." (200-line adapter file.)         │
│                                                                        │
│   2. (7:00) point at DataSource boxes → "Agents talk to a DataSource   │
│        — one interface, two adapters." Then: "Real agents, fake data.  │
│        The seam is the thing that lets that be true."                  │
│                                                                        │
│ CLOSE: "And it survived two adapter swaps already." [walk into 04]    │
│                                                                        │
│ IF IT BREAKS: if you feel yourself going long, stop mid-sentence,      │
│   say "I'll go deeper in Q&A," walk into chapter 04.                   │
│                                                                        │
│ TIGHTEN IT: drop half 1, keep the seam sentence.                       │
╰────────────────────────────────────────────────────────────────────────╯
```
