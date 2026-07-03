# Backpressure, bounded work, and cancellation

*Bounded concurrency, cancellation, deadlines · Language-agnostic*

## Zoom out — where this concept lives

This is the load-bearing concept of the whole `study-runtime-systems` guide. Every mechanism the codebase reaches for — timeouts, retry ceilings, budget caps, worker-pool concurrency, `AbortSignal` composition — exists to answer one question: **how do you make sure work stops when it should?**

```
Zoom out — every ceiling in the codebase, at every layer

┌─ Route layer (Vercel budget) ─────────────────────────────────────┐
│  ★ maxDuration = 300         app/api/{briefing,agent}/route.ts     │
│                              (Vercel Pro's max; Hobby was 60s)      │
└───────────────────────────────┬───────────────────────────────────┘
                                │
┌─ Request layer (client cancel) ▼──────────────────────────────────┐
│  req.signal.throwIfAborted()  between phases                       │
│  req.signal passed down through every await                        │
└───────────────────────────────┬───────────────────────────────────┘
                                │
┌─ Investigation layer (budget) ▼───────────────────────────────────┐
│  ★ BudgetTracker { maxCostUsd: 2.0 }   lib/agents/budget.ts         │
│    checked PRE-DISPATCH at every model turn                        │
│    → throws BudgetExceededError before the next Anthropic call     │
└───────────────────────────────┬───────────────────────────────────┘
                                │
┌─ Call layer (per-MCP-call ceilings) ▼─────────────────────────────┐
│  ★ TOOL_TIMEOUT_MS = 30_000  mcp/transport.ts:38                    │
│    → composed with req.signal via AbortSignal.any                  │
│  ★ maxRetries = 3            bloomreach-data-source.ts:135         │
│  ★ retryCeilingMs = 20_000   bloomreach-data-source.ts:136         │
└───────────────────────────────┬───────────────────────────────────┘
                                │
┌─ Load harness (test-only concurrency ceiling) ▼───────────────────┐
│  ★ LOAD_CONCURRENCY = K workers  eval/load.eval.ts:90              │
│  ★ per-test wall-clock cap        eval/load.eval.ts:228            │
└───────────────────────────────────────────────────────────────────┘
```

Every layer imposes a ceiling; every ceiling composes so the tightest one wins. This is the core discipline.

## Structure pass — one axis, four altitudes

Trace *"what stops this work?"* down from the top of the request to the innermost call.

```
"What stops this work?" — one question, four answers

┌─ route ─────────────────────────────────────┐
│  maxDuration hits → Vercel kills the func    │
│    → runtime STOPS the work                  │
└────────────────────┬────────────────────────┘
                     ▼
┌─ investigation ─────────────────────────────┐
│  BudgetTracker.exceeded() → throw            │
│    → USER CODE stops the work (pre-dispatch) │
└────────────────────┬────────────────────────┘
                     ▼
┌─ call ─────────────────────────────────────┐
│  AbortSignal.timeout(30_000) fires           │
│  OR req.signal.abort() fires                 │
│    → SDK translates to AbortError            │
│    → USER CODE catches, throws HTTP 0        │
└────────────────────┬────────────────────────┘
                     ▼
┌─ retry ────────────────────────────────────┐
│  retries === maxRetries                      │
│    → USER CODE exits the while loop          │
└────────────────────────────────────────────┘
```

The seam that matters: **user-code ceilings ↔ platform ceilings.** Vercel's `maxDuration = 300` is the outer platform bound; everything inside (budget, timeout, retry cap) is user-code bounded so the work reliably ends before Vercel kills it. Without user-code ceilings, the platform kill would be the *only* stopping condition — and the receipt would just say "function timed out" with no useful cause.

## How it works

### Move 1 — the mental model

You know how a `fetch()` request can hang forever if you don't set a timeout? Every async operation in this codebase could theoretically do the same. The fix is to compose ceilings: at each layer, add a bound that's tighter than the layer above, so failure at any level surfaces quickly.

```
The composed-ceiling pattern

  outer bound:  maxDuration = 300s
    ├─ next:    per-investigation budget ($2.00)
    │    ├─ next: per-call timeout (30s)
    │    │    ├─ next: per-retry cap (20s)
    │    │    └─ retry loop max (3 retries)
    │    └─ ...
    └─ ...

  the tightest applicable ceiling always wins
```

Every layer's ceiling is *inside* the layer above — a per-call 30s timeout means the worst case is 3 retries × 30s = 90s per bad call, but the retry ceiling caps each wait at 20s, so worst is ~90s of real time (30s call + 20s wait × 3). Fits inside the 300s route budget with room for many calls.

### Move 2 — the mechanisms

#### AbortSignal composition — the load-bearing kernel

```
composeSignals — OR-of-signals, first to fire wins

// lib/mcp/transport.ts:173-189
export function composeSignals(...signals: (AbortSignal | undefined)[]): AbortSignal {
  const filtered = signals.filter((s): s is AbortSignal => !!s);
  if (filtered.length === 0) return new AbortController().signal;
  if (filtered.length === 1) return filtered[0];
  if (typeof (AbortSignal as unknown as { any?: unknown }).any === 'function') {
    return (AbortSignal as unknown as { any: (s: AbortSignal[]) => AbortSignal }).any(filtered);
    // ★ Node 20+ / modern browsers: use the platform's AbortSignal.any
  }
  const ac = new AbortController();
  for (const s of filtered) {
    if (s.aborted) {
      ac.abort((s as unknown as { reason?: unknown }).reason);
      return ac.signal;
    }
    s.addEventListener('abort', () => ac.abort((s as unknown as { reason?: unknown }).reason), { once: true });
  }
  return ac.signal;
  // ★ FALLBACK: manual AbortController glue for older runtimes
}
```

Use site — the transport composes the client-cancel signal with a per-call timeout:

```ts
// lib/mcp/transport.ts:129-138
async callTool(name, args, opts?: CallToolOpts): Promise<unknown> {
  if (this.httpErrors) this.httpErrors.last = null;
  const signal = composeSignals(opts?.signal, AbortSignal.timeout(TOOL_TIMEOUT_MS));
  //   ★ two sources:                    ★ user's cancel  ★ 30s wall clock
  //   whichever fires first wins
  try {
    return await this.client.callTool({ name, arguments: args }, undefined, { signal });
  } catch (err) {
    if (isTimeoutError(err)) {
      throw new Error(`HTTP 0: timeout after ${TOOL_TIMEOUT_MS}ms`, { cause: err });
    }
    // …
  }
}
```

The load-bearing skeleton — what breaks if you remove each piece:

  → Drop **`opts?.signal`** and client cancels don't propagate; a hung Bloomreach call runs to the 30s timeout even after the user closed their tab.
  → Drop **`AbortSignal.timeout(TOOL_TIMEOUT_MS)`** and one stuck call burns the entire 300s route budget.
  → Drop **`composeSignals`** and you can only have ONE signal per call — pick timeout OR cancel, not both.
  → Drop **the `isTimeoutError` check + rethrow** and callers see a raw AbortError instead of a semantic `HTTP 0: timeout after 30000ms`; the retry ladder can't distinguish "network fault" from "user cancelled."

The `AbortSignal.any` primitive is the modern platform solution; the manual fallback exists for belt-and-braces against older runtimes (`isRuntime` check at line 177).

#### The BudgetTracker gate — pre-dispatch, always

```
BudgetTracker.exceeded() — the runaway-loop stop

// lib/agents/aptkit-adapters.ts:60-66
async complete(request: ModelRequest): Promise<ModelResponse> {
  // Phase-3 budget-ceiling gate: check BEFORE dispatching the API call
  // so a runaway loop can't burn additional cost after the ceiling has
  // already been hit.
  if (this.budget?.exceeded()) {
    throw new BudgetExceededError(this.budget.snapshot(), this.budget.limit);
  }
  // …dispatch to Anthropic…
}
```

`exceeded()` checks two ceilings (`lib/agents/budget.ts:71-76`):

```ts
exceeded(): boolean {
  const s = this.snapshot();
  if (this.limit.maxTokens != null && s.totalTokens > this.limit.maxTokens) return true;
  if (this.limit.maxCostUsd != null && s.estimatedCostUsd > this.limit.maxCostUsd) return true;
  return false;
}
```

The **pre-dispatch** placement is the interview-defense-tier detail. A post-dispatch check catches the overrun after paying for the turn; a pre-dispatch check stops the loop *before* paying. For a runaway loop, that's the difference between $2 spent and $2.20 spent.

The tracker's other half — `add()` at `lib/agents/budget.ts:51-55` — runs after each response, accumulating tokens for the next `exceeded()` call.

The threading pattern:

```
Same tracker instance, threaded through both agents in one investigation

// eval/load.eval.ts:265, :275-276, :291-292
const budget = new BudgetTracker({ maxCostUsd: BUDGET_PER_INVESTIGATION_USD });

const diagnosis = await diagnostic.investigate(golden.anomaly, {
  onCapabilityEvent: (ev) => diagnosisTrace.push(ev),
  budget,          // ★ SAME instance
});

const recommendations = await recommendationAgent.propose(golden.anomaly, diagnosis, {
  onCapabilityEvent: (ev) => recommendationTrace.push(ev),
  budget,          // ★ SAME instance — accumulated total carries over
});
```

The tracker crosses the diagnostic → recommendation boundary because a runaway on the diagnostic side should still stop the recommendation from firing. Shared state, right scope: investigation-scoped (see `04-shared-state-races-and-synchronization.md`).

#### The rate-limit retry ladder — bounded, budget-aware

```
The retry loop with all ceilings visible

// lib/data-source/bloomreach-data-source.ts:163-174
let retries = 0;
while (isRateLimited(result) && retries < this.maxRetries) {   // ★ MAX 3
  retries++;
  const hintMs = parseRetryAfterMs(result);                     // server-stated hint
  const backoffMs = this.retryDelayMs * 2 ** (retries - 1);     // else exp backoff
  const waitMs = Math.min(
    hintMs != null ? hintMs + RETRY_BUFFER_MS : backoffMs,
    this.retryCeilingMs,                                        // ★ CAP each wait
  );
  await sleep(waitMs);
  result = await this.liveCall(name, args, options.signal);     // signal still threaded
}
```

The math from the code comment at `lib/data-source/bloomreach-data-source.ts:161-162`:

> Latency note: against the 60s route budget (app/api/agent), maxRetries=3 at ~10s each can cost ~30s on a single call, so the cap stays low by default — raising it risks blowing the per-investigation budget.

Numbers:
  → 1 call = up to 30s (per-call timeout)
  → 3 retries × 20s max wait = 60s of waiting
  → Worst case for one rate-limited tool call: 30s + 20s + 30s + 20s + 30s + 20s + 30s ≈ 3 minutes

Note that even the worst case fits inside `maxDuration = 300`. If the retry cap were larger (say 60s per retry), a single rate-limited call could burn the whole route budget on its own. The current cap is deliberately budget-aware.

#### The load harness concurrency ceiling — K workers, shared queue

Already walked in `02-processes-threads-and-tasks.md`. The relevant bounding property: `LOAD_CONCURRENCY = K` (default 3) is what caps parallelism against a live provider. K=3 against Bloomreach's ~1 req/s per-user limit gives 3× the per-user rate temporarily, then retries absorb the resulting 429s.

The wall-clock cap on the test itself:

```ts
// eval/load.eval.ts:228
Math.max(600_000, ((LOAD_N * 300_000) / LOAD_CONCURRENCY) * 1.5),
```

This is the vitest per-test timeout. It's set to 1.5× the expected wall-clock so the test fails cleanly if concurrency didn't help.

#### Cancellation threading — from `req.signal` all the way down

The chain, top to bottom:

```
Cancellation propagation — one signal, threaded through 6 layers

  req.signal   (Vercel runtime signals when client disconnects)
       │
       ├─► route handler                    app/api/agent/route.ts
       │    ├─ throwIfAborted() between phases
       │    │
       │    ├─► bootstrap(req.signal)       (schema fetch)
       │    ├─► dataSource.listTools({signal})
       │    │
       │    ├─► diagAgent.investigate(anomaly, {..., signal})   diagnostic.ts:34
       │    │      │
       │    │      └─► AptKitDiagnosticInvestigationAgent
       │    │              │
       │    │              ├─► ModelProvider.complete({..., signal})
       │    │              │      │
       │    │              │      └─► anthropic.messages.create(params, {signal})
       │    │              │              (Anthropic SDK honors AbortSignal natively)
       │    │              │
       │    │              └─► toolRegistry.callTool({..., signal})
       │    │                     │
       │    │                     └─► dataSource.callTool({signal})
       │    │                            │
       │    │                            └─► SdkTransport.callTool({signal})
       │    │                                    │
       │    │                                    └─► composeSignals(signal, timeout(30s))
       │    │                                            │
       │    │                                            └─► client.callTool({signal})
       │    │                                                    (MCP SDK honors AbortSignal)
```

The property: cancellation reaches every layer. Nothing on the request path holds a reference that stays alive past the abort. This is why closing a tab mid-investigation actually stops the Anthropic call within the tick — the AbortSignal fires, the SDK aborts the fetch, the promise rejects, the chain unwinds.

### Move 3 — the principle

**Every layer of async work needs its own ceiling, and the ceilings must compose so the tightest wins.** The disease this prevents: "work that hangs somewhere in the middle of the stack and burns the outer budget without a useful error." The cure: each layer imposes a ceiling tighter than the layer above (retry cap tighter than per-call timeout tighter than budget tighter than route `maxDuration`), and every ceiling is *user code that stops work*, not just "the platform kills the function eventually."

The corollary for interviews: when a system claims to be "resilient," ask *"what stops the work?"* at each level. If the answer is only "we hope it finishes," you don't have bounded work — you have hope.

## Primary diagram — every ceiling composed

```
Bounded work — the composed ceiling stack

┌─ ROUTE (Vercel) ──────────────────────────────────────────────────┐
│  maxDuration = 300s                                                │
│  → platform kills the function if user code hasn't returned         │
└─────────────────────────┬──────────────────────────────────────────┘
                          │
┌─ REQUEST (client cancel) ▼───────────────────────────────────────┐
│  req.signal fires on tab close / navigation                        │
│  → user code throws AbortError, hits catch block, returns          │
└─────────────────────────┬──────────────────────────────────────────┘
                          │
┌─ INVESTIGATION (budget) ▼─────────────────────────────────────────┐
│  BudgetTracker { maxCostUsd: 2.0 }                                 │
│  → checked PRE-DISPATCH: throws BudgetExceededError                │
│  → route catch → emits {type: 'error'} on NDJSON                   │
└─────────────────────────┬──────────────────────────────────────────┘
                          │
┌─ CALL (per-MCP-call) ▼───────────────────────────────────────────┐
│  AbortSignal.timeout(30_000)                                       │
│  composeSignals(req.signal, timeout)                               │
│  → whichever fires first → throws HTTP 0 timeout                   │
└─────────────────────────┬──────────────────────────────────────────┘
                          │
┌─ RETRY (rate-limit ladder) ▼──────────────────────────────────────┐
│  maxRetries = 3                                                    │
│  retryCeilingMs = 20_000 (each wait)                               │
│  parsed hint or exponential backoff, capped                        │
│  worst-case ≈ 3 minutes per call, fits inside 300s route budget    │
└─────────────────────────┬──────────────────────────────────────────┘
                          │
┌─ SPACING (rate-limit hint) ▼──────────────────────────────────────┐
│  minIntervalMs = 1100                                              │
│  lastCallAt monotonic clock — best-effort, not a lock              │
└───────────────────────────────────────────────────────────────────┘

Every layer has a ceiling. Every ceiling is user code.
The tightest applicable ceiling always wins.
```

## Elaborate — why "backpressure" barely shows up here

Web Streams *have* backpressure semantics — `controller.enqueue()` respects the internal queue's high-water mark, and `reader.read()` implicitly pulls at the consumer's pace. But blooming insights writes at ~1 event per second (the pace agents run at), and consumers (browsers) read at network speed. The producer is always slower than the consumer; backpressure never triggers.

The one place backpressure conceptually matters is the demo replay: it enqueues events synchronously with a `sleep(140ms)` between them, so a consumer that reads slower than 140ms/event would fill the browser's stream buffer. In practice, browsers read chunked-encoding responses in ~1ms chunks, so this is moot.

Where the codebase *does* handle backpressure explicitly: the load harness's K-worker concurrency limit. When N > K, the shared queue acts as an implicit backpressure signal — workers can't take work faster than they finish it. That's the closest thing to "the consumer sets the pace" in this codebase.

## Interview defense

**Q: Walk me through the composed cancellation signal when a user closes their tab mid-Bloomreach call.**

Six steps:

  1. Browser closes the connection; Vercel's runtime signals `req.signal.abort()`.
  2. Deep inside the current `dataSource.callTool()` invocation, the composed signal from `composeSignals(opts?.signal, AbortSignal.timeout(30_000))` fires because `opts?.signal` (which is `req.signal`) just aborted.
  3. The MCP SDK's in-flight `fetch()` sees the abort, rejects with `AbortError`.
  4. `SdkTransport.callTool` catches, checks `isTimeoutError(err)` — false because the reason is a client abort not a timeout — falls through, rethrows.
  5. The retry loop in `BloomreachDataSource.callTool` doesn't retry (retries only on rate-limit results, not on thrown errors).
  6. The route's `try/catch` catches `AbortError`, returns without emitting a client-facing error (nobody's listening), and the `finally` block closes the stream + logs phases.

Total elapsed time from client close to server unwind: microseconds. The load-bearing primitive is `composeSignals` — without it, one signal source would win and the other's contract would be silently violated.

Anchor: `lib/mcp/transport.ts:131, :167-189`; route catch at `app/api/briefing/route.ts:294-296`.

**Q: The BudgetTracker check is pre-dispatch. Why not post-dispatch?**

Because a runaway loop's whole hazard is *the next call being expensive*. Post-dispatch: you check after the response, discover you're over budget, throw. But you already paid for that call. Pre-dispatch: you check before dispatch, throw immediately, save the cost of that call.

For a bad case with 20 turns × $0.10 each hitting a $2 ceiling, pre-dispatch stops at turn 20 having spent $2. Post-dispatch stops at turn 21 having spent $2.10. Small delta per case, but the point is *deterministic*: pre-dispatch, once the ceiling is hit, no more cost accrues.

Anchor: `lib/agents/aptkit-adapters.ts:60-66`; the comment at `:60-64` says exactly this ("check BEFORE dispatching the API call").

**Q: What's the tightest applicable ceiling for a single rate-limited MCP call?**

`retryCeilingMs = 20_000` per wait. Even if Bloomreach's error text says "retry after 60 seconds," the ceiling caps our wait at 20s (line 168 in `bloomreach-data-source.ts`: `Math.min(hintMs + RETRY_BUFFER_MS, this.retryCeilingMs)`). Combined with `maxRetries = 3` and `TOOL_TIMEOUT_MS = 30_000`, the absolute worst case for one call is bounded and — critically — computable in advance. That predictability is the whole point of the ceilings composing this way.

## See also

  → `04-shared-state-races-and-synchronization.md` — the BudgetTracker's investigation-scoped shared state.
  → `06-filesystem-streams-and-resource-lifecycle.md` — how `finally` releases resources even on abort.
  → `study-networking` — the retry-ladder rate-limit dance in networking terms.
  → `study-testing` — the fault-injecting DataSource at `lib/data-source/fault-injecting.ts` proves this all works under induced faults.
