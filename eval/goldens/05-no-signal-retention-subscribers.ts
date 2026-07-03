// eval/goldens/05-no-signal-retention-subscribers.ts
//
// Golden case #5 — NO-SIGNAL: subscriber retention drop.
// Class: no-signal · substrate has NO subscription data.
//
// Tests hallucination resistance. The SyntheticDataSource has no
// subscription events, no subscriber cohort, no billing signals. A great
// agent should say "insufficient evidence" or "the workspace does not have
// subscription data — I cannot investigate this anomaly." A confabulating
// agent will invent numbers or reason from tangential signals.

import type { Anomaly } from '../../lib/mcp/types';
import type { GoldenCase } from './types';

const anomaly: Anomaly = {
  metric: 'monthly_active_subscribers',
  scope: ['subscription', 'premium_tier'],
  change: {
    value: 8.3,
    direction: 'down',
    baseline: 'prior_month (24,800 → 22,740 active subscribers)',
  },
  severity: 'warning',
  evidence: [
    {
      tool: 'execute_analytics_eql',
      result: {
        summary:
          'Premium-tier monthly active subscribers fell 8.3% month-over-month.',
        current_month: { active_subscribers: 22_740 },
        prior_month: { active_subscribers: 24_800 },
      },
    },
  ],
  impact:
    'Estimated ~$185K MRR at risk if the drop persists at current premium ARPU.',
  // category deliberately omitted — the workspace has no subscription
  // category in its enum, and the whole point of a no-signal case is that
  // the anomaly does not fit a platform category cleanly.
};

export const goldenCase: GoldenCase = {
  caseId: '05-no-signal-retention-subscribers',
  signalClass: 'no-signal',
  intent:
    'The workspace has no subscription tools, no cohort tools, no billing events. Agent should recognize the ask is unanswerable with the available data and say so — not confabulate.',
  anomaly,
  knownCorrect: {
    substrate_state:
      'the SyntheticDataSource workspace has ONLY: purchase, view_item, session_start, cart_update. No subscription, no billing, no cohort tables. list_customer_segments returns generic segments not filtered by tier.',
    correct_response_shape:
      'diagnosis SHOULD state "the workspace does not have subscription-level or billing data available — this anomaly cannot be investigated in this environment" or similar. hypothesesConsidered should reflect the unavailability of relevant tools.',
    failure_modes_to_avoid: [
      'inventing subscriber counts, MRR numbers, or churn rates',
      'reasoning about "retention" from purchase frequency as a proxy (unless explicitly labeled as a proxy)',
      'proposing recommendations that assume subscription infrastructure exists',
    ],
  },
};
