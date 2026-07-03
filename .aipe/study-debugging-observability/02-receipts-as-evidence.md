# 02 — Receipts as evidence

**Structured per-run evidence files on disk** — Language-agnostic.

## Zoom out — where this concept lives

Every eval case writes a self-contained JSON receipt to
`eval/receipts/`. Every load run writes one to `eval/load-receipts/`.
Every retrospective ("did p95 shift?", "what did the judge actually
say?") reads receipts. The live NDJSON wire is ephemeral; the receipt
pile is *the* durable observability surface.

```
  Zoom out — receipts in the whole system

  ┌─ Live path ──────────────────────────────────────────────────┐
  │  route → NDJSON → browser trace                              │
  │  (evaporates when the request ends)                          │
  └──────────────────────────────────────────────────────────────┘

  ┌─ Eval path (the durable pile) ───────────────────────────────┐
  │  run.eval.ts   ── writes ──►  eval/receipts/*.json           │
  │  load.eval.ts  ── writes ──►  eval/load-receipts/*.json  ★    │
  │                                                       ▲       │
  │                                              (we are here)     │
  │                                                                │
  │  Read by:                                                      │
  │    · report.eval.ts    → p50/p95/p99 + tokens + cost table    │
  │    · baseline.eval.ts  → per-dimension pass rates → baseline  │
  │    · gate.eval.ts      → candidate vs baseline delta          │
  └──────────────────────────────────────────────────────────────┘
```

**Zoom in — what it is.** A per-case JSON file, self-contained, with
enough detail to reproduce the case and to answer any latency / cost /
quality question offline. The receipt *is* the evidence. Zero model
calls to re-analyze it.

## Structure pass

**Layers.** Producer (eval runner) · storage (filesystem) · reader
(report / baseline / gate) · comparator (gate).

**One axis held constant: state ownership.** Who owns the receipt at
each layer?

```
  "who owns the receipt?"

  ┌───────────────────────────────────────┐
  │ producer: run.eval.ts / load.eval.ts  │   → RUNNER writes once
  └───────────────────────────────────────┘
      ┌─────────────────────────────────────┐
      │ storage: eval/receipts/*.json       │   → DISK owns forever
      └─────────────────────────────────────┘
          ┌────────────────────────────────┐
          │ readers: report / gate / …      │   → READERS treat immutable
          └────────────────────────────────┘

  write-once, read-many. no shared mutation.
```

**Seams.** The important one: the *file* is the seam. Anyone with the
file can reproduce every downstream number. No shared library, no
service, no schema registry — the JSON shape is stable enough that a
newer reader (like `report.eval.ts`) can backfill fields
(`report.eval.ts:107-117`) from older receipts.

## How it works

### Move 1 — the mental model

Think of a receipt the way a bank thinks of a transaction record: the
event happened, the record is the durable evidence, and the record
carries enough context (amount, timestamp, counterparty) that any
downstream question about it can be answered from the record alone
without re-executing the transaction. Cheap to write, cheap to read,
cheap to compare.

```
  The receipt file — the shape

     eval/receipts/01-conversion-drop-mobile-checkout-2026-07-03T04-08-28-644Z.json

     ┌──────────────────────────────────────────────────────────┐
     │ { runId, case, signalClass, intent,                      │
     │   durationMs: {                                          │
     │     investigate, diagnosisJudge,                         │
     │     recommend, recommendationJudge, total                │
     │   },                                                     │
     │   model: { agent, judge },                               │
     │   anomaly: { metric, scope, change, severity },          │
     │   diagnosisToolCalls: [ { toolName, args, durationMs,    │
     │                            hasError } ],                 │
     │   recommendationToolCalls: [ ... ],                      │
     │   usage: {                                               │
     │     diagnose:  { in, out, turns, cost },                 │
     │     recommend: { in, out, turns, cost } },               │
     │   budget: { limit, snapshot, exceeded, budgetError },    │
     │   diagnosis: { ... },                                    │
     │   diagnosisJudgment: { verdict, dimensions, fix },       │
     │   recommendations: [ ... ],                              │
     │   recommendationJudgments: [ { judgment, ... } ] }       │
     └──────────────────────────────────────────────────────────┘

     ~35KB per case · gitignored · runId ties them together
```

### Move 2 — the mechanism, step by step

Five moving parts.

**Part A — the runId.** One per run, minted in `beforeAll`. Every
receipt in the run embeds it in both the filename and the JSON body.
This is the single correlation ID that turns a directory of files back
into a run.

Real code from `eval/run.eval.ts:162-173`:

```ts
beforeAll(() => {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not set...');
  }
  sharedRunId = new Date().toISOString().replace(/[:.]/g, '-');
  sharedAnthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  mkdirSync(RECEIPTS_DIR, { recursive: true });
  console.log(`\n[eval] runId: ${sharedRunId}`);
});
```

The `runId` shape is filesystem-safe ISO 8601 (`:` and `.` replaced with
`-`) so it works as a filename component. Readers pattern-match it back
out with the regex at `eval/report.eval.ts:206`: `/-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d+Z)\.json$/`.

```
  runId — the correlation

  filename:    01-conversion-drop-mobile-checkout-2026-07-03T04-08-28-644Z.json
                                                    ▲
                       ────────────────────────────  │
                       └── caseId                    │
                                                     │
                                                runId (also inside receipt body)

  every receipt in a run: same runId
  filter directory: `ls receipts | grep 2026-07-03T04-08-28-644Z`
  → all 10 case receipts, in one command
```

**Part B — the timing capture.** Every phase gets a `performance.now()`
bracket. All five deltas land in one `durationMs` object.

Real code from `eval/run.eval.ts:199-329`:

```ts
const t0Investigate = performance.now();
const diagnosis = await diagnosticAgent.investigate(goldenCase.anomaly, {
  onToolResult: (tc) => diagnosisToolCalls.push({ ...tc }),
  onCapabilityEvent: (ev) => diagnosisTrace.push(ev),
  budget,
});
const investigateMs = Math.round(performance.now() - t0Investigate);

// ... judge diagnosis ...
const t0DiagnosisJudge = performance.now();
// ...
const diagnosisJudgeMs = Math.round(performance.now() - t0DiagnosisJudge);

// ... recommend ...
// ... judge each recommendation ...

// then in the receipt:
durationMs: {
  investigate: investigateMs,
  diagnosisJudge: diagnosisJudgeMs,
  recommend: recommendMs,
  recommendationJudge: recommendationJudgeMs,
  total: Math.round(performance.now() - caseStart),
},
```

`performance.now()` is monotonic — safe across NTP adjustments, unlike
`Date.now()`. Every latency number in the report / gate / baseline
originates here.

**Part C — the usage/cost fill.** The `onCapabilityEvent` hook (see
`04-capability-trace-fanout.md`) captures every raw AptKit event into a
`diagnosisTrace: CapabilityEvent[]` array. After the phase completes,
`summarizeUsage` walks the array; `estimateCost` prices it.

Real code from `eval/run.eval.ts:207-220`:

```ts
const diagnosisToolCalls: ToolCall[] = [];
const diagnosisTrace: CapabilityEvent[] = [];
const diagnosis = await diagnosticAgent.investigate(goldenCase.anomaly, {
  onToolResult: (tc) => diagnosisToolCalls.push({ ...tc }),
  onCapabilityEvent: (ev) => diagnosisTrace.push(ev),
  budget,
});
const investigateMs = Math.round(performance.now() - t0Investigate);
const diagnosisUsage = summarizeUsage(diagnosisTrace);
// aptkit's estimateCost only knows OpenAI pricing; fall back to
// Blooming's Anthropic pricing helper for our claude-* models.
const diagnosisCost =
  estimateCost('anthropic', diagnosisUsage, 'claude-sonnet-4-6') ??
  estimateAnthropicCost(diagnosisUsage, 'claude-sonnet-4-6');
```

Note the fallback — aptkit ships OpenAI pricing tables only, so
Blooming's `estimateAnthropicCost` (`lib/agents/pricing.ts`) is the
last-mile pricer for `claude-*` models. Same math either way; the fall-
through means old receipts with `costUsd: null` can be backfilled at
report time.

**Part D — the write.** One `writeFileSync` per case, JSON.stringify
with 2-space indent + trailing newline.

Real code from `eval/run.eval.ts:341-398`:

```ts
const receipt = {
  runId: sharedRunId,
  case: goldenCase.caseId,
  signalClass: goldenCase.signalClass,
  intent: goldenCase.intent,
  durationMs: { investigate, diagnosisJudge, recommend, recommendationJudge, total },
  model: { agent: 'claude-sonnet-4-6', judge: 'claude-sonnet-4-6' },
  anomaly: {
    metric: goldenCase.anomaly.metric,
    scope: goldenCase.anomaly.scope,
    change: goldenCase.anomaly.change,
    severity: goldenCase.anomaly.severity,
  },
  diagnosisToolCalls: diagnosisToolCalls.map((tc) => ({
    toolName: tc.toolName,
    args: tc.args,
    durationMs: tc.durationMs,
    hasError: Boolean(tc.error),
  })),
  recommendationToolCalls: /* ... */,
  usage: {
    diagnose: usageWithCost(diagnosisUsage, diagnosisCost),
    recommend: usageWithCost(recommendUsage, recommendCost),
  },
  budget: {
    limit: budget.limit,
    snapshot: budget.snapshot(),
    exceeded: budget.exceeded(),
    budgetError,
  },
  diagnosis,
  diagnosisJudgment,
  diagnosisJudgmentError,
  diagnosisJudgeAttempts: diagnosisJudgmentResult.attempts.length,
  recommendations,
  recommendationJudgments,
};

const outPath = resolve(RECEIPTS_DIR, `${goldenCase.caseId}-${sharedRunId}.json`);
writeFileSync(outPath, JSON.stringify(receipt, null, 2) + '\n', 'utf8');
```

The receipt is *self-contained* — the anomaly is embedded, the tool
calls are embedded, the judgment is embedded. Someone with the file
alone knows what case ran, what tools it called, what it concluded, and
how the judge scored it. No cross-file joins required.

**Part E — the read.** Any downstream analysis picks up a runId (env
var or `pickRunId` default: the latest one on disk) and does the same
filter.

Real code from `eval/report.eval.ts:60-70`:

```ts
it('emit report for the run', () => {
  const runId = pickRunId(process.env.RUN_ID);
  const files = readdirSync(RECEIPTS_DIR)
    .filter((f) => f.endsWith(`${runId}.json`))
    .sort();
  if (files.length === 0) throw new Error(`No receipts for runId ${runId}`);

  const receipts: Receipt[] = files.map(
    (f) => JSON.parse(readFileSync(resolve(RECEIPTS_DIR, f), 'utf8')) as Receipt,
  );
```

That's the whole read seam. Grep-and-parse. The report code then
computes percentiles (`report.eval.ts:161-179`) from the `durationMs`
fields directly.

### Move 2 variant — the load-bearing skeleton

The kernel:

```
  runId (correlation)
  + self-contained receipt (case + inputs + outputs + judgment + timing + cost)
  + one file per case, filename encodes runId + caseId
  + write-once, read-many (no downstream mutation)
```

- **Drop the runId** and you can't distinguish two runs' receipts sitting
  in the same directory — no comparison, no baseline, no gate.
- **Drop self-containment** (e.g. by only writing a reference to a
  separate anomaly file) and receipts become fragile when the referenced
  file drifts. The interpretation ("what case is this?") stops being
  local.
- **Drop the "one file per case" shape** for a single big JSON blob and
  concurrent load runs need file locking; a partial write on crash
  corrupts every case.
- **Drop write-once** and receipts become a shared-mutable data source;
  every reader needs a schema version.

Skeleton vs hardening:

- **Skeleton:** runId + self-contained JSON file per case.
- **Hardening:** `.gitignore`-based ignore of receipts (so the pile
  doesn't bloat the repo), backfill logic in the reader
  (`report.eval.ts:192-199`) for older receipt shapes, budget snapshot
  even when the ceiling wasn't hit (proves the guard was live).

### Move 3 — the principle

**Evidence beats memory.** The temptation with an LLM system is to
re-run the agent to check something — "I think it's usually 50s, let me
run it again." A receipt says no: the number is fixed, the run
happened, and re-running costs $0.09 to answer a question you could
have answered by reading a file for free. Every retrospective becomes
grep + jq, which is what you want.

## Primary diagram

```
  Receipts as evidence — full picture

  Runner side (write once)                                 Reader side (read many)

  ┌─ eval/run.eval.ts ─────────────┐              ┌─ eval/report.eval.ts ──────┐
  │                                 │              │                             │
  │  beforeAll: mint sharedRunId    │              │  pickRunId (env or latest) │
  │  ────────────────────────────   │              │  ────────────────────────  │
  │  it.each(goldens):              │              │  readdir(RECEIPTS_DIR)     │
  │    t0 = performance.now()       │              │    .filter(runId match)    │
  │    diagnostic.investigate(hook) │              │    .map(JSON.parse)        │
  │    ms = now - t0                │              │  ─────────────────────────  │
  │    judge → verdict              │              │  percentiles per phase     │
  │    recommend                    │              │  sum tokens + cost         │
  │    judge each rec               │              │  print table               │
  │  ────────────────────────────   │              └───────────────────────────┘
  │  writeFileSync(receipt)  ───────┼──►  ┌───────────────────┐    ┌─ eval/baseline.eval.ts ──┐
  │                                 │     │ eval/receipts/    │◄───│  computeBaseline          │
  └─────────────────────────────────┘     │ *.json (per case) │    │  → eval/baseline.json     │
                                          └───────────────────┘    └───────────────────────────┘
                                                                            │
                                                                            ▼
                                                                  ┌─ eval/gate.eval.ts ──────┐
                                                                  │  candidate vs baseline   │
                                                                  │  → eval/gate-<runId>.json│
                                                                  └───────────────────────────┘

  Load side (parallel, no judges)                          Read side

  ┌─ eval/load.eval.ts ────────────┐              (same shape, different reader)
  │  N investigations, K workers    │
  │  writeFileSync ────►  eval/load-receipts/load-<runId>.json
  └─────────────────────────────────┘
```

## Elaborate

Receipts as an evidence pattern shows up in several places in the
industry — SEC broker-dealer books-and-records, credit-card
authorization logs, git's object store. The common shape is:
**self-contained, immutable, named by content or by a monotonic id.**

The Blooming version is closest to a *pytest --junit-xml*-shaped
report, if pytest wrote one file per test and embedded the inputs.
The important twist for AI eval is that the LLM output is *not
deterministic*: the receipt is the only way to say "this exact
diagnosis, from this exact anomaly, got this exact verdict from that
exact judge model." Re-running the case doesn't reproduce the string.

Adjacent concepts:

- **Event sourcing** — the durable log is the truth; state is a
  fold over the log. Receipts here are one-per-case rather than
  one-append-only-log, but the read-many-write-once discipline is
  the same.
- **Structured build outputs** — CI artifacts (JUnit XML, Cobertura,
  SARIF) are receipts in the same shape. Same reason: the CI
  container evaporates, the artifact has to carry the evidence.
- The AptKit `CapabilityEvent` model — the raw trace is what
  `summarizeUsage` folds into the receipt.

## Interview defense

**Q: Why write receipts to disk instead of a database?**

Because the read pattern is "give me all the receipts for a runId,
compute stats." That's a `readdir + JSON.parse` loop; it's I/O-bound,
not query-bound, and the pile size is measured in megabytes not
gigabytes. A database is the wrong abstraction for write-once, read-
occasionally, small-total-volume data.

The bigger reason: the file *is* the artifact you attach to a PR / an
incident review / a debug email. "Here's the receipt for case 09"
is a link to one file. "Here's a database query" isn't.

**Q: What's on a receipt that isn't on the wire?**

The judgment. The wire carries `diagnosis` + `recommendation` as they
happen, but the judge model runs *after* the diagnostic + recommend
phases complete — offline, no user-facing surface. The judgment
(`verdict` + per-dimension scores + the reasoning) lives on the
receipt only.

Also on the receipt, not the wire: the model name(s), the budget
snapshot at end-of-run, the per-tool-call `hasError` boolean rollup,
and the estimated cost.

**Q: How do receipts survive schema evolution?**

By making readers backfill. `report.eval.ts:107-117` and `:192-199`
explicitly handle the case where an older receipt has `costUsd: null`
or is missing `usage[]` — the reader re-computes cost from the token
counts using Blooming's pricing helper. The receipt shape is
append-only in practice; new fields land as optional, readers default
them when absent.

Anchor: never delete a field from the receipt shape without
double-checking the readers.

**Q: What's the load-bearing part of the receipt design?**

The runId. Everything else falls out of it: the filename convention,
the filter-by-suffix read pattern, the ability to compare two runs.
Drop the runId and the pile is opaque — same 10 cases per run, no way
to tell which run any given file belongs to.

## See also

- `03-per-phase-timing-log.md` — the *live* version of the same timing
  information.
- `04-capability-trace-fanout.md` — the hook that fills the `usage`
  section of the receipt.
- `05-budget-tracker-as-guard.md` — the tracker whose snapshot lands
  in the receipt as `budget.snapshot`.
- `07-regression-gate-and-baseline.md` — the primary consumer of the
  receipt pile.
