# What an LLM is (a next-token function you never trust raw)

**Industry name(s):** large language model, autoregressive next-token predictor, foundation model
**Type:** Industry standard · Language-agnostic

> blooming insights treats Claude as one thing — a function that maps a prompt to a string of tokens — and never trusts that string: every agent output is parsed through `parseAgentJson`, validated by a type guard, and degraded to a hard-coded `FALLBACK` if it does not conform.

**See also:** → 02-tokenization.md · → 04-structured-outputs.md · → 07-heuristic-before-llm.md · → 08-provider-abstraction.md

---

## Why care

You call `JSON.parse(await res.text())` on a response from a backend you do not control. You wrap it in `try/catch` because the backend can return a 500 HTML page, a truncated body, or a perfectly-shaped object — and your code has to survive all three without crashing the render. You do not assume the bytes are valid; you assume they are bytes, and you prove they are valid before you trust them.

The question an LLM forces on you is the same: when the thing on the other end of the call is a probabilistic text generator, what is the type of its output, and what must you do before you let that output into your typed program?

**The answer that determines whether your system is reliable: an LLM call returns a `string`, not a `Diagnosis`.** The model emits one token at a time, each sampled from a probability distribution conditioned on everything before it. Nothing in that mechanism guarantees the result parses as JSON, matches your schema, or is even non-empty. If you write code that assumes `anthropic.messages.create(...)` returns structured data, that code is wrong; it works in the demo and breaks in production the first time the model wraps its JSON in a sentence of prose.

Before treating the model as a function with an untyped return:
- Code path assumes `finalText` is valid JSON and accesses `diagnosis.conclusion` directly
- A prose preamble ("Here is the diagnosis:") makes `JSON.parse` throw
- The whole investigation 500s on output the model considered perfectly reasonable

After:
- `finalText` is treated as an opaque `string`
- `parseAgentJson` extracts the JSON, a type guard proves the shape, and a `FALLBACK` covers total failure
- The investigation always returns a valid `Diagnosis` object, even when the model produced garbage

It is the same discipline as never trusting `JSON.parse` on a network response — applied to a backend whose "API contract" is a prompt and whose adherence to it is statistical.

---

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

Everything left of the trust boundary is probabilistic. Everything right of it is your typed program. blooming insights draws that boundary explicitly and treats it as the single most important contract in the system.

---

### The call site: a string in, a string out

`runAgentLoop` (`lib/agents/base.ts`) is the only place Claude is invoked inside the agent system. The call itself is at `lib/agents/base.ts` L102:

```typescript
const res = await anthropic.messages.create(params);
```

`res.content` is an array of content blocks. The loop extracts the text blocks and joins them (L108–L113, L122):

```
res.content ──▶ filter(b => b.type === 'text') ──▶ map(b => b.text).join('')
                                                          │
                                                          ▼
                                                    finalText: string
```

That is the entirety of what the model "returns" to the rest of the system: a joined `string`. There is no schema attached, no type, no guarantee. The model could have returned a JSON object, a markdown-fenced object, an apology, or an empty string. The next stage's job is to find out which.

---

### The trust boundary: parse, validate, fall back

The diagnostic agent shows the full discipline. After the loop returns `finalText`, `DiagnosticAgent.investigate` (`lib/agents/diagnostic.ts` L74–L75) runs a three-tier chain:

```typescript
const diag =                                     // L74
  tryParseDiagnosis(finalText)                   //      parse + validate
  ?? (await this.synthesize(anomaly, toolCalls)) //      retry, clean context
  ?? FALLBACK;                                    // L75  hard-coded safe value
```

(`investigate` then post-derives `diag.confidence` via `diagnosisConfidence` at L80–L82 — see → 04-structured-outputs.md.) `tryParseDiagnosis` (`lib/agents/diagnostic.ts` L22–L29) does the two things you do to any untrusted payload: it parses (`parseAgentJson`, `lib/mcp/validate.ts` L3–L13) and it validates the shape (`isDiagnosis`, `lib/mcp/validate.ts` L29–L35). If either step fails, it returns `null` — it never lets a malformed object through.

```
finalText (untrusted string)
      │
      ▼
parseAgentJson ── throws? ──▶ catch → null
      │ object
      ▼
isDiagnosis ──── false? ───▶ null
      │ true
      ▼
typed Diagnosis ✓
```

The `FALLBACK` (`lib/agents/diagnostic.ts` L16–L20) is the floor:

```typescript
const FALLBACK: Diagnosis = {
  conclusion: 'Insufficient data to determine a cause for this change.',
  evidence: [],
  hypothesesConsidered: [],
};
```

This object is a literal, written by hand, with no model involvement. It exists so that `investigate` always returns a valid `Diagnosis` — the function's return type is honest even when the model produced nothing usable. The route can emit a `diagnosis` event unconditionally; the recommendation step always receives a well-typed object to build on.

---

### Why the boundary is non-negotiable

The monitoring agent makes the same point in its degradation path (`lib/agents/monitoring.ts` L113–L118):

```typescript
let parsed: unknown;
try {
  parsed = parseAgentJson(finalText);
} catch {
  return [];
}
if (!isAnomalyArray(parsed)) return [];
```

Note `parsed: unknown` — the strongest possible statement that the model's output has no type until proven. The `catch` and the `isAnomalyArray` guard are the two gates. Anything that fails either gate becomes `[]` (no anomalies) rather than a thrown error that kills the briefing.

```
model output  →  unknown  →  [parse]  →  [validate]  →  typed
                              │ fail       │ fail
                              ▼            ▼
                             []           []     (graceful, never throws)
```

---

### The principle

An LLM call is an I/O boundary with an untyped, adversarial-by-default return value — closer to `fetch` against a flaky third party than to a local function call. You earn the type on the way in: parse, validate, fall back. blooming insights never lets a model string cross into its typed domain without that earning step, which is why a bad generation degrades a single investigation gracefully instead of crashing the system.

---

## What an LLM is — diagram

This diagram spans the full path from prompt to typed value. The Provider layer is probabilistic; the Service layer is where the string is forced into a type or replaced by a safe default. A reader who sees only this should grasp that the model returns a string and the type is manufactured downstream.

```
┌──────────────────────────────────────────────────────────────────────┐
│  PROVIDER LAYER (Anthropic — probabilistic)                          │
│                                                                       │
│  anthropic.messages.create(params)        lib/agents/base.ts L102    │
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
│  │ parseAgentJson  L3–L13             │  fence → bare → substring   │
│  └──┬─────────────────────────────────┘                             │
│     │ object | throw                                                 │
│  ┌──▼─────────────────────────────────┐  lib/mcp/validate.ts        │
│  │ isDiagnosis / isAnomalyArray  L17+  │  shape proof                │
│  └──┬─────────────────────────────────┘                             │
│     │ valid           │ invalid / threw                             │
│     ▼                 ▼                                              │
│  typed Diagnosis   synthesize() ?? FALLBACK   diagnostic.ts L74–L75 │
└────────────────────────────────────────────────────────────────────────┘
```

The model never hands the system a `Diagnosis`. It hands the system a string, and the Service layer either proves that string is a `Diagnosis` or substitutes a hand-written one.

---

## In this codebase

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

## Tradeoffs

### Parse-and-validate prose vs. trusting the model vs. native JSON mode

| Dimension | This codebase (parse + validate + fallback) | Trust raw output | Native constrained JSON mode |
|---|---|---|---|
| Reliability on malformed output | High — three tiers, never throws | None — first bad output 500s | High — malformed is impossible by construction |
| Vendor lock-in | None — works on any text model | None | High — feature varies per provider |
| Code complexity | Moderate — parser + guards + fallback | Minimal | Low — SDK enforces |
| Correctness guarantee | Shape only | None | Shape only |
| Cost of a bad generation | One graceful fallback | One crashed request | N/A (cannot occur) |

**What we gave up.** A token-level guarantee that the output is valid JSON. Native constrained decoding makes `parseAgentJson` redundant for the parse step. By extracting from prose instead, blooming insights accepts that some fraction of calls produce output that fails the parse and must be retried via `synthesize()` or dropped to `FALLBACK` — extra latency and tokens on the unlucky calls.

**What the alternative would have cost.** Native JSON modes are per-provider features with different shapes and limits; adopting one couples the agent layer to a specific vendor's API surface. The prose-extraction approach is provider-agnostic — it works against any model that returns text — which matters given the testability seam the codebase already invests in (see → 08-provider-abstraction.md).

**The breakpoint.** Parse-and-validate is the right call while the malformed-output rate stays low enough that `synthesize()` retries are rare. When a measured parse-failure rate climbs past a few percent of calls, the extra latency and token cost of the second-tier retry start to matter, and moving the *final* structured artifact onto native tool-use JSON mode becomes worth the vendor coupling.

---

## Tech reference (industry pairing)

### @anthropic-ai/sdk (claude-sonnet-4-6)

- **Codebase uses:** `anthropic.messages.create(params)` at `lib/agents/base.ts` L102 as the sole model call; `AGENT_MODEL = 'claude-sonnet-4-6'` at L9.
- **Why it's here:** the Messages API is the next-token function the whole agent system is built on; `res.content` text blocks are the untyped return value the Service layer validates.
- **Leading today:** OpenAI's GPT-4-class models lead in raw adoption (2026); Anthropic's Claude leads in agentic tool-use reliability and is the innovation leader for long-horizon agent workloads.
- **Why it leads:** strong instruction-following on JSON-shaped tasks and a mature tool-use loop make it well-suited to the "emit a structured artifact from gathered evidence" pattern this codebase runs.
- **Runner-up:** OpenAI's Chat Completions / Responses API — equivalent next-token interface, broader ecosystem, different tool-use ergonomics.

### Type guards (TypeScript `v is T` predicates)

- **Codebase uses:** `isDiagnosis`, `isAnomalyArray`, `isRecommendationArray` in `lib/mcp/validate.ts` to prove the shape of `parseAgentJson` output before it crosses into typed code.
- **Why it's here:** TypeScript types are erased at runtime, so a runtime predicate is the only way to make `unknown` (the model output) into a `Diagnosis` safely.
- **Leading today:** Zod is the adoption leader for runtime schema validation in TypeScript (2026); it generates both the validator and the static type from one schema.
- **Why it leads:** a single source of truth for shape, with rich error messages and composability the hand-written guards here lack.
- **Runner-up:** Valibot (smaller bundle, same idea) and io-ts (functional, older).

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

## Summary

An LLM is a function that maps a token sequence to a sampled token, looped until a stop condition; its return value is a `string`, never a typed object. blooming insights internalizes this completely: `anthropic.messages.create` (`lib/agents/base.ts` L102) yields text blocks that are joined into `finalText`, and that string is treated as `unknown` until `parseAgentJson` parses it and a type guard proves its shape. When proof fails, the system degrades — `synthesize()` retries, and a hand-written `FALLBACK` guarantees `investigate` always returns a valid `Diagnosis`. The trust boundary between probabilistic provider and typed service is the system's central contract.

**Key points:**
- An LLM call returns a `string`, not your domain type — the type is manufactured downstream by parse + validate.
- `parseAgentJson` + a `v is T` type guard is the parse-and-validate boundary every model output crosses (`lib/mcp/validate.ts`).
- `FALLBACK` is model-independent by design so the bottom tier of the chain can never itself fail (`lib/agents/diagnostic.ts` L16–L20).
- Validation proves shape, not correctness — a hallucinated diagnosis passes every guard.
- Treating the model like a flaky third-party `fetch` is what makes a bad generation degrade one investigation instead of crashing the system.

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

---
Updated: 2026-05-28 — Re-derived the drifted `diagnostic.ts`/`monitoring.ts` line refs (chain L74–L75, `tryParseDiagnosis` L22–L29, `FALLBACK` L16–L20, monitoring degradation L95–L101) and noted the post-derived `diag.confidence`; `base.ts`/`runAgentLoop` refs verified unchanged.
Updated: 2026-05-29 — Monitoring degradation path moved: `parseAgentJson` + degrade guard now L113–L118 (was L95–L101), `parsed: unknown` declaration now L112 (was L85).
