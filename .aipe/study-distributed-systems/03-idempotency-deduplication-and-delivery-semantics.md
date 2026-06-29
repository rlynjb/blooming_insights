# Idempotency, deduplication, and delivery semantics

*Industry standard — duplicate work, idempotency keys, at-most-once / at-least-once / exactly-once.*

## Zoom out — where delivery semantics matter

Delivery semantics matter when *the same logical operation might be sent more than once* and *the duplicate could change observable state*. In `blooming_insights`, that's a narrow seam — and most of it is on the safe side of the fence.

```
  Where this concern lives — and where it doesn't

  ┌─ L1: Browser ─────────────────────────────────────────────┐
  │  user clicks a card · navigates · React StrictMode mounts  │
  │  → could trigger duplicate fetches → consumer-side dedup    │
  └─────────────────────────┬─────────────────────────────────┘
                            │
  ┌─ L2: Route ─────────────▼─────────────────────────────────┐
  │  GET /api/briefing — idempotent (reads the workspace)      │
  │  GET /api/agent      — idempotent (reads investigation)    │
  │  POST /api/mcp/call  — wraps one read call (idempotent)    │
  │  GET /api/mcp/callback — OAuth code exchange (★ MUTATIVE ★) │
  └─────────────────────────┬─────────────────────────────────┘
                            │
  ┌─ L3: BloomreachDataSource ────────────────────────────────┐
  │  retry ladder retries isError envelopes — safe because…    │
  └─────────────────────────┬─────────────────────────────────┘
                            │
  ┌─ L4: Bloomreach MCP ────▼─────────────────────────────────┐
  │  every tool call is a READ                                 │
  │   list_*, get_*, execute_analytics_eql                     │
  │  no tool in the allowlist mutates Bloomreach state         │
  └────────────────────────────────────────────────────────────┘
```

This file's load-bearing claim: **every tool call this codebase makes is a read, so the retry ladder is safe without an idempotency key**. The exception is OAuth code exchange in the callback route — that's the one place a duplicate could hurt, and the SDK handles it.

## Zoom in — the question this file answers

> When the same request, tool call, or React mount fires twice, does the system end up in a different state than if it had fired once?

Short answer: no, with three asterisks (the OAuth callback, the cache key, the React-StrictMode mount). The rest of this file unpacks why.

## Structure pass — the skeleton

### Axes — trace mutability

The right axis is **does this operation change observable state?** Trace it across the layers.

```
  One axis: "does this change state visible to anyone else?"

  L1 Browser
    fetch(...) twice           → idempotent if the route is
    sessionStorage write twice → same key, same value → no-op

  L2 Route
    GET /api/briefing twice    → idempotent (read-only on the wire)
    GET /api/agent twice       → idempotent (read-only on the wire)
    POST /api/mcp/call twice   → idempotent (wraps a read call)
    GET /api/mcp/callback twice → ★ NOT IDEMPOTENT ★
      (consumes the one-time OAuth code; second call should 401)

  L3 DataSource
    callTool retry             → safe because the call is a read

  L4 Bloomreach
    list_*, get_*, execute_*   → READS · all idempotent
    (no writes in the allowlist) → no idempotency key needed
```

The axis flips exactly once — at the OAuth callback. Everywhere else, the answer is "no, this is a read."

### Seams — where duplicate-work could enter

```
  Three places a duplicate could be born — and what catches it

  source of duplicate                              caught by
  ────────────────────                              ─────────
  React StrictMode double-mount in dev              startedRef guard
                                                    (lib/hooks/useInvestigation.ts:46)

  Auto-reconnect on 401 invalid_token               replays the same GET
                                                    (idempotent — wire is a read)

  Retry ladder retries an isError envelope          safe because every
                                                    tool is a read
                                                    (bloomreach-data-source.ts:164)
```

The first one is interesting because it's the only place in the codebase where a *consumer-side dedup* is the load-bearing mechanism. The other two are safe by construction.

### Layered decomposition — the same question, two altitudes

```
  "What does duplicate work cost?" — held constant down

  outer: HTTP request           cost: time + Bloomreach rate-limit budget;
                                no state change (reads only)

  inner: in-process retry        cost: time + 1.1s spacing wait;
                                no state change (reads only)

  innermost: cache lookup        cost: nothing — same key, same value,
                                consumer reads cache, never hits wire
```

The cost of a duplicate falls as you descend. At the wire, a duplicate costs a Bloomreach round-trip. Inside the request, the 60s cache makes the second call free. Inside the request *and* across requests on the same warm instance, the cache makes it free again — until TTL or restart. **The cache is the deduplication layer the system doesn't call deduplication.**

## How it works

### Move 1 — the mental model

You've handled this in the frontend: `useEffect` with a `key`, React Query's `staleTime`, a debounce on a search input. The same primitive applies here — **a cache keyed by `(operation, inputs)` is the cheapest deduplicator**, and that's what `BloomreachDataSource.cache` is.

> **Because every Bloomreach tool call is a read, "duplicate work" reduces to "wasted time + rate-limit cost." The 60s response cache (keyed by `name + JSON.stringify(args)`) is the dedup mechanism. No idempotency keys needed.**

```
  The dedup kernel — cache-as-deduplicator

  call 1: callTool('get_event_schema', {project_id: 'wobbly-ukulele'})
              │
              ▼
        cacheKey = "get_event_schema:{\"project_id\":\"wobbly-ukulele\"}"
              │
              ▼
        cache miss → wire → 1.4s → result → cache.set(key, result, 60s)
              │
              ▼
        return { fromCache: false }

  call 2: (same args, 10s later)
              │
              ▼
        cacheKey = same
              │
              ▼
        cache hit, expiresAt > now → return cached
              │
              ▼
        return { fromCache: true }  ← no wire hop, no dedup needed
```

The mechanism is two lines (`bloomreach-data-source.ts:144-152`):

```ts
const cacheKey = `${name}:${JSON.stringify(args)}`;
const ttl = options.cacheTtlMs ?? 60_000;

if (!options.skipCache) {
  const cached = this.cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { result: cached.result as T, durationMs: 0, fromCache: true };
  }
}
```

### Move 2 — walk it one part at a time

#### Part 1 — the cache key (the dedup contract)

`${name}:${JSON.stringify(args)}` is the dedup contract. Two calls share a cache entry iff their tool name and their args stringify identically. There's a real subtlety here.

```
  Cache key gotcha — JSON.stringify on objects is order-sensitive

  call A: callTool('execute_analytics_eql', { eql: 'a', project_id: 'p' })
       key: "execute_analytics_eql:{\"eql\":\"a\",\"project_id\":\"p\"}"

  call B: callTool('execute_analytics_eql', { project_id: 'p', eql: 'a' })
       key: "execute_analytics_eql:{\"project_id\":\"p\",\"eql\":\"a\"}"
                                              ↑
                                              DIFFERENT KEY
                                              → both calls hit the wire
                                              → cache stores two entries
                                              → no dedup
```

In practice this is not currently observed because the agents pass args via the same Claude-generated tool-call JSON, which doesn't reorder keys between turns. But it's a real load-bearing assumption: **the dedup works because object key order is stable across calls in this codebase**. If a future caller normalizes args differently, the cache misses silently. Worth a comment in the code; not currently flagged in tests.

The cache key includes `args`, not `project_id` alone — so two project_ids on the same warm instance correctly get separate cache entries. That's not the gap; the schema bootstrap cache is. → see file 04.

#### Part 2 — the retry ladder is safe because every tool is a read

The retry ladder (`bloomreach-data-source.ts:164-174`) re-issues the same `(name, args)` until success or `maxRetries` exhaustion. With a normal API, that's an *at-least-once* delivery — and "at least once" matters if the call mutates state. Here it doesn't, because the only calls made are reads.

The allowlist of tools the route layer permits, from `app/api/mcp/call/route.ts:15-20`:

```ts
const ALL_KNOWN = new Set<string>([
  ...monitoringTools,
  ...diagnosticTools,
  ...recommendationTools,
  ...bootstrapTools,
]);
```

And from `lib/mcp/tools.ts` — every name in those four lists is `list_*`, `get_*`, or `execute_analytics*`. Zero writes.

```
  Tool name shapes — pattern, not exhaustive

  list_*         e.g. list_cloud_organizations, list_projects, list_catalogs
                 list_segmentations, list_email_campaigns, list_voucher_pools
                 ALL READS

  get_*          e.g. get_project_overview, get_event_schema,
                 get_customer_property_schema, get_funnel
                 ALL READS

  execute_analytics(_eql)
                 runs an EQL query against the workspace, returns rows
                 NO MUTATION (EQL is analytical, not transactional)
```

**What breaks if a writeable tool gets added to the allowlist.** A `create_scenario` or `update_segmentation` tool, retried under rate-limit, would create the same scenario twice. The retry ladder has no idempotency key to dedupe with. The fix is one of: (a) an idempotency key in the request args (matched on the server), (b) the retry ladder learns to skip mutating tool names, (c) the new tool gets a different code path entirely. **None of these exist today; if the product grows write-back-to-Bloomreach actions, this becomes urgent.** → file 09.

The recommendation agent today addresses this by *proposing* Bloomreach actions in prose (a `Recommendation { steps[], bloomreachFeature, … }` object the UI renders), not by *executing* them. That's the discipline that keeps the wire read-only.

#### Part 3 — the OAuth callback is the only mutative call

The callback at `app/api/mcp/callback/route.ts:17-33`:

```ts
const code = params.get('code');
if (!code) return NextResponse.json({ error: 'missing code' }, { status: 400 });
const sid = await readSessionId();
if (!sid) return NextResponse.json({ error: 'no session' }, { status: 400 });

try {
  await completeAuth(sid, code);
  return NextResponse.redirect(new URL('/', req.url));
} catch (e) {
  return NextResponse.json({ error: String(e) }, { status: 401 });
}
```

The `completeAuth` call exchanges the one-time OAuth `code` for tokens. The code is *single-use* by spec — a duplicate exchange should be rejected by the IdP with `invalid_grant`. So:

```
  Callback idempotency — relies on the IdP, not on us

  duplicate GET /api/mcp/callback?code=ABC
       │
       ▼
   first call:  IdP exchanges code ABC for tokens, saveTokens(sid, t)
       │
       ▼
   second call: IdP rejects code ABC with invalid_grant
       │
       ▼
   we return 401 JSON (the catch branch above)
       │
       ▼
   tokens stored from first call remain valid; second call is a no-op
       from the perspective of our auth state
```

This is the right design — the IdP is the source of truth for code-single-use, and our callback handler relays its verdict. **What we don't do** is also instructive: we don't re-validate the OAuth `state` parameter (`callback/route.ts:22-26` calls this out). The MCP SDK calls the provider's `state()` multiple times per flow, so our naive store-last-compare-on-callback rejected legitimate callbacks; we removed it and trust the SDK's state handling. That's *consume-state-as-a-side-effect-once* delegated to a library — a defensible call, anchored in a live verification dated 2026-05-27.

#### Part 4 — the StrictMode dedup in the React hook

The other place a duplicate could be born is the dev-mode React StrictMode double-mount. The investigation hook (`lib/hooks/useInvestigation.ts:46-49`) guards against it explicitly:

```ts
useEffect(() => {
  if (!id) return;
  if (startedRef.current) return; // run once per mount (survives StrictMode)
  startedRef.current = true;
  // … fetch …
}, [/* … */]);
```

This is a *consumer-side dedup* — the fetch is idempotent (it's a read on the route side), but firing it twice would consume two units of Bloomreach rate-limit budget for one user action. The `startedRef.current` guard is the fix.

The comment in the file is precise about the failure mode it fixes: cancelling on cleanup *and* using the guard means the cleanup aborts the in-flight stream and the re-mount short-circuits — empty log. The current design: guard set on first mount, no cleanup cancellation, second mount short-circuits, in-flight stream completes naturally.

```
  StrictMode double-mount — three designs, one survives

  design                         dev StrictMode behavior          verdict
  ──────                         ────────────────────             ───────
  no guard, no cancel             two fetches fire in parallel    fail (dup work)
  no guard, cancel on cleanup     first fires, gets cancelled,    fail (one cancelled
                                  second fires, completes          before any logs)
  guard, no cancel                first fires, second short-       ★ WORKS ★
                                  circuits, first completes        (current design)
  guard, cancel on cleanup        first fires + immediately        fail (cancel + guard
                                  cancels, second is blocked       leaves nothing)
                                  by guard, nothing runs
```

The fourth row is the one that broke and forced the rule — see the inline comment at `useInvestigation.ts:30-37` for the war story.

#### Part 5 — delivery semantics on the NDJSON stream

The stream from route to browser is *at-most-once* per event. There's no replay, no offset, no resend on disconnect. If the browser closes the tab mid-stream, the events not yet read are lost — but the route also detects this via `req.signal.aborted` and stops emitting (`app/api/agent/route.ts:308-310`).

```
  NDJSON delivery — one writer, one reader, no replay

  controller.enqueue(line)  ──HTTPS──►  reader.read()
       │                                       │
       │                                       │
       └─ if browser closes, request aborts ───┘
          (req.signal.aborted in the route detects it)
          route emits no further events, request completes
          events already in the OS buffer may or may not
          reach the reader — there is no acknowledgement
```

This is **at-most-once with no retry, no offset, no exactly-once**. It's fine because:
- the *result* of a briefing or investigation is cacheable in the route's in-memory store (`saveInvestigation`, `putInsights`); a reconnect re-runs the briefing or replays from cache
- there's no consumer that *needs* exactly-once — the browser renders state, not a financial ledger

If a future consumer needs exactly-once (e.g. a webhook receiver, an event sink in a downstream system), this transport is the wrong tool. → file 09.

### Move 2.5 — current state vs future state

```
  Today (read-only)              vs.   Tomorrow (write-back)
  ─────────────────────────             ──────────────────────────
  every tool is a read                  proposed Recommendations
                                         become executable in
                                         Bloomreach (POST scenarios,
                                         create segments, etc.)

  retry ladder is safe                  retry ladder is dangerous
   because reads are idempotent          without idempotency keys

  60s cache deduplicates                cache must NOT serve a
   reads transparently                   write — skipCache always

  no need for a request-id              would need a request-id
                                         per write, matched server-side
```

The product's whole "an analyst that shows its work" pitch is read-only by design; recommendations are *prose*, not *POSTs*. That's not a missing feature, it's the load-bearing product decision that keeps the delivery-semantics surface this clean. If the product ever ships the "one-click apply" version of recommendations, this file's content gets a section called *idempotency keys and the write seam*.

### Move 3 — the principle

> **Idempotency is a property of the operation, not the protocol. If everything you do is a read, you don't need an idempotency key — the read itself IS your dedup contract. If you do one mutation, design that one path with care; don't generalize.**

The discipline this file demonstrates is *naming the writes*. The callback is the only one. Everything else is a read, dedup'd by cache. The framework for thinking about a new feature is *which side of this fence does it land on?* — and if it's on the write side, the work to do is named and bounded.

## Primary diagram — the dedup map

```
  Delivery semantics, drawn flat

  ┌─ L1 Browser ──────────────────────────────────────────────┐
  │  StrictMode dev double-mount                                │
  │   → useInvestigation.ts:46 startedRef guard (consumer dedup) │
  │  Auto-reconnect on 401                                       │
  │   → re-issues idempotent GET (route is a read)               │
  └─────────────────────────────────────────────────────────────┘
                          │ HTTPS · NDJSON · at-most-once
                          ▼
  ┌─ L2 Route ────────────────────────────────────────────────┐
  │  GET /api/briefing   read                                   │
  │  GET /api/agent      read                                   │
  │  POST /api/mcp/call  read-only wrapper (allowlist enforced) │
  │  GET /api/mcp/callback ★ MUTATIVE: OAuth code exchange ★    │
  │   (single-use enforced server-side by IdP)                  │
  └─────────────────────────────────────────────────────────────┘
                          │
                          ▼
  ┌─ L3 BloomreachDataSource ─────────────────────────────────┐
  │  60s cache · key = `${name}:${JSON.stringify(args)}`        │
  │  retry ladder re-issues same args until success/exhaustion  │
  │  safe because every call is a read                          │
  └─────────────────────────────────────────────────────────────┘
                          │
                          ▼
  ┌─ L4 Bloomreach ───────────────────────────────────────────┐
  │  list_* · get_* · execute_analytics(_eql) — READ-ONLY      │
  │  no write tool in the allowlist                            │
  └─────────────────────────────────────────────────────────────┘
```

## Elaborate

The "read-only by design" stance is the deepest source of safety in this codebase. The same posture shows up in:

- **CQRS (Command/Query Responsibility Segregation, Greg Young).** Queries and commands as separate code paths with separate semantics. Here, the "query" path is everything; the "command" path doesn't exist yet (recommendations are prose).
- **REST safety (RFC 7231 §4.2.1).** GET is safe and idempotent by spec; POST is neither. The route layer uses GET for all read-only paths and POST only for the OAuth callback's inverse (`/api/mcp/reset`, which clears auth — also idempotent in the sense that "clearing twice" leaves the same state).
- **Idempotency keys at Stripe / GitHub.** The canonical pattern for mutating APIs. Worth knowing the shape even though the codebase doesn't need it today: client generates a UUID, server stores `(key, response)` for some window, second request with same key returns the stored response. The work to graft this onto a future `execute_recommendation` tool is mostly server-side at Bloomreach, not ours.

The interesting comparison is **at-most-once vs at-least-once vs exactly-once.** This codebase is at-most-once on the wire-out (NDJSON stream — no replay) and at-least-once on the wire-in (Bloomreach retries up to 3x). Both choices are safe because of the read-only invariant. The famous "exactly-once is a lie" framing (Kreps, Confluent) applies if you ever need it: exactly-once on the wire is impossible; exactly-once *effects* are achieved by combining at-least-once delivery with idempotency. Today we get exactly-once effects for free because reads are naturally idempotent.

## Interview defense

### "What's your delivery guarantee on the NDJSON stream?"

At-most-once with no replay. The route emits each event with `controller.enqueue(encodeEvent(e))`; the browser reads them via `readNdjson` with `fetch + reader.read()`. There's no acknowledgement, no offset, no resend. The route detects browser disconnects via `req.signal.aborted` and stops emitting — clean failure, no zombie writes. This is fine because the *result* (insights, investigations) is recoverable: the route caches successful runs (`saveInvestigation` in `lib/state/investigations.ts`), and the demo path replays from a committed JSON snapshot. If the user disconnects mid-stream, reconnecting either replays from the in-memory cache (same instance) or re-runs the agent (different instance) — both deterministic enough to land in the same place.

```
  Anchor: app/api/agent/route.ts:185-189 — controller.enqueue
          lib/streaming/ndjson.ts:31-44 — read loop
          app/api/agent/route.ts:308-310 — abort detection
```

### "Why is the retry ladder safe without an idempotency key?"

Because every Bloomreach tool call in the allowlist is a read — `list_*`, `get_*`, or `execute_analytics_eql`. There's no write to deduplicate. The retry ladder re-issues the same `(name, args)`; the second call returns the same data the first would have, plus or minus a rate-limit window. The first thing I'd change if the product added executable recommendations (POSTs to Bloomreach to create scenarios/segments) is to add per-call idempotency: either an idempotency key in the request (Bloomreach-side), or a code-path that skips the retry ladder for writes and surfaces failures eagerly.

*Anchor:* `app/api/mcp/call/route.ts:15-20` — the allowlist is sourced from the same constants the agents use, so writes can't slip in via the agent path either.

### "Is there exactly-once anywhere in the system?"

No — and we don't need it. Exactly-once *delivery* doesn't exist anywhere; exactly-once *effects* live where they're forced (idempotent reads, IdP-enforced OAuth code single-use). The only mutative operation in the codebase is OAuth code exchange in the callback route, and its single-use guarantee is enforced server-side by the IdP (`invalid_grant` on the duplicate). We don't carry state across to dedupe ourselves. If the product grew an executable-recommendations flow tomorrow, we'd graft idempotency keys onto that one path; we wouldn't try to make the whole system exactly-once.

## See also

- `02-partial-failure-timeouts-and-retries.md` — the retry ladder this file justifies as safe.
- `04-consistency-models-and-staleness.md` — why the 60s cache (the dedup mechanism) is safe across requests.
- `07-clocks-coordination-and-leadership.md` — OAuth state survival, the only mutative seam.
- `09-distributed-systems-red-flags-audit.md` — the write-back-to-Bloomreach risk ranked.
- `.aipe/study-security/` — the allowlist as a security boundary, not just a delivery-semantics one.
