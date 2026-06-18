import Anthropic from '@anthropic-ai/sdk';
import {
  AnomalyMonitoringAgent as AptKitAnomalyMonitoringAgent,
  type MonitoringAnomaly,
  type MonitoringAnomalyCategory,
} from '@aptkit/core';
import type { McpCaller } from './base';
import {
  AnthropicModelProviderAdapter,
  BloomingToolRegistryAdapter,
  BloomingTraceSinkAdapter,
} from './aptkit-adapters';
import type { McpToolDef } from './tool-schemas';
import type { AnomalyCategory } from './categories';
import type { Anomaly, CategoryId, ToolCall } from '../mcp/types';
import type { WorkspaceSchema } from '../mcp/schema';

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

/** Streaming hooks fired as the monitoring loop runs (used to stream live status
 *  to the feed). All optional; mirror AptKit's hook surface. The optional
 *  `signal` is threaded down to the AptKit loop so the route layer's `req.signal`
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
    const toolRegistry = new BloomingToolRegistryAdapter(this.dataSource, this.allTools);
    const agent = new AptKitAnomalyMonitoringAgent({
      model: new AnthropicModelProviderAdapter(this.anthropic, 'monitoring', this.sessionId),
      tools: toolRegistry,
      workspace: this.schema,
      trace: new BloomingTraceSinkAdapter(hooks ?? {}, 'monitoring'),
      categories: categories.length ? toAptKitCategories(categories, this.schema.projectId) : [],
    });

    return (await agent.scan({ signal: hooks?.signal })).map(toBloomingAnomaly);
  }
}

function toAptKitCategories(
  categories: AnomalyCategory[],
  projectId: string,
): MonitoringAnomalyCategory[] {
  return categories.map((category) => ({
    id: category.id,
    label: category.label,
    requires: category.requires,
    enriches: category.enriches,
    whyItMatters: category.whyItMatters,
    queryRecipe: category.eql(projectId),
    thresholds: category.thresholds,
  }));
}

function toBloomingAnomaly(anomaly: MonitoringAnomaly): Anomaly {
  return {
    ...anomaly,
    category: anomaly.category as CategoryId | undefined,
  };
}
