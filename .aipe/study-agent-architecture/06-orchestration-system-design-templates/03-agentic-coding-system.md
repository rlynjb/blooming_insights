# Agentic coding / build system

> The whiteboard prompt for an agent that completes a coding task across a repo — read, plan, edit, verify — mapped against blooming insights.

This file uses the **nine-bullet system-design-template shape** (not the per-concept study template). The first seven bullets are generic and hold for any repo; the last two are answered against blooming insights' real code.

---

**The prompt:** Design an agent that completes a coding task across a repo — read, plan, edit, verify.

**Standard architecture:**

```
       task description
              │
              ▼
   ┌──────────────────────────────┐
   │ Retrieval over the codebase  │  pick the files
   │ (file tree + relevant files) │  that matter
   └──────────────┬───────────────┘
                  ▼
   ┌──────────────────────────────┐
   │ Plan phase                   │  expensive model
   │ (expensive model)            │  produces the plan
   │ - list edits per file        │
   │ - identify dependencies      │
   └──────────────┬───────────────┘
                  │ plan
                  ▼
   ┌──────────────────────────────┐
   │ Execute phase                │  cheap model
   │ (cheap model, per file)      │  applies edits
   └──────────────┬───────────────┘
                  ▼
   ┌──────────────────────────────┐
   │ Verifier-critic              │  tests + review diff
   └──────┬────────────────┬──────┘
          │ pass           │ fail
          ▼                ▼
       commit         re-plan trigger
                      └────► loop back to plan
                            (cap iterations,
                             cap writable files)
```

The shape is **plan-and-execute with a verifier loop**: one expensive call decides the strategy, many cheap calls do the grunt work, a separate verifier runs the tests, and a re-plan trigger handles divergence. The control envelope is a writable-file allowlist + an iteration cap.

**Data model:**

- **Repo context** — the file tree (cheap) + a retrieved subset of file contents relevant to the task (expensive, scoped). Embedded into the planning prompt.
- **The plan** — `[{file, edit_kind, intent, dependencies}]`. The structured artifact that flows from plan to execute.
- **The diff** — incremental changes, per file. The verifier's input.
- **Test results** — pass/fail per test + stderr. The re-plan trigger's input.
- **Iteration counter + writable-file allowlist** — the control envelope state.
- **Run trace** — for debugging which step broke. Lets you re-run from any checkpoint.

**Key components:**

- **Codebase retrieval** — agentic RAG over the repo (the task is "which files matter"). Choice: live AST/symbol retrieval + targeted file reads, not pre-embedding the whole repo — repos change every commit, the embedding goes stale fast.
- **Planner** — expensive model, one call, structured-output plan. Choice: plan-and-execute over pure ReAct because the steps are knowable from the task description; pre-deciding the strategy means cheap execution per file and one expensive call total, not N expensive calls.
- **Executor** — cheap model, applies one edit per call. Choice: per-file isolation — one execution failure shouldn't drag down the others; the planner names dependencies so the executor knows the order.
- **Verifier-critic** — runs tests + reviews the diff. Choice: tests are the primary signal (objective); model review is the secondary signal (catches things tests don't). Use a *different* model family for the critic when possible — same-family critics share blind spots.
- **Re-plan trigger** — on verifier failure, hand the failure back to the planner with the diff and the test output. Choice: trigger only on verifier failure, not on every step — re-planning per step burns the cost win of plan-and-execute.
- **Writable-file allowlist** — the agent can read any file but only write the ones explicitly in scope. Choice: file-tier guardrail at the dispatch layer (your code refuses out-of-scope writes), not in the model prompt.

**Scale concerns:**

- **Context budget for large repos (hits first, at ~100k files):** the planning prompt has to fit the relevant files; even after retrieval, big repos blow the window. Mitigation: hierarchical retrieval (directory summaries first, then file-level, then line-level); only embed summaries, retrieve raw on demand.
- **Iteration cap blowup on long tasks (at ~10+ files of edits):** plan-and-execute degrades into re-plan churn when the task is genuinely hard. Mitigation: hard iteration cap, cost ceiling, and a fail-clean handoff at the cap ("here's what I tried, here's what's left") — never a silent loop.
- **Cost per task (at ~100 tasks/day):** the plan is one expensive call; execute is many cheap calls; verify is one or more model + test runs. The expensive parts are planner + verifier. Mitigation: cache the file-retrieval result within a task; reuse the same plan across small re-runs (don't re-plan on a one-character diff).
- **Test infrastructure cost (at scale):** every verify is a test run; if tests are 10 minutes, the verifier dominates wall-clock. Mitigation: scoped test runs (run only the tests touching changed files), with a full suite run only before the final commit.

**Eval framing:**

- **Task success (offline, golden tasks):** for a fixed set of repos + tasks, does the agent produce a diff whose tests pass? This is the headline.
- **Trajectory efficiency (offline):** edits per task, re-plans per task, tokens per task. Watch for the silent-regression mode where success rate stays flat but cost doubles.
- **Regression rate (offline):** of the tasks where the targeted tests pass, how many cause failures elsewhere? Mitigation: full-suite verification before commit.
- **Online:** human-approval rate (the human PR reviewer accepts vs rejects), revert rate (the commit got reverted within N days), cost per merged PR.
- **The trap:** golden-task success looks great while the real-world success rate is half that, because golden tasks are the well-shaped ones. Mix in messy ones — vague specs, partial repros, ambiguous failures.

**Common failure modes:**

- **Editing files outside scope** — agent decides a related file needs a touch. Mitigation: writable-file allowlist enforced at the dispatch layer, not in the prompt. If the agent emits a write to an out-of-scope file, refuse and feed the refusal back as an observation.
- **Plan assumptions breaking mid-execution** — the planner assumed file X has function Y; it doesn't. Mitigation: re-plan trigger fires when the executor reports a precondition violation; the planner re-reads the failing file and re-plans only the affected steps.
- **Verifier shares the producer's blind spots** — same model family critiquing its own output approves a bug it produced. Mitigation: different model family for the critic, plus *test results* (objective signal) as the primary verifier — model review is a backstop, not the gate.
- **Context loss across long tasks** — the agent forgets earlier decisions and contradicts itself across files. Mitigation: a structured plan held outside the conversation (passed as input to every executor call) instead of relying on the conversation to carry plan state.

**Applies to this codebase:** `no`. Blooming insights is not a coding agent and has no structural overlap with this template's task domain.

The repo is a Next.js app whose agents are **data analysts over an ecommerce workspace** (Bloomreach Engagement via OAuth MCP, or the authored `mcp-server-olist` over a seeded SQLite dataset). They call domain-shaped tools, read schemas, and emit typed insights and recommendations — they do not read source files, write source files, run tests, or open PRs. There is no codebase-retrieval layer (the only "code-aware" surface is the test suite for the agents themselves — 269 vitest tests across `test/` + `mcp-server-olist/test/` — and that's the developers' tool, not the agents'). Neither the Bloomreach MCP surface nor the three authored Olist domain tools (`get_metric_timeseries` / `get_segments` / `get_anomaly_context`) carry any coding affordance — no file read, no file write, no test runner, no shell.

The structural shape of this template — *plan → execute → verify, loop on failure* — does recur in blooming insights, but at a very loose analogy:

- "Plan" maps to the monitoring agent identifying which anomaly to investigate.
- "Execute" maps to the diagnostic agent gathering evidence.
- "Verify" maps to the human user reading the recommendation and deciding whether to enact it in Bloomreach.

That's a real architectural rhyme, but the substrates have no overlap — the coding template's data model is files and diffs and tests; blooming insights' data model is EQL queries and aggregated metrics. The decisions, the guardrails, and the failure modes are different in kind, not degree.

This template is included because the spec requires all three templates in every guide. Blooming insights' relationship to it is **structurally distant — the plan/execute/verify shape recurs, but the task domain has no overlap.**

**How to make it apply:** **out of scope.** This template is a deliberate hold for completeness. Inventing a coding-agent refactor for blooming insights would be product-fiction; the codebase has no reason to become a coding agent, and the existing pipeline is not a stepping-stone toward one.

If the reader wants the blooming-insights-shaped agentic system reframed, the relevant templates are:

- `01-multi-agent-research-assistant.md` — the closest structural match (gather-then-synthesize, sequential pipeline, single source).
- `02-agentic-support-system.md` — the closest if blooming insights were to start *acting* in Bloomreach instead of just suggesting actions.

This file stays as the "what an agentic coding system looks like, for cross-pattern fluency" reference, not a refactor target.

---
