import Anthropic from '@anthropic-ai/sdk';
import {
  type CapabilityEvent,
  type CapabilityTraceSink,
  type ModelContentBlock,
  type ModelMessage,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type ModelTool,
  type ModelToolResultBlock,
  type ToolDefinition,
  type ToolRegistry,
} from '@aptkit/core';
import { AGENT_MODEL, type McpCaller } from './base';
import type { McpToolDef } from './tool-schemas';
import type { AgentName, ToolCall } from '../mcp/types';

export type AptKitAgentHooks = {
  onToolCall?: (tc: ToolCall) => void;
  onToolResult?: (tc: ToolCall) => void;
  onText?: (text: string) => void;
  /**
   * Additive Phase-2-observability hook: forwards every raw
   * `CapabilityEvent` from the AptKit trace sink. Optional; when unset,
   * runtime behavior is exactly as before. Consumers use this to feed
   * events into aptkit's `summarizeUsage` + `estimateCost` for
   * per-invocation token + cost ledger rows.
   */
  onCapabilityEvent?: (event: CapabilityEvent) => void;
};

/** Adapts Blooming's Anthropic SDK client to AptKit's provider-neutral ModelProvider. */
export class AnthropicModelProviderAdapter implements ModelProvider {
  readonly id = 'anthropic';
  readonly defaultModel: string;
  private readonly logSite: string;

  constructor(
    private readonly anthropic: Anthropic,
    agent: AgentName,
    private readonly sessionId?: string,
    model = AGENT_MODEL,
    logSite = `agents/${agent}:aptkit-model`,
  ) {
    this.defaultModel = model;
    this.logSite = logSite;
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const params: Anthropic.Messages.MessageCreateParamsNonStreaming = {
      model: this.defaultModel,
      max_tokens: request.maxTokens ?? 4096,
      messages: request.messages.map(toAnthropicMessage),
    };

    // Phase-3 prompt caching. The system prompt is stable across every call
    // within an investigation (all ~5-15 ReAct-loop iterations reuse it) and
    // is the largest fixed prefix in the payload. Wrapping it in an ephemeral
    // cache breakpoint makes the first call a cache_creation (~1.25× normal
    // input cost) and every subsequent call within 5 min a cache_read
    // (~0.1× normal). For a diagnostic run's ~10 model turns this is roughly
    // an 80% reduction on the system-prompt token cost.
    //
    // Tools are also stable across the loop but the Anthropic API caches
    // tools transparently when the SAME breakpoint is set on the system
    // prompt — so this one addition covers both prefixes.
    if (request.system) {
      params.system = [
        { type: 'text', text: request.system, cache_control: { type: 'ephemeral' } },
      ];
    }
    if (request.tools?.length) params.tools = request.tools.map(toAnthropicTool);

    const response = await this.anthropic.messages.create(
      params,
      request.signal ? { signal: request.signal } : undefined,
    );

    console.log(JSON.stringify({
      site: this.logSite,
      sessionId: this.sessionId,
      usage: response.usage,
    }));

    return {
      content: response.content.flatMap(toModelContentBlock),
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
      model: response.model,
    };
  }
}

/** Adapts Blooming's data-source callTool seam to AptKit's ToolRegistry. */
export class BloomingToolRegistryAdapter implements ToolRegistry {
  constructor(
    private readonly dataSource: McpCaller,
    private readonly allTools: McpToolDef[],
  ) {}

  listTools(): ToolDefinition[] {
    return this.allTools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ): Promise<{ result: unknown; durationMs: number }> {
    const { result, durationMs } = await this.dataSource.callTool(name, args, options);
    return { result, durationMs };
  }
}

/** Bridges AptKit trace events back into Blooming's existing route/eval hooks. */
export class BloomingTraceSinkAdapter implements CapabilityTraceSink {
  private readonly activeToolCalls = new Map<string, ToolCall[]>();

  constructor(
    private readonly hooks: AptKitAgentHooks,
    private readonly agent: AgentName,
  ) {}

  emit(event: CapabilityEvent): void {
    // Additive Phase-2 observability: forward every event to the optional
    // capability-event hook before existing per-type routing. Consumers
    // that don't set the hook see identical behavior.
    this.hooks.onCapabilityEvent?.(event);

    if (event.type === 'step') {
      this.hooks.onText?.(event.content);
      return;
    }

    if (event.type === 'tool_call_start') {
      const toolCall = this.toBloomingToolCall(event);
      const existing = this.activeToolCalls.get(event.toolName) ?? [];
      existing.push(toolCall);
      this.activeToolCalls.set(event.toolName, existing);
      this.hooks.onToolCall?.(toolCall);
      return;
    }

    if (event.type === 'tool_call_end') {
      const toolCall = this.activeToolCalls.get(event.toolName)?.shift() ?? this.toBloomingToolCall(event);
      toolCall.durationMs = event.durationMs;
      toolCall.result = event.result;
      toolCall.error = event.error;
      this.hooks.onToolResult?.(toolCall);
    }
  }

  private toBloomingToolCall(
    event: Extract<CapabilityEvent, { type: 'tool_call_start' | 'tool_call_end' }>,
  ): ToolCall {
    return {
      id: `aptkit-${event.toolName}-${event.timestamp}`,
      agent: this.agent,
      toolName: event.toolName,
      args: event.type === 'tool_call_start' && isRecord(event.args) ? event.args : {},
    };
  }
}

function toAnthropicMessage(message: ModelMessage): Anthropic.Messages.MessageParam {
  if (typeof message.content === 'string') {
    return { role: message.role, content: message.content };
  }

  return {
    role: message.role,
    content: message.content.map(toAnthropicContentBlock),
  } as Anthropic.Messages.MessageParam;
}

function toAnthropicContentBlock(
  block: ModelContentBlock | ModelToolResultBlock,
): Anthropic.Messages.ContentBlockParam {
  if (block.type === 'text') {
    return { type: 'text', text: block.text };
  }

  if (block.type === 'tool_use') {
    return {
      type: 'tool_use',
      id: block.id,
      name: block.name,
      input: block.input,
    } as Anthropic.Messages.ToolUseBlockParam;
  }

  return {
    type: 'tool_result',
    tool_use_id: block.toolUseId,
    content: block.content,
    ...(block.isError ? { is_error: true } : {}),
  };
}

function toAnthropicTool(tool: ModelTool): Anthropic.Messages.Tool {
  return {
    name: tool.name,
    description: tool.description ?? '',
    input_schema: tool.inputSchema as Anthropic.Messages.Tool['input_schema'],
  };
}

function toModelContentBlock(block: Anthropic.Messages.ContentBlock): ModelContentBlock[] {
  if (block.type === 'text') {
    return [{ type: 'text', text: block.text }];
  }

  if (block.type === 'tool_use') {
    return [{
      type: 'tool_use',
      id: block.id,
      name: block.name,
      input: block.input as Record<string, unknown>,
    }];
  }

  return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
