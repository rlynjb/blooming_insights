// eval/run.eval.ts
//
// Week-2 harness — 10 golden cases wired through both rubrics.
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

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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

import { DiagnosticAgent } from '../lib/agents/diagnostic';
import { RecommendationAgent } from '../lib/agents/recommendation';
import { AnthropicModelProviderAdapter } from '../lib/agents/aptkit-adapters';
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

  it.each(goldens.map((g) => [g.caseId, g]))(
    'case %s',
    async (_label, goldenCase: GoldenCase) => {
      const caseStart = performance.now();
      const dataSource = new SyntheticDataSource();
      const schema = syntheticWorkspaceSchema;
      const listToolsRaw = await dataSource.listTools();
      const allTools = (listToolsRaw as { tools: McpToolDef[] }).tools;
      const sessionId = `eval-${sharedRunId}-${goldenCase.caseId}`;

      console.log(
        `\n[case ${goldenCase.caseId}] (${goldenCase.signalClass}) investigating…`,
      );

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
      });
      const investigateMs = Math.round(performance.now() - t0Investigate);
      const diagnosisUsage = summarizeUsage(diagnosisTrace);
      const diagnosisCost = estimateCost('anthropic', diagnosisUsage, 'claude-sonnet-4-6');

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
        },
      );
      const recommendMs = Math.round(performance.now() - t0Recommend);
      const recommendUsage = summarizeUsage(recommendationTrace);
      const recommendCost = estimateCost('anthropic', recommendUsage, 'claude-sonnet-4-6');

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

      // Signal-class-aware gate:
      //   has-signal / partial-signal → the agent SHOULD produce a
      //     non-fail diagnosis. A fail is a bug.
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
