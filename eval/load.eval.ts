// eval/load.eval.ts
//
// Phase-4 load harness. Fires N investigations through live-synthetic
// with configurable concurrency, no judge calls, and per-investigation
// observability (tokens + cost + latency). Aggregates p50/p95/p99 across
// the load run and emits a load receipt.
//
// ─── Pattern: load / soak harness (+ chaos fault injection) ───────────────
// Characterizes THROUGHPUT and LATENCY, not quality: fires N investigations
// through a worker-pool at concurrency K, skips the judges entirely, and
// reduces results to p50/p95/p99 distributions. Sub-patterns: semaphore /
// worker-pool concurrency (shared index queue), percentile aggregation,
// isolate-failures (one investigation's error doesn't stop other workers),
// and optional fault injection (chaos testing) via FaultInjectingDataSource
// with a seed for deterministic-yet-varied reproducibility.
//
// Difference from `eval/run.eval.ts`:
//   · run.eval.ts: 10 goldens, ALL judged, receipt has verdicts
//   · load.eval.ts: N investigations (default 20, env LOAD_N=…),
//     concurrency K (default 3, env LOAD_CONCURRENCY=…), NO judges,
//     receipt is a load-run summary of timing + cost distributions
//
// Goldens rotate: N > 10 means cycling through the 10 case anomalies
// (index N mod 10). Varied metrics/scopes/severities/edge cases as the
// plan requires — not N happy-path copies. No-signal cases in the pool
// stress the "insufficient evidence" path under load.
//
// Cost math: per-investigation ~$0.09 (agent-side, cached). At N=20
// that's ~$1.80. At N=50, ~$4.50. Time: N × 250s / K concurrency.
//
// Usage:
//   npm run eval:load                          → LOAD_N=20, K=3
//   LOAD_N=5 LOAD_CONCURRENCY=1 npm run eval:load → tiny smoke
//   LOAD_N=50 LOAD_CONCURRENCY=5 npm run eval:load → real load
//
// Runner: vitest via `npm run eval:load`. Excluded from `npm test`.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import {
  estimateCost,
  summarizeUsage,
  type CapabilityEvent,
} from '@aptkit/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DiagnosticAgent } from '../lib/agents/diagnostic';
import { RecommendationAgent } from '../lib/agents/recommendation';
import {
  SyntheticDataSource,
  syntheticWorkspaceSchema,
} from '../lib/data-source/synthetic-data-source';
import type { McpToolDef } from '../lib/agents/tool-schemas';
import type { Recommendation, ToolCall } from '../lib/mcp/types';
import { estimateAnthropicCost } from '../lib/agents/pricing';
import { BudgetTracker } from '../lib/agents/budget';
import { FaultInjectingDataSource, type FaultRates } from '../lib/data-source/fault-injecting';

import { goldens } from './goldens';

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

const shouldRun = process.env.RUN_LOAD === '1';

// ─── config ──────────────────────────────────────────────────────────────────

const LOAD_N = Number(process.env.LOAD_N ?? '20');
const LOAD_CONCURRENCY = Number(process.env.LOAD_CONCURRENCY ?? '3');
const BUDGET_PER_INVESTIGATION_USD = Number(process.env.BUDGET_MAX_USD ?? '2.0');

// Phase-4B fault-injection config. When any rate > 0, wrap the
// SyntheticDataSource with FaultInjectingDataSource. Rates are per-call
// probabilities (0.05 = 5%). Deterministic sequence when FAULT_SEED set.
const FAULT_RATES: FaultRates = {
  timeout: parseNumEnv('FAULT_TIMEOUT'),
  rateLimit: parseNumEnv('FAULT_RATE_LIMIT'),
  serverError: parseNumEnv('FAULT_SERVER_ERROR'),
  malformedJson: parseNumEnv('FAULT_MALFORMED_JSON'),
};
const FAULT_SEED = process.env.FAULT_SEED ? Number(process.env.FAULT_SEED) : undefined;
const FAULT_ENABLED = Object.values(FAULT_RATES).some((r) => (r ?? 0) > 0);

function parseNumEnv(name: string): number {
  const v = process.env[name];
  if (v == null || v === '') return 0;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

// ─── types ───────────────────────────────────────────────────────────────────

type Investigation = {
  index: number;
  caseId: string;
  signalClass: string;
  startedAt: number;
  durationMs: {
    investigate: number;
    recommend: number;
    total: number;
  };
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  toolCallCount: number;
  recommendationCount: number;
  faultCounts?: Record<string, number>;
  error?: string;
};

// ─── run ─────────────────────────────────────────────────────────────────────

const RECEIPTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'load-receipts');

let sharedRunId: string;
let sharedAnthropic: Anthropic;

describe.skipIf(!shouldRun)('phase-4 load harness · N investigations, no judges', () => {
  beforeAll(() => {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY not set.');
    }
    sharedRunId = new Date().toISOString().replace(/[:.]/g, '-');
    sharedAnthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    mkdirSync(RECEIPTS_DIR, { recursive: true });
    console.log(`\n[load] runId:      ${sharedRunId}`);
    console.log(`[load] N:          ${LOAD_N}`);
    console.log(`[load] concurrency: ${LOAD_CONCURRENCY}`);
    console.log(
      `[load] goldens:     ${goldens.length} (rotating; N ${LOAD_N > goldens.length ? '>' : '≤'} pool → ${LOAD_N > goldens.length ? 'with repeats' : 'no repeats'})`,
    );
    if (FAULT_ENABLED) {
      const rates = Object.entries(FAULT_RATES)
        .filter(([, v]) => (v ?? 0) > 0)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ');
      console.log(`[load] faults:      ${rates}${FAULT_SEED != null ? ` seed=${FAULT_SEED}` : ''}`);
    }
  });

  it(
    `run ${process.env.LOAD_N ?? '20'} investigations at concurrency ${process.env.LOAD_CONCURRENCY ?? '3'}`,
    async () => {
      const runStart = performance.now();
      const results: Investigation[] = [];

      // Semaphore-based concurrency. queue is an index generator; workers
      // pull from it until it's exhausted. Errors don't stop other workers.
      const indices = Array.from({ length: LOAD_N }, (_, i) => i);
      const queue = [...indices];

      async function worker(workerId: number): Promise<void> {
        while (queue.length > 0) {
          const index = queue.shift();
          if (index == null) return;
          const caseIdx = index % goldens.length;
          const golden = goldens[caseIdx];
          const started = performance.now();
          try {
            const inv = await runOneInvestigation(index, golden.caseId, golden.signalClass, golden, workerId);
            results.push(inv);
            console.log(
              `[load w${workerId}] investigation ${index + 1}/${LOAD_N} · ${golden.caseId} · ${inv.durationMs.total}ms · $${inv.costUsd.toFixed(3)}`,
            );
          } catch (err) {
            const dur = Math.round(performance.now() - started);
            const msg = err instanceof Error ? err.message : String(err);
            results.push({
              index,
              caseId: golden.caseId,
              signalClass: golden.signalClass,
              startedAt: started,
              durationMs: { investigate: 0, recommend: 0, total: dur },
              inputTokens: 0,
              outputTokens: 0,
              costUsd: 0,
              toolCallCount: 0,
              recommendationCount: 0,
              error: msg,
            });
            console.log(
              `[load w${workerId}] investigation ${index + 1}/${LOAD_N} · ${golden.caseId} · FAILED · ${dur}ms · ${msg.slice(0, 100)}`,
            );
          }
        }
      }

      const workers = Array.from({ length: LOAD_CONCURRENCY }, (_, i) => worker(i));
      await Promise.all(workers);

      const runMs = Math.round(performance.now() - runStart);

      // ─── aggregate + emit ───────────────────────────────────────────
      results.sort((a, b) => a.index - b.index);
      const receipt = buildReceipt(sharedRunId, runMs, results);

      const outPath = resolve(RECEIPTS_DIR, `load-${sharedRunId}.json`);
      writeFileSync(outPath, JSON.stringify(receipt, null, 2) + '\n', 'utf8');

      printSummary(receipt);

      expect(results.length).toBe(LOAD_N);
    },
    // per-investigation wall-clock × N / K + slack. At 250s each, K=3, N=20:
    // ≈ 20 × 250 / 3 = 1667s ≈ 28 min. Add slack for retries.
    Math.max(600_000, ((LOAD_N * 300_000) / LOAD_CONCURRENCY) * 1.5),
  );

  afterAll(() => {
    console.log(`[load] done. Receipt: eval/load-receipts/load-${sharedRunId}.json`);
  });
});

// ─── one investigation (no judge; agent + rec only) ──────────────────────────

async function runOneInvestigation(
  index: number,
  caseId: string,
  signalClass: string,
  golden: { anomaly: import('../lib/mcp/types').Anomaly },
  workerId: number,
): Promise<Investigation> {
  const started = performance.now();
  const baseDataSource = new SyntheticDataSource();
  // Wrap with fault injector if any rate > 0. Seed=index makes each
  // investigation reproducible; if FAULT_SEED is set globally, xorshift
  // is seeded from (base + index) so runs are deterministic yet unique
  // per investigation.
  const faultCounts: Record<string, number> = {};
  const dataSource = FAULT_ENABLED
    ? new FaultInjectingDataSource(baseDataSource, {
        rates: FAULT_RATES,
        seed: FAULT_SEED != null ? FAULT_SEED + index : undefined,
        onFault: (f) => {
          faultCounts[f.kind] = (faultCounts[f.kind] ?? 0) + 1;
        },
      })
    : baseDataSource;
  const schema = syntheticWorkspaceSchema;
  const listToolsRaw = await dataSource.listTools();
  const allTools = (listToolsRaw as { tools: McpToolDef[] }).tools;
  const sessionId = `load-${sharedRunId}-w${workerId}-i${index}`;
  const budget = new BudgetTracker({ maxCostUsd: BUDGET_PER_INVESTIGATION_USD });

  // Diagnose
  const t0d = performance.now();
  const diagnosisTrace: CapabilityEvent[] = [];
  const diagnosisToolCalls: ToolCall[] = [];
  const diagnostic = new DiagnosticAgent(sharedAnthropic, dataSource, schema, allTools, sessionId);
  const diagnosis = await diagnostic.investigate(golden.anomaly, {
    onCapabilityEvent: (ev) => diagnosisTrace.push(ev),
    onToolResult: (tc) => diagnosisToolCalls.push(tc),
    budget,
  });
  const investigateMs = Math.round(performance.now() - t0d);

  // Recommend
  const t0r = performance.now();
  const recommendationTrace: CapabilityEvent[] = [];
  const recommendationAgent = new RecommendationAgent(
    sharedAnthropic,
    dataSource,
    schema,
    allTools,
    sessionId,
  );
  const recommendations: Recommendation[] = await recommendationAgent.propose(golden.anomaly, diagnosis, {
    onCapabilityEvent: (ev) => recommendationTrace.push(ev),
    budget,
  });
  const recommendMs = Math.round(performance.now() - t0r);

  // Usage + cost
  const dUsage = summarizeUsage(diagnosisTrace);
  const rUsage = summarizeUsage(recommendationTrace);
  const dCost =
    estimateCost('anthropic', dUsage, 'claude-sonnet-4-6') ??
    estimateAnthropicCost(dUsage, 'claude-sonnet-4-6');
  const rCost =
    estimateCost('anthropic', rUsage, 'claude-sonnet-4-6') ??
    estimateAnthropicCost(rUsage, 'claude-sonnet-4-6');

  return {
    index,
    caseId,
    signalClass,
    startedAt: started,
    durationMs: {
      investigate: investigateMs,
      recommend: recommendMs,
      total: Math.round(performance.now() - started),
    },
    inputTokens: dUsage.inputTokens + rUsage.inputTokens,
    outputTokens: dUsage.outputTokens + rUsage.outputTokens,
    costUsd: (dCost?.totalCost ?? 0) + (rCost?.totalCost ?? 0),
    toolCallCount: diagnosisToolCalls.length,
    recommendationCount: recommendations.length,
    faultCounts: FAULT_ENABLED ? faultCounts : undefined,
  };
}

// ─── stats + summary ─────────────────────────────────────────────────────────

function percentiles(arr: readonly number[]): { p50: number; p95: number; p99: number; max: number; mean: number } {
  if (arr.length === 0) return { p50: 0, p95: 0, p99: 0, max: 0, mean: 0 };
  const sorted = [...arr].sort((a, b) => a - b);
  const pct = (p: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
  const mean = Math.round(sorted.reduce((s, n) => s + n, 0) / sorted.length);
  return { p50: pct(50), p95: pct(95), p99: pct(99), max: sorted[sorted.length - 1], mean };
}

function buildReceipt(runId: string, totalMs: number, results: Investigation[]) {
  const succeeded = results.filter((r) => !r.error);
  const failed = results.filter((r) => r.error);
  const durTotal = succeeded.map((r) => r.durationMs.total);
  const durDiag = succeeded.map((r) => r.durationMs.investigate);
  const durRec = succeeded.map((r) => r.durationMs.recommend);
  const cost = succeeded.map((r) => r.costUsd);
  const tokens = succeeded.map((r) => r.inputTokens + r.outputTokens);

  // Aggregate fault counts across all investigations
  const faultTotals: Record<string, number> = {};
  for (const inv of results) {
    if (!inv.faultCounts) continue;
    for (const [k, v] of Object.entries(inv.faultCounts)) {
      faultTotals[k] = (faultTotals[k] ?? 0) + v;
    }
  }

  return {
    runId,
    finishedAt: new Date().toISOString(),
    config: {
      N: LOAD_N,
      concurrency: LOAD_CONCURRENCY,
      budgetPerInvestigationUsd: BUDGET_PER_INVESTIGATION_USD,
      faultRates: FAULT_ENABLED ? FAULT_RATES : undefined,
      faultSeed: FAULT_SEED,
    },
    totalMs,
    succeeded: succeeded.length,
    failed: failed.length,
    faultTotals: FAULT_ENABLED ? faultTotals : undefined,
    percentilesMs: {
      total: percentiles(durTotal),
      investigate: percentiles(durDiag),
      recommend: percentiles(durRec),
    },
    costUsd: {
      total: cost.reduce((s, c) => s + c, 0),
      perInvestigationP50: percentiles(cost).p50,
      perInvestigationP95: percentiles(cost).p95,
      perInvestigationMax: percentiles(cost).max,
    },
    tokens: {
      totalIn: succeeded.reduce((s, r) => s + r.inputTokens, 0),
      totalOut: succeeded.reduce((s, r) => s + r.outputTokens, 0),
      perInvestigationP50: percentiles(tokens).p50,
    },
    investigations: results,
  };
}

function printSummary(r: ReturnType<typeof buildReceipt>): void {
  console.error(`\n╔══════════════════════════════════════════════════════════════════════════════╗`);
  console.error(`║ Phase-4 load-harness receipt                                                ║`);
  console.error(`╚══════════════════════════════════════════════════════════════════════════════╝`);
  console.error(`\nrunId:           ${r.runId}`);
  console.error(`N:               ${r.config.N}  (concurrency ${r.config.concurrency})`);
  console.error(`Wall clock:      ${Math.round(r.totalMs / 1000)}s`);
  console.error(`Succeeded:       ${r.succeeded}`);
  console.error(`Failed:          ${r.failed}`);
  console.error(`\nDuration (ms) across investigations`);
  console.error('─'.repeat(78));
  const lat = r.percentilesMs;
  for (const [phase, p] of Object.entries(lat)) {
    console.error(
      `  ${phase.padEnd(14)}  p50 ${String(p.p50).padStart(6)}  p95 ${String(p.p95).padStart(6)}  p99 ${String(p.p99).padStart(6)}  max ${String(p.max).padStart(6)}  mean ${String(p.mean).padStart(6)}`,
    );
  }
  console.error(`\nCost`);
  console.error('─'.repeat(78));
  console.error(`  Total spend:            $${r.costUsd.total.toFixed(3)}`);
  console.error(`  Per investigation p50:  $${r.costUsd.perInvestigationP50.toFixed(3)}`);
  console.error(`  Per investigation p95:  $${r.costUsd.perInvestigationP95.toFixed(3)}`);
  console.error(`  Per investigation max:  $${r.costUsd.perInvestigationMax.toFixed(3)}`);
  console.error(`\nTokens`);
  console.error('─'.repeat(78));
  console.error(`  Total in:  ${r.tokens.totalIn.toLocaleString()}   Total out: ${r.tokens.totalOut.toLocaleString()}`);
  console.error(`  p50 per investigation: ${r.tokens.perInvestigationP50.toLocaleString()}`);

  if (r.faultTotals) {
    console.error(`\nFault injections (per-error-type totals)`);
    console.error('─'.repeat(78));
    for (const [kind, count] of Object.entries(r.faultTotals)) {
      console.error(`  ${kind.padEnd(20)}  ${count}`);
    }
  }
  if (r.failed > 0) {
    console.error(`\nInvestigation failures`);
    console.error('─'.repeat(78));
    for (const inv of r.investigations.filter((i) => i.error)) {
      console.error(`  #${inv.index + 1} ${inv.caseId} · ${inv.error?.slice(0, 80)}`);
    }
  }
  console.error('');
}
