# Per-tool circuit breaking

*Industry names: per-tool circuit breaker / bulkhead per dependency · Industry standard*

## Zoom out

```
  Zoom out — the breaker scoped to a specific tool inside the loop

  ┌─ single-call circuit breaker (in study-ai-engineering) ────┐
  │  protects your service from hammering a broken dependency  │
  └────────────────────────────────────────────────────────────┘
              ↓ expands to
  ┌─ ★ PER-TOOL CIRCUIT BREAKING (this file) ★ ────────────────┐ ← we are here
  │  scoped per tool + feeds state back to the agent            │
  │  so the agent's reasoning routes around the dead tool       │
  └─────────────────────────────────────────────────────────────┘
```

## Zoom in

Single-call retry handles one flaky request. An agent loop can call the *same* flaky tool on every turn — retrying a dead tool inside a loop multiplies the failure by the iteration count and burns the whole budget on a tool that isn't coming back. A per-tool circuit breaker fails fast on dead tools AND surfaces the open state as an observation to the agent, so the agent's next-turn reasoning routes around the dead tool. Not currently implemented explicitly in this repo — the current mitigation is coarser (agent reads `isError: true` and adapts).

## Structure pass

Layers: **breaker state per tool** (closed / open / half-open) — **decision** (call vs fail-fast) — **feedback to agent** (observation shows the open state).

Axis to hold constant: **what does the agent see when a tool is dead?**

```
  What the agent sees per implementation

  No breaker:              tool timeouts / 500s / 429s repeatedly.
                           Agent retries same tool each turn until budget exit.

  Breaker (silent):        tool errors returned. Agent may still retry
                           the same tool if it doesn't recognize the
                           pattern in the error.

  Breaker + feedback:      tool result is "circuit open — tool X unavailable".
                           Agent reasons: "I need to route around this."
                           Next turn picks a different tool.
```

## How it works

### Move 1 — the shape

You've used a client-side circuit breaker before — Hystrix, Polly, resilience4j. Same shape at the agent altitude, with the extra move that the agent needs to *know* the breaker is open so it can adapt.

```
  Per-tool circuit breaker — the shape + the feedback loop

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

### Move 2 — what this repo does today and what would ship next

**Today: implicit graceful degradation, not explicit per-tool breaker.** The `BloomreachDataSource` has a rate-limit retry ladder (parses the server's stated penalty window, retries with backoff) and returns `isError: true` results without caching them. When a tool fails:

```
  Today's failure path

  agent → dataSource.callTool('execute_analytics_eql', {...})
    │
    ▼
  BloomreachDataSource dispatches
    ┌── rate-limit? retry ladder (up to 3 attempts) ──┐
    │  parses "retry after Ns" from Bloomreach error   │
    │  waits, retries                                  │
    └──────────────────────────────────────────────── ┘
    │
    ▼ still failing → return { isError: true, content: [...] }
  aptkit wraps as tool_result with is_error: true
    │
    ▼ agent's next turn reads the failed tool_result
  agent reasons: "that failed, let me try a different approach"
  → picks a different tool or a different variant of the same tool
```

This works — the fault-injection receipt (9 faults / 3 investigations / 0 failed) proves the agent can absorb tool failures and adapt. But it's **coarse**: the agent might still try the same failing tool on the next turn if it doesn't recognize the failure pattern. Nothing tracks "tool X failed 3 times in the last 30s, stop trying it."

**What a per-tool breaker would add.**

```
  Explicit per-tool breaker (would ship in future)

  new file: lib/data-source/circuit-breaker.ts

  class ToolCircuitBreaker {
    private breakers: Map<toolName, {
      state: 'closed' | 'open' | 'half-open',
      failCount: number,
      openedAt: number,
    }>

    beforeCall(toolName): { proceed: boolean, note?: string }
      // check state; if open, fail fast with note

    afterCall(toolName, success: boolean)
      // update state, potentially trip breaker
  }

  Wrap the DataSource:
    class BreakingDataSource implements DataSource {
      constructor(inner: DataSource, breaker: ToolCircuitBreaker) {}
      callTool(name, args, opts):
        const gate = this.breaker.beforeCall(name)
        if (!gate.proceed) {
          return { result: { isError: true, content: [{ type: 'text', text: gate.note }] } }
          // feedback via error text is what the agent reads
        }
        const result = await this.inner.callTool(name, args, opts)
        this.breaker.afterCall(name, !result.result.isError)
        return result
    }
```

The load-bearing part is the feedback: when the breaker is open, the DataSource returns a `tool_result` with `isError: true` and the text "circuit open for tool X — unavailable for the next Ns." That text is what the agent reads on its next turn. The agent's reasoning naturally routes around it because the text tells it what happened.

**Why this hasn't shipped yet.** The current implicit graceful degradation covers the observed failure modes. The receipt is real — 9 injected faults / 3 investigations / 0 failed. A per-tool breaker would be a hardening upgrade for a specific failure I haven't seen yet: a stuck-open tool that the agent keeps trying repeatedly within a single investigation. If that pattern showed up in production traces, the breaker file is well-scoped to add.

**The shift from ai-eng's single-call breaker.** The ai-engineering version protects *your service* from hammering a broken dependency. Here it does that AND feeds the open-circuit state back to the agent as an observation, so the agent's reasoning can route around the dead tool rather than looping on it. A breaker that just fails fast without telling the agent leaves the agent retrying the same dead path — the feedback loop is the multi-agent-specific move.

**State the runtime has to carry.** Per-tool breakers add state the agent runtime has to carry across turns (which tools are open, their cooldown timers). In a stateless serverless request, this state lives for the request duration only. Cross-request breaker state would require a shared store (Redis, in-memory-in-a-persistent-server) — beyond the scope of this Vercel-Pro serverless deployment.

### Move 3 — the principle

A per-tool circuit breaker adds bounded state (per-tool state, cooldown timers) in exchange for preventing a specific expensive failure — the agent looping on a dead tool until the whole budget is spent. The multi-agent-specific move is feedback: telling the agent the tool is dead, not just failing fast. Without feedback, the agent keeps retrying; with feedback, the agent routes around it.

## Primary diagram

```
  Per-tool circuit breaker — the shape + feedback + runtime state

  ┌─ Agent (aptkit ReAct loop) ──────────────────────────────────┐
  │  turn N: decides on tool call, e.g. execute_analytics_eql    │
  └───────────────────────────┬──────────────────────────────────┘
                              │
                              ▼
  ┌─ BreakingDataSource (would-be decorator) ────────────────────┐
  │                                                              │
  │  toolBreaker.beforeCall('execute_analytics_eql')             │
  │  ├─ closed:    proceed to inner.callTool                     │
  │  ├─ half-open: proceed (try one probe)                       │
  │  └─ open:      return { isError: true, content: [{ text:     │
  │                  "circuit open — tool unavailable for Ns" }]}│
  │                                                              │
  │  after inner.callTool:                                       │
  │    toolBreaker.afterCall(toolName, success)                  │
  │    - failure: increment count; trip to open if N failures    │
  │    - success: reset count if half-open                        │
  │                                                              │
  └───────────────────────────┬──────────────────────────────────┘
                              │
                              ▼
  ┌─ BloomreachDataSource (inner) ───────────────────────────────┐
  │  actual MCP call, rate-limit retry, 60s cache                │
  └───────────────────────────┬──────────────────────────────────┘
                              │
                              ▼ tool result (or breaker-open note)
  ┌─ Agent — turn N+1 reads observation ─────────────────────────┐
  │  reads: "tool unavailable" text                              │
  │  reasons: "I need a different approach"                       │
  │  picks: different tool OR different query                     │
  │  → converts "budget-ending event" to                          │
  │    "routed-around inconvenience"                              │
  └──────────────────────────────────────────────────────────────┘
```

## Elaborate

Per-tool circuit breakers as an agent-runtime pattern surfaced with LangGraph's `RetryPolicy` per node and CrewAI's error-handler primitives (2024). The distinguishing insight from single-call breakers (Hystrix, Polly, resilience4j) is the feedback loop — telling the agent the tool is dead so the agent's reasoning adapts, not just failing fast at the network layer.

The frontier is **breaker-state as first-class observability** — surfacing which tools are open to the UI and the trace so operators can see "the agent avoided tool X because it was open for the last 10 investigations." That's where per-tool breakers meet the trajectory eval story (`04-agent-infrastructure/04-agent-evaluation.md`) — recovery rate becomes a first-class metric.

## Interview defense

**Q: Do you have per-tool circuit breakers?**

Not explicitly. The current graceful degradation is coarser: `BloomreachDataSource` has a rate-limit retry ladder (parses Bloomreach's stated penalty window) and returns `isError: true` results without caching them. When a tool fails, the agent reads the failed `tool_result` on the next turn and reasons its way to a different approach.

That works — receipt is 9 injected faults across 3 investigations, 0 failed (via the `FaultInjectingDataSource` decorator). But it's coarse: nothing tracks "tool X failed 3 times in 30s, stop trying it." The agent might still retry the failing tool on the next turn if it doesn't recognize the pattern.

Where I'd add an explicit per-tool breaker: if I saw a stuck-open tool pattern in production traces. New file: `lib/data-source/circuit-breaker.ts`, wrap the DataSource as a decorator, return `isError: true` with a "circuit open" note when tripped. The note is the feedback the agent reads — that's the multi-agent-specific move.

*Anchor visual:* the breaker + feedback loop diagram above.

**Q: What's the specific failure this prevents?**

The agent looping on a dead tool. One dead tool + an unbounded agent loop = whole iteration budget spent on retries against a tool that isn't coming back. That's the worst kind of cost blowup — it produces nothing, and it's silent because there's no user-visible error until the budget exit fires.

The breaker turns SECTION C's "tool-call cascade" failure mode from a budget-ending event into a routed-around inconvenience.

**Q: Where does the runtime state live?**

In-request today, if I added it — the breaker state (per-tool fail count, opened timestamp) would live inside the DataSource instance and die with the request. For a Vercel serverless deployment, that's the right scope; each request gets a fresh DataSource anyway.

Cross-request breaker state would require a shared store (Redis, or an always-on server). Not this deployment. If I moved to a persistent runtime, cross-request state would let the breaker learn from failures over hours instead of one request.

## See also

- **`03-multi-agent-orchestration/09-coordination-failure-modes.md`** — tool-call cascade is the failure this specifically prevents.
- **`04-agent-infrastructure/03-tool-calling-and-mcp.md`** — the tool layer this breaker wraps.
- **`04-agent-infrastructure/04-agent-evaluation.md`** — the fault-injection receipt that measures graceful degradation.
- **`.aipe/study-ai-engineering/`** section 06 circuit-breaker mechanics for a single call.
