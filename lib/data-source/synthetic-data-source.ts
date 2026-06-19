import {
  bootstrapTools,
  diagnosticTools,
  monitoringTools,
  queryTools,
  recommendationTools,
} from '../mcp/tools';
import type { WorkspaceSchema } from '../mcp/schema';
import type {
  DataSource,
  DataSourceCallOptions,
  DataSourceCallResult,
  DataSourceListOptions,
  ToolDef,
  ToolResult,
} from './types';

type SyntheticEvent = WorkspaceSchema['events'][number];

const PROJECT_ID = 'synthetic-blooming-project';
const PROJECT_NAME = 'Synthetic Blooming Workspace';

const syntheticEvents: SyntheticEvent[] = [
  {
    name: 'purchase',
    eventCount: 52_840,
    properties: [
      'total_price',
      'product_id',
      'category',
      'payment_type',
      'state',
      'campaign_id',
      'voucher_code',
      'inventory_level',
    ],
  },
  {
    name: 'view_item',
    eventCount: 241_900,
    properties: ['product_id', 'category', 'state', 'device_type', 'referrer'],
  },
  {
    name: 'session_start',
    eventCount: 198_400,
    properties: ['device_type', 'state', 'utm_source', 'campaign_id', 'landing_page'],
  },
  {
    name: 'cart_update',
    eventCount: 91_360,
    properties: ['product_id', 'category', 'quantity', 'cart_value', 'state'],
  },
  {
    name: 'checkout',
    eventCount: 73_610,
    properties: ['checkout_step', 'payment_type', 'cart_value', 'device_type', 'state'],
  },
  {
    name: 'search',
    eventCount: 44_220,
    properties: ['query', 'result_count', 'category', 'device_type'],
  },
  {
    name: 'email_open',
    eventCount: 38_540,
    properties: ['campaign_id', 'subject', 'segment_id'],
  },
  {
    name: 'voucher_redeemed',
    eventCount: 9_420,
    properties: ['voucher_code', 'voucher_pool_id', 'discount_amount', 'order_id'],
  },
  {
    name: 'return',
    eventCount: 4_860,
    properties: ['product_id', 'category', 'reason', 'order_id', 'state'],
  },
  {
    name: 'payment_failure',
    eventCount: 2_360,
    properties: ['payment_type', 'failure_reason', 'cart_value', 'device_type'],
  },
];

export const syntheticWorkspaceSchema: WorkspaceSchema = {
  projectId: PROJECT_ID,
  projectName: PROJECT_NAME,
  events: syntheticEvents,
  customerProperties: [
    'state',
    'city',
    'lifecycle_stage',
    'loyalty_tier',
    'email_opt_in',
    'sms_opt_in',
    'device_type',
    'last_purchase_at',
    'predicted_churn_risk',
  ],
  catalogs: [
    { id: 'products', name: 'products' },
    { id: 'inventory_level', name: 'inventory_level' },
  ],
  totalCustomers: 126_420,
  totalEvents: 757_710,
  oldestTimestamp: Date.UTC(2025, 11, 1),
  dataHorizon: { from: '2025-12-01', to: '2026-06-01', durationDays: 182 },
};

const toolNames = [
  ...new Set<string>([
    ...bootstrapTools,
    ...monitoringTools,
    ...diagnosticTools,
    ...recommendationTools,
    ...queryTools,
  ]),
];

const toolDescriptions: Record<string, string> = {
  list_cloud_organizations: 'List the cloud organizations available to the current user.',
  list_projects: 'List Bloomreach projects in a cloud organization.',
  get_event_schema: 'Return event names and event properties for a project.',
  get_customer_property_schema: 'Return customer profile properties for a project.',
  list_catalogs: 'List product and inventory catalogs for a project.',
  get_project_overview: 'Return total events, customers, oldest timestamp, and event counts.',
  execute_analytics: 'Run a synthetic aggregate analytics query over the workspace.',
  execute_analytics_eql: 'Run a synthetic EQL-style analytics query over the workspace.',
  list_customers: 'List representative synthetic customers matching a segment.',
  list_customer_events: 'List recent events for a synthetic customer.',
  list_customers_in_segment: 'List synthetic customers in a named segment.',
  list_segmentations: 'List reusable audience segments.',
  list_email_campaigns: 'List active email campaigns.',
  list_sms_campaigns: 'List active SMS campaigns.',
  list_in_app_messages: 'List active in-app messages.',
  list_banners: 'List active banner placements.',
  list_experiments: 'List active experiments.',
  list_scenarios: 'List automation scenarios.',
  get_scenario: 'Return one automation scenario.',
  list_catalog_items: 'List synthetic catalog items.',
  get_catalog_item: 'Return one synthetic catalog item.',
  list_initiatives: 'List commercial initiatives available for recommendations.',
  get_initiative_items: 'Return items attached to a commercial initiative.',
  list_recommendations: 'List existing Bloomreach recommendations.',
  get_recommendation: 'Return one existing Bloomreach recommendation.',
  list_voucher_pools: 'List active voucher pools.',
  get_frequency_policies: 'List contact frequency policies.',
  get_customer_prediction_score: 'Return a synthetic prediction score summary.',
  get_funnel: 'Return a synthetic funnel definition and current conversion metrics.',
  get_event_segmentation: 'Return a synthetic event segmentation breakdown.',
};

const toolDefs: ToolDef[] = toolNames.map((name) => ({
  name,
  description: toolDescriptions[name] ?? `Synthetic implementation of ${name}.`,
  inputSchema: {
    type: 'object',
    properties: {
      project_id: {
        type: 'string',
        description: 'Bloomreach project id. Optional for the local synthetic source.',
      },
    },
    additionalProperties: true,
  },
}));

const catalogItems = [
  {
    id: 'sku-coffee-subscription',
    name: 'Coffee subscription bundle',
    category: 'grocery',
    price: 49,
    inventory_level: 18,
    margin: 0.31,
  },
  {
    id: 'sku-skincare-trial',
    name: 'Skincare trial kit',
    category: 'beauty',
    price: 36,
    inventory_level: 420,
    margin: 0.42,
  },
  {
    id: 'sku-running-shoe',
    name: 'Road running shoe',
    category: 'sporting_goods',
    price: 118,
    inventory_level: 64,
    margin: 0.28,
  },
];

const segments = [
  {
    id: 'seg-high-value-at-risk',
    name: 'High value customers at risk',
    size: 4_820,
    criteria: 'loyalty_tier in gold/platinum and predicted_churn_risk > 0.72',
  },
  {
    id: 'seg-checkout-abandoners',
    name: 'Recent checkout abandoners',
    size: 9_340,
    criteria: 'checkout in last 7 days and no purchase after checkout',
  },
  {
    id: 'seg-mobile-sp',
    name: 'Mobile shoppers in Sao Paulo',
    size: 13_980,
    criteria: 'device_type = mobile and state = SP',
  },
];

const scenarios = [
  {
    id: 'scn-checkout-recovery',
    name: 'Checkout recovery sequence',
    status: 'paused',
    trigger: 'checkout without purchase for 2 hours',
    channel: 'email + in-app',
  },
  {
    id: 'scn-winback-high-value',
    name: 'High value winback',
    status: 'active',
    trigger: 'predicted_churn_risk rises above 0.70',
    channel: 'email',
  },
];

const campaigns = [
  {
    id: 'cmp-summer-voucher',
    name: 'Summer voucher drop',
    channel: 'email',
    status: 'active',
    open_rate: 0.284,
    click_rate: 0.061,
    conversion_rate: 0.019,
  },
  {
    id: 'cmp-mobile-recovery',
    name: 'Mobile checkout recovery',
    channel: 'email',
    status: 'draft',
    open_rate: 0.0,
    click_rate: 0.0,
    conversion_rate: 0.0,
  },
];

const customers = [
  {
    id: 'cust-1001',
    email: 'customer1001@example.test',
    state: 'SP',
    city: 'Sao Paulo',
    loyalty_tier: 'platinum',
    predicted_churn_risk: 0.81,
    lifetime_value: 1840,
  },
  {
    id: 'cust-1002',
    email: 'customer1002@example.test',
    state: 'RJ',
    city: 'Rio de Janeiro',
    loyalty_tier: 'gold',
    predicted_churn_risk: 0.67,
    lifetime_value: 1260,
  },
];

const analyticsResult = {
  summary:
    'Synthetic weekly scan: mobile checkout conversion fell 18.4% while payment failures rose 31.2%; the largest impact is in SP mobile sessions.',
  currency: 'USD',
  anomalies: [
    {
      category: 'conversion_drop',
      metric: 'conversion_rate',
      current: 0.031,
      prior: 0.038,
      change_pct: -18.4,
      scope: ['mobile', 'checkout', 'SP'],
      affected_customers: 9_340,
      lost_revenue_estimate: 42_600,
    },
    {
      category: 'fraud',
      metric: 'payment_failure_rate',
      current: 0.046,
      prior: 0.035,
      change_pct: 31.2,
      scope: ['credit_card', 'mobile'],
      affected_customers: 1_180,
      lost_revenue_estimate: 18_900,
    },
  ],
  rows: [
    { period: 'current_7d', revenue: 188_420, purchases: 4_920, conversion_rate: 0.031 },
    { period: 'prior_7d', revenue: 231_020, purchases: 5_860, conversion_rate: 0.038 },
  ],
  funnel: { view: 100_000, cart: 34_200, checkout: 18_640, purchase: 4_920 },
  history: [0.041, 0.04, 0.039, 0.039, 0.038, 0.038, 0.037, 0.036, 0.035, 0.034, 0.032, 0.031],
};

/**
 * Blooming-owned synthetic DataSource. It emulates Bloomreach's tool catalog
 * and result envelopes, but the data and ecommerce semantics intentionally
 * live in this app instead of AptKit core.
 */
export class SyntheticDataSource implements DataSource {
  async listTools(_opts?: DataSourceListOptions): Promise<{ tools: ToolDef[] }> {
    return { tools: toolDefs };
  }

  async callTool(
    name: string,
    args: Record<string, unknown> = {},
    _opts?: DataSourceCallOptions,
  ): Promise<DataSourceCallResult> {
    const started = Date.now();
    const payload = this.dispatch(name, args);
    return {
      result: payload,
      durationMs: Date.now() - started,
      fromCache: false,
    };
  }

  private dispatch(name: string, args: Record<string, unknown>): ToolResult {
    switch (name) {
      case 'list_cloud_organizations':
        return ok({ data: [{ id: 'org-synthetic-blooming', name: 'Synthetic Blooming Org' }] });
      case 'list_projects':
        return ok({ data: [{ id: PROJECT_ID, name: PROJECT_NAME }] });
      case 'get_event_schema':
        return ok({
          events: syntheticWorkspaceSchema.events.map((event) => ({
            type: event.name,
            properties: {
              default_group: {
                properties: event.properties.map((property) => ({ property })),
              },
            },
          })),
        });
      case 'get_customer_property_schema':
        return ok({
          properties: syntheticWorkspaceSchema.customerProperties.map((property) => ({ property })),
        });
      case 'list_catalogs':
        return ok({
          data: syntheticWorkspaceSchema.catalogs.map((catalog) => ({
            _id: catalog.id,
            name: catalog.name,
          })),
        });
      case 'get_project_overview':
        return ok({
          data: {
            events: syntheticWorkspaceSchema.totalEvents,
            total_customers: syntheticWorkspaceSchema.totalCustomers,
            oldest_timestamp: syntheticWorkspaceSchema.oldestTimestamp,
            event_types_overview: Object.fromEntries(
              syntheticWorkspaceSchema.events.map((event) => [
                event.name,
                { event_count: event.eventCount },
              ]),
            ),
          },
        });
      case 'execute_analytics':
      case 'execute_analytics_eql':
        return ok({
          ...analyticsResult,
          query: args.eql ?? args.query ?? args.analysis ?? null,
          project_id: args.project_id ?? PROJECT_ID,
        });
      case 'get_funnel':
        return ok({
          id: String(args.id ?? 'funnel-checkout'),
          name: 'Checkout funnel',
          steps: ['view_item', 'cart_update', 'checkout', 'purchase'],
          current: analyticsResult.funnel,
          prior_change_pct: { view: 3.2, cart: -4.1, checkout: -8.6, purchase: -18.4 },
        });
      case 'get_event_segmentation':
        return ok({
          event: args.event ?? 'purchase',
          dimension: args.dimension ?? 'state',
          rows: [
            { value: 'SP', current: 1680, prior: 2210, change_pct: -24.0 },
            { value: 'RJ', current: 910, prior: 960, change_pct: -5.2 },
            { value: 'MG', current: 740, prior: 725, change_pct: 2.1 },
          ],
        });
      case 'list_dashboards':
        return ok({ data: [{ id: 'dash-executive', name: 'Executive commerce health' }] });
      case 'get_dashboard':
        return ok({ id: args.id ?? 'dash-executive', name: 'Executive commerce health', widgets: analyticsResult.rows });
      case 'list_trends':
        return ok({ data: [{ id: 'trend-mobile-conversion', name: 'Mobile conversion trend' }] });
      case 'get_trend':
        return ok({ id: args.id ?? 'trend-mobile-conversion', history: analyticsResult.history });
      case 'list_funnels':
        return ok({ data: [{ id: 'funnel-checkout', name: 'Checkout funnel' }] });
      case 'list_running_aggregates':
        return ok({ data: [{ id: 'agg-weekly-revenue', name: 'Weekly revenue' }] });
      case 'get_running_aggregate':
        return ok({ id: args.id ?? 'agg-weekly-revenue', current: 188_420, prior: 231_020 });
      case 'list_reports':
        return ok({ data: [{ id: 'report-weekly-health', name: 'Weekly health report' }] });
      case 'get_report':
        return ok({ id: args.id ?? 'report-weekly-health', summary: analyticsResult.summary });
      case 'list_customers':
      case 'list_customers_in_segment':
        return ok({ data: customers, count: customers.length });
      case 'list_customer_events':
        return ok({
          customer_id: args.customer_id ?? customers[0].id,
          data: [
            { type: 'session_start', timestamp: '2026-05-28T10:04:00Z', device_type: 'mobile' },
            { type: 'checkout', timestamp: '2026-05-28T10:09:00Z', cart_value: 96 },
            { type: 'payment_failure', timestamp: '2026-05-28T10:10:00Z', failure_reason: 'issuer_declined' },
          ],
        });
      case 'list_segmentations':
        return ok({ data: segments });
      case 'list_email_campaigns':
        return ok({ data: campaigns });
      case 'list_sms_campaigns':
        return ok({ data: [{ id: 'sms-last-chance', name: 'Last chance reminder', status: 'paused' }] });
      case 'list_in_app_messages':
        return ok({ data: [{ id: 'iam-mobile-recovery', name: 'Mobile recovery nudge', status: 'draft' }] });
      case 'list_banners':
        return ok({ data: [{ id: 'banner-free-shipping', name: 'Free shipping banner', status: 'active' }] });
      case 'list_experiments':
        return ok({ data: [{ id: 'exp-checkout-copy', name: 'Checkout CTA copy test', status: 'running' }] });
      case 'list_scenarios':
        return ok({ data: scenarios });
      case 'get_scenario':
        return ok(findById(scenarios, args.id) ?? scenarios[0]);
      case 'list_catalog_items':
        return ok({ data: catalogItems });
      case 'get_catalog_item':
        return ok(findById(catalogItems, args.id) ?? catalogItems[0]);
      case 'list_initiatives':
        return ok({
          data: [
            { id: 'init-mobile-recovery', name: 'Mobile checkout recovery', owner: 'Lifecycle' },
            { id: 'init-payment-health', name: 'Payment approval recovery', owner: 'Growth' },
          ],
        });
      case 'get_initiative_items':
        return ok({ data: [{ id: 'item-restart-sequence', title: 'Restart checkout recovery sequence' }] });
      case 'list_recommendations':
        return ok({
          data: [
            {
              id: 'rec-checkout-recovery',
              name: 'Checkout recovery recommendation',
              status: 'ready',
              algorithm: 'popular_in_category',
            },
          ],
        });
      case 'get_recommendation':
        return ok({
          id: args.id ?? 'rec-checkout-recovery',
          name: 'Checkout recovery recommendation',
          slots: 4,
          status: 'ready',
        });
      case 'list_voucher_pools':
        return ok({
          data: [
            { id: 'vp-mobile-10', name: 'Mobile recovery 10%', available: 12_000, expires_at: '2026-06-30' },
          ],
        });
      case 'get_frequency_policies':
        return ok({ data: [{ id: 'freq-default', name: 'Default lifecycle policy', max_messages_per_week: 3 }] });
      case 'get_customer_prediction_score':
        return ok({
          model: args.model ?? 'churn_risk',
          average_score: 0.41,
          high_risk_customers: 4_820,
          top_drivers: ['payment_failure', 'checkout_without_purchase', 'low_recent_engagement'],
        });
      default:
        return errorResult(name);
    }
  }
}

function ok(payload: unknown): ToolResult {
  return {
    structuredContent: payload,
    content: [{ type: 'text', text: JSON.stringify(payload) }],
  };
}

function errorResult(name: string): ToolResult {
  const payload = { error: `synthetic tool is not implemented: ${name}` };
  return {
    isError: true,
    structuredContent: payload,
    content: [{ type: 'text', text: JSON.stringify(payload) }],
  };
}

function findById<T extends { id: string }>(items: T[], id: unknown): T | undefined {
  return items.find((item) => item.id === id);
}
