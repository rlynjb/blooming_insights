import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { McpCaller } from './base-legacy';
import { runAgentLoop, buildSynthesisInstruction } from './base-legacy';
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
  /** Cancellation signal threaded from the route's `req.signal` down through
   *  `runAgentLoop` to Anthropic and MCP. Optional — existing callers compile
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
    const system = PROMPT
      .replace('{schema}', schemaSummary(this.schema))
      .replace(/\{project_id\}/g, this.schema.projectId)
      .replace('{anomaly}', JSON.stringify(anomaly));

    const { toolCalls, parsed } = await runAgentLoop<Diagnosis>({
      anthropic: this.anthropic,
      dataSource: this.dataSource,
      agent: 'diagnostic',
      system,
      userPrompt: 'Investigate the anomaly and return the diagnosis JSON object.',
      toolSchemas: filterToolSchemas(this.allTools, diagnosticTools),
      onToolCall: hooks.onToolCall,
      onText: hooks.onText,
      onToolResult: hooks.onToolResult,
      signal: hooks.signal,
      maxTurns: 8,
      maxToolCalls: 6,
      synthesisInstruction: buildSynthesisInstruction(
        'Stop investigating now and output your final answer. ' +
          'Respond with ONLY a single JSON object in a ```json fence matching the diagnosis shape ' +
          '(conclusion, evidence, hypothesesConsidered). Base it on the evidence you have already gathered — ' +
          'when the data source is the SQL-backed `get_anomaly_context` tool, ground your evidence in its ' +
          '`pct_change` and `related_segments` fields. State your best-supported explanation, even if partial.',
      ),
      sessionId: this.sessionId,
      parseResult: tryParseDiagnosis,
      // The agent often keeps "wanting to query" instead of emitting JSON. If
      // the loop didn't produce a valid diagnosis, the loop runs one tool-less
      // synthesis turn with this prompt — hands the model the evidence it
      // already gathered and asks for the structured conclusion only.
      recoveryPrompt: (tc: ToolCall[]) => {
        const evidence =
          tc
            .map((c, i) => {
              const payload = c.error ? { error: c.error } : c.result;
              return `Query ${i + 1}: ${c.toolName} ${JSON.stringify(c.args).slice(0, 200)}\nResult: ${JSON.stringify(payload).slice(0, 900)}`;
            })
            .join('\n\n') || '(no successful queries were completed)';
        return (
          `Anomaly investigated:\n${JSON.stringify(anomaly)}\n\n` +
          `Queries run and their results:\n${evidence}\n\n` +
          'Based ONLY on the evidence above, output your best-supported diagnosis as a single JSON ' +
          'object in a ```json fence: {"conclusion": string, "evidence": string[], ' +
          '"hypothesesConsidered": [{"hypothesis": string, "supported": boolean, "reasoning": string}]}. ' +
          'Give a concrete conclusion grounded in the numbers you actually saw. If the data was ' +
          'inconclusive (e.g. recent windows empty / historical data), say specifically what was ' +
          'inconclusive and what you ruled out. Do NOT request more queries.'
        );
      },
    });

    const diag = parsed ?? FALLBACK;

    // Derive confidence from how thoroughly hypotheses were tested; downgrade a
    // "high" to "medium" when some queries errored (rate limits) so the surfaced
    // confidence reflects the data we actually got.
    const confidence = diagnosisConfidence(diag);
    const hadErrors = toolCalls.some((tc) => tc.error);
    return { ...diag, confidence: confidence === 'high' && hadErrors ? 'medium' : confidence };
  }
}
