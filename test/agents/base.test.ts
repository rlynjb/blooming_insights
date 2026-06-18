// test/agents/base.test.ts
import { describe, it, expect, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { runAgentLoop, AGENT_MODEL } from '../../lib/agents/base-legacy';
import type { McpCaller } from '../../lib/agents/base-legacy';

// ---------------------------------------------------------------------------
// Helpers to build scripted fake Anthropic instances
// ---------------------------------------------------------------------------

type FakeResponse = {
  content: Anthropic.Messages.ContentBlock[];
  stop_reason: Anthropic.Messages.Message['stop_reason'];
};

function buildFakeAnthropic(responses: FakeResponse[]): {
  anthropic: unknown;
  callCount: () => number;
} {
  let idx = 0;
  let count = 0;

  const create = vi.fn(async () => {
    count++;
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
    } satisfies Partial<Anthropic.Messages.Message> as unknown as Anthropic.Messages.Message;
  });

  const anthropic = {
    messages: { create },
  };

  return { anthropic, callCount: () => count };
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

function textBlock(text: string): Anthropic.Messages.ContentBlock {
  return { type: 'text', text, citations: null } as unknown as Anthropic.Messages.ContentBlock;
}

// ---------------------------------------------------------------------------
// Fake McpCaller
// ---------------------------------------------------------------------------

function buildFakeMcp(impl: (name: string, args: Record<string, unknown>) => Promise<unknown>): McpCaller {
  return {
    async callTool(name, args) {
      const result = await impl(name, args);
      return { result, durationMs: 1, fromCache: false };
    },
  };
}

// ---------------------------------------------------------------------------
// Shared tool schemas (minimal, no network needed)
// ---------------------------------------------------------------------------

const fakeToolSchemas: Anthropic.Messages.Tool[] = [
  {
    name: 'get_project_overview',
    description: 'Get project overview',
    input_schema: { type: 'object', properties: {}, required: [] } as Anthropic.Messages.Tool['input_schema'],
  },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runAgentLoop', () => {
  // -------------------------------------------------------------------------
  // 1. Executes a tool then finishes
  // -------------------------------------------------------------------------
  it('executes a tool then returns final text', async () => {
    const { anthropic, callCount } = buildFakeAnthropic([
      // Turn 1: model requests a tool call
      {
        content: [toolUseBlock('tu1', 'get_project_overview', { project_id: 'p' })],
        stop_reason: 'tool_use',
      },
      // Turn 2: model returns final text after seeing tool result
      {
        content: [textBlock('done: 5 customers')],
        stop_reason: 'end_turn',
      },
    ]);

    const mcp = buildFakeMcp(async () => ({
      isError: false,
      content: [],
      structuredContent: { data: { total_customers: 5 } },
    }));

    const onToolCall = vi.fn();

    const result = await runAgentLoop({
      anthropic: anthropic as unknown as Anthropic,
      dataSource: mcp,
      agent: 'monitoring',
      system: 'You are a monitoring agent.',
      userPrompt: 'Check the project.',
      toolSchemas: fakeToolSchemas,
      onToolCall,
    });

    // finalText contains 'done'
    expect(result.finalText).toContain('done');
    // exactly one tool call recorded
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].toolName).toBe('get_project_overview');
    expect(result.toolCalls[0].result).toBeDefined();
    // onToolCall fired once
    expect(onToolCall).toHaveBeenCalledTimes(1);
    // anthropic.messages.create called twice
    expect(callCount()).toBe(2);
  });

  // -------------------------------------------------------------------------
  // 2. No tools → returns text on the first turn
  // -------------------------------------------------------------------------
  it('returns text immediately when no tools are called', async () => {
    const { anthropic, callCount } = buildFakeAnthropic([
      {
        content: [textBlock('Hello, world!')],
        stop_reason: 'end_turn',
      },
    ]);

    const mcp = buildFakeMcp(async () => ({}));
    const onToolCall = vi.fn();

    const result = await runAgentLoop({
      anthropic: anthropic as unknown as Anthropic,
      dataSource: mcp,
      agent: 'coordinator',
      system: 'You are a coordinator.',
      userPrompt: 'Say hello.',
      toolSchemas: fakeToolSchemas,
      onToolCall,
    });

    expect(result.finalText).toBe('Hello, world!');
    expect(result.toolCalls).toHaveLength(0);
    expect(onToolCall).not.toHaveBeenCalled();
    expect(callCount()).toBe(1);
  });

  // -------------------------------------------------------------------------
  // 3. Records error when a tool throws; loop continues to final text
  // -------------------------------------------------------------------------
  it('records tool error and continues when mcp.callTool throws', async () => {
    const { anthropic, callCount } = buildFakeAnthropic([
      // Turn 1: tool call
      {
        content: [toolUseBlock('tu2', 'get_project_overview', { project_id: 'x' })],
        stop_reason: 'tool_use',
      },
      // Turn 2: model recovers with text after seeing is_error tool_result
      {
        content: [textBlock('recovered after error')],
        stop_reason: 'end_turn',
      },
    ]);

    const mcp = buildFakeMcp(async () => {
      throw new Error('MCP transport failed');
    });

    const result = await runAgentLoop({
      anthropic: anthropic as unknown as Anthropic,
      dataSource: mcp,
      agent: 'diagnostic',
      system: 'You are a diagnostic agent.',
      userPrompt: 'Diagnose issues.',
      toolSchemas: fakeToolSchemas,
    });

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].error).toBeDefined();
    expect(result.toolCalls[0].error).toContain('MCP transport failed');
    expect(result.finalText).toContain('recovered after error');
    expect(callCount()).toBe(2);
  });

  // -------------------------------------------------------------------------
  // 4. Respects maxTurns
  // -------------------------------------------------------------------------
  it('stops after maxTurns and returns finalText="" without looping forever', async () => {
    // Always returns a tool_use — loop should stop at maxTurns:2
    const { anthropic, callCount } = buildFakeAnthropic([
      {
        content: [toolUseBlock('tu3', 'get_project_overview', { project_id: 'q' })],
        stop_reason: 'tool_use',
      },
      {
        content: [toolUseBlock('tu4', 'get_project_overview', { project_id: 'q' })],
        stop_reason: 'tool_use',
      },
      // Should never reach this
      {
        content: [textBlock('should not see this')],
        stop_reason: 'end_turn',
      },
    ]);

    const mcp = buildFakeMcp(async () => ({ ok: true }));

    const result = await runAgentLoop({
      anthropic: anthropic as unknown as Anthropic,
      dataSource: mcp,
      agent: 'recommendation',
      system: 'You are a recommendation agent.',
      userPrompt: 'Recommend actions.',
      toolSchemas: fakeToolSchemas,
      maxTurns: 2,
    });

    expect(result.finalText).toBe('');
    expect(callCount()).toBe(2);
  });

  // -------------------------------------------------------------------------
  // 5. Forces a final answer once maxToolCalls is reached
  // -------------------------------------------------------------------------
  it('omits tools and forces a final answer once maxToolCalls is reached', async () => {
    const { anthropic, callCount } = buildFakeAnthropic([
      { content: [toolUseBlock('tu5', 'get_project_overview', { project_id: 'z' })], stop_reason: 'tool_use' },
      { content: [textBlock('final after budget')], stop_reason: 'end_turn' },
    ]);
    const mcp = buildFakeMcp(async () => ({ ok: true }));

    const result = await runAgentLoop({
      anthropic: anthropic as unknown as Anthropic,
      dataSource: mcp,
      agent: 'monitoring',
      system: 's',
      userPrompt: 'go',
      toolSchemas: fakeToolSchemas,
      maxToolCalls: 1,
      maxTurns: 8,
    });

    expect(result.toolCalls).toHaveLength(1);
    expect(result.finalText).toContain('final after budget');
    expect(callCount()).toBe(2);
    // turn 1 offered tools; turn 2 (budget spent) must omit them
    const calls = (anthropic as { messages: { create: { mock: { calls: { 0: { tools?: unknown } }[] } } } }).messages.create.mock.calls;
    expect(calls[0][0].tools).toBeDefined();
    expect(calls[1][0].tools).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // 6. onText fires with reasoning text from each turn that has text blocks
  // -------------------------------------------------------------------------
  it('calls onText with reasoning text for each turn that has text', async () => {
    const { anthropic } = buildFakeAnthropic([
      // Turn 1: text reasoning + tool use
      {
        content: [
          textBlock('thinking about it'),
          toolUseBlock('tu6', 'get_project_overview', { project_id: 'r' }),
        ],
        stop_reason: 'tool_use',
      },
      // Turn 2: final text only
      {
        content: [textBlock('final')],
        stop_reason: 'end_turn',
      },
    ]);

    const mcp = buildFakeMcp(async () => ({ ok: true }));
    const onTextCalls: string[] = [];
    const onText = (text: string) => { onTextCalls.push(text); };

    await runAgentLoop({
      anthropic: anthropic as unknown as Anthropic,
      dataSource: mcp,
      agent: 'monitoring',
      system: 'You are a monitoring agent.',
      userPrompt: 'Check things.',
      toolSchemas: fakeToolSchemas,
      onText,
    });

    expect(onTextCalls).toHaveLength(2);
    expect(onTextCalls[0]).toContain('thinking about it');
    expect(onTextCalls[1]).toContain('final');
  });

  // -------------------------------------------------------------------------
  // 7. onToolResult fires after execution with a fully populated ToolCall
  // -------------------------------------------------------------------------
  it('calls onToolResult after tool execution with result populated', async () => {
    const { anthropic } = buildFakeAnthropic([
      // Turn 1: tool use
      {
        content: [toolUseBlock('tu7', 'get_project_overview', { project_id: 's' })],
        stop_reason: 'tool_use',
      },
      // Turn 2: final text
      {
        content: [textBlock('done')],
        stop_reason: 'end_turn',
      },
    ]);

    const mcp = buildFakeMcp(async () => ({ total: 42 }));
    const onToolResultCalls: import('../../lib/mcp/types').ToolCall[] = [];
    const onToolResult = (tc: import('../../lib/mcp/types').ToolCall) => { onToolResultCalls.push(tc); };

    await runAgentLoop({
      anthropic: anthropic as unknown as Anthropic,
      dataSource: mcp,
      agent: 'monitoring',
      system: 'You are a monitoring agent.',
      userPrompt: 'Check.',
      toolSchemas: fakeToolSchemas,
      onToolResult,
    });

    expect(onToolResultCalls).toHaveLength(1);
    expect(onToolResultCalls[0].toolName).toBe('get_project_overview');
    expect(onToolResultCalls[0].result).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // 8. synthesisInstruction is appended to system only on the forced-final turn
  // -------------------------------------------------------------------------
  it('appends synthesisInstruction to the system prompt only on the forced-final turn', async () => {
    const { anthropic } = buildFakeAnthropic([
      { content: [toolUseBlock('tu8', 'get_project_overview', { project_id: 'z' })], stop_reason: 'tool_use' },
      { content: [textBlock('final')], stop_reason: 'end_turn' },
    ]);
    const mcp = buildFakeMcp(async () => ({ ok: true }));

    await runAgentLoop({
      anthropic: anthropic as unknown as Anthropic,
      dataSource: mcp,
      agent: 'diagnostic',
      system: 'BASE SYSTEM',
      userPrompt: 'go',
      toolSchemas: fakeToolSchemas,
      maxToolCalls: 1,
      maxTurns: 8,
      synthesisInstruction: 'OUTPUT JSON NOW',
    });

    const calls = (anthropic as { messages: { create: { mock: { calls: { 0: { system: string } }[] } } } }).messages.create.mock.calls;
    expect(calls[0][0].system).toBe('BASE SYSTEM'); // turn 1: tools offered, plain system
    expect(calls[1][0].system).toContain('OUTPUT JSON NOW'); // forced turn: augmented
  });
});
