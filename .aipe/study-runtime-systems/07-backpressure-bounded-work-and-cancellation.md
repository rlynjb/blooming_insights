# 07 — Backpressure, bounded work, and cancellation

**Industry name(s):** bounded concurrency · deadline budgets · forced-synthesis turn · graceful degradation · the missing `AbortController`
**Type:** Industry standard · Project-specific application

> **Verdict: bounded work is *very* well done; cancellation is deliberately absent.** Every agent run has a hard wall: `maxDuration = 300s` (route), `maxToolCalls = 6` (agent), `maxRetries = 3` (rate-limit retry), `retryCeilingMs = 20_000` (per-retry cap), `MAX_TOOL_RESULT_CHARS = 16_000` (per-result history cap). The forced-synthesis turn — omit the `tools` parameter on the last allowed turn so the model MUST emit JSON — is the most surprising and most load-bearing of these. There is **no `AbortController` anywhere in the repo**. Browser tab close, navigation away, network drop — none stop the route. The Anthropic + MCP calls keep running until natural completion or `maxDuration`. That's a deliberate trade for React StrictMode survivability (`lib/hooks/useInvestigation.ts:32-36`) and it costs real money on every abandoned investigation.

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Bounded work lives in the **Server runtime** band — every budget is enforced inside `runAgentLoop` or `McpClient`. The client side has one bounding primitive: `startedRef` (don't double-mount fetch). Providers (Anthropic, Bloomreach) enforce their OWN bounds (token limits, rate limits) — we honor them by sizing OUR bounds smaller than theirs. Cancellation, when it exists, would propagate from client→server→provider via `AbortController` chains — none of that wiring is present today.

```
  Where bounds and cancellation would live

  ┌─ Browser ────────────────────────────────────────────────────────┐
  │  bound:        startedRef.current (run fetch once per mount)     │
  │  cancellation: explicitly NOT used (see useInvestigation:32-36)   │
  └────────────────────────│─────────────────────────────────────────┘
                           │  HTTPS
  ┌─ Vercel function ──────▼─────────────────────────────────────────┐  ← we are here
  │                                                                  │
  │  HARD WALL:    maxDuration = 300s                                 │
  │  agent loop:   maxTurns = 8, maxToolCalls = 6                     │
  │                forceFinal + synthesisInstruction (forced-synthesis│
  │                  turn — the surprising load-bearing piece)         │
  │  MCP:          minIntervalMs = 1100 (spacing gate)                │
  │                maxRetries = 3, retryDelayMs = 10_000,             │
  │                retryCeilingMs = 20_000                            │
  │  cancellation: NOT IMPLEMENTED. No req.signal listener, no        │
  │                AbortController threaded through the loop.         │
  └────────────────────────│─────────────────────────────────────────┘
                           │
  ┌─ Providers ────────────▼─────────────────────────────────────────┐
  │  Anthropic: max_tokens = 4096 per turn (their cap; we set it)    │
  │  Bloomreach: 1 req/s/user (their cap; we space at 1.1s)           │
  └──────────────────────────────────────────────────────────────────┘
```

**Zoom in — the concept.** A *bound* is a deliberate limit on work that prevents one runaway operation from consuming a budget meant for many. *Backpressure* is bounds-driven signaling: "I'm full, slow down." *Cancellation* is propagated abort: "the consumer doesn't want this anymore, stop." This codebase is excellent at bounds, doesn't really do backpressure (the streams are slow enough that buffer pressure never builds), and deliberately skips cancellation.

---

## Structure pass

**Layers.** Three nested:
1. **Per-call** — `MAX_TOOL_RESULT_CHARS`, the 16KB truncation.
2. **Per-agent-run** — `maxTurns`, `maxToolCalls`, the forced-synthesis turn.
3. **Per-route** — `maxDuration`, the only platform-enforced wall.

**Axis traced: *what happens when a bound is hit?***

```
  "What happens when a bound is hit?" — across layers

  ┌─ per-call bound (16KB truncation) ────────────┐
  │  result gets sliced + "…[truncated]" marker    │   → silent degradation
  │  agent continues with reduced context          │
  └────────────────────┬──────────────────────────┘
                       │
  ┌─ per-agent-run bound (maxToolCalls=6) ───────▼┐
  │  next turn omits `tools` from the API call     │   → forced synthesis;
  │  synthesisInstruction appended to system        │     model MUST emit JSON
  └────────────────────┬──────────────────────────┘
                       │
  ┌─ per-route bound (maxDuration=300s) ─────────▼┐
  │  Vercel kills the function. Mid-flight work    │   → hard kill; in-progress
  │  is gone. No graceful shutdown hook fires.     │     work is just lost
  └───────────────────────────────────────────────┘

  the answer escalates: per-call is graceful, per-route is brutal.
  the in-between layers exist to make sure we hit "graceful" first.
```

**Seams.** Two:

1. **Between budget-hit and outcome.** What does the system do when it runs out of room? Three different answers (truncate, force synthesis, get killed). The design is to make sure the cheap one always fires before the expensive one.
2. **Between request and consumer.** The seam where cancellation would propagate — and doesn't. Server has no way to know the client disconnected.

---

## How it works

### Move 1 — the mental model

You already know how `Promise.race([fetch, timeout])` aborts a slow fetch — you set a deadline, whichever resolves first wins. Bounded work is the same pattern at a higher altitude: every layer of the system sets a deadline (or a count limit) that's smaller than the next layer up. The route gets 300s. The agent inside it gets 6 tool calls (call them 1.1s gate + ~1s HTTP each = ~12.6s) and 8 turns (~2-15s each, ~80s worst case). Anthropic gets 4096 tokens per turn. The cap-on-cap-on-cap means you almost never hit the outer one — you trip a cheap inner bound first.

```
  The bounded-work kernel — nested deadlines

       ┌─ outer: maxDuration = 300s (Vercel) ─────────────┐
       │                                                  │
       │   ┌─ middle: maxTurns × turn-cost ≤ ~120s ─────┐ │
       │   │                                            │ │
       │   │   ┌─ inner: maxToolCalls = 6 calls × ─────┐│ │
       │   │   │  ~2s = ~12s of MCP work               ││ │
       │   │   │                                       ││ │
       │   │   │   ┌─ innermost: 16KB per tool ──────┐ ││ │
       │   │   │   │  result, 4096 tokens per turn   │ ││ │
       │   │   │   └─────────────────────────────────┘ ││ │
       │   │   └───────────────────────────────────────┘│ │
       │   └────────────────────────────────────────────┘ │
       └──────────────────────────────────────────────────┘

  by the time you'd hit maxDuration, you've already hit (and gracefully
  handled) maxToolCalls, the synthesis-instruction kicks in, the model
  emits its JSON, the route returns clean.
```

### Move 2 — the moving parts

#### 1) `maxDuration = 300` — the platform-enforced wall

`export const maxDuration = 300` at the top of `app/api/agent/route.ts:20` and `app/api/briefing/route.ts:17` tells Vercel to give this function up to 300 seconds before killing it. Hobby tier caps at 60s; Pro tier caps at 300s. The repo is sized for Pro because a live investigation under the 1.1s MCP gate plus auth setup runs ~100-115s, which doesn't fit in 60s.

```
  maxDuration — the only bound the app doesn't get to enforce

  request comes in at t=0
  ...work happens, awaits the gate, awaits Anthropic, awaits MCP...
  if not done by t=300:
    Vercel kills the function process. SIGKILL-equivalent — no graceful
    shutdown hook fires. ReadableStream is left mid-emit; client sees a
    truncated body. saveInvestigation never runs for this insight.
```

What breaks without it: Hobby's 60s default kicks in. Any live (non-replay) investigation gets killed at 60s, mid-loop. The route comment explains this in line: "300s = Vercel Pro's max. A live investigation … runs ~100-115s …; 60s (Hobby) cannot fit it" (`app/api/agent/route.ts:18-19`).

#### 2) `maxTurns = 8` + `maxToolCalls = 6` — agent-loop budgets

`runAgentLoop` (`lib/agents/base.ts:48-176`) enforces two parallel budgets:

- `maxTurns` — how many round-trips with the Anthropic API. Default 8.
- `maxToolCalls` — total tool calls across all turns. Default unset; agents pass 6.

Either one triggers the `forceFinal` branch (`lib/agents/base.ts:90-92`). When `forceFinal` is true: the next API call omits `tools` from the params AND appends `synthesisInstruction` to the system prompt.

```
  the dual budget — either trip the same outcome

  loop turn N:
    budgetSpent = maxToolCalls !== undefined && toolCalls.length >= maxToolCalls
    forceFinal  = turn === maxTurns - 1 || budgetSpent

  if forceFinal:
    DON'T send tools[] in the API params
    DO append synthesisInstruction to the system prompt
       ("You have NO more tool calls available. Stop querying now and
         output your final answer…")

  → model can NOT request another tool call (no schemas to call)
  → model is INSTRUCTED to emit its final JSON
  → next response has no tool_use blocks → loop terminates normally
```

What breaks without this: the model wants to keep exploring. It returns another tool_use, we loop again, we hit `maxTurns`, but on the last turn we still SENT tools — so the model emits another tool_use we can't fulfill. The loop returns `finalText: ''`, the caller has no diagnosis, the user sees a fallback message. The forced-synthesis turn is what turns "I ran out of budget" into "I gave you the best answer I can with what I have."

#### 3) The forced-synthesis turn — the load-bearing kernel of bounded work

This is the surprising piece. Most ReAct loops just stop when they hit the budget — and produce nothing. The repo's approach is to use the budget exhaustion as a TRIGGER for a different KIND of API call: tool-less, synthesis-only.

```
  forced-synthesis turn — the most load-bearing budget primitive

  budget OK turns:
    POST /messages with:
      tools: [list of MCP tool schemas]
      system: "You're a diagnostic agent. Use tools to investigate."
    → model returns tool_use or text

  forced-final turn:
    POST /messages with:
      (no tools)
      system: original + "\n\nYou have NO more tool calls. Output ONLY
                          a JSON object in a ```json fence matching the
                          diagnosis shape. Base on evidence already
                          gathered. Don't ask for more queries."
    → model CANNOT request a tool
    → model is told what shape to emit
    → response is the structured JSON (or a parse failure that triggers
       a final synthesize() fallback at lib/agents/diagnostic.ts:73-83)
```

What breaks without it: budget exhaustion produces no output. The model keeps reaching for tools that aren't there, the loop terminates with `finalText: ''`, the diagnostic agent has no diagnosis to return. This is the difference between "graceful degradation" and "silent failure."

The diagnostic agent goes one further: if even the forced-synthesis turn fails to produce a valid JSON, it runs a *separate, dedicated synthesis call* (`DiagnosticAgent.synthesize` at `lib/agents/diagnostic.ts:87-126`) that hands the model just the evidence it already gathered and asks for the structured conclusion. Two-stage fallback for the case the model just won't stop trying to query.

#### 4) `McpClient.minIntervalMs = 1100` — proactive spacing

The spacing gate isn't a bound on OUR work — it's a bound on the rate of calls we make to the provider. `liveCall` (`lib/mcp/client.ts:148-153`) checks `Date.now() - this.lastCallAt`; if it's less than 1.1s, it `await new Promise(r => setTimeout(r, gap))` until the window opens. Sized at 1.1s because Bloomreach's observed window is 1 req/s; spacing at the full 10s window (the OTHER observed window) would cost ~60s for a 6-call investigation and blow the route budget.

```
  the spacing gate — provider-respecting backpressure

  ──── time ────►
  call 1:   ▓ HTTP
  gap:      ░░░░░░░░░░░ 1.1s
  call 2:   ▓ HTTP
  gap:      ░░░░░░░░░░░ 1.1s
  call 3:   ▓ HTTP
  ...

  the wait is non-blocking (yields the event loop — see 03).
  it's how we cooperate with the rate limit WITHOUT eating the
  expensive retry path (~10s per retry penalty).
```

#### 5) Rate-limit retry — bounded recovery

When the spacing gate isn't enough (race with another instance, undercount, etc.), Bloomreach returns a rate-limit error. `McpClient.callTool` (`lib/mcp/client.ts:122-132`) parses the error text for a retry hint (`"Retry after ~12 seconds"` or `"per 10 second"`), waits that long (plus a 500ms buffer), retries. Bounded by `maxRetries = 3` and `retryCeilingMs = 20_000`.

```
  retry loop — bounded by count AND ceiling

  result = liveCall(...)
  retries = 0
  while isRateLimited(result) and retries < 3:
    retries += 1
    hint = parseRetryAfterMs(result)              ← prefer server's hint
    backoff = retryDelayMs * 2^(retries-1)        ← else exponential off 10s
    wait = min(hint+500 ?? backoff, 20_000)       ← capped at 20s
    sleep(wait)
    result = liveCall(...)

  max time spent in retry: 3 × 20s = 60s
  → still within maxDuration but burns a serious chunk of it
  → that's why maxRetries stays at 3, not 10 — the route's 300s
     would be half-consumed by retry waits alone at higher counts
```

What breaks without the ceiling: a misparsed "Retry after ~600 seconds" could legitimately wait 10 minutes — way past the route's budget. The ceiling clamps any single wait to 20s regardless of what the server claims.

#### 6) The 4KB per-event truncation — bounding the cache size

Route-level: `TRUNC = 4000` (`app/api/agent/route.ts:99-103`, `app/api/briefing/route.ts:69-73`). Every tool result that goes into the NDJSON stream (and into the saved `collected[]` for `saveInvestigation`) is sliced to 4000 chars. Without it, one big EQL result would make a single cached investigation 100KB+ and the NDJSON event size unpredictable.

```
  per-event truncation — bounded cache, bounded UI rendering

  raw tool result (could be hundreds of KB):
    JSON.stringify(result) → 250_000 chars

  trunc(...) at route layer:
    250_000 > 4000 → slice + "…"

  result: every cached AgentEvent is small; the cache stays MB-scale,
          not GB-scale. UI renders the truncated result in the trace
          panel without blowing layout.
```

#### 7) Cancellation — the deliberately absent piece

There is no `AbortController` in this repo. None of the routes read `req.signal`. The agent loop has no `signal` parameter. `McpClient.callTool` has no abort option. The hook explicitly doesn't `reader.cancel()` on unmount.

```
  cancellation — what WOULD be wired, what isn't

  ┌─ wired client → server ──────────────────────────────────┐
  │   useInvestigation effect:                                │
  │     const ac = new AbortController()                      │
  │     fetch(url, { signal: ac.signal })                     │
  │     return () => ac.abort()       ← NOT done              │
  └───────────────────────────────────────────────────────────┘
  ┌─ wired server → providers ───────────────────────────────┐
  │   GET(req) {                                              │
  │     const signal = req.signal     ← NOT read              │
  │     await runAgentLoop({ ..., signal })                   │
  │   }                                                       │
  │   inside runAgentLoop: pass signal to anthropic/mcp        │
  └───────────────────────────────────────────────────────────┘
  ┌─ what happens TODAY when client disconnects ─────────────┐
  │   server keeps running                                    │
  │   Anthropic call still bills                              │
  │   MCP gate still sleeps and calls                         │
  │   saveInvestigation still runs at the end                 │
  │   result: server thinks the work was successful;          │
  │           client never saw the body                       │
  └───────────────────────────────────────────────────────────┘
```

The reason for the absence is documented at `lib/hooks/useInvestigation.ts:32-36`: React StrictMode's double-mount + the `startedRef` guard interacted with cleanup-time aborts to abort the stream before the first byte arrived. The pragmatic fix was to let the fetch finish. Cost: the server can't tell the difference between "user is watching" and "user closed the tab three seconds in."

What this costs concretely: a user who opens an investigation, sees the first tool call complete, gets bored and closes the tab — we keep running the full 100s, calling Anthropic and MCP, billing money the user will never see the output of. At hackathon scale it's a rounding error. At production scale, it's a line item.

The right fix when this matters: thread an `AbortController` from the route through `runAgentLoop`, hand `signal` to the Anthropic SDK (it supports it) and the MCP SDK transport (it supports it via `fetch` options). On the client, give up the StrictMode workaround in favor of an explicit `if (process.env.NODE_ENV === 'production') ac.abort()` on cleanup.

#### 8) Backpressure — the lever not pulled

The route does `controller.enqueue(...)` without checking `controller.desiredSize` or awaiting `controller.ready` (if it existed). On a slow client, the stream's internal buffer could grow. In practice it doesn't matter — the NDJSON events are small (kilobytes), the total stream is sub-MB over 100s, and the client reads as fast as the server writes. But it's a primitive we could reach for if a future feature streamed megabytes (e.g. a CSV export).

```
  enqueue vs backpressure-aware enqueue

  TODAY:
    controller.enqueue(bytes)                ← just push, no check

  IF backpressure mattered:
    if (controller.desiredSize < 0) {
      await waitForReader()
    }
    controller.enqueue(bytes)

  doesn't matter today because:
   - data per event ≤ 4KB
   - events per second ≤ a few
   - total per stream ≤ ~1MB
   - clients drain faster than we produce
```

### Move 3 — the principle

**Bounded work isn't pessimism — it's the only way to make optimistic guarantees.** "This route will respond in under 300 seconds" is a real promise only if you've sized every internal budget smaller than the wall and given every budget exhaustion a graceful fallback. The repo does this well: the cheap inner bound (forced synthesis) fires before the expensive outer bound (Vercel kill), and the user gets a coherent answer rather than a truncated body. The piece this codebase deliberately gives up — cancellation — is a separate concern: it's about RESPECTING the consumer's "I'm done." Bounded work makes the system robust; cancellation makes it polite.

---

## Primary diagram

The full bounded-work picture for one investigation request, with every budget visible:

```
  One investigation request — every budget in one frame

  ┌─ Vercel function ─────────────────────────────────────────────────────┐
  │  HARD WALL: maxDuration = 300s ───────────────────────────────────────│
  │                                                                       │
  │  ┌─ route handler ────────────────────────────────────────────────┐   │
  │  │                                                                │   │
  │  │  per-event TRUNC = 4000 chars (applied to tool results)        │   │
  │  │  REPLAY_DELAY_MS = 180 (paces cached-replay events)            │   │
  │  │                                                                │   │
  │  │  ┌─ runAgentLoop ──────────────────────────────────────────┐   │   │
  │  │  │  maxTurns = 8                                          │   │   │
  │  │  │  maxToolCalls = 6 (agent-supplied)                     │   │   │
  │  │  │  MAX_TOOL_RESULT_CHARS = 16_000 (per turn)             │   │   │
  │  │  │                                                        │   │   │
  │  │  │  on forceFinal turn:                                   │   │   │
  │  │  │    OMIT tools[] from API params                        │   │   │
  │  │  │    APPEND synthesisInstruction to system               │   │   │
  │  │  │    → model MUST emit final JSON                        │   │   │
  │  │  │                                                        │   │   │
  │  │  │  ┌─ McpClient ──────────────────────────────────────┐  │   │   │
  │  │  │  │  minIntervalMs = 1100   (spacing gate)           │  │   │   │
  │  │  │  │  maxRetries = 3                                  │  │   │   │
  │  │  │  │  retryDelayMs = 10_000  (fallback per retry)     │  │   │   │
  │  │  │  │  retryCeilingMs = 20_000 (cap per retry wait)    │  │   │   │
  │  │  │  │  cacheTtlMs = 60_000 (per-call default)          │  │   │   │
  │  │  │  └──────────────────────────────────────────────────┘  │   │   │
  │  │  │                                                        │   │   │
  │  │  │  ┌─ Diagnostic agent fallback ─────────────────────┐   │   │   │
  │  │  │  │  if forceFinal output ≠ valid JSON:             │   │   │   │
  │  │  │  │    synthesize() — separate tool-less call with  │   │   │   │
  │  │  │  │    the evidence gathered so far                 │   │   │   │
  │  │  │  │  if synthesize() fails:                         │   │   │   │
  │  │  │  │    FALLBACK = "Insufficient data…"               │   │   │   │
  │  │  │  └─────────────────────────────────────────────────┘   │   │   │
  │  │  └─────────────────────────────────────────────────────────┘  │   │
  │  │                                                                │   │
  │  │  CANCELLATION: not implemented. Client disconnect → server     │   │
  │  │                keeps running until natural end or maxDuration. │   │
  │  └────────────────────────────────────────────────────────────────┘   │
  │                                                                       │
  └───────────────────────────────────────────────────────────────────────┘
```

---

## Implementation in codebase

**Use cases.** Every long-running route applies the same stack of bounds:

- **Live diagnose** (`app/api/agent/route.ts:225-240`) — calls `DiagnosticAgent.investigate` which calls `runAgentLoop` with `maxToolCalls = 6`. Forced synthesis fires after 6 tool calls. Two-stage fallback (re-synthesize → static FALLBACK).
- **Live briefing** (`app/api/briefing/route.ts:218-240`) — `MonitoringAgent.scan` with `maxToolCalls = 6`. Same forced-synthesis pattern; on parse failure, degrades to `return []` (no anomalies) instead of crashing the route.
- **Rate-limit storm** — `McpClient.callTool` catches a 429, parses the wait, sleeps up to 20s, retries up to 3 times.

**Code side by side.**

```
  lib/agents/base.ts (lines 85-102) — the bound-checking and forceFinal switch

  for (let turn = 0; turn < maxTurns; turn++) {
    const budgetSpent = maxToolCalls !== undefined && toolCalls.length >= maxToolCalls;
    const forceFinal = turn === maxTurns - 1 || budgetSpent;
                                                      │
                                                      └─ THIS line is the dual-budget logic.
                                                         either bound trips the same forceFinal.

    const params: Anthropic.Messages.MessageCreateParamsNonStreaming = {
      model: AGENT_MODEL,
      max_tokens: maxTokens,
      system: forceFinal && synthesisInstruction ? `${system}\n\n${synthesisInstruction}` : system,
                                                  │
                                                  └─ THE forced-synthesis instruction.
                                                     applied to system ONLY on the forced turn.
      messages,
    };
    if (!forceFinal) params.tools = toolSchemas;
                       │
                       └─ THE load-bearing move: when forced, DON'T send tools.
                          the model literally cannot request another tool call.
                          it must produce text (which had better be JSON).
```

```
  lib/agents/monitoring.ts (lines 101-105) — agent supplies the budget

  const { finalText } = await runAgentLoop({
    // ...
    maxTurns: 8,
    maxToolCalls: 6, // hard cap — bounds latency under the 1 req/s MCP limit
                     │
                     └─ EXPLICITLY justified inline: the bound is sized AGAINST
                        the MCP gate. 6 calls × ~2s/call = ~12s of MCP work;
                        within the 300s wall with headroom for Anthropic latency.
    synthesisInstruction:
      'You have NO more tool calls available. Stop querying now and output your final answer. ' +
      'Respond with ONLY a JSON array of anomaly objects in a ```json fence (or [] if nothing ' +
      'meaningful), based on the data you have already gathered. Do not say you need more queries.',
  });
```

```
  lib/agents/monitoring.ts (lines 109-119) — graceful degradation

  let parsed: unknown;
  try {
    parsed = parseAgentJson(finalText);
  } catch {
    return [];     ← parse failure on forced-synthesis output: surface as "no anomalies"
                     instead of throwing 500. the route still completes, the user sees
                     an empty feed and a coverage note, not an error page.
  }
  if (!isAnomalyArray(parsed)) return [];
```

```
  lib/agents/diagnostic.ts (lines 73-83) — two-stage synthesis fallback

  const diag =
    tryParseDiagnosis(finalText) ??              ← stage 1: forced-synthesis output
    (await this.synthesize(anomaly, toolCalls)) ??  ← stage 2: dedicated tool-less call
    FALLBACK;                                    ← stage 3: static "insufficient data"
                                                  ▲
                                                  └─ each stage is a tighter constraint:
                                                     - stage 1: full system prompt + synth instruction
                                                     - stage 2: just the evidence + "output JSON"
                                                     - stage 3: hard-coded "I don't know"
                                                     guaranteed to terminate with SOMETHING.
```

```
  lib/mcp/client.ts (lines 122-132) — bounded rate-limit retry

  let retries = 0;
  while (isRateLimited(result) && retries < this.maxRetries) {   ← count cap
    retries++;
    const hintMs = parseRetryAfterMs(result);
    const backoffMs = this.retryDelayMs * 2 ** (retries - 1);
    const waitMs = Math.min(
      hintMs != null ? hintMs + RETRY_BUFFER_MS : backoffMs,
      this.retryCeilingMs,                                       ← ceiling cap
    );
    await sleep(waitMs);
    result = await this.liveCall(name, args);
  }
        │
        └─ DUAL bound: count (3) AND per-wait ceiling (20s). max total time in
           retry: ~60s. justification: any single retry on the 10s window already
           absorbs most of one minute; raising maxRetries higher trades route
           budget for resilience that's rarely needed in practice.
```

```
  lib/hooks/useInvestigation.ts (lines 32-36, 47) — the missing cancellation, justified

  // NOTE: we deliberately do NOT cancel the fetch on effect cleanup. React
  // StrictMode (dev) mounts → cleans up → re-mounts; cancelling on the first
  // cleanup, with the started-guard blocking the re-mount, aborted the stream
  // and left the logs empty. The started-guard prevents a double fetch; the
  // in-flight run simply completes (setState after unmount is a safe no-op).
  ...
  if (startedRef.current) return; // run once per mount (survives StrictMode)
  startedRef.current = true;
       │
       └─ THE bound that replaces cancellation: "run the fetch once per mount."
          combined with "never abort on cleanup," this gives us StrictMode-
          survivable single-shot streaming. trade: a client tab-close doesn't
          stop the server.
```

---

## Elaborate

The forced-synthesis turn is a useful pattern beyond this codebase — it shows up in any ReAct/tool-using loop. The principle: when you exhaust a budget, don't just stop; *change what kind of work the model is allowed to do*. By removing tools and instructing for output, you convert "I ran out of time" into "give me your best answer." It's the difference between a hard timeout and a graceful deadline.

The absent `AbortController` is also a useful pattern lesson — the cost of NOT having it is exactly the visible cost of an abandoned investigation. Threading it through would cost maybe 20 lines (route reads `req.signal`, `runAgentLoop` accepts `signal`, hands to Anthropic + transport). The lever exists; it just hasn't been pulled because the StrictMode workaround took priority.

Worth reading next: the Anthropic SDK docs on AbortController support (it's a first-class parameter), the WHATWG fetch spec on `AbortSignal`, and Vercel's Functions docs on what `maxDuration` actually does at the platform level.

---

## Interview defense

**Q: What's the most load-bearing budget primitive in the agent loop?**
A: The forced-synthesis turn (`lib/agents/base.ts:90-101`). When either `maxTurns` or `maxToolCalls` is hit, the next API call OMITS the `tools` parameter AND appends a `synthesisInstruction` to the system prompt. The model literally cannot request another tool call (no schemas to call) and is explicitly told to emit its final JSON. Without it, budget exhaustion produces empty output — the model keeps wanting to query, the loop terminates with `finalText: ''`, the user sees nothing. With it, budget exhaustion produces the best answer the model can give from what it gathered. That's the difference between a hard wall and a graceful deadline.

```
  forced synthesis — the kernel

  turn N, budget OK:                  turn N+1, budget spent:
  tools: [schemas]                    (no tools)
  system: base                        system: base + "stop. output JSON."
  → tool_use or text                  → text (which is the JSON we asked for)
```

**Q: There's no `AbortController` anywhere. Defend that.**
A: It's a deliberate trade documented at `lib/hooks/useInvestigation.ts:32-36`. React StrictMode mounts twice in dev — without the started-ref guard, two fetches go out. With the guard, the second mount short-circuits. But if cleanup also `abort()`s the first mount's fetch, the second mount sees the started-ref already true, doesn't refetch, and the stream is dead — empty logs in dev. The pragmatic fix was to let the fetch always complete. The cost is real: the server keeps running after a client disconnect, burning Anthropic + MCP credits for a UI nobody's watching. The right move when this becomes material: thread an `AbortController` through `runAgentLoop` to the SDKs (both accept `signal`), give up the StrictMode workaround, gate the client `ac.abort()` on `NODE_ENV === 'production'`.

---

## Validate

1. **Reconstruct.** Draw the nested budgets: `maxDuration` outside, `maxTurns × turn-cost` inside, `maxToolCalls × call-cost` inside that, `MAX_TOOL_RESULT_CHARS` innermost. Mark the order they would fire under a runaway agent.
2. **Explain.** Why does the diagnostic agent have TWO stages of synthesis fallback (forced-synthesis turn AND a separate `synthesize()` call)? What can make the first one fail? (The model can ignore the instruction and emit prose instead of JSON, or it can wrap the JSON in markdown the parser doesn't handle. Stage 2 is a fresh call with NO tools and a tighter prompt — just "here's the evidence, output JSON." Stage 3 is the hard-coded FALLBACK string.)
3. **Apply.** A new agent needs a 12-tool budget for its category. Where do you change the bound, and what's the consequence for `maxDuration`? (Change `maxToolCalls` at the agent's call site. Consequence: 12 calls × ~2.1s = ~25s of MCP work plus 12 Anthropic round-trips ~~~ ~60s; still under 300s but eating significantly more of the budget. Verify against worst-case Anthropic latency.)
4. **Defend.** Defend the choice to NOT thread an `AbortController` through the agent loop. What would change your mind? (Today: StrictMode survivability matters more than disconnect-cancellation, and at current usage the wasted compute is rounding-error money. Would change my mind: a billing line that shows Anthropic spend significantly higher than UI-completed runs would suggest, indicating real abandonment cost. Then wire it through, both directions, and accept the StrictMode complexity.)

---

## See also

- `01-runtime-map.md` — `maxDuration` is the hard wall on the runtime.
- `03-event-loop-and-async-io.md` — why `await setTimeout` for the spacing gate is the right backpressure primitive.
- `05-memory-stack-heap-gc-and-lifetimes.md` — the 16KB and 4KB truncations bound the heap as well as the budget.
- `06-filesystem-streams-and-resource-lifecycle.md` — why the absent `cancel(reason)` callback is part of the same missing-cancellation story.
- `08-runtime-systems-red-flags-audit.md` — where the missing `AbortController` ranks against the other risks.
