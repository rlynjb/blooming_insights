// mcp-server-olist/test/tools/get_anomaly_context.test.ts
//
// The seeded anomalies are the ground truth here — these tests assert the tool
// correctly surfaces the planted SP-revenue drop in week 4 and friends.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb, epochToIsoDate } from '../../src/db';
import * as tool from '../../src/tools/get_anomaly_context';

let db: Database.Database;

/** Pull the seeded anomaly metadata so we ask the tool about the EXACT window
 *  the generator planted. The tool has no special-case knowledge of the
 *  seeded_anomalies table — it queries the live data. */
function getSeededAnomaly(id: string): {
  metric: 'revenue' | 'order_count' | 'payment_value';
  dimension: 'state' | 'category' | 'payment_type';
  segment: string;
  start_ts: number;
  end_ts: number;
} {
  const row = db
    .prepare(
      'SELECT metric, dimension, segment, start_ts, end_ts FROM seeded_anomalies WHERE id = ?',
    )
    .get(id) as {
    metric: 'revenue' | 'order_count' | 'payment_value';
    dimension: 'state' | 'category' | 'payment_type';
    segment: string;
    start_ts: number;
    end_ts: number;
  };
  return row;
}

beforeAll(() => {
  db = openDb();
});
afterAll(() => {
  db.close();
});

describe('get_anomaly_context — input validation', () => {
  it('rejects missing required fields', () => {
    const v = tool.validateInput({});
    expect(typeof v).toBe('string');
  });
  it('rejects unknown metric', () => {
    const v = tool.validateInput({
      metric: 'profit',
      dimension: 'state',
      segment: 'SP',
      anomaly_window: { from: '2026-01-01', to: '2026-01-08' },
      baseline_window: { from: '2025-10-01', to: '2026-01-01' },
    });
    expect(typeof v).toBe('string');
  });
});

/** Build a baseline window that's the longest stretch INSIDE the data horizon
 *  but doesn't overlap the anomaly window. For week-4 anomalies the baseline
 *  is weeks 5..end; for sustained anomalies starting at week N the baseline is
 *  weeks 1..N. The data horizon is 2025-12-01 .. 2026-06-01. */
function baselineOutsideAnomaly(
  anomalyStartTs: number,
  anomalyEndTs: number,
): { from: string; to: string } {
  const HORIZON_START = Math.floor(Date.UTC(2025, 11, 1) / 1000); // 2025-12-01
  const HORIZON_END = Math.floor(Date.UTC(2026, 5, 1) / 1000); // 2026-06-01
  // Use the stretch AFTER the anomaly window when it's long enough; otherwise
  // use the stretch before.
  const afterLen = HORIZON_END - anomalyEndTs;
  const beforeLen = anomalyStartTs - HORIZON_START;
  if (afterLen >= beforeLen) {
    return { from: epochToIsoDate(anomalyEndTs), to: epochToIsoDate(HORIZON_END) };
  }
  return { from: epochToIsoDate(HORIZON_START), to: epochToIsoDate(anomalyStartTs) };
}

describe('get_anomaly_context — SP revenue drop (week 4)', () => {
  it('detects ~30% drop in SP revenue vs baseline', () => {
    const a = getSeededAnomaly('sp-revenue-drop-w4');
    // Baseline: weeks 5..26 (post-anomaly stretch is largest inside horizon)
    const out = tool.execute(db, {
      metric: a.metric,
      dimension: a.dimension,
      segment: a.segment,
      anomaly_window: { from: epochToIsoDate(a.start_ts), to: epochToIsoDate(a.end_ts) },
      baseline_window: baselineOutsideAnomaly(a.start_ts, a.end_ts),
    });
    // The generator dropped 30% of SP orders in week 4. The metric is revenue,
    // and revenue is roughly proportional to surviving order count → expect a
    // drop within a generous window around -30% (synthetic noise allows ±15%).
    expect(out.anomaly_summary.metric).toBe('revenue');
    expect(out.anomaly_summary.segment).toBe('SP');
    expect(out.anomaly_summary.pct_change).toBeLessThan(-0.15);
    expect(out.anomaly_summary.pct_change).toBeGreaterThan(-0.55);
  });

  it('includes related segments (other states)', () => {
    const a = getSeededAnomaly('sp-revenue-drop-w4');
    const out = tool.execute(db, {
      metric: a.metric,
      dimension: a.dimension,
      segment: a.segment,
      anomaly_window: { from: epochToIsoDate(a.start_ts), to: epochToIsoDate(a.end_ts) },
      baseline_window: baselineOutsideAnomaly(a.start_ts, a.end_ts),
    });
    expect(out.related_segments.length).toBeGreaterThan(5);
    // None of the related segments is SP itself.
    expect(out.related_segments.find((r) => r.name === 'SP')).toBeUndefined();
  });

  it('returns up to 10 sample orders from the anomaly window', () => {
    const a = getSeededAnomaly('sp-revenue-drop-w4');
    const out = tool.execute(db, {
      metric: a.metric,
      dimension: a.dimension,
      segment: a.segment,
      anomaly_window: { from: epochToIsoDate(a.start_ts), to: epochToIsoDate(a.end_ts) },
      baseline_window: baselineOutsideAnomaly(a.start_ts, a.end_ts),
    });
    expect(out.sample_orders.length).toBeGreaterThan(0);
    expect(out.sample_orders.length).toBeLessThanOrEqual(10);
    for (const o of out.sample_orders) {
      expect(typeof o.order_id).toBe('string');
      expect(o.purchase_ts).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(o.status).toBeTruthy();
      expect(o.items.length).toBeGreaterThan(0);
    }
  });
});

describe('get_anomaly_context — electronics spike (week 2)', () => {
  it('detects positive pct_change for electronics in week 2', () => {
    const a = getSeededAnomaly('electronics-spike-w2');
    const out = tool.execute(db, {
      metric: a.metric,
      dimension: a.dimension,
      segment: a.segment,
      anomaly_window: { from: epochToIsoDate(a.start_ts), to: epochToIsoDate(a.end_ts) },
      baseline_window: baselineOutsideAnomaly(a.start_ts, a.end_ts),
    });
    // generator multiplier is 2.5x — expect order_count to be at least 1.5x baseline.
    expect(out.anomaly_summary.pct_change).toBeGreaterThan(0.5);
  });
});

describe('get_anomaly_context — voucher dropoff (week 10 onward)', () => {
  it('detects voucher payment_value collapse vs baseline', () => {
    const a = getSeededAnomaly('voucher-dropoff-w10-on');
    // For this sustained anomaly the baseline is weeks 1..9 (pre-anomaly).
    const HORIZON_START = Math.floor(Date.UTC(2025, 11, 1) / 1000);
    const out = tool.execute(db, {
      metric: a.metric,
      dimension: a.dimension,
      segment: a.segment,
      anomaly_window: { from: epochToIsoDate(a.start_ts), to: epochToIsoDate(a.end_ts) },
      baseline_window: {
        from: epochToIsoDate(HORIZON_START),
        to: epochToIsoDate(a.start_ts),
      },
    });
    // generator multiplier is 0.05 — voucher should collapse to near zero
    expect(out.anomaly_summary.pct_change).toBeLessThan(-0.5);
  });
});
