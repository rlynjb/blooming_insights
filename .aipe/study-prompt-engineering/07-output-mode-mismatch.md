# 07 — Output mode mismatch

*Chain-boundary contract violations · Industry standard*

## Zoom out, then zoom in

Output mode mismatch lives at the seams between chains. Pull up where one chain's output meets the next chain's input.

```
  Where output-mode mismatches happen — at every chain handoff

  ┌─ diagnostic agent ──────────────────────────────────────┐
  │  output mode: JSON object (Diagnosis)                    │
  │  enforced: isDiagnosis() type guard                       │
  └────────────────────┬────────────────────────────────────┘
                       │
                       ▼  ★ THE SEAM — output mode contract ★    ← we are here
                       │
  ┌─ recommendation agent ─▼─────────────────────────────────┐
  │  input mode: JSON object (Diagnosis)                     │
  │  expectation: diagnosis.conclusion, diagnosis.evidence    │
  │  failure if: shape drifts, fields missing, wrong types    │
  └──────────────────────────────────────────────────────────┘

  Every chain declares one output mode in its prompt. Every consumer
  asserts that mode. A mismatch is a silent parser break — the kind of
  bug that ships in dev and explodes in production a week later.
```

This is the bug class that single-purpose chains (concept 06) and structured outputs (concept 02) collectively defend against. The chain boundary is *where the contract lives*, and getting it wrong is the most common cross-chain failure mode.

## Structure pass

**Layers.** Outer: the pipeline (multiple chains in sequence). Middle: each chain's declared output mode. Innermost: the consumer's parsing expectation.

**Axis — what enforces the contract.** Walk it down:

```
  one axis — "what makes the contract enforceable?" — three layers

  ┌─ pipeline layer ───────────────────┐
  │  ENFORCED by: code review            │  human checks chain A's prompt
  │                                       │  says what chain B expects
  └────────────────────────────────────┘
       ┌─ prompt layer ─────────────────┐
       │  ENFORCED by: prompt instruction │  "Return ONLY a JSON object in
       │  + example                        │   a ```json fence: {...}"
       └────────────────────────────────┘
            ┌─ runtime layer ────────────┐
            │  ENFORCED by: type guard    │  isDiagnosis() returns boolean
            │  (concept 02)               │  at the consumer boundary
            └────────────────────────────┘
```

**Seams.** The chain-A-to-chain-B handoff is the load-bearing seam. If either side's understanding of "the output mode" drifts, the handoff breaks. The type guard is the runtime defense; the prompt declaration is the design-time defense; code review is the change-time defense.

## How it works

### Move 1 — the mental model

You know how a function signature in TypeScript is a contract — caller and callee agree on input/output types and the compiler enforces it? Output mode at a chain boundary is the *same shape* of contract, except the compiler can't enforce it because the producer is an LLM emitting probabilistic text.

```
  Pattern — chain boundary as a contract, with three enforcement points

  ┌─ chain A ────────────────┐                    ┌─ chain B ──────────────┐
  │  prompt declares:         │                    │  prompt expects:        │
  │  "Return ONLY JSON object  │   ───contract───►  │  the Diagnosis shape    │
  │   in a ```json fence:      │                    │  (conclusion, evidence, │
  │   {conclusion, evidence,..}│                    │   hypothesesConsidered) │
  └────────────┬─────────────┘                    └────────────┬───────────┘
               │                                                │
               ▼                                                ▼
        emits text                                        validates shape
               │                                                ▲
               │                                                │
               └────────► type guard at boundary ───────────────┘
                          (isDiagnosis returns boolean)

  Three enforcement points: prompt declaration · type guard · code review.
  Lose any one and the contract becomes folklore.
```

The kernel: every chain has *one* declared output mode and the consumer asserts it. Lose any of the three enforcement points and the contract becomes folklore — "well, it usually returns JSON…"

### Move 2 — the walkthrough

**Step 1 — every chain declares its output mode in the prompt.** This is where it lives in this codebase:

```
  Where each chain declares its output mode

  monitoring.md:70-71   →  "Return ONLY a JSON array of anomaly objects ...
                            wrapped in a ```json fenced block:"
  diagnostic.md:58-59   →  "Return ONLY a JSON object (in a ```json fenced
                            block) of exactly this shape:"
  recommendation.md:49-50 → "Return ONLY a JSON array (in a ```json fenced
                            block) of at most 3 objects, each of exactly
                            this shape:"
  query.md:46-48        →  "Give a clear, concise answer in plain prose —
                            a few sentences; you may use short markdown
                            bullets. ... No JSON shape is required."
```

Two output modes in this codebase:

  → **Structured JSON in a fence** (monitoring, diagnostic, recommendation, intent).
  → **Plain prose** (query).

**Note query is the odd one out.** Query returns text and the UI renders it as markdown (`StreamingResponse` component). The diagnostic chain's output flows into the recommendation chain; query's output flows to the UI directly. That's why query's output mode is different — it has a different consumer.

**Step 2 — the example output IS the contract.** Look at `legacy-prompts/diagnostic.md:58-82`:

```
Return ONLY a JSON object (in a ```json fenced block) of exactly this shape:

```json
{
  "conclusion": "string — the best-supported explanation, or an honest...",
  "evidence": [
    "string — one piece of evidence per item, citing tool results..."
  ],
  "hypothesesConsidered": [
    {
      "hypothesis": "string — what you tested",
      "supported": true,
      "reasoning": "string — why the data supports or rules this out"
    }
  ],
  "affectedCustomers": {
    "count": 0,
    "segmentDescription": "string — optional; include only if..."
  },
  "timeSeries": [
    { "day": "d-13", "value": 0 },
    { "day": "today", "value": 51 }
  ]
}
```
```

The example is *the* contract. The prose around it ("of exactly this shape") is reinforcement. The model has both the shape and a worked example to copy. The receiving end (`isDiagnosis` in `lib/mcp/validate.ts:29-35`) checks only the *required* fields — `conclusion` (string), `evidence` (array), `hypothesesConsidered` (array). Optional fields like `affectedCustomers` and `timeSeries` are checked at the UI render layer with safe defaults.

**Step 3 — the type guard at the boundary.** `lib/mcp/validate.ts:29-35`:

```typescript
export function isDiagnosis(v: unknown): v is Diagnosis {
  if (!v || typeof v !== 'object') return false;
  const d = v as any;
  return typeof d.conclusion === 'string'
    && Array.isArray(d.evidence)
    && Array.isArray(d.hypothesesConsidered);
}
```

The runtime check. If the diagnostic agent returns a JSON object that doesn't have these three required fields, the boundary returns `false`. The caller (the recommendation chain's input handler, or the route handler) decides the fallback — in this codebase, a FALLBACK Diagnosis at `lib/agents/diagnostic-legacy.ts:16-20`:

```typescript
const FALLBACK: Diagnosis = {
  conclusion: 'Insufficient data to determine a cause for this change.',
  evidence: [],
  hypothesesConsidered: [],
};
```

The fallback satisfies the contract (it IS a valid Diagnosis). The downstream chain can run against it. Failure stays inside the diagnostic boundary; the pipeline continues.

**Step 4 — the bug: chain A and chain B disagree.** This is the classic. Most common version in real codebases:

```
  Anti-pattern — output mode mismatch, the bug

  chain A's prompt says:                  chain B parses with:
  ─────────────────────                   ───────────────────
  "Return a list of suggestions,           JSON.parse(text)
  one per line, in markdown."              → throws on markdown

  OR

  chain A's prompt says:                  chain B parses with:
  ─────────────────────                   ───────────────────
  "Return a JSON array of strings."        const obj = JSON.parse(text)
                                            if (obj.items) ...
                                            → undefined, silent breakage

  OR  (the dangerous one — both are JSON, both are valid)

  chain A returns:                         chain B expects:
  ────────────────                         ────────────────
  { "suggestions": ["a", "b"] }            ["a", "b"]
  (object with array field)                (array directly)
                                            → silent parsing succeeds,
                                              consumer reads .map() on
                                              an object → empty UI
```

The third one is the *dangerous* one. Both sides are emitting and parsing JSON. The mismatch is in the *shape*, and `JSON.parse` doesn't catch it. The type guard does — that's exactly why it's at the boundary.

**Step 5 — how to spot mismatches in code review.** When reviewing a PR that touches a prompt:

  1. **What output mode does this prompt declare?** Read the "Output" section of the `.md` file. Find the literal example.
  2. **What type guard validates this chain's output?** Open `lib/mcp/validate.ts`, find the `is*` function for this shape.
  3. **What consumer reads this output?** `grep` for the type. `Diagnosis` is consumed in `lib/agents/recommendation.ts` and in the UI's `EvidencePanel`.
  4. **Do all three agree?** If the prompt says `evidence: string[]` but the type guard checks `Array.isArray(d.evidence)` (which allows `evidence: number[]`), the type guard is too loose. If the consumer reads `evidence[0].cite` but the prompt's example has `evidence: ["string", "string"]`, the consumer is wrong.

**Layers-and-hops view of the contract at runtime:**

```
  Layers-and-hops — one chain handoff, three enforcement layers

  ┌─ Diagnostic agent ─────────────────────────────────────┐
  │  prompt: "Return ONLY a JSON object {...}"              │
  │  model emits: text                                       │
  └──────────────┬─────────────────────────────────────────┘
                 │ hop 1: parseAgentJson(text) → unknown
  ┌─ Parser ▼ ─────────────────────────────────────────────┐
  │  extract from ```json fence                              │
  │  fall back to substring scan                             │
  │  → unknown (could be anything)                           │
  └──────────────┬─────────────────────────────────────────┘
                 │ hop 2: isDiagnosis(parsed) → boolean
  ┌─ Type guard ▼ ─────────────────────────────────────────┐
  │  checks: conclusion string, evidence array,             │
  │  hypothesesConsidered array                              │
  │  → typed Diagnosis OR fallback                           │
  └──────────────┬─────────────────────────────────────────┘
                 │ hop 3: typed Diagnosis passed forward
  ┌─ Recommendation agent ▼ ───────────────────────────────┐
  │  reads diagnosis.conclusion, diagnosis.evidence         │
  │  works because the contract held                         │
  └─────────────────────────────────────────────────────────┘
```

### Move 3 — the principle

A chain boundary is a contract. A contract without runtime enforcement is folklore. The prompt declares the mode, the type guard enforces it, the consumer relies on it. All three layers are necessary because the producer is probabilistic and the consumer is deterministic — the runtime check is what bridges the gap. This is the same principle as input validation at any service boundary; the LLM substrate doesn't change it, only sharpens its importance.

## Primary diagram — output mode contract, full enforcement

```
  ┌─ design time (PR review) ────────────────────────────────────────┐
  │  reviewer compares:                                                │
  │    legacy-prompts/diagnostic.md "Output" section                    │
  │    vs lib/mcp/validate.ts:isDiagnosis()                            │
  │    vs lib/agents/recommendation.ts (and EvidencePanel.tsx) consumer│
  └──────────────────────────┬───────────────────────────────────────┘
                             │
  ┌─ build time ▼ ───────────────────────────────────────────────────┐
  │  TypeScript: `Diagnosis` type referenced by isDiagnosis +          │
  │  consumers + agent return type — drift fails the build             │
  └──────────────────────────┬───────────────────────────────────────┘
                             │
  ┌─ runtime ▼ ──────────────────────────────────────────────────────┐
  │                                                                    │
  │  ┌─ chain A ─────────┐    ┌─ parser ─┐    ┌─ type guard ─┐        │
  │  │  prompt declares   │ →  │ extract  │ →  │ isDiagnosis   │       │
  │  │  output mode +     │    │ from     │    │ returns bool   │       │
  │  │  worked example    │    │ fence    │    │                │       │
  │  └────────────────────┘    └──────────┘    └───────┬───────┘       │
  │                                                     │               │
  │                                              ┌──────▼──────┐        │
  │                                              │ FALLBACK if  │        │
  │                                              │ guard false  │        │
  │                                              └──────┬───────┘        │
  │                                                     │                │
  │  ┌─ chain B (consumer) ──────────────────────────────▼───────────┐  │
  │  │  reads typed Diagnosis (real or fallback) — contract held       │  │
  │  └────────────────────────────────────────────────────────────────┘  │
  └────────────────────────────────────────────────────────────────────┘
```

## Elaborate

This concept is *the most common bug class in multi-agent systems*, and the canonical version of it shows up in every framework you've seen. LangGraph has the same problem — nodes return `state` mutations, and a node that mutates `state.foo` while the next node reads `state.bar` is exactly this bug. CrewAI: agent A's output is "the answer," agent B reads "the result" — silent break. The substrate doesn't matter; the seam matters.

Two places to deepen:

- **Anthropic's "Building effective agents."** Names the workflow-vs-agent distinction. Workflows (deterministic chain composition, like this codebase) make contract enforcement easier than autonomous agents because the consumer is *known* at design time.
- **OpenAPI as a parallel.** REST APIs solved this with OpenAPI schemas + client code generation. The LLM-chain equivalent is what this codebase does informally — the type guard + the TypeScript type. The richer version would be: generate the prompt's example output from the TypeScript type so they can't drift.

In this codebase, concept 02 (structured outputs) is the per-chain output mode discipline; this concept is the cross-chain version of the same enforcement. Concept 06 (single-purpose chains) is the architectural reason the contracts are *small enough* to enforce — a monolithic agent has one giant output mode that's much harder to validate.

## Interview defense

**Q: "What's output-mode mismatch?"**

Bug class at the chain boundary. *(Draw the contract diagram.)* Chain A emits an output mode (JSON array, JSON object, prose). Chain B expects an input mode. When the two disagree, the parser breaks — sometimes loudly with a `JSON.parse` throw, sometimes silently with a shape that *parses* but is the wrong type. The silent kind is the dangerous one. The defense is three layers: the prompt declares the mode + a worked example, a type guard enforces at runtime, and code review checks the prompt vs the consumer when either changes.

```
  prompt declaration  +  runtime type guard  +  code review = enforced contract
```

Anchor: *"the dangerous one is when both sides emit and parse JSON but disagree on the shape. JSON.parse doesn't catch it. The type guard does."*

**Q: "How do you spot a mismatch in code review?"**

Four-step check. *(Walk it.)* Open the prompt — find the "Output" section, read the literal example. Open `lib/mcp/validate.ts` — find the `is*` guard for that shape. Grep for the type — find the consumers. Compare all three. If the prompt's example has `evidence: string[]` but the guard checks `Array.isArray(evidence)` (which allows `number[]`), the guard's too loose. If the consumer reads `evidence[0].cite` but the prompt says `evidence: ["string"]`, the consumer is wrong.

Anchor: *"prompt → type guard → consumer. All three must agree. If any two diverge, the third will eventually break."*

**Q: "Why isn't TypeScript enough?"**

Because the producer is an LLM, not a function. TypeScript catches the bug if the *consumer* references the wrong field, but TypeScript can't constrain the *output* of `anthropic.messages.create()` — that's typed as `Anthropic.Messages.ContentBlock[]`. The model can emit any JSON shape it wants inside that. The runtime type guard is the bridge — it's the moment where `unknown` becomes typed `Diagnosis`. Without it, you have TypeScript narrowing on a `(parsed as Diagnosis)` cast that's a lie.

Anchor: *"TypeScript catches consumer bugs. The runtime guard catches producer bugs. Both are necessary because the producer is probabilistic."*

## See also

- `02-structured-outputs.md` — the per-chain output discipline; this file is the cross-chain extension.
- `06-single-purpose-chains.md` — small per-chain output modes are what makes the contracts enforceable; monolithic outputs are not.
- `05-eval-driven-iteration.md` — type guards catch shape mismatches; evals catch *content* mismatches (the diagnosis was the wrong shape OR the diagnosis was the wrong *answer*).
- `13-forbidden-patterns.md` — sometimes "output mode drift" is the model converging on a phrasing the consumer didn't expect; concept 13 walks the prevention.
