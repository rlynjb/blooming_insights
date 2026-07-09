// eval/rubrics/recommendation-quality.ts
//
// The rubric that RubricJudge scores a Recommendation against. Same shape as
// diagnosis-quality.ts: four dimensions (1–5), three verdicts, four binary
// checks. Domain data lives in blooming; the judging engine lives in
// @aptkit/evals via @aptkit/core.
//
// ─── Pattern: scoring rubric (criteria-as-data for LLM-as-judge) ──────────
// The recommendation-side twin of diagnosis-quality.ts's rubric: judgment
// criteria as anchored, named data. Adds binary `checks` alongside the scored
// dimensions — a checklist for pass/fail properties that don't need a 1–5
// scale. Written around explicit failure modes (below) so the scale anchors
// target the ways a recommendation actually goes wrong.
//
// A recommendation is the last agent's output in the pipeline. It matters
// because it's what a marketer/analyst would ACT on. The failure modes we're
// scoring against:
//   · disconnected — recommendation doesn't respond to the diagnosis's cause
//   · wrong lever — the chosen `bloomreachFeature` doesn't fit the problem
//                    (e.g. a scenario recommended for a top-of-funnel awareness
//                    issue that needs a segment + campaign)
//   · vague — steps say "consider setting up X" instead of "do Y with Z"
//   · impact fantasy — estimatedImpact isn't proportional to the anomaly

import type { RubricDefinition } from '@aptkit/core';

export const recommendationQualityRubric: RubricDefinition = {
  id: 'blooming-recommendation-quality-v1',
  title: 'Recommendation quality',
  task: `Judge a recommendation produced by an AI analyst responding to an ecommerce
anomaly + its diagnosis. The recommendation will be JSON with these fields:
title, rationale, bloomreachFeature (scenario|segment|campaign|voucher|experiment),
steps (an ordered array), estimatedImpact (either a string or {range, rangeUsd?, assumption}),
confidence, and optional effort / timeToSetUpMinutes / readResultInDays / prerequisites /
successMetric. Score on the four dimensions below.

Important: you will receive the DIAGNOSIS that this recommendation is responding to
as context. Recommendations are graded relative to that diagnosis, not in the
abstract. A recommendation that would be great for a different problem still
scores badly if it doesn't address THIS diagnosis's root cause.`,
  dimensions: [
    {
      id: 'diagnosis_response',
      label: 'Diagnosis response',
      description:
        'Does the recommendation address the root cause the diagnosis named? A recommendation that solves a different problem than the one diagnosed is a 1. A recommendation that directly acts on the diagnosed mechanism is a 5.',
      scale: [
        {
          score: 1,
          description:
            'Recommendation solves a different problem than the one the diagnosis identified.',
        },
        {
          score: 2,
          description: 'Loosely connected to the diagnosis; addresses a symptom, not the cause.',
        },
        {
          score: 3,
          description:
            'Addresses the diagnosed cause but only obliquely (e.g. campaign to affected segment without addressing the mechanism).',
        },
        {
          score: 4,
          description:
            'Directly targets the diagnosed cause with a mechanism-appropriate lever.',
        },
        {
          score: 5,
          description:
            'Directly targets the diagnosed cause AND anticipates second-order effects or downstream risks named in the diagnosis.',
        },
      ],
    },
    {
      id: 'feature_choice_fit',
      label: 'Bloomreach feature choice fit',
      description:
        'Is `bloomreachFeature` the right lever for this problem? Scenarios fire triggered flows; segments carve out targeting; campaigns push messaging; vouchers add incentive; experiments A/B test. Wrong lever = wrong shape of solution.',
      scale: [
        { score: 1, description: 'The feature choice is unrelated to the problem shape.' },
        {
          score: 2,
          description:
            'The feature could theoretically apply but a different one would fit better.',
        },
        { score: 3, description: 'Reasonable choice; not the strongest but defensible.' },
        { score: 4, description: 'Well-matched feature for this problem shape.' },
        {
          score: 5,
          description:
            'Well-matched feature AND the rationale explicitly justifies the lever over alternatives.',
        },
      ],
    },
    {
      id: 'step_actionability',
      label: 'Step actionability',
      description:
        'Are the `steps` concrete enough that a marketer/analyst can execute them without a follow-up meeting? "Set up a segment" is a 2. "Create a segment named X where Y in the last 7 days, then feed it into scenario Z" is a 5.',
      scale: [
        { score: 1, description: 'Steps are aspirational, not executable.' },
        {
          score: 2,
          description: 'Steps name what to do but not on which entities/attributes.',
        },
        {
          score: 3,
          description: 'Steps are executable but require the operator to fill in scope details.',
        },
        {
          score: 4,
          description: 'Steps name specific entities, attributes, and thresholds.',
        },
        {
          score: 5,
          description:
            'Steps name specific entities, attributes, thresholds, AND success criteria per step.',
        },
      ],
    },
    {
      id: 'impact_realism',
      label: 'Impact realism',
      description:
        'Is `estimatedImpact` proportional to the anomaly? A $5K recovery estimate on a $42.6K anomaly is under-scaled and probably wrong. A $500K estimate is over-scaled. Estimates without an `assumption` are ungrounded even if the magnitude is right.',
      scale: [
        {
          score: 1,
          description: 'Impact is missing, or wildly disproportionate to the anomaly magnitude.',
        },
        {
          score: 2,
          description: 'Impact magnitude is plausible but there is no assumption linking it.',
        },
        { score: 3, description: 'Impact has a plausible magnitude and a stated assumption.' },
        {
          score: 4,
          description:
            'Impact has a defensible range with a stated assumption tied to numbers from the diagnosis.',
        },
        {
          score: 5,
          description:
            'Impact has a defensible range, an assumption grounded in specific numbers, AND acknowledges what could invalidate the estimate.',
        },
      ],
    },
  ],
  verdicts: [
    {
      verdict: 'pass',
      description:
        'All four dimensions at ≥4. The recommendation directly targets the diagnosed cause, uses the right lever, has executable steps, and has a defensible impact estimate.',
    },
    {
      verdict: 'pass_with_notes',
      description:
        'Overall usable but one or more dimensions at 3. The `fix` field should name the weakest dimension.',
    },
    {
      verdict: 'fail',
      description:
        'Any dimension at ≤2. The recommendation is either off-target, using the wrong lever, unactionable, or making up numbers.',
    },
  ],
  checks: [
    'the recommendation names a specific `bloomreachFeature`',
    'steps are executable, not aspirational',
    'estimatedImpact is present and grounded in the diagnosis numbers',
    'the recommendation would not be equally applicable to a different anomaly',
  ],
};
