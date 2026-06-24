# Eval-driven iteration (iterate against a golden set, not vibes)

**Industry name(s):** eval-driven development, golden-set / regression-set iteration, LLM-as-judge, offline evaluation harness
**Type:** Industry standard · Language-agnostic

> The senior-vs-junior line in prompt work is this: a junior edits a prompt, eyeballs one output, and ships; a senior runs the edited prompt against a fixed set of labeled cases and ships only if the score holds AND no critical case regressed. blooming insights does NOT yet have that layer in-repo — the prior `eval/` harness has been removed. The prompts ARE visibly iterated-by-incident: every "CRITICAL"/"Never"/"Do NOT" block in the legacy markdown is a past production miss encoded as prose. That is informal regression encoding; it is not a scored gate. The buildable target — a dataset + runner + scorer + gate that turns those prose blocks into measurable cases — is the Case B exercise this file teaches.


---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Eval-driven iteration is an *orthogonal* path that should run parallel to the request flow, not inside it. You edit a prompt at the Per-agent definitions band; a (hypothetical) eval suite would exercise the real production path (Per-agent definitions → Shared agent loop → Provider) from a separate entry point. In this repo today, the orthogonal band is empty — the prior `eval/` runner, scorer, judges, and fixtures are gone. The discipline is real prompt engineering; the harness is the buildable gap.

```
  Zoom out — where eval-driven iteration would live

  ┌─ Engineer edits prompt ─────────────────────────┐
  │  lib/agents/legacy-prompts/<name>.md  OR        │
  │  @aptkit/prompts (package source)                │
  └─────────────────────────┬────────────────────────┘
                            │
  ┌─ EVAL band (EMPTY) ─────▼─────────  ┌─ Request flow ──────┐
  │  ✗ no eval/fixtures/                │ app/api/agent/route │
  │  ✗ no eval/scripts/run-*.ts         │ → Pipeline coord    │
  │  ✗ no scorer / no judges            │ → Per-agent defs    │
  │  ✗ no committed results history     │ → Shared agent loop │
  │                                     │ → Provider          │
  │  the buildable Case B target        │ ↓                   │
  │  (dataset + runner + scorer + gate) │ user receives result │
  └──────────────────────────────────────────────────┘
       informal regression encoding lives in the prompts:
       every CRITICAL / Never / Do NOT block is a past miss
```

**Zoom in — narrow to the concept.** The question this file answers: how do you know the edit that fixed today's bug didn't silently break a case you fixed three weeks ago? A golden set + runner + scorer + gate moves the definition of "better prompt" out of your head and onto a number, with the gate checking two things — aggregate up AND no critical case regressed. The prompts in this repo encode that lesson informally — every CRITICAL block is a regression fix in prose — but nothing scores them. Below, you'll see why unit tests aren't evals, what the runner has to share with production, the LLM-judge trap, and the per-anomaly diff that catches the "average up but one case regressed" failure.

---

## Structure pass

**Layers.** Eval-driven iteration is a four-layer loop that should live in a *dev-time* band parallel to the production request path, and the layers don't help unless you keep them at that altitude. Layer A is the *dataset* — 20–50 labeled cases accreted from real production misses, each one a bug you already paid for. Layer B is the *runner* — a script that exercises the *real* agent classes (loaded prompt, real model, real validator) against each case, with an injected deterministic `McpCaller` so the tool results are reproducible. Layer C is the *scorer* — a field assertion for JSON agents or an LLM-judge for the prose agent, turning each output into pass/fail or 0–1. Layer D is the *gate* — the two-condition ship check: aggregate up AND no critical case regressed.

**Axis: lifecycle.** When does each layer fire — at dev-time (the edit), at ship-gate-time (the merge), or never (the gap)? Lifecycle is the right axis because the whole concept is a *parallel timeline* to the request flow. In this repo today, all four layers fire at *never* — the harness is not in the codebase. The closest existing artifact is the prose CRITICAL blocks in the legacy prompts, which fire at *prompt-author-review time* and only as text the next reviewer might honor. That is a dataset waiting to be written; it is not a runner.

**Seams.** Two seams matter. Seam 1 (A↔B) — the dataset is *static-and-curated*, the runner uses the *live agent classes and the live model* (non-deterministic by nature); a deterministic injected `McpCaller` would be the gate that makes the case reproducible despite the model being sampled. The load-bearing seam is Seam 2 (C↔D) — lifecycle flips from *measuring* (per-case scores) to *deciding* (ship or reject). And this is exactly where the "average went up" trap lives: a single-condition gate (only aggregate) ships silent regressions; a two-condition gate (aggregate AND zero per-case regressions) catches them. The whole value of having a harness is that this seam stops being a vibe and starts being a number — which is precisely the value the codebase does not yet capture.

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

### Part 2.5 — current state: unit tests are not evals (and the evals don't exist)

This is the distinction the brief demands be named plainly. blooming insights has 221 Vitest tests **and** no eval suite. The two layers do completely different jobs, and the absence of the second is the gap this whole file teaches.

```
UNIT TEST (test/)                   EVAL (not in repo)
──────────────────────────────     ──────────────────────────────
inject fake provider + fake mcp     would use REAL provider + real
                                    data source (subprocess or fake)
assert: the parser returns          would score: did the agent detect
        an object of the right       the seeded anomaly? did the
        shape; shape guard passes    diagnosis pass a rubric?
─────────────────────────────────────────────────────────────
"does the contract hold?"           "is the answer any good?"
deterministic, no model call        non-deterministic, real model
runs on every PR (CI)               would run on demand
```

The diagnostic agent's unit tests prove that when the fake model returns fenced JSON, the investigate path returns a typed `Diagnosis`, and when it returns garbage, the chain falls to a fallback value. That is the structured-output contract (→ 02-structured-outputs.md) under test. It says nothing about whether the diagnosis is *right*. A hallucinated-but-well-shaped diagnosis passes every one of those 221 tests. The harness that would catch that is the Case B buildable target — the rest of this file walks what it should look like when built.

---

### Part 3 — the scorer, and the LLM-judge trap

A built harness for this codebase would split into three scorers, one per agent shape.

For the monitoring agent (detection), scoring would be a code assertion against a heuristic matcher: LOOSE = metric + segment match the seeded anomaly (2-of-3); STRICT = LOOSE + a time-window signal (3-of-3). Each emitted insight is matched against each seeded anomaly; a hit increments true-positives, a miss is a false-positive.

For the diagnostic agent (free-form reasoning + structured fields), scoring is an LLM-as-judge against a rubric: hypothesis quality, evidence cited, sizing of affected customers, calibration of the confidence field, fabrication. Pass threshold by aggregate. Each criterion failure points back to a specific prompt deficit — the judge IS the prompt engineer's feedback loop.

For the recommendation agent, same shape with a smaller rubric (plausibility, specificity, impact-sized).

```
SCORER per agent  (what to build)
─────────────────────────────────────────────────────────────
 monitoring   →  detection match (LOOSE 2-of-3 / STRICT 3-of-3)
                 heuristic regex + segment-name lookup
 diagnostic   →  LLM-judge, multi-criterion rubric
                 (hypothesis / evidence / sizing / calibration / fabrication)
 recommend    →  LLM-judge, 3-criterion rubric
                 (plausible / specific / impact_sized)
 query        →  similarity-judge for prose
```

The trap to name (Hamel's discipline): an LLM judge is itself a model that can be wrong, and it is often wrong in a *correlated* way with the model it grades — particularly when both are Sonnet, as they would be here. You must validate the judge against human labels before you trust the score. Anchor examples in the judge prompt (passing-anchor, failing-anchor per criterion) give you half of that validation; the other half is rate-of-agreement with hand labels. Skipping that step replaces "I think this looks good" with "a model thinks this looks good" — same vibes-based iteration with extra latency.

---

### The principle

Eval-driven iteration moves the definition of "better prompt" out of your head and into a number on a fixed dataset, and it gates every change on two conditions, not one: the aggregate improved AND no critical case regressed. The dataset — accreted one production miss at a time — is the asset; the prompt is disposable. blooming insights has the misses written as CRITICAL blocks in the legacy prompts; the harness that turns those blocks into measurable cases is the buildable target this file teaches. The flywheel exists in concept and in prose; it does not yet exist in code.

---

## Eval-driven iteration — diagram

This diagram spans the loop. The Engineer edits a prompt; the Harness layer runs the real production path over a fixed dataset and scores each output; the Gate compares both the aggregate and the per-case deltas before allowing a ship. The feedback edge — every production miss becomes a new permanent case — is what makes the dataset grow stronger than memory.

```
┌──────────────────────────────────────────────────────────────────────┐
│  ENGINEER                                                             │
│   edits a prompt file (e.g. tightens the empty-window rule            │
│   in the monitoring prompt, or bumps @aptkit/prompts)                 │
└───────────────────────────┬───────────────────────────────────────────┘
                            │
┌───────────────────────────▼───────────────────────────────────────────┐
│  HARNESS LAYER   eval/  (NOT in repo — the buildable Case B target)   │
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

**Case B — not yet implemented.** The eval harness is not in the repo; the closest existing artifact is the informal regression encoding inside the legacy prompts. The Project exercises block below is the buildable path.

### The informal regression suite (currently the only layer present)

- **File:** `lib/agents/legacy-prompts/{monitoring,diagnostic,recommendation,query}.md`
- **Function / class:** the CRITICAL / Never / Do NOT blocks within each prompt
- **Role:** every CRITICAL block is a regression fix encoded as prose — `monitoring.md`'s empty-window block, the small-baseline caution, `diagnostic.md`'s historical-data block, the `customers matching` ban — each one a production miss the team already paid for. The legacy prompts honor them; nothing scores them.

### The seam that would make a harness cheap

- **File:** `lib/agents/base.ts` · `lib/agents/base-legacy.ts`
- **Function / class:** the shared agent loop injects both the provider SDK client and an MCP-caller dependency — the same seam the 221 unit tests use to pass fakes.
- **Role:** the dependency-injection point a future eval runner would borrow from. For an eval the move is the *opposite* of a unit test: keep the real provider client (you want real model behavior), inject a *deterministic* MCP caller that returns canned tool results per case, so each case is reproducible.

### The reference shapes the harness would score against

- **File:** `lib/state/demo-insights.json` · `lib/state/demo-investigations.json`
- **Role:** the committed demo snapshots are the closest in-repo artifact to "reference outputs for known inputs" — they record valid Anomaly / Diagnosis / Recommendation shapes that a future harness's LLM-judge could use as anchors. They were committed for the demo path, not for eval, but the data shape is the same.

### Why this is Case B, not Case A

The harness, dataset, runner, scorer, judge prompts, and committed results history would all be net-new files. The pattern is real prompt engineering and the codebase has the *seams* (dependency injection, snapshot fixtures) that would make a harness cheap to build — but none of it ships today.

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

### Build a minimal detection eval harness

- **Exercise ID:** C3.1 (adapted) — stand up the first scoring layer end-to-end.
- **What to build:** a small `eval/` folder with a fixtures directory (~10–20 cases per agent — each one a CRITICAL block from the legacy prompts re-encoded as `{ input, canned_mcp_results, expected_match }`), a runner script that imports the real `MonitoringAgent` from `lib/agents/monitoring.ts` with an injected deterministic MCP caller, and a scorer that emits per-case pass/fail plus an aggregate. Start with detection — the easiest scorer to write because pass/fail is a heuristic match, not a judge.
- **Why it earns its place:** the harness is the missing layer named by every part of this file. Detection-first means you ship one scorer end-to-end before paying for the LLM-judge complexity.
- **Files to touch:** new `eval/fixtures/detection/*.json`, new `eval/scripts/run-detection.ts`, new `eval/scripts/lib/scorer.ts`; `lib/agents/monitoring.ts` (verify the MCP caller is injectable from outside the route).
- **Done when:** `npm run eval:detection` exits 0/non-0 with a per-case + aggregate table, and a known-bad prompt edit fails the gate.
- **Estimated effort:** 1 day.

### Add an LLM-judge for the diagnostic agent

- **Exercise ID:** C3.2 (adapted) — extend the harness to the prose-and-structured-field agent.
- **What to build:** once detection scores, add `eval/judges/diagnosis-judge.md` with a multi-criterion rubric (hypothesis quality, evidence cited, sizing of affected customers, confidence calibration, fabrication) and a runner that calls the judge as a second model call per case. Anchor the rubric with one passing-anchor and one failing-anchor example per criterion so the judge has explicit calibration before it scores the candidate.
- **Why it earns its place:** demonstrates the pattern that catches "well-shaped but wrong" output — exactly the gap that structured-output validators (→ 02-structured-outputs.md) leave open.
- **Files to touch:** new `eval/judges/diagnosis-judge.md`, new `eval/scripts/run-diagnosis.ts`, new `eval/fixtures/diagnosis/*.json`.
- **Done when:** running the diagnostic eval emits a per-criterion score, and re-running after a prompt edit shows movement on the criterion the edit targeted.
- **Estimated effort:** 1–2 days.

### Validate the judges against human labels

- **Exercise ID:** C3.3 (adapted) — the Hamel discipline, made executable.
- **What to build:** hand-label ~15 diagnostic outputs (pass/fail per criterion) against the same rubric the judge uses. Compute per-criterion agreement (Cohen's kappa or simple % agreement) between your labels and the judge's scores. Document the result in `eval/judges/validation.md`. Until that document exists, judge scores should be read as suggestive, not decisive.
- **Why it earns its place:** the anchored rubric from the previous exercise is half of the discipline; rate-of-agreement with humans is the other half. Without it the judge is a model rubber-stamping another model.
- **Files to touch:** new `eval/judges/validation.md`, new `eval/fixtures/human-labels/diagnosis-*.json`.
- **Done when:** each criterion has a reported per-label agreement rate, and the validation doc honestly names any criterion where the judge disagrees with humans (this is where the rubric needs tightening, not the judge).
- **Estimated effort:** 2–4hr.

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

## See also

→ 02-structured-outputs.md · → 03-prompts-as-code.md · → 10-self-critique.md · → 13-forbidden-patterns.md

---
