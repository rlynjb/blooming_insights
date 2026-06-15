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
        return typeof next === 'function' ? next() : next;
      },
    };
  }
  return { default: MockAnthropic };
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
  // We hand back a minimal McpToolDef set covering the monitoring agent's
  // allowlist — enough that `filterToolSchemas(allTools, monitoringTools)`
  // produces a non-empty array (the Anthropic call would otherwise reject
  // an empty `tools` field).
  return {
    tools: [
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
    ],
  };
}

/** Build the fake `McpClient` the route receives from `connectMcp`. Phase 1
 *  implements only `'ok'`; the others throw so Phase 2/3 tests that touch them
 *  fail with a clear "not implemented yet" rather than a silent undefined. */
export function makeMockTransport(scenario: MockMcpScenario): MockMcp {
  if (scenario === 'ok') {
    return {
      callTool: makeBootstrapCallTool(),
      listTools: vi.fn(async () => makeMonitoringToolList()),
    };
  }
  // TODO Phase 2/3: implement these scenarios.
  throw new Error(`makeMockTransport: scenario '${scenario}' not implemented in Phase 1`);
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
  // TODO Phase 2/3: implement 'unauthed' (forces 401) and 'expired'.
  throw new Error(`makeMockSession: mode '${mode}' not implemented in Phase 1`);
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
