# in-memory-state-ownership

## In-memory state with session-scoped keys (project-specific)

The choice not to have a database. Every server-owned state value lives in a `Map` keyed by `sessionId`, on the warm Vercel instance that owns it. Persistence comes from committed JSON snapshots (`lib/state/demo-*.json`) and a gitignored dev cache. The bug this shape was *forced* to solve — `putInsights().clear()` wiping another user's feed mid-briefing on a warm instance — is the load-bearing finding here.

## Zoom out — where this pattern lives

State ownership sits between the route layer (which produces state during a request) and the UI (which reads state via subsequent requests).

```
  Zoom out — five state owners, one per lifetime

  ┌─ UI / browser ──────────────────────────────────────────────────┐
  │  bi_session cookie  (10d)                                        │
  │  bi_auth cookie     (10d, encrypted, prod only)                  │
  │  sessionStorage     (tab lifetime — investigation handoff, flag) │
  └────────────────────────┬────────────────────────────────────────┘
                           │  sessionId carries identity
  ┌─ ★ SERVER STATE ★ ────▼────────────────────────────────────────┐ ← we are here
  │  Map<sessionId, SessionFeed>     (warm instance lifetime)        │
  │     SessionFeed = { insights, investigations, anomalies }        │
  │  Map<insightId, AgentEvent[]>    (investigation cache, in-mem)   │
  │  .investigation-cache.json       (dev only, gitignored)          │
  └────────────────────────┬────────────────────────────────────────┘
                           │  durable fallback
  ┌─ Committed snapshots ─▼────────────────────────────────────────┐
  │  lib/state/demo-insights.json        (committed)                 │
  │  lib/state/demo-investigations.json  (committed)                 │
  └─────────────────────────────────────────────────────────────────┘
```

There is no SQL database. There is no Redis. There is no shared store across Vercel instances. State exists in process memory keyed by session, and degrades to the demo snapshots when the process is gone.

## Structure pass

Three layers carry state: the **identity** layer (the session cookie), the **memory** layer (the `Map<sessionId, SessionFeed>`), the **durable** layer (committed snapshots). One axis worth tracing: **what's the lifetime, and what survives the next event?**

```
  Axis: lifetime — what survives what?

  ┌─ identity (cookie) ──────┐    survives: cold start, redeploy
  │  bi_session = uuid       │   ═════╪═════►
  │  10-day max age          │
  └──────────────────────────┘
       ┌─ memory (Map) ────────────┐    survives: same warm instance
       │  Map<sessionId, …>        │   ═════╪═════►
       │  dies on cold start       │
       └────────────────────────────┘
            ┌─ durable (JSON) ───────┐    survives: deployment, cold start
            │  demo-*.json committed │
            │  .auth-cache (dev only)│
            └─────────────────────────┘
```

The axis flips at every seam. The cookie outlives cold starts; the Map dies with them; the JSON outlives both but only carries the demo snapshot. Everything else is regenerated on the next request.

The load-bearing seam is between identity and memory. The session cookie *carries* identity from request to request — but the cookie doesn't carry data, just the key. The `Map` *holds* the data, but only for the warm instance that handled the request that wrote it. Two warm instances serving the same user see different `Map` contents; this is fine because session-keyed access never crosses instances mid-request.

## How it works

### Move 1 — the mental model

You've used `localStorage` in the browser. Process memory, key-value, no schema, no transactions, wiped when the tab closes. Now imagine the *server* doing exactly that, with the `Map` being the storage and the session cookie being the only way to find your data. The cookie says "this is user `abc123`"; the server looks up `state.get('abc123')` and returns the entry it owns. If the entry isn't there (cold start, or the request landed on a different warm instance), the server regenerates by re-running the briefing.

```
  The pattern: a Map per warm instance, keyed by session

  ┌─ warm Vercel instance #1 ─┐    ┌─ warm Vercel instance #2 ─┐
  │  state = Map {              │    │  state = Map {              │
  │    'abc123' → { insights, …}│    │    'def456' → { insights, …}│
  │    'def456' → { insights, …}│    │    'xyz789' → { insights, …}│
  │  }                          │    │  }                          │
  └─────────────────────────────┘    └─────────────────────────────┘

  request:  cookie bi_session=abc123 → routed to instance #1
            instance #1: state.get('abc123') → present → serve from memory

  request:  cookie bi_session=def456 → routed to instance #2
            instance #2: state.get('def456') → present → serve from memory

  request:  cookie bi_session=def456 → routed to instance #1 (different routing)
            instance #1: state.get('def456') → present (already populated above)
            instance #1: state.get('xyz789') → MISSING → regenerate (re-run briefing)
```

Two properties of this model:

- **Per-instance isolation.** No cross-instance reads; no cross-instance writes. If your session moves to a new instance, you regenerate. That's an acceptable cost because the data is cheap (one briefing), the user is unlikely to notice (they'd just see "scanning…" again), and the alternative is a shared store this app does not need.
- **Per-session isolation.** Within one warm instance, sessions never see each other's data. Two users on the same instance get two `SessionFeed` entries; clearing one's feed cannot touch the other's. This is the bug `Map<sessionId, SessionFeed>` was designed to fix.

### Move 2 — the step-by-step walkthrough

#### the `SessionFeed` — three Maps under one key

```ts
// lib/state/insights.ts:7-14
type SessionFeed = {
  insights: Map<string, Insight>;
  investigations: Map<string, Investigation>;
  anomalies: Map<string, Anomaly>;
};

const state = new Map<string, SessionFeed>();
```

`state` is the outer map, keyed by `sessionId`. Each value is a `SessionFeed` — three inner maps for the three logical surfaces a session has (the insights it's seen, the investigations it's run, the anomalies that backed each insight). The shape is `Map<sessionId, { Map, Map, Map }>` — two levels deep, all in-memory.

```ts
// lib/state/insights.ts:16-23
function sessionState(sessionId: string): SessionFeed {
  let s = state.get(sessionId);
  if (!s) {
    s = { insights: new Map(), investigations: new Map(), anomalies: new Map() };
    state.set(sessionId, s);
  }
  return s;
}
```

`sessionState(sid)` is the get-or-create helper. Every public function in `lib/state/insights.ts` goes through it — there is no other entry point into the outer map.

#### the bug this shape fixes — concurrent-user wipe

The original (pre-fix) shape was a flat `Map<insightId, Insight>` at module level. The `putInsights` function wrote new insights and *first cleared the map*, so each briefing run was the current feed (not an accumulation). That's correct for a single user. With two users on the same warm Vercel instance, it was a wipe:

```
  Comparison — before and after the fix

  ┌─ BEFORE (single Map, clear-then-add) ─────────┐
  │                                                │
  │  const insights = new Map<string, Insight>()   │
  │                                                │
  │  putInsights(items):                           │
  │    insights.clear()    ← wipes ALL users       │
  │    items.forEach(i => insights.set(i.id, i))   │
  │                                                │
  │  ╳ user A's briefing wipes user B's feed       │
  │    when both share a warm instance             │
  └────────────────────────────────────────────────┘

  ┌─ AFTER (per-session Map, scoped clear) ────────┐
  │                                                │
  │  const state = new Map<sid, SessionFeed>()     │
  │                                                │
  │  putInsights(sid, items):                      │
  │    s = sessionState(sid)                       │
  │    s.insights.clear()  ← only THIS session     │
  │    items.forEach(i => s.insights.set(i.id, i)) │
  │                                                │
  │  ✓ wipe is scoped to one sessionId             │
  └────────────────────────────────────────────────┘
```

The fix is one indirection: instead of writing to a module-level Map, write to the *per-session* inner Map. The outer Map is never cleared by a request. This is the load-bearing finding for state ownership — the shape of "per-session Map containing the user's data" is what makes per-user isolation possible without a database.

```ts
// lib/state/insights.ts:57-71
export function putInsights(sessionId: string, items: Insight[], rawAnomalies?: Anomaly[]): void {
  // Replace the previous briefing for THIS session — each run IS the current
  // feed, not an addition. Without clearing, a warm serverless instance (or a
  // long-running dev server) accumulates stale insights from earlier runs, so
  // the feed shows yesterday's anomalies alongside today's. Investigations are
  // keyed separately and untouched here. Only this session's sub-maps are
  // cleared — never the outer map, never another session's feed.
  const s = sessionState(sessionId);
  s.insights.clear();
  s.anomalies.clear();
  items.forEach((i, idx) => {
    s.insights.set(i.id, i);
    if (rawAnomalies?.[idx]) s.anomalies.set(i.id, rawAnomalies[idx]);
  });
}
```

The comment block is the receipt — it explains both *why* clear-on-write is correct semantics (each briefing IS the current feed) and *why* the clear is scoped (so it doesn't wipe other users).

#### the investigation cache — a fall-through chain

`lib/state/investigations.ts` is the second state owner. Its read path is a *three-source fall-through* — in-memory, then dev file, then committed demo:

```ts
// lib/state/investigations.ts:22-28
export function getCachedInvestigation(insightId: string): AgentEvent[] | null {
  if (mem.has(insightId)) return mem.get(insightId)!;
  const fromFile = PERSIST ? readJson(CACHE_FILE)[insightId] : undefined;
  if (fromFile) return fromFile;
  const fromDemo = readJson(DEMO_FILE)[insightId];
  return fromDemo ?? null;
}
```

The chain encodes the lifetime ordering: most recent in memory, then last-dev-run on disk (dev only — the serverless FS is read-only), then committed snapshot. A cache miss at one level falls through to the next; only a complete miss returns `null` and forces a fresh investigation.

```
  Pattern — the three-source fall-through

  read getCachedInvestigation(insightId):

    ┌─ mem.has(insightId)? ─┐  yes  ┌─ return mem.get ─┐
    └──────────┬─────────────┘ ────► └──────────────────┘
               │  no
               ▼
    ┌─ PERSIST (dev) && file[insightId]? ─┐  yes  ┌─ return file value ┐
    └────────────────┬─────────────────────┘ ────► └────────────────────┘
                     │  no
                     ▼
    ┌─ demo[insightId]? ─┐  yes  ┌─ return demo ──┐
    └─────────┬───────────┘ ────► └────────────────┘
              │  no
              ▼
        return null  → caller runs a fresh investigation
```

The write path is *in-memory always, dev-file in dev only*:

```ts
// lib/state/investigations.ts:30-41
export function saveInvestigation(insightId: string, events: AgentEvent[]): void {
  mem.set(insightId, events);
  if (PERSIST) {
    const all = readJson(CACHE_FILE);
    all[insightId] = events;
    try {
      writeFileSync(CACHE_FILE, JSON.stringify(all));
    } catch {
      /* best effort */
    }
  }
}
```

Production never writes to disk — Vercel's serverless FS is read-only. The dev file is gitignored and survives hot-reload (which would wipe the in-memory Map); without it, every dev-server restart would lose every investigation.

#### the layered hops — where state is read on a typical request

```
  Layers-and-hops — request reads state at three layers

  ┌─ browser ─────┐  hop 1: GET /investigate/abc
  │  page         │ ───────────────────────────────►
  └───────────────┘
                                                      ┌─ Next.js route ────┐
                                                      │  needs to know:    │
                                                      │   • who is this?    │
                                                      │   • what insight?   │
                                                      └────────┬───────────┘
                                                               │
                                       ┌───────────────────────┼───────────────────────┐
                                       │                       │                       │
                                       ▼                       ▼                       ▼
                            ┌─ identity ──────┐   ┌─ memory ──────────┐   ┌─ data via NDJSON ─┐
                            │ readSessionId   │   │ getInsight(sid,id)│   │ fetch agent NDJSON│
                            │ (bi_session     │   │ from              │   │ → readNdjson      │
                            │  cookie)        │   │ Map<sid,SessionFeed>│ │ → setState        │
                            └─────────────────┘   └───────────────────┘   └───────────────────┘
                                                          │
                                                          │ MISS → fall back to
                                                          │  sessionStorage stash from the
                                                          │  briefing (set by stashInsights)
                                                          ▼
                                                  carry from client
                                                  (Vercel routing across instances)
```

The session id is read from the cookie on every request — that's the identity layer. The in-memory Map provides the data when the request lands on the warm instance that has it; when it doesn't, the browser carries the data forward via `sessionStorage`. The hook `useBriefingStream` stashes each insight in `sessionStorage` precisely so that the investigation page can hand its anomaly to `/api/agent?insight=…` *without* relying on the server's Map being populated.

#### the four lifetimes — comparison

```
  Comparison — what state lives where

  ┌─ store ──────────────────┬─ lifetime ────────────┬─ contents ────────────────────────┐
  │ bi_session cookie         │ 10 days               │ random sessionId                  │
  │ bi_auth cookie            │ 10 days (prod only)   │ encrypted OAuth tokens + PKCE     │
  │ Map<sid, SessionFeed>     │ warm-instance         │ insights, investigations,         │
  │ (lib/state/insights.ts)   │  lifetime             │  anomalies — per session          │
  │ Map<insightId, events[]>  │ warm-instance         │ investigation event traces        │
  │ (lib/state/investig…ts)   │  lifetime             │                                   │
  │ .investigation-cache.json │ until manually cleared│ dev-only persistence              │
  │ .auth-cache.json          │ until manually cleared│ dev-only OAuth state              │
  │ demo-insights.json        │ committed             │ snapshot of one captured briefing │
  │ demo-investigations.json  │ committed             │ snapshot of one investigation     │
  │ sessionStorage (client)   │ tab lifetime          │ bi:insight:<id> (per-card stash)  │
  │                           │                       │ bi:diag:<id>    (step-2→3 handoff)│
  │                           │                       │ bi:reconnecting (one-shot flag)   │
  └───────────────────────────┴───────────────────────┴───────────────────────────────────┘
```

Five owners. Each one has a clearly named lifetime; the system never confuses which is which.

### Move 3 — the principle

Per-session state in process memory is correct *when* you can re-derive the state on cache miss and *when* sessions don't need to share data. Both conditions hold here: a briefing miss costs one re-run (cheap, the user sees "scanning…" again); sessions never cross (each session is the world for one user). The shape works because the alternative — a shared store — would buy nothing and cost operations.

The transferable lesson: state ownership is a *decision*, not a default. Picking "no database" deliberately means asking three questions for every state value. (1) What's the lifetime? (request, warm instance, deploy, forever.) (2) Who needs to read it from where? (one process, one user, multiple processes, multiple users.) (3) What's the cost of regenerating it? If the answers are "warm instance + this user + cheap to regenerate," in-memory is fine. If any answer changes, a shared store enters. The list above is honest about which value is which.

The dual lesson: the *bug that forced the per-session indirection* is the kind of bug only a multi-tenant serverless deployment surfaces. A flat `Map<insightId, Insight>` would work perfectly in dev (one user) and in tests (isolated runs); it would break in production exactly when two users happened to share a warm instance. The fix — `Map<sessionId, SessionFeed>` — is one extra `Map` lookup and zero performance cost. Most "in-memory state" bugs in serverless apps look like this; the fix is always "key by who owns the data."

## Primary diagram

```
  in-memory-state-ownership — full picture

  ┌─ Identity (cookies) ──────────────────────────────────────────────────┐
  │  bi_session  (10d, httpOnly)                                           │
  │  bi_auth     (10d, httpOnly, AES-256-GCM under AUTH_SECRET, prod only) │
  │                                                                         │
  │  lib/mcp/session.ts:16-23   getOrCreateSessionId() → sessionId          │
  │  lib/mcp/session.ts:26-29   readSessionId() → sessionId | null          │
  └────────────────────────────┬──────────────────────────────────────────┘
                               │  sessionId
  ┌─ Server memory (per warm instance) ───▼──────────────────────────────┐
  │                                                                        │
  │  lib/state/insights.ts                                                 │
  │    state: Map<sessionId, SessionFeed> = new Map()                      │
  │    SessionFeed = {                                                     │
  │      insights:       Map<insightId, Insight>                           │
  │      investigations: Map<insightId, Investigation>                     │
  │      anomalies:      Map<insightId, Anomaly>                           │
  │    }                                                                   │
  │    sessionState(sid)  → get-or-create the inner Maps                   │
  │    putInsights(sid,…) → s.insights.clear() (scoped) + set new items    │
  │    getInsight / putInvestigation / getInvestigation                    │
  │                                                                        │
  │  lib/state/investigations.ts                                           │
  │    mem: Map<insightId, AgentEvent[]>                                   │
  │    getCachedInvestigation(id):                                         │
  │      mem.get → file.get (dev only) → demo-file.get → null              │
  │    saveInvestigation(id, events):                                      │
  │      mem.set + writeFileSync (dev only)                                │
  └────────────────────────────┬──────────────────────────────────────────┘
                               │  durable fallback for cold starts + demo
  ┌─ Disk ────────────────────▼──────────────────────────────────────────┐
  │  lib/state/demo-insights.json       (committed snapshot)               │
  │  lib/state/demo-investigations.json (committed snapshot)               │
  │  .investigation-cache.json          (dev only, gitignored)             │
  │  .auth-cache.json                   (dev only, gitignored)             │
  └─────────────────────────────────────────────────────────────────────────┘

  ┌─ Browser (client-side state, mirrors server) ─────────────────────────┐
  │  sessionStorage:                                                       │
  │    bi:insight:<id>  (per-card stash from useBriefingStream)            │
  │    bi:diag:<id>     (step-2 → step-3 diagnosis handoff)                │
  │    bi:reconnecting  (useReconnectPolicy one-shot guard)                │
  │  localStorage:                                                         │
  │    bi:mode          ('demo' | 'live-bloomreach' | 'live-synthetic')    │
  └────────────────────────────────────────────────────────────────────────┘
```

## Elaborate

**Why no database.** Three reasons. (a) There's no cross-session aggregation — each user gets their own briefing scoped to their own Bloomreach workspace; no analytics-on-analytics. (b) Cold-start regeneration is cheap — the cost of re-running a briefing is bounded by the rate-limit envelope (~30-60s), and the user already understands "scanning…" as a state. (c) The alternative — a shared store — adds ops surface (Redis or KV provisioning + monitoring + secrets) for zero feature gain. The decision is reviewed in the audit's `storage-choice` lens; the conclusion is "deliberate ceiling, not a missing feature."

**The "warm instance" assumption.** Vercel functions are stateless contractually — there is no guarantee a warm instance survives between requests, and there is no guarantee that two requests from the same session land on the same instance. The Map shape works because (a) most requests *do* land on warm instances most of the time (Vercel's routing tends to keep sessions sticky in practice), and (b) when they don't, the system degrades to "regenerate" rather than failing. The `sessionStorage` stash in the browser is the belt-and-suspenders: even if the server forgets, the client remembers enough to keep going.

**What changes if state needs to cross instances.** Redis or Vercel KV replaces both inner Maps. The public functions in `lib/state/insights.ts` and `lib/state/investigations.ts` stay the same — `putInsights`, `getInsight`, `getCachedInvestigation`, `saveInvestigation`. The implementations become `await redis.set(...)` and `await redis.get(...)`. The session-keyed structure is unchanged; only the storage backend rotates. This is the seam the current shape preserves — state access is already async-shaped in the public surface (well, technically not — `getInsight` is sync today — but the call sites would migrate easily).

**Why `sessionStorage` on the client.** Two reasons. The first (`bi:insight:<id>`) is the cross-instance fallback described above. The second (`bi:diag:<id>`) is the step-2 → step-3 handoff: the diagnostic step writes a `Diagnosis` to `sessionStorage` so the recommendation step can read it without re-running the diagnostic agent. Both are *tab-scoped* — closing the tab clears them — which matches the user's mental model (a session is a tab's lifetime).

## Interview defense

**Q: Why is there no database in this app? Walk me through the state choices.**

> Three state owners on the server, all in process memory, all keyed by session. The first is `Map<sessionId, SessionFeed>` in `lib/state/insights.ts` — one entry per user, holding their insights, investigations, and anomalies. The second is `Map<insightId, AgentEvent[]>` in `lib/state/investigations.ts` — the per-investigation event trace, used to hydrate back-nav without re-running the agent. The third is `Map<sessionId, SessionAuthState>` in `lib/mcp/auth.ts` — OAuth tokens, in dev backed by a gitignored file and in prod backed by an encrypted cookie. Durable storage comes from two sources: the OAuth cookies survive deploys, and the committed `lib/state/demo-*.json` files are the always-available fallback. The choice not to have a DB is deliberate because the data is per-session and cheap to regenerate — a cold start costs one briefing run, which the user already sees as "scanning…" Adding a DB would buy nothing and cost ops surface.

```
  the three server state owners

  1. Map<sessionId, SessionFeed>  → insights, investigations, anomalies
  2. Map<insightId, events[]>     → investigation event traces
  3. Map<sessionId, AuthState>    → OAuth tokens (cookie-backed in prod)

  durable fallback:
    demo-*.json (committed)       → the demo path
    bi_auth cookie                → OAuth survives deploys
```

**Anchor:** `lib/state/insights.ts:7-23`, `lib/state/investigations.ts:11-41`, `lib/mcp/auth.ts:144-152`.

**Q: What's the load-bearing detail in `putInsights`?**

> The fact that `s.insights.clear()` operates on the *per-session* inner Map, not the outer map. Before this shape, the state was a single flat `Map<insightId, Insight>` at module level, and `putInsights` cleared the whole thing before adding new items. Each briefing replaced the feed, which was correct for one user — but on a warm Vercel instance serving two users, user A's briefing would wipe user B's feed mid-render. The fix is the outer indirection: `state.get(sessionId).insights.clear()` only clears the inner Map for one user; the outer Map is never cleared by a request. That's the kernel: the bug only appears under multi-tenant warm-instance traffic, but the fix is permanent and zero-cost. Every state owner in this repo follows the same shape — keyed by who owns the data.

```
  the per-session indirection

  state.get(sid).insights.clear()   ← scoped to ONE user
  not:
  state.clear()                      ← would wipe everyone
```

**Anchor:** `lib/state/insights.ts:57-71` plus the explicit comment block above the function body explaining the scoping.

**Q: A user logs in, gets a briefing, navigates to investigate, and the page hits a different Vercel instance. What happens?**

> The investigation page needs the source `Insight` to send to `/api/agent`. The route looks up `getInsight(sessionId, insightId)` — on the new instance, the lookup misses because the briefing was on a different instance. So the page falls back to `sessionStorage`: `useBriefingStream` calls `stashInsights(list)` after every briefing, which writes `bi:insight:<id>` for each card. The investigation page reads that, hands the insight to `/api/agent?insight=…` as a query param or body. The server-side Map is the fast path; the client-side `sessionStorage` is the cross-instance fallback. The architectural lesson: don't trust the server-side Map to be there; let the client carry the data forward when it cheaply can.

```
  the cross-instance fallback

  briefing on instance A  →  putInsights(sid, items)
                              + stashInsights(items)  ← client carries

  investigate on instance B  →  getInsight(sid, id)
                                  ↳ MISS (different instance)
                                ←  sessionStorage.getItem('bi:insight:'+id)
                                  ↳ HIT — handed to /api/agent
```

**Anchor:** `lib/state/insights.ts:73-75`, `lib/hooks/useBriefingStream.ts:53-60, 194, 268`.

## See also

- `02-auth-boundary.md` — the third state owner (auth tokens) with the same per-session shape
- `01-request-flow.md` — where `putInsights` is called inside the briefing route
- `08-demo-replay-as-reliability.md` — the demo snapshots as the durable fallback
