// eval/run.eval.ts
//
// Week-1 proof-of-path — the ONE golden case wired end-to-end:
//   1. Instantiate SyntheticDataSource (deterministic, in-process, no OAuth)
//   2. Run blooming's DiagnosticAgent over the golden anomaly → Diagnosis
//   3. Instantiate RubricJudge from @aptkit/evals (via @aptkit/core)
//   4. Judge the diagnosis against the diagnosis-quality rubric → RubricJudgment
//   5. Print + write a JSON receipt
//
// Runner: vitest (the same resolver `npm test` uses — needed because
// `moduleResolution: "bundler"` + the `@aptkit/core → @rlynjb/aptkit-core`
// npm alias trip up Node's ESM resolver via tsx). Excluded from `npm test`
// by the default config's `include` pattern (test/**/*.test.ts).
// `npm run eval` uses vitest.eval.config.ts which targets `eval/**/*.eval.ts`.
//
// ── Week 2 · Session A ──
// Capture the tool-call trace during agent.investigate() via the
// onToolResult hook, then feed it to the judge as `tool_calls_trace`
// context. Fixes the Week-1 evidence_grounding false-positive: the judge
// was flagging real numbers (e.g. "SP -24") as invention because it never
// saw the get_event_segmentation call the agent made.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { RubricJudge } from '@aptkit/core';
import { describe, expect, it } from 'vitest';

import { DiagnosticAgent } from '../lib/agents/diagnostic';
import { AnthropicModelProviderAdapter } from '../lib/agents/aptkit-adapters';
import {
  SyntheticDataSource,
  syntheticWorkspaceSchema,
} from '../lib/data-source/synthetic-data-source';
import type { McpToolDef } from '../lib/agents/tool-schemas';
import type { ToolCall } from '../lib/mcp/types';

import {
  goldenAnomaly,
  knownCorrect,
  caseId,
} from './goldens/conversion-drop-mobile-checkout';
import { diagnosisQualityRubric } from './rubrics/diagnosis-quality';

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

// ─── trace formatting ────────────────────────────────────────────────────────

/**
 * Format the captured tool-call trace as a compact string for the judge.
 * Full JSON is verbose and eats the judge's context budget; each call gets a
 * numbered header with tool name + args + a summary of the result body.
 *
 * The judge's job is to verify that every claim in the diagnosis is traceable
 * to *some* line in this trace. Anything not present is invention.
 */
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
      // The result may be an { ok, data } envelope or a bare object.
      // Stringify with a size cap so an enormous synthetic result doesn't
      // blow the judge's token budget.
      const raw = JSON.stringify(c.result);
      const truncated = raw.length > 4000 ? raw.slice(0, 4000) + `… [truncated, ${raw.length} total chars]` : raw;
      lines.push(`result: ${truncated}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

// ─── run ─────────────────────────────────────────────────────────────────────

describe('eval: diagnosis quality', () => {
  it(
    `${caseId}: agent produces a passing diagnosis`,
    async () => {
      if (!process.env.ANTHROPIC_API_KEY) {
        throw new Error(
          'ANTHROPIC_API_KEY is not set. Put it in .env.local or export it before running.',
        );
      }

      const runId = new Date().toISOString().replace(/[:.]/g, '-');
      const startedAt = performance.now();

      const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const dataSource = new SyntheticDataSource();
      const schema = syntheticWorkspaceSchema;

      const listToolsRaw = await dataSource.listTools();
      const allTools = (listToolsRaw as { tools: McpToolDef[] }).tools;

      // ─── 1. investigate ─────────────────────────────────────────────────
      console.log(`\n[eval] case: ${caseId}`);
      console.log(
        `[eval] investigating anomaly (metric=${goldenAnomaly.metric}, scope=${goldenAnomaly.scope.join(',')})…`,
      );
      const t0Investigate = performance.now();
      const agent = new DiagnosticAgent(
        anthropic,
        dataSource,
        schema,
        allTools,
        `eval-${runId}`,
      );

      // Capture every tool call the agent makes. The judge sees this trace as
      // context so it can verify the diagnosis's numbers against ground truth.
      const toolCallTrace: ToolCall[] = [];
      const diagnosis = await agent.investigate(goldenAnomaly, {
        onToolResult: (tc) => {
          // Push a shallow snapshot so later mutations of the internal
          // ToolCall object (unlikely, but the AptKit trace sink reuses them)
          // don't rewrite the trace.
          toolCallTrace.push({ ...tc });
        },
      });
      const investigateMs = Math.round(performance.now() - t0Investigate);
      console.log(
        `[eval] diagnosis produced in ${investigateMs}ms (${toolCallTrace.length} tool calls)`,
      );

      // ─── 2. judge ───────────────────────────────────────────────────────
      console.log('[eval] judging diagnosis with RubricJudge…');
      const t0Judge = performance.now();
      const judgeModel = new AnthropicModelProviderAdapter(
        anthropic,
        'diagnostic', // reused: judge log-site labels it as diagnostic-eval
        `eval-${runId}`,
      );
      const judge = new RubricJudge({
        model: judgeModel,
        rubric: diagnosisQualityRubric,
        capabilityId: 'blooming.eval.diagnosis-judge',
        maxTokens: 2048,
        temperature: 0,
      });

      const subject = JSON.stringify(diagnosis, null, 2);
      const traceForJudge = formatToolCallTrace(toolCallTrace);

      const judgmentResult = await judge.judge({
        subject,
        context: {
          anomaly: JSON.stringify(goldenAnomaly, null, 2),
          known_correct_shape: JSON.stringify(knownCorrect, null, 2),
          tool_calls_trace: traceForJudge,
        },
      });
      const judgeMs = Math.round(performance.now() - t0Judge);
      console.log(`[eval] judgment produced in ${judgeMs}ms`);

      if (!judgmentResult.ok) {
        throw new Error(
          `RubricJudge failed to produce structured output: ${judgmentResult.error}`,
        );
      }

      // ─── 3. receipt ─────────────────────────────────────────────────────
      const receipt = {
        case: caseId,
        runId,
        durationMs: {
          investigate: investigateMs,
          judge: judgeMs,
          total: Math.round(performance.now() - startedAt),
        },
        model: {
          agent: 'claude-sonnet-4-6',
          judge: 'claude-sonnet-4-6',
        },
        anomaly: {
          metric: goldenAnomaly.metric,
          scope: goldenAnomaly.scope,
          change: goldenAnomaly.change,
          severity: goldenAnomaly.severity,
        },
        toolCallTrace: toolCallTrace.map((tc) => ({
          toolName: tc.toolName,
          args: tc.args,
          durationMs: tc.durationMs,
          hasError: Boolean(tc.error),
        })),
        toolCallCount: toolCallTrace.length,
        diagnosis,
        judgment: judgmentResult.value,
        judgeAttempts: judgmentResult.attempts.length,
      };

      console.log('\n[eval] ─── receipt ───────────────────────────────────────');
      console.log(JSON.stringify(receipt.judgment, null, 2));
      console.log('[eval] ────────────────────────────────────────────────────\n');

      const outDir = resolve(dirname(fileURLToPath(import.meta.url)), 'receipts');
      mkdirSync(outDir, { recursive: true });
      const outPath = resolve(outDir, `${caseId}-${runId}.json`);
      writeFileSync(outPath, JSON.stringify(receipt, null, 2) + '\n', 'utf8');
      console.log(`[eval] receipt written to ${outPath}`);
      console.log(`[eval] verdict: ${receipt.judgment.verdict}`);

      // Week-1 gate: the diagnosis must not FAIL. `pass` and `pass_with_notes`
      // are both acceptable; `fail` means the substrate or the prompt broke.
      expect(receipt.judgment.verdict).not.toBe('fail');
    },
    300_000, // 5-minute timeout — one diagnostic run + one judge call
  );
});
