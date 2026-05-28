import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { McpCaller } from './base';
import { runAgentLoop } from './base';
import { filterToolSchemas, type McpToolDef } from './tool-schemas';
import { monitoringTools } from '../mcp/tools';
import { parseAgentJson, isAnomalyArray } from '../mcp/validate';
import type { Anomaly, Severity, ToolCall } from '../mcp/types';
import type { WorkspaceSchema } from '../mcp/schema';

const PROMPT = readFileSync(join(process.cwd(), 'lib/agents/prompts/monitoring.md'), 'utf8');

/** Compact, token-bounded schema summary for the prompt (NOT the full 112KB schema). */
export function schemaSummary(schema: WorkspaceSchema): string {
  const oldestDate = schema.oldestTimestamp
    ? new Date(schema.oldestTimestamp).toISOString().slice(0, 10)
    : 'unknown';

  // Top 20 events, each capped at 10 properties
  const MAX_EVENTS = 20;
  const MAX_PROPS_PER_EVENT = 10;

  const eventsText = schema.events
    .slice(0, MAX_EVENTS)
    .map((e) => {
      const props = e.properties.slice(0, MAX_PROPS_PER_EVENT).join(', ');
      return `  - ${e.name} (${e.eventCount}): ${props || '(no properties)'}`;
    })
    .join('\n');

  // Customer properties, cap at 30
  const MAX_CPROPS = 30;
  const customerPropsText = schema.customerProperties.slice(0, MAX_CPROPS).join(', ');

  return [
    `Project: ${schema.projectName} (${schema.projectId})`,
    `Total customers: ${schema.totalCustomers.toLocaleString()}`,
    `Total events: ${schema.totalEvents.toLocaleString()}`,
    `Oldest data: ${oldestDate}`,
    `Catalogs: ${schema.catalogs.map((c) => c.name).join(', ') || 'none'}`,
    '',
    `Top events (name, eventCount: properties):`,
    eventsText,
    '',
    `Customer properties: ${customerPropsText}`,
  ].join('\n');
}

const SEV_RANK: Record<Severity, number> = { critical: 3, warning: 2, info: 1, positive: 0 };

/** Streaming hooks fired as the monitoring loop runs (used to stream live status
 *  to the feed). All optional; mirror runAgentLoop's hook surface. */
export interface MonitorHooks {
  onToolCall?: (tc: ToolCall) => void;
  onToolResult?: (tc: ToolCall) => void;
  onText?: (t: string) => void;
}

export class MonitoringAgent {
  constructor(
    private anthropic: Anthropic,
    private mcp: McpCaller,
    private schema: WorkspaceSchema,
    private allTools: McpToolDef[],
  ) {}

  async scan(hooks?: MonitorHooks): Promise<Anomaly[]> {
    const system = PROMPT
      .replace('{schema}', schemaSummary(this.schema))
      .replace(/\{project_id\}/g, this.schema.projectId);

    const { finalText } = await runAgentLoop({
      anthropic: this.anthropic,
      mcp: this.mcp,
      agent: 'monitoring',
      system,
      userPrompt: 'Scan the workspace for significant recent changes and return the anomaly JSON array.',
      toolSchemas: filterToolSchemas(this.allTools, monitoringTools),
      onToolCall: hooks?.onToolCall,
      onToolResult: hooks?.onToolResult,
      onText: hooks?.onText,
      maxTurns: 8,
      maxToolCalls: 6, // hard cap — bounds latency under the 1 req/s MCP limit
      synthesisInstruction:
        'You have NO more tool calls available. Stop querying now and output your final answer. ' +
        'Respond with ONLY a JSON array of anomaly objects in a ```json fence (or [] if nothing ' +
        'meaningful), based on the data you have already gathered. Do not say you need more queries.',
    });

    // Degrade gracefully: if the agent produced no parseable/valid anomaly array
    // (e.g. stale data with nothing recent to report, or it exhausted its call
    // budget mid-exploration), treat it as "no anomalies" rather than failing the
    // whole briefing. The route's `trace` still records what the agent did.
    let parsed: unknown;
    try {
      parsed = parseAgentJson(finalText);
    } catch {
      return [];
    }
    if (!isAnomalyArray(parsed)) return [];
    return [...parsed].sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity]).slice(0, 10);
  }
}
