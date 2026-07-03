# eval — offline evaluation harness

Domain data (goldens, rubrics, calibration) for the tier-2 hardening plan. The
reusable engine (`RubricJudge`, scorers, replay-runner) lives in
[`@aptkit/evals`](https://www.npmjs.com/package/@rlynjb/aptkit-core) via
`@aptkit/core`; this folder is thin glue plus blooming's domain vocabulary.

## Layout

```
eval/
├── goldens/          case files: an Anomaly + "known-correct shape" per case
├── rubrics/          RubricDefinitions (currently: diagnosis quality)
├── receipts/         JSON receipts, one per run (gitignored)
└── run.ts            end-to-end runner
```

## Run

```bash
npm run eval
```

Requires `ANTHROPIC_API_KEY` in `.env.local` (or the environment). Uses
`SyntheticDataSource`, so no OAuth, no Bloomreach, no network beyond Anthropic.

Runner is vitest (via `vitest.eval.config.ts`) — the same module resolver
`npm test` uses. `eval/**/*.eval.ts` is excluded from `npm test` by the
default config's `include` pattern.

## What Week 1 ships

**ONE golden case**, end-to-end:

1. `SyntheticDataSource` (in-process, deterministic)
2. `DiagnosticAgent` investigates the golden anomaly
3. `RubricJudge` scores the diagnosis on 4 dimensions (root-cause plausibility,
   evidence grounding, scope coherence, actionable next step)
4. Receipt written to `receipts/<case>-<runId>.json`

Approximate cost: **~$0.15 per run** (one diagnostic session + one rubric
judgment on Sonnet 4.6).

## What Week 1 does NOT ship

- The full golden set (20–30 cases, Week 2)
- Hand-labeled calibration slice + judge-vs-human agreement (Week 2)
- Detection recall@k — needs `scoreRecallAtK` from aptkit 0.4.x (deferred per plan)
- CI wiring, report percentiles, fault injection, budget ceilings (Weeks 3–4)

## Frozen-core discipline

`eval/` only IMPORTS from `lib/`. Nothing in `lib/`, `app/`, or `test/` was
touched to add this. The 221-test suite stays green (unrelated: `eval/` is
excluded from `npm test` by convention — cost + non-determinism).
