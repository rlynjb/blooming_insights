# Database systems red flags — ranked audit

*Industry standard / Project-specific* — ranked list of storage-engine and consistency risks grounded in this repo. Severity is "what's the worst that happens, today, given current usage."

## Zoom out, then zoom in

Nothing in this repo is on fire. The honest top finding is that the codebase made deliberate choices to avoid a real database, and most of the "risks" listed below are latent — they bite *if* something changes (a new `await`, a second writer, a missing env var). The point of this audit is to name where the load-bearing assumptions are, so a future change doesn't break them by accident.

```
  Zoom out — where this concept lives

  ┌─ this audit ────────────────────────────────────────────┐
  │  walks 01-08, ranks the risks that fall out             │
  │  severity = blast radius × likelihood-given-current-use  │
  └─────────────────────────────────────────────────────────┘
```

## Structure pass

**Axis traced: blast radius** — if this risk fires, what does the user see?

```
  ┌─ R1 .. R3 ─────┐   user can't recover without redeploy / re-OAuth
  ┌─ R4 .. R6 ─────┐   user sees a one-time wrong result, recoverable by retry
  ┌─ R7 .. R8 ─────┐   user sees nothing; risk is to future maintainers
```

## The ranked findings

### R1 — `AUTH_SECRET` missing in production wipes everyone's auth at once

**Where:** `lib/mcp/auth.ts:53-58`

```typescript
function aesKey(): Buffer {
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    throw new Error(
      'AUTH_SECRET is required in production to encrypt the auth cookie. ' +
        'Set it in your Vercel project environment variables.',
    );
  }
  return createHash('sha256').update(secret).digest();
}
```

**What happens:** if `AUTH_SECRET` is unset in prod (deploy misconfiguration, env-var rotation gone wrong), every request that hits `withAuthCookies` throws synchronously the moment it tries to read the cookie. Every user sees a 500 immediately. The thrown error is the literal string, so logs make it obvious — but service is down for *every* session until the env var is restored.

**Blast radius:** all users, all sessions. Recovery: set the env var and redeploy.

**Why it's R1:** it's the only failure mode in the repo where ONE configuration mistake takes down EVERY user simultaneously. Single point of failure for the only durable state.

**Mitigation:** the `connectMcp` setup throw is caught in the briefing route's setup block (`app/api/briefing/route.ts:170-179`), so the 500 carries the real message rather than a bare crash. That's the only safety net.

### R2 — Snapshot staleness in demo mode is invisible to the user

**Where:** `app/api/briefing/route.ts:86-152` (replay path); `lib/state/demo-*.json` (the snapshots)

**What happens:** the demo snapshot is whatever someone captured and committed last. The UI has no "this data is from N days ago" indicator. A demo run weeks after capture shows numbers the user might think are current.

**Blast radius:** users on demo mode see stale data and don't know it's stale. No correctness bug — demo is explicitly opt-in via the `bi:mode` toggle and the docs make clear it's a fixed snapshot — but trust-affecting if someone walks into a meeting with a months-old demo.

**Mitigation:** a "captured on YYYY-MM-DD" badge in the UI would close this. Today: documentation only.

### R3 — A second writer for the same session could half-replace the feed

**Where:** `lib/state/insights.ts:57-71` — `putInsights`

**What happens:** if two `/api/briefing` calls for the same `sessionId` ran concurrently (e.g. a user opens two tabs and refreshes both at once), the second's `.clear()` could land mid-way through the first's `.forEach()`. The session's feed would end up with a mix of items from both runs.

**Blast radius:** one user, one session, until they refresh again.

**Why it hasn't bitten:** the briefing button disables while in-flight, the auto-reconnect is guarded (one retry), and most users have one tab. But nothing in the server prevents the concurrent case.

**Mitigation:** the cleanest fix is build-and-swap inside `putInsights` (build new Maps locally, assign at end — see `05-transactions-isolation-and-anomalies.md`'s interview answer). A per-session async lock would also work. Today: neither is in place.

### R4 — Adding an `await` between `.clear()` and `.forEach()` in `putInsights` would create a dirty-read window

**Where:** `lib/state/insights.ts:57-71`

**What happens:** today `putInsights` is synchronous between `.clear()` and `.forEach()`, so no other JS can interleave. Adding any `await` in that window — telemetry call, validation, derived-fields recomputation that does I/O — opens a window where a reader sees an empty feed mid-briefing.

**Blast radius:** one user during one briefing, until the function completes.

**Why it's R4 (not higher):** the code is correct *today*. The risk is to a future change. The comment at `lib/state/insights.ts:57-63` warns about WHY `.clear()` is called but says nothing about the atomicity contract — a future maintainer adding an `await` won't see the warning.

**Mitigation:** a "DO NOT add `await` between .clear() and .forEach()" comment. Or refactor to build-and-swap so the contract is enforced by construction.

### R5 — Two concurrent cache misses for the same key cause a duplicate upstream call

**Where:** `lib/data-source/bloomreach-data-source.ts:147-152` (cache read) + `:184-187` (cache write)

**What happens:** two concurrent `callTool(name, args)` with the same key both miss the cache, both trigger `liveCall`, both write the result. The second upstream call burns one tick of the ~1 req/s rate budget.

**Blast radius:** one extra upstream call per simultaneous miss. No correctness violation — both callers get a valid result.

**Why it's R5:** the cost is genuinely small. The "fix" (request coalescing — first caller's pending Promise gets returned to subsequent callers) costs more code than the bug costs in practice.

**Mitigation:** none needed today. If the agents ever fan out wider, request coalescing becomes worth it.

### R6 — The `lastCallAt` race can produce a 429 that costs ~10s on retry

**Where:** `lib/data-source/bloomreach-data-source.ts:190-205` — `liveCall`

**What happens:** `lastCallAt` is read-modified-written across two `await`s. Two concurrent callers can both see "elapsed > minIntervalMs," both skip the spacing wait, both fire. The upstream returns a 429 to one. The retry path parses the wait hint (typically 10s for Bloomreach), sleeps, retries.

**Blast radius:** one user, one extra ~10s on one call. Against the 300s `maxDuration` budget, this is significant if it hits during a long monitoring scan.

**Why it's R6:** the repo *deliberately* chose retry-absorption over locking for this case (a lock would serialize every tool call across all concurrent sessions). The risk is by design; the audit point is "know the cost, don't be surprised by it in a Vercel log."

**Mitigation:** the retry path. If the 10s+ tail latency ever becomes user-visible, a per-instance lock around `liveCall` would prevent it at the cost of cross-session serialization.

### R7 — `JSON.stringify` key-order non-determinism could cause cache misses for logically-equal args

**Where:** `lib/data-source/bloomreach-data-source.ts:144` — `${name}:${JSON.stringify(args)}`

**What happens:** `JSON.stringify` preserves insertion order. Two calls with the same logical args but different key order (`{a:1, b:2}` vs `{b:2, a:1}`) hash to different cache keys. Both result in real upstream calls.

**Blast radius:** extra upstream calls; no correctness bug.

**Why it's R7:** in practice the agent builds args from a fixed JSON schema, so key order is stable per call site. The risk is to a future caller that hand-builds args (e.g. a future debug route, a new agent).

**Mitigation:** sort keys before stringifying. The cost is trivial; the bug it prevents is rare. Either way, today not a problem.

### R8 — No `EXPLAIN`-equivalent for EQL means slow queries hide in `durationMs` alone

**Where:** `lib/data-source/bloomreach-data-source.ts:154-176` — the call timing path; `BloomreachDataSource` doesn't expose a plan summary

**What happens:** when an EQL call is slow, the only signal is `durationMs` in the result envelope. There's no plan, no cost breakdown, no "this could be faster if you indexed X" hint. The agents can't choose between queries based on cost.

**Blast radius:** none today — the model picks queries based on the prompt and tool schemas, not based on cost. The risk is "we won't catch a slow query in code review because we can't see the plan."

**Why it's R8:** it's a maintainability finding, not a runtime risk. Listed for completeness — if the upstream ever exposes plan data, this is the place to surface it.

**Mitigation:** roll up the existing `tool_call_end` events into a per-session plan summary (the data is on the wire already; just not aggregated).

## Not yet exercised

These are concepts the topic spec lists that genuinely don't apply, listed once so reviewers can verify the absence is honest:

- **B-tree / LSM indexes** — no persisted storage.
- **Real ACID transactions** — no store that supports them; the one multi-step write is R3/R4.
- **MVCC version chains** — `Map` is single-version per key; no readers seeing stale snapshots while a writer commits.
- **Backups / PITR** — the only durable state is the cookie; "backup" means "user re-runs OAuth."
- **Streaming replication lag** — the demo snapshot is manual, lag = time since last commit.
- **Failover** — no primary/replica failover because there's no primary in the database sense.

## Interview defense

**Q: What's the biggest risk in this app's data story?**

`AUTH_SECRET` missing in production. It's the only thing where one config mistake takes down every user simultaneously, because it's the key for the only piece of durable state (the bi_auth cookie). The error message at `lib/mcp/auth.ts:53-58` is loud and the briefing route catches the setup throw to return a real message instead of a bare 500, so it's detectable — but until the env var is restored, every request fails.

**Q: What's the load-bearing latent risk?**

Someone adding an `await` between `.clear()` and `.forEach()` in `putInsights` at `lib/state/insights.ts:57`. Today the function is atomic-by-language; one async call in that window creates a dirty-read window where a concurrent reader sees an empty feed. The fix is to build the new Maps as locals and swap them in at the end — atomic by construction. Today the warning isn't in the code.

**Q: What did the team *deliberately* choose not to fix?**

Two things. The cache race (two concurrent misses → duplicate upstream call) — the fix is request coalescing, which costs more code than the bug costs in practice. The `lastCallAt` race (two callers race the spacing → second gets a 429) — the fix is a per-instance lock, which would serialize every tool call across every concurrent session and cost more than the occasional retry. Both are "absorb the failure rather than prevent it" choices, and both are correct.

## See also

- `00-overview.md` — the ranked findings condensed
- `05-transactions-isolation-and-anomalies.md` — the multi-step write at R3/R4
- `06-locks-mvcc-and-concurrency-control.md` — the race trade-offs at R5/R6
- `07-wal-durability-and-recovery.md` — the cookie design that R1 puts at risk
