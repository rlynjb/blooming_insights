# 06 — The eval flywheel

**Industry names:** Eval-driven development / measure-fix-remeasure loop / model-quality regression tracking. **Type:** Industry-emerging discipline, project-specific cadence.

## Zoom out, then zoom in

Once Pillar 2 exists (file 05), it becomes a *driver* — not just a verdict. Each eval run surfaces a problem; the team ships a fix; the next eval run measures whether the fix moved the number; the gap between expected and observed surfaces the *next* problem. The Phase 3 PR cadence is the canonical flywheel — PR D found a recall gap, Phase 2.5 fixed it (5× loose-recall lift), PR E exposed a currency-units bug in the recommendation rubric, PR F's judge caught a recurrence on re-run, PR G surfaced conclusion instability across K=10. Each loop is one PR; each PR is one move on a numerical scoreboard.

```
Zoom out — where the flywheel sits in the development cycle

  ┌─ DEV WORK ─────────────────────────────────────────────────────────┐
  │                                                                    │
  │  ┌─ Implementation ──────────────────┐                              │
  │  │  edit prompt / model / tool dispatch│                              │
  │  └────────────────┬──────────────────┘                              │
  │                   │ committed                                       │
  │                   ▼                                                 │
  │  ┌─ Pillar 1: npm test (deterministic) ─┐                           │
  │  │  269 tests pass — wiring still works │  ← needed but not          │
  │  └────────────────┬─────────────────────┘     sufficient             │
  │                   │                                                 │
  │                   ▼                                                 │
  │  ┌─ ★ Pillar 2: the eval flywheel ★ ────────────────────────────┐  │
  │  │                                                                │ ← we are here
  │  │  measure → fix → re-measure → surface next gap → loop          │  │
  │  │                                                                │  │
  │  │  one PR per loop; receipts committed under eval/results/       │  │
  │  └─────────────────────────────────────────────────────────────┘  │
  │                                                                    │
  └────────────────────────────────────────────────────────────────────┘
```

Now zoom in. The interesting move is **how each loop's eval output becomes the input to the next loop's diagnosis** — and the testing discipline this imposes: per-run committed receipts, named PR scope, parallel-run hazards, and the "is the green bar moving for the right reason?" question.

## Structure pass

**Layers:** measurement → finding → fix → re-measurement → next finding. **Axis traced:** *what's the receipt for each step, and is it auditable?* **The seams where the answer flips:**

```
The axis "is this step auditable?" — across the flywheel

  axis traced = "if a reviewer asks 'show me', what do you point at?"

  ┌─ measurement step ─────────────────────────────┐
  │  npm run eval:detection -- --K=10              │  RECEIPT:
  │  → eval/results/<date>/                         │  the result dir
  │  → summary.md, detection-K10-*.json             │
  └──────────────────────┬─────────────────────────┘
                         │  flip 1: receipt now becomes
                         │  diagnostic input
                         ▼
  ┌─ finding step ─────────────────────────────────┐
  │  "loose-recall is 12% — that's too low"         │  RECEIPT:
  │  "Phase 2.5 hypothesis: the agent isn't        │  the PR description
  │   surfacing low-traffic segments"               │  + commit message
  └──────────────────────┬─────────────────────────┘
                         │  flip 2: hypothesis becomes
                         │  code change
                         ▼
  ┌─ fix step ─────────────────────────────────────┐
  │  PR with code change + maybe new deterministic  │  RECEIPT:
  │  tests for the wiring of the fix                │  the commit + new
  │                                                 │  npm test passes
  └──────────────────────┬─────────────────────────┘
                         │  flip 3: fix gets re-measured
                         │  against same anomalies
                         ▼
  ┌─ ★ re-measurement step ★ ──────────────────────┐
  │  EVAL_RUN_TAG=after-fix npm run eval:detection  │  RECEIPT:
  │  → eval/results/<date>-after-fix/               │  side-by-side
  │  → diff baseline vs after-fix in commit message │  before/after,
  │  → "loose-recall: 12% → 62% (5× lift)"         │  both committed
  └──────────────────────┬─────────────────────────┘
                         │  flip 4: re-measurement output
                         │  reveals the next finding
                         ▼
  ┌─ surface-next-gap step ─────────────────────────┐
  │  PR E saw the lift but spotted: "the rec for    │  RECEIPT:
  │  the SP-revenue anomaly is denominated in USD   │  next PR description
  │  but the dataset is in BRL — currency-unit bug" │  cites the receipt
  └──────────────────────┬─────────────────────────┘
                         │
                         └─► loops back to measurement
```

The flip that matters across the whole pattern: **every step leaves a committed receipt that becomes the input to the next step.** Without the receipts, "we fixed it" is unverifiable; with them, the PR description literally cites file paths under `eval/results/`. That's the testing discipline.

## How it works

### Move 1 — the mental model

The flywheel is just a control loop where the sensor is the eval suite, the controller is the engineer reading the receipts, and the actuator is a PR. The discipline that makes it work as a *testing* methodology rather than a vibes-based dev cycle is *every loop produces an audit trail*.

```
The flywheel — sensor / controller / actuator

  ┌─ sensor (eval suite) ────┐
  │  reads model behavior    │  ← K=10 captures, rubric scores,
  │  emits structured signal │     pass-rate %, per-criterion mean
  └────────────┬─────────────┘
               │ signal
               ▼
  ┌─ controller (the engineer) ─┐
  │  reads receipts             │  ← cross-reference against
  │  forms a hypothesis         │     production code, prompts,
  │  designs the next move      │     tool schemas
  └────────────┬────────────────┘
               │ commit
               ▼
  ┌─ actuator (a PR) ──────────┐
  │  code change + the new     │  ← PR description names the
  │  EVAL_RUN_TAG receipt that │     receipt before and after
  │  proves the fix moved      │
  │  the number                │
  └────────────┬───────────────┘
               │ effect
               ▼
   (loop closes back to sensor on next eval run)
```

The discipline: nothing in this loop is verbal. Every transition is a file path or a number on a scoreboard.

### Move 2 — the walkthrough

#### Loop 1 — PR D (measure baseline, find recall gap)

PR D shipped the detection eval — `eval/scripts/run-detection.ts` + the seeded anomalies in `mcp-server-olist/`. The first K=10 run produced a baseline that nobody had ever seen before: the MonitoringAgent was catching ~12% of seeded anomalies under LOOSE matching (2-of-3 criteria), well below what the team had assumed. Receipt: `eval/results/2026-06-15/summary.md`.

```
Loop 1 — PR D — establish baseline + find first gap

  measure:    npm run eval:detection -- --K=10
              → loose recall: ~12%, strict recall: lower
  receipt:    eval/results/2026-06-15/summary.md
  finding:    "the agent doesn't surface low-traffic segments — the rubric
               counts them, the agent skips them"
  next:       Phase 2.5 — a prompt + tool-dispatch fix
```

Without the eval pillar this PR wouldn't have existed. The "wiring works" green bar on `npm test` already passed — there was no other instrument that would have surfaced "the agent passes its unit tests but misses 88% of the anomalies it's deployed to catch."

#### Loop 2 — Phase 2.5 fix + re-measurement (5× lift)

Phase 2.5 shipped a fix: changes to the monitoring prompt and the order of tool dispatch so the agent saw segment data earlier in the loop. Then a second K=10 run, tagged so it wouldn't clobber the baseline.

```
Loop 2 — Phase 2.5 fix + re-measure

  fix:        prompt + tool-dispatch change
  test:       npm test (269 still green — wiring not broken)
  re-measure: EVAL_RUN_TAG=after-fix npm run eval:detection -- --K=10
              → loose recall: ~62% (5× lift from baseline 12%)
  receipt:    eval/results/2026-06-15-after-fix/summary.md
  reviewer:   reads both result dirs side-by-side; diff is the proof
```

The `EVAL_RUN_TAG=after-fix` is load-bearing: without it, the second K=10 would overwrite `eval/results/2026-06-15/` and the baseline would be gone. The fix would still be in the code; the *proof* the fix worked would not.

#### Loop 3 — PR E (diagnosis + recommendation evals — currency-unit bug surfaced)

PR E extended the suite from detection to diagnosis and recommendation. The new judges revealed a bug the previous loops couldn't see: the RecommendationAgent was occasionally denominating expected impact in USD when the Olist dataset is entirely in BRL. The recommendation judge's `SPECIFIC (0-2)` criterion caught it twice in the first K=10 — the calibration spot-check confirmed the judge was right.

```
Loop 3 — PR E — diagnosis + recommendation evals find currency bug

  measure:    npm run eval:diagnosis -- --K=10
              npm run eval:recommendation -- --K=10
  receipt:    eval/results/<date>/diagnosis-K10-scores.json
              eval/results/<date>/recommendation-K10-scores.json
  finding:    recommendation judge flagged 2/10 candidates for an
              SP-revenue anomaly with USD-denominated impact strings
              ("$X recovered") when ground truth is BRL ("R$X")
  calibration: human spot-checked judge agreement — 3/3 including
              this bug catch
  next:       PR F — fix the agent prompt to enforce dataset currency
```

The calibration receipt is what made the bug-find credible. Without it a reviewer could reasonably push back: "the judge could be hallucinating the bug — show me." With it: "the human spot-check agrees 3/3, including this exact case."

#### Loop 3.5 — the parallel-run incident

In the middle of PR E development, the main session was running `npm run eval:diagnosis -- --K=10` from a Bash session. A sub-agent (a parallel Claude Code instance working on PR E) ALSO triggered a K=10 run against the same date dir. Both processes targeted `eval/results/2026-06-15/`. The incident is the canonical post-mortem for parallel-run hazards in non-deterministic test infrastructure.

```
The K=10 race condition — what happened, how it was caught

  T0   main session: npm run eval:diagnosis -- --K=10  (PID 30039)
        writes to eval/results/2026-06-15/diagnosis-K10-raw.json (partial)
  T1   sub-agent:    npm run eval:diagnosis -- --K=10  (PID 30040)
        ALSO writes to eval/results/2026-06-15/diagnosis-K10-raw.json
        (would have clobbered)
  T2   main session: ps aux | grep eval  ← detected the duplicate process
  T3   kill 30039 30040  ← killed BOTH before either completed
  T4   re-ran with EVAL_RUN_TAG set so results landed in a labeled dir

  RESULT: zero data loss; but the receipt for "we caught it" is the kill
          command + the subsequent tagged re-run. The proof a reviewer
          would ask for: ps aux output snapshot from T2.
```

The lesson maps directly to the `vi.stubEnv` flake-fix story (file 03): shared mutable state across parallel test runs is a hazard. There the shared state was `process.env`; here it's a filesystem dir. Same family of fix, different layer. Today `EVAL_RUN_TAG` is the mitigation but it's opt-in — the file-03 fix's analogue (a tracked, framework-enforced mutator) hasn't been built. Red-flag 12 in the audit names it.

#### Loop 4 — PR F (judge catches recurrence on re-run)

After PR E's currency-unit fix landed, PR F re-ran the recommendation eval. The judge caught one regression — the fix had over-corrected for the BRL/USD distinction and produced a candidate that quoted "R$0" (zero) for impact. The judge's `IMPACT-SIZED (0-1)` criterion fired. PR F walked back the fix to keep the BRL discipline without breaking the impact magnitude.

```
Loop 4 — PR F — judge catches over-correction

  measure:    after PR E's BRL fix, re-run recommendation eval
  receipt:    eval/results/<date>-pr-f/recommendation-K10-scores.json
  finding:    judge total dropped on 1/10 candidates from 4 → 2 because
              the rec text said "R$0 impact" — currency right, magnitude wrong
  fix:        prompt change that preserves currency-unit discipline but
              requires a non-zero numeric impact
  re-measure: judge pass rate restored
```

The methodology that makes this a *test*: PR F's commit message cites two receipts (the broken K=10, the fixed K=10) by file path. A reviewer can audit the actual scores in either result dir without taking anyone's word for it.

#### Loop 5 — PR G (capture + score regression goldens — conclusion instability)

PR G shipped the regression eval — capture mode + score mode. Capture writes K=1 outputs to `eval/fixtures/regression-golden/<fixture>.json`. Score mode runs the same fixtures, structurally diffs the new output against the captured golden, and additionally runs an LLM similarity judge for non-structural fields. The first score run surfaced something the previous loops couldn't see: **conclusion instability**. Two of the ten regression fixtures produced *different conclusions* across runs — same input, different anomaly identified, different recommendation thrust. The structural diff alone would have missed it (different text); the similarity judge caught it.

```
Loop 5 — PR G — regression goldens surface conclusion instability

  capture:    npm run eval:regression -- --capture
              → 10 fixtures, K=1 each, written to eval/fixtures/regression-golden/
  score:      npm run eval:regression
              → structural diff + similarity-judge per fixture
              → 2/10 flagged "same_conclusion: false" by judge
  finding:    monitoring fixture `02-monitoring-3-anomalies` produced a
              DIFFERENT anomaly on the second run; not a wording shift,
              an actual different finding
  reviewer:   eval/results/<date>-score-baseline/ shows the judge's
              reasoning; human spot-check confirms — agreement received
  next:       not yet shipped — instability surfaced, root-cause TBD
```

This is the highest-value PR in the cadence so far: it didn't catch a bug, it revealed that the *foundation assumption* of regression testing — "same input → same output (mostly)" — doesn't hold here. The fix isn't a prompt change; it's a methodology shift toward K-runs-per-fixture in regression mode too. The receipt is the score-baseline dir; the next move is design, not code.

### Move 2 variant — the load-bearing skeleton

Drop any one of these four and the flywheel collapses into vibes-based development:

1. **Receipts at every transition.** The eval result dir for each loop must be *committed*, not just regenerated. Without committed receipts, "we fixed it" is hearsay. The Phase 3 paper trail (`2026-06-15/`, `2026-06-15-after-fix/`, `2026-06-15-capture/`, `2026-06-15-score-baseline/`) IS the discipline.

2. **A discriminator that prevents same-day clobber.** `EVAL_RUN_TAG`. Without it, re-running the eval after a fix overwrites the baseline; the proof the fix worked vanishes.

3. **A PR-per-loop cadence.** The PR description cites the before/after receipts by file path. A loop without a PR (or a PR that bundles three loops together) loses the traceability — you can't tell which change moved which number.

4. **Calibration receipts for every judge change.** When the rubric is edited (or the judge model is bumped), the agreement-with-human spot-check needs to be re-run. Without it, "the judge changed but the receipts didn't" silently invalidates the scoring of every prior loop.

Skeleton = committed receipts + tagged result dirs + PR-per-loop + calibration receipts. Optional hardening: a lockfile guard (audit's red-flag 12) and an enforcing CI hook that refuses to merge a PR that touches eval scripts without a new score-baseline dir.

### Move 3 — the principle

**Testing-driven development at the model-behavior layer is the same shape as TDD at the function layer — write the assertion first, then write the code, then watch the assertion go green.** What changes is the vocabulary: the assertion is a rubric, the code might be a prompt edit, the "green" is a pass-rate. The discipline that distinguishes useful eval work from theatre is the receipt at every step. Vibes are not committed; numbers are. The whole flywheel is built on that one rule.

## Primary diagram

The full Phase 3 PR cadence, every loop labelled:

```
The Phase 3 eval flywheel — PR D through PR G, with receipts

  ┌─ PR D (loop 1) ──────────────────────────────────────────────────┐
  │                                                                  │
  │  measure baseline:    npm run eval:detection -- --K=10           │
  │  receipt:             eval/results/2026-06-15/                   │
  │  finding:             loose-recall ~12% (much lower than assumed)│
  │  ────────────────────────────────────────────────────────────────│
  │                       ▼                                          │
  │  Phase 2.5 fix:       prompt + tool-dispatch order               │
  │  npm test:            269 still green                            │
  │                       ▼                                          │
  │  re-measure:          EVAL_RUN_TAG=after-fix npm run eval:       │
  │                                              detection -- --K=10│
  │  receipt:             eval/results/2026-06-15-after-fix/         │
  │  result:              loose-recall ~62% (5× lift)                │
  │                                                                  │
  └──────────────────────────────────┬───────────────────────────────┘
                                     │ surface next gap
                                     ▼
  ┌─ PR E (loop 3) ──────────────────────────────────────────────────┐
  │                                                                  │
  │  extend suite:        + diagnosis + recommendation evals          │
  │  receipt:             eval/results/<date>/diagnosis-K10-scores   │
  │                                          recommendation-K10-...  │
  │  finding:             recommendation judge flagged USD-denom for │
  │                       BRL dataset — currency-unit bug             │
  │  calibration:         3/3 human-vs-judge agreement (incl. this)  │
  │                       eval/results/<date>-score-baseline/        │
  │  ────────────────────────────────────────────────────────────────│
  │  PR E race incident:  main session + sub-agent both ran K=10     │
  │  detection:           ps aux + kill 30039 30040                  │
  │  mitigation:          re-run with EVAL_RUN_TAG                   │
  │                                                                  │
  └──────────────────────────────────┬───────────────────────────────┘
                                     │
                                     ▼
  ┌─ PR F (loop 4) ──────────────────────────────────────────────────┐
  │                                                                  │
  │  fix:                 prompt change to enforce BRL currency      │
  │  re-measure:          eval/results/<date>-pr-f/                   │
  │  finding:             over-correction — "R$0 impact" caught by   │
  │                       recommendation judge IMPACT-SIZED criterion│
  │  fix:                 walk back; preserve BRL but require        │
  │                       non-zero magnitude                          │
  │  receipt:             commit message cites both result dirs by   │
  │                       path                                       │
  │                                                                  │
  └──────────────────────────────────┬───────────────────────────────┘
                                     │
                                     ▼
  ┌─ PR G (loop 5) ──────────────────────────────────────────────────┐
  │                                                                  │
  │  capture goldens:     npm run eval:regression -- --capture       │
  │  receipt:             eval/fixtures/regression-golden/*.json     │
  │                       (10 fixtures, K=1 each)                    │
  │  score:               npm run eval:regression                    │
  │  receipt:             eval/results/2026-06-15-score-baseline/    │
  │  finding:             2/10 fixtures flagged "same_conclusion:    │
  │                       false" — CONCLUSION INSTABILITY across     │
  │                       runs (not wording shifts, real divergence) │
  │  next move:           NOT a prompt change — a methodology shift  │
  │                       toward K-runs-per-fixture in regression    │
  │                                                                  │
  └──────────────────────────────────────────────────────────────────┘
```

## Implementation in codebase

**Use case A — the result-dir paper trail.** The whole flywheel is committed under `eval/results/`. Every loop's receipt is a directory with a `summary.md` and per-eval JSON files. A reviewer auditing PR D → PR E can `ls eval/results/` and see the dates lined up.

```
eval/results/                             what each dir represents
────────────                              ────────────────────────
2026-06-15/                               PR D baseline detection K=10
2026-06-15-after-fix/                     Phase 2.5 fix re-measure (5× lift proof)
2026-06-15-capture/                       PR G capture mode (10 fixtures, K=1)
2026-06-15-score-baseline/                PR G score mode + calibration receipts
       │
       └─ name pattern: <date>-<EVAL_RUN_TAG> — the tag IS the audit trail.
          Without it, all four runs would land in 2026-06-15/ and clobber
          each other; with it, each is a distinct commit-ready receipt.
```

**Use case B — `EVAL_RUN_TAG` honored at every entry point.** All four eval scripts respect the env var the same way, so the discipline is uniform.

```
eval/scripts/run-detection.ts  (lines 92–97)

  // EVAL_RUN_TAG lets a same-day re-run land in a sibling dir (e.g.
  // 2026-06-15-after-fix), so a fix can be measured without clobbering
  // the prior baseline.
  const tag = process.env.EVAL_RUN_TAG;
  const dateDir = tag ? `${todayIso()}-${tag}` : todayIso();
       │
       └─ same six lines repeat in run-diagnosis.ts, run-recommendation.ts,
          and run-regression.ts. Uniform discipline = the operator doesn't
          have to remember which script handles tags differently.

eval/scripts/run-regression.ts  (lines 178–183)

  // Results dir — EVAL_RUN_TAG honored (matches PRs D/E/F).
  const tag = process.env.EVAL_RUN_TAG;
  const dateDir = tag ? `${todayIso()}-${tag}` : todayIso();
       │
       └─ identical pattern. Cf. the comment block in file 03 ("the comment
          IS the post-mortem"): naming WHY the pattern exists is part of
          keeping it alive across refactors.
```

**Use case C — the calibration receipt as a fork in the flywheel.** When a loop's eval result is suspicious, the next step isn't always "fix the code." Sometimes it's "spot-check the judge." Loop 3's BRL bug was confirmed via the calibration receipt at `eval/results/<date>-score-baseline/`. Without that fork, "the judge says there's a bug" and "there actually is a bug" are indistinguishable.

## Elaborate

The eval flywheel as a methodology is an LLM-era specialization of the older measure-fix-remeasure cycle from systems performance work (a flame-graph-driven optimization loop, a load-test-driven scaling loop). The form is identical: instrumented sensor, hypothesis, intervention, re-measurement. What changes is the assertion vocabulary — "is the latency budget met?" becomes "did the model pass the rubric?" The discipline that distinguishes useful work from theatre travels: receipts at every transition, per-PR cadence, named-not-bundled fixes.

The deeper cross-reference is to test-driven development at the code layer. TDD says: write the test first, watch it fail, write the code, watch it pass. The eval flywheel says: write the rubric first, run it (it fails — the baseline is below bar), make the change, re-run it (it passes — the fix moved the number). Both rest on the same primitive: the assertion is committed before the implementation, so the implementation can be measured against it.

Cross-reference: `study-debugging-observability`'s "the trace IS the test" — the NDJSON event stream is what makes the eval suite possible (every tool call is a span, every step is a timestamp). Without observability, there's no input for the eval; without the eval, the observability data is just logs. The two disciplines compose.

## Interview defense

**Q: How is this different from just running tests?** The receipts. A normal test run produces a binary (green / red) and an exit code; that's all the audit trail a green CI run leaves. The flywheel produces a *committed result directory* per loop, with per-anomaly per-criterion scores, the K-run distribution, and a calibration receipt for the judge. Six months later, "did this fix actually work?" is a `git log` + `cat eval/results/<date>-<tag>/summary.md`, not a memory.

**Q: Why per-PR loops instead of bundling fixes?** Traceability. A PR that bundles three changes produces one before/after delta — you can't tell which change moved which number. PR D → E → F → G is four discrete deltas. When PR F's over-correction caused a regression on the recommendation judge, the PR-per-loop discipline meant the team could roll back exactly PR F's fix without touching PR E's. Bundle and you lose that.

**Q: What's the failure mode of this methodology?** Judge drift. The rubric is an LLM call; the LLM behind the rubric is itself a moving target (Anthropic ships model updates, behaviour shifts subtly). If the calibration receipts aren't refreshed when the judge model is bumped, the same rubric prompt could quietly score differently across loops — and the numerical scoreboard would lie. The mitigation is exactly the discipline already in place: receipts committed alongside every judge change, calibrated against human spot-check before being trusted. The vulnerability is real but the discipline closes it.

**Q: What pre-condition makes this possible?** The `DataSource` seam from Phase 2. Without an injectable production seam, the eval suite couldn't run the *real* agent against a controlled data source; it would have to run a parallel for-testing copy, and a green eval against the parallel copy would not prove the production agent works. The flywheel only works because Pillar 1 and Pillar 2 share the seam.

## Validate

1. **Reconstruct:** Without looking, list the four load-bearing parts of the eval flywheel. Which one is the discipline that distinguishes "real methodology" from "vibes-based dev"?
2. **Explain:** Walk through what would have happened in the PR E parallel-run incident if `EVAL_RUN_TAG` didn't exist. What proof would have been lost?
3. **Apply:** Sketch the loop for a hypothetical PR H — the team bumps Sonnet 4.6 to a newer model. What measures, what fixes, what receipts? Include the calibration step.
4. **Defend:** A reviewer says "you're just iterating on prompts until the number looks good — this is Goodhart's-law-bait." Push back with the rubric-criteria-not-just-totals argument and the calibration receipts that prevent the judge from being optimized for.

## See also

- `audit.md#testing-ai-features` — the seam where Pillar 1 hands off to Pillar 2
- `audit.md#testing-red-flags-audit` — flag 12 (parallel-run hazard) is the next discipline-gap the flywheel needs
- `03-vi-stubenv-isolation.md` — the original "shared mutable state is a hazard" post-mortem; same family of fix at the env-var layer
- `05-llm-eval-as-testing.md` — Pillar 2 as a standalone discipline; this file is what you do with it once it exists
- (external) `eval/README.md` — the operational runbook
- (external) `.aipe/study-debugging-observability/` — the NDJSON trace pillar that makes eval input possible

---
Updated: 2026-06-16 — New concept file. Names the eval flywheel as a testing-driven development methodology at the model-behavior layer. Walks the Phase 3 PR D→E→F→G cadence with committed receipts at each step. Surfaces the K=10 parallel-run incident as the canonical post-mortem (cf. file 03's AUTH_SECRET flake — same family). Cross-links to red-flag 12 (lockfile gate as the unbuilt next discipline).
