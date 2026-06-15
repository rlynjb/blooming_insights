// mcp-server-olist/scripts/seed-olist.ts
//
// Deterministic synthetic Olist-flavored dataset generator. Run with:
//   npm run seed
// (from mcp-server-olist/) — writes data/olist.db.
//
// Three seeded anomalies are baked in for Phase 3 eval ground truth — see
// the README and the SEEDED_ANOMALIES table below.
//
// Determinism: the PRNG is a tiny mulberry32 seeded with OLIST_SEED = 42.
// Every developer who runs `npm run seed` ends up with byte-identical data.

import Database from 'better-sqlite3';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const OLIST_SEED = 42;
// Walk up from wherever this file lives until we hit the directory containing
// package.json (the package root). Works whether running from src/ via tsx, or
// from dist/scripts/ after a tsc build, or via vitest.
function findPackageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (existsSync(resolve(dir, 'package.json'))) return dir;
    dir = resolve(dir, '..');
  }
  throw new Error('seed-olist: could not locate package root from ' + import.meta.url);
}
const PACKAGE_ROOT = findPackageRoot();
const DB_PATH = resolve(PACKAGE_ROOT, 'data', 'olist.db');

// -----------------------------------------------------------------------------
// Seeded PRNG (mulberry32). Pure ALU, no allocations. Returns [0, 1).
// -----------------------------------------------------------------------------
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rng = mulberry32(OLIST_SEED);
const rand = () => rng();
const randInt = (min: number, max: number): number => Math.floor(rand() * (max - min + 1)) + min;
const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)];
const pickWeighted = <T>(arr: readonly [T, number][]): T => {
  const total = arr.reduce((acc, [, w]) => acc + w, 0);
  let r = rand() * total;
  for (const [val, weight] of arr) {
    r -= weight;
    if (r <= 0) return val;
  }
  return arr[arr.length - 1][0];
};

// -----------------------------------------------------------------------------
// Reference data: Brazilian states (real codes, weighted toward SP/RJ/MG which
// is how the real Olist dataset is distributed), product categories, payment
// types.
// -----------------------------------------------------------------------------
const STATES_WEIGHTED: [string, number][] = [
  ['SP', 30], ['RJ', 13], ['MG', 12], ['BA', 5], ['PR', 5],
  ['RS', 4], ['SC', 4], ['DF', 3], ['GO', 3], ['ES', 3],
  ['PE', 3], ['CE', 2], ['PA', 2], ['MT', 2], ['MS', 2],
  ['MA', 1], ['PB', 1], ['RN', 1], ['PI', 1], ['AL', 1],
  ['SE', 1], ['TO', 1], ['RO', 1], ['AM', 1], ['AC', 0.5],
  ['AP', 0.5], ['RR', 0.5],
];

const CITIES_BY_STATE: Record<string, string[]> = {
  SP: ['sao paulo', 'campinas', 'santos', 'guarulhos', 'osasco'],
  RJ: ['rio de janeiro', 'niteroi', 'duque de caxias', 'nova iguacu'],
  MG: ['belo horizonte', 'uberlandia', 'contagem', 'juiz de fora'],
  BA: ['salvador', 'feira de santana', 'vitoria da conquista'],
  PR: ['curitiba', 'londrina', 'maringa'],
  RS: ['porto alegre', 'caxias do sul', 'pelotas'],
  SC: ['florianopolis', 'joinville', 'blumenau'],
  DF: ['brasilia'],
  GO: ['goiania', 'aparecida de goiania'],
  ES: ['vitoria', 'vila velha'],
  PE: ['recife', 'olinda'],
  CE: ['fortaleza'],
  PA: ['belem'],
  MT: ['cuiaba'],
  MS: ['campo grande'],
};

const CATEGORIES = [
  'electronics',
  'fashion',
  'home_decor',
  'health_beauty',
  'sports',
  'toys',
  'food_drink',
] as const;

const CATEGORY_PRICE_RANGES_CENTS: Record<(typeof CATEGORIES)[number], [number, number]> = {
  electronics: [5000, 250000],   // R$ 50 – R$ 2500
  fashion: [3000, 40000],
  home_decor: [4000, 80000],
  health_beauty: [2000, 25000],
  sports: [5000, 60000],
  toys: [3000, 35000],
  food_drink: [1500, 12000],
};

const PAYMENT_TYPES = ['credit_card', 'boleto', 'voucher', 'debit_card'] as const;
const PAYMENT_WEIGHTS: [string, number][] = [
  ['credit_card', 60],
  ['boleto', 25],
  ['voucher', 10],
  ['debit_card', 5],
];

const ORDER_STATUSES_WEIGHTED: [string, number][] = [
  ['delivered', 88],
  ['shipped', 7],
  ['canceled', 3],
  ['processing', 2],
];

// -----------------------------------------------------------------------------
// Time horizon: end at a fixed date so the seed-anomaly windows below stay
// stable across runs. We use 2026-06-01 00:00 UTC and run backward 26 weeks
// (~6 months) so weeks 1-26 are clean integer Mon-anchored buckets.
// -----------------------------------------------------------------------------
const END_TS = Math.floor(Date.UTC(2026, 5, 1) / 1000); // 2026-06-01 00:00 UTC
const TOTAL_WEEKS = 26;
const START_TS = END_TS - TOTAL_WEEKS * 7 * 86400;

// -----------------------------------------------------------------------------
// Seeded anomalies — the ground truth for Phase 3 evals. Each describes an
// (anomaly_window) and the agent should be able to detect + diagnose it.
//
// Week numbering: week 1 = (START_TS .. START_TS + 7d), week 26 ends at END_TS.
// -----------------------------------------------------------------------------
const SEEDED_ANOMALIES = [
  {
    id: 'sp-revenue-drop-w4',
    metric: 'revenue',
    dimension: 'state',
    segment: 'SP',
    start_ts: START_TS + 3 * 7 * 86400, // start of week 4
    end_ts: START_TS + 4 * 7 * 86400,   // end of week 4
    expected_severity: 'critical',
    description: 'Revenue in São Paulo (SP) drops ~30% in week 4 vs preceding 12-week baseline.',
    /** Internal: multiplier applied to SP orders in this window during generation. */
    _generator: { kind: 'multiplier' as const, value: 0.7 },
  },
  {
    id: 'electronics-spike-w2',
    metric: 'order_count',
    dimension: 'category',
    segment: 'electronics',
    start_ts: START_TS + 1 * 7 * 86400, // start of week 2
    end_ts: START_TS + 2 * 7 * 86400,
    expected_severity: 'warning',
    description: 'Electronics category orders spike ~2.5x in week 2 vs baseline.',
    _generator: { kind: 'multiplier' as const, value: 2.5 },
  },
  {
    id: 'voucher-dropoff-w10-on',
    metric: 'payment_value',
    dimension: 'payment_type',
    segment: 'voucher',
    start_ts: START_TS + 9 * 7 * 86400, // start of week 10
    end_ts: END_TS,                      // sustained until end
    expected_severity: 'critical',
    description:
      'Voucher payments drop to near-zero starting in week 10 (sustained through end of window).',
    _generator: { kind: 'multiplier' as const, value: 0.05 },
  },
] as const;

// -----------------------------------------------------------------------------
// Schema
// -----------------------------------------------------------------------------
const SCHEMA_SQL = `
CREATE TABLE customers (
  id    TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  city  TEXT NOT NULL
);

CREATE TABLE products (
  id        TEXT PRIMARY KEY,
  category  TEXT NOT NULL,
  weight_g  INTEGER NOT NULL
);

CREATE TABLE orders (
  id           TEXT PRIMARY KEY,
  customer_id  TEXT NOT NULL REFERENCES customers(id),
  status       TEXT NOT NULL,
  purchase_ts  INTEGER NOT NULL,
  delivered_ts INTEGER
);

CREATE TABLE order_items (
  order_id    TEXT NOT NULL REFERENCES orders(id),
  product_id  TEXT NOT NULL REFERENCES products(id),
  price_brl   INTEGER NOT NULL,
  freight_brl INTEGER NOT NULL
);

CREATE TABLE payments (
  order_id     TEXT NOT NULL REFERENCES orders(id),
  type         TEXT NOT NULL,
  installments INTEGER NOT NULL,
  value_brl    INTEGER NOT NULL
);

CREATE TABLE reviews (
  order_id TEXT NOT NULL REFERENCES orders(id),
  score    INTEGER NOT NULL,
  ts       INTEGER NOT NULL
);

CREATE TABLE seeded_anomalies (
  id                TEXT PRIMARY KEY,
  metric            TEXT NOT NULL,
  dimension         TEXT NOT NULL,
  segment           TEXT NOT NULL,
  start_ts          INTEGER NOT NULL,
  end_ts            INTEGER NOT NULL,
  expected_severity TEXT NOT NULL,
  description       TEXT NOT NULL
);

CREATE INDEX idx_orders_purchase_ts ON orders(purchase_ts);
CREATE INDEX idx_orders_customer    ON orders(customer_id);
CREATE INDEX idx_items_order        ON order_items(order_id);
CREATE INDEX idx_items_product      ON order_items(product_id);
CREATE INDEX idx_payments_order     ON payments(order_id);
CREATE INDEX idx_reviews_order      ON reviews(order_id);
CREATE INDEX idx_customers_state    ON customers(state);
CREATE INDEX idx_products_category  ON products(category);
CREATE INDEX idx_payments_type      ON payments(type);
`;

// -----------------------------------------------------------------------------
// Generators
// -----------------------------------------------------------------------------
function id(prefix: string, n: number): string {
  return `${prefix}_${n.toString(36).padStart(6, '0')}`;
}

interface CustomerRow { id: string; state: string; city: string; }
interface ProductRow  { id: string; category: string; weight_g: number; }

function generateCustomers(n: number): CustomerRow[] {
  const rows: CustomerRow[] = [];
  for (let i = 0; i < n; i++) {
    const state = pickWeighted(STATES_WEIGHTED);
    const cities = CITIES_BY_STATE[state] ?? [state.toLowerCase()];
    rows.push({ id: id('cust', i), state, city: pick(cities) });
  }
  return rows;
}

function generateProducts(n: number): ProductRow[] {
  const rows: ProductRow[] = [];
  for (let i = 0; i < n; i++) {
    const category = pick(CATEGORIES);
    rows.push({ id: id('prod', i), category, weight_g: randInt(100, 5000) });
  }
  return rows;
}

interface PlannedOrder {
  id: string;
  customer: CustomerRow;
  status: string;
  purchase_ts: number;
  delivered_ts: number | null;
  /** Items chosen — each entry references a product + a per-item price. */
  items: Array<{ product: ProductRow; price_brl: number; freight_brl: number }>;
  /** Payments for this order — may be split. */
  payments: Array<{ type: string; installments: number; value_brl: number }>;
  /** Optional review (not every order gets one). */
  review: { score: number; ts: number } | null;
}

/** Map a purchase_ts to the week index 1..26 (week 1 starts at START_TS). */
function weekIndex(purchase_ts: number): number {
  return Math.floor((purchase_ts - START_TS) / (7 * 86400)) + 1;
}

/** Apply the seeded multipliers as Bernoulli-trial keep/drop on a generated
 *  order during the anomaly window. Returns true if the order should survive,
 *  false if it should be dropped. */
function shouldKeepOrder(
  order: PlannedOrder,
  anomaly: typeof SEEDED_ANOMALIES[number],
): boolean {
  const inWindow = order.purchase_ts >= anomaly.start_ts && order.purchase_ts < anomaly.end_ts;
  if (!inWindow) return true;
  switch (anomaly.dimension) {
    case 'state':
      if (order.customer.state !== anomaly.segment) return true;
      break;
    case 'category':
      if (!order.items.some((i) => i.product.category === anomaly.segment)) return true;
      break;
    case 'payment_type':
      if (!order.payments.some((p) => p.type === anomaly.segment)) return true;
      break;
  }
  const mult = anomaly._generator.value;
  if (mult >= 1) return true; // multipliers >= 1 are handled by oversampling, not dropping
  return rand() < mult;
}

/** Generate the planned order with random items, payments, and (optional)
 *  review. Pure: no DB writes — that's the next step. */
function generateOneOrder(
  i: number,
  customers: CustomerRow[],
  products: ProductRow[],
): PlannedOrder {
  const customer = pick(customers);
  // Pick a random purchase_ts uniformly across the 26-week window.
  const purchase_ts = randInt(START_TS, END_TS - 1);
  const status = pickWeighted(ORDER_STATUSES_WEIGHTED);

  // 1-3 items per order, weighted toward 1.
  const itemCount = pickWeighted([[1, 70], [2, 20], [3, 10]]);
  const items: PlannedOrder['items'] = [];
  for (let j = 0; j < itemCount; j++) {
    const product = pick(products);
    const [minP, maxP] = CATEGORY_PRICE_RANGES_CENTS[product.category as keyof typeof CATEGORY_PRICE_RANGES_CENTS];
    const price_brl = randInt(minP, maxP);
    const freight_brl = randInt(500, 3500);
    items.push({ product, price_brl, freight_brl });
  }
  const orderTotal = items.reduce((acc, it) => acc + it.price_brl + it.freight_brl, 0);

  // Payments: 90% single payment, 10% split into 2.
  const payments: PlannedOrder['payments'] = [];
  if (rand() < 0.9) {
    const type = pickWeighted(PAYMENT_WEIGHTS);
    const installments = type === 'credit_card' ? randInt(1, 10) : 1;
    payments.push({ type, installments, value_brl: orderTotal });
  } else {
    const t1 = pickWeighted(PAYMENT_WEIGHTS);
    const t2 = pickWeighted(PAYMENT_WEIGHTS);
    const split = Math.floor(orderTotal / 2);
    payments.push({ type: t1, installments: 1, value_brl: split });
    payments.push({ type: t2, installments: 1, value_brl: orderTotal - split });
  }

  // Delivered: most delivered orders have a delivered_ts 2-14 days later.
  const delivered_ts =
    status === 'delivered' ? purchase_ts + randInt(2, 14) * 86400 : null;

  // Reviews: 70% of orders reviewed, score skewed toward 4-5.
  const review =
    rand() < 0.7
      ? {
          score: pickWeighted([[5, 50], [4, 30], [3, 12], [2, 5], [1, 3]]),
          ts: (delivered_ts ?? purchase_ts) + randInt(0, 7) * 86400,
        }
      : null;

  return {
    id: id('ord', i),
    customer,
    status,
    purchase_ts,
    delivered_ts,
    items,
    payments,
    review,
  };
}

/** Oversample additional orders for anomalies whose generator multiplier > 1
 *  (e.g. the electronics spike). The extras are generated WITH the segment
 *  forced, and slotted into the anomaly window. */
function generateAnomalyBoosters(
  customers: CustomerRow[],
  products: ProductRow[],
  startingIndex: number,
  baselineWeeklyOrders: number,
): PlannedOrder[] {
  const extras: PlannedOrder[] = [];
  let i = startingIndex;
  for (const anomaly of SEEDED_ANOMALIES) {
    if (anomaly._generator.value <= 1) continue;
    const weeks = (anomaly.end_ts - anomaly.start_ts) / (7 * 86400);
    const baseInWindow = Math.round(baselineWeeklyOrders * weeks);
    const extraNeeded = Math.round(baseInWindow * (anomaly._generator.value - 1));
    for (let k = 0; k < extraNeeded; k++) {
      const o = generateOneOrder(i++, customers, products);
      // Force the segment + window.
      o.purchase_ts = randInt(anomaly.start_ts, anomaly.end_ts - 1);
      if (anomaly.dimension === 'state') {
        const city = pick(CITIES_BY_STATE[anomaly.segment] ?? [anomaly.segment.toLowerCase()]);
        o.customer = { ...o.customer, state: anomaly.segment, city };
      } else if (anomaly.dimension === 'category') {
        // Replace the first item with a product of the target category.
        const productsInCategory = products.filter((p) => p.category === anomaly.segment);
        const product = pick(productsInCategory);
        const [minP, maxP] =
          CATEGORY_PRICE_RANGES_CENTS[product.category as keyof typeof CATEGORY_PRICE_RANGES_CENTS];
        o.items[0] = { product, price_brl: randInt(minP, maxP), freight_brl: randInt(500, 3500) };
      } else if (anomaly.dimension === 'payment_type') {
        const total = o.items.reduce((acc, it) => acc + it.price_brl + it.freight_brl, 0);
        o.payments = [{ type: anomaly.segment, installments: 1, value_brl: total }];
      }
      extras.push(o);
    }
  }
  return extras;
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------
function main(): void {
  // Make sure data/ exists (and the .gitkeep marker is harmless either way).
  if (!existsSync(dirname(DB_PATH))) {
    mkdirSync(dirname(DB_PATH), { recursive: true });
  }
  if (existsSync(DB_PATH)) {
    process.stderr.write(`[seed] removing existing ${DB_PATH}\n`);
    unlinkSync(DB_PATH);
  }

  const t0 = Date.now();
  process.stderr.write(`[seed] PRNG seed: ${OLIST_SEED}\n`);

  const customers = generateCustomers(5_000);
  const products = generateProducts(800);

  // Target: ~10k orders. Generate, then apply anomaly suppression (drops some
  // in-window orders for multiplier < 1 anomalies), then append boosters for
  // multiplier > 1 anomalies.
  const TARGET_ORDERS = 10_000;
  const planned: PlannedOrder[] = [];
  for (let i = 0; i < TARGET_ORDERS; i++) {
    planned.push(generateOneOrder(i, customers, products));
  }

  // Apply suppression-multiplier anomalies.
  const surviving: PlannedOrder[] = [];
  for (const order of planned) {
    let keep = true;
    for (const anomaly of SEEDED_ANOMALIES) {
      if (!shouldKeepOrder(order, anomaly)) {
        keep = false;
        break;
      }
    }
    if (keep) surviving.push(order);
  }
  process.stderr.write(
    `[seed] orders after suppression: ${surviving.length} (target ~${TARGET_ORDERS})\n`,
  );

  // Append boosters.
  const baselineWeekly = surviving.length / TOTAL_WEEKS;
  const boosters = generateAnomalyBoosters(
    customers,
    products,
    TARGET_ORDERS,
    baselineWeekly,
  );
  const allOrders = [...surviving, ...boosters];
  process.stderr.write(
    `[seed] orders after boosters: ${allOrders.length} (added ${boosters.length})\n`,
  );

  // Write to SQLite.
  const db = new Database(DB_PATH);
  db.exec(SCHEMA_SQL);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  const insertCustomer = db.prepare(
    'INSERT INTO customers (id, state, city) VALUES (?, ?, ?)',
  );
  const insertProduct = db.prepare(
    'INSERT INTO products (id, category, weight_g) VALUES (?, ?, ?)',
  );
  const insertOrder = db.prepare(
    'INSERT INTO orders (id, customer_id, status, purchase_ts, delivered_ts) VALUES (?, ?, ?, ?, ?)',
  );
  const insertItem = db.prepare(
    'INSERT INTO order_items (order_id, product_id, price_brl, freight_brl) VALUES (?, ?, ?, ?)',
  );
  const insertPayment = db.prepare(
    'INSERT INTO payments (order_id, type, installments, value_brl) VALUES (?, ?, ?, ?)',
  );
  const insertReview = db.prepare(
    'INSERT INTO reviews (order_id, score, ts) VALUES (?, ?, ?)',
  );
  const insertAnomaly = db.prepare(
    'INSERT INTO seeded_anomalies (id, metric, dimension, segment, start_ts, end_ts, expected_severity, description) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );

  const allInsert = db.transaction(() => {
    for (const c of customers) insertCustomer.run(c.id, c.state, c.city);
    for (const p of products) insertProduct.run(p.id, p.category, p.weight_g);
    // Customer id may not have been registered if the booster forced a state — but
    // we kept the same id so the FK passes. We still need to register the customer
    // if its id is unknown; check uniqueness here.
    const knownCustomerIds = new Set(customers.map((c) => c.id));
    for (const o of allOrders) {
      if (!knownCustomerIds.has(o.customer.id)) {
        insertCustomer.run(o.customer.id, o.customer.state, o.customer.city);
        knownCustomerIds.add(o.customer.id);
      }
      insertOrder.run(o.id, o.customer.id, o.status, o.purchase_ts, o.delivered_ts);
      for (const it of o.items) {
        insertItem.run(o.id, it.product.id, it.price_brl, it.freight_brl);
      }
      for (const p of o.payments) {
        insertPayment.run(o.id, p.type, p.installments, p.value_brl);
      }
      if (o.review) {
        insertReview.run(o.id, o.review.score, o.review.ts);
      }
    }
    for (const a of SEEDED_ANOMALIES) {
      insertAnomaly.run(
        a.id,
        a.metric,
        a.dimension,
        a.segment,
        a.start_ts,
        a.end_ts,
        a.expected_severity,
        a.description,
      );
    }
  });
  allInsert();

  // Quick stats.
  const stats = {
    customers: (db.prepare('SELECT COUNT(*) AS c FROM customers').get() as { c: number }).c,
    products: (db.prepare('SELECT COUNT(*) AS c FROM products').get() as { c: number }).c,
    orders: (db.prepare('SELECT COUNT(*) AS c FROM orders').get() as { c: number }).c,
    order_items: (db.prepare('SELECT COUNT(*) AS c FROM order_items').get() as { c: number }).c,
    payments: (db.prepare('SELECT COUNT(*) AS c FROM payments').get() as { c: number }).c,
    reviews: (db.prepare('SELECT COUNT(*) AS c FROM reviews').get() as { c: number }).c,
    seeded_anomalies: (db.prepare('SELECT COUNT(*) AS c FROM seeded_anomalies').get() as { c: number }).c,
    weekIndex_min: weekIndex(START_TS),
    weekIndex_max: weekIndex(END_TS - 1),
  };
  process.stderr.write(`[seed] stats: ${JSON.stringify(stats)}\n`);
  process.stderr.write(`[seed] wrote ${DB_PATH} in ${Date.now() - t0}ms\n`);

  db.close();
}

main();
