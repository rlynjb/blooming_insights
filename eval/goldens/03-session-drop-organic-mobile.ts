// eval/goldens/03-session-drop-organic-mobile.ts
//
// Golden case #3 — a top-of-funnel session drop.
// Class: has-signal · exercises session_start filtered by utm_source.
//
// Tests the agent's ability to reason about traffic-quality vs volume
// signals when the anomaly is upstream of the funnel (session_start vs
// checkout). The substrate has session_start and get_event_segmentation
// available.

import type { Anomaly } from '../../lib/mcp/types';
import type { GoldenCase } from './types';

const anomaly: Anomaly = {
  metric: 'session_start_count',
  scope: ['mobile', 'organic'],
  change: {
    value: 22.7,
    direction: 'down',
    baseline: 'prior_7d (198,400 → 153,400 sessions)',
  },
  severity: 'warning',
  evidence: [
    {
      tool: 'execute_analytics_eql',
      result: {
        summary:
          'Mobile organic sessions fell 22.7% week-over-week; paid channels roughly stable.',
        current_7d: { sessions: 153_400 },
        prior_7d: { sessions: 198_400 },
        by_utm_source: {
          organic: { current: 42_000, prior: 68_500, change_pct: -38.7 },
          paid: { current: 111_400, prior: 129_900, change_pct: -14.2 },
        },
      },
    },
  ],
  impact:
    'Loss of 45K mobile organic sessions over 7 days may compound if the drop persists; downstream conversion impact not yet materialized.',
  category: 'campaign_perf',
};

export const goldenCase: GoldenCase = {
  caseId: '03-session-drop-organic-mobile',
  signalClass: 'has-signal',
  intent:
    'Top-of-funnel anomaly. Agent must not conflate with the checkout-conversion story from case 1; scope is broader (mobile, no state filter, organic-specific).',
  anomaly,
  knownCorrect: {
    primary_signal: 'mobile organic session_start count dropped 22.7% week-over-week',
    likely_causes: [
      'SEO ranking loss or algorithm shift',
      'competitor bid pressure on branded terms',
      'referral partner change',
    ],
    scope_should_stay_within: ['mobile', 'organic', 'session_start'],
    red_herrings_to_avoid: [
      'checkout / conversion rate — this is an upstream volume issue',
      'paid channel performance — case-scoped to organic',
      'attributing to fraud or infrastructure — no evidence',
    ],
  },
};
