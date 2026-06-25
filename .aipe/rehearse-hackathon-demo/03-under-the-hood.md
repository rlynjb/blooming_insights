# 03 — Under the hood   (6:00–8:00, 2 minutes)

  ## Opening hook

The demo just landed. The room is leaning in. Now they have a
question: how did that actually work? Chapter 3 answers it in
two minutes, one level deep, then stops.

This is where most hackathon demos lose the audience a second
time. The presenter has earned the room's attention with the
money shot, then immediately squanders it on an architecture
tour — five boxes, four arrows, six acronyms — until the room
checks out again. Don't. You pick the single most impressive
mechanism in the codebase, you draw one diagram of it, and you
explain it in three sentences. Then you move on.

The one mechanism worth showing for blooming insights is the
**adapter boundary** — `@aptkit/core` owns the agent loop
runtime, three Blooming-owned adapters bridge it to Anthropic
and to a `DataSource` interface, and the DataSource has two
implementations (Bloomreach MCP, or in-process synthetic). The
NDJSON streaming pipeline sits on top of it and bridges the
loop's callbacks to the React UI. The whole thing is what makes
the money shot possible AND what makes live-synthetic the killer
demo path. Every other architectural choice serves it.

This is the senior selling point: **library owns the loop,
Blooming owns the domain.** Swapping data sources doesn't touch
the agents. Swapping the model provider doesn't touch the
agents. The seam is where credibility lives.

  ## The time-budget bar

Two minutes. The room is willing to hear ONE technical thing
right now. Spend the budget on the right thing.

```
  ┌──────────────────────────────────────────────────────────┐
  │ ░░░░░░░░░░░░░░░░░░░░░░░░░░▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░░░░░░ │
  │ 0:00 ────────────────── 6:00 ─── 8:00 ─────────────10:00 │
  │   UNDER THE HOOD — you own 6:00 to 8:00 (2 minutes)      │
  └──────────────────────────────────────────────────────────┘
```

  ## The chapter-opening diagram — the streaming pipeline

One picture, the whole thing. This is the architecture diagram
you draw on screen or hold up on a slide. Everything you say in
chapter 3 maps onto a part of this diagram.

```
  the architecture · adapter boundaries make live-synthetic work

  ┌─ browser ───────────────────────────────────────────────────┐
  │  useInvestigation()  ← lib/hooks/useInvestigation.ts         │
  │   reader = res.body.getReader()                              │
  │   for each '\n'-delimited line:                              │
  │     setItems((p) => [...p, JSON.parse(line)])                │
  └─────────────────────────────────────────┬───────────────────┘
                                            │  HTTP body, NDJSON
                                            ▼
  ┌─ Next.js route (app/api/agent/route.ts) ─────────────────────┐
  │  ReadableStream wraps the agent run; every callback becomes  │
  │  one NDJSON line on the wire (AgentEvent contract)           │
  └─────────────────────────────────────────┬───────────────────┘
                                            │  agent.investigate(…)
                                            ▼
  ┌─ Blooming-owned agents (lib/agents/*.ts) ────────────────────┐
  │  diagnostic.ts · monitoring.ts · recommendation.ts ·         │
  │  query.ts · intent.ts                                         │
  │   ↓ thin wrappers — each constructs an @aptkit/core agent    │
  │     with two adapters injected:                              │
  └──────────────┬───────────────────────────┬───────────────────┘
                 │                           │
                 ▼                           ▼
  ┌─ AptKit loop ───────────┐  ┌─ aptkit-adapters.ts (Blooming) ─┐
  │  @aptkit/core@0.3.0      │  │  AnthropicModelProviderAdapter  │
  │  owns the agent runtime  │  │   → Anthropic SDK              │
  │  (think→tool→observe     │  │  McpToolRegistryAdapter        │
  │   loop, retries, budget) │  │   → DataSource                 │
  │  Blooming does NOT       │  │  CapabilityTraceSink           │
  │  own this anymore        │  │   → onText/onToolCall callbacks │
  └──────────────┬──────────┘  └────────────┬─────────────────────┘
                 │  loop calls tools          │
                 ▼                           ▼
  ┌─ DataSource seam (lib/data-source/types.ts) ─────────────────┐
  │   interface DataSource {                                     │
  │     getSchema(): WorkspaceSchema                             │
  │     executeAnalyticsEql(query): EqlResult                    │
  │     …                                                        │
  │   }                                                          │
  └─────────────┬───────────────────────────┬───────────────────┘
                │                           │
   live-bloomreach                  live-synthetic
                ▼                           ▼
  ┌─ BloomreachDataSource ─┐   ┌─ SyntheticDataSource ──────────┐
  │ lib/data-source/        │   │ lib/data-source/                │
  │  bloomreach-data-source │   │  synthetic-data-source.ts       │
  │  → MCP JSON-RPC over    │   │  → in-process deterministic     │
  │    HTTP to alpha server │   │    ecommerce data (516 LOC)     │
  │  OAuth + rate limits    │   │  no auth · no network · runs    │
  │                         │   │  anywhere with ANTHROPIC_API_KEY│
  └─────────────────────────┘   └─────────────────────────────────┘
```

The reasoning steps don't reach React after the agent finishes —
they reach React as the agent thinks them. And the agents don't
know whether they're talking to Bloomreach or to in-process
synthetic data; the DataSource seam hides it. Same agent code
serves both. Read that diagram once a day until the demo.

  ## The three sentences

You explain this in three sentences. Practice them. Don't
improvise; you'll over-explain.

  ## Sentence 1 — the adapter boundary   (6:00–6:30)

```
  ┃ "i don't own the agent loop anymore — i pulled it out into
  ┃  a published library, @aptkit/core. my five agents are thin
  ┃  wrappers that hand the loop two adapters: one to anthropic,
  ┃  one to a DataSource interface. the loop runs the
  ┃  think-tool-observe cycle; the adapters know what 'a tool'
  ┃  and 'a model' actually mean in my domain."
```

Then point at the middle of the diagram — the AptKit box on the
left, the adapter box on the right. The senior point: the loop
is reusable infrastructure; the domain plugs in through
adapters.

  ## Sentence 2 — the DataSource seam   (6:30–7:00)

```
  ┃ "the DataSource seam is what makes this demo possible. the
  ┃  agents call into a DataSource interface — they don't know
  ┃  whether it's the real Bloomreach MCP server or a 500-line
  ┃  in-process synthetic ecommerce dataset i wrote. same agent
  ┃  code path. that's how this demo runs with zero auth and
  ┃  zero upstream dependencies, while still being a real agent
  ┃  run with real model reasoning."
```

Then point at the DataSource band of the diagram. The two
implementations — `BloomreachDataSource`, `SyntheticDataSource`
— are both in `lib/data-source/`. The agents don't import
either; they import the interface. Vendor swaps don't touch
domain code.

  ## Sentence 3 — the NDJSON streaming bridge   (7:00–7:30)

This is the engineering detail that earns credibility for the
money shot specifically — it's the reason the reasoning trace
materializes line-by-line on screen instead of arriving as a
blob at the end.

```
  ┃ "the agent loop fires callbacks on every thought, tool call
  ┃  start, and tool result. the route encodes each one as one
  ┃  line of NDJSON and pushes it into a streaming response.
  ┃  the browser reads the stream line-by-line and appends each
  ┃  event to react state. that's why the trace fills in live
  ┃  instead of all at once."
```

That sentence is the difference between "I built a UI for an
agent" and "I built the live observability surface that lets a
user trust the agent." Judges who have shipped systems will
notice — and it's the load-bearing part of the money shot they
just watched.

  ## The "I built one" beat — 30 seconds left   (7:30–8:00)

You have thirty seconds left in chapter 3. Use them to deflect
to chapter 4 (the build story) — but don't burn them on dead
silence either. Show ONE thing on screen that proves the trace
they just watched is real.

```
  SHOW (on screen)                  SAY (out loud)
  ──────────────────────────        ───────────────────────────
  scroll the status log up so       "every blue line in this log
   the EQL query text from the        is a real query the model
   live trace is visible              just generated. nothing is
                                      canned."
  ──────────────────────────        ───────────────────────────
  hand-off into chapter 4           "let me tell you the part
                                      that was hard to build."
```

  ## Strong vs weak — the under-the-hood failure mode

The mistake is going one level too deep. Two levels is a
lecture; one is a credibility win. Stop at one.

```
  WEAK UNDER-THE-HOOD               STRONG UNDER-THE-HOOD
  ─────────────────────────────     ─────────────────────────────
  opens a separate slide with       points at the running app,
   five boxes and twelve arrows      draws or shows ONE diagram
                                     of the streaming pipeline
  walks through every box:
   "this is the Next.js route,      says THREE sentences:
    which uses streaming response     · the agent loop
    bodies via ReadableStream,        · the streaming bridge
    which then is consumed in the     · one load-bearing
    React component using a useRef…"    constraint (rate limit)
  ─────────────────────────────     ─────────────────────────────
  3 minutes · room is glazing       90 seconds · room is nodding
  by minute 2                       presenter has 30s buffer
  ─────────────────────────────     ─────────────────────────────
  judges' next question:            judges' next question:
   "what does it do, exactly?"       "what was hard to build?"
   (you already lost them)           (this is the question you
                                      WANT — chapter 4 answers it)
```

The strong version sets up chapter 4. The weak version makes
chapter 4 redundant because you've already burned through the
budget. Trust the diagram. Three sentences.

  ## ╔══════════════════════════════════════════════════════════╗
  ## ║ IF IT BREAKS — under the hood                             ║
  ## ║                                                            ║
  ## ║ This chapter has no live interaction — it's the diagram   ║
  ## ║ and three sentences. The only way it breaks is if a judge ║
  ## ║ interrupts mid-sentence with a deep technical question     ║
  ## ║ ("what model? what's the context window? why MCP?"). DO   ║
  ## ║ NOT answer it inside chapter 3. Say:                      ║
  ## ║                                                            ║
  ## ║   "great question — i'll cover that in q&a after the      ║
  ║    demo. for now, this is the one thing i want to show you." ║
  ## ║                                                            ║
  ## ║ Then finish the three sentences. The q&a chapter (06) has ║
  ## ║ the answers prepped: claude sonnet 4.6, MCP because        ║
  ║ bloomreach already speaks it, the agent loop comes from       ║
  ║ @aptkit/core (i own the published package), the DataSource    ║
  ║ seam in lib/data-source/types.ts is what enables live-        ║
  ║ synthetic, the legacy hand-rolled loop is preserved at        ║
  ║ lib/agents/base-legacy.ts for reference. You're ready for it  ║
  ║ — just not right now.                                         ║
  ## ╚══════════════════════════════════════════════════════════╝

  ## Tighten it — if you're running long

You have two minutes for this chapter. If you walked into it
with ninety seconds because chapter 2 ran long, here's the cut
order:

```
  cut 1   drop the "I built one" beat at 7:30
            saves 30s · costs only the bridge into chapter 4

  cut 2   drop sentence 3 (the NDJSON streaming bridge)
            saves 30s · costs the money-shot explanation. you
            keep the adapter-boundary + DataSource story, which
            is the load-bearing part for the senior selling
            point.

  cut 3   show the diagram for 5 seconds without explaining
            it, say "the short version: the loop comes from a
            library i wrote, the data source has two impls,
            this demo is one of them" and skip to ch 4.
            saves 60s · costs almost everything. only do this
            if you're at 7:30 with chapter 3 still on screen.
```

The floor: the architecture diagram and sentences 1+2 (the
adapter boundary and the DataSource seam). That's the irreducible
minimum. The streaming bridge is the third sentence; cut it
before the boundary story. The boundary IS the senior selling
point — "library owns the loop, Blooming owns the domain" is the
sentence judges with infra background care about.

  ## ────────────── RUN SHEET — chapter 3 ─────────────────────

```
  ┌───────────────────────────────────────────────────────────┐
  │ UNDER THE HOOD · 6:00–8:00 · 2 minutes                    │
  ├───────────────────────────────────────────────────────────┤
  │ 6:00   show the architecture diagram                      │
  │ 6:05   SENTENCE 1 — the adapter boundary                  │
  │         "i don't own the agent loop anymore — @aptkit/    │
  │          core does. my agents are thin wrappers with two  │
  │          adapters: anthropic and a DataSource interface." │
  │ 6:30   SENTENCE 2 — the DataSource seam                   │
  │         "the agents don't know if they're talking to      │
  │          bloomreach or to my in-process synthetic data.   │
  │          same agent code. that's why this demo runs with  │
  │          zero auth and zero upstream dependency."         │
  │ 7:00   SENTENCE 3 — the NDJSON streaming bridge           │
  │         "the loop fires callbacks · the route turns each  │
  │          into NDJSON · browser appends to react. that's   │
  │          why the trace fills in live."                    │
  │ 7:30   scroll the status log up, show real EQL text       │
  │         "every blue line is a real query the model just   │
  │          generated."                                      │
  │ 7:55   bridge: "let me tell you the part that was hard."  │
  ├───────────────────────────────────────────────────────────┤
  │ MUST NAIL   diagram + sentence 1 (the adapter boundary)   │
  │ IF BREAKS   "i'll cover that in q&a" · finish sentences   │
  │ TIGHTEN     cut "i built one" → cut sentence 3 → diagram  │
  │             alone + the boundary line                      │
  └───────────────────────────────────────────────────────────┘
```

Read chapter 4 next.
