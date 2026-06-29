# Chapter 4 — The scale story

  ## Opening hook

The architecture chapter showed what you built. The choices chapter showed why each piece is the right shape today. This chapter is about what breaks first as load grows — and the discipline of knowing the *order* it breaks in, not just naming a thing that could fail.

Most candidates get this question wrong in one of two ways. They either say "well I haven't scaled this" and trail off — which signals they don't even know which knob would matter. Or they confabulate a five-layer caching, sharding, replicating answer that no one would actually build for an app at this size. The senior signal is being able to walk three realistic scale scenarios for *your specific app*, name what breaks first, second, third, and name what you'd measure to know.

You have three realistic scenarios worth walking: ten times the concurrent users on the live mode, one hundred times the insights persisted across sessions, ten times the Bloomreach calls per briefing. The first stresses your in-memory state model. The second stresses your no-DB stance. The third stresses your rate-limit budget. Different bottleneck each time.

  ## The picture you draw — the scale-bottleneck chart

This is the visual anchor. Three scenarios across the top; the bottleneck order down the side. The chart names what bites first as the load on each axis grows.

```
  What breaks first, by scenario

                     │ 10× concurrent  │ 100× insights   │ 10× Bloomreach
                     │ users (live)    │ persisted       │ calls per brief
  ───────────────────┼─────────────────┼─────────────────┼─────────────────
  1st bottleneck     │ Bloomreach      │ in-memory Map   │ ~1 req/s rate
                     │ rate-limit      │ memory pressure │ limit budget
                     │ shared budget   │ per warm        │ blows the run
                     │ across users    │ instance        │ duration
  ───────────────────┼─────────────────┼─────────────────┼─────────────────
  2nd bottleneck     │ in-memory state │ cold-start      │ maxDuration=300
                     │ split across    │ rebuild cost on │ runs out of
                     │ warm instances  │ new warm inst.  │ headroom
  ───────────────────┼─────────────────┼─────────────────┼─────────────────
  3rd bottleneck     │ Sonnet 4.6      │ NDJSON payload  │ token spend on
                     │ token spend     │ size at first   │ model per brief
                     │ per agent run   │ render          │
  ───────────────────┼─────────────────┼─────────────────┼─────────────────
  what to measure    │ p95 briefing    │ V8 heap per     │ tool calls per
                     │ duration, MCP   │ session, time-  │ run, rate-limit
                     │ retry counts    │ to-first-event  │ retry counts
                     │                 │ from cold       │
```

Read the chart top to bottom by column. Each column is one scenario; each row is what gives way first, second, third. Memorize the *first row*. That's the answer to the surface question. The other rows are what comes out under follow-up.

  ## The body — the three scenarios walked

  ### Scenario 1 — 10× concurrent users on live mode

```
  ┌─────────────────────────────────────────────────────────────┐
  │ THEY ASK                                                    │
  │   "What happens if ten users hit the live mode at the same  │
  │    time?"                                                   │
  │                                                             │
  │ WHAT THEY'RE TESTING                                        │
  │   Do you know where your shared resources are? Do you       │
  │   understand that the constraint isn't always in your app,  │
  │   it can be at the boundary you depend on? Can you tell     │
  │   the story across layers?                                  │
  └─────────────────────────────────────────────────────────────┘
```

**Strong answer:**

> "The first thing that breaks isn't in my app — it's at the Bloomreach boundary. The alpha loomi connect server rate-limits at roughly one request per second, and that's a single bucket across all my live traffic, not per-user. My `BloomreachDataSource` already paces calls with that ~1.1s spacing and a retry on 429, but with ten concurrent users each making five to fifteen tool calls per briefing, the queue stacks up. Briefings that normally finish in fifty seconds start hitting the maxDuration=300 ceiling. Users see in-progress timelines stalled at 'querying Bloomreach.'
>
> The second thing that breaks is cross-instance state. Vercel will spin up a second warm instance to absorb the load, and now my in-memory session state is split. If a user's briefing finishes on instance A and their click into 'investigate' lands on instance B, instance B has no record of the briefing. They get a 404-shaped failure: 'insight not found.'
>
> The third thing is per-user token spend on Sonnet 4.6. The agent loops aren't free — a diagnostic run is typically six to eight model turns. At ten times the users I'm paying ten times the token bill, which is just a budget conversation, not a system failure.
>
> What I'd measure: p95 briefing duration on `/api/briefing`, the MCP retry counter inside `lib/mcp/client.ts`, and a count of 'investigation not found' responses on `/api/agent`. The first tells me I'm queueing on the rate limit; the second confirms it; the third tells me I've crossed the cross-instance threshold."

```
  ┃ "The first bottleneck isn't in my app. It's at the
  ┃  Bloomreach boundary — one bucket, all my live traffic."
```

```
  ┌─────────────────────────┬─────────────────────────────────┐
  │ WEAK ANSWER             │ STRONG ANSWER                   │
  ├─────────────────────────┼─────────────────────────────────┤
  │ "I'd want to add Redis  │ "First bottleneck: Bloomreach   │
  │  for shared state, and  │  rate limit, shared bucket.     │
  │  maybe scale the        │  Second: cross-instance state   │
  │  Vercel functions       │  split. Third: model token      │
  │  horizontally."         │  spend. Measure: p95 briefing,  │
  │                         │  MCP retries, not-found counts." │
  ├─────────────────────────┼─────────────────────────────────┤
  │ Why it's weak: prescribes│ Why it works: names what       │
  │ the fix before naming   │ actually breaks, in order, with  │
  │ what breaks. The        │ the metric that would tell you. │
  │ interviewer wanted the  │ Reaches for the fix only after  │
  │ diagnosis; you gave     │ the diagnosis is complete.       │
  │ them a plan.            │                                  │
  └─────────────────────────┴─────────────────────────────────┘
```

  ### Scenario 2 — 100× insights persisted across sessions

```
  ┌─────────────────────────────────────────────────────────────┐
  │ THEY ASK                                                    │
  │   "If you started persisting every briefing — say a hundred │
  │    sessions worth of insights — what gives way?"            │
  │                                                             │
  │ WHAT THEY'RE TESTING                                        │
  │   Do you understand that 'in-memory is fine' has a ceiling? │
  │   Can you walk the failure curve of an explicitly-bounded   │
  │   design? Can you describe the cold-start failure mode      │
  │   without panicking?                                        │
  └─────────────────────────────────────────────────────────────┘
```

**Strong answer:**

> "The first thing that gives way is memory on the warm instance. Right now `lib/state/insights.ts` holds an outer `Map<sessionId, SessionFeed>` where each `SessionFeed` is three inner maps. With a hundred sessions retained, the outer map has a hundred entries and each session's insight + investigation payload is non-trivial — every insight carries evidence (the captured tool result), which can be a few KB of JSON each. A hundred sessions times ~10 insights each times a few KB of evidence is megabytes of resident memory. The warm instance starts trimming garbage less effectively, and the V8 heap pressure shows up as slower agent loops.
>
> The second thing that gives way is cold-start rebuild cost. When Vercel spins up a fresh warm instance, the in-memory state is empty. A user whose session had a hundred insights now starts blank. With ephemeral state this is acceptable — the briefing is fresh anyway. With *persisted* state, it's a regression. That's when in-memory stops being the right model.
>
> The third thing is the NDJSON payload on first render. If the feed page paginated through a hundred insights instead of serving the latest run, the initial payload balloons. The current UI was designed for one briefing at a time, so this is a UI shape question more than a backend one.
>
> What I'd measure: V8 heap size per warm instance (Vercel exposes this), and time-to-first-event for a fresh-instance briefing. The first tells me when memory is the constraint; the second tells me cold-starts are getting expensive."

```
  ┃ "In-memory is fine until you want history. The trigger
  ┃  to add a database is the day 'persisted briefing'
  ┃  becomes a user request."
```

  ### Scenario 3 — 10× Bloomreach calls per briefing

```
  ┌─────────────────────────────────────────────────────────────┐
  │ THEY ASK                                                    │
  │   "If your agents got more thorough and started making ten  │
  │    times the tool calls per briefing, what breaks first?"   │
  │                                                             │
  │ WHAT THEY'RE TESTING                                        │
  │   Do you know your latency budget? Have you actually        │
  │   counted what a run costs in wall-clock seconds? Can you   │
  │   tell the story without confusing token cost with time     │
  │   cost?                                                     │
  └─────────────────────────────────────────────────────────────┘
```

**Strong answer:**

> "The first thing that breaks is the run-duration budget against the rate limit. At ~1.1s spacing between Bloomreach calls, ten times the calls means ten times the floor on wall-clock duration spent waiting on the boundary. A briefing that ran fifty seconds at five tool calls now runs five hundred seconds at fifty — and `maxDuration = 300` on the route handler kicks in. The route times out before the agent finishes synthesizing.
>
> The second thing that breaks is the user's patience curve. Even if I bumped `maxDuration` to the platform ceiling, a five-minute-plus stream is a different product than a one-minute stream. The streaming-reasoning surface helps — the user sees activity, not a spinner — but expectations shift past a couple of minutes.
>
> The third thing is per-briefing token spend on Sonnet 4.6. Ten times the tool calls means roughly ten times the tool-result blocks in the conversation history, which all replay into every subsequent model turn. The cost grows superlinearly, not linearly, because each later turn carries more context.
>
> What I'd measure: tool calls per run (already logged via `res.usage` at `lib/agents/aptkit-adapters.ts:60,65`), the MCP retry counter, and the per-route wall-clock duration. The first tells me the agent is getting verbose; the second tells me I'm queueing on the rate limit; the third tells me where the run-duration ceiling is."

  ## The follow-ups across all three

```
  Likely follow-ups across all three scale scenarios
        │
        ▼
  You named the first bottleneck for the scenario asked.
        │
        ├─► IF THEY ASK "WHAT WOULD YOU FIX FIRST?"
        │     For (1) 10× users: graceful queueing in front
        │     of /api/briefing so a burst doesn't pile up
        │     on Bloomreach. For (2) 100× persisted: introduce
        │     a database. For (3) 10× calls: a parallel-safe
        │     tool-call scheduler, since the rate limit allows
        │     queued bursts.
        │
        ├─► IF THEY ASK "WHY HAVEN'T YOU DONE IT?"
        │     None of the three load conditions are real yet.
        │     This is a one-warm-instance demo + dev tool.
        │     The trigger to do any of these is the scenario
        │     becoming real — not speculative.
        │
        ├─► IF THEY ASK "CAN YOU CACHE THE BLOOMREACH CALLS?"
        │     Partial — McpClient already caches per-call by
        │     (toolName, args) in-process. Doesn't help across
        │     instances. A shared cache (Redis) would. That's
        │     a real lever; it costs an external dependency I
        │     don't currently take.
        │
        └─► IF THEY ASK "WHAT'S YOUR ALERTING STRATEGY?"
              I don't have one. The honest answer — see the
              "I don't know" box below.
```

  ## When you don't know

The pressure point on this chapter is operational observability — alerting, SLOs, on-call dashboards. You did not build any of that. You logged token usage and wrote tests. The interviewer will sniff this and push.

```
  ╔═══════════════════════════════════════════════════════════════╗
  ║ WHEN YOU DON'T KNOW                                           ║
  ║                                                               ║
  ║   They ask: "What's your alerting strategy when one of these  ║
  ║   bottlenecks bites in production? What's your SLO?"          ║
  ║                                                               ║
  ║   You have structured logging — `res.usage` is logged at      ║
  ║   `lib/agents/aptkit-adapters.ts:60,65`. You have no alerts,  ║
  ║   no dashboards, no SLO. This is a one-warm-instance demo,    ║
  ║   not a production SRE surface.                               ║
  ║                                                               ║
  ║   Say:                                                        ║
  ║   "I have structured logging — every agent turn logs token    ║
  ║    usage and MCP retries, and the route handlers log error    ║
  ║    events through the same NDJSON channel they stream to      ║
  ║    the UI. What I have not built is the layer above that:     ║
  ║    alerts, SLOs, on-call dashboards. The honest framing is    ║
  ║    this is a demo + dev tool today; the trigger to invest in  ║
  ║    observability is the first real user where downtime        ║
  ║    matters. If you wanted to walk through what I'd build,     ║
  ║    I'd start with p95 briefing duration as the first SLO and  ║
  ║    retry counts as the leading indicator."                    ║
  ║                                                               ║
  ║   What this signals: you have the building blocks (logs);     ║
  ║   you have a sense of what would be load-bearing first        ║
  ║   (p95 briefing, retries); you're honest about what you       ║
  ║   haven't built. Senior signal.                               ║
  ║                                                               ║
  ║   Do NOT say:                                                 ║
  ║   "I'd use Datadog and set up some dashboards..." — generic   ║
  ║   "I'd use X" answers signal you haven't actually thought     ║
  ║   about what to measure. Always lead with the metric, not     ║
  ║   the tool.                                                   ║
  ╚═══════════════════════════════════════════════════════════════╝
```

  ## What you'd change

If you were redoing the scale story today, the one change you'd reach for first is **adding a real cancellation chain from `/api/briefing` through the adapter into `BloomreachDataSource.callTool`** — so a user who navigates away mid-briefing frees the rate-limit slot they were holding. Today the route handler returns and the UI tears down, but the in-flight tool call against Bloomreach finishes anyway. At one user this is wasted compute; at ten concurrent users it's a third of your rate-limit budget burning on requests no one will read. The fix is plumbing one `AbortController` through the layers — you know what to do; you haven't done it.

  ## One-page summary

**Core claim:** scale fails on a *different* axis depending on the scenario. Knowing the order — not just the parts — is the senior signal. The first bottleneck for live users is Bloomreach's rate-limit budget, not your code. The first bottleneck for persisted state is in-memory heap. The first bottleneck for verbose agents is `maxDuration`.

**Questions covered:**
- *10× concurrent users?* → Bloomreach rate limit first; cross-instance state second; model spend third. Measure p95 briefing, MCP retries, not-found counts.
- *100× persisted insights?* → in-memory heap first; cold-start rebuild second; NDJSON payload third. Measure V8 heap, time-to-first-event.
- *10× tool calls per briefing?* → run-duration vs `maxDuration` first; user patience second; superlinear token spend third. Measure tool calls per run, retry counts, wall-clock duration.
- *Alerting?* → I have structured logging; I haven't built the alerting layer. Trigger is the first user where downtime matters.

**Pull quotes:**
```
┃ "The first bottleneck isn't in my app. It's at the
┃  Bloomreach boundary — one bucket, all my live traffic."
```
```
┃ "In-memory is fine until you want history. The trigger
┃  to add a database is the day 'persisted briefing'
┃  becomes a user request."
```

**What you'd change:** plumb a proper `AbortController` chain through the route → adapter → DataSource so a cancelled briefing frees its Bloomreach rate-limit slot.
