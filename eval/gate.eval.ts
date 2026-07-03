// eval/gate.eval.ts
//
// Phase-5 regression gate. Compares a candidate run's per-criterion pass
// rates against eval/baseline.json (committed reference). Blocks if any
// dimension's pass rate has dropped by more than GATE_MAX_REGRESSION
// (default 0.10 = 10 percentage points).
//
// Wire into CI as: `npm run eval && npm run eval:gate` — the latter
// exits non-zero on regression, which fails the PR check.
//
// Usage:
//   npm run eval:gate
//     → reads eval/baseline.json + LATEST run's receipts
//   RUN_ID=<candidate> npm run eval:gate
//     → uses a specific candidate runId
//   BASELINE_LABEL=v2 npm run eval:gate
//     → reads eval/baseline-v2.json
//   GATE_MAX_REGRESSION=0.05 npm run eval:gate
//     → tighter threshold (5 percentage points)

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { computeBaseline, type Baseline } from './baseline.eval';

const RECEIPTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'receipts');
const EVAL_DIR = dirname(fileURLToPath(import.meta.url));

const shouldRun = process.env.RUN_GATE === '1';

const GATE_MAX_REGRESSION = Number(process.env.GATE_MAX_REGRESSION ?? '0.10');

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

describe.skipIf(!shouldRun)('phase-5 regression gate · candidate vs baseline', () => {
  it('candidate must not regress by more than GATE_MAX_REGRESSION per dim', () => {
    const label = process.env.BASELINE_LABEL ?? '';
    const baselineFile = label ? `baseline-${label}.json` : 'baseline.json';
    const baselinePath = resolve(EVAL_DIR, baselineFile);
    let baseline: Baseline;
    try {
      baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as Baseline;
    } catch {
      throw new Error(
        `Missing baseline at ${baselinePath}. Build one with:  npm run eval:baseline`,
      );
    }

    const candidateRunId = pickRunId(process.env.RUN_ID);
    const files = readdirSync(RECEIPTS_DIR)
      .filter((f) => f.endsWith(`${candidateRunId}.json`))
      .sort();
    if (files.length === 0) throw new Error(`No receipts for candidate runId ${candidateRunId}`);

    const receipts: Receipt[] = files.map(
      (f) => JSON.parse(readFileSync(resolve(RECEIPTS_DIR, f), 'utf8')) as Receipt,
    );
    const candidate = computeBaseline(candidateRunId, receipts);

    const gateResult = evaluateGate(baseline, candidate, GATE_MAX_REGRESSION);

    const outPath = resolve(
      EVAL_DIR,
      `gate-${candidateRunId}.json`,
    );
    writeFileSync(outPath, JSON.stringify(gateResult, null, 2) + '\n', 'utf8');

    printSummary(gateResult, baseline, candidate);

    if (!gateResult.ok) {
      throw new Error(
        `Regression gate FAILED. ${gateResult.blockingDimensions.length} dimension(s) regressed by more than ${GATE_MAX_REGRESSION}. See ${outPath}.`,
      );
    }

    expect(gateResult.ok).toBe(true);
  });
});

type Delta = {
  dimension: string;
  scope: 'diagnosis' | 'recommendation';
  baselinePassRate: number;
  candidatePassRate: number;
  delta: number;
  regressed: boolean;
};

type GateResult = {
  ok: boolean;
  baselineRunId: string;
  candidateRunId: string;
  gateMaxRegression: number;
  deltas: Delta[];
  blockingDimensions: Delta[];
};

function evaluateGate(
  baseline: Baseline,
  candidate: Baseline,
  maxRegression: number,
): GateResult {
  const deltas: Delta[] = [];
  for (const scope of ['diagnosis', 'recommendation'] as const) {
    const b = baseline[scope];
    const c = candidate[scope];
    const dims = new Set([
      ...Object.keys(b.perDimensionPassRate),
      ...Object.keys(c.perDimensionPassRate),
    ]);
    for (const dim of dims) {
      const bRate = b.perDimensionPassRate[dim] ?? 0;
      const cRate = c.perDimensionPassRate[dim] ?? 0;
      const delta = cRate - bRate; // negative = regression
      deltas.push({
        dimension: dim,
        scope,
        baselinePassRate: bRate,
        candidatePassRate: cRate,
        delta,
        regressed: -delta > maxRegression,
      });
    }
  }
  const blockingDimensions = deltas.filter((d) => d.regressed);
  return {
    ok: blockingDimensions.length === 0,
    baselineRunId: baseline.runId,
    candidateRunId: candidate.runId,
    gateMaxRegression: maxRegression,
    deltas,
    blockingDimensions,
  };
}

function printSummary(gate: GateResult, baseline: Baseline, candidate: Baseline): void {
  console.error(`\n╔══════════════════════════════════════════════════════════════════════════════╗`);
  console.error(`║ Phase-5 regression gate                                                     ║`);
  console.error(`╚══════════════════════════════════════════════════════════════════════════════╝`);
  console.error(`\n  Baseline runId:    ${gate.baselineRunId} (${baseline.caseCount} cases)`);
  console.error(`  Candidate runId:   ${gate.candidateRunId} (${candidate.caseCount} cases)`);
  console.error(`  Max allowed drop:  ${gate.gateMaxRegression} (${Math.round(gate.gateMaxRegression * 100)} pp)`);
  console.error(`\n  Per-dimension pass-rate delta (candidate − baseline)`);
  console.error('─'.repeat(78));
  for (const scope of ['diagnosis', 'recommendation'] as const) {
    console.error(`  [${scope}]`);
    for (const d of gate.deltas.filter((x) => x.scope === scope)) {
      const bp = (d.baselinePassRate * 100).toFixed(0);
      const cp = (d.candidatePassRate * 100).toFixed(0);
      const dp = (d.delta * 100).toFixed(0);
      const sign = d.delta >= 0 ? '+' : '';
      const flag = d.regressed ? ' ✗ REGRESSED' : '';
      console.error(
        `    ${d.dimension.padEnd(30)}  base ${bp.padStart(3)}% → cand ${cp.padStart(3)}%   Δ ${sign}${dp}pp${flag}`,
      );
    }
  }
  console.error('');
  console.error(gate.ok ? '  ✓ GATE PASSED' : `  ✗ GATE FAILED — ${gate.blockingDimensions.length} regressed dimension(s)`);
  console.error('');
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
