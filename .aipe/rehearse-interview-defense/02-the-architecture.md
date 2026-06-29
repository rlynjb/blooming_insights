# Chapter 2 — The architecture

  ## Opening hook

You delivered the pitch. The interviewer leans in and says "okay, walk me through how it actually works." You have about ninety seconds and one whiteboard. This chapter is about being able to draw the architecture from memory, in order, without backtracking — and surviving the inevitable interruption at minute one without losing the thread.

The architecture is layered enough that you can lose yourself in any layer if you start there. The discipline you're practicing is *top-down with no dive*. You draw the four bands, name the role of each, and only then walk a single request through them end-to-end. You do not stop to explain the agent loop's internals before the user has even fetched anything. The interviewer will *ask* you to dive — that's the next question, not the first one.

  ## The picture you draw — the layered architecture

This is the whiteboard, drawn in the order you'd draw it. Top to bottom: the user, the service, the agent loop, the data source. Every arrow is labeled with what travels and in which direction. Memorize the *order you draw the boxes* — that's the muscle memory you want under pressure.

```
  blooming insights — the architecture, four bands

  ┌─ UI band ─────────────────────────────────────────────────────┐
  │  app/page.tsx (feed) · /investigate/[id] · /recommend         │
  │  3 hooks: useBriefingStream · useInvestigation · useDemoCapture│
  │  one shared NDJSON kernel: lib/streaming/ndjson.ts readNdjson  │
  └────────┬──────────────────────────────────────────────────────┘
           │ fetch(POST) → ReadableStream of NDJSON
           │ event types: insight · diagnosis · recommendation ·
           │   tool_call_start · tool_call_end · reasoning_step ·
           │   coverage_item · done · error
           ▼
  ┌─ Service band (Next 16, App Router on Vercel) ────────────────┐
  │  /api/briefing  →  monitoring + categories agents              │
  │  /api/agent     →  diagnostic | recommendation | query agents  │
  │  /api/mcp/{callback,reset,call,tools,…}                        │
  │  bootstraps the DataSource INSIDE the stream                   │
  │  Vercel Pro · maxDuration = 300                                │
  └────────┬──────────────────────────────────────────────────────┘
           │ runs an agent (constructs the loop, hands it a
           │   DataSource, streams events back to the response)
           ▼
  ┌─ Agent loop band (library: @aptkit/core@0.3.0) ───────────────┐
  │  iterate: model → tool_use blocks → tool_results → repeat      │
  │  3 adapters bridge Blooming to the library (206 LOC total):    │
  │    AnthropicModelProviderAdapter (Sonnet 4.6, Haiku for intent)│
  │    BloomingToolRegistryAdapter (wraps the DataSource seam)     │
  │    BloomingTraceSinkAdapter (translates aptkit events to       │
  │      Blooming's AgentEvent shape for the stream)               │
  │  legacy hand-rolled loop preserved at base-legacy.ts:86-176    │
  └────────┬──────────────────────────────────────────────────────┘
           │ callTool(name, args) — DataSource.callTool returns
           │   { result, durationMs, fromCache }
           ▼
  ┌─ DataSource band (lib/data-source/types.ts) ──────────────────┐
  │  BloomreachDataSource — HTTPS to loomi connect MCP, OAuth      │
  │    (PKCE + DCR), encrypted cookie, ~1 req/s rate limit + retry │
  │  SyntheticDataSource — 516 LOC, in-process EQL substrate,      │
  │    no network, used by `live-synthetic` mode                   │
  └───────────────────────────────────────────────────────────────┘
```

Four bands. UI consumes a single streaming contract. Service handles one HTTP request and runs the agent loop inside it. Loop lives in a library; this app owns the boundary. Data source is a swap seam — two adapters today, same caller surface.

  ## The body — the walk-through and where they interrupt

  ### The 90-second walkthrough

This is the script you walk a request through. Read it aloud once. Time it. You're aiming for ninety seconds.

```
  ┌─────────────────────────────────────────────────────────────┐
  │ THEY ASK                                                    │
  │   "Walk me through how the system works, end-to-end."       │
  │                                                             │
  │ WHAT THEY'RE TESTING                                        │
  │   Do you have a mental model of your own system? Can you    │
  │   tell the story top-down without rabbit-holing into one    │
  │   layer? Do you know where the seams are? Can you stay      │
  │   inside ninety seconds?                                    │
  └─────────────────────────────────────────────────────────────┘
```

**Strong answer (the walk-through):**

> "Let me draw the four bands. UI, service, agent loop, data source. *(draw boxes top to bottom)*
>
> User loads the feed at `app/page.tsx`. The default mode is `'demo'` — it serves a committed snapshot as plain JSON, instantly, no auth, no agents. That's my reliable presentation path. The user can toggle into `'live-bloomreach'` to run the agents for real, or `'live-synthetic'` to run them against my in-process substrate.
>
> When they click run live, the UI hook — `useBriefingStream` — does a `fetch(POST)` to `/api/briefing`. That route handler bootstraps the DataSource *inside the stream*, so any setup error becomes a real error event the UI can render, not a bare 500.
>
> The handler then runs the monitoring agent. The agent loop itself is the library `@aptkit/core` — I own three adapter classes that bridge Blooming to its primitives. The library iterates: model produces tool_use blocks, the registry executes them, the trace sink emits events. Those events get translated to my NDJSON event contract and streamed back through the same response.
>
> The actual data calls go through the DataSource seam. In live-Bloomreach mode that's an OAuth'd HTTPS client to the loomi connect MCP server, rate-limited to roughly one request per second. In live-synthetic mode it's a 516-LOC in-process substrate that satisfies the same caller surface.
>
> The user sees, in real time: tool calls firing, intermediate reasoning steps, and finally the insight cards rendering as each anomaly is found. Then they click into one — that's `/investigate/[id]`. Same shape: hook fetches, route runs the diagnostic agent, NDJSON streams back through the same kernel.
>
> Same architecture every time. UI fetches NDJSON. Route runs an agent. Agent calls tools through the seam."

That's the walkthrough. Four bands. One request. Same shape every time.

  ### The interruptions you should expect

The interviewer rarely lets you finish the full ninety. They interrupt at the layer they want to dig into. Know the branches.

```
  Where the interviewer interrupts the walkthrough
        │
        ▼
  You're mid-walkthrough.
        │
        ├─► AT THE UI BAND ("how does the streaming actually work?")
        │     One kernel: lib/streaming/ndjson.ts readNdjson.
        │     fetch returns a ReadableStream, we read the body,
        │     split on newlines, JSON.parse each line, dispatch
        │     by event.type. Same kernel for 4 surfaces.
        │
        ├─► AT THE SERVICE BAND ("why bootstrap inside the stream?")
        │     The setup phase — token decryption, MCP client init,
        │     listTools — used to throw before any response had
        │     started, which surfaced as a bare 500 in the UI. By
        │     pushing setup inside the stream, errors become a real
        │     error event with a real message. Production-only 500
        │     was how I found this bug — see chapter 6.
        │
        ├─► AT THE AGENT LOOP ("why a library and not your own loop?")
        │     I had my own loop first — base-legacy.ts:86-176, still
        │     in the repo. I migrated to @aptkit/core@0.3.0 once it
        │     exposed primitives I could adapt to. Library owns the
        │     loop; I own the boundary. Three adapter classes,
        │     ~200 LOC. Legacy preserved as a rollback receipt.
        │
        └─► AT THE DATA SOURCE ("two adapters? why?")
              The seam survives. I built against Bloomreach, then
              built a synthetic adapter for development without
              network, then a third (SQL-backed) adapter lived
              behind it briefly. Two adapter swaps, zero caller-
              surface change. That's the receipt for the seam.
```

  ### Why bootstrap inside the stream — the seam they'll probe

This is the architecture choice senior interviewers reliably stop on, because it sounds backwards. Bootstrapping the data source *inside* the route response stream means more code inside the streaming path. Why?

```
  ┌─────────────────────────────────────────────────────────────┐
  │ THEY ASK                                                    │
  │   "Why bootstrap the MCP connection inside the streaming    │
  │    response instead of in route middleware?"                │
  │                                                             │
  │ WHAT THEY'RE TESTING                                        │
  │   Do you understand the cost of setup-phase failures in     │
  │   a streaming app? Do you treat the user-visible error as   │
  │   a first-class output? Or do you let exceptions become     │
  │   500s that the UI can't render?                            │
  └─────────────────────────────────────────────────────────────┘
```

**Strong answer:**

> "Setup-phase failures used to throw before the response had started. The client would see a bare 500 with no body. There's a specific case where this bit me: in production, `aesKey()` in `lib/mcp/auth.ts` would throw if `AUTH_SECRET` was unset — pre-stream, unguarded. The UI saw a 500 and could only say 'something went wrong.' Demo mode worked fine, which made the bug invisible until I tried live in prod.
>
> The fix was to wrap setup in try/catch *inside* the stream, so any setup error becomes a real NDJSON error event with a real message — the UI renders the actual problem and offers a reconnect button on auth errors. Now the streaming contract is the *only* output surface; every failure rides through it."

```
  ┃ "The streaming contract is the only output surface.
  ┃  Every failure rides through it."
```

  ### Why a library agent loop and not the one you built

This is the second seam they'll probe. You hand-rolled the loop first; you migrated to a library. Both decisions need defending.

```
  ┌─────────────────────────────────────────────────────────────┐
  │ THEY ASK                                                    │
  │   "Why migrate to a library agent loop after building       │
  │    your own?"                                               │
  │                                                             │
  │ WHAT THEY'RE TESTING                                        │
  │   Do you know when to own infrastructure and when to        │
  │   adopt it? Can you defend revisiting a decision you        │
  │   previously made the other way? Do you keep a rollback     │
  │   path?                                                     │
  └─────────────────────────────────────────────────────────────┘
```

**Strong answer:**

> "I hand-rolled the loop in Phase 1. That was deliberate — I needed two things the library didn't yet expose: a hard `maxToolCalls` budget so I could bound rate-limit exposure on the alpha Bloomreach server, and a forced final-synthesis turn so the model would always produce a structured answer instead of looping forever. The hand-rolled loop is still in the repo at `lib/agents/base-legacy.ts:86-176`.
>
> In Phase 4, `@aptkit/core` reached version 0.3.0 with the generic-primitive surface I needed. I migrated. The Blooming side is three adapter classes in `lib/agents/aptkit-adapters.ts`, around two hundred lines total: an `AnthropicModelProviderAdapter` for the model, a `BloomingToolRegistryAdapter` that wraps my DataSource seam, and a `BloomingTraceSinkAdapter` that translates aptkit events into my UI's event contract.
>
> I own the boundary; AptKit owns the loop. Three small adapter classes, around two hundred lines, and the legacy loop is preserved for the day I need to peel back to it."

```
  ┃ "I own the boundary; AptKit owns the loop. Three small
  ┃  adapter classes, ~200 LOC, and the legacy loop is preserved
  ┃  for the day I need to peel back to it."
```

  ## When you don't know

The interviewer can push you into Next.js runtime internals or Vercel's streaming behavior — territory you didn't deeply design for; you used the defaults.

```
  ╔═══════════════════════════════════════════════════════════════╗
  ║ WHEN YOU DON'T KNOW                                           ║
  ║                                                               ║
  ║   They ask: "What's the connection model for your Vercel      ║
  ║   functions handling streaming responses? Are they keeping    ║
  ║   sockets open? How does that interact with cold starts?"     ║
  ║                                                               ║
  ║   You picked the Node runtime, set maxDuration to 300, and    ║
  ║   the streaming worked. You did not deeply design the         ║
  ║   socket / cold-start behavior.                               ║
  ║                                                               ║
  ║   Say:                                                        ║
  ║   "I configured maxDuration at 300 for the long-running       ║
  ║    streaming routes and used Vercel's default Node runtime.   ║
  ║    The socket lifecycle and cold-start tradeoffs underneath   ║
  ║    — I didn't deeply design for those. What I designed for    ║
  ║    was the user-visible side: every failure becoming an       ║
  ║    NDJSON error event so the UI has something to render.      ║
  ║    The platform side I trusted Vercel on. If we needed to     ║
  ║    scale connections, that's where I'd want to dig in."       ║
  ║                                                               ║
  ║   What this signals: honesty about the boundary between       ║
  ║   what you owned and what you defaulted to, plus a sharp      ║
  ║   handoff to what you DID design for. Senior interviewers     ║
  ║   read this as confidence about scope.                        ║
  ║                                                               ║
  ║   Do NOT say:                                                 ║
  ║   "Yeah, Vercel handles all that with their edge / lambda     ║
  ║    hybrid…" — vague handwaving about a platform you didn't    ║
  ║   read deeply is the surest way to get pushed further into    ║
  ║   the territory you don't know.                               ║
  ╚═══════════════════════════════════════════════════════════════╝
```

  ## What you'd change

If you were redoing the architecture today, the one structural change you'd reach for first is **giving the agent loop a real cancellation primitive across the whole request path** — not just the in-loop `AbortSignal` you have today. Cancellation works on the model SDK call; it doesn't cleanly propagate through the streaming response to the in-flight tool call, which can mean a wasted Bloomreach hit after the user has already navigated away. The fix is one extra layer of `AbortController` plumbing from the route through the adapter into the DataSource. You know what to do; you haven't done it.

  ## One-page summary

**Core claim:** four bands, drawn top-down, walked once. UI consumes NDJSON; service runs an agent; loop is a library; data is a seam. The walkthrough is ninety seconds. Every interruption corresponds to a layer.

**Questions covered:**
- *"Walk me through the system"* → four bands, one request, end-to-end in ninety seconds.
- *"Why bootstrap inside the stream?"* → setup failures become NDJSON error events instead of bare 500s; specific bug: prod-only `aesKey()` throw.
- *"Why a library agent loop?"* → I hand-rolled it first (deliberate), migrated when `@aptkit/core@0.3.0` exposed the primitives. Three adapters at `aptkit-adapters.ts`. Legacy preserved at `base-legacy.ts:86-176`.
- *"Vercel runtime details?"* → I designed the user-visible side; platform internals I trusted defaults on.

**Pull quotes:**
```
┃ "The streaming contract is the only output surface.
┃  Every failure rides through it."
```
```
┃ "I own the boundary; AptKit owns the loop. Three small
┃  adapter classes, ~200 LOC, and the legacy loop is preserved
┃  for the day I need to peel back to it."
```

**What you'd change:** plumb a proper `AbortController` chain from route → adapter → DataSource, so a cancelled request kills the in-flight Bloomreach call instead of wasting rate-limit budget on a navigation the user already moved past.
