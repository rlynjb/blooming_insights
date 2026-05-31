# Self-critique and self-consistency (the model checks its own work)

**Industry name(s):** self-critique / self-refine, self-verification, self-consistency (sample-and-vote), reflexion-style revision
**Type:** Industry standard · Language-agnostic

> Self-critique runs the model a second time to evaluate and revise its own output; self-consistency runs the model N times and votes. Both buy reliability with 2–5× the tokens. blooming insights does neither — its `synthesize()` is a clean-context RETRY for recovery-from-no-JSON, not a critique step — and the trap to respect is that a model grading itself shares the blind spots that produced the output.


---

## Why care

You have an autocomplete that suggests a value, and for a high-stakes field — say a wire amount — you do not just take the first suggestion. You either show a confirmation step ("you typed $4,200 — confirm?") or you compute the value two independent ways and flag a mismatch. The pattern is: for outputs where being wrong is expensive, you spend extra work to catch the wrong ones before they ship.

An LLM output is the same. The first sample is one draw from a distribution; for low-stakes output you take it, for high-stakes output you want a second opinion. The question this file answers: **when is it worth running the model again to check or re-vote its own answer, and when is that just paying 2–5× the tokens to confirm its own mistake?**

**The pivot: self-critique and self-consistency trade tokens for reliability, and the trade only pays off when the failures are catchable by a re-read or a vote — not when the model is confidently and systematically wrong.** A model asked to grade its own output will pass the same hallucination that produced it, because the blind spot is shared. Knowing which failures these techniques catch — and which they cannot — is the whole skill.

Before any verification:
- The diagnostic agent's first conclusion streams straight to the user; a confident-wrong cause is shown as fact
- The intent classifier's one-word answer (`intent.ts` L17–31) is taken as-is; a borderline question is misrouted with no second look
- There is no mechanism to catch "well-formed but wrong" — the type guards prove shape, not truth (→ 02-structured-outputs.md)

After (if added):
- A verify pass re-reads the diagnosis against the evidence before it streams, catching "you concluded X but your evidence shows Y"
- An N-run vote on the classifier turns a coin-flip borderline case into a majority decision
- Both cost more tokens, and both have a clear ceiling on what they can catch

---

## How it works

**Mental model.** These are two different shapes for "use the model more than once to get a more reliable answer."

Self-critique is *sequential*: generate → critique → revise. The second call reads the first call's output and the question, and either approves it or rewrites it. Self-consistency is *parallel*: generate N times independently, then pick the answer the runs agree on. One spends tokens on depth (one careful re-read); the other spends tokens on breadth (many independent draws).

```
SELF-CRITIQUE (sequential)            SELF-CONSISTENCY (parallel)
─────────────────────────             ─────────────────────────
 generate ──▶ output v1               run 1 ─▶ answer A
     │                                run 2 ─▶ answer A
     ▼                                run 3 ─▶ answer B
 critique(v1) ─▶ "issue: …"           run 4 ─▶ answer A
     │                                run 5 ─▶ answer A
     ▼                                    │
 revise ──▶ output v2                  vote ─▶ A  (4 of 5)
─────────────────────────             ─────────────────────────
 cost: 2–3× tokens                    cost: N× tokens
 catches: errors a re-read finds      catches: high-variance / unstable answers
```

The cost framing is the load-bearing part: self-critique is roughly 2–3× the tokens of a single call (generate + critique + maybe revise); self-consistency is literally N× (you run the whole thing N times). You do not sprinkle these everywhere — you spend them where being wrong is expensive.

---

### Self-critique — generate, then evaluate-and-revise

The critique call is given the original input AND the first output, and asked a pointed question: does this output actually follow from the evidence? Is every claim grounded? It returns either "approved" or a revised version.

```
VERIFY PASS on a diagnosis (would-be flow)
─────────────────────────────────────────────────────────────
 diagnosis v1  { conclusion, evidence[], hypothesesConsidered[] }
        │
        ▼
 critique call:  "Here is the anomaly, the queries run, and this
                  diagnosis. Does the conclusion follow from the
                  evidence? Flag any claim not supported by a query
                  result. Return the diagnosis unchanged if sound,
                  or a corrected one."
        │
        ▼
 diagnosis v2  (approved, or conclusion softened to match evidence)
        │
        ▼  THEN stream to the user
```

This is exactly what blooming insights does NOT have. The diagnosis produced by `DiagnosticAgent.investigate` streams to the user the moment it validates (`route.ts` L153–154) — there is no second call that reads it back against the evidence. The natural insertion point is between `investigate` returning and `send({ type: 'diagnosis' })` firing.

The high-value target here is specific: catching the diagnosis that concludes "mobile checkout regressed" when the evidence rows actually show desktop moved. The type guard accepts it (`conclusion` is a string), the user sees a confident wrong cause. A verify pass that re-reads conclusion-against-evidence is the layer that catches the well-formed-but-wrong output the validators cannot.

---

### Self-consistency — run N, vote

For a *classification* — a small, discrete output space — sampling N times and voting is cheap and effective. Each run is an independent draw; if the answer is stable the votes agree, and if it is borderline the majority smooths the noise.

```
N-RUN VOTE on the intent classifier (would-be flow)
─────────────────────────────────────────────────────────────
 query: "did mobile drop and what do I do about it?"  ← ambiguous

 run 1 ─▶ diagnostic       (intent.ts classifier, temp default)
 run 2 ─▶ diagnostic
 run 3 ─▶ recommendation
 run 4 ─▶ diagnostic
 run 5 ─▶ diagnostic
        │
        ▼
 vote ─▶ diagnostic  (4 of 5)   ← stable decision on a borderline query
```

blooming insights' classifier (`classifyIntent`, `intent.ts` L17–31) is a single call: one Haiku request, `max_tokens: 16`, one word, parsed by `parseIntent`. It is cheap (the whole point of the Haiku-vs-Sonnet routing) so N-run voting is affordable here in a way it would not be on the Sonnet agents. This is the natural place self-consistency would earn its keep: a borderline question that flips between `diagnostic` and `recommendation` between runs would settle on a majority instead of a coin flip.

---

### Why `synthesize()` is NOT self-critique

This must be said plainly because it is the obvious thing to mistake. blooming insights has a second model call in the diagnostic and recommendation paths — `synthesize()` (`diagnostic.ts` L82–121, `recommendation.ts` L82–127) — and it is **not** a critique or verify step.

```
synthesize()  IS a clean-context RETRY        NOT a critique
─────────────────────────────────────────────────────────────
 trigger:  tryParseDiagnosis(finalText) == null   (no usable JSON)
 input:    the EVIDENCE, freshly formatted        NOT the first output
 ask:      "produce the diagnosis JSON now"        NOT "is v1 correct?"
 goal:     RECOVER a parseable artifact            NOT verify a good one
```

The trigger tells the whole story. `synthesize()` only runs when the loop produced no parseable JSON — `tryParseDiagnosis(finalText) ?? (await this.synthesize(...)) ?? FALLBACK` (`diagnostic.ts` L73–77). When the loop *does* produce a valid diagnosis, `synthesize()` never runs and nothing checks that diagnosis. It is a recovery mechanism for the structured-output contract (→ 02-structured-outputs.md), aimed at "the model kept wanting to query and never emitted JSON." It does not read a first answer and ask "is this right?" — it never even sees the first answer; it re-derives from evidence in a clean context. A critique pass would do the opposite: it would run *on the successful path*, take the valid diagnosis as input, and evaluate it.

So the honest current state: blooming insights has a clean-context retry (recovery), zero self-critique (verification), and zero self-consistency (voting).

---

### The principle

Self-critique and self-consistency both spend extra model calls to raise reliability — one by re-reading and revising, one by sampling and voting — and both are worth it only where the cost of being wrong exceeds the 2–5× token cost AND the failure is the kind a re-read or a vote can catch. The hard ceiling on both is the shared-blind-spot problem: a model grading its own work approves the same systematic error that produced it, so self-critique catches careless errors, not confident-wrong reasoning. blooming insights does neither today; its only second call (`synthesize()`) is recovery, not verification.

---

## Self-critique / self-consistency — diagram

This diagram spans the decision. The Generation layer produces a first output; for low-stakes output it ships directly (today's path); for high-stakes output a Verification layer either re-reads-and-revises (self-critique) or samples-and-votes (self-consistency) before shipping. The shared-blind-spot warning sits on the critique edge because that is where it bites.

```
┌──────────────────────────────────────────────────────────────────────┐
│  GENERATION LAYER                                                     │
│   DiagnosticAgent.investigate → Diagnosis v1   (diagnostic.ts L44)   │
│   classifyIntent → one word                    (intent.ts L17)       │
└───────────────┬──────────────────────────────────────────────────────┘
                │ first output
        ┌───────┴────────────────────────────┐
        │ low stakes                          │ high stakes
        ▼  (TODAY's path — both flows)        ▼  (NOT built)
┌─────────────────────┐         ┌──────────────────────────────────────┐
│ ship as-is          │         │  VERIFICATION LAYER                  │
│ route.ts L153–154   │         │                                      │
│ (no second look)    │         │  self-critique (sequential):         │
└─────────────────────┘         │   critique(v1, evidence) → v2        │
                                │   ⚠ shared blind spot: same model    │
                                │      approves its own systematic err  │
                                │                                      │
                                │  self-consistency (parallel):        │
                                │   run N → vote   (cheap on classifier)│
                                │   cost: N× tokens                     │
                                └──────────────────┬───────────────────┘
                                                   ▼
                                            ship verified output

  (separate) synthesize()  diagnostic.ts L82–121 — runs ONLY when v1
  failed to parse; a clean-context RETRY, NOT a critique of a good v1.
```

A reader who sees only this should grasp: verification is conditional on stakes, self-critique is sequential and self-consistency is parallel, both cost extra tokens, and the existing `synthesize()` sits outside this entirely — it is recovery, not verification.

---

## Implementation in codebase

**Not yet implemented.** There is no self-critique, self-verification, or self-consistency anywhere in blooming insights; no output is re-read for correctness and nothing is sampled-and-voted.

The closest existing analog is `synthesize()` (`lib/agents/diagnostic.ts` L82–121, `lib/agents/recommendation.ts` L82–127) — but it is a *clean-context retry for recovery-from-no-JSON*, not a critique: it fires only when `tryParseDiagnosis(finalText)` returns null (`diagnostic.ts` L73–77), it never sees the first output, and it re-derives the artifact from evidence rather than evaluating an existing one. A real verify pass would live between `DiagnosticAgent.investigate` returning and `send({ type: 'diagnosis' })` in `app/api/agent/route.ts` (L153–154); an N-run vote would wrap `classifyIntent` in `lib/agents/intent.ts` (L17–31).

---

## Elaborate

### Where this comes from

Self-consistency comes from Wang et al., "Self-Consistency Improves Chain of Thought Reasoning" (2022): sample multiple reasoning paths and take the majority answer, which beats greedy decoding on reasoning tasks. Self-critique / self-refine traces to Madaan et al.'s "Self-Refine" (2023) and the Reflexion line (Shinn et al., 2023): have the model produce feedback on its own output and revise. Anthropic's and OpenAI's prompting guides both describe verify-then-revise patterns. The common thread is using extra inference to convert a single uncertain sample into a more reliable answer.

### The deeper principle

```
one sample                          verified output
──────────────────────────────     ──────────────────────────────
a draw from a distribution          consensus (vote) or re-checked (critique)
cheap, fast                         2–5× tokens
fine for low-stakes / reviewable    worth it for high-stakes / hard-to-review
```

The deep idea: reliability is buyable with inference, but the exchange rate is not constant. On a discrete, high-variance output (a borderline classification) a vote buys a lot of reliability per token. On a confident, systematically-wrong generation, a self-critique by the same model buys almost nothing, because the error is in the model's belief, not its carelessness. You spend where the exchange rate is good.

### Where this breaks down

1. **The shared blind spot.** This is the headline caveat. A model critiquing itself shares the priors that produced the output; if it hallucinated a cause confidently, asking it "is this right?" often gets "yes." Self-critique catches sloppiness (a claim that contradicts the evidence in the same context) far better than it catches confident-wrong reasoning. For the latter you need an *independent* check — a different model, or a human, or a deterministic validator — not the same model again.

2. **Diminishing returns.** The second critique pass catches most of what any critique pass will catch; a third rarely helps. N-run voting flattens out too — going from 5 to 11 runs barely moves a stable answer and only matters for genuinely borderline cases. Past the knee you are paying tokens for noise.

3. **Self-consistency needs a discrete answer to vote on.** Voting works on the intent classifier (three labels) and would NOT work on the diagnosis prose — there is nothing to take a majority of when every run phrases the conclusion differently. For free-form output you need a different aggregation (judge-and-pick) or you fall back to critique.

4. **Latency and cost.** Self-consistency is N× the latency unless you parallelize the calls, and N× the spend regardless. On the Sonnet agents (`AGENT_MODEL`, `base.ts` L9) that is expensive; on the Haiku classifier it is cheap — which is exactly why the classifier is the right place to start.

### What to explore next

- **Independent-model critique.** Use a different model (or the cheaper Haiku) to critique the Sonnet diagnosis, breaking the shared-blind-spot problem the same-model critique suffers.
- **Confidence-gated verification.** Only run the verify pass when the diagnosis is low-confidence or when the evidence array is short — spend the extra tokens only on the risky outputs.
- **Evals as the real correctness layer.** Self-critique raises reliability but cannot prove correctness; a golden-set eval (→ 05-eval-driven-iteration.md) is what actually measures whether the diagnoses are right.

---

## Project exercises

### Add a verify pass on the diagnosis before it streams

- **Exercise ID:** C-self-critique (adapted) — self-critique / self-verification on a high-stakes output.
- **What to build:** between `DiagnosticAgent.investigate` returning and `send({ type: 'diagnosis' })` (`app/api/agent/route.ts` L153–154), add a single critique call that receives the anomaly, the gathered tool results, and the diagnosis, and answers "does the conclusion follow from the evidence?" — returning the diagnosis unchanged if sound or a corrected one if a claim is unsupported. Reuse the `synthesize()` clean-context call shape (`lib/agents/diagnostic.ts` L82–121) as the structural template, but feed it the *first diagnosis* as input (the thing `synthesize()` never sees) and use the cheaper Haiku model as the critic to blunt the shared-blind-spot problem.
- **Why it earns its place:** demonstrates you can distinguish recovery (`synthesize()`) from verification, place the verify pass on the *successful* path, and address the shared-blind-spot weakness by making the critic independent.
- **Files to touch:** `lib/agents/diagnostic.ts` (a `critique` method), `app/api/agent/route.ts` (wire it before the `diagnosis` event), `test/agents/diagnostic.test.ts` (a case where critique corrects an evidence-contradicting conclusion).
- **Done when:** a diagnosis whose conclusion contradicts its evidence is corrected (or flagged) by the critique pass before streaming, and a sound diagnosis passes through unchanged with one extra call.
- **Estimated effort:** 1–4hr

### Add an N-run vote to the intent classifier

- **Exercise ID:** C-self-consistency (adapted) — sample-and-vote on a discrete classification.
- **What to build:** wrap `classifyIntent` (`lib/agents/intent.ts` L17–31) so it runs the Haiku classification N times (e.g. N=5), collects the parsed intents via `parseIntent`, and returns the majority label; tie-break to the existing default (`diagnostic`). Keep it behind a small N so the extra Haiku calls stay cheap.
- **Why it earns its place:** self-consistency is only correct on a discrete output with a cheap model — exactly the classifier — and the exercise forces you to recognize why the same technique is wrong for the Sonnet prose agents.
- **Files to touch:** `lib/agents/intent.ts` (vote wrapper around `classifyIntent`), `test/agents/intent.test.ts` (a case where 3-of-5 runs settle a borderline query).
- **Done when:** a borderline query that the single call flips between `diagnostic` and `recommendation` settles on a stable majority label across runs, and the cost is N cheap Haiku calls, not N Sonnet calls.
- **Estimated effort:** <1hr

---

## Interview defense

### What an interviewer is really asking

"How would you make the LLM's output more reliable?" tests whether you reach for "run it again" reflexively or know *which* re-run (critique vs vote), what each costs, and what each cannot catch. The senior signal is naming the shared-blind-spot ceiling and correctly identifying `synthesize()` as recovery, not verification.

### Likely questions

**[mid] "There's a second model call in the diagnostic path — `synthesize()`. Is that self-critique?"**

No. `synthesize()` (`diagnostic.ts` L82–121) is a clean-context retry that fires only when the loop produced no parseable JSON — `tryParseDiagnosis(finalText) ?? synthesize() ?? FALLBACK` (L73–77). It never sees the first output and re-derives the diagnosis from evidence. Self-critique would do the opposite: run on the *successful* path, take the valid diagnosis as input, and evaluate whether it follows from the evidence.

```
synthesize() : v1 failed to parse → re-derive from evidence  (recovery)
critique     : v1 is valid → re-read it vs evidence → revise  (verification)
```

**[senior] "When is self-consistency the right tool, and where would you NOT use it here?"**

Self-consistency votes over a discrete output, so it fits the intent classifier (three labels, cheap Haiku, `intent.ts` L17–31) — N runs settle a borderline query into a majority. It does NOT fit the diagnosis: the output is free prose, every run phrases the conclusion differently, and there is nothing to take a majority of. For the prose agents you'd reach for critique or a judge, not a vote.

```
classifier (discrete, cheap)  → vote ✓
diagnosis (prose, expensive)  → vote ✗  (nothing to vote on; use critique)
```

**[arch] "You add a self-critique pass and the model still approves its own hallucinations. Why, and what fixes it?"**

The shared blind spot: the critic is the same model with the same priors, so it endorses the confident-wrong reasoning it produced. Self-critique catches sloppy errors (a claim contradicting evidence in-context), not systematic ones. The fix is an *independent* checker — a different model, the cheaper Haiku as critic, a deterministic validator, or a human — plus evals (→ 05) as the real correctness measure, since critique raises reliability but never proves correctness.

```
same-model critique → endorses own systematic error (shared priors)
independent critique → can disagree → catches confident-wrong
```

### The question candidates always dodge

**"Does the model checking its own work actually make it more correct, or just more confident?"** Often just more confident, and candidates dodge because "add a self-critique pass" sounds rigorous. A same-model critique shares the blind spot that produced the error, so it frequently rubber-stamps. The honest answer: self-critique catches careless errors, not confident systematic ones; for the latter you need independence, and for proof of correctness you need evals — not a self-graded pat on the back.

### One-line anchors

- `lib/agents/diagnostic.ts` L73–77 — `tryParse ?? synthesize ?? FALLBACK`: `synthesize()` is recovery, gated on parse failure.
- `lib/agents/diagnostic.ts` L82–121 — `synthesize()`: clean-context, re-derives from evidence, never reads v1.
- `app/api/agent/route.ts` L153–154 — diagnosis streams unverified; the verify-pass insertion point.
- `lib/agents/intent.ts` L17–31 — single-call classifier; the cheap target for an N-run vote.
- Wang et al. 2022 (self-consistency); Madaan et al. 2023 (self-refine) — the canonical sources.

---

## Validate

### Level 1 — Reconstruct

From memory, draw both shapes: self-critique (generate→critique→revise, sequential) and self-consistency (run N→vote, parallel). Label the token cost of each (~2–3× vs N×) and write the one caveat that limits same-model critique (the shared blind spot).

### Level 2 — Explain

Out loud: why is `synthesize()` (`lib/agents/diagnostic.ts` L82–121) NOT self-critique? Name its trigger (`tryParseDiagnosis(finalText)` is null, L73–77), what it takes as input (evidence, not the first output), and how a real verify pass would differ on all three points.

### Level 3 — Apply

Scenario: add a verify pass that catches a diagnosis whose `conclusion` says "mobile checkout regressed" while its `evidence` rows show desktop moved. Decide where it goes (`app/api/agent/route.ts` L153–154, before the `diagnosis` event), what it receives (anomaly + tool results + the v1 diagnosis), which model you'd use for the critic and why (Haiku, to blunt the shared-blind-spot problem), and what it returns (unchanged or corrected).

### Level 4 — Defend

A reviewer says: "Just add a self-critique pass to every agent — the model can check its own work." State which agent it actually helps (the prose diagnosis) versus where a vote is the right tool instead (the discrete classifier, `intent.ts`), name the shared-blind-spot ceiling that limits same-model critique, and give the cost (2–5× tokens) and the breakpoint event that justifies paying it.

### Quick check — code reference test

What is the exact trigger condition under which `synthesize()` runs in the diagnostic agent, and why does that make it recovery rather than verification? (Answer: it runs only when `tryParseDiagnosis(finalText)` returns `null` — `lib/agents/diagnostic.ts` L73–77 — i.e. the loop produced no parseable JSON. On the successful path it never runs and never inspects the valid diagnosis, so it recovers a missing artifact rather than verifying an existing one.)

## See also

→ 02-structured-outputs.md · → 05-eval-driven-iteration.md · → 09-chain-of-thought.md · → 11-meta-prompting.md
Updated: 2026-05-30 — Migrated to study.md v1.47 template (Phase 1+2 mechanical): removed Tradeoffs / Tech reference / Summary sections; renamed "In this codebase" → "Implementation in codebase"; moved See also to a bottom block. "Why care" preserved pending Phase 3 (Zoom out, then zoom in + LAYERS diagram) authoring.
