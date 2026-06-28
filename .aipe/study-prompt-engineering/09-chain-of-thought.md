# 09 — Chain-of-thought (CoT)

*Step-by-step reasoning prompts · Industry standard*

## Zoom out, then zoom in

Pull up the diagnostic agent's prompt. Chain-of-thought reasoning is the thing that the prompt asks the model to do *between* tool calls.

```
  Where chain-of-thought lives — inside the diagnostic prompt's approach

  ┌─ diagnostic.md ─────────────────────────────────────────────────┐
  │  ## Role                                                          │
  │  Investigate WHY a specific anomaly occurred.                     │
  │                                                                    │
  │  ## Investigation approach                                         │
  │  ┌──────────────────────────────────────────────────────────┐    │
  │  │ ★ CoT — explicit step structure ★                          │    │ ← we are here
  │  │  1. Generate 2–3 hypotheses BEFORE your first tool call.    │    │
  │  │  2. Design queries to falsify each hypothesis.              │    │
  │  │  3. Locate WHEN the change happened — spend one of           │    │
  │  │     your calls on this.                                      │    │
  │  │  4. Conclude once you have data supporting or ruling out     │    │
  │  │     each hypothesis.                                          │    │
  │  └──────────────────────────────────────────────────────────┘    │
  │  ## Tool catalog reminders                                          │
  │  ## Common errors                                                   │
  │  ## Output (structured Diagnosis)                                   │
  └───────────────────────────────────────────────────────────────────┘
```

CoT in 2026 isn't "Let's think step by step" anymore — that prompt-engineering trick was a 2022 GPT-3.5 thing. On frontier models like Sonnet 4.6, CoT shows up as a *structured reasoning approach* embedded in the prompt: name the steps, tell the model when to think and what to think about. The model does the rest internally.

## Structure pass

**Layers.** Outer: the agent's overall task. Middle: the explicit reasoning steps in the prompt. Innermost: the model's internal generation of intermediate reasoning tokens.

**Axis — what does the model spend tokens on?** Walk it down:

```
  one axis — "what does the model spend tokens on?" — three layers, three answers

  ┌─ no-CoT prompt ────────────────────┐
  │  output tokens = final answer only  │  fast, cheap, often shallow
  └────────────────────────────────────┘
       ┌─ explicit CoT prompt ──────────┐
       │  output tokens = reasoning      │  slower, costlier, deeper
       │  steps + final answer           │  for multi-step problems
       └────────────────────────────────┘
            ┌─ structured CoT (this codebase) ─┐
            │  output tokens = TOOL calls per  │  reasoning happens
            │  step + final structured answer  │  THROUGH the tool loop
            └─────────────────────────────────┘
```

**Seams.** The biggest seam is between "CoT for its own sake" (just emit reasoning tokens, hope they help) and "CoT as a structure for the work" (the steps drive the tool-call plan). This codebase uses the second pattern — the diagnostic prompt's 4-step approach IS the tool-call plan.

## How it works

### Move 1 — the mental model

You know how when you're debugging a tricky bug, you don't just *think harder* — you write down "okay, hypothesis 1 is X, hypothesis 2 is Y, here's the test that distinguishes them," and *then* run the tests? CoT in a prompt is the same shape: name the steps, tell the model to walk them, let it spend tokens on intermediate reasoning.

```
  Pattern — chain-of-thought, the kernel

  ┌─ task ───────────────┐
  │  "Why did revenue     │
  │   drop?"              │
  └──────────┬───────────┘
             │  WITHOUT CoT:
             │  ┌─ model jumps to conclusion ─┐
             │  │  "Revenue dropped because    │
             │  │   conversion fell."          │ ← guessed; might be right
             │  └─────────────────────────────┘
             │
             │  WITH CoT:
             │  ┌─ model walks steps ─────────┐
             │  │  step 1: hypotheses         │
             │  │    H1: device regression    │
             │  │    H2: traffic shift         │
             │  │    H3: payment failure       │
             │  │  step 2: queries to test     │
             │  │    Q1: revenue by device     │
             │  │    Q2: traffic by source     │
             │  │    Q3: checkout funnel       │
             │  │  step 3: conclusion          │
             │  │    H2 supported by data     │
             │  └─────────────────────────────┘
```

The mechanism: spending tokens on intermediate reasoning makes the model less likely to skip steps. On multi-step problems (causal investigation, multi-hop reasoning, planning), this is a real reliability lift. On simple problems (a one-shot classifier, a structured lookup), it's wasted tokens.

### Move 2 — the walkthrough

**Step 1 — when CoT helps.** Three situations:

  → **Multi-step problems.** The diagnostic agent's job is exactly this — generate hypotheses, query to test them, conclude. Without the explicit steps in the prompt, the model would either guess (skip the test) or query randomly (skip the hypotheses).
  → **Output that should reflect a process.** The recommendation agent's prompt has a similar structure (`legacy-prompts/recommendation.md:30-46`): read the diagnosis, check what exists, pick the feature, estimate impact, name prerequisites. Walking through the steps makes the output internally consistent.
  → **Cheaper models.** Older or cheaper models benefit more from explicit CoT. Sonnet 4.6 does a lot of reasoning internally; Haiku 4.5 (the intent classifier) does much less. If you ever needed to swap the diagnostic agent to a cheaper model, the explicit step structure would matter more.

**Step 2 — when CoT hurts.** Three situations:

  → **Simple lookups.** The intent classifier (`lib/agents/intent.ts`) doesn't ask the model to reason — it asks for one word. Adding "Let's think step by step: first, consider whether the user is asking about what changed..." would waste tokens AND introduce drift (the model might say "thinking: ... → diagnostic" instead of just "diagnostic").
  → **Structured classifiers under tight latency.** When the output is short and the answer is mostly pattern-matched (yes/no, A/B/C), CoT slows you down without helping.
  → **Outputs already strong on frontier models.** Don't add CoT preemptively. Add it when you measure a quality lift on a specific case. Otherwise you're paying for reasoning tokens without getting a benefit.

**Step 3 — what CoT looks like in this codebase.** The diagnostic prompt at `legacy-prompts/diagnostic.md:18-23`:

```
## Investigation approach

1. **Generate 2–3 hypotheses** before your first tool call. Examples: device-specific
   regression, country/region shift, campaign traffic change, product category
   collapse, data collection gap.
2. **Design queries to falsify each hypothesis.** Segment the metric by the most
   likely discriminating dimension first (`by customer.device_type`, `by customer.country`,
   `by event.category`, etc.) ...
3. **Locate WHEN the change happened — spend one of your calls on this; it sharpens
   the diagnosis AND powers the timeline chart.** Run a time-series of the
   anomalous metric ...
4. **Conclude** once you have data supporting or ruling out each hypothesis. State
   which hypothesis best fits the evidence, or honestly say no clear cause was found.
```

Four explicit steps. Each one names *what* to do AND *why* to do it. The "before your first tool call" framing in step 1 is the load-bearing constraint — without it, the model would start querying before it had hypotheses to test.

This is *embedded* CoT: the reasoning structure is in the prompt, but the model isn't asked to emit a "reasoning" block separately. Instead, the reasoning shows up in the *sequence of tool calls* — hypothesis-driven queries, then a time-series query, then the structured Diagnosis output.

**Step 4 — the modern caveat: frontier models do CoT internally now.** Sonnet 4.6 (the agent model in this codebase) has built-in reasoning. When you give it the diagnostic prompt, it generates intermediate thoughts in its internal reasoning *without* needing you to ask for them in prose. This means the explicit-CoT-in-prompt approach is *less critical* than it was in 2022, but still helps because:

  → It STRUCTURES the model's reasoning along the steps you care about (hypotheses, not random exploration).
  → It makes the chain replayable in the streaming trace — each `reasoning_step` event the agent emits maps to a step in the prompt.
  → It serves as documentation for *humans* reading the prompt later — concept 03's source-of-truth benefit.

**Step 5 — CoT meets structured output.** Here's the subtle one. If you want BOTH reasoning AND a structured answer, the reasoning goes in a *"thinking" field* of the structured output, not in free-form prose preceding the JSON.

```
  Pattern — CoT inside a structured output schema

  BAD (mixes prose and structure):              GOOD (reasoning in a typed field):
  ─────────────────────────────                 ──────────────────────────────
  "First, I'll consider hypothesis 1...         {
   ...                                            "reasoning": "Considered H1...",
   Now I'll test it with query X...               "conclusion": "...",
   ...                                            "evidence": [...]
   Based on the data...                          }
   ```json                                       (the prose-reasoning becomes
   { "conclusion": "..." }                        a typed field; the parser
   ```                                            still gets clean JSON)
  "

  → parser sees prose THEN JSON,                → parser sees JSON; reasoning
    has to extract from fence                     is RECOVERABLE from the field
    OR fall back to substring                     no extraction gymnastics
```

This codebase's diagnostic prompt does *most* of this — the prompt structure encourages the model to reason through the tool calls themselves (each tool call IS a step), and the final output is pure structured JSON. The reasoning is captured in `hypothesesConsidered` (an array of `{hypothesis, supported, reasoning}` objects) — exactly the "reasoning in a typed field" pattern.

Look at `legacy-prompts/diagnostic.md:64-70`:

```
  "hypothesesConsidered": [
    {
      "hypothesis": "string — what you tested",
      "supported": true,
      "reasoning": "string — why the data supports or rules this out"
    }
  ],
```

The `reasoning` field is where the model's per-hypothesis logic lands. It's typed, it's queryable, it's *visible to the user* in the EvidencePanel UI ("hypotheses considered" is a collapsible section). The CoT isn't thrown away after the model emits the structured answer — it's preserved as data.

**Layers-and-hops view — CoT across the diagnostic agent:**

```
  Layers-and-hops — embedded CoT through the diagnostic loop

  ┌─ Prompt instruction (lib/agents/legacy-prompts/diagnostic.md) ─┐
  │  "1. Generate 2-3 hypotheses ..."                                │
  │  "2. Design queries to falsify ..."                              │
  │  "3. Locate WHEN the change happened ..."                        │
  │  "4. Conclude ..."                                                │
  └──────────────────────┬──────────────────────────────────────────┘
                         │ hop 1: model starts loop
  ┌─ Turn 1 ▼ ───────────────────────────────────────────────────────┐
  │  assistant text: "Looking at this revenue drop, my hypotheses    │
  │  are: H1 mobile regression, H2 country shift, H3 ..."             │
  │  → ToolUseBlock: query revenue by device_type                    │
  └──────────────────────┬──────────────────────────────────────────┘
                         │ hop 2: tool result back, next turn
  ┌─ Turn 2 ▼ ───────────────────────────────────────────────────────┐
  │  assistant text: "Mobile is flat; H1 not supported. Testing H2." │
  │  → ToolUseBlock: query revenue by country                         │
  └──────────────────────┬──────────────────────────────────────────┘
                         │ ...turns 3-5 walk steps 3+4...
                         │
  ┌─ Final turn ▼ ───────────────────────────────────────────────────┐
  │  assistant text: structured Diagnosis JSON                       │
  │  hypothesesConsidered[*].reasoning captures the per-step logic   │
  └─────────────────────────────────────────────────────────────────┘
```

Each turn is a CoT step. The model's reasoning is *expressed as a tool-call plan*, not as free prose. This is the modern shape — CoT as a structural skeleton, not as "think step by step" magic words.

### Move 3 — the principle

CoT is the discipline of *spending tokens on intermediate state* to improve the final answer. The structure matters — random "reasoning out loud" wastes tokens; *named* steps that map to a tool-call plan or a structured-output field pay back. The principle generalises: any time the work has a real process to walk, encoding the process in the prompt is more reliable than hoping the model walks it implicitly.

## Primary diagram — CoT in this codebase, structural shape

```
  ┌─ Prompt: explicit step structure ────────────────────────────────────┐
  │                                                                       │
  │  legacy-prompts/diagnostic.md ## Investigation approach                │
  │                                                                       │
  │  step 1: hypotheses (BEFORE first tool call)                          │
  │     │                                                                  │
  │     ▼                                                                  │
  │  step 2: queries to falsify each                                       │
  │     │                                                                  │
  │     ▼                                                                  │
  │  step 3: WHEN — time-series query                                      │
  │     │                                                                  │
  │     ▼                                                                  │
  │  step 4: conclude                                                      │
  └───────────────────────────────────────────────────────────────────────┘
                                  │
                                  │  drives:
                                  ▼
  ┌─ Tool-call loop (lib/agents/base-legacy.ts) ─────────────────────────┐
  │  turn 1: model names hypotheses → ToolUse(query for H1)               │
  │  turn 2: result → model evaluates H1 → ToolUse(query for H2)          │
  │  turn 3: result → model evaluates H2 → ToolUse(time-series query)     │
  │  turn 4: result → model concludes                                      │
  │  turn N: forced-final synthesis if budget exhausted                    │
  └────────────────────────────────────────────────────────────────────────┘
                                  │
                                  │  produces:
                                  ▼
  ┌─ Structured output ──────────────────────────────────────────────────┐
  │  Diagnosis {                                                          │
  │    conclusion: "Mobile-specific regression on iOS payment flow"       │
  │    evidence: [...]                                                    │
  │    hypothesesConsidered: [                                            │
  │      { hypothesis: "Country shift", supported: false,                 │
  │        reasoning: "Revenue distribution by country unchanged" }       │
  │      { hypothesis: "Device regression", supported: true,              │
  │        reasoning: "Mobile -34%, desktop +2% over the window" }        │
  │    ]                                                                  │
  │    timeSeries: [...]                                                  │
  │  }                                                                    │
  │  ↑ reasoning preserved as TYPED fields, not thrown away              │
  └────────────────────────────────────────────────────────────────────────┘
```

## Elaborate

The original CoT paper (Wei et al., 2022, "Chain-of-Thought Prompting Elicits Reasoning in Large Language Models") demonstrated the technique on math word problems with GPT-3. Adding "Let's think step by step" to prompts measurably improved accuracy. That specific phrasing was the discovery; the underlying principle — spending tokens on intermediate reasoning helps — was the result.

The discipline evolved through three eras:

- **2022 — "Let's think step by step" magic.** A literal addition to the prompt that worked on GPT-3 / 3.5. Less effective on frontier models because they already reason internally.
- **2023 — structured CoT in the prompt.** Named steps, explicit substeps, "first do X, then do Y." More reliable than the magic phrase; pays back more on harder tasks.
- **2024–2026 — CoT in structured-output schemas.** The pattern this codebase uses — reasoning as a typed field (`hypothesesConsidered[*].reasoning`), not as free prose preceding the answer. Combines reliability of structured output with the benefit of preserved reasoning.

Where to read next: the original Wei et al. paper for the foundational result. Anthropic's "thinking" feature docs (anthropic.com/news/claude-sonnet-4-5 — extended thinking) for the modern API-level support. Simon Willison has a running comparison of when explicit CoT helps vs hurts on current models.

In this codebase, concept 06 (single-purpose chains) is what makes CoT manageable — each chain has one job, so the CoT structure is small and focused. A monolithic agent would need a CoT structure with so many branches it would collapse under its own weight.

## Interview defense

**Q: "Where do you use chain-of-thought?"**

In the diagnostic agent's prompt. *(Pull up the 4-step structure.)* The prompt names hypothesis generation → falsifying queries → time-series query → conclusion as explicit steps. The model walks them through the tool loop — each turn is a step. The reasoning gets preserved in the `hypothesesConsidered[*].reasoning` field of the structured Diagnosis output, so it's *typed data*, not prose to be thrown away.

```
  step 1 hypotheses  →  step 2 falsify  →  step 3 when  →  step 4 conclude
                      (tool calls)        (tool call)     (structured output
                                                           with reasoning fields)
```

Anchor: *"explicit steps structure the tool-call plan; reasoning lives in typed fields of the output, not in free prose."*

**Q: "Why not just 'Let's think step by step'?"**

Two reasons. One, on Sonnet 4.6 the model does a lot of reasoning internally — the magic-phrase trick was a GPT-3 thing, less useful now. Two, "think step by step" is unstructured — the model decides what the steps are. The diagnostic prompt's 4-step structure is opinionated: hypotheses BEFORE queries (rule order is load-bearing), time-series query in step 3 (so the UI gets a timeline chart), conclude in step 4 (forced into structured output). That's CoT-as-skeleton, not CoT-as-incantation.

Anchor: *"the magic phrase is 2022. The modern shape is named steps that map to your tool-call plan and your output schema."*

**Q: "When does CoT hurt?"**

Simple lookups, structured classifiers, anywhere the answer is one token. The intent classifier in this codebase is exactly this — it doesn't ask for reasoning, it asks for one word. Adding "think step by step" to the intent classifier would cost tokens, slow latency, and risk drift (the model might say "thinking: ... → diagnostic" instead of just "diagnostic"). The rule: add CoT when you can *measure* a quality lift; otherwise you're paying for reasoning tokens without a return.

```
  add CoT when:                     skip CoT when:
  ────────────                      ─────────────
  multi-step reasoning              one-word output
  the work has a process            structured classifier
  cheaper models                    output already strong
  ↑ measured a quality lift         ↑ no measured benefit
```

Anchor: *"add CoT when you can measure the lift; skip when you can't. It's not free."*

**Q: "What's the load-bearing part?"**

Reasoning in a typed field, not in free prose preceding the answer. *(Pull up the schema with `hypothesesConsidered[*].reasoning`.)* If you let the model emit prose-then-JSON, your parser has to extract from a fence and might miss reasoning that contradicts the JSON. If you put the reasoning *inside* the JSON as a field, the structure stays clean, the reasoning is queryable, and you can show it in the UI as "hypotheses considered." The CoT is preserved, not discarded.

Anchor: *"reasoning belongs in a typed field, not before the JSON. Otherwise you're throwing away the chain of thought after it's done its work."*

## See also

- `01-anatomy.md` — CoT steps live in section 1 (system role) as the "approach" subsection.
- `02-structured-outputs.md` — CoT in a typed field (`hypothesesConsidered[*].reasoning`) is structured output preserving reasoning.
- `06-single-purpose-chains.md` — single-purpose chains keep the CoT structure small enough to enforce.
- `10-self-critique.md` — the next-level pattern; CoT is the model reasoning *through* the problem, self-critique is the model reasoning *about* its own answer.
