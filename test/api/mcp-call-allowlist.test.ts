// Contract pin tests for the /api/mcp/call allowlist guard. These don't
// assert the happy-path call shape; they pin the boundary:
//   - an allowlisted name reaches conn.mcp.callTool (no 403)
//   - an unsanctioned name (e.g. 'whoami', historically valid, now removed)
//     returns 403 with { error: 'tool not allowed' }
//   - a non-string name returns the same 403
//
// We mock the two dependencies the route imports at module scope so we can
// observe whether callTool was reached without standing up real auth / MCP.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const callToolMock = vi.fn();

vi.mock('../../lib/mcp/session', () => ({
  getOrCreateSessionId: vi.fn(async () => 'test-sid'),
}));

vi.mock('../../lib/mcp/connect', () => ({
  connectMcp: vi.fn(async () => ({
    ok: true as const,
    mcp: { callTool: callToolMock },
  })),
}));

// Import the handler AFTER the mocks are registered so the module sees them.
import { POST } from '../../app/api/mcp/call/route';

function makeReq(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/mcp/call', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/mcp/call — tool-name allowlist', () => {
  beforeEach(() => {
    callToolMock.mockReset();
    callToolMock.mockResolvedValue({ result: { ok: true }, durationMs: 1, fromCache: false });
  });

  it('lets an allowlisted name through (no 403)', async () => {
    // 'list_dashboards' is the first monitoringTools entry.
    const res = await POST(makeReq({ name: 'list_dashboards', args: {} }));
    expect(res.status).not.toBe(403);
    expect(callToolMock).toHaveBeenCalledTimes(1);
    expect(callToolMock).toHaveBeenCalledWith('list_dashboards', {}, { skipCache: true });
  });

  it("returns 403 for 'whoami' (removed from /debug; pins end-to-end contract)", async () => {
    const res = await POST(makeReq({ name: 'whoami', args: {} }));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toEqual({ error: 'tool not allowed' });
    expect(callToolMock).not.toHaveBeenCalled();
  });

  it('returns 403 for a non-string name', async () => {
    const res = await POST(makeReq({ name: 42, args: {} }));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toEqual({ error: 'tool not allowed' });
    expect(callToolMock).not.toHaveBeenCalled();
  });
});
