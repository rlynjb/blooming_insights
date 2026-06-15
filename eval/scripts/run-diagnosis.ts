// eval/scripts/run-diagnosis.ts
//
// PR E entry point — Path C: bypass detection, invoke DiagnosticAgent
// directly on each seeded anomaly's metadata. Run K iterations × 3 anomalies
// = 3K diagnostic invocations; judge each with LLM-as-judge.
//
// Usage:
//   npm run eval:diagnosis -- --K=10
//
// Cost: ~$3-5 on Anthropic for K=10 (30 agent runs + 30 judge calls).
// Runtime: ~15-30 minutes (sequential, fresh subprocess per agent run).

import Anthropic from '@anthropic-ai/sdk';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

import { runDiagnosticAgentOnce, type DiagnosticRunCapture } from './lib/run-diagnostic-agent';
import { seededToAnomaly } from './lib/anomaly-to-insight';
import {
  judgeDiagnosis,
  buildJudgeInput,
  isJudgeError,
  JUDGE_MODEL,
  type JudgeOutput,
  type JudgeError,
  type ReferenceDiagnosis,
} from './lib/judge';
import type { SeededAnomaly } from './lib/scorer';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');

// ---------------------------------------------------------------------------
// .env.local loader (mirrors run-detection.ts).
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

function loadReferenceDiagnoses(): Record<string, ReferenceDiagnosis> {
  const p = resolve(REPO_ROOT, 'eval/fixtures/reference-diagnoses.json');
  if (!existsSync(p)) {
    throw new Error(`Reference diagnoses not found at ${p}.`);
  }
  const raw = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
  // Drop _meta — only keyed anomaly entries are valid references.
  const out: Record<string, ReferenceDiagnosis> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k === '_meta') continue;
    out[k] = v as ReferenceDiagnosis;
  }
  return out;
}

function loadJudgePrompt(): string {
  const p = resolve(REPO_ROOT, 'eval/judges/diagnosis-judge.md');
  if (!existsSync(p)) {
    throw new Error(`Judge prompt not found at ${p}.`);
  }
  return readFileSync(p, 'utf8');
}

// ---------------------------------------------------------------------------
// Results dir — EVAL_RUN_TAG honored (matches PR D's pattern).
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
  judge: JudgeOutput | JudgeError;
}

interface CriterionMeans {
  hypothesis: number;
  evidence: number;
  sizing: number;
  calibration: number;
  fabrication: number;
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
    hypothesis: [] as number[],
    evidence: [] as number[],
    sizing: [] as number[],
    calibration: [] as number[],
    fabrication: [] as number[],
  };
  let passed = 0;
  let erroredJudge = 0;
  let erroredAgent = 0;

  for (const r of runs) {
    if (r.agentError) {
      erroredAgent++;
      continue;
    }
    if (isJudgeError(r.judge)) {
      erroredJudge++;
      continue;
    }
    totals.push(r.judge.total);
    crit.hypothesis.push(r.judge.scores.hypothesis);
    crit.evidence.push(r.judge.scores.evidence);
    crit.sizing.push(r.judge.scores.sizing);
    crit.calibration.push(r.judge.scores.calibration);
    crit.fabrication.push(r.judge.scores.fabrication);
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
      hypothesis: mean(crit.hypothesis),
      evidence: mean(crit.evidence),
      sizing: mean(crit.sizing),
      calibration: mean(crit.calibration),
      fabrication: mean(crit.fabrication),
    },
  };
}

function aggregateOverall(runs: PerRunRecord[]): OverallAggregate {
  const totals: number[] = [];
  const crit = {
    hypothesis: [] as number[],
    evidence: [] as number[],
    sizing: [] as number[],
    calibration: [] as number[],
    fabrication: [] as number[],
  };
  let passed = 0;
  let erroredJudge = 0;
  let erroredAgent = 0;

  for (const r of runs) {
    if (r.agentError) {
      erroredAgent++;
      continue;
    }
    if (isJudgeError(r.judge)) {
      erroredJudge++;
      continue;
    }
    totals.push(r.judge.total);
    crit.hypothesis.push(r.judge.scores.hypothesis);
    crit.evidence.push(r.judge.scores.evidence);
    crit.sizing.push(r.judge.scores.sizing);
    crit.calibration.push(r.judge.scores.calibration);
    crit.fabrication.push(r.judge.scores.fabrication);
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
      hypothesis: mean(crit.hypothesis),
      evidence: mean(crit.evidence),
      sizing: mean(crit.sizing),
      calibration: mean(crit.calibration),
      fabrication: mean(crit.fabrication),
    },
  };
}

// ---------------------------------------------------------------------------
// Markdown summary renderer.
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

  return `# Diagnosis eval — ${args.date} (K=${args.K})

Run with Sonnet 4.6 (agent + judge), OlistDataSource live. Path C: diagnostic agent invoked directly on each seeded anomaly's metadata, bypassing upstream detection.${erroredLine}

## Aggregate

| Metric                 | Value           |
|---|---|
| Pass rate (mean)       | ${pct(args.overall.pass_rate_mean)} |
| Mean total score       | ${num(args.overall.mean_total)} / 9 |
| Per-criterion (mean)   | |
|   hypothesis           | ${num(args.overall.criterion_means.hypothesis)} / 2 |
|   evidence             | ${num(args.overall.criterion_means.evidence)} / 2 |
|   sizing               | ${num(args.overall.criterion_means.sizing)} / 2 |
|   calibration          | ${num(args.overall.criterion_means.calibration)} / 1 |
|   fabrication          | ${num(args.overall.criterion_means.fabrication)} / 2 |

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
  const referenceDiagnoses = loadReferenceDiagnoses();
  const judgePromptText = loadJudgePrompt();
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // Verify every seeded anomaly has a reference + multiplier.
  for (const a of seededAnomalies) {
    if (!referenceDiagnoses[a.id]) {
      console.error(`Missing reference diagnosis for seeded anomaly id: ${a.id}`);
      process.exit(1);
    }
  }

  console.log(
    `[diagnosis] starting K=${K} runs × ${seededAnomalies.length} anomalies = ${K * seededAnomalies.length} agent invocations`,
  );
  console.log(`[diagnosis] anomalies: ${seededAnomalies.map((a) => a.id).join(', ')}`);
  console.log(`[diagnosis] judge model: ${JUDGE_MODEL}`);

  const t0 = Date.now();
  const sessionPrefix = `eval-diagnosis-${Date.now()}`;
  const allRecords: PerRunRecord[] = [];
  // Capture the agent outputs separately from the judge outputs (per the spec
  // — diagnosis-K10-candidates.json + diagnosis-K10-judge.json).
  const candidateCaptures: DiagnosticRunCapture[] = [];

  for (const seeded of seededAnomalies) {
    const inputAnomaly = seededToAnomaly(seeded);
    const reference = referenceDiagnoses[seeded.id];

    for (let i = 1; i <= K; i++) {
      const sessionId = `${sessionPrefix}-${seeded.id}-run${i}`;
      const capture = await runDiagnosticAgentOnce(i, seeded.id, inputAnomaly, sessionId);
      candidateCaptures.push(capture);

      let judge: JudgeOutput | JudgeError;
      let agentError = capture.error;
      if (capture.error || !capture.diagnosis) {
        // Don't waste a judge call when the agent didn't produce a diagnosis.
        agentError = capture.error ?? 'no_diagnosis_emitted';
        judge = {
          judge_error: 'agent did not produce a diagnosis; judge skipped',
          raw_response: '',
          attempts: 0,
        };
      } else {
        const judgeInput = buildJudgeInput(seeded, reference, capture.diagnosis, capture.toolCalls);
        try {
          judge = await judgeDiagnosis(anthropic, judgeInput, judgePromptText);
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
      } else if (isJudgeError(judge)) {
        console.log(
          `[K=${K}] ${seeded.id} ${i}/${K}: JUDGE_ERROR (${durSec}s) → ${judge.judge_error}`,
        );
      } else {
        const s = judge.scores;
        const pass = judge.pass ? 'PASS' : 'FAIL';
        console.log(
          `[K=${K}] ${seeded.id} ${i}/${K} (${durSec}s): hyp=${s.hypothesis} ev=${s.evidence} sz=${s.sizing} cal=${s.calibration} fab=${s.fabrication} total=${judge.total} ${pass}`,
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
    resolve(dir, `diagnosis-K${K}-judge.json`),
    JSON.stringify(
      {
        K,
        date,
        judge_model: JUDGE_MODEL,
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

  // candidates: agent outputs + tool transcripts (the raw audit dump)
  writeFileSync(
    resolve(dir, `diagnosis-K${K}-candidates.json`),
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
          diagnosis: c.diagnosis,
          // Drop tool result bodies that are >8KB to keep the file readable;
          // keep args + result for everything else. The judge JSON already has
          // truncated transcripts; this file is the SOURCE for manual spot-checks.
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
    resolve(dir, `diagnosis-K${K}-summary.json`),
    JSON.stringify(
      {
        K,
        date,
        judge_model: JUDGE_MODEL,
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
    judgeModel: JUDGE_MODEL,
    overall,
    perAnomaly,
    anomalyOrder: seededAnomalies.map((a) => a.id),
    totalRuntimeSec,
  });
  writeFileSync(resolve(dir, 'diagnosis-summary.md'), md);

  console.log('');
  console.log(`[diagnosis] wrote results to ${dir}`);
  console.log('');
  console.log(md);
}

main().catch((err) => {
  console.error('[diagnosis] fatal:', err);
  process.exit(1);
});
