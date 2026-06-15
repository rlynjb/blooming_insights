// lib/agents/base.ts
import type Anthropic from '@anthropic-ai/sdk';
import type { AgentName, ToolCall } from '../mcp/types';

/**
 * The model used for all agent loops. Chosen for low latency within the 60s
 * per-investigation budget. Can be swapped at call-site by changing AGENT_MODEL.
 */
export const AGENT_MODEL = 'claude-sonnet-4-6';

/**
 * Minimal structural interface for an MCP caller so that unit tests can inject
 * a fake without depending on the concrete McpClient class or any network.
 * McpClient structurally satisfies this interface.
 */
export interface McpCaller {
  callTool(
    name: string,
    args: Record<string, unknown>,
    opts?: { cacheTtlMs?: number; skipCache?: boolean },
  ): Promise<{ result: unknown; durationMs: number; fromCache: boolean }>;
}

export interface AgentRunResult {
  finalText: string;
  toolCalls: ToolCall[];
}

const MAX_TOOL_RESULT_CHARS = 16_000;

function truncate(s: string): string {
  if (s.length <= MAX_TOOL_RESULT_CHARS) return s;
  return s.slice(0, MAX_TOOL_RESULT_CHARS) + '\n…[truncated]';
}

/**
 * runAgentLoop — shared Claude + MCP tool-use loop used by all four agents.
 *
 * Drives a multi-turn conversation where every tool_use block is dispatched
 * through the injected McpCaller and the result is fed back as a tool_result.
 * The loop terminates when:
 *   - The model returns a response with no tool_use blocks (natural end), or
 *   - maxTurns is exhausted (returns finalText:'').
 *
 * Both the Anthropic client and MCP client are injected so that callers can
 * pass fakes in tests — no network or real API keys needed.
 */
export async function runAgentLoop(opts: {
  anthropic: Anthropic;
  mcp: McpCaller;
  agent: AgentName;
  system: string;
  userPrompt: string;
  toolSchemas: Anthropic.Messages.Tool[];
  onToolCall?: (tc: ToolCall) => void;
  onText?: (text: string) => void;
  onToolResult?: (tc: ToolCall) => void;
  maxTurns?: number;
  maxTokens?: number;
  maxToolCalls?: number; // hard cap on total tool calls; once hit, the model is forced to synthesize
  synthesisInstruction?: string; // appended to system on the forced-final turn to compel a structured answer
}): Promise<AgentRunResult> {
  const {
    anthropic,
    mcp,
    agent,
    system,
    userPrompt,
    toolSchemas,
    onToolCall,
    onText,
    onToolResult,
    maxTurns = 8,
    maxTokens = 4096,
    maxToolCalls,
    synthesisInstruction,
  } = opts;

  const messages: Anthropic.Messages.MessageParam[] = [
    { role: 'user', content: userPrompt },
  ];

  const toolCalls: ToolCall[] = [];

  for (let turn = 0; turn < maxTurns; turn++) {
    // Omit tools when the model must now produce a final answer instead of
    // another tool call — guarantees a non-empty response and bounds latency:
    //   - on the final allowed turn, or
    //   - once the hard tool-call budget (maxToolCalls) is reached.
    const budgetSpent = maxToolCalls !== undefined && toolCalls.length >= maxToolCalls;
    const forceFinal = turn === maxTurns - 1 || budgetSpent;
    const params: Anthropic.Messages.MessageCreateParamsNonStreaming = {
      model: AGENT_MODEL,
      max_tokens: maxTokens,
      // On the forced-final turn, append the synthesis instruction so the model
      // stops exploring and emits its structured answer (it otherwise tends to
      // keep "thinking" and never produce the JSON).
      system: forceFinal && synthesisInstruction ? `${system}\n\n${synthesisInstruction}` : system,
      messages,
    };
    if (!forceFinal) params.tools = toolSchemas;
    const res = await anthropic.messages.create(params);
    // TODO: thread sessionId once runAgentLoop opts carry it (would require touching all 4 callers).
    console.log(JSON.stringify({ site: 'agents/base:runAgentLoop', usage: res.usage }));

    // Append assistant turn to message history
    messages.push({ role: 'assistant', content: res.content });

    // Extract text blocks from this turn and surface them to caller
    const textBlocks = res.content.filter(
      (b): b is Anthropic.Messages.TextBlock => b.type === 'text',
    );
    if (textBlocks.length > 0 && onText) {
      onText(textBlocks.map((b) => b.text).join(''));
    }

    // Collect tool_use blocks
    const toolUses = res.content.filter(
      (b): b is Anthropic.Messages.ToolUseBlock => b.type === 'tool_use',
    );

    // No tools → we're done; collect text and return
    if (toolUses.length === 0) {
      const finalText = textBlocks.map((b) => b.text).join('');
      return { finalText, toolCalls };
    }

    // Execute each tool call through MCP and collect results
    const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];

    for (const tu of toolUses) {
      const tc: ToolCall = {
        id: tu.id,
        agent,
        toolName: tu.name,
        args: tu.input as Record<string, unknown>,
      };

      // Notify caller before executing (allows progress streaming in the future)
      onToolCall?.(tc);

      let isError = false;
      let resultContent: string;

      try {
        const { result, durationMs } = await mcp.callTool(
          tu.name,
          tu.input as Record<string, unknown>,
        );
        tc.result = result;
        tc.durationMs = durationMs;
        resultContent = truncate(JSON.stringify(result));
      } catch (err) {
        isError = true;
        const message = err instanceof Error ? err.message : String(err);
        tc.error = message;
        resultContent = truncate(JSON.stringify({ error: message }));
      }

      toolCalls.push(tc);
      onToolResult?.(tc);

      const toolResult: Anthropic.Messages.ToolResultBlockParam = {
        type: 'tool_result',
        tool_use_id: tu.id,
        content: resultContent,
        ...(isError ? { is_error: true } : {}),
      };
      toolResults.push(toolResult);
    }

    // Feed all tool results back as the next user turn
    messages.push({ role: 'user', content: toolResults });
  }

  // maxTurns exhausted without a clean end
  return { finalText: '', toolCalls };
}
