# 01 — Runtime map

**Industry name(s):** runtime topology · execution model · process map
**Type:** Industry standard · Project-specific instance

> Four runtimes now (Phase 2). **Client** = React 19 in a browser tab, pulling NDJSON from `fetch().body.getReader()`. **Server** = Node 20 inside a Vercel function, one process per cold start. **Subprocess** (new) = `mcp-server-olist/dist/src/index.js`, a child Node process the server spawns via `StdioClientTransport` when live-sql mode is active; reused across calls within one `OlistDataSource` instance, killed on `dispose()`. **Providers** = Anthropic + Bloomreach MCP over HTTPS (only relevant in live-bloomreach mode). Plus an offline runtime: `tsx eval/scripts/run-*.ts` for the eval flywheel, each script its own Node process per `npm run eval:*`. The rule that explains nearly every design choice in the *server* runtime is still: *the server gets exactly one Node process per invocation and exactly 300 seconds before the platform kills it.* The subprocess rule is different: *exactly one child per `OlistDataSource` instance, single-flight, no per-call rate limit, cleanup-on-dispose.*

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Four bands. The **client runtime** is the V8 inside the user's browser; the only "work" it does is decode NDJSON and call `setState`. The **server runtime** is Node 20 on a Vercel function — one V8 instance, one event loop, no worker threads. The **subprocess runtime** (new since Phase 2) is another Node 20 process — `mcp-server-olist/dist/src/index.js` spawned via `process.execPath` over a stdio pipe; its event loop processes JSON-RPC frames coming in on stdin and writes results back on stdout. Inside it, `better-sqlite3` runs queries synchronously. The **provider runtime** is everything reached over HTTPS: Anthropic for reasoning, the Bloomreach MCP server for tools (in live-bloomreach mode only). There's still no separate database server in the parent process — the SQLite store lives inside the subprocess's heap+filesystem.

```
  Where work runs in blooming insights (Phase 2)

  ┌─ Browser (V8 · one tab) ───────────────────────────────────────────────┐
  │   React 19 components                                                  │
  │   useInvestigation hook  ←  pulls NDJSON line-by-line                  │
  └─────────────────────────────────│──────────────────────────────────────┘
                                    │  HTTPS (chunked transfer · NDJSON)
  ┌─ Vercel function (Node 20 · ONE process per invocation) ───────────────┐ ← parent
  │                                                                        │
  │   ┌──────────────────────────────────────────────────────────────────┐ │
  │   │ Next.js route handlers — /api/briefing /api/agent /api/mcp/*    │ │
  │   │ each returns Response(new ReadableStream(...))                  │ │
  │   └─────────────────────────────│────────────────────────────────────┘ │
  │                                 ▼                                       │
  │   ┌──────────────────────────────────────────────────────────────────┐ │
  │   │ lib/agents/* + lib/data-source/* + lib/mcp/*                     │ │
  │   │   runAgentLoop · DataSource (Bloomreach OR Olist) · auth         │ │
  │   └─────────────────────────────│────────────────────────────────────┘ │
  │           ┌─────────────────────┴───────────────────┐                   │
  │           ▼ live-bloomreach                        ▼ live-sql           │
  │   ┌──────────────────────┐                  ┌──────────────────────┐   │
  │   │ Anthropic SDK +      │                  │ Anthropic SDK +      │   │
  │   │ MCP SDK (HTTP)       │                  │ MCP SDK (stdio)      │   │
  │   │ StreamableHTTP       │                  │ StdioClientTransport │   │
  │   └──────────│───────────┘                  └──────────│───────────┘   │
  └──────────────│──────────────────────────────────────────│──────────────┘
                 │  HTTPS · OAuth bearer · ~1 req/s          │ Unix pipe ·
                 │                                            │ JSON-RPC 2.0
  ┌─ Provider runtimes (external) ───────────────────────┐   ▼
  │  Anthropic API   Bloomreach loomi-connect MCP        │  ┌─ Subprocess (Node 20 child) ─┐
  │  (claude-sonnet-4-6)  (~1 req/s/user globally)       │  │  mcp-server-olist/dist/src/   │
  └──────────────────────────────────────────────────────┘  │   index.js                    │
                                                            │  StdioServerTransport          │
                                                            │  3 tools (get_metric_*…)        │
                                                            │  better-sqlite3 (SYNC queries) │
                                                            │  single-flight; no rate gate    │
                                                            │  killed by parent's dispose()  │
                                                            └─────────────────────────────────┘
```

**Zoom in — what this concept is.** The runtime map is just *which V8/Node process owns which line of code, and what it shares with whom*. The topology used to be flat (one Node process); Phase 2 added a second Node process for live-sql mode. Each Vercel invocation is still its own *parent* Node process holding every cache and state Map you'll see in `lib/state/*`. When that parent spawns an `OlistDataSource`, the *child* gets a separate V8 isolate, a separate event loop, a separate heap, and its own `better-sqlite3` handle pointing at a SQLite file on disk. Nothing in the parent's heap is visible to the child or vice versa — they only see each other through JSON-RPC frames on the stdio pipe.

---

## Structure pass

**Layers.** Four: browser V8 → Node 20 parent on Vercel → (a) Anthropic + Bloomreach over HTTPS, and (b) Node 20 child for Olist over stdio. The two branches at the bottom split on `bi:mode`.

**Axis to trace: *who owns state, and how long does it live?***

```
  One question down the stack — "who owns state, how long does it live?"

  ┌──── browser ─────────────────┐   sessionStorage → tab lifetime
  │  React useState + sessionStorage│  (stash on the client survives reload but not a new tab)
  └────────────────┬──────────────┘
                   │ HTTPS
  ┌──── Node parent on Vercel ───▼┐   in-process Map → cold-start lifetime
  │  Map<string, Insight>            │  (everything in lib/state/* + lib/mcp/schema.ts cache)
  │  AsyncLocalStorage<RequestStore> │  request lifetime (concurrency-safe per request)
  │  Encrypted cookie (bi_auth)       │  10 days (survives instance swap; live-bloomreach only)
  │  OlistDataSource instance         │  request lifetime; owns the child PID until dispose()
  └────────────────┬──────────────────┘
                   │ stdio pipe        │ HTTPS
                   ▼                   ▼
  ┌──── Olist child Node process ──┐  ┌──── Provider ─────────────────┐
  │  better-sqlite3 handle          │  │  Anthropic stateless           │
  │   → SQLite file (read-only      │  │   (no state held across calls) │
  │     for the agent's tools)      │  │  Bloomreach OAuth + rate gate  │
  │  one-tool-at-a-time queue       │  └────────────────────────────────┘
  │  process lifetime = parent's    │
  │   OlistDataSource lifetime      │
  └─────────────────────────────────┘

  the answer changes at every seam — and Phase 2 added a new seam:
  parent ↔ child Node process across a stdio pipe.
```

**Seams.** Four load-bearing ones now:

1. **The HTTPS boundary between browser and Node** — where React state stops mattering and the Node `Map` starts. Anything written into `Map<string, Insight>` after `putInsights(...)` is invisible to any other browser session.
2. **The HTTPS boundary between Node and Anthropic/Bloomreach** — where the 300-second budget meets the `1 req/s` budget. The spacing gate (`03`) and the cache (`05`) live here.
3. **The stdio boundary between Node parent and the Olist child** (new, Phase 2) — JSON-RPC 2.0 frames over a Unix pipe. The per-call timeout (`AbortSignal.timeout(30_000)` ORed with the caller-supplied signal via `composeSignals`) lives here. The lifecycle ownership lives here (parent owns the child PID; `dispose()` closes the SDK client which closes the transport which kills the child). The control-flow axis FLIPS at this seam: parent decides what tool to call, child decides how to compute it.
4. **The Vercel-function-instance boundary** — invisible at code level, real at runtime. Two requests can land on two different warm instances; neither sees the other's `Map`, and a second parent would spawn a *second* Olist child (not share one).

---

## How it works

### Move 1 — the mental model

You already know how Next's App Router works: a `GET()` exported from a `route.ts` becomes an HTTP endpoint. What's worth seeing is what that means at runtime: when a request arrives, Vercel either reuses a warm Node process or cold-starts a new one. Inside that process, your `GET` is one async function call on the event loop. There's no other thread. There's no other event loop. Everything `runAgentLoop` does — every `await mcp.callTool(...)`, every `await new Promise(setTimeout)` — is a turn of *this* loop.

```
  The runtime kernel — what one route handler call looks like

  request arrives
      │
      ▼
  ┌─────────────────────────────────────────────────────────────────┐
  │ Vercel: pick a warm Node process (or cold-start one)            │
  └───────────────────────────────────────────┬─────────────────────┘
                                              │
                                              ▼
  ┌─────────────────────────────────────────────────────────────────┐
  │ Node process (V8 · one event loop · no worker threads)          │
  │                                                                 │
  │   GET(req) is one task on the event loop                        │
  │     await … await … await … (each await yields the loop)        │
  │     stream.start() runs the agent loop inside the same task     │
  │     controller.close() in finally                                │
  │                                                                 │
  └───────────────────────────────────────────┬─────────────────────┘
                                              │
                                              ▼
                           response (or maxDuration kills it at 300s)
```

The kernel is small: one Node process, one event loop, one task per request, and a 300-second hard wall.

### Move 2 — the moving parts

#### 1) The Next.js runtime declaration (or lack of one)

What you'd expect to see at the top of every route file: `export const runtime = 'nodejs'` or `'edge'`. What you see in this repo: **neither**. The two long routes only declare `export const maxDuration = 300`. That's deliberate — Next.js defaults to the Node runtime when nothing is declared, and the repo needs Node because it imports `node:fs`, `node:async_hooks`, `node:crypto` (cipher), and the `@modelcontextprotocol/sdk` (which uses `fetch` but expects Node semantics).

```
  Per-route runtime: declared vs defaulted

  ┌─ what's declared ─────────────────────────────────────┐
  │  app/api/agent/route.ts      maxDuration = 300        │
  │  app/api/briefing/route.ts   maxDuration = 300        │
  │  (no `export const runtime` anywhere)                 │
  └───────────────────────────────────────────────────────┘
                          │
                          ▼  Next.js fills in the default
  ┌─ what actually runs ──────────────────────────────────┐
  │  Node 20 runtime on Vercel (the only viable choice    │
  │  given node: imports + the MCP SDK's expectations)    │
  └───────────────────────────────────────────────────────┘
```

What breaks without the `maxDuration`: the route gets Vercel's default (10s Hobby / 60s Pro), and a live investigation (~100-115s) gets killed mid-loop. The route comment names this exactly.

#### 2) One process per invocation, reused while warm

Vercel functions are not "one process per request" — they're one process that handles as many requests as the platform routes to it before evicting it. This is why your in-process `Map`s sometimes work and sometimes don't: the second user on the warm instance sees the first user's data; the third user, who happens to land on a freshly-cold-started second instance, sees nothing.

```
  Vercel function lifecycle — what a "process" actually means

  cold start                  warm reuse                    eviction
  ─────────────                ─────────────                ─────────────
  ┌─ new Node process ┐        ┌─ same process ┐           ┌─ Node killed ┐
  │  V8 starts        │        │  reused for   │           │  Map<>'s     │
  │  module init      │        │  request N+1  │           │  contents    │
  │  Map<> = empty    │ ───►   │  Map<> still  │  ──────►  │  gone        │
  └───────────────────┘        │  has stuff    │           └──────────────┘
                               └───────────────┘

  the period between cold-start and eviction is when in-process caching
  "just works"; the moment a second instance spins up, it breaks silently
```

The repo navigates this by treating the in-memory layer as opportunistic (`getCachedInvestigation` falls through to a committed JSON file) and by carrying anything that *must* survive on the client (the `?insight=` query param in `app/api/agent/route.ts:37-46`).

#### 3) The client runtime: browser V8, plus one hook

The client side of this app is a thin shell over a streaming reader. Everything important happens in `useInvestigation`: open `fetch`, get the body's `ReadableStream` reader, loop on `reader.read()`, decode chunks, split on `\n`, parse each JSON line, dispatch to `setState`. The cognitively interesting part is the explicit decision NOT to call `AbortController.abort()` on effect cleanup — React StrictMode's double-mount would abort the still-warming stream.

```
  Client runtime — what a single fetched stream looks like

  ┌─ React component mounts ────────────────────────────────────┐
  │                                                              │
  │  useInvestigation(id, step)                                  │
  │      └─ effect (run once per mount via startedRef.current)   │
  │            └─ fetch('/api/agent?…')                          │
  │                  └─ res.body.getReader()                     │
  │                        └─ while (true) { await reader.read } │
  │                              └─ decode → split('\n') → JSON  │
  │                                    └─ setState per event      │
  │                                                              │
  │  cleanup: nothing. The fetch is allowed to complete.         │
  │  (StrictMode's double-mount otherwise aborts the stream      │
  │  before the first byte arrives.)                             │
  └──────────────────────────────────────────────────────────────┘
```

What breaks without the started-ref guard: StrictMode mounts twice, two fetches go out, two streams write into the same state, the trace shows every step twice.

#### 4) The provider runtimes — what we depend on but don't own

Two external runtimes (live-bloomreach mode) plus, since Phase 2, one *internal* runtime we DO own (the Olist child). The externals are stateless from our point of view:

- **Anthropic**: the model call. No state held between calls (we send the full message history every turn). Latency is the only thing that matters; budget per call is ~2-15s.
- **Bloomreach MCP server**: stateful in that it holds the OAuth session, stateless per tool call. Hard constraint: ~1 req/s/user — `McpClient.minIntervalMs = 1100`.
- **Olist subprocess (live-sql)**: a Node child we spawn and own. SQLite queries return in <10ms — there's no rate gate. The constraint instead is *single-flight* (`OlistDataSource.callTool` holds the SDK Client which serializes one in-flight call at a time). See `02` for the process-model details and `04` for why single-flight makes the sync SQLite calls safe in the child loop.

```
  Provider boundary — what they enforce, what we send

  ┌─ Our Node process ────┐                         ┌─ Provider ──────────┐
  │                       │                         │                     │
  │  Anthropic SDK        │ ─── HTTPS · full hist ──► │ Anthropic           │
  │  (no state held       │ ◄── full response ──── │ (stateless)         │
  │   between turns)      │                         │                     │
  │                       │                         │                     │
  │  McpClient            │ ─── HTTPS · bearer ───► │ Bloomreach MCP      │
  │  (1.1s gate +         │      one tool call/req  │ (1 req/s/user       │
  │   60s response cache) │ ◄── tool result ──────  │  enforced)          │
  └───────────────────────┘                         └─────────────────────┘
```

What breaks without the spacing gate: rapid-fire MCP calls land inside the same 1-second window and the server returns rate-limit errors carrying its own retry hint, which `McpClient` then has to wait out — costing ~10s per overrun instead of ~1s of upfront spacing.

### Move 3 — the principle

**A runtime map is not a deployment diagram — it's a *state-and-time* diagram.** Where does each piece of state live, and how long does it live? "It runs on Node" is a deploy fact; "the `cached` schema lives for the warm-instance lifetime, and the `bi_auth` cookie lives for 10 days" is a runtime fact. The second one tells you what will break in production; the first doesn't.

---

## Primary diagram

The full runtime topology, with state ownership and the lifetimes that matter:

```
  The runtime map — bands, owners, lifetimes

  ┌─ Browser V8 (per tab) ─────────────────────────────────────────────────┐
  │  React state         → component lifetime                              │
  │  sessionStorage      → tab lifetime (survives reload, not new tab)      │
  │  useInvestigation    → reads NDJSON; does NOT abort on unmount         │
  └────────────────────────────────│───────────────────────────────────────┘
                                   │  HTTPS chunked
  ┌─ Vercel function (Node 20) ────▼───────────────────────────────────────┐
  │                                                                        │
  │  ┌─ Per-request (ALS-scoped) ────────────────────────────────────────┐ │
  │  │  AsyncLocalStorage<RequestStore> in lib/mcp/auth.ts:47           │ │
  │  │   → decrypted auth store, dirty flag, flushed on request end     │ │
  │  └──────────────────────────────────────────────────────────────────┘ │
  │                                                                        │
  │  ┌─ Per-warm-instance (module scope) ────────────────────────────────┐ │
  │  │  insights      Map<string, Insight>     lib/state/insights.ts:4   │ │
  │  │  investigations Map<string, AgentEvent[]> lib/state/investigations.ts:11│
  │  │  schema cache  let cached: WS|null      lib/mcp/schema.ts:131     │ │
  │  │  McpClient.cache Map<string, {result,exp}> lib/mcp/client.ts:80   │ │
  │  └──────────────────────────────────────────────────────────────────┘ │
  │                                                                        │
  │  ┌─ Per-call (stack-local) ──────────────────────────────────────────┐ │
  │  │  runAgentLoop messages[]                lib/agents/base.ts:79     │ │
  │  │  toolCalls[] / collected[]              lib/agents/base.ts:83     │ │
  │  └──────────────────────────────────────────────────────────────────┘ │
  │                                                                        │
  │     budget walls:                                                      │
  │       maxDuration       = 300s   (route)                               │
  │       minIntervalMs     = 1100   (McpClient)                           │
  │       maxToolCalls      = 6      (per agent)                           │
  │       maxRetries        = 3      (rate-limit retry)                    │
  │       MCP cache TTL     = 60s    (callTool default)                    │
  └────────────────────────────────│───────────────────────────────────────┘
                                   │  HTTPS + OAuth bearer
  ┌─ External providers ───────────▼───────────────────────────────────────┐
  │  Anthropic API            Bloomreach loomi-connect MCP                  │
  │   stateless per call      ~1 req/s/user                                 │
  │   ~2-15s per call         retry-hint in error body                      │
  └────────────────────────────────────────────────────────────────────────┘
```

---

## Implementation in codebase

**Use cases.** Every entry point exercises this map.

- `GET /api/briefing` (`app/api/briefing/route.ts`) — full route handler, one stream, one MonitoringAgent run.
- `GET /api/agent?insightId=…&step=diagnose` (`app/api/agent/route.ts`) — same shape, but with replay-from-cache and per-step filtering.
- Every page that uses `useInvestigation` (`lib/hooks/useInvestigation.ts`) — the client side of the runtime, NDJSON reader.
- `npm run eval:detection|diagnosis|recommendation|regression` (`eval/scripts/run-*.ts` via `tsx`) — Phase 3's offline runtime. Each script is its OWN parent Node process (not on Vercel), spawns its own `OlistDataSource` (which spawns its own subprocess), runs K iterations, writes JSON + summary.md to `eval/results/<date>/`, exits.

**Code side by side.**

```
  app/api/agent/route.ts (line 20)

  export const maxDuration = 300;
       │
       └─ THE budget wall. Removed → Vercel defaults (10s/60s) kill any
          investigation longer than a couple turns. Sized at 300s because
          a live diagnose+recommend runs ~100-115s under the 1 req/s MCP
          gate, plus headroom for cold-start + auth setup.
```

```
  lib/mcp/auth.ts (lines 41-47)

  // To avoid Next's request-vs-response cookie split (a read *after* a set in the
  // same request returns the OLD value), we never touch the cookie per
  // provider-method call. `withAuthCookies` seeds an AsyncLocalStorage-scoped store
  // from the cookie ONCE at the start of the request and flushes it back ONCE at
  // the end; the provider's many synchronous read/write calls hit that store in
  // between. Each request gets its own ALS context, so concurrent requests on one
  // instance never share state.
  interface RequestStore { store: Store; dirty: boolean }
  const requestStore = new AsyncLocalStorage<RequestStore>();
                                         │
                                         └─ THE per-request context. This is the
                                            only thing in the app that makes the
                                            module-scope auth store safe under
                                            concurrent requests on one warm
                                            instance. Without it, request B's
                                            cookie read would see request A's
                                            in-flight writes.
```

```
  lib/mcp/schema.ts (lines 131-141, 173-192)

  let cached: WorkspaceSchema | null = null;
        │
        └─ Module-scope cache → lives for the warm-instance lifetime.
           A second warm instance pays the full bootstrap cost (4 sequential
           tool calls, ~4-5s under the 1.1s gate) on its first request.

  export async function bootstrapSchema(mcp: McpClient): Promise<WorkspaceSchema> {
    if (cached) return cached;
    // ... 4 sequential calls (the McpClient enforces the spacing inline)
    cached = parseWorkspaceSchema({ ... });
    return cached;
  }
```

```
  lib/hooks/useInvestigation.ts (lines 32-36)

  // NOTE: we deliberately do NOT cancel the fetch on effect cleanup. React
  // StrictMode (dev) mounts → cleans up → re-mounts; cancelling on the first
  // cleanup, with the started-guard blocking the re-mount, aborted the stream
  // and left the logs empty. The started-guard prevents a double fetch; the
  // in-flight run simply completes (setState after unmount is a safe no-op).
                                       │
                                       └─ The most consequential CLIENT runtime
                                          decision. Trades cancellation for
                                          StrictMode survivability. The cost
                                          (server keeps running after tab close)
                                          is real — see 07.
```

---

## Elaborate

The serverless runtime is a relatively new shape and not all the textbook advice translates cleanly. In particular:

- **"One process per request" is wrong for Vercel.** It's "one process serves many requests until the platform evicts it." This is what enables module-level caches to ever work, and what makes their failures intermittent.
- **The Node event loop on Vercel is the same Node event loop you have locally.** All the standard reasoning (microtasks, macrotasks, run-to-completion) applies — that's the subject of `03`.
- **There is no per-process supervisor for the PARENT.** Vercel manages the parent process; we don't. We don't catch `SIGTERM`, we don't flush state on shutdown, we don't do graceful drain.
- **There IS a per-process supervisor for the CHILD — us.** Phase 2 made the parent the supervisor of the Olist subprocess via the SDK's `Client.close()` / `StdioClientTransport.close()`. The catch is that supervision only runs on `dispose()`; a parent crash before `dispose()` leaks the child. Node's `child_process` exposes the PID but the SDK abstraction hides it, so we can't `process.kill(pid)` directly without lifting a layer.

**Why `tsx` (not `ts-node`) for eval scripts.** `tsx` uses esbuild as the loader, which gets typescript files running in ~200ms cold vs `ts-node`'s 2-3s. For a K=10 eval that already spends 5-10 minutes in Anthropic + subprocess calls, the loader speed isn't the load-bearing factor — the build-step elimination is. `tsx eval/scripts/run-detection.ts` lets a contributor edit the script and re-run without `tsc`, which keeps the eval flywheel tight. Trade: tsx defaults to ESM-aware behavior, which the scripts handle via `fileURLToPath(import.meta.url)` for path resolution.

Worth reading next: Vercel's Functions docs (lifecycle/eviction), the `@modelcontextprotocol/sdk`'s `client/stdio.js` and `server/stdio.js` (what `StdioClientTransport` does under the hood), the Node `child_process` docs for the layer underneath, and the `tsx` vs `ts-node` benchmarks.

---

## Interview defense

**Q: Why doesn't the repo declare `export const runtime = 'nodejs'` anywhere?**
A: Next.js defaults to Node when nothing's declared, and Node is the only viable choice here — the repo imports `node:fs`, `node:async_hooks`, and `node:crypto` (AES-GCM cipher in `lib/mcp/auth.ts`), and the MCP SDK expects Node semantics. The Edge runtime would fail at module load. The only `export const` at the top of the long routes is `maxDuration = 300` because that's the one that has to be overridden — the default budget would kill a live investigation.

```
  why no runtime declaration

  ┌─ defaults ─┐                 ┌─ overrides ─┐
  │  Node 20   │  ◄── implicit   │ maxDuration  │  ◄── explicit
  │  600s max  │                 │   = 300s     │
  └────────────┘                 └──────────────┘
   no override needed             needed: 10/60s default would kill us
```

**Q: What's the single most load-bearing primitive in the runtime map?**
A: `AsyncLocalStorage<RequestStore>` in `lib/mcp/auth.ts:47`. It's the only thing that makes a module-scope mutable store safe under concurrent requests on one warm instance. Drop it and request B's auth-cookie read sees request A's mid-flight write, which would corrupt the PKCE verifier and break the OAuth round-trip.

```
  why ALS is the kernel

  module-scope writes from request A ───┐
                                        ├──► ALS scopes each request's
  module-scope writes from request B ───┘     store to its own ctx;
                                              flushes back to cookie once.
```

---

## Validate

1. **Reconstruct.** Draw the three runtimes and label, on each, the longest-lived piece of state.
2. **Explain.** Why does `lib/mcp/schema.ts:131` keep `cached` at module scope instead of attaching it to the request context, and what's the cost when Vercel cold-starts a new instance? (Hint: bootstrap is 4 sequential tool calls × 1.1s gate.)
3. **Apply.** A new route needs a database. Where would you put the connection pool? (Module scope, with a `globalThis.__pool` guard against HMR re-init in dev. The repo has no such route today — this is the pattern you'd add.)
4. **Defend.** Why is `useInvestigation` allowed to leak the in-flight `fetch` on unmount? Defend the choice against "you should always abort on cleanup." (Reference `lib/hooks/useInvestigation.ts:32-36`. StrictMode double-mount + started-guard race aborts before the first byte; the right move is to let the fetch finish — `setState`-after-unmount is a safe no-op in React 19.)

---

## See also

- `02-processes-threads-and-tasks.md` — now-two-Node-processes story, threads still absent.
- `03-event-loop-and-async-io.md` — two event loops now (parent + child); JSON-RPC framing on the pipe.
- `04-shared-state-races-and-synchronization.md` — `AsyncLocalStorage` + single-flight subprocess + `composeSignals`.
- `06-filesystem-streams-and-resource-lifecycle.md` — `dispose()` discipline now owns a child PID.
- `07-backpressure-bounded-work-and-cancellation.md` — `maxDuration`, `maxToolCalls`, the half-wired `AbortSignal`.
- `.aipe/study-system-design/00-overview.md` — the architectural component view that complements this runtime view.

---
Updated: 2026-06-16 — added subprocess runtime band (Olist child, stdio, JSON-RPC), tsx/eval scripts, dispose() lifecycle.
