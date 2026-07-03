// eval/goldens/02-fraud-payment-failure-credit-card.ts
//
// Golden case #2 — the fraud-flagged payment_failure anomaly.
// Class: has-signal · anchored to the second seeded anomaly in
// synthetic-data-source.ts (fraud category, credit_card + mobile).
//
// Tests whether the agent, given a fraud-tagged anomaly, correctly reasons
// about whether the rise is truly fraud vs. an infrastructure failure vs.
// user experience. In this substrate, the co-occurrence with the conversion
// drop suggests infra > fraud, and a strong diagnosis will note that.

import type { Anomaly } from '../../lib/mcp/types';
import type { GoldenCase } from './types';

const anomaly: Anomaly = {
  metric: 'payment_failure_rate',
  scope: ['credit_card', 'mobile'],
  change: {
    value: 31.2,
    direction: 'up',
    baseline: 'prior_7d (0.035 → 0.046)',
  },
  severity: 'critical',
  evidence: [
    {
      tool: 'execute_analytics_eql',
      result: {
        summary:
          'Weekly scan: payment_failure_rate on credit_card mobile rose 31.2% (0.035 → 0.046); co-occurs with an 18.4% conversion drop in SP mobile checkout.',
        current_7d: { failure_rate: 0.046, failures: 1_180 },
        prior_7d: { failure_rate: 0.035, failures: 900 },
        affected_customers: 1_180,
        lost_revenue_estimate_usd: 18_900,
      },
    },
  ],
  impact:
    'Estimated $18.9K lost revenue and 1,180 affected credit-card mobile customers over the trailing 7 days.',
  category: 'fraud',
};

export const goldenCase: GoldenCase = {
  caseId: '02-fraud-payment-failure-credit-card',
  signalClass: 'has-signal',
  intent:
    'Cross-mechanism disambiguation: the anomaly is tagged `fraud` but the scale + co-occurrence pattern suggests infrastructure failure. Strong diagnosis considers both and reasons about which fits the evidence.',
  anomaly,
  knownCorrect: {
    primary_signal:
      'payment_failure_rate up 31.2% on credit_card mobile in the same window a mobile checkout conversion drop of 18.4% occurred in SP',
    disambiguation:
      'a real fraud spike would typically show geographic dispersion, unusual purchase patterns, or blocklist hits; infrastructure would show co-timing with conversion drops and a concentrated scope (credit_card + mobile) — the evidence favors infrastructure',
    scope_should_stay_within: ['credit_card', 'mobile'],
    red_herrings_to_avoid: [
      'blaming the customer segment when infra is more consistent with the pattern',
      'conflating fraud category tag with root cause without disambiguating',
    ],
  },
};
