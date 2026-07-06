# Exercise 09 — wire the gate

## ① verdict

An eval that doesn't block a bad deploy is a notebook. Yours already
gates: `eval/gate.eval.ts` reads `eval/baseline.json`, computes a
per-dimension delta, and fails the CI check if any dim regresses by
more than `GATE_MAX_REGRESSION` (default 10pp). It's wired into
`.github/workflows/ci.yml`. The exercise is to know it works — because
you have the receipt that it *did* work: Move 3.

## ② analogy

A smoke detector wired to the alarm, not one you have to remember to
sniff. The gate is the wire. Without it, your eval is a lab test the
dev runs when they think about it — which is never in practice.

## ③ in your repo

Everything is on disk:

- `eval/gate.eval.ts` — the gate logic
- `eval/baseline.json` — committed reference (runId `2026-07-03T04-08-28-644Z`, 10 cases)
- `eval/baseline.eval.ts` — computes a fresh baseline from receipts
- `.github/workflows/ci.yml` — CI (typecheck + `npm test` + `npm run build`)
- `eval/gate-2026-07-03T18-11-06-952Z.json` — the LIVED gate output from Move 3's failed candidate run

## ④ human track — the threshold decision

The gate's default `GATE_MAX_REGRESSION = 0.10` is a business call. Ten
percentage points is generous — enough to absorb stochastic variance
from a temperature-0 judge, tight enough to catch a real regression.
That number is yours to own.

Failure semantics you decided:

- **Per-dimension gate.** A regression on ANY dim blocks. Not a weighted overall score. (This is stricter, but it catches the failure mode where one critical dim tanks while three others drift up.)
- **Only regressions block.** Improvements are logged but don't gate. (You can add a "no-improvement expected but got one" trip wire later; not shipped today.)
- **Baseline is committed.** `baseline.json` is in git, not floating on a shared drive. A PR that regresses the baseline can also propose updating the baseline — a deliberate act, not an accident.

The `GATE_MAX_REGRESSION` env var lets you tighten for a run (e.g.,
`GATE_MAX_REGRESSION=0.05` for stricter gating on a specific PR). The
default is what CI uses; the override is for local runs when you want
to see how close a candidate is.

## ⑤ AI track — the gate implementation + CI wiring

Claude wrote `gate.eval.ts` (187 LOC) against your contract:

- Read `baseline.json`.
- Discover the latest candidate `runId` from receipts.
- Compute per-dim pass rate delta.
- Fail if any dim regressed > threshold.
- Write a `gate-<runId>.json` receipt on disk.

The contract you specified is *what the gate protects against*. Claude
filled in the math.

Verification of the gate — not "I read Claude's code," but the receipt
that the gate actually fired:

> **The Move 3 receipt** — `eval/gate-2026-07-03T18-11-06-952Z.json`
> is the gate output from Move 3's candidate run. The candidate
> shipped `filterSupportedHypotheses` at the handoff. The gate
> computed per-dim delta:
>
> - `diagnosis_response`: 50% → 27% (Δ −23pp) — REGRESSED
> - `feature_choice_fit`: 58% → 40% (Δ −18pp) — REGRESSED
> - `step_actionability`: 100% → 87% (Δ −13pp) — REGRESSED
> - `impact_realism`: 42% → 20% (Δ −22pp) — REGRESSED
>
> All four blocking. Gate failed. Fix reverted.

That IS the gate proving it works. Not a synthetic test — a real regression
caught before merge.

## ⑥ do it

1. Open `.github/workflows/ci.yml`. Note what runs on CI today
   (typecheck + `npm test` + `npm run build`). The gate is not yet
   in the CI step list — it lives in `eval/gate.eval.ts` and is
   opt-in via `RUN_GATE=1`. Decide: does CI run the gate on every PR
   (adds ~$1.30/PR in Anthropic cost + ~7 min), or gated on a label,
   or nightly only?
   - **Coach's read**: nightly + label-triggered on PRs that touch
     `lib/agents/*`, `lib/mcp/*`, or `eval/*`. Full-time on every PR
     is expensive; on-touch is proportional.
2. Run the gate against Move 3's candidate to reproduce the receipt:
   ```bash
   RUN_ID=2026-07-03T18-11-06-952Z RUN_GATE=1 npm run eval:gate
   ```
   Confirm the output matches `eval/gate-2026-07-03T18-11-06-952Z.json`.
   This is the "prove it fails on a known-bad change" step from the
   spec — and it fails because it already did, live.
3. Run the gate against the current baseline for a passing case (any
   run at or above baseline):
   ```bash
   RUN_ID=2026-07-03T04-08-28-644Z RUN_GATE=1 npm run eval:gate
   ```
   The baseline compared against itself passes trivially (Δ = 0 on
   every dim). This is the "prove it passes on a good one" step.
4. Consider updating the baseline. If you've grown adversarial cases
   (Ex 06) or done a full calibration pass (Ex 05), the current
   baseline is stale and every eval run compares against a snapshot
   from a different regime. Regenerating the baseline is:
   ```bash
   npm run eval && npm run eval:baseline > eval/baseline.json
   ```
   Then commit `baseline.json`. Baseline updates are deliberate PRs
   — the gate blocks unless the baseline moves, so updating the
   baseline IS how the numbers ratchet up.
5. Wire the gate into CI as its own job when you're ready — a job that
   runs on PRs touching the agent/rubric surface and blocks merge on
   regression. Cost the decision honestly: ~$1.30 per PR at 10 cases,
   ~7 min. If that's tolerable, ship. If not, run gated on labels or
   on `main` post-merge.

## ⑦ done when

- You can point at `eval/gate-2026-07-03T18-11-06-952Z.json` and say: *"this is the gate blocking a bad change I tried to ship — Move 3."*
- You can reproduce that gate output locally by running the gate on the Move 3 candidate `runId`.
- You have a decision about whether the gate runs on every PR, on-label, or nightly, and can defend the cost vs signal tradeoff.
- A known-good change (baseline-vs-baseline, or an improvement) passes the gate. A known-bad change (Move 3 candidate) fails it.
- You can say the interview sentence: *"the gate is real. The receipt is `gate-2026-07-03T18-11-06-952Z.json`. It fired on a candidate that regressed by 13–23pp across all four recommendation dims, and I reverted."*
