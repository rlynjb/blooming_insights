// eval/goldens/04-cart-abandonment-mobile-broad.ts
//
// Golden case #4 — cart abandonment on mobile, broad scope (no state filter).
// Class: partial-signal · substrate has cart_update event + funnel data.
//
// Tests scope-appropriateness at a broader anomaly definition. The agent
// should NOT narrow to SP/mobile-checkout territory (case 1's scope);
// it should keep the diagnosis at the mobile / cart level or acknowledge
// the more specific SP pattern as one contributor.

import type { Anomaly } from '../../lib/mcp/types';
import type { GoldenCase } from './types';

const anomaly: Anomaly = {
  metric: 'cart_to_checkout_rate',
  scope: ['mobile'],
  change: {
    value: 11.9,
    direction: 'down',
    baseline: 'prior_7d (0.611 → 0.544)',
  },
  severity: 'warning',
  evidence: [
    {
      tool: 'execute_analytics_eql',
      result: {
        summary:
          'Mobile cart → checkout progression fell 11.9% (0.611 → 0.544); consistent across geographies but sharpest in SP mobile.',
        current_7d: { rate: 0.544, cart_updates: 34_200, checkouts: 18_640 },
        prior_7d: { rate: 0.611, cart_updates: 32_100, checkouts: 19_620 },
      },
    },
  ],
  impact: 'Approximately 980 fewer mobile checkouts week-over-week from the same cart volume.',
  category: 'cart_abandonment',
};

export const goldenCase: GoldenCase = {
  caseId: '04-cart-abandonment-mobile-broad',
  signalClass: 'partial-signal',
  intent:
    'Broader-scope anomaly than case 1. Agent should stay at the mobile-cart level and only mention SP as one contributor, not the whole story. Tests scope proportionality.',
  anomaly,
  knownCorrect: {
    primary_signal: 'mobile cart → checkout progression down 11.9% week-over-week',
    likely_contributors: [
      'the same SP payment-processor issue affecting downstream (may explain part of the mobile-wide effect since SP is a large slice)',
      'mobile checkout page performance regression',
      'shipping-fee UX change on cart page',
    ],
    scope_should_stay_within: ['mobile', 'cart', 'checkout'],
    red_herrings_to_avoid: [
      'narrowing to SP-only (case 1 already scoped there — this is broader)',
      'attributing to session volume (session_start scope is a different question)',
      'proposing site-wide changes when scope is mobile',
    ],
  },
};
