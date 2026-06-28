# Guardrails and control

*Industry name: guardrails / control envelope — Industry standard.*

The controls that bound an autonomous loop. **This repo's envelope is load-bearing.** Per-agent budgets (`maxTurns` + `maxToolCalls` + forced-final synthesis) live at the kernel layer; AbortSignal is threaded through every async layer; AptKit validators are the output guardrail; the diagnose→recommend HTTP split is an action-gating human-in-the-loop pause.

## Zoom out — where this concept lives

Guardrails live at three layers: input (sanitize / validate before the loop starts), inside the loop (caps on iteration, cost, tool calls; cancellation propagation), and output (schema validation, never let agent output trigger side effects directly).

```
  Where guardrails live in blooming insights

  ┌─ Input guardrails ──────────────────────────────────────┐
  │  schemaCapabilities + runnableCategories                 │ ← context filtering
  │  per-agent tool policy (least privilege)                 │ ← tool grants
  └────────────────────┬───────────────────────────────────┘
                       ▼
  ┌─ Loop-level guardrails (the kernel's control envelope) ─┐
  │  maxTurns per agent (6 or 8)                             │ ← we are here
  │  maxToolCalls per agent (4 or 6)                         │
  │  forced-final synthesis when budget hit                  │
  │  AbortSignal threaded through every async call           │
  └────────────────────┬───────────────────────────────────┘
                       ▼
  ┌─ Output guardrails ─────────────────────────────────────┐
  │  AptKit validators (tryParseAnomalies, tryParseDiagnosis,│
  │   validateRecommendations)                                │
  │  recovery turn on parse failure                          │
  │  HTTP split between diagnose + recommend = human gate    │
  └──────────────────────────────────────────────────────────┘
```

## Structure pass

The axis: **what bound is enforced where?**

```
  Bound                         Layer                Mechanism
  ─────                         ─────                ─────────
  How many turns                kernel               maxTurns
  How many tool calls           kernel               maxToolCalls
  How long any one call         transport (Bloom)    30s MCP per-call timeout
  How long the whole request    route                Vercel maxDuration=300
  How fast tool calls fire      DataSource           ~1 req/s spacing
  Which tools the agent sees    AptKit               toolPolicy filter
  When the user cancels         all layers           AbortSignal (req.signal)
  Whether the output parses     AptKit               validator + recovery turn
  Whether recommendations run   route                HTTP split + diagnosis param
  Whether the recommendation    n/a (read-only)      no execution side-effect path
   triggers a real action
```

The control envelope is layered — each bound catches a different failure mode. No single mechanism does everything.

## How it works

### Move 1 — the mental model

You know the layered defense pattern in security — network firewall, app-layer auth, per-endpoint rate limit, output sanitization. Each layer catches a different attack class. Guardrails for agents are the same: per-turn budgets catch infinite loops, per-call timeouts catch hung dependencies, output validators catch malformed handoffs, the HTTP split catches "we don't trust the agent enough to skip human review."

```
  The control envelope around an autonomous loop

  ┌───────────────────────────────────────────────┐
  │  Input guardrail   (validate / sanitize)      │
  └────────────────────┬──────────────────────────┘
                       ▼
  ┌───────────────────────────────────────────────┐
  │  Agent loop                                   │
  │   • iteration cap (max steps)                 │
  │   • token / cost budget (halt at ceiling)     │
  │   • human-in-the-loop pause (gated actions)   │
  └────────────────────┬──────────────────────────┘
                       ▼
  ┌───────────────────────────────────────────────┐
  │  Output guardrail  (schema, safety check,     │
  │  never let agent output trigger side effects  │
  │  directly — go through your code)             │
  └───────────────────────────────────────────────┘
```

### Move 2 — walk this repo's envelope, layer by layer

**Loop-level: per-agent budgets enforced inside `runAgentLoop`.**

Every agent has `maxTurns + maxToolCalls + synthesisInstruction` configured at the AptKit class level. Numbers from the source:

| Agent | maxTurns | maxToolCalls | What the budget guarantees |
|---|---|---|---|
| Monitoring | 8 | 6 | At most 6 EQL queries per briefing |
| Diagnostic | 8 | 6 | At most 6 tool calls per investigation |
| Recommendation | 6 | 4 | Tighter — mostly reasons from upstream diagnosis |
| Query | 8 | 6 | At most 6 tool calls per Q&A |

The forced-final synthesis turn is the load-bearing part. From `base-legacy.ts:230-232`:

```typescript
export function buildSynthesisInstruction(middle: string): string {
  return `You have NO more tool calls available. ${middle} Do not say you need more queries.`;
}
```

When the budget is hit, the next turn omits `tools` from the Anthropic request so the model MUST emit text. Without this, the budget cap alone wouldn't produce output — the model could refuse to synthesize. The instruction tells it the situation; the tools-omission forces the format.

**Loop-level: AbortSignal threaded through every layer.**

Every async call in the pipeline accepts a `signal: AbortSignal` so that when the user closes the tab, the cascade of in-flight calls all cancel. From `base-legacy.ts:114-117`:

```typescript
for (let turn = 0; turn < maxTurns; turn++) {
  // Coarse abort check between turns — bails fast on cancel so the route's
  // catch block sees the AbortError before another SDK call is queued.
  signal?.throwIfAborted();
  // ...
```

The signal is plumbed:
- From `req.signal` at the route layer
- Into the agent's `hooks.signal`
- Through `runAgentLoop`'s per-turn check
- Into every `anthropic.messages.create(params, { signal })` call
- Into every `dataSource.callTool(name, args, { signal })` call
- Down to the MCP transport's HTTPS call (and Bloomreach's per-call 30s timeout composes via `AbortSignal.any`)

What this prevents: orphaned LLM/MCP calls eating budget after the user has left.

**Loop-level: per-call timeout at the transport.**

`BloomreachDataSource` enforces a 30s timeout per MCP call (composed with the request signal). Even if the loop's overall AbortSignal is still live, any one MCP call that hangs gets cancelled after 30s. This is the "no single call can stall the loop" bound.

**Output-level: AptKit validators.**

Each AptKit agent has a validator that runs on the loop's final text:
- `tryParseAnomalies` (monitoring)
- `tryParseDiagnosis` (diagnostic)
- `validateRecommendations` (recommendation)
- `validateQueryAnswer` (query)

If the parse fails, the kernel runs ONE additional tool-less recovery turn with a dedicated prompt:

```typescript
// base-legacy.ts:213-218
parsed = opts.parseResult(finalText);
if (parsed === null && opts.recoveryPrompt) {
  const recoveryText = await runRecoveryTurn(opts, opts.recoveryPrompt(toolCalls));
  parsed = recoveryText === null ? null : opts.parseResult(recoveryText);
}
```

If recovery also fails, the agent returns the empty/fallback shape. This is the "the agent's output ALWAYS matches the expected schema or returns nothing" guarantee.

**Output-level: the HTTP split as a human-in-the-loop gate.**

The diagnose→recommend split (`../03-multi-agent-orchestration/03-sequential-pipeline.md`) is itself a guardrail. The user reviews the diagnosis before recommendations are generated. From `app/api/agent/route.ts:289`:

```typescript
if (step !== 'diagnose') {
  // ... only then run RecommendationAgent
}
```

When `step === 'diagnose'`, the route NEVER runs the recommendation agent — even if the diagnosis is great. The user has to explicitly proceed. This is the action-gating split: the diagnostic agent's output doesn't trigger downstream computation without human approval.

**Read-only by construction: no execution side effects.**

The RecommendationAgent is explicitly read-only — from its prompt: "You are read-only: you do NOT execute anything. Your recommendations are suggestions for a human to act on." The agent CAN'T trigger a real Bloomreach action because no execution tool is in its tool grant. The execution path doesn't exist in the codebase. This is the strongest guardrail there is — the agent doesn't have the capability to do harm because the capability isn't in its policy.

### Move 2.5 — what's NOT in the envelope yet

**No per-tool circuit breaker.** A flaky tool still wastes calls until the budget is spent. See `../05-production-serving/03-per-tool-circuit-breaking.md`.

**No global token-ceiling.** Per-agent budgets sum to a bounded total, but there's no overall cap that halts the pipeline if total tokens exceed a threshold. If a future change loosened any per-agent cap, the global guard wouldn't catch it.

**No input sanitization for prompt injection on the QueryAgent's free-form input.** The user's typed query goes into the prompt as-is. Prompt injection vectors (e.g., the user typing "ignore previous instructions and ...") aren't filtered. Mitigations: the per-agent tool policy contains the blast radius (the QueryAgent can't trigger side effects regardless), and the AbortSignal lets the user cancel. But "the user CAN'T injection-attack the agent" isn't true; "the user can't get the agent to do anything harmful via injection" mostly is, because of the read-only tool grants.

### Move 3 — the principle

An agent without caps loops silently and burns tokens; an agent whose output triggers side effects directly is a prompt-injection liability. The control envelope's job is to make both impossible by topology: caps at the kernel, validators at the output, no side-effect tools at the agent layer. The HTTP split for human review is the explicit acknowledgment that even with all the above, the user gets the final word before action.

The pattern that matters most: **the agent never executes itself**. It emits intent; your code executes. That boundary is the safety story. Every guardrail above is enforcement at a different layer of that one principle.

## In this codebase

**Yes — load-bearing.** Every layer of the control envelope is in place:

- Kernel: per-agent budgets + forced-final synthesis (`@aptkit/core` + Blooming's `base-legacy.ts` mirror)
- Cancellation: AbortSignal threaded route → agent → AptKit → Anthropic + MCP
- Per-call timeout: 30s at the MCP transport
- Output: AptKit validators + one-turn recovery
- Action gating: HTTP split between diagnose and recommend
- Read-only by topology: no execution tool in any agent's grant

The gaps (named above): per-tool circuit breaker, global token ceiling, input sanitization for prompt injection.

## Primary diagram

The full control envelope around an investigation:

```
  Control envelope around one investigation

  ┌─ /api/agent?step=diagnose ─────────────────────────────────┐
  │                                                              │
  │  ┌─ Input guardrails ─────────────────────────────────────┐ │
  │  │  resolveAnomaly: validate insightId / insightParam      │ │
  │  │  per-agent toolPolicy filters MCP catalog                │ │
  │  │  schemaSummary capped at 20×10 (not 100KB)              │ │
  │  └────────────────────────────────────────────────────────┘ │
  │                                                              │
  │  ┌─ Loop guardrails (kernel) ─────────────────────────────┐ │
  │  │  maxTurns=8, maxToolCalls=6                             │ │
  │  │  forced-final synthesis on budget hit                   │ │
  │  │  signal.throwIfAborted() between turns                  │ │
  │  │  signal threaded to anthropic.messages.create + callTool│ │
  │  │  per-call 30s timeout at MCP transport                  │ │
  │  └────────────────────────────────────────────────────────┘ │
  │                                                              │
  │  ┌─ Output guardrails ────────────────────────────────────┐ │
  │  │  tryParseDiagnosis on finalText                         │ │
  │  │  recovery turn (one tool-less call) if parse fails       │ │
  │  │  fallback diagnosis shape if recovery fails              │ │
  │  └────────────────────────────────────────────────────────┘ │
  │                                                              │
  │  ┌─ Action gate (HTTP split) ─────────────────────────────┐ │
  │  │  STOP — do NOT run RecommendationAgent                  │ │
  │  │  user must navigate to ?step=recommend explicitly       │ │
  │  └────────────────────────────────────────────────────────┘ │
  └──────────────────────────────────────────────────────────────┘
```

## Interview defense

**Q: "What's your control envelope around the agent loop?"**

A: Four layers. Loop-level: per-agent `maxTurns` + `maxToolCalls` + forced-final synthesis (8/6 for monitoring/diagnostic/query, 6/4 for recommendation) — without the cap an agent loops silently and burns tokens; without forced-final synthesis the cap alone wouldn't produce output. Cancellation: AbortSignal threaded from `req.signal` at the route layer down through AptKit's runAgentLoop into every Anthropic and MCP call, so closing the tab cancels in-flight work. Output-level: AptKit validators (`tryParseDiagnosis`, etc.) catch malformed output, with a one-turn recovery that re-runs tool-less synthesis with a dedicated prompt. Action gating: the HTTP split between `?step=diagnose` and `?step=recommend` — the diagnostic agent's output never triggers recommendations without explicit user navigation. And the strongest guardrail of all: the agent never executes itself. The RecommendationAgent is read-only by topology — no execution tool in its grant, so even prompt injection can't make it do harm.

Diagram I'd sketch:

```
  ┌─ input ─────────────────────────────┐
  │  tool policy, schema-gated context  │
  └──────────────┬──────────────────────┘
                 ▼
  ┌─ loop ──────────────────────────────┐
  │  maxTurns, maxToolCalls, signal     │
  │  forced-final synthesis on budget   │
  └──────────────┬──────────────────────┘
                 ▼
  ┌─ output ────────────────────────────┐
  │  validator + recovery turn          │
  └──────────────┬──────────────────────┘
                 ▼
  ┌─ action gate (HTTP split) ──────────┐
  │  human reviews diagnosis before     │
  │  recommendations are generated      │
  └─────────────────────────────────────┘

  + invariant: agent NEVER executes itself; harness runs all tools
```

Anchor: "the forced-final synthesis turn is the load-bearing kernel guarantee. Without it, the cap alone wouldn't produce output — the model could refuse to synthesize. Tools-omission on the final turn is the mechanism that makes the cap *produce a result*, not just stop."

**Q: "What guardrails are NOT in your envelope yet?"**

A: Three honest gaps. Per-tool circuit breaker — a flaky tool today wastes calls until the per-agent budget is spent; a circuit breaker would fail fast and feed the open-circuit state back to the agent so reasoning routes around it. Global token ceiling — per-agent budgets sum to a bounded total, but there's no overall cap that halts the pipeline if total tokens exceed a threshold. Prompt-injection sanitization on the QueryAgent's free-form input — the user's typed query goes into the prompt as-is. The blast radius is contained by the read-only tool grants (the agent can't trigger side effects regardless), so a successful injection mostly costs tokens, not actions. But "the user CAN'T injection-attack the agent" isn't true; "the user can't get the agent to do anything harmful via injection" mostly is.

## See also

- [`../01-reasoning-patterns/02-agent-loop-skeleton.md`](../01-reasoning-patterns/02-agent-loop-skeleton.md) — where the budget exits live
- [`03-tool-calling-and-mcp.md`](./03-tool-calling-and-mcp.md) — tool policy is the least-privilege primitive
- [`04-agent-evaluation.md`](./04-agent-evaluation.md) — validators are implicit eval
- [`../03-multi-agent-orchestration/03-sequential-pipeline.md`](../03-multi-agent-orchestration/03-sequential-pipeline.md) — the HTTP split as a control point
- [`../05-production-serving/03-per-tool-circuit-breaking.md`](../05-production-serving/03-per-tool-circuit-breaking.md) — the gap that production serving fills
- ai-engineering's prompt-injection + error-recovery files (cross-ref) — the per-call defenses
