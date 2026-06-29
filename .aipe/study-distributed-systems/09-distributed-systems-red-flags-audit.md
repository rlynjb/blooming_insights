# Distributed systems red flags — audit

*Ranked coordination and partial-failure risks, grounded in the repo.*

This file is the audit. Findings ranked by consequence, each anchored to evidence, each with a verdict on whether to fix today, defer with a tripwire, or accept.

## How to read this

Three columns implied in every finding:

- **Severity** — what breaks if this fires, sized to the current product
- **Likelihood** — is this an active hazard today, or gated by a deployment property that doesn't currently hold?
- **Verdict** — fix · defer (with tripwire) · accept (with reason)

The findings below are ordered by *risk-adjusted impact today*, not by raw severity. A high-severity hazard gated by a deployment property the repo controls is ranked below a medium-severity hazard that fires under normal use.

## Top findings (ranked)

### 1. Schema cache leaks across tenants (HIGH severity · LOW likelihood today · DEFER with tripwire)

**The hazard.** `lib/mcp/schema.ts:138` declares a module-level `let cached: WorkspaceSchema | null = null`. First request on a warm Vercel instance fills it; every subsequent request returns the same cached value regardless of `sessionId`, OAuth identity, or Bloomreach `project_id`.

```ts
// lib/mcp/schema.ts:138
let cached: WorkspaceSchema | null = null;

export async function bootstrapSchema(dataSource, opts = {}) {
  if (cached) return cached;
  // … bootstrap …
  cached = parseWorkspaceSchema({…});
  return cached;
}
```

**What fires if it does.** Two distinct Bloomreach OAuth identities landing on the same warm instance: the second sees the first's project name, event schema, and customer properties. Agent prompts go out with the wrong schema; EQL gets generated against events that don't exist in the second user's project; Bloomreach errors with cryptic "unknown event" messages that look like schema mismatch but are actually our cache.

**Why low likelihood today.** Single-tenant deployment. `BLOOMREACH_PROJECT_ID` pins one project. Every authenticated session resolves to the same workspace. The hazard is gated by *the deployment property*, not by the code.

**Verdict — defer.** Key the cache by `projectId` (or move it to a per-request bootstrap) the day the deployment supports multi-tenant Bloomreach. The fix is small:

```ts
// pseudocode — the safe version
const cache = new Map<string, WorkspaceSchema>();

export async function bootstrapSchema(dataSource, opts = {}) {
  const { projectId, projectName } = await resolveProject(dataSource, opts);
  const hit = cache.get(projectId);
  if (hit) return hit;
  // …
  cache.set(projectId, schema);
  return schema;
}
```

**Tripwire.** If the deployment ever:
- adds a second `BLOOMREACH_PROJECT_ID` value
- supports per-user Bloomreach OAuth (different DCR client registrations per user)
- runs against a Bloomreach instance with multiple cloud organizations / projects per user

→ ship the fix before that deploy lands. See `04-consistency-models-and-staleness.md` for the full walkthrough.

---

### 2. Rate-limit classification is regex-on-text (MEDIUM severity · MEDIUM likelihood · DEFER with tripwire)

**The hazard.** `lib/data-source/bloomreach-data-source.ts:51-71` detects rate-limit errors by regexing the response text for `/rate limit|too many requests/i` and `/retry[\s-]*after[^0-9]*(\d+)\s*second/i` / `/per\s*(\d+)\s*second/i`. If Bloomreach changes the wording — "throttled," "quota exceeded," shifts the language locale — the regex misses, the retry ladder skips, the call returns as an unhandled error.

**What fires if it does.** Briefings and investigations start failing intermittently. The error surfaces honestly (the `isError: true` envelope still rides the response) but the system stops retrying when it should. The user sees `{ type: 'error', message: 'tool_name → ...' }` and tries again manually.

**Why medium likelihood.** Server-side strings change over time, especially during alpha. The current strings have held; future versions of `loomi-mcp-alpha` could change them. We don't have a contract that pins the wording.

**Verdict — defer.** A structured error code in the response envelope (Bloomreach-side change, not ours) would be the right fix. Until then, the regexes are fine *and* the test coverage in `test/mcp/client.test.ts:101-167` pins the current behavior. The realistic mitigation: a "saw an error, didn't classify as rate-limit, but contained 'limit' or 'quota'" telemetry line in the per-phase logger would catch the wording-change moment in production.

**Tripwire.** First alert: a user-visible briefing failure that turns out to be an unhandled rate-limit. Second alert: a log line showing an error response with text we don't match but probably should. Either fires → audit the regexes against current Bloomreach error strings, expand patterns.

---

### 3. No jitter on the retry ladder (LOW severity today · MEDIUM likelihood in concurrent use · DEFER with concurrency tripwire)

**The hazard.** `lib/data-source/bloomreach-data-source.ts:163-174` computes `waitMs = min(hintMs+500 ?? backoffMs, retryCeilingMs)`. The wait is *deterministic* given the error envelope. If two concurrent requests against the same Bloomreach user both hit a 429 with the same hint, they sleep the same amount and retry at the same wake instant — re-tripping the same rate-limit window.

**What fires if it does.** Briefings issued concurrently against one Bloomreach account ladder-align and burn through `maxRetries=3` faster than they should, exhausting retries before the window actually clears for either request.

**Why low likelihood today.** Each browser session opens *one* concurrent stream. Two users on different Bloomreach accounts don't share rate-limit windows. The lockstep scenario requires two simultaneous streams against the same Bloomreach identity, which doesn't happen in the current product shape.

**Verdict — defer.** Jitter is the textbook fix and adds a single line. The case for not adding it today is honest: we don't have the lockstep concurrency to suffer from its absence. The case for adding it later: cost is negligible, defense-in-depth.

**Tripwire.** First time we see two concurrent streams against one Bloomreach account (a dev tool, an admin dashboard, a second browser tab the user opens for the same account), ship full or decorrelated jitter:

```ts
// pseudocode — decorrelated jitter (AWS Builders Library)
const prev = lastWaitMs;
const next = Math.min(retryCeilingMs, Math.random() * Math.max(retryDelayMs, prev * 3));
```

See `02-partial-failure-timeouts-and-retries.md` for the full discussion.

---

### 4. No circuit breaker around Bloomreach (LOW severity today · LOW likelihood · ACCEPT)

**The hazard.** When Bloomreach is fully down or persistently rate-limiting, every request still runs the full retry ladder before failing — burning up to ~50s per call inside the route's 300s budget. With no breaker, *every* in-flight request pays this cost individually.

**What fires if it does.** Slow user experience during a Bloomreach outage: each briefing takes 50-90s to fail instead of failing immediately. The system never enters a "fail fast for the next N seconds while upstream recovers" mode.

**Why low likelihood.** Bloomreach Engagement is a mature platform; sustained outages aren't a daily event. The retry ladder's bounded design (`maxRetries=3`, `retryCeilingMs=20_000`) limits the per-call damage to ~50s, well inside the 300s route budget.

**Verdict — accept.** A circuit breaker is the right answer when (a) you have many concurrent requests that would benefit from cooperative fail-fast and (b) the cost of waiting through the retry is user-visible. Today we have neither at the scale that justifies the complexity. **The case to revisit:** if briefings ever become "five times faster on warm cache" — a UX promise — the slow-fail during an upstream outage would feel worse and a breaker would be justified. Not today.

The Hystrix-style half-open breaker is the canonical shape; the simpler `opossum` library is the realistic Node/Vercel choice if/when added.

---

### 5. Anthropic is a distributed dependency with no DataSource-style discipline around it (MEDIUM severity · LOW likelihood · DEFER)

**The hazard.** Every Claude call rides through `@anthropic-ai/sdk` directly inside the agent classes (e.g. `lib/agents/diagnostic.ts:36-44` constructs the AptKit agent with a raw `AnthropicModelProviderAdapter` wrapping the SDK). There is no spacing gate, no retry ladder, no 30s timeout, no `McpToolError`-style enrichment around Anthropic. If Anthropic 429s, 5xxs, or hangs, the failure mode is whatever the SDK propagates — typically a thrown exception that becomes an `{ type: 'error' }` NDJSON event.

**What fires if it does.** Investigations and briefings fail when Anthropic is slow or rate-limited. No retry → first failure becomes user-visible. No timeout → a hung call burns route budget waiting for the SDK's defaults.

**Why low likelihood.** Anthropic's reliability is generally high; the SDK has its own retry semantics for transient failures; the route's 300s budget bounds the worst case anyway.

**Verdict — defer.** The discipline shown around Bloomreach (`BloomreachDataSource`'s spacing + retry + timeout + classification) deserves a parallel for Anthropic if the product ever sees high Anthropic-side failure rates. The clean shape: a `ModelProvider` port mirroring the `DataSource` port, with an `AnthropicModelProvider` adapter that adds the discipline. Synthetic mode could then swap to a `FakeModelProvider` for tests without changing agent code.

**Tripwire.** First user-visible failure that turns out to be an Anthropic 429 / 5xx / timeout → ship the port + adapter + retry. The pattern is already in the codebase (file 02); the work is mirroring it for the model layer.

---

### 6. NDJSON malformed-line silent drop has no telemetry (LOW severity · LOW likelihood · DEFER)

**The hazard.** `lib/streaming/ndjson.ts:24-26` defines the `onMalformed` callback as defaulting to silent. The two consumers — `lib/hooks/useInvestigation.ts` and the feed page — pass no callback, so malformed lines disappear without trace. If the producer ever emits malformed lines systematically, the consumer silently drops them and the symptom is "the stream feels incomplete" with no diagnostic.

**What fires if it does.** A producer regression (e.g. unescaped newline inside a JSON string field) drops events on the floor and the only signal is missing UI updates.

**Why low likelihood.** The producer is `controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'))` — `JSON.stringify` correctly escapes embedded newlines, so the failure mode requires a bug in the JSON serialization or a non-standard producer.

**Verdict — defer.** Add a `console.warn` in the consumer's `onMalformed` callback for production diagnostics. One-line change, minimal code surface, high signal-to-noise if it ever fires. The reason to defer rather than fix-now: the producer's `JSON.stringify` is reliable, the path has run hundreds of times without a malformed-line observation.

**Tripwire.** First time a "missing events" bug is reported, audit the producer/consumer for malformed-rate; add the warn before debugging.

---

### 7. Cache key collisions on object-key-order (LOW severity · LOW likelihood · ACCEPT)

**The hazard.** `lib/data-source/bloomreach-data-source.ts:144` uses `${name}:${JSON.stringify(args)}` as the cache key. `JSON.stringify` is order-sensitive: `{a:1,b:2}` and `{b:2,a:1}` produce different strings. Two callers using semantically-equal but key-different args bypass the cache.

**What fires if it does.** Wasted Bloomreach calls; possible rate-limit pressure; no correctness violation.

**Why low likelihood.** The agents pass args from Claude-generated tool-call JSON, which doesn't reorder keys between turns. All in-codebase callers pass args from the same constructed shape.

**Verdict — accept.** Sort keys before stringifying would close the gap (`JSON.stringify(args, Object.keys(args).sort())`). The change is small; the risk it mitigates is small. **The case to revisit:** if a future caller normalizes args from a different shape (e.g. coming over the wire from a webhook), audit the dedup path then.

---

### 8. Investigation cache lives only on the instance that ran it (LOW severity · LOW likelihood · ACCEPT)

**The hazard.** `lib/state/investigations.ts:11` stores investigation results in a process-local `Map<string, AgentEvent[]>`. The combined-run cache (`saveInvestigation` at `agent/route.ts:302`) only persists to memory in production. A follow-up request — say, the user clicks "see recommendations" after the diagnose step — that lands on a different instance re-runs the agent.

**What fires if it does.** A user gets the live agent loop instead of an instant replay; latency goes from milliseconds to seconds; Bloomreach budget is consumed unnecessarily.

**Why low likelihood.** The investigate UI is designed to *expect* this: it stashes the result in `sessionStorage` client-side (see `useInvestigation.ts:55-65`) and rehydrates instantly without a fetch when the step's stash key is present. The cross-instance miss only happens on a first-time navigation, and the cost is one fresh agent run.

**Verdict — accept.** A shared cache (Redis, KV) would close the gap but the client-side stash already provides the user-visible benefit. The deferred work is named in file 04; if Vercel KV or similar gets added for unrelated reasons, this is a free upgrade.

---

### 9. Observability of cross-boundary calls is minimal (LOW severity · MEDIUM likelihood · DEFER for production-readiness)

**The hazard.** The per-phase `console.log` summary in `app/api/agent/route.ts:331-338` and `app/api/briefing/route.ts:317-324` is the entire cross-boundary observability surface. There's no distributed trace ID, no span propagation, no per-tool-call success/failure histogram, no rate-limit hit counter.

**What fires if it does.** During a production incident, diagnosing "why did 30% of briefings fail in this 10-minute window?" reduces to grepping Vercel logs for the summary lines and reconstructing patterns by hand. Doable but slow.

**Why medium likelihood.** Production incidents are inevitable; the question is just how often. The single-deployment, low-traffic profile today makes log-grepping tolerable.

**Verdict — defer for production-readiness.** When the product moves out of alpha and has SLOs to defend, add: (1) a trace ID (UUID per request) included in every log line, (2) a structured metric for tool-call outcome (`{ tool, status, durationMs, retries, fromCache }`), (3) a separate alert for "retry ladder exhausted" frequency. The lift is moderate (1-2 days); the timing is "before the first user-visible incident."

---

### 10. The "verified live" comments are dated 2026-05-27 and need re-verification (LOW severity · LOW likelihood · DEFER with calendar tripwire)

**The hazard.** `app/api/mcp/callback/route.ts:22-26` notes "Verified live 2026-05-27." OAuth flow behavior depends on Bloomreach's IdP staying compatible with the MCP SDK; alpha servers change. If the SDK update or a Bloomreach change altered the multi-call-to-state() pattern, the assumption that "the SDK handles state, we don't have to" could silently break.

**What fires if it does.** OAuth callbacks would either reject valid flows (state mismatch coming back) or accept invalid ones (CSRF window opens).

**Verdict — defer.** Re-verify the OAuth flow against a fresh `loomi-mcp-alpha.bloomreach.com` instance every quarter or before any major release. The mechanism: an integration test that drives the connect → callback flow end-to-end against a live Bloomreach (not just the mock).

---

## Findings explicitly NOT raised (and why)

The temptation in an audit is to manufacture findings to fill space. These are deliberately omitted:

- **"No SLOs / SLAs."** Correct — this is alpha-stage software. SLOs are a production-grade concern; raising them in an audit before they're appropriate would be performative.
- **"No DR plan."** Correct — there's nothing to recover. The demo snapshot IS the disaster recovery for the user-visible product; the OAuth tokens are recoverable by re-auth; the briefings re-run.
- **"No rate-limit metric for our own routes."** Correct but not relevant — Vercel's platform handles route-level rate-limiting; we're not exposing API endpoints meant for high-frequency machine traffic.
- **"No multi-region setup."** Correct — single region is fine for a single-Bloomreach-account product serving an analyst use case.

## Summary table

```
  Findings — sorted by risk-adjusted impact

  #  finding                                         sev    likl   verdict
  ─  ─────────────────                                ────   ────   ──────────
  1  schema cache leaks across tenants                HIGH   LOW    defer · multi-tenant tripwire
  2  rate-limit regex classification                  MED    MED    defer · wording-change tripwire
  3  no jitter on retry ladder                        LOW    MED    defer · concurrency tripwire
  4  no circuit breaker around Bloomreach              LOW    LOW    accept · bounded ladder suffices
  5  Anthropic has no DataSource discipline            MED    LOW    defer · failure-rate tripwire
  6  malformed NDJSON line silent drop telemetry      LOW    LOW    defer · add warn
  7  cache key collisions on object-key order          LOW    LOW    accept · in-codebase callers safe
  8  investigation cache per-instance only             LOW    LOW    accept · sessionStorage covers UX
  9  cross-boundary observability minimal              LOW    MED    defer for production-readiness
  10 OAuth flow re-verification cadence                LOW    LOW    defer · quarterly check
```

## The one finding to act on

If only one of these gets acted on this quarter, it's **#5 — Anthropic without DataSource discipline**, because:

- The repo *already has* the pattern (`BloomreachDataSource`'s spacing/retry/timeout/classification), so the change is mirroring an existing shape.
- The cost of running without it is borne by the product's reliability profile, not by the upstream's.
- It generalizes — the `ModelProvider` port would also enable a `FakeModelProvider` for cheaper tests, which is a current pain point.

**Finding #1** is higher-severity but lower-likelihood (gated by deployment property). Acting on it speculatively is fine if multi-tenant is on the roadmap; otherwise tripwire.

## Verified anchors

Every finding above is anchored to current code as of the audit date. The two files that carry the bulk of the distributed-systems mechanisms (and the bulk of the findings) are:

- `lib/data-source/bloomreach-data-source.ts` — findings 2, 3, 4, 7
- `lib/mcp/schema.ts` — finding 1
- `lib/mcp/transport.ts` — implicit in finding 4 (per-call timeout that makes a breaker less urgent)
- `lib/agents/*.ts` — finding 5 (Anthropic SDK calls)
- `lib/streaming/ndjson.ts` — finding 6
- `lib/state/investigations.ts` — finding 8
- `app/api/agent/route.ts` + `app/api/briefing/route.ts` — finding 9
- `app/api/mcp/callback/route.ts` — finding 10

The 221-test suite covers the in-place mechanisms (retry ladder, rate-limit detection, transport timeout, NDJSON parser, session-keyed state). What's *not* covered by tests is the integration with Bloomreach itself — see finding 10's mitigation.

## See also

- `02-partial-failure-timeouts-and-retries.md` — the mechanisms behind findings 2, 3, 4.
- `04-consistency-models-and-staleness.md` — the schema cache walkthrough (finding 1).
- `05-replication-partitioning-and-quorums.md` — the "not yet exercised" baseline this audit is calibrated against.
- `07-clocks-coordination-and-leadership.md` — the cookie-as-coordination-state mechanism this audit doesn't flag (it works).
- `.aipe/study-debugging-observability/` — the observability gap from finding 9 in detail.
- `.aipe/study-security/` — finding 10 in security terms (OAuth flow assumptions).
