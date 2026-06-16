# Three-rung mem-file-seed store

**Industry name(s):** tiered cache, write-through cache, fixture store, fallback chain, layered persistence
**Type:** Industry standard · Project-specific (the 3 specific rungs are this repo's choice)

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** A snapshot is only as useful as the *scopes* it survives. blooming insights' snapshot store has three rungs, each surviving a different scope: mem survives the process, the dev file survives the dev machine, and the committed seed survives across deploys and machines. Reads check all three in priority order (first non-null wins); writes always go to mem and conditionally to the dev file (production's serverless filesystem is read-only). The committed seed is a `git add`-ed artifact written by an offline workflow — never at runtime.

```
  Zoom out — where the 3 rungs sit

  ┌─ Process (Vercel function instance) ────────────┐
  │  mem: Map<insightId, AgentEvent[]>               │
  │  rung 1 — fastest, freshest, dies on process exit│
  └─────────────────────────▲────────────────────────┘
                            │  writeFileSync (dev only)
  ┌─ Dev machine filesystem ┴────────────────────────┐
  │  .investigation-cache.json                        │
  │  rung 2 — survives server restarts in dev         │
  │  (Vercel prod FS is read-only → write skipped)    │
  └─────────────────────────▲────────────────────────┘
                            │  offline capture workflow (git add)
  ┌─ Committed in repo ─────┴────────────────────────┐  ← we are here
  │  lib/state/demo-investigations.json               │
  │  rung 3 — crosses deploys, crosses machines       │
  │  (the only rung that survives a fresh clone)      │
  └──────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** A 3-rung store is a *fallback chain over scopes*, not just over latencies. The canonical multi-tier cache (CPU L1/L2/L3 cache, CDN edge/regional/origin) has rungs that differ by *latency*. Here, the rungs differ by *durability scope* — each rung serves a different reproducibility need: mem for same-process speed, dev file for between-restart continuity in development, committed seed for portability across machines and deploys. The read priority (mem → dev file → seed) gives the freshest data at every layer of durability with no extra plumbing.

---

## Structure pass

**Layers.** Three rungs (mem map, dev JSON file, committed JSON seed) and two operations (read with fallback, write with gating).

**Axis: state (who owns it, where does it live, how long does it survive?).** This is the right axis because the store's *whole job* is state ownership at different scopes. Mem: process-scoped, dies on process exit or function-instance migration. Dev file: machine-scoped *in dev only* — `PERSIST = process.env.NODE_ENV === 'development'` gates the write; Vercel's prod runtime has a read-only filesystem so the rung is dev-exclusive. Committed seed: repo-scoped, eternal until someone re-runs the capture workflow.

**Seams.** Three load-bearing:

- **Mem ↔ dev file.** Crossed only in development. `saveInvestigation` writes mem unconditionally and the dev file behind `PERSIST`. The seam is the `NODE_ENV` check; cross it the wrong way in prod and `writeFileSync` throws `EROFS` (caught and swallowed — best-effort).
- **Dev file ↔ committed seed.** Never crossed at runtime. The seed is built by an *offline* workflow — run a live combined investigation in dev, let mem+dev-file capture it, copy/merge `.investigation-cache.json` into `lib/state/demo-investigations.json`, commit. The seam between the two files is *human discipline + git*, not code.
- **Process ↔ deploy.** Crossed only by the committed seed. Mem dies on process exit; the dev file is local to one machine. Only the seed survives a fresh clone or a Vercel cold start. Without it, replay would require live re-capture every deploy.

```
  Structure pass — 3-rung store

  ┌─ 1. LAYERS ───────────────────────────────────┐
  │  mem map · dev file · committed seed           │
  └────────────────────────┬───────────────────────┘
                           │  pick the axis
  ┌─ 2. AXIS ─────────────▼────────────────────────┐
  │  state: who owns it, where does it live,       │
  │  how long does it survive?                     │
  └────────────────────────┬───────────────────────┘
                           │  trace, find flips
  ┌─ 3. SEAMS ────────────▼────────────────────────┐
  │  mem ↔ dev file: gated by PERSIST (LOAD)       │
  │  dev file ↔ seed: offline workflow (LOAD)      │
  │  process ↔ deploy: only seed crosses (LOAD)    │
  └────────────────────────┬───────────────────────┘
                           ▼
                   Block 4 — How it works
```

Skeleton mapped. Now walk the read chain, the write chain, and the offline seed workflow.

---

## How it works

**Mental model.** A 3-rung store is a *fallback chain*: try the fastest/freshest rung first, fall through on miss, return the first non-null. The reverse, the write side, is a *write-through-with-gates*: write to every rung you legally can, gated by environment constraints. The two sides aren't symmetric — that's the *point*. Reading should prefer freshness; writing should only persist where it's legal.

```
  Pattern — read fallback and write-through-with-gates

  READ (getCachedInvestigation)              WRITE (saveInvestigation)
  ──────────────────────────────             ──────────────────────────────
  rung 1: mem.get(id)                        rung 1: mem.set(id, events)  ← always
       │ miss                                rung 2: writeFileSync(file)  ← if PERSIST
       ▼                                              ↑
  rung 2: dev-file[id] (if PERSIST)                   └─ best-effort
       │ miss                                            (EROFS in prod is OK)
       ▼                                     rung 3: NEVER written at runtime
  rung 3: seed-file[id]                              ↑
       │ miss                                        └─ git-add'd artifact;
       ▼                                                 offline workflow only
  null → live run path
```

### Move 2 — walk the parts

#### Rung 1 — in-memory Map (per-process)

The reader anchor: you've used a `Map` as an in-memory cache (`const cache = new Map(); cache.set(key, value)`). Same shape. The mem rung is a module-level `Map<string, AgentEvent[]>` — one entry per cached investigation, scoped to whatever process is currently serving the request.

What happens on read: `mem.has(insightId)` returns true if this process has seen the run before. On hit, `mem.get(insightId)!` returns the captured events. On miss, the read falls through to rung 2.

What happens on write: `mem.set(insightId, events)` runs unconditionally — every snapshot lands in mem first. There's no eviction, no TTL, no LRU. The mem map grows unboundedly *within* a process; that's acceptable here because Vercel function instances are short-lived and the worst case is "the instance dies and the mem dies with it."

Boundary: Vercel's serverless model has multiple function instances. A request landing on instance A doesn't see instance B's mem. So the *effective* persistence across requests in prod is rung 3 only — mem is a per-request-pile optimization, not a cross-request store. In dev (one process), mem behaves like a real cache.

```
  Rung 1 — mem map

  declaration:     const mem = new Map<string, AgentEvent[]>()  ← module-level
  read:            mem.has(id) ? mem.get(id)! : fallthrough
  write:           mem.set(id, events)                          ← unconditional
  lifetime:        until process exit / instance migration
  effective scope: per-process (dev: one process; prod: one instance)
```

#### Rung 2 — `.investigation-cache.json` (dev-only file)

The reader anchor: you've used `localStorage` to persist app state across page reloads. Same idea — but here the scope is "the dev machine's filesystem," persisted across server restarts during development. The dev file is local to one machine; it's `.gitignore`'d (not committed) and only touched when `NODE_ENV === 'development'`.

What happens on read: `PERSIST ? readJson(CACHE_FILE)[insightId] : undefined`. In prod, the read is short-circuited to `undefined` — saves the disk hit and respects the read-only FS. In dev, `readJson` defensively wraps `existsSync` + `readFileSync` + `JSON.parse` in try/catch; a malformed file returns `{}` and the read falls through.

What happens on write: `saveInvestigation` reads the file, sets `all[insightId] = events`, writes the whole JSON back. The write is wrapped in try/catch so an `EROFS` (read-only filesystem in prod) or `EACCES` (permissions) doesn't crash the route — it's best-effort. The `PERSIST` gate means the try/catch never even runs in prod.

Boundary: the dev file is a *full rewrite per save*. If two requests in the same dev process race the write, the last one wins for any insightIds the other touched. Acceptable here because dev has one developer's traffic; in a concurrent prod scenario this would be a real race. The dev-only scope makes that moot.

```
  Rung 2 — dev file

  gate:        PERSIST = process.env.NODE_ENV === 'development'
  read:        if PERSIST: try { readJson(CACHE_FILE)[id] } catch { {} }
  write:       if PERSIST: read whole file, mutate map, writeFileSync whole file
  lifetime:    until rm -f .investigation-cache.json
  failure:     EROFS in prod (impossible because PERSIST=false there)
               malformed JSON: caught, returns {} (read falls through)
  effective scope: one dev machine
```

#### Rung 3 — `demo-investigations.json` (committed seed)

The reader anchor: you've shipped a test fixture as a JSON file in the repo. Same shape — but here the fixture *is* a captured live run, written by running the system and copying the dev file's contents. It's the only rung that's *committed* to git, and the only rung that survives a fresh clone, a Vercel cold start, or a new function instance.

What happens on read: `readJson(DEMO_FILE)[insightId]`. No gate — both prod and dev try to read the seed. The seed is always present in deployed builds because it's in the repo.

What happens on write: nothing at runtime. There's no `saveInvestigation` code path that writes to `DEMO_FILE`. The seed is written *offline* — by hand or by an unwritten capture script — by taking the dev file's contents and merging them in. The seam is human discipline + `git add`, not code.

Boundary: the seed is *static*. If `AgentEvent`'s union grows a new required field, the seed becomes stale and the consumer reads `undefined` for the new field. The TypeScript compiler can't catch this (the cache shape is trusted, not validated at runtime). The defensive move is either keeping new fields optional or adding a per-snapshot version envelope (the cache provenance envelope from `audit.md` Top-3 finding 3).

```
  Rung 3 — committed seed

  path:        lib/state/demo-investigations.json
  read:        readJson(DEMO_FILE)[id]  ← no gate, always tried
  write:       ─ never at runtime ─
               offline: run live → copy dev file → git add → commit
  lifetime:    until git revert or manual deletion
  effective scope: every machine, every deploy, every fresh clone
```

#### Read chain — first non-null wins

The reader anchor: you've used `localStorage || sessionStorage || defaultValue` for a tiered fallback. Same shape, but with three rungs and the explicit `null` return.

What happens: `getCachedInvestigation(insightId)` walks the rungs in order. Each rung returns the cached events on hit, undefined/null on miss. The function returns the first non-null hit, or `null` if all three miss. The `null` return is what lets the route's cache-first gate fall through to the live setup.

Boundary: the priority order (mem → dev file → seed) means a stale dev-file entry can shadow a fresh seed entry. Restarting the dev server clears mem but not the dev file; if the seed was updated to fix a bug, the dev file's old entry would still be served. The escape hatch is `?live=1` on the request — force a fresh live run regardless of cache state — or `rm .investigation-cache.json`.

```
  Read chain — getCachedInvestigation(insightId)

  if mem.has(id)         → return mem.get(id)!
  else if PERSIST &&     → return fromFile      ← rung 2 (dev only)
       fromFile defined
  else if fromDemo       → return fromDemo      ← rung 3 (always)
       defined
  else                   → return null          ← live run required

  priority = mem > dev file > seed
            ↑
            └─ freshness preference: a recent live run shadows an older seed
```

#### Write chain — every rung you legally can

The reader anchor: you've used a write-through cache (write to cache AND to source-of-truth). Here it's write to two rungs, gated by environment.

What happens: `saveInvestigation` writes to mem always (rung 1) and to the dev file in development only (rung 2). The dev-file write reads the whole file, sets the new entry, writes the whole file back — full rewrite per save. The seed (rung 3) is never written at runtime — it's a `git add`-ed artifact.

Boundary: the write is *not transactional*. If the route process crashes between the mem.set and the writeFileSync, the mem rung has the new entry but the dev file doesn't. Next process restart loses the new entry (mem dies, dev file is stale). For the demo workflow this doesn't matter (a captured run can be re-captured); for any production workflow it would.

```
  Write chain — saveInvestigation(insightId, events)

  mem.set(id, events)                ← always
  if PERSIST:
    all = readJson(CACHE_FILE)       ← read whole
    all[id] = events
    try:
      writeFileSync(CACHE_FILE,      ← write whole
                    JSON.stringify(all))
    except:
      ─ best effort, ignore ─        ← EROFS in prod is harmless
                                       (gate prevents it anyway)
```

#### Move 3 — the principle

A 3-rung store works because each rung serves a *different scope*, not just a different latency. The lesson generalises: when you're designing a snapshot or fixture store, ask "what scopes do I need to survive?" and write one rung per scope. Mem alone is too volatile (dies on process exit). A dev file alone is too local (doesn't cross machines). A committed seed alone is too static (can't capture new runs). Three rungs — process, machine-in-dev, repo-everywhere — give you fresh-where-possible, durable-where-needed, portable-across-deploys. Collapsing to fewer rungs costs you a specific reproducibility property at each step.

---

## Primary diagram

The full store, with the read priority and write gates marked.

```
  3-rung mem-file-seed store — full picture

  ┌─ Module-level state (lib/state/investigations.ts:7-11) ──────────────┐
  │  const PERSIST = process.env.NODE_ENV === 'development'                │
  │  const CACHE_FILE = .investigation-cache.json                          │
  │  const DEMO_FILE  = lib/state/demo-investigations.json                 │
  │  const mem        = new Map<string, AgentEvent[]>()                    │
  └──────────────────────────────────────────────────────────────────────┘

  READ — getCachedInvestigation (lines 22-28):                              WRITE — saveInvestigation (lines 30-41):
  ─────────────────────────────────                                        ─────────────────────────────────
                                                                            mem.set(id, events)             ← always
  rung 1: mem.get(id)             ← fastest                                       │
       │ hit → return                                                             ▼
       │ miss                                                              if PERSIST:
       ▼                                                                     all = readJson(CACHE_FILE)
  rung 2: if PERSIST:                                                        all[id] = events
            readJson(CACHE_FILE)  ← dev only                                 try { writeFileSync(...) }
       │ hit → return                                                            catch { /* best effort */ }
       │ miss                                                                   │
       ▼                                                                        ▼
  rung 3: readJson(DEMO_FILE)     ← always tried                          (seed never written at runtime)
       │ hit → return
       │ miss
       ▼
  return null                     ← live run required

  OFFLINE seed workflow (no code):
  ─────────────────────────────────
  1. NODE_ENV=development npm run dev
  2. trigger a live combined-run investigation
  3. let mem+dev-file capture it
  4. copy/merge .investigation-cache.json → lib/state/demo-investigations.json
  5. git add lib/state/demo-investigations.json && git commit
  6. ship → seed is now portable across deploys
```

---

## Implementation in codebase

### Use cases

Three real moments the 3-rung structure earns its keep:

- **Demoing without creds.** Clone the repo, `npm run dev`, open the app, click a seeded insight. The replay path hits rung 3 (the committed seed), short-circuits before any auth/key check, and the UI animates the captured run at 180ms ticks. No Anthropic key, no Bloomreach OAuth, no network. This is the *whole point* of rung 3 — no other rung survives a fresh clone.

- **Iterating on a captured bug in dev.** A captured `insightId` produced a bad diagnosis. You replay it (rung 1 or rung 2 hits depending on whether you've restarted the server), scrub the trace, change one thing (prompt, tool description), re-run live (`?live=1`) which captures a new snapshot to rung 1+2. Next page load reads rung 1 (the fresh one) without going to the seed. The priority order is what makes "live run shadows seed" the natural behavior — no cache invalidation needed.

- **Capturing the demo seed itself.** No script, no automation — the workflow is: run dev, trigger a combined-run investigation, let `saveInvestigation` write `.investigation-cache.json`, copy/merge into `lib/state/demo-investigations.json`, commit. The seed becomes the canonical *capture* artifact for cross-machine replay. The lack of automation is a real gap (the workflow lives in muscle memory) but the rung structure makes the artifact small and portable.

### Code side by side, with a line-by-line read

The module setup — paths, gates, and the mem map:

```
  lib/state/investigations.ts  (lines 1-11)

  import { existsSync, readFileSync, writeFileSync } from 'node:fs';
  import { join } from 'node:path';
  import type { AgentEvent } from '../mcp/events';

  // Sources (in order): in-memory (this process) → dev file → committed demo seed.
  // Writes go to in-memory always, and to the dev file in development only.
  const PERSIST = process.env.NODE_ENV === 'development';                      ← write gate for rung 2
  const CACHE_FILE = join(process.cwd(), '.investigation-cache.json');         ← rung 2 path (dev only)
  const DEMO_FILE = join(process.cwd(), 'lib/state/demo-investigations.json'); ← rung 3 path (committed)

  const mem = new Map<string, AgentEvent[]>();                                 ← rung 1 (per-process)
        │
        └─ four lines of constants, one Map. The whole rung topology is
           visible in 11 lines. The comment IS the documentation — the
           ordering ("in order: in-memory → dev file → committed seed") is
           the read priority, named in plain English at the top of the file.
```

The defensive read — `existsSync` first, malformed-JSON-tolerant:

```
  lib/state/investigations.ts  (lines 13-20)

  function readJson(path: string): Record<string, AgentEvent[]> {
    try {
      if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8'));     ← guarded read
    } catch {
      /* ignore */                                                              ← malformed → empty
    }
    return {};                                                                  ← absent → empty
  }
        │
        └─ a missing file or malformed JSON returns {} — the read chain
           falls through cleanly. No process crash, no surfaced error.
           This is what makes a fresh clone work even before the first
           snapshot is captured: rung 3 reads empty, returns null, falls
           through to the live path. No "first-run" special case needed.
```

The read chain — first non-null wins:

```
  lib/state/investigations.ts  (lines 22-28)

  export function getCachedInvestigation(insightId: string): AgentEvent[] | null {
    if (mem.has(insightId)) return mem.get(insightId)!;                        ← rung 1: process mem
    const fromFile = PERSIST ? readJson(CACHE_FILE)[insightId] : undefined;    ← rung 2: dev only
    if (fromFile) return fromFile;
    const fromDemo = readJson(DEMO_FILE)[insightId];                           ← rung 3: always tried
    return fromDemo ?? null;                                                    ← null → live run
  }
        │
        └─ priority: mem > dev file > seed. First non-null wins. The
           `??` operator returns null only if BOTH `fromDemo` and the
           short-circuit chain hit nothing — the explicit `null` is
           what the caller's `if (cached)` gate looks for.
```

The write chain — every rung you legally can:

```
  lib/state/investigations.ts  (lines 30-41)

  export function saveInvestigation(insightId: string, events: AgentEvent[]): void {
    mem.set(insightId, events);                                                ← rung 1: always
    if (PERSIST) {                                                              ← gate for rung 2
      const all = readJson(CACHE_FILE);                                         ← read whole
      all[insightId] = events;
      try {
        writeFileSync(CACHE_FILE, JSON.stringify(all));                        ← write whole
      } catch {
        /* best effort */                                                       ← EROFS in prod = ok
      }
    }
  }
        │
        └─ never writes rung 3 (the seed) — that's a git-add'd artifact.
           The PERSIST gate is the load-bearing safety net: if it weren't
           there, prod would attempt writeFileSync and the catch would
           swallow EROFS silently on every save. Gate first, catch second,
           defense in depth.
```

The test-only escape hatch — proves the mem rung is the test scope:

```
  lib/state/investigations.ts  (lines 43-46)

  /** test-only */
  export function _clearInvestigationCache(): void {
    mem.clear();
  }
        │
        └─ tests reset rung 1 between cases. They never touch rung 2 or
           rung 3 — vitest runs with NODE_ENV=test so PERSIST=false and
           the dev file is untouched; the seed is read-only fixture data.
           The underscore prefix is the convention for "internal, not
           public API."
```

---

## Elaborate

The 3-rung structure here is the same shape as Django's settings fallback (`local_settings.py > production_settings.py > base_settings.py`), Rails' credentials (`config/credentials/<env>.yml.enc` overrides `config/credentials.yml.enc`), or the XDG base directory spec (`$XDG_CONFIG_HOME` overrides `/etc/<app>`). The common thread: a layered fallback where each layer serves a different *scope of authority* (local override, environment-specific default, base default). What's unusual here is that the layers serve *durability scopes*, not authority scopes — that's why the read priority is freshness-preferring rather than override-respecting.

What this pattern gets right that flat fixture stores miss: the *graceful degradation* property. A fresh clone with no `.investigation-cache.json` and a deploy with no warm mem still serves the seed. The rungs don't fight; they fall through. Most layered systems require an explicit "is the override present?" check at every read site; here the `readJson` helper returns `{}` for any failure mode and the chain naturally falls through. The defensive coding lives in one helper, not at every callsite.

What's missing — and worth naming — is the *capture script*. The seed is built by an ad-hoc workflow (run dev, copy file, commit). A `scripts/capture-investigation.ts` that takes an `insightId`, runs the combined investigation live, and writes the resulting events directly to `demo-investigations.json` would close the gap between "I want a new seed" and "the seed is updated." Today the workflow is muscle memory; a 30-line script would automate it. The pattern doesn't need this to work — but adding it would make the seed less prone to bit-rot as the agent prompts evolve.

Worth a note on cross-instance limitation: in production on Vercel, every request can land on a different function instance, so mem (rung 1) is effectively per-instance. The first request after a cold start hits rung 3 (the seed). Subsequent requests *to the same instance* hit rung 1. There's no cross-instance coherence — if instance A captures a fresh live run, instance B doesn't see it until the *seed* is re-committed and deployed. This is fine for the demo (the seed has the runs that matter) but it means runtime-captured runs don't survive past the instance that captured them. A real prod cache would need a centralized store (Redis, Vercel KV, a DB row) as a 2.5-th rung. Not built.

---

## Interview defense

**Q1. Why three rungs? Couldn't this be one file?**

Each rung survives a different scope. Mem is per-process — fastest, but dies on process exit or function-instance migration. The dev file is per-machine in dev only — survives server restarts during development, but Vercel's prod runtime has a read-only filesystem so this rung is dev-exclusive (gated by `PERSIST = NODE_ENV === 'development'`). The committed seed is the only rung that crosses deploys and machines — it's a `git add`-ed fixture that the demo path relies on. Collapsing to one file would force a choice: lose the per-process speed (skip mem), lose the cross-deploy durability (skip seed), or break prod (try to write the seed at runtime when the FS is read-only). The 3-rung priority (mem → file → seed) gives the freshest data possible at each durability tier.

```
  rung     │  scope               │  what kills it
  ─────────┼─────────────────────┼─────────────────────────────────
  mem      │  process             │  process exit, instance migration
  dev file │  machine, dev only   │  rm .investigation-cache.json
  seed     │  repo, all deploys   │  only a git revert
```

**Anchor:** "name the scope each rung serves — collapsing loses something specific at each rung."

**Q2. The seed has no provenance metadata. What's the risk and what's the fix?**

The captured `AgentEvent[]` in `lib/state/demo-investigations.json` has the events but not the metadata about the run — no timestamp, no `modelVersion`, no `promptHash`, no MCP server version. So you can't tell *when* a snapshot was captured, *which model* produced it, or *which prompt version* the agent was running. The risk: if you change the diagnostic agent's prompt and notice a regression, you can't diff today's run against the seed to see what changed — because the seed has no version info. The fix is a per-snapshot envelope: extend the cache shape to `{capturedAt, modelVersion, promptHash?, events: AgentEvent[]}`. `AGENT_MODEL = 'claude-sonnet-4-6'` is already a constant in `lib/agents/base.ts:9` — easy to capture. Prompt hash requires hashing the prompt strings at startup. ~1 hour, plus a one-time re-capture of the seed. Today the seed is a *replay* fixture; the envelope would make it a *regression* fixture.

```
  current:    { insightId: AgentEvent[] }
  proposed:   { insightId: {
                  capturedAt:   number,
                  modelVersion: string,
                  promptHash?:  string,
                  events:       AgentEvent[]
                }
              }
                  ▲
                  └─ replay fixture → regression fixture
                     (you can diff snapshots across model/prompt versions)
```

**Anchor:** "replay fixture vs regression fixture — the envelope is what makes the seed useful for the latter."

---

## Validate

1. **Reconstruct.** Without looking, draw the 3 rungs and label the read priority. Test: name the file:line range for `getCachedInvestigation`. Anchor: `lib/state/investigations.ts:22-28`.
2. **Explain.** Why does `saveInvestigation` use `try/catch` around `writeFileSync`? What scenario does that defend against, and why is the `PERSIST` gate the *primary* defense? Anchor: `lib/state/investigations.ts:34-37`.
3. **Apply to a scenario.** A captured investigation produces a different result on replay than on the original live run. List three categories of cause, ranked by likelihood: (a) staleness in the seed vs current code, (b) the live run drifted (LLM non-determinism), (c) a bug in the replay path.
4. **Defend the decision.** Argue for replacing rung 2 (the dev file) with Vercel KV / Redis so prod also persists captured runs. Then argue why the current 3-rung shape is right for an early-stage demo-first app.

---

## See also

- `audit.md` — the broader lens audit; this pattern is named in state-snapshots-and-debugging-boundaries and reproduction-and-evidence.
- `01-ndjson-agentevent-discriminated-union.md` — the typed shape the store persists.
- `02-replay-from-snapshot-with-paced-emission.md` — the consumer of this store (the cache-first replay path).
- `04-dual-write-send-to-stream-and-store.md` — the upstream that captures into this store.
- `06-eval-result-paper-trail.md` — the offline cousin of this store. Both persist `AgentEvent`-shaped evidence; this store serves single-request replay, `eval/results/<date>[-<tag>]/` serves K-iteration measurement.
- `.aipe/study-system-design/04-caching-and-rate-limiting.md` — the broader caching pattern (system-design angle).

---
Updated: 2026-06-16 — cross-link to `06-` added; the seed-as-fixture discipline here is the spiritual precursor to the eval-result-dir-as-fixture discipline.
