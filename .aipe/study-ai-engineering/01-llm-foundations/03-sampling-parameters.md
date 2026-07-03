# 03 — Sampling parameters

**Type:** Industry standard. Also called: temperature, top-p (nucleus sampling), top-k.

## Zoom out, then zoom in

Sampling controls the shape of the model's next-token distribution and, downstream, whether output is repeatable or creative.

```
  Zoom out — where sampling lives in the request

  ┌─ Agent layer ─────────────────────────────────────────────────────┐
  │  AnthropicModelProviderAdapter.complete(request)                   │
  │  · request.temperature ← ★ THIS CONCEPT ★                          │
  │  · request.messages, request.tools                                 │
  └─────────────────────────────┬─────────────────────────────────────┘
                                │
  ┌─ Anthropic SDK ─────────────▼─────────────────────────────────────┐
  │  messages.create({temperature, top_p?, top_k?, ...})               │
  │  passes through to model server                                    │
  └───────────────────────────────────────────────────────────────────┘
```

Zoom in. Two places in this codebase set temperature explicitly. Everywhere else, AptKit picks the default. That's a deliberate design — the agents rely on Anthropic's tuned defaults for tool-use reasoning; the judge overrides to 0 for reproducibility.

## Structure pass

**Layers:**
- Outer: reader-visible behavior (reproducibility, creativity)
- Middle: `request.temperature` in the ModelRequest
- Inner: the model server's sampling algorithm

**Axis: reproducibility.**
- `temperature: 0` → same input → same output (near-deterministic). Judge picks this.
- `temperature: 0.7` (Anthropic's typical default) → variation across runs, natural-sounding output. Agents use the default.

**Seam:** `AnthropicModelProviderAdapter.complete()`. Everything higher (AptKit, agents) speaks in `ModelRequest`; everything lower (SDK, HTTP) speaks in Anthropic-specific param names. The adapter maps.

## How it works

### Move 1 — the mental model

The model produces a probability distribution over its ~200K-token vocabulary for the next token. Sampling picks one. Temperature reshapes the distribution before picking — low temperature = sharpen (pick the most likely), high = flatten (allow the tail).

```
  Temperature reshapes the next-token distribution

  T = 0     ▓                     ← pick argmax; deterministic
            ▓
            ▓        _   _   _
           argmax

  T = 0.7  ▓ ▓                    ← natural spread; some variation
           ▓ ▓ ▓
           ▓ ▓ ▓ ▓ _ _
           top    tail

  T = 1.5  ▓ ▓ ▓ ▓                ← wild; the tail wins often
           ▓ ▓ ▓ ▓ ▓
           ▓ ▓ ▓ ▓ ▓ ▓ ▓
```

Top-p (nucleus sampling) is a cap: keep the smallest set of tokens whose probabilities sum to `p`, then sample from that set. Top-k: keep the top `k` tokens by probability, sample from those. Anthropic's SDK supports both; this repo uses neither explicitly.

### Move 2 — walk the mechanism

**Where temperature is set — two places.**

1. **The judge, at 0.** In `eval/run.eval.ts:236` and `:283`, both `RubricJudge` instances pass `temperature: 0`. This is deliberate: a judge that disagrees with itself across runs on the same input is useless for regression measurement.

```typescript
// eval/run.eval.ts:229-237
const diagnosisJudge = new RubricJudge({
  model: judgeModel,
  rubric: diagnosisQualityRubric,
  capabilityId: 'blooming.eval.diagnosis-judge',
  maxTokens: 4096,
  temperature: 0,          // ← reproducibility
});
```

2. **The agents, at the default.** No temperature is passed anywhere in `MonitoringAgent`, `DiagnosticAgent`, `RecommendationAgent`, or `QueryAgent`. The `ModelRequest` field is unset; AptKit doesn't override; Anthropic's server uses its default (currently ~0.7 for tool-use models). This is the right call for reasoning under tool-use — deterministic tool-use loops tend to get stuck in a groove.

**Why NOT temperature: 0 on the agents.**

You'd think reproducibility would help evals. It doesn't, and here's why: the ReAct loop's decisions branch heavily on tool_result values. If the SyntheticDataSource returns the same numbers (it does — it's a fixture), a `temperature: 0` agent would take the exact same path every time and eval variance would look artificially clean. Anthropic's default temperature gives you natural variance in the trace WITHOUT changing the overall verdict — which is closer to how the agent behaves on live data.

### Move 3 — the principle

Pick temperature based on what you're measuring, not on a general aesthetic. Deterministic where you need reproducibility (judges, tests, classifiers). Default where you need natural reasoning variety (agent loops, generation). Don't set top-p and top-k unless you've measured they help — extra dials, extra ways to be wrong.

## Primary diagram

Where temperature is set in this repo and what depends on it.

```
  Temperature settings in blooming_insights

  ┌─ Agents (reasoning; run against live/synthetic data) ─────────────┐
  │   temperature: (unset → Anthropic default ~0.7)                    │
  │   MonitoringAgent · DiagnosticAgent · RecommendationAgent ·        │
  │   QueryAgent · intent classifier                                    │
  └────────────────────────────────────────────────────────────────────┘

  ┌─ Judges (rubric scoring; must be reproducible) ───────────────────┐
  │   temperature: 0                                                    │
  │   RubricJudge (diagnosis rubric)                                    │
  │   RubricJudge (recommendation rubric)                               │
  │   → eval/run.eval.ts:236, :283                                     │
  └────────────────────────────────────────────────────────────────────┘

  Session D calibration mixed judges (Sonnet at 0 vs Haiku at 0)
    · 6/6 verdict agreement · 13/24 exact match dims · 24/24 within-1
  → eval/calibration/agreement-*.json
```

## Elaborate

The "temperature = 0 is deterministic" claim has a caveat: at exactly 0, Anthropic uses argmax sampling, but tie-breaking on identical logits can still produce different tokens on different backend replicas. In practice on Sonnet 4.6 with real prompts this happens vanishingly rarely, but "deterministic" is really "near-deterministic given a fixed backend build."

Top-p and top-k are worth understanding even if you don't set them:
- **top-p = 0.9** (nucleus sampling): keep the smallest cluster of tokens totalling 90% probability. Adapts — high-confidence turns get few tokens in the cluster, uncertain turns get many.
- **top-k = 40**: keep only the top 40 by probability. Hard cap regardless of distribution shape.

Combined with temperature they can compose (temperature reshapes, top-p/top-k truncate). Most production agents at this scale don't bother.

## Project exercises

### Exercise — measure judge stability under retry

- **Exercise ID:** C1.3-A · Case A (concept exercised).
- **What to build:** modify `eval/run.eval.ts` to run each `RubricJudge.judge()` call TWICE with the same input, log both `dimensions.*.score` sets to the receipt, compute per-dim stability rate across the double-judged set. Confirms that `temperature: 0` gives near-deterministic judging in practice, or reveals it doesn't.
- **Why it earns its place:** turns a design claim ("temperature 0 is reproducible") into a measured claim ("score stability across double-run: X%"). Interviewer signal: "I didn't trust that temperature 0 was actually reproducible — here's the measurement."
- **Files to touch:** `eval/run.eval.ts`, add a receipt field `diagnosisJudgmentSecondRun` and `recommendationJudgmentsSecondRun`, add a small aggregator in `afterAll`.
- **Done when:** running the 10-case eval prints a "judge stability" section with per-dim exact-match rate across the double-judged runs.
- **Estimated effort:** 1-4hr.

## Interview defense

**Q: What temperature do you run the agents at?**

Anthropic's default (~0.7). I don't override it on the agents. The reasoning is: temperature 0 tempts you into believing your evals are stable when actually you've just flattened the natural variance of the loop. The judge runs at 0 because reproducibility on a rubric matters more than variety. Agents run at the default because the ReAct loop's real behavior on live data has some randomness in it, and I want the eval to see that.

```
  agents at default T → real-world variance
  judge at T=0        → stable scoring
  = eval measures signal, not judge noise
```

**Q: When would you set top-p or top-k?**

Rarely. If I saw the model repeatedly falling into the same wrong groove on a specific class of prompt — always picking the same doomed tool call, always phrasing rejection the same wrong way — I'd try top-p around 0.9 to loosen the tail before I'd go up on temperature. Neither is in this codebase today because I haven't hit that failure pattern.

**Q: What does "temperature 0 is not fully deterministic" mean in practice?**

Anthropic argmaxes at T=0, but ties on identical logits break unpredictably across replicas. In this repo on Sonnet 4.6 I've never seen the judge score two rounds differently on the same input, but I'd never claim "guaranteed identical" — I'd say "reproducible in practice."

## See also

- `04-structured-outputs.md` — schema-constrained outputs cap variance more than temperature does
- `05-evals-and-observability/03-llm-as-judge-bias.md` — biases the judge carries at any temperature
- `eval/run.eval.ts` — the two `temperature: 0` sites
