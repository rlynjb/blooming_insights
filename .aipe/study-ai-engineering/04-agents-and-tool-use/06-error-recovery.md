# 06 — error recovery in agents

**Subtitle:** Tool errors, timeouts, runaway loops, parse failures · Industry standard

## Zoom out, then zoom in

Agents fail in more ways than chains. Five common failure modes,
mitigated by layers spread across AptKit and Blooming.

```
  Zoom out — error sources by layer

  ┌─ Provider (Anthropic) ─────────────────────┐
  │   5xx, rate limit, model error             │  ← Anthropic SDK auto-retries
  └────────────────────────────────────────────┘
  ┌─ Adapter (Blooming) ───────────────────────┐
  │   typed validation failure                 │  ← parseAgentJson + isX guard
  └────────────────────────────────────────────┘
  ┌─ Tool registry (Blooming) ─────────────────┐
  │   tool returns error result                │  ← BloomreachDataSource catches  ← we are here
  │   tool times out                           │     and surfaces as McpToolError
  │   rate-limit retry                          │
  └────────────────────────────────────────────┘
  ┌─ Loop (AptKit) ────────────────────────────┐
  │   max iterations hit                       │  ← AptKit hard cap
  │   model loops on same tool                  │  ← prompt cap (6 calls)
  └────────────────────────────────────────────┘
  ┌─ Route (Blooming) ─────────────────────────┐
  │   AbortError (user navigated away)         │  ← skip error emit, close stream
  │   any other throw                          │  ← emit { type: 'error', message }
  └────────────────────────────────────────────┘
```

## Structure pass

  → **One axis to trace — recovery strategy.** Each layer handles its
    own failure mode. Lower layers (provider, tool) try to recover
    silently (retry, timeout); middle layers (validator) reject early
    so failure surfaces as throws not silent corruption; upper layers
    (route) translate throws to user-facing errors.

## How it works

### Move 1 — the mental model

Same shape as defense in depth: each layer catches what it can, throws
what it can't, and the route handler is the last line that turns a
throw into a user-visible message.

```
  Failure modes + mitigations

  ┌──────────────────────┬──────────────────────────────────┐
  │ Failure              │ Recovery                         │
  ├──────────────────────┼──────────────────────────────────┤
  │ Tool returns error   │ AptKit passes error as observation│
  │ (e.g. EQL syntax)    │ → model retries with corrected   │
  │                      │   query                           │
  ├──────────────────────┼──────────────────────────────────┤
  │ Tool times out       │ 30s transport timeout in MCP     │
  │                      │ → AbortError → loop or fail      │
  ├──────────────────────┼──────────────────────────────────┤
  │ Rate limit (Bloomreach)│ BloomreachDataSource parses    │
  │                      │ retry-after, sleeps, retries up  │
  │                      │ to 3x                            │
  ├──────────────────────┼──────────────────────────────────┤
  │ Model loops on same  │ Prompt cap ("at most 6 tool      │
  │ tool                  │ calls") + AptKit iteration limit │
  ├──────────────────────┼──────────────────────────────────┤
  │ Model emits invalid  │ parseAgentJson throws            │
  │ JSON                 │ → AptKit catches or rethrows;    │
  │                      │ → route emits 'error' event       │
  ├──────────────────────┼──────────────────────────────────┤
  │ User navigates away  │ AbortController fires             │
  │                      │ → throwIfAborted in loop          │
  │                      │ → AbortError caught at route,    │
  │                      │   error event SKIPPED             │
  └──────────────────────┴──────────────────────────────────┘
```

### Move 2 — the step-by-step walkthrough

**Layer 1 — tool error returns.** When `BloomreachDataSource.callTool`
gets back a result with `isError: true`, it doesn't throw — it returns
the error result so AptKit can pass it back to the model as an
observation:

```typescript
// lib/data-source/bloomreach-data-source.ts:179-181
if ((result as any)?.isError === true) {
  return { result: result as T, durationMs, fromCache: false };
}
```

The model sees something like `{ isError: true, content: [{type:
'text', text: 'EQL syntax error: unexpected token'}] }` as the next
turn's observation. Its next thought says "that query failed; let me
fix the syntax" and it tries again. This is recovery-by-feedback —
the model fixes its own errors when it can see them.

**Layer 2 — rate-limit retry.** Bloomreach's alpha server enforces "1
per 10 second" globally per user. `BloomreachDataSource.callTool`
detects rate-limit errors, parses the server-stated penalty window,
sleeps, and retries up to 3 times
(`lib/data-source/bloomreach-data-source.ts:163-174`):

```typescript
let retries = 0;
while (isRateLimited(result) && retries < this.maxRetries) {
  retries++;
  const hintMs = parseRetryAfterMs(result);
  const backoffMs = this.retryDelayMs * 2 ** (retries - 1);
  const waitMs = Math.min(
    hintMs != null ? hintMs + RETRY_BUFFER_MS : backoffMs,
    this.retryCeilingMs,
  );
  await sleep(waitMs);
  result = await this.liveCall(name, args, options.signal);
}
```

The AptKit loop above doesn't see rate-limit retries — they're
absorbed silently inside `callTool`. The agent's turn just takes
longer. See `06-production-serving/05-retry-circuit-breaker.md` for
the full pattern.

**Layer 3 — tool timeout.** The MCP transport (`lib/mcp/transport.ts`)
applies a 30s per-call timeout via `AbortSignal.timeout(30000)`
composed with the route's `req.signal`. A tool that hangs gets
`AbortError`'d, propagates up as `McpToolError` (with a meaningful
`toolName` and `detail`), and the route catches it.

**Layer 4 — validation failure.** When the model's final synthesis
emits invalid JSON, `parseAgentJson` throws "no parseable json in
agent output" (`lib/mcp/validate.ts:12`). AptKit may retry the
model turn; if it can't, the throw propagates to the route, which
emits `{ type: 'error', message: '...' }`.

**Layer 5 — runaway loops.** Two caps:

  → **Prompt cap.** Every agent prompt says "make at most N tool
    calls then conclude" (6 for monitoring/diagnostic, 4 for
    recommendation). This is a soft cap — the model usually
    respects it.

  → **AptKit hard cap.** AptKit's loop has a max-iteration limit
    (configured in AptKit). If the model ignores the prompt cap and
    keeps emitting `tool_use`, AptKit forces termination by emitting
    a "max iterations reached, return best answer" signal.

**Layer 6 — user navigates away.** When the browser cancels the
fetch:
  - Route handler's `req.signal.aborted` becomes true.
  - Next `req.signal.throwIfAborted()` in the route throws
    `DOMException: AbortError`.
  - The route's catch (`app/api/agent/route.ts:308-310`) recognizes
    AbortError and *skips* the error event emit (no one's listening),
    just lets the finally close the stream.

```typescript
if (e instanceof DOMException && e.name === 'AbortError') {
  return;  // skip error emit, finally still runs
}
```

This is the difference between *failure* (something went wrong, tell
the user) and *cancellation* (nothing went wrong, the user just left).
Different recovery: failure surfaces, cancellation is silent.

### Move 3 — the principle

**Push recovery as low in the stack as possible. Tool errors retry at
the tool layer; rate limits retry at the transport layer; runaway loops
are bounded at the loop layer; the route is only the last
catch-and-translate. Each layer's recovery makes the layers above it
simpler.** The opposite anti-pattern is "everything throws to the
route handler" — which works in tutorials and falls over in production
because the route has no idea how to recover from a rate limit when
the agent loop is mid-investigation.

## Primary diagram

```
  Failure flow — error sources, mitigations, escape points

  ┌─ Route handler (app/api/agent/route.ts) ──────────────────┐
  │                                                            │
  │  ┌─ AptKit agent loop ──────────────────────────────────┐ │
  │  │                                                       │ │
  │  │  ┌─ adapter.complete() ─┐                             │ │
  │  │  │  Anthropic SDK retries│  ← provider errors handled│ │
  │  │  └──────────┬────────────┘                             │ │
  │  │             │                                          │ │
  │  │             ▼ tool_use detected                        │ │
  │  │  ┌─ BloomingToolRegistryAdapter ─┐                    │ │
  │  │  │  ┌─ BloomreachDataSource ────┐ │                   │ │
  │  │  │  │  rate-limit retry  ◄──────┘ │  ← absorbed       │ │
  │  │  │  │  cache hit                  │                    │ │
  │  │  │  │  transport timeout 30s      │  ← AbortError up   │ │
  │  │  │  │  isError → return result    │  ← model recovers  │ │
  │  │  │  └────────────────────────────┘                    │ │
  │  │  └──────────┬────────────────────┘                     │ │
  │  │             │                                          │ │
  │  │             ▼ tool result back to model                │ │
  │  │             │                                          │ │
  │  │  iteration cap hit? ─── yes ─► force terminate         │ │
  │  │       │ no                                             │ │
  │  │       ▼                                                │ │
  │  │   model emits final text                               │ │
  │  │       │                                                │ │
  │  │       ▼                                                │ │
  │  │   parseAgentJson → throws if invalid                   │ │
  │  │   isDiagnosis → throws if wrong shape                  │ │
  │  └──────────────────────────────────────────────────────┘ │
  │                                                            │
  │  catch (e):                                                │
  │    if AbortError → return (silent — user left)             │
  │    else → send { type: 'error', message }                  │
  │                                                            │
  │  finally:                                                  │
  │    dispose data source                                     │
  │    log phase summary                                       │
  │    controller.close()                                      │
  └────────────────────────────────────────────────────────────┘
```

## Elaborate

The "tool error as observation" pattern (Layer 1) is the cleanest LLM-
specific recovery move. The model emitted a bad EQL query; the server
said "syntax error"; the model sees the error in its next observation
and naturally retries with a corrected query. No code change needed —
the loop's natural feedback handles it. The prompt helps by listing
common EQL syntax errors (`lib/agents/legacy-prompts/monitoring.md`
has a "Common errors to avoid" section that pre-empts most of these).

The "AbortError is silent" distinction (Layer 6) is subtle but matters
for production observability. Without it, every user-navigation-away
would log an "error" line and the dashboard would show a 30% error
rate that's actually a 30% normal-cancellation rate. The categorical
distinction between *failure* and *cancellation* is what keeps the
error budget meaningful.

## Project exercises

### Exercise — surface "retry exhausted" distinctly from generic errors

  → **Exercise ID:** `study-ai-eng-04-06.1`
  → **What to build:** Add a `RetryExhaustedError extends Error` class
    in `lib/data-source/bloomreach-data-source.ts`, thrown when the
    rate-limit retry loop exits without success. Catch it specifically
    in the route and emit `{ type: 'error', message, retryable: true }`
    so the UI can show a "wait 30s and try again" affordance.
  → **Why it earns its place:** Today rate-limit-exhaustion looks like a
    generic error to the UI. Distinguishing it lets the UI offer the
    right recovery (wait, not "refresh page").
  → **Files to touch:** `lib/data-source/bloomreach-data-source.ts`,
    `app/api/agent/route.ts`, `lib/mcp/events.ts`,
    `lib/hooks/useReconnectPolicy.ts`,
    `components/feed/InsightCard.tsx` (or wherever error renders).
  → **Done when:** Exhausting the retry budget shows a distinct
    "rate-limited, wait 30s" message instead of generic "something
    went wrong."
  → **Estimated effort:** `1–4hr`

### Exercise — detect "model looped on same tool" and surface

  → **Exercise ID:** `study-ai-eng-04-06.2`
  → **What to build:** In `BloomingTraceSinkAdapter`, count consecutive
    `tool_call_start` events for the same tool name. If >3 in a row,
    emit a `{ type: 'warning', message: 'model looping on toolX' }`
    event. The UI can show a soft warning in the trace.
  → **Why it earns its place:** Today repeated tool calls are invisible
    — you have to scroll the trace to notice. Making it surface
    automatically lets you spot prompt-tuning opportunities.
  → **Files to touch:** `lib/agents/aptkit-adapters.ts:100-141`,
    `lib/mcp/events.ts`, `components/investigation/ReasoningTrace.tsx`.
  → **Done when:** An investigation where the model calls
    `execute_analytics_eql` 4 times in a row shows a warning chip in
    the StatusLog.
  → **Estimated effort:** `1–4hr`

## Interview defense

**Q: What can go wrong during an agent investigation, and how do you
handle each?**

Six failure modes, six layers:

```
  source              mitigation                       layer
  ──────              ──────────                       ─────
  tool returns error  pass as observation, model       AptKit
                      retries with correction
  rate limit          parse retry-after, sleep, retry  BloomreachDataSource
  tool timeout (30s)  AbortError → propagate           transport
  invalid JSON        parseAgentJson throws → maybe    validator
                      retry, then error event
  runaway loop        prompt cap (6 calls) + AptKit    prompt + loop
                      hard cap
  user navigated      AbortError → SILENT (skip emit) route catch
```

Push recovery as low as possible. The route's catch is the
catch-and-translate — it doesn't recover, it just turns whatever
escaped into either a user-visible error event or a silent close
(for AbortError, which means "user left, nothing went wrong").

**Anchor line:** "Layered recovery. Each layer handles its own failure
mode. The route is the last line — it translates throws into wire
events but doesn't recover."

**Q: What's the load-bearing distinction in the route's catch?**

AbortError vs everything else. AbortError means the user navigated
away — no consumer for the error event, so emitting it would just log
noise. Everything else means actual failure — emit the error event so
the UI can show something. Without this distinction, every navigation-
away would log as an error and your error rate would be ~30% of
sessions instead of the real 1-2%.

```typescript
if (e instanceof DOMException && e.name === 'AbortError') {
  return;  // silent — user left
}
// else: send error event
```

**Anchor line:** "Failure vs cancellation. AbortError is cancellation;
it's silent. Everything else is failure; emit and surface."

## See also

  → `01-agents-vs-chains.md` — the loop these failures happen inside
  → `06-production-serving/05-retry-circuit-breaker.md` — the retry layer
    that wraps the data source
  → `06-production-serving/04-rate-limiting-backpressure.md` — the
    rate-limit detection that triggers the retry
