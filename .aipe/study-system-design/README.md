# Study — system design

This guide takes the **current blooming insights repo** and walks its architecture in two passes:

- **Pass 1 — `audit.md`.** One section per lens in the 8-lens inventory (system-map-and-boundaries, request-response-and-data-flow, state-ownership-and-source-of-truth, caching-and-invalidation, storage-choice-and-durability-boundaries, failure-handling-and-reliability, scale-bottlenecks-and-evolution, system-design-red-flags-audit). Verdict-first, ranked findings, every claim grounded in a `file:line` reference. Cross-links to each pattern file when a finding warrants the deeper walk.
- **Pass 2 — 8 discovered-pattern files.** Named after the architectural patterns this codebase actually exercises (request flow, OAuth boundary, provider abstraction, caching+rate-limiting, streaming NDJSON, multi-agent orchestration, client stream handoff, schema-gated coverage). Each uses the full per-concept template — Zoom out → Structure pass → How it works → Primary diagram → Implementation in codebase → Elaborate → Interview defense → Validate → See also.

## Reading order

1. **[00-overview.md](./00-overview.md)** — the one-page orientation: full-system ASCII diagram + a legend that names what each component is, what it owns, and what it talks to.
2. **[audit.md](./audit.md)** — the lens-by-lens audit (Pass 1). Skim this first; it tells you which pattern files to open next.
3. **Pattern files (Pass 2).** Open the ones whose names match what you're trying to understand:
   - [01-request-flow.md](./01-request-flow.md) — the seven-hop briefing pipeline + the demo short-circuit.
   - [02-oauth-boundary.md](./02-oauth-boundary.md) — OAuth 2.0 + PKCE + DCR via `OAuthClientProvider`; encrypted-cookie store + ALS pattern.
   - [03-provider-abstraction.md](./03-provider-abstraction.md) — `McpTransport` + `McpCaller` seams; why 125 tests run offline.
   - [04-caching-and-rate-limiting.md](./04-caching-and-rate-limiting.md) — `McpClient` cache + spacing + retry + no-cache-on-error.
   - [05-streaming-ndjson.md](./05-streaming-ndjson.md) — producer/consumer over `ReadableStream`; the line-buffering kernel; `fetch`-stream vs `EventSource`.
   - [06-multi-agent-orchestration.md](./06-multi-agent-orchestration.md) — one shared `runAgentLoop`; `maxToolCalls` + `forceFinal` + `synthesize()`.
   - [07-client-stream-handoff.md](./07-client-stream-handoff.md) — `useInvestigation`'s `startedRef` latch + four `sessionStorage` keys.
   - [08-schema-gated-coverage.md](./08-schema-gated-coverage.md) — the pure schema gate that scopes monitoring's budget before any EQL fires.

## Cross-links to neighboring foundation guides

This guide owns architectural shape. Mechanism-level depth lives elsewhere:

- **Runtime / execution model** (event loop, async, ALS, `AsyncLocalStorage`) → `study-runtime-systems`
- **Network protocol behavior** (HTTP, NDJSON wire format, OAuth on the wire, TLS) → `study-networking`
- **Distributed-systems correctness** (across-instance state, encrypted-cookie pattern, no-quorum reads) → `study-distributed-systems`
- **Database engine internals** (none here — no DB) → `study-database-systems` (mostly N/A for this repo)
- **Schema shape** (`Insight`/`Anomaly`/`Diagnosis`/`Recommendation` types) → `study-data-modeling`
- **DSA mechanism teaching** (TTL cache, NDJSON line buffering, rate-limit retry, set-membership classification) → `study-dsa-foundations` (plus the legacy `study-dsa-foundations/*` archive for the prior depth treatments)

## The verdict, in one paragraph

The architecture is small, intentional, and shaped by one external constraint (Bloomreach's ~1 req/s/user rate limit). Three pieces are load-bearing and do their jobs well: `runAgentLoop` (one function, four agents), `McpClient` (cache + spacing + retry), and the NDJSON streaming routes (long agent work becomes a visibly-working UI). One choice is deliberate and consequential: no database. That choice is right for hackathon scale and wrong the moment two users want a shared feed or anyone wants yesterday's anomalies. The two biggest architectural risks aren't bugs — they're places where the design's assumptions could quietly stop holding: the in-memory state in a serverless-instance world (one cold start drops the feed), and the unbounded coupling between the 1 req/s rate limit and the 300s route budget (one slow MCP day pushes investigations past the ceiling). Both are named in `audit.md` with the move.

---

Updated: 2026-06-02 — Restructured to v1.59.2 audit-style two-pass shape: `audit.md` (Pass 1, 8 lenses) + 8 discovered-pattern files (Pass 2). The 8 legacy lens-named numbered files are deleted; their content lives in `audit.md`'s lens sections + cross-links. Pattern files promoted from the legacy archive `.aipe/study-system-design/`.
Updated: 2026-06-01 — Initial generation as v1.55 audit-shaped guide.
