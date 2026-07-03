# 07 · Output mode mismatch

**Industry name:** *output mode mismatch* / *output format drift* / *contract break at the seam* · Language-agnostic

## Zoom out — where output modes live

Every chain declares an output mode. The composition layer expects that mode. When one chain quietly changes what it emits, the composition breaks *downstream* of the change, not at the change itself. That's the whole failure surface.

```
  Zoom out — the output mode contract per stage

  ┌─ MonitoringAgent.scan() ────────────────────────────┐
  │  declared mode: Anomaly[] (JSON, validated at        │
  │                  lib/mcp/validate.ts:isAnomalyArray)  │
  └────────────────┬────────────────────────────────────┘
                   │  contract: array of anomaly objects
                   ▼
  ┌─ DiagnosticAgent.investigate(anomaly) ──────────────┐
  │  declared mode: Diagnosis (JSON, validated at        │
  │                  lib/mcp/validate.ts:isDiagnosis)     │
  └────────────────┬────────────────────────────────────┘
                   │  contract: object with three fields
                   ▼
  ┌─ RecommendationAgent.propose(anomaly, diagnosis) ───┐
  │  declared mode: Recommendation[] (JSON, validated at │
  │                  lib/mcp/validate.ts:isRecommenda…)   │
  └─────────────────────────────────────────────────────┘

  ┌─ Query route (/api/agent) ──────────────────────────┐
  │  declared mode: PROSE (markdown-flavored text)       │
  │  legacy-prompts/query.md:46-48: "no JSON shape is    │
  │  required — just the answer text"                    │
  └─────────────────────────────────────────────────────┘
```

## Zoom in — one contract per chain, and one glaring exception

Four chains, three modes:

- Monitor → `Anomaly[]` JSON.
- Diagnose → `Diagnosis` JSON.
- Recommend → `Recommendation[]` JSON.
- Query → **prose**.

Every chain has a validator on the parse boundary. Every chain except query emits structured JSON. Query emits free text and the caller (the UI) treats it as markdown. This is the seam where output mode mismatch bites — if the query chain suddenly returned JSON, the UI would render `{ "answer": "..." }` verbatim. If the diagnose chain suddenly returned prose, the parser would throw.

## Structure pass — layers, axis, seams

Trace one axis: *who is the reader of each chain's output*, and *what shape does that reader expect*.

- **Monitor's reader:** the briefing route iterator + the diagnostic agent's input. Both expect `Anomaly[]`.
- **Diagnose's reader:** the recommendation agent (expects `Diagnosis`) + the UI (expects `Diagnosis`).
- **Recommend's reader:** the UI (expects `Recommendation[]`).
- **Query's reader:** the UI (expects prose text, rendered as markdown).

**The seam:** the boundary where a chain's output is consumed. Every seam has an implicit *and* explicit contract. Explicit = the TypeScript type + the validator. Implicit = "the model actually returns something matching that type." Mismatches happen when the implicit drifts away from the explicit.

## How it works

### Move 1 — the shape

You've built REST endpoints. You know this failure: your `/api/orders` returns JSON. One day the endpoint starts returning HTML (server error rendered as a 500 page), the frontend does `res.json()`, throws `SyntaxError: Unexpected token '<' in JSON`. The mismatch is at the mode level — the caller wanted one thing, got another. LLM chains have the same failure surface. The prompt says "return JSON." The model returns markdown with a code fence and a signoff. The parser breaks.

```
  Pattern — output mode as a typed contract

  producer                               consumer
  ┌──────────────┐  contract: JSON      ┌──────────────┐
  │ chain A       │ ────────────────►  │ chain B       │
  │  emits JSON   │                    │  parses JSON  │
  └──────────────┘                    └──────────────┘

  the contract is:
    · shape (what fields)
    · encoding (JSON vs markdown vs plain text)
    · wrapper (fenced code block vs bare)
    · trailing prose (allowed vs not)
```

Every one of those four is a way the contract can break. Shape drift: field renamed. Encoding drift: JSON becomes markdown. Wrapper drift: fence added or removed. Trailing prose: model adds "Hope this helps!" at the end.

### Move 2 — walking the modes

#### JSON mode chains — three of the four

Monitor, diagnose, and recommend all emit fenced JSON. Their validators live at `lib/mcp/validate.ts`:

`isAnomalyArray()` at `:17-27`:
```
export function isAnomalyArray(v: unknown): v is Anomaly[] {
  return Array.isArray(v) && v.every((a) =>
    !!a && typeof a === 'object' &&
    typeof (a as any).metric === 'string' &&
    Array.isArray((a as any).scope) &&
    !!(a as any).change && typeof (a as any).change.value === 'number' &&
    ((a as any).change.direction === 'up' || (a as any).change.direction === 'down') &&
    typeof (a as any).change.baseline === 'string' &&
    SEVERITIES.includes((a as any).severity)
  );
}
```

`isDiagnosis()` at `:29-35`:
```
export function isDiagnosis(v: unknown): v is Diagnosis {
  if (!v || typeof v !== 'object') return false;
  const d = v as any;
  return typeof d.conclusion === 'string'
    && Array.isArray(d.evidence)
    && Array.isArray(d.hypothesesConsidered);
}
```

`isRecommendationArray()` at `:42-57` — stricter, checks the enum values, checks the impact union shape.

The three guards decompose the contract. Each guard is small — the diagnosis guard only checks three fields. Everything else on `Diagnosis` (`affectedCustomers`, `timeSeries`) is optional. The strictness gradient is intentional: highest for recommendations (they drive marketer action; the shape has to be right), medium for anomalies (they drive downstream diagnosis; broken shape halts the pipeline), lowest for diagnoses (they're consumed by another prompt + rendered as prose; some tolerance helps).

#### Prose mode — the one exception

`lib/agents/legacy-prompts/query.md:46-48`:

> "Give a clear, concise answer in plain prose — a few sentences; you may use short markdown bullets. Cite the key numbers you found. If you couldn't get the data, say so plainly. No JSON shape is required — just the answer text."

That's the whole declared mode: prose, allowed markdown, no wrapper, no schema. The caller (`/api/agent` route) streams the assistant text tokens straight to the UI, which renders them as markdown.

The gotcha: if a future edit added "and also return a JSON summary" to this prompt, the model would happily emit prose followed by fenced JSON. The UI would render the JSON as literal markdown code block. The user would see raw JSON in their answer. This is exactly the mode-mismatch failure surface — the prompt drifted, no validator caught it, the UI's markdown renderer treated the JSON as text to be displayed.

#### Where mismatches surface in real code

The three specific failure modes I've hit in production:

**Model adds a courtesy signoff.**
```
   here's your analysis:
   ```json
   { "conclusion": "..." }
   ```
   let me know if you'd like me to elaborate!
```
Fence extraction at `lib/mcp/validate.ts:5` catches the fenced block. The trailing prose is discarded. But if the model puts the signoff *inside* the fence, or drops the fence entirely, you fall through to the substring-scan fallback at `:7-12`.

**Two fenced blocks.**
```
   thinking:
   ```json
   { "hypothesis": "..." }
   ```
   answer:
   ```json
   { "conclusion": "..." }
   ```
```
The regex at `:5` is non-greedy — it grabs the first fenced block. Which may or may not be the answer. This is a real bug we hit; the fix in production would be a rule in § 4 of the prompt: "return exactly one fenced JSON block." (This repo's diagnostic prompt does say "return ONLY a JSON object" at `legacy-prompts/diagnostic.md:60`, which the model usually honors.)

**Encoding shift on model upgrade.**

Sonnet 3 emitted diagnoses with plain-text field values. Sonnet 4 sometimes emits diagnoses with markdown-formatted `conclusion` fields — bullet points inside a JSON string. Parsing succeeds. The UI renders the string. The user sees markdown-inside-JSON-inside-markdown, which the outer markdown renderer flattens weirdly. The fix isn't the parser; it's the § 4 output shape: "the `conclusion` field must be plain prose, no markdown formatting."

```
  Flow — mode mismatch as a downstream failure

  chain A "returns JSON"          consumer "parses JSON"
     │                                  │
     │      contract intact             │
     ▼                                  ▼
  { "conclusion": "..." }  ─────►  JSON.parse ─────► ✓

     │                                  │
     │      contract drifts             │
     ▼                                  ▼
  Here's your analysis:            JSON.parse ─────► ✗
  ```json                          throws SyntaxError
  { "conclusion": "..." }
  ```                              the failure surfaces
                                   at the parser, not
                                   at the chain that drifted.
```

The failure lands one hop downstream of the mistake. That's the diagnostic difficulty. In this repo the fallback substring scan absorbs most of it, but the underlying discipline is: prompt declares the mode, validator checks the mode, mismatches surface as validator throws rather than propagating silently.

### Move 2 variant — the load-bearing skeleton

Kernel of "output mode as contract":

1. **Every chain declares a mode explicitly in its prompt.** Drop this and the model picks one per call.
2. **A validator narrows the parsed output to the typed shape.** Drop this and shape drift propagates.
3. **Downstream code depends on the type, not the raw text.** Drop this and every consumer re-parses.
4. **The parser is lenient about wrappers.** Drop this and one courtesy signoff halts the whole pipeline.

Hardening on top: retry with a stricter prompt on validation fail, a schema-diff dashboard that alerts on new field shapes appearing in production, per-chain test cases in the eval that specifically look at mode compliance. None of that is the skeleton — the skeleton is: declare + validate + typed hand-off + lenient parse.

### Move 3 — the principle

**A chain's output mode is a contract with everyone downstream.** The prompt is only half the contract — the model has to actually honor it, and models drift. The other half is the validator, which is what makes drift *loud* instead of silent. Every serious pipeline has a validator on every seam. The absence of one is not "trust in the model" — it's a delayed bug.

## Primary diagram

```
  Output mode mismatch — the full recap

  chain          declared mode        validator                       consumer
  ─────────────────────────────────────────────────────────────────────────────
  monitor    →   Anomaly[] JSON       isAnomalyArray                  diagnose + UI
  diagnose   →   Diagnosis JSON       isDiagnosis                     recommend + UI
  recommend  →   Recommendation[]     isRecommendationArray           UI
  query      →   PROSE (markdown)     (none — direct stream to UI)    UI

  failure modes at the seam:
    1  shape drift          — field renamed
    2  encoding drift       — JSON becomes prose
    3  wrapper drift        — fenced block added/removed
    4  courtesy prose       — signoff inside or outside the JSON

  defense at every seam:
    lib/mcp/validate.ts:parseAgentJson  ← 3 fallback layers
    lib/mcp/validate.ts:is*             ← shape guards, narrowest possible
```

## Elaborate

The chain-of-thought interaction with output mode is the one most engineers get wrong. If you want the model to reason *and* return JSON, the reasoning has to live inside the JSON — a `thinking` field on the structured output. The wrong shape is: "think through this, then return JSON." What you get: prose thinking followed by JSON. The parser has to skip the prose. The substring-scan fallback catches this, but it's fragile — if the prose contains a `{` character (say the model wrote about "the config {"), the scan starts there and everything breaks. The right shape is: return JSON with a `thinking` string field that contains the reasoning. Now the reasoning is inside the mode, not adjacent to it. Full walk in `09-chain-of-thought.md`.

The 2026 version of this: providers now support "extended thinking" or "reasoning tokens" as a first-class response mode. Anthropic's Claude models can emit a `thinking` block that's structurally separate from the main response — you can enable it via `thinking: { type: 'enabled' }` and get the reasoning trace on the API response object, not in your JSON output. This codebase doesn't use that yet (the diagnostic prompt still asks for `hypothesesConsidered` as part of the output shape). If it did, the trade-off would be: less prompt engineering, more API surface to manage, thinking trace tokens billed separately.

The related pattern from concept 06 (single-purpose chains): when each chain has one mode and the composition is code, mode mismatches are localized to seams. When chains are combined into a super-prompt, mode drift can happen internally to the super-prompt in a way no validator catches. The decomposition is what makes output modes checkable.

## Interview defense

**Q: A chain in your pipeline suddenly starts returning bad output. Where do you look first?**

The validator on the parse boundary. In this codebase that's `lib/mcp/validate.ts`. Each chain's output is narrowed by a shape guard (`isAnomalyArray`, `isDiagnosis`, `isRecommendationArray`). If a validator suddenly starts throwing, the mode has drifted. Common causes: a prompt edit changed § 4 (the output shape section), a model upgrade made the model politer (added a signoff outside the JSON fence), or a downstream consumer changed its field expectations without updating the guard. The receipts in `eval/receipts/*.json` capture raw model output per case, so bisecting is possible.

```
  drift lands at:  validator
  bisect via:      eval/receipts/*.json
```

Anchor: `lib/mcp/validate.ts:29-57`.

**Q: You have JSON chains and one prose chain in the same repo. What's the discipline?**

Explicit mode declaration in every prompt, plus one validator per JSON chain, plus zero validator on the prose chain (the UI renders it directly). The failure surface is when someone edits the prose chain to *also* return JSON — the model will happily emit prose followed by JSON, the UI markdown-renders the JSON as a code block, users see raw JSON. The way you catch this is: the prompt says exactly one mode, and any edit that adds "also return X" is a red flag in review. In this codebase the query prompt at `lib/agents/legacy-prompts/query.md:46-48` explicitly says "no JSON shape is required — just the answer text." That negative declaration is load-bearing.

```
  three JSON chains: prompt says JSON + validator catches drift
  one prose chain:   prompt says prose  + explicit "no JSON"
                              ▲
                    the negative declaration is what prevents future drift
```

Anchor: `lib/agents/legacy-prompts/query.md:46-48`.

## See also

- 02 · structured outputs — the mechanism for making mode contracts enforceable at the provider boundary.
- 06 · single-purpose chains — decomposition is what makes seams (and their modes) checkable.
- 01 · anatomy — § 4 (output shape) is where the mode is declared per chain.
