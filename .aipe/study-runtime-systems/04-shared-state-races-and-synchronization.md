# Shared State, Races, and Synchronization

**Industry name:** request-scoped state, AsyncLocalStorage, session-keyed state · **Type:** Industry standard

## Zoom out — where this concept lives

A single-threaded JS event loop means no shared-memory races in the OS-thread sense — but the runtime has its own race surface: module-level mutables shared across requests on a warm Vercel instance. This file walks how the repo isolates four classes of state, why it works in three of them, and where it leaks in the fourth.

```
  Zoom out — the four state stores in the Node band

  ┌─ Node process (warm instance, may serve many users) ────────────────┐
  │                                                                     │
  │  ┌─ class 1: module-level session-keyed Maps ───────────────────┐   │
  │  │  state (lib/state/insights.ts:14)                            │   │
  │  │  mem   (lib/state/investigations.ts:11)                      │   │
  │  │  memStore (lib/mcp/auth.ts:36) — test-only path              │   │
  │  └──────────────────────────────────────────────────────────────┘   │
  │  ┌─ class 2: ALS per-request store ─────────────────────────────┐   │
  │  │  requestStore (lib/mcp/auth.ts:47)                           │   │
  │  └──────────────────────────────────────────────────────────────┘   │
  │  ┌─ class 3: per-request instance fields ───────────────────────┐   │
  │  │  BloomreachDataSource.cache (per-request instance; safe)     │   │
  │  │  BloomreachDataSource.lastCallAt (per-instance; safe)        │   │
  │  └──────────────────────────────────────────────────────────────┘   │
  │  ┌─ class 4: module-level UNKEYED ★ THE LEAK ★ ─────────────────┐   │
  │  │  cached (lib/mcp/schema.ts:138) — bleeds projectId/Name      │   │
  │  └──────────────────────────────────────────────────────────────┘   │
  │                                                                     │
  └─────────────────────────────────────────────────────────────────────┘
```

Three of those classes are correct; one is the highest-ranked finding in this guide's audit.

## Structure pass

### Axis: who can see this state?

Trace one question — "who else has read access to this Map / variable / field?" — across the four classes.

```
  Same one question, four answers — that contrast IS the lesson

  class 1 (session-keyed Map) →  anyone with the same sessionId (one user)
  class 2 (ALS requestStore)  →  anyone inside the same async tree (one request)
  class 3 (per-request inst.) →  anyone holding this DataSource ref (one request)
  class 4 (unkeyed cached)    →  EVERY request on this warm instance (any user)
```

Class 4's answer is the bug. Every other class scopes visibility to one user OR one request; class 4 scopes to the warm process — which has no relation to user identity. Two different users hitting the same warm instance get each other's `projectId` and `projectName` for as long as the cache lives.

### Seams

The relevant seam is **the request boundary**. Above the seam (Vercel-side), each request is independent and the platform may route to any process. Below the seam (Node-side), within one warm process, module-level state survives between requests.

```
  The request seam — what flips when you cross it

  ┌─ Vercel platform (request as unit) ──────────────────┐
  │  isolation: 100% — platform routes each independently │
  └────────────────────────┬─────────────────────────────┘
                           │
                           │ (the seam)
                           │
  ┌─ Node process (warm instance) ──────▼────────────────┐
  │  isolation: depends on the developer                  │
  │  - session-keyed Map → user-isolated ✓                │
  │  - ALS store          → request-isolated ✓            │
  │  - per-instance field → request-isolated ✓            │
  │  - bare `let` global  → NOT isolated ✗ (finding #1)   │
  └───────────────────────────────────────────────────────┘
```

The seam doesn't enforce isolation by itself. The code below it has to.

## How it works

### Move 1 — the mental model

You know how a singleton DB connection at module level is fine for a single-user CLI but a session bleed waiting to happen in a web server? Same idea here, scaled to every kind of mutable state. The rule that keeps a web server's module-level state safe is: ONE OF (a) make it immutable, (b) key it by session, OR (c) put it inside an ALS context. Pick none of these and you have a leak.

```
  The three safe shapes — pick at least one

  ┌─ shape (a): immutable ─────────┐
  │  const TIMEOUT_MS = 30_000     │ ← fine; everyone reads the same thing
  └────────────────────────────────┘
  ┌─ shape (b): session-keyed ─────┐
  │  Map<sessionId, SessionFeed>   │ ← fine; each user has their own slot
  └────────────────────────────────┘
  ┌─ shape (c): ALS-scoped ────────┐
  │  requestStore.run(ctx, fn)     │ ← fine; each request gets its own ctx
  └────────────────────────────────┘
  ┌─ shape (✗): bare mutable ──────┐
  │  let cached: T | null = null   │ ← leak; whoever wrote it last wins
  └────────────────────────────────┘
```

The repo gets this right in three places and wrong in one. Both classes are at module level — the difference is the key.

### Move 2 — the moving parts

#### Shape (b) in action: the session-keyed Map

The canonical correct pattern in this codebase.

```ts
// lib/state/insights.ts:4-23
// Session-scoped feed state. A single warm Vercel instance serves many users
// concurrently, so module-level Maps would bleed between sessions — and
// putInsights' clear() would wipe another user's feed mid-briefing. Each
// session gets its own sub-feed; the outer map is never cleared by a request.
type SessionFeed = {
  insights: Map<string, Insight>;
  investigations: Map<string, Investigation>;
  anomalies: Map<string, Anomaly>;
};

const state = new Map<string, SessionFeed>();

function sessionState(sessionId: string): SessionFeed {
  let s = state.get(sessionId);
  if (!s) {
    s = { insights: new Map(), investigations: new Map(), anomalies: new Map() };
    state.set(sessionId, s);
  }
  return s;
}
```

The outer `state` Map is module-level and survives between requests. The protection is `sessionId` as the key. Two users hit the same warm instance, both call `sessionState`, both get their OWN sub-feed; neither sees the other.

The mutation pattern at `lib/state/insights.ts:57-71`:

```ts
export function putInsights(sessionId: string, items: Insight[], rawAnomalies?: Anomaly[]): void {
  // Replace the previous briefing for THIS session — each run IS the current
  // feed, not an addition. Without clearing, a warm serverless instance (or a
  // long-running dev server) accumulates stale insights from earlier runs, so
  // the feed shows yesterday's anomalies alongside today's. Investigations are
  // keyed separately and untouched here. Only this session's sub-maps are
  // cleared — never the outer map, never another session's feed.
  const s = sessionState(sessionId);
  s.insights.clear();
  s.anomalies.clear();
  items.forEach((i, idx) => {
    s.insights.set(i.id, i);
    if (rawAnomalies?.[idx]) s.anomalies.set(i.id, rawAnomalies[idx]);
  });
}
```

The comment makes the danger explicit: clearing the OUTER map would wipe everyone's feed mid-briefing. The code clears only `s.insights` and `s.anomalies` — only this session's slots.

Same pattern in `lib/state/investigations.ts:11`:

```ts
const mem = new Map<string, AgentEvent[]>();
// keyed by insightId, which is per-investigation; another user's investigation
// has a different insightId (a UUID), so the keys never collide.
```

The key choice (insightId — a UUID generated per anomaly) makes collision astronomically unlikely. Combined with `mem` being module-level for warm-instance reuse, this works.

#### Shape (c) in action: the ALS per-request store

`AsyncLocalStorage` is the JavaScript answer to thread-local storage. It binds a value to an async call tree, so every `await` inside the tree sees the same value without passing it explicitly.

```ts
// lib/mcp/auth.ts:46-47, 86-104 — the request-scoped store
interface RequestStore { store: Store; dirty: boolean }
const requestStore = new AsyncLocalStorage<RequestStore>();

export async function withAuthCookies<T>(fn: () => Promise<T>): Promise<T> {
  if (process.env.NODE_ENV !== 'production') return fn();
  const { cookies } = await import('next/headers');
  const raw = (await cookies()).get(AUTH_COOKIE)?.value;
  const ctx: RequestStore = { store: raw ? decryptStore(raw) : {}, dirty: false };
  const result = await requestStore.run(ctx, fn);
  // ...
}

function readAll(): Store {
  const ctx = requestStore.getStore();          // ← reads the per-request ctx
  if (ctx) return ctx.store;
  // ...
}

function writeAll(store: Store): void {
  const ctx = requestStore.getStore();
  if (ctx) {
    ctx.store = store;
    ctx.dirty = true;
    return;
  }
  // ...
}
```

`requestStore.run(ctx, fn)` enters an async context. Every `requestStore.getStore()` call from inside `fn` — including from deep async descendants — returns the same `ctx`. Two concurrent requests on the same warm instance each call `withAuthCookies`, each call `run(...)` with a different `ctx`, and each of their `getStore()` calls returns THEIR `ctx`. The two never see each other's `store`.

The mechanism underneath: Node's async_hooks tracks parent-child relationships between async resources (Promises, timers, I/O callbacks). When a context is entered with `run`, every async resource created inside inherits it. The "store" is a hidden field on the async context, propagated through every `await`.

Why this exists for THIS code: Next.js's request-vs-response cookie split. Inside a request, reading `cookies()` returns the REQUEST cookies; writing returns a response builder. Reading-then-writing-then-reading-again sees the OLD value, not the just-written one. The OAuth flow needs to read PKCE state, do crypto, write it back, read it again — many times per request. The ALS pattern lets the provider's many sync read/write calls hit an in-memory `ctx.store` instead of touching cookies each time; the cookie is read ONCE at the start of the request and written ONCE at the end.

#### Shape (a) in action: per-request instance fields

```ts
// lib/data-source/bloomreach-data-source.ts:121-137
export class BloomreachDataSource implements DataSource {
  private cache = new Map<string, { result: unknown; expiresAt: number }>();
  private lastCallAt = 0;
  // ...
  constructor(private transport: McpTransport, opts: ClientOpts = {}) { /* ... */ }
}
```

`cache` and `lastCallAt` are instance fields. They survive only as long as the `BloomreachDataSource` instance. Crucially, that instance is constructed PER REQUEST inside `connectMcp` (`lib/mcp/connect.ts:94-101`):

```ts
return {
  ok: true,
  mcp: new BloomreachDataSource(new SdkTransport(client, httpErrors), {
    minIntervalMs: 1100,
    retryDelayMs: 10_000,
    retryCeilingMs: 20_000,
    maxRetries: 3,
  }),
};
```

Per-request construction means per-request lifetime. Two concurrent users get two different `BloomreachDataSource` objects with two different `cache` Maps. The 60s response cache only helps repeats within ONE request — which is exactly what the agent loop hits (the same EQL fired in `diagnose` then `recommend`).

This is shape (a) — immutable from the OUTSIDE — because no other request can reach this instance. The mutability is contained to the request's async tree.

##### A latent micro-race in this class

```ts
// lib/data-source/bloomreach-data-source.ts:190-205
private async liveCall(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
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

If TWO `callTool` invocations fire concurrently on the same `BloomreachDataSource`, both can read `lastCallAt`, both compute `elapsed >= minIntervalMs`, and both fire without spacing. This is a race in the JS-event-loop sense: it requires two awaits to overlap on the same instance. Today the agent loop runs tools SEQUENTIALLY per turn (`lib/agents/base-legacy.ts:162` iterates `toolUses` with awaits), so this never fires. If the loop ever did parallel tool calls (a `Promise.all` over `toolUses`), the race would surface. The mitigation is in the structure of the caller, not the class.

#### Shape (✗) in action: the unkeyed `cached` — finding #1

```ts
// lib/mcp/schema.ts:138, 186-209
let cached: WorkspaceSchema | null = null;

export async function bootstrapSchema(
  dataSource: DataSource,
  opts: BootstrapOpts = {},
): Promise<WorkspaceSchema> {
  if (cached) return cached;                    // ← returns ANY user's cached schema
  const { projectId, projectName } = await resolveProject(dataSource, opts);
  const args = { project_id: projectId };

  // Sequential — the server allows ~1 req/s; BloomreachDataSource already spaces calls.
  const eventSchema = await callOrThrow(dataSource, 'get_event_schema', args, opts);
  const customerProps = await callOrThrow(dataSource, 'get_customer_property_schema', args, opts);
  const catalogs = await callOrThrow(dataSource, 'list_catalogs', args, opts);
  const overview = await callOrThrow(dataSource, 'get_project_overview', args, opts);

  cached = parseWorkspaceSchema({               // ← writes ANY user's schema globally
    projectId,
    projectName,
    eventSchema,
    customerProps,
    catalogs,
    overview,
  });
  return cached;
}
```

`cached` is module-level, unkeyed, and persists for the lifetime of the warm process. The flow:

```
  Two users on one warm instance — what `cached` does

  T=0   user A → bootstrapSchema → resolveProject returns A's project
        → 4 MCP calls populate A's schema
        → cached = A's schema
        → user A's request continues with A's schema (correct)

  T=10  user B → bootstrapSchema → if (cached) return cached
        → user B sees A's projectId / projectName / events / customers
        → user B's request continues with A's schema (WRONG)
```

The blast radius:
- `WorkspaceSchema.projectId` flows into every tool call as `project_id`. User B's queries hit A's project (if B has tokens for A's project, fine; if not, the calls error out and the user sees Bloomreach permission errors).
- `WorkspaceSchema.events` and `customerProperties` flow into the agent's prompt (`schemaSummary` in `lib/agents/monitoring.ts:19-60`). User B sees A's data layout in the agent's thinking — a small information leak.
- `WorkspaceSchema.totalCustomers` and `totalEvents` appear in the UI header. User B sees A's customer count.

Every OTHER module-level mutable in this codebase is session-keyed. This one isn't. The fix is small: change `let cached: WorkspaceSchema | null` to `const cached = new Map<string, WorkspaceSchema>()` keyed on `sessionId` (or on `projectId`, depending on which is the right scope). Or remove the cache entirely — the 4 MCP calls are slow (4 × ~1.1s = ~4.4s) but only run once per request, and the rest of the route's budget can absorb it.

There's a `_resetSchemaCache()` test helper at `schema.ts:211-213` that does `cached = null` — used in tests but never called from production code.

### Move 2 variant — the load-bearing skeleton

The state-isolation skeleton has three required parts. Drop any one and you have a leak.

```
  The skeleton — the kernel that keeps multi-user state safe

  1. A SCOPE choice for every mutable
     (immutable / session-keyed / request-scoped (ALS) / per-instance)

  2. A KEY that uniquely identifies the scope's owner
     (sessionId for cross-request, async context for in-request,
      object identity for per-instance)

  3. A PUBLIC MUTATION PATTERN that respects both
     (clear only YOUR sub-map; never the outer; use ALS run() to enter ctx)
```

What breaks when each is missing:
- Drop the SCOPE choice and you get a global mutable that every request shares (the schema cache leak).
- Drop the KEY and you have a per-user Map without a way to look up the right user's slot (the would-be bug if `state` were just `Map<insightId, ...>` instead of `Map<sessionId, ...>`).
- Drop the MUTATION discipline and a method like `clear()` wipes another user's data (the bug that `putInsights`'s comment explicitly prevents).

The repo gets all three right for the four shape-(b)/shape-(c) Maps. It misses #1 for the schema cache.

### Move 3 — the principle

On a single-threaded runtime, "race" doesn't mean two threads stepping on each other — it means two requests' async trees sharing a mutable that they shouldn't. The synchronization primitive isn't a lock; it's a key. The key partitions the state into per-owner slots, and the runtime's single-threaded execution model ensures each slot is touched serially. Lose the key (the schema cache) and there's nothing else to protect you — JavaScript has no `mutex` to fall back on.

## Primary diagram

```
  The full state-isolation map — four classes, three correct

  ┌─ Node process (warm instance) ──────────────────────────────────────┐
  │                                                                     │
  │   ┌─ state ────────────────────────────────────────────────────┐    │
  │   │   Map<sessionId, SessionFeed>     ✓ session-keyed          │    │
  │   │   - sub-maps cleared by THIS session only                  │    │
  │   │   - outer map never cleared                                │    │
  │   └────────────────────────────────────────────────────────────┘    │
  │   ┌─ mem (investigations.ts:11) ──────────────────────────────┐    │
  │   │   Map<insightId, AgentEvent[]>    ✓ insightId-keyed       │    │
  │   │   - UUIDs make collision astronomical                      │    │
  │   └────────────────────────────────────────────────────────────┘    │
  │   ┌─ memStore (auth.ts:36, test-only) ────────────────────────┐    │
  │   │   Map<sessionId, SessionAuthState>  ✓ session-keyed       │    │
  │   └────────────────────────────────────────────────────────────┘    │
  │   ┌─ requestStore (auth.ts:47) ───────────────────────────────┐    │
  │   │   AsyncLocalStorage<RequestStore>   ✓ async-context-bound │    │
  │   │   - one ctx per requestStore.run(ctx, fn) call            │    │
  │   └────────────────────────────────────────────────────────────┘    │
  │   ┌─ BloomreachDataSource.cache / .lastCallAt ────────────────┐    │
  │   │   per-instance field, instance constructed per request    │    │
  │   │   ✓ scoped by object identity                             │    │
  │   │   ⚠ latent micro-race if caller ever fires parallel calls │    │
  │   └────────────────────────────────────────────────────────────┘    │
  │   ┌─ cached (schema.ts:138) ──────────────────────────────────┐    │
  │   │   let cached: WorkspaceSchema | null     ✗ UNKEYED LEAK   │    │
  │   │   - finding #1 in the audit                               │    │
  │   └────────────────────────────────────────────────────────────┘    │
  │                                                                     │
  └─────────────────────────────────────────────────────────────────────┘
```

## Elaborate

`AsyncLocalStorage` is one of Node's most important runtime features for serverless. Before it (Node ≥13 stabilized in 16), the canonical way to propagate request-scoped state through async code was to pass a `context` argument everywhere — which works but pollutes every signature. ALS makes the context implicit and propagated by the runtime; the price is the magic.

The schema-cache leak is the kind of bug that only shows up under load: a single-user dev session never sees it (the same user populates and reads `cached`), and a test never catches it (each test starts with `_resetSchemaCache()` or a fresh process). It surfaces only when two real users hit the same warm Vercel instance in quick succession. The fix is a single line — wrap `cached` in a `Map<sessionId, ...>` — but the slot in this guide is meant to make the *category* of bug visible, not just this one instance.

## Interview defense

> Q: "How does this codebase handle state shared across concurrent requests on the same Node process?"

Four classes of state, three patterns. Session-keyed Maps at module level (insights, investigations, the test auth store) — every method takes a `sessionId` and looks up a sub-slot. `AsyncLocalStorage` for per-request OAuth state, so the SDK's many sync read/write calls hit an in-memory context instead of cookies. Per-request instance fields on `BloomreachDataSource`, constructed fresh each request. The fourth — a bare `let cached: WorkspaceSchema | null` in `lib/mcp/schema.ts:138` — is the one place the pattern was missed; it leaks `projectId` and `projectName` across users.

> Q: "Why ALS instead of just passing a context argument?"

Next.js's request-vs-response cookie split. Reading `cookies()` returns request cookies; writing returns a response builder. The OAuth flow needs many sync read/writes per request. Passing the context everywhere would require modifying the MCP SDK's `OAuthClientProvider` interface, which we don't control. ALS lets us keep the SDK's sync API while making the underlying storage request-scoped.

> Q: "Single-threaded runtime — there are no real races, right?"

Wrong vocabulary, right intuition. There are no shared-memory races between OS threads. There ARE concurrency bugs: cross-request state bleed (the schema cache), and the latent micro-race in `BloomreachDataSource.lastCallAt` if two callTool invocations on the same instance ever ran in parallel. The single thread means each operation is atomic at the JS level, but two awaits can still interleave on the SAME mutable if the design didn't think about it.

## See also

- `02-processes-threads-and-tasks.md` — why "single-threaded" doesn't mean "no concurrency bugs."
- `05-memory-stack-heap-gc-and-lifetimes.md` — what gets garbage-collected when these maps grow.
- `08-runtime-systems-red-flags-audit.md` — the schema-cache leak ranked as finding #1.
