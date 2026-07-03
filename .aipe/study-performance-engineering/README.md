# study-performance-engineering

Applied performance-engineering audit of this repo — measurement and
optimization of what the code actually does. Grounded in real files,
real receipts, real budgets. No invented scale, no aspirational numbers.

Two passes, standard for audit-style generators:

```
  Pass 1 — the 8-lens audit         audit.md
  Pass 2 — the discovered patterns  01-…  02-…  03-…  …
```

## Read order

  1. `00-overview.md` — the repo-grounded map, ranked findings,
     what's measured vs `not yet exercised`.
  2. `audit.md` — the 8-lens walk. Each lens either names what the
     repo does with `file:line` grounding or emits `not yet exercised`.
  3. Pattern files (`01-` through `07-`) — one per load-bearing perf
     mechanism the repo actually exercises. Read in numeric order or
     jump straight to the one you're debugging.

## Pattern files

- `01-route-budget-and-timeout-composition.md` — how the 300s route
  budget, 30s per-tool timeout, and `AbortSignal` composition together
  bound a single investigation.
- `02-spacing-gate-and-retry-ladder.md` — the ~1.1s proactive spacing
  gate vs the parsed retry-after ladder. The load-bearing distinction:
  spacing is a scheduler; the retry ladder is backpressure.
- `03-prompt-caching-ephemeral-breakpoint.md` — `cache_control:
  ephemeral` on the system prompt; validated live with
  `cache_read_input_tokens` hits in the receipts.
- `04-response-cache-ttl.md` — the 60s per-`(name, args)` map cache
  inside the Bloomreach adapter; write-through on `skipCache`.
- `05-budget-ceiling-check-before-dispatch.md` — the `BudgetTracker`
  gate that throws BEFORE the next Anthropic call, not after.
- `06-load-harness-semaphore-concurrency.md` — the fixed-K worker
  pool that drives the load eval. Fault-injection is layered as a
  decorator on the DataSource — the agent doesn't know.
- `07-fault-injecting-decorator.md` — offline degradation exercise
  via a DataSource decorator. Shows the agent surviving 9 faults
  across 3 investigations with 0 failures.

## Cross-links to neighbor generators

  → **`study-runtime-systems`** owns the execution mechanism:
     event loop, async/await, `AbortSignal` composition semantics,
     how `setTimeout` interacts with backpressure. This guide MEASURES;
     runtime-systems EXPLAINS.
  → **`study-system-design`** owns the architectural tradeoffs:
     why the ~1.1s spacing gate exists (Bloomreach per-user global
     rate limit), why the 60s response cache is per-instance
     (Vercel memory model), why the load harness runs offline.
     This guide grounds those choices in numbers; system-design
     defends them at the whiteboard.

If a finding belongs to a neighbor, this guide cross-links rather than
re-teaches. That partition is what keeps each generator sharp.
