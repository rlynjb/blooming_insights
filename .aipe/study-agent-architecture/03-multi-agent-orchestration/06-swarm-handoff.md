# Swarm / handoff

**Industry standard.** Peer-to-peer control transfer, no central boss. **Not exercised** in this codebase.

## Zoom out, then zoom in

Sits as an alternative to supervisor-worker. Instead of a central coordinator dispatching to workers, agents themselves decide when to hand control to a peer specialist.

```
  Zoom out — where this WOULD live

  ┌─ Orchestration layer ───────────────────────────┐
  │  Today: deterministic dispatch                   │
  │  Would: ★ peer-to-peer handoff (no boss) ★      │ ← we are here
  │  agents transfer the conversation between        │
  │  themselves at the model's discretion            │
  └──────────────────────────────────────────────────┘
```

## Structure pass

Layers: per-agent personality (each agent owns a specialty + a handoff catalog) → handoff decision (the active agent decides "this isn't my job, hand to peer X") → conversation transfer (the new agent takes over, with the prior context).

**Axis traced — "who's in control?":** the most-recently-active agent. Control flows peer-to-peer; there's no central "next agent" decision-maker.

**Seam:** the handoff message — a structured "I'm done here; you take over" the active agent emits, the runtime interprets, the next agent receives. OpenAI's Swarm SDK formalizes this as a structured handoff return value.

## How it works

### Move 1 — the mental model

You know the difference between a manager dispatching tasks and a team passing tickets between themselves. Supervisor-worker is the manager — the supervisor decides who handles each request. Swarm is the team — the first agent looks at the request, decides "this isn't mine," and tags in a peer specialist. The peer might tag back, or hand to a third peer, or finish.

```
  Swarm — peer handoff

      ┌────────┐  "you take it"  ┌────────┐
      │agent A  │ ──────────────► │agent B  │
      └────────┘                 └───┬────┘
           ▲                         │ "back to you"
           └─────────────────────────┘
```

More flexible than supervisor-worker (no central bottleneck; agents can hand off in any topology). Harder to debug (no single point that knows the whole state) and prone to infinite handoff (A → B → A → B…) without explicit caps.

### Move 2 — step by step

#### Why this is rare in production

Two reasons swarm is rare in shipped agent systems:

1. **Infinite handoff is easy to introduce.** A → B → A → B is the default failure mode when two agents both decide "this isn't really mine." The mitigation — a handoff counter that force-stops or escalates after N transfers — is part of the kernel, not bolt-on. OpenAI's Swarm SDK enforces this at the runtime.
2. **Tracing is hard.** A request flows through N agents in sequence; the trace is N agent trajectories stitched together. Standard agent UIs (this repo's `StatusLog` included) show one agent's trajectory at a time; supporting "the conversation moved to agent B at turn 4" requires multi-agent trace plumbing the repo doesn't have.

The natural home is customer-support routing where the agent personalities map to support tiers — Tier 1 handles common questions, hands to Tier 2 specialist on complex ones, who hands to Tier 3 escalation when needed. The conversation feel of "specialist takes over" matches the user expectation.

#### Why this repo wouldn't reach for swarm

The handoffs in this repo are deterministic (`monitoring → diagnose → recommend`) and known in advance. The user (not the model) drives transitions by clicking "see recommendations." There's no model decision about *which* agent to hand to next. Swarm would add the flexibility of model-driven transitions for a system whose transitions are deterministic; that's a feature mismatched to the domain.

A hypothetical use case where swarm would land: the QueryBox grows beyond "general query about your workspace" into specialty roles — "ask the campaign expert," "ask the segmentation expert," "ask the experimentation expert" — and each expert is a different agent with a different tool allowlist and a different conversational tone. Then peer handoff between the experts (and back to a triage agent) starts to make sense. But the design constraint that pushes this — wanting persistent agent personalities the user can address by role — isn't in this product's design.

#### The infinite-handoff failure mode

Worth detailing because it's the canonical swarm bug. Three pieces have to land for swarm to work safely:

1. **Per-agent handoff catalog.** Each agent has a fixed list of peers it can hand to. Not "any agent in the swarm" — that's how cycles form.
2. **Handoff counter.** The runtime tracks total handoffs in one conversation. Cap at N (typical: 5-8). When the cap fires, the runtime forces a final synthesis or escalates to human.
3. **Forbidden return handoffs.** Sometimes the cleanest rule is "A can hand to B; B cannot hand back to A in the same conversation." Asymmetric handoff catalogs prevent the most common cycle.

This repo would have all three for free if it adopted swarm, because the four agents have natural specialty boundaries that lend themselves to asymmetric catalogs. But adoption isn't on the roadmap.

### Move 3 — the principle

**Swarm earns its complexity when the user benefits from talking to specialty agents with persistent personalities AND the dispatch decision is genuinely the agent's, not the engineer's.** Neither condition is true in this repo's design. Most agent systems should not reach for swarm — supervisor-worker covers the same dispatch surface with a cleaner trace and a single point of synthesis.

## Primary diagram

```
  Swarm topology (hypothetical, not in this repo)

  ┌─ user query ─────────────────────────────────────────────────┐
  │                                                                │
  │   ┌─ Triage Agent ─────────────────────────────────────────┐ │
  │   │   handoff_catalog: [CampaignExpert, SegmentationExpert, │ │
  │   │                     ExperimentationExpert]               │ │
  │   │   decides: "this is about a campaign perf drop"          │ │
  │   │   emits: handoff(CampaignExpert)                         │ │
  │   └────────────────────────┬─────────────────────────────────┘ │
  │                            ▼                                    │
  │   ┌─ CampaignExpert ─────────────────────────────────────────┐ │
  │   │   handoff_catalog: [SegmentationExpert, Triage]          │ │
  │   │   investigates campaign data                              │ │
  │   │   discovers segment-specific issue                        │ │
  │   │   emits: handoff(SegmentationExpert)                     │ │
  │   └────────────────────────┬─────────────────────────────────┘ │
  │                            ▼                                    │
  │   ┌─ SegmentationExpert ─────────────────────────────────────┐ │
  │   │   handoff_catalog: [CampaignExpert] (asymmetric — can't  │ │
  │   │                     hand back to Triage to prevent cycle) │ │
  │   │   investigates segment data                               │ │
  │   │   finds answer; emits final text (no handoff)             │ │
  │   └──────────────────────────────────────────────────────────┘ │
  │                                                                  │
  │   Runtime enforces: handoff counter <= 5                         │
  │                     forbidden return handoffs respected           │
  └────────────────────────────────────────────────────────────────┘
```

## Elaborate

OpenAI's Swarm SDK (released October 2024 as an experimental pattern) is the canonical formalization of this topology. The SDK shapes handoffs as structured return values — an agent's response can include a `handoff` field that the runtime interprets as "transfer the conversation to agent X." The receiving agent gets the conversation history plus its own system prompt + tool allowlist. The runtime tracks the handoff count and enforces an upper bound.

The Anthropic SDK doesn't have a built-in swarm primitive, but you can express the same pattern by wrapping `runAgentLoop` calls — the active agent returns a structured intent, the wrapper inspects it for handoff, dispatches to the next agent's loop. That's exactly the indirection a SDK would add automatically.

Production swarm deployments tend to converge on 3-5 agents with tight specialty boundaries and asymmetric handoff catalogs. Beyond ~5 agents the coordination surface (which agent can hand to which?) becomes unmanageable; the cycle-prevention rules become a coordination subproblem of their own. Most teams that try larger swarms either collapse back to supervisor-worker or shard the swarm into independent sub-swarms each handling a domain.

## Interview defense

> **Q: Would swarm make sense for this codebase?**
>
> No. The handoffs in this repo are deterministic — `monitoring → diagnose → recommend` is a fixed pipeline driven by the user clicking "see recommendations." There's no model decision about which agent handles a request; the orchestration code dispatches. Swarm's value is *model-driven* peer handoff when the user benefits from specialty personalities. This product's user experience is "an analyst that shows its work," not "talk to the campaign expert vs the segmentation expert" — there's no specialty role surface in the UI. Swarm would add coordination complexity for no UX win.

> **Q: When would swarm make sense?**
>
> When the user benefits from agent specialty personalities and the dispatch is genuinely runtime-decided. Customer support is the canonical example: Tier 1 handles common questions, hands to Tier 2 on complex ones, who hands to Tier 3 on escalation. The user experiences distinct conversational tone shifts as specialists take over. The handoff decision is model-driven because the question complexity isn't enumerable in code. For analytical agent systems like this one, the same flexibility is overhead.

> **Q: What's the infinite-handoff failure mode?**
>
> The default failure when two agents both decide "this isn't really mine." Agent A hands to B; B hands back to A; A hands to B again. The conversation never terminates because the handoff IS the termination signal. The fix is part of the kernel: (1) per-agent fixed handoff catalogs so A can only hand to a limited set, (2) a global handoff counter the runtime caps at N transfers, (3) asymmetric catalogs that explicitly forbid common return cycles. OpenAI's Swarm SDK enforces all three; a hand-rolled swarm needs to do the same. The general pattern is the multi-agent version of the budget exit from the single-agent loop skeleton.

## See also

- → `02-supervisor-worker.md` — the centralized alternative to swarm
- → `09-coordination-failure-modes.md` — infinite handoff and its mitigation
- → `01-when-not-to-go-multi-agent.md` — the gate that should reject swarm for this repo's domain
