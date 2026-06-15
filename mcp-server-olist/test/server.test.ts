// mcp-server-olist/test/server.test.ts
//
// Server-level smoke tests — exercise the callTool dispatcher without spinning
// up the stdio transport. The integration test at
// test/data-source/olist.integration.test.ts goes through the wire.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../src/db';
import { callTool, TOOL_DEFINITIONS, buildServer } from '../src/server';

let db: Database.Database;
beforeAll(() => {
  db = openDb();
});
afterAll(() => {
  db.close();
});

const VALID_WINDOW = { from: '2025-12-01', to: '2026-06-01' };

describe('TOOL_DEFINITIONS', () => {
  it('exposes exactly 3 tools', () => {
    expect(TOOL_DEFINITIONS).toHaveLength(3);
  });
  it('names match the spec', () => {
    const names = TOOL_DEFINITIONS.map((t) => t.name);
    expect(names).toEqual(['get_metric_timeseries', 'get_segments', 'get_anomaly_context']);
  });
  it('every tool has a description and an inputSchema', () => {
    for (const t of TOOL_DEFINITIONS) {
      expect(t.description).toBeTruthy();
      expect(t.inputSchema).toBeTruthy();
      expect((t.inputSchema as { type: string }).type).toBe('object');
    }
  });
});

describe('buildServer', () => {
  it('returns an MCP Server instance with the tools capability', () => {
    const server = buildServer(db);
    expect(server).toBeTruthy();
    // Server.constructor.name is 'Server' — sanity check on the SDK class.
    expect(server.constructor.name).toBe('Server');
  });
});

describe('callTool dispatcher', () => {
  it('returns a success envelope for a valid get_metric_timeseries call', () => {
    const envelope = callTool(db, 'get_metric_timeseries', {
      metric: 'revenue',
      time_range: VALID_WINDOW,
    });
    expect((envelope as { isError?: boolean }).isError).not.toBe(true);
    expect(Array.isArray(envelope.content)).toBe(true);
    expect(envelope.content[0].type).toBe('text');
    // structuredContent.data is the parsed result.
    const data = (envelope as { structuredContent: { data: unknown } }).structuredContent.data;
    expect(data).toHaveProperty('points');
    expect(data).toHaveProperty('totalCount');
  });

  it('returns a success envelope for get_segments', () => {
    const envelope = callTool(db, 'get_segments', { dimension: 'category' });
    expect((envelope as { isError?: boolean }).isError).not.toBe(true);
    const data = (envelope as { structuredContent: { data: { segments: unknown[] } } })
      .structuredContent.data;
    expect(data.segments.length).toBe(7);
  });

  it('returns isError envelope for unknown tool', () => {
    const envelope = callTool(db, 'not_a_tool', {});
    expect((envelope as { isError?: boolean }).isError).toBe(true);
    expect(envelope.content[0].text).toMatch(/unknown tool/);
  });

  it('returns isError envelope for invalid input (missing metric)', () => {
    const envelope = callTool(db, 'get_metric_timeseries', { time_range: VALID_WINDOW });
    expect((envelope as { isError?: boolean }).isError).toBe(true);
    expect(envelope.content[0].text).toMatch(/invalid input/);
  });

  it('returns isError envelope for invalid input (bad metric enum)', () => {
    const envelope = callTool(db, 'get_metric_timeseries', {
      metric: 'profit',
      time_range: VALID_WINDOW,
    });
    expect((envelope as { isError?: boolean }).isError).toBe(true);
  });

  it('returns isError envelope when invalid ISO date is passed', () => {
    const envelope = callTool(db, 'get_metric_timeseries', {
      metric: 'revenue',
      time_range: { from: 'not-a-date', to: '2026-06-01' },
    });
    expect((envelope as { isError?: boolean }).isError).toBe(true);
    expect(envelope.content[0].text).toMatch(/tool error|invalid/i);
  });
});
