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
   * `undefined` for live Bloomreach workspaces where the bound is open-ended.
   * Prompts that interpolate `{schema}` read this to anchor `time_range`
   * windows inside the populated horizon when the field is present.
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

