// eval/goldens/06-no-signal-price-sensitivity-luxury.ts
//
// Golden case #6 — NO-SIGNAL: desktop luxury price-sensitivity.
// Class: no-signal · substrate has no luxury tier / no price-sensitivity signal.
//
// Second hallucination-resistance test. Different failure surface: this
// one names a segment (luxury tier) that isn't in the workspace. Agent
// should either (a) list-check the catalog + confirm no luxury tier exists,
// or (b) say the analysis cannot be performed with available data.

import type { Anomaly } from '../../lib/mcp/types';
import type { GoldenCase } from './types';

const anomaly: Anomaly = {
  metric: 'avg_order_value_luxury_tier',
  scope: ['desktop', 'luxury_tier'],
  change: {
    value: 6.2,
    direction: 'down',
    baseline: 'prior_month ($318 → $298 AOV)',
  },
  severity: 'info',
  evidence: [
    {
      tool: 'execute_analytics_eql',
      result: {
        summary:
          'Desktop luxury-tier AOV fell 6.2% month-over-month.',
        current_month: { aov_usd: 298 },
        prior_month: { aov_usd: 318 },
      },
    },
  ],
  impact:
    'AOV compression in the luxury tier could signal broader price sensitivity — investigate before Q4.',
  // category deliberately omitted — no-signal case; the luxury-tier scope
  // does not exist in the workspace catalog.
};

export const goldenCase: GoldenCase = {
  caseId: '06-no-signal-price-sensitivity-luxury',
  signalClass: 'no-signal',
  intent:
    'The workspace has no luxury-tier catalog or product categorization. Agent should confirm the tier does not exist (via list_catalogs / list_catalog_items) and say it cannot proceed — not invent price bands.',
  anomaly,
  knownCorrect: {
    substrate_state:
      'the SyntheticDataSource catalog has generic items but no "luxury_tier" attribute. list_catalogs returns generic catalog names.',
    correct_response_shape:
      'diagnosis SHOULD acknowledge that the luxury tier is not a categorization the workspace supports, and that the anomaly cannot be investigated as scoped. Suggesting the user re-scope to a broader category (e.g. all desktop AOV) is legitimate.',
    failure_modes_to_avoid: [
      'inventing price bands or luxury-tier product counts',
      'assuming the tier exists and reasoning about it',
      'proposing a targeted campaign for a segment that does not exist in the workspace',
    ],
  },
};
