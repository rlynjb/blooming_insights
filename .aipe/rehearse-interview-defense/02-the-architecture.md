# Chapter 2 — The architecture

  ## Opening hook

Ten minutes into a senior interview, someone says "walk me through the architecture." What they want is a whiteboard walk — you drawing the system, live, while narrating, without hesitation. What most candidates do is describe it in prose ("so there's a frontend, and then it calls the backend, and the backend calls the AI…") and lose the interviewer somewhere around minute two.

This chapter is about drawing the diagram from scratch in ninety seconds or less, with the four bands, the labeled hops, and the two off-to-the-side scaffolds (the eval flywheel and the CI gate). You should be able to re-draw this diagram on a hotel notepad if the wifi drops during a video interview. It's that important.

  ## The chapter-opening diagram

This is the whiteboard walk. Every hop labeled, every band named, every seam marked. You re-draw this from memory.

```
  blooming insights — the architecture, at a whiteboard

  ┌─ Browser (React 19) ─────────────────────────────────────────────┐
  │                                                                  │
  │  app/page.tsx (461 LOC)                                          │
  │  ├─ useBriefing()          → GET /api/briefing (NDJSON)           │
  │  ├─ useLiveMode()          → live vs demo toggle (localStorage)   │
  │  └─ useInvestigation()     → POST /api/agent (NDJSON)             │
  │                                                                  │
  │  StatusLog + ReasoningTrace  ← streams agent thinking to UI      │
  │  readNdjson kernel (64 LOC) ← ONE kernel, 4 streaming consumers   │
  │                                                                  │
  └────────────────────────────┬─────────────────────────────────────┘
                               │  hop 1: fetch() + ReadableStream
                               │  Content-Type: application/x-ndjson
                               ▼
  ┌─ Route layer (Next.js 16 App Router · edge=off) ─────────────────┐
  │                                                                  │
  │  /api/briefing   → runs monitoringAgent, streams Insight[]       │
  │  /api/agent      → step=diagnose | recommend | null (combined)   │
  │  /api/mcp/*      → OAuth callbacks, tool coverage, capture        │
  │                                                                  │
  │  lib/state/insights.ts                                           │
  │    session-keyed Map<sessionId, SessionFeed>                     │
  │    ↑ was Map<id, Insight> (AI-defaulted, concurrent-user wipe)   │
  │                                                                  │
  │  30s per-call timeout · 300s route budget · maxDuration=300      │
  │                                                                  │
  └────────────────────────────┬─────────────────────────────────────┘
                               │  hop 2: agent.run(input)
                               ▼
  ┌─ Agent layer (@aptkit/core@0.3.0) ───────────────────────────────┐
  │                                                                  │
  │  5 agents:                                                       │
  │   ┌────────────────┐    ┌────────────────┐    ┌───────────────┐  │
  │   │ monitoring     │    │ diagnostic     │    │ recommendation│  │
  │   │ Sonnet 4.6     │───▶│ Sonnet 4.6     │───▶│ Sonnet 4.6    │  │
  │   └────────────────┘    └────────────────┘    └───────────────┘  │
  │   ┌────────────────┐    ┌────────────────┐                       │
  │   │ query          │    │ classifyIntent │                       │
  │   │ Sonnet 4.6     │    │ Haiku          │  ← deterministic     │
  │   └────────────────┘    └────────────────┘    supervisor         │
  │                                                                  │
  │  Bridge: lib/agents/aptkit-adapters.ts (~263 LOC)                │
  │   → AnthropicModelProviderAdapter                                │
  │   → BloomingToolRegistryAdapter                                  │
  │   → BloomingTraceSinkAdapter                                     │
  │                                                                  │
  │  Rollback: lib/agents/*-legacy.ts (9 files, ~1000 LOC preserved) │
  │                                                                  │
  │  BudgetTracker (per-investigation ceiling, shared across steps)  │
  │  pricing.ts (Anthropic-priced; aptkit's estimateCost is OpenAI)  │
  │  Prompt caching: cache_control:'ephemeral' on system prompt      │
  │                                                                  │
  └────────────────────────────┬─────────────────────────────────────┘
                               │  hop 3: DataSource port (71 LOC)
                               │  → the seam. 4 uses, 0 caller changes.
                               ▼
  ┌─ Provider layer ─────────────────────────────────────────────────┐
  │                                                                  │
  │   ┌─────────────────────┐                                        │
  │   │ Bloomreach          │   → live path                          │
  │   │ DataSource          │                                        │
  │   └──────────┬──────────┘                                        │
  │              │  hop 4: MCP over StreamableHTTP                   │
  │              │  OAuth PKCE + Dynamic Client Registration         │
  │              ▼                                                   │
  │   loomi-connect MCP server ──▶ Bloomreach Engagement             │
  │                                                                  │
  │   ┌─────────────────────┐                                        │
  │   │ Synthetic           │   → offline eval / capture path        │
  │   │ DataSource          │                                        │
  │   └─────────────────────┘                                        │
  │                                                                  │
  │   ┌─────────────────────┐                                        │
  │   │ FaultInjecting      │   → decorator; 4 fault modes           │
  │   │ DataSource          │      at configurable rates             │
  │   └─────────────────────┘                                        │
  │                                                                  │
  └──────────────────────────────────────────────────────────────────┘

     Off to the side: the eval flywheel (not in the request path)
     ┌───────────────────────────────────────────────────────────┐
     │  eval/goldens/*   ← 10 goldens, 4 signal classes           │
     │  eval/rubrics/*   ← 2 rubrics × 4 dims × 5-scale × verdict │
     │  eval/baseline.json ← committed; the regression floor      │
     │  eval/gate.eval.ts  ← blocks if any dim regresses > 10pp   │
     │  eval/load.eval.ts  ← semaphore-based, LOAD_N / LOAD_K     │
     │  eval/report.eval.ts ← reads receipts → p50/p95/p99        │
     └───────────────────────────────────────────────────────────┘

     .github/workflows/ci.yml → typecheck + npm test + npm run build
     on every push and PR
```

That's the whole thing on one whiteboard. Every hop labeled. Every band named. Every seam marked. The reader who traces this diagram in order (browser → route → agent → provider) sees the request flow; the reader who scans it top-to-bottom sees the architecture.

  ## The two questions this chapter defends

Architecture rounds have two big questions. First: "walk me through the system." Second: "walk me through one request." This chapter defends both — the shape and the flow.

  ### Question 1 — Walk me through the system

┌─────────────────────────────────────────────────┐
│ THEY ASK                                        │
│   "Walk me through the architecture."           │
│                                                 │
│ WHAT THEY'RE TESTING                            │
│   Can you narrate a system as a system, not a   │
│   list of features? Do you know which parts     │
│   are load-bearing vs. incidental? Can you talk │
│   while you draw?                               │
└─────────────────────────────────────────────────┘

The strong answer walks the four bands in order, names the two off-to-the-side scaffolds, and marks the three receipts (readNdjson kernel, AptKit bridge, DataSource seam). Say it while you're drawing:

> *"I'll draw it in four bands — browser, routes, agents, providers — plus two scaffolds off to the side.*
>
> *[Draw browser band] Top band is the browser. React 19, Next.js 16. `app/page.tsx` is 461 lines, extracted into three hooks — `useBriefing`, `useLiveMode`, `useInvestigation`. The panel that streams the agents' reasoning is `StatusLog` wrapping `ReasoningTrace`. All the streaming surfaces — the briefing, the diagnose step, the recommend step, and the free-form query — consume one shared kernel called `readNdjson`, which is 64 lines of code. Four consumers, one kernel. That's the strongest deduplication receipt on the frontend.*
>
> *[Draw route band] Second band is the Next.js route layer. Two main routes — `/api/briefing` for the monitoring pass, and `/api/agent` for the diagnostic and recommendation steps. The `maxDuration` is 300 seconds because Vercel's Pro tier maxes there, and I have a 300-second route budget composed with 30-second per-call timeouts at `lib/mcp/transport.ts`. Session state lives in a `Map<sessionId, SessionFeed>` — session-keyed, not id-keyed, which I'll come back to when we talk about the concurrent-user bug.*
>
> *[Draw agent band] Third band is the agent layer. Five agents on top of `@aptkit/core@0.3.0` — monitoring, diagnostic, query, recommendation, and a Haiku classifier called `classifyIntent`. The Haiku classifier is the deterministic supervisor — a small model routing to a big model. AptKit is my agent primitive; I wrapped it in about 263 lines of adapter code — three classes: `AnthropicModelProviderAdapter`, `BloomingToolRegistryAdapter`, `BloomingTraceSinkAdapter`. The legacy pre-AptKit loop is still in the repo at `*-legacy.ts` as a rollback receipt.*
>
> *[Draw provider band] Fourth band is providers. The critical piece is a 71-line port called `DataSource`. I've used it four different ways — the real Bloomreach adapter, a Synthetic adapter for offline eval, and a `FaultInjectingDataSource` decorator that wraps any of them and injects failures at configurable rates. Four uses, zero caller-side changes. That's the strongest seam receipt in the whole system.*
>
> *[Draw scaffolds] Off to the side, two scaffolds. The eval flywheel — 10 goldens, 2 rubrics with 4 dimensions each, a baseline committed to the repo, and a gate that blocks if any dimension regresses more than 10 percentage points. And CI on GitHub Actions — typecheck, tests, build, on every push."*

That's the walkthrough. Roughly 90 seconds if you're drawing at a natural pace. You've named 12 real files and given three concrete receipts (readNdjson 64 LOC / 4 consumers, AptKit adapters 263 LOC, DataSource 71 LOC / 4 uses). No hedging. No filler.

┌─────────────────────────┬─────────────────────────┐
│ WEAK ANSWER             │ STRONG ANSWER           │
├─────────────────────────┼─────────────────────────┤
│ "There's a Next.js      │ "Four bands. Browser at │
│ frontend that calls the │ the top runs a shared   │
│ backend, and the        │ 64-line NDJSON kernel   │
│ backend calls Claude    │ across four streaming   │
│ through some agents.    │ surfaces. The agent     │
│ There's OAuth for       │ layer is five agents on │
│ Bloomreach. There's a   │ @aptkit/core, wrapped   │
│ streaming thing for the │ in 263 lines of adapter │
│ UI. Oh, and I have some │ code. The provider band │
│ evals."                 │ is behind a 71-line     │
│                         │ DataSource port with    │
│                         │ four uses. The eval     │
│                         │ flywheel and CI gate    │
│                         │ sit off to the side."   │
├─────────────────────────┼─────────────────────────┤
│ Why it's weak:          │ Why it works:           │
│ No structure. Just a    │ Named bands. Named LOC. │
│ list of things. "Some   │ Named receipts. Every   │
│ agents" and "some evals"│ number is verifiable in │
│ signal the candidate    │ the repo. You could     │
│ doesn't remember the    │ walk from here to any   │
│ shape. No LOC anchors,  │ file. No receipt is     │
│ no receipts, no seams.  │ vague.                  │
└─────────────────────────┴─────────────────────────┘

┃ "A named receipt is worth more than a paragraph
┃  of description. Every band gets one number the
┃  interviewer can verify."

  ### Question 2 — Walk me through one request

┌─────────────────────────────────────────────────┐
│ THEY ASK                                        │
│   "Walk me through what happens when a user      │
│   clicks an insight to investigate it."         │
│                                                 │
│ WHAT THEY'RE TESTING                            │
│   Can you trace a request end-to-end? Do you    │
│   know which parts happen where? Can you name   │
│   the failure modes at each hop?                │
└─────────────────────────────────────────────────┘

Here's the request flow — the diagnose step, end to end:

```
  One investigation, end-to-end

  Browser                    Route (Next.js)         Agent (AptKit)         Provider
  ────────                    ───────────────         ────────────────       ────────
   click InsightCard
        │
        │  useInvestigation.start(insightId, step='diagnose')
        ▼
   POST /api/agent   ─────►   step=diagnose
   NDJSON stream              validate session
                              read Insight from Map<sessionId, feed>
                              BudgetTracker.check()
                                    │
                                    │  agent.run(diagnosticAgent, input)
                                    ▼
                                              agent loop tick 1:
                                              modelProvider.stream(msgs)
                                              → tool_use: execute_analytics_eql
                                                    │
                                                    │  DataSource.callTool()
                                                    ▼
                                              BloomreachDataSource
                                              → MCP call over StreamableHTTP
                                              → 30s per-call timeout
                                              → response envelope: structuredContent
                                              ← tool_result
                                                    │
                                              onCapabilityEvent(receipt)
                                              → hooks emit to trace sink
                                                    │
                                              agent loop tick 2:
                                              model reasons about result
                                              → tool_use: another EQL query
                                              ...
                                              → final text (Diagnosis)
                                    │
                              ◄─── result
                              stream events:
                                reasoning_step, tool_call_start,
                                tool_call_end, diagnosis, done
                              on error: emit `error` event, close stream
        │
        ◄─── NDJSON events tick in
   StatusLog renders each event
   sessionStorage stashes result
   → step 3 (recommend) hydrates instantly on click
```

Say it out loud:

> *"When a user clicks an InsightCard, `useInvestigation.start` posts to `/api/agent` with the insight ID and step equals 'diagnose'. The route validates the session, reads the Insight from the session-keyed feed map, checks the BudgetTracker to make sure we're under the per-investigation ceiling, and starts the agent.*
>
> *AptKit runs the loop. Each tick, the model streams tokens back — either text, or a `tool_use` block. On a `tool_use`, AptKit routes through `BloomingToolRegistryAdapter` down to the `DataSource` port, which the running configuration wires to `BloomreachDataSource`. That calls MCP over StreamableHTTP with a 30-second per-call timeout. The MCP server proxies to Bloomreach. Result comes back as a `tool_result` block. The trace sink emits an NDJSON event to the response stream — reasoning step, tool call start, tool call end.*
>
> *The browser reads the NDJSON via the shared `readNdjson` kernel and paints each event into `StatusLog`. When the agent produces its final `Diagnosis`, that streams as a `diagnosis` event and the browser stashes it in `sessionStorage`, so the recommend step (step 3) hydrates instantly when the user clicks through."*

That's the walkthrough. Every hop labeled. Every seam named. Nothing hand-waved.

  ## The follow-up decision tree

Once you land the architecture walk, the interviewer will pick one branch to drill into. Here's what they usually pick and what to say:

```
  You walk the architecture.
        │
        ▼
  ┌─► "How does the NDJSON streaming work under the hood?"
  │      They're testing whether you built it or copied it.
  │      Answer: "Server writes NDJSON to a ReadableStream. Client
  │      uses fetch + reader.read() + a TextDecoder. The kernel is
  │      lib/streaming/readNdjson.ts — 64 LOC. Handles partial lines
  │      by buffering. Four consumers use it identically."
  │
  ├─► "Why session-keyed instead of just an ID map?"
  │      They're testing your concurrent-user thinking.
  │      Answer: Chapter 6. This is the AI-wrote-the-bug story.
  │      Get to the receipt: "It was Map<id, Insight>. Two users
  │      hitting the same node overwrote each other's feeds. Fixed
  │      by keying on session, not insight ID."
  │
  ├─► "How does the DataSource abstraction pay off?"
  │      They're testing whether you know why it's there.
  │      Answer: "Four uses, zero caller-side changes. Bloomreach,
  │      Synthetic for offline eval, FaultInjecting as a decorator
  │      on either. The eval flywheel wouldn't exist without it —
  │      goldens run against Synthetic, no MCP round-trips."
  │
  └─► "What's the AptKit adapter layer doing?"
         They're testing whether you understand what you're
         wrapping and why.
         Answer: Chapter 3, Choice #2. "AptKit owns the loop.
         I own the boundary. Three adapters — ModelProvider,
         ToolRegistry, TraceSink — total ~263 LOC. Legacy loop
         preserved at *-legacy.ts as rollback receipt."
```

  ## When you don't know

The territory where architecture questions push you past your depth is usually the internals of a library you're using. AptKit's internal scheduler. Next.js's App Router streaming internals. React 19's transition-tuning. You didn't build any of those. You built on top of them.

```
╔═══════════════════════════════════════════════╗
║ WHEN YOU DON'T KNOW                           ║
║                                               ║
║   They ask: "How does AptKit actually manage  ║
║   the tool-use loop internally? What's the    ║
║   scheduler look like?"                       ║
║                                               ║
║   You have not read AptKit's source. You use  ║
║   its API. You've read the interface but not  ║
║   the guts.                                   ║
║                                               ║
║   Say:                                        ║
║   "I haven't read AptKit's internal           ║
║    scheduler. What I know is the contract at  ║
║    my adapter boundary — AptKit calls into    ║
║    ModelProviderAdapter to get a streamed     ║
║    response, then ToolRegistryAdapter to      ║
║    dispatch tool_use blocks, then hands       ║
║    tool_result blocks back to the model on    ║
║    the next tick. There's an iteration        ║
║    budget I can configure. From the outside   ║
║    it behaves like a bounded ReAct loop.      ║
║    If you want to dig into how it schedules   ║
║    parallel tool calls internally, I'd want   ║
║    to read the source with you — I haven't."  ║
║                                               ║
║   What this signals: confidence about the     ║
║   boundary you own (the adapters), no fake    ║
║   confidence about internals you don't, and   ║
║   an offer to read together. All three land   ║
║   as senior.                                  ║
║                                               ║
║   Do NOT say:                                 ║
║   "It probably uses some kind of async queue  ║
║    with priority-based scheduling and…"       ║
║   The moment you speculate about internals    ║
║   you didn't read, you set yourself up to be  ║
║   wrong on the next follow-up. The senior     ║
║   move is naming the boundary you own.        ║
╚═══════════════════════════════════════════════╝
```

  ## What you'd change

If you were building this today from scratch, the biggest architectural change you'd make earlier: extract `readNdjson` on day one, not on day 40. When you started, four streaming surfaces (`useBriefing`, `useInvestigation`, `query`, `capture`) each had their own inline `while(!done)` loop. Extracting the shared kernel came late in the project. It shipped cleanly, but the debt cost about a week of drift where the loops diverged slightly. The lesson: when you know you'll have more than one streaming consumer, extract the reader first, not last.

The band structure would stay. The DataSource port would stay. The AptKit boundary would stay. The eval flywheel would come earlier, too — probably before the second agent was written.

  ## The one-page summary

**Core claim.** blooming insights is a four-band system with two off-to-the-side scaffolds. Browser (React 19, one shared 64-LOC NDJSON kernel). Route (Next.js 16, session-keyed feed map). Agent (5 agents on @aptkit/core, ~263 LOC of adapters). Provider (DataSource port, 4 uses, 0 caller changes). Off to the side: eval flywheel + CI gate.

**The questions covered.**

  → "Walk me through the architecture." → four bands + two scaffolds + three receipts (64/263/71 LOC).
  → "Walk me through one request." → browser → route → agent tick → DataSource → MCP → back through the stream to StatusLog.
  → "How does NDJSON work?" → server writes to ReadableStream, client reads via `readNdjson.ts` kernel, buffering handles partial lines.
  → "Why session-keyed?" → concurrent-user wipe fix (Chapter 6).
  → "Why the DataSource abstraction?" → four uses, zero caller changes; the eval flywheel depends on it.

**The pull quote.**

  → *"A named receipt is worth more than a paragraph of description."*

**What you'd change.** Extract `readNdjson` on day one, not day 40. Introduce the eval flywheel before the second agent. Everything else stays.
