# blooming insights — agent architecture study guide

A topic-focused companion to [`../study-ai-engineering/`](../study-ai-engineering/). Same staff-engineer voice, same per-concept template — but the lens is **what happens above one agent**: reasoning patterns beyond ReAct, retrieval as a control loop, multi-agent orchestration topologies, agent infrastructure, and serving for an autonomous loop.

## Codebase shape: multi-agent (minimal topology) + adapter-switchable

blooming insights is a **multi-agent** codebase, but deliberately the *minimal* form — a deterministic sequential pipeline (monitoring → diagnostic → recommendation) plus an intent router, with the typed `Diagnosis` as the inter-stage message. The orchestration is **deterministic route code, not an LLM supervisor** — the route picks the next agent from `?step=`, and the user gates each transition by navigating. This is the architectural opinion at the heart of the guide: split work into specialists, keep coordination in code, escalate to an autonomous supervisor only when the coordination decision itself needs the model. See `03-multi-agent-orchestration/01-when-not-to-go-multi-agent.md` for the full defense.

A second axis landed in Phase 2: **the topology is adapter-switchable.** Every agent's tool-registry adapter holds a `DataSource` (`lib/data-source/types.ts`). Two adapters implement it today: `BloomreachDataSource` (live OAuth MCP) and `SyntheticDataSource` (in-process, 516 LOC of deterministic fakes at `lib/data-source/synthetic-data-source.ts`). The `bi:mode` localStorage key holds `'demo' | 'live-bloomreach' | 'live-synthetic'`. The previously-documented Olist subprocess adapter and its sibling `mcp-server-olist/` package — plus the four-pillar eval/ pipeline that ran against them — were removed in PR #8 (commit 62c24d7); the in-repo measurement story is back to "structural unit tests + the streamed `AgentEvent` trajectory as the inspectable artifact."

**A third axis landed after Phase 2: the active ReAct spine is `@aptkit/core` v0.3.0, not Blooming's `runAgentLoop`.** The four agent classes in `lib/agents/` are thin wrappers (30–100 LOC each) that construct an `@aptkit/core` agent and hand it three Blooming-owned adapter objects from `lib/agents/aptkit-adapters.ts` (206 LOC): `AnthropicModelProviderAdapter`, `BloomingToolRegistryAdapter`, `BloomingTraceSinkAdapter`. The Blooming-side `runAgentLoop` is preserved at `lib/agents/base-legacy.ts`; sibling `*-legacy.ts` files keep the legacy path intact for revertibility. See `04-agent-infrastructure/06-aptkit-runtime-layer.md` for the "own your domain + adapter layer, defer reusable agent behavior to a library" pattern as a concept.

Start with [`00-overview.md`](00-overview.md) for the system map, then [`agent-patterns-in-this-codebase.md`](agent-patterns-in-this-codebase.md) for the feature-by-feature breakdown.

## Sub-sections

- **[01-reasoning-patterns/](01-reasoning-patterns/README.md)** (6 files) — chains-vs-agents (the boundary), ReAct (the baseline), plan-and-execute, reflexion / self-critique, tree of thoughts, routing (the bridge to multi-agent).
- **[02-agentic-retrieval/](02-agentic-retrieval/README.md)** (3 files) — agentic RAG, self-corrective RAG, retrieval routing. Intentionally thin: retrieval here is *live agentic EQL*, not embedding-RAG (the design rationale is cross-referenced to `../study-ai-engineering/03-retrieval-and-rag/11-rag.md`).
- **[03-multi-agent-orchestration/](03-multi-agent-orchestration/README.md)** (9 files) — when-not-to-go-multi-agent, supervisor-worker, sequential pipeline, parallel fan-out, debate / verifier-critic, swarm / handoff, graph orchestration, shared state and message passing, coordination failure modes. **The load-bearing section** for a multi-agent codebase.
- **[04-agent-infrastructure/](04-agent-infrastructure/README.md)** (6 files) — context engineering, agent memory tiers, tool calling and MCP (with the `DataSource` seam above it), agent evaluation (structural unit tests + the inspectable trajectory — the automated harness is gone with `eval/`), guardrails and control, **AptKit runtime layer** (the senior pattern: own your domain + adapter layer, defer reusable agent behavior to a library). The cross-cutting disciplines that separate a demo from a shipped system.
- **[05-production-serving/](05-production-serving/README.md)** (3 files) — cross-turn caching, fan-out backpressure, per-tool circuit breaking. These cover what `../study-ai-engineering/06-production-serving/` becomes once the unit is a loop or a topology.
- **[06-orchestration-system-design-templates/](06-orchestration-system-design-templates/README.md)** (3 files) — IK-style 9-bullet templates: multi-agent research assistant, agentic support system, agentic coding system. Mapped against this codebase's actual shape.

## Reading order

The cross-sub-section order is **A → B → C → D → E → F**, but no file requires another — each is self-contained with `See also` cross-links. The path that tracks this codebase's strengths:

1. **`03-multi-agent-orchestration/01-when-not-to-go-multi-agent.md`** first — it grounds the architectural opinion the rest of the guide leans on. Then `03/03-sequential-pipeline.md`, `03/08-shared-state-and-message-passing.md`, `03/09-coordination-failure-modes.md` — the three Case-A files for this codebase's actual topology.
2. **`01-reasoning-patterns/02-react.md` and `06-routing.md`** — the baseline every agent runs, and the router that bridges single-agent into multi-agent.
3. **`04-agent-infrastructure/`** — read in directory order; the discipline is what holds it all together.
4. **`02-agentic-retrieval/01-agentic-rag.md`** — for why retrieval here is live EQL inside the loop and not a vector pipeline.
5. **`05-production-serving/`** — what the McpClient does inside a loop vs a single call.
6. **`06-orchestration-system-design-templates/`** — the same code reframed as an interview answer.

## Case A vs Case B

**Case A** (implemented — cited to real `file:line`):
- The whole of SECTION A's chains-vs-agents boundary, ReAct, and routing (the four agents on AptKit's spine; the intent classifier re-exported from AptKit).
- SECTION B's agentic-RAG (reframed: agentic, but the tool is `execute_analytics_eql` under Bloomreach, or synthetic equivalents in-process — not embeddings).
- SECTION C's sequential pipeline, shared-state-and-message-passing (the `bi:diag:<id>` handoff), and coordination-failure-modes (this codebase's *deterministic* orchestration structurally avoids whole classes of multi-agent failures).
- Most of SECTION D — context engineering, memory tiers (working + ephemeral persistence), tool calling and MCP (with the `DataSource` seam above MCP and the AptKit runtime layer above the seam), guardrails (AptKit-owned budgets, read-only tools, validators, coverage gate, auto-reconnect), **AptKit runtime layer (own your domain + adapter layer, defer reusable agent behavior to a library)**.
- SECTION E's cross-turn caching (the 60s TTL on the Bloomreach adapter + demo replay).

**Case B** (not yet implemented in this repo): SECTION A's plan-and-execute, reflexion, tree of thoughts. SECTION B's self-corrective-RAG and retrieval-routing. SECTION C's supervisor-worker (would replace the deterministic route), parallel fan-out, debate/critic, swarm/handoff, graph orchestration. SECTION D's agent evaluation as an *automated harness with portfolio numbers* — the structural unit tests + inspectable trajectory are still Case A, but the trajectory-eval harness with seeded ground truth was removed when `eval/` and `mcp-server-olist/` were deleted in PR #8. SECTION E's fan-out backpressure (no fan-out exists) and per-tool circuit breaking.

## How this guide composes with the rest of the family

```
study-system-design/        the systems-level view of the same orchestration
                                (request flow, multi-agent-orchestration, schema-gated
                                 coverage, NDJSON streaming, client stream handoff)
study-ai-engineering/           single-agent mechanics + retrieval mechanics
                                (ReAct mechanics, tool calling, agent memory two-layer
                                 split, RAG / why-no-embeddings, LLM-as-judge, single-
                                 call caching/cost/rate-limit/retry-and-circuit-breaker)
study-prompt-engineering/       prompt-craft mechanics (self-critique, structured
                                 outputs, anatomy of the production prompts the agents
                                 use, the {categories} runtime interpolation)
rehearse-interview-defense/     the wide-opener interview book — defending the project
                                 above the concept level
THIS GUIDE                      everything ABOVE one agent — reasoning patterns,
                                 agentic retrieval as a control loop, multi-agent
                                 orchestration topologies, agent infrastructure,
                                 production serving for a loop or a topology
```

The boundary with `study-ai-engineering/`: that guide stops at the single-agent surface and covers retrieval mechanics deeply. Everything above one agent — the reasoning patterns past ReAct, the agentic retrieval *loop*, the multi-agent topologies — lives here. Where a mechanic is already taught in `study-ai-engineering/`, this guide cites it in `See also` rather than re-teaching.

---
Updated: 2026-05-29 — created
Updated: 2026-06-16 — Reflected Phase 2 DataSource seam (adapter-switchable), Phase 3 four-pillar eval suite (`eval/`) moving Case A coverage to include automated trajectory/output eval (no longer Case B). Flipped the agent-evaluation Case B line into Case A with the four portfolio numbers; named the new Case B (cross-family judge backstop).
Updated: 2026-06-19 — Reflected AptKit v0.3.0 migration: third axis (active spine is `@aptkit/core`, not Blooming's `runAgentLoop` — the legacy spine is preserved at `base-legacy.ts`). Replaced the Olist subprocess adapter with `SyntheticDataSource`; the Olist adapter, `mcp-server-olist/` sibling package, and `eval/` pipeline were removed in PR #8. Reverted agent-evaluation Case A claim — automated harness is gone with `eval/`; structural unit tests + inspectable trajectory remain. Added 6th file slot in `04-agent-infrastructure/` for the AptKit runtime layer concept.
