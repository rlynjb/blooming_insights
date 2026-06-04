# Story: 169 vitest tests, zero quality signal — named the gap, wrote the recipe, didn't pretend

**Competency:** technical-judgment
**Also probes:** failure-recovery (the senior "what I'd do differently" honesty)
**Lands at:** Anthropic | Meta | Google | all
**Project / context:** blooming insights (Loomi Connect AI Hackathon, 2026-05-27 → 2026-06-02; post-build audit on 2026-06-02)
**Cross-link:** [`.aipe/drills/evals-observability-induce-eval-gap-build-min-eval-harness.md`](../drills/evals-observability-induce-eval-gap-build-min-eval-harness.md) · [`.aipe/rehearse-interview-defense/08-the-ai-question.md`](../rehearse-interview-defense/08-the-ai-question.md) · [`.aipe/audits/recon-2026-06-02.md`](../audits/recon-2026-06-02.md)

---

## Situation

`2026-06-02`, two days after the hackathon submission. I ran `/aipe:recon` on the repo. The audit came back with a sharp verdict: **L1 with one L2 spike, capped at L1 across every competency by the eval-cap rule.** 169 vitest tests on the agents, zero of them measuring answer quality. The five tests in `test/agents/diagnostic.test.ts:144-291` test that the wrapper extracted the JSON I'd pre-written into the scripted-Anthropic fake — they prove the *plumbing* (parseAgentJson, isDiagnosis, the synthesize() fallback, the FALLBACK constant), not the *answer*. `isDiagnosis` checks that `conclusion` is *a string*, not that it is *true*.

The recon's cap rule was the punch: *"No eval, no claim above L1 anywhere — no matter how much code is present."* The agent-architecture work (the centerpiece, L2) reads as L1 on contact with "how do you know any of the agent outputs are good?"

## Task

I owned the choice between two responses. **Option A:** claim the 169 tests are "comprehensive testing" of the AI layer and hope nobody pulls the thread. **Option B:** name the gap honestly — *"these tests prove plumbing, not quality"* — and write the recipe for the eval harness that closes it. Only one of those survives a senior interviewer asking "show me how you know the diagnoses are right."

## Action

I chose B and made it concrete. The senior move on this kind of gap isn't apologizing for it — it's *naming it sharper than the interviewer would*, then handing them the fix.

I wrote `.aipe/drills/evals-observability-induce-eval-gap-build-min-eval-harness.md` — a 6-section drill that:

1. **Names what the 5 tests in `test/agents/diagnostic.test.ts` actually prove** (plumbing) **vs what they don't** (answer quality). Each test gets one line; no hedging.
2. **Specifies the induced failure** — feed the live diagnostic agent a hand-curated case where the obvious wrong answer is also the most-tool-call-shaped one (a 90% checkout-to-purchase rate, which is physically impossible; the right cause-class is `data-quality-issue`, but the prompt's "Investigation approach" biases toward dimension-breakdown hypotheses that produce `payment-regression` as the wrong answer with `confidence: 'high'` and 3+ hypothesesConsidered). The failure to induce is *"confidently wrong with the appearance of rigor."*
3. **Walks three diagnostic hypotheses** for why the agent gets it wrong (prompt-bias toward queryable hypotheses, `synthesize()` dressing up rambling outputs, confidence-calibration broken on out-of-distribution inputs). Each is falsifiable.
4. **Specs the harness** — `evals/golden/anomaly-cases.json` (5-10 labeled cases by cause class), `evals/rubrics/cause-class.md` (4-6 canonical classes), `evals/runner.ts` (live agent against the goldset), `evals/judge.ts` (LLM-as-judge against the rubric, with cross-family judge per `study-ai-engineering/05-evals-and-observability/03-llm-as-judge-bias.md`), `evals/agreement.test.ts` (the eval gate — agreement rate of judge vs ground truth).
5. **Rejects four alternative approaches** (exact-match comparison of conclusion strings, raising `maxToolCalls` without measurement, trusting the existing `diagnosisConfidence` derivation, starting with a confusion matrix at N=10), each with the reason it loses.
6. **Names the L3-ceiling sentence** — *"baseline 60% agreement, every prompt edit ships with a delta vs that number"* — which is the answer that survives senior pushback.

The estimate I wrote on the drill: **~5h of work to move the entire LENS scorecard up one rung** (closes the cap rule, unblocks every other competency). The drill is the recipe; the harness execution is a separate session.

I then refreshed `.aipe/rehearse-interview-defense/08-the-ai-question.md` (the chapter answering the AI-engineering question in the loop) and `.aipe/rehearse-interview-defense/07-the-counterfactuals.md` (the "what would you do differently" chapter) — both now lead with the eval gap, named honestly, with the recipe handed to the reader. The interview answer becomes: *"I shipped 169 tests on the agents. Every one of them proves the wrapper extracted the JSON I pre-wrote — none of them touch answer quality. The L5 senior move was to ship the eval harness in the same week as the agent loop. I didn't. Here's the recipe I'd execute now and the agreement-rate metric it'd produce."*

## Result

The drill exists at `.aipe/drills/evals-observability-induce-eval-gap-build-min-eval-harness.md`. The induced failure is specified — a falsifiable test case the harness will catch. The harness spec is concrete (5 files, 5 hours estimated). The recon audit's TRACK queue head is exactly this drill; it's the move that unblocks moves 2-5 in the audit's ordered queue (cost meter, multi-agent coordination failure rep, the global-Map fix, prompt versioning) by closing the cap rule.

The interview answer that lands: instead of overclaiming "production-grade AI engineering," the answer is *"I shipped the agent loop, didn't ship the eval harness, named the gap before the audit caught it, wrote the recipe."* That's an L4 answer (with the harness executed, it becomes L5).

The concrete number the drill commits to capturing: **baseline 60% agreement on the seed goldset of 10 cases** (the expected first-run rate per the drill), measured by an LLM-as-judge against a 4-6 class rubric, with hand-scored inter-rater agreement against my own labels at ~80% to bound the judge's bias. Every prompt edit that lands after the harness ships will produce a delta vs that baseline.

## What I'd do differently / what I learned

The L5 senior move was to ship the eval harness **in the same week as the agent loop**. I didn't. The bank flags this as the central "what I'd do differently" — and it's not a small lesson. The pattern I'd internalize: **if you're shipping AI features, the eval harness is part of the feature, not a follow-up.** The first 10 goldset cases take an hour to curate; the harness scaffolding is another 2-3 hours; the judge call is half an hour. That's ~5 hours of "feature work that happens to be measurement," which is exactly the budget I spent on Tier 2 UI work that I cut on day 2 (story 03). Same budget; different choice; different ceiling. Next AI build, the eval harness lands first, before the second agent — because the cap rule fires whether or not I've heard of it.

---

## Defense — likely follow-ups

- **Q: How do you know any of the agent outputs are good?**
  A: Today, I don't. 169 vitest tests pass, and none of them measure answer quality. The five tests on the diagnostic agent test that the wrapper extracted the JSON I'd pre-written into a scripted Anthropic fake — they prove `parseAgentJson` works, that `isDiagnosis` validates the shape, and that the `FALLBACK` constant fires when parsing fails. They do not prove that the diagnosis's *cause class* is correct. The harness that would prove that — goldset + LLM-as-judge + agreement rate — exists as a recipe at `.aipe/drills/`, not as code. Five hours of work to ship it; the recipe is concrete. The senior move was to ship it in week one of the build. I didn't, and that's the central thing I'd do differently.

- **Q: Why didn't you ship the eval harness in week one?**
  A: Honest answer: I optimized for the demo's wow moment (the live agent stream) and the visible architecture (4-agent pipeline, MCP integration, OAuth boundary). The eval harness doesn't show on stage. It's the invisible discipline that makes the AI claim defensible *after* the demo, when an interviewer asks the question you just asked. I missed that the question would come — and frankly, "the demo doesn't show evals" is exactly the kind of priority logic that produces L1 ceilings. The pattern I'd internalize is: **the cap rule fires whether or not the demo shows it.** Next AI build, the eval lands before the second agent.

- **Q: You estimated 5 hours for the harness. Have you actually built one before?**
  A: Not in production, no. The estimate is based on the file count (5 files: goldset JSON, rubric markdown, runner, judge, agreement test), the line count per file (~50-100 lines each — the runner imports `DiagnosticAgent` from `lib/agents/diagnostic.ts` and iterates the goldset; the judge is one Anthropic call against a rubric), and the case-curation cost (10 cases at ~5 minutes each by hand). The risk is that the first 10 cases aren't hard enough — if the agent gets them all right on the first try, I picked too easy. The drill names that risk explicitly: *"if you cannot induce the failure, the drill is faked — pick a harder case."* The 5-hour estimate is the floor; the failure mode is "I shipped a harness that always says 100%."

- **Q: What's the difference between what your 5 tests do and what an eval would do?**
  A: My 5 tests check the *shape* — is the output a `Diagnosis`, did the fallback path fire, did the `FALLBACK` constant kick in when parsing failed. An eval checks the *truth* — given this input, is the cause class the agent named in the same category as the labeled cause class? Shape vs truth. My tests fail when the plumbing breaks; an eval fails when the answer regresses. Different failure modes; different things being measured. The drill's framing: my tests are a contract test wearing an eval costume.

- **Q: This is a "what I'd do differently" story, not a war story. Why is it failure-recovery?**
  A: Because the honest naming IS the recovery move. The recon audit's verdict is sharp — "L1 by the cap rule" — and the recovery isn't "I built the harness later." The recovery is the *senior-bar pattern* of not overclaiming. Two-thirds of interview candidates who shipped a similar project would claim "production-grade AI" with 169 tests and let the interviewer find the gap. The senior move is to find it first, name it sharper than the interviewer would, and hand them the recipe. That pattern — *honest gap-naming under audit pressure* — is the failure-recovery competency, even when the "failure" is something you missed rather than something you broke. If you can't name a wrong call from your career, the bar reads it as either "not operating at senior scope" or "not reflecting on it." This story is the second kind, owned.

- **Q: For Anthropic specifically — how does this connect to safety / mission?**
  A: Direct connection. The discipline of *measuring AI output quality before claiming AI quality* is the prerequisite for any safety claim. You can't claim "this agent doesn't hallucinate" without an agreement-rate against a goldset; you can't claim "this prompt change doesn't regress" without a baseline + delta. The eval harness is the substrate for the safety claim, not adjacent to it. I'm not claiming this work IS safety work — it's not. I'm claiming the discipline of "no eval, no claim" is the substrate safety work depends on. The fact that I named the gap and wrote the recipe (instead of overclaiming the 169 tests) is the closest signal I can show toward mission-aligned thinking from a hackathon-week project. Honest framing: the substrate is there; the mission-shaped project to apply it to isn't yet.
