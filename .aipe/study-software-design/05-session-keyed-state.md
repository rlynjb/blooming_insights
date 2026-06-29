# 05 — session-keyed in-memory state (the correctness boundary)

## Subtitle

Module-private mutable state · multi-tenant correctness · information hiding — *Project-specific (Vercel concurrency)*.

## Zoom out — where this state lives

This is the smallest Pass 2 file. It earns its place because the design move it carries is the only thing standing between *one user's data* and *another user's data* on a warm serverless instance. Tiny module, tiny interface, real correctness invariant.

```
  Zoom out — where session-keyed state sits

  ┌─ Browser tab A (user A) ──┐  ┌─ Browser tab B (user B) ──┐
  │  POST /api/briefing       │  │  POST /api/briefing        │
  │  cookie: bi_session=A1B2  │  │  cookie: bi_session=X9Y8   │
  └────────────┬──────────────┘  └────────────┬───────────────┘
               │                               │
               ▼                               ▼
          ┌────────────────────────────────────────────┐
          │  ONE warm Vercel Node.js process            │
          │  (Next.js route handlers share globals)     │
          └────────────────────────┬───────────────────┘
                                   │
  ┌─ The state (★ THIS CONCEPT ★) ─▼──────────────────┐
  │  lib/state/insights.ts                             │ ← we are here
  │    state: Map<sessionId, SessionFeed>              │
  │    sessionFeed = {insights, investigations,        │
  │                   anomalies}                       │
  └────────────────────────────────────────────────────┘
```

Two users hit the same process. Without the session keying, `putInsights(items)` from user A's briefing would wipe user B's feed mid-request. The whole concern of this file is *that doesn't happen*.

## Zoom in — what it is

When a serverless function is "warm" — i.e. the same Node.js process serves multiple incoming requests — any module-level mutable state is shared across all those requests. The naïve version of this file would be a single `Map<string, Insight>` at module scope. That works in dev (you're the only user). It catastrophically fails in production (any user's briefing wipes every other user's feed).

The fix is to **key the state by session ID**. The outer map's entries are per-user sub-maps; nothing operating on one session's sub-map touches another's. The cookie-driven `sessionId` is the partition key.

The role-vocabulary:

```
  outer state    the process-global container (never cleared by a request)
                 → state: Map<sessionId, SessionFeed>
  sub-state      the per-session container (cleared by THIS session's request)
                 → SessionFeed = { insights, investigations, anomalies }
  partition key  the value that selects one session's sub-state
                 → sessionId (from the bi_session cookie)
  invariant      the thing the partitioning guarantees
                 → a request mutating session A never affects session B
```

## Structure pass — layers · axes · seams

Three layers: the **request** (which carries a session cookie), the **state module** (which keys by session), the **outer map** (which holds all sessions). Trace one axis: **what's the blast radius of a write?**

```
  Trace "what does this write affect?" down the layers

  ┌─ request (one user) ────────────────────────────┐
  │  cookie: bi_session=A1B2                        │
  │  intent: refresh MY feed                        │
  └──────────────────┬──────────────────────────────┘
                     │  carries sessionId
                     ▼
  ┌─ state module ──────────────────────────────────┐
  │  putInsights(sessionId='A1B2', items)            │ ← blast radius:
  │    s = sessionState('A1B2')                      │   one sub-map
  │    s.insights.clear()  ← THIS user's insights    │
  │    s.anomalies.clear() ← THIS user's anomalies   │
  │    s.investigations  ← UNTOUCHED                 │
  └──────────────────┬──────────────────────────────┘
                     │  reads/writes one entry of the outer map
                     ▼
  ┌─ outer map ─────────────────────────────────────┐
  │  state: Map<sessionId, SessionFeed>             │
  │    'A1B2' → SessionFeed { insights: cleared }    │
  │    'X9Y8' → SessionFeed { insights: ← untouched }│
  └─────────────────────────────────────────────────┘
```

The seam between layers 1 and 2 is **the function signature**: every public function takes `sessionId` as its first argument. That's the partition key, made explicit at every call site. Above the seam, the request thinks "refresh my feed." Below the seam, the state module thinks "clear and rewrite session A1B2's sub-map without touching anyone else's."

## How it works

### Move 1 — the mental model

A database with **row-level multi-tenancy** — every row has a `tenant_id` column, every query has `WHERE tenant_id = ?`. The in-memory version is the same idea: the `Map<sessionId, SessionFeed>` is the table, the sessionId is the tenant_id, every public function takes sessionId as its first argument.

The literal shape:

```
  The session-keyed state — process-shared outer map, per-session sub-maps

  ┌─ Map<sessionId, SessionFeed> (process-shared) ────────────────────┐
  │                                                                   │
  │   'A1B2' ─► { insights:        Map<insightId, Insight>,          │
  │              investigations:   Map<insightId, Investigation>,    │
  │              anomalies:        Map<insightId, Anomaly> }         │
  │                                                                   │
  │   'X9Y8' ─► { insights:        Map<insightId, Insight>,          │
  │              investigations:   Map<insightId, Investigation>,    │
  │              anomalies:        Map<insightId, Anomaly> }         │
  │                                                                   │
  │   'Q4R5' ─► { ... }                                              │
  │                                                                   │
  └───────────────────────────────────────────────────────────────────┘

  ↑ a request only ever reads/writes ONE entry of this outer map.
    putInsights() clears ONE entry's sub-maps, never the outer map itself.
```

### Move 2 — the step-by-step walkthrough

#### Part 1 — the shape (the partition)

The two type declarations and the outer map. Three lines that carry the entire correctness story:

```ts
// lib/state/insights.ts:8-14
type SessionFeed = {
  insights: Map<string, Insight>;
  investigations: Map<string, Investigation>;
  anomalies: Map<string, Anomaly>;
};

const state = new Map<string, SessionFeed>();
```

The outer `Map<sessionId, SessionFeed>` is module-private (`const state = ...`, never exported). The only way to read or write it is through the public functions below, all of which take `sessionId`. **That's the hide:** no caller can accidentally iterate the outer map or wipe it; they don't have a reference to it.

#### Part 2 — the accessor that creates on demand

The internal `sessionState(sessionId)` helper. The "create the sub-map lazily" pattern:

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

First call for a session: create the sub-map, return it. Subsequent calls: return the existing one. The caller never sees the create-or-fetch distinction; they just get a `SessionFeed`. **That's part of the hide too** — the lifecycle of when a session's sub-map comes into existence is the module's business, not the caller's.

#### Part 3 — the load-bearing function (the careful clear)

`putInsights` is the function the comment is most defensive about. Read the file-level comment and the function comment together:

```ts
// lib/state/insights.ts:5-7 (file-level)
// Session-scoped feed state. A single warm Vercel instance serves many users
// concurrently, so module-level Maps would bleed between sessions — and
// putInsights' clear() would wipe another user's feed mid-briefing. Each
// session gets its own sub-feed; the outer map is never cleared by a request.

// lib/state/insights.ts:57-71 (function)
export function putInsights(sessionId: string, items: Insight[], rawAnomalies?: Anomaly[]): void {
  // Replace the previous briefing for THIS session — each run IS the current
  // feed, not an addition. Without clearing, a warm serverless instance (or a
  // long-running dev server) accumulates stale insights from earlier runs, so
  // the feed shows yesterday's anomalies alongside today's. Investigations are
  // keyed separately and untouched here. Only this session's sub-maps are
  // cleared — never the outer map, never another session's feed.
  const s = sessionState(sessionId);
  s.insights.clear();                              // ← THIS session's insights only
  s.anomalies.clear();                             // ← THIS session's anomalies only
  items.forEach((i, idx) => {
    s.insights.set(i.id, i);
    if (rawAnomalies?.[idx]) s.anomalies.set(i.id, rawAnomalies[idx]);
  });
}
```

Three properties this function guarantees, each named in the comment:

  → **`s.insights.clear()` clears one session's sub-map, not the outer map.** Calling `state.clear()` here would wipe every user's feed. The named target (`s.insights`) is the protection.
  → **`s.investigations` is untouched.** Investigations are long-running; a new briefing replaces the feed but preserves any drill-down work the user has done. The clear is *scoped to the feed*, not to the whole session.
  → **`s.anomalies` is cleared too** because anomalies are paired with insights — keeping stale anomalies around when their insights are gone would leak the wrong evidence into the next investigation lookup.

The comment carries the *reasoning* (without clearing, stale insights pile up on warm instances), the *scope* (this session only, never the outer map), and the *exception* (investigations are deliberately kept). That's the right density of comment for a function carrying a real correctness invariant.

#### Part 4 — the readers (each takes sessionId)

Five reader functions, each takes `sessionId` first. The discipline is uniform:

```ts
// lib/state/insights.ts:73-92
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

export function putInvestigation(sessionId: string, inv: Investigation): void {
  sessionState(sessionId).investigations.set(inv.insightId, inv);
}

export function getInvestigation(sessionId: string, id: string): Investigation | null {
  return state.get(sessionId)?.investigations.get(id) ?? null;
}
```

Notice: the readers use `state.get(sessionId)?.insights.get(id) ?? null` — optional chaining returns `null` cleanly if the session doesn't exist yet. The writer `putInvestigation` uses `sessionState(sessionId)` (which creates on demand) because writes assume the session has work to record. Read = "tell me what's there if anything"; write = "make sure there's a place to put this."

#### Part 5 — the test-only escape hatch

One ugly but honest helper:

```ts
// lib/state/insights.ts:94-101
/** test-only — when sessionId is omitted, wipe the entire outer map. */
export function _clear(sessionId?: string): void {
  if (sessionId === undefined) {
    state.clear();                                 // ← wipes EVERYTHING
    return;
  }
  state.delete(sessionId);
}
```

The leading underscore signals "internal" / "test-only." Tests use `_clear()` to reset between test cases without hand-managing per-session cleanup; production code calls `_clear(sessionId)` (or never calls it). This is the kind of escape hatch that needs to live in the same file as the invariant it can break — putting it elsewhere would let a careless `import { clear } from '../state'` look reasonable.

The named `_` prefix is the documentation. A pure JSDoc `@internal` would be ignored by a teammate searching for a "clear" function.

### Move 3 — the principle

**The interface protects the invariant; private state without a public-API discipline would not.** The `state` map is module-private. The only way to mutate it is through functions that *all take `sessionId` as the first argument*. That uniformity is the discipline — a future contributor adding a sixth function will naturally type `sessionId: string` first because that's what every other function in the file does.

The deeper principle is one Ousterhout calls *information hiding for a correctness reason* rather than complexity reduction: the decision being hidden ("this state is partitioned by session ID, and the partitioning is load-bearing for multi-tenant correctness") is held inside one file, with the public functions enforcing it by signature.

Compare to the alternative: if `insights` were a top-level `Map<string, Insight>` exported as `export const insights`, the partitioning would need to live at *every call site*. Every reader would need to remember to scope by session; every writer would need to remember to namespace by session. Drop the discipline once and you've got a multi-tenant bug. The cost of forgetting is a security incident.

By contrast, the current shape **makes the partitioning impossible to forget**: the function signature is the contract. You cannot call `getInsight(id)` without passing the sessionId; the compiler tells you. **A correctness invariant enforced by a function signature is the strongest version of information hiding.**

## Primary diagram

The full picture — process, request, partition, scoped mutations:

```
  ┌─ ONE warm Vercel Node.js process ────────────────────────────────────┐
  │                                                                      │
  │  process-shared module state (lib/state/insights.ts):                │
  │                                                                      │
  │  const state: Map<sessionId, SessionFeed>                            │
  │  ┌───────┬─────────────────────────────────────────────────────┐    │
  │  │ key   │ value                                               │    │
  │  ├───────┼─────────────────────────────────────────────────────┤    │
  │  │ A1B2  │ {insights: Map, investigations: Map, anomalies: Map}│    │
  │  │ X9Y8  │ {insights: Map, investigations: Map, anomalies: Map}│    │
  │  │ Q4R5  │ {insights: Map, investigations: Map, anomalies: Map}│    │
  │  └───────┴─────────────────────────────────────────────────────┘    │
  │                                                                      │
  │  ┌─ request 1 (user A1B2) ──┐    ┌─ request 2 (user X9Y8) ──┐      │
  │  │  /api/briefing           │    │  /api/briefing            │      │
  │  │  putInsights('A1B2', xs) │    │  putInsights('X9Y8', ys)  │      │
  │  │    └─► state.get('A1B2') │    │    └─► state.get('X9Y8')  │      │
  │  │        .insights.clear() │    │        .insights.clear()  │      │
  │  │        .insights.set(...)│    │        .insights.set(...) │      │
  │  └──────────────────────────┘    └───────────────────────────┘      │
  │                                                                      │
  │  ↑ two concurrent writes mutate DIFFERENT entries of the outer       │
  │    map. neither touches the other's sub-map. no clear() ever         │
  │    wipes the outer map.                                              │
  └──────────────────────────────────────────────────────────────────────┘

  the partition key flows from the cookie:
  ┌──────────────────────────────────────────────────────────┐
  │  request                                                  │
  │   └─► cookies().get('bi_session')                         │
  │        └─► getOrCreateSessionId(): string                 │
  │             └─► passed into every state-module function   │
  │                  as its first argument                    │
  └──────────────────────────────────────────────────────────┘
```

## Elaborate

This pattern shows up wherever in-process state has to survive across requests but partition by tenant — caching, request memoization, in-memory feature flags, session-scoped agent context. The canonical example outside serverless is a Java servlet container: one JVM, many concurrent requests, any static mutable state is automatically shared, and you have to key by session ID or risk cross-request bleed.

In the serverless world (Vercel, Cloudflare Workers, AWS Lambda) the bleed is more surprising because **the docs frame each request as isolated** — and in early invocations they are, when the function is cold-started for each request. Once the function gets traffic, the runtime keeps the Node.js process warm and reuses it for subsequent requests. Module-level state survives. The first time this surprises a team is usually a bug report along the lines of "I saw another user's data on my feed."

The Bloomreach-specific reason this matters: the alpha MCP server's OAuth tokens are per-user, and the briefing agent runs for tens of seconds. Two users hitting the same warm instance within that window would have collided before the session-keying was introduced. The original code (before the fix that lives in this file's `git log`) was the textbook bug; the comment at lines 5-12 documents exactly what the failure mode was.

The deeper note: this is **information hiding doing work no test could catch**. A unit test of `putInsights` with a single session passes whether or not the function clears the outer map. The correctness invariant is *anti-fragile* — it only matters when two sessions overlap, and writing a test that reliably exercises that race is hard. The discipline of "take sessionId as the first argument; only mutate that sub-map" is the protection that doesn't depend on a test catching the regression.

For the conceptual treatment, read `.aipe/read-aposd/part-2/04-information-hiding.md`. The chapter is about hiding decisions; this file's decision happens to be a correctness one rather than a complexity one. The same primitive serves both.

## Interview defense

### Q1: "Why use module-level state at all? Couldn't you use a Redis or a database?"

```
  the budget for a per-request lookup — measured

  ┌─ alternative: Redis per session ─────────────────────────────────┐
  │  every briefing read: GET bi:session:A1B2:insights  → ~5–15ms    │
  │  every investigation read: 1 more GET per insight   → ~5–15ms    │
  │  per briefing: ~5 reads = ~25–75ms added latency                  │
  │  + Redis is a new dependency, new failure mode, new auth         │
  └──────────────────────────────────────────────────────────────────┘

  ┌─ current: in-process Map ────────────────────────────────────────┐
  │  every read: state.get(sid)?.insights.get(id)  → ~10µs           │
  │  zero new dependencies                                            │
  │  bleed surface: warm instance restart loses everything            │
  │  scale ceiling: ~10K sessions × ~10 insights = ~100K entries     │
  │    (well under Node's GC pressure on a single process)            │
  └──────────────────────────────────────────────────────────────────┘
```

Because this state is **session-scoped and ephemeral by design**. The feed is "what the user just saw in their last briefing run." If the warm instance restarts, the next briefing fetch rebuilds it — that's the same code path that built it the first time. No durability guarantee is needed.

The alternatives carry costs: Redis is +25-75ms per request on a streaming path that's already running tight against Vercel's 300s ceiling, plus a new dependency, plus an authentication story. A database persists too much (the data is genuinely throwaway). Module-level state is the right shape for the requirement *as long as* the session-keying invariant holds.

The tradeoff is honest: the data evaporates on warm-instance restart. The user's recovery is "click the briefing again, which is what they were going to do anyway." That's the right cost to pay for the latency win.

**Anchor:** the data is ephemeral; the partitioning is the only invariant that matters.

### Q2: "How would you test the multi-tenant invariant?"

```
  the test — concurrent writes, scoped reads

  test:  two sessions, interleaved writes, then each session reads
         their own data back

    // session A writes 3 insights
    putInsights('A1B2', [a1, a2, a3]);

    // session B writes 2 insights (this MUST NOT affect A)
    putInsights('X9Y8', [b1, b2]);

    // each session reads only their own
    expect(listInsights('A1B2')).toEqual([a1, a2, a3]);
    expect(listInsights('X9Y8')).toEqual([b1, b2]);

    // now session B re-runs (clears B's sub-map)
    putInsights('X9Y8', [b3]);

    // A is untouched
    expect(listInsights('A1B2')).toEqual([a1, a2, a3]);
    expect(listInsights('X9Y8')).toEqual([b3]);
```

The test file at `test/state/insights.test.ts` exercises exactly this — two sessions writing and reading, checking that each session's view is independent. The test is straightforward because the function signatures *force* the partitioning. You can't write a test that accidentally shares state between sessions; the API doesn't let you.

The harder test — concurrent writes where the timing matters — isn't needed because JavaScript is single-threaded. Two `putInsights` calls on the same process can't actually interleave at the line-by-line level. The test just demonstrates the sequential semantics; the runtime guarantees there's no interleaving below them.

**Anchor:** the function signature enforces the partitioning; the test demonstrates it.

### Q3: "What's the failure mode if the session cookie is missing or wrong?"

```
  what happens with no/bad cookie

  case 1: NO cookie → getOrCreateSessionId() generates a new UUID
                       and sets the cookie. First-time user;
                       sub-map is created on first write.

  case 2: STALE cookie (refers to an evicted session) → state.get(sid)
                       returns undefined; readers return null; writers
                       create a new sub-map. The user sees an empty
                       feed and re-runs the briefing.

  case 3: SPOOFED cookie → user A sends user B's cookie value.
                       lib/state is NOT a security boundary — the cookie
                       has httpOnly + secure + sameSite=none in prod
                       (lib/mcp/session.ts:10-14). Spoofing requires
                       network MITM or a browser-level escalation, both
                       outside this module's threat model.
```

Three cases, three behaviours:

  1. **No cookie** — `getOrCreateSessionId()` in `lib/mcp/session.ts:16-24` generates a UUID and sets the cookie. The state module sees a fresh `sessionId` it has no entry for, returns empty for reads, and creates the sub-map on the first write.
  2. **Stale cookie** — points to a session that was evicted (warm instance restarted). Readers return null; writers create a new sub-map. The user sees an empty feed and re-runs.
  3. **Spoofed cookie** — outside this module's threat model. The cookie has `httpOnly`, `secure`, `sameSite=none` set in production (`lib/mcp/session.ts:10-14`). Spoofing requires network-level MITM or a browser-side escalation; the state module trusts the cookie because the cookie's transport security is the protection.

The state module isn't doing any auth — it's doing partitioning. The cookie's integrity is `lib/mcp/auth.ts`'s job, and it does it with `httpOnly`, `secure`, encrypted-cookie OAuth tokens, and a session-bound session ID.

**Anchor:** the state module partitions; the cookie module authenticates. Separate concerns, separate files.

## See also

  → `00-overview.md` — where this state sits in the request lifecycle.
  → `audit.md` — lens 3 (information-hiding-and-leakage) names this as the cleanest correctness hide.
  → `01-port-and-adapter-data-source.md` — the larger information-hiding example.
  → `03-aptkit-bridge-information-hiding.md` — the AptKit-vocabulary-hiding example.
  → `.aipe/read-aposd/part-2/04-information-hiding.md` — the conceptual chapter.
  → `lib/mcp/session.ts` — the cookie-issuing module that produces the partition key.
