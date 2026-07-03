// eval/goldens/01-conversion-drop-mobile-checkout.ts
//
// Golden case #1 — the Week-1 proof-of-path case.
// Class: has-signal · anchored to synthetic-data-source.ts:279-291.

import type { Anomaly } from '../../lib/mcp/types';
import type { GoldenCase } from './types';

const anomaly: Anomaly = {
  metric: 'conversion_rate',
  scope: ['mobile', 'checkout', 'SP'],
  change: {
    value: 18.4,
    direction: 'down',
    baseline: 'prior_7d (0.038 → 0.031)',
  },
  severity: 'critical',
  evidence: [
    {
      tool: 'execute_analytics_eql',
      result: {
        summary:
          'Weekly conversion scan: mobile checkout fell 18.4% (0.038 → 0.031); payment failures rose 31.2% in the same window; largest impact in SP mobile sessions.',
        current_7d: { conversion_rate: 0.031, purchases: 4_920, revenue_usd: 188_420 },
        prior_7d: { conversion_rate: 0.038, purchases: 5_860, revenue_usd: 231_020 },
        funnel: { view: 100_000, cart: 34_200, checkout: 18_640, purchase: 4_920 },
        affected_customers: 9_340,
        lost_revenue_estimate_usd: 42_600,
      },
    },
  ],
  impact:
    'Estimated $42.6K lost revenue and 9,340 affected mobile-SP customers over the trailing 7 days.',
  history: [0.041, 0.04, 0.039, 0.039, 0.038, 0.038, 0.037, 0.036, 0.035, 0.034, 0.032, 0.031],
  category: 'conversion_drop',
};

export const goldenCase: GoldenCase = {
  caseId: '01-conversion-drop-mobile-checkout',
  signalClass: 'has-signal',
  intent:
    'The canonical happy path — clear anomaly, substrate has co-occurring payment_failure signal, agent should name payment processor as the primary mechanism and stay in mobile/checkout/SP scope.',
  anomaly,
  knownCorrect: {
    primary_signal:
      'checkout → purchase step is where the funnel breaks; upstream steps are stable relative to prior week',
    co_occurring_signal:
      'payment_failure_rate rose 31.2% in the same window (0.035 → 0.046); the fraud category flag co-fires on credit_card mobile scope',
    most_likely_root_cause_candidates: [
      'payment processor issue affecting mobile credit_card in SP',
      'mobile checkout UX regression (form validation / autofill)',
    ],
    scope_should_stay_within: ['mobile', 'checkout', 'SP', 'credit_card'],
    red_herrings_to_avoid: [
      'desktop conversion — no evidence in scan',
      'top-of-funnel (view_item / session_start) — stable',
      'geographies other than SP — scope is scoped',
    ],
  },
};
