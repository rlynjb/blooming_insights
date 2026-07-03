# Data modeling red-flags audit

**Industry term:** Data-modeling smell catalog · **Type:** Consolidated capstone checklist, applied verbatim to blooming_insights.

## Zoom out, then zoom in

**Zoom out — the audit at a glance.** This is the capstone. Each red flag from the topic spec, marked FIRES / N/A / CLEAN against this repo with a one-line rationale and a link to the concept file that walks it in depth. If a red flag is N/A, it's because the substrate doesn't exist (no DB → no missing-index red flag in the classical sense).

```
  The red-flag scorecard — where blooming_insights lands

  ┌─ FIRES ────────────────────────────────────────────────────────┐
  │  · same fact stored twice (2 instances — walked in file 02)    │
  │  · query pattern with no supporting index                       │
  │    (eval aggregation over receipts/ — walked in file 03)        │
  │  · invariant enforced only in app code                          │
  │    (clear-then-set, demo-capture atomicity — walked in file 04) │
  └────────────────────────────────────────────────────────────────┘

  ┌─ CLEAN ────────────────────────────────────────────────────────┐
  │  · destructive migration with no rollback (no migrations)      │
  │  · column drop with no backfill (no columns, no drops)          │
  │  · schema fighting the access pattern (request/demo paths OK)   │
  └────────────────────────────────────────────────────────────────┘

  ┌─ N/A — substrate doesn't exist ────────────────────────────────┐
  │  · no discernible model / everything in one JSON blob           │
  │    (there IS a discernible model — it's in TypeScript, not SQL) │
  │  · multi-write op without transaction: FIRES for the two cases  │
  │    that exist (see 04) — but the general "SQL transaction"      │
  │    version is N/A because there's no SQL                        │
  │  · N+1 query in ORM: N/A (no ORM)                               │
  └────────────────────────────────────────────────────────────────┘
```

**Zoom in — the pattern.** Read this file top-to-bottom as the audit summary. Each finding names its severity, its home file, and the constructive next move.

## Structure pass

### One axis: severity (impact × likelihood)

```
  Severity axis — cost today × likelihood of firing tomorrow

  cost today │ cost tomorrow
  ───────────┼───────────────
   zero      │    low       →  keep an eye, don't act
   zero      │    high      →  refactor before shipping the change that fires it
   low       │    low       →  accept as debt
   low       │    high      →  fix in the next sprint
   high      │    any       →  fix now
```

Every finding below carries a "severity today" and a "severity if X changes."

### Seams — where red flags cluster

Two seams collect most of the flags:

- **The `anomalyToInsight` seam** (`lib/state/insights.ts:25`) — the enrichment splice is where denormalization enters, and it's where the missing "recompute on evidence change" contract lives.
- **The `eval/` aggregation seam** (`eval/baseline.eval.ts`, `gate.eval.ts`, `report.eval.ts`) — three copies of the same directory-scan pattern, no shared abstraction, no indexed store.

Everything else is either clean or "the substrate doesn't exist so the question doesn't apply."

## How it works

### Move 1 — the mental model

Read the checklist the way you'd read a linter's output: each entry names a *specific pattern* to look for in your code, a *specific consequence* if it's present, and a *specific fix* if you decide to address it. Not every red flag needs to be fixed — some are acceptable debt for the current scale — but every red flag deserves to be *named*. Blind spots are more dangerous than known debt.

```
  How to read a red-flag entry

     ┌──────────────────────────────────────────────┐
     │ NAME OF THE RED FLAG                         │
     │  ─────────────────────────                   │
     │  where it fires · file:line                  │
     │  severity today · severity tomorrow          │
     │  what breaks (concrete)                      │
     │  fix (constructive)                          │
     │  cross-ref to the concept file that walks it │
     └──────────────────────────────────────────────┘
```

### Move 2 — the checklist, one entry at a time

#### RF1 · Same fact editable in two places — FIRES

**Where:** `lib/mcp/types.ts:58` (type comment explicitly names it as "denormalized from Diagnosis.affectedCustomers.count"); `lib/state/insights.ts:25-45` (the derived-field splice in `anomalyToInsight`).

**Severity today:** low. Pipeline is one-shot; anomalies aren't mutated after enrichment.
**Severity tomorrow:** medium-high. The moment any edit path is added (re-scope a diagnosis, refresh evidence), the copies silently disagree.

**What breaks:** `Insight.affectedCustomers` renders the count from the first diagnosis; a re-run diagnosis with a different count doesn't update the card. `Insight.revenueImpact` etc. derive from evidence at construction; if evidence gets enriched mid-flight, the derived field is stale.

**Fix:** delete the derived fields from `Insight`; derive at render time (a `.map()` inside the component) or via a memoized selector. Cost is negligible — display-time only.

→ Full walkthrough: `02-normalization-and-duplication.md`.

#### RF2 · Frequent query with no supporting index — FIRES

**Where:** `eval/baseline.eval.ts:44-51`, `eval/gate.eval.ts:64-72`, `eval/report.eval.ts:62-70`. Three copies of `readdirSync + filter-by-suffix + JSON.parse × N`.

**Severity today:** low. 10 files per run × a few runs = milliseconds per aggregation.
**Severity tomorrow:** high at 200 cases per run or when cross-run trending arrives (no answer without full scan).

**What breaks:** every gate/baseline/report run does two full directory listings (one to pick the runId, one to filter). Every cross-run question — "which cases regressed in the last month?" — has no answer short of parsing every file.

**Fix:** two-step. **Step 1 (cheap):** factor a `eval/receipts.ts` module with `listRunIds()` and `readRun(runId)`; three call sites collapse to one abstraction. **Step 2 (bigger, only when the query pattern demands):** SQLite table `run_dimensions(runId, caseId, dimension, score, verdict)` + index on `(dimension, verdict)`. Keep receipts as blobs for full replay; extract the aggregation surface into rows.

→ Full walkthrough: `03-indexing-vs-query-patterns.md`.

#### RF3 · Multi-write operation with no transaction — FIRES (two instances)

**Where:**
1. `lib/state/insights.ts:57-71` — `putInsights` does `.clear()` + `.clear()` + `forEach.set` in sequence, no swap.
2. Demo-capture path — writes `lib/state/demo-insights.json` **and** `lib/state/demo-investigations.json` sequentially; no atomic-rename dance.

**Severity today:** near-zero. Case 1 is safe because Node's event loop doesn't preempt inside a sync function and the current loop body doesn't await. Case 2 is safe because dev workflow is capture → git diff → commit, so bad writes get caught by human review.

**Severity tomorrow:** case 1 becomes real the moment anyone adds an `await` inside the forEach (which the shape doesn't forbid). Case 2 becomes real the moment the capture becomes automated / CI-triggered.

**What breaks:** case 1 — a concurrent `listInsights` in the race window returns `[]`. Case 2 — first file succeeds, second fails, committed demo is inconsistent (insight ids reference nonexistent investigations).

**Fix:** case 1 — build the new maps locally, swap references atomically. Case 2 — write to temp files, then rename in a specific order (or collapse to one file).

→ Full walkthrough: `04-transactions-and-integrity.md`.

#### RF4 · Invariant enforced only in app code (not the store) — FIRES (by construction)

**Where:** everywhere, because the store *is* app code. There's no DB layer that could enforce constraints. `lib/mcp/validate.ts:17-57` is the entire integrity layer for LLM-produced content; `BudgetTracker` is the entire integrity layer for cost.

**Severity today:** low. The validators are correct and run at every trust boundary. Budget is enforced before every model turn.
**Severity tomorrow:** low, *as long as* new trust boundaries also add validators. The risk is a future contributor adding a route handler that skips validation and injects unchecked LLM output into state.

**What breaks if a validator is skipped:** malformed anomalies flow into the state Map, then throw at some downstream deref with no useful stack.

**Fix:** none needed for the current shape — this red flag *"invariant enforced in app code"* fires by construction in a no-DB architecture and is the intended design. Address only if you introduce a durable store; then move constraints (uniqueness, FK, check constraints) into the store where the enforcement is stronger.

→ Full walkthrough: `04-transactions-and-integrity.md`.

#### RF5 · Destructive migration with no rollback — CLEAN

**Where:** N/A. There are no migrations; the schema evolves by adding optional fields (`?`) to TypeScript interfaces. Every change is additive-only.

**Severity today:** zero.
**Severity tomorrow:** low — the discipline is enforced by convention + the 144-test suite that reads the committed demo. A breaking change would require touching every persisted snapshot; the review pressure would catch it.

**What breaks:** nothing yet. The trap to watch: the day someone tries to *narrow* a union type (drop the string case from `EstimatedImpact`), it silently invalidates every legacy snapshot. → tracked in `05-migrations-and-evolution.md`.

**Fix:** no fix; keep the additive-optional discipline. If schema evolution ever becomes a hot path (frequent shape changes across many stores), introduce a Zod-style schema library so migrations become explicit versioned artifacts.

#### RF6 · Column drop with no backfill — CLEAN

**Where:** N/A (no columns, no drops).

→ See `05-migrations-and-evolution.md` for the equivalent case in this repo: *renaming* a required field.

#### RF7 · Relational schema fighting a document-shaped access pattern (or vice versa) — CLEAN (deliberate)

**Where:** N/A. There's no relational schema. The document-shaped access pattern is matched with document-shaped storage (JSON files). The KV access pattern is matched with a Map.

**Severity today:** zero. Store shape matches access shape on every path.
**Severity tomorrow:** medium at eval-aggregation growth — `06-access-patterns-and-storage-choice.md` names the trigger.

→ Full walkthrough: `06-access-patterns-and-storage-choice.md`.

#### RF8 · No discernible data model / one giant JSON blob — CLEAN

**Where:** N/A. The model is well-articulated in `lib/mcp/types.ts` (7 core interfaces) + `eval/goldens/types.ts` (4 eval interfaces) with a single canonical file per concern. This isn't the "unknown blob" anti-pattern — the shapes are typed, imported everywhere, and validated at boundaries.

**Severity today:** zero.
**Severity tomorrow:** zero, provided new persisted concerns get their own interface rather than being stuffed into an existing one.

→ Full walkthrough: `01-the-data-model-and-its-shape.md`.

#### RF9 · N+1 query in ORM code — N/A

No ORM, no query, no N+1.

The closest analog: **N+1 file reads** in the eval aggregation loop. The `readdirSync + parse × N` pattern reads N files to answer one question. This is called out under RF2 rather than as a separate flag; the fix (materialized view or a real store) is the same.

#### Move 2 variant — the load-bearing skeleton of "a red-flags audit that stays useful"

Three parts. If any is missing, the audit degrades from tool to decoration.

1. **Named findings, not vague smells.** "This might be a problem" isn't a finding. "`Insight.affectedCustomers` is denormalized from `Diagnosis.affectedCustomers.count`, breaks the moment either is re-computed independently" is a finding. Every entry above cites a specific file:line.

2. **Severity split: today vs tomorrow.** A red flag with severity=low today can be worth fixing if severity tomorrow is high. Reversing the pair (high today, low tomorrow) usually means "the thing that would have fired already did, once, and now everyone is careful" — accept as debt. Every entry above gives both.

3. **Constructive move, not just critique.** Every entry names the fix. RF1's fix is "derive at render time." RF2's fix is a two-step `eval/receipts.ts` + SQLite. If a red flag has no fix, it's either N/A or the design is deliberately paying the cost — say so explicitly (RF4 CLEAN by construction, RF7 CLEAN deliberately).

### Move 3 — the principle

**A red-flags audit is only useful if you also do the un-flagging.** Every finding needs a decision: fix now, fix next, or accept as debt with the tradeoff named. Blooming_insights lands in a genuinely reasonable place — three flags fire, all at low severity today, all with concrete moves for when severity rises. The two that would be worth acting on soon are (RF2) the missing `eval/receipts.ts` abstraction (the fix is a factoring, not a store change) and (RF3) the demo-capture atomicity (a one-time write-then-rename fix). The rest are debt worth naming and accepting.

## Primary diagram

The whole audit in one frame.

```
  blooming_insights — red-flag capstone

  ┌─ act soon (today's low + tomorrow's high) ──────────────────┐
  │                                                              │
  │  RF1  denormalization on Insight     → derive at render      │
  │       (02-normalization-and-duplication.md)                  │
  │                                                              │
  │  RF2  eval scan × 3 sites            → factor eval/receipts  │
  │       (03-indexing-vs-query-patterns.md)                     │
  │                                                              │
  │  RF3  demo-capture atomicity         → write-then-rename     │
  │       (04-transactions-and-integrity.md)                     │
  └─────────────────────────────────────────────────────────────┘

  ┌─ accept as debt (low both today and tomorrow) ──────────────┐
  │                                                              │
  │  RF3(a)  putInsights clear-then-set  → safe until an await   │
  │          is added inside the forEach                         │
  │                                                              │
  │  RF4  integrity in app code          → intended for no-DB    │
  │                                                              │
  └─────────────────────────────────────────────────────────────┘

  ┌─ clean or N/A ──────────────────────────────────────────────┐
  │                                                              │
  │  RF5  destructive migration          → no migrations         │
  │  RF6  column drop w/o backfill       → no columns            │
  │  RF7  schema vs access mismatch      → matches by design     │
  │  RF8  no discernible model           → well-typed model      │
  │  RF9  N+1 in ORM                     → no ORM                │
  │                                                              │
  └─────────────────────────────────────────────────────────────┘
```

## Elaborate

The three "act soon" findings share a shape: **an abstraction that isn't there yet.** RF1 needs a "compute at read" abstraction (a selector or a hook). RF2 needs an "eval receipts" module abstraction. RF3(demo-capture) needs a write-then-rename abstraction. None of these require introducing a store, a library, or a framework — they're all local refactorings that harden the shape without adding a dependency. That's the sweet spot: high leverage, low commit cost.

The "accept as debt" entries are also worth reading as a check on discipline. RF3(a) is safe because Node's synchronous execution model *happens to* protect the code. That's not a data-modeling contract — it's a runtime happenstance. If you ever want the code to be safe *by contract*, the immutable-swap fix is a two-line change. Whether to do it now is a question about the team's tolerance for latent bugs vs the value of "we shipped that fix and it stays fixed forever."

## Interview defense

**Q: "Walk me through your data-modeling audit findings, worst to best."**
Answer: "Three fire, five are clean or N/A. Worst: RF1 — `Insight` denormalizes derived fields from `Anomaly.evidence` and copies `Diagnosis.affectedCustomers.count`. Zero cost today because the pipeline is one-shot; medium-high cost the moment any edit path is added. Second: RF2 — `readdirSync + filter + parse × N` appears three times in the eval subsystem. First fix is factoring `eval/receipts.ts`, no store needed; second fix is SQLite once cross-run trending becomes a query. Third: RF3 — two multi-write operations without atomicity (in-memory clear-then-set, demo two-file capture). Both safe today by convention, both need a swap-or-rename fix. Clean cases: no destructive migrations, well-typed model, store shape matches access on request and demo paths. N/A: no ORM, no SQL." Draw the severity-split diagram.

**Q: "What's the one you'd fix first if you had a day?"**
Answer: "RF2's first move — factor `eval/receipts.ts` with `listRunIds()` and `readRun(runId)`. Three call sites collapse to one abstraction. Doesn't need a store; just removes duplication and gives us a seam to swap in a database later. Under two hours to ship." Anchor: `eval/baseline.eval.ts:44-51`, `eval/gate.eval.ts:64-72`, `eval/report.eval.ts:62-70`.

**Q: "What would you leave alone?"**
Answer: "RF4 — invariants in app code — is by design in a no-DB system. `lib/mcp/validate.ts` is 60 lines and handles every trust boundary. `BudgetTracker.exceeded()` guards cost before every model turn. Both are enforced at exactly the right seams; moving them to a store would only matter if a store existed. And RF5 through RF9 are honestly N/A — you shouldn't invent problems the substrate doesn't have." Anchor: `lib/agents/budget.ts:71-76` for the model of a good app-side invariant.

## See also

- `00-overview.md` — the summary card that got you here.
- `02-normalization-and-duplication.md` — RF1 walkthrough.
- `03-indexing-vs-query-patterns.md` — RF2 walkthrough.
- `04-transactions-and-integrity.md` — RF3 and RF4 walkthrough.
- `05-migrations-and-evolution.md` — why RF5 / RF6 are clean.
- `06-access-patterns-and-storage-choice.md` — why RF7 is clean and where it would flip.
