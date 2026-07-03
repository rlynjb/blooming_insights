# FaultInjectingDataSource — decorator over the port

Decorator pattern · Industry standard

## Zoom out — where this concept lives

You know how `useMemo` wraps a computation to add caching without
changing what the computation does? Same shape. A decorator wraps
a `DataSource` to add faults — the wrapped adapter is untouched,
the interface is unchanged, but every `callTool` now has a
configurable probability of failing in one of four documented ways.

```
  Zoom out — the decorator sits between client and adapter

  ┌─ Client layer (agents) ──────────────────────────────┐
  │  DiagnosticAgent · RecommendationAgent               │
  └────────────────────────┬─────────────────────────────┘
                           │  holds: DataSource (port)
  ┌─ Decorator ────────────▼─────────────────────────────┐
  │  ★ FaultInjectingDataSource ★                        │ ← you are here
  │     implements DataSource                             │
  │     wraps: another DataSource                         │
  └────────────────────────┬─────────────────────────────┘
                           │  passes through when no fault fires
  ┌─ Inner adapter ────────▼─────────────────────────────┐
  │  SyntheticDataSource  (or Bloomreach, or another     │
  │                        decorator — the type doesn't  │
  │                        care)                          │
  └──────────────────────────────────────────────────────┘
```

The decorator satisfies the same port as the thing it wraps, so
from the client's view it *is* the port. That's why decoration is
composition, not inheritance.

## Structure pass

**Layers.** Two, but the decorator makes it look like three. The
`DataSource` port is the same shape on both sides of the
decorator — same two methods, same envelope.

**Axis: failure.** Where does a call fail? Above the decorator,
never — the port doesn't say anything about faults. Inside the
decorator, sometimes — configurable probability. Below the
decorator, the inner adapter behaves normally on every non-fault
call. The axis-answer flips at the decorator's `callTool`: the
failure surface exists there and nowhere else.

**Seams.** One seam, twice. The `DataSource` port serves as both
the *upper* seam (agent → decorator) and the *lower* seam
(decorator → inner adapter). Same interface, two boundaries.
That's the decorator's defining property.

## How it works

### Move 1 — the mental model

The pattern is *decorator* (Gang of Four). Three roles:

```
  Decorator — component + wrapper, same interface

     ┌──────────────┐
     │    client    │  depends on ─────────┐
     │  (an agent)  │                       ▼
     └──────────────┘             ┌──────────────────┐
                                  │    component     │  ← the shape
                                  │  (DataSource     │     everyone
                                  │   interface)     │     satisfies
                                  └───────┬──────────┘
                                          │
                             satisfied by │ satisfied by
                                          │
                     ┌────────────────────┼──────────────────┐
                     ▼                    ▼                  ▼
             ┌─────────────┐      ┌─────────────┐    ┌───────────────┐
             │ Synthetic   │      │ Bloomreach  │    │   wrapper     │
             │ (concrete)  │      │ (concrete)  │    │ (decorator —  │
             └─────────────┘      └─────────────┘    │  FaultInject  │
                                                     └───────┬───────┘
                                                             │ wraps
                                                             ▼
                                                     ┌───────────────┐
                                                     │  inner: any   │
                                                     │  component    │
                                                     │  (Synthetic,  │
                                                     │  Bloomreach,  │
                                                     │  or another   │
                                                     │  decorator)   │
                                                     └───────────────┘
```

- **component** — the interface. `DataSource` (`types.ts:63`).
- **wrapper** — a class that implements the interface *and* holds
  an instance of the interface. `FaultInjectingDataSource`.
- **delegate** — the wrapped instance. Called `inner` in the
  wrapper.

The recognition test: a decorator's interface is exactly the
component's interface — no wider, no narrower. If the wrapper
adds new methods that clients call, it's not a decorator; it's a
subclass or a facade.

### Move 2 — the walkthrough

**The constructor — component + wrapper.**

```typescript
// lib/data-source/fault-injecting.ts:59-68
export class FaultInjectingDataSource implements DataSource {
  private callIndex = 0;
  private prngState: number;

  constructor(
    private readonly inner: DataSource,          // ← the delegate
    private readonly options: FaultInjectorOptions,
  ) {
    this.prngState = options.seed ?? 0;
  }
```

Annotation:
- Line 59 — `implements DataSource`. The wrapper satisfies the
  same port as the thing it wraps. This is the decorator's
  defining constraint.
- Line 64 — `inner: DataSource`. Not `SyntheticDataSource`, not
  a specific adapter — the port itself. That's how the wrapper
  composes with anything, including other decorators.
- Line 60-61 — private state. Call index for the `onFault`
  callback, PRNG state for deterministic sequences.

**The wrapped method — same signature as the port.**

```typescript
// lib/data-source/fault-injecting.ts:70-104
async callTool(
  name: string,
  args: Record<string, unknown>,
  opts?: DataSourceCallOptions,
): Promise<DataSourceCallResult> {
  this.callIndex += 1;

  const roll = this.random();          // one PRNG roll per call
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
}
```

Annotation:
- Line 70-74 — same signature as `DataSource.callTool`. Character-
  for-character. The wrapper is type-compatible with the port.
- Line 82 — one PRNG roll per call. Comparing that roll against
  the *cumulative* threshold means at most one fault fires per
  call (severity-ordered: timeout > rate_limit > server_error >
  malformed_json).
- Line 103 — the passthrough. When no fault fires, the call
  goes to `this.inner.callTool(...)` verbatim. Args unchanged,
  opts unchanged, envelope unchanged. This is the load-bearing
  line — without it, the decorator would be a mock instead.

**The unmodified method — `listTools` passes through.**

```typescript
// lib/data-source/fault-injecting.ts:106-110
listTools(opts?: DataSourceListOptions): Promise<unknown> {
  // Faults are only injected on callTool. listTools stays clean so the
  // agent's bootstrap phase isn't a randomly-failing path.
  return this.inner.listTools(opts);
}
```

Annotation: a pure passthrough. The comment names why — the
bootstrap phase (agents listing tools at startup) is not the
target of the fault-injection story. A decorator can be selective
about which methods it decorates.

**The failure modes — four shapes.**

```typescript
// lib/data-source/fault-injecting.ts:112-155 (abridged)
private fireTimeout(toolName: string): never {
  this.options.onFault?.({ kind: 'timeout', toolName, callIndex: this.callIndex });
  throw new Error(`HTTP 0: timeout after 30000ms`, {
    cause: new Error('injected fault: timeout'),
  });
}

private fireRateLimit(toolName: string): never {
  this.options.onFault?.({ kind: 'rate_limit', ... });
  const err = new Error(`Rate limited: please retry after 2000ms`, ...);
  (err as Error & { status?: number }).status = 429;
  throw err;
}

// server_error — same shape, 500 status

private async fireMalformedJson(toolName: string): Promise<DataSourceCallResult> {
  this.options.onFault?.({ kind: 'malformed_json', ... });
  return {
    result: {
      isError: false,
      content: [{ type: 'text', text: '{"broken":"unclosed' }],
      structuredContent: undefined,
    },
    durationMs: 42,
    fromCache: false,
  };
}
```

Annotation:
- Three of four modes *throw* (`: never` return type). One returns
  a malformed envelope. That asymmetry is deliberate — timeouts,
  rate limits, and server errors are transport-level failures the
  agents' `catch` blocks catch; malformed JSON is a *shape*
  failure the agents' type-guards catch. Different failure
  surfaces, different agent paths.
- Every mode fires `onFault` first so the load harness can count
  faults (`eval/load.eval.ts:256-258`) before the throw.
- The messages mimic the actual Bloomreach shapes
  (`HTTP 0: timeout after 30000ms` matches `lib/mcp/transport.ts:137`
  verbatim; the 429 shape matches Bloomreach's retry ladder
  trigger). That mimicry is what makes the injector *equivalent*
  to real fault conditions rather than a mock.

**How it composes — the load harness wraps Synthetic.**

```typescript
// eval/load.eval.ts:246-260
const baseDataSource = new SyntheticDataSource();
const faultCounts: Record<string, number> = {};
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

Annotation:
- Line 246 — inner adapter.
- Line 249-259 — the wrap. Notice the return type: `dataSource` is
  either the wrapper or the base, and both branches type as
  `DataSource`. The agents downstream don't need to know which.
- Line 250-251 — seed is `index + FAULT_SEED` per investigation,
  so each of the N load investigations gets a reproducible-but-
  unique fault sequence.

**Deterministic PRNG — xorshift32 when seeded.**

```typescript
// lib/data-source/fault-injecting.ts:157-166
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

Annotation: without a seed, `Math.random()`. With a seed,
xorshift32 — cheap, deterministic, good enough for probability
rolls. This is why fault runs are reproducible under CI and
usable in regression tests.

### Move 3 — the principle

**A decorator is a wrapper that preserves the interface exactly.**
Every method signature matches; every method either passes
through or performs its added job and returns the same envelope
shape. Decorators compose (you can wrap a decorator with another
decorator), which subclasses can't safely do. When the same seam
already exists (here, `DataSource`), adding behavior by decoration
is almost always cheaper than adding a config flag to the inner
class or adding a subclass.

## Primary diagram

```
  FaultInjectingDataSource — component + wrapper, same shape

  ┌─ agent (client) ─────────────────────────────────────────┐
  │  dataSource.callTool('execute_analytics_eql', args)      │
  └────────────────────────┬────────────────────────────────┘
                           │  DataSource type
                           ▼
  ┌─ FaultInjectingDataSource (wrapper) ────────────────────┐
  │  callTool(name, args, opts):                             │
  │    ┌──────────────────────────┐                          │
  │    │  roll = random()         │                          │
  │    │  check thresholds:       │                          │
  │    │   ┌ roll < timeout    → throw HTTP 0 timeout        │
  │    │   ├ roll < rateLimit  → throw 429                   │
  │    │   ├ roll < serverErr  → throw 500                   │
  │    │   └ roll < malformed  → return { garbled envelope } │
  │    │  none fired?           → PASSTHROUGH                │
  │    └──────────────────────────┘                          │
  │  listTools(opts):     PASSTHROUGH (never decorated)      │
  └────────────────────────┬────────────────────────────────┘
                           │  DataSource type (same shape)
                           ▼
  ┌─ inner: any DataSource ─────────────────────────────────┐
  │  SyntheticDataSource · BloomreachDataSource · another   │
  │  FaultInjectingDataSource · ...                         │
  └─────────────────────────────────────────────────────────┘

  key property: interface(wrapper) === interface(inner). so
  the client can't tell whether it's calling a wrapped or an
  unwrapped adapter.
```

## Elaborate

The pattern is *decorator* from Gang of Four (1994). The
canonical opening example is Java's `BufferedInputStream` wrapping
`FileInputStream` — both are `InputStream`, so any code that
reads from an `InputStream` benefits from the buffering without
noticing. Same shape here: any code that calls `DataSource`
methods benefits from the fault injection without noticing.

Why decoration beats a config flag: adding `enableFaults` to
`SyntheticDataSource` would leak the concern into the inner class,
grow its state, and force the concern to be shipped in production
code. Decorating keeps `SyntheticDataSource` clean and puts the
concern in a file that's imported only by `eval/load.eval.ts` and
tests.

Why it beats a subclass: `FaultInjectingSyntheticDataSource
extends SyntheticDataSource` would only work with one inner
adapter. To fault-inject Bloomreach, you'd need a second subclass.
The decorator wraps *any* `DataSource`, including its own future
peers.

Where the pattern shows up elsewhere: middleware in web
frameworks (each middleware wraps the next handler, same
`(req, res) => void` shape). React higher-order components
(same `Component` interface). Retry wrappers, cache wrappers,
telemetry wrappers — every one of them is this pattern.

## Interview defense

**Q: How is this different from a mock?**
A mock replaces the inner behavior entirely — you assert on
what the mock was called with, and it returns whatever you told
it to. The fault injector *passes through* when no fault fires,
so the agent path exercises the real synthetic adapter's real
responses most of the time. The whole point is to test the
graceful-degradation path *interleaved with* successful calls,
which a mock can't do.

**Q: Why not just add a flag to `SyntheticDataSource`?**
Three reasons. First, the fault story is orthogonal to synthetic-
vs-Bloomreach — you want to inject faults into either, and a
decorator does both. Second, it puts test-only concerns in
production code. Third, subclassing / flag-carrying doesn't
compose — you can wrap a decorator with another decorator, but
you can't stack flags.

**Q: What's the load-bearing part people forget?**
The `implements DataSource` on line 59. Without it, TypeScript
would still accept the class at the two call sites (structural
typing), but the *contract* wouldn't be enforced. If someone
added a third method to `DataSource` later, the compiler wouldn't
catch that the decorator missed it. The explicit `implements`
turns the port into an obligation, not a suggestion.

Second load-bearing part: the passthrough line
(`fault-injecting.ts:103`). Without it, the decorator becomes a
mock — no calls ever reach the inner adapter, no real behavior is
exercised. That's why the pattern requires the wrapper to hold a
delegate and dispatch to it on the no-op path.

**Q: What about composition — could you stack two?**
Yes. `new FaultInjectingDataSource(new FaultInjectingDataSource(inner, ...), ...)`
type-checks and would compound the failure probabilities. The
`inner: DataSource` type is what allows this — if the constructor
took `inner: SyntheticDataSource`, stacking would break. The
repo doesn't currently stack, but the composition property is
free.

## See also

- `01-datasource-port.md` — the port this decorator satisfies.
- `04-optional-hooks.md` — how the `onFault` callback fits the
  same additive-hook pattern this codebase uses across seams.
- `.aipe/read-aposd/` — the book chapter on modules and interfaces.
