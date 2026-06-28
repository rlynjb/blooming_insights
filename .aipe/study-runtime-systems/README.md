# Study — runtime systems

How code actually executes inside blooming insights: which processes exist, which event loop the work rides, where shared state lives, and what cancellation actually reaches.

## Reading order

  1. `00-overview.md` — the three-band runtime map and the ranked findings.
  2. `01-runtime-map.md` — every process, task, and resource grounded in the codebase.
  3. `02-processes-threads-and-tasks.md` — Node's single-threaded model; honest framing of "no child processes."
  4. `03-event-loop-and-async-io.md` — the microtask story behind `AsyncLocalStorage` + the spacing gate.
  5. `04-shared-state-races-and-synchronization.md` — `Map<sessionId, SessionFeed>` and per-request ALS context.
  6. `05-memory-stack-heap-gc-and-lifetimes.md` — warm-instance retention, the 60s response cache.
  7. `06-filesystem-streams-and-resource-lifecycle.md` — `ReadableStream` controllers, dev cache files, the NDJSON reader lock.
  8. `07-backpressure-bounded-work-and-cancellation.md` — `AbortSignal` plumbed through `DataSource.callTool`; the 30s per-call ceiling.
  9. `08-runtime-systems-red-flags-audit.md` — ranked execution-model risks.

## What this guide is for

The execution-model x-ray. A code review tomorrow that asks "what runs where, and what happens when two of them run at the same time" should be defensible from the diagrams in `00-overview.md` and `01-runtime-map.md`.

## What this guide is NOT for

  → **Where components live.** That's `study-system-design`. Topology vs execution.
  → **Test isolation, fakes, deterministic seeds.** That's `study-testing`.
  → **Auth boundary, OAuth flow content.** That's `study-security` / `study-system-design`. This guide only touches OAuth state insofar as it forces the `AsyncLocalStorage` shape.

## Cross-links

  → `study-system-design/01-request-flow.md` for the request topology this guide is the execution-time view of.
  → `study-data-modeling/` for the data shapes flowing through these runtimes.
