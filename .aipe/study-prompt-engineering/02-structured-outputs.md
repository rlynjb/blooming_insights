# Structured outputs (prompt-instructed JSON, and surviving it)

**Industry name(s):** structured outputs, JSON-from-prompt, fenced-JSON extraction, schema-in-prose, output contracts
**Type:** Industry standard · Language-agnostic

> blooming insights does the thing every blog tells you not to — it instructs the model to "Return ONLY a JSON array … wrapped in a ```json fenced block" in plain prose — and survives it because `parseAgentJson` strips the fence first, three type guards prove the shape, and `synthesize()` retries on clean context. The fence-regex-first ordering is not arbitrary: it is a direct fix for courteous models wrapping JSON in markdown.


---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Structured outputs span the `## Output` section of three prompts (Per-agent definitions band) and the validator in `lib/mcp/validate.ts` that handles the model's final text. The prompt sits inside the agent class; the contract sits at the boundary between the agent's `finalText` and whatever consumes it next — `parseAgentJson` + a type guard + a `synthesize()` repair path. The producer-consumer split is what this concept is about: one half in the prompt, one half in the code that reads the response.

```
  Zoom out — where structured outputs live

  ┌─ Per-agent definitions ─────────────────────────┐
  │  ★ ## Output: "ONLY JSON, fenced" ★              │  ← we are here (request)
  │  monitoring.md L69 · diagnostic.md L59 · rec L47 │
  └─────────────────────────┬────────────────────────┘
                            │  agent loop runs
  ┌─ Shared agent loop ─────▼────────────────────────┐
  │  runAgentLoop → finalText (untrusted string)     │
  └─────────────────────────┬────────────────────────┘
                            │  hand-off to validator
  ┌─ Output contract ───────▼────────────────────────┐  ← we are also here (guarantee)
  │  ★ parseAgentJson + isDiagnosis/isAnomalyArray ★ │
  │  lib/mcp/validate.ts L3–53                        │
  │  + synthesize() repair  diagnostic.ts L82–121    │
  └─────────────────────────┬────────────────────────┘
                            │ typed value or floor
  ┌─ Pipeline coordinator ──▼────────────────────────┐
  │  next agent / UI consumes the typed shape         │
  └──────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question is: when the model returns "Here's the analysis:\n```json\n[…]\n```\nHope this helps!" — how do you turn that into a typed value you can trust? The answer is a three-stage funnel — extract, validate, repair — where the prompt asks for the shape (statistical) and your own code guarantees it (enforced). Below, you'll see why the fence regex runs before the bare `JSON.parse`, why the guards skip the `id` field on the recommendation shape, and why `synthesize()` runs on clean context instead of one more loop turn.

---

## Structure pass

**Layers.** Structured outputs run as a four-layer producer→consumer pipeline and each layer has a different idea of what "the output" is. Layer A is the *prompt's `## Output` section* — the asked-for JSON shape, written in English with a fenced example. Layer B is the *model's final text* — an untrusted string that *might* be that JSON, *might* be that JSON wrapped in chatty markdown, *might* be a refusal. Layer C is the *extract+validate funnel* — `parseAgentJson` then a `v is T` guard, with a repair path (`synthesize()`) for the failure branch. Layer D is the *typed value the consumer ships* — the thing the next agent or the UI actually holds.

**Axis: guarantees.** What is *promised* at each layer, and what is *enforced*? This is the right axis because the trap this whole concept defends against is conflating "I asked for JSON" (a request) with "I got JSON" (a guarantee). Control is too narrow here (the model controls Layer B no matter what); the interesting question is what each layer commits to. A asks; B promises nothing; C either guarantees a typed value or routes to a floor; D is guaranteed-typed by construction. If you can't say what each layer guarantees, you can't tell where to put the validator.

**Seams.** Two seams, one load-bearing. Seam 1 (A↔B) is the seam blog folklore obsesses over — the guarantee flips from *statistical* ("the model usually emits JSON because I asked nicely") to *whatever-came-back* ("here's a string, good luck"). That seam is where the format request lives, but it's not where safety lives. The load-bearing seam is Seam 2 (B↔C): the guarantee flips from *no-shape-promised* to *typed-or-floored*. This is where `parseAgentJson` runs the fence-regex-first (because the model honored the prompt's request and wrapped its JSON in markdown — exactly what blog folklore warned would happen), where the type guard either returns a `Diagnosis` or null, where `synthesize()` retries on clean context, and where the floor (`[]` for monitoring, `FALLBACK` for diagnostic) makes the function total. Get this seam right and "the model returned garbage" stops being a 500 — it becomes an empty list.

```
  Structure pass — structured outputs

  ┌─ 1. LAYERS ───────────────────────────────────┐
  │  A: prompt ## Output (asked-for fenced JSON)   │
  │  B: model finalText (untrusted string)          │
  │  C: extract + validate + repair funnel          │
  │  D: typed value the consumer ships              │
  └────────────────────────┬───────────────────────┘
                           │  pick the axis
  ┌─ 2. AXIS ─────────────▼────────────────────────┐
  │  guarantees: what does each layer promise vs   │
  │  enforce?                                       │
  └────────────────────────┬───────────────────────┘
                           │  trace A→D, find flips
  ┌─ 3. SEAMS ────────────▼────────────────────────┐
  │  S1 (A↔B): statistical request → no-promise    │
  │            string                               │
  │  S2 (B↔C): no-promise → typed-or-floored        │
  │            (LOAD-BEARING — where shape becomes  │
  │             a guarantee)                        │
  └────────────────────────┬───────────────────────┘
                           ▼
                   Block 4 — How it works
```

```
  A seam — "is the shape guaranteed?" answered two ways

  ┌─ Layer B ────────┐    seam     ┌─ Layer C ────────────┐
  │  finalText:      │ ═════╪═════► │  parseAgentJson +    │
  │  string, no      │  (it flips) │  type guard → typed  │
  │  shape promise   │             │  value OR floor      │
  └──────────────────┘             └──────────────────────┘
         ▲                                   ▲
         └────── same axis, two answers ─────┘
                 → this boundary turns a request into a guarantee
```

The skeleton is mapped — the rest of this file walks the mechanics that hang off it.

## How it works

**Mental model.** The model's final text is an untrusted body you must defensively turn into a typed value through a three-stage funnel: *extract* the JSON out of whatever prose surrounds it, *validate* its shape field-by-field, *repair* via a clean-context retry when extract-or-validate fails. The prompt's job is to *ask* for the shape; the funnel's job is to *guarantee* it.

```
final_text: "Here's the anomalies:\n```json\n[ … ]\n```\nLet me know!"
      │
  (1) EXTRACT    parse-agent-json
      │  fence regex FIRST → bare JSON parse → first-bracket-to-last scan
      ▼
  parsed: unknown
      │
  (2) VALIDATE   is-anomaly-array / is-diagnosis / is-recommendation-array
      │  every required field present & correct type?
      ▼
  typed value ✓     ─── or ───▶  null / []
                                   │
  (3) REPAIR     synthesize  (clean-context retry)
                                   │  ?? FALLBACK / []
                                   ▼
                              always a valid typed value
```

The model tries to emit JSON; the funnel guarantees a typed result regardless of how well it tried.

---

### The choice the codebase made: instruct JSON in prose

Open any of the three structured prompts and you'll see the format demanded in English, with a concrete example block:

```
monitoring prompt — Output section
  ## Output
  Return ONLY a JSON array of anomaly objects, at most 10 items, sorted by
  severity …, wrapped in a ```json fenced block. Each item:
  [ { "metric": …, "change": { "value": …, "direction": …, "baseline": … }, … } ]
  Field rules:
  - metric — short snake_case name …
  - severity — "critical" (>20% …), "warning" (10–20% …), …
```

```
diagnostic prompt      ## Output → a ```json {object} of exactly this shape + field rules
recommendation prompt  ## Output → a ```json [array] of at most 3 objects + field rules
```

This is the pattern blog folklore warns against: "don't describe JSON in words, the model will drift; use the provider's native mode." And the folklore is not wrong about the *failure modes* — prose-instructed JSON does drift, does get wrapped in fences, does occasionally arrive with a chatty preamble. The disagreement is about whether those failure modes are *handled* or *fatal*. blooming insights treats them as handled.

---

### Schema-shaping in prose: telling the model what NOT to emit

The prompts don't just describe the shape — they sculpt it, including fields the model must *omit*:

```
recommendation prompt — Output section
  - Do NOT include an `id` field — the system assigns it after validation.
```

This is schema-shaping done in English. The model emits id-less recommendations; the type guard validates the id-less shape (an `Omit<Recommendation, 'id'>[]` predicate); the code assigns the id after validation with a UUID generator:

```
prompt says:           "Do NOT include an id"
model emits:           { title, rationale, bloomreach_feature, steps, … }  ← no id
shape guard:           validates THIS id-less shape
code assigns:          { id: random_uuid(), ...r }
```

The split is deliberate: the prompt and validator agree on what the *model* controls; the system owns *identity*. Letting the model invent ids risks collisions and non-UUID strings. The "Do NOT include an id" line is a prose instruction doing a job a native schema would do with `additionalProperties: false` — and it has to be repeated in the recommendation agent's synthesis instruction too, because the synthesis path bypasses the main prompt.

---

### The fence-strip-first bug, and why the regex runs first

Here is the production scar. The agent-JSON parser tries the markdown-fence regex *before* a bare JSON parse:

```
  parse_agent_json(text):
    fence     = text.match(/```(?:json)?\s*([\s\S]*?)```/i)   # ← FENCE FIRST
    candidate = (fence ? fence.group(1) : text).strip()
    try:
        return JSON.parse(candidate)
    except:
        pass   # fall through

    start = candidate.search(/[[{]/)                          # substring scan
    end   = max(candidate.last_index_of("]"),
                candidate.last_index_of("}"))
    if start >= 0 AND end > start:
        return JSON.parse(candidate.slice(start, end + 1))
    raise "no parseable json in agent output"
```

Why fence-first? Because the three structured prompts *ask* for a ```json fence in their Output sections — and the model complies. If you ran a bare JSON parse first, it would throw on the leading ```` ```json ```` and the trailing ```` ``` ````, and you'd be relying on the substring scan to recover — which is the *least* precise strategy. Fence-first means the common case (model did exactly what you asked) is also the most precise extraction.

```
the bug class this defends against:
  ─────────────────────────────────────────────────────────
  prompt:  "be concise" + "return JSON"
  model:   politely wraps the JSON in ```json … ``` as code
  naive:   JSON.parse("```json\n[…]\n```")  → SyntaxError → 500
  here:    fence regex captures group 1 → JSON.parse([…]) → ✓
```

I have shipped a feature where a teammate added "be concise and well-formatted" to a prompt that relied on schema mode, and overnight the model started fencing its JSON as a courtesy — well-formatted, to a model, means a code block. The parser that did bare-parse-first broke for every call. The fix was the exact ordering you see here: strip the fence before you trust the body. This is not theoretical; it is the literal reason the fence regex runs before the bare parse.

---

### Validate: shape proofs, not casts

The parser returns `unknown` — it has parsed *syntax*, not *shape*. Three `v is T` guards prove the shape field-by-field:

```
is-anomaly-array         walks every item: metric:string, scope[],
                         change.value:number, change.direction ∈ {up,down},
                         change.baseline:string, severity ∈ SEVERITIES
is-diagnosis             conclusion:string, evidence[], hypothesesConsidered[]
is-recommendation-array  every item: title, rationale,
                         bloomreachFeature ∈ FEATURES, steps[],
                         estimatedImpact, confidence ∈ CONFIDENCE  (id NOT checked)
```

A guard returning `false` is not an error — it routes to the repair or the floor. The monitoring agent does the simplest thing: `if not is_anomaly_array(parsed): return []`. The guard is the gate that decides whether the model's output is trustworthy enough to ship.

---

### Repair: the clean-context synthesize retry

When the loop's final text doesn't parse-and-validate, the diagnostic and recommendation agents don't give up — they re-prompt on clean context:

```
  return try_parse_diagnosis(final_text)
         ?? await synthesize(anomaly, tool_calls)
         ?? FALLBACK
```

The synthesize path is a *separate* call to the provider SDK with **no tools and no loop history** — it formats the gathered evidence as text and asks for ONLY the JSON. Why a fresh call instead of one more loop turn: the loop history is full of `tool_use`/`tool_result` pairs and the model has momentum toward "I should query more." A clean single-turn call breaks that momentum. The recommendation agent has the identical structure. The monitoring agent has no synthesize path — it degrades straight to `[]`, because an empty anomaly list is a safe, honest answer; a missing diagnosis is not.

---

### The principle

Prompt-instructed JSON is a defensible production choice when — and only when — you pair it with extract + validate + repair in your own code. The prompt makes the *request*; the parser + the guards + the synthesize retry make the *guarantee*. The cost is real (you own the parser, you pay for repair retries, you get shape-not-correctness), and the benefit is real (portable across any text model, fully unit-testable with fakes, no provider coupling on the output side). The fence-first ordering is the one detail that earns its place by experience, not by theory.

---

## Structured outputs — diagram

This diagram spans the producer and the contract. The model emits prose-with-fenced-JSON because the prompt asked for it; the funnel extracts, validates, and repairs into a typed value with a guaranteed floor. A reader who sees only this should grasp that the prompt requests the shape and the code guarantees it.

```
┌──────────────────────────────────────────────────────────────────────┐
│  PRODUCER — the prompt requests JSON in PROSE                         │
│   monitoring · diagnostic · recommendation prompts (## Output)        │
│   "Return ONLY a JSON … wrapped in a ```json fenced block"           │
│   recommendation: "Do NOT include an id" (schema-shaping)             │
│           │                                                           │
│           ▼  final_text = "Here's …:\n```json\n[…]\n```\nLet me know" │
└───────────────────────────┬───────────────────────────────────────────┘
                            │  untrusted string
┌───────────────────────────▼───────────────────────────────────────────┐
│  CONTRACT — extract + validate + repair  (validator module)           │
│                                                                       │
│  (1) EXTRACT  parse-agent-json                                        │
│       FENCE REGEX FIRST → bare parse → first-[/{-to-last-]/}-scan     │
│       (fence-first = fix for courteous markdown-wrapping)             │
│           │ unknown                                                   │
│  (2) VALIDATE is-anomaly-array / is-diagnosis / is-recommendation-array │
│       field-by-field; id intentionally NOT validated                  │
│           │ valid              │ false / threw                        │
│           ▼                    ▼                                      │
│      typed value         (3) REPAIR  synthesize  (diagnostic, rec)    │
│                              fresh create, NO tools, NO history       │
│                                   │ valid        │ null               │
│                                   ▼              ▼                    │
│                              typed value   FALLBACK / []              │
│                                                                       │
│  monitoring: NO synthesize → parse?validate? else []                  │
└────────────────────────────────────────────────────────────────────────┘

  prompt = the REQUEST (statistical).  contract = the GUARANTEE (enforced).
```

The fence is asked for in prose, stripped first in code; the typed value is manufactured by extract → validate → repair, with a model-independent floor.

---

## Implementation in codebase

**Case A — implemented.**

### The prompt-side JSON instruction

- **File:** `lib/agents/prompts/{monitoring,diagnostic,recommendation}.md`
- **Function / class:** the `## Output` section of each prompt
- **Line range:** `monitoring.md` L69–97 (array, fenced, severity-sorted, field rules); `diagnostic.md` L59–103 (object of exact shape + the empty-case shape L94–101); `recommendation.md` L47–91 (≤3 objects + field rules, including the id-omission at L82).
- **Role:** requests fenced JSON in prose and sculpts the shape (including which fields to omit).

### Extract

- **File:** `lib/mcp/validate.ts`
- **Function / class:** `parseAgentJson(text)`
- **Line range:** L3–13 — fence regex (L4) first, bare `JSON.parse` (L6), first-bracket-to-last-bracket substring scan (L7–10), throw (L12).
- **Role:** pulls the JSON out of fenced/bare/prose-wrapped output; fence-first by design.

### Validate

- **File:** `lib/mcp/validate.ts`
- **Function / class:** `isAnomalyArray`, `isDiagnosis`, `isRecommendationArray`
- **Line range:** L17–27, L29–35, L42–53; enum sets `SEVERITIES` (L15), `FEATURES`/`CONFIDENCE` (L37–38). The recommendation guard validates `Omit<Recommendation,'id'>[]` (L42).
- **Role:** proves shape field-by-field; the recommendation guard skips `id` because the system assigns it.

### Repair + floor

- **File:** `lib/agents/{diagnostic,recommendation,monitoring}.ts`
- **Function / class:** `synthesize()` and the fallback chain
- **Line range:** diagnostic `tryParseDiagnosis ?? synthesize ?? FALLBACK` (L73–77), `synthesize` (L82–121), `FALLBACK` (L15–19); recommendation `tryParseRecommendations ?? synthesize` then `[]`, ids assigned (L69–76), `synthesize` (L82–127); monitoring parse-or-`[]` (L85–92, no synthesize).
- **Role:** clean-context retry then a model-independent floor; monitoring's floor is `[]` directly.

### Why this is a codebase strength

The output contract works against any text model and is fully exercisable in the test suite with injected fakes — no live structured-output API needed. The id-assignment-after-validation detail shows the boundary was thought through precisely. And the fence-first ordering encodes a real lesson rather than a guessed one.

---

## Elaborate

### Where this comes from

Extracting JSON from generated prose predates native JSON modes. LangChain's `OutputParser`s, the `instructor` library's validate-and-retry loop, and Pydantic-backed extraction all converged on the same shape — prompt for a format, parse leniently, validate against a schema, retry on failure. The ```json fence convention emerged because models trained on developer text reach for code fences when asked for code-shaped output, which makes the fence a high-signal extraction anchor — exactly what `parseAgentJson` exploits. Native structured outputs (OpenAI `response_format` / structured outputs, Anthropic tool-use JSON, constrained decoding via Outlines/SGLang) are the newer answer: constrain the *decoding* so invalid JSON is impossible.

### The deeper principle

```
request                               guarantee
─────────────────────────────────    ─────────────────────────────────
"return JSON in a ```json fence"      parse + validate + repair (code)
honored statistically                 honored always
breaks silently on prose/fence        surfaces as null → repair → floor
provider-agnostic                     provider-agnostic
```

The model's adherence to a format request is probabilistic; the contract's adherence to its return type is absolute. The funnel exists to move the guarantee from the model (statistical) into code (enforced).

### Where this breaks down

1. **The substring scan can mis-recover.** Stage (c) grabs first-bracket-to-last-bracket. Prose with stray brackets, or two JSON blocks, can yield a wrong-but-parseable object that then *passes* the guard. Pragmatic recovery, not a correctness guarantee.
2. **Shape is not correctness.** `isDiagnosis` proves `conclusion` is a string — not that it is true. A hallucinated diagnosis with the right shape passes the entire contract. Catching wrong-but-well-formed output is the job of evals (→ 03-prompts-as-code.md notes the missing observability), not validation.
3. **Repair doubles cost on the unlucky path.** When `tryParse` returns null, `synthesize()` is a second full call (`max_tokens: 2048`, `diagnostic.ts` L94). Free on the happy path, real money if the parse-failure rate climbs.
4. **Prose-instructed JSON drifts on model upgrades.** A new model can change how it formats by default (more prose, different fence style). Native mode is immune to that; prose-instruction must be re-checked when the model changes — and nothing in the code logs which model produced which output (→ 03-prompts-as-code.md).

### What to explore next

- **Native tool-use for the final artifact:** define `submit_diagnosis` as a tool the model must call to finish, so the SDK enforces valid arguments — eliminating extract+validate for the output at the cost of provider coupling. The codebase *already* uses native tool-use for the input side (every MCP call), so the runner-up is proven acceptable; it's held back on output deliberately.
- **Zod schemas:** one schema per shape, generating both the validator and the static type, with field-level error messages the hand-written guards lack.
- **Constrained decoding (Outlines, SGLang):** force valid JSON at the token level — the strongest form of the parse guarantee.

---

## Project exercises

### Promote the final artifact to native tool-use JSON

- **Exercise ID:** C1.7 (adapted) — structured outputs via the provider's contract.
- **What to build:** define the `Diagnosis` shape as a `submit_diagnosis` tool and require the diagnostic agent to terminate by calling it, so the SDK enforces valid arguments; keep `parseAgentJson` + `synthesize()` as the fallback for portability. Encode the id-omission as `additionalProperties: false` for the recommendation tool.
- **Why it earns its place:** demonstrates you know the difference between *requesting* JSON and *guaranteeing* it at decode level, and that the codebase already uses native tool-use for input but not output.
- **Files to touch:** `lib/agents/diagnostic.ts` (terminate via tool call), `lib/agents/base.ts` (surface tool input), `lib/mcp/validate.ts` (reuse `isDiagnosis` on the tool args), `test/agents/diagnostic.test.ts`.
- **Done when:** a normal run produces a `Diagnosis` from tool-call arguments (no `parseAgentJson`), and a forced tool-call failure still degrades through `synthesize() ?? FALLBACK`.
- **Estimated effort:** 1–2 days

### Add a fence-courtesy regression test

- **Exercise ID:** C1.7 (adapted) — pin the fence-first behavior.
- **What to build:** a Vitest case that feeds `parseAgentJson` a string where the JSON is wrapped in a ```json fence *with* a chatty preamble and trailer ("Here's the analysis:\n```json\n[…]\n```\nHope this helps!"), and asserts the array is extracted correctly — locking in the courteous-markdown defense so a future "simplification" of the parser can't silently break it.
- **Why it earns its place:** turns the production scar (the reason the fence regex runs first) into an executable invariant.
- **Files to touch:** `test/mcp/validate.test.ts` (extend `parseAgentJson` cases).
- **Done when:** the test passes against the current parser and fails if the fence regex is removed or reordered after the bare parse.
- **Estimated effort:** <1hr

---

## Interview defense

### What an interviewer is really asking

"How do you get structured output from an LLM?" tests whether you stop at "I prompt for JSON" or go to "I prompt, extract, validate, repair — and I know the cost of each." The senior signal is defending prompt-instructed JSON honestly: naming why the blogs warn against it, then showing the funnel that makes it safe, and knowing exactly where native mode would win.

### Likely questions

**[mid] "The model returns `Here's the result:\n```json\n[…]\n````. How do you get a typed array out?"**

`parseAgentJson` (`validate.ts` L3–13) runs the fence regex first, capturing the body inside ```json``` — the common case because the prompt asked for that fence. Then `isAnomalyArray` (L17–27) proves the shape. Both succeed → typed `Anomaly[]`; otherwise → `[]` (`monitoring.ts` L91).

```
prose + ```json fence → fence regex (L4) → JSON.parse → isAnomalyArray → Anomaly[] ✓
```

**[senior] "The internet says never instruct JSON in the prompt. You do. Defend it."**

The blogs are right about the failure modes — drift, fences, preambles — and wrong to call them fatal. We treat the output as an untrusted body: `parseAgentJson` extracts (fence-first), the guards validate field-by-field, `synthesize()` repairs on clean context, and there's a model-independent floor. That buys portability (any text model) and full testability with fakes. The cost is owning the parser and paying for repair retries. Native mode would remove the parse failure entirely but couple the output to one provider — we already accept native tool-use for input and hold it back on output deliberately.

```
blog warns:   drift / fence / preamble  → "use native mode"
we answer:    extract(fence-first) + validate + repair + floor
trade:        portability+testability  vs  token-level validity
```

**[arch] "Why does `parseAgentJson` try the fence regex before a bare `JSON.parse`?"**

Because the prompts ask for a ```json fence and the model complies, so the fence is the *common* case — and a bare parse would throw on the fence delimiters, dropping you to the least-precise substring scan. Fence-first means the happy path is also the most precise extraction. Concretely: a teammate once added "be concise and well-formatted" to a schema-mode prompt and the model started fencing its JSON as a courtesy overnight; the bare-parse-first parser broke for every call. Fence-first is the fix.

```
bare-first:  JSON.parse("```json…```") → SyntaxError → rely on fuzzy scan
fence-first: regex captures [...] → JSON.parse → precise ✓
```

### The question candidates always dodge

**"What does your validation actually guarantee?"** Shape, not truth. `isDiagnosis` proves `conclusion` is a string — not that the conclusion is correct. A hallucinated-but-well-shaped diagnosis passes the entire contract. Candidates dodge this because it concedes the contract doesn't catch wrong answers. The honest answer: shape is the validator's job; correctness is the evals' job, which this codebase does not yet have (→ 03-prompts-as-code.md).

### One-line anchors

- `lib/mcp/validate.ts` L3–13 — `parseAgentJson`: fence regex FIRST, then bare parse, then substring scan.
- `lib/mcp/validate.ts` L17–53 — the three guards; recommendation validates the id-less shape.
- `lib/agents/prompts/recommendation.md` L82 — "Do NOT include an id" — schema-shaping in prose.
- `lib/agents/diagnostic.ts` L82–121 — `synthesize()`: clean-context, tool-less repair.
- `lib/agents/monitoring.ts` L88–91 — parse-or-`[]`, no synthesize (empty list is a safe answer).

---

## Validate

### Level 1 — Reconstruct

From memory, draw the three-stage funnel (extract → validate → repair) and name the function at each stage. State the order of `parseAgentJson`'s three extraction strategies and which one matches what the prompt asked for.

### Level 2 — Explain

Out loud: why does `isRecommendationArray` validate a shape *without* `id` (`validate.ts` L42), where does the `id` come from (`recommendation.ts` L76), and why is the "Do NOT include an id" instruction repeated in the synthesis text (`recommendation.ts` L62)?

### Level 3 — Apply

Scenario: you add a new agent that must return `{ summary: string; tags: string[] }`. Using `validate.ts` L29–35 as the template, write the `isSummary` guard; decide which `parseAgentJson` strategy hits for fence-wrapped output; and decide whether this agent needs a `synthesize()` repair or can floor to a default like monitoring does — justify the choice with what a safe default would be.

### Level 4 — Defend

A reviewer says: "Switch the final diagnosis to Anthropic tool-use JSON mode and delete `parseAgentJson`." State what that buys (token-level validity), what it costs (provider coupling, harder fakes-in-tests, re-encoding `recommendation.md` L82 as a schema constraint), why the codebase already accepts native tool-use for *input* but not output, and the measured condition under which you'd flip the output side.

### Quick check — code reference test

In `parseAgentJson`, what are the three extraction strategies in order, and what happens if all three fail? (Answer: (1) fenced-code regex `/```(?:json)?\s*([\s\S]*?)```/i`, (2) bare `JSON.parse`, (3) first-bracket-to-last-bracket substring scan; if none yields valid JSON it throws `'no parseable json in agent output'` — `lib/mcp/validate.ts` L3–13.)

## See also

→ 01-anatomy.md · → 03-prompts-as-code.md · → 07-output-mode-mismatch.md · → 09-chain-of-thought.md

---
Updated: 2026-05-29 — Corrected the `## Output` section ranges (monitoring L69–97, diagnostic L59–103, recommendation L47–91) and the dependent in-section refs (fence asks → monitoring L71 / diagnostic L61 / recommendation L49; "Do NOT include an id" → recommendation L82; diagnostic empty-case shape L94–101). No placeholder injection table exists in this file (it lives in 01-anatomy.md), so `{categories}` was added there instead.
Updated: 2026-05-30 — Migrated to study.md v1.47 template (Phase 1+2 mechanical): removed Tradeoffs / Tech reference / Summary sections; renamed "In this codebase" → "Implementation in codebase"; moved See also to a bottom block. "Why care" preserved pending Phase 3 (Zoom out, then zoom in + LAYERS diagram) authoring.
Updated: 2026-05-30 — Phase 3 of study.md v1.47 migration: replaced "Why care" block with "Zoom out, then zoom in" (LAYERS diagram + zoom-in paragraph) per format.md.
Updated: 2026-05-31 — Applied study.md v1.48: scrubbed "How it works" of file paths, line refs, and real-code fences; replaced with generic role labels + pseudocode per format.md. Codebase-specific anchoring lives exclusively in "Implementation in codebase".
Updated: 2026-05-31 — Applied study.md v1.50: added Structure pass block (layers · axis · seams) between Zoom out and How it works per format.md's new Block 3.
