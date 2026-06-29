# Study — system design (blooming_insights)

This folder is the per-repo system-design guide. It teaches the architecture this repo actually exercises — where data, state, and work live; how they move across boundaries; what changes if a dependency rotates.

## Reading order

Open in this order — each file leans on the orientation the previous one set.

1. **`00-overview.md`** — one-page map. The whole system in one diagram, what each component owns, what it talks to. Read first; skim only this if you have five minutes.
2. **`audit.md`** — the 8-lens audit. One section per system-design lens (boundaries, flows, state, caching, storage, failure, scale, red flags), each with `file:line` evidence or an honest `not yet exercised`.
3. **Pattern files (`01-` through `10-`)** — the patterns this repo actually relies on. Each named after the pattern, not the lens. Each uses the standard concept-file shape (zoom out → structure pass → how it works → primary diagram → elaborate → interview defense → see also).

## Pattern files

The order roughly follows the request — outer system shell first, then the load-bearing seam, then the streaming and reliability machinery.

| # | File | What it teaches |
|---|------|-----------------|
| 01 | `01-request-flow.md` | The end-to-end flow: browser → Next.js route → DataSource → MCP server → LLM → NDJSON back to the UI |
| 02 | `02-auth-boundary.md` | OAuth/PKCE/DCR with two storage backends (encrypted cookie in prod, gitignored file in dev), session-scoped per request |
| 03 | `03-datasource-seam.md` | **The load-bearing seam.** Port (`DataSource`) with two live adapters today; survived two adapter swaps without changing caller code |
| 04 | `04-aptkit-primitive-boundary.md` | Three-class bridge to `@aptkit/core`: model provider, tool registry, trace sink. Library owns the loop; this repo owns the boundary |
| 05 | `05-framework-runtime-only.md` | Why Next.js earns its keep here as a runtime (App Router, streaming responses, edge cookies, `maxDuration`) — not as a UI framework anchor |
| 06 | `06-streaming-ndjson.md` | One `readNdjson` kernel feeds four consumer surfaces; `AgentEvent` is the wire contract; producer always terminates with `\n` |
| 07 | `07-in-memory-state-ownership.md` | Session-keyed in-memory state (`Map<sessionId, SessionFeed>`); concurrent-user wipe RESOLVED; the cookie carries identity, the map carries data |
| 08 | `08-demo-replay-as-reliability.md` | Demo replays a committed JSON snapshot as if it were a live NDJSON stream; how a presentation-grade default emerged from a flaky upstream |
| 09 | `09-schema-gated-coverage.md` | A 10-category checklist gates which monitoring categories run, based on the live workspace schema — no EQL spent on unsupported categories |
| 10 | `10-rate-limit-aware-mcp-client.md` | Proactive spacing + retry ladder + 60s cache, all inside the Bloomreach adapter; agent loop never sees the rate limit |

## Cross-links to neighboring foundation guides

System-design is the *where*; foundations are the *how*. When a pattern here leans on a foundation, the link sits inside the relevant pattern file.

- **`study-database-systems`** — there is no DB in this repo (in-memory + session cookies). The audit's `storage-choice-and-durability-boundaries` lens calls this out as a deliberate choice and points to the foundation guide for what changes if one is added.
- **`study-data-modeling`** — the shape of `Insight` / `Anomaly` / `Diagnosis` / `Recommendation` (the NDJSON wire types) lives in the data-modeling guide; this folder links to it from the streaming pattern.
- **`study-distributed-systems`** — when failure crosses the Bloomreach boundary (OAuth revocation, rate-limit retry, server unreachable), the coordination concerns belong to the distributed-systems guide.
- **`study-runtime-systems`** — the Vercel serverless model (cold starts, request lifetime, `maxDuration = 300`, `AsyncLocalStorage` per request) lives there; this folder names where each constraint shows up.

## On UPDATE

- Add a pattern file when a new pattern shows up in the codebase (e.g. a worker, a queue, a second auth surface).
- Update an existing pattern file when its implementation changes (e.g. the seam grows a third adapter, the streaming kernel adds backpressure).
- Remove a pattern file only when the pattern is genuinely gone — not when it's refactored.
- Regenerate `audit.md` against current evidence on every run.
