# 08 · Few-shot prompting

**Industry name:** *few-shot prompting* / *in-context examples* / *demonstration prompting* · Industry standard

## Zoom out — where few-shot lives (or doesn't) in this repo

Few-shot is one of those techniques every prompt tutorial teaches first. It's also the one this codebase mostly *doesn't* need — because the output shape is enforced structurally (concept 02) rather than through examples. Draw where it does appear.

```
  Zoom out — where few-shot could / does live

  ┌─ prompts in this repo ─────────────────────────────────────┐
  │                                                             │
  │  legacy-prompts/monitoring.md                               │
  │    § 4 output shape shows ONE example object (:72-85)       │
  │    ← "shape example" — a form of shape-only few-shot        │
  │                                                             │
  │  legacy-prompts/diagnostic.md                               │
  │    § 4 output shape shows ONE schema template (:60-82)      │
  │    ← same shape-example move                                │
  │                                                             │
  │  legacy-prompts/recommendation.md                           │
  │    § 4 output shape shows ONE example object (:51-74)       │
  │    ← same shape-example move                                │
  │                                                             │
  │  legacy-prompts/query.md                                    │
  │    NO examples (prose output; shape doesn't need seeding)   │
  │                                                             │
  │  eval/rubrics/{diagnosis,recommendation}-quality.ts         │
  │    NO task examples (rubric is a judgment framework, not    │
  │    a task; example-driven grading would leak the answer)    │
  │                                                             │
  └────────────────────────────────────────────────────────────┘
```

## Zoom in — three flavors of few-shot, one used here

Three shapes of few-shot to distinguish:

1. **Task few-shot** — full input/output pairs. "Given anomaly A, the correct diagnosis is D. Given anomaly B, the correct diagnosis is E. Now diagnose F." Constrains behavior.

2. **Shape few-shot** — one example that shows the output structure without seeding task behavior. "Here's what a valid response looks like: `{ conclusion: '...', evidence: [...] }`." Constrains format.

3. **Anti-example few-shot** — "here's what a bad answer looks like; don't do this." Rarely used.

This codebase uses #2 (shape few-shot) in the JSON-emitting chains and skips #1 entirely. The reason: task few-shot is expensive (large token cost per example, drift with model upgrades), and the shape constraint alone is enough when combined with the output validator.

## Structure pass — layers, axis, seams

Trace one axis: *how the output shape is enforced*, from strongest to weakest guarantee.

- **Layer 1 — provider schema (tool calling).** Strongest. The model literally cannot emit invalid tokens.
- **Layer 2 — shape-example few-shot in § 4.** Weaker but cheap. "Return exactly this shape" plus one filled-in example.
- **Layer 3 — task few-shot.** Constrains both shape and reasoning behavior. Expensive.
- **Layer 4 — output validator.** Catch-all safety net at the app boundary.

**The seam:** between provider-enforced structure (Layer 1) and prompt-time examples (Layer 2/3). This codebase leans on Layer 1 for tool calls, Layer 2 for final answers, and Layer 4 as backstop. Layer 3 doesn't appear — that's a deliberate call.

## How it works

### Move 1 — the shape

You've written a unit test with example inputs. A few-shot example is the same primitive at prompt time. You're saying "here's what a right answer looks like on a case you've never seen." The model uses the shape of the example to constrain its output on *your* case.

```
  Pattern — few-shot as example-in-context

  system prompt: "diagnose this anomaly"
  ─────────────────────────────────────
  example 1: anomaly A ──► diagnosis {conclusion: "...", evidence: [...]}
  example 2: anomaly B ──► diagnosis {conclusion: "...", evidence: [...]}
  example 3: anomaly C ──► diagnosis {conclusion: "...", evidence: [...]}
  ─────────────────────────────────────
  user: anomaly F ──► ??? (model completes)
```

Two things happen:

- The model learns the *shape* — that output is a JSON with `conclusion` and `evidence`, that `conclusion` is one sentence.
- The model learns the *style* — that evidence bullets are terse, that hypotheses are enumerated a specific way, that the conclusion isn't hedged.

Style transfer is the interesting effect. Instructions can't easily produce a specific style — "be concise" is a directive but doesn't teach a voice. Examples show the voice by doing it.

### Move 2 — walking the examples in this repo

#### Shape example in monitoring.md

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

This is *one* filled-in example. It's shape few-shot — it demonstrates:

- The wrapper: fenced JSON block.
- The array-of-objects shape.
- The field set and types.
- The style of `impact` (specific to the metric, translates % to business consequence, no restatement of the percentage).

It's not task few-shot because it doesn't map an input anomaly to an output diagnosis. It just shows the output format on one plausible case.

The trade-off: even one shape example costs tokens. This one is ~150 tokens. If the § 4 output shape had 3-5 examples, we'd be spending 500-750 tokens per call on shape demonstration alone. With `cache_control: ephemeral` on the system prompt (concept 04), that cost is amortized — cached across the loop. Without caching, it'd be per-turn expensive.

#### Why no task few-shot

Reasons this codebase skips task few-shot for the three agents:

1. **The output is structural.** JSON with a validator. Shape few-shot handles most of the shape drift; task examples would add reasoning-transfer that we don't need.

2. **Model upgrades regress task few-shot.** A Sonnet 3 few-shot example might drift on Sonnet 4 — the model treats it as a template to imitate rather than a demonstration to reason from. Then the *specific* examples show up in outputs on unrelated cases. Cleaning this up mid-migration is a nightmare.

3. **The eval covers behavior.** With 10 goldens + rubric scoring (concept 05), we get behavior-level feedback on the actual outputs. Task few-shot is a way to constrain behavior at prompt time; evals let us catch it at test time. Both work; running both is redundant.

4. **Cost.** Each task few-shot example is a full I/O pair — a full anomaly + a full diagnosis. On the diagnostic prompt, one example is ~1,000 tokens. Three would be 3,000. The baseline diagnose input average is 7,404. Adding task few-shot would nearly double it.

Where task few-shot *would* land in this codebase: if we spun up a new classifier chain (say, "classify this anomaly's category" — see `lib/agents/categories.ts` for the categories). Classifiers are the canonical few-shot use case — 3-5 labeled examples of `input → label` significantly outperforms an instruction-only classifier for the same cost.

#### Why no examples in the rubrics

`eval/rubrics/diagnosis-quality.ts:17-22`:

```
task: `Judge a diagnosis produced by an AI analyst investigating an ecommerce anomaly.
The diagnosis will be JSON with these fields: conclusion (one-sentence root cause),
evidence (bullet list of what supported the conclusion), hypothesesConsidered (each
with hypothesis + supported flag + reasoning), and optional affectedCustomers and
confidence. Score on the four dimensions below.`,
```

The rubric definition names the shape and lists the dimensions with descriptions. It does not include *examples* of scored judgments. Reason: including an example judgment would leak the answer — the judge model would tend to score similarly to the example rather than reason from the rubric independently. The dimensions and their per-score descriptions are enough constraint for the judge; adding examples would add noise (or worse, bias).

This is the flip side of the classifier reasoning above. When examples would *bias* the output rather than *constrain* it, skip them.

```
  Comparison — when examples help vs bias

  ┌─ classifier: examples help ──────────────────┐
  │  intent: {greeting | question | complaint}    │
  │  giving 3 examples per class trains the model │
  │  to draw the class boundaries the same way    │
  └───────────────────────────────────────────────┘

  ┌─ rubric grader: examples bias ────────────────┐
  │  score this diagnosis 1-5 on dimension X       │
  │  giving an example scored judgment leaks a     │
  │  reference point; judge model tends to score   │
  │  new cases against the example rather than     │
  │  reason from the dimension description         │
  └────────────────────────────────────────────────┘
```

### Move 2 variant — the load-bearing skeleton

The kernel of "few-shot as a discipline":

1. **Distinguish shape example from task example.** Drop this and you don't know whether you're constraining format or behavior.
2. **Prefer structural enforcement over examples when both are available.** Provider schema > shape example > task example > nothing.
3. **Use task few-shot for classifiers or format-sensitive generation.** Skip it elsewhere.
4. **Cache examples in the stable prefix.** Drop this and every example is billed every turn.

Hardening on top: example selection (retrieve the most relevant few-shots per query), rotating example sets, A/B testing example configurations. None of that is the skeleton.

### Move 3 — the principle

**Examples constrain output more than instructions do — but only when the examples land in the model's "how to answer" register, not its "which specific answer" register.** The line between the two is thin. A shape example shows the model *how* to format output; a task example shows the model *what kind of thing* to produce. Both are useful. Both cost tokens. The trick is knowing which kind of constraint your current bug needs. Blog-post advice like "just add more examples" is wrong when the bug is model drift on shape — you need one clean shape example, not five noisy task examples.

## Primary diagram

```
  Few-shot — the full recap

  three flavors, three costs, three uses

  ┌─ shape example ────────────────────────────────────┐
  │  one filled-in output object at end of § 4          │
  │  cost:   ~150 tokens                                │
  │  used:   monitoring.md, diagnostic.md,               │
  │          recommendation.md                           │
  │  cached: yes (part of stable prefix)                 │
  └─────────────────────────────────────────────────────┘

  ┌─ task few-shot ────────────────────────────────────┐
  │  full input/output pair(s), N of them               │
  │  cost:   ~1000 tokens per example                   │
  │  used:   NONE in this repo (structural enforcement  │
  │          + evals cover the same ground)             │
  │  when:   classifiers, format-sensitive generation   │
  └─────────────────────────────────────────────────────┘

  ┌─ rubric anti-example ──────────────────────────────┐
  │  "here's a bad answer"                              │
  │  used:   NONE in this repo (avoid leaking answers    │
  │          into a judge that's supposed to grade      │
  │          independently)                             │
  └─────────────────────────────────────────────────────┘

  discipline:  shape examples are cheap safety;
               task examples are behavior transfer;
               skip both when a schema does the work.
```

## Elaborate

Anthropic's prompt-engineering guide and the OpenAI cookbook both advise 3-5 examples as a starting point for task few-shot. That number comes from cost/benefit — below 3, the model doesn't lock onto the pattern; above 5, you hit diminishing returns and eat context tokens for little marginal gain. The 3-5 range is folklore across the industry now.

The failure mode that's most under-discussed: **example contamination**. When you include a task example in the prompt, the model may cite specific *content* from the example on unrelated cases. In one production system I shipped, we included an anomaly example about "credit card processor SP failure" (the same case pattern shows up in this repo's goldens). Weeks later, we noticed the model was hallucinating "credit card processor SP failure" as the diagnosis for anomalies about session drops in Germany. The example became a template. The fix was: swap in generic placeholder anomalies for the examples ("category X, region Y") and let the actual task drive the specifics.

The interaction with structured output (concept 02) is the modern move. If your output shape is enforced by a tool schema, you don't need shape few-shot — the schema is a stronger constraint than any example. This repo does the two-tier version: tool calls use schemas (Layer 1 in the structure pass), final answers use a shape-example inside a shape-declaring § 4 (Layer 2), and the validator catches drift (Layer 4). Task few-shot doesn't appear because none of these agents are classifiers.

The Hamel Husain rule-of-thumb: if you can measure "did few-shot help" with an eval, run the eval first, then add few-shot. If the eval improves, keep the examples. If it doesn't, drop them. Don't add few-shot as a defensive move without measurement — you're spending tokens on nothing.

## Interview defense

**Q: When do you reach for few-shot?**

Two cases. First, classifiers — 3-5 input-to-label examples significantly outperforms an instruction-only classifier at similar cost. Second, format-sensitive generation where the schema alone doesn't fully constrain style (a captioning chain, for instance, where you want a specific voice). What I don't reach for: task few-shot on agents whose output shape is already enforced by a tool schema and validated at the app boundary — that's redundant and expensive. In this codebase the three JSON agents use one *shape* example each (~150 tokens in § 4) and skip task few-shot entirely. The eval harness catches behavior drift, so we don't need to constrain behavior at prompt time.

```
  classifier?           yes  ──►  3-5 examples
  format-sensitive?     yes  ──►  1-3 examples for voice
  schema-enforced JSON? no   ──►  one shape example, skip tasks
```

Anchor: `lib/agents/legacy-prompts/monitoring.md:71-85` (shape example); `eval/rubrics/diagnosis-quality.ts:17-22` (task-less rubric task).

**Q: What's the specific bug where you learned examples can hurt?**

Example contamination. I shipped a chain with a task few-shot example about a specific customer scenario. Weeks later, the model was citing the example's specifics on unrelated queries — the example became a template it kept reaching for. The fix was to swap the example specifics for generic placeholders and let the actual task drive the details. General rule: when a few-shot example contains any content that's likely to *not* appear in real queries, it's a leak waiting to happen. Generic examples land safer than realistic ones.

```
   realistic example  ──► model treats it as reality
   generic example    ──► model treats it as format
```

Anchor: none in this repo — this codebase avoids task few-shot for exactly this reason.

## See also

- 01 · anatomy — § 3 is where few-shot lives when it lives.
- 02 · structured outputs — provider-side schema is a stronger constraint than any example.
- 04 · token budgeting — examples are billed as part of the stable prefix; caching helps.
- 05 · eval-driven iteration — running the eval before/after adding few-shot tells you whether it earned its tokens.
