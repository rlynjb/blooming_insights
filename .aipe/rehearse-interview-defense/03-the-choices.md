# Chapter 3 — The choices

This is where interviews get real. "Why this and not that?" is the question that separates someone who *made* decisions from someone who accepted defaults and can't tell the difference. The trap isn't having made a "wrong" choice — there are no wrong choices if you can name the criterion and the cost. The trap is the answer "it's good for this kind of thing," which tells the interviewer you don't remember why you picked it.

This chapter defends every load-bearing choice in blooming insights — the framework, the agent-loop-over-a-framework call, the model split, the streaming transport, and the no-database decision. The trivial ones (Tailwind, Vitest) don't earn a section; nobody senior probes them. For each real choice you get the criterion, the alternative, and the cost you're paying — because naming the cost is what makes the defense land.

## The choices, with the picked option highlighted

Hold the whole decision set as one tree before defending any single branch — the highlighted path is what shipped.

```
  DECISION                  ALTERNATIVES                  PICKED ▶ / cost
  ════════════════════════════════════════════════════════════════════════

  framework            ┌─ plain React SPA + API
                       ├─ Remix / SvelteKit
                       └─ ▶ Next.js 16 App Router   ── route handlers +
                                                       streaming + Vercel,
                                                       cost: Vercel coupling

  agent orchestration  ┌─ LangChain / agent framework
                       └─ ▶ own runAgentLoop on the   ── control + testable
                            MCP SDK                      with fakes,
                                                         cost: you write the loop

  model                ┌─ one model for everything
                       ├─ OpenAI GPT-4 class
                       └─ ▶ sonnet-4-6 (agents)      ── tool-use quality +
                            + haiku-4-5 (intent)        cheap classification,
                                                         cost: Anthropic lock-in

  streaming transport  ┌─ SSE / EventSource
                       ├─ WebSocket
                       ├─ poll
                       └─ ▶ NDJSON over a            ── POST + simple line
                            ReadableStream (fetch)      framing + one wire
                                                         format, cost: no
                                                         auto-reconnect

  state / storage      ┌─ Postgres / SQLite
                       ├─ Redis
                       └─ ▶ in-memory maps +         ── zero infra, creds-free
                            committed demo snapshot     demo path, cost:
                                                         per-instance cache loss
```

Five branches, five highlighted picks, five costs. Walk them one at a time.

---

## Choice 1 — Next.js 16 App Router

> ┌─────────────────────────────────────────────────────────────┐
> │ THEY ASK                                                      │
> │   "Why Next.js? Why not a plain React SPA with a separate     │
> │    API?"                                                      │
> │                                                               │
> │ WHAT THEY'RE TESTING                                          │
> │   Did you pick the framework for a reason tied to THIS app,   │
> │   or because it's what you'd use by default? Do you know what │
> │   it actually buys you here?                                  │
> └─────────────────────────────────────────────────────────────┘

In your voice:

"The load-bearing feature is streaming from a route handler. This app's whole identity is watching the agent reason in real time, so I needed first-class server-side streaming co-located with the UI. Next.js 16 route handlers let me return a `ReadableStream` of NDJSON directly, and the App Router puts the page and its data route in the same project with shared types. I'm a React engineer, so the component layer was home ground — the new surface I was learning was the agent and MCP layer, and Next let me keep the frontend boring so I could spend my attention there. The cost I'm paying is coupling to Vercel's serverless model: `maxDuration` caps a request at 300 seconds, and there's no long-lived process to hold state, which is why state is in-memory and per-instance."

That last sentence matters — you connected the framework choice to the state choice. Senior answers show the decisions are *linked*, not a pile of independent picks.

There's a second-order honesty here worth pre-loading, because a sharp interviewer will pull on it: I use Next.js 16 + React 19 as a *runtime*, not for its data primitives. Every routed page is `'use client'`; there are no Server Components in the routed surface, no Suspense boundaries, no `loading.tsx` / `error.tsx`, no server actions, no `use(promise)`. That's not an oversight — it's a fit-for-purpose call. React 19's marquee data features assume request-response: render once, suspend on a promise, resolve with data. This product is a 30-90s NDJSON stream, not a request-response shape. Suspense has nothing to suspend on; a Server Component can't hold a streaming reader loop. So the framework gives me the route-handler streaming, the file-based routing, the deploy story — and I drive the data layer with a hand-written fetch + `ReadableStream` reader, which is the right shape for this product. If they ask "why no Suspense?" the answer is one sentence: *Suspense is built for promises that resolve; mine never does — it streams.*

```
"Why Next.js?"
        │
        ▼
  ├─► IF THEY ASK "why not Remix / SvelteKit?"
  │     → "Either would stream fine. Next won on my familiarity
  │        and the Vercel deploy story for a hackathon timeline.
  │        I optimized for shipping the AI layer, not for
  │        re-learning a framework."
  │
  ├─► IF THEY ASK "what does App Router give you over Pages?"
  │     → "Route handlers returning a Web ReadableStream, and
  │        co-located server code. The streaming ergonomics are
  │        the reason."
  │
  └─► IF THEY ASK "the 300s cap — is that a problem?"
        → "A live briefing runs well under it, but it's a real
           ceiling: ~1.1s spacing × tool calls. It bounds how
           much an agent can do in one request. I'd measure p95
           run time before pushing more work into a single call."
```

---

## Choice 2 — Your own agent loop, not a framework

> ┌─────────────────────────────────────────────────────────────┐
> │ THEY ASK                                                      │
> │   "Why hand-roll the agent loop instead of LangChain or a     │
> │    framework?"                                                │
> │                                                               │
> │ WHAT THEY'RE TESTING                                          │
> │   Do you understand what an agent loop actually is, or did    │
> │   you reach for a framework to avoid understanding it? Can    │
> │   you justify build-vs-buy on more than "I felt like it"?     │
> └─────────────────────────────────────────────────────────────┘

In your voice:

"An agent loop is small when you write it for one purpose: call the model with a tool schema, run the tool calls it asks for, feed results back, repeat until it answers or you cut it off. That's `runAgentLoop` — one function all four agents share. Each agent is just a prompt, a subset of tools, and an output validator. I built it myself for two reasons. First, control: I needed a hard `maxToolCalls` budget and a forced final synthesis turn, because the MCP server is rate-limited at roughly one request a second and I can't let an agent wander. Second, testability — because the loop takes the MCP client and the Anthropic client as injected dependencies, I test all four agents against fakes with no network. That's how the suite is 169 tests across 18 files with zero live calls. A framework would have hidden the loop I specifically needed to control, and made the fakes harder."

```
┃ I didn't avoid the agent framework because frameworks are
┃ bad — I avoided it because the loop is the part I needed
┃ to control, and it's about forty lines.
```

This is **deliberate** mode — your decision, made for named reasons. Say "I built it" with a flat voice. No apology for not using the popular tool.

---

## Choice 3 — claude-sonnet-4-6 for agents, claude-haiku for intent

> ┌─────────────────────────────────────────────────────────────┐
> │ THEY ASK                                                      │
> │   "Why Anthropic? And why two different models?"              │
> │                                                               │
> │ WHAT THEY'RE TESTING                                          │
> │   Do you match the model to the job, or use the biggest one   │
> │   everywhere? Do you think about cost and latency per call,   │
> │   or just capability?                                         │
> └─────────────────────────────────────────────────────────────┘

In your voice:

"The agents do multi-step tool use against real data — that needs the stronger model, so they run `claude-sonnet-4-6`. But there's one job that's tiny and high-frequency: classifying a free-form question's intent before routing it. That doesn't need a reasoning model, so it runs `claude-haiku-4-5` — cheaper and faster for a one-shot classification. Matching the model to the job is the point: I don't pay sonnet prices to decide which agent should handle a query. And the agent model is a single exported constant, `AGENT_MODEL` in `base.ts`, so swapping it — or pointing it at a different provider's SDK — is a one-line change. I evaluated Anthropic against the OpenAI tool-use path and stayed with Anthropic because the MCP SDK and the tool-use ergonomics were the cleanest fit; that's a choice I'd re-run if pricing or capability shifted."

That's **evaluated-and-accepted** mode, and you should name it that way in the room: "I evaluated the alternative and accepted this one for these reasons" is a stronger sentence than pretending there was never another option.

```
┌──────────────────────────────────┬──────────────────────────────────┐
│ WEAK ANSWER                       │ STRONG ANSWER                     │
├──────────────────────────────────┼──────────────────────────────────┤
│ "I used Claude because it's good  │ "Agents run sonnet because they   │
│  at agents and tool use."         │  do multi-step tool use; intent   │
│                                   │  classification runs haiku        │
│                                   │  because it's a one-shot, high-   │
│                                   │  frequency call that doesn't need │
│                                   │  a reasoning model. I match the   │
│                                   │  model to the job."               │
├──────────────────────────────────┼──────────────────────────────────┤
│ Why it's weak:                    │ Why it works:                     │
│ true but generic — it would       │ shows a cost/latency axis, not    │
│ apply to any model. No cost       │ just a capability one. The two-   │
│ axis, no per-job thinking. You    │ model split is evidence you       │
│ sound like you used one model     │ thought about each call's actual  │
│ for everything and rationalized.  │ requirements.                     │
└──────────────────────────────────┴──────────────────────────────────┘
```

---

## Choice 4 — NDJSON over a ReadableStream, not SSE

> ┌─────────────────────────────────────────────────────────────┐
> │ THEY ASK                                                      │
> │   "Why NDJSON over a fetch stream instead of Server-Sent      │
> │    Events?"                                                   │
> │                                                               │
> │ WHAT THEY'RE TESTING                                          │
> │   Do you know the difference, or did you copy a streaming     │
> │   tutorial? Can you name what EventSource would have cost      │
> │   you here specifically?                                      │
> └─────────────────────────────────────────────────────────────┘

In your voice:

"EventSource forces GET and brings its own event framing and auto-reconnect. I wanted POST semantics, full control of the framing, and one wire format I could reuse across both routes and the demo replay. NDJSON — one JSON object per line — is the simplest thing that works: I emit `JSON.stringify(event) + '\n'` on the server, and on the client I read the stream, split on newlines, and keep the trailing partial line in a buffer until the next chunk completes it. The contract is a single `AgentEvent` union, so the same parser handles the briefing, the investigation, and the cached demo replay. The cost is that I gave up EventSource's free auto-reconnect — so I built reconnection at my own layer instead, which I needed anyway because the alpha server revokes tokens and EventSource's reconnect wouldn't re-auth."

```
┃ I gave up EventSource's free reconnect on purpose — it
┃ wouldn't re-auth against a server that revokes tokens, so
┃ I'd have had to build recovery at my layer regardless.
```

That's the senior move: you didn't just list why your choice is good, you named what you *gave up* and why the lost feature wouldn't have helped here anyway.

---

## Choice 5 — No database

> ┌─────────────────────────────────────────────────────────────┐
> │ THEY ASK                                                      │
> │   "No database at all? Where does anything persist?"          │
> │                                                               │
> │ WHAT THEY'RE TESTING                                          │
> │   Is this a thoughtful choice or a missing piece? Do you      │
> │   know the cost, and can you say when you'd add one — without │
> │   getting defensive?                                          │
> └─────────────────────────────────────────────────────────────┘

In your voice:

"There's no relational data to model here — the workspace data lives in Bloomreach, and I read it ad-hoc through the MCP server. What I'd persist is the briefing results and investigations, and for the demo that's a committed JSON snapshot the app replays. Live state is in-memory maps. I made this call deliberately for the context: a hackathon against an alpha MCP server that revokes tokens after a few minutes. The committed snapshot isn't just convenience — it's the *reliable* path, because it runs with no auth and no upstream at all. The cost I'm paying is real and I'll name it: on Vercel, state is per-instance, so a cold start re-bootstraps the schema and investigations cached on one instance aren't visible to another. The moment this is genuinely multi-user, the first thing I add is a shared store — Redis for the cache, a persistent store for investigations. That's my top counterfactual."

You said the cost out loud and named the trigger for changing it. That converts "no database" from a gap into a decision. We come back to this in Chapter 7 — here you're defending the choice; there you're owning what you'd redo.

```
"No database?"
        │
        ▼
  ├─► IF THEY ASK "isn't that fragile?"
  │     → "For a single demo instance, no — it's simpler and has
  │        fewer failure modes. For multi-user, yes, and I know
  │        exactly what I'd add and when."
  │
  ├─► IF THEY ASK "why is the demo snapshot committed to git?"
  │     → "It's the creds-free presentation path. The alpha
  │        server revokes tokens mid-demo; the snapshot replays
  │        real captured data with no upstream, so the demo never
  │        depends on a flaky connection."
  │
  └─► IF THEY ASK "what would Redis actually fix?"
        → "Shared cache across instances and a place to keep
           investigations so they survive a cold start and are
           visible to every instance. I'd measure cold-start
           rate and cross-instance cache misses to size it."
```

---

╔═══════════════════════════════════════════════════════════════╗
║ WHEN YOU DON'T KNOW                                           ║
║                                                               ║
║   They go deep on a choice you defaulted to: "Your auth uses  ║
║   PKCE and Dynamic Client Registration — why DCR over a       ║
║   pre-registered client, and what's the threat model PKCE is  ║
║   closing?"                                                   ║
║                                                               ║
║   Say:                                                        ║
║   "Honest answer: the PKCE + DCR flow is what the MCP SDK's   ║
║    OAuth provider does, and I accepted its default rather     ║
║    than designing the flow myself. I understand the shape —   ║
║    PKCE closes the auth-code interception attack on public    ║
║    clients, and DCR registers a client dynamically instead    ║
║    of pre-provisioning one — but I didn't choose DCR over     ║
║    pre-registration as a decision; the server and SDK drove   ║
║    it. What I *did* build deliberately is the token store     ║
║    around it: an encrypted cookie in prod, a file in dev. I   ║
║    can defend that part in depth."                            ║
║                                                               ║
║   What this signals: you can tell a decision you MADE from a  ║
║   default you ACCEPTED, you know the shape of the thing you   ║
║   defaulted to, and you redirect to the part you genuinely    ║
║   own. That's the most senior thing you can do with a         ║
║   defaulted-to choice.                                        ║
║                                                               ║
║   Do NOT say:                                                 ║
║   "I chose DCR because it's more secure" — claiming a         ║
║   default as a deliberate decision is the fastest way to get  ║
║   exposed, because the next question assumes you chose it on  ║
║   purpose and you won't have the why.                         ║
╚═══════════════════════════════════════════════════════════════╝

This box is the most important one in the chapter. The three modes of decision-making — **deliberate**, **evaluated-and-accepted**, **defaulted-to** — run through every choice you defend. Owning a defaulted-to choice *as* a default, while pointing at the deliberate work you built around it, is a stronger signal than pretending you designed the OAuth flow from scratch.

```
        ▸ "It's good for this kind of thing" is the sound of a
          forgotten reason. Every defense names a criterion and
          a cost, or it isn't a defense.
```

---

## What you'd change

The most reconsiderable choice in this chapter is the fixed roughly-one-second spacing between MCP calls. It's simple and it's safe against the alpha server's rate limit, and I'd defend it for the context — but it's conservative. A token-bucket or adaptive limiter would use the budget better when the server has headroom, instead of always pausing the full interval. I picked the fixed interval deliberately because, against an alpha server I didn't fully trust, predictable-and-safe beat optimal-and-clever. If the rate limit were documented and stable, I'd move to an adaptive limiter and measure the throughput gain.

---

## One-page summary (night-before review)

**Core claim:** Every load-bearing choice has a named criterion and a named cost — and the choices are linked, not independent (the framework's serverless model is *why* state is in-memory).

**The choices covered:**
- **Next.js 16** — for first-class streaming from route handlers co-located with the UI; cost: Vercel coupling + the 300s cap.
- **Own agent loop, not a framework** — for the `maxToolCalls` control and fake-injected testability; deliberate.
- **sonnet-4-6 agents + haiku-4-5 intent** — match the model to the job; evaluated-and-accepted; one-line `AGENT_MODEL` swap.
- **NDJSON over fetch, not SSE** — POST + simple framing + one wire format; gave up auto-reconnect I'd have replaced anyway.
- **No database** — in-memory + committed demo snapshot; deliberate for the context; cost is per-instance cache loss; Redis is the trigger-based fix.

**Pull quotes:**
- "It's good for this kind of thing" is the sound of a forgotten reason — every defense names a criterion and a cost.
- I gave up EventSource's free reconnect on purpose — it wouldn't re-auth against a token-revoking server.

**What you'd change:** Move the fixed ~1.1s MCP spacing to an adaptive/token-bucket limiter if the rate limit were stable and documented.

---
Updated: 2026-05-29 — created
Updated: 2026-06-02 — Test-count precision: "around 170 tests" → "169 tests across 18 files" to match the current vitest suite per study-testing audit.
Updated: 2026-06-03 — Added a "framework runtime, not its data primitives" paragraph to Choice 1 (Next.js) absorbing the study-frontend-engineering audit's "framework underused" finding — preempts "why no Suspense / Server Components?" with the fit-for-purpose defense (this product is a 30-90s NDJSON stream, not a request-response shape).
