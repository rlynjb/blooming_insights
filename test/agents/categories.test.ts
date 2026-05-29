import { describe, it, expect } from 'vitest';
import {
  CATEGORIES,
  coverageFor,
  missingFor,
  coverageReport,
  runnableCategories,
  schemaCapabilities,
} from '../../lib/agents/categories';

// the wobbly-ukulele event schema (no search/return/payment_failure events;
// no utm_source property; no inventory_level catalog).
const wobblyEvents = ['view_item', 'cart_update', 'checkout', 'session_start', 'purchase'];
const wobbly = new Set<string>(wobblyEvents);

const cat = (id: string) => CATEGORIES.find((c) => c.id === id)!;

describe('coverageFor', () => {
  it('is full when all hard deps are present and no soft deps are missing', () => {
    expect(coverageFor(cat('conversion_drop'), wobbly)).toBe('full');
    expect(coverageFor(cat('cart_abandonment'), wobbly)).toBe('full');
    expect(coverageFor(cat('revenue_drop'), wobbly)).toBe('full');
    expect(coverageFor(cat('customer_churn'), wobbly)).toBe('full');
    expect(coverageFor(cat('product_demand'), wobbly)).toBe('full');
  });

  it('is unavailable when a required event is missing', () => {
    expect(coverageFor(cat('search_failure'), wobbly)).toBe('unavailable');
    expect(coverageFor(cat('return_spike'), wobbly)).toBe('unavailable');
    expect(coverageFor(cat('fraud'), wobbly)).toBe('unavailable');
  });

  it('is limited when hard deps are present but a soft (property/catalog) dep is missing', () => {
    expect(coverageFor(cat('campaign_perf'), wobbly)).toBe('limited'); // no session_start.utm_source
    expect(coverageFor(cat('inventory'), wobbly)).toBe('limited'); // no catalog:inventory_level
  });

  it('upgrades a limited category to full when the soft dep appears', () => {
    const withUtm = new Set<string>([...wobblyEvents, 'session_start.utm_source']);
    expect(coverageFor(cat('campaign_perf'), withUtm)).toBe('full');
    const withCatalog = new Set<string>([...wobblyEvents, 'catalog:inventory_level']);
    expect(coverageFor(cat('inventory'), withCatalog)).toBe('full');
  });

  it('drops a full category to unavailable when a required event disappears', () => {
    const noPurchase = new Set<string>(['view_item', 'cart_update', 'checkout', 'session_start']);
    expect(coverageFor(cat('revenue_drop'), noPurchase)).toBe('unavailable');
    expect(coverageFor(cat('conversion_drop'), noPurchase)).toBe('unavailable');
  });
});

describe('missingFor', () => {
  it('lists absent required events', () => {
    expect(missingFor(cat('search_failure'), wobbly)).toEqual(['search']);
    expect(missingFor(cat('return_spike'), wobbly)).toEqual(['return']);
  });
  it('lists absent soft deps for limited categories', () => {
    expect(missingFor(cat('campaign_perf'), wobbly)).toEqual(['session_start.utm_source']);
    expect(missingFor(cat('inventory'), wobbly)).toEqual(['catalog:inventory_level']);
  });
  it('is empty when everything is present', () => {
    expect(missingFor(cat('revenue_drop'), wobbly)).toEqual([]);
  });
});

describe('coverageReport', () => {
  it('covers all 10 categories in registry order, with the expected resolutions for wobbly-ukulele', () => {
    const report = coverageReport(wobbly);
    expect(report).toHaveLength(10);
    expect(report.map((r) => r.coverage)).toEqual([
      'full', // conversion_drop
      'full', // cart_abandonment
      'full', // product_demand
      'full', // revenue_drop
      'full', // customer_churn
      'limited', // inventory
      'limited', // campaign_perf
      'unavailable', // search_failure
      'unavailable', // return_spike
      'unavailable', // fraud
    ]);
  });
  it('omits `missing` on full categories and includes it otherwise', () => {
    const byId = Object.fromEntries(coverageReport(wobbly).map((r) => [r.category, r]));
    expect(byId.revenue_drop.missing).toBeUndefined();
    expect(byId.search_failure.missing).toEqual(['search']);
    expect(byId.inventory.missing).toEqual(['catalog:inventory_level']);
  });
});

describe('runnableCategories', () => {
  it('returns only full + limited (never unavailable)', () => {
    const ids = runnableCategories(wobbly).map((c) => c.id);
    expect(ids).toEqual([
      'conversion_drop',
      'cart_abandonment',
      'product_demand',
      'revenue_drop',
      'customer_churn',
      'inventory',
      'campaign_perf',
    ]);
    expect(ids).not.toContain('search_failure');
  });
});

describe('schemaCapabilities', () => {
  it('flattens events, event.property, and catalog:name into one set', () => {
    const caps = schemaCapabilities({
      events: [
        { name: 'purchase', properties: ['total_price', 'product_id'] },
        { name: 'session_start', properties: ['utm_source'] },
      ],
      catalogs: [{ name: 'products' }],
    });
    expect(caps.has('purchase')).toBe(true);
    expect(caps.has('purchase.total_price')).toBe(true);
    expect(caps.has('session_start.utm_source')).toBe(true);
    expect(caps.has('catalog:products')).toBe(true);
    expect(caps.has('view_item')).toBe(false);
  });
});
