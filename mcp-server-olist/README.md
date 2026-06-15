# mcp-server-olist

An MCP server over a synthetic Brazilian e-commerce dataset, modelled after the
[Olist public dataset on Kaggle](https://www.kaggle.com/datasets/olistbr/brazilian-ecommerce).
Built to back the `blooming insights` agent loop as a second `DataSource`
adapter alongside the existing Bloomreach adapter, and to provide deterministic
ground truth for the Phase 3 eval harness.

The server runs as a Node subprocess and communicates over MCP **stdio**. It
exposes three domain tools (NOT a raw `execute_sql`) so the agents talk in
metric/dimension/window terms rather than emitting SQL the model might fumble.

## Why synthetic instead of real Olist

The real Olist dataset on Kaggle requires authenticated download. The synthetic
generator in `scripts/seed-olist.ts`:

- mirrors Olist's schema (customers, orders, products, order_items, payments,
  reviews) so the swap to real Olist is mechanical;
- is **deterministic** under a fixed seed (`OLIST_SEED = 42`) — every developer
  gets byte-identical data;
- bakes in **three seeded anomalies** with metadata in a `seeded_anomalies`
  table, which the Phase 3 monitoring-agent eval consumes as ground truth.

To swap in real Olist CSVs later: drop the CSVs under `data/raw/` and replace
the `generate*()` calls in `scripts/seed-olist.ts` with CSV `INSERT` loops. The
table schemas below already match the public dataset.

## Schema

All monetary values stored as **integers in BRL cents** to avoid float math.
Timestamps stored as **unix epoch seconds**.

```
customers
  id            TEXT PRIMARY KEY
  state         TEXT          -- Brazilian state code (e.g. 'SP', 'RJ')
  city          TEXT

orders
  id            TEXT PRIMARY KEY
  customer_id   TEXT REFERENCES customers(id)
  status        TEXT          -- 'delivered' | 'shipped' | 'canceled' | ...
  purchase_ts   INTEGER       -- unix epoch seconds
  delivered_ts  INTEGER NULL

products
  id            TEXT PRIMARY KEY
  category      TEXT          -- 'electronics' | 'fashion' | ... (7 total)
  weight_g      INTEGER

order_items
  order_id      TEXT REFERENCES orders(id)
  product_id    TEXT REFERENCES products(id)
  price_brl     INTEGER       -- cents
  freight_brl   INTEGER       -- cents

payments
  order_id      TEXT REFERENCES orders(id)
  type          TEXT          -- 'credit_card' | 'boleto' | 'voucher' | 'debit_card'
  installments  INTEGER
  value_brl     INTEGER       -- cents

reviews
  order_id      TEXT REFERENCES orders(id)
  score         INTEGER       -- 1-5
  ts            INTEGER

seeded_anomalies                   -- ground truth for Phase 3 eval
  id                  TEXT PRIMARY KEY
  metric              TEXT        -- 'revenue' | 'order_count' | 'payment_value'
  dimension           TEXT        -- 'state' | 'category' | 'payment_type'
  segment             TEXT        -- e.g. 'SP', 'electronics', 'voucher'
  start_ts            INTEGER
  end_ts              INTEGER
  expected_severity   TEXT        -- 'warning' | 'critical'
  description         TEXT
```

## Seeded anomalies

Three deliberate anomalies, planted by `scripts/seed-olist.ts`:

| # | What | Where | When | Severity |
|---|------|-------|------|----------|
| 1 | Revenue drops ~30% | `state = SP` | week 4 | critical |
| 2 | Order count spikes ~2.5x | `category = electronics` | week 2 | warning |
| 3 | Voucher payments drop to ~0 (sustained) | `payment_type = voucher` | week 10 onward | critical |

The monitoring agent should surface all three; the diagnostic agent's
`get_anomaly_context` calls should produce evidence pointing to the planted
window.

## Build, seed, and run

```bash
# from repo root
cd mcp-server-olist
npm run seed       # generates data/olist.db (deterministic, ~5-15 MB)
npm run build      # compiles src/ → dist/
npm run start      # runs the MCP server over stdio
```

The `OlistDataSource` adapter at `lib/data-source/olist-data-source.ts` spawns
the server via `StdioClientTransport` automatically — running it by hand is for
inspection / one-off debugging.

## Tools

### `get_metric_timeseries`

Aggregates a metric over a time window, optionally grouped by a dimension and
optionally filtered by a single dimension/value pair. Granularity is `day` or
`week`.

```ts
input: {
  metric: 'revenue' | 'order_count' | 'avg_order_value' | 'payment_value';
  dimension?: 'state' | 'category' | 'payment_type';
  time_range: { from: string; to: string };   // ISO YYYY-MM-DD
  filter?: { dimension: 'state' | 'category' | 'payment_type'; value: string };
  granularity?: 'day' | 'week';                // default 'day'
}
output: {
  points: Array<{ ts: string; value: number; segment?: string }>;
  totalCount: number;
}
```

### `get_segments`

Lists distinct values of a dimension with the order count + revenue in the
requested window. Lets the agent discover what to filter on.

```ts
input: {
  dimension: 'state' | 'category' | 'payment_type';
  time_range?: { from: string; to: string };   // defaults to last 90 days
}
output: {
  segments: Array<{ name: string; order_count: number; revenue_brl: number }>;
}
```

### `get_anomaly_context`

For the diagnostic loop's evidence gathering: returns the segment's change
against the baseline, other segments that moved correlated, and up to 10
representative orders from the anomaly window.

```ts
input: {
  metric: 'revenue' | 'order_count' | 'payment_value';
  dimension: 'state' | 'category' | 'payment_type';
  segment: string;
  anomaly_window: { from: string; to: string };
  baseline_window: { from: string; to: string };
}
output: {
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
```

## Error handling

The server follows the MCP spec:

- Invalid input → `{ isError: true, content: [{ type: 'text', text: '...' }] }`
- DB / unexpected error → `{ isError: true, content: [...] }`
- Server crash → process exits with non-zero code

Tools NEVER throw to the protocol layer — errors are returned as `isError`
results so the client (and the agent loop) can reason about them.
