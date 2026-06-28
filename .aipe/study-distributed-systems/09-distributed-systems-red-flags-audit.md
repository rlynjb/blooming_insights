# Distributed systems red flags audit

**Industry name:** ranked coordination + partial-failure risks · **Type:** Project-specific audit grounded in real files

A ranked list of distributed-systems risks in this codebase, with `file:line` evidence for each verdict. Severity reflects *likelihood × blast radius* in the current shape — not what a textbook would call critical.

Severities: **critical** (would cause data loss or correctness bug in prod) · **warning** (would cause UX degradation or wasted cost) · **info** (real concern, not currently biting) · **deliberate** (a gap by design, listed for completeness).

---

## #1 — Per-instance rate-limit spacing — burstable across the cohort  · severity: **warning**

**Evidence:** `lib/data-source/bloomreach-data-source.ts:191` — `lastCallAt` is a private field on `BloomreachDataSource`, instantiated per connection (which is per request, on a per-instance OAuth provider). Two warm Vercel instances each have their own `lastCallAt`.

**The risk:** The proactive 1.1s spacing (`minIntervalMs: 1100`, set in `lib/mcp/connect.ts:97`) prevents one instance from hammering Bloomreach. But two warm instances handling the same user's requests can each call at ~1.1s intervals, *doubling* the effective rate. Bloomreach's rate limit is per-user GLOBAL, not per-instance.

**What happens in practice:** the retry ladder catches the 429 envelope and waits the stated penalty window (~10s), so correctness is preserved. The cost is latency — every "burst" becomes a 10s+ wait that the user notices.

**The fix when it starts mattering:** shared rate-limit state in Redis / Vercel KV (a `lastCallAt:${userId}` key with atomic CAS). Same shape as the bi_auth cookie pattern but for per-user, not per-session.

**Cross-link:** `02-partial-failure-timeouts-and-retries.md` (the retry ladder that absorbs this) · `07-clocks-coordination-and-leadership.md` (the cookie pattern that would model the fix).

---

## #2 — No in-flight lock on schema bootstrap — duplicate work on cold start  · severity: **warning**

**Evidence:** `lib/mcp/schema.ts:186-209`. The `cached` module variable is checked once; if it's `null` and two concurrent requests both call `bootstrapSchema`, both run the 6-call orchestration (`list_cloud_organizations` → `list_projects` → `get_event_schema` + 3 siblings). Both write to `cached`; the second one wins.

**The risk:** ~6 wasted MCP calls per duplicated bootstrap, each paying the ~1.1s spacing. Under load on a cold instance, this becomes a thundering-herd problem against an upstream that rate-limits.

**What happens in practice:** reads are idempotent so correctness is preserved. The cost is wasted bandwidth and a slower first response when concurrent requests race.

**The fix:** memoize the in-flight Promise, not the resolved value. One-line change:

```ts
let inflight: Promise<WorkspaceSchema> | null = null;
export async function bootstrapSchema(...) {
  if (cached) return cached;
  if (inflight) return inflight;
  inflight = (async () => { /* … existing body … */ cached = …; inflight = null; return cached; })();
  return inflight;
}
```

**Cross-link:** `03-idempotency-deduplication-and-delivery-semantics.md` (where the cache pattern is discussed).

---

## #3 — Schema cache has no TTL — process-lifetime staleness  · severity: **info**

**Evidence:** `lib/mcp/schema.ts:190` (`if (cached) return cached;`) and `:211` (`_resetSchemaCache()` is test-only, no production reset).

**The risk:** If Bloomreach adds a new event type, customer property, or catalog after the Vercel instance warmed up, the agents won't see it until the instance restarts. Vercel cycles instances often enough that this hasn't bitten — but the failure mode is "agent reasons about a workspace that doesn't match reality."

**The fix when it starts mattering:** add a TTL (5 minutes is plausible) or an LRU keyed by `projectId` so switching workspaces also invalidates. Bigger fix: move the schema cache to Redis/KV with the same TTL.

**Cross-link:** `04-consistency-models-and-staleness.md` (the process-lifetime staleness corner).

---

## #4 — Per-instance ephemeral state requires a URL-param workaround  · severity: **info**

**Evidence:** `lib/state/insights.ts:14` (the per-process `state` Map) and `app/api/agent/route.ts:35` (`resolveAnomaly` reads three sources in order: `?insight=<JSON>` URL param, then same-instance Map, then demo snapshot).

**The risk:** A briefing that fills the `insights` Map on instance A leaves instance B's Map empty. Without the `?insight=` URL hack (the feed page stashes the Insight in `sessionStorage` and threads its JSON through the investigate URL), an investigation request landing on a fresh instance would return 404 "insight not found."

**What happens in practice:** the hack works — the client-side stash is the cross-instance bridge. But it means the API contract for `/api/agent` includes "you should also pass the Insight JSON" which is unusual.

**The fix when it starts mattering:** move insights/investigations to Redis/KV. Removes the URL hack from the contract.

**Cross-link:** `04-consistency-models-and-staleness.md` (the per-instance staleness deep walk) · `05-replication-partitioning-and-quorums.md` (the migration path that solves this).

---

## #5 — Cancellation deliberately not propagated in one client hook  · severity: **info (documented, deliberate)**

**Evidence:** `lib/hooks/useInvestigation.ts:33-37`:

> we deliberately do NOT cancel the fetch on effect cleanup. React StrictMode (dev) mounts → cleans up → re-mounts; cancelling on the first cleanup, with the started-guard blocking the re-mount, aborted the stream and left the logs empty.

**The risk:** If a user clicks an investigation card, then navigates away mid-stream, the upstream MCP calls keep running until the 300s deadline. Wasted Anthropic + Bloomreach calls, no UI to receive them.

**What happens in practice:** the cost is real on truly aborted runs, but the dev-mode StrictMode breakage is worse. The guard pattern (`startedRef.current`) prevents the double-fetch in dev; the in-flight run completes in prod with no consumer (`setState` after unmount is a safe no-op).

**The fix when it starts mattering:** detect StrictMode (or use a stronger "single-mount" pattern with a ref-based abort that only fires after a delay confirming the second mount didn't come) and re-enable cancel-on-cleanup. Low priority; the dev experience is the bigger win.

**Cross-link:** `06-queues-streams-ordering-and-backpressure.md` (the cancellation pattern this is an exception to).

---

## #6 — No write path = no idempotency keys, no compensation, no outbox  · severity: **deliberate**

**Evidence:** `lib/data-source/synthetic-data-source.ts` tool dispatch — every case returns a read result. `lib/mcp/tools.ts` enumerates only `list_*`/`get_*`/`execute_*` tools across the five tool catalogs. The `Recommendation.steps[]` field is plain text for the user to execute manually in Bloomreach's UI.

**Why this is deliberate, not a gap:** the product's pitch is "an analyst that shows its work" — propose, don't execute. The user keeps agency over real Bloomreach writes. Adding execution would add: idempotency keys (Bloomreach API would need to support them, or we'd need a client dedup table), a reconciliation log (durable per-step state), compensation handlers (some steps reversible, some not), an outbox (only if we add a local datastore), and an orchestrator. None of that is cheap, and none of it earns its place when the user is already a competent orchestrator with Bloomreach's UI open.

**Cross-link:** `08-sagas-outbox-and-cross-boundary-workflows.md` (the full deep walk).

---

## #7 — No replication, no shared cache, no leader election  · severity: **deliberate**

**Evidence:** the absence of any Redis client, KV client, Postgres driver, or coordination library in `package.json`. State is per-instance in-memory Maps + a gitignored dev file + committed demo JSON snapshots.

**Why this is deliberate, not a gap:** one upstream, read-only tools, no fan-out, no second writer. The architectural pressure that *would* push us into real coordination (multi-user shared workspaces, persistent investigations, background scheduled jobs) doesn't exist yet.

**Cross-link:** `05-replication-partitioning-and-quorums.md` (the full Case B walk and migration path).

---

## #8 — `lastCallAt` updates on error (good!) — but does not protect against burst-and-fail  · severity: **info**

**Evidence:** `lib/data-source/bloomreach-data-source.ts:200`:

```ts
} catch (err) {
  this.lastCallAt = Date.now();   // ← even on error
  throw new McpToolError(name, errorDetail(err), { cause: err });
}
```

**Why this is here:** without it, a string of consecutive failures would each fail immediately and try again immediately, hammering the upstream while it's already unhappy.

**Why it's listed:** this is a *good* pattern, but it has a subtle limit — if the *very first* call fails fast (DNS, TLS, instant 401), then the second call also runs ~1.1s later, fails again, and the user waits N × 1.1s seeing one failure each. There's no exponential backoff on transport errors (only on rate-limit envelopes). The 30s per-call timeout caps the worst case.

**The fix when it starts mattering:** classify transport errors and apply backoff to repeated ones — but this is over-engineering for a single-user CLI-ish use case. Listed for completeness.

**Cross-link:** `02-partial-failure-timeouts-and-retries.md` (the retry ladder).

---

## #9 — Reconnect predicate divergence — two regex variants, deliberately not unified  · severity: **info (documented)**

**Evidence:** `lib/hooks/useReconnectPolicy.ts:33-34`:

```ts
const AUTH_ERROR_RE_AUTO   = /invalid_token|unauthor|forbidden|401|session expired|reconnect/i;
const AUTH_ERROR_RE_BUTTON = /unauthor|forbidden|401|session expired/i;
```

**The risk:** The button predicate is missing `invalid_token` and `reconnect`. So an auth-shaped error that *auto* matches one of those would not match the manual-button predicate — meaning if auto-reconnect already fired (and the flag is set), the user sees an error UI but no reconnect button to click.

**Why this is deliberate (per the comment):** unifying the regexes would need live verification against the alpha Bloomreach server to be sure the manual-button case doesn't change for the worse. Filed as a latent bug; not this refactor's job.

**Cross-link:** `02-partial-failure-timeouts-and-retries.md` (the reconnect policy walk).

---

## #10 — Anthropic streaming, retries, and timeouts not in our control  · severity: **info**

**Evidence:** `lib/agents/intent.ts:21` and the AptKit adapters layer in `lib/agents/aptkit-adapters.ts` (the model provider wrapper). We pass `signal` through to the SDK; we don't wrap it in our own retry/timeout/backoff.

**Why this is mostly fine:** Anthropic's SDK has its own internal retry on transient errors. Our route-level 300s budget bounds the worst case. The signal propagation means tab-close cancels in-flight model calls.

**The risk:** if Anthropic API behavior changes (different rate-limit shape, more transient failures), we have no application-level retry to catch it. Errors propagate as-is into the NDJSON `error` event.

**The fix when it starts mattering:** wrap the SDK with a retry like the BloomreachDataSource one, but classification differs (HTTP 429 vs Bloomreach's body-embedded envelope). Low priority because we don't hit the rate limit at our volume.

---

## Top finding

**#1 (per-instance rate-limit spacing)** is the highest-leverage *real* gap in the current shape — every other warning is either deliberate, dev-only, or already self-healing. Two warm instances doubling the effective rate against a per-user upstream rate limit is the single risk most likely to bite under any non-trivial load increase, and the fix (shared `lastCallAt` in KV) is a clean one-pattern lift.

## Reading order for the audit

1. Skim #1, #2 first — the two warnings worth acting on.
2. Read #3, #4, #5 to know what's tolerated and why.
3. Read #6, #7 to defend the deliberate gaps in interviews.
4. #8–#10 are info-level — useful to know, not actionable today.

## See also

- `02-partial-failure-timeouts-and-retries.md` — the deep walk that informs #1, #8, #9, #10.
- `03-idempotency-deduplication-and-delivery-semantics.md` — informs #2.
- `04-consistency-models-and-staleness.md` — informs #3, #4.
- `05-replication-partitioning-and-quorums.md` — the migration path that resolves #1, #3, #4.
- `06-queues-streams-ordering-and-backpressure.md` — informs #5.
- `07-clocks-coordination-and-leadership.md` — the cookie pattern that models the fix for #1.
- `08-sagas-outbox-and-cross-boundary-workflows.md` — defends #6.
