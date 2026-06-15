// mcp-server-olist/src/tools/get_segments.ts
//
// Tool 2: list distinct values of a dimension (states / categories /
// payment_types) with order_count + revenue in the requested window. Lets the
// agent discover what to filter on before drilling into a specific segment.

import type Database from 'better-sqlite3';
import {
  getSegmentsSchema,
  validateAgainstSchema,
  type Dimension,
} from '../schemas.js';
import { isoDateToEpoch } from '../db.js';

export interface GetSegmentsInput {
  dimension: Dimension;
  time_range?: { from: string; to: string };
}

export interface SegmentRow {
  name: string;
  order_count: number;
  revenue_brl: number;
}

export interface GetSegmentsOutput {
  segments: SegmentRow[];
}

export function validateInput(raw: unknown): string | GetSegmentsInput {
  const err = validateAgainstSchema(getSegmentsSchema, raw);
  if (err) return err;
  return raw as GetSegmentsInput;
}

/** Default the time window to the last 90 days from the data's `MAX(purchase_ts)`,
 *  NOT real wall-clock — synthetic data has a fixed horizon, and we want the
 *  default to be useful against it. The agent can always supply explicit dates. */
function defaultTimeRange(db: Database.Database): { fromEpoch: number; toEpoch: number } {
  const row = db.prepare('SELECT MAX(purchase_ts) AS max_ts FROM orders').get() as {
    max_ts: number | null;
  };
  const toEpoch = row.max_ts ?? Math.floor(Date.now() / 1000);
  const fromEpoch = toEpoch - 90 * 24 * 3600;
  return { fromEpoch, toEpoch };
}

export function execute(db: Database.Database, input: GetSegmentsInput): GetSegmentsOutput {
  let fromEpoch: number;
  let toEpoch: number;
  if (input.time_range) {
    fromEpoch = isoDateToEpoch(input.time_range.from);
    toEpoch = isoDateToEpoch(input.time_range.to);
  } else {
    const def = defaultTimeRange(db);
    fromEpoch = def.fromEpoch;
    toEpoch = def.toEpoch;
  }

  let sql: string;
  switch (input.dimension) {
    case 'state':
      sql = `
        SELECT c.state AS name,
               COUNT(DISTINCT o.id) AS order_count,
               COALESCE(SUM(oi.price_brl), 0) AS revenue_brl
        FROM orders o
        JOIN customers c ON c.id = o.customer_id
        LEFT JOIN order_items oi ON oi.order_id = o.id
        WHERE o.purchase_ts >= ? AND o.purchase_ts < ?
        GROUP BY c.state
        ORDER BY revenue_brl DESC, name ASC
      `;
      break;
    case 'category':
      sql = `
        SELECT p.category AS name,
               COUNT(DISTINCT o.id) AS order_count,
               COALESCE(SUM(oi.price_brl), 0) AS revenue_brl
        FROM orders o
        JOIN order_items oi ON oi.order_id = o.id
        JOIN products p ON p.id = oi.product_id
        WHERE o.purchase_ts >= ? AND o.purchase_ts < ?
        GROUP BY p.category
        ORDER BY revenue_brl DESC, name ASC
      `;
      break;
    case 'payment_type':
      sql = `
        SELECT pay.type AS name,
               COUNT(DISTINCT o.id) AS order_count,
               COALESCE(SUM(oi.price_brl), 0) AS revenue_brl
        FROM orders o
        JOIN payments pay ON pay.order_id = o.id
        LEFT JOIN order_items oi ON oi.order_id = o.id
        WHERE o.purchase_ts >= ? AND o.purchase_ts < ?
        GROUP BY pay.type
        ORDER BY revenue_brl DESC, name ASC
      `;
      break;
  }

  const rows = db.prepare(sql).all(fromEpoch, toEpoch) as SegmentRow[];
  return { segments: rows };
}
