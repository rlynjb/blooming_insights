# study-performance-engineering — blooming insights

Applied audit of what's measurably slow or expensive in this repo, why, and which change would improve it without moving the bottleneck.

## Reading order

1. `00-overview.md` — the map. Ranked findings, the one weight-bearing distinction (spacing-compliance vs backpressure), and where each pattern file lives.
2. `audit.md` — Pass 1. The 8-lens walk with `file:line` grounding. Every lens either names what's there or emits `not yet exercised`.
3. Pattern files — Pass 2. One per significant mechanism this repo exercises:
   - `01-prompt-caching.md` — ephemeral cache breakpoint on the system prompt; ~80% reduction on prefix input cost across a ReAct loop.
   - `02-per-investigation-budget-ceiling.md` — check-before-dispatch token/cost ceiling per investigation.
   - `03-observability-report.md` — receipts on disk + a report that emits p50/p95/p99 latency + tokens/cost.
   - `04-load-harness-with-fault-injection.md` — semaphore-based concurrency harness; a decorator that injects timeouts/429s/500s/malformed JSON.
   - `05-rate-limit-spacing-and-retry-ladder.md` — `minIntervalMs = 1100` proactive spacing + parsed-window retry ladder on 429s. This is rate-limit compliance, not backpressure.
   - `06-response-cache-and-demo-replay.md` — the 60s response cache and the demo-snapshot NDJSON replay path.

## Neighbors — cross-links

- `study-runtime-systems` — the execution model: `AbortSignal.timeout` composition, the ReAct loop's per-turn shape, cancellation propagation.
- `study-system-design` — the architecture-scale tradeoffs: the `DataSource` seam, DIY vs Vercel Pro's 300s cap, the demo vs live split.

Findings that belong to those neighbors are cross-linked from `audit.md`, not restated here.

## What this repo does NOT exercise (yet)

- Multi-region deployment / horizontal scale
- Persistent queues (Kafka, Redis Streams) — no work queue exists; investigations run inside the request
- Client-side rendering budget or bundle-size optimization — the UI is dark-mode-only Tailwind v4 with no perceptible startup-cost work
- Database indexes / query plans — there is no database
- CPU profiling of hot loops — the hot path is model + MCP calls, not local compute

These lenses emit `not yet exercised` in `audit.md` with an honest note about when they'd become relevant.
