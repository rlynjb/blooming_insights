# 06 — Access patterns and storage choice

**Storage-shape/access-shape fit · the seam to system-design · why "no database" was actually right**

## Zoom out — where this concept lives

Every other concept file here has taken "no DB" as given and worked around it. This one asks the harder question: **was that the right call?** And if so, when does it stop being right?

```
  Zoom out — the seam to system-design

  ┌─ Storage layer (the choice) ─────────────────────────┐
  │                                                       │
  │  Option A: no DB — tier ladder + in-memory Map        │
  │            ★ WHAT THIS REPO CHOSE ★                   │
  │                                                       │
  │  Option B: Postgres + Drizzle (AdvntrCue's choice)    │
  │  Option C: SQLite local + Supabase mirror (buffr's)   │
  │  Option D: GitHub-as-backend (dryrun's choice)        │
  │  Option E: pgvector + Postgres (for a RAG layer)      │
  │                                                       │
  └───────────────────────────────────────────────────────┘
                     ▲
                     │  the seam:
                     │  "which datastore?" → system-design
                     │  "does its shape fit the reads?" → data-modeling (here)
                     ▼
  ┌─ Access shape (the driver) ─────────────────────────┐
  │                                                       │
  │  Read: per-session hot feed (the briefing)            │
  │  Read: per-insight investigate deep-dive              │
  │  Read: cross-session aggregates? ← NO                 │
  │  Read: user-scoped history? ← NO                      │
  │  Read: full-text search? ← NO                         │
  │  Write: replace-whole-feed atomically                 │
  │  Write: append tool-call events during agent loop     │
  │                                                       │
  └───────────────────────────────────────────────────────┘
```

The question: **given the access shape above, does Option A (no DB) match it — and where does that match break?**

## The structure pass — layers, one axis, seams

Hold one axis: **what's the natural lookup key for this read?**

```
  Axis: "what identifier do I have when I read this fact?"

  ┌── read shape ─────────────────┬── natural key ─────────┐
  │                               │                        │
  │  daily briefing               │  sessionId             │
  │  (home page render)           │                        │
  ├───────────────────────────────┼────────────────────────┤
  │  investigate a specific       │  sessionId + insightId │
  │  insight                       │                        │
  ├───────────────────────────────┼────────────────────────┤
  │  ask a follow-up query        │  sessionId + query     │
  │  (natural-language)           │  string                │
  ├───────────────────────────────┼────────────────────────┤
  │  reset demo mode              │  sessionId             │
  ├───────────────────────────────┼────────────────────────┤
  │  eval: read receipts for a    │  runId (filename)      │
  │  run                          │                        │
  ├───────────────────────────────┼────────────────────────┤
  │  ── NOT PRESENT ──            │                        │
  │  see all my past briefings    │  userId + dateRange    │
  │  favorite an insight          │  userId + insightKey   │
  │  full-text search insights    │  query string          │
  │  compare workspaces           │  workspaceId × N       │
  └───────────────────────────────┴────────────────────────┘

  seam: every "present" read is scoped to sessionId. Every
        "not present" read wants a userId or a query index.
        The DB decision hinges on which side of this seam
        the app crosses.
```

Every existing read is scoped to `sessionId`. Every hypothetical read that would demand a DB is scoped to *something else* — a user id, a query string, a workspace. **That's the whole story: as long as the access shape is session-scoped, the tier ladder is enough.** Cross the seam into user-scoped or query-scoped reads, and the tier ladder runs out.

## How it works

### Move 1 — the mental model

You know this from the shape-matches-store rule anyone who has picked between Postgres and Redis has felt: **you don't pick the store first, you pick the store to fit the shape.** Redis is right if you're storing "the value for a key" and reading it back by key. Postgres is right if you're joining tables. A document store is right if you're storing "the whole aggregate" and reading it whole.

This app's shape: **whole aggregates, keyed by session, read back whole.** That's a document-store shape. And the tier-2 `Map<sessionId, SessionFeed>` is *literally* a document store — one document per session, the whole SessionFeed as the value, get-by-session-id as the read.

```
  The pattern — access shape drives the store shape

    "how do I read this?"          natural store           natural analog
    ─────────────────────           ───────────────         ─────────────
    by primary key, whole           document store          Map<pk, doc>
    by predicate, filtered          relational              SELECT ... WHERE
    by similarity, ranked           vector store            embed + kNN
    by full-text, ranked            search engine           inverted index
    by timestamp range              time-series             time-partitioned

  this repo: 100% "by primary key (sessionId), whole"
             → Map<sessionId, SessionFeed> is the RIGHT shape
             → adding Postgres would just re-implement Map with more latency
```

The verdict: **for the current access shape, an in-memory `Map` is the correct store.** Adding Postgres would be adding a network hop to a get-by-key that's already O(1) in the process. That's not conservatism — that's shape-fit.

### Move 2 — the specific access patterns, one by one

#### Access pattern 1 — the daily briefing (home feed)

**Read:** `listInsights(sessionId)` → render feed. Fires once per home-page load.

**Write:** `putInsights(sessionId, items)` — replace whole feed atomically, ~5-10 items.

**Store shape:** `Map<sessionId, SessionFeed>` with `insights: Map<id, Insight>`.

**Match:** yes. The read is "give me all insights for this session"; the store gives it in O(N) where N is small (5-10). The write is "replace the whole feed"; the store supports it with `.clear()` + set. No index needed, no query planner, no marshalling cost.

**When it stops matching:** the moment a user has *multiple* briefings across time and wants to see the archive. Today's map has *one current briefing* per session, replaced on each new run. History becomes: `Map<(userId, date), SessionFeed>` — which is still a document-store shape, but keyed by (user, date), which means an auth layer and a real user identity, which means a DB.

#### Access pattern 2 — the investigate deep-dive

**Read:** `getInsight(sessionId, id)` → hydrate the insight. Then `getCachedInvestigation(id)` → hydrate the reasoning trace. Streams new agent events via SSE if not cached.

**Write:** `putInvestigation(sessionId, inv)` after the agent completes. Also `saveInvestigation(insightId, events)` to the fallback tier for dev-mode persistence.

**Store shape:** in-memory `Map<insightId, Investigation>` + a three-source fallback chain (see file 01).

**Match:** yes. The read is "give me the investigation for this insight ID"; the store gives it in O(1). The three-source chain (in-memory → dev file → committed demo) covers the three failure modes: cold start, dev restart, demo-mode fallback.

**When it stops matching:** users want to *share* an investigation link. The URL today is `/investigate/{insightId}`, and the insight ID is a session-scoped UUID — meaningless to another user. Sharing requires a *durable* insight ID that survives session boundaries, which is exactly the modeling change file 02 walked in the "favorites" interview answer.

#### Access pattern 3 — the natural-language query

**Read + write:** the query box at the bottom of every screen accepts free-form questions, dispatches to the agent loop, and streams events back. No storage happens; the results render inline and vanish on refresh.

**Store shape:** none. The result lives in component state, never persisted.

**Match:** yes, by omission — the design says "queries don't persist," so there's nothing to store. That's a modeling call, not a technical one: the team decided ephemeral queries were fine, and the store shape follows.

**When it stops matching:** a "query history" or "save this query" feature. Then queries need a durable identity + a store — another tier-6 use case.

#### Access pattern 4 — the auth boundary (bi_auth cookie)

**Read + write:** every MCP-touching request decrypts the cookie into an ALS context, mutates, re-encrypts on flush.

**Store shape:** `Record<sessionId, SessionAuthState>` serialized into one cookie.

**Match:** *scaled to one entry per browser*, yes. The cookie carries only the current session's OAuth state. It's shaped as a `Record` for future-proofing (multi-session-per-browser), but effectively used as a single-entry map.

**When it stops matching:** cross-device auth. A user logs in on desktop, wants to see their briefings on mobile. Cookies are per-browser; you can't share `bi_auth`. That forces a real durable auth store — an auth DB, keyed by user, with per-device sessions.

#### Access pattern 5 — the eval subsystem

**Read shape:** two dominant queries — "all receipts for runId X" (aggregator) and "all receipts for caseId Y" (load-shape review). Both O(F) over the receipts dir. Plus "the current baseline" (single file read).

**Write shape:** append-only. New receipts written per case per run; never mutated.

**Store shape:** filesystem, with filename patterns as the index.

**Match:** yes at hackathon scale (28 receipts total). See file 03 for the O(F) scan analysis. The write pattern (append, never mutate) is exactly what filesystems + git are best at.

**When it stops matching:** ~1,000+ receipts. Filesystem `readdir` starts costing real time; git blobs start bloating. The natural next tier is SQLite over `eval/receipts.sqlite` — same append-only pattern, real indexes, git-friendly with a rebuild step. Not needed today.

### Move 2.5 — comparison with Rein's other system-design portfolio

The five system shapes in Rein's portfolio pick the storage-access match differently. Worth ranking them side-by-side, because this app's "no DB" call is only defensible if the shape of *its* domain matches.

```
  Access-shape → storage-choice, across five projects

  project        primary access shape           storage picked
  ──────────    ─────────────────────           ──────────────

  dryrun        review card by (deckId, cardId)  GitHub JSON files
                write on review                   ← lookup by path,
                spaced-repetition schedule        no relational shape
                (per-card)

  buffr         "give me my vlogs, whole"        SQLite (canonical) +
                offline-first, single-user        Supabase (opt mirror)
                                                  ← document + mirror

  contrl        real-time frame → landmarks      no storage in hot path
                per-frame, no persistence         ← latency budget
                                                    forbids I/O

  AdvntrCue     RAG: embed → kNN → context       pgvector + Postgres
                per-session chat history          ← relational + vector,
                                                    colocated

  blooming      "give me this session's briefing" Map<sess, feed> +
  insights      whole, read-and-render            git-committed JSON
                                                  ← document, ephemeral

  the pattern: EACH project's storage matches ITS access shape.
               No project is "just use Postgres by default."
```

Where blooming insights fits: **ephemeral document store with git-committed durable seeds.** That's a valid shape when the domain doesn't demand user-scoped durability. The moment it does, blooming moves toward the AdvntrCue shape (Postgres + colocated auxiliary indexes) rather than the buffr shape (local-first with mirror), because there's no local device to be authoritative.

### Move 3 — the principle

The principle: **choose storage by matching the shape you read, not the shape you write.** Writes are usually easier to accommodate; reads dominate cost and design. If every read is "get whole aggregate by ID," you want a document store — and an in-memory `Map` is the fastest document store there is. If reads want joins or aggregates, you want relational. If reads want similarity, you want vector. Never the reverse.

The load-bearing consequence for this codebase: **as long as reads stay session-scoped, no DB is the correct call.** The tier ladder answers every read pattern currently in the app. Adding Postgres today would give up latency (a network hop where there was `Map.get`) with nothing to show for it.

The line where that flips is precise: the first read whose natural key isn't `sessionId`. Favorites, per-user history, cross-workspace comparisons, full-text search — all of these need a durable identifier that survives the session. That's when the tier ladder runs out and DB shopping starts.

## Primary diagram — the access-shape/storage-shape fit map

```
  Every access pattern in this repo — matched to its store, and where it breaks

  ─────────────────────────────────────────────────────────────────────────────
  access pattern                    natural key         store          fit
  ─────────────────────────────────────────────────────────────────────────────
  daily briefing (feed render)      sessionId           Map<sess,      ✓
                                                         SessionFeed>

  investigate deep-dive             sessionId +         nested Map     ✓
                                     insightId          + 3-source
                                                         fallback

  natural-language query            (ephemeral)         — no store —   ✓
                                                                       (by design)

  MCP OAuth state                   sessionId           bi_auth        ✓
                                                         encrypted
                                                         cookie

  eval receipts by runId            runId               filename       ✓
                                                         pattern         (small F)

  eval baseline reference           (singleton)         one file       ✓

  ─── the seam ────────────────────────────────────────────────────────────
  BELOW: hypothetical, would demand tier 6 (a real DB)
  ─────────────────────────────────────────────────────────────────────────

  favorites list                    userId +            — needs DB —   ✗
                                     stableInsightKey

  briefing history                  userId + date       — needs DB —   ✗

  shared investigation link         durable insightId   — needs DB —   ✗

  cross-workspace comparison        workspaceId × N     — needs DB —   ✗

  full-text insight search          query string        — needs        ✗
                                                         search index —
  ─────────────────────────────────────────────────────────────────────────

  the rule: every ✓ has sessionId in the key.
             every ✗ needs a durable identifier the session doesn't provide.
```

## Elaborate

Where the pattern comes from: this is *bounded contexts* from Domain-Driven Design applied at the storage layer. The bounded context here is "one session's exploration of one workspace's daily anomalies." Everything inside that context is naturally aggregated per session, per day. Everything outside — user history, cross-user comparison, permanent bookmarks — is a *different* context, and DDD would tell you it deserves its own store, not to be crammed into this one.

The reason "no DB" often gets picked wrong: teams reach for Postgres before they've named the access shape, because Postgres is the "safe default." For a session-scoped ephemeral shape, Postgres is *not* safer — it's slower and more complex, and it obscures the fact that the domain didn't need it. Naming the access shape first prevents that.

The reason not to lean too hard on this: the domain grows. What's ephemeral in v1 gets promoted to durable in v3 when a customer says "I want to see last week's briefings." At that point the correct move isn't to lift-and-shift the `Map` into a DB — it's to *add* a durable tier for the promoted concepts, keeping the ephemeral tier for the reads that stay session-scoped. Two-tier reads: the DB for archive, the `Map` for current. That's the natural evolution.

Related reading: DHH's "one person framework" writing on why Basecamp resists SQL joins for read paths — same shape-fit argument. Also: Fielding's REST dissertation on caching semantics — the tier ladder here is basically Fielding's cacheability semantics stretched across five stores.

## Interview defense

### Q1 — "you don't have a database. Isn't that a hackathon shortcut?"

> It could be, but it's not — it's a shape-fit choice. Every read in this app is scoped to a session ID: the daily briefing, the investigate deep-dive, the OAuth state, the query results. None of them join, none of them aggregate across users, none of them survive the session. That access shape *is* a document store — `key → whole aggregate → read whole`. An in-memory `Map<sessionId, SessionFeed>` is a document store; adding Postgres would just re-implement that with a network hop.
>
> The line where "no DB" would stop being right is precise: **the first read whose natural key isn't `sessionId`.** Favorites, per-user history, shared investigation links, cross-workspace compares — all of these want a durable identifier the session doesn't provide. That's when I'd introduce a real DB, and I know exactly what shape it would take: user-scoped tables, with stable `insightKey` = `hash(metric + scope + baseline)` so anomalies re-firing on Tuesday link back to Monday's favorite.

```
  the sessionId seam

  every current read:           every future read that'd break:
  ─────────────────             ──────────────────────────────
  by sessionId                  by userId
  by sessionId + insightId      by durable insightKey
  by sessionId + query          by query index

  → the tier ladder holds because sessionId is enough.
    it stops holding on the first read that needs more.
```

Anchor: "no DB while sessionId is the natural key; DB the moment it isn't."

### Q2 — "if the demo works, why didn't you 'just add Supabase' like buffr does?"

> Buffr's shape is different. Buffr has a canonical local store (SQLite on-device) and Supabase is an *opt-in* mirror for cross-device sync. That's a local-first shape — the device is authoritative, the cloud is a copy. It works because buffr's user has one device, one identity, and wants their data available on other devices they own.
>
> Blooming Insights doesn't have a local-first story. It runs entirely in a browser tab against serverless functions. There's no device to be authoritative on. If I added Supabase, it wouldn't be "mirror the local store" — it would be "*become* the store," which changes the whole architecture: I'd need user auth (currently only workspace-scoped OAuth), a schema, migrations, RLS policies. That's a real database rollout, and the domain doesn't ask for it *yet*.
>
> When it does ask — the moment favorites or history land — I'd pick Postgres, not Supabase (RLS is nice for tenant isolation but I've already got that via session scoping), and I'd colocate any future vector search (RAG on past insights) in the same instance the way AdvntrCue does. Same reasoning: shape drives store, not defaults.

Anchor: "buffr's local-first shape doesn't map onto this domain; when a DB comes, it's Postgres for the same reasons AdvntrCue picked it."

### Q3 — "walk me through the promotion from 'ephemeral' to 'durable' for the favorites feature."

> Three moves:
>
> First, give `Insight` a **stable key** that isn't a session-scoped UUID. `stableInsightKey = hash(metric + scope + baseline)`. That means when Tuesday's briefing re-detects Monday's anomaly, they share a key — favorites persist across the session boundary. This is a modeling change, not a storage one; it goes in `lib/mcp/types.ts` alongside the existing `id`.
>
> Second, introduce a **tier 6 — a durable DB**. Postgres, single instance, colocated on Vercel. Two tables:
>
> ```
>   users {
>     id           uuid       primary key
>     workspaceId  string     (from OAuth)
>     createdAt    timestamptz
>   }
>
>   favorites {
>     userId      uuid       references users
>     insightKey  string     -- stable, not session UUID
>     createdAt   timestamptz
>     unique (userId, insightKey)
>   }
> ```
>
> Third, **wire it into the existing read path** without disturbing the session-scoped Map. On feed render, look up the user's favorites; join in memory by comparing each rendered `insight.stableInsightKey` against the favorite set. That keeps the hot-path `Map<sessionId, SessionFeed>` untouched — the favorites read is a *separate* small query that runs in parallel.
>
> The whole change: 1 field on `Insight`, 2 tables in a new tier, 1 auth boundary (user identity via existing OAuth), 1 in-memory join. It doesn't disturb any current shape — the tier ladder gains a new rung.

```
  the promotion — three moves, ranked

  1. modeling:    add stableInsightKey to Insight
                    (survives session boundary)
  2. storage:     introduce tier 6 (Postgres)
                    users + favorites tables
  3. read wiring: parallel favorites lookup on feed render,
                    join in memory by stableInsightKey

  what does NOT change:
  · Map<sessionId, SessionFeed> — still the hot-path feed store
  · bi_auth cookie discipline    — still the request-scoped state
  · eval subsystem              — still filesystem-committed
  · demo mode                    — still tier-5 seeded
```

Anchor: "add a rung, don't rewrite the ladder."

## See also

- `01-the-data-model-and-its-shape.md` — the tier ladder this file's storage choice sits inside.
- `03-indexing-vs-query-patterns.md` — the O(1) `Map` access this file justifies.
- `05-migrations-and-evolution.md` — why "no DB" is compatible with real committed data, if you version it.
- `07-data-modeling-red-flags-audit.md` — the "durable identifier missing" red flag is marked here.
