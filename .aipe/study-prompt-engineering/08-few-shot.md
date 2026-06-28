# 08 — Few-shot prompting

*In-context examples · Industry standard*

## Zoom out, then zoom in

Pull up the system prompt for any of the agents in this codebase. Few-shot examples — when there are any — live inside the system message, embedded in the "Output" section.

```
  Where few-shot examples sit in the prompt

  ┌─ system prompt (assembled from monitoring.md) ──────────────────┐
  │  ## Role                                                          │
  │  ## Hard rules                                                    │
  │  ## Period-over-period method                                     │
  │  ## Suggested query plan                                          │
  │  ## Tool catalog reminders                                        │
  │  ## Common errors to avoid                                         │
  │  ## Output                                                         │
  │    ┌──────────────────────────────────────────────────────────┐  │
  │    │ ★ FEW-SHOT EXAMPLE — one worked JSON output ★             │  │ ← we are here
  │    │ [                                                          │  │
  │    │   { "metric": "purchase_revenue",                          │  │
  │    │     "category": "revenue_drop",                            │  │
  │    │     "change": { "value": 30.0, "direction": "down", ... },│  │
  │    │     "severity": "critical", ... }                          │  │
  │    │ ]                                                          │  │
  │    └──────────────────────────────────────────────────────────┘  │
  │  ## Workspace schema                                              │
  └───────────────────────────────────────────────────────────────────┘
```

Few-shot is the cheapest reliability lever in prompt engineering, and the one most early-career prompt work skips. Concept 01 named the four sections; this concept is what goes in section 3 (examples) when "describe the shape in prose" isn't enough.

## Structure pass

**Layers.** Outer: the prompt as a whole. Middle: the examples section. Innermost: each individual example.

**Axis — how strongly does each prompt element constrain the output?** Walk it down:

```
  one axis — "how much does this part of the prompt constrain output?"

  ┌─ prose rule ───────────────────────┐
  │  "Return JSON in a code fence."     │  WEAK — model can drift
  └────────────────────────────────────┘
       ┌─ schema spec ──────────────────┐
       │  "Fields: name (string),        │  MEDIUM — constrains type,
       │   change.value (number)..."     │  doesn't constrain style
       └────────────────────────────────┘
            ┌─ worked example ───────────┐
            │  [{ "name": "purchase_revenue",│ STRONG — model copies the shape
            │     "change": {...} }]        │ AND the field-naming style AND
            └────────────────────────────┘   the value-formatting style
```

**Seams.** The boundary between "describing the shape in prose" and "showing a worked example" is a real engineering decision. Cheap to add an example — costs ~50–300 tokens. Pays back every call.

## How it works

### Move 1 — the mental model

You know how when you onboard onto a new codebase and you read the README first, then you read *the code* — and the code shows you a hundred conventions the README didn't name? Few-shot examples are the *code* version of prompt instructions. The prose says "return JSON"; the example shows the model what JSON looks like in *your* shape.

```
  Pattern — few-shot, the kernel

  prose instruction       worked example          model output
  ─────────────────       ──────────────         ─────────────
  "Return JSON in        [{                       [{
   this shape:            "metric": "...",         "metric": "purchase_revenue",
   metric (string),       "change": {              "change": {
   change.value           "value": 30.0,           "value": 23.4,
   (number), ..."         "direction": "down" }    "direction": "down" }
                         }]                       }]

  the prose tells the rule       the example shows the SHAPE
                                  → output mirrors the example
```

The mechanism: language models are trained on *next-token prediction*. When you show one worked example, the model is *much* more likely to emit tokens that look like that example than to invent a new style. This is the strongest constraint cheap money can buy.

### Move 2 — the walkthrough

**Step 1 — when to use few-shot.** Three situations where it earns its place:

  → **Classifiers.** The intent classifier in `lib/agents/intent.ts` is a good candidate (it doesn't have examples today; it could). One-word output with three valid values is exactly where a few examples lock in the shape.
  → **Format-sensitive output.** Anywhere you need a specific JSON shape, a specific date format, a specific punctuation convention. The monitoring prompt's worked example at `legacy-prompts/monitoring.md:72-85` is exactly this.
  → **Style-sensitive output.** When the model needs to write *in a specific tone* — the recommendation agent's `rationale` field benefits from an example because "good rationale" is a *style* the model has to copy.

Three situations where you skip it:

  → **Open-ended generation.** The query agent returns prose; if you showed an example, the model would copy the *content style* of that example, narrowing the range of valid answers. Free-form prose wants *no* anchoring example.
  → **Outputs where the shape is enforced by tools.** If you use Anthropic tool-calling for structured output, the schema is the contract; no need for an example.
  → **Outputs the model already does perfectly with prose rules alone.** Add examples when you measure a quality lift, not preemptively.

**Step 2 — what's in this codebase today.** Walk the four prompts:

```
  Examples in this codebase, by prompt

  ┌──────────────────┬───────────────────────────────────────────┐
  │ prompt           │ examples present?                          │
  ├──────────────────┼───────────────────────────────────────────┤
  │ monitoring.md    │ YES — 1 worked JSON output (lines 72-85)   │
  │ diagnostic.md    │ YES — 1 worked JSON output (lines 58-82)   │
  │                  │ + 1 "insufficient data" fallback example    │
  │                  │   (lines 91-98)                              │
  │ recommendation.md│ YES — 1 worked JSON output (lines 49-74)    │
  │ query.md         │ NO — open-ended prose; no example needed    │
  │ intent.ts        │ NO — system message is too short to embed    │
  │                  │   examples; one-word output, model handles   │
  └──────────────────┴───────────────────────────────────────────┘
```

The pattern: structured-output chains have one canonical worked example. The open-ended prose chain has none. The intent classifier could have examples but doesn't — that's a real opportunity (see Project Exercise below).

**Step 3 — the anatomy of a good worked example.** Look at `legacy-prompts/monitoring.md:72-85`:

```
[
  {
    "metric": "purchase_revenue",
    "category": "revenue_drop",
    "scope": ["global"],
    "change": { "value": 30.0, "direction": "down", "baseline": "90d" },
    "severity": "critical",
    "impact": "Revenue down 30% versus the prior 90 days on a baseline of ...",
    "evidence": [
      { "tool": "execute_analytics_eql",
        "result": { "metric": "purchase_revenue", "current": 4200000,
                    "prior": 6000000 } }
    ]
  }
]
```

Three things this example does right:

  → **Realistic content.** `purchase_revenue`, `revenue_drop`, `critical` are *plausible* values the model would emit for a real workspace. Not `"metric": "FOO"`.
  → **Demonstrates the harder fields.** `impact` is a written sentence — the example shows it as a *full sentence with numbers and business framing*, which is exactly the style the model is supposed to copy. Just saying "impact: a sentence describing impact" wouldn't lock in the style.
  → **Demonstrates `evidence` shape.** The nested `{ tool, result }` structure is non-trivial to describe in prose; the example *shows* it.

**Step 4 — when to add a second example.** Default: one good example. Reach for a second when:

  → **The output has two distinct shapes** the model should emit in different situations. The diagnostic prompt does this — the main shape (`legacy-prompts/diagnostic.md:58-82`) AND the empty-data fallback shape (lines 91-98):

```
If you cannot determine a cause, return:
```json
{
  "conclusion": "Insufficient data to determine a cause for this change.",
  "evidence": [],
  "hypothesesConsidered": []
}
```
```

This is the *graceful failure* example. Without it, the model might emit a half-formed diagnosis when the data was empty; with it, the model has a sanctioned escape valve.

  → **The model is regressing on a specific edge case.** Add an example targeting that case. The eval suite (concept 05) catches the regression; the second example fixes it.

**Step 5 — when to stop.** *Three to five good examples beats twenty mediocre ones.* This is the empirical rule. Marginal examples beyond ~5 cost tokens (each example is in the system prompt every call) without much quality lift. The exception is *evaluation*-driven addition — if your eval set shows the model regressing on a specific edge case and an example fixes it, add the example. If the eval doesn't show a lift, don't add it.

**The interaction with structured output (concept 02).** A few-shot example *is* the structured output's shape, demonstrated. If you use tool-calling for structured output (Anthropic's `tool_use` pattern), the tool schema serves the same role and you don't need a separate example. If you use the prose-and-validate pattern (this codebase), the example *is* the contract — concept 07 walks how the example, the type guard, and the consumer must agree.

**The cost.** Examples are in the system prompt every call. Concept 04 (token budgeting) is the discipline that decides if you can afford them. The monitoring example is ~250 tokens; that's 250 tokens × every call × forever. Worth it for reliability; not free.

### Move 3 — the principle

Examples constrain output more than rules do because language models are next-token predictors. Showing the shape locks the model into reproducing it; describing the shape leaves it to interpretation. The principle is the same as showing a junior engineer a worked code review instead of just describing the style guide — the worked example carries an order of magnitude more signal per token than the rules document.

## Primary diagram — few-shot in this codebase

```
  ┌─ legacy-prompts/monitoring.md ────────────────────────────────────────┐
  │  ## Output                                                              │
  │                                                                          │
  │  Return ONLY a JSON array of anomaly objects, ... wrapped in a ```json │
  │  fenced block:                                                          │
  │                                                                          │
  │  [                                                                       │
  │    {                                                                     │
  │      "metric": "purchase_revenue",      ← realistic content              │
  │      "category": "revenue_drop",                                          │
  │      "scope": ["global"],                                                │
  │      "change": { "value": 30.0, "direction": "down", "baseline": "90d" },│
  │      "severity": "critical",                                              │
  │      "impact": "Revenue down 30%..."  ← demonstrates the HARD field     │
  │      "evidence": [{ "tool": "..." }]   ← demonstrates nested shape       │
  │    }                                                                     │
  │  ]                                                                       │
  │                                                                          │
  │  Field rules:                                                            │
  │  - category — REQUIRED. the checklist `id` ...                           │
  │  - metric — short snake_case name ...                                    │
  │  ...                                                                     │
  └────────────────────────────────────────────────────────────────────────┘
                                  │
                                  │  model attends to the example
                                  │  more strongly than the field rules
                                  ▼
  ┌─ model output (next call) ────────────────────────────────────────────┐
  │  [                                                                     │
  │    {                                                                   │
  │      "metric": "conversion_rate",   ← copied the snake_case            │
  │      "category": "conversion_drop", ← copied the category id style    │
  │      "scope": ["country:US"],                                          │
  │      "change": { "value": 14.2, "direction": "down", "baseline": "90d" }│
  │      "severity": "warning",                                            │
  │      "impact": "Conversion rate fell 14%..."  ← copied the sentence    │
  │      "evidence": [{ "tool": "execute_analytics_eql", ... }]            │
  │    }                                                                   │
  │  ]                                                                     │
  └──────────────────────────────────────────────────────────────────────┘
```

## Elaborate

The few-shot pattern dates back to GPT-3's debut paper (Brown et al., 2020) — the original "in-context learning" demonstration. The mechanism the paper named — that examples in the prompt steer the model *without retraining* — is what every prompt-engineering technique downstream of it is built on. The paper's other contribution: *more examples diminish in return after the first few*. The 3–5-good-beats-20-mediocre rule traces back here.

Three nuances worth knowing:

- **Example ORDER matters.** Recent models attend more strongly to *the most recent* example in a prompt. If you have multiple, put the most-canonical-example last. This codebase only has one example per prompt, so order doesn't bite.
- **Bad examples are worse than no examples.** If you put a broken example in the prompt, the model copies the brokenness. This is a real bug — a deprecated field that lingers in a worked example gets emitted by every call until someone notices. The discipline: when you change the output schema, update the example *first*.
- **Examples interact with structured-output mode.** Provider-native structured outputs (OpenAI's `response_format: json_schema`) have the schema as the contract; the example becomes redundant. If you're using prose-and-validate (this codebase), examples carry their full weight.

Where to read next: the original GPT-3 paper for the foundational result. Anthropic's prompt-engineering docs on multi-shot prompting. Simon Willison has a running thread on when examples help vs hurt.

In this codebase, concept 01 (anatomy) is where section 3 (examples) lives. Concept 02 (structured outputs) is what the example is *demonstrating*. Concept 04 (token budgeting) is why you don't add 20 examples.

## Project exercises

### Exercise — Add few-shot examples to the intent classifier

  → **Exercise ID:** FEWSHOT-INTENT
  → **What to build:** Modify `lib/agents/intent.ts` (and the active path through `@aptkit/core`'s intent classifier if exposed) to include 3 few-shot examples in the system message — one example per Intent class (monitoring / diagnostic / recommendation). Each example is a one-line user query followed by the one-word answer.
  → **Why it earns its place:** The intent classifier is the *exact* case where few-shot is highest-leverage — one-word output with three valid values is what examples lock in. Today the prompt is rule-only (`"Classify ... as exactly one word: monitoring, diagnostic, or recommendation. Reply with ONLY the one word."`). Three examples would measurably improve reliability and bring the prompt in line with the other agents' patterns.
  → **Files to touch:** `lib/agents/intent-legacy.ts` (the legacy path, for prototype), then push the change into the AptKit prompt if the upstream supports it.
  → **Done when:** the classifier's system message includes "Examples:" followed by 3 lines like `"What's changed this week?" → monitoring`. A short eval (10 ambiguous queries) shows ≥0.9 agreement with hand-labelled answers.
  → **Estimated effort:** ~1 hour for the change; ~2 hours if also writing the 10-case eval.

### Exercise — Add an edge-case example to the recommendation prompt

  → **Exercise ID:** FEWSHOT-RECCO-EDGE
  → **What to build:** Add a second worked example to `lib/agents/legacy-prompts/recommendation.md` showing what to emit when the diagnosis is *inconclusive* (the diagnostic chain returned the FALLBACK Diagnosis). Today the recommendation agent has one example showing a confident, dollar-quantified recommendation; it's silent on what to do when there's nothing to act on.
  → **Why it earns its place:** Concept 02's empty-state escape valve is missing from this prompt. Without the example, the model invents recommendations or returns an empty array silently — neither is great. With an example showing "given inconclusive diagnosis, propose ONE low-effort investigative action with explicit `confidence: low`," the model has a sanctioned shape for the edge case.
  → **Files to touch:** `lib/agents/legacy-prompts/recommendation.md`.
  → **Done when:** the prompt has a clearly-labelled second example (`"If the diagnosis was inconclusive, return:"`) and a run against a fallback Diagnosis produces a low-confidence investigative recommendation rather than `[]`.
  → **Estimated effort:** ~30 minutes.

## Interview defense

**Q: "When do you reach for few-shot?"**

Three cases. *(List them.)* Classifiers — where the output is short and the valid range is small. Format-sensitive output — JSON shapes, date formats, anywhere the model needs to produce *exactly* a structure. Style-sensitive output — when the model needs to *write* in a specific tone, the example carries the style. Three cases to skip: open-ended generation (don't anchor it), tool-calling-as-output (the schema is the contract), outputs the model already nails with rules alone (don't pay for what you don't need).

```
  use few-shot:                   skip few-shot:
  ─────────────                   ─────────────
  classifiers                      open-ended generation
  format-sensitive output          tool-calling-as-output
  style-sensitive output           outputs already nailed by rules
```

Anchor: *"examples constrain output more than rules do, because models are next-token predictors. Show the shape, don't describe it."*

**Q: "How many examples?"**

Three to five good examples beats twenty mediocre ones. Default to one — this codebase's monitoring, diagnostic, and recommendation prompts all use exactly one worked example. Add a second when the output has two distinct shapes (success and graceful failure — the diagnostic prompt has both). Add a third when an eval shows the model regressing on a specific edge case the third example targets. Stop when adding more doesn't lift the score.

Anchor: *"one good example wins. Add the second when there's a second valid shape. After that, only add what the eval set proves earns its place."*

**Q: "What's the failure mode?"**

Bad examples are *worse* than no examples. If a deprecated field lives in your worked example, the model copies the deprecation. The discipline: when you change the output schema, update the example *first*, before the type guard, before the consumer. The example IS the contract; if it's wrong, the contract is wrong.

```
  schema change checklist:
  1. update the worked example in the .md prompt
  2. update the type guard in lib/mcp/validate.ts
  3. update the consumer(s)
  4. ship
```

Anchor: *"the example is the contract. Bad examples are worse than no examples — the model copies the brokenness."*

## See also

- `01-anatomy.md` — section 3 (examples) is exactly this concept; the four-section anatomy is where few-shot lives.
- `02-structured-outputs.md` — the example shows the JSON shape; the type guard enforces it; together they're the contract.
- `04-token-budgeting.md` — examples are in the system prompt every call; concept 04 is the discipline that decides if you can afford them.
- `05-eval-driven-iteration.md` — when to add a second/third example is an eval-driven decision; not by vibes.
- `07-output-mode-mismatch.md` — when the example, the type guard, and the consumer disagree, that's a mismatch.
