// mcp-server-olist/src/tools/get_anomaly_context.ts
//
// Tool 3: evidence-gathering for the diagnostic agent. Given a flagged anomaly
// (segment + window) and a baseline window, return:
//   - the anomaly_summary (anomaly value, baseline avg, pct change)
//   - related_segments (other segments in the same dimension and how they moved)
//   - up to 10 representative orders from the anomaly window
//
// The agent loop reads this verbatim into the diagnosis output's `evidence[]`.

import type Database from 'better-sqlite3';
import {
  getAnomalyContextSchema,
  validateAgainstSchema,
  type Dimension,
} from '../schemas.js';
import { epochToIsoDate, isoDateToEpoch } from '../db.js';

export interface GetAnomalyContextInput {
  metric: 'revenue' | 'order_count' | 'payment_value';
  dimension: Dimension;
  segment: string;
  anomaly_window: { from: string; to: string };
  baseline_window: { from: string; to: string };
}

export interface GetAnomalyContextOutput {
  anomaly_summary: {
    metric: string;
    segment: string;
    anomaly_value: number;
    baseline_avg: number;
    pct_change: number;
  };
  related_segments: Array<{ name: string; pct_change: number }>;
  sample_orders: Array<{
    order_id: string;
    purchase_ts: string;
    status: string;
    price_brl: number;
    items: Array<{ category: string; price_brl: number }>;
  }>;
}

export function validateInput(raw: unknown): string | GetAnomalyContextInput {
  const err = validateAgainstSchema(getAnomalyContextSchema, raw);
  if (err) return err;
  return raw as GetAnomalyContextInput;
}

/** Build the (joinClause, filterClause, params...) for a given metric+dimension
 *  pair. Same shape as get_metric_timeseries but with the dimension always
 *  baked in as both grouping AND filter — we want a single number per window. */
function aggregateForSegment(
  db: Database.Database,
  metric: GetAnomalyContextInput['metric'],
  dimension: Dimension,
  segment: string,
  fromEpoch: number,
  toEpoch: number,
): number {
  let sql: string;
  switch (metric) {
    case 'revenue':
      if (dimension === 'state') {
        sql = `
          SELECT COALESCE(SUM(oi.price_brl), 0) AS v
          FROM orders o
          JOIN customers c ON c.id = o.customer_id
          JOIN order_items oi ON oi.order_id = o.id
          WHERE c.state = ? AND o.purchase_ts >= ? AND o.purchase_ts < ?
        `;
      } else if (dimension === 'category') {
        sql = `
          SELECT COALESCE(SUM(oi.price_brl), 0) AS v
          FROM orders o
          JOIN order_items oi ON oi.order_id = o.id
          JOIN products p ON p.id = oi.product_id
          WHERE p.category = ? AND o.purchase_ts >= ? AND o.purchase_ts < ?
        `;
      } else {
        sql = `
          SELECT COALESCE(SUM(oi.price_brl), 0) AS v
          FROM orders o
          JOIN payments pay ON pay.order_id = o.id
          JOIN order_items oi ON oi.order_id = o.id
          WHERE pay.type = ? AND o.purchase_ts >= ? AND o.purchase_ts < ?
        `;
      }
      break;
    case 'order_count':
      if (dimension === 'state') {
        sql = `
          SELECT COUNT(DISTINCT o.id) AS v
          FROM orders o
          JOIN customers c ON c.id = o.customer_id
          WHERE c.state = ? AND o.purchase_ts >= ? AND o.purchase_ts < ?
        `;
      } else if (dimension === 'category') {
        sql = `
          SELECT COUNT(DISTINCT o.id) AS v
          FROM orders o
          JOIN order_items oi ON oi.order_id = o.id
          JOIN products p ON p.id = oi.product_id
          WHERE p.category = ? AND o.purchase_ts >= ? AND o.purchase_ts < ?
        `;
      } else {
        sql = `
          SELECT COUNT(DISTINCT o.id) AS v
          FROM orders o
          JOIN payments pay ON pay.order_id = o.id
          WHERE pay.type = ? AND o.purchase_ts >= ? AND o.purchase_ts < ?
        `;
      }
      break;
    case 'payment_value':
      if (dimension === 'state') {
        sql = `
          SELECT COALESCE(SUM(pay.value_brl), 0) AS v
          FROM orders o
          JOIN customers c ON c.id = o.customer_id
          JOIN payments pay ON pay.order_id = o.id
          WHERE c.state = ? AND o.purchase_ts >= ? AND o.purchase_ts < ?
        `;
      } else if (dimension === 'category') {
        sql = `
          SELECT COALESCE(SUM(pay.value_brl), 0) AS v
          FROM orders o
          JOIN order_items oi ON oi.order_id = o.id
          JOIN products p ON p.id = oi.product_id
          JOIN payments pay ON pay.order_id = o.id
          WHERE p.category = ? AND o.purchase_ts >= ? AND o.purchase_ts < ?
        `;
      } else {
        sql = `
          SELECT COALESCE(SUM(pay.value_brl), 0) AS v
          FROM orders o
          JOIN payments pay ON pay.order_id = o.id
          WHERE pay.type = ? AND o.purchase_ts >= ? AND o.purchase_ts < ?
        `;
      }
      break;
  }
  const row = db.prepare(sql).get(segment, fromEpoch, toEpoch) as { v: number };
  return row?.v ?? 0;
}

/** List every distinct segment value for the dimension (small cardinality:
 *  27 states / 7 categories / 4 payment types). */
function listSegments(db: Database.Database, dimension: Dimension): string[] {
  let sql: string;
  switch (dimension) {
    case 'state':
      sql = 'SELECT DISTINCT state AS name FROM customers ORDER BY name';
      break;
    case 'category':
      sql = 'SELECT DISTINCT category AS name FROM products ORDER BY name';
      break;
    case 'payment_type':
      sql = 'SELECT DISTINCT type AS name FROM payments ORDER BY name';
      break;
  }
  return (db.prepare(sql).all() as Array<{ name: string }>).map((r) => r.name);
}

function pctChange(anomalyVal: number, baselineAvg: number): number {
  if (baselineAvg === 0) return anomalyVal === 0 ? 0 : Infinity;
  return (anomalyVal - baselineAvg) / baselineAvg;
}

/** Span in days between two ISO dates (inclusive of from, exclusive of to). */
function daysBetween(fromEpoch: number, toEpoch: number): number {
  return Math.max(1, Math.round((toEpoch - fromEpoch) / 86400));
}

export function execute(
  db: Database.Database,
  input: GetAnomalyContextInput,
): GetAnomalyContextOutput {
  const aFrom = isoDateToEpoch(input.anomaly_window.from);
  const aTo = isoDateToEpoch(input.anomaly_window.to);
  const bFrom = isoDateToEpoch(input.baseline_window.from);
  const bTo = isoDateToEpoch(input.baseline_window.to);

  const anomalyValue = aggregateForSegment(db, input.metric, input.dimension, input.segment, aFrom, aTo);
  const baselineSum = aggregateForSegment(db, input.metric, input.dimension, input.segment, bFrom, bTo);

  // Normalize baseline to a same-length window so pct_change is meaningful when
  // the windows are different sizes (e.g. 1-week anomaly vs 12-week baseline).
  const anomalyDays = daysBetween(aFrom, aTo);
  const baselineDays = daysBetween(bFrom, bTo);
  const baselineAvg = (baselineSum * anomalyDays) / baselineDays;

  const anomaly_summary = {
    metric: input.metric,
    segment: input.segment,
    anomaly_value: anomalyValue,
    baseline_avg: baselineAvg,
    pct_change: pctChange(anomalyValue, baselineAvg),
  };

  // Related segments: every OTHER segment in the same dimension, how they moved
  // in the same anomaly window vs same baseline window (normalized).
  const allSegments = listSegments(db, input.dimension);
  const related_segments: GetAnomalyContextOutput['related_segments'] = [];
  for (const seg of allSegments) {
    if (seg === input.segment) continue;
    const aVal = aggregateForSegment(db, input.metric, input.dimension, seg, aFrom, aTo);
    const bSum = aggregateForSegment(db, input.metric, input.dimension, seg, bFrom, bTo);
    const bAvg = (bSum * anomalyDays) / baselineDays;
    related_segments.push({ name: seg, pct_change: pctChange(aVal, bAvg) });
  }
  // Most-moved-by-absolute-value first, finite values only (Inf is the "from
  // nothing" case which is informative but not a comparable magnitude).
  related_segments.sort((a, b) => {
    const av = Number.isFinite(a.pct_change) ? Math.abs(a.pct_change) : 0;
    const bv = Number.isFinite(b.pct_change) ? Math.abs(b.pct_change) : 0;
    return bv - av;
  });

  // Sample orders from the anomaly window for the segment. Limit to 10.
  let ordersSql: string;
  switch (input.dimension) {
    case 'state':
      ordersSql = `
        SELECT o.id AS order_id, o.purchase_ts AS ts, o.status AS status
        FROM orders o
        JOIN customers c ON c.id = o.customer_id
        WHERE c.state = ? AND o.purchase_ts >= ? AND o.purchase_ts < ?
        ORDER BY o.purchase_ts ASC
        LIMIT 10
      `;
      break;
    case 'category':
      ordersSql = `
        SELECT DISTINCT o.id AS order_id, o.purchase_ts AS ts, o.status AS status
        FROM orders o
        JOIN order_items oi ON oi.order_id = o.id
        JOIN products p ON p.id = oi.product_id
        WHERE p.category = ? AND o.purchase_ts >= ? AND o.purchase_ts < ?
        ORDER BY o.purchase_ts ASC
        LIMIT 10
      `;
      break;
    case 'payment_type':
      ordersSql = `
        SELECT DISTINCT o.id AS order_id, o.purchase_ts AS ts, o.status AS status
        FROM orders o
        JOIN payments pay ON pay.order_id = o.id
        WHERE pay.type = ? AND o.purchase_ts >= ? AND o.purchase_ts < ?
        ORDER BY o.purchase_ts ASC
        LIMIT 10
      `;
      break;
  }
  const orderRows = db.prepare(ordersSql).all(input.segment, aFrom, aTo) as Array<{
    order_id: string;
    ts: number;
    status: string;
  }>;

  // For each sampled order, pull its items + total price. Two prepared
  // statements; fine for at most 10 orders.
  const itemsStmt = db.prepare(`
    SELECT p.category AS category, oi.price_brl AS price_brl
    FROM order_items oi
    JOIN products p ON p.id = oi.product_id
    WHERE oi.order_id = ?
  `);

  const sample_orders: GetAnomalyContextOutput['sample_orders'] = orderRows.map((r) => {
    const items = itemsStmt.all(r.order_id) as Array<{ category: string; price_brl: number }>;
    const total = items.reduce((acc, it) => acc + it.price_brl, 0);
    return {
      order_id: r.order_id,
      purchase_ts: epochToIsoDate(r.ts),
      status: r.status,
      price_brl: total,
      items: items.map((it) => ({ category: it.category, price_brl: it.price_brl })),
    };
  });

  return { anomaly_summary, related_segments, sample_orders };
}
