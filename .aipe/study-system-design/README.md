# Study — System Design (applied)

The system-design guide for **blooming insights** — a Next.js 16 SPA that
runs a multi-agent AI analyst against an MCP server (Bloomreach is the
default preset), streams the reasoning to the browser as NDJSON, and now
lets a visitor swap in their own MCP server + auth strategy from the UI.

This is a per-repo study. The lens inventory in `audit.md` is walked
against the code that's actually here. The pattern files in `01-…` to
`08-…` name only patterns the repo actually exercises — the file list
itself is a teaching artifact.

## Reading order

1. **`00-overview.md`** — one-page orientation: full-system ASCII
   diagram + legend. Skim this and you have the whole map.
2. **`audit.md`** — the 8-lens audit, Pass 1. Every lens named,
   every finding grounded in `file:line`.
3. **Pattern files, in order:**

   1. `01-request-flow.md` — browser → route → agents →
      DataSource, with the per-request MCP config header decode step.
   2. `02-auth-boundary-and-swappable-mcp.md` — three
      `OAuthClientProvider` implementations (Bloomreach OAuth /
      bearer / anonymous), the precedence chain, the trust
      boundary at the MCP URL.
   3. `03-provider-abstraction-and-datasource-seam.md` — the port
      (`DataSource`), the 5 uses receipt, why the abstraction has
      shipped without a caller-surface change.
   4. `04-aptkit-agent-primitive-boundary.md` — where in-house
      Blooming code stops and the AptKit primitive begins; the
      three bridging adapters; how the budget ceiling and
      capability trace ride this seam.
   5. `05-streaming-ndjson.md` — one kernel, four consumers, one
      producer contract (`AgentEvent`).
   6. `06-per-request-config-transport.md` — the UI settings modal
      → localStorage → base64 header → route decode → env fallback
      transport.
   7. `07-demo-replay-as-reliability.md` — the committed snapshot
      path, now hidden from the UI toggle but still functional as
      the presentation-reliability escape hatch and the regression
      baseline.
   8. `08-schema-gated-coverage.md` — how the monitoring agent
      refuses to spend EQL budget on categories the workspace
      doesn't support.

## Cross-links to neighboring foundation guides

- `study-database-systems` — storage-engine internals (transactions,
  indexes, MVCC). This repo has no database engine of its own; state
  lives in in-memory maps + `sessionStorage` + localStorage + committed
  JSON. `study-database-systems` may still be worth reading for the
  vocabulary; it doesn't exercise this repo.
- `study-data-modeling` — the *shape* of `Insight` / `Anomaly` /
  `Diagnosis` / `Recommendation` and the `AgentEvent` NDJSON
  discriminated union.
- `study-distributed-systems` — coordination-under-partial-failure
  vocabulary (retries, idempotency, rate limits). The Bloomreach
  rate-limit retry ladder and the OAuth session cookie flow live at
  that seam.
- `study-runtime-systems` — Next.js 16 App Router execution model,
  the `AsyncLocalStorage` cookie plumbing, `ReadableStream` back-
  pressure, `AbortSignal` propagation.
- `study-networking` — HTTP semantics (streaming responses, chunked
  transfer, `x-forwarded-host` at Vercel's edge), the OAuth 2.1 +
  PKCE + DCR flow the Bloomreach preset uses.
- `study-software-design` — pattern vocabulary (port, adapter,
  client, seam, factory, dependency injection, decorator). The
  DataSource seam and the AuthProvider factory pattern both live at
  that altitude.
- `study-agent-architecture` — the ReAct-style agent loop, tool
  registries, budget threading — those internals now live inside
  `@aptkit/core@0.3.0`, bridged into this repo through the three
  adapters in `lib/agents/aptkit-adapters.ts`.

## The load-bearing finding

The **DataSource seam has now shipped in FIVE uses without a caller-
facing interface change:**

1. Olist adapter added (Phase 2 exploration)
2. Olist adapter removed (PR #8)
3. `SyntheticDataSource` added
4. `FaultInjectingDataSource` decorator (Week 4B offline chaos)
5. **`McpDataSource` + `AuthProvider` generalization (Session B)** —
   Bloomreach reduced from baked-in default to one preset among many;
   user-visible config now picks any MCP server

Five different pressures on the same boundary, and the agents +
route handlers never noticed. That's the senior-signal receipt for
the port (`DataSource`) pattern in this repo. See
`03-provider-abstraction-and-datasource-seam.md`.
