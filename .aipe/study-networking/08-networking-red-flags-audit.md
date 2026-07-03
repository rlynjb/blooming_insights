# 08 — networking red-flags audit

## Subtitle

Ranked protocol and network-failure risks (Project-specific — evidence-grounded verdicts on where the wire layer can bite).

## Zoom out, then zoom in

Seven other files walked what's on the wire and how it works. This one ranks what could bite. Nothing in this audit is manufactured — every finding cites a specific file:line or explicitly says `not yet exercised`. The order is by consequence, not by area.

```
  Zoom out — the risks ranked

  ┌─ HIGH — production impact if hit ─────────────────────────┐
  │  R1: no per-call Anthropic timeout                         │
  │  R2: process-local response cache                          │
  │  R3: no retry jitter (single-user OK, multi-user risky)    │
  └────────────────────────────────────────────────────────────┘
  ┌─ MEDIUM — quality-of-service concerns ────────────────────┐
  │  R4: reconnect regex divergence between auto & button      │
  │  R5: no circuit breaker on chronically-down upstream       │
  │  R6: no HTTPS-only enforcement on override.url             │
  └────────────────────────────────────────────────────────────┘
  ┌─ LOW — hygiene / would-be-nice ────────────────────────────┐
  │  R7: implicit connection pool tuning                       │
  │  R8: no dedicated `Vary` on cache-varying responses        │
  │  R9: OAuth `code` in URL (industry-standard, worth noting) │
  └────────────────────────────────────────────────────────────┘
```

Zoom in — each finding names the mechanism, the evidence, the failure mode it enables, and the move that would close it.

## Structure pass

**Layers where risks concentrate:**
- Route (missing timeouts, missing observability on some paths)
- Transport (retry policy shape, cache locality)
- Client (regex divergence in reconnect)
- Config surface (URL validation, no protocol enforcement)

**Axis — FAILURE-CONTAINMENT (does the failure escape its ring or stay contained?):**

Every red flag below is a place where a failure could escape its intended containment ring. That's what makes it a red flag — the design intended containment but the mechanism doesn't quite reach.

## The findings

### R1 — no per-call Anthropic timeout (HIGH)

**Mechanism:** MCP calls get a 30s `AbortSignal.timeout` composed in `lib/mcp/transport.ts:131`. Anthropic calls get only the route's `req.signal` — no explicit per-call ceiling. From `lib/agents/aptkit-adapters.ts:92-95`:

```ts
const response = await this.anthropic.messages.create(
  params,
  request.signal ? { signal: request.signal } : undefined,
);
```

**Failure mode:** If Anthropic's API stalls (network partition on the return leg, provider incident with slow-hanging responses), a single model turn could burn the entire 300s route budget. The Anthropic SDK has internal timeouts, but they're not explicit here and not aligned with this app's route budget.

**Why it hasn't bitten yet:** Anthropic's uptime is high enough that stalls are rare. Baseline metrics show diagnostic p50 at 50s dominated by MCP calls, not Anthropic. The gap has been latent, not manifested.

**The move:** compose `AbortSignal.timeout(60_000)` (or similar) with `request.signal` in the adapter, matching the shape used in `SdkTransport`. One-line change. Signal:

```ts
const timeoutSignal = AbortSignal.timeout(60_000);
const signal = request.signal
  ? AbortSignal.any([request.signal, timeoutSignal])
  : timeoutSignal;
const response = await this.anthropic.messages.create(params, { signal });
```

**Evidence:** `lib/agents/aptkit-adapters.ts:92-95`. Contrast with `lib/mcp/transport.ts:131-137` (which does compose).

### R2 — process-local response cache means variable hit rate (HIGH)

**Mechanism:** The 60s response cache in `lib/data-source/bloomreach-data-source.ts:122` is a `Map` in memory, per function instance:

```ts
private cache = new Map<string, { result: unknown; expiresAt: number }>();
```

**Failure mode:** On Vercel, each function instance has its own cache. A cache hit requires the same instance to serve two requests within 60s — which happens when Vercel routes a repeat request to a warm instance, but not always. Under load with multiple warm instances, the effective hit rate is lower than "60s ago I made this call, so it's cached." Repeat calls that miss cache pay the full ~1.1s spacing + Bloomreach latency.

**Why it hasn't bitten hard:** Baseline traffic is low; instance affinity holds most of the time. Prompt caching on the Anthropic side (`cache_creation → cache_read`) is verified live at 3168 tokens, which is the more impactful cache in the current cost profile.

**The move:** if the hit rate matters more, promote the cache to a shared store (Redis / Vercel KV). Explicitly out of scope right now — the comment at `bloomreach-data-source.ts:8` frames this as the default. Naming it in the audit so it's a known gap.

**Evidence:** `lib/data-source/bloomreach-data-source.ts:122`. Also referenced in `lib/mcp/connect.ts:112-117` (the rationale for the 60s TTL).

### R3 — no jitter on the retry ladder (HIGH, contextually)

**Mechanism:** The rate-limit retry ladder waits exactly the stated window + 500ms buffer (`lib/data-source/bloomreach-data-source.ts:164-174`):

```ts
const waitMs = Math.min(
  hintMs != null ? hintMs + RETRY_BUFFER_MS : backoffMs,
  this.retryCeilingMs,
);
await sleep(waitMs);
```

No jitter. If Bloomreach rate-limits at global scope and multiple users hit the ceiling simultaneously, all their retries land at the same moment. The next window sees another burst.

**Why it hasn't bitten:** This app is currently single-user-per-request; Bloomreach's rate limit is per-OAuth-token, which is per-user. Multiple concurrent users would have separate rate-limit budgets, so synchronizing their retries is less of a thundering-herd problem than a general one.

**The move:** if the app grows a shared-credential mode (e.g. a shared bearer token for team access, which the Session B/D config surface makes possible), add `± 20%` jitter to the retry wait:

```ts
const jitter = 1 + (Math.random() - 0.5) * 0.4;  // 0.8-1.2×
await sleep(waitMs * jitter);
```

**Evidence:** `lib/data-source/bloomreach-data-source.ts:164-174`.

### R4 — reconnect regex divergence (MEDIUM)

**Mechanism:** `lib/hooks/useReconnectPolicy.ts:33-34` keeps two regexes:

```ts
const AUTH_ERROR_RE_AUTO = /invalid_token|unauthor|forbidden|401|session expired|reconnect/i;
const AUTH_ERROR_RE_BUTTON = /unauthor|forbidden|401|session expired/i;
```

The button regex is missing `invalid_token` and `reconnect`. Comments on the file (`useReconnectPolicy.ts:20-25`) flag this as a known latent bug: the button won't fire on an error message shaped `invalid_token: ...`, even though the auto path would have.

**Failure mode:** If the auto-reconnect one-shot guard fires and fails (the reset succeeds but the reload's re-auth also fails, and the browser lands back on the error UI), the user clicks the "reconnect" button. If the underlying error text is `invalid_token: ...`, the button's short regex misses it — the click does nothing.

**Why it hasn't bitten hard:** The auto path handles the common revoked-token case; the button is a fallback that rarely fires because the auto path succeeds most of the time.

**The move:** unify the regexes. The comment says this requires manual verification against live Bloomreach — not a code-only change. Filed as a future concern; the divergence is documented in-file.

**Evidence:** `lib/hooks/useReconnectPolicy.ts:33-34`, plus the comment block at :5-31.

### R5 — no circuit breaker on chronically-down upstream (MEDIUM)

**Mechanism:** If Bloomreach is fully down (all calls return 5xx or all time out), each MCP tool call inside a ReAct loop pays its full timeout (30s per call for stalls, or immediate for 5xx). A diagnostic loop running 10 tool calls against a fully-down upstream pays ~300 seconds of budget on retries and failures — exactly the route budget ceiling.

No circuit breaker: no per-host failure-rate tracking, no "open the circuit for 30 seconds after 3 consecutive failures."

**Failure mode:** During a Bloomreach outage, every investigation grinds through 300s of futile calls before the route timeout kills it. Users see slow error responses. Cost accumulates (route runtime is billed).

**Why it hasn't bitten hard:** Alpha-server outages are rare. When they happen, the auto-reconnect regex often catches the shape and the app degrades gracefully to "please reconnect."

**The move:** wrap the transport in a per-host circuit breaker. Open after N consecutive failures within window W; fail-fast for cool-down period C. Emit a distinct error shape so the UI can show "upstream is down" instead of "your call timed out." Out of scope right now; documented as a gap.

**Evidence:** absence — grep confirms no circuit-breaker pattern in `lib/`.

### R6 — override.url not enforced as HTTPS (MEDIUM)

**Mechanism:** `lib/mcp/config.ts:50-60` validates the override shape but not the URL scheme:

```ts
export function isMcpConfigOverride(value: unknown): value is McpConfigOverride {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (v.url !== undefined && typeof v.url !== 'string') return false;
  // ...
}
```

A user could persist `{ "url": "http://localhost:8080/mcp/", "authType": "bearer", "bearerToken": "..." }` and their bearer token would ride plaintext to `localhost:8080`. Legitimate for local dev; a footgun for production users who accidentally paste an HTTP URL.

**Failure mode:** A production user pastes an `http://` MCP URL (perhaps a typo, perhaps a self-hosted server without TLS). Their bearer token is transmitted plaintext to the target. If the network path is compromised, the token leaks.

**Why it hasn't bitten:** Users don't typically paste HTTP URLs. The default (`https://loomi-mcp-alpha...`) is HTTPS. Env vars in production are typically set by developers who know to use HTTPS.

**The move:** validate scheme in `isMcpConfigOverride` — allow `http://` only for `localhost` / `127.0.0.1` hosts. Warn in the UI settings modal when a non-HTTPS URL is entered. Both are surface-level changes; the substrate for validation already exists.

**Evidence:** `lib/mcp/config.ts:50-60` — no scheme check.

### R7 — implicit connection pool tuning (LOW)

**Mechanism:** No explicit `undici.Agent` config. Node's global `fetch` uses `undici`'s default pool. On Vercel's ephemeral functions, this is fine — the pool discards on function end anyway. On a long-running Node server, defaults might not scale to sustained high traffic.

**Failure mode:** If this app deployed to a long-running Node runtime with sustained hundreds of concurrent investigations, `undici`'s default pool could serialize requests behind a limited number of sockets, adding queueing latency.

**Why it hasn't bitten:** Vercel-only deployment; ephemeral functions don't need long-lived pool tuning.

**The move:** if deployment target changes, add an explicit `undici.setGlobalDispatcher(new Agent({ connections: 128 }))` at module init. Cheap change; only worth doing if a runtime change is imminent.

**Evidence:** absence — grep for `httpAgent|Agent|dispatcher` in `lib/` returns nothing.

### R8 — no `Vary` on cache-varying responses (LOW)

**Mechanism:** The demo snapshot response includes `Cache-Control: no-store, no-transform` (`app/api/briefing/route.ts:150`). The live-stream responses use `no-cache, no-transform` (`app/api/agent/route.ts:108`). Neither includes a `Vary` header, but neither response is actually intended to be cached by any intermediary, so `Vary` isn't strictly needed.

However: **the response varies by cookie state and by the `x-bi-mcp-config` header.** A future proxy or edge cache configured to cache these responses (unwisely) would serve the wrong response to a user with different cookies or a different MCP override. `Vary: Cookie, x-bi-mcp-config` would signal this explicitly.

**Failure mode:** hypothetical — depends on a misconfigured intermediary caching the responses despite `no-cache`.

**The move:** add `Vary: Cookie, x-bi-mcp-config` to the response headers as a defense-in-depth belt-and-braces. Zero runtime cost, correct signal to any intermediary.

**Evidence:** `app/api/agent/route.ts:106-109`, `app/api/briefing/route.ts:147-152`.

### R9 — OAuth `code` in URL query string (LOW, industry-standard)

**Mechanism:** Standard OAuth authorization-code flow puts the code in the callback URL's query string (`app/api/mcp/callback/route.ts:17-18`):

```ts
const code = params.get('code');
```

The code is TLS-protected in transit. It has a short lifetime (Bloomreach's server invalidates it once exchanged). But URLs get logged in access logs, referrer headers, etc. — a fresh, unused code briefly appearing in Vercel logs is a small exposure window.

**Failure mode:** if a Vercel log with the auth code URL is accessed by an attacker before the code is exchanged (seconds window), they could complete the OAuth flow themselves. PKCE (which this app uses) mitigates this: the attacker doesn't have the `code_verifier`, so their code exchange fails.

**Why it's LOW:** industry-standard flow. PKCE is the defense. The exposure window is seconds. Redaction in structured logging would help but isn't required by the OAuth spec.

**The move:** ensure Vercel's access logs redact query strings for `/api/mcp/callback` — a Vercel-level configuration, not a code change. Confirm the `code_verifier` never leaks into logs (it doesn't — `redactSecrets` in `lib/mcp/transport.ts:66-76` includes `"code_verifier"` in its patterns).

**Evidence:** `app/api/mcp/callback/route.ts:17-18`, `lib/mcp/transport.ts:55-61` (redaction includes the verifier).

## Summary — the ranked table

```
  Network red-flags ranked by consequence

  ┌────┬────────────────────────────────────┬──────────┬────────────┐
  │ #  │ finding                            │ severity │ evidence   │
  ├────┼────────────────────────────────────┼──────────┼────────────┤
  │ R1 │ no per-call Anthropic timeout      │ HIGH     │ aptkit-    │
  │    │                                    │          │  adapters  │
  │    │                                    │          │  :92-95    │
  │ R2 │ process-local response cache       │ HIGH     │ bloomreach-│
  │    │                                    │          │  ds:122    │
  │ R3 │ no jitter on retry ladder          │ HIGH*    │ bloomreach-│
  │    │ (*single-user OK; multi risky)     │          │  ds:164-174│
  │ R4 │ reconnect regex divergence         │ MEDIUM   │ useRecon-  │
  │    │ (auto vs button)                   │          │  nectPolicy│
  │    │                                    │          │  :33-34    │
  │ R5 │ no circuit breaker for chronic     │ MEDIUM   │ absence in │
  │    │ upstream outage                    │          │ lib/       │
  │ R6 │ override.url not enforced as HTTPS │ MEDIUM   │ config.ts  │
  │    │                                    │          │  :50-60    │
  │ R7 │ implicit connection pool tuning    │ LOW      │ absence    │
  │ R8 │ no Vary on cache-varying responses │ LOW      │ agent.ts   │
  │    │                                    │          │  :106-109  │
  │ R9 │ OAuth code in URL (industry std,   │ LOW      │ callback.ts│
  │    │ PKCE mitigates)                    │          │  :17-18    │
  └────┴────────────────────────────────────┴──────────┴────────────┘
```

## The load-bearing finding

If you fix one thing from this audit, fix **R1 — the missing Anthropic per-call timeout.** It's the direct symmetry-break with the MCP path's strongest defense. `SdkTransport.callTool` composes a 30s ceiling; `AnthropicModelProviderAdapter.complete` doesn't. Every other risk in the list is either latent (R2, R3, R5, R7, R8), documented (R4), or upstream-shape-dependent (R6, R9). R1 is a hole in the defense-in-depth story that a one-line change would close.

The move, for completeness:

```ts
// lib/agents/aptkit-adapters.ts around :92
const timeoutSignal = AbortSignal.timeout(60_000);  // Anthropic budget
const signal = request.signal
  ? AbortSignal.any([request.signal, timeoutSignal])
  : timeoutSignal;
const response = await this.anthropic.messages.create(
  params,
  { signal },
);
```

60s is a defensible ceiling (Anthropic p99 for `messages.create` is well under 30s; a call taking 60s is stuck). The route's 300s budget is the last-resort ceiling, not the first.

## Explicit `not yet exercised` list

For honesty — the following don't appear in the audit because the code doesn't exercise them:

- **UDP / QUIC / HTTP/3 at the application layer** — Vercel's edge negotiates whatever with browsers; the app is HTTP/1.1 or /2 to upstreams via `undici`.
- **WebSockets / SSE** — see `06-websockets-sse-streaming-and-realtime.md`; NDJSON is the streaming choice.
- **DNS caching / SRV records / service discovery** — origins are hardcoded HTTPS URLs.
- **Multi-region routing** — no `runtime: 'edge'`, no region-affinity logic.
- **CORS** — all browser→route calls are same-origin.
- **mTLS** — bearer / OAuth tokens on the outbound side, not client certs.
- **Backpressure signaling to the browser** — event sizes and stream length don't fill Node's write buffer in practice.

Each becomes relevant when the shape changes — see the individual files for what triggers each.

## Interview defense

**Q: What's the single largest gap in the network layer's defense-in-depth?**

The missing per-call timeout on the Anthropic side. `SdkTransport.callTool` composes `AbortSignal.timeout(30_000)` — the strongest defense in the MCP path — but `AnthropicModelProviderAdapter.complete` composes nothing. A stuck Anthropic call would sit until the route's 300s budget runs out. Fix: compose `AbortSignal.timeout(60_000)` with `request.signal` in the adapter, one-line change matching the shape used elsewhere.

Anchor: `lib/agents/aptkit-adapters.ts:92-95` (the gap), `lib/mcp/transport.ts:131` (the pattern to copy).

**Q: Your response cache is `Map`-in-memory. Is that a bug or a decision?**

Decision, with a known limitation. On Vercel's ephemeral functions, each instance has its own cache; hits require request affinity to the same warm instance. Baseline traffic is low enough that affinity holds most of the time, and Anthropic's prompt cache (verified live at 3168 tokens creation → 3168 tokens read) is the more impactful cost lever anyway.

The move if hit rate mattered more: promote to Vercel KV / Redis. Explicitly noted in the code comments as future work. The current shape is deliberate simplicity, not oversight.

Anchor: `lib/data-source/bloomreach-data-source.ts:122`.

**Q: Ranked risks — which one worries you most in production?**

R1 (Anthropic timeout gap) if uptime matters — a single stuck call burning 300s of route budget is a real user-facing symptom. R6 (no HTTPS enforcement on override URL) if security matters — a user pasting an HTTP MCP URL leaks their bearer token plaintext. R3 (no retry jitter) if multi-user matters — a shared-credential mode would synchronize retries.

Everything else is either latent (needs a specific runtime change to bite) or well-documented (R4's regex divergence is called out in the file comment).

## See also

- `07-timeouts-retries-pooling-and-backpressure.md` — the defenses that ARE in place; this file is the mirror
- `06-websockets-sse-streaming-and-realtime.md` — R4's reconnect divergence in context
- `study-security` — R6 (HTTPS enforcement) and R9 (OAuth code exposure) seen through the security lens
- `study-distributed-systems` — R3 (jitter), R5 (circuit breaker) seen through the coordination-under-failure lens
