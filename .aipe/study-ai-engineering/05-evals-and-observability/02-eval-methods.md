# Eval methods (the scoring ladder)

**Industry name(s):** evaluation methods / metrics, exact-match, fuzzy match, rubric grading, LLM-as-judge, pairwise comparison, human evaluation
**Type:** Industry standard · Language-agnostic

> Once you have an eval set, you need a way to turn an output into a score; the methods form a ladder from cheap-and-strict (exact-match) to expensive-and-nuanced (human review), and the right rung depends on the surface. blooming insights now wires four of the rungs in production evals: detection uses set-overlap precision/recall (`eval/scripts/lib/scorer.ts`), diagnosis and recommendation use per-criterion rubric grading by LLM-as-judge (`eval/judges/{diagnosis,recommendation}-judge.md`), regression uses structural diff + similarity-judge two-mode (`eval/judges/similarity-judge.md` + `structural-diff.ts`). Pairwise A/B is the un-built rung.


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

  Currently in this codebase: 269 Vitest tests guard plumbing,
  AND four eval runners under `eval/scripts/` score quality —
  set-overlap (detection), per-criterion rubric + judge
  (diagnosis/recommendation), structural diff + similarity judge
  (regression). All four rungs walked below are wired.
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

**Case A — four rungs wired.** blooming insights ships a real scoring layer under `eval/scripts/lib/` that selects the rung per surface. The 269 Vitest tests under `test/` still assert *shape* and control flow against fakes; the eval suite under `eval/` is the parallel quality layer.

### Set overlap for detection (Rung 2 — fuzzy / F1 family)

- **File:** `eval/scripts/lib/scorer.ts` + `eval/scripts/run-detection.ts`
- **What it does:** for each of the K=10 monitoring-agent runs, compares the agent's `Anomaly[]` output to the 3 seeded anomalies under **two matchers**: LOOSE (2-of-3 — metric + segment + time-window) and STRICT (3-of-3). Computes precision, recall, and a per-anomaly hit-rate. Reports loose and strict separately because they answer different questions.
- **Result paper trail:** `eval/results/2026-06-15/detection-K10-{loose,strict,raw}.json` + `summary.md`; the post-prompt-fix re-run lives at `eval/results/2026-06-15-after-fix/` (5× lift in loose recall).

### Rubric + LLM-as-judge for diagnosis (Rungs 3 + 4)

- **File:** `eval/scripts/lib/judge.ts` + `eval/scripts/run-diagnosis.ts` + `eval/judges/diagnosis-judge.md`
- **What it does:** for each candidate diagnosis, sends the anomaly metadata, the reference-diagnosis shape, the candidate, and the tool-call transcript to a Sonnet-4.6 judge under a **5-criterion rubric**: hypothesis 0-2, evidence 0-2, sizing 0-2, calibration 0-1, fabrication 0-2 (total 0-9; pass threshold 7). Each criterion's score and rationale is captured for spot-check calibration.
- **Result paper trail:** `eval/results/2026-06-15/diagnosis-K10-{candidates,judge,summary}.json` + `diagnosis-summary.md`. **Calibration receipt:** 8/8 manual-vs-judge agreement on a stratified sample (2 per anomaly + 2 mid-pack). Mean 6.37/9, 53.3% pass.

### Rubric + LLM-as-judge for recommendation (Rungs 3 + 4)

- **File:** `eval/scripts/lib/judge-rec.ts` + `eval/scripts/run-recommendation.ts` + `eval/judges/recommendation-judge.md`
- **What it does:** for each candidate recommendation set (the agent returns up to 3), scores each one on a **3-criterion rubric** — plausible 0-2, specific 0-2, impact_sized 0-1 (total 0-5; pass threshold 4). The rubric specifically asks "is the impact figure credible, not just numeric?" — which is what let the judge catch the BRL cents-vs-Reais regression at run 8 of electronics-spike-w2 (R$131,965 AOV → impact_sized=0).
- **Result paper trail:** `eval/results/2026-06-15/recommendation-K10-{candidates,judge,summary}.json` + `recommendation-summary.md`. **Calibration receipt:** 3/3 manual-vs-judge agreement on a stratified sample including the BRL-bug catch (proves the judge isn't rubber-stamping).

### Structural diff + similarity judge for regression (Rung 1 + custom)

- **File:** `eval/scripts/lib/structural-diff.ts` + `eval/scripts/lib/similarity-judge.ts` + `eval/scripts/run-regression.ts` + `eval/judges/similarity-judge.md`
- **What it does:** for each of 10 golden fixtures, runs the current agent and scores the candidate against the captured golden in **two modes**: structural diff (types match, required fields present — Rung 1 equivalent for shape) AND similarity judge (does the *conclusion* materially match — a custom rung tuned for "did my prompt edit change the answer's substance"). Outputs structural-pass / semantic-pass / overall-pass per fixture.
- **Result paper trail:** `eval/results/2026-06-15-capture/` (the capture run) and `eval/results/2026-06-15-score-baseline/regression-summary.md` (the score-against-self baseline: 100% structural, 30% semantic).
- **Why two modes:** structural diff catches type / required-field regressions for free (no LLM call); the similarity judge catches conclusion-level drift that the structural diff cannot see (e.g., "platform-wide surge" flipped to "electronics-specific event" on identical inputs). See `05-regression-evals.md` for the full pattern walk.

### What's NOT wired

- **Pairwise (Rung 5)** — no `--compare promptA promptB` mode exists yet. The exercise below adds it.
- **Exact-match (Rung 1)** on `classifyIntent` — covered by regression fixture `10-intent-classify-investigation.json` (the only fixture with semantic_pass=true reliably, because the output space is one enum word), but no dedicated `eval/scripts/run-intent.ts`.
- **Human-eval calibration as a standing harness** — the calibration receipts in `eval/results/2026-06-15/diagnosis-summary.md` and `recommendation-summary.md` are stratified manual spot-checks, not a recurring run.

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

### Add severity-weighted recall to the detection scorer

- **Exercise ID:** B3.1 (adapted) — sharpen the wired detection eval.
- **What to build:** extend `eval/scripts/lib/scorer.ts` to weight recall on `critical` severity above `warning` and `info` (asymmetric error cost). Today the aggregate hides which class of miss is happening; today's 33.3% loose recall is averaged across all three seeded anomalies, but missing a `critical` should hurt more than missing an `info`. Surface a `weightedRecall` field alongside the raw one.
- **Why it earns its place:** the F1-hides-the-error-type lesson is in this file's "Where this breaks down" section. The eval already exists — closing this loop turns a bare aggregate into something you can act on.
- **Files to touch:** `eval/scripts/lib/scorer.ts`, `eval/scripts/lib/summary.ts` (render the weighted number in `summary.md`), `mcp-server-olist/data/seeds/anomalies.ts` (expected severity per seeded anomaly).
- **Done when:** a re-run of `npm run eval:detection -- --K=10` prints both raw and severity-weighted recall, and the next dated dir under `eval/results/` carries both.
- **Estimated effort:** <1 day

### Add a pairwise prompt-edit A/B mode (the un-built rung)

- **Exercise ID:** B3.3 (adapted) — pairwise comparison for prompt iteration.
- **What to build:** a `--compare promptA promptB` mode for `run-diagnosis.ts` / `run-recommendation.ts` that runs each seeded anomaly through two versions of `lib/agents/prompts/diagnostic.md` (or `recommendation.md`), judges each case pairwise via a new `eval/scripts/lib/pairwise-judge.ts` + `eval/judges/pairwise-judge.md`, and reports a win-rate with order randomized per case (and ideally swap-and-average).
- **Why it earns its place:** demonstrates the exact decision tooling for "did my prompt change help?" — turning vibes into a measured A/B. The Phase 2.5 DATA HORIZON fix was measured by **running detection twice with two prompt versions** (`eval/results/2026-06-15/` vs `…-after-fix/`) — pairwise is the same idea formalized at per-case granularity.
- **Files to touch:** `eval/scripts/run-diagnosis.ts` (compare mode), `eval/scripts/lib/pairwise-judge.ts`, `eval/judges/pairwise-judge.md`, reads two variants of `lib/agents/prompts/diagnostic.md`.
- **Done when:** `npm run eval:diagnosis -- --compare prompts/diagnostic-v1.md prompts/diagnostic-v2.md` prints a win-rate with order-randomized cases and writes results to a dated dir.
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

## Validate

### Level 1 — Reconstruct

From memory, draw the six-rung ladder from cheapest/strictest to most expensive/nuanced, and write the one-line rule for when to climb a rung.

### Level 2 — Explain

Out loud: why is exact-match correct for `classifyIntent` output but wrong for a `Diagnosis` conclusion? Tie it to output entropy (the size of the correct-answer space).

### Level 3 — Apply

Scenario: you must eval `MonitoringAgent.scan`. Open `lib/agents/monitoring.ts` L68–L103 and note it returns an array sorted by severity and sliced to 10. Explain why F1 (not exact-match, not a rubric) fits, and why you would weight recall on `critical` (`lib/mcp/types.ts` L3) above `info`.

### Level 4 — Defend

A colleague proposes one LLM-as-judge scorer for every surface "so the harness is simple." Argue the per-surface cost: name a surface where the judge wastes money and adds bias (intent/severity) and a surface where it is genuinely needed (recommendation prose), and state the simplest correct method for each.

### Quick check — code reference test

What does `classifyIntent` (`lib/agents/intent.ts` L17–L31) return, and which scoring method fits it and why? (Answer: one of three enum words — it caps `max_tokens` at 16 to force a single-word answer — so exact-match (`===`) is the correct method: the output space is a single label with zero correct variation, so no tolerance is needed and a judge would only add cost and bias.)

## See also

→ 01-eval-set-types.md · → 03-llm-as-judge-bias.md · → 04-llm-observability.md · → ../01-llm-foundations/07-heuristic-before-llm.md

---
Updated: 2026-05-28 — Test count 125→157; re-derived `MonitoringAgent.scan` (monitoring.ts L68–L103) and `Diagnosis` (types.ts L64–L73) refs. `classifyIntent` (intent.ts L17–L31), `propose` (recommendation.ts L36–L77), and Severity (types.ts L3) unchanged. Still Case B.
Updated: 2026-05-30 — Migrated to study.md v1.47 template (Phase 1+2 mechanical): removed Tradeoffs / Tech reference / Summary sections; renamed "In this codebase" → "Implementation in codebase"; moved See also to a bottom block. "Why care" preserved pending Phase 3 (Zoom out, then zoom in + LAYERS diagram) authoring.
Updated: 2026-05-30 — Phase 3 of study.md v1.47 migration: replaced "Why care" block with "Zoom out, then zoom in" (LAYERS diagram + zoom-in paragraph) per format.md.
Updated: 2026-05-31 — Applied study.md v1.48: scrubbed "How it works" of file paths, line refs, and real-code fences; replaced with generic role labels + pseudocode per format.md. Codebase-specific anchoring lives exclusively in "Implementation in codebase".
Updated: 2026-05-31 — Applied study.md v1.50: added Structure pass block (layers · axis · seams) between Zoom out and How it works per format.md's new Block 3.
Updated: 2026-06-16 — Phase 3 flipped this file from Case B to Case A: opening verdict, Implementation in codebase, and the un-wired-rung enumeration now anchor to the four real runners under `eval/scripts/` and the three judge prompts under `eval/judges/`, with calibration receipts cited (diagnosis 8/8, recommendation 3/3 including BRL-bug catch). Replaced the "build the evals/runner.ts" exercise with two new ones: severity-weighted recall on the detection scorer; pairwise prompt-edit A/B (the actual un-built rung).
