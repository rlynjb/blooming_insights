// eval/goldens/09-engagement-drop-email-campaign.ts
//
// Golden case #9 — email campaign engagement drop.
// Class: partial-signal · substrate has list_email_campaigns tool with
// generic data; the specific campaign context is limited.
//
// Tests the agent's ability to reason about marketing-channel metrics
// with only partial substrate support. list_email_campaigns returns a
// generic list; there's no per-campaign performance detail. Agent should
// use what's available (campaign existence + generic data), note the
// limits, and propose next-step tools it would want.

import type { Anomaly } from '../../lib/mcp/types';
import type { GoldenCase } from './types';

const anomaly: Anomaly = {
  metric: 'email_click_through_rate',
  scope: ['newsletter', 'transactional_recovery'],
  change: {
    value: 24.3,
    direction: 'down',
    baseline: 'prior_month (0.082 → 0.062)',
  },
  severity: 'warning',
  evidence: [
    {
      tool: 'execute_analytics_eql',
      result: {
        summary:
          'Email CTR across newsletter and transactional_recovery flows dropped 24.3% month-over-month.',
        current_month: { ctr: 0.062, sent: 484_000, clicks: 30_000 },
        prior_month: { ctr: 0.082, sent: 481_000, clicks: 39_400 },
      },
    },
  ],
  impact: 'Reduced email engagement may compound into lower re-engagement funnel volume.',
  category: 'campaign_perf',
};

export const goldenCase: GoldenCase = {
  caseId: '09-engagement-drop-email-campaign',
  signalClass: 'partial-signal',
  intent:
    'Marketing-channel anomaly with only partial substrate support (generic list_email_campaigns). Agent should use what is available, explicitly name the limits, and specify the tools it would want to complete the analysis.',
  anomaly,
  knownCorrect: {
    primary_signal: 'email CTR down 24.3% month-over-month across two flows',
    likely_contributors: [
      'subject-line or preheader regression',
      'audience quality shift (list decay)',
      'inbox-placement issue (deliverability)',
      'transactional_recovery flow triggering rules changed',
    ],
    scope_should_stay_within: ['email', 'newsletter', 'transactional_recovery'],
    substrate_limits:
      'list_email_campaigns returns generic campaign metadata; per-campaign CTR breakdown is not directly available. Agent should note this limit.',
    red_herrings_to_avoid: [
      'attributing to broader engagement decline without evidence',
      'inventing per-campaign CTR numbers not returned by the tool',
      'proposing an experiment when the diagnostic data does not yet support one',
    ],
  },
};
