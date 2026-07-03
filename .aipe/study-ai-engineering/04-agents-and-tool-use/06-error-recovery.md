# 06 — Error recovery in agents

**Type:** Industry standard. Also called: graceful degradation, fault-tolerant agents.

## Zoom out, then zoom in

The load-bearing pattern for production reliability in this codebase. Both AptKit's loop and this repo's `FaultInjectingDataSource` are built around the assumption that tools fail — and that the model can reason around failures presented as `is_error: true` tool_result blocks.

```
  Zoom out — where recovery happens

  ┌─ FaultInjectingDataSource (decorator) ────────────────────────────┐
  │  injects: timeout, rate_limit, server_error, malformed_json        │
  │  ★ THIS CONCEPT ★                                                  │
  └─────────────────────────────┬─────────────────────────────────────┘
                                │  fault raised OR is_error result
  ┌─ Agent loop (AptKit) ───────▼─────────────────────────────────────┐
  │  wraps errors as tool_result {isError: true, content: <msg>}       │
  │  next model turn sees the error, decides how to respond            │
  └───────────────────────────────────────────────────────────────────┘
```

Zoom in. AptKit's loop catches tool call errors and packages them as `tool_result {isError: true, content: "…"}`. The model reads that on the next turn and typically pivots (try a different tool, try different args, or give up). Session-D fault-injection run confirmed this in practice: **9 injected faults across 3 investigations, 0 failed investigations.** The agent reasoned around every fault.

## Structure pass

**Layers:**
- Outer: user-visible reliability (investigation completes even under faults)
- Middle: AptKit's error-handling in the tool dispatch
- Inner: the fault classes injected + the model's per-fault response

**Axis: where does failure originate + get contained?**
- Origin: tool call (transport error, rate limit, malformed response)
- Contained at: AptKit's loop wraps as tool_result / isError → agent sees it as observation
- Recovered by: model reasoning → pivots to different tool/args OR concludes with what it has

**Seam:** the tool-dispatch try/catch inside AptKit's loop. Above: the model sees observations (some of which are errors). Below: real transport failures.

## How it works

### Move 1

You've caught an exception in a request handler and returned a 500 with a message. The client reads the message and shows a retry button. Same shape here — AptKit catches tool failures, turns them into structured messages, hands them to the model on the next turn. Model reads and decides what to do.

```
  Recovery shape

  tool throws or returns error
         │
         ▼
  AptKit wraps as tool_result {isError: true, content: <msg>}
         │
         ▼
  next model turn sees the error observation
         │
         ▼
  model reasons: try different args, try different tool, or give up
```

### Move 2

**The failure modes covered.**

`FaultInjectingDataSource` at `lib/data-source/fault-injecting.ts` injects four kinds:

1. **Timeout.** Throws `HTTP 0: timeout after 30000ms` — mimics `lib/mcp/transport.ts:137` shape. Model observation: tool call errored; the loop's next turn sees an isError tool_result.
2. **Rate limit.** Throws `Rate limited: please retry after 2000ms` with `status: 429`. Model observation: same — one tool_result with isError.
3. **Server error.** Throws `HTTP 500: Internal server error` with `status: 500`. Model observation: same.
4. **Malformed JSON.** Returns a `ToolResult` where the payload is broken JSON. Doesn't throw. Exercises the downstream JSON-parse rejection path — the model sees a tool_result whose content is unparseable, has to decide whether the tool worked.

**How AptKit's loop wraps errors.**

Inside AptKit's `callTool` dispatch (from the runtime), a try/catch around `toolRegistry.callTool()`. On catch, the loop packages the error as:

```
  {
    type: 'tool_result',
    tool_use_id: '<original id>',
    content: <error message>,
    is_error: true,   // ← Anthropic tool_result flag
  }
```

Next model turn, the model sees a tool_use that came back with is_error. Prompt engineering (the diagnostic system prompt) tells the model that ancillary tools can return empty; that treatment extends implicitly to error results.

**What the model actually does.**

From the session-D fault-injection run: 9 faults across 3 investigations, 0 failed. The model observed each fault, moved on. Common patterns:

- Timeout on `execute_analytics_eql` → model retries the same query in a different format on the next turn.
- Rate limit → model rephrases or picks a different tool.
- Server error → model treats the specific dimension as unknown, notes it in evidence, moves on.
- Malformed JSON → model recognizes it can't parse and skips that observation.

The model does not always get it right — sometimes it retries the exact same call with the same args and gets the same fault again. But over a 6-tool-call budget, it typically finds enough working paths to reach a conclusion.

**Circuit breaker — not present.**

Retry with backoff exists in `BloomreachDataSource` (rate-limit ladder based on parsed retry-after header). Circuit breaker (open / half-open / closed state machine, fail-fast after N consecutive failures) is NOT present. See `06-production-serving/05-retry-circuit-breaker.md`.

**Iteration budget — the ultimate stopper.**

AptKit's loop has a `turnsRemaining` hard cap (~15-20 turns, higher than the 6-tool-call soft cap). If every turn errors out and the model keeps retrying, the hard cap fires and the loop returns whatever partial answer it has, with a graceful error at the route boundary.

### Move 3

Assume tools fail. Structure your agent so failures are observations, not exceptions — the model can reason around observations but not exceptions. The 9/9 fault absorption in Session D wasn't luck; it was the design working.

## Primary diagram

```
  Full fault path — from injection to recovery

  ┌─ FaultInjectingDataSource ────────────────────────────────────────┐
  │  configured rates per fault kind                                  │
  │  deterministic PRNG (FAULT_SEED)                                  │
  │  onFault callback for observability                               │
  │                                                                   │
  │  callTool(name, args, opts) {                                     │
  │    if (roll < timeout_rate)    throw timeout                     │
  │    if (roll < rate_limit_rate) throw 429                          │
  │    if (roll < server_err_rate) throw 500                          │
  │    if (roll < malformed_rate)  return {broken JSON}               │
  │    else                        this.inner.callTool()              │
  │  }                                                                │
  └─────────────────────────────┬─────────────────────────────────────┘
                                │  throws OR returns broken result
  ┌─ AptKit loop ───────────────▼─────────────────────────────────────┐
  │  try {                                                             │
  │    const result = await tools.callTool(name, args)                │
  │    messages.push({role: 'user', content: [{                        │
  │      type: 'tool_result',                                          │
  │      tool_use_id: block.id,                                        │
  │      content: JSON.stringify(result)                               │
  │    }]})                                                            │
  │  } catch (err) {                                                   │
  │    messages.push({role: 'user', content: [{                        │
  │      type: 'tool_result',                                          │
  │      tool_use_id: block.id,                                        │
  │      content: String(err),                                         │
  │      is_error: true                                                │
  │    }]})                                                            │
  │  }                                                                 │
  └─────────────────────────────┬─────────────────────────────────────┘
                                │  next turn's messages includes the error
  ┌─ Model reasoning ───────────▼─────────────────────────────────────┐
  │  sees the isError tool_result                                     │
  │  emits a next thought: "that call failed; let me try…"             │
  │  picks a different tool OR retries with different args             │
  │  eventually either succeeds enough to conclude OR gives up         │
  └───────────────────────────────────────────────────────────────────┘

  Empirical (Session D):
    9 injected faults across 3 investigations → 0 failed investigations
```

## Elaborate

The "wrap errors as observations, not exceptions" pattern is core to agent reliability. Alternative patterns (rethrow to route handler, let the loop crash) fail catastrophically on the first fault; the "observations" approach recovers most cases. Modern agent frameworks (LangGraph, CrewAI, AptKit) all use this pattern.

Beyond in-loop recovery, production-grade agent systems layer: retry with backoff (in the transport layer — this codebase has it in `BloomreachDataSource`), circuit breakers (not present here), timeouts (present, 30s at the transport layer), and hard iteration caps (present as `turnsRemaining` in AptKit).

## Project exercises

### Exercise — measure recovery patterns per fault kind

- **Exercise ID:** C4.6-A · Case A (concept exercised; measure the recovery quality).
- **What to build:** in the load harness (`eval/load.eval.ts`), enable fault injection with `FAULT_TIMEOUT=0.05 FAULT_MALFORMED_JSON=0.05` etc. Log per-investigation: (a) how many faults were injected, (b) how many tool calls followed each fault, (c) whether the investigation completed. Compare per-dim quality of fault-hit vs fault-clean investigations.
- **Why it earns its place:** turns "graceful degradation" from claim into measured behavior. Interviewer signal: "here's exactly how the agent recovers, and here's the quality tradeoff — measured."
- **Files to touch:** `eval/load.eval.ts` (extend receipt), `eval/report.eval.ts` (add fault-recovery section).
- **Done when:** load receipt shows per-fault-kind: mean recovery turns, completion rate, quality delta vs fault-clean.
- **Estimated effort:** 1-2 days.

## Interview defense

**Q: What happens when a tool errors?**

AptKit's loop catches the error inside the dispatch, wraps it as a `tool_result {isError: true, content: <error message>}`, and appends to the messages array. Next model turn sees the error as an observation. The model reasons around it — tries a different tool, retries with different args, or notes the gap and moves on. That's the mechanism. In the fault-injection run I did (Session D), 9 faults across 3 investigations produced 0 failed investigations.

```
  ✗ don't rethrow → loop crashes
  ✓ wrap as observation → model reasons around it
```

**Q: What failure modes are covered?**

Four in the fault injector: timeout, rate limit (429), server error (500), malformed JSON. Deterministic sequence via `FAULT_SEED`. Real transport-level retries also exist in `BloomreachDataSource` (parses the server's retry-after header). Circuit breaker is NOT present — retry with backoff is.

**Q: What stops an infinite retry loop?**

Two caps. Soft cap: the prompt says "at most 6 tool calls." Model respects this. Hard cap: AptKit's `turnsRemaining` counter (~15-20 turns), which fires regardless of what the model wants. If the hard cap fires, the loop returns whatever it has with an error at the route boundary. Plus the `BudgetTracker` ceiling — if the runaway loop burns $2, the next model call throws `BudgetExceededError` before dispatching.

## See also

- `03-react-pattern.md` — the loop error recovery lives inside
- `02-tool-calling.md` — the tool call the error interrupts
- `06-production-serving/04-rate-limiting-backpressure.md` — the outbound rate-limit ladder in BloomreachDataSource
- `06-production-serving/05-retry-circuit-breaker.md` — the retry-that-exists / breaker-that-doesn't
- `lib/data-source/fault-injecting.ts` — the fault injector
