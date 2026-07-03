# Runtime map

*Runtime topology · Project-specific*

## Zoom out — where this concept lives

Before you can reason about a bug or a cost blowout, you need to see the whole thing on one page. The runtime map is that page — it names the process boundaries, where state lives inside each one, and which resources cross each boundary.

```
Zoom out — the three bands and where state lives

┌─ Browser (one page per user) ─────────────────────────────────────┐
│  ★ React tree                                                     │
│  ★ useRef latches, sessionStorage stashes, localStorage mode      │
│  fetch()  →  ReadableStream reader  →  handle(event)              │
└─────────────────────┬─────────────────────────────────────────────┘
                      │ HTTPS (one request per stream)
                      │ req.signal fires on unmount / tab close
┌─ Vercel serverless (Node process) ▼───────────────────────────────┐
│  ★ THIS IS WHERE ALL SERVER RUNTIME LIVES ★  ← we are here        │
│                                                                    │
│  process-scoped (module load, warm reuse):                        │
│  · in-memory Map<sessionId, SessionFeed>  lib/state/insights.ts   │
│  · in-memory Map<insightId, AgentEvent[]> lib/state/investigations│
│  · prompt strings read at module load     (legacy agents)         │
│  · pricing table                          lib/agents/pricing.ts   │
│                                                                    │
│  request-scoped (per HTTP request):                               │
│  · AsyncLocalStorage RequestStore         lib/mcp/auth.ts:47      │
│  · ReadableStream body                    routes                  │
│  · BudgetTracker instance                 lib/agents/budget.ts    │
│  · BloomreachDataSource instance          per makeDataSource()    │
│                                                                    │
│  call-scoped (per MCP or Anthropic call):                         │
│  · AbortSignal.timeout(30_000)            lib/mcp/transport.ts:38 │
│  · retry ladder waitMs                    bloomreach-data-source  │
└─────────────────────┬─────────────────────────────────────────────┘
                      │ HTTPS (per-user rate-limited; ~1 req/s)
┌─ Providers (external) ▼───────────────────────────────────────────┐
│  Anthropic API · Bloomreach loomi connect MCP server              │
└───────────────────────────────────────────────────────────────────┘
```

There are exactly three bands. Not four. There is no worker process, no child process, no OS thread the app manages. A `grep -r "worker_threads\|child_process"` across `lib/` and `app/` returns zero hits. This is important: every runtime primitive you meet in the rest of this guide is a *single-threaded-event-loop* primitive, not a threading one.

## The structure pass — control, state, failure

Three axes, held constant across the three bands. Read one column at a time; the answer flips at every boundary.

```
The three-band structure — same axes, three answers each

axis          browser              node process            provider
────          ─────────────        ────────────            ────────

control       React scheduler +    single event loop       their scheduler,
              microtask queue      + microtask queue       we don't see it

state         useState, useRef,    Map<sessionId, …>,      opaque; each call
              sessionStorage,      ALS RequestStore,       is stateless from
              localStorage         BudgetTracker(instance) our side

failure       error boundary,      try / catch / finally   HTTP status +
              readNdjson's         + `send({type:'error'})`  isError envelope
              onMalformed hook     on NDJSON wire          (MCP result)

lifecycle     mount → unmount      request → response      per-call
              (StrictMode: mount   (finally block always
              → unmount → mount)   fires, even on abort)
```

The seams that carry a load are the boundaries where an axis-answer flips:

  → **Browser ↔ Node — the control axis flips.** The browser owns "when to start a request"; the Node process owns "when to finish it." The signal that binds them is `req.signal` — the browser can cancel; the node handler observes and unwinds. See `useInvestigation.ts:38-49` (the client side) and `route.ts:215, :226` (`req.signal.throwIfAborted()` between phases).

  → **Node ↔ Provider — the failure axis flips.** Inside the Node band, failures are `throw`s and rejections. At the provider boundary they become HTTP status codes and MCP `isError` envelopes. `BloomreachDataSource.callTool` translates both directions: HTTP errors → `McpToolError` with tagged tool name; `isError: true` results → rate-limit retry OR pass-through.

  → **Request ↔ Call — the state axis flips.** Above the transport call, state is a `BudgetTracker` instance shared across turns. Below it, state is a per-call `AbortSignal` and a per-call retry counter. The transport is where the "long-lived accumulator" meets the "call-scoped ceiling."

Everything in this guide hangs on those three seams.

## How it works — the map, mechanism by mechanism

### Move 1 — the mental model

A Vercel serverless deployment isn't magic: it's one Node process, cold-started when needed, kept warm briefly, killed when idle. Every module-level `const`, every `new Map()`, every top-level `readFileSync` runs once per instance and persists until the process dies.

```
One instance, many requests

instance boots (cold start)
   │
   │  module load: prompts read, Maps created, pricing table freezes
   ▼
request A ──►  handler runs  ──► response  ──► instance stays warm
   │              │                │
   │              └─ reads         └─ writes to same Maps
request B ──►    handler runs  ──► response
   │              │
   │              └─ ★ sees A's Maps ★  ← this is why session-keying matters
   ▼
… some time passes …
   │
   ▼
instance killed (Vercel decides)
   │
   ▼
request C ──►  COLD START ──►  new instance, empty Maps
```

The critical property: warm reuse. On a warm instance, session Maps carry state between requests. That's a feature (you don't re-connect the MCP client on every call) and a hazard (state that isn't scoped by session bleeds between users).

### Move 2 — the three bands, one at a time

#### The browser band

The browser hosts one React tree per open tab. State lives in three places, at three lifetimes:

  → **`useState` / `useRef`** — component-scoped. Wipes on unmount.
  → **`sessionStorage`** — tab-scoped. Survives navigation within the tab, dies on tab close. Used to stash the insight (`bi:insight:${id}`), the diagnosis handoff (`bi:diag:${id}`), and the completed investigation trace (`bi:inv:${step}:${id}`) — see `lib/hooks/useInvestigation.ts:19-20`.
  → **`localStorage`** — origin-scoped. Persists across tab close. Used only for the demo/live mode flag (`bi:mode`) — see `lib/hooks/useInvestigation.ts:158`.

The critical browser primitive is the `useRef` latch in `useInvestigation.ts:44`:

```ts
// lib/hooks/useInvestigation.ts:44-49
const startedRef = useRef(false);

useEffect(() => {
  if (!id) return;
  if (startedRef.current) return; // run once per mount (survives StrictMode)
  startedRef.current = true;
```

React 19 dev mode double-mounts every effect. Without the ref latch, every investigation would fire twice. With it, the second mount observes the ref is already `true` and bails. The comment at line 46 is load-bearing: `run once per mount (survives StrictMode)`.

#### The Node process band

This is where all server runtime lives. Cross-cutting mechanisms:

  → **`AsyncLocalStorage` (`node:async_hooks`)** — `lib/mcp/auth.ts:47`. Seeds a `RequestStore` from the auth cookie once at request start, flushes back once at request end. Each request gets its own ALS context; concurrent requests on one instance never share state.

  → **`ReadableStream<Uint8Array>`** — `app/api/briefing/route.ts:99, :191`, `app/api/agent/route.ts:129, :184`. Web Streams API, not Node's `stream` module. The route returns a stream; Vercel keeps the connection open until `controller.close()`.

  → **Session-keyed `Map`** — `lib/state/insights.ts:14`. Outer map keyed by session id. Only the caller's sub-map is cleared on write; the outer map is never cleared by request code.

  → **`BudgetTracker` instance** — `lib/agents/budget.ts:41-77`. Instance created per investigation; passed via `AgentHooks.budget` to both `DiagnosticAgent.investigate()` and `RecommendationAgent.propose()`. Same instance across the two agents in one investigation.

#### The provider band

Two providers, both stateless from our side:

  → **Anthropic API** — `claude-sonnet-4-6` for agents, `claude-haiku-4-5-20251001` for intent classification. Called through the `@anthropic-ai/sdk` client. Every call is independent from Anthropic's perspective; state lives in the *messages array* the client sends.

  → **Bloomreach loomi connect MCP server** — the OAuth-authenticated MCP server. Per-user rate-limited (~1 req/s); tokens revoked after minutes. `BloomreachDataSource` (`lib/data-source/bloomreach-data-source.ts`) is the adapter that speaks to it.

### Move 3 — the principle

**Runtime state has a lifetime, and the lifetime is what the scope is for.** Every piece of state in this codebase is deliberately scoped to a lifetime: module (Maps that survive requests), request (ALS), investigation (BudgetTracker), or call (AbortSignal). When the lifetimes are named right, the concurrency questions get easy — you never have to ask "who else sees this?" because the scope answers.

The mistake the codebase avoids: process-scoped state that should be request-scoped. That mistake is how `putInsights` would wipe another user's feed on a warm instance if the map weren't keyed by session (`lib/state/insights.ts:14, :62-71`). The scope is the fix.

## Primary diagram — the full map

```
Runtime map — three bands, state at every scope

┌─ Browser ─────────────────────────────────────────────────────────┐
│                                                                    │
│  ┌─ Page (React tree) ────────────────────────────────────┐       │
│  │ useState  useRef(latch)  sessionStorage  localStorage  │       │
│  └────────────────────┬───────────────────────────────────┘       │
│                       │ fetch()                                   │
│                       │ req.signal fires on unmount                │
└───────────────────────┼───────────────────────────────────────────┘
                        │
                        ▼   HTTPS
┌─ Vercel serverless — ONE Node process per warm instance ──────────┐
│                                                                    │
│  Route handler:                                                   │
│  · maxDuration = 300                                              │
│  · try { … } finally { console.log(phases) }                      │
│  · ReadableStream body                                            │
│                                                                    │
│  ┌─ process scope ────────────────────────────────────────┐       │
│  │ Map<sessionId, SessionFeed>       lib/state/insights.ts│       │
│  │ Map<insightId, AgentEvent[]>      lib/state/invs.ts    │       │
│  │ prompt strings (legacy agents)                          │       │
│  └────────────────────────────────────────────────────────┘       │
│                                                                    │
│  ┌─ request scope (ALS + local) ──────────────────────────┐       │
│  │ RequestStore { store, dirty }     lib/mcp/auth.ts:46    │       │
│  │ BudgetTracker                     lib/agents/budget.ts  │       │
│  │ BloomreachDataSource              lib/data-source/…     │       │
│  │ CapabilityEvent[] (eval only)     eval/load.eval.ts     │       │
│  └────────────────────────────────────────────────────────┘       │
│                                                                    │
│  ┌─ call scope (per MCP / Anthropic call) ────────────────┐       │
│  │ AbortSignal.timeout(30_000)       lib/mcp/transport.ts  │       │
│  │ composeSignals(client, timeout)                          │       │
│  │ retry counter (up to maxRetries=3)                       │       │
│  └────────────────────────────────────────────────────────┘       │
│                                                                    │
└───────────────────────┬───────────────────────────────────────────┘
                        │
                        ▼   HTTPS (rate-limited ~1 req/s per user)
┌─ Providers ───────────────────────────────────────────────────────┐
│  Anthropic (stateless)                                            │
│  Bloomreach MCP (session-owned; tokens rot ~minutes)              │
└───────────────────────────────────────────────────────────────────┘
```

## Elaborate — why the three-band framing lands

The three-band framing comes from serverless deployment reality: you write code that runs on a Node process, but the platform owns the process lifecycle. You don't `fork()`, you don't manage threads, you don't tune GC. What you own is the code that runs *inside* one process, and the protocol between that process and the client / the providers.

This shifts the runtime questions from *"how do I schedule work across cores"* to *"how do I bound work inside one event loop, how do I share resources across concurrent requests on one warm instance, and how do I compose the cancellation signals so nothing outlasts its purpose."* Every mechanism in this guide is a variation on those three questions.

If the codebase later grew a background job (e.g., a scheduled monitoring scan), it would add a fourth band — the cron trigger — and the runtime questions would shift again (durable state? job retries?). It has not, so this guide teaches three bands.

## Interview defense

**Q: How many processes does blooming insights run?**

Three bands, but only one that the app manages: the Node process on Vercel. The browser is a client, not a process the app owns; the Anthropic and Bloomreach APIs are external services. Everything server-side happens inside one Node process per warm serverless instance. No worker threads, no child processes.

Anchor: `grep -r "worker_threads\|child_process" lib/ app/` returns zero hits.

**Q: Where does state live in a warm serverless instance?**

Three scopes, three lifetimes:

  → Process scope — module-level `Map`s (`lib/state/insights.ts:14`), prompt strings read at module load (legacy agents), the pricing table. Persists across every request on this instance until the process dies.

  → Request scope — `AsyncLocalStorage` for the auth cookie store (`lib/mcp/auth.ts:47`), per-request `BudgetTracker`, per-request `BloomreachDataSource`. Dies when the response ends.

  → Call scope — `AbortSignal.timeout(30_000)` on each MCP call. Dies when the call resolves or aborts.

The failure mode this prevents: process-scoped state that should be session-scoped. `putInsights` clears one session's insights — if the outer map weren't keyed by session, it would wipe another user's feed mid-briefing on a warm instance.

**Q: What's the maximum wall-clock a single request can hold?**

`maxDuration = 300s` on `/api/briefing` and `/api/agent` (Vercel Pro's cap). Below that, `TOOL_TIMEOUT_MS = 30_000` per MCP call means one hung call costs 30s, not 300s. Below that, `retryCeilingMs = 20_000` bounds any single retry wait. Bounded work is enforced at every level of the stack.

## See also

  → `02-processes-threads-and-tasks.md` — the answer to "where does work run" per band.
  → `04-shared-state-races-and-synchronization.md` — the mechanisms behind each scope in the map.
  → `07-backpressure-bounded-work-and-cancellation.md` — how the ceilings compose.
  → `study-system-design` (`.aipe/study-system-design/`) — the DataSource seam and the deployment shape from a system-design lens.
