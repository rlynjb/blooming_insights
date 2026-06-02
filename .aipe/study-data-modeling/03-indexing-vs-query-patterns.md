# Indexing vs query patterns

**Industry name(s):** Indexing · query plan · N+1 · access path · the "frequent query, no index" smell
**Type:** Industry standard · Language-agnostic

> **Not yet exercised in this repo** — the honest framing. There are no DB queries because there's no DB; the in-memory `Map`s in `lib/state/insights.ts` are accessed by key, which is constant-time by construction (no index needed). The topic still earns a file because the **upstream Bloomreach store** is a real database the repo queries against — and the access path is **EQL recipes**. That's the closest cousin. This file walks how the EQL queries are shaped, where the rate limit is the real cost (not query time), and what the repo would have to build if it ever owned a queryable store of its own.

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Two stores, two regimes. The in-memory `Map`s the repo owns are key-only — `get(id)` is the only access pattern, and `Map` is already a hash. The Bloomreach upstream is a real columnar event store accessed through EQL via the MCP layer. The repo's "queries" against it are short DSL strings constructed in `lib/agents/categories.ts` (the static recipes) and assembled live by the diagnostic and recommendation agents from prompts.

```
  Zoom out — two stores, two regimes

  ┌─ UI client band ─────────────────────────────────────────┐
  │  reads insights/investigations by id                       │
  │  (no query layer in the client — typed objects only)       │
  └────────────────────────────┬─────────────────────────────┘
                               │ GET /api/agent?insight=…
  ┌─ Route handler band ───────▼─────────────────────────────┐
  │  getInsight(id), getAnomaly(id), getInvestigation(id)     │
  │  → Map.get(id)  ★ O(1) by construction (no index needed)  │
  └────────────────────────────┬─────────────────────────────┘
                               │ agent.scan(), agent.investigate()
  ┌─ Agent loop band ──────────▼─────────────────────────────┐
  │  monitoring agent runs the CATEGORIES recipes             │
  │  diagnostic/recommendation construct EQL live              │
  └────────────────────────────┬─────────────────────────────┘
                               │ mcp.callTool('execute_analytics_eql', { eql, ...})
  ┌─ MCP wrapper band ─────────▼─────────────────────────────┐
  │  McpClient + spacing gate (1.1s between calls)            │
  │  the rate limit IS the cost; query time isn't measured    │
  └────────────────────────────┬─────────────────────────────┘
                               │ HTTPS → Bloomreach
  ┌─ UPSTREAM store ───────────▼─────────────────────────────┐
  │  Bloomreach Engagement — columnar event store              │
  │  indexes/partitions/sharding: opaque                       │
  │  the only "access path" the repo controls is the EQL it    │
  │  writes against it                                         │
  └──────────────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question this topic asks is: do the indexes that exist support the queries actually run? **For the in-memory store, the answer is trivial — `Map.get(id)` is the only access pattern and `Map` is the index.** For the Bloomreach upstream, the answer is **the repo can't see the indexes**, and the cost it actually pays isn't query time — it's the 1-request-per-second rate limit, which makes "minimize the number of round-trips" the equivalent of "minimize the index lookups." This file unpacks both.

---

## Structure pass

**Layers.** Same four-layer stack. The interesting layers for queries are the **agent loop band** (where queries are constructed) and the **MCP wrapper band** (where the spacing gate enforces the real cost).

**Axis: round-trip cost.** For each query, what does it cost? Not in CPU or IO — in *MCP round-trips against a 1 req/s limit*. The agent budget (6 tool calls per loop) is the equivalent of a query budget. Pick the right axis because in a normal DB, "cost" is index scan vs seq scan; here, "cost" is one more 1-second wait. That changes which optimizations matter.

**Seams.** Three matter. **Seam 1: in-memory store ↔ readers.** No index needed — `Map` is already O(1) by key. **Seam 2: EQL recipes ↔ rate limit.** Each recipe is one round-trip and one rate-limit slot. The static recipes in `categories.ts` are designed to bundle multiple metrics into one EQL call (file 03's exemplar). **Seam 3: agent loop ↔ EQL.** The diagnostic and recommendation agents construct EQL *during* the loop, with the budget guardrails in `runAgentLoop` capping the round-trip count at 6.

```
  Structure pass — round-trip cost across seams

  ┌─ 1. LAYERS ──────────────────────────────────────────────┐
  │  UI · Route · Agent loop · MCP wrapper                    │
  └─────────────────────────────┬────────────────────────────┘
                                │  pick the axis
  ┌─ 2. AXIS ──────────────────▼─────────────────────────────┐
  │  round-trip cost: how many 1-second slots does this query │
  │  spend? (not CPU; not IO — wall-clock under a rate limit) │
  └─────────────────────────────┬────────────────────────────┘
                                │  trace across seams
  ┌─ 3. SEAMS ─────────────────▼─────────────────────────────┐
  │  S1: in-memory Maps ↔ readers   ★ O(1) — no index needed │
  │  S2: EQL recipes ↔ rate limit   ★ BUNDLED (multi-metric)  │
  │  S3: agent loop ↔ EQL           ★ BUDGETED (maxToolCalls) │
  └─────────────────────────────┬────────────────────────────┘
                                ▼
                        Block 4 — How it works
```

---

## How it works

### Move 1 — the access-path picture, both stores

You know how `dict[key]` in Python is O(1) — no index needed because the hash IS the index? That's the in-memory store. Now imagine the *other* store is a remote service that returns whatever you ask for, but only lets you ask once per second. The optimization isn't "use the right index" — it's "ask for as many things as you can per ask." Different shape entirely.

```
  the two access regimes

  IN-MEMORY                        REMOTE-WITH-RATE-LIMIT
  ┌─ store ─────────┐              ┌─ store ─────────────────┐
  │ Map<id, value>  │              │ Bloomreach (opaque)     │
  │ (insights,      │              │ accessed via EQL        │
  │  anomalies,     │              │ rate-limited 1 req/s    │
  │  investigations)│              └─────────────┬───────────┘
  └────────┬────────┘                            │
           │ get(id)                             │ mcp.callTool(eql)
           ▼                                     ▼
       O(1) hash                          ~1s wall-clock per call
       (no index needed)                  (the bottleneck)

  optimization moves:                    optimization moves:
    none — the data shape IS              1. bundle metrics into one EQL
    the access path                        2. share calls between agents
                                           3. cache identical calls
                                              (TTL cache in McpClient)
                                           4. cap the agent's call budget
                                              (maxToolCalls)
```

### Move 2 — the in-memory store, walked

There's not much to walk. The three `Map`s in `lib/state/insights.ts` are accessed by id; that's it. **One operation per Map:**

```
  the in-memory queries — all are single-key lookups

  Map                  read                       write              cost
  ───────────────────  ─────────────────────────  ─────────────────  ────
  insights             getInsight(id)             putInsights(...)   O(1)
  anomalies            getAnomaly(id)             putInsights(...)   O(1)
  investigations       getInvestigation(id)       putInvestigation() O(1)

  the only iteration:
    listInsights()  →  [...insights.values()]
                       O(n) — used by the briefing list endpoint
                       n ≤ 10 (capped by monitoring agent's slice(0, 10))
```

What breaks if a query pattern emerges that ISN'T by id: nothing, today — there is none. The hypothetical that would force an index: "find all insights with `severity === 'critical'` from the last hour." Today that'd be `O(n)` iteration. With n ≤ 10 it doesn't matter. With n in the thousands, you'd want a secondary index keyed by `severity` (or `category`, or `timestamp` bucket). The repo isn't there.

### Move 2 — the EQL recipes, walked

The `CATEGORIES` registry in `lib/agents/categories.ts` (L19–L112) declares 10 recipes — one per anomaly category. Each is a function that takes `projectId` and returns an EQL string. **One recipe per category, designed to be one round-trip:**

```
  the recipe pattern — multi-metric in one call

  category              eql(projectId) →
  ──────────────────    ────────────────────────────────────────────────
  conversion_drop       select count event view_item,
                              count event checkout,
                              count event purchase
                          in last 90 days
                          ↑ THREE metrics, ONE round-trip

  cart_abandonment      select count event cart_update,
                              count event checkout,
                              count event purchase
                          in last 90 days
                          ↑ THREE metrics, ONE round-trip

  revenue_drop          select sum event purchase.total_price,
                              count event purchase
                          in last 90 days
                          ↑ TWO metrics, ONE round-trip
```

This is the **batching pattern** equivalent to a JOIN in SQL — bundle the related metrics into one query rather than firing N queries. The win isn't query-engine optimization (the upstream might run each metric as a separate scan internally — we can't see); the win is **fewer rate-limit slots**. With a 1 req/s limit and a 6-call budget per agent run, bundling three metrics into one EQL is a 3× win on what fits in the budget.

What breaks if you split a recipe into three single-metric queries: each one burns a rate-limit slot and a budget slot. A monitoring agent with 10 categories and 3 metrics each would need 30 slots; today the recipes pack them into 10 — and the monitoring prompt's "suggested query plan" further packs them into ~5 (`prompts/monitoring.md` L41–L47).

### Move 2 — the agent loop's budget gate

The monitoring agent caps tool calls at 6. The diagnostic agent caps at 6. The recommendation agent caps at 4. These are explicit `maxToolCalls` arguments to `runAgentLoop` (`monitoring.ts` L101, `diagnostic.ts` L62, `recommendation.ts` L57). The budget IS the query plan limit. When the budget is exhausted, `runAgentLoop` switches to a tool-less synthesis turn — the agent must conclude from what it already gathered.

```
  the budget — query-plan cap per agent

  agent              maxToolCalls   what it spends them on
  ─────────────────  ────────────   ──────────────────────────────────
  monitoring         6              ~5 EQL queries to compute the
                                    coverage-grid metrics; 1 spare for
                                    a breakdown or sparkline

  diagnostic         6              EQL queries to test 2-3 hypotheses
                                    (each hypothesis ~2 queries on average)

  recommendation     4              EQL queries to check whether a
                                    candidate Bloomreach feature already
                                    exists (e.g. find existing segments)

  what breaks past the budget:
    runAgentLoop sets `forceFinal: true` and removes tools from the next
    Anthropic call. the synthesisInstruction says "you have NO more tool
    calls — answer with what you have." the agent is forced to conclude.
```

What this models in DB terms: it's a **query-cost ceiling**. SQL has `statement_timeout` and connection-pool limits; this is the equivalent for an LLM-driven query plan.

### Move 2 — the cache (the only "index" the repo owns)

`McpClient` has a TTL cache keyed by `${name}:${JSON.stringify(args)}` (mentioned in `study-software-design/03-information-hiding-and-leakage.md` as a strong hide). Identical tool calls within the TTL skip the network round-trip and return cached results.

```
  the cache — a degenerate index, by content hash

  key = `${toolName}:${JSON.stringify(args)}`
                          ↑
                          this is effectively the query-result hash;
                          identical (name, args) → identical result

  cache hit:    skip network + skip rate-limit slot
  cache miss:   round-trip + spacing-gate wait + store on success

  what it indexes against:  the EXACT tool-call signature
  what it doesn't help:     two queries with different args that
                            return overlapping data (no partial
                            cache, no rewrite)
```

In a real query engine, the cache analog is a result cache or materialized view. This one is the dumbest possible version (exact match on a serialized key); the repo's queries are stable enough that this is plenty.

### Move 2 — what's NOT here (the honest "not yet exercised")

The classic data-modeling concerns under this heading don't apply because the substrate doesn't exist:

- **No covering indexes** — there are no relational tables to add `CREATE INDEX` to.
- **No N+1 queries** — there are no joins to N+1 over. The closest pattern would be: "for each insight, fetch its investigation." Today that's not a real read path — the investigate page receives the insight id and starts an agent run; investigations are stored by `insightId` and read individually. With a relational store, this would be the place to add an index on `Investigation.insightId` (which IS the PK in the current Map, so trivially indexed).
- **No query plans to read** — the EQL is a DSL whose execution plan is opaque. The repo can write the EQL but can't see how Bloomreach executes it.
- **No partial indexes / functional indexes / GIN indexes** — same reason as above.

### Move 3 — the principle

The right index is the one that matches the access path. When the access path is "by id," a hash is the only index. When the access path is "by content over a rate-limited remote," the optimization moves UP a layer — bundle, cache, budget. The data-modeling skill doesn't translate; the *spirit* does — every query has a cost, name the cost, design the access path to minimize it. In this repo, the cost is rate-limit slots, and the design moves are the bundled recipes plus the budget gate plus the TTL cache. None of them look like an index, but all of them play the same role.

---

## Primary diagram

Access paths and their costs, recap.

```
  the access paths — both stores, both regimes

  ┌─ IN-MEMORY (owned by the repo) ─────────────────────────┐
  │                                                            │
  │   insights: Map<id, Insight>          ─┐                   │
  │   anomalies: Map<id, Anomaly>         ─┤  get(id) — O(1)   │
  │   investigations: Map<insightId, Inv> ─┘                   │
  │                                                            │
  │   listInsights() — O(n), n ≤ 10                            │
  │                                                            │
  │   "indexes" needed today: none                             │
  │                                                            │
  └────────────────────────────────────────────────────────────┘

  ┌─ BLOOMREACH UPSTREAM (queried via EQL) ─────────────────┐
  │                                                            │
  │   static recipes:                                          │
  │     CATEGORIES[].eql(projectId)   ← 10 bundled recipes     │
  │     each runs as ONE round-trip                            │
  │                                                            │
  │   live construction:                                       │
  │     diagnostic/recommendation agents write EQL              │
  │     during the agent loop                                  │
  │                                                            │
  │   cost layer:                                              │
  │     McpClient spacing gate (1.1s between calls)            │
  │     TTL cache (exact-match on toolName + args)             │
  │     agent budget (maxToolCalls per agent)                  │
  │     forceFinal synthesis when budget exhausted             │
  │                                                            │
  │   "indexes" needed today: none — the repo can't add them   │
  │                                                            │
  └────────────────────────────────────────────────────────────┘
```

---

## Implementation in codebase

### The in-memory access paths

```
lib/state/insights.ts  (lines 44–54)

  export function getInsight(id: string): Insight | null {
    return insights.get(id) ?? null;          ← Map.get, O(1)
  }

  export function getAnomaly(id: string): Anomaly | null {
    return anomalies.get(id) ?? null;
  }

  export function listInsights(): Insight[] {
    return [...insights.values()];            ← O(n); n capped at 10 by the
  }                                            ← monitoring agent's slice(0, 10)
       │
       └─ no secondary indexes. no filtering. no sorting. the only access
          pattern is "give me this id" (or "give me all"). that's why
          there's no index layer.
```

### A bundled EQL recipe

```
lib/agents/categories.ts  (lines 24–33)

  {
    id: 'conversion_drop',
    label: 'conversion rate drop',
    requires: ['view_item', 'checkout', 'purchase'],
    whyItMatters: '...',
    eql: () => `select count event view_item,
                       count event checkout,
                       count event purchase
                  in last 90 days`,           ← THREE metrics in ONE round-trip
    thresholds: { critical: 20, warning: 10 },
  }
       │
       └─ this is the "covering index" analog for the rate-limit world:
          ask for everything the category needs in one call. firing three
          separate `count event` calls would burn 3× the budget and 3×
          the rate-limit slots for the same data.
```

### The budget gate

```
lib/agents/monitoring.ts  (lines 100–106)

  maxTurns: 8,
  maxToolCalls: 6, // hard cap — bounds latency under the 1 req/s MCP limit
  synthesisInstruction:
    'You have NO more tool calls available. Stop querying now and output ' +
    'your final answer. Respond with ONLY a JSON array of anomaly objects ' +
    'in a ```json fence (or [] if nothing meaningful), based on the data ' +
    'you have already gathered.',
       │
       └─ when the budget is spent, runAgentLoop drops the tool schemas
          from the next Anthropic call and appends the synthesisInstruction
          as a user message. the agent is forced to answer from what it
          already queried. this is the "no more query budget" path.
```

### The cache key (a content-hash index)

```
lib/mcp/client.ts  (around line 102 — referenced in software-design audit)

  const key = `${name}:${JSON.stringify(args)}`;
                          ↑
                          identical (name, args) → identical result
                          cache hit skips both network and rate-limit slot
       │
       └─ this is the only piece of the repo that does anything index-like.
          it's an exact-match content cache, no rewrite, no overlap detection.
          good enough because the agent's recipe set is small and the args
          are stable across a single run.
```

---

## Elaborate

The deeper structural point: **most data-modeling intuition about indexes maps to the wrong cost here.** A DBA's instinct is "the query is slow, the explain plan shows a seq scan, add an index." In this repo, no query is "slow" in the wall-clock-of-an-individual-query sense — every EQL call returns quickly (~100ms), but every call also burns one of six budget slots and one of N rate-limit slots. The optimization isn't "make each query faster." It's "fit more meaningful data into each query, and fit fewer queries into the run." The bundled-recipe pattern in `categories.ts` and the agent's "suggested query plan" in `monitoring.md` are both expressions of that.

If the repo ever owned a queryable store of its own — say, a Postgres `insights` table — the access paths would matter. The hottest reads would be (a) the briefing list (`SELECT * FROM insights WHERE workspace_id = ? ORDER BY timestamp DESC`), which would need an index on `(workspace_id, timestamp DESC)`, and (b) the single-insight fetch (`SELECT * FROM insights WHERE id = ?`), which the PK index covers. Beyond that, filtering by severity or category would need secondary indexes if the n gets large. None of this exists today, and none of it should until the use case demands it.

A note on the demo seed JSON. `lib/state/demo-insights.json` is a *fully materialized* result set — 12 insights, each ~1KB, totaling ~12KB. Reading it is a single `readFileSync + JSON.parse`. That's the simplest possible "materialized view": pre-compute the result once, store it as a flat file, read it back as a unit. It works because the access pattern is "give me all 12" — there's no need to query it. The moment the demo grows to 1000 insights with filters, this stops being viable. The data-modeling concern would be real then; it isn't now.

## Interview defense

**Q: How does this repo handle indexing?**
A: For the data the repo owns — three in-memory `Map`s in `lib/state/insights.ts` — there is no index layer because every access is `Map.get(id)`, which is already O(1). The only iteration is `listInsights()` over ≤10 entries. For the upstream Bloomreach store, the repo can't add indexes (it doesn't own the store), so the equivalent optimization is at the query-construction layer: bundle multiple metrics into one EQL call to spend fewer rate-limit slots. The `CATEGORIES` registry in `lib/agents/categories.ts` is the bundling — three metrics per recipe, one round-trip per category. The McpClient TTL cache (`lib/mcp/client.ts` L102) is the only index-like structure — keyed on `${toolName}:${JSON.stringify(args)}`, exact-match.

**Q: Where would you start indexing if you migrated this to Postgres?**
A: Primary keys cover the by-id reads (insights, investigations, anomalies). Add an index on `(workspace_id, timestamp DESC)` for the briefing-list query — that's the hottest non-PK read in any version of this. Add an index on `Investigation.insightId` (FK) if it isn't the PK. Beyond that, wait — adding indexes preemptively wastes write cost. The closest place this matters today is the in-memory `listInsights()` returning O(n) — but with n capped at 10, it's noise.

```
  diagram while you talk

  what the repo OWNS:                    what the repo QUERIES:
  ┌─ in-memory Maps ──┐                  ┌─ Bloomreach EQL ───────┐
  │ Map.get(id) O(1)  │                  │ rate-limited 1 req/s    │
  │ no index needed   │                  │ bundled recipes         │
  └───────────────────┘                  │ TTL cache (exact-match) │
                                          │ agent budget (6 calls)  │
                                          └─────────────────────────┘
```

## Validate

1. **Reconstruct.** Without opening the file: which file contains the static EQL recipes, and what's the pattern for fitting multiple metrics into one call? What's the budget cap on monitoring agent tool calls, and why is it set there?

2. **Explain.** Why does the McpClient cache use `${toolName}:${JSON.stringify(args)}` as its key? What query optimization does this play the role of in a SQL world, and what does it NOT do (hint: partial overlap)?

3. **Apply.** A 1000-row briefing-list page is requested. Trace what would happen against the current in-memory `listInsights()` (today). Now design the query and index for a Postgres-backed version. Which fields would you index, and which would you not?

4. **Defend.** Someone argues the monitoring agent's `maxToolCalls: 6` is too restrictive — "let it ask for more if it needs to." Defend the cap. (Hint: at 1 req/s, 6 calls is 6 seconds plus the time the model spends thinking; raising it raises wall-clock latency for a marginal data win that often doesn't change the headline.)

## See also

- `01-the-data-model-and-its-shape.md` — `WorkspaceSchema` and the capability set are the upstream schema view the EQL is constructed against.
- `04-transactions-and-integrity.md` — the rate-limit slots are the integrity-equivalent here; an agent that ignores them corrupts everyone else's budget.
- `06-access-patterns-and-storage-choice.md` — the in-memory Map choice is the reason there's no query layer; the JSON-file fallback is the materialized-view pattern.
- `study-software-design/03-information-hiding-and-leakage.md` — the McpClient cache is named as a strong-hide example; the cache-key construction is owned by one file.
