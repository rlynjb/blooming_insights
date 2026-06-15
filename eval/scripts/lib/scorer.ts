// eval/scripts/lib/scorer.ts
//
// Detection scorer for the 3 seeded Olist anomalies. Implements BOTH a LOOSE
// and STRICT match per the phase-3 plan — same `MatchResult` records used for
// either; the only difference is whether 2-of-3 criteria (loose) or 3-of-3
// (strict) flip a match into a true positive.
//
// The matcher is itself an artifact: every heuristic here is documented inline
// because the recruiter narrative will be cross-examined on how "precision /
// recall" got computed. Conservative bias — we'd rather under-credit a real
// match than over-credit a coincidence; the LOOSE bucket is the optimistic
// ceiling, STRICT is the recruiter number.

import type { Anomaly } from '../../../lib/mcp/types';

// ---------------------------------------------------------------------------
// Seeded anomaly shape — mirrors the `seeded_anomalies` table (see
// mcp-server-olist/scripts/seed-olist.ts).
// ---------------------------------------------------------------------------

export interface SeededAnomaly {
  id: string;
  metric: string;     // 'revenue' | 'order_count' | 'payment_value'
  dimension: string;  // 'state' | 'category' | 'payment_type'
  segment: string;    // 'SP' | 'electronics' | 'voucher'
  start_ts: number;   // unix seconds
  end_ts: number;     // unix seconds
  expected_severity: string;
  description: string;
}

export type Criterion = 'metric' | 'segment' | 'time';

export interface MatchResult {
  /** Index into the run's insight array. */
  insight_idx: number;
  /** Which seeded anomaly this insight matched against (best/first match). */
  anomaly_id: string;
  matched_criteria: Criterion[];
  /** 2+ criteria matched. */
  is_loose_match: boolean;
  /** All 3 criteria matched. */
  is_strict_match: boolean;
}

export interface ScoreSummary {
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  /** TP / (TP + FP); 0 when no insights were emitted. */
  precision: number;
  /** TP / 3 (the seeded anomaly count is constant). */
  recall: number;
}

export interface ScoreRunResult {
  loose: ScoreSummary;
  strict: ScoreSummary;
  /** One MatchResult per insight (whether it matched or not, in insight order).
   *  Unmatched insights still appear with empty `matched_criteria`. */
  matches: MatchResult[];
}

// ---------------------------------------------------------------------------
// Heuristic 1: metric overlap.
//
// The seeded metrics are 'revenue', 'order_count', 'payment_value'. The agent
// emits `metric` as a snake_case slug (per the monitoring prompt — examples
// include `revenue`, `order_count`, `payment_value`, `purchase_revenue`,
// `conversion_rate`). We accept:
//   (a) exact equality (revenue === revenue), OR
//   (b) the seeded metric word appears in the insight's headline / summary /
//       impact text — case-insensitive, word-boundary anchored so "revenue"
//       doesn't false-match "irrelevant" but does match "revenue_drop" or
//       "Revenue (SP)".
//
// We also fold a handful of obvious near-synonyms to widen recall under LOOSE
// without bleeding false-matches in STRICT:
//   - 'payment_value' ↔ 'payment value' / 'voucher value' / 'payment_value'
//   - 'order_count'   ↔ 'order count' / 'orders' / 'order_count'
//   - 'revenue'       ↔ 'revenue' / 'sales' (Olist agents narrate "sales drop"
//                       interchangeably with "revenue drop")
// ---------------------------------------------------------------------------
const METRIC_ALIASES: Record<string, string[]> = {
  revenue: ['revenue', 'sales', 'gmv'],
  order_count: ['order_count', 'order count', 'orders', 'order volume'],
  payment_value: ['payment_value', 'payment value', 'payments'],
};

function metricMatches(insight: Anomaly, seeded: SeededAnomaly): boolean {
  const aliases = METRIC_ALIASES[seeded.metric] ?? [seeded.metric];
  // (a) exact metric slug
  if (insight.metric && insight.metric.toLowerCase() === seeded.metric) return true;
  // (a') the insight metric is itself one of the aliases (e.g. 'sales')
  if (insight.metric && aliases.includes(insight.metric.toLowerCase())) return true;
  // (b) word-boundary mention in narrative fields. We DON'T include `evidence`
  //     since the agent often copies the tool name into evidence whether or
  //     not the diagnosis is really about that metric.
  const haystack = [
    insight.impact ?? '',
    ...(insight.scope ?? []),
    insight.change?.baseline ?? '',
  ].join(' ').toLowerCase();
  return aliases.some((a) => new RegExp(`\\b${escapeRegExp(a)}\\b`).test(haystack));
}

// ---------------------------------------------------------------------------
// Heuristic 2: segment overlap.
//
// Insight.scope is the load-bearing field — the prompt teaches the agent to
// emit `state:SP`, `category:electronics`, `payment_type:voucher` strings. We
// match any scope entry that contains the seeded segment word (case-insens.).
// Fallback: scan impact + metric slug + scope-as-text for the segment word at
// a word boundary, so an insight that says "São Paulo revenue dropped 30%" but
// forgot to populate scope still scores as a match.
// ---------------------------------------------------------------------------
const SEGMENT_ALIASES: Record<string, string[]> = {
  SP: ['sp', 'são paulo', 'sao paulo', 'state:sp'],
  electronics: ['electronics', 'category:electronics'],
  voucher: ['voucher', 'vouchers', 'payment_type:voucher'],
};

function segmentMatches(insight: Anomaly, seeded: SeededAnomaly): boolean {
  const aliases = SEGMENT_ALIASES[seeded.segment] ?? [seeded.segment.toLowerCase()];
  const scopeText = (insight.scope ?? []).join(' ').toLowerCase();
  const haystack = [
    scopeText,
    (insight.impact ?? '').toLowerCase(),
    (insight.metric ?? '').toLowerCase(),
  ].join(' ');
  return aliases.some((a) => {
    // word-boundary for ASCII; substring for multi-word / non-ASCII aliases
    // (regex `\b` does not behave well around accented characters).
    if (/^[a-z0-9_:\- ]+$/.test(a)) {
      return new RegExp(`\\b${escapeRegExp(a)}\\b`).test(haystack);
    }
    return haystack.includes(a);
  });
}

// ---------------------------------------------------------------------------
// Heuristic 3: time-window overlap.
//
// The monitoring prompt teaches 90d-vs-prior-90d windows with `baseline: "90d"`,
// not explicit start/end dates — so insights don't typically carry the
// anomaly's calendar week directly. We use a fuzzy mention check:
//
//   - If the insight's impact / scope text mentions any of the dates inside
//     the anomaly window (or within ±7 days), or an explicit week phrasing
//     ("week N", "in week N of...") that matches the anomaly's week index,
//     we count it as a time match.
//   - As a wider fallback for the LOOSE bucket: any insight that uses the
//     `90d` baseline AND whose anomaly window is within the LAST 90 DAYS of
//     END_TS counts as a time match. This is generous on purpose — most of
//     the seeded anomalies DO sit in the last 90 days of the simulated data,
//     so a 90d-baseline insight is plausibly observing them.
//
// END_TS for the seeded dataset is 2026-06-01 00:00 UTC; we read each
// anomaly's start_ts/end_ts and compute their week index 1..26 (week 1 starts
// at START_TS = END_TS - 26 weeks).
// ---------------------------------------------------------------------------
const DATASET_END_TS = Math.floor(Date.UTC(2026, 5, 1) / 1000);
const DATASET_TOTAL_WEEKS = 26;
const DATASET_START_TS = DATASET_END_TS - DATASET_TOTAL_WEEKS * 7 * 86400;

function weekIndex(ts: number): number {
  return Math.floor((ts - DATASET_START_TS) / (7 * 86400)) + 1;
}

function timeMatches(insight: Anomaly, seeded: SeededAnomaly): boolean {
  const haystack = [
    insight.impact ?? '',
    insight.change?.baseline ?? '',
    ...(insight.scope ?? []),
  ].join(' ').toLowerCase();

  // Explicit week reference: the anomaly spans these week indices.
  const startWk = weekIndex(seeded.start_ts);
  const endWk = weekIndex(seeded.end_ts - 1); // end_ts is exclusive
  for (let wk = startWk; wk <= endWk; wk++) {
    if (new RegExp(`\\bweek\\s*${wk}\\b`).test(haystack)) return true;
  }

  // Date mention inside the anomaly window (±7 days).
  const PADDED_START = seeded.start_ts - 7 * 86400;
  const PADDED_END = seeded.end_ts + 7 * 86400;
  // Look for YYYY-MM-DD tokens in the haystack and see if any falls in range.
  const dateMatches = haystack.match(/\b(\d{4}-\d{2}-\d{2})\b/g) ?? [];
  for (const d of dateMatches) {
    const ts = Math.floor(new Date(`${d}T00:00:00Z`).getTime() / 1000);
    if (ts >= PADDED_START && ts <= PADDED_END) return true;
  }

  // LOOSE fallback: a 90d-baseline insight observing an anomaly that lives in
  // the last 90 days of the dataset is plausibly catching it. This widens
  // recall under LOOSE; STRICT will still require an explicit overlap below
  // (which is why we set this branch behind a separate flag callers can
  // disable for STRICT).
  return looseTimeFallback(insight, seeded);
}

function looseTimeFallback(insight: Anomaly, seeded: SeededAnomaly): boolean {
  if (insight.change?.baseline !== '90d') return false;
  const ninetyDaysBeforeEnd = DATASET_END_TS - 90 * 86400;
  return seeded.end_ts >= ninetyDaysBeforeEnd;
}

// ---------------------------------------------------------------------------
// Per-insight matching: find the SINGLE best seeded anomaly this insight
// matches against (most criteria first; ties broken by anomaly_id alphabet).
// An insight is assigned to at most one seeded anomaly so we don't double-count
// a single insight as "matched all three" — that would let one verbose insight
// drown out the three-anomaly recall ceiling.
//
// The STRICT path disables `looseTimeFallback` so that a 90d-baseline insight
// without an explicit week/date mention does NOT get a free time credit.
// ---------------------------------------------------------------------------
function scoreInsight(
  insight: Anomaly,
  insightIdx: number,
  anomalies: SeededAnomaly[],
  options: { strict: boolean },
): MatchResult {
  let best: MatchResult = {
    insight_idx: insightIdx,
    anomaly_id: '',
    matched_criteria: [],
    is_loose_match: false,
    is_strict_match: false,
  };

  for (const a of [...anomalies].sort((x, y) => x.id.localeCompare(y.id))) {
    const criteria: Criterion[] = [];
    if (metricMatches(insight, a)) criteria.push('metric');
    if (segmentMatches(insight, a)) criteria.push('segment');
    if (timeMatchesForMode(insight, a, options.strict)) criteria.push('time');
    if (criteria.length > best.matched_criteria.length) {
      best = {
        insight_idx: insightIdx,
        anomaly_id: a.id,
        matched_criteria: criteria,
        is_loose_match: criteria.length >= 2,
        is_strict_match: criteria.length >= 3,
      };
    }
  }
  return best;
}

function timeMatchesForMode(
  insight: Anomaly,
  seeded: SeededAnomaly,
  strict: boolean,
): boolean {
  if (strict) {
    // STRICT: must have an explicit week/date mention. Re-run timeMatches
    // logic without the loose fallback.
    const haystack = [
      insight.impact ?? '',
      insight.change?.baseline ?? '',
      ...(insight.scope ?? []),
    ].join(' ').toLowerCase();
    const startWk = weekIndex(seeded.start_ts);
    const endWk = weekIndex(seeded.end_ts - 1);
    for (let wk = startWk; wk <= endWk; wk++) {
      if (new RegExp(`\\bweek\\s*${wk}\\b`).test(haystack)) return true;
    }
    const PADDED_START = seeded.start_ts - 7 * 86400;
    const PADDED_END = seeded.end_ts + 7 * 86400;
    const dateMatches = haystack.match(/\b(\d{4}-\d{2}-\d{2})\b/g) ?? [];
    for (const d of dateMatches) {
      const ts = Math.floor(new Date(`${d}T00:00:00Z`).getTime() / 1000);
      if (ts >= PADDED_START && ts <= PADDED_END) return true;
    }
    return false;
  }
  return timeMatches(insight, seeded);
}

// ---------------------------------------------------------------------------
// scoreRun — top-level entry. Computes loose + strict ScoreSummary plus the
// per-insight MatchResult array for the per-anomaly aggregator.
// ---------------------------------------------------------------------------
export function scoreRun(
  insights: Anomaly[],
  anomalies: SeededAnomaly[],
): ScoreRunResult {
  const looseMatches = insights.map((ins, i) =>
    scoreInsight(ins, i, anomalies, { strict: false }),
  );
  const strictMatches = insights.map((ins, i) =>
    scoreInsight(ins, i, anomalies, { strict: true }),
  );

  return {
    loose: summarize(looseMatches, anomalies, 'loose'),
    strict: summarize(strictMatches, anomalies, 'strict'),
    // Return the loose matches for per-insight provenance — the strict view's
    // detection-rate table is derived from `summarize(strictMatches, ...)`. The
    // raw run dump also includes strictMatches for parity (see run-detection).
    matches: looseMatches,
  };
}

function summarize(
  matches: MatchResult[],
  anomalies: SeededAnomaly[],
  mode: 'loose' | 'strict',
): ScoreSummary {
  const matchedSet = new Set<string>();
  let truePositives = 0;
  let falsePositives = 0;

  for (const m of matches) {
    const isMatch = mode === 'loose' ? m.is_loose_match : m.is_strict_match;
    if (isMatch) {
      truePositives++;
      matchedSet.add(m.anomaly_id);
    } else {
      falsePositives++;
    }
  }
  const falseNegatives = anomalies.length - matchedSet.size;
  const precision =
    truePositives + falsePositives === 0 ? 0 : truePositives / (truePositives + falsePositives);
  // Recall denom = anomaly count (3), not TP-unique-set, so multiple insights
  // hitting the same anomaly don't artificially inflate recall.
  const recall = matchedSet.size / anomalies.length;

  return { truePositives, falsePositives, falseNegatives, precision, recall };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Convenience for the run-detection driver: return which seeded anomaly ids
 *  were "detected" in a given mode for a single run. Used by the per-anomaly
 *  aggregator. */
export function detectedAnomalies(
  matches: MatchResult[],
  mode: 'loose' | 'strict',
): Set<string> {
  const set = new Set<string>();
  for (const m of matches) {
    const isMatch = mode === 'loose' ? m.is_loose_match : m.is_strict_match;
    if (isMatch && m.anomaly_id) set.add(m.anomaly_id);
  }
  return set;
}

/** Re-export strict-mode matches alongside loose for the audit dump. */
export function strictMatchesFor(
  insights: Anomaly[],
  anomalies: SeededAnomaly[],
): MatchResult[] {
  return insights.map((ins, i) => scoreInsight(ins, i, anomalies, { strict: true }));
}
