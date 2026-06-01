# What an LLM is (a next-token function you never trust raw)

**Industry name(s):** large language model, autoregressive next-token predictor, foundation model
**Type:** Industry standard · Language-agnostic

> blooming insights treats Claude as one thing — a function that maps a prompt to a string of tokens — and never trusts that string: every agent output is parsed through `parseAgentJson`, validated by a type guard, and degraded to a hard-coded `FALLBACK` if it does not conform.


---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** The "LLM" in this system is the single call site `anthropic.messages.create` inside `runAgentLoop` (`lib/agents/base.ts` L102), sitting in the Provider band. Everything above it — the route, the pipeline, the per-agent definitions — exists to construct the input; everything below it (the SDK over HTTPS) is the model. The output crosses back up as a `string`, and the trust boundary where that string becomes a typed value lives one layer up in the per-agent code.

```
  Zoom out — where "an LLM" lives

  ┌─ Pipeline ──────────────────────────────────────┐
  │  monitoring → diagnostic → recommendation        │
  └─────────────────────────┬────────────────────────┘
                            │
  ┌─ Per-agent + Agent loop ▼────────────────────────┐
  │  runAgentLoop (lib/agents/base.ts)               │
  │  parse + validate + FALLBACK (the trust boundary)│
  └─────────────────────────┬────────────────────────┘
                            │  anthropic.messages.create  L102
  ┌─ Provider ──────────────▼────────────────────────┐  ← we are here
  │  ★ THE LLM (Anthropic Messages SDK) ★            │
  │  P(next | context) → sample → append → stop      │
  └─────────────────────────┬────────────────────────┘
                            │  res.content → join → finalText: string
                            ▼
                     back up to per-agent for parse/validate
```

**Zoom in — narrow to the concept.** The question is: what is the *type* of the thing on the other end of `anthropic.messages.create`? It is a probabilistic next-token function whose output is `string` — never `Diagnosis`, never `Anomaly[]`. Everything How it works covers — `parseAgentJson`, the type guards, the three-tier fallback — exists because that single fact is true.

---

## Structure pass

**Layers.** Four layers stack from caller to model: the per-agent code that constructs the call and consumes its return, the agent loop (`runAgentLoop`) that wraps `messages.create` and joins text blocks into `finalText`, the provider SDK that frames an HTTPS request, and the model itself (frozen weights producing a token distribution). The layers are stacked one-way: input goes down, a `string` comes back up.

**Axis: trust.** What does each layer trust about the bytes flowing past it? This axis is the right lens because the whole reason this file exists is to say "the model output is untrusted until the per-agent code earns its type." Control would flatten everything (the caller always decides the prompt; the model always decides the tokens); cost is downstream; trust is the lens that makes the load-bearing seam pop.

**Seams.** The seam between the provider SDK and the agent loop is cosmetic — both treat the response as raw text blocks. The load-bearing seam is one layer up: between the agent loop's returned `finalText: string` and the per-agent code that consumes it. Trust flips here from "probabilistic, possibly-malformed prose" to "must be a typed `Diagnosis` / `Anomaly[]` or the floor `FALLBACK` kicks in." Every parse, every type guard, every three-tier fallback exists to honor this single seam.

```
  Structure pass — what an LLM is

  ┌─ 1. LAYERS ───────────────────────────────────┐
  │  per-agent (constructs + consumes)             │
  │  agent loop (messages.create + join text)      │
  │  provider SDK (HTTPS framing)                  │
  │  model (frozen weights → token distribution)   │
  └────────────────────────┬───────────────────────┘
                           │  pick the axis
  ┌─ 2. AXIS ─────────────▼────────────────────────┐
  │  trust: what does each layer trust about the   │
  │  bytes flowing past it?                        │
  └────────────────────────┬───────────────────────┘
                           │  trace across layers, find flips
  ┌─ 3. SEAMS ────────────▼────────────────────────┐
  │  SDK↔loop: cosmetic (both see raw text)        │
  │  loop↔per-agent: LOAD-BEARING                  │
  │    finalText: string → typed Diagnosis or      │
  │    FALLBACK; parse + validate live here        │
  └────────────────────────┬───────────────────────┘
                           ▼
                   Block 4 — How it works
```

```
  A seam — "what is this string?" answered two ways

  ┌─ agent loop ─┐    seam     ┌─ per-agent ─┐
  │ untrusted    │ ════╪═════► │ typed value │
  │ finalText    │  (it flips) │ or FALLBACK │
  └──────────────┘             └─────────────┘
         ▲                              ▲
         └────── same axis, two answers ─┘
                 → this boundary carries the contract
```

The skeleton is mapped — the rest of this file walks the mechanics that hang off it.

## How it works

**Mental model.** An LLM is a pure function `f(tokens) → next-token-distribution`, sampled and looped. Give it a sequence of tokens; it returns a probability distribution over the next token; you sample one, append it, and call again. Repeat until a stop condition. The "intelligence" is entirely in the learned weights; the runtime is a `while` loop over a sampling step. This is why the output is a `string` and nothing more — there is no JSON encoder in the model, only a sequence of sampled tokens that *happen* to spell valid JSON when the prompt is good and the dice cooperate.

```
prompt tokens ──▶ ┌──────────────────────────────┐
                  │  LLM (frozen weights)         │
[t0 t1 t2 ... tn] │  P(next | t0..tn)             │ ──▶ distribution over vocab
                  └──────────────────────────────┘
                              │ sample one token
                              ▼
                  append tn+1, loop until stop
                              │
                              ▼
                  finalText: "Here's the diagnosis:\n```json\n{...}\n```"
                              │
                              ▼  ← the boundary where trust must be earned
                  parse → validate → fall back
```

Everything left of the trust boundary is probabilistic. Everything right of it is your typed program. You draw that boundary explicitly and treat it as the single most important contract in the system.

---

### The call site: a string in, a string out

The shared agent loop is the only place the model is invoked. Inside that loop, you call the provider SDK:

```
  response = provider_sdk.messages.create(params)
```

The response carries an array of content blocks. The loop extracts the text blocks and joins them into one string:

```
  response.content
        │
        ▼
  filter blocks where type == "text"
        │
        ▼
  map blocks to their text and join
        │
        ▼
  finalText: string
```

That is the entirety of what the model "returns" to the rest of the system: a joined `string`. There is no schema attached, no type, no guarantee. The model could have returned a JSON object, a markdown-fenced object, an apology, or an empty string. The next stage's job is to find out which.

---

### The trust boundary: parse, validate, fall back

Here's the part everyone trips on. After the loop returns `finalText`, the per-agent code runs a three-tier chain:

```
  diag = parse_and_validate(finalText)        // tier 1: parse + shape check
      OR await synthesize(anomaly, toolCalls) // tier 2: retry, clean context
      OR FALLBACK                              // tier 3: hand-written safe value
```

The parse-and-validate step does the two things you do to any untrusted payload: it parses (the JSON extractor) and it validates the shape (a type-guard predicate). If either step fails, it returns `null` — it never lets a malformed object through.

```
finalText (untrusted string)
      │
      ▼
parse JSON ───── throws? ──▶ catch → null
      │ object
      ▼
shape guard ──── false? ───▶ null
      │ true
      ▼
typed Diagnosis ✓
```

The `FALLBACK` is the floor:

```
  FALLBACK = {
    conclusion: "Insufficient data to determine a cause for this change.",
    evidence: [],
    hypothesesConsidered: [],
  }
```

This object is a literal, written by hand, with no model involvement. It exists so that the investigation function always returns a valid `Diagnosis` — the function's return type is honest even when the model produced nothing usable. The route can emit a `diagnosis` event unconditionally; the recommendation step always receives a well-typed object to build on.

---

### Why the boundary is non-negotiable

The monitoring agent makes the same point in its degradation path:

```
  parsed: unknown
  try:
      parsed = parse_json(finalText)
  catch:
      return []
  if not is_anomaly_array(parsed):
      return []
```

Note `parsed: unknown` — the strongest possible statement that the model's output has no type until proven. The `catch` and the shape guard are the two gates. Anything that fails either gate becomes `[]` (no anomalies) rather than a thrown error that kills the briefing.

```
model output  →  unknown  →  [parse]  →  [validate]  →  typed
                              │ fail       │ fail
                              ▼            ▼
                             []           []     (graceful, never throws)
```

---

### The principle

An LLM call is an I/O boundary with an untyped, adversarial-by-default return value — closer to `fetch` against a flaky third party than to a local function call. You earn the type on the way in: parse, validate, fall back. You never let a model string cross into your typed domain without that earning step, which is why a bad generation degrades a single investigation gracefully instead of crashing the system.

---

## What an LLM is — diagram

This diagram spans the full path from prompt to typed value. The Provider layer is probabilistic; the Service layer is where the string is forced into a type or replaced by a safe default. A reader who sees only this should grasp that the model returns a string and the type is manufactured downstream.

```
┌──────────────────────────────────────────────────────────────────────┐
│  PROVIDER LAYER (Anthropic — probabilistic)                          │
│                                                                       │
│  anthropic.messages.create(params)        lib/agents/base.ts         │
│     loop: P(next token | context) → sample → append → stop          │
│           │                                                          │
│           ▼                                                          │
│  res.content = [ { type:'text', text: "...```json {...}```" }, ... ] │
└───────────────────────────┬───────────────────────────────────────────┘
                            │  text blocks joined → finalText: string
┌───────────────────────────▼───────────────────────────────────────────┐
│  SERVICE LAYER (typed — trust earned here)                           │
│                                                                       │
│  finalText (string, untrusted)                                       │
│     │                                                                │
│  ┌──▼─────────────────────────────────┐  lib/mcp/validate.ts        │
│  │ parseAgentJson                     │  fence → bare → substring   │
│  └──┬─────────────────────────────────┘                             │
│     │ object | throw                                                 │
│  ┌──▼─────────────────────────────────┐  lib/mcp/validate.ts        │
│  │ isDiagnosis / isAnomalyArray        │  shape proof                │
│  └──┬─────────────────────────────────┘                             │
│     │ valid           │ invalid / threw                             │
│     ▼                 ▼                                              │
│  typed Diagnosis   synthesize() ?? FALLBACK   diagnostic.ts         │
└────────────────────────────────────────────────────────────────────────┘
```

The model never hands the system a `Diagnosis`. It hands the system a string, and the Service layer either proves that string is a `Diagnosis` or substitutes a hand-written one.

---

## Implementation in codebase

### Files, functions, and line ranges

- **The model call:** `anthropic.messages.create(params)` — `lib/agents/base.ts`, `runAgentLoop`, L102. The single point where Claude is invoked for all four agents.
- **Text extraction:** `res.content.filter(b => b.type === 'text').map(b => b.text).join('')` — `lib/agents/base.ts` L108–L113 (surfacing to `onText`) and L122 (the returned `finalText`).
- **Parse step:** `parseAgentJson(text)` — `lib/mcp/validate.ts` L3–L13. Three escalating strategies: markdown fence, bare `JSON.parse`, then a first-bracket-to-last-bracket substring scan; throws if all fail.
- **Validate step (type guards):** `isAnomalyArray` (`lib/mcp/validate.ts` L17–L27), `isDiagnosis` (L29–L35), `isRecommendationArray` (L42–L53). Each is a `v is T` predicate that proves the shape field by field.
- **Fall back:** `FALLBACK` constant — `lib/agents/diagnostic.ts` L16–L20; the three-tier chain — `lib/agents/diagnostic.ts` L74–L75. Monitoring's `[]` degradation — `lib/agents/monitoring.ts` L113–L118.
- **Model identity:** `AGENT_MODEL = 'claude-sonnet-4-6'` — `lib/agents/base.ts` L9. The one constant naming the function being called.

### Why three tiers, not one

The single most important design choice is that there are three independent answers to "what if the model output is bad," not one. `tryParseDiagnosis` handles malformed output that the loop's final turn produced. `synthesize()` handles the case where the loop produced prose but the gathered evidence is salvageable (a fresh, clean-context retry — see → 04-structured-outputs.md). `FALLBACK` handles total failure. Each tier covers a failure mode the previous tier cannot, and the bottom tier is model-independent so it can never itself fail.

---

## Elaborate

### Where this pattern comes from

The autoregressive language model — predict the next token given all previous tokens — is the architecture introduced by the GPT line (Radford et al., 2018) and scaled through GPT-3 (Brown et al., 2020) into the foundation-model era. The mechanism is unchanged across vendors: a transformer produces a distribution over a vocabulary, a sampler picks a token, the token is appended, and the loop repeats. "Large" refers to parameter count and training corpus; the *interface* — tokens in, token-distribution out — is identical to a 2018 model.

The "never trust raw output" discipline is older than LLMs. It is the same rule as "validate at the boundary" from input validation, "parse, don't validate" from typed functional programming, and "treat all network responses as hostile" from web security. LLMs make the rule unavoidable because the output is not merely *possibly* malformed — it is *generatively* variable: the same prompt can produce conformant JSON on one call and a wrapped explanation on the next.

### The deeper principle

```
deterministic backend                LLM backend
──────────────────────────────       ──────────────────────────────
same input → same output             same input → distribution of outputs
malformed = a bug to report          malformed = an expected fraction of calls
schema enforced server-side          schema is a *request*, honored statistically
validate to catch rare errors        validate to catch a routine event
```

When the backend is deterministic, validation catches bugs. When the backend is an LLM, validation is part of the happy path: a meaningful fraction of well-formed prompts still produce output that needs repair or rejection. The fallback chain is not error handling bolted on; it is the control flow.

### Where this breaks down

1. **Validation proves shape, not correctness.** `isDiagnosis` confirms `conclusion` is a string and `evidence` is an array. It cannot confirm the conclusion is *true* or the evidence *real*. A confidently hallucinated diagnosis passes every type guard. Shape validation is necessary, not sufficient; correctness needs evals (a separate, currently-absent concern).

2. **`FALLBACK` is silent.** When the chain reaches `FALLBACK`, the user sees "Insufficient data" with no signal that the model actually failed to produce JSON versus genuinely finding nothing. The two cases are indistinguishable downstream — an observability gap (see → 06-token-economics.md).

3. **The substring-scan in `parseAgentJson` can mis-parse.** Grabbing first-bracket-to-last-bracket recovers JSON from prose, but a response containing two JSON blocks, or prose with stray brackets, can yield a wrong-but-parseable object that then *passes* the type guard. The scan is a pragmatic recovery, not a correctness guarantee.

### What to explore next

- **Constrained / structured decoding** (Outlines, OpenAI structured outputs, Anthropic tool-use JSON): force valid JSON at the token level so `parseAgentJson` becomes unnecessary for the parse step.
- **Logit bias and grammar-constrained sampling:** controlling the distribution directly rather than rejecting bad samples after the fact.
- **Evals (Phase 3):** the layer that checks *correctness* of model output, which validation deliberately does not.

---

## Project exercises

### Make `FALLBACK` observable

- **Exercise ID:** C1.13/C1.14 (adapted) — foundational reliability instrumentation.
- **What to build:** thread a discriminator through `DiagnosticAgent.investigate` so the route can emit *which* tier produced the diagnosis (`parsed` / `synthesized` / `fallback`), and surface a distinct UI state when `FALLBACK` was used.
- **Why it earns its place:** demonstrates you understand that a silent fallback hides a model failure, and that "the function always returns a valid type" is not the same as "the model succeeded."
- **Files to touch:** `lib/agents/diagnostic.ts` (return a tagged result), `lib/mcp/events.ts` (extend the `diagnosis` event), `app/api/agent/route.ts` (forward the tag), `app/investigate/[id]/page.tsx` (render the fallback state).
- **Done when:** a forced parse failure (inject a fake that returns prose) produces a `diagnosis` event tagged `fallback` and a visibly distinct UI, while a normal run is tagged `parsed`.
- **Estimated effort:** 1–4hr

### Harden `parseAgentJson` against multi-block prose

- **Exercise ID:** C1.4 (adapted) — boundary-parsing robustness.
- **What to build:** add a unit-tested case to `parseAgentJson` for output containing prose plus two JSON blocks, and make the substring scan prefer the first *valid* fenced block over a naive first-bracket-to-last-bracket grab.
- **Why it earns its place:** shows you found the concrete failure mode where the recovery scan returns a wrong-but-parseable object that passes the type guard.
- **Files to touch:** `lib/mcp/validate.ts` (`parseAgentJson`), `test/mcp/validate.test.ts` (new fixtures).
- **Done when:** a fixture with prose + two fenced JSON objects parses to the intended object, and the existing tests still pass.
- **Estimated effort:** 1–4hr

---

## Interview defense

### What an interviewer is really asking

"What does an LLM return?" is checking whether you conflate the model's output with your domain object. The senior signal is saying "a string, which I treat as untrusted I/O" without prompting, and then describing the parse/validate/fallback boundary as control flow rather than error handling.

### Likely questions

**[mid] What is the return type of `anthropic.messages.create` in this codebase, and what happens to it?**

`res.content` is an array of content blocks; the loop filters text blocks and joins them into `finalText: string` (`lib/agents/base.ts` L122). That string is untrusted — it goes into `parseAgentJson` then a type guard before any field is read.

```
res.content → [text, text] → join → finalText: string → parse → validate → typed
```

**[senior] The model returns valid JSON 95% of the time. Why build a fallback chain for the other 5%?**

Because at production volume 5% is not an edge case — it is a routine event, and an unhandled one crashes a real user's investigation. The chain (`lib/agents/diagnostic.ts` L74–L75) covers three distinct failure modes: malformed loop output (`tryParseDiagnosis`), salvageable-evidence-but-prose (`synthesize`), and total failure (`FALLBACK`). The bottom tier is hand-written so it cannot itself fail.

```
95% → tryParseDiagnosis ✓
 5% → null → synthesize() ──✓ or──▶ FALLBACK (always valid)
```

**[arch] Your type guard passes but the diagnosis is hallucinated. What does validation actually buy you?**

Shape, not truth. `isDiagnosis` proves `conclusion` is a string and `evidence` is an array — it cannot prove the content is real. Validation prevents *crashes* and *type errors*; catching *wrong-but-well-formed* output is the job of evals, which this codebase does not yet have. Conflating the two is the mistake.

```
isDiagnosis ✓  →  "won't crash"      (validation)
            ✗  →  "won't crash"
truth?         →  "is it correct?"   (evals — separate layer)
```

### The question candidates always dodge

**"Where exactly is the boundary between the model and your typed code?"** The honest answer names the line: `lib/agents/base.ts` L122, where text blocks become `finalText: string`. Everything before it is probabilistic; everything after must earn its type. Candidates who cannot point to the line are treating "the model returns a Diagnosis" as if it were true.

### One-line anchors

- `lib/agents/base.ts` L102 — the one model call.
- `lib/agents/base.ts` L122 — text blocks → `finalText: string`, the trust boundary.
- `lib/mcp/validate.ts` L3–L13, L29–L35 — parse then prove shape.
- `lib/agents/diagnostic.ts` L74–L75 — the three-tier chain.
- `lib/agents/diagnostic.ts` L16–L20 — `FALLBACK`, the model-independent floor.

---

## Validate

### Level 1 — Reconstruct

From memory, draw the path from `anthropic.messages.create` to a typed `Diagnosis`. Name the intermediate type of the model's output (`string`), the two steps that earn the type (parse, validate), and the value returned when both fail.

### Level 2 — Explain

Out loud: why is `finalText` typed `string` and not `Diagnosis`, even though the prompt asked for a diagnosis? Why does `monitoring.ts` declare `parsed: unknown` (L112) before validating?

### Level 3 — Apply

Scenario: a new "summary" agent is added that should return `{ headline: string; bullets: string[] }`. Using `lib/agents/diagnostic.ts` L22–L29 and L74–L75 as the template, describe the parse function, the type guard you would add to `lib/mcp/validate.ts`, and the `FALLBACK` literal — and explain why the `FALLBACK` must not call the model.

### Level 4 — Defend

A colleague says: "Anthropic supports tool-use JSON mode now; rip out `parseAgentJson` and let the SDK guarantee valid JSON." State what that buys (token-level validity), what it costs (vendor coupling against the testability seam in → 08-provider-abstraction.md), and the measured condition under which you would actually do it.

### Quick check — code reference test

What is the exact return type of `runAgentLoop`, and which field of it is the untrusted model output? (Answer: `AgentRunResult = { finalText: string; toolCalls: ToolCall[] }` — `lib/agents/base.ts` L24–L27; `finalText` is the untrusted string.)

## See also

→ 02-tokenization.md · → 04-structured-outputs.md · → 07-heuristic-before-llm.md · → 08-provider-abstraction.md

---
Updated: 2026-05-28 — Re-derived the drifted `diagnostic.ts`/`monitoring.ts` line refs (chain L74–L75, `tryParseDiagnosis` L22–L29, `FALLBACK` L16–L20, monitoring degradation L95–L101) and noted the post-derived `diag.confidence`; `base.ts`/`runAgentLoop` refs verified unchanged.
Updated: 2026-05-29 — Monitoring degradation path moved: `parseAgentJson` + degrade guard now L113–L118 (was L95–L101), `parsed: unknown` declaration now L112 (was L85).
Updated: 2026-05-30 — Migrated to study.md v1.47 template (Phase 1+2 mechanical): removed Tradeoffs / Tech reference / Summary sections; renamed "In this codebase" → "Implementation in codebase"; moved See also to a bottom block. "Why care" preserved pending Phase 3 (Zoom out, then zoom in + LAYERS diagram) authoring.
Updated: 2026-05-30 — Phase 3 of study.md v1.47 migration: replaced "Why care" block with "Zoom out, then zoom in" (LAYERS diagram + zoom-in paragraph) per format.md.
Updated: 2026-05-31 — Applied study.md v1.48: scrubbed "How it works" of file paths, line refs, and real-code fences; replaced with generic role labels + pseudocode per format.md. Codebase-specific anchoring lives exclusively in "Implementation in codebase".
Updated: 2026-05-31 — Applied study.md v1.50: added Structure pass block (layers · axis · seams) between Zoom out and How it works per format.md's new Block 3.
