# Backpressure, bounded work, and cancellation

**Industry:** bounded concurrency, overload control, cancellation and deadlines · Language-agnostic

## Zoom out — where this concept lives

Everything runs on one thread per band, everything shares a single event loop, and everything talks to upstream systems we don't own. That's where bounded work matters. If one investigation runs forever, one Vercel instance is stuck; if one MCP call hangs, one investigation is stuck; if the agent keeps looping, cost spirals. Every ceiling in the repo — 300s route, 30s per call, USD per investigation — is here to prevent one of those runaway modes.

```
  Zoom out — where the ceilings live

  ┌─ Browser ────────────────────────────────────┐
  │  (no ceilings — the tab is the ceiling)      │
  └───────────────────┬──────────────────────────┘
                      │  fetch (long-poll NDJSON)
  ┌─ Vercel serverless ▼─────────────────────────┐
  │  ★ THIS CONCEPT ★                             │
  │                                               │
  │  maxDuration = 300s   ← route ceiling         │
  │  TOOL_TIMEOUT_MS = 30s  ← per-call ceiling    │
  │  BudgetTracker.exceeded()  ← cost ceiling     │
  │  AbortSignal composition  ← cancellation      │
  │  BloomreachDataSource spacing  ← rate ceiling │
  │                                               │
  └───────────────────┬──────────────────────────┘
                      │
  ┌─ Upstream ───────▼────────────────────────────┐
  │  their rate limits + our retry ladder         │
  └───────────────────────────────────────────────┘
```

The concept: **layered ceilings that compose**. Each layer has its own budget; whichever fires first wins. Cancellation propagates through the whole chain via AbortSignal.

## Structure pass — layers, axis, seams

Pick one axis — **who cancels this work when it takes too long?** — and trace it.

```
  One axis (who cancels?) down the layers

  ┌─ Vercel platform ──────────────────────────────┐
  │  maxDuration = 300s        → the PLATFORM      │
  │                               kills the invoke │
  └────────────────────────────────────────────────┘
      ↓
  ┌─ your route handler ───────────────────────────┐
  │  req.signal.throwIfAborted()   → YOU check,    │
  │                                  YOU throw     │
  └────────────────────────────────────────────────┘
      ↓
  ┌─ transport layer ──────────────────────────────┐
  │  AbortSignal.any(signal,       → COMPOSED      │
  │    AbortSignal.timeout(30s))     first-fires   │
  │                                  wins          │
  └────────────────────────────────────────────────┘
      ↓
  ┌─ model provider ───────────────────────────────┐
  │  budget.exceeded()             → BUDGET GUARD  │
  │  → BudgetExceededError          check-before-  │
  │                                  dispatch      │
  └────────────────────────────────────────────────┘

  the seam that matters: check-before vs interrupt-during
```

**The load-bearing seam:** cancellation is *observed at await boundaries*, not injected mid-synchronous-code. `throwIfAborted()` throws when checked; if you never check, the async chain keeps going even after `req.signal` fires. The transport layer's `AbortSignal.any` composition is what makes cancellation propagate *into* an in-flight `fetch()` — the socket close fires the signal, the fetch rejects with `AbortError`, control returns to your catch block.

## How it works

### Move 1 — the mental model

You know how `AbortController` in browsers lets you cancel a `fetch()` mid-flight? That's one AbortSignal saying "stop." The interesting move is **composing many signals**: the route's signal (client aborted?) OR a timeout signal (30s elapsed?) OR a budget signal (would exceed cost?) — each one is independent, and the first one to fire cancels the work.

```
  Pattern — layered ceilings with first-fires-wins

  route handler (300s ceiling)
    │
    │  req.signal (abort if client cancels)
    │
    ├── each async step:
    │     req.signal.throwIfAborted()      ← coarse cancel
    │
    ├── each MCP call:
    │     signal = AbortSignal.any(         ← fine cancel
    │       req.signal,                        (composed)
    │       AbortSignal.timeout(30_000)
    │     )
    │     await client.callTool(…, { signal })
    │
    └── each model turn:
          if (budget.exceeded()) throw ...  ← cost cancel
          const r = await anthropic.messages.create(…)
          budget.add(r.usage)

  none of these interrupt sync code;
  all of them fire at the next await
```

The composition is what makes cancellation *reliable* even when multiple ceilings are in play. Miss one composition (say, don't pass `signal` into `callTool`) and that call becomes a black hole: the client aborts, the route knows, but the in-flight MCP call keeps running until the 30s timeout — burning the deadline for nothing.

### Move 2 — the pieces

#### The 300s route ceiling

`app/api/agent/route.ts:23` sets `export const maxDuration = 300`. That's Vercel Pro's max. When 300s elapses, Vercel kills the invocation regardless of what your code is doing. There's no "graceful" — the process just stops responding.

**Why 300s and not 60:** a live investigation takes 100-115s under the ~1 req/s Bloomreach spacing. Add retries, add serialization between DiagnosticAgent → RecommendationAgent, and you can hit 250s. Hobby's 60s ceiling cannot fit this shape.

**What if the client disconnects mid-stream:** `req.signal` fires. The chain of `throwIfAborted()` checks in the route handler propagates it into the catch/finally.

#### Per-call MCP timeout — the sub-budget

`lib/mcp/transport.ts:38` sets `const TOOL_TIMEOUT_MS = 30_000`. Every single MCP call gets wrapped in a 30s timeout signal:

```
  // lib/mcp/transport.ts:129-146 — timeout composed with route signal
  async callTool(name, args, opts) {
    if (this.httpErrors) this.httpErrors.last = null;
    const signal = composeSignals(opts?.signal, AbortSignal.timeout(TOOL_TIMEOUT_MS));
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

**Why:** a hung MCP call would otherwise burn the entire 300s route budget on one stuck request. 30s is a compromise — long enough for legitimate slow calls (Bloomreach can take several seconds under load), short enough that a hang doesn't eat the whole route.

**The `HTTP 0:` tag** at line 137 gives callers a distinct marker to recognize timeout errors. `McpClient.callTool` in `bloomreach-data-source.ts` doesn't retry timeouts (retry would risk another 30s wait inside the same route budget), so timeouts fail fast — exactly what we want.

#### AbortSignal composition — how cancellation propagates

`lib/mcp/transport.ts:173-189` implements the composition:

```
  // lib/mcp/transport.ts:173-189 — first-fires-wins
  export function composeSignals(...signals: (AbortSignal | undefined)[]): AbortSignal {
    const filtered = signals.filter((s): s is AbortSignal => !!s);
    if (filtered.length === 0) return new AbortController().signal;
    if (filtered.length === 1) return filtered[0];
    if (typeof (AbortSignal as unknown as { any?: unknown }).any === 'function') {
      return (AbortSignal as unknown as { any: (s: AbortSignal[]) => AbortSignal }).any(filtered);
    }
    // fallback: manual glue for older runtimes
    const ac = new AbortController();
    for (const s of filtered) {
      if (s.aborted) { ac.abort((s as any).reason); return ac.signal; }
      s.addEventListener('abort', () => ac.abort((s as any).reason), { once: true });
    }
    return ac.signal;
  }
```

Node 20 and modern browsers have `AbortSignal.any`, which does exactly this natively. The manual fallback exists for belt-and-braces against older runtimes; in Vercel's Node 20 environment, the native path always wins.

**The composed signal fires when:**
- The client disconnects → `req.signal` aborts
- The 30s timer fires → `AbortSignal.timeout(30_000)` aborts

Either one propagates through the fetch to the underlying socket, which cancels the in-flight request. The `catch` in `callTool` sees `AbortError`, wraps it, throws.

```
  Layers-and-hops — cancellation propagation on client disconnect

  ┌─ browser (tab closed) ─────────────────────┐
  │  fetch aborts                              │
  └──────────────────┬─────────────────────────┘
                     │  TCP RST
  ┌─ Vercel route handler ─────────────────────┐
  │  req.signal fires                          │
  │                                            │
  │  throwIfAborted() at next check point     │
  │      │                                     │
  │      │  … meanwhile, in-flight MCP call:  │
  │      ▼                                     │
  │  transport.callTool(…, { signal: req.sig })│
  │      │                                     │
  │      ▼                                     │
  │  composed = any(req.sig, timeout(30s))    │
  │      │                                     │
  │      ▼                                     │
  │  client.callTool(…, { signal: composed })  │
  │      │                                     │
  │      ▼                                     │
  │  fetch(url, { signal: composed })          │
  │      │                                     │
  │      ▼                                     │
  │  ★ socket close on composed abort ★         │
  └────────────────────────────────────────────┘

  cancellation reaches the socket in one hop from the client
```

Without the composition, `req.signal` alone would fire when the client disconnects — but the MCP SDK wouldn't know unless we passed it through. The composition is what threads the signal all the way down.

#### BudgetTracker — check-before-dispatch

`lib/agents/budget.ts:41-77` is the per-investigation cost tracker. It's *not* a cancellation signal in the AbortSignal sense; it's a check the model adapter does before each turn:

```
  // conceptual — inside AnthropicModelProviderAdapter.complete()
  if (budget.exceeded()) {
    throw new BudgetExceededError(budget.snapshot(), budget.limit);
  }
  const response = await anthropic.messages.create(…);
  budget.add({
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  });
```

**Why check-before, not interrupt-during:** interrupting an in-flight Anthropic call requires the composed AbortSignal path (which we do have — the route's signal composes through `messages.create`). But cost accounting happens *after* the response comes back — you don't know if the call would exceed until you have the usage. The design chooses to eat one over-budget call rather than complicate the cancellation path.

**The tracker instance is shared** across DiagnosticAgent + RecommendationAgent via `AgentHooks.budget` (`eval/load.eval.ts:274-292` passes it to both). Safe because the two agents run sequentially — DiagnosticAgent finishes, then RecommendationAgent starts. No interleaving.

**The exceeded error** propagates through AptKit's agent loop → the wrapper agent → the route's try/catch, which emits a graceful NDJSON `error` event. The client sees "budget exceeded," not a hung stream.

#### The Bloomreach spacing gate — rate ceiling

`lib/data-source/bloomreach-data-source.ts:191-200` — the ~1 req/s spacing:

```
  const elapsed = Date.now() - this.lastCallAt;
  if (elapsed < this.minIntervalMs) {
    await new Promise((r) => setTimeout(r, this.minIntervalMs - elapsed));
  }
  const start = Date.now();
  try {
    const raw = await this.transport.callTool(name, args, { signal });
    this.lastCallAt = Date.now();
    return raw;
  } catch (err) {
    this.lastCallAt = Date.now();
    throw err;
  }
```

**What this bounds:** the local call rate to Bloomreach. Bloomreach's stated limit is ~1 req/10s ("1 per 10 second"), but they're more permissive in practice; `minIntervalMs = 200` (from the constructor default) gives a comfortable client-side floor. If we go over, Bloomreach's 429s trigger the retry ladder.

**Sits underneath the AbortSignal:** the `await new Promise((r) => setTimeout(…))` inside the wait doesn't listen to the signal. If the client cancels during the wait, we sleep out the wait, then check the signal on the next call. That's a minor latency leak (up to 200ms of extra work) which nobody cares about in practice.

#### The eval worker pool — bounded parallelism

`eval/load.eval.ts:171-211` — the only place in the repo with explicit bounded concurrency:

```
  // eval/load.eval.ts:171-211 — semaphore-based worker pool
  const indices = Array.from({ length: LOAD_N }, (_, i) => i);
  const queue = [...indices];

  async function worker(workerId: number): Promise<void> {
    while (queue.length > 0) {
      const index = queue.shift();
      if (index == null) return;
      // … run one investigation …
    }
  }

  const workers = Array.from({ length: LOAD_CONCURRENCY }, (_, i) => worker(i));
  await Promise.all(workers);
```

**Pattern:** N items to process, K workers pulling from a shared queue. Each worker is an async function that loops until the queue is empty. `Promise.all(workers)` waits for all K to drain.

**Why not `Promise.all(items.map(process))`:** that would fire ALL N in parallel, which at N=20 would hit Bloomreach's global rate limit and Anthropic's TPM ceiling simultaneously. K=3 keeps concurrency bounded.

**Why not a proper semaphore library:** the queue + K workers pattern IS the semaphore. No shared counter to worry about — the `queue.shift()` is the acquire, and JS's single-threaded model means two workers can't shift the same index (there's no `await` between the length check and the shift).

**Errors don't stop other workers:** the per-item try/catch inside the worker isolates failures. One investigation dies, the other K-1 keep processing.

```
  Pattern — semaphore-based worker pool

  ┌── shared queue ──┐
  │  [0, 1, 2, ..., N-1]  │
  └─────┬───────────────┬───────────┬────────┐
        │               │           │        │
        ▼               ▼           ▼        ▼
   worker 0        worker 1    worker 2  ...worker K-1
     │  shift()      │  shift()   │  shift()   │
     │  run inv      │  run inv   │  run inv   │
     │  push result  │            │            │
     └── loop ───────┴────────────┴────────────┘

  when queue is empty, workers return → Promise.all resolves
```

### Move 2 variant — the load-bearing skeleton

Every bounded-work story in the repo has three parts. Strip any one and the ceiling breaks.

1. **Isolate the kernel: ceiling + check point + propagation.**
   - Ceiling: the deadline (300s, 30s, budget USD, ~1 req/s)
   - Check point: where the code observes it (throwIfAborted, exceeded(), spacing gate)
   - Propagation: how the signal reaches into in-flight work (AbortSignal composition)

2. **Name each part by what breaks when it's missing.**
   - Without **ceiling**: work runs forever, cost explodes, upstream rate-limits.
   - Without **check point**: ceiling fires but nothing responds; async chain keeps going.
   - Without **propagation**: check point catches at the top, but in-flight sockets stay open until their own timeout (or forever).

3. **Separate skeleton from optional hardening.**
   - Skeleton: the three-part deadline/check/propagate structure.
   - Hardening: the fallback for older runtimes without `AbortSignal.any`, the `HTTP 0:` timeout tag for callers to recognize, the `dispose` in `finally` for connection release.

### Move 3 — the principle

Cancellation is a *signal* you have to *catch* — nothing magical happens if you set `maxDuration = 300` without threading `req.signal` through every await. The design pattern that works: **layered ceilings, composed signals, check-before-await**. Each layer has one job (route enforces 300s, transport enforces 30s per call, model enforces budget), and cancellation propagates up through composition. Skip a layer and the ceiling above it becomes the only ceiling — with worse observability.

## Primary diagram

```
  Bounded work and cancellation — the full picture

  ┌─ Vercel platform ────────────────────────────────────────────┐
  │  maxDuration = 300s          ← platform kills invoke         │
  └──────────────────────────┬───────────────────────────────────┘
                             │
  ┌─ route handler ─────────▼────────────────────────────────────┐
  │  req.signal.throwIfAborted()  ← coarse check between phases  │
  │                                                              │
  │  try {                                                       │
  │    schema = await bootstrap(req.signal)                      │
  │    req.signal.throwIfAborted()                               │
  │    tools = await ds.listTools({ signal: req.signal })        │
  │    req.signal.throwIfAborted()                               │
  │    diagnosis = await diagAgent.investigate(…, signal)        │
  │    req.signal.throwIfAborted()                               │
  │    recs = await recAgent.propose(…, signal)                  │
  │  } catch (e) { send({ type: 'error' }) }                    │
  │    finally { controller.close(); dispose() }                │
  └──────────────────────────┬───────────────────────────────────┘
                             │
  ┌─ transport (per MCP call) ▼──────────────────────────────────┐
  │  signal = AbortSignal.any(                                   │
  │    req.signal,                                               │
  │    AbortSignal.timeout(30_000)                               │
  │  )                                                           │
  │  await client.callTool(…, { signal })                        │
  │                                                              │
  │  first to fire wins:                                         │
  │    · client aborted   → AbortError                           │
  │    · 30s elapsed      → AbortError (HTTP 0: timeout)         │
  └──────────────────────────────────────────────────────────────┘

  ┌─ model provider (per turn) ──────────────────────────────────┐
  │  if (budget.exceeded()) throw BudgetExceededError            │
  │  const r = await anthropic.messages.create(…, { signal })    │
  │  budget.add(r.usage)                                         │
  │                                                              │
  │  check-before-dispatch: one over-budget call at most         │
  └──────────────────────────────────────────────────────────────┘

  ┌─ Bloomreach spacing gate (per call) ─────────────────────────┐
  │  await sleep(minIntervalMs - elapsed)  ← ~1 req/s floor      │
  │  await transport.callTool(…, { signal })                     │
  │  lastCallAt = Date.now()                                     │
  └──────────────────────────────────────────────────────────────┘

  ┌─ eval worker pool (load harness only) ───────────────────────┐
  │  K workers pull from shared queue                            │
  │  errors in one worker don't stop others                      │
  │  bounded parallelism → controlled load                       │
  └──────────────────────────────────────────────────────────────┘
```

## Elaborate

`AbortSignal.any` is a 2023 addition (Node 20.3+, Chrome 116+). Before it, everyone rolled their own composition — the manual fallback at `transport.ts:180-188` is what that looked like. Native `any` is cleaner: `filtered.length === 1` early-returns the single signal directly instead of allocating a controller.

The philosophy behind "cancellation as a signal" — instead of, say, forcibly killing a task — comes out of async programming's foundational constraint: you can't interrupt a synchronous stretch. If a task's mid-computation, the runtime can't rip it out. What you *can* do is set a flag that the task checks. Every mainstream async runtime landed on this pattern: Node's AbortSignal, Python's asyncio.CancelledError, Go's context.Context, .NET's CancellationToken. They're isomorphic — the same idea in different clothes.

The reason `blooming_insights` reaches for AbortSignal so aggressively is that **the alternative would be a stuck route with no diagnostic signal**. When a call hangs, you want the error path to fire with a clear error tag (`HTTP 0: timeout after 30000ms`), not a Vercel platform kill at 300s with no message. Every layered ceiling exists to shorten the "how do I know something went wrong" loop.

Read `08-runtime-systems-red-flags-audit.md` next — it ranks the top runtime risks in this file (and every other file in the guide) with evidence anchored to `file:line`.

## Interview defense

**Q: What's the deadline model? Multiple layers?**

Yes, three composed layers. Vercel's `maxDuration = 300s` is the outer ceiling — if the invocation runs that long, the platform kills it. Inside that, every MCP call gets wrapped in a 30s timeout via `AbortSignal.timeout` composed with the route's `req.signal` — whichever fires first cancels the underlying fetch. Inside *that*, each model turn checks `BudgetTracker.exceeded()` before dispatch; if the accumulated cost is over the USD ceiling, we throw `BudgetExceededError` instead of making the call. Three layers because each addresses a different failure: platform (runaway route), transport (hung call), cost (runaway agent). Skip any one and the other two can't compensate.

*Diagram to sketch: three nested boxes labeled 300s / 30s / $budget, with arrows showing each level's cancellation path — platform kills, AbortSignal fires, exception throws.*

**Q: How does cancellation propagate all the way into an in-flight `fetch`?**

Via `AbortSignal.any` composition. The route handler holds `req.signal`. When it calls `dataSource.callTool(name, args, { signal: req.signal })`, that passes the signal down. Inside the transport, we build a composed signal: `AbortSignal.any(req.signal, AbortSignal.timeout(30_000))`. That composed signal goes into `client.callTool(…, { signal })`, which threads it into `fetch(url, { signal })`. When the client disconnects, the TCP RST fires `req.signal`, which fires the composed signal, which rejects the in-flight fetch with `AbortError`. Control returns to the transport's catch block, wraps the error with the `HTTP 0:` tag, throws upward. Every await in the chain observes the cancellation at its next checkpoint.

*Diagram to sketch: a chain of arrows from `browser fetch abort` → `TCP RST` → `req.signal` → `composeSignals` → `client.callTool signal` → `fetch abort` → `AbortError` → `catch` → `throw`.*

**Q: The load-bearing part people forget about bounded work?**

That check-before-dispatch is not the same as cancellation. `BudgetTracker.exceeded()` stops the *next* model turn — it doesn't cancel the in-flight one. If you set a budget of $0.10 and the current turn is halfway through a $0.20 call, you're going to eat that whole $0.20 before the check fires again. The tradeoff: cancellation-during-model-call is doable (`AbortSignal.any` composes into `messages.create`) but adds complexity, and cost accounting only knows the cost *after* the response returns. Naming this explicitly signals you understand where the invariant actually holds — "never exceed by more than one turn."

*Diagram to sketch: a timeline with turn 1 (checked, dispatched, cost added), turn 2 (checked, exceeded → throw before dispatch), and a note "worst case: one turn's cost over budget."*

## See also

- `03-event-loop-and-async-io.md` — how AbortSignal.timeout uses the event loop's timer phase
- `04-shared-state-races-and-synchronization.md` — BudgetTracker as sequencing primitive shared across agents
- `06-filesystem-streams-and-resource-lifecycle.md` — how AbortSignal composes through the stream lifecycle
- `08-runtime-systems-red-flags-audit.md` — the ranked risk list built on top of these ceilings
