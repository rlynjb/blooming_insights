// eval/compute-agreement.eval.ts
//
// Session D — user-vs-judge agreement computation.
//
// Reads a FILLED worksheet (yourScores + yourVerdict populated) from
// eval/calibration/worksheet-<runId>.json AND the receipts for the same
// runId. Computes three agreement metrics per the pre-agreed design:
//
//   Verdict agreement       N/M   (user verdict == judge verdict)
//   Exact-match dimensions  N/M   (user score == judge score per dim)
//   Within-1 dimensions     N/M   (|user - judge| ≤ 1 per dim)
//
// Emits eval/calibration/agreement-<runId>.json + a human-readable
// stderr table. This is the receipt that survives interview scrutiny
// ("shipped, calibrated, N/M user-vs-judge agreement across 4 dims").
//
// ─── Pattern: judge calibration / inter-rater agreement ───────────────────
// Validates the JUDGE itself. Compares blind human labels (the worksheet)
// against the judge's scores and reports agreement — verdict match, exact
// dimension match, within-1. This inter-annotator-agreement number is what
// lets you trust an LLM-as-judge at all. Sub-patterns: a fail-closed
// guardrail (refuses partial worksheets, so no misleading partial number),
// and an honesty tag (pilot-ai-vs-ai mode is stamped NOT interview-
// defensible). Pairs with generate-worksheet.eval.ts, which produces the
// blind worksheet this reads.
//
// Usage:
//   npm run eval:agreement
//     → reads the LATEST runId's worksheet by default
//   RUN_ID=2026-07-03T02-47-24-392Z npm run eval:agreement
//
// Guardrail: this script REFUSES to run if the worksheet has any
// null scores/verdicts (user hasn't finished labeling), so we never
// produce a partial-and-misleading agreement number.

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const RECEIPTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'receipts');
const CALIBRATION_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'calibration');

const shouldRun = process.env.RUN_AGREEMENT === '1';

const DIMENSION_IDS = [
  'root_cause_plausibility',
  'evidence_grounding',
  'scope_coherence',
  'actionable_next_step',
] as const;

type Verdict = 'pass' | 'pass_with_notes' | 'fail';
type DimId = (typeof DIMENSION_IDS)[number];

type Worksheet = {
  runId: string;
  /**
   * How the worksheet was labeled. Defaults to 'human' (the interview-
   * defensible mode). If set to 'pilot-ai-vs-ai', the resulting agreement
   * receipt is a pipeline-shape validation, NOT a real calibration number.
   */
  labelerMode?: 'human' | 'pilot-ai-vs-ai';
  cases: Array<{
    caseId: string;
    signalClass: string;
    judgeHasOutput: boolean;
    yourScores: Record<DimId, { score: number | null; note: string }>;
    yourVerdict: { verdict: Verdict | null; note: string };
  }>;
};

type Receipt = {
  case: string;
  signalClass: string;
  diagnosisJudgment: {
    verdict: string;
    dimensions: Record<string, { score: number; reason?: string }>;
  };
};

describe.skipIf(!shouldRun)('eval calibration · compute agreement', () => {
  it('user-vs-judge agreement across 4 dimensions + verdict', () => {
    const runId = pickRunId(process.env.RUN_ID);
    console.log(`[agreement] runId: ${runId}`);

    // ─── read worksheet ─────────────────────────────────────────────────
    const worksheetPath = resolve(CALIBRATION_DIR, `worksheet-${runId}.json`);
    const worksheet = JSON.parse(readFileSync(worksheetPath, 'utf8')) as Worksheet;
    console.log(`[agreement] worksheet: ${worksheetPath}`);
    console.log(`[agreement] cases in worksheet: ${worksheet.cases.length}`);

    // ─── validate: all scores + verdicts filled ─────────────────────────
    const incomplete: string[] = [];
    for (const c of worksheet.cases) {
      for (const dim of DIMENSION_IDS) {
        if (c.yourScores[dim]?.score == null) {
          incomplete.push(`${c.caseId}.${dim}`);
        }
      }
      if (c.yourVerdict.verdict == null) {
        incomplete.push(`${c.caseId}.verdict`);
      }
    }
    if (incomplete.length > 0) {
      throw new Error(
        `Worksheet has ${incomplete.length} unfilled fields. Refusing to compute a partial agreement number. Missing:\n  ${incomplete.slice(0, 20).join('\n  ')}${incomplete.length > 20 ? '\n  …' : ''}`,
      );
    }

    // ─── read receipts ──────────────────────────────────────────────────
    const receipts = new Map<string, Receipt>();
    for (const f of readdirSync(RECEIPTS_DIR).filter((f) => f.endsWith(`${runId}.json`))) {
      const r = JSON.parse(readFileSync(resolve(RECEIPTS_DIR, f), 'utf8')) as Receipt;
      receipts.set(r.case, r);
    }

    // ─── compute agreement ──────────────────────────────────────────────
    let verdictHits = 0;
    let verdictTotal = 0;
    let exactHits = 0;
    let within1Hits = 0;
    let dimTotal = 0;

    type PerDim = { exact: number; within1: number; total: number };
    const perDim: Record<string, PerDim> = {};
    for (const d of DIMENSION_IDS) perDim[d] = { exact: 0, within1: 0, total: 0 };

    type PerCase = {
      caseId: string;
      signalClass: string;
      verdict: { user: Verdict; judge: string | 'no-judge'; agree: boolean | null };
      dims: Record<string, { user: number; judge: number | null; delta: number | null }>;
    };
    const perCase: PerCase[] = [];

    for (const c of worksheet.cases) {
      const receipt = receipts.get(c.caseId);
      const judgeVerdict = receipt?.diagnosisJudgment?.verdict;
      const judgeHasVerdict = judgeVerdict !== undefined && judgeVerdict !== 'judge_error';
      const userVerdict = c.yourVerdict.verdict as Verdict;

      const caseRow: PerCase = {
        caseId: c.caseId,
        signalClass: c.signalClass,
        verdict: {
          user: userVerdict,
          judge: judgeHasVerdict ? (judgeVerdict as string) : 'no-judge',
          agree: judgeHasVerdict ? judgeVerdict === userVerdict : null,
        },
        dims: {},
      };

      if (judgeHasVerdict) {
        verdictTotal++;
        if (judgeVerdict === userVerdict) verdictHits++;
      }

      for (const dim of DIMENSION_IDS) {
        const userScore = c.yourScores[dim].score as number;
        const judgeScore = receipt?.diagnosisJudgment?.dimensions?.[dim]?.score;
        if (judgeScore == null) {
          caseRow.dims[dim] = { user: userScore, judge: null, delta: null };
          continue;
        }
        const delta = userScore - judgeScore;
        caseRow.dims[dim] = { user: userScore, judge: judgeScore, delta };
        dimTotal++;
        perDim[dim].total++;
        if (userScore === judgeScore) {
          exactHits++;
          perDim[dim].exact++;
        }
        if (Math.abs(delta) <= 1) {
          within1Hits++;
          perDim[dim].within1++;
        }
      }

      perCase.push(caseRow);
    }

    // ─── receipt ────────────────────────────────────────────────────────
    const labelerMode = worksheet.labelerMode ?? 'human';
    const agreement = {
      runId,
      computedAt: new Date().toISOString(),
      labelerMode,
      pilotWarning:
        labelerMode === 'pilot-ai-vs-ai'
          ? 'PILOT: labels came from an AI labeler, not a blind human. This receipt validates the compute-agreement pipeline shape but is NOT an interview-defensible calibration number. Both roles (labeler + judge) are Claude with different prompts — this measures rubric self-consistency, not judge-vs-human agreement. Do a real blind human pass before citing.'
          : undefined,
      totals: {
        verdictAgreement: { hits: verdictHits, total: verdictTotal, rate: rate(verdictHits, verdictTotal) },
        exactMatchDimensions: { hits: exactHits, total: dimTotal, rate: rate(exactHits, dimTotal) },
        within1Dimensions: { hits: within1Hits, total: dimTotal, rate: rate(within1Hits, dimTotal) },
      },
      perDimension: perDim,
      perCase,
      casesWithNoJudge: perCase.filter((c) => c.verdict.judge === 'no-judge').map((c) => c.caseId),
    };

    const outPath = resolve(CALIBRATION_DIR, `agreement-${runId}.json`);
    writeFileSync(outPath, JSON.stringify(agreement, null, 2) + '\n', 'utf8');
    console.log(`[agreement] wrote ${outPath}`);

    // ─── stderr summary ──────────────────────────────────────────────────
    console.error('\n╔══════════════════════════════════════════════════════════════════════════════╗');
    if (labelerMode === 'pilot-ai-vs-ai') {
      console.error('║ Session D · PILOT (AI-vs-AI) · NOT interview-defensible                     ║');
    } else {
      console.error('║ Session D · blind calibration · user-vs-judge agreement                     ║');
    }
    console.error('╚══════════════════════════════════════════════════════════════════════════════╝');
    if (labelerMode === 'pilot-ai-vs-ai') {
      console.error(
        '\n⚠  PILOT MODE — labels came from an AI labeler. Both roles are Claude;\n   this measures rubric self-consistency, not judge-vs-human agreement.\n   Do a real blind human pass before citing this number anywhere.',
      );
    }
    console.error(`\nrunId:  ${runId}`);
    console.error(`\nTotals (across the ${verdictTotal} cases with judge output)`);
    console.error('─'.repeat(78));
    console.error(`  Verdict agreement       ${padRate(agreement.totals.verdictAgreement)}`);
    console.error(`  Exact-match dimensions  ${padRate(agreement.totals.exactMatchDimensions)}`);
    console.error(`  Within-1 dimensions     ${padRate(agreement.totals.within1Dimensions)}`);
    console.error(`\nPer-dimension`);
    console.error('─'.repeat(78));
    for (const dim of DIMENSION_IDS) {
      const p = perDim[dim];
      console.error(
        `  ${dim.padEnd(30)}  exact ${String(p.exact).padStart(2)}/${p.total}   within-1 ${String(p.within1).padStart(2)}/${p.total}`,
      );
    }
    console.error('\nPer-case (user | judge · delta per dimension)');
    console.error('─'.repeat(78));
    for (const c of perCase) {
      const verdictLine = `${c.verdict.user} | ${c.verdict.judge}${c.verdict.agree === true ? ' ✓' : c.verdict.agree === false ? ' ✗' : ' —'}`;
      console.error(`  ${c.caseId.padEnd(38)}  ${verdictLine}`);
      const dimLine = DIMENSION_IDS.map((d) => {
        const dd = c.dims[d];
        if (dd.judge == null) return `${d.slice(0, 5)}:${dd.user}|—`;
        return `${d.slice(0, 5)}:${dd.user}|${dd.judge}(${dd.delta! >= 0 ? '+' : ''}${dd.delta})`;
      }).join('  ');
      console.error(`    ${dimLine}`);
    }
    if (agreement.casesWithNoJudge.length > 0) {
      console.error(
        `\nNote: ${agreement.casesWithNoJudge.length} case(s) had no judge output (judge_error):`,
      );
      for (const cid of agreement.casesWithNoJudge) console.error(`  · ${cid}`);
      console.error(
        '  Your labels on these are still valid; they contribute once we re-run with larger max_tokens.',
      );
    }
    console.error('');

    expect(verdictTotal).toBeGreaterThan(0);
  });
});

function rate(hits: number, total: number): number {
  return total === 0 ? 0 : Math.round((hits / total) * 100) / 100;
}
function padRate(r: { hits: number; total: number; rate: number }): string {
  return `${String(r.hits).padStart(3)}/${String(r.total).padEnd(3)}  (${String(Math.round(r.rate * 100)).padStart(3)}%)`;
}

function pickRunId(fromEnv: string | undefined): string {
  if (fromEnv) return fromEnv;
  const files = readdirSync(CALIBRATION_DIR).filter((f) => f.startsWith('worksheet-') && f.endsWith('.json'));
  if (files.length === 0) {
    throw new Error(`No worksheet files found in ${CALIBRATION_DIR}. Run \`npm run eval:worksheet\` first.`);
  }
  const runIds = files.map((f) => f.replace(/^worksheet-|\.json$/g, ''));
  return runIds.sort().pop() as string;
}
