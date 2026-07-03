# Runtime map

**Industry:** the runtime map (execution-context inventory) · Language-agnostic

## Zoom out — where this concept lives

Every concept file in this guide hangs off one picture: the three bands where code in `blooming_insights` actually runs, and the boundaries between them. This file draws the picture; the other seven files walk one aspect of it at a time.

```
  Zoom out — the runtime map

  ┌─ Browser (V8, one JS thread) ────────────────────────────┐
  │  React 19 · useInvestigation · McpConfigModal            │
  │  localStorage · sessionStorage · fetch()                 │
  └───────────────────────┬──────────────────────────────────┘
                          │  hop 1: HTTPS request + NDJSON
  ┌─ Vercel serverless (Node 20, one warm process) ─▼────────┐
  │  ★ THIS FILE'S FOCUS ★                                   │
  │  app/api/*/route.ts · ALS · in-memory Map<sessionId,…>   │
  │  bounded by maxDuration = 300                            │
  └───────────────────────┬──────────────────────────────────┘
                          │  hop 2: HTTPS (Bearer / OAuth)
  ┌─ Upstream (not our runtime) ──────────▼──────────────────┐
  │  Bloomreach MCP server · Anthropic API                   │
  │  we own our rate-limit policy, not their scheduling      │
  └──────────────────────────────────────────────────────────┘

  fourth CONTEXT (not a production tier): vitest process for evals
```

You're looking at the whole system. Every mechanism in the following files is either "how work moves within one band" or "what has to survive a hop between bands."

## Structure pass — layers, axis, seams

The map has three layers. Pick one axis — **who owns state** — and trace it across all three.

```
  One axis (who owns state?) traced down the layers

  ┌─ Browser ────────────────────────────────┐
  │  React state + localStorage + session-   │  → the CLIENT owns
  │  Storage. Survives reloads (localStorage │    persistent config
  │  only), tab-only (sessionStorage)        │
  └──────────────────────────────────────────┘
       ↓ hop crosses a trust boundary
  ┌─ Vercel serverless ──────────────────────┐
  │  ALS-scoped Map + module-level Map<sid,…>│  → the INSTANCE owns
  │  wiped when the instance dies            │    per-request state
  │  encrypted cookie survives instance death│    (ephemeral)
  └──────────────────────────────────────────┘
       ↓ hop crosses a network boundary
  ┌─ Upstream ───────────────────────────────┐
  │  Bloomreach owns OAuth tokens + workspace│  → the PROVIDER owns
  │  data. Anthropic owns model context.     │    the source of truth
  └──────────────────────────────────────────┘

  the answer flips at each layer — that's the lesson
```

**Two seams matter more than the others:**

- **The browser → server seam.** State that must survive a page reload lives in `localStorage` or an encrypted cookie. State that must survive one browsing session lives in `sessionStorage`. State that dies with the tab is fine as React state. The choice is load-bearing — the MCP config modal writes to `localStorage`; the diagnosis handoff between step 2 and step 3 uses `sessionStorage`. See `04-shared-state-races-and-synchronization.md`.

- **The Vercel instance → next Vercel instance seam.** Warm instances live for minutes; ephemeral ones die after one request. Module-level `Map`s look persistent but aren't: the *next* request may hit a *different* instance. The design compensates by encoding the anomaly into the URL as a `?insight=…` query param — see `app/api/agent/route.ts:36-46`. That's a *deliberate* choice to sidestep shared state entirely.

## How it works

### Move 1 — the mental model

A runtime map is just an inventory: for each piece of code, name the process it runs in, the thread inside that process, and the boundary that separates it from the next piece. In a full-fat backend the inventory might be dozens of rows (a web tier, a queue, a worker fleet, a cron scheduler, a search index, a cache). In `blooming_insights` it's three, and one of them (upstream) isn't ours.

```
  Pattern — runtime inventory row

  ┌── row ──────────────────────────────────────────────┐
  │  where     the process / band                       │
  │  what      the JS event loop / worker / no-op       │
  │  who owns  state, cache, resources                  │
  │  budget    time · memory · money per unit of work   │
  │  bounded   how it stops (timeout · signal · kill)   │
  └─────────────────────────────────────────────────────┘

  fill in three rows: browser · vercel · upstream
```

Once you have those three rows, every question about performance, safety, or debuggability lands somewhere on the map.

### Move 2 — walking each band

#### The browser band

**What runs:** React 19 components under `app/` and `components/`. The `useInvestigation` hook (`lib/hooks/useInvestigation.ts:39`) drives a live investigation stream — it kicks off a `fetch()` in a `useEffect`, then reads the NDJSON body chunk-by-chunk via `readNdjson`.

**Thread model:** one JavaScript thread. Not two, not four — the same event loop as any V8 embedding. Any long-running synchronous work here freezes rendering. The repo does nothing synchronous that would matter (no big JSON.parse of megabyte payloads in the hot path; the NDJSON reader parses one line at a time).

**State ownership:** three tiers.

- `localStorage` — persists across reloads. Holds `bi:mcp_config` (the config modal, `lib/mcp/config.ts:34`) and `bi:mode` (feed live mode, `lib/hooks/useInvestigation.ts:159`). SSR-unsafe by definition, so every helper guards with `typeof localStorage === 'undefined'` (`lib/mcp/config.ts:107`).
- `sessionStorage` — tab-scoped. Holds `bi:inv:<step>:<id>` (per-step trace stash) and `bi:diag:<id>` (diagnosis handoff between step 2 and step 3). See `lib/hooks/useInvestigation.ts:20-21`.
- React state — dies with the component. Trace items, complete flag, error.

**Bounded by:** the browser tab. There is no timeout ceiling — an in-flight NDJSON stream can run for the full 300s Vercel budget. On unmount the stream is deliberately NOT cancelled; see `lib/hooks/useInvestigation.ts:34-38` for the StrictMode-safe pattern.

#### The Vercel serverless band

**What runs:** every file under `app/api/*/route.ts`. `app/api/agent/route.ts` is the load-bearing one — it runs the investigation stream. `app/api/briefing/route.ts` runs the initial monitoring sweep. Both set `export const maxDuration = 300` (`app/api/agent/route.ts:23`, `app/api/briefing/route.ts:20`).

**Thread model:** one Node process per warm instance, one V8 event loop inside it. Vercel keeps instances warm for concurrent requests — module-level state (`memStore` in `auth.ts:36`, the `Map<sessionId, SessionFeed>` in `insights.ts:14`) survives across requests to that instance.

**State ownership:** three sub-tiers.

- **Request-scoped, ALS-backed.** `withAuthCookies` (`lib/mcp/auth.ts:86`) seeds an `AsyncLocalStorage`-scoped store from the encrypted cookie once at the start of a request and flushes it back at the end. Every provider read/write inside hits the ALS store. Each request gets its own ALS context, so two concurrent requests on one instance never share auth state.
- **Instance-scoped, module-level `Map`.** `lib/state/insights.ts:14` — `Map<sessionId, SessionFeed>`. Each session's feed is a sub-`Map`. Wiped when Vercel kills the instance.
- **Cross-instance, encrypted cookie.** `bi_auth` (AES-256-GCM under `AUTH_SECRET`) is the only state that survives the boundary. It carries OAuth tokens, DCR client info, and PKCE verifier — the fields the OAuth callback needs when it lands on a *different* instance.

**Bounded by:** `maxDuration = 300` seconds on the route. Vercel kills the invocation at 300s regardless. The 30s per-call MCP timeout in `transport.ts:38` is a *sub-budget* inside that — one stuck upstream call can't burn the whole budget.

#### The upstream band (not our runtime)

**What runs:** Bloomreach's MCP server and Anthropic's Claude API. We don't own the runtime, the scheduling, or the resource model.

**What we own:** our **client-side policy** against them. The BloomreachDataSource holds a 60s response cache (`lib/data-source/bloomreach-data-source.ts:122`), a ~1 req/s spacing gate (`:123, :191-200`), and a retry ladder that honors the server's stated penalty window. The rate-limit retry logic caps a single call at up to 20s of retry wait (`retryCeilingMs`, `:127`).

**Bounded by:** whatever the upstream promises. Bloomreach's stated retry hint is ~10s; our fallback base matches. Anthropic's per-model rate limits are the other implicit bound — the BudgetTracker (`lib/agents/budget.ts:41`) enforces our cost ceiling, not theirs.

#### The eval context (fourth band, but not a production tier)

**What runs:** vitest processes for `eval/*.eval.ts`. Same Node 20 runtime as the serverless band, but the wall-clock budget is *lifted* — `eval/load.eval.ts` runs for 28+ minutes at N=20 K=3.

**Why call it out:** the eval harness is the only place in the repo with explicit bounded parallelism — the worker-pool pattern in `eval/load.eval.ts:171-211`. That mechanism doesn't exist in production because the production shape (one user, one instance, one investigation) doesn't need it.

### Move 3 — the principle

A runtime map is worth writing down for the same reason a build-vs-runtime dependency graph is worth writing down: it makes the ambient assumptions visible. The moment you can name "this state lives on the instance, that state lives in the cookie, this state lives on the browser," a whole class of bugs (auth-token leak between users, feed wipes another user's data, browser state that doesn't survive reload) stops being surprising. You either designed against them or you didn't.

## Primary diagram — the runtime map, whole

```
  Runtime map — every band, every hop, every boundary

  ┌─ Browser (V8, single JS thread) ─────────────────────────────┐
  │                                                              │
  │  React components ── useInvestigation ── fetch() ── ndjson   │
  │                        (started-ref latch)                    │
  │                                                              │
  │  state:  localStorage (bi:mcp_config, bi:mode)               │
  │          sessionStorage (bi:inv:<step>:<id>, bi:diag:<id>)   │
  │          React state (ephemeral)                             │
  │  bounded by: the tab                                         │
  └────────────────────────────┬─────────────────────────────────┘
                               │  HTTPS + custom header
                               │  x-bi-mcp-config: <base64 JSON>
                               │  cookie: bi_session, bi_auth
                               ▼
  ┌─ Vercel serverless (Node 20, one warm process) ──────────────┐
  │                                                              │
  │  app/api/agent/route.ts   maxDuration = 300                  │
  │  app/api/briefing/route.ts                                   │
  │                                                              │
  │  per-request:  AsyncLocalStorage<RequestStore>               │
  │                 └─ seeded from bi_auth, flushed at end       │
  │                                                              │
  │  per-instance: Map<sessionId, SessionFeed> (lib/state/…)     │
  │                 └─ dies when Vercel kills the instance       │
  │                                                              │
  │  bounded by:   route maxDuration (300s)                      │
  │                per-call MCP timeout (30s)                    │
  │                per-investigation BudgetTracker (USD)         │
  └────────────────────────────┬─────────────────────────────────┘
                               │  HTTPS + Bearer / OAuth PKCE
                               │  spacing gate: ~1 req/s
                               ▼
  ┌─ Upstream (not our runtime) ─────────────────────────────────┐
  │                                                              │
  │  Bloomreach MCP  (list_cloud_organizations → …)              │
  │  Anthropic API   (claude-sonnet-4-6)                         │
  │                                                              │
  │  bounded by:  their rate limits + our BudgetTracker          │
  └──────────────────────────────────────────────────────────────┘

  fourth CONTEXT — not a production tier:
  ┌─ vitest process (long-lived Node) ───────────────────────────┐
  │  eval/load.eval.ts — semaphore-based K workers, no wall clock│
  └──────────────────────────────────────────────────────────────┘
```

## Elaborate

Runtime maps come out of the systems-programming tradition — the same instinct that draws process diagrams before writing any code. The reason the exercise still matters in a serverless-first architecture is that "serverless" hides the runtime by design. You don't allocate processes; Vercel does. You don't schedule threads; V8 does. You don't reserve memory; the platform kills you if you overshoot.

The consequence: the runtime decisions you *do* make (ALS for scoping, module `Map`s for per-instance cache, encrypted cookies for cross-instance state, per-call timeouts for upstream calls) become the *only* runtime knobs you have. Missing one of them isn't hidden by defaults — it shows up as a bug you can point at.

For a next step: the file `04-shared-state-races-and-synchronization.md` walks the ALS pattern in detail (why it exists, what it prevents). The file `07-backpressure-bounded-work-and-cancellation.md` walks the 300s budget + AbortSignal composition. Read those two next — everything else is a specialization of what happens inside one of these bands.

## Interview defense

**Q: What runtime does `blooming_insights` run on?**

Three bands, actually — browser V8, Vercel serverless (Node 20), and upstream providers we don't own. The interesting one is the middle band: it's *one Node process per warm Vercel instance*, one V8 event loop inside that, and module-level state survives across requests to the same instance but not across instances. That's why `lib/mcp/auth.ts` uses `AsyncLocalStorage` to scope OAuth state per request — two concurrent requests on one instance would otherwise share the same token store.

*Diagram to sketch: the three horizontal bands with the AsyncLocalStorage box inside the middle band, one context per request.*

**Q: How does state cross a Vercel instance boundary?**

By design, three ways only. First, an encrypted `bi_auth` cookie (AES-256-GCM under `AUTH_SECRET`) — that's how OAuth tokens survive from the `connect` request on instance-A to the `callback` request on instance-B. Second, URL query params — the feed hands the anomaly to the investigation page as `?insight=…` so the target route doesn't depend on a shared `Map`. Third, `localStorage` on the client, which persists across reloads and is sent back as a custom header (`x-bi-mcp-config`). Nothing else survives an instance death.

*Diagram to sketch: two Vercel instance boxes side by side with three arrows between them — cookie, URL param, custom header — and an X through anything else.*

**Q: Why not use Redis for shared state?**

Because the workload doesn't need it. One user per browser session hitting one route at a time; the concurrency ceiling per session is ~1 in-flight request. Redis is warranted when you need cross-instance shared state that has to be consistent (a rate limiter that spans all users, a cache with cross-user hit rates, a job queue). None of those apply here. The BudgetTracker is per-investigation, the rate limit is per-user (via the ALS-scoped session), and there's no job queue. Adding Redis now would be infrastructure without a workload to justify it.

*Diagram to sketch: a decision tree — "shared state needed?" → no → arrow down to the current design; yes → arrow across to Redis.*

## See also

- `02-processes-threads-and-tasks.md` — the "one JS thread per band" claim, made concrete
- `04-shared-state-races-and-synchronization.md` — the ALS pattern in detail
- `07-backpressure-bounded-work-and-cancellation.md` — how the 300s budget composes with the 30s per-call timeout
- `.aipe/study-system-design/` — the WHERE (which component owns which responsibility), complementing this file's HOW
