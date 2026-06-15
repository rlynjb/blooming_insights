// mcp-server-olist/test/tools/get_metric_timeseries.test.ts
//
// Tests the get_metric_timeseries tool against the seeded olist.db. All tests
// share the same opened DB (read-only) — the seed is deterministic so the
// assertions on absolute counts/sums are safe.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db';
import * as tool from '../../src/tools/get_metric_timeseries';

let db: Database.Database;
beforeAll(() => {
  db = openDb();
});
afterAll(() => {
  db.close();
});

const WINDOW = { from: '2025-12-01', to: '2026-06-01' };

describe('get_metric_timeseries — input validation', () => {
  it('rejects missing metric', () => {
    const v = tool.validateInput({ time_range: WINDOW });
    expect(typeof v).toBe('string');
    expect(v).toMatch(/metric/);
  });

  it('rejects unknown metric enum value', () => {
    const v = tool.validateInput({ metric: 'profit', time_range: WINDOW });
    expect(typeof v).toBe('string');
  });

  it('rejects unknown dimension', () => {
    const v = tool.validateInput({ metric: 'revenue', dimension: 'planet', time_range: WINDOW });
    expect(typeof v).toBe('string');
  });

  it('rejects extra top-level keys', () => {
    const v = tool.validateInput({ metric: 'revenue', time_range: WINDOW, extra: 'no' });
    expect(typeof v).toBe('string');
    expect(v).toMatch(/extra/);
  });

  it('accepts a valid input', () => {
    const v = tool.validateInput({ metric: 'revenue', time_range: WINDOW });
    expect(typeof v).not.toBe('string');
  });
});

describe('get_metric_timeseries — happy path', () => {
  it('returns revenue points for a window', () => {
    const out = tool.execute(db, { metric: 'revenue', time_range: WINDOW });
    expect(out.points.length).toBeGreaterThan(0);
    expect(out.totalCount).toBeGreaterThan(0);
    for (const p of out.points) {
      expect(p.ts).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(typeof p.value).toBe('number');
      expect(p.value).toBeGreaterThanOrEqual(0);
      expect(p.segment).toBeUndefined();
    }
  });

  it('returns order_count points', () => {
    const out = tool.execute(db, { metric: 'order_count', time_range: WINDOW });
    expect(out.points.length).toBeGreaterThan(0);
    expect(out.points[0].value).toBeGreaterThan(0);
    expect(Number.isInteger(out.points[0].value)).toBe(true);
  });

  it('returns avg_order_value points', () => {
    const out = tool.execute(db, { metric: 'avg_order_value', time_range: WINDOW });
    expect(out.points.length).toBeGreaterThan(0);
    expect(out.points[0].value).toBeGreaterThan(0);
  });

  it('returns payment_value points', () => {
    const out = tool.execute(db, { metric: 'payment_value', time_range: WINDOW });
    expect(out.points.length).toBeGreaterThan(0);
    expect(out.points[0].value).toBeGreaterThan(0);
  });
});

describe('get_metric_timeseries — dimension grouping', () => {
  it('groups revenue by category — produces 7 distinct segments', () => {
    const out = tool.execute(db, { metric: 'revenue', dimension: 'category', time_range: WINDOW });
    const segments = new Set(out.points.map((p) => p.segment));
    expect(segments.size).toBe(7);
    expect(segments.has('electronics')).toBe(true);
    expect(segments.has('food_drink')).toBe(true);
  });

  it('groups revenue by state — at least 20 distinct states', () => {
    const out = tool.execute(db, { metric: 'revenue', dimension: 'state', time_range: WINDOW });
    const segments = new Set(out.points.map((p) => p.segment));
    expect(segments.size).toBeGreaterThanOrEqual(20);
    expect(segments.has('SP')).toBe(true);
  });

  it('groups payment_value by payment_type — 4 distinct types', () => {
    const out = tool.execute(db, {
      metric: 'payment_value',
      dimension: 'payment_type',
      time_range: WINDOW,
    });
    const segments = new Set(out.points.map((p) => p.segment));
    expect(segments.size).toBe(4);
    expect(segments.has('credit_card')).toBe(true);
    expect(segments.has('voucher')).toBe(true);
  });
});

describe('get_metric_timeseries — filter narrowing', () => {
  it('filters revenue to a single category', () => {
    const all = tool.execute(db, { metric: 'revenue', time_range: WINDOW });
    const filtered = tool.execute(db, {
      metric: 'revenue',
      time_range: WINDOW,
      filter: { dimension: 'category', value: 'electronics' },
    });
    const allSum = all.points.reduce((a, p) => a + p.value, 0);
    const filteredSum = filtered.points.reduce((a, p) => a + p.value, 0);
    expect(filteredSum).toBeGreaterThan(0);
    expect(filteredSum).toBeLessThan(allSum);
  });

  it('filters payment_value to voucher type', () => {
    const filtered = tool.execute(db, {
      metric: 'payment_value',
      time_range: WINDOW,
      filter: { dimension: 'payment_type', value: 'voucher' },
    });
    expect(filtered.points.length).toBeGreaterThan(0);
    expect(filtered.totalCount).toBeGreaterThan(0);
  });

  it('filters to SP state', () => {
    const filtered = tool.execute(db, {
      metric: 'revenue',
      time_range: WINDOW,
      filter: { dimension: 'state', value: 'SP' },
    });
    expect(filtered.points.length).toBeGreaterThan(0);
  });
});

describe('get_metric_timeseries — empty + edge cases', () => {
  it('returns empty points for a window with no data', () => {
    const out = tool.execute(db, {
      metric: 'revenue',
      time_range: { from: '2000-01-01', to: '2000-02-01' },
    });
    expect(out.points).toEqual([]);
    expect(out.totalCount).toBe(0);
  });

  it('returns empty for an unknown filter value (no error)', () => {
    const out = tool.execute(db, {
      metric: 'revenue',
      time_range: WINDOW,
      filter: { dimension: 'state', value: 'ZZ' }, // not a real Brazilian state
    });
    expect(out.points).toEqual([]);
    expect(out.totalCount).toBe(0);
  });
});

describe('get_metric_timeseries — granularity', () => {
  it('week granularity produces fewer buckets than day', () => {
    const day = tool.execute(db, {
      metric: 'revenue',
      time_range: WINDOW,
      granularity: 'day',
    });
    const week = tool.execute(db, {
      metric: 'revenue',
      time_range: WINDOW,
      granularity: 'week',
    });
    expect(week.points.length).toBeLessThan(day.points.length);
    expect(week.points.length).toBeGreaterThan(0);
  });
});
