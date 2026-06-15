import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { McpCaller } from './base';
import { runAgentLoop, AGENT_MODEL } from './base';
import { schemaSummary } from './monitoring';
import { filterToolSchemas, type McpToolDef } from './tool-schemas';
import { diagnosticTools } from '../mcp/tools';
import { parseAgentJson, isDiagnosis } from '../mcp/validate';
import { diagnosisConfidence } from '../insights/derive';
import type { Anomaly, Diagnosis, ToolCall } from '../mcp/types';
import type { WorkspaceSchema } from '../mcp/schema';

const PROMPT = readFileSync(join(process.cwd(), 'lib/agents/prompts/diagnostic.md'), 'utf8');

const FALLBACK: Diagnosis = {
  conclusion: 'Insufficient data to determine a cause for this change.',
  evidence: [],
  hypothesesConsidered: [],
};

function tryParseDiagnosis(text: string): Diagnosis | null {
  try {
    const parsed = parseAgentJson(text);
    return isDiagnosis(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

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

    const { finalText, toolCalls } = await runAgentLoop({
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
      synthesisInstruction:
        'You have NO more tool calls available. Stop investigating now and output your final answer. ' +
        'Respond with ONLY a single JSON object in a ```json fence matching the diagnosis shape ' +
        '(conclusion, evidence, hypothesesConsidered). Base it on the evidence you have already gathered — ' +
        'state your best-supported explanation, even if partial. Do not say you need more queries.',
    });

    // The agent often keeps "wanting to query" instead of emitting JSON. If the
    // loop didn't produce a valid diagnosis, run a dedicated tool-less synthesis
    // call that hands the model the evidence it already gathered and asks for the
    // structured conclusion only.
    const diag =
      tryParseDiagnosis(finalText) ?? (await this.synthesize(anomaly, toolCalls)) ?? FALLBACK;

    // Derive confidence from how thoroughly hypotheses were tested; downgrade a
    // "high" to "medium" when some queries errored (rate limits) so the surfaced
    // confidence reflects the data we actually got.
    const confidence = diagnosisConfidence(diag);
    const hadErrors = toolCalls.some((tc) => tc.error);
    return { ...diag, confidence: confidence === 'high' && hadErrors ? 'medium' : confidence };
  }

  /** Dedicated, tool-less call that turns the gathered query results into a
   *  structured Diagnosis. Returns null on any failure (caller falls back). */
  private async synthesize(anomaly: Anomaly, toolCalls: ToolCall[]): Promise<Diagnosis | null> {
    try {
      const evidence =
        toolCalls
          .map((tc, i) => {
            const payload = tc.error ? { error: tc.error } : tc.result;
            return `Query ${i + 1}: ${tc.toolName} ${JSON.stringify(tc.args).slice(0, 200)}\nResult: ${JSON.stringify(payload).slice(0, 900)}`;
          })
          .join('\n\n') || '(no successful queries were completed)';

      const res = await this.anthropic.messages.create({
        model: AGENT_MODEL,
        max_tokens: 2048,
        system:
          'You are concluding a completed investigation. Output ONLY a JSON diagnosis. Never ask for more data.',
        messages: [
          {
            role: 'user',
            content:
              `Anomaly investigated:\n${JSON.stringify(anomaly)}\n\n` +
              `Queries run and their results:\n${evidence}\n\n` +
              'Based ONLY on the evidence above, output your best-supported diagnosis as a single JSON ' +
              'object in a ```json fence: {"conclusion": string, "evidence": string[], ' +
              '"hypothesesConsidered": [{"hypothesis": string, "supported": boolean, "reasoning": string}]}. ' +
              'Give a concrete conclusion grounded in the numbers you actually saw. If the data was ' +
              'inconclusive (e.g. recent windows empty / historical data), say specifically what was ' +
              'inconclusive and what you ruled out. Do NOT request more queries.',
          },
        ],
      } as Anthropic.Messages.MessageCreateParamsNonStreaming);
      // TODO: thread sessionId once DiagnosticAgent carries it (would require touching the route caller).
      console.log(JSON.stringify({ site: 'agents/diagnostic:synthesize', usage: res.usage }));

      const text = res.content
        .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');
      return tryParseDiagnosis(text);
    } catch {
      return null;
    }
  }
}
