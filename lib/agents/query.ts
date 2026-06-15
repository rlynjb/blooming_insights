import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { McpCaller } from './base';
import { runAgentLoop, buildSynthesisInstruction } from './base';
import type { AgentHooks } from './diagnostic';
import { schemaSummary } from './monitoring';
import { filterToolSchemas, type McpToolDef } from './tool-schemas';
import { queryTools } from '../mcp/tools';
import type { Intent } from './intent';
import type { WorkspaceSchema } from '../mcp/schema';

const PROMPT = readFileSync(join(process.cwd(), 'lib/agents/prompts/query.md'), 'utf8');

export class QueryAgent {
  constructor(
    private anthropic: Anthropic,
    private mcp: McpCaller,
    private schema: WorkspaceSchema,
    private allTools: McpToolDef[],
    private sessionId?: string,
  ) {}

  /** Answer a free-form question; returns the final natural-language answer text. */
  async answer(query: string, intent: Intent, hooks: AgentHooks = {}): Promise<string> {
    const system = PROMPT
      .replace('{schema}', schemaSummary(this.schema))
      .replace(/\{project_id\}/g, this.schema.projectId)
      .replace(/\{intent\}/g, intent);

    const { finalText } = await runAgentLoop({
      anthropic: this.anthropic,
      mcp: this.mcp,
      agent: 'coordinator', // query answering is the coordinator surface
      system,
      userPrompt: query,
      toolSchemas: filterToolSchemas(this.allTools, queryTools),
      onToolCall: hooks.onToolCall,
      onText: hooks.onText,
      onToolResult: hooks.onToolResult,
      signal: hooks.signal,
      maxTurns: 8,
      maxToolCalls: 6,
      synthesisInstruction: buildSynthesisInstruction(
        'Now answer the user question directly and concisely ' +
          'in plain prose, citing the key numbers you found.',
      ),
      sessionId: this.sessionId,
    });

    return finalText.trim() || 'I was unable to find enough data to answer that question.';
  }
}
