# Chapter 4 — The scale story

The scale question is a senior-leveling probe. The interviewer doesn't actually care whether your portfolio app handles a million users. They care whether you can think about *what breaks first*, in what order, with what fix. If you answer with "Vercel auto-scales," you've failed the probe before they finished asking it.

This chapter walks three scale scenarios — 10× users, 100× data, 10× latency-sensitive requests. For each, you'll name **the first bottleneck**, **the second bottleneck**, **what you'd add when**, and **how you'd measure to know**. The trick is that for *this* codebase, the binding constraint is almost never your own service. It's almost always upstream. Owning that honestly is the senior move.

## The scale-bottleneck chart — what breaks first as load grows

The visual anchor for the chapter. Trace one row at a time.

```
  blooming insights — what breaks first under each scale dimension

  ───────────────────────────────────────────────────────────────────
  SCENARIO          1st bottleneck         2nd bottleneck         3rd
  ───────────────────────────────────────────────────────────────────

  10× concurrent    Bloomreach rate-       Anthropic per-org      Vercel
  users (live)      limit (~1 RPS,         token throughput       function
                    revokes after          (Sonnet 4.6)           concurrency
                    minutes)                                       per region
                          │                       │                    │
                          ▼                       ▼                    ▼
                    add queue +            add request batching    scale to
                    one MCP connection     across users in a       per-request
                    per workspace, not     workspace; cache        instance pool
                    per request            insights at session     (Vercel default
                                           level                   handles this)


  100× data         Bloomreach EQL         Synthetic adapter      In-process
  (workspace        query latency          512 LOC has to         insights Map
  10× bigger)       (90-day window over    keep parity with       cardinality
                    a much bigger event    real shapes
                    stream)
                          │                       │                    │
                          ▼                       ▼                    ▼
                    push narrower          regenerate from        session-key
                    aggregations into      a real workspace       eviction policy
                    EQL; reduce            snapshot               (today: grows
                    period-over-period     periodically            unbounded per
                    span; sample                                  process; OK at
                    customer scope                                low N, not at
                                                                  high N)


  10× latency-      Anthropic time-to-     Bloomreach per-call    NDJSON line
  sensitive         first-token (Sonnet    spacing (~1.1s)        framing /
  requests          4.6 ~600ms-1s) on      multiplied by 10-15    serialization
  (faster TTFB)     a forced-synthesis     calls per agent run    (negligible
                    final turn                                    today, becomes
                                                                  real at very
                                                                  high event
                                                                  rates)
                          │                       │                    │
                          ▼                       ▼                    ▼
                    consider Haiku for     measure actual         pre-serialize
                    monitoring agent's     headroom; tighten      hot-path event
                    first pass; reserve    spacing; or fan out    shapes; today
                    Sonnet for             concurrent reads       not worth it
                    diagnostic synthesis   over multiple
                                           workspaces
```

That's the whole chapter on one page. The pattern that should jump out: **the first bottleneck is always upstream**. Not your code. Owning that is the scale conversation's punchline.

## The big question — "how does this scale?"

```
  ┌─────────────────────────────────────────────────┐
  │ THEY ASK                                        │
  │   "How does this scale? What if you had ten     │
  │    times the load?"                             │
  │                                                 │
  │ WHAT THEY'RE TESTING                            │
  │   Will you reach for "Vercel auto-scales" or    │
  │   do you actually know what your binding        │
  │   constraint is? Can you sequence bottlenecks   │
  │   — what breaks first, what next, what after    │
  │   that?                                         │
  └─────────────────────────────────────────────────┘
```

The strong opener — the sentence that frames the whole answer:

> "Before I answer the load number, let me name the binding constraint, because it shapes everything below it. **My code is not the bottleneck in this system.** The two upstreams are — Bloomreach loomi connect at roughly one request per second, with tokens that revoke after minutes; and the Anthropic API on a per-org TPM budget. So when you ask 'how does this scale,' the honest first answer is: it scales until I hit one of those two, and after that the question is how I avoid hammering them. Then we can talk about my service."

Now you've done two things in one sentence: you've shown you know what *actually* breaks first, and you've reframed the question to a design conversation you can have.

## Scenario 1 — 10× concurrent users on live mode

> "First bottleneck is the Bloomreach rate limit. The alpha server is documented at roughly one request per second per workspace, and I space my calls at about 1.1 seconds to stay conservative. A single diagnostic agent makes ten to fifteen tool calls. So one user costs me roughly 15 seconds of upstream time. Ten concurrent users on the same workspace would serialize on the upstream — I'd be effectively single-threaded against Bloomreach.
>
> "The fix is **one MCP connection per workspace, not per request**. Today every `/api/briefing` call opens its own connection through `BloomreachDataSource`. At 10× users I'd add a workspace-level connection pool with a request queue — every user's tool call goes onto the queue, the queue drains at the upstream's rate limit, results fan back out. The data-source seam at `lib/data-source/types.ts` is the right place for that — it's a connection-management change inside `BloomreachDataSource`, no caller-side change.
>
> "Second bottleneck is the Anthropic per-org token budget. Sonnet 4.6 has a TPM ceiling per org, and a 15-call agent run consumes meaningful tokens per user. At 10× I'd batch where possible — same monitoring scan can serve multiple users in the same workspace, which means caching the monitoring output at the session or workspace level, not re-running it per request.
>
> "What I'd measure to know: per-request upstream latency on Bloomreach (I'd add a histogram on `BloomreachDataSource.executeEql`), and rate-limit-error rate. If I'm not seeing 429s I have headroom; if I'm seeing them I need the queue. The `res.usage` logs I already write at `lib/agents/aptkit-adapters.ts:60,65` give me the Anthropic-side token accounting."

```
  ┌─────────────────────────┬─────────────────────────┐
  │ WEAK SCALE ANSWER       │ STRONG SCALE ANSWER     │
  ├─────────────────────────┼─────────────────────────┤
  │ "Vercel serverless      │ "Binding constraint     │
  │ functions auto-scale,   │ isn't my service —      │
  │ so the app should       │ it's the upstream       │
  │ handle more users       │ rate limit. First       │
  │ pretty well."           │ thing that breaks at    │
  │                         │ 10× users is serial-    │
  │                         │ ization against         │
  │                         │ Bloomreach. Fix is      │
  │                         │ one connection per      │
  │                         │ workspace with a        │
  │                         │ request queue."         │
  ├─────────────────────────┼─────────────────────────┤
  │ Why it's weak:          │ Why it works:           │
  │ Cargo-culted infra      │ Names the actual        │
  │ confidence. Doesn't     │ binding constraint.     │
  │ name a bottleneck.      │ Names the fix and       │
  │ Doesn't show you've     │ where it lives in       │
  │ thought about it.       │ the codebase. Names     │
  │                         │ what you'd measure.     │
  └─────────────────────────┴─────────────────────────┘
```

```
  ┃ "My code is not the bottleneck in this system.
  ┃  The two upstreams are."
```

## Scenario 2 — 100× data (workspace 10× bigger)

> "This is the most interesting scenario for this system, because the agents are doing period-over-period on a 90-day window. At 100× data, the EQL queries get slower in two ways: more events to aggregate, and more cardinality in the breakdowns (more countries, more product categories, more customer segments).
>
> "First bottleneck is **EQL query latency**. The monitoring agent runs maybe six to eight queries per scan, each over 90 days. At 10× workspace size those go from sub-second to multi-second. The fix is upstream: push narrower aggregations into EQL — instead of `sum event purchase.total_price` over 90 days globally, ask for daily buckets and aggregate client-side. Or reduce the window for the first-pass scan (30 days), and only use 90 days for confirmed anomalies that need stable comparison. Both keep the analyst loop honest; they just spend less data on each pass.
>
> "Second bottleneck is the **synthetic adapter's parity**. At 10× workspace size the real Bloomreach response shapes start exercising edge cases the synthetic adapter doesn't model — sparse countries, long-tail products, customers with no events. The cost there is that my synthetic dev path stops matching production behavior. The fix is to regenerate the synthetic data periodically from a real workspace snapshot, not to hand-author it.
>
> "Third is the in-process `Map<sessionId, SessionFeed>` — it grows unbounded per process. At very high session counts I'd add an LRU eviction. But honestly, the session is short-lived (one user, one briefing), so the cardinality isn't worrying until I'm at thousands of concurrent sessions, which loops back to scenario 1.
>
> "Measure: per-EQL-call latency histograms; cardinality of monitoring-scan result sets per workspace size. If a 90-day scan crosses ~5 seconds I'd push the window-narrowing change."

## Scenario 3 — 10× latency-sensitive requests (faster TTFB)

> "Time-to-first-byte on the streamed feed is dominated by two things: Anthropic time-to-first-token on a forced-synthesis turn, and the cumulative spacing of Bloomreach tool calls in the agent loop. The synthesis turn alone is roughly 600ms to 1s for Sonnet 4.6. The tool-call spacing is 1.1s per call, multiplied by however many tool calls the agent makes.
>
> "First bottleneck is the **synthesis latency on Sonnet**. The strongest lever here is model selection per agent stage. Right now everything runs on Sonnet 4.6, except the intent classifier which is Haiku. I'd consider moving the *monitoring scan's first-pass detection* to Haiku — it's a structured pattern-match against EQL results, which Haiku handles fine — and reserving Sonnet for the diagnostic's hypothesis-testing synthesis where reasoning quality matters.
>
> "Second bottleneck is the **call spacing on Bloomreach**. I'm at 1.1 seconds because the rate limit is ambiguous. If I had a documented limit and could measure headroom in production, I'd tighten to whatever the real ceiling supports. At 10× latency-sensitive requests that's worth real engineering investment — but only with the measurement, never with a guess.
>
> "Third is **NDJSON line framing and serialization**, which is negligible today. Each line is small, `JSON.stringify` is fast. At very high event rates on a single connection I'd pre-serialize the hot-path event shapes (`reasoning_step`, `tool_call_start`), but I'm not within an order of magnitude of needing that.
>
> "Measure: TTFB on `/api/briefing` (the first NDJSON line); per-agent-stage latency; the existing `res.usage` logs to know which model is consuming what."

## The follow-up tree

Scale questions usually chain. Walk the branches.

```
  You give the binding-constraint answer.
        │
        ▼
        ├─► "What do you measure to know when to add it?"
        │     Always have one ready per bottleneck. EQL
        │     histogram. Bloomreach 429 rate. Anthropic
        │     TPM. TTFB. Don't say "monitoring" — say
        │     the specific signal.
        │
        ├─► "What if you couldn't change the upstream?"
        │     Re-frame to *your* design moves: caching,
        │     queueing, batching, lower-cost model per
        │     stage. The data-source seam lets you change
        │     the implementation without changing callers.
        │
        ├─► "How would you load-test it?"
        │     Synthetic adapter is the answer — it's in-
        │     process and deterministic. You can drive
        │     N concurrent sessions through the real
        │     agent path without touching Bloomreach.
        │     Be honest that you haven't run the test;
        │     describe the setup.
        │
        └─► "What about cost?"
              The token-accounting log at aptkit-adapters
              .ts:60,65 is the on-ramp. Per-stage token
              counts × per-agent runs × users gives you
              an envelope. Honest about not having a
              production number yet.
```

## When you don't know

The question most likely to push you past your depth is **multi-region** or **distributed scale at FAANG numbers**. You haven't built either. Don't pretend.

```
  ╔═══════════════════════════════════════════════╗
  ║ WHEN YOU DON'T KNOW                           ║
  ║                                               ║
  ║   They ask: "How would you handle a million   ║
  ║   concurrent users across three regions?"     ║
  ║                                               ║
  ║   You haven't shipped a multi-region system   ║
  ║   under real load. Don't invent one.          ║
  ║                                               ║
  ║   Say:                                        ║
  ║   "I haven't shipped a multi-region system    ║
  ║    at that scale. What I can tell you is      ║
  ║    where the failure points in this           ║
  ║    architecture would land first: the         ║
  ║    in-process insights map becomes a real     ║
  ║    problem when traffic spans multiple        ║
  ║    instances, so cross-instance state moves   ║
  ║    to KV or Postgres. The Bloomreach          ║
  ║    workspace is per-tenant, so a million      ║
  ║    users across workspaces is a per-tenant    ║
  ║    rate-limit problem, not a single-tenant    ║
  ║    one. Beyond that I'd be guessing at        ║
  ║    failure modes I haven't operated. Happy    ║
  ║    to design it with you on the whiteboard    ║
  ║    if you want — I just won't claim I've      ║
  ║    shipped it."                               ║
  ║                                               ║
  ║   What this signals: senior-level honesty     ║
  ║   about the gap between portfolio-scale       ║
  ║   experience and FAANG-scale experience,      ║
  ║   without giving up the design ground you     ║
  ║   *do* know.                                  ║
  ║                                               ║
  ║   Do NOT say:                                 ║
  ║   "You'd put it behind a load balancer and    ║
  ║    use Redis for caching and add more         ║
  ║    instances." Generic. The interviewer       ║
  ║    will ask follow-ups you can't answer.      ║
  ╚═══════════════════════════════════════════════╝
```

## What you'd change in the scale story

The one thing missing from the scale story today is **a real load test on the synthetic adapter**. The setup exists — `makeDataSource('live-synthetic', sessionId)` runs the agent loop end-to-end with no upstream. I could drive N concurrent `/api/briefing` calls against that and measure the in-process Map cardinality, the per-stage latency, the memory growth. I haven't. The trigger is preparing for a real interviewer who asks "have you measured" — at that point I want a number to point to, not a defense of the design alone.

## One-page summary

**Core claim:** Scale questions are about sequencing bottlenecks. For this system, the first bottleneck is *always upstream*. Naming that honestly reframes the conversation into a design discussion you can have.

**The three scenarios in one line each:**
- **10× users** → first bottleneck is Bloomreach rate limit; fix is one MCP connection per workspace + request queue.
- **100× data** → first bottleneck is EQL query latency; fix is narrower aggregations and shorter window for first-pass scans.
- **10× latency-sensitive** → first bottleneck is Sonnet synthesis time; fix is per-stage model selection (Haiku for first-pass, Sonnet for synthesis).

**Pull quotes:**
```
  ┃ "My code is not the bottleneck in this system.
  ┃  The two upstreams are."

  ┃ "I'd tighten the call spacing once the upstream
  ┃  is stable and I have a measurement, never with
  ┃  a guess."
```

**What you'd change:** run a real load test against the synthetic adapter to get numbers you can point at, instead of defending the design alone.
