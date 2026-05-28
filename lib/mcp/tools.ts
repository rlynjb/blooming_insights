// Per-agent MCP tool subsets. Each agent is granted only the tools relevant to
// its job (monitoring detects, diagnostic investigates, recommendation proposes).
// bootstrapTools are used once at session start for schema discovery.

export const monitoringTools = [
  'list_dashboards', 'get_dashboard',
  'list_trends', 'get_trend',
  'list_funnels', 'get_funnel',
  'list_running_aggregates', 'get_running_aggregate',
  'list_reports', 'get_report',
  'execute_analytics', 'execute_analytics_eql',
  'get_customer_prediction_score',
] as const;

export const diagnosticTools = [
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

export const recommendationTools = [
  'list_scenarios', 'get_scenario',
  'list_initiatives', 'get_initiative_items',
  'list_recommendations', 'get_recommendation',
  'list_segmentations', 'list_email_campaigns',
  'list_voucher_pools',
  'get_frequency_policies',
] as const;

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
