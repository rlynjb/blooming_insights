# Testing & correctness — blooming_insights

The question the whole guide answers:

> **How do you know the code works, and how will you know it still works after the next change?**

A test suite is either your unknown-unknowns alarm or it's decoration. This
audit says which one you have.

---

## The map

```
  Deterministic surface (npm test)          Probabilistic surface (npm run eval*)
  ─────────────────────────────────         ──────────────────────────────────────
  vitest.config.ts                          vitest.eval.config.ts
    include: test/**/*.test.ts                include: eval/**/*.eval.ts
    221 passing                               10 goldens · rubric-judged
    injected fakes, no network                real Anthropic key, ~$0.09/case

  test/                                     eval/
    agents/    (9 files, agent loops)         goldens/    (10 case files)
    api/       (3 files, route integration)   rubrics/    (2 rubric defs)
    mcp/       (7 files, transport + auth)    receipts/   (per-case JSON, gitignored)
    data-source/ (1 file)                     calibration/ (blind labeling worksheets)
    insights/  (1 file)                       baseline.json + gate.eval.ts
    state/     (2 files)                      load.eval.ts (semaphore pool, N + K)
    streaming/ (1 file)                       fault-injecting.ts (decorator)
    fixtures/  (8 captured JSON payloads)     run.eval.ts (harness)

           │                                            │
           └──────────────── seam ──────────────────────┘
                     the DataSource port
                (BloomreachDataSource · SyntheticDataSource · FaultInjectingDataSource)
```

Two runners, two configs, one seam. `npm test` runs deterministic assertions
against injected fakes. `npm run eval` runs the same agents against the same
seam but with real Anthropic and a rubric judge. They MEET at the DataSource
port — the same abstraction the production route depends on.

---

## The determinism seam — where a finding belongs

The seam that decides where a finding goes:

- **Assertion says "equals X"** → deterministic testing, this guide.
- **Assertion says "score ≥ 4 on this rubric" or "verdict is not fail"** →
  probabilistic evaluation, cross-link to `study-ai-engineering`.

The two meet at the agents. `test/agents/*.test.ts` scripts Anthropic's SDK
with a fake and asserts equality on JSON output, tool-call args, control-flow
edges. `eval/run.eval.ts` calls the real Anthropic and asserts a rubric
judgment. Same code under test — different assertion shape.

State which half a finding is when you write it. A regression in the
byte-identity of `buildSynthesisInstruction` is a testing bug (deterministic:
the string is either equal or it isn't). A regression in
`actionable_next_step` from 30% pass to 5% pass is an eval bug (probabilistic:
the rubric judge is the arbiter).

---

## Reading order

1. **`00-overview.md`** — verdict-first summary. Coverage map, the three
   highest-leverage gaps, one-line verdict per lens.
2. **`audit.md`** — the 7-lens audit. What's tested, what isn't, red flags
   firing. Cross-links out to the Pass 2 pattern files for deep walks.
3. **`01-…` through `0N-…`** — Pass 2 pattern files, one per testing
   technique this repo applies deliberately. Read only the ones you want to
   understand deeply; the audit is the source of truth for scope.

The pattern files are:

- `01-scripted-anthropic-fake.md` — module-level `vi.mock('@anthropic-ai/sdk', …)`
  with a shared response queue draining into `MockAnthropic.messages.create`.
  The single technique that makes agent-loop unit tests possible without a
  network. Deterministic side of the seam.
- `02-injected-datasource-fake.md` — port/adapter testability. `DataSource`
  is the port; `BloomreachDataSource`, `SyntheticDataSource`, and
  `FaultInjectingDataSource` are the adapters. Tests inject whichever adapter
  they need — production uses one, unit tests another, evals a third, load
  tests wrap a fourth around it. Deterministic side of the seam.
- `03-captured-fixture-schema-tests.md` — `test/fixtures/*.json` are real MCP
  responses captured once and pinned. `parseWorkspaceSchema` is tested against
  these instead of hand-built objects. Deterministic; guards schema drift at
  the MCP boundary.
- `04-signal-class-gated-eval.md` — the goldens carry a `signalClass` tag
  (`has-signal | partial-signal | no-signal | positive`) that decides whether
  a fail is gated (test failure) or measured (data point). Probabilistic
  side; the wrapper is deterministic.
- `05-rubric-baseline-and-regression-gate.md` — `eval/baseline.json` is a
  committed per-dimension pass-rate table; `eval/gate.eval.ts` blocks if any
  dimension regresses by more than `GATE_MAX_REGRESSION` (default 10pp).
  Probabilistic core; the diff comparison is deterministic.
- `06-fault-injection-decorator.md` — `FaultInjectingDataSource` wraps any
  concrete DataSource and forces failures at configurable rates with a
  deterministic PRNG seed. Same seam as `02-` but decorated. Deterministic;
  used in load tests to exercise graceful-degradation paths that never fire
  against the happy path.

If a file above doesn't exist yet, it means the pattern was folded into the
audit instead. Check `audit.md`.

---

## What this guide is not

- **Not a coverage report.** The audit ranks by risk, not percentage. Two
  uncovered lines in the auth cookie crypto path outweigh 200 covered lines
  in a tsx component that only renders a `<div>`.
- **Not a "how to run vitest" reference.** See `package.json` scripts and
  `vitest.config.ts` for that.
- **Not an eval-engine walkthrough.** Rubric internals, `@aptkit/core`, and
  the LLM-as-judge architecture live in `study-ai-engineering`. This guide
  covers the deterministic harness *around* the judge: how the goldens are
  loaded, how the baseline is written, how the regression gate compares.
