# Distributed Systems — Red Flags Audit

*Ranked risks grounded in the codebase, worst first.*

This is the audit file. Each risk is named, evidenced with file paths, ranked by consequence, and paired with a move to make. No hedging; if it's a risk, say why. If it's mitigated, name the mitigation. If it's fine as-is, say so.

## The ranking

| # | Risk | Where | Consequence | Mitigation status |
|---|------|-------|-------------|-------------------|
| 1 | Per-instance cache is not a durability story | `bloomreach-data-source.ts:122` | Cold instance = every call round-trips; retry ladder must hold | Ladder holds; cache is opportunistic. Fine at current scale. |
| 2 | Read-only tool invariant is unenforced | `types.ts:63` | Adding a write tool silently breaks retry correctness | No enforcement in types or lint. Documented in this guide only. |
| 3 | `JSON.stringify` cache key assumes key order | `bloomreach-data-source.ts:144` | Different arg orders miss cache; wastes calls | Not a bug today; single-producer assumption. Would bite on multi-client. |
| 4 | Malformed JSON fault gets cached | `bloomreach-data-source.ts:178` + `fault-injecting.ts:148` | `isError: false` + broken content is cached for 60 s | The agent parses downstream and rejects; but cache poisoning persists until TTL. |
| 5 | No jitter on retry ladder | `bloomreach-data-source.ts:157` | Multi-instance thundering herd against Bloomreach | Rate limit gate + parsed retry window is loose defense. |
| 6 | Auth cookie is only cross-instance state | `auth.ts:86` | Cookie rotation / secret rotation requires a re-auth for all users | Documented; acceptable for a portfolio app. |
| 7 | `AUTH_SECRET` misconfiguration is a hard fail in prod | `auth.ts:52` | Unset → all auth fails at first request | Startup validation exists (throws in `aesKey()`). Would benefit from earlier boot check. |
| 8 | Retry ladder sleeps don't respect `req.signal` | `bloomreach-data-source.ts:167` | Client cancel doesn't interrupt a 20 s wait | Rare (only during retry); next `liveCall` sees the signal. |
| 9 | Investigations Map has no eviction | `state/investigations.ts:11` | Long-running instance grows memory; unlikely on Vercel serverless | Vercel instances recycle often; effectively self-clearing. |
| 10 | No dead-letter for tool errors | route handler | Errors ride through as `is_error: true`; model must handle | Working as designed — agent reasons around; monitored via fault-injection receipt. |

## Risk detail

### 1. Per-instance cache is not a durability story

**Evidence**: `lib/data-source/bloomreach-data-source.ts:122`

```ts
private cache = new Map<string, { result: unknown; expiresAt: number }>();
```

**The consequence**: on Vercel's autoscaling model, each cold-started instance has an empty cache. The retry ladder + spacing gate are what actually protect against Bloomreach 429s — the cache is a bonus for warm instances. If someone reads the code as "we have a cache so we won't hit rate limits," they'd be wrong.

**Why it stays**: the cache still absorbs duplicates within one investigation (all runs on one instance for its 300 s life). That's most of the value.

**The move (if scale demands)**: swap the Map for a shared KV client behind the same interface. Vercel KV or Upstash Redis; keep the 60 s TTL, share it across instances. See file 04's "Phase B" section.

### 2. Read-only tool invariant is unenforced

**Evidence**: `lib/data-source/types.ts:63`

```ts
export interface DataSource {
  callTool(name, args, opts?): Promise<DataSourceCallResult>;
  listTools(opts?): Promise<unknown>;
}
```

**The consequence**: the retry ladder retries rate-limited results, the cache memoizes non-error results. Both are safe only because MCP tools are read-only. If a write tool got added — a `create_campaign`, an `update_segment` — the ladder would double-execute the write on a 429, and the cache would memoize the response of a mutation.

**Why it stays unenforced**: the current tool set is all reads (`list_*`, `get_*`, `run_query`, `list_cloud_organizations`, etc.). The invariant is documented in files 02 and 03 of this guide, but the type system doesn't distinguish. AptKit's `ToolDefinition` shape (in `node_modules/@aptkit/core`) doesn't carry a "safe to retry" annotation either.

**The move**: tag tools with a `safeToRetry: boolean` in their schema. The retry ladder honors the tag; the cache honors the tag. Write tools would need an idempotency key + downstream dedup.

### 3. `JSON.stringify` cache key assumes single-producer key order

**Evidence**: `lib/data-source/bloomreach-data-source.ts:144`

```ts
const cacheKey = `${name}:${JSON.stringify(args)}`;
```

**The consequence**: `JSON.stringify({a: 1, b: 2})` and `JSON.stringify({b: 2, a: 1})` produce different strings, so they'd cache-miss for logically-identical calls.

**Why it doesn't matter today**: the model is the only producer of tool_use args. Anthropic's SDK produces stable-order JSON, and the AptKit adapter passes it through. No multi-client scenario exists.

**Why it could bite later**: if a second call site (e.g. a UI-triggered "re-run" that reconstructs args from user input) hit the same cache, it might cache-miss depending on key order.

**The move**: canonicalize the args before stringify — sort keys, normalize whitespace. `import stableStringify from 'json-stable-stringify'` and swap the one line. Low cost; deferred until it matters.

### 4. Malformed JSON fault gets cached

**Evidence**: `lib/data-source/fault-injecting.ts:148` + `bloomreach-data-source.ts:178`

The fault returns `isError: false` with content `{"broken":"unclosed`. The cache write is gated on `!result.isError`, so this DOES get cached (for 60 s).

**The consequence**: in a real production scenario where a genuine partial JSON payload came back, subsequent identical calls would hit the poisoned cache instead of retrying. The agent's `unwrap()` parse in `lib/mcp/schema.ts` would fail the same way each time.

**Why it stays**: `unwrap()` rejects the garbage; the model sees a failed parse and picks a different tool. The retry ladder is bypassed (because `isError: false`), but the *effect* is the same: the caller gets a signal something's wrong.

**The move**: extend the no-cache-on-error gate to include "content that doesn't parse as expected." Would require a schema check inside McpDataSource, which is a layering decision — right now the schema lives above (`lib/mcp/schema.ts`). Deferred; not urgent because real malformed payloads are rare and cache TTL is 60 s.

### 5. No jitter on retry ladder

**Evidence**: `lib/data-source/bloomreach-data-source.ts:157`

The retry wait is `Math.min(hint + 500 || 10s × 2^n, 20_000)` — deterministic given the input.

**The consequence**: two Vercel instances that both hit a 429 at the same time would wait the same duration and re-fire simultaneously — a mini thundering herd.

**Why it's a low risk**: the spacing gate at each instance keeps their steady-state rate < 1 req/s. The synchronized retry is a short-lived burst, and Bloomreach's 429 response ("1 per 10 second") would just re-fire — the ladder handles it.

**The move**: add ±20% jitter to the sleep. `waitMs *= 0.8 + Math.random() * 0.4`. Two-line change; low priority.

### 6. Auth cookie is the only cross-instance state

**Evidence**: `lib/mcp/auth.ts:86` `withAuthCookies`

The cookie is encrypted under `AUTH_SECRET`. Any Vercel instance can decrypt it. That's the entire cross-instance coordination story.

**The consequence**: `AUTH_SECRET` rotation requires a re-auth for every user (all old cookies become undecryptable). No key rotation grace period. If the secret is ever compromised, rotation is a hard cut.

**Why it stays acceptable**: for a portfolio-scale app, a hard-cut re-auth is fine. Users click "authorize with Bloomreach" again; done in seconds. A production-scale app with millions of users would need a dual-key rotation window.

**The move**: dual-key `AUTH_SECRET_CURRENT` + `AUTH_SECRET_PREVIOUS`. Try current first, fall back to previous. Rotate periodically. Two-value env config; can be added when needed.

### 7. `AUTH_SECRET` misconfiguration is a hard fail

**Evidence**: `lib/mcp/auth.ts:52`

```ts
function aesKey(): Buffer {
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    throw new Error(
      'AUTH_SECRET is required in production to encrypt the auth cookie…',
    );
  }
  return createHash('sha256').update(secret).digest();
}
```

**The consequence**: if deployed to production without `AUTH_SECRET`, every OAuth attempt throws immediately at the first `saveTokens` call. The error message is clear, but the deploy passes health checks (nothing checks env at boot).

**Why it's mitigated**: the throw message is explicit; anyone reading Vercel logs finds it in seconds.

**The move**: a startup env check that fails the build if `AUTH_SECRET` is unset in production. `next.config.ts` or a Vercel build hook. Small addition; would surface earlier than first-request failure.

### 8. Retry ladder sleeps don't respect `req.signal`

**Evidence**: `lib/data-source/bloomreach-data-source.ts:167`

```ts
await sleep(waitMs);
```

`sleep` is a `setTimeout` promise — no signal awareness. If a client cancels during a 20 s retry wait, the wait completes before the next `liveCall` sees the cancel.

**The consequence**: after a client cancel, up to 20 s of function time is burned on a sleep that will never be used. The next `liveCall` throws `AbortError` and unwinds, but the sleep already ran.

**Why it's rare**: retries are only triggered by 429s. In steady state (after the spacing gate is warm), 429s are uncommon. The window where this matters is small.

**The move**: swap `sleep(ms)` for `sleep(ms, signal)` that races the timeout against the signal's abort event. Ten-line change; adds correctness under cancel.

### 9. Investigations Map has no eviction

**Evidence**: `lib/state/investigations.ts:11`

```ts
const mem = new Map<string, AgentEvent[]>();
```

Top-level Map, no LRU, no size cap. Every `saveInvestigation` grows it.

**The consequence**: on a long-running Vercel instance (uncommon), memory grows unboundedly.

**Why it's a low risk**: Vercel instances recycle regularly — cold start, cold cache, empty Map. Effectively self-clearing.

**The move**: LRU cap at N entries. `Map` with a size check on set. Would earn its place if instances stayed alive longer or if investigations grew larger. Not urgent.

### 10. No dead-letter for tool errors

**Evidence**: `app/api/agent/route.ts:200-215`

Tool errors ride into the stream as `tool_call_end` events with an `error` field. The model sees them, reasons around them (or fails). There's no dead-letter queue, no error aggregation, no alerting.

**The consequence**: a systemic error mode (e.g. every `run_query` returns `HTTP 500`) would silently degrade the investigation quality — the model would keep trying, hit the retry budget, and produce a shallow diagnosis.

**Why it's working as designed**: the fault-injection receipt (9 injected faults / 3 investigations / 0 failed) is exactly this: the model reasons around tool failures, and the investigation still completes. The AptKit agent loop treats `is_error: true` as a signal, not a stop condition.

**The move for production**: log tool error rates to Vercel's log ingest; alert on rates > 10%. Or emit an OpenTelemetry span per tool call. Would enable observability without changing the resilience story.

## The takeaway

**Rank 1 (the top finding, restated from 00-overview.md):** the per-instance cache is not a durability guarantee. The retry ladder does the heavy lifting; the cache is opportunistic. Any story that reads "we have a cache so we're safe from rate limits" is wrong. The story that reads "we have a spacing gate + retry ladder + no-cache-on-error + 30 s per-call timeout, and the cache is a bonus" is right.

**Rank 2 (the invariant to protect):** every MCP tool must be read-only. This invariant is documented in this guide but not enforced by the type system. Adding a write tool without adding the retry safety analysis is a straight-line bug.

**Everything else** is either low-frequency (ranks 3, 4, 5, 8), scale-dependent (ranks 6, 7, 9), or working as designed (rank 10). None of them are urgent. All of them are known.

The honest framing: **this is a small distributed surface, and the small size is the design.** One hop out, one shared secret for cross-instance state, no writes anywhere. Every risk in this audit is a known consequence of that shape. The mitigations that exist are proportional to the risks that exist.

## See also

- `00-overview.md` — the top finding is a compressed version of Rank 1 here.
- `02-partial-failure-timeouts-and-retries.md` — the ladder that Rank 1 relies on.
- `03-idempotency-deduplication-and-delivery-semantics.md` — the invariant that Rank 2 is about.
- `04-consistency-models-and-staleness.md` — the per-instance staleness that Rank 1 lives in.
