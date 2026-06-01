# Extracting JSON from prose

**Industry name(s):** lenient/forgiving JSON extraction, fenced-block parsing, structural validation (type guards)
**Type:** Industry standard · Language-agnostic

> When an LLM returns a JSON object wrapped in free-form text, you need a fallback ladder — fenced-block regex, bare parse, substring scan — followed by a type guard that confirms shape before you trust the value.


---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** `parseAgentJson` + the three `is`-predicate guards (`isAnomalyArray`, `isDiagnosis`, `isRecommendationArray`) live in `lib/mcp/validate.ts` and are called by every specialist agent — `MonitoringAgent.scan`, `DiagnosticAgent.investigate`, `RecommendationAgent.propose`. They sit between the Agent loop (which returns `finalText: string` from `runAgentLoop`) and the per-agent fallback chain (`tryParse ?? synthesize ?? FALLBACK`). This is the seam where the model's prose-wrapped output becomes a typed value the downstream route + UI can trust.

```
Zoom out — where JSON-from-prose extraction lives

┌─ Per-agent definitions ────────────────────────┐
│  monitoring.ts · diagnostic.ts · recommendation.ts│
│  call runAgentLoop → finalText: string         │
└─────────────────────┬──────────────────────────┘
                      │
┌─ Agent loop ───────▼───────────────────────────┐
│  runAgentLoop (lib/agents/base.ts)             │
│  returns { finalText, toolCalls }              │
└─────────────────────┬──────────────────────────┘
                      │  finalText (may have prose wrap)
┌─ Extraction + validation ──────────────────────┐  ← we are here
│  ★ parseAgentJson(text): unknown ★            │
│      1. fenced-block regex                    │
│      2. bare JSON.parse                       │
│      3. substring scan                        │
│         │                                      │
│         ▼                                      │
│  ★ isAnomalyArray / isDiagnosis /             │
│    isRecommendationArray (v is T) ★           │
└─────────────────────┬──────────────────────────┘
                      │  typed value (or fallback)
┌─ Route + UI ───────────────────────────────────┐
│  send({type:'insight'/'diagnosis'/...}) → UI   │
└────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question is: how do you reliably extract a structured object from text a model wrote, when the model was told to emit JSON but chose to wrap it in a sentence — and how do you make sure the parsed value is the shape you expected, not whatever happens to parse? The answer is a three-attempt extraction ladder followed by a structural type guard. Each ladder step short-circuits if the previous succeeded: try the fenced-block regex first, then a bare `JSON.parse`, then a substring scan from the first `[`/`{` to the last `]`/`}`. Whatever parses is then handed to a TypeScript `v is T` predicate that walks every required field at runtime. The next sections name the regex, the substring math, and the difference between liberal extraction at the boundary and strict validation at the gate.

---

## Structure pass

**Layers.** JSON-from-prose extraction is a four-layer stack: the **caller** (a specialist agent that just received `finalText` from `runAgentLoop`), the **extractor** (`parseAgentJson` — the three-attempt fallback ladder: fenced-block regex → bare parse → substring scan), the **validator** (a `v is T` type guard that walks every required field), and the **consumer** (the route → UI, which only ever sees a typed value or the agent's fallback). The extractor is intentionally liberal; the validator is intentionally strict — and that asymmetry is the whole point.

**Axis: cost.** Cost here is *parse attempts × probability-of-success-per-attempt* — and the ladder is ordered cheapest-most-likely first. Pick this axis because the extraction ladder IS a cost-minimization strategy: try the cheapest, most-likely-to-work parse first (fenced block — the model was told to use one); fall through to slightly costlier alternates (bare parse — no extraction needed; substring scan — chop and parse). Each attempt costs only if the previous failed. State competes (the candidate variable changes between attempts) but it's a thin axis — the ladder isn't about state ownership; it's about *probabilistic cost ordering*. Pick cost and the ordering reveals itself; pick state and the ordering looks arbitrary.

**Seams.** Two seams matter; one is load-bearing. **Seam 1: extractor → validator.** Cost-shape flips from "best-effort parse, may have produced anything" to "strict structural check, must match the expected shape." This is the liberal-extraction/strict-validation seam — the whole reason both pieces exist. **Seam 2 (load-bearing): validator → consumer (or fallback).** Cost flips from "we hold an `unknown` value" to "we hold a typed `T` we can trust" — OR the validator rejected, the fallback fires, and we hold a known-safe placeholder. This is the joint that lets the downstream route + UI assume types are real; without the validator, the model's output would leak directly into typed code paths.

```
Structure pass — JSON-from-prose

┌─ 1. LAYERS ─────────────────────────────────────────┐
│  Caller (agent) · Extractor (ladder: fenced → bare  │
│  → substring) · Validator (v is T) · Consumer (route│
│  + UI) or Fallback                                   │
└────────────────────────┬─────────────────────────────┘
                         │  pick the axis
┌─ 2. AXIS ─────────────▼──────────────────────────────┐
│  cost: attempts × probability of success — ladder    │
│  is ordered cheapest-most-likely first               │
└────────────────────────┬─────────────────────────────┘
                         │  trace across layers, find flips
┌─ 3. SEAMS ────────────▼──────────────────────────────┐
│  S1: extractor → validator                           │
│      (LIBERAL parse → STRICT structural check)       │
│  S2: validator → consumer ★load-bearing              │
│      (unknown → typed T, or → known-safe fallback)   │
└────────────────────────┬─────────────────────────────┘
                         ▼
                 Block 4 — How it works
```

```
S2 seam — "can downstream trust this value?" answered two ways

┌─ Validator ────────┐    seam     ┌─ Consumer ───────────┐
│  v is T returned   │ ═════╪═════►│  typed T, safe to     │
│  true              │  (it flips) │  ship to route/UI     │
│                    │             │                       │
│  v is T returned   │             │  fallback placeholder │
│  false             │             │  (known-safe shape)   │
└────────────────────┘             └───────────────────────┘
        ▲                                       ▲
        └────── same axis (cost), two answers ─┘
                → this is why model output never leaks into typed code
```

The skeleton is mapped — the rest of this file walks the mechanics that hang off it.

---

## How it works

The extraction is a three-attempt fallback ladder. Each attempt either returns a parsed value or falls through to the next. Once a value is parsed — by any path — it passes to a structural validator before being used.

```
text input
    │
    ▼
┌───────────────────────────┐
│  fenced-block regex?      │  match /```(?:json)?\s*([\s\S]*?)```/i
│  yes → candidate = fence  │
│  no  → candidate = text   │
└───────────┬───────────────┘
            │
            ▼
┌───────────────────────────┐
│  JSON.parse(candidate)    │  try/catch
│  ok  → return value       │
│  throw → fall through     │
└───────────┬───────────────┘
            │
            ▼
┌───────────────────────────┐
│  substring scan           │  first [/{ to last ]/}
│  ok  → return value       │
│  fail → throw             │
└───────────┬───────────────┘
            │
            ▼
        parsed: unknown
            │
            ▼
┌───────────────────────────┐
│  type guard               │  isAnomalyArray / isDiagnosis / isRecommendationArray
│  true  → trusted value    │
│  false → reject / throw   │
└───────────────────────────┘
```

The ladder is short-circuit: the moment any step succeeds, the later steps never run. The load-bearing piece of this whole flow is the type guard at the end — not any single ladder step. The ladder gives you *something* parseable from realistic model output; the guard is what makes that something safe to ship into typed code. Drop a ladder step and you get more fallback hits; drop the guard and malformed values leak into the route and UI.

### The fenced-block regex

```
fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
```

The regex matches an opening triple-backtick, an optional `json` label, optional whitespace, then captures everything up to the closing triple-backtick. The capture group uses `[\s\S]` — not `.` — because `.` does not match newlines by default in JavaScript without the `s` flag. The `?` after `*` makes it non-greedy so it stops at the first closing fence rather than consuming multiple blocks.

If the match exists, `fence[1]` is the captured content (the JSON text only, without backticks). If no match, the full `text` is the candidate. Either way the candidate is trimmed before any parse attempt.

### Bare parse

```
try:    return JSON.parse(candidate)
catch:  pass     # fall through to substring scan
```

This is a standard `JSON.parse` in a try/catch. If the candidate is already well-formed JSON (e.g. the fenced block contained only JSON, no prose), this succeeds and returns immediately. The catch block does nothing — it intentionally falls through to the substring scan.

### The substring scan

```
start = candidate.search(/[[{]/)
end   = max(candidate.lastIndexOf(']'), candidate.lastIndexOf('}'))
if start >= 0 and end > start:
    return JSON.parse(candidate.slice(start, end + 1))
throw Error('no parseable json in agent output')
```

The `search(regex)` call returns the index of the first match of the character class `[[{]` — either `[` or `{`, whichever appears first. `lastIndexOf` finds the last occurrence of the closing bracket or brace. Slicing `[start, end + 1)` pulls out the substring that starts at the outermost bracket and ends at the outermost closing bracket.

Sample string to make the indices concrete:

```
"Here is the data: [{\"metric\":\"views\",\"scope\":[\"homepage\"]}] — done."
 0         1         2         3         4         5         6
 0123456789012345678901234567890123456789012345678901234567890123456789

start = 18   (index of '[')
end   = 52   (index of ']' from lastIndexOf)
slice(18, 53) = '[{"metric":"views","scope":["homepage"]}]'
```

`JSON.parse` on that slice succeeds.

### Structural validation

Parsing succeeds → value is `unknown`. TypeScript accepts `unknown` in no typed context without narrowing. The three type guards narrow by walking the actual fields at runtime.

`isAnomalyArray` is an `is` predicate — it returns `v is Anomaly[]`, which tells TypeScript the value is that type inside the `if` branch:

```
isAnomalyArray(v: unknown) returns v is Anomaly[]:
    return Array.isArray(v)
       AND v.every(a =>
              a != null
          AND typeof a == 'object'
          AND typeof a.metric == 'string'
          AND Array.isArray(a.scope)
          AND a.change != null
          AND typeof a.change.value == 'number'
          AND (a.change.direction == 'up' OR a.change.direction == 'down')
          AND typeof a.change.baseline == 'string'
          AND SEVERITIES.includes(a.severity)
          )
```

The guard is a chain of `AND` predicates. The moment any predicate is false, the language short-circuits and returns `false` without evaluating the rest — no try/catch needed.

`isDiagnosis` checks three fields: `conclusion` is a string, `evidence` is an array, `hypothesesConsidered` is an array. `isRecommendationArray` checks six fields per element including enum membership via `Array.includes`. One field, `estimatedImpact`, accepts a union shape: an `impactOk` check admits the value when it is EITHER a plain string (the legacy form) OR an object whose `range` is a string (the richer `{ range, rangeUsd?, assumption }` form) — so both encodings pass the guard.

### Step-by-step execution trace

**Input A: prose wrapping a fenced JSON block**

```
text = "Here are the anomalies:\n```json\n[{\"metric\":\"orders\",\"scope\":[\"checkout\"],\"change\":{\"value\":0.12,\"direction\":\"down\",\"baseline\":\"last 7 days\"},\"severity\":\"warning\"}]\n```\nLet me know if you have questions."
```

Step 1 — fenced regex:
```
fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
fence[0] = "```json\n[{...}]\n```"
fence[1] = "[{\"metric\":\"orders\",\"scope\":[\"checkout\"],\"change\":{\"value\":0.12,\"direction\":\"down\",\"baseline\":\"last 7 days\"},\"severity\":\"warning\"}]"
```

Step 2 — candidate:
```
candidate = fence[1].trim()
           = "[{\"metric\":\"orders\",\"scope\":[\"checkout\"],\"change\":{\"value\":0.12,\"direction\":\"down\",\"baseline\":\"last 7 days\"},\"severity\":\"warning\"}]"
```

Step 3 — bare parse:
```
JSON.parse(candidate)  →  succeeds
return value = [{metric:"orders", scope:["checkout"], change:{value:0.12,direction:"down",baseline:"last 7 days"}, severity:"warning"}]
```

Substring scan: never reached.

Step 4 — type guard (caller calls `isAnomalyArray`):
```
v = [{metric:"orders", scope:["checkout"], change:{...}, severity:"warning"}]

Array.isArray(v)                       → true
v[0] != null                           → true
typeof v[0] === 'object'               → true
typeof v[0].metric === 'string'        → true  ("orders")
Array.isArray(v[0].scope)              → true
v[0].change != null                    → true
typeof v[0].change.value === 'number'  → true  (0.12)
v[0].change.direction === 'down'       → true
typeof v[0].change.baseline === 'string' → true
SEVERITIES.includes(v[0].severity)    → true  ("warning" ∈ SEVERITIES)

isAnomalyArray(v) = true  →  v is now Anomaly[] inside caller's if-branch
```

---

**Input B: bare array embedded in prose (no fence)**

```
text = "The anomalies are [{\"metric\":\"clicks\",\"scope\":[\"homepage\"],\"change\":{\"value\":0.05,\"direction\":\"up\",\"baseline\":\"30d avg\"},\"severity\":\"info\"}] — that's everything."
```

Step 1 — fenced regex:
```
fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
fence = null   (no backticks in text)
```

Step 2 — candidate:
```
candidate = text.trim()
           = "The anomalies are [{...}] — that's everything."
```

Step 3 — bare parse:
```
JSON.parse(candidate)  →  throws SyntaxError  (leading prose before '[')
// catch block: fall through
```

Step 4 — substring scan:
```
start = candidate.search(/[[{]/)
      = 18   (index of '[' in "The anomalies are [")

end = Math.max(
        candidate.lastIndexOf(']'),   // index 89 (the ']' after the object)
        candidate.lastIndexOf('}')    // index 88
      )
    = 89

start >= 0 && end > start → true

candidate.slice(18, 90)
  = "[{\"metric\":\"clicks\",\"scope\":[\"homepage\"],\"change\":{\"value\":0.05,\"direction\":\"up\",\"baseline\":\"30d avg\"},\"severity\":\"info\"}]"

JSON.parse(slice)  →  succeeds
return value = [{metric:"clicks", scope:["homepage"], change:{value:0.05,direction:"up",baseline:"30d avg"}, severity:"info"}]
```

Step 5 — type guard:
```
isAnomalyArray(v):
Array.isArray(v)                         → true
v[0].metric === 'string'                 → true  ("clicks")
Array.isArray(v[0].scope)                → true
v[0].change.value is number              → true  (0.05)
v[0].change.direction === 'up'           → true
v[0].change.baseline is string           → true
SEVERITIES.includes("info")             → true

isAnomalyArray(v) = true
```

### The principle

Be liberal in what you accept from a model; be strict in what you trust. The extraction ladder handles realistic model output — formatted code fences, bare JSON, JSON buried in a sentence — without demanding a contract the model can't always keep. The type guard is where strictness kicks in: only a structurally correct value is admitted to typed downstream code.

The diagram in the next section is the primary recap.

---

## Extracting JSON from prose — diagram

```
 text: string
      │
      ▼
 ┌─────────────────────────────────────────┐
 │  fenced-block regex                     │
 │  /```(?:json)?\s*([\s\S]*?)```/i        │
 │                                         │
 │  match?  yes ──► candidate = fence[1]   │
 │          no  ──► candidate = text       │
 └──────────────────────┬──────────────────┘
                        │
                        ▼ candidate.trim()
 ┌─────────────────────────────────────────┐
 │  JSON.parse(candidate)                  │
 │                                         │
 │  ok  ──────────────────────────────────►│
 │  throw ──► fall through                 │
 └──────────────────────┬──────────────────┘
                        │ (only on throw)
                        ▼
 ┌─────────────────────────────────────────┐
 │  substring scan                         │
 │                                         │
 │  start = first index of [ or {          │
 │  end   = max(lastIndexOf(]), lastIndex(})│
 │                                         │
 │  ok  ──────────────────────────────────►│
 │  fail ──► throw Error                   │
 └──────────────────────┬──────────────────┘
                        │
                        ▼
                  parsed: unknown
                        │
                        ▼
 ┌─────────────────────────────────────────┐
 │  type guard (caller's responsibility)   │
 │                                         │
 │  isAnomalyArray(parsed)       → Anomaly[]            │
 │  isDiagnosis(parsed)          → Diagnosis             │
 │  isRecommendationArray(parsed)→ Omit<Recommendation,'id'>[] │
 │                                         │
 │  true  ──► trusted typed value          │
 │  false ──► reject / throw in caller     │
 └─────────────────────────────────────────┘
```

---

## Implementation in codebase

**File:** `lib/mcp/validate.ts`
**Function / class:** `parseAgentJson` + `isAnomalyArray` + `isDiagnosis` + `isRecommendationArray`
**Line range:** L3–L57

```ts
// lib/mcp/validate.ts  L3–L13
export function parseAgentJson(text: string): unknown {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fence ? fence[1] : text).trim();
  try { return JSON.parse(candidate); } catch { /* fall through to substring scan */ }
  const start = candidate.search(/[[{]/);
  const end = Math.max(candidate.lastIndexOf(']'), candidate.lastIndexOf('}'));
  if (start >= 0 && end > start) {
    return JSON.parse(candidate.slice(start, end + 1));
  }
  throw new Error('no parseable json in agent output');
}

// lib/mcp/validate.ts  L17–L27
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

GitHub: `https://github.com/rlynjb/blooming_insights/blob/main/lib/mcp/validate.ts`

---

## Elaborate

### Where it comes from

This pattern has a name: **Postel's law** (the robustness principle) — "be conservative in what you send, be liberal in what you accept." Applied to LLM output: you can't force a hosted model to return machine-readable JSON on every call (especially with streaming or older prompt-only APIs), so you accept whatever it writes and extract the structure yourself. The technique is also called **structured-output extraction** in the LLM tooling literature — distinct from constrained decoding, which prevents the problem at generation time.

The `is` predicate pattern (`function isAnomalyArray(v: unknown): v is Anomaly[]`) is standard TypeScript for runtime type narrowing — identical to what you'd write to validate data from `fetch()` before rendering it.

### The deeper principle

```
 model output (text)
         │
         ▼
 ┌───────────────────┐         liberal
 │  extraction ladder│  ◄──── accept any
 │  (forgiving)      │         plausible
 └────────┬──────────┘         encoding
          │
          ▼
   parsed: unknown
          │
          ▼
 ┌───────────────────┐         strict
 │  type guard       │  ◄──── trust only
 │  (exact fields)   │         exact shape
 └───────────────────┘
```

Liberal at the boundary, strict at the gate.

### Where it breaks down

The substring scan uses the **outermost** brackets. If the prose before the real JSON contains a stray `{` — for example: `"Use {curly braces}. Here is the data: [{...}]"` — `start` points to the stray `{`, not the opening bracket of the array. `JSON.parse` on that slice fails, and the function throws even though a valid JSON array was present.

The guards are hand-written. Each new field on `Anomaly`, `Diagnosis`, or `Recommendation` requires a matching check inside the guard — there is no schema that keeps itself in sync. A field rename in the type definition does not break the guard at compile time.

### What to explore next

- **Tool/function-calling JSON mode** — Anthropic's tool-use API and OpenAI's function-calling API both let you declare a JSON schema; the model is constrained to emit conforming JSON. No extraction ladder needed.
- **Zod** — a TypeScript-first schema validation library. Define the schema once; get parsing, coercion, and a type-narrowed result. Replaces the hand-written guards and adds coercion (e.g. string → number).
- **Constrained decoding** — grammar-guided sampling (e.g. Outlines, llama.cpp GBNF grammars) forces the model's token choices to produce valid JSON at generation time, eliminating the problem entirely for self-hosted models.

---

## Interview defense

### What they're really asking

When an interviewer asks about extracting JSON from LLM output, they are testing: do you know how `JSON.parse` fails, what a type guard is, and why "the model returned JSON" is not the same as "you have a trusted typed value"? Senior questions layer in: what does Postel's law cost you, and when would you replace the extraction ladder with a schema library or constrained output mode?

### Q&A

**[mid] "Walk me through what happens when `JSON.parse(text)` throws on agent output."**

The raw text from the agent contains markdown, punctuation, and English around the JSON. `JSON.parse` is a strict parser — it fails on any non-JSON prefix. You catch the exception, then attempt a recovery strategy: locate the outermost bracket pair and parse only that slice. If the slice parses, you have your value. If not, you surface a clear error.

```
text: "The data is [{...}] — let me know!"
           │
           JSON.parse(text)  →  SyntaxError (leading 'T')
           │
           search for first [ or {  →  index 12
           lastIndexOf(])           →  index 18
           slice(12, 19)            →  "[{...}]"
           JSON.parse(slice)        →  [{...}]  ✓
```

**[senior] "The parsed value is `unknown`. Why does that matter, and how do you handle it?"**

`JSON.parse` returns `any` in TypeScript's standard lib, which means the compiler will not catch field access on a non-existent key. If you type the result as `unknown` (or treat it as such), the compiler forces you to narrow the type before using it. An `is` predicate is the idiomatic way to do that narrowing at runtime. Without it, a malformed value from the model flows into typed code with no error.

```
function isAnomalyArray(v: unknown): v is Anomaly[] {
  // walks every required field at runtime
  return Array.isArray(v) && v.every((a) => typeof a.metric === 'string' && ...)
}

if (isAnomalyArray(parsed)) {
  // TypeScript narrows parsed to Anomaly[] here
  // downstream code is typed
}
```

**[arch] "This extraction ladder is fragile — stray braces in prose break the scan. What would you replace it with, and what does the replacement cost?"**

Two options, each eliminating the problem at a different layer:

```
 Option A: Zod schema                    Option B: structured output / tool-call mode
 ┌──────────────────────┐                ┌──────────────────────────────────┐
 │ model still returns  │                │ declare tool schema in API call  │
 │ text prose           │                │ model emits tool_use block        │
 │                      │                │ no extraction needed              │
 │ extraction ladder    │                │                                  │
 │  → still needed      │                │ model must support tool-call mode │
 │                      │                │ prompt + call site changes        │
 │ Zod replaces guards  │                │                                  │
 │  → schema = source   │                │ zero extraction code              │
 │    of truth          │                │ Zod optional but natural          │
 └──────────────────────┘                └──────────────────────────────────┘
```

Option A (Zod) removes guard maintenance but not extraction fragility. Option B (structured output) removes both — the model's token space is constrained to valid JSON conforming to the schema. The cost of B is coupling to the tool-call API, restructuring the prompt, and losing the ability to use non-conformant models or streaming text mode without a rework.

### The dodge

**"Why not force the model to return clean JSON with a tool/JSON mode instead of scraping prose?"**

Honest answer: you can, and for greenfield work it is the better default. Anthropic's tool-use API constrains the model to emit a `tool_use` content block with a structured input — no regex needed. This codebase uses text prompts that ask for JSON rather than declaring a tool schema, which gives the implementation flexibility (works with any model, any streaming mode) but pushes the extraction burden onto the client.

```
 Tool/JSON mode (ideal)          Text + extraction (current)
 ┌──────────────────┐            ┌──────────────────────────┐
 │ declare schema   │            │ prompt: "respond in JSON" │
 │ in API call      │            │                          │
 │                  │            │ extraction ladder        │
 │ model: tool_use  │            │  → regex                 │
 │ block (JSON)     │            │  → bare parse            │
 │                  │            │  → substring scan        │
 │ no extraction    │            │                          │
 │ type guard still │            │ type guard               │
 │ advisable        │            │                          │
 └──────────────────┘            └──────────────────────────┘
```

The extraction approach works and has zero migration cost. It becomes a liability when shapes grow or the team inherits it without context.

### Code anchors

- `lib/mcp/validate.ts` L4 — fenced-block regex
- `lib/mcp/validate.ts` L5 — candidate selection
- `lib/mcp/validate.ts` L6 — bare parse try/catch
- `lib/mcp/validate.ts` L7–L12 — substring scan + throw
- `lib/mcp/validate.ts` L17–L27 — `isAnomalyArray` is-predicate

---

## Validate your understanding

**Level 1 — Reconstruct**

Without looking at the file, describe the three extraction attempts in `parseAgentJson` in order. For each: what it tries, what input makes it succeed, and what it does on failure.

**Level 2 — Explain**

`isAnomalyArray` in `lib/mcp/validate.ts` (L17–L27) checks `SEVERITIES.includes((a as any).severity)`. Explain why this check is necessary even after `JSON.parse` succeeds. What is the return type annotation `v is Anomaly[]`, and what does it enable in the caller's code? What would happen if you removed the guard and cast the result directly to `Anomaly[]`?

**Level 3 — Apply**

The model returns: `"I found two issues. {\"type\":\"summary\"} Here is the real list: [{\"metric\":\"sessions\",\"scope\":[\"landing\"],\"change\":{\"value\":0.08,\"direction\":\"down\",\"baseline\":\"7d avg\"},\"severity\":\"warning\"}] Done."` — no fence markers, and there is a stray `{}` before the array.

Trace `parseAgentJson` on this input step by step. What does `candidate.search(/[[{]/)` return? What does `lastIndexOf(']')` return? What does `slice(start, end + 1)` contain? Does `JSON.parse` on that slice succeed? Cite `lib/mcp/validate.ts` L7–L10 in your answer.

After `parseAgentJson` returns, what does `isAnomalyArray(result)` return, and why? Walk `lib/mcp/validate.ts` L18–L26 for the single array element.

**Level 4 — Defend**

A teammate argues: "We should replace `parseAgentJson` with Zod's `z.array(AnomalySchema).parse(result)` after JSON.parse." Evaluate this. What does Zod solve that the current guards do not? What does it not solve? Under what conditions would you recommend the change?

**Quick check**

- The regex `/```(?:json)?\s*([\s\S]*?)```/i` — why `[\s\S]` instead of `.`? What does the `?` after `*` do?
- If `fence` is non-null, what is `fence[1]`? What is `fence[0]`?
- `candidate.search(/[[{]/)` returns `-1` if there is no bracket. What does the guard `start >= 0 && end > start` prevent?
- An `is` predicate returns `boolean`. What does the `: v is Anomaly[]` annotation add over just returning `boolean`?
- `isRecommendationArray` accepts `estimatedImpact` in two shapes. Name both. (Cite `lib/mcp/validate.ts` L46–L48.)

## See also

→ ../01-system-design/06-multi-agent-orchestration.md · → 05-severity-sort.md

---
Updated: 2026-05-28 — refreshed code references to current line numbers; noted that `isRecommendationArray` now accepts `estimatedImpact` as either a string or a `{ range, ... }` object (the `impactOk` union check)
Updated: 2026-05-30 — Migrated to study.md v1.47 template (Phase 1+2 mechanical): removed Tradeoffs / Tech reference / Summary sections; renamed "In this codebase" → "Implementation in codebase"; moved See also to a bottom block. "Why care" preserved pending Phase 3 (Zoom out, then zoom in + LAYERS diagram) authoring.
Updated: 2026-05-30 — Phase 3 of study.md v1.47 migration: replaced "Why care" block with "Zoom out, then zoom in" (LAYERS diagram + zoom-in paragraph) per format.md.
Updated: 2026-05-31 — Applied study.md v1.48: scrubbed "How it works" of file paths, line refs, and real-code fences; replaced with generic role labels + pseudocode per format.md. Codebase-specific anchoring lives exclusively in "Implementation in codebase".
Updated: 2026-05-31 — Applied study.md v1.50: added Structure pass block (layers · axis · seams) between Zoom out and How it works per format.md's new Block 3.
Updated: 2026-05-31 — Applied study.md v1.52 voice trait (verdict first, then rank what matters) — clarity edits to Move 2.
