# 09 · Chain-of-thought (CoT)

**Chain-of-thought / step-by-step reasoning / hypothesize-then-answer — Industry standard**

## Zoom out, then zoom in

The classic 2022-era instruction "let's think step by step" is largely subsumed by modern models doing chain-of-thought internally. What's left is the specific case where the reasoning shape has to be *explicit and traceable* — where you want the model to hypothesize before concluding, cite evidence before asserting, or consider rivals before picking. This codebase's diagnostic prompt uses exactly that shape: "Generate 2-3 hypotheses before the first tool call. Query to falsify each hypothesis. Conclude with the hypothesis that best fits the evidence." That's structured CoT, and it earns its tokens because the hypothesesConsidered array is part of the downstream artifact.

```
  Zoom out — where CoT sits

  ┌─ Chain-of-thought applied ──────────────────────────────┐
  │  diagnostic prompt: "generate 2-3 hypotheses before…"    │
  │  → emissions have hypothesesConsidered[] array           │
  │  → each hypothesis has supported flag + reasoning        │
  └────────────────────────┬────────────────────────────────┘
                           │
  ┌─ Chain-of-thought absent ─▼─────────────────────────────┐
  │  intent classifier: "reply with ONLY the one word"       │
  │  → CoT would burn tokens for a single-word output        │
  │  → this codebase correctly skips it                      │
  └─────────────────────────────────────────────────────────┘

  ┌─ Modern internal CoT (Sonnet 4.6) ──────────────────────┐
  │  the model does chain-of-thought internally without     │
  │  being asked. Frontier models don't need "let's think    │
  │  step by step" as a magic incantation.                   │
  └─────────────────────────────────────────────────────────┘
```

**Zoom in.** CoT has two forms. **Internal CoT** — the model does step-by-step reasoning implicitly and emits the answer. This is what modern models do by default. **Structured CoT** — the prompt requires the reasoning to be explicit as an emitted artifact (a `hypothesesConsidered` array, a `reasoning` field, a "thinking" scratchpad). This is what earns tokens in production. In this codebase, structured CoT is *the* diagnostic method — the hypotheses are outputs, not just internal steps.

## Structure pass

### Axes — the dimension we're tracing

**Is the reasoning an artifact or a scratchpad?** For a classifier, reasoning is a scratchpad the user never sees, and asking for it is pure token cost. For a diagnostic investigation where the user reads the hypotheses and their rationales, the reasoning IS the artifact and asking for it explicitly is required.

### Seams — where CoT flips utility

Three seams:

- **Simple lookup vs multi-step reasoning** — for the classifier, one word out, no CoT. For the diagnosis, multi-hypothesis reasoning, structured CoT.
- **Free-form CoT vs structured CoT** — free-form CoT ("let's think step by step" + then the answer) wastes tokens on prose the parser has to strip. Structured CoT (reasoning as a named field in the output shape) is parseable and downstream-usable.
- **Internal CoT vs elicited CoT** — modern models do CoT internally; asking them to CoT explicitly is redundant *unless* you want the reasoning as an artifact.

### Layered decomposition

"Why does the reasoning exist?" — traced across altitudes:

```
  "Why does the reasoning exist here?" — same question, three altitudes

  ┌────────────────────────────────────────────────┐
  │ outer: the user's need                          │  → user wants to see
  │                                                 │    WHY the agent
  │                                                 │    concluded what it did
  └────────────────────────────────────────────────┘
      ┌────────────────────────────────────────────┐
      │ middle: the artifact shape                  │  → Diagnosis.hypothesesConsidered
      │                                             │    is a first-class field
      └────────────────────────────────────────────┘
          ┌────────────────────────────────────────┐
          │ inner: the prompt's method              │  → "Generate 2-3 hypotheses
          │                                          │    before the first tool call"
          └────────────────────────────────────────┘
```

The user need drives the artifact shape, which drives the prompt's CoT requirement. If the user need was "one word answer," the whole CoT chain evaporates.

## How it works

### Move 1 — the mental model

You know how a code review comment "why did you pick this approach?" is more useful when you can see the alternatives the author considered — because reading the rejected options is what makes the chosen one credible? Structured CoT is that discipline for LLM outputs. The `hypothesesConsidered` array is the "alternatives considered" section of a diagnosis; without it, the conclusion is just a claim.

```
  Structured CoT — the pattern

  ┌── prompt shape ─────────────────────────────────────────┐
  │  "Generate 2-3 hypotheses before the first tool call.   │
  │   Query to falsify each hypothesis.                     │
  │   Conclude with the hypothesis that best fits."          │
  └────────────────────────┬────────────────────────────────┘
                           │
  ┌── model reasons ───────▼────────────────────────────────┐
  │  1. hypothesize (2-3 candidates)                        │
  │  2. query tools to test each                             │
  │  3. update hypotheses with evidence                      │
  │  4. pick the best-supported one                          │
  │  5. emit ALL hypotheses in the output                    │
  └────────────────────────┬────────────────────────────────┘
                           │
  ┌── output shape ────────▼────────────────────────────────┐
  │  {                                                       │
  │    "conclusion": "…",                                    │
  │    "evidence": ["…"],                                    │
  │    "hypothesesConsidered": [                             │
  │      { "hypothesis": "…", "supported": true,  "reasoning": "…" },│
  │      { "hypothesis": "…", "supported": false, "reasoning": "…" },│
  │    ]                                                     │
  │  }                                                       │
  └─────────────────────────────────────────────────────────┘

  the CoT is IN THE ARTIFACT, not just in the model's head
```

### Move 2 — the step-by-step walkthrough

**Step 1 — the prompt names the reasoning method.**

`@aptkit/prompts/dist/src/diagnostic.js:14-19`:

```
Recommended approach:
1. Generate 2-3 hypotheses before the first tool call.
2. Query to falsify each hypothesis.
3. Spend one call locating when the change happened with a time-series query when such a tool exists.
4. Conclude with the hypothesis that best fits the evidence.
```

Four steps. Note the ordering: hypothesize *before* querying. That's the key discipline — a model that queries first and hypothesizes later ends up justifying whatever it happened to find. A model that hypothesizes first and queries to falsify each candidate is doing science. In interview terms, this is the difference between confirmation bias and hypothesis testing.

The "falsify" verb is deliberate. "Confirm" would let the model gather selective evidence for its favorite hypothesis. "Falsify" pushes it to try to *disprove* candidates, and whichever survives is the best-supported.

**Step 2 — the output schema embeds the CoT as an emitted artifact.**

Same file, lines 26-38:

```
Return ONLY a JSON object in a \`\`\`json fenced block with this shape:

{
  "conclusion": "string",
  "evidence": ["string"],
  "hypothesesConsidered": [
    { "hypothesis": "string", "supported": true, "reasoning": "string" }
  ],
  ...
}
```

`hypothesesConsidered` is a first-class field. Each hypothesis has three parts: the claim, whether it was supported, and the reasoning. The `supported: true` field is the *falsification result* — the model's answer to "did the evidence support or contradict this hypothesis?" The `reasoning` field is the *rationale* — the evidence-anchored argument.

```
  hypothesis object — three parts, three purposes

  ┌── hypothesis: "string" ────────┐  → the claim the agent tested
  ├── supported: true | false ────┤  → the falsification verdict
  └── reasoning: "string" ─────────┘  → the evidence-anchored rationale
```

**Step 3 — the ReAct loop makes this real.**

`@aptkit/core`'s DiagnosticInvestigationAgent runs a ReAct loop (Reason-Act-Observe). Each turn: the model reasons, calls a tool, observes the result, updates hypotheses. The prompt's "recommended approach" is what makes the reasoning follow the hypothesize → falsify → conclude shape rather than the querying-guided-by-vibes shape.

```
  ReAct loop with structured CoT

  turn 1  reason:  "I have 3 candidate hypotheses: (a) payment,
                    (b) UX regression, (c) upstream traffic."
          act:     get_metric_timeseries('payment_failure_rate', 'mobile SP')
          observe: payment_failure_rate rose 31.2%

  turn 2  reason:  "(a) is supported. Test (b): check checkout_step drop
                    location."
          act:     get_event_segmentation('checkout', ['checkout_step'])
          observe: checkout_step distribution unchanged

  turn 3  reason:  "(b) not supported. Test (c): upstream funnel."
          act:     get_event_segmentation('view_item', …)
          observe: view_item unchanged

  turn 4  conclude: "Payment processor issue on mobile-SP-credit_card."
          emit:    { conclusion, evidence, hypothesesConsidered:[…3…] }
```

The evidence for each hypothesis lives in the tool_calls; the emitted `hypothesesConsidered` array is the summary of what the loop tested. This is CoT as an artifact — the reasoning trace is preserved for the user (and for the eval rubric — see step 5).

**Step 4 — the rubric scores the reasoning explicitly.**

`eval/rubrics/diagnosis-quality.ts:25-38`:

```ts
{
  id: 'root_cause_plausibility',
  label: 'Root-cause plausibility',
  description: 'Does the conclusion name a plausible mechanism (not just a symptom restatement)? A conclusion that says "conversion dropped because conversion dropped" is a 1. A conclusion that names a specific mechanism supported by the evidence is a 5.',
  scale: [
    { score: 1, description: 'Restates the symptom; no mechanism named.' },
    { score: 2, description: 'Vague mechanism, no evidence link.' },
    { score: 3, description: 'Plausible mechanism, weakly evidenced.' },
    { score: 4, description: 'Specific mechanism, evidence supports it.' },
    { score: 5, description: 'Specific mechanism, evidence directly supports it, and rival mechanisms are considered.' },
  ],
},
```

The rubric's top score (5) explicitly rewards "rival mechanisms are considered." That reward loop is what closes the CoT discipline: the model is prompted to hypothesize, the output schema demands the hypotheses, and the eval rubric rewards showing that rival hypotheses were considered. All three layers pull in the same direction.

**Step 5 — where CoT is deliberately absent.**

The intent classifier (`@aptkit/agent-query/dist/src/intent.js:13`):

```
'Classify the user query as exactly one word: monitoring, diagnostic, or recommendation. Reply with ONLY the one word.'
```

No CoT. Not "let's think step by step about which category this falls into." Just the instruction and the three allowed outputs. Why? Because the classifier's output is one word, and asking for reasoning would (a) add tokens the parser has to strip, (b) risk the model emitting the reasoning *without* the word, (c) not improve the classification accuracy on a task that's already well-specified. Modern Haiku does the reasoning internally; asking it to emit the reasoning would be a token tax with no signal benefit.

```
  When CoT is a token tax

  simple lookup / single-word output   →  no CoT, model handles internally
  structured classifier                 →  no CoT, output is the classification
  arithmetic / logic puzzle              →  YES CoT, complex intermediate steps
  multi-hypothesis reasoning            →  YES structured CoT, hypotheses are output
```

**Step 6 — the interaction with structured output.**

If you want both **reasoning** and **a structured answer**, the reasoning goes in a field of the structured output — not in free-form prose before the JSON. Free-form prose before JSON breaks the parser (see `02-structured-outputs.md`) and is the classic "the model was courteous and prefaced its JSON" bug. Structured CoT lives *inside* the JSON as a named field, so the parser reads the whole thing as one artifact.

```
  WRONG — CoT as prose before JSON:                RIGHT — CoT as field in JSON:

  Let me think step by step. First,                {
  I'll consider payment processor issues.           "reasoning": "First consider payment
  Then UX regressions. Then upstream               processor. Then UX regressions. …",
  traffic. Payment failures rose 31.2%             "conclusion": "Payment processor issue",
  in the same window, so (a) is supported.          "hypothesesConsidered": [ … ]
                                                    }
  ```json
  { "conclusion": "…", … }
  ```

  parser has to strip the prose;                   parser reads the whole JSON
  courteous drift breaks parsing                    reasoning is a first-class field
```

### Move 2 variant — the load-bearing skeleton

The kernel of structured CoT is four moves:

```
  hypothesize before act → falsify each → emit reasoning in schema → reward in rubric
```

What breaks if you skip each:

- **Skip "hypothesize before act"** — the model queries first and reasons after. The reasoning becomes post-hoc justification of whatever was found.
- **Skip "falsify each"** — the model confirms its favorite hypothesis with selective evidence. Rival hypotheses get lip service.
- **Skip "emit reasoning in schema"** — the CoT stays in the model's head. The user sees the conclusion but not the reasoning; the eval can't score the reasoning; the audit trail is missing the "why."
- **Skip "reward in rubric"** — the model finds shortcuts. Emitting one plausible-sounding hypothesis and calling it a day scores as well as considering three. The rubric's "rival mechanisms are considered" scale level is what makes the reward loop close.

Hardening layered on top: explicit falsification prompts per hypothesis, self-critique loops (see `10-self-critique.md`), CoT-in-the-open (Anthropic's `thinking` blocks that stream reasoning to the user in real time).

### Move 3 — the principle

**CoT earns its tokens when the reasoning is an artifact the user, the eval, or the next stage reads.** If nobody reads the reasoning, you're paying for it and getting nothing. Modern models do CoT internally by default; the choice is whether to emit that reasoning as a first-class output. Emit when the audit trail matters; skip when the output is a single answer.

## Primary diagram

```
  Structured CoT in the diagnostic agent — the full loop

  ┌── prompt method ────────────────────────────────────────┐
  │  "Generate 2-3 hypotheses before the first tool call.   │
  │   Query to falsify each hypothesis.                     │
  │   Conclude with the hypothesis that best fits."          │
  └────────────────────┬────────────────────────────────────┘
                       │
  ┌── ReAct loop ──────▼────────────────────────────────────┐
  │  turn 1: reason (hypothesize) → act (query) → observe   │
  │  turn 2: reason (falsify h1)  → act (query) → observe   │
  │  turn 3: reason (falsify h2)  → act (query) → observe   │
  │  turn 4: conclude (pick supported h) → emit             │
  └────────────────────┬────────────────────────────────────┘
                       │
  ┌── output schema ───▼────────────────────────────────────┐
  │  {                                                       │
  │    "conclusion": "…",                                    │
  │    "evidence": ["…"],                                    │
  │    "hypothesesConsidered": [                             │
  │      {"hypothesis":"…","supported":true, "reasoning":"…"},│
  │      {"hypothesis":"…","supported":false,"reasoning":"…"},│
  │      {"hypothesis":"…","supported":false,"reasoning":"…"} │
  │    ]                                                     │
  │  }                                                       │
  └────────────────────┬────────────────────────────────────┘
                       │
  ┌── consumer ────────▼────────────────────────────────────┐
  │  UI:   EvidencePanel renders hypotheses as collapsible  │
  │  Eval: rubric scores "rival mechanisms considered" → 5   │
  │  Next: RecommendationAgent reads the supported h        │
  └─────────────────────────────────────────────────────────┘
```

## Elaborate

The classic Wei et al. 2022 paper "Chain-of-Thought Prompting Elicits Reasoning" is what named the technique. What that paper measured was a real effect on GPT-3-era models where explicit CoT lifted accuracy on multi-step reasoning tasks by 10-30 points. Modern models (Sonnet 4.6, GPT-4.5, Gemini 2) have absorbed that discipline into their pretraining and post-training — they CoT internally by default. The residue of the technique is (a) structured CoT for artifact-shaped outputs, and (b) explicit CoT for cheaper/older models where internal reasoning is weaker.

Anthropic's `thinking` blocks (introduced 2025) are the vendor-side answer to CoT: the model streams its internal reasoning as a special block that the API surfaces separately from the final answer. This is a middle ground between "reasoning in the model's head" (no observability) and "reasoning in the output JSON" (parseable but not real-time). This codebase does not currently use `thinking` blocks — the reasoning is emitted in `hypothesesConsidered` after the loop concludes, not streamed live during it.

Two failure modes I've watched:

- **The "reasoning-only" bug.** The prompt asks for reasoning and then the answer. The model emits paragraphs of reasoning and forgets the answer entirely, or runs out of `max_tokens` mid-thought. Fix: structured CoT with the reasoning as a *bounded* field (`reasoning: string`, not "explain your reasoning in detail").
- **The "confidence-inflating" bug.** The model's reasoning includes phrases like "I am highly confident that..." and every conclusion is inflated. Fix: don't let the model emit its own confidence in prose. Give it a `confidence: high | medium | low` enum and constrain the choice.

Related concepts:
- **Few-shot** (`08-few-shot.md`) — few-shot of *reasoning* is a related pattern (show the model an example of the reasoning shape).
- **Self-critique** (`10-self-critique.md`) — the natural extension when reasoning quality matters even more.
- **Structured outputs** (`02-structured-outputs.md`) — reasoning-as-a-schema-field is structured output for reasoning.
- **Eval-driven iteration** (`05-eval-driven-iteration.md`) — how you know CoT is earning its tokens.

## Interview defense

**Q: When does chain-of-thought earn its tokens in a production system, and when doesn't it?**

Earns its tokens when the reasoning IS an artifact — read by the user, scored by an eval, consumed by the next stage. This codebase's diagnostic agent emits `hypothesesConsidered` as a first-class array; the UI renders it as collapsible hypothesis cards, the eval rubric scores whether rival mechanisms were considered, the audit trail preserves the reasoning. Doesn't earn its tokens when the output is a single answer (classifier) or when the reasoning is scratchpad the caller throws away. In this codebase the intent classifier deliberately has no CoT — the output is one word, and asking for reasoning would burn tokens for no downstream benefit.

```
  Decision — CoT yes/no

  is the reasoning read downstream?
   ├── yes (user, eval, next stage) → structured CoT
   └── no (scratchpad thrown away)  → skip, model does it internally
```

Anchor: diagnostic prompt at `@aptkit/prompts/dist/src/diagnostic.js:14-19`; intent classifier at `@aptkit/agent-query/dist/src/intent.js:13`.

**Q: Free-form CoT before a JSON output — what breaks?**

The parser. The model emits reasoning as prose, then the JSON in a fence. If the parser looks for the fence first (as `parseAgentJson` does at `lib/mcp/validate.ts:3-13`), it recovers. If the parser is stricter — say "start of body must be JSON" — the reasoning prose breaks it. The fix is structured CoT: put the reasoning in a `reasoning` field *inside* the JSON. Then the whole output is one artifact, parseable and readable. This codebase does exactly that — the diagnostic emits `hypothesesConsidered[i].reasoning` as a string inside the JSON.

```
  Free-form CoT vs structured CoT — where the parser lives

  free-form CoT:                        structured CoT:
    "Let me think step by step…"          {
    "First consider payment…"               "hypothesesConsidered": [
    "Then UX…"                                {"reasoning":"consider payment…"},
    ```json                                   {"reasoning":"consider UX…"}
    { "conclusion": "…" }                    ],
    ```                                     "conclusion": "…"
                                            }
  parser: strip prose then parse         parser: parse the whole thing
                                          reasoning is a field, not a preface
```

**Q: What's the load-bearing part people forget?**

The falsification framing. "Consider three hypotheses" gets you three hypotheses of which one is confirmed with cherry-picked evidence. "Falsify each hypothesis" gets you three hypotheses each tested to fail, and whichever survives is genuinely supported. The verb matters. Every production diagnostic prompt I've shipped has needed the falsification framing, and every one where I said "consider" instead of "falsify" produced confirmation-bias-flavored outputs.

Anchor: diagnostic prompt at `@aptkit/prompts/dist/src/diagnostic.js:16` — the exact phrasing is "Query to falsify each hypothesis." The falsify verb is doing the work.

## See also

- `05-eval-driven-iteration.md` — how the rubric closes the CoT reward loop.
- `08-few-shot.md` — few-shot of reasoning as a related pattern.
- `10-self-critique.md` — the natural extension when reasoning quality matters more.
- `02-structured-outputs.md` — reasoning-as-schema-field.
