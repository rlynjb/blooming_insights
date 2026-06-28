# Swarm / handoff

*Industry name: swarm / handoff / peer-to-peer agents — Industry standard (OpenAI's "Swarm" SDK).*

Peer-to-peer control transfer, no central boss — the model itself decides when to hand off to a specialist. **Not in this repo and unlikely to be.** This repo's orchestration is deterministic route code; there's no agent-to-agent handoff decision.

## Zoom out — where this concept would live

If adopted, it would replace the route handler's `if (step === X)` dispatch with agent-emitted handoff decisions. The model would say "I should hand this to the recommendation agent" instead of the URL deciding.

```
  Where swarm WOULD live (would replace the code supervisor)

  ┌─ Service layer ─────────────────────────────────────────┐
  │  Today:  route handler decides which agent runs (CODE)  │
  │  Future: an agent decides who to hand off to (MODEL)    │ ← would live here
  │          via a `handoff_to_agent` tool call             │
  └──────────────────────────────────────────────────────────┘
```

## How it works

### Move 1 — the mental model

Imagine each agent has a `handoff_to_agent(target_agent)` tool in its grant. Calling that tool transfers control to the named agent, passing the current state. There's no central supervisor — agents pass control among themselves like a relay race.

```
  Swarm — peer-to-peer handoff, no boss

      ┌────────┐  "you take it"  ┌────────┐
      │agent A  │ ──────────────► │agent B  │
      └────────┘                 └───┬────┘
           ▲                         │ "back to you"
           └─────────────────────────┘
```

### Move 2 — why it's a bad fit for this repo

The workflow is **fixed**: briefing → diagnose → recommend. There's no decision for the agents to make about handoff order; the route already knows. Adding swarm here would mean:

- DiagnosticAgent gets a `handoff_to_recommendation` tool
- The model decides when to call it
- The decision is wasted because the URL `?step=recommend` already encodes the same answer for free

You'd be paying LLM tokens for the model to re-derive what TypeScript already knows. That's the LLM-supervisor anti-pattern from `01-when-not-to-go-multi-agent.md`, just expressed peer-to-peer instead of centrally.

The case where swarm WOULD make sense: a product where the user types a free-form request and the system has to decide which specialists chain together. "Plan a trip to Tokyo and book it" might handoff travel-research-agent → flight-booking-agent → hotel-booking-agent based on what each finds. The handoff decision is genuine because the chain isn't fixed.

### Move 3 — the principle

Swarm wins when handoff is a real decision and loses when it isn't. The product question is: do the agents need to decide *at runtime* which other agent runs next, based on what they're seeing? If yes (free-form user requests over heterogeneous specialists), swarm. If no (fixed product workflow), code supervisor.

The failure mode swarm introduces — infinite handoff (A → B → A → B → ...) — is one of the multi-agent failure modes covered in `09-coordination-failure-modes.md`. Mitigation: handoff counter; force stop or escalate to human after N handoffs.

## In this codebase

**Not implemented. Not planned.** The workflow is fixed; there's no handoff decision for agents to make. The route handler at `app/api/agent/route.ts` dispatches based on the URL `?step=` parameter — the closest equivalent of "handoff" is "the user navigated to the next page," which is the browser's job, not the model's.

## Primary diagram

The contrast — fixed workflow vs swarm-suitable workflow:

```
  Comparison — when swarm fits and doesn't

  THIS REPO (fixed workflow — swarm doesn't fit):
  ┌────────────┐  URL says   ┌────────────┐  URL says   ┌────────────┐
  │ Monitoring │ ──────────► │ Diagnostic │ ──────────► │ Recommend  │
  └────────────┘             └────────────┘             └────────────┘
  the order is in the URL; no agent decision

  HYPOTHETICAL SWARM-SUITABLE (open workflow):
  user types "plan a trip to Tokyo and book it"
              │
              ▼
        ┌──────────────┐
        │ research     │ ─→ handoff_to(flight_booker) if flights found
        └──────┬───────┘    handoff_to(hotel_booker) if hotels found
               │            handoff_to(human) if ambiguous
               ▼
        ┌──────────────┐
        │ flight booker│ ←→ might handoff back to research for more options
        └──────────────┘
        the chain isn't fixed; agents decide based on what they find
```

## Interview defense

**Q: "Do you use a swarm / handoff topology?"**

A: No. The workflow is fixed — briefing → diagnose → recommend — so there's no handoff decision for the agents to make. The URL `?step=` already encodes which agent runs next; making the model re-derive that with a `handoff_to_agent` tool call would burn tokens for free information. Swarm fits products where the chain isn't fixed — a travel-booking assistant that decides at runtime whether to handoff to flights vs hotels vs human. For a product like this one, where the workflow is the product, code dispatch wins.

The failure mode swarm exposes — infinite handoff (A → B → A → B) — is covered in `09-coordination-failure-modes.md`. The mitigation is a handoff counter, but the cheaper move is "don't use swarm when the workflow is fixed."

Anchor: "swarm trades the supervisor's centralized control for distributed agent decisions. The trade only pays off when the distribution is needed — open-ended user requests, not a fixed product workflow."

## See also

- [`02-supervisor-worker.md`](./02-supervisor-worker.md) — the centralized alternative this repo uses
- [`01-when-not-to-go-multi-agent.md`](./01-when-not-to-go-multi-agent.md) — the gate that filters swarm out
- [`09-coordination-failure-modes.md`](./09-coordination-failure-modes.md) — infinite handoff and its mitigation
