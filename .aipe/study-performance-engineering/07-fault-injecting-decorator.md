# 07 · Fault-injecting decorator

**Decorator + chaos injection · Industry standard.** Also called
*chaos monkey* (Netflix), *fault injection*, or *failure
simulation*. The decorator shape (wrap a real service so a
fraction of calls fail in known ways) is the reusable primitive;
the failure modes named here are load-bearing for the graceful-
degradation story.

## Zoom out — where the decorator sits

Between the load harness and the concrete data source. `FaultInjectingDataSource`
implements `DataSource`, wraps another `DataSource` (typically
`SyntheticDataSource`), and forces failures at configurable rates
BEFORE the wrapped source's `callTool` ever runs.

```
  Zoom out — the decorator seam

  ┌─ Agent (unchanged) ──────────────────────────────────────────┐
  │  dataSource.callTool(name, args)                              │
  │  ─ doesn't know if it's real, synthetic, or fault-injected    │
  └───────────────────────────────┬──────────────────────────────┘
                                  │  DataSource interface
  ┌─ FaultInjectingDataSource ────▼──────────────────────────────┐
  │                                                                │
  │   ★ per-call PRNG roll → maybe throw / delay / malformed ★     │
  │                                                                │
  │   if fault fires:                                              │
  │     · timeout        → delay past TOOL_TIMEOUT_MS               │
  │     · rate_limit     → throw 429 with retry-after hint          │
  │     · server_error   → throw 500                                │
  │     · malformed_json → return content the agent can't parse     │
  │   else:                                                        │
  │     inner.callTool(...) ← normal path                          │
  └───────────────────────────────┬──────────────────────────────┘
                                  │  DataSource interface
  ┌─ inner: SyntheticDataSource ──▼──────────────────────────────┐
  │  in-process fake · returns fixture data · 0ms                 │
  └───────────────────────────────────────────────────────────────┘
```

**Zoom in — one shape, five uses.** The `DataSource` interface is
the seam. The comment at `fault-injecting.ts:9-16` names it: this
is the *fourth* use of the seam without a caller-surface change
(Olist added, Olist removed, Synthetic added, this decorator, and
now the McpDataSource generalization). Stability across five uses
is what makes the "graceful degradation under fault injection"
story defensible — the agents don't know they're being tested.

## Structure pass — layers, axis, seams

**Layers.** The decorator layer plus everything either side.

**Axis: what's the difference between "test with a fake" and
"test with fault injection"?**

```
  Axis — "what kind of failure does the test exercise?"

  ┌─ test type ─────────────┐   what fails            what's tested
  │ happy path (Synthetic)   │   nothing               tool result shape
  │ unit test (per-agent)    │   mock returns X         one agent's logic
  │ integration (Synthetic) │   nothing                whole loop
  │ fault-injection          │   1 in K calls          graceful degradation
  │ live-load (would burn $) │   real 429s / timeouts  end-to-end reality
  └─────────────────────────┘
```

**Seams.** Two: the DataSource interface (the outer seam — the
decorator preserves it exactly) and the fault-check gate inside
`callTool` (the inner seam — where the PRNG roll decides whether
this call gets faulted).

## How it works

### Move 1 — the mental model

You already know the *decorator pattern* from wrapping a `fetch`
with logging or retry logic. This is that pattern applied to the
`DataSource` port: same interface in, same interface out, added
behavior in between. The added behavior here is "sometimes fail
in known ways."

```
  Pattern — decorator + configurable fault

    callTool(name, args)  ───►  FaultInjectingDataSource
                                    │
                                    ▼
                              PRNG.roll()
                                    │
                    fires?  ────yes───►  emit fault (throw/delay/malformed)
                       no
                        ▼
                   inner.callTool(name, args)  ───►  normal result

    same DataSource interface; agents don't know
```

**Skeleton part everyone forgets.** *Independent per-error
probabilities, first-fire wins.* Each fault type has its own
probability (`FAULT_TIMEOUT=0.2`, `FAULT_MALFORMED_JSON=0.2`), and
they're checked in a fixed order. A call can only fail ONE way
per invocation — whichever check fires first. This is what makes
the fault sequence reproducible across runs (with a seed) and what
lets you say "5 malformed_json + 4 timeout" instead of "9 faults,
distribution unknown."

### Move 2 — walking the mechanism

#### The four failure modes

`lib/data-source/fault-injecting.ts:19-28`:

```
  · timeout          — delays past the transport's 30s TOOL_TIMEOUT_MS,
                         or throws HTTP-0 style timeout error inline
  · rate_limit       — 429 error carrying a retry-after hint. The
                         McpDataSource retry ladder handles it exactly
                         the way it handles a live server's 429.
  · server_error     — 500 error mimicking a stock HTTP error envelope
  · malformed_json   — returns a ToolResult with garbled content that
                         the agent's downstream JSON parse will reject
```

**Each failure mode maps to a real live failure.** Timeout
exercises the tool-timeout path (§01). Rate_limit exercises the
retry ladder (§02). Server_error exercises the general HTTP-error
path in transport. Malformed_json exercises the agent's own
downstream JSON parsing — a different failure mode from the
transport layer, and one that a naive test suite misses.

**Not injected: budget exceeded, dispatch race, cancel mid-stream.**
Those either aren't fault classes (BudgetExceeded is by design)
or aren't tool-call-level (cancel is request-level). Named
honestly rather than pretending the decorator covers everything.

#### The PRNG choice

`lib/data-source/fault-injecting.ts:45-56` (from the earlier read):

```ts
export type FaultInjectorOptions = {
  rates: FaultRates;
  /** Optional deterministic seed. When set, PRNG is xorshift32 with this seed;
   *  otherwise Math.random(). Deterministic seed makes the fault sequence
   *  reproducible across runs — useful for regression tests. */
  seed?: number;
  onFault?: (fault: {…}) => void;
};
```

**Seed → xorshift32; no seed → Math.random.** Deterministic runs
matter for regression tests: "this seed + this fault rate should
produce this specific fault sequence." When you're debugging why
run 3 investigation 2 tool call 5 timed out, you can replay the
exact sequence. `Math.random()` mode is fine for smoke runs where
you want statistical rather than exact behavior.

**Seed offset per investigation.** `eval/load.eval.ts:253-256`:

```ts
const dataSource = FAULT_ENABLED
  ? new FaultInjectingDataSource(baseDataSource, {
      rates: FAULT_RATES,
      seed: FAULT_SEED != null ? FAULT_SEED + index : undefined,
      onFault: (f) => { faultCounts[f.kind] = (faultCounts[f.kind] ?? 0) + 1; },
    })
  : baseDataSource;
```

**Why `FAULT_SEED + index`.** Two properties: (1) two runs with
the same `FAULT_SEED` produce identical fault sequences per
investigation (reproducible); (2) different investigations within
the same run produce different sequences (each investigation
stresses a different pattern of faults). Constant seed + constant
offset per investigation = deterministic-yet-unique. Comment
alongside names this as the design goal.

#### The onFault hook

Every fault increments a per-kind counter (`load.eval.ts:257-258`).
The receipt aggregates across investigations
(`load.eval.ts:344-351`):

```ts
// Aggregate fault counts across all investigations
const faultTotals: Record<string, number> = {};
for (const inv of results) {
  if (!inv.faultCounts) continue;
  for (const [k, v] of Object.entries(inv.faultCounts)) {
    faultTotals[k] = (faultTotals[k] ?? 0) + v;
  }
}
```

**What this produces.** The tier-2 receipt line:

```
  Fault injections (per-error-type totals)
  ────────────────────────────────────────
    malformed_json      5
    timeout             4
```

Nine total faults across three investigations, all recovered, zero
investigation failures. That's the defensible number the story
rests on — you can point at the receipt file
(`eval/load-receipts/load-2026-07-03T05-21-12-237Z.json`) and the
counts match.

#### The load-eval result

From that receipt:

```
  config: N=3, concurrency=1
  faultRates: { timeout: 0.2, malformed_json: 0.2 }
  faultSeed: 42
  totalMs: 283170
  succeeded: 3
  failed: 0
  faultTotals: { malformed_json: 5, timeout: 4 }
```

**All 3 investigations succeeded through 9 faults.** That's the
graceful-degradation claim: with a 40% aggregate fault rate
(20% timeout + 20% malformed JSON, independent), zero
investigations failed to produce a diagnosis. The agent's reasoning
absorbs the faults — either the retry ladder recovers them, or
the agent notices "this tool returned garbage" and tries a
different query.

### Move 3 — the principle

Test failure paths on real code with a decorator, not with
mocks. Mocks let you test "the agent calls the tool and gets X"
— but they don't test the actual failure paths (the retry ladder,
the JSON parse, the agent's re-planning logic) because the mock
short-circuits before those paths run. A decorator preserves the
real interface and the real code paths; it just controls WHICH
paths are exercised. That's the difference between "we have a
graceful degradation story" and "we've verified graceful
degradation on real code."

## Primary diagram

```
  The full fault-injected load run

  env: FAULT_TIMEOUT=0.2 FAULT_MALFORMED_JSON=0.2 FAULT_SEED=42 N=3 K=1
                              │
                              ▼
  runOneInvestigation(index=0)
      │
      ▼
    baseDataSource = new SyntheticDataSource()
    dataSource     = new FaultInjectingDataSource(base, {
                       rates: { timeout: 0.2, malformed_json: 0.2 },
                       seed: 42 + 0,
                       onFault: (f) => faultCounts[f.kind]++
                     })
      │
      ▼
    DiagnosticAgent uses dataSource ─ doesn't know it's decorated

    tool call 1 → PRNG roll → timeout fault
                  ▲ agent's retry ladder fires
                  ▲ eventual result
    tool call 2 → PRNG roll → clean
    tool call 3 → PRNG roll → malformed_json
                  ▲ agent parses, sees garbage, tries different query
    …
    diagnosis produced (success)
      │
      ▼
    RecommendationAgent · same decorator · same behavior
      │
      ▼
    investigation done — faultCounts: {timeout: 1, malformed_json: 1}

  repeat for index=1, 2 → aggregate → receipt
```

## Elaborate

**Where the pattern comes from.** Chaos engineering — Netflix's
Chaos Monkey (2010) turning off production instances at random.
The idea generalizes to injection at any seam: network chaos
(tc/netem), disk chaos (ChaosMesh), and application-level chaos
(this decorator). What's specific here is the *scope*: not
production, but offline load runs — so you can measure
degradation without paying the production risk.

**Why offline instead of live.** Two reasons in the comments.
First, hitting the live Bloomreach MCP with faults burns the ~1
req/s budget for testing that's easier done in-process. Second,
the fault classes we can INJECT are richer than what we can
provoke live (you can't reliably cause a live 500 or a live
malformed response). Offline + decorator gives full control.

**Cross-link.** `study-testing` walks the full eval design (goldens,
judges, receipts) that the fault-injected run reuses. `study-
software-design` walks the decorator pattern itself and why the
`DataSource` interface stability across five uses is the
architectural payoff.

## Interview defense

### Q1 · "Walk me through your graceful degradation story."

**Answer.** Decorator pattern on the `DataSource` port.
`FaultInjectingDataSource` wraps any concrete data source
(typically `SyntheticDataSource` for load runs) and — before
delegating to the wrapped `callTool` — rolls a seeded PRNG against
per-error-type rates. If a fault fires, we emit it in one of four
shapes: a delayed/throwing timeout, a 429 with a retry-after
hint, a 500 error, or a malformed JSON response body. Each shape
maps to a real live failure class — the retry ladder handles 429
exactly the way it handles a live 429, the JSON parse in the
agent handles malformed_json the way it handles a real garbled
tool response, and so on. The agents never know they're being
tested. Load run receipts show, for `FAULT_TIMEOUT=0.2
FAULT_MALFORMED_JSON=0.2 N=3` with seed 42: 9 injected faults, 3
investigations succeeded, 0 failures. That's the defensible
number.

```
  same DataSource interface
       ▲
       │
  ┌────┴───────────────┐
  │ FaultInjectingDS   │  wraps
  │  · PRNG roll       │  ┌─ SyntheticDS ─┐
  │  · maybe fault     │──►│ or McpDS or  │
  │  · else delegate   │  │  BloomreachDS │
  └────────────────────┘  └───────────────┘
```

**One-line anchor.** "Decorator on the port; same interface; four
failure modes matching real live failures; receipts show 9 faults
/ 0 investigation failures."

### Q2 · "Why not just mock the DataSource with a jest.mock that returns errors?"

**Answer.** Mocks short-circuit code paths you want to test. If you
mock `callTool` to throw a 429, you're testing "does the caller
handle a thrown 429?" — which is a small slice. What you want to
test is: does the retry ladder inside `BloomreachDataSource`
correctly parse the retry-after, wait, retry, and eventually
succeed? Does the response cache correctly not cache the error?
Does the agent's re-planning logic correctly notice the eventual
success? A decorator preserves ALL of that code and just controls
WHICH inputs it sees. It's the difference between testing the
handler for a fault and testing the full path through the system
under fault conditions.

**One-line anchor.** "Mocks test the fault-handler in isolation;
decorators test the full path under fault conditions."

### Q3 · "What's the difference between fault injection and load testing?"

**Answer.** Different axes. Load testing (§06) measures the system
at increasing concurrency — how does p95 latency behave when K
workers pull from the queue at once? Fault injection measures the
system under failure — how many failures can the agents survive
before an investigation fails? You can compose them (the load
harness accepts fault-injection env vars and wraps the data source
when they're set). The combined run is what defends both stories:
under K=1 concurrency AND 40% fault rate, zero investigations
fail — that's the graceful degradation claim at load-shaped
input, not at synthetic ideal input.

**One-line anchor.** "Load = concurrency axis; fault = failure
axis; compose them for the real graceful-degradation number."

### Q4 · "What's the risk of the seed offset per investigation being additive?"

**Answer.** Correlation across investigations if the seed space is
small. With seed=42 and offsets 0, 1, 2, xorshift32 states 42, 43,
44 are close in state space, so the first few PRNG outputs might
be similar. For statistical faults at ~20% rate over ~10 calls per
investigation, this is invisible; for tighter distributions or
larger N it could correlate. The fix would be a better mixing —
`seed = hash(baseSeed, index)` instead of `seed = baseSeed + index`.
Named as a known bound rather than a bug; the current fault
distribution across investigations reads independent enough that
it hasn't mattered.

**One-line anchor.** "Additive offset can correlate near-adjacent
seeds; hash-based offset is the fix if it starts to matter."

## See also

- `06-load-harness-semaphore-concurrency.md` — the harness this
  decorator layers into.
- `02-spacing-gate-and-retry-ladder.md` — the retry ladder
  exercised by injected 429s.
- `01-route-budget-and-timeout-composition.md` — the tool
  timeout exercised by injected timeouts.
- `study-testing` — the eval framework this runs inside.
- `study-software-design` — the decorator pattern itself and
  the `DataSource` port stability across five uses.
