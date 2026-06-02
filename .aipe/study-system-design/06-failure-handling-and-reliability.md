# Failure handling and reliability

**Industry name(s):** failure mode audit · resilience patterns · graceful degradation · retry budget
**Type:** Industry standard · Language-agnostic

> blooming insights has **seven distinct failure paths and one missing one**. The load-bearing failure handling is in **`McpClient`** — bounded retry on rate limits with parsed retry-after windows, no-cache-on-error to prevent poisoning, exponential backoff capped at `retryCeilingMs`. The other six handlers are: every agent output validates → falls back to a typed safe default; every route try/catches setup separately from streaming (so setup errors return 401/500 JSON, mid-stream errors emit a `done` event); the client has a one-shot reconnect-on-401 policy that uses sessionStorage to prevent loops; the `useInvestigation` hook deliberately *does not cancel* the fetch on StrictMode cleanup; `withAuthCookies` returns `{}` on tampered/corrupt cookies (fail-open-to-re-auth, not fail-closed-to-error); the `_clear` helpers exist for tests but not for production self-healing. The missing one: **no circuit breaker** anywhere — if Bloomreach is fully down, every retry burns 30 seconds of the 300s budget before failing. The pattern is **graceful-degrade everywhere structured outputs land; retry-with-parsed-hint where rate limits do; no retry where transport throws.**

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Reliability is the sum of "what fails" × "what catches it" × "what the user sees." Most apps you've shipped (AdvntrCue, dryrun) had three or four failure paths and one global error boundary. This codebase has more failure paths than usual because the dependency surface is larger — an agent run touches Anthropic, Bloomreach, the rate limiter, the JSON parser, the type guard — and each can fail differently. The interesting audit is naming each path and its handler.

```
  Zoom out — where failure handling lives        ← we are here (every band)

  ┌─ UI ──────────────────────────────────────────┐
  │  one-shot reconnect-on-401 + sessionStorage flag │  ← client-side resilience
  └─────────────────────┬──────────────────────────┘
                        │
  ┌─ Route handler ────▼───────────────────────────┐
  │  try/catch around SETUP separately from STREAM   │  ← two error modes
  └─────────────────────┬──────────────────────────┘
                        │
  ┌─ Agent loop ───────▼───────────────────────────┐
  │  bounded turns + forced-final + synthesize() fallback│  ← graceful-degrade
  │  parse + type guard + FALLBACK constants         │
  └─────────────────────┬──────────────────────────┘
                        │
  ┌─ McpClient ────────▼───────────────────────────┐
  │  retry on rate limit · no-cache-on-error         │  ★ LOAD-BEARING ★
  └─────────────────────┬──────────────────────────┘
                        │
  ┌─ Auth ─────────────▼───────────────────────────┐
  │  decrypt failure → {} → re-auth (fail open)      │  ← honest about who owns auth
  └────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question is: *for every place this app can fail, what catches it, what does the user see, and what's the recovery path?* The grading dimensions are (1) does it catch the failure at all, (2) does it propagate the right shape (typed error vs throw), (3) does the user get a meaningful message or a useful next action, (4) is the recovery automatic or does the user have to do something. This file walks each failure path, names the handler, and grades the pattern.

---

## Structure pass

**Layers.** Same five bands. Failure handling lives at every band, with different patterns.

**Axis: containment.** Hold one question constant across the bands: *where does this failure originate, where does it propagate to, and where does it get contained?* Containment is the right axis for failure handling because the *defining* property of a good failure handler is "where the failure stops" — a handler that catches an error but then crashes the parent is worse than no handler at all. Trust is downstream (security/); cost is also relevant (a 30s retry burn IS a cost) but containment makes the boundaries visible.

**Seams.** Three load-bearing.

- **F1: McpClient ↔ everything above it.** Containment is *aggressive* here — rate limits get parsed and waited out; errors are caught and tagged with which tool failed; transport throws become typed `McpToolError`s with the server's actual error body attached. The whole point of `McpClient` is to be the place external failures get sane treatment.
- **F2: Agent output ↔ typed value.** Containment is *via fallback* — `parseAgentJson` + type guard, on miss → `FALLBACK` (the load-bearing pattern). This is also the prompt-injection defense (see `study-security/`), but architecturally it's the failure handler that prevents one bad model response from blowing up the whole investigation.
- **F3: Route setup ↔ route streaming.** Two error contracts: setup errors return JSON (401, 500); streaming errors emit an NDJSON `{type: 'error', message}` event then close cleanly. This is structural — once the stream is open, the wire format is committed; we can't switch to JSON mid-stream.

```
  Structure pass — failure containment

  ┌─ 1. LAYERS ────────────────────────────────────────────┐
  │  UI · Route · Agent loop · Provider · Auth               │
  └───────────────────────────┬────────────────────────────┘
                              │
  ┌─ 2. AXIS ────────────────▼────────────────────────────┐
  │  containment: where does this failure stop?             │
  └───────────────────────────┬────────────────────────────┘
                              │
  ┌─ 3. SEAMS ───────────────▼────────────────────────────┐
  │  F1: McpClient (the buck stops here for rate/transport) ★│
  │  F2: agent output → typed value (FALLBACK on miss)    ★ │
  │  F3: route setup vs streaming (two error contracts)     │
  └────────────────────────────────────────────────────────┘
```

---

## How it works

### Move 1 — the mental model

You know `try/catch`. The mental shape here is *the same primitive, applied at every band, with each band's handler being shaped by what failure it's containing*. The interesting move is naming what's *not* handled: there's no circuit breaker, no exponential backoff on transport errors (only on rate limits), no global error boundary on the UI side. The choices about what to handle and what to let propagate are deliberate.

```
  Pattern — graceful-degrade vs propagate

  failure originates              handled here              user sees
  ──────                          ────                      ─────
  Bloomreach 429                  McpClient (parse + wait)  retry happens silently
  Bloomreach 500/network          McpClient (throws)        tool_call_end has tc.error
  Bloomreach 401 (token expired)  connectMcp returns !ok    page redirects to re-auth
  Anthropic 500/network           agent loop (no catch)     stream emits error event
  Model emits non-JSON            agent.synthesize() ×2     synthesis fallback runs
  Synthesize also fails           FALLBACK constant         "insufficient data" stub
  AUTH_SECRET wrong               decryptStore → {}         fail-open → re-auth flow
  StrictMode double-mount         startedRef guard          run-once semantics
  Vercel instance recycle         re-derive on next request seamless if cookie+stash
```

### Move 2 — each failure path, with the handler

#### Path 1 — Bloomreach rate limit (the load-bearing handler)

The most common failure, and the one with the most code dedicated to it.

```
  Bloomreach returns isError + "Retry after ~10 second(s)" text

  McpClient.callTool detects isRateLimited(result)
       │
       ▼
  parseRetryAfterMs(result)  ← regex extracts "10" from "retry after 10 seconds"
       │  (falls back to retryDelayMs * 2^(retries-1) if no hint parseable)
       │  (caps at retryCeilingMs = 20s either way)
       ▼
  sleep(hintMs + RETRY_BUFFER_MS=500)
       │
       ▼
  re-call live (skipping cache check)
       │
       ▼
  if still rate-limited && retries < maxRetries=3 → repeat
  if still rate-limited && retries >= 3            → return result as-is (NOT cached)
  if no longer rate-limited                        → cache (TTL) + return
```

The whole retry mechanism is ~20 lines (lib/mcp/client.ts L121–L132). Three things make it robust: *parsing the server's actual retry hint* (so we wait the right amount, not some fixed backoff), *the 500ms buffer past the hint* (so we land just after the penalty clears instead of on its boundary), and *the retryCeilingMs cap* (so a misparsed or absurd hint can't wedge the request indefinitely).

```
  Why the parsed hint matters

  observed Bloomreach error text:    "Retry after ~12 second(s)"
       │
       ▼
  without parsing: fixed 1s backoff  → 12 retries before window clears
                                       → 12 wasted requests, log spam,
                                         no progress, eventual failure
       │
       ▼
  with parsing: sleep 12.5s, then retry
                                       → 1 wasted request, then success
```

#### Path 2 — Bloomreach transport throw (no retry, tagged error)

```
  StreamableHTTPClientTransport throws (e.g. 401 with no auth cookie)

  SdkTransport.callTool catches  →  reads httpErrors holder for the captured body
       │
       ▼
  throws new Error(`HTTP ${status}: ${body}`, { cause: err })
       │
       ▼
  McpClient.liveCall catches  →  throws new McpToolError(name, errorDetail, { cause })
       │
       ▼
  bubbles up to runAgentLoop  →  sets tc.error  →  fed to model as tool_result with is_error: true
       │
       ▼
  bubbles to route  →  if mid-stream, emit error event; if setup, return JSON
```

There is *no automatic retry* on transport throws (only on rate-limit-shaped error envelopes). This is the right call: a 500 from Bloomreach is unlikely to clear in seconds, so retrying just burns the budget. The model receives the error as a `tool_result` with `is_error: true` and can decide to try a different approach or give up.

#### Path 3 — agent output is non-JSON or wrong shape (FALLBACK)

This is the prompt-injection containment AND the "model wanders off" containment.

```
  runAgentLoop returns finalText  →  agent tries tryParseDiagnosis(finalText)
       │
       ▼
  parse fails OR isDiagnosis returns false
       │
       ▼
  agent runs synthesize(anomaly, toolCalls)   ← dedicated tool-less call
       │  hands the model the evidence it already gathered
       │  asks ONLY for the structured shape, never more queries
       ▼
  parse synthesize() output
       │
       ▼
  still fails  →  return FALLBACK (a typed safe default)
                  "Insufficient data to determine a cause for this change."
```

The chain is: *primary parse → synthesis call → FALLBACK*. Each stage catches the previous stage's failure with a different mechanism. The synthesis call is the most interesting — it runs a SECOND Anthropic call with no tools and a stricter prompt, exclusively to convert the evidence into a structured shape. This is what makes "the model can't emit JSON" not a fatal error for the investigation.

**`MonitoringAgent` is simpler** — no synthesis call; it returns `[]` on any parse/validation failure. The reasoning: monitoring is checklist-driven (the agent works through 10 categories), so "no parseable result" usually means the model literally found nothing worth flagging, in which case `[]` is the *right* answer.

```
  Three agents, three handlers — graded by recovery aggressiveness

  MonitoringAgent      parse → []                        light (no synthesize)
  DiagnosticAgent      parse → synthesize() → FALLBACK   heavy (3 stages)
  RecommendationAgent  parse → synthesize() → []         heavy (3 stages)
  QueryAgent           returns finalText.trim() or "I was unable to…"   light
```

#### Path 4 — route setup error (before the stream opens)

```
  Route handler runs setup synchronously: getOrCreateSessionId → connectMcp
       │
       ▼
  try { conn = await connectMcp(sid); }
  catch (e) {
    console.error('[agent] setup error:', e);
    return NextResponse.json({ error: `/api/agent setup · ${e.message}` }, { status: 500 });
  }
       │
       ▼
  if (!conn.ok) return NextResponse.json({ needsAuth: true, authUrl: conn.authUrl }, { status: 401 });
```

Two failure modes here, both *before* the stream opens. AUTH_SECRET missing in production throws from `aesKey()` → caught here → returns 500 with the real error. Missing OAuth tokens → `connectMcp` returns `{ok: false, authUrl}` → returns 401 with the URL the browser should redirect to. Both return JSON because the stream hasn't started — we can still switch to a normal HTTP error response.

#### Path 5 — route mid-stream error (after the stream opens)

```
  Stream is open, controller is writing events.
  Any throw inside the try block lands here:

  } catch (e) {
    console.error('[agent] error:', e);
    send({ type: 'error', message: `/api/agent · ${e.message}` });
  } finally {
    controller.close();
  }
```

Once the stream is open, we can't return JSON — we already committed to NDJSON. The handler emits an `{type: 'error', message}` NDJSON line, then closes the stream cleanly. The client's NDJSON parser handles the error event explicitly (sets the error state, stops appending). This is the *structural* reason the route splits its try blocks: setup errors and streaming errors have different wire-format obligations.

#### Path 6 — client one-shot reconnect on 401

```
  app/page.tsx (briefing fetch)

  res = await fetch('/api/briefing')
  if (res.status === 401) {
    body = await res.json()
    if (body.needsAuth && body.authUrl) {
      // CHECK FOR LOOP: have we already tried to reconnect this session?
      alreadyTried = sessionStorage.getItem('bi:reconnecting') === '1'
      if (alreadyTried) {
        setStatus('error')  ← give up, show error
      } else {
        sessionStorage.setItem('bi:reconnecting', '1')  ← mark
        window.location.href = body.authUrl              ← redirect to IdP
      }
    }
  } else {
    sessionStorage.removeItem('bi:reconnecting')  ← clear flag on success
  }
```

The `bi:reconnecting` flag prevents an infinite reconnect loop: if the redirect-back lands and we still get 401, we know the IdP flow didn't help and we surface the error instead of redirecting again. The flag is cleared on the next successful briefing.

#### Path 7 — `useInvestigation` deliberately doesn't cancel on cleanup

```
  // NOTE: we deliberately do NOT cancel the fetch on effect cleanup. React
  // StrictMode (dev) mounts → cleans up → re-mounts; cancelling on the first
  // cleanup, with the started-guard blocking the re-mount, aborted the stream
  // and left the logs empty. The started-guard prevents a double fetch; the
  // in-flight run simply completes (setState after unmount is a safe no-op).
```

This is a failure-handling *anti-pattern* (don't cancel) chosen deliberately for a *correctness* reason (StrictMode would corrupt the stream otherwise). The cost: if a user genuinely navigates away mid-investigation, the agent keeps running on the server until it finishes (or hits maxToolCalls / maxTurns / Anthropic timeout). For a 30-90s run, that's wasted budget. The benefit: dev-mode StrictMode doesn't break the trace. Acceptable trade for now; named in file 08 as a potential future concern.

#### Path 8 — corrupt or tampered `bi_auth` cookie (fail open)

```
  lib/mcp/auth.ts  decryptStore

  function decryptStore(token: string): Store {
    try {
      ...AES-256-GCM decrypt and parse...
      return JSON.parse(plain) as Store;
    } catch {
      return {}; // tampered, rotated-secret, or corrupt cookie → treat as no auth
    }
  }
```

A tampered cookie or an `AUTH_SECRET` rotation breaks decryption (GCM auth tag mismatch). Returning `{}` means "no auth state" → connectMcp returns `{ok: false, authUrl}` → user re-auths. The alternative (throw) would crash every request with a corrupt cookie, which is worse — users would see 500s instead of a re-auth prompt. **Fail open to re-auth, not closed to error.**

### Move 2.5 — what's NOT handled, and what'd happen

Three failure paths the code doesn't handle. Each is a deliberate or accidental gap.

```
  NOT HANDLED: circuit breaker
    scenario:    Bloomreach is fully down for 5 minutes
    today:       every request burns 3 retries × ~12s wait = 36s before failing,
                 then surfaces the error. The route's 300s budget is mostly spent
                 in retry waits. 10 concurrent requests = 10 × 36s burnt
    would help:  break after N consecutive 5xx, fail fast for the next M seconds
    why missing: no production traffic to justify the complexity yet
    file ref:    NONE — gap

  NOT HANDLED: Anthropic timeout / retry
    scenario:    Anthropic returns 5xx or times out
    today:       agent loop throws → route catches → emits error event → close
    would help:  retry the model call with exponential backoff
    why missing: Anthropic's own SDK has some retry built in for 429/5xx;
                 we don't wrap it. For now this is acceptable; if Anthropic
                 reliability becomes an issue, wrap in retry-with-budget.
    file ref:    NONE — gap

  NOT HANDLED: partial-investigation persistence on failure
    scenario:    agent reaches turn 4, network fails mid-MCP call
    today:       the failure bubbles up; the route emits an error; the partial
                 trace IS sent to the client (every step was streamed before
                 the failure), but no saveInvestigation runs (it only runs
                 on the combined non-step path, on success)
    would help:  save what we have, mark it incomplete, let next visit resume
    why missing: resume semantics are hard; explicit "no resume" is correct
                 for now; the partial trace shown to the user is the recovery
    file ref:    app/api/agent/route.ts L254 (saveInvestigation only on combined+success)
```

### Move 3 — the principle

**Different failures need different handlers; one global "catch and crash" is the wrong answer for all of them.** This codebase honestly differentiates: rate limits get retried (parsed hint, bounded budget); transport errors get tagged and surfaced (no retry); model parse failures get a synthesis fallback (one more shot at the JSON); model output failures get a typed fallback (graceful degrade); auth failures get a re-auth redirect (not a 500); setup errors get JSON responses (not NDJSON); stream errors get NDJSON events (not JSON responses). Each handler is small (3–20 lines), each is matched to one failure mode, and the cumulative effect is that the user almost never sees an unrecoverable error. The lesson generalizes: name your failures one by one, give each a handler whose shape matches the failure's shape, and the system gets reliable not because nothing fails but because failures are routed.

---

## Primary diagram

The full failure topology — every path, every handler, every recovery action.

```
  Failure topology — 8 paths, each with its handler

  ┌─ Browser ────────────────────────────────────────────────────────────────────┐
  │                                                                               │
  │  one-shot reconnect-on-401 (bi:reconnecting flag in sessionStorage)           │
  │  useInvestigation does NOT cancel on cleanup (deliberate, StrictMode)         │
  │  no global error boundary on the page (gap, low severity)                     │
  └───────────────────────────────────┬───────────────────────────────────────────┘
                                      │
                                      ▼
  ┌─ Route handlers ─────────────────────────────────────────────────────────────┐
  │                                                                               │
  │  setup try/catch       → JSON 401 (needsAuth) or 500 (real error message)     │
  │  streaming try/catch   → NDJSON {type:'error', message} + controller.close()  │
  └───────────────────────────────────┬───────────────────────────────────────────┘
                                      │
                                      ▼
  ┌─ Agent loop ─────────────────────────────────────────────────────────────────┐
  │                                                                               │
  │  bounded turns (maxTurns=8)           prevents infinite tool-call loops       │
  │  bounded tool calls (maxToolCalls=4–6) hard budget cap per agent              │
  │  forced final turn                    drops tools, demands structured output  │
  │                                                                               │
  │  parse → synthesize() → FALLBACK     three-stage graceful-degrade            │
  │    (DiagnosticAgent · RecommendationAgent)                                    │
  │                                                                               │
  │  parse → []                          light graceful-degrade                  │
  │    (MonitoringAgent · QueryAgent fallback text)                              │
  └───────────────────────────────────┬───────────────────────────────────────────┘
                                      │
                                      ▼
  ┌─ McpClient ──────────────────────────────────────────────────────────────────┐
  │                                                                               │
  │  rate limit (isError: true + "retry after N second")                          │
  │    → parseRetryAfterMs → sleep(parsed + 500ms) → re-call                      │
  │    → up to maxRetries=3, each capped at retryCeilingMs=20s                    │
  │    → never cached                                                             │
  │                                                                               │
  │  transport throw (network, 401, 500)                                          │
  │    → SdkTransport adds captured response body                                 │
  │    → wrapped in McpToolError(toolName, detail, { cause })                    │
  │    → bubbles up; tc.error set; model sees is_error: true                     │
  │    → NO RETRY                                                                 │
  │                                                                               │
  │  ★ NO CIRCUIT BREAKER ★ — gap, named in file 08                              │
  └───────────────────────────────────┬───────────────────────────────────────────┘
                                      │
                                      ▼
  ┌─ Auth ───────────────────────────────────────────────────────────────────────┐
  │                                                                               │
  │  decryptStore catches → returns {} → connectMcp returns {ok:false, authUrl}   │
  │  → route returns 401 needsAuth → client redirects to IdP → re-auth            │
  │  (FAIL OPEN to re-auth, not closed to error)                                  │
  └──────────────────────────────────────────────────────────────────────────────┘
```

---

## Implementation in codebase

### Use cases

**Use case 1 — Bloomreach hits the 1-per-10s rate limit mid-investigation.** Agent's 3rd tool call hits 429 → McpClient parses "(1 per 10 second)" → sleeps 10.5s → retries → success → caches → returns to agent. The agent doesn't know it happened; the user sees a slightly longer `tool_call` duration. No error surfaces.

**Use case 2 — Anthropic returns "I'd need more data" instead of JSON.** DiagnosticAgent's `runAgentLoop` returns finalText that's prose, not JSON. `tryParseDiagnosis` returns null. `synthesize()` runs: a fresh Anthropic call with no tools, the evidence already gathered, and "you have NO more queries — produce JSON" prompt. The synthesis call returns valid JSON → typed `Diagnosis` is returned. The user sees a diagnosis that mentions the data was inconclusive. No error surfaces.

**Use case 3 — AUTH_SECRET rotated in production.** All existing `bi_auth` cookies become un-decryptable. User's next request → `decryptStore` catches the GCM tag mismatch → returns `{}` → `connectMcp` finds no tokens → returns `{ok: false, authUrl}` → route returns 401 needsAuth → user redirected to IdP → re-auth. User sees "click here to re-connect" instead of a 500.

**Use case 4 — Vercel restarts the instance mid-briefing.** Browser's `fetch` to `/api/briefing` is in flight. The instance dies. The stream errors out (TCP RST). Client's NDJSON reader sees an empty `read()` result. UI shows the partial events that did land + an error message. No reconnect (this is a hard failure; user retries manually).

### Failure handler file index

| Path | File · Owner | Lines | Handler |
|---|---|---|---|
| Rate limit retry | `lib/mcp/client.ts` · `callTool` | L121–L132 | Parse + sleep + re-call, bounded |
| Transport throw | `lib/mcp/transport.ts` · `SdkTransport.callTool` | L47–L58 | Capture HTTP error body, throw with cause |
| Tagged error | `lib/mcp/client.ts` · `McpToolError` + `errorDetail` | L55–L77, L160–L162 | Tag with tool name + server text |
| No-cache-on-error | `lib/mcp/client.ts` | L137–L139 | Skip cache write on `isError: true` |
| Agent parse → synthesize → FALLBACK | `lib/agents/diagnostic.ts` · `investigate` + `synthesize` | L46–L126 | Three-stage graceful degrade |
| Agent parse → synthesize → [] | `lib/agents/recommendation.ts` · `propose` + `synthesize` | L36–L133 | Three-stage graceful degrade |
| Agent parse → [] | `lib/agents/monitoring.ts` · `scan` | L113–L119 | Light graceful degrade (returns []) |
| Forced final turn | `lib/agents/base.ts` · `runAgentLoop` | L90–L102 | Drop tools, demand structured output |
| Bounded loop | `lib/agents/base.ts` · `runAgentLoop` | L85–L102 | maxTurns + maxToolCalls hard caps |
| Route setup try/catch | `app/api/briefing/route.ts` · `GET` | L161–L173 | JSON 401/500 before stream opens |
| Route stream try/catch | `app/api/briefing/route.ts` · `GET` | L247–L256 | NDJSON `error` event + close |
| Route setup try/catch | `app/api/agent/route.ts` · `GET` | L155–L166 | Same pattern |
| Route stream try/catch | `app/api/agent/route.ts` · `GET` | L255–L263 | Same pattern |
| Reconnect-once policy | `app/page.tsx` · briefing fetch | L394, L410–L427 | sessionStorage flag prevents loop |
| Do-not-cancel on cleanup | `lib/hooks/useInvestigation.ts` | L31–L36 (comment), L213 | StrictMode correctness over cleanup |
| Fail-open auth decrypt | `lib/mcp/auth.ts` · `decryptStore` | L69–L79 | Return `{}` on tampered/corrupt cookie |

### Sample — the parsed-hint retry mechanism

```
  lib/mcp/client.ts  (lines 121–132)  ← annotated

  // Rate-limit retry. Bloomreach enforces a multi-second global window and
  // states it in the error text; honor the parsed hint, else exponential
  // backoff off retryDelayMs — every wait capped at retryCeilingMs.
  // Latency note: against the 60s route budget (app/api/agent), maxRetries=3
  // at ~10s each can cost ~30s on a *single* call, so the cap stays low by
  // default — raising it risks blowing the per-investigation budget.
  let retries = 0;
  while (isRateLimited(result) && retries < this.maxRetries) {
    retries++;
    const hintMs = parseRetryAfterMs(result);                  ← parse server's stated window
    const backoffMs = this.retryDelayMs * 2 ** (retries - 1);  ← fallback: exponential
    const waitMs = Math.min(
      hintMs != null ? hintMs + RETRY_BUFFER_MS : backoffMs,    ← prefer hint + 500ms cushion
      this.retryCeilingMs,                                       ← cap either way at 20s
    );
    await sleep(waitMs);
    result = await this.liveCall(name, args);                   ← re-call (still spaced)
  }
       │
       └─ this 12-line loop IS the load-bearing reliability mechanism.
          Three load-bearing decisions:
          (1) parseRetryAfterMs preferred over backoff — wait the right
              amount, not some general formula
          (2) RETRY_BUFFER_MS=500 lands AFTER the penalty clears, not on
              its boundary (where a race could still 429)
          (3) retryCeilingMs caps every wait — protects against a misparsed
              or absurd hint wedging the request indefinitely
```

### Sample — the route's two try/catches

```
  app/api/agent/route.ts  (lines 155–264)  ← annotated, condensed

  // SETUP try/catch — runs BEFORE the stream opens; can return JSON
  let conn: Awaited<ReturnType<typeof connectMcp>>;
  try {
    const sid = await getOrCreateSessionId();
    conn = await connectMcp(sid);
  } catch (e) {
    console.error('[agent] setup error:', e);                  ← full stack to Vercel logs
    return NextResponse.json(
      { error: `/api/agent setup · ${e.message}` },
      { status: 500 },                                          ← JSON 500, real message
    );
  }
  if (!conn.ok) return NextResponse.json({ needsAuth: true, authUrl: conn.authUrl }, { status: 401 });

  // ... stream opens here ...
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        // ... bootstrap, run agents, emit events ...
      } catch (e) {
        console.error('[agent] error:', e);                     ← full stack to Vercel logs
        send({                                                   ← NDJSON error event
          type: 'error',
          message: `/api/agent · ${e.message}`,
        });
      } finally {
        controller.close();                                      ← always close cleanly
      }
    },
  });
       │
       └─ TWO try/catches because the wire format obligation changes
          when the stream opens. Setup can return JSON (401 needsAuth or
          500 setup error); once the stream is committed, errors MUST be
          NDJSON or the client's parser breaks. The split is the structural
          design constraint that makes both failure modes return useful
          messages to the user.
```

---

## Elaborate

### Why no circuit breaker

A circuit breaker would track consecutive 5xx errors from Bloomreach and "open" (fail fast for N seconds) after a threshold. The codebase has none. The honest reason is **scale** — we don't have enough traffic to justify the complexity. At 1 req/s/user, an outage manifests as a single slow request, not a flood. With 100 concurrent users, the math changes — each one burning 30s on retries adds up to real resource pressure, and a breaker that fails fast for 30 seconds saves the cumulative budget. The day this codebase serves real production traffic, the breaker is the first reliability investment.

### Why deliberate-no-cancel in `useInvestigation`

React StrictMode (dev) intentionally double-mounts effects: mount → cleanup → mount. If the cleanup cancels the fetch, the second mount tries to fetch again, but the started-guard says "no, we already started" — and the original fetch was just cancelled — so the trace is empty. Three options:

1. Don't use a started-guard, let StrictMode double-fetch. Wastes Anthropic + MCP budget.
2. Use a started-guard, cancel on cleanup. Empty trace.
3. Use a started-guard, *don't* cancel on cleanup. The original fetch completes; setState-after-unmount is a safe no-op. **Chosen.**

The cost is "a fetch that fires can't be cancelled by the user navigating away." For a 30-90s run, that's real wasted budget if the user actually leaves. The mitigation would be an `AbortController` driven by a *route change*, not a StrictMode cleanup — but that's not implemented. Named in file 08 as a small finding.

### Why three different "no parseable output" handlers

`MonitoringAgent` returns `[]`. `DiagnosticAgent` runs `synthesize()` → falls back to `FALLBACK`. `RecommendationAgent` runs `synthesize()` → falls back to `[]`. Why three patterns?

- Monitoring is *checklist-driven* — the agent works through 10 categories looking for anomalies. "Nothing parseable" almost always means "the model found nothing worth flagging," for which `[]` is the correct answer. Running a synthesis call would just consume more Anthropic budget to confirm "nothing found."
- Diagnostic is *exploratory* — the agent runs EQL queries to interpret one anomaly. "Nothing parseable" usually means the model *kept exploring* instead of synthesizing. The dedicated synthesize call hands the model exactly the evidence and asks for the structured shape. If that also fails, `FALLBACK` is a meaningful stub ("insufficient data to determine a cause") — empty array would be misleading.
- Recommendation is *generative* — propose 2–3 actions for a diagnosis. Same exploration pattern as diagnostic, so same synthesis fallback. But `[]` is a valid recommendation set (sometimes the diagnosis is "can't do anything actionable"), so empty array is the right zero-recommendation answer.

Three patterns because the *failure semantics* differ — and the architecture matches the semantics. This is also a debt (covered in `study-software-design/`) — the `synthesize` method is duplicated across diagnostic and recommendation; lifting it into `runAgentLoop` is a known refactor.

### Cross-link to legacy mechanism teaching

- The McpClient retry mechanism (with the parsed-hint + cushion + ceiling) → `.aipe/study-system-design-dsa/01-system-design/04-caching-and-rate-limiting.md`
- The agent loop's forced-final synthesis pattern → `.aipe/study-system-design-dsa/01-system-design/06-multi-agent-orchestration.md`
- The OAuth boundary's fail-open-to-re-auth pattern → `.aipe/study-system-design-dsa/01-system-design/02-oauth-boundary.md`
- The schema-gate's pure schema-capability classification (which keeps the monitoring agent from spending budget on unsupported categories — a form of failure prevention rather than handling) → `.aipe/study-system-design-dsa/01-system-design/08-schema-gated-coverage.md`

---

## Interview defense

**What they are really asking:** can you name every failure path in your system, name the handler, and honestly say what isn't handled?

---

**[mid] — Walk me through the failure handling in blooming insights.**

Eight paths, ranked by frequency. Most common: Bloomreach rate limit. McpClient parses the "retry after N seconds" text from the error body, sleeps that long plus 500ms, retries — up to 3 times with each wait capped at 20 seconds. Silently invisible to the user. Second: agent emits non-JSON. DiagnosticAgent runs a dedicated `synthesize()` call (tool-less Anthropic call that hands the model the evidence and asks for structured shape only); if that also fails, `FALLBACK` stub. Third: AUTH_SECRET rotation breaks decryption — `decryptStore` returns `{}` → user re-auths instead of seeing a 500. Fourth: route setup error returns JSON 401 or 500 before the stream opens. Fifth: route streaming error emits an NDJSON `error` event + closes cleanly. Sixth: client one-shot reconnect with a sessionStorage flag prevents infinite loops. Seventh: `useInvestigation` deliberately doesn't cancel on cleanup so StrictMode doesn't corrupt the trace. Eighth: tool errors never get cached, so transient failures don't poison the next 60 seconds.

```
  the failure routing

  rate limit       McpClient (parse + wait + retry, bounded)
  transport throw  McpToolError tagged + bubble (no retry)
  parse failure    synthesize() → FALLBACK
  auth failure     decryptStore returns {} → re-auth flow
  setup error      JSON 401/500
  stream error     NDJSON error event + close
```

---

**[senior] — Where's the load-bearing failure handler, and why?**

McpClient's retry loop. Without it, the 1-per-10-second Bloomreach rate limit would surface as a tool error every 1-in-10 calls, the diagnostic agent would see `is_error: true` on its tool results, and the user would get a partial diagnosis or a fallback every time we got unlucky on timing. The retry is what makes the rate limit a *latency* concern instead of an *availability* concern. Three things make it work: parsing the server's actual retry-after text (so we wait the right amount), the 500ms cushion (so we land after the penalty clears not on its boundary), and the 20-second ceiling on every wait (so a misparsed hint can't wedge the request). It's about 20 lines that absorb a structural constraint the user otherwise would see.

---

**[arch] — What failure path do you NOT handle, and what would it cost to add?**

Circuit breaker. If Bloomreach is fully down for 5 minutes, every request burns 3 retries × 12s each = ~36 seconds before failing. At 1 concurrent user, that's annoying. At 10 concurrent users, that's 6 minutes of compute wasted on doomed retries. The fix is a per-tool, per-instance circuit: track consecutive 5xx, after threshold (say 5) open the circuit for 30 seconds — every call during open fails fast. Roughly 30-50 lines of code, no external dependency. I'd add it the day this app sees real concurrent traffic. Today, the failure mode is "this user's request takes 36s and fails" rather than "this user's request takes 200ms and fails fast," and we accept the slow failure because there's no concurrency cost.

---

**The dodge — "have you seen production errors?"**

Not in real production — there hasn't been one yet. The visible failure modes I've seen are: rate-limit retries that succeed silently (verified in dev), the synthesize-fallback running when the model wanders off (verified by inspecting traces), and the re-auth flow when the demo cookie expires (manually tested). I haven't seen the route's 500 path fire because nothing has caused setup to throw in dev. The structured `console.error` with full stack in every catch block is there *so* the first real production error gives us the diagnostic information — Vercel function logs are the observability backstop. Adding real instrumentation (OpenTelemetry, or even just structured JSON logs with request IDs) is the next reliability investment after the circuit breaker.

---

**One-line anchors:**
- 8 failure paths, 8 different handlers, each shaped to its specific failure.
- McpClient's rate-limit retry is load-bearing — it absorbs the 1-per-N-second penalty as latency, not availability.
- The missing handler is a circuit breaker — fine at 1 user, costly at 10+.

---

## Validate your understanding

### Level 1 — Reconstruct
Without looking, name 6 failure paths in this codebase. For each, name the handler file and what the user ultimately sees. Check against the failure handler file index.

### Level 2 — Explain
Why does `McpClient.callTool` parse the retry-after hint instead of using fixed exponential backoff? What would change if it used backoff only? Reference `lib/mcp/client.ts` L31–L38 and L121–L132.

### Level 3 — Apply
A teammate proposes adding a "retry the whole investigation" button on the error UI. Walk through which failure path it would hook into, what state would need to be preserved, and whether the current architecture supports it. Reference the route's two try/catches and `lib/state/investigations.ts`.

### Level 4 — Defend
Defend the choice to NOT cancel the fetch on `useInvestigation` cleanup. When does this hurt the user, when does it help, and what's the right cancellation hook if you wanted one?

### Quick check
- Which file owns the rate-limit retry? → `lib/mcp/client.ts` L121–L132
- Which file owns the agent-output FALLBACK? → `lib/agents/diagnostic.ts` L16–L20 (FALLBACK constant); recovery chain L74–L82
- Which file owns the reconnect-once policy? → `app/page.tsx` L394, L410–L427 (the `bi:reconnecting` flag pattern)
- What's NOT retried? → transport throws (network errors, 5xx) — only rate-limit-shaped errors are retried
- What's NOT handled at all? → circuit breaker; Anthropic-specific retry beyond SDK defaults; partial-investigation persistence on failure

---

## See also

→ [04-caching-and-invalidation.md](./04-caching-and-invalidation.md) · [07-scale-bottlenecks-and-evolution.md](./07-scale-bottlenecks-and-evolution.md) · [08-system-design-red-flags-audit.md](./08-system-design-red-flags-audit.md) · `.aipe/study-system-design-dsa/01-system-design/04-caching-and-rate-limiting.md` (the McpClient retry mechanism in depth) · `.aipe/study-system-design-dsa/01-system-design/06-multi-agent-orchestration.md` (the forced-final + synthesize pattern)
