# Chapter 5 — The failure story

The failure question is the operational maturity probe. Anyone can ship a happy path. The senior signal is whether you've actually walked the codebase asking *"what happens when this returns nothing,"* *"what happens when this throws,"* *"what happens when the user navigates away mid-request."*

This chapter walks the failure surfaces in **blooming insights** — there are five — and for each one, what the system actually does when that surface fails. Some are handled well. Some are handled honestly (you know about the gap and you've named the cost). One is genuinely a soft spot you'd fix next. The senior move is to name all three honestly, not to perform comprehensiveness on the ones that are weak.

## The failure-mode map — five failure surfaces

The visual anchor. Trace one row at a time — failure surface on the left, system behavior on the right, your defense underneath.

```
  blooming insights — failure surfaces and current behavior

  ─────────────────────────────────────────────────────────────────────────
  FAILURE SURFACE                  WHAT THE SYSTEM DOES TODAY
  ─────────────────────────────────────────────────────────────────────────

  1.  Bloomreach token             useReconnectPolicy detects invalid_token
      revoked mid-session          in the NDJSON error event, resets auth
      (the alpha behavior)         state, reloads the feed once (guarded
                                   against re-loops). Demo mode is the
                                   reliable presentation fallback —
                                   ?demo=cached serves the committed
                                   snapshot, no auth.

  2.  Bloomreach 429               BloomreachDataSource retries with the
      (rate limit hit)             configured spacing (~1.1s baseline).
                                   On repeated failure the agent receives
                                   an error tool-result and decides what
                                   to do (usually: surface as best-effort
                                   evidence in the trace, continue).

  3.  Anthropic API outage         The agent loop surfaces the API error
      or partial response          as a real error JSON in the NDJSON
                                   stream. UI shows an error panel with
                                   a reconnect button. Bare 500s used to
                                   leak from /api/briefing setup
                                   (Chapter 6, hard bug 2 — fixed).

  4.  Malformed EQL result         validate.ts rejects shapes that don't
      from Bloomreach              match the WorkspaceSchema; the result
                                   never reaches the agent. Tool call
                                   ends with a structured error the
                                   agent can reason about.

  5.  User navigates away          useInvestigation's StrictMode-safe
      mid-fetch                    pattern (Chapter 6, hard bug 1) means
                                   the fetch is not cancelled on unmount
                                   — setState after unmount is a safe
                                   no-op. Pending writes complete; the
                                   user's next session hydrates from
                                   sessionStorage if they back-nav.
```

Five surfaces, five behaviors. Now defend each. The trap is to claim a behavior the system doesn't actually have. Don't — every defense below is anchored to real code.

## Failure 1 — Bloomreach token revoke (the alpha killer)

```
  ┌─────────────────────────────────────────────────┐
  │ THEY ASK                                        │
  │   "What happens if the upstream auth fails      │
  │    mid-session?"                                │
  │                                                 │
  │ WHAT THEY'RE TESTING                            │
  │   Have you thought about non-happy-path auth?   │
  │   Specifically: do you handle the case where a  │
  │   token is valid when you start and invalid     │
  │   30 seconds later?                             │
  └─────────────────────────────────────────────────┘
```

The strong answer:

> "This was the single most consequential reliability constraint in the project. The Bloomreach loomi connect alpha server **revokes tokens after minutes**. Not an hour, not a day — minutes. That means a token I issued at the start of a briefing can be invalid by the time the agent is partway through its tool calls.
>
> "The defense is two-layered. First, the **detection layer** — `useReconnectPolicy` (123 LOC, one of the three custom hooks I extracted from `app/page.tsx`). When the NDJSON stream emits an error event whose code is `invalid_token`, the policy resets the OAuth state through `/api/mcp/reset` and triggers exactly one reload of the feed. There's a guard against re-loops — if the reload itself errors with the same code, we surface the error to the UI instead of looping forever.
>
> "Second, the **fallback layer** — demo mode. The default `bi:mode` is `'demo'`, which serves a committed snapshot from `lib/state/demo-insights.json`. There's no auth in the demo path. So if you're presenting this on a flight, or if the alpha server is having a bad day, demo is the reliable surface and you can demonstrate the system without depending on the upstream at all. The honest framing is that demo mode exists *because* the alpha is unreliable, not as a fake metric.
>
> "Cost I'm paying: live mode is recovery-oriented. I'm not going to claim it's production-stable — it's stable enough to capture fresh snapshots locally, which I then commit for the demo path. The trigger that would change the design is a stable upstream that doesn't revoke; at that point the demo-replay machinery becomes optional rather than load-bearing."

```
  ┃ "Demo mode exists because the alpha is unreliable,
  ┃  not as a fake metric. Calling it that out loud is
  ┃  the senior move."
```

## Failure 2 — Bloomreach 429 (rate limit)

The 429 case lives in `BloomreachDataSource` (and the old `lib/mcp/client.ts` shim before the seam was extracted).

> "The data source is configured to space calls at roughly 1.1 seconds — the conservative number for the documented rate limit. When a 429 still comes back (the limit is ambiguous and the server occasionally throttles harder than documented), the data source retries with a back-off. After a configured number of retries, the call surfaces as a structured error tool-result to the agent.
>
> "Here's the senior signal: I don't pretend the agent recovers gracefully from every 429. What the agent does is treat the failed tool call as *evidence in its trace*. The diagnostic agent's prompt is structured to keep going on best-effort evidence — it cites what it has, names what's missing, and lowers its confidence accordingly. So a partial-data diagnosis is honest about being partial, not invented.
>
> "What I'd add if I were operating this in production: a circuit breaker on the data source. After N consecutive 429s in a window, fail fast and surface a 'upstream degraded' state to the UI rather than hammering. Today I don't have that — the conservative spacing has been enough."

## Failure 3 — Anthropic API outage or partial response

> "Two cases here. **API outage** — Anthropic returns a 5xx or the request times out. The adapter at `lib/agents/aptkit-adapters.ts` lets the error propagate; AptKit's loop surfaces it; the route handler emits a real error JSON in the NDJSON stream; the UI's error panel shows it with a reconnect button.
>
> "**Partial response** — the trickier case. Sonnet's streaming response gets cut off mid-tool-use block, or the final synthesis turn ends without a structured answer. The adapter logs the partial `res.usage` (lines 60 and 65) so I can see what tokens were spent before the cut. The agent loop's discipline — the **forced final synthesis turn** I built in the legacy and preserved in the AptKit migration — is the defense here: when the model budget runs out, the loop forces one more turn that has to produce a structured answer rather than another tool call. That turn can itself fail, but it bounds the unboundedness.
>
> "What used to leak: a bare 500 from `/api/briefing` when the **setup** before the stream threw — specifically when `aesKey()` in `lib/mcp/auth.ts` threw because `AUTH_SECRET` was unset in production. I caught that one (Chapter 6, hard bug 2) and wrapped the setup in a try/catch that returns a real error JSON with the actual cause. So 'AUTH_SECRET is required in production' now shows up in the error panel instead of a bare 500."

## Failure 4 — Malformed EQL result from Bloomreach

> "The validation layer is `lib/mcp/validate.ts`. Every EQL result is parsed against the expected shape before it reaches the agent — a result with missing keys, wrong types, or unexpected envelope structure is rejected. The tool call ends with a structured error the agent can reason about ('the EQL returned a malformed result with X missing') rather than the agent receiving a confused payload and producing a confused conclusion.
>
> "The Bloomreach MCP result envelope is also a known footgun — sometimes the data is in `structuredContent`, sometimes in `content[0].text` as a JSON string. The transport layer at `lib/mcp/transport.ts` handles that branching so the agent code never has to see it. That's the **MCP result envelope handling** that's in the *what-must-not-change* list — the agents above the transport assume a normalized shape."

## Failure 5 — User navigates away mid-fetch

This one's worth a careful walk because it ties to the trickiest bug in the project (Chapter 6, hard bug 1).

> "The pattern most React tutorials would tell you to write is: cancel the in-flight fetch on unmount via an AbortController. I tried that. It collided with React StrictMode in development in a specific way that caused **empty logs in development** — and only in development. The mechanism is in Chapter 6; the short version is that the cleanup-cancel and the started-guard were solving for different lifetimes, and under StrictMode they cancelled the only request and then blocked the remount from starting fresh.
>
> "The fix at `lib/hooks/useInvestigation.ts` is to **keep the started-guard, drop the cleanup-cancel**. `setState` after unmount is a safe no-op — React just ignores it. The pending fetch completes; if the component is gone, the result is discarded; if the user back-navs (which the hook supports through `sessionStorage` hydration), the result is there for them.
>
> "Cost I'm paying: a fetch that the user has navigated away from runs to completion and consumes upstream budget. For a portfolio app that's negligible. At production scale I'd want a debounced or coalesced cancellation that survives StrictMode — the right pattern is a single source of truth for whether the request is 'still wanted,' not a cleanup-side cancellation."

```
  ┌─────────────────────────┬─────────────────────────┐
  │ WEAK FAILURE ANSWER     │ STRONG FAILURE ANSWER   │
  ├─────────────────────────┼─────────────────────────┤
  │ "The system has retries │ "Five failure surfaces. │
  │ and error handling      │ Token revoke is handled │
  │ throughout. Errors are  │ by useReconnectPolicy   │
  │ caught and surfaced to  │ resetting auth and      │
  │ the user. We have a     │ reloading once with a   │
  │ demo mode as a backup." │ guard. Rate-limit 429s  │
  │                         │ retry, then surface as  │
  │                         │ evidence to the agent.  │
  │                         │ The bare-500 setup leak │
  │                         │ used to happen and I    │
  │                         │ fixed it..."            │
  ├─────────────────────────┼─────────────────────────┤
  │ Why it's weak:          │ Why it works:           │
  │ Sweeping. Doesn't name  │ Names each surface,     │
  │ a specific surface, a   │ each behavior, each     │
  │ specific behavior, or   │ file. Names a real bug  │
  │ a specific weakness.    │ that's been fixed.      │
  │ Reads as the candidate  │ Honest about the costs  │
  │ has rehearsed the word  │ still being paid.       │
  │ "retries."              │                          │
  └─────────────────────────┴─────────────────────────┘
```

## The follow-up tree

```
  You walk the five failure surfaces.
        │
        ▼
        ├─► "What's the worst failure mode?"
        │     Token revoke mid-investigation. Honest answer:
        │     it interrupts the user's flow even with the
        │     reconnect, because the in-flight investigation
        │     state isn't durable. Fix would be a more
        │     persistent investigation store; today you re-
        │     navigate and the investigation re-runs.
        │
        ├─► "How do you know about these in production?"
        │     Honest: today I don't have production. The
        │     real signal is the dev-time NDJSON error
        │     event surfaced to the UI. In production I'd
        │     add structured logs at the route boundaries
        │     and at aptkit-adapters.ts (where res.usage is
        │     already logged) wired into a sink. Today the
        │     server logs go to Vercel; no aggregation.
        │
        ├─► "What's the worst silent failure?"
        │     The agent producing a confident-sounding
        │     diagnosis from partial evidence. That's not
        │     a code bug — it's a reasoning failure. The
        │     defense is the prompt discipline (cite
        │     evidence, lower confidence on partials)
        │     plus the retired eval suite's regression
        │     check. Naming that the eval is retired is
        │     part of the honest story (Chapter 6).
        │
        └─► "Have you tested the failure paths?"
              The hard bug fixes have tests. The reconnect
              policy has tests. The validate.ts schemas
              have tests. 24 test files, 221 passing.
              Honest gap: the full token-revoke-mid-stream
              path is hard to test deterministically and
              I haven't built the harness for it.
```

## When you don't know

The territory most likely to push you past your depth is **distributed failure modes** — what happens to a request that's partially committed across two services, partial network partitions, eventual consistency under partition.

```
  ╔═══════════════════════════════════════════════╗
  ║ WHEN YOU DON'T KNOW                           ║
  ║                                               ║
  ║   They ask: "What happens if the Bloomreach   ║
  ║   call partially succeeds and your service    ║
  ║   crashes before the result reaches the       ║
  ║   client?"                                    ║
  ║                                               ║
  ║   You haven't designed for distributed        ║
  ║   commit semantics. The system is fire-and-   ║
  ║   stream, not transactional.                  ║
  ║                                               ║
  ║   Say:                                        ║
  ║   "Honest answer: today the system isn't      ║
  ║    transactional across that boundary. The    ║
  ║    Bloomreach call either succeeds or fails;  ║
  ║    if my service dies after the tool result   ║
  ║    is in memory but before the NDJSON line    ║
  ║    is flushed, the user reloads and the       ║
  ║    whole briefing re-runs — the upstream      ║
  ║    call is paid for twice. There's no idem-   ║
  ║    potency key on the briefing scan today.    ║
  ║    For production I'd add one: a per-session  ║
  ║    request ID that lets a retry coalesce      ║
  ║    against the in-flight original. I haven't  ║
  ║    built that and I won't pretend I have."    ║
  ║                                               ║
  ║   What this signals: you understand what      ║
  ║   distributed commit even means, you know     ║
  ║   what you'd build, and you're not pretending ║
  ║   you've shipped it.                          ║
  ║                                               ║
  ║   Do NOT say:                                 ║
  ║   "The retries should handle that." They      ║
  ║   don't. The interviewer is testing whether   ║
  ║   you know what retries cover and what they   ║
  ║   don't.                                      ║
  ╚═══════════════════════════════════════════════╝
```

## What you'd change in the failure story

The one weakest spot in the failure story today is **observability**. The system has good error *behavior* — it doesn't crash silently, it doesn't lose user state, it routes errors to the UI. What it lacks is a real production-grade signal that errors are happening at all. `res.usage` is logged at `lib/agents/aptkit-adapters.ts:60,65`, route handlers throw to Vercel's default logger, and that's it. The fix is structured logs at the route boundaries plus a sink — datadog, axiom, anything. The trigger is production traffic; for a portfolio project it's not worth the wiring yet.

## One-page summary

**Core claim:** The senior move on failures is to name the five surfaces, name what the system actually does for each, and be honest about which behaviors are robust and which are still soft.

**The five failure surfaces, one line each:**
- **Token revoke** → `useReconnectPolicy` resets auth, reloads once, with a re-loop guard. Demo is the reliable fallback.
- **Rate-limit 429** → spacing + retry, then surface as evidence to the agent.
- **Anthropic outage / partial** → real error JSON in the NDJSON stream; forced final synthesis bounds unboundedness.
- **Malformed EQL** → validated at `lib/mcp/validate.ts`; rejected before reaching the agent.
- **User navigates away** → fetch runs to completion; `setState` after unmount is a no-op; back-nav hydrates from `sessionStorage`.

**Pull quote:**
```
  ┃ "Demo mode exists because the alpha is unreliable,
  ┃  not as a fake metric. Calling it that out loud is
  ┃  the senior move."
```

**What you'd change:** add structured logs at the route boundaries plus a real sink. The error *behaviors* are good; the observability is missing. Production traffic is the trigger.
