# Reflexion / self-critique loop

_Industry standard._

## Zoom out, then zoom in

The agent evaluates its own output and retries. **Not used in blooming_insights** as a reasoning pattern. This file names what IS in the codebase that looks similar (the recovery prompt in AptKit's runtime), what's actually different, and when true reflexion would earn its keep.

```
  Zoom out — where reflexion would sit

  ┌─ Worker agent (e.g. DiagnosticAgent) ──────────────────────┐
  │  Currently: ReAct → parse → return                         │
  │                                                            │
  │  With reflexion:                                           │
  │    ReAct → parse → CRITIC('is this right?') → revise loop  │
  │    (cap the rounds to prevent thrash)                      │
  └────────────────────────────────────────────────────────────┘
```

Zoom in: this file is placement + honest comparison. Blooming's `recoveryPrompt` (`run-agent-loop.js:110`) looks like reflexion but is actually structured-output rescue — mechanically different.

## Structure pass

**Layers:** producer (draft answer) · critic (evaluate) · reviser (retry) · round cap.
**Axis:** *what does the second call examine?*
**Seam:** the critic's contract — what "wrong" means (schema, factual, tone, correctness). Different definitions → different reliability of the critique.

```
  Reflexion (self-critique) vs recovery-prompt (schema rescue)

  Reflexion (a reliability loop):
  ┌────────────────┐       ┌─────────────────┐
  │ Producer draft │  →   │ Critic ('good?')│
  └────────────────┘       └────────┬────────┘
                               ┌────┴────┐
                               ▼         ▼
                            return    revise → loop

  Recovery prompt (schema rescue — what AptKit does):
  ┌────────────────┐       ┌──────────────────┐
  │ Producer draft │  →   │ tryParseSchema    │
  └────────────────┘       └────────┬─────────┘
                                    ▼ null
                          ┌──────────────────┐
                          │ Producer, strict │  ← ONE rescue turn,
                          │ prompt, no tools │    not a critic
                          └────────┬─────────┘
                                   ▼
                                 return
```

## How it works

### Move 1 — the mental model

You've written unit tests before — the assertion checks output, and if it fails, the fix is a code change. Reflexion is the runtime equivalent: after the model answers, a second model call *asserts* the answer against a criterion, and if it fails, the loop drafts again.

```
  Pattern: reflexion (asymmetric)

  ┌────────────┐            ┌────────────┐
  │ producer   │ ──draft──► │  critic    │
  │ (Sonnet)   │            │ (Sonnet or  │
  └────────────┘            │  different) │
       ▲                    └────┬────────┘
       │ revise prompt           │
       └───── loop ──────────────┘
       cap rounds (2-3 max) — one bad critic makes it worse
```

### Move 2 — the walkthrough

**What Blooming actually has — recovery prompt, NOT reflexion.** `run-agent-loop.js:106-138`:

```js
let parsed = null;
if (options.parseResult) {
  parsed = options.parseResult(finalText);
  if (parsed === null && options.recoveryPrompt) {
    const recoveryText = await runRecoveryTurn(options, options.recoveryPrompt(toolCalls));
    parsed = recoveryText === null ? null : options.parseResult(recoveryText);
  }
}
```

Line-by-line: `parseResult(finalText)` tries to extract a schema-valid `Diagnosis` from the model's final text. On null (schema failure) ONE rescue turn fires with a stricter prompt: "output ONLY the diagnosis JSON, no tool calls." **The critic here is a deterministic schema parser, not another LLM.** This is structured-output rescue, not reflexion. The model isn't grading its own reasoning; the harness caught a format failure and asked for a re-render.

**Why the distinction matters.** Reflexion says "your answer is *incorrect* — try again with different reasoning." Recovery says "your answer is *unparseable* — output it in the right shape." Different failure modes, different fixes. Confusing them is a common junior mistake.

**True reflexion — hypothetical adoption.** For it to earn its keep in Blooming, a specific measured failure would need to be present: e.g. "the diagnostic conclusion contradicts the evidence 5% of the time." Then:

Hypothetical:
```ts
// hypothetical addition to DiagnosticAgent
async investigate(anomaly, hooks) {
  const draft = await this.runReActLoop(anomaly, hooks);
  for (let round = 0; round < MAX_CRITIC_ROUNDS; round++) {
    const critique = await this.critic.grade(draft, anomaly);
    if (critique.pass) return draft;
    draft = await this.runReActLoop(anomaly, {...hooks, feedback: critique.reason});
  }
  return draft;  // ran out of rounds; return best-effort
}
```

Line-by-line: `grade` returns `{pass: boolean, reason: string}`; on fail the reason feeds back into the next iteration. Cost: 2-3x tokens for a hoped-for reliability lift. Not free.

**The bias failure mode.** A model critiquing its own output shares the blind spots that produced it. Self-critique catches format failures and *obvious* errors well; catches subtle-reasoning failures poorly. Mitigation named in `study-ai-engineering.md`'s LLM-as-judge file: use a different model family for the critic. In Blooming that'd mean Haiku critiquing Sonnet, or a cross-provider setup — not free, and only worth it if the reliability lift shows up in a golden-trajectory eval.

### Move 3 — the principle

Reflexion catches what it can catch: format errors, obvious factuals, tone. It doesn't fix a model that reasoned wrong for the same reasons the critic will reason wrong. The senior move is *measuring* the failure mode reflexion would fix before adopting the 2-5x token cost. In this codebase, the measured failure is "sometimes returns non-JSON" (schema, caught by recovery prompt for free), not "sometimes reasons incorrectly" (which would need reflexion).

## Primary diagram

```
  Recap — the two things that look like reflexion in this codebase

  RECOVERY PROMPT (implemented — run-agent-loop.js:110):
  ┌─────────────────┐    ┌────────────────┐
  │ final text      │ →  │ parseDiagnosis │
  └─────────────────┘    └────────┬───────┘
                              null│      ok
                                  ▼      ▼
                          ┌────────────┐  return
                          │ ONE rescue │
                          │ turn       │
                          └────────────┘
                          Schema rescue, NOT critique.

  TRUE REFLEXION (not implemented):
  ┌─────────────────┐    ┌──────────────┐
  │ producer draft  │ →  │ critic model │
  └─────────────────┘    └──────┬───────┘
        ▲                       │
        │ revise                ▼
        └─────── loop (cap rounds 2-3) ──── return
```

## Elaborate

Reflexion was named in Shinn et al. 2023 ("Reflexion: Language Agents with Verbal Reinforcement Learning") as a training-time technique that also transfers to inference-time. The production version is simpler: producer + critic + revise loop. LangGraph implements it as a graph with the critic as a conditional edge; the pattern generalizes.

The related pattern this repo does exercise, quietly, is `diagnosisConfidence` (`diagnostic-agent.js:67-80`) — a deterministic post-hoc classifier that reads the hypotheses considered and downgrades a "high" confidence to "medium" if any tool call errored. That's a rule-based critic, cheaper and more reliable than an LLM critic for that specific criterion.

## Interview defense

**Q: Do you have self-critique in this system?**
A: No. What looks like it — the `recoveryPrompt` path in AptKit's runtime — is structured-output rescue: if the final answer failed to parse as valid Diagnosis JSON, one rescue turn fires with a stricter prompt. The critic there is a deterministic parser, not another LLM. I'd introduce true reflexion only if I measured that the *reasoning* was wrong in a way parsing couldn't catch, and only with a different model family critic (Haiku critiquing Sonnet, or cross-provider) because a self-critique shares blind spots.

Diagram: the "these look alike, are not" side-by-side.
Anchor: `run-agent-loop.js:106-138` (recovery), `diagnostic-agent.js:67-80` (confidence downgrade).

**Q: Reflexion vs a schema-strict re-prompt — same thing?**
A: No. Same shape, different semantics. Schema-strict re-prompt catches "unparseable output" — a format failure. Reflexion catches "wrong output" — a correctness failure. The critic contract is what makes them different. A parser can't tell you if the diagnosis is *wrong*, only if it's malformed. That distinction is where I'd start if a stakeholder asked "why are diagnoses sometimes bad" — measure whether they're malformed (parser-caught, cheap to fix) or wrong (needs a real critic, expensive).

Diagram: two funnels — "format check" vs "correctness check" — with the LLM below only the second.
Anchor: same files as above.

## See also

- `02-agent-loop-skeleton.md` — recovery prompt as optional hardening.
- `03-react.md` — the base pattern reflexion layers onto.
- `04-agent-infrastructure/04-agent-evaluation.md` — the eval that would tell you if reflexion is worth adopting.
- Cross-reference: `.aipe/study-ai-engineering/`'s LLM-as-judge bias file.
