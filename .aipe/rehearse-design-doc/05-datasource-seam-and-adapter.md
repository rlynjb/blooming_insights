# RFC 05 — DataSource port + adapter pattern

**One-line summary.** The agents depend on a port (`DataSource` at `lib/data-source/types.ts`) — not on the MCP client — and two adapters (`BloomreachDataSource`, `SyntheticDataSource`) sit behind it; a factory (`makeDataSource`) selects one per request based on `bi:mode`. The seam survived two adapter swaps without changing the caller surface.

---

## Context

Early in the build, the agents called the MCP client directly — `mcp.callTool('execute_analytics_eql', { ... })`. That worked for a single data source (Bloomreach via the loomi connect MCP server), but it pinned three things together that didn't belong together:

- **The agent's logic** (what to ask)
- **The transport's protocol** (MCP over HTTP with PKCE OAuth)
- **The data's substrate** (Bloomreach Engagement's EQL)

Two real pressures made the coupling expensive:

1. **The alpha MCP server was unreliable during development.** Token revocation, rate limits, occasional connection failures. Building and testing the agents against the live server was slow and brittle. A local data source — even a fake one — would un-block test-driven work.
2. **A second adapter was attempted.** An Olist-substrate adapter (SQL-backed, ecommerce fixtures) was built behind this seam to validate that the agents really were substrate-agnostic. It was used to calibrate the eval flywheel (8/8 + 3/3), caught three real bugs (notably the BRL cents-vs-Reais run, R$131,965; calibration at 29/30; instability around 30%), and was then *removed* once the calibration evidence was banked. The adapter swap was real — and the agent code didn't move.

A third pressure made the pattern earn its place: a synthetic adapter (`SyntheticDataSource`) was added later to support a third mode (`live-synthetic`) for demos that can't depend on Bloomreach being healthy. Adding it touched the factory and the new file — no agent, no route handler had to know.

---

## Decision

**A port-and-adapters layout, with a factory keyed on `bi:mode`:**

```
  The DataSource seam — one port, two adapters, one factory

  ┌─ Caller side (substrate-agnostic) ───────────────────┐
  │                                                       │
  │  MonitoringAgent       ─┐                             │
  │  DiagnosticAgent       ─┤                             │
  │  RecommendationAgent   ─┤── all hold a DataSource    │
  │  QueryAgent            ─┘   (never the concrete       │
  │                              adapter)                  │
  │                                                       │
  │  bootstrapSchema(ds)   ─── reads schema via the port  │
  │                                                       │
  └─────────────────────────┬─────────────────────────────┘
                            │  depends on the port,
                            │  not the adapter
                            ▼
  ┌─ The port: lib/data-source/types.ts ─────────────────┐
  │                                                       │
  │  interface DataSource {                               │
  │    callTool(name, args, opts?):                       │
  │      Promise<{ result, durationMs, fromCache }>       │
  │    listTools(opts?): Promise<unknown>                 │
  │  }                                                    │
  │                                                       │
  │  (envelope mirrors McpClient's exact return shape     │
  │   so the rename didn't change behavior)               │
  │                                                       │
  └─────────────────────────┬─────────────────────────────┘
                            │  factory selects per request:
                            │  parseLiveMode(?mode=) → LiveMode
                            ▼
       ┌────────────────────┴────────────────────┐
       ▼                                         ▼
  ┌─ BloomreachDataSource ──────┐   ┌─ SyntheticDataSource ───────┐
  │  lib/data-source/            │   │  lib/data-source/            │
  │    bloomreach-data-source.ts │   │    synthetic-data-source.ts  │
  │                              │   │                              │
  │  wraps McpClient over the    │   │  in-process deterministic    │
  │  loomi connect server        │   │  fake ecommerce data         │
  │  OAuth PKCE + ~1 req/s rate  │   │  no network, no auth,        │
  │  limit + cache + retry       │   │  instant                     │
  └──────────────────────────────┘   └──────────────────────────────┘
```

**The port (`DataSource`)** is the abstract surface — two methods, `callTool` and `listTools`, both async, both returning a transport-neutral envelope. The envelope `{ result, durationMs, fromCache }` mirrors `McpClient`'s return shape exactly, because the original rename from "MCP client" to "data source" had to be behavior-preserving.

**`BloomreachDataSource`** wraps the McpClient (which wraps the MCP SDK transport, which wraps the OAuth-authenticated HTTP connection to `https://loomi-mcp-alpha.bloomreach.com/mcp`). All the production complexity — token refresh, rate limiting, per-call 30s timeout, cache, retry — lives in this adapter. The agents never see any of it.

**`SyntheticDataSource`** is a 516-LOC pure-data file. No network. No async beyond the function signatures. It synthesizes plausible Bloomreach-shaped responses to the same tool calls (`execute_analytics_eql`, `get_event_schema`, etc.) using deterministic fixtures. Used for `bi:mode = live-synthetic` — a demo that runs the real agent loop, the real Claude model calls, but never touches Bloomreach.

**`makeDataSource(mode, sessionId)`** is the factory at `lib/data-source/index.ts:60`. The route handler reads `bi:mode` from the request, calls `parseLiveMode` to narrow it to `'live-bloomreach' | 'live-synthetic'`, and calls the factory. Demo mode never reaches the factory — it short-circuits to the committed JSON snapshot (RFC 01).

---

## The seam survived two adapter swaps — the receipt

This is the load-bearing claim. Two real changes happened behind this port without the agents or the route handlers needing to know:

```
  Adapter swap log — what changed, what didn't

  ┌────────────────────────────────────────────────────────┐
  │ Swap 1: OlistDataSource added                          │
  │   purpose: SQL-backed Olist ecommerce fixtures for     │
  │            agent calibration + eval flywheel           │
  │   files touched: + olist-data-source.ts (new)          │
  │                  + factory branch                       │
  │                  + 'live-sql' added to LiveMode union  │
  │   files NOT touched: agents/*, app/api/*, components/  │
  │   evidence banked: 8/8 + 3/3 calibration; 3 bugs       │
  │                    caught (BRL R$131,965, calibration  │
  │                    29/30, instability 30%)             │
  ├────────────────────────────────────────────────────────┤
  │ Swap 2: OlistDataSource removed                        │
  │   purpose: calibration done; substrate no longer       │
  │            earning its file weight; Synthetic took its │
  │            place                                       │
  │   files touched: − olist-data-source.ts                │
  │                  − 'live-sql' branch                   │
  │                  − fixtures + olist-specific tests     │
  │   files NOT touched: agents/*, app/api/*, components/  │
  │   evidence: types.ts header still references the swap  │
  │             ("an Olist (SQL-backed) adapter previously │
  │             lived behind this seam and was removed")   │
  ├────────────────────────────────────────────────────────┤
  │ Swap 3: SyntheticDataSource added                      │
  │   purpose: instant demo path that runs the REAL agent  │
  │            loop without Bloomreach being healthy       │
  │   files touched: + synthetic-data-source.ts            │
  │                  + 'live-synthetic' branch in factory  │
  │                  + 'live-synthetic' added to LiveMode  │
  │   files NOT touched: agents/*, app/api/*, components/  │
  └────────────────────────────────────────────────────────┘
```

Three adapter changes, zero changes to caller surface. That's the shipped receipt — not a claim, a git-grep-able fact. The `types.ts` header comment is the in-source artifact: "Currently `BloomreachDataSource` is the only implementation — an Olist (SQL-backed) adapter previously lived behind this seam and was removed."

---

## Alternatives considered

### No port — agents call the MCP client directly

The shape the codebase started with. The agent constructs an `McpClient` (or receives one) and calls `mcp.callTool(...)`.

**Why it lost.** The Olist experiment was blocked under this shape — every agent would have had to grow a "which backend am I talking to?" branch, or the agents would have had to be duplicated. Tests against fake data would either mock the MCP client (leaks the protocol) or stand up an MCP-protocol fake (high effort, low value). The port-and-adapters move was the single change that unblocked the calibration work.

### A factory but no port (concrete types, structural typing)

Two concrete classes, `BloomreachDataSource` and `SyntheticDataSource`, structurally compatible. The factory returns `BloomreachDataSource | SyntheticDataSource`.

**Why it lost.** Structural typing works until it doesn't. The moment one adapter adds an adapter-specific option (`BloomreachDataSource` has `skipCache`, `cacheTtlMs`), the union breaks down — callers either branch or downcast. The named port draws the line: anything in `DataSource` is for *every* adapter; anything else stays on the concrete class and the agents never see it.

### Dependency injection container (InversifyJS / tsyringe)

Bind the port to the adapter in a container, inject into agents.

**Why it lost.** Overshoot for two adapters and one factory. The container's value (lifetime management, complex graphs) doesn't pay rent at this scale. Constructor-passing the `DataSource` into each agent is two extra lines per route handler and zero magic — and that pattern survives a future container if one's ever warranted.

---

## Consequences

**What this cost — owned, not apologized for:**

- **Adapter-specific features have to break the port or stay hidden.** `BloomreachDataSource` has cache controls the synthetic adapter doesn't have. Today they're class-only and callers don't see them; if an agent ever needs them, the port grows or the agent downcasts. Either is a real decision moment.
- **The port's envelope shape (`{ result, durationMs, fromCache }`) is McpClient-flavored.** `fromCache: false` from the synthetic adapter is a lie of convenience — there is no cache in the synthetic adapter. It returns false to satisfy the type. A different adapter family (one with a meaningful cache model) might want a richer shape. Today the envelope earns its keep by mirroring `McpClient` exactly; if a third adapter pulls in a different direction, the envelope is the seam to renegotiate.
- **The factory branches by string mode.** `parseLiveMode` defaults unknown values to `'live-bloomreach'` (one of two acceptable defaults). String-keyed factory branches are simple and obvious until you have ten of them; at that point a registry pattern starts to earn its place. With two modes, the `if/else` is the right shape.

**What this bought:**

- **Two substrate swaps without breakage.** The Olist add and remove + the Synthetic add are three substrate changes that touched only the adapter file + the factory branch. Agents, route handlers, components — untouched. That's the shipped receipt.
- **Tests stop fighting the network.** Agent tests construct an in-memory fake (often a hand-rolled `DataSource` per test, not the full `SyntheticDataSource`) and exercise the agent's tool-use loop directly. The 24-file / 221-test suite never opens a socket.
- **The eval flywheel had something to chew on.** Olist-substrate evals caught three real bugs (BRL cents-vs-Reais; calibration drift; 30% instability). That eval work depended on having a non-Bloomreach substrate to compare against; the port made it possible. The Olist adapter is gone; the bugs it caught stayed fixed; the next version of the evals will run against `SyntheticDataSource`.
- **The mode selector (`bi:mode`) is honest about what it does.** `demo` short-circuits the factory (RFC 01's snapshot path). `live-bloomreach` and `live-synthetic` are both "real agent run, different backend." The user sees this distinction in the UI; the factory enforces it in code.

---

## Open Questions

- **Does the port need a richer error model?** Today both adapters throw on failure and the route handler catches generically. An adapter-specific error type (`DataSourceTimeoutError`, `DataSourceAuthError`) would let the route handler do smarter recovery (auto-reconnect on auth, surface timeout differently). Cheap to add when the next adapter forces the conversation.
- **Should the synthetic adapter expose a "make this anomaly happen" testing API?** Today its data is static — same anomalies every run. For end-to-end testing of the *UI's* anomaly handling (vs the agents'), a "seed this synthetic adapter to emit X" surface would help. Out of scope for the current product; a future test harness might want it.
- **When does a third adapter become real (not theoretical)?** The pattern earns its keep with two. A real third — say, a BigQuery-backed adapter for a different deployment — would be the test of whether the port is truly substrate-agnostic or quietly Bloomreach-shaped. Today the port is shaped by what the agents need; a third adapter would either fit or reveal a leak. No plan to add one; mentioned because "the pattern is fine until N+1" is always the live question.
