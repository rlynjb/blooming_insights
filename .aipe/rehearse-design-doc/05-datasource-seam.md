# RFC-05 — DataSource seam + adapter pattern

**Decision in one line:** Every agent depends on a `DataSource` port at `lib/data-source/types.ts` — never on the concrete Bloomreach MCP client. Three adapters have shipped through the seam without changing a caller's surface: the receipt is real, not aspirational.

---

## Context

The first version of the agent loop imported `McpClient` directly. Every agent knew about MCP tools, MCP result envelopes, the `structuredContent` vs `content[0].text` unwrap dance, the ~1 req/s rate limit, and the fact that the transport was HTTPS+SSE against `loomi-mcp-alpha.bloomreach.com`. That was fine for one backend.

Then three pressures arrived at once:

1. **Evals.** The regression gate (RFC-10) needs to run against reproducible data. Live Bloomreach queries are non-deterministic (customer counts drift), rate-limited (~1 req/s), and cost money per run. Testing the agents against real MCP made eval runs expensive AND flaky.

2. **A brief Olist experiment.** For a stretch of a few days, an alternate SQL-backed dataset (Olist) was wired in behind the agents to check whether the design generalized beyond Bloomreach's event model. Added, then removed.

3. **Fault injection.** The tier-2 story ("what happens under real-world faults?") needed a way to force timeouts, 429s, and 500s deterministically. Real Bloomreach doesn't emit these on command.

A "just mock MCP" approach doesn't compose. The rate limit lives in the transport, the retry ladder lives in the client, the unwrap lives in the schema helper. Mocking any one of them leaks the concrete transport into the test. What was needed was a port — one interface the agents talk to, one that the eval harness could bind to a synthetic backend and the fault harness could bind to a decorator.

---

## Decision

Define the smallest port the agents actually use. Everything else stays on the concrete adapters.

```
The port — the abstract surface every backend must implement

  ┌─ DataSource (interface) ─────────────────────────────────────────┐
  │  callTool(name, args, opts?)                                     │
  │    → Promise<{ result, durationMs, fromCache }>                  │
  │  listTools(opts?)                                                │
  │    → Promise<unknown>                                            │
  └──────────────────────────────────────────────────────────────────┘

  ┌─ what the port canonicalizes ────────────────────────────────────┐
  │  · the {result, durationMs, fromCache} envelope from McpClient    │
  │  · MCP-shaped ToolResult with isError + content[] passthrough     │
  │  · signal-based cancellation                                      │
  └──────────────────────────────────────────────────────────────────┘

  ┌─ what stays on the concrete adapter ─────────────────────────────┐
  │  Bloomreach's rate limit, retry ladder, cache, auth, MCP transport│
  │  Synthetic's fixture loading, seeded RNG                          │
  │  FaultInjecting's PRNG, per-call roll                             │
  └──────────────────────────────────────────────────────────────────┘
```

Three adapters live behind the port today:

- `BloomreachDataSource` — real MCP over the loomi connect server. Rate-limited (~1 req/s), retry ladder, per-call cache, encrypted-cookie auth.
- `SyntheticDataSource` — offline fixture-backed adapter for evals. Deterministic, no network, no LLM.
- `FaultInjectingDataSource` — decorator that wraps any of the above and forces failures per configurable rates (RFC-08).

Agents (monitoring, diagnostic, recommendation, query) hold a `DataSource` reference and never look at the concrete class. The AptKit tool-registry adapter (`BloomingToolRegistryAdapter`, RFC-06) calls `dataSource.callTool` — that's the whole coupling.

---

## Alternatives considered

**(a) Mock the MCP client directly.** Keep the concrete import; use a test-time subclass with overridden `callTool`. Loses at the second adapter — as soon as Olist showed up, "just subclass McpClient" was already wrong, because Olist wasn't an MCP client. The class hierarchy was the wrong axis; the seam belongs at the tool-call level, not the transport level.

**(b) One adapter per environment, chosen by env var.** `if (process.env.DATA_SOURCE === 'synthetic') { … } else { … }` at every call site. Loses on the fault-injection use case — that adapter isn't an alternative to Bloomreach, it's a decorator around it. Env-based selection can't express "wrap the real one." The interface makes composition free; env-var branching does not.

**(c) A wider port that exposes cache + rate-limit hints.** Include `skipCache`, `cacheTtlMs`, `bypassRateLimit` in the abstract surface. Loses because most adapters don't have those concepts — synthetic has no cache to skip, fault-injecting has no rate limit to bypass. Widening the port forces every adapter to stub methods it doesn't need. The port is deliberately narrow: `callTool` + `listTools` + an optional `signal`. Adapter-specific options live on the concrete classes; agents never reach for them.

---

## Consequences

**What this buys — and this is the receipt, not a claim:**

The seam has shipped through **four uses** without changing an agent's surface:

1. Olist adapter added
2. Olist adapter removed
3. Synthetic adapter added (evals)
4. FaultInjecting decorator added (fault tests)

Each of those was a `new SomethingDataSource(...)` at the composition root and zero changes to the agents. That's what a healthy seam looks like — the callers don't know a swap happened.

Beyond the swap-count receipt:

- **Evals are reproducible and cheap.** Running the 10-case baseline against `SyntheticDataSource` finishes in seconds without touching Bloomreach.
- **Fault injection is a real receipt, not a mock.** The FaultInjecting decorator wraps the same DataSource the agents use in production. Fault behavior surfaces through the exact code path a real 429 would take.
- **Adapter internals stay private.** `BloomreachDataSource` can add a new caching tier or change its retry ladder without any agent noticing.

**What it costs:**
- **The port has to stay narrow.** Every new agent capability is pressure to widen it. So far the discipline has held (four adapters, one interface), but each new "just add this hint to DataSource" request needs to be resisted or the seam decays into a leaky abstraction.
- **Two envelopes to keep aligned.** MCP's `ToolResult` shape and the port's `DataSourceCallResult` envelope are separate types. When MCP adds a field the agents care about, both types need updating. Documented in `types.ts` — `structuredContent` is passed through as an open key so the unwrap helper keeps working.

**What the reviewer will push on:**
> "Why is this a port and not just a function? You've made a class hierarchy."

The framing: the port is one interface with two methods. It's not a class hierarchy — it's a shape contract. The three concrete adapters have wildly different internals (network, fixtures, PRNG) and share exactly what the agents need to see. A bare function couldn't express "the same shape can be decorated" — the FaultInjecting adapter wraps another DataSource; it needs the interface to be the noun. The interface earns its weight the moment the decorator ships.

---

## Open questions

- **Streaming tool results.** MCP is starting to support streaming tool outputs. The current port assumes `callTool` returns one envelope. When streaming tools land, we either widen the port (breaking the narrow-surface discipline) or add a second method (`streamTool`?). Deferred until the first tool the agents actually want to stream shows up.
- **A LangChain-style tool interface for portability.** If the agents ever want to reach for tools that live outside DataSource (e.g. a native Vercel function that isn't behind MCP), the current port assumes MCP-shaped tool defs. Not a real constraint today; noted so we don't paint into a corner.
