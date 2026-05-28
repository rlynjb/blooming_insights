import { describe, it, expect, vi } from 'vitest';
import { McpClient, McpToolError } from '../../lib/mcp/client';
import type { McpTransport } from '../../lib/mcp/transport';

function fakeTransport(impl: (name: string) => unknown): McpTransport & { calls: number } {
  const t = {
    calls: 0,
    async callTool(name: string) { t.calls++; return impl(name); },
    async listTools() { return { tools: [] }; },
  };
  return t;
}

describe('McpClient', () => {
  it('returns the transport result and marks fromCache=false on a miss', async () => {
    const t = fakeTransport(() => ({ ok: 1 }));
    const c = new McpClient(t);
    const r = await c.callTool('whoami', {});
    expect(r.result).toEqual({ ok: 1 });
    expect(r.fromCache).toBe(false);
    expect(t.calls).toBe(1);
  });

  it('serves a cached result within ttl without hitting the transport', async () => {
    const t = fakeTransport(() => ({ ok: 1 }));
    const c = new McpClient(t);
    await c.callTool('whoami', {});
    const r2 = await c.callTool('whoami', {});
    expect(r2.fromCache).toBe(true);
    expect(t.calls).toBe(1);
  });

  it('caches per name+args', async () => {
    const t = fakeTransport((n) => ({ n }));
    const c = new McpClient(t);
    await c.callTool('get_trend', { a: 1 });
    await c.callTool('get_trend', { a: 2 });
    expect(t.calls).toBe(2);
  });

  it('skipCache bypasses the cache', async () => {
    const t = fakeTransport(() => ({ ok: 1 }));
    const c = new McpClient(t);
    await c.callTool('whoami', {});
    await c.callTool('whoami', {}, { skipCache: true });
    expect(t.calls).toBe(2);
  });

  it('expires cache after ttl', async () => {
    vi.useFakeTimers();
    const t = fakeTransport(() => ({ ok: 1 }));
    const c = new McpClient(t);
    await c.callTool('whoami', {}, { cacheTtlMs: 1000 });
    vi.advanceTimersByTime(1001);
    await c.callTool('whoami', {}, { cacheTtlMs: 1000 });
    expect(t.calls).toBe(2);
    vi.useRealTimers();
  });

  it('rate limits to minIntervalMs between live calls', async () => {
    vi.useFakeTimers();
    const t = fakeTransport((n) => ({ n }));
    const c = new McpClient(t, { minIntervalMs: 200 });
    const p1 = c.callTool('a', {});
    await vi.runAllTimersAsync();
    await p1;
    const start = Date.now();
    const p2 = c.callTool('b', {});
    await vi.advanceTimersByTimeAsync(199);
    let done = false;
    p2.then(() => { done = true; });
    await Promise.resolve();
    expect(done).toBe(false); // still waiting on the 200ms floor
    await vi.advanceTimersByTimeAsync(1);
    await p2;
    expect(Date.now() - start).toBeGreaterThanOrEqual(200);
    vi.useRealTimers();
  });

  it('listTools delegates to the transport', async () => {
    const t: McpTransport = {
      async callTool() { return {}; },
      async listTools() { return { tools: [{ name: 'list_projects' }] }; },
    };
    const c = new McpClient(t);
    expect(await c.listTools()).toEqual({ tools: [{ name: 'list_projects' }] });
  });

  it('does not cache an error result', async () => {
    let n = 0;
    const t: McpTransport = { async callTool() { n++; return n === 1 ? { isError: true, content: [{ type: 'text', text: 'boom' }] } : { ok: 1 }; }, async listTools() { return { tools: [] }; } };
    const c = new McpClient(t, { minIntervalMs: 0 });
    const r1 = await c.callTool('x', {});
    expect((r1.result as any).isError).toBe(true);
    const r2 = await c.callTool('x', {}); // same key — must NOT be served from cache
    expect(r2.fromCache).toBe(false);
    expect((r2.result as any).ok).toBe(1);
    expect(n).toBe(2);
  });

  it('retries a rate-limited result then succeeds', async () => {
    let n = 0;
    // No parseable window in the text → falls back to the (tiny) backoff base.
    const t: McpTransport = { async callTool() { n++; return n < 3 ? { isError: true, content: [{ type: 'text', text: 'Too many requests: rate limit reached' }] } : { isError: false, ok: true }; }, async listTools() { return { tools: [] }; } };
    const c = new McpClient(t, { minIntervalMs: 0, retryDelayMs: 1 });
    const r = await c.callTool('x', {});
    expect((r.result as any).ok).toBe(true);
    expect(n).toBe(3);
  });

  it('waits the parsed retry-after window for "(1 per 10 second)", then succeeds and caches', async () => {
    vi.useFakeTimers();
    let n = 0;
    let firstFailAt = 0;
    let retryAt = 0;
    const t: McpTransport = {
      async callTool() {
        n++;
        if (n === 1) {
          firstFailAt = Date.now();
          return { isError: true, content: [{ type: 'text', text: 'Too many requests: rate limit reached (1 per 10 second)' }] };
        }
        retryAt = Date.now();
        return { isError: false, ok: true };
      },
      async listTools() { return { tools: [] }; },
    };
    const c = new McpClient(t, { minIntervalMs: 0 }); // default retry tuning (10s window)
    const p = c.callTool('x', {});
    await vi.runAllTimersAsync();
    const r = await p;
    expect((r.result as any).ok).toBe(true);
    expect(n).toBe(2);
    // The retry waited at least the parsed 10s window (not the old 1.2s).
    expect(retryAt - firstFailAt).toBeGreaterThanOrEqual(10_000);
    // A rate-limited-then-successful call caches its success.
    const r2 = await c.callTool('x', {});
    expect(r2.fromCache).toBe(true);
    vi.useRealTimers();
  });

  it('honors an explicit "Retry after ~N seconds" hint over the backoff base', async () => {
    vi.useFakeTimers();
    let n = 0;
    let firstFailAt = 0;
    let retryAt = 0;
    const t: McpTransport = {
      async callTool() {
        n++;
        if (n === 1) {
          firstFailAt = Date.now();
          return { isError: true, content: [{ type: 'text', text: 'rate limit reached. Retry after ~7 seconds' }] };
        }
        retryAt = Date.now();
        return { isError: false, ok: true };
      },
      async listTools() { return { tools: [] }; },
    };
    const c = new McpClient(t, { minIntervalMs: 0, retryDelayMs: 60_000 });
    const p = c.callTool('x', {});
    await vi.runAllTimersAsync();
    await p;
    const waited = retryAt - firstFailAt;
    expect(waited).toBeGreaterThanOrEqual(7_000);
    expect(waited).toBeLessThan(8_000); // the 7s hint, not the 60s fallback base
    vi.useRealTimers();
  });

  it('gives up after maxRetries and returns the error result', async () => {
    let n = 0;
    const t: McpTransport = { async callTool() { n++; return { isError: true, content: [{ type: 'text', text: 'rate limit reached' }] }; }, async listTools() { return { tools: [] }; } };
    const c = new McpClient(t, { minIntervalMs: 0, retryDelayMs: 1, maxRetries: 2 });
    const r = await c.callTool('x', {});
    expect((r.result as any).isError).toBe(true);
    expect(n).toBe(3); // 1 initial + 2 retries
  });

  it('wraps a transport throw as McpToolError tagged with the tool name + detail', async () => {
    const t: McpTransport = {
      async callTool() { throw new Error('Unauthorized'); },
      async listTools() { return { tools: [] }; },
    };
    const c = new McpClient(t, { minIntervalMs: 0 });
    await expect(c.callTool('list_cloud_organizations', {})).rejects.toBeInstanceOf(McpToolError);
    await expect(c.callTool('list_cloud_organizations', {})).rejects.toThrow(
      'list_cloud_organizations → Unauthorized',
    );
  });

  it('includes a thrown error.cause in the detail', async () => {
    const t: McpTransport = {
      async callTool() { throw new Error('fetch failed', { cause: new Error('ECONNREFUSED') }); },
      async listTools() { return { tools: [] }; },
    };
    const c = new McpClient(t, { minIntervalMs: 0 });
    await expect(c.callTool('get_event_schema', {})).rejects.toThrow(/ECONNREFUSED/);
  });
});
