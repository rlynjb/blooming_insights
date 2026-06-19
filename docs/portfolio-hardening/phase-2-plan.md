# Phase 2 plan — DataSource seam + Olist MCP server

> **RETIRED 2026-06-18.** The Olist MCP server, eval pipeline, and `live-sql`
> bi:mode were removed from the codebase. The `DataSource` seam itself survives
> (still wraps `BloomreachDataSource`) but the second adapter and the
> `mcp-server-olist/` package no longer exist. This plan is preserved as a
> historical record of what was built — see commits between Phase 2 PR A and
> the removal commit on the `remove-olist-mcp-server` branch.

> Execution plan for **Phase 2 (Swap)** of `blooming-insights-portfolio-hardening-plan.md`.
> Phase 2's goal: blooming insights runs live end-to-end against your own MCP server over Olist,
> with the Bloomreach adapter dormant but switchable.

**Total estimate:** ~5–8 focused days across 3 sub-phases / 3 PRs.
**Discipline:** "Don't change these" list stays frozen (runAgentLoop, 4 agents, `AgentEvent` contract, UI surface, demo path, the 216-test suite).
**New artifacts allowed:** `DataSource` seam, `mcp-server-olist/` package, the second adapter.

---

## Resolved decisions (2026-06-15)

```
Q1. Repo location:  same repo, mcp-server-olist/ sibling dir
                    all Phase 2 work on the mcp-server branch
Q2. Olist data:     SQLite committed (small + deterministic)
Q3. Tool schema:    Option A — 2-3 domain tools (NOT raw execute_sql)
                    Reasoning: interview-defense signal, safety, and
                    backend-portability (DataSource swap stays at data
                    layer, doesn't leak SQL into prompts).
Q4. Phase 1 study:  personal-study time; will be done manually by the
                    user against existing study guides (.aipe/study-*).
                    NOT a code generation activity; does NOT block PR A.
                    The Phase 1 → Phase 2 bridge is 2a.1's inventory.
```

PR A is unblocked. Ready to execute when scheduled.

---

## 2a — Seam extraction (PR A, ~1–2 days)

Internally consistent — can't half-ship. Pure refactor; behavior-preserving discipline applies.

### 2a.1 — Inventory Bloomreach call surface

```
Grep every site that touches McpClient.callTool / listTools.
Document the current return shape (cache hint? duration? envelope?).
Output: one-page inventory before any edits.
```

Expected call surface (from session memory, verify during execution):

- `lib/mcp/client.ts` — `McpClient` class with `.callTool` + `.listTools`
- `lib/mcp/connect.ts` — `connectMcp()` returns `{ ok, mcp, authUrl? }`
- `lib/agents/base.ts` — `runAgentLoop` consumes `opts.mcp`
- `lib/agents/{monitoring,diagnostic,recommendation,query}.ts` — each agent class holds an `mcp` reference
- `lib/mcp/schema.ts` — `bootstrapSchema(mcp, ...)` calls `mcp.callTool`
- `app/api/{briefing,agent}/route.ts` — both routes pass `connectMcp()` results through
- `test/api/_helpers.ts` — `makeMockTransport()` simulates the McpClient surface

### 2a.2 — Define `lib/data-source/types.ts`

```ts
export interface DataSource {
  callTool(
    name: string,
    args: Record<string, unknown>,
    opts?: { signal?: AbortSignal },
  ): Promise<{ result: ToolResult; durationMs: number; fromCache: boolean }>;

  listTools(
    opts?: { signal?: AbortSignal },
  ): Promise<ToolDef[]>;
}
```

Honors the `AbortSignal` seam shipped in commit `bd44300` (PR #5).

### 2a.3 — Make the Bloomreach adapter

Two paths:

- **Rename** `McpClient → BloomreachDataSource` (smaller diff, clear ownership)
- **Wrap** via composition (`BloomreachDataSource` holds an `McpClient`)

Pick rename unless wrapping earns something. **Keep all OAuth/PKCE/retry/cache code unchanged** — proves the seam wasn't retrofitted.

### 2a.4 — Reroute callers

```
runAgentLoop      opts.mcp → opts.dataSource
4 agent classes   ctor takes DataSource, not McpClient
bootstrapSchema   bootstrapSchema(dataSource, ...)
Route handlers   pass DataSource into the loop
Test fakes       implement DataSource interface
```

### 2a.5 — Verify

- All 216 tests green (no behavior change for non-cancellation paths)
- TypeScript clean (`npx tsc --noEmit`)
- 7 briefing + 10 agent integration tests pin route contract unchanged
- Smoke test: `?demo=cached` paints the same as today

### Risks for 2a

- **Test mock surface.** If many mocks needed `McpClient`-specific bits beyond `callTool`/`listTools`, the refactor cascades. Agent will surface scope creep before the wave of edits.
- **Schema bootstrap depth.** `bootstrapSchema` may invoke private McpClient methods (cache lookups, etc.). May need a slightly wider DataSource interface — surface the call before broadening.

---

## 2b — Author the MCP server (PR B, ~3–5 days)

The high-value half. This is where you become an MCP **author**, not just a consumer.

### 2b.1 — Stack decisions (needs Open Question answers first)

Defaults if Open Questions resolve cleanly:

```
SDK:       @modelcontextprotocol/sdk (Server + StdioServerTransport)
Data:      SQLite via better-sqlite3 (sync, fast, no infra)
Location:  mcp-server-olist/ (sibling dir in this repo, per Q1 default)
Transport: stdio (subprocess spawn from blooming insights)
```

### 2b.2 — Load Olist into SQLite

```
mcp-server-olist/scripts/load-olist.ts
  - Source: Kaggle Brazilian e-commerce dataset (Olist)
  - Tables: orders, customers, products, order_items, payments, reviews
  - Output: mcp-server-olist/data/olist.db

mcp-server-olist/README.md
  - Document schema
  - Document load steps + Kaggle credentials path
  - Document any data trimming (e.g., reduce to ~10k orders for
    deterministic demos)
```

If Open Question #2 = "commit SQLite":
```
- File size target: ~10–20 MB after trimming
- Add .gitattributes for binary handling
```

If Open Question #2 = "load script + .gitignore":
```
- Add data/.gitkeep
- Add data/olist.db to .gitignore
- Add `npm run load-olist` script
```

### 2b.3 — Design the tool schema (the senior artifact)

**Strong recommendation: 2–3 domain tools, NOT one raw `execute_sql`.**

Suggested shape:

```ts
get_metric_timeseries({
  metric: 'revenue' | 'order_count' | 'avg_order_value' | ...,
  dimension?: 'category' | 'state' | 'payment_type',
  time_range: { from: string; to: string },  // ISO dates
  filter?: { dimension: string; value: string },
}) → { points: Array<{ ts: string; value: number; segment?: string }>;
       totalCount: number; }
```

Analog of Bloomreach's `execute_analytics_eql`. The tool's JSON-schema validation + the structured input shape is the portfolio artifact.

```ts
get_segments({
  dimension: 'category' | 'state' | 'payment_type',
}) → { segments: Array<{ name: string; count: number }> }
```

Lets the agents discover what to filter on.

```ts
get_anomaly_context({
  anomaly_id: string,
}) → { evidence: Array<{ ... }>; relatedSegments: string[] }
```

For the diagnostic loop's evidence-gathering. Maps closely to the existing diagnostic agent's tool-use pattern.

**Why not raw SQL:**
- Model can generate broken / dangerous queries
- No type safety on inputs
- Portfolio signal of designed tool surface > raw escape hatch
- Easier to swap data sources later (Postgres, BigQuery) if needed

### 2b.4 — Author the server

```
mcp-server-olist/src/index.ts
  - Server with StdioServerTransport
  - Tool handlers → typed SQL queries → MCP result envelope
  - Error handling matches MCP spec (isError + content)

mcp-server-olist/src/tools/
  - one file per tool
  - tool schema (JSON schema)
  - input validation
  - SQL execution
  - result shaping
```

### 2b.5 — `OlistDataSource` adapter

```
lib/data-source/olist-data-source.ts
  - Spawns mcp-server-olist subprocess via child_process
  - Speaks MCP protocol over stdio
  - Implements DataSource interface from 2a
  - Same shape envelope as BloomreachDataSource ({ result, durationMs, fromCache })
```

### 2b.6 — Test

```
mcp-server-olist/test/*.test.ts
  - Tool schema validation
  - Each tool's SQL produces expected shape
  - Error envelopes match MCP spec

test/data-source/olist.integration.test.ts
  - Spawn server, call each tool, assert response
  - Validate cancellation (AbortSignal) propagates
```

### Risks for 2b

- **Olist data shape mismatch.** Order-level granularity; no session events; no hourly buckets. `get_metric_timeseries` composes daily aggregates from order rows. Might need to **synthesize anomalies** for testing — drop revenue 30% in São Paulo for a week, etc.
- **MCP protocol edge cases.** Brand-new server may trip on initialization handshake, capability negotiation, error envelopes. Plan for protocol-debugging time.
- **Repo bloat.** Full Olist is ~30 MB. Trim to ~10k orders for the demo if committing.

---

## 2c — Wire as live default + prompt pass (PR C, ~1–2 days + prompt iteration)

### 2c.1 — Extend `bi:mode`

```ts
type Mode = 'demo' | 'live-sql' | 'live-bloomreach';
// default changes from 'live' → 'live-sql'
```

Migration path for existing users:
- `localStorage.getItem('bi:mode') === 'live'` → treat as `'live-sql'`
- Old `'demo'` value unchanged

### 2c.2 — DataSource factory

```ts
// lib/data-source/index.ts
export function makeDataSource(mode: Mode): DataSource | DemoDataSource {
  switch (mode) {
    case 'demo':            return new DemoDataSource(); // existing snapshot path
    case 'live-sql':        return new OlistDataSource();
    case 'live-bloomreach': return new BloomreachDataSource();
  }
}
```

Route handlers branch on mode; agents never see the choice.

### 2c.3 — Prompt updates (the unpredictable part)

Domain-prompt pass — agents need:

- **SQL-shaped tool guidance** replacing EQL examples in:
  - `lib/agents/diagnostic.ts` — synthesisInstruction middle
  - `lib/agents/recommendation.ts` — same
  - `lib/agents/query.ts` — same
  - `lib/agents/monitoring.ts` — same
- **Olist domain hints** (Brazilian e-commerce, categories, `payment_type` values, etc.)
- **Updated synthesisInstruction shape clauses** to match Olist's actual data shape

The `buildSynthesisInstruction(middle)` helper from commit `8179e08` is the surface — only the `middle` clauses change.

### 2c.4 — Verify end-to-end

```
npm run dev with live-sql:
  → full feed → investigate → recommend flow paints
  → monitoring agent surfaces an anomaly from Olist data
  → diagnostic agent gathers evidence via get_anomaly_context
  → recommendation agent proposes Olist-shaped actions

Switch to demo:
  → snapshot replay unchanged (the cached agent traces still work)

Switch to live-bloomreach:
  → still works (dormant but switchable per phase-2 goal)

All tests green:
  → 216+ tests pass
  → integration tests still pin route contracts
```

### Risks for 2c

- **Prompt tuning is the unpredictable part.** Agents tuned for Bloomreach's EQL semantics may not reason cleanly about SQL-shaped tools on first pass. Plan 1–3 iteration cycles.
- **Synthetic anomaly seeding.** Olist's raw data may not produce naturally-anomalous patterns the monitoring agent surfaces well. Seeding deliberate anomalies (revenue drops, category-specific spikes) might be needed — and that's actually the bridge into Phase 3 (Eval), since seeded anomalies = ground truth.

---

## Sequencing summary

```
PR A (2a):  DataSource seam extraction.
            216 tests green. No new server yet. Bloomreach still default.
            Nothing user-visible changes.

PR B (2b):  mcp-server-olist/ ships as new package.
            New tests for the server + adapter.
            OlistDataSource exists. NOT wired into UI yet.

PR C (2c):  bi:mode default flips to 'live-sql'. Prompts updated.
            End-to-end live on Olist.
            Bloomreach mode still switchable.
```

**Acceptance for Phase 2 complete:** open `/` with default mode, watch the full feed → investigate → recommend flow paint with data sourced from your local MCP server over Olist. Toggle to `live-bloomreach` (still works). Toggle to `demo` (still works).

---

## Hard rules (carried from the source plan)

```
✗ Don't touch runAgentLoop, the 4 agents, AgentEvent contract,
  stepper/feed/investigate UI, the test suite as-is, or the demo path.

✗ Don't delete BloomreachDataSource — it stays as a dormant adapter
  proving the seam wasn't retrofitted.

✗ Don't start Phase 3 (Eval) until Phase 2 ships end-to-end on Olist.

✗ Don't interleave phases. Source plan: "Each phase ships before the
  next starts; no interleaving."
```

---

## SMOKE TEST (post-PR-C merge, manual)

PR C lands the wiring; this is the manual end-to-end verification path. Tests stay at
269 because the agent suite is scripted with mocks — prompt content doesn't drive them.
The real proof that Olist is live is the manual flow:

```
1. cd mcp-server-olist && npm run seed && npm run build     # one-time
2. npm run dev                                              # from repo root
3. Browser → http://localhost:3000
4. Mode toggle → 'live · olist' (default for new sessions)
5. Verify: full feed loads with Olist anomalies — the 3 seeded ones should
   surface (SP-state revenue drop, electronics-category demand spike,
   voucher-payment dropoff). The feed shows monitoring queries against
   get_metric_timeseries / get_segments / get_anomaly_context, not EQL.
6. Click an insight → investigate → recommend should all work end-to-end.
   Diagnostic agent calls get_anomaly_context; recommendation agent reasons
   from the diagnosis alone (no list_scenarios / list_segmentations under Olist).
7. Switch to 'demo' → snapshot replay unchanged (the committed snapshot is
   Bloomreach-shaped — that's intentional, demo proves the cache path works).
8. Switch to 'live · bloomreach' → Bloomreach OAuth flow fires; if you have
   no access, expect 401 + reconnect banner (correct behavior — the alpha
   server may be revoked / unavailable).
9. Toggle back to 'live · olist' to confirm the mode persists across reloads.
```

## What this plan does NOT cover

- **Phase 1 (Study) steps 1–7** — assumed done before PR A begins. If not, the inventory in 2a.1 surfaces gaps; complete the relevant Phase 1 step(s) before continuing.
- **Phase 3 (Eval)** — separate plan once Phase 2 ships.
- **The "After this — RAG gap"** sidebar from the source plan — separate phase-two project per the source.
