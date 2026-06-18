import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { McpCaller } from './base';
import { runAgentLoop, buildSynthesisInstruction } from './base';
import { schemaSummary } from './monitoring';
import { filterToolSchemas, type McpToolDef } from './tool-schemas';
import { recommendationTools } from '../mcp/tools';
import { parseAgentJson, isRecommendationArray } from '../mcp/validate';
import type { AgentHooks } from './diagnostic';
import type { Anomaly, Diagnosis, Recommendation, ToolCall } from '../mcp/types';
import type { WorkspaceSchema } from '../mcp/schema';

const PROMPT = readFileSync(join(process.cwd(), 'lib/agents/prompts/recommendation.md'), 'utf8');

/** Recommendations as the agent emits them - id is assigned by us after validation. */
type IdlessRecommendation = Omit<Recommendation, 'id'>;

function tryParseRecommendations(text: string): IdlessRecommendation[] | null {
  try {
    const parsed = parseAgentJson(text);
    return isRecommendationArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Legacy Blooming implementation retained while the active adapter uses @aptkit/core. */
export class LegacyRecommendationAgent {
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
    const system = PROMPT
      .replace('{schema}', schemaSummary(this.schema))
      .replace(/\{project_id\}/g, this.schema.projectId)
      .replace('{diagnosis}', JSON.stringify(diagnosis));

    const { parsed: idless } = await runAgentLoop<IdlessRecommendation[]>({
      anthropic: this.anthropic,
      dataSource: this.dataSource,
      agent: 'recommendation',
      system,
      userPrompt: 'Propose recommendations for this diagnosis and return the JSON array.',
      toolSchemas: filterToolSchemas(this.allTools, recommendationTools),
      onToolCall: hooks.onToolCall,
      onText: hooks.onText,
      onToolResult: hooks.onToolResult,
      signal: hooks.signal,
      maxTurns: 6,
      maxToolCalls: 4,
      synthesisInstruction: buildSynthesisInstruction(
        'Stop querying now and output your final answer. ' +
          'Respond with ONLY a JSON array of at most 3 recommendation objects in a ```json fence ' +
          '(or [] if you cannot propose grounded actions), based on the diagnosis and the data you ' +
          'have already gathered. Do NOT include an id field.',
      ),
      sessionId: this.sessionId,
      parseResult: tryParseRecommendations,
      // The agent often keeps "wanting to query" instead of emitting JSON. If
      // the loop did not produce a valid recommendation array, the loop runs one
      // tool-less synthesis turn with this prompt: hands the model the diagnosis
      // plus the tool results it already gathered and asks for structured output.
      recoveryPrompt: (tc: ToolCall[]) => {
        const evidence =
          tc
            .map((c, i) => {
              const payload = c.error ? { error: c.error } : c.result;
              return `Query ${i + 1}: ${c.toolName} ${JSON.stringify(c.args).slice(0, 200)}\nResult: ${JSON.stringify(payload).slice(0, 900)}`;
            })
            .join('\n\n') || '(no existing-feature queries were completed)';
        return (
          `Anomaly that was diagnosed:\n${JSON.stringify(anomaly)}\n\n` +
          `Diagnosis to act on:\n${JSON.stringify(diagnosis)}\n\n` +
          `Existing-feature queries run and their results:\n${evidence}\n\n` +
          'Based on the diagnosis above, output your best 2-3 recommendations as a single JSON ' +
          'array in a ```json fence. Each object: {"title": string, "rationale": string, ' +
          '"bloomreachFeature": "scenario"|"segment"|"campaign"|"voucher"|"experiment", ' +
          '"steps": string[], "estimatedImpact": {"range": string, "rangeUsd"?: {"low": number, ' +
          '"high": number}, "assumption": string}, "effort": "low"|"medium"|"high", ' +
          '"timeToSetUpMinutes": number, "readResultInDays": number, "prerequisites": ' +
          '[{"label": string, "satisfied": boolean}], "successMetric": string, ' +
          '"confidence": "high"|"medium"|"low"}. Compute the dollar impact from the diagnosis\'s ' +
          'affected-customer count x AOV (revenue / purchase count from the evidence) x a ' +
          'reactivation % range. Order by predicted impact (highest first). Do NOT include an id ' +
          'field. If you cannot propose grounded actions, return []. Do NOT request more queries.'
        );
      },
    });

    if (!idless) return [];

    // Assign ids AFTER validation, cap at 3, and return the canonical shape.
    return idless.slice(0, 3).map((r) => ({ id: crypto.randomUUID(), ...r }));
  }
}
