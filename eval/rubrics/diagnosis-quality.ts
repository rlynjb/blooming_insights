// eval/rubrics/diagnosis-quality.ts
//
// The rubric that RubricJudge scores a Diagnosis against. Four dimensions,
// each 1–5. Domain data lives in blooming (this file); the judging engine
// (`RubricJudge`, `RubricDefinition`) lives in @aptkit/evals via @aptkit/core.
//
// ─── Pattern: scoring rubric (criteria-as-data for LLM-as-judge) ──────────
// Externalizes the judgment criteria as DATA, not prose baked into a prompt:
// named dimensions, each with an anchored 1–5 scale. That's what makes the
// judge auditable, tunable, and calibratable (see compute-agreement.eval.ts).
// Anchored scales exist to reduce judge variance — every score has a concrete
// definition rather than a vibe.
//
// This rubric is intentionally shaped like what the retired Phase 3 pipeline
// scored — five criteria collapsed into four here (drop the "phrasing" one;
// it was noise, not signal). The Week-2 calibration slice will re-measure
// judge-vs-human agreement against Synthetic; the retired baseline was 8/8 +
// 3/3 against Olist. Not directly comparable, but the same discipline.

import type { RubricDefinition } from '@aptkit/core';

export const diagnosisQualityRubric: RubricDefinition = {
  id: 'blooming-diagnosis-quality-v1',
  title: 'Diagnosis quality',
  task: `Judge a diagnosis produced by an AI analyst investigating an ecommerce anomaly.
The diagnosis will be JSON with these fields: conclusion (one-sentence root cause),
evidence (bullet list of what supported the conclusion), hypothesesConsidered (each
with hypothesis + supported flag + reasoning), and optional affectedCustomers and
confidence. Score on the four dimensions below.`,
  dimensions: [
    {
      id: 'root_cause_plausibility',
      label: 'Root-cause plausibility',
      description:
        'Does the conclusion name a plausible mechanism (not just a symptom restatement)? A conclusion that says "conversion dropped because conversion dropped" is a 1. A conclusion that names a specific mechanism supported by the evidence is a 5.',
      scale: [
        { score: 1, description: 'Restates the symptom; no mechanism named.' },
        { score: 2, description: 'Vague mechanism, no evidence link.' },
        { score: 3, description: 'Plausible mechanism, weakly evidenced.' },
        { score: 4, description: 'Specific mechanism, evidence supports it.' },
        {
          score: 5,
          description: 'Specific mechanism, evidence directly supports it, and rival mechanisms are considered.',
        },
      ],
    },
    {
      id: 'evidence_grounding',
      label: 'Evidence grounding',
      description:
        'Does the diagnosis cite the actual signals the substrate exposed? Bonus if it names the co-occurring signals (e.g. the payment_failure spike alongside the conversion drop). Penalty for invented numbers or claims not derivable from the tool results.',
      scale: [
        { score: 1, description: 'Numbers or claims that contradict the evidence.' },
        { score: 2, description: 'Vague evidence references; no specific numbers cited.' },
        { score: 3, description: 'Cites at least one specific number from the evidence.' },
        { score: 4, description: 'Cites multiple specific signals; notes at least one co-occurring signal.' },
        {
          score: 5,
          description: 'Cites the primary and co-occurring signals; every claim is traceable to a tool result.',
        },
      ],
    },
    {
      id: 'scope_coherence',
      label: 'Scope coherence',
      description:
        'Does the diagnosis stay within the anomaly\'s scope (mobile, checkout, SP)? Extrapolations to segments the scan did not cover (desktop, other countries) are incoherent.',
      scale: [
        { score: 1, description: 'Diagnosis is about a different scope entirely.' },
        { score: 2, description: 'Mixes in-scope and out-of-scope claims.' },
        { score: 3, description: 'Stays in scope but does not fully use scope-specific detail.' },
        { score: 4, description: 'Uses the specific scope (e.g. mobile/checkout/SP) in the conclusion.' },
        {
          score: 5,
          description: 'Uses the specific scope AND explicitly rules out out-of-scope hypotheses.',
        },
      ],
    },
    {
      id: 'actionable_next_step',
      label: 'Actionable next step',
      description:
        'Would a marketer / analyst reading this know what to do next? "Investigate mobile checkout" is unhelpful (that\'s what the diagnosis IS). "Check payment processor logs for credit_card mobile SP over the last 7 days" is actionable.',
      scale: [
        { score: 1, description: 'No next step, or the next step is to redo the diagnosis.' },
        { score: 2, description: 'Vague next step ("investigate further").' },
        { score: 3, description: 'Named next step, but no specifics.' },
        { score: 4, description: 'Specific next step with a scope.' },
        { score: 5, description: 'Specific next step, scoped, with a named tool/query to run.' },
      ],
    },
  ],
  verdicts: [
    {
      verdict: 'pass',
      description:
        'All four dimensions at ≥4. The diagnosis names a plausible root cause, cites evidence, stays in scope, and hands off an actionable next step.',
    },
    {
      verdict: 'pass_with_notes',
      description:
        'Overall usable but one or more dimensions at 3. The `fix` field should name the weakest dimension.',
    },
    {
      verdict: 'fail',
      description: 'Any dimension at ≤2. The diagnosis is not usable as-is.',
    },
  ],
  checks: [
    'cites at least one number from the tool results',
    'stays within the anomaly scope',
    'names at least one specific action',
    'does not invent numbers not present in the evidence',
  ],
};
