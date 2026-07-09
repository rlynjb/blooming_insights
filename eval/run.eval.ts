// eval/run.eval.ts
//
// Week-2 harness — 10 golden cases wired through both rubrics.
//
// ─── Pattern: golden-set, LLM-as-judge eval harness on a test runner ──────
//
// The overarching shape is the GOLDEN-DATASET LLM-EVAL pattern ("evals as
// tests"): a fixed set of curated cases → run through the system → score →
// aggregate. It's the LLM analog of a regression suite, except outputs are
// non-deterministic, so it measures quality distributions rather than
// asserting exact values. It composes these sub-patterns:
//
//   1. LLM-as-judge          — a separate model (RubricJudge + rubric) grades
//                              each output instead of exact-match assertions.
//   2. Rubric / scored dims  — judgments are per-dimension scores (≥4 = pass)
//                              plus a verdict, aggregated into pass-rates.
//   3. Staged pipeline       — diagnose → judge → recommend → judge; each
//                              stage feeds the next, each has its own judge.
//   4. Receipt / artifact log — every case writes a durable JSON receipt
//                              (tokens, cost, traces, scores). The receipt is
//                              the real deliverable; pass/fail is secondary.
//   5. Fixture map-reduce     — beforeAll = setup, it.each = map one run per
//                              case, afterAll = reduce receipts to summaries.
//   6. Null-object degrade    — a judge failure yields a synthetic
//                              `judge_error` judgment (buildJudgmentPlaceholder)
//                              so the batch stays resilient and data stays whole.
//   7. Meta-evaluation        — the escape-hatch check evaluates the EVAL
//                              itself (does the rubric discriminate?).
//
// It is deliberately NOT a unit/integration test: excluded from `npm test`,
// it gates only certain signal classes and its output is a quality report,
// not a green checkmark.
//
// ─── Why this is a `.eval.ts` "test" file that also contains agent code ───
//
// This is an EVAL HARNESS dressed up as a vitest test file — that's the
// design, not an accident. vitest is borrowed here as an ORCHESTRATION
// RUNTIME (not for unit testing), because it hands us four things for free:
//   · beforeAll     → mint one shared runId + Anthropic client for the batch
//   · it.each       → one reported row per golden case, isolated, each with
//                     its own per-case timeout (a plain for-loop gives neither)
//   · expect        → the actual pass/fail gate
//   · afterAll      → aggregate every receipt into the summary tables
//
// The "code" (investigate → judge → recommend → judge → write receipt) lives
// INLINE in each it.each case rather than in a library the test calls, because
// each case IS one full end-to-end run — the test and the thing-under-test are
// the same object. And the rich receipts + summary reporting ARE the point of
// the run, so that observability can't be hidden behind a library boundary.
//
// This is LLM-eval, not a normal test: outputs are non-deterministic (an
// LLM's diagnosis, scored by another LLM), so it does two un-test-like things
//   · gates by signal class, not blanket pass/fail (see the gate below)
//   · writes a JSON receipt per case + prints aggregate quality tables,
//     because a green/red result carries too little signal on its own.
//
// Shape:
//   · `beforeAll` mints a shared runId all cases use
//   · `it.each(goldens)` runs each golden case as its own test row
//       - diagnose → judge diagnosis
//       - recommend → judge each recommendation
//       - write per-case receipt
//   · `afterAll` walks the receipts for this run and prints a summary
//     table (per-dimension pass rate, per-signal-class breakdown)
//
// Cases run sequentially inside the file (vitest default), so Anthropic
// rate limits stay tame. The whole run is ~15-40 min for 10 cases.
//
// Runner: vitest via `npm run eval` (uses vitest.eval.config.ts).
// Excluded from `npm test`.

// Node built-ins — read .env, write receipts, resolve dirs.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// The raw LLM client + aptkit's eval primitives: RubricJudge (LLM-as-judge),
// usage/cost helpers, and their types.
import Anthropic from '@anthropic-ai/sdk';
import {
  RubricJudge,
  estimateCost,
  summarizeUsage,
  type CapabilityEvent,
  type CostEstimate,
  type TokenUsageSummary,
} from '@aptkit/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Local code under test — the two agents, adapters, pricing, budget, the
// synthetic data source, and the golden cases + rubrics that drive the eval.
import { DiagnosticAgent } from '../lib/agents/diagnostic';
import { RecommendationAgent } from '../lib/agents/recommendation';
import { AnthropicModelProviderAdapter } from '../lib/agents/aptkit-adapters';
import { estimateAnthropicCost } from '../lib/agents/pricing';
import { BudgetTracker } from '../lib/agents/budget';
import {
  SyntheticDataSource,
  syntheticWorkspaceSchema,
} from '../lib/data-source/synthetic-data-source';
import type { McpToolDef } from '../lib/agents/tool-schemas';
import type { Recommendation, ToolCall } from '../lib/mcp/types';

import { goldens, type GoldenCase } from './goldens';
import { diagnosisQualityRubric } from './rubrics/diagnosis-quality';
import { recommendationQualityRubric } from './rubrics/recommendation-quality';

// ─── env ─────────────────────────────────────────────────────────────────────

// Hand-rolled dotenv parser (no dependency just for the eval). Walks
// .env.local then .env, regex-matches KEY=value lines, strips surrounding
// quotes, and sets process.env WITHOUT overwriting anything already set.
// Called at module load (below) so ANTHROPIC_API_KEY exists before any case.
function loadEnvFromDotenv(): void {
  const candidates = ['.env.local', '.env'];
  for (const name of candidates) {
    const path = resolve(process.cwd(), name);
    let contents: string;
    try {
      contents = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    for (const line of contents.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const key = m[1];
      if (process.env[key]) continue;
      let value = m[2].trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
  }
}

loadEnvFromDotenv();

// ─── judge-failure placeholder ───────────────────────────────────────────────

/**
 * The shape RubricJudge returns on success. Duplicated (not imported) so the
 * receipt shape is stable even if aptkit renames its internals.
 */
type RubricJudgmentValue = {
  dimensions: Record<string, { score: number; reason: string }>;
  checks?: Record<string, boolean>;
  verdict: string;
  fix: string;
  reasoning?: string;
};

/**
 * When the judge model fails to produce structured output (parse error after
 * retries), we still want a well-shaped judgment in the receipt so the summary
 * block can distinguish "judge_error" from "fail" from "pass". Use a synthetic
 * verdict tag so aggregation code sees it as a distinct outcome.
 */
function buildJudgmentPlaceholder(verdict: 'judge_error'): RubricJudgmentValue {
  return {
    dimensions: {},
    verdict,
    fix: '',
    reasoning: 'Judge model failed to produce parseable structured output. See judgmentError.',
  };
}

// ─── usage / cost helper ─────────────────────────────────────────────────────

/**
 * Combine an aptkit `TokenUsageSummary` with its `CostEstimate` (may be
 * undefined when pricing is unknown) into a single receipt-friendly row.
 */
function usageWithCost(usage: TokenUsageSummary, cost: CostEstimate | undefined) {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    turns: usage.turns,
    modelName: usage.modelName,
    estimated: usage.estimated,
    costUsd: cost?.totalCost ?? null,
    inputCostUsd: cost?.inputCost ?? null,
    outputCostUsd: cost?.outputCost ?? null,
  };
}

// ─── trace formatting ────────────────────────────────────────────────────────

// Render the recorded tool calls into a human-readable text block for the
// judge to read as context. Numbers each call and prints its name, args, and
// either the error or the result — truncating results to 4000 chars so a huge
// tool payload can't blow up the judge's context window.
function formatToolCallTrace(calls: readonly ToolCall[]): string {
  if (calls.length === 0) return '(no tool calls recorded)';
  const lines: string[] = [];
  for (let i = 0; i < calls.length; i++) {
    const c = calls[i];
    lines.push(`--- call ${i + 1}: ${c.toolName} ---`);
    if (Object.keys(c.args).length > 0) {
      lines.push(`args: ${JSON.stringify(c.args)}`);
    }
    if (c.error) {
      lines.push(`error: ${c.error}`);
    } else if (c.result !== undefined) {
      const raw = JSON.stringify(c.result);
      const truncated =
        raw.length > 4000 ? raw.slice(0, 4000) + `… [truncated, ${raw.length} total chars]` : raw;
      lines.push(`result: ${truncated}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

// ─── run ─────────────────────────────────────────────────────────────────────

const RECEIPTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'receipts');

let sharedRunId: string;
let sharedAnthropic: Anthropic;

// `describe` is the batch; `beforeAll` sets up shared state used by every
// case (see header for why vitest, not a bespoke runner, hosts this).
describe('eval · Week 2C — 10 goldens · diagnosis + recommendation quality', () => {
  beforeAll(() => {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error(
        'ANTHROPIC_API_KEY is not set. Put it in .env.local or export it before running.',
      );
    }
    sharedRunId = new Date().toISOString().replace(/[:.]/g, '-');
    sharedAnthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    mkdirSync(RECEIPTS_DIR, { recursive: true });
    console.log(`\n[eval] runId: ${sharedRunId}`);
    console.log(`[eval] cases:  ${goldens.length}`);
  });

  // Each golden case becomes its own test row. The whole agent pipeline runs
  // INLINE below — this callback IS the thing under evaluation, not a wrapper
  // around it. The 600_000 arg (bottom of this block) is vitest's per-case
  // timeout, which is a chunk of why we lean on it.each instead of a for-loop.
  it.each(goldens.map((g) => [g.caseId, g]))(
    'case %s',
    async (_label, goldenCase: GoldenCase) => {
      // ─── setup ────────────────────────────────────────────────────────
      // Fresh synthetic data source + tool list per case, plus a case-scoped
      // sessionId. Nothing here talks to the LLM yet.
      const caseStart = performance.now();
      const dataSource = new SyntheticDataSource();
      const schema = syntheticWorkspaceSchema;
      const listToolsRaw = await dataSource.listTools();
      const allTools = (listToolsRaw as { tools: McpToolDef[] }).tools;
      const sessionId = `eval-${sharedRunId}-${goldenCase.caseId}`;

      console.log(
        `\n[case ${goldenCase.caseId}] (${goldenCase.signalClass}) investigating…`,
      );

      // Per-investigation budget tracker. Shared across DiagnosticAgent
      // + RecommendationAgent so the ceiling counts total spend, not
      // per-agent spend. Limit sourced from BUDGET_MAX_USD env var
      // (default 2.00 USD — very generous vs the observed ~$0.09/case,
      // this is here as an escape valve, not a normal-path constraint).
      const budgetLimitUsd = Number(process.env.BUDGET_MAX_USD ?? '2.0');
      const budget = new BudgetTracker({ maxCostUsd: budgetLimitUsd });
      let budgetError: string | undefined;

      // ─── diagnose ─────────────────────────────────────────────────────
      const t0Investigate = performance.now();
      const diagnosticAgent = new DiagnosticAgent(
        sharedAnthropic,
        dataSource,
        schema,
        allTools,
        sessionId,
      );
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

      // ─── judge diagnosis ──────────────────────────────────────────────
      const t0DiagnosisJudge = performance.now();
      const judgeModel = new AnthropicModelProviderAdapter(
        sharedAnthropic,
        'diagnostic',
        sessionId,
      );
      const diagnosisJudge = new RubricJudge({
        model: judgeModel,
        rubric: diagnosisQualityRubric,
        capabilityId: 'blooming.eval.diagnosis-judge',
        maxTokens: 4096, // bumped from 2048; 2048 truncated the JSON on
                         // no-signal cases where the judgment reasoning
                         // is longer
        temperature: 0,
      });
      const diagnosisJudgmentResult = await diagnosisJudge.judge({
        subject: JSON.stringify(diagnosis, null, 2),
        context: {
          anomaly: JSON.stringify(goldenCase.anomaly, null, 2),
          known_correct_shape: JSON.stringify(goldenCase.knownCorrect, null, 2),
          case_intent: goldenCase.intent,
          signal_class: goldenCase.signalClass,
          tool_calls_trace: formatToolCallTrace(diagnosisToolCalls),
        },
      });
      const diagnosisJudgeMs = Math.round(performance.now() - t0DiagnosisJudge);

      // ─── recommend ────────────────────────────────────────────────────
      const t0Recommend = performance.now();
      const recommendationAgent = new RecommendationAgent(
        sharedAnthropic,
        dataSource,
        schema,
        allTools,
        sessionId,
      );
      const recommendationToolCalls: ToolCall[] = [];
      const recommendationTrace: CapabilityEvent[] = [];
      const recommendations: Recommendation[] = await recommendationAgent.propose(
        goldenCase.anomaly,
        diagnosis,
        {
          onToolResult: (tc) => recommendationToolCalls.push({ ...tc }),
          onCapabilityEvent: (ev) => recommendationTrace.push(ev),
          budget,
        },
      );
      const recommendMs = Math.round(performance.now() - t0Recommend);
      const recommendUsage = summarizeUsage(recommendationTrace);
      const recommendCost =
        estimateCost('anthropic', recommendUsage, 'claude-sonnet-4-6') ??
        estimateAnthropicCost(recommendUsage, 'claude-sonnet-4-6');

      // ─── judge each recommendation ────────────────────────────────────
      const t0RecommendJudge = performance.now();
      const recommendationJudge = new RubricJudge({
        model: judgeModel,
        rubric: recommendationQualityRubric,
        capabilityId: 'blooming.eval.recommendation-judge',
        maxTokens: 4096, // parity with diagnosis judge
        temperature: 0,
      });
      const recommendationTraceForJudge = formatToolCallTrace(recommendationToolCalls);
      const recommendationJudgments: Array<{
        recommendationId: string;
        recommendationTitle: string;
        bloomreachFeature: string;
        judgment: ReturnType<typeof buildJudgmentPlaceholder> | RubricJudgmentValue;
        attempts: number;
        judgmentError?: string;
      }> = [];
      for (let i = 0; i < recommendations.length; i++) {
        const rec = recommendations[i];
        const rjResult = await recommendationJudge.judge({
          subject: JSON.stringify(rec, null, 2),
          context: {
            anomaly: JSON.stringify(goldenCase.anomaly, null, 2),
            diagnosis: JSON.stringify(diagnosis, null, 2),
            case_intent: goldenCase.intent,
            signal_class: goldenCase.signalClass,
            tool_calls_trace: recommendationTraceForJudge,
          },
        });
        if (rjResult.ok) {
          recommendationJudgments.push({
            recommendationId: rec.id,
            recommendationTitle: rec.title,
            bloomreachFeature: rec.bloomreachFeature,
            judgment: rjResult.value,
            attempts: rjResult.attempts.length,
          });
        } else {
          // Judge failed to produce structured output — record the failure
          // in the receipt rather than throwing, so the summary block sees
          // complete data.
          recommendationJudgments.push({
            recommendationId: rec.id,
            recommendationTitle: rec.title,
            bloomreachFeature: rec.bloomreachFeature,
            judgment: buildJudgmentPlaceholder('judge_error'),
            attempts: rjResult.attempts.length,
            judgmentError: rjResult.error,
          });
        }
      }
      const recommendationJudgeMs = Math.round(performance.now() - t0RecommendJudge);

      // ─── receipt ──────────────────────────────────────────────────────
      // Assemble the big per-case JSON: run metadata, per-phase durations,
      // models, anomaly summary, tool-call summaries, usage/cost, budget
      // snapshot, and the diagnosis + recommendations with their judgments.
      // This file is the durable artifact the afterAll summary reads back.
      //
      // If the diagnosis judge failed, we still write a receipt (with a
      // placeholder judgment + the error) so the summary block can see the
      // case as "judge_error" rather than have it disappear.
      const diagnosisJudgment = diagnosisJudgmentResult.ok
        ? diagnosisJudgmentResult.value
        : buildJudgmentPlaceholder('judge_error');
      const diagnosisJudgmentError = diagnosisJudgmentResult.ok
        ? undefined
        : diagnosisJudgmentResult.error;

      const receipt = {
        runId: sharedRunId,
        case: goldenCase.caseId,
        signalClass: goldenCase.signalClass,
        intent: goldenCase.intent,
        durationMs: {
          investigate: investigateMs,
          diagnosisJudge: diagnosisJudgeMs,
          recommend: recommendMs,
          recommendationJudge: recommendationJudgeMs,
          total: Math.round(performance.now() - caseStart),
        },
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
        recommendationToolCalls: recommendationToolCalls.map((tc) => ({
          toolName: tc.toolName,
          args: tc.args,
          durationMs: tc.durationMs,
          hasError: Boolean(tc.error),
        })),
        // Phase-2 observability: per-invocation token usage + cost, from
        // aptkit's summarizeUsage + estimateCost over the captured trace.
        usage: {
          diagnose: usageWithCost(diagnosisUsage, diagnosisCost),
          recommend: usageWithCost(recommendUsage, recommendCost),
        },
        // Phase-3 per-investigation budget snapshot. Shared tracker across
        // diagnose + recommend, so this is the ACROSS-agents running total.
        // budgetError is set only if the ceiling was breached mid-run
        // (currently unreachable at BUDGET_MAX_USD=2.0 default; here as
        // proof-of-pipe).
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

      const dv = receipt.diagnosisJudgment.verdict;
      const rvs = receipt.recommendationJudgments.map((rj) => rj.judgment.verdict).join(', ');
      console.log(
        `[case ${goldenCase.caseId}] done in ${Math.round((performance.now() - caseStart) / 1000)}s · diagnosis: ${dv} · recs: [${rvs || '(none)'}]`,
      );

      // Signal-class-aware gate — the one spot where this stops looking like
      // a normal test. A normal test asserts a deterministic output; here the
      // "output" is LLM quality scored by another LLM, so we only turn certain
      // classes into a hard expect() and leave the rest as measured-not-gated:
      //   has-signal / partial-signal → the agent SHOULD produce a
      //     non-fail diagnosis. A fail is a bug → gated with expect().
      //   no-signal / positive         → measured, not gated. A fail
      //     here is a data point (confabulation or unhandled positive).
      //   judge_error                  → never gated; the model output
      //     failed to parse. Recorded in receipt, not a case failure.
      const isGated =
        goldenCase.signalClass === 'has-signal' ||
        goldenCase.signalClass === 'partial-signal';
      if (isGated) {
        expect(receipt.diagnosisJudgment.verdict).not.toBe('fail');
        for (const rj of receipt.recommendationJudgments) {
          expect(
            rj.judgment.verdict,
            `case ${goldenCase.caseId} rec "${rj.recommendationTitle}"`,
          ).not.toBe('fail');
        }
      }
    },
    600_000, // 10 min per case
  );

  afterAll(() => {
    // The reporting layer — and the reason vitest's afterAll is worth
    // borrowing. A green/red pass carries too little signal for an eval, so
    // here we walk every receipt this run wrote and print aggregate quality
    // tables (per-case verdicts, per-dimension pass rates, escape-hatch check).
    // This observability IS the deliverable of the run, not a side effect.
    //
    // Walk the receipts dir for files matching this run's runId; build a
    // summary table across all cases.
    if (!sharedRunId) return;
    const files = readdirSync(RECEIPTS_DIR).filter((f) => f.endsWith(`${sharedRunId}.json`));
    if (files.length === 0) {
      console.error('\n[eval] afterAll: no receipts found for this run');
      return;
    }

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

    const receipts: Receipt[] = files.map(
      (f) => JSON.parse(readFileSync(resolve(RECEIPTS_DIR, f), 'utf8')) as Receipt,
    );
    receipts.sort((a, b) => a.case.localeCompare(b.case));

    const passish = (v: string) => v === 'pass' || v === 'pass_with_notes';

    // ─── per-case summary ────────────────────────────────────────────────
    console.error('\n╔══════════════════════════════════════════════════════════════════════════════╗');
    console.error('║ Week 2C · 10 goldens · per-case verdicts                                    ║');
    console.error('╠══════════════════════════════════════════════════════════════════════════════╣');
    console.error('║ case                                          class         diag    recs    ║');
    console.error('╟──────────────────────────────────────────────────────────────────────────────╢');
    for (const r of receipts) {
      const case_ = r.case.padEnd(45);
      const cls = r.signalClass.padEnd(13);
      const dv = r.diagnosisJudgment.verdict.padEnd(7);
      const recCount = r.recommendationJudgments.length;
      const recPass = r.recommendationJudgments.filter((rj) => passish(rj.judgment.verdict)).length;
      const recs = `${recPass}/${recCount}`.padEnd(7);
      console.error(`║ ${case_} ${cls} ${dv} ${recs} ║`);
    }
    console.error('╚══════════════════════════════════════════════════════════════════════════════╝');

    // ─── per-dimension pass rate ─────────────────────────────────────────
    // dimAgg tallies pass/total/score-distribution per rubric dimension
    // (score ≥ 4 counts as pass); printDims renders it with a 1:_ 2:_ …
    // histogram. Run for both the diagnosis and recommendation rubrics.
    const dimAgg = (
      key: 'diagnosisJudgment' | 'recommendationJudgment',
    ): Record<string, { pass: number; total: number; scores: number[] }> => {
      const out: Record<string, { pass: number; total: number; scores: number[] }> = {};
      for (const r of receipts) {
        const judgments =
          key === 'diagnosisJudgment' ? [r.diagnosisJudgment] : r.recommendationJudgments.map((rj) => rj.judgment);
        for (const j of judgments) {
          for (const [dim, val] of Object.entries(j.dimensions)) {
            out[dim] ??= { pass: 0, total: 0, scores: [] };
            out[dim].total++;
            if (val.score >= 4) out[dim].pass++;
            out[dim].scores.push(val.score);
          }
        }
      }
      return out;
    };

    const printDims = (label: string, agg: Record<string, { pass: number; total: number; scores: number[] }>) => {
      console.error(`\n${label} pass rate (score ≥ 4)`);
      console.error('─'.repeat(78));
      for (const [dim, s] of Object.entries(agg)) {
        const pct = s.total > 0 ? Math.round((s.pass / s.total) * 100) : 0;
        const dist = s.scores.reduce<Record<number, number>>((acc, n) => {
          acc[n] = (acc[n] ?? 0) + 1;
          return acc;
        }, {});
        const distStr = [1, 2, 3, 4, 5].map((n) => `${n}:${dist[n] ?? 0}`).join(' ');
        console.error(`  ${dim.padEnd(30)}  ${String(s.pass).padStart(3)}/${String(s.total).padEnd(3)}  (${String(pct).padStart(3)}%)   dist [${distStr}]`);
      }
    };

    printDims('DIAGNOSIS', dimAgg('diagnosisJudgment'));
    printDims('RECOMMENDATION', dimAgg('recommendationJudgment'));

    // ─── escape-hatch check (Q1 pre-agreed criterion) ────────────────────
    // Quality check on the eval itself: count DISTINCT scores per diagnosis
    // dimension and flag any with fewer than 3 as "substrate too homogeneous"
    // — i.e. the rubric isn't discriminating between cases.
    console.error('\nEscape-hatch check (≥3 distinct pass/fail patterns per dimension)');
    console.error('─'.repeat(78));
    const dAgg = dimAgg('diagnosisJudgment');
    for (const [dim, s] of Object.entries(dAgg)) {
      const distinct = new Set(s.scores).size;
      const flag = distinct >= 3 ? '✓' : '✗ substrate too homogeneous';
      console.error(`  ${dim.padEnd(30)}  ${distinct} distinct scores  ${flag}`);
    }
    console.error('');
  });
});
