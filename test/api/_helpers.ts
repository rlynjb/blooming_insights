// test/api/_helpers.ts
//
// Shared scaffolding for /api/briefing + /api/agent integration tests.
//
// Four mocking surfaces (per integration-tests plan §Architecture):
//   1. Anthropic SDK  — scripted response queue (module-level `vi.mock`)
//   2. MCP transport  — fake `McpClient` returning scripted tool/listTools data
//   3. Session/auth   — stub `getOrCreateSessionId` + `connectMcp`
//   4. NDJSON consumer — `collectEvents` reuses the production `readNdjson` kernel
//
// Phase 1 implements only the 'ok' / 'authed' branches needed by the smoke
// test; the other scenarios are stubbed with explicit throws so Phase 2/3 tests
// fail loudly until they're filled in.
import { vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { readNdjson } from '../../lib/streaming/ndjson';
import { AGENT_MODEL } from '../../lib/agents/base';
import { McpToolError } from '../../lib/mcp/client';
import { putInsights, anomalyToInsight } from '../../lib/state/insights';
import type { Anomaly, Insight } from '../../lib/mcp/types';

// ---------------------------------------------------------------------------
// 1. Anthropic SDK mock
// ---------------------------------------------------------------------------
//
// The briefing/agent routes do `new Anthropic({ apiKey })` inside the handler,
// so we have to intercept at module-load time. Test files register the mock at
// module scope (so it applies before the route module is imported) and then
// call `setAnthropicResponses(...)` per-test to fill the response queue.
//
// Pattern used by tests:
//   vi.mock('@anthropic-ai/sdk', () => mockAnthropicModule());
//   ... in beforeEach: setAnthropicResponses([resp1, resp2, ...])
//
// The queue is shared module state (vitest re-resolves the mock factory once),
// so `resetAnthropicQueue()` MUST run between tests to keep them independent.

type ScriptedResponse =
  | Anthropic.Messages.Message
  | (() => Anthropic.Messages.Message);

const anthropicQueue: ScriptedResponse[] = [];
const anthropicCalls: Anthropic.Messages.MessageCreateParamsNonStreaming[] = [];

export function setAnthropicResponses(responses: ScriptedResponse[]): void {
  anthropicQueue.length = 0;
  anthropicQueue.push(...responses);
}

export function resetAnthropicQueue(): void {
  anthropicQueue.length = 0;
  anthropicCalls.length = 0;
}

export function getAnthropicCalls(): readonly Anthropic.Messages.MessageCreateParamsNonStreaming[] {
  return anthropicCalls;
}

/** Returns a module factory suitable for `vi.mock('@anthropic-ai/sdk', ...)`.
 *  The default export is a real `class` (the route does `new Anthropic(...)`)
 *  whose `messages.create` drains the scripted queue (next-style). Throws when
 *  the queue is exhausted so tests fail loudly instead of returning undefined.
 *  Using a class — not `vi.fn().mockImplementation(...)` — because vitest's
 *  spy wrapper isn't `new`-able without the underlying function being declared
 *  as `function` or `class`. */
export function mockAnthropicModule(): { default: unknown } {
  class MockAnthropic {
    messages = {
      create: async (params: Anthropic.Messages.MessageCreateParamsNonStreaming) => {
        anthropicCalls.push(params);
        const next = anthropicQueue.shift();
        if (!next) throw new Error('mock anthropic: scripted queue exhausted');
        // Function entries may throw — this is the hook tests use to simulate
        // an SDK failure mid-stream (monitoring scan fails). Errors thrown from
        // the factory propagate up through `runAgentLoop` into the route's
        // catch block, which is the path we want to exercise.
        return typeof next === 'function' ? next() : next;
      },
    };
  }
  return { default: MockAnthropic };
}

/** Helper: queue entry that throws when consumed. Used to script a mid-stream
 *  Anthropic SDK failure so the agent loop bubbles the error to the route's
 *  catch block, which then emits an `error` event into the NDJSON stream. */
export function anthropicErrorResponse(message: string): () => Anthropic.Messages.Message {
  return () => {
    throw new Error(message);
  };
}

/** Build a canonical `Anthropic.Messages.Message` shape from minimal options. */
export function mockAnthropicResponse(opts: {
  text?: string;
  toolUses?: Array<{ id?: string; name: string; input: Record<string, unknown> }>;
  stop_reason?: Anthropic.Messages.Message['stop_reason'];
  usage?: { input_tokens: number; output_tokens: number };
}): Anthropic.Messages.Message {
  const content: Anthropic.Messages.ContentBlock[] = [];
  if (opts.text) {
    content.push({ type: 'text', text: opts.text, citations: null } as unknown as Anthropic.Messages.ContentBlock);
  }
  for (const tu of opts.toolUses ?? []) {
    content.push({
      type: 'tool_use',
      id: tu.id ?? `tu_${Math.random().toString(36).slice(2, 8)}`,
      name: tu.name,
      input: tu.input,
      caller: { type: 'direct' },
    } as unknown as Anthropic.Messages.ContentBlock);
  }
  return {
    id: `msg_${Math.random().toString(36).slice(2, 10)}`,
    type: 'message',
    role: 'assistant',
    model: AGENT_MODEL,
    container: null,
    stop_details: null,
    stop_sequence: null,
    usage: {
      input_tokens: opts.usage?.input_tokens ?? 10,
      output_tokens: opts.usage?.output_tokens ?? 10,
      cache_creation: null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      inference_geo: null,
      server_tool_use: null,
      service_tier: null,
    },
    content,
    stop_reason: opts.stop_reason ?? (opts.toolUses?.length ? 'tool_use' : 'end_turn'),
  } as unknown as Anthropic.Messages.Message;
}

// ---------------------------------------------------------------------------
// 2. MCP transport mock
// ---------------------------------------------------------------------------
//
// The route never touches `lib/mcp/transport` directly — it goes through
// `connectMcp()` and then operates on the returned `McpClient`. So the cheapest
// place to intercept is `connectMcp`, and `makeMockMcp` builds the McpClient
// surface (callTool + listTools) the route consumes downstream.
//
// `callTool` returns the McpClient envelope `{ result, durationMs, fromCache }`
// (NOT the raw transport shape) — this is what `bootstrapSchema` and
// `runAgentLoop` expect after the McpClient wraps the raw response.

export type MockMcpScenario = 'ok' | 'list-tools-fail' | 'tool-call-fail' | 'timeout';

export interface MockMcpOptions {
  /** For `'tool-call-fail'`: which tool name should `callTool` throw on. All
   *  other tools fall through to the happy-path bootstrap responses. */
  tool?: string;
  /** Error message attached to the synthesized `McpToolError`. */
  errorMessage?: string;
}

export interface MockMcp {
  callTool: ReturnType<typeof vi.fn>;
  listTools: ReturnType<typeof vi.fn>;
}

/** The minimal happy-path `callTool` responses needed by `bootstrapSchema`. The
 *  shape matches the real Bloomreach MCP envelope: `{ structuredContent: {...} }`
 *  is what `unwrap` prefers. */
function makeBootstrapCallTool() {
  return vi.fn(async (name: string, _args: Record<string, unknown>, _opts?: unknown) => {
    let structuredContent: unknown;
    switch (name) {
      case 'list_cloud_organizations':
        structuredContent = { data: [{ id: 'org-test', name: 'Test Org' }] };
        break;
      case 'list_projects':
        structuredContent = { data: [{ id: 'proj-test', name: 'Test Project' }] };
        break;
      case 'get_event_schema':
        // Provide events that satisfy a couple of categories so the runnable
        // set isn't empty but stays tight (smoke test doesn't need anomalies).
        structuredContent = {
          events: [
            {
              type: 'purchase',
              properties: { default_group: { properties: [{ property: 'total_price' }, { property: 'product_id' }] } },
            },
            {
              type: 'session_start',
              properties: { default_group: { properties: [{ property: 'device_type' }] } },
            },
          ],
        };
        break;
      case 'get_customer_property_schema':
        structuredContent = { properties: [{ property: 'email' }] };
        break;
      case 'list_catalogs':
        structuredContent = { data: [] };
        break;
      case 'get_project_overview':
        structuredContent = {
          data: {
            events: 1000,
            total_customers: 100,
            oldest_timestamp: new Date('2024-01-01').getTime(),
            event_types_overview: { purchase: { event_count: 500 }, session_start: { event_count: 500 } },
          },
        };
        break;
      default:
        // Unknown tools (executed by the monitoring agent during scan) get an
        // empty success envelope. The smoke test scripts the model to return
        // [] immediately so this branch is only hit if the model decides to
        // call a tool — in which case we'd rather not blow up.
        structuredContent = { data: [], rows: [] };
    }
    return { result: { structuredContent }, durationMs: 1, fromCache: false };
  });
}

function makeMonitoringToolList() {
  // listTools returns the raw transport shape: `{ tools: [...] }`.
  // We hand back a minimal McpToolDef set that overlaps the monitoring,
  // diagnostic, recommendation, AND query allowlists in `lib/mcp/tools.ts`,
  // so `filterToolSchemas(allTools, <any-allowlist>)` produces a non-empty
  // array regardless of which agent is firing. The mocked Anthropic SDK
  // doesn't validate `tools`, but the agent routes call `filterToolSchemas`
  // before the SDK call and we want the resulting schemas to be realistic.
  const obj = {
    type: 'object',
    properties: { project_id: { type: 'string' } },
    required: ['project_id'],
  } as const;
  return {
    tools: [
      // Monitoring + diagnostic + query — analytics execution tools.
      {
        name: 'execute_analytics_eql',
        description: 'Run an EQL analytics query.',
        inputSchema: {
          type: 'object',
          properties: { project_id: { type: 'string' }, eql: { type: 'string' } },
          required: ['project_id', 'eql'],
        },
      },
      {
        name: 'execute_analytics',
        description: 'Run an analytics query.',
        inputSchema: {
          type: 'object',
          properties: { project_id: { type: 'string' }, analysis: { type: 'object' } },
          required: ['project_id'],
        },
      },
      // Diagnostic + query — segmentation / customer lookups.
      { name: 'list_segmentations', description: 'List segmentations.', inputSchema: obj },
      { name: 'list_email_campaigns', description: 'List email campaigns.', inputSchema: obj },
      // Recommendation + query — scenarios / vouchers.
      { name: 'list_scenarios', description: 'List scenarios.', inputSchema: obj },
      { name: 'list_voucher_pools', description: 'List voucher pools.', inputSchema: obj },
    ],
  };
}

/** Build the fake `McpClient` the route receives from `connectMcp`. Each
 *  scenario pins a specific failure mode the route needs to handle:
 *    - `'ok'`             happy path — bootstrap tools + listTools succeed
 *    - `'list-tools-fail'` listTools throws an `McpToolError`; bootstrap callTool
 *                          still works (those calls fire BEFORE listTools, so
 *                          the route emits workspace + coverage events first,
 *                          then the catch block emits an `error` event)
 *    - `'tool-call-fail'`  a SPECIFIC callTool invocation throws (opts.tool);
 *                          all other tools fall through to the happy path. For
 *                          bootstrap-phase failures (e.g. tool='get_event_schema')
 *                          the route's catch fires after workspace; for
 *                          monitoring-phase failures the agent loop catches the
 *                          error and feeds it back as a tool_result block.
 *    - `'timeout'`         callTool returns a never-resolving promise. Tests
 *                          using this scenario MUST run with `vi.useFakeTimers()`
 *                          (or attach an AbortSignal with a short deadline) —
 *                          the route's real per-call timeout is 30s, far past
 *                          vitest's default 5s, so blocking real-time would
 *                          deadlock the suite. */
export function makeMockTransport(
  scenario: MockMcpScenario,
  opts: MockMcpOptions = {},
): MockMcp {
  if (scenario === 'ok') {
    return {
      callTool: makeBootstrapCallTool(),
      listTools: vi.fn(async () => makeMonitoringToolList()),
    };
  }
  if (scenario === 'list-tools-fail') {
    return {
      callTool: makeBootstrapCallTool(),
      listTools: vi.fn(async () => {
        // Match the shape McpClient.liveCall would wrap a transport failure in:
        // the route ultimately catches an Error whose message includes the tool
        // name and detail. listTools doesn't go through liveCall, so we throw
        // a plain Error here — that's what the route's catch sees.
        throw new Error(opts.errorMessage ?? 'listTools failed: HTTP 503 upstream');
      }),
    };
  }
  if (scenario === 'tool-call-fail') {
    if (!opts.tool) {
      throw new Error("makeMockTransport('tool-call-fail') requires opts.tool");
    }
    const targetTool = opts.tool;
    const happyPath = makeBootstrapCallTool();
    return {
      callTool: vi.fn(async (name: string, args: Record<string, unknown>, callOpts?: unknown) => {
        if (name === targetTool) {
          throw new McpToolError(
            name,
            opts.errorMessage ?? 'tool execution failed',
          );
        }
        return happyPath(name, args, callOpts);
      }),
      listTools: vi.fn(async () => makeMonitoringToolList()),
    };
  }
  if (scenario === 'timeout') {
    // callTool returns a promise that never resolves. Tests MUST drive the
    // clock with fake timers or wrap the call with a short abort, otherwise
    // vitest will hit its test-timeout.
    return {
      callTool: vi.fn(() => new Promise<never>(() => {})),
      listTools: vi.fn(async () => makeMonitoringToolList()),
    };
  }
  throw new Error(`makeMockTransport: unknown scenario '${scenario as string}'`);
}

// ---------------------------------------------------------------------------
// 3. Session/auth stub
// ---------------------------------------------------------------------------

export type MockSessionMode = 'authed' | 'unauthed' | 'expired';

export interface MockSession {
  sessionId: string;
  /** Shape used by tests that need to stub `connectMcp` directly. */
  authed: boolean;
  authUrl?: string;
}

export function makeMockSession(mode: MockSessionMode): MockSession {
  if (mode === 'authed') {
    return { sessionId: 'test-session-001', authed: true };
  }
  if (mode === 'unauthed') {
    // The briefing route reads `connectMcp(sid)` and branches on `conn.ok`.
    // Tests use this descriptor to drive the `connectMcp` mock to return
    // `{ ok: false, authUrl: <session.authUrl> }`. `sessionId` is still
    // valid (the cookie/jar surface returns one) — the failure is in the OAuth
    // tokens, not the session id itself.
    return {
      sessionId: 'test-session-unauthed-002',
      authed: false,
      authUrl: 'http://localhost:3000/api/mcp/start?session=test-session-unauthed-002',
    };
  }
  if (mode === 'expired') {
    // Not exercised by the /api/briefing tests in Phase 2 — the briefing route's
    // catch only branches on `conn.ok`, it does not look for a `revoked` flag.
    // The reconnect-on-revoked path lives in the client-side `useReconnectPolicy`
    // hook (Phase 3 territory). Provided as a placeholder so the agent route
    // tests can use it without re-editing this file.
    return {
      sessionId: 'test-session-expired-003',
      authed: false,
      authUrl: 'http://localhost:3000/api/mcp/start?session=test-session-expired-003',
    };
  }
  throw new Error(`makeMockSession: unknown mode '${mode as string}'`);
}

// ---------------------------------------------------------------------------
// 4. NDJSON consumer
// ---------------------------------------------------------------------------

/** Drain a Response whose body is an NDJSON stream and return the parsed
 *  events as a typed array. Reuses the production `readNdjson` kernel so the
 *  parse contract is exactly the one the live UI hooks rely on. */
export async function collectEvents<E>(response: Response): Promise<E[]> {
  const events: E[] = [];
  if (!response.body) return events;
  await readNdjson<E>(response.body, (e) => events.push(e));
  return events;
}

// ---------------------------------------------------------------------------
// 5. Insight feed seeding (agent route only)
// ---------------------------------------------------------------------------
//
// `/api/agent?step=diagnose&insightId=X` resolves the anomaly via
// `getAnomaly(sessionId, X)` against the session-keyed Map in
// `lib/state/insights.ts`. Agent tests need to PRE-SEED that map so the route
// finds the anomaly instead of falling to 404. We wrap `putInsights` rather
// than touching the Map directly so the contract matches what the briefing
// route would write at end-of-scan.
//
// Returns the synthesized insight (with its assigned id) so tests can use it
// directly as the `?insightId=` value.

/** A minimal Anomaly with sensible defaults. Tests can override any field. */
export function makeAnomaly(overrides: Partial<Anomaly> = {}): Anomaly {
  return {
    metric: 'purchase_revenue',
    scope: ['mobile', 'checkout'],
    change: { value: 18, direction: 'down', baseline: 'prior 4 weeks' },
    severity: 'warning',
    evidence: [],
    ...overrides,
  };
}

/** Seed one anomaly into the session-scoped insights map and return the
 *  resulting Insight (with its assigned id). Tests pass `insight.id` as the
 *  route's `?insightId=` query param so `getAnomaly(sid, id)` resolves it. */
export function seedInsight(sessionId: string, anomaly: Anomaly = makeAnomaly()): Insight {
  const insight = anomalyToInsight(anomaly);
  putInsights(sessionId, [insight], [anomaly]);
  return insight;
}
