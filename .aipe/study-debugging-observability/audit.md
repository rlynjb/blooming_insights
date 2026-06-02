# Debugging & Observability — audit

> **Verdict-first.** The trace IS the product. blooming insights emits a typed NDJSON `AgentEvent` stream (`lib/mcp/events.ts:4-17`) that every layer of the system speaks — the live UI renders it, the cache snapshots it, the replay re-emits it at 180ms ticks so the consumer can't tell live from replay. That's an unusually strong observability substrate for an early-stage repo. The strongest pattern is the 8-line discriminated union; the load-bearing gap is the metrics aggregator (`durationMs` is measured per call but nothing rolls it up); the highest-priority finding is the asymmetry between the rigorously typed happy path (AgentEvent) and the freeform exception path (4× `console.error`) — closing it is a 30-line `lib/log.ts` and four single-line swaps.

---

## observability-map

The evidence map is uneven but honest. Five layers, four kinds of evidence, one big gap:

```
  layer           │  evidence shape                  │  lifetime
  ────────────────┼─────────────────────────────────┼──────────────────
  UI              │  rendered TraceItem[] + devtools │  page mount
  Route handler   │  NDJSON wire + 2× console.error  │  request
  Agent loop      │  AgentEvent[] (the spine)        │  request
  MCP client      │  durationMs · fromCache · error  │  per call
  Provider        │  ─ (their logs, not ours)        │  not owned
```

Two seams are load-bearing in the map: **agent loop ↔ route handler** (in-process hooks flip to framed NDJSON line — this is where the trace becomes a transport-able artifact), and **route handler ↔ cache snapshot** (`saveInvestigation` lifts the request-scoped `collected[]` into a persistent replayable artifact). A *missing* seam, named for honesty: **agent loop ↔ external sink** — no OpenTelemetry/Langfuse/Datadog export anywhere. The trace lives only in the UI and the cache; nothing aggregates or queries across investigations.

→ see `01-ndjson-agentevent-discriminated-union.md` for the 8-line contract every layer speaks
→ see `04-dual-write-send-to-stream-and-store.md` for the agent↔route seam mechanics

## reproduction-and-evidence

The reproduction primitive is the captured `AgentEvent[]` snapshot. A captured investigation replays from `lib/state/demo-investigations.json` deterministically, with no MCP/Anthropic credentials needed, paced at 180ms per event so the UI animates identically to a live run. That collapses the canonical "same data, same auth, same browser, same network" reproduction problem to "load the right `insightId` and watch the cache replay."

Two real gaps. The route saves only on the `done` path (`app/api/agent/route.ts:254`) gated on `step == null`, so (a) a thrown error short-circuits the snapshot — broken runs aren't replayable — and (b) split-step runs hand off via `sessionStorage` instead of caching server-side. The briefing flow and the free-form query flow don't use this cache at all; their own replay paths are structurally similar but unshared.

→ see `02-replay-from-snapshot-with-paced-emission.md` for the cache-first replay path and why 180ms is load-bearing
→ see `03-three-rung-mem-file-seed-store.md` for the mem→file→seed chain that makes the seed portable across deploys

## structured-logs-and-correlation

Honest verdict: there is almost no traditional log surface. Four `console.error` calls total — `app/api/agent/route.ts:160,256` and `app/api/briefing/route.ts:166,248` — is the entire backend log. No logger module, no log levels, no correlation IDs, no redaction. None of `pino`/`winston`/`bunyan`/`lib/log.ts` exists.

The *substitute* — and it's genuinely a substitute, not a workaround — is that the AgentEvent stream gives you what correlation IDs are usually for. Every event in a stream belongs to one investigation; the array IS the correlation envelope. You don't need to `grep "requestId=abc"` because you're already inside the request's typed event array. This is the same insight as Go's `context.Context` or Node's `AsyncLocalStorage` — except the events ARE the context. The gap that remains is at the route catch sites: when an exception escapes, all you get is `[agent] error: <message>` in Vercel's stdout with no `insightId`, no level, no redaction.

The asymmetry — typed happy path (`AgentEvent`), freeform exception path (`console.error`) — is the single most surprising shape in this repo's observability story. Closing it is ~30 lines of `lib/log.ts` + four single-line edits at the catches. Top-3 finding below.

## metrics-slis-slos-and-alerts

`not yet exercised` past the per-call primitive. `durationMs` is measured wall-clock around every MCP call (`lib/mcp/client.ts:112,134`) and rides on every `tool_call_end` event in the trace. That's rung 1 of the 4-rung metrics pipeline; rungs 2–4 don't exist. No `lib/metrics.ts`, no histogram, no time-series store, no SLO definition (no `docs/slos.md`), no PagerDuty, no on-call rotation, no SLA. The only quantitative time constraint anywhere is `maxDuration = 300` (`app/api/agent/route.ts:20`), which is a Vercel hard kill, not an SLO target.

The gap is acceptable today (the user watches the trace live — aggregated metrics matter when nobody is watching in real time). The trigger that makes it urgent: customer #1 or any case where you need to answer "is this getting slower week-over-week?" The smallest first move is a `lib/metrics.ts` with an in-memory histogram per `toolName`, wired next to `send({type:'tool_call_end', …})` in both routes — ~2 hours, turns rung 1 into rung 1+2.

## traces-and-request-lifecycles

The trace is the strongest layer. The `AgentEvent` discriminated union (`lib/mcp/events.ts:4-12`) defines the entire span vocabulary in 8 lines: `tool_call_start` opens a span, `tool_call_end` closes it with `durationMs`, `reasoning_step` annotates the timeline between spans. NDJSON over HTTP is the carrier (`route.ts:174` — `controller.enqueue(encoder.encode(encodeEvent(e)))`). Cache-first replay re-emits the captured events identically at 180ms ticks (`route.ts:127–141`), so the UI's `useInvestigation` hook can't tell live from replay.

One latent risk worth flagging: span pairing is positional. `replaceRunningTool` in `lib/hooks/useInvestigation.ts:86–95` scans backwards for the most recent `running` tool with the same `toolName`. This works because today's `runAgentLoop` dispatches tools sequentially. If parallel tool dispatch ever lands, the pairing ambiguates; the fix is a `spanId` field. Latent today, not active.

For the LLM-telemetry angle on this same stream (token usage, model versions, prompt drift), cross-link to `.aipe/study-ai-engineering/05-evals-and-observability/04-llm-observability.md` rather than re-teaching it.

→ see `01-ndjson-agentevent-discriminated-union.md` for the union as contract
→ see `02-replay-from-snapshot-with-paced-emission.md` for the replay carrier

## state-snapshots-and-debugging-boundaries

The snapshot is `saveInvestigation(insightId, events[])` in `lib/state/investigations.ts:30-41`. It writes the captured `AgentEvent[]` to a 3-rung store: mem (per-process, fastest), `.investigation-cache.json` (dev-only — Vercel FS is read-only in prod), and `lib/state/demo-investigations.json` (committed seed, crosses deploys). `getCachedInvestigation` reads in priority order — mem → dev file → seed, first non-null wins.

The boundary is "the agent finished cleanly" — `send({type:'done'})` is the contract that triggers the save, gated on `step == null` (combined run only). Errors don't snapshot, by design: half-runs would corrupt the replay path. The snapshot captures `AgentEvent[]` and nothing else — no provenance envelope, no `capturedAt`, no `modelVersion`, no `promptHash`. That makes it a replay fixture, not a regression fixture; the difference is whether you can diff two snapshots across model/prompt versions.

→ see `03-three-rung-mem-file-seed-store.md` for the read/write chain and the scopes each rung serves

## incident-analysis-and-prevention

One documented incident. Commit `e83a8e0` (the flake-fix) is the canonical worked example of `reproduce → isolate → verify → prevent` in this repo: `process.env.AUTH_SECRET` was mutated directly inside `test/mcp/auth.test.ts`, vitest's parallel workers leaked the variable across files, so the crypto round-trip test passed in isolation and flaked ~1-in-N in a full run. The fix is `vi.stubEnv` + `vi.unstubAllEnvs` in `beforeEach`/`afterEach`. 12 lines added, 3 removed, one file, production code unchanged. The commit message IS the post-mortem — it names the root cause, the fix, the contributing condition (parallel workers + shared global), and the verification ("157 tests pass across repeated runs; tsc clean").

Past that one example, incident tooling is absent. No Sentry, no error tracker, no on-call rotation, no PagerDuty/Opsgenie, no `docs/runbooks/`, no SLO definitions, no incident-management workflow. The detect layer for prod is "the user reports it" or "the developer reads Vercel logs." This is rationally deferred (solo repo, no SLA, no rotation to wake) — naming it explicitly is the point.

→ see `05-auth-secret-flake-postmortem.md` for the incident walked end-to-end as a reusable template

## debugging-observability-red-flags-audit

Ranked by *consequence in this repo* — not by what's industry-standard. Read top-down, stop at your remediation budget.

```
  rank  gap                                     cost     blast radius  primitive
  ────  ──────────────────────────────────────  ───────  ────────────  ──────────────
  P0    no metrics aggregator (rung 2)          low      high          yes (durationMs)
  P0    no structured logger (lib/log.ts)       low      high          no (4× console.error)
  P1    no Sentry / error tracker               medium   medium        no (depends on P0)
  P1    no upstream request-ID correlation      low      medium        yes (response objects)
  P2    no snapshot provenance envelope         low      medium        yes (events[] exists)
  P2    parallel-span pairing is positional     low      low/latent    yes (toolName + running)
  P3    no on-call rotation/runbooks/SLOs       high     low           no (no SLA today)
  P3    no backend trace sink (OTel/Langfuse)   high     low           yes (AgentEvent stream)
```

The split that drives the ranking: gaps where the *primitive is already measured* are cheap to close (the work is wiring); gaps with no primitive need code from zero. P0 rows are dominated by primitive-in-place items because those are highest leverage per dollar. P3 rows are correctly deferred — adding OTel without a backend that queries the traces is performative; adding rotation without an SLA is theatre.

The leading indicators that flip P3 → P1: "we have a customer with an SLA" (rotation), "we want regression analysis across snapshots" (OTel + provenance envelope), "we hit our first prod outage that took >1 hour to root-cause" (Sentry + runbooks).

---

## Top 3 ranked findings

1. **No metrics aggregator (rung 2 of the pipeline) — `lib/mcp/client.ts:112,134` measures `durationMs` per call; nothing rolls it up.** Fix shape: write a `lib/metrics.ts` with an in-memory histogram per `toolName`. Wire `metrics.observe(toolName, durationMs)` next to `send({type:'tool_call_end', …})` in both routes. Expose `/api/metrics` in Prometheus exposition format. ~2 hours of work; turns rung 1 into rung 1+2; makes cross-run regressions visible.

2. **No structured logger — `app/api/agent/route.ts:160,256` + `app/api/briefing/route.ts:166,248` are 4× `console.error` with no level, no fields, no correlation, no redaction.** Fix shape: a ~30-line `lib/log.ts` exposing `log.error({event, ...fields}, err)`, serializing to NDJSON, with a redaction list. Swap the 4 catches. No new dependency required. ~30 minutes; closes a high-blast-radius gap and is the prerequisite for any meaningful incident tooling (Sentry inherits the same lossy strings without structured fields).

3. **Cache snapshot lacks provenance envelope — `lib/state/investigations.ts:30-41` writes `events: AgentEvent[]` directly, no `capturedAt`/`modelVersion`/`promptHash`.** Fix shape: extend the snapshot to `{capturedAt, modelVersion, promptHash?, events: AgentEvent[]}`. `AGENT_MODEL = 'claude-sonnet-4-6'` is already a constant in `lib/agents/base.ts:9`. Update both write paths and read paths; re-capture the seed. ~1 hour; converts the seed from a replay fixture into a regression fixture (you can diff snapshots across model/prompt versions).
