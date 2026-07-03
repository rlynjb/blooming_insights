# load harness with fault injection

**Industry name(s):** load testing · concurrency semaphore · fault injection · chaos engineering (offline variant). **Type label:** Industry standard.

## Zoom out — where the harness sits

Two orthogonal machines that compose. The load harness runs N investigations at concurrency K without judges. The fault-injection decorator wraps the data source to force failures. Together they answer "what happens when the agents run in parallel AND the data source flakes."

```
Zoom out — where the harness + decorator sit

┌─ Runner band (Vitest) ──────────────────────────────────┐
│  eval/load.eval.ts                                       │
│  semaphore workers (K)                                    │
│  queue.shift() per index                                  │
└──────────────────────────┬───────────────────────────────┘
                           │  N investigations
┌─ Agent band ─────────────▼───────────────────────────────┐
│  DiagnosticAgent · RecommendationAgent                    │
│  ReAct loop calls callTool                                │
└──────────────────────────┬───────────────────────────────┘
                           │  callTool(...)
┌─ Data-source band ───────▼───────────────────────────────┐
│  FaultInjectingDataSource (wraps SyntheticDataSource)     │
│  ★ rolls dice; injects timeout / 429 / 500 / malformed ★  │ ← we are here
└──────────────────────────┬───────────────────────────────┘
                           │  passes through if no fault
┌─ Storage band ───────────▼───────────────────────────────┐
│  SyntheticDataSource → synthetic events                   │
│  load-receipts/load-<runId>.json                          │
└──────────────────────────────────────────────────────────┘
```

**Zoom in — what it is.** A semaphore-based load runner + a decorator that fakes the failure modes real Bloomreach exhibits. The receipt at the end tells you two things: (a) the latency + cost distributions under concurrency, (b) the count of injected faults vs the count of investigation failures. The gap between those two numbers is the "agents reason around faults" property, quantified.

## Structure pass — layers · one axis · one seam

The axis worth tracing is **who owns the failure**.

```
one axis held: "who OWNS this failure when it appears?"

┌─ load runner (worker pool) ──────────────────────────────┐
│  catches thrown investigation errors                      │  → runner OWNS: does the run continue?
└──────────────────────────┬────────────────────────────────┘
                           │  seam: try/catch around runOneInvestigation
┌─ agent (ReAct loop) ─────▼───────────────────────────────┐
│  sees tool_result with is_error: true                     │  → agent OWNS: reason around it, try different query
└──────────────────────────┬────────────────────────────────┘
                           │  seam: DataSource.callTool
┌─ data-source decorator ──▼───────────────────────────────┐
│  FaultInjectingDataSource                                 │  → decorator OWNS: which failure mode fires
│  throws timeout / 429 / 500                               │
│  returns malformed_json non-throwing                      │
└───────────────────────────────────────────────────────────┘
```

**The seams.** Two joints: (1) `DataSource.callTool` — the interface the decorator wraps, unchanged since the DataSource seam extraction (`lib/data-source/bloomreach-data-source.ts` history note); (2) the ReAct loop's tool_result convention — a throw at the callTool level becomes a `tool_result` block with `is_error: true`, which the model reads as text and reasons around. The failure axis flips across both.

## How it works

### Move 1 — the mental model

You know how a chaos-monkey works: it randomly kills instances in production and you watch what breaks. This is a chaos-monkey for the data-source layer, but offline. The decorator wraps the same interface the real Bloomreach adapter satisfies; from the agent's perspective, an injected timeout is indistinguishable from a real Bloomreach 30s timeout.

```
The pattern — decorator + semaphore

  ┌─────────────────────────┐
  │  semaphore workers (K)  │  workers pull indices from a queue
  └─────────┬───────────────┘
            │
            ▼
  ┌─────────────────────────┐
  │  runOneInvestigation()  │  each index: diagnose + recommend
  └─────────┬───────────────┘
            │  callTool(...)
            ▼
  ┌─────────────────────────┐
  │  FaultInjectingDataSource│  wraps SyntheticDataSource
  │   ┌───────────────────┐ │  rolls one random number
  │   │  timeout?  → throw │ │  first threshold that fires wins
  │   │  429?      → throw │ │
  │   │  500?      → throw │ │
  │   │  malformed?→ return│ │  (non-throwing failure)
  │   │  else     → passthr│ │
  │   └───────────────────┘ │
  └─────────────────────────┘
```

The four failure modes cover what the tier-2 story defends against: `timeout`, `rate_limit`, `server_error`, `malformed_json`. The first three throw; the fourth returns a shape-broken tool_result that the agent's downstream JSON parse rejects. That distinction matters — the ReAct loop sees them differently.

### Move 2 — the step-by-step walkthrough

#### Step 1 — the semaphore worker pool

`eval/load.eval.ts:170`:

```typescript
const indices = Array.from({ length: LOAD_N }, (_, i) => i);
const queue = [...indices];

async function worker(workerId: number): Promise<void> {
  while (queue.length > 0) {
    const index = queue.shift();
    if (index == null) return;
    // ... runOneInvestigation, push result, log
  }
}

const workers = Array.from({ length: LOAD_CONCURRENCY }, (_, i) => worker(i));
await Promise.all(workers);
```

Standard semaphore-over-a-queue. Each worker is an async function that pulls from a shared queue until empty. K workers = K concurrent investigations. `Promise.all(workers)` waits for all of them to drain.

**Why this shape, not `Promise.all(indices.map(...))`:** the map-then-await variant fires all N at once and the runtime buffers them. Semaphore-over-queue is genuinely bounded — you never have more than K investigations running at a time, even if the runtime could handle more. That's what you want when the bottleneck is your Anthropic per-key rate.

**What breaks under LOAD_CONCURRENCY > Anthropic per-key limit:** individual model calls start 429ing. The eval doesn't retry those (`AptKit`'s loop propagates the error), so investigations fail. The semaphore prevents this by keeping K small; tuning K is where you meet the rate limit head-on.

#### Step 2 — the fault-injection decorator

`lib/data-source/fault-injecting.ts:59` defines the class. The load harness wires it in at `eval/load.eval.ts:252`:

```typescript
const dataSource = FAULT_ENABLED
  ? new FaultInjectingDataSource(baseDataSource, {
      rates: FAULT_RATES,
      seed: FAULT_SEED != null ? FAULT_SEED + index : undefined,
      onFault: (f) => {
        faultCounts[f.kind] = (faultCounts[f.kind] ?? 0) + 1;
      },
    })
  : baseDataSource;
```

Only when any fault rate > 0. The seed is `FAULT_SEED + index` so each investigation is reproducible individually AND runs distinct fault sequences.

`lib/data-source/fault-injecting.ts:81` is the decision loop:

```typescript
const roll = this.random();
const r = this.options.rates;

let acc = 0;
if (r.timeout != null && r.timeout > 0) {
  acc += r.timeout;
  if (roll < acc) return this.fireTimeout(name);
}
if (r.rateLimit != null && r.rateLimit > 0) {
  acc += r.rateLimit;
  if (roll < acc) return this.fireRateLimit(name);
}
// ... serverError, malformedJson
// No fault this call — pass through to the wrapped adapter.
return this.inner.callTool(name, args, opts);
```

One roll per call. Cumulative thresholds mean the rates compose additively — `timeout=0.2, malformed=0.2` gives a 40% total fault rate, split evenly. Higher-severity errors are checked first so a heavy config still yields the more disruptive fault surfaces first (comment at line 78).

**What breaks if you roll separately per fault:** a call could fire both a timeout AND a malformed_json in the same invocation, which is meaningless. One roll per call is the right shape.

#### Step 3 — the four failure shapes

Each `fire*` method matches the shape of the real failure it's imitating. `fireTimeout` at line 112:

```typescript
throw new Error(`HTTP 0: timeout after 30000ms`, {
  cause: new Error('injected fault: timeout'),
});
```

The message is byte-identical to what `lib/mcp/transport.ts:137` throws on a real timeout. That's on purpose — the agent's downstream error handling doesn't know it's a fake.

`fireRateLimit` at line 120 mimics Bloomreach's 429 shape. `fireServerError` at line 130 mimics a 500. `fireMalformedJson` at line 139 is the odd one — it doesn't throw:

```typescript
private async fireMalformedJson(toolName: string): Promise<DataSourceCallResult> {
  return {
    result: {
      isError: false,
      content: [
        { type: 'text', text: '{"broken":"unclosed' },
      ],
      structuredContent: undefined,
    },
    durationMs: 42,
    fromCache: false,
  };
}
```

It returns a successfully-shaped envelope with corrupted content. The MCP result envelope handling downstream (`structuredContent` preferred, else `content[0].text` → JSON.parse) rejects it. This exercises a different failure surface than the throw-based ones.

**What breaks if malformed_json throws instead:** it collapses into the same failure surface as timeout. Two paths are exercised by design.

#### Step 4 — the agent reasons around the fault

The load-bearing behavior. AptKit's ReAct loop catches the exception at the tool-execution seam and presents it as a `tool_result` block with `is_error: true`. The model sees that block on the next turn, reasons about it, and typically issues a different tool call.

The proof: `FAULT_TIMEOUT=0.2, FAULT_MALFORMED_JSON=0.2, N=3` injected 9 faults across 3 investigations, and **all 3 investigations succeeded**. The receipt at `eval/load-receipts/load-2026-07-03T05-21-12-237Z.json`:

```json
{
  "config": {
    "N": 3,
    "faultRates": { "timeout": 0.2, "malformedJson": 0.2 }
  },
  "succeeded": 3,
  "failed": 0,
  "faultTotals": { "malformed_json": 5, "timeout": 4 }
}
```

9 faults injected, 0 investigation failures. The model didn't crash; it kept trying different queries until it got a clean result.

**What this measures:** graceful degradation is a real property of this system, not an aspiration. The three investigations still cost $0.21 (up ~30% from a fault-free run of the same N, because retries cost tokens) but they all completed.

```
Layers-and-hops — one fault, from injection to model recovery

┌─ Agent loop turn N ──────┐  hop 1: model emits tool_use
│  execute_analytics_eql   │ ─────────────────────────────┐
└──────────────────────────┘                              │
                                                          ▼
                                        ┌─ FaultInjectingDataSource ┐
                                        │  roll = 0.13              │
                                        │  timeout threshold 0.2    │
                                        │  → fireTimeout()          │
                                        └────────┬───────────────────┘
                                                 │  hop 2: throw
                                                 ▼
                                        ┌─ AptKit tool exec seam    ┐
                                        │  catches, wraps as        │
                                        │  tool_result is_error     │
                                        └────────┬───────────────────┘
                                                 │  hop 3: back to model
                                                 ▼
                                        ┌─ Agent loop turn N+1     ┐
                                        │  model reads "HTTP 0:    │
                                        │  timeout" text, reasons,  │
                                        │  tries different query    │
                                        └───────────────────────────┘
```

#### Step 5 — the load receipt aggregates it all

`eval/load.eval.ts:335` builds the receipt. Unlike `run.eval.ts` which writes one file per case, `load.eval.ts` writes **one summary file per load run**. That's the right shape at N=20+: you care about the aggregate distributions, not per-investigation detail. The per-investigation rows still ship inside the receipt for debugging.

```json
"percentilesMs": {
  "total": { "p50": 92707, "p95": 99630, "p99": 99630, "max": 99630, "mean": 94390 },
  "investigate": { "p50": 43726, "p95": 46009, "p99": 46009, "max": 46009, "mean": 44350 },
  "recommend": { "p50": 47516, "p95": 55904, "p99": 55904, "max": 55904, "mean": 50039 }
}
```

Same nearest-rank percentiles as the report (see `03-observability-report.md`). At N=3, p95 = p99 = max = index 2, which is honest about the low N.

### Move 3 — the principle

The load-bearing move is **decorator composition on a stable interface**. The `DataSource` seam is what makes fault injection possible without touching agent code — the decorator wraps the same interface, and the agents can't tell the difference between a real Bloomreach 429 and an injected one. The seam has already survived two adapter swaps (Olist added and removed, Synthetic added); the fault injector is a third — offline decoration rather than a swap. When your seams are clean, you can bolt a chaos-monkey onto the outside of the system without a single edit to the inside.

## Primary diagram — the recap

```
The load-harness + fault-injection pattern — end to end

┌─ Config ────────────────────────────────────────────────────────┐
│  LOAD_N=3  LOAD_CONCURRENCY=1                                    │
│  FAULT_TIMEOUT=0.2  FAULT_MALFORMED_JSON=0.2  FAULT_SEED=42     │
└──────────────────────────────┬──────────────────────────────────┘
                               │
                               ▼
┌─ eval/load.eval.ts ─────────────────────────────────────────────┐
│                                                                  │
│  beforeAll:                                                      │
│    · mint sharedRunId                                            │
│    · build Anthropic client                                      │
│    · log config                                                  │
│                                                                  │
│  main test:                                                      │
│    · queue = [0..N-1]                                            │
│    · K workers, each: while queue non-empty: run one             │
│    · each: SyntheticDataSource + FaultInjectingDataSource wrap   │
│    · each: DiagnosticAgent → RecommendationAgent, shared budget  │
│    · errors caught, pushed to results with error field           │
│                                                                  │
│  aggregate:                                                      │
│    · percentiles across succeeded[]                              │
│    · faultTotals across all investigations                       │
│    · write load-receipts/load-<runId>.json                       │
│                                                                  │
└──────────────────────────────┬──────────────────────────────────┘
                               │
                               ▼
┌─ Receipt (one file per run) ────────────────────────────────────┐
│  { config, totalMs, succeeded, failed, faultTotals,              │
│    percentilesMs, costUsd, tokens, investigations[] }            │
│                                                                  │
│  Proof of graceful degradation:                                  │
│    9 faults / 3 investigations → 0 failed                        │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

## Elaborate

Load testing goes back to LoadRunner in the 90s and JMeter in the 2000s. Both are external drivers hitting a live system. This harness is the same shape but in-process — the driver, the agents, and the (synthetic) data source all run in one Vitest process. That works because the bottleneck being measured is the Anthropic API, not local machine resources.

Fault injection has its own history — Netflix Chaos Monkey (2011) popularized the term. The offline variant here doesn't kill instances; it wraps a single interface. That's a lighter-weight but narrower version of the pattern: you're only exercising failures at one seam, not the whole distributed graph. For blooming's scale (one process, one Anthropic key, one Bloomreach adapter), that's the right seam.

**Adjacent primitive worth naming.** The decorator pattern is what makes this cheap. `FaultInjectingDataSource implements DataSource` — no interface change, no caller edits. If you've ever wrapped a `fetch` with a caching-fetch or a retry-fetch, you've built this. The chaos-monkey use case is one specialization; retry, caching, logging, and rate-limiting are others. Same shape, different intent.

**What to read next.** `05-rate-limit-spacing-and-retry-ladder.md` for how the real Bloomreach path handles the same failure modes without the decorator. `03-observability-report.md` for how the per-case receipts differ from the load-run summary receipt.

## Interview defense

**Q: Walk me through the load harness and why the fault-injection decorator is separate.**

Two orthogonal machines that compose. The load harness runs N investigations at concurrency K — semaphore over a queue, each worker pulls an index until empty. No judges, so the wall clock is the agent loop only; cost is roughly $0.09 per investigation. That's the throughput measurement.

The fault-injection decorator wraps any `DataSource` — including the synthetic one the load harness uses — and forces failures at configurable per-error probabilities: timeout, rate_limit, server_error, malformed_json. First three throw; malformed_json returns a shape-broken tool_result envelope so the downstream JSON parse rejects it. The load-bearing property this proves: with `FAULT_TIMEOUT=0.2, FAULT_MALFORMED_JSON=0.2, N=3`, I injected 9 faults across 3 investigations and got 0 investigation failures. The AptKit ReAct loop presents each thrown fault as a `tool_result` block with `is_error: true`; the model reads that block on the next turn and issues a different tool call. Graceful degradation, quantified.

The two are separate because the load harness answers "throughput" and the decorator answers "resilience." Either alone is meaningful; together they answer "throughput under stress."

```
The anchor diagram to sketch

K workers ← queue [0..N-1]
    │
    ▼
one investigation:
  DataSource ← FaultInjectingDataSource ← SyntheticDataSource
                       │
                       ▼
       roll 0.13 < timeout 0.2 → throw
                       │
                       ▼
       agent sees tool_result is_error → next turn, different query
```

**Q: Why semaphore-over-queue instead of `Promise.all(map)`?**

`Promise.all(map)` fires N promises at once and lets the runtime handle them however. Semaphore-over-queue is genuinely bounded — you never have more than K in flight. When the bottleneck is Anthropic's per-key rate, that matters — K becomes the tuning knob against the rate limit. With map-then-await you can't control it.

**Q: Why does malformed_json not throw?**

To exercise a different failure surface. The three throwing variants (timeout / 429 / 500) all land at the same catch in the AptKit tool-exec seam — same code path. Malformed JSON returns a successfully-shaped envelope with corrupted content, which the MCP downstream (`structuredContent` preferred, else `content[0].text` → JSON.parse) rejects at a different layer. The agent reads *that* rejection differently than it reads a thrown timeout, so I get proof of both recovery paths from one config.

**Q: Where does the semaphore not save you?**

Anthropic's per-key rate limit — if K exceeds what my key allows, individual model calls 429 and the AptKit loop propagates that. The semaphore bounds *my* concurrency, not Anthropic's ceiling on it. Fair — I'd need Anthropic-side retry-with-backoff to handle that, and the point of the load test is to measure where the ceiling sits, not to work around it.

## See also

- `05-rate-limit-spacing-and-retry-ladder.md` — the real Bloomreach path exercises these same failure modes with server-stated retry windows.
- `03-observability-report.md` — sibling pattern; per-case receipt shape for the judged eval.
- `audit.md` §8 R6 — the honest note that this is offline chaos, not live chaos.
