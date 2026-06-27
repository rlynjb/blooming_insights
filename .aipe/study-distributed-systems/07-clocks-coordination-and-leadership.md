# 07 — clocks, coordination, leadership

**Industry name(s):** clock skew · happens-before · logical clocks (Lamport, vector) · leases · leader election · split-brain
**Type:** Industry standard · Language-agnostic

> **Verdict-first: NOT YET EXERCISED at the distributed level.** blooming insights uses `Date.now()` in five places — `BloomreachDataSource` cache TTLs, `BloomreachDataSource` spacing tracker, `OlistDataSource.callTool` for `durationMs`, `useInvestigation` UI timestamps, and `Insight.timestamp` ISO strings — and **every one of those is within a single process**. No two processes compare clock values; no logical-clock protocol exists; no lease is acquired; no leader is elected. The classical distributed-systems clock concerns (skew between nodes, happens-before across processes, split-brain when two nodes both think they're leader) do not apply because the boxes whose clocks would need to agree don't exist. The most consequential clock fact in the codebase: **`Insight.timestamp` is generated server-side per-instance**, so two instances generating insights for the same anomaly stamp them at slightly different wall-clock times — currently invisible because each instance overwrites the other (`putInsights` clears first), but it would become a real ordering question if insights were ever merged across instances.

---

## Zoom out, then zoom in

```
  Zoom out — clocks in this codebase

  ┌─ UI layer ──────────────────────────────────────────────┐
  │  ts: Date.now() on TraceItem  ◄── per-tab, single clock │
  │  no cross-tab ordering                                   │
  └─────────────────────────┬───────────────────────────────┘
                            │
  ┌─ Service layer ─────────▼───────────────────────────────┐
  │  McpClient cache: now > expiresAt        ◄── single process│
  │  McpClient spacing: now - lastCallAt     ◄── single process│
  │  Insight.timestamp = new Date().toISOString()             │
  │  ★ all within ONE process — no cross-process compare ★    │ ← we are here
  └─────────────────────────┬───────────────────────────────┘
                            │
  ┌─ Provider layer ────────▼───────────────────────────────┐
  │  Bloomreach event timestamps (their clocks; opaque to us)│
  │  Anthropic response timing (their clocks; opaque to us)  │
  └──────────────────────────────────────────────────────────┘
```

**Zoom in.** The question this file answers: *do any two processes in this system need to agree on what time it is?* The answer is no — every wall-clock reading is consumed inside the same process that took it. No process compares its clock to another's. No process waits for a lease to expire on a different process's clock. No process holds a leadership role that depends on heartbeat timing. This file walks the concepts so they're in your vocabulary, points at the four `Date.now()` callsites and confirms each one's safety, and names the future feature that would force this topic to become real.

---

## Structure pass

**Layers.** Three. UI (one tab's clock, used for timestamping `TraceItem`s for display order). Service (one process's clock, used for cache TTL and rate-limit spacing). Provider (their clock, opaque to us — we just store the ISO string they send).

**Axis: same-clock vs cross-clock comparison.** Hold one question: *is this clock reading ever compared to a reading from a different clock?* In this codebase, the answer for every callsite is **no**. `Date.now()` for cache TTL is compared to a `Date.now()` taken later in the same process. `Date.now()` for `lastCallAt` is compared to a `Date.now()` taken later in the same process. `Date.now()` for `TraceItem.ts` is used to display events in arrival order in the same tab. Cross-clock comparison doesn't happen. Skew doesn't matter.

**Seams.** One real, one absent.

- **Seam: process clock ↔ wall-clock representation.** The `Insight.timestamp` field is an ISO string the UI displays; the *value* is the producing instance's `new Date().toISOString()`. As long as one instance produces all insights for one feed, there's no comparison across clocks. The current `putInsights` (`lib/state/insights.ts:30-42`) makes this work by clearing the Map first — each briefing fully replaces the prior one, so timestamps never get mingled across instances.
- **Seam: process clock ↔ another process's clock** — *does not exist*. No leader election, no lease, no heartbeat, no quorum vote that depends on clock agreement.

```
  Structure pass — clocks within a process, not across

  ┌─ within one Vercel process ─────────────────────────┐
  │  Date.now() for cache:    compared to Date.now()    │
  │                            in same process — safe    │
  │  Date.now() for spacing:  same                       │
  │  toISOString for insight: ISO string for display     │
  │                            — no comparison           │
  └────────────────────────┬────────────────────────────┘
                           │  no clock comparison crosses this seam
                           │  because nothing about another process's
                           │  clock is ever read
                           ▼
  ┌─ within another Vercel process ─────────────────────┐
  │  same code, same patterns, ITS clock                 │
  └──────────────────────────────────────────────────────┘
```

---

## How it works

### Move 1 — the mental model

You already know `Date.now()` returns milliseconds since 1970 from the machine's clock. The distributed-systems issue: every machine's clock is slightly different. Two `Date.now()` readings from two machines, even taken at the "same" instant, can differ by milliseconds (well-synced via NTP), seconds (sloppy), or hours (broken). This means **you cannot order events from different machines by their wall-clock timestamps and get the right answer.**

```
  Why wall-clock doesn't work across machines

  machine A clock:  ─── 10:00:00.000 ──────► event A1 at 10:00:00.500
  machine B clock:  ─── 09:59:59.800 ──────► event B1 at 10:00:00.300 (B-clock)
                                                     (= 10:00:00.500 A-clock)

  did A1 happen "before" B1?
    by wall-clock timestamps:    A1.ts (500) > B1.ts (300) → B1 first
    by actual real-world time:   they were simultaneous

  → wall-clock ordering is unreliable across machines
```

Three classical responses to this:

```
  Distributed clock patterns — the kernel

  LAMPORT CLOCKS       integer counter; on send, bump and attach;
                       on receive, max(local, received) + 1
                       gives partial ordering ("if A causally before B,
                       L(A) < L(B)" — but not vice versa)

  VECTOR CLOCKS        one counter per node; on send, attach vector;
                       on receive, element-wise max + bump own
                       gives full causal ordering (can detect concurrency)

  HYBRID LOGICAL       wall-clock + logical bump; close-to-real-time
                       but still total-orderable

  LEASES               "I own X until time T (your clock + my clock skew)"
                       short-lived locks that auto-expire
                       requires both sides agree on a generous-enough margin
```

**None of these apply in blooming insights** because no event from one machine is ever compared to or merged with an event from another machine within our code.

### Move 2 — the four `Date.now()` callsites, walked

**Use cases.**

Every existing use case is within-process and safe. The interesting *non*-use cases are the features that would force this to become a real concern:
- Scheduled briefings (would need cron + leader election; Vercel Cron Jobs handles it).
- "Don't run two briefings in parallel for the same user" (would need a distributed lock; Vercel KV `SET NX` with TTL is the easy solution).
- Merging insights from two parallel briefings into one feed (would need ordering; HLC or per-event UUID with tiebreak).

#### Callsite 1 — BloomreachDataSource cache TTL (`lib/data-source/bloomreach-data-source.ts:149, 186`)

```
  Cache TTL — within-process comparison only

  set:    expiresAt = Date.now() + ttl     ← same process's clock
  read:   if cached.expiresAt > Date.now() ← same process's clock
          → return cached

  comparison: this process's Date.now() at T vs same process's at T+N
  skew matters? NO — same monotonic-ish clock
  exception: NTP correction during the 60s window could shift
             Date.now() backward. Practically irrelevant — a one-
             time NTP step is rare on Vercel and at most causes one
             cache miss
```

Safe. No distributed clock issue.

```
  lib/data-source/bloomreach-data-source.ts  (lines 149-150, 185-186)

  if (cached && cached.expiresAt > Date.now()) {        ← read-time comparison
    return { result: cached.result as T, durationMs: 0, fromCache: true };
  }
  // ...
  const now = Date.now();                                ← write-time stamp
  this.cache.set(cacheKey, { result, expiresAt: now + ttl });
       │
       └─ both Date.now() calls happen in the same Node process.
          Comparison is monotonic-ish — safe even across NTP corrections
          (worst case: one extra cache miss or one extra hit, no
          correctness impact).
```

#### Callsite 2 — BloomreachDataSource spacing (`lib/data-source/bloomreach-data-source.ts:191, 197, 200`)

```
  Spacing tracker — within-process comparison only

  on call:  elapsed = Date.now() - this.lastCallAt
            if elapsed < minIntervalMs: sleep(diff)
            ...transport.callTool...
            this.lastCallAt = Date.now()

  comparison: same process's clock at two times
  skew matters? NO
  exception (also irrelevant): NTP step could make elapsed negative;
             the `< minIntervalMs` test stays correct, just sleeps the
             full interval. No data corruption possible.
```

Safe. No distributed clock issue.

```
  lib/data-source/bloomreach-data-source.ts  (lines 190-205)

  const elapsed = Date.now() - this.lastCallAt;
  if (elapsed < this.minIntervalMs) {
    await new Promise((r) => setTimeout(r, this.minIntervalMs - elapsed));
  }
  try {
    const result = await this.transport.callTool(name, args);
    this.lastCallAt = Date.now();                        ← record after success
    return result;
  } catch (err) {
    this.lastCallAt = Date.now();                        ← also record on fail
    // ...
  }
       │
       └─ rate-limit spacing tracker. Same-process clock comparison;
          no skew issue. Cross-instance leak: two Vercel instances each
          have their own lastCallAt, so concurrent calls from different
          instances can both fire within Bloomreach's window. That's a
          coordination issue (file 05), not a clock issue.
```

#### Callsite 2b — OlistDataSource durationMs (`lib/data-source/olist-data-source.ts:152, 159`)

```
  Olist durationMs — within-process comparison only

  on call:  const start = Date.now()
            ... await client.callTool(..., { signal })
            const durationMs = Date.now() - start
            return { result, durationMs, fromCache: false }

  comparison: same process's clock at two times (start vs end)
  skew matters? NO — same monotonic-ish clock
  cross-process? NO — even though the call traverses a stdio pipe
                       to a subprocess, BOTH Date.now() readings
                       happen in the parent process; the child's
                       clock is never read by our code
```

Safe. The interesting observation: even though this callsite is *about* an IPC round-trip, the clock comparison stays within one process — the parent measures wall-clock duration from before-send to after-receive without touching the child's clock at all. The child has its own clock and presumably writes log timestamps with it, but those are display-only (file 06, the stderr stream).

#### Callsite 3 — UI TraceItem timestamps (`lib/hooks/useInvestigation.ts:107, 113`)

```
  TraceItem.ts — for UI display order, single tab

  on each agent event:
    const it: TraceItem = { kind: 'step', ..., ts: Date.now() }

  comparison: not really compared; used as a render ordering hint
              and possibly shown to the user as "X seconds ago"
  cross-process? NO — generated in the browser, consumed in same tab
```

Safe. No distributed clock issue.

#### Callsite 4 — Insight.timestamp (`lib/state/insights.ts:14`)

```
  Insight.timestamp — produced server-side, ISO format

  anomalyToInsight: {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),    ← server's clock at conversion
    ...
  }

  comparison: the UI may display "generated 5 minutes ago" using
              new Date(timestamp) vs Date.now() in the browser
              — that compares the SERVER's clock to the BROWSER's clock
              → mild clock skew here is real

  worst case: a few minutes of "ago" being slightly wrong
              for a user with a badly-set machine clock
  safety: human-readable ISO; nothing else depends on it
```

Mostly safe. The cross-clock comparison server→browser is the only one in the codebase, and the consequence of skew is a display glitch ("3 minutes ago" off by 30 seconds for a user whose machine clock is 30s slow). No data corruption.

```
  lib/state/insights.ts  (lines 8-28, specifically line 14)

  export function anomalyToInsight(a: Anomaly): Insight {
    const id = crypto.randomUUID();
    // ...
    return {
      id,
      timestamp: new Date().toISOString(),               ← server's clock,
      // ...                                                ISO string format
    };
  }
       │
       └─ the only "produced here, displayed there" timestamp. UI
          compares to browser Date.now() for "X minutes ago" rendering.
          Skew effect is cosmetic; no data path depends on the value.
```

### Move 3 — what NOT YET EXERCISED looks like (and what would force it)

#### Leader election

**Not exercised.** No node has a special role. Every Vercel instance is interchangeable. No leader, no follower, no role transition.

```
  What would force leader election

  feature: "exactly one briefing per organization per day at 8am"
    needs: ONE Vercel function to fire per (org, day)
    risk:  if you trigger N functions and only one should "win," need
           leader election OR a coordinating service

  solution: lean on Vercel Cron Jobs — the platform IS the leader-
            election protocol; ONE function is invoked per cron entry,
            guaranteed by Vercel's infrastructure
```

#### Lease / lock

**Not exercised.** No code acquires a lock saying "I own this resource for the next N seconds." The closest thing is the `startedRef` guard in `useInvestigation`, which is a *process-local* once-per-mount flag, not a distributed lock.

```
  What would force a distributed lock

  feature: "user clicks 'rerun briefing' — don't run two in parallel"
    today: nothing prevents two parallel runs from two tabs / two clicks
    risk:  doubles MCP cost; second run may overwrite first

  solution: Vercel KV with SET NX user:briefing-lock TTL=60s
            → first request acquires; second sees the lock and 409s
            this IS a lease — short-lived lock with auto-expiry
            requires clock-skew margin (KV's clock vs Vercel function's)
            in practice: KV is single-source-of-truth for the lock,
            its clock is the only one that matters
```

#### Split-brain

**Not exercised.** There's no role you could split-brain across. No leader, no primary, no quorum vote.

#### Hybrid Logical Clocks / vector clocks

**Not exercised.** No event from one process is causally ordered against an event from another process inside our code. If we eventually merged insights from two instances, we'd want a Lamport or HLC timestamp on each insight to order them; today we don't merge, so we don't need to order.

### Move 3 (real) — the principle

**Clocks become a distributed-systems problem only when one machine reads another machine's clock.** Inside one process, `Date.now()` is fine — it's monotonic enough and consistent with itself. The instant you need two processes to agree on "who got there first" or "who holds the lock until when," wall-clock comparisons stop working and you reach for logical clocks, consensus, or a single source-of-truth clock (a coordinator). blooming insights stays on the easy side of this line by structurally avoiding the situations that cross it — no peer coordination, no leases, no leader. When the day comes that a feature needs one, the right move is to lean on Vercel KV's atomic operations (its clock is the only one that matters) rather than trying to coordinate Vercel function clocks against each other.

---

## Primary diagram

```
  Clocks in blooming insights — every Date.now() callsite, classified

  ┌─ browser ────────────────────────────────────────────────────┐
  │                                                                │
  │   TraceItem.ts = Date.now()                                    │
  │   → single tab, single clock, display-order only — SAFE        │
  │                                                                │
  │   new Date(insight.timestamp).getTime() vs Date.now()          │
  │   → cross-clock (server→browser), display-only — MILD SKEW OK  │
  │                                                                │
  └────────────────────────────────┬─────────────────────────────┘
                                   │  no other cross-clock comparisons
                                   ▼
  ┌─ Vercel instance (one process) ──────────────────────────────┐
  │                                                                │
  │   McpClient.cache.expiresAt = Date.now() + 60_000              │
  │   ... if (cached.expiresAt > Date.now()) ...                   │
  │   → same process, same clock — SAFE                            │
  │                                                                │
  │   McpClient.lastCallAt = Date.now()                            │
  │   ... elapsed = Date.now() - lastCallAt ...                    │
  │   → same process, same clock — SAFE                            │
  │                                                                │
  │   anomalyToInsight: timestamp = new Date().toISOString()       │
  │   → produced here, displayed there — see browser box above     │
  │                                                                │
  │   ─── what would FORCE a distributed clock problem ───         │
  │   - leader election (no role exists)                            │
  │   - distributed lock (no resource needs one)                    │
  │   - causal ordering of cross-instance events (no merge)         │
  │   all NOT YET EXERCISED                                         │
  │                                                                │
  └────────────────────────────────────────────────────────────────┘
```

---

## Elaborate

The reason clocks are hard in distributed systems isn't that NTP is bad — it's that NTP gives you "close-enough for most things" without telling you how close. The fundamental result is Lamport's: physical time is a fiction; causal ordering is what you can actually know. If you need to know "did A happen before B," and they're on different machines, you need to attach causal information (Lamport counter, vector clock, HLC timestamp) at the source so the comparison is meaningful at the merge point.

blooming insights skips this entire problem space by structurally not having cross-machine comparisons. That's not because the engineers are clever; it's because the architecture has no shared writable state that two machines would need to order writes into. The day a feature lands that needs such ordering — say, a shared insight feed where two organizations' admins both mark insights as "resolved" — you'd reach for either a server-assigned monotonic counter (single point of truth) or HLC timestamps (distributed but reasonable). Postgres's `SERIAL` column is a poor-man's monotonic counter; Vercel KV's `INCR` is the same idea in a key-value store. Both work because they centralize the clock to one place — the storage layer — and let everyone else read from it.

The right next move IF a coordination concern arose: lean on Vercel KV. Its atomic operations (`INCR`, `SET NX`, `EXPIRE`) cover 90% of the cases (counters, locks, leases) without needing a custom clock protocol. The other 10% (true consensus, complex transactional ordering) is what you'd add Postgres or a dedicated coordinator for.

---

## Interview defense

**Q: How do you handle clock skew in this system?**

I don't have to. Every `Date.now()` reading in this codebase is compared to another reading from the same process — cache TTLs, rate-limit spacing, UI display timestamps. There's no leader election, no distributed lock, no causal ordering across instances, so the classical clock-skew concerns don't fire. The one cross-clock comparison is server-generated `Insight.timestamp` (ISO string) versus browser `Date.now()` for "X minutes ago" rendering — and the consequence of skew is cosmetic, not corrupting.

```
  the four Date.now() callsites, classified

  cache TTL          ← same process, monotonic-enough, safe
  rate-limit spacing ← same process, safe
  TraceItem.ts (UI)  ← same tab, safe
  Insight.timestamp  ← server→browser cosmetic skew, safe
```

**Q: What would force you to deal with this?**

A feature that needs two machines to agree on "who got there first." Scheduled briefings — exactly one Vercel function should fire per cron entry — would force leader election (and Vercel Cron Jobs would solve it for me at the platform layer). A "rerun lock" so two parallel briefings can't run for the same user — distributed lock, easiest done with Vercel KV's `SET NX` with TTL. Merging insights from two parallel runs into one feed — distributed ordering, easiest via a server-assigned monotonic ID.

```
  the three features that would force it
  
  cron-style schedule  →  Vercel Cron Jobs (platform handles it)
  "don't run two"      →  Vercel KV SET NX + TTL
  merge ordered feed   →  monotonic counter or HLC
```

**Q: What's the load-bearing concept people forget?**

The lease — a lock with a TTL. A naive distributed lock without an expiration would deadlock if the holder dies before releasing. A lease auto-releases after N seconds; if the holder is still alive and needs more time, it renews. The clock-skew margin matters: you set the lease to (max work time + max clock skew between holder and store), so the holder doesn't lose its lease early. In a Vercel KV-style world this is moot because KV's clock is the only one that matters — but it's the conceptual primitive people skip when first reaching for a distributed lock.

---

---

## See also

- `02-partial-failure-timeouts-and-retries.md` — the spacing tracker and retry waits both depend on within-process `Date.now()` comparisons
- `03-idempotency-deduplication-and-delivery-semantics.md` — the cache TTL is a clock-based dedup window
- `05-replication-partitioning-and-quorums.md` — replication is the other "not yet exercised" that would force this topic
- `08-sagas-outbox-and-cross-boundary-workflows.md` — workflows often need timestamps; the step 2 → step 3 flow doesn't
- `.aipe/study-runtime-systems/` — event loop within one Vercel instance (when generated)

---
