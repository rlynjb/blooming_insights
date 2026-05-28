// test/agents/diagnostic.test.ts
import { describe, it, expect, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { DiagnosticAgent } from '../../lib/agents/diagnostic';
import type { McpCaller } from '../../lib/agents/base';
import { AGENT_MODEL } from '../../lib/agents/base';
import type { WorkspaceSchema } from '../../lib/mcp/schema';
import type { McpToolDef } from '../../lib/agents/tool-schemas';
import type { Anomaly } from '../../lib/mcp/types';

// ---------------------------------------------------------------------------
// Shared fixture
// ---------------------------------------------------------------------------

const FIXTURE_SCHEMA: WorkspaceSchema = {
  projectId: 'proj-456',
  projectName: 'Diagnostic Store',
  totalCustomers: 20000,
  totalEvents: 5000000,
  oldestTimestamp: new Date('2023-01-01T00:00:00Z').getTime(),
  catalogs: [{ id: 'cat-1', name: 'Products' }],
  events: [
    {
      name: 'purchase',
      eventCount: 120000,
      properties: ['revenue', 'country', 'currency', 'product_id'],
    },
    {
      name: 'view_item',
      eventCount: 900000,
      properties: ['product_id', 'category', 'price'],
    },
  ],
  customerProperties: ['email', 'country', 'loyalty_tier'],
};

const SAMPLE_ANOMALY: Anomaly = {
  metric: 'conversion_rate',
  scope: ['mobile'],
  change: { value: 23, direction: 'down', baseline: '7d' },
  severity: 'critical',
  evidence: [{ tool: 'execute_analytics_eql', result: { current: 0.03, prior: 0.039 } }],
};

// ---------------------------------------------------------------------------
// Fake Anthropic builder (same pattern as monitoring.test.ts)
// ---------------------------------------------------------------------------

type FakeResponse = {
  content: Anthropic.Messages.ContentBlock[];
  stop_reason: Anthropic.Messages.Message['stop_reason'];
};

function buildFakeAnthropic(responses: FakeResponse[]): { anthropic: unknown } {
  let idx = 0;
  const create = vi.fn(async () => {
    const resp = responses[idx];
    if (!resp) throw new Error(`No scripted response at index ${idx}`);
    idx++;
    return {
      id: `msg_${idx}`,
      type: 'message' as const,
      role: 'assistant' as const,
      model: AGENT_MODEL,
      container: null,
      stop_details: null,
      stop_sequence: null,
      usage: {
        input_tokens: 10,
        output_tokens: 10,
        cache_creation: null,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
        inference_geo: null,
        server_tool_use: null,
        service_tier: null,
      },
      content: resp.content,
      stop_reason: resp.stop_reason,
    } as unknown as Anthropic.Messages.Message;
  });
  return { anthropic: { messages: { create } } };
}

function textBlock(text: string): Anthropic.Messages.ContentBlock {
  return { type: 'text', text, citations: null } as unknown as Anthropic.Messages.ContentBlock;
}

function toolUseBlock(id: string, name: string, input: Record<string, unknown>): Anthropic.Messages.ContentBlock {
  return {
    type: 'tool_use',
    id,
    name,
    input,
    caller: { type: 'direct' },
  } as unknown as Anthropic.Messages.ContentBlock;
}

// ---------------------------------------------------------------------------
// Fake MCP caller
// ---------------------------------------------------------------------------

function buildFakeMcp(): McpCaller {
  return {
    async callTool(_name, _args) {
      return { result: { ok: true }, durationMs: 1, fromCache: false };
    },
  };
}

// ---------------------------------------------------------------------------
// Shared tool defs
// ---------------------------------------------------------------------------

const FAKE_TOOL_DEFS: McpToolDef[] = [
  {
    name: 'execute_analytics_eql',
    description: 'Run analytics EQL query',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
];

// ---------------------------------------------------------------------------
// Valid diagnosis JSON
// ---------------------------------------------------------------------------

const VALID_DIAGNOSIS_JSON = JSON.stringify({
  conclusion: 'Mobile checkout conversion dropped due to a payment UI regression.',
  evidence: [
    'Mobile purchase count fell 23% while desktop was flat.',
    'Regression aligns with a deploy on the anomaly date.',
  ],
  hypothesesConsidered: [
    { hypothesis: 'Payment UI regression', supported: true, reasoning: 'Correlates with deploy date.' },
    { hypothesis: 'Seasonal traffic shift', supported: false, reasoning: 'Desktop was unaffected.' },
  ],
  affectedCustomers: { count: 1400, segmentDescription: 'Mobile shoppers at checkout' },
});

// ---------------------------------------------------------------------------
// 1. Returns a parsed diagnosis from a valid JSON fence
// ---------------------------------------------------------------------------

describe('DiagnosticAgent.investigate', () => {
  it('parses and returns a valid diagnosis when agent emits correct JSON', async () => {
    const { anthropic } = buildFakeAnthropic([
      {
        content: [textBlock('```json\n' + VALID_DIAGNOSIS_JSON + '\n```')],
        stop_reason: 'end_turn',
      },
    ]);

    const agent = new DiagnosticAgent(
      anthropic as unknown as Anthropic,
      buildFakeMcp(),
      FIXTURE_SCHEMA,
      FAKE_TOOL_DEFS,
    );

    const result = await agent.investigate(SAMPLE_ANOMALY);
    expect(result.conclusion).toContain('payment UI regression');
    expect(result.evidence).toHaveLength(2);
    expect(result.hypothesesConsidered).toHaveLength(2);
    expect(result.hypothesesConsidered[0].supported).toBe(true);
    expect(result.affectedCustomers?.count).toBe(1400);
  });

  // ---------------------------------------------------------------------------
  // 2. Passes streaming hooks through (tool call + text + tool result)
  // ---------------------------------------------------------------------------

  it('fires onToolCall, onText, and onToolResult hooks', async () => {
    const eqlResult = { data: { rows: [{ mobile_purchases: 380, desktop_purchases: 600 }] } };

    const { anthropic } = buildFakeAnthropic([
      // Turn 1: agent makes a tool call
      {
        content: [
          toolUseBlock('tu-diag-1', 'execute_analytics_eql', {
            project_id: 'proj-456',
            query: 'select count event purchase by customer.device grouping top 3 in last 7 days',
          }),
        ],
        stop_reason: 'tool_use',
      },
      // Turn 2: agent emits text + final diagnosis
      {
        content: [
          textBlock('Analysing results…\n```json\n' + VALID_DIAGNOSIS_JSON + '\n```'),
        ],
        stop_reason: 'end_turn',
      },
    ]);

    const toolCallsCaptured: string[] = [];
    const mcp: McpCaller = {
      async callTool(name, _args) {
        toolCallsCaptured.push(name);
        return { result: eqlResult, durationMs: 2, fromCache: false };
      },
    };

    const onToolCall = vi.fn();
    const onText = vi.fn();
    const onToolResult = vi.fn();

    const agent = new DiagnosticAgent(
      anthropic as unknown as Anthropic,
      mcp,
      FIXTURE_SCHEMA,
      FAKE_TOOL_DEFS,
    );

    const result = await agent.investigate(SAMPLE_ANOMALY, { onToolCall, onText, onToolResult });

    expect(toolCallsCaptured).toEqual(['execute_analytics_eql']);
    expect(onToolCall).toHaveBeenCalledTimes(1);
    expect(onToolResult).toHaveBeenCalledTimes(1);
    expect(onText).toHaveBeenCalledTimes(1);
    expect(result.conclusion).toContain('payment UI regression');
  });

  // ---------------------------------------------------------------------------
  // 3. Graceful fallback on non-diagnosis JSON (does NOT throw)
  // ---------------------------------------------------------------------------

  it('returns the fallback diagnosis when agent emits non-diagnosis JSON', async () => {
    const { anthropic } = buildFakeAnthropic([
      {
        content: [textBlock('```json\n{"foo":1}\n```')],
        stop_reason: 'end_turn',
      },
    ]);

    const agent = new DiagnosticAgent(
      anthropic as unknown as Anthropic,
      buildFakeMcp(),
      FIXTURE_SCHEMA,
      FAKE_TOOL_DEFS,
    );

    const result = await agent.investigate(SAMPLE_ANOMALY);
    expect(result.conclusion).toMatch(/Insufficient/i);
    expect(result.evidence).toEqual([]);
    expect(result.hypothesesConsidered).toEqual([]);
  });

  it('returns the fallback diagnosis when agent emits unparseable text', async () => {
    const { anthropic } = buildFakeAnthropic([
      {
        content: [textBlock('I was unable to investigate this anomaly due to insufficient data.')],
        stop_reason: 'end_turn',
      },
    ]);

    const agent = new DiagnosticAgent(
      anthropic as unknown as Anthropic,
      buildFakeMcp(),
      FIXTURE_SCHEMA,
      FAKE_TOOL_DEFS,
    );

    const result = await agent.investigate(SAMPLE_ANOMALY);
    expect(result.conclusion).toMatch(/Insufficient/i);
    expect(result.evidence).toEqual([]);
    expect(result.hypothesesConsidered).toEqual([]);
  });
});
