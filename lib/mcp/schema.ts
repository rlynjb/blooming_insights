import type { McpClient } from './client';

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

export async function resolveProject(
  mcp: McpClient,
): Promise<{ projectId: string; projectName: string }> {
  const orgs = unwrap<{ data: { id: string; name: string }[] }>(
    (await mcp.callTool('list_cloud_organizations', {})).result,
  ).data;
  if (!orgs?.length) throw new Error('no cloud organizations for this user');

  const projects = unwrap<{ data: { id: string; name: string }[] }>(
    (await mcp.callTool('list_projects', { cloud_organization_id: orgs[0].id }))
      .result,
  ).data;
  if (!projects?.length) throw new Error('no projects in organization');

  const pinned = process.env.BLOOMREACH_PROJECT_ID;
  const project =
    (pinned && projects.find((p) => p.id === pinned)) || projects[0];
  return { projectId: project.id, projectName: project.name };
}

export async function bootstrapSchema(
  mcp: McpClient,
): Promise<WorkspaceSchema> {
  if (cached) return cached;
  const { projectId, projectName } = await resolveProject(mcp);
  const args = { project_id: projectId };

  // Sequential — the server allows ~1 req/s; McpClient already spaces calls.
  const eventSchema = (await mcp.callTool('get_event_schema', args)).result;
  const customerProps = (
    await mcp.callTool('get_customer_property_schema', args)
  ).result;
  const catalogs = (await mcp.callTool('list_catalogs', args)).result;
  const overview = (await mcp.callTool('get_project_overview', args)).result;

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
