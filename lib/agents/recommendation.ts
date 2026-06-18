import Anthropic from '@anthropic-ai/sdk';
import {
  RecommendationAgent as AptKitRecommendationAgent,
} from '@aptkit/core';
import type { McpCaller } from './base';
import {
  AnthropicModelProviderAdapter,
  BloomingToolRegistryAdapter,
  BloomingTraceSinkAdapter,
} from './aptkit-adapters';
import type { AgentHooks } from './diagnostic';
import type { McpToolDef } from './tool-schemas';
import type { Anomaly, Diagnosis, Recommendation } from '../mcp/types';
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
      model: new AnthropicModelProviderAdapter(this.anthropic, 'recommendation', this.sessionId),
      tools: new BloomingToolRegistryAdapter(this.dataSource, this.allTools),
      workspace: this.schema,
      trace: new BloomingTraceSinkAdapter(hooks, 'recommendation'),
    });

    return agent.propose(anomaly, diagnosis, { signal: hooks.signal });
  }
}
