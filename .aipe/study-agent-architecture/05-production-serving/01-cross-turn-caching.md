# Cross-turn caching

**Industry name(s):** Cross-turn / intra-run cache, tool-result memoization, run-replay cache, semantic cache, prompt-prefix cache
**Type:** Industry standard · Language-agnostic

> An agent runs many turns per task, and many tasks repeat sub-steps. blooming insights caches at two of the three useful scopes — a 60s exact-match `Map` over MCP tool results keyed on `name:JSON.stringify(args)` (intra-run memoization), and a whole-investigation replay used by the demo — and deliberately skips the third (cross-run semantic cache), because a stale hit would poison the agent's whole trajectory, not just one response.


---

## Why care

You wrote a search box once. Every keystroke fires `fetch('/api/search?q=' + q)`. The first time the user types `react`, the API hits the DB and returns 80 rows. The second time, the same keystrokes hit the same endpoint and the DB does the same work. You reach for a `Map` keyed on the query string: hit → return the cached rows in 0 ms; miss → fetch and store. Every cache you've written — `useMemo`, React Query's `staleTime`, a `WeakMap` of parsed results — is this shape with a different key and a different eviction rule.

Now picture the same memoization, but the "function" being cached is *an agent's tool call.* An agent's diagnostic run can call `execute_analytics_eql` six times. Two of those calls might be identical — same EQL, same args — because the model decided to verify a number it already saw on an earlier turn. Without a cache, those two identical calls each pay the full HTTP round trip, the 1.1s spacing, and a slot in the per-investigation budget. With a cache, the second call returns in 0 ms and the budget goes farther.

That's the first piece of the question this file answers: **inside a single agent run, when the model re-derives the same sub-result, who returns it from cache?** But the question doesn't stop there. Agents also run *across* tasks — task A and task B, run an hour apart, can ask sub-questions that are *similar* (not identical) and would each benefit from reusing the other's work. That's a different cache, with a different key (semantic similarity instead of exact match) and a much sharper failure mode.

**Why answering that question matters:** because the same caching instinct you have for `useMemo` doesn't transfer cleanly to an agent. Caching a frontend function is safe — same args mean same result, every time. Caching an agent's tool call is conditional — same args might mean different results if the underlying data changed, and a stale hit feeds *into the model's reasoning*, which then conditions every downstream turn on the stale value. The bug doesn't show up as a wrong cached number; it shows up as a confidently-wrong trajectory built on top of one stale read.

Without intra-run caching:
- A diagnostic agent re-runs the same EQL twice in one investigation
- Each call pays 1.1s spacing + HTTP round trip + a slot in the 6-call budget
- The 6-call cap is hit earlier; the agent gives up before the right question lands

With intra-run caching (what `McpClient` has):
- The second identical EQL returns from the in-memory `Map` in 0 ms
- The 6-call budget covers more *distinct* queries
- The investigation has room to actually triangulate the cause

Without cross-run semantic caching (what this codebase chose):
- Task B asks "purchases vs prior 90 days" two hours after Task A asked the same
- Task B re-runs the full EQL, re-spaces it, re-counts it against the budget
- It also pays for being correct — its numbers reflect the latest two hours of data, not Task A's snapshot

With cross-run semantic caching (the version this codebase skipped):
- Task B's "purchases vs prior 90 days" matches Task A's cached result, returns in 0 ms
- But the two hours of new data are silent; Task B answers from a snapshot that's stale-by-design
- The model reasons forward from the cached value; every downstream turn inherits the stale read

One-line summary: **agent caches come in scopes — within a turn, within a run, across runs — and the failure mode gets sharper as the scope widens, because a stale hit poisons the *trajectory*, not just one response.** Here's the shape of the three scopes, which two this codebase has, and the deliberate reason it skipped the third.

---

## How it works

**The mental model: three caches at three scopes, nested by blast radius.** The smallest scope is one turn of one run (provider-side prompt-prefix caching — skip the tokenizer). The middle scope is many turns of one run (intra-run memoization — skip the network for repeated tool calls within a single task). The widest scope is many runs (cross-run semantic cache — return Task A's answer to Task B's similar question). The blast radius of a wrong cached value grows with the scope: a single-turn stale prefix is invisible; a stale intra-run hit affects one trajectory; a stale cross-run hit affects every trajectory that matches it.

```
Three cache scopes, nested by blast radius

  ┌─ scope: cross-run (widest blast radius) ─────────────────────────┐
  │   key: semantic similarity of the sub-question                    │
  │   value: prior task's cached result                               │
  │   stale hit: poisons every matching task's trajectory             │ ◄── SKIPPED
  │                                                                    │   on purpose
  │  ┌─ scope: intra-run (medium blast radius) ──────────────────────┐│
  │  │   key: tool name + JSON.stringify(args)                        ││
  │  │   value: this run's earlier tool result                        ││
  │  │   stale hit: this trajectory only; one run, one user           ││ ◄── BUILT
  │  │   TTL bounds it (60s here)                                     ││
  │  │                                                                  ││
  │  │  ┌─ scope: per-turn (smallest) ────────────────────────────────┐│
  │  │  │  key: prompt prefix (provider-side, cache_control on Claude)││
  │  │  │  value: tokenized + KV-cached prefix                         ││ ◄── ABSENT
  │  │  │  stale hit: impossible (provider re-verifies hash)          ││   (no field set
  │  │  └────────────────────────────────────────────────────────────┘│   on requests)
  │  └──────────────────────────────────────────────────────────────┘│
  └────────────────────────────────────────────────────────────────────┘

  Plus a separate, coarsest cache: whole-run replay (the demo)
   → a captured investigation streams from disk on /investigate, no agents run
```

The strategy in plain English: **cache where the cost is and the staleness is bounded.** Intra-run is the cheap win — same task, fresh data window (60s here), and the stale hit lives in one run that ends in seconds. Cross-run looks like the same instinct extended (more hits, more savings) but the staleness window grows from "seconds inside one task" to "hours or days across many tasks" — and the value lives in *every* downstream model turn, not in one response.

### Layer 1: intra-run memoization — the cache `McpClient` runs hard

The technical thing: an in-memory `Map` keyed on `${tool_name}:${JSON.stringify(args)}` with a 60-second TTL, sitting in front of every MCP tool call. Same call within 60 seconds = 0 ms hit; otherwise the HTTP round trip runs.

If you're coming from frontend, this is `useMemo` over a deps array. Same args mean the same memoized return; the cache lives for the component's lifetime. The agent version lives for `McpClient`'s lifetime, which in practice is one investigation.

```
McpClient.callTool — the intra-run cache lives here

  callTool(name, args, opts)
       │
       ▼
   cacheKey = `${name}:${JSON.stringify(args)}`             L102
       │
       ▼
   cache.get(cacheKey)?.expiresAt > now ?                   L106–L110
       │
       ├─ hit  →  return { result, durationMs: 0,
       │                    fromCache: true }
       │
       └─ miss → liveCall(name, args)  →  network            L113
                     ▼
                  if isError: return WITHOUT caching         L137–L139
                  else: cache.set(key, { result,
                                          expiresAt: now+60s }) L143–L144
                     ▼
                  return { result, durationMs, fromCache: false }
```

The practical consequence: when the diagnostic agent re-runs the same EQL inside one investigation (which happens when the model verifies a number, or two agents in the chain ask the same workspace-shape query), the second call is free. The 60-second TTL means the cache works *within* a typical investigation (the route's `maxDuration` is 300s, but a single investigation usually finishes in 30–60s) and silently expires across investigations.

The condition under which it works (and doesn't): the cache assumes args determine result. That's true for `execute_analytics_eql` on a slow-moving aggregate — the underlying data doesn't shift second-to-second. It's *not* always true; the cache is opted out for the `/debug` "force fresh" path via `skipCache` (L105). The cache also never stores errors (L137–L139) — an `isError: true` result returns to the agent but isn't written, so a 429 doesn't poison the cache for the rest of the run.

### Layer 2: whole-run replay — the demo cache

The technical thing: a separate, coarser cache that stores entire investigations (the streamed event sequence the agent produced) and replays them on `/investigate` requests when the data is requested with no `live=1` flag. No agents run on a replay; the events stream from disk with a small per-event delay to look live.

If you're coming from frontend, this is the difference between "run the data layer" and "serve the recorded fixtures from a Storybook story." Both produce the same rendered UI; one runs the code, the other plays a tape.

```
The whole-run replay — agents do not run

  GET /api/agent?insightId=...   (no &live=1)
        │
        ▼
   getCachedInvestigation(insightId) ?                      route.ts L127
        │
        ├─ hit  →  filterByStep(...)
        │         stream events from disk with a small delay
        │         NO MCP calls, NO Claude calls
        │
        └─ miss →  fall through to the live agent path
```

The practical consequence: the demo experience (clicking a stored anomaly tile) runs without an API key, without MCP, without Bloomreach access. It's a whole-run cache hit. The cost paid was at recording time; the replay is free. That's an even coarser cache than intra-run — the *whole trajectory* is the value, the `insightId` is the key.

The condition under which this works: the underlying anomaly is stable enough that the recorded investigation is still a useful answer when replayed. For a demo of capability, that's always true. For a live diagnosis, it isn't — which is exactly why the `&live=1` flag exists.

### Layer 3 (absent): cross-run semantic cache — the one this codebase skipped

The technical thing: a cache where the key is a *semantic embedding* of a sub-question rather than an exact tool-args match — so Task B's "purchase volume over 90 days" hits Task A's "count purchases for last 90 days" because they're semantically close enough. Standard pattern in production agents that handle high query volume.

If you're coming from frontend, this is the difference between exact-string `useMemo` (same args, hit) and a fuzzy cache that says "this query is similar enough to a cached one, return the cached value." The fuzzy version saves more queries; it also returns wrong answers when "similar enough" doesn't actually mean "the same answer."

```
The cross-run semantic cache — NOT in this codebase

  task B asks: "purchases trend over the last 90 days"
        │
        ▼
   embed(question) → vector
        │
        ▼
   cache.findNearest(vector, threshold=0.92) → cached value?
        │
        ├─ hit  →  return Task A's cached result
        │         ◄── stale if Task A ran 2h ago and data has moved
        │
        └─ miss →  full retrieval, cache the new vector + result
```

The practical consequence — and the reason this codebase skipped it: a stale cross-run hit doesn't return one wrong response; it *feeds into the model's reasoning*, which then conditions every downstream turn on the stale value. The diagnostic agent that hits a stale cached value will reason confidently from it, run more queries that contextualize it, and conclude a diagnosis built on a stale read. The blast radius is the whole trajectory, not the one response — and it's silent.

The condition under which a cross-run semantic cache would be safe: the underlying data has to be slow enough that "an hour ago" is still right. For analytics aggregates over 90-day windows, that's *sometimes* true and *sometimes* not — and you can't tell from the question. The mitigations exist (freshness gates that don't cache anything within a moving window, source-side cache-busting on writes) but they're complex to maintain and easy to get wrong; the failure mode when you get them wrong is the worst kind of cost blowup — silent, wrong, confident.

### Why the scope gradient matters — blast radius vs hit rate

The technical principle: as cache scope widens (per-turn → intra-run → cross-run), the potential hit rate goes up *and* the blast radius of a stale hit goes up. The trade isn't linear; it's a Pareto where intra-run sits at a sweet spot and cross-run sits past the point where staleness is silently costly.

```
The cache-scope tradeoff

  scope         hit rate     blast radius    in this codebase
  ─────────    ──────────   ────────────   ─────────────────
  per-turn     low           1 turn          ABSENT (no prompt-prefix
                                              caching on Claude calls)
  intra-run    medium        1 trajectory    BUILT — 60s TTL Map
  whole-run    by design     1 user/session  BUILT — demo replay
  cross-run    high          ALL trajectories SKIPPED on purpose —
               (semantic)                       stale hit poisons every
                                                downstream turn
```

The principle: **cache wider only when the value is bounded against the freshness it depends on.** The 60s intra-run TTL is bounded against the typical investigation duration; the whole-run replay is bounded against the demo's "this is a recording" semantics. Cross-run with semantic match is unbounded — the cache assumes the underlying data hasn't moved, which for live analytics is exactly the assumption you can't make.

### Phase A vs Phase B — what would change if semantic caching were added

Right now intra-run + whole-run are in; cross-run semantic is out. Naming what shifts if it were added makes the cost honest.

```
       Phase A (now)                    Phase B (with cross-run semantic)
┌──────────────────────────────┐   ┌──────────────────────────────────────┐
│ McpClient cache: 60s TTL,    │   │ McpClient cache: same (intra-run)    │
│ exact key, intra-run only    │   │ + semantic cache layer above         │ ←
│   ▼                          │   │   ▼                                  │
│ Task A: runs full investigat. │   │ Task A: runs full investigation     │
│ Task B (2h later, similar q):│   │ Task B (2h later): semantic hit →    │ ←
│   runs full investigation     │   │   Task A's stale numbers feed model  │
│   (fresh data, real cost)    │   │   (silent, confident, possibly wrong)│
└──────────────────────────────┘   └──────────────────────────────────────┘
   correct, slow                       fast, sometimes wrong, hard to see
```

*Phase A (now):* every distinct investigation pays its own retrieval cost. Repeat sub-steps within one investigation are free (intra-run cache); repeat investigations of the same anomaly are free (demo replay). The bill scales linearly with distinct trajectories.

*Phase B (semantic cache):* repeat *similar* sub-steps across investigations would be free too. The bill flattens, and so does the freshness — the model is reasoning from possibly-stale data and the user can't tell.

The takeaway: **the codebase stopped at the scope where staleness is bounded.** Pushing to cross-run semantic would buy hit rate at the cost of trajectory-wide failure modes that are silent and hard to test for. That's not "we'll add it later" — it's "we shouldn't add it unless we measure a real need and build the freshness gates first."

This is what people mean when they say "caching an agent is harder than caching a function." The function cache's failure mode is "wrong returned value." The agent cache's failure mode is "wrong reasoning chain built on top of a wrong returned value." The second is exponentially worse.

The full picture is below.

---

## Cross-turn caching — diagram

```
blooming insights: cross-turn caching, three scopes labelled by what's in/out

  Request enters: GET /api/agent
       │
       ▼
  ┌─────────────────────────────────────────────────────────────────┐
  │ L0  Whole-run replay (demo)         BUILT                        │
  │   route.ts L125–L141                                              │
  │   key: insightId                                                  │
  │   value: captured event stream                                    │
  │   hit  →  no agents run, stream from disk                          │
  └─────────────────────────────────────────────────────────────────┘
                       ▼ miss / live=1
  ┌─────────────────────────────────────────────────────────────────┐
  │ Agent layer (runAgentLoop ×N)                                    │
  │   each tool_use →                                                 │
  │       ▼                                                            │
  └─────────────────────────────────────────────────────────────────┘
                       ▼
  ┌─────────────────────────────────────────────────────────────────┐
  │ L1  Intra-run cache                  BUILT                        │
  │   McpClient.callTool, client.ts L97–L146                          │
  │   key: `${name}:${JSON.stringify(args)}`                          │
  │   value: { result, expiresAt: now + 60_000 }                      │
  │   hit  →  return in 0ms; agent's tool-call budget intact          │
  │   miss →  liveCall → network → cache on success only              │
  └─────────────────────────────────────────────────────────────────┘
                       ▼ miss
  ┌─────────────────────────────────────────────────────────────────┐
  │ L2  Cross-run semantic cache         SKIPPED ON PURPOSE           │
  │     would key on embed(question), nearest-neighbor               │
  │     blast radius: every trajectory that matches → not safe        │
  │     for moving analytics data without freshness gates             │
  └─────────────────────────────────────────────────────────────────┘
                       ▼
  ┌─────────────────────────────────────────────────────────────────┐
  │ L3  Provider prompt-prefix cache     ABSENT                       │
  │     would set cache_control on the static system prompt          │
  │     covered in `../../study-ai-engineering/06-production-serving/01-llm-caching.md` │
  └─────────────────────────────────────────────────────────────────┘
                       ▼
                  MCP transport → Bloomreach

  IN:  intra-run (L1)  +  whole-run replay (L0)
  OUT: cross-run semantic (L2) — by deliberate design
       provider prefix cache (L3) — gap also covered in ai-eng
```

---

## Implementation in codebase

**Case A (partial) — the two scopes that are built.**

**Intra-run cache (Layer 1)**
**File:** `lib/mcp/client.ts`
**Function / class:** `McpClient.callTool`
**Line range:** L97–L146 (key at L102, TTL default at L103, read at L105–L110, error-no-cache at L137–L139, write at L143–L144)

The 60s TTL `Map` keyed on `name:JSON.stringify(args)`. Returns `{ result, durationMs: 0, fromCache: true }` on a hit (L108). On error, returns the result but does not cache (L137–L139). This is the cache the agent loops lean on for repeated tool calls within a single investigation.

**Whole-run replay (Layer 0)**
**File:** `app/api/agent/route.ts`
**Function / class:** the `GET` stream's cache-first branch (`getCachedInvestigation`)
**Line range:** L125–L141 (cache lookup at L127; event replay at L130–L140)

A captured investigation streams from disk, no agents run, no MCP calls, no Claude calls. Used by demo links (`insightId` without `live=1`). This is the coarsest cache — the *whole trajectory* is the value.

**Case B — what's deliberately skipped.**

**Cross-run semantic cache (Layer 2)**
**Honest sentence:** not implemented. A semantic cache would key on an embedding of the sub-question and return a cached prior result on a nearest-neighbor hit; the deliberate choice was to skip it because a stale hit poisons the whole trajectory (the agent reasons forward from a stale value, and every downstream turn inherits the error), and the analytics data is exactly the kind of moving target that makes "stale enough to matter" hard to detect.

**Provider prompt-prefix cache (Layer 3)**
**Honest sentence:** not set. The Anthropic Messages API supports `cache_control` markers on stable parts of the request; this codebase doesn't set them. Covered in detail in `../../study-ai-engineering/06-production-serving/01-llm-caching.md` (the ai-eng caching file).

```
shape (not full impl):
  // intra-run cache (client.ts L97–L146)
  const cacheKey = `${name}:${JSON.stringify(args)}`;
  const cached = this.cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { result: cached.result, durationMs: 0, fromCache: true };
  }
  // ...liveCall, retry, error checks...
  if (!isError) this.cache.set(cacheKey, { result, expiresAt: now + 60_000 });

  // whole-run replay (route.ts L125–L141)
  const cached = getCachedInvestigation(insightId);
  if (cached) {
    const stream = new ReadableStream({
      start(c) { for (const e of cached) { c.enqueue(encode(e)); await sleep(...); } }
    });
    return new Response(stream, { headers: NDJSON_HEADERS });
  }
```

---

## Elaborate

### Where this pattern comes from

Cross-turn caching as a *named* pattern emerged once agent runs became long-running multi-call sessions rather than single API requests. Single-call caching (the ai-eng version, `01-llm-caching.md`) covers the request-response cache; that pattern doesn't account for the same agent calling the same tool five times in one task. Anthropic's prompt-prefix caching (`cache_control`, 2024), OpenAI's automatic prefix caching, and the agent-framework patterns around intra-task memoization (LangChain's `cache=True` on tool calls, LlamaIndex's `ResponseCache`) are all instantiations of the same insight: cache at the scope where the saving compounds and the staleness is bounded.

### The deeper principle

There are three nested scopes a cache can occupy, and they trade hit rate against staleness blast radius along a Pareto curve. Intra-run sits near the sweet spot — high hit rate inside a task, low blast radius (one trajectory, bounded by TTL). Whole-run replay is even more lopsided (huge savings, blast radius is "the recording is stale" which is acceptable for demos). Cross-run semantic is the seductive next step: more hit rate, but the blast radius jumps to "every trajectory that matches the cached key," and the failure is silent because the model reasons confidently from whatever the cache returned. The principle: cache wider only when freshness is provably bounded against the value's use.

```
  scope of cache         marginal hit rate      marginal blast radius
  ──────────────         ─────────────────      ───────────────────────
  intra-run              high                   low (one run, TTL bounded)
  whole-run replay       very high              low (intentional snapshot)
  cross-run semantic     highest                trajectory-wide, silent
                                                 (needs freshness gates)
```

### Where this breaks down

The intra-run cache breaks if args aren't deterministic — a tool that takes a `now` timestamp or a session token as an argument will key on something that changes every call, and the cache will never hit. (`execute_analytics_eql` keys on an EQL string, which doesn't carry a timestamp, so this is fine here.) The whole-run replay breaks if the captured trajectory contains state the user expects to be current — a demo of a 6-month-old anomaly with "as of today" framing reads weird. Cross-run semantic breaks in the way already named: stale hits silently poison reasoning.

### What to explore next
- Single-call caching: `../../study-ai-engineering/06-production-serving/01-llm-caching.md` → the layer this file extends (per-call cache, prompt-prefix cache)
- Fan-out backpressure: `02-fan-out-backpressure.md` → concurrency control, the next layer of serving cost
- Per-tool circuit breaking: `03-per-tool-circuit-breaking.md` → what to do when the tool the cache fronts is sick

---

## Interview defense

### What an interviewer is really asking
When an interviewer asks "how do you cache an agent," they're testing whether you can name the scope of each cache and the blast radius of a stale hit at that scope. The strong signal is showing three scopes, what's in/out, and *why* — especially the cross-run cache, which is where most teams over-reach. The weak signal is naming one cache and stopping.

### Likely questions

[mid] Q: What gets cached in this system?

A: Two scopes. The intra-run cache is an in-memory `Map` in `McpClient` keyed on `${tool_name}:${JSON.stringify(args)}` with a 60-second TTL — same EQL within one investigation returns in 0 ms instead of paying the HTTP round trip and the 1.1s spacing. The whole-run replay is even coarser — the demo serves a captured investigation from disk without running any agents, MCP calls, or Claude calls. What's *not* cached is the prompt prefix (the static system prompts re-tokenize every turn) and a cross-run semantic cache.

Diagram:
```
  L0  whole-run replay (demo, route.ts L125–L141)         IN
  L1  intra-run Map (client.ts L102–L144, 60s TTL)        IN
  L2  cross-run semantic (not built)                       OUT
  L3  provider prompt-prefix cache                         OUT
```

[senior] Q: Why no cross-run semantic cache?

A: Blast radius. A stale intra-run hit hurts one trajectory, bounded by a 60s TTL and the fact that one investigation ends in seconds — small, contained, easy to reason about. A stale cross-run hit returns a possibly-out-of-date value to the model, which then reasons forward from it; every downstream turn in that trajectory is conditioned on the stale read. The failure is silent — the model doesn't know to flag it, the cache doesn't know to refresh it, and there's no exception. For live analytics data where things move hour-to-hour, "an hour ago" is sometimes right and sometimes catastrophically wrong, and you can't tell from the question alone. Building it safely needs freshness gates that are easy to get wrong, so the deliberate call was to not add it until we measured a real hit-rate need *and* had bounded the source's freshness.

Diagram:
```
   Intra-run stale hit                  Cross-run semantic stale hit
   ───────────────────                  ────────────────────────────
   one trajectory                       every matching trajectory
   60s TTL bounds it                    hours to days
   ends with the run                    silent across runs
   easy to test                         hard to even detect
```

[arch] Q: If a vector store ships beside MCP tomorrow, do any of these cache decisions change?

A: The intra-run cache stays — it's source-agnostic, keyed on tool name + args, and the vector store's calls go through the same `McpCaller` interface (`base.ts` L16) and get cached the same way. The whole-run replay stays — it's still a captured trajectory regardless of which tools ran in it. The cross-run semantic cache becomes *more* tempting because the vector store has higher per-call cost and a slower-moving index, but it's still the same blast-radius problem: a stale hit feeds the model a snapshot. What would change is the *option becomes viable* — a vector store over slow-moving narratives is exactly the case where cross-run caching could be safe with the right freshness gates. So the answer flips from "skipped because the data moves" to "now we'd evaluate per-source."

Diagram:
```
   today (EQL only)                tomorrow (EQL + vector)
   ─────────────────                ────────────────────────────────
   L1 intra-run: yes                L1 intra-run: yes (both sources)
   L2 cross-run semantic: no        L2 cross-run semantic: maybe,
                                       per source, with freshness gate
```

### The question candidates always dodge
Q: You said the prompt-prefix cache is a "separate gap." Isn't that the cache that would save the most money? Why isn't *that* the headline?

A: Honest answer: yes, the prompt prefix is the largest single line item by tokens, and `cache_control` would address it with a few lines of work. The reason it's not the headline of this file is scope — this file covers *cross-turn* caching, which is "caches whose value spans more than one Claude call." The prompt-prefix cache lives *inside* one Claude call (it short-circuits tokenization on a single request) and is covered in `../../study-ai-engineering/06-production-serving/01-llm-caching.md`, which is the right home for it. The split is real: per-call mechanics (caching, retry, rate-limit) sit in the ai-eng guide; the same mechanics extended to a loop or topology sit here. Naming it as a gap here is the honest acknowledgment that the per-call layer also has work to do; the layered fix is one `cache_control` field in `base.ts` L102 when we want it.

Diagram:
```
   per-call layer (ai-eng)         cross-turn layer (this file)
   ─────────────────────           ─────────────────────────────
   prompt-prefix cache              intra-run tool cache
   single-call retry                whole-run replay
   single-call backpressure         cross-run semantic (skipped)
                                    (each EXTENDS the per-call analog)
```

### One-line anchors
- "Three cache scopes — per-turn, intra-run, cross-run — and the blast radius of staleness widens with each."
- "Intra-run is a `Map` with a 60s TTL; whole-run replay is the demo; cross-run semantic is deliberately skipped."
- "The cross-run failure isn't 'wrong response' — it's 'wrong trajectory built on a stale read,' silent and trajectory-wide."
- "Cache wider only when freshness is provably bounded against the value's use."

---

## Validate your understanding

### Level 1 — Reconstruct the diagram
Close this file. Draw the three nested cache scopes (per-turn, intra-run, cross-run) plus the whole-run replay. Label which are built, which are absent, and the blast radius of each.

Open the file. Compare.

✓ Pass: you drew the three scopes nested by blast radius, labelled intra-run and whole-run as built, cross-run semantic and prompt-prefix as absent, and noted the blast radius widens as the scope does
✗ Fail: re-read How it works, wait 10 minutes, try again

### Level 2 — Explain it out loud
A colleague asks "why don't you semantic-cache the EQL calls across investigations?" No notes. Under 90 seconds.

Checkpoints — did you:
- Name the blast-radius argument (stale hit feeds the model, every downstream turn inherits it)?
- Distinguish "one trajectory affected" (intra-run) from "every matching trajectory affected" (cross-run)?
- Name the bounded TTL on the intra-run cache (60s) as the reason that scope works?
- Name the breakpoint at which cross-run could become safe (slow-moving data + freshness gates + measured hit-rate need)?

If you skipped any: you described it, you didn't understand it.

### Level 3 — Apply it to a new scenario
A new feature ships: a daily-batch aggregate over past investigations that updates every 24 hours. A user asks "show me the trend of cart abandonment across my last 10 investigations." Without opening the code: would a cross-run semantic cache earn its place here? Where would it slot in, and what freshness gate would you add?

Write your answer (4–6 sentences). Then open `lib/mcp/client.ts` L97–L146 to see where the cache layer would sit relative to the existing intra-run cache.

### Level 4 — Defend the decision you'd change
"You said the prompt-prefix cache is a gap. If you had two hours to ship one cache improvement to this codebase, would you add `cache_control` on Claude messages or build the cross-run semantic cache for tool results? Walk the cost-benefit: what does each save, what does each risk?"

Reference the code: point to `runAgentLoop` (`base.ts` L102) for where `cache_control` would slot on the Anthropic call, and `McpClient.callTool` (`client.ts` L97–L146) for where the semantic cache would intercept.

### Quick check — code reference test
Without opening any files:
- What file holds the intra-run cache and what's the TTL default?
- What's the cache key format (the string passed to `Map.get`)?
- What route file holds the whole-run replay branch, and what URL parameter bypasses it for a live re-run?

Open and verify. ✓ File + function names matter; line numbers drifting is fine.

## See also

→ 02-fan-out-backpressure.md · → 03-per-tool-circuit-breaking.md · → single-call caching: `../../study-ai-engineering/06-production-serving/01-llm-caching.md`

---
Updated: 2026-05-29 — created
Updated: 2026-05-30 — Migrated to study.md v1.47 template (Phase 1+2 mechanical): removed Tradeoffs / Tech reference / Summary sections; renamed "In this codebase" → "Implementation in codebase"; moved See also to a bottom block. "Why care" preserved pending Phase 3 (Zoom out, then zoom in + LAYERS diagram) authoring.
