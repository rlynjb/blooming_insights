// test/api/briefing.integration.test.ts
//
// Integration tests for GET /api/briefing. This file establishes the
// scaffolding (Phase 1 of the integration tests plan) with one smoke test
// that proves end-to-end: route entry → handler → NDJSON stream out.
//
// Mocks live at module scope so they're registered before the route module is
// imported (vitest hoists `vi.mock`). The shared helpers in `_helpers.ts`
// supply scripted Anthropic responses + a fake `McpClient`.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { AgentEvent } from '../../lib/mcp/events';
import {
  collectEvents,
  makeMockSession,
  makeMockTransport,
  mockAnthropicModule,
  mockAnthropicResponse,
  resetAnthropicQueue,
  setAnthropicResponses,
} from './_helpers';

// 1) Stub the Anthropic SDK at module load — the route does `new Anthropic(...)`
//    inside the handler, so the mock has to be in place before the route module
//    runs. The factory wires a scripted queue we fill per-test.
vi.mock('@anthropic-ai/sdk', () => mockAnthropicModule());

// 2) Stub the session + connect surfaces so the route never touches the cookie
//    store or the live Bloomreach MCP. Same pattern as
//    test/api/mcp-call-allowlist.test.ts (the only other route test today).
const mockMcp = makeMockTransport('ok');
const mockSession = makeMockSession('authed');

vi.mock('../../lib/mcp/session', () => ({
  getOrCreateSessionId: vi.fn(async () => mockSession.sessionId),
  readSessionId: vi.fn(async () => mockSession.sessionId),
}));

vi.mock('../../lib/mcp/connect', () => ({
  connectMcp: vi.fn(async () => ({ ok: true as const, mcp: mockMcp })),
  completeAuth: vi.fn(async () => {}),
}));

// Import AFTER the mocks are registered so the route sees them.
import { GET } from '../../app/api/briefing/route';
import { _resetSchemaCache } from '../../lib/mcp/schema';

beforeEach(() => {
  // `bootstrapSchema` memoizes — without a reset, the second test would skip
  // the bootstrap callTool path entirely and our mock-call assertions drift.
  _resetSchemaCache();
  resetAnthropicQueue();
  mockMcp.callTool.mockClear();
  mockMcp.listTools.mockClear();
  // The route reads ANTHROPIC_API_KEY before opening the stream; without a
  // value it returns 500. Any non-empty string is fine — the actual SDK is
  // mocked.
  process.env.ANTHROPIC_API_KEY = 'test-key';
});

describe('GET /api/briefing — smoke (Phase 1 scaffolding)', () => {
  it('streams NDJSON ending in `done` on the happy path', async () => {
    // Arrange — script the monitoring agent to return [] immediately so the
    // loop terminates after exactly ONE Anthropic call. This is the minimum
    // happy path: no anomalies => no insights => `done` flushes.
    setAnthropicResponses([
      mockAnthropicResponse({
        text: '```json\n[]\n```',
        stop_reason: 'end_turn',
      }),
    ]);

    // Act
    const req = new NextRequest('http://localhost:3000/api/briefing');
    const response = await GET(req);

    // Assert: status + content-type
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/x-ndjson');

    const events = await collectEvents<AgentEvent | { type: string }>(response);

    // The route emits a deterministic phase order on the happy path:
    //   reasoning_step (schema)
    //   workspace
    //   reasoning_step + coverage_item per category (×10)
    //   reasoning_step ("checking N of 10…")
    //   …monitoring agent runs (no insights here)
    //   done
    expect(events.length).toBeGreaterThan(0);
    const types = events.map((e) => (e as { type: string }).type);
    expect(types).toContain('workspace');
    expect(types).toContain('coverage_item');
    expect(types[types.length - 1]).toBe('done');

    // The 6 bootstrap tool calls fire exactly once each + listTools once.
    expect(mockMcp.listTools).toHaveBeenCalledTimes(1);
    const calledTools = mockMcp.callTool.mock.calls.map((c) => c[0]);
    expect(calledTools).toContain('list_cloud_organizations');
    expect(calledTools).toContain('list_projects');
    expect(calledTools).toContain('get_event_schema');
    expect(calledTools).toContain('get_customer_property_schema');
    expect(calledTools).toContain('list_catalogs');
    expect(calledTools).toContain('get_project_overview');
  });
});
