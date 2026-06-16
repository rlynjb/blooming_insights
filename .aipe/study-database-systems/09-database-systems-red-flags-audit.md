# Database Systems — Red Flags Audit

## Subtitle

The ranked list of what to actually worry about, grounded in real files · Project-specific.

## Zoom out, then zoom in

```
  Zoom out — the audit perimeter (expanded for Phase 2)

  ┌─ what we ARE auditing ────────────────────────────────────────┐
  │  main app:                                                     │
  │    - MCP response cache (Map + TTL)                            │
  │    - schema singleton                                          │
  │    - in-process state Maps (insights / investigations /        │
  │      anomalies)                                                │
  │    - auth store (3 backends)                                   │
  │    - dev-only JSON files                                       │
  │    - bi_auth cookie crypto                                     │
  │    - the per-instance rate-limit counter                       │
  │  mcp-server-olist (NEW):                                       │
  │    - committed 3.5 MB binary DB                                │
  │    - read-only-by-convention (not enforced beyond open flag)   │
  │    - seed determinism (mulberry32 seed=42)                     │
  │    - schema-to-tool contract (olistWorkspaceSchema)            │
  │    - 9 named indexes vs the actual query shapes                │
  └────────────────────────────────────────────────────────────────┘

  ┌─ what we are NOT auditing ────────────────────────────────────┐
  │  - Bloomreach (upstream, opaque, not "ours")                   │
  │  - browser storage beyond the auth cookie                       │
  │  - Vercel-side persistence (we don't use any)                  │
  │  - SQLite internals (page format, pager, btree implementation)  │
  └────────────────────────────────────────────────────────────────┘
```

### How to read this

Ranked by consequence × likelihood × time-to-bite. **High** means "I'd fix this before scaling traffic past a handful of concurrent users." **Medium** means "fine for today, will bite when feature X arrives." **Low** means "known tradeoff, acceptable in context."

Each finding names the **file:line**, the **mechanism**, the **trigger**, and the **fix shape**.

## The ranked list

### 1. HIGH — rate-limit budget is per-instance, not global

**Where.** `lib/mcp/client.ts` L82, L149-156 — `lastCallAt` is on the McpClient instance, which is reconstructed per `connectMcp()` call.

**The mechanism.** `minIntervalMs=1100` enforces ~1 req/s on a single Node process. Bloomreach enforces 1 req/s GLOBALLY per user. Multiple warm Vercel instances each pace independently → the global rate gets exceeded the moment two instances handle requests for the same user concurrently.

**The trigger.** Two concurrent briefings on two warm instances. The retry path in `lib/mcp/client.ts` L121-132 catches the resulting 429s and waits 10s — that's the safety net, not the fix. Under sustained concurrent load, every call pays the 10s retry tax and the 300s route budget burns out.

**The fix shape.** Shared token bucket in an external KV. Pseudocode in section 06 Move 2c. Atomic `INCR rl:user:{id}:window` + `EXPIRE rl:user:{id}:window 1` on the first increment; reject when over budget. Upstash Redis is the obvious match for Vercel.

**Why high.** This is the one finding here that would bite under *any* real concurrent traffic, not just at scale. Two browser tabs from the same user is enough.

---

### 2. HIGH — insights Map state diverges across instances with no shared truth

**Where.** `lib/state/insights.ts` L4-L6 (the Maps), L30-42 (`putInsights` write path), L52-54 (`listInsights` read path).

**The mechanism.** Each warm instance has its own private `Map`. `putInsights()` writes only to this instance. A read from a different instance sees `[]` (or a different briefing's state).

**The trigger.** Any time Vercel serves the same user's next request from a different warm instance than the briefing ran on. With low traffic, often the SAME instance is reused; with any concurrency or instance churn, divergence is the default.

**The mitigation in place.** `app/api/agent/route.ts` L37-47 has a three-tier fallback: client-sent blob → in-memory → demo file. The client-sent blob is what actually saves this — `sessionStorage` carries the insight, the URL carries it as `?insight=`. **Don't remove that fallback** without first adding a shared store.

**The fix shape.** Move `putInsights` / `listInsights` to Vercel KV (or Upstash). One key per briefing, JSON-serialized payload. Same shape, network-backed.

**Why high.** Today the workaround works because the UI is well-behaved (always passes the insight blob). Add any cross-tab feature, any "shareable link to an investigation," any background refresh — and the workaround fails silently. Silent failures rank high.

---

### 3. MEDIUM — schema cache has no invalidation, ever

**Where.** `lib/mcp/schema.ts` L131, L173-174 — `cached: WorkspaceSchema | null` lives for the lifetime of the Node process.

**The mechanism.** Once `bootstrapSchema()` runs, every subsequent call returns the cached value. The only invalidation is `_resetSchemaCache()` (L194) which is test-only.

**The trigger.** A workspace's event schema changes upstream (Bloomreach side — new event type registered, property added). The warm instance won't see the change until it dies. Could be hours.

**The current acceptance.** The author explicitly traded freshness for the rate-limit budget (the four-call bootstrap is ~4-5s; running it per briefing is unaffordable). For a single-tenant demo, this is the right call.

**The fix shape, when it matters.** TTL on the cache (say, 1 hour), OR explicit invalidation on a webhook from Bloomreach (which doesn't exist), OR a `?refresh=schema` debug toggle.

**Why medium.** Workspace schemas don't change mid-day in normal use. The cost when it does happen is "your live demo shows the wrong event list" — recoverable by redeploying.

---

### 4. MEDIUM — `putInsights()` is non-atomic across awaits, and atomic-by-luck within ticks

**Where.** `lib/state/insights.ts` L30-42.

**The mechanism.** `insights.clear() + anomalies.clear() + N×insights.set(...)` is multi-step. Today there's no `await` in the body, so Node's event loop gives you tick-atomicity for free. Add any `await` (logging, metric emission, a network call) and another concurrent handler can observe `insights.size === 0` between the clear and the loop.

**The trigger.** Anyone refactoring this function to add async work. The fragility is invisible in the source — there's no comment naming "this body must stay synchronous."

**The fix shape now.** A comment that names the contract: `// MUST remain synchronous — body relies on event-loop tick atomicity for write isolation.` A linter rule, ideally. A test that asserts via grep.

**The fix shape later.** Once in a shared store, do it as one write: `kv.set('briefing:current', items)` — atomic from KV's perspective.

**Why medium.** Will not bite until someone refactors. When it does, it'll be a flaky test that nobody can reproduce because the race window is tiny.

---

### 5. MEDIUM — dev write paths have no atomic-rename or fsync

**Where.**
- `lib/state/investigations.ts` L30-41 (`saveInvestigation` → `writeFileSync(CACHE_FILE, ...)`)
- `lib/mcp/auth.ts` L137-141 (`writeAll` → `writeFileSync(CACHE_FILE, ...)`)
- `app/api/mcp/capture-demo/route.ts` L33-36, L57-60 (capture script writing demo fixtures)

**The mechanism.** Read-the-whole-file, modify-in-memory, write-the-whole-file-back. No `tmp + rename` atomic-replace. No fsync. A power loss mid-write leaves a torn file. JSON.parse on the next read catches the corruption (`lib/state/investigations.ts` L17-19; `lib/mcp/auth.ts` L120) and treats the file as empty.

**The trigger.** Dev machine crashes during a write. Also: two concurrent writers (`saveInvestigation()` called twice in parallel) → last writer wins; the other's investigation is lost.

**The acceptance.** This is dev-only — production uses the cookie for auth and Map-only for investigations. Loss in dev means "re-run the briefing," not a data incident.

**The fix shape.** If we ever want these to be production-grade: write to `${CACHE_FILE}.tmp`, fsync, rename. Or use SQLite — even an embedded file DB gives you atomic-replace for free.

**Why medium.** Acceptable today, would be a bug the day persistence becomes important.

---

### 6. MEDIUM — `bi_auth` cookie crypto depends on `AUTH_SECRET` and silently degrades

**Where.** `lib/mcp/auth.ts` L51-60 (key derivation), L69-79 (decrypt with catch-all that returns `{}`).

**The mechanism.** AES-256-GCM under SHA-256(`AUTH_SECRET`). On decrypt failure (tampering, rotated secret, corrupt cookie), the catch returns `{}` — silently logged-out.

**The good parts.** AES-GCM is the right primitive. The catch-and-return-empty is correct behavior (treat as no auth, force re-login). Test coverage exists for the crypto round-trip (`_authCookieCrypto` in L243-247).

**The trigger.** Rotating `AUTH_SECRET` invalidates every user's session globally — they all silently get re-logged-out. No log line warns the operator that "this was a rotation, not an attack."

**The fix shape.** Log decrypt failures at info level (not error — could be legitimate rotation). Track a counter; alert on sudden spike (potential attack vs. rotation).

**Why medium.** Today this just means users re-login when AUTH_SECRET rotates. If we ever cared about distinguishing "tampered cookie" from "rotated secret," we'd need a key-id prefix in the cookie format.

---

### 7. LOW — MCP cache has no LRU; unbounded growth in theory

**Where.** `lib/mcp/client.ts` L80 — `private cache = new Map<...>()` with no max-entries.

**The mechanism.** Every unique `(toolName, args)` pair adds a key. Keys are TTL-evicted on access, not proactively — so an unused key stays in the Map until the process dies.

**The trigger.** A long-running warm instance + many unique tool-call argument sets. In practice, the argument space per session is bounded (a handful of EQL queries, a handful of `list_*` calls), so the Map stays small.

**The fix shape, if needed.** Add a max-entries cap and an LRU eviction policy. `Map`'s insertion-order preservation makes a poor-man's LRU easy: track access order, delete the oldest on overflow. Or use a library (`lru-cache`).

**Why low.** No observed unbounded growth. Worth a comment in the code; not worth the fix yet.

---

### 8. LOW — `JSON.stringify(args)` is order-sensitive cache key

**Where.** `lib/mcp/client.ts` L102.

**The mechanism.** Two callers passing `{a:1, b:2}` and `{b:2, a:1}` get different cache keys. Cache misses where a hit was possible.

**The trigger.** Callers constructing args from different sources (e.g. one from a literal, one from `Object.assign`). In practice, the agents construct args programmatically with consistent key order, so this doesn't bite.

**The fix shape.** Canonicalize: `JSON.stringify(args, Object.keys(args).sort())`. One-line fix. Acceptable defer because it's a perf miss, not a correctness bug.

**Why low.** Worst case: a cache miss. Cost: one extra MCP call.

---

### 9. LOW — investigations Map never evicts; per-instance memory grows with completed investigations

**Where.** `lib/state/investigations.ts` L11 — `mem = new Map<...>()` with no eviction.

**The mechanism.** Every `saveInvestigation()` is an upsert. The Map grows monotonically until the instance dies.

**The trigger.** A warm instance handling many investigations over its lifetime. Each investigation is a few KB of `AgentEvent[]` — at 1000 investigations, you're looking at a few MB. Not a leak in the harmful sense; the instance will die before it matters.

**The fix shape.** LRU cap, or just trust Vercel to recycle instances.

**Why low.** Vercel instance lifetimes are short enough that this doesn't accumulate in practice.

---

### 10. MEDIUM — committed 3.5 MB binary DB inflates repo size; regeneration is the recovery path

**Where.** `mcp-server-olist/data/olist.db` (committed to git, 3.5 MB). Generated by `mcp-server-olist/scripts/seed-olist.ts`.

**The mechanism.** The seed script is deterministic (mulberry32 PRNG, seed=42). Anyone can regenerate the exact same DB by running `npm run seed`. The committed binary is a convenience — clone the repo, the fixture is already there.

**The trade-off.** Repo size pays for clone-and-go reproducibility. 3.5 MB per commit if the DB ever changes; git stores compressed deltas but binary deltas compress poorly. If the schema or seed evolves, every change ships the full new binary.

**The trigger that flips the calculus.** Adding a second fixture (e.g. a different seed for adversarial evals) doubles the cost. Three fixtures triples it. The day there are >3 such binaries, move them to git-lfs OR drop them and require `npm run seed` in CI.

**The fix shape if/when it matters.** Two options:
1. Delete `olist.db` from git, gitignore it, require seed-on-CI + on-first-clone documentation
2. Move to git-lfs; binary stays clone-fast, repo stays small

**Why medium.** Not a correctness risk. A repo-hygiene risk that grows with the number of binary fixtures.

---

### 11. LOW — Olist seed determinism depends on `OLIST_SEED = 42` constant

**Where.** `mcp-server-olist/scripts/seed-olist.ts` L36-47 (mulberry32 PRNG + seed constant).

**The mechanism.** The committed `olist.db` is byte-identical across machines BECAUSE the seed is fixed and the PRNG is pure ALU. Three seeded anomalies live at specific (week, segment) coordinates that the eval suite asserts against.

**The trigger.** Anyone changing `OLIST_SEED` invalidates every eval baseline. The anomaly windows in `SEEDED_ANOMALIES` (L143-179) would still be the same coordinates, but the surrounding noise floor would differ — anomaly detection thresholds calibrated to the old data could no-op or false-positive on new data.

**The current acceptance.** The constant is named (`OLIST_SEED`), one place, easy to grep. No-one has changed it.

**The fix shape, if it ever matters.** Make the seed an input to the seed script (env var with default 42), and tag committed DBs with `olist-seed-<n>.db`. Today, single-fixture-by-convention is fine.

**Why low.** Trips only if someone changes the constant. The committed DB acts as a backstop: regenerated DBs are byte-checkable against it.

---

### 12. LOW — `olistWorkspaceSchema()` is hand-maintained, can drift from db.ts

**Where.** `lib/mcp/schema.ts` L232-273 (the synthetic schema the agents see); `mcp-server-olist/scripts/seed-olist.ts` L184-244 (the real DB schema).

**The mechanism.** `olistWorkspaceSchema()` describes the dataset to the agents — three "events" (order, payment, review), customer properties (state, city), and the data horizon (2025-12-01 .. 2026-06-01). It's hand-coded and does NOT derive from `db.ts` or the seed script. If the seed script's schema changes (new table, new column, new dimension), the agent-facing schema stays stale until someone hand-edits both.

**The trigger.** Schema evolution in `mcp-server-olist`. Today there's one schema, one source-of-truth-by-convention.

**The fix shape, if it ever matters.** Derive the schema from `db.ts` introspection (`PRAGMA table_info(...)` + the indexes), OR keep them in sync with a test that compares the introspected shape to the hand-coded `olistWorkspaceSchema()`.

**Why low.** One-time hand-coded translation; small surface; the dataset is stable.

---

### 13. LOW — Bloomreach is a single point of failure with no caching of last-known-good

**Where.** Every route that touches `connectMcp()` / `bootstrapSchema()` / agent loops.

**The mechanism.** If Bloomreach is down or auth fails, the briefing can't run and there's no stale-cache fallback path. The 60s MCP cache helps for the duration of a session, but a cold instance with no cache state can't serve.

**The trigger.** Bloomreach outage. We can't do anything about the upstream — but we COULD serve last-known-good cached insights instead of failing.

**The fix shape, if we cared.** Persist last-successful briefing to a shared store; serve it as "stale, last refreshed at T" when live calls fail. Today the demo fallback (`?demo=cached`) covers the no-credentials case but not the upstream-down case mid-session.

**Why low.** Single-tenant demo; an upstream outage means "demo doesn't work right now," not "users can't access their data." Would be a real concern in production.

---

## What's notably ABSENT and why that's fine

```
  classical database red flags that mostly don't apply (with the Olist
  caveats noted)

  ✗ "N+1 in the ORM"                  — no ORM. N+1 exists in the agent
                                         loop (section 04 Move 2c) and is
                                         accepted by design.

  ~ "missing indexes on hot queries"  — main app: no queries. Olist: 9
                                         B-tree indexes cover every tool
                                         query shape (see 03). A query that
                                         outgrew them would be a regression.

  ✗ "deadlocks under contention"       — no locks. Olist is readonly +
                                         single-process. Node's event loop
                                         is the closest scheduler.

  ~ "WAL not synced; data loss risk"  — main app: nothing durable to WAL.
                                         Olist: WAL mode is set; the only
                                         writer (seed) gets durability on
                                         COMMIT. Read-only at runtime, so
                                         WAL stays dormant.

  ✗ "stale replica reads"             — no replicas. cross-instance
                                         divergence (main app) named in #2.

  ~ "backup not tested"               — main app: no data to back up.
                                         Olist: the committed binary IS the
                                         backup; "test" = `npm run seed` and
                                         diff the result. See #10.

  ✗ "schema migration broke prod"     — no schema migrations. The Olist
                                         schema is rebuilt from scratch on
                                         every `npm run seed`; no in-place
                                         ALTER paths.
```

## The two-line summary

If you only fix two things, pick **#1** (shared rate-limit budget) and **#2** (shared insights store). Everything else is either acceptable in context or won't bite until a feature lands that doesn't exist yet.

If you're building features today and want to keep the audit clean: **assume nothing about cross-instance state, assume the rate limit could trip at any moment, and assume Bloomreach can be slow.** The codebase's current design already does this — the audit is mostly about naming the lines where those assumptions are load-bearing.

## See also

- `01-database-systems-map` — the layout being audited (both altitudes)
- `06-locks-mvcc-and-concurrency-control` — the concurrency mechanics behind #1 and #2
- `08-replication-and-read-consistency` — the cross-instance divergence behind #2
- `10-embedded-sqlite-fixture` — context for findings #10, #11, #12
- `study-system-design` — when to reach for shared KV
- `study-distributed-systems` — token-bucket algorithm details

---
Updated: 2026-06-16 — added findings #10 (committed binary repo cost), #11 (seed determinism), #12 (schema-to-tool drift) for the Phase 2 Olist tier. Re-numbered #13 (was #10). Absent-list updated to flag the Olist caveats.
