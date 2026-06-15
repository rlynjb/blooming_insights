// test/data-source/olist.integration.test.ts
//
// Integration test: spin up the real mcp-server-olist subprocess, drive it
// through the OlistDataSource adapter, assert the wire works end-to-end.
//
// Prerequisite: `npm run build` in mcp-server-olist/ before running these tests
// (the seed + build also runs in CI). Tests skip if the compiled entry is
// missing so a fresh clone doesn't see a confusing failure.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { OlistDataSource, OlistToolError } from '../../lib/data-source/olist-data-source';

const SERVER_ENTRY = resolve(
  __dirname,
  '../../mcp-server-olist/dist/src/index.js',
);
const DB_PATH = resolve(__dirname, '../../mcp-server-olist/data/olist.db');

// Skip the whole suite if the precondition isn't satisfied — avoids confusing
// "command not found" errors on a fresh clone.
const isReady = existsSync(SERVER_ENTRY) && existsSync(DB_PATH);
const describeIfReady = isReady ? describe : describe.skip;

const WINDOW = { from: '2025-12-01', to: '2026-06-01' };

describeIfReady('OlistDataSource — subprocess lifecycle + tool calls', () => {
  let ds: OlistDataSource;

  beforeAll(async () => {
    ds = new OlistDataSource({ serverEntry: SERVER_ENTRY });
    await ds.connect();
  }, 15_000);

  afterAll(async () => {
    await ds.dispose();
  });

  it('listTools returns the 3 advertised tools', async () => {
    const result = (await ds.listTools()) as { tools: Array<{ name: string }> };
    expect(result.tools).toHaveLength(3);
    const names = result.tools.map((t) => t.name).sort();
    expect(names).toEqual(['get_anomaly_context', 'get_metric_timeseries', 'get_segments']);
  });

  it('calls get_metric_timeseries and returns the {result, durationMs, fromCache} envelope', async () => {
    const out = await ds.callTool('get_metric_timeseries', {
      metric: 'revenue',
      time_range: WINDOW,
    });
    expect(typeof out.durationMs).toBe('number');
    expect(out.durationMs).toBeGreaterThanOrEqual(0);
    expect(out.fromCache).toBe(false);
    const r = out.result as {
      isError?: boolean;
      structuredContent?: { data: { points: unknown[]; totalCount: number } };
      content: Array<{ text: string }>;
    };
    expect(r.isError).not.toBe(true);
    // structuredContent is the typed path; content[0].text is the JSON-stringified fallback.
    expect(r.structuredContent?.data.points.length).toBeGreaterThan(0);
  });

  it('calls get_segments and returns 7 categories', async () => {
    const out = await ds.callTool('get_segments', { dimension: 'category' });
    const r = out.result as { structuredContent?: { data: { segments: unknown[] } } };
    expect(r.structuredContent?.data.segments.length).toBe(7);
  });

  it('calls get_anomaly_context with seeded windows', async () => {
    const out = await ds.callTool('get_anomaly_context', {
      metric: 'revenue',
      dimension: 'state',
      segment: 'SP',
      anomaly_window: { from: '2025-12-22', to: '2025-12-29' },
      baseline_window: { from: '2025-10-01', to: '2025-12-22' },
    });
    const r = out.result as {
      structuredContent?: {
        data: { anomaly_summary: { segment: string }; related_segments: unknown[] };
      };
    };
    expect(r.structuredContent?.data.anomaly_summary.segment).toBe('SP');
    expect(r.structuredContent?.data.related_segments.length).toBeGreaterThan(0);
  });

  it('returns an isError result for an invalid input rather than throwing', async () => {
    const out = await ds.callTool('get_metric_timeseries', { metric: 'profit', time_range: WINDOW });
    const r = out.result as { isError?: boolean };
    expect(r.isError).toBe(true);
  });

  it('returns an isError result for an unknown tool name', async () => {
    const out = await ds.callTool('not_a_tool', {});
    const r = out.result as { isError?: boolean };
    expect(r.isError).toBe(true);
  });

  it('multiple sequential calls reuse the same subprocess', async () => {
    const a = await ds.callTool('get_segments', { dimension: 'state' });
    const b = await ds.callTool('get_segments', { dimension: 'category' });
    const c = await ds.callTool('get_segments', { dimension: 'payment_type' });
    expect(a.fromCache).toBe(false);
    expect(b.fromCache).toBe(false);
    expect(c.fromCache).toBe(false);
  });
});

describeIfReady('OlistDataSource — AbortSignal propagation', () => {
  it('aborts an in-flight call when the signal fires', async () => {
    const ds = new OlistDataSource({ serverEntry: SERVER_ENTRY });
    await ds.connect();
    try {
      const ac = new AbortController();
      // Fire the abort almost immediately so the in-flight MCP call is canceled.
      setTimeout(() => ac.abort(), 1);
      await expect(
        ds.callTool(
          'get_metric_timeseries',
          { metric: 'revenue', time_range: WINDOW },
          { signal: ac.signal },
        ),
      ).rejects.toBeInstanceOf(OlistToolError);
    } finally {
      await ds.dispose();
    }
  });

  it('an already-aborted signal rejects immediately', async () => {
    const ds = new OlistDataSource({ serverEntry: SERVER_ENTRY });
    await ds.connect();
    try {
      const ac = new AbortController();
      ac.abort();
      await expect(
        ds.callTool(
          'get_metric_timeseries',
          { metric: 'revenue', time_range: WINDOW },
          { signal: ac.signal },
        ),
      ).rejects.toBeInstanceOf(OlistToolError);
    } finally {
      await ds.dispose();
    }
  });
});

describeIfReady('OlistDataSource — dispose', () => {
  it('dispose() kills the subprocess and is idempotent', async () => {
    const ds = new OlistDataSource({ serverEntry: SERVER_ENTRY });
    await ds.connect();
    await ds.dispose();
    await ds.dispose(); // second call should not throw
    // After dispose, a new call lazy-reconnects.
    await ds.connect();
    const out = await ds.callTool('get_segments', { dimension: 'category' });
    expect((out.result as { isError?: boolean }).isError).not.toBe(true);
    await ds.dispose();
  });
});
