# 01 — Vercel route budget

`maxDuration = 300` as a hard ceiling · Industry standard (Vercel) · Project-specific reasoning

## Zoom out — where this pattern lives

Every serverless function has a wall-clock cap. The route budget is the contract Vercel enforces; everything inside the route has to fit. Here is where it sits and what it bounds.

```
  Zoom out — the route budget as the outermost wall

  ┌─ UI ───────────────────────────────────────────────────┐
  │  page → fetch /api/agent or /api/briefing               │
  └───────────────────────┬─────────────────────────────────┘
                          │  HTTP (streaming)
  ┌─ Vercel runtime ──────▼─────────────────────────────────┐
  │  ★ export const maxDuration = 300  ★ ← we are here       │
  │  the wall around everything below                        │
  └───────────────────────┬─────────────────────────────────┘
                          │
  ┌─ Route handler ───────▼─────────────────────────────────┐
  │  bootstrap → listTools → agents → MCP calls + Anthropic  │
  └─────────────────────────────────────────────────────────┘
```

The pattern is not "we set it high so nothing fails." The pattern is "we set it to the highest value the plan allows, then defend the budget from inside so a single hung call cannot eat it." Two routes use it: `/api/agent` (`app/api/agent/route.ts:22`) and `/api/briefing` (`app/api/briefing/route.ts:19`).

## Structure pass — layers, axis, seams

**Layers — the wall and the work below it:**
- Vercel runtime layer — owns the 300s ceiling, kills the function when it hits it
- Route handler layer — owns the phase log, the cancellation propagation, the per-call timeout
- Adapter layer — owns the per-call retry + spacing
- Upstream — Bloomreach MCP server (rate-limited, occasionally hangs)

**The axis: who holds the time budget?** Trace it down the stack and the answer flips:

```
  Tracing "who holds the time budget?" down the stack

  ┌─ Vercel runtime ──────────────────────────┐
  │  HARD CEILING — 300s, then SIGKILL         │   the runtime decides
  └───────────────────────────────────────────┘
       ┌──────────────────────────────────────┐
       │ Route handler                         │
       │  phase log + cancellation propagation │   the route MEASURES
       └──────────────────────────────────────┘    + propagates cancel
            ┌────────────────────────────────┐
            │ MCP transport                   │
            │  TOOL_TIMEOUT_MS = 30_000       │    the transport
            │  AbortSignal.any(req, timeout)  │    SUB-BUDGETS one call
            └────────────────────────────────┘
                 ┌─────────────────────────┐
                 │ Bloomreach MCP server    │   upstream
                 │  may take seconds to     │   doesn't honor any
                 │  reply, may hang         │   client budget
                 └─────────────────────────┘
```

The seam between **runtime** and **handler** is where the budget changes from "you have 300s" to "I will measure how much of it you spent." The seam between **route handler** and **transport** is where the budget changes from "the whole request must fit" to "this one call must fit in 30s." Both seams carry contracts. Both flips are load-bearing.

## How it works

### Move 1 — the mental model

A `maxDuration` declaration is a wall. Vercel reads it at deploy time, allocates that much wall-clock per request, and SIGKILLs the function when it hits the ceiling. That is the entire mechanism on Vercel's side. The interesting work is what you do **inside** the wall — because if you do nothing, a single stuck upstream call can burn the whole 300s and the user gets nothing back.

The pattern here has three parts, and dropping any one of them changes the behavior:

```
  The route-budget defence — three nested bounds

  ┌──── 300s route budget (Vercel) ────────────────────────┐
  │                                                         │
  │   ┌── per-call 30s timeout (AbortSignal) ──────────┐   │
  │   │                                                 │   │
  │   │   ┌── client cancel (req.signal) ──────────┐  │   │
  │   │   │   user navigates away → ALL of the     │  │   │
  │   │   │   above propagate down to the in-      │  │   │
  │   │   │   flight Anthropic + MCP calls         │  │   │
  │   │   └────────────────────────────────────────┘  │   │
  │   └───────────────────────────────────────────────┘   │
  └────────────────────────────────────────────────────────┘

  outermost wins → innermost fires first
```

The wall is at 300s. Below it sits the 30s per-call timeout (any single MCP round-trip is bounded). Below that, the client cancel signal — if the user closes the tab, ALL three layers cancel because the signals are composed.

### Move 2 — step by step

**The declaration itself — `maxDuration`**

This is the wall. Vercel reads it at build time.

```ts
// app/api/agent/route.ts:20-22
// 300s = Vercel Pro's max. A live investigation (diagnostic → recommendation)
// runs ~100-115s under the ~1 req/s MCP limit; 60s (Hobby) cannot fit it.
export const maxDuration = 300;
```

```ts
// app/api/briefing/route.ts:17-19
// 300s = Vercel Pro's max. The monitoring agent + ~1 req/s MCP spacing can run
// well past Hobby's 60s ceiling, so the live briefing needs the higher budget.
export const maxDuration = 300;
```

The number isn't "as high as possible because we want headroom." It's "Pro's maximum because the cheaper plan's ceiling won't fit one real investigation." The comments name the constraint that drove the number — that is the actual teaching point. A reviewer who skims the value learns nothing; a reviewer who reads the comment learns the **why**.

```
  Pattern: budget = (per-call work) × (per-call count) + (spacing)
           300s   ≥ (~3-5s)        × (6 tool calls)   + (5.5s + bootstrap)
           300s   ≥ ~30-40s typical, ~100-115s observed worst case
```

**Per-call timeout — `TOOL_TIMEOUT_MS`**

The route budget alone is not enough. A single hung MCP call would eat all 300s. The per-call timeout is the inner wall.

```ts
// lib/mcp/transport.ts:29-38
// Per-call upper bound on a single MCP tool/listTools round-trip. A hung
// Bloomreach connection would otherwise burn the entire 300s route budget on
// one stuck call. Sibling of `retryCeilingMs: 20_000` in client.ts — that
// ceiling bounds a rate-limit retry wait, this one bounds the request itself.
// Thrown as `HTTP 0: timeout after 30000ms`, riding the existing transport
// failure path (McpClient.liveCall already wraps it in McpToolError). The
// retry ladder in McpClient.callTool only retries successful-but-rate-limited
// results, so the timeout error fails fast — exactly what we want, since a
// retry would just risk another 30s wait inside the same route budget.
const TOOL_TIMEOUT_MS = 30_000;
```

Pseudocode of the composition:

```
  for each MCP call:
    inner_signal  = AbortSignal.timeout(30_000)        // per-call ceiling
    composed      = AbortSignal.any([req.signal, inner_signal])
                                                       // whichever fires first wins
    result        = await client.callTool(name, args, { signal: composed })
    // if composed fires → throws AbortError → caught upstream
```

The real code:

```ts
// lib/mcp/transport.ts:131
const signal = composeSignals(opts?.signal, AbortSignal.timeout(TOOL_TIMEOUT_MS));
try {
  return await this.client.callTool({ name, arguments: args }, undefined, { signal });
} catch (err) {
  if (isTimeoutError(err)) {
    throw new Error(`HTTP 0: timeout after ${TOOL_TIMEOUT_MS}ms`, { cause: err });
  }
  // ...
}
```

The HTTP 0 tag is intentional. When this surfaces in logs or in the UI, you know instantly: this wasn't an HTTP error — it was a client-side timeout. Different cause, different fix.

**The phase log — measuring how the budget was spent**

Here's the move people forget. Setting `maxDuration = 300` only tells Vercel what the ceiling is. It does NOT tell you, after a timeout, where the time went. The phase log fills that gap.

```ts
// app/api/briefing/route.ts:203-207
const t0 = performance.now();
const phases: Array<{ phase: string; durationMs: number }> = [];
const recordPhase = (phase: string, started: number) => {
  phases.push({ phase, durationMs: Math.round(performance.now() - started) });
};

// per-phase usage, e.g.:
const t_schema = performance.now();
const schema = await bootstrap(req.signal);
recordPhase('schema_bootstrap', t_schema);
```

And on the way out — including on error — it logs one line per request:

```ts
// app/api/briefing/route.ts:317-324
console.log(JSON.stringify({
  route: '/api/briefing',
  sessionId: sid,
  mode,
  totalMs: Math.round(performance.now() - t0),
  phases,
  aborted: req.signal.aborted,
}));
```

The same shape lives in `/api/agent` (`app/api/agent/route.ts:331-338`). One Vercel filter — `phases.phase = "schema_bootstrap"` — reads bootstrap latency across both endpoints. That is the design decision: shared shape so a single observability query lights up both routes.

Critical detail: the log fires inside `finally`. Even when the route throws (or hits the 300s ceiling), the phase log emits. **You can answer "what was running when we hit the ceiling?" by reading the last phase recorded before `totalMs ≈ 300_000`.**

**Cancellation propagation — making the wall reach the workers**

The route's `req.signal` is threaded into every async boundary inside the route, so a client cancellation reaches in-flight Anthropic + MCP calls.

```ts
// app/api/briefing/route.ts:215-220
req.signal.throwIfAborted();
step('reading the workspace schema…');
const t_schema = performance.now();
const schema = await bootstrap(req.signal);
recordPhase('schema_bootstrap', t_schema);
```

Each agent constructor takes the signal in its hooks (`AgentHooks.signal` in `lib/agents/diagnostic.ts:23`). Each `dataSource.callTool` is called with `{ signal }`. The signal flows all the way down to the Anthropic SDK and the MCP transport, and `composeSignals` ORs it with the per-call 30s timeout.

```
  Cancellation propagation — the signal flows down

  user closes tab
        │
        ▼
  req.signal fires (Next.js)
        │
        ├──► throwIfAborted() at phase boundaries (route handler)
        │
        ├──► passed to bootstrap(req.signal) → unwraps inside MCP client
        │
        ├──► passed to agent.investigate({signal})
        │         │
        │         ├──► passed to anthropic.messages.create(params, {signal})
        │         │
        │         └──► passed to dataSource.callTool(..., {signal})
        │                   │
        │                   └──► composeSignals(req, timeout) → MCP transport
        │
        └──► finally: phase log fires showing how much budget was burned
                       before the cancel landed
```

### Move 3 — the principle

A wall-clock budget is only a number until you defend it from inside. The actual pattern is: declare the budget, sub-budget every potentially-slow operation, propagate cancellation, and log where the budget went — including on the failure path. Setting `maxDuration` and walking away gives you a wall with no instruments; the user sees a 504 and you cannot tell why.

The principle generalizes: any time you set a hard limit (memory, time, retries, request size), the next move is to add a smaller inner limit on the most likely single offender, plus an observability hook that survives the failure path.

## Primary diagram

The whole pattern in one frame.

```
  Route budget defence — the whole stack

  ┌─ Vercel runtime ────────────────────────────────────────────────────┐
  │  maxDuration = 300s — HARD CEILING, SIGKILL on overrun               │
  └───────────────────────────────┬─────────────────────────────────────┘
                                  │
  ┌─ Route handler ───────────────▼─────────────────────────────────────┐
  │                                                                       │
  │  t0 = performance.now()                                               │
  │  phases = []                                                          │
  │                                                                       │
  │  try {                                                                │
  │    req.signal.throwIfAborted()                                        │
  │                                                                       │
  │    t_a = now()                                                        │
  │    await phase_a(req.signal)              ─┐                          │
  │    recordPhase('phase_a', t_a)             │ each phase guards on     │
  │                                            │ req.signal AND threads   │
  │    t_b = now()                             │ it down to inner calls   │
  │    await phase_b(req.signal)               │                          │
  │    recordPhase('phase_b', t_b)            ─┘                          │
  │  } catch (e) { ... }                                                  │
  │  finally {                                                            │
  │    console.log({ route, totalMs, phases, aborted })                   │
  │       ↑ fires even on timeout — answers "where did the time go?"     │
  │  }                                                                    │
  └─────────────────────────────────┬───────────────────────────────────┘
                                    │
  ┌─ MCP transport ─────────────────▼───────────────────────────────────┐
  │  per-call: composeSignals(req.signal, AbortSignal.timeout(30_000))   │
  │  whichever fires first cancels the in-flight HTTP request             │
  └─────────────────────────────────────────────────────────────────────┘
```

## Elaborate

**Where Vercel's `maxDuration` came from.** Lambda's `Timeout` (max 900s) is the upstream primitive. Vercel exposes it per-route via the `maxDuration` named export. The plan-tiered ceiling (Hobby 60s, Pro 300s, Enterprise 800s as of writing) is a billing constraint, not a technical one.

**Why this code can't use Hobby.** A diagnose+recommend investigation makes up to 6+4 tool calls × 1.1s spacing + per-call MCP latency + per-call Anthropic latency. Even an empty schema bootstrap is ≥4.4s. The 60s ceiling fits roughly one tool-less Anthropic call and nothing else. The route comments name this explicitly so a future engineer doesn't try to "save money by going Hobby" and ship a broken demo.

**The pattern beyond Vercel.** Every serverless and edge platform has the same shape: a wall-clock limit, a SIGKILL on overrun. AWS Lambda's 900s, Cloudflare Workers' 30s CPU / 30s wall (paid plan), Cloud Run's per-request timeout. The defence pattern is the same in all of them — name the ceiling in code with a comment that justifies the number, sub-budget any potentially-slow single operation, propagate cancellation, log where time went on the failure path.

**Adjacent guides.**
- The cancellation mechanism (AbortSignal, AbortController, composition) is detailed in `study-runtime-systems`.
- The shape of the route handler as a streaming response is in `study-system-design` → request flow.
- The cost meter (Anthropic `res.usage` logged per call) lives in `study-ai-engineering` → cost ceiling.

## Interview defense

> **"Walk me through how you bound wall-clock on a long-running serverless function."**

```
  Three nested bounds, fail-fast in, observability out

  300s route budget (Vercel maxDuration) ─┐
   │                                       │  outer wall
   │  30s per-MCP-call timeout ──────────┐ │
   │   │                                  │ │
   │   │  req.signal (client cancel) ─┐  │ │  ← composed via
   │   │                              │  │ │    AbortSignal.any
   │   ▼                              ▼  ▼ │
   │  the FIRST to fire cancels the inner ▼
   │  ────────────────────────────────────
   │
   └─► phase log in finally{} → answers "where did the budget go"
        even on the timeout path
```

I set `maxDuration = 300` on the route — the route comment cites why: a real investigation runs ~100-115s and Hobby's 60s won't fit. Inside, every MCP call gets `AbortSignal.timeout(30_000)`, composed with `req.signal` via `AbortSignal.any`, so a single hung call can't burn the whole budget. The signal threads all the way down — through `bootstrapSchema`, through every agent, through `anthropic.messages.create`, through `dataSource.callTool`. And I emit a phase log in `finally` so when a timeout happens I can read `phases` in Vercel and see exactly which phase was running. Anchor: `app/api/agent/route.ts:22` for the budget; `lib/mcp/transport.ts:38,131` for the per-call timeout + composition; `app/api/agent/route.ts:331-338` for the phase log.

> **"What's the load-bearing part most people forget when they set a `maxDuration`?"**

The `finally`-block phase log. Setting `maxDuration` only tells the runtime what the ceiling is — it gives you no help diagnosing what was running when you hit it. If the log fires only on the success path, every timeout is silent. We emit one structured line per request with `totalMs`, the phases array, and `aborted`, and it fires inside `finally` so the timeout path is covered too. That single change is the difference between "the route timed out, who knows why" and "the route timed out at 297s inside `monitoring_scan`, here's the phase before it that took 95s."

> **"Why 30s for the per-call timeout?"**

Because the 60s rate-limit retry ladder (`retryCeilingMs: 20_000` × up to 3 retries) can already cost ~30s on a SINGLE call — that's `retries × ceiling` on a successful-but-rate-limited response. The 30s timeout is for transport-level hangs (no response at all), which is a different failure mode that the retry ladder doesn't address (the retry ladder only fires on `isRateLimited(result)`, i.e. a returned 429 envelope). So 30s covers the hung-connection case while leaving the rate-limit retry budget intact. Anchor: comment at `lib/mcp/transport.ts:29-37`.

## See also

- `02-mcp-spacing-and-retry.md` — the per-call layer inside this budget
- `03-ttl-cache-no-cache-on-error.md` — the cache that absorbs repeats within the budget
- `04-progressive-ndjson-stream.md` — what the user sees while the budget is being spent
- `audit.md` → `performance-budget` lens
