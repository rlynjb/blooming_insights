# Chapter 5 — The failure story

  ## Opening hook

Somewhere in every senior interview, someone asks the failure question. "What happens if the database goes down? What if the LLM API times out? What if a user sends malformed input?" This is the operational-thinking round. Interviewers are checking whether you built a happy-path demo or a system that stays standing when things go wrong.

Most candidates answer this round with vibes: "I have error handling." "There's retry logic." "It's resilient." None of that lands. What lands is a specific failure surface, the specific thing the system does at that surface, and a real receipt that the failure mode has been exercised — not imagined.

Your failure story has a receipt other candidates don't have. **Nine injected faults across three investigations, zero investigation failures.** This chapter builds around that receipt.

  ## The chapter-opening diagram

The failure-mode map. Each surface is a box. Each box names what the system does when the fault fires.

```
  The failure-mode map — what the system does when things go wrong

  ┌─ Browser / Client faults ───────────────────────────────────┐
  │                                                             │
  │  Network drops mid-stream                                   │
  │    → readNdjson yields until the reader errors              │
  │    → useInvestigation surfaces the error to StatusLog       │
  │    → user sees a reconnect button (auth path)               │
  │                                                             │
  │  Malformed NDJSON line                                      │
  │    → readNdjson buffers partial lines, JSON.parse per line  │
  │    → parse failure logs + drops the line, does not crash    │
  │                                                             │
  │  User closes tab mid-investigation                          │
  │    → sessionStorage stash means back-nav hydrates instant   │
  │    → StrictMode double-fetch protection at hook layer       │
  └────────────────────────┬────────────────────────────────────┘
                           │
  ┌─ Route layer faults ───▼────────────────────────────────────┐
  │                                                             │
  │  BudgetExceededError thrown mid-investigation               │
  │    → agent.run() short-circuits BEFORE next dispatch        │
  │    → route emits `error` NDJSON event, closes stream        │
  │                                                             │
  │  300s route budget exceeded                                 │
  │    → maxDuration=300 kills the function                     │
  │    → client sees stream close without `done` event          │
  │                                                             │
  │  Session validation failure                                 │
  │    → return 401, client resets auth, single retry           │
  │    → auto-reconnect guarded against retry loop              │
  └────────────────────────┬────────────────────────────────────┘
                           │
  ┌─ Agent layer faults ───▼────────────────────────────────────┐
  │                                                             │
  │  Model API 5xx / timeout                                    │
  │    → AptKit's loop presents as tool_result: is_error:true   │
  │    → model reasons around it, retries or writes conclusion  │
  │                                                             │
  │  Budget check-before-dispatch                               │
  │    → BudgetTracker.check() BEFORE model call                │
  │    → runaway loop cannot cost more than the ceiling         │
  │                                                             │
  │  Prompt cache miss (first call)                             │
  │    → cache_creation_input_tokens counted at premium rate    │
  │    → subsequent calls hit cache_read (cost drops)           │
  └────────────────────────┬────────────────────────────────────┘
                           │
  ┌─ Provider layer faults ────▼────────────────────────────────┐
  │                                                             │
  │  MCP call timeout (per-call: 30s)                           │
  │    → transport.ts:38+131 composes AbortSignal               │
  │    → tool_result: is_error:true → model reasons around      │
  │                                                             │
  │  MCP call 5xx / network error                               │
  │    → same shape: is_error:true to the model                 │
  │                                                             │
  │  MCP call rate-limited (429)                                │
  │    → McpClient retries with backoff                         │
  │    → gives up after budget, emits is_error:true             │
  │                                                             │
  │  OAuth token revoked mid-request                            │
  │    → capturing fetch catches raw response body              │
  │    → auth flow triggers re-auth (guarded, once)             │
  │                                                             │
  │  FaultInjectingDataSource decorator (test-only)             │
  │    → 4 modes: timeout · error · slow · malformed_response   │
  │    → severity-order rolls, PRNG seed for repro              │
  │    → RECEIPT: 9 faults / 3 investigations / 0 failures      │
  └─────────────────────────────────────────────────────────────┘
```

Every surface named. Every response named. Every real timing budget cited. The receipt at the bottom is the one you carry into the room.

  ## The load-bearing receipt

┌─────────────────────────────────────────────────┐
│ THEY ASK                                        │
│   "How do you know your error handling actually  │
│   works? Have you tested it?"                   │
│                                                 │
│ WHAT THEY'RE TESTING                            │
│   Have you exercised your failure paths, or     │
│   are you speculating? Do you have a receipt or │
│   a story?                                      │
└─────────────────────────────────────────────────┘

This is the question your fault-injection receipt was built for. Say it directly:

> *"I built a fault-injecting decorator on top of my DataSource port. Four failure modes — timeout, error, slow response, malformed response — each at configurable rates, with a PRNG seed so failures are reproducible.*
>
> *I ran three end-to-end investigations under it. Across those three runs, nine injected faults fired. Zero investigation failures. Every single fault got presented to the model as a `tool_result` block with `is_error: true`, and the model reasoned around it — either retried the call, tried a different tool, or wrote its conclusion without that piece of evidence.*
>
> *That's the receipt. Nine faults, three investigations, zero failures. The behavior isn't 'the system catches errors' — the behavior is 'AptKit's agent loop wraps tool calls, and when they fail, the failure becomes the model's problem, not the invocation's problem.' There's no invocation-level catch-and-retry. The model reasons.*
>
> *That's the pattern I wanted to prove. Modern agent loops don't need per-tool retry logic; they need the model to understand it can fail. My receipt is that this actually works."*

┃ "Nine injected faults across three investigations,
┃  zero investigation failures. The model reasoned
┃  around every fault."

┌─────────────────────────┬─────────────────────────┐
│ WEAK ANSWER             │ STRONG ANSWER           │
├─────────────────────────┼─────────────────────────┤
│ "I have try/catch       │ "I built a fault-       │
│ around the tool calls   │ injecting decorator on  │
│ and retry logic if      │ the DataSource port.    │
│ they fail. I've tested  │ Nine injected faults    │
│ it works."              │ across three            │
│                         │ investigations. Zero    │
│                         │ investigation failures. │
│                         │ Each fault presents as  │
│                         │ tool_result:            │
│                         │ is_error:true — the     │
│                         │ model reasons around."  │
├─────────────────────────┼─────────────────────────┤
│ Why it's weak:          │ Why it works:           │
│ "Retry logic" without   │ Specific receipt.       │
│ specifying what layer.  │ Specific numbers.       │
│ "Tested it works" with  │ Specific mechanism      │
│ no receipt. Signals     │ (is_error:true block).  │
│ hopeful engineering,    │ Names why the mechanism │
│ not verified.           │ works (model reasons    │
│                         │ around it) — that's a   │
│                         │ built-it insight.       │
└─────────────────────────┴─────────────────────────┘

  ## Failure surface by surface

The receipt is the closer, but the interviewer will usually walk you through specific surfaces one at a time. Here's what to say for each.

  ### MCP call timeout — 30 seconds per call

┌─────────────────────────────────────────────────┐
│ THEY ASK                                        │
│   "What happens if the MCP call hangs? What's   │
│   your timeout?"                                │
│                                                 │
│ WHAT THEY'RE TESTING                            │
│   Do you know your timing budgets? Are they     │
│   composed sanely, or do you have one deep      │
│   timeout at the top with no per-call limit?    │
└─────────────────────────────────────────────────┘

Say this:

> *"Timeouts are composed. Each MCP tool call has a 30-second per-call timeout, wired up in `lib/mcp/transport.ts` around lines 38 and 131 — the `SdkTransport` composes the route signal with an `AbortController` that fires at 30 seconds. On top of that, the whole route has a 300-second budget. `maxDuration=300` on the route, and I check it during the loop.*
>
> *When the 30-second per-call fires, the fetch aborts, `SdkTransport` throws, `McpClient` catches and — depending on whether it was a first attempt or a retry — either retries or gives up. If it gives up, the tool call returns `is_error: true` to the agent loop. Model reasons around it.*
>
> *When the 300-second route budget fires, `maxDuration` cuts the whole function. The client's `readNdjson` sees the stream close without a `done` event and surfaces an error state. Not graceful, but bounded. The user sees 'something went wrong, try again.'*
>
> *The composition matters. A single top-level 300-second timeout with no per-call limit means a single bad tool call could eat the whole budget while the model waits. Composed, each call is bounded, and the loop gets to make progress even if one tool call fails."*

  ### Auth revocation mid-request — the alpha-server reality

┌─────────────────────────────────────────────────┐
│ THEY ASK                                        │
│   "What happens if the OAuth token gets revoked  │
│   during an investigation?"                     │
│                                                 │
│ WHAT THEY'RE TESTING                            │
│   Do you know how OAuth failures actually       │
│   look? Do you have a real reconnect strategy   │
│   or just theoretical error handling?           │
└─────────────────────────────────────────────────┘

Say this:

> *"The Bloomreach loomi-connect alpha server revokes tokens after minutes. This isn't hypothetical — I ran into it constantly during development. The failure surface is a real one for this codebase.*
>
> *When it fires: `SdkTransport`'s capturing fetch catches the raw error body (that's why I need capturing fetch — the SDK swallows response bodies on errors otherwise). The transport surfaces `invalid_token`. The route emits an NDJSON error event with a specific error code. The client — the feed page — sees that code, resets auth in `lib/mcp/auth.ts`, and reloads the request once. Guarded — one reload, not a loop.*
>
> *This is a case where the failure mode drove the design. If loomi-connect had stable tokens I wouldn't have needed the capturing fetch or the auto-reconnect. The receipt is that auth revocations are a routine occurrence in dev and the reconnect path handles them without user intervention."*

  ### Concurrent user wipe — the fixed one

You'll cover the fix in depth in Chapter 6, but it belongs on the failure map here because it *was* a failure surface that shipped.

> *"There was a real concurrent-user failure surface until Week 3. `lib/state/insights.ts` used a `Map<insightId, Insight>`. Two users on the same warm instance overwrote each other's feeds. Fixed by keying on `sessionId` instead. `Map<sessionId, SessionFeed>`. The failure was silent — no error, just wrong data. That's the worst kind of failure to catch, and I only caught it because I was reading `insights.ts` for a different reason. It's in Chapter 6 in full."*

Volunteering a real past failure — one that's fixed and receipted — is a stronger signal than defending only the successes.

  ## The follow-up decision tree

Failure questions have a distinct branching pattern. Here's what interviewers push on:

```
  You describe the fault injection receipt.
        │
        ▼
  ┌─► "What's an example of a fault the model
  │    couldn't reason around?"
  │      Honest answer: with 4 fault modes at those
  │      rates over 3 investigations, I haven't hit
  │      one. But I know the shape — a systematic
  │      failure where every tool call fails would
  │      end in the model writing a conclusion of
  │      "I could not gather evidence." Which is
  │      correct behavior but not useful output.
  │      I'd want to detect that pattern and
  │      surface it to the user distinctly.
  │
  ├─► "What's your retry strategy for the MCP
  │    client?"
  │      McpClient in lib/mcp/client.ts implements
  │      retry-with-backoff on 429s. Backoff is
  │      exponential with jitter. Gives up after a
  │      bounded number of attempts. No cache-on-
  │      error — a failed call doesn't poison the
  │      cache for the next request.
  │
  ├─► "How would you tell if the LLM is
  │    hallucinating a tool result?"
  │      The tool result comes back from
  │      DataSource with real structure — an
  │      envelope with structuredContent or
  │      content[0].text. The model can't
  │      fabricate a call result mid-loop; it
  │      only sees results the agent loop
  │      returned to it. What I can't detect is
  │      the model misinterpreting a real
  │      result. That's what the eval flywheel
  │      is for — evidence_grounding is one of
  │      the four judged dimensions.
  │
  └─► "Do you have any circuit breakers?"
       Not formally. Backoff and per-call
       timeouts are the closest thing. A real
       circuit breaker — 'stop calling this
       tool for N minutes' — would help under
       sustained upstream outage. I haven't built
       it because the eval hasn't surfaced a
       case where the model kept slamming a
       broken tool.
```

  ## When you don't know

The territory where failure questions push past your depth is anything about actual production outage response. You have not been on-call for a service you built. You don't have real incident retros. Own it.

```
╔═══════════════════════════════════════════════╗
║ WHEN YOU DON'T KNOW                           ║
║                                               ║
║   They ask: "Walk me through an actual         ║
║   incident. Something went down. What did      ║
║   your team do?"                              ║
║                                               ║
║   You have not been on-call for a production   ║
║   AI system. You've been on-call at            ║
║   enterprise for FedEx / Amazon / CoreWeave    ║
║   frontend work, but LLM-agent incidents are   ║
║   a new class you have not owned.              ║
║                                               ║
║   Say:                                        ║
║   "I have not been on-call for an LLM agent    ║
║    incident. My on-call history is             ║
║    enterprise frontend — production            ║
║    JavaScript errors, layout regressions,     ║
║    the shape of incident I've walked is       ║
║    'user X can't do Y, here's the console     ║
║    error.' Blooming insights is a system      ║
║    I've built end-to-end in isolation. I       ║
║    have the fault-injection receipt, but I     ║
║    don't have the war story. What I would     ║
║    walk you through is how I'd triage one —    ║
║    the receipts I already emit through        ║
║    onCapabilityEvent would be my first       ║
║    signal. Want me to walk that?"             ║
║                                               ║
║   What this signals: honest scope of what     ║
║   you own, portfolio experience acknowledged   ║
║   without inflating it, and a concrete offer   ║
║   that shows you can think through triage      ║
║   even though you haven't lived it.           ║
║                                               ║
║   Do NOT say:                                 ║
║   "Well, there was this one time when          ║
║    someone reported a bug and we…"            ║
║   Stretching a small bug report into an       ║
║   incident narrative reads as inflation.      ║
║   The interviewer has been on-call. They      ║
║   know what a real incident sounds like.       ║
║   Yours will sound off. Better to own the     ║
║   gap.                                        ║
╚═══════════════════════════════════════════════╝
```

  ## What you'd change

If you were designing the failure story from scratch, the biggest change: build the FaultInjectingDataSource decorator on day one, not in Week 4. When you started, you had try/catch and hope. The decorator forced you to face what actually happens on each surface — and the AptKit-loop reasoning behavior only became visible because you injected the faults. Without the decorator, you'd be defending failure handling on trust. With it, you're defending it on receipt.

The second change: add a circuit breaker to `McpClient`. Right now the backoff is exponential-with-jitter but there's no "stop trying this tool for 5 minutes." Under a sustained loomi-connect outage, an investigation would eat its full 300-second budget on repeated 429s. Not catastrophic, but wasteful. A circuit breaker at the client would fail fast on the first call and return a clean is_error to the model.

The rest of the failure story stays. Composed timeouts, model-reasons-around-faults, guarded auto-reconnect on auth revocation — all correct calls that shipped.

  ## The one-page summary

**Core claim.** blooming insights's failure story is composed timeouts (30s per call, 300s per route), model-reasons-around-faults (via `is_error:true` tool_result blocks), and one production-grade receipt: 9 injected faults across 3 investigations, 0 investigation failures.

**The questions covered.**

  → "How do you know error handling works?" → FaultInjectingDataSource decorator, 9 faults / 3 investigations / 0 failures.
  → "What if MCP hangs?" → 30s per-call timeout at transport.ts:38+131, composed with 300s route budget.
  → "What if the OAuth token revokes?" → capturing fetch surfaces invalid_token, client resets auth, guarded one-reload.
  → "What's your retry strategy?" → McpClient exponential backoff with jitter, no cache-on-error, gives up on budget.
  → "Any circuit breakers?" → not formally. Would add one to McpClient if I were doing it again.

**The pull quote.**

  → *"Nine injected faults across three investigations, zero investigation failures. The model reasoned around every fault."*

**What you'd change.** Build FaultInjectingDataSource on day one, not Week 4. Add a real circuit breaker to McpClient.
