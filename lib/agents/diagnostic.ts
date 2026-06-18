import Anthropic from '@anthropic-ai/sdk';
import {
  DiagnosticInvestigationAgent as AptKitDiagnosticInvestigationAgent,
  type DiagnosticDiagnosis,
} from '@aptkit/core';
import type { McpCaller } from './base';
import {
  AnthropicModelProviderAdapter,
  BloomingToolRegistryAdapter,
  BloomingTraceSinkAdapter,
} from './aptkit-adapters';
import type { McpToolDef } from './tool-schemas';
import type { Anomaly, Diagnosis, ToolCall } from '../mcp/types';
import type { WorkspaceSchema } from '../mcp/schema';

export interface AgentHooks {
  onToolCall?: (tc: ToolCall) => void;
  onText?: (text: string) => void;
  onToolResult?: (tc: ToolCall) => void;
  /** Cancellation signal threaded from the route's `req.signal` down through
   *  AptKit's agent loop to Anthropic and MCP. Optional — existing callers compile
   *  + pass unchanged. */
  signal?: AbortSignal;
}

export class DiagnosticAgent {
  constructor(
    private anthropic: Anthropic,
    private dataSource: McpCaller,
    private schema: WorkspaceSchema,
    private allTools: McpToolDef[],
    private sessionId?: string,
  ) {}

  async investigate(anomaly: Anomaly, hooks: AgentHooks = {}): Promise<Diagnosis> {
    const agent = new AptKitDiagnosticInvestigationAgent({
      model: new AnthropicModelProviderAdapter(this.anthropic, 'diagnostic', this.sessionId),
      tools: new BloomingToolRegistryAdapter(this.dataSource, this.allTools),
      workspace: this.schema,
      trace: new BloomingTraceSinkAdapter(hooks, 'diagnostic'),
    });

    return toBloomingDiagnosis(await agent.investigate(anomaly, { signal: hooks.signal }));
  }
}

function toBloomingDiagnosis(diagnosis: DiagnosticDiagnosis): Diagnosis {
  return diagnosis;
}
