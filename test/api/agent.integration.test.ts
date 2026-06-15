// test/api/agent.integration.test.ts
//
// Integration tests for GET /api/agent — the diagnose / recommend / query
// pipeline. Phase 3 (final phase) of the integration-tests scaffold.
//
// Reality-pinning notes — these were the plan-vs-real-route deltas Phase 3
// uncovered:
//
//   1. The query-flow param is `?q=...` (NOT `?query=...`).
//   2. The 404 body reads `{ error: 'insight not found' }` (NOT
//      `'anomaly not found'`).
//   3. The route never inspects a `revoked` flag on the session — `unauthed`
//      surfaces as `conn.ok === false`.
//   4. The cached-investigation cache (`lib/state/investigations.ts`) is
//      ALSO checked before the auth gate. Tests that use an insightId which
//      already lives in `demo-investigations.json` would replay the cached
//      stream and never touch Anthropic / MCP. We sidestep this by clearing
//      `_clearInvestigationCache()` in beforeEach AND using test-only ids.
//   5. `RecommendationAgent.propose` returns `[]` when parse fails — the
//      diagnostic FALLBACK (`{ conclusion: 'Insufficient data…' }`) only
//      applies to the diagnose flow. Test 5 verifies both shapes.
//
// Mocks follow the briefing test's pattern: module-scope `vi.mock` so the
// Anthropic SDK + session + connect surfaces are intercepted before the route
// module loads; tests swap `currentMcp` / `currentConn` / `currentSessionId`
// in their arrange step.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { AgentEvent } from '../../lib/mcp/events';
import type { Diagnosis, Recommendation } from '../../lib/mcp/types';
import {
  collectEvents,
  makeAnomaly,
  makeMockSession,
  makeMockTransport,
  mockAnthropicModule,
  mockAnthropicResponse,
  resetAnthropicQueue,
  seedInsight,
  setAnthropicResponses,
  getAnthropicCalls,
  type MockMcp,
} from './_helpers';

// 1) Stub the Anthropic SDK at module load.
vi.mock('@anthropic-ai/sdk', () => mockAnthropicModule());

// 2) Stub session + connect surfaces; tests swap the state vars below.
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
import { GET } from '../../app/api/agent/route';
import { _resetSchemaCache } from '../../lib/mcp/schema';
import { _clear as clearInsights } from '../../lib/state/insights';
import { _clearInvestigationCache } from '../../lib/state/investigations';

// A parseable diagnosis fenced as JSON — the agent loop's `tryParseDiagnosis`
// hits `parseAgentJson` which strips the ```json fence before `JSON.parse`.
const VALID_DIAGNOSIS: Diagnosis = {
  conclusion: 'Mobile checkout revenue dropped 18% because the catalog feed sync stalled at 06:00 UTC.',
  evidence: ['purchase_revenue dropped from 12k to 9.8k', 'no catalog_sync events after 06:00'],
  hypothesesConsidered: [
    { hypothesis: 'Promotion expired early', supported: false, reasoning: 'no promo events ended' },
    { hypothesis: 'Catalog sync stalled', supported: true, reasoning: 'sync events stopped at 06:00' },
  ],
};

const VALID_RECOMMENDATIONS_IDLESS: Omit<Recommendation, 'id'>[] = [
  {
    title: 'Restart the catalog sync scenario',
    rationale: 'sync stopped at 06:00; restarting publishes the latest inventory',
    bloomreachFeature: 'scenario',
    steps: ['Open the catalog sync scenario', 'Trigger a manual run'],
    estimatedImpact: { range: '+5–8% mobile revenue', assumption: 'feed restored within 30m' },
    confidence: 'high',
  },
  {
    title: 'Notify affected customers with a recovery campaign',
    rationale: 'customers who saw stale inventory may have abandoned cart',
    bloomreachFeature: 'campaign',
    steps: ['Segment cart abandoners since 06:00', 'Send a 10% recovery voucher'],
    estimatedImpact: { range: '+1–2% recovered revenue', assumption: '10% open rate' },
    confidence: 'medium',
  },
];

beforeEach(() => {
  // bootstrapSchema memoizes; without a reset, the 2nd test would skip the
  // bootstrap callTool path entirely and our mock-call assertions drift.
  _resetSchemaCache();
  resetAnthropicQueue();
  clearInsights();
  // Saved investigations would otherwise survive across tests AND replay
  // cached streams instead of hitting Anthropic.
  _clearInvestigationCache();
  // Reset state vars to the happy path; tests reassign as needed.
  currentMcp = makeMockTransport('ok');
  currentConn = {
    ok: true,
    mcp: currentMcp as unknown as import('../../lib/mcp/client').McpClient,
  };
  currentSessionId = 'test-session-001';
  process.env.ANTHROPIC_API_KEY = 'test-key';
});

describe('GET /api/agent — diagnose / recommend / query (Phase 3)', () => {
  // ---------------------------------------------------------------------------
  // Test 1 — diagnose step happy path
  // ---------------------------------------------------------------------------
  it('runs diagnose step → emits investigation events → terminal Diagnosis', async () => {
    // Arrange: pre-seed the session feed so getAnomaly resolves.
    const insight = seedInsight(currentSessionId, makeAnomaly());
    // One Anthropic turn returns parseable diagnosis JSON in a fence; the loop
    // sees no tool_use blocks and exits, parses, and returns the Diagnosis.
    setAnthropicResponses([
      mockAnthropicResponse({
        text: '```json\n' + JSON.stringify(VALID_DIAGNOSIS) + '\n```',
        stop_reason: 'end_turn',
      }),
    ]);

    // Act
    const req = new NextRequest(
      `http://localhost:3000/api/agent?step=diagnose&insightId=${insight.id}`,
    );
    const response = await GET(req);

    // Assert
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/x-ndjson');

    const events = await collectEvents<AgentEvent>(response);
    const types = events.map((e) => e.type);

    // Investigation kicks off with a reasoning_step, then the agent emits its
    // own thought (from the fence text), then the diagnosis, then done.
    expect(types).toContain('reasoning_step');
    expect(types).toContain('diagnosis');
    expect(types).not.toContain('recommendation'); // step=diagnose only
    expect(types[types.length - 1]).toBe('done');

    // The terminal diagnosis event carries the parsed shape (with confidence
    // derived by `diagnosisConfidence`; we only assert the fields we control).
    const diagEvent = events.find((e) => e.type === 'diagnosis') as
      | { type: 'diagnosis'; diagnosis: Diagnosis }
      | undefined;
    expect(diagEvent?.diagnosis.conclusion).toBe(VALID_DIAGNOSIS.conclusion);
    expect(diagEvent?.diagnosis.evidence).toEqual(VALID_DIAGNOSIS.evidence);
  });

  // ---------------------------------------------------------------------------
  // Test 2 — recommend step happy path
  // ---------------------------------------------------------------------------
  // The recommend step requires the diagnosis to be handed over via
  // `?diagnosis=<JSON>` (see route.ts line 243); without it the route throws.
  it('runs recommend step → emits recommendation events → terminal done', async () => {
    const insight = seedInsight(currentSessionId, makeAnomaly());
    setAnthropicResponses([
      mockAnthropicResponse({
        text: '```json\n' + JSON.stringify(VALID_RECOMMENDATIONS_IDLESS) + '\n```',
        stop_reason: 'end_turn',
      }),
    ]);

    const diagnosisQs = encodeURIComponent(JSON.stringify(VALID_DIAGNOSIS));
    const req = new NextRequest(
      `http://localhost:3000/api/agent?step=recommend&insightId=${insight.id}&diagnosis=${diagnosisQs}`,
    );
    const response = await GET(req);

    expect(response.status).toBe(200);
    const events = await collectEvents<AgentEvent>(response);
    const types = events.map((e) => e.type);

    // recommend step: no diagnosis event (it was handed over), only the
    // recommendation phase fires.
    expect(types).not.toContain('diagnosis');
    expect(types).toContain('reasoning_step');
    const recEvents = events.filter((e) => e.type === 'recommendation') as Array<{
      type: 'recommendation';
      recommendation: Recommendation;
    }>;
    expect(recEvents).toHaveLength(2);
    expect(recEvents[0].recommendation.title).toBe(VALID_RECOMMENDATIONS_IDLESS[0].title);
    expect(recEvents[0].recommendation.id).toBeDefined(); // id assigned post-validation
    expect(types[types.length - 1]).toBe('done');
  });

  // ---------------------------------------------------------------------------
  // Test 3 — query step happy path
  // ---------------------------------------------------------------------------
  // The query flow takes `?q=<text>` (NOT `?query=`) and runs TWO Anthropic
  // calls: classifyIntent (one shot) + the query agent loop (one shot here
  // because we script an immediate end_turn).
  it('classifies intent + runs query agent → terminal prose answer', async () => {
    setAnthropicResponses([
      // 1) classifyIntent — returns one-word intent.
      mockAnthropicResponse({ text: 'diagnostic', stop_reason: 'end_turn' }),
      // 2) QueryAgent loop — returns the prose answer immediately.
      mockAnthropicResponse({
        text: 'Mobile revenue dropped because the catalog feed sync stalled at 06:00 UTC.',
        stop_reason: 'end_turn',
      }),
    ]);

    const req = new NextRequest(
      'http://localhost:3000/api/agent?q=' + encodeURIComponent('why did mobile revenue drop?'),
    );
    const response = await GET(req);

    expect(response.status).toBe(200);
    const events = await collectEvents<AgentEvent>(response);
    const types = events.map((e) => e.type);

    // Query flow emits NO diagnosis / recommendation events — only reasoning
    // steps and the terminal done. The final reasoning_step (kind: conclusion)
    // carries the prose answer.
    expect(types).not.toContain('diagnosis');
    expect(types).not.toContain('recommendation');
    expect(types[types.length - 1]).toBe('done');

    const conclusionStep = events
      .filter((e) => e.type === 'reasoning_step')
      .map((e) => (e as Extract<AgentEvent, { type: 'reasoning_step' }>).step)
      .find((s) => s.kind === 'conclusion');
    expect(conclusionStep?.content).toContain('catalog feed sync stalled');

    // Two Anthropic calls: classifyIntent + QueryAgent loop.
    expect(getAnthropicCalls()).toHaveLength(2);
  });

  // ---------------------------------------------------------------------------
  // Test 4 — recovery fires when the first turn's JSON is unparseable
  // ---------------------------------------------------------------------------
  // `runAgentLoop` calls `parseResult` on the natural finalText; when it
  // returns null AND `recoveryPrompt` is set, it fires `runRecoveryTurn`
  // (one tool-less SDK call). The second call's text re-runs through
  // `parseResult`; on success the diagnosis lands.
  it('runRecoveryTurn fires when first Anthropic turn returns unparseable JSON', async () => {
    const insight = seedInsight(currentSessionId, makeAnomaly());
    setAnthropicResponses([
      // Turn 1: text without a JSON fence → tryParseDiagnosis returns null.
      mockAnthropicResponse({
        text: 'I am still thinking about which queries to run.',
        stop_reason: 'end_turn',
      }),
      // Turn 2 (recovery): parseable diagnosis.
      mockAnthropicResponse({
        text: '```json\n' + JSON.stringify(VALID_DIAGNOSIS) + '\n```',
        stop_reason: 'end_turn',
      }),
    ]);

    const req = new NextRequest(
      `http://localhost:3000/api/agent?step=diagnose&insightId=${insight.id}`,
    );
    const response = await GET(req);
    expect(response.status).toBe(200);

    const events = await collectEvents<AgentEvent>(response);
    const diagEvent = events.find((e) => e.type === 'diagnosis') as
      | { type: 'diagnosis'; diagnosis: Diagnosis }
      | undefined;

    // Recovery succeeded — the parsed diagnosis (not FALLBACK) lands.
    expect(diagEvent?.diagnosis.conclusion).toBe(VALID_DIAGNOSIS.conclusion);
    expect(events.map((e) => e.type)).toContain('done');

    // Exactly TWO Anthropic calls happened: loop + recovery.
    expect(getAnthropicCalls()).toHaveLength(2);
    // The recovery turn is tool-less (params.tools omitted).
    const calls = getAnthropicCalls();
    expect(calls[0].tools).toBeDefined();
    expect(calls[1].tools).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // Test 5 — recovery exhausted → FALLBACK diagnosis + empty recommendations
  // ---------------------------------------------------------------------------
  // When BOTH parse attempts fail, DiagnosticAgent returns its FALLBACK shape:
  // `{ conclusion: 'Insufficient data…', evidence: [], hypothesesConsidered: [] }`
  // (with a confidence derived by `diagnosisConfidence`). The route still
  // emits the `diagnosis` event + `done`.
  it('returns FALLBACK diagnosis when both parse attempts fail', async () => {
    const insight = seedInsight(currentSessionId, makeAnomaly());
    setAnthropicResponses([
      mockAnthropicResponse({ text: 'thinking...', stop_reason: 'end_turn' }),
      // Recovery turn — still no parseable JSON.
      mockAnthropicResponse({ text: 'still thinking...', stop_reason: 'end_turn' }),
    ]);

    const req = new NextRequest(
      `http://localhost:3000/api/agent?step=diagnose&insightId=${insight.id}`,
    );
    const response = await GET(req);
    expect(response.status).toBe(200);

    const events = await collectEvents<AgentEvent>(response);
    const diagEvent = events.find((e) => e.type === 'diagnosis') as
      | { type: 'diagnosis'; diagnosis: Diagnosis }
      | undefined;

    // FALLBACK shape pinned to lib/agents/diagnostic.ts line 16-20.
    expect(diagEvent?.diagnosis.conclusion).toBe(
      'Insufficient data to determine a cause for this change.',
    );
    expect(diagEvent?.diagnosis.evidence).toEqual([]);
    expect(diagEvent?.diagnosis.hypothesesConsidered).toEqual([]);
    expect(events.map((e) => e.type)).toContain('done');
  });

  // ---------------------------------------------------------------------------
  // Test 6 — 401 unauthed
  // ---------------------------------------------------------------------------
  // Same shape as the briefing 401 test: connect mock returns ok:false.
  // Note: the agent route checks the cached-investigation hit BEFORE the
  // auth gate, but only if `insightId` is set AND `live !== '1'`. To pin the
  // auth gate cleanly we use an insightId that's not cached.
  it('returns 401 with authUrl when connectMcp reports unauthed', async () => {
    const mockSession = makeMockSession('unauthed');
    currentSessionId = mockSession.sessionId;
    currentConn = { ok: false, authUrl: mockSession.authUrl! };
    // Seed an insight so getAnomaly resolves (the auth gate fires AFTER
    // resolveAnomaly per route.ts line 143-148).
    const insight = seedInsight(currentSessionId, makeAnomaly());

    const req = new NextRequest(
      `http://localhost:3000/api/agent?step=diagnose&insightId=${insight.id}`,
    );
    const response = await GET(req);

    expect(response.status).toBe(401);
    expect(response.headers.get('content-type')).toContain('application/json');
    const body = (await response.json()) as { needsAuth?: boolean; authUrl?: string };
    expect(body.needsAuth).toBe(true);
    expect(body.authUrl).toBe(mockSession.authUrl);

    // No MCP calls fired — auth gate hit before bootstrapSchema.
    expect(currentMcp.callTool).not.toHaveBeenCalled();
    expect(currentMcp.listTools).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Test 7 — anomaly not found (404)
  // ---------------------------------------------------------------------------
  // No seed → resolveAnomaly returns null → route returns 404. Reality pin:
  // the error body reads `{ error: 'insight not found' }` (NOT
  // 'anomaly not found' as the plan text guessed).
  it('returns 404 when ?insightId points at an unknown anomaly', async () => {
    // No seed for this id and `_clearInvestigationCache()` ran in beforeEach,
    // so the cache is empty.
    const req = new NextRequest(
      'http://localhost:3000/api/agent?step=diagnose&insightId=does-not-exist-xyz',
    );
    const response = await GET(req);

    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('application/json');
    const body = (await response.json()) as { error?: string };
    expect(body.error).toBe('insight not found');

    // No connection / MCP work happened — the 404 fires before connectMcp.
    expect(currentMcp.callTool).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Test 8 — sessionId threaded into every Anthropic usage log line
  // ---------------------------------------------------------------------------
  // `runAgentLoop` logs `{ site, sessionId, usage }` per turn (base.ts:121).
  // Every site that fires during the diagnose flow MUST carry the test session
  // id. We assert at least one site fired with sessionId === 'test-session-001'
  // and no usage log line was missing the field.
  it('threads sessionId into every Anthropic usage log line', async () => {
    const insight = seedInsight(currentSessionId, makeAnomaly());
    setAnthropicResponses([
      mockAnthropicResponse({
        text: '```json\n' + JSON.stringify(VALID_DIAGNOSIS) + '\n```',
        stop_reason: 'end_turn',
      }),
    ]);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      const req = new NextRequest(
        `http://localhost:3000/api/agent?step=diagnose&insightId=${insight.id}`,
      );
      const response = await GET(req);
      await collectEvents(response);

      // Usage log lines are JSON-encoded strings containing `"usage"`. The
      // route's summary line ALSO contains "usage"... no, actually it doesn't.
      // The summary contains "phases" and "totalMs". Filter by `"site":` to
      // pick the per-turn usage lines from runAgentLoop / runRecoveryTurn /
      // classifyIntent.
      const usageLines = logSpy.mock.calls
        .map((c) => c[0])
        .filter((s): s is string => typeof s === 'string' && s.includes('"site":'));

      expect(usageLines.length).toBeGreaterThan(0);
      for (const line of usageLines) {
        const parsed = JSON.parse(line) as { sessionId?: string };
        expect(parsed.sessionId).toBe('test-session-001');
      }
    } finally {
      logSpy.mockRestore();
    }
  });

  // ---------------------------------------------------------------------------
  // Test 9 — phase log shape
  // ---------------------------------------------------------------------------
  // The route emits ONE summary `console.log` per request from the finally
  // block (route.ts line 287-292), shape:
  //   { route: '/api/agent', sessionId, totalMs, phases: [{phase, durationMs}] }
  //
  // The diagnose flow's phases (per recordPhase calls): schema_bootstrap,
  // list_tools, diagnostic_investigate. Query-flow-only phases
  // (intent_classify, query_answer) must NOT appear.
  it('emits phase summary log with diagnose-flow phases only', async () => {
    const insight = seedInsight(currentSessionId, makeAnomaly());
    setAnthropicResponses([
      mockAnthropicResponse({
        text: '```json\n' + JSON.stringify(VALID_DIAGNOSIS) + '\n```',
        stop_reason: 'end_turn',
      }),
    ]);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      const req = new NextRequest(
        `http://localhost:3000/api/agent?step=diagnose&insightId=${insight.id}`,
      );
      const response = await GET(req);
      await collectEvents(response);

      const summaryCalls = logSpy.mock.calls
        .map((c) => c[0])
        .filter((s): s is string => typeof s === 'string' && s.includes('"/api/agent"'));

      expect(summaryCalls).toHaveLength(1);

      const parsed = JSON.parse(summaryCalls[0]) as {
        route: string;
        sessionId: string;
        totalMs: number;
        phases: Array<{ phase: string; durationMs: number }>;
      };

      expect(parsed.route).toBe('/api/agent');
      expect(parsed.sessionId).toBe('test-session-001');
      expect(typeof parsed.totalMs).toBe('number');
      expect(parsed.totalMs).toBeGreaterThanOrEqual(0);

      const phaseNames = parsed.phases.map((p) => p.phase);
      expect(phaseNames).toContain('schema_bootstrap');
      expect(phaseNames).toContain('list_tools');
      expect(phaseNames).toContain('diagnostic_investigate');
      // The diagnose step does NOT run recommendation, query, or intent.
      expect(phaseNames).not.toContain('recommendation_propose');
      expect(phaseNames).not.toContain('intent_classify');
      expect(phaseNames).not.toContain('query_answer');

      for (const p of parsed.phases) {
        expect(typeof p.durationMs).toBe('number');
        expect(p.durationMs).toBeGreaterThanOrEqual(0);
      }
    } finally {
      logSpy.mockRestore();
    }
  });
});
