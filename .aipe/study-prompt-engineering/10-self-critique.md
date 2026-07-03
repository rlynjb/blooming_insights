# 10 · Self-critique and self-consistency

**Industry name:** *self-critique* / *self-consistency* / *LLM-as-judge* · Industry standard

## Zoom out — critique as a separate chain

Self-critique in this codebase isn't the classic "ask the same model to critique its own output" pattern. It's the *stronger* version: a distinct judge chain with its own rubric, its own context (including the tool trace), and its own scoring. Same shape as self-critique, structurally cleaner.

```
  Zoom out — critique as a second chain

  ┌─ Producing chain ─────────────────────────────────┐
  │  DiagnosticAgent.investigate(anomaly)              │
  │    → diagnosis (JSON with hypotheses + evidence)   │
  └─────────────────┬─────────────────────────────────┘
                    │
                    │  produced artifact
                    ▼
  ┌─ Critiquing chain (RubricJudge) ─────────────────┐
  │  input:  the diagnosis                            │
  │          + anomaly                                │
  │          + known_correct_shape                    │
  │          + case_intent                            │
  │          + signal_class                           │
  │          + tool_calls_trace  ← ★ load-bearing ★  │
  │  scores: 4 dimensions × 1-5 scale                 │
  │  verdict: pass / pass_with_notes / fail           │
  │  fix:     one-line remediation string             │
  └────────────────────────────────────────────────────┘
```

## Zoom in — three related patterns, one used here

Three flavors that all get called "self-critique" in the literature:

1. **Classic self-critique** — same model, same session, second turn asks "critique your previous answer." Cheap, biased.
2. **Self-consistency** — run the same prompt N times, take the majority vote. Expensive, more reliable.
3. **Judge-as-secondary-prompt** — a distinct chain with its own rubric and context. Higher fidelity, requires infrastructure.

This codebase uses #3 (the RubricJudge pattern from concept 05) for the eval harness. It doesn't use #1 or #2 on the production hot path.

## Structure pass — layers, axis, seams

Trace one axis: *how independent is the critic from the producer*.

- **Layer 1 — producer (DiagnosticAgent).** Uses `claude-sonnet-4-6`, sees the anomaly + workspace schema + tools.
- **Layer 2 — critic (RubricJudge).** Uses `claude-sonnet-4-6` (same model family, deliberate for cost consistency; could be swapped). Sees the diagnosis + a *different* context set (rubric, known-correct-shape, case-intent, tool trace).

**The seam:** the different context set. That's what makes the critic *independent* enough to be useful. Same model, different eyes. The critic isn't asked "was your answer good" (self-critique with all its bias); it's given a rubric and a ground-truth reference and asked to score.

## How it works

### Move 1 — the shape

You've done code review. Not "I review my own PR" — "someone else, with fresh eyes, reads my PR against a checklist." The reviewer has:

- **The artifact** (your PR).
- **A reference frame** (the style guide, the design doc, the acceptance criteria).
- **Independence from producing it** (they didn't write the code).

The RubricJudge is the code-review analog for LLM outputs. Same three pieces: the artifact (diagnosis), the reference frame (rubric + known-correct-shape), the independence (fresh conversation, different context, no memory of the producing chain's ReAct loop).

```
  Pattern — critique as second-pass review

  producer          artifact         critic
  ┌──────────┐     ┌──────────┐    ┌──────────────┐
  │ chain A  │ ──► │ diagnosis│──► │ RubricJudge  │
  │ (agent)  │     │  JSON    │    │  scores it   │
  └──────────┘     └──────────┘    └──────┬───────┘
                                          │
                                          ▼
                                    ┌──────────────┐
                                    │ judgment     │
                                    │  · dimensions│
                                    │  · verdict   │
                                    │  · fix       │
                                    └──────────────┘

  the "same eyes review the same code" pattern:
  producer is blind to its own biases.
  critic is blind to the reasoning path that led here.
  both blindnesses cover different bugs.
```

### Move 2 — walking the mechanism

#### The RubricJudge invocation

`eval/run.eval.ts:229-247`:

```
const diagnosisJudge = new RubricJudge({
  model: judgeModel,
  rubric: diagnosisQualityRubric,
  capabilityId: 'blooming.eval.diagnosis-judge',
  maxTokens: 4096,
  temperature: 0,
});
const diagnosisJudgmentResult = await diagnosisJudge.judge({
  subject: JSON.stringify(diagnosis, null, 2),
  context: {
    anomaly:            JSON.stringify(goldenCase.anomaly, null, 2),
    known_correct_shape: JSON.stringify(goldenCase.knownCorrect, null, 2),
    case_intent:        goldenCase.intent,
    signal_class:       goldenCase.signalClass,
    tool_calls_trace:   formatToolCallTrace(diagnosisToolCalls),
  },
});
```

Four moving parts:

- **`rubric`** — a `RubricDefinition` (concept 05). Dimensions, scale, verdicts, checks. Structured, versioned (`id: 'blooming-diagnosis-quality-v1'`).
- **`subject`** — the diagnosis under review, serialized JSON.
- **`context`** — the five fields that give the judge independence. `known_correct_shape` is the ground-truth reference; `tool_calls_trace` is what makes the judge able to detect confabulation.
- **`maxTokens: 4096`** — bumped from 2048 because the no-signal case reasoning was longer and truncating. Real production tuning, not premature optimization.

`temperature: 0` — the judge is nondeterministic even at 0 (Anthropic doesn't guarantee determinism), but 0 is the closest we get. Variance across runs is real (concept 05 notes the same case scoring `root_cause_plausibility` 4 or 5 depending on the run).

#### Why this is stronger than classic self-critique

Classic self-critique looks like this:

```
   turn 1  USER: "diagnose this anomaly"
           MODEL: [diagnosis]

   turn 2  USER: "was that correct? critique it."
           MODEL: [critique — sees its own reasoning in context]
```

Two failures:

1. **Bias.** The model sees its own reasoning path from turn 1. It rationalizes rather than reviews. "Yes, my reasoning was sound because..." — the critique is a defense, not an audit.

2. **No ground truth.** The critique has no reference frame beyond the model's own priors. If the model's confabulation is convincing, its critique will be too.

RubricJudge sidesteps both:

- **Fresh conversation.** The judge doesn't see the producing chain's messages. No rationalization loop.
- **Ground-truth reference.** `known_correct_shape` is human-authored per case. The judge grades against that, not against the model's own opinion of correctness.
- **Real evidence via `tool_calls_trace`.** The judge sees the actual tool calls the producer made and the actual results. It can cross-check every claim in the diagnosis against real data.

Receipt `05-no-signal-retention-subscribers-2026-07-03T02-12-17-099Z.json` is the case study. The DiagnosticAgent confidently reasoned about "31.2% payment failure rise, 4,820 high-risk customers, 18.4% conversion drop" — plausible-looking numbers. If we'd asked the same model to self-critique, it likely would have defended its reasoning. RubricJudge, seeing the tool trace, wrote:

> "these numbers originate from tools that do not exist in the workspace or returned synthetic data unrelated to subscription/billing events. The known_correct_shape explicitly flags inventing subscriber counts, churn rates, and MRR numbers as a failure mode. Every cited number is either invented or from a tool whose output is synthetic noise..."

That finding is impossible for classic self-critique. The tool trace + known-correct-shape are what enable it.

#### Self-consistency — what it would look like here

Self-consistency: run the same prompt N times, take the majority vote. Not in this repo, but worth understanding.

For the diagnostic agent, self-consistency would be:

```
   for i in 1..5:
     diagnosis_i = agent.investigate(anomaly)   // ← 5 independent runs
   final_diagnosis = majority_vote(diagnoses[])  // ← consensus
```

Cost: 5× tokens. Reliability: higher, because random model variance averages out.

For the RubricJudge, self-consistency would be:

```
   for i in 1..3:
     judgment_i = judge.judge({ subject: diagnosis, context })
   final_verdict = majority_vote(judgments[].verdict)
```

Cost: 3× judge tokens. Reliability: higher on the borderline cases (concept 05's judgment-stability variance — same anomaly scoring `root_cause_plausibility` 4 or 5 across runs would collapse to a single median score).

This codebase doesn't run self-consistency in the eval — 15-40 minute run × N would be prohibitive. If a specific dimension's variance became loud enough to hide signal, we'd invest.

#### The diminishing-returns problem

A model critiquing its own output has the same blind spots that produced the output. Self-critique catches obvious errors (formatting, missed steps) but misses systematic ones (the confabulation the model finds plausible).

The RubricJudge sidesteps this partly — separate conversation, ground-truth context — but *not fully*. The judge is still an LLM with the same fundamental biases. On subtle judgment calls ("is this hypothesis actually plausible?"), the judge can be wrong in the same direction as the producer. This is why:

- The rubric is multi-dimensional (four dimensions × 5-point scale). Even if the judge is wrong on one dimension, aggregate scores are more stable.
- Human calibration on a subset is important — pull 10 judgments, have a human score them, check judge-vs-human agreement.
- Judge model is versioned separately (`capabilityId: 'blooming.eval.diagnosis-judge'`) so you can track its own drift.

The Hamel Husain framing: LLM-as-judge is useful for *directional* signal, not for *ground truth*. You'd never say "the judge said pass, therefore this is production-ready." You'd say "the judge said pass on 8/10 cases and fail on 2, so let me look at the 2." The judge is a filter, not an oracle.

```
  Flow — where LLM-as-judge sits in the eval chain

  agent output ──► RubricJudge ──► judgment ──► human triage
                       │                            │
                       │                            └── high-confidence fail:
                       │                                 fix the prompt
                       │
                       └── high-confidence pass: skip human review
                           borderline: flag for human review
```

### Move 2 variant — the load-bearing skeleton

Kernel of self-critique done right:

1. **Distinct conversation from the producer.** Drop this and the critic rationalizes rather than reviews.
2. **Ground-truth reference in the context.** Drop this and the critic grades on model priors.
3. **Real evidence available to the critic** (tool trace here). Drop this and the critic can't detect confabulation.
4. **Structured judgment output.** Drop this and you can't aggregate across cases.

Hardening on top: self-consistency (majority vote), calibration slices (judge-vs-human), judge-model rotation, per-dimension trend tracking. None of that is the skeleton.

### Move 3 — the principle

**Independence is what makes critique useful — and it's what classic self-critique lacks.** The RubricJudge is stronger than classic self-critique specifically because it does *not* share memory with the producer. Same model. Different eyes. Different context. Different job. That structural independence is what lets it catch confabulation the producer can't see in its own output.

## Primary diagram

```
  Self-critique — the full recap

  ┌─ Classic self-critique (NOT used here) ────────────────────┐
  │  turn 1  produce                                            │
  │  turn 2  same model, same session: "was that correct?"      │
  │  weaknesses: rationalization loop, no ground truth          │
  └─────────────────────────────────────────────────────────────┘

  ┌─ Self-consistency (NOT used here) ─────────────────────────┐
  │  run same prompt N times                                    │
  │  majority vote across outputs                               │
  │  weaknesses: 2-5× cost per case                             │
  └─────────────────────────────────────────────────────────────┘

  ┌─ Judge-as-secondary-prompt (★ used here ★) ────────────────┐
  │  producer: DiagnosticAgent                                  │
  │      ↓                                                       │
  │  artifact: diagnosis (JSON)                                  │
  │      ↓                                                       │
  │  critic: RubricJudge                                         │
  │    · fresh conversation (no rationalization)                 │
  │    · rubric + known_correct_shape (ground truth)             │
  │    · tool_calls_trace (real evidence)                        │
  │      ↓                                                       │
  │  output: dimensions + verdict + fix                          │
  │                                                              │
  │  captured in eval/receipts/<case>-<runId>.json               │
  └─────────────────────────────────────────────────────────────┘
```

## Elaborate

The RubricJudge pattern is where LLM-as-judge as a discipline landed after two years of iteration. Early self-critique work (Reflexion, Self-Refine papers, 2023) established the technique. Practitioner community (Hamel Husain most vocally) refined it: fresh conversation, ground truth, structured rubric, human calibration on a subset. This codebase implements the practitioner-community version.

The cost math on when self-critique / self-consistency is worth it:

- **Self-consistency at N=3.** Triples the producer cost. Worth it when the base output has high variance and you have no eval to catch regressions. In this repo, evals catch regressions, so self-consistency isn't worth 3× cost on the hot path.

- **Judge-as-secondary-prompt.** Adds one critic call per producer call. Roughly 2× the cost of the producer alone (judge is smaller, but not much). Worth it because the judgment feeds back into the eval score, which is how you iterate on prompts.

- **Both together.** 5-6× cost. Only worth it for safety-critical outputs (medical, legal, content moderation). This repo doesn't cross that bar.

The specific line where LLM-as-judge stops being useful: when the judge's variance approaches the producer's variance. If your judge disagrees with itself 40% of the time on borderline cases, it's not filtering — it's adding noise. This codebase's eval `afterAll` prints per-dimension score distributions specifically so you can see whether the judge is behaving as a filter or as noise. When the distribution is bi-modal (lots of 4s and 5s, few 3s), the judge is filtering. When it's uniform (equal spread across 1-5), the judge is noise.

The interaction with concept 05 (eval-driven iteration): RubricJudge is the mechanism inside the eval harness. Every case's `diagnosisJudgment` in the receipt is a RubricJudge output. The eval discipline (goldens + rubric + receipts) *depends* on RubricJudge working; if the judge were unreliable, the entire eval-driven-iteration story collapses. So investing in judge quality (rubric refinement, calibration, context tuning) has outsized leverage.

The related pattern from other codebases in Rein's portfolio: `AdvntrCue` has a similar critic-like layer for RAG relevance scoring — the retrieved chunks are scored against the query before being included in the final generation. Different domain, same shape — independent critic, structured score, downstream code uses the score to filter.

## Interview defense

**Q: How does this codebase implement self-critique?**

Not classic self-critique — a stronger variant. The RubricJudge at `eval/run.eval.ts:229-247` is a distinct chain with its own rubric, its own context, and its own scoring. It grades diagnoses on 4 dimensions × 5-point scale using ground-truth `known_correct_shape` from each golden case plus the real `tool_calls_trace` from the producing chain. Fresh conversation from the producer, different context, structured output. This is stronger than "ask the same model to critique its answer" because there's no rationalization loop — the critic can't defend the producer's reasoning because it never saw the reasoning path, only the artifact.

```
   classic:  same model + same session → rationalization
   this:     same model + fresh session + rubric + ground truth
                                          → independent audit
```

Anchor: `eval/run.eval.ts:229-247`, `eval/rubrics/diagnosis-quality.ts`.

**Q: What makes the judge able to catch confabulation the producer can't?**

Two things. One, the `known_correct_shape` field — human-authored notes per golden case that explicitly flag failure modes (e.g. "inventing subscriber counts is a fail"). The judge grades against that, not against the model's own priors. Two, the `tool_calls_trace` — the actual tool calls the producer made and their real results. The judge can cross-reference every number cited in the diagnosis against a real tool result. Without the trace, a plausible-sounding invented number scores well; with the trace, the judge writes "this number is not in any tool result." Receipt `05-no-signal-retention-subscribers` is the canonical example — 4,820 confabulated "high-risk customers" caught by trace cross-reference.

```
  producer  ──► diagnosis with "4,820 customers"
  judge     ──► reads tool_calls_trace ──► "no tool returned that number" ──► score 1
```

Anchor: `eval/run.eval.ts:238-247` (judge context), `eval/receipts/05-no-signal-retention-subscribers-*.json` (the found confabulation).

## See also

- 05 · eval-driven iteration — the RubricJudge is the mechanism inside the eval harness.
- 09 · chain-of-thought — the structured `hypothesesConsidered` reasoning is what the judge grades on.
- 02 · structured outputs — the judgment itself is a structured output (dimensions, verdict, fix).
- 06 · single-purpose chains — the judge is another single-purpose chain with a scoped job.
