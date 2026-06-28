# Deep module — the DataSource seam

*industry name: deep module / narrow interface · type: Language-agnostic (APOSD primitive)*

---

## Zoom out, then zoom in

**Zoom out — where this pattern lives.** The data layer of the stack.

```
  Zoom out — where the DataSource seam sits in the system

  ┌─ UI layer ────────────────────────────────────────────────┐
  │  app/page.tsx + hooks (useBriefingStream, ...)            │
  └───────────────────────────┬───────────────────────────────┘
                              │  fetch /api/briefing | /api/agent
  ┌─ Route layer ─────────────▼───────────────────────────────┐
  │  app/api/briefing/route.ts                                 │
  │  app/api/agent/route.ts                                    │
  └───────────────────────────┬───────────────────────────────┘
                              │  makeDataSource(mode, sessionId)
  ┌─ Agent layer ─────────────▼───────────────────────────────┐
  │  MonitoringAgent · DiagnosticAgent · RecommendationAgent  │
  │  QueryAgent  ··· all hold a `DataSource` reference        │
  └───────────────────────────┬───────────────────────────────┘
                              │  ds.callTool(name, args, opts)
  ┌─ Data layer ── ★ THIS SEAM ★ ────────────────────────────┐
  │  lib/data-source/types.ts          73-LOC interface       │  ← you are here
  │   ├── BloomreachDataSource         214 LOC (live)         │
  │   └── SyntheticDataSource          516 LOC (deterministic)│
  └───────────────────────────┬───────────────────────────────┘
                              │
  ┌─ Provider layer ──────────▼───────────────────────────────┐
  │  Bloomreach loomi-mcp-alpha · in-process synthetic        │
  └───────────────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** A *deep module* is a small interface over a big body. The fewer decisions the caller knows about, the less complexity propagates per change. The `DataSource` interface is the smallest seam in the codebase that still lets the agent layer do useful work: two methods, one envelope. Behind it sit ~730 LOC of concrete behavior the agents never see — OAuth, rate-limit retry ladders, request spacing, response caching, signal composition for one adapter; a 30+ tool synthetic dispatcher for the other. Same caller-facing shape; wildly different bodies. That ratio — small mouth, big stomach — IS the pattern.

---

## Structure pass

The skeleton before the mechanics.

**Layers.** Three:

```
  caller layer       agents + bootstrap helpers
                     ──────────────────────────
                     hold a DataSource reference;
                     consume { result, durationMs, fromCache }

  contract layer     DataSource interface
                     ─────────────────────
                     2 methods · 4 supporting types · 73 LOC

  implementation     BloomreachDataSource · SyntheticDataSource
                     ─────────────────────────────────────────
                     214 LOC + 516 LOC · two protocols, one shape
```

**Axis — trace one question across the layers.** *Who owns the cost-of-a-tool-call decision?*

```
  layer              who decides "how long does callTool take?"
  ─────────────      ─────────────────────────────────────────
  caller layer       NOBODY decides — the caller pays the time
                     the data layer returns
  contract layer     contract is silent on cost (no SLA in types)
  implementation     EACH adapter decides:
                       Bloomreach → 60s cache + ~1 req/s spacing
                                  + 0–60s retry on rate-limit
                       Synthetic  → 0ms (in-process dispatch)
```

The axis-answer flips at the contract-to-implementation seam. That flip is what makes the seam load-bearing: two protocols with wildly different cost shapes hide behind one interface, so callers don't have to encode the cost difference in their own logic. The seam IS the contract that lets the agent layer be cost-agnostic.

**Seams.** Two horizontal seams (caller-to-contract, contract-to-impl) and one vertical seam (the two implementations are peer siblings — Bloomreach vs Synthetic). The vertical seam is the substitution test: `mode === 'live-bloomreach' ? new BloomreachDataSource(...) : new SyntheticDataSource()` and the agents don't know which.

---

## How it works

### Move 1 — the mental model

A deep module is like a function with a small signature whose body has *earned* its way to bigger. Think `JSON.stringify(value)` — one argument in (well, two), a string out; behind it: a recursive walker, cycle detection, type-tag dispatch, replacer logic, ~indent formatting. The signature stays narrow because *the body absorbs the decisions the caller would otherwise have to make.*

The DataSource interface plays the same role for ecommerce data fetching. The agent says "call this tool with these args"; the body decides whether to hit the cache, when to space the request, whether to retry on a rate-limit, when to compose a timeout signal, how to package the result.

```
  The deep module — narrow mouth, fat body

         ─── narrow interface ───
         ┌───────────────────────┐
         │  DataSource           │   2 methods · 73 LOC
         │   .callTool()         │
         │   .listTools()        │
         └───────────┬───────────┘
                     │
       ╔═════════════▼═════════════╗
       ║                           ║
       ║   ↓  big hidden body  ↓   ║   ~730 LOC of concerns
       ║                           ║   the caller never sees
       ║   • OAuth                 ║
       ║   • 1 req/s spacing       ║
       ║   • 60s cache             ║
       ║   • rate-limit retry      ║
       ║   • signal compose        ║
       ║   • typed errors          ║
       ║   • synthetic dispatch    ║
       ║   • 30+ tool fixtures     ║
       ║                           ║
       ╚═══════════════════════════╝

  the wider the gap between mouth and body,
  the less complexity propagates per change
```

The benefit: agents don't change when caching changes, when the retry ladder changes, when a new tool is added to the synthetic source, when the OAuth dance is rewritten. A change inside the body never escapes the seam.

### Move 2 — the step-by-step walkthrough

#### Move 2a — the interface (the narrow mouth)

`lib/data-source/types.ts` (73 LOC total). The whole contract fits on one screen:

```ts
  // lib/data-source/types.ts:63-71
  export interface DataSource {
    callTool(
      name: string,
      args: Record<string, unknown>,
      opts?: DataSourceCallOptions,
    ): Promise<DataSourceCallResult>;

    listTools(opts?: DataSourceListOptions): Promise<unknown>;
  }
```

**Line-by-line read of what's load-bearing:**

  - `name: string, args: Record<string, unknown>` — schemaless arg passing. The MCP server defines tool schemas at runtime (`listTools()`); typing them at the seam would couple the interface to one provider. Schemaless here is the right call.
  - `opts?: DataSourceCallOptions` — only `signal` lives in the abstract surface. Adapter-specific knobs (`cacheTtlMs`, `skipCache`) live on the concrete class (`CallToolOptions` in `bloomreach-data-source.ts:22-26`) because the agents never need them. **APOSD principle: keep the interface as narrow as the *common* caller needs; let adapters extend.**
  - `DataSourceCallResult = { result: unknown; durationMs: number; fromCache: boolean }` — the envelope every adapter returns. `result` stays `unknown` (not generic) to match `McpClient`'s return shape exactly so the rename didn't break call sites. `durationMs` and `fromCache` exist for the UI's "how this was gathered" trace.

The interface's *information hiding* trick: it mirrors the MCP `CallToolResult` shape just enough that the existing `unwrap()` helper still works, but it doesn't import from the MCP SDK. A new adapter (postgres, in-memory fixture, anything) implements this without taking on an MCP dependency.

#### Move 2b — the live body (BloomreachDataSource)

`lib/data-source/bloomreach-data-source.ts`, 214 LOC. The implementation that earns the "big stomach" label.

```
  Layers-and-hops inside BloomreachDataSource.callTool

  ┌─ caller ────────────────────────────────────────┐
  │  agent.scan() → ds.callTool(name, args)         │
  └──────────────────────┬──────────────────────────┘
                         │  hop 1: cacheKey lookup
  ┌─ cache layer ────────▼──────────────────────────┐
  │  if cached & fresh → return early               │
  │    (durationMs: 0, fromCache: true)             │
  └──────────────────────┬──────────────────────────┘
                         │  hop 2: cache miss → liveCall
  ┌─ rate-limit layer ───▼──────────────────────────┐
  │  await spacing (minIntervalMs since last call)  │
  │  call transport                                 │
  │  if isRateLimited(result):                      │
  │    parseRetryAfterMs(result) or backoff         │
  │    sleep(min(wait, retryCeilingMs))             │
  │    retry up to maxRetries                       │
  └──────────────────────┬──────────────────────────┘
                         │  hop 3: result back
  ┌─ envelope layer ─────▼──────────────────────────┐
  │  if isError → return uncached                   │
  │  else cache + return                            │
  │    { result, durationMs, fromCache: false }     │
  └─────────────────────────────────────────────────┘
```

The four concerns (cache, spacing, retry, envelope) live as named sections inside one ~50-LOC `callTool` body — read it once and the whole shape is visible. The caller's mental model stays: "call a tool, get an envelope back."

**The load-bearing bits of internal grammar:**

  - `parseRetryAfterMs` (`:64-71`) — knows the two error-text shapes the live Bloomreach server emits. **Strong hide.** A change in the Bloomreach error format edits ONE function.
  - `RETRY_BUFFER_MS = 500` (`:49`) — the cushion added on top of the parsed window so the retry lands *just after* the penalty clears. Documented inline. A caller never knows this exists.
  - `McpToolError` (`:101-110`) — a typed error tagged with the tool name + the underlying server detail. Routes catch this and surface "which tool failed and why" without inventing a wrapper themselves.

#### Move 2c — the synthetic body (SyntheticDataSource)

`lib/data-source/synthetic-data-source.ts`, 516 LOC. The same interface; a wildly different body.

The body is a single `dispatch(name, args)` `switch` with 30+ cases, each returning a deterministic fixture wrapped in the standard envelope (`structuredContent` + `content[0].text`). Three things the synthetic body deliberately mirrors from the live one:

  - **Envelope shape (`ok` helper, `:498-503`).** Returns the same `{ structuredContent, content }` shape Bloomreach returns, so the upstream `unwrap()` helper works identically.
  - **Error shape (`errorResult` helper, `:505-512`).** Returns `{ isError: true, structuredContent, content }` for unknown tools so AptKit's loop threads the error back to the model the same way it would for a real failure.
  - **Result envelope (`{ result, durationMs, fromCache: false }`).** Same shape as `BloomreachDataSource` — `durationMs` is real (0–few ms for in-process work); `fromCache` is always false (no cache for deterministic data).

The substitution test passes: a route handler reads `mode` once at construction time, hands the resulting `DataSource` to the agent, and the agent works unchanged regardless of which body it got.

```ts
  // lib/data-source/index.ts:67-100
  export async function makeDataSource(
    mode: LiveMode,
    sessionId: string,
  ): Promise<MakeDataSourceResult> {
    if (mode === 'live-synthetic') {
      const dataSource = new SyntheticDataSource();
      return { ok: true, mode, dataSource, bootstrap: ..., dispose: ... };
    }
    // live-bloomreach — defer to connectMcp, returns BloomreachDataSource
    ...
  }
```

The factory's return type is `DataSource`, not the concrete class. **Callers see only the interface.**

### Move 2 variant — the load-bearing skeleton

The kernel: **(1) one method (`callTool`)** + **(2) one envelope (`{ result, durationMs, fromCache }`)** + **(3) a factory that returns the abstract type**.

What breaks when each part is missing:

  - **Drop the abstract envelope, return raw adapter results** — every caller now has to know which adapter it has, because the shapes differ. The substitution test breaks; the agents leak knowledge of the provider.
  - **Drop the factory, construct adapters at call sites** — every route handler now has to know `connectMcp` + the synthetic constructor signature. Adding a third adapter changes every call site.
  - **Drop the interface, type the parameter as the concrete `BloomreachDataSource`** — the synthetic adapter no longer satisfies the type. Same outcome: agents leak provider knowledge.

The kernel is the contract + the factory + the envelope — together they make substitution work. Everything else (caching, retry, AbortSignal composition, 30+ synthetic tool cases) is the body. Big bodies are fine. Wide mouths are the bug.

### Move 3 — the principle

> **A module's worth is functionality ÷ interface size.**
>
> Maximize the numerator; minimize the denominator. The agents should ask the smallest possible question and get the broadest possible answer. The narrow interface is the protection — it's what keeps a change inside the body from escaping. When the interface fits on one screen and the body fills a directory, the module is doing its job.

---

## Primary diagram

The whole pattern in one frame.

```
  The deep module — recap with all four layers labelled

  ┌─ caller layer (agents + bootstrap) ────────────────────────────┐
  │  await dataSource.callTool('execute_analytics_eql', { eql });  │
  └──────────────────────────┬─────────────────────────────────────┘
                             │  envelope: { result, durationMs, fromCache }
                             │  the caller never sees:
                             │    cache hits / spacing / retries /
                             │    OAuth / signal composition /
                             │    synthetic dispatch / fixture data
  ┌─ contract layer (the seam) ────────────────────────────────────┐
  │  DataSource                                                    │
  │    .callTool(name, args, opts?) → DataSourceCallResult         │
  │    .listTools(opts?) → unknown                                 │
  │                                  ← 73 LOC, 2 methods           │
  └──────────────────────────┬─────────────────────────────────────┘
                             │  one of two implementations is wired
                             │  by makeDataSource(mode, sessionId)
  ┌─ implementation layer ───▼─────────────────────────────────────┐
  │  ┌─ BloomreachDataSource ──────┐ ┌─ SyntheticDataSource ─────┐│
  │  │  214 LOC — live MCP         │ │  516 LOC — fixtures        ││
  │  │  • OAuth via auth.ts        │ │  • dispatch(name, args)    ││
  │  │  • ~1 req/s spacing         │ │    switch over 30+ tools   ││
  │  │  • 60s response cache       │ │  • deterministic data       ││
  │  │  • rate-limit retry ladder  │ │  • same envelope shape     ││
  │  │  • parseRetryAfterMs        │ │  • same isError shape      ││
  │  │  • McpToolError             │ │                            ││
  │  │  • composeSignals           │ │                            ││
  │  └─────────────────────────────┘ └────────────────────────────┘│
  └─────────────────────────┬──────────────────────────────────────┘
                            │  Bloomreach branch only
  ┌─ provider layer ────────▼──────────────────────────────────────┐
  │  loomi-mcp-alpha · OAuth + PKCE + DCR · HTTP                   │
  └────────────────────────────────────────────────────────────────┘

  ratio: 730 LOC body ÷ 73 LOC interface ≈ 10:1
  every concern below the seam can change WITHOUT touching the agents
```

---

## Elaborate

**Where this primitive comes from.** Parnas's "information hiding" (1972) is the ancestor; Liskov's substitution principle is the formal contract test. Ousterhout in *A Philosophy of Software Design* (Ch. 4–5) folds the two into one usable rule: design interfaces by what the *common* caller needs; let everything else live in the body. The book's two clearest examples are `JSON.stringify` and a file-system VFS — both are small mouths over enormous bodies.

**What's adjacent in this codebase.**

  - The AptKit adapter bridge (`02-information-hiding-aptkit-bridge.md`) is the same lesson at a different scale — three small adapter classes hiding AptKit's generic primitive interfaces from the four agent classes.
  - The `readNdjson` kernel (`03-pulled-complexity-down-readndjson.md`) is the OUTPUT-side dual: one body, many callers, but at a single-function scale rather than a whole class.

**What to read next.** `.aipe/read-aposd/part-2/03-deep-modules.md` is the book chapter this pattern most directly anchors to.

---

## Interview defense

**Q1: What is a deep module and where in this codebase do you have one?**

The clearest one is the `DataSource` interface at `lib/data-source/types.ts` — 73 lines, two methods. Behind it sit two adapters: `BloomreachDataSource` (214 LOC, owns OAuth, rate-limit retry, 60s caching, signal composition) and `SyntheticDataSource` (516 LOC, owns a 30+ tool deterministic dispatcher). About a 10:1 ratio of body to interface. The agent layer holds a `DataSource` reference and never knows which adapter it has — that's what makes the seam load-bearing.

```
  ┌─ interface (73 LOC) ─┐
  │   callTool /         │
  │   listTools          │
  └──────────┬───────────┘
             │
  ┌──────────▼──────────────────┐
  │   ~730 LOC of hidden body   │
  │   (OAuth + cache + retry +  │
  │    spacing + signal compose │
  │    + 30+ synthetic tools)   │
  └─────────────────────────────┘
```

Anchor: `lib/data-source/types.ts`.

**Q2: What's the load-bearing part of the design — the part that breaks if you remove it?**

The envelope. `{ result, durationMs, fromCache }`. Drop it — let each adapter return whatever shape it wants — and the substitution test breaks. The agents would have to switch on adapter type to know how to read the response, and the whole point of the seam evaporates. The two-method interface, the factory, and the envelope all matter, but the envelope is the one that's easy to forget because it looks like a data shape rather than a design decision.

```
  the kernel
  ──────────
  small interface  +  uniform envelope  +  factory returning the abstract type
  drop ANY of the three → the substitution test breaks
```

Anchor: `lib/data-source/types.ts:53-57` (the `DataSourceCallResult` shape).

**Q3: Why did you not put `cacheTtlMs` and `skipCache` on the abstract interface?**

Because the agent layer — the *common* caller — doesn't need them. APOSD's rule is to make the interface as narrow as the common caller requires; let adapters extend their own concrete option shape for the uncommon caller. The cache controls only matter to `/api/mcp/call` (the debug panel) and `/api/mcp/capture` (the demo capture flow), which construct `BloomreachDataSource` directly and pass `CallToolOptions`. The 4+ agents that go through the seam never set TTL.

```
  abstract DataSourceCallOptions   →   { signal? }
                                       common caller's full need

  concrete CallToolOptions         →   { signal?, cacheTtlMs?, skipCache? }
                                       extends for the 2 uncommon callers
```

Anchor: `lib/data-source/types.ts:39-41` and `lib/data-source/bloomreach-data-source.ts:22-26`.

**Q4: Walk me through the substitution test.**

`makeDataSource(mode, sessionId)` in `lib/data-source/index.ts` returns `Promise<MakeDataSourceResult>` where the success shape is `{ ok: true, mode, dataSource: DataSource, bootstrap, dispose }`. The route handler reads `mode` once, calls the factory, and hands `dataSource` (typed as `DataSource`, not the concrete class) to the agent constructor. The four agent classes take `dataSource: McpCaller`, which is `Pick<DataSource, 'callTool'>` — an even narrower view of the interface. Switch `mode` from `'live-bloomreach'` to `'live-synthetic'`, hit the same route, and the agent runs unchanged against deterministic fake data. That's the seam earning its keep.

Anchor: `lib/data-source/index.ts:67-100` (the factory) and `lib/agents/base.ts:14` (the `McpCaller = Pick<DataSource, 'callTool'>` narrowing).

---

## See also

  → `02-information-hiding-aptkit-bridge.md` — same APOSD lesson at a different scale.
  → `03-pulled-complexity-down-readndjson.md` — the streaming dual: one body, many callers.
  → `audit.md` Lens 2 (deep-vs-shallow-modules) and Lens 3 (information-hiding-and-leakage).
  → `.aipe/read-aposd/part-2/03-deep-modules.md` — the book chapter on deep modules.
  → `.aipe/read-aposd/part-2/04-information-hiding.md` — the book chapter on the hiding rule.
