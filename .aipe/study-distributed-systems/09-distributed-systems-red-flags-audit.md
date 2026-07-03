# distributed-systems-red-flags-audit

*Ranked risks · Present + future · Coordination hazards*

## Zoom out — where this file sits

This is the final file in the guide. Everything above walked how the
system COORDINATES ACROSS partial failure; this file walks WHERE it's
still exposed. Ranked by consequence — the top items are what a real
production incident would come from; the bottom items are noted for
completeness or for when the product grows into them.

```
  Zoom out — where the risks live

  ┌─ Client layer ────────────────────────────────────┐
  │  RISK: browser tab closes = investigation lost    │
  │  RISK: cross-tab dedup does not exist             │
  └───────────────────────┬───────────────────────────┘
                          │
  ┌─ Service layer ───────▼───────────────────────────┐
  │  RISK: fault-injection subsystem is real (asset)  │
  │  RISK: single external system, alpha-quality      │
  │  RISK: no shared cache across warm instances      │
  │  RISK: step-3 hard error on missing diagnosis     │
  │  RISK: split-step runs don't persist              │
  └───────────────────────┬───────────────────────────┘
                          │
  ┌─ Provider layer ────────────────────────────────────┐
  │  RISK: alpha token revocation (minutes)             │
  │  RISK: no idempotency protocol on Bloomreach        │
  │  RISK: Anthropic cost blowout on runaway loops      │
  └────────────────────────────────────────────────────┘
```

The findings are ranked by consequence, with the load-bearing test
applied to each: **if this fired in production tomorrow, what
specifically would the system lose?**

## Ranked findings

### #1 — Fault-injection subsystem is real (ASSET, not risk)

Lead with the good news. The Week-4B fault-injection subsystem at
`lib/data-source/fault-injecting.ts` is a genuine distributed-systems
asset. Four canonical failure modes, deterministic when seeded,
proven to exercise graceful degradation via the tool_result
`is_error: true` path. Receipt at
`eval/load-receipts/load-2026-07-03T05-21-12-237Z.json` shows 9 faults
injected across 3 investigations, 0 failures.

**Why it's the top finding**: because most codebases in this shape
claim "we handle failures gracefully" and can't prove it. This one
proved it. The `FaultInjectingDataSource` decorator sits on the
`DataSource` seam and wraps ANY concrete adapter. Reproducing a specific
failure mode is `FAULT_TIMEOUT=0.2 FAULT_SEED=42` — one env-var pair.

**Verdict**: strength. Cross-link: file 02, band 4.

### #2 — Single external system, alpha-quality (LIVE RISK)

The whole product depends on the Bloomreach `loomi-mcp-alpha` server.
Documented failure modes:

- rate-limits per user globally (~1 req/s, "1 per 10 second" observed
  windows)
- revokes tokens after minutes (per `.aipe/project/context.md` line 44)
- occasionally times out (why the 30s ceiling exists at
  `lib/mcp/transport.ts:38`)

**Load-bearing test**: if `loomi-mcp-alpha` is down for an hour, the
live path is dead. Users see auth errors, timeouts, or empty briefings.
The demo path still works (replays from committed
`lib/state/demo-*.json`), which is the correct fallback for a "reliable
presentation surface."

**Verdict**: fundamental to the product; not fixable without adding a
second data source. The DataSource seam is what makes that
architecturally possible (see finding #1). Cross-link: file 01.

### #3 — No shared cache across warm instances (MODERATE RISK)

Every warm Vercel instance has its own
`BloomreachDataSource.cache` Map at
`bloomreach-data-source.ts:122`. Two instances serving the same user
each pay full cost for the same tool call. In practice this is fine —
one request opens one stream lives on one instance — but under
concurrent multi-instance traffic patterns (say, if the user opens
two tabs), Bloomreach's rate-limit budget is burned twice on the
same call.

**Load-bearing test**: user opens two tabs and clicks briefing on
both simultaneously. Both hit Bloomreach with the same calls. The
instance-local caches don't help. Both pay ~1 req/s.

**Fix path**: Vercel KV shared cache. Not implemented today; wouldn't
be hard to add behind a `SharedCacheDataSource` decorator on the same
seam.

**Verdict**: moderate. Cross-link: files 03, 04.

### #4 — Alpha token revocation forces re-auth flow as core UX (LIVE RISK)

Because the alpha revokes tokens after minutes, the app must handle
mid-investigation auth failures as a first-class UI feature. This is
done via the "reconnect" button on auth errors (feed page,
per `.aipe/project/context.md` line 45) and the auto-reconnect logic
that resets auth and reloads once (guarded).

**Load-bearing test**: user starts an investigation, waits 90 seconds
(intermediate agent turn), Bloomreach revokes the token. Next tool
call 401s. The route surfaces `HTTP 401: <invalid_token body>` as a
McpToolError. The client detects the invalid-token pattern and resets
auth.

**What's brittle**: the detection is text-pattern-based on the error
body. If Bloomreach changes their error envelope, the auto-reconnect
stops working silently. Named as a future-proofing risk.

**Verdict**: moderate; the fix is defensive parsing that recognizes
multiple envelope shapes. Cross-link: file 07.

### #5 — Runaway model loops burn budget (MODERATE RISK, MITIGATED)

The agent loop is bounded by:

- `BudgetTracker` per-investigation (`lib/agents/budget.ts`, checked at
  `aptkit-adapters.ts:63-66`) — throws `BudgetExceededError` before
  each model dispatch if the ceiling is hit; default $2.0/investigation
  per `eval/load.eval.ts:91`
- Vercel `maxDuration=300` — hard 5-minute ceiling per request
- Anthropic's built-in retry-on-5xx and model-level limits
- The 30s per-call MCP timeout (files 02, transport)

**Load-bearing test**: model gets stuck in a loop calling the same
tool with variations. Budget tracker catches it at ~$2.00. Route
emits graceful `{type: "error"}` NDJSON event. User sees an error, not
a blown budget.

**What's brittle**: the budget checks INPUT+OUTPUT tokens, not
cache-read tokens (per comment at `aptkit-adapters.ts:104-106`), so
the tracker is slightly conservative with caching on. Named for
transparency; not a real problem.

**Verdict**: moderate risk, well-mitigated. The budget tracker is the
correct escape hatch.

### #6 — No cross-user coordination anywhere (BY DESIGN, becomes RISK if product grows)

There is no shared state, no leader election, no distributed locking.
Every user's investigation is independent. This is correct for the
current product shape (one user, one workspace, one analysis).

**When it becomes a risk**: any of these product changes:

- **Team workspace view** — multiple users see shared analysis. Needs
  shared state and cross-user consistency.
- **Scheduled reconciliation** — nightly refresh of every user's
  briefing. Needs a job scheduler with leader election.
- **Bloomreach webhook receiver** — real-time events into our system.
  Needs a durable queue and consumer group.

**Verdict**: named honestly. Cross-link: files 05, 06, 07.

### #7 — Step-3 hard error on missing diagnosis (LOW RISK, ROUGH EDGE)

If a user navigates directly to `/investigate/[id]/recommend` cold
(no step 2 run), the server throws:
`"no diagnosis was handed over — open the diagnosis step first"`
(at `app/api/agent/route.ts:271`).

**Load-bearing test**: user bookmarks a step-3 URL and returns to it
the next day. Step 3 fails hard. User has to click back to the feed
and start over.

**Fix path**: detect missing diagnosis client-side and redirect to
step 2, or auto-run the combined path.

**Verdict**: low; a one-day fix. Cross-link: file 08.

### #8 — Split-step runs don't persist (LOW RISK, ROUGH EDGE)

Only the combined-run path (`step === null`, used by the demo-capture
script) writes to `saveInvestigation` at
`app/api/agent/route.ts:302`. Split-step runs stash to sessionStorage
client-side only.

**Load-bearing test**: user runs split-step investigation, closes
tab. Server has no record. Re-opening `/investigate/[id]` runs
step 2 again from scratch.

**Verdict**: low; probably the right behavior for now (persistence
without a real store is contrived). If we grew "history of every
investigation" as a feature, we'd revisit.

### #9 — Cache key uses `JSON.stringify(args)` — key-order fragility (LOW RISK)

The cache key at `bloomreach-data-source.ts:144` is
`${name}:${JSON.stringify(args)}`. If the model produces args in a
different key order across turns (unlikely but possible), the cache
misses. This is a latent bug that manifests as "why is the cache
never hitting" rather than a hard failure.

**Fix path**: canonical stringification (sort keys). Small change.

**Verdict**: low; hypothetical today.

### #10 — Malformed JSON path only tested via fault injection (LOW RISK)

Real Bloomreach almost never returns malformed JSON — the fault
injection subsystem was built to test THAT path specifically. If it
did happen in production, the `unwrap` helper at
`lib/mcp/schema.ts:36-43` calls `JSON.parse(text)` and throws on
error. The throw propagates to the transport layer, gets wrapped as
`McpToolError`, and reaches the agent loop where it becomes
`tool_result` `is_error: true`.

**Load-bearing test**: fault-injection Week-4B smoke test proved 5
malformed_json injections were absorbed without failing an
investigation.

**Verdict**: low; the fault-injection subsystem IS the mitigation
receipt.

## Absent-and-honest — mechanisms not present, ranked by when they matter

Ranked from "matters soon" to "matters if scale changes drastically":

  1. **Shared cache across instances (Vercel KV / Redis)** — matters as
     soon as multi-tab or multi-user concurrent traffic is common
  2. **Idempotency keys on mutating tools** — matters the day a mutating
     tool ships (voucher issue, campaign send, segment update)
  3. **Durable inbound queue** — matters if we receive Bloomreach
     webhooks or add background jobs
  4. **Leader election for scheduled tasks** — matters if we ship
     scheduled reconciliation
  5. **Cross-instance sticky routing** — matters if we grew persistent
     per-user state that must live on one instance
  6. **Replicated log / event sourcing** — matters if we ship "history
     of every investigation" as a first-class feature
  7. **Distributed transaction coordinator** — matters if we spanned
     two mutating providers (unlikely in this product)

Named here so future audit updates can promote items as the product
grows.

## Verdicts, one line each

```
  #1  fault-injection subsystem      ASSET       — receipt proves it
  #2  single external system         LIVE RISK   — fundamental; DataSource seam limits blast
  #3  no shared cache                 MODERATE    — Vercel KV is the fix
  #4  alpha token revocation          LIVE RISK   — re-auth UI works; envelope parsing brittle
  #5  runaway model budget            MODERATE    — BudgetTracker is the escape hatch
  #6  no cross-user coordination      BY DESIGN   — becomes risk on product growth
  #7  step-3 hard error on cold nav   LOW         — one-day fix
  #8  split-step non-persistence      LOW         — deferred to future feature
  #9  cache-key JSON.stringify order  LOW         — canonical stringify is trivial
  #10 malformed JSON in production    LOW         — fault-injection is the mitigation receipt
```

## What kept me up before writing this file — and doesn't now

Writing this audit against the four bands + fault-injection receipt
was clarifying. The pre-Week-4B version of the code had all the
mechanisms EXCEPT the receipt. Now the receipt is a JSON file with a
seed you can re-run. The confidence that "we handle failures
gracefully" is not a claim anymore; it's a measurement.

The remaining live risks (#2, #4) are structural: the alpha server is
alpha; there's one of them. Neither is fixable without adding a second
data source or leaving the alpha, both of which are product-scope
decisions. The DataSource seam makes both future moves architecturally
possible without breaking the agents.

The rough edges (#7, #8, #9) are naming exercises. Each is a
follow-up ticket, not a fire.

## See also

- 01-distributed-system-map.md — the picture every finding above
  hangs off
- 02-partial-failure-timeouts-and-retries.md — the mechanisms that
  make the LIVE RISK findings survivable
- 08-sagas-outbox-and-cross-boundary-workflows.md — #7 and #8 in
  detail
- `../study-system-design/audit.md` — same repo, architecture lens
  rather than coordination lens
