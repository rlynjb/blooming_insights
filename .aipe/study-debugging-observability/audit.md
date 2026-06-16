# Debugging & Observability — audit

> **Verdict-first.** Four observability surfaces. The trace IS the product (surface 1) — blooming insights emits a typed NDJSON `AgentEvent` stream (`lib/mcp/events.ts:4-17`) that every online layer speaks; the cache snapshots it; the replay re-emits at 180ms ticks so the consumer can't tell live from replay. The 269-test Vitest suite is surface 2; the dev cache files are surface 3. Phase 3 added **surface 4: the committed eval result paper trail** under `eval/results/<date>[-<tag>]/` — per-run JSON + judge scores + summary markdown, with `EVAL_RUN_TAG` as the env-var primitive that lets re-runs land in sibling dirs without overwriting. The eval flywheel (measure → debug → fix → re-measure) is the model-level debugging methodology that surfaced PR D's monitoring-prompt bug (5% → 25% precision), PR E's BRL cents-vs-Reais bug at run 8 (judge: *"AOV BRL 131,965 is implausible"*), PR F's recurrence at the same numerical fingerprint, and PR G's 30% regression baseline. The strongest pattern is the 8-line discriminated union; the load-bearing runtime-metrics gap is the aggregator (`durationMs` measured per call, never rolled up); the highest-priority finding is still the asymmetry between the rigorously typed happy path (AgentEvent) and the freeform exception path (4× `console.error`) — closing it is a 30-line `lib/log.ts` and four single-line swaps.

---

## observability-map

The evidence map has **four observability surfaces** — three online (live, request-scoped) and one offline (post-hoc, committed). Honest about what each one catches:

```
  surface           │  layer           │  evidence shape                  │  lifetime
  ──────────────────┼─────────────────┼─────────────────────────────────┼──────────────────
  1. live trace     │  UI              │  rendered TraceItem[] + devtools │  page mount
                    │  Route handler   │  NDJSON wire + 2× console.error  │  request
                    │  Agent loop      │  AgentEvent[] (the spine)        │  request
                    │  MCP client      │  durationMs · fromCache · error  │  per call
                    │  Provider        │  ─ (their logs, not ours)        │  not owned
  ──────────────────┼─────────────────┼─────────────────────────────────┼──────────────────
  2. unit tests     │  Vitest          │  269 tests, exit code + report   │  CI run
  ──────────────────┼─────────────────┼─────────────────────────────────┼──────────────────
  3. dev cache      │  filesystem      │  .auth-cache.json,               │  dev machine
                    │  (gitignored)    │  .investigation-cache.json       │
  ──────────────────┼─────────────────┼─────────────────────────────────┼──────────────────
  4. eval results   │  eval/results/   │  per-run JSON + judge scores +   │  forever (git)
     (COMMITTED)    │  <date>[-<tag>]/ │  freeform notes + summary.md     │
                    │  EVAL_RUN_TAG    │  ▲ catches model-behavior bugs   │
                    │  → sibling dirs  │    that surfaces 1-3 can't       │
```

Three seams are load-bearing in the map. **agent loop ↔ route handler** — in-process hooks flip to framed NDJSON line; this is where the trace becomes a transport-able artifact. **route handler ↔ cache snapshot** — `saveInvestigation` lifts the request-scoped `collected[]` into a persistent replayable artifact. **agent run ↔ eval result dir** — the eval runner serializes K iterations of the agent into a date-stamped, judge-scored, committed directory; this is where *online behavior* becomes *offline measurement*. The third seam is the entire reason surface 4 exists — a single live request can hide a behavior bug that K iterations across a fixture exposes.

A *missing* seam, named for honesty: **agent loop ↔ external sink** — no OpenTelemetry/Langfuse/Datadog export anywhere. The trace lives only in the UI, the cache, and (post-hoc) the eval result dir. Nothing aggregates *runtime* metrics across investigations.

→ see `01-ndjson-agentevent-discriminated-union.md` for the 8-line contract every online layer speaks
→ see `04-dual-write-send-to-stream-and-store.md` for the agent↔route seam mechanics
→ see `06-eval-result-paper-trail.md` for surface 4 — the offline measurement substrate

## reproduction-and-evidence

Two reproduction primitives, one online and one offline.

**Online: the captured `AgentEvent[]` snapshot.** A captured investigation replays from `lib/state/demo-investigations.json` deterministically, with no MCP/Anthropic credentials needed, paced at 180ms per event so the UI animates identically to a live run. That collapses the canonical "same data, same auth, same browser, same network" reproduction problem to "load the right `insightId` and watch the cache replay."

**Offline: the committed eval result dir.** Phase 3 added `eval/results/<date>[-<tag>]/` as the reproduction primitive for *model-level* bugs. Each result dir captures K iterations against a known fixture (seeded Olist data, three known anomalies), with per-run candidate output, judge scores, and a `summary.md` rollup. Re-running with `EVAL_RUN_TAG=<context>` lands in a sibling dir without overwriting — `2026-06-15` vs `2026-06-15-after-fix` is the unit of "before vs after the fix." This is what makes the fix *verifiable*: you measure once, change one thing, measure again, diff the dirs.

Three real gaps. (a) The route saves only on the `done` path (`app/api/agent/route.ts:254`) gated on `step == null`, so a thrown error short-circuits the snapshot — broken runs aren't replayable. (b) Split-step runs hand off via `sessionStorage` instead of caching server-side. The briefing flow and the free-form query flow don't use this cache at all; their own replay paths are structurally similar but unshared. (c) Adjacent eval result dirs are diffable by hand only — no `compare-evals.ts` emits structured deltas, no automated regression-vs-baseline check beyond reading both `summary.md` files.

→ see `02-replay-from-snapshot-with-paced-emission.md` for the cache-first replay path and why 180ms is load-bearing
→ see `03-three-rung-mem-file-seed-store.md` for the mem→file→seed chain that makes the seed portable across deploys
→ see `06-eval-result-paper-trail.md` for the offline reproduction primitive — eval result dirs, EVAL_RUN_TAG, and the flywheel

## structured-logs-and-correlation

Honest verdict: there is almost no traditional log surface. Four `console.error` calls total — `app/api/agent/route.ts:160,256` and `app/api/briefing/route.ts:166,248` — is the entire backend log. No logger module, no log levels, no correlation IDs, no redaction. None of `pino`/`winston`/`bunyan`/`lib/log.ts` exists.

The *substitute* — and it's genuinely a substitute, not a workaround — is that the AgentEvent stream gives you what correlation IDs are usually for. Every event in a stream belongs to one investigation; the array IS the correlation envelope. You don't need to `grep "requestId=abc"` because you're already inside the request's typed event array. This is the same insight as Go's `context.Context` or Node's `AsyncLocalStorage` — except the events ARE the context. The eval surface (`eval/results/<date>[-<tag>]/`) generalises the same insight at a different scope: the *result dir* IS the correlation envelope for K iterations — you don't need to correlate runs across files because they're all inside the same directory. The gap that remains is at the route catch sites: when an exception escapes, all you get is `[agent] error: <message>` in Vercel's stdout with no `insightId`, no level, no redaction.

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

Three documented incidents now, each at a different layer of the stack.

**Test-level: the AUTH_SECRET flake (`e83a8e0`).** Canonical worked example of `reproduce → isolate → verify → prevent` in this repo: `process.env.AUTH_SECRET` was mutated directly inside `test/mcp/auth.test.ts`, vitest's parallel workers leaked the variable across files, so the crypto round-trip test passed in isolation and flaked ~1-in-N in a full run. The fix is `vi.stubEnv` + `vi.unstubAllEnvs` in `beforeEach`/`afterEach`. 12 lines added, 3 removed, one file, production code unchanged. The commit message IS the post-mortem.

**Model-level: the BRL cents-vs-Reais bug (PR E run 8, recurring in PR F run 8).** Surfaced via the eval flywheel: K=10 of the recommendation agent landed `impact_sized: 0` on iteration 8 with the judge writing *"AOV BRL 131,965 is implausible for a Brazilian consumer electronics order — these are stored as cents in the source schema."* The agent treated `purchase.price_brl` (cents in the seeded data) as Reais, computing AOV 100x too high. Fix landed in PR E; PR F's regression eval caught the *same numerical fingerprint* recurring at the same iteration slot (run 8 of K=10), which is itself a real debug signal — same fingerprint = same code path failed the same way. Detection: LLM-as-judge. Diagnosis: read the freeform `notes` field of `recommendation-K10-judge.json`. Verification: re-run with `EVAL_RUN_TAG=after-fix`, diff the result dirs.

**Process-level: the parallel-run race.** K=10 of the recommendation eval was running from the main session's Bash. A PR E sub-agent ALSO ran K=10 against the same OlistDataSource. Two `npm run eval:recommendation` processes were competing for the same date-stamped output dir. Detection: `ps aux | grep eval` showed PIDs 30039 and 30040. Fix: `kill 30039 30040` before the writes collided. Prevention: discipline around `EVAL_RUN_TAG=<session>` when spawning evals from a sub-agent to land in sibling dirs. The detection primitive was process listing — there's no `.eval.lock`, no in-app race detection. When the in-app surface doesn't exist, `ps aux` + `kill PID` IS the observability tool.

Past these three examples, broader incident tooling is absent. No Sentry, no error tracker, no on-call rotation, no PagerDuty/Opsgenie, no `docs/runbooks/`, no SLO definitions, no incident-management workflow. The detect layer for prod is "the user reports it" or "the developer reads Vercel logs." This is rationally deferred (solo repo, no SLA, no rotation to wake) — naming it explicitly is the point.

→ see `05-auth-secret-flake-postmortem.md` for the test-level incident walked end-to-end as a reusable template
→ see `06-eval-result-paper-trail.md` for the eval flywheel methodology that surfaced PR D's monitoring-prompt date-framing bug (5% → 25% precision), PR E's BRL bug, PR F's recurrence at the same numerical fingerprint, PR G's 30% regression baseline; also for the parallel-run incident walked at process level

## debugging-observability-red-flags-audit

Ranked by *consequence in this repo* — not by what's industry-standard. Read top-down, stop at your remediation budget.

```
  rank  gap                                     cost     blast radius  primitive
  ────  ──────────────────────────────────────  ───────  ────────────  ──────────────
  P0    no metrics aggregator (rung 2)          low      high          yes (durationMs)
  P0    no structured logger (lib/log.ts)       low      high          no (4× console.error)
  P1    no Sentry / error tracker               medium   medium        no (depends on P0)
  P1    no upstream request-ID correlation      low      medium        yes (response objects)
  P1    no compare-evals.ts (sibling-dir diff)  low      medium        yes (result-dir naming)
  P2    no snapshot provenance envelope         low      medium        yes (events[] exists)
  P2    parallel-span pairing is positional     low      low/latent    yes (toolName + running)
  P2    no .eval.lock for parallel-run guard    low      low           no (ps aux + kill only)
  P3    no on-call rotation/runbooks/SLOs       high     low           no (no SLA today)
  P3    no backend trace sink (OTel/Langfuse)   high     low           yes (AgentEvent stream)
```

The split that drives the ranking: gaps where the *primitive is already measured* are cheap to close (the work is wiring); gaps with no primitive need code from zero. P0 rows are dominated by primitive-in-place items because those are highest leverage per dollar. P3 rows are correctly deferred — adding OTel without a backend that queries the traces is performative; adding rotation without an SLA is theatre.

The leading indicators that flip P3 → P1: "we have a customer with an SLA" (rotation), "we want regression analysis across snapshots" (OTel + provenance envelope), "we hit our first prod outage that took >1 hour to root-cause" (Sentry + runbooks).

---

## Top 3 ranked findings

1. **No metrics aggregator (rung 2 of the pipeline) — `lib/mcp/client.ts:112,134` measures `durationMs` per call; nothing rolls it up.** Fix shape: write a `lib/metrics.ts` with an in-memory histogram per `toolName`. Wire `metrics.observe(toolName, durationMs)` next to `send({type:'tool_call_end', …})` in both routes. Expose `/api/metrics` in Prometheus exposition format. ~2 hours of work; turns rung 1 into rung 1+2; makes cross-run regressions visible.

2. **No structured logger — `app/api/agent/route.ts:160,256` + `app/api/briefing/route.ts:166,248` are 4× `console.error` with no level, no fields, no correlation, no redaction.** Fix shape: a ~30-line `lib/log.ts` exposing `log.error({event, ...fields}, err)`, serializing to NDJSON, with a redaction list. Swap the 4 catches. No new dependency required. ~30 minutes; closes a high-blast-radius gap and is the prerequisite for any meaningful incident tooling (Sentry inherits the same lossy strings without structured fields).

3. **Cache snapshot lacks provenance envelope — `lib/state/investigations.ts:30-41` writes `events: AgentEvent[]` directly, no `capturedAt`/`modelVersion`/`promptHash`.** Fix shape: extend the snapshot to `{capturedAt, modelVersion, promptHash?, events: AgentEvent[]}`. `AGENT_MODEL = 'claude-sonnet-4-6'` is already a constant in `lib/agents/base.ts:9`. Update both write paths and read paths; re-capture the seed. ~1 hour; converts the seed from a replay fixture into a regression fixture (you can diff snapshots across model/prompt versions). The eval surface (`06-`) already exercises a heavier version of this discipline — its result dirs carry the date and tag in the *path*, which is one step away from carrying `modelVersion`/`promptHash`. The two surfaces converge on the same provenance need.

---
Updated: 2026-06-16 — added the fourth observability surface (eval result paper trail) to observability-map; refreshed reproduction-and-evidence with the offline reproduction primitive; expanded incident-analysis with the BRL bug (model-level) and parallel-run race (process-level) incidents; bumped test count 144 → 269; added P1 (no compare-evals.ts) and P2 (no .eval.lock) red flags.
