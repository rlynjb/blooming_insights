import { describe, expect, it, vi } from 'vitest';
import { makeDataSource, parseLiveMode, SyntheticDataSource } from '../../lib/data-source';
import { bootstrapSchema, _resetSchemaCache } from '../../lib/mcp/schema';

vi.mock('../../lib/mcp/connect', () => ({
  connectMcp: vi.fn(async () => {
    throw new Error('connectMcp should not be called for live-synthetic');
  }),
}));

describe('SyntheticDataSource', () => {
  it('lists Bloomreach-shaped tools for the existing agents', async () => {
    const dataSource = new SyntheticDataSource();

    const listed = await dataSource.listTools();
    const names = listed.tools.map((tool) => tool.name);

    expect(names).toContain('execute_analytics_eql');
    expect(names).toContain('list_scenarios');
    expect(names).toContain('list_cloud_organizations');
  });

  it('returns bootstrap payloads that parse into a workspace schema', async () => {
    _resetSchemaCache();
    const dataSource = new SyntheticDataSource();

    const schema = await bootstrapSchema(dataSource);

    expect(schema.projectId).toBe('synthetic-blooming-project');
    expect(schema.events.map((event) => event.name)).toContain('purchase');
    expect(schema.events.map((event) => event.name)).toContain('payment_failure');
    expect(schema.customerProperties).toContain('predicted_churn_risk');
    expect(schema.catalogs.map((catalog) => catalog.name)).toContain('inventory_level');
  });

  it('returns analytics evidence in MCP-compatible result envelopes', async () => {
    const dataSource = new SyntheticDataSource();

    const { result, fromCache, durationMs } = await dataSource.callTool(
      'execute_analytics_eql',
      { project_id: 'synthetic-blooming-project', eql: 'select count event purchase in last 7 days' },
    );

    const envelope = result as {
      structuredContent?: { anomalies?: Array<{ category?: string }> };
      content?: Array<{ text?: string }>;
    };
    expect(fromCache).toBe(false);
    expect(durationMs).toBeGreaterThanOrEqual(0);
    expect(envelope.structuredContent?.anomalies?.[0]?.category).toBe('conversion_drop');
    expect(envelope.content?.[0]?.text).toContain('Synthetic weekly scan');
  });
});

describe('makeDataSource synthetic mode', () => {
  it('selects synthetic without connecting to Bloomreach', async () => {
    _resetSchemaCache();
    const result = await makeDataSource('live-synthetic', 'test-session');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mode).toBe('live-synthetic');
    expect(await result.bootstrap()).toMatchObject({
      projectId: 'synthetic-blooming-project',
      projectName: 'Synthetic Blooming Workspace',
    });
  });

  it('parses only the explicit synthetic mode and defaults all legacy values to Bloomreach', () => {
    expect(parseLiveMode('live-synthetic')).toBe('live-synthetic');
    expect(parseLiveMode('live-bloomreach')).toBe('live-bloomreach');
    expect(parseLiveMode('live-sql')).toBe('live-bloomreach');
    expect(parseLiveMode(null)).toBe('live-bloomreach');
  });
});
