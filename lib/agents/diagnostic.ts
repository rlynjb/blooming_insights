import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { McpCaller } from './base';
import { runAgentLoop } from './base';
import { schemaSummary } from './monitoring';
import { filterToolSchemas, type McpToolDef } from './tool-schemas';
import { diagnosticTools } from '../mcp/tools';
import { parseAgentJson, isDiagnosis } from '../mcp/validate';
import type { Anomaly, Diagnosis, ToolCall } from '../mcp/types';
import type { WorkspaceSchema } from '../mcp/schema';

const PROMPT = readFileSync(join(process.cwd(), 'lib/agents/prompts/diagnostic.md'), 'utf8');

export interface AgentHooks {
  onToolCall?: (tc: ToolCall) => void;
  onText?: (text: string) => void;
  onToolResult?: (tc: ToolCall) => void;
}

export class DiagnosticAgent {
  constructor(
    private anthropic: Anthropic,
    private mcp: McpCaller,
    private schema: WorkspaceSchema,
    private allTools: McpToolDef[],
  ) {}

  async investigate(anomaly: Anomaly, hooks: AgentHooks = {}): Promise<Diagnosis> {
    const system = PROMPT
      .replace('{schema}', schemaSummary(this.schema))
      .replace(/\{project_id\}/g, this.schema.projectId)
      .replace('{anomaly}', JSON.stringify(anomaly));

    const { finalText } = await runAgentLoop({
      anthropic: this.anthropic,
      mcp: this.mcp,
      agent: 'diagnostic',
      system,
      userPrompt: 'Investigate the anomaly and return the diagnosis JSON object.',
      toolSchemas: filterToolSchemas(this.allTools, diagnosticTools),
      onToolCall: hooks.onToolCall,
      onText: hooks.onText,
      onToolResult: hooks.onToolResult,
      maxTurns: 8,
      maxToolCalls: 6,
    });

    // Graceful: if the agent didn't produce a valid diagnosis, return an honest fallback
    let parsed: unknown;
    try {
      parsed = parseAgentJson(finalText);
    } catch {
      parsed = null;
    }
    if (!isDiagnosis(parsed)) {
      return {
        conclusion: 'Insufficient data to determine a cause for this change.',
        evidence: [],
        hypothesesConsidered: [],
      };
    }
    return parsed;
  }
}
