# Consistency models and staleness

*Industry standard — read-your-writes, stale reads, monotonic reads, convergence.*

## Zoom out — where consistency matters

Consistency matters when **two callers can observe different views of the same underlying state** and the discrepancy is observable to the user. In `blooming_insights`, the cross-process surface is one HTTPS call to Bloomreach; the cross-request surface is in-process state (session-keyed Maps + one global cache). That second surface is where this file does the real work.

```
  Where consistency questions live in this codebase

  ┌─ L1: Browser ────────────────────────────────────────────────┐
  │  sessionStorage stash (per-tab, per-origin)                   │
  │  multi-tab read-your-writes? NO — each tab has its own stash  │
  └─────────────────────────┬────────────────────────────────────┘
                            │
  ┌─ L2: Vercel route ──────▼────────────────────────────────────┐
  │  ★ module-level state, per warm instance ★                    │
  │  • lib/state/insights.ts:14         — session-keyed Maps      │
  │  • lib/state/investigations.ts:11   — keyed by insightId      │
  │  • lib/mcp/schema.ts:138            — ★ GLOBAL CACHE ★        │
  └─────────────────────────┬────────────────────────────────────┘
                            │
  ┌─ L3: BloomreachDataSource ──────────────────────────────────┐
  │  60s response cache · per-instance · keyed by name+args       │
  │  (per-request adapter; cache is per-adapter, not global)      │
  └─────────────────────────┬────────────────────────────────────┘
                            │
  ┌─ L4: Bloomreach ────────▼────────────────────────────────────┐
  │  workspace data (we don't own it)                             │
  │  eventually-consistent ingest? unknown — opaque to us         │
  └────────────────────────────────────────────────────────────────┘
```

Two caches and the underlying workspace. The 60s response cache is per-request-adapter and harmless. The module-level schema cache is global per warm instance and is the most interesting consistency hazard in the repo.

## Zoom in — the question this file answers

> What can two callers see that disagrees, for how long, and what's the worst that happens?

Three answers, in order of severity: the schema cache (load-bearing, has a real hazard), the response cache (bounded, safe), and Bloomreach's own ingest consistency (opaque, accepted).

## Structure pass — the skeleton

### Axes — trace staleness

The axis is **how long can a stale value persist, and who sees it?**

```
  One axis: "how stale can this get, and who sees it?"

  cache layer                          max staleness    who sees it
  ─────────                            ─────────────    ───────────
  L1 sessionStorage stash              forever          one tab (per-origin)
                                       (until cleared)

  L2 schema cache (module-level)       until cold       EVERY user routed to
                                       restart          that instance, INCLUDING
                                                        a different Bloomreach user

  L2 insights/investigations Maps       per session      only that session
                                       (session-keyed)  (anomalies cleared per run;
                                                         investigations sticky until
                                                         instance dies)

  L3 response cache (BloomreachDS)     60s              only this request
                                                        (per-adapter, ephemeral)

  L4 Bloomreach workspace               unknown          all callers
                                       (their domain)
```

The axis-answer doesn't change much between rows — it flips dramatically at the schema cache row. **Module-level + global + cross-user = the hazard.** Everywhere else, staleness is either per-session, per-request, or per-tab, and the consequence is bounded.

### Seams — where consistency contracts live

```
  Three load-bearing seams

  seam 1: schema cache (module global)
    contract: "the first request to bootstrap on this warm instance
               sets the schema for every subsequent request"
    failure mode: cross-user staleness if instance serves two distinct
                  Bloomreach projects

  seam 2: session-keyed insights Map
    contract: "each session sees its own latest briefing; putInsights
               replaces (clears + sets) the session's sub-map"
    failure mode: ephemeral — cold restart loses all sessions' state

  seam 3: 60s response cache (per-adapter)
    contract: "within one request, identical (name, args) returns the
               first call's result"
    failure mode: bounded — adapter dies with the request, cache with it
```

The first one is where the consistency model is *implicit*. The other two are *explicit* (session-keying, per-request lifetime) and inherit their safety from that explicitness.

## How it works

### Move 1 — the mental model

You've seen this in the browser: `localStorage` vs `sessionStorage` vs in-memory React state. Three lifetimes, three staleness profiles, three different mental models for what's safe to put where.

> **In this repo there are three caches with three lifetimes (60s, request, instance-lifetime), and the only one that can produce a cross-user consistency surprise is the instance-lifetime one — the module-level schema cache.**

```
  Three caches, three lifetimes, three staleness profiles

  ┌─────────────────┬───────────────┬──────────────────┬─────────────────┐
  │ cache           │ lifetime      │ scope            │ staleness risk  │
  ├─────────────────┼───────────────┼──────────────────┼─────────────────┤
  │ response cache  │ 60s           │ per-request      │ tiny (60s, same │
  │ (BloomreachDS)  │               │ adapter         │  request only)  │
  ├─────────────────┼───────────────┼──────────────────┼─────────────────┤
  │ insights Map    │ until cold    │ per-session       │ ephemeral —     │
  │                 │ restart       │ inside instance   │ cold restart    │
  │                 │               │                   │ wipes it        │
  ├─────────────────┼───────────────┼──────────────────┼─────────────────┤
  │ schema cache    │ until cold    │ ★ INSTANCE-WIDE ★ │ cross-user      │
  │ (mcp/schema.ts) │ restart       │ (NOT keyed)      │ if two users    │
  │                 │               │                   │ on diff projects│
  │                 │               │                   │ share instance  │
  └─────────────────┴───────────────┴──────────────────┴─────────────────┘
```

The asterisks on the third row are the file's central finding.

### Move 2 — walk the three caches

#### Part 1 — the response cache (60s, per-adapter) — safe

The simplest layer. Every `BloomreachDataSource` instance has its own `Map`:

```ts
// lib/data-source/bloomreach-data-source.ts:121-188
export class BloomreachDataSource implements DataSource {
  private cache = new Map<string, { result: unknown; expiresAt: number }>();
  // …
  async callTool<T>(name, args, options) {
    const cacheKey = `${name}:${JSON.stringify(args)}`;
    const ttl = options.cacheTtlMs ?? 60_000;
    if (!options.skipCache) {
      const cached = this.cache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        return { result: cached.result as T, durationMs: 0, fromCache: true };
      }
    }
    // … live call, retry, write-on-success only …
  }
}
```

Why it's safe:
- Each route handler builds a fresh `BloomreachDataSource` via `connectMcp(sid)` (`lib/mcp/connect.ts:94-101`). The adapter (and its cache) live for the duration of *one* request and are garbage-collected when the route returns.
- The cache key includes the full args, so two requests on the same instance with different `project_id` get different entries. (Within a request, two requests can't happen — one request, one adapter.)
- The cache write happens **only on `isError !== true`** (`bloomreach-data-source.ts:179-187`). A rate-limit or transport error doesn't poison anything.
- TTL 60s. Even if some path *did* share an adapter across requests (it doesn't today), 60s is short enough that "yesterday's data" is not a concern.

**The staleness window** here is at most 60s, against a Bloomreach workspace whose ingest latency we don't measure but which is likely longer than 60s for new events (Bloomreach Engagement workspaces aren't real-time). **Net effect: the user-observable consistency is bounded by Bloomreach's own ingest, not by our cache.**

#### Part 2 — session-keyed state Maps (insights, anomalies, investigations) — safe-by-design but ephemeral

The state layer (`lib/state/insights.ts:14-23`):

```ts
type SessionFeed = {
  insights: Map<string, Insight>;
  investigations: Map<string, Investigation>;
  anomalies: Map<string, Anomaly>;
};
const state = new Map<string, SessionFeed>();

function sessionState(sessionId: string): SessionFeed {
  let s = state.get(sessionId);
  if (!s) {
    s = { insights: new Map(), investigations: new Map(), anomalies: new Map() };
    state.set(sessionId, s);
  }
  return s;
}
```

The outer Map is keyed by `sessionId`. Each session gets its own inner Maps. The discipline in `putInsights` (`insights.ts:57-71`):

```ts
export function putInsights(sessionId, items, rawAnomalies?) {
  // Replace the previous briefing for THIS session — each run IS the current
  // feed, not an addition. Without clearing, a warm serverless instance (or a
  // long-running dev server) accumulates stale insights from earlier runs, so
  // the feed shows yesterday's anomalies alongside today's. Investigations are
  // keyed separately and untouched here. Only this session's sub-maps are
  // cleared — never the outer map, never another session's feed.
  const s = sessionState(sessionId);
  s.insights.clear();    // ← clear THIS session's, not the global map
  s.anomalies.clear();
  // … repopulate …
}
```

This is the *right* shape for a multi-tenant warm instance: cross-session isolation by construction, intra-session "latest briefing wins" semantics.

```
  Session keying — the invariant that makes it safe

  warm Vercel instance serves three users
  ───────────────────────────────────────
  state Map:
    "sid-A" → { insights: {…3 entries…}, … }
    "sid-B" → { insights: {…7 entries…}, … }
    "sid-C" → { insights: {…0 entries…}, … }

  user A starts a new briefing
       │
       ▼
   putInsights("sid-A", newList)
       │
       ▼
   sessionState("sid-A").insights.clear() ← ONLY A's
       │
       ▼
   sessionState("sid-A").insights ← repopulated

   user B's sub-map is UNTOUCHED ★ this is the load-bearing invariant ★
```

The other-side consistency story:

```
  Ephemeral state — what survives an instance gap

  request 1 lands on instance X            request 2 (same user) lands on instance Y
  ────────────────────────────              ────────────────────────────────────────
  putInsights("sid-A", [...])               state.get("sid-A") → undefined
  state(X).get("sid-A") = {3 insights}      no carry-over from X
                                            request 2 must re-bootstrap

  the route handles this in three ways:
    - the feed re-runs the briefing (or replays demo)
    - the investigation flow passes the Insight through sessionStorage
      (browser-side) so the route can re-resolve from the param
    - the demo snapshot is the source-of-truth fallback
```

**This is the intentional design** — call it "eventually-consistent across Vercel instances by way of re-fetching the source." The route never assumes its state survives an instance gap; the client passes enough context (the full `Insight` JSON in the `?insight=` param, the diagnosis in `sessionStorage`) to rebuild the relevant state from scratch.

The comment block in `app/api/agent/route.ts:30-62` (the `resolveAnomaly` function) is the textbook example:

```ts
// Prefers the client-provided insight (handed from the feed via
// sessionStorage → `?insight=`), which is the only source that survives
// Vercel's per-instance memory. Falls back to in-memory (same-instance /
// dev, scoped to the caller's session) then the demo snapshot.
```

Three fallback sources, in priority order: client-provided (survives any gap) → in-memory (same instance) → demo snapshot (committed JSON). **The hierarchy is the consistency model**: the system is read-your-writes for the client, eventually-consistent across instances, deterministic from the demo file.

#### Part 3 — the schema cache (module-level, instance-wide) — the hazard

The single global variable:

```ts
// lib/mcp/schema.ts:138
let cached: WorkspaceSchema | null = null;

export async function bootstrapSchema(
  dataSource: DataSource,
  opts: BootstrapOpts = {},
): Promise<WorkspaceSchema> {
  if (cached) return cached;
  const { projectId, projectName } = await resolveProject(dataSource, opts);
  // … 4 more bootstrap calls …
  cached = parseWorkspaceSchema({ … });
  return cached;
}
```

`cached` is a module-level `let`, not session-keyed, not adapter-keyed, not args-keyed. The first request on a warm instance to call `bootstrapSchema` fills it; every subsequent request returns the same value, **regardless of which user, which session, which Bloomreach project**.

```
  The schema cache hazard — cross-user staleness, drawn explicitly

  scenario: warm Vercel instance, two users with distinct Bloomreach
            workspaces (e.g. via BLOOMREACH_PROJECT_ID env override,
            or distinct DCR client registrations)

  time      event                                   `cached` value
  ─────     ──────────────────────────              ──────────────────
  t=0       user A: GET /api/briefing
            bootstrapSchema(A's dataSource)
            resolveProject → project "wobbly-ukulele"
            cached = wobbly-ukulele's schema       cached = schema(A)
  ─────────────────────────────────────────────────────────────────────
  t=1       user B: GET /api/briefing
            bootstrapSchema(B's dataSource)
            if (cached) return cached              ★ returns A's schema ★
            B sees A's project name, A's event     ⚠ wrong workspace
            schema, A's customer properties

  the call never reaches Bloomreach for user B.
  the agents run with the wrong schema in their prompt.
  the EQL the agents emit references A's events against B's project_id.
  Bloomreach errors on unknown events for project B.

  net effect: B's briefing fails with cryptic Bloomreach errors that
  look like "schema mismatch" but are actually our cache leaking.
```

**Why this hasn't been observed in production:** today the single deployed instance authenticates to one Bloomreach account (`BLOOMREACH_PROJECT_ID` env pins one project). The hazard is gated by a deployment property, not by the code. If the deployment ever supports multi-tenant Bloomreach (one Vercel deployment serving multiple distinct Bloomreach OAuth identities), this fires.

**The fix is one line:** key the cache by `projectId` (or session). The mechanism that *should* be there:

```ts
// pseudocode — what a safe version looks like

const cache = new Map<string, WorkspaceSchema>();

export async function bootstrapSchema(dataSource, opts = {}) {
  const { projectId, projectName } = await resolveProject(dataSource, opts);
  const hit = cache.get(projectId);
  if (hit) return hit;
  // … bootstrap …
  cache.set(projectId, schema);
  return schema;
}
```

One Map, one key, same lifetime. The change is small; what makes it deferred is that the single-tenant deployment doesn't expose the hazard. **File 09 ranks this; this file diagnoses it.**

#### Part 4 — what Bloomreach itself promises

We're a client of Bloomreach. We don't get to choose its consistency model. What we *observe*:

- **Reads are eventually consistent with ingest.** New events you POST to Bloomreach Engagement appear in EQL results minutes later, not seconds.
- **Rate-limit state is global per user.** The 429 envelope's "1 per 10 second" is a property of the user's API quota, not per-region or per-shard. Two of our instances hitting Bloomreach for the same user share the rate limit.
- **Tokens are server-side state.** Bloomreach can revoke tokens (the alpha server revokes "after minutes" per the project context). Our reset path (`/api/mcp/reset`) clears our auth state but doesn't revoke server-side — the cookie clearing is what makes us re-auth.

For our purposes, the contract with Bloomreach is "eventually-consistent reads with no read-your-writes guarantee, against a global rate-limit window." We accept that contract and design around it (the 60s response cache is fine because Bloomreach's own staleness is at least that wide; the schema bootstrap is once-per-instance because the schema doesn't change minute-to-minute).

### Move 2.5 — current state vs future state

```
  Today (single-tenant)                    Tomorrow (multi-tenant)
  ───────────────────────────              ──────────────────────────────
  schema cache: module-level let           schema cache: Map keyed by
   (works because only one project)         projectId

  insights state: session-keyed Map        same shape — already correct
   (works for any tenancy)

  no cross-instance state                  needs a shared store (KV /
   (re-resolves from client / demo)         Redis) or sticky routing
                                            (sticky routing is the
                                            cheapest if Vercel supports it)

  no read-your-writes for the agent's      same — agents don't write to
   tool calls (every call is a read)        Bloomreach, so no R-Y-W needed
```

The current state is *correct for the current deployment*. The future-state work is bounded and named.

### Move 3 — the principle

> **Module-level mutable state in a serverless runtime is a multi-tenant consistency hazard waiting for the right two users to arrive on the same warm instance. The fix is either keying (cache by tenant id) or scoping (move state to per-request). Choose one consciously — don't let "it works today" be the design.**

The session-keyed Maps in `lib/state/` got this right: the outer key is the tenant, the lifetime is the instance. The schema cache got it wrong: no tenant key, instance lifetime. The same mistake, made differently. **Reviewing module-level state for tenant-keying is a checklist item, not a judgement call.**

## Primary diagram — the staleness map

```
  Consistency surfaces in blooming_insights — full picture

  ┌─ Browser ─────────────────────────────────────────────────────┐
  │  sessionStorage stash (per-tab, per-origin)                    │
  │  ★ READ-YOUR-WRITES inside a tab; no cross-tab guarantee ★      │
  └─────────────────────────┬─────────────────────────────────────┘
                            │
  ┌─ Route handler ─────────▼─────────────────────────────────────┐
  │  in-memory state (per warm instance):                          │
  │   • insights: Map<sessionId, {…}>     ← session-keyed, SAFE    │
  │   • investigations: Map<insightId,…>   ← session-keyed, SAFE    │
  │   • schema cache: ★ MODULE-LEVEL let ★  ← NOT keyed, HAZARD    │
  │                                                                │
  │  cross-instance: stateless (re-resolve from client or demo)    │
  └─────────────────────────┬─────────────────────────────────────┘
                            │
  ┌─ DataSource adapter ────▼─────────────────────────────────────┐
  │  60s response cache, per-adapter (per-request)                 │
  │  keyed by name + JSON.stringify(args)                          │
  │  ★ ALWAYS SAFE — adapter dies with the request ★               │
  └─────────────────────────┬─────────────────────────────────────┘
                            │
  ┌─ Bloomreach ────────────▼─────────────────────────────────────┐
  │  workspace: eventually-consistent with ingest (their domain)   │
  │  rate-limit: global per user                                   │
  │  tokens: server-side state, can be revoked                     │
  └────────────────────────────────────────────────────────────────┘

  consistency model:
    • inside-request:        bounded by 60s response cache
    • inside-session:        latest briefing wins (clear-on-put)
    • cross-instance:        eventually-consistent via re-resolve
    • cross-tenant (today):  ⚠ schema cache leaks if multi-tenant
```

## Elaborate

The classifications used here come from Vogels and Brewer:

- **Read-your-writes** (Vogels). A user who issues a write sees its result on a subsequent read. *In this codebase, the user's only "write" is starting a briefing or investigation; the next read on the same session sees its result (sessionStorage handoff or in-memory cache). R-Y-W holds for the client, eventually-consistent across instances.*
- **Monotonic reads.** Once a user sees value V, they never subsequently see an older value. *Holds within a session because `putInsights` clears + sets atomically. Could break across instances if a slow-arriving stale result overwrote a newer one — doesn't today because each session has at most one inflight briefing.*
- **PACELC** (Abadi). The extension to CAP: even when there's no partition, you trade Latency for Consistency. *Here we picked latency: the 60s response cache, the module-level schema cache, and the per-instance Maps all trade some consistency for speed. The schema-cache trade is the one we made implicitly; the others were explicit.*

The other reference worth knowing: **CRDT (conflict-free replicated data types).** Not used in this repo, not needed. The reason: there's no multi-writer scenario. The browser writes to `sessionStorage` (single writer per tab), the route writes to the session-keyed Map (single writer per request), the DataSource cache is single-writer per adapter. CRDTs solve multi-writer convergence; we don't have multi-writer.

## Interview defense

### "What's your consistency model for a user's briefing?"

Inside a session, read-your-writes: a briefing run on instance X populates `state[sid].insights`, the same session's next request on instance X reads it back. Across instances, eventually-consistent via re-resolve: the client passes the `Insight` JSON through `sessionStorage` → `?insight=` so a different instance can rebuild the anomaly from scratch (`resolveAnomaly` in `app/api/agent/route.ts:30-62`). The demo snapshot is the deterministic fallback. The system is never *strongly* consistent across instances — and doesn't need to be, because every Bloomreach call is a read and the route can always re-run the briefing.

*Anchor:* `lib/state/insights.ts:57-71` — `putInsights` clears-then-sets per-session; `app/api/agent/route.ts:30-62` — the three-source fallback hierarchy.

### "Walk me through the schema cache and what's wrong with it."

`lib/mcp/schema.ts:138` declares a module-level `let cached: WorkspaceSchema | null = null`. First request to `bootstrapSchema` on a warm Vercel instance runs the bootstrap orchestrator (list_cloud_organizations → list_projects → 4 metadata calls), parses the result, and stores it. Every subsequent request on that instance returns the same `cached` value without re-running. Today it's safe because we deploy single-tenant — `BLOOMREACH_PROJECT_ID` pins one project, all requests resolve to the same workspace. The hazard is multi-tenant: if two distinct OAuth identities land on the same instance, the second sees the first's schema, which leaks A's event names into B's agent prompts and produces Bloomreach errors that look like schema mismatch. The fix is a `Map<projectId, WorkspaceSchema>` instead of a single `let`. Three-line change; deferred because the deployment property gates the hazard. File 09 ranks it.

### "Why no shared cache (Redis/KV) across Vercel instances?"

Because we don't need cross-instance read-your-writes for anything load-bearing. The two pieces of state that need to survive an instance gap — OAuth tokens and investigation results — already do, via different mechanisms: tokens via the encrypted cookie (`lib/mcp/auth.ts`), investigations via `sessionStorage` handoff + the in-memory cache on whichever instance serves the request. The 60s response cache is per-request, so cross-instance is irrelevant. The schema cache is global per instance, which is the hazard already discussed. Adding Redis would solve one real problem (the schema cache) and add complexity to four non-problems. The right shape today is the cookie + sessionStorage tactic; the right shape *tomorrow* if we go multi-tenant is keying the schema cache and probably moving the OAuth client info to KV. We're not there yet.

*Anchor:* `lib/mcp/auth.ts:38-104` — the cookie-as-distributed-state mechanism; `app/api/agent/route.ts:30-62` — the client-passes-context-back tactic.

## See also

- `03-idempotency-deduplication-and-delivery-semantics.md` — the cache as dedup mechanism.
- `07-clocks-coordination-and-leadership.md` — OAuth state survival, the other piece of distributed state.
- `09-distributed-systems-red-flags-audit.md` — the schema cache hazard ranked.
- `.aipe/study-system-design/` — the architectural shape that makes single-tenant safe today.
- `.aipe/study-database-systems/` — datastore-local consistency (mostly `not yet exercised` here — no datastore we own).
