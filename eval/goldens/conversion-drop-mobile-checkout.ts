// eval/goldens/conversion-drop-mobile-checkout.ts
//
// Week-1 golden case — the ONE end-to-end proof-of-path.
//
// Anchored to the synthetic anomaly literal at
// lib/data-source/synthetic-data-source.ts:279–291. The DiagnosticAgent will
// receive the Blooming-shaped Anomaly below, run its ReAct loop against
// SyntheticDataSource, and produce a Diagnosis. RubricJudge then scores that
// Diagnosis against the rubric in eval/rubrics/diagnosis-quality.ts.
//
// The `knownCorrect` block is NOT fed to the agent; it is context for the
// judge (the "known-correct shape" the rubric's evidence-grounding and
// scope-coherence dimensions expect to see reflected in the diagnosis). Week 2
// will hand-label ~10 cases the same way to measure judge agreement.

import type { Anomaly } from '../../lib/mcp/types';

export const goldenAnomaly: Anomaly = {
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

/**
 * Known-correct shape the diagnosis SHOULD reflect. Passed as `context` to the
 * rubric judge so `evidence_grounding` and `scope_coherence` can score the
 * agent's diagnosis against what the synthetic substrate actually contains.
 *
 * The synthetic substrate co-locates a conversion drop with a payment_failure
 * spike in the same window — a diagnosis that only cites the funnel narrowing
 * (view → cart → checkout → purchase = 100k → 34.2k → 18.6k → 4.9k) without
 * mentioning the payment-failure signal is incomplete. A diagnosis that jumps
 * to a cause OUTSIDE the scope (e.g. desktop, or a different country) is
 * incoherent.
 */
export const knownCorrect = {
  primary_signal: 'checkout → purchase step is where the funnel breaks; upstream steps are stable relative to prior week',
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
};

export const caseId = 'conversion-drop-mobile-checkout' as const;
