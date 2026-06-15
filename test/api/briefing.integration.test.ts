// test/api/briefing.integration.test.ts
//
// Integration tests for GET /api/briefing. Phase 1 (smoke) verified the
// scaffolding works; Phase 2 (this file) extends to 7 cases covering the demo
// branch, the unauthed 401 path, two error paths, and the phase-timing log.
//
// One cancellation case from the plan (test 6) is intentionally SKIPPED: the
// route's `start(controller)` does not read `req.signal` and has no abort
// guard inside its bootstrap loop, so a consumer-side cancel doesn't shorten
// the route's work — it only stops the caller from reading. A behavioural
// cancellation test would be a no-op against the current implementation and
// would need either (a) plumbing `req.signal` into the route or (b) shaping a
// test that asserts on stream-cancel semantics rather than route behaviour.
// Both are outside Phase 2's budget; leaving a placeholder `it.skip` keeps the
// gap visible in the suite output.
//
// Mocks live at module scope so they're registered before the route module is
// imported (vitest hoists `vi.mock`). The shared helpers in `_helpers.ts`
// supply scripted Anthropic responses + a fake `McpClient`.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { AgentEvent } from '../../lib/mcp/events';
import {
  anthropicErrorResponse,
  collectEvents,
  makeMockSession,
  makeMockTransport,
  mockAnthropicModule,
  mockAnthropicResponse,
  resetAnthropicQueue,
  setAnthropicResponses,
  type MockMcp,
} from './_helpers';

// 1) Stub the Anthropic SDK at module load — the route does `new Anthropic(...)`
//    inside the handler, so the mock has to be in place before the route module
//    runs. The factory wires a scripted queue we fill per-test.
vi.mock('@anthropic-ai/sdk', () => mockAnthropicModule());

// 2) Stub the session + connect surfaces. The default transport is the happy
//    path; tests that need a different scenario assign to `currentMcp` /
//    `currentConn` in their arrange step, and the mocked `connectMcp` reads
//    those at call-time (so tests don't have to re-mock the module).
let currentMcp: MockMcp = makeMockTransport('ok');
let currentConn: Awaited<ReturnType<typeof import('../../lib/mcp/connect').connectMcp>> = {
  ok: true,
  mcp: currentMcp as unknown as import('../../lib/mcp/client').McpClient,
};
let currentSessionId = 'test-session-001';

vi.mock('../../lib/mcp/session', () => ({
  getOrCreateSessionId: vi.fn(async () => currentSessionId),
  readSessionId: vi.fn(async () => currentSessionId),
}));

vi.mock('../../lib/mcp/connect', () => ({
  connectMcp: vi.fn(async () => currentConn),
  completeAuth: vi.fn(async () => {}),
}));

// Import AFTER the mocks are registered so the route sees them.
import { GET } from '../../app/api/briefing/route';
import { _resetSchemaCache } from '../../lib/mcp/schema';
import { _clear as clearInsights } from '../../lib/state/insights';

beforeEach(() => {
  // `bootstrapSchema` memoizes — without a reset, the second test would skip
  // the bootstrap callTool path entirely and our mock-call assertions drift.
  _resetSchemaCache();
  resetAnthropicQueue();
  clearInsights();
  // Reset the default mocks to the happy path before each test. Individual
  // tests reassign `currentMcp` / `currentConn` / `currentSessionId` to point
  // at their scenario.
  currentMcp = makeMockTransport('ok');
  currentConn = {
    ok: true,
    mcp: currentMcp as unknown as import('../../lib/mcp/client').McpClient,
  };
  currentSessionId = 'test-session-001';
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
    expect(currentMcp.listTools).toHaveBeenCalledTimes(1);
    const calledTools = currentMcp.callTool.mock.calls.map((c) => c[0]);
    expect(calledTools).toContain('list_cloud_organizations');
    expect(calledTools).toContain('list_projects');
    expect(calledTools).toContain('get_event_schema');
    expect(calledTools).toContain('get_customer_property_schema');
    expect(calledTools).toContain('list_catalogs');
    expect(calledTools).toContain('get_project_overview');
  });
});

describe('GET /api/briefing — error + auth + cancellation (Phase 2)', () => {
  // ---------------------------------------------------------------------------
  // Test 2 — demo mode
  // ---------------------------------------------------------------------------
  // The route checks `?demo=cached` (NOT `?demo=1` / `?mode=demo`) and reads
  // `lib/state/demo-insights.json` from disk via `existsSync` + `readFileSync`.
  // The real snapshot already lives in the repo — we exercise the actual demo
  // replay path against it, then assert event shape rather than line-counting.
  // The route's REPLAY_DELAY_MS=140 paces emissions, so we override it via the
  // delay only mattering between events; collectEvents simply waits the stream.
  it('uses snapshot replay on demo=cached and bypasses MCP entirely', async () => {
    // Arrange: nothing scripted — demo branch must never call Anthropic or MCP.
    const req = new NextRequest('http://localhost:3000/api/briefing?demo=cached');

    // Act
    const response = await GET(req);

    // Assert: NDJSON stream identical-shape to the live path.
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/x-ndjson');

    const events = await collectEvents<AgentEvent | { type: string; [k: string]: unknown }>(
      response,
    );
    const types = events.map((e) => (e as { type: string }).type);
    expect(types[0]).toBe('workspace'); // snapshot starts with workspace
    expect(types).toContain('coverage_item');
    expect(types).toContain('insight'); // snapshot has insights to replay
    expect(types[types.length - 1]).toBe('done');

    // Demo replay must NOT touch MCP or Anthropic.
    expect(currentMcp.callTool).not.toHaveBeenCalled();
    expect(currentMcp.listTools).not.toHaveBeenCalled();
  }, 15_000); // demo replay is paced (140ms × N events); bump the timeout

  // ---------------------------------------------------------------------------
  // Test 3 — 401 unauthed
  // ---------------------------------------------------------------------------
  // The route calls `connectMcp(sid)` and returns `NextResponse.json({ needsAuth,
  // authUrl }, { status: 401 })` when `conn.ok === false`. The 401 is a plain
  // JSON body — no stream is opened, so we don't need to drain NDJSON here.
  it('returns 401 with authUrl when connectMcp reports unauthed', async () => {
    // Arrange: swap the connect mock to return `ok: false`.
    const mockSession = makeMockSession('unauthed');
    currentSessionId = mockSession.sessionId;
    currentConn = { ok: false, authUrl: mockSession.authUrl! };

    // Act
    const req = new NextRequest('http://localhost:3000/api/briefing');
    const response = await GET(req);

    // Assert: 401 + JSON body (NOT NDJSON), no stream consumed.
    expect(response.status).toBe(401);
    expect(response.headers.get('content-type')).toContain('application/json');
    const body = (await response.json()) as { needsAuth?: boolean; authUrl?: string };
    expect(body.needsAuth).toBe(true);
    expect(body.authUrl).toBe(mockSession.authUrl);

    // No bootstrap calls fired — the gate was hit before bootstrapSchema.
    expect(currentMcp.callTool).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Test 4 — listTools fails
  // ---------------------------------------------------------------------------
  // listTools fires AFTER the bootstrap callTools and AFTER the coverage gate,
  // so the route emits workspace + coverage_item events BEFORE the failure
  // reaches the catch block. The catch then emits a single `error` event.
  it('emits an error event when listTools throws (partial events still flushed)', async () => {
    // Arrange: bootstrap succeeds; listTools throws.
    currentMcp = makeMockTransport('list-tools-fail', {
      errorMessage: 'listTools failed: HTTP 503 upstream',
    });
    currentConn = {
      ok: true,
      mcp: currentMcp as unknown as import('../../lib/mcp/client').McpClient,
    };

    // Act
    const req = new NextRequest('http://localhost:3000/api/briefing');
    const response = await GET(req);
    expect(response.status).toBe(200); // stream already opened before listTools

    const events = await collectEvents<AgentEvent | { type: string; message?: string }>(
      response,
    );
    const types = events.map((e) => (e as { type: string }).type);

    // Partial flush: bootstrap-phase events (workspace + coverage_items) fired
    // before listTools was called, so they're in the stream.
    expect(types).toContain('workspace');
    expect(types).toContain('coverage_item');

    // The catch block emitted exactly one `error` event with the route prefix.
    const errorEvents = events.filter((e) => (e as { type: string }).type === 'error');
    expect(errorEvents).toHaveLength(1);
    const errMsg = (errorEvents[0] as { message: string }).message;
    expect(errMsg).toMatch(/^\/api\/briefing · /);
    expect(errMsg).toContain('listTools failed');

    // `done` is NOT emitted on the error path — the route only sends `done` from
    // the try-block, then the finally closes the stream.
    expect(types).not.toContain('done');
  });

  // ---------------------------------------------------------------------------
  // Test 5 — monitoring scan fails (Anthropic SDK throws)
  // ---------------------------------------------------------------------------
  // The `runAgentLoop` catches MCP callTool errors locally and feeds them back
  // as `is_error: true` tool_result blocks — they do NOT propagate. So to
  // simulate "monitoring scan fails," the failure has to come from the SDK
  // surface: Anthropic.messages.create throws. That bubbles out of runAgentLoop
  // → MonitoringAgent.scan → into the route's catch block.
  it('emits an error event when Anthropic SDK throws during monitoring scan', async () => {
    setAnthropicResponses([
      anthropicErrorResponse('Anthropic API: 529 overloaded'),
    ]);

    const req = new NextRequest('http://localhost:3000/api/briefing');
    const response = await GET(req);
    expect(response.status).toBe(200);

    const events = await collectEvents<AgentEvent | { type: string; message?: string }>(
      response,
    );
    const types = events.map((e) => (e as { type: string }).type);

    // Bootstrap phases all flushed before the SDK call.
    expect(types).toContain('workspace');
    expect(types).toContain('coverage_item');

    const errorEvents = events.filter((e) => (e as { type: string }).type === 'error');
    expect(errorEvents).toHaveLength(1);
    const errMsg = (errorEvents[0] as { message: string }).message;
    expect(errMsg).toMatch(/^\/api\/briefing · /);
    expect(errMsg).toContain('529 overloaded');

    expect(types).not.toContain('done');
  });

  // ---------------------------------------------------------------------------
  // Test 6 — cancellation
  // ---------------------------------------------------------------------------
  // The route now plumbs `req.signal` through to every async operation inside
  // `start(controller)`. When the client aborts BEFORE the stream's try-block
  // runs, the very first `req.signal.throwIfAborted()` fires synchronously, the
  // catch block recognizes the AbortError and returns (no `error` event is
  // emitted — the consumer has cancelled), and the `finally` still records the
  // phase summary with `aborted: true`. Pre-aborting is the deterministic shape
  // (no race against the first chunk landing).
  it('cleans up reader on client cancel', async () => {
    // Arrange: pre-abort the signal so the route's first checkpoint fires
    // synchronously inside the try block. The Anthropic mock queue is empty
    // intentionally — if cancellation didn't short-circuit, the route would
    // reach `MonitoringAgent.scan` and the mock would throw
    // 'mock anthropic: scripted queue exhausted', which would surface as an
    // `error` event (a failure we'd see in the assertions below).
    const ac = new AbortController();
    ac.abort();
    const req = new NextRequest('http://localhost:3000/api/briefing', { signal: ac.signal });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      // Act
      const response = await GET(req);
      const events = await collectEvents<AgentEvent | { type: string }>(response);

      // Assert: no `done` (the try-block returned before reaching it) and
      // no `error` (the AbortError catch returned without emitting).
      const types = events.map((e) => (e as { type: string }).type);
      expect(types).not.toContain('done');
      expect(types).not.toContain('error');

      // Phase log still fired in the finally, with the new `aborted` field set.
      const summaryCalls = logSpy.mock.calls
        .map((c) => c[0])
        .filter((s): s is string => typeof s === 'string' && s.includes('"/api/briefing"'));
      expect(summaryCalls).toHaveLength(1);
      const parsed = JSON.parse(summaryCalls[0]) as { aborted?: boolean; phases: unknown[] };
      expect(parsed.aborted).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });

  // ---------------------------------------------------------------------------
  // Test 7 — phase-timing log
  // ---------------------------------------------------------------------------
  // The route's finally block emits ONE summary `console.log` per request,
  // shape: { route, sessionId, totalMs, phases: [{ phase, durationMs }, ...] }.
  // On the happy path, all four phases should appear: schema_bootstrap,
  // coverage_gate, list_tools, monitoring_scan.
  it('emits a phase-timing summary log with all 4 phases', async () => {
    // Arrange: happy-path scan (no anomalies).
    setAnthropicResponses([
      mockAnthropicResponse({
        text: '```json\n[]\n```',
        stop_reason: 'end_turn',
      }),
    ]);

    // Capture every console.log made during the route execution. We have to
    // spy and then filter for the summary line — the agent loop also logs a
    // per-turn usage line via `runAgentLoop`, and we don't want to assert on
    // that here (test/agents tests do).
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      const req = new NextRequest('http://localhost:3000/api/briefing');
      const response = await GET(req);
      await collectEvents(response);

      // The summary line is JSON.stringify'd with the `/api/briefing` route tag.
      const summaryCalls = logSpy.mock.calls
        .map((c) => c[0])
        .filter((s): s is string => typeof s === 'string' && s.includes('"/api/briefing"'));

      expect(summaryCalls).toHaveLength(1);

      const parsed = JSON.parse(summaryCalls[0]) as {
        route: string;
        sessionId: string;
        totalMs: number;
        phases: Array<{ phase: string; durationMs: number }>;
      };

      expect(parsed.route).toBe('/api/briefing');
      expect(parsed.sessionId).toBe('test-session-001');
      expect(typeof parsed.totalMs).toBe('number');
      expect(parsed.totalMs).toBeGreaterThanOrEqual(0);

      const phaseNames = parsed.phases.map((p) => p.phase);
      expect(phaseNames).toContain('schema_bootstrap');
      expect(phaseNames).toContain('coverage_gate');
      expect(phaseNames).toContain('list_tools');
      expect(phaseNames).toContain('monitoring_scan');

      // Each phase carries a numeric durationMs.
      for (const p of parsed.phases) {
        expect(typeof p.durationMs).toBe('number');
        expect(p.durationMs).toBeGreaterThanOrEqual(0);
      }
    } finally {
      logSpy.mockRestore();
    }
  });
});
