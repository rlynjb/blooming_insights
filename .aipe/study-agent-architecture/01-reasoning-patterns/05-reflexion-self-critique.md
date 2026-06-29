# Reflexion / self-critique

**Industry standard.** A loop structure layered on a base reasoning pattern. **Not yet implemented** in this codebase.

## Zoom out, then zoom in

Sits *outside* the inner agent loop — wraps it. The base pattern (ReAct) produces a draft; a critic step decides whether to accept or loop.

```
  Zoom out — where this concept WOULD live

  ┌─ Reasoning layer ───────────────────────────────┐
  │  ★ Reflexion wrapper (not in this repo) ★      │ ← we are here
  │  loop { base ReAct → critic → accept or revise } │
  └────────────────────────────┬────────────────────┘
                               │
  ┌─ Runtime layer ───────────▼────────────────────┐
  │  runAgentLoop  (one base ReAct loop per draft)  │
  └─────────────────────────────────────────────────┘
```

This file places reflexion in the escalation family alongside plan-and-execute. They're orthogonal — plan-and-execute escalates "the model wanders during reasoning"; reflexion escalates "the model produces plausible-but-wrong outputs."

**The recovery prompt in `runAgentLoop` is not reflexion.** That confusion is worth heading off — see the next section.

## Structure pass

Layers: producer (the base reasoning loop) → critic (a separate prompt or model judging the producer's output) → revise loop (with a cap on rounds).

**Axis traced — "who catches mistakes?":** in plain ReAct, the model catches its own as it goes. In reflexion, a *separate prompt* (sometimes a separate model entirely) catches mistakes after the producer commits to an answer. The axis flips at the critic boundary.

**Seam:** the producer's draft output is the typed handoff. The critic reads it (plus the trajectory that produced it) and emits a verdict — accept, or revise with a specific failure named.

## How it works

### Move 1 — the mental model

You know the difference between writing a function and writing it after code review. Plain ReAct is writing the function — the model reasons, acts, observes, commits. Reflexion is writing it, then having a reviewer look at it before you ship — *"this output's hypotheses don't actually rule out the simpler explanation; revise."*

```
  The reflexion loop — base pattern plus a critic gate

  ┌─ base pattern (one ReAct run) produces a draft ──┐
  │  monitoring/diagnostic/recommendation agent      │
  │  emits its structured answer                      │
  └────────────────────┬─────────────────────────────┘
                       ▼
  ┌─ Critic step ──────────────────────────────────┐
  │  separate model call: "is this correct /        │
  │  complete / well-grounded?"                     │
  └────────────────────┬─────────────────────────────┘
              ┌─────────┴─────────┐
              ▼ good              ▼ flawed
          return            revise + loop
          (commit)          (re-run producer
                            with critic's notes)
                                  │
                                  └── cap the retries
```

### Move 2 — step by step

#### What this would look like in this repo

The diagnostic agent is the natural candidate. The diagnosis output has a `hypothesesConsidered` array (`lib/mcp/types.ts:97`) — each hypothesis tagged supported/unsupported. A critic could read the diagnosis and ask:

- Does the conclusion actually follow from the supported hypotheses?
- Are there obvious alternative hypotheses the producer didn't consider?
- Does the affected-customers count match the evidence?

Hypothetical wrapper:

```ts
// hypothetical lib/agents/reflexive-diagnostic.ts (not implemented)
class ReflexiveDiagnosticAgent {
  constructor(
    private producer: DiagnosticAgent,    // today's class
    private critic: ModelProvider,         // ideally a DIFFERENT model family
    // ... other ports
  ) {}

  async investigate(
    anomaly: Anomaly,
    hooks: AgentHooks,
    maxRounds = 2,
  ): Promise<Diagnosis> {
    let diagnosis = await this.producer.investigate(anomaly, hooks);
    for (let round = 0; round < maxRounds; round++) {
      const verdict = await this.critic.complete({
        system: CRITIC_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: JSON.stringify({ anomaly, diagnosis }) }],
        maxTokens: 1024,
      });
      const parsed = parseVerdict(verdict.content);
      if (parsed.accept) return diagnosis;
      // re-run with the critic's notes appended
      diagnosis = await this.producer.investigate(
        { ...anomaly, criticNotes: parsed.notes },
        hooks,
      );
    }
    return diagnosis;  // out of rounds — return the last draft
  }
}
```

#### The hard limit that matters

A model critiquing its own output shares the blind spots that produced the output. If the producer is Claude Sonnet 4.6 and the critic is *also* Claude Sonnet 4.6, the critic will miss exactly the things the producer missed. Self-critique catches format and obvious-error failures well; it catches subtle-reasoning failures poorly because the failure mode that produced the wrong answer is the same failure mode that grades it.

Mitigation: use a *different model family* for the critic when the stakes justify it. Anthropic blog post `claude-as-judge`: the self-preference bias is real and measurable. For this repo, a hypothetical reflexion wrapper would want the critic to be GPT-4 or a different Claude generation, not the same Sonnet that produced the diagnosis. This is the same bias-against-self problem named in (future) `study-ai-engineering`'s LLM-as-judge file.

#### The cost is 2-5x

One extra full agent turn per round (the critic call), plus potentially another full producer run per round if the critic rejects. Two rounds bounded means: best case 1x cost (critic accepts the first draft), worst case 3x cost (two revisions before the cap fires). The repo runs ReAct without this overhead because the existing failure rate doesn't justify the multiplier.

#### Why the recovery prompt is NOT reflexion

A common confusion. `runAgentLoop`'s `recoveryPrompt` (lines 106-114 of `run-agent-loop.js`) fires when the structured-output parser (`tryParseAnomalies`) returns null — the model emitted text that wasn't a valid JSON array. The recovery prompt re-asks the *same model* with just the tool evidence and a "convert this to the structured form" instruction.

That's structured-output recovery, not self-critique. The recovery prompt isn't asking "was the answer correct?" — it's asking "format the answer correctly." It has no critic. It has no notion of acceptance vs revision. It runs once unconditionally (when parse fails) and accepts whatever comes back.

Reflexion is a *judgment loop*; recovery is a *format loop*. They look similar from a distance because both involve a second model call after the main loop, but the failure mode they address is different.

### Move 3 — the principle

**Reflexion catches a specific class of failures: plausible-but-wrong outputs.** The producer's loop produces something that looks reasonable, follows from the evidence, and is structurally correct — but the conclusion is subtly off (the wrong hypothesis was followed, an obvious alternative wasn't tested, the affected-customer count is off by an order of magnitude). The producer has no signal to catch this because the producer is the source of the mistake. A critic with a different prompt — and ideally a different model — has an independent shot.

The interview-grade move is to name the failure mode reflexion catches, not to add it preemptively. Adding reflexion to a pipeline whose failures are "format drift" or "tool-call errors" pays the 2-5x tax for no win.

## Primary diagram

```
  Reflexion as a wrapper around the base agent

  ┌──────────────────────────────────────────────────────────┐
  │  ReflexiveDiagnosticAgent.investigate(anomaly)            │
  │                                                            │
  │  ┌─ round 0 ──────────────────────────────────────────┐   │
  │  │  producer.investigate(anomaly)                       │   │
  │  │   ─► runAgentLoop (the base ReAct)                  │   │
  │  │   ─► draft Diagnosis                                │   │
  │  └─────────────────────┬──────────────────────────────┘   │
  │                        ▼                                    │
  │  ┌─ critic gate (different model family ideally) ─────┐   │
  │  │  critic.complete({system: CRITIC_PROMPT, ...})      │   │
  │  │  → verdict = { accept | revise + notes }            │   │
  │  └─────────────────────┬──────────────────────────────┘   │
  │           ┌─────────────┴─────────────┐                    │
  │           ▼ accept                    ▼ revise              │
  │       return diagnosis           round++; if < maxRounds:  │
  │                                  producer.investigate(      │
  │                                    {anomaly, criticNotes:   │
  │                                     verdict.notes})         │
  │                                  ─── else: return last draft│
  └────────────────────────────────────────────────────────────┘
```

## Elaborate

The original Reflexion paper (Shinn et al., 2023) framed it as agent learning across episodes: the agent runs a task, reflects on what went wrong, stores the reflection in a memory buffer, and the next attempt at a similar task pulls from that buffer. That's the cross-task version — multi-turn within an episode AND cross-episode learning. The version this file covers is the simpler intra-task variant: producer → critic → revise, within a single task.

The cross-task version is interesting for agents that handle a stream of similar tasks (e.g. a coding agent solving many bugs in the same repo) because the reflections accumulate into something like a learned playbook. It's less useful for this repo's shape — each anomaly investigation is one-off and the reflections wouldn't transfer to the next anomaly.

The cousin pattern is *verifier-critic* in a multi-agent topology (`03-multi-agent-orchestration/05-debate-verifier-critic.md`). That's the same idea expressed as "two named agents, one produces, one critiques" rather than "one agent run twice with different prompts." Functionally equivalent; the multi-agent framing is just more explicit about the role separation.

## Interview defense

> **Q: Does this codebase do self-critique anywhere?**
>
> No, and the absence is deliberate. The recovery prompt in `runAgentLoop` looks like self-critique from a distance but it isn't — it fires when the structured-output parser fails (the model emitted text instead of JSON) and re-asks the same model to format correctly. It's a format loop, not a judgment loop. The reason there's no judgment loop: the dominant failure modes in this repo are tool-call errors (the EQL returns an unexpected shape) and rate-limit retries, not "the diagnosis was plausible-but-wrong." If we started shipping diagnoses that customers told us were confidently wrong, that would be the signal to add reflexion — specifically, with a different model family as the critic to avoid the self-preference bias.

> **Q: What's the self-preference problem and why does it matter here?**
>
> A model critiquing its own output shares the blind spots that produced the output. Claude Sonnet 4.6 will systematically rate Claude Sonnet 4.6 outputs higher than equivalent outputs from GPT-4. If we ran self-critique with the same model on both sides, the critic would accept exactly the diagnoses we want it to catch. The fix is to use a different model family for the critic — different training data, different RLHF, different blind spots. That's a small change at the `ModelProvider` adapter layer (pass a different model to `AnthropicModelProviderAdapter`, or swap in an `OpenAIModelProviderAdapter`) but it's the load-bearing one.

> **Q: How is this different from plan-and-execute?**
>
> Orthogonal escalations from baseline ReAct. Plan-and-execute solves "the model wanders during reasoning" by deciding the strategy up front. Reflexion solves "the model produces plausible-but-wrong outputs" by adding a critic after the producer commits. You'd add plan-and-execute when the path is knowable but long; you'd add reflexion when the path is fine but the answer is wrong. They can compose — plan-and-execute with a reflexion check after each execute step — but the cost of both layered on is 4-7x, which is rarely worth it.

## See also

- → `03-react.md` — the producer pattern reflexion wraps
- → `04-plan-and-execute.md` — the orthogonal escalation
- → `03-multi-agent-orchestration/05-debate-verifier-critic.md` — the multi-agent version of the same idea
- → cross-reference (when generated): `study-prompt-engineering`'s self-critique file — the prompt-level mechanics
- → cross-reference (when generated): `study-ai-engineering`'s LLM-as-judge file — the self-preference bias
