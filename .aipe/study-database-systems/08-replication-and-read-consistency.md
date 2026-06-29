# Replication and read consistency — the demo snapshot as a frozen read replica

*Industry standard / Project-specific* — there's no streaming replication. The committed JSON snapshots in `lib/state/demo-*.json` are point-in-time read replicas of one previous live briefing, frozen at capture time and served as the `?demo=cached` path.

## Zoom out, then zoom in

A read replica exists to take read load off the primary and to provide a consistent fallback when the primary is unavailable. The repo's `?demo=cached` mode does exactly that — it takes load off Bloomreach (no upstream calls during a demo) and provides a fallback when the primary is unavailable (the alpha server is rate-limited and revokes tokens after minutes, so demos *must* not depend on it). The lag is infinite — the snapshot updates only when someone runs the dev-only capture and commits the JSON files.

```
  Zoom out — where this concept lives

  ┌─ UI layer ───────────────────────────────────────────────┐
  │  feed + investigations render IDENTICALLY in both modes  │
  └────────────────────────────┬─────────────────────────────┘
                               │  HTTP, ?demo=cached
  ┌─ Service layer ────────────▼─────────────────────────────┐
  │  /api/briefing GET ?demo=cached                          │
  │      ┌────────────────────────────────────┐              │
  │      │  read JSON file                     │              │
  │      │  stream NDJSON with replay pacing   │ ★ THE REPLICA │ ← we are here
  │      │  filter events per step (agent)     │              │
  │      └────────────────────────────────────┘              │
  └────────────────────────────┬─────────────────────────────┘
                               │
  ┌─ Storage layer ────────────▼─────────────────────────────┐
  │  lib/state/demo-insights.json       (665 lines)          │
  │  lib/state/demo-investigations.json (3487 lines)          │
  └──────────────────────────────────────────────────────────┘
```

Zoom in: the "replica" is a pair of committed JSON files. The capture path that updates them is dev-only. The replay path is read-only at runtime on Vercel. The contract between primary (live Bloomreach) and replica (the snapshot) is one promise: **the snapshot's event shapes are a superset of what the live path produces, so the UI can render either without branching.**

## Structure pass

**Layers:**

```
  L1  primary (Bloomreach MCP)        the live source of truth
  L2  capture path (dev-only)         runs primary, writes JSON
  L3  committed JSON (git)            the "replica"
  L4  replay path (?demo=cached)      reads JSON, streams NDJSON
  L5  UI                              renders either, same code
```

**Axis traced: where does the data come from on a read?**

```
  Trace one axis: where does the read get its data?

  ┌─ live mode ─────────────────────────────┐
  │  agents call BloomreachDataSource        │   → primary (network)
  └──────────────────────────────────────────┘
                  (it flips)
  ┌─ demo mode ─────────────────────────────┐
  │  readFileSync(DEMO_FILE)                 │   → replica (disk)
  └──────────────────────────────────────────┘

  the seam is the ?demo=cached query param at /api/briefing
  same UI, two read paths, identical event shapes
```

**Seams** — two matter:

- The query-param boundary (`req.nextUrl.searchParams.get('demo') === 'cached'` at `app/api/briefing/route.ts:78`) — same route, two implementations, branched at the first line.
- The capture / replay boundary — the capture path (dev) and the replay path (any) share the snapshot file but never run in the same flow. Capture writes; replay reads; they never interleave.

## How it works

### Move 1 — the mental model

You've used `git pull` before — point-in-time copy of a remote source, with explicit "update me" steps. The shape here is the same: capture is the `git push`, deploy is the `git pull`, replay is "now read from your local copy." The replication lag is whatever time elapsed between the last capture and now. There's no streaming, no log shipping, no consistency lag in the traditional sense — there's just "when was the snapshot last refreshed."

```
  Manual replication — pull, push, read

  ┌─ primary (live) ──┐
  │  Bloomreach EQL    │
  └────────┬───────────┘
           │ dev runs capture
           ▼
  ┌─ capture route ───┐
  │  /api/mcp/capture- │
  │  demo (dev-only)   │
  └────────┬───────────┘
           │ writes
           ▼
  ┌─ committed JSON ──┐
  │  lib/state/demo-*  │
  │  .json             │
  └────────┬───────────┘
           │ git commit + deploy
           ▼
  ┌─ replay route ────┐    ┌─ UI ───────────┐
  │  /api/briefing?    │ ──►│ feed + invest. │
  │  demo=cached       │    │ same code      │
  └────────────────────┘    └────────────────┘
```

That's the kernel: an offline snapshot pipeline that delivers a frozen, consistent view to the read path.

### Move 2 — the replication pipeline, one part at a time

#### The snapshot shape — what's actually in the JSON

`lib/state/demo-insights.json` is a `DemoSnapshot` (typed at `app/api/briefing/route.ts:28-36`):

```typescript
type DemoSnapshot = {
  workspace?: BriefingWorkspace;        // projectName, totalCustomers, totalEvents
  coverage?: CoverageReport;            // 10-category checklist results
  trace?: DemoTraceItem[];              // recorded EQL calls + reasoning steps
  insights?: Insight[];                 // the final insight cards
};
```

`lib/state/demo-investigations.json` is keyed by `insightId` and holds the recorded `AgentEvent[]` stream for each investigation. The replay route (`/api/agent`) filters those events by `agent` to serve step 2 (diagnostic) vs step 3 (recommendation) separately.

#### The capture path (dev-only)

`/api/mcp/capture-demo` runs a real briefing against Bloomreach, runs each investigation, and writes both files. From `.aipe/project/context.md`:

> Dev-only one-click capture ("capture this as the demo snapshot"): runs the live briefing + each investigation and writes `lib/state/demo-*.json`.

This is the "manual replication" step. It's gated to dev because (a) writing to the filesystem in prod isn't supported on Vercel, and (b) the snapshot is meant to be reviewed in git before going live.

#### The replay path (any mode)

```typescript
// app/api/briefing/route.ts:86-152 (the demo branch, condensed)
if (demo && existsSync(DEMO_FILE)) {
  const snapshot = JSON.parse(readFileSync(DEMO_FILE, 'utf8')) as DemoSnapshot;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = async (e: BriefingEvent) => {
        controller.enqueue(encoder.encode(JSON.stringify(e) + '\n'));
        await new Promise((r) => setTimeout(r, REPLAY_DELAY_MS));  // ◄── pacing
      };
      try {
        if (snap.workspace) await emit({ type: 'workspace', workspace: snap.workspace });
        for (const item of coverage) {
          await emit(stepEvt(coverageLines[i]));
          await emit({ type: 'coverage_item', item });
        }
        for (const t of trace) {
          if (t.kind === 'tool') {
            await emit({ type: 'tool_call_start', ... });
            await emit({ type: 'tool_call_end', ... });
          } else if (t.content) {
            await emit(stepEvt(t.content));
          }
        }
        for (const insight of insights) await emit({ type: 'insight', insight });
        await emit({ type: 'done' });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { 'content-type': 'application/x-ndjson; ...' } });
}
```

Four things this does:

1. Reads the snapshot as JSON.
2. Replays the events in the same order the live path emits them: workspace → coverage → trace → insights → done.
3. Uses `REPLAY_DELAY_MS` (140ms) between emits so the UI's `StatusLog` reveals progressively rather than all at once — matches the live "watching the agent work" experience.
4. Filters and shapes the events so the UI consumer doesn't know which mode it's in.

#### The contract — same event shapes, both modes

The `AgentEvent` union (`lib/mcp/events.ts` per the project context) is the wire contract. Both the live agent loop and the demo replay produce events that match this union. The UI's stream reader doesn't branch on mode — it consumes the same NDJSON regardless.

This is what makes the replica useful: it's not a "downgraded fallback," it's the same UI with the same data shapes, just sourced differently. The cost of maintaining this contract is the "What must not change" rule from `.aipe/project/context.md`:

> The demo snapshot keys (`insights`, `workspace`, `trace`) and the per-step replay filter (events tagged by `agent`).

Break that contract and the replica stops being a drop-in for the primary.

#### Consistency model — eventually fresh, never live

The snapshot is whatever was captured the last time someone ran capture and committed. There's no expiry, no automatic refresh, no consistency guarantee beyond "what's in git is what serves." The lag is measured in commits, not milliseconds.

```
  Consistency model — manual, commit-bounded

  primary (Bloomreach):    ◄── live, changes constantly
       │
       │  (lag = time since last capture commit)
       │
       ▼
  replica (committed JSON): ◄── frozen until next commit
```

For a demo at a meeting, this is exactly the property you want — the snapshot doesn't change between rehearsal and the live demo. For a production analytics product, this would be unusable.

#### Stale-read protection — the UI doesn't try

Both modes use the same UI. The UI has no concept of "this data might be stale" because in live mode the data is fresh by construction (just emitted by the agent), and in demo mode the user explicitly opted in with a `?demo=cached` or the localStorage `bi:mode` toggle. There's no logic that says "warn the user the demo snapshot is old" — the assumption is the user knows.

### Move 3 — the principle

A "read replica" doesn't need streaming replication to be useful — it needs a stable contract with the primary and a clear refresh story. The committed snapshot here gets both: the AgentEvent shape is the contract, and `git commit` is the refresh. The whole machinery — capture script, JSON files, replay path, identical UI — collapses to "checkpoint your primary into git, serve from git on the read path." Most "fallback mode" requirements in apps can be satisfied this way; persistent replicas are heavier than they need to be when staleness is acceptable.

## Primary diagram

```
  Replication + read consistency — full pipeline

  ┌─ Bloomreach MCP (primary) ──────────────────────────────┐
  │  live EQL execution                                      │
  └────────────────────────┬────────────────────────────────┘
                           │
                           │ dev runs /api/mcp/capture-demo
                           │ (manual, gated to NODE_ENV=development)
                           ▼
  ┌─ capture path (dev) ────────────────────────────────────┐
  │  • run live briefing (real agents, real MCP calls)       │
  │  • run each investigation (step 2 + step 3)              │
  │  • write lib/state/demo-insights.json                    │
  │  • write lib/state/demo-investigations.json              │
  └────────────────────────┬────────────────────────────────┘
                           │
                           │ git commit + deploy
                           ▼
  ┌─ committed JSON (the "replica") ────────────────────────┐
  │  lib/state/demo-insights.json       (DemoSnapshot)       │
  │  lib/state/demo-investigations.json (keyed by insightId) │
  └────────────────────────┬────────────────────────────────┘
                           │
                           │ ?demo=cached query param
                           ▼
  ┌─ replay path (any env) ─────────────────────────────────┐
  │  • readFileSync(DEMO_FILE)                               │
  │  • emit events: workspace → coverage → trace → insights  │
  │  • 140ms between emits (REPLAY_DELAY_MS)                 │
  │  • NDJSON, same shape as live path                       │
  └────────────────────────┬────────────────────────────────┘
                           │
                           ▼
  ┌─ UI ────────────────────────────────────────────────────┐
  │  same components, same stream reader, no mode branch     │
  └──────────────────────────────────────────────────────────┘

  consistency: eventually fresh, refreshed by commit
  lag: time since last capture (typically days)
  cost: zero infra; one git history line per capture
```

## Elaborate

The interesting design constraint is the **presentation reliability** requirement from `.aipe/project/context.md`:

> Demo (default): `?demo=cached` serves the committed snapshot as plain JSON; investigations replay the committed events (filtered per step). Instant, no auth — the reliable presentation path.
>
> Live: runs the agents against Bloomreach. The alpha server is rate-limited (~1 req/s) and revokes tokens after minutes, so live is recovery-oriented (auto-reconnect) — capture a fresh snapshot locally and commit it for the demo.

That paragraph explains why the snapshot exists at all: the upstream's alpha-grade availability makes live demos unsafe. The replica isn't a performance optimization; it's a *correctness for the demo flow* mechanism. The lag is acceptable because the demo doesn't need fresh data — it needs *reliably renderable* data.

Compare to Postgres streaming replication: a real read replica receives WAL records from the primary and applies them, so reads are slightly behind but eventually catch up. This repo's "replica" never catches up unless someone runs capture — but for the use case, that's the feature. A streaming replica would be wrong here because it would couple the demo to the upstream's flakiness.

The cleanest extension of this pattern: if the team ever wanted multiple snapshots (e.g. "demo for the conversion-drop story" vs "demo for the fraud spike story"), the move is to commit multiple `demo-*.json` variants and select between them with a query param. The replay path already handles the "file exists / file doesn't exist" branch; multi-snapshot just changes which file gets read.

## Interview defense

**Q: Does this app have read replicas?**

Yes, conceptually — `lib/state/demo-insights.json` and `lib/state/demo-investigations.json` are a frozen point-in-time replica of one previous live briefing. The capture path (dev-only `/api/mcp/capture-demo`) runs a real briefing against Bloomreach and writes the JSON files. They get committed to git, ship in the deploy, and serve as the `?demo=cached` path at `/api/briefing` and `/api/agent`. The replay streams the same NDJSON event shapes as the live path, so the UI doesn't branch on mode.

**Q: What's the consistency model?**

Eventually fresh, refreshed by `git commit`. There's no streaming replication, no automatic refresh — the snapshot is whatever the last capture committed. That's by design: the demo is the *reliable* presentation path, and "reliable" here means "doesn't depend on the alpha upstream that revokes tokens after minutes."

**Q: What's the load-bearing contract between primary and replica?**

The `AgentEvent` NDJSON shape. The live agent loop emits these events; the demo replay emits identical-shaped events from the JSON file. The UI's stream reader can't tell the difference. That contract is in the "What must not change" list — break it and the replica stops being a drop-in.

**Q: How would you make the replica auto-refresh?**

You wouldn't — and that's the whole point. The lag is the feature: a fixed snapshot doesn't change between rehearsal and the actual demo. If you needed fresh-ish data, the right move is a second snapshot file (or a remote-fetched JSON that's still rendered through the same replay path), not streaming replication. Streaming would couple the demo to the upstream's availability, which is exactly what the snapshot exists to decouple.

## See also

- `01-database-systems-map.md` — where the snapshot sits among the four storage analogs (L3)
- `04-query-planning-and-execution.md` — the live path the snapshot mirrors
- `07-wal-durability-and-recovery.md` — the other "survives a deploy" thing (the cookie)
- `09-database-systems-red-flags-audit.md` — the staleness risk if capture isn't refreshed
