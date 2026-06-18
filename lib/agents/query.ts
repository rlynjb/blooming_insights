import Anthropic from '@anthropic-ai/sdk';
import { QueryAgent as AptKitQueryAgent } from '@aptkit/core';
import type { McpCaller } from './base';
import {
  AnthropicModelProviderAdapter,
  BloomingToolRegistryAdapter,
  BloomingTraceSinkAdapter,
} from './aptkit-adapters';
import type { AgentHooks } from './diagnostic';
import type { McpToolDef } from './tool-schemas';
import type { Intent } from './intent';
import type { WorkspaceSchema } from '../mcp/schema';

export class QueryAgent {
  constructor(
    private anthropic: Anthropic,
    private dataSource: McpCaller,
    private schema: WorkspaceSchema,
    private allTools: McpToolDef[],
    private sessionId?: string,
  ) {}

  /** Answer a free-form question; returns the final natural-language answer text. */
  async answer(query: string, intent: Intent, hooks: AgentHooks = {}): Promise<string> {
    const agent = new AptKitQueryAgent({
      model: new AnthropicModelProviderAdapter(this.anthropic, 'coordinator', this.sessionId),
      tools: new BloomingToolRegistryAdapter(this.dataSource, this.allTools),
      workspace: this.schema,
      trace: new BloomingTraceSinkAdapter(hooks, 'coordinator'),
    });

    return agent.answer(query, { intent, signal: hooks.signal });
  }
}
