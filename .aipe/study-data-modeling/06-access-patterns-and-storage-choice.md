# 06 — Access patterns and storage choice

**Storage-shape matching access-shape · Industry standard**

## Zoom out, then zoom in

The classical question — *does the storage shape match the read/write
pattern?* — is the seam to system design. **blooming_insights** answers
it with "no database, because the access pattern doesn't ask for one."
This file walks why that's right, names the ceiling, and shows the
buildable target the day the access pattern shifts.

```
  Zoom out — the storage tiers and what each one is for

  ┌─ Browser ───────────────────────────────────────────────────────┐
  │  localStorage 'bi:mode'    user preference (mode toggle)         │
  │  sessionStorage 'inv:<id>' per-tab investigation hydration       │
  └──────────────────┬──────────────────────────────────────────────┘
                     │
  ┌─ Vercel serverless ─────────────────────────────────────────────┐
  │  Cookies: bi_session + bi_auth   per-user identity + tokens     │
  │  in-process Maps                  the feed + investigations      │
  │  60s response cache               substrate dedup                │
  └──────────────────┬──────────────────────────────────────────────┘
                     │
  ┌─ Disk (dev only, gitignored) ───────────────────────────────────┐
  │  .auth-cache.json                                                │
  │  .investigation-cache.json     ★ THIS CONCEPT decides ★          │ ← we are here
  │                                  do we need real persistence?    │
  └──────────────────┬──────────────────────────────────────────────┘
                     │
  ┌─ Committed JSON (versioned) ────────────────────────────────────┐
  │  lib/state/demo-{insights,investigations}.json                   │
  │  the reliable presentation path                                  │
  └──────────────────┬──────────────────────────────────────────────┘
                     │
  ┌─ External substrate ────────────────────────────────────────────┐
  │  Bloomreach Engagement (events, customers, catalogs)             │
  │  SyntheticDataSource (deterministic facts)                       │
  └─────────────────────────────────────────────────────────────────┘
```

Zoom in. There are six storage tiers in the codebase, and exactly one
choice was made deliberately: **no real persistence layer of our own.**
The interesting question is how that choice survives — and what would
break it.

---

## Structure pass — the axis is "who owns this data, and how long does it live?"

```
  Trace ONE axis — "ownership + lifetime" — across tiers

  tier                             | owner       | lifetime           | recoverable
  ─────────────────────────────────┼─────────────┼────────────────────┼─────────────
  browser localStorage             | user        | until they clear   | no — user pref
  session cookie (bi_session)      | server      | session            | re-mint trivially
  auth cookie (bi_auth, prod)      | server      | until re-auth      | re-auth flow
  in-process Maps                  | warm server | until cold/restart | YES, recompute
  dev JSON cache                   | dev box     | until rm           | YES, recompute
  committed demo JSON              | repo        | git history        | YES, recapture
  external substrate (Bloomreach)  | Bloomreach  | forever            | n/a — read-only
  ─────────────────────────────────┴─────────────┴────────────────────┴─────────────

  axis seam:  "do WE own data that we cannot recover from upstream?"
  answer:     NO. every data tier owned by us is recomputable.
  therefore:  no DB needed. the moment that answer flips, a DB earns its keep.
```

Each row's answer to "recoverable" is yes — except for the substrate,
which we don't own. The recoverability of *our* data is the entire
justification for the no-DB choice.

---

## How it works

### Move 1 — the mental model

You know the rule "pick the data structure that matches the access
pattern"? That's `Array.push` vs `Set.add` vs `Map.get`. The same rule
scales up to storage choice: pick the **storage system** that matches
the access pattern. No-DB-because-no-need is a real answer — *if* the
access pattern truly doesn't need one.

```
  The decision tree — what storage matches what access pattern?

  start: does the app OWN data the user creates?
                                 │
                ┌────────────────┴──────────────────┐
              YES                                  NO
                │                                   │
                ▼                                   ▼
  does it need to outlive a process restart?    in-memory cache works
                │                                   │
       ┌────────┴────────┐                          │  this codebase is here:
      YES               NO                          │  every data tier we own
       │                 │                          │  is recomputable from the
       ▼                 ▼                          │  substrate (Bloomreach or
  real DB           in-memory cache                 │   synthetic adapter).
                                                    │
                                                    ▼
                                              done — no DB
```

The codebase sits firmly in the right branch. Every "store" it has is a
**write-through cache of recomputable data**. Lose the cache, recompute.
Done.

### Move 2 — the storage tiers, one at a time

Six tiers. Each one has a different lifetime and a different reason for
existing.

#### **Tier 1: browser localStorage `bi:mode`**

User preference. The toggle between demo / live / live-synthetic
modes persists across visits because users want it to.

```
  bi:mode storage shape

  key:    'bi:mode'
  value:  'demo' | 'live-bloomreach' | 'live-synthetic'
  read:   on every page load (client-side)
  write:  when user clicks the mode toggle

  why localStorage and not a cookie?
    - this is purely client-side UX state, never read by the server
    - cookies would round-trip on every request — wasted bytes
    - localStorage survives across sessions (user expects mode to stick)
```

Match score: ideal. User-scoped, client-only, persistent. localStorage
exists for exactly this.

#### **Tier 2: server session cookie `bi_session`**

Per-user identity for scoping in-memory Maps. A UUID minted on first
request:

```typescript
// lib/mcp/session.ts (snippet)
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

This is the join key for everything in the state layer (see
`03-indexing-vs-query-patterns.md`). Without it, two users hitting the
same warm Vercel instance would share a feed.

#### **Tier 3: server auth cookie `bi_auth` (prod only)**

The encrypted OAuth tokens for Bloomreach. AES-256-GCM under
`AUTH_SECRET`, stored in an httpOnly cookie. In dev, the same tokens
live in `.auth-cache.json` (gitignored, plaintext).

```
  prod vs dev auth storage

  prod (Vercel, serverless):              dev (local):
  ────────────────────────                ───────────
  encrypted cookie (bi_auth)              plaintext file (.auth-cache.json)
  AsyncLocalStorage-scoped store          single-tenant
  per-request decrypt + re-encrypt        load once, write on change

  why the split? serverless filesystem is read-only in prod —
  you can't write a file. cookies are the only writable store.
```

This is the only encrypted-at-rest data in the app. The choice (encrypted
cookie vs server-side session store like Redis) is a system-design call,
not a data-modeling one — but the *shape* of what's stored (a token bag
keyed by user) is data-modeling.

#### **Tier 4: in-process Maps (the actual "database")**

This is the load-bearing tier. The session-keyed `Map<sessionId,
SessionFeed>` in `lib/state/insights.ts` and the
`Map<insightId, AgentEvent[]>` in `lib/state/investigations.ts` are
the entire "live" data layer.

Lifetime: from process start to process death. Vercel keeps a warm
serverless instance alive for ~minutes to ~hours; after that it cold-
starts a new one and the Maps are empty. The next briefing call refills
them from scratch (substrate query → agent loop → write).

```
  the in-process Map as a write-through cache

  request                    state layer                    substrate
     │                            │                              │
     │  GET /                     │                              │
     │ ──────────────────────────►│                              │
     │                            │  listInsights(sessionId)     │
     │                            │  → []  (empty after cold)    │
     │                            │                              │
     │  POST /api/briefing        │                              │
     │ ──────────────────────────►│                              │
     │                            │  agent loop                  │
     │                            │ ────────────────────────────►│ query
     │                            │                              │
     │                            │ ◄────────────────────────────│ events
     │                            │  putInsights(sessionId, [...])│
     │                            │  Maps now have the briefing  │
     │                            │                              │
     │  GET /                     │                              │
     │ ──────────────────────────►│                              │
     │                            │  listInsights → cached       │
     │ ◄──────────────────────────│                              │
```

Match score: ideal **for this access pattern.** Every read is keyed.
Every value is recomputable. The "store" is just the most recent
briefing.

#### **Tier 5: gitignored dev JSON caches**

`.auth-cache.json` and `.investigation-cache.json` exist for developer
ergonomics: when you restart the dev server, you don't want to re-do
OAuth or re-run a 30-second briefing. The cache lets you pick up where
you left off.

```typescript
// lib/state/investigations.ts:6-9
const PERSIST = process.env.NODE_ENV === 'development';
const CACHE_FILE = join(process.cwd(), '.investigation-cache.json');
const DEMO_FILE = join(process.cwd(), 'lib/state/demo-investigations.json');
```

`PERSIST` is the load-bearing flag — file writes only happen in dev,
because Vercel's serverless filesystem is read-only in production.

#### **Tier 6: committed demo JSON snapshots (the presentation reliability layer)**

`lib/state/demo-insights.json` (665 lines) and
`lib/state/demo-investigations.json` (3,487 lines) are the reliable
presentation path. They get checked into git, deployed with the app, and
served when the user picks demo mode.

```
  demo JSON as the "fixed dataset" tier

  ┌─ purpose ──────────────────────────────────────────────┐
  │  - reliable demo for screenshots / interviews / pitches │
  │  - no auth required, no rate limits, instant load       │
  │  - same shape as live data (same types, same UI)        │
  │  - regenerated via one-click capture (dev only)         │
  └─────────────────────────────────────────────────────────┘

  ┌─ what it ISN'T ────────────────────────────────────────┐
  │  - not a database (no updates, no queries)              │
  │  - not user data (it's frozen demo content)             │
  │  - not the source of truth (the substrate is)           │
  └─────────────────────────────────────────────────────────┘
```

Match score: ideal for "data that's part of the deploy." This is *content*,
not *data* — it's versioned with the code because that's the right
lifetime for it.

#### **Tier 7: external substrate (not ours)**

Bloomreach Engagement (live) or `SyntheticDataSource` (in-process). We
*never* write to either. The substrate is the source of truth for events,
customers, catalogs — every metric the agents compute starts from a
substrate query.

```typescript
// lib/data-source/synthetic-data-source.ts:85-108
export const syntheticWorkspaceSchema: WorkspaceSchema = {
  projectId: PROJECT_ID,
  projectName: PROJECT_NAME,
  events: syntheticEvents,
  ...
  totalCustomers: 126_420,
  totalEvents: 757_710,
  oldestTimestamp: Date.UTC(2025, 11, 1),
  dataHorizon: { from: '2025-12-01', to: '2026-06-01', durationDays: 182 },
};
```

The synthetic adapter is a 516-line JavaScript file. Every "row" is a
JS object literal. Counts are hardcoded:
52,840 purchases / 241,900 view_items / 198,400 session_starts /
91,360 cart_updates. That's not a database either — it's a
**deterministic fixture** that pretends to be one, satisfying the
`DataSource` interface so the same agent code runs against it.

```
  why synthetic data is in-process (not in a DB)

  the access pattern: agent issues EQL-like query, gets back rows
  the synthetic answer: pre-computed analytics result object

  any DB you'd reach for would be massive overkill — there's
  exactly one fixed "row" per query type, all deterministic.
  the simplest thing that satisfies the DataSource interface is
  a function that switch()s on tool name and returns canned data.
```

Match score: ideal for fixtures. The data never changes; it's part of
the code; agents can run against it offline with no setup.

### Move 2.5 — current state vs future state

This is the file where the buildable-target comparison matters most.

```
  Current state vs future state — when would the no-DB choice break?

  Phase A — current state                Phase B — buildable target
  ─────────────────────                  ──────────────────────────
  every data tier is recomputable        users can author content
  no cross-session reads                 (saved insights, comments,
  no cross-user analytics                 shared briefings, alerts)
  no audit trail                                       │
  no scheduled jobs                                    │
            │                                          ▼
            ▼                              the access pattern grows:
  Map-of-Maps is enough                    - "all critical insights this week"
  no DB needed                             - "this user's saved annotations"
                                          - "send me an alert when X"
                                                       │
                                                       ▼
                                          → PostgreSQL with:
                                            users(id, email, ...)
                                            insights(id, session_id, ...,
                                                     created_at, severity)
                                            annotations(id, insight_id,
                                                        user_id, body)
                                            alert_rules(id, user_id, metric, ...)
                                          + indexes on (severity, created_at)
                                          + Drizzle migrations
                                          + transactions for multi-row writes

  the migration cost is ~real but bounded:
  - types.ts stays the source of truth (Drizzle generates from types)
  - the Map<id, Insight> wrapper becomes a Postgres query
  - validate.ts still earns its keep at the LLM boundary
  - the demo JSON tier could stay (frozen fixtures don't move to DB)
```

The takeaway: **almost nothing has to change** to make this codebase
ready for a real DB the day the access pattern demands it. The types
are already the source of truth. The data layer is already abstracted
behind `putInsights` / `getInsight` functions. Swapping the Map for a
Postgres call is mechanical, not architectural.

This is the **payoff** of the deliberate no-DB choice: you're not stuck
when you outgrow it.

### Move 3 — the principle

**The right storage is whatever matches the access pattern.** Most
codebases reach for Postgres because that's the default, then discover
they're paying for relational semantics they don't use. **blooming_insights**
does it backwards (and right): identify the access pattern (keyed by
session + insight ID, recomputable from upstream), pick the simplest
thing that fits (in-process Maps), accept the ceiling (no cross-session
reads), document the buildable target (Postgres when the ceiling
becomes a wall).

The generalisation: storage choice is a **product decision in disguise**.
The day the product wants cross-user analytics, you need a DB. Until
then, a Map is the entire data layer. Don't fight the access pattern;
match it.

---

## Primary diagram

The six tiers, what each is for, what would force a change.

```
  Storage tier map — current state + buildable target

  ┌─ TIER ───────────────────┬─ FIT ─┬─ WOULD CHANGE WHEN ───────────────┐
  │                          │       │                                   │
  │ browser localStorage     │  ★★★  │ never (user pref, ideal use)      │
  │   bi:mode                │       │                                   │
  │                          │       │                                   │
  │ session cookie           │  ★★★  │ never (per-user scoping)          │
  │   bi_session             │       │                                   │
  │                          │       │                                   │
  │ auth cookie / dev file   │  ★★   │ if tokens needed to outlive       │
  │   bi_auth                │       │   a single user's browser         │
  │                          │       │   → server-side session store     │
  │                          │       │                                   │
  │ in-process Maps          │  ★★★  │ if access pattern grew secondary  │
  │   state/{insights,       │       │   indexes (e.g. "all critical     │
  │    investigations}.ts    │       │   insights across users")         │
  │                          │       │   → Postgres + indexes            │
  │                          │       │                                   │
  │ dev JSON caches          │  ★★★  │ never relevant in prod            │
  │   .investigation-cache   │       │                                   │
  │                          │       │                                   │
  │ committed demo JSON      │  ★★★  │ if demo data grew to MB or        │
  │   lib/state/demo-*.json  │       │   needed updates between deploys  │
  │                          │       │   → CMS / object storage          │
  │                          │       │                                   │
  │ external substrate       │  ★★★  │ never (not ours; we just read)    │
  │   Bloomreach / Synthetic │       │                                   │
  │                          │       │                                   │
  └──────────────────────────┴───────┴───────────────────────────────────┘

  the load-bearing decision:
  in-process Maps are fit-for-purpose IFF every data tier we own
  is recomputable from the substrate. that property holds today;
  the day it stops holding, Postgres earns its keep.
```

---

## Elaborate

Where this comes from: the **CQRS** (Command Query Responsibility
Segregation) world makes this seam explicit — read models live wherever
they're cheapest to read; write models live wherever they're authoritative.
In **blooming_insights**, the "authoritative write model" is the
substrate (Bloomreach), which the app never writes to. The "read model"
is the in-process Maps, recomputed on every briefing. That's CQRS with
the *commands* delegated to a third party.

The seam to **system design** (`.aipe/study-system-design/`): the choice
between "in-process Maps" and "Postgres on Supabase" is an architecture
call — *which datastore.* That decision belongs in system-design, not
here. This file's job was just to confirm that the *shape* of the data
the app holds doesn't fight whatever store is chosen.

What this codebase consciously doesn't do — and is right not to:

- **No Redis / Memcached.** A second cache layer would buy nothing; the
  Maps are already in-process and the rate limit on the substrate (not
  on us) is the constraint that matters.
- **No relational DB.** Until the access pattern grows beyond
  primary-key Map lookups, Postgres-on-Supabase would add ops burden
  with no read-path benefit.
- **No S3 / object storage.** Demo JSON is small enough to live in
  git; agent output is ephemeral.

What it does consciously and right:

- **Substrate-as-truth.** The app owns nothing the substrate doesn't.
  This is the entire justification for the no-DB choice — and it's the
  property that, if violated, would force the choice to change.
- **DataSource interface.** The `DataSource` abstraction
  (`lib/data-source/types.ts`) means both adapters (Bloomreach, synthetic)
  satisfy the same shape. A third adapter — say, a Postgres-backed
  fixture for tests — would slot in without touching any caller.

What to read next: `audit.md` for the consolidated checklist; the
system-design study guide for the "which datastore" complement to this
file.

---

## Interview defense

**Q: "Why no database?"**

Verdict first: because every data tier the app *owns* is recomputable
from the substrate. The substrate (Bloomreach) is the source of truth for
events, customers, catalogs; the app never writes to it; every metric
the UI shows is recomputed on demand. There's nothing to persist.

```
  the test that decides "DB or no DB"

  question:  is the data RECOMPUTABLE from upstream?
                          │
                          ▼
                ┌─────────┴─────────┐
              YES                 NO
                │                   │
                ▼                   ▼
  in-memory cache is enough    real DB earns its keep
                │
                ▼
  this codebase is here:
    every metric → fresh EQL query
    every Insight → fresh agent emission
    every Diagnosis → fresh agent emission
    losing the cache → next request rebuilds it
```

Anchor: "the day a user can edit an insight — annotate, save, share —
the answer flips and Postgres earns its keep. Until then the substrate
IS the database."

**Q: "What's the ceiling on this design?"**

Verdict first: **cross-session reads.** The Map-of-Maps shape gives O(1)
access within a session and nothing across sessions. The day the product
wants "show me all critical insights from every customer today," that's
a `WHERE severity = 'critical' AND created_at > ...` query — a full
scan over every session's sub-map, with no secondary index to help.
That's when I'd reach for Postgres.

```
  the ceiling, sketched

  current access pattern:            ceiling pattern:
  ────────────────────────           ──────────────────
  by (sessionId, insightId)          by attribute (severity, date)
            │                                   │
            ▼                                   ▼
        Map.get(id)                  WHERE severity = ...
        O(1)                         needs a sorted index or
                                     a real query engine
```

Anchor: "the buildable target is small — types.ts stays the source of
truth, Drizzle generates the schema from it, the `putInsights` /
`getInsight` functions become Postgres queries. Maybe a day of work
when the access pattern flips, no architecture rewrite."

**Q: "What's the riskiest tier?"**

Verdict first: **the committed demo JSON**, because there's no test
that re-validates it against the current types. Adding a required field
to `Insight` would silently break the demo replay — the JSON would
parse, the UI would render with the field undefined, no crash. The fix
is a 30-line Vitest test that runs `isInsight` over every entry. The
audit recommends it.

```
  the silent-drift risk

  demo-insights.json (committed, frozen)
            │
            │  loaded via JSON.parse + cast (no validation)
            ▼
  rendered by UI assuming current Insight shape
            │
            │  if Insight.criticalNewField was added (required):
            │    - JSON parses fine
            │    - field is undefined
            │    - UI renders with empty data
            │    - no error logged
            ▼
  silent regression — only caught by manual inspection
```

Anchor: "loud failures are easy; silent ones are dangerous. The
codebase has strong validators on LLM output but no validator on the
demo JSON snapshots. That's the gap I'd close first if I owned this."

---

## See also

- [`00-overview.md`](./00-overview.md) — the whole storage picture in one
  diagram
- [`03-indexing-vs-query-patterns.md`](./03-indexing-vs-query-patterns.md)
  — the Map shape that makes the in-process tier work
- [`04-transactions-and-integrity.md`](./04-transactions-and-integrity.md)
  — what enforces correctness without a DB-side check
- [`05-migrations-and-evolution.md`](./05-migrations-and-evolution.md)
  — type evolution as the migration story
- [`audit.md`](./audit.md) — the consolidated checklist
- `.aipe/study-system-design/` — the "which datastore" complement to
  this file
