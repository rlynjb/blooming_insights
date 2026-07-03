# 10 · Self-critique and self-consistency

**Self-critique / LLM-as-judge / self-consistency / verify-then-emit — Industry standard**

## Zoom out, then zoom in

A model critiquing its own output has the same blind spots that produced the output. That's the honest headline. The technique still works — under specific conditions — because critique and generation are different modes and the model does catch a class of errors on critique that it missed on generation. In this codebase, self-critique is realized as **LLM-as-judge** (see `05-eval-driven-iteration.md`) — a *different* prompt (the RubricJudge) scores the diagnostic agent's output against a rubric. Not the same LLM turn critiquing itself; a *secondary* LLM call with different context, different task, and different scoring criteria. That's the shape that earns tokens.

```
  Zoom out — where self-critique sits

  ┌─ Generation ────────────────────────────────────────────┐
  │  DiagnosticAgent produces Diagnosis                     │
  │  Same LLM, same context, same call                      │
  └────────────────────────┬────────────────────────────────┘
                           │
  ┌─ ★ CRITIQUE STAGE ★ ────▼───────────────────────────────┐
  │  RubricJudge scores the Diagnosis                       │  ← we are here
  │  DIFFERENT prompt, DIFFERENT context (rubric-shaped),   │
  │  same underlying model, temperature 0                   │
  │  outputs: dimensions{}, verdict, fix                    │
  └────────────────────────┬────────────────────────────────┘
                           │
  ┌─ Consumer ─────────────▼────────────────────────────────┐
  │  eval receipt writes judgment alongside diagnosis        │
  │  regression gate: has-signal + partial-signal must not   │
  │  verdict as fail                                         │
  └─────────────────────────────────────────────────────────┘
```

**Zoom in.** Self-critique has three common shapes: (1) **same-turn critique** — "produce an answer, then critique it, then revise" in one long generation. Cheap but blind. (2) **secondary-call critique** — a different LLM call reads the output and scores it. This is what's in production. (3) **self-consistency** — run the same prompt N times, majority-vote the answer. Expensive but catches the "one weird sample" case. This codebase uses shape (2) as LLM-as-judge in the eval pipeline. Shape (1) is not used in the agent loop itself — production diagnoses don't get re-verified before shipping to the UI.

## Structure pass

### Axes — the dimension we're tracing

**What is the critique blind to?** A model critiquing its own output tends to be blind to *the same blind spots* that produced the output — because it reads the output the same way. A rubric-anchored critique with different context (like `tool_calls_trace`) can catch different things because the *context* forces different attention. Trace this axis and you find where self-critique earns tokens and where it's ceremony.

### Seams — where critique catches vs misses

Three seams:

- **Same-turn vs secondary-call** — same-turn critique is generation continuing under the same context; secondary-call critique is a fresh generation with a different prompt shape. The secondary call has the option to see things (rubric criteria, tool traces) the generating call never had.
- **Rubric-anchored vs free-form** — rubric-anchored critique scores against named dimensions; free-form critique produces "here are three things I could improve" prose. Rubric-anchored is parseable and gates decisions; free-form is a dashboard read.
- **Judge-of-answer vs self-consistency** — judge-of-answer scores one output. Self-consistency runs N outputs and votes. Different failure modes; different costs.

### Layered decomposition

"What does the critique see that generation missed?" — traced down:

```
  "What does critique catch?" — same question, three altitudes

  ┌────────────────────────────────────────────────┐
  │ outer: format bugs (JSON malformed, wrong fields│  → validators already
  │        missing)                                 │    catch these
  └────────────────────────────────────────────────┘
      ┌────────────────────────────────────────────┐
      │ middle: content bugs (invented numbers,     │  → critique catches
      │         out-of-scope claims)                │    when it has the
      │                                             │    tool_calls_trace
      └────────────────────────────────────────────┘
          ┌────────────────────────────────────────┐
          │ inner: reasoning bugs (wrong root       │  → critique often
          │        cause given the evidence)        │    misses because
          │                                          │    critique-mode has
          │                                          │    same priors
          └────────────────────────────────────────┘
```

The middle layer is where LLM-as-judge is most useful. The inner layer — deep reasoning bugs — is where self-critique tends to be blind, because critique-mode brings the same priors that generation brought.

## How it works

### Move 1 — the mental model

You know how a code review by the *same engineer* who wrote the code catches typos but misses the wrong-abstraction bug — because you read your own code with the assumptions you had when writing it? Self-critique is that. A *different reviewer* (or the same person after a day of distance) catches more. LLM-as-judge is engineering that distance: a fresh prompt shape, different task framing, sometimes different context, so the "same model" comes at the output cold.

```
  Same-turn critique vs secondary-call critique

  same-turn (weak):                       secondary-call (this codebase):

  ┌── one LLM call ───────────────┐        ┌── generation call ──┐   ┌── critique call ──┐
  │  "Produce a diagnosis, then    │        │  agent context      │   │  judge context     │
  │   critique it, then revise."  │        │  (anomaly, tools,   │──▶│  (subject +       │
  │                                │        │   loop history)     │   │   rubric +         │
  │  same context, same priors    │        │                     │   │   tool_calls_trace)│
  └────────────────────────────────┘        └─────────────────────┘   └────────────────────┘

  reads own output as author              reads output as reviewer,
  catches: format bugs                    catches: shape + grounding
  misses: reasoning bugs                  catches: reasoning bugs
                                          (with tool_calls_trace)
```

### Move 2 — the step-by-step walkthrough

**Step 1 — the secondary call has a different prompt shape.**

`@aptkit/core/node_modules/@aptkit/evals/dist/src/rubric-judge.js:61-77`:

```js
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
```

The judge prompt is not "here's a diagnosis, is it good?" — it's a *rubric-shaped* prompt that names dimensions, scales, verdicts, and a specific output structure. The task framing is "you are a rubric judge," not "review this diagnosis." That reframing pushes the model into critique-mode with specific criteria, not generation-mode with continuation instincts.

**Step 2 — the context makes critique grounded rather than vibes-based.**

`eval/run.eval.ts:238-247`:

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

The context is what makes this critique valuable and not ceremony. Without `tool_calls_trace`, the judge is asked "is this a good diagnosis?" — it can only score in the abstract. With `tool_calls_trace`, the judge can verify "did the diagnosis cite a number that came from an actual tool result, or did it invent one?" — grounded critique. This is the specific reason self-critique tends to be blind to reasoning bugs unless you deliberately supply the context the original generation had *plus* something the original didn't have.

```
  Critique context — what makes it grounded

  ┌── original generation saw ────────────────────────┐
  │  anomaly, tool results (during loop), schema      │
  │  BUT NOT: the rubric, the known-correct shape     │
  └────────────────────────┬──────────────────────────┘
                           │
  ┌── critique sees ───────▼──────────────────────────┐
  │  anomaly (same)                                    │
  │  tool_calls_trace (same, but as one artifact)      │
  │  known_correct_shape (NEW — generation didn't have)│
  │  rubric dimensions (NEW — generation didn't have)  │
  │  signal_class (NEW — generation didn't have)       │
  └────────────────────────────────────────────────────┘

  the NEW context is what lets critique catch what generation missed
```

**Step 3 — the outputs are structured, not free-form.**

The judge returns:

```json
{
  "dimensions": {
    "root_cause_plausibility": { "score": 4, "reason": "…" },
    "evidence_grounding":       { "score": 5, "reason": "…" },
    ...
  },
  "checks": { "cites at least one number from the tool results": true, ... },
  "verdict": "pass",
  "fix": "The one highest-leverage improvement…",
  "reasoning": "…"
}
```

Structured critique is the difference between "this is a dashboard read" and "this gates a decision." The eval harness reads `verdict`, gates on `pass|pass_with_notes|fail`, and aggregates `dimensions` across cases. A free-form critique ("here are some thoughts on the diagnosis…") can't gate anything.

**Step 4 — the specific bug that self-critique catches in this codebase.**

Look at the `evidence_grounding` dimension in `eval/rubrics/diagnosis-quality.ts:41-55`:

```ts
{
  id: 'evidence_grounding',
  label: 'Evidence grounding',
  description: 'Does the diagnosis cite the actual signals the substrate exposed? Bonus if it names the co-occurring signals (e.g. the payment_failure spike alongside the conversion drop). Penalty for invented numbers or claims not derivable from the tool results.',
  scale: [
    { score: 1, description: 'Numbers or claims that contradict the evidence.' },
    { score: 2, description: 'Vague evidence references; no specific numbers cited.' },
    { score: 3, description: 'Cites at least one specific number from the evidence.' },
    { score: 4, description: 'Cites multiple specific signals; notes at least one co-occurring signal.' },
    { score: 5, description: 'Cites the primary and co-occurring signals; every claim is traceable to a tool result.' },
  ],
},
```

Score 1 explicitly says "numbers or claims that contradict the evidence." This is the confabulation bug — the model invents a plausible-sounding number that isn't in the tool results. Same-turn self-critique tends to miss this because the same generative priors that invented the number will accept it as plausible on re-read. Secondary-call critique WITH the tool_calls_trace catches it — because the judge is asked "is this number in the trace?" and the trace is right there to check.

```
  Confabulation — what critique catches when it has the trace

  generation:   "payment failures rose 31.2%" (real)
                "payment failures rose 45%"   (invented — sounds right)

  same-turn critique:   both look plausible; skims accept both
  secondary + trace:    checks 31.2% against trace → found
                        checks 45% against trace → NOT found → flag
                        evidence_grounding score drops to 1
```

**Step 5 — where self-consistency lives (and doesn't).**

Self-consistency is running the same prompt N times and voting. This codebase does not use it for the main agent output — the diagnostic agent runs once per anomaly, and its output ships. There is a related pattern in the eval infrastructure: the calibration slice at `eval/compute-agreement.eval.ts` and `eval/calibration/` measures judge-vs-human agreement, and if agreement is low the whole judge-as-signal argument collapses. That's a *different* discipline — measuring the reliability of the judge — but it borrows the self-consistency idea (multiple observations of the same case, do they agree?).

Where I'd reach for real self-consistency: high-stakes classification where wrong is costly (say, content moderation) and the cost of running the classifier 3-5 times and voting is small. Not for the diagnostic loop, which is already ~50 seconds per case and would triple in cost for marginal reliability gain.

**Step 6 — the diminishing returns problem.**

A model critiquing its own output has the same blind spots that produced the output. If the diagnostic agent's priors say "payment processor issue" is the most likely cause for any conversion drop, its self-critique also says "payment processor issue" is the most likely cause. The critique will happily *confirm* the primary hypothesis and miss that the actual cause was something else the model's priors don't emphasize. The fix is not "critique harder" — it's *changing the context* (rubric criteria that force different attention, tool_calls_trace that grounds claims) so the critique-mode reads the output through a different lens.

```
  The blind-spot problem — why "critique harder" doesn't help

  generation priors:  "conversion drop → payment"
  critique priors:    "conversion drop → payment"    ← same priors
  self-critique:      "payment hypothesis looks fine"
                                              → same conclusion.

  fix: change the CONTEXT of the critique
       supply rubric that scores "rival mechanisms considered"
       supply tool_calls_trace so grounding is verifiable
       the priors don't change, but the attention does
```

### Move 2 variant — the load-bearing skeleton

The kernel of production self-critique is three moves:

```
  secondary call (not same-turn) → rubric-shaped prompt → grounded context (with trace)
```

What breaks if you skip each:

- **Skip "secondary call"** — same-turn critique reads the output with the same priors. Catches typos, misses reasoning bugs.
- **Skip "rubric-shaped prompt"** — free-form critique produces prose. Not parseable, not gate-able, ends up as dashboard read.
- **Skip "grounded context"** — the judge scores in the abstract. Can say "reads plausible" but can't verify "cites a real number."

Hardening layered on top: self-consistency across judge runs (run the judge N times, look at variance), human-vs-judge calibration (`eval/compute-agreement.eval.ts`), rubric evolution (add dimensions as new failure modes surface).

### Move 3 — the principle

**Critique is only as good as the context you give it.** A model reading its own output with the same context that produced it will make the same mistakes. A model reading with rubric criteria that force different attention, and with a trace that anchors grounding, can catch what generation missed. The trick isn't running critique — it's engineering the context so critique reads through a different lens.

## Primary diagram

```
  Self-critique in this codebase — the two calls

  ┌── generation call ──────────────────────────────────────┐
  │  DiagnosticAgent.investigate(anomaly)                    │
  │  model: Sonnet 4.6                                       │
  │  system: diagnostic prompt (role, rules, schema)          │
  │  context: schema, anomaly                                │
  │  tools: analytics tools (allowlist)                       │
  │  output: Diagnosis JSON                                   │
  └────────────────────────┬────────────────────────────────┘
                           │  (subject)
  ┌── critique call ───────▼────────────────────────────────┐
  │  RubricJudge.judge({ subject, context })                 │
  │  model: Sonnet 4.6 (same underlying model,               │
  │         DIFFERENT prompt shape, temperature 0)           │
  │  system: buildRubricJudgeSystemPrompt(rubric)             │
  │  context: anomaly + known_correct_shape + case_intent    │
  │           + signal_class + tool_calls_trace              │
  │  tools: NONE                                              │
  │  output: { dimensions, verdict, fix, checks }             │
  └────────────────────────┬────────────────────────────────┘
                           │
  ┌── consumer ────────────▼────────────────────────────────┐
  │  eval receipt: writes both diagnosis AND judgment        │
  │  regression gate: fail on has-signal + partial-signal    │
  │                   verdicts of `fail`                     │
  │  per-dimension pass rate: aggregated in afterAll         │
  └─────────────────────────────────────────────────────────┘
```

## Elaborate

Self-consistency was named by Wang et al. 2022 ("Self-Consistency Improves Chain of Thought Reasoning") — the specific technique of sampling multiple reasoning paths and taking the majority vote. It was a real improvement on math and logic benchmarks at the time. Modern models have absorbed enough of this that per-sample variance on well-shaped tasks is low, and running the loop N times often produces the same output N times. The residue: self-consistency is worth reaching for on tasks with high per-sample variance (edge cases, ambiguous inputs), not for stable tasks.

LLM-as-judge as a discipline came out of the Anthropic and OpenAI eval teams around 2023-2024. Hamel Husain's writing is the canonical practitioner-side reference — the specific point that "your LLM eval is only as good as the context you give the judge" is his, and it's why this codebase's judge context includes `tool_calls_trace` (which is the specific bit Hamel would call out as load-bearing).

Two failure modes I've watched:

- **The "judge model is the generator model" bug.** Team uses GPT-4 to generate and GPT-4 to judge. Judge scores everything at 4.5 because it reads its own reasoning style as good. Fix: use a different model for judging, or use rubric-shaped prompts that force different attention. This codebase uses the same underlying model (Sonnet 4.6) but a different prompt shape and different context — that's the mitigation.
- **The "critique that never fails" bug.** The judge scores every output as `pass` because the rubric levels are too fuzzy ("score 3 = adequate," "score 4 = good"). Fix: anchor scale levels with specific behavior descriptions (as this codebase does — "score 1 = restates the symptom, score 5 = rival mechanisms considered"). Concrete anchors force discrimination.

Related concepts:
- **Eval-driven iteration** (`05-eval-driven-iteration.md`) — the full loop that LLM-as-judge sits inside.
- **Chain-of-thought** (`09-chain-of-thought.md`) — the reasoning that critique reads.
- **Structured outputs** (`02-structured-outputs.md`) — the judge itself uses structured output.

## Interview defense

**Q: Does this codebase run self-critique on production diagnoses before shipping to the UI?**

No, and the reason is honest. Self-critique costs a second LLM call per output — roughly doubling per-case latency and cost. The eval pipeline runs the judge on every golden case, so regressions in critique-visible qualities (grounding, scope, plausibility) surface at eval time and gate deploys. Production diagnoses ship un-critiqued because the eval discipline is the check. If a specific class of production failure started showing up that evals miss, the answer might be adding a lightweight in-line critique for that class — but it would be shaped around the specific failure, not a blanket "critique everything."

```
  Where critique runs in this codebase

  eval loop:         diagnostic → judge (LLM-as-judge)
                                    scores against rubric
                                    gates on has-signal / partial-signal

  production loop:   diagnostic → UI (NO critique)
                                    trust the eval discipline
                                    saves latency + cost
```

Anchor: `eval/run.eval.ts:229-247` for the judge invocation in eval.

**Q: The judge scores every case as `pass_with_notes`. What's wrong?**

The rubric's scale levels aren't specific enough, so the judge can't discriminate. If score 3 means "adequate" and score 4 means "good," those are vibes — the judge picks 3 or 4 by feel. The fix is anchoring scale levels with specific behavior descriptions. This codebase does it right at `eval/rubrics/diagnosis-quality.ts:29-38`: score 1 = "restates the symptom," score 5 = "rival mechanisms are considered." The judge has to check specific things to pick a score. Second thing to check: the escape-hatch distinct-score-count check at `eval/run.eval.ts:516-523` — if a dimension shows only one distinct score across all cases, the substrate is too homogeneous and the judge isn't discriminating even with a good rubric.

```
  Vague rubric vs specific rubric

  vague:                              specific:
   score 3 = adequate                   score 3 = plausible mechanism,
   score 4 = good                                weakly evidenced
   score 5 = excellent                  score 4 = specific mechanism,
                                                evidence supports it
                                       score 5 = specific mechanism +
                                                evidence supports +
                                                rival mechanisms considered

  judge: picks by feel                 judge: verifies each level explicitly
   → clusters at 3-4                    → uses full 1-5 range
```

**Q: What's the load-bearing part people forget?**

The tool_calls_trace in the judge context. Everyone builds a rubric with a "cites evidence" dimension. Nobody remembers to pass the tool results into the judge. So the judge scores "did this diagnosis cite evidence?" in the abstract — it looks at the diagnosis's evidence field and says "yes, there are three bullet points, seems evidenced." What it can't do without the trace is verify "the number cited in evidence[0] actually came from the third tool call, not the model's priors." The trace is what turns "reads plausible" into "verifiably grounded." Every self-critique setup I've built without the trace was easier to game than any I've built with one.

Anchor: `tool_calls_trace` field at `eval/run.eval.ts:246` and its truncation in `formatToolCallTrace` at `eval/run.eval.ts:132-152`.

## See also

- `05-eval-driven-iteration.md` — LLM-as-judge is the eval loop's critique layer.
- `09-chain-of-thought.md` — the reasoning the critique reads.
- `11-meta-prompting.md` — the judge system prompt is built from data (`buildRubricJudgeSystemPrompt`).
