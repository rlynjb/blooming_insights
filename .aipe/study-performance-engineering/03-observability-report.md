# observability report

**Industry name(s):** performance report · receipt-driven observability · offline analytics over trace artifacts. **Type label:** Language-agnostic.

## Zoom out — where the report sits

The report is a purely offline consumer of files-on-disk. Nothing runs against the model. Nothing calls the network. It reads receipts written during the live eval and prints latency percentiles + cost.

```
Zoom out — where the report sits

┌─ Storage band (filesystem) ─────────────────────────┐
│  eval/receipts/*.json   ← per-case receipts          │
│  eval/baseline.json     ← aggregated baseline        │
│  eval/load-receipts/*.json ← load-run summaries      │
└──────────────────────┬──────────────────────────────┘
                       │  read
┌─ Analysis band ──────▼──────────────────────────────┐
│  eval/report.eval.ts (offline, zero-cost)            │  ← we are here
│   → percentiles across cases                         │
│   → cost per case (backfilled if older receipts)     │
│   → tool-call latency stats                          │
└──────────────────────┬──────────────────────────────┘
                       │  console.error
┌─ Terminal ───────────▼──────────────────────────────┐
│  ASCII table: p50 / p95 / p99 / max / mean           │
└──────────────────────────────────────────────────────┘
```

**Zoom in — what it is.** Every eval run writes a per-case receipt with timings and token usage. The report walks the receipts for a run, computes distributions, and prints an ASCII table. Zero model calls, zero cost. The receipts are the source of truth; the report is a lens over them.

## Structure pass — layers · one axis · one seam

The axis worth tracing is **when the number is produced vs when it's read**.

```
one axis held: "when does this number exist?"

┌─ live run (per-case) ────────────────────────┐
│  eval/run.eval.ts                             │  → number PRODUCED here
│  writes receipt to disk                       │
└──────────────────────┬────────────────────────┘
                       │  seam: the receipt file
┌─ offline report ─────▼───────────────────────┐
│  eval/report.eval.ts                          │  → number READ here
│  reads all receipts, computes p50/p95/p99     │
│  backfills cost when older receipt lacks it   │
└──────────────────────┬────────────────────────┘
                       │  seam: the baseline file
┌─ baseline / gate ────▼───────────────────────┐
│  eval/baseline.eval.ts, eval/gate.eval.ts     │  → number COMPARED here
│  a fresh run against the frozen baseline      │
└───────────────────────────────────────────────┘
```

**The seams.** Two joints: (1) the receipt file — separates live measurement from offline analysis, so the analysis is free to rerun; (2) the baseline file — separates today's measurement from yesterday's frozen truth, so regressions are visible. Removing either collapses the whole pipeline into a single live run and you lose the ability to compare.

## How it works

### Move 1 — the mental model

You've probably built a fetch that logs `Date.now()` before and after and prints the delta. This is that pattern applied at scale — every phase of every case emits a duration, and the report is the aggregation layer over all of them. The receipt is what a `.har` file is for a network trace: a permanent artifact you can analyze any time without rerunning the request.

```
The pattern — three artifacts, one truth

live run                    baseline               fresh run
    │                           │                      │
    ▼                           ▼                      ▼
per-case receipts        aggregated baseline     new receipts
(one file per case)      (frozen, committed)     (one per case)
    │                           │                      │
    │                           │                      │
    └───► REPORT ◄──────────────┴──── COMPARE ◄────────┘
       p50/p95/p99                    delta vs baseline
       ASCII table                    ± % change
```

### Move 2 — the step-by-step walkthrough

#### Step 1 — every case writes a receipt during the live run

`eval/run.eval.ts:341`:

```typescript
const receipt = {
  runId: sharedRunId,
  case: goldenCase.caseId,
  signalClass: goldenCase.signalClass,
  durationMs: {
    investigate: investigateMs,
    diagnosisJudge: diagnosisJudgeMs,
    recommend: recommendMs,
    recommendationJudge: recommendationJudgeMs,
    total: Math.round(performance.now() - caseStart),
  },
  usage: {
    diagnose: usageWithCost(diagnosisUsage, diagnosisCost),
    recommend: usageWithCost(recommendUsage, recommendCost),
  },
  budget: {
    limit: budget.limit,
    snapshot: budget.snapshot(),
    exceeded: budget.exceeded(),
  },
  diagnosis, diagnosisJudgment, recommendations, recommendationJudgments,
  // ...
};
writeFileSync(outPath, JSON.stringify(receipt, null, 2) + '\n', 'utf8');
```

One JSON file per case per run. Path shape: `eval/receipts/<caseId>-<runId>.json`. The `runId` is minted once in `beforeAll` at line 168 and shared across all cases, so all receipts for one run share the same suffix.

**What breaks if you skip the receipt:** the report has nothing to read. This is why the receipt is written even on partial failures — a judge failure still writes a receipt with a placeholder verdict (`buildJudgmentPlaceholder('judge_error')` at line 101), so the case doesn't silently disappear from the aggregate.

#### Step 2 — usage + cost are computed from the AptKit trace

`eval/run.eval.ts:215`:

```typescript
const diagnosisUsage = summarizeUsage(diagnosisTrace);
const diagnosisCost =
  estimateCost('anthropic', diagnosisUsage, 'claude-sonnet-4-6') ??
  estimateAnthropicCost(diagnosisUsage, 'claude-sonnet-4-6');
```

`summarizeUsage` is from `@aptkit/core` — it walks the `CapabilityEvent[]` trace and sums the `model_usage` events into a single row. `estimateCost` is also aptkit, but it only knows OpenAI pricing (this is called out in `lib/agents/pricing.ts:9`), so the `??` falls through to the Blooming-side Anthropic pricing helper at `lib/agents/pricing.ts:40`.

**What breaks if you skip the pricing fallback:** every Anthropic-based receipt has `costUsd: null`. The report backfills this (see step 4), but the source-of-truth column in the receipt would be missing.

#### Step 3 — the report picks the runId to analyze

`eval/report.eval.ts:201`:

```typescript
function pickRunId(fromEnv: string | undefined): string {
  if (fromEnv) return fromEnv;
  const files = readdirSync(RECEIPTS_DIR).filter((f) => f.endsWith('.json'));
  const runIds = new Set<string>();
  for (const f of files) {
    const m = f.match(/-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d+Z)\.json$/);
    if (m) runIds.add(m[1]);
  }
  if (runIds.size === 0) throw new Error('No receipts found');
  return [...runIds].sort().pop() as string;
}
```

`RUN_ID=<isoDate>` env picks a specific run; unset defaults to the latest. The regex extracts the `runId` suffix from filenames like `01-conversion-drop-mobile-checkout-2026-07-03T04-08-28-644Z.json`.

#### Step 4 — percentile math over the receipts

`eval/report.eval.ts:161`:

```typescript
function percentiles(arr: readonly number[]): { p50, p95, p99, max, mean } {
  if (arr.length === 0) return { p50: 0, p95: 0, p99: 0, max: 0, mean: 0 };
  const sorted = [...arr].sort((a, b) => a - b);
  const pct = (p: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
  const mean = Math.round(sorted.reduce((s, n) => s + n, 0) / sorted.length);
  return { p50: pct(50), p95: pct(95), p99: pct(99), max: sorted[sorted.length - 1], mean };
}
```

Standard nearest-rank percentiles. `Math.min(sorted.length - 1, ...)` guards the last-index case so `p99` on a 10-element array doesn't fall off the end. Not linear interpolation — nearest rank is honest at N=10 (10th case is the max, 5th is p50).

**Load-bearing detail:** at N=10, p95 and p99 are the same value (index 9 = the max). The report prints them both anyway. That's honest — the percentile math doesn't lie about being underdetermined at small N; the reader can tell from the equal numbers.

#### Step 5 — cost backfill for legacy receipts

`eval/report.eval.ts:112`:

```typescript
for (const r of receipts) {
  const d = r.usage?.diagnose;
  const rr = r.usage?.recommend;
  // Backfill cost from tokens when the receipt has null costUsd
  // (older receipts written before the Blooming pricing helper).
  const dCost = d?.costUsd ?? backfillCost(d);
  const rCost = rr?.costUsd ?? backfillCost(rr);
  if (d?.costUsd == null && dCost > 0) backfilledCost++;
  ...
}
```

Older receipts written before `lib/agents/pricing.ts` was added have `costUsd: null`. The report backfills by re-running the same pricing helper against the stored `inputTokens` and `outputTokens`. This is why the `usage` shape is stored verbatim — the tokens are the raw data, the cost is derived.

**Design principle:** store the raw numbers, derive the derived ones. If Anthropic changes pricing tomorrow, one edit to `lib/agents/pricing.ts` re-costs every historical receipt.

```
Layers-and-hops — from receipt to ASCII table

┌─ receipts/*.json ─────┐  hop 1: readdirSync + JSON.parse
│  20+ per run          │ ─────────────────────────────┐
└───────────────────────┘                              │
                                                       ▼
                                        ┌─ pickRunId(env) ────┐
                                        │  find newest        │
                                        └────────┬────────────┘
                                                 │  hop 2: filter files
                                                 ▼
                                        ┌─ per-phase arrays ──┐
                                        │  investigate, judge │
                                        └────────┬────────────┘
                                                 │  hop 3: percentiles(arr)
                                                 ▼
                                        ┌─ backfillCost() ────┐
                                        │  older receipts     │
                                        └────────┬────────────┘
                                                 │  hop 4: console.error
                                                 ▼
                                        ┌─ terminal: ASCII ───┐
                                        │  padStart-aligned   │
                                        └─────────────────────┘
```

### Move 3 — the principle

The load-bearing move is separating measurement from analysis by materializing an intermediate artifact. The receipt is that artifact. Once it exists on disk, you can rerun the analysis, backfill missing columns, compare across runs, feed a gate, or share the receipt with someone else — all without touching the model. This is the same shape as flight-data-recorder analysis: the raw ticks are captured live, the story is told offline.

## Primary diagram — the recap

```
The observability-report pattern — end to end

┌─ Live run (~15-40 min, ~$1.30 for 10 cases) ────────────────────┐
│                                                                  │
│  eval/run.eval.ts:                                               │
│    beforeAll → sharedRunId = <isoDate>                           │
│    it.each(goldens) → per case:                                  │
│      · run diagnostic + judge                                    │
│      · run recommendation + judge                                │
│      · summarizeUsage(trace) + estimateCost/estimateAnthropicCost│
│      · writeFileSync(receipts/<case>-<runId>.json)               │
│    afterAll → per-case verdict table + escape-hatch summary      │
│                                                                  │
└──────────────────────────────┬──────────────────────────────────┘
                               │
                               │  receipts on disk
                               ▼
┌─ Offline analysis (0s, $0) ─────────────────────────────────────┐
│                                                                  │
│  eval/report.eval.ts:                                            │
│    pickRunId(env) → latest by default                            │
│    read all receipts for that runId                              │
│    per-phase percentiles(durations)                              │
│    per-case usage + cost table (backfilled if older receipt)     │
│    per-tool-call latency across all cases                        │
│    print ASCII table to console.error                            │
│                                                                  │
└──────────────────────────────┬──────────────────────────────────┘
                               │
                               ▼
┌─ Baseline + gate (offline, $0) ─────────────────────────────────┐
│                                                                  │
│  eval/baseline.eval.ts:                                          │
│    aggregate one run's receipts into eval/baseline.json          │
│    commit as the frozen truth                                    │
│                                                                  │
│  eval/gate.eval.ts:                                              │
│    compare a fresh run's receipts against baseline               │
│    fail if a dimension regresses beyond threshold                │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

## Elaborate

The receipt-driven pattern comes from batch-pipeline observability. Airflow / dbt / Prefect all write per-task artifacts that a downstream job aggregates; you don't rerun the whole pipeline to change the report. The web-analog is a `.har` file — you record the browser's network trace once, and every analysis is a lens over the same recording.

This repo uses ASCII tables (`console.error` with `padStart`) rather than a real reporting tool. That's on purpose — you're running Vitest as the runner (`npm run eval:report`), and Vitest's terminal output is where the reader already is. A separate dashboard adds latency to the observation, not to the run.

**Adjacent primitive worth naming.** This is a Command-Query Responsibility Segregation split at the file-system layer. The Command side writes receipts (the live eval); the Query side reads them (the report, baseline, gate). The read side is idempotent and cheap; the write side is the one that costs money. Standard shape for anything expensive-and-analytical.

**What to read next.** `04-load-harness-with-fault-injection.md` for a variant of the same pattern applied to load tests — the load harness writes a *single* summary receipt (not per-case), because the aggregate is what you care about at N=20+. `02-per-investigation-budget-ceiling.md` for how the same `usage` data drives the runtime ceiling.

## Interview defense

**Q: Walk me through the observability pipeline. What runs when?**

Three artifacts: per-case receipts, an aggregated baseline, and the report. The live eval writes one JSON receipt per case as it runs — with per-phase timings, token counts, cost, and the judge verdict. The runId is a shared ISO date across all 10 cases so the receipts group. The report is a separate Vitest test — `npm run eval:report` — that reads all receipts for a runId and prints p50/p95/p99/max/mean per phase, plus a per-case cost table. Zero model calls, zero cost. The baseline is one aggregate JSON that gets committed; the gate compares a fresh run against the baseline. The load-bearing move is separating measurement from analysis by materializing the receipt — once it's on disk, you can rerun the analysis or backfill missing columns like cost without touching the model.

```
The anchor diagram to sketch

live run           report              gate
    │                │                    │
    ▼                ▼                    ▼
receipts/*.json → percentiles ← baseline.json
    │                │                    ▲
    │                │                    │
    │                └─ backfill cost ────┘
    │                                     │
    └──────────► aggregate ────────────► frozen
```

**Q: How do you compute percentiles honestly at N=10?**

Nearest rank, not interpolation. `sorted[Math.floor((p / 100) * n)]` for percentile p, clamped to `n - 1`. At N=10, p50 is index 5, p95 is index 9, p99 is index 9 — so p95 and p99 print as the same value. That's honest — the reader can tell we're underdetermined at that N. If I wanted smoother numbers I'd bump N, not switch to interpolation.

**Q: Why store cost as a nullable field in the receipt?**

The tokens are the raw data, the cost is derived. If Anthropic changes pricing tomorrow — which they did between 4.5 and 4.6 — one edit to `lib/agents/pricing.ts` re-costs every historical receipt. The report backfills nulls on the fly. Older receipts written before the pricing helper existed still get costed at read time, and the report emits a note when it did so, so the reader knows the number came from a backfill.

**Q: What's missing from this observability story?**

A real gate on latency — today the gate is on judge verdicts, not on p95 duration. If diagnose p95 climbed from 60s to 200s but every case still passed the judge, the current gate wouldn't catch it. Named for what it isn't, not a fix I'd rush; the p95 latency variance is model-side and would produce noisy false positives at N=10.

## See also

- `02-per-investigation-budget-ceiling.md` — same `usage` data drives the live check.
- `04-load-harness-with-fault-injection.md` — sibling pattern; one summary receipt per load run instead of per-case.
- `audit.md` §2 — measurement-baselines-and-profiling lens finding.
