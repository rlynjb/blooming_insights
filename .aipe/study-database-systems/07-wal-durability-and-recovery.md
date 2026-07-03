# 07 · WAL, durability, and recovery

*Write-ahead logs, durability boundaries, backup, restore · Case B (git is the WAL)*

## Zoom out — where this concept lives

Durability is the promise that a committed write survives a crash. In
a real DB, that promise is kept by the WAL — a write-ahead log
flushed to disk before the actual data pages, so recovery can replay
the log after a crash and reconstruct the state. This repo has no
disk-based WAL, but it has three artifacts playing the same three
roles: `eval/receipts/*.json` as the append-only log, `eval/baseline.json`
as the committed reference, and `git tag` as the point-in-time
snapshot.

```
Zoom out — where durability would sit

┌─ commit event ────────────────────────────────────────┐
│  "record this eval run's judgment"                    │
└──────────────────────────┬────────────────────────────┘
                           │
┌─ ★ THIS CONCEPT ★ ──────▼────────────────────────────┐
│  the durability boundary                              │
│    · WAL: write log before data                       │
│    · checkpoint: promote log to durable data pages    │
│    · backup: point-in-time copy                       │
│    · restore: replay from log OR reload from backup   │
│                                                        │
│  this repo's analogs:                                  │
│    · eval/receipts/*.json  — the append-only log      │
│    · eval/baseline.json    — the "checkpoint" row     │
│    · git tag               — the point-in-time backup │
│    · git revert            — the restore              │
└──────────────────────────┬────────────────────────────┘
                           │
┌─ storage ────────────────▼────────────────────────────┐
│  file system + git                                    │
└───────────────────────────────────────────────────────┘
```

## Zoom in — the pattern

**The pattern:** *append-only log + committed reference row + git
backup.* Every eval run writes one file per case to `eval/receipts/`
(the WAL). The `computeBaseline` function reads those files and
produces a wide-row summary in `eval/baseline.json` (the checkpoint).
`git commit` publishes both; `git tag` is the point-in-time snapshot;
`git revert` is the restore.

## Structure pass — one axis across the durability tiers

**Axis: "what happens after a process death?"** (durability boundary)

```
Trace durability across the tiers, worst-case

  Tier                            Survives...           Recovery path
  ────                            ────────────          ─────────────
  in-memory Map                   nothing               empty on restart
  ────                            ────────────          ─────────────
  bi_auth cookie                  process death         browser re-sends
                                  redeploy               on next request
                                  10 days                (crypto-tag verified)
  ────                            ────────────          ─────────────
  .auth-cache.json (dev)          process death         fs.readFileSync
                                  NOT rm                on start
  ────                            ────────────          ─────────────
  eval/receipts/*.json            everything up to      readdirSync
                                  git commit             (permanent once
                                                          committed)
  ────                            ────────────          ─────────────
  eval/baseline.json              everything up to      readFileSync
                                  git commit             on every CI gate
  ────                            ────────────          ─────────────
  demo-insights.json              everything up to      readFileSync
                                  git commit             on every demo mode
  ────                            ────────────          ─────────────
  git tag                         permanent             git checkout
                                                          git reset --hard <tag>
```

The seams that matter:

  → **In-memory → cookie seam** — this is the ONLY durability tier
    that carries per-user state across a redeploy. Everything
    below dies with the process.

  → **Working tree → git seam** — this is the boundary between
    "in-progress changes" and "committed history." `eval/receipts/`
    accumulates in the working tree during a run and gets committed
    per PR; that's exactly the WAL-to-checkpoint pattern.

  → **git HEAD → git tag seam** — HEAD moves; tags don't. The tag
    `study-pre-regen-2026-07-03-p2` names today's pre-regen state
    so a bad regeneration can `git reset --hard <tag>` back.

The **most load-bearing move** is the git-commit boundary. Below it,
you have working-tree files that could be lost on any error. Above
it, you have permanent history the CI gate can rely on.

## How it works

### Move 1 — the pattern

You know a Redux time-travel debugger — every action produces a new
state, the history is a list of states, "undo" means jumping back.
The WAL pattern is that, plus a rule: **the log is written to disk
BEFORE the state is updated.** That way, if the process dies mid-
update, the log tells recovery exactly what to redo.

```
WAL pattern — the kernel

  1. INTENT     application wants to commit a write
  2. LOG        WAL entry appended to log file  ── fsync
  3. APPLY      in-memory state updated
  4. CHECKPOINT periodically flush apply-side to disk
                → forget log entries older than checkpoint

  what breaks if you skip step 2:
    process death after apply, no log → recovery can't redo
  what breaks if you never checkpoint:
    log grows forever, recovery replays everything on start
```

Kernel of durable storage — three parts:

  1. **The append-only log.** Every write appends. Never mutate.
     Missing → no way to recover from a crash mid-checkpoint.
  2. **The checkpoint / materialized view.** Aggregates the log into
     a compact readable shape. Missing → every reader has to replay
     the entire log.
  3. **The backup boundary.** A named snapshot you can roll back to.
     Missing → you can only recover forward, never undo a bad state.

### Move 2 — walk the three artifacts

Three artifacts, three roles.

#### Artifact 1 — `eval/receipts/*.json` as the WAL

Every eval run writes one file per case (per test signal) into
`eval/receipts/`. The filename is the durability-carrying part:

```
Actual receipt filenames from the repo

  01-conversion-drop-mobile-checkout-2026-07-03T02-12-17-099Z.json
  01-conversion-drop-mobile-checkout-2026-07-03T02-47-24-392Z.json
  01-conversion-drop-mobile-checkout-2026-07-03T04-08-28-644Z.json
  02-fraud-payment-failure-credit-card-2026-07-03T02-47-24-392Z.json
  ...

  format: <caseId>-<runId>.json
    caseId: 01..10 with a short slug
    runId: ISO timestamp, ms precision, - as separator

  properties:
    - append-only (each run writes new files, never mutates old)
    - unique-by-(caseId, runId) (physical isolation, no collisions)
    - fully ordered by runId (sort by suffix = chronological)
    - trivially replayable (readdir + parse + aggregate)
```

The `pickRunId` helper reads exactly this shape:

```typescript
// eval/baseline.eval.ts:120-130
function pickRunId(fromEnv: string | undefined): string {
  if (fromEnv) return fromEnv;
  const files = readdirSync(RECEIPTS_DIR).filter((f) => f.endsWith('.json'));
  const runIds = new Set<string>();
  for (const f of files) {
    const m = f.match(/-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d+Z)\.json$/);
    if (m) runIds.add(m[1]);
  }
  if (runIds.size === 0) throw new Error('No receipts found');
  return [...runIds].sort().pop() as string;  // ← "latest LSN"
}
```

**Read this like a WAL:**

  → filename = `<segment>-<lsn>.json`, where `lsn` is the runId
    timestamp
  → `readdirSync` = "scan the log directory"
  → `.sort().pop()` = "get the latest checkpoint / LSN"
  → per-file `JSON.parse` = "decode log records"

**In DB terms:** this is a **segmented WAL**. Each segment (case) has
its own file. Segments are named by case + LSN. The latest LSN is
the highest-sorted timestamp. Recovery is trivial: readdir + parse.

**Boundary condition — no fsync guarantee.** `writeFileSync` in
Node is buffered by the OS; a hard power loss between the syscall
and the disk flush can lose the file. In practice CI is running in
cloud instances with reliable storage, and the receipts get committed
to git shortly after being written. If you cared, `fs.fsyncSync` on
the fd would be the missing step.

#### Artifact 2 — `eval/baseline.json` as the checkpoint / materialized view

The baseline is what `computeBaseline` produces from the receipts:

```typescript
// eval/baseline.eval.ts:87-95
export function computeBaseline(runId: string, receipts: Receipt[]): Baseline {
  return {
    runId,
    builtAt: new Date().toISOString(),
    caseCount: receipts.length,
    diagnosis: aggregate(receipts.map((r) => [r.diagnosisJudgment])),
    recommendation: aggregate(receipts.map((r) => r.recommendationJudgments.map((rj) => rj.judgment))),
  };
}
```

This function reads N log records and produces one summary row.
That's a **checkpoint operation** in the classical sense — it takes
the accumulated log and boils it down to a compact representation
that captures the state "as of the current runId."

```
Sequence — checkpoint (baseline build) and gate (baseline compare)

  eval runner                receipts/          baseline.json          CI gate
  ───────────                ──────────         ──────────────         ───────
  write receipt(case1)  ──► case1-run.json
  write receipt(case2)  ──► case2-run.json                             
  ...                       ...
                            (10 files)

  npm run eval:baseline
     │
     └─► readdir + parse + computeBaseline
                        │
                        └──────────────────►   { runId, builtAt,
                                                 caseCount:10,
                                                 diagnosis: {…},
                                                 recommendation: {…} }

  (committed to git)

                                                                         npm run eval
                                                                         (writes new
                                                                          receipts)
                                                                         │
                                                                         │
                                                                         npm run eval:gate
                                                                         │
                                                                         ┌──▼──┐
                                                                         │ read│
                                                                         │ base│
                                                                         │line │
                                                                         └──┬──┘
                                                                            │ read new
                                                                            │ receipts
                                                                            │ computeBaseline
                                                                            │ (candidate)
                                                                            │
                                                                            ▼
                                                                         compare
                                                                         → pass or block
```

**Read this like a DB:** `computeBaseline` is a materialization
function. `baseline.json` is a materialized view. The CI gate is a
`SELECT` that compares two views. The materialization is manual
(explicit `npm run eval:baseline`), not automatic — that's a
deliberate choice, so you can refresh the reference row on your
schedule rather than every run.

**Boundary condition — the stale baseline.** If you regenerate
`baseline.json` from a candidate that itself has regressed, you
lock in the regression. The comment inside `baseline.eval.ts`
doesn't call this out explicitly, but the naming (`BASELINE_LABEL=v2`
support for multi-baseline workflow) hints at it. In DB terms this
is "the checkpoint contains a wrong page; recovery replays into a
wrong state." Rollback is `git revert` of the baseline.json commit.

#### Artifact 3 — `git tag` as the point-in-time backup

The context reminded us that today's git tag is
`study-pre-regen-2026-07-03-p2`. That's the durability boundary for
this study itself: a snapshot of the working tree BEFORE the study-
family regeneration.

```
Layers-and-hops — the backup / restore flow

┌─ working tree ──────────────────────────┐
│  .aipe/study-database-systems/*.md      │
│  (about to be regenerated)              │
└───────────────┬─────────────────────────┘
                │ hop 1: git tag study-pre-regen-<date>
                ▼
┌─ git object store ──────────────────────┐
│  refs/tags/study-pre-regen-2026-07-03-p2│
│  → immutable pointer to commit SHA      │
└───────────────┬─────────────────────────┘
                │ hop 2: [regeneration runs]
                │        [outputs bad? → rollback]
                ▼
┌─ working tree (bad state) ──────────────┐
│  regenerated files, some off-spec        │
└───────────────┬─────────────────────────┘
                │ hop 3: git reset --hard study-pre-regen-2026-07-03-p2
                ▼
┌─ working tree (restored) ───────────────┐
│  identical to the tag                    │
└─────────────────────────────────────────┘
```

Every one of the four hops is a durability primitive in a real DB:

  → hop 1: `pg_basebackup` / `mysqldump` — create a point-in-time
    backup
  → hop 2: production runs — the "workload" that might corrupt the
    checkpoint
  → hop 3: `pg_restore` / `mysql < dump.sql` — restore from backup

**The load-bearing property:** git tags are immutable once created.
Nobody can move `study-pre-regen-2026-07-03-p2` to a different SHA
without a force-push AND a notification (git blocks tag moves by
default). That's stronger than a filesystem backup — a filesystem
backup can be silently overwritten; a git tag can't.

**In DB terms:** a git tag is a **read-only backup with content-
addressable integrity checking**. The SHA IS the checksum; if any
byte of any committed file changed, the SHA would be different.
It's what a DB engineer would call a "cryptographically-verified
snapshot."

### Move 2.5 — the WAL that isn't (the auth cookie)

Here's a subtle one. The `bi_auth` cookie has some WAL-like
properties but is missing the log part:

```
Comparison — cookie durability vs classical WAL

  bi_auth cookie                        classical WAL
  ─────────────                          ─────────────
  one blob, latest state                 log of all writes
  encrypted, self-tagged                 append-only
  survives redeploy                      survives crash + recover
  recovery: browser re-sends             recovery: replay log
  backup: none                           backup: base + logs
  rollback: none                         PITR: replay to a point
```

The cookie is a **state snapshot without a log**. That's why:

  → You can't "recover to a state 5 minutes ago" — the old cookie is
    gone, replaced by the current one.
  → You can't audit the history of OAuth state changes — there is
    no history, only the current.
  → You can rotate `AUTH_SECRET` for security, but you can't roll
    back a bad token save.

This is a classic **CRDT-style latest-wins state** rather than a
log-based state. It's fine because OAuth is inherently latest-wins
(the newest token is the right one; the old ones are worthless), but
it's important to name what's missing.

### Move 3 — the principle

**Durability is a property of a specific tier, not of the system.**
Every artifact in this repo has a durability answer, and the answer
is different for each. The in-memory Map is durable for zero
seconds. The cookie is durable for ten days OR one AUTH_SECRET
rotation, whichever is first. The receipts are durable until you
`git push --force`.

The reason engineers reach for a database for durability is that a
DB gives you one integrated story: WAL for the log, checkpoints for
the materialized state, backups for point-in-time recovery, all
coordinated. Here you're building that same story out of files and
git. It works — it's how a lot of small systems ship — but every
piece is your responsibility, and losing any one piece breaks
recovery.

## Primary diagram — the durability stack

```
Durability in blooming_insights — from ephemeral to permanent

  ┌── EPHEMERAL (dies with process) ─────────────────────────────┐
  │  Map<sessionId, SessionFeed>                                  │
  │    lifespan: warm instance                                    │
  │    recovery: none, empty on restart                           │
  └───────────────────────────────────────────────────────────────┘

  ┌── PER-USER PORTABLE (10 days) ───────────────────────────────┐
  │  bi_auth cookie                                                │
  │    lifespan: 10d or AUTH_SECRET rotation                      │
  │    tier:     browser cookie                                    │
  │    tag:      AES-256-GCM auth tag verifies integrity           │
  │    recovery: browser re-sends → decryptStore(raw)              │
  └───────────────────────────────────────────────────────────────┘

  ┌── DEV FILE (until rm) ───────────────────────────────────────┐
  │  .auth-cache.json                                              │
  │    lifespan: filesystem                                        │
  │    tier:     gitignored file                                   │
  │    recovery: readFileSync on start                             │
  └───────────────────────────────────────────────────────────────┘

  ┌── WAL (append-only, per-run) ────────────────────────────────┐
  │  eval/receipts/<caseId>-<runId>.json                          │
  │    lifespan: git working tree, then committed                 │
  │    tier:     file system → git                                │
  │    ordering: runId ISO timestamp = natural LSN                │
  │    recovery: readdir + parse + aggregate                      │
  └───────────────────────────────────────────────────────────────┘

  ┌── CHECKPOINT (materialized view) ────────────────────────────┐
  │  eval/baseline.json                                            │
  │    lifespan: committed                                         │
  │    tier:     git                                               │
  │    role:     regression-gate reference row                     │
  │    recovery: readFileSync on gate run                          │
  └───────────────────────────────────────────────────────────────┘

  ┌── FROZEN REPLICA (materialized view) ────────────────────────┐
  │  lib/state/demo-insights.json                                  │
  │  lib/state/demo-investigations.json                            │
  │    lifespan: committed                                         │
  │    tier:     git                                               │
  │    role:     demo-mode read replay                             │
  │    refresh:  /api/mcp/capture-demo (dev-only route)            │
  └───────────────────────────────────────────────────────────────┘

  ┌── POINT-IN-TIME BACKUP ──────────────────────────────────────┐
  │  git tag study-pre-regen-2026-07-03-p2                        │
  │    lifespan: permanent (until force-push)                     │
  │    tier:     git object store                                 │
  │    tag:      SHA is the checksum                              │
  │    restore:  git reset --hard <tag>                           │
  └───────────────────────────────────────────────────────────────┘
```

## Elaborate

**Where does the "WAL as segmented files" pattern come from?**
Postgres's WAL uses segmented files (16 MB each by default, named
`000000010000000000000001` and up). LevelDB / RocksDB use "SST
files" that follow the same pattern. Kafka is entirely a segmented
log per partition. The instinct is universal: append is cheap,
mutation is expensive, and segments make retention / archival
trivial.

**The `receipts/*` folder is one of the cleanest analogs of this
pattern in a small codebase.** No mutation, no cleanup, no schema
migrations. Each file is complete on its own; you can `rm` an old
run's files without breaking anything (though the gate wouldn't
have historical baselines).

**When would you replace this with SQLite?** When the append-only
log grows past a few thousand files AND you start wanting queries
like "what's the pass rate for case 3 over the last 20 runs." Right
now the gate does one comparison (baseline vs candidate); a query
across N runs would require N reads. SQLite would make it one
`SELECT`. Nothing else changes about the pattern — the record shape
and the LSN concept both survive the migration.

**The `capture-demo` route is a manual checkpoint operation.** It
takes the current session's in-memory feed and writes it to
`lib/state/demo-insights.json` (plus investigations). That IS a
checkpoint — freezing the in-memory state to durable storage. But
it's manual (you click a button in dev) and never automatic. In DB
terms: no background checkpoint thread. That's fine for a "frozen
demo replica" pattern; it would be broken for a production DB.

## Interview defense

**"How does this system handle a crash mid-write?"**

Answer: *"It depends on the tier. The in-memory Map loses everything
on process death — the redeploy IS the crash, and the next request
starts fresh. The `bi_auth` cookie survives because it's on the
browser side, so the client re-sends it on the next request and
`decryptStore` verifies the AES-GCM tag before trusting it. The
`eval/receipts/` folder is append-only per run, so a crash mid-run
leaves a partial run in the working tree — the gate would either
skip it or fail cleanly on a missing case. The git-committed
artifacts are the only permanent tier."*

**"Where's the write-ahead log?"**

Answer: *"`eval/receipts/` is the closest analog. Each run writes
one JSON file per case; the runId in the filename is the LSN. The
`computeBaseline` function is the checkpoint operation — it reads
all receipts for a runId and produces the materialized view in
`eval/baseline.json`. The CI gate compares two materialized views.
Recovery in this world is `readdirSync + parse`, which is trivial
because the files are self-describing."*

**"How would you roll back a bad regeneration?"**

Answer: *"`git reset --hard study-pre-regen-2026-07-03-p2`. The tag
was created before the regeneration ran, so it points at the
known-good tree. Git tags are immutable and content-addressable —
the SHA is effectively the checksum — so this is stronger than a
filesystem backup. There's no undo for a filesystem overwrite; there
IS an undo for a git commit."*

The load-bearing skeleton part interviewers routinely forget:
**the runId timestamp precision.** With millisecond precision plus
the `-<random>` suffix pattern, two concurrent eval runs cannot
collide on filenames. That's the "no two writers write the same
segment" property that makes the WAL work without locking. Naming
this signals you thought about the concurrency of the log itself.

## See also

  → `01-database-systems-map.md` — the six tiers each recovery
    story sits in
  → `05-transactions-isolation-and-anomalies.md` — atomicity as
    the durability sibling
  → `08-replication-and-read-consistency.md` — the demo snapshot
    as a frozen replica
  → `study-testing/` — how the eval gate consumes this durability
    story
