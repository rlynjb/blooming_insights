# Structured outputs (extracting a typed contract from prose)

**Industry name(s):** structured output extraction, JSON-from-prose parsing, schema validation / output contracts
**Type:** Industry standard · Language-agnostic

> The model is asked to emit JSON in a markdown fence; `parseAgentJson` extracts it through three escalating strategies, a `v is T` type guard proves the shape, and a dedicated tool-less `synthesize()` call is the clean-context retry — together a contract that turns a prose string into a validated `Diagnosis`, `Anomaly[]`, or `Recommendation[]`.


---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Structured outputs span two layers: the Per-agent definitions ask for JSON (via `synthesisInstruction` appended in `lib/agents/base.ts` L96–L98), and the trust boundary lives one layer up where each agent runs `parseAgentJson` → type guard → `synthesize()` → `FALLBACK`. The model itself sits in the Provider band and emits prose-with-JSON; the contract that turns that prose into a typed `Diagnosis` / `Anomaly[]` / `Recommendation[]` lives in `lib/mcp/validate.ts` and the per-agent fallback chains.

```
  Zoom out — where the output contract lives

  ┌─ Per-agent (asks for JSON, parses, repairs) ─────┐  ← we are here
  │  synthesisInstruction       base.ts L96–98       │
  │  tryParseDiagnosis ?? synthesize ?? FALLBACK     │
  │    diagnostic.ts L74–75                          │
  │  ★ parseAgentJson + type guards ★  validate.ts   │
  └─────────────────────────┬────────────────────────┘
                            │  call
  ┌─ Provider ──────────────▼────────────────────────┐
  │  anthropic.messages.create  (text out)           │
  │  finalText = "...```json {...}```..."            │
  └─────────────────────────┬────────────────────────┘
                            │  (input side uses native tool-use; output does NOT)
  ┌─ Tools (input side, contrast) ──────────────────┐
  │  toolSchemas: native tool-use enforced by SDK   │
  └─────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question is: how do you guarantee a typed value when the model's "API" is a probabilistic text generator that wraps JSON in prose? The contract is three jobs — extract the JSON (`parseAgentJson`), validate the shape (`isDiagnosis` etc.), repair on failure (`synthesize()` in clean context, then a hand-written `FALLBACK`). How it works walks each stage and the deliberate split between native tool-use for input and parse-from-prose for output.

---

## Structure pass

**Layers.** Four layers from prompt to typed value: the per-agent prompt that asks for JSON (the `synthesisInstruction` plus the agent's system prompt), the provider call that returns `finalText: string` (possibly prose-with-fenced-JSON), the parse step (`parseAgentJson` with its three escalating strategies), and the validate step (`v is T` type guard) — followed by the repair tier (`synthesize()` clean-context retry) and the floor (`FALLBACK`).

**Axis: trust.** What can the layer above trust about the bytes coming from the layer below? This axis is the right lens because the entire contract exists to convert "untrusted prose" into "typed value or hand-written floor" — each layer earns a stronger guarantee than the one below. Control would flatten things (the model always decides the prose; the parser always decides the typed value); cost is downstream; trust is what makes each tier's job distinct.

**Seams.** Three seams in a row, each upgrading the guarantee. Prompt → provider is cosmetic (a string goes out, a string comes back). The load-bearing seam is provider → parse + validate: trust flips from "probabilistic prose" to "either a typed value or `null`." A second load-bearing seam is parse/validate → repair-or-fallback: trust flips from "best effort" to "always a valid typed value, by construction." The contract is the *composition* of these flips.

```
  Structure pass — structured outputs

  ┌─ 1. LAYERS ───────────────────────────────────┐
  │  per-agent prompt (asks for JSON)              │
  │  provider call (finalText: string)             │
  │  parse + validate (extract + shape-prove)      │
  │  repair (synthesize) + floor (FALLBACK)        │
  └────────────────────────┬───────────────────────┘
                           │  pick the axis
  ┌─ 2. AXIS ─────────────▼────────────────────────┐
  │  trust: what can each layer trust about the    │
  │  bytes from below?                             │
  └────────────────────────┬───────────────────────┘
                           │  trace across layers, find flips
  ┌─ 3. SEAMS ────────────▼────────────────────────┐
  │  prompt↔provider: cosmetic                     │
  │  provider↔parse+validate: LOAD-BEARING         │
  │    prose → typed or null                       │
  │  parse+validate↔repair/fallback: LOAD-BEARING  │
  │    null → always a valid typed value           │
  └────────────────────────┬───────────────────────┘
                           ▼
                   Block 4 — How it works
```

The skeleton is mapped — the rest of this file walks the mechanics that hang off it.

## How it works

**Mental model.** Think of the model's output as an HTTP response body you must parse defensively, except the body is `string` and the JSON may be embedded in prose. The contract is a three-stage funnel: *extract* the JSON from the prose, *validate* its shape against a type guard, and *repair* via a clean-context retry when extraction or validation fails. Only output that clears all three becomes a typed value.

```
finalText: "Here's the diagnosis:\n```json\n{...}\n```\nHope this helps!"
      │
  (1) EXTRACT     the JSON parser
      │  fenced → bare JSON.parse → first-bracket-to-last-bracket scan
      ▼
  parsed: unknown
      │
  (2) VALIDATE    the type guard
      │  every required field present & correct type?
      ▼
  typed Diagnosis ✓        ─── or ───▶ null
                                         │
  (3) REPAIR      synthesize()  (clean-context retry)
                                         │
                                         ▼  OR FALLBACK
                                   always a valid Diagnosis
```

The model's job is to *try* to emit JSON; the contract's job is to *guarantee* a typed result regardless of how well the model tried.

---

### Stage 1 — extract: the JSON parser

The JSON parser handles the three ways the model presents JSON, in order of likelihood:

```
  function parse_agent_json(text):
      fence = match(text, regex(```` ``` ````json + body + ```` ``` ````))
      candidate = trim(fence.body if fence else text)

      try:                                     # (a) bare attempt on the candidate
          return JSON.parse(candidate)
      except: pass

      start = index_of_first(candidate, "[" or "{")    # (c) substring scan
      end   = last_index_of(candidate, "]" or "}")
      if start >= 0 and end > start:
          return JSON.parse(slice(candidate, start, end + 1))

      throw "no parseable json in agent output"
```

```
(a) fenced     ```json\n{...}\n```        ← regex captures the fence body
(b) bare       {...}                       ← JSON.parse the whole thing
(c) substring  "...prose... {...} ...prose" ← grab first [/{ to last ]/}
(else) throw   no brackets at all          ← caller catches → null/[]
```

Each strategy is a fallback for the previous. The synthesis instruction *asks* for a `json` fence, so (a) is the common path; (b) and (c) recover the cases where the model forgot the fence or wrapped it in prose. The function returns `unknown` — it has parsed *syntax*, not *shape*. That is the next stage's job.

---

### Stage 2 — validate: the type guards

Three `v is T` predicates prove the parsed object matches the expected shape, field by field. The diagnosis guard:

```
  function is_diagnosis(v) -> v is Diagnosis:
      if not v or type_of(v) != "object":
          return false
      return type_of(v.conclusion)             == "string"
         AND is_array(v.evidence)
         AND is_array(v.hypothesesConsidered)
```

The anomaly-array guard is stricter — it walks every element and checks nested fields (the change value is a number, the change direction is `'up'|'down'`, the severity is in the allowed set). The recommendation-array guard validates the *id-less* shape, because the agent emits recommendations without an `id` and the code assigns it after validation:

```
agent emits:   { title, rationale, bloomreachFeature, steps, ... }   ← no id
guard validates THIS shape
code assigns:  { id: random_uuid(), ...r }
```

This is a deliberate split: the validator checks what the *model* controls; the system owns identity. Letting the model invent ids would risk collisions and non-UUID strings.

```
anomaly-array guard       ── every item: metric, scope[], change{value,direction,baseline}, severity∈SET
diagnosis guard           ── conclusion:string, evidence:[], hypothesesConsidered:[]
recommendation-array guard── every item: title, rationale, bloomreachFeature∈SET, steps[], estimatedImpact, confidence∈SET
                             (id intentionally NOT validated — assigned post-hoc)
```

The recommendation guard was deliberately *loosened* as the output contract grew. `estimatedImpact` is now a union — a legacy `string` OR a `{ range, rangeUsd?, assumption }` object — and the guard accepts either shape via an `impactOk` check: `type_of(x.estimatedImpact) == "string"` OR an object whose `range` is a string. The richer enrichment fields the agent may emit (`effort`, `timeToSetUpMinutes`, `readResultInDays`, `prerequisites`, `successMetric`) are all *optional*, so the guard does not check them; only the load-bearing fields (`title`, `rationale`, `bloomreachFeature`, `steps`, `estimatedImpact`, `confidence`) are validated. Accepting both impact shapes is what lets a legacy snapshot and a fresh dollar-range recommendation pass the *same* guard.

```
estimatedImpact accepted:
  "string"                                   ← legacy snapshots
  { range, rangeUsd?: {low,high}, assumption } ← current agent output
  impactOk = string OR object-with-string-`range`
```

---

### Stage 3 — repair: the synthesis nudge, then the dedicated call

The contract has two repair mechanisms before the final fallback.

**The synthesis instruction** (the in-loop nudge) is appended to the system prompt on the forced-final turn. For the diagnostic agent it reads, in spirit: "You have NO more tool calls available... Respond with ONLY a single JSON object in a ```json fence matching the diagnosis shape." This tells the model exactly what to emit and prohibits further exploration — so the loop's final turn usually produces fence-wrapped JSON that clears stages 1 and 2 directly.

**The dedicated `synthesize()` call** is the clean-context retry when the nudge fails. It is a *separate* model call — no tools, no loop history. It formats the gathered tool calls as evidence text and asks for only the JSON:

```
  response = provider_sdk.messages.create({
    model:       AGENT_MODEL,
    max_tokens:  2048,
    system:      "You are concluding a completed investigation. "
                 "Output ONLY a JSON diagnosis. Never ask for more data.",
    messages:    [{ role: "user", content:
      "Anomaly...\n\nQueries run...\n" + evidence +
      "\n\n...output ... {\"conclusion\": string, \"evidence\": string[], "
      "\"hypothesesConsidered\": [...]}"
    }],
  })
  return try_parse_diagnosis(response.text)
```

Why a fresh call instead of one more loop turn: the loop's message history is full of tool-use / tool-result pairs and partial reasoning — the model has momentum toward "I should query more." A clean single-turn call with no tools and no history breaks that momentum; it sees only evidence + schema + "output JSON" and reliably complies. The recommendation agent has the identical structure.

The whole contract assembles in the fallback chain:

```
try_parse_diagnosis(finalText)            ← stages 1+2 on the loop's output
  OR (await synthesize(...))               ← stages 1+2 on a clean-context retry
  OR FALLBACK                              ← model-independent floor
```

---

### Why extract-from-prose instead of native JSON mode

This is the key design decision worth defending. The system *does* use the provider's native tool-use (the `tools` parameter) for **data retrieval** — every tool call is a structured invocation with a JSON-schema'd input. But the **final structured artifact** (the `Diagnosis`, the `Recommendation[]`) is *parsed from the model's text*, not produced by a native JSON / structured-output mode.

```
DATA retrieval        → native tool-use (provider tools param)   ← structured IN
FINAL artifact        → prose → parse + type guard                ← structured OUT (parsed)
```

The reason is the same provider-agnosticism that drives the testability seam (→ 08-provider-abstraction.md): prose-extraction works against *any* text model, and the synthesis-instruction + JSON parser + guard pipeline is fully under the codebase's control and fully unit-testable with injected fakes. A native JSON mode would couple the *final-artifact* contract to one provider's feature surface. The trade is real — native modes guarantee validity at the token level — but the team chose portability and testability for the output contract while still using native tool-use for input.

---

### The principle

A structured-output contract is three jobs, not one: extract the JSON from prose, validate its shape against a type guard, and repair via a clean-context retry before falling back. Asking the model for JSON is the *request*; the contract is the *guarantee*. You guarantee a typed output for the final artifact in application code (portable, testable) while using native tool-use only for the structured *input* side — a deliberate split between where you trust the provider and where you trust your own parser.

---

## Structured outputs — diagram

This diagram spans the full contract. The Provider layer emits prose-with-JSON; the Service layer extracts, validates, and repairs it into a typed value. A reader who sees only this should grasp that the model returns prose and the type is manufactured by a three-stage funnel with a guaranteed floor.

```
┌──────────────────────────────────────────────────────────────────────┐
│  PROVIDER LAYER (Anthropic)                                           │
│                                                                       │
│  forced-final turn: system + synthesisInstruction  base.ts           │
│  "Respond with ONLY a JSON object in a ```json fence"                │
│           │                                                          │
│           ▼                                                          │
│  finalText = "Here's the diagnosis:\n```json {...} ```\n..."         │
└───────────────────────────┬───────────────────────────────────────────┘
                            │  string
┌───────────────────────────▼───────────────────────────────────────────┐
│  SERVICE LAYER (the contract)                                        │
│                                                                       │
│  (1) EXTRACT  parseAgentJson  validate.ts L3–13                      │
│       fenced → bare → first-bracket-to-last-bracket → throw          │
│           │ unknown                                                  │
│  (2) VALIDATE isDiagnosis / isAnomalyArray / isRecommendationArray   │
│       validate.ts   (id NOT validated; impact union accepted) │
│           │ valid              │ null / threw                        │
│           ▼                    ▼                                     │
│      typed value         (3) REPAIR  synthesize()  diagnostic        │
│                              fresh call, NO tools, NO history        │
│                              evidence text → ONLY JSON                │
│                                   │ valid        │ null              │
│                                   ▼              ▼                   │
│                              typed value      FALLBACK / []          │
│                                                diagnostic.ts         │
│                                                                       │
│  chain: tryParse(finalText) ?? synthesize() ?? FALLBACK    │
└────────────────────────────────────────────────────────────────────────┘

  (separate) DATA retrieval uses native tool-use (tools param) — structured IN.
  The FINAL artifact above is parsed from prose — structured OUT.
```

The model emits prose; the Service layer manufactures the type through extract → validate → repair, with a model-independent `FALLBACK` so the contract's return is always honest.

---

## Implementation in codebase

### Files, functions, and line ranges

- **Extract:** `parseAgentJson(text)` — `lib/mcp/validate.ts` L3–L13. Three strategies: fence regex, bare `JSON.parse`, first-bracket-to-last-bracket substring scan; throws if none.
- **Validate (type guards):** `isAnomalyArray` L17–L27, `isDiagnosis` L29–L35, `isRecommendationArray` L42–L57 — all in `lib/mcp/validate.ts`. The recommendation guard validates the id-less shape and accepts *either* `estimatedImpact` shape via the `impactOk` check (L46–L48); `SEVERITIES` (L15) and `FEATURES`/`CONFIDENCE` (L37–L38) back the enum checks.
- **The grown contracts (`lib/mcp/types.ts`):** `Insight` (L7–L32) gained optional `impact`, `revenueImpact`, `aov`, `funnel`, `affectedCustomers`, `history`, `downstreamReady`. `Diagnosis` (L64–L73) gained optional `confidence` ('high'|'medium'|'low', usually *derived*, not parsed) and `timeSeries`. `Recommendation` (L85–L99) gained `effort`, `timeToSetUpMinutes`, `readResultInDays`, `prerequisites`, `successMetric`, and `estimatedImpact` is now the `EstimatedImpact` union (L77–L79). Every addition is optional, so older snapshots still validate.
- **Post-validation derivation:** `anomalyToInsight` (`lib/state/insights.ts` L8–L27) spreads `deriveInsightFields(a)` (L25) to compute business-owner fields (e.g. `revenueImpact`) from the anomaly's existing evidence — `lib/insights/derive.ts` L27–L39. `Diagnosis.confidence` is post-derived by `diagnosisConfidence` in `DiagnosticAgent.investigate` (`lib/agents/diagnostic.ts` L80, downgraded `high`→`medium` on tool errors at L81–L82) — `derive.ts` L54–L63. These fields are *manufactured after parse/validate*, not extracted from the model's JSON.
- **In-loop repair nudge:** `synthesisInstruction` appended on the forced-final turn — `lib/agents/base.ts` L96–L98; the diagnostic instruction text — `lib/agents/diagnostic.ts` L62–L66.
- **Dedicated repair call (diagnostic):** `DiagnosticAgent.synthesize(anomaly, toolCalls)` — `lib/agents/diagnostic.ts` L87–L126; tool-less `create` at L97, `max_tokens: 2048` at L99.
- **Dedicated repair call (recommendation):** `RecommendationAgent.synthesize(anomaly, diagnosis, toolCalls)` — `lib/agents/recommendation.ts` L82–L132; `create` at L96, `max_tokens: 2048` at L98; its prompt now asks for the full enriched shape (the `EstimatedImpact` object, `effort`, `prerequisites`, `successMetric`) at L109–L119. Ids assigned post-validation via `crypto.randomUUID()` at L76, capped to 3.
- **The contract chains:** diagnostic `tryParseDiagnosis ?? synthesize ?? FALLBACK` — `lib/agents/diagnostic.ts` L74–L75 (`FALLBACK` constant L16–L20); recommendation `tryParseRecommendations ?? synthesize` then `[]` — `lib/agents/recommendation.ts` L69–L73; monitoring `parseAgentJson` + `isAnomalyArray` else `[]` — `lib/agents/monitoring.ts` L95–L101.
- **Native tool-use (the input side):** `params.tools = toolSchemas` on non-final turns — `lib/agents/base.ts` L101; schemas built by `filterToolSchemas`.

### Why this is a codebase strength

Three things make the output contract robust rather than hopeful: the parser handles all three presentation modes the model uses; the guards prove shape field-by-field (not a cast); and the repair path is a *clean-context* retry rather than "ask again in the same conversation." The id-assignment-after-validation detail shows the team thought about the boundary precisely — validate what the model controls, own what the system controls.

---

## Elaborate

### Where this pattern comes from

Extracting structured data from generated prose predates dedicated JSON modes. Early LLM tooling (LangChain's `OutputParser`s, the `instructor` library's retry loops, Pydantic-backed extraction) all converged on the same shape: prompt for a format, parse leniently, validate against a schema, retry on failure. The markdown-fence convention (`` ```json ``) emerged because models trained on developer text reliably reach for code fences when asked for code-shaped output, making the fence a high-signal anchor for extraction.

Native structured outputs (OpenAI's response_format / structured outputs, Anthropic tool-use JSON, constrained decoding via Outlines/SGLang) are the newer answer: constrain the *decoding* so invalid JSON is impossible. They are strictly better for the parse step where available — but they couple the contract to a provider and are harder to exercise in unit tests without the live API.

### The deeper principle

```
request                              guarantee
──────────────────────────────      ──────────────────────────────
"respond with JSON" (prompt)         parse + validate + repair (code)
honored statistically                honored always
breaks silently on prose             surfaces as null → repair → fallback
```

The model's adherence to a format request is probabilistic; the contract's adherence to its return type is absolute. The whole point of the three-stage funnel is to move the guarantee from the model (where it is statistical) into the code (where it is enforced). The `FALLBACK` is the line that makes the return type honest even when every other stage fails.

### Where this breaks down

1. **The substring scan can mis-recover.** `parseAgentJson`'s stage (c) grabs first-bracket-to-last-bracket. A response with prose containing stray brackets, or two JSON blocks, can yield a wrong-but-parseable object that then *passes* the type guard. Pragmatic recovery, not a correctness guarantee (also noted in → 01-what-an-llm-is.md).

2. **Shape is not correctness.** `isDiagnosis` confirms `conclusion` is a string — not that it is true. A hallucinated diagnosis with the right shape passes the contract entirely. Catching wrong-but-well-formed output is the job of evals, not validation.

3. **The repair call doubles cost on failure.** When `tryParse` returns `null`, `synthesize()` is a second full API call (up to 2048 output tokens). Cheap on the happy path (never invoked), expensive on the unlucky path (→ 06-token-economics.md). If the parse-failure rate climbs, the repair becomes a meaningful line item.

### What to explore next

- **Native tool-use for the final artifact:** define the `Diagnosis` shape as a "done" tool the model must call, so the SDK enforces valid arguments — eliminating stages 1 and 2 for the final output at the cost of provider coupling.
- **Zod schemas:** replace the hand-written guards with one Zod schema per shape, generating both the validator and the static type and gaining structured error messages.
- **Constrained decoding (Outlines, SGLang):** force valid JSON at the token level — the strongest form of the parse guarantee.

---

## Project exercises

### Promote the final artifact to native tool-use JSON

- **Exercise ID:** B1.1 (adapted) — structured outputs via the provider's contract.
- **What to build:** define the `Diagnosis` shape as a `submit_diagnosis` tool and require the diagnostic agent to terminate by calling it, so the SDK enforces valid arguments; keep `parseAgentJson` + `synthesize()` as the fallback path for portability.
- **Why it earns its place:** demonstrates you know the difference between requesting JSON and guaranteeing it at the decode level, and that the codebase already uses native tool-use for input but not output.
- **Files to touch:** `lib/agents/diagnostic.ts` (terminate via tool call), `lib/agents/base.ts` (surface the tool's input), `lib/mcp/validate.ts` (reuse `isDiagnosis` on the tool args), `test/agents/diagnostic.test.ts`.
- **Done when:** a normal run produces a `Diagnosis` from the tool-call arguments (no `parseAgentJson` needed), and a forced tool-call failure still degrades through `synthesize() ?? FALLBACK`.
- **Estimated effort:** 1–2 days

### Replace the hand-written guards with Zod schemas

- **Exercise ID:** B1.1 (adapted) — schema-driven validation.
- **What to build:** define `DiagnosisSchema`, `AnomalyArraySchema`, `RecommendationArraySchema` in Zod (id-less for recommendations), and rewrite `isDiagnosis` / `isAnomalyArray` / `isRecommendationArray` as `schema.safeParse` wrappers that preserve the existing `v is T` signatures.
- **Why it earns its place:** shows you can collapse type + validator into one source of truth and surface field-level errors the hand-written guards swallow.
- **Files to touch:** `lib/mcp/validate.ts`, `lib/mcp/types.ts` (derive types from schemas), `test/mcp/validate.test.ts`.
- **Done when:** all existing validation tests pass against the Zod-backed guards, and a malformed object yields a field-level error path instead of a bare `false`.
- **Estimated effort:** 1–4hr

---

## Interview defense

### What an interviewer is really asking

"How do you get structured output from an LLM?" tests whether you stop at "I prompt it for JSON" or go to "I prompt, extract, validate, and repair." The senior signal is naming the three stages and defending the choice to parse-from-prose *for the output* while using native tool-use *for the input* — and knowing where each is in the code.

### Likely questions

**[mid] The model returns `"Here's the diagnosis:\n```json\n{...}\n```"`. How do you get a typed `Diagnosis` out of it?**

`parseAgentJson` (`lib/mcp/validate.ts` L3–L13) tries the fence regex first, capturing the body inside ```json``` — that's the common case. Then `isDiagnosis` (L29–L35) proves the shape. If both succeed, `tryParseDiagnosis` (`lib/agents/diagnostic.ts` L22–L29) returns a typed `Diagnosis`; otherwise `null`.

```
prose + fence → fence regex → JSON.parse → isDiagnosis → Diagnosis ✓
```

**[senior] Why parse JSON from prose instead of using a native structured-output mode for the final artifact?**

Portability and testability. The codebase uses native tool-use for *input* (every MCP call), but keeps the *output* contract — `parseAgentJson` + guards + `synthesize()` — in application code so it works against any text model and is fully unit-testable with injected fakes against no network. A native mode guarantees validity at the token level but couples the output contract to one provider. The trade is deliberate and reversible.

```
input  → native tool-use (provider-enforced)
output → parse-from-prose (portable, testable)  ← chosen, not forced
```

**[arch] `tryParse` returns null. Why a fresh `synthesize()` call instead of one more loop turn?**

The loop's history is full of `tool_use`/`tool_result` pairs and partial reasoning; the model has momentum toward "query more." A same-conversation retry inherits that momentum. `synthesize()` (`lib/agents/diagnostic.ts` L87–L126) is a fresh `create` with no tools and no history — it sees only evidence + schema + "output JSON," which reliably produces the artifact. The cost is one extra call, paid only on the failure path.

```
loop retry:   [tool_use][tool_result]...[synth instr] → still wants to query
clean call:   [evidence + "output JSON"]               → emits JSON
```

### The question candidates always dodge

**"What does your validation actually guarantee?"** Shape, not truth. `isDiagnosis` proves `conclusion` is a string — not that the conclusion is correct. A hallucinated-but-well-shaped diagnosis passes the entire contract. Catching that is the job of evals, which this codebase does not yet have. Conflating shape with correctness is the trap.

### One-line anchors

- `lib/mcp/validate.ts` L3–L13 — `parseAgentJson`: fenced → bare → substring scan.
- `lib/mcp/validate.ts` L17–L57 — the three type guards; recommendation validates the id-less shape and accepts either `estimatedImpact` shape (`impactOk`, L46–L48).
- `lib/agents/base.ts` L96–L98 — `synthesisInstruction` appended on the forced-final turn.
- `lib/agents/diagnostic.ts` L87–L126 — `synthesize()`: clean-context, tool-less repair.
- `lib/agents/diagnostic.ts` L74–L75 — the contract chain: `tryParse ?? synthesize ?? FALLBACK`.

---

## Validate

### Level 1 — Reconstruct

From memory, draw the three-stage funnel (extract → validate → repair) and name the function at each stage. State what `parseAgentJson` returns (`unknown`), what the type guard returns (`v is T`), and what the chain returns when all stages fail (`FALLBACK` / `[]`).

### Level 2 — Explain

Out loud: why does `isRecommendationArray` validate a shape *without* an `id` (`lib/mcp/validate.ts` L42–L57), and where does the `id` come from (`lib/agents/recommendation.ts` L76)? What bug does this split prevent? Then: why does the same guard accept `estimatedImpact` as *either* a `string` or a `{ range, … }` object (the `impactOk` check, L46–L48)?

### Level 3 — Apply

Scenario: a new agent must return `{ summary: string; tags: string[] }`. Using `lib/mcp/validate.ts` L29–L35 as the template, write the `isSummary` guard, decide which of `parseAgentJson`'s three strategies will hit for fence-wrapped output, and describe the `synthesize()`-equivalent clean-context retry you'd add.

### Level 4 — Defend

A reviewer says: "Use Anthropic's tool-use JSON mode for the final diagnosis and delete `parseAgentJson`." State what that buys (token-level validity), what it costs (provider coupling, harder fakes-in-tests), why the codebase already accepts native tool-use for *input* but not output, and the measured condition under which you'd flip the output side too.

### Quick check — code reference test

In `parseAgentJson`, what are the three extraction strategies in order, and what happens if all three fail? (Answer: (1) fenced-code regex, (2) bare `JSON.parse`, (3) first-bracket-to-last-bracket substring scan; if none yields valid JSON it throws `'no parseable json in agent output'` — `lib/mcp/validate.ts` L3–L13.)

## See also

→ 01-what-an-llm-is.md · → 05-streaming.md · → 02-tokenization.md · → 07-heuristic-before-llm.md

---
Updated: 2026-05-28 — Refreshed the output contract for grown types (Insight/Diagnosis/Recommendation optional fields, `EstimatedImpact` union), the loosened `isRecommendationArray` `impactOk` check, post-validation derivation via `deriveInsightFields`/`diagnosisConfidence`, and re-derived all validate.ts/diagnostic.ts/recommendation.ts line refs.
Updated: 2026-05-29 — Synthesis-instruction append ref drifted to L96–L98 (was L95–L98); corrected the three remaining occurrences (the In-this-codebase line already read L96–L98).
Updated: 2026-05-30 — Migrated to study.md v1.47 template (Phase 1+2 mechanical): removed Tradeoffs / Tech reference / Summary sections; renamed "In this codebase" → "Implementation in codebase"; moved See also to a bottom block. "Why care" preserved pending Phase 3 (Zoom out, then zoom in + LAYERS diagram) authoring.
Updated: 2026-05-30 — Phase 3 of study.md v1.47 migration: replaced "Why care" block with "Zoom out, then zoom in" (LAYERS diagram + zoom-in paragraph) per format.md.
Updated: 2026-05-31 — Applied study.md v1.48: scrubbed "How it works" of file paths, line refs, and real-code fences; replaced with generic role labels + pseudocode per format.md. Codebase-specific anchoring lives exclusively in "Implementation in codebase".
Updated: 2026-05-31 — Applied study.md v1.50: added Structure pass block (layers · axis · seams) between Zoom out and How it works per format.md's new Block 3.
