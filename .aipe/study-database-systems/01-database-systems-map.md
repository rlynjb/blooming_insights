# Database Systems Map

## Subtitle

The storage substrate — what holds bytes, for how long, with what guarantees · Project-specific.

## Zoom out, then zoom in

Okay — here's the whole thing. You're looking at a Next.js app talking to one of two data sources via the SAME tool surface: Bloomreach upstream (live mode) or `lib/data-source/synthetic-data-source.ts` (demo mode). Neither side touches a database in this repo. The synthetic source is in-process, deterministic, uses no persistent storage. The main app holds everything in `Map`s.

```
  Zoom out — where storage lives in blooming insights

  ┌─ UI layer ──────────────────────────────────────────────────────────────┐
  │  feed / investigate / debug — React components, no client-side cache    │
  │  sessionStorage handoff of an insight blob from feed → /investigate     │
  └────────────────────────────────────┬────────────────────────────────────┘
                                       │  HTTP
  ┌─ Service layer (Vercel function) ──▼────────────────────────────────────┐
  │                                                                         │
  │   ★ THE WHOLE STORAGE STORY ★ — Map-shaped, dies with the process       │
  │                                                                         │
  │   in-memory:     MCP response cache (Map+TTL), schema singleton,        │
  │                  insights Map, investigations Map, anomalies Map,       │
  │                  syntheticWorkspaceSchema const (no state, just data)   │
  │   per-request:   AsyncLocalStorage-scoped auth store (prod)              │
  │   dev-only:      .auth-cache.json, .investigation-cache.json (JSON files)│
  │   committed:     lib/state/demo-*.json (read-only seed fixtures)         │
  │   browser:       bi_session cookie (uuid), bi_auth cookie (AES-GCM blob) │
  └────────────────────────────────────┬────────────────────────────────────┘
                                       │  network (live mode only)
                                       ▼
                            ┌─ Bloomreach (upstream) ──────┐
                            │  EQL engine; opaque          │
                            │  rate-limited globally per   │
                            │  user; we never see schemas, │
                            │  plans, or indexes           │
                            └──────────────────────────────┘
```

Now zoom in. The question this section answers: **what counts as a "datastore" here, and what guarantees does each one make to its callers?** The honest answer is: zero engines, several Map-shaped state holders, and a single durable durable layer (the cookie). Everything else evaporates on cold start.

## Structure pass

Three layers, one axis, three seams.

### The layers

```
  Service-layer storage, by lifetime

  ┌─ shortest lifetime ──────────────────────────────────────────┐
  │  per-request:  AsyncLocalStorage auth store                  │  lives ms
  │                (lib/mcp/auth.ts L47)                         │  seeded from
  │                                                              │  cookie, flushed
  │                                                              │  back on exit
  └──────────────────────────────────────────────────────────────┘
  ┌─ medium lifetime ────────────────────────────────────────────┐
  │  per-instance: MCP cache (60s TTL)                           │  lives until
  │                schema cache (no TTL — module global)         │  instance is
  │                insights / investigations / anomalies Maps    │  evicted by
  │                syntheticWorkspaceSchema const (read-only)    │  Vercel (mins
  │                                                              │  to hours)
  └──────────────────────────────────────────────────────────────┘
  ┌─ deploy-or-longer lifetime ──────────────────────────────────┐
  │  cookie:       bi_session (10d), bi_auth (10d, encrypted)    │  survives
  │  file (dev):   .auth-cache.json, .investigation-cache.json   │  survives
  │  committed:    demo-*.json fixtures                          │  survives deploys
  └──────────────────────────────────────────────────────────────┘
```

### The axis — `who can see this read, and when?`

Trace the same question across all three layers and you find the load-bearing fact about this codebase.

```
  axis: "if I write here, who reads my write?"

  per-request store     →   only the current request, then it's gone
  per-instance store    →   only requests on THIS warm Node process
  cookie store          →   only the current browser, but persistently

  there is NO row that any two arbitrary requests are guaranteed to see.
  that's the whole architectural fact.
```

### The seams — where the axis-answer flips

Three boundaries matter:

```
  seam 1: function invocation boundary
   ┌─ request A ─┐         ┌─ request B ─┐
   │ writes to   │ ─────► │ reads from   │   ← if same warm instance: hit
   │ Map         │         │ Map          │      different instance:   miss
   └─────────────┘         └─────────────┘      cold start:            empty

  seam 2: deploy boundary
   ┌─ deploy N ──┐         ┌─ deploy N+1 ┐
   │ Map full of │ ─────► │ Map is empty │   ← every deploy wipes state
   │ insights    │         │              │      (cookies + committed files
   └─────────────┘         └─────────────┘       survive; nothing else does)

  seam 3: process boundary (dev vs prod)
   ┌─ dev (local) ───────┐         ┌─ prod (Vercel) ──────┐
   │ one Node, one PID,   │ ─────► │ multiple ephemeral    │
   │ files OK to write    │         │ instances, FS RO,     │
   │ (.investigation-cache)│         │ only cookie persists  │
   └─────────────────────┘         └──────────────────────┘
```

Skeleton mapped — three lifetimes, one axis (who sees the write), three seams (request, deploy, environment). Now into the mechanics.

## How it works

### Move 1 — the mental model

You know how `useState` gives you a value that's local to one React component instance, and a sibling component re-mounting starts over with a fresh state? Server storage here works the same way at a different altitude — each warm Vercel instance has its own `Map`s, and a cold start (or a different instance on the next request) gets fresh empty ones.

The pattern is a **lifetime hierarchy** — bytes live until the smallest enclosing scope dies. Nothing in this codebase escapes the process scope without help from a cookie or a committed file.

```
  the lifetime hierarchy — bytes survive until the dotted box dies

       Vercel deployment ........................
       ┌────────────────────────────────────────┐
       │  warm Node process ....................│ ← Maps live here
       │  ┌──────────────────────────────────┐  │
       │  │  one request handler ............│  │ ← ALS auth ctx lives here
       │  │  ┌──────────────────────────┐   │  │
       │  │  │  one function call ......│   │  │ ← locals
       │  │  └──────────────────────────┘   │  │
       │  └──────────────────────────────────┘  │
       └────────────────────────────────────────┘

       cookies + committed files escape the outermost box.
       Map state does not.
```

### Move 2 — the moving parts, one at a time

**Move 2a — the MCP response cache (the closest thing to a DB).**

This is a real key-value store. Keys are `toolName + JSON.stringify(args)`. Values are `{result, expiresAt}`. Default TTL is 60 seconds. It's the only piece of storage in the app whose explicit job is to make repeated reads cheap.

Bridge: think of it as `localStorage.setItem` with an expiry timestamp baked in — except it's in Node, it's a `Map` not a JSON serializer, and it's a hot cache, not durable.

```
  pattern — single-tier KV cache with absolute-time expiry

  ┌─ callTool(name, args) ─────────────────────────────────────────┐
  │                                                                 │
  │  key = name + serialize(args)                                  │
  │  entry = cache.get(key)                                        │
  │                                                                 │
  │  if entry exists AND entry.expiresAt > now:                    │
  │     return entry.result, fromCache=true       ← hit            │
  │                                                                 │
  │  result = liveCall(name, args)                ← miss, fetch    │
  │  if result is not an error:                                    │
  │     cache.set(key, { result, expiresAt: now + ttl })            │
  │  return result, fromCache=false                                │
  └────────────────────────────────────────────────────────────────┘
```

What breaks when each part is missing:

- **drop the TTL** → cache returns stale data forever (a 1-hour-old briefing presented as current)
- **drop the "don't cache errors" check** → a transient 429 from Bloomreach poisons the cache for the next 60 seconds; every retry hits the cached error, not a fresh call
- **drop the absolute `expiresAt` and use elapsed time** → a long-running request that started before the entry expired could see it expire mid-flight; absolute time is simpler and correct here

**Move 2b — the schema singleton (process-global cache, no expiry).**

`bootstrapSchema()` calls four MCP tools (`get_event_schema`, `get_customer_property_schema`, `list_catalogs`, `get_project_overview`), stitches them into a `WorkspaceSchema`, and stores the result in a module-level variable. Subsequent calls return the cached value forever.

Bridge: think of the React `useMemo` pattern with an empty dependency array — compute once, reuse forever — except at process scope, not component scope.

```
  pattern — lazy singleton, no invalidation

  module-level state:  cached: WorkspaceSchema | null = null

  bootstrapSchema():
    if cached is not null:
       return cached                              ← reuse forever
    project = resolveProject()                    ← chain of MCP calls
    cached = buildSchemaFrom(...four tool calls)
    return cached
```

What breaks when each part is missing:

- **drop the null guard** → every briefing re-runs four sequential rate-limited MCP calls (~5-10s extra each time)
- **drop the chain order** (`list_cloud_organizations → list_projects → project_id`) → every tool call after fails because Bloomreach requires `project_id` on the envelope
- **never invalidate** → if the workspace schema changes upstream (new event type registered), this process won't see it until the instance dies

The "no invalidation" choice is deliberate — workspaces don't change schema mid-session, and a stale schema is a smaller cost than the rate-limit budget you'd burn re-fetching.

**Move 2c — the in-process state Maps (the feed and the investigations).**

Three `Map`s in `lib/state/insights.ts`: `insights`, `investigations`, `anomalies`. One `Map` plus a JSON file fallback in `lib/state/investigations.ts`. These hold the output of the agent runs — the current briefing's insights, the current investigation's event log.

Bridge: think of a singleton class in any backend you've written that holds "the cache of recent things" without explicit eviction. Here, the eviction policy is "the next briefing wipes the previous one" (`insights.clear()` on every `putInsights()` call).

```
  pattern — replace-on-write, single-writer per instance

  putInsights(items):
    insights.clear()                  ← previous briefing erased
    anomalies.clear()
    for each item in items:
       insights.set(item.id, item)
       anomalies.set(item.id, raw[i])

  listInsights():
    return all values from insights Map  ← whatever the LAST writer set
```

What breaks when each part is missing:

- **drop the `.clear()` calls** → a warm instance accumulates insights from every briefing run ever; the feed shows yesterday's anomalies next to today's
- **two concurrent `putInsights()` calls** → one's `clear()` runs between the other's `set()` calls; partial state visible
- **the assumption that "the briefing's results live here"** breaks the moment a second Vercel instance serves a request — that instance never saw `putInsights()` and returns `[]`

The investigations Map is paired with `.investigation-cache.json` in dev so a hot-reload doesn't wipe an in-progress investigation. In production that file path is read-only (serverless FS), so the file branch is skipped and only the in-memory map exists — meaning the client sends the insight blob back on every navigation (the `?insight=...` query param fallback in `app/api/agent/route.ts` L37-47 exists for exactly this reason).

**Move 2d — the auth store, with three backends.**

`lib/mcp/auth.ts` is the most database-shaped file in the codebase, because it actually has to **persist across requests** and the author confronted that. The shape:

```
  pattern — backend selection by environment

  if process.env.NODE_ENV === 'development':
     backend = JSON file (.auth-cache.json)
  if process.env.NODE_ENV === 'test':
     backend = in-memory Map (isolated per test run)
  if process.env.NODE_ENV === 'production':
     backend = encrypted httpOnly cookie (bi_auth)
              + AsyncLocalStorage to coalesce reads/writes
              into one decrypt + one encrypt per request
```

The cookie is AES-256-GCM under `AUTH_SECRET`, 10-day max-age, `SameSite=None` so it survives the OAuth round-trip. The ALS-scoped store exists because Next's `cookies()` API has a request-vs-response split: a read after a set in the same request returns the OLD value, so the provider's many synchronous read/write calls would tear without the in-request coalescing.

What breaks when each part is missing:

- **drop encryption** → tokens are readable by anyone who inspects the cookie
- **drop ALS coalescing** → the OAuth callback reads stale state and the code exchange fails
- **drop the dev-file backend** → Next dev's hot-reload wipes the in-memory Map mid-flow; PKCE verifier lost; the callback can't complete

This is the one piece of code in the repo that acts like a small per-user durable store. Cookie-as-database is unusual but correct for a stateless serverless app with a small per-user payload.

**Move 2e — the synthetic data source (no storage, just a function).**

`lib/data-source/synthetic-data-source.ts` is the demo backstop. It implements the same `DataSource` interface as the Bloomreach-backed one, but it has no persistent state: a `const syntheticWorkspaceSchema` describes the dataset shape, and each tool call is computed from that const plus the input args.

Bridge: think of a pure function with a fixed lookup table inline — no I/O, same input gives same output, no shared state.

```
  pattern — in-process synthesis, no datastore at all

  module-level const:   syntheticWorkspaceSchema: WorkspaceSchema

  callTool(name, args):
    branch on tool name
      → compute response from syntheticWorkspaceSchema + args
    return synthesized result
```

What breaks when each part is missing:

- **drop the const-ness** → demo replays become non-deterministic; same input could return different shapes
- **drop the schema source-of-truth** → tool responses can diverge from the schema (`get_event_schema` says event X exists, then a metric tool returns data for event Y)

The synthetic source IS what the "no database" verdict means in practice — even the demo path uses zero persistence. The data is the code.

### Move 2.5 — current vs future

Today: zero engines. Tomorrow, the day a feature needs persistence: Postgres for relational shape (saved insights with `(user_id, timestamp)` indexes), external KV (Upstash / Vercel KV) for shared session-level state (cross-instance rate budget, cross-instance current-briefing). The split between the two is the access pattern, not the volume. Neither is in the repo today.

### Move 3 — the principle

**Storage choices are lifetime choices.** A `Map` in a module isn't "memory" — it's storage with a lifetime equal to the enclosing process. A cookie isn't "session state" — it's storage with a lifetime equal to the cookie's max-age. A committed JSON file isn't "data" — it's storage with a lifetime equal to the deploy. Every datastore answers the question "what reads after my write?" by defining its lifetime scope. Get the lifetime wrong and you've picked the wrong storage.

This codebase picks all-shortest-lifetimes because none of its features yet need persistence. The day a feature does, the right move is to pick the lifetime scope first and the engine second — not the other way around.

## Primary diagram

```
  blooming insights — storage map, fully labelled

  ┌─ Browser ────────────────────────────────────────────────────────────┐
  │  sessionStorage     ←──  feed posts an insight blob before nav       │
  │  bi_session cookie  →   uuid, httpOnly, 10d                          │
  │  bi_auth cookie     →   AES-256-GCM(store) under AUTH_SECRET, 10d    │
  └─────────────────────────────────┬────────────────────────────────────┘
                                    │  HTTP
  ┌─ Vercel Function (per warm Node process) ─────────────────────────────┐
  │                                                                       │
  │  ┌─ MCP cache ──────────────┐   ┌─ schema cache ───────────────────┐ │
  │  │ Map<key, {result,        │   │ cached: WorkspaceSchema | null   │ │
  │  │           expiresAt}>     │   │ (no TTL, no invalidation)        │ │
  │  │ TTL 60s, minInterval 1.1s │   │ chain: orgs→projects→project_id  │ │
  │  └──────────────────────────┘   └──────────────────────────────────┘ │
  │                                                                       │
  │  ┌─ briefing state ─────────┐   ┌─ investigation state ────────────┐ │
  │  │ insights:   Map<id, I>    │   │ mem: Map<id, AgentEvent[]>       │ │
  │  │ anomalies:  Map<id, A>    │   │ + .investigation-cache.json (dev)│ │
  │  │ investigations: Map<id,V> │   │ + lib/state/demo-* (committed)   │ │
  │  │ putInsights() clears all  │   │ saveInvestigation() upserts      │ │
  │  └──────────────────────────┘   └──────────────────────────────────┘ │
  │                                                                       │
  │  ┌─ auth store ────────────────────────────────────────────────────┐ │
  │  │ dev:  .auth-cache.json (JSON file, gitignored)                  │ │
  │  │ test: memStore Map                                              │ │
  │  │ prod: ALS-scoped Store seeded from bi_auth cookie               │ │
  │  └─────────────────────────────────────────────────────────────────┘ │
  │                                                                       │
  │  ┌─ synthetic data source ─────────────────────────────────────────┐ │
  │  │ const syntheticWorkspaceSchema + per-call synthesized responses │ │
  │  │ no persistent state; demo backstop with same DataSource shape   │ │
  │  └─────────────────────────────────────────────────────────────────┘ │
  └─────────────────────────────────┬────────────────────────────────────┘
                                    │  rate limit: ~1 req/s, sometimes 1/10s
  ┌─ Bloomreach Engagement (real DB; opaque to us) ────────────────────────┐
  │  customer profiles · event streams · catalogs · EQL query engine       │
  │  exposed via MCP tools — we never see schemas, indexes, or plans       │
  └────────────────────────────────────────────────────────────────────────┘
```

## Implementation in codebase

### Use cases

- **Every MCP tool call** goes through the `McpClient` cache first. The `/debug` page exists in part to verify cache behavior — its "force fresh" toggle sets `skipCache: true` so you can compare cached vs live results side by side.
- **Every briefing** writes to the insights Map via `putInsights()`. Every investigation reads from `getCachedInvestigation()` first, falls through to the agent run, then writes back via `saveInvestigation()`.
- **Every OAuth flow** stages state in the auth backend appropriate to the env — PKCE verifier saved on `connect`, read on `callback`, tokens saved after exchange.
- **Demo mode** (`?demo=cached` on `/api/briefing` and the investigation route) replays committed JSON fixtures so the live demo works without Bloomreach credentials. The synthetic data source provides the same tool surface for dev/test scenarios where neither live nor cached demo applies.

### Code side by side

```
  lib/mcp/client.ts  (lines 80–110)

  private cache = new Map<                  ← single map, no eviction policy.
    string,                                    keys grow unbounded until the
    { result: unknown; expiresAt: number }     instance dies (no LRU).
  >();

  async callTool(...) {
    const cacheKey =
      `${name}:${JSON.stringify(args)}`;    ← key is tool+args-serialized.
                                               JSON.stringify is order-sensitive,
                                               so two callers with the same args
                                               in different key order would miss
                                               cache. (callers control args, so
                                               in practice this is fine.)
    const ttl = options.cacheTtlMs ?? 60_000; ← per-call TTL override possible
                                                 but unused outside tests.

    if (!options.skipCache) {
      const cached = this.cache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        return { result: cached.result,     ← absolute-time expiry — survives
                 durationMs: 0,                clock jumps fine within Node's
                 fromCache: true };            monotonic-ish Date.now()
      }
    }
    ...
       │
       └─ load-bearing: skipCache still WRITES through. The /debug "force fresh"
          path uses it to refresh the cache rather than bypass it. Drop the
          write-through and force-fresh becomes a one-shot — next call still
          serves the stale value.
```

```
  lib/state/insights.ts  (lines 30–42)

  export function putInsights(
    items: Insight[],
    rawAnomalies?: Anomaly[],
  ): void {
    insights.clear();                       ← the replace-on-write contract.
    anomalies.clear();                         every briefing IS the current
                                               feed — no append, no history.
    items.forEach((i, idx) => {
      insights.set(i.id, i);
      if (rawAnomalies?.[idx])
        anomalies.set(i.id, rawAnomalies[idx]);
    });
  }
       │
       └─ the comment above this function explicitly names the consequence of
          NOT clearing: a warm Vercel instance would accumulate stale insights
          across briefings. This IS the eviction policy — write-time, full-table.
          A real DB would call it TRUNCATE+INSERT. Doing it any other way
          (e.g. UPSERT-by-id) would mean yesterday's anomalies survive into
          today's feed when ids happen not to collide.
```

```
  lib/mcp/schema.ts  (lines 131, 170–192)

  let cached: WorkspaceSchema | null = null;  ← process-singleton. No TTL,
                                                 no invalidation. Lifetime =
                                                 lifetime of the Node instance.

  export async function bootstrapSchema(mcp) {
    if (cached) return cached;                ← fast path, every call after the first.
    const { projectId, projectName } =
      await resolveProject(mcp);              ← the orgs → projects chain.
    const args = { project_id: projectId };

    // Sequential — server allows ~1 req/s
    const eventSchema   = await callOrThrow(mcp, 'get_event_schema', args);
    const customerProps = await callOrThrow(mcp, 'get_customer_property_schema', args);
    const catalogs      = await callOrThrow(mcp, 'list_catalogs', args);
    const overview      = await callOrThrow(mcp, 'get_project_overview', args);

    cached = parseWorkspaceSchema({ ... });
    return cached;
  }
       │
       └─ the four-call bootstrap costs ~4-5s. Without the `if (cached) return`
          guard, every briefing would pay it again. Caching is the difference
          between "first briefing slow, subsequent ones fast" and "every
          briefing slow." Worth the staleness risk.
```

## Elaborate

The closest historical pattern this app's storage layout matches is **the early days of stateless web frameworks before Memcached** — CGI scripts that held nothing across requests, used the filesystem in dev, and pushed durable state out to cookies or the database. The MCP cache is the kind of thing you'd write in 2002 before Memcached existed.

That's not a criticism — it's the right shape for the size. The cache exists to absorb the rate limit (which is a real, observable, painful constraint at 1 req/s globally per user) and nothing more. The day the feature set demands cross-request truth, the move is to pull `lib/state/*` into a tiny KV (Upstash Redis is the obvious match for Vercel) and leave `lib/mcp/*` alone — the MCP cache is fine where it is. Cross-link: `study-system-design` walks the engine choice.

## Interview defense

**Q: "Walk me through where state lives in this app."**
Three layers. Per-request via AsyncLocalStorage for the auth store in prod. Per-instance via `Map`s — the MCP cache, the schema singleton, the insights/investigations Maps. Cross-deploy via cookies (auth + session) and committed JSON fixtures. Nothing lives between those scopes; we don't have a database.

Diagram-while-you-speak: the three-band lifetime hierarchy from Move 1.

Anchor: `lib/state/insights.ts` L4-L6 is three `Map`s, and they're the closest thing to a database table in the repo.

**Q: "What happens if two users hit /api/briefing at the same moment?"**
Depends on Vercel's routing. Same warm instance → both calls hit the same MCP cache (one wins, the other gets a cache hit, fine). Different instances → both run the full briefing, both call `putInsights()` on their own instance's Map, and now there are two different "current briefings" depending on which instance you land on next. No single source of truth. The fix would be to push insights into a shared KV; we haven't, because the use case is a live demo, not multi-tenant production.

Diagram: two stacked function boxes side by side, each with its own `Map`, both pointing up to Bloomreach.

Anchor: `lib/state/insights.ts` is module-global — module globals in serverless are per-instance.

**Q: "Why a Map and not a database?"**
Because no feature here needs persistence yet. The briefing is generated on demand, the investigation is generated on demand, the schema is cached for speed not for survival. The day a feature lands that needs to survive a cold start — saved searches, per-user history, audit logs — the answer changes to "Postgres or Upstash KV, pick by access pattern." Until then, a database is overhead with no payoff.

Diagram: the lifetime-hierarchy nested-boxes diagram.

Anchor: `package.json` has zero database dependencies.

## See also

- `06-locks-mvcc-and-concurrency-control` — the concurrent-write seams named above
- `08-replication-and-read-consistency` — the per-instance-divergence problem
- `09-database-systems-red-flags-audit` — the ranked list of what to actually worry about
- `study-system-design` (`.aipe/study-system-design/`) — which engine, when
- `study-runtime-systems` — why module globals are per-process

---
Updated: 2026-06-19 — Olist SQLite tier (Move 2e and supporting diagrams) removed; Olist altitude collapsed back to the single "no DB" altitude. Move 2e now describes the synthetic data source as the in-process, no-storage demo backstop.
Updated: 2026-06-24 — Stripped `## Validate` block per spec v1.68.3 (the Validate primitive was removed from the per-concept template; block 10 is now `See also`).
