// test/agents/query.test.ts
import { describe, it, expect, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { QueryAgent } from '../../lib/agents/query';
import type { McpCaller } from '../../lib/agents/base';
import { AGENT_MODEL } from '../../lib/agents/base';
import type { WorkspaceSchema } from '../../lib/mcp/schema';
import type { McpToolDef } from '../../lib/agents/tool-schemas';

// ---------------------------------------------------------------------------
// Shared fixture
// ---------------------------------------------------------------------------

const FIXTURE_SCHEMA: WorkspaceSchema = {
  projectId: 'proj-789',
  projectName: 'Query Store',
  totalCustomers: 12000,
  totalEvents: 3000000,
  oldestTimestamp: new Date('2023-01-01T00:00:00Z').getTime(),
  catalogs: [{ id: 'cat-1', name: 'Products' }],
  events: [
    { name: 'purchase', eventCount: 80000, properties: ['revenue', 'country', 'currency'] },
    { name: 'view_item', eventCount: 600000, properties: ['product_id', 'category', 'price'] },
  ],
  customerProperties: ['email', 'country', 'loyalty_tier'],
};

// ---------------------------------------------------------------------------
// Fake Anthropic builder (same pattern as diagnostic.test.ts)
// ---------------------------------------------------------------------------

type FakeResponse = {
  content: Anthropic.Messages.ContentBlock[];
  stop_reason: Anthropic.Messages.Message['stop_reason'];
};

function buildFakeAnthropic(responses: FakeResponse[]): { anthropic: unknown } {
  let idx = 0;
  const create = vi.fn(async () => {
    // When the script runs out, keep returning the last response so a
    // maxTurns-style loop can run to exhaustion without throwing.
    const resp = responses[Math.min(idx, responses.length - 1)];
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

function toolUseBlock(
  id: string,
  name: string,
  input: Record<string, unknown>,
): Anthropic.Messages.ContentBlock {
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
// 1. Returns the agent's final answer text (plain text, no tools)
// ---------------------------------------------------------------------------

describe('QueryAgent.answer', () => {
  it('returns the agent final answer text when the model emits plain text', async () => {
    const ANSWER = 'Revenue rose 12% last quarter, driven by repeat purchasers.';
    const { anthropic } = buildFakeAnthropic([
      { content: [textBlock(ANSWER)], stop_reason: 'end_turn' },
    ]);

    const agent = new QueryAgent(
      anthropic as unknown as Anthropic,
      buildFakeMcp(),
      FIXTURE_SCHEMA,
      FAKE_TOOL_DEFS,
    );

    const result = await agent.answer('How did revenue trend?', 'monitoring');
    expect(result).toBe(ANSWER);
  });

  // -------------------------------------------------------------------------
  // 2. Runs a tool then answers, firing all hooks
  // -------------------------------------------------------------------------

  it('runs a tool then answers and fires onToolCall, onText, and onToolResult', async () => {
    const eqlResult = { data: { rows: [{ revenue: 124000 }] } };
    const ANSWER = 'Total revenue was 124,000 over the period.';

    const { anthropic } = buildFakeAnthropic([
      {
        content: [
          toolUseBlock('tu-q-1', 'execute_analytics_eql', {
            project_id: 'proj-789',
            query: 'select sum event purchase.revenue in last 90 days',
          }),
        ],
        stop_reason: 'tool_use',
      },
      {
        content: [textBlock('Looking at the totals…\n' + ANSWER)],
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

    const agent = new QueryAgent(
      anthropic as unknown as Anthropic,
      mcp,
      FIXTURE_SCHEMA,
      FAKE_TOOL_DEFS,
    );

    const result = await agent.answer('What was total revenue?', 'diagnostic', {
      onToolCall,
      onText,
      onToolResult,
    });

    expect(toolCallsCaptured).toEqual(['execute_analytics_eql']);
    expect(onToolCall).toHaveBeenCalledTimes(1);
    expect(onToolResult).toHaveBeenCalledTimes(1);
    expect(onText).toHaveBeenCalledTimes(1);
    expect(result).toContain(ANSWER);
  });

  // -------------------------------------------------------------------------
  // 3. Returns a non-empty fallback string when the loop yields empty text
  // -------------------------------------------------------------------------

  it('returns a non-empty fallback when the loop produces no answer text', async () => {
    // Every turn is a tool_use that never resolves to a final text answer, so the
    // loop exhausts maxTurns and returns finalText:''. The fake keeps returning the
    // same tool_use response after the script ends.
    const { anthropic } = buildFakeAnthropic([
      {
        content: [
          toolUseBlock('tu-loop', 'execute_analytics_eql', { project_id: 'proj-789', query: 'x' }),
        ],
        stop_reason: 'tool_use',
      },
    ]);

    const agent = new QueryAgent(
      anthropic as unknown as Anthropic,
      buildFakeMcp(),
      FIXTURE_SCHEMA,
      FAKE_TOOL_DEFS,
    );

    const result = await agent.answer('Anything interesting?', 'recommendation');
    expect(result).not.toBe('');
    expect(result).toMatch(/unable to find enough data/i);
  });
});
