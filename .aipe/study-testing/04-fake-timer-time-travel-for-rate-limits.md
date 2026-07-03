# 04 — Fake Timer Time-Travel for Rate Limits

**Industry name:** *virtual clock* / *fake timer* pattern (Sinon
"useFakeTimers", Jest / Vitest "useFakeTimers").
**Type:** Industry-standard testing pattern.
**Determinism side:** DETERMINISTIC. The whole point is to remove
wall-clock time from the assertion — a rate-limit test must complete
in milliseconds, not the 10-second window it's asserting on.

═════════════════════════════════════════════════
Zoom out — where this pattern sits
═════════════════════════════════════════════════

The MCP client's job is to keep the Bloomreach alpha server happy
under a ~1 req/s rate limit. It does that with three time-sensitive
mechanisms: **cache TTL** (skip a duplicate call if we asked recently),
**minimum interval** (space consecutive calls by ≥N ms), and
**retry-after backoff** (when the server 429s, wait the parsed window
before retrying). Every one of these depends on `Date.now()` and
`setTimeout`.

```
  Zoom out — the time-sensitive surfaces

  ┌─ MCP client (lib/mcp/client.ts) ────────────────────────────┐
  │                                                              │
  │  callTool(name, args):                                       │
  │      cache hit?  ─── depends on Date.now() vs cacheTtlMs     │
  │      minimum interval enforced ─── setTimeout(minIntervalMs) │
  │      transport call ─── if 429: retry with parsed window     │
  │                          setTimeout(parsedRetryAfter or base)│
  │                                                              │
  │  Every branch above touches time.                            │
  └──────────────────────────────────────┬───────────────────────┘
                                         │
                              ┌──────────▼──────────┐
                              │ ★ THIS PATTERN ★    │  ← swap the clock
                              │  vi.useFakeTimers   │
                              └──────────┬──────────┘
                                         │
                                    real setTimeout
                                    real Date.now
```

Testing this surface honestly means testing across 10-second
windows. Without fake timers, the suite would take longer than the
integration budget allows and blow past CI timeouts.

═════════════════════════════════════════════════
Structure pass — layers · axes · seams
═════════════════════════════════════════════════

**Layers:**
- test (calls `vi.useFakeTimers()`, then drives the clock)
- Vitest's fake clock (in-memory replacement for `Date.now` +
  `setTimeout` + `setInterval`)
- `McpClient` (real production code, unaware the clock is fake)
- transport fake (returns 429 or ok; used by `McpClient`)

**Axis held constant — lifecycle:** when does each thing happen?
- test (setup): swaps the clock
- test (assertions): explicitly advances the clock via
  `advanceTimersByTimeAsync(N)`
- `McpClient`: schedules and waits on timers exactly as in prod
- fake clock: fires callbacks when N ms of virtual time have passed

The lifecycle axis is the right lens here because the whole pattern
lives in the "when" dimension. Which one is "now" is a decision the
test makes on every line.

**Seam:** the platform globals — `setTimeout`, `Date`, `setInterval`.
`vi.useFakeTimers()` swaps them for in-memory equivalents; `vi.useRealTimers()`
restores them.

═════════════════════════════════════════════════
How it works
═════════════════════════════════════════════════

#### Move 1 — the mental model

You've seen React's `act(...)` wrapper — it lets your test tell React
"flush all pending updates now" instead of waiting for the scheduler.
Fake timers are the same idea for `setTimeout`. Instead of waiting 10
seconds of wall-clock time to see what happens after a
`setTimeout(fn, 10_000)`, you tell Vitest "advance the virtual clock
by 10 seconds now" and the callback fires immediately.

```
  The virtual clock — visualized

  wall clock:  t=0 ─────── t=200ms ──────── t=10s ────── t=10.2s

  what production would do:
    call1 fires  →  minIntervalMs=200 wait  →  call2 fires
                                                    ↓
                                                (429 with 10s retry-after)
                                                    ↓
                                                setTimeout(10_000)
                                                    ↓
                                                call3 fires
                                                    ↓
                                                (200 ok)

  what the test does (virtual clock):
    call1 fires  →  await advanceTimersByTimeAsync(199)
                    → done stays false (still under 200 floor)
                    → await advanceTimersByTimeAsync(1)
                    → done becomes true (200ms floor cleared)
                                                    ↓
                    call2 fires  →  transport returns 429
                                                    ↓
                    await runAllTimersAsync()
                    → the client's 10s retry-after timer fires
                    → call3 fires, returns ok

  total wall time: milliseconds.
```

Kernel — three moving parts:

- **`vi.useFakeTimers()` swap** — installed at test start; MUST be
  paired with `vi.useRealTimers()` at test end (or `afterEach`)
- **explicit advance** — `await
  vi.advanceTimersByTimeAsync(N)` or `await vi.runAllTimersAsync()`.
  The `async` variants are critical because production timers usually
  wrap Promises; the sync variants (`advanceTimersByTime`) don't
  flush the Promise microtask queue and leave `.then()` handlers
  pending
- **the `Date.now()` synchronization** — Vitest's fake clock ALSO
  patches `Date.now()`, so the `now - cachedAt` comparisons inside
  `McpClient` see the virtual time

Drop any of these:
- No fake timer swap → the test waits real time; CI hits its
  minute budget on a single rate-limit assertion
- No async advance → the code under test's `.then()` never fires;
  the test hangs
- No `Date.now()` patch → cache-TTL logic behaves like it did at
  test start; window-parsed retries never fire

#### Move 2 — the walkthrough

**Case 1 — the cache TTL test (simplest).**

Wire the timer, exhaust the TTL, prove the cache expired:

```
  Location: test/mcp/client.test.ts:49-58

  it('expires cache after ttl', async () => {
    vi.useFakeTimers();
    const t = fakeTransport(() => ({ ok: 1 }));
    const c = new McpClient(t);
    await c.callTool('whoami', {}, { cacheTtlMs: 1000 });
    vi.advanceTimersByTime(1001);                    // ← past the TTL
    await c.callTool('whoami', {}, { cacheTtlMs: 1000 });
    expect(t.calls).toBe(2);                          // ← hit twice
    vi.useRealTimers();
  });
```

Two `callTool` invocations, 1001ms of virtual time between them, the
transport was hit twice. Compare against the cache-hit test just
above it (`client.test.ts:24-31`) — same setup, no advance, so the
second call served from cache and the transport was hit once. Same
production code, different clock behavior.

Note the sync `vi.advanceTimersByTime` here (no `async`). This works
because the assertion is on side-effect count (`t.calls`), not on
Promise resolution — no `.then()` needs to have fired between the
advance and the assertion.

**Case 2 — the minimum-interval enforcement test (subtle).**

This one has to check the state BEFORE and AFTER the floor is
cleared. It uses a "pending-flag" pattern:

```
  Location: test/mcp/client.test.ts:60-78

  it('rate limits to minIntervalMs between live calls', async () => {
    vi.useFakeTimers();
    const t = fakeTransport((n) => ({ n }));
    const c = new McpClient(t, { minIntervalMs: 200 });
    const p1 = c.callTool('a', {});
    await vi.runAllTimersAsync();
    await p1;

    const start = Date.now();
    const p2 = c.callTool('b', {});
    await vi.advanceTimersByTimeAsync(199);          // ← 1ms shy of floor
    let done = false;
    p2.then(() => { done = true; });
    await Promise.resolve();                          // ← flush microtasks
    expect(done).toBe(false);                         // ← still waiting

    await vi.advanceTimersByTimeAsync(1);              // ← cross the floor
    await p2;
    expect(Date.now() - start).toBeGreaterThanOrEqual(200);
    vi.useRealTimers();
  });
```

Three moves to notice:
- `await vi.runAllTimersAsync()` before `await p1` — flushes any
  pending Promises so the first call has fully resolved before the
  second starts (otherwise the second call's timer wouldn't have a
  clean "now" to schedule against)
- `p2.then(() => { done = true; }) + await Promise.resolve()` — a
  minimal microtask flush that lets `.then()` fire IF the promise
  already resolved. If it didn't, `done` stays false — proving the
  floor is still in effect
- `Date.now() - start >= 200` — the assertion uses the fake clock's
  `Date.now`. The check reads virtual milliseconds, but the shape
  matches what a real-clock assertion would look like

**Case 3 — the retry-after parsing test (the star).**

This is the test that pins production behavior against a real
Bloomreach error message. The transport returns a 429-shaped result
whose text says `"(1 per 10 second)"`; the client is expected to
parse "10 seconds" out of it and wait accordingly:

```
  Location: test/mcp/client.test.ts:111-140

  it('waits the parsed retry-after window for "(1 per 10 second)", ...',
    async () => {
      vi.useFakeTimers();
      let n = 0;
      let firstFailAt = 0;
      let retryAt = 0;
      const t: McpTransport = {
        async callTool() {
          n++;
          if (n === 1) {
            firstFailAt = Date.now();
            return { isError: true, content: [{ type: 'text',
              text: 'Too many requests: rate limit reached (1 per 10 second)'
            }]};
          }
          retryAt = Date.now();
          return { isError: false, ok: true };
        },
        async listTools() { return { tools: [] }; },
      };
      const c = new McpClient(t, { minIntervalMs: 0 });  // no interval floor
      const p = c.callTool('x', {});
      await vi.runAllTimersAsync();                       // ← blast through
      const r = await p;
      expect((r.result as any).ok).toBe(true);
      expect(n).toBe(2);
      expect(retryAt - firstFailAt).toBeGreaterThanOrEqual(10_000);
      // A rate-limited-then-successful call CACHES its success:
      const r2 = await c.callTool('x', {});
      expect(r2.fromCache).toBe(true);
      vi.useRealTimers();
  });
```

`runAllTimersAsync()` is the "advance until nothing is pending" hammer
— it flushes every scheduled timer, including chains where callback A
schedules callback B. That's what turns a 10-second retry into an
instant test.

The assertion `retryAt - firstFailAt >= 10_000` is the pin: the
production code parsed "10 second" out of the message and waited
accordingly. If the parser regressed (e.g. defaulted to 1200ms base),
this assertion would fail loudly.

#### Move 2 variant — the load-bearing skeleton

Kernel: **swap + advance + restore.**

- Swap: `vi.useFakeTimers()` at test start.
- Advance: `advanceTimersByTimeAsync(N)` for a specific window,
  `runAllTimersAsync()` for "everything pending."
- Restore: `vi.useRealTimers()` at test end.

Drop any:
- No swap → runs on wall-clock; CI budget explodes
- No advance → nothing happens; test hangs on the awaited promise
- No restore → the next test in the same worker inherits fake timers;
  if it does `await new Promise(r => setTimeout(r, 100))` it hangs

Hardening: pin `Date.now()` deltas as evidence (not just event
count), assert the *cache-after-retry* behavior, use `minIntervalMs:
0` to isolate the retry-after logic from the interval floor.

#### Move 3 — the principle

Time is a dependency like any other; treat it as one. Any test that
would otherwise wait wall-clock time to make its assertion is testing
the world's clock, not your code. Swap the clock at the platform
seam, drive it explicitly, restore it after — same kernel as
patterns 01 and 02, applied to the `Date.now()` + `setTimeout`
boundary.

═════════════════════════════════════════════════
Primary diagram
═════════════════════════════════════════════════

The retry-after flow with virtual time.

```
  Retry-after test — virtual clock advance flow

  test start          call1               call2 (retry)          test end
  t_virt=0            t_virt=0            t_virt≥10s

  vi.useFakeTimers()
     │
     ▼
  new McpClient(fakeTransport, { minIntervalMs: 0 })
     │
     ▼
  const p = c.callTool('x', {})   ── production code runs
     │                              (queues transport call,
     │                               awaits fake timers)
     │
     ├── transport returns 429 with "(1 per 10 second)"
     │       │
     │       ▼
     │   McpClient parses "10 second"
     │       │
     │       ▼
     │   McpClient schedules setTimeout(fn, 10_000)  ← FAKE timer
     │       │
     ▼       ▼
  await runAllTimersAsync()   ── "advance until no pending timers"
                                 │
                                 ▼
                          fake clock jumps to t=10s
                                 │
                                 ▼
                          setTimeout callback fires immediately
                                 │
                                 ▼
                          transport called again → returns ok
                                 │
                                 ▼
                          promise p resolves
     │
     ▼
  await p → { result: { ok: true } }
  assert retryAt - firstFailAt >= 10_000 (virtual ms)
     │
     ▼
  vi.useRealTimers()   ← restore, so next test starts clean
```

═════════════════════════════════════════════════
Elaborate
═════════════════════════════════════════════════

The virtual-clock pattern predates JS testing tooling — Sinon shipped
it in 2010, borrowed from Ruby's `Timecop` and Java's Joda-Time
mocking. The Vitest / Jest API is basically the Sinon interface with
`async` variants added for Promise-timer interactions (which didn't
exist when Sinon first shipped).

The `async` variants matter because most modern time-dependent code
wraps `setTimeout` in a Promise:

```
  Common wrapper                       async advance needed?
  ─────────────────────────────        ──────────────────────
  setTimeout(cb, N)                    no (sync advance flushes)
  await new Promise(r =>               yes — the Promise's .then()
    setTimeout(r, N))                    only runs on microtask flush
  Promise-chained retry                 yes — every setTimeout in the
                                          chain needs to fire + flush
```

`McpClient`'s retry ladder is the third shape — a Promise chain
where each retry's `setTimeout` schedules the next attempt. That's
why the tests reach for `runAllTimersAsync()` instead of
`advanceTimersByTime(20_000)` — the latter would fire the first
retry's timer but not the microtask that queues the second retry's
timer, so the chain stalls.

The pattern's cost is real: fake timers change the shape of *every*
timer call in the test, including any inside libraries you didn't
mean to affect. If a test uses fake timers AND a real-timer library
(one that expects wall-clock semantics), you get subtle stalls. The
discipline of `vi.useRealTimers()` in `afterEach` (or at test end)
keeps this contained.

Cross-links:
- Pattern 03 uses this pattern for the transport tests'
  `'timeout'` scenario — the test uses `vi.useFakeTimers()` +
  `AbortSignal.timeout` to prove the transport's per-call timeout
  fires within its 30s budget without actually waiting 30s
- `study-networking`'s timeout / retry / backoff patterns explain
  the production behavior these tests exercise

═════════════════════════════════════════════════
Interview defense
═════════════════════════════════════════════════

**Q: How do you test a 10-second retry-after backoff without
slowing your CI?**

Answer: Swap the platform clock. `vi.useFakeTimers()` at test start
replaces `setTimeout` and `Date.now` with in-memory equivalents. You
call the production code, and instead of waiting 10 real seconds you
`await vi.runAllTimersAsync()` — the fake clock jumps forward until
no timers are pending, callbacks fire immediately, the retry happens
instantly. Assertions on the elapsed time still hold because
`Date.now()` reads the virtual clock. Restore with
`vi.useRealTimers()` so the next test isn't polluted.

Anchor: `test/mcp/client.test.ts:111-140` — the parsed
"(1 per 10 second)" retry-after test.

Diagram sketch:

```
  useFakeTimers()  →  callTool() → 429 with "10 second" hint
                                   → McpClient schedules setTimeout(fn, 10_000)
  runAllTimersAsync()  →  fake clock jumps to t=10s → callback fires
                                                    → transport retry → ok
```

**Q: Why `runAllTimersAsync` instead of `advanceTimersByTime(20_000)`?**

Answer: Because the retry chain is `setTimeout → Promise.then →
setTimeout`. `advanceTimersByTime` fires the first `setTimeout` but
doesn't flush the microtask that queues the second `setTimeout` —
the chain stalls halfway. `runAllTimersAsync` alternates advancing
and flushing until nothing is pending. When the code under test is
Promise-heavy (like retry ladders), `runAllTimersAsync` is safer.

**Q: What happens if you forget `useRealTimers()`?**

Answer: The next test in the same worker inherits the fake clock.
If it uses `await new Promise(r => setTimeout(r, 100))` expecting real
time, it hangs — the fake clock hasn't been advanced, so the
`setTimeout` callback never fires. The test times out with a
confusing "test exceeded 5000ms" error 3 tests later. The safe
pattern is `afterEach(() => vi.useRealTimers())` at file scope.

═════════════════════════════════════════════════
See also
═════════════════════════════════════════════════

- `01-scripted-anthropic-fake.md` — the same "swap a
  non-deterministic dependency" discipline at the LLM boundary
- `03-http-transport-mock-with-module-hoisting.md` — combined with
  this for the transport's `'timeout'` scenario
- `audit.md` lens 4 — the determinism discipline this pattern
  proves
- `study-networking` — the production timeout / retry / backoff
  patterns these tests exercise
