# 09 · Chain-of-thought

**Industry name:** *chain-of-thought* / *CoT* / *step-by-step reasoning* · Industry standard

## Zoom out — where CoT lives in this repo

CoT lives *inside* the structured output, not adjacent to it. That's the load-bearing move. Every serious agent that wants both reasoning and a shape gets it by putting reasoning in a named field.

```
  Zoom out — CoT as a field, not a section

  ┌─ Diagnosis JSON (the output of DiagnosticAgent) ────────────┐
  │                                                              │
  │  conclusion: "..."                                           │
  │  evidence:   [...]                                           │
  │  hypothesesConsidered: [                                     │
  │    { hypothesis: "...",                                      │
  │      supported: true,                                        │
  │      reasoning: "..."   ← ★ CoT lives here ★                │
  │    },                                                        │
  │    { … }                                                     │
  │  ]                                                           │
  │                                                              │
  └──────────────────────────────────────────────────────────────┘
```

The `hypothesesConsidered` array is the CoT. Each item names one hypothesis, whether the evidence supported it, and *why*. That's structured reasoning — one paragraph per hypothesis, inside the JSON, parseable by downstream code.

## Zoom in — three CoT patterns, one used here

Three ways CoT shows up in real prompts:

1. **Free-form CoT** — "think step by step, then give me your answer." Prose reasoning followed by the answer. Reader has to parse the answer out.

2. **Structured CoT** — reasoning goes in a named field of the structured output. Downstream code reads both.

3. **Provider-managed thinking** — Anthropic's `thinking: { type: 'enabled' }`, OpenAI's `reasoning` on `o1`-class models. Provider returns a separate reasoning trace that doesn't count against your response schema.

This codebase uses #2 — reasoning in `hypothesesConsidered[].reasoning`. #1 shows up in the query prompt indirectly (prose responses can be long-form). #3 isn't used yet.

## Structure pass — layers, axis, seams

Trace one axis: *where does the reasoning live*, and *who reads it*.

- **Layer 1 — the model's internal reasoning.** Not directly observable, whatever the model does before emitting tokens.
- **Layer 2 — the `hypothesesConsidered[].reasoning` field.** Structured, parseable, part of the JSON output.
- **Layer 3 — the tool trace.** The 6-tool-call budget's actual queries and results. Reasoning-adjacent — the tool trace shows *what the model chose to check*.
- **Layer 4 — the judge's context.** `tool_calls_trace` is passed to the RubricJudge so it can grade the reasoning-supported claims against real data.

**The seam:** between free-form reasoning (Layer 1's shadow) and structured reasoning (Layer 2). The seam is *what's parseable*. Free-form reasoning is expressive; structured reasoning is queryable. This codebase picks queryable.

## How it works

### Move 1 — the shape

You've written a function that computes an answer and returns `{ result, workingSet }`, where `workingSet` is the intermediate state you'd want to log if the result looked wrong. Same pattern here. Instead of "the model outputs an answer plus its reasoning," the model outputs an answer plus a structured working set — one hypothesis per array entry, with the reasoning for each.

```
  Pattern — CoT as a structured working set

  ┌─ model output ──────────────────────────┐
  │  conclusion: "the answer"                │
  │  hypothesesConsidered:                   │
  │    [ { hypothesis: A, supported, why },  │
  │      { hypothesis: B, supported, why },  │
  │      { hypothesis: C, supported, why } ] │
  └──────────────────────────────────────────┘

  the "how did the model get there" is the array.
  the "what did it decide" is the conclusion.
  both are queryable JSON.
```

This is CoT the way it should look in 2026. The old prompt-engineering advice was "add 'let's think step by step' to your prompt and let the model reason freely." That works. It also makes the output unparseable and hides the reasoning behind prose. The modern move is: keep the reasoning field, drop the "let's think" instruction, let the schema do the work.

### Move 2 — walking the mechanism

#### The diagnostic prompt's CoT declaration

`lib/agents/legacy-prompts/diagnostic.md:18-23`:

```
## Investigation approach

1. **Generate 2–3 hypotheses** before your first tool call. Examples: device-specific regression, country/region shift, campaign traffic change, product category collapse, data collection gap.
2. **Design queries to falsify each hypothesis.** …
3. **Locate WHEN the change happened** …
4. **Conclude** once you have data supporting or ruling out each hypothesis. State which hypothesis best fits the evidence, or honestly say no clear cause was found.
```

The prompt names the reasoning pattern. Generate hypotheses. Test each. Conclude. This is CoT-by-instruction. It doesn't say "think step by step" in those words — it says "generate 2-3 hypotheses" as a specific step, "design queries to falsify each" as a specific step, and so on. The reasoning structure is baked into the instructions.

Then § 4 (the output shape) declares where the reasoning goes:

`lib/agents/legacy-prompts/diagnostic.md:65-72`:

```
"hypothesesConsidered": [
  {
    "hypothesis": "string — what you tested",
    "supported": true,
    "reasoning": "string — why the data supports or rules this out"
  }
]
```

`hypothesis` names the CoT step. `supported` is the boolean outcome. `reasoning` is the free-form justification. The schema captures the *structure* of reasoning; the reasoning content itself is free text inside a bounded field.

#### The judge reading the CoT

The RubricJudge's `evidence_grounding` dimension at `eval/rubrics/diagnosis-quality.ts:41-55` explicitly grades whether the reasoning is grounded in real evidence:

```
{
  id: 'evidence_grounding',
  label: 'Evidence grounding',
  description:
    'Does the diagnosis cite the actual signals the substrate exposed? Bonus if it names the co-occurring signals (…). Penalty for invented numbers or claims not derivable from the tool results.',
  scale: [
    { score: 1, description: 'Numbers or claims that contradict the evidence.' },
    { score: 2, description: 'Vague evidence references; no specific numbers cited.' },
    { score: 3, description: 'Cites at least one specific number from the evidence.' },
    { score: 4, description: 'Cites multiple specific signals; notes at least one co-occurring signal.' },
    { score: 5, description: 'Cites the primary and co-occurring signals; every claim is traceable to a tool result.' },
  ],
}
```

The judge cross-references reasoning claims against the tool trace. This is only possible because the reasoning is in a queryable field — the judge reads `hypothesesConsidered[].reasoning`, then reads the actual tool results in the trace, then compares. If the reasoning had been free-form prose, the judge could still grade it, but with more noise.

#### The wrong shape — free-form CoT next to structured output

The failure mode this repo avoids:

```
   PROMPT (wrong shape): "think step by step, then return JSON"

   MODEL OUTPUT:
   Let me analyze this step by step.

   First, I need to consider what could cause a conversion drop
   in mobile checkout. Possible causes include...

   Looking at the tool results, I see that payment_failure spiked
   31.2% during the anomaly window...

   ```json
   { "conclusion": "...", "evidence": [...] }
   ```
```

Three problems:

1. **The parser has to skip the prose.** `parseAgentJson` in `lib/mcp/validate.ts:3-13` handles this (fence extraction + substring fallback), but it's fragile — a `{` character in the prose ("the config {") starts the substring scan at the wrong place.

2. **The reasoning is not queryable.** Downstream code can only get to the prose reasoning by re-reading it as a string. It's not indexed. The judge can't easily grade specific claims.

3. **Token cost.** Free-form CoT is expensive. A structured `hypothesesConsidered` array with 3 items runs ~300-500 tokens. Free-form reasoning on the same problem runs 1500-3000. Baseline diagnose output average is 1,858 tokens — most of that is the array + `conclusion` + `evidence`. Freeing it up would balloon that number.

Structured reasoning is a token discipline as much as a parsing discipline. Bounded fields limit how much reasoning the model can produce, which is the *whole point* — force it to make each hypothesis contribute a well-scoped paragraph, not run on.

```
  Comparison — free-form CoT vs structured CoT

  free-form:
    "Let me think through this...
     [1500-3000 tokens of reasoning]
     ```json
     { "conclusion": "..." }
     ```
     Hope this helps!"

  structured:
    { "conclusion": "...",
      "hypothesesConsidered": [
        { "hypothesis": "...", "supported": true,  "reasoning": "..." },
        { "hypothesis": "...", "supported": false, "reasoning": "..." },
        { "hypothesis": "...", "supported": false, "reasoning": "..." }
      ]
    }
    ~500 tokens, queryable, judge-friendly, no parse gymnastics.
```

#### When CoT hurts

The 2026 caveat: frontier models do CoT internally now. Sonnet 4.6, GPT-5, Gemini 2.5 all reason before emitting. Explicitly asking for step-by-step in the prompt is *less necessary* than it was two years ago — and on simple lookups or structured classifiers, asking for CoT just wastes tokens.

Two specific anti-patterns:

- **Simple classifier with CoT.** "Classify this intent as monitoring/diagnostic/recommendation. Think step by step." Adding "think step by step" makes the model produce 200 tokens of prose about why it's monitoring before emitting the answer. The classifier's job is one token. CoT is wasted.

- **Structured output with CoT-in-prose.** "Reason step by step, then output JSON." The model emits both. The parser has to fight the prose. Structured CoT (reasoning inside the JSON field) is the right shape here.

Where CoT still earns its tokens: multi-step problems (this repo's diagnostic agent, which explicitly generates 2-3 hypotheses), long-context reasoning (RAG synthesis over multiple docs), and low-parameter models that still benefit from the explicit reasoning nudge.

### Move 2 variant — the load-bearing skeleton

The kernel of "CoT done right":

1. **Reasoning lives inside the structured output.** Drop this and you have free-form prose adjacent to JSON — parseable but fragile.
2. **The prompt names the reasoning structure explicitly.** "Generate 2-3 hypotheses" not "think step by step." The structure comes from the instruction, the content from the model.
3. **Judge / consumer reads the reasoning field, not the prose.** Drop this and you have reasoning nobody actually verifies.
4. **Reasoning length is bounded by the field's role.** Drop this and one hypothesis's reasoning balloons to 5000 tokens.

Hardening on top: provider-managed thinking (Anthropic's `thinking` block, OpenAI's `reasoning`), reasoning trace visualization for debugging, per-hypothesis eval scoring. None of that is the skeleton — the skeleton is: put reasoning in the schema, name the structure in the prompt, verify against a trace.

### Move 3 — the principle

**Reasoning inside the structured output is queryable; reasoning next to the structured output is folklore.** The old CoT advice was born in the pre-JSON-mode era, when models emitted text and you asked them to think out loud before answering. In 2026 the model can think structurally — you name the reasoning fields (hypothesis, supported, reasoning), and the model fills them in. Both the model and your parser are happier.

## Primary diagram

```
  CoT — the full recap

  prompt (§ 2 investigation approach)
  ┌────────────────────────────────────────────────────┐
  │  "1. Generate 2-3 hypotheses.                       │
  │   2. Design queries to falsify each.                │
  │   3. Locate when the change happened.               │
  │   4. Conclude which hypothesis best fits."          │
  └────────────────────────────────────────────────────┘
                          │
                          ▼
  prompt (§ 4 output shape)
  ┌────────────────────────────────────────────────────┐
  │  hypothesesConsidered: [                            │
  │    { hypothesis, supported, reasoning }             │
  │  ]                                                  │
  └────────────────────────────────────────────────────┘
                          │
                          ▼
  model output (JSON with reasoning in the shape)
  ┌────────────────────────────────────────────────────┐
  │  conclusion: "..."                                  │
  │  evidence:   [...]                                  │
  │  hypothesesConsidered:                              │
  │    [ { hypothesis: A, supported: true,  reasoning }, │
  │      { hypothesis: B, supported: false, reasoning }, │
  │      { hypothesis: C, supported: false, reasoning } ]│
  └────────────────────────────────────────────────────┘
                          │
                          ▼
  judge reads reasoning + tool_calls_trace
  ┌────────────────────────────────────────────────────┐
  │  evidence_grounding score cross-references          │
  │  hypothesesConsidered[].reasoning against actual    │
  │  tool results captured in tool_calls_trace          │
  └────────────────────────────────────────────────────┘
```

## Elaborate

The Anthropic "extended thinking" mode is the modern alternative to structured CoT in the app-layer output. Enable it, and the model returns a separate `thinking` block on the response object — provider-managed, not counted against your JSON schema, billable at reasoning-token rates. This codebase doesn't use it yet, and the trade-off if it did: less prompt-side work (no need for `hypothesesConsidered`), but the reasoning trace lives in the API response, not in the JSON output. Downstream code (the judge) would have to be re-wired to pull reasoning from a different place.

The OpenAI o1 / o3 / GPT-5 reasoning models take a similar approach — reasoning tokens are separate from response tokens, and you're billed for both. The prompt engineering discipline shifts: instead of asking the model to reason, you enable the reasoning mode and let the provider handle it. The catch: reasoning tokens are more expensive per token than input tokens, so it's a cost / quality trade-off, not a free upgrade.

The classic paper that gets cited for CoT is "Chain-of-Thought Prompting Elicits Reasoning in Large Language Models" (Wei et al., 2022). Worth reading. Worth noting that the paper's baseline models were text-only completion models — the reasoning improvement it measured is much smaller on modern chat models that already reason internally. The technique still works; the effect size has shrunk.

The self-consistency variant — run the same CoT prompt N times, take the majority vote — is real and expensive. It shows up in `10-self-critique.md`. This codebase doesn't use it for the agents (the eval harness runs each case once) but does use single-shot RubricJudge output (which is why judge variance shows up in receipt comparisons).

## Interview defense

**Q: Where does chain-of-thought live in your prompts?**

Inside the structured output, not adjacent to it. The DiagnosticAgent's output schema at `lib/agents/legacy-prompts/diagnostic.md:65-72` includes a `hypothesesConsidered` array — each item names one hypothesis, whether the evidence supported it, and the reasoning. That's structured CoT. The prompt itself names the reasoning steps ("generate 2-3 hypotheses, test each") but doesn't say "think step by step" — the schema shapes the reasoning. Downstream (the RubricJudge) reads the reasoning field directly and grades it against the tool trace. Free-form CoT would be prose next to JSON, which the parser has to fight and the judge has to re-tokenize to grade.

```
   free-form CoT:   prose reasoning + JSON  ── parser fights, judge re-reads
   structured CoT:  reasoning field IN JSON ── one parse, judge queries field
```

Anchor: `lib/agents/legacy-prompts/diagnostic.md:65-72` and `eval/rubrics/diagnosis-quality.ts:41-55`.

**Q: Frontier models reason internally now. Is explicit CoT dead?**

Less necessary, not dead. On simple lookups and structured classifiers, explicit "think step by step" wastes tokens — Sonnet 4.6 and GPT-5 reason internally before emitting. On multi-step reasoning tasks (this repo's diagnostic, which walks 2-3 competing hypotheses), a *structural* CoT still earns its tokens because the structure is queryable. On cheaper models — Haiku-class, GPT-4o-mini — explicit CoT still helps because their internal reasoning is weaker. The rule: measure. Run the eval with and without the CoT scaffolding; keep whichever wins on your rubric.

```
  frontier model + simple task:      skip CoT
  frontier model + multi-step task:  structured CoT (reasoning field)
  cheap model + any task:            explicit CoT still helps
```

Anchor: `lib/agents/legacy-prompts/diagnostic.md:18-23` — the prompt names the reasoning steps but doesn't say "think step by step."

## See also

- 02 · structured outputs — reasoning goes in a field of the schema, not next to it.
- 05 · eval-driven iteration — the judge reads the reasoning fields directly against the tool trace.
- 10 · self-critique — the vote-N-times variant of CoT.
- 04 · token budgeting — structured CoT is bounded by field roles; free-form CoT balloons.
