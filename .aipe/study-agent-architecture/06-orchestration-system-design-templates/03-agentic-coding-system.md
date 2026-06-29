# Agentic coding / build system

A system-design template. Generic structure, applied to this codebase.

- **The prompt:** "Design an agent that completes a coding task across a repo — read, plan, edit, verify."

- **Standard architecture:** plan-and-execute (plan the changes, then execute per file) + verifier-critic (run tests / review the diff, loop on failure) + guardrails (scope the writable files, cap iterations).

```
                        coding task
                            │
                            ▼
                   ┌─ Planner agent (Sonnet) ───────┐
                   │  reads repo context (file tree,│
                   │   relevant files via retrieval)│
                   │  emits structured plan:        │
                   │   [step: edit file X, step:    │
                   │    add test, step: ...]        │
                   └────────────┬───────────────────┘
                                ▼
                   ┌─ Executor (Haiku per step) ────┐
                   │  reads the step + plan context │
                   │  emits a diff for one file     │
                   │  applies via filesystem tool   │
                   └────────────┬───────────────────┘
                                ▼
                   ┌─ Verifier (test runner / lint) ┐
                   │  runs tests; if fail, loops    │
                   │   back to planner with the     │
                   │   failure as new context        │
                   └────────────┬───────────────────┘
                                │
                       ┌────────┼────────┐
                       ▼ pass            ▼ fail (under iter cap)
                  Diff ready         Re-plan with the
                  for review         failure context
                                       │
                                       └── back to planner
```

- **Data model:** repo context (file tree, relevant files retrieved by similarity or pattern), the plan (structured steps with dependencies), the diff (per-file changes the agent has applied), test results (pass/fail with failure messages), an iteration counter.

- **Key components:** retrieval over the codebase (which files matter for this task — a vector store of file contents, or grep-based retrieval), planning (the expensive model decides the strategy), execution (the cheap model applies one step at a time), verification (test runner, linter, or a reviewer agent), the re-plan trigger when verification fails. Decision: plan-and-execute vs pure ReAct for the edit loop (plan-and-execute for tasks with knowable steps; ReAct for exploratory tasks).

- **Scale concerns:** large repos blow the context budget (retrieval routing over the codebase is required; can't stuff every file). Long tasks blow the iteration cap (a 50-file refactor needs a budget far above ReAct's 8 turns). Cost per task can spike on complex tasks (verifier reruns + re-plans compound).

- **Eval framing:** task success (tests pass post-edit), trajectory efficiency (number of edits and re-plans to completion), regression rate (did the edit break something else). Coding-agent eval is unusual because the test runner IS the verifier — you get a strong correctness signal for free that other domains have to manufacture.

- **Common failure modes:** editing files outside the intended scope (the agent edits package.json when it shouldn't; mitigation: scope the writable-files allowlist). Plan assumptions breaking mid-execution (a step's expected output doesn't match what came back; re-plan trigger fires). Verifier sharing the producer's blind spots (the test the agent wrote is the test the agent's code passes — same self-preference bias). Context loss across long tasks (the agent forgets earlier file edits as the conversation grows).

- **Applies to this codebase:** **no.** This repo isn't a coding agent. There's no codebase being edited by an agent, no test-runner verifier, no diff application. The agents in this repo read analytics data and propose actions; they don't write code.

- **How to make it apply:** the refactor would be a full rewrite into a different product. None of the existing agent classes (`MonitoringAgent`, `DiagnosticAgent`, `RecommendationAgent`, `QueryAgent`) apply to coding-agent shape. A new agent stack would need:

  1. **A different tool surface.** The MCP server would expose filesystem and code-execution tools — `read_file(path)`, `write_file(path, content)`, `run_tests()`, `git_diff()`, `apply_patch(diff)`. The current Bloomreach MCP server has none of these. You'd run against a different MCP server (e.g. a filesystem MCP) or build a custom tool registry.

  2. **A retrieval layer over code.** Either grep-based retrieval (cheap, brittle) or a vector store of embedded file contents (expensive, better). The current `BloomreachDataSource` doesn't apply — code retrieval is a different substrate.

  3. **A different orchestration pattern.** Plan-and-execute is the canonical choice for coding agents because the path is knowable (read → plan → edit → verify → repeat). The current deterministic pipeline doesn't transfer; you'd build a new orchestration shape from scratch.

  4. **A different control envelope.** The action-safety story for a coding agent is much harder than for this repo's read-and-propose pattern. The agent IS editing files; the worst case is "agent edits production code in a way that ships a bug." Mitigations: writable-files allowlist (the agent can only touch files in a scoped path), required-tests-pass gate (no diff applies without tests green), git-branch isolation (the agent works on a branch, not main), human-approval-before-merge.

  The honest reality: pivoting blooming_insights into a coding agent would mean throwing out the entire product surface and starting over with the agent framework (`@aptkit/core`, the route handler shape, the NDJSON streaming) intact as the *substrate*. Cursor, Cline, Claude Code, Devin — these are the existing instances of this template. The right escalation path for the team would be "build a separate product if this is what we want to ship; don't repurpose the analytics one."

  The template is included for completeness because the spec ships all three regardless of fit. The exercise of confirming "no, this doesn't apply, here's why" is itself the interview signal — you've recognized when a template doesn't apply rather than forcing it.
