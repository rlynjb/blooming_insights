# Query planning and execution — planning happens elsewhere

*Industry standard / Project-specific* — there is no local query planner. The agents emit EQL strings; the Bloomreach server plans and executes them; we see only the result. This concept file is mostly about the *planning we do have* — which is "an LLM picks a tool and writes the query string."

## Zoom out, then zoom in

A query planner takes a declarative query, picks a plan, and executes it. In this repo the declarative query is an EQL string the model wrote, the planner is whatever runs inside Bloomreach's analytics engine, and we never see the plan. What *we* control is the tool-selection step that happens before the query is sent — and the duplicate-suppression step (the cache) that happens after.

```
  Zoom out — where this concept lives

  ┌─ UI layer ───────────────────────────────────────────────┐
  │  StatusLog shows tool calls + EQL text as they run        │
  └────────────────────────────┬─────────────────────────────┘
                               │  HTTP / NDJSON
  ┌─ Service layer ────────────▼─────────────────────────────┐
  │  monitoring/diagnostic/recommendation agents              │
  │      │                                                    │
  │      ▼                                                    │
  │  runAgentLoop  ──►  pick a tool, build args  ──► callTool│
  │                          ★ TOOL-CHOICE PLANNING ★          │ ← we are here
  └────────────────────────────┬─────────────────────────────┘
                               │  callTool('execute_analytics_eql', { eql })
  ┌─ Storage / external ───────▼─────────────────────────────┐
  │  Bloomreach MCP server                                    │
  │    ↓ EQL planner (opaque to us)                           │
  │    ↓ analytics engine                                     │
  │  → result envelope                                         │
  └──────────────────────────────────────────────────────────┘
```

Zoom in: the "query planning" that lives in this repo is the model deciding which of ~30 tools to call and what `eql` string to put in the args. That's a planning step in the loosest sense — there's no rule-based optimizer, no cost model, no statistics. It's an LLM with a tool catalog.

## Structure pass

**Layers:**

```
  L1  agent loop                LLM picks tool + args
  L2  DataSource.callTool       cache check, rate spacing
  L3  Bloomreach MCP server     EQL planner + executor (opaque)
```

**Axis traced: who plans the query?**

```
  Trace one axis: who decides what runs?

  ┌─ L1: agent (Claude) ──────────────────┐
  │  picks tool, writes EQL string         │   → LLM decides
  └────────────────────────────────────────┘
                  (it flips)
  ┌─ L2: DataSource ──────────────────────┐
  │  caches, spaces, retries; no semantics │   → mechanical, no choice
  └────────────────────────────────────────┘
                  (it flips)
  ┌─ L3: Bloomreach server ───────────────┐
  │  parses EQL, picks plan, scans events  │   → server-side planner
  └────────────────────────────────────────┘

  the planner-choice flips twice: LLM → cache → server
  we own L1; we own nothing in L3
```

**Seams** — two matter:

- L1 → L2: the `callTool(name, args)` signature is where the agent stops being able to influence execution. Once the args go in, the cache+server pipeline is mechanical.
- L2 → L3: the wire protocol (MCP over HTTP). The cache hit/miss decision flips here; the rest is a remote procedure call we don't see inside of.

## How it works

### Move 1 — the mental model

In a relational system the planner sees `SELECT * FROM events WHERE customer_id = ? AND ts > ?` and picks an index + a scan strategy. Here the analog is: the agent sees the prompt + tool schemas, picks `execute_analytics_eql`, writes the EQL, and ships it. The model is the planner — but with no statistics, no plan cache, no rewrite rules. Just "given these tools and this question, what do I call?"

```
  Two-stage execution — local planner, remote executor

       user question (anomaly to diagnose)
              │
              ▼
       ┌─ L1: agent (LLM) ──────────┐
       │  pick tool: execute_eql     │   "planning"
       │  write eql string           │
       │  build args                 │
       └────────────┬────────────────┘
                    │ callTool(name, args)
                    ▼
       ┌─ L2: DataSource ───────────┐
       │  cache hit? return early    │   "caching"
       │  cache miss? send live      │
       └────────────┬────────────────┘
                    │ HTTP
                    ▼
       ┌─ L3: Bloomreach ───────────┐
       │  parse eql, plan, execute   │   "real execution"
       │  return result envelope     │   (opaque)
       └─────────────────────────────┘
```

That's the kernel. The rest is what each layer actually does.

### Move 2 — the planner, one part at a time

#### L1 — the agent loop (the "planner")

The agent loop is the only part of the planner we own. The relevant facts (from `lib/agents/base.ts` and the per-agent files):

- Default model is `claude-sonnet-4-6`; intent classification uses `claude-haiku-4-5-20251001` (cheaper, faster — see `.aipe/project/context.md`).
- Each agent (monitoring, diagnostic, recommendation, query) gets a different tool subset from `lib/agents/tool-schemas.ts`. That's a coarse permissions model: monitoring can call `execute_analytics_eql` but not `list_campaigns`; recommendation can call `list_scenarios` but not `execute_analytics_eql`.
- The agent loop hands Claude the tool schemas, gets back a `tool_use` block, calls `dataSource.callTool(name, args)`, sends the result as a `tool_result` block, and loops until Claude emits a final text response.

```
  The agent loop — a degenerate planner with no statistics

  prompt + tool schemas
        │
        ▼
  Claude.messages.create({ tools, messages })
        │
        ▼
  response.stop_reason
   ┌────┴──────────┐
   │               │
  "tool_use"   "end_turn"
   │               │
   ▼               ▼
  pick the         emit final text
  tool block       (the answer)
   │
   ▼
  dataSource.callTool(name, args)
   │
   ▼
  append tool_result, loop
```

The planning quality is whatever the model can do with the tool catalog plus the prompt. There's no plan cache (Claude doesn't remember "I did this EQL last briefing"), no cost-based reasoning, no learning. The prompts in `lib/agents/prompts/*.md` are the only place we can tune the planner.

#### L2 — the DataSource (the "executor wrapper")

The DataSource is mechanical. It does not parse, rewrite, or reason about the query — it caches by exact args (`03-btree-hash-and-secondary-indexes.md`), spaces calls at ~1 req/s, and retries on rate-limit errors with a parsed wait hint.

```typescript
// lib/data-source/bloomreach-data-source.ts:139-188 (callTool, condensed)
async callTool<T>(name, args, options) {
  const cacheKey = `${name}:${JSON.stringify(args)}`;
  if (cache hit && unexpired) return { fromCache: true, durationMs: 0 };

  let result = await this.liveCall(name, args, options.signal);
  while (isRateLimited(result) && retries < maxRetries) {
    await sleep(parseRetryAfterMs(result) ?? backoff);
    result = await this.liveCall(name, args, options.signal);
  }
  if (!isError(result)) cache.set(cacheKey, { result, expiresAt: now + ttl });
  return { result, durationMs, fromCache: false };
}
```

This is what a database driver does, with three customizations for Bloomreach's quirks: the cache (since the upstream is slow), the spacing (since the upstream rate-limits globally), and the retry-after parsing (since the upstream states its penalty window in the error text).

#### L3 — the Bloomreach EQL planner (opaque)

We do not have an `EXPLAIN` for EQL. We see a result and a duration; we infer planning behavior from response time. Two observable signals:

- A simple `count` query over a 90-day window returns in ~1-2s. A complex segmentation in ~5-10s. The cache (L2) collapses repeats to 0ms.
- Errors come back as an `isError: true` envelope with text describing what failed (parse error, rate limit, unauthorized). The error text is the only debugging surface.

This is the same situation you'd have hitting any third-party analytics API. The planner is a black box; you only see the boundary.

#### The 90-day window — the only "query rewrite" we do

```
  Window-bound rewrite — done in the prompt, not at runtime

  user/agent intent  →  "what changed recently"
                              │
                              ▼
  prompt forces       →  current 90d vs prior 90d
                              │
                              ▼
  EQL emitted         →  WHERE ts BETWEEN (now-90d, now)
                         WHERE ts BETWEEN (now-180d, now-90d)
```

`.aipe/project/context.md` is explicit: short windows (7d) hit the dataset's sparse tail and produce bogus ±100% swings. The prompts in `lib/agents/prompts/` enforce 90d to avoid that. This is a "query rewrite" in the loosest sense — done at prompt-design time, not at runtime.

#### N+1 behavior — none, by construction

The monitoring agent issues one EQL per category × scope (current, prior). The diagnostic agent issues one EQL per hypothesis. There is no place in the code that issues one EQL per row of a previous result — the agent loop's natural shape is "issue a few queries, reason on the results" rather than "iterate over results and re-query."

The closest thing to N+1 risk is in the demo replay (`app/api/briefing/route.ts:122-138`) which iterates over recorded `trace[]` items and emits one event per item. That's not a query — it's a recorded playback — and the items are bounded by how many tool calls the original briefing made.

### Move 3 — the principle

When most of "query planning" lives behind an external boundary, your job shrinks to: (a) constrain what the *local* planner is allowed to ask (tool catalogs, prompt-enforced windows), and (b) shield the upstream from your local planner's mistakes (cache, spacing, retry). You can't optimize a plan you can't see, but you can absolutely bound the number of plans you produce and the cost of repeats.

## Primary diagram

```
  Query planning + execution — full path, three layers

  ┌─ agent loop (LLM) ──────────────────────────────────────┐
  │  prompt: "investigate this anomaly"                      │
  │  tools: [execute_analytics_eql, list_segmentations, …]   │
  │                                                           │
  │  Claude picks: { name: "execute_analytics_eql",           │
  │                  args: { eql: "select count … where …" }} │
  └──────────────────────────────┬──────────────────────────┘
                                 │ callTool(name, args)
  ┌─ BloomreachDataSource ───────▼──────────────────────────┐
  │  key = `${name}:${JSON.stringify(args)}`                 │
  │  cache.get(key)?  ──► HIT  → return { fromCache: true }  │
  │                  └─► MISS → liveCall(...)                │
  │     ↓                                                    │
  │  spacing: wait until 1.1s since lastCallAt               │
  │  retry-on-429 with parsed window hint                    │
  └──────────────────────────────┬──────────────────────────┘
                                 │ HTTP / MCP
  ┌─ Bloomreach MCP server ──────▼──────────────────────────┐
  │  parse EQL → plan → scan events → aggregate → respond    │
  │  (opaque to us — no EXPLAIN, only durationMs + result)   │
  └─────────────────────────────────────────────────────────┘
```

## Elaborate

The interesting design choice is that the planner is the model, not a hand-written rule engine. Earlier versions of analyst-style products (and the synthetic adapter in `lib/data-source/synthetic-data-source.ts`) hard-coded the queries: "given this anomaly category, run THIS EQL." That's faster and cheaper but brittle — every new anomaly type needs new code. The LLM-as-planner approach pays per-query in tokens and latency but generalizes to anomalies the prompt didn't anticipate.

The repo handles the cost side with the tool subset (monitoring can't call diagnostic's tools, so the planning space is smaller per agent) and the prompt design (the prompts in `lib/agents/prompts/` are tight and enumerate the patterns to look for). That's the closest thing to a cost-based optimizer here — "restrict the search space at the source."

If you wanted real `EXPLAIN`-style visibility, the place to add it would be in `BloomreachDataSource.callTool` — capture `name`, `args`, `durationMs`, `fromCache` in a per-session trace, then surface them in the existing `StatusLog`. The trace data is already on the wire (`tool_call_end` events carry `durationMs` and the result); it's just not aggregated into a plan summary.

## Interview defense

**Q: How does query planning work here?**

Three layers: the model picks a tool and writes the query string (the planner), the DataSource caches/spaces/retries (the executor wrapper), the Bloomreach server actually plans and runs EQL (opaque). We own only the first layer and have prompts that constrain what plans the model is allowed to produce — most importantly the 90-day window rule, since shorter windows produce bogus ±100% swings on a sparse dataset.

**Q: What's your story for N+1 queries?**

It's structurally avoided. The agent loop's natural shape is "issue a few queries, reason on the result" — there's no place that iterates over rows of one result and issues a query per row. The monitoring agent runs one EQL per category × current/prior, bounded by the 10 categories minus whatever the coverage gate rejects. The diagnostic agent runs one EQL per hypothesis, bounded by the prompt to ~3-5 hypotheses. The cache (60s TTL, keyed by `name + JSON.stringify(args)`) collapses any accidental repeats to 0ms.

**Q: What would you change if you wanted query observability?**

Aggregate the trace data already in `tool_call_end` events into a per-session plan summary — tool name, durationMs, fromCache, rough args fingerprint. That gives you the moral equivalent of `EXPLAIN ANALYZE` without changing the upstream contract. Today that data is on the wire but not summarized; the UI shows it per-call in `StatusLog` but doesn't roll it up.

## See also

- `03-btree-hash-and-secondary-indexes.md` — the cache that collapses repeat plans
- `06-locks-mvcc-and-concurrency-control.md` — why per-call spacing is the only contention story
- `07-wal-durability-and-recovery.md` — what happens when an agent's planning step fails mid-way
- `09-database-systems-red-flags-audit.md` — the lack of EXPLAIN visibility
