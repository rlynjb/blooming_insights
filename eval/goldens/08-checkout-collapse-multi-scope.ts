// eval/goldens/08-checkout-collapse-multi-scope.ts
//
// Golden case #8 — critical multi-scope checkout collapse.
// Class: has-signal · substrate returns data on both mobile and desktop.
//
// Tests scope discipline when the anomaly is legitimately broad. Agent
// should treat mobile and desktop as parallel investigations, not
// collapse to one, and should note whether the pattern is symmetric
// (points at a shared cause like payment processor) or asymmetric
// (points at platform-specific causes).

import type { Anomaly } from '../../lib/mcp/types';
import type { GoldenCase } from './types';

const anomaly: Anomaly = {
  metric: 'checkout_completion_rate',
  scope: ['mobile', 'desktop', 'all_geos'],
  change: {
    value: 15.8,
    direction: 'down',
    baseline: 'prior_7d (0.278 → 0.234)',
  },
  severity: 'critical',
  evidence: [
    {
      tool: 'execute_analytics_eql',
      result: {
        summary:
          'Site-wide checkout completion rate fell 15.8%; mobile and desktop both down but mobile sharper.',
        current_7d: {
          overall_rate: 0.234,
          mobile_rate: 0.264,
          desktop_rate: 0.198,
        },
        prior_7d: {
          overall_rate: 0.278,
          mobile_rate: 0.312,
          desktop_rate: 0.237,
        },
      },
    },
  ],
  impact:
    'Site-wide checkout regression across platforms; approx $58K weekly revenue at risk if pattern persists.',
  category: 'conversion_drop',
};

export const goldenCase: GoldenCase = {
  caseId: '08-checkout-collapse-multi-scope',
  signalClass: 'has-signal',
  intent:
    'Multi-platform anomaly. Agent should treat mobile + desktop as parallel investigations, not collapse to one. Note whether the pattern is symmetric (shared cause) or asymmetric (platform-specific).',
  anomaly,
  knownCorrect: {
    primary_signal: 'checkout completion rate down 15.8% site-wide; both mobile and desktop hit',
    likely_shared_cause_candidates: [
      'payment processor issue affecting all channels (would show co-occurring payment_failure spike)',
      'site-wide checkout page latency regression',
      'tax / shipping calculation service outage',
    ],
    scope_should_stay_within: ['mobile', 'desktop', 'checkout'],
    red_herrings_to_avoid: [
      'narrowing prematurely to mobile-only (case 1 territory)',
      'attributing to traffic quality when volume is stable',
      'ignoring the desktop drop when it is a meaningful chunk of the story',
    ],
  },
};
