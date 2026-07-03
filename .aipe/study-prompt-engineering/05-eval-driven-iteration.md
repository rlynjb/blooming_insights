# 05 · Eval-driven prompt iteration

**Eval-driven prompting / golden sets / LLM-as-judge / rubric evaluation — Industry standard**

## Zoom out, then zoom in

The line between amateur and professional prompt work is this: an amateur iterates by vibes ("the response feels better now"). A professional iterates against a golden set with a rubric-based judge and per-case receipts, and only ships a prompt change when the judge scores hold or improve. In this codebase, the discipline is real: 10 golden cases, two rubrics with four dimensions each, a `RubricJudge` that scores every diagnosis and every recommendation, per-case JSON receipts, and a signal-class-aware gate that lets no-signal cases inform without turning into failures.

```
  Zoom out — where evals sit

  ┌─ Agent under test ───────────────────────────────────────┐
  │  DiagnosticAgent · RecommendationAgent                   │
  │  produces: Diagnosis, Recommendation[]                    │
  └────────────────────────┬────────────────────────────────┘
                           │  subject
  ┌─ Rubric ───────────────▼────────────────────────────────┐
  │  diagnosisQualityRubric (4 dims × 5-point scale)         │
  │  recommendationQualityRubric (4 dims × 5-point scale)    │
  │  verdicts: pass, pass_with_notes, fail                    │
  └────────────────────────┬────────────────────────────────┘
                           │  input
  ┌─ RubricJudge ──────────▼────────────────────────────────┐
  │  ★ SECONDARY LLM CALL — JUDGE-AS-PROMPT ★                 │  ← we are here
  │  system: buildRubricJudgeSystemPrompt(rubric)             │
  │  user:   buildRubricJudgeUserPrompt({subject, context})   │
  │  returns: structured judgment (dims + verdict + fix)      │
  └────────────────────────┬────────────────────────────────┘
                           │
  ┌─ Receipt ──────────────▼────────────────────────────────┐
  │  eval/receipts/<caseId>-<runId>.json                      │
  │  written per case; walked in afterAll for the summary     │
  └───────────────────────────────────────────────────────────┘
```

**Zoom in.** Three things live in this concept, and they compose into one loop. **Golden set** — hand-curated cases with a known-correct shape. **Rubric-based judge** — a secondary LLM call scored against a schema of dimensions and verdicts (see `02-structured-outputs.md` — the judge itself uses structured output). **Receipts + regression gate** — per-case JSON that lets you diff across runs and a test-runner gate that fails on regression. Miss any one and you're back to vibes.

## Structure pass

### Axes — the dimension we're tracing

**Reproducibility of the judgment.** If the same input goes into the same rubric with the same judge model, do you get the same verdict? Trace this axis and you find the load-bearing parts of the eval infrastructure — the judge's system prompt structure, the context you pass in, the temperature setting, the judge model's own drift across versions.

### Seams — where reproducibility flips

Three seams:

- **Agent output vs judge input** — the diagnosis JSON crosses from "produced" to "evaluated." What's carried across that boundary determines what the judge can score. If you pass only the diagnosis and not the anomaly + tool_calls_trace as context, the judge scores in the abstract instead of against the case.
- **Rubric definition vs judge system prompt** — the rubric is a TypeScript object; the judge system prompt is a string. `buildRubricJudgeSystemPrompt` converts one to the other. That conversion is deterministic given the rubric, so rubric changes are the only way the judge's system prompt drifts.
- **Judge model vs judge output** — the judge uses the same Sonnet 4.6 as the agent (temperature 0). Different session, different sampling, but same model. Judgment stability across runs is a *known variance* in this codebase — same anomaly on the same substrate produced `root_cause_plausibility: 5` on one run and `4` on another. This is documented in the task briefing as real, and it's why you look at *distributions across cases* rather than single-case scores.

### Layered decomposition

"What produced this verdict?" — traced across the layers:

```
  "What produced this verdict?" — same question, three altitudes

  ┌────────────────────────────────────────────────┐
  │ outer: the whole run (10 cases)                 │  → runId + git SHA +
  │                                                 │    prompt package versions
  └────────────────────────────────────────────────┘
      ┌────────────────────────────────────────────┐
      │ middle: this specific case                  │  → caseId + signal_class
      │        (01-conversion-drop-mobile-checkout)  │   + anomaly + goldens.knownCorrect
      └────────────────────────────────────────────┘
          ┌────────────────────────────────────────┐
          │ inner: this specific judgment           │  → subject (Diagnosis JSON)
          │        (root_cause_plausibility: 4)     │   + context (anomaly, trace)
          │                                          │   + rubric.dimensions[i]
          └────────────────────────────────────────┘
```

Every level answers the same question, and every level's answer becomes context for the level below.

## How it works

### Move 1 — the mental model

You know how a Jest test has a subject-under-test, an expected-value assertion, and a diff-on-fail? An eval is that, but the assertion is fuzzy — instead of `expect(x).toBe(y)` you have a rubric that scores 1-5 across dimensions, and instead of a single expected value you have a known-correct *shape* the diagnosis is supposed to match.

```
  Eval — the pattern

  ┌─ golden case ───────────┐
  │  anomaly                │  ← what to investigate
  │  knownCorrect            │  ← what shape the diagnosis should have
  │  signalClass             │  ← has-signal / no-signal / partial / positive
  └────────────┬────────────┘
               │
               ▼
  ┌─ agent runs ───────────────────────┐
  │  diagnostic.investigate(anomaly)   │
  │  → diagnosis                        │
  │  → tool_calls_trace                 │
  └────────────┬────────────────────────┘
               │
               ▼
  ┌─ judge scores ─────────────────────┐
  │  RubricJudge.judge({                │
  │    subject: diagnosis,               │
  │    context: {anomaly, known,         │
  │      trace, intent, signalClass}     │
  │  })                                  │
  │  → judgment {dims, verdict, fix}     │
  └────────────┬────────────────────────┘
               │
               ▼
  ┌─ receipt ──────────────────────────┐
  │  JSON per case, per run             │
  │  aggregated in afterAll             │
  └────────────────────────────────────┘
```

### Move 2 — the step-by-step walkthrough

**Step 1 — the golden case is a specific shape.**

`eval/goldens/01-conversion-drop-mobile-checkout.ts:9-60`:

```ts
const anomaly: Anomaly = {
  metric: 'conversion_rate',
  scope: ['mobile', 'checkout', 'SP'],
  change: { value: 18.4, direction: 'down', baseline: 'prior_7d (0.038 → 0.031)' },
  severity: 'critical',
  evidence: [{ ...tool, result: { current_7d: {...}, prior_7d: {...}, funnel: {...} } }],
  ...
};

export const goldenCase: GoldenCase = {
  caseId: '01-conversion-drop-mobile-checkout',
  signalClass: 'has-signal',
  intent: 'The canonical happy path — clear anomaly, substrate has co-occurring payment_failure signal, agent should name payment processor as the primary mechanism and stay in mobile/checkout/SP scope.',
  anomaly,
  knownCorrect: {
    primary_signal: 'checkout → purchase step is where the funnel breaks; upstream steps are stable relative to prior week',
    co_occurring_signal: 'payment_failure_rate rose 31.2% in the same window (0.035 → 0.046)',
    most_likely_root_cause_candidates: [ 'payment processor issue affecting mobile credit_card in SP', ... ],
    scope_should_stay_within: ['mobile', 'checkout', 'SP', 'credit_card'],
    red_herrings_to_avoid: ['desktop conversion — no evidence in scan', ...],
  },
};
```

Four things worth noting. First, `anomaly` is the *input* to the agent — what the monitoring layer would have handed the diagnostic layer. Second, `knownCorrect` is the *shape* the judge scores against — not a single expected string, but a set of primary signals, root-cause candidates, scope boundaries, and red herrings. Third, `signalClass` is the case's *character* (has-signal, no-signal, partial-signal, positive). Fourth, `intent` is prose that tells the judge (and the reader) what this case exists to prove.

The reason `knownCorrect` isn't a single expected diagnosis: the diagnosis is inherently non-deterministic (the LLM chooses between the two most-likely candidates on a given run), and locking to one specific string would make the test fail on legitimate rewrites. The rubric scores against *shape*, not string.

**Step 2 — the rubric defines the dimensions and the scale.**

`eval/rubrics/diagnosis-quality.ts:15-108` (excerpts):

```ts
export const diagnosisQualityRubric: RubricDefinition = {
  id: 'blooming-diagnosis-quality-v1',
  title: 'Diagnosis quality',
  task: `Judge a diagnosis produced by an AI analyst investigating an ecommerce anomaly.
The diagnosis will be JSON with these fields: conclusion (one-sentence root cause),
evidence (bullet list of what supported the conclusion), hypothesesConsidered...`,
  dimensions: [
    {
      id: 'root_cause_plausibility',
      label: 'Root-cause plausibility',
      description: 'Does the conclusion name a plausible mechanism (not just a symptom restatement)?',
      scale: [
        { score: 1, description: 'Restates the symptom; no mechanism named.' },
        { score: 2, description: 'Vague mechanism, no evidence link.' },
        { score: 3, description: 'Plausible mechanism, weakly evidenced.' },
        { score: 4, description: 'Specific mechanism, evidence supports it.' },
        { score: 5, description: 'Specific mechanism, evidence directly supports it, and rival mechanisms are considered.' },
      ],
    },
    // evidence_grounding, scope_coherence, actionable_next_step
  ],
  verdicts: [
    { verdict: 'pass', description: 'All four dimensions at ≥4...' },
    { verdict: 'pass_with_notes', description: 'Overall usable but one or more dimensions at 3...' },
    { verdict: 'fail', description: 'Any dimension at ≤2...' },
  ],
  checks: [
    'cites at least one number from the tool results',
    'stays within the anomaly scope',
    'names at least one specific action',
    'does not invent numbers not present in the evidence',
  ],
};
```

Two structural notes. First, each dimension has all five scale levels named specifically — not "score 1 = bad, score 5 = good," but "score 1 = restates the symptom" and "score 5 = specific mechanism, evidence directly supports it, and rival mechanisms are considered." Anchoring the scale prevents the judge from drifting toward "3 for anything I'm not sure about." Second, `checks` are binary — the judge either can or can't verify the property. Binary checks are the ratchet that stops the fuzzy dimensions from being the only signal.

**Step 3 — the judge builds a system prompt from the rubric.**

`@aptkit/core/node_modules/@aptkit/evals/dist/src/rubric-judge.js:31-77`:

```js
export function buildRubricJudgeSystemPrompt(rubric) {
    const dimensions = rubric.dimensions.map((d) => {
        const scale = d.scale.map((l) => `  ${l.score} = ${l.description}`).join('\n');
        return `${d.id} ${d.label}: ${d.description}\n${scale}`;
    }).join('\n\n');
    const verdicts = rubric.verdicts.map((r) => `- ${r.verdict}: ${r.description}`).join('\n');
    const checks = rubric.checks?.length
        ? `\nChecks to return as booleans:\n${rubric.checks.map((c) => `- ${c}`).join('\n')}\n`
        : '';
    // ... builds the JSON output shape
    return [
        `You are a rubric judge for: ${rubric.title}.`,
        rubric.task,
        '',
        'Score the subject against the rubric. Score meaning and evidence, not style preferences unless the rubric asks for style.',
        'Never rewrite the subject. Return one highest-leverage fix, not a list.',
        '',
        'Rubric dimensions:',
        dimensions,
        '',
        'Allowed verdicts:',
        verdicts,
        checks.trimEnd(),
        ...
        'Output JSON only. No prose. No markdown fences. Use exactly this shape:',
        JSON.stringify(outputShape),
    ].filter(Boolean).join('\n');
}
```

The judge's system prompt is *generated from the rubric*, not hand-written. This is the load-bearing move: the rubric is the source of truth, and any change to the rubric changes the judge's system prompt deterministically. Two rubrics with the same shape produce two judges with the same anatomy. This is meta-prompting (see `11-meta-prompting.md`), applied to the evaluation seam specifically.

```
  Judge system prompt — assembled from the rubric

  rubric.dimensions        →  "root_cause_plausibility: Does the ...
                              1 = Restates the symptom.
                              2 = Vague mechanism..."
  rubric.verdicts           →  "- pass: All four dimensions at ≥4..."
  rubric.checks             →  "cites at least one number from tool results"
  rubric.task              →  "Judge a diagnosis produced by ..."

  ────────────────────────  (concatenated in order)  ─────────────────────
                                   │
                                   ▼
                    the JUDGE's system prompt
                    (deterministic given the rubric)
```

**Step 4 — the judge user prompt carries the context that makes grounding possible.**

`@aptkit/core/node_modules/@aptkit/evals/dist/src/rubric-judge.js:79-84`:

```js
export function buildRubricJudgeUserPrompt(input) {
    const context = input.context && Object.keys(input.context).length > 0
        ? `Context:\n${Object.entries(input.context).map(([k, v]) => `${k}: ${v}`).join('\n')}\n\n`
        : '';
    return `${context}Subject:\n${input.subject}`;
}
```

Two blocks — context, then subject. Context is what the judge needs to score meaningfully; subject is what's being scored. In `eval/run.eval.ts:238-247`:

```ts
const diagnosisJudgmentResult = await diagnosisJudge.judge({
  subject: JSON.stringify(diagnosis, null, 2),
  context: {
    anomaly: JSON.stringify(goldenCase.anomaly, null, 2),
    known_correct_shape: JSON.stringify(goldenCase.knownCorrect, null, 2),
    case_intent: goldenCase.intent,
    signal_class: goldenCase.signalClass,
    tool_calls_trace: formatToolCallTrace(diagnosisToolCalls),
  },
});
```

Five context fields. The `tool_calls_trace` is what distinguishes "grounded in the tool call" from "invented" — without it, the judge can't tell whether a number in the diagnosis came from a real tool result or from the model's priors. `formatToolCallTrace` (`eval/run.eval.ts:132-152`) truncates each result to 4000 chars so a single 40K JSON tool response doesn't blow the judge's context budget:

```ts
const raw = JSON.stringify(c.result);
const truncated =
  raw.length > 4000 ? raw.slice(0, 4000) + `… [truncated, ${raw.length} total chars]` : raw;
lines.push(`result: ${truncated}`);
```

That 4000-char cap is the token-budget lever inside the eval — same discipline as `schemaSummary` (see `04-token-budgeting.md`), applied at the eval boundary rather than the agent boundary.

```
  Judge context — what makes grounded scoring possible

  ┌─ anomaly ────────────┐  what the agent was investigating
  ├─ known_correct_shape ┤  what the diagnosis should look like
  ├─ case_intent         ┤  why this case exists (prose)
  ├─ signal_class        ┤  has-signal / no-signal / …
  └─ tool_calls_trace    ┘  what the agent actually queried and saw
                             ↑
                    without this, "cites a number" is unverifiable
                    (the judge doesn't know what tools returned)
```

**Step 5 — the receipt is the audit trail.**

`eval/run.eval.ts:341-395` builds the receipt. Every case, every run, one JSON file. Fields include timings, tool calls with args + durations, usage + cost (from `summarizeUsage` + `estimateCost`), budget snapshot, the diagnosis itself, the judgment (dimensions + verdict + fix), the recommendations, and their judgments. Files land in `eval/receipts/<caseId>-<runId>.json`. The `afterAll` block walks that directory, filters to this run's files, prints per-case verdicts, per-dimension pass rates, and a distinct-score-count check (the escape-hatch check — if a dimension shows only one distinct score across all cases, the substrate is too homogeneous and the judge isn't discriminating).

**Step 6 — the gate that lets no-signal cases inform without failing.**

`eval/run.eval.ts:407-424`:

```ts
const isGated =
  goldenCase.signalClass === 'has-signal' ||
  goldenCase.signalClass === 'partial-signal';
if (isGated) {
  expect(receipt.diagnosisJudgment.verdict).not.toBe('fail');
  for (const rj of receipt.recommendationJudgments) {
    expect(rj.judgment.verdict, `case ${goldenCase.caseId} rec "${rj.recommendationTitle}"`).not.toBe('fail');
  }
}
```

Only `has-signal` and `partial-signal` cases are gated as pass/fail. `no-signal` cases (where the anomaly is spurious and the agent *should* confabulate less rather than more) are measured but not gated — a fail on a no-signal case is a data point, not a build break. Same for `positive` (an improvement, where the agent should recognize the shift without over-recommending). This shape lets the eval carry cases the agent isn't optimized for without turning every ambiguous verdict into a red build.

```
  Signal-class-aware gate

  ┌─ signal class ───┬─ gated? ─┬─ meaning of fail ────────────┐
  │ has-signal       │  YES      │ agent regressed on happy path│
  │ partial-signal   │  YES      │ agent regressed on ambiguity │
  │ no-signal        │  NO       │ data point — confabulation? │
  │ positive         │  NO       │ data point — over-recommend? │
  └──────────────────┴──────────┴──────────────────────────────┘
```

### Move 2 variant — the load-bearing skeleton

The kernel of eval-driven prompt iteration is five moves, in order:

```
  golden set → rubric → judge (LLM secondary call) → receipt → regression gate
```

What breaks if you skip each:

- **Skip "golden set"** — you're back to vibes. Every prompt change is a stab. You can't distinguish "the response feels better" from "I got lucky on the one case I checked."
- **Skip "rubric"** — the judge scores in prose. The scores drift. You can't aggregate across cases because "pretty good, some issues" isn't a comparable value.
- **Skip "judge as LLM secondary call"** — you're doing manual review. Scales to ~10 cases and dies. The moment you have 50 cases you cannot ship prompt changes because each PR takes an hour of eyeballing to review.
- **Skip "receipt"** — you can't diff across runs. Every run is a fresh view; every regression is a "wait, was that always failing?"
- **Skip "regression gate"** — evals are advisory. Team ships prompt changes that regress on cases nobody re-checked. The gate is what makes evals load-bearing instead of a dashboard nobody reads.

Hardening layered on top: LLM-vs-human agreement calibration (`eval/compute-agreement.eval.ts` — the calibration slice that measures whether the judge's scores match a human's), signal-class breakdown in the summary (per-signal pass rate, not just overall), distinct-score-count check (guards against the substrate being too homogeneous for meaningful scores).

### Move 3 — the principle

**Evals are how prompt iteration becomes engineering.** Without them, prompts drift as fast as the person writing them can retype. With them, every change is a diff against a known set of cases and a measurable outcome. The discipline scales the moment you have more than three cases you can no longer eyeball, which is roughly week one of any real LLM feature.

## Primary diagram

```
  Eval-driven iteration — the full loop

  ┌── golden set (10 cases) ──────────────────────────────────┐
  │  01-conversion-drop-mobile-checkout   (has-signal)         │
  │  02-fraud-payment-failure-credit-card  (has-signal)        │
  │  03-session-drop-organic-mobile        (has-signal)        │
  │  04-cart-abandonment-mobile-broad      (partial-signal)    │
  │  05-no-signal-retention-subscribers    (no-signal)         │
  │  06-no-signal-price-sensitivity-luxury (no-signal)         │
  │  07-positive-conversion-surge-mobile   (positive)          │
  │  08-checkout-collapse-multi-scope      (has-signal)        │
  │  09-engagement-drop-email-campaign     (has-signal)        │
  │  10-no-signal-seo-organic              (no-signal)         │
  └────────────────────┬──────────────────────────────────────┘
                       │
                       ▼  for each case:
  ┌── agent under test ──────────────────────────────────────┐
  │  DiagnosticAgent.investigate(anomaly) → diagnosis         │
  │  RecommendationAgent.propose(anomaly, dx) → recs          │
  │  captures: tool_calls_trace, usage, cost, budget          │
  └────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
  ┌── judge (secondary LLM call) ────────────────────────────┐
  │  system: buildRubricJudgeSystemPrompt(rubric)             │
  │  user:   subject + context (anomaly, known,               │
  │          case_intent, signal_class, tool_calls_trace)     │
  │  returns: {dimensions{}, verdict, fix, checks{}}          │
  └────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
  ┌── receipt per case ───────────────────────────────────────┐
  │  eval/receipts/<caseId>-<runId>.json                       │
  │  written by writeFileSync at end of each `it` case          │
  └────────────────────┬──────────────────────────────────────┘
                       │
                       ▼  afterAll:
  ┌── summary + gate ────────────────────────────────────────┐
  │  per-case verdicts table                                  │
  │  per-dimension pass rate (score ≥ 4)                      │
  │  distinct-score-count check (escape hatch)                │
  │  gate: has/partial-signal cases MUST not be `fail`        │
  └───────────────────────────────────────────────────────────┘
```

## Elaborate

Hamel Husain's writing on evals is the canonical reference for this discipline. His posts on "your AI needs an eval set" and the working shape of LLM-as-judge are what most production teams reach for when they build the first version of an eval harness. If you read one thing after this file, read him.

The `RubricJudge` shape in `@aptkit/core` is a specific take on LLM-as-judge — dimensions on a 1-5 scale with named descriptions for each level, verdicts as the roll-up, binary checks as the ratchet, and a `fix` field for the highest-leverage suggestion. It's not the only shape. Some teams use pairwise comparisons (which of two outputs is better) instead of absolute scoring. Some use single-dimension binary judgments (was this a good answer, yes/no). The tradeoff: absolute scoring is easier to aggregate and correlate to prompt changes, but drifts more across judge model versions; pairwise is more stable but harder to interpret across cases.

Two specific gaps in this codebase worth naming honestly. First, judgment stability is a known variance: the task briefing documents that `root_cause_plausibility` came back 5 on one Session B run and 4 on Session A for the same anomaly on the same substrate. This is real, and it's why you look at *distributions across cases and runs*, not single-case scores. Second, the calibration slice (`eval/calibration/`) measures LLM-vs-human agreement — the load-bearing question of whether the judge is a proxy for a human's judgment. If agreement is low, the whole judge-as-signal argument collapses.

The 4000-char tool result truncation in `formatToolCallTrace` is the specific token-budget lever inside the eval. Same discipline as `schemaSummary` (see `04-token-budgeting.md`), applied at the eval boundary. If the judge starts scoring badly because it can't see the whole tool result, you widen the cap. If the judge's own input token bill grows unmanageable, you tighten.

Related concepts:
- **Structured outputs** (`02-structured-outputs.md`) — the judge itself uses structured output; the rubric's outputShape is a JSON schema the judge must satisfy.
- **Token budgeting** (`04-token-budgeting.md`) — the 4000-char truncation in the judge context.
- **Meta-prompting** (`11-meta-prompting.md`) — `buildRubricJudgeSystemPrompt` is meta-prompting applied to the eval boundary.

## Interview defense

**Q: Walk me through the eval loop in this codebase from golden case to gate.**

Ten golden cases in `eval/goldens/`, each with an anomaly, a `knownCorrect` shape, a signal class, and prose intent. For each case, the harness runs `DiagnosticAgent.investigate` then `RecommendationAgent.propose`, capturing tool calls, usage, and cost. Each output goes through a `RubricJudge` — a secondary LLM call using a rubric of four dimensions × 5-point scale plus binary checks plus verdict roll-up. The judge sees the subject plus context including the tool-calls trace (formatted with per-call args + truncated results), which is what lets it distinguish grounded numbers from invented ones. The output is a per-case JSON receipt in `eval/receipts/`. The `afterAll` block aggregates per-dimension pass rates and gates the run — `has-signal` and `partial-signal` cases must not verdict as `fail`; `no-signal` and `positive` cases are measured but not gated because they're testing confabulation and over-recommendation, not the happy path.

Anchors: `eval/run.eval.ts` for the harness, `eval/rubrics/diagnosis-quality.ts:15-108` for the rubric shape, `@aptkit/core/node_modules/@aptkit/evals/dist/src/rubric-judge.js:31-77` for the judge system prompt builder.

```
  The gate — signal-class-aware

  has-signal, partial-signal:  gated on `verdict !== fail`
  no-signal, positive:          measured, not gated
```

**Q: You changed a prompt. The eval passes but the average judge score dropped from 4.2 to 3.9. Do you ship?**

Depends on the distribution, not the average. Look at the per-dimension pass rates first — if `root_cause_plausibility` held at 90% pass but `evidence_grounding` dropped from 100% to 60%, that's a real regression on a specific dimension and I don't ship. If every dimension dropped by ~0.3 and the pass rate is unchanged (all cases still score ≥ 4), that's a judge drift artifact — the same rubric run against the same outputs won't produce identical scores across runs. Second thing I check: the distinct-score-count check in the escape-hatch block. If a dimension went from 3-distinct-scores to 1-distinct-score, the judge stopped discriminating and the "improvement" is meaningless. Third: I look at the `fix` field on the failing cases — that's where the highest-leverage regression signal is, per the rubric's own instruction.

```
  Score dropped 4.2 → 3.9 — decision tree

  per-dimension pass rate unchanged? → likely judge drift, ship
  one dimension dropped hard?         → real regression, revert
  distinct-score-count collapsed?     → judge stopped discriminating,
                                        don't ship, fix the rubric
```

**Q: What's the load-bearing part people forget?**

Context. Everyone builds a rubric and forgets to pass the tool_calls_trace to the judge. The rubric asks "does the diagnosis cite evidence?" — but if the judge doesn't see what evidence was available, it can't verify grounding. It scores in the abstract. The fix in this codebase — `context: { anomaly, known_correct_shape, case_intent, signal_class, tool_calls_trace }` at `eval/run.eval.ts:239-246` — is what turned the judge from "produces vibes-shaped scores" into "produces grounded scores you can debug from." Every eval I've built without a tool-call trace was easier to game than any I've built with one.

Anchor: `formatToolCallTrace` at `eval/run.eval.ts:132-152` and its use as the `tool_calls_trace` context field.

```
  Judge context — the tool-call trace is the load-bearing part

  ┌── without tool_calls_trace ────────────────────────┐
  │ judge sees: diagnosis, anomaly, known-correct       │
  │ can score: "reads plausible," "in-scope"            │
  │ CANNOT score: "invented number" vs "real citation"  │
  └────────────────────────────────────────────────────┘

  ┌── with tool_calls_trace ────────────────────────────┐
  │ judge sees: everything above + every tool_call.args │
  │             + truncated result                      │
  │ CAN score: "cites a number that came from tool X"   │
  └────────────────────────────────────────────────────┘
```

## See also

- `02-structured-outputs.md` — the judge itself uses structured output.
- `04-token-budgeting.md` — the 4000-char truncation in `formatToolCallTrace`.
- `10-self-critique.md` — LLM-as-judge is a specific shape of "another LLM checks the output."
- `11-meta-prompting.md` — `buildRubricJudgeSystemPrompt` builds a prompt from data.
