# Chapter 4 — The Scale Story

When an interviewer asks "what breaks first at 10x?" they are not asking you to recite a horizontal-scaling playbook. They are watching whether you know where YOUR system's load actually lands. The wrong move here is to start naming Redis and Kafka and read replicas — because in this system the first thing that breaks at 10x is none of those. It is a rate limit you do not own, on a server you do not run. The strong move is to point straight at it, prove you measured it, and only then walk to the infrastructure you would add. You will get more credit for "the ceiling is upstream of my code, here is exactly where" than for a tour of components you have not wired in.

So before anything else, internalize the shape of the load. This is the sequence of what breaks, in order, as you turn up users, data, and latency-sensitivity:

```
┌ BLOOMING INSIGHTS — WHAT BREAKS FIRST, IN ORDER ────────────────────────────┐
│                                                                              │
│  TURN UP USERS ──────────────────────────────────────────────────────────► │
│   1x          10x                         100x                               │
│   │            │                            │                                │
│   ▼            ▼                            ▼                                 │
│  fine    ┌───────────────┐          ┌──────────────────┐                     │
│          │ #1 Bloomreach │          │ #2 in-memory     │                     │
│          │ ~1 req/s PER  │          │ state is PER-    │                     │
│          │ USER + token  │          │ INSTANCE (warm   │                     │
│          │ revocation    │          │ cache; cold      │                     │
│          │ (NOT my code) │          │ start re-boots)  │                     │
│          └───────────────┘          └──────────────────┘                     │
│                                                                              │
│  TURN UP DATA ───────────────────────────────────────────────────────────► │
│   1x ───────────────────────────────────────────────► 100x                  │
│   │  EQL runs server-side at Bloomreach. 90d-vs-prior-90d +                  │
│   │  maxToolCalls budget bound the work REGARDLESS of dataset size.          │
│   ▼  What grows: query latency under ~1.1s spacing. Wall: 300s function cap. │
│                                                                              │
│  TURN UP LATENCY-SENSITIVITY ────────────────────────────────────────────► │
│   │  NDJSON stream → user sees the trace immediately (perceived-latency win) │
│   ▼  Hard wall: ~1.1s inter-call spacing × tool-call count, then 300s ceiling│
│      60s TTL cache absorbs repeats.                                          │
│                                                                              │
│  ── DEMO PATH (?demo=cached): static snapshot, no auth, no MCP → scales      │
│     trivially. The reliable presentation path. ──────────────────────────── │
└──────────────────────────────────────────────────────────────────────────────┘
```

Everything in this chapter is a walk through that picture: three scenarios, each with a first bottleneck, a second, what you add and when, and how you measure it. Notice up front that two of the three first-bottlenecks live at Bloomreach, not in your code — that is the honest center of the story, and the place an interviewer will respect you for going first.

---

## Scenario 1 — 10x users (concurrency)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ "What breaks first if 10x more analysts hit this at once?"                     │
│ → Do you know whether your ceiling is your code, your platform, or the upstream│
│   API — and can you tell them apart?                                           │
└──────────────────────────────────────────────────────────────────────────────┘
```

The first thing that breaks is not mine, and I lead with that. The hard ceiling is Bloomreach's loomi MCP server: it rate-limits roughly **one request per second, per user**, and on the alpha endpoint it **revokes tokens after a few minutes**. My Vercel functions can fan out as wide as Vercel lets them — serverless concurrency is genuinely fine, each request gets its own function instance. But every live briefing or investigation is a chain of MCP tool calls, and each chain is paced at `minIntervalMs: 1100` in `lib/mcp/connect.ts` (line 92) precisely because that per-user window is the real constraint. Ten analysts, ten independent token sets, ten independent ~1 req/s budgets — that part scales linearly. What does not scale is a single analyst trying to go faster: their work is serialized behind that spacing, and no amount of my own concurrency fixes a per-user upstream limit.

The second thing that breaks is mine, and I own it cleanly — the broader per-instance state story. The concurrent-user wipe bug I had at an earlier scale (a global `Map<id, Insight>` plus `putInsights.clear()` at the top of every briefing write) is **resolved**: `lib/state/insights.ts` is now `Map<sessionId, SessionFeed>` and the outer map is never cleared by a request, so concurrent users on one warm instance don't wipe each other any more. What remains, the next-bottleneck story, is cross-instance: the 60s response cache lives inside one `BloomreachDataSource` instance (the `cache` Map at `lib/data-source/bloomreach-data-source.ts:122`), cached investigations live in a module-level `Map` in `lib/state/investigations.ts`, a cold start re-bootstraps the schema from scratch, and two requests on different instances share nothing. I already worked around the cross-instance piece for the feed→investigate handoff — an investigation's source insight is handed to the agent route through the URL (`?insight=`), parsed in `resolveAnomaly`, *because* I knew in-memory state wouldn't survive Vercel's per-instance memory between the feed and the investigate page. That is a band-aid, not a store.

So at multi-user scale, here is what I add and when. The trigger is "more than one instance needs to see the same investigation" — which is the moment I leave a single warm instance. I add a **shared cache (Redis)** to replace the per-instance 60s Map, and a **persistent investigation store** (Redis or a small Postgres) to replace `lib/state/investigations.ts` and the `?insight=` hand-off. I would also move the OAuth PKCE state and tokens out of the encrypted `bi_auth` cookie into that shared store — the code comment in `lib/mcp/connect.ts` (lines 11-14) already names this as the likely production fix, because the connect request and the callback request can land on different ephemeral instances.

How I measure whether I need it yet: I instrument cold-start rate (cold starts re-bootstrap the schema, which is the expensive part) and cache-hit ratio on the `McpClient` Map. If cold starts are rare and hit-ratio is high, per-instance state is fine and I do not add Redis — adding a shared store before the data says I need it just buys me a new network dependency and a new failure surface for no win.

> ▸ The ceiling at 10x users is Bloomreach's ~1 req/s-per-user limit and token revocation, not my serverless concurrency.

> ▸ My in-memory state is per-instance by design today; the moment two instances must agree on one investigation, I add Redis — not before.

**Strong vs. weak — when they ask "how do you scale to more users":**

```
┌─────────────────────────────────────┬─────────────────────────────────────┐
│ WEAK                                 │ STRONG                               │
├─────────────────────────────────────┼─────────────────────────────────────┤
│ "I'd add Redis, a load balancer,     │ "The first ceiling is Bloomreach's   │
│  and horizontal autoscaling for      │  ~1 req/s per-user limit and token   │
│  scalability."                       │  revocation — upstream of my code.   │
│                                      │  Vercel concurrency is fine. My own  │
│                                      │  bottleneck is per-instance in-memory│
│                                      │  state; I'd add Redis the moment two │
│                                      │  instances must share one            │
│                                      │  investigation."                     │
├─────────────────────────────────────┼─────────────────────────────────────┤
│ Why it's weak: names components      │ Why it works: tells them apart —     │
│ without locating the load. Can't     │ upstream limit vs. platform vs. my   │
│ tell upstream limit from own code.   │ code — and ties each fix to a        │
│ Sounds rehearsed, not measured.      │ trigger I can measure.               │
└─────────────────────────────────────┴─────────────────────────────────────┘
```

Follow-up decision tree for this scenario:

```
"10x users" answered
        │
        ▼
   ├─► IF THEY ASK "so the demo path scales fine?"
   │     Yes — and that's deliberate. ?demo=cached replays a committed
   │     snapshot (lib/state/demo-insights.json) as a paced NDJSON stream
   │     (REPLAY_DELAY_MS=140 in app/api/briefing/route.ts). No auth, no MCP,
   │     no per-user limit. It scales like any static file read. It's the
   │     reliable presentation path precisely BECAUSE it touches none of the
   │     bottlenecks I just named.
   │
   ├─► IF THEY ASK "why didn't you just add Redis from the start?"
   │     No data told me to. A single warm instance with a 60s cache serves
   │     the demo and a single analyst's live session fine. Adding a shared
   │     store before I'm multi-instance buys a network hop and a new failure
   │     surface for zero measured win. I named the trigger; I'd add it then.
   │
   └─► IF THEY ASK "what about 10,000 concurrent users with multi-region
         failover?"  → see the "I don't know" box below. I have NOT built
         horizontal-scale infra. I say so, then name what I'd add and how
         I'd measure — I do not improvise a distributed design I can't defend.
```

---

## Scenario 2 — 100x data

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ "What happens when the workspace has 100x the events?"                         │
│ → Does your work grow with the dataset, or did you bound it on purpose?         │
└──────────────────────────────────────────────────────────────────────────────┘
```

This is the scenario where the design actually holds up, and I say so plainly: **100x data barely moves my system, because I never pull the data into my process.** The EQL queries run server-side at Bloomreach — I call `execute_analytics_eql`, Bloomreach scans its own warehouse, and I get back small aggregates like `{ current: 42000, prior: 51500 }`. The monitoring method is period-over-period on 90-day windows — current 90d vs prior 90d, derived from a 90d and a 180d query (the recipe is spelled out in `lib/agents/prompts/monitoring.md`, lines 22-27). That returns counts and sums, not rows. Whether the workspace has a million events or a hundred million, the aggregate I get back is the same handful of numbers.

The second bound is the agent's tool-call budget. `runAgentLoop` in `lib/agents/base.ts` enforces a `maxToolCalls` cap and, once it is spent, forces a final synthesis turn (line 90-91: `budgetSpent`, and the forced-final logic). Monitoring is capped at 6 calls (`lib/agents/monitoring.ts` line 101), diagnostic at 6, query at 6, recommendation at 4. So the total work per run is bounded by a constant number of bounded-size queries — it does not grow with the dataset at all. The schema summary I feed the model is also capped: top 20 events, 10 properties each, 30 customer properties (`schemaSummary` in `lib/agents/monitoring.ts`, lines 24-35), so even a workspace with thousands of event types does not blow up my prompt.

What actually grows with 100x data is **query latency at Bloomreach** — a count over a much larger table takes longer to come back — and that latency is paid serially under my ~1.1s spacing. The wall is the **300s function ceiling** (`maxDuration = 300` in both `app/api/briefing/route.ts` line 17 and `app/api/agent/route.ts` line 20). A live investigation already runs ~100-115s under the rate limit (per the comment in the agent route, lines 18-19); if each underlying EQL got several times slower on a huge dataset, a single run could approach that 300s cap.

What I would add, and when: if query latency on big workspaces pushed runs toward 300s, I would not try to make my loop faster — the spacing is fixed by the upstream limit. I would **shrink the number of calls or pre-aggregate.** Concretely: cache the schema bootstrap (it is the same per workspace and gets re-read every cold start), and lean harder on the 60s response cache so a repeated category check is free. How I measure: p50/p95 of total EQL round-trip latency per call, and total calls per run. If p95 round-trip times the call count creeps toward 300s, that is my signal to cut calls, not to add infrastructure.

> ┃ "100x data barely moves me because EQL runs at Bloomreach — I get aggregates back, not rows, and a fixed tool-call budget caps the work regardless of dataset size."

---

## Scenario 3 — 10x latency-sensitive requests

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ "What if these requests become latency-sensitive — users won't wait?"          │
│ → Did you design for perceived latency, and do you know your real wall-clock     │
│   ceiling?                                                                       │
└──────────────────────────────────────────────────────────────────────────────┘
```

I separate two things here, because interviewers conflate them and I want to show I do not: **perceived latency** and **wall-clock latency.** I already won the perceived-latency fight by design. The whole system streams its reasoning as NDJSON over a `ReadableStream` — the briefing and agent routes enqueue events line by line (consumed by `lib/streaming/ndjson.ts:readNdjson` in the browser, a shared kernel across all 4 streaming surfaces, not EventSource). The user sees "reading the workspace schema…", then each category resolving, then the live EQL queries, *as they happen.* Time-to-first-token is a few hundred milliseconds. Nobody stares at a spinner for two minutes; they watch an analyst think. That is the single biggest latency lever and it is already pulled.

The wall-clock ceiling is the honest other half — and only on the Bloomreach path. A full live-bloomreach run is **~1.1s inter-call spacing × number of tool calls**, plus model time per turn, capped by the **300s function limit.** That is why the tool-call budgets are low — they are not just about cost, they bound latency. The 60s TTL cache (`lib/data-source/bloomreach-data-source.ts:122`, post-Phase-2 PR A rename) absorbs repeats: if two analysts check the same category inside a minute, the second pays zero. Critically, the cache does the right thing under load — it is **never written on an error** (an `isError` result returns without caching), so a transient 429 during a burst can never poison the cache and serve a stale error to the next caller. On the `live-synthetic` path there's no rate limit and no network — calls are in-process function calls — so wall-clock latency there is essentially the model time only.

The piece of "model time" I would flag honestly if pushed on cost: AptKit's runtime now logs `res.usage` on every model call (`lib/agents/aptkit-adapters.ts:60,65` in the `AnthropicModelProviderAdapter`), so I do have the per-call number for the migrated active path. What I do *not* have is a per-investigation roll-up or a budget threshold; I can quote the meter but I haven't built the aggregation that would let me set a soft cost cap.

What I would add at 10x latency-sensitive load, and when: the first move is to make the cache shared (Scenario 1's Redis), so the 60s absorb-repeats win spans instances instead of one warm box. The trigger is the same — multi-instance traffic. Beyond that, for truly latency-bound use I would pre-compute briefings on a schedule rather than on-demand, so the common-case read is a snapshot replay (which already scales trivially, like the demo path) and only genuinely-fresh investigations pay the live cost.

How I measure: **p50 and p95 of a full briefing run, and the tool-call count per run.** Those two numbers together tell me everything — if p95 is creeping up, I look at whether it is more calls (cut the budget or pre-aggregate) or slower calls (Bloomreach-side, which I cannot fix, so I cache harder). I would also track time-to-first-event separately from total time, because the streaming design means those can diverge a lot and the first one is what users actually feel.

> ▸ Perceived latency is already solved by NDJSON streaming; the wall-clock ceiling is ~1.1s × call-count under the 300s cap, and I measure both p50/p95 and call-count.

Follow-up decision tree for latency:

```
"latency" answered
        │
        ▼
   ├─► IF THEY ASK "why NDJSON over a reader loop and not Server-Sent Events?"
   │     SSE (EventSource) is GET-only and reconnects on its own, which fights
   │     my one-shot reconnect guard. A fetch + ReadableStream reader gives me
   │     full control of the request and a plain newline-delimited JSON contract
   │     (lib/mcp/events.ts). I parse line by line; the client routes any
   │     non-NDJSON body down a plain-JSON fallback, so a malformed stream still
   │     degrades instead of hanging.
   │
   ├─► IF THEY ASK "isn't 300s a long time to hold a function open?"
   │     Yes — that's Vercel Pro's max and it's a real cost. I set it because a
   │     live investigation needs ~100-115s under the rate limit and Hobby's 60s
   │     can't fit it. The streaming design means the user isn't blocked the
   │     whole time; they're reading the trace. The fix for chronic long runs is
   │     pre-computed briefings, not a bigger timeout.
   │
   └─► IF THEY ASK "what's your p95 right now?"
         I haven't run this under sustained load, so I don't have a measured p95
         to quote — see the "I don't know" box. I know the components of the
         number (spacing × calls + model time) and I know which metrics I'd
         capture. I won't invent a figure.
```

---

## The honest center: horizontal scale I have not built

This is the part of the chapter where you will get pushed past your depth, and the whole credibility of everything above depends on how you handle it. You have not built at horizontal scale. Do not let the strong answers in Scenarios 1-3 tempt you into improvising a multi-region distributed design when they push. Stop at the edge of what you have built and name it.

```
╔══════════════════════════════════════════════════════════════════════════════╗
║ "I DON'T KNOW" RECOVERY — horizontal scale / multi-region failover             ║
║                                                                                ║
║ THE PUSHBACK: "Okay, run this for 10,000 concurrent users across three         ║
║   regions with automatic failover. Walk me through the architecture."          ║
║                                                                                ║
║ SAY: "I haven't built at horizontal scale — no multi-region replication, no    ║
║   hot-path queue infra, no load balancing under sustained traffic. So I'm not  ║
║   going to invent a design I can't defend. What I CAN do is tell you where my  ║
║   current system would break first and what I'd reach for: the per-instance    ║
║   in-memory state goes to a shared store (Redis) the moment I'm multi-instance;║
║   the OAuth tokens move out of the cookie into that store; and because the     ║
║   real ceiling is Bloomreach's per-user rate limit, the scaling question is    ║
║   really 'how many independent user-token budgets do I have,' not 'how big is  ║
║   my fleet.' For the failover and multi-region piece specifically, I'd want to ║
║   pair with someone who's run it — I'd be learning, and I'd measure before I   ║
║   committed to a topology."                                                    ║
║                                                                                ║
║ WHAT THIS SIGNALS: you know the boundary of your own experience and you don't  ║
║   bluff across it. You redirect to the part you CAN reason about (your own     ║
║   bottlenecks, the upstream limit) instead of freezing. Senior interviewers    ║
║   read this as trustworthy — they now believe everything you DID claim.        ║
║                                                                                ║
║ DO NOT SAY: "I'd just add a load balancer and autoscaling group and shard the  ║
║   database across regions with eventual consistency." You'd be reciting words  ║
║   for a system you've never operated. The next question ("how do you handle a  ║
║   split-brain during a region failover?") ends the bluff in one move, and now  ║
║   they doubt the answers you actually earned.                                   ║
╚══════════════════════════════════════════════════════════════════════════════╝
```

> ┃ "I haven't run this at horizontal scale, so I won't invent a topology I can't defend — but I can tell you exactly where it breaks and what I'd measure before I added anything."

---

## What you'd change

If I were taking this past a demo and toward real multi-instance load, the change I'd lift first is the same one I named last refresh and have already half-done: the 60s cache, the cached investigations, and the OAuth PKCE/token state all survive only inside one warm instance, and I'm already routing an insight through the URL because I knew that. I would put a shared store (Redis to start) behind the cache and the investigation store, and move the auth state there too, which would also let me re-enable the CSRF `state` validation that is written and tested but currently unwired (`consumeState` in `lib/mcp/auth.ts`) because the SDK calls `state()` multiple times per flow and a shared store could track issued states properly. The cheap correctness fix from a previous refresh — session-keying `lib/state/insights.ts` — has shipped (`Map<sessionId, SessionFeed>`), so the concurrent-user wipe bug is no longer on this list. What I would NOT change preemptively is anything to fight the upstream rate limit — that is Bloomreach's number, not mine, and the right response is more independent user budgets and harder caching, not a faster loop.

---

## Summary — Chapter 4

**Core claim:** At 10x the first ceiling is upstream (Bloomreach's ~1 req/s-per-user limit + token revocation), my own first bottleneck is per-instance in-memory state (and the concurrent-user wipe bug has shipped its fix), and I have not built horizontal-scale infra — I know exactly where it breaks and what I'd measure before adding anything.

**Questions covered:**
- *What breaks first at 10x users?* — Bloomreach's per-user rate limit + token revocation (not my code); then the broader per-instance cache/investigation state (cross-instance, not same-instance — the same-instance concurrent-user wipe was fixed by session-keying `lib/state/insights.ts`), addressed by Redis when I go multi-instance.
- *What happens at 100x data?* — Almost nothing: EQL runs at Bloomreach, I get aggregates not rows, and the maxToolCalls budget bounds work regardless of size. Cost is query latency under the 300s cap.
- *What about 10x latency-sensitive requests?* — Perceived latency is already solved by NDJSON streaming (shared `readNdjson` kernel); wall-clock ceiling on the Bloomreach path is ~1.1s × call-count under 300s; the 60s cache (now in `bloomreach-data-source.ts:122`) absorbs repeats. Live-synthetic path has no rate-limit ceiling at all. Measure p50/p95 and call-count.
- *10,000 users, multi-region failover?* — Haven't built it; name the bottleneck, the shared-store fix, and that the scaling unit is independent user-token budgets — don't improvise a topology.

**Pull quotes:**
- "The ceiling at 10x users is Bloomreach's ~1 req/s-per-user limit and token revocation, not my serverless concurrency."
- "100x data barely moves me because EQL runs at Bloomreach — I get aggregates back, not rows, and a fixed tool-call budget caps the work."
- "Perceived latency is already solved by NDJSON streaming; the wall-clock ceiling on the Bloomreach path is ~1.1s × call-count under the 300s cap."
- "I haven't run this at horizontal scale, so I won't invent a topology I can't defend — but I can tell you exactly where it breaks."
- "The concurrent-user wipe bug from a previous refresh has shipped its fix: `Map<sessionId, SessionFeed>` in `lib/state/insights.ts`. The next bottleneck is cross-instance, not same-instance."

**What you'd change:** Lift state (cache, investigations, OAuth tokens) out of per-instance memory into a shared store (Redis to start) when I go multi-instance — this would also let me re-enable the written-but-unwired CSRF `state` validation in `lib/mcp/auth.ts:consumeState`. Don't build anything to fight the upstream rate limit — that number isn't mine.

---
Updated: 2026-05-29 — created
Updated: 2026-06-02 — Added the CRITICAL `lib/state/insights.ts` race condition (global Map + `putInsights.clear()` wipes concurrent users on one warm instance) per study-system-design audit's red-flags finding; sharpened the "second bottleneck" framing from cross-instance-only to also include same-instance concurrent-user wipe; promoted the ~30 LOC session-key fix to the "what you'd change" lead. Added one sentence on `synthesize()` as the suspected unmeasured cost concentration (per study-performance-engineering) so the cost question has an honest "I haven't metered it" answer ready.
Updated: 2026-06-20 — insights.ts concurrent-user wipe bug is RESOLVED (session-keyed Map<sessionId, SessionFeed> shipped) — removed the "smallest correctness bug at any current scale" framing and replaced with "previous bug fixed, broader cross-instance story remains." McpClient cache reference relocated to lib/data-source/bloomreach-data-source.ts:122 (Phase 2 PR A rename). res.usage logging gap framing updated: AptKit's runtime now logs at lib/agents/aptkit-adapters.ts:60,65; what's missing is the per-investigation roll-up + cost budget. Synthetic adapter named as the "no rate limit, no network, no wall-clock ceiling beyond model time" path.
