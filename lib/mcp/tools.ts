// Per-agent MCP tool subsets. Each agent is granted only the tools relevant to
// its job (monitoring detects, diagnostic investigates, recommendation proposes).
// bootstrapTools are used once at session start for schema discovery.
//
// Both adapters' tool catalogs are listed in one set per agent — the agent runs
// against whichever adapter the route picked, and `filterToolSchemas` only
// surfaces the tools actually present in `listTools()`. Mixing names is safe:
// the Bloomreach server will never advertise `get_metric_timeseries` and the
// Olist server will never advertise `execute_analytics_eql`.

// Bloomreach (EQL-shaped) ↓
const monitoringToolsBloomreach = [
  'list_dashboards', 'get_dashboard',
  'list_trends', 'get_trend',
  'list_funnels', 'get_funnel',
  'list_running_aggregates', 'get_running_aggregate',
  'list_reports', 'get_report',
  'execute_analytics', 'execute_analytics_eql',
  'get_customer_prediction_score',
] as const;

const diagnosticToolsBloomreach = [
  'execute_analytics', 'execute_analytics_eql',
  'get_funnel', 'get_event_segmentation',
  'list_customers', 'list_customer_events',
  'list_customers_in_segment', 'list_segmentations',
  'list_email_campaigns', 'list_sms_campaigns',
  'list_in_app_messages', 'list_banners',
  'list_experiments', 'list_scenarios',
  'list_catalog_items', 'get_catalog_item',
  'get_customer_prediction_score',
] as const;

const recommendationToolsBloomreach = [
  'list_scenarios', 'get_scenario',
  'list_initiatives', 'get_initiative_items',
  'list_recommendations', 'get_recommendation',
  'list_segmentations', 'list_email_campaigns',
  'list_voucher_pools',
  'get_frequency_policies',
] as const;

// Olist (SQL-backed) — three domain tools the mcp-server-olist server exposes.
// `get_metric_timeseries` for trends, `get_segments` for discovery,
// `get_anomaly_context` for the diagnostic loop's evidence gathering. The
// recommendation agent has no Olist-side tool catalog — recommendations are
// derived from the diagnosis text alone (the existing-feature checks were a
// Bloomreach-specific affordance).
const olistTools = ['get_metric_timeseries', 'get_segments', 'get_anomaly_context'] as const;

export const monitoringTools = [...monitoringToolsBloomreach, ...olistTools] as const;
export const diagnosticTools = [...diagnosticToolsBloomreach, ...olistTools] as const;
export const recommendationTools = [...recommendationToolsBloomreach, ...olistTools] as const;

// Broad, de-duplicated union granted to the free-form query agent so it can
// answer anything (monitoring + diagnostic + recommendation surfaces combined).
export const queryTools = [
  ...new Set<string>([...monitoringTools, ...diagnosticTools, ...recommendationTools]),
] as const;

// The exact tools the bootstrap path calls (see lib/mcp/schema.ts):
//   resolveProject  → list_cloud_organizations, list_projects
//   bootstrapSchema → get_event_schema, get_customer_property_schema,
//                     list_catalogs, get_project_overview
// `whoami`, `get_customer_schema`, and `get_mapping` were listed here
// historically but are never called — removed to keep the list honest.
// Cross-check every name against the live server with lib/mcp/tool-coverage.ts
// (exposed at GET /api/mcp/tools/check).
export const bootstrapTools = [
  'list_cloud_organizations', 'list_projects',
  'get_event_schema', 'get_customer_property_schema',
  'list_catalogs', 'get_project_overview',
] as const;
