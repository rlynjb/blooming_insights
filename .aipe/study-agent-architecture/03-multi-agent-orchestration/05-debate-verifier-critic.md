# Debate / verifier-critic

**Industry standard.** Two agents argue or critique to refine quality. **Not exercised** in this codebase.

## Zoom out, then zoom in

Sits as a quality-refinement wrapper around a producer agent. The producer emits a draft; the critic (or the second debater) judges; the loop revises until accepted or capped.

```
  Zoom out — where this WOULD live

  ┌─ Reasoning layer ───────────────────────────────┐
  │  Producer agent (one ReAct loop)                 │
  │     ★ wrapped by debate or verifier-critic ★    │ ← we are here
  │  Critic agent (separate model family ideally)    │
  └──────────────────────────────────────────────────┘
```

The multi-agent expression of reflexion (`01-reasoning-patterns/05-reflexion-self-critique.md`). Same idea — catch plausible-but-wrong outputs — expressed as two named agents instead of one agent run twice.

## Structure pass

Layers: producer (the answer-generating agent) → critic or debate partner (the judging agent) → loop or judge.

**Axis traced — "what catches mistakes?":** in plain ReAct nothing does. In debate, the two agents catch each other's mistakes through argument. In verifier-critic, the critic catches the producer's mistakes through one-sided judgment.

**Seam:** the producer's draft is the typed handoff. The critic reads it (plus the trajectory that produced it) and emits a verdict. In symmetric debate, both agents see each other's drafts and a third "judge" agent picks.

## How it works

### Move 1 — the mental model

You know code review. Producer writes the function; reviewer reads it; if there's a problem, the reviewer comments and the producer revises. Two roles, one workflow. Debate is the same with two reviewers arguing about whether the function is right.

Two flavors:

```
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

Debate has two producers that disagree by design; a separate judge picks the winning argument. Verifier-critic has one producer and one critic; the critic accepts or sends back for revision.

### Move 2 — step by step

#### Where this could land in this repo

The diagnostic agent is the natural producer. Its output (`Diagnosis`) has a structured `hypothesesConsidered` array with `supported: bool` flags — a critic could read the diagnosis and ask:

- Did the conclusion actually follow from the supported hypotheses?
- Are there obvious alternative hypotheses that weren't tested?
- Is the affected-customers count consistent with the evidence?

A verifier-critic wrapper:

```ts
// hypothetical lib/agents/diagnostic-with-critic.ts (not implemented)
class CriticGatedDiagnosticAgent {
  constructor(
    private producer: DiagnosticAgent,
    private critic: ModelProvider,  // ideally a DIFFERENT model family
    // ... ports
  ) {}

  async investigate(anomaly: Anomaly, hooks: AgentHooks, maxRounds = 2): Promise<Diagnosis> {
    let diagnosis = await this.producer.investigate(anomaly, hooks);
    for (let round = 0; round < maxRounds; round++) {
      const verdict = await this.critic.complete({
        system: CRITIC_PROMPT,
        messages: [{ role: 'user', content: JSON.stringify({ anomaly, diagnosis }) }],
        maxTokens: 1024,
      });
      const parsed = parseVerdict(verdict.content);
      if (parsed.accept) return diagnosis;
      diagnosis = await this.producer.investigate(
        { ...anomaly, criticNotes: parsed.notes },
        hooks,
      );
    }
    return diagnosis;  // out of rounds — return last draft
  }
}
```

The critic's per-round cost is one extra model call (~$0.01-0.02). The producer's per-round cost is a full agent run (~$0.05-0.10). With `maxRounds=2`, best case is 1.1x baseline; worst case is 3x baseline.

#### The critic-model choice is load-bearing

A model critiquing its own output shares the blind spots that produced it. If the producer is Claude Sonnet 4.6 and the critic is *also* Claude Sonnet 4.6, the critic will miss exactly the things the producer missed. This is the self-preference bias documented in (future) `study-ai-engineering`'s LLM-as-judge file.

Mitigation: use a different model family for the critic. For this repo, the critic would want to be GPT-4 or a different Claude generation, not the same Sonnet. The `AnthropicModelProviderAdapter` (and a hypothetical `OpenAIModelProviderAdapter`) makes this swap a one-line change at construction.

#### When debate beats verifier-critic

Debate (symmetric) is better when the failure mode is "the producer is overconfident in one interpretation." Two agents arguing for opposite interpretations force the disagreement into the open; the judge has to weigh evidence rather than rubber-stamp one side. Verifier-critic (asymmetric) is better when the failure mode is "the producer makes correctness errors a check could catch" — the critic doesn't need to argue, just verify against a checklist.

For this repo's diagnostic agent, verifier-critic is the right choice if added — the failure mode would be "wrong but plausible diagnosis," not "right vs alternative interpretation." Debate is overkill for a single-conclusion task.

#### The cost ceiling

Every round is a full producer-and-critic exchange. If 2 rounds are the cap, the worst-case cost is 3x baseline. The breakeven analysis: if the critic catches a wrong diagnosis 25% of the time AND the average cost of shipping a wrong diagnosis (user re-investigates manually, lost trust) is 3x a normal investigation, the critic earns its overhead. Below 25% catch rate, it's a tax for no win.

### Move 3 — the principle

**Verifier-critic catches a specific class of failures: plausible-but-wrong outputs.** The producer commits an answer that follows from the evidence and is structurally correct — but the conclusion is subtly off. The producer has no signal to catch this because the producer is the source of the mistake. The critic with a different prompt — and ideally a different model — has an independent shot. Debate is the variant for "two interpretations both have merit; pick one." Both are escalations from baseline ReAct; both pay a 2-3x cost; both are only worth it when the catch rate × the cost-of-shipping-wrong exceeds the overhead.

## Primary diagram

```
  Verifier-critic wrapping the diagnostic agent (hypothetical)

  ┌─ CriticGatedDiagnosticAgent.investigate(anomaly) ─────────────┐
  │                                                                  │
  │  round = 0                                                       │
  │  diagnosis = producer.investigate(anomaly)  // existing class    │
  │                                                                   │
  │  while round < maxRounds (2):                                    │
  │     ┌─ critic.complete (DIFFERENT model family ideally) ──────┐ │
  │     │  system: CRITIC_PROMPT                                   │ │
  │     │  input: { anomaly, diagnosis }                           │ │
  │     │  output: { accept: bool, notes?: string }                │ │
  │     └────────────────────────┬─────────────────────────────────┘ │
  │                              ▼                                    │
  │     if verdict.accept: return diagnosis                          │
  │     diagnosis = producer.investigate({                           │
  │       ...anomaly,                                                 │
  │       criticNotes: verdict.notes  // re-run with the feedback     │
  │     })                                                            │
  │     round++                                                       │
  │                                                                   │
  │  return diagnosis  // out of rounds — return last draft           │
  └──────────────────────────────────────────────────────────────────┘
```

## Elaborate

The verifier-critic pattern shows up in production agent systems for high-stakes outputs — code-generating agents with a test-running critic, customer-facing summary agents with a "is this true to the source?" critic, autonomous-action agents with a "is this action safe?" critic. The shared property: the cost of shipping a wrong answer is meaningfully higher than the cost of one extra critic round, AND the wrong answer is detectable by a check the producer didn't run.

Code-generating agents are the canonical successful case because the test runner IS the critic. The producer writes the code; the critic runs the tests; the verdict is exit-code 0 or not. The cost of wrong code (a bug ships) is high; the cost of running tests is low; the critic catches a high percentage of mistakes. All three conditions align.

The conditions don't align as cleanly for "diagnose an anomaly correctly." The cost of a wrong diagnosis is medium (the user has to think harder, maybe re-investigate); the critic call costs ~$0.01-0.02 per round; the catch rate is unknown but probably moderate (Claude critiquing Claude has self-preference bias; cross-family critics are better but still imperfect). For this repo today the math doesn't justify the overhead; for a future high-stakes use of the diagnostic agent (say, automatic action-taking based on the diagnosis) the math would change.

## Interview defense

> **Q: Does this codebase have a critic anywhere?**
>
> No. Every agent's output is taken at face value. The closest thing is the structured-output validator chain — `tryParseAnomalies`, `tryParseDiagnosis`, recommendation validators — which checks *structure* but not *correctness*. A `Diagnosis` that parses correctly but has a wrong conclusion would ship as-is. If we started shipping diagnoses that customers identified as confidently wrong, that's the signal to add a verifier-critic with a different model family for the critic. Not yet a measured problem.

> **Q: Verifier-critic vs debate — which would you pick here?**
>
> Verifier-critic, if I had to pick. The diagnostic task is single-conclusion ("what caused this anomaly?"), not multi-interpretation ("here are three plausible causes; which wins?"). Debate's value is forcing disagreement into the open, which only helps when there are legitimate competing interpretations. The diagnostic agent's failure mode would be "wrong but plausible," not "right but missing alternatives" — verifier-critic addresses the former cheaper.

> **Q: Why does the critic need to be a different model family?**
>
> Self-preference bias. A model critiquing its own output rates its own answers higher than equivalent answers from a different model — it shares the blind spots that produced the answer. Claude Sonnet 4.6 critiquing Claude Sonnet 4.6 is essentially asking the same model "are you right?" — the answer is unreliable in the same direction the original answer was unreliable. Using a different model family (GPT-4 or a different Claude generation) gives the critic an independent shot at finding errors. The `AnthropicModelProviderAdapter` makes this swap a one-line construction change; adding an `OpenAIModelProviderAdapter` would be a one-class addition.

## See also

- → `01-reasoning-patterns/05-reflexion-self-critique.md` — the single-agent expression of the same idea
- → `09-coordination-failure-modes.md` — what goes wrong when two same-family agents critique
- → cross-reference (when generated): `study-ai-engineering`'s LLM-as-judge file — the self-preference bias
