# 08 · Replication and read consistency

*Replicas, lag, failover, stale reads · Case B (the frozen replica)*

## Zoom out — where this concept lives

Replication is what happens when you have more than one copy of your
data — a primary and one or more replicas. The classical questions
are: what does the replica see, how stale is it, what happens on
primary failure. This repo has NO live replication (only one Vercel
deployment, one Bloomreach account, one everything). It DOES have a
frozen replica — `lib/state/demo-insights.json` — that plays exactly
the role a stale read replica plays.

```
Zoom out — where replication would sit

┌─ primary write ──────────────────────────────────────┐
│  briefing agent → putInsights → SessionFeed         │
└────────────────────────┬─────────────────────────────┘
                         │
┌─ ★ THIS CONCEPT ★ ────▼─────────────────────────────┐
│  the replication story                               │
│    · primary: SessionFeed in memory                  │
│    · replica: demo-insights.json in git              │
│    · replication event: /api/mcp/capture-demo        │
│    · lag: time since last capture (manual)          │
│    · failover: `?demo=cached` URL flag              │
└────────────────────────┬─────────────────────────────┘
                         │
┌─ reads ────────────────▼─────────────────────────────┐
│  live: through the agent loop                        │
│  demo: static file read of the frozen replica        │
└──────────────────────────────────────────────────────┘
```

## Zoom in — the pattern

**The pattern:** *manually-refreshed frozen read replica.* A committed
JSON snapshot serves the "read-only demo" traffic; the primary
(live agent + MCP) serves the interactive traffic. The refresh is
manual — a dev clicks a button to capture the current session's
feed into the file, then commits it. Lag is measured in "days since
last capture," not seconds.

## Structure pass — one axis across primary and replica

**Axis: "what does each source promise about freshness?"** (staleness)

```
Trace freshness across the read sources

  Source                          Freshness                     Consistency
  ──────                          ─────────                     ───────────
  live SessionFeed                as-of latest putInsights       within a session,
                                  in this warm instance          strong
  ──────                          ─────────                     ───────────
  60s response cache              up to 60s stale                bounded staleness
                                  (per cacheKey)                 within a process
  ──────                          ─────────                     ───────────
  bi_auth cookie                  as-of the last commit         strongly consistent
                                  (per request)                  per user
  ──────                          ─────────                     ───────────
  demo-insights.json              as-of last capture             strongly consistent
                                  (typically weeks)              — but very stale
  ──────                          ─────────                     ───────────
  eval/baseline.json              as-of last baseline build      strongly consistent
                                  (per CI cadence)               within CI
```

The seams that matter:

  → **Live-vs-demo seam** — the `mode` selector in the client
    (`bi:mode`) picks which source serves the reads. Same page,
    different data source.

  → **Same-instance vs cross-instance seam** — within one warm
    Vercel instance, the SessionFeed is strongly consistent.
    Across instances, it's inconsistent (each has its own Map). The
    browser (sessionStorage + cookie) carries state across this seam.

  → **Capture-time vs commit-time seam** — the demo replica is
    written by `writeFileSync` (immediately durable in the working
    tree), then committed to git separately. There's a window where
    the file is on disk but not yet in git; a redeploy in that
    window loses the capture.

The **most load-bearing property** is that the demo replica has **no
lag metric**. Nobody in the codebase checks how old the file is; the
demo mode happily replays whatever is committed, regardless of
whether the workspace has drifted since capture.

## How it works

### Move 1 — the pattern

You've built with a CDN. The primary is your origin server; the CDN
is a stale-tolerant replica that serves cached responses. The origin
is authoritative; the CDN is fast and slightly behind. That's the
shape here — except the "CDN" is a JSON file in git, and the "cache
TTL" is however often a dev runs the capture button.

```
Frozen-replica pattern — kernel

  primary (live agent)                    frozen replica (demo-insights.json)
  ────────────────────                    ────────────────────────────────────
  writes                                   NEVER writes
  reads (agent needs latest)               reads (demo page needs
                                             SOMETHING to display)

     ── capture-demo route ──────────────►
        (dev-only, one-shot, manual)

  the interesting properties:
    · the replica is a static file (no daemon replicates for you)
    · the "sync" is a manual button click
    · the replica can drift arbitrarily far behind
    · reads from the replica never fall back to the primary
```

Kernel of frozen-replica reads — three parts:

  1. **The replica artifact.** A file or blob that captures a
     point-in-time snapshot. Missing → nothing to serve.
  2. **The read-routing decision.** Some flag says "use the replica,
     not the primary." Missing → readers always hit the (slow /
     unavailable) primary.
  3. **The refresh mechanism.** Some way to update the replica when
     it's too stale. **Missing → the replica ages until it's wrong;
     nothing warns you.** This is the exact hazard this repo has.

### Move 2 — walk the three moving parts

Three parts to walk: the capture (write to the replica), the routing
(mode selector), and the read (demo mode's static serve).

#### Part 1 — the capture (writing to the frozen replica)

The `/api/mcp/capture-demo` route is the "replication event" for this
system. It reads the current in-memory feed and writes it to a
committed JSON file:

```typescript
// app/api/mcp/capture-demo/route.ts:34-58 (abbreviated)
// Writes lib/state/demo-insights.json + demo-investigations.json.
// Dev-only route. Manual trigger via the "capture demo" button on the feed page.

writeFileSync(
  join(process.cwd(), 'lib/state/demo-insights.json'),
  JSON.stringify(payload, null, 2),
);

// Investigations only get written when the cache exists
if (haveInvestigationCache) {
  writeFileSync(
    join(process.cwd(), 'lib/state/demo-investigations.json'),
    JSON.stringify(invPayload, null, 2),
  );
}
```

Read this as a **replication event.** The primary (in-memory
SessionFeed) is captured; the replica (JSON file) is updated
atomically via `writeFileSync`; the caller commits the file to git.
Once committed, the replica is durable across redeploys.

```
Sequence — one manual replication event

  dev clicks "capture demo"
      │
      ▼
  fetch('/api/mcp/capture-demo', { method: 'POST' })
      │
      ▼
  route reads session's SessionFeed
      │
      ▼
  writeFileSync(demo-insights.json, JSON.stringify(feed))
      │
      ▼
  return {ok: true, files: […]}
      │
      ▼
  dev: git add + git commit + git push
      │
      ▼
  next deploy: replica is in the bundled repo
```

**Boundary condition — the write-but-not-commit window.** Between
`writeFileSync` and `git commit`, the file is only in the dev's
working tree. A crash / cleanup / branch-switch loses the capture.
There is no atomicity between the fs write and the git commit; a
committed replica is only durable AFTER `git push`.

**In DB terms:** this is **manual, non-atomic replication with no
lag tracking.** In production DBs, replication lag is measured in
milliseconds and monitored; here it's measured in "weeks since
someone hit the button" and monitored by nobody.

#### Part 2 — the routing decision (`bi:mode` picks the source)

The client's mode selector routes reads to either the primary or the
replica:

```typescript
// app/page.tsx:79-96 (mode resolution on mount)
const saved = localStorage.getItem('bi:mode');
if (saved === 'demo') setMode('demo');
else if (saved === 'live-mcp') setMode('live-mcp');
else if (saved === 'live-synthetic') setMode('live-synthetic');
```

```
Comparison — three modes, three data sources

  demo                           live-mcp                       live-synthetic
  ────                           ────────                       ──────────────
  reads: static JSON file        reads: MCP tool calls          reads: SyntheticDataSource
                                        (Bloomreach or            (in-process
                                         env-configured server)    deterministic)
  writes: NONE                   writes: putInsights            writes: putInsights
  freshness: last capture        freshness: real-time           freshness: real-time
                                                                  (deterministic)
  role: reliability path         role: production               role: fresh-visitor UX
        + regression evidence
```

The `demo` mode is the interesting one for this concept. Look at the
comment in `app/page.tsx:60-62`:

```typescript
// demo replays the cached snapshot — still reachable via
// ?demo=cached URL param or by manually setting `bi:mode=demo` in
// localStorage (kept as a reliability path / dev tool / regression evidence),
// but no longer in the mode toggle.
```

**"Reliability path"** is exactly the language a DB engineer uses for
a read replica used during a primary outage. If the live MCP server
is down or the OAuth flow fails, hitting `?demo=cached` gives you a
guaranteed-working page. The reads are stale, but they render.

#### Part 3 — the read (demo mode's static serve)

Reads in demo mode bypass the agent loop entirely:

```typescript
// app/api/briefing/route.ts:22 (referenced pattern)
const DEMO_FILE = join(process.cwd(), 'lib/state/demo-insights.json');
// ... route reads DEMO_FILE and streams the pre-captured insights
```

```
Layers-and-hops — a demo-mode read

┌─ UI · page.tsx ─────────────────────┐
│  mode = 'demo'                       │
│  useBriefingStream('demo', ready)    │
└────────────────┬────────────────────┘
                 │ hop 1: GET /api/briefing?mode=demo
                 ▼
┌─ Route handler · briefing ──────────┐
│  reads lib/state/demo-insights.json  │
│  parses → replays as NDJSON events   │
│  NEVER touches the agent loop        │
└────────────────┬────────────────────┘
                 │ hop 2: NDJSON stream
                 ▼
┌─ Client · useBriefingStream ────────┐
│  receives {type:'insight', …}       │
│  renders identically to live mode    │
└─────────────────────────────────────┘
```

**In DB terms:** the demo route is a **direct read from the frozen
replica**. It never falls back to the primary. If the file is stale,
the render is stale. If the file is missing, the demo fails (there's
no "read primary as fallback" behavior).

**Boundary condition — the schema mismatch.** If the Insight type
shape drifts (a new required field is added, an existing field is
renamed), old demo captures become undecodable. There's no
migration layer between the captured JSON and the current TypeScript
type. In a real DB this would be schema versioning; here it's
"someone remembers to re-capture."

### Move 2.5 — the read-consistency levels, mapped

DB systems name their read-consistency levels precisely. Map this
repo's read paths onto that vocabulary:

```
Read consistency levels — where each source falls

  Level                    Example DB                Repo analog
  ─────                    ──────────                ───────────
  Strong (per-key)         Postgres single-row       withAuthCookies
                                                       (per-request cookie)
  ─────                    ──────────                ───────────
  Snapshot                 Postgres READ COMMITTED   SessionFeed within one
                                                       warm instance
  ─────                    ──────────                ───────────
  Bounded staleness        Redis w/ TTL              60s response cache
                             (60s TTL)                 in BloomreachDataSource
  ─────                    ──────────                ───────────
  Eventual                 Postgres async replica    demo-insights.json
                                                       (with unbounded lag)
  ─────                    ──────────                ───────────
  Prehistoric              A tape backup             demo-insights.json
                             from 2019                 if never re-captured
```

The demo replica sits between "eventual" and "prehistoric" depending
on how long since the last capture. Without a lag metric, you can't
tell which one you're in.

### Move 3 — the principle

**A replica's usefulness is bounded by its lag.** A 100 ms replica
is a read scaling tool; a 100 second replica is a reliability tool;
a 100 day replica is a demo artifact. The lag determines the use
case. In this repo the demo replica is used for the last two — a
reliability path when the primary is down, and a stable artifact
for regression evidence — and both use cases tolerate high lag.

The moment you'd need a low-lag replica here is if the demo mode
ever had to reflect the CURRENT workspace's data — e.g., "show the
last 24 hours of anomalies." Then you'd need automated capture on a
schedule, lag tracking, and possibly fallback-to-primary reads. None
of that exists today, which is a deliberate scoping decision.

## Primary diagram — the primary + replica map

```
Replication story in blooming_insights — primary, replica, and routing

  ┌── PRIMARY (live path) ───────────────────────────────────────┐
  │                                                                │
  │   agent loop → putInsights →                                   │
  │      SessionFeed  (in-memory, per-warm-instance)               │
  │                                                                 │
  │   reads: getInsight / listInsights                              │
  │   consistency: strong within a warm instance                   │
  │   durability: 0 (dies with process)                            │
  │                                                                 │
  └────────────────────┬───────────────────────────────────────────┘
                       │
                       │ manual capture:
                       │  /api/mcp/capture-demo
                       │  (dev-only, POST)
                       ▼
  ┌── REPLICA (frozen, committed) ───────────────────────────────┐
  │                                                                │
  │   lib/state/demo-insights.json                                 │
  │   lib/state/demo-investigations.json                           │
  │                                                                 │
  │   writes: manual only, via capture-demo                        │
  │   reads:  GET /api/briefing?mode=demo                          │
  │   consistency: strong (immutable file)                         │
  │   durability: forever (once committed)                         │
  │   lag: unbounded (last capture ← now)                          │
  │                                                                 │
  └────────────────────────────────────────────────────────────────┘

  ┌── READ ROUTING ──────────────────────────────────────────────┐
  │                                                                │
  │   localStorage bi:mode                                          │
  │                                                                 │
  │   'live-synthetic' → SyntheticDataSource (in-process)          │
  │   'live-mcp'       → live agent loop (primary)                 │
  │   'demo'           → demo-insights.json (frozen replica)       │
  │                                                                 │
  │   route: /api/briefing?mode=... reads the flag once at start   │
  │   never falls back between modes                                │
  └────────────────────────────────────────────────────────────────┘

  ┌── FAILURE MODES ─────────────────────────────────────────────┐
  │                                                                │
  │   primary down (MCP unreachable)                               │
  │     → live-mcp: error banner, reconnect policy fires          │
  │     → user manually switches to ?demo=cached (reliability     │
  │       path)                                                   │
  │                                                                 │
  │   replica stale (drift)                                        │
  │     → NOTHING FLAGS IT — the demo renders happily              │
  │     → this is the top-3 red flag in this study                │
  │                                                                 │
  └────────────────────────────────────────────────────────────────┘
```

## Elaborate

**Where does the "frozen replica for demo" pattern come from?** From
every developer who ever shipped a "static demo" of a live product.
Notion has a demo workspace; Linear has a demo issue tracker; Figma
has a demo file. The pattern is "capture the primary at a
representative moment, commit it, and route demo traffic there." The
tradeoff is always the same: freshness for reliability.

**Why this repo went with a JSON file instead of a proper replica.**
Because the demo mode's job is regression evidence, not real-time
mirroring. The captured JSON is checked into git, gets diffed on
every PR, and provides a stable reference for "does the app still
render insights correctly." A live replica would give you neither of
those properties.

**When would you upgrade to real replication?** If you wanted the
demo mode to reflect "this week's anomalies" rather than "the
anomalies as of the last capture," you'd need scheduled captures.
Once you have scheduled captures, you're a step away from
event-driven captures (capture every time putInsights runs), and at
that point you have real replication. But the effort is only worth
it if the demo mode's job changes.

## Interview defense

**"Does this system have replication?"**

Answer: *"Yes and no. There's no live-replicated database, but there
IS a frozen read replica — `lib/state/demo-insights.json` — that
gets captured manually from a live session via `/api/mcp/capture-demo`
and committed to git. When the client's mode is `demo`, the briefing
route reads from the JSON file instead of running the agent loop.
It's used as a reliability path when the live MCP is down, as
regression evidence in git diffs, and as a stable demo artifact."*

**"What's the lag on this replica?"**

Answer: *"Unbounded and untracked. That's a red flag I'd fix in
production. The capture is a manual dev-only button click, and
there's no metric anywhere for 'time since last capture.' The demo
mode will happily replay a 6-month-old snapshot with no warning.
In a real DB this would be an alerting failure — replication lag
above threshold triggers a page. Here nobody notices until a demo
user reports seeing stale data."*

**"How does the client route reads to the replica?"**

Answer: *"Through the `bi:mode` localStorage flag, resolved on
mount in `app/page.tsx`. Values are `demo`, `live-mcp`, and
`live-synthetic`. The chosen mode gets passed through the URL as
`?mode=` to `/api/briefing`, and the route handler picks the data
source. There's no automatic failover between modes — if the live
mode errors, the user has to explicitly switch to demo via
`?demo=cached` or by editing localStorage."*

The load-bearing skeleton part interviewers routinely forget:
**the demo mode has no fallback to primary.** In real replication,
a replica read that fails often falls back to the primary. Here it
doesn't — a missing or corrupt `demo-insights.json` produces an
error, not a degraded read. Naming this signals you thought about
what "read consistency in the presence of failure" actually means.

## See also

  → `01-database-systems-map.md` — Tier 6 (git-committed) as the
    replica's storage tier
  → `07-wal-durability-and-recovery.md` — capture as a checkpoint
    operation
  → `09-database-systems-red-flags-audit.md` — the stale-replica
    hazard as a ranked finding
  → `study-distributed-systems/` — the same seam viewed as
    "consistency across replicas"
