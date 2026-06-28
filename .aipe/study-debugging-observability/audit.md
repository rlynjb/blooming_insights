# Audit — Debugging & Observability

Pass 1. Eight lenses walked against the repo. Each section names what the codebase actually does, with `file:line` grounding, or emits `not yet exercised` honestly.

## 1. observability-map

The evidence map. What can be observed at each boundary in this system?

**Three observability surfaces are live today.** A fourth (the `eval/results/<date>/` paper trail) existed briefly and was retired with the Olist work — don't claim it.

| Boundary | What's observable | Where |
| --- | --- | --- |
| browser ↔ Next.js route | NDJSON event stream (8 variants) | `lib/mcp/events.ts:4-12`; produced by `app/api/briefing/route.ts`, `app/api/agent/route.ts`; consumed by `useBriefingStream.ts`, `useInvestigation.ts`, `useDemoCapture.ts`, `StreamingResponse.tsx` via `lib/streaming/ndjson.ts:17-64` |
| Next.js route ↔ Anthropic | `res.usage` cost log + per-phase timings | `lib/agents/aptkit-adapters.ts:57-61` (per model call); `app/api/briefing/route.ts:317-324` and `app/api/agent/route.ts:331-338` (per request) |
| Next.js route ↔ Bloomreach MCP | tool name + durationMs + truncated result on the NDJSON wire; raw error body via the capturing fetch | `app/api/briefing/route.ts:264-275` (live emit); `lib/mcp/transport.ts:99-114` (raw body capture) |
| in-process state | per-session feed maps; cached investigations | `lib/state/insights.ts:14-23` (sessionState); `lib/state/investigations.ts:11` (mem Map) |
| disk (dev-only) | `.auth-cache.json`, `.investigation-cache.json` | `lib/mcp/auth.ts:34-35`; `lib/state/investigations.ts:7-9` |
| committed seed | `lib/state/demo-insights.json`, `lib/state/demo-investigations.json` | the replay fixture |
| Vercel logs (prod) | per-request summary line + per-error stack | `app/api/briefing/route.ts:298-324`; `app/api/agent/route.ts:312-338` |
| Vitest output (dev/CI) | 24 files / 221 tests | `test/` tree |

→ see `01-ndjson-agent-event-discriminated-union.md` for the wire contract,
→ see `03-three-rung-mem-file-seed-store.md` for the storage tier.

**Blind spots:** no APM/Sentry, no metrics endpoint, no distributed trace tree, no client-side error surface (browser exceptions in `useBriefingStream` set local error state but don't ship anywhere). The platform-level observability is what Vercel gives you out of the box plus the per-request log line.

## 2. reproduction-and-evidence

Can we reproduce a failure cheaply? Yes, by design.

**The committed demo snapshot is the reproduction fixture.** `lib/state/demo-insights.json` (28KB) and `lib/state/demo-investigations.json` (200KB) hold a complete real run — the workspace, the coverage grid, the monitoring trace, every insight, and every investigation's full event stream. Hitting `/api/briefing?demo=cached` replays it (no auth, no LLM, no MCP) at a paced 140ms/event. Hitting `/api/agent?insightId=…` *without* `live=1` triggers the cache-first branch at `app/api/agent/route.ts:125-142`, which replays the saved events at 180ms each.

**Dev runs add to the evidence library automatically.** Every live combined run writes to `.investigation-cache.json` via `saveInvestigation` at `app/api/agent/route.ts:302`. If a live investigation hits an interesting bug, the bug *is already saved*; refresh and the cached events replay deterministically.

**Per-step replay filter at `app/api/agent/route.ts:64-82`.** The combined-run snapshot is filtered by agent tag (`step.agent`, `tc.agent`) so step 2 (diagnose) and step 3 (recommend) replay the correct slice. The filter is the seam — it's what makes one captured run usable as two separate fixtures.

→ see `02-replay-from-snapshot-with-paced-emission.md`.

**What's missing:** no minimal-repro extraction tool. To narrow a 200KB snapshot to just the failing tool call, you edit JSON by hand. Vitest fixtures live in `test/fixtures/` but they're hand-rolled, not derived from cached failures.

## 3. structured-logs-and-correlation

Events, levels, context, correlation IDs, redaction.

**Logs are JSON, single-line, with a shared shape across routes** (`app/api/briefing/route.ts:317-324`, `app/api/agent/route.ts:331-338`):

```
{"route":"/api/briefing","sessionId":"…","mode":"live-bloomreach",
 "totalMs":118433,"phases":[…],"aborted":false}
```

The shared shape is deliberate — one Vercel filter (`phases.phase = "schema_bootstrap"`) reads both routes. **No leveling** (no info/warn/error tier); every non-error log is a `console.log`, every error is a `console.error`.

**The session ID is the only correlation thread.** Created by `getOrCreateSessionId` at `lib/mcp/session.ts`, stored in the `bi_session` cookie, threaded through every Vercel log and into the Anthropic call log (`lib/agents/aptkit-adapters.ts:60`). It does NOT propagate to Bloomreach (no header is added; the MCP SDK doesn't expose one). It does NOT propagate to the client logs. Cross-service correlation = grep by session ID, accepted limitation.

**Redaction is auth-token shaped, not PII shaped.** `redactSecrets` at `lib/mcp/transport.ts:55-76` scrubs `Bearer …`, `access_token`, `refresh_token`, `id_token`, `code_verifier` — comprehensive on credentials. EQL query results (which can contain customer emails, IDs, country breakdowns) are **not** redacted before being logged in `console.error` paths or written to `.investigation-cache.json`. For a real production deployment with real customer data this is a gap; for the alpha+demo workspace it's fine.

**Cause-chain walking.** `formatError` at `lib/mcp/transport.ts:82-97` walks up to 5 levels of `e.cause` before redacting, so a token tucked inside `e.cause.cause` doesn't survive. This is a real lesson — `String(e)` doesn't follow cause chains; you'd lose the redaction without it.

## 4. metrics-slis-slos-and-alerts

`not yet exercised` — at the metrics/alerting tier. The phase log line is *almost* an SLI ("did the route finish under 300s") but nothing aggregates or alerts on it. There's no `/api/metrics`, no Prometheus, no Sentry, no PagerDuty, no synthetic uptime monitor.

The closest thing to an alert is the in-route 300s ceiling: `maxDuration = 300` at `app/api/briefing/route.ts:19` and `app/api/agent/route.ts:22`. When Vercel kills the function, the `finally` block still fires the phase log so you can see how much of the budget burned. That's *graceful timeout* (a runtime concern) more than an alert (an observability concern).

When this matters: the next deployment to a real Bloomreach customer with non-demo traffic needs at least a healthcheck endpoint + Vercel monitoring on 5xx rate. For the alpha + demo path it doesn't.

## 5. traces-and-request-lifecycles

Per-request, in-app trace exists. Cross-service, no.

**The per-request phase log IS the trace.** `phases: Array<{phase, durationMs}>` accumulated through the request and emitted at end in `finally`:

```
phases: [
  {phase:"schema_bootstrap", durationMs:2104},
  {phase:"coverage_gate",    durationMs:3},
  {phase:"list_tools",       durationMs:611},
  {phase:"monitoring_scan",  durationMs:115714}
]
```

This tells you what part of a 300s budget burned where — the only structured latency-attribution surface in the repo.

**Per-tool latency rides the NDJSON stream.** `tool_call_end` carries `durationMs` (the time inside `dataSource.callTool`), surfaced in the UI's tool block. So the trace is *two-tier*: phases (coarse, server log) + per-tool calls (fine, NDJSON wire). Both observable, neither stitched into a unified trace tree.

**No spans, no trace IDs.** No OpenTelemetry, no W3C `traceparent` header on outbound Anthropic / Bloomreach calls. If a Bloomreach 500 lands during `monitoring_scan`, you have the route's phase log and the tool's `tool_call_end` error string; you do NOT have a unified trace that connects the user's click to that Bloomreach call to that downstream IdP redirect.

→ relevant code: `app/api/briefing/route.ts:204-281`, `app/api/agent/route.ts:216-295`.

## 6. state-snapshots-and-debugging-boundaries

Strong — this is the surface the product itself produces.

**Three layers of state, each independently inspectable:**

1. **The NDJSON event stream** — every reasoning step, tool call, and result on the wire. Open DevTools → Network → Response of `/api/agent?…` → you have the full event list as text, one per line. No proprietary format.
2. **In-process Maps** — `lib/state/insights.ts:14` holds `state: Map<sessionId, SessionFeed>`. In dev, attach a debugger and inspect. Not observable in prod (warm Vercel instance, no introspection endpoint).
3. **The dev cache files** — `.auth-cache.json` and `.investigation-cache.json` are gitignored JSON, written via `writeFileSync`. Open them in any editor; the schema is the same `AgentEvent[]` the wire uses.

**The capture button is the manual snapshot mechanism.** Dev-only one-click "capture this as the demo snapshot" in `app/page.tsx` runs the live briefing + each investigation and writes the result to `lib/state/demo-*.json`. The captured artifact is committable and replayable — the snapshot IS the bug report.

**The `dataSource.callTool` boundary is the API-debugging seam.** `lib/mcp/transport.ts:99-114` wraps `fetch` so the raw body of any non-OK response is stored in an `HttpErrorHolder`, then attached to the thrown `McpToolError` — surfacing the *real* Bloomreach error message instead of the SDK's generic "Unauthorized." This is the most expensive lesson in the file: the SDK's default error eats the diagnostic detail.

→ see `03-three-rung-mem-file-seed-store.md` for the storage tier.

## 7. incident-analysis-and-prevention

One real incident is preserved as a postmortem in code (the comment trail).

**The `AUTH_SECRET` flake.** Production-only 500 with no error message. Root cause: `aesKey()` at `lib/mcp/auth.ts:51-60` throws when `AUTH_SECRET` is unset, and the production cookie codepath calls it on every auth-store read. The throw escaped before the route could JSON-encode a response, so Vercel returned a bare 500. Prevention: wrap the setup phase in try/catch and surface `e.message` as a JSON body, at `app/api/briefing/route.ts:170-179` and `app/api/agent/route.ts:166-174`. The comment at line 167-168 explicitly names the lesson:

> "Wrapped so a setup throw (e.g. missing AUTH_SECRET breaking cookie encryption in production) returns the real message instead of a bare 500."

The same pattern (catch-setup-and-return-real-message) is the prevention guard for the *next* env-var flake. → see `05-auth-secret-flake-postmortem.md`.

**Other safety guards in the same family:**

- `DOMException` `AbortError` swallowed at `app/api/briefing/route.ts:294-296` and `app/api/agent/route.ts:308-310` — a client-cancelled stream is not an incident; the `finally` still records phase data.
- Best-effort dispose at `app/api/briefing/route.ts:308-312` and `app/api/agent/route.ts:322-326` — a teardown error must NOT swallow the route-level error.
- The retry ladder + ceiling in `BloomreachDataSource` — rate-limit responses are retried with parsed-hint backoff, capped at `retryCeilingMs: 20_000`, with `TOOL_TIMEOUT_MS = 30_000` at `lib/mcp/transport.ts:38` as a hard per-call bound. Comment names the lesson: "A hung Bloomreach connection would otherwise burn the entire 300s route budget on one stuck call."

**No runbook directory.** The lessons live as `// because …` comments next to the guards. Discoverable if you read the code; not discoverable from a `/runbooks` index.

## 8. debugging-observability-red-flags-audit

Ranked by consequence. Verdict + evidence for each.

### Rank 1 — no cross-service trace propagation

**Verdict:** when a Bloomreach call fails, you cannot connect the user's session ID to that specific HTTP call to that specific IdP redirect from logs alone.

**Evidence:** no `traceparent` header is set on the MCP SDK transport (`lib/mcp/transport.ts:99-114` shows the fetch wrapper — it captures error bodies but does NOT inject a trace header). The session ID does not propagate. Cross-service correlation is `grep "<session id>"` across two systems' logs, and Bloomreach is a third-party server whose logs you don't have.

**Why it's #1:** the next class of incident (intermittent Bloomreach 5xx, OAuth flake, IdP latency) requires precisely this stitch to diagnose without re-running.

### Rank 2 — no client-side error reporting

**Verdict:** browser-side exceptions are lost. The hook catches and sets local state; no error gets shipped off the client.

**Evidence:** `useBriefingStream.ts:289-294` catches with `setErrorMessage(String(e))` and `setStatus('error')` — that's the end of the trail. No Sentry, no `window.onerror`, no `/api/log/client` endpoint. A `JSON.parse` failure inside `readNdjson` is silently dropped by default (`opts.onMalformed` is opt-in at `lib/streaming/ndjson.ts:24`).

**Why it's #2:** the live-stream UI is the entire product surface. A silent failure there is invisible until the user reports it — and the product has no users.

### Rank 3 — PII redaction is auth-only, not content-shaped

**Verdict:** EQL results landing in `console.error` or in `.investigation-cache.json` are not scrubbed. Demo data is non-real; live customer data on a Bloomreach prod workspace would not be.

**Evidence:** `redactSecrets` at `lib/mcp/transport.ts:55-76` lists 5 patterns, all credential-shaped. The error path at `app/api/agent/route.ts:312-315` calls `formatError(e)` (which walks cause chains) and `redactSecrets` (which catches creds) — but a Bloomreach 500 whose body includes `{"customer":"alice@…"}` would survive both and reach Vercel logs.

**Why it's #3:** harmless today (demo workspace, no real customers); blocking the moment a real Bloomreach prod workspace is wired in.

### Rank 4 — no SLI/SLO/alert tier

**Verdict:** nobody is paged when `/api/briefing` 500s in production. You find out by reloading the page.

**Evidence:** no `/api/metrics`, no synthetic monitor, no Vercel alert rule wired. The 300s ceiling at `maxDuration = 300` is a runtime cap, not an alert.

**Why it's #4:** appropriate for the current stage; explicit gap to call out when the project graduates from demo.

### Rank 5 — the dev-cache file is plaintext

**Verdict:** `.auth-cache.json` holds OAuth access tokens in plaintext on disk in development.

**Evidence:** `lib/mcp/auth.ts:32-34` and the `writeAll` path at `lib/mcp/auth.ts:125-142` write the full token store to disk unencrypted. The comment names the constraint: "the dev cache holds OAuth tokens in plaintext; it is local-only and gitignored."

**Why it's #5:** the file is gitignored, the cost of theft is one developer's Bloomreach alpha session, the production codepath uses the AES-encrypted cookie at `auth.ts:62-67` instead. Accepted tradeoff; named explicitly so the next developer doesn't ship it.

### Rank 6 — `readNdjson` silently drops malformed lines by default

**Verdict:** a producer that emits a malformed JSON line vanishes from the trace with no signal at the consumer.

**Evidence:** `lib/streaming/ndjson.ts:44-49` calls `opts?.onMalformed?.(line, err)` — the optional chaining means a consumer that doesn't pass `onMalformed` simply skips the line. None of the four real consumers pass it (`useBriefingStream.ts:288`, `useInvestigation.ts:194`, `useDemoCapture.ts`, `StreamingResponse.tsx`).

**Why it's #6:** producers are all internal (your own routes encoding via `encodeEvent`) so the failure mode is theoretical; named for the post-mortem when someone adds a new producer that occasionally emits a half-buffered chunk.
