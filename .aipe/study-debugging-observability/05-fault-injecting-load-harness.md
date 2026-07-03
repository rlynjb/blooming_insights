# 05 · Fault-injecting load harness

*Decorator + chaos-eng lite / offline fault injection — **project-specific***

## Zoom out — where this concept lives

`FaultInjectingDataSource` is a decorator around any `DataSource`
adapter (Synthetic or Bloomreach). It fires timeout / rate-limit /
server-error / malformed-JSON faults at configurable per-call rates.
`eval/load.eval.ts` uses it to run N investigations at K concurrency
against the fake substrate with faults on, exposing how the agent
loop degrades under realistic Bloomreach failure conditions —
without touching the real Bloomreach server.

```
  Zoom out — the fault injector's seat in the stack

  ┌─ eval runner (vitest) ──────────────────────────────────┐
  │  eval/load.eval.ts                                       │
  │  - N=20, concurrency=3, budget per case                  │
  │  - FAULT_TIMEOUT=0.2, FAULT_MALFORMED_JSON=0.2, ...      │
  └─────────────────────────┬───────────────────────────────┘
                            │  wraps
                            ▼
  ┌─ ★ FaultInjectingDataSource ★  (decorator) ─────────────┐
  │  callTool(name, args, opts):                             │
  │    roll = random()                                        │
  │    if roll < timeout:      throw HTTP 0 timeout           │
  │    if roll < rateLimit:    throw 429                      │
  │    if roll < serverError:  throw HTTP 500                 │
  │    if roll < malformedJson: return corrupted envelope     │
  │    else:                   inner.callTool(...)            │
  │                                                          │
  │  listTools(): pass-through (bootstrap must not flake)    │
  └─────────────────────────┬───────────────────────────────┘
                            │  wraps
                            ▼
  ┌─ SyntheticDataSource ───────────────────────────────────┐
  │  in-process fake — deterministic responses               │
  └──────────────────────────────────────────────────────────┘
```

Zoom in — this is chaos engineering-lite in a single decorator. The
seam is `DataSource`; every abstraction downstream (agents, retry
ladder, `AgentEvent` error events, error handling in the routes) is
tested against the same failure surface Bloomreach exposes.

## Structure pass — the skeleton

**Axis held constant: what failure shape does each fault mimic?**

| Fault kind | Mimics real Bloomreach failure |
|---|---|
| `timeout` | 30s `AbortSignal.timeout` in `SdkTransport` (transport.ts:38) |
| `rate_limit` | Bloomreach's `1 per 10 second` penalty envelope (client.ts retry ladder) |
| `server_error` | HTTP 500 from the alpha server |
| `malformed_json` | Bloomreach EQL edge cases returning garbled text blocks |

**Seams:**

  → seam 1 — **`DataSource` as the extension point.** The decorator
    only exists because `DataSource` was already extracted as an
    abstract interface (`lib/data-source/types.ts`). Without that
    seam, the fault injector would need to reach into Bloomreach's
    OAuth layer to disturb it — messy and unreliable.
  → seam 2 — **only `callTool` is faulted.** `listTools` passes
    through untouched (`fault-injecting.ts:106-110`) so the
    bootstrap phase doesn't randomly fail. This is the deliberate
    choice: bootstrap failures aren't what the harness is
    exercising — steady-state fault tolerance is.
  → seam 3 — **`onFault` callback for observability.** Every
    injected fault fires `onFault({kind, toolName, callIndex})`
    (`fault-injecting.ts:47-52`), and the load runner aggregates
    per-kind counts into the load receipt.

## How it works

### Move 1 — the mental model

Think of it as `if (Math.random() < 0.2) throw` — that's the whole
shape. The decorator pattern from GoF just gives you a place to hang
that check without touching the underlying `DataSource`
implementation. Same interface in, same interface out; behavior
between the two is decorated with roll-and-inject.

```
  The pattern — decorator adds a random rejection step

  agent → callTool(name, args)
           │
           ▼
  ┌────────────────────────────────────────────────┐
  │  FaultInjectingDataSource.callTool             │
  │                                                │
  │    roll = random()   ← xorshift32 when seeded, │
  │                        Math.random() otherwise │
  │                                                │
  │    acc = 0                                     │
  │    for each configured rate in order:          │
  │      acc += rate                               │
  │      if roll < acc:                            │
  │        onFault({kind, toolName, callIndex})    │
  │        throw or return corrupted envelope      │
  │                                                │
  │    else: inner.callTool(name, args)  ← pass    │
  └────────────────────────────────────────────────┘
```

The "check order" matters — see part 3 below. It's a design choice
about which faults dominate when rates overlap.

### Move 2 — the step-by-step walkthrough

**Part 1 — the four failure shapes.**

Each one mimics a specific Bloomreach failure mode.

`fireTimeout` (`fault-injecting.ts:112-118`):

```typescript
private fireTimeout(toolName: string): never {
  this.options.onFault?.({ kind: 'timeout', toolName, callIndex: this.callIndex });
  // Shape mimics lib/mcp/transport.ts:137 — `HTTP 0: timeout after 30000ms`.
  throw new Error(`HTTP 0: timeout after 30000ms`, {
    cause: new Error('injected fault: timeout'),
  });
}
```

The `HTTP 0:` prefix is the real transport's timeout tag
(`transport.ts:137`) so the same downstream detection logic reads
"this is a timeout" whether the injector or the real transport
threw it. **What breaks if the prefix differs:** the retry ladder in
`BloomreachDataSource` decides retryability by matching text; a
different prefix means the injected fault behaves differently from
the real one — the whole point of the injector is defeated.

`fireRateLimit` (`fault-injecting.ts:120-128`) sets
`err.status = 429` and attaches the "please retry after 2000ms" text
that matches Bloomreach's error envelope. Same principle: the
downstream retry ladder can't tell injected from real.

`fireServerError` (`fault-injecting.ts:130-137`) — HTTP 500,
`err.status = 500`. This is the "just fail" path (no retry).

`fireMalformedJson` (`fault-injecting.ts:139-155`) is the odd one:
it does NOT throw. It returns a valid-looking `DataSourceCallResult`
envelope but the `content[0].text` is unclosed JSON. This exercises
the agent's downstream `JSON.parse` rejection path — the failure
lives at the boundary AFTER the tool call succeeds, in the layer
that interprets the result.

**Part 2 — the check order.**

From `fault-injecting.ts:81-100`:

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
if (r.serverError != null && r.serverError > 0) {
  acc += r.serverError;
  if (roll < acc) return this.fireServerError(name);
}
if (r.malformedJson != null && r.malformedJson > 0) {
  acc += r.malformedJson;
  if (roll < acc) return this.fireMalformedJson(name);
}

// No fault this call — pass through to the wrapped adapter.
return this.inner.callTool(name, args, opts);
```

**Why timeout is checked first.** The comment at
`fault-injecting.ts:79-80` names it: "heavy config still yields the
more disruptive fault surfaces first." When rates overlap (say,
`timeout=0.3, malformed=0.3`, roll = 0.15), the timeout fires — the
more disruptive fault wins. If order were reversed, high-config runs
would preferentially exercise the mild fault, and the harness would
under-test the disruptive ones.

**Part 3 — seeding for determinism.**

`fault-injecting.ts:157-166`:

```typescript
private random(): number {
  if (this.options.seed == null) return Math.random();
  let s = this.prngState;
  s ^= s << 13;
  s ^= s >>> 17;
  s ^= s << 5;
  this.prngState = s;
  return (Math.abs(s) % 1_000_000) / 1_000_000;
}
```

When `FAULT_SEED=42` is set, the fault sequence is reproducible
across runs. This is what turns "the agents flaked under load" into
a debug-able experiment: rerun with the same seed and observe the
same failure.

**Part 4 — the observability wire (`onFault`).**

The load runner sets `onFault` to aggregate per-kind counts, both
per-investigation and totals across the load receipt
(`load.eval.ts:253-259`):

```typescript
? new FaultInjectingDataSource(baseDataSource, {
    rates: FAULT_RATES,
    seed: FAULT_SEED,
    onFault: (f) => {
      faultCounts[f.kind] = (faultCounts[f.kind] ?? 0) + 1;
    },
  })
```

Per investigation, `faultCounts` lands on the `Investigation`
record. Across the run, `faultTotals` lands on the load receipt
(`load.eval.ts:344-349, 366`). Sample from a real load receipt
(`load-2026-07-03T05-21-12-237Z.json`):

```json
"faultTotals": {
  "malformed_json": 5,
  "timeout":        4
}
```

Meaning: over 3 investigations with `timeout=0.2, malformed_json=0.2`,
the agent absorbed 4 injected timeouts and 5 malformed responses,
and all 3 investigations still succeeded (`succeeded: 3, failed: 0`
on the same receipt). That's the observability payoff: not just
"did it work," but "how many bad things did it survive."

**Part 5 — what the load receipt actually captures.**

`eval/load-receipts/load-<runId>.json` (~4KB) — from the current
committed sample:

```json
{
  "runId": "...",
  "config": { "N": 3, "concurrency": 1,
              "budgetPerInvestigationUsd": 2,
              "faultRates": {...},
              "faultSeed": 42 },
  "totalMs": 283170,
  "succeeded": 3,
  "failed": 0,
  "faultTotals": {"malformed_json": 5, "timeout": 4},
  "percentilesMs": {
    "total":       {p50, p95, p99, max, mean},
    "investigate": {...},
    "recommend":   {...}
  },
  "costUsd": {"total": 0.2097, "perInvestigationP50": ..., "perInvestigationMax": ...},
  "tokens": {"totalIn": 17211, "totalOut": 10537, ...},
  "investigations": [
    {
      "index": 0,
      "caseId": "01-conversion-drop-mobile-checkout",
      "durationMs": {...},
      "inputTokens": 5869,
      "outputTokens": 3377,
      "costUsd": 0.068,
      "toolCallCount": 6,
      "faultCounts": {"malformed_json": 2}
    },
    ...
  ]
}
```

This is what makes fault-load observability real: not just "3/3
passed" but the distributions, the cost impact, and the fault
absorption count per investigation.

### Move 2 — Layers-and-hops: an injected timeout on tool call 4

```
  A malformed_json fault mid-investigation

  ┌─ load worker ────────────┐
  │  DiagnosticAgent          │
  │  .investigate(anomaly)    │
  └────────────┬─────────────┘
               │  tool call: execute_analytics_eql
               ▼
  ┌─ FaultInjecting ─────────┐
  │  roll = 0.35              │  rates: timeout=0.2, malformed=0.2
  │  acc  = 0.2 (timeout)     │  roll ≥ acc? yes, skip timeout
  │  acc  = 0.4 (malformed)   │  roll < acc? YES → fireMalformedJson
  │                           │
  │  onFault({kind:'malformed_json', toolName, callIndex:4})
  │                           │
  │  return {                  │
  │    result: {              │
  │      isError: false,      │
  │      content: [           │
  │        {type:'text',      │
  │         text:'{"broken":"unclosed'}  ← corrupted
  │      ]                    │
  │    },                     │
  │    durationMs: 42,        │
  │    fromCache: false       │
  │  }                        │
  └────────────┬─────────────┘
               │  seems successful — result comes back
               ▼
  ┌─ agent's downstream ─────┐
  │  aptkit parses result as │
  │  JSON → SyntaxError       │
  │  agent turn observes the  │
  │  broken payload, decides  │
  │  to retry or abort         │
  └────────────┬─────────────┘
               │  the investigation either recovers or fails
               ▼
  load worker records:
    faultCounts.malformed_json += 1
    (per-investigation entry in the load receipt)
```

### Move 3 — the principle

**Fault-inject at the seam, not inside the layer.** The agents,
retry ladders, and route handlers don't know they're being tested —
they see the same failure shapes they'd see against the real
Bloomreach server. This is only possible because `DataSource` was
extracted as a real seam; the fault injector is a *decorator* over
that seam, not a monkey-patch inside the transport. When the next
adapter arrives (`OlistDataSource`, a hypothetical CSV adapter, a
mocked S3 loader), the fault injector works against it unchanged —
because it only ever depended on the abstract `DataSource`
interface.

## Primary diagram

```
  Fault-injecting load harness — full picture

  ┌──────────────────────────────────────────────────────────────────┐
  │ CONFIG                                                            │
  │   LOAD_N=20, LOAD_CONCURRENCY=3, BUDGET_MAX_USD=2.0                │
  │   FAULT_TIMEOUT=0.2, FAULT_MALFORMED_JSON=0.2, FAULT_SEED=42       │
  └──────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
  ┌──────────────────────────────────────────────────────────────────┐
  │ eval/load.eval.ts                                                 │
  │                                                                    │
  │   for i in 0..N (concurrency K):                                  │
  │     golden = goldens[i % len(goldens)]                            │
  │     dataSource = FAULT_ENABLED                                    │
  │       ? new FaultInjectingDataSource(                             │
  │           new SyntheticDataSource(),                              │
  │           {rates: FAULT_RATES, seed: FAULT_SEED, onFault})        │
  │       : new SyntheticDataSource()                                 │
  │                                                                    │
  │     DiagnosticAgent(sharedAnthropic, dataSource, ...)              │
  │       .investigate(golden.anomaly, {onCapabilityEvent, budget})   │
  │                                                                    │
  │     record {                                                       │
  │       caseId, signalClass, durationMs, tokens, cost,               │
  │       faultCounts,   ← observability from the injector            │
  │       error                                                        │
  │     }                                                              │
  │                                                                    │
  │   summarize percentiles + cost totals + faultTotals                │
  │   writeFileSync(eval/load-receipts/load-<runId>.json)              │
  └──────────────────────────────────────────────────────────────────┘

  What lives in the load receipt:
    · per-investigation: durationMs, tokens, cost, faultCounts, error?
    · aggregates: percentiles p50/p95/p99, totalCost, faultTotals
    · config: N, K, budget, rates, seed
```

## Elaborate

**Where this pattern comes from.** Chaos engineering (Netflix's
Chaos Monkey, Gremlin, Litmus) applies the same idea at
infrastructure scale — kill nodes, degrade network. The
FaultInjectingDataSource is the "in-process, at-the-seam" version:
same principle, targeted at the code you actually own. The decorator
approach comes straight out of GoF; the "roll-and-inject" method
comes out of standard test-double literature.

**Cousins that solve the same problem differently.**

  → **`msw` (Mock Service Worker) at the HTTP layer** — would work
    against the real Bloomreach transport, but requires re-encoding
    Bloomreach's response shapes in fixture form. The
    FaultInjectingDataSource sits above HTTP, so it inherits
    whatever the real adapter produces.
  → **Toxiproxy / network-level chaos** — more realistic, more
    infra to run. Overkill for a single Next.js process.
  → **Manual fixtures per test** — brittle, doesn't test rate
    interactions.

**Why `listTools` is deliberately clean.** Bootstrap failures aren't
what the harness is exercising. The steady-state ReAct loop — call
tool → observe → call tool — is the target. If bootstrap flaked
randomly, every investigation would fail before it started, and the
signal would drown.

**Adjacent to `03-capability-trace-receipts.md`.** The load receipt
is the aggregate cousin of the per-case receipt. Same substrate
(receipts on disk), different scope (N investigations rolled up vs
one case detailed).

## Interview defense

**Q1 · "How do you know the agent behaves correctly against a
Bloomreach server that rate-limits and occasionally returns
malformed responses?"**

**Model answer.** `FaultInjectingDataSource` wraps any `DataSource`
adapter and injects timeout / rate-limit / server-error /
malformed-JSON faults at configurable per-call rates
(`lib/data-source/fault-injecting.ts:59-104`). The load harness
runs N investigations at K concurrency with faults on and captures
`faultTotals` in a load receipt — so I can point at "the agent
absorbed 4 injected timeouts across 3 investigations and all 3
succeeded" as evidence. Anchor:
`eval/load-receipts/load-2026-07-03T05-21-12-237Z.json` has
`succeeded: 3, faultTotals: {malformed_json: 5, timeout: 4}`.

**Q2 · "The fault injector fires only on `callTool`, not
`listTools`. Why?"**

**Model answer.** Bootstrap failures aren't what the harness is
exercising. The ReAct loop's steady-state behavior — "call tool,
observe result, decide next tool" — is what needs the fault
coverage. If `listTools` flaked randomly, every investigation
would die at bootstrap and I'd get no signal about the loop.
`fault-injecting.ts:106-110` explicitly comments on this. It's a
deliberate choice about what surface you're testing.

**Q3 · "What's the load-bearing part of this pattern people
forget?"**

**Model answer.** The injected fault shapes have to **match the
real failure shapes exactly** — including the error message text —
because downstream code (retry ladders, error detection) matches
by string. `fireTimeout` throws `HTTP 0: timeout after 30000ms` —
which is the same string `SdkTransport` throws in `transport.ts:
137`. If the injector said "HTTP 999: fake timeout" the retry
ladder wouldn't recognize it as retryable, and the harness would
be testing a different code path than production. Anchor comment:
`fault-injecting.ts:114`.

```
  interview sketch — the "shape must match" invariant

  production timeout   ─► "HTTP 0: timeout after 30000ms"  ─┐
                                                             │  same
                                                             │  string
                                                             │  →
  injected timeout     ─► "HTTP 0: timeout after 30000ms"  ─┘  same
                                                                downstream
                                                                path

  If the injected string differed, downstream would take a
  different branch → we'd test the wrong path.
```

## See also

- `03-capability-trace-receipts.md` — the per-case sibling of this
  file's aggregate load receipt
- `04-baseline-and-regression-gate.md` — quality-under-clean-run
  gate; this file is quality-under-fault-load
