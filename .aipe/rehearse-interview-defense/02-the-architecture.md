# Chapter 2 — The architecture

Sometime in the first fifteen minutes of every system-design-flavored interview, someone walks to the whiteboard and says "draw me your architecture." This chapter teaches you to draw it in under ninety seconds, with confidence, in a way that gives the interviewer something to interrupt. Because they will interrupt — and you want them interrupting at a layer you can defend, not at a layer you skipped past.

The trap most candidates fall into is drawing the architecture they wish they had, not the one they shipped. You skip past the messy parts (the rate-limit retry, the encrypted-cookie auth store, the StrictMode-safe hook) because they feel embarrassing. They are not embarrassing. They are *evidence you shipped a real thing*. Draw them.

## The architecture diagram — the one you redraw on the whiteboard

This is the whole picture. Memorize it as four bands top-to-bottom: UI, Service, Data, Provider. Every box, every arrow, every layer crossing.

```
  blooming insights — full architecture (the whiteboard target)

  ┌─ UI layer ──────────────────────────────────────────────────────────┐
  │                                                                      │
  │  app/page.tsx (feed, 461 LOC)                                        │
  │    ├─ useBriefingStream  (313 LOC) — opens /api/briefing             │
  │    ├─ useDemoCapture     (146 LOC) — dev-only capture                │
  │    └─ useReconnectPolicy (123 LOC) — token-revoke recovery           │
  │                                                                      │
  │  app/investigate/[id]/page.tsx              ← step 2 (diagnose)      │
  │  app/investigate/[id]/recommend/page.tsx    ← step 3 (recommend)     │
  │    └─ lib/hooks/useInvestigation.ts ─ runs one step, stashes result  │
  │                                                                      │
  │  components/shared/StatusLog → ReasoningTrace → ToolCallBlock        │
  │  (the streamed agent trace; same component on every page)            │
  │                                                                      │
  └────────────┬────────────────────────────────────────────┬────────────┘
               │ NDJSON over fetch                          │
               │ (consumed by readNdjson @                  │
               │  lib/streaming/ndjson.ts, 64 LOC,          │
               │  shared by 4 streaming surfaces)           │
  ┌─ Service ──▼────────────────────────────────────────────▼────────────┐
  │                                                                      │
  │  /api/briefing  (monitoring scan → insights[])                       │
  │  /api/agent     (step=diagnose|recommend|null)                       │
  │  /api/mcp/*     (callback, reset, call, tools, capture)              │
  │      maxDuration = 300s (Vercel Pro)                                 │
  │      writes NDJSON via ReadableStream                                │
  │                                                                      │
  │       ┌──────────────────────────────────────────────────┐           │
  │       │  agents (thin wrappers over @aptkit/core@0.3.0)  │           │
  │       │   monitoring · diagnostic · recommendation       │           │
  │       │   query · intent                                 │           │
  │       └──────────────────────┬───────────────────────────┘           │
  │                              │ runs the loop via                     │
  │                              ▼                                       │
  │       ┌──────────────────────────────────────────────────┐           │
  │       │  lib/agents/aptkit-adapters.ts (206 LOC)         │           │
  │       │   3 Blooming-owned adapter classes:              │           │
  │       │    · AnthropicModelProviderAdapter               │           │
  │       │    · BloomingToolRegistryAdapter                 │           │
  │       │    · BloomingTraceSinkAdapter                    │           │
  │       │   ↑ THIS IS THE SEAM I OWN                       │           │
  │       └──────────┬───────────────────────────────────────┘           │
  │                  │                                                   │
  └──────────────────┼───────────────────────────────────────────────────┘
                     │
  ┌─ Data layer ─────▼───────────────────────────────────────────────────┐
  │                                                                      │
  │  lib/data-source/types.ts  — DataSource interface                    │
  │    makeDataSource(mode, sessionId) returns one of:                   │
  │      ├─ BloomreachDataSource (HTTPS + OAuth + ~1.1s spacing + retry) │
  │      └─ SyntheticDataSource  (516 LOC in-process, deterministic)     │
  │                                                                      │
  │  lib/state/insights.ts — Map<sessionId, SessionFeed>                 │
  │    (session-keyed; concurrent-user wipe bug RESOLVED)                │
  │                                                                      │
  │  lib/mcp/client.ts — 17-line backwards-compat shim                   │
  │  lib/mcp/auth.ts — AES-256-GCM encrypted cookie (prod) / file (dev)  │
  │                                                                      │
  └─────────────────────┬───────────────────────────────────────┬────────┘
                        │                                       │
  ┌─ Provider layer ────▼───────────────────────────────────────▼────────┐
  │  Anthropic API                       Bloomreach loomi connect MCP    │
  │   · claude-sonnet-4-6 (agents)        (alpha — rate-limited,         │
  │   · claude-haiku-4-5 (intent)          revokes tokens after minutes) │
  └──────────────────────────────────────────────────────────────────────┘

  bi:mode = 'demo' | 'live-bloomreach' | 'live-synthetic'  (default demo)
```

Three things to point at while you draw it — these are the moves that turn the picture from a feature list into an architecture: **the agent boundary** in the Service layer (AptKit owns the loop, you own three adapters), **the data-source seam** between Service and Data (one interface, two adapters), and **the streaming kernel** crossing UI and Service (one `readNdjson`, four surfaces). Walk each one as you draw.

## How you draw it under time pressure

You can't draw the whole picture above on a real whiteboard. You draw a compressed version, then expand exactly the band the interviewer asks about. Practice this order:

```
  Whiteboard draw order — under 90 seconds

  1.  Four boxes top to bottom, labeled bands:
        UI / Service / Data / Provider                    (10s)
  2.  Inside Service: the agent box                       (10s)
  3.  Inside UI: page.tsx + StatusLog                     (10s)
  4.  The arrow from UI to Service, labeled "NDJSON"      (5s)
  5.  Inside Data: the DataSource interface + 2 adapters  (15s)
  6.  Provider: Anthropic + Bloomreach MCP                (10s)
  7.  Mark the seam: aptkit-adapters.ts                   (10s)
  8.  Stop. Ask: "where would you like me to go deeper?"  (5s)
```

Total: ~75 seconds. The "stop and ask" at the end is doing real work — it cedes the floor to the interviewer in a way that makes you look senior, not nervous. Don't keep drawing.

## The end-to-end request flow — `/api/briefing`

The single most likely follow-up is "okay, now walk me through what happens when a user hits the feed page." This is a hops-and-bands walk. Memorize the eight hops.

```
  Request flow — feed page load with bi:mode = 'live-bloomreach'

  ┌─ Browser ────┐  hop 1: GET /                ┌─ Vercel edge ──┐
  │  app/page.tsx│ ───────────────────────────► │  Next.js SSR   │
  │  mounts      │                              │  (RSC)         │
  └──────────────┘                              └────────┬───────┘
                                                          │
                                                  hop 2   │ HTML shell
                                                          ▼
  ┌─ Browser ────────────────────────────────────────────────────┐
  │  useBriefingStream effect fires after hydration              │
  │  fetch('/api/briefing', { headers: { 'x-bi-mode': ... } })   │
  └────────────────────────┬─────────────────────────────────────┘
                hop 3 POST │ + cookie (encrypted OAuth state)
                           ▼
  ┌─ Service: /api/briefing route handler ───────────────────────┐
  │   1. setup: read cookie → aesKey() → OAuth provider          │
  │      (wrapped in try/catch returning real error JSON —       │
  │       see Chapter 6, hard bug 2 for the bare-500 fix)        │
  │   2. makeDataSource('live-bloomreach', sessionId)            │
  │   3. monitoringAgent.run(dataSource, traceSink)              │
  │   4. return new ReadableStream piping NDJSON events          │
  └────────────────────────┬─────────────────────────────────────┘
                hop 4 loop │  (one iteration per agent step)
                           ▼
  ┌─ aptkit-adapters.ts (the boundary) ──────────────────────────┐
  │  AptKit's loop drives:                                        │
  │    · AnthropicModelProviderAdapter.complete()                 │
  │      → POST api.anthropic.com (Sonnet 4.6)                    │
  │    · BloomingToolRegistryAdapter.execute(toolCall)            │
  │      → dataSource.executeEql(...)                             │
  │    · BloomingTraceSinkAdapter.write(event)                    │
  │      → writes NDJSON line back to UI                          │
  └──────┬─────────────────────────────────────────┬─────────────┘
   hop 5 │ token + tools                     hop 6 │ EQL
         ▼                                         ▼
  ┌─ Anthropic ────────┐                 ┌─ Bloomreach MCP ──┐
  │  Sonnet 4.6        │                 │  rate-limited     │
  │  returns:          │                 │  ~1.1s spacing    │
  │   reasoning step   │                 │  retries on 429   │
  │   tool_use blocks  │                 │  may revoke token │
  └────────────────────┘                 └────────┬──────────┘
                                                  │ hop 7
                                          tool result
                                                  ▼
  ┌─ aptkit-adapters.ts ─────────────────────────────────────────┐
  │  Loop continues until max-iterations or final synthesis      │
  │  Each step emits an AgentEvent (NDJSON) back to the browser  │
  └────────────────────────┬─────────────────────────────────────┘
                           │
                hop 8 NDJSON│ (one line per event)
                           ▼
  ┌─ Browser ────────────────────────────────────────────────────┐
  │  readNdjson(reader) yields events; useBriefingStream          │
  │  routes them: reasoning_step → StatusLog,                     │
  │  insight → InsightCard, error → ReconnectPolicy               │
  └──────────────────────────────────────────────────────────────┘
```

That's the whole flow. Walk it in that order if asked: hop labels, layer crossings, what each band promises the next. The two bits an interviewer is most likely to probe are **hop 5** (why a forced final synthesis turn? — Chapter 3) and **hop 6** (how do you handle the rate limit? — Chapter 5).

```
  ┃ "Every hop crosses a band, and every band crossing is
  ┃  a contract I can defend on its own."
```

## The big question — "walk me through your architecture"

```
  ┌─────────────────────────────────────────────────┐
  │ THEY ASK                                        │
  │   "Walk me through your architecture."          │
  │                                                 │
  │ WHAT THEY'RE TESTING                            │
  │   Can you talk about a system at the level of   │
  │   bands and seams, not files and features? Do   │
  │   you know where the load is actually carried?  │
  │   Will you draw the messy parts honestly or     │
  │   try to make it look cleaner than it is?       │
  └─────────────────────────────────────────────────┘
```

The strong answer, in your voice, designed to fit the whiteboard draw above:

> "Four bands top-to-bottom — **UI, Service, Data, Provider**. The UI is Next.js 16 App Router; the main page is `app/page.tsx` and it uses three custom hooks that I pulled out of it deliberately — `useBriefingStream` for the live agent feed, `useDemoCapture` for the dev-only snapshot capture, `useReconnectPolicy` for the token-revoke recovery. The page talks to the Service layer over **NDJSON over fetch** — not SSE, not a websocket — because it's append-only and a single reader and that's the simplest contract I could ship.
>
> "In the Service layer, the route handlers are thin. The agents themselves are also thin — they're wrappers over `@aptkit/core@0.3.0`. The interesting part is right here" — *point at* `lib/agents/aptkit-adapters.ts` — "this is the boundary I own. Three small adapter classes — model provider, tool registry, trace sink. AptKit owns the agent loop; I own the boundary. It's about two hundred lines and the legacy hand-rolled loop is still preserved at `base-legacy.ts` as my rollback receipt.
>
> "Below that is the **DataSource seam** — `lib/data-source/types.ts`. One interface, two adapters: `BloomreachDataSource` talks HTTPS over OAuth PKCE with about 1.1-second call spacing because the alpha server is rate-limited; `SyntheticDataSource` is in-process and deterministic, about 500 lines, so I can run the system end-to-end without touching Bloomreach at all. The seam has survived two adapter swaps without changing the caller surface — that's the receipt for it being a real seam, not future-proofing.
>
> "Providers are Anthropic — Sonnet 4.6 for agents, Haiku for the intent classifier — and the Bloomreach loomi connect MCP server over OAuth. Where would you like me to go deeper?"

Notice the structure: bands, then the load-bearing detail in each band, then the hand-off. The hand-off is the whole point. You've named three things they could pull on (the AptKit boundary, the DataSource seam, the agent loop), and they'll pick one.

```
  ┌─────────────────────────┬─────────────────────────┐
  │ WEAK ARCHITECTURE WALK  │ STRONG ARCHITECTURE WALK│
  ├─────────────────────────┼─────────────────────────┤
  │ "So the frontend is     │ "Four bands top-to-     │
  │ Next.js. It calls an    │ bottom: UI, Service,    │
  │ API route. The API      │ Data, Provider. The     │
  │ route calls Claude.     │ UI talks to the Service │
  │ Claude calls tools.     │ over NDJSON over fetch  │
  │ The tools call          │ — append-only, single   │
  │ Bloomreach over MCP.    │ reader, simplest        │
  │ Then it streams the     │ contract I could ship.  │
  │ result back."           │ The interesting piece   │
  │                         │ is the adapter boundary │
  │                         │ between my code and the │
  │                         │ AptKit agent runtime..."│
  ├─────────────────────────┼─────────────────────────┤
  │ Why it's weak:          │ Why it works:           │
  │ A chain of calls is not │ Bands and seams, then   │
  │ an architecture. There's│ a load-bearing detail   │
  │ no band, no seam, no    │ in each band. The       │
  │ contract. The reader    │ "interesting piece" is  │
  │ can't tell what's a     │ named explicitly. The   │
  │ load-bearing decision   │ choice of contract      │
  │ from what's a default.  │ (NDJSON) is justified.  │
  └─────────────────────────┴─────────────────────────┘
```

## Where they'll interrupt and what to say

Walk the decision tree before the interview so you're not caught flat-footed.

```
  You finish the band walk and ask "where would you like me to go deeper?"
        │
        ▼
        │
        ├─► "Tell me about the agent layer"
        │     → Chapter 3, Choice 2 (AptKit migration).
        │       Lead with "I started by owning the loop;
        │       migrated to AptKit once its primitives
        │       were clean enough." Show base-legacy.ts.
        │
        ├─► "How does the streaming work?"
        │     → Walk readNdjson at lib/streaming/ndjson.ts.
        │       64 lines. Used by 4 surfaces. Then walk
        │       the StatusLog → ReasoningTrace render path.
        │
        ├─► "Walk me through one request end-to-end"
        │     → The 8-hop flow above. Slow down at hops 5
        │       and 6 (agent loop + rate-limited tool).
        │
        ├─► "Why no database?"
        │     → Chapter 3, Choice 1 (no DB) and Chapter 7,
        │       Reconsideration 1. Honest answer: deliberate
        │       for the context, with a real bug (concurrent-
        │       user wipe) that's now resolved.
        │
        └─► "How do you handle auth?"
              → Chapter 8 (the AI question — OAuth PKCE +
                DCR is the canonical defaulted-to). Honest:
                the MCP SDK provides the mechanics; I own
                the encrypted-cookie store wrapper.
```

## When you don't know

The territory you're most likely to get pushed past your depth in this chapter is *scale*. Architecture diagrams invite "how would this handle X RPS?" questions. The honest answer is that you've designed for the constraint that exists (a rate-limited upstream), not the constraint that doesn't (production load).

```
  ╔═══════════════════════════════════════════════╗
  ║ WHEN YOU DON'T KNOW                           ║
  ║                                               ║
  ║   They ask: "How does this architecture       ║
  ║   handle 1000 requests per second?"           ║
  ║                                               ║
  ║   You haven't load-tested it and you          ║
  ║   shouldn't pretend you have. The real        ║
  ║   constraint is upstream, not your code.      ║
  ║                                               ║
  ║   Say:                                        ║
  ║   "I haven't load-tested at that throughput.  ║
  ║    The binding constraint in this system      ║
  ║    isn't my service — it's the upstream       ║
  ║    Bloomreach API, which is rate-limited to   ║
  ║    roughly one request per second and revokes ║
  ║    tokens after minutes. So at 1000 RPS what  ║
  ║    breaks first is the upstream, not me. The  ║
  ║    interesting design question becomes how to ║
  ║    fan out without hammering — caching, queue,║
  ║    one upstream connection per workspace. I'd ║
  ║    love to walk through the design if you'd   ║
  ║    like."                                     ║
  ║                                               ║
  ║   What this signals: you know the binding     ║
  ║   constraint, you don't fake a load number,   ║
  ║   and you re-frame the question to a design   ║
  ║   conversation you can actually have.         ║
  ║                                               ║
  ║   Do NOT say:                                 ║
  ║   "Vercel auto-scales so it should handle     ║
  ║    it." Cargo-culted infra confidence. The    ║
  ║    interviewer will probe and you'll fold.    ║
  ╚═══════════════════════════════════════════════╝
```

## What you'd change in the architecture

The one thing you'd reconsider in the architecture today is **cross-instance state**. `lib/state/insights.ts` is now session-keyed (`Map<sessionId, SessionFeed>`), which fixed the concurrent-user wipe bug that AI had defaulted me into. But it's still in-process. If a single warm Vercel instance handles both reads, you're fine; if traffic lands on two different instances, the second instance has no insights for the same session. The trigger for changing this is multi-instance deployment, which a portfolio app doesn't have. The fix is straightforward — Vercel KV or a small Postgres — and the seam is already there. I'd add it the day I had two instances.

## One-page summary

**Core claim:** Talk about architecture in bands and seams, not files and features. Draw the messy parts honestly. Hand the interviewer a thread at the end.

**Questions covered:**
- "Walk me through your architecture." → Four bands top-to-bottom; load-bearing detail per band; end with "where would you like me to go deeper?"
- "Walk me through one request end-to-end." → The eight-hop flow; slow down at the agent-loop hop and the rate-limited tool hop.
- "How would this handle 1000 RPS?" → Honest "I haven't load-tested at that throughput"; the binding constraint is upstream rate-limit, not my service; re-frame to design.

**Pull quotes:**
```
  ┃ "Every hop crosses a band, and every band crossing
  ┃  is a contract I can defend on its own."
```

**What you'd change:** the in-process insights store will need cross-instance state the day there's a second Vercel instance. The seam is ready; the trigger isn't here yet.
