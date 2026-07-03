# Error recovery in agents

## Subtitle

Graceful degradation / fault-tolerant agent loop — Industry standard.

## Zoom out, then zoom in

Agents fail in more ways than chains. Any tool call can time out, 429, 500, or return malformed JSON. Any model turn can loop on the same wrong tool. Any provider can drop mid-response. blooming's error recovery story runs across three levels: the transport handles connection-layer failures, the DataSource retries rate limits, and the agent loop presents remaining failures to the model as observations. The load-bearing receipt: **9 injected faults / 3 investigations / 0 failed** — the `FaultInjectingDataSource` decorator pumps random failures into a load harness, and the agent's reasoning-around-failures pattern completes every investigation.

```
  Zoom out — three error recovery layers

  ┌─ Transport (lib/mcp/transport.ts) ────────────────┐
  │  30s per-call timeout, redacted error text         │
  └───────────────────────┬────────────────────────────┘
                          │
                          ▼
  ┌─ DataSource (lib/data-source/bloomreach-...) ─────┐
  │  retry ladder for rate-limit (~1 req/s)             │
  │  no-cache-on-error                                  │
  └───────────────────────┬────────────────────────────┘
                          │  remaining failures
                          ▼
  ┌─ Agent loop ★ ─────────────────────────────────────┐ ← we are here
  │  tool_result { is_error: true, content: "..." }     │
  │  model reads error as observation, reasons around   │
  └────────────────────────────────────────────────────┘
```

Zoom in: the agent's superpower is the `is_error: true` flag on tool_result. The model sees it, adjusts, tries something else.

## Structure pass

- **Layers:** connection error → transport → adapter → tool_result → model observation. Five bands.
- **Axis: recovery locus.** Transport recovers connection failures. DataSource recovers rate limits. Agent recovers *semantic* failures (tool succeeded but returned unusable data, tool doesn't exist, etc).
- **Seam:** the `is_error: true` flag. Everything upstream tried to succeed; everything downstream is the model handling failure.

## How it works

### Move 1 — the mental model

The failure taxonomy and the recovery locus for each:

```
  Failure taxonomy — where each recovers

  ┌─────────────────────┬──────────────────────────────┐
  │ Failure             │ Recovery                     │
  ├─────────────────────┼──────────────────────────────┤
  │ tool returns error   │ pass to LLM as tool_result   │
  │                     │ with is_error: true; model    │
  │                     │ reasons around it              │
  ├─────────────────────┼──────────────────────────────┤
  │ tool times out       │ DataSource wraps as HTTP-0    │
  │                     │ error; agent sees as tool_res │
  ├─────────────────────┼──────────────────────────────┤
  │ 429 rate limit       │ DataSource retry ladder      │
  │                     │ (backoff + Retry-After hint) │
  ├─────────────────────┼──────────────────────────────┤
  │ 500 server error     │ same — retry if idempotent    │
  ├─────────────────────┼──────────────────────────────┤
  │ malformed JSON       │ tool_result is_error: true;   │
  │                     │ model reasons around it        │
  ├─────────────────────┼──────────────────────────────┤
  │ model loops on       │ hard max_iterations cap;      │
  │ same tool             │ receipt records the loop     │
  ├─────────────────────┼──────────────────────────────┤
  │ budget exhausted     │ BudgetExceededError; route    │
  │                     │ emits graceful error event    │
  └─────────────────────┴──────────────────────────────┘
```

### Move 2 — the step-by-step walkthrough

**Transport-layer recovery.** `lib/mcp/transport.ts:34-36` sets `TOOL_TIMEOUT_MS = 30_000` — any hung MCP call fails fast with an HTTP-0 timeout error rather than burning the 300s route budget. `redactSecrets()` (`lib/mcp/transport.ts:57-64`) strips tokens from error bodies before they surface to logs.

**DataSource-layer recovery.** `BloomreachDataSource` (aka `McpDataSource`) has a retry ladder for rate-limit responses. Configurable spacing (~1 req/s to match Bloomreach's alpha limit); Retry-After hint parsed and honored; retry ceiling at 20s so a slow-decaying rate limit doesn't extend the whole route.

**Agent-layer recovery — the `is_error: true` pattern.** The `BloomingToolRegistryAdapter.execute()` catches errors and wraps them as `tool_result { is_error: true, content: [{ type: "text", text: errorMessage }] }`. The model reads that block on its next turn. Empirically, Sonnet 4.6 handles this gracefully — it acknowledges the error in a thought ("the previous query hit an error; let me try a different EQL") and reroutes.

**The receipt that proves it.** The `FaultInjectingDataSource` decorator (`lib/data-source/fault-injecting.ts:44`) wraps any DataSource and injects timeouts, rate limits, server errors, and malformed JSON at configurable rates. In a load-harness run: **3 investigations completed, 9 injected faults across them, 0 failed**. The model reasoned around every fault. That's evidence, not assertion.

Diagram of one fault flowing through the layers:

```
  One injected fault — recovery path

  turn N: model emits tool_use → execute_analytics_eql(...)
    │
    ▼
  BloomingToolRegistryAdapter.execute()
    │
    ▼
  FaultInjectingDataSource.callTool(name, args)
    │  ← 5% chance to inject "server_error"
    ▼
  throw new McpToolError({ status: 500, message: "injected fault" })
    │  (caught inside registry adapter)
    ▼
  wrap as: tool_result {
    tool_use_id: ...,
    is_error: true,
    content: [{ type: "text",
                text: "HTTP 500: injected fault" }]
  }
    │
    ▼
  append to messages, next model turn
    │
    ▼
  turn N+1: model sees is_error, emits thought:
    "That query errored. Let me try a different one."
    then emits tool_use with different args
    │
    ▼
  loop continues; investigation completes normally
```

**The two hard-stop cases.** Some failures don't lend themselves to model recovery — budget exhaustion (`BudgetExceededError`, `lib/agents/budget.ts`) and hard max_iterations. Both are surfaced as NDJSON `error` events to the UI. The user sees a graceful message with reconnect / retry options; the receipt records the failure.

### Move 2 — variant: the load-bearing skeleton

**What's the agent's recovery kernel?** Two parts:

1. **`is_error: true` on tool_result.** Without this, a tool failure would either crash the agent (if the error propagated up) or fool the model (if the error was silently converted to a "success" with an empty result). Both are worse than "the model sees the error."
2. **Max-iterations ceiling.** Without this, a model that keeps calling the same failing tool would loop until the route timed out. The ceiling is the escape valve.

Hardening layered on top: transport timeout, retry ladder, budget tracker, cancellation via `AbortSignal`. All are load-bearing for production; none are required for the loop to fail-gracefully in principle.

### Move 3 — the principle

Present failures to the model as observations. The agent loop is a decision loop; a failed observation is still information the loop can process. Only the failures the model can't reason around — budget, max_iterations, unrecoverable exceptions — should propagate up as hard errors.

## Primary diagram

```
  Error recovery — full frame

  ┌─ Tool call ────────────────────────────────────────────┐
  │  BloomingToolRegistryAdapter.execute(tool_use)          │
  └────────────────────┬───────────────────────────────────┘
                       │
                       ▼
  ┌─ DataSource layer ─────────────────────────────────────┐
  │  · retry-on-429 (rate limit)                            │
  │  · no-cache-on-error                                    │
  │  · 30s timeout ceiling                                  │
  └────────────────────┬───────────────────────────────────┘
                       │  succeeds
                       ▼
              tool_result { is_error: false, content: [...] }
                       │
                       │  fails
                       ▼
              tool_result { is_error: true,
                            content: [{ type: "text",
                                        text: "HTTP 500: ..." }] }
                       │
                       ▼
  ┌─ Model sees error observation ─────────────────────────┐
  │  next turn: thought acknowledges error, action retries  │
  │  ~90% of injected faults recovered this way             │
  └────────────────────┬───────────────────────────────────┘
                       │
                       ▼
  ┌─ Hard-stop paths (not recoverable) ────────────────────┐
  │  · BudgetExceededError → NDJSON error event              │
  │  · max_iterations hit  → receipt records loop            │
  │  · abort via req.signal → clean shutdown                 │
  └────────────────────────────────────────────────────────┘

  Load-harness receipt: 9 injected faults / 3 investigations / 0 failed
```

## Elaborate

The "present errors as observations" pattern is what makes ReAct-style agents robust. Contrast with a chain-of-tools that has no reasoning between calls: a failed step there either propagates up (crash) or gets suppressed (silent wrong answer). Neither is what you want.

The fault-injecting decorator is a real production discipline — it forces the agent's failure modes to surface during load testing, not during a real customer incident. The 9-fault / 0-failure result is what makes the graceful-degradation claim provable.

Related: **02-tool-calling.md** (the tool_result shape errors ride), **03-react-pattern.md** (the loop where recovery happens), **../06-production-serving/05-retry-circuit-breaker.md** (the layer beneath the DataSource retries).

## Project exercises

### B4.6 · Detect and interrupt tool-loop failures

- **Exercise ID:** B4.6 (Case A — max_iterations exists; add loop detection)
- **What to build:** When the model calls the same tool with the same args 3+ times in a row, inject a `tool_result { is_error: true, content: "You called this tool 3 times with the same args and it kept failing. Try a different approach." }`. The extra observation nudges the model off the loop.
- **Why it earns its place:** Targets the "loop on same tool" failure mode explicitly, saving iterations that max_iterations would otherwise burn.
- **Files to touch:** `lib/agents/aptkit-adapters.ts` (BloomingToolRegistryAdapter — track recent calls), `test/agents/base.test.ts` (loop-detection test).
- **Done when:** a synthetic case that induces a tool loop detects the loop by turn 3 and emits the nudge observation.
- **Estimated effort:** `1–4hr`.

## Interview defense

**Q: How do you know your agent handles errors gracefully?**

The load-harness receipt: 9 injected faults across 3 investigations, 0 failed. The `FaultInjectingDataSource` in `lib/data-source/fault-injecting.ts:44` decorates any DataSource with configurable failure rates (timeout, rate_limit, server_error, malformed_json). Every failure becomes a `tool_result is_error: true` at the model boundary; the model reads it, reasons around it, tries something else. That's provable evidence, not assertion.

**Q: What's the failure mode the model can't recover from?**

Loop detection. If the model calls the same tool with the same args 3 times in a row, it's stuck — no observation the model is producing is unstickable. Max_iterations catches it eventually, but the exercise `B4.6` proposes an earlier detection that nudges the model with an extra "you're looping" observation. Load-bearing: knowing which failures the model can and can't recover from is what makes the layering non-trivial.

## See also

- [02-tool-calling.md](02-tool-calling.md) — the tool_result shape.
- [03-react-pattern.md](03-react-pattern.md) — the loop where recovery happens.
- [../06-production-serving/05-retry-circuit-breaker.md](../06-production-serving/05-retry-circuit-breaker.md) — the retry layer beneath the DataSource.
