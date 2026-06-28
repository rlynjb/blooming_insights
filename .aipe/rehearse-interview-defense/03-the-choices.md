# Chapter 3 — The choices

Halfway through any senior interview, someone will start picking at your stack. *"Why Next.js? Why no database? Why this agent library? Why NDJSON and not server-sent events?"* The trap is to treat each one as a separate trivia question. They're not. They're all variations of one question: **do you know why you reached for what you reached for, or did you default into it?**

This chapter walks five load-bearing choices. For each one, you'll get the alternatives you actually evaluated, the criterion that decided it, and the cost you're paying. The structure is the same every time, because that's the structure a senior answer has: *I picked X because Y, and the cost I'm watching is Z.*

You'll also learn to name the **decision mode** every time. Three modes:

- **Deliberate** — you considered alternatives and chose this on a named criterion.
- **Evaluated-and-accepted** — AI or a library suggested it, you read it, you tested it, you accepted.
- **Defaulted-to** — you took the default and didn't deeply evaluate. Riskiest to own; strongest signal when owned well.

Most of your choices are some mix. Naming the mode is the senior move.

## The decision tree — the chapter on one page

```
  Five load-bearing choices, with mode and the cost you're watching

                                    decision
                                       │
              ┌────────────┬───────────┼───────────┬────────────┐
              │            │           │           │            │
              ▼            ▼           ▼           ▼            ▼
        ┌─────────┐  ┌──────────┐ ┌─────────┐ ┌─────────┐ ┌────────┐
        │ NO DB   │  │  APTKIT  │ │DATASOURCE│ │ NDJSON  │ │ OAUTH  │
        │         │  │ MIGRATION│ │   SEAM   │ │ over    │ │ PKCE + │
        │         │  │          │ │          │ │ fetch   │ │  DCR   │
        └────┬────┘  └─────┬────┘ └─────┬────┘ └────┬────┘ └────┬───┘
             │             │            │           │           │
       mode: │       mode: │      mode: │     mode: │     mode: │
   DELIBERATE│   EVAL-AND- │  DELIBERATE│   DELIB.  │  DEFAULTED│
             │   ACCEPTED  │            │           │           │
             ▼             ▼            ▼           ▼           ▼
       cost: in-      cost: a thin   cost: 516    cost: no    cost: token
       process         adapter        LOC of      bidir.      revoke
       state (now     layer to        synthetic   stream      after
       session-       maintain (~200  to keep     surface     minutes
       keyed; cross-  LOC) when       in sync     yet         on alpha
       instance       AptKit's API    with real                Bloomreach
       still open)    shifts          data                     server
```

Each branch below gets its own treatment. Read them in order — they build on each other.

## Choice 1 — No database (in-process state only)

```
  ┌─────────────────────────────────────────────────┐
  │ THEY ASK                                        │
  │   "Why no database? Where do you store state?"  │
  │                                                 │
  │ WHAT THEY'RE TESTING                            │
  │   Do you reach for Postgres on reflex, or do    │
  │   you actually know what state your system has  │
  │   and where it needs to live? Are you honest    │
  │   about the cost of skipping the database?      │
  └─────────────────────────────────────────────────┘
```

The strong answer, in your voice:

> "Deliberate choice, for the context. The state in this system is mostly ephemeral — the streamed reasoning trace, the in-flight insights for one session, the OAuth tokens in an encrypted cookie. The two pieces of *persistent* state I have are committed to the repo as JSON: `lib/state/demo-insights.json` and `lib/state/demo-investigations.json`. Those are the demo snapshot — the reliable presentation path. Everything else lives in `lib/state/insights.ts` as a `Map<sessionId, SessionFeed>`.
>
> "The cost I'm paying — and I'll be direct about this — is **cross-instance state**. One warm Vercel instance is fine. Two instances and a user's second request lands somewhere with no memory of the first. For a portfolio app with no production traffic that's a non-issue; the day I have two instances I'd reach for Vercel KV or a small Postgres. The seam is already there in the `lib/state/` module.
>
> "There's a real bug in this corner I should name. The original `insights.ts` was a global `Map<id, Insight>` with a `.clear()` at the top of every briefing write. For one user that's correct. For two concurrent users on one warm instance, user A's `.clear()` wiped user B's mid-session. AI had suggested the original shape; I accepted it; I caught it later on a concurrency re-read; the fix was to session-key the map. **Shipped.** That's the strongest version of owning a defaulted-to decision — AI wrote it, I accepted it, I read it again as a real bug, here's the fix and it shipped."

```
  ┌─────────────────────────┬─────────────────────────┐
  │ WEAK "WHY NO DB" ANSWER │ STRONG "WHY NO DB"      │
  ├─────────────────────────┼─────────────────────────┤
  │ "I didn't need one for  │ "Deliberate, for the    │
  │ a portfolio project."   │ context. Most state is  │
  │                         │ ephemeral. The persist- │
  │                         │ ent piece is the demo   │
  │                         │ snapshot, committed as  │
  │                         │ JSON. Cost I'm paying:  │
  │                         │ cross-instance state.   │
  │                         │ Seam's ready; trigger   │
  │                         │ is multi-instance,      │
  │                         │ which isn't here yet."  │
  ├─────────────────────────┼─────────────────────────┤
  │ Why it's weak:          │ Why it works:           │
  │ Reads as "I cut corners │ Names the decision mode │
  │ because it's a side     │ (deliberate). Names     │
  │ project." No mention of │ what state exists and   │
  │ what state actually     │ where it lives. Names   │
  │ exists or where it      │ the cost. Names the     │
  │ lives. No cost named.   │ trigger that would      │
  │                         │ change it.              │
  └─────────────────────────┴─────────────────────────┘
```

```
  ┃ "AI wrote this, I accepted it, I later read it as
  ┃  a real bug, here's the fix and it shipped."
```

## Choice 2 — The AptKit migration (and the legacy preserved)

This is the single most consequential decision-revisit in the project. Get it right and you've shown the interviewer something most candidates can't — that you can revisit a decision you previously defended hard, and articulate what changed.

```
  ┌─────────────────────────────────────────────────┐
  │ THEY ASK                                        │
  │   "Why this agent library — why not write the   │
  │    loop yourself? Or why not use LangChain?"    │
  │                                                 │
  │ WHAT THEY'RE TESTING                            │
  │   Do you know what an agent loop actually does, │
  │   or did you import a framework and pray? Can   │
  │   you defend a decision that *changed* — that   │
  │   was one thing six months ago and is something │
  │   else today?                                   │
  └─────────────────────────────────────────────────┘
```

The strong answer:

> "I did write the loop myself first. The original `runAgentLoop` is still in the repo at `lib/agents/base-legacy.ts`, lines 86 to 176. That was a deliberate choice at the time, for two reasons. One: I needed a hard `maxToolCalls` budget against a rate-limited upstream that could revoke my token at any minute. Two: I needed a **forced final synthesis turn** — when the budget runs out, the agent has to produce a structured answer rather than a half-finished tool call. Both are disciplines that an off-the-shelf agent runtime might not give me out of the box.
>
> "Then `@aptkit/core` reached `0.3.0` and the primitive surface got clean — `ModelProvider`, `ToolRegistry`, `CapabilityTraceSink`. I read the source, confirmed that both disciplines survive — the budget can be configured, the forced-synthesis pattern is expressible — and migrated. The result is `lib/agents/aptkit-adapters.ts`, three Blooming-owned adapter classes, about two hundred lines: `AnthropicModelProviderAdapter`, `BloomingToolRegistryAdapter`, `BloomingTraceSinkAdapter`. **Library owns the loop. I own the boundary.**
>
> "That's a different decision-mode answer than the no-DB one. This one was **evaluated-and-accepted**. I didn't take AptKit on faith; I had the hand-rolled loop in front of me and a list of disciplines I wasn't willing to give up. The migration was the conclusion of a comparison, not a default. And the legacy is preserved — `base-legacy.ts` is my rollback receipt. The day AptKit's API shifts in a way that breaks one of my disciplines, I peel back to the legacy loop while I figure out how to express the discipline in the new shape."

The line in `aptkit-adapters.ts` worth pointing at:

```ts
// lib/agents/aptkit-adapters.ts:60,65 — usage logged from the model adapter
//   const res = await this.client.messages.create({ ... })
//   logger.info({ usage: res.usage }, 'anthropic.usage')
//   ...
//   logger.info({ usage: res.usage }, 'anthropic.usage.final')
```

That `res.usage` log is the boundary doing its job — token accounting lives on my side of the adapter, not buried inside the library.

```
  ┃ "I own the boundary; AptKit owns the loop. Three
  ┃  small adapter classes, about 200 lines, and the
  ┃  legacy loop is preserved for the day I need to
  ┃  peel back to it."
```

## Choice 3 — The DataSource seam (`lib/data-source/types.ts`)

```
  ┌─────────────────────────────────────────────────┐
  │ THEY ASK                                        │
  │   "Why an abstract DataSource interface? Isn't  │
  │    that future-proofing?"                       │
  │                                                 │
  │ WHAT THEY'RE TESTING                            │
  │   Do you understand the difference between a    │
  │   seam that earns its cost (because something   │
  │   real flips across it) and an abstraction      │
  │   added "in case we need it"?                   │
  └─────────────────────────────────────────────────┘
```

The strong answer:

> "Not future-proofing — receipt-driven. The interface is `lib/data-source/types.ts`. Two adapters today: `BloomreachDataSource` does HTTPS over OAuth PKCE with about 1.1-second call spacing and rate-limit retry; `SyntheticDataSource` is in-process, deterministic, about 500 lines of Blooming-owned synthetic ecommerce data. The factory is `makeDataSource(mode, sessionId)`.
>
> "Here's the receipt for it being a real seam: it has already survived two adapter swaps without changing the caller surface. An Olist SQLite adapter was added and later removed; the Synthetic adapter replaced it. Each time, the agent code didn't change — it kept calling `dataSource.executeEql(...)` and `dataSource.listTools()`. That's the test for whether a seam is load-bearing or cosmetic: would the layers either side need to change if I swapped the implementation? In this case, demonstrably no.
>
> "The cost I'm paying is the synthetic adapter itself — 516 lines I have to keep semantically aligned with what real Bloomreach returns. That's real maintenance. It earns its place because it lets me run the system end-to-end without an alpha rate-limited upstream — which is the difference between being able to demo this on a flight and not."

```
  ┌─────────────────────────┬─────────────────────────┐
  │ WEAK "WHY THE SEAM"     │ STRONG "WHY THE SEAM"   │
  ├─────────────────────────┼─────────────────────────┤
  │ "I added it so I could  │ "Not future-proofing.   │
  │ swap data sources in    │ Receipt-driven. The     │
  │ the future."            │ seam has survived two   │
  │                         │ adapter swaps without   │
  │                         │ the agent code changing │
  │                         │ — Olist added, removed, │
  │                         │ Synthetic in. That's    │
  │                         │ the test."              │
  ├─────────────────────────┼─────────────────────────┤
  │ Why it's weak:          │ Why it works:           │
  │ "In the future" is the  │ Names the *historical*  │
  │ phrase senior engineers │ evidence (two swaps).   │
  │ are trained to mistrust │ Defines the test for a  │
  │ — it's how abstraction  │ real seam (no caller    │
  │ debt enters codebases.  │ change). Names the cost.│
  └─────────────────────────┴─────────────────────────┘
```

## Choice 4 — NDJSON over fetch (not SSE, not WebSocket)

```
  ┌─────────────────────────────────────────────────┐
  │ THEY ASK                                        │
  │   "Why NDJSON over fetch and not SSE? Or a      │
  │    WebSocket?"                                  │
  │                                                 │
  │ WHAT THEY'RE TESTING                            │
  │   Do you know what each transport actually      │
  │   gives you, or did you copy the streaming      │
  │   pattern from a tutorial? Did you pick the     │
  │   simplest contract that meets your needs?      │
  └─────────────────────────────────────────────────┘
```

The strong answer:

> "Deliberate. The shape of the data is *append-only events from one writer to one reader*. NDJSON over fetch gives me exactly that — one line per event, `JSON.parse` each line, the browser's stream reader handles the chunking. The whole consumer is `lib/streaming/ndjson.ts`, 64 lines, and it's the kernel under four streaming surfaces — the briefing, the diagnose step, the recommend step, and the free-form query. One kernel, four call sites.
>
> "I didn't pick SSE because SSE adds a framing convention (`event:` and `data:` lines, `id:` for resumability) I don't need, and the browser `EventSource` API can't send a POST body or custom headers — and I need both, for the OAuth cookie and the `x-bi-mode` header. I didn't pick a WebSocket because the data flow is one-directional. A WebSocket buys me a bidirectional surface and asks me to pay for it with connection state, heartbeats, and reconnection logic. The system doesn't have a bidirectional case yet.
>
> "Cost I'm watching: if I ever need bidirectional — say, a 'cancel this investigation' message from the UI back to the agent — NDJSON over fetch doesn't help me. I'd add an out-of-band cancellation endpoint first; if that gets clunky, that's the trigger to consider a WebSocket. Not before."

```
  ┃ "I picked the simplest contract that meets the
  ┃  shape of the data: append-only, one writer,
  ┃  one reader. NDJSON over fetch is exactly that."
```

## Choice 5 — OAuth PKCE + Dynamic Client Registration

This is the **defaulted-to** decision. Own it cleanly.

```
  ┌─────────────────────────────────────────────────┐
  │ THEY ASK                                        │
  │   "Walk me through your OAuth setup. PKCE? DCR? │
  │    Why?"                                        │
  │                                                 │
  │ WHAT THEY'RE TESTING                            │
  │   Do you understand what you implemented at the │
  │   protocol level, or did you copy an MCP        │
  │   example? Can you say "I defaulted to this"    │
  │   without sounding like you don't know what     │
  │   it does?                                      │
  └─────────────────────────────────────────────────┘
```

The strong answer:

> "Honest framing: this is the **defaulted-to** decision in the project. The MCP SDK ships with an `OAuthClientProvider` interface that expects PKCE and Dynamic Client Registration, and the Bloomreach loomi connect server is configured for both. I implemented the provider, I didn't pick the protocol. So when I defend PKCE and DCR, I'm defending the *mechanics* of the implementation, not the *choice* to use them.
>
> "What I do defend is the wrapper around the SDK's expectations. The auth state needs to survive a serverless cold start, so I built an encrypted-cookie store — `lib/mcp/auth.ts`, AES-256-GCM, the key derived from `AUTH_SECRET`. In dev it falls back to a gitignored JSON file so I don't have to set the secret. The provider's storage methods (`tokens()`, `saveTokens()`, `clientInformation()`, `saveClientInformation()`) all go through that store, threaded with `AsyncLocalStorage` so each request's cookie is in scope inside the SDK's callbacks.
>
> "The cost is that PKCE plus DCR is a multi-step dance and there are corner cases I haven't pushed on — for example, what happens if `saveClientInformation` is called twice with different client IDs in rapid succession. The wrapper would prefer the latest write, which is probably fine, but I haven't proven it. If you want to push on PKCE internals — the code-verifier hashing, the `S256` challenge, the back-channel exchange — I can walk through what the SDK does, but I'd be reading you the SDK, not defending a choice I made."

That last sentence is the move. It hands the interviewer the truth — *here's where my knowledge ends* — without conceding the parts you do own.

## When you don't know

The question most likely to push you past your depth in this chapter is **a comparison to an agent framework you don't know well** — LangChain, LangGraph, CrewAI, AutoGen. You looked at the conceptual shapes, you didn't run them.

```
  ╔═══════════════════════════════════════════════╗
  ║ WHEN YOU DON'T KNOW                           ║
  ║                                               ║
  ║   They ask: "How does AptKit compare to       ║
  ║   LangGraph? Why not pick LangGraph?"         ║
  ║                                               ║
  ║   You haven't shipped on LangGraph. The       ║
  ║   honest answer is to defend AptKit on its    ║
  ║   own terms and not pretend to a comparison   ║
  ║   you can't make.                             ║
  ║                                               ║
  ║   Say:                                        ║
  ║   "I haven't shipped on LangGraph, so I can't ║
  ║    give you a real comparison. What I can     ║
  ║    tell you is what AptKit gave me that I     ║
  ║    needed: a clean primitive surface — model  ║
  ║    provider, tool registry, trace sink — that ║
  ║    let me keep the two disciplines I wasn't   ║
  ║    willing to give up: a hard tool-call       ║
  ║    budget and a forced final-synthesis turn.  ║
  ║    The migration from my hand-rolled loop was ║
  ║    conditional on both surviving. If LangGraph║
  ║    expresses those as cleanly I'd be open to  ║
  ║    looking. Want me to walk through how the   ║
  ║    forced-synthesis pattern works in my       ║
  ║    code?"                                     ║
  ║                                               ║
  ║   What this signals: confidence about what    ║
  ║   you chose, honesty about the comparison     ║
  ║   you can't make, and a re-route to a thread  ║
  ║   you can defend in depth.                    ║
  ║                                               ║
  ║   Do NOT say:                                 ║
  ║   "LangGraph is more for stateful graphs and  ║
  ║    AptKit is more for stateless flows."       ║
  ║   Vague taxonomy you read on a blog. An       ║
  ║   interviewer who has used LangGraph will     ║
  ║   pull on it and you'll fall apart.           ║
  ╚═══════════════════════════════════════════════╝
```

## Follow-up decision tree — choice questions usually come in chains

```
  Whichever choice they pick, the chain is usually the same:
  "why" → "what's the cost" → "when would you change it" → "have you measured"

        │
        ▼
  You give the named-criterion answer (mode + criterion).
        │
        ├─► "What's the cost?"
        │     Always have one ready. Every choice in this
        │     chapter has a cost named. Don't pretend it's
        │     free.
        │
        ├─► "When would you reconsider?"
        │     Always have a named trigger. "Multi-instance
        │     deployment." "AptKit's API shifts." "Workspace
        │     with different event naming." Real triggers,
        │     not "more users."
        │
        └─► "Have you measured?"
              The honest answer is usually no for portfolio
              projects. Say so. Name what you'd measure first
              if you had production traffic. (For the data
              source seam: per-call latency by adapter. For
              NDJSON: time-to-first-line and time-to-final-
              event.)
```

## What you'd change about the choices

If you were doing this over today, the one choice you'd revisit hardest is **the rate-limit spacing on `BloomreachDataSource`**. I'm currently spacing calls at about 1.1 seconds because the alpha server is ambiguous about its real rate limit and I picked a conservative number to stay safe. That choice is costing me real latency on every live run — a multi-step diagnostic agent makes ten or fifteen tool calls, and at 1.1s spacing that's ten or fifteen seconds of artificial wait. If I had a stable upstream with documented headroom, I'd measure actual rate-limit responses and tighten the spacing. The trigger is *measurement plus a documented limit*, not a guess.

## One-page summary

**Core claim:** Every load-bearing choice has the same shape — *I picked X because Y, the cost I'm watching is Z, the trigger that would change it is W.* Name the decision mode every time (deliberate, evaluated-and-accepted, or defaulted-to).

**The five choices and their one-line defenses:**
- **No DB** → deliberate; cost is cross-instance state (seam ready, trigger is multi-instance).
- **AptKit migration** → evaluated-and-accepted; cost is adapter maintenance; legacy preserved as rollback.
- **DataSource seam** → deliberate; cost is 516 LOC of synthetic; receipt is two adapter swaps without caller change.
- **NDJSON over fetch** → deliberate; cost is no bidirectional surface; trigger is a real cancel-mid-stream need.
- **OAuth PKCE+DCR** → defaulted-to; defend the wrapper, not the protocol choice.

**Pull quotes:**
```
  ┃ "I own the boundary; AptKit owns the loop. Three
  ┃  small adapter classes, about 200 lines, and the
  ┃  legacy loop is preserved for the day I need to
  ┃  peel back to it."

  ┃ "AI wrote this, I accepted it, I later read it as
  ┃  a real bug, here's the fix and it shipped."

  ┃ "I picked the simplest contract that meets the
  ┃  shape of the data: append-only, one writer,
  ┃  one reader. NDJSON over fetch is exactly that."
```

**What you'd change:** tighten the Bloomreach call spacing once the upstream is stable and documented; measure actual rate-limit responses rather than guessing conservative.
