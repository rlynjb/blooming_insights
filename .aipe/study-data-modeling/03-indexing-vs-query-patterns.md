# Indexing vs query patterns

**Industry name(s):** Indexing · query plan · N+1 · access path · the "frequent query, no index" smell · index-tuned-to-query-shape
**Type:** Industry standard · Language-agnostic

> **Activated for real in Phase 2.** The original framing (2026-06-01) was "not yet exercised — no DB, just `Map.get(id)`." That's now wrong. The `mcp-server-olist/` package has a SQLite database with **9 explicit indexes**, each one chosen to support a specific query that one of the three Olist tools (`get_metric_timeseries`, `get_segments`, `get_anomaly_context`) actually issues. The textbook lesson "the right index is the one that matches the access path" plays out concretely here — every `CREATE INDEX` line in `mcp-server-olist/scripts/seed-olist.ts` can be pointed back to the WHERE / GROUP BY / JOIN it supports. The file also still covers the in-memory `Map`s (trivial, by-id) and the Bloomreach EQL recipes (still the rate-limited-upstream pattern).

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Three stores, three regimes now. (1) The in-memory per-session `Map`s the repo owns for UI state — key-only, `get(id)` is the only access pattern, `Map` is already a hash. (2) The Bloomreach upstream — a real columnar event store accessed through EQL via the MCP layer; the repo can't see its indexes, and the cost it pays is rate-limit slots, not query time. (3) **The Olist SQLite DB** — owned by the repo, schema designed in `seed-olist.ts`, 9 indexes designed against the 3 tools' query shapes; the repo CAN see the indexes here, and the cost it pays is local disk I/O and a single-process EXPLAIN-able query plan.

```
  Zoom out — three stores, three regimes

  ┌─ UI client band ─────────────────────────────────────────┐
  │  reads insights/investigations by id                       │
  └────────────────────────────┬─────────────────────────────┘
                               │ GET /api/agent?insight=…
  ┌─ Route handler band ───────▼─────────────────────────────┐
  │  getInsight(sid, id), getAnomaly(sid, id)                 │
  │  → SessionFeed.get(sid).insights.get(id)                  │
  │  → O(1) hash, by-id only, no index needed                 │
  └────────────────────────────┬─────────────────────────────┘
                               │ agent.scan(), agent.investigate()
  ┌─ Agent loop band ──────────▼─────────────────────────────┐
  │  monitoring/diagnostic/recommendation construct queries   │
  │  via mcp.callTool — abstract over BOTH stores below       │
  └────────────────────────────┬─────────────────────────────┘
                               │
                ┌──────────────┴──────────────┐
                │                              │
         live-bloomreach                live-sql (Olist)
                │                              │
                ▼                              ▼
  ┌─ Bloomreach upstream ──────────┐ ┌─ Olist SQLite (owned) ──────────┐
  │ execute_analytics_eql            │ │ get_metric_timeseries           │
  │ rate-limited 1 req/s             │ │ get_segments                    │
  │ indexes opaque                   │ │ get_anomaly_context             │
  │ cost = round-trip slots          │ │ cost = local I/O + plan choice  │
  │ ★ cousin pattern                 │ │ 9 EXPLICIT INDEXES, each one    │
  │                                  │ │   matches a known query shape   │
  │                                  │ │ ★ TEXTBOOK CASE — visible plans │
  └──────────────────────────────────┘ └──────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question this topic asks is: do the indexes that exist support the queries actually run? Three layers, three answers. **For the in-memory store, the answer is trivial** — `Map.get(id)` is the only access pattern and `Map` is the index. **For the Bloomreach upstream, the repo can't see the indexes**, and the cost it pays is rate-limit slots — so "minimize round-trips" replaces "minimize index lookups." **For the Olist SQLite, the answer is fully visible** — the 9 indexes in `SCHEMA_SQL` were chosen explicitly to support the three tools' query patterns, and every index can be traced back to a `WHERE` / `GROUP BY` / `JOIN` it supports.

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

`McpClient` has a TTL cache keyed by `${name}:${JSON.stringify(args)}` (mentioned in `study-software-design/audit.md#information-hiding-and-leakage` as a strong hide). Identical tool calls within the TTL skip the network round-trip and return cached results.

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

### Move 2 — the Olist indexes, mapped to the queries they support

The most concrete part of this file. `mcp-server-olist/scripts/seed-olist.ts` creates 9 indexes in `SCHEMA_SQL`. Each one is the answer to a specific query the three Olist tools issue. Walk them in pairs:

```
  Olist indexes — each one matched to its query

  ┌─ idx_orders_purchase_ts ──────────────────────────────────┐
  │  ON orders(purchase_ts)                                    │
  │                                                              │
  │  query that uses it (get_metric_timeseries):                │
  │    SELECT date_bucket(purchase_ts), SUM(...)                 │
  │    FROM orders JOIN order_items ...                          │
  │    WHERE purchase_ts BETWEEN ? AND ?                         │
  │    GROUP BY date_bucket(purchase_ts)                         │
  │                                                              │
  │  what breaks without it: every time-bucket aggregation       │
  │  becomes a full table scan of `orders` (~9,800 rows).        │
  │  small now, painful at 10x.                                  │
  └─────────────────────────────────────────────────────────────┘

  ┌─ idx_orders_customer ─────────────────────────────────────┐
  │  ON orders(customer_id)                                    │
  │                                                              │
  │  query that uses it: FK join from orders → customers        │
  │  (every time the dimension is `state`).                      │
  │                                                              │
  │  what breaks without it: nested-loop join becomes O(n²)      │
  │  in the worst case (n = order count).                        │
  └─────────────────────────────────────────────────────────────┘

  ┌─ idx_items_order, idx_items_product ──────────────────────┐
  │  ON order_items(order_id), order_items(product_id)         │
  │                                                              │
  │  query that uses idx_items_order:                            │
  │    every join from orders → order_items                     │
  │  query that uses idx_items_product:                          │
  │    every dimension='category' filter (join through products)│
  │                                                              │
  │  the two together cover both directions of the M:N bridge.  │
  └─────────────────────────────────────────────────────────────┘

  ┌─ idx_payments_order, idx_payments_type ───────────────────┐
  │  ON payments(order_id), payments(type)                     │
  │                                                              │
  │  idx_payments_order: every join orders → payments           │
  │  idx_payments_type:  every dimension='payment_type' filter  │
  │                                                              │
  │  ★ idx_payments_type is the index that supports the          │
  │     voucher-dropoff seeded anomaly's detection query        │
  │     (file 09 covers the anomaly).                            │
  └─────────────────────────────────────────────────────────────┘

  ┌─ idx_customers_state ─────────────────────────────────────┐
  │  ON customers(state)                                       │
  │                                                              │
  │  query that uses it: every dimension='state' filter or      │
  │  group-by — including the SP-revenue-drop seeded anomaly.   │
  └─────────────────────────────────────────────────────────────┘

  ┌─ idx_products_category ───────────────────────────────────┐
  │  ON products(category)                                     │
  │                                                              │
  │  query that uses it: every dimension='category' query —    │
  │  including the electronics-spike seeded anomaly.            │
  └─────────────────────────────────────────────────────────────┘

  ┌─ idx_reviews_order ───────────────────────────────────────┐
  │  ON reviews(order_id)                                      │
  │                                                              │
  │  not yet hot — no tool reaches reviews today. but pre-      │
  │  indexed because the seeded data populates the table and a  │
  │  future "review_score by segment" query would need it.      │
  │  the only speculative index in the set.                     │
  └─────────────────────────────────────────────────────────────┘
```

**The pattern:** indexes here aren't speculative-on-everything (`CREATE INDEX ON every column` would be wasteful). They're chosen by walking the three tool implementations and asking, for each WHERE / GROUP BY / JOIN: "does an index exist?" Read `mcp-server-olist/src/tools/get_metric_timeseries.ts` and `get_segments.ts` and `get_anomaly_context.ts`, list the predicates, and you can predict the index list. That's the textbook discipline — design the schema against the access path, not against the table.

What's missing: **no compound indexes.** A `(state, purchase_ts)` composite would be faster than the two singletons for queries that filter both. Today the volume is small enough (single-digit milliseconds per query at 9,800 orders) that single-column indexes suffice. At 10x data this becomes the next move.

What's also missing: **no covering indexes.** SQLite supports `INCLUDE`-like columns via prefix tricks, but none of the indexes here carry payload — every index hit is followed by a table lookup for the actual values. Fine at this scale.

### Move 2 — what's STILL not here (the honest "not yet exercised")

A few classic data-modeling concerns under this heading still don't apply:

- **No query plans inspected in CI** — the schema picks the indexes correctly today, but there's no `EXPLAIN QUERY PLAN` check that runs as a test. A future schema change could regress to a full scan and nothing would catch it until the wall-clock got noticeably slower.
- **No N+1 queries observable in the agent loop** — the agent issues one tool call per logical question, and each tool call returns aggregated data. The "N+1" failure mode (loop in app code issuing one query per row) doesn't have a place to live here — the agent is the loop, but the LLM is rate-limited by the agent budget, not by the SQL count.
- **No relational-store layer for UI state** — the in-memory per-session `Map`s still serve insights/investigations. The buildable target named in 2026-06-01 (Postgres for `insights`/`investigations`) has been built only as Olist (analytics) — the UI layer is unchanged.
- **No EXPLAIN-based index recommendation** — the indexes were chosen by reading the SQL, not by running a load profile. That's the right move for a 9,800-row deterministic dataset; at production scale, the discipline would shift to "watch slow query log + auto-recommend."

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

## See also

- `01-the-data-model-and-its-shape.md` — `WorkspaceSchema` and the capability set are the upstream schema view the EQL is constructed against.
- `04-transactions-and-integrity.md` — FKs and WAL on the Olist side; the agent-contract layer's runtime guards.
- `06-access-patterns-and-storage-choice.md` — three storage layers, three durability stories; the in-memory Maps are still by-id-only.
- `08-the-olist-relational-schema.md` — the schema each index supports, in 3NF.
- `09-deterministic-synthetic-data.md` — the seeded anomalies that exercise the index plans (the SP and electronics queries hit `idx_customers_state` and `idx_products_category`).
- `study-software-design/audit.md#information-hiding-and-leakage` — the McpClient cache is named as a strong-hide example.

---
Updated: 2026-06-16 — added Olist 9-index walk; reframed "not yet exercised" as "still no EXPLAIN gates in CI"; the topic is now genuinely live for the Olist tools.
Updated: 2026-06-24 — Stripped `## Validate` block per spec v1.68.3 (the Validate primitive was removed from the per-concept template; block 10 is now `See also`).
