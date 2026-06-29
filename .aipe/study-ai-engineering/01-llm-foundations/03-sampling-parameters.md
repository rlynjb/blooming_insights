# Sampling parameters

*Industry standard — temperature, top-p, top-k*

## Zoom out — where this concept lives

After the model produces a probability distribution over the next token, the *sampler* picks one. Sampling parameters (temperature, top-p, top-k) reshape that distribution before the pick. In this codebase, **no agent sets any sampling parameter** — every call uses Anthropic's defaults.

```
  Zoom out — where sampling lives

  ┌─ Caller (agent code) ────────────────────────┐
  │  builds ModelRequest                         │
  │  — does NOT set temperature/top-p/top-k      │
  └────────────────────┬─────────────────────────┘
                       │
                       ▼
  ┌─ Adapter (aptkit-adapters.ts:42-52) ─────────┐
  │  complete(request) builds SDK params         │
  │  — passes NO sampling field                  │
  └────────────────────┬─────────────────────────┘
                       │
                       ▼
  ┌─ ★ Anthropic API ★ ──────────────────────────┐ ← we are here
  │  model → distribution over next token        │
  │  sampler (DEFAULT params) → next token       │
  └──────────────────────────────────────────────┘
```

**Zoom in.** The codebase relies on Anthropic's defaults for everything. That's a deliberate choice but worth being honest about — every agent that should be deterministic (intent classifier, structured-output emitters) is running on the same defaults as the open-ended ones.

## Structure pass — layers · axes · seams

**Layers:** model → distribution → sampler → token.

**Axis: how much variance do I want?** The agents in this codebase have *different* answers — intent classification wants deterministic; recommendation rationale wants creative. But the code doesn't differentiate: same sampling for all.

**Seam:** the `MessageCreateParamsNonStreaming` shape at `lib/agents/aptkit-adapters.ts:42-52`. The seam exists — Anthropic accepts `temperature`, `top_p`, `top_k` here — it's just not being used.

## How it works

### Move 1 — the mental model

You know how `Math.random()` returns a number, but if you skewed the distribution (only return values near 0.5), the outputs would feel less random? Sampling parameters do that to the model's next-token distribution.

```
  Three parameters, three knobs on the same distribution

  Model produces:
    token_A: 0.45  ←──┐
    token_B: 0.30     │
    token_C: 0.15     │
    token_D: 0.07     │
    token_E: 0.03     │
    ...               │
    (long tail)       │
                      │
  temperature=0       │  pick the max → token_A every time
                      │
  temperature=0.7     │  scale + sample → mostly A or B, sometimes C
   (default)          │
                      │
  temperature=1.5     │  flatten distribution → sometimes D, E, or further
                      │
  top-p=0.9           │  keep tokens until cumulative=0.9, sample from those
   (nucleus)          │
                      │
  top-k=5             │  keep top 5 tokens, sample from those
```

### Move 2 — the step-by-step walkthrough

**Part 1 — what the adapter actually sets (and doesn't).**

From `lib/agents/aptkit-adapters.ts:42-52`:

```typescript
const params: Anthropic.Messages.MessageCreateParamsNonStreaming = {
  model: this.defaultModel,
  max_tokens: request.maxTokens ?? 4096,
  messages: request.messages.map(toAnthropicMessage),
};

if (request.system) params.system = request.system;
if (request.tools?.length) params.tools = request.tools.map(toAnthropicTool);
// NOTHING about temperature, top_p, top_k.
```

No sampling parameters set. The SDK uses Anthropic's defaults. As of 2026, Anthropic's default temperature for chat models is around `1.0` for prose, but tool-call output is constrained by the schema regardless of temperature — so the determinism comes from the schema, not the sampler.

**Part 2 — what each parameter does (in case you wire it).**

  → **`temperature: 0`** — argmax sampling. Picks the token with the highest probability every time. Reproducible. Use for: classifiers, structured outputs you want to be byte-identical across runs, regression-set replay.
  → **`temperature: 0.7`** — standard chat-like variance. Most production defaults.
  → **`temperature: 1.2+`** — more creative, more risk of going off-topic.
  → **`top_p: 0.9`** — nucleus sampling. Keep tokens until cumulative probability hits 0.9, sample within. Adaptive: a confident distribution narrows naturally; a flat one stays wide.
  → **`top_k: 40`** — hard cap. Keep only top 40 tokens regardless of distribution shape.

Anthropic recommends using either `temperature` or `top_p`, not both.

**Part 3 — where this codebase *should* care.**

```
  Agents and the sampling defaults they're running on

  ┌──────────────────┬─────────────────────┬────────────────────────┐
  │ Agent            │ Should be           │ Actually is            │
  ├──────────────────┼─────────────────────┼────────────────────────┤
  │ Intent           │ temperature=0       │ default (Anthropic's)  │
  │ classifier       │ (deterministic      │ — structurally OK      │
  │                  │  classification)    │ because parseIntent    │
  │                  │                     │ accepts anything       │
  │                  │                     │ (defaults to           │
  │                  │                     │ 'diagnostic')          │
  ├──────────────────┼─────────────────────┼────────────────────────┤
  │ Monitoring       │ temperature=0.3     │ default                │
  │ (tool selection) │ (some exploration   │ — the 6-call budget    │
  │                  │  on which EQL to    │ caps exploration       │
  │                  │  run, but mostly    │ anyway                 │
  │                  │  deterministic)     │                        │
  ├──────────────────┼─────────────────────┼────────────────────────┤
  │ Recommendation   │ temperature=0.7+    │ default                │
  │ (rationale       │ (creative prose     │ — probably already in  │
  │  writing)        │  helps)             │ this range             │
  ├──────────────────┼─────────────────────┼────────────────────────┤
  │ Diagnostic       │ Mixed — varies      │ default                │
  │                  │ between hypothesis  │ — was a source of      │
  │                  │ exploration and     │ "conclusion            │
  │                  │ conclusion          │ instability" (30% of   │
  │                  │ commitment          │ runs reach different   │
  │                  │                     │ conclusions; Phase 3   │
  │                  │                     │ retired finding)       │
  └──────────────────┴─────────────────────┴────────────────────────┘
```

The "conclusion instability" finding from the retired Phase 3 eval suite is the canonical case where this matters: same anomaly, same prompt, different conclusion on 3 of 10 runs. Lowering temperature for the conclusion-emission step would have reduced this — but it would also reduce hypothesis exploration. The right move is split sampling (low for conclusions, higher for hypotheses), which requires per-agent or even per-call control.

### Move 3 — the principle

**Sampling parameters are how you tell the model "be reproducible" vs "be creative."** Defaults are fine for chat. For structured-output agents and classifiers, `temperature=0` is the move. This codebase hasn't paid the cost yet because the structured-output paths are constrained by tool schemas, not by sampling.

## Primary diagram — the full recap

```
  Where sampling sits in the LLM call surface

  Caller → Adapter → SDK → API
                            ▼
                  ┌─ Model: distribution ─┐
                  │   over next token     │
                  └──────────┬────────────┘
                             │
                             ▼
                  ┌─ Sampler ─────────────┐
                  │  temperature: default │ ← this codebase's
                  │  top_p:       default │   only choice today:
                  │  top_k:       default │   "use Anthropic's
                  │                       │    defaults for every
                  └──────────┬────────────┘    agent"
                             │
                             ▼
                       next token
                             │
                             ▼  loop until stop
                       output sequence

  Reproducibility today: NOT guaranteed.
  An agent run on the same input may produce
  different outputs (different tool choices,
  different conclusions, different rationales).
```

## Elaborate

**Why defaults work surprisingly well here.** Two reasons:

  1. **Tool schemas constrain output.** When the model emits a `tool_use` block, the schema enforces the field shape regardless of sampling. So even at `temperature=1.0`, an EQL query call is structurally valid.
  2. **The 6-call budget caps exploration.** The monitoring prompt at `lib/agents/legacy-prompts/monitoring.md:18` enforces a hard 6-tool-call cap. High temperature can't make the agent thrash forever — it gets cut off.

**Why defaults bite anyway.** The conclusion-emission step in the diagnostic agent is unconstrained prose. High temperature there is what made the Phase 3 eval surface 30% conclusion instability. The right fix is per-call sampling — `temperature=0` for the conclusion step, default for the exploration steps — which requires plumbing sampling through the AptKit `ModelRequest` shape.

## Project exercises

### Exercise — Per-call sampling for the diagnostic conclusion

  → **Exercise ID:** B1.3
  → **What to build:** Wire `temperature` through `ModelRequest` from the AptKit boundary down through `AnthropicModelProviderAdapter.complete()`, and have the diagnostic agent set `temperature: 0` on the final conclusion-emission turn (the last call before returning).
  → **Why it earns its place:** directly addresses the retired Phase 3 finding of 30% conclusion instability. Pattern transfers to any agent that mixes exploration with structured commitment.
  → **Files to touch:** `lib/agents/aptkit-adapters.ts` (pass `request.temperature` to SDK params), `lib/agents/diagnostic.ts` or the AptKit hook surface (set `temperature=0` on the synthesis turn), `test/agents/diagnostic.test.ts` (assert the conclusion turn uses temperature 0).
  → **Done when:** running the same anomaly diagnosis 10 times produces the same conclusion text (or close to it — exploration steps can still vary), and the test suite explicitly covers the per-call sampling distinction.
  → **Estimated effort:** 1–4hr.

## Interview defense

**Q: "What temperature does your monitoring agent run at?"**

Anthropic's default — I don't set it. It's a deliberate but honest gap: the codebase relies on tool schemas to constrain structured output and on the 6-call budget to cap exploration, so default sampling has been good enough for the loop's mechanics. Where it bit was the diagnostic conclusion-emission step — the retired Phase 3 eval surfaced 30% conclusion instability on the same input. The fix is per-call temperature: 0 on the synthesis turn, default on exploration. Not wired yet.

*Anchor: "Defaults today; per-call sampling is the next move (`B1.3`)."*

**Q: "Why not just set temperature=0 everywhere?"**

Three agents want creativity: monitoring (which EQL angle to try), diagnostic (which hypothesis to explore), recommendation (rationale writing). Forcing temperature=0 globally would kill exploration and make the agents brittle to small prompt changes. The right framing is per-step, not per-agent.

*Anchor: "Exploration steps want variance; commitment steps want determinism. Split, not flat."*

## See also

  → `01-what-an-llm-is.md` — the function whose output the sampler shapes
  → `04-structured-outputs.md` — why tool schemas constrain output regardless of sampling
  → `05-evals-and-observability/03-llm-as-judge-bias.md` — eval framing for the conclusion-instability finding
