// eval/scripts/lib/anomaly-to-insight.ts
//
// Path-C bypass: convert a seeded-anomaly row (the SQLite ground truth in
// mcp-server-olist/scripts/seed-olist.ts) into the Anomaly shape that
// `DiagnosticAgent.investigate()` expects.
//
// Why: PR D's detection eval showed monitoring upstream is the bottleneck
// (~33% loose recall, 0% strict). Scoring the diagnostic agent through the
// monitoring stage would only diagnose anomalies that happened to be
// detected — a biased sample. By converting the seeded metadata DIRECTLY
// to a diagnostic Anomaly input, we isolate diagnosis quality from
// detection coverage.
//
// The Anomaly type used by DiagnosticAgent is from `lib/mcp/types.ts`:
//
//   interface Anomaly {
//     metric: string;                             // 'revenue' | 'order_count' | 'payment_value'
//     scope: string[];                            // ['state:SP'] etc.
//     change: { value: number; direction: 'up'|'down'; baseline: string };
//     severity: Severity;                         // 'critical' | 'warning' | 'info' | 'positive'
//     evidence: { tool: string; result: unknown }[]; // can be empty
//     impact?: string;                            // optional one-line business impact
//     history?: number[];                         // not used for diagnostic
//     category?: CategoryId;                      // not used for diagnostic
//   }
//
// The diagnostic prompt interpolates `{anomaly}` (JSON.stringify of this
// object) into its system text — so any field we set is visible to the model.

import type { Anomaly, Severity } from '../../../lib/mcp/types';
import type { SeededAnomaly } from './scorer';

/** Map seeded `dimension` to the `scope` prefix the monitoring agent uses
 *  in production. Mirrors the scope shape the diagnostic prompt is trained
 *  to read (`state:SP`, `category:electronics`, `payment_type:voucher`). */
function dimensionToScopePrefix(dimension: string): string {
  switch (dimension) {
    case 'state':
      return 'state';
    case 'category':
      return 'category';
    case 'payment_type':
      return 'payment_type';
    default:
      return dimension;
  }
}

/** Convert a multiplier (e.g., 0.7 = 30% drop, 2.5 = 150% spike, 0.05 = 95% drop)
 *  into the `change` shape the production Anomaly carries. The diagnostic prompt
 *  reads `change.value` (a percent magnitude) + `change.direction` ('up' | 'down')
 *  + `change.baseline` (a description of the comparison window). */
function multiplierToChange(
  multiplier: number,
  baseline: string,
): Anomaly['change'] {
  const direction: 'up' | 'down' = multiplier >= 1 ? 'up' : 'down';
  // For mult=0.7 we want value=30 (down 30%); for mult=2.5 we want value=150
  // (up 150%); for mult=0.05 we want value=95 (down 95%).
  const pctMagnitude =
    multiplier >= 1
      ? Math.round((multiplier - 1) * 100)
      : Math.round((1 - multiplier) * 100);
  return { value: pctMagnitude, direction, baseline };
}

/** Convert the seeded anomaly's start_ts/end_ts (unix seconds) into a
 *  human-readable baseline string ("week 4 (2025-12-22)"). Mirrors the
 *  `change.baseline` text the diagnostic prompt's `{anomaly}` block carries. */
function buildBaselineLabel(
  seeded: SeededAnomaly,
  startIso: string,
  endIso: string,
): string {
  // Compute week index in the 26-week horizon (week 1 = first 7 days from
  // dataset start). Mirrors weekIndex() in seed-olist.ts and scorer.ts.
  const DATASET_START_TS = Math.floor(Date.UTC(2025, 11, 1) / 1000); // 2025-12-01
  const wkStart = Math.floor((seeded.start_ts - DATASET_START_TS) / (7 * 86400)) + 1;
  const wkEnd = Math.floor((seeded.end_ts - 1 - DATASET_START_TS) / (7 * 86400)) + 1;
  const weekLabel = wkStart === wkEnd ? `week ${wkStart}` : `weeks ${wkStart}-${wkEnd}`;
  return `${weekLabel} (${startIso} to ${endIso}) vs 12-week baseline`;
}

/** One-line business-impact framing for the `impact` field. Picks language
 *  the diagnostic prompt sees in production-shaped Anomaly objects (the
 *  monitoring agent narrates "Revenue in SP dropped 30% — investigate root
 *  cause" style summaries). */
function buildImpact(
  seeded: SeededAnomaly,
  change: Anomaly['change'],
): string {
  const direction = change.direction === 'down' ? 'fell' : 'rose';
  return (
    `${seeded.metric} for ${seeded.dimension}:${seeded.segment} ${direction} ` +
    `~${change.value}% in ${seeded.dimension === 'payment_type' && change.direction === 'down' && change.value >= 80
      ? 'a sustained dropoff'
      : 'a discrete window'}. ` +
    `Investigate the root cause.`
  );
}

/**
 * Convert a seeded anomaly (DB-shape, ground truth) into the Anomaly input
 * `DiagnosticAgent.investigate()` expects.
 *
 * `evidence` is intentionally an empty array — the diagnostic agent's job is
 * to gather its own evidence via tool calls; we don't pre-seed any. This is
 * the same shape the production monitoring agent sometimes emits (insights
 * with `evidence: []` when an Olist-fallback scan didn't capture per-insight
 * tool outputs).
 *
 * The diagnostic prompt sees the JSON-serialized anomaly via the `{anomaly}`
 * interpolation — so every field set here is visible to the model.
 */
export function seededToAnomaly(seeded: SeededAnomaly): Anomaly {
  const scopePrefix = dimensionToScopePrefix(seeded.dimension);
  const scope = [`${scopePrefix}:${seeded.segment}`];

  // Multiplier sourced from the seed script — pinned per seeded anomaly id so
  // we don't lose this field when round-tripping through SQLite (the DB only
  // stores the description, not the multiplier).
  const multiplier = MULTIPLIERS_BY_ID[seeded.id];
  if (multiplier == null) {
    throw new Error(
      `seededToAnomaly: unknown seeded anomaly id ${seeded.id}; add multiplier to MULTIPLIERS_BY_ID.`,
    );
  }

  const startIso = new Date(seeded.start_ts * 1000).toISOString().slice(0, 10);
  const endIso = new Date(seeded.end_ts * 1000).toISOString().slice(0, 10);
  const baseline = buildBaselineLabel(seeded, startIso, endIso);

  const change = multiplierToChange(multiplier, baseline);
  const severity = seeded.expected_severity as Severity;

  return {
    metric: seeded.metric,
    scope,
    change,
    severity,
    evidence: [],
    impact: buildImpact(seeded, change),
  };
}

/** Pinned ground-truth multipliers — mirrors `_generator.value` in
 *  seed-olist.ts. Kept here so the eval driver doesn't have to import the
 *  seed script (which would pull in the entire mcp-server-olist package). */
const MULTIPLIERS_BY_ID: Record<string, number> = {
  'sp-revenue-drop-w4': 0.7,
  'electronics-spike-w2': 2.5,
  'voucher-dropoff-w10-on': 0.05,
};

export { MULTIPLIERS_BY_ID };
