# Eval methods (the scoring ladder)

**Industry name(s):** evaluation methods / metrics, exact-match, fuzzy match, rubric grading, LLM-as-judge, pairwise comparison, human evaluation
**Type:** Industry standard · Language-agnostic

> Once you have an eval set, you need a way to turn an output into a score; the methods form a ladder from cheap-and-strict (exact-match) to expensive-and-nuanced (human review), and the right rung depends on the surface. blooming insights briefly wired four of these rungs (set-overlap for detection, per-criterion rubric + LLM-judge for diagnosis and recommendation, structural diff + similarity judge for regression) — all gone in PR #8 (commit 62c24d7) along with the Olist MCP server they ran against. **Evals are Case B again.** Read this file as study material; the exercises name the cheapest rung to rebuild over the in-process `SyntheticDataSource`.


---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Eval methods are the *scoring* side of the eval band — the function that consumes a per-agent output and emits a score. Each band's output has its own shape and so needs its own method: monitoring emits a typed `Anomaly[]` (exact-match scoring works), diagnostic emits a `Diagnosis` paragraph (rubric or LLM-judge), recommendation emits a `Recommendation[]` array (set overlap + per-item rubric). The scorer slots into the offline eval flow from `01-eval-set-types.md`.

```
  Zoom out — match the scorer to the per-agent surface

  ┌─ Per-agent output ───────────────────────────────┐
  │  Anomaly[]    Diagnosis (prose)   Recommendation[]│
  └────┬──────────────┬──────────────────┬───────────┘
       │ enum         │ free-form        │ array
       │ typed        │ JSON-with-prose  │ JSON
       ▼              ▼                  ▼
  ┌─ Eval band — scoring methods ────────────────────┐  ← we are here
  │  ★ exact-match / F1 (cheap, deterministic) ★      │
  │    for enum/typed surfaces                        │
  │  ★ rubric / LLM-judge (tolerant of wording) ★     │
  │    for prose surfaces                             │
  │  set overlap + per-item rubric                    │
  │    for array surfaces                             │
  └─────────────────────────┬────────────────────────┘
                            │
  ┌─ Score, tracked over time ▼──────────────────────┐
  │  noise-free numbers a team will actually act on   │
  └──────────────────────────────────────────────────┘

  Currently in this codebase: 221 Vitest tests guard plumbing.
  No eval runners — PR #8 removed `eval/` along with the Olist
  MCP server. Every rung walked below is study material; the
  exercises name the cheapest one to rebuild.
```

**Zoom in — narrow to the concept.** The question is: for each surface in blooming insights, which scoring method is strict enough to catch real regressions but loose enough not to fail correct-but-differently-worded answers? The wrong method makes your eval set lie — exact-match on prose creates noise, LLM-judge on enums is expensive and biased. Method choice is what makes the score *trustworthy*. How it works walks each method, the surface it fits, and the trap of using a single scorer for everything.

---

## Structure pass

**Layers.** Three layers: the per-agent output (Anomaly[] enum, Diagnosis prose, Recommendation[] array), the scoring method (the right rung on the ladder: exact-match / F1, rubric / LLM-judge, set overlap + per-item rubric), and the tracked quality score. The scoring method must match the output's *shape* — wrong rung produces noise.

**Axis: guarantees.** What does the scorer guarantee about its result — strict equality (cheap, brittle), tolerant rubric (nuanced, expensive), or human verdict (most accurate, slowest)? This axis is the right lens because the file is structured as a *rung ladder* — each rung trades determinism for tolerance, and the right choice depends on the output shape. The unifying question is "what guarantee does this score carry."

**Seams.** The cosmetic seam is within a rung (variants of rubric grading are all rubric-like). The load-bearing seam is between *rungs*: exact-match → rubric flips guarantees from "deterministic, cheap, brittle to wording" to "tolerant, expensive, depends on judge." A second load-bearing seam is between the output shape and the scorer choice: get this wrong and the eval lies (exact-match on prose produces noise; LLM-judge on enums is expensive and biased). Match scorer to shape — that's the load-bearing decision.

```
  Structure pass — eval methods

  ┌─ 1. LAYERS ───────────────────────────────────┐
  │  per-agent output (enum / prose / array)       │
  │  scoring method (right rung on the ladder)     │
  │  tracked quality score                         │
  └────────────────────────┬───────────────────────┘
                           │  pick the axis
  ┌─ 2. AXIS ─────────────▼────────────────────────┐
  │  guarantees: what does each rung guarantee —   │
  │  strict, tolerant, or human?                   │
  └────────────────────────┬───────────────────────┘
                           │  trace across layers, find flips
  ┌─ 3. SEAMS ────────────▼────────────────────────┐
  │  variants within rung: cosmetic                │
  │  rung↔rung: LOAD-BEARING                       │
  │    deterministic → tolerant → human            │
  │  output↔scorer: LOAD-BEARING                   │
  │    wrong rung for the shape = eval lies        │
  └────────────────────────┬───────────────────────┘
                           ▼
                   Block 4 — How it works
```

The skeleton is mapped — the rest of this file walks the mechanics that hang off it.

## How it works

**Mental model.** Think of the methods as a ladder. Each rung up handles more output variability and more nuance, and costs more (compute, money, latency, human time). You climb only as high as the output's variability forces you to — the cheapest rung that does not produce false failures is the right one. This is the same discipline as `../01-llm-foundations/07-heuristic-before-llm.md`: do not reach for the model when a string compare suffices.

```
the scoring ladder (cheap/strict at bottom → expensive/nuanced at top)
─────────────────────────────────────────────────────────────────────
  human review        ▲  most nuanced, slowest, most expensive — gold standard
  pairwise            │  "is A better than B?" — relative, robust to scale drift
  LLM-as-judge        │  model scores prose vs. rubric — nuanced, has BIAS
  rubric grading      │  checklist of criteria — structured, partly automatable
  fuzzy match         │  F1 / ROUGE / embedding-sim — tolerant of wording
  exact-match         ▼  ===  — fastest, free, deterministic, zero tolerance
─────────────────────────────────────────────────────────────────────
  climb only as high as the output's variability forces you to
```

The lower rungs are deterministic and free; the upper rungs are judgment calls that cost a model call or a human. You match the rung to the surface, not the other way around.

---

### Rung 1 — exact-match (the `===` of evals)

Exact-match scores an output correct only if it equals the reference exactly. It is `toBe`. It works when the output space is small and predictable — an enum, a boolean, a single label.

```
exact-match on anomaly severity
─────────────────────────────────────────────
output:    "critical"
reference: "critical"
score:     output === reference ? 1 : 0   → 1
```

In this system the natural fit is classification-shaped output. The intent classifier returns one of `'monitoring' | 'recommendation' | 'diagnostic'` — a one-word answer (it caps `max_tokens` at 16 to force this). An eval of intent classification is pure exact-match: the model said `diagnostic`, the reference is `diagnostic`, score 1. Severity classification on anomalies (`Severity = 'critical' | 'warning' | 'info' | 'positive'`) is the same shape. No tolerance is needed because there is no correct variation in a single enum value.

### Rung 2 — fuzzy match (tolerance for wording)

Fuzzy match scores partial overlap rather than exact equality. For a *set* of expected items it is precision/recall/F1; for free text it is token overlap (ROUGE), edit distance, or embedding cosine similarity. It is `toContain` and normalized compares, generalized.

```
F1 on the SET of anomalies the monitoring agent flagged
─────────────────────────────────────────────────────────────
expected anomalies:  {mobile-conv-drop, ios-checkout-error, eu-bounce}
flagged anomalies:   {mobile-conv-drop, ios-checkout-error, paid-search-up}
                      ─────────── overlap=2 ───────────
precision = 2/3   (2 of 3 flagged were correct)
recall    = 2/3   (2 of 3 expected were caught)
F1        = 0.67  (harmonic mean)
```

The monitoring agent's `scan` returns an *array* of anomalies, sorted by severity and sliced to the top 10. Its quality is not one label — it is a set: did it catch the anomalies that matter (recall) without flagging noise (precision)? F1 is the exact instrument. Exact-match is too strict here (the order or one extra item should not zero the score); a rubric is overkill (the items are structured, not prose).

### Rung 3 — rubric grading (a checklist for prose)

A rubric is a list of binary or scored criteria a good answer must satisfy. You decompose "is this diagnosis good?" into checkable sub-questions, each scored independently, then aggregate.

```
rubric for a Diagnosis
─────────────────────────────────────────────────────────────
[ ] conclusion names a specific cause (not "something changed")   weight 3
[ ] cites evidence tied to the anomaly's scope (mobile/checkout)  weight 2
[ ] considers ≥2 hypotheses (hypothesesConsidered non-trivial)    weight 2
[ ] does not hallucinate a metric not in the tool results         weight 3
                                                  score = Σ(passed×weight)/Σweight
```

A `Diagnosis` has `conclusion`, `evidence[]`, and `hypothesesConsidered[]`. Some criteria are checkable by code (is `hypothesesConsidered.length >= 2`? does `evidence` reference the anomaly's `scope`?); others need a judge. A rubric is the structured middle: more tolerant than exact-match (wording is free), more objective than a single holistic judge score (each criterion is explicit). It is the recommended first method for diagnosis and recommendation prose because it forces you to *define* what good means.

### Rung 4 — LLM-as-judge (a model grades the prose)

LLM-as-judge hands the output (and the reference or rubric) to a separate model and asks it to score. It handles nuance no checklist captures — tone, coherence, whether the reasoning actually follows — at the cost of a model call and judge bias (the whole subject of `03-llm-as-judge-bias.md`).

```
LLM-as-judge on a recommendation
─────────────────────────────────────────────────────────────
judge prompt: "Given anomaly X and diagnosis Y, rate this
               recommendation 1–5 on actionability and fit to
               the mapped Bloomreach feature. Justify."
output:  {title, rationale, bloomreachFeature:"scenario", steps[...]}
judge →  4/5 "concrete steps, correct feature, impact vague"
```

The recommendation agent's `propose` produces `Recommendation` objects whose quality is genuinely subjective — is this action sensible, does the `bloomreachFeature` enum match the problem, are the `steps` concrete? A rubric covers the checkable parts; LLM-as-judge covers the holistic "would an expert endorse this." It is the rung you climb to when a rubric cannot capture the nuance — and you climb it knowing it imports bias you must control.

### Rung 5 — pairwise comparison (which of two is better)

Pairwise asks the judge a relative question — "is output A better than output B?" — instead of an absolute score. Relative judgments are more reliable than absolute ones (humans and models both rank better than they rate), and they are the natural method for comparing two prompt versions or two models.

```
pairwise for a prompt-edit A/B
─────────────────────────────────────────────────────────────
case → diagnostic.md v1 → output A ┐
     → diagnostic.md v2 → output B ┤→ judge: "A or B better?"
                                    └→ aggregate win-rate over the golden set
v2 wins 64% of cases → v2 is the better prompt
```

This is the method for the decisions you will actually face: did editing the diagnostic prompt help? Did the next model beat the current one? Run the golden set through both, judge pairwise, report a win-rate. Pairwise sidesteps the "is 0.82 good?" problem — you do not need a calibrated absolute scale, only a consistent relative one.

### Rung 6 — human evaluation (the gold standard)

Human review is an expert reading outputs and scoring them. It is the ground truth every other method approximates, and the source of the reference answers in the golden set. It is slow and expensive, so you use it to *calibrate* the cheaper methods (does the LLM-judge agree with humans?) and to spot-check, not to score every run.

```
human review's role
─────────────────────────────────────────────────────────────
authors golden references → defines "good"
calibrates the LLM-judge  → does judge agree with human ≥ X%?
spot-checks production     → feeds failures to the regression set
```

### Matching method to surface in this system

```
surface                          output shape          method
───────────────────────────────  ────────────────────  ─────────────────────
classifyIntent                   one enum word         exact-match
anomaly severity                 one enum              exact-match
MonitoringAgent.scan (set)       array of anomalies    fuzzy / precision-recall-F1
DiagnosticAgent.investigate      prose + structure     rubric → LLM-judge
RecommendationAgent.propose      subjective action     rubric → LLM-judge
prompt-edit / model A/B          two prose outputs     pairwise
calibration & golden authoring   anything              human
```

### The principle

Match the scoring method to the variability of the output, not to your enthusiasm for the technique. Exact-match for a label, F1 for a set, a rubric for structured prose, a judge for nuance, pairwise for comparisons, human for ground truth — and never climb a rung higher than the output forces you to, because every rung up costs more and the upper rungs import bias. The same engineer who picks `toBe` over `toMatch` when the output is predictable picks exact-match over LLM-judge for the same reason.

---

## Eval methods — diagram

This diagram spans the State layer (the eval set), the Eval-harness layer (which selects a scoring method per surface), and the Provider boundary (the LLM-judge, only for the upper rungs). A reader who sees only this should grasp that one harness routes each surface's output to the cheapest method that fits it.

```
┌──────────────────────────────────────────────────────────────────────┐
│  DATASET LAYER  (evals/fixtures/)                                    │
│   golden / adversarial / regression cases  {input, reference|rubric} │
└────────────────────────────────┬──────────────────────────────────────┘
                                 │ each case → run live agent → output
┌────────────────────────────────▼──────────────────────────────────────┐
│  EVAL HARNESS  (evals/runner.ts — NEW)                              │
│                                                                       │
│   route by surface to the cheapest fitting method:                    │
│                                                                       │
│   intent / severity ──────▶ exact-match (===)        ── free, local   │
│   monitoring set ─────────▶ fuzzy / F1               ── free, local   │
│   diagnosis structure ────▶ rubric (code + criteria) ── mostly local  │
│   diagnosis/rec nuance ───▶ LLM-as-judge ──┐         ── model call    │
│   prompt/model A/B ───────▶ pairwise ──────┤                          │
│                                            │                          │
└────────────────────────────────────────────┼──────────────────────────┘
                                             │  PROVIDER BOUNDARY (judge only)
┌────────────────────────────────────────────▼──────────────────────────┐
│   Anthropic API — a JUDGE model (cross-family, see 03-...-bias.md)    │
│   returns score / winner → aggregated into the run report             │
└───────────────────────────────────────────────────────────────────────┘
   lower rungs never touch the provider; only nuance/comparison climb up
```

One harness, many methods. The cheap rungs stay local and free; only diagnosis/recommendation nuance and A/B comparisons reach the Provider boundary for a judge.

---

## Implementation in codebase

**Case B — no scorer wired today.** PR #8 (commit 62c24d7) removed the entire `eval/` tree along with the Olist MCP server. The 221 Vitest tests under `test/` still assert *shape* and control flow against fakes; there is no parallel scoring layer running against the live model. What was there briefly, and what would be the right rung per surface if it were rebuilt:

### What used to be wired (now gone)

- **Set overlap for detection (Rung 2)** — `eval/scripts/lib/scorer.ts` + `eval/scripts/run-detection.ts` scored `Anomaly[]` output against 3 seeded anomalies under loose/strict matchers. Removed in PR #8.
- **Rubric + LLM-as-judge for diagnosis (Rungs 3 + 4)** — `eval/scripts/lib/judge.ts` + `eval/scripts/run-diagnosis.ts` + `eval/judges/diagnosis-judge.md` ran a 5-criterion rubric (hypothesis / evidence / sizing / calibration / fabrication). Removed in PR #8.
- **Rubric + LLM-as-judge for recommendation (Rungs 3 + 4)** — `eval/scripts/lib/judge-rec.ts` + `eval/scripts/run-recommendation.ts` + `eval/judges/recommendation-judge.md` ran a 3-criterion rubric (plausible / specific / impact_sized). Removed in PR #8.
- **Structural diff + similarity judge for regression (Rung 1 + custom)** — `eval/scripts/run-regression.ts` + `eval/judges/similarity-judge.md` did capture-then-score with a two-mode comparator. Removed in PR #8.

### The right rung per surface — if rebuilt over `SyntheticDataSource`

- **Intent classifier** → exact-match (`===`). `classifyIntent` (`lib/agents/intent.ts:17–31`) returns one of three enum words capped at `max_tokens: 16`. Pure Rung 1; no tolerance needed.
- **Monitoring scan** → fuzzy / F1. `MonitoringAgent.scan` (`lib/agents/monitoring.ts:73–93` in the AptKit-wired wrapper) returns an `Anomaly[]`. Set overlap precision/recall, weighted by severity, is the right rung.
- **Diagnostic agent** → per-criterion rubric (Rung 3). A `Diagnosis` decomposes naturally into checkable points; the previous 5-criterion rubric is the right starting shape.
- **Recommendation agent** → per-criterion rubric (Rung 3). Same shape, smaller rubric.
- **Prompt-edit / model A/B** → pairwise (Rung 5). Always the right tool for "did this change help?"; never wired in this codebase.

### What's deliberately NOT here

Without a scorer wired, the 221 Vitest tests are the only assertions in the repo. They guard plumbing only; the model boundary is faked. The cheapest re-entry to Case A is the golden-set exercise in `01-eval-set-types.md` (one fixture file, one runner, one rung — no LLM-as-judge yet).

---

## Elaborate

### Where this pattern comes from

The ladder draws from three lineages. **Exact-match and F1** come straight from classical NLP and information retrieval — F1 has scored classifiers and retrieval systems for decades. **ROUGE/BLEU** (token-overlap fuzzy metrics) came from machine translation and summarization research. **LLM-as-judge and pairwise** are recent, born from the observation that human preference is expensive and that a strong model approximates it well enough to scale — Chatbot Arena popularized pairwise human/LLM preference as the dominant way to rank models. The ladder is the accumulated answer to "how do you score text when there is no single right answer?"

### The deeper principle

```
output variability        →  scoring method
─────────────────────────    ───────────────────────────────
one of N labels           →  exact-match (no tolerance needed)
a set of items            →  precision/recall/F1
structured prose          →  rubric (decompose into criteria)
free-form prose           →  LLM-judge (holistic) or pairwise (relative)
"better or worse?"        →  pairwise (relative beats absolute)
ground truth              →  human
```

The method tracks the *entropy* of the correct-answer space. A single enum has near-zero entropy → exact-match. A paragraph of reasoning has high entropy → you cannot enumerate correct answers, so you either decompose into criteria (rubric) or delegate the holistic judgment (judge/pairwise). The whole ladder is "how do I assert correctness when I cannot write down the one correct string?"

### Where this breaks down

1. **F1 hides which errors you made.** An F1 of 0.67 on monitoring output does not say whether you are missing critical anomalies (bad — low recall on what matters) or flagging noise (annoying but safe — low precision). Always report precision and recall separately and weight by severity; the aggregate alone misleads.

2. **Rubrics are only as good as their criteria.** A rubric that omits "does not hallucinate a metric" will score a confident, fluent, *fabricated* diagnosis highly. Writing the rubric is the hard, high-leverage work; the scoring is mechanical.

3. **LLM-judge introduces bias and cost on every case.** Position bias, verbosity bias, self-preference (`03-llm-as-judge-bias.md`) — and a model call per case. Climb to the judge only when the rubric genuinely cannot capture the nuance, and calibrate the judge against human scores before trusting it.

### What to explore next

- **G-Eval / chain-of-thought judging:** have the judge reason through the rubric step by step before scoring — more reliable than a bare 1–5 number.
- **Calibration against human labels:** measure judge-human agreement on a sample; if it is low, the judge score is decorative.
- **Severity-weighted F1 for monitoring:** weight recall on `critical` anomalies far above `info`, so the metric reflects the cost of a miss.

---

## Project exercises

### Build a minimal F1 scorer for monitoring over `SyntheticDataSource`

- **Exercise ID:** B3.1 (adapted) — the cheapest Rung-2 entry to re-open Case A.
- **What to build:** an `eval/scripts/lib/scorer.ts` that takes the `Anomaly[]` from `MonitoringAgent.scan` (now wired via `@aptkit/core`) and computes precision/recall/F1 against 3–5 hand-curated golden anomalies for the synthetic workspace. No LLM-judge yet, no K=10 yet — one run, one number, severity-weighted recall as the headline.
- **Why it earns its place:** the previous 4-pillar suite died with Olist; rebuilding the cheapest deterministic rung over the in-process `SyntheticDataSource` is the entry point for everything else. Severity-weighted recall hits the F1-hides-the-error-type lesson from "Where this breaks down."
- **Files to touch:** `eval/scripts/lib/scorer.ts`, `eval/scripts/run-monitoring.ts`, `eval/fixtures/golden-monitoring.json`, `package.json` (`eval:monitoring` script).
- **Done when:** `npm run eval:monitoring` runs once against `SyntheticDataSource`, prints precision / recall / F1 / severity-weighted recall, and writes JSON to `eval/results/<date>/monitoring.json`.
- **Estimated effort:** 1 day

### Add a pairwise prompt-edit A/B mode (the rung the previous suite never built)

- **Exercise ID:** B3.3 (adapted) — pairwise comparison for prompt iteration.
- **What to build:** a `--compare promptA promptB` mode that runs each golden case through two versions of a prompt (e.g., two variants of `@aptkit/prompts`' diagnostic prompt or a locally-overridden copy), judges each case pairwise via a new `eval/scripts/lib/pairwise-judge.ts` + `eval/judges/pairwise-judge.md`, and reports a win-rate with order randomized per case (ideally swap-and-average).
- **Why it earns its place:** demonstrates the exact decision tooling for "did my prompt change help?" — turning vibes into a measured A/B. Pairwise (relative) beats absolute scoring when you don't have a calibrated 1–5 scale.
- **Files to touch:** `eval/scripts/run-diagnosis.ts`, `eval/scripts/lib/pairwise-judge.ts`, `eval/judges/pairwise-judge.md`, plus a fixture pointing at two prompt variants.
- **Done when:** `npm run eval:diagnosis -- --compare promptA.md promptB.md` prints a win-rate with order-randomized cases and writes results to a dated dir.
- **Estimated effort:** 1–2 days

---

## Interview defense

### What an interviewer is really asking

"How would you score your eval set?" tests whether you know that one method does not fit all surfaces. The junior answer is "LLM-as-judge" (the shiny one). The senior answer matches method to surface and justifies *not* using the judge where a cheaper method is correct — exact-match for intent, F1 for the monitoring set — and names the bias and cost you take on when you do climb to the judge.

### Likely questions

**[mid] How would you score the monitoring agent's output?**

`MonitoringAgent.scan` (`lib/agents/monitoring.ts` L68–L103) returns an *array* of anomalies, not one label, so it is a set-overlap problem: precision (were the flagged ones real?) and recall (did it catch the ones that matter?), combined as F1. Exact-match is too strict — one extra item or a different order should not zero the score — and a rubric is overkill for structured items.

```
expected ∩ flagged → precision & recall → F1
```

**[senior] Why not just use LLM-as-judge for everything? It's the most capable.**

Because it is the most expensive and the only one with bias. Judging `classifyIntent`'s one-word enum output (`lib/agents/intent.ts` L17–L31) with a model call is paying for, and importing bias into, what `===` grades for free and correctly. Climb to the judge only when a rubric cannot capture the nuance — diagnosis/recommendation prose — and even then control for the biases in `03-llm-as-judge-bias.md`.

```
intent enum → exact-match (free, correct)   NOT judge (paid, biased)
rec prose   → judge (nuance the rubric misses)
```

**[arch] You edited `diagnostic.md` to improve diagnoses. How do you prove it helped?**

Pairwise A/B over the golden set: run each case through v1 and v2 of the prompt, judge "which is better" per case, report a win-rate. Pairwise beats absolute scoring here because you do not need a calibrated 1–5 scale — only a consistent relative judgment — and relative judgments are more reliable from both humans and models.

```
golden set → {v1 out, v2 out} → judge pairwise → win-rate(v2)
```

### The question candidates always dodge

**"What does an F1 of 0.7 actually tell you to do?"** On its own, almost nothing — it hides whether you are missing critical anomalies (dangerous) or flagging harmless noise (annoying). The honest answer is that you never report a bare F1: you report precision and recall separately, and for monitoring you weight recall on `critical` severity far above `info`, because the cost of missing a critical anomaly is not symmetric with flagging an extra info one. People who quote a single aggregate have not thought about the asymmetry of the errors.

### One-line anchors

- The ladder: exact-match → fuzzy/F1 → rubric → LLM-judge → pairwise → human.
- Climb only as high as output variability forces you — same as `toBe` vs. `toMatch`.
- intent/severity → exact-match; monitoring set → F1; diagnosis/rec prose → rubric/judge.
- F1 hides the error type — always split precision and recall, weight by severity.
- Pairwise (relative) beats absolute scoring for prompt/model A/B.

---

## See also

→ 01-eval-set-types.md · → 03-llm-as-judge-bias.md · → 04-llm-observability.md · → ../01-llm-foundations/07-heuristic-before-llm.md

---
