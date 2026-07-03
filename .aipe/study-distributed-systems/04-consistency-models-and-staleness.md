# Consistency Models and Staleness

*Industry name: bounded staleness · read-through cache · Type: Industry standard*

## Zoom out — where this concept lives

Consistency asks a question with teeth: when I read, what am I *allowed* to see? Strong consistency says "always the latest write." Eventual says "eventually the latest, but not right now." Bounded staleness sits in between: "up to N seconds old, no worse."

```
  Zoom out — the consistency surface in this repo

  ┌─ Client band ──────────────────────────────────────────┐
  │  browser · reads whatever the SSE stream sends          │
  │            no consistency guarantees below              │
  └─────────────────────────┬──────────────────────────────┘
                            │
  ┌─ Server band ───────────▼──────────────────────────────┐
  │                                                         │
  │  ★ THIS FILE: what "consistent" means for shared state ★│
  │                                                         │
  │  · 60s response cache (per Vercel instance)             │
  │  · in-mem investigations cache (per Vercel instance)    │
  │  · auth cookie (per browser session, encrypted)         │
  │                                                         │
  └─────────────────────────┬──────────────────────────────┘
                            │
                            ▼
                    ┌──────────┐
                    │MCP server│  ← the truth we cache from
                    └──────────┘
```

There is no cross-node consistency in this repo — no replicas, no eventual convergence protocol, no quorum reads. What there is: **bounded staleness at 60 s** (the response cache), and **per-instance state that gets no consistency guarantees at all** (the investigation cache). Naming that plainly is the whole file.

## Zoom in — narrow to the concept

The one applied consistency question in this codebase is: "what does the model see when it reads via the cache?" Answer: **the most recent successful non-error response within the last 60 seconds, per Vercel instance.** That's bounded staleness, not strong consistency. Everything else — the investigations Map, the demo snapshot — is opportunistic and per-instance.

## Structure pass

### Layers

- **Browser** — has no shared state to be consistent about. Reads the stream once.
- **Vercel function instance** — the 60 s response cache, the in-memory investigations Map.
- **Shared, cross-instance** — the encrypted auth cookie (browser-owned), the demo JSON snapshot (git-committed, effectively read-only).
- **External** — the MCP server's own consistency (out of scope; different guide).

### One axis held constant — "what's the guaranteed freshness?"

```
  Axis: freshness bound at each layer

  browser                → whatever it displays now
                           reload → fresh stream from server
                           freshness = "as of this stream"

  Vercel instance A      → cache hit: up to 60s old
                           cache miss: fresh (server round-trip)

  Vercel instance B      → cache is EMPTY on cold start
                           first call: always fresh

  auth cookie            → 10-day TTL (AUTH_COOKIE_MAX_AGE)
                           any instance can decrypt any cookie
                           cross-instance = consistent by construction

  demo snapshot          → git-committed, changes only on deploy
                           strong per-deploy, no runtime updates

  MCP server truth       → whatever the tenant's real system says
                           we don't reason about its internal consistency
```

The interesting flip: **instance A vs instance B** for the response cache. Same key, same 60 s TTL, but they don't share. That's per-instance bounded staleness with zero convergence between instances.

### Seams

- **Cache read seam** (`bloomreach-data-source.ts:147`): if hit AND not expired, return cached. Otherwise round-trip. This is the staleness bound.
- **Cross-instance seam**: doesn't exist for the response cache or the investigations Map. Only the auth cookie crosses instances, and it crosses via the browser (round-trip through the client).

## How it works

### Move 1 — the mental model

You've written a memoized HTTP fetch with a TTL — that's exactly this pattern. The distributed-systems angle: since Vercel autoscales, "the cache" isn't one cache. It's N caches, one per instance, each independently 60 s stale.

```
  The pattern — per-instance bounded staleness

    request 1              request 2              request 3
        │                      │                      │
        ▼                      ▼                      ▼
  ┌──────────┐          ┌──────────┐          ┌──────────┐
  │Instance A│          │Instance A│          │Instance B│
  │ (cache X)│          │ (cache X)│          │ (cache ∅)│
  └────┬─────┘          └────┬─────┘          └────┬─────┘
       │                     │                     │
   fresh fetch          cache hit                fresh fetch
   populate X             (< 60s)               populate X'
       │                     │                     │
       ▼                     ▼                     ▼
    server               (no server)             server

  A and B never share. Each has its own X.
  Bounded staleness AT EACH INSTANCE. Not across.
```

The kernel: **cache with TTL bounds staleness in one place; scale-out multiplies the number of places.** If you want cross-instance freshness, you need external state (Redis, KV, cookie). This repo doesn't reach for that yet.

### Move 2 — the walkthrough

#### The response cache — bounded staleness at 60 s

The read is guarded by expiry:

```ts
// lib/data-source/bloomreach-data-source.ts:147
if (!options.skipCache) {
  const cached = this.cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { result: cached.result as T, durationMs: 0, fromCache: true };
  }
}
```

`expiresAt > Date.now()` is the entire staleness contract. If the entry hasn't expired, the cached value is served regardless of how many times the underlying data has changed on the MCP server. That's a **read-your-writes-within-instance** guarantee for the model — if the same investigation writes tool_result X, then asks for the same tool_call, it sees X.

**Failure mode this hides**: the model can't see writes from *another* instance's calls. Not a problem because there's nothing coordinated — but if two instances processed the same investigation concurrently (impossible today; the browser only opens one stream), they'd diverge.

```
  Staleness bound at read time

  now = T
  entry.expiresAt = T + 45s   → return cached  (bounded 45s stale)
  entry.expiresAt = T - 5s    → miss, refetch  (staleness bound reset)
```

#### The investigations Map — no consistency guarantee

`lib/state/investigations.ts:11` — top-level `mem` Map. Written in `saveInvestigation`, read in `getCachedInvestigation`. Purely opportunistic:

```ts
// lib/state/investigations.ts:22
export function getCachedInvestigation(insightId: string): AgentEvent[] | null {
  if (mem.has(insightId)) return mem.get(insightId)!;
  const fromFile = PERSIST ? readJson(CACHE_FILE)[insightId] : undefined;
  if (fromFile) return fromFile;
  const fromDemo = readJson(DEMO_FILE)[insightId];
  return fromDemo ?? null;
}
```

Three-tier read: in-memory Map (this instance) → dev file (this dev machine) → git-committed demo snapshot. In production only the first and third tiers exist (Vercel FS is read-only). No convergence. No cross-instance sharing.

**This is opportunistic replay, not consistency**. If instance A ran the investigation and cached it, only instance A can replay it. Instance B on a subsequent request would recompute from scratch (or serve the demo snapshot if the insight matches one).

#### The auth cookie — the exception

The one piece of "distributed state" done right. `lib/mcp/auth.ts:86` `withAuthCookies`:

```ts
// lib/mcp/auth.ts:86
export async function withAuthCookies<T>(fn: () => Promise<T>): Promise<T> {
  if (process.env.NODE_ENV !== 'production') return fn();
  const raw = (await cookies()).get(AUTH_COOKIE)?.value;
  const ctx: RequestStore = { store: raw ? decryptStore(raw) : {}, dirty: false };
  const result = await requestStore.run(ctx, fn);
  if (ctx.dirty) {
    (await cookies()).set(AUTH_COOKIE, encryptStore(ctx.store), {…});
  }
  return result;
}
```

Any Vercel instance can decrypt any cookie because the cookie is encrypted under `AUTH_SECRET` (shared across all instances via env var). **This achieves strong consistency across instances by construction**: the state lives in the browser, and the crypto key is shared. No coordination protocol needed.

```
  Auth cookie — strong consistency by construction

  Browser
    ↑↓ cookie (AES-256-GCM under AUTH_SECRET)
  ┌─────────────┬─────────────┐
  │ Instance A  │ Instance B  │
  │ decrypt(k)  │ decrypt(k)  │  same key, same view
  │ mutate      │ mutate      │  writes race, but each
  │ encrypt(k)  │ encrypt(k)  │  request is a single-writer
  └─────────────┴─────────────┘  read-modify-write on ITS cookie
                                 (not a shared row)
```

The race that could exist — two tabs updating the auth store concurrently — doesn't matter because each browser holds ONE cookie. Cross-tab, whoever writes last wins. Since the only writes are OAuth token refreshes (rare, minutes apart), that's fine.

#### The AsyncLocalStorage read-through — request isolation

Inside a single request, the auth store operates on a snapshot. `lib/mcp/auth.ts:47`:

```ts
const requestStore = new AsyncLocalStorage<RequestStore>();
```

The upstream comment explains why: "To avoid Next's request-vs-response cookie split (a read *after* a set in the same request returns the OLD value), we never touch the cookie per provider-method call. `withAuthCookies` seeds an AsyncLocalStorage-scoped store from the cookie ONCE at the start of the request and flushes it back ONCE at the end."

**This is a read-your-writes guarantee within a request**: any read after a write in the same request sees the new value. Achieved by keeping the in-flight state in ALS instead of round-tripping through Next's cookie API.

```
  ALS-scoped store — read-your-writes within one request

  request start
    │
    │ decrypt cookie → seed store
    │
    ├─ provider.saveTokens(t)     → store.tokens = t; dirty=true
    ├─ provider.tokens()          → store.tokens (sees the write)
    ├─ provider.saveClientInfo(i) → store.clientInfo = i; dirty=true
    │
    │ if dirty → encrypt store → set cookie
  request end
```

### Move 2.5 — current state vs future state

```
  Phase A (now):                    Phase B (if scale demands):
  ──────────────                    ─────────────────────────

  · response cache PER instance     · shared cache in Redis / KV
    60s TTL, no sharing               (Vercel KV, Upstash)
                                    · cross-instance dedup
  · investigations Map PER instance · shared investigations store
    opportunistic replay              (durable, queryable)

  · auth cookie shared              · unchanged; already right
    (cross-instance, encrypted)     · maybe a KV lookup for session
                                      auth if cookies grow

  when B becomes worth it:
    · Bloomreach 429s dominate → shared cache cuts requests
    · users demand history → shared investigations enable it
    · multi-tab investigations → shared state avoids divergence
```

The takeaway: **most of what's per-instance today wouldn't need to change if users stayed single-tab, single-investigation.** The consistency story only becomes a limitation when the product grows.

### Move 3 — the principle

**Bounded staleness is a real consistency model, not "we didn't bother."** Naming your staleness bound (60 s here) is a design decision with tradeoffs: freshness vs load on the upstream. A cache without a stated bound is a bug waiting to be called; a 60 s TTL is a legible contract. The two questions to ask when you write a cache: "how stale is 'stale enough'?" and "who bounds the staleness?" This repo's answer: 60 s, at the McpDataSource layer.

## Primary diagram

The staleness story, one frame:

```
  Consistency + staleness bounds — the whole picture

  ┌─ Browser ──────────────────────────────────────────────┐
  │  state: cookies (bi_session, bi_auth),                  │
  │         localStorage[bi:mcp_config]                     │
  │  consistency: single-writer per browser; strong within  │
  └─────────────────────────┬──────────────────────────────┘
                            │
  ┌─ Vercel instance A ─────▼──────────────────────────────┐
  │  ┌ 60s response cache ─┐   ┌─ investigations Map ────┐ │
  │  │ bounded staleness   │   │ opportunistic replay    │ │
  │  │ 60s TTL             │   │ per-instance only       │ │
  │  │ no-cache-on-error   │   │ no cross-instance share │ │
  │  └─────────────────────┘   └─────────────────────────┘ │
  │  ┌ ALS auth store ────┐                                │
  │  │ read-your-writes   │                                │
  │  │ within one request │                                │
  │  └────────────────────┘                                │
  └────────────────────────────────────────────────────────┘
  ┌─ Vercel instance B (independent) ──────────────────────┐
  │  same shape, EMPTY caches on cold start                 │
  │  independent staleness bound (also 60s, own clock)      │
  └─────────────────────────┬──────────────────────────────┘
                            │
  ┌─ Auth cookie (cross-instance, browser-durable) ─────────┐
  │  encrypted under AUTH_SECRET                            │
  │  strong consistency by construction                     │
  └─────────────────────────────────────────────────────────┘
```

## Elaborate

Formal consistency models: linearizable > sequential > causal > eventual. Bounded staleness is a variant of eventual with a staleness ceiling — Cosmos DB and Cloudant use it as a first-class read tier. Read-your-writes is a *session guarantee*, not a system-wide consistency model, and it's what ALS gives you within one request.

**Cache invalidation** — the second-hard-problem-in-CS story — is delegated here to the TTL. No pub/sub invalidation, no version stamps, no LRU eviction (only TTL). That's fine because:

- One writer per cache: the model, feeding through McpDataSource.
- Read-only underlying data: a 60 s stale read of `list_projects` is still correct enough to reason about.
- Bounded absolute lifetime: 60 s is the whole TTL; explicit `skipCache` overrides for the `/debug` "force fresh" path.

**The auth cookie's crypto is what makes distributed state cheap here.** Every alternative — shared Redis session, JWT with backend validation, cookie-keyed KV lookup — trades a round-trip for stronger guarantees. AES-256-GCM under a shared secret gives you "any instance can act on any request" without any round-trip. See `lib/mcp/auth.ts:62` for the encryption; `lib/mcp/auth.ts:38-46` for the comment on why this choice.

Related: `study-database-systems` walks the cookie's storage-level story (why AES-GCM, why SameSite=None for the OAuth return). `study-security` walks the trust boundary. This file only cares that "any instance can read any cookie" is a strong-consistency property achieved without coordination.

## Interview defense

**Q: "What's your cache's consistency model?"**

A: Bounded staleness at 60 s, per Vercel instance. Cache key is `${name}:${JSON.stringify(args)}`; entries expire at `now + 60_000`. A read that finds a fresh entry serves it; otherwise the retry ladder runs. No cross-instance sharing — instance A's cache and instance B's cache are independent.

```
   inst A cache: [X, 45s left]  →  read X → hit
   inst B cache: [empty]        →  read X → fresh fetch, populate

   → same X, different instances, different freshness
```

**Load-bearing gotcha**: on Vercel's autoscaling model, "the cache is warm" is a per-instance assumption. First request to a new instance is always a cache miss, so the retry ladder has to hold every time. The cache is opportunistic; correctness lives in the ladder.

**Q: "How does the auth cookie stay consistent across instances?"**

A: Cryptographic construction. Every Vercel instance has `AUTH_SECRET` in its env; they all derive the same AES-256-GCM key. Any instance can decrypt any cookie the app has ever set. The state lives in the browser; the instances are stateless. No coordination protocol, no shared session store.

**Anchor**: `lib/mcp/auth.ts:62` (aesKey) and `lib/mcp/auth.ts:86` (withAuthCookies — ALS-scoped read-through).

**Q: "When would you need to move to a shared cache?"**

A: When Bloomreach 429s dominate the latency budget. Right now the cache is per-instance and the retry ladder covers the 429 case. If load grew such that instances were being scaled aggressively and each cold instance was triggering fresh 10 s retry waits, a shared cache (Vercel KV, Upstash) would cut those. Until then, the 60 s per-instance TTL is doing enough.

## See also

- `03-idempotency-deduplication-and-delivery-semantics.md` — the cache's dedup role.
- `01-distributed-system-map.md` — where the shared state actually crosses instances (only the cookie).
- `09-distributed-systems-red-flags-audit.md` — the per-instance cache is the top-of-list risk.
