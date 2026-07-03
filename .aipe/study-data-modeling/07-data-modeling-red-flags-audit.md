# 07 — Data-modeling red flags · audit

**Consolidated checklist · this codebase · verdict + severity + fix**

## Zoom out — where this file sits

The other six files walked concepts. This one is the *audit*: the standard data-modeling red-flag checklist marked against this specific repo. Every row is a claim about *this* codebase, ranked worst-first, with a fix path.

```
  Zoom out — the audit's shape

  ┌─ Findings ranked worst-first ───────────────────────────┐
  │                                                          │
  │  ┌── HIGH severity ──┐                                   │
  │  │  latent bugs;      │  → shape drift, missing invariant │
  │  │  fix soon          │    enforcers, silent corruption   │
  │  └────────────────────┘                                   │
  │                                                          │
  │  ┌── MEDIUM severity ┐                                   │
  │  │  works today,      │  → policy gaps, unscripted       │
  │  │  breaks on         │    regenerations, growth cliffs  │
  │  │  destructive       │                                   │
  │  │  change or scale   │                                   │
  │  └────────────────────┘                                   │
  │                                                          │
  │  ┌── LOW severity ────┐                                   │
  │  │  worth naming, not │  → conventions, opportunities to │
  │  │  worth fixing yet  │    tighten later                  │
  │  └────────────────────┘                                   │
  └──────────────────────────────────────────────────────────┘
```

## The checklist

Each red flag is stated as it would appear in a generic data-modeling audit, then marked against this repo.

### 1. **Same fact stored in two places, editable independently**  — HIGH · fixable

**Generic form:** the same fact is declared/edited in more than one place, with no mechanism keeping the copies in sync. The DB analog: two columns holding the same value, updatable independently.

**In this repo:** yes — `Diagnosis` and `Investigation.diagnosis`.

```
  lib/mcp/types.ts:94-104          lib/mcp/types.ts:132-141
  ────────────────                  ────────────────
  interface Diagnosis {              interface Investigation {
    conclusion: string;                insightId: string;
    evidence: string[];                reasoning: ReasoningStep[];
    hypothesesConsidered:              diagnosis: {
      { hypothesis, supported,           conclusion: string;
        reasoning }[];                   evidence: string[];
    ...                                  hypothesesConsidered: string[];
  }                                                    ↑ DIFFERENT SHAPE
                                       };
                                       recommendations: Recommendation[];
                                     }
```

Same conceptual entity, same file, two shapes. `hypothesesConsidered` is `{hypothesis, supported, reasoning}[]` in one and `string[]` in the other. Nothing enforces they stay in sync.

**Fix:** replace `Investigation.diagnosis: {...inline...}` with `Investigation.diagnosis: Diagnosis`. One-line change, single source of truth thereafter. TypeScript will complain at any call site that assumed the old shape — you fix those in the same PR.

**Cost:** ~30 minutes; 1 line changed + ~5 call sites updated.

---

### 2. **Multi-write operation with no transaction wrapping it** — CONDITIONAL · currently safe

**Generic form:** an operation writes multiple pieces of state that must land together or not at all, without an atomicity mechanism. The DB analog: two `INSERT`s outside a `BEGIN`/`COMMIT`.

**In this repo:** currently safe by accident of runtime. `putInsights` writes to `insights` and `anomalies` maps in one synchronous function. Because the runtime is single-threaded, no reader can observe the intermediate state.

**When it becomes a real red flag:** the moment an `await` is introduced anywhere between `s.insights.clear()` and the final `.set()` (file 04 walks this). Also, if the maps ever move to a shared-memory worker or a persistence layer, the atomicity guarantee vaporizes.

**Fix path (preventive):** wrap `putInsights` with a comment naming the "no `await` allowed here" invariant, and consider extracting a `synchronousSectionOnly` marker/type if the codebase grows more of these. Not urgent.

**Cost:** ~5 minutes for the comment; nothing else needed today.

---

### 3. **A migration policy that only handles additive changes** — MEDIUM · known, bounded

**Generic form:** the schema evolves, but the migration strategy handles only "add optional field." Renames, retypes, deletions have no defined path. The DB analog: no `ALTER TABLE` scripts, only `ADD COLUMN`.

**In this repo:** yes. Every field added to `Insight`, `Anomaly`, `Recommendation`, `Diagnosis` since day one has been optional (`?`), which handles the additive case for all committed JSONs (demo seeds, receipts, baseline). There's no `schemaVersion` field anywhere, no `migrate()` at the read boundary, no script that regenerates the demo seeds when a shape changes.

**Concrete failure case:** rename `Insight.headline` → `Insight.title`. Every hand-committed `demo-insights.json` entry now silently reads as "no title." Nothing catches this at build time.

**Fix:** file 05's Phase B — read-side migration with `schemaVersion` + `migrate()` per persisted shape. See that file for the full walkthrough.

**Cost:** ~2-3 hours for the first pass (add `schemaVersion: '1'` to every persisted shape + build the `migrate()` scaffolding); every future destructive change adds one case (~15 minutes).

---

### 4. **No stable identifier for an entity that will eventually need to survive a session** — MEDIUM · latent

**Generic form:** an entity's primary key is a per-session UUID or a random ID that means nothing outside the session. The DB analog: using auto-increment IDs as user-facing references, then later needing to reassign them across environments.

**In this repo:** yes. `Insight.id = crypto.randomUUID()` (`lib/state/insights.ts:26`). Meaningful only within one session's `Map<sessionId, SessionFeed>`. The moment you want:
  → to share an investigation link across sessions,
  → to favorite an insight and see it re-favor'd on Tuesday,
  → to keep a history of past briefings,
  → to deep-link into an investigation from an email,

...the session-UUID doesn't survive.

**Fix:** add a `stableInsightKey: string` derived from `hash(metric + scope + baseline)` alongside the existing `id`. Old code paths keep using `id`; new persistence uses `stableInsightKey`. Non-invasive.

**Cost:** ~1 hour; the derivation is deterministic, no migration needed for existing sessions (they die with the instance anyway).

---

### 5. **A frequent query with no supporting "index"** — LOW · latent scan cost

**Generic form:** a hot-path read walks a linear collection. The DB analog: `SELECT ... WHERE unindexed_column = ?`.

**In this repo:** two O(F) scans, both cold-path:

```
  file                                     scan                                cost today
  ────                                     ────                                ────────────

  lib/state/investigations.ts:15-20        readJson() re-parses whole file     O(dev cache
   (getCachedInvestigation fallback)        every call                          size)
                                                                                dev-only

  eval/baseline.eval.ts:44-46              readdirSync + filter(endsWith)      O(28 files)
   (baseline receipt collection)            for a runId                         negligible
```

Both are cold-path. Neither is a bug today. Both would be real costs at 10× scale.

**Fix:**
  → dev cache: memoize the parsed JSON keyed on file mtime (see file 03).
  → receipt collection: partition receipts into `eval/receipts/{runId}/` subdirs, or move to SQLite (`eval/receipts.sqlite`).

**Cost:** the dev cache fix is ~15 minutes; the receipts partition is ~1 hour but not needed until `eval/receipts/` has 500+ files.

---

### 6. **N+1 query pattern in app code** — NOT PRESENT

**Generic form:** app code issues one query per row in a loop instead of one query returning all rows.

**In this repo:** no. The MCP data layer batches naturally (one tool call returns whole datasets), agents iterate over in-memory arrays without re-fetching, and the feed render pulls the whole feed in one go. This isn't an accident — the design decision to make the whole SessionFeed one document (file 06) forecloses this class of bug.

**Verdict:** clean.

---

### 7. **A destructive migration with no rollback plan** — NOT APPLICABLE YET

**Generic form:** a schema change removes a column or drops data with no way to reverse it.

**In this repo:** no committed schema has ever been dropped. The whole migration story is additive (see red flag 3). When destructive changes come, they'll need rollback plans — file 05's Phase B `migrate()` design implicitly supports rollback (versions can be walked backward if the migration functions are invertible).

**Verdict:** not exercised yet; the framework to support it is a next-step.

---

### 8. **An invariant enforced only in app code that the "DB" doesn't guard** — MIXED

**Generic form:** an invariant lives in app code with no enforcement close to the storage. The DB analog: an application checks "email is unique" but no `UNIQUE` constraint exists on the column — a race lets duplicates in.

**In this repo:** partially, and the partial coverage is the story. The strong cases:
  → `isMcpConfigOverride` guards the wire boundary rigorously (`lib/mcp/config.ts:50-60`).
  → `makeAuthProvider` throws on cross-field violations (`lib/mcp/auth-providers/index.ts:56-76`).
  → `withAuthCookies` + AES-256-GCM enforce cookie integrity + request scoping.

The weak case:
  → **no shape guard on `Insight` at any read boundary.** The demo seeds could be corrupted (rename a field, break a type) and nothing would catch it at load — a bad `Insight` would just render weirdly in the UI.

**Fix:** add `isInsight()` type guard next to the interface declaration, mirror the pattern from `isMcpConfigOverride`. Use it at every "reads-a-committed-JSON" boundary (`demo-insights.json`, `demo-investigations.json`, any migrated eval receipts).

**Cost:** ~30 minutes per top-level type (Insight, Anomaly, Diagnosis, Recommendation, Investigation). Maybe 2 hours total. Best paid for at the same time as the `schemaVersion` work (red flag 3).

---

### 9. **A wire format with weak validation** — NOT PRESENT

**Generic form:** the app accepts network inputs without validating them, trusting the sender.

**In this repo:** no. The MCP config wire format has three failure modes covered (see file 04):
  → missing header → `null` → env fallback.
  → malformed base64 / JSON → `null` → env fallback.
  → invalid shape → type guard rejects → `null` → env fallback.

All three are tested at `test/mcp/config.test.ts`.

**Verdict:** clean — model for what other boundaries should do.

---

### 10. **Denormalization without a "single writer" invariant** — NOT PRESENT

**Generic form:** a denormalized field can be updated from multiple write paths, allowing the denormalized copy to drift from its source.

**In this repo:** no. Every denormalized field on `Insight` (`evidence`, `impact`, `history`, `affectedCustomers`, `category`) is written exactly once — inside `anomalyToInsight()` — and never mutated afterward. `putInsights` clears and rebuilds; nothing else writes.

**Verdict:** clean — the write-atomicity discipline (file 02, file 04) enforces the invariant by structure.

---

### 11. **A "big blob" JSON that's grown without a rotation strategy** — LOW · watch

**Generic form:** a collection of files grows indefinitely with no expiry, no rotation, no compaction.

**In this repo:** the `eval/receipts/` directory has 28 files committed today. Every baseline run adds 10 more (one per golden case). There's no rotation strategy, no `eval/receipts/archive/`, no note on how many to keep.

At current pace (~2-3 baseline runs per week during active dev, ~0 during idle), this is fine for a year. At 500+ receipts, the O(F) scans in `baseline.eval.ts` and `report.eval.ts` start to feel it, and git blob storage begins to bloat.

**Fix:** either partition into `eval/receipts/{runId}/*.json` (git-friendly, index by directory), or keep only the last N runs and archive the rest (loses history — worse). Best move: **partition + keep everything**, since git handles the storage cheaply.

**Cost:** ~30 minutes; the aggregator and load-shape scripts need updated readdir walks.

---

### 12. **A schema that assumes something the storage can't guarantee** — LOW · noted

**Generic form:** the schema treats a field as if the storage layer enforces some property (uniqueness, foreign-key integrity, ordering) that it actually doesn't.

**In this repo:** the `Anomaly` map is keyed by the parallel `Insight.id`, with no explicit "there's exactly one anomaly per insight" declaration. The invariant holds because `putInsights` writes both together, but the *shape* doesn't say it. If a maintainer later did `s.anomalies.set(someOtherId, ...)` from a different code path, the invariant would break silently.

**Fix:** a comment on `SessionFeed` explaining the parallel-map invariant, or (better) collapsing anomalies into `Insight.rawAnomaly?: Anomaly` so the parallel structure is impossible to violate.

**Cost:** the comment is 5 minutes; the structural collapse is 1 hour and requires care because the anomaly is intentionally kept separate for the agent-loop path (which doesn't want the denormalized `Insight` fields).

---

## Summary — the audit at a glance

```
  Ranked-worst-first — the audit's ledger

  ─────────────────────────────────────────────────────────────────────
  #    finding                                  severity   effort  fix
  ─────────────────────────────────────────────────────────────────────
  1    Diagnosis vs Investigation.diagnosis     HIGH       ~30m    file 02
       shape drift                                                  file 04
                                                                    fix
  3    no schemaVersion + migrate() policy       MEDIUM     ~2-3h   file 05
                                                                    Phase B
  4    Insight.id is session-UUID; no             MEDIUM     ~1h    file 06
       stable key for cross-session survival                        Q3
  5a   dev cache reparses whole file per call    LOW        ~15m    file 03
       (getCachedInvestigation)                                     memoize
  5b   O(F) receipt-dir scans in baseline/       LOW        ~1h     file 03
       load — cliff at ~500 files                                   partition
  8    no isInsight() guard on read boundaries   LOW-MED    ~2h     add type
                                                                    guards
  11   eval/receipts/ growing without rotation   LOW        ~30m    partition
                                                                    by runId
  12   parallel-map invariant undocumented       LOW        5m       comment
       (anomalies vs insights)
  ─────────────────────────────────────────────────────────────────────

  clean rows (no red flag firing):
  · N+1 queries (file 06 shape forecloses)
  · wire-format validation (isMcpConfigOverride is the model)
  · denormalization without single-writer (write-atomicity holds it)
  · destructive migration rollback (nothing destructive yet)
```

## The one-line verdict

**The data modeling is stronger than it looks for a no-DB app**, with two real risks (`Diagnosis` shape drift, no `schemaVersion`) and one latent architectural inflection (no stable identifier). The wire-boundary validation (`isMcpConfigOverride`) and the session-scoped Map keying are exemplary — those are the patterns to extend to the read boundaries that don't have them yet.

The single most valuable next PR: **file 02's `Diagnosis` fix**, 30 minutes, permanently removes a class of latent bug. The single most valuable *strategic* next step: **file 05's `schemaVersion` scaffolding**, 2-3 hours, buys forward capacity for every destructive schema change from that point on.

## Interview defense

### Q1 — "give me the worst data-modeling issue in this repo, and how you'd fix it."

> The `Diagnosis` shape drift. Same conceptual entity — the diagnostic agent's output — declared twice in the same file. `Diagnosis` (lib/mcp/types.ts:94-104) has `hypothesesConsidered: {hypothesis, supported, reasoning}[]`. `Investigation.diagnosis` (types.ts:132-141) has `hypothesesConsidered: string[]`. Nothing enforces they stay in sync.
>
> The fix is one line: replace `Investigation.diagnosis: {...inline...}` with `Investigation.diagnosis: Diagnosis`. TypeScript then flags every call site that assumed the old inline shape — I'd update those in the same PR. Thirty minutes of work, permanent removal of a whole class of latent shape-drift bug.

Anchor: "same file, same entity, two shapes, no enforcer."

### Q2 — "what's your migration strategy, and where does it break?"

> Optional-fields-only, forward-only. Every new field on my top-level types is `?`, so old committed JSONs — demo seeds, eval receipts, baseline — still validate against the current types. Adding a field is safe; renaming or retyping isn't.
>
> Where it breaks: destructive changes. Rename `Insight.headline` → `Insight.title` and my demo seeds silently render blank titles. There's no `schemaVersion` field to switch on, no `migrate()` at any read boundary. That's the biggest strategic debt.
>
> The fix path is defined but not built: read-side migration with `schemaVersion` + `migrate(fromVer, data)`. About 2-3 hours to scaffold, then every future destructive change adds one 15-minute case. The reason it's not built yet: no destructive change has been *needed* yet, and YAGNI applies to migration infrastructure until it doesn't.

Anchor: "forward-only today; read-side migration when destructive comes."

### Q3 — "what's the cleanest pattern in this codebase, and what makes it clean?"

> The wire-format validation for `McpConfigOverride`. Three failure modes covered (missing header, malformed base64/JSON, invalid shape), all falling back safely to env defaults, all tested. Cross-field invariants pushed one layer down to `makeAuthProvider` where they're enforced with throws. Empty-string normalization in a separate pass so partial overrides work without clobbering env.
>
> What makes it clean: **four layers, four failure modes, no layer trusted with the whole invariant.** The UI can be bypassed (curl); the type guard can be fooled by valid-but-nonsense values; the factory catches missing required fields for a given discriminant; the tests prove all four paths. That's the defense-in-depth pattern I'd extend to the *other* read boundaries — the demo seeds, the eval receipts — that currently have no guards at all.

Anchor: "the MCP config path is the model; the read boundaries for committed JSON aren't there yet."

## See also

- `01-the-data-model-and-its-shape.md` — the ERD that named every entity this audit touches.
- `02-normalization-and-duplication.md` — walks the specific `Diagnosis` shape drift.
- `04-transactions-and-integrity.md` — the wire-validation pattern this audit calls exemplary.
- `05-migrations-and-evolution.md` — the `schemaVersion` fix path for red flag 3.
- `06-access-patterns-and-storage-choice.md` — the "when to add a DB" line this audit's stable-key finding depends on.
