# LLM caching

**Industry name(s):** response caching, prompt caching (`cache_control` / KV-cache reuse), semantic caching, exact-match cache
**Type:** Industry standard · Language-agnostic

> blooming insights caches at two layers it controls — a 60s exact-match `Map` over MCP tool results keyed `name:JSON.stringify(args)`, and a coarse whole-investigation replay cache — but does NOT cache the one thing that dominates the bill: the long static system prompts re-sent to Claude on every turn.

**See also:** → 02-llm-cost-optimization.md · → 04-rate-limiting-backpressure.md · → 05-retry-circuit-breaker.md · → ../04-agents-and-tool-use/README.md

---

## Why care

You memoize a pure function with a `Map`: hash the arguments, check the map, return the stored value on a hit, compute and store on a miss. The hit path is free; the miss path pays once. Every cache you have ever written — `useMemo`, React Query's `staleTime`, a `WeakMap` of parsed results — is this shape with a different key function and a different eviction rule.

An LLM application has three distinct things worth caching, and they sit at three different layers. The question this concept answers is: *which layer are you caching at, and is it the layer where the cost actually lives?*

**That distinction is the whole game.** Caching the wrong layer wastes engineering effort and leaves the bill untouched. blooming insights re-sends a multi-thousand-token system prompt to Claude on every single turn of every agent loop — and caches none of it. It caches the MCP tool results (cheap to re-fetch, but slow and rate-limited) and the finished investigation (so a demo replays without burning a key). The expensive layer — the repeated prompt prefix — is the one gap.

Before naming the layers:
- Same EQL query, same args, within 60s → re-hits Bloomreach over the network every time
- Same investigation viewed twice → re-runs three agents and ~15 Claude calls
- Same 2,000-token system prompt → re-tokenized and re-charged at full input price every turn

After the layers blooming insights built (and the one it skipped):
- Exact-match tool cache → identical EQL returns in 0 ms, no network, no rate-limit cost
- Investigation replay cache → a viewed investigation streams from disk, zero Claude calls
- Prompt cache (ABSENT) → the static prefix would re-cost ~10% of full input price on a hit

It is three `Map`-shaped ideas keyed differently: by tool args, by investigation id, and (the missing one) by prompt prefix.

---

## How it works

**Mental model.** An LLM request is `(static_prefix + dynamic_suffix) → tokens → response`. There are three places to short-circuit that pipeline, and they nest from coarse to fine. The outermost cache returns the whole *response* (skip everything). The middle cache returns a *tool result* the response needed (skip one network hop). The innermost cache reuses the *tokenized prefix* (skip re-charging the input you already sent). blooming insights owns the outer two and leaves the inner one on the table.

```
 request pipeline                          cache layer that short-circuits it
 ─────────────────────────────────────     ──────────────────────────────────────
 view investigation                    ◀──  L0  whole-response replay (built)
   └─ run agent loop
        └─ Claude call
             ├─ tokenize (prefix+suffix) ◀── L2  prompt cache  (cache_control) ABSENT
             └─ tool_use → MCP call     ◀──  L1  exact-match tool cache (built)
                  └─ Bloomreach network
```

L0 and L1 are application-level caches the codebase implements as plain `Map`s. L2 is a provider-side cache toggled by a field on the API request — blooming insights never sets that field.

---

### L1 — exact-match tool cache (`McpClient.callTool`)

This is the cache the codebase leans on hardest. Every MCP tool call passes through `callTool`, which keys a `Map` on the tool name plus a deterministic JSON serialization of every argument.

```
┌──────────────────────────────────────────────────────────────┐
│  Map<string, { result: unknown; expiresAt: number }>          │
│                                                               │
│  key:  "execute_analytics_eql:{\"eql\":\"top 10 keywords\"}" │
│  value: { result: <raw MCP response>,                         │
│           expiresAt: Date.now() + 60_000 }                    │
└──────────────────────────────────────────────────────────────┘
```

The cache key is built at `lib/mcp/client.ts` L35: `` const cacheKey = `${name}:${JSON.stringify(args)}` ``. The TTL defaults to `60_000` ms (L36). The read happens at L38–L42: if an entry exists and `cached.expiresAt > Date.now()`, the call returns `{ result, durationMs: 0, fromCache: true }` without touching the network. The write happens at L64–L65 on success only.

```
callTool("execute_analytics_eql", { eql })
   │
   ├─ key = "execute_analytics_eql:{...}"
   ├─ cache.get(key)?.expiresAt > now ?
   │     │ yes → return { result, durationMs: 0, fromCache: true }   ← L41
   │     │ no
   ├─ liveCall (network)                                              ← L46
   ├─ result.isError ? return WITHOUT caching                        ← L58–L60
   └─ cache.set(key, { result, expiresAt: now + 60s })               ← L65
```

The critical guard is no-cache-on-error at `lib/mcp/client.ts` L57–L60: an `isError` result is returned without a cache write, so a transient failure never poisons the cache for 60 seconds. This is the same rule React Query applies — queries cache, errors do not.

Within a single investigation, the diagnostic and recommendation agents frequently issue overlapping EQL queries. The 60s TTL means the second agent's identical query returns instantly from L1 instead of re-spending a network round-trip against Bloomreach's ~1 req/s ceiling.

---

### L0 — investigation replay cache (`lib/state/investigations.ts`)

This is a coarse, whole-response cache: instead of caching one tool result, it caches the *entire NDJSON event stream* a finished investigation produced. Viewing an already-run investigation replays the recorded events rather than re-running three agents.

```
getCachedInvestigation(insightId)
   │
   ├─ mem.has(insightId)        ? return mem.get(insightId)   ← L23  (in-process)
   ├─ dev file (PERSIST only)   ? return fromFile             ← L24  (.investigation-cache.json)
   └─ demo seed                 ? return fromDemo ?? null     ← L26  (committed JSON)
```

The lookup chain is at `lib/state/investigations.ts` L22–L28: in-memory `Map` first, then a dev-only on-disk file, then a committed demo seed. The write is `saveInvestigation` at L30–L41, called from the route after a live run completes (`app/api/agent/route.ts` L162).

The route wires this in at `app/api/agent/route.ts` L63–L81: when an `insightId` is requested and `live !== 1`, it pulls the cached event array and re-emits it through a `ReadableStream`, sleeping `REPLAY_DELAY_MS = 180` (L50) between events so the replay *feels* like a live run.

```
GET /api/agent?insightId=X            GET /api/agent?insightId=X&live=1
   │                                     │
   ├─ getCachedInvestigation(X)          ├─ skip cache (live=1)
   │     │ hit                           └─ run 3 agents, ~15 Claude calls,
   │     └─ replay NDJSON @ 180ms/event        then saveInvestigation(X)
   │        ZERO Claude calls
```

This is a response cache in the strict sense: the unit cached is the final user-visible output, not an intermediate. It is what makes a demo runnable without an API key — the most expensive possible operation (a full multi-agent run) collapses to a file read.

---

### L2 — prompt caching (`cache_control`) — ABSENT

This is the layer blooming insights does not implement, and it is the one that maps directly to the dominant cost. Every agent loads a static system prompt from disk (`monitoring.md`, `diagnostic.md`, `recommendation.md`, `query.md`) and re-sends it as the `system` field on *every* `anthropic.messages.create` call. A diagnostic run with `maxToolCalls: 6` makes up to 7 such calls, each re-paying full input price for the identical multi-thousand-token prefix.

Anthropic's prompt caching lets you mark a stable prefix with `cache_control: { type: 'ephemeral' }`. The provider tokenizes that prefix once, stores the KV-cache server-side for ~5 minutes, and on subsequent calls within the window charges a cache *read* rate (~10% of input price) instead of full input.

```
Without cache_control (current):
  turn 0  [system 2000 tok @ full] + [messages] → response
  turn 1  [system 2000 tok @ full] + [messages] → response   ← re-charged
  turn 2  [system 2000 tok @ full] + [messages] → response   ← re-charged
          ...                                                    7× full price

With cache_control on the static system prefix:
  turn 0  [system 2000 tok @ full, WRITE cache] + [messages] → response
  turn 1  [system 2000 tok @ ~10%, READ cache]  + [messages] → response
  turn 2  [system 2000 tok @ ~10%, READ cache]  + [messages] → response
          ...                                                    6× at ~10%
```

The semantic cache — "this question is close enough to a cached one, return the stored answer" — is also absent. blooming insights' L1 cache is strictly exact-match: `JSON.stringify(args)` must be byte-identical. A query of "top keywords last week" and "top 10 keywords last week" miss each other entirely. A semantic cache would embed the query and serve a neighbor above a similarity threshold; the codebase has no embeddings anywhere, so this is a deeper gap (see `03-retrieval-and-rag`).

---

### Current state vs future state

```
            cached today            absent
            ──────────────          ──────────────────────
L0 response  investigation replay    —
L1 tool      exact-match Map (60s)   —
L2 prompt    —                       cache_control prefix
L2.5 semantic —                      embedding-keyed neighbor cache
```

The two implemented layers attack *latency and rate-limit pressure* (re-fetching is slow and quota-bound). The absent layer attacks *cost* (re-tokenizing is what you pay for). They are orthogonal — implementing L2 would not change a single L1 hit, and vice versa.

---

### The principle

Cache at the layer where the cost lives. For a network-bound, rate-limited data source the cost is the round-trip, so you cache the *result* (L1). For a replayable demo the cost is the whole multi-agent run, so you cache the *response* (L0). For a model that re-tokenizes a fixed prefix every turn the cost is the *input tokens*, so you cache the *prefix* (L2). Each layer is a `Map` with a different key and a different thing stored; choosing the right one is choosing the right key.

---

## LLM caching — diagram

This diagram spans all four layers across the UI, Route, Agent, and Provider boundaries. The two solid boxes are built; the two dashed boxes are the gaps.

```
  ┌────────────────────────────────────────────────────────────────────┐
  │  UI / ROUTE LAYER   app/api/agent/route.ts                          │
  │                                                                     │
  │  GET /api/agent?insightId=X                                         │
  │       │                                                             │
  │  ┌────▼─────────────────────────────────────────────┐              │
  │  │  L0  investigation replay cache  (BUILT)          │              │
  │  │  getCachedInvestigation(X)  L63                   │              │
  │  │   hit → replay NDJSON @ 180ms, 0 Claude calls     │              │
  │  └────┬─────────────────────────────────────────────┘              │
  │       │ miss / live=1                                               │
  └───────┼──────────────────────────────────────────────────────────────┘
          │
  ┌───────▼──────────────────────────────────────────────────────────────┐
  │  AGENT LAYER   lib/agents/                                            │
  │                                                                       │
  │  runAgentLoop → anthropic.messages.create({ system, messages })      │
  │       │                                                               │
  │  ┌────┴───────────────────────────────────────────────┐             │
  │  ╎  L2  prompt cache  (ABSENT)                          ╎             │
  │  ╎  static system prefix re-sent at full price/turn     ╎             │
  │  ╎  would set cache_control: { type:'ephemeral' }       ╎             │
  │  └────────────────────────────────────────────────────┘             │
  │       │ tool_use block                                                │
  └───────┼──────────────────────────────────────────────────────────────┘
          │  mcp.callTool(name, args)
  ┌───────▼──────────────────────────────────────────────────────────────┐
  │  PROVIDER / MCP LAYER   lib/mcp/client.ts                             │
  │                                                                       │
  │  ┌────────────────────────────────────────────────────┐             │
  │  │  L1  exact-match tool cache  (BUILT)                │             │
  │  │  key = name:JSON.stringify(args)   L35              │             │
  │  │  ttl = 60_000   L36                                 │             │
  │  │  hit → durationMs:0, fromCache:true   L41           │             │
  │  │  no-cache-on-error   L57–L60                        │             │
  │  └────────────────────────────────────────────────────┘             │
  │       │ miss → liveCall → Bloomreach MCP                              │
  └───────────────────────────────────────────────────────────────────────┘
```

A reader who sees only this diagram should grasp: two caches are built and protect latency/quota; the cost-bearing prompt layer is the dashed gap.

---

## In this codebase

This is partially implemented — two of the three layers exist.

### L1 exact-match tool cache (Case A)

**File:** `lib/mcp/client.ts`
**Function / class:** `McpClient.callTool`
**Line range:** L30–L67 (key L35, ttl L36, read L38–L42, no-cache-on-error L57–L60, write L64–L65)

The cache field is `private cache = new Map<string, { result; expiresAt }>()` at L18. Default TTL `60_000` ms. Key format `` `${name}:${JSON.stringify(args)}` ``. A `skipCache` option (L38) bypasses the read but still writes through (L62–L63 comment), serving the `/debug` force-refresh path.

### L0 investigation replay cache (Case A)

**File:** `lib/state/investigations.ts`
**Function / class:** `getCachedInvestigation` (read), `saveInvestigation` (write)
**Line range:** read L22–L28, write L30–L41

Three-tier lookup: in-memory `Map` (L23) → dev file `.investigation-cache.json` (L24, dev only) → committed demo seed (L26). Wired into the route at `app/api/agent/route.ts` L63–L81 (replay branch, `REPLAY_DELAY_MS = 180` at L50) and L162 (`saveInvestigation` after a live run).

### L2 prompt caching (Case B — Not yet implemented)

**Not yet implemented.** blooming insights re-sends each agent's static system prompt at full input price on every turn — the `system` field at `lib/agents/base.ts` L98 carries the multi-thousand-token prefix loaded by `readFileSync` in each agent (e.g. `lib/agents/query.ts` L13), with no `cache_control` marker anywhere.

Where it would live: the `params` object constructed at `lib/agents/base.ts` L92–L100. The static prefix would move into a structured `system` array with a `cache_control: { type: 'ephemeral' }` block on the stable portion, leaving the per-run variable text (anomaly JSON, schema summary) outside the cached span. The semantic cache would live as a new module beside `lib/mcp/client.ts`, keyed on an embedding of the `?q=` query — but the codebase has no embedding infrastructure today (see `03-retrieval-and-rag`).

---

## Elaborate

### Where this pattern comes from

Response caching predates LLMs by decades — it is HTTP `Cache-Control` and the `staleTime` of every data-fetching library. Exact-match request caching (L1) is the cache-aside pattern: the application owns the cache, populates on miss, returns on hit. **Prompt caching** (L2) is newer and provider-specific: Anthropic shipped `cache_control` in 2024 to amortize the cost of long, stable prefixes (system prompts, few-shot examples, large documents) across a conversation. **Semantic caching** comes from the RAG world — embed the query, retrieve the nearest cached answer, serve it if similarity clears a threshold (GPTCache popularized this in 2023).

### The deeper principle

```
  what you cache        keyed by             cost it removes
  ──────────────────    ─────────────────    ───────────────────
  whole response (L0)   investigation id     entire agent run
  tool result   (L1)    name + args hash     network round-trip
  prompt prefix (L2)    the prefix itself    input tokenization
  semantic      (L2.5)  query embedding      a near-duplicate call
```

Caches are not interchangeable. Each removes a *different* cost, so the right question is never "do we cache?" but "which cost is dominant and which cache removes it?" blooming insights correctly identified that network round-trips against a 1 req/s source are painful, and cached those. It has not yet acted on the input-token cost.

### Where this breaks down

The L1 `Map` is per-process and unbounded. On a Vercel serverless cold start the cache is empty — every cold-start request is a guaranteed miss. The `Map` never evicts on size, so a long-lived process accumulating many distinct queries grows without bound (in practice the tool-call set is small, so this has not bitten). Exact-match keying means cosmetically different but semantically identical queries miss each other entirely.

Prompt caching has its own sharp edge: the cached prefix must be byte-stable. If the system prompt interpolates anything per-call (a timestamp, the anomaly JSON) *before* the `cache_control` boundary, every call invalidates the cache and you pay the write rate every time with zero hits. The cache also expires ~5 minutes after last use, so it helps within a burst, not across cold spells.

### What to explore next

- Anthropic prompt caching (`cache_control`) — the primary cost lever this codebase has not pulled; see `02-llm-cost-optimization.md`
- `lru-cache` / `node-cache` — bounded eviction for the L1 `Map` to cap memory under high query cardinality
- Stale-while-revalidate — return the cached tool result immediately while refreshing in the background, extending L1's benefit without lengthening staleness
- GPTCache / semantic caching — embedding-keyed neighbor lookup for the `?q=` query path, once embeddings exist

---

## Tradeoffs

| Dimension | This codebase (L0 + L1 only) | Add L2 prompt cache | Add L2.5 semantic cache |
|---|---|---|---|
| Cost removed | network round-trips, full re-runs | repeated input tokens (the bill driver) | near-duplicate model calls |
| Setup complexity | zero — two `Map`s | low — one request-field change + a stable-prefix split | high — embedding model, vector store, threshold tuning |
| Hit precision | exact (L1), per-id (L0) | exact prefix match | fuzzy — risks serving a wrong-but-close answer |
| Survives cold start | no (in-memory) | yes (provider-side, ~5 min) | depends on store |
| Failure mode | cold-start misses; unbounded growth | invalidates if prefix not byte-stable | false hits below a bad threshold |

**What we gave up.** By caching only L0 and L1, blooming insights leaves the input-token cost untouched. A diagnostic run re-sends its full system prompt 6–7 times; with `cache_control` the 2nd through 7th calls would read the prefix at ~10% price. For a demo-stage app that mostly replays from L0 (zero Claude calls), this gap is nearly free — the cost only materializes on live runs. That is why skipping L2 was right *for now*: the L0 replay cache means the common path never reaches Claude at all.

**What the alternative would have cost.** Implementing L2 well requires splitting each system prompt into a byte-stable cached prefix and a per-run variable suffix, then verifying the prefix never changes (a timestamp slipping into the prefix silently zeroes the hit rate). That is real work for a payoff that only shows up on live, non-replayed runs. The semantic cache costs far more — an embedding model, a vector index, threshold tuning, and the risk of serving a confidently-wrong neighbor.

**The breakpoint.** L0 + L1 is sufficient while most traffic is replayed demos and live runs are rare. The moment live `?live=1` runs become the common path — real users investigating fresh anomalies daily — the repeated system-prompt cost compounds and L2 prompt caching becomes the highest-ROI change in the codebase. The trigger is "live runs per day × agents per run × turns per agent" crossing into the hundreds of full-price prefix re-sends.

---

## Tech reference (industry pairing)

### in-memory Map (cache-aside, exact-match)

- **Codebase uses:** `Map<string, {result, expiresAt}>` in `McpClient` (`lib/mcp/client.ts` L18) and `Map<string, AgentEvent[]>` in `lib/state/investigations.ts` L11.
- **Why it's here:** zero dependencies, exact-match keying on serialized tool args, instant hit path for repeated EQL within a run.
- **Leading today:** `lru-cache` (npm) for bounded in-process caches (adoption-leading, 2026); Redis/Upstash for cross-instance (innovation-leading for serverless, 2026).
- **Why it leads:** `lru-cache` adds size-based eviction the raw `Map` lacks; Redis survives cold starts and coordinates across serverless instances.
- **Runner-up:** `node-cache` — built-in TTL expiry callbacks, drop-in for the manual `expiresAt` check.

### Anthropic prompt caching (`cache_control`)

- **Codebase uses:** nothing — no `cache_control` field is set on any `anthropic.messages.create` call.
- **Why it's here:** it is the named gap; the static system prefix at `lib/agents/base.ts` L98 is the obvious candidate.
- **Leading today:** Anthropic ephemeral prompt caching (adoption-leading for Claude apps, 2026); OpenAI automatic prompt caching (innovation-leading — no opt-in field, 2026).
- **Why it leads:** Anthropic's explicit `cache_control` gives precise control over the cached span; OpenAI's automatic caching removes the byte-stability footgun entirely.
- **Runner-up:** self-hosted KV-cache reuse (vLLM `--enable-prefix-caching`) for teams running open models.

### semantic caching

- **Codebase uses:** nothing — the L1 cache is strictly exact-match on `JSON.stringify(args)`.
- **Why it's here:** the `?q=` free-form query path (`app/api/agent/route.ts` L135) is the candidate surface where near-duplicate questions recur.
- **Leading today:** GPTCache (adoption-leading open-source semantic cache, 2026); managed semantic caches in LangChain / Vercel AI SDK (innovation-leading, 2026).
- **Why it leads:** GPTCache bundles embedding + vector store + threshold logic; managed caches remove the operational surface.
- **Runner-up:** a hand-rolled embedding + cosine-threshold lookup over a small `Map` for low query volume.

---

## Project exercises

### Add `cache_control` to the static system-prompt prefix

- **Exercise ID:** B5.2 (adapted) — provenance C5.1 (caching).
- **What to build:** Split each agent's `system` prompt into a byte-stable cached prefix and a per-run variable suffix, then attach `cache_control: { type: 'ephemeral' }` to the prefix block in the `params` constructed by `runAgentLoop`. Move per-run interpolation (anomaly JSON, schema summary) into the uncached suffix so the prefix stays identical across turns.
- **Why it earns its place:** it is the single highest-ROI cost change in the codebase and demonstrates you can identify *where the cost actually lives* (input tokens), not just where caching is easy.
- **Files to touch:** `lib/agents/base.ts` (the `params` build at L92–L100), each agent's prompt assembly (`lib/agents/diagnostic.ts`, `lib/agents/recommendation.ts`, `lib/agents/query.ts`, `lib/agents/monitoring.ts`).
- **Done when:** a live diagnostic run shows `cache_creation_input_tokens` on turn 0 and `cache_read_input_tokens` (not full `input_tokens`) on turns 1–6 in `res.usage`, proving the prefix is being read from cache.
- **Estimated effort:** 1–4hr.

### Bound the L1 tool cache with LRU eviction

- **Exercise ID:** C5.1 (caching) — fresh, no clean Build map.
- **What to build:** Replace the raw `Map` in `McpClient` with an `lru-cache` instance capped at a max entry count, preserving the `name:JSON.stringify(args)` key and 60s TTL.
- **Why it earns its place:** shows you spotted the unbounded-growth failure mode and chose a bounded cache without changing the cache-aside contract.
- **Files to touch:** `lib/mcp/client.ts` (the `cache` field L18 and `callTool` read/write at L38–L42, L64–L65).
- **Done when:** the existing `test/mcp/client.test.ts` suite still passes and a new test proves the cache evicts the least-recently-used entry past the cap.
- **Estimated effort:** <1hr.

---

## Summary

blooming insights caches at two layers it owns: an exact-match `Map` over MCP tool results (`lib/mcp/client.ts`, 60s TTL, keyed on `name:JSON.stringify(args)`, no-cache-on-error) and a coarse whole-investigation replay cache (`lib/state/investigations.ts`) that lets a finished investigation stream from disk with zero Claude calls. Both attack latency and rate-limit pressure. The layer it skips — Anthropic prompt caching via `cache_control` on the repeated static system prefix — is the one that attacks cost, and is the primary buildable target. A semantic cache is a deeper gap, blocked on the absence of any embedding infrastructure.

**Key points:**
- There are three cache layers — whole-response (L0), tool-result (L1), prompt-prefix (L2) — and they each remove a *different* cost.
- L1 keys on `name:JSON.stringify(args)` and never caches an error result (`lib/mcp/client.ts` L57–L60), so a transient failure cannot poison the cache.
- L0 replay (`lib/state/investigations.ts`) collapses a full multi-agent run to a file read — the reason the demo runs without an API key.
- The static system prompt is re-sent at full input price every turn; `cache_control` would cut turns 2–N to ~10% — the unbuilt cost lever.
- Exact-match caching misses semantically identical queries; a semantic cache needs embeddings the codebase does not have.

---

## Interview defense

### What an interviewer is really asking

"How do you cache an LLM app?" is testing whether you know that an LLM request has *multiple* cacheable layers and that the cheap-to-build layer is rarely the cost-bearing one. The weak answer is "I put responses in Redis." The strong answer names the layers, says which cost each removes, and points at the one that moves the bill — prompt caching of the repeated prefix.

### Likely questions

**[mid] What does blooming insights' tool cache key on, and why does it never cache errors?**

It keys on `` `${name}:${JSON.stringify(args)}` `` (`lib/mcp/client.ts` L35) — tool name plus deterministic arg serialization. It skips the cache write when `result.isError === true` (L57–L60) because caching a 429 or a failure for 60s would serve that failure to every caller for a full minute with no retry.

```
  result.isError ?
   ┌── true  → return, NO cache write  (L58–L60)
   └── false → cache.set(key, {result, expiresAt: now+60s})  (L65)
```

**[senior] You re-send a 2,000-token system prompt every turn. What does that cost and how do you fix it?**

Every turn re-charges the full prefix at input price. A diagnostic run (`maxToolCalls: 6`) makes up to 7 calls — 7× full prefix. The fix is `cache_control: { type: 'ephemeral' }` on the stable prefix: turn 0 writes the cache, turns 1–6 read it at ~10% input price.

```
  turn 0  prefix @ full (cache WRITE)
  turn 1  prefix @ ~10% (cache READ)
   ...
  turn 6  prefix @ ~10% (cache READ)
```

**[arch] Your L1 cache is an in-memory Map. What breaks at scale, and what replaces it?**

Per-process state. On serverless, each cold start gets an empty `Map` — every cold-start request is a forced miss. Two concurrent instances also can't share hits. The replacement is a shared store (Redis/Upstash) keyed identically, surviving cold starts and coordinating across instances.

```
  Instance A: Map{ } ── miss ── Bloomreach
  Instance B: Map{ } ── miss ── Bloomreach   ← no shared hit
                                              fix: one Redis key both read
```

### The question candidates always dodge

**"Why not just cache the final LLM response and call it done?"**

Because blooming insights *does* (L0 replay) — and that only helps when the exact same investigation is re-viewed. It does nothing for a *new* investigation that re-sends the same system prompt, and nothing for two near-identical free-form queries. Response caching, tool caching, and prompt caching are not substitutes; each covers a path the others miss. Naming that is the signal.

### One-line anchors

- `lib/mcp/client.ts` L35 — cache key `name:JSON.stringify(args)`
- `lib/mcp/client.ts` L57–L60 — no-cache-on-error guard
- `lib/state/investigations.ts` L22–L28 — three-tier replay lookup
- `app/api/agent/route.ts` L63–L81 — replay branch, `REPLAY_DELAY_MS = 180`
- `lib/agents/base.ts` L98 — the un-cached static `system` prefix (the gap)

---

## Validate

### Level 1 — Reconstruct

From memory, draw the four-layer cache stack (L0 response, L1 tool, L2 prompt, L2.5 semantic). For each, name what is cached, what it is keyed by, and which cost it removes. Mark which two are built in blooming insights.

### Level 2 — Explain

Out loud: explain why caching the tool results (L1) does nothing to reduce the input-token bill, and why caching the prompt prefix (L2) does nothing to reduce network round-trips. Why are they orthogonal?

### Level 3 — Apply

Scenario: a live diagnostic run is slow and expensive. Open `lib/agents/base.ts` L92–L100. The `system` field is re-sent every turn. Identify exactly where you would insert the `cache_control` boundary, and state what per-run text must move *out* of the cached prefix to keep it byte-stable. Then check `lib/agents/diagnostic.ts` to confirm what variable text gets interpolated into the diagnostic system prompt.

### Level 4 — Defend

A teammate says "remove the L0 investigation replay cache — it makes the demo show stale data." State the concrete cost of removing it: how many Claude calls a single re-viewed investigation would then make (three agents, each up to 6 tool calls + a synthesis call). Then defend why the no-cache-on-error rule in L1 already addresses the "stale bad data" worry that L0 raises.

### Quick check — code reference test

What is the default TTL of the L1 tool cache, and on which line is it set? (Answer: `60_000` ms, `lib/mcp/client.ts` L36.)
