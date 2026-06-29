# Per-tool circuit breaking

**Industry standard.** Single-call retry handles one flaky request; agent loops can call the same flaky tool every turn. **Partially exercised** in this repo — retry-and-feed-back, not a full circuit-state machine.

## Zoom out, then zoom in

Sits at the data-source layer, between the agent's tool call and the wire. The single-call version protects your service from a dead dependency; the agent version does that *and* feeds the failure back to the agent so the agent can route around it.

```
  Zoom out — where this concept lives

  ┌─ Agent loop ─────────────────────────────────────┐
  │  tool_use → tools.callTool                       │
  └───────────────────────┬──────────────────────────┘
                          ▼
  ┌─ Data source layer ──────────────────────────────┐
  │  ★ retry + cache + (no formal breaker) ★         │ ← we are here
  │  failure surfaces to the agent as tool_result    │
  │  with is_error: true                              │
  └───────────────────────┬──────────────────────────┘
                          ▼
  ┌─ Wire ───────────────────────────────────────────┐
  │  MCP transport → Bloomreach server                │
  └──────────────────────────────────────────────────┘
```

## Structure pass

Layers: tool call → cache check → spacing → wire call → retry on rate-limit → error envelope → tool_result back to agent.

**Axis traced — "what happens when a tool is unavailable?":** in this repo, the data source retries on rate-limit (up to 3x with the server-stated retry-after window), then surfaces failure to the agent as a `tool_result` with `is_error: true`. The agent reads that and can route around the dead tool in subsequent turns. No formal circuit-state machine (closed/open/half-open) is implemented.

**Seam:** the `tool_result` block with `isError: true`. That's the boundary where infrastructure failure becomes agent observation.

## How it works

### Move 1 — the mental model

You know circuit breakers from microservices — if a downstream service is failing, fail fast locally instead of waiting on every call. Three states: closed (calls pass through), open (calls fail fast), half-open (try one to see if it recovered).

The agent version layers one extra thing on top: when the breaker is open, *tell the agent*. A breaker that just fails fast without informing the agent leaves the agent retrying the same dead path every turn. The agent observes the failure as a `tool_result` and reasons about whether to try a different tool.

```
  Per-tool breaker with feedback to the agent

  Agent calls tool X
       │
       ▼
  ┌───────────────────────────────────────────────┐
  │  Circuit breaker (per tool)                   │
  │   closed:    calls pass through               │
  │   N fails →  OPEN: fail fast, don't call tool │
  │   after T:   half-open, try one               │
  └───────────────────────────────────────────────┘
       │ tool X open?
       ▼
  Agent observes "tool X unavailable" and routes
  around it (picks a different tool / degrades /
  escalates) — instead of retrying it every turn
```

### Move 2 — step by step

#### What this repo has — retry, not break

Open `lib/data-source/bloomreach-data-source.ts:139-188`. The retry ladder:

```ts
// lib/data-source/bloomreach-data-source.ts:154-174
const start = Date.now();
let result = await this.liveCall(name, args, options.signal);

let retries = 0;
while (isRateLimited(result) && retries < this.maxRetries) {
  retries++;
  const hintMs = parseRetryAfterMs(result);             // parse "retry after N seconds"
  const backoffMs = this.retryDelayMs * 2 ** (retries - 1);  // exponential fallback
  const waitMs = Math.min(
    hintMs != null ? hintMs + RETRY_BUFFER_MS : backoffMs,
    this.retryCeilingMs,
  );
  await sleep(waitMs);
  result = await this.liveCall(name, args, options.signal);
}

const durationMs = Date.now() - start;
if ((result as any)?.isError === true) {
  return { result: result as T, durationMs, fromCache: false };  // surface error
}
```

The logic:

1. **Make the call.** First attempt against the wire.
2. **Is the response rate-limited?** `isRateLimited` (`bloomreach-data-source.ts:51-55`) checks `result.isError === true` AND the content text matches `/rate limit|too many requests/i`.
3. **Parse the server's stated retry window.** `parseRetryAfterMs` (`bloomreach-data-source.ts:64-71`) handles two observed shapes — "Retry after ~N second(s)" and "rate limit reached (1 per N second)" — extracting the wait time.
4. **Sleep and retry.** Use the parsed hint if available; fall back to exponential backoff (`retryDelayMs * 2^(retries-1)`). Cap the wait at `retryCeilingMs` (20s default).
5. **Try up to maxRetries times.** Default 3. If still rate-limited after 3 retries, surface the error to the agent.
6. **On non-error: cache and return.** On error: skip the cache (don't poison it), return the error envelope with `fromCache: false`.

This is the retry-and-feed-back pattern. The agent receives the failure as a `tool_result` with `isError: true`; the model on the next turn can decide to (a) try the same tool again with different args, (b) try a different tool, or (c) give up and synthesize from what it has.

What's *missing* is the formal circuit-state machine. There's no `closed` → `open` → `half-open` state tracked per tool. The retry ladder treats every call as a fresh attempt; a tool that's been down for 5 minutes will still pay the retry cost on every new agent call rather than failing fast.

#### Why the missing breaker is okay (for now)

The retry-and-surface pattern handles the dominant failure mode in this repo (transient rate-limit errors) well. A circuit-state machine would help for *persistent* failures (Bloomreach's server is down for an hour) by failing fast instead of paying retry cost. For this repo's use pattern (low-volume, demo-cadence), persistent failures are rare and the retry cost is acceptable.

The threshold where the formal breaker would earn its place: high-volume use where retries-during-outages would meaningfully spike cost and latency. At that point, tracking per-tool state (consecutive failure count, cooldown timer) and short-circuiting calls during the open state is the standard pattern.

#### The feedback to the agent — the load-bearing detail

The most important behavior is the failure flowing back to the agent as a `tool_result` with `is_error: true`. The agent loop's harness handles this in `run-agent-loop.js:73-86`:

```js
let isError = false;
let resultContent;
try {
  const { result, durationMs } = await tools.callTool(toolUse.name, toolUse.input, { signal });
  toolCall.result = result;
  toolCall.durationMs = durationMs;
  resultContent = truncate(JSON.stringify(result));
} catch (error) {
  isError = true;
  const message = error instanceof Error ? error.message : String(error);
  toolCall.error = message;
  resultContent = truncate(JSON.stringify({ error: message }));
}
toolCalls.push(toolCall);
// emit trace event with the error
toolResults.push({
  type: 'tool_result',
  toolUseId: toolUse.id,
  content: resultContent,
  ...(isError ? { isError: true } : {}),
});
```

Two error paths:

1. **`tools.callTool` throws.** The `try/catch` catches it, sets `isError = true`, packages the error message in the `content` string, marks the `tool_result` block with `isError: true`.
2. **`tools.callTool` returns an error result.** The `BloomreachDataSource` already returned `{result: errorEnvelope, ...}`; the result's `isError: true` is in the result object, the harness packages it as `tool_result` content as usual. The model sees the error content.

Both paths feed the failure back to the model. The model on the next turn reads the error and can adapt — this is the "agent reasons around a dead tool" capability the per-tool breaker pattern unlocks. Without this feedback (a breaker that fails fast without telling the agent), the agent would retry the same dead path every turn.

### Move 3 — the principle

**An agent's retry story is different from a service's retry story because the agent can reason about the failure.** A service that retries a dead dependency is just waiting; an agent that receives the failure as a `tool_result` can change its strategy. The control that matters most isn't the retry count or the backoff — it's the *failure-as-observation* feedback that lets the agent route around the dead path. Add the formal circuit-state machine when the volume justifies the persistent-failure cost savings; until then, retry-and-surface covers the dominant pattern.

## Primary diagram

```
  The retry ladder + agent feedback path in this repo

  ┌─ Agent emits tool_use(execute_analytics_eql, args) ──────────────┐
  └────────────────────────────────────┬──────────────────────────────┘
                                       ▼
  ┌─ tools.callTool → BloomreachDataSource.callTool ──────────────────┐
  │                                                                     │
  │   1. cache check                                                    │
  │       cacheKey = name:JSON.stringify(args), TTL 60s                 │
  │       hit + not expired? return { result, durationMs:0,            │
  │                                    fromCache: true }                │
  │                                                                     │
  │   2. liveCall                                                        │
  │       spacing: wait until 200ms since last call                     │
  │       transport.callTool → MCP wire → loomi connect server          │
  │       on transport error: throw McpToolError                        │
  │       on response: return result envelope                            │
  │                                                                     │
  │   3. retry on rate-limit (up to 3x)                                  │
  │       isRateLimited(result)?                                         │
  │         yes → parseRetryAfterMs(result)                             │
  │               sleep min(hint+500ms, backoff, ceiling 20s)           │
  │               liveCall again                                         │
  │                                                                     │
  │   4. on non-error: cache + return                                    │
  │      on still-error after retries: return error envelope            │
  │       (DO NOT cache errors — would poison)                          │
  └────────────────────────────────────┬──────────────────────────────┘
                                       ▼
  ┌─ run-agent-loop.js packages the response ─────────────────────────┐
  │   if catch: { type: 'tool_result', isError: true,                   │
  │              content: JSON.stringify({error: e.message}) }          │
  │   if isError result: { type: 'tool_result', isError: true,          │
  │                        content: JSON.stringify(result) }            │
  │   if success: { type: 'tool_result', content: ... }                 │
  └────────────────────────────────────┬──────────────────────────────┘
                                       ▼
  ┌─ Next turn: model reads the tool_result ──────────────────────────┐
  │   if isError visible in content:                                    │
  │     model can: retry with different args                            │
  │                try a different tool                                  │
  │                give up and synthesize from what it has              │
  │   the agent reasons AROUND the failure, not THROUGH it              │
  └────────────────────────────────────────────────────────────────────┘

  MISSING: formal circuit-state machine (closed / open / half-open).
  Persistent failures pay the retry cost on every new agent call.
  Adequate for low-volume use; would warrant the formal breaker at
  high-volume cost-sensitive scale.
```

## Elaborate

The retry-and-surface pattern this repo runs is the lower-complexity end of a spectrum that ends with a full Hystrix-style circuit breaker. The progression:

1. **No retry.** First-class failure — the agent just sees the error.
2. **Retry with backoff.** What this repo has. Bounded attempts, server-aware retry-after window honored.
3. **Per-tool circuit breaker.** Adds persistent-failure state — fail fast for a cooldown window when a tool has been failing repeatedly.
4. **Hierarchical breaker.** Per-tool AND per-host AND per-service. Coordinated across many call sites.
5. **Adaptive concurrency + breaker.** Dynamic concurrency limits driven by observed latency/error rates.

Most production agent systems land at step 2 or 3. Step 4 and beyond is microservices-scale infrastructure that doesn't pay off until you have many call sites coordinating against shared dependencies.

The "feed the failure back to the agent" piece is what makes the agent retry pattern qualitatively different from a service retry pattern. In a service, retry is a transparent wrapper — the caller doesn't know the call was retried. In an agent, the failure becoming an observation IS the safety mechanism — the model can adapt its strategy. A breaker that fails fast but doesn't tell the agent is worse than no breaker at all (the agent retries the same dead path on every turn).

The 16,000-char tool-result truncation (`run-agent-loop.js:2-7`) interacts with error feedback: a very long error message can still be truncated. The current shape (`{error: e.message}` JSON) is short enough this isn't a concern; if errors started carrying server stack traces or full request bodies, the truncation could cut the model's view of the error mid-sentence. The mitigation is keeping error envelopes structured and short.

## Interview defense

> **Q: How does this codebase handle tool failures?**
>
> Retry-and-surface, no formal circuit breaker. `BloomreachDataSource.callTool` (`lib/data-source/bloomreach-data-source.ts:139-188`) catches rate-limit errors from the MCP response, parses the server's stated retry window (handles two formats: "retry after N seconds" and "rate limit reached (1 per N second)"), sleeps the parsed window plus a 500ms buffer (capped at 20s ceiling), and retries up to 3 times. If still rate-limited after retries OR if the transport throws, the error surfaces to the agent as a `tool_result` block with `isError: true`. The agent reads that on the next turn and can adapt — try the same tool with different args, try a different tool, or synthesize from what it has.

> **Q: Why not a formal circuit-state machine?**
>
> The retry-and-surface pattern handles the dominant failure mode in this repo (transient rate-limit errors from Bloomreach's alpha server) well. The formal circuit breaker — closed/open/half-open with cooldown timers — would help for *persistent* failures by failing fast instead of paying retry cost on every call. At this repo's volume (low traffic, demo cadence), persistent failures are rare and the retry cost is acceptable. The threshold where the formal breaker earns its place is high-volume use where retries-during-outages would spike cost and latency meaningfully. That's the escalation point worth naming.

> **Q: What makes the agent retry story different from a service retry story?**
>
> The failure becoming an observation. In a service, retry is a transparent wrapper — the caller doesn't know the call was retried. In an agent, the model receives the error as a `tool_result` and can *reason* about it: try a different tool, change the args, give up gracefully. A breaker that fails fast without telling the agent leaves the agent retrying the same dead path on every turn. The "failure-as-observation" piece is the load-bearing addition that single-call retry libraries don't have. This repo gets it for free because the harness in `run-agent-loop.js:73-86` packages caught errors as `tool_result` blocks with `isError: true`.

> **Q: What's the failure mode of caching errors?**
>
> Cache poisoning. If a transient rate-limit error got cached, every subsequent agent call to the same tool + args would get the cached error envelope for 60s, even after the actual error condition cleared. The agent would observe a persistent failure when the underlying problem was transient. `BloomreachDataSource.callTool` (`bloomreach-data-source.ts:179-182`) explicitly checks for `isError === true` and returns without caching when it sees one. Errors die at the source; the next call retries fresh.

## See also

- → `04-agent-infrastructure/03-tool-calling-and-mcp.md` — the wire path the retry ladder protects
- → `01-cross-turn-caching.md` — what the retry ladder explicitly does NOT cache
- → `02-fan-out-backpressure.md` — the rate-limit signal both the retry and the cap respond to
- → `03-multi-agent-orchestration/09-coordination-failure-modes.md` — the "tool-call cascade" failure this controls in single-agent loops
- → cross-reference (when generated): `study-ai-engineering`'s retry-and-circuit-breaker file — the single-call mechanics this builds on
- → cross-reference (when generated): `study-system-design`'s caching-and-rate-limiting file — the same `BloomreachDataSource` from a system-design lens
