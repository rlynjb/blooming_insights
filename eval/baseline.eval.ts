// eval/baseline.eval.ts
//
// Phase-5 regression-gate baseline builder. Reads all receipts for a
// given runId and computes per-criterion pass rates + verdict
// distributions across cases; writes eval/baseline.json — the committed
// artifact the regression gate compares candidate runs against.
//
// Usage:
//   npm run eval:baseline
//     → reads the LATEST runId's receipts and writes eval/baseline.json
//   RUN_ID=2026-07-03T04-08-28-644Z npm run eval:baseline
//     → uses a specific runId as the baseline
//   BASELINE_LABEL=v2 npm run eval:baseline
//     → writes eval/baseline-v2.json (multi-baseline workflow later)

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const RECEIPTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'receipts');
const EVAL_DIR = dirname(fileURLToPath(import.meta.url));

const shouldRun = process.env.RUN_BASELINE === '1';

type Receipt = {
  case: string;
  signalClass: string;
  diagnosisJudgment: {
    verdict: string;
    dimensions: Record<string, { score: number }>;
  };
  recommendationJudgments: Array<{
    judgment: {
      verdict: string;
      dimensions: Record<string, { score: number }>;
    };
  }>;
};

describe.skipIf(!shouldRun)('phase-5 baseline · build regression-gate reference', () => {
  it('build baseline.json from a run', () => {
    const runId = pickRunId(process.env.RUN_ID);
    const files = readdirSync(RECEIPTS_DIR)
      .filter((f) => f.endsWith(`${runId}.json`))
      .sort();
    if (files.length === 0) throw new Error(`No receipts for runId ${runId}`);

    const receipts: Receipt[] = files.map(
      (f) => JSON.parse(readFileSync(resolve(RECEIPTS_DIR, f), 'utf8')) as Receipt,
    );

    const baseline = computeBaseline(runId, receipts);

    const label = process.env.BASELINE_LABEL ?? '';
    const filename = label ? `baseline-${label}.json` : 'baseline.json';
    const outPath = resolve(EVAL_DIR, filename);
    writeFileSync(outPath, JSON.stringify(baseline, null, 2) + '\n', 'utf8');
    console.log(`[baseline] wrote ${outPath}`);
    console.log(`[baseline] runId: ${runId}   cases: ${receipts.length}`);
    console.log(`[baseline] diagnosis dims:      ${Object.keys(baseline.diagnosis.perDimensionPassRate).join(', ')}`);
    console.log(`[baseline] verdict distribution: ${JSON.stringify(baseline.diagnosis.verdictDistribution)}`);

    expect(receipts.length).toBeGreaterThan(0);
  });
});

// ─── computation ─────────────────────────────────────────────────────────────

export type Baseline = {
  runId: string;
  builtAt: string;
  caseCount: number;
  diagnosis: DimensionAggregate;
  recommendation: DimensionAggregate;
};

export type DimensionAggregate = {
  /** Fraction of scores ≥ 4 per dimension (0..1). */
  perDimensionPassRate: Record<string, number>;
  /** Count of each score value (1..5) per dimension. */
  perDimensionScoreCounts: Record<string, Record<number, number>>;
  /** Count of each verdict across judgments (pass / pass_with_notes / fail / judge_error). */
  verdictDistribution: Record<string, number>;
};

export function computeBaseline(runId: string, receipts: Receipt[]): Baseline {
  return {
    runId,
    builtAt: new Date().toISOString(),
    caseCount: receipts.length,
    diagnosis: aggregate(receipts.map((r) => [r.diagnosisJudgment])),
    recommendation: aggregate(receipts.map((r) => r.recommendationJudgments.map((rj) => rj.judgment))),
  };
}

function aggregate(perCase: ReadonlyArray<ReadonlyArray<{ verdict: string; dimensions: Record<string, { score: number }> }>>): DimensionAggregate {
  const perDimensionPassRate: Record<string, { pass: number; total: number }> = {};
  const perDimensionScoreCounts: Record<string, Record<number, number>> = {};
  const verdictDistribution: Record<string, number> = {};
  for (const caseJudgments of perCase) {
    for (const j of caseJudgments) {
      verdictDistribution[j.verdict] = (verdictDistribution[j.verdict] ?? 0) + 1;
      for (const [dim, val] of Object.entries(j.dimensions)) {
        perDimensionPassRate[dim] ??= { pass: 0, total: 0 };
        perDimensionPassRate[dim].total += 1;
        if (val.score >= 4) perDimensionPassRate[dim].pass += 1;
        perDimensionScoreCounts[dim] ??= { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
        perDimensionScoreCounts[dim][val.score] = (perDimensionScoreCounts[dim][val.score] ?? 0) + 1;
      }
    }
  }
  const rates: Record<string, number> = {};
  for (const [dim, s] of Object.entries(perDimensionPassRate)) {
    rates[dim] = s.total === 0 ? 0 : s.pass / s.total;
  }
  return { perDimensionPassRate: rates, perDimensionScoreCounts, verdictDistribution };
}

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
