import { describe, it, expect, vi } from 'vitest';
import { McpClient } from '../../lib/mcp/client';
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
    const t: McpTransport = { async callTool() { n++; return n < 3 ? { isError: true, content: [{ type: 'text', text: 'Too many requests: rate limit reached (1 per 1 second)' }] } : { isError: false, ok: true }; }, async listTools() { return { tools: [] }; } };
    const c = new McpClient(t, { minIntervalMs: 0, retryDelayMs: 1 });
    const r = await c.callTool('x', {});
    expect((r.result as any).ok).toBe(true);
    expect(n).toBe(3);
  });

  it('gives up after maxRetries and returns the error result', async () => {
    let n = 0;
    const t: McpTransport = { async callTool() { n++; return { isError: true, content: [{ type: 'text', text: 'rate limit reached' }] }; }, async listTools() { return { tools: [] }; } };
    const c = new McpClient(t, { minIntervalMs: 0, retryDelayMs: 1, maxRetries: 2 });
    const r = await c.callTool('x', {});
    expect((r.result as any).isError).toBe(true);
    expect(n).toBe(3); // 1 initial + 2 retries
  });
});
