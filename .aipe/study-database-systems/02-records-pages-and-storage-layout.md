# 02 · Records, pages, and storage layout

*Row layout, locality, and the cost model of persistence · Case B*

## Zoom out — where this concept lives

In a real DB, "storage layout" means: rows packed into pages, pages
grouped into files, files hitting the disk. Locality determines how
many pages you touch to answer a query. Here you don't have pages —
but you still have **records** with a shape, and you still have
**locality decisions** that determine how much work a read does.

```
Zoom out — the storage-layout question, from record to disk

┌─ what a caller sees ────────────────────────────────────┐
│  const insight = getInsight(sessionId, id)              │
└──────────────────────────────┬──────────────────────────┘
                               │
┌─ ★ THIS CONCEPT ★ ──────────▼──────────────────────────┐
│  the record shape          — what fields ride together │
│  the container layout      — where rows sit relative to │
│                              each other                 │
│  the "page" boundary       — the unit that's fetched   │
│                              or serialized as one blob  │
└──────────────────────────────┬──────────────────────────┘
                               │
┌─ storage backend ────────────▼──────────────────────────┐
│  Map · file · JSON blob · encrypted cookie              │
└─────────────────────────────────────────────────────────┘
```

## Zoom in — the pattern

**The pattern:** *records grouped by access locality.* A row's fields
travel together because they're read together. A page groups rows that
tend to be scanned together. This repo has no pages, but it has three
**page-like blobs** where the "group things read together" instinct is
alive: the encrypted cookie, the demo snapshot, and the receipt JSON.

## Structure pass — one axis across the record locations

**Axis: "who owns the byte layout?"** (physical layout)

```
Trace ownership of the byte layout across the tiers

  Tier                      Record shape decided by     Serialization
  ────                      ─────────────────────       ─────────────
  1. localStorage           JSON.stringify()            per-value blob
  2. sessionStorage         JSON.stringify()            per-value blob
  3. server Map             the JS engine (opaque)      none — objects live
  4. bi_auth cookie         JSON.stringify + AES-GCM    ONE blob for ALL sessions
  5. .auth-cache.json       JSON.stringify              ONE blob for ALL sessions
  6. git-committed JSON     JSON.stringify(_, null, 2)  ONE blob per artifact
```

The seams that matter:

  → **Tier 3 → Tier 4** (Map → cookie): the "one blob for all sessions"
    seam. Inside the Map, each `SessionFeed` is independent. Encrypted
    into `bi_auth`, they all live in one JSON blob. The cookie is a
    **page** in the classical sense: writing one field rewrites the
    whole page.

  → **Tier 4 → Tier 6** (cookie → git): the crypto seam. The cookie's
    layout is invisible to git; the git-committed JSON is pretty-printed
    and diff-able. Two totally different serialization strategies for
    the same shape of data.

The **most load-bearing choice** here is which fields cluster in the
`SessionFeed` object. Read it once — you get the story:

```typescript
// lib/state/insights.ts:8-12
type SessionFeed = {
  insights: Map<string, Insight>;
  investigations: Map<string, Investigation>;
  anomalies: Map<string, Anomaly>;
};
```

That's a **clustered layout**. Three related maps live inside one
object because they're always accessed together — the briefing writes
all three, the investigate page reads two of them, the "put investigation"
call reads `investigations` after `insights` was already touched. If
these were three independent top-level `Map`s, every read would be
three lookups. As one object, one outer `state.get(sessionId)` warms
the reference for all three.

## How it works

### Move 1 — the pattern

Think of it like a React component's `state` object. You could have
five `useState` hooks; instead you often have one `useState({a, b,
c})` because those three fields change together. Same instinct here:
if fields belong to the same logical unit, group them so one lookup
reaches all of them.

```
Records-and-pages — pattern skeleton

  record  = the smallest logical unit (one insight, one auth blob)
  cluster = a group of records that travel together on read
  page    = the smallest unit the storage layer serializes/loads
            (page ≥ cluster ≥ record)

  ┌────────────────────────────────────────────────┐
  │  page: bi_auth cookie                           │
  │                                                  │
  │   ┌ cluster: session #A ──────┐                 │
  │   │  record: clientInfo       │                 │
  │   │  record: tokens           │                 │
  │   │  record: codeVerifier     │                 │
  │   └───────────────────────────┘                 │
  │                                                  │
  │   ┌ cluster: session #B ──────┐                 │
  │   │  record: clientInfo       │                 │
  │   │  record: tokens           │                 │
  │   └───────────────────────────┘                 │
  └────────────────────────────────────────────────┘

  (one write to session #A's tokens rewrites the WHOLE page)
```

### Move 2 — walk the three page-like blobs

Three concrete "pages" in this repo. Each teaches a different property
of storage layout.

#### Blob 1 — the encrypted cookie as a "shared page"

The `bi_auth` cookie is the clearest page-like structure in the repo.
Look at what's in it:

```typescript
// lib/mcp/auth.ts:19-36
interface SessionAuthState {
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
  state?: string;
}

type Store = Record<string, SessionAuthState>;   // sessionId → SessionAuthState

// Backends selected by env — production hits the cookie path
```

`Store` is a map from `sessionId` to `SessionAuthState`. All sessions
for the same browser cookie live in ONE encrypted blob. In DB terms,
this is a **heap file with one page**: every row is packed together,
and any write means rewriting the page.

```
Layers-and-hops — one field write, the whole page rewrites

┌─ agent route ────────────────────────────────────────────┐
│  provider.saveTokens(newTokens)                          │
└──────────────────┬───────────────────────────────────────┘
                   │ hop 1: mutate ONE field in ctx.store[sid]
                   ▼
┌─ ALS-scoped Store (in memory during the request) ────────┐
│  { "sid-A": {…, tokens: NEW}, "sid-B": {…}, … }         │
│  ctx.dirty = true                                        │
└──────────────────┬───────────────────────────────────────┘
                   │ hop 2: encryptStore(ctx.store) — WHOLE STORE
                   ▼
┌─ AES-256-GCM ────────────────────────────────────────────┐
│  iv || tag || ciphertext                                 │
└──────────────────┬───────────────────────────────────────┘
                   │ hop 3: cookies().set(AUTH_COOKIE, blob)
                   ▼
┌─ Set-Cookie header (bytes on the wire) ──────────────────┐
│  bi_auth = <base64url of the entire encrypted page>     │
└──────────────────────────────────────────────────────────┘
```

**Cost model:** updating one field costs `O(all sessions)` bytes on
the wire, every request. In a real DB this is what page-level updates
look like — the record is small, but the fsync unit is the page.

**Why it's still fine:** each browser only has its own cookie (SameSite
+ per-user), and OAuth writes are rare. The page never grows past
maybe two or three sessions in practice.

**What breaks if the layout changes:** if you flatten `Store` to
`Record<string, unknown>` and skip the `SessionAuthState` grouping,
you lose the ability to atomically read "everything about this
session" — you'd need per-field lookups and each one deserializes the
whole cookie anyway. The cluster IS the read pattern.

#### Blob 2 — `SessionFeed` as a "page in memory"

The in-memory Map doesn't serialize, but it still has locality. Look
at how `putInsights` writes:

```typescript
// lib/state/insights.ts:57-71
export function putInsights(sessionId: string, items: Insight[], rawAnomalies?: Anomaly[]): void {
  const s = sessionState(sessionId);        // ONE outer .get() → warm the cluster
  s.insights.clear();                        // scoped clear — inner map only
  s.anomalies.clear();
  items.forEach((i, idx) => {
    s.insights.set(i.id, i);                 // write clustered with anomalies
    if (rawAnomalies?.[idx]) s.anomalies.set(i.id, rawAnomalies[idx]);
  });
}
```

Notice: **one outer `state.get(sessionId)`, then N inner writes.** If
`insights`, `investigations`, and `anomalies` were three separate
module-level Maps, `putInsights` would `state.get()` three times
(once per Map). Clustering them in `SessionFeed` amortizes the outer
lookup — you pay for the hash once, then you're pointing at the
cluster.

This is exactly the **B-tree page** access pattern in a real DB:
"find the page, then walk the rows." Except the page is a JS object
and the walk is `.set()`.

**Comparison — how the layout affects the read pattern:**

```
Comparison — one clustered object vs three flat Maps

  Clustered (what the code does):

    state.get(sid)                    ← 1 outer hash lookup
       │
       ├─ .insights.set(id, i)         ← inner .set() reuses the ref
       ├─ .anomalies.set(id, a)        ← same
       └─ .investigations.set(...)     ← same

    Total: 1 outer lookup + N inner ops


  Flat (what it would cost):

    insights.get(sid)                  ← lookup 1
    anomalies.get(sid)                 ← lookup 2
    investigations.get(sid)            ← lookup 3

    Total: N outer lookups per row
```

At scale that outer lookup is `O(1)` amortized, so the difference is
constant-factor. But the SHAPE is exactly the "prefetch the page,
then read the rows" story from database systems.

#### Blob 3 — `eval/baseline.json` as a wide row

Now look at the third page-like blob — the committed reference row:

```json
// eval/baseline.json (excerpt, 92 lines total)
{
  "runId": "2026-07-03T04-08-28-644Z",
  "builtAt": "2026-07-03T05:29:44.727Z",
  "caseCount": 10,
  "diagnosis": {
    "perDimensionPassRate": { … 4 dimensions … },
    "perDimensionScoreCounts": { … 4 dimensions × 5 buckets … },
    "verdictDistribution": { … }
  },
  "recommendation": { … same shape as diagnosis … }
}
```

This is a **single wide row** — one artifact, many nested fields.
Compare it with the shape of `eval/receipts/*.json` (one file per
case per run, dozens of files):

```
Comparison — wide vs narrow row layout

  baseline.json (wide, one row, many dimensions)

    ┌───────────────────────────────────────────────────────┐
    │ { runId, builtAt, caseCount,                          │
    │   diagnosis: { passRate×4, scoreCounts×4×5, verdicts},│
    │   recommendation: { … same … } }                      │
    └───────────────────────────────────────────────────────┘

    read: one fread, JSON.parse once → whole thing in memory
    write: one fwrite atomically


  receipts/*.json (narrow, N rows, per-case)

    ┌────────────────────┐  ┌────────────────────┐
    │ case 1, run 1      │  │ case 1, run 2      │  ...
    └────────────────────┘  └────────────────────┘
    ┌────────────────────┐  ┌────────────────────┐
    │ case 2, run 1      │  │ case 2, run 2      │  ...
    └────────────────────┘  └────────────────────┘

    read: readdir + N × fread (the CI gate does this)
    write: append per case (the eval runner does this)
```

The gate at `eval/gate.eval.ts:64-72` reads all receipts for a runId
and computes a new baseline shape from them — that's a **full scan**
over the narrow rows to produce a wide row, then a **comparison** of
two wide rows. Wide-row layout is right for the reference; narrow-row
layout is right for the append-only log.

**In DB terms:** `baseline.json` is a materialized view. `receipts/*`
is the base table. The gate is the incremental refresh + compare.

**What breaks if you invert the layout:** if `baseline.json` were N
files (one per dimension), the gate would N-way join every run. If
`receipts/*` were one giant file, every eval run would need to
rewrite it (write amplification).

### Move 2.5 — current state vs future state

Only one migration is close enough to matter here: **the receipts
folder as a candidate table.** Today it's a heap of JSON files;
tomorrow you might want SQL over it. The instructive part is what
DOESN'T have to change.

```
Comparison — receipts today vs receipts on SQLite

  TODAY (heap of JSON files)                    FUTURE (SQLite table)

  eval/receipts/                                 CREATE TABLE receipts (
    01-…-run1.json                                 case_id      TEXT,
    01-…-run2.json                                 signal_class TEXT,
    …                                              run_id       TEXT,
                                                   diagnosis    JSON,
  read: readdir + N × JSON.parse                   recommendation JSON,
  filter: string suffix match                      PRIMARY KEY (case_id, run_id)
  index: NONE                                    );

  gate takes: ~50ms for 10 cases                 gate takes: ~5ms via query
```

The gate's `computeBaseline` (`eval/baseline.eval.ts:87-95`) is
already shaped like an aggregate query — it reads receipts, groups by
dimension, and computes pass rates. **The record layout doesn't need
to change; only the container does.** That's the payoff of storing
records with a clean shape today: the migration is a wrapping change,
not a rewrite.

### Move 3 — the principle

**Locality is a consequence of access pattern, not a property of the
data.** The `SessionFeed` groups three maps because the code touches
all three together. The cookie packs all sessions into one blob
because the crypto boundary is per-cookie, not per-row.
`baseline.json` is one wide row because the CI gate reads all of it
in one comparison.

Change the access pattern and the layout changes. This is why a real
DB is hard to design: you're committing to a layout BEFORE you know
every access pattern. In this repo you can watch the layout change
as the code changes, because there's no DB frozen in the middle.

## Primary diagram — the three page-like blobs

```
The three "pages" in blooming_insights — three different layout stories

  ┌── Page 1: bi_auth cookie  ─────────────────────────────────────┐
  │                                                                 │
  │   {                                                             │
  │     "sid-A": { clientInfo, tokens, codeVerifier, state },      │  ← cluster
  │     "sid-B": { clientInfo, tokens, … },                        │  ← cluster
  │   }                                                             │
  │                        AES-256-GCM entire blob                  │
  │                        → base64url → HTTP cookie                │
  │                                                                 │
  │   write amp: HIGH (any field → whole page rewritten)           │
  │   read amp:  LOW  (one decrypt gets everything)                │
  └────────────────────────────────────────────────────────────────┘

  ┌── Page 2: SessionFeed (in-memory)  ────────────────────────────┐
  │                                                                 │
  │   Map<sessionId, {                                              │
  │     insights: Map<id, Insight>,          ← inner "row" map     │
  │     investigations: Map<id, Investigation>,                     │
  │     anomalies: Map<id, Anomaly>,                                │
  │   }>                                                            │
  │                                                                 │
  │   layout benefit: one outer .get() warms all three inner maps  │
  │   partition:      by sessionId (never bleeds across users)      │
  └────────────────────────────────────────────────────────────────┘

  ┌── Page 3: eval/baseline.json  ─────────────────────────────────┐
  │                                                                 │
  │   { runId, builtAt, caseCount,                                  │
  │     diagnosis: { rates, counts, verdicts },                     │
  │     recommendation: { rates, counts, verdicts } }               │
  │                                                                 │
  │   wide row · JSON.stringify(_, null, 2) · atomic fwrite         │
  │   read: one fread on every CI run                               │
  │   role: materialized view of eval/receipts/*                    │
  └────────────────────────────────────────────────────────────────┘
```

## Elaborate

**Where does the "record cluster" instinct come from?** From
row-oriented storage engines. Postgres pages hold row tuples packed
together; when you `SELECT *` from a row, the whole row is on one page
and you get every column in one fetch. Column stores flip this: they
pack all values of ONE column together across many rows, because their
access pattern is "read one column across a million rows" rather than
"read one row entirely."

The `SessionFeed` object is a row-oriented choice. If you were doing
analytics — "for every session, count the insights" — column-oriented
would be faster: one flat `Map<sessionId, number>` for counts, no
inner map traversal. But this repo's access pattern is
"give me all three related maps for this session, then work with them
locally," which is exactly the row-store sweet spot.

**When would you flip to a column store here?** When you start
computing aggregates across all sessions in real time — a "total
insights emitted today" gauge on a dashboard. That's a scan-heavy
workload, and the current layout would require walking every
`SessionFeed` and summing every inner map. A parallel flat counter
would be one lookup.

## Interview defense

**"How is data laid out for storage in this app?"**

Answer: *"Three page-like blobs, each with a different layout story.
The `bi_auth` cookie packs all OAuth sessions into one AES-encrypted
blob — that's page-level write amplification, but it's fine because
OAuth writes are rare. The `SessionFeed` in-memory object clusters
three related maps because the code touches them together — one outer
lookup warms all three. The `eval/baseline.json` file is one wide row
because the CI gate reads the whole thing in one comparison. Each
layout matches its access pattern."*

**"What does the write amplification look like on the cookie?"**

Answer: *"Rewrites the entire encrypted store on every dirty request.
The 'row' is a `SessionAuthState`; the 'page' is the `Store` record
that holds all sessions. But the AsyncLocalStorage discipline in
`withAuthCookies` batches every provider-method write into one commit
at request end, so it's ONE cookie-set per request, not one per
field. That's the reason ALS is there."*

**"What's the difference between `baseline.json` and `receipts/*`?"**

Answer: *"Wide row vs narrow rows. `baseline.json` is a materialized
view: one file, all dimensions aggregated. `receipts/*` is the base
table: one file per case per run. The gate reads all narrow rows,
computes an aggregate shape identical to the baseline, and compares.
That layout means every eval run is an append to the base table and
a re-materialization of the view — write cost stays low, read cost
stays low."*

The load-bearing skeleton part interviewers routinely forget:
**the clustered outer lookup in `sessionState()`.** Without it,
`putInsights` would do three separate outer-map lookups (one per
inner map). Naming that clustering explains WHY `SessionFeed` is one
object and not three siblings.

## See also

  → `01-database-systems-map.md` — the tier each of these pages lives on
  → `03-btree-hash-and-secondary-indexes.md` — the outer lookup as a
    hash-index probe
  → `07-wal-durability-and-recovery.md` — `receipts/*` as the WAL
