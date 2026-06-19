# Deterministic synthetic data + ground-truth records

> **RETIRED 2026-06-18.** This file was authored against the Olist MCP
> server / Phase 3 eval pipeline, both removed from the codebase. The
> patterns it teaches are real, but the code anchors it cites no longer
> exist. Preserved as a historical record of what was studied.
>
> **What replaced this:** the determinism-in-test-data pattern is still
> real — it now lives in `11-in-process-synthetic-fixture.md`, anchored
> to `lib/data-source/synthetic-data-source.ts`. The new pattern is
> in-process (no SQLite, no `mulberry32`, no `seed=42`) and the
> ground-truth-records half is gone with the eval pipeline. The
> `SyntheticDataSource` is deterministic by construction — every payload
> is a source-code const literal, so there's no PRNG to seed. The audit's
> finding #7 names the missing contract test for that determinism.

**Industry name(s):** Deterministic synthetic data · seeded PRNG · ground-truth records · golden-set data model · eval data contract · result schema as contract
**Type:** Industry standard · Language-agnostic · Project-specific (the mulberry32 + seeded_anomalies + golden-fixtures combination)

> The pattern that connects schema design to AI evals. The Olist DB is **synthetic** (no real Brazilian customer data) and **deterministic** (`mulberry32(seed=42)` makes it byte-identical across machines), with **three seeded anomalies** modeled IN the DB (`seeded_anomalies` table) that serve as **ground truth** for Phase 3 evals. The Phase 3 eval pipeline writes structured **result schemas** to `eval/results/<date>/*.json` — those JSON shapes are themselves data contracts the scoring step depends on, and the **regression-golden** fixtures (`eval/fixtures/regression-golden/01..10.json`) are git-tracked snapshots of the captured agent behavior. This file walks all three patterns: determinism in test data, ground truth as records, and result schemas as contracts.

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Three layers, one loop. The seeder writes deterministic data to the Olist DB. The agent reads the data through the tools and emits anomaly findings. The evaluator reads the seeded anomalies from the DB and the agent's findings from a result JSON, then scores precision/recall. Determinism is what makes the loop reproducible — every run from a fresh repo clone should produce the same data, hit the same edge cases, and (modulo LLM stochasticity) get comparable scores.

```
  Zoom out — the eval-data loop

  ┌─ SOURCE (mcp-server-olist/scripts/seed-olist.ts) ────────┐
  │  mulberry32(seed=42)                                       │
  │  → 5,000 customers, ~9,800 orders, ~13k items, etc.        │
  │  → byte-identical every run                                │
  │  → SEEDED_ANOMALIES injected as multiplier on subsets      │
  └────────────────────────────┬─────────────────────────────┘
                               │ writes to
  ┌─ SQLite DB (mcp-server-olist/data/olist.db) ─────────────┐
  │  data tables + seeded_anomalies (3 rows of ground truth)  │
  └────────────────────────────┬─────────────────────────────┘
                               │ read by agent tools (3) +
                               │ read by eval pipeline (run-detection)
  ┌─ Agent loop ────────────────▼─────────────────────────────┐
  │  monitoring agent surfaces anomalies                       │
  │  outputs Anomaly[] in JSON                                 │
  └────────────────────────────┬─────────────────────────────┘
                               │ captured into result JSONs
  ┌─ Eval results (eval/results/<date>/*.json) ──────────────┐
  │  detection-K10-raw.json          ← raw agent outputs       │
  │  detection-K10-loose.json        ← loose matches           │
  │  detection-K10-strict.json       ← strict matches          │
  │  summary.md                       ← scorecard               │
  │                                                            │
  │  scored against: seeded_anomalies (the ground truth)       │
  └────────────────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** Three sub-concepts, one file:

1. **Determinism in test data** — `mulberry32(seed=42)` is the pure-function PRNG; same input always produces the same data.
2. **Ground-truth records modeled IN the data** — `seeded_anomalies` is a table in the same DB the agent reads from; the eval queries it directly.
3. **Result schemas as data contracts** — `eval/results/<date>/*.json` files have a stable structural shape; the `summary.md` renderer and the `score` mode both depend on it. The `regression-golden/` fixtures (10 files) are the most rigid — `score` mode does structural-diff against them.

---

## Structure pass

**Layers.** Seed-time layer (writes the DB and the seed-anomalies rows) → query-time layer (agent reads through tools) → eval-time layer (scorer reads agent output + seed-anomalies). The discipline that runs across all three: **every artifact is a deterministic function of inputs that are pinned in the repo.**

**Axis: reproducibility.** For each artifact (data, agent output, eval score), what makes another developer reach the same artifact starting from the same git commit? This is the right axis because "deterministic synthetic data" is *literally* about pinning the answer to that question. Cost is wrong (PRNG is free); failure is wrong (these layers don't fail-propagate). Reproducibility pops the seams: each layer has a different reproducibility story.

**Seams.** Three matter. **S1: seed → DB.** `mulberry32(seed=42)` makes this fully deterministic. **S2: DB → agent.** Determinism breaks here — the LLM is stochastic; even with `temperature=0`, the agent's tool-call interleavings vary. **S3: agent output → eval score.** Deterministic given the agent output and the seeded_anomalies — the scorer is a pure function.

```
  Structure pass — reproducibility across seams

  ┌─ 1. LAYERS ──────────────────────────────────────────────┐
  │  Seeder · DB · Tools · Agent · Eval scorer                │
  └─────────────────────────────┬────────────────────────────┘
                                │  pick the axis
  ┌─ 2. AXIS ──────────────────▼─────────────────────────────┐
  │  reproducibility: does the same git commit + the same    │
  │  inputs reach the same artifact?                          │
  └─────────────────────────────┬────────────────────────────┘
                                │  trace across seams
  ┌─ 3. SEAMS ─────────────────▼─────────────────────────────┐
  │  S1: seeder → DB        ★ fully deterministic            │
  │  S2: DB → agent         ★ stochastic (the LLM)           │
  │  S3: agent → eval score ★ deterministic again            │
  └─────────────────────────────┬────────────────────────────┘
                                ▼
                        Block 4 — How it works
```

---

## How it works

### Move 1 — the determinism picture

You know how `npm test` running twice on your machine reaches the same answer because the test inputs are fixed? Same shape here, but at the dataset level. Most synthetic-data generators use `Math.random()` — every run produces different data, every developer gets a different DB. That breaks evals. `mulberry32(seed=42)` replaces it: a tiny deterministic PRNG, seeded with a fixed integer, that produces the same sequence on every run.

```
  the determinism kernel — mulberry32

  function mulberry32(seed) {
    let state = seed >>> 0;
    return function next() {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const rng = mulberry32(42);    ← seed is a constant
  const v1 = rng();              ← always the same
  const v2 = rng();              ← always the same
  ...

  every generator (customers, orders, items, payments, reviews) reads
  from `rng()` in a fixed order. swap one rng() for two rng() calls
  somewhere and EVERY downstream value shifts — that's the test pressure
  on the seed: it's brittle by design, because brittle is the same as
  reproducible.
```

**Skeleton parts of deterministic synthetic data:**

1. **Pure PRNG.** No `Math.random`, no `Date.now()`, no `process.pid`. Anything that varies between runs breaks determinism.
2. **Fixed seed.** A constant integer the seeder reads as `const OLIST_SEED = 42`.
3. **Fixed call order.** Every generator function reads from `rng()` in a stable order; reordering changes the output.
4. **Fixed time anchor.** The data horizon end is `END_TS = Math.floor(Date.UTC(2026, 5, 1) / 1000)` — a constant, not "now."

Drop step 1 (use `Math.random`) and the data is non-reproducible. Drop step 4 (use `Date.now()`) and the data drifts across calendar days even with a fixed seed.

### Move 2 — the seeded anomalies as ground-truth records

The `seeded_anomalies` table is the eval contract. Three rows, each describing one anomaly the seeder deliberately injected by applying a multiplier on a subset of generated orders.

```
  the three seeded anomalies

  id: sp-revenue-drop-w4
    metric:     'revenue'
    dimension:  'state'
    segment:    'SP'
    window:     week 4 of the 26-week horizon
    multiplier: 0.7              ← São Paulo orders that week have a 30%
                                   chance of being dropped during seed
    expected_severity: 'critical'

  id: electronics-spike-w2
    metric:     'order_count'
    dimension:  'category'
    segment:    'electronics'
    window:     week 2
    multiplier: 2.5              ← 1.5× extra electronics orders inserted
                                   in week 2 (over-sampling)
    expected_severity: 'warning'

  id: voucher-dropoff-w10-on
    metric:     'payment_value'
    dimension:  'payment_type'
    segment:    'voucher'
    window:     week 10 through end of horizon
    multiplier: 0.05             ← 95% of voucher payments dropped
                                   (sustained collapse)
    expected_severity: 'critical'
```

Two of these are **dropoffs** (multiplier < 1, applied as Bernoulli-trial keep/drop during generation) and one is a **spike** (multiplier > 1, applied as oversampling extra orders in the window). The seeder handles both in `shouldKeepOrder()` + `generateAnomalyBoosters()`.

**What makes this a ground-truth record:** the eval pipeline (`eval/scripts/run-detection.ts`) doesn't read the multiplier from anywhere; it reads `seeded_anomalies` from the DB and matches the monitoring agent's output against `(metric, dimension, segment, window)`. The DB row IS the spec.

**What audit finding #4 names:** the `description TEXT NOT NULL` column says "Revenue in São Paulo (SP) drops ~30% in week 4" — and the multiplier (`0.7`) is what produces that 30%. The multiplier is the load-bearing number; the description is human prose. They sit in different files (the description in the DB, the multiplier in the seed constant). Change one without the other and the description becomes a lie.

### Move 2 — the eval result schemas as data contracts

The Phase 3 eval pipeline writes JSON files under `eval/results/<YYYY-MM-DD>/`. Two kinds of files matter for this guide:

**(a) Per-run detection results.** `detection-K10-raw.json`, `detection-K10-loose.json`, `detection-K10-strict.json`. The shape is fixed: array of K runs, each with `runIndex`, `anomalies` (the agent's output), `matches` (per-seeded-anomaly: was it detected loose/strict), `errors[]`. The scorer reads this shape; the `summary.md` renderer reads this shape; a future regression-comparison tool would read this shape. **The JSON shape is the contract.**

**(b) Regression-golden fixtures.** `eval/fixtures/regression-golden/01-monitoring-empty.json` through `10-intent-classify-investigation.json` — 10 captured "golden" outputs across all four agents. Each has:

```
  the regression-golden shape

  {
    "id": "<fixture-name>",
    "agent": "monitoring" | "diagnostic" | "recommendation" | "query" | "intent",
    "description": "<one paragraph naming what this fixture exercises>",
    "input": { ... },             ← the agent's input (mode, categories, etc.)
    "golden_output": [...]         ← the captured output to diff against
  }
```

The `score` mode of the eval pipeline does **structural diff** between a fresh run and the `golden_output` — every field is compared, every array element is compared in order. The fixture's shape IS the regression contract. A future change to the agent (a renamed field, a reordered array, a new optional field) shows up as a diff against these fixtures.

```
  the result-schema hierarchy

  loosest (free-form):    raw agent JSON (validate.ts narrows it)
                          ↓
                          captured into detection-K10-raw.json
                          (audit trail; not the contract)
                          ↓
  more structured:        per-run matches + aggregate scores
                          summary.md is a projection of this
                          ↓
  most structured:        regression-golden fixtures
                          structural-diff every field; ANY change is
                          a flagged regression unless the golden is
                          re-captured deliberately
```

### Move 3 — the principle

A data model is correct when its determinism story matches its consumers' reproducibility needs. **Synthetic data with `Math.random()` is a contradiction** — the whole point of synthetic data is "I control the inputs, so I control the outputs." `mulberry32(seed=42)` makes the seed-to-DB step deterministic, the seeded-anomalies table makes the DB-to-eval contract auditable, and the regression-golden fixtures make the eval-output shape structurally testable. Every step in the loop is reproducible except the LLM itself — and even there, the K=10 averaging gives statistical reproducibility. The discipline transfers: any time you're building a data layer that feeds an AI eval, pin the data with a deterministic seed, model the ground truth as records, and capture the result shapes as committed contracts.

---

## Primary diagram

The full eval-data loop, with reproducibility annotated.

```
  the eval-data loop — what's deterministic where

  ┌─ SEED-TIME ────────────────────────────────────────────────┐
  │  mulberry32(seed=42)                  ★ deterministic       │
  │  + SEEDED_ANOMALIES constant          ★ pinned in source    │
  │  + END_TS = 2026-06-01 (constant)     ★ no Date.now()       │
  │                                                              │
  │  → writes data/olist.db (byte-identical across machines)    │
  │  → writes 3 rows in seeded_anomalies                        │
  └────────────────────┬───────────────────────────────────────┘
                       │
  ┌─ QUERY-TIME ───────▼───────────────────────────────────────┐
  │  agent tools query the DB via prepared statements           │
  │  same SQL → same rows → same JSON outputs                   │
  │                                                              │
  │  agent loop is stochastic (LLM)         ★ NOT deterministic │
  │    even with temperature=0, tool-call ordering varies        │
  │                                                              │
  │  → emits Anomaly[] JSON per run                              │
  └────────────────────┬───────────────────────────────────────┘
                       │
  ┌─ EVAL-TIME ────────▼───────────────────────────────────────┐
  │  run-detection runs K=10 independent agent runs              │
  │  scorer reads seeded_anomalies + each run's anomalies        │
  │  scorer is a pure function           ★ deterministic         │
  │                                                              │
  │  → writes detection-K10-raw/loose/strict.json                │
  │  → writes summary.md                                         │
  │                                                              │
  │  regression-golden fixtures (committed)                      │
  │    → score mode structural-diffs against them                │
  │    → drift surfaces as a failing test                        │
  └────────────────────────────────────────────────────────────┘
```

---

## Implementation in codebase

### The deterministic PRNG

```
mcp-server-olist/scripts/seed-olist.ts  (lines 36–45)

  function mulberry32(seed: number): () => number {
    let state = seed >>> 0;                   ← coerce to uint32
    return function next() {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;  ← [0, 1)
    };
  }

  const OLIST_SEED = 42;                       ← the constant
  const rng = mulberry32(OLIST_SEED);
       │
       └─ pure ALU; no allocations after the closure capture; no
          dependence on time, environment, or process state. the
          ONLY thing that affects the output is the seed.
```

### The seeded anomaly definitions

```
mcp-server-olist/scripts/seed-olist.ts  (lines 143–179)

  const SEEDED_ANOMALIES = [
    {
      id: 'sp-revenue-drop-w4',
      metric: 'revenue',
      dimension: 'state',
      segment: 'SP',
      start_ts: START_TS + 3 * 7 * 86400,
      end_ts:   START_TS + 4 * 7 * 86400,
      expected_severity: 'critical',
      description: 'Revenue in São Paulo (SP) drops ~30% in week 4 ...',
      _generator: { kind: 'multiplier', value: 0.7 }   ← ★ NOT in DB
    },
    { ... 'electronics-spike-w2', multiplier 2.5  ... },
    { ... 'voucher-dropoff-w10-on', multiplier 0.05 ... },
  ] as const;
       │
       └─ the multiplier (_generator.value) is the load-bearing fact.
          it's applied during generation in shouldKeepOrder() and
          generateAnomalyBoosters(). it lives ONLY in this constant —
          the DB stores the human description, not the multiplier.
          this is audit finding #4: drift risk if description and
          multiplier stop matching.
```

### Where the seeded anomalies are read by the eval

```
eval/scripts/lib/run-agent.ts and run-detection.ts

  // load the ground truth FROM THE DB the agent just read
  const seededAnomalies = db.prepare('SELECT * FROM seeded_anomalies').all();

  // run the agent K times, score each run
  for (let k = 0; k < K; k++) {
    const agentOutput = await runMonitoringAgent(...);
    const matches = matchAnomalies(agentOutput, seededAnomalies);
    runs.push({ runIndex: k, anomalies: agentOutput, matches });
  }
       │
       └─ the DB is the source of truth. the eval queries it; the agent
          queries it. one shared substrate, two consumers. that's why
          the seeded_anomalies row IS the spec — both sides read it.
```

### The regression-golden fixture shape

```
eval/fixtures/regression-golden/01-monitoring-empty.json  (excerpt)

  {
    "id": "01-monitoring-empty",
    "agent": "monitoring",
    "description": "Monitoring scan of the live Olist DataSource ...",
    "input": {
      "dataset": "olist",
      "categories": "[] (no checklist provided — broad scan)",
      "notes": "..."
    },
    "golden_output": [
      {
        "metric": "payment_value",
        "category": "payment_type_collapse",
        "scope": ["payment_type:voucher"],
        "change": { "value": 79.4, "direction": "down", ... },
        "severity": "critical",
        "impact": "...",
        "evidence": [...]
      }
    ]
  }
       │
       └─ every field in golden_output[] is checked structurally when
          the `score` mode runs. a renamed field is a regression.
          a re-ordered array is a regression. a new optional field
          requires a deliberate re-capture.
          ten such fixtures cover monitoring (2), diagnostic (3),
          recommendation (3), query (1), intent (1).
```

---

## Elaborate

The deepest structural choice here is that **the eval pipeline reads the SAME DB the agent reads**. A common temptation is to have a separate "ground truth" config (a YAML or JSON file outside the data layer) — and that's how most eval frameworks ship. The Olist setup puts the ground truth IN the DB, which has two big consequences. First, the multiplier-and-description coupling (audit finding #4) is a real risk: the table row could drift from the seed-time generator. Second, the eval gets a cleaner contract: `SELECT * FROM seeded_anomalies` returns rows in the same `(metric, dimension, segment, window)` shape the agent emits, so the matcher is just JOIN-and-compare. The tradeoff is named, not hidden.

The K=10 detection eval is the **statistical-reproducibility** complement to the deterministic-data story. The data is byte-identical; the agent isn't. Running the agent 10 times and aggregating gives a precision/recall number with a standard deviation — that's the reproducibility you can claim for the LLM-as-classifier piece. The `summary.md` reports `±std` alongside `mean` for exactly this reason. The bar for K matters: K=2 catches gross failures; K=10 gives ~±10% confidence intervals; K=30 would tighten further. The 2026-06-15 baseline run is K=10.

A subtle data-modeling point about **the regression-golden fixtures**. They're committed JSON snapshots of REAL captured agent outputs — not hand-curated "ideal" outputs. That choice is right for regression-testing (you want to know if behavior changed, not whether behavior is ideal); it would be wrong for quality testing (the fixture might enshrine a bug). The two roles are complementary: the regression-golden suite catches "did anything change?"; the K=10 detection eval scores "is what we have actually working?". Together they cover "stability + capability."

The most interesting thing about the **`description` column on `seeded_anomalies`** is that it's a *human-facing field in a machine-read table*. Most schema design says "don't store free-form text the machine has to parse" — but the description here isn't parsed; it's READ. It's documentation embedded in the DB so a developer running `SELECT * FROM seeded_anomalies` understands what each row means. That's a legitimate pattern (Postgres `COMMENT ON COLUMN` is the analog) — except SQLite doesn't have great `COMMENT ON` ergonomics, and a description column is the more portable alternative. The drift risk (audit #4) is the cost; clear documentation in the DB is the benefit.

## Interview defense

**Q: How does this codebase make its data deterministic?**
A: One tiny PRNG plus a fixed seed. `mulberry32(seed=42)` is in `mcp-server-olist/scripts/seed-olist.ts` L36–L45 — a pure 4-line uint32 hash that produces a number in [0, 1). The seeder reads from `rng()` in a fixed order for every generator (customers, products, orders, items, payments, reviews), and the time horizon is a constant (`END_TS = Date.UTC(2026, 5, 1) / 1000`) rather than `Date.now()`. The result is byte-identical data across machines: same git commit + same `npm run seed` = same `olist.db` file. That's the load-bearing property for the K=10 detection eval — without it, two developers running the same eval reach different numbers because they're scoring against different data.

**Q: Why is the ground truth in a DB table instead of a separate config file?**
A: Because the eval and the agent read the same substrate. The Olist DB has 7 tables: 6 "real" tables (customers, orders, etc.) that the agent's tools query, and one `seeded_anomalies` table the eval reads. Putting the ground truth in the DB means the matcher is just `(metric, dimension, segment, window)` against `(metric, dimension, segment, window)` — no parsing, no path resolution, no "where's the config file" question. The cost is the multiplier-vs-description drift risk (the multiplier lives in the seed constant; the description lives in the table; nothing enforces they stay aligned). Audit finding #4 names the fix: store the multiplier as a column or generate the description from the multiplier.

```
  diagram while you talk

  seeder         DB                eval
  ───────        ──────────────    ───────────
  mulberry32     customers,        SELECT * FROM
  (seed=42)  →   orders, ...   ←   seeded_anomalies
                                    │
                 seeded_anomalies   compare against
                 (3 rows of truth)  agent's Anomaly[]
                                    │
                                    detection-K10-*.json
                                    summary.md
```

## Validate

1. **Reconstruct.** Without opening the file: name the three seeded anomalies (id, metric, segment, multiplier). For each, name the schema column that the detection query filters on, and the index that supports the query.

2. **Explain.** Why does `mulberry32` count as "deterministic" when the underlying math involves uint32 overflow and bit shifts? What is the seed actually pinning?

3. **Apply.** A new seeded anomaly is proposed: "delivery delays in week 8 for the BA segment, +30% delivery time." Trace: which table holds the data the agent would query, which columns carry the signal, what multiplier you'd apply in the seeder, and what row you'd add to `seeded_anomalies`.

4. **Defend.** Someone argues the eval should use real Olist data (the Kaggle dataset) instead of a synthetic one. Defend the synthetic + seeded approach. (Hint: real data doesn't carry known-injected anomalies; you'd have no ground truth to measure recall against.)

## See also

- `01-the-data-model-and-its-shape.md` — `olistWorkspaceSchema()` is the agent's view of the data; this file covers the data behind that view.
- `04-transactions-and-integrity.md` — the seed runs in one SQLite transaction; FK enforcement protects the integrity of the relations the seeder writes.
- `05-migrations-and-evolution.md` — `drop-and-reseed` is legitimate BECAUSE the data is deterministically regenerable; this file walks why.
- `07-data-modeling-red-flags-audit.md` — finding #4 (description ↔ multiplier drift).
- `08-the-olist-relational-schema.md` — the 7 tables this data lands in.
- `10-units-in-column-names.md` — the `price_brl` bug; the eval evidence for measured downstream cost.

---
Created: 2026-06-16 — new file covering deterministic synthetic data, seeded_anomalies as ground truth, and eval result schemas as data contracts.
