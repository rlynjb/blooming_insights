# Three-rung mem/file/seed store

**Industry name(s):** tiered storage / read-through cache hierarchy; a fallback chain (lookup-chain) of three sources. Closest precedent: the gem/npm package resolution chain, Maven's local→remote-cache→central. **Type:** Project-specific application of an industry pattern.

## Zoom out — where this concept lives

When the route asks "do we already have this investigation's events?", it walks three storage tiers in order. The same pattern shows up twice in this codebase — for cached investigations (`lib/state/investigations.ts`) and for OAuth state (`lib/mcp/auth.ts`). Each tier has a different *lifetime* and a different *recovery story*.

```
  Zoom out — three rungs at the storage layer, queried in order

  ┌─ Service layer ─────────────────────────────────────────────┐
  │  /api/agent · getCachedInvestigation(insightId) → AgentEvent[]?│
  └────────────────────┬────────────────────────────────────────┘
                       │ walks ↓
  ┌─ Storage layer ────▼────────────────────────────────────────┐
  │                                                              │
  │   rung 1: in-memory  Map<insightId, AgentEvent[]>            │
  │   ────────────────  process-local, dies on restart           │
  │                                                              │
  │             ↓ miss                                            │
  │                                                              │
  │   rung 2: dev file  .investigation-cache.json                │
  │   ────────────────  gitignored, dev-only, survives restart   │
  │                                                              │
  │             ↓ miss                                            │
  │                                                              │
  │   ╔══════════════════════════════════════════╗               │
  │   ║ rung 3: seed file lib/state/demo-*.json  ║ ← we are here │
  │   ║ ─────────  committed, ships with the repo║   for the     │
  │   ╚══════════════════════════════════════════╝   demo path   │
  │                                                              │
  └──────────────────────────────────────────────────────────────┘
```

**Zoom in.** Three rungs, one read path. The lookup function walks them top-to-bottom and returns the first hit. Writes go to rung 1 always, rung 2 only in development; rung 3 is committed via a manual capture flow (not via the request path). Each rung has a different *survives-what* story — restart, instance, repo.

The question this pattern answers: *"how do we get a sensible default for a fresh user (the demo seed), keep dev iteration fast (the file), and serve a warm prod request cheaply (the Map) — all from one lookup site?"*

## Structure pass

**Layers.** Three storage tiers + one read-through function. The function is the structural unit; the tiers are interchangeable backends in priority order.

**Axis: lifetime.** Hold one question constant — *"how long does data at this rung survive?"*

```
  Trace "what survives X?" across the three rungs

  rung           lifetime answer                  recovers from
  ────           ───────────────                  ─────────────
  1: in-memory   this process / this warm         a single request
                 Vercel instance                  (free, fastest)
  2: dev file    this machine's filesystem        a dev-server restart
                 (gitignored)                     (cheap, requires NODE_ENV=development)
  3: demo seed   the git repo                     a fresh checkout
                 (committed)                      (the ground truth fallback)

  the lifetime answer extends with each rung — shorter→longer
```

The state-survival axis is what makes the rungs meaningful: each rung answers "I survive X" with a strictly bigger X than the rung above. Restart? Rung 2+. New machine? Rung 3. Fresh demo user with no auth? Rung 3.

**Seams.**

1. **rung 1 ↔ rung 2: the dev/prod boundary.** `PERSIST = process.env.NODE_ENV === 'development'` at `lib/state/investigations.ts:7` decides whether rung 2 exists. In production the file system is read-only on Vercel, so the rung is *gated by env*, not just by presence.
2. **rung 2 ↔ rung 3: the writability boundary.** Rung 2 is written by the request path (`saveInvestigation`); rung 3 is written by a *manual capture flow* (the dev-only "capture this as demo snapshot" button in `app/page.tsx`). Different write triggers, different intentions: rung 2 says "I saw this just now," rung 3 says "freeze this as the canonical example."
3. **Read seam: the function itself.** `getCachedInvestigation` at `lib/state/investigations.ts:22-28` walks all three; callers see one return value. Drop the function and every consumer would have to implement the cascade itself → drift, missed rungs, inconsistent priority.

Skeleton mapped.

## How it works

### Move 1 — the mental model

You've used `localStorage.getItem('x') ?? fetch('/api/x')` — local first, network as fallback. That's a two-rung cascade. The three-rung version adds *one more level* for the ground-truth case (a committed default that ships with the repo).

Another anchor you've already coded: variable scope lookup in Python/JavaScript — local → enclosing → global → built-in. Same pattern. First match wins; later scopes are ignored. The three-rung store is "variable scope" for cached AgentEvent arrays.

```
  The pattern — read-through fallback chain (3 rungs)

  query: get(key)
              │
              ▼
       ┌────────────────┐    hit
       │ rung 1 (mem)   │ ─────────► return value
       └───────┬────────┘
               │ miss
               ▼
       ┌────────────────┐    hit
       │ rung 2 (file)  │ ─────────► return value
       └───────┬────────┘
               │ miss (or rung gated off in prod)
               ▼
       ┌────────────────┐    hit
       │ rung 3 (seed)  │ ─────────► return value
       └───────┬────────┘
               │ miss
               ▼
             null
```

### Move 2.1 — the read function

The whole pattern in 7 lines at **`lib/state/investigations.ts:22-28`**:

```typescript
export function getCachedInvestigation(insightId: string): AgentEvent[] | null {
  if (mem.has(insightId)) return mem.get(insightId)!;                  // ← rung 1: process-local Map
  const fromFile = PERSIST ? readJson(CACHE_FILE)[insightId] : undefined; // ← rung 2: dev-only file (gated by env)
  if (fromFile) return fromFile;
  const fromDemo = readJson(DEMO_FILE)[insightId];                     // ← rung 3: committed seed (always tried)
  return fromDemo ?? null;
}
```

**Line-by-line read.**

- Line 1 — `mem.has(insightId)`. Rung 1. In-memory `Map<string, AgentEvent[]>` declared at `lib/state/investigations.ts:11`. Process-local: dies on serverless cold-start, dev-server restart, or HMR. Warm-cache speed: O(1), no I/O.
- Line 2 — `PERSIST ? readJson(CACHE_FILE) : undefined`. Rung 2. Gated by `NODE_ENV === 'development'` at line 7. In production this *never* runs — the gate is the env check, not a file existence check. The comment at line 9 names why: "serverless FS is read-only." So rung 2 is literally a different shape per environment.
- Line 4 — `readJson(DEMO_FILE)`. Rung 3. Always tried (no env gate). This is what makes the demo path work for an unauthenticated fresh user on Vercel prod: even with rung 1 cold and rung 2 absent, the committed seed answers.
- Line 5 — `fromDemo ?? null`. Nullish coalesce: the caller distinguishes "not in any rung" from any cached value (including, hypothetically, an empty array — which would be a valid replay of zero events).

The function is a *strict* fallback chain — it doesn't *merge* rungs (no "demo seed + dev overlay"). First hit wins, and the rungs are checked in survives-less → survives-more order so the freshest data shines through.

### Move 2.2 — the write path (asymmetric with read)

Writes don't traverse the chain — they're explicit per rung.

**Rung 1 + rung 2 write, in one function at `lib/state/investigations.ts:30-41`:**

```typescript
export function saveInvestigation(insightId: string, events: AgentEvent[]): void {
  mem.set(insightId, events);                          // ← rung 1: always
  if (PERSIST) {                                       // ← rung 2: dev-only
    const all = readJson(CACHE_FILE);
    all[insightId] = events;
    try {
      writeFileSync(CACHE_FILE, JSON.stringify(all));  // ← read-modify-write; ok for single-writer dev
    } catch {
      /* best effort */                                // ← never let a disk error tank the request
    }
  }
}
```

**Rung 3 write is a different flow entirely** — the dev-only "capture this as demo snapshot" button (`app/page.tsx`, when in dev) hits dedicated routes (`app/api/mcp/capture-demo/`) that re-run the live briefing + each investigation and write `lib/state/demo-*.json` directly. The request path never touches rung 3.

**Why the asymmetry.** Rung 3 is *ground truth* — committed to git, reviewed in PRs. If `saveInvestigation` wrote to it on every request, every dev would have unintended diff churn. The capture flow gates the rung-3 write behind an explicit human action: "I want THIS run to become the canonical demo."

### Move 2.3 — load-bearing skeleton

This is a kernel-shaped concept. Three parts; drop any one and a specific named capability disappears.

**1. Isolate the kernel.** Three rungs queried in priority order, write-through to rung 1 (and rung 2 in dev) only.

```
  kernel (pseudocode):

    read(key) :=
      if rung1[key] exists then return rung1[key]
      if rung2 is active and rung2[key] exists then return rung2[key]
      if rung3[key] exists then return rung3[key]
      return null

    write(key, value) :=
      rung1[key] := value
      if rung2 is active then persist({key: value, ...readJson(rung2_file)})
      (rung3 is never written by this path)
```

**2. Name each part by what BREAKS when it is missing.**

| Part | What breaks if removed |
| --- | --- |
| rung 1 (in-memory Map) | every replay re-reads the JSON file → ~200KB parse + disk I/O per request; warm Vercel instance gains nothing |
| rung 2 (dev file) | dev-server restart loses every saved investigation; reproducing a bug means re-running the live agent every time |
| rung 3 (committed seed) | fresh checkout / new contributor has empty demo path → cannot run the product without auth + Anthropic key |
| the read priority order | swap rungs 1 and 3 and a stale demo seed shadows fresh in-memory captures forever |
| the `PERSIST` gate on rung 2 | prod tries to `writeFileSync` the read-only Vercel FS → throws repeatedly (caught best-effort, but pollutes logs) |
| the write asymmetry (request doesn't write rung 3) | every dev's runs would auto-commit demo snapshots → uncontrolled git churn |

**3. Separate skeleton from optional hardening.**

The kernel is "three sources, ordered lookup, first hit wins." Optional hardening (all of which is currently present): the env gate on rung 2; the try/catch around `writeFileSync`; the empty-object fallback in `readJson` for missing/corrupt files. Each of these can be removed without breaking the *concept* — they're each handling a specific failure mode (read-only FS, disk error, malformed JSON).

The concept itself is the three rungs queried in order. Everything else is "what happens at each rung when something goes wrong."

### Move 2.4 — the parallel auth implementation

The same pattern appears at `lib/mcp/auth.ts` for OAuth state. Three rungs, slightly different shapes.

```
  lib/mcp/auth.ts — auth store, three rungs

  rung 1 (process):  memStore: Map<sessionId, SessionAuthState>   ← always
  rung 2 (dev):      .auth-cache.json                              ← PERSIST gate
  rung 3 (prod):     encrypted httpOnly cookie (bi_auth)           ← ALS-scoped, AES-256-GCM
```

The third rung is *not* a committed seed — it's the AsyncLocalStorage-scoped cookie store. Same three-rung *structure*; the rung-3 backend differs because the use case differs. Demo events ship with the repo (committed seed makes sense); OAuth tokens are per-user secrets (cookie makes sense).

The read function at `lib/mcp/auth.ts:113-123` mirrors the same shape:

```typescript
function readAll(): Store {
  const ctx = requestStore.getStore();
  if (ctx) return ctx.store;                                         // ← rung 3 (prod): ALS-scoped, cookie-backed
  if (!PERSIST) return Object.fromEntries(memStore);                 // ← rung 1 (test): isolated in-memory
  try {
    if (existsSync(CACHE_FILE)) return JSON.parse(readFileSync(CACHE_FILE, 'utf8')) as Store;  // ← rung 2 (dev): file
  } catch {
    /* corrupt/unreadable cache — treat as empty */
  }
  return {};
}
```

**The order is different.** Auth checks prod-cookie first (because in prod that's the only thing that works); investigations check process-mem first (because warm-cache wins). The *primitive* (three rungs, ordered, first hit wins) is identical; the *priorities* are per-domain.

This duplication is worth naming as a **convention, not a coincidence**. If a fourth subsystem needs the same shape, a shared `tieredStore<T>` utility is the next refactor — but with N=2 instances the duplication is cheap and the per-instance shape (different gates, different backends) wants to vary.

### Move 2.5 — layers-and-hops

How one cache lookup travels through the rungs, in time, with each hop labeled.

```
  Layers-and-hops — one getCachedInvestigation call

  ┌─ Service layer ─────────────────────────────────────────────────┐
  │  GET /api/agent?insightId=X (no live=1)                          │
  │      │ hop 1: getCachedInvestigation(X)                          │
  │      ▼                                                            │
  ├─ Storage layer (in-process) ─────────────────────────────────────┤
  │  ╔ rung 1: mem.has(X) ═════════════════╗                         │
  │  ║   yes → return mem.get(X)            ║ ── hop 2a: hit, return │
  │  ╚════════════════════════════════════ ╝                         │
  │      │ no                                                         │
  │      ▼ hop 2b: env gate check                                    │
  │  ╔ rung 2 (dev only): PERSIST=true ═════╗                         │
  │  ║   readJson('.investigation-cache')   ║                         │
  │  ║   if X in file → return file[X]      ║ ── hop 3a: hit, return │
  │  ╚════════════════════════════════════ ╝                         │
  │      │ no (or prod)                                               │
  │      ▼ hop 3b                                                     │
  │  ╔ rung 3: readJson('demo-investigations.json') ═════════════╗   │
  │  ║   if X in file → return file[X]                            ║   │
  │  ║   else → null                                              ║   │
  │  ╚════════════════════════════════════════════════════════════╝   │
  │      │                                                            │
  │      ▼ hop 4: result (events or null)                            │
  ├─ Service layer ───────────────────────────────────────────────────┤
  │  if events: filterByStep + paced replay (see 02-replay-…)         │
  │  if null: continue to live agent run                              │
  └──────────────────────────────────────────────────────────────────┘
```

Every hop is labeled. The env gate at hop 2b is the part that genuinely *changes the shape of the diagram* between dev and prod — dev has 3 hops to lookup, prod has 2.

### Move 3 — the principle

Tiered caches are a textbook pattern (L1/L2/L3 in CPUs, browser cache → CDN → origin, Memcached → DB). The lesson hidden in *this* instance is that **the rungs aren't all the same kind of thing**. Rung 1 is RAM, rung 2 is local disk, rung 3 is the git repo. They have different *write authorities* (request, request, human) and different *survival domains* (process, machine, repo).

The general principle: when a system has a "default that ships with the product," a "user-edited working state," and a "warm cache for performance," they're tiers of the same lookup. Don't model them as three different APIs — model them as one lookup function with a priority order. The priority IS the policy: freshest-survives-most-recent at the top, ground-truth-fallback at the bottom.

The corollary: **writes don't have to mirror the read chain.** Reads cascade by priority; writes go where they belong. Writing to a committed seed on every request would be insane; reading from one as a fallback is exactly right.

## Primary diagram

The full picture — three rungs, asymmetric writes, two parallel instances of the same pattern.

```
  Three-rung mem/file/seed store — used twice in this codebase

  READS (cascading, first hit wins)              WRITES (per rung, asymmetric)
  ───────────────────────────────────            ──────────────────────────────

  getCachedInvestigation(id):                    saveInvestigation(id, events):
                                                   mem.set(id, events)        ← always
    rung 1: mem.has(id)?           ─►hit          if (PERSIST):
                                                    writeFileSync('.investigation-cache.json')
       │ miss                                       (best-effort, try/catch)
       ▼
    rung 2: PERSIST?
       readJson('.investigation-cache.json')      capture flow (separate route):
         id in file? ─►hit                          /api/mcp/capture-demo →
                                                     writeFileSync('lib/state/demo-investigations.json')
       │ miss (or prod)                              (gitignored cache is dropped from prod;
       ▼                                              this seed is committed)
    rung 3: readJson('demo-investigations.json')
       id in file? ─►hit
       │ miss
       ▼
       null


  Same shape, second instance — readAll() for OAuth at lib/mcp/auth.ts:113-123:

    rung 1 (test): memStore Map                ← _clearAuthStore() resets it
    rung 2 (dev):  .auth-cache.json            ← PERSIST gate, writeFileSync on patchState
    rung 3 (prod): bi_auth cookie (AES-GCM)    ← ALS-scoped, withAuthCookies seeds + flushes per request
```

## Elaborate

Tiered storage shows up everywhere because it solves a tension everyone has: you want fast, you want durable, and you want a ground-truth default — and no single backend gives all three. The classic CPU cache hierarchy (L1: SRAM, fast/small/expensive; L2: bigger/slower; L3: bigger again; main memory: huge/slow/cheap) is the model. Application-level cache hierarchies (browser→CDN→origin, Memcached→Postgres, ActiveRecord query cache→DB) are the same shape.

The wrinkle here is the *committed seed* — rung 3 isn't a slower cache, it's a default that ships with the product. The closest precedent is **rails fixtures** + the dev DB seed file, or **storybook stories** that ship hand-rolled state for the component browser. Both have the "humans curate this, request paths read it" asymmetry this code has.

The AsyncLocalStorage backend at `lib/mcp/auth.ts:47` is a small masterpiece worth reading separately. It exists because Next.js's request-vs-response cookie split returns the *old* value after a `set` within the same request — so the OAuth provider's many synchronous read/write calls would each fight that. ALS scopes a per-request store seeded once from the cookie and flushed once at the end. The pattern is "**load on entry, mutate freely, persist on exit**" — also a kind of three-rung pattern in time (cookie → ALS → cookie) instead of in space.

**Adjacent concepts:**
- **Read-through cache** — same pattern, two rungs (typically cache→DB).
- **Cache-aside** — caller is responsible for the lookup cascade, not the storage layer.
- **Write-through vs write-back** — this code is write-through on rungs 1+2 (sync write to both), and write-skipping on rung 3 (never written by request path).
- **Loader chains in Webpack / Babel** — different domain (transformation pipeline), same "ordered cascade" primitive.

**Read next:**
- `02-replay-from-snapshot-with-paced-emission.md` — what the cache feeds into.
- `04-dual-write-send-to-stream-and-store.md` — where rung 1 gets populated.
- `05-auth-secret-flake-postmortem.md` — the auth-store instance bit us in production.

## Interview defense

**Q: Why three rungs and not two?**
A: Two rungs (in-memory + disk) covers fast-vs-durable but misses the "fresh user, no auth, no saved runs" case. The committed seed at rung 3 is the ground-truth default that ships with the product — it's what makes `/api/briefing?demo=cached` work for a stranger hitting the deployed Vercel URL with no cookies. The third rung isn't a slower cache, it's a different *kind of thing*: human-curated, committed to git, never written by request paths. The asymmetry between read (all three cascade) and write (rungs 1+2 from requests, rung 3 from a deliberate capture flow) is the load-bearing detail.

> *Sketch:* the three-rungs diagram with the survives-what column.

**Anchor:** "Rung 3 is product default, not slow cache."

**Q: Why the `PERSIST` env gate on rung 2 instead of "try to write, ignore if it fails"?**
A: Vercel's serverless filesystem is read-only — `writeFileSync` *would* throw on every request. The catch swallows it, but the logs pile up and the attempt itself isn't free (the read-modify-write on rung 2 reads the file too, and there is no file). The env gate makes the intent explicit: rung 2 is a *dev-only* tier. Production has rung 1 (warm-instance Map) + rung 3 (committed seed). Two-rung in prod, three-rung in dev. Naming the env is the documentation that this shape change is deliberate.

> *Sketch:* dev path with 3 rungs vs prod path with rung 2 grayed out, both feeding the same reader.

**Anchor:** "Rung 2 is dev-only; prod is two-tier."

**Q: Why doesn't `saveInvestigation` write rung 3?**
A: Rung 3 is committed to git. If every live run wrote it, every developer would have unintended `lib/state/demo-investigations.json` diffs in every PR. The capture flow is the deliberate "I want THIS to be the canonical demo" gesture — it's a dev-only button (`app/page.tsx`) that hits dedicated routes (`/api/mcp/capture-demo`) and writes the seed explicitly. Read-cascades cheaply; writes are intentional and per-rung.

> *Sketch:* the reads-vs-writes side-by-side from the primary diagram.

**Anchor:** "Writes go where they belong; reads cascade."

**Q: The same pattern appears in `lib/mcp/auth.ts` — is that duplication?**
A: It's a convention with two instances. The kernel is identical (three rungs, ordered lookup, first hit wins). The per-instance details differ on purpose: investigation rung 3 is a committed seed (ground-truth default), auth rung 3 is the encrypted cookie (per-user secret); investigation cascade prioritises mem first (warm-cache wins), auth cascade prioritises cookie first (prod constraint). At N=2 the duplication is cheap and the variation is meaningful. At N=3 I'd extract a `tieredStore<T>` utility; the cost of the extraction equals the cost of one more copy.

> *Sketch:* the two read functions side by side.

**Anchor:** "Convention not coincidence; abstract when N=3."

**Q: How do you reproduce a production bug with this store?**
A: Production hit, user reports a bad investigation. Locally: `git pull` (in case the seed has the same bug), reproduce against the live alpha — when the bug fires, `saveInvestigation` has already written `.investigation-cache.json`. Now I can refresh the page indefinitely, the cache-first branch in `/api/agent` replays the saved events deterministically, and I have a stable fixture to step-debug through. If the bug is worth keeping, I hit "capture this as demo snapshot" and the seed becomes a regression artifact in the next PR.

> *Sketch:* "live failure → rung 2 auto-save → replay → manual capture → rung 3 commit."

**Anchor:** "The cache is the bug report."

## See also

- `02-replay-from-snapshot-with-paced-emission.md` — what reads from these rungs.
- `04-dual-write-send-to-stream-and-store.md` — where the writes originate.
- `05-auth-secret-flake-postmortem.md` — the parallel auth-store instance, broken by missing AUTH_SECRET.
- `audit.md` § 2 (reproduction-and-evidence), § 6 (state-snapshots-and-debugging-boundaries).
