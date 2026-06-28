# Debate / verifier-critic

*Industry name: debate / verifier-critic / multi-agent argument — Industry standard.*

Agents argue or critique each other to refine quality. **Not in this repo as code** — the StatusLog UI plus a human reading it IS the verifier-critic loop here. Cover the multi-agent framing of `01-reasoning-patterns/05-reflexion-self-critique.md`.

## Zoom out — where this concept would live

If adopted, a critic agent would sit between a producing agent and the route's `send(diagnosis)` call. In the multi-agent version (as opposed to reflexion's single-agent version), the critic is a *separate AptKit-backed class*, not a second pass within the same agent.

```
  Where the critic WOULD live (not yet implemented)

  ┌─ Service layer ───────────────────────────────────────────┐
  │  /api/agent?step=diagnose                                  │
  │   diagnosis = diagAgent.investigate(anomaly)               │
  │   ★ critique = critic.review(diagnosis) ★ ← would go here  │
  │   if critique.flawed → diagnosis = diagAgent.investigate(  │
  │      anomaly, { feedback: critique.reasoning })            │
  │   send({ type: 'diagnosis', diagnosis })                   │
  └────────────────────────────────────────────────────────────┘
```

## Structure pass

The axis: **who catches a bad answer before it ships?**

```
  Two flavors of multi-agent quality check

  Debate (symmetric):                  Verifier-critic (asymmetric):
  ─────────────────                    ────────────────────────────
  two agents argue                     one agent produces, one reviews
  same task, different perspectives    producer never sees critic's prompt
  a judge agent picks the winner       critic loops back to producer
                                       with explicit feedback
  cost: 2x agents + 1 judge call/round cost: producer + critic per check
  buy: catches reasoning errors        buy: catches output errors a
       neither would catch alone            single producer routinely misses
```

## How it works

### Move 1 — the mental model

You know code review — a developer writes, a reviewer reads, they go back and forth until the reviewer signs off. Verifier-critic is code review with two LLM agents. Debate is two developers arguing and a tech lead picking the better argument. Both work; verifier-critic is cheaper and the production default.

```
  Debate and verifier-critic — two shapes

  Debate (symmetric):              Verifier-critic (asymmetric):
  ┌────────┐   ┌────────┐          ┌──────────┐   ┌──────────┐
  │agent A  │◄─►│agent B  │         │ producer │──►│ critic   │
  │(propose)│   │(counter)│         │          │◄──│(approve/ │
  └────────┘   └────────┘          └──────────┘   │ reject)  │
       │            │                              └──────────┘
       └─────┬──────┘                    loop until approved
             ▼                           (cap the rounds)
        judge picks
```

### Move 2 — what verifier-critic would look like for the diagnostic agent

A `DiagnosisCritic` would be a third AptKit class — similar wrapper shape to `DiagnosticAgent`, with a prompt that takes a finished diagnosis and asks:

- Does every claim in `evidence[]` cite a tool result the producer actually ran?
- Are the `hypothesesConsidered[]` actually competing, or three rephrasings of one?
- Is the `affectedCustomers.count` plausible relative to the workspace's total customers?
- Did the producer rule out the obvious-but-unstated hypothesis?

Sketch of the integration:

```typescript
// hypothetical lib/agents/diagnostic-critic.ts
export class DiagnosisCritic {
  // returns { approved: bool, feedback?: string }
  async review(diagnosis: Diagnosis, anomaly: Anomaly): Promise<CritiqueResult> {
    const agent = new AptKitCriticAgent({
      model: new AnthropicModelProviderAdapter(this.anthropic, 'critic', this.sessionId, 'claude-haiku-4-5-20251001'),
      tools: emptyToolRegistry, // no tools — pure analysis
      // ... one LLM call, structural rules in the prompt
    });
    return agent.review(diagnosis, anomaly);
  }
}
```

Note the model choice: `claude-haiku-4-5-20251001`, not sonnet. A different size from the producer — this is *partial* protection against the shared-blind-spots failure (a same-model critic shares the same biases that produced the bad output). A different model FAMILY would be fuller protection but adds vendor cost.

The route would gain a critic-loop:

```typescript
// hypothetical app/api/agent/route.ts (the new critic gate)
let diagnosis = await diagAgent.investigate(anomaly, hooks);
for (let attempt = 0; attempt < 2; attempt++) {
  const critique = await critic.review(diagnosis, anomaly);
  if (critique.approved) break;
  diagnosis = await diagAgent.investigate(anomaly, { ...hooks, feedback: critique.feedback });
}
send({ type: 'diagnosis', diagnosis });
```

The retry cap (2) is non-negotiable — without it, the producer-critic pair can ping-pong indefinitely.

### Move 3 — the principle

Critic agents earn their overhead when the producer's failure mode is "made a plausible-looking output that's subtly wrong." They don't help when the failure mode is "couldn't find the data" or "tool errored out" — those need a different fix. The cost is real: every approved diagnosis pays 1 critic call; every rejected one pays critic + producer + critic + maybe producer again. For high-stakes outputs that gate human action, the cost is worth it. For low-stakes drafts a human reviews, the human IS the critic and adding an LLM critic is double-paying.

## In this codebase

**Not implemented as code.** The verifier-critic loop in this product is fulfilled by the human reading the StatusLog:

- Every reasoning_step, every tool_call_start, every tool_call_end streams to the StatusLog UI
- The user sees the diagnostic agent's hypotheses, evidence-gathering queries, and conclusion
- If the diagnosis looks wrong, the user goes back and re-runs the investigation
- The human is the asymmetric critic

Why this is the right call right now:
- **Adding an LLM critic without removing the human one double-pays.** Both check the same output; the human's check is free.
- **No measured failure rate.** We have no automated trajectory eval (`../04-agent-infrastructure/04-agent-evaluation.md`) showing how often the diagnostic agent produces a wrong-but-plausible diagnosis the human critic misses. Without that data, the case for an LLM critic is theoretical.
- **The structural rule already does half the work.** The diagnostic prompt requires evidence-grounded claims; the validator at the AptKit layer rejects malformed output. That's catching the format-failure cases an LLM critic would also catch — cheaper.

The case for adopting it: the product moves to autonomous-analyst mode (no human review). At that point a haiku critic on a sonnet producer is one of the cheapest reliability adds.

## Primary diagram

The contrast:

```
  Comparison — today's human critic vs hypothetical LLM critic

  TODAY (human in the critic slot):           HYPOTHETICAL (LLM critic added):
  ┌─ DiagAgent (sonnet) ─┐                    ┌─ DiagAgent (sonnet) ─┐
  │  → diagnosis          │                    │  → diagnosis          │
  └──────────┬───────────┘                    └──────────┬───────────┘
             │ stream                                     ▼
             ▼ NDJSON                          ┌─ DiagnosisCritic (haiku) ─┐
  ┌─ StatusLog ─────────┐                      │  no tools                  │
  │  user reads trace,  │                      │  structural rules:         │
  │  decides whether to │                      │   - evidence-grounded?     │
  │  trust the diagnosis│                      │   - hypotheses distinct?   │
  └─────────────────────┘                      │   - count plausible?       │
                                                └──────────┬─────────────────┘
                                                           │
                                                ┌──────────┴──────────┐
                                                ▼ approve             ▼ flawed
                                              ship                  re-run diag
                                                                    (cap retries=2)
```

## Interview defense

**Q: "Do you use a critic agent on the diagnosis?"**

A: Not as code — the StatusLog UI plus the user reading it IS the verifier-critic loop. Every reasoning step and tool call streams to the sidebar; if the diagnosis looks wrong, the user re-runs the investigation. Adding an LLM critic right now would double-pay: both checks (LLM + human) review the same output, the human's check is free.

The case for adopting an LLM critic is the autonomous-analyst version of the product — no human reviewing. At that point I'd add a haiku critic (different size from the sonnet producer, partial protection against shared blind spots) checking three structural rules: evidence-grounded claims, distinct hypotheses, plausible affected-customer counts. Cap retries at 2 so the producer-critic pair can't ping-pong indefinitely.

Diagram I'd sketch:

```
  ┌─ producer (sonnet) ─┐         human critic (today):
  │  → diagnosis        │           StatusLog → user reads → re-run if wrong
  └──────────┬──────────┘
             ▼                     LLM critic (hypothetical):
  ┌─ critic (haiku) ─────┐           critic LLM → approve/feedback
  │  approve or reject   │           → loop with cap=2
  └──────────────────────┘
```

Anchor: "the diagnostic prompt already requires every claim to cite a tool result. That structural rule catches the most common failure (made-up facts) without an LLM critic. The escalation is for subtle reasoning errors, not factual grounding."

**Q: "Why a different model for the critic?"**

A: Because a same-model critic shares the producer's blind spots. The model that hallucinated a count will rationalize it as plausible on review. The cheapest fix that actually moves the needle is a different *size* (haiku reviewing sonnet) — partial protection. A different *vendor* (Anthropic reviewing OpenAI) is fuller protection but adds vendor cost. For this repo, haiku is the right starting point: it's already in the codebase for the intent classifier, no new vendor relationship, much cheaper than re-running sonnet for the critic. The pattern: spend the cheaper inference budget on the critic, the more expensive on the producer.

## See also

- [`../01-reasoning-patterns/05-reflexion-self-critique.md`](../01-reasoning-patterns/05-reflexion-self-critique.md) — the single-agent version of the same pattern
- [`../04-agent-infrastructure/04-agent-evaluation.md`](../04-agent-infrastructure/04-agent-evaluation.md) — what's currently in the critic slot (the human + the trace)
- ai-engineering's `LLM-as-judge` (cross-ref) — self-preference bias detail
