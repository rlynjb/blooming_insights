import Anthropic from '@anthropic-ai/sdk';
import {
  RecommendationAgent as AptKitRecommendationAgent,
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
import type { AgentHooks } from './diagnostic';
import type { McpToolDef } from './tool-schemas';
import type { Anomaly, Diagnosis, Recommendation, ToolCall } from '../mcp/types';
import type { WorkspaceSchema } from '../mcp/schema';

/** Compatibility wrapper: Blooming keeps this constructor while AptKit owns the reusable agent. */
export class RecommendationAgent {
  constructor(
    private anthropic: Anthropic,
    private dataSource: McpCaller,
    private schema: WorkspaceSchema,
    private allTools: McpToolDef[],
    private sessionId?: string,
  ) {}

  async propose(
    anomaly: Anomaly,
    diagnosis: Diagnosis,
    hooks: AgentHooks = {},
  ): Promise<Recommendation[]> {
    const agent = new AptKitRecommendationAgent({
      model: new AnthropicModelProviderAdapter(this.anthropic, this.sessionId),
      tools: new BloomingToolRegistryAdapter(this.dataSource, this.allTools),
      workspace: this.schema,
      trace: new BloomingTraceSinkAdapter(hooks),
    });

    return agent.propose(anomaly, diagnosis, { signal: hooks.signal });
  }
}

/** Adapts Blooming's Anthropic SDK client to AptKit's provider-neutral ModelProvider. */
class AnthropicModelProviderAdapter implements ModelProvider {
  readonly id = 'anthropic';
  readonly defaultModel = AGENT_MODEL;

  constructor(
    private readonly anthropic: Anthropic,
    private readonly sessionId?: string,
  ) {}

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const params: Anthropic.Messages.MessageCreateParamsNonStreaming = {
      model: this.defaultModel,
      max_tokens: request.maxTokens ?? 4096,
      messages: request.messages.map(toAnthropicMessage),
    };

    if (request.system) params.system = request.system;
    if (request.tools?.length) params.tools = request.tools.map(toAnthropicTool);

    const response = await this.anthropic.messages.create(
      params,
      request.signal ? { signal: request.signal } : undefined,
    );

    console.log(JSON.stringify({ site: 'agents/recommendation:aptkit-model', sessionId: this.sessionId, usage: response.usage }));

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
class BloomingToolRegistryAdapter implements ToolRegistry {
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
class BloomingTraceSinkAdapter implements CapabilityTraceSink {
  private readonly activeToolCalls = new Map<string, ToolCall[]>();

  constructor(private readonly hooks: AgentHooks) {}

  emit(event: CapabilityEvent): void {
    if (event.type === 'step') {
      this.hooks.onText?.(event.content);
      return;
    }

    if (event.type === 'tool_call_start') {
      const toolCall = toBloomingToolCall(event);
      const existing = this.activeToolCalls.get(event.toolName) ?? [];
      existing.push(toolCall);
      this.activeToolCalls.set(event.toolName, existing);
      this.hooks.onToolCall?.(toolCall);
      return;
    }

    if (event.type === 'tool_call_end') {
      const toolCall = this.activeToolCalls.get(event.toolName)?.shift() ?? toBloomingToolCall(event);
      toolCall.durationMs = event.durationMs;
      toolCall.result = event.result;
      toolCall.error = event.error;
      this.hooks.onToolResult?.(toolCall);
    }
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

function toBloomingToolCall(
  event: Extract<CapabilityEvent, { type: 'tool_call_start' | 'tool_call_end' }>,
): ToolCall {
  return {
    id: `aptkit-${event.toolName}-${event.timestamp}`,
    agent: 'recommendation',
    toolName: event.toolName,
    args: event.type === 'tool_call_start' && isRecord(event.args) ? event.args : {},
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
