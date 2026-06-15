import type { DataSource } from '../data-source/types';
import { McpToolError } from '../data-source/bloomreach-data-source';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface WorkspaceSchema {
  projectId: string;
  projectName: string;
  /** Events sorted by eventCount descending (most active first). */
  events: { name: string; properties: string[]; eventCount: number }[];
  customerProperties: string[];
  catalogs: { id: string; name: string }[];
  totalCustomers: number;
  totalEvents: number;
  oldestTimestamp: number | null;
  /**
   * Inclusive `from`, exclusive `to` ISO dates bounding the data — when known.
   * Present for synthetic datasets (Olist) where we control the seed window;
   * `undefined` for live Bloomreach workspaces where the bound is open-ended.
   * Prompts that interpolate `{schema}` read this to anchor `time_range`
   * windows inside the populated horizon instead of hallucinating dates from
   * training memory.
   */
  dataHorizon?: { from: string; to: string; durationDays: number };
}

// ---------------------------------------------------------------------------
// Result unwrap helper
// ---------------------------------------------------------------------------

/**
 * Unwrap a raw tool result envelope.
 * Prefers `structuredContent` when present and non-null;
 * otherwise parses `content[0].text` as JSON.
 */
export function unwrap<T = any>(result: unknown): T {
  const r = result as Record<string, any>;
  if (r?.structuredContent != null) {
    return r.structuredContent as T;
  }
  const text: string = r?.content?.[0]?.text;
  return JSON.parse(text) as T;
}

// ---------------------------------------------------------------------------
// Pure parser (TDD-tested against real fixtures)
// ---------------------------------------------------------------------------

interface EventSchemaPayload {
  events?: Array<{
    type: string;
    properties?: {
      default_group?: {
        properties?: Array<{ property: string }>;
      };
    };
  }>;
}

interface CustomerPropsPayload {
  properties?: Array<{ property: string }>;
}

interface CatalogsPayload {
  data?: Array<{ _id: string; name: string }>;
}

interface OverviewPayload {
  data?: {
    events?: number;
    total_customers?: number;
    oldest_timestamp?: number | null;
    event_types_overview?: Record<string, { event_count: number }>;
  };
}

/**
 * Pure function: build a WorkspaceSchema from the raw tool results plus the
 * resolved project id/name. Robust to empty arrays and missing fields.
 */
export function parseWorkspaceSchema(input: {
  projectId: string;
  projectName: string;
  eventSchema: unknown;
  customerProps: unknown;
  catalogs: unknown;
  overview: unknown;
}): WorkspaceSchema {
  const { projectId, projectName } = input;

  const eventPayload = unwrap<EventSchemaPayload>(input.eventSchema);
  const customerPayload = unwrap<CustomerPropsPayload>(input.customerProps);
  const catalogsPayload = unwrap<CatalogsPayload>(input.catalogs);
  const overviewPayload = unwrap<OverviewPayload>(input.overview);

  const overviewData = overviewPayload?.data ?? {};
  const eventTypesOverview = overviewData.event_types_overview ?? {};

  const events = (eventPayload?.events ?? [])
    .map((e) => ({
      name: e.type,
      properties: (e.properties?.default_group?.properties ?? []).map(
        (p) => p.property,
      ),
      eventCount: eventTypesOverview[e.type]?.event_count ?? 0,
    }))
    .sort((a, b) => b.eventCount - a.eventCount);

  const customerProperties = (customerPayload?.properties ?? []).map(
    (p) => p.property,
  );

  const catalogs = (catalogsPayload?.data ?? []).map((c) => ({
    id: c._id,
    name: c.name,
  }));

  const totalCustomers = overviewData.total_customers ?? 0;
  const totalEvents = overviewData.events ?? 0;
  const oldestTimestamp = overviewData.oldest_timestamp ?? null;

  return {
    projectId,
    projectName,
    events,
    customerProperties,
    catalogs,
    totalCustomers,
    totalEvents,
    oldestTimestamp,
  };
}

// ---------------------------------------------------------------------------
// Live orchestrator (integration — not unit-tested; depends on network)
// ---------------------------------------------------------------------------

let cached: WorkspaceSchema | null = null;

/** Optional per-call options threaded down to the MCP client. Today carries
 *  only an AbortSignal so the route layer's `req.signal` can cancel an
 *  in-flight bootstrap call when the client navigates away. */
export interface BootstrapOpts {
  signal?: AbortSignal;
}

/** Call a bootstrap tool and surface an error envelope (`isError`) as a tagged
 *  McpToolError carrying the server's text — otherwise `unwrap` fails later with
 *  a cryptic JSON parse error that hides which tool returned what. */
async function callOrThrow(
  dataSource: DataSource,
  name: string,
  args: Record<string, unknown>,
  opts: BootstrapOpts = {},
): Promise<unknown> {
  const { result } = await dataSource.callTool(name, args, { signal: opts.signal });
  const r = result as { isError?: boolean; content?: Array<{ text?: string }> } | null;
  if (r && r.isError === true) {
    const text =
      (r.content ?? []).map((c) => c?.text).filter(Boolean).join(' ') || 'tool returned an error';
    throw new McpToolError(name, text);
  }
  return result;
}

export async function resolveProject(
  dataSource: DataSource,
  opts: BootstrapOpts = {},
): Promise<{ projectId: string; projectName: string }> {
  const orgs = unwrap<{ data: { id: string; name: string }[] }>(
    await callOrThrow(dataSource, 'list_cloud_organizations', {}, opts),
  ).data;
  if (!orgs?.length) throw new Error('no cloud organizations for this user');

  const projects = unwrap<{ data: { id: string; name: string }[] }>(
    await callOrThrow(dataSource, 'list_projects', { cloud_organization_id: orgs[0].id }, opts),
  ).data;
  if (!projects?.length) throw new Error('no projects in organization');

  const pinned = process.env.BLOOMREACH_PROJECT_ID;
  const project =
    (pinned && projects.find((p) => p.id === pinned)) || projects[0];
  return { projectId: project.id, projectName: project.name };
}

export async function bootstrapSchema(
  dataSource: DataSource,
  opts: BootstrapOpts = {},
): Promise<WorkspaceSchema> {
  if (cached) return cached;
  const { projectId, projectName } = await resolveProject(dataSource, opts);
  const args = { project_id: projectId };

  // Sequential — the server allows ~1 req/s; BloomreachDataSource already spaces calls.
  const eventSchema = await callOrThrow(dataSource, 'get_event_schema', args, opts);
  const customerProps = await callOrThrow(dataSource, 'get_customer_property_schema', args, opts);
  const catalogs = await callOrThrow(dataSource, 'list_catalogs', args, opts);
  const overview = await callOrThrow(dataSource, 'get_project_overview', args, opts);

  cached = parseWorkspaceSchema({
    projectId,
    projectName,
    eventSchema,
    customerProps,
    catalogs,
    overview,
  });
  return cached;
}

export function _resetSchemaCache(): void {
  cached = null;
}

/**
 * Synthesized WorkspaceSchema for the Olist (`live-sql`) mode. The Bloomreach
 * bootstrap path (`bootstrapSchema`) calls `list_cloud_organizations` /
 * `get_event_schema` / etc. — tools the Olist server doesn't expose. Rather
 * than build a parallel orchestrator over Olist's three tools, we hand the
 * agents a fixed, prompt-shaped schema describing Brazilian e-commerce
 * dimensions (state / category / payment_type) in the same shape the
 * Bloomreach path produces. The numeric totals are placeholders — agents only
 * surface them in passing copy ("X customers in the workspace"), and the
 * `schemaSummary` formatter handles missing values gracefully.
 *
 * Returned NOT through the module-level `cached` slot — that slot is keyed
 * implicitly by mode (Bloomreach uses it, Olist doesn't) and mixing them
 * would corrupt the schema across mode toggles.
 */
export function olistWorkspaceSchema(): WorkspaceSchema {
  return {
    projectId: 'olist',
    projectName: 'Olist · Brazilian e-commerce (local MCP)',
    // Three "events" describe the available metric/dimension axes — the agents
    // read these in `schemaSummary` to know what they can filter on. Names are
    // SQL-ish (the underlying mcp-server-olist exposes get_metric_timeseries,
    // get_segments, get_anomaly_context) so the model never reaches for EQL.
    events: [
      {
        name: 'order',
        properties: ['state', 'category', 'payment_type', 'purchase_ts', 'price_brl'],
        eventCount: 0,
      },
      {
        name: 'payment',
        properties: ['type', 'installments', 'value_brl'],
        eventCount: 0,
      },
      {
        name: 'review',
        properties: ['score', 'ts'],
        eventCount: 0,
      },
    ],
    customerProperties: ['state', 'city'],
    catalogs: [],
    totalCustomers: 0,
    totalEvents: 0,
    oldestTimestamp: null,
    // The synthetic Olist dataset is seeded with a fixed horizon (see
    // mcp-server-olist/scripts/seed-olist.ts: END_TS = 2026-06-01 UTC,
    // START_TS = END_TS − 26 weeks = 2025-12-01). Hard-coded because we
    // own the seed; agents key off this to keep `time_range` inside the
    // populated window instead of guessing 2017–2018 Kaggle dates.
    dataHorizon: {
      from: '2025-12-01',
      to: '2026-06-01',
      durationDays: 182,
    },
  };
}
