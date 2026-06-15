// mcp-server-olist/test/tools/get_segments.test.ts

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../../src/db';
import * as tool from '../../src/tools/get_segments';

let db: Database.Database;
beforeAll(() => {
  db = openDb();
});
afterAll(() => {
  db.close();
});

describe('get_segments — input validation', () => {
  it('rejects missing dimension', () => {
    const v = tool.validateInput({});
    expect(typeof v).toBe('string');
  });
  it('rejects unknown dimension', () => {
    const v = tool.validateInput({ dimension: 'planet' });
    expect(typeof v).toBe('string');
  });
  it('accepts dimension=state with no time_range (defaults to last 90d of data)', () => {
    const v = tool.validateInput({ dimension: 'state' });
    expect(typeof v).not.toBe('string');
  });
});

describe('get_segments — happy path', () => {
  it('returns at least 20 Brazilian states', () => {
    const out = tool.execute(db, { dimension: 'state' });
    expect(out.segments.length).toBeGreaterThanOrEqual(20);
    const names = out.segments.map((s) => s.name);
    expect(names).toContain('SP');
    expect(names).toContain('RJ');
  });

  it('returns 7 categories', () => {
    const out = tool.execute(db, { dimension: 'category' });
    expect(out.segments.length).toBe(7);
    const names = out.segments.map((s) => s.name);
    expect(names).toContain('electronics');
    expect(names).toContain('food_drink');
    expect(names).toContain('toys');
  });

  it('returns 4 payment types', () => {
    const out = tool.execute(db, { dimension: 'payment_type' });
    expect(out.segments.length).toBe(4);
    const names = out.segments.map((s) => s.name);
    expect(names).toContain('credit_card');
    expect(names).toContain('boleto');
    expect(names).toContain('voucher');
    expect(names).toContain('debit_card');
  });

  it('returns order_count and revenue_brl for each segment', () => {
    const out = tool.execute(db, { dimension: 'category' });
    for (const s of out.segments) {
      expect(typeof s.name).toBe('string');
      expect(typeof s.order_count).toBe('number');
      expect(typeof s.revenue_brl).toBe('number');
      expect(s.order_count).toBeGreaterThan(0);
      expect(s.revenue_brl).toBeGreaterThan(0);
    }
  });
});

describe('get_segments — time_range narrows the count', () => {
  it('a 1-week window has fewer orders per category than a 6-month window', () => {
    const wide = tool.execute(db, {
      dimension: 'category',
      time_range: { from: '2025-12-01', to: '2026-06-01' },
    });
    const narrow = tool.execute(db, {
      dimension: 'category',
      time_range: { from: '2026-05-25', to: '2026-06-01' },
    });
    const wideTotal = wide.segments.reduce((a, s) => a + s.order_count, 0);
    const narrowTotal = narrow.segments.reduce((a, s) => a + s.order_count, 0);
    expect(narrowTotal).toBeGreaterThan(0);
    expect(narrowTotal).toBeLessThan(wideTotal);
  });
});
