# Study — Performance Engineering

What is measurably slow or expensive in this repo, why, and which change improves it
without moving the bottleneck. Grounded in the actual files, the actual ceilings, the
actual budgets the code already defends.

## Reading order

1. `00-overview.md` — the repo's performance map: where the budget is, where the
   ceiling is, the top three risks, what's `not yet exercised`.
2. `audit.md` — the 8-lens walk. Pass 1. Read this once, then dip back per lens.
3. `01-spacing-gate-vs-backpressure.md` — the load-bearing distinction. The
   `minIntervalMs = 1100` in `connect.ts:97` is **rate-limit compliance** to a
   provider quota, not **backpressure** against a slow consumer. Knowing which one
   it is, is the difference between tuning it correctly and tuning it wrong.
4. `02-rate-limit-retry-ladder.md` — parsing the provider's stated penalty window
   off the 429 envelope, capping any single retry wait at 20s, bounding worst-case
   retry cost so the 300s route budget survives.
5. `03-per-call-timeout-ceiling.md` — `TOOL_TIMEOUT_MS = 30_000`. The thing that
   stops one hung MCP call from eating the entire 300s budget.
6. `04-response-cache-with-no-cache-on-error.md` — the 60s response cache. Throughput
   absorber that intentionally refuses to remember failures.
7. `05-streaming-perceived-latency.md` — NDJSON streaming as a **perceived-latency**
   tool. Total wall-clock barely moves; the felt-time collapses from "120s of nothing"
   to "the agent is talking the whole time."

## Cross-links to neighboring guides

- `../study-runtime-systems/` — explains the execution mechanisms (event loop,
  `AbortSignal`, `ReadableStream`, `setTimeout`) this guide measures.
- `../study-system-design/` — explains the architecture-scale tradeoffs (provider
  rate limits, route budgets, demo-vs-live) this guide quantifies.
- `../study-distributed-systems/` — owns the partial-failure semantics of the
  rate-limit retry + per-call timeout when the provider is degraded.
- `../study-debugging-observability/` — owns the `phases[]` summary log and `res.usage`
  shape; this guide uses those signals but doesn't teach them.

## How to use this

If you're tuning a number — `minIntervalMs`, `cacheTtlMs`, `TOOL_TIMEOUT_MS`,
`maxDuration` — read `00-overview.md` and the relevant pattern file before
changing it. Each of those numbers defends a ceiling. Moving one without
understanding which ceiling it defends moves the bottleneck somewhere else.
