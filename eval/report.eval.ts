// eval/report.eval.ts
//
// Phase-2 observability report — reads all receipts for a run and prints:
//   · per-phase latency percentiles (p50, p95, p99, max) across cases
//   · per-case token usage + cost per phase (diagnose, recommend)
//   · run totals (tokens, cost, aggregate time)
//   · per-tool-call latency stats
//
// Sourced purely from receipts on disk — no model calls. Zero-cost.
//
// Usage:
//   npm run eval:report
//     → the latest runId's receipts by default
//   RUN_ID=2026-07-03T02-47-24-392Z npm run eval:report
//
// Runner: vitest via `npm run eval:report`.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const RECEIPTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'receipts');

const shouldRun = process.env.RUN_REPORT === '1';

type Receipt = {
  runId: string;
  case: string;
  signalClass: string;
  durationMs: {
    investigate: number;
    diagnosisJudge: number;
    recommend: number;
    recommendationJudge: number;
    total: number;
  };
  usage?: {
    diagnose?: UsageRow;
    recommend?: UsageRow;
  };
  diagnosisToolCalls: Array<{ toolName: string; durationMs?: number; hasError: boolean }>;
  recommendationToolCalls: Array<{ toolName: string; durationMs?: number; hasError: boolean }>;
};

type UsageRow = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  turns: number;
  modelName?: string;
  estimated: boolean;
  costUsd: number | null;
  inputCostUsd: number | null;
  outputCostUsd: number | null;
};

describe.skipIf(!shouldRun)('eval observability · latency + cost report', () => {
  it('emit report for the run', () => {
    const runId = pickRunId(process.env.RUN_ID);
    const files = readdirSync(RECEIPTS_DIR)
      .filter((f) => f.endsWith(`${runId}.json`))
      .sort();
    if (files.length === 0) throw new Error(`No receipts for runId ${runId}`);

    const receipts: Receipt[] = files.map(
      (f) => JSON.parse(readFileSync(resolve(RECEIPTS_DIR, f), 'utf8')) as Receipt,
    );

    console.error(`\n╔══════════════════════════════════════════════════════════════════════════════╗`);
    console.error(`║ Phase-2 observability report                                                ║`);
    console.error(`╚══════════════════════════════════════════════════════════════════════════════╝`);
    console.error(`\nrunId:  ${runId}`);
    console.error(`cases:  ${receipts.length}`);

    // ─── per-phase latency percentiles ─────────────────────────────────
    const phases: Array<['investigate' | 'diagnosisJudge' | 'recommend' | 'recommendationJudge' | 'total', string]> = [
      ['investigate', 'diagnose'],
      ['diagnosisJudge', 'diag-judge'],
      ['recommend', 'recommend'],
      ['recommendationJudge', 'rec-judge'],
      ['total', 'total'],
    ];
    console.error('\nPer-phase latency (ms) across cases');
    console.error('─'.repeat(78));
    console.error(
      `  ${'phase'.padEnd(14)}  ${'p50'.padStart(7)}  ${'p95'.padStart(7)}  ${'p99'.padStart(7)}  ${'max'.padStart(7)}  ${'mean'.padStart(7)}`,
    );
    for (const [key, label] of phases) {
      const arr = receipts.map((r) => r.durationMs[key]).filter((n) => typeof n === 'number');
      const stats = percentiles(arr);
      console.error(
        `  ${label.padEnd(14)}  ${String(stats.p50).padStart(7)}  ${String(stats.p95).padStart(7)}  ${String(stats.p99).padStart(7)}  ${String(stats.max).padStart(7)}  ${String(stats.mean).padStart(7)}`,
      );
    }

    // ─── per-case token usage + cost ────────────────────────────────────
    console.error('\nPer-case token usage + cost (from aptkit summarizeUsage + estimateCost)');
    console.error('─'.repeat(78));
    console.error(
      `  ${'case'.padEnd(40)}  ${'d.in'.padStart(6)}  ${'d.out'.padStart(6)}  ${'d.$'.padStart(6)}  ${'r.in'.padStart(6)}  ${'r.out'.padStart(6)}  ${'r.$'.padStart(6)}`,
    );
    let totalCost = 0;
    let totalIn = 0;
    let totalOut = 0;
    let missingCost = 0;
    for (const r of receipts) {
      const d = r.usage?.diagnose;
      const rr = r.usage?.recommend;
      const dCost = d?.costUsd ?? 0;
      const rCost = rr?.costUsd ?? 0;
      if (d?.costUsd == null && d != null) missingCost++;
      if (rr?.costUsd == null && rr != null) missingCost++;
      totalCost += dCost + rCost;
      totalIn += (d?.inputTokens ?? 0) + (rr?.inputTokens ?? 0);
      totalOut += (d?.outputTokens ?? 0) + (rr?.outputTokens ?? 0);
      console.error(
        `  ${r.case.padEnd(40)}  ${String(d?.inputTokens ?? '—').padStart(6)}  ${String(d?.outputTokens ?? '—').padStart(6)}  ${dollars(d?.costUsd)}  ${String(rr?.inputTokens ?? '—').padStart(6)}  ${String(rr?.outputTokens ?? '—').padStart(6)}  ${dollars(rr?.costUsd)}`,
      );
    }
    console.error(
      `\n  Totals:  input ${totalIn.toLocaleString()}  output ${totalOut.toLocaleString()}  cost $${totalCost.toFixed(3)}`,
    );
    if (missingCost > 0) {
      console.error(`  Note: ${missingCost} row(s) had null costUsd (usage present but pricing lookup returned undefined)`);
    }
    if (receipts.some((r) => !r.usage)) {
      const legacy = receipts.filter((r) => !r.usage).map((r) => r.case);
      console.error(
        `\n  Legacy receipts without usage[]: ${legacy.length}  (${legacy.join(', ')})`,
      );
      console.error(`  Re-run \`npm run eval\` to populate.`);
    }

    // ─── tool call latency ──────────────────────────────────────────────
    const allToolCallDurations: number[] = [];
    for (const r of receipts) {
      for (const tc of [...r.diagnosisToolCalls, ...r.recommendationToolCalls]) {
        if (typeof tc.durationMs === 'number') allToolCallDurations.push(tc.durationMs);
      }
    }
    if (allToolCallDurations.length > 0) {
      console.error('\nPer-tool-call latency (ms) across all cases');
      console.error('─'.repeat(78));
      const s = percentiles(allToolCallDurations);
      console.error(
        `  n=${allToolCallDurations.length}  p50=${s.p50}  p95=${s.p95}  p99=${s.p99}  max=${s.max}  mean=${s.mean}`,
      );
    }

    console.error('');
    expect(receipts.length).toBeGreaterThan(0);
  });
});

function percentiles(arr: readonly number[]): {
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
} {
  if (arr.length === 0) return { p50: 0, p95: 0, p99: 0, max: 0, mean: 0 };
  const sorted = [...arr].sort((a, b) => a - b);
  const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
  const mean = Math.round(sorted.reduce((s, n) => s + n, 0) / sorted.length);
  return {
    p50: pct(50),
    p95: pct(95),
    p99: pct(99),
    max: sorted[sorted.length - 1],
    mean,
  };
}

function dollars(n: number | null | undefined): string {
  if (n == null) return '     —'.padStart(6);
  return `$${n.toFixed(3)}`.padStart(6);
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
