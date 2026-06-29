# Agent evaluation

**Industry standard.** Evaluating an agent is harder than evaluating one LLM call — the unit of evaluation is the *trajectory*, not just the final output. **Exercised** in this repo via Vitest with injected fakes (144 tests, no network).

## Zoom out, then zoom in

Sits as the testing and validation layer wrapping the agent classes. The eval surface is the test files in `test/agents/`; the seam that makes it work is the same port-and-adapter discipline the production agents use.

```
  Zoom out — where this concept lives

  ┌─ Production ────────────────────────────────────┐
  │  MonitoringAgent / DiagnosticAgent / Rec / Query│
  │  → real Anthropic + real Bloomreach MCP         │
  └────────────────────────────┬────────────────────┘
                               │
  ┌─ Eval seam ───────────────▼────────────────────┐
  │  ★ Vitest with injected fakes ★                 │ ← we are here
  │  fake ModelProvider + fake ToolRegistry          │
  │  scripted trajectories, no network, no API key  │
  └─────────────────────────────────────────────────┘
```

The same `ModelProvider` and `ToolRegistry` ports the production stack runs on are what the tests substitute. The agent class doesn't know it's being tested.

## Structure pass

Layers: trajectory eval (which tools called, in what order, with what arguments) → output eval (the structured result against a schema and against expected values) → behavioral eval (recovery from failures, budget exits, allowlist enforcement).

**Axis traced — "what's the unit of evaluation?":** for a single LLM call, it's input → output. For an agent, it's the full trajectory — the sequence of model calls, tool calls, and the final output. The trajectory is the test target.

**Seam:** the port substitution. The agent class consumes `ModelProvider` and `ToolRegistry` via constructor injection (the `BloomingToolRegistryAdapter` and `AnthropicModelProviderAdapter` get injected in production); tests inject fakes. The agent's code doesn't change.

## How it works

### Move 1 — the mental model

You know the difference between testing a pure function (`add(2, 3) === 5`) and testing a UI component (mount it, fire events, assert on the rendered output). The pure function has one input → one output; the component has a sequence of mounts, prop changes, user events, and the rendering is the eval target. Agent evaluation is the component side: the agent has a *trajectory* (the model calls, the tool calls, the final output), and the trajectory is what you assert against.

```
  LLM eval (one call):       Agent eval (a trajectory):
  ┌──────────────┐           ┌──────────────────────────┐
  │ input        │           │ was the right tool called?│
  │ → output     │           │ in the right order?       │
  │ → score      │           │ did it recover from errors│
  └──────────────┘           │ how many steps / $ / ms?  │
                             │ was the final output good?│
                             └──────────────────────────┘
```

### Move 2 — step by step

#### What the test setup looks like

Open `test/agents/monitoring.test.ts` (or any sibling test file). The setup constructs a fake `ModelProvider` that returns scripted Anthropic content blocks and a fake `DataSource` (or directly a fake `ToolRegistry`) that returns canned results.

```ts
// representative shape (paraphrased from test/agents/*.test.ts)
class FakeModelProvider implements ModelProvider {
  id = 'fake';
  defaultModel = 'fake-model';
  private responses: ModelResponse[];
  private callIndex = 0;

  constructor(scripted: ModelResponse[]) {
    this.responses = scripted;
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    if (this.callIndex >= this.responses.length) {
      throw new Error('FakeModelProvider exhausted scripted responses');
    }
    return this.responses[this.callIndex++];
  }
}

// in a test:
const modelProvider = new FakeModelProvider([
  // turn 1: emit a tool_use for execute_analytics_eql
  {
    content: [
      { type: 'text', text: 'I will query revenue.' },
      { type: 'tool_use', id: 'tu_1', name: 'execute_analytics_eql', input: { eql: '...' } },
    ],
  },
  // turn 2: emit the final JSON array
  {
    content: [
      { type: 'text', text: '```json\n[{"metric": "revenue", ...}]\n```' },
    ],
  },
]);

const toolRegistry = new InMemoryToolRegistry(
  [{ name: 'execute_analytics_eql', description: '...', inputSchema: {...} }],
  {
    execute_analytics_eql: async (args) => ({ current: 100, prior: 200 }),
  },
);

const agent = new AnomalyMonitoringAgent({ model: modelProvider, tools: toolRegistry, workspace, ... });
const anomalies = await agent.scan();

expect(anomalies).toHaveLength(1);
expect(anomalies[0].metric).toBe('revenue');
expect(modelProvider.callIndex).toBe(2);  // verified the two-turn trajectory
```

Three properties matter:

1. **No network.** No real Anthropic call, no real MCP call. The tests run in milliseconds.
2. **Deterministic.** The fake provider returns exactly what you scripted; the test outcome is repeatable.
3. **The same code runs.** The agent class doesn't know it's being tested — it calls `model.complete(...)` and `tools.callTool(...)` exactly as in production. Only the implementations behind the ports are different.

#### The four eval dimensions

The trajectory tests cover four dimensions of agent behavior:

1. **Task success rate.** Did the agent produce a valid output? (`expect(anomalies).toHaveLength(...)`)
2. **Tool-call accuracy.** Did it call the right tools with the right arguments in the right order? (Inspect `toolRegistry.callHistory` or the scripted `FakeToolRegistry`'s `lastCalledWith`.)
3. **Trajectory efficiency.** How many steps did it take to completion? (`expect(modelProvider.callIndex).toBeLessThanOrEqual(maxTurns)`)
4. **Recovery rate.** Did it handle a failed tool call gracefully? (Script a tool result that throws or returns `isError: true`; assert the agent continues with a different approach.)

The fifth dimension — the final output quality — is what's hardest to evaluate automatically. The output assertions in this repo's tests check *structure* (shape of `Anomaly`, presence of required fields) and *exact-match values* against scripted scenarios. They don't run an LLM-as-judge over the output's semantic correctness; the test set is small enough that human review during development covers that gap.

#### The recovery prompt test

A specific test worth pointing out: `test/agents/synthesis-instruction.test.ts` verifies that when the agent runs out of `maxToolCalls`, the next call to the model strips the `tools` parameter (forcing synthesis) and injects the synthesis instruction in the system prompt. This is testing the kernel's *budget-exit hardening* — not the agent's output, but the harness's behavior around the agent.

That kind of test is the trajectory-eval discipline applied to the runtime itself. It's the missing piece in most agent test suites — people test "given inputs X and a scripted model, expect output Y" but don't test "given a model that misbehaves, the runtime forces a final answer." Both belong in the eval surface.

#### The evaluator paradox — using an LLM to grade an LLM

Not exercised in this repo. The risk: using an LLM judge to grade an agent's trajectory introduces the same self-preference bias from `03-multi-agent-orchestration/05-debate-verifier-critic.md`. If you grade Claude Sonnet outputs with Claude Sonnet, the judge accepts what the producer produced.

The controls when LLM-as-judge is necessary:

- **Frozen golden trajectories.** A curated set of "this is what good looks like" trajectories captured from real successful runs; new agent runs are compared against them.
- **Iteration caps.** The judge can't keep asking for revisions; cap at one verdict.
- **Human spot-checks.** A periodic sample of judge decisions is reviewed by a human to catch drift.

This repo's eval surface stays trajectory-and-structure focused, avoiding the LLM judge entirely. The 144 tests are all deterministic structural assertions. If the team grew an eval that required semantic grading (e.g. "is this diagnosis actually plausible?"), the judge pattern would land — with the controls.

### Move 3 — the principle

**The unit of evaluation for an agent is the trajectory.** Final-output assertions cover one dimension; trajectory assertions cover the others (tool-call accuracy, efficiency, recovery, budget compliance). The port-and-adapter discipline (substitute the `ModelProvider` and `ToolRegistry` with fakes) is what makes trajectory eval cheap and deterministic. Without it, the only way to test an agent is end-to-end against real services, which is slow, flaky, and costs money. With it, 144 tests run in seconds and assert on every dimension of agent behavior.

## Primary diagram

```
  The eval substitution — same agent code, different ports

  Production:                              Test:
  ┌─────────────────────────┐              ┌─────────────────────────┐
  │ MonitoringAgent.scan()  │              │ MonitoringAgent.scan()  │
  │ (the production class,  │              │ (SAME CLASS, no change) │
  │  not a wrapper)         │              │                         │
  └────────────┬────────────┘              └────────────┬────────────┘
               │                                         │
               ▼                                         ▼
  ┌─ AnomalyMonitoringAgent (AptKit) ──────────────────────────────────┐
  │   runAgentLoop({ model, tools, ... })                              │
  └────────────────────┬─────────────────────────────┬──────────────────┘
                       │                              │
                       ▼                              ▼
  ┌─ ModelProvider port ─┐                 ┌─ ModelProvider port ─┐
  │ AnthropicAdapter      │                 │ FakeModelProvider     │
  │ → real Anthropic API  │                 │ → scripted responses  │
  │ → ~$0.03/turn         │                 │ → 0ms, deterministic  │
  └───────────────────────┘                 └───────────────────────┘

  ┌─ ToolRegistry port ──┐                 ┌─ ToolRegistry port ──┐
  │ BloomingAdapter       │                 │ InMemoryToolRegistry │
  │ → BloomreachDataSource│                 │ → injected handlers   │
  │ → real MCP call       │                 │ → 0ms, deterministic  │
  └───────────────────────┘                 └───────────────────────┘

  Test assertions on:
   - the agent's final output (Anomaly[], Diagnosis, etc.)
   - the scripted model's callIndex (number of turns)
   - the registry's call history (which tools, in what order, args)
   - recovery behavior on isError tool results
   - budget compliance (maxTurns, maxToolCalls)
```

## Elaborate

The trajectory-as-unit-of-evaluation framing emerged as agents became production systems rather than research demos. For a one-shot LLM call, you have one input and one output; the eval surface is "did the output match the expected answer." For an agent, "the answer" is downstream of a chain of decisions (which tool, what argument, when to stop), and any of those decisions can go wrong in ways that don't show up in the final output. Trajectory eval catches the upstream failures the final output hides.

The "fake the ports, run the real agent" pattern is the standard answer in agent-framework testing literature. LangChain's `FakeListChatModel`, OpenAI's mocked client in pytest, this repo's `FakeModelProvider` and `InMemoryToolRegistry` — all express the same idea. The discipline that makes it work is constructor injection of the model and tool ports; agents that hard-code their model provider (e.g. `new Anthropic()` inline) can't be tested this way without monkey-patching.

The 144-test count in this repo is meaningful relative to the agent count (4 active agents × ~3-4 categories of tests per agent + the runtime/adapter/registry surface tests). That density catches regressions in the per-agent prompt templating, the per-agent tool allowlist enforcement, and the agent's structured-output recovery. The test files are organized to mirror the agent file structure (`test/agents/monitoring.test.ts` ↔ `lib/agents/monitoring.ts`), which is a small but meaningful discoverability win for someone navigating the repo.

## Interview defense

> **Q: How does this codebase evaluate its agents?**
>
> Vitest with port substitution. 144 tests, all in `test/`, no network calls. Each test constructs a fake `ModelProvider` that returns scripted Anthropic content blocks (a `tool_use` block, then a final-text block) and a fake `ToolRegistry` (or `DataSource`) that returns canned tool results. The agent class — the same `MonitoringAgent` / `DiagnosticAgent` / etc. that runs in production — is instantiated with the fakes via constructor injection. The test then asserts on the agent's final output (`Anomaly[]`, `Diagnosis`, etc.) AND on the trajectory (which tools were called, in what order, with what arguments). The port-and-adapter discipline from `lib/data-source/types.ts` and `@aptkit/runtime/model-provider` is what makes this cheap and deterministic.

> **Q: What four dimensions does the eval surface cover?**
>
> Task success (the output parses and contains expected values), tool-call accuracy (right tools called with right args in right order), trajectory efficiency (turn count under the budget cap), and recovery (when a tool errors or the parser fails, the agent reaches a graceful end). The fifth dimension — semantic quality of the final output — isn't automated; the test set is small enough that human review during development covers it. If we needed to scale that dimension, the answer would be an LLM-as-judge with the standard controls (frozen golden trajectories, cap iterations, periodic human spot-checks) to dodge the self-preference bias.

> **Q: Why does the eval surface depend on the port-and-adapter pattern?**
>
> Because the agent classes need to be testable without changing their code. The `AnthropicModelProviderAdapter` and `BloomingToolRegistryAdapter` are constructor arguments to the AptKit agent classes; tests construct the same agent with `FakeModelProvider` and `InMemoryToolRegistry` instead. The agent doesn't know it's being tested — it calls `model.complete(...)` and `tools.callTool(...)` exactly as in production. Without this seam, you'd have to monkey-patch the Anthropic SDK or run integration tests against real services, both of which are slow and flaky. The port discipline is what makes 144 tests run in seconds.

## See also

- → `01-reasoning-patterns/02-agent-loop-skeleton.md` — the loop the tests exercise
- → `03-tool-calling-and-mcp.md` — the port the tests substitute behind
- → `05-guardrails-and-control.md` — the budget caps and validators the tests assert
- → cross-reference (when generated): `study-ai-engineering`'s evals sub-section — the output-quality eval methods and LLM-as-judge bias this file deliberately stays out of
- → cross-reference (when generated): `study-testing`'s test-organization file — the broader testing discipline these agent tests sit inside
