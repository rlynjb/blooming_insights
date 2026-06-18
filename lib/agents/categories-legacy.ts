import type { CategoryId, CategoryCoverage, CoverageReport } from '../mcp/types';

// The fixed ecommerce-anomaly checklist the monitoring agent runs. A category is
// "runnable" only when the workspace emits the events (and, for `enriches`, the
// properties/catalogs) it needs — gated at runtime against the live schema, so
// the grid never fakes a category the data can't support.
export interface AnomalyCategory {
  id: CategoryId;
  label: string; // lowercase display
  requires: string[]; // hard deps (event names) — missing any → unavailable (ghost tile)
  enriches?: string[]; // soft deps (`event.property` / `catalog:<name>`) — missing → limited
  whyItMatters: string; // framing the agent expands with the real numbers
  eql: (projectId: string) => string; // suggested period-over-period recipe (90d vs prior 90d)
  thresholds: { critical: number; warning: number }; // |% change| gates
}

const win = 'in last 90 days';

export const CATEGORIES: AnomalyCategory[] = [
  {
    id: 'conversion_drop',
    label: 'conversion rate drop',
    requires: ['view_item', 'checkout', 'purchase'],
    whyItMatters:
      'conversion is the funnel hinge — a drop here loses completed-intent customers even at flat traffic.',
    eql: () => `select count event view_item, count event checkout, count event purchase ${win}`,
    thresholds: { critical: 20, warning: 10 },
  },
  {
    id: 'cart_abandonment',
    label: 'cart abandonment',
    requires: ['cart_update', 'checkout', 'purchase'],
    whyItMatters:
      'rising abandonment means shoppers fill carts but stall before paying — usually friction or sticker shock at checkout.',
    eql: () => `select count event cart_update, count event checkout, count event purchase ${win}`,
    thresholds: { critical: 20, warning: 10 },
  },
  {
    id: 'product_demand',
    label: 'product demand spike',
    requires: ['purchase'],
    whyItMatters:
      'a sudden velocity spike on a SKU is an opportunity to ride — front-page it and protect inventory before it sells out.',
    eql: () => `select count event purchase by event purchase.product_id grouping top 10 ${win}`,
    thresholds: { critical: 100, warning: 50 },
  },
  {
    id: 'revenue_drop',
    label: 'revenue drop',
    requires: ['purchase'],
    whyItMatters:
      'revenue is the top line — a move here flows straight to income; isolate whether it is demand or conversion.',
    eql: () => `select sum event purchase.total_price, count event purchase ${win}`,
    thresholds: { critical: 20, warning: 10 },
  },
  {
    id: 'customer_churn',
    label: 'customer churn',
    requires: ['purchase', 'session_start'],
    whyItMatters:
      'a falling repeat-purchase rate reflects customers not coming back — the leading edge of lifetime-value erosion.',
    eql: () => `select count event purchase, count event session_start ${win}`,
    thresholds: { critical: 15, warning: 8 },
  },
  {
    id: 'inventory',
    label: 'inventory problems',
    requires: ['purchase'],
    enriches: ['catalog:inventory_level'],
    whyItMatters:
      'sell-through outrunning replenishment causes stockouts and lost sales — velocity flags it; a stock-level catalog confirms it.',
    eql: () => `select count event purchase by event purchase.product_id grouping top 10 ${win}`,
    thresholds: { critical: 30, warning: 15 },
  },
  {
    id: 'campaign_perf',
    label: 'campaign performance',
    requires: ['session_start'],
    enriches: ['session_start.utm_source'],
    whyItMatters:
      'a swing in campaign-driven traffic shifts the top of the funnel — a utm source attributes it to the channel that moved.',
    eql: () => `select count event session_start ${win}`,
    thresholds: { critical: 25, warning: 12 },
  },
  {
    id: 'search_failure',
    label: 'search failure',
    requires: ['search'],
    whyItMatters:
      'zero-result searches are demand the catalog or relevance is failing to meet — a direct, fixable revenue leak.',
    eql: () => `select count event search ${win}`,
    thresholds: { critical: 20, warning: 10 },
  },
  {
    id: 'return_spike',
    label: 'product return spike',
    requires: ['return'],
    whyItMatters:
      'a return spike erodes the revenue already booked and points at a quality, sizing, or expectation gap on specific SKUs.',
    eql: () => `select count event return ${win}`,
    thresholds: { critical: 25, warning: 12 },
  },
  {
    id: 'fraud',
    label: 'fraud detection',
    requires: ['payment_failure'],
    whyItMatters:
      'clusters of failed payments or anomalous orders signal card-testing or fraud — costly in chargebacks if unwatched.',
    eql: () => `select count event payment_failure ${win}`,
    thresholds: { critical: 20, warning: 10 },
  },
];

/** Build the set of capabilities the workspace exposes: event names, plus
 *  `event.property` and `catalog:<name>` strings for property/catalog deps. */
export function schemaCapabilities(schema: {
  events: { name: string; properties: string[] }[];
  catalogs?: { name: string }[];
}): Set<string> {
  const set = new Set<string>();
  for (const e of schema.events ?? []) {
    set.add(e.name);
    for (const p of e.properties ?? []) set.add(`${e.name}.${p}`);
  }
  for (const c of schema.catalogs ?? []) set.add(`catalog:${c.name}`);
  return set;
}

/** Pure gate: missing a hard dep → unavailable; missing only a soft dep →
 *  limited; else full. `available` is the capability set from schemaCapabilities. */
export function coverageFor(cat: AnomalyCategory, available: Set<string>): CategoryCoverage {
  const has = (dep: string) => available.has(dep);
  if (!cat.requires.every(has)) return 'unavailable';
  if (cat.enriches && cat.enriches.length > 0 && !cat.enriches.every(has)) return 'limited';
  return 'full';
}

/** The required/enriching deps that were absent (for the ghost-tile copy). */
export function missingFor(cat: AnomalyCategory, available: Set<string>): string[] {
  return [...cat.requires, ...(cat.enriches ?? [])].filter((d) => !available.has(d));
}

/** The full coverage summary across all 10 categories, registry order. */
export function coverageReport(available: Set<string>): CoverageReport {
  return CATEGORIES.map((cat) => {
    const coverage = coverageFor(cat, available);
    const missing = missingFor(cat, available);
    return {
      category: cat.id,
      label: cat.label,
      coverage,
      ...(coverage !== 'full' && missing.length ? { missing } : {}),
    };
  });
}

/** Categories the monitoring agent should actually run (full + limited). */
export function runnableCategories(available: Set<string>): AnomalyCategory[] {
  return CATEGORIES.filter((cat) => coverageFor(cat, available) !== 'unavailable');
}
