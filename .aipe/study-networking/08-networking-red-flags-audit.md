# Networking red flags — audit

**Industry name(s):** network reliability audit, failure-mode review, gap analysis
**Type:** Project-specific

> Ranked by consequence, with the evidence for each verdict. The top of the list is the gap I'd close first if I had one PR to spend on this app's networking layer.

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** The risks below are *real gaps in the current code*, not theoretical concerns. Each is grounded in a specific file and line range; each names the failure mode in concrete terms ("the user sees X after Y seconds"), and each has a "what would I do" answer. The top three are load-bearing for user-visible liveness; the rest are real but lower-priority.

```
Zoom out — where each risk lives

┌─ UI band ──────────────────────────────────────────────────────────┐
│  RISK 5: no cancellation on hook cleanup (deliberate; StrictMode)   │
└────────────────────────┬───────────────────────────────────────────┘
                         │
┌─ Service band ─────────▼──────────────────────────────────────────┐
│  RISK 1: no per-call timeout on upstream fetches                  │
│  RISK 2: retry ceiling can eat 20%+ of route budget on one call   │
│  RISK 4: text-match rate-limit detection (brittle to upstream)    │
│  RISK 6: in-process cache doesn't survive cold start              │
│  RISK 7: no backpressure across concurrent users                  │
└────────────────────────┬──────────────────────────────────────────┘
                         │
┌─ Auth boundary ────────▼──────────────────────────────────────────┐
│  RISK 3: DCR + PKCE state in single cookie = SPOF for OAuth      │
│  RISK 8: AUTH_SECRET rotation has no graceful path                │
└────────────────────────┬──────────────────────────────────────────┘
                         │
┌─ Network boundary ─────▼──────────────────────────────────────────┐
│  RISK 9: no DNS resilience (resolver hang = silent latency)       │
│  RISK 10: no edge buffering check (no-transform is defensive)     │
└────────────────────────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question this file answers: which networking gaps would actually hurt a user *today*, ranked by how likely and how bad? Each risk is named, evidence is cited, the failure mode is constructed, and the fix is sketched. No invented scenarios — everything is grounded in the real code.

---

## Structure pass

**Layers.** Risks live in three places. **Service layer** (where the route handles connect/call/retry — most risks here). **Auth boundary** (the cookie + OAuth round-trip — concentrated risk because a single cookie carries the whole flow). **Network boundary** (the platform/DNS/edge — lowest risk because we delegate everything).

**Axis: failure (origin → impact).** Trace "where does the failure originate, what's its impact, what catches it?" Each risk has the same structure: an unhandled (or under-handled) failure mode at one layer, with a visible consequence at the user-facing layer.

**Seams.** The three load-bearing seams from prior files reappear here as the *home* of three of the top risks: the Service→Bloomreach seam (risk 1, 2, 4), the cookie auth seam (risk 3, 8), the streaming wire seam (covered indirectly in risk 10).

---

## How it works

### The ranking method

For each risk: **what** is the gap (one sentence), **evidence** (file + lines), **failure mode** (what the user sees, when), **why it's not fixed today** (the honest cost of the fix), and **the move** (one-line proposal). Ranked by consequence × likelihood, not just one or the other.

```
Each risk is structured the same way:

  ┌───────────────────────────────────────────────────────────────┐
  │  RISK N — short name                                          │
  │                                                                │
  │  What: one-sentence gap                                       │
  │  Evidence: file:line                                          │
  │  Failure mode: what the user sees, when                       │
  │  Why not fixed: honest cost                                   │
  │  Move: one-line proposed change                               │
  └───────────────────────────────────────────────────────────────┘
```

---

## Risk 1 — No per-call timeout on upstream fetches

  → **What.** Neither the Bloomreach `fetch` nor the Anthropic SDK call has an `AbortController` / `signal`. The only timeout in play is `maxDuration = 300` at the route level, which kills the *whole function*, not the stuck call.
  → **Evidence.** `lib/mcp/transport.ts:24-36` (`makeCapturingFetch` passes `init` to `fetch` unchanged, no signal added). `app/api/agent/route.ts:20` and `app/api/briefing/route.ts:17` (`maxDuration = 300`). A grep for `AbortController`, `AbortSignal`, `signal:` across `lib/` and `app/` returns no app-side hits.
  → **Failure mode.** Bloomreach socket hangs at minute 2 of an investigation. The user sees the events that streamed before minute 2, then silence. At minute 5 (300 s mark), Vercel kills the function. No final event lands; the UI just stops. From the user's perspective: "the page froze."
  → **Why not fixed today.** No observed instance of a hang in production logs (yet). The fix is simple but untriggered. Risk is real because Bloomreach is alpha-quality; the slower the upstream gets, the more likely we hit it.
  → **Move.** Wrap `init` in `makeCapturingFetch` with `signal: AbortSignal.timeout(15_000)` (15 s per-call). Surface the resulting `AbortError` as `McpToolError(name, 'upstream timeout')`. Same pattern on Anthropic via `@anthropic-ai/sdk`'s `timeout` option.

```
Risk 1 — failure timeline

  t=0s          user clicks investigate
  t=2s          first events arrive
  t=15s         5 events through; agent kicks off Bloomreach call N
  t=15s+        Bloomreach socket hangs (no response, no close)
  t=300s        Vercel kills the function
  t=300s+       user sees... nothing. Silent stop.
  
  With fix: at t=30s the call times out, agent emits {type:'error'},
            user sees "upstream timeout" and can retry.
```

---

## Risk 2 — Retry ceiling can eat 20%+ of route budget on one call

  → **What.** `maxRetries: 3` × `retryCeilingMs: 20_000` = up to 60 s wall time on a *single* tool call. A 60 s investigation that hits a contested call can spend its entire budget waiting.
  → **Evidence.** `lib/mcp/client.ts:92-94` (defaults), `lib/mcp/connect.ts:93-95` (production instantiation: `retryDelayMs: 10_000, retryCeilingMs: 20_000, maxRetries: 3`). The 60 s arithmetic is `20s × 3 retries`.
  → **Failure mode.** An investigation calls Bloomreach 6 times. Calls 1–5 succeed normally (~3 s each). Call 6 hits the 1-per-10-s window because the user clicked through fast; client waits 10.5 s, retries; rate-limited again (Bloomreach's window is wider than parsed); client waits 20 s, retries; same story; client gives up after 60 s of retry. Total: 15 s of normal work + 60 s of retry = 75 s. With Anthropic round-trips, the whole investigation can hit 90–115 s before the agent finishes. On a route budget of 300 s, this works. On a route budget of 60 s (Hobby tier), it doesn't.
  → **Why not fixed today.** The 300 s budget is in place specifically for this. The arithmetic is *tight, not broken*. The risk is that we lose the 300 s ceiling (downgrade to Hobby, regional regulation, etc.) or the upstream slows further.
  → **Move.** Track total retry time across the whole route and short-circuit when remaining budget drops below threshold. Add an emission like `{type:'warning', message:'budget low'}` before falling back to a degraded answer.

---

## Risk 3 — DCR + PKCE state in single cookie = SPOF for OAuth

  → **What.** The Dynamic Client Registration result (`clientInformation`) and the PKCE code verifier (`codeVerifier`) for an in-flight OAuth handshake are both stored in the encrypted `bi_auth` cookie. If the cookie is dropped between the `connect` request and the `callback` request, the handshake cannot complete — there's no fallback storage.
  → **Evidence.** `lib/mcp/auth.ts:28-34` (the three-backend explanation comment), `lib/mcp/auth.ts:86-104` (`withAuthCookies` reads/writes the cookie once per request). `app/api/mcp/callback/route.ts:18-32` (the callback expects the cookie to be present; returns 400 "no session" if `bi_session` is missing).
  → **Failure mode.** User starts OAuth on `<preview-1>.vercel.app` (cookie set with `SameSite=None` for that hostname). User clicks the IdP link, lands at Bloomreach's IdP. Bloomreach 302s back to `<preview-1>.vercel.app/api/mcp/callback?code=…`. If the browser drops the cookie (third-party-cookie restrictions, ITP, or some Safari/Firefox combination + `SameSite=None` quirks), the callback runs without `bi_auth` decryption — `clientInformation` and `codeVerifier` are missing. `transport.finishAuth(code)` fails. User sees 401 with an opaque error.
  → **Why not fixed today.** Production has not hit this in observed flows (the comment in `connect.ts:1-14` flags it as a known live-verification item). The alternative — a shared store (Redis, Vercel KV) — adds infrastructure cost and a per-request KV read.
  → **Move.** Add a fallback: when the cookie is absent in the callback, look up the session in a short-TTL Vercel KV store keyed by the OAuth `state` parameter. The `state` is already in the URL (we don't validate it server-side, but it's there for this purpose). 5-minute TTL covers the OAuth round-trip without long-term state.

---

## Risk 4 — Text-match rate-limit detection (brittle to upstream wording change)

  → **What.** `isRateLimited(result)` regex-matches `/rate limit|too many requests/i` and `parseRetryAfterMs` parses `/retry[\s-]*after[^0-9]*(\d+)\s*second/i` and `/per\s*(\d+)\s*second/i`. If Bloomreach changes either wording — "throttled", "quota exceeded", "wait 10s" — both regexes silently miss, the retry never fires, and the error bubbles to the user.
  → **Evidence.** `lib/mcp/client.ts:18-22` (`isRateLimited`), `lib/mcp/client.ts:31-38` (`parseRetryAfterMs`).
  → **Failure mode.** Bloomreach updates their MCP server to standardize on RFC-7807 Problem Details (`title: "Too Many Requests"` becomes `code: "throttled"`). Our regex no longer matches. Every rate-limited call now surfaces as an `McpToolError` directly. User sees "rate limit reached" in the UI; the retry mechanism that *would* have handled it transparently is dead.
  → **Why not fixed today.** Bloomreach's wording has been stable across the observed life of this app. The honest verdict is "fragile but currently correct."
  → **Move.** Add a structured-error path: prefer reading a `code` or `error.code` field in the response envelope (when Bloomreach exposes one); fall back to text matching. Log a counter when the fallback fires so a wording drift is visible.

---

## Risk 5 — No cancellation on hook cleanup (deliberate; React StrictMode tradeoff)

  → **What.** `useInvestigation` deliberately does NOT cancel the in-flight fetch on effect cleanup. React StrictMode mounts → cleans up → re-mounts in dev; cancelling on the first cleanup, combined with the started-guard blocking the re-mount, aborts the stream and leaves the UI empty.
  → **Evidence.** `lib/hooks/useInvestigation.ts:31-47` (the comment block explains the design), and the absence of `reader.cancel()` in the cleanup phase.
  → **Failure mode.** User navigates away mid-investigation. The fetch keeps running on the server; events keep being processed; results are stashed in sessionStorage on `done`. The user paid for an investigation they didn't see. Same effect: an extra Vercel function invocation finishes. Cost: real but small (one extra Anthropic-billed run).
  → **Why not fixed today.** The StrictMode interaction is real. The alternative (cancel-on-unmount with a `ref` guard tracking double-mount) is more complex.
  → **Move.** Use a `useRef<AbortController>` that survives StrictMode re-mount; abort only when the *real* unmount happens (not the StrictMode double-tap). Trade complexity for correctness.

---

## Risk 6 — In-process cache doesn't survive cold start; not shared across instances

  → **What.** The `McpClient` cache is `new Map()` per `McpClient` instance, and `connectMcp` creates a new `McpClient` per request. The cache is effectively per-request unless callers share an instance — which agents within one request do, but two consecutive requests do not.
  → **Evidence.** `lib/mcp/client.ts:80` (`private cache = new Map()`), `lib/mcp/connect.ts:91-97` (`new McpClient(...)` per call).
  → **Failure mode.** User runs a briefing. Same user runs another briefing 5 seconds later. The second briefing hits Bloomreach with the *same* schema-read call, paying the rate-limit budget again, when the first briefing's result was identical and could have been reused.
  → **Why not fixed today.** The agents share the client within a single request, which captures most of the cache benefit (an agent that asks for the schema and then asks again gets the cached version). The cross-request savings would require an instance-level singleton or a KV cache — extra complexity for unclear benefit at single-user scale.
  → **Move.** Hoist `McpClient` to module scope so warm function instances share the cache. Risk: thread safety (the spacing counter `lastCallAt` becomes shared) — needs a per-session keyed sub-cache instead.

---

## Risk 7 — No backpressure across concurrent users on the same warm instance

  → **What.** Two requests arriving on the same warm Vercel instance share `lastCallAt` via the `McpClient`'s instance scope (today they don't, because we instantiate per-request — but if we ever hoist for Risk 6's fix, they will). With shared `lastCallAt`, two simultaneous requests can interleave their spacing checks and break the gate.
  → **Evidence.** Conceptual; would manifest if Risk 6's hoisting fix landed without per-session keying.
  → **Failure mode.** Two users hit the same warm instance at the same second. Both check `lastCallAt`, both pass spacing. Both call Bloomreach within 100ms. Bloomreach rate-limits the second one. Retry logic kicks in, but the spacing remains broken across the request boundary.
  → **Why not fixed today.** Not observed; we instantiate per-request, so this is forward-looking.
  → **Move.** If hoisting `McpClient`, key the `lastCallAt` map by `sessionId` (each user has their own counter). Bloomreach's rate-limit is per-user globally, so per-user spacing is the right granularity.

---

## Risk 8 — `AUTH_SECRET` rotation has no graceful path

  → **What.** Rotating `AUTH_SECRET` immediately invalidates *all* `bi_auth` cookies (decrypt fails, `decryptStore` returns `{}`, all users see "needs auth"). There is no two-key window for graceful rotation.
  → **Evidence.** `lib/mcp/auth.ts:51-79` (a single `aesKey()` derived from `AUTH_SECRET`; no support for "try old key, then new").
  → **Failure mode.** Operator rotates `AUTH_SECRET` (compromise response, key hygiene). Every existing user's `bi_auth` cookie becomes undecryptable; the next request returns 401; the user has to re-OAuth. For low-traffic apps this is fine; for a popular app, it's a stampede.
  → **Why not fixed today.** Single-user dev app. Rotation has never happened in production. The fix is real but unmotivated by current scale.
  → **Move.** Accept a comma-separated `AUTH_SECRET` list; try each on decrypt, write with the first. Two-key window during rotation; old cookies migrate on first read.

---

## Risk 9 — No DNS resilience (resolver hang = silent latency)

  → **What.** We delegate DNS entirely to undici / OS resolver. If the resolver is slow or hanging, the upstream call inherits that latency. No fast-fail, no fallback resolver, no pre-warming.
  → **Evidence.** A grep for `dns`, `lookup`, `Dispatcher` in `lib/` and `app/` returns no app hits. The default behaviour is what we get.
  → **Failure mode.** A regional DNS outage or misconfiguration adds 5 s to every fresh connection. Six Bloomreach calls per investigation = 30 s of pure DNS latency (worst case). Combined with the spacing + retry, the route can run out of budget without any observable upstream error.
  → **Why not fixed today.** DNS is reliable in practice on Vercel; not observed.
  → **Move.** Pre-warm `loomi-mcp-alpha.bloomreach.com` and `api.anthropic.com` on cold start (a single throwaway HEAD request) so the resolver+pool are ready by the first real call.

---

## Risk 10 — Defensive `no-transform`, no live verification of edge behaviour

  → **What.** `Cache-Control: no-cache, no-transform` is set on both streaming routes specifically to prevent Vercel's edge from buffering or recompressing the stream. We have *not* empirically verified that the edge respects it; the directive is based on documented Vercel behaviour.
  → **Evidence.** `app/api/agent/route.ts:107-110` (NDJSON_HEADERS), `app/api/briefing/route.ts:144-149`. No test or live observation log that confirms the directive is honored.
  → **Failure mode.** Vercel changes its edge behaviour (re-rolls a CDN layer, enables a new optimisation). The directive is ignored, the stream is buffered, the UI sees no events until the producer closes 60–115 s in. From the user's perspective: "the page is frozen, then suddenly everything appears at once."
  → **Why not fixed today.** Vercel's documentation says they respect this directive; no observed regression.
  → **Move.** Add a smoke test: hit `/api/briefing` in production, measure the time-to-first-byte vs time-to-second-byte. Expectation: similar (live streaming). If they're far apart (TTFB short, TTSB at the end), the edge is buffering.

---

## Primary diagram

```
Risk map — full recap, ranked

┌────────────────────────────────────────────────────────────────────┐
│  TOP 3 — would close first                                          │
├────────────────────────────────────────────────────────────────────┤
│  #1  no per-call timeout                                            │
│      lib/mcp/transport.ts:24-36 · maxDuration is whole-function    │
│      fix: wrap signal with AbortSignal.timeout(15_000)             │
│                                                                     │
│  #2  retry ceiling vs route budget                                  │
│      lib/mcp/client.ts:92-94 · 60s per call × 6 calls = tight       │
│      fix: track total retry budget across the route                 │
│                                                                     │
│  #3  DCR + PKCE state in single cookie (SPOF)                       │
│      lib/mcp/auth.ts:86-104 · cookie drop kills OAuth               │
│      fix: KV fallback keyed by OAuth state                          │
├────────────────────────────────────────────────────────────────────┤
│  MID — real but lower priority                                      │
├────────────────────────────────────────────────────────────────────┤
│  #4  text-match rate-limit detection                                │
│  #5  no cancellation on hook cleanup (deliberate; StrictMode)       │
│  #6  per-request cache (no warm-instance reuse)                     │
│  #7  no backpressure for concurrent users on warm instance          │
├────────────────────────────────────────────────────────────────────┤
│  LOW — forward-looking                                              │
├────────────────────────────────────────────────────────────────────┤
│  #8  AUTH_SECRET rotation has no graceful path                      │
│  #9  no DNS resilience (pre-warming or fallback)                    │
│  #10 no-transform unverified empirically                            │
└────────────────────────────────────────────────────────────────────┘
```

---

## Implementation in codebase

### What to grep when you want to verify these gaps yourself

```
Risk verification — grep commands and expected output

# Risk 1 — no AbortController / signal on outbound fetch
$ grep -rn "AbortController\|AbortSignal\|signal:" lib/ app/
   → returns only the StrictMode-cleanup comment in
     lib/hooks/useInvestigation.ts:34. No app-side signal usage.

# Risk 6 — McpClient instantiated per request
$ grep -n "new McpClient" lib/ app/
   → lib/mcp/connect.ts:91 (one site, inside connectMcpInner)

# Risk 4 — rate-limit text matching
$ grep -n "rate limit\|retry.*after" lib/mcp/client.ts
   → lib/mcp/client.ts:21 (the regex)
     lib/mcp/client.ts:33-37 (the parser)

# Risk 8 — single AUTH_SECRET, no list support
$ grep -n "AUTH_SECRET" lib/mcp/
   → lib/mcp/auth.ts:53 (env read), 55-59 (error if missing)
     no comma-split, no fallback key

# Risk 10 — no-transform set in two places, no test
$ grep -rn "no-transform" lib/ app/ test/
   → app/api/agent/route.ts:109 + app/api/briefing/route.ts:147 +
     app/api/briefing/route.ts:262. No test verifying the directive
     is honored end-to-end.
```

### Where each fix would land

```
Move map — file × risk

  file                                 risks it owns
  ────                                  ─────────────
  lib/mcp/transport.ts                  #1 (add AbortSignal to fetch)
  lib/mcp/client.ts                     #2 (route-level budget tracking)
                                        #4 (structured-error path)
                                        #6 (instance-keyed cache)
                                        #7 (session-keyed lastCallAt)
  lib/mcp/auth.ts                       #3 (KV fallback for OAuth state)
                                        #8 (multi-key AUTH_SECRET list)
  lib/hooks/useInvestigation.ts         #5 (StrictMode-safe cancellation)
  lib/mcp/connect.ts                    #9 (cold-start pre-warming)
  test/network-streaming.spec.ts (new)  #10 (TTFB/TTSB smoke test)
```

---

## Elaborate

The pattern of risks here is consistent: **the app delegates aggressively where it can, and the gaps are at the seams between delegation and ownership**. Risk 1 (no timeout) and Risk 9 (no DNS resilience) are both "we delegated to undici and didn't guard the boundary." Risk 3 (PKCE in one cookie) and Risk 8 (no key rotation) are both "we own the cookie crypto but didn't build the infrastructure around it." Risk 4 (text-match rate-limit) is "we own the protocol parser but it's a regex."

This is a fine shape for a single-user app at this stage — the cost of any one fix is high relative to the observed failure rate. The right move is to instrument first (does the failure ever happen?) before fixing. The top three risks are worth fixing without instrumentation because their *consequence* if triggered is high (silent stop, frozen page, OAuth loop).

The pattern that *doesn't* show up here: nothing in this audit is "the wrong protocol choice." NDJSON over chunked HTTP is the right transport (file 06 makes the case). HTTPS on every hop is right. OAuth 2.1 + PKCE is right. The risks are all in the *details around* the right choices.

---

## Interview defense

**Q1: If you had one PR to spend on networking, what would you ship?**

The per-call timeout. `lib/mcp/transport.ts:24-36` is the insertion point. Five-line patch: wrap `init.signal` with `AbortSignal.timeout(15_000)` and surface the `AbortError` as `McpToolError('upstream timeout')`. Eliminates the "frozen page" failure mode where a hung Bloomreach socket eats the route's full 300 s window.

```
Diagram-while-you-speak

  before:   fetch(url, init)              ──► hang → maxDuration kills function
  after:    fetch(url, {signal: AbortSignal.timeout(15s), ...init})
            ──► throws after 15s → caught as McpToolError → user sees error
```

Anchor: "the only timeout today is whole-function kill; per-call is missing and it's the cheapest fix."

**Q2: What's the most fragile thing in the network layer?**

The text-match rate-limit detection (`isRateLimited` regex). Bloomreach signals rate-limit via response body text, not HTTP status; if they change the wording, our retry mechanism silently dies and every rate-limited call surfaces as a hard error. The fix is reading a structured error code when available; the cost is alpha-quality MCP servers may not expose one. Honest fragility.

**Q3: What's *not* a risk that you might think is?**

CORS. Every browser → API call is same-origin; we don't expose any cross-origin endpoint, so there's no preflight, no allowlist, no CORS surface to misconfigure. Adding a cross-origin client later requires deliberate work; the absence of CORS today is correct, not an omission.

---

## Validate

  1. **Reconstruct.** Without looking, name the top 3 risks and the file you'd open first for each.
  2. **Explain.** For risk #1 (no per-call timeout), trace the user-visible failure: what does the user see, at what timestamps, and why does it happen?
  3. **Apply.** A teammate proposes adding 5 more retries to the rate-limit logic. Argue against it citing risk #2's math, and propose what they should ship instead.
  4. **Defend.** Why is risk #3 (cookie SPOF for OAuth) ranked above risk #4 (text-match brittleness)? Compare the consequence × likelihood for each.

---

## See also

  → `00-overview.md` — the top-3 list with shorter framing.
  → `07-timeouts-retries-pooling-and-backpressure.md` — the mechanism behind risks 1, 2, 4, 6, 7.
  → `04-tls-and-trust-establishment.md` — the mechanism behind risks 3, 8.
  → `06-websockets-sse-streaming-and-realtime.md` — the design behind risks 5, 10.
