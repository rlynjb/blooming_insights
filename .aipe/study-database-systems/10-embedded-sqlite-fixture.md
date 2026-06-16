# Embedded SQLite as Test Fixture

## Subtitle

The data layer as a deterministic, hermetic, committed binary one process away · Project-specific (pattern: data-as-fixture).

## Zoom out, then zoom in

Okay — here's the whole thing. In Phase 2 we authored an MCP server with its own SQLite database. The main Next.js app doesn't import a DB driver; the sibling subprocess does. The pattern that emerges — and the one this file teaches — is **the data layer as a hermetic test fixture**: write the schema, write the seed, ship the binary, and every clone of the repo has the same dataset byte-for-byte.

```
  Zoom out — where the embedded-SQLite-fixture pattern lives

  ┌─ UI layer ──────────────────────────────────────────────────────────────┐
  │  feed / investigate / debug — same React surface as before              │
  └────────────────────────────────────┬────────────────────────────────────┘
                                       │  agent emits MCP tool call
  ┌─ Service layer (main app) ────────▼────────────────────────────────────┐
  │  lib/agents/*.ts, lib/mcp/client.ts                                     │
  │  routes a tool call through stdio MCP transport                         │
  └────────────────────────────────────┬────────────────────────────────────┘
                                       │  child_process.spawn(stdio)
  ┌─ Provider layer (mcp-server-olist subprocess) ─▼─────────────────────────┐
  │                                                                          │
  │   ★ THIS FILE'S TERRITORY ★                                              │
  │                                                                          │
  │   better-sqlite3 readonly + WAL                                          │
  │   data/olist.db (3.5 MB, committed binary)                               │
  │   seeded by scripts/seed-olist.ts (mulberry32 PRNG, seed=42)             │
  │   three domain tools wrap parameterized SQL                              │
  │   three seeded anomalies as ground truth                                 │
  └──────────────────────────────────────────────────────────────────────────┘
```

Now zoom in. The pattern is the *combination* of four pieces — better-sqlite3 (sync driver), readonly open (no accidental mutation), seeded determinism (mulberry32 + seed=42), committed binary (reproducibility-by-clone). Take any one out and the test-fixture story falls apart. This file walks each piece and what it gives up vs gains.

## Structure pass

Three layers, one axis, three seams.

### The layers

```
  the four pieces stacked, by what they enforce

  ┌─ scripts/seed-olist.ts ────────────────────────────────────┐
  │  PRNG: mulberry32 with OLIST_SEED = 42                     │  build-time
  │  schema: hand-written CREATE TABLEs + 9 indexes            │  one-shot
  │  ground truth: 3 SEEDED_ANOMALIES with explicit windows    │
  └──────────────────────────────┬─────────────────────────────┘
                                 │  writes
                                 ▼
  ┌─ data/olist.db ─────────────────────────────────────────────┐
  │  3.5 MB SQLite file, committed to git                       │  durable
  │  ~30k rows, 7 tables, 9 indexes                             │  via git
  │  byte-identical across clones                               │
  └──────────────────────────────┬─────────────────────────────┘
                                 │  read
                                 ▼
  ┌─ src/db.ts ─────────────────────────────────────────────────┐
  │  openDb(): new Database(path, { readonly, fileMustExist })  │  runtime
  │  pragma WAL + foreign_keys ON                               │  every
  │                                                              │  open
  └──────────────────────────────┬─────────────────────────────┘
                                 │  used by
                                 ▼
  ┌─ src/tools/*.ts ────────────────────────────────────────────┐
  │  three domain tools wrap prepared statements                │  per
  │  validate input → build SQL → db.prepare().all(...) → JSON  │  call
  └──────────────────────────────────────────────────────────────┘
```

### The axis — `what does each piece make impossible?`

```
  axis: "what failure mode does each layer rule out?"

  seed script + fixed PRNG seed   →  rules out: non-reproducible test data
  committed binary                →  rules out: "works on my machine" drift
  readonly: true on open          →  rules out: a tool call mutating the DB
  prepared statements             →  rules out: SQL injection on user input
                                      (not user-facing here, but defensive)
```

Each layer's job is to remove a category of failure. Read together, the pattern is "remove ambient variability so the agent run is the experiment, not the data."

### The seams

```
  seam 1: build-time vs runtime
   ┌─ seed-olist.ts ─┐                ┌─ src/db.ts ─────┐
   │ writes the DB   │ ──── via fs ─► │ reads readonly  │
   │ (PRNG drives    │                │ (no PRNG, no    │
   │  every value)   │                │  mutation)      │
   └─────────────────┘                └─────────────────┘

  seam 2: in-process vs subprocess
   ┌─ main app ──────┐                ┌─ mcp-server-olist ┐
   │ no DB driver    │ ─── stdio ───► │ better-sqlite3 +  │
   │ in package.json │                │ data/olist.db     │
   └─────────────────┘                └───────────────────┘

  seam 3: the schema contract
   ┌─ db.ts (truth) ─┐                ┌─ olistWorkspaceSchema() ┐
   │ tables, indexes │ ── HAND ────► │ what the AGENT sees      │
   │ in the DB file  │   (not auto)   │ in lib/mcp/schema.ts L232│
   └─────────────────┘                └──────────────────────────┘
```

Seam 3 is the load-bearing one for drift risk — see Move 2d and finding #12 in `09-database-systems-red-flags-audit.md`.

## How it works

### Move 1 — the mental model

You know how a snapshot test in Jest works — call a function, serialize the output, commit the result, and every future run asserts against the committed string? Same idea, scaled up: the *whole database* is the snapshot. The seed script produces it; the binary lives in git; every clone of the repo gets the exact same starting state. The agent then runs against it, and its behavior is the variable under test.

```
  pattern — the data is the snapshot

       build-time             commit-time           run-time
       ──────────             ───────────           ────────
       seed-olist.ts    →     git commit       →   openDb(readonly)
       (deterministic)        olist.db              (no PRNG, no
                                                      mutation)
            │
            └─ same seed →
               same DB    →
               same fixture across every clone, forever
```

### Move 2 — the moving parts

**Move 2a — `better-sqlite3`: synchronous, embedded, sub-millisecond.**

`better-sqlite3` is a synchronous SQLite binding for Node. `db.prepare(sql).all(params)` returns rows immediately — no `await`. This is the opposite of `pg` / `mysql2` / `sqlite3` (the async one), which queue I/O on the event loop.

Bridge: think of `fs.readFileSync` vs `fs.readFile`. The sync version blocks the event loop for the duration of the call. That's bad in a server handling many concurrent requests; it's perfect in a subprocess that handles one MCP tool call at a time.

```
  why sync is right for THIS subprocess

  ┌─ mcp-server-olist process ───────────────────────────────┐
  │  one stdin → JSON message → one tool call → one response │
  │                                                           │
  │  there is never "two concurrent tool calls" inside this   │
  │  process. the subprocess is a 1-at-a-time worker.          │
  │                                                           │
  │  blocking the event loop for ~5ms per query is fine:       │
  │  there's nothing else for the loop to do.                  │
  └───────────────────────────────────────────────────────────┘
```

What breaks if you swap in an async driver (`sqlite3` package, or `better-sqlite3` doesn't fit and you reach for `pg`):

- **more async overhead per call** — every prepare + each row materialization becomes a promise; for a tool that returns 10k rows, that's noise
- **no win from non-blocking I/O** — there's no other work for the event loop to multiplex with
- **larger surface for `.catch()` handling** — sync errors throw at the call site; async errors require explicit `.catch` chains

In a stdio MCP subprocess specifically, sync IS the right choice. The standard "don't block the event loop" advice assumes a server multiplexing N connections; this process multiplexes 1.

**Move 2b — `readonly: true` on open, the safety rail.**

```
  src/db.ts L32-43 (paraphrased)

  new Database(path, {
    readonly: true,           ← attempt to write throws "attempt to write a
                                  readonly database"
    fileMustExist: true,      ← no auto-create; if the seed hasn't run, the
                                  open fails loudly
  });
```

What breaks if you drop `readonly`:

- a future tool implementation could accidentally include an `UPDATE` and silently mutate the committed fixture across test runs
- evals lose determinism — the second run sees a different DB than the first
- the committed binary in git would diff after every run (catastrophic for the eval result paper trail)

The pragmatic value: readonly is a CONTRACT that the seed script is the only writer. Any future maintainer reading `db.ts` sees the flag and knows the DB is a fixture, not a state store.

**Move 2c — seeded determinism (mulberry32 + seed=42).**

```
  scripts/seed-olist.ts L34-47

  function mulberry32(seed: number): () => number {
    return function () {
      seed = seed + 0x6D2B79F5 | 0;
      let t = seed;
      t = Math.imul(t ^ t >>> 15, t | 1);
      t ^= t + Math.imul(t ^ t >>> 7, t | 61);
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  const OLIST_SEED = 42;
  const rng = mulberry32(OLIST_SEED);
       │
       └─ pure ALU, no allocations, no Math.random. every call to rng() is
          determined by the previous one and the initial seed. swap Math.random
          for this and the entire generated DB becomes a function of (seed,
          algorithm) — reproducible across machines, OS versions, Node versions.
```

What breaks if you use `Math.random` instead:

- every seed run produces a different DB
- the committed binary becomes a one-time artifact, not a regenerable fixture
- evals lose their ground truth — the three SEEDED_ANOMALIES (L143-179) wouldn't land at the same week boundaries across runs

The discipline: **never call `Math.random` in code paths that should be reproducible.** Always thread a seeded PRNG through.

**Move 2d — schema introspection vs hand-maintained translation.**

The DB has its real schema (in `seed-olist.ts` L184-244). The agents need to see a description of that schema (which "events" exist, which dimensions can be filtered). This translation lives in `lib/mcp/schema.ts` L232 — `olistWorkspaceSchema()`.

```
  the contract — db.ts (truth) ↔ olistWorkspaceSchema() (what the agent sees)

  truth (mcp-server-olist):
    tables: customers, products, orders, order_items, payments, reviews,
            seeded_anomalies
    dimensions exposable: state, category, payment_type

  agent-facing schema (lib/mcp/schema.ts L232-273):
    events: 'order', 'payment', 'review'
    customerProperties: ['state', 'city']
    dataHorizon: { from: '2025-12-01', to: '2026-06-01', durationDays: 182 }
```

The translation is **hand-maintained**, not auto-derived. The dataHorizon is hard-coded from `seed-olist.ts` L133 (END_TS = 2026-06-01 UTC). If the seed window changes, this function must be updated by hand.

What breaks if these drift:

- agents could ask for `time_range` outside the populated window and get empty results that look like "no anomaly" instead of "no data"
- new dimensions added to the seed wouldn't be available to the agent until `olistWorkspaceSchema()` is updated

This is finding #12 in the red-flags audit. The fix (derive from `PRAGMA table_info()` on the DB) is straightforward but unnecessary at one-fixture scale.

**Move 2e — the committed binary as the "backup."**

`data/olist.db` is in git. That's unusual — most projects gitignore binary artifacts. The trade-off:

```
  axis: "what does committing a 3.5 MB binary buy you, what does it cost?"

  buys:
    - `git clone` gives you a working repo with a working DB
    - eval runs are byte-reproducible across machines without rebuild
    - the seed script becomes documentation, not a required build step
    - "what state is the DB in?" is `git log -- data/olist.db`

  costs:
    - 3.5 MB per schema/seed change committed
    - git stores binary deltas poorly (compared to text); each edit ≈ full blob
    - repo size grows; clones get slightly slower over many revisions
    - encourages "edit and commit" instead of "fix the seed and regenerate"
```

The fix recipe when the cost flips: `.gitignore` the binary, require `npm run seed` on first clone and in CI. Or use git-lfs. At one fixture, committing it is the right call — see finding #10.

### Move 3 — the principle

**A test fixture is most useful when it removes ambient variability.** Every layer of this pattern — sync driver, readonly open, fixed PRNG seed, committed binary — exists to remove one source of "did the data change between runs?" The agent's behavior is the experiment; the data must be a constant. Once you understand that, the four layers stop looking like "engineering decisions" and start looking like four ways to spell the same word: *deterministic*.

The deeper lesson generalizes beyond AI eval: **wherever you want to test behavior, lock the data down first.** Property tests with seeded inputs, golden files, recorded HTTP responses, frozen container images — all of these are versions of this same move.

## Primary diagram

```
  embedded SQLite as test fixture — full recap

  ┌─ build-time ─────────────────────────────────────────────────────────┐
  │  scripts/seed-olist.ts                                                │
  │    mulberry32(seed=42) → 5k customers, 800 products, 10k orders     │
  │    + 3 SEEDED_ANOMALIES (ground truth, week-aligned)                  │
  │    one db.transaction() for all ~30k inserts                          │
  │    → data/olist.db (3.5 MB)                                           │
  └────────────────────────────────────┬──────────────────────────────────┘
                                       │  git commit
                                       ▼
  ┌─ source-control-time ────────────────────────────────────────────────┐
  │  data/olist.db in git tree                                            │
  │  byte-identical across every clone                                    │
  │  "backup" = git history; "PITR" = git checkout <sha>                  │
  └────────────────────────────────────┬──────────────────────────────────┘
                                       │  npm install + clone
                                       ▼
  ┌─ runtime ────────────────────────────────────────────────────────────┐
  │  src/db.ts                                                            │
  │    openDb() → new Database(path, { readonly, fileMustExist })         │
  │            → pragma WAL + foreign_keys ON                              │
  │                                                                       │
  │  src/tools/{get_metric_timeseries, get_segments, get_anomaly_context}│
  │    validate input → build SQL → db.prepare().all() → JSON envelope    │
  │                                                                       │
  │  every tool call: sub-millisecond synchronous read                     │
  │  no PRNG, no mutation, no network                                      │
  └────────────────────────────────────┬──────────────────────────────────┘
                                       │  stdio MCP transport
                                       ▼
  ┌─ eval-time ──────────────────────────────────────────────────────────┐
  │  eval/scripts/* run the agent against the same fixture every time     │
  │  → eval/results/<date>/ paper trail (JSON, not a DB)                  │
  │  the three seeded anomalies are the ground truth the agent must find  │
  └───────────────────────────────────────────────────────────────────────┘
```

## Implementation in codebase

### Use cases

- **The eval suite** (`eval/scripts/`) runs blooming insights's agents against the Olist MCP server as a hermetic data source. Same DB binary, same agent code, same answer expected. When the answer drifts, it's the agent that changed — the data didn't.
- **Local development** without Bloomreach credentials. Spawn `mcp-server-olist` as the MCP target and the agents run end-to-end against synthetic data.
- **Test fixture for `mcp-server-olist/test/*.test.ts`** — 43 tests that open the DB read-only, run a tool query, and assert on the output. Hermetic, deterministic, no network.
- **Anomaly detection ground truth.** The three injected anomalies (sp-revenue-drop-w4, electronics-spike-w2, voucher-dropoff-w10-on) are the answer key — evals score the agent by how many of the three it finds and how it characterizes them.

### Code side by side

```
  mcp-server-olist/src/db.ts  (lines 32–43)

  export function openDb(
    path: string = resolveDbPath(),
  ): Database.Database {
    if (!existsSync(path)) {
      throw new Error(
        `olist.db not found at ${path} —     ← loud failure if the seed
         run 'npm run seed' from               script never ran. better than
         mcp-server-olist/ first.`,             a confusing "no rows" later.
      );
    }
    const db = new Database(path, {
      readonly: true,                       ← the contract: this code never
                                               writes. attempts throw.
      fileMustExist: true,                  ← no auto-create; we don't want
                                               an empty DB silently created.
    });
    db.pragma('journal_mode = WAL');        ← future-proofs against multi-
                                               process attachments (eval
                                               worker pool, parallel runs).
    db.pragma('foreign_keys = ON');         ← FK violations throw at INSERT;
                                               the seed depends on this for
                                               consistency checks.
    return db;
  }
       │
       └─ this 12-line function carries four design decisions: existence check
          (loud failure path), readonly (contract), fileMustExist (no surprise
          creates), WAL + FK pragmas (one-time, applied on every open). Each
          flag earns its place; removing any one breaks a load-bearing
          property of the fixture.
```

```
  mcp-server-olist/scripts/seed-olist.ts  (lines 34–47)

  function mulberry32(seed: number): () => number {  ← pure-ALU PRNG.
    return function () {                                deterministic from
      seed = seed + 0x6D2B79F5 | 0;                   the initial seed; no
      let t = seed;                                    Math.random, no Date.
      t = Math.imul(t ^ t >>> 15, t | 1);              now(), no OS entropy.
      t ^= t + Math.imul(t ^ t >>> 7, t | 61);
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  const OLIST_SEED = 42;                              ← single source of
  const rng = mulberry32(OLIST_SEED);                   "what makes this DB
                                                         specifically this DB."
       │
       └─ every random choice during seed generation goes through rng(),
          not Math.random. names, prices, dates, anomaly noise — all derived
          deterministically from OLIST_SEED. change the constant, get a
          different (but still reproducible) DB.
```

```
  lib/mcp/schema.ts  (lines 232–273)

  export function olistWorkspaceSchema(): WorkspaceSchema {
    return {
      projectId: 'olist',
      projectName: 'Olist · Brazilian e-commerce (local MCP)',
      events: [
        { name: 'order',   properties: [...], eventCount: 0 },
        { name: 'payment', properties: [...], eventCount: 0 },
        { name: 'review',  properties: [...], eventCount: 0 },
      ],
      customerProperties: ['state', 'city'],
      catalogs: [],
      totalCustomers: 0,
      totalEvents: 0,
      oldestTimestamp: null,
      dataHorizon: {                          ← hard-coded from seed-olist.ts
        from: '2025-12-01',                      L133 (END_TS = 2026-06-01).
        to: '2026-06-01',                        if the seed window changes,
        durationDays: 182,                       this must update by hand.
      },
    };
  }
       │
       └─ the hand-maintained translation from "what's in the DB" to "what the
          agent thinks is available." Bypasses the main app's `cached` slot
          (which is for Bloomreach schemas) — comment at L228-230 names why
          mixing the two would corrupt across mode toggles.
```

## Elaborate

The "data as fixture" pattern has a long history. SQLite itself is built around the assumption that the DB is a file (one byte sequence, easy to ship, easy to version). The DuckDB community uses parquet files the same way for analytical workloads. Recorded HTTP fixtures (`vcr` in Ruby, `pytest-recording` in Python) are the same idea at the network layer.

The specific innovation here is **using SQLite + a synthetic seed as a hermetic data source for an LLM agent eval**. The agent's tools (`get_metric_timeseries` etc.) look like real domain tools, but every query is against the committed binary. There's no flakiness from network calls, no rate limits, no per-run data drift. The three seeded anomalies are the answer key — the agent should find them, characterize them, and propose actions.

The trade-off the team accepted: synthetic data doesn't capture the long tail of real-world weirdness. A real Olist dataset would have edge cases (negative prices from refunds, NULL category, malformed addresses) that this seed doesn't. The fix when it matters: layer real-data fixtures on top, OR replay a captured production trace. For now, controlled-synthetic is the right shape because it makes the agent's reasoning the variable under test.

Cross-link: `study-testing` owns the eval suite design; this file owns the data-layer half of it.

## Interview defense

**Q: "Walk me through your data layer in Phase 2."**
We authored an MCP server with its own SQLite database — `mcp-server-olist/`. It uses `better-sqlite3` (synchronous, embedded), opens the DB readonly with WAL mode and foreign keys enforced. The data file is committed to git (3.5 MB) so every clone has the same fixture. The seed script uses a mulberry32 PRNG with seed=42, so the DB is byte-reproducible. Three anomalies are injected at known windows as ground truth for the eval suite. The main Next.js app doesn't have a DB driver — `mcp-server-olist` is a sibling package, and the main app reaches it through MCP stdio. The pattern is "data layer one process away, with hermeticity guarantees."

Diagram: the four-layer stack from the structure pass (seed → committed binary → readonly open → tool queries).

Anchor: `mcp-server-olist/src/db.ts` L32-43 (open); `mcp-server-olist/scripts/seed-olist.ts` L34-47 (PRNG) + L143-179 (seeded anomalies).

**Q: "Why better-sqlite3 instead of the async sqlite3 package?"**
Because the MCP subprocess only handles one tool call at a time. There's no concurrent request multiplexing to benefit from non-blocking I/O. Sync gives me direct return values, sync error semantics, no promise overhead per row, and prepared-statement caching for free. The standard "don't block the event loop" advice assumes a server with N concurrent requests; this process has one. Sync is correct here.

Diagram: the subprocess box with "1 stdin → 1 tool call → 1 response" labelled, showing why event-loop multiplexing has no work to do.

Anchor: `mcp-server-olist/src/db.ts` L9 (import) + `mcp-server-olist/src/tools/get_metric_timeseries.ts` L153 (synchronous `db.prepare(sql).all(...)`).

**Q: "Why commit a 3.5 MB binary instead of seeding on first run?"**
Reproducibility-by-clone. Anyone who clones the repo gets a working DB without running anything. Eval result diffs are byte-comparable across machines. The trade is repo size: 3.5 MB per schema change. At one fixture this is fine. The day there's a second one — adversarial seed, larger dataset — the calculus flips and I'd move to git-lfs or gitignore + CI seed step. Named explicitly in the red-flags audit (#10).

Diagram: the trade-off table from Move 2e.

Anchor: `mcp-server-olist/data/olist.db` (3.5 MB, in git); regenerable via `npm run seed`.

**Q: "How does the agent know the schema of this DB?"**
Through `olistWorkspaceSchema()` in `lib/mcp/schema.ts` L232 — a hand-maintained function that describes the dataset (events: order/payment/review, customerProperties: state/city, dataHorizon: 2025-12-01..2026-06-01). It is NOT auto-derived from the DB; if the seed changes, this function must be updated by hand. That's the trade-off — one place to maintain, but a drift risk. Finding #12 in the audit.

Diagram: the seam-3 picture (db.ts truth on the left, hand-coded schema on the right, arrow labelled HAND).

Anchor: `lib/mcp/schema.ts` L232-273; `mcp-server-olist/scripts/seed-olist.ts` L184-244 (the actual schema).

## Validate

**Level 1 — reconstruct.** Name the four layers of the fixture pattern (seed script + PRNG, committed binary, readonly open, tool queries) and one property each enforces.

**Level 2 — explain.** Why is `Math.random` banned inside the seed script? What specifically would break if it were used? (Answer: every seed run would produce a different DB; the committed binary would diverge from regenerated ones; the three SEEDED_ANOMALIES would land at slightly different anomaly characteristics; eval baselines calibrated against one run would no-op against another. The mulberry32 + fixed-seed combo removes all of this.)

**Level 3 — apply.** Suppose we add a fourth domain tool, `get_top_customers`. Walk the seed→binary→runtime→agent chain — what must change, what stays the same. (Answer: db.ts is unchanged. seed-olist.ts unchanged unless we need a new index. New file `src/tools/get_top_customers.ts` with input schema, SQL builder, prepared-statement call. `lib/mcp/schema.ts` `olistWorkspaceSchema()` may or may not need to expose new dimensions; check if the agent needs to know. New tests in `test/tools/`.)

**Level 4 — defend.** Argue against switching the seed PRNG from mulberry32 to `Math.random` "for simplicity." (Answer: the committed DB stops being reproducible. Future maintainers cloning the repo and running `npm run seed` would get a DIFFERENT DB than the committed one, so they'd either re-commit it (churn) or accept the divergence (drift). The eval result paper trail at `eval/results/<date>/` would no longer be reproducible. The mulberry32 line cost is 6 lines of code; the determinism it buys is foundational to the whole eval story.)

## See also

- `01-database-systems-map` — where this fits in the overall storage picture
- `02-records-pages-and-storage-layout` — the SQLite pages this fixture lives in
- `03-btree-hash-and-secondary-indexes` — the 9 indexes that make the queries fast
- `04-query-planning-and-execution` — what SQLite's planner does with these tables
- `05-transactions-isolation-and-anomalies` — the seed transaction wraps the whole insert
- `07-wal-durability-and-recovery` — WAL mode here is dormant (readonly) but enabled
- `09-database-systems-red-flags-audit` — findings #10, #11, #12 cover this file's risks
- `study-testing` — the eval suite that uses this fixture
- `study-system-design` — when this pattern stops being the right shape

---
Updated: 2026-06-16 — created. Phase 2 introduced the SQLite-backed mcp-server-olist; this file teaches the "data as fixture" pattern across all four layers (seed determinism, committed binary, readonly open, prepared-statement tool queries).
