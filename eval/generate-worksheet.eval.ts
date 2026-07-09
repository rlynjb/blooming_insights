// eval/generate-worksheet.eval.ts
//
// Session D — worksheet generator for blind calibration.
//
// Reads the receipts for a given runId and produces
// `eval/calibration/worksheet-<runId>.json` — a file containing each case's
// anomaly + diagnosis, WITHOUT the judgment. The user fills in their own
// scores per dimension + verdict per case, blind to the judge's scores.
// The compute-agreement script then reads the filled worksheet + the
// receipts and computes user-vs-judge agreement.
//
// ─── Pattern: blind-labeling setup (anti-anchoring) ───────────────────────
// Emits a judgment-FREE worksheet (anomaly + diagnosis + blank score slots)
// so the human labels WITHOUT seeing the judge's answer. Deliberately hiding
// the judge output prevents anchoring bias — this is the setup half of the
// calibration loop that compute-agreement.eval.ts closes. Sub-patterns:
// separation-of-concerns (generate vs score are two scripts) and
// script-as-test (describe.skipIf(!RUN_WORKSHEET)).
//
// Usage:
//   npm run eval:worksheet
//     → reads the LATEST runId's receipts by default
//   RUN_ID=2026-07-03T02-47-24-392Z npm run eval:worksheet
//     → uses a specific runId
//
// Runner: vitest via `npm run eval:worksheet` (same eval config;
// generate-worksheet.eval.ts uses `describe.skipIf` or similar so it does
// not run unless explicitly targeted — see the file gating below).

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { diagnosisQualityRubric } from './rubrics/diagnosis-quality';

const RECEIPTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'receipts');
const CALIBRATION_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'calibration');

// Only run this file when explicitly targeted (npm run eval:worksheet).
// The default `npm run eval` will skip it because RUN_WORKSHEET is unset.
const shouldRun = process.env.RUN_WORKSHEET === '1';

describe.skipIf(!shouldRun)('eval calibration · generate blind worksheet', () => {
  it('emit worksheet-<runId>.json', () => {
    const runId = pickRunId(process.env.RUN_ID);
    console.log(`[worksheet] runId: ${runId}`);

    const files = readdirSync(RECEIPTS_DIR)
      .filter((f) => f.endsWith(`${runId}.json`))
      .sort();
    if (files.length === 0) {
      throw new Error(`No receipts found for runId ${runId}`);
    }
    console.log(`[worksheet] receipts found: ${files.length}`);

    type Receipt = {
      case: string;
      signalClass: string;
      intent: string;
      anomaly: unknown;
      diagnosis: unknown;
      diagnosisJudgment?: { verdict: string };
    };

    const cases = files.map((f) => {
      const r = JSON.parse(readFileSync(resolve(RECEIPTS_DIR, f), 'utf8')) as Receipt;
      return {
        caseId: r.case,
        signalClass: r.signalClass,
        intent: r.intent,
        anomaly: r.anomaly,
        diagnosis: r.diagnosis,
        // Non-scoring hint so the user knows which cases don't have judge
        // output to compare against. NOT the judge's actual verdict.
        judgeHasOutput: r.diagnosisJudgment?.verdict !== 'judge_error',
        // The four blanks for the user to fill:
        yourScores: {
          root_cause_plausibility: { score: null as number | null, note: '' },
          evidence_grounding: { score: null as number | null, note: '' },
          scope_coherence: { score: null as number | null, note: '' },
          actionable_next_step: { score: null as number | null, note: '' },
        },
        yourVerdict: {
          verdict: null as null | 'pass' | 'pass_with_notes' | 'fail',
          note: '',
        },
      };
    });

    const worksheet = {
      runId,
      generatedAt: new Date().toISOString(),
      instructions: {
        howTo:
          'Read each case\'s anomaly + diagnosis. Score each of the 4 dimensions 1–5 using the rubric below. Then pick a verdict (pass / pass_with_notes / fail). DO NOT peek at the receipt JSON in eval/receipts/ — the judge\'s scores are only revealed AFTER you submit. Save the file when done. Then run `npm run eval:agreement` to compute judge-vs-you agreement.',
        expectedTime: '~30–60 minutes for 10 cases',
        verdicts: ['pass', 'pass_with_notes', 'fail'],
        dimensionScoreScale: '1 = worst, 5 = best — see rubric.dimensions[*].scale',
        judgeErrorNote:
          'Some cases have judgeHasOutput = false, which means the judge model failed to produce parseable JSON. Score them anyway — your labels are useful once we re-run with a larger max_tokens.',
      },
      rubric: diagnosisQualityRubric,
      cases,
    };

    mkdirSync(CALIBRATION_DIR, { recursive: true });
    const outPath = resolve(CALIBRATION_DIR, `worksheet-${runId}.json`);
    writeFileSync(outPath, JSON.stringify(worksheet, null, 2) + '\n', 'utf8');
    console.log(`[worksheet] wrote ${outPath}`);
    console.log(`[worksheet] ${cases.length} cases to score.`);
    console.log(
      `[worksheet] cases with judge output: ${cases.filter((c) => c.judgeHasOutput).length}/${cases.length}`,
    );
    console.log(`[worksheet] fill in yourScores + yourVerdict, then run:  npm run eval:agreement`);

    expect(cases.length).toBeGreaterThan(0);
  });
});

/**
 * If RUN_ID is set, use it. Otherwise pick the newest runId present in the
 * receipts directory (by lexical sort, which works because ISO timestamps).
 */
function pickRunId(fromEnv: string | undefined): string {
  if (fromEnv) return fromEnv;
  const files = readdirSync(RECEIPTS_DIR).filter((f) => f.endsWith('.json'));
  if (files.length === 0) {
    throw new Error(`No receipts found in ${RECEIPTS_DIR}`);
  }
  // Files look like <caseId>-<runId>.json. Strip the caseId prefix and
  // .json suffix to isolate the runId, then pick the max.
  const runIds = new Set<string>();
  for (const f of files) {
    const m = f.match(/-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d+Z)\.json$/);
    if (m) runIds.add(m[1]);
  }
  if (runIds.size === 0) {
    throw new Error(`Could not parse runId from any receipt filename in ${RECEIPTS_DIR}`);
  }
  return [...runIds].sort().pop() as string;
}
