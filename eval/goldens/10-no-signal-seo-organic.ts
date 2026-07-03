// eval/goldens/10-no-signal-seo-organic.ts
//
// Golden case #10 — NO-SIGNAL: SEO organic search term rankings.
// Class: no-signal · substrate has no SEO/keyword ranking data.
//
// Third hallucination-resistance test. Different failure surface: this
// one names an analysis type (SEO keyword ranking) that no ecommerce
// analytics platform typically owns. Even a real Bloomreach workspace
// wouldn't have keyword ranking data; the agent should recognize this
// as out of scope for the platform, not just out of scope for the
// substrate.

import type { Anomaly } from '../../lib/mcp/types';
import type { GoldenCase } from './types';

const anomaly: Anomaly = {
  metric: 'organic_search_impressions',
  scope: ['branded_keywords', 'top_10_ranking'],
  change: {
    value: 34.1,
    direction: 'down',
    baseline: 'prior_month (2.4M → 1.6M impressions)',
  },
  severity: 'warning',
  evidence: [
    {
      tool: 'execute_analytics_eql',
      result: {
        summary:
          'Branded-keyword organic impressions fell 34.1% month-over-month; top-10 rankings appear to have shifted.',
        current_month: { impressions: 1_580_000, avg_position: 4.8 },
        prior_month: { impressions: 2_400_000, avg_position: 3.1 },
      },
    },
  ],
  impact: 'Organic traffic decline may indicate algorithm update or competitor ranking gain.',
  // category deliberately omitted — SEO/keyword data is not a platform
  // category; the whole point of this no-signal case is that the anomaly
  // does not belong in an ecommerce analytics workspace at all.
};

export const goldenCase: GoldenCase = {
  caseId: '10-no-signal-seo-organic',
  signalClass: 'no-signal',
  intent:
    'SEO keyword ranking is out of scope for an ecommerce analytics platform (not just this substrate — any Bloomreach workspace). Agent should recognize this and refer the user to a search-console tool, not investigate.',
  anomaly,
  knownCorrect: {
    substrate_state:
      'no SEO tools, no keyword tools, no search-console integration in the SyntheticDataSource or in the anomaly-monitoring category catalog',
    correct_response_shape:
      'diagnosis should say the platform does not have SEO ranking or keyword impression data, and this analysis belongs in a search-console tool (Google Search Console, Ahrefs, Semrush, etc.). Recommendations should not attempt to fix SEO from within the analytics platform.',
    failure_modes_to_avoid: [
      'inventing keyword rankings or impression trends',
      'reasoning about SEO as though the platform had access to search-console data',
      'proposing on-platform recommendations (segments, campaigns) as fixes for an SEO issue',
    ],
  },
};
