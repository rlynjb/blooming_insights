# Overview — Debugging & Observability in blooming insights

## The shape, in one frame

The product is "an analyst that shows its work." The same NDJSON event pipe that streams reasoning to the user *is* the developer's primary debugging surface. So the on-call evidence trail and the demo's "watch the agent think" UI are the same wire.

```
  How this repo reveals its behavior — three surfaces

  ┌─ UI layer ─────────────────────────────────────────────────┐
  │  StatusLog / ReasoningTrace                                │
  │     ▲                                                       │
  │     │ TraceItem (step | tool, ts)                           │
  └─────┼───────────────────────────────────────────────────────┘
        │
  ┌─ Service layer ─────────────────────────────────────────────┐
  │  GET /api/briefing  ──┐                                     │
  │  GET /api/agent     ──┤                                     │
  │                       │  encodeEvent(AgentEvent)            │
  │                       ▼                                     │
  │                ╔═══════════════════════╗                    │
  │                ║  ★ NDJSON stream ★    ║  ← SURFACE 1       │
  │                ╚═══════════════════════╝     (live trace)   │
  │                       │                                     │
  │                       ├─► console.log({route,phases,…})     │
  │                       │   (Vercel logs, per-request summary)│
  │                       ▼                                     │
  │                 saveInvestigation(id, collected)            │
  └─────────────────────────────────────────────────────────────┘
                          │
  ┌─ Storage layer ───────▼─────────────────────────────────────┐
  │  in-memory Map → .investigation-cache.json (dev only)        │
  │                → lib/state/demo-investigations.json (seed)   │
  │  ╔══════════════════════════════════════════╗               │
  │  ║  ★ Recoverable post-mortem evidence ★    ║  ← SURFACE 3  │
  │  ╚══════════════════════════════════════════╝               │
  └─────────────────────────────────────────────────────────────┘

  Plus: ★ Vitest test output ★  ← SURFACE 2
        24 files / 221 passing — the deterministic correctness gate
```

Three surfaces, not four. The fourth (an `eval/results/<date>/` paper trail) existed briefly and was retired with the Olist work — be honest about that when defending this in an interview.

## The three surfaces

### 1. NDJSON streaming trace (live)

The `AgentEvent` discriminated union at **`lib/mcp/events.ts:4-12`** is the wire contract. Eight variants: `reasoning_step | tool_call_start | tool_call_end | insight | diagnosis | recommendation | done | error`. Encoded one-per-line, terminated with `'\n'`.

Two routes produce it: `app/api/briefing/route.ts` (monitoring scan) and `app/api/agent/route.ts` (diagnostic + recommendation + free-form query). Four client consumers read it via the shared kernel at **`lib/streaming/ndjson.ts:17-64`**: `useBriefingStream.ts`, `useInvestigation.ts`, `useDemoCapture.ts`, and `StreamingResponse.tsx`. One wire, two producers, four consumers, one kernel.

When the LLM picks a wrong tool, when a Bloomreach call times out, when an anomaly is mis-categorised — you see it live in `StatusLog` because that's the same data the agent emitted. There's no separate debug log to consult.

### 2. Vitest test output

24 test files / 221 tests. `test/mcp/events.test.ts` pins the NDJSON encode/decode round-trip. `test/streaming/ndjson.test.ts` pins the line-buffered parse semantics (including the trailing-buffer flush). `test/api/briefing.integration.test.ts` (7 cases) pins the 9-case event dispatcher the briefing hook depends on. This is the *correctness gate before behavior gets weird in production* — neighbor to this guide, owned by `study-testing`.

### 3. Dev cache files (gitignored) + committed seed

Three-rung store at **`lib/state/investigations.ts:11-28`**: in-memory `Map` → `.investigation-cache.json` (dev only) → `lib/state/demo-investigations.json` (committed seed). The same lookup walks all three. Same idea for OAuth state at `lib/mcp/auth.ts:34-36` and the in-memory `memStore`.

When a live run produces a useful failure, the dev cache *already saved it*. You can re-open the page and the cached events replay — the bug is reproducible without re-running the agent.

## Ranked findings (what's interesting first)

1. **The NDJSON wire is both the UX and the debug surface.** This is the load-bearing decision. It eliminates the divergence problem (the dev log saying one thing while the user sees another) because there's only one pipe. → `01-ndjson-agent-event-discriminated-union.md`.

2. **Replay is built in.** The demo path isn't a fixture jig bolted on for tests — it's a real route (`/api/briefing?demo=cached`, `/api/agent` cache-first branch at `app/api/agent/route.ts:125-142`) that emits the snapshot at a paced 180ms/event so it *feels* like the live run. That gives you a reproducible debugging fixture per investigation. → `02-replay-from-snapshot-with-paced-emission.md`.

3. **The three-rung store is the post-mortem evidence trail.** A failure on the live route writes to in-memory and (in dev) `.investigation-cache.json`. Recovery is reload-the-page; investigation is open-the-JSON-file. → `03-three-rung-mem-file-seed-store.md`.

4. **The collected/send dual-write is the seam between live and replay.** Every emitted event is pushed into `collected` so `saveInvestigation(insightId, collected)` writes the same shape the live stream produced — no separate "snapshot format." → `04-dual-write-send-to-stream-and-store.md`.

5. **The `AUTH_SECRET` flake was the postmortem that named the pattern: "wrap setup in try/catch and surface the message."** Production-only 500 because `aesKey()` threw before the route could send a JSON body. Fixed by `app/api/briefing/route.ts:170-179` + `app/api/agent/route.ts:166-174`. → `05-auth-secret-flake-postmortem.md`.

## Per-phase wall-clock log line

Server-side `console.log` (Vercel logs only — not on the NDJSON wire), emitted once per request from the `finally` block at **`app/api/briefing/route.ts:317-324`** and **`app/api/agent/route.ts:331-338`**:

```json
{"route":"/api/briefing","sessionId":"…","mode":"live-bloomreach",
 "totalMs":118433,"phases":[
   {"phase":"schema_bootstrap","durationMs":2104},
   {"phase":"coverage_gate","durationMs":3},
   {"phase":"list_tools","durationMs":611},
   {"phase":"monitoring_scan","durationMs":115714}
 ],"aborted":false}
```

Shared shape across both routes so a single Vercel filter (`phases.phase = "schema_bootstrap"`) reads both. Fires on error too, so when the 300s ceiling kills a request you can see exactly which phase burned the budget. The Anthropic `res.usage` cost meter lives in a sibling line, logged on every model call at **`lib/agents/aptkit-adapters.ts:57-61`**.

## What's not yet exercised (be honest)

- **No SLI/SLO/alerting infra.** No metrics endpoint, no Sentry, no PagerDuty, no synthetic monitoring. The phase log is the closest thing to an SLI ("did the route finish under 300s"); nobody pages on it.
- **No distributed tracing.** No OpenTelemetry, no spans, no trace IDs propagated cross-service. The session ID at `lib/mcp/session.ts` is the closest thing to a correlation ID — it threads through `console.log` lines but nothing collects them into a trace tree.
- **No structured-log redaction beyond auth tokens.** `redactSecrets` at `lib/mcp/transport.ts:55-76` scrubs `Bearer …`, `access_token`, `refresh_token`, `id_token`, `code_verifier`. Customer PII in EQL results is NOT redacted — see audit lens 3.
- **No runbook documentation.** The auth-secret postmortem is preserved here (file 05), but there's no `/runbooks/` directory; the next incident has to rediscover the pattern.

The honest framing: this repo has *strong* observability on its own loop (the agents' reasoning) and *weak* observability on the surrounding infrastructure (the platform, the third-party MCP server, the user's session). The next layer of debugging investment is alerting + tracing, not more logs.
