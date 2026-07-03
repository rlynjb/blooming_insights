// eval/goldens/07-positive-conversion-surge-mobile.ts
//
// Golden case #7 — POSITIVE anomaly: a mobile conversion surge.
// Class: positive · tests whether the agent handles good news correctly.
//
// The substrate here does NOT actually support a surge — it has a static
// -18.4% drop. The anomaly presented to the agent is the OPPOSITE. Two
// legitimate outcomes: (a) agent notes substrate contradicts the anomaly
// and requests clarification; (b) agent reasons about what would cause
// this scope to surge if it did.
//
// The rubric here is testing whether "positive" severity gets treated as
// worth understanding (what worked so we can replicate), not just "no
// action needed."

import type { Anomaly } from '../../lib/mcp/types';
import type { GoldenCase } from './types';

const anomaly: Anomaly = {
  metric: 'conversion_rate',
  scope: ['mobile', 'iOS', 'US'],
  change: {
    value: 12.6,
    direction: 'up',
    baseline: 'prior_7d (0.041 → 0.046)',
  },
  severity: 'positive',
  evidence: [
    {
      tool: 'execute_analytics_eql',
      result: {
        summary:
          'iOS mobile US conversion rose 12.6% week-over-week; other iOS regions roughly stable.',
        current_7d: { rate: 0.046, purchases: 3_890, revenue_usd: 148_900 },
        prior_7d: { rate: 0.041, purchases: 3_460, revenue_usd: 132_400 },
      },
    },
  ],
  impact: 'Estimated +$16.5K/week revenue lift from the iOS US conversion improvement.',
  category: 'conversion_drop', // reusing the closest CategoryId; the severity is positive
};

export const goldenCase: GoldenCase = {
  caseId: '07-positive-conversion-surge-mobile',
  signalClass: 'positive',
  intent:
    'Positive-severity anomaly. Tests whether agent (a) handles good news as an opportunity ("what worked, can we replicate?"), (b) notes substrate contradicts (the synthetic data is negative), or (c) both. Poor response: "no action needed" — a positive anomaly worth diagnosing is still worth diagnosing.',
  anomaly,
  knownCorrect: {
    substrate_state:
      'the SyntheticDataSource returns the same negative-signal analyticsResult regardless of the anomaly framing; the agent may notice this and question the anomaly, or may reason about the anomaly as-stated.',
    correct_response_shape:
      'diagnosis should either (a) explicitly note the substrate data does not match the reported anomaly direction and ask for clarification, or (b) reason about what could cause a positive iOS-US shift (recent app release, iOS-specific optimization, US-specific campaign). Recommendations should focus on replication/expansion, not fixes.',
    failure_modes_to_avoid: [
      'treating positive anomaly as "not worth investigating"',
      'blindly reasoning about the positive shift while the substrate returns negative data (silently contradictory)',
      'proposing damage-control recommendations for a positive surge',
    ],
  },
};
