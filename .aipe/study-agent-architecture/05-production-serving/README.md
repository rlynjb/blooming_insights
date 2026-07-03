# Section E — Production serving for agents

**Anchor:** single-agent + multi-agent (both). What single-call serving concerns become once the unit is an autonomous loop or a topology.

`study-ai-engineering`'s production-serving section covers single-call caching, cost, rate-limit, retry. This sub-section covers the concerns that only show up once you have a loop or a topology issuing many calls, often against the same tool, often concurrently.

## Files

1. **`01-rate-limit-compliance.md`** — the 1-req/s spacing gate + retry ladder in `BloomreachDataSource`. The de-facto backpressure on every fan-out.
2. **`02-fan-out-backpressure.md`** — semaphore-based load harness in `eval/load.eval.ts`. Concurrency cap = worker count.
3. **`03-fault-injection-and-graceful-degradation.md`** — `FaultInjectingDataSource` decorator + the receipt (9 faults / 3 investigations / 0 failed).
4. **`04-cost-controls.md`** — the four cost levers together: BudgetTracker, prompt caching, Anthropic pricing helper, per-tool budgets.

## Reading order

01 → 02 → 03 → 04. Rate-limit compliance sets the ceiling every fan-out runs against; the load harness exercises the fan-out against that ceiling; fault injection proves the shape holds under chaos; cost controls close by naming the compound levers.
