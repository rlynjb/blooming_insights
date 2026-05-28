// test/agents/monitoring.test.ts
import { describe, it, expect, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { schemaSummary, MonitoringAgent } from '../../lib/agents/monitoring';
import type { McpCaller } from '../../lib/agents/base';
import type { WorkspaceSchema } from '../../lib/mcp/schema';
import type { McpToolDef } from '../../lib/agents/tool-schemas';
import { AGENT_MODEL } from '../../lib/agents/base';

// ---------------------------------------------------------------------------
// Shared fixture
// ---------------------------------------------------------------------------

const FIXTURE_SCHEMA: WorkspaceSchema = {
  projectId: 'proj-123',
  projectName: 'Test Store',
  totalCustomers: 15000,
  totalEvents: 4200000,
  oldestTimestamp: new Date('2023-01-01T00:00:00Z').getTime(),
  catalogs: [{ id: 'cat-1', name: 'Products' }],
  events: [
    {
      name: 'purchase',
      eventCount: 98000,
      properties: ['revenue', 'country', 'currency', 'product_id'],
    },
    {
      name: 'view_item',
      eventCount: 750000,
      properties: ['product_id', 'category', 'price'],
    },
    {
      name: 'cart_update',
      eventCount: 310000,
      properties: ['product_id', 'action', 'quantity'],
    },
    {
      name: 'session_start',
      eventCount: 900000,
      properties: ['device_type', 'source'],
    },
  ],
  customerProperties: ['email', 'country', 'loyalty_tier', 'total_spent'],
};

// ---------------------------------------------------------------------------
// Fake Anthropic builder (same pattern as base.test.ts)
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
// Shared tool defs (minimal, no network needed)
// ---------------------------------------------------------------------------

const FAKE_TOOL_DEFS: McpToolDef[] = [
  {
    name: 'execute_analytics_eql',
    description: 'Run analytics EQL query',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
];

// ---------------------------------------------------------------------------
// Helper: valid anomaly JSON for two anomalies (info + critical)
// ---------------------------------------------------------------------------

const TWO_ANOMALIES_JSON = JSON.stringify([
  {
    metric: 'session_count',
    scope: ['mobile'],
    change: { value: 12, direction: 'up', baseline: '7d' },
    severity: 'info',
    evidence: [{ tool: 'execute_analytics_eql', result: { rows: 100 } }],
  },
  {
    metric: 'purchase_count',
    scope: ['checkout'],
    change: { value: 25, direction: 'down', baseline: '7d' },
    severity: 'critical',
    evidence: [{ tool: 'execute_analytics_eql', result: { rows: 50 } }],
  },
]);

// ---------------------------------------------------------------------------
// 1. schemaSummary (pure)
// ---------------------------------------------------------------------------

describe('schemaSummary', () => {
  it('includes the project name', () => {
    const s = schemaSummary(FIXTURE_SCHEMA);
    expect(s).toContain('Test Store');
  });

  it('includes a known event name with its count', () => {
    const s = schemaSummary(FIXTURE_SCHEMA);
    expect(s).toContain('purchase');
    expect(s).toContain('98000');
  });

  it('includes a customer property', () => {
    const s = schemaSummary(FIXTURE_SCHEMA);
    expect(s).toContain('loyalty_tier');
  });

  it('is bounded — does not dump the full 112KB schema', () => {
    // Build a schema with many events and long property lists
    const big: WorkspaceSchema = {
      ...FIXTURE_SCHEMA,
      events: Array.from({ length: 100 }, (_, i) => ({
        name: `event_${i}`,
        eventCount: i * 100,
        properties: Array.from({ length: 50 }, (_, j) => `prop_${j}`),
      })),
      customerProperties: Array.from({ length: 200 }, (_, i) => `cprop_${i}`),
    };
    const s = schemaSummary(big);
    // Summary should be well under 10KB
    expect(s.length).toBeLessThan(10_000);
  });
});

// ---------------------------------------------------------------------------
// 2. MonitoringAgent.scan — parses, validates, sorts, slices
// ---------------------------------------------------------------------------

describe('MonitoringAgent.scan', () => {
  it('parses and sorts anomalies critical-first', async () => {
    const { anthropic } = buildFakeAnthropic([
      {
        content: [textBlock('```json\n' + TWO_ANOMALIES_JSON + '\n```')],
        stop_reason: 'end_turn',
      },
    ]);

    const agent = new MonitoringAgent(
      anthropic as unknown as Anthropic,
      buildFakeMcp(),
      FIXTURE_SCHEMA,
      FAKE_TOOL_DEFS,
    );

    const result = await agent.scan();
    expect(result).toHaveLength(2);
    expect(result[0].severity).toBe('critical');
    expect(result[1].severity).toBe('info');
  });

  it('makes one tool call then returns final anomaly JSON', async () => {
    const eqlResult = { data: { rows: [{ count: 42 }] } };
    const { anthropic } = buildFakeAnthropic([
      // Turn 1: model calls a tool
      {
        content: [
          toolUseBlock('tu1', 'execute_analytics_eql', {
            project_id: 'proj-123',
            query: 'select count event purchase in last 7 days',
          }),
        ],
        stop_reason: 'tool_use',
      },
      // Turn 2: returns anomaly JSON after seeing result
      {
        content: [textBlock('```json\n' + TWO_ANOMALIES_JSON + '\n```')],
        stop_reason: 'end_turn',
      },
    ]);

    const toolCallNames: string[] = [];
    const mcp: McpCaller = {
      async callTool(name, _args) {
        toolCallNames.push(name);
        return { result: eqlResult, durationMs: 2, fromCache: false };
      },
    };

    const onToolCall = vi.fn();

    const agent = new MonitoringAgent(
      anthropic as unknown as Anthropic,
      mcp,
      FIXTURE_SCHEMA,
      FAKE_TOOL_DEFS,
    );

    const result = await agent.scan(onToolCall);
    expect(toolCallNames).toEqual(['execute_analytics_eql']);
    expect(onToolCall).toHaveBeenCalledTimes(1);
    expect(result[0].severity).toBe('critical');
  });

  it('slices to at most 10 anomalies', async () => {
    // Build 11 valid anomaly objects
    const elevenAnomalies = Array.from({ length: 11 }, (_, i) => ({
      metric: `metric_${i}`,
      scope: ['global'],
      change: { value: 15, direction: 'down' as const, baseline: '7d' },
      severity: 'info' as const,
      evidence: [{ tool: 'execute_analytics_eql', result: {} }],
    }));

    const { anthropic } = buildFakeAnthropic([
      {
        content: [textBlock('```json\n' + JSON.stringify(elevenAnomalies) + '\n```')],
        stop_reason: 'end_turn',
      },
    ]);

    const agent = new MonitoringAgent(
      anthropic as unknown as Anthropic,
      buildFakeMcp(),
      FIXTURE_SCHEMA,
      FAKE_TOOL_DEFS,
    );

    const result = await agent.scan();
    expect(result.length).toBeLessThanOrEqual(10);
  });

  // ---------------------------------------------------------------------------
  // 3. scan throws on invalid output
  // ---------------------------------------------------------------------------

  it('throws when the agent returns non-anomaly JSON', async () => {
    const { anthropic } = buildFakeAnthropic([
      {
        content: [textBlock('```json\n[{"foo":1}]\n```')],
        stop_reason: 'end_turn',
      },
    ]);

    const agent = new MonitoringAgent(
      anthropic as unknown as Anthropic,
      buildFakeMcp(),
      FIXTURE_SCHEMA,
      FAKE_TOOL_DEFS,
    );

    await expect(agent.scan()).rejects.toThrow('monitoring agent returned invalid anomalies');
  });

  it('accepts an empty array as valid (no anomalies found)', async () => {
    const { anthropic } = buildFakeAnthropic([
      {
        content: [textBlock('```json\n[]\n```')],
        stop_reason: 'end_turn',
      },
    ]);

    const agent = new MonitoringAgent(
      anthropic as unknown as Anthropic,
      buildFakeMcp(),
      FIXTURE_SCHEMA,
      FAKE_TOOL_DEFS,
    );

    const result = await agent.scan();
    expect(result).toEqual([]);
  });
});
