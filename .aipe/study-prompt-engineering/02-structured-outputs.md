# 02 · Structured outputs via tool calling and schemas

**Structured output / tool calling / typed model boundary — Industry standard**

## Zoom out, then zoom in

Structured output is the contract at the model boundary. Everything else in your app assumes a shape — `Diagnosis.conclusion` is a string, `Recommendation.bloomreachFeature` is one of five enum values, `steps` is an array. When that contract breaks, you get a stack trace three functions deep in a component that has no idea it's downstream of an LLM. Structured output is how you make that stack trace impossible.

```
  Zoom out — where structured output sits

  ┌─ UI (React) ─────────────────────────────────────────┐
  │  <EvidencePanel diagnosis={diagnosis} />              │
  │  reads diagnosis.conclusion (string)                  │
  │  reads diagnosis.evidence[] (array)                   │
  └────────────────────────┬─────────────────────────────┘
                           │  TypeScript type: Diagnosis
  ┌─ Streaming route ──────▼─────────────────────────────┐
  │  /api/agent NDJSON writer                            │
  │  emits { type:'diagnosis', diagnosis: Diagnosis }    │
  └────────────────────────┬─────────────────────────────┘
                           │
  ┌─ Validator ────────────▼─────────────────────────────┐
  │  isDiagnosis(parsed)  ← lib/mcp/validate.ts:29        │
  │  gate → drops malformed model output                 │
  └────────────────────────┬─────────────────────────────┘
                           │
  ┌─ Parser ───────────────▼─────────────────────────────┐
  │  parseAgentJson(text)  ← lib/mcp/validate.ts:3        │
  │  strips ```json fences, best-effort substring scan   │
  └────────────────────────┬─────────────────────────────┘
                           │
  ┌─ ★ STRUCTURED OUTPUT SEAM ★ ─▼──────────────────────┐
  │  Model returns text; prompt asks for JSON in a fence │  ← we are here
  │  Contract lives in the prompt AND in the validator   │
  └──────────────────────────────────────────────────────┘
```

**Zoom in.** Modern structured output has three approaches: (1) native tool calling — the model returns a tool call whose input schema *is* the output schema; (2) `response_format` / JSON mode — the provider enforces valid JSON server-side; (3) prompt-and-validate — the prompt asks for a shape and your code validates the parse. This codebase uses approach (3) with a `parseAgentJson` → `isDiagnosis` gate. The reason it's not (1) is that the agent's *actual* tool calls are analytics queries (`execute_analytics_eql`), not schema emissions. The output is the *result* of the loop, not a tool call. Approach (3) is fine for that shape as long as the validator is real.

## Structure pass

### Axes — the dimension we're tracing

**Where does the contract live?** For structured output, this is *the* question. In (1) it lives at the provider (schema is enforced before the response returns). In (2) it lives at the provider but weaker — JSON is guaranteed but shape isn't. In (3) it lives in your validator, entirely on your side.

### Seams — where the contract flips

Two load-bearing seams:

- **Model → parser** — the text-to-JSON boundary. Everything before is unstructured; everything after should be structured. This is where the "model wrapped it in a markdown fence" bug lives.
- **Parser → validator** — the JSON-to-typed boundary. `parseAgentJson` returns `unknown`; `isDiagnosis` narrows to `Diagnosis`. Without the validator, `unknown` leaks into the app as `any` and breaks something three components downstream.

### Layered decomposition

"Who catches malformed output?" traced down the stack:

```
  "Who catches malformed output?" — same question, three altitudes

  ┌─────────────────────────────────────────┐
  │ outer: the UI component                  │  → nobody. It crashes.
  └─────────────────────────────────────────┘
      ┌─────────────────────────────────────┐
      │ middle: the validator                │  → this layer.
      │        (isDiagnosis)                 │  Returns false; caller rethrows.
      └─────────────────────────────────────┘
          ┌─────────────────────────────────┐
          │ inner: the parser               │  → JSON.parse throws
          │        (parseAgentJson)         │  on malformed JSON;
          │                                 │  caller catches.
          └─────────────────────────────────┘
```

The lesson: catching malformed output is *always* the validator's job, not the UI's job. If the UI is catching it, you don't have structured output — you have a contract that isn't enforced.

## How it works

### Move 1 — the mental model

You know how a TypeScript function signature turns "this returns something" into "this returns a specific shape the compiler will yell about" — same idea. Structured output turns "the model returns text" into "the model returns a value that satisfies a shape, and if it doesn't, my code refuses to move forward."

```
  Structured output — the shape at the boundary

  ┌─ prompt ─────────┐   ┌─ model ──────┐   ┌─ parser ─┐   ┌─ validator ─┐   ┌─ app ──┐
  │ "Return ONLY JSON│──▶│ generates    │──▶│ strips   │──▶│ narrows to  │──▶│ typed  │
  │  in this shape:  │   │ text with    │   │ ``` json │   │ Diagnosis   │   │ safely │
  │  { conclusion,   │   │ JSON in it   │   │ fence    │   │ or REJECTS  │   │        │
  │    evidence,     │   │              │   │          │   │             │   │        │
  │    hypotheses}"  │   └──────────────┘   └──────────┘   └─────────────┘   └────────┘
  └──────────────────┘                                           │
                                                                  │ fail → throw
                                                                  ▼
                                                          caller gets error,
                                                          not corrupt data
```

The contract lives in three places at once: the prompt (asks for the shape), the parser (extracts it from the model's response), the validator (proves the extracted thing satisfies the shape). Miss any one and the contract has a hole.

### Move 2 — the step-by-step walkthrough

**Step 1 — declare the shape in the prompt.**

The prompt names the exact fields. From `@aptkit/prompts/dist/src/diagnostic.js:26-38`:

```js
Return ONLY a JSON object in a \`\`\`json fenced block with this shape:

{
  "conclusion": "string",
  "evidence": ["string"],
  "hypothesesConsidered": [
    { "hypothesis": "string", "supported": true, "reasoning": "string" }
  ],
  "affectedCustomers": { "count": 0, "segmentDescription": "string" },
  "timeSeries": [{ "day": "w-3", "value": 0 }]
}

Omit affectedCustomers or timeSeries when you cannot support them from observed data.
```

Two things worth noting. First, the shape is shown as *literal JSON in the prompt*, not described in prose. "The model should return a conclusion field" is far weaker than showing the model the actual `{ "conclusion": "string", ... }` — the model pattern-matches the example. Second, the fence: `\`\`\`json` is the delimiter the parser looks for. If you don't ask for the fence, the model sometimes emits raw JSON, sometimes JSON-wrapped-in-prose. Asking for the fence is asking for a predictable delimiter.

**Step 2 — parse the fence.**

`lib/mcp/validate.ts:3-13`:

```ts
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
```

Two-layer fallback. Try the fence first (the happy path). If no fence, try substring-scan for the outermost `[...]` or `{...}` (the "model was courteous and skipped the fence" path). Either way, the result is `unknown`. That `unknown` is deliberate — the next step is what narrows.

```
  parseAgentJson — the two-layer fallback

  input text
    │
    ▼
  ┌─ regex match ```json … ``` ─┐
  │  match?                      │──yes──▶ JSON.parse(match[1])
  └──────────────────────────────┘
    │ no
    ▼
  ┌─ substring [ or { … ] or } ──┐
  │  bracket span?                │──yes──▶ JSON.parse(span)
  └──────────────────────────────┘
    │ no
    ▼
  throw 'no parseable json'
```

**Step 3 — validate the shape.**

`lib/mcp/validate.ts:29-35`:

```ts
export function isDiagnosis(v: unknown): v is Diagnosis {
  if (!v || typeof v !== 'object') return false;
  const d = v as any;
  return typeof d.conclusion === 'string'
    && Array.isArray(d.evidence)
    && Array.isArray(d.hypothesesConsidered);
}
```

Three field checks. Not exhaustive — no per-hypothesis shape check, no evidence-item type check. This is deliberate: the validator draws the line at "the fields my UI reads exist and are the right kind." Everything the UI doesn't touch is allowed to drift. That's the working-engineer's tradeoff: full-schema validation (Zod / Pydantic) is stricter but every field you add is a place a real model output might legitimately vary. Blooming validates the load-bearing three and lets the rest pass through.

**Step 4 — the retry story (where this codebase is honest about a gap).**

Modern production pattern: on schema fail, re-ask with a stricter system prompt. Blooming does *not* implement this today. Look at `parseAgentJson` — it throws. The caller (`AptKitDiagnosticInvestigationAgent`) does have a `recoveryPrompt` for the ReAct loop's tool-use recovery, but there's no re-ask-on-schema-fail loop specifically for output parsing. The unstated assumption is that Sonnet 4.6 produces well-formed JSON reliably enough that the retry path isn't paying for itself. That's a bet, and it's a defensible one — the observed schema-fail rate in receipts is near zero. But when Sonnet 4.7 ships and the fail rate ticks up, this is the seam where the retry loop lands.

```
  Comparison — with retry vs without retry

  Without retry (current)              With retry (production hardening)
  ─────────────────                    ──────────────────────
   model out                             model out
     │                                     │
     ▼                                     ▼
   parseAgentJson                        parseAgentJson
     │                                     │
     ▼                                     ▼
   isDiagnosis                           isDiagnosis
     │                                     │
     ├─ ok → return                        ├─ ok → return
     └─ throw → 500                        └─ fail →
                                              ├─ attempt < N ?
                                              │    re-ask model
                                              │    with stricter
                                              │    system prompt
                                              └─ else → throw
```

**Step 5 — where the model gets courteous and this all breaks.**

The specific bug every production prompt engineer has debugged at least once: a prompt that used to work suddenly starts wrapping the JSON in a markdown code fence *and* prefacing it with "Here's the diagnosis you asked for:". The parser was matching `` ```json ... ``` `` cleanly, so the fence isn't the issue. The issue is the preface text — if the model emits both a preface *and* a fence, `parseAgentJson`'s fence-first branch still works. But if the model skips the fence and just prefaces, the substring-scan fallback picks up a `[` or `{` from somewhere in the preface (say, a bracket in an example the model quoted) and JSON.parse fails on a truncated span.

Fix: tighten the prompt to include an explicit "no preface, no explanation, JSON only" instruction. In this codebase, the "Return ONLY a JSON object in a \`\`\`json fenced block" line is doing exactly that job. The word `ONLY` is load-bearing.

### Move 3 — the principle

**Structured output is a three-place contract, not a one-place instruction.** The shape lives in the prompt (asks), the parser (extracts), the validator (proves). Instructions in the prompt alone are wishes; validators alone catch malformed but don't shape generation; parsers alone tolerate unpredictable model behavior instead of constraining it. All three, together, are the contract.

## Primary diagram

```
  Structured output — the full contract

  ┌── the prompt ─────────────────────────────────────────┐
  │  "Return ONLY a JSON object in a ```json fenced       │
  │   block with this shape: { conclusion, evidence,      │
  │   hypothesesConsidered, ... }"                        │
  └────────────────────────┬──────────────────────────────┘
                           │
  ┌── model ───────────────▼──────────────────────────────┐
  │   assistant: ```json                                  │
  │              {"conclusion":"payment processor …",     │
  │               "evidence":["…"],                       │
  │               "hypothesesConsidered":[…]}             │
  │              ```                                      │
  └────────────────────────┬──────────────────────────────┘
                           │
  ┌── parseAgentJson ──────▼──────────────────────────────┐
  │  1. regex fence → match                               │
  │  2. JSON.parse(match[1]) → unknown                    │
  │  fallback: substring scan for outer [ or {            │
  │  fallback: throw                                      │
  │  lib/mcp/validate.ts:3-13                             │
  └────────────────────────┬──────────────────────────────┘
                           │ unknown
  ┌── isDiagnosis ─────────▼──────────────────────────────┐
  │  type guard — narrows unknown to Diagnosis            │
  │  fields checked: conclusion, evidence,                │
  │                  hypothesesConsidered                 │
  │  lib/mcp/validate.ts:29-35                            │
  └────────────────────────┬──────────────────────────────┘
                           │ Diagnosis (typed)
  ┌── consumer ────────────▼──────────────────────────────┐
  │  <EvidencePanel diagnosis={diagnosis} />              │
  │  reads .conclusion, .evidence[], .hypotheses          │
  │  safely — the contract held                           │
  └───────────────────────────────────────────────────────┘
```

## Elaborate

Three modern approaches, in order of strictness:

**Native tool calling (strictest).** The provider (Anthropic, OpenAI) accepts a tool definition with an `input_schema` (JSON Schema). The model's response is guaranteed to satisfy the schema — if it can't, the provider retries internally before returning. Use when your agent's output *is* an action call (search this database, book this appointment). Not the right fit for Blooming's diagnosis output, which is the *result* of a loop, not a call the model wanted to make.

**JSON mode / response_format (medium).** The provider guarantees valid JSON but not shape. Anthropic doesn't have a first-class JSON mode; OpenAI does. Use when you want no markdown wrappers, no preface text, no fence trimming — just a JSON blob. Shape validation is still on you.

**Prompt-and-validate (what Blooming does).** The prompt describes the shape, you parse and validate. Cheapest to implement, easiest to iterate on the shape without provider round-trips, works across every provider. The tradeoff is you carry the schema-fail retry logic yourself if you want it, and you tolerate a tiny malformed-output rate at the boundary.

The specific choice you make matters less than *having* a validator. I've seen prompt-and-validate systems ship for two years with zero schema-fail incidents because the validator was the discipline. I've seen "we use OpenAI JSON mode so we don't need to validate" systems ship a bug where the model returned `{"result": [null]}` and the UI crashed on `.result.length` — JSON was valid, shape wasn't. Validation is non-negotiable regardless of which of the three approaches you pick.

Related concepts:
- **Prompts as code** (`03-prompts-as-code.md`) — the schema section is the most reviewed part of the prompt.
- **Output mode mismatch** (`07-output-mode-mismatch.md`) — the failure mode where two chains disagree about what "structured" means.
- **Eval-driven iteration** (`05-eval-driven-iteration.md`) — the eval catches schema-fail regressions across model versions.

## Interview defense

**Q: The model just returned JSON wrapped in a markdown code fence. What do you do?**

Two answers, one is right for demos and the wrong one for production. In a demo, you strip the fence in a one-liner and move on. In production, you look at *why* the fence is there — usually because the prompt said "return JSON" without saying "return ONLY JSON, no fence, no preface." Then you fix the prompt to be explicit, add a fence-tolerant parser (`parseAgentJson` in this codebase — matches `\`\`\`json` fence first, falls back to substring scan) so the next drift doesn't break you, and add a test case to the eval set with a fenced expected input so you catch the reverse drift when the model stops fencing.

```
  parser strategy — two-layer defense

  strict fence match   ─── happy path
        │ miss
        ▼
  substring bracket scan ─── graceful degrade
        │ miss
        ▼
  throw                 ─── loud fail, caller decides
```

Anchor: `parseAgentJson` at `lib/mcp/validate.ts:3-13`.

**Q: When is tool calling the right structured-output approach, and when isn't it?**

Right when the output IS an action — book this, search that. Wrong when the output is the *result* of the agent's reasoning. In this codebase the diagnostic agent uses tool calling for its analytics queries (which ARE actions — call this MCP tool with these args) but returns its final diagnosis as JSON-in-a-fence, because the diagnosis is a report, not a call. Forcing the diagnosis through tool calling would mean defining a `submit_diagnosis` tool whose only job is to be the return channel, and you'd be paying for the extra tool-call round-trip to say something the model was already going to say in its final text.

```
  when to reach for which

  output IS an action      →  tool calling with input_schema
  output IS a report        →  JSON-in-fence + validator
  output is a boolean flag  →  tool calling OR JSON mode
  output is free-form prose →  don't structure it
```

**Q: What's the load-bearing part people forget?**

The validator. Everyone remembers the prompt (they wrote it) and the parser (they debugged it once). The validator is skipped in "we'll just cast to `Diagnosis`" mode. Six months later a model upgrade changes the emission shape subtly — say `hypothesesConsidered` becomes `hypothesesConsidered` sometimes and `hypotheses` other times — and the UI crashes on `.hypothesesConsidered.length`. The validator is what makes that crash *impossible* — `isDiagnosis(x)` returns false, the caller throws a controlled error, and the UI shows a "model output was malformed" state instead of a stack trace.

Anchor: `isDiagnosis` at `lib/mcp/validate.ts:29-35`.

## See also

- `01-anatomy.md` — the schema section of the prompt anatomy.
- `03-prompts-as-code.md` — versioning schema changes safely.
- `05-eval-driven-iteration.md` — catching structured-output regressions across model versions.
- `07-output-mode-mismatch.md` — the failure mode this concept prevents.
