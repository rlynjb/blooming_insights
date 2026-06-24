# Regression evals (capture, then score with structural diff + similarity judge)

> **RETIRED 2026-06-18.** This file was authored against the Olist MCP
> server / Phase 3 eval pipeline, both removed from the codebase. The
> patterns it teaches are real, but the code anchors it cites no longer
> exist. Preserved as a historical record of what was studied.

**Industry name(s):** regression evaluation, snapshot eval, capture-then-replay eval, golden-output testing, structural diff + semantic similarity judging
**Type:** Industry standard · Project-specific implementation

> A regression eval is the third eval set type — frozen *outputs* you captured on a known-good day, re-scored against today's outputs to catch drift you would otherwise miss. The trick for non-deterministic prose is the scoring: a verbatim string compare always fails, so you split it — **structural diff** for shape (types match, required fields present) and an **LLM similarity judge** for semantic match (did the *conclusion* materially change). blooming insights wires both: `eval/scripts/run-regression.ts` runs in two modes (`capture` writes today's outputs, `score` compares them to a frozen golden set), and the 30% semantic baseline at `eval/results/2026-06-15-score-baseline/regression-summary.md` is itself the load-bearing finding — conclusion-level stochasticity is real.

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** A regression eval is one shape of the offline eval band — same harness pattern as golden/adversarial, but scored against *captured outputs* instead of hand-written references. It sits between observability (the trace is the captured-output source) and evals (the score is the regression assertion). The capture mode writes today's `Anomaly[]` / `Diagnosis` / `Recommendation[]` outputs into a golden directory; the score mode re-runs the same inputs against today's code and asks "did anything change?"

```
  Zoom out — regression sits between observability and evals

  ┌─ Live request flow (UNCHANGED) ────────────────────┐
  │  agents → captured event stream + outputs           │
  └────────────────────────┬───────────────────────────┘
                           │  one well-known day = "golden"
  ┌─ Capture mode ────────▼────────────────────────────┐
  │  write today's outputs into                         │
  │  eval/fixtures/regression-golden/                   │
  │  (10 fixtures: monitoring × 2, diagnostic × 3,      │
  │   recommendation × 3, query × 1, intent × 1)        │
  └────────────────────────┬───────────────────────────┘
                           │  later — after a prompt edit, model swap, etc.
  ┌─ Score mode ──────────▼────────────────────────────┐  ← we are here
  │  re-run same inputs against today's code            │
  │  compare candidate vs golden, two modes:            │
  │    ★ structural diff (types / required fields) ★    │
  │    ★ similarity judge (conclusion match) ★          │
  └────────────────────────┬───────────────────────────┘
                           │
  ┌─ Score table ─────────▼────────────────────────────┐
  │  100% structural / 30% semantic = baseline          │
  │  prompt edit drops semantic to 10%?  → REGRESSION   │
  │  prompt edit holds semantic at ~30%? → MERGE        │
  │  prompt edit lifts semantic to 50%?  → INVESTIGATE  │
  └────────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question is: when your agent's output is non-deterministic prose, how do you tell a *real* regression (the prompt edit broke something) from a *baseline* regression (the agent always drifts a little)? Verbatim equality is the wrong instrument — same input runs produce different prose every time. Split the question into two: **shape** (deterministic — types and required fields don't change unless the contract changes) and **substance** (non-deterministic — judged by a similarity model). The shape check is structural diff for free; the substance check is one LLM call per fixture. How it works walks the two-mode scoring, the capture-then-score split, and why the 30% semantic baseline is the finding, not a bug.

---

## Structure pass

**Layers.** Four layers form the regression eval: the live agent (produces today's output for the same inputs as the golden), the capture mode (writes a frozen reference into the golden directory once), the score mode (compares candidate vs golden in two modes — structural diff + similarity judge), and the score table (per-fixture pass/fail aggregated into structural and semantic rates). The capture is one-time; the score runs every time you edit a prompt or swap a model.

**Axis: guarantees.** What does each scoring mode guarantee — deterministic shape match (structural) or probabilistic substance match (semantic)? This axis is the right lens because the file's whole frame is "verbatim is the wrong instrument; you need two modes because shape and substance need different rungs." Structural diff is Rung 1 (exact/===) applied to the *contract*, not the value; the similarity judge is Rung 4 (LLM-as-judge) applied to the *conclusion*. The split is the load-bearing decision.

**Seams.** The cosmetic seam is between the agent and the capture file — both are just JSON. The load-bearing seam is between the structural and semantic modes: guarantees flip from "deterministic shape — a type change is always a regression" to "probabilistic substance — a 30% mismatch rate IS the baseline." A second load-bearing seam is between the score mode and the decision rule: the same number (e.g., 25% semantic pass) is a regression OR a non-regression depending on which side of the baseline it falls on.

```
  Structure pass — regression evals

  ┌─ 1. LAYERS ───────────────────────────────────┐
  │  live agent (today's output)                   │
  │  capture mode (writes frozen golden once)      │
  │  score mode (structural diff + similarity)     │
  │  score table (per-fixture pass / aggregate)    │
  └────────────────────────┬───────────────────────┘
                           │  pick the axis
  ┌─ 2. AXIS ─────────────▼────────────────────────┐
  │  guarantees: deterministic shape match (struct)│
  │  vs probabilistic substance match (semantic)?  │
  └────────────────────────┬───────────────────────┘
                           │  trace across layers, find flips
  ┌─ 3. SEAMS ────────────▼────────────────────────┐
  │  agent↔capture: cosmetic                       │
  │  structural↔semantic: LOAD-BEARING             │
  │    type change = always regression             │
  │    conclusion drift = baseline-relative        │
  │  score↔decision: LOAD-BEARING                  │
  │    same number, different verdict by baseline  │
  └────────────────────────┬───────────────────────┘
                           ▼
                   Block 4 — How it works
```

The skeleton is mapped — the rest of this file walks the mechanics that hang off it.

## How it works

**Mental model.** A regression eval is a snapshot test for an LLM feature. You take a known-good day's outputs, freeze them as the golden, and on every change re-run the same inputs and compare. The trick is that the comparison can't be `===` — same inputs produce different prose. So you compare **shape** with a deterministic structural diff and **substance** with a probabilistic similarity judge, and you accept that the substance match has a baseline mismatch rate. The discipline is to measure the baseline first (run capture, immediately re-run score — that's your floor) and then anchor every later run to it.

```
verbatim snapshot test (wrong for LLMs)   regression eval (right for LLMs)
─────────────────────────────────────     ──────────────────────────────────
expect(today).toBe(golden)                 mode 1: structuralDiff(today, golden)
fails on any non-deterministic prose                ↓ shape regression?
("you are SOL on day 1")                   mode 2: similarityJudge(today, golden)
                                                    ↓ substance regression?
                                            aggregate: 100% struct / 30% semantic
                                            baseline + decision rule
```

The two modes are independent. A change can fail structural (broke the contract — always a regression) without changing substance, or pass structural but fail semantic (kept the shape, changed the conclusion — judged against baseline). You report both.

---

### Move 2 — the capture / score split

Two scripts, one in each mode. **Capture** runs today's agents on each fixture's input and writes the outputs verbatim into the golden directory; you run it once when the code is in a known-good state and commit the result. **Score** runs today's agents on the same inputs and compares each output to the captured golden under both modes.

```
the capture / score split
─────────────────────────────────────────────────────────────
mode = "capture"                     mode = "score"
for fixture in golden/:              for fixture in golden/:
  input = fixture.input                input = fixture.input
  candidate = agent.run(input)         candidate = agent.run(input)
  write(golden/fixture, candidate)     gold = read(golden/fixture)
                                       structural = structuralDiff(candidate, gold)
                                       semantic   = similarityJudge(candidate, gold)
                                       record(fixture, structural, semantic)
                                     aggregate → summary.md
```

Capture is destructive — it overwrites the previous golden — so it is a deliberate operator action ("I trust today's outputs as the new reference"), not an automatic step in CI. Score is non-destructive — it produces a result dir + summary you read.

### Move 2 — structural diff (the deterministic mode)

Structural diff walks the candidate and golden in lockstep, asserting that the *types* and *required fields* match. It does NOT compare values — different values are not regressions, missing fields ARE.

```
structural diff in pseudocode
─────────────────────────────────────────────────────────────
structuralDiff(candidate, golden):
    if typeof candidate != typeof golden:
        return { pass: false, reason: "type mismatch" }
    if isArray(golden):
        // shape: array of the same item type, but length can vary
        return checkItemShapes(candidate, golden)
    if isObject(golden):
        for key in requiredKeys(golden):
            if key not in candidate:
                return { pass: false, reason: "missing field: " + key }
            recurse on candidate[key], golden[key]
    return { pass: true }
```

Why this catches regressions for free: contracts change rarely. If `Diagnosis` always had `hypothesesConsidered: []` and today's output omits it, that's a real regression that broke the type guard. Structural diff is one cheap check that pegs at 100% in the baseline and drops to <100% only when a contract changes.

### Move 2 — the similarity judge (the probabilistic mode)

The similarity judge is an LLM call. It receives the candidate, the golden, and a small instruction set, and returns `{ semantic_pass: boolean, confidence: number, notes: string, differences: string[] }`. The judge is asked whether the *conclusion* materially matches — not whether the wording is identical.

```
similarity judge prompt shape
─────────────────────────────────────────────────────────────
"Compare these two outputs for the same input.
 Did the substance materially change?
 - For monitoring: same anomalies flagged with comparable severity?
 - For diagnostic: same supported hypothesis?
 - For recommendation: same mechanisms (campaign / scenario / segment / experiment)?
 - For query: same ranking, same magnitudes within 5%?
 Return semantic_pass: true if substance matches; false if it changed.
 Always include a `differences` array of specific points."
```

The judge has the same self-preference + verbosity biases as any LLM-as-judge — see `03-llm-as-judge-bias.md`. The calibration receipt for this judge is the **30% semantic baseline** itself: running capture-then-immediately-score produces 30% match on identical prompts, which sets the floor every later run is measured against.

### Move 2 — the baseline-relative decision rule

A single semantic pass rate is meaningless without the baseline. The decision rule is comparative:

```
the decision rule (anchored to the 30% baseline)
─────────────────────────────────────────────────────────────
baseline = 30% (running score immediately after capture, identical prompts)

today's run: prompt edit X applied

  semantic_pass < 20%   → REAL REGRESSION (worse than baseline drift)
                          DO NOT MERGE
  semantic_pass ≈ 30%   → within baseline tolerance
                          MERGE
  semantic_pass > 50%   → SUSPICIOUS LIFT
                          (might be over-anchoring; investigate)
```

The 30% is calibration, not target. The baseline is the price you pay for measuring a non-deterministic system; the decision rule is how you tell signal from that price.

### Move 3 — the principle

Regression evals for an LLM feature work like snapshot tests for deterministic code, with one inversion: the assertion shifts from "values are equal" to "shape is equal AND substance is judged equal." Splitting the comparison into a deterministic mode (cheap, sharp — catches contract changes) and a probabilistic mode (LLM call, fuzzy — catches conclusion drift) gives you two independent signals from one captured fixture. The discipline that makes this work is anchoring decisions to a measured baseline: a 30% mismatch rate is the floor, not a bug, and you only call regression when today drops below it.

---

## Regression evals — diagram

This diagram spans the State layer (where the golden fixtures + result dirs live), the Eval-harness layer (the capture and score modes), and the Provider boundary (the live agent + the similarity-judge model). A reader who sees only this should grasp that capture is one-time + destructive; score is non-destructive + emits a paper trail; and the two-mode scoring is what makes verbatim non-determinism survivable.

```
┌──────────────────────────────────────────────────────────────────────┐
│  STATE LAYER  (the goldens + the receipts)                           │
│                                                                       │
│   eval/fixtures/regression-golden/                                    │
│     01-monitoring-empty.json     ← input + captured output            │
│     ...                                                               │
│     10-intent-classify-investigation.json                             │
│                                                                       │
│   eval/results/<YYYY-MM-DD>-capture/   ← writes here on capture       │
│   eval/results/<YYYY-MM-DD>-score-baseline/   ← reads from here       │
│     regression-summary.md      regression-summary.json                │
│     regression-candidates.json regression-judge.json                  │
└────────────┬──────────────────────────────────────┬──────────────────┘
             │  capture (one-time, destructive)    │  score (every change)
┌────────────▼──────────────────────────────────────▼──────────────────┐
│  EVAL HARNESS  (eval/scripts/run-regression.ts)                      │
│                                                                       │
│   for each fixture:                                                   │
│     input → run live agent → candidate                                │
│     mode "capture": write candidate to golden dir                     │
│     mode "score":                                                     │
│       structural = structuralDiff(candidate, golden)                  │
│       semantic   = similarityJudge(candidate, golden)                 │
└────────────┬──────────────────────────────────────┬──────────────────┘
             │ agent call                          │ judge call
┌────────────▼──────────┐                ┌─────────▼─────────────────────┐
│ PROVIDER (agent)       │                │ PROVIDER (similarity judge)   │
│ claude-sonnet-4-6      │                │ claude-sonnet-4-6             │
│ over OlistDataSource   │                │ eval/judges/similarity-judge  │
└───────────────────────┘                └───────────────────────────────┘
   (live agent run)                         (semantic comparison)
```

One captured golden serves multiple score runs; the structural mode never hits the provider boundary; the semantic mode does, once per fixture per run.

---

## Implementation in codebase

**Case A — implemented.** The regression eval ships as one of the four pillars in `eval/`. The 269 Vitest tests under `test/` are independent (they assert plumbing with fakes); regression eval runs real agents.

### The runner

- **File:** `eval/scripts/run-regression.ts` (~742 lines — the largest of the four runners; handles capture mode, score mode, both judges, the result-dir layout, and the per-fixture per-agent dispatch)
- **Modes:** `--mode=capture` writes to `eval/results/<date>-capture/`; `--mode=score` writes to `eval/results/<date>-score-baseline/` (or any suffix passed via `EVAL_RUN_TAG`).
- **Dispatch:** each fixture declares which agent runs (`monitoring`, `diagnostic`, `recommendation`, `query`, `intent`); the runner imports the corresponding helper from `eval/scripts/lib/run-{diagnostic,query,intent,recommendation,agent}-agent.ts`.

### The two scorers

- **File:** `eval/scripts/lib/structural-diff.ts` — walks candidate vs golden, asserts types + required-field presence, returns `{ pass, diffs[] }`.
- **File:** `eval/scripts/lib/similarity-judge.ts` — wraps the `eval/judges/similarity-judge.md` prompt around the candidate + golden, sends to `claude-sonnet-4-6`, parses `{ semantic_pass, confidence, notes, differences }`.

### The fixtures

- **Directory:** `eval/fixtures/regression-golden/` — 10 captured fixtures (`01` through `10`), each a JSON file with `input` (what the agent gets) and `output` (the captured golden). Coverage: monitoring (empty schema + 3-anomalies), diagnostic (sp / electronics / voucher), recommendation (sp / electronics / voucher), query (revenue-by-state), intent (classify-investigation).

### The judge prompt

- **File:** `eval/judges/similarity-judge.md` (~225 lines) — the rubric the similarity judge runs against. Defines what "same substance" means per agent surface (monitoring = same anomalies + comparable severity; diagnostic = same supported hypothesis; recommendation = same mechanisms; query = same ranking + 5% magnitude tolerance).

### The baseline run

- **File:** `eval/results/2026-06-15-score-baseline/regression-summary.md` — the load-bearing receipt. Capture happened on 2026-06-15; score ran immediately against the same prompts. Result: **100% structural pass, 30% semantic pass** (only voucher diagnosis, voucher recommendation, and intent classification produce stable conclusions on identical inputs). The 7 fixtures that drifted show real conclusion-level changes documented in the `differences` arrays (e.g., "platform-wide surge → electronics-specific event" for `04-diagnostic-electronics`).

### npm script wiring

- **File:** `package.json`
- **Scripts:** `"eval:regression": "tsx eval/scripts/run-regression.ts"` (line in scripts block)

---

## Elaborate

### Where this pattern comes from

Regression evals are the LLM-era version of two older practices: **snapshot testing** from frontend (capture a render, fail on diff — Jest's `toMatchSnapshot`) and **golden-output testing** from compilers/codegen (capture the compiled output, fail on diff). Both assume the output is deterministic — and that assumption breaks for LLMs. The two-mode split (structural deterministic + semantic probabilistic) is the accumulated answer from the LLM-eval community: keep snapshot testing's discipline, change only the comparison instrument.

### The deeper principle

```
domain                  expected match    comparison instrument
──────────────────────  ────────────────  ─────────────────────────
frontend snapshots      pixel/DOM exact   string ===
compiler goldens        bytes exact       diff
LLM regression          shape exact +     structural diff +
                        substance match   similarity judge (LLM)
```

The discipline (capture, freeze, compare on every change) is the same across all three; the comparison instrument adapts to the output's determinism level. LLM regression evals are snapshot tests with a fuzzy comparator.

### Where this breaks down

1. **Capture is destructive and the baseline can drift.** Re-capturing the golden bakes today's drift into the new reference. The right capture cadence is rare and operator-driven (e.g., after a model upgrade you decide to baseline), not automatic.

2. **The similarity judge has the same self-preference trap as the other judges.** Sonnet judging sonnet output's match — bias by construction (see `03-llm-as-judge-bias.md`). The mitigation is the same: per-criterion structure in the prompt + manual spot-checks (the `differences` arrays in `regression-summary.md` are spot-checkable).

3. **A 30% baseline doesn't generalize across systems.** The baseline is *this* codebase + *these* prompts + *this* model. A different system might baseline at 50% or 10%. The discipline is to measure your own baseline; don't import this one.

### What to explore next

- **Per-criterion semantic match.** Today the judge returns one boolean `semantic_pass`. Splitting it into per-surface criteria (monitoring: anomaly set match; diagnostic: hypothesis match; recommendation: mechanism match) gives finer-grained signal — "the prompt edit kept the hypothesis but changed the recommendation mechanisms" is more actionable than one bool.
- **Time-windowed baselines.** Re-measure the baseline once a quarter (against current prompts + current model); track baseline drift over time as a system-stability metric.
- **Fixture coverage gaps.** 10 fixtures is small. Each new eval-surfaced failure should become an 11th, 12th, ... fixture (the operationalize-the-flywheel exercise in `01-eval-set-types.md`).

---

## Project exercises

### Per-surface semantic-match breakdown

- **Exercise ID:** B3.10 (adapted) — sharpen the wired regression eval.
- **What to build:** extend `eval/judges/similarity-judge.md` to return a per-criterion match instead of a single `semantic_pass` boolean (e.g., for diagnostic: `hypothesis_match`, `evidence_match`, `confidence_match`). Update `eval/scripts/lib/similarity-judge.ts` to parse the new shape, and `eval/scripts/run-regression.ts` to render it in `summary.md`. The 30% baseline can then be decomposed: are hypotheses stable but evidence drifting? Or vice versa?
- **Why it earns its place:** the current single-boolean output tells you THAT 7 fixtures drifted but not WHICH AXIS each drifted on. Per-criterion gives the eval flywheel a finer lever to pull.
- **Files to touch:** `eval/judges/similarity-judge.md`, `eval/scripts/lib/similarity-judge.ts`, `eval/scripts/run-regression.ts` (summary rendering), `eval/scripts/lib/summary.ts`.
- **Done when:** a re-run of `npm run eval:regression -- --mode=score` writes a `summary.md` with per-criterion semantic-match columns and the 30% baseline is shown decomposed.
- **Estimated effort:** 1 day

### Time-windowed baseline tracking

- **Exercise ID:** C3.10 (provenance) — make baseline drift visible.
- **What to build:** every dated `eval/results/<date>-score-baseline/` dir's `regression-summary.json` already carries an aggregate. Add `eval/scripts/baseline-history.ts` that walks all score-baseline dirs over the last N days, prints a small chart (or just a table) of structural-pass and semantic-pass over time, and flags any month-over-month delta > 10%.
- **Why it earns its place:** the baseline itself is a measurement — if it drifts from 30% → 45% without any prompt or model change, something else changed (a dependency, an SDK update, the synthetic dataset's seed). Visible drift is the cheapest early-warning system.
- **Files to touch:** `eval/scripts/baseline-history.ts`, optional `package.json` script `"eval:baseline-history"`.
- **Done when:** running the script prints a table of dated baselines and flags significant deltas.
- **Estimated effort:** <1 day

---

## Interview defense

### What an interviewer is really asking

"How do you tell if a prompt edit made things worse?" tests whether you know that LLM regression is a different problem from code regression. The junior answer is "run the tests again." The senior answer is the two-mode split: structural diff for the deterministic shape, similarity judge for the non-deterministic substance, both anchored to a measured baseline — and the recognition that a 30% mismatch rate is the floor, not a bug.

### Likely questions

**[mid] Why can't you just snapshot-test an LLM agent's output?**

Because LLM outputs are non-deterministic. Same input, same prompts, same model produces different prose on each invocation (`eval/results/2026-06-15-score-baseline/regression-summary.md` shows 30% match running capture-then-immediately-score with no changes). A verbatim snapshot fails on day one, so you have to relax the comparator — structural diff for shape, similarity judge for substance.

```
snapshot test: expect(today).toBe(golden)  → fails always
regression:    structuralDiff + similarityJudge → measures real drift
```

**[senior] You see a 25% semantic pass after a prompt edit. Regression or not?**

Relative to the 30% baseline (`eval/results/2026-06-15-score-baseline/regression-summary.md`), 25% is below floor — that's a real regression beyond baseline stochasticity. DO NOT MERGE. The decision rule is anchored to baseline because the baseline IS what stochasticity costs you on identical prompts; anything that drops below it is signal, not noise.

```
baseline = 30%  → today = 25%  → real regression
baseline = 30%  → today = 32%  → within tolerance → merge
baseline = 30%  → today = 50%  → suspicious lift → investigate
```

**[arch] The similarity judge is sonnet judging sonnet. Isn't that the self-preference trap?**

Yes — same trap as the diagnosis and recommendation judges (`03-llm-as-judge-bias.md`). The mitigation today is per-criterion prompt structure + the `differences` arrays in `regression-summary.md` as spot-check receipts; the gap is cross-family judging (the named Case-B exercise in `03-llm-as-judge-bias.md`). For regression specifically, the bias risk is asymmetric — a self-preferring judge will over-report "same substance" between two sonnet outputs, biasing the baseline upward; that makes the 30% baseline a conservative floor (the real baseline is probably lower), which is actually a safe direction for a regression decision rule.

```
sonnet judge biases toward "same substance"
  → baseline biases upward
  → real regressions still drop below it
  → safe for the merge/no-merge decision
  (but: cross-family judge would give a truer absolute number)
```

### The question candidates always dodge

**"Your baseline is 30%. How do you know that's right and not just a noisy small-N measurement?"** The honest answer is you don't — 10 fixtures × 1 capture-vs-score run is a thin baseline, and the right hardening is K=10 capture runs averaged (so the baseline is `mean(score(capture_i, golden))` over many captures) rather than one shot. The codebase ships the one-shot baseline because it's the cheapest credible answer; the upgrade is the time-windowed baseline-history exercise above. Saying "0.30 baseline" without acknowledging the small-N is the tell that someone hasn't actually shipped this discipline.

### One-line anchors

- Regression eval = snapshot test with a fuzzy comparator.
- Two modes: structural diff (deterministic, free) + similarity judge (probabilistic, one LLM call).
- 100% structural / 30% semantic baseline at `eval/results/2026-06-15-score-baseline/regression-summary.md`.
- The 30% is the floor, not a target — decisions are baseline-relative.
- Capture is destructive + operator-driven; score is non-destructive + emits a paper trail.

---

## See also

→ 01-eval-set-types.md · → 02-eval-methods.md · → 03-llm-as-judge-bias.md · → 04-llm-observability.md · → ../07-system-design-templates/03-multi-rubric-eval-pipeline.md

---
