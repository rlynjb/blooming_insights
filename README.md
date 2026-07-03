# blooming insights

An AI analyst for a Bloomreach Engagement ecommerce workspace. Streams the
agents' reasoning as a first-class UI surface — every conclusion carries
provenance (exact tool calls, current-vs-prior numbers, streamed reasoning
trace). "An analyst that shows its work."

Built on Next.js 16 + React 19 + [`@aptkit/core`](https://npmjs.com/package/@rlynjb/aptkit-core)
agent runtime + Anthropic Claude Sonnet 4.6 + a swappable MCP server (Bloomreach
by default; configurable via `MCP_URL` + `MCP_AUTH_TYPE`) or an in-process
Synthetic adapter.

---

## Tier-2 claims (with receipts)

This is a **tier-2 production-grade** codebase — deployed, instrumented,
cost-controlled, fault-tested, and eval-proven. NOT tier 3 (live traffic).
Every claim below is backed by code + a shipped receipt.

```
Concern                          Where it lives                   Receipt
────────────────────────────────────────────────────────────────────────────────
Per-call timeout (30s) composed  lib/mcp/transport.ts:38-131      integration
  with client cancellation        + composeSignals                  test/
Cancellation to every async      req.signal.throwIfAborted() →     integration
  layer                           agents → callTool                 test/
Rate-limit retry ladder          BloomreachDataSource               test/
                                  (retryCeilingMs, spacing gate)
Secret redaction + cause-chain   redactSecrets / formatError        test/
Structured per-phase timing      recordPhase / finally summary log  eval/
Graceful degradation on error    route catch → NDJSON error event  eval/load.eval
                                                                    (0/9 faults
                                                                    caused case
                                                                    failure)
DataSource adapter seam          lib/data-source/types.ts +         3 adapter
  (survived 4 uses)                2 adapters + fault decorator      swaps, 0
                                                                    caller-side
                                                                    changes
AptKit adapter boundary          lib/agents/aptkit-adapters.ts      library
                                  (3 classes, 206 LOC)               owns loop,
                                                                    I own
                                                                    boundary
Prompt caching on system prompt  aptkit-adapters.ts complete()      live logs
                                                                    show
                                                                    cache_creation
                                                                    → cache_read
Per-investigation budget         lib/agents/budget.ts               BudgetTracker
  ceiling                         + BudgetExceededError              throws before
                                                                    dispatch when
                                                                    ceiling hit
Eval harness (2 rubrics,        eval/                              10-case run
  10 goldens, blind cal, gate)                                       @ ~$1.30
Test suite                       test/                              24 files /
                                                                    221 passing
```

---

## One-command reproducibility

Every claim above is reproducible from a clean clone. `.env.local` needs
`ANTHROPIC_API_KEY` for anything that calls the model; `AUTH_SECRET`
(32+ chars) for anything that touches cookie-encrypted sessions.

```bash
# install
npm ci

# unit + integration tests (24 files, 221 tests, no API cost)
npm test

# eval — 10 goldens, ~$1.30, ~35 min
npm run eval

# report — p50/p95/p99 latency + tokens + cost from latest run
npm run eval:report

# blind calibration (worksheet + user labels + agreement)
npm run eval:worksheet     # generates blank worksheet
# (fill in yourScores + yourVerdict in eval/calibration/worksheet-*.json)
npm run eval:agreement     # computes user-vs-judge agreement

# load harness (N configurable, no judges, ~$0.08/investigation)
LOAD_N=20 LOAD_CONCURRENCY=3 npm run eval:load

# fault injection (offline; wraps the DataSource with a configurable
# failure decorator to test graceful degradation)
LOAD_N=5 FAULT_TIMEOUT=0.1 FAULT_MALFORMED_JSON=0.1 FAULT_SEED=42 \
  npm run eval:load

# regression gate (Phase 5) — reads eval/baseline.json + latest run,
# fails if any dim regressed by more than GATE_MAX_REGRESSION (default 10pp)
npm run eval:gate

# build a NEW baseline from a run
RUN_ID=<runId> npm run eval:baseline
```

---

## Development

```bash
# dev server
npm run dev
# → http://localhost:3000

# Next production build
npm run build

# lint
npm run lint
```

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│  Next.js 16 App Router + React 19                                   │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │  UI (app/page.tsx 461 LOC + 3 hooks; 4-tier progressive        │  │
│  │  composition; NDJSON stream reader kernel)                     │  │
│  └────────────────────────┬───────────────────────────────────────┘  │
│                           │ NDJSON stream (30–90s)                    │
│  ┌────────────────────────▼───────────────────────────────────────┐  │
│  │  Route handlers (app/api/*)                                    │  │
│  │  · 300s maxDuration                                            │  │
│  │  · AbortSignal → agents → callTool                             │  │
│  │  · session-keyed state (Map<sessionId, SessionFeed>)           │  │
│  └────────────────────────┬───────────────────────────────────────┘  │
│                           │                                           │
│  ┌────────────────────────▼───────────────────────────────────────┐  │
│  │  Agents (thin wrappers over @aptkit/core)                      │  │
│  │  · MonitoringAgent → DiagnosticAgent → RecommendationAgent      │  │
│  │  · classifyIntent (Haiku) for intent routing                    │  │
│  │  · BudgetTracker enforces per-investigation ceiling             │  │
│  └────────┬───────────────────────────────────────┬─────────────── │  │
│           │                                       │                  │
│  ┌────────▼──────────────────┐         ┌──────────▼───────────────┐  │
│  │  DataSource port          │         │  Blooming AptKit         │  │
│  │  (lib/data-source/types)   │         │  adapters                │  │
│  │  ├─ McpDataSource          │         │  (aptkit-adapters.ts:    │  │
│  │  │   (BloomreachDataSource │         │   3 classes, 206 LOC)    │  │
│  │  │    is the alias — same  │         │  library owns the loop;  │  │
│  │  │    class, either name)  │         │  we own the boundary     │  │
│  │  ├─ SyntheticDataSource    │         └──────────────────────────┘  │
│  │  └─ FaultInjecting         │                                        │
│  │      (offline decorator)   │                                        │
│  └───────────────────────────┘                                        │
│                                                                        │
│  AuthProvider (lib/mcp/auth-providers/)                               │
│  ├─ oauth-bloomreach (default; OAuth 2.1 + PKCE + DCR)                │
│  ├─ bearer (static token via MCP_AUTH_TOKEN)                          │
│  └─ anonymous (no auth; local dev MCP servers)                        │
└──────────────────────────────────────────────────────────────────────┘
```

- **Modes**: `live-synthetic` (default, no OAuth), `live-mcp` (env-configured
  MCP server; Bloomreach is the default example config), and `demo` (hidden
  from UI toggle but reachable via `?demo=cached` — preserved reliability
  path). See `.env.example` for `MCP_URL` / `MCP_AUTH_TYPE` / `MCP_AUTH_TOKEN`.
- **Frozen core**: the AptKit adapter bridge, the 4 active agents (thin
  wrappers), the `AgentEvent` NDJSON contract, the UI, and the demo replay
  path. `*-legacy.ts` siblings (the hand-rolled `runAgentLoop`) remain as
  the rollback receipt.
- **Data flow**: browser → NDJSON stream ← route → agents → DataSource
  (McpDataSource with an AuthProvider / Synthetic / FaultInjecting decorator).

Detailed studies:
- `.aipe/study-system-design/` — architecture, boundaries, flows
- `.aipe/study-software-design/` — module depth, AOSD lenses
- `.aipe/study-ai-engineering/` — LLM foundations, evals, agents,
  observability
- `.aipe/study-agent-architecture/` — reasoning patterns, orchestration
- `.aipe/rehearse-interview-defense/` — 8-chapter defense book
- `docs/portfolio-hardening/` — the tier-2 hardening plan + weekly
  study plan being executed against `main`

---

## What's NOT in this repo (deliberately)

- No database. Session state in-process, session-keyed. Demo snapshot
  as reliability path. Trigger for revisit: multi-instance deployment.
- No LLM supervisor. Route code is a deterministic pipeline over 4
  agents. Trigger for revisit: 5th agent that must interleave.
- No Server Components, no Suspense, no `use(promise)`, no React
  Query / SWR. NDJSON over fetch stream IS the product.
