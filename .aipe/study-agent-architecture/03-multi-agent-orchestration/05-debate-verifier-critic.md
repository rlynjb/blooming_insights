# Debate / verifier-critic

_Industry standard._

## Zoom out, then zoom in

Agents argue or critique to refine quality. This codebase does not use debate or a critic loop today — every stage produces its artifact and stops, no second-agent review pass. This file names *where* the pattern would earn its overhead if it were adopted, and *why* it isn't here yet.

```
  Zoom out — the shape blooming does NOT have

  ┌─ /api/agent (SUPERVISOR) ────────────────────────────────────┐
  │  Stage A → Diagnosis (produced, not reviewed)                │
  │  Stage B → Recommendation[] (produced, not reviewed)         │
  │                                                              │
  │  ★ NO CRITIC PASS. The judge in eval/report.eval.ts is       │
  │    for grading TEST runs, not for gating PRODUCTION outputs. │
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: the eval judge (`eval/report.eval.ts`) is a Claude-based grader that scores diagnosis and recommendation quality against a rubric. It runs offline against goldens, not in the production loop. That's a distinction worth naming: a *test-time* judge is not the same as a *production critic loop*.

## Structure pass

**Layers:** producer · critic · verdict · loop-or-return decision.
**Axis:** *does the stake justify a second full agent turn per artifact?*
**Seam:** the critic's verdict shape. In a production critic loop this must be a structured decision (`approve` | `revise-with-reasons` | `escalate-to-human`), not free text — otherwise the loop condition has to interpret prose.

```
  Two flavors, both currently unused here

  Debate (symmetric):              Verifier-critic (asymmetric):
  ┌────────┐   ┌────────┐          ┌──────────┐   ┌──────────┐
  │agent A │◄─►│agent B │          │ producer │──►│ critic   │
  │propose │   │counter │          │ (Stage A)│◄──│(review)  │
  └────────┘   └────────┘          └──────────┘   └──────────┘
       │            │                    loop until approved
       └──────┬─────┘                   (cap the rounds)
              ▼
         judge picks
```

## How it works

### Move 1 — the mental model

You've had a pull request reviewed. You wrote the code, someone else reviewed it, they approved or asked for changes, you iterated. A verifier-critic loop is that shape at the agent layer: producer writes the artifact, critic reads it, either approves or sends it back with specific reasons. The self-critique variant (Reflexion) is when the producer critiques its own draft — cheaper, but shares the blind spots that produced the draft (see `01-reasoning-patterns/05-reflexion-self-critique.md`).

```
  Pattern: verifier-critic loop

  producer produces draft
       │
       ▼
  ┌──────────────────┐
  │ critic reviews   │
  └────┬─────────────┘
       │
   ┌───┴────┐
   ▼        ▼
  approve  revise → producer again (bounded loop)
   │
   ▼
  return
```

### Move 2 — the walkthrough

**What's NOT here — a production critic on the recommendation.** The RecommendationAgent's output is not currently reviewed by a second agent. If a user gets a recommendation that says "run Scenario X for 14 days," that's what the model produced and nothing gated it. In practice the guardrail against bad recommendations is:

- the type-guard `isRecommendationArray` in `lib/mcp/validate.ts:42-56` (rejects malformed structure, not bad content),
- the fixed `bloomreachFeature` enum (`scenario|segment|campaign|voucher|experiment` — the model can't propose an unknown feature),
- the UI making the reasoning transparent (the ReasoningTrace surfaces the tool calls that produced the rec).

These catch shape errors and hallucinated features. They don't catch "the recommendation is technically valid but strategically wrong."

**What IS here — the eval judge, offline only.** `eval/report.eval.ts` runs a Claude-based grader against golden cases. It scores diagnosis and recommendation on rubrics (evidence quality, actionability, groundedness). The judge is Sonnet 4.6, same family as the producer, which is *the exact self-preference bias* the pattern warns about — see the LLM-as-judge concept in `study-ai-engineering`. That's tolerable for offline eval (calibrated against human ratings in `eval/calibration/`), but promoting the judge into the production loop as a critic would inherit that bias.

**Where debate would earn its keep — recommendation strategy.** The strongest case for a critic in this repo is recommendation. Diagnosis is grounded in evidence (EQL results either show the effect or they don't). Recommendation is a strategic call (should you segment or run a scenario?), and strategic calls have real disagreement. A critic-agent that asked "would a different Bloomreach feature fit better here?" and forced the producer to defend the choice would catch reasonable-but-wrong picks. Cost: another full ~50s Sonnet loop per investigation, roughly doubling recommend latency and cost.

**Where debate would NOT help — diagnosis.** A critic-agent reviewing a diagnosis would essentially re-run the diagnostic loop with a "does this evidence support the conclusion?" framing. That's Reflexion (self-critique on the same model), and the same-family blind spot problem applies. Better spend of tokens: sharpen the diagnostic prompt.

```
  Layers-and-hops — where a critic loop COULD sit

  ┌─ /api/agent (SUPERVISOR) ───────────────────────────────────┐
  │  Stage A: DiagnosticAgent → Diagnosis                       │
  │  Stage B: RecommendationAgent → Recommendation[]            │
  │           │                                                 │
  │           ▼ ← ★ critic hook would go here ★                 │
  │  ┌─ (hypothetical) CriticAgent ──────────────────────────┐  │
  │  │  input: Anomaly + Diagnosis + proposed Recommendations│  │
  │  │  output: approve | revise-with-reasons                │  │
  │  └───────────────────────────────────────────────────────┘  │
  │           │ if revise: back to Stage B (cap rounds = 2)     │
  └──────────────────────────────────────────────────────────────┘
```

### Move 3 — the principle

Debate and critic loops trade tokens for reliability. The threshold is the stake: high-stakes outputs (a strategic recommendation, a production diff) can justify the 2x cost of a critic pass; low-stakes outputs cannot. The failure mode this always risks: the critic is the same model family as the producer, so blind spots are shared. If the stake justifies a critic, it usually justifies a *different-family* critic (Opus over Sonnet, or GPT-4 over Sonnet) so the disagreement is real, not cosmetic. Blooming doesn't run a critic today because the recommendation output goes to a human user who acts as the last-mile critic — that human-in-the-loop replaces the model critic at zero extra token cost.

## Primary diagram

```
  Recap — current shape vs the critic-loop upgrade

  Current shape (no critic):
  ┌─────────────┐   ┌────────────────┐
  │ Diagnostic  │──►│ Recommendation │──► user
  └─────────────┘   └────────────────┘

  With critic loop (not implemented):
  ┌─────────────┐   ┌────────────────┐   ┌──────────┐
  │ Diagnostic  │──►│ Recommendation │──►│ Critic   │──► user
  └─────────────┘   └────────────────┘   │ Opus     │
                            ▲            └─────┬────┘
                            │ revise           │
                            └──────────────────┘
                              cap: 2 rounds
```

## Elaborate

The reason blooming doesn't use a critic loop in production is that the *user* is the critic. Recommendations render as cards with the full reasoning trace visible — the user sees the tool calls, the evidence, the rationale, and decides whether to act. That's human-in-the-loop critique, essentially free from a token-cost standpoint.

If blooming grew into an *autonomous* action-taker (the recommendation triggers a Bloomreach API call directly), the human critic disappears and a model critic becomes cheap by comparison. That's the natural adoption trigger. Section F's "agentic support system" template covers this shape — the moment the agent takes real actions, guardrails and critic passes move from "nice to have" to "required."

Anthropic's "Building Effective Agents" (2024) names the tradeoff clearly: debate patterns produce measurable quality gains on high-stakes reasoning but at 2-5x token cost, and self-preference bias limits the gains when the critic shares a model family with the producer. Their production recommendation matches this repo's shape: cheap producer + human-in-the-loop until the stakes force a model critic.

## Interview defense

**Q: Does this codebase use a critic loop, and if not, why not?**
A: No — the RecommendationAgent's output is not reviewed by a second agent before the user sees it. Three reasons: the output goes straight to a human user who acts as the last-mile critic (free), the reasoning trace makes the derivation transparent so the human can evaluate quality without re-computing it, and the type-guards + enum constraint on `bloomreachFeature` catch shape errors. If blooming grew into an autonomous action-taker where recommendations triggered Bloomreach API calls directly, a critic loop would earn its overhead — probably a different-family model (Opus) reviewing Sonnet's proposal to avoid the same-family blind spot.

Diagram: current shape (no critic) beside the hypothetical critic-loop shape.
Anchor: `eval/report.eval.ts` (the offline judge, showing the shape exists at test time but not in production).

**Q: Why isn't the eval judge just promoted to a production critic?**
A: The eval judge is Sonnet 4.6, same family as the producer. That's fine for offline grading calibrated against human ratings, but promoting the same-family model to a production critic bakes in the self-preference bias — the critic will systematically over-approve outputs that "sound" like its own. For a production critic to catch real errors you'd want a different model family (Opus over Sonnet, or a competing provider). The eval infrastructure would still be useful for evaluating the *critic itself*, but the critic model is a separate choice.

Diagram: the model-family bias — same family = same blind spots.
Anchor: `eval/report.eval.ts`; cross-reference `study-ai-engineering`'s LLM-as-judge bias file.

## See also

- `01-reasoning-patterns/05-reflexion-self-critique.md` — the same-agent version.
- `06-swarm-handoff.md` — the alternative topology (also rejected).
- `04-agent-infrastructure/05-guardrails-and-control.md` — the guardrails that DO exist today.
- `06-orchestration-system-design-templates/02-agentic-support-system.md` — the shape where a production critic becomes necessary.
