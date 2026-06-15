// lib/agents/base.ts
import type Anthropic from '@anthropic-ai/sdk';
import type { AgentName, ToolCall } from '../mcp/types';
import type { DataSource } from '../data-source/types';

/**
 * The model used for all agent loops. Chosen for low latency within the 60s
 * per-investigation budget. Can be swapped at call-site by changing AGENT_MODEL.
 */
export const AGENT_MODEL = 'claude-sonnet-4-6';

/**
 * The agent-facing subset of `DataSource` — just `callTool`. The full
 * DataSource surface (which adds `listTools`) is implemented by adapters
 * (BloomreachDataSource today, OlistDataSource next) and consumed by the
 * route handlers; the agent loop never lists tools at runtime (the catalog
 * arrives pre-fetched as `allTools` in each agent's constructor).
 *
 * Pre-Phase 2 this was a standalone shape; lifting it to a Pick of DataSource
 * keeps the two surfaces aligned — any DataSource is automatically a McpCaller,
 * and the test fakes that only implement `callTool` still satisfy the agent's
 * requirement.
 */
export type McpCaller = Pick<DataSource, 'callTool'>;

export interface AgentRunResult<T = null> {
  finalText: string;
  toolCalls: ToolCall[];
  parsed: T | null;
}

const MAX_TOOL_RESULT_CHARS = 16_000;

function truncate(s: string): string {
  if (s.length <= MAX_TOOL_RESULT_CHARS) return s;
  return s.slice(0, MAX_TOOL_RESULT_CHARS) + '\n…[truncated]';
}

export type RunAgentLoopOpts<T> = {
  anthropic: Anthropic;
  /** Source of tool execution — DataSource subset (just `callTool`). Renamed
   *  from `mcp` in Phase 2 PR A; the agent loop's internals are unchanged. */
  dataSource: McpCaller;
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
  sessionId?: string; // optional; surfaced only in the per-turn usage log line so per-session token totals can be joined
  // Optional cancel propagation: when set, the loop checks `signal.aborted`
  // between turns and threads it to `anthropic.messages.create(params)` plus to
  // every `dataSource.callTool` call so an in-flight request aborts when the
  // route's `req.signal` fires. Optional — existing callers without a signal
  // are unchanged.
  signal?: AbortSignal;
  // Optional one-turn recovery: if the loop's finalText doesn't parse, the loop
  // runs ONE additional tool-less turn with `recoveryPrompt(toolCalls)` and
  // re-parses. Either both options or neither must be set for recovery to fire.
  parseResult?: (finalText: string) => T | null;
  recoveryPrompt?: (toolCalls: ToolCall[]) => string;
};

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
 *
 * Optional `parseResult` + `recoveryPrompt` add a one-turn tool-less recovery:
 * the loop runs as normal, attempts the parse on `finalText`, and on failure
 * runs ONE additional tool-less turn with the recovery prompt before giving up.
 * Callers that don't pass `parseResult` get `parsed: null` and ignore it.
 */
export async function runAgentLoop<T = null>(
  opts: RunAgentLoopOpts<T>,
): Promise<AgentRunResult<T>> {
  const {
    anthropic,
    dataSource,
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
    sessionId,
    signal,
  } = opts;

  const messages: Anthropic.Messages.MessageParam[] = [
    { role: 'user', content: userPrompt },
  ];

  const toolCalls: ToolCall[] = [];
  let finalText = '';

  for (let turn = 0; turn < maxTurns; turn++) {
    // Coarse abort check between turns — bails fast on cancel so the route's
    // catch block sees the AbortError before another SDK call is queued.
    signal?.throwIfAborted();
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
    const res = await anthropic.messages.create(params, signal ? { signal } : undefined);
    console.log(JSON.stringify({ site: 'agents/base:runAgentLoop', sessionId, usage: res.usage }));

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

    // No tools → we're done; collect text and exit the loop
    if (toolUses.length === 0) {
      finalText = textBlocks.map((b) => b.text).join('');
      break;
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
        const { result, durationMs } = await dataSource.callTool(
          tu.name,
          tu.input as Record<string, unknown>,
          signal ? { signal } : undefined,
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

  // One-turn tool-less recovery: if the caller provided a parser and the
  // loop's finalText doesn't parse, run a dedicated synthesis turn with the
  // recovery prompt and re-parse. Returns null on either parse failure or
  // any thrown error inside the recovery turn (caller decides the fallback).
  let parsed: T | null = null;
  if (opts.parseResult) {
    parsed = opts.parseResult(finalText);
    if (parsed === null && opts.recoveryPrompt) {
      const recoveryText = await runRecoveryTurn(opts, opts.recoveryPrompt(toolCalls));
      parsed = recoveryText === null ? null : opts.parseResult(recoveryText);
    }
  }

  return { finalText, toolCalls, parsed };
}

/**
 * Build the forced-final synthesis prompt. The prefix and closer are
 * owned by the loop because they reflect the loop's decision to spend
 * the last turn without tools; the middle is role-specific and stays
 * verbatim per agent.
 */
export function buildSynthesisInstruction(middle: string): string {
  return `You have NO more tool calls available. ${middle} Do not say you need more queries.`;
}

/**
 * One additional tool-less Claude call used by `runAgentLoop` when its
 * `parseResult` returns null on the loop's finalText. Returns the assistant
 * text on success, null on any thrown error so the caller can fall back.
 */
async function runRecoveryTurn<T>(
  opts: RunAgentLoopOpts<T>,
  recoveryUserContent: string,
): Promise<string | null> {
  try {
    // Early bail if cancellation already fired before we made the SDK call.
    opts.signal?.throwIfAborted();
    const res = await opts.anthropic.messages.create(
      {
        model: AGENT_MODEL,
        max_tokens: 2048,
        system:
          'You are concluding a completed investigation. Output ONLY the structured answer in the requested shape. Never ask for more data.',
        messages: [{ role: 'user', content: recoveryUserContent }],
      } as Anthropic.Messages.MessageCreateParamsNonStreaming,
      opts.signal ? { signal: opts.signal } : undefined,
    );
    console.log(
      JSON.stringify({ site: 'agents/base:runRecoveryTurn', sessionId: opts.sessionId, usage: res.usage }),
    );
    return res.content
      .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
  } catch (err) {
    // Propagate AbortError up — the route's catch-block distinguishes cancels
    // from real failures. Swallowing it here would let the loop return its
    // FALLBACK and emit a `diagnosis` event on an already-cancelled stream.
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    return null;
  }
}
