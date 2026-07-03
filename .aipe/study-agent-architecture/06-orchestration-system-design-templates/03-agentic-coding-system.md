# Agentic coding / build system

*System design template · plan-and-execute + verifier + guardrails*

- **The prompt:** "Design an agent that completes a coding task across a repo — read, plan, edit, verify."

- **Standard architecture:** plan-and-execute (plan the changes, then execute per file) + verifier-critic (run tests / review the diff, loop on failure) + guardrails (scope the writable files, cap iterations).

```
  input: task ("add rate limit to /api/x")
    │
    ▼
  ┌─────────────────────────────┐
  │  Retrieval over the codebase │  which files matter?
  │  (semantic + AST search)     │
  └──────────────┬──────────────┘
                 ▼
  ┌─────────────────────────────┐
  │  Planner (expensive model)   │  → plan = [step1, step2, ...]
  └──────────────┬──────────────┘
                 ▼
  ┌─────────────────────────────┐
  │  Executor per plan step      │
  │  (edits, cheap model)        │
  └──────────────┬──────────────┘
                 ▼
  ┌─────────────────────────────┐
  │  Verifier: run tests /       │
  │  review the diff             │
  └────────┬─────────────┬──────┘
           ▼ pass        ▼ fail
      commit / merge   re-plan (context ← test output)
                       loop (cap it)
```

- **Data model:** repo context (file tree, relevant files retrieved), the plan (structured — steps, dependencies, files to touch, expected changes), the diff (current changes), test results (which tests, which passed/failed, failure messages), an iteration counter (guards against re-plan-forever).

- **Key components:** retrieval over the codebase (which files matter — semantic search + AST-based reachability), planning (see `01-reasoning-patterns/04-plan-and-execute.md` — Sonnet for plan, Haiku for execute), execution (edits with scoped write permission), verification (tests / linter / review), the re-plan trigger on verification failure. Decision: plan-and-execute vs pure ReAct for the edit loop (structured tasks favor plan; open-ended tasks favor ReAct).

- **Scale concerns:** large repos blow the context budget (retrieval routing over the codebase — see `02-agentic-retrieval/03-retrieval-routing.md`); long tasks blow the iteration cap (budget ceiling + re-plan cap); cost per task (Sonnet planner + Haiku executor keeps this bounded); parallel edits to independent files (fan-out — see `03-multi-agent-orchestration/04-parallel-fan-out.md`).

- **Eval framing:** task success (tests pass; no regressions elsewhere); trajectory efficiency (edits and re-plans to completion — fewer is better); regression rate (did it break something else — golden test suite must stay green); code-review-style human eval on complex tasks; adversarial set (prompt-injected instructions in code comments should not hijack the agent).

- **Common failure modes:** editing files outside scope (guardrail: writable-files allowlist enforced at the tool layer, not the agent layer); plan assumptions breaking mid-execution (re-plan trigger with cap — same discipline as `01-reasoning-patterns/04-plan-and-execute.md`); verifier sharing the producer's blind spots (use a different model family or a hard test-run as the verifier — not another LLM); context loss across long tasks (agent memory tiers — see `04-agent-infrastructure/02-agent-memory-tiers.md`); infinite re-plan (cap the retries).

- **Applies to this codebase:** **no**. This repo is an analytics agent over a business workspace, not a coding agent over a repo. No file-editing tools exist; no plan-and-execute pattern is instantiated; no verifier-critic loop runs. The template is generic and not directly reflected in the codebase — it's presented so the reader can defend the pattern in an interview even when the codebase doesn't exercise it.

- **How to make it apply:** this would be a rebuild, not an extension — different product entirely. The load-bearing changes:

  1. **Different tool substrate.** MCP servers for file-system access, git, test runners, linters. This repo's swappable-MCP AuthProvider abstraction (`lib/mcp/auth-providers/`) would carry over — the pattern of "pluggable MCP + per-request config override" is the right shape for connecting to a codebase-editing MCP server. But the specific tool set is entirely different.

  2. **Plan-and-execute agent.** New file: `lib/agents/coding-agent.ts` that runs a two-phase loop (plan with Sonnet, execute with Haiku per step). aptkit doesn't ship this out of the box; would either wrap two aptkit agents or extend the base agent primitives.

  3. **Verifier via test suite, not LLM.** The verifier should be `npm test` — a hard signal, not an LLM opinion. The agent reads the failing tests, reasons about the failure, re-plans. This uses the same "feedback loop from tool result to agent reasoning" pattern the per-tool circuit breaker uses (`05-production-serving/03-per-tool-circuit-breaking.md`) — the test failure IS the observation.

  4. **Writable-files guardrail.** Scope enforced at the tool layer. New file: `lib/data-source/scoped-fs.ts` — a DataSource decorator that wraps the file-system MCP client and rejects writes outside a configured allowlist. Similar shape to what the `FaultInjectingDataSource` decorator does today.

The recurring pattern to notice: the *infrastructure* patterns in this guide (DataSource seam, AuthProvider abstraction, hooks, BudgetTracker, iteration caps, cancellation signals) all carry over to a coding agent. The *domain* (tool set, prompts, output shapes) is different. That's what makes this repo's infrastructure work portable — it's not tied to Bloomreach; it's the general shape any agent system needs.
