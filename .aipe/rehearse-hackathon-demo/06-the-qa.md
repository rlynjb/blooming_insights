# Chapter 06 — The Q&A (post-clock — prep, no budget)

This chapter does not eat your ten minutes. It runs after the timed slot. But it is the chapter that decides whether the judges walk away thinking "real engineering" or "AI-built mockup." The room saw the demo for five minutes. They will spend three to ten minutes asking you about it. Those questions are the second half of your scorecard.

The pattern judges use in 2026 is well-known: they assume heavy AI assistance in the build (correctly), and they probe to find out whether you understand what you shipped. Defensive answers — "I really did write most of it myself" — score worse than matter-of-fact answers — "I used Claude heavily for the agent loop refactor; here's the boundary I drew and here's what I decided." The job of this chapter is to train you for that posture: own the tools, own the decisions, own the rough edges, and have a crisp speakable answer ready for every probe you can predict.

The five probes the room will almost certainly ask, plus the harder ones the experienced judges will. Each answer is in your voice, first person, present tense, speakable on the spot.

  ## The Q&A map — the questions in priority order

```
  ┌────────────────────────────────────────────────────────────────┐
  │                  Q&A — LIKELY → LESS LIKELY                     │
  │                                                                 │
  │  TIER 1 — almost certain (prep these cold)                      │
  │    Q1  "Is this actually working, or is it a mockup?"           │
  │    Q2  "What was the hard part?"                                │
  │    Q3  "What's the stack?"                                      │
  │    Q4  "Did you build this during the hackathon?" (AI-usage)    │
  │    Q5  "Is there a business here / what's next?"                │
  │                                                                 │
  │  TIER 2 — experienced judges (prep these warm)                  │
  │    Q6  "Why a library for the loop instead of writing your own?"│
  │    Q7  "Isn't synthetic just fake data?"                        │
  │    Q8  "You built an eval pipeline and then deleted it?"        │
  │    Q9  "What's the production deployment story?"                │
  │                                                                 │
  │  TIER 3 — adversarial / weird (prep one liner each)             │
  │    Q10 "Why Bloomreach?"                                        │
  │    Q11 "Couldn't a marketer just ask ChatGPT?"                  │
  │    Q12 "What stops the agent from hallucinating numbers?"       │
  │    Q13 "How much does this cost per briefing?"                  │
  └────────────────────────────────────────────────────────────────┘
```

Below: each question, the crisp answer, and the most likely follow-up so you don't get walked into a corner.

  ## Tier 1 — almost certain

  ### Q1 — "Is this actually working, or is it a mockup?"

This is the no-vaporware probe. The answer is short and specific:

```
  ┃ "Real. There are three modes — the toggle you saw in the
  ┃  corner — `demo`, `live-synthetic`, and `live-bloomreach`.
  ┃  All three run real agent code. Demo replays a committed
  ┃  snapshot of a real run. Synthetic runs the agents in
  ┃  process against deterministic ecommerce data. Bloomreach
  ┃  runs against a real Bloomreach workspace over OAuth and
  ┃  MCP. The thing on stage was synthetic — real Claude,
  ┃  real agent loop, fake data."
```

**Likely follow-up:** "Can I see the live-bloomreach one?"
**Answer:** "Yes — but the Bloomreach alpha server revokes tokens after a few minutes, so I demo on synthetic for reliability. I can run it on Bloomreach after this if you want to see the OAuth flow and the rate-limiter."

  ### Q2 — "What was the hard part?"

There is one good answer here and it is not "everything." Pick one and tell it tight.

```
  ┃ "Building the eval pipeline. I had four agents and no
  ┃  ground truth for what 'good' looked like — so I built a
  ┃  4-pillar eval suite (detection, diagnosis, recommendation,
  ┃  regression) with LLM-as-judge plus manual spot-check
  ┃  calibration. It surfaced three real bugs the agents had:
  ┃  one was a units bug where revenue came out as
  ┃  R$131,965 because I was treating BRL cents as Reais; one
  ┃  was a binary-calibration bug — the LLM judge was giving
  ┃  29 out of 30 perfect scores; one was conclusion
  ┃  instability — 30% of identical inputs produced
  ┃  diverging conclusions. The eval finding the bugs was the
  ┃  hard part. The bugs themselves were easy once I had a
  ┃  scoreboard."
```

**Likely follow-up:** "And you removed the eval pipeline?"
**Bridge to Q8.**

  ### Q3 — "What's the stack?"

Short. Names. Move on.

```
  ┃ "Next.js 16 App Router on Vercel, React 19. TypeScript.
  ┃  Anthropic SDK — claude-sonnet-4-6 for the agents,
  ┃  claude-haiku-4-5 for intent classification. AptKit core
  ┃  at 0.3.0 for the agent loop runtime. Model Context
  ┃  Protocol over Streamable HTTP with OAuth PKCE for the
  ┃  Bloomreach side. NDJSON over ReadableStream for the
  ┃  trace streaming. Tailwind v4. Vitest — 24 test files,
  ┃  221 passing. No database; state in memory, demo
  ┃  snapshots committed as JSON."
```

**Likely follow-up:** "Why Sonnet and not Opus?"
**Answer:** "Latency. The streaming trace is the differentiator, and Sonnet keeps the time-to-first-event short enough that the trace feels alive. Opus would feel like waiting."

  ### Q4 — "Did you build this during the hackathon?" (the AI-usage probe)

This is the test for posture. Matter-of-fact. Own it.

```
  ┃ "I used Claude heavily — the agent prompts, the data
  ┃  source adapter, big chunks of the route handlers, most
  ┃  of the test scaffolding. What I decided: the 4-agent
  ┃  decomposition, the DataSource seam, that the trace had
  ┃  to be the differentiator, that the eval would be 4
  ┃  pillars not 2, and that the loop should migrate from
  ┃  hand-rolled to library after I proved the shape worked.
  ┃  The model wrote a lot of code. I wrote the architecture
  ┃  and the judgments."
```

**Likely follow-up:** "How long did it take?"
**Answer:** Pick a real number you can defend; do not round up.

  ### Q5 — "Is there a business here? / What's next?"

```
  ┃ "The business model is the same as every analytics-on-top
  ┃  of-platform-X product — Bloomreach has marketers who
  ┃  spend hours staring at dashboards, and the agent loop
  ┃  collapses that into a five-minute morning read. Next is
  ┃  rebuilding the eval against synthetic, adding a
  ┃  notification path on the monitoring agent so the feed
  ┃  pushes you, and broadening past Bloomreach — the
  ┃  DataSource seam is exactly what would let me adapt to a
  ┃  second platform."
```

**Likely follow-up:** "Who pays for it?"
**Answer:** "Marketers / growth teams on Bloomreach. The pitch is 'replace the dashboard-staring hour with a five-minute briefing.' Per-seat SaaS is the natural shape; I haven't priced it."

  ## Tier 2 — experienced judges

  ### Q6 — "Why a library for the loop instead of writing your own?"

```
  ┃ "I built it first. The hand-rolled loop is still in the
  ┃  repo at base-legacy.ts as a rollback receipt. Once
  ┃  @aptkit/core had a clean generic-primitive surface, the
  ┃  migration was 3 adapter classes — about 200 lines. The
  ┃  library owns the loop; I own the boundary. That's the
  ┃  trade I want: deep code I author lives at the boundary,
  ┃  not in the loop itself."
```

**Likely follow-up:** "What if AptKit goes away?"
**Answer:** "Roll back to base-legacy.ts. It's not deleted, it's preserved. That's why."

  ### Q7 — "Isn't synthetic just fake data?"

This is the question that tests whether you understand what synthetic mode is *for*. Don't get defensive.

```
  ┃ "The data is fake — purchase, view_item, session_start,
  ┃  cart_update events with realistic properties, owned by
  ┃  the app. The behavior is real: real Claude, real
  ┃  4-agent loop, real streaming trace, real EQL-shaped
  ┃  queries executed against in-process tables. What
  ┃  synthetic lets me do is run the agent loop live for a
  ┃  judge without depending on Bloomreach being up or
  ┃  having an OAuth token. The fake is the data, not the
  ┃  agent behavior. That's exactly what a demo needs."
```

**Likely follow-up:** "But you don't know it works on real data."
**Answer:** "It runs on real data in `live-bloomreach` mode against a real Bloomreach workspace. Synthetic is the demo-day path; Bloomreach is the production path. I can flip the toggle and show you."

  ### Q8 — "You built an eval pipeline and then deleted it?"

This is the question that decides whether the chapter-04 arc reads as senior or as messy. The answer is the strongest single anecdote in your interview kit.

```
  ┃ "Built it, used it to surface three real bugs — the BRL
  ┃  units bug, the binary-calibration bug, the conclusion
  ┃  instability — and retired it together with the data
  ┃  substrate it scored against. The substrate was Olist
  ┃  ecommerce data over a SQLite MCP server I owned; I
  ┃  retired that substrate in favor of the Blooming-owned
  ┃  synthetic shape, which is cleaner. The eval went with
  ┃  it. The rebuild target is against synthetic, decoupled
  ┃  from any one adapter's seed data. The receipt of
  ┃  having shipped the eval once, and the three bugs it
  ┃  caught, are stronger than promising to build it. That's
  ┃  what's in the close as next."
```

**Likely follow-up:** "Wouldn't it have been safer to keep the eval?"
**Answer:** "It would have been safer. It would also have meant carrying a substrate I no longer wanted, just so the scoring still worked. The right shape is eval-against-synthetic. The cost is the gap until I rebuild it. I'm naming the gap, not hiding it."

  ### Q9 — "What's the production deployment story?"

```
  ┃ "Demo as default for reliability — the committed snapshot
  ┃  serves instantly with no auth. live-bloomreach when
  ┃  there's a real workspace and OAuth tokens. live-
  ┃  synthetic is the dev/test/judge-friendly path. Vercel
  ┃  Pro for the agent routes — maxDuration 300 because
  ┃  Bloomreach is rate-limited to ~1 req/s and a briefing
  ┃  can take a couple of minutes end to end. Auth is
  ┃  AES-256-GCM-encrypted cookies in production, file-based
  ┃  store in dev. The alpha Bloomreach server revokes
  ┃  tokens after minutes — the feed has auto-reconnect on
  ┃  invalid_token to handle it."
```

**Likely follow-up:** "How do you scale past one user?"
**Answer:** "Session ID per user, OAuth tokens per session, in-memory caches per session. The agent loop is stateless across requests — each briefing fetches fresh from Bloomreach. The scaling question is really 'how many Bloomreach tool calls per minute can you sustain' and that's an alpha-server problem, not an architecture problem."

  ## Tier 3 — adversarial / weird

  ### Q10 — "Why Bloomreach?"

```
  ┃ "It's where the marketer already is. There's a real MCP
  ┃  surface — execute_analytics_eql, the EQL query language,
  ┃  the segment and campaign APIs — which means I can act
  ┃  on the diagnosis, not just describe it. The
  ┃  recommendation agent proposes scenarios, vouchers,
  ┃  campaigns — those are Bloomreach primitives. The
  ┃  product is Bloomreach-specific on purpose."
```

  ### Q11 — "Couldn't a marketer just ask ChatGPT?"

```
  ┃ "ChatGPT doesn't have tool access to the workspace. The
  ┃  whole loop here is grounded — every conclusion cites
  ┃  the exact EQL query that produced it and the current-vs-
  ┃  prior numbers behind it. You can't get that from a
  ┃  general chatbot. The streaming trace is the proof."
```

  ### Q12 — "What stops the agent from hallucinating numbers?"

```
  ┃ "Every number in the UI is sourced from a tool call. The
  ┃  Insight type carries an evidence array of {tool, result}
  ┃  pairs, and the UI renders the prior→now comparison from
  ┃  that evidence. If the agent makes a number up, there's
  ┃  no evidence entry — and the UI shows a `--` placeholder
  ┃  instead of a fabricated value. Hallucinated narrative is
  ┃  still possible. Hallucinated numbers are caught at the
  ┃  render layer."
```

  ### Q13 — "How much does this cost per briefing?"

```
  ┃ "Haven't measured precisely. The monitoring agent does
  ┃  maybe 6 to 10 tool calls and a similar number of model
  ┃  turns on Sonnet, so ballpark a few cents. The
  ┃  recommendation agent is shorter. Bloomreach side is
  ┃  free — rate-limited but not metered. Order of magnitude:
  ┃  a daily briefing per user costs less than the API
  ┃  charges for the marketer's expense-report tool."
```

  ## Postures to hold across all answers

```
  ┌────────────────────────────────────────────────────────────────┐
  │ POSTURE                          INSTEAD OF                     │
  │ ────────────────────────────     ─────────────────────────────  │
  │ "I used Claude heavily for X"    "I really did write it myself" │
  │ "Real, on path Y. Here's the     "It's a working demo, I        │
  │  toggle."                          promise."                    │
  │ "Built it, retired it, here's    "It worked at some point but   │
  │  why."                             I had to remove it."         │
  │ "Naming the gap, not hiding it." "I'm planning to add that."    │
  │ "Same loop, swappable substrate."  "Well it works on synthetic  │
  │                                    so it should work on real."  │
  └────────────────────────────────────────────────────────────────┘
```

The right column is the junior default. The left column is the move you practice until it's reflex.

  ## The "I don't know" recovery

You will get a question you don't have an answer for. The pattern that works:

```
  ┃ "Honest answer: I don't know. The thing I do know is [a
  ┃  related fact you DO know that connects to their
  ┃  question]. Happy to dig into that part if it's useful."
```

Three moves: admit the gap, anchor on what you do know, offer the related dig. Do not bluff. Judges remember the bluff longer than they remember the gap.

  ## The one-page run sheet — Q&A

```
  ╭──────────────────────────────────────────────────────────────────╮
  │ RUN SHEET — 06 THE Q&A                       post-clock, no cap  │
  │                                                                  │
  │ POSTURE: matter-of-fact about AI assistance, specific about      │
  │          decisions, willing to name gaps.                        │
  │                                                                  │
  │ TIER 1 (cold):                                                   │
  │   Q1 mockup?    → "real. three modes. all run real agent code."  │
  │   Q2 hard part? → "the eval pipeline — surfaced 3 real bugs."    │
  │   Q3 stack?     → Next 16 / React 19 / Sonnet / AptKit / MCP /   │
  │                   NDJSON / Vitest, 24 files / 221 passing.       │
  │   Q4 AI usage?  → "Claude heavily for code. I wrote the          │
  │                   architecture and the judgments."               │
  │   Q5 business?  → "marketers on Bloomreach. DataSource seam      │
  │                   broadens past Bloomreach."                     │
  │                                                                  │
  │ TIER 2 (warm):                                                   │
  │   Q6 why library? → "built it first. library owns loop, I own   │
  │                     boundary. legacy preserved as receipt."      │
  │   Q7 fake data?   → "fake DATA, real behavior."                  │
  │   Q8 deleted eval?→ "shipped + caught 3 bugs + retired with     │
  │                     substrate. naming the gap, not hiding it."   │
  │   Q9 production?  → "demo default. live-bloomreach with OAuth.   │
  │                     auto-reconnect for token revokes."           │
  │                                                                  │
  │ TIER 3 (one-liners ready):                                       │
  │   Q10 why bloomreach?      → "marketer already there + EQL"     │
  │   Q11 vs ChatGPT?           → "grounded in tool calls"           │
  │   Q12 hallucinations?       → "numbers caught at render layer"   │
  │   Q13 cost?                 → "few cents / briefing, ballpark"   │
  │                                                                  │
  │ I DON'T KNOW: admit the gap → anchor on related → offer the dig. │
  │                                                                  │
  │ NEVER: bluff. defend AI usage defensively. apologize for         │
  │        retiring code.                                            │
  ╰──────────────────────────────────────────────────────────────────╯
```
