// mcp-server-olist/src/tools/get_metric_timeseries.ts
//
// Tool 1: aggregate a metric over a time window, optionally grouped by a
// dimension and optionally filtered. The agent loop in blooming insights uses
// this as its primary "what changed?" query — it stands in for Bloomreach's
// `execute_analytics_eql` on the SQL-backed adapter.
//
// All SQL uses prepared statements with positional parameters. Money is stored
// in cents (INTEGER) — the tool returns BRL in cents too, callers convert.

import type Database from 'better-sqlite3';
import {
  getMetricTimeseriesSchema,
  validateAgainstSchema,
  type Metric,
  type Dimension,
  type Granularity,
} from '../schemas.js';
import { epochToIsoDate, isoDateToEpoch, truncateEpoch } from '../db.js';

export interface GetMetricTimeseriesInput {
  metric: Metric;
  dimension?: Dimension;
  time_range: { from: string; to: string };
  filter?: { dimension: Dimension; value: string };
  granularity?: Granularity;
}

export interface MetricPoint {
  ts: string; // ISO YYYY-MM-DD at bucket start
  value: number;
  segment?: string;
}

export interface GetMetricTimeseriesOutput {
  points: MetricPoint[];
  totalCount: number;
}

/** Column expression for the requested dimension, joined into the FROM clause. */
function dimensionColumn(dim: Dimension): string {
  switch (dim) {
    case 'state':
      return 'c.state';
    case 'category':
      return 'p.category';
    case 'payment_type':
      return 'pay.type';
  }
}

/** Validate input, then return a strongly typed input. Returns the same
 *  error-string contract as validateAgainstSchema so the server layer can wrap
 *  it in `{ isError: true }`. */
export function validateInput(raw: unknown): string | GetMetricTimeseriesInput {
  const err = validateAgainstSchema(getMetricTimeseriesSchema, raw);
  if (err) return err;
  return raw as GetMetricTimeseriesInput;
}

/** Execute the tool against an open SQLite DB. Pure function — no MCP-layer
 *  concerns, easy to unit-test. */
export function execute(
  db: Database.Database,
  input: GetMetricTimeseriesInput,
): GetMetricTimeseriesOutput {
  const granularity: Granularity = input.granularity ?? 'day';
  const fromEpoch = isoDateToEpoch(input.time_range.from);
  const toEpoch = isoDateToEpoch(input.time_range.to);

  // Always join orders + order_items + customers + products + payments only when
  // the metric, dimension, or filter needs it. Keeping the joins on the conservative
  // side: order_items is needed for revenue/avg_order_value, payments for
  // payment_value. Products for category dim/filter. Customers for state dim/filter.
  const needsItems =
    input.metric === 'revenue' ||
    input.metric === 'avg_order_value' ||
    input.dimension === 'category' ||
    input.filter?.dimension === 'category';
  const needsPayments =
    input.metric === 'payment_value' ||
    input.dimension === 'payment_type' ||
    input.filter?.dimension === 'payment_type';
  const needsProducts = input.dimension === 'category' || input.filter?.dimension === 'category';
  const needsCustomers = input.dimension === 'state' || input.filter?.dimension === 'state';

  const joins: string[] = [];
  if (needsItems) joins.push('JOIN order_items oi ON oi.order_id = o.id');
  if (needsProducts) joins.push('JOIN products p ON p.id = oi.product_id');
  if (needsCustomers) joins.push('JOIN customers c ON c.id = o.customer_id');
  if (needsPayments) joins.push('JOIN payments pay ON pay.order_id = o.id');

  // Metric expression. order_count counts DISTINCT orders so multi-item orders
  // don't inflate the count when order_items is joined.
  let metricExpr: string;
  switch (input.metric) {
    case 'revenue':
      metricExpr = 'SUM(oi.price_brl)';
      break;
    case 'order_count':
      metricExpr = 'COUNT(DISTINCT o.id)';
      break;
    case 'avg_order_value':
      // Avg revenue per order — sum item prices, divide by distinct orders.
      metricExpr = 'CAST(SUM(oi.price_brl) AS REAL) / COUNT(DISTINCT o.id)';
      break;
    case 'payment_value':
      metricExpr = 'SUM(pay.value_brl)';
      break;
  }

  const where: string[] = ['o.purchase_ts >= ?', 'o.purchase_ts < ?'];
  const params: (string | number)[] = [fromEpoch, toEpoch];
  if (input.filter) {
    const col = dimensionColumn(input.filter.dimension);
    where.push(`${col} = ?`);
    params.push(input.filter.value);
    // Make sure the join for the filter column is present even when no
    // metric/dimension would otherwise add it.
    if (input.filter.dimension === 'state' && !needsCustomers) {
      joins.push('JOIN customers c ON c.id = o.customer_id');
    }
    if (input.filter.dimension === 'category' && !needsProducts) {
      if (!needsItems) joins.unshift('JOIN order_items oi ON oi.order_id = o.id');
      joins.push('JOIN products p ON p.id = oi.product_id');
    }
    if (input.filter.dimension === 'payment_type' && !needsPayments) {
      joins.push('JOIN payments pay ON pay.order_id = o.id');
    }
  }

  // Pull all matching rows + their purchase_ts + (optional) dimension value into
  // memory, then bucket by (truncated_ts, segment) in JS. The dataset is small
  // (~10k orders) so this avoids SQLite-side date math (which would need
  // strftime + integer/unixepoch dance) and keeps the SQL simple.
  const dimCol = input.dimension ? dimensionColumn(input.dimension) : null;
  const selectCols = ['o.id AS order_id', 'o.purchase_ts AS ts'];
  if (input.metric === 'revenue' || input.metric === 'avg_order_value') {
    selectCols.push('oi.price_brl AS amount');
  } else if (input.metric === 'payment_value') {
    selectCols.push('pay.value_brl AS amount');
  } else {
    selectCols.push('1 AS amount'); // order_count uses DISTINCT o.id later
  }
  if (dimCol) selectCols.push(`${dimCol} AS segment`);

  const sql = `
    SELECT ${selectCols.join(', ')}
    FROM orders o
    ${joins.join('\n      ')}
    WHERE ${where.join(' AND ')}
  `;
  const rows = db.prepare(sql).all(...params) as Array<{
    order_id: string;
    ts: number;
    amount: number;
    segment?: string;
  }>;

  // Bucket rows by (truncated ts, segment). Use Map<string, ...> to preserve
  // insertion order so we can produce a clean sorted output.
  type Bucket = {
    bucketTs: number;
    segment?: string;
    sumAmount: number;
    distinctOrders: Set<string>;
  };
  const buckets = new Map<string, Bucket>();
  for (const r of rows) {
    const bucketTs = truncateEpoch(r.ts, granularity);
    const seg = r.segment ?? undefined;
    const key = `${bucketTs}::${seg ?? ''}`;
    let b = buckets.get(key);
    if (!b) {
      b = { bucketTs, segment: seg, sumAmount: 0, distinctOrders: new Set() };
      buckets.set(key, b);
    }
    b.sumAmount += r.amount;
    b.distinctOrders.add(r.order_id);
  }

  const points: MetricPoint[] = [];
  for (const b of buckets.values()) {
    let value: number;
    switch (input.metric) {
      case 'revenue':
      case 'payment_value':
        value = b.sumAmount;
        break;
      case 'order_count':
        value = b.distinctOrders.size;
        break;
      case 'avg_order_value':
        value = b.distinctOrders.size === 0 ? 0 : b.sumAmount / b.distinctOrders.size;
        break;
    }
    points.push({
      ts: epochToIsoDate(b.bucketTs),
      value,
      ...(b.segment !== undefined ? { segment: b.segment } : {}),
    });
  }
  // Sort by (ts, segment) so output is stable + intuitive.
  points.sort((a, b) => {
    if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
    return (a.segment ?? '') < (b.segment ?? '') ? -1 : 1;
  });

  // Total distinct orders across the whole window (for the caller's UI footer).
  const totalCount = new Set(rows.map((r) => r.order_id)).size;
  return { points, totalCount };
}
