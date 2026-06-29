# Few-shot prompting

**Industry standard** · examples that constrain output

## Zoom out — where examples live in this codebase

Three of blooming's four structured-output prompts (monitoring, diagnostic, recommendation) carry a worked output example inside the `## Output` section. The fourth, query, doesn't — because prose doesn't need an example to constrain its shape. The intent classifier has its "examples" embedded in the prompt as parenthetical hints (`monitoring (what changed / what is new)`). Each choice is deliberate.

```
  Zoom out — examples per prompt template

  ┌─ Prompt templates ──────────────────────────────────────┐
  │  monitoring.md:73-85                                     │
  │    └─ 1 worked Anomaly object, full schema               │
  │  diagnostic.md:60-81                                     │
  │    └─ 1 worked Diagnosis object, full schema             │
  │  recommendation.md:51-74                                 │
  │    └─ 1 worked Recommendation object, full schema        │
  │  query.md                                                │
  │    └─ no example (prose mode)                            │
  │  intent prompt (inline in intent.ts:29-31)               │
  │    └─ inline hints: monitoring/diagnostic/recommendation │
  └─────────────────────────────────────────────────────────┘
```

## Zoom in

Few-shot examples constrain output more than instructions do. You can write "return JSON with these fields" three different ways and get three slightly different shapes; you can show *one example object* and get that shape back, every time. The pattern works because the model is trained to match patterns in its context — and an example is a denser, more legible pattern than a list of rules. The cost: examples consume context tokens. The discipline: pick examples that pin the shape, not examples that pin the answer.

## Structure pass

**Layers.** Two: the *instruction layer* (the prose rules in `## Output` or `## Hard rules`) and the *example layer* (the worked object inside a ```json fence).

**Axis traced — leverage.** Hold one question constant: *for a given token spend, which gives the model more clarity about the output shape?*

```
  Axis = leverage — what gives the most shape per token?

  ┌─ prose rules ────────────────────────────────────────────┐
  │   "severity is one of critical, warning, info, positive"  │
  │   "change.value is a positive number"                     │
  │   "wrap in a ```json fence"                               │
  │     ~30 tokens, easy to misinterpret                      │
  │     "is it 'positive number' or 'positive integer'?"      │
  └──────────────────────────────────────────────────────────┘
                              │  vs
  ┌─ one worked example ─────▼───────────────────────────────┐
  │   { "severity": "critical", "change": { "value": 30.0 }, │
  │     ... }                                                 │
  │     ~120 tokens, zero ambiguity                           │
  │     the example IS the spec                               │
  └──────────────────────────────────────────────────────────┘
```

**Seams.** The instruction → example seam is where the model resolves ambiguity. When the rules say "severity is one of four values" and the example shows `"severity": "critical"`, the model has both the constraint and the canonical form. Instructions without examples force the model to invent the form; examples without instructions don't tell the model what's required vs optional. Both belong; the example is the load-bearing one.

## How it works

### Move 1 — what an example does that an instruction can't

You know how a TypeScript type definition is *one shape* but the comments around it explain *what each field means*? Few-shot examples are the type. The instructions around them are the doc-comments. The model reads both; the type does the constraining; the comments do the explaining.

```
  Pattern — example as the constraint, instructions as the gloss

  ┌─────────────────────────────────────────────────────────┐
  │  ## Output                                               │
  │                                                          │
  │  Return ONLY a JSON array of anomaly objects... wrapped  │ ← what to do
  │  in a ```json fenced block:                              │
  │                                                          │
  │  [                                                       │
  │    {                                                     │ ← THE example
  │      "metric": "purchase_revenue",                       │   (the constraint)
  │      "category": "revenue_drop",                         │
  │      "scope": ["global"],                                │
  │      "change": {                                         │
  │        "value": 30.0,                                    │
  │        "direction": "down",                              │
  │        "baseline": "90d"                                 │
  │      },                                                  │
  │      "severity": "critical",                             │
  │      "impact": "Revenue down 30% versus...",             │
  │      "evidence": [...]                                   │
  │    }                                                     │
  │  ]                                                       │
  │                                                          │
  │  Field rules:                                            │ ← the gloss
  │  - `category` — REQUIRED. the checklist `id` ...         │
  │  - `severity` — `"critical"` (>20%), `"warning"` ...     │
```

The example pins everything that's hard to specify in prose: exact field names, exact nesting, exact JSON syntax, exact string casing (`"down"` not `"DOWN"`, `"critical"` not `"Critical"`), exact wrapping (the ```json fence). The field rules pin everything that's easy to specify in prose: which fields are required, what each one means, what range the value should be in.

### Move 2 — the worked Anomaly object, annotated

Open `lib/agents/legacy-prompts/monitoring.md` at line 73. The example object that lives there is doing six jobs at once:

```
  monitoring.md:73-85 — one example, six jobs

  ┌─────────────────────────────────────────────────────────┐
  │  [                                                       │ ← job 1: array wrapper
  │    {                                                     │
  │      "metric": "purchase_revenue",                       │ ← job 2: snake_case names
  │      "category": "revenue_drop",                         │ ← job 3: a real category id
  │      "scope": ["global"],                                │ ← job 4: array of strings
  │      "change": {                                         │ ← job 5: nested object
  │        "value": 30.0,                                    │      → positive number
  │        "direction": "down",                              │      → enum value
  │        "baseline": "90d"                                 │      → string slug
  │      },                                                  │
  │      "severity": "critical",                             │ ← job 6: matched to value
  │      "impact": "Revenue down 30%...",                    │      (>20% → critical)
  │      "evidence": [                                       │
  │        { "tool": "execute_analytics_eql",                │
  │          "result": { "metric": "...",                    │
  │                      "current": 4200000,                 │
  │                      "prior": 6000000 } }                │
  │      ]                                                   │
  │    }                                                     │
  │  ]                                                       │
  └─────────────────────────────────────────────────────────┘
```

Each part of the example is doing real work. The example chooses the magnitudes to match the rule (`30%` triggers `critical` per the rules; if the example were `5%` with `severity: critical`, the model would learn the wrong threshold). The `evidence` structure shows the model that `result` is a free-form object with arbitrary shape, not a fixed schema. The `category` field shows what kind of value goes there (snake_case slug, not a random string).

### Move 2 — when examples constrain more than instructions

The "respond only in JSON" anti-pattern is the contrast worth holding. You write:

```
  Don't do this in 2026:

  ## Output
  Respond only in valid JSON, exactly matching this format:
  - `metric` is a string
  - `severity` is one of: critical, warning, info, positive
  - `change` is an object with value, direction, baseline
  ...

  Make sure your response is parseable. Do not include any
  text outside the JSON. Be valid JSON.
```

And you get: roughly 90% of calls return JSON. The other 10% return JSON wrapped in markdown code fences, JSON with a chatty preamble ("Here's the anomaly:..."), JSON with trailing prose ("Let me know if you need more!"), or invalid JSON because the model put a comment in. Each is the model trying to be helpful in a way the instruction didn't anticipate.

The example-based version:

```
  Do this:

  ## Output
  Return ONLY a JSON array ... wrapped in a ```json fenced block:

  [
    { "metric": "...", "severity": "critical", ... }
  ]
```

Now the model has seen the wrapper (```json fence), the shape (array of objects), the casing, the punctuation. Compliance jumps because the model is *pattern-matching to the example*, not interpreting prose rules. Internet advice from 2022 was "tell the model to be valid JSON." Internet advice from 2024+ is "show the model an example of valid JSON." The example wins not because the instruction is wrong but because it's underspecified.

### Move 2 — the intent classifier's inline-hint version

The intent classifier doesn't have a JSON example because its output isn't JSON. But it does have something example-shaped — inline parenthetical hints:

```
  // lib/agents/intent-legacy.ts:29-31
  system:
    'Classify the user query as exactly one word: ' +
    'monitoring (what changed / what is new), ' +
    'diagnostic (why did something happen), or ' +
    'recommendation (what should I do). Reply with ONLY the one word.',
```

Each label has a paraphrase of what it means. That's not a few-shot example in the strict sense (no input/output pair), but it serves the same function: pinning what each label *covers*. Without the parentheses, the model might classify "what's the conversion rate?" as `diagnostic` (because it sounds like a question about a number); with the parentheses, "what changed" anchors it to `monitoring`.

True few-shot for this classifier would look like:

```
  Examples:
    Q: "What's our revenue this month?"      → monitoring
    Q: "Why did mobile drop yesterday?"      → diagnostic
    Q: "Should we send a recovery email?"    → recommendation
```

It would cost ~40 more tokens per call. The inline-hint version costs ~15 and gets you most of the benefit. For a 16-max-token classifier, the cost matters; for a 4096-token agent, it wouldn't.

### Move 2 — when NOT to use few-shot

The query agent doesn't have a JSON example because its output is prose. Showing the model a worked answer ("Here's an example of a good answer: 'Conversion rate fell 18% in the US last week.'") would *narrow* the model's response style — it would parrot the example's structure and tone. For prose generation where the answer shape depends on the question shape, examples hurt more than they help.

The rule: few-shot examples constrain output. That's good when you want constraint (structured output, classifier labels, format-sensitive fields). It's bad when you want flexibility (open-ended generation, prose answers to varying questions). blooming uses examples in every place where shape matters and skips them in the one place where shape doesn't.

### Move 2 — the cost-per-example math

Three examples cost roughly 3× the tokens of one example, and they don't add 3× the value. The marginal benefit of the second example is real (it shows the shape with different content, so the model learns "the shape is invariant"); the marginal benefit of the third is small (the model already has the shape pinned); the marginal benefit of the tenth is near zero.

```
  Few-shot diminishing returns

  examples  │  shape clarity  │  prompt token cost  │  ROI
  ──────────┼─────────────────┼─────────────────────┼──────
  0         │  low (guess)    │  0                  │  bad
  1         │  high           │  ~120               │  great
  3         │  very high      │  ~360               │  good
  5         │  marginal +     │  ~600               │  ok
  20        │  near zero +    │  ~2400              │  bad
```

blooming uses one example per structured agent. The data the codebase has (committed demo snapshots) suggests this is enough — the rejected-output rate at the type guard is low (when the guards reject, it's mostly because of edge cases the example didn't cover, not because of basic shape mismatch). Adding a second example would mostly be insurance for edge cases; adding ten would be wasteful.

The spec's rule of thumb — "3–5 good examples beats 20 mediocre ones" — applies to classifiers where coverage matters (one example per class). For shape constraints, even one example is usually enough.

### Move 2 — the few-shot + structured-output interaction

The most interesting use of few-shot in this codebase is that *the example IS the structured-output contract*. The `## Output` section's worked Anomaly object simultaneously:

- declares the schema (every field appears)
- pins the wrapping (```json fence)
- provides the few-shot demonstration (the model pattern-matches)
- doubles as documentation (a human reading the prompt understands what comes back)

That's four jobs in one block of code. The discipline that makes it work: the example matches the type guard exactly. If the type guard requires `category`, the example has `category`. If the type guard allows `impact` to be optional, the example *still includes it* — because showing it teaches the model to produce it. The example is more generous than the guard; the guard is more lenient than the example. Both agree on what's required.

### Move 3 — the principle

Few-shot examples are the highest-leverage tool in the prompt-engineering toolkit when output shape matters. One worked example pins shape better than ten lines of prose rules; the cost is ~100 tokens per call; the benefit compounds with every call (consistent output, low parser failure rate, easy code review). Use examples wherever shape matters; skip them where flexibility matters. The choice is per-prompt, not per-codebase.

## Primary diagram

```
  Few-shot in blooming — example placement, why each is the way it is

  ┌─ monitoring.md ───────────────────────────────────────────┐
  │  ## Output                                                 │
  │  ┌─ INSTRUCTIONS ────────────────────────────────────┐    │
  │  │ "Return ONLY a JSON array ... wrapped in ```json" │    │
  │  └────────────────┬──────────────────────────────────┘    │
  │                   │                                        │
  │  ┌─ EXAMPLE (the few-shot) ───────────────────────────┐   │
  │  │ [                                                   │   │
  │  │   { "metric": "purchase_revenue",                   │   │
  │  │     "category": "revenue_drop",                     │   │
  │  │     "change": { "value": 30, "direction": "down",   │   │
  │  │                 "baseline": "90d" },                │   │
  │  │     "severity": "critical",  ← magnitude matches    │   │
  │  │     "impact": "Revenue down 30%..." }               │   │
  │  │ ]                                                   │   │
  │  └─────────────────────────────────────────────────────┘   │
  │  ┌─ FIELD RULES (the gloss) ─────────────────────────┐    │
  │  │ "- severity — critical (>20%), warning (10-20%)..."│    │
  │  └────────────────────────────────────────────────────┘    │
  └────────────────────────────────────────────────────────────┘

  ┌─ intent (intent-legacy.ts:29-31) ──────────────────────────┐
  │  inline parenthetical hints, not full examples              │
  │  "monitoring (what changed)..."                             │
  │  → fits the 16-token budget                                 │
  └────────────────────────────────────────────────────────────┘

  ┌─ query.md ─────────────────────────────────────────────────┐
  │  NO example — prose output, examples would narrow voice    │
  └────────────────────────────────────────────────────────────┘

  pattern: examples where shape matters · skip where flexibility matters
```

## Elaborate

The "respond only in JSON" anti-pattern is canonical because it was good advice in 2022 and bad advice by 2024. Models in 2022 needed the instruction because they hadn't been trained heavily on tool-calling and JSON-output use cases. Models in 2024+ have been trained on enough JSON-emitting work that the *example* is what pins the shape; the instruction is mostly noise. This is one of the cases where reading dated blog posts will lead you astray — what was best practice three years ago is mediocre practice today, because the underlying model behavior has shifted.

The Anthropic prompt engineering guide leans hard on examples as the primary tool for shape constraint, with explicit advice to put them inside XML-like tags for Claude's training preferences. blooming uses ```json fences instead of `<example>...</example>` tags, partly because the model handles either fine and the fence is more readable to a human reviewer. This is the kind of vendor-specific quirk worth knowing but not building around: the underlying pattern (one worked example > ten prose rules) survives across providers; the *exact tag syntax* varies.

The query agent's deliberate absence of examples is the underrated half of this concept. When the answer shape varies per question, an example narrows the model's range in unwanted ways. The reader's loopd portfolio probably exercises this — chain prompts where every output sounds the same because the few-shot showed it how to sound. The fix in those cases is to *remove* the example, or to make the example explicitly varied ("here are three different answers in three different shapes; respond in whichever fits the question").

The eugeneyan.com blog has good material on example selection — particularly the point that *which* example you pick matters as much as *how many*. An example with `severity: "critical"` and `change.value: 30` teaches the model "30% triggers critical." An example with `severity: "info"` and `change.value: 5` teaches the model "5% might still be reportable." Pick the example that pins the boundary you care about. blooming's monitoring example picks `critical / 30%` — biasing the model toward emitting `critical` for serious changes, which is the right bias for a monitoring agent (false negatives are worse than false positives).

## Interview defense

**Q: When would you use few-shot, and when would you skip it?**

A: Use few-shot when output *shape* matters — structured outputs, classifiers, format-sensitive fields where the model needs to learn the exact syntax. Skip few-shot when output *flexibility* matters — open-ended prose generation where the answer should adapt to the question. blooming uses examples in three of five agents (monitoring, diagnostic, recommendation — all structured) and skips them in two (intent uses inline hints to fit a 16-token budget; query produces prose where examples would narrow the voice). The decision rule: if showing the model a specific instance would push the answer in an unwanted direction, skip; if showing it pins the shape, use.

```
  what I'd sketch:

  use example when:      skip example when:
  ────────────────       ──────────────────
  shape is fixed         shape varies per input
  classifier labels      open-ended generation
  format-sensitive       prose where voice matters
  parser at boundary     human consumer
```

**Q: What's the courteous-model bug, and how do examples help?**

A: The courteous-model bug: you tell the model "return JSON only," and most of the time it does. Sometimes — especially if the prompt also tells it to "be concise" or "explain your reasoning" — it gets chatty and wraps the JSON in a markdown code fence as a politeness ("Here you go:\n```json\n...\n```"). The parser breaks. Examples help because the example *includes* the fence — when the model sees the example wrapped in ```json...```, it learns "the wrapper is part of the output," not "the wrapper is something I should avoid." blooming's worked Anomaly object lives inside a ```json fence in the prompt, which teaches the model that ```json fences are part of the contract. Combined with `parseAgentJson` (which strips the fence on the way back), the system is robust to both fence-included and fence-omitted output — the example normalizes one common form; the parser handles the other.

```
  example contains the wrapper → model emits the wrapper → parser strips it

  prompt:  example shown as  ```json\n[...]\n```
  model:   emits             ```json\n[...]\n```
  parser:  strips the fence, JSON.parse the inside

  → discipline: example + parser are co-designed
                example sets the model's preferred form;
                parser handles the form the model picks anyway.
```

## See also

- [01-anatomy.md](./01-anatomy.md) — the example lives inside the system-prompt section
- [02-structured-outputs.md](./02-structured-outputs.md) — the example IS the contract that the type guard enforces
- [04-token-budgeting.md](./04-token-budgeting.md) — the example costs ~100 tokens; one is plenty for shape
- [07-output-mode-mismatch.md](./07-output-mode-mismatch.md) — keeping the example in sync with the type guard is how mismatches don't ship
