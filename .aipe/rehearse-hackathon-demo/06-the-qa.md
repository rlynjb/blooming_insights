# Chapter 6 — The Q&A   (prep only, post-clock)

## Opening hook

Q&A runs **after** the buzzer. It does not eat the ten minutes. The reason this chapter exists is that the questions you get in the three minutes after a hackathon demo are wildly predictable, and the difference between a winning demo and a *winning-and-getting-funded* demo is whether you have crisp, honest, speakable answers to the standard probes already loaded.

The discipline here is different from the demo chapters. You are no longer choreographing screens. You are preparing for questions where the wrong move is **performative** — overclaiming, defensiveness, or pretending the build is more finished than it is. **Hackathon judges in 2026 assume heavy AI use. They assume rough edges. What they are checking is whether you understand what you built well enough to be honest about it.**

This chapter is not a script you read top-to-bottom. It is a question bank. For each question, you have a verdict-first answer (one short paragraph) and a follow-up branch. Practice the verdict-first answers out loud — they should come out in roughly the same words every time.

## The time-budget bar

```
  10:00  ┌─────────────────────────────────────────────────────────────┐
         │ buzzer rings — timed slot ends                                │
         │                                                               │
         │ 06  Q&A  ← starts here, you have ~3 minutes typically        │
         │           target: 3 questions answered well > 6 answered fast │
         └─────────────────────────────────────────────────────────────┘
```

Three minutes, three questions. Quality over quantity. If a question is unclear, ask for the clarification — you have time. If you don't know the answer, **say so directly** and name what you would check. Judges remember the candidate who said "I don't know" cleanly more than the one who bullshitted around it.

## The standard probes — verdict first, then branch

The seven questions below cover ~90% of what you will be asked. Each has the verdict-first answer to lead with, the anecdote or detail you reach for if asked to elaborate, and the trap to avoid.

### Probe 1 — "Is this actually working?"

**Verdict:** Yes. Three modes — `demo`, `live-bloomreach`, and `live-synthetic`. What you saw was `live-synthetic`: real four-agent loop on real Claude, against in-process synthetic ecommerce data. Creds-free, deterministic, no upstream dependency.

```
  THE BRANCH

  ┌─ if they ask "is the data real?" ────────────────────────────────┐
  │  "The agent behavior is real — same Claude model, same loop,      │
  │  same tool-use, same trace. The data is Blooming-owned synthetic │
  │  ecommerce — purchase, view_item, session_start events with       │
  │  realistic properties. The fake is the data, not the agent."     │
  └───────────────────────────────────────────────────────────────────┘

  ┌─ if they ask "can it hit a real workspace?" ─────────────────────┐
  │  "Yes — `live-bloomreach` mode. The DataSource seam means the    │
  │  agents don't care which adapter is behind them. I don't demo    │
  │  it live because the alpha MCP server revokes OAuth tokens       │
  │  after minutes and that's not a stage-safe risk."                │
  └───────────────────────────────────────────────────────────────────┘
```

**Trap to avoid:** overclaiming "production-grade." Say what's true — three modes, two of them live, alpha upstream too unreliable for a stage.

### Probe 2 — "Why a library for the loop? Why not write your own?"

**Verdict:** I did write my own first. That was Phase 1 — `runAgentLoop`, hand-rolled — and it proved the four-agent shape worked. Once `@aptkit/core` had a clean generic-primitive surface, the migration was three adapter classes. Library owns the loop; I own the boundary. Legacy preserved at `base-legacy.ts` as the rollback receipt.

```
  THE BRANCH

  ┌─ if they ask "why migrate at all?" ──────────────────────────────┐
  │  "The hand-rolled loop worked but mixed two concerns — what an  │
  │  agent does and how the loop steps. Pulling the loop out into    │
  │  a library let me reuse it for the intent router and any future  │
  │  agent, and the boundary became the documented thing."           │
  └───────────────────────────────────────────────────────────────────┘

  ┌─ if they ask "isn't @aptkit/core yours too?" ────────────────────┐
  │  "Yes. I authored both. The split isn't NIH versus library —     │
  │  it's whether the loop should be reusable across projects        │
  │  (yes) and whether this app should own the agent contracts (yes)."│
  └───────────────────────────────────────────────────────────────────┘
```

**Trap:** sounding like you used a framework you don't understand. The opposite — you wrote the framework and you can name what it owns.

### Probe 3 — "Isn't synthetic just fake data?"

**Verdict:** It's deterministic, Blooming-owned synthetic ecommerce — purchase, view_item, session_start, cart_update events with realistic properties. The point is to let the agent loop run live (real Claude, real reasoning, real trace) without depending on Bloomreach being up or having OAuth tokens. **The fake is the data, not the agent behavior** — which is what a demo needs.

```
  THE BRANCH

  ┌─ if they ask "why not just hit Bloomreach?" ─────────────────────┐
  │  "I do — that's `live-bloomreach`. Two problems for a stage:     │
  │  the alpha server is rate-limited at ~1 req/s and revokes        │
  │  tokens after minutes. Synthetic gives me the live agent         │
  │  behavior without the upstream risk."                            │
  └───────────────────────────────────────────────────────────────────┘

  ┌─ if they ask "won't the agent overfit to synthetic patterns?" ───┐
  │  "Possible. That's why the seam matters — the same agent code    │
  │  runs against Bloomreach in live mode. If the agent only worked  │
  │  on synthetic, the seam wouldn't have survived two adapter       │
  │  swaps already."                                                 │
  └───────────────────────────────────────────────────────────────────┘
```

**Trap:** getting defensive. Synthetic-as-fake is a fair probe. Own it — the fake is the data, not the agent.

### Probe 4 — "You built an eval pipeline and then deleted it?"

**Verdict:** Built it, used it to surface three real bugs — including one where the agent reported a $26K average order value because it forgot Brazilian reais are quoted in cents — and retired it with the dataset it scored against. The rebuild target is against the synthetic adapter, decoupled from any one adapter's seed data. **The receipt of having shipped it once plus the bugs it caught are stronger than promising to build it.**

```
  THE BRANCH

  ┌─ if they ask "what were the three bugs?" ────────────────────────┐
  │  "BRL cents-vs-reais — recommendation judge caught it at run 8   │
  │  when the agent claimed R$131,965 average order value, which is  │
  │  about $26,000 per order, obviously wrong. Binary calibration —  │
  │  the diagnostic agent's confidence was zero in 29 of 30 runs.    │
  │  Conclusion instability — 30% regression baseline."              │
  └───────────────────────────────────────────────────────────────────┘

  ┌─ if they ask "isn't retiring an eval risky?" ────────────────────┐
  │  "Retiring it without a plan would be. The plan is to rebuild    │
  │  against synthetic so the eval doesn't depend on any one         │
  │  adapter's seed data. That's a stronger eval than the one I      │
  │  retired."                                                       │
  └───────────────────────────────────────────────────────────────────┘

  ┌─ if they push: "why not keep it?" ───────────────────────────────┐
  │  "The substrate was wrong. The eval scored against Olist-shaped │
  │  data. The product runs against ecommerce shapes more broadly.  │
  │  Keeping a wrong-shape eval is worse than rebuilding right."     │
  └───────────────────────────────────────────────────────────────────┘
```

**Trap:** sounding like you deleted work because it was hard. The opposite — you retired it because you learned what it needed to be.

### Probe 5 — "What's the stack?"

**Verdict:** Next.js 16 with the App Router on Vercel, React 19, TypeScript. Anthropic SDK for Claude — Sonnet-4.6 for the task agents, Haiku-4.5 for the intent router. MCP via `@modelcontextprotocol/sdk` with PKCE and Dynamic Client Registration when hitting Bloomreach. Streaming as newline-delimited JSON over `ReadableStream`. Agent runtime on `@aptkit/core@0.3.0`. Tailwind v4. No database — in-memory state plus committed demo snapshots.

```
  THE BRANCH

  ┌─ if they ask "why NDJSON not SSE?" ──────────────────────────────┐
  │  "EventSource doesn't let you POST a body — the briefing request │
  │  needs one. NDJSON over fetch + ReadableStream gives me the     │
  │  POST body, the streaming, and a single kernel I reuse on three │
  │  hooks (briefing, investigation, query)."                       │
  └───────────────────────────────────────────────────────────────────┘

  ┌─ if they ask "why no database?" ─────────────────────────────────┐
  │  "Demo snapshots are committed JSON for reliability. Live state │
  │  is in-memory because every briefing is a fresh scan — there's  │
  │  nothing to persist across requests. A DB would be premature."  │
  └───────────────────────────────────────────────────────────────────┘
```

**Trap:** listing tech with no reason. Every choice has a reason. Lead with the choice that has the strongest reason (NDJSON or no-DB).

### Probe 6 — "Did you build this during the hackathon?"

**Verdict:** Most of it. The four-phase arc — hand-rolled loop, DataSource seam, eval pipeline, migration to `@aptkit/core` — spans about eight weeks. The streaming UI, the synthetic data source, and the demo polish are the last two weeks. Some of the older bones (the auth provider, the MCP client wrapper) were built before the window. **I'd rather be honest about the timeline than win on a technicality.**

```
  THE BRANCH

  ┌─ if they ask "what did you actually ship this week?" ────────────┐
  │  "The synthetic data source, the streaming trace polish on the  │
  │  shared StatusLog, and the four-pillar eval rebuild plan. The   │
  │  rest is the substrate."                                        │
  └───────────────────────────────────────────────────────────────────┘
```

**Trap:** overclaiming. Honest timelines win in this room.

### Probe 7 — "Where's the business?"

**Verdict:** Two paths. Direct — sell into the existing Bloomreach customer base as a workspace add-on: their marketers already do this work manually. Indirect — the streaming-reasoning UX itself is a product pattern that generalizes to any analyst tool, not just Bloomreach. The codebase is the proof of the pattern; the substrate is interchangeable.

```
  THE BRANCH

  ┌─ if they ask "what's the moat?" ─────────────────────────────────┐
  │  "Speed of iteration on the agent loop and the trace UX. The    │
  │  DataSource seam means I can drop into a new analytics backend   │
  │  in a week. The trace UX is the differentiator — most analyst   │
  │  AI shows results; this shows reasoning."                       │
  └───────────────────────────────────────────────────────────────────┘

  ┌─ if they ask "who pays?" ────────────────────────────────────────┐
  │  "Marketing teams on Bloomreach in the short term. Analyst-AI   │
  │  product teams in the medium term — the trace pattern is the    │
  │  reusable piece."                                                │
  └───────────────────────────────────────────────────────────────────┘
```

**Trap:** the moat question. Don't claim a technical moat that isn't there. Speed-of-iteration and UX differentiation are honest moats; "proprietary algorithms" would be a lie.

## The "I don't know" recovery

This is the most important section in the chapter. You will get a question you don't have a clean answer to. The recovery move:

```
  THE RECOVERY MOVE — three lines, in this order

  1. "I don't know."                       ← say it directly
  2. "Here's what I'd check —"             ← name the file or method
  3. "— and I can follow up after if       ← offer the follow-up
      that's the right answer for you."

  Example:
    Judge: "How does the diagnostic agent decide when to stop?"
    You:   "I don't know the exact stopping condition off the top of
            my head. I'd check the prompt at
            lib/agents/prompts/diagnostic.md and the loop in
            @aptkit/core's tool-use kernel. I can follow up after if
            that's the right answer for you."
```

The three-line recovery is more credible than a guess. A guess that lands wrong destroys the rest of your credibility for the room. The honest "I don't know" lets the next question reset.

## Anti-patterns to recognize in yourself, on the spot

```
WEAK Q&A MOVES                        STRONG Q&A MOVES
──────────────────────────────────    ──────────────────────────────────
hedging ("kind of, sort of")          verdict first, then qualify
"that's a great question"             skip the pleasantry, answer
guessing when unsure                  three-line "I don't know" recovery
defensiveness on tradeoffs            naming the tradeoff directly
talking over the question             waiting until the question ends
"like I said earlier…"                fresh sentence — they don't remember
listing six possible answers          one verdict, one branch if pressed
```

The "that's a great question" reflex is hard to break. Try this: when you hear yourself about to say it, replace it with a one-second pause. The pause is more credible than the compliment.

## The one-page Q&A run sheet

```
╭───────────────────────── Q&A — RUN SHEET ────────────────────────────╮
│ Post-clock. ~3 minutes. Target: 3 answered well > 6 answered fast.    │
│                                                                        │
│ VERDICT-FIRST ANSWERS (lead with these, then branch):                 │
│                                                                        │
│  "Is this actually working?"     → Yes, 3 modes; you saw `live-       │
│                                    synthetic` — real agents, fake     │
│                                    data.                              │
│                                                                        │
│  "Why a library?"                → I built it first. Library owns     │
│                                    loop; I own boundary. Legacy       │
│                                    preserved as rollback receipt.     │
│                                                                        │
│  "Isn't synthetic fake data?"    → The fake is data, not behavior.   │
│                                                                        │
│  "You deleted the eval?"         → Built, used (caught 3 bugs),       │
│                                    retired with substrate. Receipt    │
│                                    of having shipped it > promise.    │
│                                                                        │
│  "What's the stack?"             → Next.js 16, Anthropic SDK,         │
│                                    @aptkit/core, NDJSON over fetch,   │
│                                    MCP for Bloomreach.                │
│                                                                        │
│  "Built during hackathon?"       → Most. 4-phase arc = ~8 weeks.      │
│                                    Honest timeline > technicality.    │
│                                                                        │
│  "Where's the business?"         → Bloomreach add-on direct;          │
│                                    streaming-reasoning UX pattern     │
│                                    is the reusable piece.             │
│                                                                        │
│ "I DON'T KNOW" RECOVERY:                                              │
│   1. "I don't know."                                                  │
│   2. "Here's what I'd check — [file or method]"                       │
│   3. "I can follow up if that's the right answer for you."            │
│                                                                        │
│ NEVER SAY: "that's a great question" / "kind of" / "sort of" /        │
│   "like I said earlier"                                               │
╰────────────────────────────────────────────────────────────────────────╯
```
