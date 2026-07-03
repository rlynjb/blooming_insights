# 08 · Few-shot prompting

**Few-shot / in-context examples / example-driven prompting — Industry standard**

## Zoom out, then zoom in

Examples constrain output more tightly than instructions do. Show a model three examples of the exact JSON shape you want, and it will emit that shape. Write three paragraphs of prose describing the same shape, and it will emit *close* to that shape, most of the time. This is the specific reason production prompts lean on few-shot when the output is format-sensitive — and it's also the reason to *not* few-shot when the output is meant to be creative or open-ended.

```
  Zoom out — where few-shot sits

  ┌─ Instruction-only prompt ────────────────────────────────┐
  │  "Return a JSON array of anomaly objects with these       │
  │   fields: metric, scope, change, severity."               │
  │  ↓ variance in emission style: medium-high                │
  └──────────────────────────────────────────────────────────┘

  ┌─ Few-shot prompt ────────────────────────────────────────┐
  │  "Return a JSON array of anomaly objects like this:      │
  │                                                           │
  │   [{"metric":"purchase_revenue","category":"revenue_drop",│
  │     "scope":["global"],"change":{...},"severity":"critical"│
  │    }]"                                                    │
  │  ↓ variance in emission style: low                        │
  └──────────────────────────────────────────────────────────┘
```

**Zoom in.** Few-shot has three positions in the prompt anatomy (see `01-anatomy.md`): (a) inline in the rules/schema section as literal expected-output examples, (b) as a separate "here are three examples" block, (c) as trailing user/assistant turn pairs at the end of the messages array. This codebase uses (a) — the monitoring, diagnostic, and recommendation prompts each embed one example JSON output right in the "## Output" section. That embedded example is the few-shot.

## Structure pass

### Axes — the dimension we're tracing

**How tightly does the emission shape need to match?** For format-sensitive outputs (JSON, tags, structured objects), tight matching matters and few-shot earns its tokens. For open-ended generation (a summary, a narrative recommendation), tight matching is a *failure* — every output starts to sound like the example.

### Seams — where the example flips utility

Two seams:

- **Format-sensitive vs open-ended** — the same technique (show an example) either constrains the model helpfully or locks it into repetition depending on which side of this seam you're on.
- **Positive example vs edge-case example** — a canonical happy-path example teaches shape. An edge-case example (empty result, malformed input) teaches "here's what to do when the happy path doesn't apply." Both work; they teach different things.

### Layered decomposition

"What is the example doing here?" — traced across three altitudes:

```
  "What is this example teaching?" — same question, three altitudes

  ┌────────────────────────────────────────────────┐
  │ outer: the whole prompt                         │  → what job the agent has
  └────────────────────────────────────────────────┘
      ┌────────────────────────────────────────────┐
      │ middle: the ## Output section              │  → the exact shape to emit
      └────────────────────────────────────────────┘
          ┌────────────────────────────────────────┐
          │ inner: the JSON literal in the section  │  → the exact bytes to emit
          └────────────────────────────────────────┘
```

The inner altitude is the few-shot: not "your output should look like X" but "here is X, emit something that pattern-matches."

## How it works

### Move 1 — the mental model

You know how a code review comment "please match the style of the existing tests" is less effective than pasting one existing test into the PR description and saying "match this shape"? Same reason. The model pattern-matches better against a literal example than it does against a description of what the example would look like.

```
  Few-shot vs instruction — what the model sees

  instruction only:                      few-shot:
  "Return an anomaly object with          "Return an anomaly like this:
    metric, scope, change, severity"
                                          {"metric":"purchase_revenue",
                                           "category":"revenue_drop",
                                           "scope":["global"],
                                           "change":{"value":30,"direction":"down","baseline":"90d"},
                                           "severity":"critical",
                                           "impact":"Revenue down 30% ..."}"

  model has to:                          model has to:
  - infer field types                    - pattern-match the shape
  - infer array/object nesting            - substitute values
  - infer value formats                   - copy structure

  emission variance: medium               emission variance: low
```

### Move 2 — the step-by-step walkthrough

**Step 1 — the monitoring prompt embeds a full example.**

`lib/agents/legacy-prompts/monitoring.md:71-85`:

```
Return ONLY a JSON array of anomaly objects, at most 10 items, sorted by severity (critical → warning → info → positive), wrapped in a ```json fenced block:

[
  {
    "metric": "purchase_revenue",
    "category": "revenue_drop",
    "scope": ["global"],
    "change": { "value": 30.0, "direction": "down", "baseline": "90d" },
    "severity": "critical",
    "impact": "Revenue down 30% versus the prior 90 days on a baseline of ~12k purchases — a sustained drop at this magnitude pulls the quarterly topline by several million in lost sales, and if the trend holds it compounds across the channel mix.",
    "evidence": [
      { "tool": "execute_analytics_eql", "result": { "metric": "purchase_revenue", "current": 4200000, "prior": 6000000 } }
    ]
  }
]
```

One example. Not three, not ten — one. It's the canonical happy-path example: revenue down 30%, global scope, critical severity, with a real business-impact sentence and evidence citation. The model reads this and knows exactly what shape to emit.

Two things worth noting. First, the `impact` field's example sentence is *long* and specific — that's teaching the model that impact is not a token-count-conscious field, it's the "why the user should care" sentence and should have real content. Second, the `evidence[0].result` is a real-shaped tool result with `current` and `prior` numbers — that teaches the model to cite specific numbers, not vague summaries.

**Step 2 — the recommendation prompt teaches format via inline literals.**

`@aptkit/prompts/dist/src/recommendation.js:54-70`:

```
Each object must have:

- title: string
- rationale: string
- bloomreachFeature: scenario | segment | campaign | voucher | experiment
- steps: string[]
- estimatedImpact: string OR { range: string, rangeUsd?: { low: number, high: number }, assumption: string }
- confidence: high | medium | low
- effort?: low | medium | high
- timeToSetUpMinutes?: number
- readResultInDays?: number
- prerequisites?: { label: string, satisfied: boolean }[]
- successMetric?: string
```

This is a *hybrid* — not a full JSON example, but a field-by-field schema with type annotations. It's teaching the shape via a description that reads like TypeScript. The model pattern-matches the description too, but less tightly than a literal example. This codebase is honest about the tradeoff: for recommendations, the *content* varies enough per case (title, rationale, steps are all context-specific) that a canonical example would over-constrain the emissions. The field-list-with-types is the middle ground.

```
  Two flavors of few-shot in this codebase

  ┌── literal JSON example (monitoring) ──────────────┐
  │  full example object with real values             │
  │  teaches: exact shape + tone of `impact` sentences │
  │  risk: emissions become too similar to example    │
  └───────────────────────────────────────────────────┘

  ┌── field-schema example (recommendation) ──────────┐
  │  field-by-field type annotations                  │
  │  teaches: shape only, not content                 │
  │  risk: shape drift because the constraint is soft │
  └───────────────────────────────────────────────────┘
```

**Step 3 — the diagnostic prompt embeds the output shape as JSON.**

`@aptkit/prompts/dist/src/diagnostic.js:26-45`:

```
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

If you cannot determine a cause, return:
{
  "conclusion": "Insufficient data to determine a cause for this change.",
  "evidence": [],
  "hypothesesConsidered": []
}
```

Two examples here. The first is the happy-path shape. The second is the *edge case* — what to emit when the investigation fails to find a cause. That second example is the load-bearing few-shot: without it, the model would try to invent a conclusion when it should confess "insufficient data." With it, the model has a template for "I couldn't figure it out" that emits a valid Diagnosis shape and lets the downstream validator accept it.

```
  Edge-case few-shot — teaching the "I can't" shape

  happy path example:              edge case example:
  { "conclusion":"…mechanism…",     { "conclusion":"Insufficient data…",
    "evidence":["…"],                 "evidence": [],
    "hypothesesConsidered":[{…}]}    "hypothesesConsidered": [] }

  without the edge case, the model tries to invent a conclusion
  even when there's no signal.
  with the edge case, the model has a template for "I can't."
```

**Step 4 — when to *not* few-shot.**

Two places in this codebase where few-shot is deliberately absent. First: **the intent classifier** (`@aptkit/agent-query/dist/src/intent.js:13`):

```
'Classify the user query as exactly one word: monitoring (what changed / what is new), diagnostic (why did something happen), or recommendation (what should I do). Reply with ONLY the one word.'
```

No examples. Just a one-line instruction with the three allowed outputs enumerated. Why? Because the output is one of three literal words, the instruction is fully specified, and adding examples would (a) grow the prompt, (b) risk the model over-fitting to the example queries, (c) not add signal beyond the three-word enumeration. Few-shot has a cost (tokens) and no benefit here.

Second: **the impact sentences** inside monitoring outputs. Look at the example impact: "Revenue down 30% versus the prior 90 days on a baseline of ~12k purchases — a sustained drop at this magnitude pulls the quarterly topline by several million in lost sales, and if the trend holds it compounds across the channel mix." That's *one* example, and the risk is that every impact sentence in every emission starts to sound like it (see `13-forbidden-patterns.md` for the specific bug — model convergence on phrasings). This codebase mitigates by making the example prose long enough that direct copying is obviously wrong; a shorter example would be more prone to being echoed.

**Step 5 — the 3-to-5 rule.**

Working consensus: **3–5 good examples beats 10 mediocre ones**. Three examples give the model enough variance to pattern-match on shape without over-fitting to any single example. Ten examples eat tokens and add marginal signal past the fifth. Zero examples leaves emission variance high.

This codebase uses *one* example per output shape in most prompts. That's below the 3-to-5 rule. Why? Two reasons. First, the examples are load-bearing for shape but not for content variance — the content varies by anomaly, and the model handles that naturally. Second, adding more examples would grow the system prompt and push the stable-prefix cache boundary further — see `04-token-budgeting.md`; every added byte of few-shot is a byte you pay for once at cache_creation and then read cheaply, so the tradeoff isn't per-call cost, it's cache creation cost + prompt readability.

```
  Few-shot count — the tradeoff curve

  0 examples:  emission variance HIGH, prompt tokens LOW
  1 example:   emission variance MEDIUM (shape locked, content free), tokens LOW
  3-5 exampls: emission variance LOW (well-locked), tokens MEDIUM
  10+:         emission variance LOW (over-fit risk), tokens HIGH,
                readability POOR
```

### Move 2 variant — the load-bearing skeleton

The kernel of few-shot in this codebase is three moves:

```
  canonical happy-path example + edge-case example + no example for classifiers
```

What breaks if you skip each:

- **Skip "canonical happy-path"** — emission variance grows. Half your outputs are well-shaped; the other half have subtle field drift.
- **Skip "edge-case"** — the model confabulates when it should confess. Diagnostic without the "Insufficient data" template invents diagnoses on no-signal cases (see `10-no-signal-*` cases in `eval/goldens/` — these are the specific cases this few-shot addresses).
- **Skip "no example for classifiers"** — you add examples where they don't earn tokens. Same output, larger prompt, worse cache economics.

Hardening layered on top: rotating examples across chain calls (see `13-forbidden-patterns.md` for the related concept), edge-case examples per known failure mode, negative examples ("do NOT emit this shape").

### Move 3 — the principle

**Examples are the fastest way to constrain shape and the slowest way to constrain content.** For format-sensitive outputs (JSON, tags, structured objects), one example locks the shape better than three paragraphs of description. For open-ended outputs (a narrative recommendation, a creative summary), examples over-constrain content and every output starts to sound like the example. Reach for few-shot when the answer to "what should the output look like exactly" is a specific bytes-pattern; skip it when the answer is "it depends on the input."

## Primary diagram

```
  Few-shot in Blooming — where each prompt uses what

  ┌── monitoring prompt ────────────────────────────────────┐
  │  ## Output                                              │
  │  Return ... ```json fenced block:                       │
  │  [ { "metric": "purchase_revenue", ... } ]              │  ← 1 full literal
  │                                                          │    example (30% rev drop)
  │  purpose: teach exact shape + tone of `impact` sentence  │
  └─────────────────────────────────────────────────────────┘

  ┌── diagnostic prompt ────────────────────────────────────┐
  │  Return ... with this shape: { conclusion, ... }        │  ← happy-path shape
  │                                                          │
  │  If you cannot determine a cause, return:                │  ← edge-case example
  │  { conclusion: "Insufficient data ...", ... }            │    (the load-bearing part)
  └─────────────────────────────────────────────────────────┘

  ┌── recommendation prompt ────────────────────────────────┐
  │  Each object must have:                                 │
  │  - title: string                                        │  ← field-schema example
  │  - bloomreachFeature: scenario|segment|...              │    (types, no full example)
  │                                                          │
  │  purpose: shape without over-constraining content        │
  └─────────────────────────────────────────────────────────┘

  ┌── intent classifier ────────────────────────────────────┐
  │  "Classify ... Reply with ONLY the one word."           │  ← NO examples
  │                                                          │
  │  purpose: output is fully specified by the instruction   │
  └─────────────────────────────────────────────────────────┘
```

## Elaborate

The 3-to-5 rule came out of empirical work on GPT-3-era models where prompt lengths were expensive and every example counted. Modern models (Sonnet 4.6, GPT-4.5) are more sample-efficient — one good example often gets you 90% of the shape-locking effect, and each additional example adds diminishing returns. This codebase's use of *one* example per prompt is a working reflection of that: the cost of adding more examples (prompt size, over-fit risk) exceeds the marginal signal past the first.

The interaction between few-shot and structured output is worth naming: **a few-shot example is itself a structured-output example**. When the prompt says "return this JSON" and shows the JSON, you're doing few-shot at the schema level. This is why the anatomy of the "## Output" section in every prompt in this codebase is functionally identical across chains — it's the schema-few-shot pattern, applied per chain.

Anthropic's prompt engineering guide leans heavily on this: their canonical recommendation is "wrap examples in `<example>` tags." This codebase doesn't use XML tags — the examples are markdown-fenced JSON blocks — but the shape is the same. Either works; pick one, stay consistent.

Two failure modes I've watched happen with few-shot:

- **The "leaked example" bug.** Someone puts a real customer's data into the example. Six months later a support engineer sees the model quote that customer's name in an unrelated response. Fix: use synthetic data for examples, always.
- **The over-fit bug.** The example uses a specific phrasing ("Revenue down 30%") and every emission starts with "Revenue down X%" regardless of what the actual metric is. Fix: use variable phrasings across the example if it's a template, or use forbidden-patterns discipline (see `13-forbidden-patterns.md`).

Related concepts:
- **Anatomy** (`01-anatomy.md`) — few-shot sits in the rules/schema section.
- **Structured outputs** (`02-structured-outputs.md`) — a schema example IS a few-shot example.
- **Forbidden patterns** (`13-forbidden-patterns.md`) — the specific bug when few-shot causes convergence.
- **Chain-of-thought** (`09-chain-of-thought.md`) — few-shot of reasoning is a related but distinct technique.

## Interview defense

**Q: When do you use few-shot in a production prompt, and when don't you?**

Use it when the output is format-sensitive — JSON, tags, a specific structured shape — because one literal example locks the shape tighter than three paragraphs of description. Don't use it when the output is open-ended (a narrative, a creative summary) because every emission will start to echo the example. Don't use it when the instruction is fully specified — the intent classifier in this codebase is a one-line instruction with three allowed outputs, and adding examples would grow the prompt without adding signal. In this codebase, the monitoring / diagnostic / recommendation prompts use one embedded example each for the JSON shape; the classifier uses zero.

```
  Decision — few-shot yes/no

  format-sensitive output?   → yes, embed 1-3 examples
  open-ended generation?      → no, examples cause convergence
  instruction fully specified? → no, examples add tokens without signal
  edge case needs a template? → yes, one edge-case example
```

Anchor: monitoring prompt's example at `lib/agents/legacy-prompts/monitoring.md:71-85`; diagnostic edge-case example at `@aptkit/prompts/dist/src/diagnostic.js:41-45`.

**Q: The diagnostic agent starts confabulating a conclusion on no-signal cases. What's the fix?**

Look at whether the prompt has an edge-case example for "insufficient data." In this codebase it does: `@aptkit/prompts/dist/src/diagnostic.js:41-45` — "If you cannot determine a cause, return: { conclusion: 'Insufficient data ...', evidence: [], hypothesesConsidered: [] }". That literal template gives the model a shape to emit when the happy path doesn't apply. Strip it, and the model tries to invent a conclusion from priors instead of confessing the miss. The specific eval cases where this shows up are the `05-no-signal-*`, `06-no-signal-*`, and `10-no-signal-*` goldens — they test whether the diagnostic agent uses the template or invents. When the eval fails on those cases, the first thing to check is whether the template example is still in the prompt.

```
  Edge-case few-shot — the specific bug it prevents

  without edge-case example:         with edge-case example:
  no-signal case                     no-signal case
    │                                   │
    ▼                                   ▼
  model has no template for            model emits the template:
  "I can't figure this out"            { conclusion: "Insufficient data..." }
    │                                   │
    ▼                                   ▼
  invents a plausible conclusion       eval passes (no confabulation)
  eval fails on no-signal cases        gate is satisfied
```

**Q: What's the load-bearing part people forget?**

The edge-case example. Everyone remembers the happy-path example. The load-bearing few-shot is the "here's what to emit when you can't do the job" template — because without it, the model tries to do the job anyway and invents. In this codebase, the diagnostic prompt's "Insufficient data" template at `@aptkit/prompts/dist/src/diagnostic.js:41-45` is the specific example. Every no-signal case in the eval set (`05-no-signal-retention-subscribers`, `06-no-signal-price-sensitivity-luxury`, `10-no-signal-seo-organic`) is testing whether the model uses that template instead of confabulating. Miss the template and half your no-signal cases regress.

## See also

- `01-anatomy.md` — the rules/schema section where few-shot lives.
- `02-structured-outputs.md` — a schema example IS a few-shot example.
- `09-chain-of-thought.md` — few-shot of reasoning is a related pattern.
- `13-forbidden-patterns.md` — the failure mode when few-shot causes convergence.
