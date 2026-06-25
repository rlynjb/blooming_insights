# RFC-005: DataSource seam — one interface, two adapters, the receipts that earned it

**Status:** Accepted (implemented)
**Owner:** rein
**Decision:** Agents and route handlers consume backends through a single `DataSource` interface (`lib/data-source/types.ts:63-71`) — `callTool(name, args, opts?)` + `listTools(opts?)`, both returning a `{result, durationMs, fromCache}` envelope. Two adapters implement it today: `BloomreachDataSource` (OAuth + PKCE + DCR + ~1 req/s rate limit + 60s response cache, talking the real loomi connect MCP protocol) and `SyntheticDataSource` (in-process, deterministic Blooming-owned synthetic ecommerce data, zero network). The route handlers select via a `makeDataSource(mode, sessionId)` factory; the agent loop holds a `Pick<DataSource, 'callTool'>` (`McpCaller`) and cannot tell which concrete adapter is on the other side. This seam has survived two adapter swaps in production without changing one caller surface.

---

## Context

The product runs Claude-driven agent loops that read ecommerce analytics from a backend, decide what to do, and stream the reasoning back to the UI. Phase 1 was "talk to Bloomreach's loomi connect MCP server" — one backend, hand-rolled by `McpClient` in `lib/mcp/client.ts`. That worked for the live product.

Two product-shaped pressures forced the seam:

1. **The Bloomreach alpha server revokes OAuth tokens after minutes and is rate-limited to ~1 req/s.** You cannot run an eval flywheel against it. You cannot demo against it reliably. Every "let's iterate on the agent" loop hit the same wall: get fresh tokens, run one investigation, get rate-limited, wait, get re-revoked.

2. **Phase 2 (the Olist swap) deliberately tested whether the agents were generic.** The hypothesis was "if the agent prompts are general enough to talk to *any* ecommerce backend, we should be able to point them at a SQL-backed substrate (Olist's open-source ecommerce dataset) and they should keep working." The eval flywheel that built on top (4-pillar rubric, calibrated 8/8 + 3/3) surfaced three real bugs the live path had silently been carrying.

Phase 2's Olist adapter was then *removed* in PR #8 (commit 62c24d7) — the eval substrate had paid for itself, and maintaining a second backend wasn't worth its weight against a one-engineer roadmap. But what stayed was the seam. Removing the Olist adapter touched `lib/data-source/index.ts`, `mcp-server-olist/`, `eval/`, and the `'live-sql'` bi:mode branch. It did NOT touch the agent classes, the route handlers, or any production caller. That is the receipt.

The synthetic adapter (commit c75ec3e) then dropped a *third* concrete behind the same interface — 516 LOC of Blooming-owned deterministic ecommerce data (purchase / view_item / session_start / cart_update events with realistic distributions, returning AppKit-shaped EQL responses), in-process, zero network, instantly demo-able with no auth. The agents didn't notice.

Implementation: `lib/data-source/types.ts:63-71` (the interface), `lib/data-source/bloomreach-data-source.ts` (the live adapter, 214 LOC — originally `McpClient`), `lib/data-source/synthetic-data-source.ts` (the in-process adapter, 516 LOC), `lib/data-source/index.ts` (the `makeDataSource(mode, sessionId)` factory), `lib/agents/base.ts:14` (the `McpCaller = Pick<DataSource, 'callTool'>` type the agent loop consumes), `app/api/agent/route.ts:160-179` (the route's call site).

---

## Goals

- One interface every backend adapter satisfies; agents and route handlers consume that interface, never a concrete adapter.
- New adapters cost only their own file. Adding (or removing) an adapter does not touch the agent loop, the supervisor's `if`-ladder, or the streaming layer.
- The interface is *exactly* what the agents need — `callTool` + `listTools` + the `{result, durationMs, fromCache}` envelope. No speculative methods, no "what if we wanted X" surface area.
- Adapter-specific knobs (the Bloomreach 60s cache TTL, the `skipCache` flag) live on the concrete class, not on the abstract interface — only the route handlers that need them see them.
- Tests run with no network: a `Pick<DataSource, 'callTool'>` fake satisfies the agent loop's expectations.

## Non-goals

- A generic data-fetch abstraction. We are not building an ORM, not building a query-language layer, not building a "swap your backend in production" config knob. The seam exists to make adapter swaps *cheap*, not to make them runtime-selectable across all customer workloads.
- Hiding protocol differences inside the interface. The Bloomreach adapter still owns its own OAuth flow, rate-limit ladder, and cache; the Synthetic adapter owns its data generation. The interface only contracts the *shape* of a tool call, not how the call is performed.
- Multi-backend fan-out in one agent run. Each agent run reads from one backend. Cross-backend joins are out of scope.
- A pluggable third-party adapter system. The factory is exhaustive (`'live-bloomreach'` or `'live-synthetic'`); new adapters land in source, not as plugins.

---

## The decision

```
  ┌─ UI layer (app/page.tsx) ─────────────────────────────────────────┐
  │  bi:mode toggle, 3-way: 'demo' | 'live-bloomreach' | 'live-synthetic' │
  │  default 'demo' (replays committed snapshot, never reaches the seam)   │
  └──────────────────────────────────┬─────────────────────────────────┘
                                     │  ?mode=…
  ┌─ Route layer (app/api/agent/route.ts, briefing/route.ts) ────────┐
  │                                                                  │
  │  const mode = parseLiveMode(req.nextUrl.searchParams.get('mode')); │
  │  const dsResult = await makeDataSource(mode, sessionId);          │
  │  if (!dsResult.ok) return needsAuthResponse(dsResult.authUrl);    │
  │  const { dataSource, bootstrap, dispose } = dsResult;             │
  └──────────────────────────────────┬─────────────────────────────────┘
                                     │  the seam: DataSource interface
  ┌─ DataSource (lib/data-source/types.ts:63-71) ───────────────────┐
  │                                                                  │
  │  interface DataSource {                                          │
  │    callTool(name, args, opts?): Promise<{result, durationMs,    │
  │                                            fromCache}>;          │
  │    listTools(opts?): Promise<unknown>;                          │
  │  }                                                              │
  │                                                                  │
  │  Agents hold only: McpCaller = Pick<DataSource, 'callTool'>     │
  │                    (lib/agents/base.ts:14)                       │
  └────────────────┬───────────────────────────┬────────────────────┘
                   │                           │
       ┌───────────▼────────────┐  ┌───────────▼─────────────┐
       │ BloomreachDataSource   │  │ SyntheticDataSource     │
       │ (214 LOC)              │  │ (516 LOC)               │
       │ + OAuth/PKCE/DCR       │  │ + in-process generator  │
       │ + ~1 req/s rate limit  │  │ + deterministic outputs │
       │ + 60s response cache   │  │ + zero network          │
       │ + retry-after parsing  │  │ + zero auth             │
       │ + AbortSignal compose  │  │ + AppKit-shaped EQL out │
       └──────────┬─────────────┘  └─────────────────────────┘
                  │  StreamableHTTPClientTransport
       ┌──────────▼─────────────┐
       │ loomi-mcp-alpha        │
       │ .bloomreach.com/mcp    │
       └────────────────────────┘
```

The pattern: **the abstract interface is what callers see; the concrete classes own their protocol's complexity.** Classic adapter pattern. The agent loop sits behind `McpCaller` and cannot reach the Bloomreach-specific cache knobs even if it wanted to.

Three load-bearing details:

1. **The factory owns the connect handshake.** `makeDataSource(mode, sessionId)` returns `{ ok: true, dataSource, bootstrap, dispose } | { ok: false, authUrl }`. Route handlers receive a ready-to-use adapter or a redirect; they don't run OAuth themselves, don't construct adapters themselves, don't know which adapter they got beyond `dsResult.dataSource`. (`lib/data-source/index.ts:67-100`.)

2. **The interface mirrors the existing call shape exactly.** `{result, durationMs, fromCache}` is the envelope `McpClient` returned long before the seam landed. Lifting `DataSource` over the existing class was a rename + a type — zero behavior change. That's why the Bloomreach adapter is still 214 LOC and not a refactor; the shape was already right.

3. **Adapter-specific surface lives on the concrete class.** `BloomreachDataSource.callTool` accepts `{ cacheTtlMs?, skipCache?, signal? }`; the abstract `DataSourceCallOptions` is `{ signal? }` only. The four short MCP routes (`/api/mcp/{call,reset,capture,tools}/...`) that need `skipCache` import the concrete `BloomreachDataSource`; everything else sees only `DataSource`.

---

## Alternatives considered

### Alternative A: Keep `McpClient` as the only call site; agents talk to it directly

The pre-seam world. Agents import `McpClient`, the route handlers construct it, no abstraction layer.

**Why it lost:**

- The Olist swap (Phase 2) was the forcing function. Without a seam, swapping the backend meant rewriting every agent's tool-call site. That's not a "swap," that's a parallel implementation.
- Tests already needed a fake — `McpClient` was already constructed via dependency injection in every agent constructor. The fake shape (`callTool` only) was the seam; we just hadn't named it.
- The synthetic adapter's value (instant demo, no auth, deterministic) is unreachable without a seam. The `'live-synthetic'` bi:mode would have been "second copy of the agent loop pointed at fake data," not a one-line factory branch.

The honest version: pre-seam, *you could read the codebase and think the agents were generic.* The seam is the proof — once it existed and we swapped behind it twice, that hypothesis stopped being a hypothesis.

### Alternative B: A generic ORM-style abstraction

The "real database abstraction" answer. Define `Repository<T>` shapes, build per-backend repositories, let the agent compose `repo.events.find({...})`-style queries.

**Why it lost:**

- The product runs through MCP tools, not queries. The agent's vocabulary is "call this tool with these args, get a result back." An ORM would force us to translate MCP tool calls into repository methods, then translate them back at every adapter. Two translation layers where zero are needed.
- The agents are the consumers, and the agents prompt the model to emit `tool_use` blocks whose `name` and `input` map directly to MCP tool calls. Wedging an ORM between the model's output and the backend would require either translating tool calls into repository calls (a glue layer that fights the model) or leaking the repository semantics into the prompt (which defeats the abstraction).
- An ORM would invite "switch databases in production." That's not our problem. Our problem is "swap one backend for another between deploys, occasionally."

The shape we want is the adapter pattern, not the repository pattern. Different problem.

### Alternative C: Per-backend route handlers

The "don't abstract at all; have two routes" answer. `/api/agent-bloomreach` and `/api/agent-synthetic`, each with its own handler, each importing its concrete client directly.

**Why it lost:**

- Doubles the route code. Each new adapter doubles it again. The `if`-ladder supervisor (RFC-003) would have to live in N copies, one per route, with the streaming layer in N copies underneath.
- Every cross-cutting change (the schema-bootstrap-inside-stream cadence fix; the `step` query param split; phase-timing logs) lands in N places.
- The cleanest version of "per-backend route" is "one route, one factory" — which is the chosen design with extra steps.

### Alternative D: Framework-supplied tool registry (e.g., AptKit's `ToolRegistry` as the seam)

After the AptKit migration (RFC-006), a tempting move was "delete `DataSource`; let AptKit's `ToolRegistry` interface be the seam."

**Why it lost:**

- `ToolRegistry` is AptKit's primitive — it's the right interface for *AptKit* to consume tools from, not the right interface for the route layer to construct backends with. The route layer needs OAuth-handshake-aware construction, cancellation, and the `{result, durationMs, fromCache}` envelope for the UI's tool-call trace. `ToolRegistry` carries none of that.
- The DataSource seam predates the AptKit migration and survived it intact precisely because it owns a different boundary: `DataSource` is "what's the backend"; `ToolRegistry` is "what tools does the loop see." `BloomingToolRegistryAdapter` (`lib/agents/aptkit-adapters.ts:75-97`) bridges them by forwarding `tools.callTool` into `dataSource.callTool` — keeping each interface tight at its own boundary.
- Deleting our own interface in favor of a library's interface is exactly the dependency call RFC-006 talks about. The boundary stays on our side.

### Alternative E: Conditional inline branching ("if mode === 'synthetic' { … } else { … }")

The "we'll just have an if-statement" answer. No interface, no factory, just branches at each call site.

**Why it lost:**

- Every place that talks to the backend gets the if-statement. That's the agent loop, the schema bootstrap, the tools-list call, the `/api/mcp/*` short routes — at least eight call sites. Each one of them has to know about every adapter.
- The compiler stops helping. "Add a third backend" becomes "find every if-statement and add an else-if." With a typed interface, "add a third backend" is "implement DataSource, register in the factory."
- The synthetic adapter ships its own deterministic schema. Hard-coding which adapter returns which schema shape into the bootstrap call site would have *baked* the inline-branch decision into every consumer.

```
  Alternatives matrix

  option                     adapter-swap-cost  test-fake-cost  caller-coupling   chosen?
  ──────────────────────────  ──────────────────  ───────────────  ───────────────  ───────
  DataSource seam (interface) one new file        Pick<…>         none (interface) ★
  no abstraction (raw client) parallel rewrite    same as today   tight (concrete) no (rewritten Phase 2)
  ORM / Repository<T>          big translate layer high (mock all  N (per repo)     no (wrong shape)
                                                   repo methods)
  per-backend route handlers   N copies of route   N x today       N (full route)   no (multiplies code)
  framework ToolRegistry      lose construction   tied to AptKit  AptKit-shaped    no (wrong layer)
                              + envelope shape
  inline if-statements        every call site +   no help         every call site  no (compiler stops)
                              every new branch                                     helping)
```

---

## Tradeoffs accepted

We chose the typed seam, accepting:

1. **Two adapters today, no automated swap test.** Removing the Olist adapter was confirmed by hand — we read the diff and verified no caller surface moved. A "swap every adapter through every test" matrix doesn't exist. *We accept this — the interface is tight enough (two methods, one envelope shape) that drift is grep-visible.*

2. **The 60s response cache and the `skipCache` knob are Bloomreach-specific.** Callers that need them have to type as `BloomreachDataSource`, not `DataSource`. *We accept this — those four routes (`/api/mcp/{call,reset,capture,tools}/check`) are the only places we want cache control, and they're upstream of the agents anyway. Putting `cacheTtlMs?` on the abstract interface would leak a Bloomreach concern into Synthetic.*

3. **Factory result is a discriminated union (`ok: true | ok: false, authUrl`).** Route handlers must branch on `dsResult.ok`. A throwing factory would have been one less branch but lost the typed `authUrl` redirect path. *We accept the branch — the OAuth-redirect case is exactly what every route needs to handle, and forcing it into the type prevents "forgot to redirect" bugs.*

4. **The synthetic adapter ships its own static schema (`syntheticWorkspaceSchema`).** Not generated, not pulled from any "source-of-truth" file. Adding events to the synthetic data means editing the synthetic adapter. *We accept this — synthetic data is *defined* in the adapter, by construction; pulling it from elsewhere would be solving a problem we don't have.*

5. **No third-party adapter registry.** The factory is hard-coded. New adapters require a code change. *We accept this — pluggable backends invite security surface (untrusted adapter code) and complexity (lifecycle management, dependency injection) that one engineer building one product doesn't need.*

6. **The legacy `McpClient` name is gone from `lib/mcp/client.ts`.** The class is now `BloomreachDataSource` at `lib/data-source/bloomreach-data-source.ts`. Internal links and old references in study artifacts point at the old location. *We accept this — the file move was Phase 2 PR A; cross-link refreshes are a documentation hygiene cost, not an architectural concern.*

---

## Risks and mitigations

| Risk | Severity | Mitigation |
|------|----------|------------|
| New adapter forgets to honor `signal` → cancellation doesn't propagate, in-flight calls keep burning the 300s budget | Medium | Both current adapters compose `signal` through every layer (Bloomreach to fetch + transport; Synthetic ignores it because it's in-process, but documented). The interface types `signal?: AbortSignal` so the compiler reminds you. |
| Drift between the adapters' result envelopes (one returns extra fields, callers come to depend on them) | Medium | The `result: unknown` typing on the interface forces call sites to narrow at use; the schema validators in `lib/mcp/validate.ts` do the actual shape checks. New fields are open by design (`ToolResult` has `[key: string]: unknown`). |
| The `makeDataSource` factory's mode universe grows past binary, branches pile up | Low today | Two values today (`'live-bloomreach'`, `'live-synthetic'`). If it grows to 4+ branches, the factory itself becomes a candidate for splitting (one factory per adapter family). Not yet. |
| Adapter-specific knobs (cache TTL, retry behavior) leak into the abstract interface | Medium | Disciplined today: `DataSourceCallOptions` is `{signal?}`; Bloomreach's `{cacheTtlMs?, skipCache?}` lives on `BloomreachDataSource.CallToolOptions`. Reviewer-visible because both types are in the same folder. |
| Tests assume the wrong concrete (e.g., assume `fromCache` is always meaningful) | Low | Synthetic always returns `fromCache: false`; Bloomreach returns the real value. Tests that care about cache behavior import the Bloomreach adapter directly; agent tests use a `Pick<…>` fake and ignore the field. |
| The `BloomingToolRegistryAdapter` (RFC-006) holds a stale `allTools` snapshot if the backend grows new tools mid-session | Low today | `allTools` is fetched once at session start (`app/api/agent/route.ts:239-243`). Bloomreach's tool list is stable across a session; synthetic's is fully static. The day either grows dynamic tools, the adapter re-fetches per-call. |

---

## Rollout / migration

The seam landed in Phase 2 (PR A). Behavior was unchanged — the existing `McpClient` was renamed to `BloomreachDataSource`, the file moved from `lib/mcp/client.ts` to `lib/data-source/bloomreach-data-source.ts`, and the `DataSource` interface was lifted over its existing shape. Callers (agents, route handlers) were rewired to consume `DataSource` (or `Pick<DataSource, 'callTool'>`) instead of the concrete class. The Olist adapter then landed alongside it as the proof-of-life that the seam worked.

The interesting migrations after that:

- **Olist removal (PR #8, commit 62c24d7).** The Olist adapter (`lib/data-source/olist-data-source.ts`), the standalone MCP server (`mcp-server-olist/`), the eval flywheel (`eval/`), and the `'live-sql'` bi:mode branch were all deleted. Touched: the factory's switch, the mode parser, the UI's mode toggle. **Did not touch: the DataSource interface, any agent, the supervisor, the streaming layer, the route handlers' interior.** The receipt.

- **Synthetic addition (commit c75ec3e).** `lib/data-source/synthetic-data-source.ts` (516 LOC) landed as a sibling of the Bloomreach adapter. Touched: the factory's branch, the mode parser, the UI's mode toggle (added the third option). **Did not touch: the agent classes, the route handlers' interior, the supervisor, the streaming layer.** Second receipt.

- **AptKit migration (RFC-006).** The agent classes (`monitoring.ts`, `diagnostic.ts`, `recommendation.ts`, `query.ts`) moved their per-stage ReAct loop from `runAgentLoop` (now at `base-legacy.ts`) onto AptKit's runtime. The `BloomingToolRegistryAdapter` was added as a bridge from `DataSource.callTool` to AptKit's `ToolRegistry.callTool` — keeping the DataSource seam intact. **Did not touch: the DataSource interface, either concrete adapter.** Third receipt.

**If/when a third adapter lands** (e.g., a Postgres-direct adapter for a customer who can't expose MCP): implement `DataSource`, add a branch to `makeDataSource`, add a mode value to `LiveMode` and the UI toggle. ~1 file + ~3 line changes outside that file. The agents, supervisor, and streaming layer don't move.

**If we ever delete an adapter**: same story in reverse. The seam has the receipts.

---

## Open questions

1. **Should `DataSource` formalize a `dispose()` method on the interface itself?** Today it's part of the factory's return value, not the interface — because Bloomreach is session-scoped (lives in cookies) and Synthetic is in-process (nothing to dispose). The day an adapter needs per-request teardown (a SQLite connection, an opened socket), `dispose` migrates onto the interface. Not yet.

2. **Capture-and-replay across adapters.** The demo snapshot (`lib/state/demo-insights.json`) is captured from one adapter (currently Bloomreach in dev capture, or Synthetic via the dev capture path) and replayed by everyone. The replay path doesn't go through `DataSource` at all — it bypasses the seam. Should it? Probably not — the snapshot is a "this is what the UI rendered" recording, not a "this is what the backend returned" recording. But the boundary is worth naming.

3. **Per-adapter rate-limit + cache config.** Bloomreach's `~1 req/s` and `60s cache` are internal constants on `BloomreachDataSource`. Synthetic has neither. The day an adapter needs configurable spacing (e.g., per-customer rate limit), the configuration story has to land — probably via constructor options on the concrete class, not on the interface.

4. **A read-only adapter for production debugging.** Imagine `LoggingDataSource(inner: DataSource)` that wraps another adapter and writes every call to disk. The interface trivially supports this (decorator pattern). Not built yet; named so the next person who reaches for an observability hook sees the seam was designed to admit it.

5. **The synthetic adapter's data isn't shaped to test edge cases.** The data is deterministic but doesn't yet have curated scenarios (e.g., a planted anomaly the diagnostic agent should reliably find). Adding curated scenarios would turn Synthetic from "demoable" into "calibratable" — bringing back some of what the retired Phase 3 eval flywheel provided. Open.

---

## What a reviewer will push on (and the framing that holds)

> "Why not just call `BloomreachDataSource` directly? You only have one production backend."

We have one *Bloomreach* backend. We've shipped behind this seam against three adapters in production code (Olist added, Olist removed, Synthetic added) without changing a caller. Removing the seam means the next swap is a rewrite instead of a file. The cost of the seam is two methods on an interface; the cost of not having it would have been the Olist swap not being possible to do cheaply, the eval flywheel not paying for itself, and the synthetic demo path not existing.

> "Adapter pattern over a single library? That's textbook over-engineering."

If we had ONE adapter and the API was stable forever, yes. We've had three, two of them in the last six months. The over-engineering claim collapses on contact with the receipts.

> "Couldn't `ToolRegistry` from AptKit do the same job after RFC-006?"

`ToolRegistry` is what the agent loop consumes; `DataSource` is what the route layer constructs. Different boundaries. `BloomingToolRegistryAdapter` (`lib/agents/aptkit-adapters.ts:75-97`) bridges them by forwarding `tools.callTool` into `dataSource.callTool` — eight lines, one direction. Collapsing the two would force AptKit's interface to grow construction concerns (OAuth handshake, cancellation envelope, cache-hit tracking) it has no business owning.

> "The synthetic adapter is 516 LOC. That's a lot of code to maintain."

It's the price of replacing a separate MCP server we deleted. The Olist-MCP-server-plus-substrate was ~2000 LOC across a sibling project; collapsing it into one in-process file inside this repo is a 4x reduction *and* removes the cross-process complexity (subprocess management, lifecycle, transport boundary). The receipt is that the agent-facing tool contracts are *exactly* what the live adapter exposes — no special-casing in the agent prompts.

> "What if a fourth adapter has a fundamentally different shape — say it doesn't have a tool list?"

Then the interface has to grow, and that's a real RFC conversation. Today every backend we've considered exposes tool-call semantics (MCP, SQL via a tool-wrapped client, synthetic via in-process tool dispatch). A fundamentally different shape (e.g., a raw streaming backend that emits events without tool-call framing) would either need a sibling interface or an adapter that converts events to tool calls — both of those are tractable decisions when they arise.

---

## References

- `lib/data-source/types.ts:63-71` — the `DataSource` interface (the seam itself)
- `lib/data-source/types.ts:53-57` — the `{result, durationMs, fromCache}` envelope
- `lib/data-source/index.ts:67-100` — the `makeDataSource(mode, sessionId)` factory + discriminated-union result
- `lib/data-source/bloomreach-data-source.ts:1-214` — the Bloomreach adapter (originally `McpClient`)
- `lib/data-source/synthetic-data-source.ts:1-516` — the in-process synthetic adapter
- `lib/agents/base.ts:14` — `McpCaller = Pick<DataSource, 'callTool'>` (the agent-facing subset)
- `app/api/agent/route.ts:160-179` — the route's call site (factory → DataSource → agent constructors)
- `app/api/briefing/route.ts` — sibling call site (same shape)
- `lib/agents/aptkit-adapters.ts:75-97` — `BloomingToolRegistryAdapter` (bridges DataSource into AptKit's ToolRegistry; the seam-on-seam boundary)
- `app/page.tsx:73-78` — the 3-way `bi:mode` toggle (the UI surface for the factory's mode universe)
- `.aipe/rehearse-design-doc/06-aptkit-primitives-and-blooming-adapter-boundary.md` — the per-stage runtime swap, which preserved this seam intact
- `.aipe/rehearse-design-doc/03-deterministic-supervisor-not-llm-router.md` — the supervisor above this seam (which doesn't see adapters either)
- `.aipe/study-system-design/03-provider-abstraction.md` — the teaching guide on this exact pattern (originally written about `McpCaller`; the seam grew from there)
- Gamma et al., *Design Patterns* (1994) — Adapter pattern, canonical reference
