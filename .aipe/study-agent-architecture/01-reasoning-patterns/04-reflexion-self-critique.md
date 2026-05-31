# Reflexion / self-critique loop

**Industry name(s):** Reflexion, self-critique loop, verifier-critic, generator-discriminator loop
**Type:** Industry standard · Language-agnostic

> A second model pass that grades the first's output and triggers a retry on failure. blooming insights does NOT use this as a critic; the diagnostic and recommendation agents do run a tool-less `synthesize()` retry on parse failure, but that's a *forced synthesis recovery* — same model, same evidence, no separate judgment.


---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** A reflexion / critic loop would sit *between* the Shared agent loop and whatever consumes its output — a second model call grading the first one, deciding whether to accept or retry. In blooming insights, that band is empty; the agent loop returns directly into the Pipeline coordinator with no critic in between. What lives in roughly that slot instead is a *forced synthesis* call inside `runAgentLoop` (when the budget burns out without a final text answer, tools are stripped and the model is asked again) — same model, no critic, just a retry without tools. Not reflexion, but the same architectural seam.

```
  Zoom out — where reflexion / critic loop WOULD live

  ┌─ Shared agent loop ─────────────────────────────┐
  │  runAgentLoop (lib/agents/loop.ts)              │
  │  produces a candidate answer (parsed JSON)      │
  └─────────────────────────┬────────────────────────┘
                            │
  ┌─ Critic / reflexion ────▼────────────────────────┐  ← ★ THIS ★ (absent)
  │  ★ would grade the answer, decide accept/retry ★ │  ← we are here
  │  ── absent in blooming insights ──                │
  │  what's here instead: forced-synthesis retry      │
  │  (same model, no tools, no critic)                │
  └─────────────────────────┬────────────────────────┘
                            │  accepted answer
  ┌─ Pipeline coordinator ──▼────────────────────────┐
  │  pipeline.ts hands result to the next stage      │
  └──────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question is: when does a critic loop catch things parsing/validation can't — and when does it just double your token cost on errors the same-model critic shares the blind spot for? Format/recognition errors (missing fields, wrong shape) are catchable by a parser, no critic needed. Substantive reasoning errors (the conclusion was wrong but plausible) are exactly what a same-model critic *can't* see — it shares the producer's priors. Below, you'll see where critic loops earn their keep, where they don't, and why blooming insights uses forced synthesis instead.

---

## How it works

**The mental model: a generator-then-critic pipeline with a bounded retry.** The base agent produces a draft. A critic step reads the draft and either approves it ("ship it") or rejects it with reasons ("the evidence section is missing a number"). On rejection, the runtime loops back to the generator with the critic's feedback included, capped at a small number of retries.

```
The loop — generator + critic + cap

  task ──► ┌──────────────────────────┐
           │ GENERATOR (base pattern, │
           │ usually ReAct)            │
           └──────────────┬───────────┘
                          │ draft answer
                          ▼
           ┌──────────────────────────┐
           │ CRITIC                   │
           │ "is this correct/        │
           │  complete/grounded?"     │
           └──┬─────────────────┬─────┘
              │ approved        │ rejected, with feedback
              ▼                 │
           RETURN               ▼
                           ┌─────────────────────┐
                           │ retry generator with│
                           │ critic feedback     │ ◄── capped (1–3 max)
                           └─────────────────────┘
```

The strategy in plain English: **run the same task twice, but the second time the producer reads the first time's critique.** ReAct produces; the critic judges; the producer revises. The cost is one extra model call per round (or two — one generator, one critic). The win is a recovery pass when the first answer was salvageable.

### Move 2.1 — The critic step

The technical thing: a model call whose system prompt is "you are evaluating an answer to a task; output a structured verdict plus reasons." Output is typically a JSON object: `{ approved: boolean, issues: string[] }` or a numeric score with a threshold.

If you're coming from frontend, this is a form's `validate()` function — but instead of a regex on the email field, it's a model reading the whole answer for substantive quality. The output is a verdict and the runtime acts on it.

```
The critic call — shape, not impl

  POST /messages {
    system: "Evaluate the diagnosis against the anomaly and evidence.
             Reject if: conclusion is vague, evidence missing,
             hypotheses untested. Return JSON.",
    messages: [{ role: 'user', content: { anomaly, evidence, draft } }]
  }
  →  { approved: false,
       issues: ["conclusion does not cite the prior-window count",
                "no hypothesis tested for traffic drop"] }
```

The practical consequence: the critic is *another* full LLM call, with the producer's full draft in its context. That's where the token cost compounds — the producer wrote tokens, now the critic re-reads them all and writes more. A round costs roughly producer + critic + retried producer.

The condition under which it works: the critic's verdict has to track *whether the answer is actually good*. If the critic just rubber-stamps everything (which is what happens when the prompt is too lenient or the model is too small), the loop adds cost and changes nothing.

### Move 2.2 — The shared-blind-spot problem

The technical thing: the critic and the producer come from the same model (or same family). The training distribution they share means they tend to find the same kinds of answers plausible. A wrong-but-plausible answer the producer wrote, the critic reads as plausible.

If you're coming from frontend, this is like asking the same engineer who wrote the code to review their own PR. They'll catch typos. They will not catch the architectural mistake their team's whole training pushed them toward.

```
Where critique works vs where it doesn't

  ┌─────────────────────────┬─────────────────────┐
  │ Failure type             │ Same-model critique│
  ├─────────────────────────┼─────────────────────┤
  │ Missing field             │ catches reliably    │
  │ Format mismatch           │ catches reliably    │
  │ Obvious omission          │ catches mostly      │
  │ Vague language            │ catches sometimes   │
  │ Wrong-but-plausible       │ rarely catches      │
  │ reasoning                 │ (shared priors)     │
  │ Reasoning errors the      │ ~never catches      │
  │ training distribution     │                     │
  │ doesn't flag              │                     │
  └─────────────────────────┴─────────────────────┘
```

The practical consequence: same-family self-critique is mostly a *structural* defense, not a substantive one. To catch substantive reasoning errors reliably, you need a critic with *different* judgment — a different model family, a different vantage on the evidence, or a programmatic check that doesn't depend on model judgment at all.

The condition under which it works (when it does): when the failure mode you want to catch is recognizable to the *same* model on a second pass. Many format and completeness failures qualify; many subtle reasoning failures don't.

### Move 2.3 — Where blooming insights actually sits (Case B with nuance)

Honest read: this codebase does not run a critic step. There is no separate model call that grades the producer's output. What there *is*, in the diagnostic and recommendation agents, is a different pattern that looks similar at a glance — a **forced synthesis recovery**.

When `runAgentLoop` returns a `finalText`, the agent class tries to parse it (`tryParseDiagnosis` in `diagnostic.ts` L22–L29, `tryParseRecommendations` in `recommendation.ts` L19–L26). If the parse fails, the agent runs a *second* tool-less LLM call — `synthesize()` — that hands the model its own already-gathered tool results and demands the structured output. That second call is the *same model* using the *same evidence* the loop already collected. It's not a critic; it's a recovery prompt that says "stop investigating, produce the JSON now."

```
What this repo has vs what a critic loop would look like

  This repo (forced synthesis recovery)        Critic loop (NOT here)
  ┌──────────────────────────────────┐         ┌────────────────────────┐
  │ runAgentLoop produces finalText   │        │ ReAct produces draft   │
  └──────────────┬───────────────────┘         └────────┬───────────────┘
                 ▼                                       ▼
          tryParseDiagnosis(text)                ┌────────────────┐
                 │                               │ critic LLM call │
       ┌─────────┴─────────┐                     │ verdict + issues│
       ▼ parse ok           ▼ parse fails        └────────┬────────┘
   return diag         synthesize(): another             │
                       LLM call WITHOUT tools,        ┌────┴────┐
                       same model, same evidence      ▼ ok      ▼ rej
                                                   return     retry generator
                                                              with feedback

  The difference: forced synthesis isn't judging the producer.
  It's the producer giving up its tools and being forced to commit.
```

The diagnostic agent's `synthesize()` lives at `lib/agents/diagnostic.ts` L87–L126. It's invoked from L75 only when the loop's `finalText` didn't parse as a Diagnosis. The system prompt is *not* "evaluate the answer" — it's "You are concluding a completed investigation. Output ONLY a JSON diagnosis. Never ask for more data." (L101). The user message hands the model the anomaly plus a stringified summary of every tool call the loop already ran. The model is being told *what to produce*, not asked *whether the prior produced thing was correct*.

The recommendation agent has the parallel structure at `lib/agents/recommendation.ts` L82–L132 — same recovery shape.

The principle: **forced synthesis and self-critique solve different problems.** Forced synthesis solves "the loop exhausted its budget without emitting parseable JSON." Self-critique solves "the loop emitted parseable JSON but the JSON is wrong." This repo accepts the second problem (a parseable-but-wrong diagnosis ships as-is) and only handles the first. That's a deliberate choice: the substantive correctness is checked downstream by the user reading the conclusion, not by a critic that shares the producer's blind spots.

The full picture is below.

---

## Reflexion / self-critique — diagram

```
The three positions you can take

  POSITION A: no recovery (pure ReAct, return whatever the loop returned)
  ┌─────────────────────────────────────────────────────────────┐
  │ runAgentLoop → finalText                                     │
  │   parse → ok? return : FALLBACK                              │
  │   no second pass, no judgment                                │
  └─────────────────────────────────────────────────────────────┘

  POSITION B: forced synthesis recovery (THIS REPO, diagnostic + recommendation)
  ┌─────────────────────────────────────────────────────────────┐
  │ runAgentLoop → finalText                                     │
  │   parse → ok? return : synthesize() ← same model,            │
  │                       no tools, "commit now"                 │
  │   → parse synthesis → ok? return : FALLBACK                  │
  │   ONE recovery pass, no judgment of correctness              │
  └─────────────────────────────────────────────────────────────┘

  POSITION C: reflexion / self-critique (NOT IN THIS REPO)
  ┌─────────────────────────────────────────────────────────────┐
  │ runAgentLoop → draft                                         │
  │   critic LLM call → { approved, issues }                     │
  │   approved? return : retry generator with feedback           │
  │   capped at N rounds                                         │
  │   ADDS judgment, BUT critic shares producer's blind spots    │
  └─────────────────────────────────────────────────────────────┘

  This repo sits at B for diagnostic and recommendation;
  at A for monitoring and query (no synthesize() retry).
```

---

## Implementation in codebase

**Not yet implemented as a critic loop (Case B with nuance).** There is no separate model call that grades a producer's output. The closest existing surface is the *forced synthesis recovery* in diagnostic and recommendation — a same-model tool-less retry when the main loop didn't emit parseable JSON.

**Closest existing surface — diagnostic agent's forced synthesis**
**File:** `lib/agents/diagnostic.ts`
**Function / class:** `DiagnosticAgent.synthesize()`
**Line range:** L87–L126 — invoked from L75 only on parse failure of the loop's `finalText`; tool-less `anthropic.messages.create` at L97 with system prompt "You are concluding a completed investigation. Output ONLY a JSON diagnosis. Never ask for more data." (L101).

**Closest existing surface — recommendation agent's forced synthesis**
**File:** `lib/agents/recommendation.ts`
**Function / class:** `RecommendationAgent.synthesize()`
**Line range:** L82–L132 — invoked from L70–L71 on parse failure; same shape as diagnostic's, returns a `Recommendation[]` (or `null` for the caller to default to `[]`).

**What's NOT here**

- No critic call that *grades* a Diagnosis before returning it.
- No retry of `runAgentLoop` with a "fix these issues" feedback message.
- No separate-model judge using a different model family on the producer's output (e.g. Haiku judging a Sonnet answer).
- No bounded round counter for retries beyond the single forced synthesis pass.

**Why the project sits here and not at a critic loop**

The substantive correctness of a diagnosis can't be reliably checked by the same model on a second pass — the model wrote a plausible explanation; it'll read its own plausible explanation as plausible. Adding a critic costs ~2x tokens per investigation for catching format issues that the parser already catches structurally. The forced synthesis pass catches the most common real failure (the loop spent its budget asking "should I query more" instead of emitting JSON) without paying for substantive judgment the critic wouldn't reliably give.

```
shape (what a critic loop WOULD add — illustrative, not in repo):

  // Hypothetical critic step (not present in this repo)
  const draft = await runAgentLoop(...);                         // existing
  const parsed = tryParseDiagnosis(draft.finalText);
  if (!parsed) {
    const recovered = await this.synthesize(anomaly, draft.toolCalls);  // existing
    if (!recovered) return FALLBACK;
    parsed = recovered;
  }

  // ↓↓↓ what reflexion/critic loop would add ↓↓↓
  const verdict = await anthropic.messages.create({
    model: 'claude-haiku-4-5',                                    // cheap judge
    system: CRITIC_PROMPT,
    messages: [{ role: 'user', content: { anomaly, evidence, parsed } }],
  });
  if (verdict.approved) return parsed;
  // retry the producer with verdict.issues as feedback (cap N rounds)
```

---

## Elaborate

### Where this pattern comes from

The pattern got its sharpest framing from the 2023 Reflexion paper (Shinn et al.), which showed that adding a "verbal self-reflection" step after a task attempt — where the agent reads its trajectory and writes a critique into memory — measurably improved subsequent attempts on programming and reasoning benchmarks. The broader generator-discriminator / verifier-critic split is older (it shows up in adversarial training and LLM-as-judge literature), and the 2024 critic-LLM line of work pushed the same idea into agent loops. The discipline became: separate the produce-an-answer model from the judge-an-answer model, and feed the judge's verdict into a bounded retry.

### The deeper principle

Two models with the same training distribution share priors; their judgments correlate. Self-critique pays off when the failure mode is *recognizable* — format errors, missing fields, omissions — because recognition doesn't require independent judgment. It pays off poorly when the failure mode is *substantive* — wrong reasoning that the same training distribution finds plausible — because the critic shares the producer's confidence in the wrong answer.

```
   Critic and producer share:        Recognizability of failure:
   training distribution             ┌──────────────────────────┐
   prior knowledge                   │ format error    HIGH      │
   confidence calibration            │ missing field    HIGH      │
                                     │ obvious omission MEDIUM   │
   The critic catches what the       │ vague reasoning  LOW       │
   producer's distribution flags     │ wrong-but-       VERY LOW │
   as anomalous; misses what it      │  plausible                 │
   flags as normal.                  └──────────────────────────┘
```

The implication: **use the same-family critic for format/structure and bring a different judgment (different model, programmatic check, human) for substance.** This is the same self-preference bias named in the LLM-as-judge literature.

### Where this breaks down

When the failure mode is wrong-but-plausible reasoning, same-family critique fails. When the cost of the critic plus retry exceeds the cost of just shipping the imperfect answer (low-stakes outputs), the loop's overhead is wasted. When the critic prompt is too strict, every answer gets rejected and the runtime hits the retry cap; when too lenient, every answer gets approved and the loop is dead weight. Tuning a critic prompt to the right strictness without a held-out eval is itself a hard problem — many teams add a critic and then can't tell whether it's helping.

### What to explore next
- `02-react.md` → the baseline this pattern escalates from; reflexion lives *on top of* a ReAct loop
- `03-plan-and-execute.md` → the other common escalation; plan-and-execute fixes "wrong path," reflexion fixes "wrong answer on the right path"
- `06-routing.md` → routing can short-circuit the need for a critic by sending different inputs to different specialists from the start
- `../../study-prompt-engineering/10-self-critique.md` → the prompt-level mechanics of asking a model to grade itself (and where same-model judgment falls down)

---

## Interview defense

### What an interviewer is really asking
When an interviewer asks about reflexion or self-critique, they're testing whether you reach for it because the name sounds rigorous or because you measured a failure it would fix. The strong signal is naming the shared-blind-spot limit and pointing at a programmatic or different-family check for substantive failures. The weak signal is "yes I added a critic" without saying which failure mode it caught.

### Likely questions

[mid] Q: Do your agents critique their own output before returning?

A: No — there's no critic step. Diagnostic and recommendation have a recovery pass called `synthesize()` (`lib/agents/diagnostic.ts` L87–L126 and `lib/agents/recommendation.ts` L82–L132) that fires only when the main `runAgentLoop` didn't emit parseable JSON. That second call uses the same model with no tools, and its prompt says "stop investigating, commit to an answer now" — it's forcing commitment, not grading correctness. The parser at `lib/mcp/validate.ts` enforces structural correctness on whatever finally comes back, and the user reading the conclusion is the substantive check.

Diagram:
```
   What runs always:          What runs on parse failure:
   runAgentLoop ──► parse     synthesize() ── tool-less ── parse
   (one model call/turn)      (one extra model call, same model)
                              system: "commit now, no tools"
```

[senior] Q: Why not add a critic — wouldn't it catch wrong diagnoses before they reach the user?

A: Probably not reliably. The critic would be the same Sonnet model that produced the diagnosis. Same family means shared training distribution; if the producer wrote a plausible-but-wrong conclusion, the critic reads it as plausible and approves it. Self-critique catches *format* and *completeness* errors reliably — but the parser already does that structurally. For *substantive* errors I'd need different judgment: a different model family as a critic, a programmatic check against the evidence (e.g. "does the conclusion's number match the prior-window count in the evidence?"), or a human reviewer. None of those is a same-family critique. So I skipped the critic and accepted user read as the final check.

Diagram:
```
   What same-family critique catches    What it doesn't
   ──────────────────────────────────   ───────────────────────────
   missing field                         wrong-but-plausible reasoning
   format mismatch                       conclusion that matches a
   obvious omission                       common-but-wrong pattern
   (parser already catches these)        the training distribution
                                          finds normal
```

[arch] Q: At 10x the user count, would you still skip the critic?

A: Probably not — the user-as-final-judge model breaks before 10x because not every user reads every conclusion carefully at scale. At that point I'd add *two* checks: a programmatic check (the conclusion's numbers come from the evidence, not invented) and a different-family critic (e.g. GPT-4o or Haiku on a cross-model verdict) for the cases the programmatic check can't express. I would not add a same-family critic — it'd add cost without catching the failures that matter at scale.

Diagram:
```
  Today (low scale)              At 10x (or automated decisions)
  ┌─────────────────┐            ┌─────────────────────────────┐
  │ runAgentLoop    │            │ runAgentLoop                 │
  │   parse         │            │   parse                      │
  │   user reads    │            │   programmatic check (Zod    │
  └─────────────────┘            │     + numbers-from-evidence) │
                                 │   different-family critic    │
                                 │     for residual cases       │
                                 │   THEN user (lighter-touch)  │
                                 └─────────────────────────────┘
```

### The question candidates always dodge
Q: Your `synthesize()` call IS a self-critique loop, right? It re-runs the model on the same task — that's reflexion.

A: Honest answer: no, and the distinction is worth naming. Reflexion has two pieces: a *judgment* of the prior attempt ("here's what was wrong") and a *retry* informed by that judgment. `synthesize()` has neither. It doesn't read the prior `finalText` and grade it. It doesn't tell the model "your previous answer lacked X, fix that." It hands the model the *evidence the loop already gathered* — not the loop's draft — and asks for a structured answer with no tools available. The producer is the same; the *input* is different. The loop's input was "investigate this anomaly" with tools available, so the model spent turns choosing queries. The synthesize call's input is "you finished investigating, here are the results, commit to a conclusion" with no tools, so the model has to produce text. It's a recovery from a known failure mode (model burned tools without committing), not a judgment of a draft. Calling it reflexion would be misleading — and it'd risk a future maintainer thinking "we have a critic" and skipping a real one when the user-as-final-judge model breaks.

Diagram:
```
  Reflexion / self-critique           This repo's synthesize()
  ───────────────────────             ────────────────────────
  step 1: produce draft               step 1: loop produces finalText
  step 2: critic READS draft,         step 2: parse fails
          emits {approved, issues}    step 3: synthesize() takes
  step 3: retry with feedback         the EVIDENCE (not the draft)
          (capped retries)            and runs a tool-less call
                                       with "commit now" prompt
  Two steps that judge.               One step that commits.
```

### One-line anchors
- "No critic step exists; the synthesize() recovery is a same-model commit-now retry, not a judgment."
- "Same-family critics catch format and recognition; they share blind spots on substantive reasoning."
- "The parser handles structural correctness; the user reading the conclusion handles substantive correctness; nothing in between."
- "I'd add a critic the day this becomes an automated decision system — and it'd be a different model family, not the same one."

---

## Validate your understanding

### Level 1 — Reconstruct the diagram
Close this file. Draw the three positions from memory: no recovery (pure ReAct), forced synthesis recovery (this repo's diagnostic + recommendation), and reflexion / critic loop (NOT in this repo). For each, label what runs always vs what runs only on the failure path, and how many model calls per "successful run."

Open the file. Compare.

✓ Pass: you have three positions, you correctly put diagnostic and recommendation on forced synthesis recovery, you correctly mark critic loop as not in this repo, and you label the critic as a *judgment* step distinct from a *recovery* step
✗ Fail: re-read Move 2.3 and the dodged question's answer, wait 10 minutes, try again

### Level 2 — Explain it out loud
Explain "does your agent critique its own answers" to a colleague who just asked. No notes. Under 90 seconds.

Checkpoints — did you:
- Answer honestly that no critic call exists?
- Name the recovery shape that DOES exist (`synthesize()` in diagnostic.ts and recommendation.ts)?
- Explain the difference between a recovery (commit now) and a critic (judge correctness)?
- Name the shared-blind-spot limit of same-family critics?

If you skipped any: you described it, you didn't understand it.

### Level 3 — Apply it to a new scenario
A product manager asks: "Sometimes the diagnostic agent confidently states a wrong cause. Can we add a step that catches that before the user sees it?" Without looking at the file: would a same-model critic loop catch this? What WOULD reliably catch it, and which files would change?

Write your answer (3–5 sentences). Then open `lib/agents/diagnostic.ts` L87–L126 and check what the current recovery does — and consider whether a *different-family* judge (e.g. Haiku at `lib/agents/intent.ts` L14) or a programmatic check against the evidence would be a cheaper, more reliable fix.

### Level 4 — Defend the decision you'd change
"If you were starting today and expected this to ship as an automated decision system — where the diagnosis directly triggers a Bloomreach action with no human read — would you still ship without a critic? Why or why not? If you'd change it, what new file would exist in `lib/agents/` and what model would you reach for?"

Reference the code: point to `lib/agents/diagnostic.ts` L75 (where synthesize is invoked) for where a critic would slot in, and to `lib/agents/intent.ts` L14 for the precedent of using a different (cheaper) model for a judgment-like task.

### Quick check — code reference test
Without opening any files:
- Does this repo have a self-critique loop? (No.)
- What file and function hold the closest analog (the forced synthesis recovery), and is it judging or committing?
- Why doesn't a same-model critic reliably catch wrong-but-plausible diagnoses?

Open and verify. ✓ File + function + the recovery-vs-critic distinction matter; line numbers drifting is fine.

## See also

→ 02-react.md · → 03-plan-and-execute.md · → 06-routing.md · → prompt mechanics: `../../study-prompt-engineering/10-self-critique.md` · → react: `../../study-ai-engineering/04-agents-and-tool-use/03-react-pattern.md`

---
Updated: 2026-05-29 — created
Updated: 2026-05-30 — Migrated to study.md v1.47 template (Phase 1+2 mechanical): removed Tradeoffs / Tech reference / Summary sections; renamed "In this codebase" → "Implementation in codebase"; moved See also to a bottom block. "Why care" preserved pending Phase 3 (Zoom out, then zoom in + LAYERS diagram) authoring.
Updated: 2026-05-30 — Phase 3 of study.md v1.47 migration: replaced "Why care" block with "Zoom out, then zoom in" (LAYERS diagram + zoom-in paragraph) per format.md.
