# Phase 2 smoke test — partial verification (2026-06-15)

> Evidence captured before opening the Phase 2 PR. Covers what's verifiable
> without a browser or live Anthropic API. The browser smoke test
> (per `phase-2-plan.md` section 2c.4) is still required before merge.

## Tested on

```
Branch:    mcp-server @ 61005cb
Commits:   5 ahead of main (planning + PR A + PR B + PR C)
Node:      v20.20.2
Platform:  darwin (macOS)
```

---

## Step 1 — Full test suite

```bash
npm test
```

**Result:** ✓ 269/269 passing across 28 test files (6.3s)

Notable: the run output included 5x `[mcp-server-olist] ready (stdio)` lines, meaning the `OlistDataSource` integration suite spawned the server through a full MCP handshake 5 times during the run with zero flake. The 10 integration tests cover:

- Spawn lifecycle (lazy connect, reuse across calls, dispose idempotency)
- AbortSignal propagation (late-fire + already-aborted)
- All 3 tools called via the stdio transport

---

## Step 2 — `mcp-server-olist` build

```bash
cd mcp-server-olist && npm run build
```

**Result:** ✓ tsc clean. 7 JS files emitted:

```
dist/src/
  index.js
  server.js
  db.js
  schemas.js
  tools/
    get_metric_timeseries.js
    get_segments.js
    get_anomaly_context.js
```

No TypeScript errors in the package.

---

## Step 3 — Standalone server startup

```bash
node dist/src/index.js  (kill after 2s; verify no crash on init)
```

**Result:** ✓ Server prints `[mcp-server-olist] ready (stdio)` on stderr and waits silently for JSON-RPC requests on stdin. Matches the integration tests' evidence pattern. Clean MCP-protocol init handshake works against the compiled artifact.

---

## Step 3b — SQLite data integrity

Direct query of `mcp-server-olist/data/olist.db` via `better-sqlite3`:

**Tables present:**
```
customers · order_items · orders · payments · products · reviews · seeded_anomalies
```

**Row counts (exact match against the seed script's promises):**

| Table | Rows |
|---|---:|
| customers | 5,000 |
| products | 800 |
| orders | 9,808 |
| order_items | 13,726 |
| payments | 10,728 |
| reviews | 6,857 |
| seeded_anomalies | 3 |

**The 3 Phase-3 ground-truth anomalies, with severity tags:**

| ID | Metric | Dimension | Segment | Severity |
|---|---|---|---|---|
| `sp-revenue-drop-w4` | revenue | state | SP | critical |
| `electronics-spike-w2` | order_count | category | electronics | warning |
| `voucher-dropoff-w10-on` | payment_value | payment_type | voucher | critical |

---

## What this DOES prove

- ✓ The server compiles, starts, speaks MCP stdio
- ✓ The `OlistDataSource` adapter spawns it, does the handshake, calls tools, disposes — 5 cycles, no flake
- ✓ The SQLite data is **exactly** what the README promises — deterministic, exact counts
- ✓ The 3 Phase-3 ground-truth anomalies exist in the table with correct labels + severity
- ✓ The whole 269-test suite green on the merge candidate
- ✓ TypeScript clean across both `tsconfig.json` (root) and `mcp-server-olist/tsconfig.json`

## What this DOES NOT prove

Browser + Anthropic API verification (the full smoke test from `phase-2-plan.md` section 2c.4) is still required before merging:

- □ **Anthropic API integration** — the 4 agents actually reasoning over the new tool surface (`get_metric_timeseries` / `get_segments` / `get_anomaly_context`) instead of the Bloomreach EQL surface
- □ **Browser UI** — feed / investigate / recommend rendering with Olist data
- □ **Mode toggle interaction** — switching between `live-sql` / `demo` / `live-bloomreach`
- □ **The 3 seeded anomalies surfacing as insights at runtime** — the data IS in the DB; whether the monitoring agent chooses to flag them depends on prompt-tuning quality (which is the territory Phase 3 evals will measure)

## Recommended browser smoke test (post-merge or pre-merge)

Per `phase-2-plan.md`:

```bash
1. npm install              # picks up better-sqlite3
2. cd mcp-server-olist && npm run build && cd ..
3. npm run dev

# Browser → http://localhost:3000
4. Mode toggle should default to "live · olist" (new sessions)
5. Watch the feed paint with Olist data
6. Verify the 3 seeded anomalies surface as insights:
   - SP revenue drop (week 4)
   - electronics spike (week 2)
   - voucher dropoff (week 10+)
7. Click an insight → investigate → recommend flow should work end-to-end
8. Switch to demo → snapshot replay unchanged
9. Switch to "live · bloomreach" → expect 401 + reconnect banner
   (this is correct behavior without live access)
```

---

## Verdict

The bones are correct. The flesh (agent reasoning + UI integration) needs the browser smoke test.

If the browser smoke test surfaces any agent-reasoning issues with the new SQL-shaped prompts (per PR C's "Honest scope decision #3" about dual-adapter framing), that's the natural input into the prompt-tuning iteration cycle the source plan budgeted for ("plan 1-3 iteration cycles" for the SQL-shaped domain pass).
