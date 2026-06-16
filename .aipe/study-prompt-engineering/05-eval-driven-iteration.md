# Eval-driven iteration (iterate against a golden set, not vibes)

**Industry name(s):** eval-driven development, golden-set / regression-set iteration, LLM-as-judge, offline evaluation harness
**Type:** Industry standard · Language-agnostic

> The senior-vs-junior line in prompt work is this: a junior edits a prompt, eyeballs one output, and ships; a senior runs the edited prompt against a fixed set of labeled cases and ships only if the score holds AND no critical case regressed. blooming insights now has a real 4-pillar eval suite under `eval/` — detection (precision/recall on 3 seeded Olist anomalies), diagnosis (5-criterion LLM-judge rubric), recommendation (3-criterion LLM-judge), regression (golden-set diff). The Phase 2.5 monitoring-prompt fix has receipts: loose recall lifted **6.7% → 33.3%** (5x), voucher detection went **1/10 → 10/10** — and the same eval set surfaced the honest limit: SP-revenue and electronics anomalies stayed 0/10 strict because the "recent 4w vs baseline 12w" framing is week-blind. The prompts are still visibly iterated-by-incident in prose (every "CRITICAL" block is a past production miss), but the scoring layer is now real, not aspirational.


---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Eval-driven iteration is an *orthogonal* path that runs parallel to the request flow, not inside it. You edit a prompt at the Per-agent definitions band, but the eval suite exercises the real production path (Per-agent definitions → Shared agent loop → Provider) from a separate entry point — `eval/scripts/run-*.ts` runners that spawn a real `OlistDataSource` subprocess and run the actual agent classes with the production prompts. The dataset, runner, scorer, and gate all live in a sibling layer that touches the same agent classes the request path touches, just driven by a different caller.

```
  Zoom out — where eval-driven iteration lives

  ┌─ Engineer edits prompt ─────────────────────────┐
  │  lib/agents/prompts/<name>.md                    │
  └─────────────────────────┬────────────────────────┘
                            │
  ┌─ EVAL band (orthogonal) ▼─────────  ┌─ Request flow ──────┐
  │  ★ eval/fixtures/* (reference) ★    │ app/api/agent/route │
  │  ★ eval/scripts/run-*.ts (4) ★      │ → Pipeline coord    │
  │  uses REAL Per-agent definitions ──→│ → Per-agent defs    │
  │  + Shared agent loop + Provider     │ → Shared agent loop │
  │  + REAL OlistDataSource subprocess  │ → Provider          │
  │  ↓                                  │ ↓                   │
  │  ★ scorer: LOOSE/STRICT (detect) ★  │ user receives result │
  │  ★ judge: 5-crit (diag) / 3 (rec) ★ │                     │
  │  ↓                                  └─────────────────────┘
  │  ★ gate: precision/recall + rubric ★ ← we are here
  └──────────────────────────────────────────────────┘
       (Phase 3 — eval/ ships detection + judges)
```

**Zoom in — narrow to the concept.** The question this file answers: how do you know the edit that fixed today's bug didn't silently break a case you fixed three weeks ago? A golden set + runner + scorer + gate moves the definition of "better prompt" out of your head and onto a number, with the gate checking two things — aggregate up AND no critical case regressed. blooming insights now has the receipts: a Phase 2.5 monitoring-prompt fix scored **6.7% → 33.3% loose recall** (5x), with a real per-anomaly delta table showing voucher went 1/10 → 10/10 *and* SP-revenue went 1/10 → 0/10 (small regression). The eval is the layer that made both visible. Below, you'll see why unit tests aren't evals, what the runner has to share with production, the LLM-judge trap, and the per-anomaly diff that catches the "average up but one case regressed" failure.

---

## Structure pass

**Layers.** Eval-driven iteration is a four-layer loop that lives in a *dev-time* band parallel to the production request path, and the layers don't help unless you keep them at that altitude. Layer A is the *dataset* — 20–50 labeled cases accreted from real production misses, each one a bug you already paid for. Layer B is the *runner* — a script that exercises the *real* agent classes (loaded prompt, real model, real validator) against each case, with an injected deterministic `McpCaller` so the tool results are reproducible. Layer C is the *scorer* — a field assertion for JSON agents or an LLM-judge for the prose agent, turning each output into pass/fail or 0–1. Layer D is the *gate* — the two-condition ship check: aggregate up AND no critical case regressed.

**Axis: lifecycle.** When does each layer fire — at dev-time (the edit), at ship-gate-time (the merge), or never (the gap)? Lifecycle is the right axis because the whole concept is a *parallel timeline* to the request flow: the dataset is forever (Layer A — `eval/fixtures/`), the runner is invoked on demand (Layer B — `npm run eval:detection -- --K=10`), the scorer runs per case per dev-time iteration (Layer C — `eval/scripts/lib/scorer.ts` for detection; `eval/judges/*.md` for diagnosis/recommendation), and the gate fires at ship-time (Layer D — currently a human reading `summary.md`, not yet a CI gate). The Phase 3 build closed the first three layers; Layer D is still manual (you read the per-anomaly delta and decide), but the *evidence* the decision rests on is now numbers in a committed `summary.md`, not vibes.

**Seams.** Two seams matter. Seam 1 (A↔B) — the dataset is *static-and-curated*, the runner uses the *live agent classes and the live model* (non-deterministic by nature); the deterministic injected `McpCaller` is the gate that makes the case reproducible despite the model being sampled. The load-bearing seam is Seam 2 (C↔D) — lifecycle flips from *measuring* (per-case scores) to *deciding* (ship or reject). And this is exactly where the "average went up" trap lives: a single-condition gate (only aggregate) ships silent regressions; a two-condition gate (aggregate AND zero per-case regressions) catches them. The whole value of having a harness is that this seam stops being a vibe and starts being a number.

```
  Structure pass — eval-driven iteration

  ┌─ 1. LAYERS ───────────────────────────────────┐
  │  A: dataset (cases accreted from misses)       │
  │  B: runner (real agent path + injected mcp)    │
  │  C: scorer (field assert | LLM judge)           │
  │  D: gate (aggregate ↑ AND no regression)        │
  └────────────────────────┬───────────────────────┘
                           │  pick the axis
  ┌─ 2. AXIS ─────────────▼────────────────────────┐
  │  lifecycle: when does each layer fire — dev    │
  │  edit, ship gate, post-incident accretion?      │
  └────────────────────────┬───────────────────────┘
                           │  trace A→D, find flips
  ┌─ 3. SEAMS ────────────▼────────────────────────┐
  │  S1 (A↔B): static curated cases → live agent   │
  │            run, made reproducible by injected   │
  │            deterministic McpCaller              │
  │  S2 (C↔D): per-case scores → ship/reject       │
  │            decision (LOAD-BEARING — where the  │
  │            "average up but edge case down"      │
  │            trap lives)                          │
  └────────────────────────┬───────────────────────┘
                           ▼
                   Block 4 — How it works
```

```
  A seam — "did the change ship?" answered two ways

  ┌─ aggregate-only ─┐    seam     ┌─ two-condition ──────┐
  │  avg ↑ → ship    │ ═════╪═════► │  avg ↑ AND no per-   │
  │  (silent         │   (it       │  case regression →   │
  │   regressions)   │    flips)   │  ship                │
  └──────────────────┘             └──────────────────────┘
         ▲                                   ▲
         └────── same axis, two answers ─────┘
                 → this boundary is the difference between
                   "we have evals" and "evals actually gate"
```

The skeleton is mapped — the rest of this file walks the mechanics that hang off it.

## How it works

**Mental model.** An eval harness is three parts: a *dataset* of cases (input + a notion of what a good output is), a *runner* that feeds each case through the real prompt-and-model path, and a *scorer* that turns each output into pass/fail or a number. You iterate by editing the prompt, re-running the whole dataset, and comparing the aggregate AND the per-case deltas. The aggregate tells you if the change helped on average; the per-case diff tells you what it broke.

```
EVAL LOOP
─────────────────────────────────────────────────────────────
   edit prompt  (monitoring / diagnostic / …)
        │
        ▼
   ┌─────────── DATASET ───────────┐
   │ case 1: input → expected/grader│
   │ case 2: input → expected/grader│   20–50 cases
   │ …                              │
   └───────────────┬────────────────┘
                   ▼
   ┌─────────── RUNNER ────────────┐
   │ for each case: run real path   │   prompt + model + parse
   │ collect output                 │
   └───────────────┬────────────────┘
                   ▼
   ┌─────────── SCORER ────────────┐
   │ pass/fail or 0–1 per case      │   assertion / LLM-judge
   └───────────────┬────────────────┘
                   ▼
   compare:  aggregate ↑?  AND  per-case regressions = 0?
        │
        ▼  ship only if both hold
```

The whole point is the second half of the final comparison. "Average went up" is the trap; "average went up AND no critical case went down" is the gate.

---

### Part 1 — the dataset is the asset, not the prompt

The prompt is cheap to rewrite. The labeled dataset — the 50 cases that encode "here is what good looks like across the edge cases we have hit" — is the thing you cannot regenerate from memory. Hamel Husain's central argument (his "Your AI Product Needs Evals" essay is the canonical reference) is that teams over-invest in prompt cleverness and under-invest in the dataset, and it is exactly backwards: the dataset is what lets you change the prompt safely.

```
WHAT YOU OWN
─────────────────────────────────────────────────────────────
 prompt text      ← cheap, regenerable, you rewrite it weekly
 the dataset      ← EXPENSIVE, accreted from real misses, irreplaceable
                    each case = one bug you already paid for once
```

For blooming insights the cases are obvious because the prompts already name them. Every "CRITICAL"/"Never"/"Do NOT" block is a case waiting to be written down:

- monitoring prompt — empty-window block: a workspace whose recent 90 days are empty. Expected: agent anchors `execution_time` or returns `[]` — NOT a ±100% swing.
- monitoring prompt — small-baseline caution: a metric with a prior value < 500 events. Expected: agent ignores it, does not report a "swing."
- diagnostic prompt — historical-data block: queries for recent windows return 0. Expected: conclusion honestly states data is historical — NOT an invented cause.
- diagnostic prompt — `customers matching` ban: a hypothesis that would need that filter shape. Expected: agent uses `by <attribute>` and does not waste a call.

Each of those is a regression fix that currently lives only as a sentence in a prompt. The dataset turns each sentence into an enforceable case.

---

### Part 2 — the runner feeds the REAL path

The runner must exercise the actual production path — the loaded markdown prompt, the real model, the shared agent loop, the agent-JSON parser, the type guards — not a hand-mocked approximation. A harness that scores a prompt against a different parser than production uses is measuring fiction.

```
RUNNER must use the SAME path as production
─────────────────────────────────────────────────────────────
 case input
    │
    ▼
 diagnostic_agent.investigate(anomaly)   ← real class, real prompt
    │  loop → real model → parse → shape guard
    ▼
 Diagnosis | FALLBACK                     ← exactly what prod returns
    │
    ▼
 scorer reads THIS, not a mock
```

The seam that makes this cheap already exists. The shared agent loop injects both the provider SDK client and an MCP-caller dependency — the same seam the 169 unit tests use to pass fakes. For evals you do the opposite of the unit tests: you keep the real provider client (you want real model behavior) and inject a *deterministic* MCP caller that returns canned tool results per case, so the case's "empty 90-day window" is reproducible run to run.

---

### Part 2.5 — current state: unit tests are not evals (and now the evals exist)

This is the distinction the brief demands be named plainly. blooming insights has 269 Vitest tests **and** a real eval suite under `eval/`. The two layers do completely different jobs.

```
UNIT TEST (test/)                   EVAL (eval/)
──────────────────────────────     ──────────────────────────────
inject fake provider + fake mcp     REAL provider, REAL OlistDataSource
assert: the parser returns          score: did the agent detect the
        an object of the right       seeded anomaly? did the diagnosis
        shape; shape guard passes    pass the 5-criterion rubric?
─────────────────────────────────────────────────────────────
"does the contract hold?"           "is the answer any good?"
deterministic, no model call        non-deterministic, real Sonnet 4.6
runs on every PR (CI)               runs on demand (~$1-3 / K=10)
```

The diagnostic agent's unit tests prove that when the fake model returns fenced JSON, the investigate path returns a typed `Diagnosis`, and when it returns garbage, the chain falls to a fallback value. That is the structured-output contract (→ 02-structured-outputs.md) under test. It says nothing about whether the diagnosis is *right*. A hallucinated-but-well-shaped diagnosis passes every one of those 269 tests. **The eval suite is the layer that catches that, and as of Phase 3 it ships.**

What the eval ACTUALLY caught — a real receipt from this codebase:

```
PROMPT DELTA              Phase 2.5 monitoring.md edit:
                          + DATA HORIZON section (anchor date range)
                          + 3-dimension scan plan (state, category,
                            payment_type — "skip any, miss its anomaly")
                          + "do not spend > 2 calls on any single
                            dimension" hard rule

DETECTION EVAL (K=10):    loose recall  6.7% → 33.3%   (+26.6 pts, 5x)
                          voucher       1/10  → 10/10
                          sp-revenue    1/10  → 0/10   (-1, small regress)
                          electronics   0/10  → 0/10   (unchanged)
                          strict recall 0.0% → 0.0%    (no movement)
                          false-pos     0.2   → 2.2    (more breadth ≈
                                                       more false signal)
```

The eval surfaced two things vibes-iteration would not. First, the win is real and bounded — voucher went perfect because it's the easiest anomaly (sustained, large, on payment_type which the new scan plan forces). Second, the win is honestly partial — sp-revenue and electronics stay 0/10 strict because "recent 4w vs baseline 12w" framing fundamentally can't catch mid-horizon week-specific anomalies. That second sentence — "the prompt fix is the wrong tool for the rest of the job" — is the kind of finding you only earn by running real numbers. With vibes-only iteration, the voucher win would have been celebrated and the SP regression would have shipped silently.

---

### Part 3 — the scorer, and the LLM-judge trap

Three case types, three scorers, all live in this codebase.

For the monitoring agent (detection), scoring is a code assertion against a heuristic matcher (`eval/scripts/lib/scorer.ts`): LOOSE = metric + segment match the seeded anomaly (2-of-3); STRICT = LOOSE + a time-window signal (3-of-3). Each emitted insight is matched against each of the 3 seeded anomalies; a hit increments true-positives, a miss is a false-positive.

For the diagnostic agent (free-form reasoning + structured fields), scoring is an LLM-as-judge against a **5-criterion rubric** that lives in `eval/judges/diagnosis-judge.md` (~350 lines of judge prompt + anchor examples): `hypothesis` (0-2), `evidence` (0-2), `sizing` (0-2), `calibration` (0-1), `fabrication` (0-2). Pass threshold ≥7/9. Each criterion failure points back to a specific prompt deficit — the judge IS the prompt engineer's feedback loop.

For the recommendation agent, same shape with a 3-criterion rubric in `eval/judges/recommendation-judge.md` (~250 lines): `plausible` (0-2), `specific` (0-2), `impact_sized` (0-1). Pass ≥4/5.

```
SCORER per agent
─────────────────────────────────────────────────────────────
 monitoring   →  detection match (LOOSE 2-of-3 / STRICT 3-of-3)
                 eval/scripts/lib/scorer.ts (heuristic regex+constants)
 diagnostic   →  LLM-judge, 5-criterion rubric, pass ≥7
                 eval/judges/diagnosis-judge.md
 recommend    →  LLM-judge, 3-criterion rubric, pass ≥4
                 eval/judges/recommendation-judge.md
 query        →  similarity-judge for prose (eval/judges/similarity-judge.md)
```

What the judge rubrics actually catch — a second real receipt: the diagnostic agent's `confidence` field produces **calibration=0 in 29/30 runs**. The judge anchor (`diagnosis-judge.md`) explicitly fails any output that says "likely caused by X" with `confidence: "high"` and zero hedging language, because that's overclaim, not calibrated confidence. Root cause: a prompt deficit — `diagnostic.md`'s confidence-derivation reads "3 hypotheses tested → confidence=high," which produces the binary output the rubric flags. This is the senior pattern in action: the eval names a criterion, the criterion fails on 29/30 runs, and the failure points back at one line in the prompt. That is the flywheel.

The trap to name (Hamel's discipline): an LLM judge is itself a model that can be wrong, and it is often wrong in a *correlated* way with the model it grades — particularly when both are Sonnet 4.6, as here. You must validate the judge against human labels before you trust the score. The judges in `eval/judges/` ship with anchor examples (passing-anchor, failing-on-sizing-anchor, failing-on-calibration-anchor) which serves as half of that validation — the judge is anchored to specific patterns; the other half (rate-of-agreement with hand labels) is still TODO. Skipping that step replaces "I think this looks good" with "a model thinks this looks good" — same vibes-based iteration with extra latency.

---

### The principle

Eval-driven iteration moves the definition of "better prompt" out of your head and into a number on a fixed dataset, and it gates every change on two conditions, not one: the aggregate improved AND no critical case regressed. The dataset — accreted one production miss at a time — is the asset; the prompt is disposable. blooming insights now has both: the misses written as CRITICAL blocks, AND the eval suite (`eval/`) that scores them. The Phase 2.5 monitoring fix has receipts — loose recall 6.7% → 33.3% — and the same suite named the honest limit (sp-revenue and electronics stay 0/10 strict because the "recent vs baseline" framing is fundamentally week-blind). That is the flywheel doing exactly what it's supposed to do: surface partial wins as partial, not as wins.

---

## Eval-driven iteration — diagram

This diagram spans the loop. The Engineer edits a prompt; the Harness layer runs the real production path over a fixed dataset and scores each output; the Gate compares both the aggregate and the per-case deltas before allowing a ship. The feedback edge — every production miss becomes a new permanent case — is what makes the dataset grow stronger than memory.

```
┌──────────────────────────────────────────────────────────────────────┐
│  ENGINEER                                                             │
│   edits a prompt file (e.g. tightens the empty-window rule            │
│   in the monitoring prompt)                                           │
└───────────────────────────┬───────────────────────────────────────────┘
                            │
┌───────────────────────────▼───────────────────────────────────────────┐
│  HARNESS LAYER   evals/  (does not exist yet)                         │
│                                                                       │
│  DATASET   cases dir holding 20–50 JSON cases                         │
│    each: { input anomaly/query, canned mcp results, grader }          │
│           │                                                           │
│  RUNNER   real provider client + injected deterministic mcp caller    │
│    → diagnostic_agent.investigate / query_agent.answer (REAL path)    │
│           │  output                                                   │
│  SCORER   field assertion (JSON agents) | LLM-judge (query prose)     │
│           │  pass/fail or 0–1 per case                                │
└───────────────────────────┬───────────────────────────────────────────┘
                            │  results table
┌───────────────────────────▼───────────────────────────────────────────┐
│  GATE                                                                 │
│   aggregate ↑ ?    AND    per-case regressions == 0 ?                 │
│        │ yes & yes                    │ no                            │
│        ▼                              ▼                               │
│      SHIP                       reject / investigate the regression   │
└──────────────────────────────────────────────────────────────────────┘
        ▲
        │  every production miss → new permanent case  (the dataset grows)
        └───────────────────────────────────────────────────────────────
```

A reader who sees only this should grasp: the dataset is fixed and growing, the runner uses the real path, and the gate checks two things — average up AND no critical regression.

---

## Implementation in codebase

**Case A — implemented (Phase 3 ships the eval suite).** The 4-pillar suite lives under `eval/`:

### The suite — 4 pillars, 4 runners

- **File:** `eval/scripts/run-detection.ts` · `run-diagnosis.ts` · `run-recommendation.ts` · `run-regression.ts`
- **Function / class:** each runner spawns a fresh `OlistDataSource` subprocess per run, instantiates the real `MonitoringAgent` / `DiagnosticAgent` / `RecommendationAgent` with the production prompts, runs K=10 times, scores each run, writes per-day results to `eval/results/<YYYY-MM-DD>/`.
- **Run with:** `npm run eval:detection -- --K=10` (~$1-3, ~5-10 min); the recruiter number.
- **Role:** the orchestration layer; the actual production agent classes do the work, the runner just drives K independent runs and aggregates.

### The scorer — detection (LOOSE / STRICT)

- **File:** `eval/scripts/lib/scorer.ts`
- **Function / class:** matchInsight() — applies a metric regex + a segment-name lookup + a time-window heuristic. LOOSE = 2-of-3 (metric + segment); STRICT = 3-of-3 (LOOSE + time window).
- **Role:** turns each emitted insight into a hit/miss/false-positive against the 3 seeded anomalies in `mcp-server-olist/scripts/seed-olist.ts` (`sp-revenue-drop-w4`, `electronics-spike-w2`, `voucher-dropoff-w10-on`).

### The LLM judges — diagnosis (5-criterion) and recommendation (3-criterion)

- **File:** `eval/judges/diagnosis-judge.md` (~350 lines) · `eval/judges/recommendation-judge.md` (~250 lines) · `eval/judges/similarity-judge.md` (~280 lines)
- **Function / class:** the judge prompt is loaded as a system prompt for a second Sonnet 4.6 call; the candidate diagnosis is passed as the user message; the judge returns a JSON score per criterion plus an overall pass/fail.
- **Role:** turns prose + structured-field reasoning into rubric scores. Diagnosis rubric: `hypothesis` 0-2 + `evidence` 0-2 + `sizing` 0-2 + `calibration` 0-1 + `fabrication` 0-2; pass ≥7/9. Recommendation rubric: `plausible` 0-2 + `specific` 0-2 + `impact_sized` 0-1; pass ≥4/5.

### The reference fixtures

- **File:** `eval/fixtures/reference-diagnoses.json` · `reference-recommendations.json` · `regression-golden/`
- **Role:** one valid-shape reference per seeded anomaly. The judge does NOT score by literal match — it uses the reference to anchor "what would a competent answer look like for THIS anomaly."

### The committed results — the receipts

- **File:** `eval/results/2026-06-15/summary.md` (pre Phase 2.5 fix) · `eval/results/2026-06-15-after-fix/summary.md` (post)
- **Role:** the same K=10 detection eval run before and after the monitoring prompt's DATA HORIZON + 3-dim scan plan additions. The post-fix `summary.md` includes the per-anomaly delta table and the "Honest interpretation" section that names what worked (voucher) and what didn't (sp-revenue, electronics — the framing limit).

### The informal regression suite still inside the prompts

- **File:** `lib/agents/prompts/monitoring.md` · `diagnostic.md` · `recommendation.md`
- **Role:** every "CRITICAL"/"Never"/"Do NOT" block in the prompts is still a regression fix encoded as prose — `monitoring.md`'s empty-window block, the small-baseline caution, the DATA HORIZON anchor — each one a production miss the team already paid for. The eval suite enforces detection, but the prose blocks are the broader regression set; they should accrete into the eval over time.

---

## Elaborate

### Where this comes from

Eval-driven development crystallized around 2023–2024 as teams shipped LLM features and discovered prompt iteration had no safety net. Hamel Husain's writing ("Your AI Product Needs Evals", and the follow-ups on LLM-as-judge and looking at your data) is the canonical practitioner reference; it argues the dataset and the act of *reading your outputs* are the work, and the prompt is downstream. The pattern borrows directly from software testing — golden files, regression suites, snapshot tests — and adapts the scorer to tolerate the non-determinism of model output (assertions on structured fields, rubric-based LLM judges for prose).

### The deeper principle

```
software test                       eval
──────────────────────────────     ──────────────────────────────
unit under test = function          unit under test = prompt+model
output = deterministic value        output = sampled, non-deterministic
scorer = ===                        scorer = field assert | LLM-judge
regression = exact diff             regression = score drop on a case
```

The deep equivalence: both move correctness from "I checked once" to "the suite checks every change." The only adaptation is that the eval scorer must absorb non-determinism — which is why you score on a fixed dataset with a tolerance, and why a single critical case failing matters more than a fractional average dip.

### Where this breaks down

1. **A small golden set lies.** 20 cases that all happen to have healthy data tell you nothing about the empty-window path. The set must over-represent the edge cases — the CRITICAL blocks — not the happy path, because the happy path rarely regresses.

2. **The average hides the killer.** This is the named failure mode: a prompt edit that raises mean score by tightening the happy-path phrasing while regressing the one historical-data case. Aggregate-only gating ships it. You must diff per-case.

3. **The LLM judge drifts and colludes.** An unvalidated judge that shares blind spots with the agent (often the same model family, → 10-self-critique.md) will rubber-stamp the agent's confident-wrong outputs. The judge must be validated against human labels, and re-validated after a model upgrade.

4. **Real-model evals cost money and are non-deterministic.** Running 50 cases through `claude-sonnet-4-6` per prompt edit is real spend and the scores wobble run to run. You cache where you can, set a tolerance band, and accept that the gate is statistical, not exact.

### What to explore next

- **Pin every production miss as a case.** The moment a merchant gets a bad briefing, capture the anomaly + the canned tool results and add it to `evals/cases/` — the dataset's whole value is that it grows from real failures.
- **LLM-judge validation set.** Hand-label 20 query-agent answers, then measure the judge's agreement with your labels before trusting it on the other 30.
- **A/B prompt comparison.** Run two prompt versions over the same dataset and report the per-case win/loss/tie table, not just the two averages.

---

## Project exercises

### Lift strict detection past 0% — close the week-blind framing gap

- **Exercise ID:** C3.1 (adapted) — prompt-engineering case study: a measured-partial-win → next-iteration design.
- **What to build:** pick **Path A** (sliding-window scan plan in the monitoring prompt — multiple recent/baseline pairs covering different parts of the 26-week horizon, OR "look for the LARGEST per-week deviation across all weeks") OR **Path B** (a new `detect_outliers({ metric, dimension, horizon })` MCP tool that returns z-score outliers across the full horizon; the agent calls it once per dimension). Re-run `npm run eval:detection -- --K=10` and confirm the per-anomaly table shows sp-revenue-w4 and electronics-spike-w2 lifting above 0/10 strict.
- **Why it earns its place:** the eval-driven flywheel is real; the next turn of the crank already has a named target. The post-fix `summary.md`'s "What this means for next iteration" section names both paths explicitly. This exercise IS the senior-pattern: measure → name the deficit → propose a fix → re-measure.
- **Files to touch:** `lib/agents/prompts/monitoring.md` (Path A) OR `mcp-server-olist/src/tools/detect-outliers.ts` + monitoring tool catalog (Path B); rerun `eval/scripts/run-detection.ts`; write a new `eval/results/<date>/summary.md` with the delta.
- **Done when:** sp-revenue-drop-w4 or electronics-spike-w2 detects > 0/10 strict on K=10 with no regression on voucher (10/10 → 10/10).
- **Estimated effort:** Path A 30 min + ~$1-3; Path B 3-4 hours.

### Fix the diagnostic calibration deficit (29/30 = 0)

- **Exercise ID:** C3.2 (adapted) — close one criterion failure in the judge rubric.
- **What to build:** the diagnosis judge (`eval/judges/diagnosis-judge.md`) scores `calibration` as 0 in 29/30 runs because `diagnostic.md`'s confidence-derivation is binary ("3 hypotheses tested → high"). Rewrite the diagnostic prompt's confidence guidance to require hedging language ("appears", "suggests", "consistent with") when evidence is correlational, and to require a `confidence: 'medium'` floor unless a hypothesis is mechanistically proven. Re-run `npm run eval:diagnosis -- --K=10` and confirm calibration score lifts above 0 on a measurable fraction of runs.
- **Why it earns its place:** turns a generic "the model overclaims" finding into a specific prompt edit traceable to a criterion in a named rubric. This IS what eval-driven means — the prompt deficit has a number on it.
- **Files to touch:** `lib/agents/prompts/diagnostic.md` (the confidence-derivation lines + the `## Output` block's confidence field rule); rerun `eval/scripts/run-diagnosis.ts`; commit the new `eval/results/<date>/diagnosis-summary.md`.
- **Done when:** calibration mean > 0.3 on K=10 (was 1/30 = 0.03), no regression on the other 4 criteria (hypothesis/evidence/sizing/fabrication).
- **Estimated effort:** 1–4hr

### Validate the judges against human labels

- **Exercise ID:** C3.3 (adapted) — the Hamel discipline, made executable.
- **What to build:** hand-label 15 diagnostic outputs (pass/fail per criterion) and 15 recommendation outputs against the same rubrics the judges use. Compute per-criterion agreement (Cohen's kappa or simple % agreement) between your labels and the judges' scores. Document the result in `eval/judges/validation.md`. Until that document exists, the judge scores should be read as suggestive, not decisive.
- **Why it earns its place:** the judges in `eval/judges/*.md` are anchored (passing-anchor / failing-anchor examples in the prompt) but not yet validated. Anchoring is half of the discipline; rate-of-agreement with humans is the other half.
- **Files to touch:** new `eval/judges/validation.md`, new `eval/fixtures/human-labels/diagnosis-*.json` and `recommendation-*.json`.
- **Done when:** each criterion has a reported per-label agreement rate, and the validation doc honestly names any criterion where the judge disagrees with humans (this is where the rubric needs tightening, not the judge).
- **Estimated effort:** 2-4hr.

---

## Interview defense

### What an interviewer is really asking

"How do you know a prompt change made things better?" tests whether you stop at "I checked the output" or go to "I ran it against a fixed dataset and gated on aggregate-up-and-no-regression." The senior signal is naming the average-up-but-edge-case-down failure mode, distinguishing unit tests (shape) from evals (quality), and knowing the dataset — not the prompt — is the asset.

### Likely questions

**[mid] "You have 269 passing unit tests. Why aren't those evals?"**

Because they test shape, not answer quality. `test/agents/diagnostic.test.ts` injects a fake model and asserts that fenced JSON parses to a typed `Diagnosis` and garbage falls to `FALLBACK` — that is the structured-output contract under test. A hallucinated diagnosis with the right fields passes every one of those tests. The real eval lives under `eval/` and runs the actual agents against the seeded Olist dataset — that's the layer that scores whether the answer is *correct*.

```
unit test (test/)         → "is the shape right?"   (fake model, CI)
eval (eval/)              → "is the answer right?"  (real Sonnet, ~$1-3)
```

**[senior] "Walk me through a real prompt-engineering iteration in this codebase, with numbers."**

The Phase 2.5 monitoring fix is the receipt. Pre-fix loose recall on the 3 seeded anomalies: 6.7%. I added a DATA HORIZON section to `monitoring.md` (anchor the date range so the agent stops querying 2017 from training memory) and a 3-dimension scan plan ("state, category, payment_type — skip any, miss its anomaly"). Post-fix loose recall: 33.3% (5x). Voucher anomaly: 1/10 → 10/10. But the same eval named the limit: sp-revenue-w4 went 1/10 → 0/10 and electronics-spike-w2 stayed 0/10 strict, because the "recent 4w vs baseline 12w" framing fundamentally can't catch a mid-horizon week-specific anomaly. The win is real; the win is partial; both are numbers, not vibes.

```
prompt delta → +DATA HORIZON, +3-dim scan plan
detection eval K=10 → loose recall 6.7% → 33.3% (5x)
                    → voucher 1/10 → 10/10
                    → sp-revenue 1/10 → 0/10 (small regress, named)
                    → strict 0% → 0% (framing limit, named)
```

**[arch] "How does an LLM-judge here avoid rubber-stamping the agent it grades?"**

Two answers. The structural answer: the diagnosis judge (`eval/judges/diagnosis-judge.md`) is anchored — it ships with a passing-anchor and two failing-anchor examples (failing-on-sizing, failing-on-calibration), each scored line by line in the judge prompt itself, so the judge has explicit calibration before it sees the candidate. The empirical answer: I haven't validated it against human labels yet, and until I do, the judge scores are suggestive, not decisive. The discipline (Hamel's) is: hand-label 15 outputs, compute per-criterion agreement with the judge, only trust the judge on criteria where the agreement rate is high. That's the missing tier of the suite and the next exercise.

```
judge anchoring (built)    → pass-anchor + 2 fail-anchors per criterion
judge validation (TODO)    → hand-label 15, compute kappa per criterion
```

### The question candidates always dodge

**"How do you know your LLM judge is any good?"** You validate it against human labels first, and candidates dodge because they ship the judge unvalidated. An LLM judge often shares blind spots with the agent it grades (same model family) and will rubber-stamp confident-wrong output. Until it agrees with hand labels at a measured rate, it is vibes with extra latency. The honest answer leads with the validation step, not the judge.

### One-line anchors

- `eval/scripts/run-detection.ts` — the runner; spawns a real `OlistDataSource` and runs `MonitoringAgent` K times.
- `eval/scripts/lib/scorer.ts` — the detection scorer (LOOSE 2-of-3, STRICT 3-of-3).
- `eval/judges/diagnosis-judge.md` — the 5-criterion rubric (hypothesis/evidence/sizing/calibration/fabrication); the receipt for "the prompt deficit has a number on it."
- `eval/results/2026-06-15-after-fix/summary.md` — the per-anomaly delta table with the honest "what worked / what didn't" interpretation.
- `lib/agents/prompts/monitoring.md` `## DATA HORIZON` section + 3-dim scan plan — the Phase 2.5 prompt delta that drove loose recall 6.7% → 33.3%.
- `test/agents/diagnostic.test.ts` — unit test of shape, not quality; the layer evals complement.
- Hamel Husain, "Your AI Product Needs Evals" — the canonical reference.

---

## Validate

### Level 1 — Reconstruct

From memory, draw the eval loop: edit prompt → dataset → runner (real path) → scorer → gate. State the two conditions the gate checks and name which one, alone, ships silent regressions.

### Level 2 — Explain

Out loud: why are the 269 Vitest tests (e.g. `test/agents/diagnostic.test.ts`) NOT evals, and what does `eval/scripts/run-detection.ts` do that they cannot? Name the seam (unit tests inject fake Anthropic + fake DataSource; the eval spawns a REAL `OlistDataSource` subprocess and runs the real Sonnet 4.6 with the real production prompt).

### Level 3 — Apply

Scenario: you're proposing the Path A iteration from `eval/results/2026-06-15-after-fix/summary.md` (the sliding-window scan plan to lift sp-revenue-w4 above 0/10 strict). Write the prompt delta (the new scan-plan paragraph for `monitoring.md`), name which `npm run eval:*` command verifies it, and predict which per-anomaly cell in the next `summary.md` should move.

### Level 4 — Defend

A reviewer says: "Detection precision dropped from 0% to 0% strict and false positives doubled — that's a regression, revert the prompt." State the actual finding (loose recall +26.6, voucher 1/10 → 10/10, the framing limit named honestly), and the principle: a measured partial win + a named limit is a senior outcome; reverting because one number didn't move loses the voucher receipt and the per-anomaly visibility.

### Quick check — code reference test

Which file in `eval/judges/` contains the 5-criterion diagnosis rubric, and what is the pass threshold? (Answer: `eval/judges/diagnosis-judge.md`; criteria = hypothesis 0-2 + evidence 0-2 + sizing 0-2 + calibration 0-1 + fabrication 0-2; pass ≥7/9. The judge runs as a second Sonnet 4.6 call with the rubric as its system prompt; the candidate diagnosis is the user message; it returns JSON scores per criterion.)

## See also

→ 02-structured-outputs.md · → 03-prompts-as-code.md · → 10-self-critique.md · → 13-forbidden-patterns.md

---
Updated: 2026-05-29 — Updated the Vitest test count from 125 to 169 across all 11 body references (the suite grew this session).
Updated: 2026-05-29 — Resynced stale prompt-line refs (the {categories} shift + earlier prompt revisions): monitoring.md CRITICAL block L25–31→L31–37, small-baseline caution L23→L29; diagnostic.md historical-data block L36–42→L38–50, "customers matching" ban L33→L35; recommendation.md id-ban L64→L82; query.md prose L36→L49.
Updated: 2026-05-30 — Migrated to study.md v1.47 template (Phase 1+2 mechanical): removed Tradeoffs / Tech reference / Summary sections; renamed "In this codebase" → "Implementation in codebase"; moved See also to a bottom block. "Why care" preserved pending Phase 3 (Zoom out, then zoom in + LAYERS diagram) authoring.
Updated: 2026-05-30 — Phase 3 of study.md v1.47 migration: replaced "Why care" block with "Zoom out, then zoom in" (LAYERS diagram + zoom-in paragraph) per format.md.
Updated: 2026-05-31 — Applied study.md v1.48: scrubbed "How it works" of file paths, line refs, and real-code fences; replaced with generic role labels + pseudocode per format.md. Codebase-specific anchoring lives exclusively in "Implementation in codebase".
Updated: 2026-05-31 — Applied study.md v1.50: added Structure pass block (layers · axis · seams) between Zoom out and How it works per format.md's new Block 3.
Updated: 2026-06-16 — Phase 3 ships: flipped framing from "not yet implemented" to Case A. Rewrote Zoom-out, Part 2.5 (unit-tests-vs-evals), Part 3 (now references the real `eval/judges/*.md` files: 5-crit diagnosis + 3-crit recommendation + similarity), Implementation block (4-pillar runner + scorer + judges + fixtures + committed results), Project exercises (now: lift strict above 0%, fix calibration=29/30=0 deficit, validate judges vs human labels), and Interview defense. Added measured-receipt: Phase 2.5 monitoring fix drove loose recall 6.7% → 33.3% (voucher 1/10 → 10/10), with sp-revenue/electronics still 0/10 strict honestly named as a framing limit. Updated unit-test count 169 → 269.
