# study-debugging-observability

The debugging & observability guide for **blooming insights**. This
generator asks the load-bearing question:

> when behavior is wrong, what evidence exists to explain it quickly
> and prevent recurrence?

It reads the codebase through 8 lenses (`audit.md`) and then walks the
five patterns the repo actually exercises deeply enough to teach.

## Reading order

```
  1. 00-overview.md    map + ranked findings + "not yet exercised"
  2. audit.md          the 8-lens audit — one section per lens
  3. 01–05             the discovered patterns, one file each
```

## The discovered patterns

Each file is a full concept walk (zoom-out → structure pass → how it
works → primary diagram → elaborate → interview defense).

- `01-ndjson-live-trace.md` — the wire-format event bus (`AgentEvent`
  discriminated union + `readNdjson` kernel) that carries agent
  reasoning to the UI as a first-class surface.
- `02-per-phase-request-summary.md` — the one-line summary log both
  streaming routes emit in `finally`, split into named phases
  (schema_bootstrap · coverage_gate · list_tools · monitoring_scan /
  diagnostic_investigate / recommendation_propose).
- `03-capability-trace-receipts.md` — the `onCapabilityEvent` fork
  from aptkit's trace sink into per-case JSON receipts on disk, with
  `summarizeUsage` + `estimateAnthropicCost` producing per-invocation
  token + cost ledger rows.
- `04-baseline-and-regression-gate.md` — `eval/baseline.json` as the
  committed reference; `gate.eval.ts` compares a candidate run's
  per-dimension pass rates against it and blocks on regression.
- `05-fault-injecting-load-harness.md` — the `FaultInjectingDataSource`
  decorator + load runner that surface how the agents behave under
  timeout / 429 / 500 / malformed JSON at controllable rates.

## Partition (what lives elsewhere)

```
  study-testing                the golden-case rubric substrate, judge
                               agreement, coverage of the agent loop
  study-performance-engineering the p50/p95/p99 numbers themselves,
                               budgets, and how to attack them
  THIS guide                   how those signals get produced and how
                               you'd use them to explain a live bug
```

Cross-links appear inline where a pattern reaches into a neighbor. If
you notice a lens finding that looks more like "did the test catch
it?" (testing) or "how fast is p95?" (performance), it belongs there.
