# 02 — Structured outputs via tool calling and schemas

*Schema-constrained generation · Industry standard*

## Zoom out, then zoom in

Structured outputs live at the seam between the model and the rest of your code. Pull up where that seam sits.

```
  Where structured-output validation sits in the system

  ┌─ UI ──────────────────────────────────────────────────────────┐
  │  InsightCard renders Anomaly[].map(...)                        │
  │  EvidencePanel reads Diagnosis.conclusion + .evidence          │
  └────────────────┬───────────────────────────────────────────────┘
                   │ typed TypeScript objects
  ┌─ Route handler ▼ ─────────────────────────────────────────────┐
  │  insights state ← await agent.scan()                            │
  └────────────────┬───────────────────────────────────────────────┘
                   │
  ┌─ Agent ▼ ─────────────────────────────────────────────────────┐
  │  ★ STRUCTURED OUTPUT BOUNDARY ★                                │ ← we are here
  │  • prompt says "return ONLY JSON in a ```json fence"            │
  │  • parser extracts JSON                                         │
  │  • validator (type guard) confirms shape                        │
  │  • on fail: ONE forced-final synthesis turn, then fallback      │
  └────────────────┬───────────────────────────────────────────────┘
                   │ free-form model text — anything goes
  ┌─ Anthropic API ▼ ─────────────────────────────────────────────┐
  │  claude-sonnet-4-6 — text in, text out (could be anything)      │
  └────────────────────────────────────────────────────────────────┘
```

The model returns text. Your downstream code wants typed objects. The structured-output layer is what bridges the two, and it's the single most production-failure-prone seam in any LLM application. Get it wrong and one polite "let me wrap that in a markdown fence for you" from the model takes the whole feature down.

## Structure pass

**Layers.** Outer: prompt says "return JSON". Middle: parser extracts the JSON candidate. Innermost: type guard validates the shape. Each layer can fail.

**Axis — what kind of failure each layer catches.** Walk it down:

```
  one axis — "what failure does this layer catch?" — three layers, three answers

  ┌─ layer 1: prompt instruction ──────┐
  │  catches: model deciding to chat   │  "Return ONLY JSON in a ```json fence."
  └────────────────────────────────────┘
       ┌─ layer 2: parser (parseAgentJson) ─┐
       │  catches: markdown fences, prose    │  matches ```json blocks, falls back
       │  prefixes, multiple JSON candidates │  to first [ or { in the text
       └────────────────────────────────────┘
            ┌─ layer 3: type guard (isAnomalyArray) ─┐
            │  catches: wrong shape, missing fields,  │  returns boolean; on false,
            │  bad enum values                        │  agent treats as empty array
            └────────────────────────────────────────┘
```

**Seams.** The prompt-to-parser seam is the JSON fence (`` ```json ``). The parser-to-validator seam is the type guard. Both seams are load-bearing — strip either and the whole boundary collapses.

## How it works

### Move 1 — the mental model

You know how a fetch response can be `await res.json()` and you trust it to throw on bad JSON? Structured outputs are *the same shape* — you ask for JSON, you parse it, you validate it. The difference is the source: instead of an HTTP server enforcing the contract, you've got a probabilistic text model whose entire job is to *politely respond*, and politeness is precisely what breaks the parser.

```
  The structured-output pattern — three layers, each one fails differently

  prompt rule       ──►  parser (regex/JSON.parse)  ──►  type guard (boolean)
       │                          │                            │
       ▼                          ▼                            ▼
  "model decides     "find JSON candidate, parse it"   "shape matches schema?"
   to return JSON"
       │                          │                            │
  fail mode:                  fail mode:                  fail mode:
  model returns prose         model returns malformed     model returns valid JSON
  ("Sure! Here is...")        JSON or wraps it in         in the wrong shape
                              markdown
```

Three layers. Each one has a real production failure mode. The whole pattern depends on all three being present.

### Move 2 — the walkthrough

**Layer 1 — the prompt instruction.** Look at `legacy-prompts/monitoring.md:70-73`:

```
## Output

Return ONLY a JSON array of anomaly objects, at most 10 items, sorted by
severity (critical → warning → info → positive), wrapped in a ```json fenced block:
```

Two pieces of leverage here. *"Return ONLY a JSON array"* — the ONLY is doing real work; it raises the bar against the model's instinct to add a courtesy preamble ("Here are the anomalies I found:"). *"wrapped in a ```json fenced block"* — this is *the* explicit shape contract, and the parser in layer 2 is built around finding it.

The follow-up at `legacy-prompts/monitoring.md:96-97`:

```
If nothing meaningful is found, return `[]`.
```

This is the empty-state escape valve. Without it, the model invents anomalies to fill the array. With it, the model has a sanctioned way to say "nothing here" without breaking the contract.

**Layer 2 — the parser.** `lib/mcp/validate.ts:3-13`:

```typescript
export function parseAgentJson(text: string): unknown {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fence ? fence[1] : text).trim();
  try { return JSON.parse(candidate); } catch { /* fall through */ }
  const start = candidate.search(/[[{]/);
  const end = Math.max(candidate.lastIndexOf(']'), candidate.lastIndexOf('}'));
  if (start >= 0 && end > start) {
    return JSON.parse(candidate.slice(start, end + 1));
  }
  throw new Error('no parseable json in agent output');
}
```

Step by step:

  → **First attempt: extract from a fence.** Regex finds ```` ```json ... ``` ```` and pulls the body.
  → **Second attempt: parse the whole candidate.** If the fence body is the JSON, this works.
  → **Third attempt: substring scan.** Find the first `[` or `{`, the last `]` or `}`, parse the slice. This is the *forgiving* fallback — handles "Here's the JSON: [...]" where the model added prose around it.
  → **Give up: throw.** Caller decides the fallback.

This is layered defense — three parse strategies, in order of strictness, because real model outputs in production drift. The strictest one works in 99% of cases; the loose substring scan rescues the rest.

**Layer 3 — the type guard.** `lib/mcp/validate.ts:17-27`:

```typescript
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

A TypeScript user-defined type guard. Boolean return; on `true`, the caller now has `Anomaly[]` typed. On `false`, the caller treats the whole batch as invalid. Note what it does NOT do — it doesn't repair, doesn't fill missing fields, doesn't coerce types. The model either returned the right shape or it didn't.

**The whole pipeline.** Layers-and-hops view, layer 1 → layer 3:

```
  Layers-and-hops — structured output, agent layer

  ┌─ Anthropic API ─────────────────────────────┐
  │  returns Message with TextBlock[]            │
  └──────────────┬──────────────────────────────┘
                 │ hop 1: finalText = textBlocks.join('')
  ┌─ Agent loop ▼ ──────────────────────────────┐
  │  text candidate                              │
  └──────────────┬──────────────────────────────┘
                 │ hop 2: parseAgentJson(finalText)
  ┌─ Parser ▼ ──────────────────────────────────┐
  │  unknown (parsed JSON value)                 │
  └──────────────┬──────────────────────────────┘
                 │ hop 3: isAnomalyArray(parsed)
  ┌─ Type guard ▼ ──────────────────────────────┐
  │  Anomaly[] OR [] (treat as no anomalies)     │
  └──────────────┬──────────────────────────────┘
                 │ hop 4: sort by severity, slice(0, 10)
  ┌─ Caller (route handler) ────────────────────┐
  │  Anomaly[] streamed to UI                    │
  └─────────────────────────────────────────────┘
```

Look at the call site at `lib/agents/monitoring-legacy.ts:128-136`:

```typescript
let parsed: unknown;
try {
  parsed = parseAgentJson(finalText);
} catch {
  return [];
}
if (!isAnomalyArray(parsed)) return [];
return [...parsed].sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity]).slice(0, 10);
```

Both fail modes — parse throws, guard returns false — collapse to the same fallback: `return []`. The UI shows "no anomalies found" instead of a 500. Graceful degradation at the boundary is the second-most important property of this pattern (the first is having the boundary at all).

**The diagnostic agent adds one more layer: the forced-final synthesis turn.** When the agent loop exhausts its tool-call budget, the model often wants to "keep querying" instead of emitting JSON. `lib/agents/diagnostic-legacy.ts:79-101`:

```typescript
recoveryPrompt: (tc: ToolCall[]) => {
  const evidence = tc.map(...).join('\n\n') || '(no successful queries...)';
  return (
    `Anomaly investigated:\n${JSON.stringify(anomaly)}\n\n` +
    `Queries run and their results:\n${evidence}\n\n` +
    'Based ONLY on the evidence above, output your best-supported diagnosis ' +
    'as a single JSON object in a ```json fence: ' +
    '{"conclusion": string, "evidence": string[], "hypothesesConsidered": [...]}.'
  );
},
```

One additional tool-less Claude call. No tools available, model must emit text, evidence handed back as context. This is the *recovery* — the loop already ran, the model already saw the data, this call only asks "give me the JSON now, please." Concept 06 walks this pattern in more detail.

**The specific bug — courteous markdown wrapping.** This is the one every production engineer hits. You ask for JSON. You get this back:

```
Sure! Here's the analysis:

```json
{"conclusion": "..."}
```

Let me know if you need anything else!
```

The model is *correctly* returning JSON, but it's wrapped in chat-tone padding. The fenced-block extraction in layer 2 handles it — that's why the parser regex is built around `` ```json ... ``` ``. If you assume the model returns raw JSON and call `JSON.parse(text)` directly, this fails. Production engineers don't trust raw `JSON.parse`. The fence extraction is the defense.

**The other specific bug — schema mode + "be concise."** Some providers offer a strict JSON mode (`response_format: { type: 'json_object' }` for OpenAI). It's tempting to add "and please be concise" to the prompt. The model — being courteous — returns the schema-conformant JSON *inside* a markdown code fence as a "courtesy" because concise is conversational. The parser breaks. The fix: never add tone instructions to a structured-output prompt; never ask for "natural-sounding JSON."

### Move 3 — the principle

Structured output at the LLM boundary is the same problem as input validation at any service boundary. The contract is "I will give you typed data"; the validation enforces it. The probabilistic source (the model) doesn't change the principle — it raises the stakes. Every production engineer who has shipped LLM features has the same defensive structure: prompt instruction + extraction + type guard + graceful fallback. Skip any layer and the seam will bite.

## Primary diagram — full structured-output pipeline

```
  ┌─ Section 1: PROMPT INSTRUCTION ─────────────────────────────────────┐
  │  "Return ONLY a JSON array ... wrapped in a ```json fenced block"    │
  │  "If nothing meaningful is found, return `[]`"                        │
  └─────────────────────────┬───────────────────────────────────────────┘
                            │ model text (can drift)
  ┌─ Section 2: PARSER ─────▼───────────────────────────────────────────┐
  │  lib/mcp/validate.ts:parseAgentJson                                  │
  │  1. regex extract ```json…``` body                                    │
  │  2. JSON.parse the body                                               │
  │  3. fallback: substring scan for first [ or {                         │
  │  4. throw on total failure                                            │
  └─────────────────────────┬───────────────────────────────────────────┘
                            │ unknown
  ┌─ Section 3: TYPE GUARD ▼───────────────────────────────────────────┐
  │  lib/mcp/validate.ts:isAnomalyArray (or isDiagnosis, isRecArray)     │
  │  returns boolean — TypeScript narrows to typed array on true         │
  └─────────────────────────┬───────────────────────────────────────────┘
                            │ Anomaly[] | falls through
  ┌─ Section 4: CALLER FALLBACK ▼ ──────────────────────────────────────┐
  │  return [] (UI shows "no anomalies") — never throw past the boundary │
  └─────────────────────────────────────────────────────────────────────┘
  ┌─ Optional Section 5: FORCED-FINAL SYNTHESIS TURN ───────────────────┐
  │  used by diagnostic + recommendation: ONE more model call, no tools, │
  │  prior evidence handed back, ask for the JSON only                   │
  │  lib/agents/base-legacy.ts:239-270  +  diagnostic-legacy.ts:79-101   │
  └─────────────────────────────────────────────────────────────────────┘
```

## Elaborate

The pattern shown here is the *forgiving* one — fence extraction + substring fallback. Provider-native structured output is the alternative path:

- **Anthropic tool use as structured output.** Define a tool with an input schema, force the model to call it (`tool_choice: { type: 'tool', name: '...' }`), parse `tool_use.input` as already-typed JSON. Cleaner — no fence extraction needed. Cost: the prompt has to be designed around tool calling.
- **OpenAI structured outputs (`response_format: { type: 'json_schema', json_schema: {...} }`).** Provider-side schema enforcement; the model can't emit invalid JSON. Cleaner still. Cost: locked to OpenAI's schema dialect, no XML tags in the prompt, some markdown-vs-prose tradeoffs.
- **JSON mode (`response_format: { type: 'json_object' }`).** Weakest of the three — guarantees parseable JSON but not the shape you wanted. Still needs the type guard.

This codebase uses the forgiving fence-extraction pattern because (a) it works across providers, (b) it costs nothing to add, (c) the agents already mix prose reasoning with structured output and tool-use-as-structured-output would require a separate path. The newer projects in your portfolio (loopd, future work) should reach for provider-native schema enforcement first and fall back to fence extraction only when crossing provider lines.

Where to read next: OpenAI's structured outputs blog post (openai.com/index/introducing-structured-outputs-in-the-api) is the cleanest treatment of the provider-side enforcement. Anthropic's tool use docs for the tool-call-as-output pattern. Hamel Husain has a post on validation discipline at the LLM boundary that's the right register for this concept.

## Interview defense

**Q: "How do you get structured output out of an LLM reliably?"**

Three layers. *(Draw the diagram.)* Prompt tells the model to return JSON in a fence. Parser extracts the fence body with a regex, JSON.parses it, falls back to a substring scan if the model added prose. Type guard validates the shape — a TypeScript user-defined type guard, boolean return. All three layers fail gracefully to an empty array.

```
  prompt rule  →  parser (fence + JSON.parse + substr fallback)  →  type guard  →  fallback
```

Anchor: *"three layers. Don't trust any one to be enough."*

**Q: "What's the failure people forget?"**

The courteous markdown wrap. The model returns valid JSON inside a fence inside a chat-style reply — "Sure! Here's your data: ```json {...}``` Let me know if you need anything else!" If your parser does raw `JSON.parse(text)`, this breaks. The fence extraction is the load-bearing part. Without it, the whole pattern is one polite "Sure!" away from collapse.

```
  WHAT MODEL RETURNS                          WHAT PARSER MUST HANDLE
  ──────────────────                          ───────────────────────
  "Sure! Here's the JSON:                     extract ```json…``` body
  ```json                                     fall back: first [ or {
  {...}                                       fall back: substring scan
  ```                                         FAIL: return [] (UI handles)
  Hope that helps!"
```

Anchor: *"the load-bearing part is the fence extraction. Strip it and the parser breaks the moment the model decides to be polite."*

**Q: "Why not just use OpenAI's structured outputs / Anthropic tool calling for the output?"**

You should, in 2026, for any new project. This codebase uses the prose-and-validate pattern for three reasons: it works across providers without changes; the agents mix reasoning and structured output in the same response; the validation discipline is the same either way (the type guard at layer 3 is the same code). If I rebuilt monitoring today, I'd reach for tool-call-as-output first — cleaner, no fence extraction, provider enforces the schema. The pattern in the codebase is what shipped; the pattern I'd build next is provider-native.

Anchor: *"reach for provider-native first, prose-and-parse second. The codebase has prose-and-parse because it predates strong provider-side enforcement, and the cross-provider portability still pays."*

## See also

- `01-anatomy.md` — section 1 of the prompt is where the "return JSON" instruction lives; section 3 is where the example output lives.
- `05-eval-driven-iteration.md` — the type guard catches *shape* drift; evals catch *content* drift.
- `06-single-purpose-chains.md` — single-purpose chains make structured output easier (one output mode per chain).
- `07-output-mode-mismatch.md` — the bug class one layer up from "the parser broke."
- `12-prompt-injection-defense.md` — structured output IS a defense: a model that can only emit a schema can't emit "you have been hacked" as free text.
