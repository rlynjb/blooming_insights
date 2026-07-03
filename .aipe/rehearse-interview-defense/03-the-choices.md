# Chapter 3 — The choices

  ## Opening hook

Every senior interview has a "why did you pick that" round. Framework, agent primitive, streaming protocol, storage — the interviewer picks the choice they know well and asks you to defend it. Most candidates fail this round the same way: they can name what they picked, but they can't name what they picked *against*, or the axis they picked on. The choice sounds like something that happened *to* them.

This chapter defends the six load-bearing choices in blooming insights. Each choice names the alternative you considered, the axis you picked on, and one cost you're paying — the tradeoff, not the win. The senior signal is that you know the cost. Anyone can name a benefit.

  ## The chapter-opening diagram

Here's the decision tree for the six choices, with the picked option highlighted at each branch.

```
  The six load-bearing choices — the picked path

  ┌─ 1. Framework ──────────────────────────────────────────┐
  │  Next.js 16 ★  ←  picked                                │
  │  vs. Remix, SvelteKit, Astro                            │
  │  Mode: DELIBERATE (read the docs, evaluated)            │
  └───────────────────────────┬─────────────────────────────┘
                              │
  ┌─ 2. Agent primitive ─────▼──────────────────────────────┐
  │  @aptkit/core@0.3.0 ★  ← picked, migrated to             │
  │  vs. own runAgentLoop (kept as *-legacy.ts rollback)    │
  │  vs. LangGraph, Mastra                                  │
  │  Mode: EVALUATED-AND-ACCEPTED                           │
  └───────────────────────────┬─────────────────────────────┘
                              │
  ┌─ 3. Provider seam ───────▼──────────────────────────────┐
  │  DataSource port ★  ←  picked, 5 uses receipt           │
  │  vs. inline MCP calls at agent site                     │
  │  vs. facade on top of MCP client directly               │
  │  Mode: DELIBERATE                                       │
  │  → 5th use: swappable MCP server (Bloomreach as         │
  │    default PRESET, not codebase identity)               │
  └───────────────────────────┬─────────────────────────────┘
                              │
  ┌─ 4. Streaming transport ─▼──────────────────────────────┐
  │  NDJSON over fetch/ReadableStream ★  ←  picked          │
  │  vs. Server-Sent Events (SSE)                           │
  │  vs. WebSocket                                          │
  │  Mode: DELIBERATE                                       │
  └───────────────────────────┬─────────────────────────────┘
                              │
  ┌─ 5. Supervisor ──────────▼──────────────────────────────┐
  │  Deterministic dispatcher ★  ←  picked                  │
  │  (code decides which agent runs next)                   │
  │  vs. LLM router / meta-agent                            │
  │  Mode: DELIBERATE                                       │
  └───────────────────────────┬─────────────────────────────┘
                              │
  ┌─ 6. Portfolio hardening ─▼──────────────────────────────┐
  │  Sequenced 6-phase plan ★  ←  picked, shipped, COMPLETE │
  │  vs. ship-then-harden-if-asked                          │
  │  vs. hardening as one-time audit                        │
  │  Mode: DELIBERATE (this is the L5 closer)               │
  └─────────────────────────────────────────────────────────┘
```

Six choices. Six pickeds. Six modes named. Each defense below takes one and walks it. Choice 3 (DataSource seam) has a second defense embedded — the "why swappable MCP" question — because the fifth use of that same port is the swappable-MCP receipt.

  ## Choice 1 — The framework

┌─────────────────────────────────────────────────┐
│ THEY ASK                                        │
│   "Why Next.js? Why not Remix or SvelteKit?"    │
│                                                 │
│ WHAT THEY'RE TESTING                            │
│   Did you actually pick this, or did you        │
│   default to what you knew? Do you know Next    │
│   16's App Router well enough to defend it as   │
│   a runtime, not just a scaffolding tool?       │
└─────────────────────────────────────────────────┘

Say this:

> *"I picked Next.js 16 as a runtime, not as a scaffolding tool. The load-bearing feature is App Router's streaming responses — I return a `ReadableStream` from a route handler and the browser reads NDJSON events as they arrive. That's the differentiator of the whole product. The reasoning UI streams because the route streams.*
>
> *I considered Remix — I've used it. Remix's data loaders are cleaner for CRUD apps, but the streaming story is thinner and I'd be re-implementing what Next 16 gives me. SvelteKit would have been a rewrite of my frontend instincts; I've shipped React for seven years. I didn't pick Next because I'm familiar — I picked it because App Router's streaming route handler is the primitive my product depends on.*
>
> *The cost I'm paying is the Vercel `maxDuration=300` ceiling. That's the hard cap on any investigation. I know that ceiling exists, I've composed a 300-second route budget with 30-second per-call timeouts to stay under it, and if I needed longer investigations I'd move to a queue-based background job pattern."*

The move: name what streaming buys you, name what you considered, name the cost you're paying (the 300-second ceiling), and name what you'd do differently if the cost mattered more.

┃ "I picked Next.js as a runtime, not as scaffolding.
┃  The load-bearing feature is streaming route handlers."

  ## Choice 2 — Own loop → AptKit migration

This is the big one. This is the choice that shows the most senior signal in the whole book.

┌─────────────────────────────────────────────────┐
│ THEY ASK                                        │
│   "Why AptKit? Why not roll your own agent       │
│   loop, or use LangGraph?"                      │
│                                                 │
│ WHAT THEY'RE TESTING                            │
│   Do you know what an agent primitive actually  │
│   is? Did you evaluate this, or default to it?  │
│   If AptKit disappeared tomorrow, could you     │
│   run without it? Do you know the boundary you  │
│   own vs. the boundary the library owns?        │
└─────────────────────────────────────────────────┘

Say this:

> *"I started with my own loop — a shared `runAgentLoop` in `lib/agents/base.ts` that ran the Anthropic tool-use dance. It worked, but I was reinventing infrastructure — retry semantics, tool dispatch, streaming, receipt emission. Every improvement was on me.*
>
> *I migrated to `@aptkit/core@0.3.0`. I looked at LangGraph and Mastra. LangGraph is the wrong shape for me — it's a graph orchestration framework and my supervisor is deterministic, so the DAG runtime is overhead I don't need. Mastra is newer and I couldn't get comfortable with the primitive stability yet. AptKit gave me exactly one thing I needed — a well-tested agent loop with an iteration budget — and let me own everything else.*
>
> *The way I wrapped it is the interesting part. I built three adapter classes — `AnthropicModelProviderAdapter`, `BloomingToolRegistryAdapter`, `BloomingTraceSinkAdapter` — total about 263 lines of code in `lib/agents/aptkit-adapters.ts`. AptKit calls into my adapters through its own interfaces; my agent code calls into AptKit's `agent.run()` and never touches AptKit types directly at the caller site. That means if AptKit becomes a liability, I swap the adapters, put the legacy loop back, and nothing changes for callers.*
>
> *And I kept the legacy loop. `lib/agents/*-legacy.ts` — nine files, about a thousand lines, still in the repo. Not commented out. Committed. That's my rollback receipt."*

The pull quote from this defense is the one line the reader memorizes:

┃ "I own the boundary; AptKit owns the loop.
┃  Three small adapter classes, ~200 lines, and
┃  the legacy loop is preserved for the day I
┃  need to peel back to it."

┌─────────────────────────┬─────────────────────────┐
│ WEAK ANSWER             │ STRONG ANSWER           │
├─────────────────────────┼─────────────────────────┤
│ "I used AptKit because  │ "I own the boundary;    │
│ it's a solid framework  │ AptKit owns the loop.   │
│ for building AI agents. │ Three adapter classes,  │
│ It handles tool use and │ ~263 LOC, and I kept    │
│ streaming really well.  │ the legacy loop as a    │
│ You can build           │ rollback receipt. If    │
│ multi-agent workflows   │ AptKit becomes a        │
│ with it."               │ liability I swap the    │
│                         │ adapters and put the    │
│                         │ legacy loop back."      │
├─────────────────────────┼─────────────────────────┤
│ Why it's weak:          │ Why it works:           │
│ "Solid framework" is    │ Names the boundary.     │
│ marketing language. No  │ Names the LOC.          │
│ boundary named. No      │ Names the exit          │
│ rollback path. No       │ strategy. Signals you   │
│ evaluation against      │ built the wrapper       │
│ alternatives. Sounds    │ deliberately, not by    │
│ like the candidate      │ default. Every senior   │
│ picked whatever was     │ engineer knows this     │
│ trending.               │ posture.                │
└─────────────────────────┴─────────────────────────┘

  ## Choice 3 — The DataSource seam

┌─────────────────────────────────────────────────┐
│ THEY ASK                                        │
│   "You have this DataSource interface. Why not   │
│   just call MCP directly from the agents?"      │
│                                                 │
│ WHAT THEY'RE TESTING                            │
│   Do you know why abstractions pay off? Do you  │
│   have a receipt that the abstraction actually  │
│   got used, or is it speculative?               │
└─────────────────────────────────────────────────┘

Say this:

> *"The `DataSource` port is 71 lines in `lib/data-source/types.ts`. Callers depend on it. Adapters implement it. That's it — the classic port-and-adapter shape.*
>
> *The receipt is that it's shipped in five uses with zero caller-side changes. First: `McpDataSource`, the generic live path — that's an alias re-export of what used to be `BloomreachDataSource`, so Bloomreach is now the default preset, not the codebase identity. Second: `SyntheticDataSource`, which is now the default UX (`live-synthetic`) and also lets the eval flywheel run without touching any MCP server — no round-trips, no OAuth, no rate limits. Third: `FaultInjectingDataSource`, a decorator that wraps any DataSource and injects failures at configurable rates for fault-injection testing. Fourth: a historical demo adapter I added and removed with zero caller touch. Fifth: the swappable-MCP path — same port, but the running config now picks the target MCP server and auth strategy per request. That's the fifth independent use, and it's the one that turned the codebase from "Bloomreach app" into "MCP-generic app with Bloomreach preset."*
>
> *That's the strongest architectural receipt in the whole system. Anyone can draw an interface. Five independent uses with zero caller changes is the receipt that the interface is at the right seam.*
>
> *The cost I'm paying: one extra indirection layer. When I'm debugging a live issue, the stack trace goes through the DataSource adapter, so I have to know that layer exists. That's a small cost. Worth it five times over."*

The move: name what the port is (71 LOC), name the receipt (5 uses, 0 caller changes), name the cost (one extra layer). The receipt is what makes this defense different from every port-and-adapter defense you've read.

  ### Choice 3b — Why did you make the MCP server swappable?

This is the load-bearing follow-up to Choice 3. The fifth use of the DataSource port didn't have to happen. Defend the decision to generalize.

┌─────────────────────────────────────────────────┐
│ THEY ASK                                        │
│   "Why did you make the MCP server swappable?    │
│   You could have hardcoded Bloomreach."         │
│                                                 │
│ WHAT THEY'RE TESTING                            │
│   Do you know when to generalize and when to    │
│   stay specific? Can you defend an abstraction  │
│   with a receipt, or does it read as premature? │
└─────────────────────────────────────────────────┘

Say this:

> *"I generalized deliberately, and the L5 answer is that portfolio-grade code shouldn't be one-vendor-locked. If a reviewer sees this and only reads 'Bloomreach app,' they read a narrower story than the code actually tells. The code is an MCP-generic analyst with Bloomreach as the default preset.*
>
> *The reason I could do it in a day of work is that the seam already existed. The `DataSource` port had been sitting there through four uses already — `BloomreachDataSource`, `SyntheticDataSource`, `FaultInjectingDataSource`, one historical demo adapter. Adding a fifth use — a generic `McpDataSource` behind three `OAuthClientProvider` strategies — was 'lean into the seam you already built,' not 'design a new one.'*
>
> *The receipt is exactly that: the same `DataSource` port has now shipped in five uses without a single caller-surface change. If I'd been generalizing prematurely, at least one of those five uses would have forced me to change the port. None did. That's the retroactive validation that the port was at the right seam from the start.*
>
> *In the UI, Bloomreach is the default. In the code, Bloomreach is a preset. Those are different things, and the difference is what makes this defensible in a senior interview."*

┃ "Bloomreach is the default preset, not the
┃  codebase identity. Same DataSource port, now
┃  in five uses without a caller-surface change —
┃  that's the abstraction-pressure receipt."

  ## Choice 4 — NDJSON over SSE

┌─────────────────────────────────────────────────┐
│ THEY ASK                                        │
│   "Why NDJSON? SSE is the standard for streaming │
│   in browsers."                                 │
│                                                 │
│ WHAT THEY'RE TESTING                            │
│   Do you know the actual difference? Did you    │
│   consider SSE? Or did you pick NDJSON because  │
│   it's what a code example used?                │
└─────────────────────────────────────────────────┘

Say this:

> *"I picked NDJSON — newline-delimited JSON — over Server-Sent Events for two reasons.*
>
> *First, POST support. `/api/agent` takes a body — the insight ID, the step, the session ID. SSE via `EventSource` is GET-only in the browser. I'd have to either route the payload through query parameters, which limits size and leaks into logs, or switch to a POST-based SSE polyfill, which is more code than just streaming NDJSON.*
>
> *Second, control over the frame. NDJSON is one JSON object per line, delimited by `\n`. My kernel `readNdjson.ts` is 64 lines and handles partial-line buffering explicitly. SSE has its own framing (`data:`, `event:`, `id:`, blank line separator) and I'd be layering my event shape on top of that. NDJSON lets my event union — `reasoning_step`, `tool_call_start`, `tool_call_end`, `insight`, `diagnosis`, `recommendation`, `done`, `error` — be the framing.*
>
> *The cost I'm paying: no automatic reconnect. `EventSource` reconnects on drop; my `fetch` + reader doesn't. For this product it doesn't matter — an investigation is a one-shot request, not a persistent channel. If I were building a real-time dashboard I'd reconsider."*

The move: name two concrete reasons, name the cost, name when you'd reconsider. This is what "picked deliberately" sounds like.

  ## Choice 5 — Deterministic supervisor

┌─────────────────────────────────────────────────┐
│ THEY ASK                                        │
│   "Why not a supervisor LLM that decides which  │
│   agent runs? That's the standard multi-agent   │
│   pattern."                                     │
│                                                 │
│ WHAT THEY'RE TESTING                            │
│   Do you know why LLM routers are expensive     │
│   and unpredictable? Or did you just pick       │
│   whatever was easier to build?                 │
└─────────────────────────────────────────────────┘

Say this:

> *"My supervisor is code, not an LLM. `/api/briefing` runs the monitoring agent; a click through to investigate calls `/api/agent` with `step=diagnose`; then a click through to recommend calls `/api/agent` with `step=recommend`. The stage transitions are user actions. The only LLM in the routing layer is `classifyIntent` on the free-form query — a Haiku model that decides whether a user's typed question is a data query or a chat, and that's a small-model call, not a routing decision that spawns work.*
>
> *Deterministic routing gives me three things. Predictable cost — I know a full investigation is exactly one diagnostic run plus one recommendation run. Debuggability — the stack trace is straight line, no ambiguity about who called what. And no compounding LLM error — a supervisor LLM that occasionally routes to the wrong agent is a bug I don't have.*
>
> *The cost is flexibility. A supervisor LLM could handle novel investigation shapes without new code. My deterministic dispatcher can't. For this product the loop is fixed — what changed, why, what to do — so I don't need flexibility there. If the product grew to include exploratory analyst work with unknown next steps, I'd reconsider."*

  ## Choice 6 — The portfolio hardening plan

This is the closing move. This is the one that lands hardest with senior interviewers because it demonstrates you don't just build — you productionize.

┌─────────────────────────────────────────────────┐
│ THEY ASK                                        │
│   "So how do you know the system actually works? │
│   How do you know a code change didn't break    │
│   something?"                                   │
│                                                 │
│ WHAT THEY'RE TESTING                            │
│   Have you thought about production reality —   │
│   evaluation, cost, faults, regressions, CI?    │
│   Or is this a hackathon project?               │
└─────────────────────────────────────────────────┘

Say this:

> *"I put the system through a sequenced 6-phase hardening plan. Every phase shipped and left a receipt.*
>
> *Phase 1 — eval flywheel. 10 goldens across 4 signal classes. 2 rubrics, 4 dimensions each, 5-point scale, three verdicts. Judge-error resilience — if the judge itself errors, I emit a `judge_error` placeholder rather than dropping the row. Blind calibration protocol drafted; a Session D pilot ran AI-vs-AI as a stress test with a `pilotWarning` flag stamped on the output so I don't confuse it with real human calibration.*
>
> *Phase 2 — observability. AptKit exposes an `onCapabilityEvent` hook; I use it to emit receipts that `eval/report.eval.ts` reads back to compute p50/p95/p99 latency and token cost per phase.*
>
> *Phase 3 — cost controls. Prompt caching on the system prompt with `cache_control: 'ephemeral'`. Validated live — the logs show `cache_creation_input_tokens: 3168` on the first call and `cache_read_input_tokens: 3168` on the next. My own pricing helper in `lib/agents/pricing.ts` because AptKit's built-in `estimateCost` is OpenAI-only. And a `BudgetTracker` in `lib/agents/budget.ts` that throws `BudgetExceededError` if a per-investigation ceiling would be crossed — check-before-dispatch, not check-after, so a runaway loop can't blow past.*
>
> *Phase 4 — load and fault. A semaphore-based load harness at `eval/load.eval.ts` parameterized by `LOAD_N` and `LOAD_K`. And a `FaultInjectingDataSource` decorator with four failure modes at configurable rates. The receipt: 9 injected faults across 3 investigations, 0 investigation failures. The model reasoned around every fault.*
>
> *Phase 5 — regression gate. `eval/baseline.json` committed. `eval/gate.eval.ts` blocks a run if any dimension regresses more than 10 percentage points from baseline. CI-ready.*
>
> *Phase 6 — CI. GitHub Actions on every push and PR: typecheck, tests, build. The README documents the tier-2 claims with a one-command repro block.*
>
> *That's six phases, all shipped, all receipt-backed. That's what I mean when I say tier-2 production-grade."*

That's a long defense. Deliberate. When the interviewer asks the "how do you know it works" question, you don't answer it in one sentence. You answer it in six named phases with receipts. That's the L5 signal.

┃ "Every phase shipped and left a receipt.
┃  Every claim is verifiable in the repo."

  ## The follow-up decision tree

Each of the six choices has its own follow-up branches. Here's the tree for the two most likely branches:

```
  You defend the AptKit migration.
        │
        ▼
  ┌─► "Show me the adapter code."
  │      Open lib/agents/aptkit-adapters.ts. Walk through
  │      AnthropicModelProviderAdapter first — it wraps
  │      Anthropic's messages.stream() to conform to
  │      AptKit's ModelProvider interface. Show how you
  │      inject prompt caching via cache_control. Point at
  │      the BloomingToolRegistryAdapter next — how tool
  │      dispatch routes through DataSource.
  │
  ├─► "How would you actually roll back?"
  │      Swap agent factory to point at the legacy loop.
  │      Legacy loop imports Anthropic directly and calls
  │      DataSource for tools. Same DataSource port on both
  │      sides — that's why the port matters. Half-day
  │      migration, at most.
  │
  └─► "What if AptKit updates change the ModelProvider
       interface?"
       Break at the adapter, not at the callers. That's
       the whole point of the boundary. I update three
       classes, ~263 LOC, and callers see no diff.
```

  ## When you don't know

The territory where choice questions push past your depth is usually a competitor tool you didn't evaluate deeply. If they ask "why not LangGraph?" and you spent an hour reading the LangGraph docs, be honest about that.

```
╔═══════════════════════════════════════════════╗
║ WHEN YOU DON'T KNOW                           ║
║                                               ║
║   They ask: "Have you used LangGraph? Why not  ║
║   that? Isn't it more feature-rich than       ║
║   AptKit?"                                    ║
║                                               ║
║   You have not built a real project on         ║
║   LangGraph. You read the docs once.           ║
║                                               ║
║   Say:                                        ║
║   "I haven't shipped anything on LangGraph.   ║
║    I read the docs and looked at the graph    ║
║    orchestration model. My supervisor is      ║
║    deterministic — code decides which agent   ║
║    runs — so the DAG runtime LangGraph        ║
║    gives me would be overhead I don't need.   ║
║    If my product needed conditional edges     ║
║    or parallel fan-out with joins, that's     ║
║    exactly what LangGraph does well and I'd   ║
║    revisit. For a linear pipeline like mine,  ║
║    AptKit at ~263 LOC of adapters is enough." ║
║                                               ║
║   What this signals: you know when LangGraph  ║
║   would actually be the right pick, you know  ║
║   why yours isn't that shape, and you don't   ║
║   pretend to have shipped what you haven't.   ║
║                                               ║
║   Do NOT say:                                 ║
║   "LangGraph is too complicated for what I     ║
║    needed."                                   ║
║   That reads as dismissal. The senior move    ║
║   is naming the shape LangGraph solves for    ║
║   and why your shape is different.            ║
╚═══════════════════════════════════════════════╝
```

  ## What you'd change

If you were making these six choices again today, the one you'd revisit hardest: the deterministic supervisor. Not because it's wrong — for this product it's right. But because you'd introduce it *after* the eval flywheel, not before. Right now you can't measure whether a routing LLM would be worse or better because the eval doesn't measure monitoring at all. Once you have a monitoring eval, the routing decision could get made on data, not intuition.

The other five choices you'd make the same way. Framework, AptKit, DataSource, NDJSON, and the hardening plan are all decisions you can point at receipts for.

  ## The one-page summary

**Core claim.** Six load-bearing choices, plus the swappable-MCP follow-up embedded in Choice 3. Each defended with the alternative considered, the axis picked on, and the cost paid. The six: Next.js 16 (streaming primitive), AptKit (own the boundary, library owns the loop), DataSource port (5 uses / 0 caller changes; Bloomreach as default preset, not identity), NDJSON (POST support + framing control), deterministic supervisor (predictable cost, straight-line trace), portfolio hardening plan (six phases, all shipped, COMPLETE).

**The pull quotes.**

  → *"I own the boundary; AptKit owns the loop. Three small adapter classes, ~200 LOC, and the legacy loop is preserved for the day I need to peel back to it."*
  → *"I picked Next.js as a runtime, not as scaffolding. The load-bearing feature is streaming route handlers."*
  → *"Every phase shipped and left a receipt. Every claim is verifiable in the repo."*

**What you'd change.** Introduce the eval flywheel before the deterministic supervisor decision. That way the routing choice gets made on data, not intuition.
