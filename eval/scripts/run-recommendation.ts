// eval/scripts/run-recommendation.ts
//
// PR F entry point — Path-C-equivalent: bypass detection + diagnosis,
// invoke RecommendationAgent directly on each seeded anomaly's metadata +
// a hand-crafted reference Diagnosis. Run K iterations × 3 anomalies =
// 3K recommendation invocations; judge each with LLM-as-judge.
//
// Usage:
//   npm run eval:recommendation -- --K=10
//
// Cost: ~$2-3 on Anthropic for K=10 (30 agent runs + 30 judge calls).
// Runtime: ~15-25 minutes (sequential, fresh subprocess per agent run).

import Anthropic from '@anthropic-ai/sdk';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

import {
  runRecommendationAgentOnce,
  type RecommendationRunCapture,
} from './lib/run-recommendation-agent';
import { seededToAnomaly } from './lib/anomaly-to-insight';
import {
  judgeRecommendations,
  buildRecJudgeInput,
  isRecJudgeError,
  REC_JUDGE_MODEL,
  type RecJudgeOutput,
  type RecJudgeError,
  type ReferenceRecommendations,
} from './lib/judge-rec';
import type { SeededAnomaly } from './lib/scorer';
import type { Diagnosis } from '../../lib/mcp/types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');

// ---------------------------------------------------------------------------
// .env.local loader (mirrors run-diagnosis.ts).
// ---------------------------------------------------------------------------
function loadEnvLocal(): void {
  const envPath = resolve(REPO_ROOT, '.env.local');
  if (!existsSync(envPath)) return;
  const raw = readFileSync(envPath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && !(key in process.env)) {
      process.env[key] = value;
    }
  }
}
loadEnvLocal();

// ---------------------------------------------------------------------------
// CLI parsing.
// ---------------------------------------------------------------------------
function parseK(): number {
  const arg = process.argv.find((a) => a.startsWith('--K='));
  if (!arg) return 10;
  const n = Number(arg.slice('--K='.length));
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`Invalid --K value: ${arg}`);
  }
  return n;
}

// ---------------------------------------------------------------------------
// Loaders.
// ---------------------------------------------------------------------------
function loadSeededAnomalies(): SeededAnomaly[] {
  const dbPath = resolve(REPO_ROOT, 'mcp-server-olist/data/olist.db');
  if (!existsSync(dbPath)) {
    throw new Error(
      `Olist DB not found at ${dbPath}. Run 'cd mcp-server-olist && npm run seed' first.`,
    );
  }
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db.prepare('SELECT * FROM seeded_anomalies ORDER BY id').all() as SeededAnomaly[];
    return rows;
  } finally {
    db.close();
  }
}

function loadReferenceDiagnosesAsInput(): Record<string, Diagnosis> {
  const p = resolve(REPO_ROOT, 'eval/fixtures/reference-diagnoses-as-input.json');
  if (!existsSync(p)) {
    throw new Error(`Reference diagnoses (as input) not found at ${p}.`);
  }
  const raw = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
  const out: Record<string, Diagnosis> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k === '_meta') continue;
    out[k] = v as Diagnosis;
  }
  return out;
}

function loadReferenceRecommendations(): Record<string, ReferenceRecommendations> {
  const p = resolve(REPO_ROOT, 'eval/fixtures/reference-recommendations.json');
  if (!existsSync(p)) {
    throw new Error(`Reference recommendations not found at ${p}.`);
  }
  const raw = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
  const out: Record<string, ReferenceRecommendations> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k === '_meta') continue;
    out[k] = v as ReferenceRecommendations;
  }
  return out;
}

function loadJudgePrompt(): string {
  const p = resolve(REPO_ROOT, 'eval/judges/recommendation-judge.md');
  if (!existsSync(p)) {
    throw new Error(`Judge prompt not found at ${p}.`);
  }
  return readFileSync(p, 'utf8');
}

// ---------------------------------------------------------------------------
// Results dir — EVAL_RUN_TAG honored (matches PR D / PR E pattern).
// ---------------------------------------------------------------------------
function makeResultsDir(): { dir: string; date: string } {
  const today = new Date();
  const date = today.toISOString().slice(0, 10);
  const tag = process.env.EVAL_RUN_TAG;
  const dirName = tag ? `${date}-${tag}` : date;
  const dir = resolve(REPO_ROOT, 'eval/results', dirName);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return { dir, date };
}

// ---------------------------------------------------------------------------
// Aggregation types.
// ---------------------------------------------------------------------------
interface PerRunRecord {
  runIndex: number;
  anomalyId: string;
  durationMs: number;
  agentError?: string;
  judge: RecJudgeOutput | RecJudgeError;
}

interface CriterionMeans {
  plausible: number;
  specific: number;
  impact_sized: number;
}

interface PerAnomalyAggregate {
  total_runs: number;
  passed: number;
  errored_judge: number;
  errored_agent: number;
  pass_rate: number;
  mean_total: number;
  criterion_means: CriterionMeans;
}

interface OverallAggregate {
  total_runs: number;
  passed: number;
  errored_judge: number;
  errored_agent: number;
  pass_rate_mean: number;
  mean_total: number;
  criterion_means: CriterionMeans;
}

function aggregatePerAnomaly(runs: PerRunRecord[]): PerAnomalyAggregate {
  const totals: number[] = [];
  const crit = {
    plausible: [] as number[],
    specific: [] as number[],
    impact_sized: [] as number[],
  };
  let passed = 0;
  let erroredJudge = 0;
  let erroredAgent = 0;

  for (const r of runs) {
    if (r.agentError) {
      erroredAgent++;
      continue;
    }
    if (isRecJudgeError(r.judge)) {
      erroredJudge++;
      continue;
    }
    totals.push(r.judge.total);
    crit.plausible.push(r.judge.scores.plausible);
    crit.specific.push(r.judge.scores.specific);
    crit.impact_sized.push(r.judge.scores.impact_sized);
    if (r.judge.pass) passed++;
  }

  const successful = totals.length;
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

  return {
    total_runs: runs.length,
    passed,
    errored_judge: erroredJudge,
    errored_agent: erroredAgent,
    pass_rate: successful === 0 ? 0 : passed / successful,
    mean_total: mean(totals),
    criterion_means: {
      plausible: mean(crit.plausible),
      specific: mean(crit.specific),
      impact_sized: mean(crit.impact_sized),
    },
  };
}

function aggregateOverall(runs: PerRunRecord[]): OverallAggregate {
  const totals: number[] = [];
  const crit = {
    plausible: [] as number[],
    specific: [] as number[],
    impact_sized: [] as number[],
  };
  let passed = 0;
  let erroredJudge = 0;
  let erroredAgent = 0;

  for (const r of runs) {
    if (r.agentError) {
      erroredAgent++;
      continue;
    }
    if (isRecJudgeError(r.judge)) {
      erroredJudge++;
      continue;
    }
    totals.push(r.judge.total);
    crit.plausible.push(r.judge.scores.plausible);
    crit.specific.push(r.judge.scores.specific);
    crit.impact_sized.push(r.judge.scores.impact_sized);
    if (r.judge.pass) passed++;
  }

  const successful = totals.length;
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

  return {
    total_runs: runs.length,
    passed,
    errored_judge: erroredJudge,
    errored_agent: erroredAgent,
    pass_rate_mean: successful === 0 ? 0 : passed / successful,
    mean_total: mean(totals),
    criterion_means: {
      plausible: mean(crit.plausible),
      specific: mean(crit.specific),
      impact_sized: mean(crit.impact_sized),
    },
  };
}

// ---------------------------------------------------------------------------
// Markdown summary renderer (mirrors diagnosis-summary.md shape).
// ---------------------------------------------------------------------------
function renderSummaryMd(args: {
  date: string;
  K: number;
  judgeModel: string;
  overall: OverallAggregate;
  perAnomaly: Record<string, PerAnomalyAggregate>;
  anomalyOrder: string[];
  totalRuntimeSec: number;
  spotCheck?: { reviewed: number; agreement_rate: number; notes: string };
}): string {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const num = (x: number) => x.toFixed(2);

  const perAnomalyRows = args.anomalyOrder
    .map((id) => {
      const a = args.perAnomaly[id];
      return `| ${id} | ${a.passed}/${a.total_runs} (${pct(a.pass_rate)}) | ${num(a.mean_total)} |`;
    })
    .join('\n');

  const erroredLine =
    args.overall.errored_agent + args.overall.errored_judge > 0
      ? `\nErrored runs: ${args.overall.errored_agent} agent + ${args.overall.errored_judge} judge (excluded from aggregate)`
      : '';

  const spotCheckSection = args.spotCheck
    ? `## Spot-check (judge calibration)\n\nReviewed ${args.spotCheck.reviewed} judge outputs manually (random sample):\n  - Agreement with manual scoring: ${pct(args.spotCheck.agreement_rate)}\n  - Notes: ${args.spotCheck.notes}\n`
    : `## Spot-check (judge calibration)\n\n_Reviewed manually after this run — see spot-check section appended below._\n`;

  const mins = Math.floor(args.totalRuntimeSec / 60);
  const secs = Math.round(args.totalRuntimeSec % 60).toString().padStart(2, '0');

  return `# Recommendation eval — ${args.date} (K=${args.K})

Run with Sonnet 4.6 (agent + judge), OlistDataSource live. Path-C-equivalent: recommendation agent invoked directly on each seeded anomaly's metadata + a hand-crafted reference diagnosis, bypassing upstream detection + diagnosis stages.${erroredLine}

## Aggregate

| Metric                | Value           |
|---|---|
| Pass rate (mean)      | ${pct(args.overall.pass_rate_mean)} |
| Mean total score      | ${num(args.overall.mean_total)} / 5 |
| Per-criterion (mean)  | |
|   plausible           | ${num(args.overall.criterion_means.plausible)} / 2 |
|   specific            | ${num(args.overall.criterion_means.specific)} / 2 |
|   impact_sized        | ${num(args.overall.criterion_means.impact_sized)} / 1 |

## Per anomaly

| Anomaly                | Pass rate | Mean score |
|---|---|---|
${perAnomalyRows}

${spotCheckSection}

Judge model: ${args.judgeModel}
Total runtime: ${mins}:${secs}
`;
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY not set. Add it to .env.local and re-run.');
    process.exit(1);
  }

  const K = parseK();
  const seededAnomalies = loadSeededAnomalies();
  if (seededAnomalies.length === 0) {
    console.error('No seeded anomalies in DB. Re-seed mcp-server-olist.');
    process.exit(1);
  }
  const inputDiagnoses = loadReferenceDiagnosesAsInput();
  const referenceRecommendations = loadReferenceRecommendations();
  const judgePromptText = loadJudgePrompt();
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // Verify every seeded anomaly has BOTH an input diagnosis AND a reference
  // recommendations entry — fail loud at the top rather than mid-run.
  for (const a of seededAnomalies) {
    if (!inputDiagnoses[a.id]) {
      console.error(`Missing input diagnosis for seeded anomaly id: ${a.id}`);
      process.exit(1);
    }
    if (!referenceRecommendations[a.id]) {
      console.error(`Missing reference recommendations for seeded anomaly id: ${a.id}`);
      process.exit(1);
    }
  }

  console.log(
    `[recommendation] starting K=${K} runs × ${seededAnomalies.length} anomalies = ${K * seededAnomalies.length} agent invocations`,
  );
  console.log(`[recommendation] anomalies: ${seededAnomalies.map((a) => a.id).join(', ')}`);
  console.log(`[recommendation] judge model: ${REC_JUDGE_MODEL}`);

  const t0 = Date.now();
  const sessionPrefix = `eval-recommendation-${Date.now()}`;
  const allRecords: PerRunRecord[] = [];
  // Capture the agent outputs separately from the judge outputs (mirrors
  // PR E's diagnosis-K10-candidates.json + diagnosis-K10-judge.json shape).
  const candidateCaptures: RecommendationRunCapture[] = [];

  for (const seeded of seededAnomalies) {
    const inputAnomaly = seededToAnomaly(seeded);
    const inputDiagnosis = inputDiagnoses[seeded.id];
    const reference = referenceRecommendations[seeded.id];

    for (let i = 1; i <= K; i++) {
      const sessionId = `${sessionPrefix}-${seeded.id}-run${i}`;
      const capture = await runRecommendationAgentOnce(
        i,
        seeded.id,
        inputAnomaly,
        inputDiagnosis,
        sessionId,
      );
      candidateCaptures.push(capture);

      let judge: RecJudgeOutput | RecJudgeError;
      let agentError = capture.error;
      if (capture.error || capture.recommendations == null) {
        // Don't waste a judge call when the agent didn't produce anything.
        agentError = capture.error ?? 'no_recommendations_emitted';
        judge = {
          judge_error: 'agent did not produce recommendations; judge skipped',
          raw_response: '',
          attempts: 0,
        };
      } else {
        const judgeInput = buildRecJudgeInput(
          seeded,
          inputDiagnosis,
          reference,
          capture.recommendations,
        );
        try {
          judge = await judgeRecommendations(anthropic, judgeInput, judgePromptText);
        } catch (err) {
          judge = {
            judge_error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
            raw_response: '',
            attempts: 0,
          };
        }
      }

      const record: PerRunRecord = {
        runIndex: i,
        anomalyId: seeded.id,
        durationMs: capture.durationMs,
        agentError,
        judge,
      };
      allRecords.push(record);

      // Per-run progress log
      const durSec = (capture.durationMs / 1000).toFixed(0);
      if (agentError) {
        console.log(
          `[K=${K}] ${seeded.id} ${i}/${K}: AGENT_ERROR (${durSec}s) → ${agentError}`,
        );
      } else if (isRecJudgeError(judge)) {
        console.log(
          `[K=${K}] ${seeded.id} ${i}/${K}: JUDGE_ERROR (${durSec}s) → ${judge.judge_error}`,
        );
      } else {
        const s = judge.scores;
        const pass = judge.pass ? 'PASS' : 'FAIL';
        console.log(
          `[K=${K}] ${seeded.id} ${i}/${K} (${durSec}s): pl=${s.plausible} sp=${s.specific} im=${s.impact_sized} total=${judge.total} ${pass}`,
        );
      }
    }
  }

  const totalRuntimeSec = (Date.now() - t0) / 1000;

  // Aggregate.
  const perAnomaly: Record<string, PerAnomalyAggregate> = {};
  for (const seeded of seededAnomalies) {
    const runs = allRecords.filter((r) => r.anomalyId === seeded.id);
    perAnomaly[seeded.id] = aggregatePerAnomaly(runs);
  }
  const overall = aggregateOverall(allRecords);

  // Write to disk.
  const { dir, date } = makeResultsDir();

  // judge outputs (per-run)
  writeFileSync(
    resolve(dir, `recommendation-K${K}-judge.json`),
    JSON.stringify(
      {
        K,
        date,
        judge_model: REC_JUDGE_MODEL,
        runs: allRecords.map((r) => ({
          runIndex: r.runIndex,
          anomalyId: r.anomalyId,
          durationMs: r.durationMs,
          agentError: r.agentError,
          judge: r.judge,
        })),
      },
      null,
      2,
    ),
  );

  // candidates: agent outputs + tool transcripts + the diagnosis it consumed
  // (the raw audit dump — feeds manual spot-checks).
  writeFileSync(
    resolve(dir, `recommendation-K${K}-candidates.json`),
    JSON.stringify(
      {
        K,
        date,
        sessionPrefix,
        runs: candidateCaptures.map((c) => ({
          runIndex: c.runIndex,
          anomalyId: c.anomalyId,
          durationMs: c.durationMs,
          inputAnomaly: c.inputAnomaly,
          inputDiagnosis: c.inputDiagnosis,
          recommendations: c.recommendations,
          toolCalls: c.toolCalls.map((tc) => ({
            id: tc.id,
            toolName: tc.toolName,
            args: tc.args,
            result: tc.result,
            error: tc.error,
            durationMs: tc.durationMs,
          })),
          reasoning: c.reasoning,
          error: c.error,
        })),
      },
      null,
      2,
    ),
  );

  // summary aggregate
  writeFileSync(
    resolve(dir, `recommendation-K${K}-summary.json`),
    JSON.stringify(
      {
        K,
        date,
        judge_model: REC_JUDGE_MODEL,
        total_runtime_seconds: totalRuntimeSec,
        overall,
        per_anomaly: perAnomaly,
      },
      null,
      2,
    ),
  );

  // human-readable scorecard
  const md = renderSummaryMd({
    date,
    K,
    judgeModel: REC_JUDGE_MODEL,
    overall,
    perAnomaly,
    anomalyOrder: seededAnomalies.map((a) => a.id),
    totalRuntimeSec,
  });
  writeFileSync(resolve(dir, 'recommendation-summary.md'), md);

  console.log('');
  console.log(`[recommendation] wrote results to ${dir}`);
  console.log('');
  console.log(md);
}

main().catch((err) => {
  console.error('[recommendation] fatal:', err);
  process.exit(1);
});
