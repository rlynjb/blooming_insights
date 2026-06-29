# Error recovery in agents

*Industry standard — tool error feedback, infinite-loop detection, budget caps*

## Zoom out — where this concept lives

Agents fail in more ways than chains: tool calls can error, the LLM can loop on the same tool, the call budget can blow, the network can drop, the user can cancel. Most of the recovery here is delegated to `@aptkit/core` (which owns the loop); this codebase contributes the *boundary* defenses — typed tool errors that the model sees, the rate-limit retry inside `BloomreachDataSource`, and `AbortSignal` threading for clean cancellation.

```
  Zoom out — where each defense sits

  ┌─ Cancellation ───────────────────────────────────────────┐
  │  req.signal threaded everywhere                          │
  │  → route → agent → AptKit loop → adapter → DataSource    │
  │  → anthropic.messages.create                             │
  └──────────────────────────────────────────────────────────┘
  ┌─ Tool failure (transport / rate-limit) ──────────────────┐
  │  BloomreachDataSource.callTool:                          │
  │   - parses 429 retry window, waits, retries (max 3)      │
  │   - throws McpToolError tagged with tool name + detail   │
  └──────────────────────────────────────────────────────────┘
  ┌─ Tool failure (logic error in result) ───────────────────┐
  │  result.isError === true                                 │
  │  → fed back to model as tool_result with is_error: true  │
  │  → model can retry or pick different tool                │
  └──────────────────────────────────────────────────────────┘
  ┌─ ★ Infinite-loop + budget defenses (AptKit) ★ ───────────┐ ← we are here
  │  - 6-call cap enforced in prompt + library               │
  │  - if LLM emits no tool_use → loop exits cleanly         │
  └──────────────────────────────────────────────────────────┘
  ┌─ LLM call failure (HTTP error, 5xx, etc.) ───────────────┐
  │  bubbles up to route's try/catch                         │
  │  → 'error' event on stream → UI surfaces reconnect       │
  └──────────────────────────────────────────────────────────┘
```

**Zoom in.** Five failure modes, five recovery paths. The pattern is "fail at the right altitude" — transport errors at the adapter, tool-logic errors at the model, budget enforcement at the loop, cancellation everywhere.

## Structure pass — layers · axes · seams

**Layers:** UI → route → agent → adapter → MCP transport → Bloomreach.

**Axis: where does each failure originate / propagate / get contained?**

  → Transport errors (rate limit, 401, 5xx): originate at MCP transport, contained in `BloomreachDataSource` (retry), propagate up as `McpToolError` if retries exhausted.
  → Tool-logic errors (`isError: true` in result): originate at Bloomreach server, propagate verbatim to the model as `is_error: true` tool_result, contained by the model picking a different tool.
  → LLM call errors: originate at Anthropic, propagate to the route's try/catch, contained by emitting `'error'` to the stream and letting the UI handle reconnect.
  → Cancellation: originates at the client (closed tab), propagates through `req.signal`, contained by `AbortError` swallow in route's try/catch.

**Seam:** every layer's `try/catch` boundary. The route is the outermost; the agent loop's iteration is the innermost.

## How it works

### Move 1 — the mental model

You know how a try/catch can be at multiple layers — a tight try inside a function, a broader one in the caller, an outermost one at the request boundary? Same pattern here. Errors get caught at the altitude that knows how to handle them.

```
  Failure modes and recovery altitudes

  ┌──────────────────────┬──────────────────────────────────┐
  │ Failure              │ Where it's caught                │
  ├──────────────────────┼──────────────────────────────────┤
  │ MCP rate limit       │ BloomreachDataSource.callTool    │
  │                      │  (parses retry window, retries)  │
  ├──────────────────────┼──────────────────────────────────┤
  │ MCP 401 / OAuth lost │ McpToolError → route's auth      │
  │                      │  reconnect flow                  │
  ├──────────────────────┼──────────────────────────────────┤
  │ Tool returns isError │ Fed back to model as tool_result │
  │                      │  with is_error: true             │
  ├──────────────────────┼──────────────────────────────────┤
  │ LLM hallucinated     │ SDK rejects: schema mismatch     │
  │ tool name            │  → model gets error, picks again │
  ├──────────────────────┼──────────────────────────────────┤
  │ LLM loops on same    │ Budget cap (6 in monitoring,     │
  │ tool                 │  library caps elsewhere)         │
  ├──────────────────────┼──────────────────────────────────┤
  │ Budget exhausted     │ Forced final answer with         │
  │                      │  whatever has been accumulated   │
  ├──────────────────────┼──────────────────────────────────┤
  │ Anthropic HTTP 5xx   │ Route's try/catch → 'error'      │
  │                      │  event → UI handles              │
  ├──────────────────────┼──────────────────────────────────┤
  │ Client cancelled     │ AbortError swallowed at route;   │
  │                      │  phase log still emits           │
  └──────────────────────┴──────────────────────────────────┘
```

### Move 2 — the step-by-step walkthrough

**Part 1 — rate-limit retry inside the adapter.**

`BloomreachDataSource.callTool` at `lib/data-source/bloomreach-data-source.ts:153-170`:

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

Parses the server's stated penalty window (`"per 10 second"` or `"Retry after ~12 second(s)"`) from the error envelope, waits + a 500ms buffer, retries up to 3 times, every wait capped at `retryCeilingMs` (20s). The agent never sees rate limits — only the result, possibly delayed.

**Part 2 — tool-logic errors fed back to the model.**

When a tool result comes back with `isError: true`, the adapter passes it through to the model as a `tool_result` content block with `is_error: true`. From `lib/agents/aptkit-adapters.ts:66-76`:

```typescript
return {
  type: 'tool_result',
  tool_use_id: block.toolUseId,
  content: block.content,
  ...(block.isError ? { is_error: true } : {}),
};
```

The model sees `is_error: true` and can either retry with different args, pick a different tool, or synthesize a final answer noting the failure. The loop continues — one tool error doesn't kill the whole investigation.

**Part 3 — McpToolError for transport-level failures.**

`BloomreachDataSource.callTool` throws `McpToolError` when the transport layer fails (e.g. HTTP 401). From `lib/data-source/bloomreach-data-source.ts:98-105`:

```typescript
export class McpToolError extends Error {
  constructor(
    public readonly toolName: string,
    public readonly detail: string,
    options?: { cause?: unknown },
  ) {
    super(`${toolName} → ${detail}`, options);
    this.name = 'McpToolError';
  }
}
```

This propagates up through the agent loop, through the route's try/catch, and surfaces as an `'error'` event on the stream. The UI handles `invalid_token` specifically by triggering a reconnect — see `app/api/briefing/route.ts:81-152` and the feed's auto-reconnect at `app/page.tsx`.

**Part 4 — budget caps.**

The monitoring agent prompt at `lib/agents/legacy-prompts/monitoring.md:18`:

```
3. Make at most 6 tool calls total, then stop and return your JSON answer.
   Be decisive — do NOT re-run variations of the same query.
   After 6 calls you will be forced to answer with whatever you have.
```

Prompt-level cap is the first line of defense. AptKit's library has its own internal iteration cap as the second line. Belt-and-suspenders: prompt cap can be relaxed/tightened per agent; library cap is a hard ceiling.

**Part 5 — cancellation, threaded everywhere.**

`req.signal` from the route enters the agent constructor and threads through every async call. From `app/api/agent/route.ts:285`:

```typescript
diagnosis = await diagAgent.investigate(inv, { ...hooksFor('diagnostic'), signal: req.signal });
```

The signal reaches every downstream call: AptKit loop, `model.complete()`, `dataSource.callTool()`. Cancellation at any depth cleanly aborts. The route's try/catch swallows `AbortError`:

```typescript
} catch (e) {
  if (e instanceof DOMException && e.name === 'AbortError') {
    return;
  }
  // ... log and emit error event for non-cancel errors
}
```

The `finally` still fires, so the per-phase log records how much budget was burned before the cancel.

**Part 6 — what's NOT explicitly defended.**

  → **Infinite-loop detection beyond budget cap.** AptKit's library has internal loop detection, but this codebase doesn't add a defense layer ("if same tool + same args called twice in a row, halt"). The budget cap is the catch-all.
  → **Circuit breaker.** No "stop calling Anthropic if N consecutive 5xx in M seconds" defense. After 3 rate-limit retries, the call returns the rate-limit envelope; the next call retries from scratch. This is honest about not being implemented.

### Move 3 — the principle

**Fail at the right altitude.** Transport errors at the transport layer; tool-logic errors at the model layer; budget caps at the loop layer; cancellation at every layer. Pushing every error to one top-level catch would lose the recovery context. The structural commitment is "every layer knows what to do with the errors that originate at its own boundary."

## Primary diagram — the full recap

```
  Error recovery — five failure modes, five paths

  ┌─ Client cancellation ──────────────────────────────────────────┐
  │  Browser tab closes / navigates                                │
  │  → req.signal aborts                                           │
  │  → AbortError propagates up                                    │
  │  → route's catch swallows AbortError                           │
  │  → finally still runs (phase log + dispose)                    │
  └────────────────────────────────────────────────────────────────┘

  ┌─ MCP rate limit ───────────────────────────────────────────────┐
  │  Bloomreach returns 429-ish envelope                           │
  │  → BloomreachDataSource parses retry window                    │
  │  → sleep(window + 500ms), retry up to 3×                       │
  │  → agent never sees rate limits                                │
  └────────────────────────────────────────────────────────────────┘

  ┌─ MCP 401 / OAuth lost ─────────────────────────────────────────┐
  │  Bloomreach returns invalid_token                              │
  │  → McpToolError propagates                                     │
  │  → route's catch emits 'error' event                           │
  │  → UI's auto-reconnect resets auth + reloads (guarded)         │
  └────────────────────────────────────────────────────────────────┘

  ┌─ Tool returns logic error (isError: true) ─────────────────────┐
  │  Wrapped as tool_result with is_error: true                    │
  │  → model sees the error                                        │
  │  → loop continues; model retries with different args / tool    │
  └────────────────────────────────────────────────────────────────┘

  ┌─ LLM loops on same tool / budget exhausted ────────────────────┐
  │  Iteration cap fires (6 in monitoring, varies per agent)       │
  │  → AptKit forces final synthesis with whatever's accumulated   │
  │  → return typed partial result                                 │
  └────────────────────────────────────────────────────────────────┘

  ┌─ Anthropic HTTP 5xx ───────────────────────────────────────────┐
  │  SDK throws                                                    │
  │  → propagates through adapter, agent, AptKit, route            │
  │  → route's catch emits 'error' event                           │
  │  → UI shows error panel                                        │
  └────────────────────────────────────────────────────────────────┘
```

## Elaborate

**Why tool errors go to the model, not the catch.** A tool failing is information the model can act on. If `get_funnel` returns "funnel not found," the model can pick a different tool (`list_funnels`) or try different args (a different funnel name). Bubbling tool errors up to the catch would lose the recovery context — the model would never get a chance to recover.

The distinction: *transport* errors (the server is broken, OAuth is bad, the network is down) bubble up; *logic* errors (the request was malformed, the resource doesn't exist) go to the model.

**Why the rate-limit retry is inside the DataSource, not in the agent loop.** Rate limiting is a property of the Bloomreach server, not of the agent's reasoning. Putting it in the DataSource means it's transparent to every consumer (agent, route handler, test). If the rate limit logic lived in the agent layer, every agent (and every future agent) would have to know about it. The DataSource is the right altitude.

**Where the recovery story is weakest.** Two known gaps:

  → **No circuit breaker.** If Bloomreach is down for 30 minutes, every new request will spend 30+ seconds (3 retries × 10s each) before failing. A circuit breaker would fail-fast after N consecutive failures.
  → **No explicit infinite-loop detection beyond budget cap.** Same tool + same args called twice in a row isn't explicitly detected; it just burns calls toward the cap. The defense is the cap; the detection isn't surgical.

Both worth implementing eventually; not pressing today because volume is low and the cap catches the worst case.

## Project exercises

### Exercise — Add a circuit breaker around Anthropic calls

  → **Exercise ID:** B4.6
  → **What to build:** Wrap `AnthropicModelProviderAdapter.complete()` with a circuit breaker. After 5 consecutive failures in a 60s window, open the circuit — all `complete()` calls fail fast with `CircuitOpenError` for 60s. After 60s, half-open: try one call. If it succeeds, close. If not, re-open. Bonus: instrument with a `circuit_state` Vercel log line so you can see when it opens / closes.
  → **Why it earns its place:** today, if Anthropic is having an outage, every request burns the full timeout before failing — the user sees minutes of "loading" before an error. A circuit breaker means the user sees the error within ~1s after the first few requests confirm the outage. Pattern transfers to any external dependency.
  → **Files to touch:** new `lib/agents/circuit-breaker.ts` (the breaker), `lib/agents/aptkit-adapters.ts` (wrap `complete()`), `test/agents/circuit-breaker.test.ts` (cover all three states + transitions).
  → **Done when:** simulated Anthropic outage triggers the circuit to open after 5 failures, the breaker stays open for 60s, half-open succeeds and re-closes when service returns, and the per-call log emits `circuit_state` transitions.
  → **Estimated effort:** 1–2 days.

## Interview defense

**Q: "How does your agent handle a failing tool call?"**

Two paths, depending on the failure type. *Transport* failures (rate limit, 401, network) get retry-ladder logic inside the `BloomreachDataSource` adapter — parses the server's stated retry window, waits + 500ms buffer, retries up to 3 times. The agent never sees rate limits, just the delayed result. *Logic* errors (tool returned `isError: true`) get fed back to the model verbatim as a `tool_result` with `is_error: true` — the model sees the error and can retry with different args or pick a different tool. The loop continues.

The structural commitment: errors get caught at the altitude that knows how to recover, not at one global try/catch.

*Anchor: "Transport: retry in `BloomreachDataSource`. Logic: feed back to the model. Budget cap as backstop."*

**Q: "What happens when the agent gets stuck?"**

Budget cap fires. Monitoring's prompt enforces 6 calls max; AptKit's library has its own internal iteration cap as a backstop. When the cap hits, the loop exits with whatever's been accumulated — AptKit forces a final synthesis from the partial context. Better a partial typed output than infinite tokens.

I don't have explicit "same tool + same args called twice → halt" detection. The budget cap catches that case structurally rather than surgically. The `B4.6` exercise adds a circuit breaker for the next altitude up (Anthropic-level failures).

*Anchor: "Budget cap is the backstop; no surgical loop detection today; circuit breaker is the next move (`B4.6`)."*

## See also

  → `03-react-pattern.md` — the loop the budget cap protects
  → `06-production-serving/04-rate-limiting-backpressure.md` — the rate-limit story from the production-serving lens
  → `06-production-serving/05-retry-circuit-breaker.md` — the deep walk on retry + circuit breaker patterns
  → `study-system-design/10-rate-limit-aware-mcp-client.md` — the same retry logic from the system-design lens
