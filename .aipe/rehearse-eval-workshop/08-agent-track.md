# Exercise 08 — agent track (grade the path, not just the destination)

## ① verdict

A right answer via a broken 40-step path is still broken. Your multi-
agent supervisor makes tool calls between diagnose and recommend; the
tool-call trace is where confabulation, wrong-tool selection, and
handoff bugs live. **Your eval already carries this discipline**: the
judge receives `tool_calls_trace` as context (`run.eval.ts:238–247`),
and you have a lived L3 receipt from Move 3 where the trace-aware judge
caught a coordination failure. This exercise is to name that discipline
and know where it's not yet complete.

## ② analogy

Grading a math proof. The final number being right doesn't excuse
invalid steps. A student who wrote *"2 + 2 = 5, therefore 5 - 3 = 4,
therefore 4 = 4"* got a "right" answer via a broken path — same problem
as an agent that produces a plausible-sounding diagnosis via a wrong
tool sequence.

## ③ in your repo

Two halves apply — one already shipped, one still open.

**Shipped half — trace passed to the judge:**

```ts
  // eval/run.eval.ts:238–247 — the load-bearing line
  const diagnosisJudgmentResult = await diagnosisJudge.judge({
    subject: JSON.stringify(diagnosis, null, 2),
    context: {
      anomaly: JSON.stringify(goldenCase.anomaly, null, 2),
      known_correct_shape: JSON.stringify(goldenCase.knownCorrect, null, 2),
      case_intent: goldenCase.intent,
      signal_class: goldenCase.signalClass,
      tool_calls_trace: formatToolCallTrace(diagnosisToolCalls), // ★
    },
  });
```

That's the diagnosis judge. Same for the recommendation judge at
`run.eval.ts:285` (`recommendationTraceForJudge`). Both judges see what
the agent did to get its answer, not just the answer. That is the
grade-the-path discipline shipped.

**The receipt this bought you** — Move 3, commit `be05240`, drill file
at `.aipe/drills/agents-and-tool-use-induce-multi-agent-coordination-failure.md`.
Summary: the recommendation agent produced a rec targeting a
hypothesis the diagnosis explicitly marked `supported: false`. The
judge caught it *because it could see the diagnosis object in the
context*. You shipped a fix (`filterSupportedHypotheses`); the eval
regressed all 4 rec dims by 13–23pp case-matched; you reverted.
Tombstone at `lib/agents/recommendation.ts:31–41` documents why.

**That negative-result rep is the L3 signal.** Not "I built an eval" —
"I ran the eval, it caught my wrong mental model before it shipped, I
reverted, and here's the tombstone." Interviewers want that receipt.

**Open half — agent trajectory NOT yet graded as its own rubric dim:**

The judges *see* the trace, but they don't currently score `tool_correctness`,
`step_order`, `error_recovery`, or `efficiency` as their own dimensions
in the rubric. The rubric asks about the OUTPUT (was the diagnosis
grounded? did the rec target the diagnosed cause?). What's missing is
a rubric dim like `path_quality` that would grade the trajectory
independently.

That's the extension exercise below.

## ④ human track — the safety boundary is a human call

For each golden case, the agent has:
- **A goal** (e.g., "diagnose why credit-card mobile payments are failing")
- **A set of forbidden actions** (e.g., "MUST NOT invent customer counts", "MUST NOT extrapolate to desktop", "MUST NOT skip the tool call and answer from priors")

The goal is human-authored — it's the case's `intent` field. The
forbidden actions are also human-authored — they live in
`knownCorrect.red_herrings_to_avoid` and `knownCorrect.failure_modes_to_avoid`
across your goldens. Those "MUST NOT" lines are the safety boundary,
and only a human can name what "unsafe" means in this domain.

Minimal start (goal + safety):
- Did the agent reach its goal? (Rubric's existing output-quality dims.)
- Did it avoid the forbidden actions? (Requires reading the trace, not just the output.)

## ⑤ AI track — path-quality dimensions

If you add a `path_quality` dim to `diagnosis-quality.ts` (or a new
rubric `agent-trajectory-quality.ts`), Claude can draft the scale prose.
Draft template (Claude generates; you edit thresholds):

```
  candidate dimension: tool_correctness (1–5)

  1 — agent called irrelevant tools OR invented tool outputs
  2 — agent called some right tools but with wrong arguments (e.g.,
      wrong time window, wrong metric, wrong scope filter)
  3 — agent called the right tools with mostly right arguments;
      some redundancy or minor argument errors
  4 — agent called the right tools with correct arguments; efficient
      (no redundant queries)
  5 — agent called the right tools with correct arguments, in an
      order that a domain expert would recognize as optimal
      (broadest cast → narrow → verify)

  candidate dimension: no_confabulation (1–5)  ← the highest-value one
                                                 for THIS repo
  1 — output contains numbers or claims NOT derivable from trace
  2 — output extrapolates loosely from trace with unstated inference
  5 — every quantitative claim in the output has a matching value
      in the trace
```

Verification: run the extended rubric on the Move 3 fingerprint runs
(receipts at `eval/receipts/*-2026-07-03T16-*.json` — six runs on cases
01 and 08). The extended rubric should score `no_confabulation` low on
the runs where the rec targeted `exp-checkout-copy` (a hypothesis the
diagnosis rejected). If it doesn't, the new dim isn't sharp enough
yet — iterate.

Note: the shipped rubric ALREADY implicitly captures a lot of this via
`evidence_grounding` on the diagnosis rubric and `diagnosis_response`
on the rec rubric. The extension is not "add rubric dims because
they're missing" — it's "make the trajectory grading its own line item
because it's currently a partial signal folded into other dims."

## ⑥ do it

1. Open `eval/run.eval.ts` and read lines 238–247 (diagnosis judge
   context payload) and lines 285–305 (recommendation judge loop).
   State out loud: *"the judge sees the tool-call trace. That's why the
   Move 3 confabulation-catching case worked."*
2. Open `.aipe/drills/agents-and-tool-use-induce-multi-agent-coordination-failure.md`.
   Read Steps 3–5 (the isolation probe + fix + eval). Note that the
   eval delta (`baseline vs candidate`, case-matched) is the receipt
   language a strong interview answer uses. This is your L3 story.
3. Pick one broken-path / right-answer case from the receipts. The
   Move 3 fingerprint case is the cleanest example: `case 01` and
   `case 08` runs at `T16-40`, `T16-44`, `T16-47`, `T16-51`, `T16-55`,
   `T16-58`. In 4/6 of those, the rec agent's rec[2] targeted a
   `supported: false` hypothesis — a right-primary answer via a broken
   handoff path. Confirm the current rubric's `diagnosis_response` dim
   scored those as `fail` (score 2 or 3). If yes, the shipped rubric
   catches this class of failure via the output rubric alone.
4. Decide: does a dedicated `path_quality` dim earn a slot on the
   rubric, or is it redundant with what `evidence_grounding` and
   `diagnosis_response` already catch? The coach's read: **redundant
   for the current failure modes**. The path-vs-output distinction
   matters more when you have longer trajectories (10+ tool calls per
   case). Your diagnostic loop today is 2–5 tool calls per case, so
   the output rubric catches most path failures.
5. Where a dedicated path dim *would* earn a slot: `no_confabulation`
   as a first-class dim on the diagnosis rubric. It's what caught the
   4,820-customer confabulation in case 05, but the current rubric
   captures it under `evidence_grounding` scale 1 ("Numbers or claims
   that contradict the evidence"). Sharpen it out into its own dim if
   confabulation stays a top failure mode after the next 20 runs.

## ⑦ done when

- You can name where the shipped harness carries the grade-the-path discipline: **`run.eval.ts:238–247`, the `tool_calls_trace` context on the judge**.
- You can name the receipt that proves it works: **Move 3, commit `be05240`, the negative-result rep at `.aipe/drills/agents-and-tool-use-induce-multi-agent-coordination-failure.md`**.
- You've considered whether a dedicated `path_quality` rubric dim earns a slot, and can defend the decision either way. (Coach's read: not yet, for a 2–5 tool call loop. Yes, if trajectories grow to 10+.)
- You can articulate the L3 interview answer: *"I induced a multi-agent coordination failure, shipped a fix, the eval caught that my mental model of the failure was wrong, and I reverted with a tombstone. The eval was doing exactly what the eval is for — catching a wrong mental model before it shipped."*
