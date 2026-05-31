# Coordination failure modes

**Industry name(s):** Coordination failure modes, multi-agent failure taxonomy, the "2-5x overhead" failures
**Type:** Industry standard · Language-agnostic

> The failures that don't exist in single-agent systems. Walk the table and show which ones blooming insights' design PREVENTS structurally vs CONTROLS with mechanisms. Thesis: deterministic orchestration buys you fewer failure modes — infinite handoff and synthesis failure are structurally absent because no autonomous handoff and no LLM merge exist.


---

## Why care

### Move 1 — the scenario (lead with the shape — the failure table)

```
The coordination failure table

  Failure                       Mitigation
  ────────────────────────      ─────────────────────────────
  Infinite handoff              handoff counter (MAX_HOPS),
   (A→B→A→B…)                    force stop or human escalate
  Tool-call cascade             per-agent + global iteration
   (one agent triggers a         caps; budget ceiling that
    storm of calls)              halts the run
  Context bloat (shared          message passing / context
    state grows with N agents)   routing instead of blackboard
  Synthesis failure             validate worker outputs vs
   (supervisor merges            schema; surface conflicts,
    contradictory results)       don't average them
  Cost blowup                   per-run token budget; cheap
   (2-5x overhead compounds      models for workers, expensive
    silently)                    only for supervisor
  Token-revocation mid-run      one-time guarded auto-reconnect
   (MCP auth expires during      (per-tab, gated by
    a live agent run)            sessionStorage flag)
```

You've added a second `useEffect` to a React component. The first effect listens to state A; the second listens to state B. The second effect sets state A. The first effect now fires again, which sets state B. Now the second effect fires again, which sets state A. The browser tab hangs. You forgot the dependency array.

That's the same shape as half the multi-agent failures. Two agents that defer to each other, two stages that loop forever, a context that grows without bound, a synthesis that averages contradictions — all variants of "I forgot to constrain the loop." Multi-agent systems introduce new loops the single-agent shape doesn't have, and each new loop is a new failure mode you have to either *prevent structurally* or *control with a mechanism*.

### Move 2 — name the question

That cluster of failures — the ones that only exist when more than one agent is in play — is what this file names. The question this file answers: **which multi-agent failure modes does blooming insights' design prevent by being deterministic, and which ones does it control with explicit mechanisms?**

The two categories matter. *Structural prevention* is when the failure can't happen because the system shape doesn't allow it (e.g. no infinite-handoff because no agent can hand off). *Control mechanism* is when the failure could happen but a specific mechanism caps it (e.g. tool-call cascade prevented by `maxToolCalls` caps).

### Move 3 — why answering that question matters

**Why you need to answer that question at all:** because the multi-agent failure cluster is where the "2-5x overhead" of multi-agent systems comes from — not just in tokens, but in debugging time, on-call burden, and silent quality degradation. A team that adopts multi-agent without naming the failures ships them all, then debugs them one production incident at a time.

In this codebase: the deterministic orchestration choice (cross-ref `./01-when-not-to-go-multi-agent.md`) eliminates entire categories of failure. There's no LLM supervisor → no synthesis failure. There's no peer handoff → no infinite handoff. There's no shared blackboard → no context bloat from inter-agent state accumulation. The failures the codebase still has to control (tool-call cascade, cost blowup, token revocation) get explicit mechanisms in code.

The thesis this file argues: **deterministic orchestration buys you fewer failure modes — not by being less powerful, but by structurally not allowing the failures autonomous coordination introduces.**

### Move 4 — concrete walk-through

An "all-the-failures-active" system (a hypothetical alternative):
- LLM supervisor + handoffs + shared state + LLM merge
- Production incidents: supervisor mis-orders stages (synthesis failure), two peer agents deferr to each other (infinite handoff), cost spikes 5x in a day (cost blowup), context grows past 100k tokens mid-run (context bloat)
- Each incident requires its own mitigation: handoff counter, supervisor prompt tuning, budget caps, summarization
- The team's on-call is 20 hours/week on these specific failure modes

blooming insights:
- Deterministic route, sequential pipeline, message passing, no LLM merge
- Structurally absent: infinite handoff (no agent emits handoff), synthesis failure (no LLM merger), context bloat (no shared state)
- Controlled with mechanisms: tool-call cascade (`maxToolCalls` caps 6/6/6/4 + forced final), cost blowup (Haiku classifier + per-stage budgets), token-revocation (one-time guarded auto-reconnect)
- On-call: minutes per week on these failure modes, because most can't happen

### Move 5 — one-line summary

The coordination failure cluster is where multi-agent systems silently lose 2-5x to their single-agent baselines; blooming insights' deterministic orchestration structurally prevents half of them (no handoff = no infinite handoff; no LLM merge = no synthesis failure; message passing = no shared-state bloat) and controls the remaining ones with explicit mechanisms anchored to specific code. Here's the table, walked.

---

## How it works

**The mental model: every multi-agent failure is "I forgot to constrain a loop or a budget."** The question is whether you constrain it structurally (the loop doesn't exist) or mechanically (the loop has a cap). Deterministic orchestration is the structural answer; budgets and counters are the mechanical answer.

```
Two ways to bound a failure

  STRUCTURAL                       MECHANICAL
  ──────────────────               ─────────────────────
  the failure can't happen         the failure CAN happen
   because the system shape         but a specific mechanism
   doesn't allow it                 caps it before it explodes
  no LLM supervisor →              tool-call cascade → maxToolCalls cap
   no synthesis failure            cost blowup → per-stage budget +
  no peer handoff →                 Haiku classifier
   no infinite handoff             token-revocation → one-time guarded
  no shared blackboard →             auto-reconnect
   no shared-state bloat
```

The strategy in plain English: **prefer structural prevention; fall back to mechanical control.** Structurally prevented failures cost zero debugging time because they can't happen. Mechanically controlled failures need watchful mechanisms — caps, budgets, retries — that you can grep for in the code.

### Layer 1 — Tool-call cascade (controlled mechanically)

The technical thing: an agent loop emits more tool calls per turn or stays in the loop longer than you intended, burning the budget on calls instead of arriving at an answer. The single-agent shape (cross-ref `../../study-ai-engineering/04-agents-and-tool-use/01-agents-vs-chains.md`) has this risk; multi-agent amplifies it (N agents, N times the risk).

The mitigation in blooming insights: a *hard `maxToolCalls` cap per agent* plus a *forced-final-turn mechanic* in `runAgentLoop` (`lib/agents/base.ts` L90–L101).

```
The mechanism (base.ts L90–L101)

  for (let turn = 0; turn < maxTurns; turn++) {
    const budgetSpent = maxToolCalls !== undefined
      && toolCalls.length >= maxToolCalls;
    const forceFinal = turn === maxTurns - 1 || budgetSpent;
    const params = { ... };
    if (!forceFinal) params.tools = toolSchemas;
    //              ▲ tools STRIPPED on forced-final
    //              ▲ model literally cannot emit more tool calls
    const res = await anthropic.messages.create(params);
    ...
  }
```

Per-agent caps:
- monitoring: `maxToolCalls: 6` (`monitoring.ts` L101)
- diagnostic: `maxToolCalls: 6` (`diagnostic.ts` L62)
- recommendation: `maxToolCalls: 4` (`recommendation.ts` L57)
- query: `maxToolCalls: 6` (`query.ts` L41)

The practical consequence: the cascade is *structurally impossible past the cap*. Once the budget is spent, the loop strips tools from the API request — the model literally cannot emit another tool_use. It's forced to emit text. The cascade can't run longer than the cap allows.

The condition under which this works: the cap is set conservatively. 6 turns is enough for the diagnostic agent's typical 3–5 EQL investigation; 4 is enough for the recommendation agent's typical 2–3 feature lookups. If a future agent's job genuinely needed 12 turns, the cap would need to be raised — at the cost of larger blast radius if the cascade fires.

### Layer 2 — Cost blowup (controlled mechanically)

The technical thing: the 2-5x token overhead of multi-agent systems compounds silently — each agent's prompt, each turn, each tool call carries cost; multiple agents per run multiplies it.

The mitigation in blooming insights: a *mixed-model strategy* (cheap classifier, expensive workers) plus *bounded per-stage budgets*.

```
Mixed-model + bounded budgets

  intent classifier:  Haiku (~$0.25/MTok input)
   lib/agents/intent.ts L14: 'claude-haiku-4-5-20251001'
   one call per query; ~150ms; tiny prompt

  agent workers:      Sonnet (~$3/MTok input)
   lib/agents/base.ts L9: 'claude-sonnet-4-6'
   bounded by maxToolCalls per stage:
     monitoring     6 turns max → ~$0.30 typical
     diagnostic     6 turns max → ~$0.40 typical
     recommendation 4 turns max → ~$0.20 typical
     query          6 turns max → ~$0.30 typical
```

The practical consequence: the run cost is bounded above by `sum(per-stage-budget)`. There's no scenario where one agent eats the whole budget — the per-stage caps slice it. The Haiku classifier saves ~10x on the intent-routing call, where Sonnet-grade reasoning isn't needed.

The condition under which this works: the per-stage budgets are calibrated to typical agent behavior. Quarterly review of actual per-run cost would catch drift; today the budgets are tight enough that drift is unlikely.

### Layer 3 — Infinite handoff (structurally absent)

The technical thing: in swarm/handoff systems (cross-ref `./06-swarm-handoff.md`), peer agents transfer control to each other; the failure mode is A → B → A → B forever, with each agent thinking the other should handle the task.

The prevention in blooming insights: *no agent has a `transfer_to_<peer>` tool*. The pipeline transitions are owned by the route file (`app/api/agent/route.ts` L237–L247), not by the agents. The agents have no capability to hand off.

```
Why infinite handoff cannot happen here

  ┌─ Per-agent tool subsets (lib/mcp/tools.ts) ─┐
  │  diagnostic:       analytics, segments,      │
  │                    funnel, comparison        │
  │                    (NO transfer_to_*)         │
  │  recommendation:   feature catalog, scenario  │
  │                    specs, campaign templates  │
  │                    (NO transfer_to_*)         │
  │  query:            broader read-only          │
  │                    (NO transfer_to_*)         │
  │  monitoring:       read-only metrics          │
  │                    (NO transfer_to_*)         │
  └──────────────────────────────────────────────┘

  No tool means no capability. The model in any agent
  cannot emit a transfer_to_* tool_use because the tool
  schema isn't in its toolSchemas array. The runtime
  never sees a handoff to process.
```

The practical consequence: the failure literally cannot fire. Future code review of any PR that introduces a `transfer_to_*` tool would surface this risk; today the surface is empty.

The condition under which this works: the prevention is permanent unless someone adds handoff tools. If a future PR added them, the prevention would have to be replaced with a `MAX_HOPS` counter — but that's a future decision, not a current debt.

### Layer 4 — Synthesis failure (structurally absent)

The technical thing: in supervisor-worker with an LLM supervisor (cross-ref `./02-supervisor-worker.md`), the supervisor reads multiple workers' outputs and *merges them into a final answer*. When workers contradict, an LLM supervisor tends to *average* the contradictions into a confident-sounding compromise — losing the signal that the disagreement existed.

The prevention in blooming insights: *no LLM supervisor exists, and no LLM merge step exists*. The route's "merge" between diagnostic and recommendation is a function call carrying the typed `Diagnosis` — no model intermediates. The recommendation agent receives the diagnosis as a typed argument and operates on it directly.

```
Why synthesis failure cannot happen here

  ┌─ The route's "synthesis" (route.ts L247) ──┐
  │                                             │
  │   const recommendations = await             │
  │     recAgent.propose(                       │
  │       inv,                                  │
  │       diagnosis!,    ◄── typed arg          │
  │       hooksFor('recommendation')            │
  │     );                                      │
  │                                             │
  │   No model is consulted to "merge" diag and │
  │   recommendation. No averaging of           │
  │   contradictory outputs. No LLM in the      │
  │   handoff path.                              │
  └─────────────────────────────────────────────┘
```

The practical consequence: there is no path where two agents' outputs could be averaged into a wrong answer by a third LLM. The recommendation agent reads the diagnosis as-is and proposes based on it. If the diagnosis is wrong, the recommendation will propose from a wrong premise — but that's a single-agent quality issue (the diagnostic agent's), not a multi-agent synthesis failure.

The condition under which this works: the codebase avoids adopting an LLM supervisor and an LLM merge. The cross-ref `./01-when-not-to-go-multi-agent.md` documents the architectural commitment.

### Layer 5 — Context bloat (structurally absent)

The technical thing: when agents share a blackboard (cross-ref `./08-shared-state-and-message-passing.md`), each agent's context window grows with every other agent's output. At 6+ agents, "lost in the middle" becomes the dominant failure mode — the model can't find the signal in the noise.

The prevention in blooming insights: *message passing*. The recommendation agent's context is the anomaly + the typed `Diagnosis` + its own prompt + its own tool subset. It does NOT include the diagnostic agent's messages, scratchpad, or intermediate tool calls.

```
Why context bloat cannot happen here

  Diagnostic agent's context           Recommendation agent's context
  (scoped to diagnostic's loop)        (scoped to recommendation's loop)
  ─────────────────────────────        ──────────────────────────────────
  anomaly                              anomaly
  diagnostic prompt + tools            recommendation prompt + tools
  conversation history (this agent)    Diagnosis (curated, ~2k tokens)
  scratchpad (this agent)              conversation history (this agent)
                                       scratchpad (this agent)

  no overlap, no shared accumulator
```

The practical consequence: each agent's context window stays small and focused. Adding a future agent (e.g. a hypothetical `SummarizationAgent`) doesn't bloat the existing agents' windows — it gets its own scoped context.

The condition under which this works: the message schema (`Diagnosis`) is expressive enough that the recommendation agent doesn't need more than what's passed. If the schema grew past ~15 fields, the message itself would start to feel like shared state, at which point the cross-ref `./07-graph-orchestration.md`'s graph-runtime curated-state model becomes the next step.

### Layer 6 — Token revocation mid-run (controlled mechanically)

The technical thing: blooming insights' MCP server uses OAuth tokens for the Bloomreach connection. Tokens can be revoked mid-run (admin action, expiration); when that happens, MCP calls start failing 401.

The mitigation in blooming insights: a *one-time guarded auto-reconnect* triggered on 401, with a `sessionStorage` flag to prevent infinite reconnect loops.

```
The mechanism (app/page.tsx L394–L427)

  on MCP 401 response in agent run:
    alreadyTried = sessionStorage.getItem('bi:reconnecting') === '1';
    if (alreadyTried) {
      // tried once, still failing — give up, surface error
      sessionStorage.removeItem('bi:reconnecting');
      showError(...);
    } else {
      sessionStorage.setItem('bi:reconnecting', '1');
      // redirect to OAuth flow to refresh token
      window.location = authUrl;
    }
  on successful reconnect:
    sessionStorage.removeItem('bi:reconnecting');
```

The practical consequence: the user gets one automatic reconnect attempt per failure. If the reconnect also fails (e.g. token genuinely revoked, admin policy), the system surfaces an error rather than looping. The `sessionStorage` flag is the bound.

The condition under which this works: the failure is transient (a revoked token can be re-authorized via the OAuth flow). If the failure were truly terminal, the auto-reconnect would still try once and then surface the error — graceful degradation.

### Phase A vs Phase B — the failures the design retires vs the ones it accepts

```
        Structurally absent (retired)      Mechanically controlled (accepted)
┌─────────────────────────────────────┐  ┌─────────────────────────────────────┐
│ Infinite handoff                    │  │ Tool-call cascade                    │
│   no agent has transfer_to_* tools  │  │   maxToolCalls caps per agent +     │
│   ▼                                 │  │   forced-final-turn in base.ts L90  │
│ Synthesis failure                   │  │                                      │
│   no LLM merge step; route handoff  │  │ Cost blowup                          │
│   is a function call with typed     │  │   Haiku for classifier, Sonnet for  │
│   Diagnosis                         │  │   workers; per-stage budgets        │
│                                     │  │                                      │
│ Context bloat                       │  │ Token revocation mid-run             │
│   no shared blackboard; each agent  │  │   one-time guarded auto-reconnect    │
│   sees only what's handed           │  │   via sessionStorage 'bi:reconnecting'│
└─────────────────────────────────────┘  └─────────────────────────────────────┘
   Retired: zero on-call burden — the          Accepted: explicit mechanisms,
   failure simply cannot happen.                 grep-able in code, bounded
                                                  by specific values.
```

*Structurally absent:* infinite handoff, synthesis failure, context bloat. These don't show up in incidents, on-call, or replays because the system shape doesn't allow them. They're not "mitigated" — they're *not possible*.

*Mechanically controlled:* tool-call cascade, cost blowup, token revocation. These could happen if the mechanisms weren't there; they're bounded by specific values (6/6/6/4 caps, model-tier choice, `sessionStorage` flag). Each one is a line of code you can point to.

The takeaway: **deterministic orchestration is a failure-mode-retirement strategy.** You don't make the failures less likely; you make them impossible. The cost is the architectural choice (no LLM supervisor, no autonomous handoff, no shared blackboard); the win is incidents that don't happen.

This is what people mean by "the safest production code is the code that doesn't run." Failure modes that don't exist don't need monitoring, don't fire pages, don't burn on-call hours.

The full picture is below.

---

## Coordination failure modes — diagram

```
The full failure-mode landscape

  ┌─ SINGLE-AGENT failures (inherited, not new) ─────────────────┐
  │  - hallucination, prompt injection, tool misuse, etc.        │
  │  - covered in ../../study-ai-engineering/04-agents-and-tool- │
  │    use/01-agents-vs-chains.md                                │
  └──────────────────────────────────────────────────────────────┘

  ┌─ MULTI-AGENT failures (the new cluster) ─────────────────────┐
  │                                                              │
  │  Failure              ┌─ Structurally absent ─┬ Mechanically │
  │                       │ in blooming insights  │ controlled    │
  │  ─────────────────    ┼───────────────────────┼──────────────│
  │  Infinite handoff     │ ✓ no transfer_to_*    │              │
  │                       │   tools anywhere       │              │
  │                       │   (lib/mcp/tools.ts)   │              │
  │  ─────────────────    ┼───────────────────────┼──────────────│
  │  Synthesis failure    │ ✓ no LLM merge;       │              │
  │                       │   route handoff is     │              │
  │                       │   function call +      │              │
  │                       │   typed Diagnosis      │              │
  │  ─────────────────    ┼───────────────────────┼──────────────│
  │  Context bloat        │ ✓ message passing      │              │
  │                       │   (Diagnosis as msg)   │              │
  │                       │   not shared state     │              │
  │  ─────────────────    ┼───────────────────────┼──────────────│
  │  Tool-call cascade    │                       │ ✓ maxToolCalls│
  │                       │                       │   6/6/6/4 +   │
  │                       │                       │   forced-final│
  │                       │                       │   (base.ts L90)│
  │  ─────────────────    ┼───────────────────────┼──────────────│
  │  Cost blowup          │                       │ ✓ Haiku for    │
  │                       │                       │   classifier;  │
  │                       │                       │   Sonnet for   │
  │                       │                       │   workers; per-│
  │                       │                       │   stage budgets│
  │  ─────────────────    ┼───────────────────────┼──────────────│
  │  Token revocation     │                       │ ✓ one-time     │
  │   mid-run              │                       │   guarded      │
  │                       │                       │   auto-reconnect│
  │                       │                       │   (page.tsx +   │
  │                       │                       │   sessionStorage│
  │                       │                       │   'bi:reconnect-│
  │                       │                       │    ing')        │
  └──────────────────────────────────────────────────────────────┘

  Thesis: 3 failures structurally absent (zero on-call cost)
          3 failures mechanically controlled (specific code,
          bounded values, grep-able)
```

---

## Implementation in codebase

**Case A — the failure-prevention story is concrete, with each failure anchored to specific code.**

### Tool-call cascade — controlled by maxToolCalls + forced-final-turn

**File:** `lib/agents/base.ts`
**Function / class:** `runAgentLoop()`
**Line range:** L90–L101 — `budgetSpent` check (L90), `forceFinal` derivation (L91), tools stripped from request when forced (L101)

**Per-agent caps:**
- `lib/agents/monitoring.ts` L101 — `maxToolCalls: 6`
- `lib/agents/diagnostic.ts` L62 — `maxToolCalls: 6`
- `lib/agents/recommendation.ts` L57 — `maxToolCalls: 4`
- `lib/agents/query.ts` L41 — `maxToolCalls: 6`

### Cost blowup — controlled by mixed-model + per-stage budgets

**Cheap classifier (Haiku for intent):**
**File:** `lib/agents/intent.ts`
**Function / class:** `classifyIntent()`
**Line range:** L14 — `CLASSIFIER_MODEL = 'claude-haiku-4-5-20251001'`

**Expensive workers (Sonnet for loops):**
**File:** `lib/agents/base.ts`
**Function / class:** `AGENT_MODEL` constant
**Line range:** L9 — `AGENT_MODEL = 'claude-sonnet-4-6'`

### Infinite handoff — structurally absent

**File:** `lib/mcp/tools.ts`
**Function / class:** per-agent tool allow-lists
**Line range:** entire file — no `transfer_to_*` tools in any agent's subset; no agent has the capability to hand off

### Synthesis failure — structurally absent

**File:** `app/api/agent/route.ts`
**Function / class:** `GET` stream `start()` body, pipeline section
**Line range:** L237–L247 — the "synthesis" between diagnostic and recommendation is a function call passing the typed `Diagnosis`; no LLM merger runs

### Context bloat — structurally absent

**File:** cross-ref `./08-shared-state-and-message-passing.md`
**Function / class:** the architectural choice of message passing
**Line range:** see Layer 5 above and `lib/mcp/types.ts` L95–L104 for the `Diagnosis` schema (the message)

### Token revocation mid-run — controlled by one-time guarded auto-reconnect

**File:** `app/page.tsx`
**Function / class:** the reconnect handler in the agent-stream error path
**Line range:** L394 (clear flag on success), L410 (read flag), L416 (set flag), L427 (clear on reconnect)

### MCP rate limit (the secondary cascade bound)

**File:** `lib/mcp/connect.ts`
**Function / class:** McpClient constructor options
**Line range:** L92 — `minIntervalMs: 1100` (the per-call spacer that also bounds upstream pressure during a tool-call cascade)

```
shape (the mechanism for tool-call cascade — most-load-bearing):

  // lib/agents/base.ts L90–L101
  const budgetSpent = maxToolCalls !== undefined
    && toolCalls.length >= maxToolCalls;
  const forceFinal = turn === maxTurns - 1 || budgetSpent;
  const params: Anthropic.Messages.MessageCreateParamsNonStreaming = {
    model: AGENT_MODEL,
    max_tokens: maxTokens,
    system: forceFinal && synthesisInstruction
      ? `${system}\n\n${synthesisInstruction}` : system,
    messages,
  };
  if (!forceFinal) params.tools = toolSchemas;
  // ▲ when forceFinal is true, tools are NOT passed; model
  //   literally cannot emit another tool_use; must produce text
  const res = await anthropic.messages.create(params);
```

---

## Elaborate

### Where this pattern comes from

The multi-agent failure-mode taxonomy got its current popular framing from a combination of: (a) Anthropic's "Building Effective Agents" (2024), which named "cost blowup" and the 2-5x overhead empirically; (b) LangGraph's documentation, which named "infinite handoff" and "synthesis failure" as the canonical failures their checkpointing prevents; (c) production write-ups from teams running multi-agent systems at scale (e.g. Replit, Hugging Face) reporting on the specific incidents they hit. The "structural prevention vs mechanical control" framing is a long-standing safety-engineering principle (Reason's Swiss-cheese model from 1990) applied to agent design.

### The deeper principle

**Failure modes that can't fire don't need monitoring.** The cheapest production system is the one whose failure modes are structurally absent — because absent failures don't need alerts, runbooks, on-call coverage, or post-mortems. The cost is upfront architectural choices that retire those failures.

```
   Mechanical control            Structural prevention
   ──────────────────────        ──────────────────────
   failure can fire               failure cannot fire
   mechanism bounds it            shape forbids it
   needs monitoring (is the       no monitoring needed
    mechanism still working?)
   on-call burden: low            on-call burden: zero
   debugging: walk the mechanism  debugging: not applicable
```

The deeper version: this is the same principle as type systems vs runtime checks. A type system *prevents* whole categories of bug from compiling; a runtime check *catches* the bug when it fires. Both are valid; the type system is cheaper at production time because the bugs simply don't exist in deployed code.

### Where this breaks down

The structural-prevention argument breaks when the prevention is *too restrictive* — when the architectural choice that retires a failure also retires capability the system genuinely needs. For example: blooming insights structurally prevents infinite handoff by not having handoff at all. The cost is no runtime adaptability in stage ordering. If product needs grow to require adaptive ordering, structural prevention has to be relaxed and the mechanism (`MAX_HOPS` counter) replaces it.

The mechanical-control argument breaks when the mechanism is poorly calibrated. A `maxToolCalls: 6` cap that's too tight for the diagnostic agent's actual job will produce truncated diagnoses, not infinite loops. The mechanism prevents the failure but introduces a different one (premature termination). Calibration is half the work.

### What to explore next
- `./01-when-not-to-go-multi-agent.md` → the architectural choice that retires the failures
- `./06-swarm-handoff.md` → the "infinite handoff" failure in detail
- `./05-debate-verifier-critic.md` → the "synthesis failure" failure in detail
- `./08-shared-state-and-message-passing.md` → the "context bloat" failure in detail
- `../05-production-serving/` → cost-aware production controls beyond what this file covers

---

## Interview defense

### What an interviewer is really asking

When an interviewer asks "what could go wrong" or "how do you handle [specific failure]" they're testing two things: do you know the failure mode by name, and can you point to the specific mechanism (or architectural choice) that addresses it in YOUR code. The strong signal is the structural-vs-mechanical distinction — naming which failures simply can't happen in this codebase vs which ones are controlled by a specific cap. The weak signal is "we'd add monitoring" without naming the failure or the mechanism.

### Likely questions

[mid] Q: What's the worst-case scenario for an agent loop, and how do you bound it?

A: Tool-call cascade — an agent loop emits tool calls every turn for the full `maxTurns` budget, burning the budget without producing a final answer. The bound in blooming insights is two-layered: `maxToolCalls` caps per agent (6/6/6/4 in monitoring/diagnostic/query/recommendation) and the forced-final-turn mechanic in `runAgentLoop` (`lib/agents/base.ts` L90–L101) — when the budget is spent, the loop strips `tools` from the request, so the model literally cannot emit another `tool_use`; it has to produce text. The cascade is structurally bounded by the cap.

Diagram:
```
  Tool-call cascade prevention

  for turn in maxTurns:
    if toolCalls.length >= maxToolCalls:
       params.tools = undefined  ◄── stripped
       (model cannot emit tool_use anymore)
       force final text output
    else:
       params.tools = toolSchemas
       proceed normally
```

[senior] Q: How would you compare blooming insights' coordination failure surface vs an autonomous multi-agent system?

A: blooming insights structurally prevents three of the six canonical multi-agent failures, because the deterministic orchestration choice retires them: no peer handoff means no infinite handoff (`lib/mcp/tools.ts` has no `transfer_to_*` tools anywhere); no LLM merge means no synthesis failure (the route's handoff is a function call with typed `Diagnosis`); message passing means no context bloat (each agent's window is scoped to what's handed). The three remaining — tool-call cascade, cost blowup, token revocation — are mechanically controlled with specific caps and one-time guarded reconnects. An autonomous system would have to mechanically control all six, with mechanisms that themselves can fail. So the question is: where would I rather spend the bug surface? Three mechanisms with structural backstops, or six mechanisms with no backstops. I picked the first; the cost was giving up adaptive routing.

Diagram:
```
  Coordination failure modes — surface comparison

  blooming insights         autonomous multi-agent
  ──────────────────        ─────────────────────
  3 structurally absent     ALL controlled by mechanisms
  3 mechanically controlled
                            6 mechanisms to:
  monitoring surface: 3      - calibrate (each value matters)
  on-call burden:    low     - monitor (still working?)
                             - debug (which mechanism failed?)

                            monitoring surface: 6
                            on-call burden:    high
```

[arch] Q: How would this failure-prevention model scale to 10 agents?

A: The structural-prevention model holds. Message passing scales (each agent's context stays scoped); no LLM merge scales (handoffs stay typed function args); no peer handoff scales (route stays the supervisor). What changes is the *calibration* of the mechanical controls. With 10 agents, per-stage budgets need a global per-run cap to prevent the sum from exceeding what the MCP rate limit can support; the Haiku-classifier-Sonnet-worker split stays the right shape but you might add a third tier (Sonnet for hard stages, Haiku for easy stages). The token-revocation handler doesn't change. The breakpoint is whether the route file becomes a switchboard at 10 agents — if yes, you adopt a graph runtime (`./07-graph-orchestration.md`), but the failure-mode model still applies: the graph runtime's curated state preserves the no-context-bloat property; explicit nodes preserve the no-infinite-handoff property; the engine's checkpointing actually adds resumability as a NEW prevention (failures recover from checkpoint instead of re-running).

Diagram:
```
At 10 agents — what changes vs what holds

  ┌─ STRUCTURAL prevention (holds) ─────┐
  │ no peer handoff (no transfer_to_*)  │
  │ no LLM merge (function-arg handoffs)│
  │ message passing (scoped contexts)   │
  └─────────────────────────────────────┘
  ┌─ MECHANICAL controls (recalibrate) ─┐
  │ tool-call cascade: per-stage caps + │
  │   GLOBAL per-run cap (new)          │
  │ cost blowup: model-tier routing per │
  │   stage (3-tier, not 2)             │
  │ token revocation: unchanged          │
  └─────────────────────────────────────┘
  ┌─ NEW preventions (if graph adopted) ┐
  │ failure recovery: checkpoint resume  │
  │   instead of full re-run             │
  └─────────────────────────────────────┘
```

### The question candidates always dodge

Q: You claim 3 failures are "structurally absent" — but they're absent because you didn't build the features that cause them. Isn't that just calling absence of features a virtue?

A: Yes, deliberately. The architectural choice IS the prevention. I didn't build LLM supervisor and autonomous handoff, and that choice retires the failure modes those features introduce. The alternative — building the features and then preventing their failures with mechanisms — is strictly more cost: more code, more on-call burden, more debugging surface. The honest framing is that I picked a less-capable system in exchange for a smaller failure surface, and I can defend that choice because the capability I gave up (adaptive runtime routing) is one I can grep for in the route file (`route.ts` L199–L249) and prove the codebase doesn't need today. The day adaptive routing becomes a hard requirement, I'd add LLM supervisor, accept the failure modes, and mechanism-control them — but until then, "absence of feature = absence of failure" is the cheapest possible answer to the question "how do you handle infinite handoff?" The answer is: I don't, because no agent in this codebase can hand off, and you can verify that by grepping `lib/mcp/tools.ts` for `transfer_to_*` and finding zero hits. That's not handwaving; that's a structural property of the system.

Diagram:
```
The "absence" argument, made concrete

  Feature absent              ─►  Failure mode absent
  ──────────────────────         ──────────────────────────────
  no transfer_to_* tools         no infinite handoff
   (lib/mcp/tools.ts)             (cannot fire — no capability)
  no LLM merger                  no synthesis failure
   (route.ts L237–L247)           (cannot fire — function call only)
  no shared blackboard            no context bloat from sharing
   (message passing)              (cannot fire — scoped contexts)

  This isn't handwaving — it's a structural property
  you can verify by grepping the code.
  Absent failures need zero monitoring.
```

### One-line anchors

- "Three failures structurally absent (handoff, synthesis, bloat), three mechanically controlled (cascade, cost, token revocation) — that's the failure surface."
- "Structural prevention is cheaper than mechanical control because absent failures need no monitoring."
- "Tool-call cascade is bounded structurally: when `maxToolCalls` is hit, the runtime strips tools from the request — the model literally cannot emit another tool_use."
- "Deterministic orchestration retires three failure modes for free; the cost is giving up adaptive runtime routing."

---

## Validate your understanding

### Level 1 — Reconstruct the diagram

Close this file. Draw the failure table from memory: 6 failure modes in rows, two columns ("structurally absent" and "mechanically controlled"). Place each failure in the right column and annotate the file/mechanism that prevents/controls it.

Open the file. Compare.

✓ Pass: you listed all 6 failures, split them 3/3 between structural and mechanical, and named the right mechanism (or architectural choice) for each
✗ Fail: re-read How it works Layers 1–6 and the failure table at the top, wait 10 minutes, try again.

### Level 2 — Explain it out loud

Explain to a colleague who asked "what could break in a multi-agent system?" — under 90 seconds, no notes.

Checkpoints — did you:
- Name at least 4 of the 6 failure modes?
- Distinguish structural prevention from mechanical control?
- Name `maxToolCalls` + forced-final-turn as the tool-call cascade bound?
- Name "no `transfer_to_*` tools" as the infinite-handoff prevention?

If you skipped any: you listed failures without naming what stops them.

### Level 3 — Apply it to a new scenario

A product manager proposes adding a "second-opinion" agent that reviews the diagnostic agent's output before recommendation. The PM doesn't specify whether it's a separate LLM or the same model.

Without looking at the file: which failure modes does this introduce? Which mechanisms would you need to add? Which structural property of the codebase would change? Reference `./05-debate-verifier-critic.md` and the LLM-as-judge bias issue.

Write your answer (3–5 sentences). Then open `lib/agents/base.ts` L90–L101 (the forced-final-turn mechanic) and consider whether the same model running as a critic shares the producer's blind spots.

### Level 4 — Defend the decision you'd change

"If you were starting this project today and you had to defend the choice between (a) deterministic orchestration with 3 mechanisms (today) and (b) autonomous orchestration with 6 mechanisms, which would you pick and why? What's the specific product requirement that would flip you from (a) to (b)? What's the on-call cost difference?"

Reference the code: `lib/agents/base.ts` L48–L176 (`runAgentLoop`), `app/api/agent/route.ts` L199–L249 (the orchestration), `lib/mcp/tools.ts` (the per-agent tool subsets that prevent handoff structurally), `app/page.tsx` L394–L427 (token-revocation handling).

### Quick check — code reference test

Without opening any files:
- Name 3 failure modes blooming insights structurally prevents.
- Name 3 failure modes blooming insights mechanically controls.
- Which file holds the forced-final-turn mechanic that bounds tool-call cascade?
- Which file holds the `sessionStorage` flag that bounds the token-revocation reconnect loop?

Open and verify. ✓ File + function names matter; line numbers drifting is fine.

## See also

→ `./01-when-not-to-go-multi-agent.md` · → `./06-swarm-handoff.md` · → `./05-debate-verifier-critic.md` · → `./08-shared-state-and-message-passing.md` · → systems view: `../../study-system-design-dsa/01-system-design/06-multi-agent-orchestration.md` · → mechanics: `../../study-ai-engineering/04-agents-and-tool-use/01-agents-vs-chains.md`

---
Updated: 2026-05-29 — created
Updated: 2026-05-30 — Migrated to study.md v1.47 template (Phase 1+2 mechanical): removed Tradeoffs / Tech reference / Summary sections; renamed "In this codebase" → "Implementation in codebase"; moved See also to a bottom block. "Why care" preserved pending Phase 3 (Zoom out, then zoom in + LAYERS diagram) authoring.
