# State snapshots and debugging boundaries

**Industry name(s):** state snapshot, checkpoint, time-travel debugging, replay-from-snapshot, captured fixture, before/after diff
**Type:** Industry standard · Language-agnostic

> The snapshot in blooming insights is `saveInvestigation(insightId, events[])`. It writes the captured `AgentEvent[]` to a 3-rung store (mem → dev file → committed seed) and lets the next request `getCachedInvestigation(insightId)` get back the *exact* event sequence the agent emitted. That gives the codebase a debugging boundary you rarely see in an early-stage repo: the state of a past investigation is persistent, replayable, and shipped as a `git add`-ed fixture. The honest gap: only the *combined* run is snapshotted (not split steps), only on clean `done` termination (not on errors), and the snapshot is not annotated with provenance metadata (model version, prompt hash, timestamp).

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** A state snapshot is the line between "this happened once" and "we can re-create the conditions of it happening." In blooming insights, the snapshot is the event stream — not the agent's internal state, not the model's KV cache, not the route's local variables — just the typed events the agent emitted. That's enough because the events *are* the user-visible state: render the events and you've reconstructed the screen.

```
  Zoom out — where snapshots sit

  ┌─ UI ────────────────────────────────────────────┐
  │  React state (TraceItem[]) hydrates from         │
  │  sessionStorage on re-mount                      │
  └─────────────────────────▲───────────────────────┘
                            │
  ┌─ Route handler ─────────┴───────────────────────┐
  │  collected: AgentEvent[] (request-scoped)        │
  │  saveInvestigation on done → 3-rung store        │
  └─────────────────────────▲───────────────────────┘
                            │
  ┌─ State persistence ─────┴───────────────────────┐  ← we are here
  │  ★ mem map (this process) ★                      │
  │  ★ .investigation-cache.json (dev) ★             │
  │  ★ lib/state/demo-investigations.json (seed) ★   │
  └─────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** A snapshot is a *typed dump of state at a chosen boundary*. The boundary matters as much as the dump: snapshotting too early misses the interesting state; snapshotting too late captures noise. blooming insights chose the boundary well — the snapshot fires at `done`, capturing the full event stream of a clean run, which is exactly the state you want to re-create for debugging or demo. The mem→file→seed chain ensures the snapshot survives the right scopes: same process (mem), same dev session (file), and across deploys (committed seed).

---

## Structure pass

**Layers.** Three rungs of persistence, each surviving a different scope: (1) in-process mem (survives same-process), (2) dev file (`.investigation-cache.json`, survives same-machine in dev), (3) committed seed (`lib/state/demo-investigations.json`, survives across deploys and machines).

**Axis: state (who owns it, where does it live, how long does it survive?).** This is the right axis because the snapshot's *whole job* is state ownership. Mem: process-scoped, dies on process exit. Dev file: machine-scoped in dev only (Vercel FS is read-only in prod). Committed seed: repo-scoped, eternal until someone re-runs the capture script. Each rung answers the lifetime question differently.

**Seams.** Two load-bearing:

- **Live ↔ snapshot.** `saveInvestigation(insightId, collected)` at `route.ts:254`. Inside this call, request-scoped state becomes process-scoped (mem) and dev-machine-scoped (file). The snapshot is gated on `step == null` (combined run only) and on clean termination (`done` reached without throw).
- **Process ↔ deploy.** The committed seed (`demo-investigations.json`) is the *only* rung that crosses deployment boundaries. Without it, every Vercel deploy starts cold and replay requires re-capturing. With it, the demo is portable.

```
  Structure pass — state snapshots

  ┌─ 1. LAYERS ───────────────────────────────────┐
  │  mem · dev file · committed seed               │
  └────────────────────────┬───────────────────────┘
                           │  pick the axis
  ┌─ 2. AXIS ─────────────▼────────────────────────┐
  │  state: who owns it, where does it live,       │
  │  how long does it survive?                     │
  └────────────────────────┬───────────────────────┘
                           │  trace, find flips
  ┌─ 3. SEAMS ────────────▼────────────────────────┐
  │  live↔snapshot: LOAD (request → process)       │
  │  process↔deploy: LOAD (mem dies; seed crosses) │
  └────────────────────────┬───────────────────────┘
                           ▼
                   Block 4 — How it works
```

Skeleton mapped. Now walk the snapshot mechanism end to end.

---

## How it works

**Mental model.** A snapshot is a *typed write of state at a chosen boundary*. The state is whatever shape you've decided is sufficient to reconstruct the system; the boundary is the moment you write. The replay is the inverse: read the typed dump, re-emit it, watch the system end up in the same place. blooming insights' snapshot writes `AgentEvent[]` at `done`; replay re-emits the array on a fresh stream. There's no internal-agent state to capture because the events are the only state the UI depends on.

```
  Pattern — snapshot + replay

  live run                                 snapshot write
  ─────────────────────────────────        ─────────────────────────────────
  collected: AgentEvent[] = []             saveInvestigation(insightId, collected)
  send(e) → push(e) + enqueue(e)             └─ mem.set(insightId, events)
  …                                          └─ writeFileSync(CACHE_FILE) [dev]
  send({type:'done'})                                  │
                                                       │
  another request:                                     │
  ─────────────────────────────────                    ▼
  GET /api/agent?insightId=…           getCachedInvestigation(insightId)
                                                       │
                                                       ▼
                                       cached events found
                                                       │
                                                       ▼
                                       for (e of events) { enqueue(e); sleep(180) }
                                                       │
                                                       ▼
                                       UI consumes stream identically to live
```

The diagram is the concept. The 3-rung read chain is what makes it portable across deploys.

### Move 2 — walk the snapshot mechanism

#### The boundary — when to snapshot

The reader anchor: you've used `localStorage.setItem` to save app state when the user clicks "save." Same shape — but here the trigger is *contractual* (the `done` event), not user action. The boundary is "the agent finished cleanly." Choosing a different boundary (snapshot on every event, snapshot at first tool call, snapshot before `done`) would change what's recoverable.

What happens: `app/api/agent/route.ts:251–254` emits `done`, then conditionally calls `saveInvestigation`. The gate is `step == null` — only the combined diagnose+recommend run is snapshotted, not the split-step flow. This is deliberate: the split-step flow hands diagnosis between steps via the client's `sessionStorage`, so the server doesn't need to know the cross-step state.

Boundary: a thrown error before `done` means no snapshot. The catch emits an `error` event but doesn't call save. So a *broken* run is not replayable — you can re-run live with the same `insightId` and hope it fails the same way, but the original failure isn't captured. The choice protects against poisoned snapshots (half-runs replaying as if complete) at the cost of losing failure-case replay.

```
  Snapshot boundary — what triggers the write

  send({type:'done'})           ← contract met; downstream can rely on it
  if (step == null)             ← combined run only (split-steps use sessionStorage)
    saveInvestigation(           ← write to mem + dev file
      insightId, collected
    )

  NOT triggered:
    - send({type:'error'})       ← error path skips save (no partial snapshots)
    - send({type:'tool_call_end'}) on its own ← per-event snapshots not built
    - step === 'diagnose' or 'recommend'      ← split-step runs not cached
```

#### The 3-rung store — mem, file, seed

The reader anchor: you've used a CDN with three caching layers (edge → regional → origin). Same shape, three layers — but here the layers serve different durability needs, not latency tiers. Mem is per-process. Dev file is per-machine-in-dev. Seed is per-deploy-everywhere.

What happens on write: `saveInvestigation` always writes to mem. If `NODE_ENV === 'development'`, it also writes to `.investigation-cache.json`. It never writes to `demo-investigations.json` — that file is the canonical *capture* artifact, written by a separate offline script and committed.

What happens on read: `getCachedInvestigation` reads in priority order — mem first (fastest, freshest), then the dev file (only if `PERSIST`, i.e. development), then the committed seed (always, last). First non-null wins. This priority means: in dev with mem still warm, you get the live run; in dev after a server restart, you get the file (your last run); in prod, you get the committed seed.

Boundary: Vercel's serverless model has multiple function instances. Mem is per-instance — a request landing on instance A doesn't see instance B's writes. So in prod, the *effective* persistence is the seed only. This is fine for the demo (the seed has the runs that matter) but means live-captured runs don't survive past the instance that captured them.

```
  3-rung store — write vs read

  writes (saveInvestigation):                  reads (getCachedInvestigation):
  ─────────────────────────────────            ─────────────────────────────────
  mem.set(id, events)              ← always    if (mem.has(id)) return            ← rung 1
                                                  mem.get(id)
  if (PERSIST)                                 if (PERSIST &&
    writeFileSync(CACHE_FILE)      ← dev only      fromFile = readJson(CACHE))    ← rung 2
                                                  return fromFile
  (never writes seed)                          if (fromDemo =                     ← rung 3
                                                  readJson(DEMO_FILE)[id])
                                                  return fromDemo
                                               return null                        ← live run required
```

#### The capture script (implied) — how seeds get written

The reader anchor: you've used `pg_dump` to capture a database state for a test fixture. The committed seed is the same idea — a captured fixture, committed for portability. Unlike `pg_dump`, there's no explicit `capture-investigation.ts` script in this repo; instead, the seed is built by running the combined-run path in dev with `NODE_ENV === 'development'`, then copying `.investigation-cache.json` into `lib/state/demo-investigations.json` (or merging it in). This is implicit — the workflow lives in muscle memory, not a script.

Boundary: there's no automation around regeneration. If the AgentEvent union grows a new variant (or an existing variant changes shape), the seed must be re-captured by hand or it will deserialize stale. The TypeScript compiler will catch *parse* mismatches at use-site, but the seed file itself isn't type-checked at build time.

#### The replay path — re-emit at 180ms ticks

The reader anchor: you've used `requestAnimationFrame` to animate a series of state changes. The replay is the same — a paced re-emission, except the pacing is server-side (`setTimeout(180)`) and the consumer is the same `useInvestigation` hook that handles live runs.

What happens: when the cache hits, the route opens a `ReadableStream`, iterates the events, encodes each as NDJSON, enqueues, sleeps 180ms, repeats. The 180ms is the difference between "static result" and "watching the agent think." It's hard-coded in `route.ts:105`.

Boundary: pacing is uniform — original timing fidelity is lost. A captured run that had a 5s gap between events replays as 180ms. For a debugging session you'd want original timing (so a hung tool replays as a 30s pause); for a demo you want pacing. The current code chose pacing. Worth flagging: a small extension would be `REPLAY_FIDELITY = 'paced' | 'original'` toggled by query param.

#### Move 3 — the principle

A snapshot is only useful if you snapshot the *minimal complete state*. blooming insights got this right: the event stream IS the state from the UI's perspective. No need to snapshot agent internals, no need to snapshot model state, no need to snapshot route locals — render the events and the screen is reconstructed. The lesson generalises: before you snapshot, ask "what's the minimal state the consumer needs to reproduce the experience?" If the answer is "the public output stream," then the snapshot is small, typed, portable, and unambiguous. If the answer is "I'd better dump the whole process memory," your boundary is wrong — move it.

---

## Primary diagram

The full snapshot system, with file:line owners marked.

```
  State snapshots — full system

  ┌─ Live run ────────────────────────────────────────────────┐
  │  app/api/agent/route.ts L171–195                           │
  │    collected: AgentEvent[] = []                            │
  │    send(e) pushes + enqueues                               │
  └─────────────────────────▲─────────────────────────────────┘
                            │ send({type:'done'}) reached
  ┌─ Snapshot boundary ─────┴─────────────────────────────────┐
  │  app/api/agent/route.ts L254                               │
  │    if (step == null)                                       │
  │      saveInvestigation(insightId, collected)               │
  │    └─ gate: only combined run, only on clean done          │
  └─────────────────────────▲─────────────────────────────────┘
                            │ 3-rung write
  ┌─ Persistence (3 rungs) ─┴─────────────────────────────────┐
  │  lib/state/investigations.ts L11 · mem.set(id, events)     │
  │  lib/state/investigations.ts L30–40 · writeFileSync(       │
  │                                       CACHE_FILE) [dev]    │
  │  (seed written offline; never at runtime)                  │
  └─────────────────────────▲─────────────────────────────────┘
                            │ next request: GET /api/agent?insightId
  ┌─ Replay path ───────────┴─────────────────────────────────┐
  │  app/api/agent/route.ts L127 · getCachedInvestigation()    │
  │  lib/state/investigations.ts L22–28                        │
  │    read chain: mem → dev file → committed seed             │
  │  app/api/agent/route.ts L132–138                           │
  │    for (e of events) { enqueue; await sleep(180) }         │
  └─────────────────────────▲─────────────────────────────────┘
                            │ NDJSON same shape as live
  ┌─ UI ────────────────────┴─────────────────────────────────┐
  │  lib/hooks/useInvestigation.ts                             │
  │    handle(e) updates React state — cannot tell live/replay │
  └───────────────────────────────────────────────────────────┘
```

---

## Implementation in codebase

### Use cases

Three real moments the snapshot earns its keep:

- **Demoing without creds.** No Anthropic key, no Bloomreach OAuth, no network. The committed seed has a real captured investigation; the cache-first path replays it; the UI renders identically. This is the *whole point* of the seed rung — every other rung would require a live capture or a dev-only setup.

- **Re-rendering after navigation.** The user clicks into an investigation, navigates away, comes back. `useInvestigation` first reads `sessionStorage` (the client-side equivalent of the snapshot, scoped to the tab) — if a stash exists, it hydrates instantly without re-fetching. If not, it hits `/api/agent` which cache-first hits the server-side snapshot. Two-tier client+server snapshot, no extra code.

- **Capturing the demo seed itself.** The seed is built by running a combined-run live, letting `saveInvestigation` write `.investigation-cache.json` in dev, then committing (or merging) the resulting JSON into `lib/state/demo-investigations.json`. The seed is shipped as a fixture; it's the only reproducible state across machines and deploys.

### Code side by side, with a line-by-line read

The snapshot module — 47 lines that do all the work:

```
  lib/state/investigations.ts  (lines 7–28)

  const PERSIST = process.env.NODE_ENV === 'development';                      ← gate for dev-only file write
  const CACHE_FILE = join(process.cwd(), '.investigation-cache.json');         ← rung 2 path
  const DEMO_FILE  = join(process.cwd(),                                       ← rung 3 path (committed)
                          'lib/state/demo-investigations.json');

  const mem = new Map<string, AgentEvent[]>();                                 ← rung 1 (per-process)

  function readJson(path: string): Record<string, AgentEvent[]> {
    try {
      if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8'));     ← defensive read: existsSync first
    } catch {
      /* ignore */                                                              ← malformed JSON → empty
    }
    return {};
  }

  export function getCachedInvestigation(insightId: string): AgentEvent[] | null {
    if (mem.has(insightId)) return mem.get(insightId)!;                        ← rung 1
    const fromFile = PERSIST ? readJson(CACHE_FILE)[insightId] : undefined;    ← rung 2 (dev only)
    if (fromFile) return fromFile;
    const fromDemo = readJson(DEMO_FILE)[insightId];                           ← rung 3 (always tried)
    return fromDemo ?? null;
  }
        │
        └─ first-non-null-wins. The priority (mem → dev file → seed)
           gives you the freshest data possible at every layer of
           durability.
```

The write side — the dual-rung write:

```
  lib/state/investigations.ts  (lines 30–41)

  export function saveInvestigation(insightId: string, events: AgentEvent[]): void {
    mem.set(insightId, events);                                                ← always: rung 1
    if (PERSIST) {                                                              ← dev only: rung 2
      const all = readJson(CACHE_FILE);
      all[insightId] = events;
      try {
        writeFileSync(CACHE_FILE, JSON.stringify(all));                        ← best-effort: ignore EROFS in prod
      } catch {
        /* best effort */
      }
    }
  }
        │
        └─ never writes rung 3 (the seed) at runtime — the seed is a
           git-add'd artifact written by an offline capture workflow.
           PERSIST gate prevents the prod runtime from trying to write
           to Vercel's read-only filesystem.
```

The caller — where the snapshot fires (and where it doesn't):

```
  app/api/agent/route.ts  (lines 251–254)

  send({ type: 'done' });
  // Only the combined run (capture) is cached to disk; the split steps are
  // handed off via the client's sessionStorage.
  if (step == null) saveInvestigation(insightId!, collected);
        │
        └─ explicit gate: split steps (step='diagnose'|'recommend') don't
           snapshot — their state lives client-side in sessionStorage.
           The cache is for the combined run that captures the *whole*
           investigation, which is what the demo seed wants.
```

The client mirror — sessionStorage as the per-tab snapshot:

```
  lib/hooks/useInvestigation.ts  (lines 131–144)

  case 'done':
    setComplete(true);
    try {
      sessionStorage.setItem(
        stashKey(step, id),                                                    ← per-(step,id) snapshot
        JSON.stringify({ items: cItems, diagnosis: cDiag, recommendations: cRecs }),
      );
      // hand the diagnosis to step 3
      if (step === 'diagnose' && cDiag) {
        sessionStorage.setItem(diagHandoffKey(id),                             ← cross-step handoff
                                JSON.stringify({ diagnosis: cDiag }));
      }
    } catch {
      /* stash is best-effort */
    }
    break;
        │
        └─ client-side snapshot, scoped to the browser tab. Re-mounting
           the hook (back-nav, refresh) reads this first — no refetch,
           no re-run. The handoff key is what passes diagnosis from
           the diagnose step's run to the recommend step's run.
```

---

## Elaborate

The snapshot pattern blooming insights uses is the same shape as Redux DevTools' time-travel, VCR.py's cassette tapes for HTTP testing, and Chrome DevTools' HAR export — all of them capture a typed sequence of events at a chosen boundary, store the dump in a portable artifact, and replay the dump deterministically. The boundary choice is what differentiates them: Redux at every action (fine-grained), VCR at every HTTP request (request-grained), HAR at every network call (per-call). blooming insights snapshots at *the end of a logical operation* (one investigation = one snapshot). That granularity matches the user's unit of work, which is the right granularity for a debugging boundary.

What this pattern gets exactly right: the captured artifact is *typed* (it's `AgentEvent[]`), so the replay path can rely on the shape without runtime checks. The TypeScript compiler is the schema for the snapshot — drift between capture and replay shows up at compile time, not at runtime. Compare to a JSON-blob log where the consumer needs `Ajv` or hand-written validators to defend against shape changes; here, the validator is `tsc`.

What's missing — and worth naming — is *snapshot-level provenance*. The captured `AgentEvent[]` has the events, but not the metadata about the run (timestamp, model version `AGENT_MODEL = 'claude-sonnet-4-6'` from `lib/agents/base.ts:9`, prompt hash, MCP server version, environment). Adding a per-snapshot envelope (`{capturedAt, modelVersion, promptHash, events}`) would make the seed useful for regression analysis — you could diff two snapshots taken with different model versions and see what changed. Not built. The current seed is a *replay* fixture, not a *regression* fixture; making it the latter is one schema change away.

The seed-as-fixture pattern has a neighbor worth crosslinking: the `demo-insights.json` file (a sibling in `lib/state/`) serves the same role for the briefing flow. Two seeds, same idea, different shapes. The replay paths differ too — the briefing route's demo replay is in `app/api/briefing/route.ts:84–151`, structurally similar to but not unified with the investigation cache. There's no shared abstraction; if the codebase ever wanted to ship more seed types, extracting a shared "replay typed event stream from JSON at N ms tick" helper would be the move.

---

## Interview defense

**Q1. Walk me through what state the snapshot captures and why that's the right boundary.**

The snapshot captures `AgentEvent[]` — the typed event stream the agent emitted during one investigation. It does *not* capture agent internals, model state, or route locals. The reason that's the right boundary: the events are the only state the UI depends on. Render the events and the screen is reconstructed. Anything else (the conversation history, the tool result objects in their full form, the agent's intermediate plans) would be dead weight in the snapshot because no consumer would use it. The boundary fires on the `done` event (`app/api/agent/route.ts:254`), gated on the combined-run path. Errors don't snapshot — half-runs would corrupt the replay path.

```
  boundary: send({type:'done'}) reached
  captured: collected: AgentEvent[]  ← typed, ordered, exhaustive for the UI
  excluded: agent internals, model state, route locals  ← dead weight
  gated:    combined run only · clean termination only
```

**Anchor:** "the events are the state, from the UI's perspective."

**Q2. Why three rungs in the cache? Couldn't this be one file?**

Each rung survives a different scope. Mem is per-process — fastest, but dies on process exit or function-instance migration. The dev file is per-machine-in-dev — survives server restarts during development, but Vercel's prod runtime has a read-only filesystem so this rung is dev-only. The committed seed is the only rung that crosses deploys and machines — it's a `git add`-ed fixture that the demo path relies on. Collapsing to one file would force a choice: lose the per-process speed (skip mem) or lose the cross-deploy durability (skip seed). The 3-rung priority (mem → file → seed) gives you the freshest data possible at each durability tier, with first-non-null wins.

```
  rung     │  scope               │  what dies it
  ─────────┼─────────────────────┼──────────────────────────────
  mem      │  process             │  process exit, instance migration
  dev file │  machine, dev only   │  serverless filesystem (prod), rm
  seed     │  repo, deploys       │  only a git revert
```

**Anchor:** name the scope each rung serves; collapsing loses something specific at each rung.

---

## Validate

1. **Reconstruct.** Without looking, draw the 3-rung store and label the read priority. Test: name the file and line range for `getCachedInvestigation`.
2. **Explain.** Why does `saveInvestigation` use `try/catch` around `writeFileSync`? What scenario does that defend against? Anchor: `lib/state/investigations.ts:34–37`.
3. **Apply to a scenario.** A captured investigation produces a different result on replay than on the original live run. List three categories of cause, ranked by likelihood.
4. **Defend the decision.** Argue for adding a `{capturedAt, modelVersion, events}` envelope to the snapshot. Argue against. Name what becomes possible with the envelope.

---

## See also

- `02-reproduction-and-evidence.md` — the snapshot as the reproduction primitive (capture-store-replay loop).
- `05-traces-and-request-lifecycles.md` — the trace shape that the snapshot captures.
- `01-observability-map.md` — the snapshot as the persistence boundary in the bigger map.
- `08-debugging-observability-red-flags-audit.md` — the snapshot's gaps (provenance, error-path capture).
