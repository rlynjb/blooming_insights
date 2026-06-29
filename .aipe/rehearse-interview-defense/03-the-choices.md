# Chapter 3 — The choices

  ## Opening hook

The architecture chapter showed *what* you built. This chapter is about defending *why*. Every load-bearing technology choice in the codebase will get one question; the question always sounds like "why X and not Y." The answer is never "X is better." The answer is always "I optimized for this axis, X wins on it, here's the cost I'm paying."

You have six load-bearing choices worth defending: the framework (Next.js 16, App Router), the agent loop substrate (a hand-roll then a primitive bridge to `@aptkit/core`), the DataSource seam (an adapter pattern that outlived its first adapter), the streaming contract (NDJSON over `ReadableStream`, not server-sent events), the storage model (no database, session-keyed in-memory maps), and the model selection (Sonnet 4.6 as agent, Haiku for intent). Every one was a real call. Some were deliberate; some were AI-suggested and you evaluated and accepted; one is a defaulted-to that you're honest about. The book teaches you to name which is which.

  ## The picture you draw — the decision tree

This is the spine of the chapter. Each branch is one choice; the highlighted leaf is what you picked; the off-axis leaves are what you considered. Memorize the *order* of branches — that's the order interviewers tend to ask them in.

```
  Six load-bearing choices, with what won

  ┌─ framework ───────────────────────────────────┐
  │  Express + Vite   Remix   ★ Next 16 (App Rtr) │
  │                                                │
  │  picked: Next 16 — App Router streaming +     │
  │   Vercel maxDuration=300 fits the loop shape   │
  └────────────────────────────────────────────────┘

  ┌─ agent loop substrate ────────────────────────┐
  │  Vercel AI SDK   LangChain   hand-roll        │
  │   ★ Phase 4: @aptkit/core@0.3.0 (primitive)   │
  │                                                │
  │  picked: hand-roll first (deliberate), then    │
  │   migrate to a library that owns the loop      │
  │   while I own the boundary                     │
  └────────────────────────────────────────────────┘

  ┌─ data backend ────────────────────────────────┐
  │  ★ DataSource seam, two adapters today:        │
  │     BloomreachDataSource · SyntheticDataSource │
  │  alt: ad-hoc imports of one MCP client         │
  │                                                │
  │  picked: abstract surface, swap-on-mode        │
  │   — survived 2 adapter swaps                   │
  └────────────────────────────────────────────────┘

  ┌─ streaming contract ──────────────────────────┐
  │  EventSource (SSE)   websockets   raw JSON     │
  │   ★ NDJSON over ReadableStream                │
  │                                                │
  │  picked: NDJSON — one POST, one body, one      │
  │   shared parser; no auth-header / reconnect    │
  │   gymnastics that EventSource imposes          │
  └────────────────────────────────────────────────┘

  ┌─ persistence ─────────────────────────────────┐
  │  Postgres   Redis   sqlite                     │
  │   ★ no DB — session-keyed in-memory Maps      │
  │                                                │
  │  picked: no DB. Briefings are ephemeral; demo  │
  │   snapshots are committed JSON. Cross-instance │
  │   state is a known open cost.                  │
  └────────────────────────────────────────────────┘

  ┌─ model selection ─────────────────────────────┐
  │  GPT-4   Sonnet 3.5   ★ Sonnet 4.6 (agents)   │
  │                       ★ Haiku 4.5 (intent)    │
  │                                                │
  │  picked: Sonnet 4.6 for the heavy reasoning,   │
  │   Haiku for the cheap classification surface   │
  └────────────────────────────────────────────────┘
```

Six branches. Six defenses. The chapter walks each.

  ## The body — one section per choice

  ### Choice 1 — Next.js 16, App Router

```
  ┌─────────────────────────────────────────────────────────────┐
  │ THEY ASK                                                    │
  │   "Why Next.js? Could you have done this on Express?"       │
  │                                                             │
  │ WHAT THEY'RE TESTING                                        │
  │   Do you know what Next.js actually gives you that an       │
  │   Express + a React build doesn't? Or did you reach for     │
  │   it because it's the default? Can you name a specific      │
  │   feature you're using that you'd have to rebuild?          │
  └─────────────────────────────────────────────────────────────┘
```

**Strong answer:**

> "Next 16 with the App Router gives me three things I'd have had to rebuild otherwise. First, streaming responses from route handlers — I return a `ReadableStream` of NDJSON from `/api/briefing` and `/api/agent` and the runtime keeps the connection open. Second, the file-system routing maps cleanly onto the user flow: `app/page.tsx` for the feed, `app/investigate/[id]/page.tsx` for diagnosis, `app/investigate/[id]/recommend/page.tsx` for the recommendation step. Third, Vercel's `maxDuration = 300` config on the long-running routes — agents on the alpha Bloomreach server can take a couple of minutes given the rate limit, and I needed somewhere to put that.
>
> The cost I'm paying is that Next 16 is a moving target — the routing conventions, the runtime model, and the cache semantics all shifted from earlier versions. I had to read the in-tree docs more than I'd like. If I were starting fresh and didn't need streaming routes, I'd consider Remix, but the streaming-response ergonomics in Next are genuinely good."

```
  ┌─────────────────────────┬─────────────────────────────────┐
  │ WEAK ANSWER             │ STRONG ANSWER                   │
  ├─────────────────────────┼─────────────────────────────────┤
  │ "Next.js is the         │ "Three concrete things: route- │
  │  industry standard for  │  handler streaming, file-system │
  │  React apps and it has  │  routing matched to the flow,   │
  │  great Vercel support." │  and Vercel maxDuration=300 for │
  │                         │  the long-running agent routes. │
  │                         │  Cost: Next 16 is a moving      │
  │                         │  target."                       │
  ├─────────────────────────┼─────────────────────────────────┤
  │ Why it's weak: "industry│ Why it works: names features    │
  │ standard" is a vibe,    │ used, ties each to something in │
  │ not a reason. The       │ the codebase, owns the cost. No │
  │ interviewer hears       │ vibes. The interviewer can       │
  │ "I picked the default." │ check each claim against code.  │
  └─────────────────────────┴─────────────────────────────────┘
```

  ### Choice 2 — the agent loop substrate (the migration story)

This is the single most consequential decision in the codebase. It's a two-act answer: you hand-rolled first (deliberately), then migrated. Both halves need defending.

```
  ┌─────────────────────────────────────────────────────────────┐
  │ THEY ASK                                                    │
  │   "Why hand-roll the agent loop instead of using LangChain  │
  │    or the Vercel AI SDK from day one?"                      │
  │                                                             │
  │ WHAT THEY'RE TESTING                                        │
  │   Do you have a real reason for not using the popular tool? │
  │   Can you name what the library *didn't* give you that      │
  │   your loop needed? Or is "not invented here" the actual    │
  │   reason?                                                   │
  └─────────────────────────────────────────────────────────────┘
```

**Strong answer (Phase 1 — why hand-roll):**

> "Two requirements neither popular library exposed cleanly at the time. First, a hard `maxToolCalls` budget — Bloomreach's alpha MCP rate-limits at roughly one request per second, and I needed to bound how many tool calls one agent run could make so a runaway loop couldn't burn through the rate limit and stall every other user. Second, a forced final-synthesis turn — on the last allowed turn or once the tool-call budget was spent, the loop omits tools from the request and appends a synthesis instruction to the system prompt. Otherwise the model 'keeps thinking' and never produces the structured answer the route handler needs to emit.
>
> The hand-rolled loop is still in the repo at `lib/agents/base-legacy.ts:86-176`. You can read it. It's around ninety lines. I knew exactly what was happening on every turn."

**Strong answer (Phase 4 — why migrate):**

> "I migrated to `@aptkit/core@0.3.0` once it exposed the generic-primitive surface I needed — a `ModelProvider`, a `ToolRegistry`, a `CapabilityTraceSink`. The Blooming side is three adapter classes in `lib/agents/aptkit-adapters.ts`, around two hundred LOC total. I own the boundary; AptKit owns the loop.
>
> The reason to migrate when the primitives existed is straightforward: maintaining a custom loop is real ongoing cost — every time the Anthropic SDK shifts, every time a new content block type appears, every time I want to add observability. The library carries that cost across many users. My loop carried it just for me.
>
> The legacy loop is preserved as a rollback receipt. If the library ever takes a direction that doesn't fit my budget or synthesis semantics, I can swap back inside an afternoon."

```
  ┃ "I own the boundary; AptKit owns the loop. Three small
  ┃  adapter classes, ~200 LOC, and the legacy loop is preserved
  ┃  for the day I need to peel back to it."
```

```
  Likely follow-ups on the loop substrate
        │
        ▼
  You give the hand-roll-then-migrate answer.
        │
        ├─► IF THEY ASK "WHAT ABOUT VERCEL AI SDK?"
        │     Vercel AI SDK at the time was tuned for chat
        │     and basic tool-use. My loop needed the budget +
        │     forced synthesis. The shape didn't fit. Today
        │     it might; I haven't re-evaluated.
        │
        ├─► IF THEY ASK "WHY NOT LANGCHAIN?"
        │     LangChain is a framework, not a primitive. It
        │     wants to own the whole graph. I wanted a library
        │     that lets me own the boundary — same reason I
        │     picked AptKit later, not LangChain.
        │
        ├─► IF THEY ASK "WHAT IF APTKIT DIES?"
        │     The legacy loop is in the repo and tested. Peel
        │     back in an afternoon. The seam is the three
        │     adapters; replacing them with calls back to
        │     runAgentLoop is mechanical.
        │
        └─► IF THEY ASK "AI suggested this?"
              Phase 1 was deliberate — I knew the budget
              constraint. Phase 4 was evaluated-and-accepted —
              I read AptKit's primitive surface and decided
              the boundary was clean enough. Both are mine
              to own.
```

  ### Choice 3 — the DataSource seam

```
  ┌─────────────────────────────────────────────────────────────┐
  │ THEY ASK                                                    │
  │   "Why an abstract DataSource interface? You only have one  │
  │    real backend."                                           │
  │                                                             │
  │ WHAT THEY'RE TESTING                                        │
  │   Did you build an abstraction speculatively (the cardinal  │
  │   junior sin), or did the abstraction earn its place by     │
  │   surviving a swap? Can you name the swap?                  │
  └─────────────────────────────────────────────────────────────┘
```

**Strong answer:**

> "It earned its place by surviving two swaps. The seam lives at `lib/data-source/types.ts` — `callTool(name, args) → { result, durationMs, fromCache }` and `listTools()`. That's the entire surface every agent depends on.
>
> Today there are two adapters. `BloomreachDataSource` is the live MCP client — HTTPS, OAuth via PKCE plus dynamic client registration, the ~1 req/s rate-limit + retry. `SyntheticDataSource` is a 516-LOC in-process substrate that satisfies the same surface — no network, no auth, used by `live-synthetic` mode for development without burning the alpha server's rate limit.
>
> A third adapter — SQL-backed — lived behind this seam briefly and was retired. Two adapter swaps, zero caller-surface change. That's the receipt. The agents in `lib/agents/*.ts` don't know which one's plugged in; the route handler picks based on the `bi:mode` value.
>
> I'm not future-proofing for a swap I haven't done. I've done two. The seam is paid for."

```
  ┃ "I'm not future-proofing for a swap I haven't done.
  ┃  I've done two. The seam is paid for."
```

  ### Choice 4 — NDJSON over `ReadableStream`, not server-sent events

```
  ┌─────────────────────────────────────────────────────────────┐
  │ THEY ASK                                                    │
  │   "Why NDJSON over fetch instead of EventSource?"           │
  │                                                             │
  │ WHAT THEY'RE TESTING                                        │
  │   Do you know what EventSource costs vs gives you? Did you  │
  │   pick NDJSON for a real reason or because you'd never set  │
  │   up SSE before?                                            │
  └─────────────────────────────────────────────────────────────┘
```

**Strong answer:**

> "EventSource (`EventSource` API) doesn't let you send a POST body and doesn't let you set custom auth headers on the request. My routes are POST — the request body carries the briefing parameters and the session cookie carries auth. With EventSource I'd have to encode the body into the URL and rebuild the auth dance. That's friction with no payoff.
>
> NDJSON over `fetch` is simpler: one POST, one streaming body, one parser. I have a shared kernel at `lib/streaming/ndjson.ts` — `readNdjson` — that powers four streaming surfaces: the briefing feed via `useBriefingStream`, the investigation flow via `useInvestigation`, the demo-capture script via `useDemoCapture`, and the test harness. Same parser, four callers, four event-type unions.
>
> The cost is no built-in reconnect logic — EventSource gives you that for free. I handle reconnect for the specific case I care about (alpha-server token revocation) at the application layer with a one-shot guard. That's the only reconnect I need; for everything else, a streaming response that fails is a real failure the user should see."

  ### Choice 5 — no database, session-keyed in-memory maps

```
  ┌─────────────────────────────────────────────────────────────┐
  │ THEY ASK                                                    │
  │   "No database? Really?"                                    │
  │                                                             │
  │ WHAT THEY'RE TESTING                                        │
  │   Do you understand what a DB buys you, and can you defend  │
  │   not having one? Or are you about to give a "well I just   │
  │   didn't get to it yet" answer that signals you don't       │
  │   know what state really lives where?                       │
  └─────────────────────────────────────────────────────────────┘
```

**Strong answer:**

> "No database is the right call for what this app actually is. A briefing is ephemeral — the user runs it, sees it, investigates one anomaly, maybe takes the recommendation, and the run is done. Nothing in the workflow asks me to query yesterday's briefings or correlate across runs. The data the user cares about historically lives in Bloomreach already; I'm just reading it.
>
> State today lives in `lib/state/insights.ts` as session-keyed in-memory Maps. Each `sessionId` gets its own sub-feed — insights, investigations, anomalies — keyed under one outer map keyed by session. The session map is never wiped; the per-session sub-maps are cleared at the start of each briefing run.
>
> The story behind 'session-keyed': there was a real bug here. The earliest version had a single module-level Map and `putInsights` called `clear()` on it. On a warm Vercel instance with two users running briefings concurrently, user A's `putInsights` call would wipe user B's feed mid-investigation. I session-keyed the map and the bug went away. That bug is the reason the file's comment reads the way it does.
>
> The cost I'm paying: cross-instance state. If Vercel routes a second request from the same user to a different warm instance, that user starts fresh. For demo and prototyping that's acceptable — the demo snapshot is committed JSON that any instance can serve. For production at scale, the trigger to add a DB is two instances in the rotation. I'm one warm instance behind."

```
  ┌─────────────────────────┬─────────────────────────────────┐
  │ WEAK ANSWER             │ STRONG ANSWER                   │
  ├─────────────────────────┼─────────────────────────────────┤
  │ "I'm just using         │ "No DB is the right call: the   │
  │  in-memory maps for     │ data lives in Bloomreach        │
  │  now, I'd add a         │ already, briefings are          │
  │  database before        │ ephemeral. Session-keyed maps   │
  │  shipping for real."    │ at lib/state/insights.ts —     │
  │                         │ session-keyed BECAUSE I had a   │
  │                         │ concurrent-user wipe bug with   │
  │                         │ module-level state. Trigger to  │
  │                         │ add a DB is a second instance."  │
  ├─────────────────────────┼─────────────────────────────────┤
  │ Why it's weak: "for     │ Why it works: names the         │
  │ now" signals you        │ design call (no DB is correct), │
  │ haven't thought it      │ the receipt (a real bug fixed), │
  │ through. Senior         │ the cost (cross-instance), the  │
  │ engineers don't have    │ trigger to revisit. No "for     │
  │ "for now" plans.        │ now" — every word is owned.     │
  └─────────────────────────┴─────────────────────────────────┘
```

  ### Choice 6 — Sonnet 4.6 as agent, Haiku as classifier

```
  ┌─────────────────────────────────────────────────────────────┐
  │ THEY ASK                                                    │
  │   "Why Sonnet 4.6 specifically? Why not GPT-4 or a smaller  │
  │    model for the agents?"                                   │
  │                                                             │
  │ WHAT THEY'RE TESTING                                        │
  │   Do you know what each model is good at? Did you measure?  │
  │   Or did you default to whatever your tooling tab was open  │
  │   to?                                                       │
  └─────────────────────────────────────────────────────────────┘
```

**Strong answer:**

> "Sonnet 4.6 for the three agent loops — monitoring, diagnostic, recommendation — because they reason over multiple turns of tool use and need to handle Bloomreach EQL query construction, evidence weighing, and structured-output adherence. That's the reasoning surface I needed. Sonnet 4.6 holds context across the loop better than Haiku does and costs less per token than the top-tier model.
>
> Haiku 4.5 for one specific surface: intent classification in the free-form QueryBox at the bottom of the feed. The classifier reads a one-line user message and routes to one of a small set of intents. That's a cheap, fast, single-shot classification — Haiku is purpose-built for it. Putting Sonnet on that surface would be paying ten times the cost for response time the user actually notices.
>
> I didn't run a head-to-head against GPT-4. Both Anthropic and OpenAI offer comparable reasoning at this tier; I'm on the Anthropic stack because the agent loop is built against the Anthropic SDK and the migration cost of swapping providers would buy me nothing measurable for this app."

  ## When you don't know

The interviewer can push you into model-internals territory — context windows, attention patterns, why Sonnet handles long tool-use chains better than Haiku — where you have not gone deep.

```
  ╔═══════════════════════════════════════════════════════════════╗
  ║ WHEN YOU DON'T KNOW                                           ║
  ║                                                               ║
  ║   They ask: "What's the actual mechanism that makes Sonnet    ║
  ║   better than Haiku at multi-turn tool use? Is it context     ║
  ║   window, training data, attention?"                          ║
  ║                                                               ║
  ║   You picked on observed behavior, not internals. You read    ║
  ║   the docs; you ran the loops; Sonnet held context, Haiku     ║
  ║   didn't. You don't know the substrate-level why.             ║
  ║                                                               ║
  ║   Say:                                                        ║
  ║   "I picked on observed behavior, not internals. In my own    ║
  ║    loops Sonnet held the multi-turn tool-use context — the    ║
  ║    diagnostic agent runs five to eight turns sometimes —      ║
  ║    and Haiku reliably lost track around turn three or four.   ║
  ║    Whether that's context window, training mix, or attention  ║
  ║    pattern — I haven't gone deep enough to tell you which.    ║
  ║    I treat the model selection as an empirical call with the  ║
  ║    eval surface I have. If we wanted to dig into the why,     ║
  ║    can you start me off?"                                     ║
  ║                                                               ║
  ║   What this signals: a real empirical methodology (I ran it,  ║
  ║   I observed, I picked), honesty about the substrate gap,     ║
  ║   willingness to learn in the room. All three are strong.     ║
  ║                                                               ║
  ║   Do NOT say:                                                 ║
  ║   "Sonnet has a bigger context window and more attention      ║
  ║    heads, so..." — fabricated mechanism-talk in an area you   ║
  ║   haven't read is the worst move. Anthropic engineers in      ║
  ║   the loop will catch it; non-experts will smell the          ║
  ║   confidence-without-receipts.                                ║
  ╚═══════════════════════════════════════════════════════════════╝
```

  ## What you'd change

If you were redoing the choices today, the one you'd revisit hardest is **the alias layer for tool-coverage dependencies**. The coverage map (which agent depends on which tool being present) currently matches on exact event-name strings. That works for the current Bloomreach workspace. For any other workspace with the same conceptual events under different names, the coverage map silently goes red. The change: an alias layer between the agent's conceptual dependency and the workspace's actual tool name. Trigger to do it: a second workspace.

  ## One-page summary

**Core claim:** every load-bearing choice in this codebase has a real defense and a real cost. The defense is the axis you optimized for; the cost is the axis you didn't. Senior signal is naming both without flinching.

**Questions covered:**
- *Next.js 16?* → streaming routes, file-system routing, `maxDuration = 300`. Cost: moving target.
- *Hand-roll the loop?* → `maxToolCalls` + forced synthesis turn. Migrated to `@aptkit/core@0.3.0` once primitives existed. Legacy preserved at `base-legacy.ts:86-176`.
- *DataSource seam?* → paid for itself with two real adapter swaps. Surface at `lib/data-source/types.ts`.
- *NDJSON over `fetch`?* → POST body + custom auth headers; one shared `readNdjson` kernel across four surfaces.
- *No DB?* → ephemeral briefings, session-keyed maps, real bug fixed (concurrent-user wipe). Trigger to add: a second warm instance.
- *Sonnet 4.6 + Haiku?* → reasoning-tier for agents, cheap-tier for intent classification. Picked empirically.

**Pull quotes:**
```
┃ "I own the boundary; AptKit owns the loop. Three small
┃  adapter classes, ~200 LOC, and the legacy loop is preserved
┃  for the day I need to peel back to it."
```
```
┃ "I'm not future-proofing for a swap I haven't done.
┃  I've done two. The seam is paid for."
```

**What you'd change:** add an alias layer between agent-conceptual tool dependencies and workspace-actual tool names, so coverage doesn't silently go red on a second workspace.
