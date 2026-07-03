# Records, pages, and storage layout

*Physical layout / Language-agnostic*

## Zoom out, then zoom in

You know how in Postgres a row is a tuple, tuples pack into 8KB pages, pages live in a heap file, and the whole thing loves *locality* — rows read together should live together? That's the mental model behind "storage layout." Now: this repo has no pages, no heap file, no disk-block cost model. What it has is JavaScript objects in a `Map`. This file walks the standard model, then names where the equivalents live here and where they simply don't exist.

```
  Zoom out — where records physically live in this repo

  ┌─ UI ─────────────────────────────────────────────────────┐
  │  Insight, Anomaly, Investigation shapes render here      │
  └────────────────────┬─────────────────────────────────────┘
                       │  JSON over NDJSON
  ┌─ Service (Vercel) ─▼─────────────────────────────────────┐
  │                                                          │
  │  ★ heap-shaped `Map` of JS objects                        │ ← this file's scope
  │    lib/state/insights.ts:14                              │
  │                                                          │
  │  ★ JSON-encoded rows on disk (deploy-time)                │
  │    lib/state/demo-*.json                                  │
  │    eval/baseline.json, eval/receipts/*.json               │
  │                                                          │
  └────────────────────┬─────────────────────────────────────┘
                       │
  ┌─ Provider (Bloomreach) ▼─────────────────────────────────┐
  │  the real pages / heaps / rows are in there — opaque     │
  └──────────────────────────────────────────────────────────┘
```

**Zoom in.** Every `Insight` in memory is a plain JS object — a row. The V8 heap decides where it physically sits; we don't. But the *access pattern* still matters: which fields we read together, which we compute lazily, whether the "row" is one object or two joined shapes. That's the layout question here, minus the disk-block layer.

## Structure pass

**Axis to hold constant: locality — what stays together when you read one row?**

Three layers of "storage":

```
  "what lives next to what?" — traced across the three layers

  ┌─ Bloomreach page/heap (opaque) ───────────────────────┐
  │  a purchase row lives in real DB pages we can't see    │  → engine decides locality
  └───────────────────────────────────────────────────────┘
      ┌─ in-memory JS object ────────────────────────────────┐
      │  an Insight is one heap-allocated object with the     │
      │  evidence[] and derived fields already denormalized in │  → we decide locality
      │  (deriveInsightFields spreads into the row)            │    via the row shape
      └──────────────────────────────────────────────────────┘
          ┌─ on-disk JSON blob ─────────────────────────────────┐
          │  demo-insights.json is one whole file per snapshot   │  → filesystem decides,
          │  eval/receipts/*.json is one whole file per (case×run)│    we choose the split
          └─────────────────────────────────────────────────────┘
```

The seam that flips the axis: **the "one row vs many rows" boundary between the object and the file.** In memory, one `Insight` is one object — atomic read. On disk, one snapshot is one file that contains *many* `Insight`s (`demo-insights.json`) — you either read the whole file or you don't read anything. That's a chunkier locality boundary than any real DB would let you have, and it's the right call here because we never partial-load a snapshot.

## How it works

### Move 1 — the mental model

Two ways to think about "a row" in any storage system:

```
  row-oriented (Postgres, MySQL)          columnar (Parquet, ClickHouse)
  ────────────────────────────           ─────────────────────────────
  [id | severity | headline | ...]        [id, id, id, id, ...]
  [id | severity | headline | ...]        [severity, severity, ...]
  [id | severity | headline | ...]        [headline, headline, ...]

  fast: SELECT * WHERE id=?               fast: SELECT AVG(revenue)
  slow: aggregate one column              slow: single-row point read
```

This repo is aggressively row-oriented. Every `Insight`, every `Anomaly`, every `Investigation` is a single JS object holding every field the UI needs — headline, severity, change, evidence, impact, history, category, and the derived fields spread on top. When you fetch it, you get all of it. There is no world in which we'd want to read just the `severity` of every insight without reading the headline too, because the UI renders the whole card as one unit.

The kernel:

```
  the row kernel — one object, all fields co-located

  Insight {
    id, timestamp,
    severity, headline, summary,           ← UI-critical fields
    metric, change, scope, source,         ← analytical fields
    evidence?, impact?, history?, category?, ← optional trace fields
    ...deriveInsightFields(anomaly)        ← denormalized derived fields
  }

  one Map.set() writes it whole; one Map.get() reads it whole.
  no partial reads. no half-populated rows.
```

That's the load-bearing shape: **row = complete UI card**. The derived fields (`deriveInsightFields`) are spread into the row at write time, not computed at read time. That's a classic denormalize-for-read choice — you spend one CPU-microsecond on each write to save N read-time computations.

### Move 2 — the primitives walked

**A "row" is a JS object; a "table" is a `Map`.**

```ts
// lib/state/insights.ts:25-45
export function anomalyToInsight(a: Anomaly): Insight {
  const id = crypto.randomUUID();          // primary key
  const sign = a.change.direction === 'down' ? '-' : '+';
  const headline = `${a.scope.join(' ')} ${a.metric} · ${sign}${Math.abs(a.change.value)}%`.toLowerCase();
  return {
    id,                                    // ← PK
    timestamp: new Date().toISOString(),
    severity: a.severity,
    headline,
    summary: `${a.metric} ${a.change.direction} ${Math.abs(a.change.value)}% vs ${a.change.baseline}`.toLowerCase(),
    metric: a.metric,
    change: a.change,                      // ← nested object, not a foreign key
    scope: a.scope,                        // ← array field, not a join table
    source: 'monitoring',
    evidence: a.evidence,                  // ← nested array of {tool, result}
    impact: a.impact,
    history: a.history,
    category: a.category,
    ...deriveInsightFields(a),             // ← denormalized derived fields spread in
  };
}
```

Read that top to bottom and you get the entire schema. Notice what isn't there: no foreign keys, no join tables, no separate `insight_evidence` normalized-out table. Everything the UI needs to render an `InsightCard` is on this one object. In Postgres you'd have `insights`, `evidence`, and `evidence_items` as three tables and reconstruct the row with two joins; here you `Map.get` and you're done.

**A "page" doesn't exist; the JS heap chooses locality.**

There is no 8KB page boundary. V8 allocates the object wherever it likes, and adjacent inserts don't have to be adjacent in memory. If you needed to make sequential reads of 100k insights fast, you'd feel this — but this repo's access pattern is *point read one insight by id*, not scan-and-project. The lookup cost is `O(1)` hash-table access; the physical layout is the runtime's problem.

**Locality of reference — what is co-accessed?**

```
  the access-pattern table — what gets read together

  read path                          fields accessed
  ─────────────────────────         ─────────────────────────────────
  feed render (InsightCard × N)     id, severity, headline, summary,
                                     change, scope, evidence, impact,
                                     history, category, derived fields
                                     → basically the whole row

  investigation subject banner       id, headline, severity, metric,
                                     scope, change
                                     → still most of the row

  investigate route lookup           id (PK lookup)
                                     → PK only, but returns whole row

  demo replay                        all rows, all fields, in order
                                     → whole "table" scan
```

Every read path touches most of the row. That's why the denormalized row shape wins here — a normalized schema would force joins on every read for no benefit.

**On-disk layout — one snapshot per file.**

```
  lib/state/demo-insights.json           665 lines
  ──────────────────────────
  {
    insights:  [ {...}, {...}, {...}, ... ],
    workspace: { projectId, projectName, ... },
    trace:     [ {...}, {...}, ... ]
  }

  lib/state/demo-investigations.json   3,487 lines
  ──────────────────────────────────
  {
    "<insightId>": [ AgentEvent, AgentEvent, ... ],
    "<insightId>": [ AgentEvent, AgentEvent, ... ],
    ...
  }

  eval/receipts/*.json                   28 files
  ────────────────────────
  one file per (caseName, runId) — the atomic unit is
  "one scored case in one eval run"
```

The chunk size is *deliberate*: a snapshot is one file because you always load it whole to replay it; each receipt is its own file because the regression gate iterates them by runId (`gate.eval.ts:64-66` reads with `.endsWith(\`${runId}.json\`)`). If you'd put all receipts in one file, adding a new run would rewrite the whole file every time; splitting them makes the git history readable per case.

That's the "pages" analog here — the file boundary is your locality boundary.

**The `Anomaly` vs `Insight` split — normalized in memory only.**

```
  lib/state/insights.ts:8-12
  ──────────────────────────
  type SessionFeed = {
    insights:       Map<insightId, Insight>;
    investigations: Map<insightId, Investigation>;
    anomalies:      Map<insightId, Anomaly>;      ← same key, different table
  };
```

An `Insight` is what the UI renders; an `Anomaly` is what the diagnostic agent needs to re-investigate. Same primary key (the insight id), two different rows. This is the closest thing this repo has to *two joined tables*: `getAnomaly(sessionId, id)` and `getInsight(sessionId, id)` are two separate calls, and `resolveAnomaly` in `app/api/agent/route.ts:35-49` walks both. In a real DB this would be `SELECT ... FROM insights JOIN anomalies USING (id)`. Here it's two hash lookups.

The reverse mapper `insightToAnomaly` (`insights.ts:53-55`) intentionally drops `evidence`, `impact`, `history`, `category` — comment on that function names the round-trip choice. The diagnostic agent only needs metric/scope/change/severity; the rest is regenerated downstream. That's the "which fields are the row's primary key material vs derived" question, answered without SQL.

### Move 2 variant — the load-bearing skeleton

What is the smallest thing you can remove and still have a working record layer?

1. **The row-completeness invariant.** Every `Insight` is either fully populated or absent — no half-rows. Break this and the UI has to null-check every field; today it null-checks a few (`evidence?`, `impact?`, `history?`, `category?`) as *optional* fields, not "populated later." The `anomalyToInsight` write happens once, all at once, and the row is done.
2. **The stable primary key (`id = crypto.randomUUID()`, `insights.ts:26`).** Break this — reuse ids across runs, say — and the UI's card-stashing (`sessionStorage`) hydrates the wrong investigation on step 3. The UUID is what makes cross-session cross-run identity work.
3. **The denormalized derived fields (`...deriveInsightFields(a)`, `insights.ts:44`).** Remove this and the UI has to re-derive on every render. Not a correctness break, but a real performance loss — the InsightCard renders 10-20 fields' worth of derivation logic per card.

The rest — the sub-Map for `anomalies` keyed by the same id, the JSON file split at snapshot boundaries — is optimization, not skeleton.

### Move 3 — the principle

**Layout follows access pattern; denormalize for reads when writes are one-shot and reads are many.** In a real DB you'd think in terms of 8KB pages and column-ordering. In this repo you think in terms of "one object per UI card, spread the derived fields at write time." Same principle, different physical unit. When your writes are batchy (one briefing produces N insights in one turn) and your reads are point-lookups (feed render, investigation deep-dive), the denormalized row is the fast path in either physical model.

## Primary diagram

```
  Records-and-pages, this-repo-flavored

  ┌─ per-session in-memory "tables" ────────────────────────────┐
  │                                                              │
  │  Map<sessionId, SessionFeed>                                 │
  │      ┌──────────────────────────────────────────────────┐    │
  │      │  insights: Map<insightId, Insight>                │    │
  │      │  ┌────────────────────────────────────────────┐   │    │
  │      │  │ id, timestamp, severity, headline,          │   │    │
  │      │  │ summary, metric, change, scope, source,     │   │    │
  │      │  │ evidence?, impact?, history?, category?,    │   │    │
  │      │  │ ...deriveInsightFields(anomaly)             │   │    │
  │      │  └────────────────────────────────────────────┘   │    │
  │      │       one row = one heap-allocated JS object       │    │
  │      │                                                    │    │
  │      │  anomalies: Map<insightId, Anomaly>                │    │
  │      │  investigations: Map<insightId, Investigation>     │    │
  │      └──────────────────────────────────────────────────┘    │
  │                                                              │
  └──────────────────────────────────────────────────────────────┘

  ┌─ on-disk "pages" (JSON files in git) ───────────────────────┐
  │                                                              │
  │  lib/state/demo-insights.json                                │
  │    { insights: [ ...N whole rows... ], workspace, trace }    │
  │                                                              │
  │  lib/state/demo-investigations.json                          │
  │    { "<insightId>": [ AgentEvent, ... ], ... }               │
  │                                                              │
  │  eval/receipts/<case>-<runId>.json  (one row per file)       │
  │                                                              │
  └──────────────────────────────────────────────────────────────┘
```

## Elaborate

The "row-oriented denormalized rows" choice is not radical — it's what every React app implicitly does with props. The name for it in DB literature is *materialized view*: the row you read is not the row you wrote, it's a pre-joined pre-derived view that lives at the same key. Materialized views are expensive to maintain in a real DB because inserts have to update the view too. Here the write is *the* view — `anomalyToInsight` is the join+derive step, and the output goes straight into the read cache. That's a cheap trick a live app can play only because there is exactly one writer per key per turn.

If this app grew a cross-session query surface ("show me every insight where category=X, across all users") you'd feel the missing indexes immediately — every Map is per-session, so a cross-session scan means iterating the outer Map. `03-btree-hash-and-secondary-indexes.md` picks up that thread.

## Interview defense

**Q: "How is data physically stored in this app?"**

Model answer: "There are three layers. Runtime: JS objects in a `Map<sessionId, SessionFeed>` at `lib/state/insights.ts:14` — one heap-allocated object per `Insight`, denormalized so the entire UI card is one row, no joins. V8 chooses physical placement. On disk at deploy time: whole-file JSON blobs — `lib/state/demo-*.json` for snapshots, `eval/receipts/*.json` split one file per (case × runId). The file boundary *is* the locality boundary — you either load the whole snapshot to replay it or you don't. Remote: the real Bloomreach pages we never see. The load-bearing choice is that every `Insight` is a *complete UI card* — derived fields are spread into the row at write time via `deriveInsightFields`, not computed at read."

Diagram to sketch: the "records-and-pages this-repo-flavored" recap, top half showing in-memory Maps, bottom half showing JSON files.

**Q: "Why not normalize `Insight` and `Anomaly` into shared tables?"**

Model answer: "There *is* a normalization here — they're separate inner Maps at `insights.ts:8-12`, both keyed by the same insight id. Two 'tables,' one key. The `Insight` holds what the UI renders; the `Anomaly` holds what the diagnostic agent needs to re-investigate. Splitting them means the reverse mapper `insightToAnomaly` at `insights.ts:53-55` can deliberately drop `evidence`, `impact`, `history`, `category` — the agent doesn't need them and they'd bloat the re-investigation input. So it's normalized where the *purpose* diverges (write path vs re-read for re-investigation), and denormalized where the purpose stays the same (UI card = one row). The join is two hash lookups in `resolveAnomaly` (`app/api/agent/route.ts:35-49`)."

Anchor: same PK, two sub-Maps, cheap "join" by identity.

## See also

- `01-database-systems-map.md` — the full storage topology this file zooms in on.
- `03-btree-hash-and-secondary-indexes.md` — the lookup structures over these rows.
- `04-query-planning-and-execution.md` — how scans and joins would work over Maps.
- `05-transactions-isolation-and-anomalies.md` — atomicity of the "replace the whole row" write.
