# Swarm / handoff

**Industry name(s):** Swarm, peer-to-peer handoff, agent handoff, OpenAI Swarm, model-decided control transfer
**Type:** Industry standard · Language-agnostic

> Peer specialist agents transfer control to each other at runtime — no central supervisor; the model decides when to hand off. blooming insights does NOT have handoff: control is centralized in the deterministic route, and no agent calls another agent. The topology that earns its overhead when peer specialists need model-decided routing the route's `if`-ladder can't express.

**See also:** → `./02-supervisor-worker.md` · → `./07-graph-orchestration.md` · → `./09-coordination-failure-modes.md` (infinite handoff) · → `./01-when-not-to-go-multi-agent.md` · → systems view: `../../study-system-design-dsa/01-system-design/06-multi-agent-orchestration.md`

---

## Why care

### Move 1 — the scenario (lead with the shape)

```
The swarm / handoff shape

      ┌────────┐  "you take it"  ┌────────┐
      │agent A  │ ──────────────► │agent B  │
      └────────┘                  └───┬────┘
           ▲                          │ "back to you"
           └──────────────────────────┘

  no central boss; peers transfer control to each other
```

You've built a `<SupportChat>` component. The user types "I want a refund." The frontend has three children — `<BillingChat>`, `<ShippingChat>`, `<AccountChat>` — each specialized for one topic. Today the parent picks which child renders based on the user's first message and never switches.

Now picture this instead: the user starts in `<BillingChat>` (refund is billing-shaped). Mid-conversation the user mentions "the package was damaged in shipping" — and `<BillingChat>` *hands off* to `<ShippingChat>` directly, not by routing back to the parent. The two children talk to each other. Later if it's actually an account-level issue, `<ShippingChat>` hands off to `<AccountChat>`. There's no parent supervisor deciding; the *children* decide who takes the conversation next.

### Move 2 — name the question

That second shape — peer agents transferring control to each other without going back through a central supervisor — is what swarm/handoff names. The question this file answers: **when does it pay to let agents hand off to peers directly, instead of always routing decisions through a central supervisor (or a fixed pipeline)?**

The technical hinge: in handoff, the *model* decides who runs next. In supervisor-worker and pipeline, *code* (or a supervisor model) does. Handoff makes specialist routing a runtime model decision.

### Move 3 — why answering that question matters

**Why you need to answer that question at all:** because handoff trades centralized control for runtime adaptability, and the cost is real: an *infinite-handoff* failure mode where two peers keep deferring to each other (A → B → A → B → A → ...) burns the budget on routing instead of doing the work. Without a handoff counter or a final-decider gate, the system loops until the iteration cap stops it — emitting nothing useful.

In this codebase: there is no peer handoff anywhere. The route file's `if`-ladder picks which agent runs at the start of each request, and that agent runs to completion. The diagnostic agent doesn't call the recommendation agent; the route does. The query agent doesn't call the diagnostic agent; the query branch is separate from the investigation branch. Each agent's input is exactly what the route hands it — no peer can transfer control mid-run.

The thing that's intentionally absent: model-decided routing between specialists. The route is the supervisor; agents are workers; workers do not communicate with peers.

### Move 4 — concrete before/after

Centralized routing (this codebase, today):
- User asks free-form question with `?q=` → route calls `classifyIntent` → route picks `QueryAgent`
- `QueryAgent` runs end-to-end with its own loop
- If the question turns out to be about an anomaly, `QueryAgent` has no way to hand off to `DiagnosticAgent` mid-run
- The user gets a query-shaped answer, even if a diagnostic flow would have been more useful

Swarm/handoff (hypothetical):
- User asks free-form question → starts in `QueryAgent`
- Mid-run, `QueryAgent` realizes "this is an anomaly investigation request" — it emits a *handoff* to `DiagnosticAgent`
- Control transfers; `DiagnosticAgent` resumes the conversation with the handed-over context
- `DiagnosticAgent` might hand off again to `RecommendationAgent` once the diagnosis is complete
- A handoff counter caps the total transfers (else infinite handoff)

### Move 5 — one-line summary

A swarm is peer agents handing control to each other at runtime — no central boss, model-decided routing, with infinite handoff as the failure mode you have to bound. blooming insights' control is centralized in the route, so no handoff exists; here's how the topology works and what would have to change for it to earn its overhead.

---

## How it works

**The mental model: peer specialists, each capable of deciding "you take it now."** Control is distributed. The model running in agent A includes in its tool subset a `transfer_to_B` or `transfer_to_C` tool; calling that tool *transfers control* — A's loop ends, B's loop begins with A's context handed over.

```
Handoff in one picture

   conversation state
       │
       ▼
   ┌────────┐
   │agent A  │ ──(emits transfer_to_B tool_use)──┐
   │ loop    │                                    │
   └────────┘                                    │
                                                 ▼
                                          ┌────────┐
                                          │agent B  │  ◄── resumes
                                          │ loop    │      with A's
                                          └────────┘      context
                                              │
                                              │ (B may transfer back,
                                              │  or to C, or finish)
                                              ▼
                                          final answer

   no central supervisor; the MODEL in each agent decides
```

The strategy in plain English: **let the model running this turn decide who should run next, including itself.** The peer that has the conversation right now has the most context to decide who should handle the next turn — including the option to keep going.

### Layer 1 — the handoff as a tool call

The technical thing: a handoff is implemented as a *tool call*. Each agent's tool subset includes `transfer_to_<peer>` tools (one per peer it can hand to). When the model emits that tool_use, the runtime catches it specifically (it doesn't go to MCP) and switches the active agent.

If you're coming from frontend, this is `router.push('/billing')` inside a React component — the component itself decides to navigate; the router framework handles the actual transition. The component doesn't "stop"; it triggers the transition and the next route component takes over.

```
Handoff as a tool call

  Agent A's runAgentLoop:
   turn 1:  model emits text + tool_use("get_user_orders")
            → runtime executes MCP tool, feeds back tool_result
   turn 2:  model emits text + tool_use("transfer_to_billing")
            ↑ this isn't a normal MCP tool — it's a HANDOFF
            → runtime stops A's loop, starts B's loop with A's
              messages[] as starting context

  Agent B's runAgentLoop (started by handoff):
   turn 1:  model sees A's prior messages, picks up the
            conversation. Emits text + tool_use("issue_refund")
   …
```

The practical consequence: the agent runtime has to distinguish handoff tool_uses from regular tool_uses. OpenAI's Swarm and Agents SDK do this with a sentinel return value (`Agent` object returned from the tool means "transfer"); LangGraph does it with explicit `Command(goto=...)` nodes. The key is that the runtime owns the transfer; the agent just declares the intent.

The condition under which this works: each agent has to know which peers exist (the tool subset has to include the handoff tools) AND there has to be a clear context-passing protocol — what does the next agent see? The full message history? A summary? A typed handoff message?

### Layer 2 — the infinite-handoff failure mode

The technical thing: *circular deferral* — agent A handoffs to B because A thinks B should handle this; B handoffs back to A because B thinks A should handle this; A handoffs to B; ... the loop terminates only when the system-wide iteration cap is hit, at which point neither agent has done the work and the user gets nothing useful.

If you're coming from frontend, this is a `<Suspense>` boundary that throws because its parent's `<Suspense>` boundary throws because its parent throws — every parent thinks the next one should handle it, and the whole tree crashes. Or it's two engineers both saying "I'll wait for the other one to start" — work that never gets done because both deferred.

```
The infinite handoff

  A → "this is billing's job" → B
        │
        ▼
  B → "this is account's job" → A   (A thinks it's billing's)
        │
        ▼
  A → "this is billing's job" → B
        │
        ▼
  B → "this is account's job" → A
        ...
   until: hop_count >= MAX_HOPS  → forced stop, no answer

  cross-ref: ./09-coordination-failure-modes.md
```

The practical consequence: every swarm framework has a handoff counter / max-hops constraint. OpenAI Swarm has a `max_turns` config; LangGraph has graph-level recursion limits; CrewAI tracks `delegation_count`. Without a cap, a swarm can burn the full per-run token budget on routing.

The condition under which this works: each agent's prompt has to make clear *when to NOT hand off* — i.e. "if you can answer this with your tools, do it; only hand off if the question is materially outside your scope." Vague prompts produce vague boundaries produce infinite handoff. Sharp prompts ("you handle refunds, shipping issues go to ShippingAgent, account-level issues go to AccountAgent") give the model real signal.

### Layer 3 — context passing on handoff (what does the next agent see?)

The technical thing: a *context handoff protocol* — when A hands to B, what does B receive? Three common shapes:

1. **Full message history.** B sees everything A said and everything the user said. Maximum context, maximum tokens.
2. **Summary by A.** A emits a one-paragraph summary as part of the handoff; B sees the summary + the new user message. Cheaper, lossy.
3. **Typed handoff message.** A produces a structured object (like blooming insights' `Diagnosis` would be if it were a handoff). B's prompt expects that exact shape. Cheapest, requires schema design.

If you're coming from frontend, this is the difference between `window.location = '/billing'` (full history via URL + session), `props` being passed to a child (curated), and a typed action being dispatched (structured). Same shape — what does the receiver see?

```
Three context-passing shapes

  Full history          Summary           Typed message
  ────────────────      ─────────────     ─────────────────
  B sees:               B sees:           B sees:
   all A's messages      A's summary       { reason: "refund",
   all user messages     new user msg        order_id: "...",
                                            issue_type: "..." }
  expensive             lossy             needs schema design
  preserves nuance      cheap             enforced contract
```

The practical consequence: full-history is what most swarm frameworks default to (OpenAI Swarm passes the whole `messages` array); summaries are what production teams move to once token costs become real; typed messages are what blooming insights' Diagnosis pattern already uses for its sequential pipeline (cross-ref `./03-sequential-pipeline.md`) — and would be the right shape for any handoff this codebase ever introduced.

The condition under which this works: the handoff protocol matches the agents' actual coupling. Loosely-coupled peers (different domains, different prompts) need typed messages because there's no shared context to inherit. Tightly-coupled peers (same domain, different sub-specialties) can ride on summary or full history.

### Phase A vs Phase B — what blooming insights would change

```
        Now (centralized route)              If peer routing earned itself
┌─────────────────────────────────────┐  ┌─────────────────────────────────────┐
│ app/api/agent/route.ts L199–L249    │  │ route picks the FIRST agent          │
│   route picks ONE agent for the run │  │   then each agent has a transfer_to_X│ ←
│   that agent runs to completion     │  │   tool in its subset                 │
│   no agent calls another agent      │  │ DiagnosticAgent may transfer_to(     │
│   ▼                                 │  │   RecommendationAgent) once done     │
│ DiagnosticAgent → returns Diagnosis │  │ RecommendationAgent may transfer_to( │ ←
│ (route hands it to recommendation)  │  │   DiagnosticAgent) on insufficient   │
│                                     │  │   diagnosis (back-edge)              │
│ control: centralized, in route.ts   │  │ control: distributed across agents   │
└─────────────────────────────────────┘  └─────────────────────────────────────┘
   the WORKERS are unchanged; only WHO decides "next agent"
   moves from route code to model emit
```

*Now:* there's no peer handoff. The route picks one agent (`QueryAgent`, `DiagnosticAgent`, or `RecommendationAgent`) based on the request shape, that agent runs to completion, the route may follow up with the next agent in the pipeline (only `DiagnosticAgent` → `RecommendationAgent`, deterministically). No agent can transfer control.

*If peer routing earned itself:* each agent's tool subset would include `transfer_to_<peer>` tools. The `DiagnosticAgent` could decide mid-investigation that it needs deeper context only a hypothetical `DeepDiveAgent` has, and hand off. The `RecommendationAgent` could hand back to diagnostic on "this diagnosis is too thin to recommend on." A *handoff counter* would cap total transfers (`MAX_HOPS = 4` say); each agent's prompt would have clear stay-vs-handoff rules.

The takeaway: **handoff distributes control to where the most context lives.** The agent running this turn has the freshest view of what's needed next. The cost: a new failure mode (infinite handoff), a new debug shape (which hop went wrong?), and harder traceability (the trajectory is fragmented across agents).

This is what people mean by "swarm shines when peer specialists need model-decided routing." When the next-agent decision genuinely depends on what the current agent saw, the agent running this turn is the best decider — better than a code if-ladder, better than a separate supervisor that hasn't read the current context.

The full picture is below.

---

## Swarm / handoff — diagram

```
Swarm / handoff — full picture

  ┌─ INITIAL ROUTING (entry point) ──────────────────────────────┐
  │                                                              │
  │   user request                                               │
  │       │                                                      │
  │       ▼                                                      │
  │   route picks FIRST agent (any topology — pipeline,          │
  │   classifier, or hardcoded entry point)                      │
  │       │                                                      │
  │       ▼                                                      │
  └──────────────────────────────────────────────────────────────┘
                              │
                              ▼
  ┌─ PEER MESH (the swarm) ──────────────────────────────────────┐
  │                                                              │
  │   ┌────────┐                       ┌────────┐                │
  │   │Agent A │ ◄── transfer_to_A ────│Agent B │                │
  │   │        │                       │        │                │
  │   │        │ ───transfer_to_B ────►│        │                │
  │   └───┬────┘                       └───┬────┘                │
  │       │                                │                     │
  │       │ transfer_to_C                  │ transfer_to_C       │
  │       │                                │                     │
  │       ▼                                ▼                     │
  │            ┌────────┐                                        │
  │            │Agent C │                                        │
  │            └────────┘                                        │
  │                                                              │
  │   each agent's tool subset includes transfer_to_<peer> tools │
  │   the MODEL decides when to emit a handoff                   │
  │                                                              │
  └──────────────────────────────────────────────────────────────┘
                              │
                              ▼
  ┌─ CONTROL ENVELOPE (the guardrails) ──────────────────────────┐
  │                                                              │
  │   ┌─────────────────────────────────────┐                    │
  │   │ Handoff counter (max_hops = N)      │                    │
  │   │   prevents infinite handoff          │                    │
  │   └─────────────────────────────────────┘                    │
  │   ┌─────────────────────────────────────┐                    │
  │   │ Per-agent iteration cap              │                    │
  │   │   bounds work inside one agent       │                    │
  │   └─────────────────────────────────────┘                    │
  │   ┌─────────────────────────────────────┐                    │
  │   │ Stay-vs-handoff rules in each       │                    │
  │   │ agent's prompt (clear scoping)       │                    │
  │   └─────────────────────────────────────┘                    │
  │                                                              │
  └──────────────────────────────────────────────────────────────┘
                              │
                              ▼
                         final answer
                         (whoever's loop emits no
                          tool_use and no handoff
                          gets to ship the response)

  blooming insights: NOT IMPLEMENTED. Control is centralized
  in app/api/agent/route.ts; no agent transfers to a peer.
  See `../06-orchestration-system-design-templates/` for the
  refactor.
```

---

## In this codebase

**Not yet implemented.**

There is no peer handoff in blooming insights. The route file (`app/api/agent/route.ts` L199–L249) picks the lead agent at the start of each request, and that agent runs to completion. The pipeline transitions (`DiagnosticAgent` → `RecommendationAgent`) happen because the route's `start()` body explicitly invokes the next agent — not because the diagnostic agent emits a handoff. Each agent's tool subset (`lib/mcp/tools.ts`) contains only MCP tools; there are no `transfer_to_<peer>` tools anywhere.

The honest sentence: **control is centralized in the deterministic route, and that's a deliberate choice — peer handoff would introduce model-decided routing the route's `if`-ladder doesn't need to express today.** The user journey has exactly three flows, the next-agent decision in each flow is knowable up front, and the next-agent failure mode that worries handoff designers (infinite-handoff) is structurally absent because no agent has the capability to transfer.

For the refactor: `../06-orchestration-system-design-templates/` includes a "swarm support assistant" template; per-agent `transfer_to_<peer>` tools would be added to each agent's tool subset, a `MAX_HOPS` counter would live in the route, and the route's `start()` body would loop over handoffs instead of running one agent and the next-fixed-stage.

**The centralized routing (the absence of handoff)**
**File:** `app/api/agent/route.ts`
**Function / class:** `GET` stream `start()` body, lead-agent select
**Line range:** L199–L200 — `const leadAgent: AgentName = q && !insightId ? 'coordinator' : step === 'recommend' ? 'recommendation' : 'diagnostic';`

**Per-agent tool subsets (no handoff tools today)**
**File:** `lib/mcp/tools.ts`
**Function / class:** the per-agent allow-list functions
**Line range:** entire file — each function returns MCP tool names only; no `transfer_to_*` tools

**The pipeline transition that is not a handoff**
**File:** `app/api/agent/route.ts`
**Function / class:** `GET` stream `start()` body, recommendation block
**Line range:** L244–L249 — the route invokes `recAgent.propose(...)` after `diagAgent.investigate(...)` returns; this is a function call from the route, not a model-decided handoff

```
shape (the absence — what a handoff would look like, not current code):

  // hypothetical: a transfer_to_recommendation tool added to diagnostic's subset
  const diagnosticTools = [
    ...mcpToolsForDiagnostic,
    {
      name: 'transfer_to_recommendation',
      description: 'Done investigating; hand off to recommendation agent.',
      input_schema: { type: 'object', properties: { diagnosis: { ... } } }
    },
  ];

  // hypothetical: handoff handling in runAgentLoop
  for (const tu of toolUses) {
    if (tu.name.startsWith('transfer_to_')) {
      const targetAgent = tu.name.slice('transfer_to_'.length);
      if (hopCount >= MAX_HOPS) throw new Error('max hops exceeded');
      return { handoff: { to: targetAgent, context: tu.input }, hopCount: hopCount + 1 };
    }
    // ... else: normal MCP tool dispatch
  }
```

---

## Elaborate

### Where this pattern comes from

Peer-handoff multi-agent systems got their current popular framing from OpenAI's Swarm framework (open-sourced October 2024 as a teaching tool) and then formalized in OpenAI's Agents SDK (2025), which made `handoffs` a first-class concept alongside tools. The underlying idea — agents transferring control to peer specialists — is older; CrewAI shipped a delegation primitive in 2023, and the academic multi-agent literature (e.g. AutoGen from Microsoft, 2023) treats peer-to-peer agent communication as a default. The key insight Swarm popularized: handoff can be implemented as just another tool call, with a sentinel return type — no special graph framework required.

### The deeper principle

**Distribute control to where the most context lives.** The agent running this turn has the freshest view of what's needed next. Centralized supervisors have to re-derive context to make routing decisions; peer agents already have it. The cost is the loss of a single point of truth — no one process knows the whole state.

```
   Centralized control   ─►  one process knows everything
                              one place to debug, one cost per
                              decision (the supervisor call)
                              cost: stale context if supervisor
                              doesn't see live state

   Distributed control   ─►  whoever is running has the most
                              context, decides next
                              no single point of truth
                              cost: harder to trace, new failure
                              modes (infinite handoff)
```

### Where this breaks down

Handoff breaks when peer scoping is fuzzy — when "billing" and "account" overlap (refund eligibility is both), the agent in billing decides "this is account," account decides "this is billing," and you get infinite handoff. The mitigation is sharp per-agent prompts that specify both stay-cases and handoff-cases explicitly.

It also breaks when the context-passing protocol drops information. If `DiagnosticAgent` hands off to `RecommendationAgent` via a summary that omits hypotheses considered, the recommendation might propose actions that contradict already-rejected hypotheses. The mitigation is a typed handoff message (like blooming insights' `Diagnosis`) that captures everything the next agent needs.

### What to explore next
- `./09-coordination-failure-modes.md` → the "infinite handoff" mitigation (handoff counter, max hops)
- `./02-supervisor-worker.md` → the centralized-control alternative
- `./07-graph-orchestration.md` → swarm expressed as a state graph with explicit nodes and transition edges (the "make it inspectable" version)
- `../06-orchestration-system-design-templates/` → the "swarm support assistant" template

---

## Tradeoffs

The decision was: **centralized control in the route — no peer handoff.** The alternative is to add `transfer_to_<peer>` tools to each agent and let model-decided routing happen at runtime.

┌──────────────────┬─────────────────────────────┬─────────────────────────────┐
│ Cost dimension   │ Centralized route (chosen)  │ Swarm / handoff (alternative)│
├──────────────────┼─────────────────────────────┼─────────────────────────────┤
│ Build cost       │ if-ladder in route.ts       │ transfer_to_* tools + handoff│
│                  │                             │ runtime + max-hops counter   │
│ Latency / run    │ no extra LLM cost for       │ +1 LLM call per handoff      │
│                  │ routing (route is code)     │ decision                     │
│ Token cost / run │ pays for the chosen path    │ pays for handoff decisions + │
│                  │                             │ context-passing overhead     │
│ Runtime          │ none — order is fixed       │ peer routing adapts to       │
│ adaptability     │                             │ runtime context              │
│ Failure modes    │ shares all of `./09`'s,     │ ADDS: infinite handoff,      │
│                  │ minus infinite-handoff      │ context-loss-on-handoff,     │
│                  │ (structurally absent)       │ ping-pong between peers      │
│ Debug shape      │ stage-localized — bug is in │ trajectory fragmented across │
│                  │ one prompt or one route     │ N agents, follow the hops    │
│                  │ branch                      │                              │
│ Single point of  │ yes — the route             │ no — distributed across      │
│ truth            │                             │ agents                       │
│ Onboarding cost  │ any engineer reads an       │ engineer must understand each│
│                  │ if-ladder                   │ agent's handoff rules        │
│ When right       │ when next-agent decision is │ when next-agent decision     │
│                  │ knowable up front           │ needs runtime context the    │
│                  │                             │ route can't have             │
└──────────────────┴─────────────────────────────┴─────────────────────────────┘

### What we gave up

We gave up the ability for agents to redirect mid-run. The `QueryAgent` can't decide "this question is actually an investigation request" and hand off to `DiagnosticAgent`. The `DiagnosticAgent` can't decide "this diagnosis needs deeper context, let me hand off to a hypothetical `DeepDiveAgent`." The path is locked at request entry.

We also gave up *peer-decided context*. The route's pipeline handoff (function call from diag to rec) carries the typed `Diagnosis`, but the route doesn't know what other context the recommendation agent might want. A handoff initiated by `DiagnosticAgent` itself could pack more context based on what the diagnostic agent actually learned during the loop.

### What the alternative would have cost

If we'd built handoff from day one, the up-front cost would be per-agent `transfer_to_<peer>` tools (one per peer it can hand to), a handoff-aware `runAgentLoop` (catches the handoff tool_use, persists context, starts the next agent's loop), and a `MAX_HOPS` counter to prevent infinite handoff. Per-run cost would be one extra LLM decision per handoff (~1–3s under MCP rate limit) — minor compared to the agent loop costs.

The bigger cost is operational: a fragmented trajectory. Today every investigation has a clean stage-by-stage trace. With handoff, the trace becomes "agent A turns 1–3, handoff, agent B turns 1–2, handoff back, agent A turn 4..." — you have to follow the hops to debug. UI surfaces (the `ProcessStepper`) would need to be re-thought; today they assume a fixed stage progression.

### The breakpoint

This stays the right call until peer specialists need *runtime* routing that the route can't express — e.g. when the QueryAgent regularly hits anomaly-investigation territory and the user would benefit from a mid-conversation transition to a real investigation flow. Or when the diagnostic agent's job grows to 4–5 specialties (segment-X diagnostic, segment-Y diagnostic, funnel diagnostic, retention diagnostic) and a generic supervisor would have to decide which specialist runs from data only the running agent has seen.

### What wasn't actually a tradeoff

A "centralized supervisor with handoff-style delegation" (where the supervisor decides handoffs but the agents don't decide themselves) is not really handoff — it's tools-style supervisor-worker with a different name. The cross-reference is `./02-supervisor-worker.md`. Real handoff requires the *peer* to decide it's time to transfer; if the supervisor is making the call, you're back in supervisor-worker territory.

A "shared blackboard" where agents write to a shared state and the next agent picks up based on the state is also not handoff — it's `./08-shared-state-and-message-passing.md`. Handoff is *active control transfer*: agent A explicitly hands off; agent B explicitly receives. The shared-blackboard alternative is *passive context*: state exists; whoever runs next reads it.

---

## Tech reference

### OpenAI Swarm / Agents SDK handoffs

- **Codebase uses:** not used.
- **Why it's here:** OpenAI's Swarm (2024 demo) and Agents SDK (2025 production) made `handoffs` a first-class primitive — a tool that returns an `Agent` object signals "transfer to this agent." This is the cleanest implementation of the handoff pattern available off-the-shelf.
- **Leading today:** OpenAI Agents SDK handoffs — innovation-leading for handoff-style multi-agent in production, 2026.
- **Why it leads:** handoffs are tools, so they reuse the existing tool-calling infrastructure; the SDK enforces a `max_turns` counter; context can be passed structured (via the handoff tool's input_schema).
- **Runner-up:** LangGraph `Command(goto=...)` — handoff as an explicit graph edge; more ceremony, more inspectable.

### LangGraph subgraphs and Command

- **Codebase uses:** not used.
- **Why it's here:** LangGraph models handoff as graph edges with explicit `goto` directives — each node can return `Command(goto='next_node', update=context)`, which lets the graph framework move control with full state tracking.
- **Leading today:** LangGraph — innovation-leading for graph-style multi-agent with checkpointed state, 2026.
- **Why it leads:** explicit state graph means every handoff is a named edge; recursion limits are first-class; checkpointing lets you pause-resume mid-handoff.
- **Runner-up:** CrewAI delegation — simpler model, less explicit state, less checkpointing.

### Anthropic Messages API tool_use (the handoff substrate)

- **Codebase uses:** `runAgentLoop` in `lib/agents/base.ts` L48–L176 — the same primitive a handoff system would use. A handoff would be a special tool_use the runtime intercepts.
- **Why it's here:** Anthropic's tool_use is the substrate; the only thing missing from this codebase is a runtime that detects `transfer_to_*` tool calls and switches the active agent.
- **Leading today:** Anthropic tool use — innovation-leading for typed agent loops with structured outputs, 2026.
- **Why it leads:** `tool_use` blocks with structured input are the right shape for "transfer with this typed context" — no framework wrapper required.
- **Runner-up:** OpenAI Responses API — equivalent shape, larger installed base.

---

## Summary

Swarm / handoff is peer specialist agents transferring control to each other at runtime — no central supervisor, model-decided routing. Implemented as a special tool call (`transfer_to_<peer>`) the runtime catches; bounded by a handoff counter (`MAX_HOPS`) to prevent infinite-handoff failures. blooming insights does not have peer handoff: control is centralized in `app/api/agent/route.ts` L199–L249, and no agent's tool subset (`lib/mcp/tools.ts`) contains a `transfer_to_*` tool. The constraint that made this right is that the user journey has three knowable flows and the next-agent decisions in each flow don't need runtime context the route doesn't already have. The cost is fixed routing — the QueryAgent can't redirect mid-conversation to an investigation flow even if that would serve the user better. The breakpoint: peer specialists with runtime routing needs the route can't express, OR a specialty explosion (4–5+ sub-specialists per stage) where centralized routing becomes a switchboard.

- Handoff is peer agents transferring control via a tool call; the runtime intercepts the call and switches the active agent.
- Infinite handoff is the failure mode (A → B → A → B); always bound it with a `MAX_HOPS` counter.
- Same-family peers with vague scoping ping-pong; sharp per-agent prompts with explicit stay/handoff rules are required.
- Context-passing protocol matters: full history (token-expensive), summary (lossy), or typed message (cleanest — like blooming insights' `Diagnosis`).
- Worth it when peer routing needs runtime context the route can't have; otherwise centralized routing wins.

---

## Interview defense

### What an interviewer is really asking

When an interviewer asks "is your system a swarm" they're testing whether you understand that "multi-agent" and "peer handoff" are different shapes. The strong signal is naming that control is centralized in `route.ts` and explaining why peer handoff would *add* failure modes (infinite handoff) without adding decision power (the next-agent calls are knowable). The weak signal is calling the codebase a swarm because there are multiple agents.

### Likely questions

[mid] Q: Does blooming insights use a swarm topology?

A: No. There are four agents, but no peer handoff between them. The route file `app/api/agent/route.ts` L199–L249 picks the lead agent at request start; that agent runs to completion; the route may invoke the next pipeline stage as a function call (diagnostic → recommendation), but no agent emits a handoff itself. Each agent's tool subset (`lib/mcp/tools.ts`) contains only MCP tools, no `transfer_to_*` tools. Control is centralized in the route — the opposite of swarm.

Diagram:
```
  ┌─ Centralized (this codebase) ──────────────────────┐
  │ route picks agent  →  agent runs to completion     │
  │ route invokes next  →  no peer handoff             │
  └────────────────────────────────────────────────────┘

  ┌─ Swarm (alternative) ──────────────────────────────┐
  │ route picks first agent  →  agent emits            │
  │ transfer_to_<peer>  →  control transfers           │
  │ peer may transfer back, to C, or finish            │
  └────────────────────────────────────────────────────┘
```

[senior] Q: Why didn't you build handoff between the diagnostic and recommendation agents?

A: Because the next-agent decision after diagnostic is *always* recommendation (or always stop, in the split-step UX where the user gates it). There's no scenario where diagnostic might decide "actually, hand off to a different specialist instead of recommendation." The transition is knowable up front, so the route can express it deterministically. If I built handoff, I'd add a `transfer_to_recommendation` tool to the diagnostic agent's subset for no decision power gain — the diagnostic agent doesn't have a choice to make. I'd also add a new failure mode (infinite-handoff) and a handoff counter to prevent it. Net: cost, no value. I'd reach for handoff the day the diagnostic agent has a meaningful choice between peer specialists (e.g. SegmentDeepDiveAgent vs FunnelDeepDiveAgent based on what the data showed).

Diagram:
```
  When handoff adds value vs when it adds cost

  Diagnostic agent has ONE next agent (today)
   → centralized route is fine
   → handoff adds cost, no decision power

  Diagnostic agent has 4 possible next agents
  based on what it saw in the data
   → centralized route would need a supervisor
   → handoff lets the diagnostic agent decide
     with the most context
```

[arch] Q: If you were going to add handoff to support multi-domain queries, what's the architecture?

A: I'd add it to the `QueryAgent` path first, not the investigation pipeline. The investigation pipeline has knowable transitions; the QueryAgent doesn't — a free-form question might span multiple domains. The architecture: `QueryAgent` gets a `transfer_to_investigation` tool with a typed input (the anomaly description it identified mid-query). If the user asked "why is conversion dropping in segment X" and the QueryAgent realizes mid-loop that this is a full investigation, it hands off to `DiagnosticAgent` with the anomaly context. The runtime catches the handoff, starts the diagnostic agent's loop with the context, and the user gets a real investigation instead of a query-shaped answer. Add `MAX_HOPS = 2` (query → investigation → recommendation maximum), and per-agent prompts that specify "only hand off if X is true." The route still owns the initial routing; handoff is an *escape hatch* for cases the route's classifier misjudged.

Diagram:
```
  Hybrid: centralized initial routing + handoff escape

  ┌────────────────────────────────────────────┐
  │ route.ts: classifyIntent → first agent     │
  └─────────────────┬──────────────────────────┘
                    ▼
  ┌─ QueryAgent ──────────────────────────────┐
  │ runs query loop                            │
  │ MAY emit transfer_to_investigation        │ ← escape hatch
  └──────┬─────────────────────────────────────┘
         │ if handoff
         ▼
  ┌─ DiagnosticAgent ─────────────────────────┐
  │ runs investigation loop                    │
  │ MAY emit transfer_to_recommendation       │
  └────────────────────────────────────────────┘
```

### The question candidates always dodge

Q: Isn't the diagnostic → recommendation pipeline already a handoff? The diagnostic agent's output becomes the recommendation agent's input.

A: It's a sequential pipeline, not a handoff — and the distinction is who decides the transition. In blooming insights, the *route* decides "after diagnostic is done, run recommendation"; the diagnostic agent doesn't decide it, it doesn't have a `transfer_to_recommendation` tool, it doesn't even know recommendation exists. The transition is a function call from the route (`recAgent.propose(inv, diagnosis!, hooksFor('recommendation'))` in `route.ts` L247) with the typed `Diagnosis` as an argument. In real handoff, the diagnostic agent's *model* would have to emit a tool_use saying "I'm done; hand off to recommendation" — and that decision is what makes it a handoff. The pipeline shape and the handoff shape can look similar in a diagram (A produces, B consumes) but they're architecturally different: in the pipeline, control flow is in code (centralized); in handoff, control flow is in the model (distributed). If I called the pipeline a handoff, I'd be claiming runtime model-decided routing the codebase doesn't have — and the failure modes that come with it (infinite handoff) don't apply because the diagnostic agent has no choice to make.

Diagram:
```
Pipeline vs handoff — same direction, different controller

  ┌─ PIPELINE (this codebase) ─────────────────────────┐
  │  route.ts:                                          │
  │    diag.investigate() → diagnosis                   │
  │    rec.propose(_, diagnosis, _)  ← route calls it   │
  │  control: ROUTE decides (deterministic)             │
  │  failure modes: pipeline order can't drift          │
  └─────────────────────────────────────────────────────┘

  ┌─ HANDOFF (not this codebase) ──────────────────────┐
  │  DiagnosticAgent loop:                              │
  │    emits tool_use("transfer_to_recommendation",    │
  │                    { diagnosis }) ◄── MODEL decides│
  │  runtime starts RecommendationAgent with context   │
  │  control: MODEL decides at runtime                  │
  │  failure modes: infinite handoff, context loss      │
  └─────────────────────────────────────────────────────┘
```

### One-line anchors

- "Swarm is peer agents transferring control to each other at runtime — model-decided routing, with infinite handoff as the failure mode you have to cap."
- "blooming insights doesn't have handoff — control is centralized in the route, and the next-agent decisions are knowable."
- "Pipeline and handoff can look similar; the difference is whether *code* or the *model* decides the transition."
- "Reach for handoff when peer specialists need runtime routing the route can't express, with a `MAX_HOPS` counter as the structural backstop."

---

## Validate your understanding

### Level 1 — Reconstruct the diagram

Close this file. Draw the swarm shape from memory: peer agents with bi-directional handoff arrows, a handoff counter as a guardrail, and the infinite-handoff failure mode as a labeled cycle. Then annotate why blooming insights doesn't have this shape today (control is centralized in the route).

Open the file. Compare.

✓ Pass: you drew peer agents with bi-directional arrows, named the `MAX_HOPS` counter, and labelled where the codebase sits (centralized, not swarm)
✗ Fail: re-read How it works Layers 1–2 and the diagram, wait 10 minutes, try again.

### Level 2 — Explain it out loud

Explain to a colleague who said "we have multiple agents, so it's a swarm, right?" — under 90 seconds, no notes.

Checkpoints — did you:
- Distinguish multiple-agents (true) from swarm-handoff (false in this codebase)?
- Say where control lives (the route, not the agents)?
- Name the failure mode handoff would introduce (infinite handoff)?
- Reference `./09-coordination-failure-modes.md` for the mitigation?

If you skipped any: you described what's there, you didn't name what's not there.

### Level 3 — Apply it to a new scenario

A product manager wants the QueryAgent to "automatically escalate to a full investigation if the question is actually about an anomaly" — without requiring the user to know which is which.

Without looking at the file: is this a handoff? Where does it slot into `route.ts`? What `transfer_to_*` tool would `QueryAgent` need? What context does it pass? How do you bound the failure mode?

Write your answer (3–5 sentences). Then open `lib/agents/query.ts` L41–L42 and `app/api/agent/route.ts` L210–L218 (the query branch) and check whether the handoff would be at the agent layer or the route layer.

### Level 4 — Defend the decision you'd change

"If you were starting this project today and you knew the QueryAgent would frequently encounter questions that should really be investigations, would you build the QueryAgent → DiagnosticAgent path as a handoff, or as a route-level re-dispatch (the route detects 'this is actually an investigation' and starts the DiagnosticAgent)? Why? What's the failure mode you'd accept in either case?"

Reference the code: `app/api/agent/route.ts` L199–L218 (route-level routing today), `lib/agents/intent.ts` L14 (`CLASSIFIER_MODEL = 'claude-haiku-4-5-20251001'`), `lib/agents/query.ts` L41–L42 (current single-agent shape).

### Quick check — code reference test

Without opening any files:
- Does blooming insights have peer handoff between agents? (Yes / No)
- Where is control centralized today?
- What's the failure mode every handoff system has to bound, and what's the standard mitigation?

Open and verify. ✓ File + function names matter; line numbers drifting is fine.

---
Updated: 2026-05-29 — created
