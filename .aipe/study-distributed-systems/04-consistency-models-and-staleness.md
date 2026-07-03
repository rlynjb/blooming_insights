# consistency-models-and-staleness

*Session-scoped state · Warm-instance locality · Read-your-writes escape hatch · Industry standard*

## Zoom out — where this concept lives

The interesting consistency questions in this repo aren't about a database
you own (you don't own one). They're about the client, the warm Vercel
instance, the sessionStorage escape hatch, and how "what the user sees"
lines up with "what the server just did." The load-bearing thing to
recognize: **the client's sessionStorage is a more durable store than the
server's in-memory Map**, and the app knows this.

```
  Zoom out — where state lives in this app

  ┌─ Client layer ────────────────────────────────────────────────┐
  │  sessionStorage — per-tab investigation cache                 │
  │  localStorage    — mode toggle (bi:mode)                      │
  │  ★ SURVIVES WARM-INSTANCE CYCLING ★                           │ ← we are here
  └─────────────────────────┬─────────────────────────────────────┘
                            │
  ┌─ Service layer ─────────▼─────────────────────────────────────┐
  │  Map<sessionId, SessionFeed> — insights, anomalies            │
  │  Map<insightId, AgentEvent[]> — investigation trace           │
  │  BloomreachDataSource.cache — per-instance 60s cache          │
  │  ALL LIVE INSIDE ONE WARM INSTANCE                            │
  │  scope: instance lifetime (minutes to hours)                  │
  └─────────────────────────┬─────────────────────────────────────┘
                            │
  ┌─ Provider layer ──────────────────────────────────────────────┐
  │  Bloomreach — the actual source of truth for workspace data   │
  │  Anthropic — stateless to us                                  │
  └────────────────────────────────────────────────────────────────┘
```

Everything server-side is per-warm-instance. The client is the durable
anchor.

## Structure pass

### Layers of consistency

```
  Four questions, held constant across layers:
  "when a write happens here, when does a read see it?"

  ┌───────────────────────────────────────────────┐
  │ client (browser)                               │
  │   write: sessionStorage.setItem(...)           │
  │   read:  sessionStorage.getItem(...)           │
  │   consistency: strong (same tab, same domain)  │  synchronous
  └───────────────────────────────────────────────┘
      ┌───────────────────────────────────────────────┐
      │ warm Vercel instance                          │
      │   write: state.set(sid, feed)                 │
      │   read:  state.get(sid)                       │
      │   consistency: strong within instance,         │  sticky is best-effort
      │                NONE across instances           │
      └───────────────────────────────────────────────┘
          ┌───────────────────────────────────────────┐
          │ Bloomreach                                 │
          │   write: none (we don't write)             │
          │   read:  execute_analytics_eql             │
          │   consistency: whatever their engine        │  (out of scope)
          │                offers                       │
          └───────────────────────────────────────────┘
```

The answer at the middle layer is the interesting one: **strong within an
instance, nothing across.** That's the constraint the client-side
sessionStorage exists to work around.

### One axis — "how does state survive a warm-instance cycle?"

Trace it:

```
  Vercel warm instance cycles: what survives, what doesn't?

  before:          instance A serves user X → putInsights → Map has data
  cycle:           instance A gets evicted / redeployed / cold-drained
  after:           instance B serves user X → getInsight returns null

  what survives?
    ✗ in-memory Map<sid, SessionFeed>       (lost)
    ✗ BloomreachDataSource.cache Map        (lost)
    ✗ dev file .investigation-cache.json    (dev only)
    ✓ committed lib/state/demo-*.json       (demo mode only)
    ✓ encrypted bi_auth cookie              (client-owned)
    ✓ bi_session cookie                     (client-owned)
    ✓ sessionStorage per-tab data           (client-owned)
    ✓ localStorage bi:mode                  (client-owned)
```

The pattern: **client-owned survives, server-owned doesn't.** Which is
why the `useInvestigation` hook exists — the app builds around this
constraint rather than fighting it.

### Seams

- **The session-id seam** — `getOrCreateSessionId()` at
  `lib/mcp/session.ts:16` gives every browser a stable id via the
  `bi_session` cookie. This seam is what lets the server-side Map be
  "per-session" instead of "shared across users on the same instance."
  Load-bearing for isolation.

- **The client-cache-first seam** — the `/api/agent` route at
  `app/api/agent/route.ts:125-142` checks the on-disk cache
  (`getCachedInvestigation`) BEFORE any live work. This is the seam
  where "the answer might already exist" is honored, saving the whole
  agent invocation. In production the disk cache is empty (serverless
  FS), so this path only fires for the committed demo snapshot.

- **The `sessionStorage → ?insight= param` seam** — the client stashes
  the whole Insight object in sessionStorage on card click, then hands
  it forward as `?insight=<JSON>` on the investigate route. The server
  reads it via `resolveAnomaly` at `app/api/agent/route.ts:35-45`. This
  seam is the app's read-your-writes escape hatch — see the next block.

## How it works

### Move 1 — the mental model: strong within an instance, sessionStorage across

You know how a React component's local `useState` lives only as long as
that component is mounted? A Vercel warm instance's in-memory Map is the
same idea, at a bigger scale — it lives only as long as the instance is
warm. Whatever needs to survive longer has to move to a store the
INSTANCE doesn't own.

```
  The pattern — client is the durable store, server is the cache

     ┌─ client ─────────────────────┐
     │  sessionStorage (per-tab)    │  ← DURABLE for a browsing session
     │  localStorage   (per-domain) │  ← DURABLE across sessions
     │  cookies        (per-domain) │  ← DURABLE, sent with each request
     └──────────────┬───────────────┘
                    │
                    │  bi_session cookie (session id)
                    │  ?insight=<JSON> (per-request payload)
                    ▼
     ┌─ warm instance ──────────────┐
     │  Map<sid, SessionFeed>        │  ← EPHEMERAL, per-instance
     │  BloomreachDataSource.cache   │  ← EPHEMERAL, per-instance, 60s TTL
     └──────────────┬───────────────┘
                    │
                    ▼
     ┌─ Bloomreach ─────────────────┐
     │  source of truth              │  ← DURABLE but expensive to read
     └───────────────────────────────┘
```

The consistency picture is: **each layer trades durability for latency**.
Client is durable but slow to read into the server (requires a request).
Server cache is fast but ephemeral. Bloomreach is durable but rate-limited
and expensive.

### Move 2 — walk the mechanism

#### Session isolation — the outer Map is never cleared

`lib/state/insights.ts:14` — `state = new Map<string, SessionFeed>()`.
The outer map keyed by session id. `putInsights` clears only the
caller's sub-map, never the outer map:

```typescript
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

Bridge from what you know: this is the same shape as multi-tenant
isolation in a shared React context — you key by tenant id, and the
"clear my data" operation only clears the tenant's slice.

**Load-bearing part: the two `.clear()` calls are on
`s.insights` and `s.anomalies`, NOT on `state`.** If the code cleared
`state` instead of `s.insights`, a `putInsights` on one session would
wipe every other session's feed mid-briefing. In the shared warm
instance model, that's a cross-tenant data leak by another name — one
user's briefing wipes another user's feed. The comment at `:63-66`
names this exact hazard.

#### The 60s cache is per-instance (staleness across instances is fine)

`BloomreachDataSource.cache` at `bloomreach-data-source.ts:122` is a
per-instance `Map`. Two warm instances serving the same session-id
each have their own copy. This is a "strong within instance, no
guarantee across" consistency model, and it's fine because:

- **60s TTL bounds the staleness** — even the most stale entry expires
  within a minute
- **Reads don't cross instances mid-request** — one request opens one
  stream, lives on one instance
- **The tools are read-only** — a stale answer is just an older number,
  not a wrong write

The consistency contract is "eventually consistent across instances,
bounded by 60s." Which is exactly what you'd want for read-only data
that's expensive to fetch.

#### The client-side sessionStorage escape hatch — read-your-writes

This is the piece that makes the whole story work. The user clicks
an insight card on the feed, then navigates to the investigate page.
The insight has to survive that navigation, and the warm instance's
in-memory Map might not.

Look at how the card handoff works:

```
  sessionStorage as the read-your-writes hop

  feed page:
    click insightCard
    ────────────────►  sessionStorage.setItem(`bi:insight:${id}`, JSON.stringify(insight))
    router.push(`/investigate/${id}?insight=<encoded>`)

  investigate page:
    reads ?insight= param OR sessionStorage
    ────────────────────►  fetch('/api/agent?insightId=X&insight=<JSON>')

  server (route.ts:35-45):
    resolveAnomaly:
      1. try parse insightParam → use it if valid    ← THE ESCAPE HATCH
      2. fall back to state.get(sid, id)              ← instance-local
      3. fall back to committed demo snapshot         ← only in demo
```

The `insight` query param IS the client's answer to "I just wrote this
insight; you might not remember it." The server prefers the parameter
because it's the only source that survives Vercel's per-instance
memory (comment at `app/api/agent/route.ts:35-38`).

**Load-bearing part: the ORDER of the fallbacks in `resolveAnomaly`.**
Client-provided wins. In-memory second. Committed snapshot last. If
you flipped this order, a stale in-memory entry would win over the
fresh one the client just sent — same class of bug as reading from a
stale replica when the client just wrote to the leader.

#### The two-step investigate flow — client-side handoff, not server-side

Related pattern. The investigate page runs in two steps:

```
  Step 2 → Step 3 handoff

  investigate/[id]/page.tsx (step 2)         investigate/[id]/recommend/page.tsx (step 3)
      │                                          │
      │ runs DiagnosticAgent                     │ runs RecommendationAgent
      │ produces `diagnosis`                     │ needs `diagnosis` as input
      │                                          │
      └── stash diagnosis in sessionStorage ─────┘
          via useInvestigation hook               (server passes ?diagnosis=<JSON>)
```

The diagnosis goes through the client, not the server. The server has
no cross-request memory of what step 2 produced. Same reason as
insights: the client is the durable anchor.

Server-side proof:

```typescript
// app/api/agent/route.ts:267-272 (excerpt)
if (step === 'recommend') {
  // STEP 3: the diagnosis was handed over from step 2.
  diagnosis = parseDiagnosis(diagnosisParam);
  if (!diagnosis) {
    throw new Error('no diagnosis was handed over — open the diagnosis step first');
  }
}
```

`parseDiagnosis(diagnosisParam)` reads the client's handoff. If the
handoff is missing, the server can't reconstruct — hard error.

### The skeleton — what "consistency" reduces to

Isolate the kernel. The pattern is: "client owns durable state, server
owns ephemeral cache, requests carry state forward through query params
and sessionStorage."

What breaks without each part:

- **Drop the client-forward handoff (`?insight=`, `?diagnosis=`)** — a
  warm instance cycle mid-investigation breaks step 2 → step 3. The
  user clicks "see recommendations" and gets "no diagnosis was handed
  over." Breaks the entire two-step flow.
- **Drop session isolation (outer Map keyed by sid)** — every warm
  instance's Map holds one user's data at a time, or worse, mixes
  users. Cross-tenant leak.
- **Drop the `isError` guard on the 60s cache** — a transient error
  gets cached; every read within 60s returns the error. Recovery
  takes 60s. (Same finding as file 03 — the mechanism serves both
  delivery and consistency.)
- **Drop the fallback order in `resolveAnomaly`** — the server prefers
  stale in-memory data over what the client just wrote. Classic
  stale-replica bug pattern.

### Optional hardening layered on top

- **The auth cookie's 10-day `maxAge`** at `lib/mcp/auth.ts:49` — bounds
  how long an encrypted-cookie auth store outlives an instance cycle.
  Tokens expire in minutes on the alpha, but the cookie carrying them
  lives longer, so the app can prompt for re-auth without losing the
  full session.
- **`throwIfAborted()` sprinkled throughout the routes** — every phase
  boundary in `/api/briefing` and `/api/agent` checks `req.signal`
  before doing work. If the client navigated away, the server doesn't
  keep computing values that no reader wants. Bounds staleness of the
  ABORTED case.
- **`useInvestigation` deliberately survives StrictMode double-mount**
  — the hook does NOT cancel the in-flight fetch on cleanup, which is
  intentional (comment cited in `.aipe/project/context.md`). React 19
  StrictMode mounts twice; cancelling on the first cleanup would abort
  a valid in-flight investigation and force a redo.

### Move 3 — the principle

**When the server can't remember, teach the client to remind it.** In
a stateless-runtime architecture (Vercel serverless, AWS Lambda, Cloud
Run), server memory is the least durable store in the whole system. The
practical consistency model isn't "eventually consistent" — it's "the
client owns the durable copy, the server is a cache, and every
request carries the state forward that the server can't guarantee will
still be there next request." Recognize this shape and design UI state
around it; fight it and you'll write cache invalidation code
indefinitely.

## Primary diagram — the consistency picture in one frame

```
  Consistency + durability, one frame

  ┌─ Client (browser) — DURABLE ─────────────────────────────────────────┐
  │                                                                       │
  │   sessionStorage `bi:insight:${id}`   → survives page nav in-tab      │
  │   sessionStorage `bi:investigation:${id}` → survives step 2 → step 3  │
  │   localStorage    `bi:mode`           → survives close/reopen         │
  │   cookies         `bi_session`, `bi_auth` → sent with each request    │
  │                                                                       │
  └───────┬───────────────────────────────────────────────────────────────┘
          │
          │  request carries:
          │    - bi_session cookie (session id)
          │    - ?insight=<JSON>   (client's copy of the write)
          │    - ?diagnosis=<JSON> (step 2's output for step 3)
          ▼
  ┌─ Warm instance — EPHEMERAL ──────────────────────────────────────────┐
  │                                                                       │
  │   state: Map<sessionId, SessionFeed>                                  │
  │       ├─ insights: Map<insightId, Insight>                            │
  │       ├─ investigations: Map<insightId, Investigation>                │
  │       └─ anomalies: Map<insightId, Anomaly>                           │
  │       (lib/state/insights.ts:8-14 — keyed by session, isolated)       │
  │                                                                       │
  │   BloomreachDataSource.cache: Map<`${name}:${args}`, cachedResult>    │
  │       (bloomreach-data-source.ts:122 — 60s TTL, no cross-instance)    │
  │                                                                       │
  │   resolveAnomaly fallback order:                                      │
  │     ①  client-provided ?insight=  (survives instance cycle)           │
  │     ②  state.get(sid, id)         (this instance's memory)            │
  │     ③  committed demo snapshot    (demo mode only)                    │
  │                                                                       │
  └───────┬───────────────────────────────────────────────────────────────┘
          │  hop B (rate-limited)
          ▼
  ┌─ Bloomreach — source of truth ─────────────────────────────────────┐
  │  authoritative workspace data                                      │
  └────────────────────────────────────────────────────────────────────┘
```

## Elaborate

The pattern you're seeing here — "durable client + ephemeral server +
request-carries-state" — is the same shape as:

- **JWT-based auth** — every request carries the token; the server never
  remembers you between requests. Same trade: instance-agnostic, no
  shared store required.
- **URL-as-state SPAs** — the URL carries the app state (filters,
  selection, page); reload restores it. Same trade: bookmarkable,
  shareable, but the URL gets long.
- **React Server Components with client-provided context** — the RSC
  runs stateless; the client feeds context forward with each render.

Where this pattern breaks in a larger system:

- **When the state is too big to fit in a query param or a cookie** —
  encrypted cookies max out at ~4KB in practice (browser limits are
  larger but headers get expensive). This app's insight/diagnosis
  objects fit; a full investigation trace does not (it's stashed in
  sessionStorage, not the URL).
- **When multiple tabs need to share state** — sessionStorage is
  per-tab. If a user opens two tabs to the same insight, each runs
  its own investigation. The system doesn't dedup across tabs.
- **When you need read-your-writes across users** — this system is
  strictly per-user; two users on one instance can't see each other's
  insights (by design). If you had shared workspace state (team
  view), the client-side stash wouldn't help — you'd need a real
  shared store.

The `useInvestigation` hook's decision to NOT cancel the in-flight
fetch on StrictMode cleanup (`.aipe/project/context.md` line 84) is a
consistency call: better to complete the write to the server than to
abort it and possibly restart cold. That's a "prefer completing an
in-flight write to starting a fresh one" rule — a small but real
distributed-systems principle.

## Interview defense

### Q: "How does state stay consistent across the browser and the server?"

Sketch this:

```
     client (durable)          server (ephemeral)
     ────────────────          ──────────────────
     sessionStorage ──────────► ?insight=<JSON>
     sessionStorage ──────────► ?diagnosis=<JSON>
     bi_session cookie ───────► Map<sid, SessionFeed>
                                (this instance only)
```

"The client is the durable store; the server is a cache. Every request
carries the state forward that the server can't guarantee will be
there — the insight object rides `?insight=<JSON>` from the feed to
the investigate route, the diagnosis rides `?diagnosis=<JSON>` from
step 2 to step 3. Server-side memory is a per-warm-instance Map keyed
by session id — strong within an instance, no guarantee across.
`resolveAnomaly` prefers the client-provided payload over the
in-memory copy, which is the read-your-writes escape hatch. This is
because a Vercel warm instance cycle mid-investigation would otherwise
lose the state."

Anchors: `app/api/agent/route.ts:35-58` (resolveAnomaly),
`lib/state/insights.ts:57-71` (session isolation),
`lib/hooks/useInvestigation.ts` (the client-side stash).

### Q: "What breaks if the outer Map key isn't the session id?"

"Cross-tenant leak. If the outer key were something shared across users
(a global feed key), one user's `putInsights` would `.clear()` and
overwrite everyone else's data. The comment at `lib/state/insights.ts:8`
names this exact hazard — a single warm instance serves many users
concurrently. The session-id partition is what keeps user A's briefing
from wiping user B's feed mid-request."

### Q: "What's the consistency model of the 60s response cache?"

"Per-instance strong, cross-instance eventually consistent bounded by
60s. Two warm instances serving the same session-id each have their
own cache Map, so one instance can serve a stale answer for up to 60s
after another instance saw a fresh one. Which is fine: the tools are
read-only, staleness manifests as an older number, not a wrong write.
If we needed cross-instance consistency, we'd use Vercel KV or
Upstash — standard escape hatch. Don't need it yet."

## See also

- 03-idempotency-deduplication-and-delivery-semantics.md — the cache
  from the delivery-semantics angle
- 07-clocks-coordination-and-leadership.md — the OAuth cookie survives
  instance cycles for the same reason sessionStorage does
- 09-distributed-systems-red-flags-audit.md — the "no shared cache"
  risk ranking
