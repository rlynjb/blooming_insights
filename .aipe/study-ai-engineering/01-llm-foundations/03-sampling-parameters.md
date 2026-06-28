# 03 — sampling parameters

**Subtitle:** Temperature / top-p / top-k · Industry standard

## Zoom out, then zoom in

Sampling parameters live inside the model call — they're knobs on how the next
token is chosen. Blooming doesn't currently set any of them; everything runs at
provider defaults.

```
  Zoom out — sampling sits inside one call

  ┌─ Agent loop ─────────────────────────────────┐
  │  adapter.complete({ messages, system,        │
  │                     tools, max_tokens })     │
  └────────────────────┬─────────────────────────┘
                       │  no temperature, no top_p, no top_k
                       ▼  passed through
  ┌─ Anthropic — sampler ────────────────────────┐
  │  ★ sample next token using defaults ★         │  ← we are here
  └───────────────────────────────────────────────┘
```

## Structure pass

  → **One axis to trace — determinism.** `temperature=0` → deterministic
    output. Higher values → more variance. This codebase uses *no* sampling
    overrides, which means provider defaults (Sonnet ~`temperature=1.0`)
    apply. The agents produce structured JSON outputs that are validated by
    runtime type guards — so variance in *prose* is tolerable, but variance
    in *shape* breaks `parseAgentJson` and the call gets rejected.

  → **The seam (which doesn't exist yet):** the place to plumb a temperature
    setting would be `AnthropicModelProviderAdapter.complete()` — but
    AptKit's `ModelRequest` type doesn't currently expose a temperature
    field, so plumbing it through means extending AptKit core. This is the
    Case B refactor.

## How it works

### Move 1 — the mental model

The model assigns a probability to every possible next token. Sampling decides
how to pick one.

```
  Same context, three sampling settings, three behaviors

  next-token distribution: ["the": 0.42, "a": 0.18, "an": 0.12, …]

  temperature=0   →  always "the"  (deterministic / argmax)
  temperature=0.7 →  usually "the", sometimes "a", rarely "an"
  temperature=1.5 →  any reasonable token, including rare ones

  top_p=0.9       →  keep tokens until cumulative probability ≥ 0.9, then
                     sample uniformly among those. Adapts to confidence.

  top_k=40        →  hard cap: only consider the top 40 tokens.
```

### Move 2 — the step-by-step walkthrough

**What Blooming actually sets.** Look at the adapter again
(`lib/agents/aptkit-adapters.ts:42-71`):

```typescript
const params: Anthropic.Messages.MessageCreateParamsNonStreaming = {
  model: this.defaultModel,
  max_tokens: request.maxTokens ?? 4096,
  messages: request.messages.map(toAnthropicMessage),
};
if (request.system) params.system = request.system;
if (request.tools?.length) params.tools = request.tools.map(toAnthropicTool);
// ← no temperature
// ← no top_p
// ← no top_k
```

That's the whole `params` object. No sampling overrides. Anthropic's default
`temperature` is 1.0; the model is sampling freely turn-to-turn.

**Why this is fine for THIS codebase, even though it sounds risky.** The
agents produce JSON that gets:

  1. Extracted by `parseAgentJson` (lenient — strips markdown fences, scans
     for `[`/`{`, tries multiple parses). `lib/mcp/validate.ts:3-13`.
  2. Validated by a type guard (`isAnomalyArray`, `isDiagnosis`,
     `isRecommendationArray`). `lib/mcp/validate.ts:17-57`.
  3. If validation fails, the agent loop emits an error or the model
     gets another turn to try again (AptKit's loop handles this internally).

So the model can vary its *prose* across runs — different diagnostic
explanations, different recommendation rationales — without breaking the
contract, because the contract is the parsed JSON shape.

**Where this is fragile.** Two places:

  → **The intent classifier.** `classifyIntent` is a one-shot, no-tools call
    that returns a single label (`diagnostic` / `monitoring` /
    `recommendation` / `query`). At default temperature, the same ambiguous
    query could classify differently on repeat. `temperature=0` would make
    repeats deterministic. AptKit's `classifyIntent` doesn't expose
    sampling, so the fix needs to land in AptKit.

  → **The monitoring agent's category selection.** When two categories
    fire on the same data (e.g. `revenue_drop` and `conversion_drop`
    measuring overlapping things), the agent's tie-breaking is
    non-deterministic. The prompt mitigates by enforcing severity sorting
    (`critical → warning → info → positive`), so two runs end up with the
    same ordered list even if the prose around each anomaly differs.

### Move 3 — the principle

**Use temperature = 0 when the output is going to be parsed; let the model run
hot when the output is going to be read by a human.** This codebase emits both
shapes from the same model — JSON contracts AND human-readable `summary` /
`rationale` / `conclusion` fields. The tradeoff is being made implicitly: the
JSON shape survives variance because of the runtime validator, and the human
prose benefits from variance because it makes the agent feel less
robotic. If parse failures start showing up in logs, temperature=0 on the
*final synthesis turn* is the move — not on every turn (which would make
multi-turn loops less robust to ambiguity).

## Primary diagram

```
  Sampling in this codebase — current state

  ┌─ AptKit ModelRequest ─────────────────────────┐
  │  { messages, system?, tools?, maxTokens? }    │  ← no sampling field
  └────────────────────┬──────────────────────────┘
                       │
                       ▼ adapter passes through
  ┌─ Anthropic MessageCreateParams ───────────────┐
  │  { model, max_tokens, system, messages, tools}│  ← also no sampling
  └────────────────────┬──────────────────────────┘
                       │
                       ▼ provider applies defaults
  ┌─ Anthropic sampler ───────────────────────────┐
  │  temperature ≈ 1.0   (Sonnet default)         │
  │  top_p, top_k = provider defaults             │
  └───────────────────────────────────────────────┘

  Refactor target: add `temperature?: number` to ModelRequest in AptKit,
  thread through in adapter, set temperature=0 for intent classifier.
```

## Elaborate

The decision to leave sampling at defaults is *implicit*, not deliberate.
Nobody picked `temperature=1.0`; it just wasn't set. For a product where the
JSON validation layer catches bad shapes, this has been fine. For a more
serious eval harness (see `05-evals-and-observability/`) you'd want
`temperature=0` for reproducibility — same inputs, same outputs, golden tests
that don't flake.

The intent classifier is the most likely place a temperature override actually
ships. Repeat queries giving inconsistent intents is a classic frustration —
the user types the same thing twice and gets routed differently. Pinning
`temperature=0` for that one model is a 5-line change once AptKit exposes the
parameter.

## Project exercises

### Exercise — plumb temperature through AptKit + Blooming, set it to 0 for intent

  → **Exercise ID:** `study-ai-eng-03.1`
  → **What to build:** Open a PR against `@rlynjb/aptkit-core` to add
    `temperature?: number` to `ModelRequest`. Update
    `AnthropicModelProviderAdapter.complete()` to pass it through. Set
    `temperature: 0` in `classifyIntent`'s adapter construction.
  → **Why it earns its place:** "How do you make the classifier
    deterministic?" is a real question for any LLM-routing product, and
    the answer "we can't, the param isn't exposed" is unsatisfying. This
    exercise is small but spans a package boundary — good signal.
  → **Files to touch:** AptKit core (upstream) ·
    `lib/agents/aptkit-adapters.ts:42-71` · `lib/agents/intent.ts:21-38`.
  → **Done when:** Two identical queries to `classifyIntent` produce identical
    outputs in a unit test (deterministic), and the existing intent tests
    still pass.
  → **Estimated effort:** `1–4hr` (the upstream PR is the most of it).

## Interview defense

**Q: What temperature does this codebase run at?**

Provider defaults — Anthropic's `temperature ≈ 1.0`. We don't set sampling
parameters anywhere in `AnthropicModelProviderAdapter.complete()`. The
agents produce structured JSON validated by a runtime type guard
(`lib/mcp/validate.ts`), so variance in the prose around the JSON is
tolerable; the contract is the shape, not the wording.

**Q: Where would lower temperature actually help here?**

The intent classifier (`lib/agents/intent.ts`). It's a one-shot, no-tools call
that returns a single label. At `temperature=0` repeat queries would always
classify identically. The blocker is that AptKit's `classifyIntent` doesn't
expose a temperature parameter today — it's a one-line addition to
`ModelRequest` and an adapter passthrough.

**Anchor line:** "We tolerate variance because the validator catches bad
shapes. The next move is `temperature=0` for intent classification — small
PR against AptKit, immediate determinism win."

## See also

  → `04-structured-outputs.md` — the validator that makes default sampling safe
  → `08-provider-abstraction.md` — the adapter where temperature would land
