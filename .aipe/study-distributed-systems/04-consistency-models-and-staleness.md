# 04 — consistency models, staleness, read-your-writes

**Industry name(s):** consistency models · stale reads · read-your-writes · stateless server / stateful client
**Type:** Industry standard · Language-agnostic

> **Verdict-first:** blooming insights has no shared store, so the classical consistency models (strong, eventual, causal, read-your-writes) mostly do not apply at the storage layer — there's nothing to be consistent *with*. Where consistency DOES bite is at three specific spots: **(1) the 60s TTL cache in `BloomreachDataSource`** is a deliberate staleness window — any data the briefing or investigation surfaces from the Bloomreach backend is up to 60 seconds behind reality (the Olist adapter has no cache, so its data is always fresh — this is an **asymmetric staleness contract across the two backends**); **(2) the cross-request handoff for investigations** uses the *client's* sessionStorage to carry state because the server has no cross-instance consistency mechanism; and **(3) the module-cached `WorkspaceSchema`** is strong-within-process for the process's lifetime. The stateless-server / stateful-client pattern in `useInvestigation` (`lib/hooks/useInvestigation.ts:18-19, 137-140`) is the actual consistency story — *the client is the source of truth between two route invocations*. Classical multi-replica consistency (file 05) is NOT YET EXERCISED.

---

## Zoom out, then zoom in

```
  Zoom out — where staleness and consistency live

  ┌─ UI layer ───────────────────────────────────────────────┐
  │  sessionStorage carries diagnosis  step 2 → step 3        │
  │  ★ STATEFUL CLIENT pattern ★                              │ ← we are here
  │  (this is the read-your-writes mechanism)                 │
  └─────────────────────────┬────────────────────────────────┘
                            │
  ┌─ Service layer ─────────▼────────────────────────────────┐
  │  McpClient 60s TTL cache  ◄── staleness window            │
  │  module schema cache       ◄── per-process lifetime       │
  │  in-memory Maps            ◄── per-instance "consistency" │
  └─────────────────────────┬────────────────────────────────┘
                            │
  ┌─ Provider layer ────────▼────────────────────────────────┐
  │  Bloomreach is the source of truth (eventually consistent │
  │  with itself — opaque to us)                              │
  └───────────────────────────────────────────────────────────┘
```

**Zoom in.** The question this file answers: *when the user clicks something and then sees a result, was the result based on data that's actually current?* For most things in this app the answer is "within 60 seconds, yes" because of the TTL cache; for the cross-step investigation flow, the answer is "yes because the client carried the data itself" — the server didn't have to be consistent because the client was the source.

---

## Structure pass

**Layers.** Three. Client (sessionStorage as cross-request memory) · Server (per-instance caches with TTL) · Provider (Bloomreach's own internals — eventually consistent, but opaque).

**Axis: who-is-the-source-of-truth across two reads.** Hold one question: *if you read X twice in quick succession, what guarantees them being the same?* On the client, the sessionStorage stash guarantees identical reads until the tab closes — strong consistency within one tab. On the server, the in-memory Map gives strong consistency within one process for the process's lifetime; **no consistency at all** across processes. At the provider, Bloomreach is the source — but the 60s TTL cache means our view of Bloomreach is stale by up to 60s, which is "bounded staleness" with a fixed bound.

**Seams.** Two real, one absent.

- **Seam: live data ↔ cached view.** The TTL cache trades freshness for rate-limit headroom. The window is fixed (60s) and the same across all tool calls — there's no "this insight needs fresher data than the schema does."
- **Seam: server request N ↔ server request N+1.** No mechanism guarantees these two requests see the same server state. The instance can be different. The cache can have expired. The Map can have been GC'd by a recycle.
- **Seam: per-replica consistency** — *does not exist*. There's no replica set to be consistent across. File 05 calls this NOT YET EXERCISED honestly.

```
  Structure pass — consistency where it actually lives

  ┌─ within one React tab ────────────────────────────────┐
  │  sessionStorage(bi:diag:<id>): strong consistency      │
  │  same value across reloads, dies when tab closes       │
  └────────────────────┬──────────────────────────────────┘
                       │  fetch
  ┌─ within one Vercel instance ──────────────────────────┐
  │  in-memory Map: strong within one process              │
  │  module-cached schema: same                            │
  │  no consistency to OTHER instances                     │
  └────────────────────┬──────────────────────────────────┘
                       │  HTTPS
  ┌─ Bloomreach (opaque) ─────────────────────────────────┐
  │  source of truth                                       │
  │  our view is stale by up to 60s (McpClient TTL)        │
  │  Bloomreach's OWN consistency is their problem         │
  └────────────────────────────────────────────────────────┘
```

---

## How it works

### Move 1 — the mental model

You already know that React's `useState` is strongly consistent within one render — you read what you set, immediately. That's the consistency model you take for granted. Distributed systems take it away: the moment two boxes have copies of the same data, you have to pick a weaker model. The standard ladder:

```
  The consistency ladder — strongest to weakest

  STRONG               every read sees the latest write
                       (single process; single transaction)

  LINEARIZABLE         every read sees a write committed before it
                       (looks single-process from outside)

  READ-YOUR-WRITES     a client sees its own writes immediately
                       (others may see stale)

  CAUSAL               if write B depended on read A, anyone who
                       sees B also sees A

  EVENTUAL             reads converge to the latest write,
                       given enough time

  STALE / BOUNDED      reads may be up to N seconds out of date
                       (this is what a TTL cache gives you)
```

blooming insights gets strong consistency *inside* one process (React state, in-memory Map) for free. It uses read-your-writes via the client-as-carrier pattern for cross-request flows. It accepts bounded staleness (60s) for cached MCP reads. It does not need anything weaker because it has no replicas.

### Move 2 — the moving parts

#### Part 1 — the stateful-client / stateless-server pattern (the load-bearing one)

The investigation flow has two route invocations: step 2 (`/api/agent?step=diagnose`) produces a diagnosis; step 3 (`/api/agent?step=recommend`) consumes that diagnosis. The server does NOT store the diagnosis between these two calls. The *client* carries it.

```
  Stateful-client / stateless-server — the handoff

  step 2: /api/agent?step=diagnose&insightId=X
    server:  runs diagnostic agent
    server:  emits 'diagnosis' event in NDJSON stream
    client:  receives event, sets cDiag
    client:  on 'done', writes to sessionStorage:
             bi:diag:X = { diagnosis: cDiag }
    server:  DOES NOT REMEMBER cDiag
             (Vercel instance may recycle; cross-instance: no link)

  user clicks "next step"

  step 3: /api/agent?step=recommend&insightId=X&diagnosis=<json>
    client:  reads sessionStorage bi:diag:X
    client:  encodes diagnosis into query string
    server:  parses diagnosis from query param
    server:  runs recommendation agent with it
```

This IS read-your-writes — the client wrote the diagnosis, the client reads it back. The server is stateless across the two requests, and that statelessness is what makes the architecture survive Vercel recycling instances between steps. The cost: the client must carry every piece of state the next request needs, which limits the size of the handoff to "fits in a sessionStorage value and a URL query param."

The boundary conditions:
- **Tab close between steps.** sessionStorage dies with the tab. Reopen → cache miss → no diagnosis → step 3 throws "no diagnosis was handed over" (`app/api/agent/route.ts:228-230`).
- **Different browser/device.** No sharing. Opening step 3 on a phone after running step 2 on a laptop will fail the handoff.
- **Diagnosis bigger than ~4MB.** sessionStorage limit per origin (browser-dependent, commonly 5–10MB). Hasn't been hit in practice but it's a soft ceiling.

#### Part 2 — the 60s TTL as a bounded-staleness window (Bloomreach side only)

`BloomreachDataSource.callTool` caches every successful result for 60 seconds (`lib/data-source/bloomreach-data-source.ts:145, 186`). That's a bounded-staleness guarantee — any data returned to the caller is at most 60 seconds out of date relative to Bloomreach. The Olist side has no cache (`lib/data-source/olist-data-source.ts:162` always returns `fromCache: false`), so its results are always fresh relative to the SQLite snapshot. This is an asymmetric staleness contract across the two backends: a `bi:mode=live-bloomreach` briefing sees 60-second-stale data; a `bi:mode=live-sql` briefing sees database-current data. The agent layer is told the same `fromCache: boolean` either way and doesn't care, but a UI tooltip about "last updated" would need to know which backend it asked.

```
  Bounded staleness — what 60s buys and costs

  bought:  rate-limit headroom (don't re-hit Bloomreach for the
           same call within 60s)
           lower latency (cached calls return in 0ms)

  cost:    insights generated from a 59-second-old EQL result
           reflect a 59-second-old view of customer behavior

  is 60s the right window?
    for an analytics dashboard answering "what happened
    yesterday?", absolutely
    for a real-time fraud-detection dashboard, no — would
    need TTL ≈ 1s, but at 1s the cache stops absorbing the
    rate limit and you blow the budget
```

The bound is fixed and the same for every tool. There's no per-tool TTL — `list_funnels` (schema-shaped, changes daily) and `execute_analytics_eql` (data-shaped, could change minute-to-minute) both get 60s. The right next move at scale: variable TTL per tool, longer for schema tools, shorter for analytics. Not done because the workload doesn't demand it.

#### Part 3 — the schema cache as "strong-within-process"

`lib/mcp/schema.ts:131-196` holds a module-level `cached: WorkspaceSchema | null`. First request pays the four-call cost (~5s with spacing); every subsequent request in that process reads the cached value.

```
  Module-cached schema — lifetime is the process

  request 1 to /api/briefing:
    cached === null → bootstrapSchema → 4 MCP calls → store
    cached := { projectId, projectName, events, … }

  request 2 to /api/briefing (same process):
    cached !== null → return immediately (no MCP calls)

  request 3 to /api/agent (same process):
    cached !== null → return immediately

  request 4 (different process / cold start):
    cached === null → bootstrap again
```

This is strong consistency within one process for the process's lifetime. It's also unbounded staleness — if Bloomreach updates the schema (a new event type added), this process never sees the change. There's `_resetSchemaCache()` exposed for tests but no production trigger. The implicit assumption is that schema changes happen on a much longer timescale than a Vercel process's lifetime, so the staleness is bounded *in practice* by how often Vercel recycles instances. Inferred — not measured.

#### Part 4 — what NOT YET EXERCISED looks like

The classical consistency models (causal, vector clocks, conflict-free replicated data types) require multiple replicas with shared state. There is no shared store. There are no replicas of the state to coordinate. The Vercel instances are *unaware of each other* — that's not eventual consistency, it's *no* consistency.

```
  things that are NOT YET EXERCISED at this consistency lens

  - read-after-write across replicas
    (no replicas)

  - causal consistency / vector clocks
    (no concurrent writes; no causal chains between replicas)

  - conflict resolution (CRDTs, last-write-wins, merge functions)
    (no writes; no conflicts)

  - read repair / anti-entropy / gossip
    (no peer state to repair)

  - quorum reads
    (only one source: Bloomreach)
```

They become relevant the moment the app adds a second writer to any state. For example: if /api/briefing and /api/agent ran on two instances at the same time for the same user and BOTH tried to update a shared "last seen insight" record, you'd need at minimum last-write-wins on a timestamp.

### Move 3 — the principle

**The cheapest consistency model is the one you don't need.** blooming insights skips most of the ladder by structurally avoiding the situations that demand the rungs — no shared writable store, no peer replicas, no concurrent writers. What it cannot skip — the cross-step investigation handoff, the bounded staleness of cached reads — it solves with the simplest available primitive (sessionStorage, TTL). The principle: figure out which consistency property your feature actually requires before reaching for the mechanism. Most features need strong-within-one-tab and bounded-staleness-on-reads. Anything stronger is paid for by a database, a queue, or both — and the absence of those in this codebase is the *answer*, not a gap.

---

## Primary diagram

```
  Consistency in blooming insights — what's strong, what's stale, what's absent

  ┌─ Client (one tab) ────────────────────────────────────────────────┐
  │                                                                    │
  │  React state:        strong within one render                      │
  │  sessionStorage:     strong across re-renders / reloads,           │
  │                      dies with the tab                             │
  │  bi:diag:<id>        ← STEP 2's WRITE                              │
  │       │                                                            │
  │       │ user navigates to step 3                                   │
  │       ▼                                                            │
  │  read bi:diag:<id>   ← STEP 3's READ ─── read-your-writes          │
  │  send in query string                                              │
  │                                                                    │
  └─────────────────────────┬─────────────────────────────────────────┘
                            │ HTTPS
                            ▼
  ┌─ Server (Vercel instance — stateless across requests) ────────────┐
  │                                                                    │
  │  request N:  reads diagnosis from query param                      │
  │              no in-process memory of step 2                        │
  │              cannot recover diagnosis on its own                   │
  │                                                                    │
  │  ── caches (per-process, opaque to other instances) ──             │
  │  McpClient cache:   bounded staleness, 60s TTL                     │
  │  module schema:     strong within process, unbounded staleness     │
  │  in-memory Maps:    strong within process, gone on recycle         │
  │                                                                    │
  └─────────────────────────┬─────────────────────────────────────────┘
                            │ HTTPS (within 60s, cached)
                            ▼
  ┌─ Bloomreach ───────────────────────────────────────────────────────┐
  │  source of truth; our view is stale by up to 60s                   │
  │  their own consistency is opaque                                   │
  └────────────────────────────────────────────────────────────────────┘

  the only "stale read" boundary that bites in practice:
    a briefing that re-runs within 60s sees the same MCP results,
    even if Bloomreach got new events between the two runs.
```

---

## Implementation in codebase

**Use cases.**
- User opens an investigation, runs the diagnose step, closes the laptop, comes back two hours later. Step 2's diagnosis is still in sessionStorage (tab still open) → step 3 works. If they closed the tab, sessionStorage cleared → step 3 fails with "no diagnosis was handed over."
- Briefing is generated at 9:00am. Same user re-opens at 9:00:30. The McpClient cache (60s TTL) returns the same EQL results without hitting Bloomreach. Same insights. Even if a fraud event happened at 9:00:15, it's invisible until the cache expires.
- A test fixture seeds `cached: WorkspaceSchema` directly via `_resetSchemaCache()` (`lib/mcp/schema.ts:194-196`) — exposed precisely because test runs need to control consistency at the process-cache layer.

**Code side by side.**

```
  lib/hooks/useInvestigation.ts  (lines 18-19, 70-84, 137-140)

  const stashKey = (step, id) => `bi:inv:${step}:${id}`;
  const diagHandoffKey = (id) => `bi:diag:${id}`;        ← the carrier key

  // for the recommend step, load the handed-over diagnosis:
  if (step === 'recommend') {
    try {
      const raw = sessionStorage.getItem(diagHandoffKey(id));
      if (raw) {
        const d = JSON.parse(raw) as { diagnosis?: Diagnosis };
        handedDiagnosis = d.diagnosis ?? null;
        cDiag = handedDiagnosis;
        if (handedDiagnosis) setDiagnosis(handedDiagnosis);
      }
    } catch { /* ignore */ }
  }

  // on 'done' during the diagnose step:
  if (step === 'diagnose' && cDiag) {
    sessionStorage.setItem(
      diagHandoffKey(id),
      JSON.stringify({ diagnosis: cDiag }),               ← THE WRITE
    );
  }
       │
       └─ this is the read-your-writes mechanism. The client writes
          the diagnosis at the end of step 2 and reads it at the start
          of step 3. Server holds nothing between the two requests —
          surviving instance recycles by design.
```

```
  lib/data-source/bloomreach-data-source.ts  (lines 130-137, 144-152)

  this.minIntervalMs = opts.minIntervalMs ?? 200;
  this.maxRetries = opts.maxRetries ?? 3;
  this.retryDelayMs = opts.retryDelayMs ?? 10_000;
  this.retryCeilingMs = opts.retryCeilingMs ?? 20_000;
  // ttl defaults to 60_000 per call

  const cacheKey = `${name}:${JSON.stringify(args)}`;
  const ttl = options.cacheTtlMs ?? 60_000;

  if (!options.skipCache) {
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {        ← lazy check
      return { result: cached.result as T,
               durationMs: 0,
               fromCache: true };
    }
  }
       │
       └─ this is the Bloomreach-side bounded-staleness mechanism. Every
          cached read is at most 60s stale relative to Bloomreach. Per-call
          TTL is overridable (cacheTtlMs option) but no caller currently
          does. The Olist adapter has no equivalent — fromCache is always
          false there (olist-data-source.ts:162), and the same DataSource
          interface returns identical-shaped envelopes from both sides
          with different freshness guarantees underneath.
```

```
  lib/mcp/schema.ts  (lines 131-133, 170-192)

  let cached: WorkspaceSchema | null = null;          ← module-level cache

  export async function bootstrapSchema(mcp): Promise<WorkspaceSchema> {
    if (cached) return cached;                         ← strong-within-process,
    const { projectId, projectName } = await resolveProject(mcp);
    const args = { project_id: projectId };
    const eventSchema = await callOrThrow(mcp, 'get_event_schema', args);
    const customerProps = await callOrThrow(mcp, 'get_customer_property_schema', args);
    const catalogs = await callOrThrow(mcp, 'list_catalogs', args);
    const overview = await callOrThrow(mcp, 'get_project_overview', args);
    cached = parseWorkspaceSchema({ projectId, projectName, eventSchema,
                                    customerProps, catalogs, overview });
    return cached;
  }
       │
       └─ no production invalidation. The cached schema lives as long
          as the Node process. Vercel will recycle the process eventually,
          which is the de-facto staleness bound. _resetSchemaCache() is
          test-only.
```

---

## Elaborate

The stateful-client / stateless-server pattern is exactly what makes serverless platforms (Vercel, AWS Lambda, Cloudflare Workers) feasible for stateful-feeling apps. The platform refuses to promise that two requests see the same process; the app responds by not putting state on the server between requests, and instead carrying it on the client (cookies, sessionStorage, URL params) or in an external durable store. blooming insights does the first; it does not yet do the second.

The 60s TTL is a single-knob system. The right pattern at higher scale is **cache-control via the caller** — let each agent declare how stale a tool result can be ("monitoring tolerates 5 minutes; diagnostic needs fresh") and let `callTool` honor that. The infrastructure for it is already in `CallToolOptions.cacheTtlMs` — what's missing is callsites that use it. The day a "real-time" feature ships, that knob gets wired up.

A related concept: read-your-writes guarantees usually come from "sticky sessions" (all of a user's requests go to one server) or from a centralized store. blooming insights gets the same effect by routing the writes through the client, which is technically cleaner because it survives any backend topology change. The cost is that "writes" are limited to "things that fit in sessionStorage."

---

## Interview defense

**Q: What consistency model does this app use?**

Three different ones at three different layers. Strong consistency within one Vercel process for in-memory state — Map and module variables. Bounded staleness (60-second TTL) for cached MCP reads. Read-your-writes for cross-request flows, but implemented unusually — by routing the writes through the client's sessionStorage instead of through a server-side store. There's no replication, no eventual consistency, no causal model — because there are no replicas of the state to be inconsistent across.

```
  three layers, three models

  in-process state    →  strong (within one process lifetime)
  cached MCP reads    →  bounded staleness (60s)
  cross-request flow  →  read-your-writes via stateful client
```

**Q: How does step 3 of the investigation see the diagnosis from step 2?**

It doesn't, on its own — the server is stateless between the two requests. The client carries the diagnosis: `useInvestigation` writes it to `sessionStorage.bi:diag:<id>` when step 2 completes, and reads it from sessionStorage when step 3 starts, then sends it back to the server in a query parameter. The server's `/api/agent?step=recommend` route requires the diagnosis to be present in the URL — it won't try to recover it on its own, because in production it provably can't (different Vercel instance, no shared store).

```
  the handoff

  step 2 server  ──emits──►  client (cDiag)
                              │
                              ▼
                          sessionStorage[bi:diag:X]
                              │
  step 3 server  ◄──reads──── client (URL param)
```

**Q: Where would this break?**

When the user closes the tab between steps. sessionStorage is per-tab. Reopening to the step-3 URL gives a cache miss → no diagnosis → 500 with "no diagnosis was handed over." The fix would be a server-side store keyed by `insightId` that both routes can read, sized for the diagnosis object — Vercel KV or Upstash Redis would work. Not built today because the only user flows that reach step 3 go through step 2 in the same tab.

---

## Validate

- **Reconstruct.** Without looking, draw the read-your-writes flow from step 2 to step 3. Name every component, the write key, the read key, and the carrier (URL param vs body vs cookie).
- **Explain.** Why is the TTL on `BloomreachDataSource.cache` fixed at 60s for every tool, when `list_funnels` changes much less frequently than `execute_analytics_eql`? Because no callsite passes `cacheTtlMs` to override the default — the option exists but isn't wired up. At hackathon scale 60s for both is fine; at production scale you'd vary it per tool. (And the Olist side bypasses the question entirely — no TTL because no cache.)
- **Apply.** A product manager asks: "Can the user re-open an old investigation tomorrow and see the same diagnosis?" Walk through the consistency layers. (Yes for cached/replayed investigations in `lib/state/investigations.ts` — those are persisted in `.investigation-cache.json` in dev or `demo-investigations.json` for the demo. No for a live investigation in production after Vercel recycles the instance — the in-memory cache is gone and the route's `getCachedInvestigation` returns null. Demo replay is the only durable path.)
- **Defend.** Why no per-tool TTL? Because the workload doesn't demand it yet. The 60s default is comfortably below the perceived-freshness threshold for an analytics tool and comfortably above the rate-limit window. The day a real-time feature ships, the wired-but-unused `cacheTtlMs` option becomes the lever.

---

## See also

- `01-distributed-system-map.md` — Seam A (client ↔ server) is the carrier for read-your-writes
- `03-idempotency-deduplication-and-delivery-semantics.md` — the same 60s TTL is also a dedup window
- `05-replication-partitioning-and-quorums.md` — why classical consistency models don't apply (no replicas)
- `08-sagas-outbox-and-cross-boundary-workflows.md` — the step 2 → step 3 flow as a cross-boundary workflow
- `10-transport-agnostic-protocol-design.md` — the asymmetric staleness contract between the two adapters
- `.aipe/study-system-design/audit.md#state-ownership-and-source-of-truth` — the architectural take on state ownership

---
Updated: 2026-06-16 — Verdict + Part 2 cover the asymmetric staleness contract (Bloomreach: 60s TTL; Olist: always fresh); line refs migrated to `lib/data-source/bloomreach-data-source.ts`.
