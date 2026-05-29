# Chapter 2 — The architecture

After the pitch, the interviewer says "walk me through the system." This is the whiteboard moment. You get one diagram and about ninety seconds of talking before they start interrupting — and the interruptions are the real test. A candidate who memorized a diagram falls apart at the first "wait, what happens here?" A candidate who *understands* the system welcomes it, because every interruption is a chance to go one layer deeper on your own terms.

This chapter gives you the architecture as a diagram you can redraw from memory, the request flow walked end-to-end, and a map of exactly where interviewers interrupt — with what to say at each spot. You think visually first; lead with the picture, then walk it.

## The system at a whiteboard

This is the diagram you draw, top to bottom, narrating as you go — UI, then the route layer, then the shared agent loop, then the MCP choke-point, then state and the external providers.

```
┌─ UI LAYER (Next.js 16 App Router · React 19 · client components) ─────────────┐
│                                                                                │
│   app/page.tsx              app/investigate/[id]      …/[id]/recommend         │
│   FEED                      STEP 2 — diagnose         STEP 3 — decide          │
│   CoverageGrid              EvidencePanel             RecommendationCard        │
│   + InsightCard[]           (diagnosis + evidence)    (action + expected impact)│
│   + StatusLog (col 2) ◄──── StatusLog (col 2) ◄────── StatusLog (col 2)        │
│        │                          │                         │                   │
│        │ fetch /api/briefing      │ fetch /api/agent?step=diagnose             │
│        │                          │     then …?step=recommend                  │
└────────│──────────────────────────│────────────────────────────────────────────┘
         │                          │   NDJSON over ReadableStream
         ▼                          ▼   (fetch + reader loop, NOT EventSource)
┌─ ROUTE LAYER (Vercel route handlers · maxDuration = 300) ─────────────────────┐
│                                                                                │
│   /api/briefing                          /api/agent  (step=diagnose|recommend) │
│   1 bootstrap schema                      cache-replay (demo) ── filterByStep  │
│   2 coverage gate ── categories.ts         │                                   │
│   3 monitoring scan ─┐                      └─ live: diagnostic → recommendation│
│   4 stream insights  │                          save investigation             │
│        │             │                              │                          │
│        ▼             ▼                              ▼                          │
│   ┌────────────────────────────────────────────────────────────────────┐     │
│   │ lib/agents/base.ts  runAgentLoop                                     │     │
│   │   one shared Claude tool-use loop · maxToolCalls budget · forced     │     │
│   │   final synthesis turn                                               │     │
│   │   ▲ monitoring   ▲ diagnostic   ▲ recommendation   ▲ query           │     │
│   │   each = prompt + tool subset + output validator                     │     │
│   └──────────────┬───────────────────────────────┬───────────────────────┘     │
│        Anthropic SDK (claude-sonnet-4-6)          │ McpClient.callTool          │
│                  │                                ▼                             │
│                  │     ┌─ lib/mcp/client.ts  McpClient ──────────────────────┐  │
│                  │     │ 60s TTL cache · ~1.1s spacing · bounded backoff      │  │
│                  │     │ retry · NO-cache-on-error · {result,durationMs,...}  │  │
│                  │     │ OAuthClientProvider (PKCE + DCR)                     │  │
│                  │     │ prod auth: AES-256-GCM `bi_auth` cookie / dev: file  │  │
│                  │     └──────────────────────────┬───────────────────────────┘  │
└──────────────────│────────────────────────────────│───────────────────────────┘
       state ──────│ (NO DB)                         ▼  providers (network)
┌──────────────────▼──────────┐    ┌────────────────────────────────────────────┐
│ in-memory maps              │    │ Bloomreach loomi connect MCP                │
│ + committed demo-*.json     │    │  (~1 req/s/user · revokes tokens after mins) │
│ (lib/state/*)               │    │ Anthropic API (every agent's reasoning)      │
└─────────────────────────────┘    └────────────────────────────────────────────┘
```

The spine to memorize: **UI → route → one shared agent loop → one MCP choke-point → external providers**, with no database in the middle. If you can redraw those five bands and the two fan-outs (four agents off the loop; two providers), you can rebuild the whole thing at a whiteboard.

---

## "Walk me through what happens when the feed loads"

> ┌─────────────────────────────────────────────────────────────┐
> │ THEY ASK                                                      │
> │   "Walk me through the system — what happens on a request?"   │
> │                                                               │
> │ WHAT THEY'RE TESTING                                          │
> │   Can you trace one request end-to-end without losing the     │
> │   thread? Do you know which layer owns which job? Can you     │
> │   tell the happy path from the auth path from the demo path?  │
> └─────────────────────────────────────────────────────────────┘

In your voice, walking the diagram top to bottom:

"The feed at `app/page.tsx` fetches `/api/briefing`. Before that route commits to a stream, it does the setup that can fail — it resolves the session and connects to the MCP server. If that needs auth, it returns a 401 with a `needsAuth` flag and an authorize URL as plain JSON, so the client can redirect to OAuth rather than getting a broken half-stream. That ordering is deliberate: surface auth *before* you start streaming.

Once connected, the route bootstraps the workspace schema, then runs a coverage gate — it checks which of ten anomaly categories the workspace's events can actually support, and only runs the supported ones. Then the monitoring agent scans, using `runAgentLoop` — the one tool-use loop all four agents share. As it works, the route streams NDJSON events: each reasoning step, each tool call start and end, each insight. The feed renders the insight cards in column one and the live reasoning trace in column two.

Click a card and you go to the investigate page, which calls `/api/agent?step=diagnose`. Same loop, different agent: the diagnostic agent forms and tests hypotheses, streams its trace, and produces a diagnosis. That diagnosis is stashed in `sessionStorage`, so step three — the recommendation — hydrates instantly and runs the recommendation agent with it.

Every tool call goes through one `McpClient`. That's the choke-point: a 60-second cache, roughly one-second spacing between calls to respect Bloomreach's rate limit, and bounded retry on rate-limit errors. There's no database — state is in-memory maps, plus a committed demo snapshot for the creds-free demo path."

That's the whole system in about ninety seconds. Notice you narrated *the diagram*, band by band. You never left the picture.

```
┃ The spine is five bands: UI → route → one agent loop →
┃ one MCP choke-point → providers. No database in the middle.
```

---

## Where they'll interrupt — and what to say

Interviewers don't let you finish the clean walk. They interrupt at the load-bearing joints. Here's the map of where, and the one-liner that turns each interruption into a point in your favor.

```
You're walking the diagram...
        │
        ├─► "How does the agent loop know when to STOP?"
        │     → "Two ways: a maxToolCalls budget, and a forced
        │        final turn. When the budget's spent I stop
        │        giving the model tools, so its next turn has to
        │        be the synthesis. It can't loop forever."
        │        (base.ts — budgetSpent at L90)
        │
        ├─► "Why NDJSON over a ReadableStream and not SSE?"
        │     → "I'm already on fetch with a reader loop, and I
        │        wanted plain POST semantics and full control of
        │        the framing. NDJSON — one JSON object per line —
        │        is dead simple to parse incrementally. EventSource
        │        forces GET and its own event framing; I didn't
        │        need it." (Chapter 3 has the full version.)
        │
        ├─► "Four agents — is that four LLM clients, four loops?"
        │     → "One loop, four configurations. runAgentLoop is
        │        shared; each agent is a prompt + a tool subset +
        │        an output validator. That's why adding the query
        │        agent was cheap." (base.ts + lib/agents/*)
        │
        ├─► "No database? Where does state live?"
        │     → "In-memory maps per server instance, plus a
        │        committed JSON snapshot for demo. Deliberate for
        │        the context; the cost is per-instance cache loss
        │        on Vercel. It's my top counterfactual." (Ch 7)
        │
        └─► "What's the coverage gate doing in the request path?"
              → "It's a cheap, in-memory check that runs before
                 the expensive agent. It classifies the 10
                 categories against the live schema so the agent
                 never spends a rate-limited call on data the
                 workspace doesn't emit." (categories.ts)
```

Every one of these is a door into a chapter. The architecture chapter's job is to make sure you *recognize the door* and step through it confidently instead of freezing.

### Weak vs strong: the architecture walk

```
┌──────────────────────────────────┬──────────────────────────────────┐
│ WEAK WALK                         │ STRONG WALK                       │
├──────────────────────────────────┼──────────────────────────────────┤
│ "So there's a frontend, and it    │ "Five layers, top down: the UI    │
│  talks to the backend, which has  │  fetches a route; the route runs  │
│  the agents, and they call the    │  one shared agent loop; the loop  │
│  AI and the Bloomreach thing,     │  calls one MCP client that's the  │
│  and it streams stuff back, and   │  choke-point for caching and rate │
│  there's caching somewhere..."    │  limiting; state is in-memory, no │
│                                   │  DB. Let me trace one request..." │
├──────────────────────────────────┼──────────────────────────────────┤
│ Why it's weak:                    │ Why it works:                     │
│ "the backend," "somewhere,"       │ names the layers as a structure   │
│ "stuff" — no named layers, no     │ first, so every detail has a      │
│ ownership. The interviewer can't  │ home. Then traces ONE request     │
│ tell what owns caching or where   │ through that structure. The       │
│ auth happens. It sounds like you  │ interviewer always knows which    │
│ never drew the diagram.           │ band you're standing in.          │
└──────────────────────────────────┴──────────────────────────────────┘
```

---

╔═══════════════════════════════════════════════════════════════╗
║ WHEN YOU DON'T KNOW                                           ║
║                                                               ║
║   They push on the MCP transport: "When the connection       ║
║   drops mid-stream, how does the StreamableHTTP transport     ║
║   resume — does it replay missed messages, or reconnect       ║
║   from a cursor?"                                             ║
║                                                               ║
║   Say:                                                        ║
║   "I'm using the MCP SDK's StreamableHTTPClientTransport, so  ║
║    the wire-level reconnection is the SDK's behavior, not     ║
║    something I implemented. What I built around it is the     ║
║    recovery at *my* layer: the alpha server revokes tokens    ║
║    after a few minutes, so on an invalid-token error I reset  ║
║    auth and reconnect once, guarded so it can't loop. I       ║
║    haven't gone into the transport's internal resume          ║
║    semantics — do you want me to walk my recovery layer, or   ║
║    is the transport's the part you're after?"                 ║
║                                                               ║
║   What this signals: a clean line between what you built and  ║
║   what the SDK gives you, fluency at your own layer, and no   ║
║   bluffing about a wire protocol you didn't implement.        ║
║                                                               ║
║   Do NOT say:                                                 ║
║   "I think it... reconnects automatically and replays from    ║
║    where it left off?" — guessing at SDK internals you        ║
║   didn't read is a trap. The follow-up will expose it.        ║
╚═══════════════════════════════════════════════════════════════╝

---

## What you'd change

The architecture's cleanest seam is the shared `runAgentLoop` — four agents, one loop, was the right call and you'd keep it. What you'd reconsider is the route layer doing too much in one function: `/api/briefing` bootstraps the schema, runs the gate, drives the agent, *and* owns the NDJSON framing and the demo-replay branch all in one handler. It works and it's readable, but if this grew, you'd pull the event-streaming and the demo-replay framing into a small reusable layer so the briefing and agent routes stop duplicating the "build a ReadableStream, emit events, pace the replay" boilerplate. The architecture is sound; the route handlers are where the next refactor lives.

---

## One-page summary (night-before review)

**Core claim:** The system is five bands — UI → route → one shared agent loop → one MCP choke-point → providers — with no database in the middle, and you can redraw it from memory.

**The questions covered:**
- *"Walk me through the system."* → Trace one request top-down through the five bands; auth surfaces before the stream; the MCP client is the single choke-point.
- *"How does the loop stop?"* → `maxToolCalls` budget + a forced final synthesis turn (`base.ts` L90).
- *"Why NDJSON not SSE?"* → already on fetch+reader, wanted POST + simple line framing (full answer in Ch 3).
- *"Four agents?"* → one loop, four configs (prompt + tool subset + validator).
- *"No database?"* → in-memory + demo snapshot; deliberate; top counterfactual (Ch 7).

**Pull quotes:**
- The spine is five bands: UI → route → one agent loop → one MCP choke-point → providers. No database in the middle.
- Every interruption is a door into a chapter — recognize the door and step through it.

**What you'd change:** Keep the shared loop; pull NDJSON streaming + demo-replay framing out of the route handlers into a reusable layer so `/api/briefing` and `/api/agent` stop duplicating it.

---
Updated: 2026-05-29 — created
