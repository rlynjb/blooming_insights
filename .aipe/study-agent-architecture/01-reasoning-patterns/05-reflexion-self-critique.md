# Reflexion / self-critique loop

*Industry name: Reflexion / self-critique / verifier-critic — Industry standard.*

The agent grades its own output and retries. Not in this repo. The streamed trace + the human reading it IS the reflexion loop here.

## Zoom out — where this concept would live

If adopted, it'd be a second agent layered on top of an existing one — e.g., a `DiagnosisCritic` that re-reads a finished diagnosis and either approves it or sends it back. It'd sit between the producing agent and the route's `send(diagnosis)` call.

```
  Where reflexion WOULD live (not yet implemented)

  ┌─ Service layer ───────────────────────────────────────────┐
  │  /api/agent?step=diagnose                                  │
  │   diagnosis = diagAgent.investigate(anomaly)               │
  │   ★ critic = criticAgent.review(diagnosis) ★ ← would go here│
  │   if critic.flawed → diagnosis = diagAgent.investigate(...)│
  │   send({ type: 'diagnosis', diagnosis })                   │
  └────────────────────────────────────────────────────────────┘
```

## Structure pass

The axis: **who catches a flawed answer before it ships?**

```
  Today (no reflexion):                  With reflexion:
  ────────────────────                   ──────────────────
  producer → ship → human notices       producer → critic → maybe re-run
                                                      │
                                                      └→ approve → ship
```

In this repo the right column is the human reading the StatusLog trace. The product surface *is* the reflexion — the user can see every tool call, every hypothesis, every conclusion, and re-run the investigation if it's wrong. That's a real reflexion loop; it's just got a human in the critic slot.

## How it works

### Move 1 — the mental model

It's a `try-catch` where the `catch` is another LLM. The producer agent emits a draft; the critic agent reads it and decides "good enough" or "go again with this feedback." You already know `try-catch`: if the operation fails some predicate, you do something different. Reflexion's predicate is just "the critic LLM said no."

```
  Reflexion — base producer + critic loop

  ┌──────────────────────────────────────────────┐
  │  base producer (ReAct) → draft answer        │
  └────────────────────┬─────────────────────────┘
                       ▼
  ┌──────────────────────────────────────────────┐
  │  critic step: "is this correct / complete?"  │
  └─────────┬─────────────────────┬──────────────┘
            ▼ approved            ▼ flawed
       return                 revise + loop
                              (cap the retries — usually 2-3)
```

### Move 2 — what it would look like in this repo

A `DiagnosisCritic` would read the diagnosis JSON and check:
- Does every claim in `evidence[]` cite a tool result the producer actually ran?
- Are the `hypothesesConsidered[]` actually competing, or just three rephrasings of one?
- Is the `affectedCustomers.count` plausible relative to the workspace's total customers?

If any check fails, the critic emits feedback ("hypothesis 2 and 3 are the same; the affected count exceeds total customers") and the diagnostic agent runs again with the critique appended to its prompt.

Sketch of where it'd plug in:

```
  Hypothetical: critic layered on the existing diagnostic loop

  ┌─ DiagnosticAgent.investigate(anomaly) ───────┐
  │  diagnosis = runAgentLoop(...)               │
  └──────────────────┬───────────────────────────┘
                     ▼
  ┌─ DiagnosisCritic.review(diagnosis) ──────────┐
  │  prompt: "check this diagnosis for: evidence │
  │   grounding, hypothesis diversity, plausible │
  │   counts. Return { approved: bool, feedback }"│
  │  ONE LLM call, no tools                       │
  └──────────────────┬───────────────────────────┘
                     │
              ┌──────┴──────┐
              ▼ approved    ▼ flawed
          return         re-run diagnostic with:
                         prompt += `Previous attempt rejected: ${feedback}`
                         (cap: 2 retries total)
```

### Move 3 — the principle

A model critiquing its own output shares the blind spots that produced the output. Reflexion catches format errors and obvious mistakes well; it catches subtle reasoning errors poorly. The fix when stakes justify it: use a *different model family* for the critic (Claude reviewing GPT, or vice versa) so the blind spots don't align. The cost: 2-5x tokens for one extra reliability step. The win: catches errors that would otherwise reach the user.

## In this codebase

**Not yet implemented as a separate agent.** The streamed AgentEvent trace IS the reflexion loop with a human in the critic slot — the user sees the diagnostic agent's hypotheses, tool calls, and conclusion in the StatusLog and can re-run the investigation from the UI if the diagnosis looks wrong.

Why not implemented as code:
- **The product already has a critic — the user.** The StatusLog shows the trajectory; the user reads it and decides whether to trust the diagnosis. Adding an LLM critic without removing the human one just adds cost.
- **Quality ceiling not measured.** We don't have automated trajectory eval (see `../04-agent-infrastructure/04-agent-evaluation.md`), so we don't know how often the diagnostic agent produces a wrong-but-plausible diagnosis the human critic misses. Without that data, the case for an LLM critic is theoretical.
- **The grounding constraint already does some of the work.** The diagnostic prompt requires every evidence item to cite an observed tool result — a structural guard that catches the most common "made-up facts" failure without a second agent.

The case for adopting it: when the product moves from "an analyst's assistant" (human in the loop) to "an autonomous analyst" (no human review). At that point an LLM critic is one of the cheapest ways to catch failures.

## Primary diagram

The product as it is — the streamed trace as the reflexion surface — vs the hypothetical LLM critic addition:

```
  Comparison — today's human critic vs hypothetical LLM critic

  TODAY (human in the critic slot):           HYPOTHETICAL (LLM critic):
  ┌──────────────┐                            ┌──────────────┐
  │ DiagAgent    │                            │ DiagAgent    │
  └──────┬───────┘                            └──────┬───────┘
         │ diagnosis + trace                          │ diagnosis
         ▼                                            ▼
  ┌──────────────┐                            ┌──────────────┐
  │ StatusLog UI │                            │ DiagnosisCritic
  │ (the human   │                            │ (LLM, no     │
  │  reads &     │                            │  tools, 1    │
  │  decides)    │                            │  call)       │
  └──────────────┘                            └──────┬───────┘
                                                     │
                                          ┌──────────┴──────────┐
                                          ▼ approve             ▼ flawed
                                       ship                  re-run diag
                                                             (cap retries=2)
```

## Elaborate

Reflexion as a named pattern comes from Shinn et al. (2023) — "Reflexion: Language Agents with Verbal Reinforcement Learning." The paper's claim: instead of fine-tuning to recover from errors, let the model reflect on a failed attempt in natural language and try again. The verbal feedback became part of the next attempt's context. Self-critique variants (verifier-critic, judge-then-revise) followed the same shape.

The production tax is real and underappreciated: every reflexion round is a full agent turn (or a critic turn plus a producer turn). On a multi-agent system that's already 3x a single-agent system, adding reflexion makes it 6-10x. The case has to be specific — "this output is high-stakes AND a different-family critic catches errors the producer can't."

The "use a different model family" guidance is the underused fix. The Anthropic-as-critic-of-Anthropic version of reflexion shares the model's biases; Anthropic-as-critic-of-OpenAI doesn't. For this repo, that would mean a haiku critic on a sonnet producer — cheap, plausible to deploy when the case shows up.

## Interview defense

**Q: "Did you consider a self-critique loop on the diagnosis?"**

A: Considered, didn't ship. The streamed trace IS the reflexion loop with a human in the critic slot — the user sees every tool call and hypothesis in the StatusLog and can re-run the investigation. Adding an LLM critic right now would add cost without removing the human critic; we'd be paying twice for the same check.

The case for adopting it would be the autonomous-analyst version of the product — no human reviewing. At that point I'd add a haiku critic (different size from the sonnet producer, partially addresses the shared-blind-spots problem) reviewing the diagnosis JSON against three structural rules: every evidence item cites a real tool call, the hypotheses are actually distinct, the affected-customers count is plausible. Cap retries at 2.

Diagram I'd sketch:

```
  ┌─ producer (DiagAgent, sonnet) ─┐
  │  → diagnosis JSON              │
  └──────────────┬─────────────────┘
                 ▼
  ┌─ critic (haiku, structural rules) ─┐
  │  approve OR flaw + feedback         │
  └──────────────┬──────────────────────┘
                 │   flawed → loop (cap=2)
                 ▼
              ship
```

Anchor: "the diagnostic prompt already requires evidence-grounded claims. That structural constraint catches the most common failure (made-up facts) without an LLM critic. Reflexion adds value where the failure is subtle reasoning, not factual grounding."

**Q: "Why not just use the model to grade its own output?"**

A: Because the model's blind spots are the same ones that produced the bad output. If the producer hallucinated a count, the same model will rationalize it as plausible on review. The fix that actually moves the needle is a critic from a different model family (haiku vs sonnet, different vendor entirely) — different training data, different bias profile. The product wisdom from people who've shipped this: a same-model critic catches format bugs reliably and reasoning bugs unreliably; a different-family critic catches both.

## See also

- [`03-react.md`](./03-react.md) — the producer ReAct agent that would be critiqued
- [`../03-multi-agent-orchestration/05-debate-verifier-critic.md`](../03-multi-agent-orchestration/05-debate-verifier-critic.md) — the multi-agent framing of the same pattern
- [`../04-agent-infrastructure/04-agent-evaluation.md`](../04-agent-infrastructure/04-agent-evaluation.md) — what's currently in the critic slot (the human + the trace)
