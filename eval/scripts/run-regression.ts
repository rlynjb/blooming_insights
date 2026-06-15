// eval/scripts/run-regression.ts
//
// PR G entry point — regression eval against 10 golden fixtures. Two modes:
//
//   npm run eval:regression -- --capture   capture golden outputs (first time
//                                          per fixture, or refresh after a
//                                          known-correct prompt change)
//   npm run eval:regression                score new outputs against the
//                                          stored goldens (structural diff +
//                                          similarity judge)
//
// Different infrastructure from PRs D/E/F: no K iterations (K=1 per fixture,
// always), no rubric (similarity judge returns yes/no + confidence), separate
// run-* drivers per agent type.
//
// Cost: ~$1-2 per full score run (10 fixtures × 1 agent call × 1 judge call
// for the 9 non-intent fixtures + 1 cheap Haiku call). Runtime: ~5-10 minutes.

import Anthropic from '@anthropic-ai/sdk';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runMonitoringAgentOnce, type AgentRunCapture } from './lib/run-agent';
import {
  runDiagnosticAgentOnce,
  type DiagnosticRunCapture,
} from './lib/run-diagnostic-agent';
import {
  runRecommendationAgentOnce,
  type RecommendationRunCapture,
} from './lib/run-recommendation-agent';
import { runQueryAgentOnce, type QueryRunCapture } from './lib/run-query-agent';
import { runIntentAgentOnce, type IntentRunCapture } from './lib/run-intent-agent';
import {
  judgeSimilarity,
  isSimilarityJudgeError,
  SIMILARITY_JUDGE_MODEL,
  type SimilarityJudgeOutput,
  type SimilarityJudgeError,
} from './lib/similarity-judge';
import { structuralDiff, type StructuralDiffResult } from './lib/structural-diff';
import type { Anomaly, Diagnosis } from '../../lib/mcp/types';
import type { Intent } from '../../lib/agents/intent';

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
const CAPTURE_MODE = process.argv.includes('--capture');

// ---------------------------------------------------------------------------
// Types — local to the regression driver, not exported.
// ---------------------------------------------------------------------------
type AgentKind = 'monitoring' | 'diagnostic' | 'recommendation' | 'query' | 'intent';

interface Fixture {
  id: string;
  agent: AgentKind;
  description?: string;
  input: Record<string, unknown>;
  golden_output: unknown;
  captured_at: string | null;
  captured_with: {
    model: string;
    prompt_hash: string | null;
    notes?: string;
  };
  scoring_config: {
    structural_required_fields: string[];
    structural_strict: boolean;
    similarity_threshold: number;
    notes?: string;
  };
}

interface PerFixtureScore {
  id: string;
  agent: AgentKind;
  structural: StructuralDiffResult;
  similarity: SimilarityJudgeOutput | SimilarityJudgeError;
  structural_pass: boolean;
  semantic_pass: boolean;
  overall_pass: boolean;
  agent_error?: string;
  duration_ms: number;
}

// ---------------------------------------------------------------------------
// Loaders.
// ---------------------------------------------------------------------------
function loadFixtures(): Fixture[] {
  const dir = resolve(REPO_ROOT, 'eval/fixtures/regression-golden');
  if (!existsSync(dir)) {
    throw new Error(`Regression-golden fixtures dir not found at ${dir}.`);
  }
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort();
  const out: Fixture[] = [];
  for (const f of files) {
    const raw = readFileSync(resolve(dir, f), 'utf8');
    out.push(JSON.parse(raw) as Fixture);
  }
  return out;
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

function loadSimilarityJudgePrompt(): string {
  const p = resolve(REPO_ROOT, 'eval/judges/similarity-judge.md');
  if (!existsSync(p)) {
    throw new Error(`Similarity judge prompt not found at ${p}.`);
  }
  return readFileSync(p, 'utf8');
}

/** Hash a prompt file's content so the captured fixture records which prompt
 *  version produced the golden. Helps diagnose "the eval re-run failed because
 *  the prompt changed under us" cases. */
function promptHash(agent: AgentKind): string {
  const map: Record<AgentKind, string | null> = {
    monitoring: 'lib/agents/prompts/monitoring.md',
    diagnostic: 'lib/agents/prompts/diagnostic.md',
    recommendation: 'lib/agents/prompts/recommendation.md',
    query: 'lib/agents/prompts/query.md',
    intent: null, // classifier prompt is inline in intent.ts; hash that file instead
  };
  const relPath = map[agent] ?? 'lib/agents/intent.ts';
  const abs = resolve(REPO_ROOT, relPath);
  const content = readFileSync(abs, 'utf8');
  return 'sha256:' + createHash('sha256').update(content).digest('hex');
}

// ---------------------------------------------------------------------------
// Results dir — EVAL_RUN_TAG honored (matches PRs D/E/F).
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
// Per-fixture run dispatcher.
// ---------------------------------------------------------------------------
async function runFixture(
  fixture: Fixture,
  inputDiagnoses: Record<string, Diagnosis>,
  sessionId: string,
): Promise<{ output: unknown; error?: string; durationMs: number; capture: unknown }> {
  const start = Date.now();

  if (fixture.agent === 'monitoring') {
    const cap: AgentRunCapture = await runMonitoringAgentOnce(1, sessionId);
    return {
      output: cap.insights,
      error: cap.error,
      durationMs: cap.durationMs,
      capture: cap,
    };
  }

  if (fixture.agent === 'diagnostic') {
    const anomaly = (fixture.input as { anomaly: Anomaly }).anomaly;
    const anomalyId = (fixture.input as { anomalyId: string }).anomalyId;
    const cap: DiagnosticRunCapture = await runDiagnosticAgentOnce(
      1,
      anomalyId,
      anomaly,
      sessionId,
    );
    return {
      output: cap.diagnosis,
      error: cap.error,
      durationMs: cap.durationMs,
      capture: cap,
    };
  }

  if (fixture.agent === 'recommendation') {
    const anomaly = (fixture.input as { anomaly: Anomaly }).anomaly;
    const anomalyId = (fixture.input as { anomalyId: string }).anomalyId;
    const diagnosis = inputDiagnoses[anomalyId];
    if (!diagnosis) {
      const ms = Date.now() - start;
      return {
        output: null,
        error: `No input Diagnosis found for anomalyId=${anomalyId} in reference-diagnoses-as-input.json`,
        durationMs: ms,
        capture: null,
      };
    }
    const cap: RecommendationRunCapture = await runRecommendationAgentOnce(
      1,
      anomalyId,
      anomaly,
      diagnosis,
      sessionId,
    );
    return {
      output: cap.recommendations,
      error: cap.error,
      durationMs: cap.durationMs,
      capture: cap,
    };
  }

  if (fixture.agent === 'query') {
    const query = (fixture.input as { query: string }).query;
    const intent = (fixture.input as { intent: Intent }).intent;
    const cap: QueryRunCapture = await runQueryAgentOnce(1, query, intent, sessionId);
    return {
      output: cap.answer,
      error: cap.error,
      durationMs: cap.durationMs,
      capture: cap,
    };
  }

  if (fixture.agent === 'intent') {
    const query = (fixture.input as { query: string }).query;
    const cap: IntentRunCapture = await runIntentAgentOnce(1, query, sessionId);
    return {
      output: cap.intent,
      error: cap.error,
      durationMs: cap.durationMs,
      capture: cap,
    };
  }

  // Unreachable per the AgentKind union, but the runtime catches a malformed
  // fixture file rather than crashing the whole regression run.
  return {
    output: null,
    error: `Unknown agent kind: ${String(fixture.agent)}`,
    durationMs: Date.now() - start,
    capture: null,
  };
}

// ---------------------------------------------------------------------------
// Capture mode: write golden outputs back to the fixture files.
// ---------------------------------------------------------------------------
async function captureMode(): Promise<void> {
  const fixtures = loadFixtures();
  const inputDiagnoses = loadReferenceDiagnosesAsInput();

  console.log(
    `[regression:capture] capturing ${fixtures.length} fixture golden outputs`,
  );

  const sessionPrefix = `eval-regression-capture-${Date.now()}`;
  const captureSummary: Array<{
    id: string;
    agent: AgentKind;
    captured: boolean;
    error?: string;
    duration_ms: number;
    output_bytes: number;
  }> = [];

  for (const fixture of fixtures) {
    const sessionId = `${sessionPrefix}-${fixture.id}`;
    console.log(`[capture] ${fixture.id} (${fixture.agent})…`);
    const { output, error, durationMs } = await runFixture(fixture, inputDiagnoses, sessionId);

    if (error) {
      console.log(`  AGENT_ERROR (${(durationMs / 1000).toFixed(0)}s): ${error}`);
      captureSummary.push({
        id: fixture.id,
        agent: fixture.agent,
        captured: false,
        error,
        duration_ms: durationMs,
        output_bytes: 0,
      });
      continue;
    }

    // Stamp the fixture file with the new golden.
    const now = new Date().toISOString();
    const hash = promptHash(fixture.agent);
    const updated: Fixture = {
      ...fixture,
      golden_output: output,
      captured_at: now,
      captured_with: {
        ...fixture.captured_with,
        prompt_hash: hash,
      },
    };
    const fp = resolve(REPO_ROOT, 'eval/fixtures/regression-golden', `${fixture.id}.json`);
    writeFileSync(fp, JSON.stringify(updated, null, 2) + '\n');

    const bytes = JSON.stringify(output).length;
    console.log(
      `  CAPTURED (${(durationMs / 1000).toFixed(0)}s, ${bytes}B) → ${fp}`,
    );
    captureSummary.push({
      id: fixture.id,
      agent: fixture.agent,
      captured: true,
      duration_ms: durationMs,
      output_bytes: bytes,
    });
  }

  // Write a capture-summary alongside the results dir so a later score-mode run
  // can see what was captured + when.
  const { dir, date } = makeResultsDir();
  writeFileSync(
    resolve(dir, 'regression-capture-summary.json'),
    JSON.stringify(
      {
        mode: 'capture',
        date,
        sessionPrefix,
        captures: captureSummary,
      },
      null,
      2,
    ),
  );

  const captured = captureSummary.filter((c) => c.captured).length;
  console.log('');
  console.log(`[regression:capture] done. ${captured}/${fixtures.length} captured.`);
  console.log(`[regression:capture] capture summary at ${dir}/regression-capture-summary.json`);
}

// ---------------------------------------------------------------------------
// Score mode: run + diff + judge each fixture.
// ---------------------------------------------------------------------------
async function scoreMode(): Promise<void> {
  const fixtures = loadFixtures();
  const inputDiagnoses = loadReferenceDiagnosesAsInput();
  const judgePromptText = loadSimilarityJudgePrompt();
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // Pre-flight: every fixture must have a golden. Fail loud upfront.
  const uncaptured = fixtures.filter((f) => f.golden_output == null);
  if (uncaptured.length > 0) {
    console.error(
      `[regression:score] ${uncaptured.length}/${fixtures.length} fixtures have null golden_output:`,
    );
    for (const f of uncaptured) console.error(`  - ${f.id}`);
    console.error('');
    console.error('Run `npm run eval:regression -- --capture` first to populate goldens.');
    process.exit(1);
  }

  console.log(`[regression:score] scoring ${fixtures.length} fixtures against captured goldens`);
  console.log(`[regression:score] judge model: ${SIMILARITY_JUDGE_MODEL}`);

  const sessionPrefix = `eval-regression-score-${Date.now()}`;
  const t0 = Date.now();
  const perFixture: PerFixtureScore[] = [];
  const candidateCaptures: Array<{ id: string; agent: AgentKind; capture: unknown }> = [];

  for (const fixture of fixtures) {
    const sessionId = `${sessionPrefix}-${fixture.id}`;
    console.log(`[score] ${fixture.id} (${fixture.agent})…`);
    const { output, error, durationMs, capture } = await runFixture(
      fixture,
      inputDiagnoses,
      sessionId,
    );
    candidateCaptures.push({ id: fixture.id, agent: fixture.agent, capture });

    if (error) {
      console.log(`  AGENT_ERROR (${(durationMs / 1000).toFixed(0)}s): ${error}`);
      perFixture.push({
        id: fixture.id,
        agent: fixture.agent,
        structural: {
          pass: false,
          missing_required_fields: [],
          type_mismatches: [],
          unexpected_fields: [],
          notes: [`Agent errored: ${error}`],
        },
        similarity: {
          judge_error: `Agent errored — judge skipped: ${error}`,
          raw_response: '',
          attempts: 0,
        },
        structural_pass: false,
        semantic_pass: false,
        overall_pass: false,
        agent_error: error,
        duration_ms: durationMs,
      });
      continue;
    }

    // Structural diff
    const structural = structuralDiff(output, fixture.golden_output, {
      requiredFields: fixture.scoring_config.structural_required_fields,
      strict: fixture.scoring_config.structural_strict,
    });

    // Similarity judge (skipped for the intent fixture — output is a single
    // string we can compare strict-equal cheaper than calling the judge).
    let similarity: SimilarityJudgeOutput | SimilarityJudgeError;
    if (fixture.agent === 'intent') {
      const isMatch = output === fixture.golden_output;
      similarity = {
        same_conclusion: isMatch,
        confidence: 1,
        notes: isMatch
          ? `Intent labels match exactly: ${String(output)}`
          : `Intent labels differ: golden=${String(fixture.golden_output)} new=${String(output)}`,
        differences_named: isMatch ? [] : [`label: ${String(fixture.golden_output)} → ${String(output)}`],
        raw_response: '',
        attempts: 0,
      };
    } else {
      try {
        similarity = await judgeSimilarity(
          anthropic,
          {
            fixture_id: fixture.id,
            agent: fixture.agent,
            golden_output: fixture.golden_output,
            new_output: output,
            fixture_input: fixture.input,
          },
          judgePromptText,
        );
      } catch (err) {
        similarity = {
          judge_error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
          raw_response: '',
          attempts: 0,
        };
      }
    }

    const structural_pass = structural.pass;
    const semantic_pass = !isSimilarityJudgeError(similarity) && similarity.same_conclusion;
    const overall_pass = structural_pass && semantic_pass;

    perFixture.push({
      id: fixture.id,
      agent: fixture.agent,
      structural,
      similarity,
      structural_pass,
      semantic_pass,
      overall_pass,
      duration_ms: durationMs,
    });

    const sPass = structural_pass ? 'STRUCT_PASS' : 'STRUCT_FAIL';
    const semLabel = isSimilarityJudgeError(similarity)
      ? 'SEM_ERROR'
      : similarity.same_conclusion
        ? `SEM_PASS(${similarity.confidence.toFixed(2)})`
        : `SEM_FAIL(${similarity.confidence.toFixed(2)})`;
    const overall = overall_pass ? 'PASS' : 'FAIL';
    console.log(
      `  ${overall} (${(durationMs / 1000).toFixed(0)}s) — ${sPass}, ${semLabel}`,
    );
  }

  const totalRuntimeSec = (Date.now() - t0) / 1000;

  // Aggregate.
  const total = perFixture.length;
  const structPassN = perFixture.filter((p) => p.structural_pass).length;
  const semPassN = perFixture.filter((p) => p.semantic_pass).length;
  const overallPassN = perFixture.filter((p) => p.overall_pass).length;
  const aggregate = {
    total,
    structural_pass: structPassN,
    semantic_pass: semPassN,
    overall_pass: overallPassN,
    pass_rate: total === 0 ? 0 : overallPassN / total,
    structural_pass_rate: total === 0 ? 0 : structPassN / total,
    semantic_pass_rate: total === 0 ? 0 : semPassN / total,
  };

  // Write to disk.
  const { dir, date } = makeResultsDir();

  // judge.json: similarity verdicts + structural diffs per fixture
  writeFileSync(
    resolve(dir, 'regression-judge.json'),
    JSON.stringify(
      {
        date,
        judge_model: SIMILARITY_JUDGE_MODEL,
        sessionPrefix,
        fixtures: perFixture.map((p) => ({
          id: p.id,
          agent: p.agent,
          duration_ms: p.duration_ms,
          structural: p.structural,
          similarity: p.similarity,
          structural_pass: p.structural_pass,
          semantic_pass: p.semantic_pass,
          overall_pass: p.overall_pass,
          agent_error: p.agent_error,
        })),
      },
      null,
      2,
    ),
  );

  // candidates.json: full agent captures (raw audit dump)
  writeFileSync(
    resolve(dir, 'regression-candidates.json'),
    JSON.stringify(
      {
        date,
        sessionPrefix,
        candidates: candidateCaptures,
      },
      null,
      2,
    ),
  );

  // summary.json: aggregate
  writeFileSync(
    resolve(dir, 'regression-summary.json'),
    JSON.stringify(
      {
        date,
        mode: 'score',
        judge_model: SIMILARITY_JUDGE_MODEL,
        total_runtime_seconds: totalRuntimeSec,
        aggregate,
        per_fixture: perFixture.map((p) => ({
          id: p.id,
          agent: p.agent,
          structural_pass: p.structural_pass,
          semantic_pass: p.semantic_pass,
          overall_pass: p.overall_pass,
          structural_failures: {
            missing_required_fields: p.structural.missing_required_fields,
            type_mismatches: p.structural.type_mismatches,
          },
          similarity_summary: isSimilarityJudgeError(p.similarity)
            ? { error: p.similarity.judge_error }
            : {
                same_conclusion: p.similarity.same_conclusion,
                confidence: p.similarity.confidence,
                differences_named: p.similarity.differences_named,
              },
        })),
      },
      null,
      2,
    ),
  );

  // human-readable scorecard
  const md = renderSummaryMd({
    date,
    aggregate,
    perFixture,
    fixtures,
    totalRuntimeSec,
  });
  writeFileSync(resolve(dir, 'regression-summary.md'), md);

  console.log('');
  console.log(`[regression:score] wrote results to ${dir}`);
  console.log('');
  console.log(md);
}

// ---------------------------------------------------------------------------
// Markdown summary renderer.
// ---------------------------------------------------------------------------
function renderSummaryMd(args: {
  date: string;
  aggregate: {
    total: number;
    structural_pass: number;
    semantic_pass: number;
    overall_pass: number;
    pass_rate: number;
    structural_pass_rate: number;
    semantic_pass_rate: number;
  };
  perFixture: PerFixtureScore[];
  fixtures: Fixture[];
  totalRuntimeSec: number;
}): string {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

  // Find the most recent capture date across all fixtures
  const captureDates = args.fixtures
    .map((f) => f.captured_at)
    .filter((d): d is string => !!d);
  const captureDateLabel = captureDates.length
    ? captureDates.sort().slice(-1)[0]?.slice(0, 10) ?? 'unknown'
    : 'unknown';

  const tick = (b: boolean) => (b ? '✓' : '✗');

  const perFixtureRows = args.perFixture
    .map((p) => {
      return `| ${p.id} | ${tick(p.structural_pass)} | ${tick(p.semantic_pass)} | ${tick(p.overall_pass)} |`;
    })
    .join('\n');

  const failures = args.perFixture.filter((p) => !p.overall_pass);
  const failureSection = failures.length
    ? failures
        .map((p) => {
          const struct = !p.structural_pass
            ? [
                p.structural.missing_required_fields.length
                  ? `  - missing required fields: ${p.structural.missing_required_fields.join(', ')}`
                  : '',
                p.structural.type_mismatches.length
                  ? `  - type mismatches: ${p.structural.type_mismatches
                      .map((m) => `${m.path} (expected ${m.expected}, got ${m.got})`)
                      .join('; ')}`
                  : '',
                p.structural.notes.length ? `  - notes: ${p.structural.notes.join('; ')}` : '',
              ]
                .filter(Boolean)
                .join('\n')
            : '';

          const sim = isSimilarityJudgeError(p.similarity)
            ? `  - similarity judge error: ${p.similarity.judge_error}`
            : !p.similarity.same_conclusion
              ? `  - similarity judge: different conclusion (confidence ${p.similarity.confidence.toFixed(2)})\n  - notes: ${p.similarity.notes}\n  - differences: ${p.similarity.differences_named.join('; ')}`
              : '';

          const agentErr = p.agent_error ? `  - agent error: ${p.agent_error}` : '';

          return `### ${p.id}\n\n${[agentErr, struct, sim].filter(Boolean).join('\n')}\n`;
        })
        .join('\n')
    : '_No failures._\n';

  const mins = Math.floor(args.totalRuntimeSec / 60);
  const secs = Math.round(args.totalRuntimeSec % 60).toString().padStart(2, '0');

  return `# Regression eval — ${args.date}

Run against ${args.aggregate.total} golden fixtures captured on ${captureDateLabel}.
Mode: score (compares current outputs to captured goldens via structural diff + similarity judge).

## Aggregate

| Metric                          | Value           |
|---|---|
| Pass rate (overall)             | ${pct(args.aggregate.pass_rate)} (${args.aggregate.overall_pass}/${args.aggregate.total}) |
| Structural pass rate            | ${pct(args.aggregate.structural_pass_rate)} (${args.aggregate.structural_pass}/${args.aggregate.total}) |
| Semantic pass rate              | ${pct(args.aggregate.semantic_pass_rate)} (${args.aggregate.semantic_pass}/${args.aggregate.total}) |

## Per fixture

| Fixture | Structural | Semantic | Pass |
|---|---|---|---|
${perFixtureRows}

## Failures

${failureSection}
---

Judge model: ${SIMILARITY_JUDGE_MODEL}
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

  if (CAPTURE_MODE) {
    await captureMode();
  } else {
    await scoreMode();
  }
}

main().catch((err) => {
  console.error('[regression] fatal:', err);
  process.exit(1);
});
