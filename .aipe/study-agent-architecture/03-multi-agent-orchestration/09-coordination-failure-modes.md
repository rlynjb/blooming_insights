# Coordination failure modes

**Industry standard.** The failures that don't exist in single-agent systems. **Mostly prevented by topology choice** in this codebase — the deterministic pipeline sidesteps the failure modes that come with LLM coordination.

## Zoom out, then zoom in

Sits as a meta-pattern across every topology. When you escalate from single-agent to any multi-agent shape, you inherit a class of failures single-agent can't have. This file enumerates them and names the mitigations.

```
  Zoom out — where this concept lives

  ┌─ Multi-agent topology ──────────────────────────┐
  │  Whichever you picked: supervisor, debate, swarm │
  │  ★ Coordination failure modes you now inherit ★ │ ← we are here
  │  (each topology brings a subset of these)        │
  └──────────────────────────────────────────────────┘
```

This repo, by staying deterministic-pipeline, sidesteps most of these. The ones that *could* still apply (cost blowup, tool-call cascade within a single agent's loop) are bounded by the control envelope from `04-agent-infrastructure/05-guardrails-and-control.md`.

## Structure pass

Layers: failure mode (the named thing that goes wrong) → topology it lives in (which shapes can produce it) → mitigation (the specific control that bounds it).

**Axis traced — "what does this failure mode require?":** each one needs at least one multi-agent feature to exist. Infinite handoff needs handoffs. Synthesis failure needs a merger. Tool-call cascade is the only one that can fire in single-agent too.

**Seam:** the specific control that catches each failure. Caps, budgets, validators, schemas.

## How it works

### Move 1 — the mental model

You know the difference between a function and a microservice mesh. The function can crash. The mesh can crash, deadlock, cascade-fail, retry-storm, partition, or end up with two services convinced of different truths. Multi-agent has the same expansion: single-agent can produce wrong output or burn budget; multi-agent can do those AND fail in ways that require coordination to even exist.

```
  The failure-mode table

  ┌──────────────────────┬──────────────────────────┐
  │ Failure              │ Mitigation               │
  ├──────────────────────┼──────────────────────────┤
  │ Infinite handoff     │ Handoff counter; force    │
  │ (A→B→A→B…)            │ stop or escalate to human │
  ├──────────────────────┼──────────────────────────┤
  │ Tool-call cascade    │ Per-agent and global      │
  │ (one agent triggers  │ iteration caps; budget    │
  │ a storm of calls)    │ ceiling that halts the run│
  ├──────────────────────┼──────────────────────────┤
  │ Context bloat as     │ Message passing / context │
  │ agents accumulate    │ routing instead of a       │
  │ shared state         │ shared blackboard          │
  ├──────────────────────┼──────────────────────────┤
  │ Synthesis failure    │ Validate worker outputs    │
  │ (supervisor merges    │ against a schema before    │
  │ contradictory)        │ synthesis; surface         │
  │                      │ conflicts, don't average   │
  ├──────────────────────┼──────────────────────────┤
  │ Cost blowup          │ Per-run token budget;      │
  │ (2-5x overhead       │ cheap models for workers,  │
  │ compounds silently)  │ expensive only for the     │
  │                      │ supervisor                 │
  └──────────────────────┴──────────────────────────┘
```

### Move 2 — step by step

#### Failure 1 — infinite handoff

**Where it lives:** swarm topology (`06-swarm-handoff.md`).
**Doesn't apply here:** no handoffs, no peer transitions. The orchestrator is deterministic code.

If this repo adopted swarm, the mitigation would be a runtime handoff counter capped at ~5-8 transitions per conversation, plus asymmetric handoff catalogs (A can hand to B; B cannot hand back to A in the same conversation). OpenAI's Swarm SDK enforces both at the kernel level — a hand-rolled swarm has to do the same.

#### Failure 2 — tool-call cascade

**Where it lives:** any agent loop. The single-agent version is "one runaway agent burning tool calls"; the multi-agent version is "supervisor spawns many workers, each runs its own loop, total tool calls × N." This is the only failure mode in the table that can fire in single-agent systems.

**Mitigation in this repo:** every agent has hard caps.

- `maxTurns = 8` is the default in `runAgentLoop` (`run-agent-loop.js:21`). Monitoring overrides via the AptKit class.
- `maxToolCalls = 6` for monitoring specifically (`monitoring-agent.js:56`). Other agents are bounded only by `maxTurns`.
- `maxTokens = 4096` per turn (`run-agent-loop.js:21`).
- `maxDuration = 300` at the route level (`app/api/briefing/route.ts:19`, `app/api/agent/route.ts:22`). The whole request can't blow past 5 minutes.

The cascade can't compound across agents in this repo because the orchestrator is sequential — only one agent loop runs at a time. If the repo grew fan-out, the per-agent caps would multiply by N and need a global cap added on top.

#### Failure 3 — context bloat

**Where it lives:** shared-state topologies (`08-shared-state-and-message-passing.md`). When every agent reads/writes a common context, the context grows with the topology size. Past ~30-50% of the model's nominal context length, the lost-in-the-middle problem fires.

**Doesn't apply here:** the repo uses message passing with small typed handoffs. The `Diagnosis` interface is hundreds of bytes; the `Anomaly` is similar. Each agent's context is its system prompt + its bounded input + its own running conversation — nothing inherited from sibling agents.

If the repo added a shared-state architecture for some reason (e.g. a long-running multi-step analysis with rich shared context), the mitigation would be: don't. Use multi-agent context routing instead — pass role-specific context to each agent. This is `04-agent-infrastructure/01-context-engineering.md` applied at the multi-agent boundary.

#### Failure 4 — synthesis failure

**Where it lives:** any topology with a merger — supervisor-worker, fan-out-fan-in, debate. The merger reads contradictory inputs and either averages them (hiding the conflict) or hallucinates a synthesis that doesn't follow from the inputs.

**Doesn't apply here:** no LLM merger. Each stage produces a typed output the next consumes; there's no aggregation step. If a hypothetical fan-out version added a merger, the mitigation would be: validate worker outputs against a schema before synthesis; surface conflicts as explicit "these workers disagreed" data rather than letting the synthesizer average them.

The closest cousin in this repo is the structured-output validators (`tryParseAnomalies`, `tryParseDiagnosis`, recommendation validators). They catch *structural* failures in one agent's output (the model emitted text that doesn't parse as JSON) but they're not synthesis-failure prevention because there's no synthesis to prevent.

#### Failure 5 — cost blowup

**Where it lives:** any multi-agent topology. The 2-5x coordination tax compounds silently across coordination messages, sub-agent runs, and per-turn context overheads. Without budget caps, the bill explodes before you notice.

**Doesn't apply here in the multi-agent sense:** no coordination tax to compound. The cost ceiling is the deterministic pipeline's natural cost (one agent run per stage, no supervisor overhead). The per-request cost lands around $0.10-0.25 for a full investigation (monitoring + diagnose + recommend at Sonnet pricing).

**Does apply in the single-agent sense:** a runaway agent loop with no budget cap can burn tokens indefinitely. Mitigations:

- The skeleton's budget exit (`maxTurns`) is unbreakable — the `for` loop can't continue past it.
- The per-tool-call cost is bounded by the per-call response size (capped at 16,000 chars in the tool result block — `run-agent-loop.js:2-4`).
- Token-usage logging (`aptkit-adapters.ts:57-61`) emits per-call usage to console for observability; aggregating these would surface cost anomalies post-hoc.

The piece this repo doesn't have: a hard per-run *dollar* budget that halts the run if the cumulative cost crosses a threshold. The `maxTurns` × `maxTokens` × per-call-cost give an effective ceiling (~$0.50 for the most expensive possible run) but no live cost gate. For a system with higher stakes (e.g. customer-facing agent that could fire 100s of times per day), adding a dollar gate would be cheap insurance.

#### The fifth failure that's only in the spec table — multi-agent coordination latency

The spec doesn't separate this from cost blowup, but it's worth a paragraph: in a multi-agent system, each coordination message adds wall-clock latency. The supervisor's "decide which worker runs" call is ~1-2s of latency added per dispatch; sequential coordination compounds. A four-stage pipeline with a supervisor at each handoff is roughly 8-15s of pure coordination overhead per request.

This repo's deterministic pipeline doesn't pay this latency because the handoffs are zero-cost function calls. The whole investigation runs in ~50-120s wall-clock (the MCP tool calls are the dominant cost), not 50-120s + 8-15s of coordination.

### Move 3 — the principle

**Multi-agent escalation buys quality at the cost of new failure modes.** Each topology brings a specific subset of the table above; you inherit them the moment you adopt the topology. The mitigations are well-known but they're not free — caps cost time-to-implement, validators cost design effort, budget gates cost monitoring infrastructure. The honest framing for any multi-agent decision: name the failure mode you're escalating to address, and name the failure modes you're now inheriting. If the inherited modes outweigh the addressed mode, don't escalate.

This repo's deterministic-pipeline shape is the structural choice that prevents the inherited modes from existing in the first place. That's not absence-of-discipline; it's the discipline of "don't escalate before you need to."

## Primary diagram

```
  Which failure modes this repo can vs cannot produce

  ┌──────────────────────────────────────────────────────────────┐
  │  Failure              | Can fire? | Why / mitigation          │
  ├──────────────────────────────────────────────────────────────┤
  │  Infinite handoff     | NO        | No handoffs in topology   │
  │                        |           |                            │
  │  Tool-call cascade    | YES       | maxTurns=8,                │
  │  (within one agent)   |  (bounded) | maxToolCalls=6 (mon),     │
  │                        |           | maxDuration=300s (route)   │
  │                        |           |                            │
  │  Context bloat        | NO        | Message passing, small     │
  │                        |           | typed handoffs             │
  │                        |           |                            │
  │  Synthesis failure    | NO        | No LLM merger              │
  │                        |           |                            │
  │  Cost blowup          | YES       | Hard caps bound max cost   │
  │  (within one agent's  |  (bounded) | per request to ~$0.50;    │
  │  loop, in theory)     |           | no live dollar gate         │
  │                        |           |                            │
  │  Coordination latency | NO        | Zero-cost function-call    │
  │                        |           | handoffs, no model         │
  │                        |           | coordination               │
  └──────────────────────────────────────────────────────────────┘
```

## Elaborate

The cost-blowup failure mode is the one production teams get bitten by most often, because it's silent. A misbehaving multi-agent system that produces wrong outputs is visible (you notice the wrong outputs). A misbehaving multi-agent system that produces correct outputs at 5x expected cost is invisible until the monthly bill arrives. The mitigation (per-run dollar budget) is cheap to add and surprisingly often missing in agent systems built by teams new to the topology.

The synthesis-failure mode is the one most likely to ship invisibly when you DO adopt multi-agent. Two workers disagree on something subtle; the supervisor averages their outputs into a synthesis that doesn't follow from either side; the user reads it as authoritative. The fix — surface conflicts, don't average — requires the supervisor's prompt to explicitly handle conflict detection, plus structured-output validation on worker outputs so conflicts are detectable. Both are doable; both are commonly skipped.

The Anthropic multi-agent research blog post (2025) is candid about which of these failures their team has hit and how they handle them. Tool-call cascade is the one they call out as the most operationally annoying — a sub-research-agent that gets stuck in a tool-call loop burns budget that compounds across the supervisor's other sub-agents. Their mitigation is a per-agent tool-call cap plus a global per-run budget that halts the supervisor if any single sub-agent crosses its allotted share.

## Interview defense

> **Q: What multi-agent failure modes could this codebase produce?**
>
> Mostly none, because the orchestration is deterministic. No infinite handoff (no handoffs). No context bloat (message passing). No synthesis failure (no LLM merger). Tool-call cascade can fire inside a single agent's loop in theory, but `maxTurns=8`, `maxToolCalls=6` for monitoring, `maxTokens=4096`, and `maxDuration=300s` at the route level bound it hard. Cost blowup within a single agent's loop is similarly bounded — the worst-case single investigation costs maybe $0.50 — but the repo doesn't have a live per-run dollar gate that halts at a threshold. That's the gap worth filling if the system grew to higher-volume use.

> **Q: What changes if you adopted a supervisor?**
>
> You inherit synthesis failure as a real risk, plus coordination latency, plus deeper cost-blowup exposure. Mitigations: schema-validate worker outputs before the supervisor synthesizes (surface conflicts, don't average); add a per-run dollar budget that halts the supervisor at threshold; use cheap models (Haiku) for the workers and reserve the supervisor's expensive model for synthesis. The Anthropic multi-agent research blog post is candid that even with these mitigations the operational complexity is real — they keep their supervisor topology to ≤5 sub-agents per run because beyond that the failure-mode surface dominates.

> **Q: What's the failure mode you'd worry about most if you escalated?**
>
> Synthesis failure — specifically the silent version where the supervisor averages contradictory worker outputs into a plausible-but-ungrounded synthesis. It ships invisibly because the output looks coherent; you only catch it by reading the worker outputs in the trace and noticing they disagree in ways the synthesis hides. The mitigation requires both schema-validation (so the supervisor can detect conflicts) and a prompt instruction to surface conflicts rather than reconcile them. Both are easy to skip and the failure mode is hard to detect post-hoc.

## See also

- → `01-when-not-to-go-multi-agent.md` — the gate that prevents most of these by not escalating
- → `04-agent-infrastructure/05-guardrails-and-control.md` — the control envelope that bounds the single-agent versions
- → `05-production-serving/02-fan-out-backpressure.md` — the cost-blowup-during-fan-out story
- → `05-production-serving/03-per-tool-circuit-breaking.md` — the tool-call-cascade story specifically
