// eval/scripts/lib/summary.ts
//
// Aggregator over K runs. Reports mean + std for precision / recall / false
// positives for each match mode (loose, strict), plus per-anomaly detection
// counts (out of K).
//
// Standard deviation is the population stddev — `sqrt(mean(sq) - mean^2)`,
// matching the phase-3 plan's specified formula. We don't bother with sample
// (N-1) stddev: K is small (10–30) and the recruiter narrative reads the
// number as a spread, not a population estimate.

import type { ScoreRunResult, SeededAnomaly } from './scorer';
import { detectedAnomalies, strictMatchesFor } from './scorer';
import type { Anomaly } from '../../../lib/mcp/types';

export interface PerRunScore {
  runIndex: number;
  durationMs: number;
  error?: string;
  insights: Anomaly[];
  score: ScoreRunResult;
  /** Captured for the raw audit dump — args only, results stripped by the
   *  driver to keep the file readable. */
  toolCalls?: { toolName: string; args: Record<string, unknown> }[];
  /** Captured for the raw audit dump — free-text reasoning blocks the agent
   *  surfaced through `onText`. */
  reasoning?: string[];
}

export interface ModeAggregate {
  precision_mean: number;
  precision_std: number;
  recall_mean: number;
  recall_std: number;
  fp_mean: number;
  fp_std: number;
}

export interface PerAnomalyAggregate {
  detected_count: number;
  detection_rate: number;
}

export interface RunSummary {
  K: number;
  errored_runs: number;
  total_duration_ms: number;
  loose: ModeAggregate;
  strict: ModeAggregate;
  /** Keyed by anomaly id. STRICT-mode rates by default (the recruiter number);
   *  the loose view is on `per_anomaly_loose`. */
  per_anomaly_strict: Record<string, PerAnomalyAggregate>;
  per_anomaly_loose: Record<string, PerAnomalyAggregate>;
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function popStd(xs: number[]): number {
  if (xs.length === 0) return 0;
  const m = mean(xs);
  const sqMean = mean(xs.map((x) => x * x));
  const variance = Math.max(0, sqMean - m * m); // clamp tiny negative from fp drift
  return Math.sqrt(variance);
}

export function aggregate(
  runs: PerRunScore[],
  anomalies: SeededAnomaly[],
): RunSummary {
  // Only count runs that didn't error in the aggregate; errored runs are
  // counted separately so the recruiter narrative can disclose them honestly.
  const successful = runs.filter((r) => !r.error);
  const errored = runs.length - successful.length;

  const looseAgg = aggregateMode(successful, 'loose');
  const strictAgg = aggregateMode(successful, 'strict');

  const perAnomalyLoose = perAnomaly(successful, anomalies, 'loose');
  const perAnomalyStrict = perAnomaly(successful, anomalies, 'strict');

  return {
    K: runs.length,
    errored_runs: errored,
    total_duration_ms: runs.reduce((a, r) => a + r.durationMs, 0),
    loose: looseAgg,
    strict: strictAgg,
    per_anomaly_strict: perAnomalyStrict,
    per_anomaly_loose: perAnomalyLoose,
  };
}

function aggregateMode(runs: PerRunScore[], mode: 'loose' | 'strict'): ModeAggregate {
  const precisions: number[] = [];
  const recalls: number[] = [];
  const fps: number[] = [];
  for (const r of runs) {
    const view = mode === 'loose' ? r.score.loose : r.score.strict;
    precisions.push(view.precision);
    recalls.push(view.recall);
    fps.push(view.falsePositives);
  }
  return {
    precision_mean: mean(precisions),
    precision_std: popStd(precisions),
    recall_mean: mean(recalls),
    recall_std: popStd(recalls),
    fp_mean: mean(fps),
    fp_std: popStd(fps),
  };
}

function perAnomaly(
  runs: PerRunScore[],
  anomalies: SeededAnomaly[],
  mode: 'loose' | 'strict',
): Record<string, PerAnomalyAggregate> {
  const out: Record<string, PerAnomalyAggregate> = {};
  for (const a of anomalies) {
    let detected = 0;
    for (const r of runs) {
      // Score.matches is the LOOSE match record (per scoreRun). For the strict
      // view we recompute strict matches from insights — the cost is tiny and
      // keeps the summary tier from depending on which record `score.matches`
      // refers to.
      const set =
        mode === 'loose'
          ? detectedAnomalies(r.score.matches, 'loose')
          : detectedAnomalies(strictMatchesFor(r.insights, anomalies), 'strict');
      if (set.has(a.id)) detected++;
    }
    out[a.id] = {
      detected_count: detected,
      detection_rate: runs.length === 0 ? 0 : detected / runs.length,
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Human-readable summary.md renderer. The recruiter narrative pulls from this.
// ---------------------------------------------------------------------------

export function renderSummaryMarkdown(args: {
  date: string;
  K: number;
  summary: RunSummary;
  anomalies: SeededAnomaly[];
  totalAnthropicSpendUsd?: number;
  totalRuntimeSeconds: number;
}): string {
  const { date, K, summary, anomalies, totalRuntimeSeconds } = args;
  const spendLine = args.totalAnthropicSpendUsd != null
    ? `Total Anthropic spend: ~$${args.totalAnthropicSpendUsd.toFixed(2)}`
    : 'Total Anthropic spend: (not tracked — read the dashboard)';

  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const pctStd = (x: number) => `±${(x * 100).toFixed(1)}%`;
  const num = (x: number) => x.toFixed(1);
  const numStd = (x: number) => `±${x.toFixed(1)}`;

  const totalRuntime = formatDuration(totalRuntimeSeconds);
  const erroredLine = summary.errored_runs > 0
    ? `\nErrored runs: ${summary.errored_runs} of ${summary.K} (excluded from aggregate)`
    : '';

  const perAnomalyRows = anomalies
    .map((a) => {
      const s = summary.per_anomaly_strict[a.id];
      const l = summary.per_anomaly_loose[a.id];
      return `| ${a.id} | ${s.detected_count}/${K} (${pct(s.detection_rate)}) | ${l.detected_count}/${K} (${pct(l.detection_rate)}) |`;
    })
    .join('\n');

  return `# Detection eval — ${date} (K=${K})

Run with Sonnet 4.6, OlistDataSource live, on 3 seeded anomalies.${erroredLine}

## Aggregate

| Metric            | Loose (2-of-3)  | Strict (3-of-3) |
|---|---|---|
| Precision (mean)  | ${pct(summary.loose.precision_mean)} | ${pct(summary.strict.precision_mean)} |
| Precision (std)   | ${pctStd(summary.loose.precision_std)} | ${pctStd(summary.strict.precision_std)} |
| Recall (mean)     | ${pct(summary.loose.recall_mean)} | ${pct(summary.strict.recall_mean)} |
| Recall (std)      | ${pctStd(summary.loose.recall_std)} | ${pctStd(summary.strict.recall_std)} |
| False positives   | ${num(summary.loose.fp_mean)} ${numStd(summary.loose.fp_std)} | ${num(summary.strict.fp_mean)} ${numStd(summary.strict.fp_std)} |

## Per anomaly

| Anomaly                       | Detected (strict) | Detected (loose) |
|---|---|---|
${perAnomalyRows}

${spendLine}
Total runtime: ${totalRuntime}
`;
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}
