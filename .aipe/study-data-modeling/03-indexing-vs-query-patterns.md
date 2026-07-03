# Indexing vs query patterns

**Industry term:** Access-path analysis · secondary indexes · full-table scan (filesystem analog) · **Type:** Industry-standard concept, applied here to a repo where "the table" is a directory of JSON files.

## Zoom out, then zoom in

**Zoom out — where reads happen.** In a database-backed system, this concept is "for each hot query, is there an index that answers it in O(log n) instead of O(n)?" blooming_insights has no database, so the equivalent question becomes: "for each hot read path, does the storage layout let us answer it without touching every record?"

```
  Hot read paths in blooming_insights — where does each one land?

  ┌─ UI layer ──────────────────────────────────────────────────┐
  │  read: getInsight(sessionId, id)  → one card                │
  │  read: listInsights(sessionId)    → the feed                │
  └──────────────────────────┬──────────────────────────────────┘
                             │
  ┌─ Service layer ──────────▼──────────────────────────────────┐
  │  ★ THIS CONCEPT ★                                            │
  │  In-memory Map<sid,{Map,Map,Map}> — O(1) by id per session   │
  │                                                              │
  │  Eval-time reads:                                            │
  │    readdirSync + filter-by-runId-suffix + parse × N          │
  │    → linear scan per aggregation                             │
  └──────────────────────────┬──────────────────────────────────┘
                             │
  ┌─ Storage layer ──────────▼──────────────────────────────────┐
  │  Map (RAM)         demo-*.json (single file)                │
  │  eval/receipts/*.json (N per run, R runs)                   │
  └─────────────────────────────────────────────────────────────┘
```

**Zoom in — the pattern.** Two read patterns dominate. The **hot request path** (feed → card → investigation) uses a Map keyed by id, per session: O(1) lookup, no index needed. The **eval aggregation path** (baseline build, gate compare, report) walks the receipts directory once per invocation: O(N × R) parses to answer questions that a DB with a single index would answer in O(log N).

## Structure pass

### Layers of read

```
  Read patterns — sorted by frequency and hot-ness

  ┌─ Hot (per-request, sub-second) ─────────────────────────────┐
  │  getInsight / listInsights / getInvestigation                │
  │  → Map lookup, O(1)                                          │
  │  → files 00–07 walk these first because they're the request │
  │    path                                                      │
  └────────────────────────┬────────────────────────────────────┘
                           │
  ┌─ Warm (per-run, seconds) ───────────────────────────────────┐
  │  demo-snapshot read (once at startup for demo mode)          │
  │  → single-file JSON.parse, ~665 lines                        │
  └────────────────────────┬────────────────────────────────────┘
                           │
  ┌─ Cold (per-eval-run, tens of seconds) ──────────────────────┐
  │  baseline aggregation, gate compare, report                  │
  │  → readdirSync + filter + JSON.parse × N per aggregation     │
  └─────────────────────────────────────────────────────────────┘
```

### One axis: **is the read pattern supported by the write layout?**

- Hot path: **yes.** Session Map keyed by sessionId + inner Map keyed by id — reads perfectly match writes.
- Warm path: **yes.** Single-file demo snapshot loaded once at startup — one file, one shape, matches.
- Cold path: **partial.** Receipts are keyed by `(caseId, runId)` in the filename. Filtering by `runId` scans the directory; filtering by `caseId` alone scans everything; querying "all receipts where `diagnosisJudgment.verdict === 'fail'`" requires parsing every file. The layout supports one query well and every other query linearly.

### Seams — where the answer flips

- **`lib/state/insights.ts:16-23` — `sessionState`.** Above the seam: the shared outer Map. Below: per-session sub-maps. The Map-of-Maps *is* the index — one hash lookup per level, and every hot request path uses both.
- **`eval/baseline.eval.ts:44-51` — the `readdirSync + filter` loop.** Above: "which run am I aggregating?" (a `runId` string). Below: a full directory scan. This is where the query pattern flips from indexed to unindexed.

## How it works

### Move 1 — the mental model

Two mental models, one per pattern.

**The hot path is a two-level hash table.** You've probably reached for `Map<userId, Map<key, value>>` before — the outer partitions the world, the inner is the actual store. blooming_insights uses this to keep session A's briefing from being wiped when session B posts a new one.

```
  Two-level hash — the "index" that isn't a DB

     "list this session's insights"
                │
                ▼
     state.get(sessionId)   ◄── O(1), outer Map
                │
                ▼
     .insights.values()      ◄── O(k), where k = insights in this feed
                                  (typically 3-8)

  no index tree, no query planner — just Map lookup twice
```

**The cold path is a file-system table scan.** Each receipt is a JSON file named `<caseId>-<runId>.json`. To "aggregate the latest run," the code reads the directory, filters filenames by suffix, parses each hit. There's no index; every parse is an O(size) cost.

```
  eval/receipts/ — the "table scan" pattern

     readdirSync(RECEIPTS_DIR)             ◄── list all files
              │
              ▼
     .filter(f => f.endsWith(`${runId}.json`))   ◄── string match
              │
              ▼
     for each file: JSON.parse(readFileSync)     ◄── the scan
              │
              ▼
     for each receipt: aggregate                 ◄── the work

  cost:  O(total_files) directory listing
       + O(runId_matches) parses × ~35KB each
```

### Move 2 — the read paths, one at a time

#### Hot path A — `getInsight(sessionId, id)`

**File:** `lib/state/insights.ts`
**Function:** `getInsight` (lines 73-75)

```typescript
export function getInsight(sessionId: string, id: string): Insight | null {
  return state.get(sessionId)?.insights.get(id) ?? null;
}
```

Two `Map.get()` calls, both O(1) on average. This is the read path that runs when the user clicks a feed card and lands on `/investigate/[id]`. It's about as fast as a read gets — no serialization, no parse, no allocation beyond the return.

**What breaks if the outer Map is removed** (i.e., you go back to a flat `Map<insightId, Insight>`): sessions bleed. The `sessionState` boundary is the entire index-that-partitions-users. The comment at lines 5-11 (already cited in file 01) is worth re-reading — it's a data-modeling decision expressed as a comment.

#### Hot path B — `listInsights(sessionId)`

**File:** `lib/state/insights.ts`
**Function:** `listInsights` (lines 81-84)

```typescript
export function listInsights(sessionId: string): Insight[] {
  const s = state.get(sessionId);
  return s ? [...s.insights.values()] : [];
}
```

O(1) session lookup + O(k) values spread, where k is the number of insights in the feed (~3-8 in practice). This is the feed-page read. `Map.values()` returns iteration order = insertion order in V8, which the UI relies on implicitly (the briefing runner inserts in the order the monitoring agent found anomalies).

**What breaks if you replace this with a filtered scan of a global list** (`allInsights.filter(i => i.sessionId === sid)`): the read cost goes from O(k) to O(all_sessions × avg_feed_size). Currently unnoticeable; matters the moment you have >100 concurrent sessions on one warm instance.

#### Warm path — demo snapshot read

**File:** `lib/state/investigations.ts` (lines 22-28) + demo files at `lib/state/demo-*.json`

```typescript
export function getCachedInvestigation(insightId: string): AgentEvent[] | null {
  if (mem.has(insightId)) return mem.get(insightId)!;
  const fromFile = PERSIST ? readJson(CACHE_FILE)[insightId] : undefined;
  if (fromFile) return fromFile;
  const fromDemo = readJson(DEMO_FILE)[insightId];
  return fromDemo ?? null;
}
```

Three-tier lookup: in-memory → dev cache file → committed demo file. Each JSON file is read + parsed on every miss (there's no in-memory cache of the file contents beyond the OS page cache). At demo-file size (~3487 lines / ~80KB for `demo-investigations.json`), a full parse is a few milliseconds — well below the network round-trip budget of the live path.

**What breaks if you cache the parsed JSON in memory:** the dev-file cache stops picking up hot writes. As long as dev is the only consumer, either shape works; the current code prefers "re-read every time" for correctness over caching.

#### Cold path A — the baseline aggregation

**File:** `eval/baseline.eval.ts`
**Function:** the vitest `it()` body at lines 42-65

```typescript
const runId = pickRunId(process.env.RUN_ID);
const files = readdirSync(RECEIPTS_DIR)
  .filter((f) => f.endsWith(`${runId}.json`))
  .sort();
if (files.length === 0) throw new Error(`No receipts for runId ${runId}`);

const receipts: Receipt[] = files.map(
  (f) => JSON.parse(readFileSync(resolve(RECEIPTS_DIR, f), 'utf8')) as Receipt,
);

const baseline = computeBaseline(runId, receipts);
```

The query is: "give me every receipt for run X, then aggregate per-dimension pass rates." Cost:

- `readdirSync`: O(total_receipts) — reads the whole directory listing.
- `filter`: linear string match per name.
- `readFileSync + JSON.parse`: per file, ~35KB each — the dominant cost.
- `computeBaseline`: linear over the parsed receipts.

At 10 cases × 3 runs = 30 files, this is milliseconds. At 200 cases × 50 runs = 10,000 files, `readdirSync` alone becomes measurable on some filesystems, and the parse cost dominates. `pickRunId` (lines 120-129) does an *additional* `readdirSync` + regex match to discover the latest runId — that's *two* full directory listings on one invocation.

**What breaks if you index the filesystem:** you'd need a manifest file that says "run X consists of files [1..10]." At 10 cases the manifest is a rounding error; at 200 it's the difference between milliseconds and seconds per invocation.

#### Cold path B — the regression gate

**File:** `eval/gate.eval.ts`
**Function:** the vitest `it()` body at lines 50-91

Same pattern as baseline, but reads *two* runs — the committed `baseline.json` and the candidate run's receipts — then diffs pass rates per dimension. Lines 63-73:

```typescript
const candidateRunId = pickRunId(process.env.RUN_ID);
const files = readdirSync(RECEIPTS_DIR)
  .filter((f) => f.endsWith(`${candidateRunId}.json`))
  .sort();
if (files.length === 0) throw new Error(`No receipts for candidate runId ${candidateRunId}`);

const receipts: Receipt[] = files.map(
  (f) => JSON.parse(readFileSync(resolve(RECEIPTS_DIR, f), 'utf8')) as Receipt,
);
const candidate = computeBaseline(candidateRunId, receipts);
```

Notice that `baseline.json` is a **pre-aggregated summary** — it's the equivalent of a materialized view. The gate reads the pre-aggregated baseline in O(1) and only pays the scan cost on the candidate side. That's a real optimization; without `baseline.json`, the gate would scan both runs.

#### Cold path C — the report

**File:** `eval/report.eval.ts` (lines 60-70)

Same shape: `readdirSync` + filter-by-runId + parse per file. This one reads `usage`, `durationMs`, and `toolCalls[]` from each receipt to print percentiles. Because it's percentile math, it inherently needs every receipt — no aggregation shortcut helps.

#### Move 2 variant — the load-bearing skeleton

The **kernel of "supporting a read pattern with the storage layout"** has three parts:

```
  kernel of an "index" — three parts, applies to Map or file layout

  1. a lookup key                      → the identifier the reader has
  2. a store organized by that key     → O(1) or O(log n) direct lookup
  3. an entry point that exposes it    → the function or file naming
```

Applied to the hot path:
- Key: `(sessionId, insightId)`
- Store: `Map<sessionId, { Map<insightId, ...> }>`
- Entry point: `getInsight(sessionId, id)`

Applied to the cold path — this is the diagnostic:
- Key: `runId`, `caseId` (composite in the filename)
- Store: flat directory, no sub-directories
- Entry point: `readdirSync + filter` (there is no `getReceipt(runId, caseId)` function)

Drop the entry point (part 3) and every call site reimplements the scan. That's exactly what happens: `baseline.eval.ts`, `gate.eval.ts`, and `report.eval.ts` all open with the same `readdirSync + filter` boilerplate. When the same query is written three times, that's the missing abstraction — and it's a data-modeling smell, not just a code-duplication one.

**The fix if the cost matters:** introduce a `receipts.ts` module with `listRunIds()`, `readRun(runId): Receipt[]`, and (if aggregation gets frequent) a lazily-built `runId → summary` cache. Or, when case count grows, back it with SQLite — a single indexed table with `(runId, caseId, dimension, score)` rows makes every aggregation an indexed lookup.

### Move 3 — the principle

**An index is a promise that a specific question can be answered without reading everything.** The Map-of-Maps for sessions makes `getInsight` cheap because it *is* an index — hashed by two keys, one lookup each. The filename encoding `<caseId>-<runId>.json` is *also* an index for the "give me one specific receipt" question, but every eval-time query today asks a different question: "give me *all* receipts for runId X," or worse, "aggregate scores across every run." Those questions have no index behind them; they scan. The rule you take home: **whenever you write the same `readdirSync + filter + parse` block a third time, you've built a database — badly.** That's the moment to either abstract the read path into one function (cheap) or introduce a store that actually indexes (bigger commit, real payoff). blooming_insights is at *two* copies of the pattern; the third is where the abstraction earns its way in.

## Primary diagram

Every hot and cold read path, side by side, with the "index" (or lack of one) named.

```
  blooming_insights — reads and the layouts that support them

  HOT PATH (per request, sub-ms)
  ┌────────────────────┐   Map<sid, {Map,Map,Map}>   ┌────────────┐
  │ getInsight(sid,id) │──►  O(1) session lookup  ──►│ Insight    │
  │ listInsights(sid)  │──►  O(1) + O(k) values   ──►│ Insight[]  │
  │ getInvestigation() │──►  O(1) both levels     ──►│ Investig.  │
  └────────────────────┘                             └────────────┘

  WARM PATH (per demo mode load)
  ┌────────────────────┐   readFile + JSON.parse    ┌────────────┐
  │ getCachedInvestig. │──►  single-file, ~80KB  ──►│ AgentEvent│
  └────────────────────┘   (three-tier: mem/dev/dem) │ [] │
                                                     └────┘

  COLD PATH (per eval run, seconds)
  ┌────────────────────┐   readdirSync + filter    ┌────────────┐
  │ baseline aggregate │──►  linear directory scan ─►│ Baseline  │
  │ gate compare       │──►  + JSON.parse × N       │ GateResult │
  │ report percentiles │──►  ~35KB per parse        │ printout   │
  └────────────────────┘                             └────────────┘
                              no query index —
                              every question is a scan
```

## Elaborate

The two-tier Map is a hand-rolled **sharded index** — the outer Map is the shard key (session), the inner is the primary key (entity id). Every real database implements this same shape internally (Postgres partitioning, Redis clustering, MongoDB sharding) — it just puts it behind a query planner. In an in-process store, you build it yourself, in TypeScript.

The receipts-directory pattern is a **write-optimized log** with no read-side index. Kafka is the archetype; append-only Postgres tables with only a sequence number are another. Both are fine *if* you consume them by scanning from a known offset. The moment consumers start asking questions like "find every row where field X has property Y," you need either (a) a secondary index on the log, (b) a materialized projection that answers the specific query, or (c) a real query engine. `baseline.json` is option (b) — it's a materialized projection that answers the gate's question in O(1). It's the right choice; it just happens to be the *only* one, and every other cross-run question is currently unanswered.

## Interview defense

**Q: "How does a request read data in this system?"**
Answer: "The feed page calls `listInsights(sessionId)` which is a two-level Map lookup — `lib/state/insights.ts:81-84`. The outer Map is keyed by sessionId to partition users on a warm serverless instance; the inner is keyed by insight id. Both hits are O(1). Getting one card by id is the same pattern — `getInsight(sid, id)` on line 73. There's no database, no ORM, no query — it's a hashed lookup in RAM." Draw the two-level Map diagram from Move 1.

**Q: "Where's the index in this codebase?"**
Answer: "The hot path *is* an index — `Map<sessionId, {Map<id, Insight>, ...}>` acts as a two-key hash. Perfect for the read pattern. The eval subsystem is different: every aggregation reads `eval/receipts/` with `readdirSync + filter-by-runId + JSON.parse × N`. That's a table scan against the filesystem, done in Node memory. It's fine at 10 cases per run; it doesn't scale to 200. The one optimization we have is `eval/baseline.json` — a pre-aggregated summary the regression gate reads instead of re-scanning the baseline run. That's a materialized view." Anchor: `eval/baseline.eval.ts:44-51` for the scan; `eval/gate.eval.ts` for the gate that uses the materialized baseline.

**Q: "When would you introduce a real store?"**
Answer: "When we ask a cross-run question that the file layout can't answer without a scan. Right now the only cross-run question is 'did per-dimension pass rate drop by more than 10 percentage points?', and the pre-aggregated baseline answers it. The trigger would be: 'show me every case where evidence_grounding scored ≤ 2 in the last month.' That has no answer today short of parsing every file. SQLite would be the smallest jump — one table with `(runId, caseId, dimension, score)` rows, one index on `(dimension, score)`, and every trend query is O(log N)." Draw the scan diagram side by side with the indexed-lookup diagram.

## See also

- `01-the-data-model-and-its-shape.md` — the shapes being read.
- `04-transactions-and-integrity.md` — writes that would need atomicity if the store gets replaced.
- `06-access-patterns-and-storage-choice.md` — the read-vs-write pattern analysis behind the storage choice.
