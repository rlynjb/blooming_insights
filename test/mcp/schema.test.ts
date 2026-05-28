import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { unwrap, parseWorkspaceSchema } from '../../lib/mcp/schema';

// Load real captured fixtures from disk.
function loadFixture(name: string): unknown {
  const p = join(__dirname, '../fixtures', name);
  return JSON.parse(readFileSync(p, 'utf-8'));
}

const eventSchemaFixture = loadFixture('get_event_schema.json');
const customerPropsFixture = loadFixture('get_customer_property_schema.json');
const catalogsFixture = loadFixture('list_catalogs.json');
const overviewFixture = loadFixture('get_project_overview.json');

// ---------------------------------------------------------------------------
// unwrap
// ---------------------------------------------------------------------------

describe('unwrap', () => {
  it('returns structuredContent when present', () => {
    const result = {
      structuredContent: { data: [1, 2, 3] },
      content: [{ type: 'text', text: '{"data":[9]}' }],
    };
    expect(unwrap<{ data: number[] }>(result)).toEqual({ data: [1, 2, 3] });
  });

  it('falls back to JSON.parse(content[0].text) when structuredContent is absent', () => {
    const result = {
      content: [{ type: 'text', text: '{"hello":"world"}' }],
    };
    expect(unwrap<{ hello: string }>(result)).toEqual({ hello: 'world' });
  });

  it('falls back when structuredContent is null', () => {
    const result = {
      structuredContent: null,
      content: [{ type: 'text', text: '{"x":42}' }],
    };
    expect(unwrap<{ x: number }>(result)).toEqual({ x: 42 });
  });

  it('unwraps real event schema fixture via structuredContent', () => {
    const u = unwrap<{ events: unknown[] }>(eventSchemaFixture);
    expect(Array.isArray(u.events)).toBe(true);
    expect(u.events.length).toBeGreaterThan(0);
  });

  it('unwraps real customer props fixture via structuredContent', () => {
    const u = unwrap<{ properties: unknown[] }>(customerPropsFixture);
    expect(Array.isArray(u.properties)).toBe(true);
    expect(u.properties.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// parseWorkspaceSchema — real fixtures
// ---------------------------------------------------------------------------

describe('parseWorkspaceSchema — real fixtures', () => {
  const schema = parseWorkspaceSchema({
    projectId: 'test-project-id',
    projectName: 'Test Project',
    eventSchema: eventSchemaFixture,
    customerProps: customerPropsFixture,
    catalogs: catalogsFixture,
    overview: overviewFixture,
  });

  it('echoes projectId and projectName', () => {
    expect(schema.projectId).toBe('test-project-id');
    expect(schema.projectName).toBe('Test Project');
  });

  it('events is non-empty (~28 events)', () => {
    expect(schema.events.length).toBe(28);
  });

  it('each event has name (string), properties (string[]), eventCount (number)', () => {
    for (const ev of schema.events) {
      expect(typeof ev.name).toBe('string');
      expect(ev.name.length).toBeGreaterThan(0);
      expect(Array.isArray(ev.properties)).toBe(true);
      for (const p of ev.properties) {
        expect(typeof p).toBe('string');
      }
      expect(typeof ev.eventCount).toBe('number');
    }
  });

  it('events are sorted by eventCount descending', () => {
    for (let i = 0; i < schema.events.length - 1; i++) {
      expect(schema.events[i].eventCount).toBeGreaterThanOrEqual(
        schema.events[i + 1].eventCount,
      );
    }
  });

  it('first event (campaign, 204917) is the most active', () => {
    expect(schema.events[0].name).toBe('campaign');
    expect(schema.events[0].eventCount).toBe(204917);
  });

  it('purchase event is present with correct eventCount', () => {
    const purchase = schema.events.find((e) => e.name === 'purchase');
    expect(purchase).toBeDefined();
    expect(purchase!.eventCount).toBe(27046);
  });

  it('view_item event is present with eventCount > 0', () => {
    const vi = schema.events.find((e) => e.name === 'view_item');
    expect(vi).toBeDefined();
    expect(vi!.eventCount).toBeGreaterThan(0);
    expect(vi!.eventCount).toBe(89717);
  });

  it('view_item has the expected properties', () => {
    const vi = schema.events.find((e) => e.name === 'view_item');
    expect(vi!.properties).toContain('product_id');
    expect(vi!.properties).toContain('title');
    expect(vi!.properties).toContain('brand');
  });

  it('customerProperties is a non-empty string[]', () => {
    expect(Array.isArray(schema.customerProperties)).toBe(true);
    expect(schema.customerProperties.length).toBeGreaterThan(0);
    for (const p of schema.customerProperties) {
      expect(typeof p).toBe('string');
    }
  });

  it('customerProperties contains known fields from fixture', () => {
    expect(schema.customerProperties).toContain('email');
    expect(schema.customerProperties).toContain('first_name');
    expect(schema.customerProperties).toContain('last_name');
    expect(schema.customerProperties).toContain('phone');
    expect(schema.customerProperties.length).toBe(9);
  });

  it('catalogs is empty [] (fixture has empty data)', () => {
    expect(schema.catalogs).toEqual([]);
  });

  it('totalCustomers is positive', () => {
    expect(schema.totalCustomers).toBe(123162);
  });

  it('totalEvents is positive', () => {
    expect(schema.totalEvents).toBe(1173252);
  });

  it('oldestTimestamp is a number', () => {
    expect(schema.oldestTimestamp).toBe(1704073839);
  });

  it('registration event has empty properties array (fixture has no default_group properties)', () => {
    const reg = schema.events.find((e) => e.name === 'registration');
    expect(reg).toBeDefined();
    expect(reg!.properties).toEqual([]);
    expect(reg!.eventCount).toBe(2470);
  });
});

// ---------------------------------------------------------------------------
// parseWorkspaceSchema — robustness (empty/minimal inputs)
// ---------------------------------------------------------------------------

describe('parseWorkspaceSchema — robustness', () => {
  it('handles empty events array without throwing', () => {
    const result = parseWorkspaceSchema({
      projectId: 'p1',
      projectName: 'P1',
      eventSchema: { structuredContent: { events: [] } },
      customerProps: { structuredContent: { properties: [] } },
      catalogs: { structuredContent: { data: [] } },
      overview: {
        structuredContent: {
          data: {
            events: 0,
            total_customers: 0,
            oldest_timestamp: null,
            event_types_overview: {},
          },
        },
      },
    });
    expect(result.events).toEqual([]);
    expect(result.customerProperties).toEqual([]);
    expect(result.catalogs).toEqual([]);
    expect(result.totalCustomers).toBe(0);
    expect(result.totalEvents).toBe(0);
    expect(result.oldestTimestamp).toBeNull();
  });

  it('handles missing event_types_overview gracefully (eventCount defaults to 0)', () => {
    const result = parseWorkspaceSchema({
      projectId: 'p2',
      projectName: 'P2',
      eventSchema: {
        structuredContent: {
          events: [
            {
              type: 'my_event',
              properties: {
                default_group: {
                  properties: [{ property: 'prop_a' }],
                },
              },
            },
          ],
        },
      },
      customerProps: { structuredContent: { properties: [] } },
      catalogs: { structuredContent: { data: [] } },
      overview: {
        structuredContent: {
          data: {
            events: 0,
            total_customers: 0,
            oldest_timestamp: null,
            // no event_types_overview key
          },
        },
      },
    });
    expect(result.events).toHaveLength(1);
    expect(result.events[0].name).toBe('my_event');
    expect(result.events[0].properties).toEqual(['prop_a']);
    expect(result.events[0].eventCount).toBe(0);
  });

  it('handles missing default_group.properties gracefully', () => {
    const result = parseWorkspaceSchema({
      projectId: 'p3',
      projectName: 'P3',
      eventSchema: {
        structuredContent: {
          events: [
            {
              type: 'bare_event',
              // no properties field at all
            },
          ],
        },
      },
      customerProps: { structuredContent: { properties: [] } },
      catalogs: { structuredContent: { data: [] } },
      overview: {
        structuredContent: {
          data: {
            events: 5,
            total_customers: 1,
            oldest_timestamp: 12345,
            event_types_overview: {},
          },
        },
      },
    });
    expect(result.events[0].properties).toEqual([]);
    expect(result.events[0].eventCount).toBe(0);
  });

  it('handles text-only fallback (no structuredContent) for catalogs', () => {
    const result = parseWorkspaceSchema({
      projectId: 'p4',
      projectName: 'P4',
      eventSchema: {
        content: [{ type: 'text', text: '{"events":[]}' }],
      },
      customerProps: {
        content: [{ type: 'text', text: '{"properties":[]}' }],
      },
      catalogs: {
        content: [{ type: 'text', text: '{"data":[]}' }],
      },
      overview: {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              data: {
                events: 0,
                total_customers: 0,
                oldest_timestamp: null,
                event_types_overview: {},
              },
            }),
          },
        ],
      },
    });
    expect(result.events).toEqual([]);
    expect(result.catalogs).toEqual([]);
  });
});
