# Swarm / handoff

*Industry names: swarm / peer handoff · Language-agnostic*

## Zoom out

```
  Zoom out — peer-to-peer control transfer (not used here)

  ┌─ SECTION C topologies ──────────────────────┐
  │  supervisor-worker (this repo — code sup.)   │
  │  sequential pipeline                         │
  │  parallel fan-out                            │
  │  debate / verifier-critic                    │
  │  ★ swarm / handoff (NOT used here) ★         │ ← we are here
  │  graph                                       │
  └──────────────────────────────────────────────┘
```

## Zoom in

Peer-to-peer control transfer, no central boss. One agent decides to hand control to a peer specialist; the peer can hand it back or forward to another peer. More flexible than supervisor-worker (no central bottleneck), harder to debug (no single point that knows the whole state). Not used in this repo, and deliberately so — the code supervisor is a stronger fit for the product shape.

## Structure pass

Layers: **agent A** — **handoff message (with new context)** — **agent B** — (loop) — **any peer**.

Axis to hold constant: **who owns the current turn?**

```
  Ownership over time — the axis flips with each handoff

  turn 1: agent A owns
  turn 2: A hands to B; now B owns
  turn 3: B works, hands to C; now C owns
  ...
  turn N: some agent emits final output

  Failure mode: infinite handoff loop
    A → B → A → B → …  no one commits to finishing
```

## How it works

### Move 1 — the shape

You've written a state machine where each state can transition to any other state before. Swarm is that shape where each state is an agent and transitions are handoff decisions the LLM makes.

```
  Swarm handoff — one message, control transfers

      ┌────────┐  "you take it"  ┌────────┐
      │agent A  │ ──────────────► │agent B  │
      └────────┘                 └───┬────┘
           ▲                         │ "back to you"
           └─────────────────────────┘
```

### Move 2 — why this repo doesn't use it, and when it would

**Why not here.** The product has three well-known stages (monitor → diagnose → recommend). The supervisor sequence is stable and UI-visible. Swarm would let, say, the diagnostic agent decide "I'm not sure — hand this to a specialist segment agent," which sounds flexible but:

1. **Breaks the UI stepper.** The `ProcessStepper` shows the user which step they're on. If the diagnostic silently hands to a different agent mid-stream, the user's mental model of the pipeline breaks.
2. **Debugging surface explodes.** A single request could touch any subset of agents in any order. Tracing which agent produced which token becomes a graph problem instead of a linear one.
3. **No specialty differentiation warrants it.** The four agents (monitoring, diagnostic, recommendation, query) have clean job boundaries. Nothing about "diagnose a specific USA anomaly" makes it useful to hand off to another agent mid-diagnosis.

**When swarm earns its cost.** Systems with many specialists where any specialist might need to consult any other, and the consultations can't be predicted at design time. Classic examples:

- **Customer support systems.** A general support agent hands to a billing specialist when the question turns billing-shaped, who might hand to a technical specialist when the billing question is really a technical bug. No supervisor can pre-enumerate all these routes.
- **Multi-domain research assistants.** A research question spans finance + medicine + policy; each specialist recognizes when the question needs input from another and hands off.

**OpenAI's Swarm framework as the reference implementation.** OpenAI's Swarm (Oct 2024, later folded into the Agents SDK) codified this pattern with `handoff` as a first-class primitive. An agent's tool set includes `transfer_to_billing_agent` as a callable; calling it hands the conversation to that agent. The framework tracks who owns the turn.

**The failure mode this pattern introduces.** Infinite handoff — A hands to B, B hands back to A, A hands back to B. Nothing forces termination. Mitigation is a **handoff counter** at the runtime level: cap total handoffs per request (say, 5), force stop or escalate to human when hit. This is covered in `09-coordination-failure-modes.md`.

**The other real failure — context loss across handoffs.** Each handoff has to carry enough context for the next agent to do useful work. Too little → the next agent lacks the info; too much → context bloat scales with handoff count. This is a form of the message-passing tradeoff (`08-shared-state-and-message-passing.md`) — the handoff message has to be curated.

### Move 3 — the principle

Swarm's flexibility is real but costly. It's the right shape when specialist consultation patterns can't be predicted; it's the wrong shape when the sequence is stable enough that a supervisor can pre-enumerate the routing. Naming it as "we considered swarm and stayed with code-routed supervisor because the sequence is stable" is a stronger interview answer than "we didn't think of it."

## Primary diagram

```
  Swarm — the general pattern, and the guards it needs

  ┌────────────────────────────────────────────────────────────────┐
  │                                                                │
  │   ┌────────┐         "transfer to        ┌────────┐            │
  │   │agent A │ ─────── billing_agent"────► │agent B │            │
  │   └────┬───┘                             └───┬────┘            │
  │        │                                     │                 │
  │        ▲                                     │ "transfer to    │
  │        │                                     ▼ technical"      │
  │        │                              ┌────────┐               │
  │        └────── "transfer back" ───────│agent C │               │
  │                                       └────────┘               │
  │                                                                │
  │  Guards required:                                              │
  │    - handoff counter (max 5 per request)                       │
  │    - shared BudgetTracker across all agents                    │
  │    - curated handoff message (not full history)                │
  │    - trace log of who owned each turn (for debug)              │
  │                                                                │
  └────────────────────────────────────────────────────────────────┘
```

## Elaborate

Swarm as a multi-agent pattern surfaced in production form with OpenAI's Swarm framework (Oct 2024) and CrewAI's `HierarchicalAgent` peer-handoff mode (2024). The pattern draws from the actor model (Erlang's `send`/`receive` between processes) and from human customer-service escalation patterns (tier-1 to tier-2 handoff).

The interesting contrast is swarm vs graph orchestration (`07-graph-orchestration.md`) — both are "no single supervisor," but graph makes the transitions explicit and pre-declared, while swarm makes them dynamic. Graph is more debuggable; swarm is more flexible. Production systems often start swarm and add graph structure as the routing patterns become known.

## Interview defense

**Q: Did you consider swarm for the multi-agent design?**

Considered and skipped. Swarm's advantage is dynamic specialist consultation — an agent can hand off to any peer when it recognizes the question needs a different specialty. That's powerful for open-ended customer-support-style systems where routing patterns can't be pre-enumerated.

Skipped for this repo because the three stages (monitor → diagnose → recommend) are stable and UI-visible. The user sees which step they're on via the ProcessStepper. If the diagnostic silently handed to a different agent mid-stream, the UI would break. Debug surface would also explode — traces become a graph problem instead of linear. Code-routed supervisor is a cleaner fit for this shape.

*Anchor visual:* the swarm-with-guards diagram above.

**Q: What's the specific failure mode swarm introduces?**

Infinite handoff — A hands to B, B hands to A, no one commits to finishing. Mitigation is a handoff counter at the runtime layer: max N handoffs per request, force stop or escalate to human when hit. OpenAI's Swarm framework builds this in; a bespoke implementation has to add it explicitly.

The other real failure is context loss across handoffs. The handoff message has to carry enough context for the next agent to be useful. Too little breaks the next agent; too much is context bloat scaled by handoff count. This is where the curated-handoff-message discipline lives — a subset of shared state, not the whole thing.

**Q: When would you reach for swarm?**

Customer support systems with many domain specialists, or multi-domain research where questions span areas at design time. When the routing patterns can't be pre-enumerated because the space of questions is too open, swarm's flexibility earns its cost. Not for products with stable pipelines like this one.

## See also

- **`02-supervisor-worker.md`** — the alternative this repo picked.
- **`07-graph-orchestration.md`** — the middle-ground between supervisor and swarm (explicit transitions, no central boss).
- **`08-shared-state-and-message-passing.md`** — the handoff message is a form of message passing.
- **`09-coordination-failure-modes.md`** — infinite handoff and its handoff-counter mitigation.
