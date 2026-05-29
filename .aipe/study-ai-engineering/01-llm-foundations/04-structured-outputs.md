# Structured outputs (extracting a typed contract from prose)

**Industry name(s):** structured output extraction, JSON-from-prose parsing, schema validation / output contracts
**Type:** Industry standard · Language-agnostic

> The model is asked to emit JSON in a markdown fence; `parseAgentJson` extracts it through three escalating strategies, a `v is T` type guard proves the shape, and a dedicated tool-less `synthesize()` call is the clean-context retry — together a contract that turns a prose string into a validated `Diagnosis`, `Anomaly[]`, or `Recommendation[]`.

**See also:** → 01-what-an-llm-is.md · → 05-streaming.md · → 02-tokenization.md · → 07-heuristic-before-llm.md

---

## Why care

You receive a webhook payload and need a typed object out of it. You do not write `const order = body as Order` and move on — you parse the JSON, then run it through a validator (Zod, a hand-written guard) that checks every field, and you have a fallback for when the payload is malformed. The boundary between "bytes from outside" and "typed object inside" is where you spend your reliability budget, because everything downstream assumes the type is real.

An LLM that should return structured data is exactly this boundary, with one extra hazard: the model frequently wraps the JSON in prose — "Here's my analysis:" before it, "Let me know if you need more" after it. So the question is not just "is this valid JSON of the right shape?" but "where, inside this string of natural language, is the JSON, and what do I do when there isn't any?"

**The pivot: a structured-output contract is parse + validate + repair, and getting all three right is what separates a demo from a system.** Asking the model for JSON is necessary but not sufficient — the model honors the request statistically. The contract is the code that turns "usually JSON-ish" into "always a valid typed object or a known-safe default."

Before the contract:
- `JSON.parse(finalText)` throws on the prose preamble; the investigation 500s
- A response missing `hypothesesConsidered` is accepted and crashes a downstream `.map`
- A run that exhausts its budget returns `''` and there is no recovery

After:
- `parseAgentJson` finds the JSON whether it's fenced, bare, or buried in prose
- `isDiagnosis` rejects anything missing a required field
- `synthesize()` retries in a clean context; `FALLBACK` covers total failure

It is the webhook-validation discipline, applied to a backend whose payloads are natural language with JSON somewhere inside.

---

## How it works

**Mental model.** Think of the model's output as an HTTP response body you must parse defensively, except the body is `string` and the JSON may be embedded in prose. The contract is a three-stage funnel: *extract* the JSON from the prose, *validate* its shape against a type guard, and *repair* via a clean-context retry when extraction or validation fails. Only output that clears all three becomes a typed value.

```
finalText: "Here's the diagnosis:\n```json\n{...}\n```\nHope this helps!"
      │
  (1) EXTRACT     parseAgentJson  validate.ts L3–13
      │  fenced → bare JSON.parse → first-bracket-to-last-bracket scan
      ▼
  parsed: unknown
      │
  (2) VALIDATE    isDiagnosis  validate.ts L29–35
      │  every required field present & correct type?
      ▼
  typed Diagnosis ✓        ─── or ───▶ null
                                         │
  (3) REPAIR      synthesize()  diagnostic.ts L87–126  (clean-context retry)
                                         │
                                         ▼  ?? FALLBACK
                                   always a valid Diagnosis
```

The model's job is to *try* to emit JSON; the contract's job is to *guarantee* a typed result regardless of how well the model tried.

---

### Stage 1 — extract: `parseAgentJson`

`parseAgentJson` (`lib/mcp/validate.ts` L3–L13) handles the three ways the model presents JSON, in order of likelihood:

```typescript
export function parseAgentJson(text: string): unknown {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);   // (a) fenced
  const candidate = (fence ? fence[1] : text).trim();
  try { return JSON.parse(candidate); } catch { /* fall through */ }  // (b) bare
  const start = candidate.search(/[[{]/);                       // (c) substring
  const end = Math.max(candidate.lastIndexOf(']'), candidate.lastIndexOf('}'));
  if (start >= 0 && end > start) {
    return JSON.parse(candidate.slice(start, end + 1));
  }
  throw new Error('no parseable json in agent output');
}
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

Three `v is T` predicates in `lib/mcp/validate.ts` prove the parsed object matches the expected shape, field by field. `isDiagnosis` (L29–L35):

```typescript
export function isDiagnosis(v: unknown): v is Diagnosis {
  if (!v || typeof v !== 'object') return false;
  const d = v as any;
  return typeof d.conclusion === 'string'
    && Array.isArray(d.evidence)
    && Array.isArray(d.hypothesesConsidered);
}
```

`isAnomalyArray` (L17–L27) is stricter — it walks every element and checks nested fields (`change.value` is a number, `change.direction` is `'up'|'down'`, `severity` is in the `SEVERITIES` set). `isRecommendationArray` (L42–L57) validates the *id-less* shape, because the agent emits recommendations without an `id` and the code assigns it after validation (`lib/agents/recommendation.ts` L76):

```
agent emits:   { title, rationale, bloomreachFeature, steps, ... }   ← no id
isRecommendationArray validates THIS shape  (validate.ts L42)
code assigns:  { id: crypto.randomUUID(), ...r }   (recommendation.ts L76)
```

This is a deliberate split: the validator checks what the *model* controls; the system owns identity. Letting the model invent `id`s would risk collisions and non-UUID strings.

```
isAnomalyArray       ── every item: metric, scope[], change{value,direction,baseline}, severity∈SET
isDiagnosis          ── conclusion:string, evidence:[], hypothesesConsidered:[]
isRecommendationArray ── every item: title, rationale, bloomreachFeature∈SET, steps[], estimatedImpact, confidence∈SET
                         (id intentionally NOT validated — assigned post-hoc)
```

`isRecommendationArray` was deliberately *loosened* as the output contract grew. `estimatedImpact` is now a union — a legacy `string` OR a `{ range, rangeUsd?, assumption }` object (`EstimatedImpact`, `lib/mcp/types.ts` L77–L79) — and the guard accepts either shape via an `impactOk` check (`lib/mcp/validate.ts` L46–L48): `typeof x.estimatedImpact === 'string'` OR an object whose `range` is a string. The richer enrichment fields the agent may emit (`effort`, `timeToSetUpMinutes`, `readResultInDays`, `prerequisites`, `successMetric` — `types.ts` L94–L99) are all *optional*, so the guard does not check them; only the load-bearing fields (`title`, `rationale`, `bloomreachFeature`, `steps`, `estimatedImpact`, `confidence`) are validated. Accepting both impact shapes is what lets a legacy snapshot and a fresh dollar-range recommendation pass the *same* guard.

```
estimatedImpact accepted by isRecommendationArray:
  "string"                                   ← legacy snapshots
  { range, rangeUsd?: {low,high}, assumption } ← current agent output
  validate.ts L46–48: impactOk = string OR object-with-string-`range`
```

---

### Stage 3 — repair: the synthesis nudge, then the dedicated call

The contract has two repair mechanisms before the final fallback.

**The synthesis instruction** (the in-loop nudge) is appended to the system prompt on the forced-final turn (`lib/agents/base.ts` L96–L98). For the diagnostic agent it reads (`lib/agents/diagnostic.ts` L63–L67): "You have NO more tool calls available... Respond with ONLY a single JSON object in a ```json fence matching the diagnosis shape." This tells the model exactly what to emit and prohibits further exploration — so the loop's final turn usually produces fence-wrapped JSON that clears stages 1 and 2 directly.

**The dedicated `synthesize()` call** is the clean-context retry when the nudge fails. `DiagnosticAgent.synthesize` (`lib/agents/diagnostic.ts` L87–L126) is a *separate* `anthropic.messages.create` (L97) — no tools, no loop history. It formats the gathered `toolCalls` as evidence text and asks for only the JSON:

```typescript
const res = await this.anthropic.messages.create({
  model: AGENT_MODEL,
  max_tokens: 2048,
  system: 'You are concluding a completed investigation. Output ONLY a JSON diagnosis. Never ask for more data.',
  messages: [{ role: 'user', content: `Anomaly...\n\nQueries run...\n${evidence}\n\n...output ... {"conclusion": string, "evidence": string[], "hypothesesConsidered": [...]}` }],
});
return tryParseDiagnosis(text);
```

Why a fresh call instead of one more loop turn: the loop's message history is full of `tool_use`/`tool_result` pairs and partial reasoning — the model has momentum toward "I should query more." A clean single-turn call with no tools and no history breaks that momentum; it sees only evidence + schema + "output JSON" and reliably complies. The recommendation agent has the identical structure (`lib/agents/recommendation.ts` L82–L132, call at L96).

The whole contract assembles in the fallback chain (`lib/agents/diagnostic.ts` L74–L75):

```
tryParseDiagnosis(finalText)             ← stages 1+2 on the loop's output
  ?? (await this.synthesize(...))         ← stages 1+2 on a clean-context retry
  ?? FALLBACK                             ← model-independent floor
```

---

### Why extract-from-prose instead of native JSON mode

This is the key design decision worth defending. The codebase *does* use Anthropic's native tool-use (the `tools` parameter) for **data retrieval** — every MCP call is a structured tool invocation with a JSON-schema'd input. But the **final structured artifact** (the `Diagnosis`, the `Recommendation[]`) is *parsed from the model's text*, not produced by a native JSON/structured-output mode.

```
DATA retrieval        → native tool-use (Anthropic tools param)  ← structured IN
FINAL artifact        → prose → parseAgentJson → type guard       ← structured OUT (parsed)
```

The reason is the same provider-agnosticism that drives the testability seam (→ 08-provider-abstraction.md): prose-extraction works against *any* text model, and the `synthesisInstruction` + `parseAgentJson` + guard pipeline is fully under the codebase's control and fully unit-testable with injected fakes. A native JSON mode would couple the *final-artifact* contract to one provider's feature surface. The trade is real — native modes guarantee validity at the token level — but the team chose portability and testability for the output contract while still using native tool-use for input.

---

### The principle

A structured-output contract is three jobs, not one: extract the JSON from prose, validate its shape against a type guard, and repair via a clean-context retry before falling back. Asking the model for JSON is the *request*; the contract is the *guarantee*. blooming insights guarantees a typed output for the final artifact in application code (portable, testable) while using native tool-use only for the structured *input* side — a deliberate split between where it trusts the provider and where it trusts its own parser.

---

## Structured outputs — diagram

This diagram spans the full contract. The Provider layer emits prose-with-JSON; the Service layer extracts, validates, and repairs it into a typed value. A reader who sees only this should grasp that the model returns prose and the type is manufactured by a three-stage funnel with a guaranteed floor.

```
┌──────────────────────────────────────────────────────────────────────┐
│  PROVIDER LAYER (Anthropic)                                           │
│                                                                       │
│  forced-final turn: system + synthesisInstruction  base.ts L96–98    │
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
│       validate.ts L17–57   (id NOT validated; impact union accepted) │
│           │ valid              │ null / threw                        │
│           ▼                    ▼                                     │
│      typed value         (3) REPAIR  synthesize()  diagnostic L87–126│
│                              fresh call, NO tools, NO history        │
│                              evidence text → ONLY JSON                │
│                                   │ valid        │ null              │
│                                   ▼              ▼                   │
│                              typed value      FALLBACK / []          │
│                                                diagnostic.ts L16–20  │
│                                                                       │
│  chain: tryParse(finalText) ?? synthesize() ?? FALLBACK  (L74–75)    │
└────────────────────────────────────────────────────────────────────────┘

  (separate) DATA retrieval uses native tool-use (tools param) — structured IN.
  The FINAL artifact above is parsed from prose — structured OUT.
```

The model emits prose; the Service layer manufactures the type through extract → validate → repair, with a model-independent `FALLBACK` so the contract's return is always honest.

---

## In this codebase

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

## Tradeoffs

### Prose-extraction contract vs. native JSON mode (for the final artifact)

| Dimension | This codebase (extract + validate + repair) | Native JSON / tool-use mode |
|---|---|---|
| Validity guarantee | Manufactured in code; repair + fallback | Token-level; malformed impossible |
| Provider coupling | None — any text model works | High — per-provider feature |
| Testability with fakes | Full — pure functions, injected anthropic | Lower — needs the live structured mode |
| Cost on failure | Extra `synthesize()` call (2048 tokens) | None (cannot fail to parse) |
| Correctness guarantee | Shape only | Shape only |
| Handles prose-wrapped output | Yes (stages a/b/c) | N/A (no prose) |

**What we gave up.** A token-level validity guarantee for the final artifact. With prose-extraction, some fraction of calls fail stages 1–2 and pay the repair cost; a native mode makes malformed output structurally impossible. The codebase accepts the repair cost to keep the output contract portable and unit-testable.

**What the alternative would have cost.** Coupling the final-artifact contract to one provider's structured-output feature, with different shapes and limits per vendor, and a contract that is harder to exercise in the 157-test suite without the live API. Notably the codebase already uses native tool-use for *input* (data retrieval) — so the choice was specifically to keep the *output* side in portable application code.

**The breakpoint.** Prose-extraction is right while the parse-failure rate stays low enough that `synthesize()` retries are rare. When a measured failure rate climbs past a few percent — making the doubled-cost repair a real line item — moving the final artifact onto native tool-use JSON mode becomes worth the provider coupling. The retrieval side already proves native tool-use is acceptable here; the output side is held back deliberately, not by inability.

**Not actually a tradeoff:** id-assignment-after-validation. Validating the id-less shape and assigning UUIDs in code (`recommendation.ts` L76) costs nothing and removes a class of model-controlled-identity bugs.

---

## Tech reference (industry pairing)

### markdown-fence JSON extraction (`parseAgentJson`)

- **Codebase uses:** `lib/mcp/validate.ts` L3–L13 — fence regex, then bare parse, then first-bracket-to-last-bracket scan.
- **Why it's here:** the synthesis instructions ask for a ```json fence; the parser recovers the cases where the model forgets the fence or wraps it in prose.
- **Leading today:** native structured outputs (OpenAI response_format, Anthropic tool-use JSON) lead for *new* projects (2026); fence-extraction remains the portable, provider-agnostic baseline.
- **Why it leads:** constrained decoding eliminates the parse failure mode entirely where the provider supports it.
- **Runner-up:** LangChain `JsonOutputParser` / `instructor` — same parse-validate-retry shape, more framework.

### type guards (`isDiagnosis`, `isAnomalyArray`, `isRecommendationArray`)

- **Codebase uses:** `lib/mcp/validate.ts` L17–L57 — hand-written `v is T` predicates, one per shape.
- **Why it's here:** to convert `parseAgentJson`'s `unknown` into a typed value with a runtime shape proof, validating the id-less recommendation shape (and accepting either `estimatedImpact` shape) specifically.
- **Leading today:** Zod leads adoption for runtime validation in TypeScript (2026) — one schema generates validator and type.
- **Why it leads:** single source of truth for shape, composable, with structured error reporting the hand-written guards lack.
- **Runner-up:** Valibot (smaller), io-ts (functional).

### clean-context retry (`synthesize()`)

- **Codebase uses:** `lib/agents/diagnostic.ts` L87–L126, `lib/agents/recommendation.ts` L82–L132 — a fresh, tool-less `create` that re-derives the artifact from evidence text.
- **Why it's here:** to break the model's exploration momentum that a same-conversation retry would inherit.
- **Leading today:** `instructor`-style validation-retry loops lead for Python (2026); a clean-context re-prompt is the language-agnostic equivalent.
- **Why it leads:** retrying with the validation error or a clean context recovers most format failures without constrained decoding.
- **Runner-up:** JSON-repair libraries (e.g. `jsonrepair`) — fix malformed JSON mechanically instead of re-prompting; cheaper but cannot recover missing fields.

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

## Summary

A structured-output contract is parse + validate + repair, not just a JSON request. blooming insights extracts the model's JSON from prose with `parseAgentJson` (fenced → bare → substring scan, `lib/mcp/validate.ts`), proves the shape with `v is T` guards that validate the id-less recommendation shape and let the system assign ids, and repairs failures with a clean-context tool-less `synthesize()` call before dropping to a model-independent `FALLBACK`. Crucially, the codebase uses native tool-use for the structured *input* (data retrieval) but keeps the final-artifact contract in portable, testable application code — a deliberate split between trusting the provider and trusting its own parser.

**Key points:**
- The contract has three stages: extract (`parseAgentJson`), validate (type guards), repair (`synthesize()` → `FALLBACK`).
- `parseAgentJson` handles fenced, bare, and prose-buried JSON in escalating order.
- Type guards prove shape field-by-field; the recommendation guard validates the id-less shape and the system assigns UUIDs after.
- `synthesize()` is a clean-context retry — no tools, no loop history — which breaks the model's exploration momentum.
- Native tool-use is used for *input*; the final *output* artifact is parsed from prose for portability and testability — a defensible, reversible choice.

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

---
Updated: 2026-05-28 — Refreshed the output contract for grown types (Insight/Diagnosis/Recommendation optional fields, `EstimatedImpact` union), the loosened `isRecommendationArray` `impactOk` check, post-validation derivation via `deriveInsightFields`/`diagnosisConfidence`, and re-derived all validate.ts/diagnostic.ts/recommendation.ts line refs.
Updated: 2026-05-29 — Synthesis-instruction append ref drifted to L96–L98 (was L95–L98); corrected the three remaining occurrences (the In-this-codebase line already read L96–L98).
