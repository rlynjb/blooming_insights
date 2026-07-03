# Skeptical reviewer questions

**The memorize-this file.** Six probes you *will* get in a senior loop, each with the answer that holds under follow-up. Coach voice — this is what you say in the room, not what you think.

For each probe: the question as they'll actually ask it, the answer in the shape you should deliver it (verdict first, then the receipt), and one follow-up you should preempt so they don't get to it first.

## Probe 1 — "How do you know any of the agent output is actually good?"

This is the interviewer's opening move on any AI product. The reason it works is that most candidates answer with vibes — "the outputs look reasonable" or "I tested it a lot." Don't do that.

**The answer, in the shape to deliver it.**

*"I have a per-criterion baseline committed at `eval/baseline.json`. 4 diagnosis dimensions — 75% root_cause_plausibility, 50% evidence_grounding, 75% scope_coherence, 0% actionable_next_step. 4 recommendation dimensions — 48% diagnosis_response, 62% feature_choice_fit, 100% step_actionability, 43% impact_realism. That's not vibes. Every PR runs the gate against this baseline in CI. If a change regresses any criterion, the PR blocks."*

**The move.** You gave them 8 specific numbers before they finished nodding. That's the receipt density that ends the "how do you know" question.

**The follow-up you preempt.** *"And blind human calibration is the known gap — Session D pilot ran AI-vs-AI, which the receipt file explicitly stamps as `pilotWarning` because AI-vs-AI isn't real calibration. Real number needs a 30-min blind human pass. Worksheet's ready."* You disclose the gap before they find it. That's the credibility move.

## Probe 2 — "Why did the actionable_next_step baseline come in at 0%?"

This is the follow-up to probe 1. They picked the worst number and pointed at it. Good — that's the number you want to talk about, because it's your best evidence that the eval is *doing its job*.

**The answer.**

*"Every diagnosis is mechanism-clear but action-vague. The agent will tell you checkout conversion dropped in the USA segment; it won't tell you the next specific tool call to confirm the cause. That's a systemic prompt gap, and I know it's systemic because the 0% baseline is measured across N=6 diagnoses with full judge output — 6-of-6 failed the criterion. Not one-case noise."*

*"The fix shape is a one-prompt change: name the specific tool call and its expected result. The regression gate makes sure a fix that doesn't actually move the number can't be shipped."*

**The move.** You (a) named the gap concretely, (b) proved it's systemic not noise, (c) named the fix shape, (d) named how the fix gets verified. That's the full loop in four sentences.

**The follow-up you preempt.** *"Week 3 is the target for this. Anthropic's diagnostic prompt patterns doc says to require named next-step; the fix aligns to that."*

## Probe 3 — "6 of 10 diagnoses got judge_error. Is that OK?"

This one's a trap. If you get defensive ("it's fine, don't worry about it") you lose. If you catastrophize ("yeah that's a huge problem") you lose. The move is to explain what actually happened and name the tradeoff.

**The answer.**

*"Judge_error means the judge output was truncated, not that the agent output was bad. The judge was configured with maxTokens 4096, which hits the ceiling on the longer no-signal cases — 05, 06, 10 no-signal, plus 03 has-signal. The underlying diagnostic output on those cases is still measured via the completed judgments on the other criteria."*

*"Two fix options — bump to 8192 tokens at roughly 2× cost per judgment, or accept as a known low-frequency outcome bucket. Current call is accept, because the underlying agent reasoning is fine and I'd rather spend the budget on more golden cases than more judgment tokens. The choice is deferred, not hidden — it's in the eval doc."*

**The move.** You separated the failure mode (judge truncation) from the concern the interviewer was probing (agent quality). You named the exact cases. You named the two options and the pick. You didn't apologize.

**The follow-up you preempt.** *"If I ever add cases where the diagnosis output itself gets long, I'd bump the judge tokens. The current cases are within budget."*

## Probe 4 — "Why retire the Olist MCP server?"

This is the interviewer testing whether you understand what an abstraction is *for*. The wrong answer is "Olist wasn't very good." The right answer is that you retired it because the seam had already earned its receipt.

**The answer.**

*"The DataSource seam was speculative until I used it. Adding the Olist adapter — a real, third-party MCP server — was the first proof the port wasn't same-shape-different-name; the adapter did real translation. Once the seam was proved, SyntheticDataSource was a cleaner shape for the same job: in-process, no network, no auth, no rate limit."*

*"And crucially — the fault-injecting decorator became the 3rd offline use of the seam. So the seam has now shipped 4 uses with zero caller-surface changes: Olist add, Olist remove, Synthetic add, Fault-injecting decorator. That's the shipped abstraction receipt. A seam nobody uses isn't a seam."*

**The move.** You reframed the question from "why remove Olist" to "how the seam earned its keep." You gave them the 4-uses receipt without them asking. You made the retirement a *step* in the seam's proof, not an admission of failure.

**The follow-up you preempt.** *"If a real second Bloomreach-alternative MCP server ever ships, the seam is ready. But shipping-scope is Bloomreach — see Ch 01 outside-scope list."*

## Probe 5 — "What's the eval gap now?"

They're testing whether you know your own weakness. If you say "no gaps, it's shipped" you're done. The move is to name the exact gap, name the size of the fix, and name why it's not fixed yet.

**The answer.**

*"The blind human calibration pass. Session D pilot was AI-vs-AI — I know it's not real calibration, and the receipt file stamps that with `pilotWarning`. Two models trained on similar data agree more than a real human would; that's the whole reason the pilot's numbers don't count as calibration."*

*"Real number needs a blind human pass. Worksheet is generated. Roughly 30–60 minutes of my own judgment on the 10 cases blind, then compared to the model's. That's the receipt that turns the mechanic into a number. It's the top open gap."*

**The move.** You named the gap in the first sentence. You explained *why* it's a gap (AI-vs-AI is not calibration). You named the exact effort to close it (30–60 min). No hedging, no apology.

**The follow-up you preempt.** *"The mechanic itself is shipped — Session D pilot proved the loop works end-to-end. What's missing is the number, not the loop."*

## Probe 6 — "What's the routing decision on monitoring?"

This one's about whether you'll optimize without evidence. The obvious move is to route the monitoring agent to Haiku — it's the simplest task, Haiku's cheaper, why hasn't this shipped? The right answer is that routing it *blind* is the exact anti-pattern the eval flywheel exists to prevent.

**The answer.**

*"Deferred with evidence. The eval currently skips the monitoring agent — golden anomalies get fed straight to the diagnostic agent — which means I have no cost signal on monitoring. Routing monitoring to Haiku blind is the exact anti-pattern the eval flywheel exists to prevent: a change I can't measure."*

*"Trigger for revisit is one real briefing measurement. Once the eval covers a monitoring case with real cost and quality numbers, the Haiku-vs-Sonnet decision has evidence to sit on. Not before."*

**The move.** You named the decision status ("deferred with evidence") in the first three words. You named the specific reason routing blind is wrong (no measurement). You named the trigger for revisit. That's decision hygiene — the shape of an engineer who won't ship changes they can't verify.

**The follow-up you preempt.** *"The intent classifier is already on Haiku 4.5 — see `lib/agents/intent.ts`. So it's not a Haiku-avoidance thing; it's a measure-before-you-route thing."*

## The pattern across all six

Notice what every answer does:

1. **Verdict in the first sentence.** No throat-clearing. No "great question." Direct.
2. **Specific numbers or file paths in sentence 2 or 3.** The receipt density is the credibility.
3. **Name the tradeoff or gap the interviewer might probe next.** You beat them to it. That's what makes the answer *feel* honest instead of defensive.
4. **Never apologize for a deliberate choice.** Deferred with rationale is not the same as forgotten. Own it.

## The one line that lands the whole book

If they ask "what should I take away from this project?" — one line:

*"I shipped an AI analyst that runs the human-analyst loop on Bloomreach, and then spent 4 weeks building the eval + observability + cost + fault-tolerance + regression-gate flywheel around it. Every claim in the portfolio traces to a committed receipt. That's the receipt density I'd bring to production work."*
