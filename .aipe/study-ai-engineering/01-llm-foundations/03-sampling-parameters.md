# Sampling parameters

## Subtitle

Temperature, top-p, top-k — Industry standard.

## Zoom out, then zoom in

This codebase doesn't set temperature explicitly anywhere. That's a deliberate choice: the adapter uses Anthropic's defaults, and the agents rely on the model's default sampling to be "sensible." Look at `lib/agents/aptkit-adapters.ts:57` — the `MessageCreateParams` object contains `model`, `max_tokens`, `messages`, and `tools`. No `temperature`, no `top_p`, no `top_k`.

That's fine — until it isn't. Understanding what those knobs do, and when the codebase should reach for them, is the concept.

```
  Zoom out — where sampling parameters could go

  ┌─ Agent code ─────────────────────────────────────────┐
  │  agent builds ModelRequest                            │
  └───────────────────────┬──────────────────────────────┘
                          ▼
  ┌─ AnthropicModelProviderAdapter.complete() ★ ────────┐ ← we are here
  │  today: { model, max_tokens, messages, tools }       │
  │  tomorrow: could add { temperature, top_p }          │
  └───────────────────────┬──────────────────────────────┘
                          ▼
                     Anthropic model
```

Zoom in: the sampler sits between the raw next-token distribution and the emitted token. Changing sampling doesn't change the model; it changes which token the model picks from a distribution it already produced.

## Structure pass

- **Layers:** distribution → sampler → chosen token. Three bands, all inside the model.
- **Axis: determinism.** At temperature 0, sampling is deterministic — same prompt, same output every time. At higher temperatures, sampling is stochastic — same prompt, different outputs.
- **Seam:** the sampler itself. Above it, the model is fixed. Below it, the emitted tokens depend on the sampler's settings.

## How it works

### Move 1 — the mental model

The model produces a probability distribution over the vocabulary. The sampler picks one token from that distribution. Three knobs control how:

```
  Sampling knobs — what each one does to the distribution

  raw distribution:
    "checkout"  ██████ 0.35
    "cart"      ████   0.22
    "payment"   ███    0.15
    "session"   ██     0.10
    ...(long tail)

  temperature=0:  always pick "checkout"        ← deterministic
  temperature=1:  sample from full distribution ← default-ish
  temperature=2:  boost the tail — take risks   ← creative

  top_p=0.9:      keep tokens until sum≥0.9, sample from those
                  (drops the "long tail")

  top_k=40:       keep only 40 most-likely tokens
                  (hard cap on candidate set)
```

### Move 2 — the step-by-step walkthrough

**temperature.** Scales the logits before softmax. `T=0` collapses to argmax (pick the highest-probability token). `T=1` uses the raw distribution. `T>1` flattens the distribution so lower-probability tokens are more likely.

**top_p (nucleus sampling).** Keep tokens until their cumulative probability hits `p`, then sample from that set. Adapts automatically — when the model is confident (one dominant token), the nucleus is small; when it's uncertain (many candidates), the nucleus is larger.

**top_k.** Keep only the `k` most-likely tokens. Cruder than top_p; harder cap.

**How this codebase currently uses them.** It doesn't set any of them. Anthropic's default temperature is roughly 1.0 for `messages.create()`. That's why the eval harness sees slight variation between runs of the same case — the diagnostic agent's exact wording varies turn to turn.

**Where the codebase *should* set temperature=0.** The intent classifier. `lib/agents/intent.ts:19` calls `classifyAptKitIntent()` — a single-shot classification into a fixed label set. Non-determinism here is pure noise. A future add: pass `temperature: 0` through the adapter for classifier calls. Aptkit's `ModelRequest` shape supports it (`request.temperature` is optional); the adapter just needs to plumb it through.

Diagram of the current state vs the future state:

```
  Comparison — current vs recommended

  ┌─ Current ──────────────────────────┬─ Recommended ─────────────────────┐
  │ every call uses default temp (~1)  │ agents keep default temp           │
  │                                    │ intent classifier uses temp=0      │
  │ intent varies run-to-run           │ intent is deterministic            │
  │ eval verdicts vary slightly across │ eval verdicts vary only on the     │
  │ reruns of the same case            │ agent's non-determinism, not the   │
  │                                    │ classifier's                       │
  └────────────────────────────────────┴────────────────────────────────────┘
```

**Where the codebase *should not* set temperature=0.** The agents themselves. Diagnostic + recommendation both benefit from occasional exploration — if the model gets stuck on a wrong hypothesis, a tiny bit of temperature gives it a chance to consider alternatives. Temperature 0 on a multi-turn agent tends to loop.

### Move 3 — the principle

Temperature=0 is the right default for anything you want reproducible — classifiers, structured output extractors, gate decisions. Temperature≈1 is the right default for anything multi-turn or generative — agents, chat, writing. The knob you almost never need to touch is `top_k`; nucleus sampling (`top_p`) is a better default when you need to constrain diversity.

## Primary diagram

```
  Sampling in the request/response flow — one frame

  ┌─ your code ────────────────────────────────────────┐
  │  ModelRequest {                                     │
  │    messages, tools, maxTokens,                      │
  │    temperature?,   ← MISSING in this codebase      │
  │    topP?           ← MISSING in this codebase      │
  │  }                                                  │
  └──────────────────────┬──────────────────────────────┘
                         │
                         ▼
  ┌─ Anthropic ─────────────────────────────────────────┐
  │  model → raw next-token distribution                 │
  │        → sampler (uses temperature / topP)           │
  │        → emitted token                               │
  └──────────────────────┬──────────────────────────────┘
                         │
                         ▼
                     next token
```

## Elaborate

The names come from the physics analogy: at high "temperature," a probability distribution flattens (all outcomes roughly equal); at low temperature, it sharpens (one dominant outcome). It's an analogy that has stuck.

Provider defaults matter: OpenAI's default temperature is 1.0; Anthropic's is roughly 1.0 too; some open-source stacks default to 0.7. If you swap providers via the port, verify the default before assuming "no temperature" means the same thing.

Related: **04-structured-outputs.md** (where `temperature=0` and structured outputs work together to produce reliable typed responses), **08-provider-abstraction.md** (where the `ModelRequest.temperature` field would flow through if you added it).

## Project exercises

### B1.3 · Plumb temperature through the ModelRequest

- **Exercise ID:** B1.3
- **What to build:** Add explicit `temperature: 0` to the intent classifier's model call, keeping default temperature everywhere else. Add a test that verifies the same intent query produces the same output over 5 back-to-back calls.
- **Why it earns its place:** Small, low-risk, and the eval-noise reduction is measurable. Interview payoff: "here's a specific place I found where the default was wrong and here's the fix."
- **Files to touch:** `lib/agents/aptkit-adapters.ts` (plumb `request.temperature` into `params`), `lib/agents/intent.ts` (pass temperature=0 via aptkit's classifier options), `test/agents/intent.test.ts` (determinism test).
- **Done when:** the classifier test passes 5/5 with identical output; the eval receipts stop showing intent-classification variance.
- **Estimated effort:** `1–4hr`.

## Interview defense

**Q: Your codebase doesn't set temperature anywhere. Is that a bug?**

Not for the agents — Anthropic's default is fine for multi-turn tool-using loops that benefit from occasional exploration. It *is* a gap for the intent classifier: single-shot classification into a fixed label set, where non-determinism is pure noise. The fix is a two-line plumb-through in the adapter — see `B1.3`. The load-bearing part: knowing which class of task cares about determinism and which doesn't.

**Q: Why not just use temperature=0 everywhere?**

Multi-turn agents at temperature 0 tend to loop. If the model picks a wrong tool at turn 1 and the reasoning path leading to that tool is the highest-probability path at temperature 0, the model will pick it again at turn 2, and again at turn 3, until `max_iterations` catches it. Small temperature gives the model an escape hatch. The alternative is more expensive: detect the loop in code and inject a "try a different tool" observation (see **04-agents-and-tool-use/06-error-recovery.md**).

## See also

- [04-structured-outputs.md](04-structured-outputs.md) — pairing temperature=0 with schema-constrained output.
- [../04-agents-and-tool-use/06-error-recovery.md](../04-agents-and-tool-use/06-error-recovery.md) — the loop-detection pattern for when temperature isn't enough.
- [08-provider-abstraction.md](08-provider-abstraction.md) — how the `ModelRequest` port would carry temperature across providers.
