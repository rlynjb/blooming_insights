# Sampling parameters (and the defaults this codebase deliberately keeps)

**Industry name(s):** sampling parameters, decoding controls — temperature, top-p (nucleus), top-k
**Type:** Industry standard · Language-agnostic

> Sampling controls how randomly the model picks the next token; blooming insights sets *none* of them — it accepts Claude's default temperature everywhere and tunes only `max_tokens`, including a deliberate `16` on the intent classifier to force a one-word answer.


---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Sampling parameters live inside the Provider step — the moment after the model produces a distribution over the next token and *something* has to pick one. That selection happens inside `anthropic.messages.create` at `lib/agents/base.ts` L102, and the codebase touches only one knob alongside it: `max_tokens`. Temperature, top-p, top-k are all left at provider defaults across every call site (agent loop, both `synthesize()` calls, intent classifier).

```
  Zoom out — where sampling lives

  ┌─ Per-agent (what gets passed)  ───────────────────┐
  │  classifier   intent.ts L18–25     max_tokens 16   │
  │  agent turn   base.ts L92–100      max_tokens 4096 │
  │  synthesis    diagnostic.ts L97–116 max_tokens 2048│
  │  NO temperature / top_p / top_k on any call site   │
  └─────────────────────────┬──────────────────────────┘
                            │  params → create()
  ┌─ Provider ──────────────▼──────────────────────────┐  ← we are here
  │  anthropic.messages.create(params)                 │
  │  P(next token)  ──▶  ★ SAMPLE ★  ──▶  append      │
  │  ↑ reshape by temperature/top_p/top_k (DEFAULT)    │
  │  max_tokens bounds how many iterations of the loop │
  └────────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question is: for *this* call, do you want the output to vary or to be the same every time? Sampling parameters are the per-task answer — temperature 0 for classification, default for exploration, somewhere in between for synthesis. blooming insights answers "default everywhere," which How it works shows is defensible for three of the four agents and a small gap on the classifier.

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

### What this system sets: only `max_tokens`

Scan every model-call site and the honest fact lands: no `temperature`, no `top_p`, no `top_k` is passed anywhere. The only decoding-adjacent parameter set is `max_tokens`, which is a *length* cap, not a *randomness* control.

The agent loop's call carries exactly four params — `model`, `max_tokens`, `system`, `messages` — plus `tools` on non-final turns:

```
  params = {
    model:       AGENT_MODEL,
    max_tokens:  maxTokens,
    system:      forceFinal ? base + synthesisInstruction : base,
    messages:    messages,
  }
```

No `temperature` field. Same for both synthesis calls and the intent classifier.

```
every model-call site:
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

`max_tokens` is tuned per call, and the most pointed value is on the intent classifier:

```
  response = provider_sdk.messages.create({
    model:       CLASSIFIER_MODEL,
    max_tokens:  16,
    system:      "Classify the user query as exactly one word: "
                 "monitoring ... diagnostic ... recommendation. "
                 "Reply with ONLY the one word.",
    messages:    [{ role: "user", content: query }],
  })
```

16 tokens is enough for one word and nothing else. The classifier physically cannot ramble — the length cap enforces what the system prompt requests. The full ladder of `max_tokens` values:

```
max_tokens by call    value   purpose
──────────────────    ─────   ──────────────────────────────
agent turn             4096    room for tool-use + JSON output
diagnostic synthesis   2048    one structured artifact, no exploration
recommendation synth.  2048    one structured array
classifier               16    one word — bound the answer hard
```

This is the system being deliberate about *length* while leaving *randomness* at default. The classifier would, ideally, also pin temperature to 0 (a classification has one right answer) — but it does not, relying instead on a sharp prompt plus the tiny `max_tokens` to make the output stable in practice.

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

Sampling randomness is a per-task setting, not a global default: classification and structured synthesis want determinism (temperature 0); open-ended generation tolerates or wants variety. You can accept the provider default everywhere — defensible for the analytical, JSON-extracting agents, slightly suboptimal for the two calls that have one right answer. Tuning `max_tokens` but not `temperature` shows the team controlled *length* (the cost and shape lever) and left *randomness* alone (the determinism lever) — a reasonable but incomplete set of decoding decisions.

---

## Sampling parameters — diagram

This diagram shows where decoding controls would act in the call path, and what blooming insights actually sets at each call. The Provider layer owns the sampling step; the Service layer sets only `max_tokens`.

```
┌──────────────────────────────────────────────────────────────────────┐
│  SERVICE LAYER (what this codebase sets per call)                    │
│                                                                       │
│  classifier  intent.ts   model, max_tokens:16,  system, msgs  │
│  agent turn  base.ts    model, max_tokens:4096, system, msgs │
│  synthesis   diagnostic model, max_tokens:2048, system, msgs │
│       │                                                              │
│       │  NO temperature / top_p / top_k on any call                  │
└───────┼────────────────────────────────────────────────────────────────┘
        │  params → create()  base.ts
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

## Implementation in codebase

**Partially addressed — `max_tokens` only.** No `temperature`, `top_p`, or `top_k` is set on any `anthropic.messages.create` call; Claude's defaults apply everywhere. The only per-call decoding tuning is `max_tokens`.

### Files, functions, and line ranges

- **Agent turn params (no temperature):** `lib/agents/base.ts` L92–L100; `max_tokens: maxTokens` with default `4096` at L74; call at L102.
- **Diagnostic synthesis (no temperature):** `lib/agents/diagnostic.ts` L97–L116; `max_tokens: 2048` at L99.
- **Recommendation synthesis (no temperature):** `lib/agents/recommendation.ts` L96–L122; `max_tokens: 2048` at L98.
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
- `lib/agents/diagnostic.ts` L99 / `recommendation.ts` L98 — synthesis `max_tokens: 2048`, default temperature.
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

## See also

→ 01-what-an-llm-is.md · → 02-tokenization.md · → 07-heuristic-before-llm.md

---
Updated: 2026-05-28 — Re-derived the drifted synthesis-call ranges (diagnostic L97–L116 / `max_tokens` L99, recommendation L96–L122); the no-temperature finding and `base.ts`/`intent.ts` refs verified unchanged.
Updated: 2026-05-30 — Migrated to study.md v1.47 template (Phase 1+2 mechanical): removed Tradeoffs / Tech reference / Summary sections; renamed "In this codebase" → "Implementation in codebase"; moved See also to a bottom block. "Why care" preserved pending Phase 3 (Zoom out, then zoom in + LAYERS diagram) authoring.
Updated: 2026-05-30 — Phase 3 of study.md v1.47 migration: replaced "Why care" block with "Zoom out, then zoom in" (LAYERS diagram + zoom-in paragraph) per format.md.
Updated: 2026-05-31 — Applied study.md v1.48: scrubbed "How it works" of file paths, line refs, and real-code fences; replaced with generic role labels + pseudocode per format.md. Codebase-specific anchoring lives exclusively in "Implementation in codebase".
