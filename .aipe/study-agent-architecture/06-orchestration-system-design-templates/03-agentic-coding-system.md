# Agentic coding / build system

A generic interview-style design template, reframed against this codebase. Nine bullets in the standard shape.

- **The prompt:** "Design an agent that completes a coding task across a repo — read, plan, edit, verify."

- **Standard architecture:** plan-and-execute (plan the changes, then execute per file) + verifier-critic (run tests / review the diff, loop on failure) + guardrails (scope the writable files, cap iterations):

```
  Standard agentic coding / build system

  ┌─ Retrieval over codebase ────────────────────────────────┐
  │  which files matter for the task (RAG over the repo)      │
  └─────────────────────────┬────────────────────────────────┘
                            ▼
  ┌─ Planner ────────────────────────────────────────────────┐
  │  expensive model; produces the plan: [{file, edit}, ...]  │
  └─────────────────────────┬────────────────────────────────┘
                            ▼
  ┌─ Executor (per file) ────────────────────────────────────┐
  │  cheap model; runs the edit per the plan                  │
  └─────────────────────────┬────────────────────────────────┘
                            ▼
  ┌─ Verifier ───────────────────────────────────────────────┐
  │  run tests / review diff / type check                     │
  └────────────┬────────────────────────────┬────────────────┘
               ▼ pass                       ▼ fail
            ship                       re-plan + loop
                                       (cap iterations)
```

- **Data model:** repo context (file tree, relevant files retrieved); the plan (list of edits with rationale); the diff (changed files + their new contents); test results (pass/fail per suite); an iteration counter (to enforce the loop cap).

- **Key components:**
  - **Retrieval over the codebase** — which files matter for this task (vector search over the code corpus)
  - **Planning** — generate the diff plan up front; expensive model, one call
  - **Execution** — apply the edits per file; cheap model, per-file calls
  - **Verification** — tests, type checks, diff review (LLM-as-judge or rule-based)
  - **The re-plan trigger** — on verification failure, loop back to planner with the failure as context
  - **Decision per component:** plan-and-execute vs pure ReAct for the edit loop (plan wins on multi-file tasks with predictable shape; ReAct wins on exploratory tasks where the model can't pre-commit)

- **Scale concerns:**
  - **Large repos blow the context budget** — can't fit the whole repo in the planner's prompt; need retrieval routing over the codebase (`../02-agentic-retrieval/03-retrieval-routing.md`)
  - **Long tasks blow the iteration cap** — multi-day refactors don't fit one agent run; need persistent task state across runs
  - **Cost per task** — planning + executing + verifying = many LLM calls; cheap-model executors are the main cost lever

- **Eval framing:**
  - **Task success** — tests pass; the agent's diff actually does what was asked
  - **Trajectory efficiency** — edits and re-plans to completion (fewer = better)
  - **Regression rate** — did the diff break something else that was passing

- **Common failure modes:**
  - Editing files outside scope (mitigation: scope the writable files in the executor's tool grant)
  - Plan assumptions breaking mid-execution (mitigation: the re-plan trigger on verification failure)
  - Verifier sharing the producer's blind spots (mitigation: different model family for the verifier — same insight as `../03-multi-agent-orchestration/05-debate-verifier-critic.md`)
  - Context loss across long tasks (mitigation: persistent state across runs — checkpoint the plan + the partial diff)

- **Applies to this codebase:** **No, not at all.** blooming insights is a data analyst, not a coding assistant. The codebase doesn't read files, doesn't write files, doesn't run tests, doesn't produce diffs. The tools the agents call are MCP analytics tools (`execute_analytics_eql`, etc.), not file-system or test-runner tools. The closest tangential overlap is the diagnostic agent's "generate hypotheses, test each" prompt — which is a soft plan-and-execute pattern at the prompt level, not an architecture. But the *output* is a Diagnosis JSON object describing why an ecommerce metric moved, not a code diff.

- **How to make it apply:** This is the template that doesn't naturally apply. Making it apply would mean building a *different product* — not an evolution of this one. If we hypothetically pivoted blooming insights into "an agent that writes the Bloomreach scenario configuration JSON for you and verifies it":
  1. **Retrieval over the corpus of past scenarios** — Bloomreach's existing scenarios as the "files" the agent reads; needs vector search.
  2. **A `ScenarioPlanner` agent** — given the diagnosis, plan the scenario edit (which triggers, which actions, which conditions).
  3. **A `ScenarioExecutor` agent** — render the planned edit as Bloomreach scenario config JSON.
  4. **A `ScenarioVerifier` agent** — run the proposed scenario through Bloomreach's validator API (if such an API exists); check for trigger overlap with existing scenarios.
  5. **Re-plan on validation failure** — feed the validator's errors back to the planner.

  This is a real adjacent product (and a credible one — it'd genuinely be useful for marketers). It's just not what blooming insights is today, and the refactor is closer to "build a different product on the same agent runtime" than "extend the current product."
