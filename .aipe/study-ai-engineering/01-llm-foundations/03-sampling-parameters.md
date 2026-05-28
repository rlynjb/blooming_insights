# Sampling parameters (and the defaults this codebase deliberately keeps)

**Industry name(s):** sampling parameters, decoding controls — temperature, top-p (nucleus), top-k
**Type:** Industry standard · Language-agnostic

> Sampling controls how randomly the model picks the next token; blooming insights sets *none* of them — it accepts Claude's default temperature everywhere and tunes only `max_tokens`, including a deliberate `16` on the intent classifier to force a one-word answer.

**See also:** → 01-what-an-llm-is.md · → 02-tokenization.md · → 07-heuristic-before-llm.md

---

## Why care

A `Math.random()`-driven shuffle gives you a different order every call; a fixed seed gives you the same order every time. Some features want the variety (a "surprise me" feed); some need the repeatability (a test snapshot, a deterministic pager). The knob between them is how much randomness you allow into the selection step — and choosing the wrong setting makes a feature either boringly repetitive or untestably flaky.

The LLM equivalent is the sampling step. After the model produces a probability distribution over the next token, *something* has to pick one. Picking the single most-probable token every time is deterministic; sampling from the distribution introduces variety. The question is: for *this* task, do you want the model's output to vary call-to-call, or to be the same every time?

**The pivot: sampling parameters trade determinism for diversity, and the right setting is task-specific — a classifier wants determinism, a brainstorm wants diversity.** Temperature scales the distribution (higher = flatter = more random); top-p and top-k restrict which tokens are even eligible. Leave them at defaults and you inherit a middle-ground randomness that is fine for analysis prose and slightly wrong for a one-word classifier.

Before thinking about sampling:
- A classifier returns "monitoring" on one call and "diagnostic" on a borderline query the next
- A JSON-extraction agent's output varies in phrasing run-to-run, complicating any snapshot test
- "Why did the same query give a different intent?" has no answer

After understanding the knobs:
- You know the variation comes from non-zero default temperature, not a bug
- You can pin temperature to 0 where determinism matters (classification, synthesis)
- You can justify keeping the default where mild variety is harmless (analysis prose)

It is the seed-vs-`Math.random()` choice, made per model call instead of per shuffle.

---

## How it works

**Mental model.** The model outputs a probability distribution over the whole vocabulary for the next token. Sampling parameters reshape that distribution and then pick from it. Think of it as a weighted `Array.prototype.find` over the vocabulary where the weights are the probabilities and the parameters control how aggressively you favor the top weights.

```
model output: P(next token)
  "diagnostic" 0.55   "monitoring" 0.30   "recommendation" 0.10   ...rest 0.05

temperature scales the gap between these probabilities:
  T → 0    : pick argmax → "diagnostic" every time      (deterministic)
  T = 1    : sample as-is → mostly "diagnostic", sometimes others
  T → high : flatten → near-uniform → unpredictable

top-p (nucleus): keep the smallest set of tokens summing to p, sample within it
top-k         : keep only the k highest-probability tokens, sample within them
```

The default (when you set nothing) is the provider's chosen middle: enough randomness for natural prose, not so much that output is incoherent. blooming insights accepts that default everywhere and never reshapes the distribution.

---

### What blooming insights sets: only `max_tokens`

Grepping every `anthropic.messages.create` call confirms the honest fact: no `temperature`, no `top_p`, no `top_k` is passed anywhere. The only decoding-adjacent parameter set is `max_tokens`, which is a *length* cap, not a *randomness* control.

The agent loop's call (`lib/agents/base.ts` L92–L100) carries exactly four params — `model`, `max_tokens`, `system`, `messages` — plus `tools` on non-final turns:

```typescript
const params: Anthropic.Messages.MessageCreateParamsNonStreaming = {
  model: AGENT_MODEL,
  max_tokens: maxTokens,
  system: forceFinal && synthesisInstruction ? `${system}\n\n${synthesisInstruction}` : system,
  messages,
};
```

No `temperature` field. Same for both synthesis calls (`lib/agents/diagnostic.ts` L92–L111, `lib/agents/recommendation.ts` L96–L117) and the intent classifier (`lib/agents/intent.ts` L18–L25).

```
every create() call in the codebase:
  model        ✓ set
  max_tokens   ✓ set        (length, not randomness)
  system       ✓ set
  messages     ✓ set
  tools        ✓ (non-final turns only)
  temperature  ✗ DEFAULT
  top_p        ✗ DEFAULT
  top_k        ✗ DEFAULT
```

---

### The one deliberate decoding choice: `max_tokens: 16` on the classifier

`max_tokens` is tuned per call, and the most pointed value is on the intent classifier (`lib/agents/intent.ts` L18–L25):

```typescript
const res = await anthropic.messages.create({
  model: CLASSIFIER_MODEL,
  max_tokens: 16,
  system:
    'Classify the user query as exactly one word: monitoring ... ' +
    'diagnostic ... recommendation .... Reply with ONLY the one word.',
  messages: [{ role: 'user', content: query }],
});
```

`16` tokens is enough for one word and nothing else. The classifier physically cannot ramble — the length cap enforces what the system prompt requests. The full ladder of `max_tokens` values:

```
max_tokens by call          value   purpose
──────────────────────────  ─────   ──────────────────────────────
agent turn   base.ts L74     4096    room for tool-use + JSON output
synthesis    diagnostic L94  2048    one structured artifact, no exploration
synthesis    recommend.  L98 2048    one structured array
classifier   intent.ts L20     16    one word — bound the answer hard
```

This is the codebase being deliberate about *length* while leaving *randomness* at default. The classifier would, ideally, also pin temperature to 0 (a classification has one right answer) — but it does not, relying instead on a sharp prompt plus the tiny `max_tokens` to make the output stable in practice.

---

### Current state vs. future state

```
CURRENT                                FUTURE (where temperature would help)
────────────────────────────────      ────────────────────────────────────
all calls: default temperature         classifier: temperature 0 (determinism)
classifier: max_tokens 16 only         synthesis:  temperature 0 (stable JSON)
synthesis:  default temperature         agents:     keep default (analysis prose)
```

Two calls have a determinism interest that default temperature does not serve: the **intent classifier** (one correct label per query) and the **synthesis pass** (the same evidence should yield the same JSON). Both would benefit from `temperature: 0`. The agent exploration turns are different — mild variety in how the model phrases its reasoning is harmless and arguably helps it explore.

---

### The principle

Sampling randomness is a per-task setting, not a global default: classification and structured synthesis want determinism (temperature 0); open-ended generation tolerates or wants variety. blooming insights accepts the provider default everywhere — defensible for the analytical, JSON-extracting agents, slightly suboptimal for the two calls that have one right answer. Tuning `max_tokens` but not `temperature` shows the team controlled *length* (the cost and shape lever) and left *randomness* alone (the determinism lever) — a reasonable but incomplete set of decoding decisions.

---

## Sampling parameters — diagram

This diagram shows where decoding controls would act in the call path, and what blooming insights actually sets at each call. The Provider layer owns the sampling step; the Service layer sets only `max_tokens`.

```
┌──────────────────────────────────────────────────────────────────────┐
│  SERVICE LAYER (what this codebase sets per call)                    │
│                                                                       │
│  classifier  intent.ts L18–25   model, max_tokens:16,  system, msgs  │
│  agent turn  base.ts L92–100    model, max_tokens:4096, system, msgs │
│  synthesis   diagnostic L92–111 model, max_tokens:2048, system, msgs │
│       │                                                              │
│       │  NO temperature / top_p / top_k on any call                  │
└───────┼────────────────────────────────────────────────────────────────┘
        │  params → create()  base.ts L102
┌───────▼────────────────────────────────────────────────────────────────┐
│  PROVIDER LAYER (Anthropic — owns the sampling step)                 │
│                                                                       │
│  P(next token) ──▶ [ reshape by temperature/top_p/top_k ]            │
│                          │ (left at DEFAULT — Anthropic's choice)    │
│                          ▼                                            │
│                    sample one token ──▶ append ──▶ loop              │
│                          │                                           │
│  max_tokens bounds how many times this loop runs (length cap)        │
└────────────────────────────────────────────────────────────────────────┘
```

The randomness knobs live entirely on the Provider side and are never overridden. The Service side controls only how *long* the output can be, not how *varied*.

---

## In this codebase

**Partially addressed — `max_tokens` only.** No `temperature`, `top_p`, or `top_k` is set on any `anthropic.messages.create` call; Claude's defaults apply everywhere. The only per-call decoding tuning is `max_tokens`.

### Files, functions, and line ranges

- **Agent turn params (no temperature):** `lib/agents/base.ts` L92–L100; `max_tokens: maxTokens` with default `4096` at L74; call at L102.
- **Diagnostic synthesis (no temperature):** `lib/agents/diagnostic.ts` L92–L111; `max_tokens: 2048` at L94.
- **Recommendation synthesis (no temperature):** `lib/agents/recommendation.ts` L96–L117; `max_tokens: 2048` at L98.
- **Intent classifier (no temperature; `max_tokens: 16`):** `lib/agents/intent.ts` L18–L25; the `16` at L20; one-word system prompt L21–L23.
- **Models:** `AGENT_MODEL = 'claude-sonnet-4-6'` (`lib/agents/base.ts` L9); `CLASSIFIER_MODEL = 'claude-haiku-4-5-20251001'` (`lib/agents/intent.ts` L14).

### Why default temperature is defensible for these agents

Three of the four agents are JSON-extraction analysts: they read tool results and emit a structured artifact, then everything is parsed and validated downstream (→ 01-what-an-llm-is.md). For that work, mild output variation is invisible — the parse step normalizes phrasing away, and the type guards reject anything malformed regardless of how it was sampled. Determinism would not improve the *parsed* result; it would only make snapshot testing of the raw text easier. So leaving temperature at default costs nothing the system cares about. The two calls that genuinely want determinism — the classifier and the synthesis pass — are where the absence is a real (small) gap.

---

## Elaborate

### Where this pattern comes from

Temperature comes from the softmax: dividing logits by a temperature `T` before normalizing scales the distribution's sharpness. `T → 0` collapses to argmax (greedy decoding); `T = 1` samples the raw distribution; `T > 1` flattens it toward uniform. Top-k (Fan et al. 2018) and top-p / nucleus sampling (Holtzman et al. 2019) were introduced to fix a failure of pure temperature sampling: a long tail of low-probability tokens can still be picked and derail the output, so both methods truncate the eligible set before sampling. These three are the standard decoding controls across every major provider.

"Use defaults until a task proves it needs otherwise" is a sane engineering posture — but classification and structured extraction are exactly the tasks that *do* prove it. The literature is consistent: for tasks with a single correct output, greedy decoding (`T = 0`) is the baseline.

### The deeper principle

```
task shape                       want                    setting
──────────────────────────────  ──────────────────────  ───────────────
single correct label            determinism             temperature 0
extract one structured object   determinism + stability  temperature 0
analytical reasoning prose      coherence, mild variety  default ok
brainstorm / creative draft     diversity                temperature ↑, top_p ↓
```

The classifier (`intent.ts`) sits in the top row: a query has one intent, and randomness can only introduce wrong labels on borderline inputs. The synthesis calls sit in the second row: the same gathered evidence should yield the same diagnosis. The agent exploration turns sit in the third row, where the default is fine.

### Where this breaks down

1. **Borderline classifications flip.** A query that the model scores 0.51 "diagnostic" / 0.49 "monitoring" will, under default temperature, occasionally sample "monitoring." With `temperature: 0` it always picks "diagnostic." The `16`-token cap and sharp prompt make this rare, but not impossible — the randomness knob is still live.

2. **Synthesis output is not reproducible.** Re-running `synthesize()` on the same `toolCalls` can produce a differently-worded `conclusion`. Harmless for the user; annoying for any future eval harness that wants a stable baseline to diff against.

3. **Defaults are opaque and provider-controlled.** Because nothing is set, the effective temperature is whatever Anthropic chose and could change between model versions. The codebase has no record of, or control over, its own randomness.

### What to explore next

- **`temperature: 0` for the classifier and both synthesis calls:** the one-line change that makes the deterministic-by-nature calls deterministic in fact (the exercise below).
- **`top_p` for the agent turns:** if exploration ever feels too repetitive or too scattered, nucleus sampling is the finer control than temperature alone.
- **Stop sequences:** an alternative to `max_tokens: 16` for bounding the classifier — stop after the first word rather than after 16 tokens.

---

## Tradeoffs

### Default temperature everywhere vs. per-task tuning

| Dimension | This codebase (defaults + max_tokens) | Per-task temperature tuning |
|---|---|---|
| Setup cost | Zero — set nothing | One `temperature` field per call class |
| Classifier reliability | Good (sharp prompt + 16-token cap), not guaranteed | Deterministic on a given input |
| Synthesis reproducibility | Varies run-to-run | Stable, eval-friendly |
| Agent prose quality | Natural (default randomness) | Same if left default; worse if forced to 0 |
| Control / auditability | None — provider-chosen | Explicit, version-stable |

**What we gave up.** Determinism on the two calls that have a single correct output. The classifier can flip a borderline query; the synthesis pass cannot be reproduced byte-for-byte. Both are *small* because the prompt and the parse/validate boundary absorb most of the variance — but "small and silent" is exactly the kind of nondeterminism that confounds debugging when it does surface.

**What the alternative would have cost.** Almost nothing for the deterministic calls — one `temperature: 0` field each. The only real risk is forcing `temperature: 0` on the *agent exploration* turns, which can make multi-step reasoning more repetitive and occasionally more brittle (greedy decoding can get stuck). The correct move is selective: pin the classifier and synthesis, leave the agents at default.

**The breakpoint.** Defaults are fine until determinism becomes a *requirement* rather than a nicety — the first time someone builds an eval harness (→ Phase 3) that needs a reproducible baseline, or the first time a flaky classification causes a user-visible wrong routing. At that point, `temperature: 0` on the classifier and synthesis stops being optional.

---

## Tech reference (industry pairing)

### temperature

- **Codebase uses:** nothing — default applies on every call (`lib/agents/base.ts` L92–L100 and all `create` sites set no `temperature`).
- **Why it's here (absent):** the analytical agents tolerate mild variety because their output is parsed and validated; the team controlled `max_tokens` (length) but not temperature (randomness).
- **Leading today:** `temperature: 0` is the de-facto standard for classification and structured extraction across providers (2026).
- **Why it leads:** for single-correct-answer tasks, greedy decoding removes a source of error for free.
- **Runner-up:** low non-zero temperature (e.g. 0.2) — near-deterministic but avoids the rare degenerate loops pure greedy decoding can hit.

### top-p (nucleus sampling)

- **Codebase uses:** nothing — default.
- **Why it's here (absent):** no call needs finer-grained diversity control than the default provides.
- **Leading today:** top-p is the standard diversity knob for open-ended generation (2026), often paired with a moderate temperature.
- **Why it leads:** it adapts the eligible-token set to the distribution's shape, avoiding both the rigidity of top-k and the tail risk of raw temperature sampling.
- **Runner-up:** top-k — simpler, fixed-size cutoff; less adaptive.

### `max_tokens` (length cap)

- **Codebase uses:** `4096` / `2048` / `16` across agent / synthesis / classifier calls.
- **Why it's here:** it bounds output length — cost and shape — and the `16` enforces the one-word classifier contract.
- **Leading today:** universal across providers (2026); not a differentiator.
- **Why it leads:** bounds the most expensive output component with a single integer (→ 06-token-economics.md).
- **Runner-up:** stop sequences — content-based termination instead of count-based.

---

## Project exercises

### Pin temperature 0 on the classifier and both synthesis calls, then measure determinism

- **Exercise ID:** B1.3 (adapted) — sampling control for deterministic sub-tasks.
- **What to build:** add `temperature: 0` to the classifier call and both `synthesize()` calls, leave the agent exploration turns at default, then run each fixed input N times and record how often the output is identical before vs. after.
- **Why it earns its place:** demonstrates you know which calls have a single correct answer and that you measured the effect rather than asserting it — the exact "show the determinism" interview signal.
- **Files to touch:** `lib/agents/intent.ts` (classifier), `lib/agents/diagnostic.ts` (`synthesize`), `lib/agents/recommendation.ts` (`synthesize`); a small repeat-run script under `test/`.
- **Done when:** the classifier returns the identical label on N/N repeats of a borderline query, and a `synthesize()` call returns byte-identical JSON on N/N repeats of the same `toolCalls`, with the before/after counts recorded.
- **Estimated effort:** 1–4hr

### Replace the classifier's `max_tokens: 16` bound with a stop sequence

- **Exercise ID:** C1.3 (adapted) — decoding-control alternatives.
- **What to build:** swap `max_tokens: 16` for a stop sequence that ends generation after the first word, and compare robustness on adversarial multi-word queries.
- **Why it earns its place:** shows you understand `max_tokens` and stop sequences are two different ways to bound output, with different failure modes.
- **Files to touch:** `lib/agents/intent.ts` (`classifyIntent`), `test/agents/intent.test.ts`.
- **Done when:** the classifier returns a single word for inputs that previously produced two, and `parseIntent` still maps it correctly.
- **Estimated effort:** <1hr

---

## Summary

Sampling parameters — temperature, top-p, top-k — control how randomly the model selects the next token from its output distribution; the right setting is task-specific. blooming insights sets none of them: Claude's default temperature applies on every `anthropic.messages.create` call, and the only per-call decoding tuning is `max_tokens` (`4096` agent, `2048` synthesis, `16` classifier). Default temperature is defensible for the JSON-extraction agents, whose output is parsed and validated downstream, but slightly suboptimal for the two calls with a single correct answer — the intent classifier and the synthesis pass — both of which would ideally use `temperature: 0`.

**Key points:**
- Temperature trades determinism for diversity; top-p/top-k restrict the eligible token set.
- This codebase sets only `max_tokens`; `temperature`/`top_p`/`top_k` are left at provider defaults.
- `max_tokens: 16` on the classifier (`lib/agents/intent.ts` L20) bounds the answer to one word but does not make it deterministic.
- Default temperature is fine for analytical agents (output is parsed/validated) and a small gap for the classifier and synthesis (single correct answer).
- The fix is selective: `temperature: 0` for classification and synthesis, default for exploration.

---

## Interview defense

### What an interviewer is really asking

"What temperature do you use?" probes whether you understand that randomness is a per-task setting and whether you can defend a default. The senior move is to admit the codebase uses defaults, explain why that is fine for the analytical agents, and name the two calls where it is a (small) gap — rather than claiming a tuned value that does not exist.

### Likely questions

**[mid] What sampling parameters does this codebase set?**

Only `max_tokens`. No `temperature`, `top_p`, or `top_k` is passed on any `anthropic.messages.create` call (`lib/agents/base.ts` L92–L100, all `create` sites). Claude's defaults apply for randomness.

```
set:    model, max_tokens, system, messages, (tools)
unset:  temperature, top_p, top_k  → provider default
```

**[senior] The intent classifier has one correct answer per query. Is default temperature the right choice for it?**

No — ideally it would be `temperature: 0`. A classification has a single right label, so greedy decoding removes a source of error for free; under default temperature a borderline query can sample the wrong label. The codebase mitigates with a sharp prompt and `max_tokens: 16` (`lib/agents/intent.ts` L20), which makes flips rare but does not eliminate them. The clean fix is one line.

```
borderline query: P(diagnostic)=0.51, P(monitoring)=0.49
  default temp → samples monitoring ~49% of the time
  temperature 0 → always diagnostic
```

**[arch] Would you set `temperature: 0` everywhere?**

No — selectively. Pin it on the classifier and both `synthesize()` calls (single correct output, want reproducibility). Leave the agent exploration turns at default: greedy decoding can make multi-step reasoning repetitive or get stuck, and the agents' output is parsed and validated anyway, so the variance is absorbed.

```
classifier   → temp 0   (one label)
synthesis    → temp 0   (stable JSON)
agent turns  → default  (exploration, parsed downstream)
```

### The question candidates always dodge

**"Why didn't you set temperature at all?"** The honest answer is that the team controlled length (`max_tokens`) but not randomness, and the analytical agents do not need it because their output is parsed and validated — but the classifier and synthesis *do* have a determinism interest that the default does not serve. Pretending the default was a deliberate determinism choice would be wrong; it is an accepted gap.

### One-line anchors

- No `temperature`/`top_p`/`top_k` anywhere — `lib/agents/base.ts` L92–L100 is representative.
- `lib/agents/intent.ts` L20 — `max_tokens: 16`, the one-word classifier bound (not a randomness control).
- `lib/agents/diagnostic.ts` L94 / `recommendation.ts` L98 — synthesis `max_tokens: 2048`, default temperature.
- temperature 0 = argmax (deterministic); default = mild randomness; the classifier and synthesis want the former.

---

## Validate

### Level 1 — Reconstruct

From memory: name the three sampling parameters, what each does to the distribution, and which of them this codebase sets (none). List the `max_tokens` value for the classifier, the agent turn, and a synthesis call.

### Level 2 — Explain

Out loud: why is default temperature harmless for the diagnostic agent's exploration turns but a (small) liability for the intent classifier? Tie the answer to the parse/validate boundary in → 01-what-an-llm-is.md.

### Level 3 — Apply

Scenario: QA reports the same free-form query is occasionally routed to a different agent. Open `lib/agents/intent.ts` L18–L25. Explain how default temperature on the classifier produces this, why `max_tokens: 16` does *not* fix it, and the exact one-line change that does.

### Level 4 — Defend

A colleague proposes `temperature: 0` on *every* call including the agent loop in `lib/agents/base.ts`. Argue which calls should get it and which should not, and name the concrete risk of forcing greedy decoding on the multi-step exploration turns.

### Quick check — code reference test

How many sampling-randomness parameters does any `anthropic.messages.create` call in this codebase set? (Answer: zero — only `max_tokens` is set; `temperature`/`top_p`/`top_k` are all left at Claude defaults.)
