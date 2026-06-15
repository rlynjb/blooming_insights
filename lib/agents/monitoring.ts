import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { McpCaller } from './base';
import { runAgentLoop, buildSynthesisInstruction } from './base';
import { filterToolSchemas, type McpToolDef } from './tool-schemas';
import { monitoringTools } from '../mcp/tools';
import type { AnomalyCategory } from './categories';
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

  // Synthetic datasets (Olist) ship with a known horizon — surface it inline
  // so the model anchors `time_range` to dates that actually exist, instead
  // of pulling 2017-2018 Kaggle dates from training memory.
  const horizonLine = schema.dataHorizon
    ? `Data horizon: ${schema.dataHorizon.from} → ${schema.dataHorizon.to} (${schema.dataHorizon.durationDays} days; \`to\` exclusive). ALL queries MUST land inside this window.`
    : null;

  return [
    `Project: ${schema.projectName} (${schema.projectId})`,
    `Total customers: ${schema.totalCustomers.toLocaleString()}`,
    `Total events: ${schema.totalEvents.toLocaleString()}`,
    `Oldest data: ${oldestDate}`,
    ...(horizonLine ? [horizonLine] : []),
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
 *  to the feed). All optional; mirror runAgentLoop's hook surface. The optional
 *  `signal` is threaded down to `runAgentLoop` so the route layer's `req.signal`
 *  cancels in-flight Anthropic + MCP calls when the client navigates away. */
export interface MonitorHooks {
  onToolCall?: (tc: ToolCall) => void;
  onToolResult?: (tc: ToolCall) => void;
  onText?: (t: string) => void;
  signal?: AbortSignal;
}

export class MonitoringAgent {
  constructor(
    private anthropic: Anthropic,
    private dataSource: McpCaller,
    private schema: WorkspaceSchema,
    private allTools: McpToolDef[],
    private sessionId?: string,
  ) {}

  async scan(hooks?: MonitorHooks, categories: AnomalyCategory[] = []): Promise<Anomaly[]> {
    // Build the runnable-category checklist injected into the prompt. The route
    // gates out unsupported categories first, so the agent never spends EQL
    // budget on a category this workspace's events can't support.
    const checklist = categories.length
      ? categories
          .map(
            (c) =>
              `- \`${c.id}\` (${c.label}) — ${c.whyItMatters} recipe: \`${c.eql(this.schema.projectId)}\`. ` +
              `flag when |Δ| ≥ ${c.thresholds.warning}% (critical ≥ ${c.thresholds.critical}%).`,
          )
          .join('\n')
      : '(no checklist provided — scan for any significant recent change)';

    const system = PROMPT
      .replace('{schema}', schemaSummary(this.schema))
      .replace(/\{project_id\}/g, this.schema.projectId)
      .replace('{categories}', checklist);

    const { finalText } = await runAgentLoop({
      anthropic: this.anthropic,
      dataSource: this.dataSource,
      agent: 'monitoring',
      system,
      userPrompt:
        'Work through your category checklist (each as 90d vs prior 90d) and return the anomaly ' +
        'JSON array — stamp each flagged anomaly with its `category`.',
      toolSchemas: filterToolSchemas(this.allTools, monitoringTools),
      onToolCall: hooks?.onToolCall,
      onToolResult: hooks?.onToolResult,
      onText: hooks?.onText,
      signal: hooks?.signal,
      maxTurns: 8,
      maxToolCalls: 6, // hard cap — bounds latency under the 1 req/s MCP limit
      synthesisInstruction: buildSynthesisInstruction(
        'Stop querying now and output your final answer. ' +
          'Respond with ONLY a JSON array of anomaly objects in a ```json fence (or [] if nothing ' +
          'meaningful), based on the data you have already gathered — anchored on revenue / ' +
          'order_count / payment_value over time, filtered by state / category / payment_type as ' +
          'relevant to the data shown.',
      ),
      sessionId: this.sessionId,
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
