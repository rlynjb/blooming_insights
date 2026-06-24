# 05 — LLM eval as testing

> **RETIRED 2026-06-18.** This file was authored against the Olist MCP
> server / Phase 3 eval pipeline, both removed from the codebase. The
> patterns it teaches are real, but the code anchors it cites no longer
> exist. Preserved as a historical record of what was studied.

**Industry names:** Offline eval / LLM-as-judge / golden + adversarial set / rubric-scored regression. **Type:** Industry standard for AI products; project-specific in how it's wired into the `DataSource` seam.

## Zoom out, then zoom in

`npm test` answers "did the wiring break?" It does not — and cannot — answer "did the model regress?" The Phase 3 eval suite is the second testing pillar: probabilistic by design, expensive, non-deterministic, and deliberately run on a separate track. Same agents, same code paths, same `DataSource` seam — but instead of a scripted Anthropic fake and a fake DataSource, the eval suite spawns the **real** `OlistDataSource` (seeded SQLite) and lets the **real** `runAgentLoop` call Sonnet 4.6 K times. Each output is scored against an LLM-as-judge rubric or compared structurally to a seeded ground truth.

```
Zoom out — where this pattern lives, both pillars side by side

  ┌─ TEST CODE ────────────────────────────────────────────────────────┐
  │                                                                    │
  │  ┌─ Pillar 1: npm test (deterministic) ─────────────────────────┐  │
  │  │  test/agents/*.test.ts                                         │  │
  │  │     scripted Anthropic + fake DataSource → real agent loop    │  │
  │  │     269 tests; <10s; assertion = `expect(...).toBe(...)`      │  │
  │  └─────────────────────────────────────────────────────────────┘  │
  │                                                                    │
  │  ┌─ ★ Pillar 2: npm run eval:* (probabilistic) ★ ───────────────┐  │ ← we are here
  │  │  eval/scripts/{run-detection,run-diagnosis,                   │  │
  │  │                run-recommendation,run-regression}.ts          │  │
  │  │     real Anthropic + real OlistDataSource → real agent loop  │  │
  │  │     K=10 per anomaly; 5-30 minutes; ~$10-15 full Phase 3      │  │
  │  │     assertion = LLM judge ≥ N OR structural diff matches      │  │
  │  └─────────────────────────────────────────────────────────────┘  │
  │                                                                    │
  └────────────────────────────────┬───────────────────────────────────┘
                                   │ both call into
  ┌─ PRODUCTION CODE (unchanged) ──▼───────────────────────────────────┐
  │                                                                    │
  │  lib/agents/*  +  lib/data-source/types.ts (DataSource interface)  │
  │     ↑ same agents, same loop, same interface                       │
  │     ↑ Pillar 1 injects fakes; Pillar 2 injects real OlistDataSource│
  │                                                                    │
  └────────────────────────────────────────────────────────────────────┘
```

Now zoom in. The interesting move is **how the eval suite turns a non-deterministic LLM output into a stable assertion** — and the discipline it carries: K-run variance capture, rubric calibration against human judgment, pre-flight gates, and a separation contract with `npm test`.

## Structure pass

**Layers:** seeded ground truth → real agent run → captured candidate output → judge (LLM or structural) → score → aggregate over K runs. **Axis traced:** *how is correctness asserted, and against what reference?* **The seams where the answer flips:**

```
The axis "what's the assertion?" — across pillars and within Pillar 2

  axis traced = "how do you decide pass/fail?"

  ┌─ Pillar 1 (npm test) ─────────────────────────┐
  │  expect(x).toBe(y)                             │  EQUALITY against a
  │  same input → same output                      │  test-author constant
  └──────────────────┬────────────────────────────┘
                     │  flip 1: assertion shape changes
                     ▼
  ┌─ ★ Pillar 2 (eval:detection) ─────────────────┐
  │  scoreRun(insights, seededAnomalies)           │  STRUCTURAL match against
  │  → precision, recall under LOOSE / STRICT       │  seeded ground truth
  │                                                 │  (2-of-3 vs 3-of-3 criteria)
  └──────────────────┬────────────────────────────┘
                     │  flip 2: ground truth becomes harder
                     ▼                              to express structurally
  ┌─ ★ Pillar 2 (eval:diagnosis, eval:rec) ★ ─────┐
  │  judgeDiagnosis(candidate, reference, anomaly) │  LLM-AS-JUDGE rubric:
  │  → { right_hypothesis: 0-2, real_evidence: 0-2,│  5 criteria for diagnosis
  │      segment_sizing: 0-2, calibrated_conf: 0-1,│  3 criteria for rec
  │      no_fabrication: 0-2 }                     │  pass if total ≥ N
  │  total ∈ [0,9]; pass ≥ 7                       │
  └──────────────────┬────────────────────────────┘
                     │  flip 3: judge is itself an LLM —
                     ▼  is the judge calibrated?
  ┌─ Calibration layer (manual spot-check) ───────┐
  │  human scores N captures; compare to judge     │  HUMAN-vs-JUDGE
  │  → 8/8 agreement on diagnosis judge            │  (8/8 + 3/3 receipts
  │  → 3/3 on rec judge (caught BRL-currency bug)  │   committed under
  └──────────────────┬────────────────────────────┘    eval/results/...)
                     │
                     ▼
  ┌─ Variance capture (K=10) ─────────────────────┐
  │  10 independent runs per anomaly               │  DISTRIBUTION, not point
  │  report mean, min, max; one bad run ≠ verdict  │  estimate
  └───────────────────────────────────────────────┘
```

The flips that matter: **assertion → rubric → judge calibration → K-run variance.** Each layer adds a new way the eval could lie to you (judge biased, K too small, ground truth wrong) and a discipline that controls it.

## How it works

### Move 1 — the mental model

The whole pillar is one recursive structure: you wrote tests for the wrapper code in `npm test`; the eval suite is a test for the *model's output*, which itself uses *another model* to judge. The discipline is what stops "an LLM judging an LLM" from devolving into noise.

```
The eval kernel — agent loop wrapped in a scoring loop

  ┌─ for each seeded anomaly a in [seeded_anomalies] ─┐
  │   for k in 1..K:                                   │  ← outer K-run loop
  │     spawn fresh OlistDataSource (stdio subprocess) │     captures variance
  │     capture = runAgentOnce(a, dataSource, sessionId)│
  │     score   = scoreOrJudge(capture, reference, a)  │
  │     perRun[k] = score                              │
  │   summary[a] = aggregate(perRun)                   │  ← mean / pass-rate
  │                                                     │     across K
  └───────────────────────────────────────────────────┘
```

The outer K-loop is the load-bearing scoring discipline: one run lies, ten runs surface the distribution. The inner agent run is the *exact production code path* — same agents, same loop, just a different DataSource implementation underneath the seam.

### Move 2 — the walkthrough

#### The DataSource seam at the eval boundary (the load-bearing reuse)

The single most important thing about how Pillar 2 is wired: it reuses Pillar 1's seam. Production `runAgentLoop` takes a `DataSource` parameter. Pillar 1 passes a fake. Pillar 2 passes the real `OlistDataSource`. The agent code in the middle is *unchanged* and *unaware* of which pillar is running it.

```
The shared seam — Pillar 1 and Pillar 2 both swap at DataSource

                          shared agent code
                          ┌──────────────────────┐
                          │ runAgentLoop({       │
                          │   anthropic,          │ ← swapped per pillar
                          │   dataSource,         │ ← swapped per pillar
                          │   …,                  │
                          │ })                    │
                          └──────────────────────┘
                            ▲                  ▲
                            │                  │
  Pillar 1 (npm test) ──────┘                  └────── Pillar 2 (npm run eval:*)
   anthropic: vi.fn fake                          anthropic: real SDK call
   dataSource: 5-line literal                     dataSource: OlistDataSource
   assertion: expect(...).toBe(...)                          (stdio subprocess)
                                                  assertion: judge(...) ≥ N
```

That's the Phase 2 payoff in one sentence: one seam, two consumers, two assertion styles, same production agent in the middle.

#### Ground truth — what the eval is asserting *against*

Detection asserts structurally against seeded anomalies; diagnosis and recommendation assert against *reference outputs* that a human curated as one-valid-answer-shape examples; regression asserts against *captured goldens* from a known-good run.

```
The 4-eval ground-truth ladder

  eval                ground truth                       assertion shape
  ────                ────────────                       ───────────────
  detection           3 seeded anomalies in olist.db     2-of-3 / 3-of-3
                      (metric + segment + time-window)   structural match

  diagnosis           reference-diagnoses.json           5-criterion rubric,
                      (one valid answer per anomaly)     judge total ≥ 7

  recommendation      reference-recommendations.json     3-criterion rubric,
                      (one valid answer per diagnosis)   judge total ≥ 4

  regression          eval/fixtures/regression-golden/   structural diff +
                      *.json (10 captured outputs)       similarity judge
```

The asymmetry matters: detection's ground truth is *checkable structurally* (does the agent surface the seeded segment?). Diagnosis can't be — "did the agent reason correctly?" is irreducibly probabilistic. The rubric is how you collapse it to a number.

#### The LLM-as-judge rubric (diagnosis example)

The diagnosis judge scores against 5 criteria, total 0-9, pass ≥ 7. Each criterion has explicit anchors (the rubric file at `eval/judges/diagnosis-judge.md` includes Anchor A — PASSING total=8, Anchor B — FAILING on sizing + calibration total=5, Anchor C — PASSING but borderline total=7). Anchors prevent "judge drifts to its own bias."

```
The 5-criterion diagnosis rubric

  criterion              max   what it measures
  ─────────              ───   ────────────────
  1. RIGHT HYPOTHESIS    0-2   does the diagnosis identify the seeded cause?
  2. REAL EVIDENCE       0-2   are tool-call citations actually in the transcript?
  3. SEGMENT SIZING      0-2   are affected-customer counts plausible vs ground truth?
  4. CALIBRATED          0-1   does confidence track evidence strength?
     CONFIDENCE
  5. NO FABRICATION      0-2   any made-up tool calls / numbers?
  ─────────              ───
  total                  0-9   pass threshold: ≥ 7
```

The 5-criterion split is itself a testing discipline: a candidate that scored 8/9 with a 0 on NO FABRICATION is *worse* than one that scored 7/9 with all criteria above 1. Subscores carry information the total hides.

#### Calibration as testing the test

The judge is itself an LLM. Without calibration receipts the score means nothing. The discipline: manually score N captures with a human, compare to the judge's scores. The Phase 3 receipts:

```
The calibration receipts (committed under eval/results/...)

  judge                  receipt                                 agreement
  ─────                  ───────                                 ─────────
  diagnosis-judge.md     8 captures hand-scored vs judge         8/8
                                                                 (full agreement)
  recommendation-judge   3 captures hand-scored vs judge         3/3
                                                                 (incl. BRL-currency
                                                                  bug catch — judge
                                                                  flagged a candidate
                                                                  that quoted USD
                                                                  values when the
                                                                  dataset is in BRL)
  similarity-judge.md    captured via regression eval baseline   structural-diff +
                                                                 judge agreement
                                                                 documented in
                                                                 eval/results/<date>-
                                                                 score-baseline/
```

Without the receipts, "the diagnosis judge passed" is a number without a unit. With them, "the diagnosis judge passed AND it agrees with my hand-scoring on 8/8 captures" is a measurement. That asymmetry is what makes an LLM judge a test.

#### K=10 — variance capture as discipline

A single agent run is one sample from a distribution. Sonnet 4.6 with temperature > 0 (default) emits a different response every time; even identical prompts produce different tool-call sequences, different evidence picks, different confidence values. K=10 turns "did it pass?" into "what's the pass rate?"

```
K=10 in pseudocode — distribution, not point estimate

  for k in 1..10:
    spawn fresh OlistDataSource subprocess     // hermetic per run
    capture = runAgent(anomaly, dataSource)    // one sample
    score   = judge(capture)                   // one judge call
    perRun.push({ k, capture, score })
  end

  summary = {
    mean:     mean(perRun.score.total),
    passRate: count(score ≥ 7) / K,
    minScore: min(perRun.score.total),
    perCriterion: meanByCriterion(perRun),
  }

  // ↑ mean tells you the average, passRate tells you reliability,
  //   minScore tells you the worst-case (the run that would scare a customer).
```

K=10 is the validated number for the portfolio; K=30 would tighten the precision/recall confidence interval to ~±10% (per `eval/README.md`). The cost scales linearly; the agreement-with-human signal does not.

#### EVAL_RUN_TAG — same-day re-runs don't clobber

Every eval script honors `process.env.EVAL_RUN_TAG`. Without it, results land in `eval/results/2026-06-15/`. With it, they land in `eval/results/2026-06-15-after-fix/` (or whatever suffix). The discipline this enforces: a same-day re-run after a fix doesn't overwrite the baseline. The committed paper trail proves the fix moved the number:

```
eval/results/                    what's in it
────────────                     ────────────
2026-06-15/                      first detection K=10 (loose-recall ~12%)
2026-06-15-after-fix/            same K=10 after Phase 2.5 fix (loose-recall ~62%)
2026-06-15-capture/              regression goldens captured (PR G)
2026-06-15-score-baseline/       baseline scored against the just-captured goldens
                                  (judge calibration receipts)
```

That sequence — capture, fix, re-measure, baseline — IS the eval flywheel (file 06). `EVAL_RUN_TAG` is what makes it possible to keep both halves of the receipt.

#### Pre-flight gates — refusing to run on bad inputs

Every eval script begins with hard exits on missing prerequisites. From `eval/scripts/run-detection.ts`:

```
The pre-flight pattern — refuse early, refuse loud

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY not set. Add it to .env.local and re-run.');
    process.exit(1);                                  ← exit on bad config
  }
  if (anomalies.length === 0) {
    console.error('No seeded anomalies in DB. Re-seed mcp-server-olist.');
    process.exit(1);                                  ← exit on missing fixture
  }

  // PR G adds one more: the regression scorer refuses to run
  // if any fixture has null golden_output.
  if (uncaptured.length > 0) {
    console.error(`${uncaptured.length}/${fixtures.length} fixtures have null
                   golden_output. Run \`npm run eval:regression -- --capture\`
                   first.`);
    process.exit(1);                                  ← exit on missing goldens
  }
```

This is design-in safety for non-deterministic test infrastructure. The eval suite costs money to run; a half-configured run produces meaningless data that wastes both money and the reviewer's time. Better to refuse and tell the operator exactly what to fix.

### Move 2 variant — the load-bearing skeleton

Drop any one of these five and the eval pillar collapses into noise:

1. **A shared seam between Pillar 1 and Pillar 2.** Drop this and you'd be evaluating different code than you ship — the eval suite would run a parallel "for testing" copy of the agent, and a green eval would not prove the production agent works. The `DataSource` interface IS the load-bearing seam.

2. **A rubric with anchors, not just criteria.** Drop the anchors and the judge's interpretation drifts run-to-run. The diagnosis judge file has three labelled anchors (PASSING 8, FAILING 5, BORDERLINE 7); without them, "did the judge score this 7?" depends on which way the judge happened to lean.

3. **Calibration receipts (judge vs human spot-check).** Drop these and "the judge passed" is meaningless — you can't tell whether the judge is correctly calibrated or has its own systematic bias. 8/8 + 3/3 are the receipts; they're committed.

4. **K=10 variance capture.** Drop this and you treat one stochastic run as ground truth. The model could be unreliable in ways a single run won't show.

5. **`EVAL_RUN_TAG` + result-dir versioning.** Drop this and same-day re-runs clobber the receipts. The fix-then-measure flywheel (file 06) literally cannot work without per-run isolated result dirs.

Skeleton = shared seam + anchored rubric + calibration receipts + K-run variance + tagged results. Optional hardening: a lockfile guard on the result dir (not built today; mentioned in audit's red-flag 12).

### Move 3 — the principle

**Non-determinism doesn't mean unmeasurable; it means you measure differently.** `npm test` answers "did the wiring break?" — one binary per assertion. The eval suite answers "did the model regress?" — a *distribution* per anomaly, judged against an anchored rubric, calibrated against a human spot-check. Both are testing. They use different vocabularies because they answer different questions. A team that ships AI features with only `npm test` is shipping wiring without quality measurement; a team that ships only evals is shipping without a CI safety net. Both pillars.

## Primary diagram

The full Pillar 2 architecture, every part labelled:

```
The Phase 3 eval suite — full view

  ┌─ TRIGGER ───────────────────────────────────────────────────────────┐
  │   $ EVAL_RUN_TAG=after-fix npm run eval:diagnosis -- --K=10         │
  └──────────────────────────────────┬──────────────────────────────────┘
                                     │
  ┌─ PRE-FLIGHT GATES (process.exit(1) on miss) ────────────────────────┐
  │   • ANTHROPIC_API_KEY set?                                          │
  │   • OlistDataSource subprocess built? (mcp-server-olist/dist/)      │
  │   • seeded_anomalies table populated?                                │
  │   • (regression-only) every fixture has captured golden_output?     │
  └──────────────────────────────────┬──────────────────────────────────┘
                                     │
  ┌─ OUTER K-LOOP — variance capture ───────────────────────────────────┐
  │                                                                      │
  │   for each anomaly a in [seeded_anomalies]:                          │
  │     for k in 1..K (=10):                                             │
  │       ┌─ fresh subprocess per run ─┐                                 │
  │       │  spawn OlistDataSource     │  ← hermetic, crash-isolated    │
  │       │  (stdio MCP transport)     │                                 │
  │       └──────────┬─────────────────┘                                 │
  │                  │                                                   │
  │                  ▼                                                   │
  │       ┌─ REAL agent run ──────────────────┐                          │
  │       │  runDiagnosticAgentOnce(a, ds, …) │  ← SAME agent code as   │
  │       │     → conclusion                   │     production; SAME    │
  │       │     → evidence[]                   │     DataSource seam.    │
  │       │     → hypothesesConsidered[]       │                          │
  │       │     → captured tool-call trace     │                          │
  │       └──────────┬─────────────────────────┘                          │
  │                  │                                                   │
  │                  ▼                                                   │
  │       ┌─ JUDGE call (Anthropic again) ────┐                          │
  │       │  judgeDiagnosis({                  │                          │
  │       │    anomaly, reference,             │  ← rubric from           │
  │       │    candidate: capture,             │     judges/diagnosis-    │
  │       │    transcript: capture.toolCalls   │     judge.md             │
  │       │  })                                │                          │
  │       │  → { right_hypothesis: 0-2, … }    │                          │
  │       │  → total ∈ [0,9]                   │                          │
  │       └──────────┬─────────────────────────┘                          │
  │                  │                                                   │
  │       perRun[k] = { capture, score }                                 │
  │     end for k                                                        │
  │     summary[a] = aggregate(perRun)  // mean, passRate, perCriterion │
  │   end for a                                                          │
  └──────────────────────────────────┬──────────────────────────────────┘
                                     │
  ┌─ OUTPUT — committed paper trail ────────────────────────────────────┐
  │                                                                      │
  │   eval/results/<YYYY-MM-DD>[-<EVAL_RUN_TAG>]/                       │
  │     summary.md             ← human-readable scorecard                │
  │     diagnosis-K10-raw.json ← every capture (audit trail)            │
  │     diagnosis-K10-scores.json ← every judge call's full output      │
  │     model-versions.json    ← which Claude version produced this    │
  │                                                                      │
  └──────────────────────────────────────────────────────────────────────┘

  CALIBRATION (separate, manual, committed):
  ┌─────────────────────────────────────────────────────────────────────┐
  │  human spot-scores N captures from one results/ dir                 │
  │  compare to that dir's judge scores                                 │
  │  agreement counts (8/8, 3/3) committed under                        │
  │  eval/results/<date>-score-baseline/                                │
  │                                                                      │
  │  if disagreement: judge prompt needs revision (rare); cycle.        │
  └─────────────────────────────────────────────────────────────────────┘
```

## Implementation in codebase

**Use case A — the pre-flight + K-loop driver.** `eval/scripts/run-detection.ts` is the canonical entry point.

```
eval/scripts/run-detection.ts  (lines 92–135 — main driver)

  // EVAL_RUN_TAG lets a same-day re-run land in a sibling dir
  const tag = process.env.EVAL_RUN_TAG;
  const dateDir = tag ? `${todayIso()}-${tag}` : todayIso();
         │
         └─ env-var-derived result dir is the no-clobber discipline; without
            it, two K=10 runs same day overwrite each other's receipts.

  async function main(): Promise<void> {
    if (!process.env.ANTHROPIC_API_KEY) {
      console.error('ANTHROPIC_API_KEY not set. Add it to .env.local and re-run.');
      process.exit(1);                            ← pre-flight gate 1
    }
    const K = parseK();
    const anomalies = loadSeededAnomalies();
    if (anomalies.length === 0) {
      console.error('No seeded anomalies in DB. Re-seed mcp-server-olist.');
      process.exit(1);                            ← pre-flight gate 2
    }
    for (let i = 1; i <= K; i++) {                 ← THE OUTER K-LOOP
      const capture = await runMonitoringAgentOnce(i, `${sessionId}-run${i}`);
      const score = scoreRun(capture.insights, anomalies);
      perRun.push({ k: i, capture, score });
    }
  }
       │
       └─ K=10 is the validated production number; each iteration spawns a
          fresh subprocess so a crash in run i doesn't poison run i+1. That's
          variance capture + hermetic-per-run, in one loop.
```

**Use case B — the pre-flight refusal in the regression eval.** `eval/scripts/run-regression.ts` has the strictest pre-flight in the suite — it refuses to score if any fixture has a null `golden_output`, which would otherwise silently produce meaningless similarity-judge calls.

```
eval/scripts/run-regression.ts  (lines 387–399 — pre-flight for score mode)

  async function scoreMode(): Promise<void> {
    const fixtures = loadFixtures();
    // Pre-flight: every fixture must have a golden. Fail loud upfront.
    const uncaptured = fixtures.filter((f) => f.golden_output == null);
    if (uncaptured.length > 0) {
      console.error(
        `[regression:score] ${uncaptured.length}/${fixtures.length} fixtures have null golden_output:`,
      );
      for (const f of uncaptured) console.error(`  - ${f.id}`);
      console.error('');
      console.error('Run `npm run eval:regression -- --capture` first to populate goldens.');
      process.exit(1);                            ← refuse, with remediation
    }
  }
       │
       └─ this is testing-discipline at the eval-infrastructure layer: design
          in the safety, fail fast on a misconfiguration, tell the operator
          the exact next command. A regression eval that silently runs against
          missing goldens would produce numbers nobody could interpret.
```

**Use case C — the calibration receipt.** Committed at `eval/results/2026-06-15-score-baseline/` — the directory where the human-vs-judge agreement was recorded after the Phase 3 baseline run. The diagnosis judge agreed 8/8 with hand-scoring; the recommendation judge agreed 3/3 (and one of the three catches was the BRL-currency bug — the judge flagged a candidate that quoted USD when the seeded dataset is in BRL). Without those receipts, the judge scores would be uncalibrated and the "passed ≥ 7" assertion would mean nothing.

## Elaborate

LLM-as-judge as a testing discipline is the same shape as code review for human engineers — a more-experienced reviewer scores a candidate's work against criteria, and the scoring itself is the test. The discipline that distinguishes a working eval from theatre is exactly the discipline that distinguishes useful code review from rubber-stamping: anchored rubrics (not gut feel), calibration (the reviewer's biases known), and variance capture (one good day isn't a hire). OpenAI's `evals` library, Anthropic's `inspect_ai`, and Langfuse all draw the same set of lines; the Phase 3 suite here just rolls the same primitives by hand against the seeded Olist dataset.

The deeper cross-reference is to `01-scripted-anthropic-harness.md`: that pattern fakes both seams (Anthropic + DataSource) to test the wrapper deterministically. This pattern keeps both seams real to test the *model* probabilistically. The asymmetry between the two pillars — what's faked vs what's real — is what makes them complementary rather than duplicative.

Cross-reference: `study-software-design`'s "deep modules with small interfaces are easy to test" — the `DataSource` interface is exactly such a deep module, and Pillar 2 is the receipts that prove the design pays off. Same agents, two implementations, both pillars share the seam, the seam is what makes the eval suite *possible*.

## Interview defense

**Q: Why is the eval suite separate from `npm test`?** Three reasons. (1) **Cost.** A full Phase 3 run is ~$10–15 on Anthropic; running it on every PR would burn through budget instantly. (2) **Determinism.** `npm test` is "same input → same output, every time." The eval suite is probabilistic by design — K=10 surfaces a distribution, not a point. Mixing them would produce CI flakes that erode trust in the deterministic suite. (3) **Runtime.** Each eval script takes 5–30 minutes; the deterministic suite is <10s. Putting them in the same command would either make CI unbearably slow or train developers to skip slow tests.

```
The two pillars are different *kinds* of test

  pillar 1 (npm test)              pillar 2 (npm run eval:*)
  ──────────────────              ──────────────────────────
  deterministic                    probabilistic
  cheap (free)                     ~$10-15 full spend
  fast (<10s)                      5-30 min per script
  per-PR in CI                     per-release, per-fix, on-demand
  green = wiring works             green = model output meets bar
  red = code regression             red = quality regression (or judge drift)
```

Two pillars, one product, complementary signals.

**Q: How do you trust an LLM judge to score another LLM's output?** Calibration. The judge is itself a tool — and like any tool, it can be measured. You manually score N captures, compare to the judge's scores, and accept the judge only when the agreement is high enough. The Phase 3 receipts are 8/8 on the diagnosis judge and 3/3 on the recommendation judge (including a real bug catch — the BRL-currency one). Those numbers are committed in `eval/results/<date>-score-baseline/` so a reviewer can audit the delta themselves. Without those receipts, "the judge passed" is meaningless.

**Q: Why K=10 instead of just running it once?** Because one run is one sample from a distribution. Sonnet 4.6 with default temperature emits different responses to identical inputs — different tool-call sequences, different evidence picks, different confidence values. K=10 captures the variance: mean, pass-rate, min-score. The mean tells you the average; the pass-rate tells you reliability; the min-score tells you the worst case that would scare a customer. The validated number for portfolio use is K=10; K=30 tightens precision/recall confidence to ~±10% but ~triples the cost.

**Q: What does this pillar NOT catch?** The *production* MCP path. The eval suite runs against `OlistDataSource` because it's faster, hermetic, and deterministic enough for seeded ground truth. Production runs against `BloomreachDataSource`. The agents are the same; the data underneath isn't. If the Bloomreach schema has quirks the Olist seed doesn't, a green eval would not prove production quality. That's the load-bearing gap of the current revision — named in audit's Top-3, not yet closed.

## See also

- `audit.md#testing-ai-features` — the seam where Pillar 1 hands off to Pillar 2
- `audit.md#testing-red-flags-audit` — flags 7 (no live-MCP contract) and 12 (parallel-run) are the remaining open gaps in this pillar
- `01-scripted-anthropic-harness.md` — Pillar 1's mirror pattern; same `DataSource` seam, both fakes
- `06-eval-flywheel.md` — measure → fix → re-measure as a methodology built on top of this pillar
- (external) `eval/README.md` — the operational runbook (one-time setup, npm scripts, cost notes)
- (external) `.aipe/study-ai-engineering/05-evals-and-observability/` — model-architecture / rubric-design theory deep walk

---
Updated: 2026-06-16 — New concept file. Names LLM-eval-as-testing as the second pillar of this folder; covers the 4-eval suite, anchored rubrics, calibration receipts (8/8 diagnosis + 3/3 recommendation incl. BRL bug catch), K=10 variance, EVAL_RUN_TAG result-dir versioning, pre-flight gates as testing discipline, and the eval-vs-npm-test boundary. Anchored to `eval/scripts/run-detection.ts` (lines 92–135) and `eval/scripts/run-regression.ts` (lines 387–399) with file-line grounding.
Updated: 2026-06-24 — Stripped `## Validate` block per spec v1.68.3 (the Validate primitive was removed from the per-concept template; block 10 is now `See also`).
