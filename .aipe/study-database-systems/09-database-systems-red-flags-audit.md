# Database systems — red-flags audit

*Ranked storage-engine and consistency risks grounded in the repo. Every finding has `file:line` evidence. Verdicts first, mechanics second.*

---

## The scoring rubric

Each finding names:
- **Severity** — how bad if this triggers in production.
  - `HIGH` — breaks user-visible behavior or silently corrupts state.
  - `MEDIUM` — degrades performance or reliability under load; not seen in normal use.
  - `LOW` — cosmetic or dev-only.
- **Evidence** — file paths, line ranges, code.
- **Mechanism** — what actually goes wrong.
- **The move** — the concrete fix or the deliberate acceptance.

---

## Finding 1 — Cache key is non-canonical JSON (MEDIUM)

**Evidence.** `lib/data-source/bloomreach-data-source.ts:144`

```ts
const cacheKey = `${name}:${JSON.stringify(args)}`;
```

**Mechanism.** `JSON.stringify` serializes object properties in insertion order. If two call sites build `args` with different key insertion order — even for the same conceptual query — the cache keys differ and the cache misses. In practice this doesn't bite today because the agents build `args` via the same tool-schema-driven code path, so key order is stable. But it's the class of bug that lands as a *performance regression* rather than a correctness one — rate-limit retries begin dominating requests and nothing in observability points at the cache-miss root cause.

**The move.** Two options: (a) canonical JSON serializer (`sortedJsonStringify`) — one function change, ~5 lines. (b) accept it and add a unit test locking in the current key-order invariant. I'd pick (a) — it's cheap and eliminates a whole failure mode. Anchor for the fix: right before line 144, replace `JSON.stringify(args)` with a canonical stringifier that sorts object keys recursively.

**Cross-links.** `03-btree-hash-and-secondary-indexes.md` — the composite index discussion; `04-query-planning-and-execution.md` — plan-reuse via cache.

---

## Finding 2 — `getCachedInvestigation` file reads on every request (LOW–MEDIUM)

**Evidence.** `lib/state/investigations.ts:22-28`

```ts
export function getCachedInvestigation(insightId: string): AgentEvent[] | null {
  if (mem.has(insightId)) return mem.get(insightId)!;
  const fromFile = PERSIST ? readJson(CACHE_FILE)[insightId] : undefined;
  if (fromFile) return fromFile;
  const fromDemo = readJson(DEMO_FILE)[insightId];  // ← reads the whole file every call
  return fromDemo ?? null;
}
```

**Mechanism.** The `fromDemo` tier does `readFileSync` + `JSON.parse` on `lib/state/demo-investigations.json` (3487 lines, ~150KB) on every cache-miss lookup. That's fine at demo cadence (a few reads per session) but scales poorly if the demo file grows or if this path becomes the hot path. There's no memoization of the parsed DEMO file across calls.

**The move.** Cache the parsed demo file on first read into a module-level variable. Two options: (a) simple lazy-load `let demoParsed: Record<string, AgentEvent[]> | null = null;` and re-use. (b) `fs.watch` for dev; static import for prod. (a) is fine — the file only changes at deploy time, so a warm-instance cache is perfect. Two-line change.

**Cross-links.** `02-records-pages-and-storage-layout.md` — file-boundary as page boundary; `08-replication-and-read-consistency.md` — the "committed snapshot" replica tier.

---

## Finding 3 — Read-modify-write race on `.investigation-cache.json` (LOW — dev-only)

**Evidence.** `lib/state/investigations.ts:30-41`

```ts
export function saveInvestigation(insightId: string, events: AgentEvent[]): void {
  mem.set(insightId, events);
  if (PERSIST) {
    const all = readJson(CACHE_FILE);        // read
    all[insightId] = events;                 // modify
    try {
      writeFileSync(CACHE_FILE, JSON.stringify(all));  // write
    } catch { /* best effort */ }
  }
}
```

**Mechanism.** Read at line 34, write at line 37 — no lock. Two concurrent writers can both read the old file, both mutate their in-memory copies, both `writeFileSync` — one wins, the other is lost. `PERSIST = NODE_ENV === 'development'` so this branch is dead in production.

**The move.** Accepted. Documented in the "concurrency control" study file. If this ever needs to move to prod, use `writeFileSync` with an atomic tmpfile-rename dance (`writeFileSync(tmp)` + `renameSync(tmp, CACHE_FILE)`), or drop persistence entirely.

**Cross-links.** `06-locks-mvcc-and-concurrency-control.md`.

---

## Finding 4 — `lastCallAt` rate-limit spacing is racy (LOW)

**Evidence.** `lib/data-source/bloomreach-data-source.ts:190-205`

```ts
private async liveCall(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  const elapsed = Date.now() - this.lastCallAt;
  if (elapsed < this.minIntervalMs) {
    await new Promise((r) => setTimeout(r, this.minIntervalMs - elapsed));
  }
  try {
    const result = await this.transport.callTool(name, args, { signal });
    this.lastCallAt = Date.now();
    return result;
  }
  ...
```

**Mechanism.** `elapsed` is read, then `await` yields the loop, and by the time the second racer reads it *its own* `elapsed` is stale — both may skip the spacing wait. Between two concurrent tool calls on the same `BloomreachDataSource` instance, the intended 200ms floor collapses. The retry ladder catches downstream rate-limit responses, but a preventive spacing floor would be tighter.

**The move.** Accepted. The Bloomreach server-side rate limit is the actual enforcer; local spacing is a courtesy. If this became load-bearing, replace with a proper sequential queue: every `callTool` acquires a promise from a chain `this.gate = this.gate.then(() => this._reallyCall(...))`, guaranteeing serial spacing.

**Cross-links.** `04-query-planning-and-execution.md`; `06-locks-mvcc-and-concurrency-control.md`.

---

## Finding 5 — All in-memory state is wiped on redeploy (HIGH by shape, MEDIUM by acceptance)

**Evidence.**
- `lib/state/insights.ts:14` — `Map<sessionId, SessionFeed>`
- `lib/data-source/bloomreach-data-source.ts:122` — 60s TTL cache
- `lib/state/investigations.ts:11` — in-mem investigation cache

**Mechanism.** Every deploy (or Vercel warm-instance turnover) drops the entire feed for every session, the entire cache, and the entire in-mem investigation store. Users see their in-flight briefing die; the next request re-runs it. In-flight NDJSON streams get dropped.

**The move.** Design accepts this. Recovery is idempotent (agent reruns produce equivalent output), the client's `sessionStorage` stash of the clicked Insight covers card-click hydration, and the `bi_auth` cookie survives so OAuth doesn't need to redo the handshake. If the app grew a "please don't lose my in-progress investigation on redeploy" requirement, that's the moment for durable server-side storage (Postgres + a `investigations` table with status column, or Vercel KV). Not before. Anchor for the recognition: `bi_auth` at `lib/mcp/auth.ts:38-104` is the one exception that already survives redeploys.

**Cross-links.** `07-wal-durability-and-recovery.md`.

---

## Finding 6 — `demo-investigations.json` is loaded via `readJson` from a hot path (LOW)

**Evidence.** Same as Finding 2 — `lib/state/investigations.ts:26-27`. The `readJson` helper does `existsSync + readFileSync + JSON.parse` on every call.

**Mechanism.** A single filesystem read is cheap on Vercel (files bundled into the function image), but this is a pattern worth naming. The `readJson` helper at `investigations.ts:13-20` is fine as a defensive convenience wrapper; the issue is calling it repeatedly without caching the parsed result. This is really the same finding as #2 — I list it separately because it also applies in *production* (unlike Finding 2's dev tier), where a warm instance may service dozens of investigation lookups.

**The move.** Same as Finding 2 — memoize the parsed demo file at module scope.

**Cross-links.** `08-replication-and-read-consistency.md`.

---

## Finding 7 — Cache key is unbounded in memory (LOW — bounded by tool cardinality)

**Evidence.** `lib/data-source/bloomreach-data-source.ts:122`

```ts
private cache = new Map<string, { result: unknown; expiresAt: number }>();
```

**Mechanism.** Nothing evicts expired entries; they just get overwritten by the next real call to the same key. Over a very long-lived warm instance (Vercel typically recycles them within an hour or two), the Map could accumulate stale entries for `(tool, args)` combinations that never repeat. In practice: tool count is small (~15 tools), args cardinality per tool is low (project_ids are stable per session), so this stays under a few hundred entries. No leak risk at current scale.

**The move.** Accepted. If it grew, a periodic sweeper or an LRU cap would fix it — but at current cardinality it's noise.

**Cross-links.** `03-btree-hash-and-secondary-indexes.md`.

---

## Finding 8 — `readdirSync` scan pattern in the regression gate is O(n) (LOW)

**Evidence.** `eval/gate.eval.ts:64-66`

```ts
const files = readdirSync(RECEIPTS_DIR)
  .filter((f) => f.endsWith(`${candidateRunId}.json`))
  .sort();
```

**Mechanism.** Linear scan of every receipt file, filtered by filename suffix. At 28 receipts today, negligible; at 10,000 receipts it would still be sub-second on any modern SSD; at 100,000 you'd want a directory-per-run layout so the "index" is the filesystem tree.

**The move.** Accepted for now. When receipts count crosses ~1,000, restructure to `eval/receipts/<runId>/<case>.json` so the runId lookup becomes a single directory listing.

**Cross-links.** `03-btree-hash-and-secondary-indexes.md`; `04-query-planning-and-execution.md`.

---

## Finding 9 — No canonical schema versioning on committed JSON snapshots (LOW–MEDIUM)

**Evidence.**
- `lib/state/demo-insights.json`, `demo-investigations.json` — no `schemaVersion` field at the top level.
- `eval/baseline.json:1-92` — has `runId` and `builtAt` but no `schemaVersion`.
- `eval/receipts/*.json` — 28 files, structure implied by `Receipt` type at `eval/gate.eval.ts:34-47`.

**Mechanism.** If the shape of `Insight`, `Anomaly`, `AgentEvent`, or the receipt structure changes, older committed snapshots become subtly incompatible. The `AGENTS.md` "what must not change" list already flags this ("new fields stay optional so older snapshots still validate") — that's the current mitigation: additive-only schema evolution. But there's no runtime version check; you catch the incompatibility by "the demo replay broke."

**The move.** For low cost / high value: add `schemaVersion: 1` to the top level of each snapshot file, log a warning if the reader sees an unfamiliar version, add a matching field to the writer (capture flow, `computeBaseline`). Doesn't have to gate behavior today; just makes the eventual migration visible.

**Cross-links.** `02-records-pages-and-storage-layout.md`; `study-data-modeling`.

---

## Finding 10 — bi_auth cookie has no rotation / re-encryption path (LOW — accepted)

**Evidence.** `lib/mcp/auth.ts:51-79`

```ts
function aesKey(): Buffer {
  const secret = process.env.AUTH_SECRET;
  ...
  return createHash('sha256').update(secret).digest();
}
```

**Mechanism.** If `AUTH_SECRET` is rotated in Vercel env, every existing `bi_auth` cookie becomes undecryptable (the decrypt catch at `auth.ts:69-79` returns `{}`, which the app treats as "no auth"). Every active user gets forced through the OAuth flow again on their next request.

**The move.** Accepted. This is *the* rotation story — you rotate by accepting the log-out event. Since Bloomreach revokes tokens every few minutes anyway, users are already used to reconnecting. If long-lived server-side sessions ever mattered, a dual-key decryption path (`AUTH_SECRET` + `AUTH_SECRET_OLD`) for a grace window would fix it — 20 lines.

**Cross-links.** `07-wal-durability-and-recovery.md`.

---

## Summary — ranked by consequence

```
  1. HIGH-by-shape / MEDIUM-by-acceptance
     ─ All in-memory state wiped on redeploy         (Finding 5)
        → design decision; recovery is idempotent, cookie survives

  2. MEDIUM
     ─ Non-canonical cache key                        (Finding 1)
        → 5-line fix; eliminates silent perf regression class

     ─ Repeated readJson on hot path                  (Findings 2 + 6)
        → 2-line memoize; drops demo-tier read latency

     ─ No schemaVersion on snapshots                  (Finding 9)
        → cheap forward-compat insurance

  3. LOW / dev-only / accepted
     ─ Dev-only file R-M-W race                       (Finding 3)
     ─ Rate-limit spacing race                        (Finding 4)
     ─ Unbounded cache Map                            (Finding 7)
     ─ Linear directory scan                          (Finding 8)
     ─ AUTH_SECRET rotation forces re-auth            (Finding 10)
```

The rank is honest about what's a *shape* issue (Finding 5 — nothing to fix without adding a database) versus what's a *5-minute fix* (Findings 1, 2, 6, 9). If I had one afternoon on this: I'd land canonical cache keys (Finding 1) and memoized demo reads (Findings 2 + 6), and add `schemaVersion` fields (Finding 9). That's it — the rest is either accepted-tradeoff or wait-until-scale.

## Cross-links

- `01-database-systems-map.md` — the storage topology every finding lives in.
- `03-btree-hash-and-secondary-indexes.md` — Findings 1, 7, 8.
- `05-transactions-isolation-and-anomalies.md` — Findings 3, 4.
- `06-locks-mvcc-and-concurrency-control.md` — Findings 3, 4.
- `07-wal-durability-and-recovery.md` — Findings 5, 10.
- `08-replication-and-read-consistency.md` — Findings 2, 6, 9.
- `study-system-design` — "should we add a database" belongs there, not here.
- `study-testing` — the test coverage of `putInsights`' turn-atomicity is in `test/state/insights.test.ts`.
