# Agents vs chains

## Subtitle

Loop with LLM-decided steps / fixed multi-stage pipeline — Industry standard.

## Zoom out, then zoom in

blooming uses both. The outer flow — monitoring → diagnose → recommend — is a **chain** (fixed order, human-triggered transitions). Each stage inside is an **agent** (LLM decides which MCP tools to call and how many). That's the shape most production LLM systems converge on: chains for the coordination you already know, agents for the exploration you don't.

```
  Zoom out — the two nested layers

  ┌─ Outer: chain (fixed) ─────────────────────────────┐
  │                                                     │
  │  monitoring ──▶ diagnostic ──▶ recommendation      │
  │                                                     │
  │  each stage is:                                    │
  │  ┌─ Inner: agent (loop) ★ ────────────────────┐   │
  │  │  Thought ──▶ Action ──▶ Observation ──▶ ... │   │ ← agents live here
  │  │  LLM decides which tool, how many turns     │   │
  │  └────────────────────────────────────────────┘   │
  └─────────────────────────────────────────────────────┘
```

Zoom in: the shape difference is *who decides the steps*. In a chain, code decides. In an agent, the LLM decides.

## Structure pass

- **Layers:** chain (code control) → agent (LLM control) → tool call (external). Three nested bands.
- **Axis: who decides control flow?** Chain: code. Agent: LLM. Tool: neither — deterministic execution.
- **Seam:** the `while` loop inside each agent. Above it, code is in charge; inside it, LLM is in charge.

## How it works

### Move 1 — the mental model

Chain:

```
  Chain — fixed step order, code decides

  Input ──▶ Step 1 ──▶ Step 2 ──▶ Step 3 ──▶ Output
           (LLM call)  (LLM call)  (LLM call)
  code sequences the calls; each is a separate LLM invocation
```

Agent:

```
  Agent — LLM decides steps, code loops until stop

           ┌────────────────────────────────┐
           │                                 │
  Input ──▶│  Thought ──▶ Action ──▶ Obs ──┐ │──▶ Output (when LLM emits done)
           │              ▲                │ │
           │              │                ▼ │
           │              └────── loop ────  │
           └────────────────────────────────┘
```

### Move 2 — the step-by-step walkthrough — variant: the load-bearing skeleton

**The agent kernel.** What are the irreducible parts of an agent loop? Three:

1. **The model turn.** One call to the LLM with the accumulated messages, tools, and any prior tool results. Without this, no action at all.
2. **The tool dispatcher.** When the model emits a `tool_use` block, code runs the tool and appends the result as a `tool_result` message. Without this, tools can't run.
3. **The termination condition.** When the model emits an `end_turn` stop (or the loop hits `max_iterations`), the loop stops. Without this, the loop never ends.

```
  Agent kernel — three parts, name each by what breaks when missing

  ┌─ 1. Model turn ─────────────────────────────────┐
  │  drops it: agent can't decide anything           │
  └──────────────────────────────────────────────────┘
  ┌─ 2. Tool dispatcher ────────────────────────────┐
  │  drops it: tools never actually execute          │
  └──────────────────────────────────────────────────┘
  ┌─ 3. Termination condition ──────────────────────┐
  │  drops it: agent loops forever                   │
  └──────────────────────────────────────────────────┘
```

**Skeleton vs hardening.** The three above are the kernel — the minimum that still is an agent. Hardening layered on top: cancellation via `AbortSignal` (see `hooks.signal` in `lib/agents/diagnostic.ts:33`), budget ceilings (`lib/agents/budget.ts`), retry-on-transient-error, observability hooks. All of those are additions — you can strip them and still have "an agent."

**Where blooming's kernel lives.** Not in blooming's code — in `@aptkit/core`. The `AptKitDiagnosticInvestigationAgent` class holds the loop. blooming's contribution is the *adapters* that plug the kernel into blooming's world: `AnthropicModelProviderAdapter` for the model turn, `BloomingToolRegistryAdapter` for the dispatcher, `BloomingTraceSinkAdapter` for observability. See `lib/agents/aptkit-adapters.ts`.

**Where the chain lives.** In the route handler. `app/api/agent/route.ts` reads the `?step=diagnose|recommend` param and picks which agent to run. That's the chain — code decides which stage runs next based on user action (clicking "see recommendations →"). No LLM makes the transition decision.

Diagram of one investigation flowing through the outer chain and the inner agent:

```
  Nested — chain outside, agent inside

  ┌─ Chain (route decides) ────────────────────────────────┐
  │                                                         │
  │  user clicks investigate                                │
  │           │                                             │
  │           ▼                                             │
  │  ┌─ DiagnosticAgent (inner agent, aptkit-owned loop) ┐  │
  │  │  turn 1: LLM thought + eql query                   │  │
  │  │  turn 2: tool result + LLM thought                 │  │
  │  │  ...                                                │  │
  │  │  turn N: LLM emits submit_diagnosis tool_use       │  │
  │  │            → Diagnosis returned                    │  │
  │  └────────────────────────────────────────────────────┘  │
  │           │                                             │
  │           ▼                                             │
  │  saveInvestigation()                                    │
  │                                                         │
  │  user clicks "see recommendations →"                    │
  │           │                                             │
  │           ▼                                             │
  │  ┌─ RecommendationAgent (inner agent) ────────────────┐ │
  │  │  turn 1-N: same pattern, different system prompt   │ │
  │  │            → Recommendation[] returned             │ │
  │  └────────────────────────────────────────────────────┘ │
  └─────────────────────────────────────────────────────────┘
```

### Move 3 — the principle

Use chains where you know the steps in advance. Use agents where you don't. Blooming uses chain-of-agents: the outer sequence is deterministic (three stages, defined by product surface); the inner exploration inside each stage is LLM-decided (which EQL to run, in what order, with what follow-up). Getting this split right is where most systems end up.

## Primary diagram

```
  Agents + chains in blooming — full frame

  ┌─ Chain (outer, code-decided) ──────────────────────────┐
  │                                                         │
  │  ┌─ Stage 1: MonitoringAgent ──────────────────────┐   │
  │  │  agent loop: pick categories, run EQL,          │   │
  │  │  synthesize anomalies                            │   │
  │  │  → Anomaly[]                                     │   │
  │  └──────────────────────────────────────────────────┘   │
  │                        │                                 │
  │                        ▼ (user click)                    │
  │  ┌─ Stage 2: DiagnosticAgent ──────────────────────┐   │
  │  │  agent loop: explore hypotheses, cite evidence  │   │
  │  │  → Diagnosis                                     │   │
  │  └──────────────────────────────────────────────────┘   │
  │                        │                                 │
  │                        ▼ (user click)                    │
  │  ┌─ Stage 3: RecommendationAgent ──────────────────┐   │
  │  │  agent loop: propose actions, size impact       │   │
  │  │  → Recommendation[]                              │   │
  │  └──────────────────────────────────────────────────┘   │
  │                                                         │
  └─────────────────────────────────────────────────────────┘

  Each agent's kernel: model turn + tool dispatcher + termination.
  aptkit owns the kernel; blooming owns the adapters.
```

## Elaborate

The chain-of-agents pattern is the industry consensus for LLM applications with multi-stage flows. Pure agents (one massive loop that does everything) tend to lose focus; pure chains (fixed steps at every level) can't handle open-ended exploration. The nested shape lets each layer do what it's best at.

Aptkit's contribution: writing the agent kernel once and letting apps plug in their own adapters. That's why blooming's five agent classes are ~35-70 lines each (`lib/agents/*.ts`) — the loop is elsewhere, and blooming supplies only the mapping into its world.

Related: **02-tool-calling.md** (the tool part of the agent kernel), **03-react-pattern.md** (a specific loop shape), **../02-context-and-prompts/03-prompt-chaining.md** (the outer chain).

## Project exercises

### B4.1 · Extract a helper for the outer chain

- **Exercise ID:** B4.1 (Case A — outer chain exists in route handlers, could be consolidated)
- **What to build:** Right now the outer chain is coded across `app/api/briefing/route.ts` and `app/api/agent/route.ts` — the transition logic is in the routes. Extract a `InvestigationChain` class or module that names the chain explicitly. Route handlers become thin dispatchers.
- **Why it earns its place:** The chain is currently implicit — a code reader has to reconstruct it by reading two route files. Making it explicit signals "we knew this was a chain and named it."
- **Files to touch:** New `lib/agents/investigation-chain.ts`, refactor `app/api/agent/route.ts` (thinner), extend `test/state/investigations.test.ts` for the chain.
- **Done when:** the chain is named and unit-tested independently of routes; route handlers shrink by ~30%.
- **Estimated effort:** `1–2 days`.

## Interview defense

**Q: Why is blooming a chain of agents and not just one big agent?**

Product surface. The user has three distinct actions — see anomalies, investigate one, see recommendations. Each is a separately-scored, separately-cached stage. A single agent would flatten those into one output; the chain preserves the shape the UI cares about. Load-bearing: independent scoring (two rubrics, one per inner agent) is only possible because the chain is explicit.

**Q: Which layer holds the loop — your code or aptkit's?**

Aptkit. The `AptKitDiagnosticInvestigationAgent` (from `@aptkit/core`) owns the while loop. Blooming supplies three adapters: model provider, tool registry, trace sink. That's ports-and-adapters applied to the agent boundary — the kernel is portable, the app-specific plumbing is in adapters.

## See also

- [02-tool-calling.md](02-tool-calling.md) — the dispatcher inside the agent kernel.
- [03-react-pattern.md](03-react-pattern.md) — the specific loop shape aptkit uses.
- [../02-context-and-prompts/03-prompt-chaining.md](../02-context-and-prompts/03-prompt-chaining.md) — the outer chain in more detail.
