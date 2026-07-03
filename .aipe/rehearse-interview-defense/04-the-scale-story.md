# Chapter 4 — The scale story

  ## Opening hook

Scale rounds are the round where junior candidates fold and senior candidates shine. The junior answer sounds like "well, at scale you'd add a load balancer and a Redis cache and probably shard the database." No numbers. No first bottleneck named. No trigger to reconsider. The senior answer names the specific first thing that breaks, at what specific load, and how you'd measure to know.

This chapter walks three scale scenarios for blooming insights: 10× users, 100× investigations, and 10× peak QPS. For each, the first bottleneck, the second bottleneck, what you'd add when, and how you'd measure. Real numbers throughout — from the baseline eval, run at `2026-07-03T04-08-28-644Z`, ten cases.

  ## The chapter-opening diagram

Here's the scale-bottleneck chart. X-axis is load; each row names what breaks first as that dimension grows.

```
  What breaks first — the scale-bottleneck chart

  Load dimension       At 10×                       At 100×
  ──────────────       ─────                        ──────
                       │                            │
  Users                │  session Map<sess, feed>   │  route-instance
  (concurrent)         │  → warm-instance memory    │  → sticky sessions
                       │  gets crowded              │    can't work
                       │  TRIGGER: multi-instance   │  TRIGGER: durable
                       │  deploy                    │  session store
                       ▼                            ▼
                       ────────────────────────────────
                       │                            │
  Investigations       │  per-investigation cost    │  Anthropic
  (per day)            │  ~$0.09 → ~$0.90/user/day  │  rate-limit
                       │  BudgetTracker ceilings    │  → queue + retry
                       │  hold                      │  → provider fanout
                       │  TRIGGER: budget over-run  │  TRIGGER: 429 rate
                       ▼                            ▼
                       ────────────────────────────────
                       │                            │
  Peak QPS             │  MCP server rate limit     │  Vercel function
                       │  (~1 req/s upstream)       │  concurrency cap
                       │  → per-tenant queue        │  → move to
                       │  → tool call batching      │    dedicated
                       │  TRIGGER: 429 from loomi   │    infrastructure
                       ▼                            ▼
                       ────────────────────────────────

  Baseline numbers (2026-07-03T04-08-28-644Z, N=10)
  ────────────────────────────────────────────────
    Per-phase p50 latency:
      diagnose 50s · d-judge 38s · recommend 51s · r-judge 90s
      total 225s per case
    Per-case avg cost (agent-side, cached):
      ~$0.09
    Total 10-case run:
      $0.913 agent + ~$0.40 judge ≈ $1.30
```

Real numbers. All three scenarios below key off this baseline. The diagram is the visual anchor; the scenarios below are the walkthroughs.

  ## Scenario 1 — 10× users

┌─────────────────────────────────────────────────┐
│ THEY ASK                                        │
│   "What breaks first when you go from your      │
│   current user count to 10× that?"              │
│                                                 │
│ WHAT THEY'RE TESTING                            │
│   Do you know where state lives in your         │
│   system? Do you know which parts don't scale   │
│   horizontally? Can you name the trigger to     │
│   reconsider without hedging?                   │
└─────────────────────────────────────────────────┘

Say this:

> *"The first thing that breaks is the session map. State lives in `lib/state/insights.ts` as a `Map<sessionId, SessionFeed>` — session-keyed since I fixed the concurrent-user wipe. That map is warm-instance memory on a Vercel Function.*
>
> *At single-instance scale, the map holds hundreds of active sessions no problem. At 10× users I'm still probably fine on a warm instance — the map's overhead per session is a handful of objects. What actually breaks first is not memory, it's routing. Vercel Functions can cold-start on any instance; a user who investigates on instance A and comes back on instance B has an empty feed. Today I get lucky because instances stay warm for a few minutes, but 10× users means 10× the chance a request lands on a cold instance.*
>
> *The trigger to reconsider is a multi-instance deploy. The move is a durable session store — either Vercel KV, or Upstash Redis, or a Postgres row keyed on session. My storage abstraction — the DataSource port — makes the swap manageable, but session state is not behind that port today. It's in-process. That's the piece I'd move first.*
>
> *The second thing that breaks, further out, is auth store contention. The encrypted-cookie OAuth store I have in `lib/mcp/auth.ts` is fine per-user, but at high enough concurrency the AES-256-GCM overhead on every route entry adds up. At 100× users I'd cache the decrypted client per-request via `AsyncLocalStorage` more aggressively than I do now.*
>
> *How I'd measure to know: the semaphore load harness in `eval/load.eval.ts` is written but I've only smoke-tested at N=2 and N=3. A real run at N=30 with concurrency 5 costs about $2.50 in API spend and would give me actual p95 numbers under load. That's the next real experiment."*

┌─────────────────────────┬─────────────────────────┐
│ WEAK ANSWER             │ STRONG ANSWER           │
├─────────────────────────┼─────────────────────────┤
│ "I'd add a Redis cache  │ "The first thing that   │
│ and scale horizontally  │ breaks is the session   │
│ with a load balancer.   │ Map in lib/state/       │
│ Probably shard the      │ insights.ts. It's warm- │
│ database if it got      │ instance memory. The    │
│ really big. Add some    │ trigger is multi-       │
│ monitoring."            │ instance deploy. Move   │
│                         │ session state to Vercel │
│                         │ KV or Redis. My         │
│                         │ semaphore harness is    │
│                         │ written but I've only   │
│                         │ smoke-tested at N=2 —   │
│                         │ real p95 under load is  │
│                         │ my next experiment."    │
├─────────────────────────┼─────────────────────────┤
│ Why it's weak:          │ Why it works:           │
│ Textbook words with no  │ Points at the actual    │
│ system anchor. No file  │ file where state lives. │
│ named. No trigger.      │ Names the trigger.      │
│ "Probably shard the     │ Names the fix. Names    │
│ database" — there is    │ the measurement gap     │
│ no database. That       │ (only smoke tests) and  │
│ answer isn't about      │ the plan to close it.   │
│ THIS system.            │                         │
└─────────────────────────┴─────────────────────────┘

┃ "The trigger to reconsider is more valuable
┃  than the abstract 'at scale' answer. Interviewers
┃  hire people who know when they'd change their mind."

  ## Scenario 2 — 100× investigations per day

┌─────────────────────────────────────────────────┐
│ THEY ASK                                        │
│   "What happens if you go from your current      │
│   investigation volume to 100× that?"           │
│                                                 │
│ WHAT THEY'RE TESTING                            │
│   Do you know your unit economics? Can you      │
│   name the cost per investigation? Have you     │
│   thought about rate limits at the provider?    │
└─────────────────────────────────────────────────┘

Say this:

> *"The unit economics are what I'd walk first. A full investigation — diagnose plus recommend — averages about 9 cents in Anthropic spend today with prompt caching on. At 100× investigations, that's a real budget question. My `BudgetTracker` in `lib/agents/budget.ts` holds per-investigation ceilings; it does not hold a per-user-per-day ceiling. At 100× I'd add that.*
>
> *The second thing that breaks is Anthropic rate limits. Right now a single investigation makes a handful of model calls; at 100× concurrent investigations I'll hit the tier's tokens-per-minute cap. The fix is a queue in front of the agent runs — investigations become jobs, not synchronous requests. That's a bigger architectural move — it kills the Vercel-function shape for `/api/agent`. I'd move to a background worker with a durable queue. Client polls or reconnects to a status stream.*
>
> *The third thing, further out: MCP server rate limit. Bloomreach loomi-connect is documented as rate-limited around 1 request per second. My `McpClient` in `lib/mcp/client.ts` already implements retry with backoff. At 100× investigation volume I'm going to be pushing hard against that ceiling. The fix, if I couldn't get a higher tier, is per-tenant queuing on my side so I don't spike upstream.*
>
> *How I'd measure to know: the receipts I already emit via `onCapabilityEvent` include tokens and latency per phase. `eval/report.eval.ts` reads them back into p50/p95/p99. What I don't have is production telemetry — I'd add a real trace sink writing to something like Vercel Analytics or an OTel collector before I scaled to 100× actual investigations."*

The move: three named bottlenecks in order of when they hit. The first is cost. The second is provider rate limit. The third is upstream rate limit. Each has a fix. Each has an axis you'd measure on.

  ## Scenario 3 — 10× peak QPS

┌─────────────────────────────────────────────────┐
│ THEY ASK                                        │
│   "You've got a briefing-load pattern where       │
│   everyone opens the app on Monday morning.      │
│   10× peak QPS. What happens?"                  │
│                                                 │
│ WHAT THEY'RE TESTING                            │
│   Do you know the difference between average    │
│   and peak load? Can you talk about backpressure │
│   and queueing without hand-waving?             │
└─────────────────────────────────────────────────┘

Say this:

> *"Peak QPS is the interesting one because blooming insights has an asymmetric load shape. Briefings are cheap-ish — a monitoring pass with a handful of tool calls. Investigations are expensive — 50 to 100 seconds on the diagnose phase alone.*
>
> *At 10× peak briefing load, the immediate failure surface is the MCP server. loomi-connect is documented around 1 req/s per client. Even with `McpClient`'s rate-limit retry, a burst of 100 briefings starting simultaneously all queue up upstream. The fix in-flight is that each briefing gets its own 30-second per-call timeout composed with the 300-second route budget — a briefing that can't get its tool calls through fails cleanly with a graceful NDJSON error event rather than hanging forever.*
>
> *That's what the system does today, not what I'd add. What I'd add: pre-computed briefings. A briefing scan is not that time-sensitive — a metric anomaly from an hour ago is still an anomaly. I'd background the monitoring pass on a cron, cache the result per workspace, and serve `/api/briefing` from the cache. The demo path already does this — `?demo=cached` serves a committed snapshot. Extending that to a real cached-briefing pattern turns peak QPS from a live-agent problem into a static-serving problem.*
>
> *The second bottleneck at 10× peak QPS is Vercel Function concurrency. Each function invocation has a cap. At high enough concurrent QPS, cold starts multiply and p95 latency degrades. The move is either function warming, higher-tier concurrency, or moving off Vercel Functions to a dedicated container. The trigger for that is when p95 crosses whatever SLA I'm committing to — I don't have one today because I don't have paying customers yet.*
>
> *How I'd measure to know: I'd need real production traffic, not synthetic load. The load harness gives me function-level numbers; peak-shape numbers require actual users. That's the honest answer — I can prep the system, but the measurement waits for real usage."*

  ## The follow-up decision tree

Scale questions have deep branches. Here's what interviewers usually pick after your first answer:

```
  You name the first bottleneck (the session Map).
        │
        ▼
  ┌─► "How would you migrate the session state
  │    without downtime?"
  │      They're testing your migration thinking.
  │      Answer: dual-write — new writes go to both
  │      the Map and the durable store. Reads fall
  │      back Map → durable. Once all sessions expire
  │      (a few minutes on this app), Map is dead code.
  │      Remove the Map. That's the seam paying off —
  │      caller code touches neither store directly.
  │
  ├─► "What's the actual memory footprint of that
  │    Map? Do you know?"
  │      Honest answer: I don't have production
  │      numbers. Per-session it's a SessionFeed with
  │      an Insights array — order of KB per session,
  │      not MB. But that's an estimate, not a
  │      measurement. If you want a measurement I'd
  │      run the harness with a memory profiler
  │      attached.
  │
  ├─► "Wouldn't you just cache the briefing at CDN
  │    level?"
  │      Yes, that's the pre-computed briefing move
  │      I described. Cache-Control: s-maxage on the
  │      briefing route with the demo-snapshot path
  │      re-purposed as the cached path.
  │
  └─► "What about the recommendation phase — that's
       even more expensive. Can you cache that?"
        Harder. Recommendations depend on the specific
        diagnosis. I could cache recommendations by
        insight hash — same diagnosis input = same
        recommendation output — but that requires the
        diagnosis to be deterministic. LLM outputs
        aren't. The move is to memoize by hash and
        accept staleness, which is what production
        RAG systems do. I haven't built it.
```

  ## When you don't know

The territory where scale questions push past your depth is anything past "single-region, small-user-count Vercel deployment." Multi-region replication. Kafka fan-out. Global load balancing. You have not built these.

```
╔═══════════════════════════════════════════════╗
║ WHEN YOU DON'T KNOW                           ║
║                                               ║
║   They ask: "How would you handle multi-       ║
║   region failover? What's your RTO and RPO?"  ║
║                                               ║
║   You have not built a multi-region app.       ║
║   You've deployed to a single Vercel region.   ║
║                                               ║
║   Say:                                        ║
║   "I haven't built multi-region. The apps I    ║
║    have shipped have been single-region — the  ║
║    system-design work in my portfolio spans    ║
║    local-first mobile, on-device ML, and       ║
║    serverless web, all single-region. For      ║
║    blooming insights, the state I'd have to    ║
║    replicate is the session store I don't      ║
║    have yet — so multi-region genuinely isn't  ║
║    on the roadmap. If you want to walk me      ║
║    through how you'd think about RTO/RPO for   ║
║    a system like this, I'd take that as a      ║
║    coaching moment. What I do know is where    ║
║    the state boundaries in the system are —    ║
║    session, budget, eval baseline — so I can   ║
║    tell you what would need to replicate."     ║
║                                               ║
║   What this signals: honest gap named,         ║
║   portfolio scope acknowledged, willingness    ║
║   to learn in the room, and a concrete offer   ║
║   (naming state boundaries) that shows you     ║
║   can think through the shape without         ║
║   pretending to have shipped it.               ║
║                                               ║
║   Do NOT say:                                 ║
║   "I'd use active-active replication with       ║
║    consensus via Raft."                       ║
║   The moment you name a technology you         ║
║   haven't run, the next follow-up will        ║
║   expose it. Every time.                       ║
╚═══════════════════════════════════════════════╝
```

  ## What you'd change

If you were designing for scale from day one, the biggest change: extract the session store as a port from the beginning. Right now `Map<sessionId, SessionFeed>` is direct in `lib/state/insights.ts`. If it were behind a `SessionStore` port like `DataSource` is, the swap to a durable store would be a same-day change. Today it's a real refactor.

Second change: instrument tokens and latency from day one, not day 40. You added `onCapabilityEvent` in Phase 2 of the hardening plan. If it had been in place from the first agent, every eval and every real run would have receipts. The reason it wasn't from day one is that you didn't know AptKit's hooks existed yet — that's a defaulted-to decision, and the honest way to describe it is "I didn't evaluate observability at build time; I retrofitted it."

The three-scenario shape stays the same. What you'd add is more measurement earlier.

  ## The one-page summary

**Core claim.** Three scale scenarios, each with a first bottleneck, a trigger, and a measurement gap. The 10× users bottleneck is the session Map (trigger: multi-instance deploy). The 100× investigations bottleneck is Anthropic rate limits after unit-cost overrun (trigger: budget alert or 429). The 10× peak QPS bottleneck is the MCP server's 1 req/s rate limit (trigger: 429 upstream). Real p50 baseline: diagnose 50s, recommend 51s, total 225s per case, ~$0.09 per case.

**The questions covered.**

  → "What breaks first at 10× users?" → session Map in-process, trigger is multi-instance deploy, fix is durable session store.
  → "What about 100× investigations?" → cost first (need per-day budget ceiling), then Anthropic rate limits (queue), then MCP server rate limit (per-tenant queuing).
  → "10× peak QPS?" → MCP server rate limit hits first, briefings can be pre-computed and cached, investigations can't.
  → "Multi-region?" → haven't built. Portfolio is single-region. Honest gap named.

**The pull quote.**

  → *"The trigger to reconsider is more valuable than the abstract 'at scale' answer."*

**What you'd change.** Extract session store as a port from day one. Instrument tokens and latency from the first agent, not Phase 2 of hardening.
