# Runtime Systems — Red Flags Audit

**Industry name:** runtime risk audit · **Type:** Project-specific

## Zoom out — where this concept lives

This file is the audit. Every other file in this folder was a teaching pass; this one ranks the five things actually visible in the current code that a senior engineer would flag in review. Each entry is grounded in a real `file:line`, named, and paired with a fix sized to the risk.

```
  Zoom out — the five findings, ranked

  HIGH        ✗ Finding #1: schema cache leaks across users
              ✗ Finding #2: per-instance cache co-located with bug-shaped neighbor

  MEDIUM      ⚠ Finding #3: useInvestigation deliberately doesn't cancel
              ⚠ Finding #4: disposeDataSource is a no-op for the only live adapter

  LOW         ◦ Finding #5: latent lastCallAt micro-race (dormant)
```

The ranking weights: blast radius (how many users affected), correctness vs ergonomics (data leak vs UX cost), and how easy it is to fix.

## Finding #1 — Schema cache leaks across sessions

**Severity:** HIGH (correctness · multi-user data exposure)
**Evidence:** `lib/mcp/schema.ts:138`, `186-209`

```ts
// lib/mcp/schema.ts:138
let cached: WorkspaceSchema | null = null;

// lib/mcp/schema.ts:186-209 (the read+write site)
export async function bootstrapSchema(
  dataSource: DataSource,
  opts: BootstrapOpts = {},
): Promise<WorkspaceSchema> {
  if (cached) return cached;
  const { projectId, projectName } = await resolveProject(dataSource, opts);
  // ... 4 MCP calls populate ...
  cached = parseWorkspaceSchema({ /* ... */ });
  return cached;
}
```

### What's wrong

`cached` is module-level and unkeyed. Every other module-level mutable in this codebase is session-keyed (`state` in `lib/state/insights.ts:14`, `mem` in `lib/state/investigations.ts:11`, `memStore` in `lib/mcp/auth.ts:36`); this one isn't. On a warm Vercel instance, the FIRST request populates `cached` for its user; the SECOND request from a different user sees `cached` is non-null and returns the FIRST user's schema.

The blast radius:
- `WorkspaceSchema.projectId` flows into every tool call as `project_id`. If user B doesn't have tokens for user A's project, every MCP call errors out and B sees Bloomreach permission errors.
- `WorkspaceSchema.events`, `customerProperties`, `catalogs` flow into the agent's prompt via `schemaSummary` (`lib/agents/monitoring.ts:19-60`). User B's agent sees user A's data layout — a small information leak.
- `WorkspaceSchema.projectName`, `totalCustomers`, `totalEvents` appear in the UI header. User B sees user A's project name and customer count.

### Why it's not caught by tests

A single-user dev session never sees the leak (the same user populates and reads `cached`). Tests reset the cache via `_resetSchemaCache()` (`schema.ts:211-213`) between runs. The bug only surfaces with two real users hitting the same warm instance in quick succession.

### The fix

Smallest change: session-key the cache.

```ts
const cached = new Map<string, WorkspaceSchema>();

export async function bootstrapSchema(
  dataSource: DataSource,
  opts: BootstrapOpts & { sessionId: string } = { sessionId: '' },
): Promise<WorkspaceSchema> {
  const existing = cached.get(opts.sessionId);
  if (existing) return existing;
  // ... bootstrap ...
  cached.set(opts.sessionId, schema);
  return schema;
}
```

Costs: change the bootstrap signature (one extra param) and pass `sessionId` from the route handler / factory.

Alternative: remove the cache entirely. The 4 MCP calls are sequential at ~1.1s spacing = ~4.4s per bootstrap, but they only run ONCE per request. The route budget can absorb it. The downside is every request pays ~4.4s; the upside is removing a leak vector permanently.

Recommended: session-key. Keeps the cache benefit, fixes the leak with one line.

---

## Finding #2 — Cache is per-request (currently safe), but co-located with the leak

**Severity:** HIGH (latent · review hazard)
**Evidence:** `lib/data-source/bloomreach-data-source.ts:122`, `144-188`

```ts
// lib/data-source/bloomreach-data-source.ts:121-122
export class BloomreachDataSource implements DataSource {
  private cache = new Map<string, { result: unknown; expiresAt: number }>();
```

### What's wrong

This cache is currently safe — `BloomreachDataSource` is constructed per request inside `connectMcp` (`lib/mcp/connect.ts:94-101`), so each user gets their own instance with their own cache Map. The 60s TTL is enforced per entry.

BUT: the comment doesn't say this. A future "let's reuse one BloomreachDataSource singleton to save the OAuth handshake cost" refactor would silently break isolation — the cache would become shared and start leaking results across users.

### The fix

Add an inline comment naming the per-request lifetime as a correctness invariant.

```ts
export class BloomreachDataSource implements DataSource {
  // ★ INVARIANT: this cache is per-instance, and instances are constructed
  //   PER REQUEST in lib/mcp/connect.ts. DO NOT promote to a module-level
  //   singleton without re-keying entries by sessionId — the 60s TTL alone
  //   does not protect against cross-user leaks.
  private cache = new Map<string, { result: unknown; expiresAt: number }>();
```

Five-minute fix, prevents a future foot-gun.

---

## Finding #3 — `useInvestigation` deliberately does NOT cancel on cleanup

**Severity:** MEDIUM (resource waste · documented trade)
**Evidence:** `lib/hooks/useInvestigation.ts:36-37`, `44-49`

```ts
// lib/hooks/useInvestigation.ts:36-37 (the comment)
//  NOTE: we deliberately do NOT cancel the fetch on effect cleanup. React
//  StrictMode (dev) mounts → cleans up → re-mounts; cancelling on the first
//  cleanup, with the started-guard blocking the re-mount, aborted the stream
//  and left the logs empty. The started-guard prevents a double fetch; the
//  in-flight run simply completes (setState after unmount is a safe no-op).
```

### What's wrong

When a user opens an investigation page and then closes the tab (or navigates away) mid-stream, the server-side investigation keeps running until `maxDuration = 300` kicks in. That's up to 300s of MCP and Anthropic costs for a result no one will read.

For an alpha with low traffic, this is acceptable — the dev ergonomics (StrictMode-safe re-mount) outweighs the wasted compute. At higher volume it would matter.

### Why it's the way it is

The `useEffect` cleanup pattern of "cancel on cleanup" interacts badly with React StrictMode (dev only): mount → cleanup → re-mount, with the cleanup aborting the in-flight fetch and the started-guard blocking the re-mount's restart. The result was empty logs in dev. The doc'd workaround: don't cancel; let the in-flight run finish (setState after unmount is a documented React no-op).

### The fix

Multi-step option that preserves both invariants:

1. Detect "real unmount" (page navigated away) vs "StrictMode cleanup" (about to re-mount). Production builds don't run StrictMode cleanup, so a `process.env.NODE_ENV === 'production'` guard would let prod cancel on cleanup and dev keep the current behavior.
2. Or: use AbortController with a tiny delay — schedule the abort on cleanup, but cancel the schedule on re-mount. This is the "debounced cancel" pattern.
3. Or: accept the trade as-is and add server-side cancellation via the cookie-stored session ID — a separate route that marks the session as "cancel any in-flight work."

Option 1 is the cheapest fix; option 3 is the most correct. Pick based on traffic.

---

## Finding #4 — `disposeDataSource()` is a no-op for the only live adapter

**Severity:** MEDIUM (latent · cleanup hook unfilled)
**Evidence:** `lib/data-source/index.ts:91-99`, `app/api/{agent,briefing}/route.ts` finally blocks

```ts
// lib/data-source/index.ts:91-99 (the no-op)
return {
  ok: true,
  mode,
  dataSource: bloomreachDs,
  bootstrap: (signal?: AbortSignal) => bootstrapSchema(bloomreachDs, { signal }),
  // Bloomreach is session-scoped, not subprocess-scoped — the client lives
  // across requests via the cookie store, so the route's `finally` doesn't
  // tear it down.
  dispose: async () => {},
};
```

### What's wrong

Both live routes (`/api/agent`, `/api/briefing`) call `await disposeDataSource()` in their `finally` block — but the only production adapter (Bloomreach) returns a no-op. The seam is wired but doesn't fire.

This is correct TODAY (Bloomreach has nothing to tear down — its OAuth state lives in the cookie). It becomes wrong the moment someone adds an adapter with real per-request resources: a SQL connection pool, an open WebSocket, an in-process lock, a file handle. Without a working dispose, those resources leak.

### Why it's the way it is

The previous Olist SQL adapter (now retired) WAS the case the dispose was built for — it spawned a subprocess that needed to be torn down per request. When the adapter went away, the dispose became a no-op for the remaining adapter.

### The fix

No code change needed today. The seam is correct; the implementation is correct. The maintenance discipline: any new adapter MUST implement a real `dispose` if it holds anything beyond per-call locals.

Worth adding to a docs comment:

```ts
// dispose() runs in the route's finally block on EVERY exit path (success,
// error, client abort). Adapters that hold per-request resources (DB pools,
// open files, locks, sockets) MUST release them here.
```

---

## Finding #5 — Latent `lastCallAt` micro-race (dormant)

**Severity:** LOW (dormant · doesn't fire today)
**Evidence:** `lib/data-source/bloomreach-data-source.ts:190-205`

```ts
// lib/data-source/bloomreach-data-source.ts:190-205
private async liveCall(name: string, args: ..., signal?: AbortSignal): Promise<unknown> {
  const elapsed = Date.now() - this.lastCallAt;
  if (elapsed < this.minIntervalMs) {
    await new Promise((r) => setTimeout(r, this.minIntervalMs - elapsed));
  }
  try {
    const result = await this.transport.callTool(name, args, { signal });
    this.lastCallAt = Date.now();
    return result;
  } catch (err) {
    this.lastCallAt = Date.now();
    throw new McpToolError(name, errorDetail(err), { cause: err });
  }
}
```

### What's wrong

If TWO `callTool` invocations fire concurrently on the same `BloomreachDataSource`, both can read `lastCallAt`, both compute `elapsed >= minIntervalMs` as false (no wait), both fire immediately. The rate limit gets bypassed.

This is a JS-event-loop race: it requires two awaits to overlap on the same instance. Today the agent loop runs tools SEQUENTIALLY per turn (`lib/agents/base-legacy.ts:162` iterates `toolUses` with awaits inside a `for` loop). The race never fires.

### When it would fire

If the loop ever switched to parallel tool execution:

```ts
// hypothetical: parallel tool calls per turn
await Promise.all(toolUses.map((tu) => dataSource.callTool(tu.name, tu.input, { signal })));
```

THEN the race would surface. Two `callTool` calls would parallel through `liveCall`, both read `lastCallAt`, both skip the wait, both hit Bloomreach inside the same 1.1s window. Bloomreach would 429, the retry ladder would kick in, the calls would eventually succeed — but the spacing protection would be useless.

### The fix

Promise-based serialization, only if parallel calls become a thing:

```ts
private callQueue: Promise<unknown> = Promise.resolve();

private async liveCall(...) {
  const myTurn = this.callQueue.then(async () => {
    // ... existing body ...
  });
  this.callQueue = myTurn.catch(() => {});  // don't fail the queue on one call's failure
  return myTurn;
}
```

Today: no action needed. Worth a comment noting the structural constraint:

```ts
// ★ INVARIANT: callers must NOT fire parallel callTool invocations on the
//   same BloomreachDataSource instance. lastCallAt is a per-instance gate;
//   parallel calls would race past the ~1 req/s spacing. The agent loop
//   in lib/agents/base-legacy.ts iterates tools sequentially per turn —
//   keep it that way unless you also fix the race.
```

---

## Summary — what to fix and in what order

```
  Priority order — biggest blast radius first

  1. Session-key the schema cache (Finding #1) — 1 line + plumbing,
     fixes a real multi-user data leak                              HIGH

  2. Add the per-request invariant comment on
     BloomreachDataSource.cache (Finding #2)                        HIGH (5 min)

  3. Add the dispose-hook docs comment (Finding #4)                 MEDIUM (5 min)

  4. Either NODE_ENV-guard useInvestigation cleanup
     OR accept the trade and revisit at scale (Finding #3)          MEDIUM (judgment)

  5. Add the parallel-call invariant comment on liveCall
     (Finding #5)                                                   LOW (5 min)
```

Three of these are 5-minute comment fixes that close foot-guns. One is a real code change with real test coverage (the schema cache leak). One is a judgment call (the useInvestigation cleanup).

## What's solid in the runtime

The audit is the negative half; the positive half is worth naming so the review doesn't read as a hit piece. The repo gets the harder parts right:

- **ALS-scoped per-request store** (`lib/mcp/auth.ts:47`, `91`, `114`, `126`) — production-grade async context propagation, correctly placed at the cookie boundary to dodge Next's request-vs-response cookie split.
- **AbortSignal composition** (`lib/mcp/transport.ts:131`, `173`) — modern `AbortSignal.any` with a runtime feature check and a hand-rolled fallback. Composes client cancel with per-call timeout cleanly.
- **Signal threading through five async layers** — route → bootstrap/agent → loop → dataSource → transport → SDK. Every layer accepts `{ signal }`; cancel reaches the deepest await.
- **Session-keyed module-level state** (`lib/state/insights.ts:14-23`) — explicit comment about cross-session bleed; `putInsights` clears only THIS session's slot.
- **Per-route `finally` discipline** — `disposeDataSource` + `controller.close` + phase-summary log fire on every exit path, including client abort. No leaked controllers.
- **Truncation guard against blocking the event loop** (`lib/agents/base-legacy.ts:32`, `184`) — 16K cap on tool-result strings before `JSON.stringify`, preventing a multi-megabyte blob from stalling the thread.

The schema cache stands out as the one piece that didn't get the same care — which is the lesson. Even in a codebase with strong patterns, a single missed key is enough to leak across users.

## See also

- `00-overview.md` — the runtime map these findings sit on.
- `04-shared-state-races-and-synchronization.md` — the deeper walk on findings #1, #2, #5.
- `06-filesystem-streams-and-resource-lifecycle.md` — the deeper walk on finding #4.
- `07-backpressure-bounded-work-and-cancellation.md` — the deeper walk on finding #3.
