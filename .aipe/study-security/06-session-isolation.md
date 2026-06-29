# Session isolation

**Per-session state scoping on shared serverless instances** (Project-specific implementation of a language-agnostic primitive).

## Zoom out — where this concept lives

A single warm Vercel function instance serves many users concurrently. Module-level state — Maps, caches, the auth store — is shared across all of them unless explicitly partitioned. This concept is the partition.

```
  Zoom out — what shares an instance

  ┌─ Vercel function (warm instance) ────────────────────┐
  │                                                       │
  │  Module-level state (shared across requests)          │
  │   ├─ lib/state/insights.ts: state Map<sid, feed>      │
  │   ├─ lib/state/investigations.ts: mem Map<id, events> │
  │   └─ lib/mcp/auth.ts: memStore (test) / ALS (prod)    │
  │                                                       │
  │  Per-request scope (NOT shared)                       │
  │   └─ AsyncLocalStorage<RequestStore>                  │
  │                                                       │
  │  Many requests in flight                              │
  │   ├─ Alice's GET /api/briefing                        │
  │   ├─ Bob's GET /api/agent?insightId=...               │
  │   └─ Charlie's POST /api/mcp/call                     │
  │                                                       │
  └───────────────────────────────────────────────────────┘
```

The principle: every piece of state on a shared instance must be keyed by the user it belongs to, or it leaks across users.

## Structure pass

**Axes:** trust (each session is its own tenant), state (where does it live, how is it keyed?), failure (a missing key → cross-session bleed).

**Layers:** browser cookie (`bi_session`) → route reads sid → state Map keyed by sid → per-session sub-maps.

**Seam:** the load-bearing seam is the **key function** — every state read/write goes through `sessionState(sessionId)`. Skip the function, the Map becomes a global. Use the wrong key (e.g. a hardcoded "default"), every user shares one bucket.

**Axis flip:** outside `sessionState`, the state is one shared structure. Inside (per sid), each call sees its own sub-structure. The function is where the trust answer flips from "shared" to "scoped."

## How it works

### Move 1 — the mental model

If you've used `Map<userId, UserData>` to fake multi-tenancy in a tutorial, this is that — applied to every piece of mutable state on the request path. The mental shape: **the outer Map is shared; the inner Maps are per-tenant; the routes never see the outer.**

```
  Pattern — keyed-map session isolation

  outer:   Map<sid, SessionFeed>     ← shared, never cleared by a request
  inner:   { insights, anomalies, investigations }  ← per-session, isolated

  request:
    sid = getOrCreateSessionId()  ← from bi_session cookie
    feed = sessionState(sid)       ← outer.get(sid) ?? create new
    feed.insights.set(...)         ← writes hit only this session's sub-map
```

### Move 2 — the step-by-step walkthrough

#### Session identity (`bi_session`)

The `bi_session` cookie is a UUID v4, minted on first contact and persisted:

```ts
// lib/mcp/session.ts:16-24
export async function getOrCreateSessionId(): Promise<string> {
  const jar = await cookies();
  let id = jar.get(COOKIE)?.value;
  if (!id) {
    id = crypto.randomUUID();
    jar.set(COOKIE, id, sessionCookieOpts());
  }
  return id;
}
```

The cookie options match `bi_auth` (httpOnly, secure in prod, SameSite=None in prod, Lax in dev). The id has no semantic content — it's a per-browser correlator that indexes all per-session state.

**What breaks if the cookie is shared (e.g. user copy-pastes it):** the two browsers see each other's feed/anomalies/investigations. The cookie IS the identity; there's no second factor.

#### Per-session feed (`lib/state/insights.ts`)

The outer map is module-level — one per warm instance, shared across all requests on that instance:

```ts
// lib/state/insights.ts:8-23
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

Every read/write goes through `sessionState(sid)` — never `state` directly. The functions that consume the outer map are all keyed:

```ts
// lib/state/insights.ts:73-84
export function getInsight(sessionId: string, id: string): Insight | null {
  return state.get(sessionId)?.insights.get(id) ?? null;
}

export function getAnomaly(sessionId: string, id: string): Anomaly | null {
  return state.get(sessionId)?.anomalies.get(id) ?? null;
}

export function listInsights(sessionId: string): Insight[] {
  const s = state.get(sessionId);
  return s ? [...s.insights.values()] : [];
}
```

**The critical safety move:** `putInsights` clears the session's sub-maps but never the outer map:

```ts
// lib/state/insights.ts:57-71
export function putInsights(sessionId: string, items: Insight[], rawAnomalies?: Anomaly[]): void {
  // Replace the previous briefing for THIS session — each run IS the current
  // feed, not an addition. ...Only this session's sub-maps are cleared —
  // never the outer map, never another session's feed.
  const s = sessionState(sessionId);
  s.insights.clear();
  s.anomalies.clear();
  items.forEach((i, idx) => {
    s.insights.set(i.id, i);
    if (rawAnomalies?.[idx]) s.anomalies.set(i.id, rawAnomalies[idx]);
  });
}
```

**What breaks if the outer map were cleared:** Alice running a new briefing would wipe Bob's mid-investigation cache. The clear-inner-not-outer discipline is what prevents one user's action from affecting another's data on the same instance.

#### Per-session auth store (production)

The auth store uses `AsyncLocalStorage` to scope the cookie-decryption result to one request (covered in detail in `01-encrypted-auth-cookie.md`):

```ts
// lib/mcp/auth.ts:46-47, 86-104
interface RequestStore { store: Store; dirty: boolean }
const requestStore = new AsyncLocalStorage<RequestStore>();

export async function withAuthCookies<T>(fn: () => Promise<T>): Promise<T> {
  if (process.env.NODE_ENV !== 'production') return fn();
  const { cookies } = await import('next/headers');
  const raw = (await cookies()).get(AUTH_COOKIE)?.value;
  const ctx: RequestStore = { store: raw ? decryptStore(raw) : {}, dirty: false };
  const result = await requestStore.run(ctx, fn);
  ...
}
```

Two concurrent requests on one warm instance each get their own `RequestStore`. The encryption key is shared (it's the same `AUTH_SECRET`), but the *decrypted contents* are scoped to whichever cookie value the request brought in. Alice's auth state and Bob's auth state never share a process variable.

#### Investigation cache scoping

`lib/state/investigations.ts` keys the in-memory cache by `insightId` (not by `sessionId`):

```ts
// lib/state/investigations.ts:11
const mem = new Map<string, AgentEvent[]>();
```

This is intentional — investigations are looked up by `insightId` for cache replay (`/api/agent`). But the `insightId` is minted client-side from `crypto.randomUUID()` (`lib/state/insights.ts:26`), so collision across sessions is astronomically unlikely. The route also re-resolves the anomaly through `resolveAnomaly(sid, insightId, insightParam)` (`app/api/agent/route.ts:35-60`), which checks the *session's own* feed first before falling through to the demo snapshot. **A request from Bob with Alice's insightId hits "insight not found" because Bob's `getAnomaly` returns null.**

```ts
// app/api/agent/route.ts:146-151
const sid = await getOrCreateSessionId();
const anomaly = insightId ? resolveAnomaly(sid, insightId, insightParam) : null;
if (insightId && !anomaly) {
  return NextResponse.json({ error: 'insight not found' }, { status: 404 });
}
```

The cached investigation replay (`getCachedInvestigation`) does NOT check session, so if Bob *guessed* a valid Alice-issued insightId AND that insight had been investigated, Bob would get the replay. The mitigation is the un-guessability of UUIDv4 — but it's a thin one. **For a multi-tenant deployment with adversarial users, the investigation cache should also be session-scoped.**

#### Per-request logging key

The phase log line surfaces `sessionId` for incident analysis:

```ts
// app/api/agent/route.ts:331-338
console.log(JSON.stringify({
  route: '/api/agent',
  sessionId: sid,
  mode,
  totalMs: Math.round(performance.now() - t0),
  phases,
  aborted: req.signal.aborted,
}));
```

The sessionId is a per-browser correlator; it lets logs trace "who saw what" without exposing user identity (which is OAuth-internal). For a privacy-strict deployment, even hashing the sid before logging would be a tighter posture.

### Move 2.5 — current state vs target state

```
  Investigation cache scoping — Phase A (today) vs Phase B (target)

  ┌─ Phase A (today) ──────────────────┐  ┌─ Phase B (target) ──────────────────┐
  │ getCachedInvestigation(insightId)   │  │ getCachedInvestigation(sid, id)     │
  │   not session-keyed                 │  │   session-keyed                     │
  │                                     │  │                                     │
  │  Bob can replay Alice's investiga-  │  │  Bob's lookup with Alice's id       │
  │  tion if he knows the UUID          │  │  returns null                       │
  │                                     │  │                                     │
  │  mitigation: UUID unguessable       │  │  defense: don't depend on UUID      │
  └─────────────────────────────────────┘  └─────────────────────────────────────┘
```

Migration cost: change `mem` from `Map<id, events>` to `Map<sid, Map<id, events>>` and update three call sites in `lib/state/investigations.ts`. No data migration (it's in-memory). The demo snapshot path stays session-less (it's intentionally shared).

### Move 3 — the principle

**On shared instances, every mutable map is a leak waiting for a missing key.** The defense isn't avoiding shared instances (you can't on serverless); it's auditing every module-level state structure for "what's the key, and where's the check?" The pattern compounds: a session-scoped feed makes sense if (and only if) the auth store is also session-scoped; the cookie-derived sid is the unifying index. The deeper principle: **scope is a constructor-time decision, not a runtime hope.** Initialize the structure pre-scoped (an outer Map of inner Maps) and the wrong write becomes impossible by shape, not just by discipline.

## Primary diagram

```
  Per-session scoping — three structures, one cookie

  ┌─ Browser ──────────────────────────────────────────────┐
  │  Cookie: bi_session=alice-uuid                          │
  └────────────┬───────────────────────────────────────────┘
               │ hop 1: request with cookie
               ▼
  ┌─ Vercel function (warm; also serving Bob) ─────────────┐
  │                                                          │
  │  getOrCreateSessionId() → "alice-uuid"                  │
  │       │                                                  │
  │       ├──► state.get("alice-uuid")                       │
  │       │       └─ SessionFeed { insights, anomalies, ... }│
  │       │                                                  │
  │       ├──► requestStore.run(ctx, fn)                     │
  │       │       └─ ALS scope: alice's decrypted auth state │
  │       │                                                  │
  │       └──► mem.get(alice's insightId)                    │
  │              └─ (cache; NOT session-keyed today)         │
  │                                                          │
  │  meanwhile: Bob's request runs concurrently              │
  │       ├──► state.get("bob-uuid")                         │
  │       │       └─ SessionFeed (different inner Maps)      │
  │       └──► its own ALS scope                             │
  │                                                          │
  └──────────────────────────────────────────────────────────┘
```

## Elaborate

The pattern is **request-scoped state on shared compute**. The general challenge: serverless platforms (Vercel, AWS Lambda) reuse warm instances across requests for latency. Module-level state survives across requests but is *shared* — not per-user. The two standard answers:

1. **Push state out of process** (Redis, KV, DB). The cleanest, also the most operational overhead.
2. **Key in-process state by request identity** (the pattern here). Cheaper, requires discipline.

This codebase chose (2) for performance + simplicity. The tradeoff: every new state structure has to remember the key discipline. A test that exercises the "two concurrent sessions don't bleed" property catches the regression early — `test/state/insights.test.ts` does some of this, though a dedicated cross-session test would be sharper.

Node's `AsyncLocalStorage` (Node 14+) is the formal mechanism for per-request scope without threading the context through every function — analogous to Java's `ThreadLocal` or Python's `contextvars`. It's load-bearing here for the auth path because the OAuth SDK's many provider-method calls run inside one logical request; ALS gives them a shared context they all see without the routes passing it down.

**Related industry concepts:**
- Tenant isolation in multi-tenant SaaS — same problem at a different scale.
- `AsyncLocalStorage` (Node) / `contextvars` (Python) / `ThreadLocal` (Java) — per-context scope mechanisms.
- Row-level security (Postgres) — the same idea applied to data at rest, with the DB enforcing the tenant key.

## Interview defense

**Q: Why a Map keyed by sessionId instead of `new` per request?**
**A:** Persistence across requests. The feed must survive between "user runs a briefing" and "user clicks an insight" — both are separate requests, possibly on the same or different warm instances. A per-request structure would wipe between them. The Map gives in-process persistence on the same instance; if the user's request lands on a cold instance, the demo snapshot fallback covers it (`app/api/agent/route.ts:50-58`). For a deployment where the same-instance bet is unacceptable, push the Map to KV.

```
  per-request scope     → ALS (auth, formatting context)
  per-session scope     → keyed module Map (feed, anomalies)
  cross-session scope   → none (no shared writable state)
```

**Q: What's the load-bearing part people forget?**
**A:** `putInsights` clears `insights.clear()` and `anomalies.clear()` but NOT `state.clear()`. A single missing word — calling `state.clear()` instead of the inner clears — wipes every session's feed. The comment on lines 60-64 spells it out for the next maintainer. The discipline is "clear inner, never outer," and the test that proves it is in `test/state/insights.test.ts`.

**Q: How does this defend against an active attacker?**
**A:** Mostly it doesn't — it defends against accidental cross-session bleed. The bi_session cookie isn't a credential by itself; an attacker would need to steal the cookie (XSS, malicious extension) to impersonate a session. Once they have it, they have everything that session owns. The boundary that defends against an active attacker is the OAuth scope at the IdP. The session isolation is the boundary against *coding mistakes* on a shared instance.

**Q: What's the gap?**
**A:** The investigation cache. It's keyed by `insightId` (UUIDv4), not by sid. The mitigation is UUID unguessability — but that's a thin mitigation. For an adversarial multi-tenant deployment, change `mem` to `Map<sid, Map<id, events>>`. Today it's "good enough because UUIDs are large"; the right answer is "key it by sid and don't bet on guessability."

## See also

- `01-encrypted-auth-cookie.md` — the ALS-scoped auth store; same pattern at a different layer.
- `02-oauth-pkce-dcr-boundary.md` — where the bi_session cookie originates.
- `audit.md` § 5 (Data exposure and privacy), § 2 (Authentication and authorization).
- `lib/state/insights.ts` — the canonical per-session feed.
- `lib/state/investigations.ts` — the cache with the open gap.
- `lib/mcp/session.ts` — the cookie + getOrCreateSessionId helper.
