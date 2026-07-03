# Clocks, Coordination, and Leadership

*Industry name: monotonic vs wall-clock time · leases · leader election · Type: Industry standard*

## Zoom out — where this concept lives

Distributed leadership — leases, election, split-brain, quorum-based coordination — is **not yet exercised** in this repo. What IS exercised: local monotonic time (`Date.now()`, `performance.now()`) used to bound waits, TTLs, and phase timings. Naming that clearly matters more than pretending otherwise.

```
  Zoom out — where clocks appear (and where they don't)

  ┌─ Client band ──────────────────────────────────────────┐
  │  browser clock (untrusted; not used for coordination)   │
  └────────────────────────────────────────────────────────┘

  ┌─ Server band ──────────────────────────────────────────┐
  │  Date.now() → cache TTL, spacing gate, cookie MaxAge   │
  │  performance.now() → phase durations, load latency     │
  │  ★ THIS FILE: what these clocks bound, what they don't ★│
  │                                                         │
  │  NO leader, NO lease, NO election, NO coordination      │
  │  between Vercel instances                              │
  └────────────────────────────────────────────────────────┘

  ┌─ External band ────────────────────────────────────────┐
  │  MCP server's clock (opaque to us)                      │
  │  Anthropic's clock (opaque to us)                       │
  └────────────────────────────────────────────────────────┘
```

## Zoom in — narrow to the concept

Three clock uses matter here:

1. **`Date.now()` for wall-clock TTL** — the 60 s response cache, the 10-day auth cookie MaxAge. Wall clock is fine because both bounds are approximate.
2. **`Date.now()` for the spacing gate** — measures elapsed time within one instance to space calls at ≥ 1.1 s apart.
3. **`performance.now()` for phase durations** — the route logs each phase's wall-clock time.

None of these coordinate across nodes. That's the honest answer. Distributed leadership becomes relevant the moment there's shared mutable state, and this repo doesn't have any yet.

## Structure pass

### Layers — where clocks appear

- **McpDataSource** — `this.lastCallAt = Date.now()` for the spacing gate.
- **McpDataSource cache** — `expiresAt: now + ttl` for the 60 s TTL.
- **route.ts** — `performance.now()` for phase durations.
- **auth cookie** — `maxAge: AUTH_COOKIE_MAX_AGE` (10 days) — browser enforces expiry.
- **fault injector** — `Math.random()` or seeded xorshift32 (`fault-injecting.ts:167`) — not a clock, but named here because it's the only randomness source in the coordination story.

### One axis held constant — "does this clock coordinate across nodes?"

```
  Axis: does this clock cross an instance boundary?

  Date.now() in spacing gate      →  NO. per-instance elapsed only.
  Date.now() in cache expiresAt   →  NO. per-instance TTL.
  performance.now() phase timing  →  NO. logged locally only.
  auth cookie MaxAge (10 days)    →  YES, sort of. Browser enforces;
                                     server just checks decryption.
  MCP server response times       →  YES, but opaque. We just retry.
```

Only one clock crosses a node boundary — the browser's MaxAge enforcement on the auth cookie. And even that's an "expiration hint," not a distributed clock. There is no `HLC`, `NTP-corrected`, `TrueTime`-style clock in this repo.

### Seams

No coordination seams because there's no coordination. If leadership ever entered this codebase, the seam would be at the DataSource layer — one Vercel instance would need to claim exclusive rights to some resource. That doesn't happen today.

## How it works

### Move 1 — the mental model

You've written `setTimeout(fn, 1000)`. That's a clock use. You've written `if (Date.now() > entry.expiresAt) { entry = null; }`. That's a clock use too. **A clock isn't distributed unless two nodes read the same time and act on it together.** This repo has clocks; it doesn't have distributed clocks.

```
  The pattern — one instance, one clock, no coordination

  instance A     time flows: t=0  →  t=1s  →  t=2s  →  …
                     ↓          ↓        ↓
                spacing gate  cache TTL   phase log
                (own clock,  (own TTL,   (own timer,
                 no share)    no share)   no share)

  instance B     time flows: independently. never compared.
```

If leadership were needed, the pattern would be different: one instance holds a lease with a TTL, other instances see the lease in shared state and wait. That's `etcd`, `Zookeeper`, or Consul. Not here.

### Move 2 — the walkthrough

#### The spacing gate's clock

`bloomreach-data-source.ts:190`:

```ts
private async liveCall(name, args, signal?): Promise<unknown> {
  const elapsed = Date.now() - this.lastCallAt;
  if (elapsed < this.minIntervalMs) {
    await new Promise((r) => setTimeout(r, this.minIntervalMs - elapsed));
  }
  // ...
  this.lastCallAt = Date.now();
  // ...
}
```

Uses `Date.now()` (wall clock). Two properties:

- **Per-instance.** Each Vercel function instance has its own `lastCallAt`. Instance A calling at t=0 doesn't tell instance B not to call at t=100ms.
- **Wall clock jumps are irrelevant.** If NTP corrects the clock backward by 500 ms mid-call, `elapsed` could go negative, but the check `if (elapsed < this.minIntervalMs)` still triggers a wait. The spacing bound holds regardless.

**Why not `performance.now()` here?** Because `lastCallAt` needs to survive across `async` boundaries, and `performance.now()` doesn't add anything for a millisecond-precision bound. `Date.now()` is idiomatic.

**Failure mode this doesn't defend against**: two Vercel instances hitting Bloomreach at the same instant. Each spaces its own calls at 1.1 s, but the aggregate rate exceeds 1 req/s. That's the case the retry ladder catches. See file 02.

#### The cache TTL's clock

`bloomreach-data-source.ts:186`:

```ts
this.cache.set(cacheKey, { result, expiresAt: now + ttl });
// ... later:
if (cached && cached.expiresAt > Date.now()) {
  return { result: cached.result as T, durationMs: 0, fromCache: true };
}
```

Same wall clock. Same per-instance scope. Wall-clock skew doesn't matter because the ceiling is per-instance — no other node ever reads `entry.expiresAt`.

#### The auth cookie's MaxAge — the one cross-instance clock

`lib/mcp/auth.ts:49`:

```ts
const AUTH_COOKIE_MAX_AGE = 60 * 60 * 24 * 10; // 10 days
```

Set as a cookie attribute: `maxAge: AUTH_COOKIE_MAX_AGE`. The browser enforces expiry. The server never checks it directly — it only tries to decrypt whatever the browser sends. So the "clock" here is:

- **Browser's clock** — decides when to delete the cookie.
- **`AUTH_SECRET`** — decides whether the decrypted content is valid at all.

This is a soft expiry: a browser with a wrong clock could keep the cookie longer than 10 days, but the OAuth tokens inside would already be expired (Bloomreach enforces its own token lifetimes). The MaxAge is a hygiene bound, not a security bound.

```
  Auth cookie MaxAge — soft expiry

  browser clock                server clock
       │                            │
       │  cookie set at t=0         │
       │  MaxAge = 10 days          │
       │                            │
       │  browser deletes at t=10d  │
       │  IF its clock is right     │
       │                            │
       │  server gets cookie at any │  server just decrypts
       │  time within that window   │  → if valid, use
                                    │  → if expired token inside,
                                    │    OAuth flow re-runs
```

#### `performance.now()` for phase durations

`route.ts:220`:

```ts
const t0 = performance.now();
const phases: Array<{ phase: string; durationMs: number }> = [];
const recordPhase = (phase: string, started: number) => {
  phases.push({ phase, durationMs: Math.round(performance.now() - started) });
};
```

Monotonic clock. Used purely for observability (Vercel logs). No coordination. No TTL. No decision hinges on this timer other than "how long did phase X take?" which is what monotonic time is for.

#### The fault injector's PRNG — deterministic when seeded

`fault-injecting.ts:167`:

```ts
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

Not a clock, but named here because it's the closest thing to a coordination decision the repo makes. When `FAULT_SEED` is set, the fault sequence is deterministic and reproducible across runs. That's crucial for regression tests — chaos testing that isn't reproducible isn't testing, it's dice-rolling.

Load harness seeds each investigation from `(base + index)` so runs are deterministic yet unique per investigation. That's not coordination between nodes; it's coordination between test invocations.

### Move 3 — the principle

**Local monotonic time is enough when no state crosses instances.** The moment two nodes share mutable state that a timer bounds — a lease, a lock, a coordinated retry — you need distributed time (HLCs, TrueTime, or a coordinator). This repo doesn't need any of that, and pretending it does would misrepresent what's here. The `Date.now()` uses in the spacing gate and cache are local timers; the auth cookie MaxAge is a hygiene bound. That's the whole clock story until the app grows shared mutable state.

## Primary diagram

Every clock use, one frame:

```
  Every clock in the repo — where it appears, what it bounds

  ┌─ McpDataSource ────────────────────────────────────────┐
  │  this.lastCallAt = Date.now()                           │
  │    → spacing gate: sleep if elapsed < minIntervalMs     │
  │    → per-instance, wall clock                           │
  │                                                         │
  │  entry.expiresAt = Date.now() + ttl                     │
  │    → cache TTL check on next read                       │
  │    → per-instance, wall clock                           │
  └────────────────────────────────────────────────────────┘

  ┌─ SdkTransport ─────────────────────────────────────────┐
  │  AbortSignal.timeout(30_000)                            │
  │    → per-call timeout                                   │
  │    → composes with route signal                         │
  │    → node's internal timer (monotonic-ish)              │
  └────────────────────────────────────────────────────────┘

  ┌─ route.ts (per request) ───────────────────────────────┐
  │  performance.now() for phase durations                  │
  │    → logged in finally block, always                    │
  │    → monotonic, per instance                            │
  └────────────────────────────────────────────────────────┘

  ┌─ auth cookie ──────────────────────────────────────────┐
  │  maxAge: 60 * 60 * 24 * 10  (10 days)                   │
  │    → browser enforces expiry                            │
  │    → cross-instance IN THE SENSE that any instance can  │
  │      still decrypt a cookie the browser hasn't deleted  │
  │    → soft expiry (server never checks the MaxAge)       │
  └────────────────────────────────────────────────────────┘

  ┌─ FaultInjectingDataSource ─────────────────────────────┐
  │  xorshift32(seed) — deterministic when seeded           │
  │    → reproducible fault sequences for regression tests  │
  │    → NOT a clock; a coordination substitute for tests   │
  └────────────────────────────────────────────────────────┘

  ★ NO LEADER, NO LEASE, NO CROSS-NODE CLOCK ★
```

## Elaborate

The literature has three families of distributed clocks:

1. **Physical clocks** — NTP-synchronized wall time. Correct-ish, but subject to drift and skew.
2. **Logical clocks** — Lamport timestamps, vector clocks. Order events causally without wall time.
3. **Hybrid** — HLCs (Hybrid Logical Clocks), Google's TrueTime. Combine physical + logical for bounded-uncertainty ordering.

None of these appear here. If the app grew a scheduled monitoring job that ran every N minutes across multiple instances, a leader election would keep two instances from running the same job — that's `etcd`-style leadership with lease TTLs. Not needed today.

**Leases and split-brain**: a lease is a lock with a TTL. If the leaseholder dies without releasing, the lease expires and another instance can claim it. Split-brain is when two instances *both* think they hold the lease — usually because a clock skew or a network partition confuses the coordinator. Zookeeper, etcd, Consul all solve this with quorum-based coordination. Again, not here.

**Where this becomes relevant**: the first background job. Say the app grew a nightly monitoring task that ran across all users. If two Vercel cron triggers fired at once (rare, but possible), a lease-based coordinator would ensure only one ran. That's the moment leader-election vocabulary earns its complexity.

## Interview defense

**Q: "Where does time show up in your system?"**

A: Three places. `Date.now()` bounds the 60 s response cache and the ~1.1 s spacing gate — both per-instance, wall-clock. `performance.now()` measures phase durations for observability. `AbortSignal.timeout(30_000)` in the transport bounds a single MCP call. None of these coordinate across nodes.

```
   spacing gate     Date.now()       per-instance
   cache TTL        Date.now()       per-instance
   phase durations  performance.now()per-instance, monotonic
   per-call timeout AbortSignal      per-instance timer
   cookie MaxAge    browser          soft; browser enforces
```

**Q: "Do you have any distributed time?"**

A: No. There's no leader election, no lease, no coordinator. The auth cookie MaxAge is the closest thing — any Vercel instance can decrypt a cookie the browser still holds — but that's a soft hygiene bound, not a coordinated clock. If the app grew shared mutable state, that's when I'd reach for HLCs or a coordinator like etcd.

**Q: "How would you add background jobs safely?"**

A: The moment I need a scheduled job that runs across users, I'd add a distributed lease. Vercel Cron plus a Redis-backed lease (or a Postgres `SELECT FOR UPDATE` lock with a TTL) — one worker claims the lease with a bounded expiry, does the work, releases. If the worker dies mid-flight, the lease expires and another worker picks it up. That's the shape leader election takes at the small scale I'd need first.

## See also

- `02-partial-failure-timeouts-and-retries.md` — where `AbortSignal.timeout` composes with `req.signal`.
- `04-consistency-models-and-staleness.md` — where `Date.now()` bounds cache staleness.
- `05-replication-partitioning-and-quorums.md` — the shared-state precondition for coordination.
