# Study — system design

This guide takes the **current blooming insights repo** and walks its architecture in two passes:

- **Pass 1 — `audit.md`.** One section per lens in the 8-lens inventory (system-map-and-boundaries, request-response-and-data-flow, state-ownership-and-source-of-truth, caching-and-invalidation, storage-choice-and-durability-boundaries, failure-handling-and-reliability, scale-bottlenecks-and-evolution, system-design-red-flags-audit). Verdict-first, ranked findings, every claim grounded in a `file:line` reference. Cross-links to each pattern file when a finding warrants the deeper walk.
- **Pass 2 — 10 discovered-pattern files.** Named after the architectural patterns this codebase actually exercises (request flow, OAuth boundary, provider abstraction, caching+rate-limiting, streaming NDJSON, multi-agent orchestration, client stream handoff, schema-gated coverage, AptKit primitive adapters, synthetic data source). Two earlier files (`09-eval-pipeline.md`, `10-authored-mcp-server.md`) are kept as RETIRED historical artifacts — their subjects (the eval suite, the Olist MCP server) were removed from the codebase in PR #8 (2026-06-18). Each active file uses the full per-concept template — Zoom out → Structure pass → How it works (pattern + repo code side-by-side) → Primary diagram → Elaborate → Interview defense → See also.

## Reading order

1. **[00-overview.md](./00-overview.md)** — the one-page orientation: full-system ASCII diagram + a legend that names what each component is, what it owns, and what it talks to.
2. **[audit.md](./audit.md)** — the lens-by-lens audit (Pass 1). Skim this first; it tells you which pattern files to open next.
3. **Pattern files (Pass 2).** Open the ones whose names match what you're trying to understand:
   - [01-request-flow.md](./01-request-flow.md) — the seven-hop briefing pipeline + the demo short-circuit + the three runtime modes (demo / live-bloomreach / live-synthetic).
   - [02-oauth-boundary.md](./02-oauth-boundary.md) — OAuth 2.0 + PKCE + DCR via `OAuthClientProvider`; encrypted-cookie store + ALS pattern.
   - [03-provider-abstraction.md](./03-provider-abstraction.md) — the `DataSource` upper seam with three implementations (Bloomreach + Synthetic + the abstract interface) + the older `McpTransport` lower seam (Bloomreach-only); `makeDataSource(mode, sessionId)` factory.
   - [04-caching-and-rate-limiting.md](./04-caching-and-rate-limiting.md) — `BloomreachDataSource`'s cache + spacing + retry + no-cache-on-error.
   - [05-streaming-ndjson.md](./05-streaming-ndjson.md) — producer/consumer over `ReadableStream`; the line-buffering kernel; `fetch`-stream vs `EventSource`.
   - [06-multi-agent-orchestration.md](./06-multi-agent-orchestration.md) — five agents from `@aptkit/core`, bridged through three Blooming-owned adapter classes; `maxToolCalls` + `forceFinal` + `synthesize()`; same agents over swappable adapter.
   - [07-client-stream-handoff.md](./07-client-stream-handoff.md) — `useInvestigation`'s `startedRef` latch + four `sessionStorage` keys.
   - [08-schema-gated-coverage.md](./08-schema-gated-coverage.md) — the pure schema gate that scopes monitoring's budget; adapter-aware schemas + DATA HORIZON contract.
   - [11-aptkit-primitive-adapters.md](./11-aptkit-primitive-adapters.md) — three bridge classes in `lib/agents/aptkit-adapters.ts` adapt Blooming runtime objects (Anthropic SDK, DataSource, streaming hooks) to AptKit's generic primitives (`ModelProvider`, `ToolRegistry`, `CapabilityTraceSink`). The senior-grade "thin generic primitive + domain adapter" pattern, applied at the agent boundary.
   - [12-synthetic-data-source.md](./12-synthetic-data-source.md) — the in-process Blooming-owned synthetic adapter (`lib/data-source/synthetic-data-source.ts`, ~516 LOC). Same `DataSource` interface as Bloomreach, completely different failure model: no OAuth, no rate limit, no network. The "two adapters, one interface, different failure modes" lesson.
   - [09-eval-pipeline.md](./09-eval-pipeline.md) **(RETIRED)** — banner-preserved historical artifact. The 4-pillar eval suite was removed in PR #8.
   - [10-authored-mcp-server.md](./10-authored-mcp-server.md) **(RETIRED)** — banner-preserved historical artifact. The Olist MCP server was removed in PR #8.

## Cross-links to neighboring foundation guides

This guide owns architectural shape. Mechanism-level depth lives elsewhere:

- **Runtime / execution model** (event loop, async, ALS, `AsyncLocalStorage`) → `study-runtime-systems`
- **Network protocol behavior** (HTTP, NDJSON wire format, OAuth on the wire, TLS) → `study-networking`
- **Distributed-systems correctness** (across-instance state, encrypted-cookie pattern, no-quorum reads) → `study-distributed-systems`
- **Database engine internals** (none here — no DB) → `study-database-systems` (mostly N/A for this repo)
- **Schema shape** (`Insight`/`Anomaly`/`Diagnosis`/`Recommendation` types) → `study-data-modeling`
- **DSA mechanism teaching** (TTL cache, NDJSON line buffering, rate-limit retry, set-membership classification) → `study-dsa-foundations` (plus the legacy `study-dsa-foundations/*` archive for the prior depth treatments)

## The verdict, in one paragraph

The architecture is small, intentional, and shaped by two forces: one external constraint (Bloomreach's ~1 req/s/user rate limit) and one self-imposed discipline (the agent code stays in this app, but the *agent shape* comes from `@aptkit/core` — generic primitives upstream, domain adapters here). FIVE pieces are load-bearing: the AptKit agent primitives + the three Blooming-owned bridge classes that adapt this codebase's runtime objects to AptKit's interface; the `DataSource` seam with three implementations (Bloomreach + Synthetic + the abstract interface); `BloomreachDataSource` (cache + spacing + retry; the prod adapter); the NDJSON streaming routes (long agent work becomes a visibly-working UI); and the OAuth-on-Vercel encrypted cookie store. The `DataSource` seam is the load-bearing reason the codebase has TWO live modes — the same agents drive Bloomreach in prod AND a Blooming-owned in-process `SyntheticDataSource` for development/demo, with a runtime mode switch (`bi:mode = 'demo' | 'live-bloomreach' | 'live-synthetic'`). The architectural lesson the codebase teaches *twice* is the same: generic interface, domain adapter — once at the `DataSource` boundary (one interface, two concrete adapters), once at the AptKit boundary (`ModelProvider`/`ToolRegistry`/`CapabilityTraceSink` upstream, Anthropic + Blooming domain code on this side). One choice is deliberate and consequential: no database for the app's own state. That choice is right for hackathon scale and wrong the moment two users want a shared feed or anyone wants yesterday's anomalies. The two biggest architectural risks aren't bugs — they're places where the design's assumptions could quietly stop holding: the in-memory state in a serverless-instance world (one cold start drops the feed), and the unbounded coupling between the 1 req/s rate limit and the 300s route budget (one slow MCP day pushes investigations past the ceiling). Both are named in `audit.md` with the move.

---
