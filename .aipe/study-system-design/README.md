# Study — System Design (blooming insights)

The system-design guide for **this** repo. The shape it teaches: a Next.js App
Router app that streams a multi-agent NDJSON pipeline to the browser, behind a
provider-neutral DataSource seam, with OAuth/PKCE/Dynamic Client Registration
to a rate-limited alpha MCP server on the back end.

## Reading order

```
  Pass 1 — orient (read in order)
  ┌───────────────────────────────────────────────────────────────────┐
  │  README.md             ← you are here                              │
  │  00-overview.md        ← whole-system diagram + legend             │
  │  audit.md              ← 8-lens audit (every system-design lens)   │
  └───────────────────────────────────────────────────────────────────┘

  Pass 2 — discovered patterns (read by question)
  ┌───────────────────────────────────────────────────────────────────┐
  │  01-request-flow.md            "what does GET /api/briefing do?"   │
  │  02-oauth-boundary.md          "how does the cookie become auth?"  │
  │  03-datasource-seam.md         "where do we swap real for fake?"   │
  │  04-aptkit-primitive-boundary  "what does Blooming own vs AptKit?" │
  │  05-caching-and-rate-limiting  "how do we live inside ~1 req/s?"   │
  │  06-streaming-ndjson.md        "how does the browser see progress?"│
  │  07-multi-agent-orchestration  "who runs in what order, why?"      │
  │  08-client-stream-handoff.md   "how do step 2 → step 3 share data?"│
  │  09-schema-gated-coverage.md   "how do we avoid wasted EQL calls?" │
  └───────────────────────────────────────────────────────────────────┘
```

The audit walks every lens (even ones the codebase doesn't exercise yet); the
pattern files unpack the load-bearing ones. Read top to bottom for the first
pass; afterwards open a pattern file by the question it answers.

## What this guide is NOT

This is system-design only: where components live, where state moves, where
boundaries fail, what changes at scale. Things you'll find here:

  → architectural boundaries (DataSource seam, OAuth gate, AptKit shim)
  → request and data flow (`/api/briefing` and `/api/agent`)
  → state ownership (session-keyed maps, encrypted cookie, sessionStorage)
  → caching, rate-limiting, durability boundaries
  → failure handling at the boundary, not inside any one component

Things you'll find in a neighbouring guide:

  → **runtime mechanics** (the async loop, the AbortSignal composition, the
     event-loop story) → `study-runtime-systems`
  → **protocol behaviour** (HTTP semantics, TLS, OAuth wire format,
     NDJSON-on-the-wire, connection lifecycle) → `study-networking`
  → **datastore engine internals** (we don't have a database, but if we did)
     → `study-database-systems`
  → **schema shape** (the WorkspaceSchema parser, the Insight/Anomaly/Diagnosis
     contract) → `study-data-modeling`
  → **distributed coordination** (we run on Vercel serverless — multi-instance
     concerns like cross-instance state are NOTED here but the underlying
     partial-failure/coordination theory lives there)
     → `study-distributed-systems`
  → **DSA underneath the architecture** (heap, BFS, traversal — not exercised
     in this repo today, but the catalogue lives there)
     → `study-dsa-foundations`

When a pattern file touches one of those, it cross-links and stops.

## How the pattern files are organized

Each file follows the same 9-block template (see `format.md` in the spec
family):

  1. Subtitle — industry name + type
  2. Zoom out, then zoom in — layers diagram with the concept's box marked
  3. Structure pass — layers · axis · seams
  4. How it works — the mechanism walked, with this repo's code inline
  5. Primary diagram — the recap visual
  6. Elaborate — where the pattern comes from, where it breaks
  7. (skipped — only AI/ML topics get exercises)
  8. Interview defense — Q + A with the load-bearing skeleton named
  9. See also

The audit is the index of *what's there*; the pattern files are the deep walk
on what's load-bearing. If you're skimming, the file list itself is the
artifact — a senior engineer reading the directory should already know what
this codebase actually does.
