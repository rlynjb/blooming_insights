# Performance red-flags audit

**Industry name(s):** perf risk register · ranked perf findings · audit report
**Type:** Industry standard · Language-agnostic

> Ten ranked performance risks for blooming insights, each with file:line evidence, the failure mode it would cause, and the cheapest fix. The top three are **the cost concentration on `synthesize()` (output-token heavy, unmeasured)**, **the complete absence of `res.usage` logging (Anthropic returns it free; nobody reads it)**, and **the 300s route budget pinned at the ceiling with zero headroom for retry storms**. Everything below the top three is either small in absolute terms or only relevant at a scale this codebase hasn't hit yet. Three honest `not yet exercised` notes — load testing, profiler integration, batching — close the file.

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** A perf audit is a *ranked* list, not an exhaustive one. The point isn't to enumerate every possible inefficiency — it's to name *which two or three* would actually move the needle, and *which others* are real but small. Below that, the list shades into "noted, not blocking" and "watch this if X changes." This file ranks blooming insights' performance risks by consequence × likelihood, with file:line evidence for each.

```
  Zoom out — the audit landscape          ← we are here (rank-by-consequence)

  ┌─ HIGH consequence × HIGH likelihood ──────────────────────┐
  │  R1: cost concentration on synthesize()                    │
  │  R2: no res.usage logging anywhere                         │
  │  R3: 300s route budget pinned at ceiling                   │
  └────────────────────────────────────────────────────────────┘
  ┌─ MEDIUM consequence × VARIABLE likelihood ────────────────┐
  │  R4: no prompt-prefix caching (Anthropic feature)          │
  │  R5: investigations Map grows monotonically                │
  │  R6: schema cache has no TTL                               │
  │  R7: no Web Vitals / time-to-first-event metric            │
  └────────────────────────────────────────────────────────────┘
  ┌─ LOW consequence × LOW likelihood (today) ────────────────┐
  │  R8: per-event setState not batched                        │
  │  R9: NDJSON event size sometimes large                     │
  │  R10: bootstrap chain serialized (4-6 calls)              │
  └────────────────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question is: *if you only had time to fix three things, which three, and what's the evidence for each?* The answer is: fix the meter first (R2 — `res.usage` logging), then the cost concentration it would reveal (R1 — `synthesize()`), then the headroom on the budget (R3 — route ceiling). Below, each risk gets a one-paragraph diagnosis with file:line evidence, the failure mode, the cheapest fix, and what the fix unblocks.

---

## Structure pass

**Layers.** Three risk bands by rank: top three (move the needle), middle four (real but smaller), bottom three (noted, not blocking today).

**Axis: consequence × likelihood.** Hold one question across every risk: *how much pain would this cause, and how likely is it to bite?* The right axis for an audit isn't "is this a bug" — it's "should we fix this now, later, or never." Cost (file 01) and visibility (file 02) sit one altitude up; this file is *prioritization*, which composes consequence with likelihood.

**Seams.** Two load-bearing.

- **A1: blind ↔ measured.** The top three risks all hinge on the same blindness — no `res.usage`, no per-investigation summary, no histograms. Fix the meter and several risks become visibly bounded; leave it absent and every other risk is unbounded by ignorance.
- **A2: works-now ↔ breaks-later.** Several risks (R5, R6, R8) are *fine today* and would break *only* under conditions this codebase hasn't hit yet — higher event rates, longer-warm instances, schema mutability. The right call for those is "watch, don't fix" — but be specific about what triggers the watch.

```
  Structure pass — Audit ranking

  ┌─ 1. LAYERS ──────────────────────────────────────┐
  │  Top three · Middle four · Bottom three           │
  └────────────────────────┬─────────────────────────┘
                           │  pick the axis
  ┌─ 2. AXIS ─────────────▼──────────────────────────┐
  │  consequence × likelihood: rank by impact         │
  └────────────────────────┬─────────────────────────┘
                           │  trace it across risks
  ┌─ 3. SEAMS ────────────▼──────────────────────────┐
  │  A1: blind ↔ measured    (the meter unblocks rank)│
  │  A2: works-now ↔ breaks-later  (watch triggers)   │
  └────────────────────────┬─────────────────────────┘
                           ▼
                   Block 4 — How it works
```

The skeleton is mapped — the rest walks each risk top to bottom.

---

## How it works

### Move 1 — the mental model

You've inherited a codebase and someone hands you a 50-item "tech debt" list. The list is useless until you rank it — most items are fine, a few are urgent. A perf audit is the same shape: a *ranked* short list with evidence, not an exhaustive list of every possible improvement. The right framing is *opportunity cost*: every hour spent on R8 (low impact) is an hour not spent on R1 (high impact). Below, each risk is one paragraph with the four pieces an audit owes its reader: *what's broken*, *evidence*, *failure mode*, *cheapest fix*.

```
  Pattern — what each risk row tells you

   one-line claim    "synthesize() is the dominant unmeasured output-token cost"
   evidence          file:line range that proves the claim
   failure mode      what bites when this is unmitigated
   cheapest fix      smallest code change that meaningfully reduces the risk
   unblocks          what the fix lets you measure / optimize next
```

---

### Move 2 — the ten risks, ranked

#### R1: cost concentration on `synthesize()` (output-token heavy, unmeasured)

```
  ────────────────────────────────────────────────────────────────────────
  RANK 1 — HIGH consequence × HIGH likelihood
  ────────────────────────────────────────────────────────────────────────
  what's broken: the synthesize() fallback in DiagnosticAgent and
                 RecommendationAgent emits a long structured-JSON output
                 (conclusion + evidence array + hypotheses array, or 2-3
                 full Recommendation objects). Output tokens cost ~5× input
                 tokens. nothing measures its frequency or cost.
  evidence:      lib/agents/diagnostic.ts:87-126  (synthesize)
                 lib/agents/recommendation.ts:82-132  (synthesize)
                 prompt: "Output ONLY a JSON ... recommendation objects ..."
                 NO res.usage logged on either call site
                 NO counter for how often the fallback fires
  failure mode:  silent — the dominant per-investigation cost line is
                 invisible. A prompt refactor that increases the output
                 JSON size (e.g. adding a new field) raises the bill with
                 no signal. A model swap (sonnet → opus) compounds the
                 problem.
  cheapest fix:  add console.log(res.usage) at lib/agents/diagnostic.ts:117
                 and lib/agents/recommendation.ts:122 — two lines. tag with
                 { agent, kind: 'synthesize' } so the cost can be filtered
                 from the loop's normal turns.
  unblocks:      first measurement of synthesize() vs loop-turn cost ratio
                 → enables a cost cap on the fallback if it's heavy
                 → enables judging whether the fallback frequency is high
                   (if so: tighten maxToolCalls; if not: leave it)
  cross-ref:     .aipe/study-ai-engineering/06-production-serving/02-llm-cost-optimization.md
                 02-measurement-baselines-and-profiling.md (Meter 2)
```

#### R2: no `res.usage` logging anywhere (the cheapest unread meter)

```
  ────────────────────────────────────────────────────────────────────────
  RANK 2 — HIGH consequence × HIGH likelihood
  ────────────────────────────────────────────────────────────────────────
  what's broken: every anthropic.messages.create call returns res.usage
                 (input_tokens, output_tokens, cache_read, cache_creation).
                 zero call sites read it. cost is completely invisible.
  evidence:      lib/agents/base.ts:102     (main agent loop)
                 lib/agents/diagnostic.ts:97 (synthesize fallback)
                 lib/agents/recommendation.ts:96 (synthesize fallback)
                 lib/agents/intent.ts:18    (haiku classifier)
                 no .usage access anywhere in the repo (grep confirms)
  failure mode:  cost regressions land silently. a prompt template change
                 doubles input tokens; no signal. a model swap moves the
                 bill 3×; no signal. soft budgets in file 01 cannot exist
                 without this meter.
  cheapest fix:  ONE console.log per call site — five lines total. log
                 { agent, kind, ...res.usage }. ships the data to Vercel
                 function logs where it can be ingested later.
  unblocks:      cost budgeting in file 01
                 R1's measurement (confirms the synthesize concentration)
                 R4's measurement (would show if prompt-prefix caching is
                   actually missing or quietly enabled by SDK defaults)
  cross-ref:     02-measurement-baselines-and-profiling.md (Meter 2 — the
                 cheapest fix in the codebase for the most consequential
                 blind spot)
```

#### R3: 300s route budget pinned at ceiling, zero headroom

```
  ────────────────────────────────────────────────────────────────────────
  RANK 3 — HIGH consequence × MEDIUM likelihood (high on bad days)
  ────────────────────────────────────────────────────────────────────────
  what's broken: maxDuration = 300 sits at Vercel Pro's ceiling. Typical
                 investigation is ~100-115s. There's no slack: if Bloomreach
                 has a slow day (multiple 429 retries × 10-20s each) or
                 Anthropic returns slowly, the cumulative time crosses 300s
                 and Vercel kills the function mid-stream.
  evidence:      app/api/agent/route.ts:18-20  (comment + maxDuration = 300)
                 app/api/briefing/route.ts:15-17 (same)
                 lib/mcp/client.ts:121-132    (retry waits up to 20s × 3 max)
                 NO measurement of how close any investigation has come
  failure mode:  user sees half-stream + console.error in Vercel logs.
                 confidence is downgraded (data-quality note in UI) but
                 the actual user impact is "no diagnosis, no recommendation."
                 frequency: not measured; suspected rare but variable.
  cheapest fix:  TWO paths, neither code:
                 (a) tighten maxToolCalls (6 → 4 for diagnostic) to cap
                     the worst-case investigation more tightly. cost:
                     less exploration → lower confidence diagnoses.
                 (b) move the agent run out of the route (queue + worker)
                     so the route budget is no longer the cap. cost: a
                     database (does not exist) + a worker process.
                 cross-ref study-system-design/01-system-design/07 — the
                 same tradeoff frames as "ceiling 2" in that file.
  unblocks:      headroom on bad days; absent rework, fixing R1+R2 first
                 lets you see if R3 actually bites (today, frequency is
                 unknown).
```

#### R4: no prompt-prefix caching (Anthropic feature unused)

```
  ────────────────────────────────────────────────────────────────────────
  RANK 4 — MEDIUM consequence × HIGH likelihood (compounds every turn)
  ────────────────────────────────────────────────────────────────────────
  what's broken: Anthropic offers free prompt-prefix caching: insert
                 cache_control breakpoints in the system prompt and the
                 cached portion costs ~10% of the normal input rate.
                 blooming insights doesn't use it. every agent turn
                 re-tokenizes the same ~5-10KB system prompt.
  evidence:      lib/agents/diagnostic.ts:46    system = PROMPT.replace(...)
                 lib/agents/monitoring.ts:83    same shape
                 lib/agents/recommendation.ts:41 same shape
                 lib/agents/base.ts:92-101      no cache_control anywhere
                 no use of Anthropic SDK's beta prompt caching
  failure mode:  silent over-spend on input tokens. multiplied by every
                 turn in every agent in every investigation. invisible
                 because of R2 (no res.usage).
  cheapest fix:  insert cache_control: { type: 'ephemeral' } on the system
                 prompt's content block (Anthropic SDK supports this with
                 the prompt-caching beta header). ~5 lines per call site.
                 the savings compound with turns: an 8-turn agent saves
                 ~7× the input-token cost of the system prompt.
  unblocks:      requires R2 to measure the savings, but the change is
                 cheap enough to ship without measurement (cache hit is
                 always at least as cheap as a miss).
  cross-ref:     .aipe/study-ai-engineering/06-production-serving/01-llm-caching.md
```

#### R5: investigations Map grows monotonically (no eviction)

```
  ────────────────────────────────────────────────────────────────────────
  RANK 5 — MEDIUM consequence × LOW likelihood (today)
  ────────────────────────────────────────────────────────────────────────
  what's broken: lib/state/investigations.ts maintains an in-memory
                 Map<string, AgentEvent[]> with .set on every saved run
                 and NO .delete, NO LRU, NO size cap. de-facto bound
                 is the warm function instance dying.
  evidence:      lib/state/investigations.ts:11  const mem = new Map(...)
                 lib/state/investigations.ts:31  mem.set(insightId, events)
                 no .delete in the file
                 (contrast: lib/state/insights.ts:36 calls insights.clear()
                  at every putInsights — that one IS bounded)
  failure mode:  in a long-warm instance running many investigations, the
                 Map grows ~50KB per investigation. at demo scale: tens
                 of investigations × 50KB = a few MB, fine. at heavier
                 traffic on a long-warm instance: tens of MB, noticeable
                 on Vercel's RAM limit.
  cheapest fix:  add an LRU cap (e.g. keep last 100 investigations) using
                 a small LRU library or hand-rolled. ~20 lines.
                 alternative: skip the in-memory cache entirely once a DB
                 is added; persist + retrieve from the DB on cache miss.
  unblocks:      bounds the unbounded growth path. low priority today
                 because the instance death is a de-facto bound — but the
                 shape is the classic Node leak pattern.
  cross-ref:     04-cpu-memory-and-allocation.md
```

#### R6: schema cache has no TTL (per-instance, lifetime)

```
  ────────────────────────────────────────────────────────────────────────
  RANK 6 — LOW consequence × LOW likelihood (today)
  ────────────────────────────────────────────────────────────────────────
  what's broken: lib/mcp/schema.ts:131 cached: WorkspaceSchema | null is
                 populated once per warm instance and never invalidated
                 (except via test-only _resetSchemaCache).
  evidence:      lib/mcp/schema.ts:131,170,194
                 _resetSchemaCache only called from tests
                 no TTL, no invalidation signal from Bloomreach
  failure mode:  a user adds an event type to their workspace; the warm
                 instance won't see it until cold restart. user sees the
                 old schema in the agent's reasoning ("I don't see a
                 `return` event in this workspace") even though it now
                 exists.
  cheapest fix:  add a TTL (cachedAt timestamp + 60-300s freshness check).
                 ~10 lines. cost: 6-12s of bootstrap latency on first
                 request after expiry.
  unblocks:      bounds staleness when workspace schema mutates. low
                 priority because (a) schemas rarely mutate, (b) cold
                 starts cycle frequently on serverless anyway.
  cross-ref:     06-caching-batching-and-backpressure.md (Cache 2)
```

#### R7: no Web Vitals / time-to-first-event metric

```
  ────────────────────────────────────────────────────────────────────────
  RANK 7 — MEDIUM consequence × HIGH likelihood (silently degrades)
  ────────────────────────────────────────────────────────────────────────
  what's broken: no client-side measurement. no LCP/INP/CLS via
                 next/web-vitals. no time-to-first-event or time-to-done
                 wrapped around the fetch call. the perceived-perf
                 strategy (file 07) is unvalidated.
  evidence:      no useReportWebVitals call anywhere
                 no @vercel/speed-insights integration
                 no performance.mark / performance.measure in client code
                 no /api/telemetry endpoint
  failure mode:  a refactor that adds a heavy synchronous parse to the
                 per-event handler doubles time-to-first-event; nobody
                 notices. a CSS change that delays the LCP element by
                 500ms; nobody notices. perceived perf degrades silently.
  cheapest fix:  useReportWebVitals in app/layout.tsx + console.log (or
                 POST /api/telemetry). ~10 lines for Web Vitals. another
                 ~5 lines to wrap fetch with performance.now() for the
                 investigation-specific metrics.
  unblocks:      first time the UX strategy in file 07 can be validated
                 (or refuted). same shape as R2 but on the client side.
  cross-ref:     07-rendering-client-and-mobile-performance.md
```

#### R8: per-event setState not batched (works at today's rate)

```
  ────────────────────────────────────────────────────────────────────────
  RANK 8 — LOW consequence × LOW likelihood (today)
  ────────────────────────────────────────────────────────────────────────
  what's broken: useInvestigation hook calls setItems / setDiagnosis /
                 setRecommendations per NDJSON event. ~100-200 setState
                 calls per investigation. at 1-2 events/sec, this is
                 fine. at higher rates (e.g. streamed text deltas), it
                 would dominate render time.
  evidence:      lib/hooks/useInvestigation.ts:97-150 (handle function)
                 each case calls setX → re-render
                 NO useReducer, NO batched flush, NO startTransition
  failure mode:  ONLY bites if event rates jump (a future agent emits
                 per-token text deltas, or a fan-out architecture sends
                 events from N parallel agents at once). today: fine.
  cheapest fix:  refactor to useReducer + manual flush via requestAnimationFrame.
                 ~30 lines. alternatively, wrap setState calls in
                 startTransition to mark them non-urgent.
  unblocks:      headroom for higher event rates. low priority today
                 because rates are bounded by Anthropic's per-turn cost.
  cross-ref:     07-rendering-client-and-mobile-performance.md
```

#### R9: NDJSON event size sometimes large (truncated to 4KB)

```
  ────────────────────────────────────────────────────────────────────────
  RANK 9 — LOW consequence × MEDIUM likelihood (works as designed)
  ────────────────────────────────────────────────────────────────────────
  what's broken: tool_call_end events carry result payloads. TRUNC = 4000
                 in the route caps them, but 4KB × 30-50 tool events =
                 ~120-200KB per investigation streamed to the browser.
  evidence:      app/api/agent/route.ts:99-103   const TRUNC = 4000
                 app/api/briefing/route.ts:69-73 (same TRUNC)
                 lib/mcp/events.ts:7 (no size limit at the type level)
  failure mode:  not really a failure mode today — bandwidth is cheap,
                 chunked NDJSON streams handle it fine. would become a
                 perf concern on a constrained mobile network or if the
                 truncation cap were raised.
  cheapest fix:  none needed today; document the design choice. if it
                 ever bites: tighten TRUNC to 1000 chars for the UI
                 (the model's 16k cap can stay).
  unblocks:      noted, not blocking. the 4KB cap is already tight.
```

#### R10: bootstrap chain serialized (4-6 calls before any agent)

```
  ────────────────────────────────────────────────────────────────────────
  RANK 10 — LOW consequence × LOW likelihood (one-time cold cost)
  ────────────────────────────────────────────────────────────────────────
  what's broken: bootstrapSchema calls 4-6 MCP tools sequentially before
                 the first agent runs. ~6-12s of bootstrap on every cold
                 instance. on warm instances, the schema cache makes it
                 free.
  evidence:      lib/mcp/schema.ts:178-185 (four sequential awaits)
                 comment confirms: "Sequential — the server allows ~1 req/s"
                 cache hit is microseconds (lib/mcp/schema.ts:173)
  failure mode:  cold-start latency bump (~6-12s) on the first request
                 after a fresh instance. invisible on warm requests. no
                 user-visible failure — the spacing gate forbids parallel
                 calls anyway.
  cheapest fix:  none possible — Bloomreach's rate limit forbids parallel
                 calls. the schema cache (Cache 2) is already the right
                 fix for warm requests. for cold-start mitigation, only
                 option is keep-warm / regional placement.
  unblocks:      noted, not fixable at this layer. cold-start cost is a
                 serverless tradeoff.
  cross-ref:     03-latency-throughput-and-tail-behavior.md (bootstrap math)
                 05-io-network-and-database-bottlenecks.md (the I/O chain)
```

---

### Move 2.5 — what's NOT YET EXERCISED (honest omissions)

These would normally appear in an audit but legitimately don't apply to this codebase yet:

```
  ┌─ Load testing ─────────────────────────────────────────────────────┐
  │  no k6, no autocannon, no synthetic benchmark.                      │
  │  cheapest target: a script that hits /api/briefing?demo=cached 10× │
  │  serially and logs total/TTFE/TTD. exercises NDJSON pipeline.       │
  │  not a finding because: nobody promised to measure throughput yet.  │
  └─────────────────────────────────────────────────────────────────────┘

  ┌─ Profiler integration ─────────────────────────────────────────────┐
  │  no clinic, no 0x, no --inspect flag wired into dev script.         │
  │  not a finding because: profilers are diagnostic tools (reached    │
  │  for when monitoring flags something), and monitoring (R2, R7)     │
  │  hasn't been built yet. profiling comes after measurement.          │
  └─────────────────────────────────────────────────────────────────────┘

  ┌─ Batching ──────────────────────────────────────────────────────────┐
  │  no batched MCP calls, no batched Anthropic calls.                  │
  │  not a finding because: Bloomreach's MCP doesn't expose a batch    │
  │  endpoint, and Anthropic's messages API is one-turn-per-call. the  │
  │  cache (R4) is the equivalent lever — remove the call entirely.   │
  └─────────────────────────────────────────────────────────────────────┘

  ┌─ Formal SLOs ──────────────────────────────────────────────────────┐
  │  no p95 latency target, no error-rate budget.                      │
  │  not a finding because: soft budgets in file 01 depend on R2's    │
  │  meter landing first. SLO without measurement is theater.          │
  └─────────────────────────────────────────────────────────────────────┘
```

---

### Move 3 — the principle

**The audit's job is to *not* be exhaustive.** Twenty risks ranked equally is useless; three risks ranked by consequence is actionable. The discipline is rejecting the urge to "be thorough" and instead being *opinionated*. blooming insights' top three (R1: cost concentration; R2: no meter; R3: zero budget headroom) are the ones that would actually change the bill, the visibility, or the failure rate. Fix those and the system is materially better; ignore them and every other "fix" is rearranging deck chairs.

---

## Primary diagram

The full ranked list at a glance — top three, middle four, bottom three, not-yet-exercised.

```
  blooming insights — ranked perf risks (the audit at a glance)

  ┌─ TOP THREE (HIGH consequence) ─────────────────────────────────────────┐
  │                                                                         │
  │  R1  COST CONCENTRATION on synthesize()                                 │
  │      lib/agents/diagnostic.ts:87, recommendation.ts:82                  │
  │      ★ output-heavy structured JSON, unmeasured                         │
  │      fix: add res.usage logging (R2 enables R1's measurement)           │
  │                                                                         │
  │  R2  NO res.usage LOGGING ANYWHERE                                      │
  │      lib/agents/base.ts:102, diagnostic.ts:97, recommendation.ts:96,    │
  │      intent.ts:18                                                       │
  │      ★ cheapest fix in the codebase; biggest visibility win             │
  │      fix: console.log(res.usage) at five call sites                     │
  │                                                                         │
  │  R3  300s ROUTE BUDGET PINNED AT CEILING                                │
  │      app/api/agent/route.ts:20, briefing/route.ts:17                    │
  │      ★ zero headroom for retry storms                                   │
  │      fix: queue + worker (requires DB) OR tighten maxToolCalls          │
  └────────────────────────────────────────────────────────────────────────┘

  ┌─ MIDDLE FOUR (MEDIUM consequence) ─────────────────────────────────────┐
  │                                                                         │
  │  R4  NO PROMPT-PREFIX CACHING (Anthropic feature unused)               │
  │      lib/agents/base.ts (no cache_control anywhere)                    │
  │      fix: ~5 lines per call site, compounds per turn                   │
  │                                                                         │
  │  R5  investigations MAP grows monotonically                            │
  │      lib/state/investigations.ts:11,31 (no .delete)                    │
  │      fix: LRU cap (~20 lines)                                          │
  │                                                                         │
  │  R6  SCHEMA CACHE has no TTL                                           │
  │      lib/mcp/schema.ts:131,170                                         │
  │      fix: add cachedAt + TTL check (~10 lines)                         │
  │                                                                         │
  │  R7  NO WEB VITALS / time-to-first-event metric                        │
  │      (absent: useReportWebVitals, performance.mark)                    │
  │      fix: ~10 lines in app/layout.tsx                                  │
  └────────────────────────────────────────────────────────────────────────┘

  ┌─ BOTTOM THREE (LOW consequence today) ─────────────────────────────────┐
  │                                                                         │
  │  R8  PER-EVENT setState not batched                                    │
  │      lib/hooks/useInvestigation.ts:97-150                              │
  │      fix: useReducer + manual flush (only if event rates jump)         │
  │                                                                         │
  │  R9  NDJSON EVENT SIZE sometimes large (~120-200KB per investigation)  │
  │      route.ts TRUNC=4000 cap                                           │
  │      fix: tighten TRUNC if it ever bites                               │
  │                                                                         │
  │  R10 BOOTSTRAP CHAIN serialized (~6-12s cold cost)                     │
  │      lib/mcp/schema.ts:178-185                                         │
  │      fix: none possible (rate limit forbids parallel)                  │
  └────────────────────────────────────────────────────────────────────────┘

  ┌─ NOT YET EXERCISED (honest omissions) ─────────────────────────────────┐
  │  - Load testing (no synthetic baseline)                                │
  │  - Profiler integration (no clinic, no 0x, no --inspect)               │
  │  - Batching (provider doesn't support; cache is the equivalent lever)  │
  │  - Formal SLOs (no p95 target, no error-rate budget)                   │
  └────────────────────────────────────────────────────────────────────────┘
```

---

## Implementation in codebase

### Use cases — when this audit gets consulted

- **Sprint planning** — pick the top item, ship the fix, re-rank. R2 unblocks R1, so the natural sequence is R2 first.
- **Onboarding** — a new contributor reads this file to see "what's known to be slow/expensive" without reading the rest of the guide.
- **Before a major refactor** — re-rank the risks against the proposed change. A refactor that touches `synthesize()` should weigh R1 carefully; a refactor that adds a parallel agent topology turns R8 from low into high.
- **After a production incident** — cross-reference the symptom against this file. "We hit 300s and the function died" → R3 was the latent risk.

### Code side by side

**The R2 fix — five lines that unblock R1 and the soft budgets in file 01.**

```
  // ── PROPOSED FIX FOR R2 (illustrative — not yet applied) ──
  //
  // lib/agents/base.ts (after line 102):
  //   const res = await anthropic.messages.create(params);
  //   console.log('[perf]', { agent, kind: 'loop_turn', turn, ...res.usage });
  //
  // lib/agents/diagnostic.ts (after line 117):
  //   const res = await this.anthropic.messages.create({...});
  //   console.log('[perf]', { agent: 'diagnostic', kind: 'synthesize', ...res.usage });
  //
  // lib/agents/recommendation.ts (after line 122):
  //   const res = await this.anthropic.messages.create({...});
  //   console.log('[perf]', { agent: 'recommendation', kind: 'synthesize', ...res.usage });
  //
  // lib/agents/intent.ts (after line 26):
  //   const res = await anthropic.messages.create({...});
  //   console.log('[perf]', { agent: 'coordinator', kind: 'classify', ...res.usage });
  //
  // five lines total. ships to Vercel function logs. R1 becomes
  // measurable immediately; soft budgets in file 01 become possible.
```

**The R3 trigger — the spot where the route budget is committed.**

```
  app/api/agent/route.ts  (lines 18–20)

  // 300s = Vercel Pro's max. A live investigation (diagnostic → recommendation)
  // runs ~100-115s under the ~1 req/s MCP limit; 60s (Hobby) cannot fit it.
  export const maxDuration = 300;                              ← the line itself
        │
        └─ this single line is R3 in a nutshell: the budget is pinned at
           the ceiling. the comment names the typical case (~100-115s).
           the headroom is implicit (~185s). on bad days the headroom
           is gone. removing the line drops to Vercel's default (60s on
           Hobby), which makes things worse. the only real fixes are
           architectural: queue + worker, or lower maxToolCalls.
```

**The R5 evidence — investigations.set without ever calling .delete.**

```
  lib/state/investigations.ts  (lines 11, 31)

  const mem = new Map<string, AgentEvent[]>();                ← module-level Map

  export function saveInvestigation(insightId: string, events: AgentEvent[]): void {
    mem.set(insightId, events);                               ← grows monotonically
    if (PERSIST) { ... }
  }

  // NOTE: no mem.delete anywhere in this file. _clearInvestigationCache
  // exists (lib/state/investigations.ts:45) but is test-only.
        │
        └─ contrast with lib/state/insights.ts:36, where putInsights calls
           insights.clear() at the top. that one IS bounded; this one
           ISN'T. de-facto bound is instance death; explicit bound would
           be an LRU.
```

---

## Elaborate

**Where this pattern comes from.** Risk-ranked audits are the SRE / consulting standard for any "review this system" exercise. The classic format (RAID register: Risk, Assumption, Issue, Dependency) is one common shape; "rank by consequence × likelihood" is another. The discipline that makes them useful is *forcing the rank* — if every item is "high priority," nothing is. The two-step decision (is this real? is this top three?) makes the list actionable.

**Why R2 unblocks the top three.** R2 is the meter; R1 is what the meter would reveal; R3 is what the meter would let you bound. Fix R2 first and you can *measure* whether R1 is as concentrated as suspected and whether R3 ever bites. Without R2, both are educated guesses. The five lines of `console.log` are the rare case where one small fix unblocks the whole top three's prioritization.

**Why the bottom three are listed at all.** Not every risk needs a fix; some need a *trigger condition documented*. R8's setState would matter if event rates jumped; R10's bootstrap chain would matter if the rate limit were raised. Naming the trigger ("watch this if X changes") is what turns a noted risk into a useful one. Without the trigger, the bottom three are noise; with the trigger, they're a tripwire.

**Connection to adjacent concepts.** Every other file in this guide feeds into this one — file 01 names the budgets these risks would break, file 02 names the meter that resolves R2/R7, file 03 quantifies R3's tail, file 04 sources R5/R6's memory concerns, file 06 sources R4's caching gap, file 07 sources R7's missing client measurement. This file is the *consolidated* prioritization across all of them.

---

## Interview defense

### Q: If you had time to fix one performance thing in blooming insights, which would it be and why?

**Answer:** R2 — add `res.usage` logging at five Anthropic call sites. Five lines of code. It's the cheapest fix in the entire codebase and it unblocks the most consequential blind spot (cost). Today nobody knows what an investigation costs in tokens; the suspected dominant line item — the output-heavy `synthesize()` fallback — is unconfirmed. The five lines confirm it. They also enable every soft budget in file 01 (cost-per-investigation cap, p95 latency SLO, error-rate budget). The leverage is asymmetric: five log lines turn "we ship and hope" into "we ship and measure." Every other fix on the list is downstream of this one.

```
  why R2 first

   cost: 5 lines of console.log
   unlocks:
     R1 measurement (synthesize concentration)
     R3 measurement (how often we approach 300s)
     R4 measurement (would caching actually save the suspected amount?)
     soft budgets in file 01
   ratio: ~5 lines for ~10 unblocked decisions
```

### Q: The audit lists ten risks but only ranks three as "high." How did you draw the line?

**Answer:** Consequence × likelihood. A risk earns "high" only if (a) the failure mode is materially user-visible or financially significant *and* (b) it's likely to bite at current usage, not just at theoretical scale. R1 (cost concentration) bites on every investigation — likelihood = constant; consequence = financial; high × high. R2 (no meter) is the prerequisite for measuring anything else; high consequence (every other risk is bounded by ignorance), constant likelihood. R3 (route budget at ceiling) bites only on bad days but the consequence is "user gets no answer"; medium × high. Everything else is either lower consequence (R8 setState — works fine at today's rates) or lower likelihood (R5 memory growth — bounded by instance death today). The discipline of refusing to call everything "high" is what makes the ranking useful.

### Q: What's the most obvious risk you'd expect to be on this list that isn't?

**Answer:** "Bundle size" or "First Contentful Paint" — the classic frontend perf risks. They're not on the list because (a) the codebase has no `@next/bundle-analyzer` integration so we can't actually measure bundle size, and (b) the bundle is dominated by the same Next.js 16 + React 19 baseline as every other Next app — there's no obvious bloat (no chart library, no rich text editor, no design system imports). FCP is fast because the pages are server-rendered shells with skeleton placeholders; the heavy work is the post-hydration NDJSON read, not the initial render. The honest answer: those risks aren't on the list because they're not the biggest ones *for this system*. The audit is supposed to be opinionated, not exhaustive.

---

## Validate

**Level 1 — Reconstruct.** List the top three risks in blooming insights' perf audit with their file:line evidence and one-line fix. (Answer: R1 — cost concentration on `synthesize()` (`lib/agents/diagnostic.ts:87`, `lib/agents/recommendation.ts:82`); fix: add `res.usage` logging. R2 — no `res.usage` logging anywhere (5 call sites: `lib/agents/base.ts:102`, `lib/agents/diagnostic.ts:97`, `lib/agents/recommendation.ts:96`, `lib/agents/intent.ts:18`); fix: 5 `console.log` lines. R3 — 300s route budget pinned at ceiling (`app/api/agent/route.ts:20`, `app/api/briefing/route.ts:17`); fix: queue + worker (architectural) or tighten `maxToolCalls`.)

**Level 2 — Explain.** Why is R2 ranked above R1 even though R1 is the more consequential issue? (Answer: R2 is the *prerequisite* for measuring R1. Without `res.usage` logging, R1's claim ("synthesize is the dominant unmeasured output-token cost") is an inference, not a measurement. Fixing R2 first turns R1 from "suspected" to "confirmed or refuted." Fixing R1 first (e.g. tweaking the synthesis prompt) without R2's measurement is shipping blind — there's no way to tell if the change moved the bill. The sequence matters: meter first, then optimize.)

**Level 3 — Apply.** A new feature adds a third agent that runs after recommendation and proposes a follow-up monitoring rule. Re-rank the risks for that change. (Answer: R3 (300s budget) gets *worse* — the third agent adds ~30-50s to the typical investigation, eating into the headroom further; rank stays high but the urgency rises. R1 (cost concentration) gets *worse* — a third agent likely adds another `synthesize` call; the cost concentration spreads. R7 (Web Vitals) is unchanged. R5 (Map growth) is unchanged. R10 (bootstrap) is unchanged. The natural action: ship R2's meter *first* so the new agent's actual cost lands measured, not hoped.)

**Level 4 — Defend.** A reviewer says "you've listed ten risks but you're not actually fixing any — this audit is just paperwork." Defend. (Answer: an audit's value is *deciding what NOT to fix* as much as deciding what to fix. The top three are the queue; the middle four are explicit "noted, lower priority"; the bottom three are explicit "watch only." Without the audit, every change is unranked — the team might fix R10 (which can't actually be fixed) instead of R2 (which is five lines). The audit IS the prioritization. Shipping R1-R3 fixes is a separate exercise that depends on engineering capacity; the audit names what to spend that capacity on. Paperwork is when the audit doesn't change behavior; this one ranks the next three sprints' work.)

---

## See also

- `00-overview.md` — the top-three findings, with the consolidated map
- `01-performance-budget.md` — the four budgets the risks would break
- `02-measurement-baselines-and-profiling.md` — R2 in depth (the meter that unblocks everything)
- `03-latency-throughput-and-tail-behavior.md` — R3's tail math
- `04-cpu-memory-and-allocation.md` — R5/R6 memory shapes
- `06-caching-batching-and-backpressure.md` — R4 prompt-prefix cache gap
- `07-rendering-client-and-mobile-performance.md` — R7 Web Vitals gap
- `.aipe/study-system-design/01-system-design/07-scale-bottlenecks-and-evolution.md` — the architectural fix for R3
- `.aipe/study-ai-engineering/06-production-serving/02-llm-cost-optimization.md` — R1 theory
- `.aipe/study-agent-architecture/05-production-serving/02-fan-out-backpressure.md` — R8 trigger condition (if fan-out arrives)
