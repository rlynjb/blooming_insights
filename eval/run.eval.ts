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
      const diagnosis = await agent.investigate(goldenAnomaly);
      const investigateMs = Math.round(performance.now() - t0Investigate);
      console.log(`[eval] diagnosis produced in ${investigateMs}ms`);

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
      const judgmentResult = await judge.judge({
        subject,
        context: {
          anomaly: JSON.stringify(goldenAnomaly, null, 2),
          known_correct_shape: JSON.stringify(knownCorrect, null, 2),
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
