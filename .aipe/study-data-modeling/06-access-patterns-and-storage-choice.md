# Access patterns and storage choice

**Industry name(s):** Storage choice · access-pattern fit · in-memory store · key-value · document store · serverless cold-start · session-scoped state · relational analytics warehouse
**Type:** Industry standard · Language-agnostic · Project-specific (the session-keyed-in-memory variant + the local SQLite analytics variant)

> The storage choice question: **does the storage shape match the read/write pattern?** This repo now has **three storage layers**. (1) **Session-scoped in-memory** `Map<sessionId, SessionFeed>` in `lib/state/insights.ts` for live UI state — by-id reads within a session, per-session isolation between users. (2) **Olist SQLite** on disk under `mcp-server-olist/data/olist.db` — a real relational analytics warehouse with FKs, indexes, NOT NULL, read-only at runtime. (3) **Committed demo seeds** (`lib/state/demo-*.json`) and **eval result snapshots** (`eval/results/<date>/*.json`) — git-tracked, durable forever. The access pattern is **layered by lifetime**: per-request UI state in (1), per-machine analytics state in (2), per-commit fixtures in (3). The classic mismatch from the 2026-06-01 version — "per-process memory on serverless" — is partly bridged by the session-scoping (multi-user safety) and by the wire-format-as-state pattern (the browser carries the data across cold starts). The mismatch hasn't been retired; it's been bounded.

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Three storage layers, one access pattern. The owned data lives in three in-memory `Map`s. A dev-only file-backed cache (`.investigation-cache.json`) survives `npm run dev` restarts. A committed demo seed (`lib/state/demo-insights.json`, `demo-investigations.json`) survives forever — it's git-tracked and serves the offline mode. On Vercel, where serverless instances are ephemeral, the in-memory store is per-instance, so the route handler has a **three-source fallback chain** for resolving any anomaly: client-passed wire-format → in-memory → demo seed.

```
  Zoom out — the storage layers

  ┌─ Read access pattern (UI → route → store) ───────────────┐
  │                                                            │
  │   request: investigate insight `abc-123`                   │
  │                                                            │
  │   resolveAnomaly(id, insightParam):                        │
  │     1. is there a ?insight= JSON param? ── yes → trust it  │
  │     2. is anomalies Map.get(id) ≠ null?  ── yes → use it   │
  │     3. is insights Map.get(id) ≠ null?   ── yes → convert  │
  │        (lossy via insightToAnomaly — the leak)             │
  │     4. is the demo seed JSON's id match? ── yes → use it   │
  │     5. else → 404                                          │
  │                                                            │
  └────────────────────────────────────────────────────────────┘

  ┌─ The three storage layers (in priority order) ───────────┐
  │                                                            │
  │   1. in-memory Maps                                        │
  │      lib/state/insights.ts                                 │
  │      lifetime: one process instance (Vercel: warm only)    │
  │      ephemeral; lost on cold start; no I/O cost            │
  │                                                            │
  │   2. dev file cache                                        │
  │      .investigation-cache.json                             │
  │      lifetime: across `npm run dev` restarts (DEV ONLY)    │
  │      production = NEVER (Vercel FS is read-only)           │
  │                                                            │
  │   3. committed demo seed                                   │
  │      lib/state/demo-insights.json                          │
  │      lib/state/demo-investigations.json                    │
  │      lifetime: forever (git-tracked)                       │
  │      shipped fixture; offline mode; test data              │
  │                                                            │
  └────────────────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question this concept answers: does the choice of `Map` (in-memory KV) match the access pattern? **Yes for the read pattern** — every read is by-id, which is the strongest case for a hash. **No for the write durability** — a briefing computed on one Vercel instance may not be visible to the next one, which is why the wire-format fallback exists (the browser holds the briefing's full Insight JSON in sessionStorage and ships it back to the route). The mismatch isn't with the access pattern, it's with the *deployment model* (ephemeral instances vs the in-process Map assumption).

---

## Structure pass

**Layers.** Same four-layer stack. The interesting layer is the **state module band** + the **deployment substrate** (Vercel serverless vs local dev).

**Axis: durability boundary.** For each piece of state, what survives what? — a request, a warm instance, a cold start, a git commit. Pick the right axis because storage choice is *literally* about durability tradeoffs. Cost is wrong here (RAM is free); failure is wrong (these layers don't fail-propagate). Durability boundary pops the seams: each store layer has a different boundary it survives, and the fallback chain crosses them in priority order.

**Seams.** Three matter. **Seam 1: request ↔ in-memory Map.** Each request reads/writes the same Map within an instance. Per-instance scope. **Seam 2: warm instance ↔ cold start.** In-memory Maps survive warm requests, die on cold start. **Seam 3: process lifetime ↔ committed data.** The demo seed survives indefinitely; the in-memory Maps don't. The fallback chain is the bridge: when the in-memory layer is empty (cold start), the demo seed is the floor.

```
  Structure pass — durability boundaries

  ┌─ 1. LAYERS ──────────────────────────────────────────────┐
  │  UI · Route · State module · Filesystem · Git              │
  │  (deployment substrate matters here)                       │
  └─────────────────────────────┬────────────────────────────┘
                                │  pick the axis
  ┌─ 2. AXIS ──────────────────▼─────────────────────────────┐
  │  durability boundary: what survives what?                 │
  │  per-request / warm-instance / cold-start / git           │
  └─────────────────────────────┬────────────────────────────┘
                                │  trace across seams
  ┌─ 3. SEAMS ─────────────────▼─────────────────────────────┐
  │  S1: request ↔ Map         ★ ALWAYS available (in-process)│
  │  S2: warm ↔ cold start     ★ LOST (Maps die on cold start)│
  │  S3: process ↔ git seed    ★ ALWAYS available (committed) │
  └─────────────────────────────┬────────────────────────────┘
                                ▼
                        Block 4 — How it works
```

---

## How it works

### Move 1 — the storage choice, as a picture

You know how `localStorage.setItem(k, v)` is a key-value store that survives until the user clears it? Same shape here, except (a) it's server-side and (b) "until the user clears it" becomes "until the Vercel instance is reclaimed (~minutes of idle)." The data shape is the same as `localStorage` — string keys, structured values, no joins, no queries. The storage shape (`Map`) matches that perfectly. The mismatch isn't shape; it's durability.

```
  the choice — Map vs the alternatives

  CHOICE                         FITS THIS ACCESS PATTERN?
  ───────────────────────────    ────────────────────────────────
  Map<id, value>     ← current   YES — by-id reads, whole-briefing writes
                                  NO  — durability across cold starts

  Postgres / SQLite              YES — same access pattern + durability
                                  cost: schema + migrations + deps

  Redis                          YES — same access + durability + TTL
                                  cost: a managed service

  filesystem JSON                YES on dev (works today via
                                  .investigation-cache.json)
                                  NO on Vercel (read-only FS)

  why Map is the right call FOR NOW:
    - dataset is bounded (10 insights per briefing)
    - access pattern is by-id only
    - no persistence requirement for the demo (the seed covers offline)
    - the live data is recomputable (re-run the agents)
    - no migration story needed
    - zero dependencies, zero ops

  when it stops being the right call:
    - users expect briefings to persist across sessions
    - the dataset grows past warm-instance memory
    - secondary access patterns emerge (filter by severity, by date)
    - multiple workers need to share state
```

### Move 2 — the three store layers, one at a time

#### `lib/state/insights.ts` — session-scoped in-memory (UPDATED 2026-06-16)

The shape has been refactored from "three module-level Maps shared by all requests" to "an outer Map keyed by sessionId, with three inner Maps per session." This fixes a multi-user safety bug — a single warm Vercel instance serves many users, and module-level globals would let `putInsights().clear()` for user A wipe user B's feed mid-briefing.

```
  the session-scoped layer

  const state = new Map<string, SessionFeed>();        ← outer, NEVER cleared

  type SessionFeed = {
    insights:       Map<string, Insight>;              ← per-session
    investigations: Map<string, Investigation>;        ← per-session
    anomalies:      Map<string, Anomaly>;              ← per-session
  };

  reads:  getInsight(sessionId, id) →
            state.get(sessionId)?.insights.get(id) ?? null
          ── two-level hash lookup, O(1)
  writes: putInsights(sessionId, items, raw) clears + repopulates
          ONLY this session's sub-feed

  lifetime semantics (unchanged):
    LOCAL DEV: outer Map lives until you Ctrl-C the dev server
    VERCEL:    outer Map lives per warm instance — minutes of idle, no longer
               ANY cold start = empty outer Map, fall back to seed/wire-param

  what's new vs 2026-06-01: cross-session isolation.
    user A's briefing run no longer wipes user B's feed.
    test/state/insights.test.ts has explicit isolation tests.
```

#### `mcp-server-olist/data/olist.db` — the SQLite analytics warehouse (NEW)

A real relational store, on disk, owned by the repo. Read-only at runtime (only the seeder writes). Three tools query it (`get_metric_timeseries`, `get_segments`, `get_anomaly_context`); the agent loop calls those tools when `LiveMode === 'live-sql'`.

```
  the Olist SQLite layer

  reads:  prepared statements over 7 tables via better-sqlite3 (sync)
          plans use the 9 indexes (file 03 walks them)
          PRAGMA foreign_keys = ON, journal_mode = WAL

  writes: ONLY by mcp-server-olist/scripts/seed-olist.ts
          drop-and-rebuild pattern — the file is destroyed and recreated
          deterministic: mulberry32(seed=42) → byte-identical every time

  lifetime semantics:
    file lives until git clean or manual unlink
    every npm run seed REPLACES the file (no incremental writes)
    survives Vercel cold starts ONLY when the file is on disk
      (in Vercel serverless: the DB file is NOT shipped — the Olist
       mode is local-development-and-eval only)

  what this is for: Phase 3 evals (eval/scripts/run-detection.ts spawns
  a fresh mcp-server-olist subprocess and grades the monitoring agent's
  output against the seeded_anomalies table). NOT for production UI.
```

#### `lib/state/investigations.ts` — the dev file cache (secondary)

A separate layer just for investigations. Uses the same `Map<insightId, AgentEvent[]>` in memory, but ALSO writes to `.investigation-cache.json` in dev only. The dev cache survives across `npm run dev` restarts so iterating on the investigate page doesn't require re-running every agent.

```
  the dev file cache — DEV ONLY

  const PERSIST = process.env.NODE_ENV === 'development';
  const CACHE_FILE = join(process.cwd(), '.investigation-cache.json');

  reads (in order):
    1. mem.get(insightId)              ← in-process Map
    2. readJson(CACHE_FILE)[insightId]  ← dev file (dev only)
    3. readJson(DEMO_FILE)[insightId]   ← committed seed (always)
    4. null

  writes:
    mem.set(insightId, events)         ← always
    if (PERSIST) {                     ← dev only
      const all = readJson(CACHE_FILE);
      all[insightId] = events;
      writeFileSync(CACHE_FILE, ...);  ← best effort
    }

  what breaks in production: the second layer doesn't exist. Vercel's
  filesystem is read-only. the production fallback chain is mem → demo.
  (the comment in the file names this: "serverless FS is read-only.")

  what breaks if you delete .investigation-cache.json mid-dev: nothing
  catastrophic — the next investigation re-runs the agents and writes
  it back. just slower for one click.
```

#### `lib/state/demo-*.json` — the committed seed (floor)

Two files, git-tracked: `demo-insights.json` (~12KB, 12 insights) and `demo-investigations.json` (the matching investigations). Captured by `scripts/capture-demo.ts` running a full real agent loop, then committed. Acts as both the **offline mode** (when no Bloomreach credentials are available) and the **floor of the fallback chain** (when the in-memory layer is empty).

```
  the committed seed — always available

  lifetime: as long as the git repo exists
  shape:    same Insight / Investigation interfaces (must validate)
  size:     bounded — ~12 insights, ~12KB total (for demo-insights)
  source:   scripts/capture-demo.ts (re-capture on demand)

  read access:
    existsSync(DEMO_FILE) + readFileSync(DEMO_FILE, 'utf8') + JSON.parse
    O(n) where n is the seed size. n is small, so n doesn't matter.

  use cases:
    1. offline mode: no BLOOMREACH_API_KEY → the briefing route serves
       the seed instead of running the live agents
    2. cold-start fallback: the live route falls through to the seed
       when the in-memory layer is empty AND the wire-format param
       isn't present
    3. tests: several tests load the seed as a fixture

  why this is correct: the seed isn't pretending to be live data. it's
  pretending to be a SHIPPED EXAMPLE. it has all the right shape, with
  hand-curated values that demo well. cheap, durable, no infrastructure.
```

### Move 2 — the three-source fallback chain (the access pattern made concrete)

The route handler's `resolveAnomaly` function (L37–L61 of `app/api/agent/route.ts`) is the fallback chain. **One source per fallback:**

```
  resolveAnomaly — three sources in priority order

  STEP 1: wire-format param  (?insight=<JSON> from the browser)
    ├ exists?
    │   ├ parses as JSON?
    │   │   └ has metric, change, scope, severity?
    │   │       └ return insightToAnomaly(parsed)   ← TRUSTED PATH
    │   └ no → fall through
    └ no → fall through

  STEP 2: anomalies Map  (the in-memory raw store)
    ├ getAnomaly(insightId) ≠ null?
    │   └ return it
    └ null → fall through

  STEP 3: insights Map  (the in-memory enriched store)
    ├ getInsight(insightId) ≠ null?
    │   └ return insightToAnomaly(insight)  ← LOSSY (drops 4 fields)
    └ null → fall through

  STEP 4: demo seed file  (last resort)
    ├ DEMO_FILE exists?
    │   ├ parse JSON
    │   │   └ find insight by id
    │   │       └ return insightToAnomaly(found)  ← LOSSY
    │   └ catch → null
    └ no → null

  STEP 5: return null  → the route returns 404
```

**Why this many sources?** Each step exists for a real failure mode:
- **Wire-format param**: the most reliable when the user clicks from the briefing — the browser holds the Insight in sessionStorage and ships it back. Survives any cold start because the data travels with the request.
- **`anomalies` Map**: the right answer when the in-memory store is warm AND the user clicked through within the same instance. No conversion loss.
- **`insights` Map**: the user navigated directly via URL (not through the briefing UI) AND the in-memory layer happens to have the Insight (warm and the briefing was recent).
- **Demo seed**: the user is in offline mode OR the demo id was passed in directly.

What breaks: if all four miss, the route returns 404. The UI handles it by showing "investigation not found." The 4-source fallback exists *because* the in-memory layer is unreliable on Vercel — without it, every cold start would 404 any in-progress investigation.

### Move 2 — the wire-format-as-bridge pattern

The single most interesting access-pattern decision in this codebase. The investigate page is a separate route from the briefing; the user clicks an insight and the browser navigates to `/investigate?id=…&insight=<JSON>`. The `&insight=<JSON>` is the **entire Insight JSON, URL-encoded, shipped from the browser back to the route**.

```
  the wire-format bridge — diagram

  ┌─ briefing page ─────────────────────────────────────────┐
  │  /api/briefing  →  Insight[]                             │
  │  user clicks an insight                                   │
  │  app/page.tsx stores it in sessionStorage                │
  │  navigates to /investigate?id=abc&insight=<JSON>         │
  └──────────────────────────┬───────────────────────────────┘
                             │ URL (with the JSON param)
                             ▼
  ┌─ investigate page ──────────────────────────────────────┐
  │  /api/agent?id=abc&insight=<JSON>                        │
  │  resolveAnomaly sees ?insight= first, uses it            │
  │  ★ no need to look up by id at all                       │
  └──────────────────────────────────────────────────────────┘

  why this exists: the route can't trust that its in-memory store has
  the insight. Vercel might have cold-started a different instance.
  the browser is the durability layer.

  what it costs:
    - URL bloat (the Insight JSON ~ 500-800 bytes URL-encoded)
    - the insightToAnomaly leak (file 02) — the route has to convert
      back to Anomaly for the diagnostic agent

  what it gains:
    - zero round-trips to look up the insight
    - works across cold starts trivially
    - no DB needed for "remember this for the next request"
```

This is the **stateless-route + state-on-the-client** pattern, common in serverless. The browser IS the durability layer. The wire format being lossy is acceptable because the diagnostic agent only needs the four fields (`metric`, `scope`, `change`, `severity`) to start investigating — the other fields (`evidence`, `impact`) would be nice-to-have but aren't load-bearing. The leak (file 02) is the *cost* of this design.

### Move 2 — the alternative that would retire all of this

A single Postgres or SQLite table with two relations:

```
  the buildable target — one table, one FK

  insights (table)
    id              uuid PK
    timestamp       timestamptz
    severity        text  (check constraint: in 4 values)
    metric          text
    change          jsonb (the { value, direction, baseline } subobject)
    scope           text[] (Postgres array; or jsonb)
    source          text  (check: in 2 values)
    evidence        jsonb (variable shape — jsonb fits)
    impact          text
    revenue_impact  jsonb  ← all Tier 1 fields as jsonb or columns
    ...

  investigations (table)
    insight_id      uuid PK + FK → insights(id) ON DELETE CASCADE
    reasoning       jsonb  (the AgentEvent[] array)
    diagnosis       jsonb
    recommendations jsonb

  what retires:
    - the three-source fallback chain (route looks up by id, period)
    - the wire-format bridge (no need to ship the JSON in the URL)
    - the insightToAnomaly leak (no conversion needed; agent reads
      from the same row with all fields intact)
    - the per-instance memory problem (Postgres survives Vercel
      instance lifecycle trivially)
    - the .investigation-cache.json dev file (the DB IS the cache)

  what costs:
    - a managed DB (Vercel Postgres, Supabase, Neon — all serverless-
      friendly)
    - a schema-as-code layer (Drizzle is the natural fit — already in
      Rein's portfolio via AdvntrCue)
    - one migration to seed from demo-insights.json
    - a few weeks of operational learning curve
```

Doing this would not just solve the durability problem — it would retire the worst data-modeling smell in the repo (the Insight↔Anomaly leak) because the conversion path that introduces the leak would no longer exist.

### Move 3 — the principle

Storage choice is access-pattern fit plus durability fit. The repo's `Map`s are a textbook access-pattern fit (by-id reads of bounded data) and a textbook durability mismatch (per-instance memory on ephemeral serverless). The mismatch is bridged by two compensating patterns: the wire-format-as-state (the browser holds the data, ships it back) and the committed seed (a static floor for offline/cold-start). Both patterns work, both are reasonable for a demo-and-portfolio repo, both introduce their own complexity (the leak from the lossy conversion; the seed-vs-live divergence). The right next move is to graduate to a real KV or relational store — but only when "users expect the briefing to persist" becomes a real requirement.

---

## Primary diagram

The storage layers and the access pattern, recap.

```
  Storage and access — full picture

  ┌─ READ ACCESS PATTERN ────────────────────────────────────┐
  │                                                            │
  │   GET /api/agent?id=abc&insight=<JSON>                    │
  │   GET /api/investigate?id=abc                             │
  │                                                            │
  │   resolveAnomaly walks 4 sources in priority order         │
  │                                                            │
  └────────────────┬─────────────────────────────────────────┘
                   │
        ┌──────────┼──────────┬──────────┬──────────┐
        ▼          ▼          ▼          ▼          ▼
   wire-format   anomalies  insights  demo seed   404
   (?insight=)   Map        Map       file
   ★ DURABLE     ephemeral  ephemeral ★ DURABLE
     (browser)   (warm only)(warm only) (git)

  ┌─ STORE LAYERS ───────────────────────────────────────────┐
  │                                                            │
  │   1. in-memory Maps          (per-instance, ephemeral)     │
  │      lib/state/insights.ts                                 │
  │      lib/state/investigations.ts                           │
  │                                                            │
  │   2. dev file cache          (cross-restart in dev only)   │
  │      .investigation-cache.json                             │
  │                                                            │
  │   3. committed demo seed     (forever, git-tracked)        │
  │      lib/state/demo-insights.json                          │
  │      lib/state/demo-investigations.json                    │
  │                                                            │
  └────────────────────────────────────────────────────────────┘

  ┌─ THE STATELESS-ROUTE-WITH-CLIENT-STATE BRIDGE ───────────┐
  │                                                            │
  │   sessionStorage on the browser holds the Insight          │
  │   the navigation URL includes ?insight=<JSON>              │
  │   the route trusts the wire-format param FIRST             │
  │   (per-instance memory isn't relied on for correctness)    │
  │                                                            │
  └────────────────────────────────────────────────────────────┘
```

---

## Implementation in codebase

### The three Maps

```
lib/state/insights.ts  (lines 8–14, UPDATED)

  type SessionFeed = {
    insights:       Map<string, Insight>;
    investigations: Map<string, Investigation>;
    anomalies:      Map<string, Anomaly>;
  };
  const state = new Map<string, SessionFeed>();
       │
       └─ outer Map keyed by sessionId. each session gets its own
          SessionFeed (three inner Maps). the outer Map is NEVER
          cleared by a request; only the inner Maps for THIS session
          are cleared on putInsights(sessionId, ...). multi-user safe
          on a warm Vercel instance.
```

### The dev file cache

```
lib/state/investigations.ts  (lines 1–24)

  import { existsSync, readFileSync, writeFileSync } from 'node:fs';
  import { join } from 'node:path';
  import type { AgentEvent } from '../mcp/events';

  // Sources (in order): in-memory (this process) → dev file → committed demo seed.
  // Writes go to in-memory always, and to the dev file in development only
  // (serverless FS is read-only).
  const PERSIST = process.env.NODE_ENV === 'development';
  const CACHE_FILE = join(process.cwd(), '.investigation-cache.json');
  const DEMO_FILE = join(process.cwd(), 'lib/state/demo-investigations.json');

  const mem = new Map<string, AgentEvent[]>();
       │
       └─ the comment names the entire layered model: in-memory → dev
          file → demo seed. and names the prod constraint explicitly:
          "serverless FS is read-only." this comment IS the architecture.

  export function getCachedInvestigation(insightId: string): AgentEvent[] | null {
    if (mem.has(insightId)) return mem.get(insightId)!;
    const fromFile = PERSIST ? readJson(CACHE_FILE)[insightId] : undefined;
    if (fromFile) return fromFile;
    const fromDemo = readJson(DEMO_FILE)[insightId];
    return fromDemo ?? null;
  }
       │
       └─ the read fallback chain. one return per layer. note the
          PERSIST gate skips the file read entirely in production,
          where it would always miss anyway.
```

### The four-source resolution at the route

```
app/api/agent/route.ts  (lines 33–62)

  function resolveAnomaly(insightId: string, insightParam?: string | null): Anomaly | null {
    // 1. WIRE-FORMAT PARAM (the durable client-side bridge)
    if (insightParam) {
      try {
        const i = JSON.parse(insightParam) as Insight;
        if (i && typeof i.metric === 'string'
              && i.change
              && Array.isArray(i.scope)
              && i.severity) {
          return insightToAnomaly(i);
        }
      } catch { /* malformed — fall through */ }
    }

    // 2. IN-MEMORY ANOMALIES MAP (no conversion needed)
    const a = getAnomaly(insightId);
    if (a) return a;

    // 3. IN-MEMORY INSIGHTS MAP (lossy conversion)
    const i = getInsight(insightId);
    if (i) return insightToAnomaly(i);

    // 4. COMMITTED DEMO SEED (last resort)
    try {
      if (existsSync(DEMO_FILE)) {
        const snap = JSON.parse(readFileSync(DEMO_FILE, 'utf8')) as { insights?: Insight[] };
        const di = (snap.insights ?? []).find((x) => x.id === insightId);
        if (di) return insightToAnomaly(di);
      }
    } catch { /* ignore */ }

    return null;
  }
       │
       └─ four sources, each with a specific failure mode it covers.
          two of them (steps 3 and 4) are lossy because they go through
          insightToAnomaly — the leak from file 02. if the route went
          to a real DB, step 2 would be the only source, no leak.
```

### The wire-format bridge (the browser side)

```
app/page.tsx  (the briefing component, when an insight is clicked)

  // (paraphrased — the actual code lives in the click handler)
  sessionStorage.setItem('selectedInsight', JSON.stringify(insight));
  const url = `/investigate?id=${insight.id}&insight=${encodeURIComponent(JSON.stringify(insight))}`;
  router.push(url);
       │
       └─ the Insight travels with the navigation. the route then prefers
          this wire-format payload over its in-memory store. this is what
          makes the route correct under Vercel's cold-start model — the
          browser is the durability layer.
```

---

## Elaborate

The deeper choice here is that **the repo prefers correctness-via-redundancy over correctness-via-infrastructure**. Adding a real DB would solve every storage problem cleanly, but it'd also add a dependency, a schema migration story, an ops surface, and a deployment dependency. The current design hides all of that behind the four-source fallback chain — at the cost of one leak (`insightToAnomaly` drops fields) and one design smell (the route trusts the browser to ship the full Insight back). For a demo-and-portfolio repo on Vercel Hobby with a single user, the tradeoff is reasonable. For a production system with multiple users and persistent state expectations, it isn't.

The wire-format bridge is the genuinely clever part. Most serverless apps solve the cold-start problem with a DB or KV (Redis, DynamoDB). This one solves it with sessionStorage + a URL param — zero infrastructure. The cost is the URL gets long (~500 bytes), but URLs handle that fine. The win is enormous: the route is completely stateless from a correctness standpoint; the in-memory Maps are pure optimization. If they're warm, the user gets a fast response without re-running the briefing. If they're cold, the wire-format payload makes the route still work.

A subtle access-pattern point: the `anomalies` Map exists because the wire-format bridge is **lossy**. The browser ships `Insight`, but the diagnostic agent wants `Anomaly` (with the raw evidence). When the in-memory `anomalies` Map has the right id, the route uses it (step 2) — full evidence, no loss. Only when the Map misses does the route fall through to the lossy conversion paths (steps 1, 3, 4). That priority ordering is exactly correct: prefer the highest-fidelity source, fall through to lower-fidelity ones with documented loss.

What this repo would look like with Drizzle + Vercel Postgres: schema in `lib/db/schema.ts` (5-10 columns per table), migrations in `drizzle/`, a single-table `insights` with a JSONB `evidence` column, a related `investigations` table with FK to insights. The full Insight JSON would live in one row, every cold start would still find it, no wire-format bridge needed, no four-source fallback. The route handler would be simpler. The leak would retire (no conversion needed). The cost: dependency, migrations, a managed service. **The buildable target is well-shaped; it's just not the right call until the durability requirement is real.** Rein has shipped exactly this pattern in AdvntrCue (Postgres + Drizzle + Netlify Functions) — the playbook is in the portfolio.

## Interview defense

**Q: Walk me through the storage choice in this repo.**
A: Three layers. **(1) Session-scoped in-memory** in `lib/state/insights.ts` — `Map<sessionId, SessionFeed>` where each `SessionFeed` is three inner Maps (`insights`, `anomalies`, `investigations`). Per-session isolation: one user's `putInsights` clears only that session's sub-maps. Reads are two-level `state.get(sessionId)?.insights.get(id)` (O(1) hash lookups). **(2) Olist SQLite on disk** under `mcp-server-olist/data/olist.db` — real relational analytics warehouse, FKs + WAL + read-only at runtime + designed-against-queries indexes. **(3) Committed seeds** (`lib/state/demo-*.json`, `eval/results/<date>/*.json`, `eval/fixtures/regression-golden/*.json`) — git-tracked, durable forever. Durability across Vercel cold starts: layer 1 dies, layer 2 lives if the file ships, layer 3 always lives. The route's `resolveAnomaly` walks four sources (wire-format param → per-session anomalies → per-session insights → demo seed) to bridge the layer-1 ephemeral gap.

**Q: What's the wire-format bridge and why does it exist?**
A: When the user clicks an insight on the briefing, the browser puts the entire Insight JSON in `sessionStorage` AND ships it back as a `?insight=<JSON>` URL param when navigating to the investigate page. The route prefers this param over its in-memory store. It exists because Vercel cold starts mean the in-memory store can't be trusted — a briefing computed on instance A may not be visible to instance B. Letting the browser carry the state across the cold-start boundary makes the route stateless-for-correctness while keeping the in-memory Maps as a pure optimization for warm hits. The cost is a long URL (~500 bytes) and the `insightToAnomaly` leak (the route converts the lossy `Insight` back to `Anomaly`, dropping 4 fields). Net: cheap, correct, no infrastructure.

```
  diagram while you talk

  briefing page                        investigate page
  ──────────────                       ─────────────────
  click insight                        GET /api/agent?id=X&insight=<JSON>
   ├ sessionStorage.set(insight)        │
   └ navigate ──────────────────────────┴ resolveAnomaly walks 4 sources:
                                          1. wire-format param  ★ durable
                                          2. anomalies Map      (warm only)
                                          3. insights Map       (warm only, lossy)
                                          4. demo seed          ★ always available

  the browser bridges the cold-start gap. no DB needed.
```

## Validate

1. **Reconstruct.** Without opening the file: name the four sources `resolveAnomaly` walks in priority order. Which two are durable across Vercel cold starts? Which two are warm-instance-only?

2. **Explain.** Why does the `anomalies` Map have priority over the `insights` Map in the fallback chain? What property of each source explains the order? (Hint: lossiness.)

3. **Apply.** A new feature needs to show a user's last 10 briefings on a dashboard. Trace why the current storage choice can't support this access pattern. Design the minimum migration: which store, which schema, which indexes.

4. **Defend.** Someone proposes adding Vercel KV (Redis) to retire the in-memory Maps. Defend the *current* design as a deliberate choice given (a) demo-and-portfolio context, (b) single-user expectation, (c) no persistent-briefing requirement. At what point would Vercel KV earn its place?

## See also

- `01-the-data-model-and-its-shape.md` — the entities stored in each layer.
- `02-normalization-and-duplication.md` — the wire-format leak is now the load-bearing one (the schema-side fix shipped); session-scoped state makes a server-side lookup safe.
- `04-transactions-and-integrity.md` — session-scoped sub-maps + Olist FK/WAL; the integrity invariants per layer.
- `05-migrations-and-evolution.md` — drop-and-reseed is the Olist "migration"; deterministic synthesis is why it's legitimate.
- `08-the-olist-relational-schema.md` — the schema living in `mcp-server-olist/data/olist.db`.
- `09-deterministic-synthetic-data.md` — why the DB is regenerable + the eval result shapes that live in `eval/results/`.
- `study-system-design/*` — the system-design side of this question (which datastore, scaling, replication).

---
Updated: 2026-06-16 — added the session-scoped state refactor and the Olist SQLite analytics layer; primary store layer count moved from 3 (in-memory / dev-file / demo-seed) to 5 (per-session in-memory / Olist SQLite / dev-file cache / committed demo seed / committed eval results).
