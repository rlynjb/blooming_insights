# RFC-003: Deterministic supervisor in code — not an LLM supervisor, not a framework

**Status:** Accepted (implemented)
**Owner:** rein
**Decision:** blooming insights is multi-agent (four agents: monitoring, diagnostic, recommendation, query), each its own ReAct loop with its own prompt, tool subset, and budget. The supervisor that decides *which agent runs next* is a TypeScript `if`-ladder in `app/api/agent/route.ts`, not an LLM, not a framework. The control flow between agents is owned by code; the control flow inside each agent is owned by the model.

---

## Context

The product runs an investigation in three stages:

1. **Monitoring** scans the workspace's last 90 days against a 10-category anomaly checklist, producing insights.
2. **Diagnostic** takes one insight and runs a tool-using agent loop to produce a typed `Diagnosis` (`conclusion`, `evidence[]`, `hypothesesConsidered[]`).
3. **Recommendation** takes the `Diagnosis` and proposes typed actions.

The order is fixed by data dependency: stage N+1 cannot start without stage N's typed output. The investigation page enforces it with a two-step UX (step 2 = diagnose, step 3 = recommend), with the user clicking through.

Two separate concerns sit at the multi-agent boundary:

- **The work inside each stage** is non-deterministic. The model decides which tools to call, how many turns to use, when to stop. That's a ReAct loop; the model owns control.
- **The order between stages** is deterministic. Code decides. There's no run where monitoring goes second, or where diagnostic skips. The path is known up front.

The decision is about that second concern: who owns the order. The frame of 2026 makes a default visible — "make it multi-agent with a supervisor" via LangGraph / CrewAI / Autogen / a custom orchestrator agent is the path of least typing. This RFC explains why we did the simpler thing on purpose.

Implementation: `app/api/agent/route.ts:196-254` (the `if`-ladder + the pipeline calls), `lib/agents/base.ts:48-176` (the shared per-stage ReAct loop), `lib/agents/diagnostic.ts` / `lib/agents/recommendation.ts` / `lib/agents/monitoring.ts` / `lib/agents/query.ts` (the per-stage definitions), `lib/agents/intent.ts:14` (Haiku for cheap classification, Sonnet everywhere else).

---

## Goals

- The four agents stay genuinely independent — separate prompts, separate tool subsets, separate budgets — so each can be tuned and tested in isolation.
- The order between them is debuggable by reading code. No "the supervisor decided" mystery in production logs.
- Adding a stage is a code change to one file (the route). Removing a stage is a code change to one file. Reordering is the same.
- Total cost per investigation is bounded by per-stage budgets, not by a supervisor's variable reasoning over how many stages to run.
- Test the orchestration end-to-end without an Anthropic API key. The deterministic supervisor is just `if`s.

## Non-goals

- A general-purpose agent platform. We are not building a framework for arbitrary agent compositions.
- LLM-decided routing between agents. The day a stage's output should *choose* the next stage (not "the next stage", "a next stage from N options") is the day this RFC has a successor.
- A workflow engine. No persisted state machine, no human-in-the-loop checkpointing, no pause/resume across days. Investigations run to completion in one request (or split into two by the `step=` param).
- Cross-stage parallelism. Stages are strictly sequential because the data dependency demands it. No fan-out today.

---

## The decision

```
  ┌─ Route handler (the deterministic supervisor) ───────────────────────┐
  │  app/api/agent/route.ts                                              │
  │                                                                      │
  │  const leadAgent: AgentName =                                        │
  │    q && !insightId      ? 'coordinator'      // free-form query flow │
  │    : step === 'recommend' ? 'recommendation'  // step 3              │
  │                           : 'diagnostic';     // step 2 (default)    │
  │                                                                      │
  │  if (q && !insightId) { /* QueryAgent path */ }                      │
  │                                                                      │
  │  if (step !== 'recommend') {                                         │
  │    diagnosis = await diagAgent.investigate(inv, hooks);              │
  │    send({ type: 'diagnosis', diagnosis });                           │
  │  }                                                                   │
  │                                                                      │
  │  if (step !== 'diagnose') {                                          │
  │    recommendations = await recAgent.propose(inv, diagnosis, hooks);  │
  │    for (const r of recommendations) send({ type: 'recommendation' });│
  │  }                                                                   │
  │                                                                      │
  │  send({ type: 'done' });                                             │
  └──────────────────────────────────┬───────────────────────────────────┘
                                     │
  ┌─ Per-agent definitions (each is a ReAct loop) ──────────────────────┐
  │  monitoring.ts │ diagnostic.ts │ recommendation.ts │ query.ts        │
  │                                                                      │
  │  Each defines:                                                       │
  │    - its system prompt                                               │
  │    - its tool subset (from the full MCP surface)                     │
  │    - its maxToolCalls budget   (monitoring 6, diag 6, rec 4, query 6)│
  │    - its synthesisInstruction  (forced-final turn copy)              │
  │    - its typed output schema   (Anomaly, Diagnosis, Recommendation)  │
  └──────────────────────────────────┬───────────────────────────────────┘
                                     │
  ┌─ Shared ReAct loop (lib/agents/base.ts:48-176) ─────────────────────┐
  │  runAgentLoop({ anthropic, mcp, system, userPrompt, toolSchemas,    │
  │                 maxTurns, maxToolCalls, synthesisInstruction, ... }) │
  │                                                                      │
  │  while (turn < maxTurns) {                                          │
  │    response = anthropic.messages.create(messages + toolSchemas)     │
  │    if (no tool_use blocks)  break  // natural stop                  │
  │    for each tool_use: result = mcp.callTool(...); append            │
  │    if (totalToolCalls >= maxToolCalls) force-synthesis-turn         │
  │  }                                                                  │
  └─────────────────────────────────────────────────────────────────────┘
```

The supervisor is the `if`-ladder. It is 6 lines. It encodes one fact: the order is `monitoring → diagnostic → recommendation`, with `query` as a separate single-stage path for free-form questions.

The decomposition is real. Each agent has a different prompt (`lib/agents/prompts/`), a different tool subset (`lib/mcp/tools.ts` exposes per-agent filtering), a different budget (`maxToolCalls: 6/6/4/6`), and a different output schema. They share the loop, not the configuration.

The classifier intent agent (`lib/agents/intent.ts:14`) uses Claude Haiku 4.5 instead of Sonnet 4.6 — same "pay only for what the job needs" instinct, applied at the per-call level. Classification doesn't need Sonnet-grade reasoning.

---

## Alternatives considered

### Alternative A: LLM supervisor agent (the LangGraph / CrewAI shape)

A supervisor agent that, after each stage, reasons about which stage should run next. The supervisor sees each worker's output and decides the next move.

**Why it lost:**

The decision the supervisor would make is *already known* at code-write time. The order is `monitoring → diagnostic → recommendation`. There is no run where the supervisor could plausibly choose differently with the information it has. Paying an LLM call per inter-stage decision to re-derive a fact that's in source code is the textbook 2-5x coordination tax for zero benefit.

```
  Deterministic route (chosen)         LLM supervisor (rejected)
  ─────────────────────────            ─────────────────────────
  if-ladder picks next stage           supervisor reasons each stage
  0 LLM calls for ordering             1 LLM call per stage decision
  4 worker LLM calls per run           4 worker + N supervisor calls
  ~$0.10 per investigation             ~$0.20-0.50 per investigation
  log says: "ran diagnostic"           log says: "supervisor chose diagnostic
                                       because <reasoning>" — useful only if
                                       the choice was non-trivial
```

The honest version: a supervisor earns its keep when the *next stage depends on what the previous stage discovered*. Ours doesn't. If a diagnosis comes back inconclusive, we don't route to a different specialist — we move to recommendation anyway and let the user decide. The day we want adaptive routing, the supervisor earns its overhead. Until then, it doesn't.

Secondary costs of the supervisor pattern that came up:

- **Debuggability.** A failed investigation in production says "the supervisor chose X" — which requires re-running the supervisor's prompt against logged context to understand. With code, the choice is one git blame away.
- **Non-determinism in tests.** Every test of orchestration needs to mock or accept the supervisor's choices. With `if`s, the tests check `if` outputs directly.
- **Coordination context window.** A supervisor that sees each worker's full output has to re-process those tokens on every decision. Tokens cost money and add latency. The deterministic route processes them once (in the next stage's prompt).

### Alternative B: Single mega-agent with all tools

The "why decompose at all" answer. One agent, one system prompt, the full union of all four agents' tools, one big budget.

**Why it lost:**

The original shape, before decomposition. It failed in three specific ways:

1. **Tool budget contention.** With ~12 tools and a 6-call budget, the agent often spent all 6 on diagnostic-style tool calls and never reached recommendation-style synthesis. Different sub-jobs starved each other for the shared budget.
2. **Prompt length blowup.** One system prompt covering "monitor → diagnose → recommend" was long enough that the model lost the structure of the task — it would conflate the diagnosis with the recommendation, output unstructured text, or skip stages.
3. **Schema mixing.** The single output had no clean type. Was it a diagnosis? A list of recommendations? Both? The downstream UI had to parse heuristically.

Each of those is a *structural* failure that no amount of prompt tuning fixes. They are what earned the decomposition. The deterministic supervisor + per-stage isolation is the topology that addresses *those specific failures*.

This alternative is the "did we even need multi-agent?" check. The answer was yes — but yes for *structural* reasons, not because the routing was hard.

### Alternative C: LangGraph (or equivalent framework)

Adopt a framework that wires graph-shaped agent orchestration, persists checkpoints, handles human-in-the-loop, gives you observability primitives, etc.

**Why it lost:**

- Pulls in a dependency the size of the rest of the agent code combined. For an `if`-ladder of 3 cases, that's overkill.
- The framework's primitives (graphs, channels, checkpointers) are designed for use cases more complex than ours. Their value scales with graph complexity; ours is a line.
- Vendor lock on the orchestration shape. If we want to move the supervisor to code (which we did, deliberately) the framework gets in the way.
- The "you'll need it eventually" argument has not happened. When it does, this RFC gets a successor. Until then, we're paying maintenance and learning-curve cost for capability we don't use.

There is a real version of this story where a team with 8 engineers and 12 agents adopts LangGraph and benefits. That is not us.

### Alternative D: Swarm / handoff (peer agents transferring control)

OpenAI's Swarm and similar designs: agents are peers, any agent can hand control to any other based on data.

**Why it lost:**

- We don't have peer specialists in the swarm sense. We have a fixed pipeline of single-purpose agents. The shape doesn't match.
- The control-transfer pattern earns its keep when the *next agent's identity* depends on runtime data the engineer can't predict — a triage system with 20 sub-specialists, for example. Our pipeline has 3 stages in a known order.
- Swarm patterns make individual agent prompts more complex (each agent has to know about every other agent it could hand to). That's coupling we don't want.

```
  Alternatives matrix

  option                routing-cost   debuggability   adaptive?   chosen?
  ──────────────────    ────────────   ─────────────   ─────────   ───────
  if-ladder (code)      $0             high            no          ★
  LLM supervisor        $0.05-0.20/run medium          yes         no (we don't need adaptive)
  single mega-agent     $0             low (tangled)   no          no (the failure that forced decomposition)
  LangGraph framework   $0             framework-dep   yes         no (overkill for 3 stages)
  swarm / handoff       $0.05/handoff  medium          yes         no (no peer-handoff use case)
```

---

## Tradeoffs accepted

We chose the deterministic `if`-ladder, accepting:

1. **No adaptive routing.** If a diagnostic conclusion is "inconclusive — need more data", we don't auto-route to a deeper specialist. The user re-runs or moves on. *We accept this — the deeper-specialist agent doesn't exist yet, and inventing it requires also inventing the routing logic.*

2. **The route file is the supervisor.** It's not labeled as such. A new engineer reading the codebase might miss that the orchestration happens in 6 lines of `if`s, not in a file called `pipeline.ts`. *We accept this — the comment at `app/api/agent/route.ts:196-200` flags it.*

3. **Adding a stage means editing the route.** Not a generic `pipeline.add(stage)` call, an actual code change with a code review. *We accept this — it makes the supervisor changes visible in git, which is what we want for orchestration changes.*

4. **The Combined Run (`step=null`) vs Split Steps (`step=diagnose|recommend`) duality.** The same supervisor handles both: Combined Run does both stages in one request (used for the demo-capture path), Split Steps does one per request (production). *We accept this — collapsing them would re-introduce the 115s-in-one-request shape we deliberately moved off of (RFC-002 covers the streaming side).*

5. **Cross-request typed handoff via `sessionStorage` + URL param.** Because the supervisor lives in the route and the two split steps are two separate requests, the typed `Diagnosis` from step 2 has to travel through the browser's `sessionStorage` to be handed in as a URL param on step 3 (`app/api/agent/route.ts:222-240`, `parseDiagnosis`). *We accept this — the alternative is server-side investigation state, which RFC-001 ruled out.*

6. **No supervisor reasoning logs.** Production logs say "ran diagnostic, then recommendation." They don't say *why*. Because the why is "because the code says so." *We accept this — the trade is "structured production logs with no LLM in them" vs. "less-structured logs with LLM reasoning we don't actually need to debug."*

---

## Risks and mitigations

| Risk | Severity | Mitigation |
|------|----------|------------|
| Hidden coupling between stages bleeds into the supervisor (e.g., recommendation needs context only diagnostic generated) | Medium | The typed `Diagnosis` is the only allowed inter-stage carrier. New cross-stage data demands a new field on `Diagnosis` (visible in the type), not a side-channel. |
| Engineer adds a new stage in the wrong order | Low | The route's `if`-ladder is short and reviewed. A misordering would fail the `parseDiagnosis` check at the recommend step. |
| Per-stage `maxToolCalls` budget tuned wrong → forced synthesis fires too early or too late | Medium | Tunable per-stage (`lib/agents/base.ts:60-61, 86-90`). Adjusted based on real runs; current values (6/6/4/6) reflect observed agent behavior. |
| `lib/agents/intent.ts` Haiku-vs-Sonnet split drifts (Sonnet sneaks into classification, or Haiku gets used for reasoning) | Low | One constant (`CLASSIFIER_MODEL` at `lib/agents/intent.ts:14`), one constant (`AGENT_MODEL` at `lib/agents/base.ts:9`). Grep-visible. |
| `step=null` Combined Run path bit-rots (used only by demo-capture) | Medium | Test coverage at `test/agents/*.test.ts`; cache-replay path exercises the full event sequence on every demo. |
| The cross-request `sessionStorage` handoff fails (the user navigates between tabs, the storage gets wiped) | Medium | The recommend step throws "no diagnosis was handed over — open the diagnosis step first" (`app/api/agent/route.ts:228-230`). The error is honest; the UX guides the user back to step 2. |
| We outgrow the if-ladder shape | Future | RFC successor when the route file has >3 cases or any case depends on runtime data. The trigger is named, not theoretical. |

---

## Rollout / migration

Day-one shape. The interesting migration that already happened: the original single mega-agent was decomposed into four single-purpose agents *before* the route was wired as a supervisor — i.e., decomposition first (to fix the structural failures), then deterministic supervision (because adaptive supervision wasn't needed). The route was always code.

The recent migration that matters: the introduction of the `step` query param (`app/api/agent/route.ts:117-118`) that splits the combined diagnose+recommend run into two requests. The supervisor's logic gained a new dimension (`if step === 'recommend'` vs `if step !== 'diagnose'`) but stayed in the same shape — `if`s in one file. The classifier-model split (Haiku for intent, Sonnet for reasoning) was a similar code-level decision, not a framework adoption.

---

## Open questions

1. **When does the `if`-ladder stop scaling?** When the route file has >3 cases or any case depends on runtime data the supervisor couldn't know up front. Today we have 3 cases (query flow, recommend flow, default diagnostic flow). The trigger for the next RFC is the day a stage's *output* needs to change which stage runs next.

2. **Should monitoring run inside the same request as diagnostic?** Today monitoring runs in `/api/briefing` (producing the insight feed) and diagnostic runs in `/api/agent` (one-insight-at-a-time, on user click). They're sequential in time but not in request shape. The user gate between them is the click. This is the right shape for the product (a 10-category briefing doesn't auto-investigate every anomaly — too expensive); flagged here because it's the kind of decision a reviewer asks about.

3. **Per-stage retry policy.** The shared loop's `runAgentLoop` retries individual tool calls (via `McpClient`'s retry logic) but doesn't retry the whole agent on a soft failure. If a diagnostic returns an empty `conclusion`, we don't auto-re-run it. Open whether we should.

4. **Forced-synthesis turn behavior.** When `maxToolCalls` is hit (`lib/agents/base.ts:90`), the loop forces the model to synthesize a final answer from what it has so far. The `synthesisInstruction` per stage shapes this. Quality of forced-synthesis answers vs. natural-stop answers is uneven; tuning is per-stage trial-and-error. Worth more rigorous eval.

5. **Cross-agent observability.** Each agent emits its own reasoning steps and tool calls (via `hooksFor(agent)` at `app/api/agent/route.ts:181-195`). There's no global "trace ID" linking the diagnostic and recommendation phases of one investigation — they're correlated by `insightId` only. Probably fine; flagged for the future.

---

## What a reviewer will push on (and the framing that holds)

> "Why didn't you use LangGraph / CrewAI / [framework]?"

The framework's primitives solve coordination problems we don't have. Three stages in a known order is an `if`-ladder, not a graph. Adopting the framework would cost a dependency and a learning curve for capability we don't use. The day we have a graph (or 12 agents, or adaptive routing), the trade flips.

> "Isn't this just a workflow? Why call it multi-agent?"

The cross-stage control is workflow-shaped (code-owned, fixed order). The within-stage control is agent-shaped (model-owned, variable). Both are true. The boundary between them is the load-bearing detail — work-inside-stage is non-deterministic enough that you need an agent loop; order-between-stages is deterministic enough that you don't.

> "What if a diagnosis comes back inconclusive — shouldn't a supervisor route to a deeper specialist?"

That deeper specialist doesn't exist. Inventing the routing logic without inventing the specialist is putting up scaffolding for a building we haven't designed. The day we have multiple diagnostic specialists with overlapping competence, this RFC has a successor. Until then, "inconclusive" is shown to the user, who decides.

> "You're hand-rolling orchestration. That doesn't scale."

It scales to ~3 stages and ~1 engineer. It would not scale to 20 stages and a team — but that's not the workload. The deterministic shape is the right point on the cost ledger for this specific problem. The framework shape is the right point for a *different* problem.

> "The `if`-ladder is fragile. One typo and the wrong agent runs."

The test suite covers it (`test/agents/*.test.ts` — 169 tests, none require an API key thanks to RFC-N+1 on provider abstraction). The supervisor's choices are deterministic, so testing them is testing `if` branches, not "what did the LLM decide this time."

---

## References

- `app/api/agent/route.ts:196-200` — the `leadAgent` `if`-ladder (the supervisor)
- `app/api/agent/route.ts:210-218` — the query-flow branch (one-agent path)
- `app/api/agent/route.ts:224-249` — the investigation pipeline (diagnostic → recommendation)
- `app/api/agent/route.ts:222-240` — the cross-request `Diagnosis` handoff via `parseDiagnosis(diagnosisParam)`
- `lib/agents/base.ts:9` — `AGENT_MODEL = 'claude-sonnet-4-6'` (everywhere except classification)
- `lib/agents/base.ts:48-176` — the shared `runAgentLoop` (what every stage runs inside)
- `lib/agents/base.ts:60-61, 86-90` — `maxToolCalls` + forced-synthesis turn
- `lib/agents/intent.ts:14` — `CLASSIFIER_MODEL = 'claude-haiku-4-5-...'` (the cheap-model split)
- `lib/agents/diagnostic.ts`, `recommendation.ts`, `monitoring.ts`, `query.ts` — per-stage definitions
- `lib/mcp/tools.ts` — per-agent tool subset filtering
- `.aipe/study-agent-architecture/03-multi-agent-orchestration/01-when-not-to-go-multi-agent.md` — deeper teaching guide on the escalation gate
- `.aipe/study-agent-architecture/03-multi-agent-orchestration/03-sequential-pipeline.md` — deeper teaching guide on the topology we chose
- Anthropic, "Building Effective Agents" (2026) — the canonical reference for "don't auto-route what you can hand-route"

---

**Updated:** 2026-06-03 — no architectural drift. The recon and cleanup audits surfaced eval / observability gaps (no LLM eval; `res.usage` dropped on the floor at four call sites; no phase-timing on the 300s budget) that are real but live in the cleanup-and-readiness layer, not the supervisor decision. The supervisor's `if`-ladder remains the right shape; the gaps are additive instrumentation, not RFC-worthy reversals.
