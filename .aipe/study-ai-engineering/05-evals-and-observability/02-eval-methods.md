# 02 — eval methods

**Subtitle:** Exact match / fuzzy / rubric / LLM-as-judge · Industry standard (Case B)

## Zoom out, then zoom in

**Case B.** Six methods, ordered from cheap-and-strict to
expensive-and-flexible. Match the method to what you're scoring.

```
  Zoom out — methods rank from mechanical to subjective

  ┌─ Output type → suggested method ─────────────────┐
  │  enum / id / classifier label  → exact match    │  ← cheap
  │  generated short text          → fuzzy match    │
  │  generated structured prose    → rubric         │
  │  generated long output         → LLM-as-judge   │
  │  comparing two variants        → pairwise        │
  │  golden truth required         → human eval     │  ← expensive
  └──────────────────────────────────────────────────┘
```

## Structure pass

  → **One axis to trace — cost vs subjectivity.** Exact match is free
    but only works for outputs with one right answer (classifier
    labels, IDs). Human eval is expensive but works for any output.
    Pick the cheapest method that captures what you care about.

## How it works

### Move 1 — the mental model

```
  Method ladder

  ┌──────────────────────┬──────────────────────────┐
  │ Method               │ When to use              │
  ├──────────────────────┼──────────────────────────┤
  │ Exact match          │ Classifiers, structured   │
  │                      │ outputs, IDs              │
  ├──────────────────────┼──────────────────────────┤
  │ Fuzzy match          │ Generated text where      │
  │ (edit distance,      │ wording varies but        │
  │  normalized)         │ semantics shouldn't        │
  ├──────────────────────┼──────────────────────────┤
  │ Rubric (criteria-    │ Quality of generated      │
  │ based; human or LLM) │ text on dimensions        │
  │                      │ (tone, structure, accuracy)│
  ├──────────────────────┼──────────────────────────┤
  │ LLM-as-judge         │ Scalable rubric eval.     │
  │                      │ Cheap, but biased — see   │
  │                      │ 03-llm-as-judge-bias.md   │
  ├──────────────────────┼──────────────────────────┤
  │ Pairwise             │ "Is A better than B?"     │
  │                      │ for comparing variants    │
  ├──────────────────────┼──────────────────────────┤
  │ Human eval           │ Highest signal, lowest    │
  │                      │ scale; for golden curation│
  └──────────────────────┴──────────────────────────┘
```

### Move 2 — the step-by-step walkthrough

**For blooming insights' hypothetical eval suite, the right mix is:**

  → **Intent classifier:** exact match. `classifyIntent` returns one of
    a fixed enum (`diagnostic` | `monitoring` | `recommendation` |
    `query`). Score: 1 if predicted matches expected, 0 otherwise.
    Golden set: 20 queries with their expected intents.

  → **Monitoring agent:** mechanical match on the *set* of detected
    anomalies. For each golden anomaly, did it appear in the agent's
    output? Score: recall@N. Could augment with rubric ("did it pick
    appropriate severity?"). This is exact-ish, not LLM-as-judge.

  → **Diagnostic agent:** LLM-as-judge with rubric. The output is prose;
    you can't exact-match. The rubric:
      - Did it identify the correct root cause? (1-5)
      - Did it cite specific evidence? (1-5)
      - Did it consider plausible alternative hypotheses? (1-5)
      - Is the affected-customer estimate within an order of magnitude
        of the golden answer? (1-5)
    Average per item, aggregate across the set.

  → **Recommendation agent:** rubric + structural checks.
      - Is `bloomreachFeature` appropriate for the diagnosis? (rubric)
      - Are the `steps` actionable (not vague)? (rubric)
      - Does `estimatedImpact` cite the diagnosis's affected-customer
        count + an AOV? (structural — check the math is present)
      - Did it avoid duplicating an existing scenario? (rubric)

  → **Query agent:** LLM-as-judge against expected answer prose.

**The choice between rubric-by-human and rubric-by-LLM.** Human rubric
gives ~3-5x higher signal but ~50-100x lower throughput. For weekly CI,
LLM-as-judge is the only scalable option. For golden-set *creation*
(deciding what the correct answer IS), humans do it once and the LLM
judges thereafter.

**A hypothetical judge prompt** for the diagnostic eval:

```
You are evaluating a diagnostic agent's output against a known-correct
answer.

Anomaly: {{anomaly_json}}
Expected diagnosis: {{golden_diagnosis_json}}
Agent's diagnosis: {{agent_diagnosis_json}}

Score on each dimension 1-5:
- root_cause_correctness: Did the agent identify the same cause?
- evidence_specificity: Did the agent cite specific evidence?
- hypothesis_breadth: Did it consider plausible alternatives?
- impact_accuracy: Is the affected-customer estimate within an order
  of magnitude?

Return JSON: { "root_cause": N, "evidence": N, "hypotheses": N,
              "impact": N, "explanation": "..." }
```

The same lenient extract + type guard pattern from
`01-llm-foundations/04-structured-outputs.md` would parse the judge's
output.

### Move 3 — the principle

**Use the cheapest method that captures what you care about.** Exact
match for enums. Fuzzy match for short generated text. Rubric (LLM or
human) for prose. Don't reach for LLM-as-judge when exact match works
— LLM-as-judge is biased and noisy; mechanical scoring is neither.

## Primary diagram

```
  Method-per-agent matrix for blooming insights' hypothetical evals

  ┌──────────────────┬─────────────────────────────────────┐
  │ Agent            │ Suggested eval method               │
  ├──────────────────┼─────────────────────────────────────┤
  │ intent classify  │ exact match (4-class enum)          │
  │ monitoring       │ recall@N on golden anomalies         │
  │                  │  + rubric (severity correctness)    │
  │ diagnostic       │ LLM-as-judge rubric (4 dimensions)  │
  │ recommendation   │ structural + LLM-as-judge rubric    │
  │ query (free-form)│ LLM-as-judge against golden answer  │
  └──────────────────┴─────────────────────────────────────┘

  per agent: 10-20 golden items
  judge model: different family from agent (GPT-4o for Claude agents)
  threshold: aggregate score must stay > baseline-2pp
```

## Elaborate

The method ladder reflects ~5 years of community learning since
LLM-as-judge entered the mainstream (around 2022, with the rise of
GPT-4-as-grader for OpenAI's evals). The 2024 "JudgeArena" benchmarks
showed that LLM-as-judge correlates ~70-90% with human rubric on most
tasks — good enough for relative tracking ("did this PR regress?") but
not for absolute claims ("our agent is 92% accurate").

For pairwise comparison, the bias profile is different (less position
bias, more verbosity bias). Use pairwise when you're A/B testing prompt
variants; use absolute scoring when you're tracking quality over time.

## Project exercises

### Exercise — implement the four-dimension rubric judge for diagnostics

  → **Exercise ID:** `study-ai-eng-05-02.1`
  → **What to build:** Inside `test/evals/diagnosis.eval.ts` (created
    in 01-eval-set-types.md's exercise), implement the LLM-as-judge
    with the four-dimension rubric above. Use OpenAI's GPT-4o (or
    another non-Anthropic family). Parse via `parseAgentJson` reused
    from `lib/mcp/validate.ts`.
  → **Why it earns its place:** Concrete instance of the method-
    selection move. Demonstrates "I know when to reach for LLM-as-judge
    and what its rubric should be."
  → **Files to touch:** `test/evals/diagnosis.eval.ts`,
    `test/evals/judge-prompt.ts` (the rubric prompt as a constant),
    `package.json` (`openai` dep), env var docs.
  → **Done when:** Running `npm run eval` produces per-item 4-dim
    scores plus an aggregate; rerunning is stable within ±5%
    (judge variance is real but bounded).
  → **Estimated effort:** `1–2 days`

## Interview defense

**Q: How would you score this codebase's LLM outputs?**

Method per agent, picked by output shape:

```
  agent             method
  ─────             ──────
  intent classify   exact match (4-class enum)
  monitoring        recall@N on golden anomaly set
                      + severity-correctness rubric
  diagnostic        LLM-as-judge with 4-dim rubric
                      (root cause / evidence / hypotheses / impact)
  recommendation    structural checks + rubric
  query             LLM-as-judge against golden answer
```

The principle is: use the cheapest method that captures what you care
about. Exact match where the answer is a label; rubric (LLM or human)
where it's prose; pairwise when comparing variants.

**Anchor line:** "Match the method to the output shape. LLM-as-judge
is biased and noisy — use it for prose, not for enums."

**Q: When would you use pairwise instead of absolute scoring?**

When you're A/B testing prompt variants. Pairwise asks "is variant A
better than variant B on this input?" — it's easier for the judge to
answer relatively than absolutely, and the bias profile is different
(less position bias, more verbosity bias). Use absolute scoring when
you're tracking quality *over time* (week-over-week regression
detection).

## See also

  → `01-eval-set-types.md` — the inputs each method scores
  → `03-llm-as-judge-bias.md` — what to watch out for with LLM judges
