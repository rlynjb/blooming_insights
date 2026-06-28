# Overview — the whole system on one page

If you read only one file, read this one. It puts the boxes on a map; the
audit and the pattern files unpack what each box does and where it breaks.

## The whole-system diagram

The shape: a browser drives two NDJSON endpoints, each of which constructs a
DataSource (live Bloomreach or in-process synthetic), bootstraps a workspace
schema, and runs a multi-agent loop whose tokens stream back as they happen.

```
  blooming insights — top-level system map

  ┌─ Browser (Next.js client) ──────────────────────────────────────────────┐
  │                                                                          │
  │   app/page.tsx            useBriefingStream    useReconnectPolicy        │
  │   investigate/[id]/...    useInvestigation     useDemoCapture (dev)      │
  │                                                                          │
  │   localStorage `bi:mode`  ──┐    sessionStorage `bi:insight:<id>`        │
  │   ('demo' default)          │   `bi:diag:<id>`  `bi:reconnecting`        │
  └─────────────────────────────┼────────────────────────────────────────────┘
                                │
                                │  GET /api/briefing?{demo=cached|mode=...}
                                │  GET /api/agent?insightId=...&step=...
                                │  POST /api/mcp/{call,reset,capture,capture-demo}
                                │  GET  /api/mcp/{callback,tools,tools/check}
                                ▼
  ┌─ Edge / Network boundary ────────────────────────────────────────────────┐
  │  cookies: bi_session (uuid)  +  bi_auth (AES-256-GCM encrypted store)    │
  └─────────────────────────────────────────────────────────────────────────┘
                                │
                                ▼
  ┌─ Service layer (Vercel serverless, maxDuration=300) ────────────────────┐
  │                                                                          │
  │   Route handlers                                                         │
  │     /api/briefing   — monitoring scan → NDJSON                           │
  │     /api/agent      — investigation pipeline → NDJSON                    │
  │                                                                          │
  │   ┌─ DataSource seam (lib/data-source/types.ts) ─────────────────────┐   │
  │   │  makeDataSource(mode, sessionId)                                  │   │
  │   │    ├─ live-bloomreach → BloomreachDataSource                      │   │
  │   │    │   60s cache · ~1 req/s · retry · 30s timeout                 │   │
  │   │    └─ live-synthetic → SyntheticDataSource (in-process)           │   │
  │   └───────────────────────────────────────────────────────────────────┘   │
  │                                                                          │
  │   ┌─ Agent layer (lib/agents/*) — thin Blooming shims ────────────────┐  │
  │   │  MonitoringAgent · DiagnosticAgent · RecommendationAgent          │  │
  │   │  QueryAgent · classifyIntent                                      │  │
  │   │       └──► AptKit primitive (@aptkit/core@0.3.0)                  │  │
  │   │            via 3 adapters (aptkit-adapters.ts):                   │  │
  │   │              AnthropicModelProviderAdapter                        │  │
  │   │              BloomingToolRegistryAdapter                          │  │
  │   │              BloomingTraceSinkAdapter                             │  │
  │   └───────────────────────────────────────────────────────────────────┘  │
  │                                                                          │
  │   ┌─ In-memory state ─────────────────────────────────────────────────┐  │
  │   │  lib/state/insights.ts        Map<sessionId, SessionFeed>          │ │
  │   │  lib/state/investigations.ts  combined-run cache (mem + dev file)  │ │
  │   └───────────────────────────────────────────────────────────────────┘  │
  │                                                                          │
  └─────────────────────────────────────────────────────────────────────────┘
                                │                            │
                                │ HTTPS + Bearer            │ in-process call
                                ▼                            ▼
  ┌─ Provider (Bloomreach loomi connect MCP) ──┐    ┌─ Synthetic in-memory ──┐
  │  https://loomi-mcp-alpha.bloomreach.com/   │    │  deterministic fake    │
  │  OAuth PKCE + Dynamic Client Registration  │    │  ecommerce workspace   │
  │  ~1 req/s rate-limit (per user, global)    │    │  (no network, no auth) │
  │  Anthropic API (claude-sonnet-4-6;         │    │                        │
  │  claude-haiku-4-5 for intent)              │    │                        │
  └────────────────────────────────────────────┘    └────────────────────────┘

  Persistence story (none of these is a database):
    .auth-cache.json          dev-only OAuth cache         (gitignored)
    .investigation-cache.json dev-only investigation cache (gitignored)
    lib/state/demo-*.json     committed demo snapshot      (in git)
```

## Legend — what each box is, what it owns, who it talks to

**Browser / Next.js client** — App Router, React 19. Owns presentation state
and three storage slots: `localStorage` for the mode toggle, `sessionStorage`
for stash + handoff (insight, diagnosis, reconnect-guard), and three custom
hooks that own each streaming surface (`useBriefingStream`,
`useInvestigation`, `useDemoCapture`). Talks only to its own `/api/*` routes.

**Edge / Network boundary** — `bi_session` is a plain UUID cookie; `bi_auth`
is the encrypted store of OAuth client info + tokens + PKCE verifier. Both
are `SameSite=None; Secure` in production so they survive the OAuth round-trip
to the Bloomreach IdP and back to `/api/mcp/callback`.

**Route handlers** — two streaming routes (`/api/briefing` and `/api/agent`)
share the same shape: parse `mode`, run `makeDataSource`, bootstrap the
schema, run an agent, stream NDJSON. Both set `maxDuration = 300` to fit
under Vercel Pro's ceiling. The four short MCP routes (`/api/mcp/{call,
reset, capture, capture-demo}` + `/callback` + `/tools`) handle the OAuth
dance and dev tooling.

**DataSource seam** (`lib/data-source/types.ts`, 71 LOC) — the abstract
surface every backend must implement: `callTool`, `listTools`. The factory
`makeDataSource(mode, sessionId)` returns one of two adapters:
`BloomreachDataSource` (live HTTPS+OAuth+rate-limit+cache+retry) or
`SyntheticDataSource` (in-process, deterministic, no auth). Agents hold a
`DataSource` reference, never a concrete adapter — see
`03-datasource-seam.md`.

**Agent layer** — five thin Blooming wrappers (`monitoring`, `diagnostic`,
`recommendation`, `query`, `intent`) over `@aptkit/core@0.3.0`'s reusable
agents. The wrappers exist to (a) accept Blooming's concrete types, (b) wire
the three adapter classes in `aptkit-adapters.ts` that bridge between
AptKit's provider-neutral interfaces and Blooming's Anthropic SDK +
DataSource + trace-event shapes. The hand-rolled `runAgentLoop` is preserved
at `lib/agents/base-legacy.ts` for reference — see
`04-aptkit-primitive-boundary.md`.

**In-memory state** — `lib/state/insights.ts` is a `Map<sessionId,
SessionFeed>` so one warm Vercel instance serving multiple users doesn't
leak feed contents across sessions. `lib/state/investigations.ts` caches
combined-run investigations (for replay) in memory, plus a dev-only file
mirror, plus a committed demo seed.

**Bloomreach loomi connect MCP** (the alpha provider) — rate-limits at
~1 req/s globally per user, revokes tokens after minutes, returns rate-limit
errors as tool-result envelopes with the penalty window in the error text.
The Bloomreach adapter parses that text and waits the stated window before
retrying.

**Synthetic in-memory provider** — `lib/data-source/synthetic-data-source.ts`
(516 LOC) ships a fixed ecommerce workspace plus deterministic responses to
the same tool names the live server exposes (`execute_analytics_eql`,
`get_event_schema`, …). No network, no auth, no rate limit — used when
`bi:mode = 'live-synthetic'`.

**Anthropic API** — agents call `claude-sonnet-4-6`; the intent classifier
calls `claude-haiku-4-5-20251001`. Both go through
`AnthropicModelProviderAdapter` so AptKit never imports the Anthropic SDK
directly.

## Ranked findings (the things you'll bring back from this guide)

1. **The DataSource seam is the load-bearing architectural move.** Every
   agent holds an abstract `DataSource`, not a concrete adapter; the factory
   `makeDataSource(mode, sessionId)` picks the implementation per request
   based on `bi:mode`. The same agent code runs against live Bloomreach,
   in-process synthetic data, or (historically) any other adapter — one
   line in the route, no agent changes.
   → `03-datasource-seam.md`

2. **NDJSON is the streaming contract, not SSE or WebSocket.** Every
   streaming surface (briefing, agent, capture, query) shares one kernel
   (`lib/streaming/ndjson.ts`, 64 LOC) on the client and `encodeEvent` on
   the server. The contract is a discriminated union (`AgentEvent`) — one
   event per line, malformed lines silently skipped, trailing buffer
   flushed at end-of-stream.
   → `06-streaming-ndjson.md`

3. **Two cookies do two different jobs.** `bi_session` is the user
   identifier (plain UUID); `bi_auth` is the OAuth store (AES-256-GCM
   encrypted, AsyncLocalStorage-scoped, flushed once per request). The
   second one is the only state that survives across Vercel instances —
   in-memory feed state does NOT.
   → `02-oauth-boundary.md`

4. **The schema gate stops the agent from spending EQL budget on
   unmonitorable categories.** Before the monitoring agent runs, the
   route computes `schemaCapabilities` → `runnableCategories`; only those
   categories reach the agent. Without the gate, the alpha server's ~1
   req/s ceiling would burn the 300s budget on categories whose required
   events the workspace doesn't emit.
   → `09-schema-gated-coverage.md`

5. **The agent layer is now AptKit primitives + three adapter classes.**
   The migration to `@aptkit/core@0.3.0` is complete; `lib/agents/*.ts`
   are thin shims that adapt Blooming's types into AptKit's
   provider-neutral interfaces. The `-legacy.ts` siblings are preserved
   for reference but not wired.
   → `04-aptkit-primitive-boundary.md`

## Verdict — the one lesson

If you take one architectural idea away from this codebase, it's this:
**when an external provider is unreliable, slow, or rate-limited, put a
seam in front of it and ship two adapters.** The DataSource seam exists
because Bloomreach's alpha MCP server can't be the only path to "the app
runs end-to-end" — it'd block dev, demos, and CI. The synthetic adapter
behind the same interface is what lets the rest of the system stay honest
about running the real agent loop without depending on a flaky upstream.
Every other architectural choice (NDJSON streaming, session-keyed state,
the cookie split, the schema gate) is downstream of that one.
