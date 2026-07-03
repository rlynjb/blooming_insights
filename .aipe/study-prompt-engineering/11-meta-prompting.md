# 11 · Meta-prompting

**Meta-prompting / prompt from data / prompt generation — Industry standard**

## Zoom out, then zoom in

Meta-prompting is when you write code that generates a prompt from data instead of hand-crafting the prompt as a static string. In this codebase there are two real examples: (a) `renderPromptTemplate` fills `{schema}` and `{anomaly}` variables into a template at runtime — light meta-prompting, essentially string interpolation; and (b) `buildRubricJudgeSystemPrompt` walks a `RubricDefinition` object and assembles a full judge system prompt from its dimensions, verdicts, and checks — heavy meta-prompting, where the prompt's *structure* comes from the data. The second is the shape worth learning.

```
  Zoom out — where meta-prompting sits

  ┌─ Data (source of truth) ─────────────────────────────────┐
  │  diagnosisQualityRubric = {                              │
  │    dimensions: [{id, label, description, scale:[…]}, …], │
  │    verdicts: [{verdict, description}, …],                 │
  │    checks: […],                                           │
  │    task: '…'                                              │
  │  }                                                        │
  └────────────────────────┬────────────────────────────────┘
                           │  input to a prompt-builder function
  ┌─ Prompt builder ───────▼────────────────────────────────┐
  │  buildRubricJudgeSystemPrompt(rubric)                    │
  │  concatenates: task + dimensions text + verdicts + …     │
  └────────────────────────┬────────────────────────────────┘
                           │  output: a system prompt string
  ┌─ ★ META-PROMPTING SEAM ★ ▼─────────────────────────────┐
  │  the LLM receives a prompt whose STRUCTURE was          │  ← we are here
  │  determined by data, not by a human writing string       │
  └─────────────────────────────────────────────────────────┘
```

**Zoom in.** Meta-prompting is not "use an LLM to write your prompts for you" (that's the internet-thread version). The production version is: **the prompt is a function of data, and the data is the source of truth.** Change the rubric object, the judge's system prompt changes deterministically. Change one dimension's description, the judge's system prompt reflects it on the next call without a human editing a string.

## Structure pass

### Axes — the dimension we're tracing

**Where does the source of truth live — in the prompt string or in the data?** For rubrics, the source of truth is the rubric object (typed, in a `.ts` file, code-reviewed). For agent prompts, the source of truth is the prompt template string (also a `.ts` file, but hand-written prose with `{}` slots). Meta-prompting is what moves the source of truth from string to data.

### Seams — where meta-prompting flips

Two seams:

- **String source of truth vs data source of truth** — when the prompt is a hand-written string with `{}` slots, the string owns the structure and the data fills the slots. When the prompt is generated from data, the data owns the structure and the builder function is a serializer.
- **Author-time vs load-time vs call-time** — a prompt built at author-time is a static string. Built at load-time from data is meta-prompting. Built at call-time from per-call data is dynamic prompting (this codebase uses this too — `renderPromptTemplate({schema, anomaly})` at call time).

### Layered decomposition

"Where does the prompt come from?" — traced across altitudes:

```
  "Where does the prompt come from?" — same question, three altitudes

  ┌────────────────────────────────────────────────┐
  │ outer: the code artifact                        │  → a .ts file
  │        (what's in the repo)                     │
  └────────────────────────────────────────────────┘
      ┌────────────────────────────────────────────┐
      │ middle: the shape                           │  → a template with {}
      │                                             │    OR a builder function
      └────────────────────────────────────────────┘
          ┌────────────────────────────────────────┐
          │ inner: the source of truth              │  → a string (hand)
          │                                          │    OR a data object
          │                                          │    (meta-prompting)
          └────────────────────────────────────────┘
```

## How it works

### Move 1 — the mental model

You know how a template engine (Handlebars, JSX, EJS) is just "here's a template with slots, here's the data, glue them together"? Light meta-prompting is exactly that — `renderPromptTemplate('… {schema} …', { schema: 'value' })`. Heavy meta-prompting is one step deeper: the *structure* of the prompt is also derived from the data, not just the slot values.

```
  Light meta-prompting vs heavy meta-prompting

  ┌── light (template with slots) ────────────────────────┐
  │  template = "You are ... {schema} ... {anomaly} ..."  │
  │  data      = { schema: '…', anomaly: '…' }             │
  │  output    = interpolated string                       │
  │  structure is fixed in the template                   │
  └───────────────────────────────────────────────────────┘

  ┌── heavy (structure from data) ────────────────────────┐
  │  data = { dimensions: [ ... ], verdicts: [ ... ], … }  │
  │  builder(data) = walks data, assembles prompt          │
  │  output = a prompt whose sections and content are      │
  │           BOTH derived from the data                   │
  └───────────────────────────────────────────────────────┘
```

### Move 2 — the step-by-step walkthrough

**Step 1 — the data is typed and code-reviewed.**

`eval/rubrics/diagnosis-quality.ts:15-108`:

```ts
export const diagnosisQualityRubric: RubricDefinition = {
  id: 'blooming-diagnosis-quality-v1',
  title: 'Diagnosis quality',
  task: `Judge a diagnosis produced by an AI analyst investigating an ecommerce anomaly...`,
  dimensions: [
    {
      id: 'root_cause_plausibility',
      label: 'Root-cause plausibility',
      description: 'Does the conclusion name a plausible mechanism...',
      scale: [
        { score: 1, description: 'Restates the symptom; no mechanism named.' },
        // ...
        { score: 5, description: 'Specific mechanism, evidence directly supports it, and rival mechanisms are considered.' },
      ],
    },
    // ...more dimensions
  ],
  verdicts: [
    { verdict: 'pass', description: 'All four dimensions at ≥4...' },
    // ...
  ],
  checks: [
    'cites at least one number from the tool results',
    // ...
  ],
};
```

Two things worth noting. First, this is `RubricDefinition` (a type from `@aptkit/core`). The compiler knows the shape. Adding a new dimension is adding an object to the array — the type system yells if the new object misses `id`, `label`, `description`, or `scale`. Second, this file is code-reviewed like any other — the PR that added dimensions to the rubric went through the same review as a PR that adds a new function.

**Step 2 — the builder walks the data.**

`@aptkit/core/node_modules/@aptkit/evals/dist/src/rubric-judge.js:31-77`:

```js
export function buildRubricJudgeSystemPrompt(rubric) {
    const dimensions = rubric.dimensions
        .map((dimension) => {
            const scale = dimension.scale
                .map((level) => `  ${level.score} = ${level.description}`)
                .join('\n');
            return `${dimension.id} ${dimension.label}: ${dimension.description}\n${scale}`;
        })
        .join('\n\n');
    const verdicts = rubric.verdicts
        .map((rule) => `- ${rule.verdict}: ${rule.description}`)
        .join('\n');
    const checks = rubric.checks?.length
        ? `\nChecks to return as booleans:\n${rubric.checks.map((check) => `- ${check}`).join('\n')}\n`
        : '';
    // ...builds the JSON output shape from dimensions and checks
    return [
        `You are a rubric judge for: ${rubric.title}.`,
        rubric.task,
        '',
        'Score the subject against the rubric...',
        'Never rewrite the subject. Return one highest-leverage fix, not a list.',
        '',
        'Rubric dimensions:',
        dimensions,
        '',
        'Allowed verdicts:',
        verdicts,
        checks.trimEnd(),
        examples.trimEnd(),
        '',
        'Output JSON only. No prose. No markdown fences. Use exactly this shape:',
        JSON.stringify(outputShape),
    ].filter(Boolean).join('\n');
}
```

Three moves inside the builder. **First**: walk `rubric.dimensions` and format each as `id label: description\n scale`. **Second**: walk `rubric.verdicts` and format each as `- verdict: description`. **Third**: assemble the whole system prompt as a bounded array of strings and join. The whole builder is a pure function of the rubric object.

```
  Builder — the meta-prompting kernel

  ┌── input: RubricDefinition ─────────────────────────────┐
  │  { title, task, dimensions[], verdicts[], checks[] }   │
  └──────────────────────┬─────────────────────────────────┘
                         │
  ┌── walk dimensions ───▼─────────────────────────────────┐
  │  for each dim: format id + label + description +       │
  │                       scale as text                    │
  │  join with \n\n                                         │
  └──────────────────────┬─────────────────────────────────┘
                         │
  ┌── walk verdicts ─────▼─────────────────────────────────┐
  │  for each verdict: format as "- verdict: description"  │
  │  join with \n                                           │
  └──────────────────────┬─────────────────────────────────┘
                         │
  ┌── walk checks ───────▼─────────────────────────────────┐
  │  for each check: format as "- check"                    │
  │  join with \n, wrap in "Checks to return as booleans:"  │
  └──────────────────────┬─────────────────────────────────┘
                         │
  ┌── build output shape ▼─────────────────────────────────┐
  │  Object.fromEntries(dimensions.map(d => [d.id, ...]))   │
  │  JSON.stringify(outputShape) → literal example in prompt│
  └──────────────────────┬─────────────────────────────────┘
                         │
  ┌── concatenate final ─▼─────────────────────────────────┐
  │  [task, dimensions text, verdicts text, checks text,   │
  │   output shape] joined by \n                            │
  └────────────────────────────────────────────────────────┘
```

**Step 3 — the output shape is meta-generated too.**

Look at lines 51-59 of `rubric-judge.js`:

```js
const dimensionShape = Object.fromEntries(rubric.dimensions.map((dimension) => [dimension.id, { score: 0, reason: '' }]));
const checkShape = Object.fromEntries((rubric.checks ?? []).map((check) => [check, true]));
const outputShape = {
    dimensions: dimensionShape,
    ...(rubric.checks?.length ? { checks: checkShape } : {}),
    verdict: rubric.verdicts[0]?.verdict ?? 'pass',
    fix: '',
    reasoning: '',
};
```

This is the "here's the exact JSON to emit" example (few-shot; see `08-few-shot.md`). Its shape is derived from the rubric's dimensions and checks arrays. Add a dimension, the example JSON gets a new field; add a check, the example gets a new boolean. The prompt's few-shot example is *itself* generated by data.

```
  Few-shot example — generated from data

  dimensions.map → dimensionShape
      ┌────────────────────────────────────┐
      │ { root_cause_plausibility:          │
      │   { score: 0, reason: '' },         │
      │   evidence_grounding:               │
      │   { score: 0, reason: '' }, … }     │
      └────────────────────────────────────┘

  checks.map → checkShape
      ┌────────────────────────────────────┐
      │ { "cites at least one number …":   │
      │   true, … }                         │
      └────────────────────────────────────┘

  outputShape = { dimensions, checks, verdict, fix }
      ↓
  JSON.stringify → literal example in the prompt

  add a dimension to the rubric → example JSON adds the field
  add a check → example JSON adds the boolean
  no human touches the prompt string
```

**Step 4 — the same discipline in the agent prompts, at lower depth.**

The monitoring / diagnostic / recommendation prompts use *light* meta-prompting — templates with `{schema}` and `{anomaly}` slots that `renderPromptTemplate` fills:

```js
// from @aptkit/agent-anomaly-monitoring/dist/src/monitoring-agent.js:42-45
const system = renderPromptTemplate(this.prompt, {
    schema: schemaSummary(this.options.workspace),
    categories: formatCategoryChecklist(categories),
});
```

The template is a static string with `{schema}` and `{categories}` slots. The values are computed by `schemaSummary()` (see `04-token-budgeting.md`) and `formatCategoryChecklist()`. Both value-generators are pure functions of workspace data, so the whole `{schema}` and `{categories}` interpolation is meta-prompting at the value level — but not at the structure level (the surrounding template is hand-written prose).

```
  Light vs heavy meta-prompting — where each is used

  ┌── agent prompts (light) ────────────────────────────────┐
  │  monitoring / diagnostic / recommendation                │
  │  template: hand-written string with {schema} slots       │
  │  values: schemaSummary(workspace), etc.                  │
  │  structure = string (author-time)                        │
  │  values = data (call-time)                                │
  └─────────────────────────────────────────────────────────┘

  ┌── judge prompt (heavy) ─────────────────────────────────┐
  │  RubricJudge system prompt                              │
  │  structure: derived from rubric.dimensions.length,       │
  │            rubric.verdicts.length, rubric.checks.length  │
  │  values: derived from rubric.dimensions[i].description,  │
  │          etc.                                            │
  │  structure = data (load-time)                            │
  │  values = data (load-time)                                │
  └─────────────────────────────────────────────────────────┘
```

**Step 5 — the risk this pattern carries.**

Meta-prompted prompts can drift from being human-readable. If the builder concatenates 40 dimensions and 12 verdicts, the resulting system prompt is a wall of text nobody can code-review as prose — you review the *data* instead. That's fine when the data is well-typed and the shape is stable. It's risky when the builder's output is the actual thing you'd want to sanity-check but nobody looks at it. Mitigation in this codebase: the rubrics are small (four dimensions each) and the builder is simple enough to reason about.

The other risk is prompts that "read like LLM output" — the meta version of that is prompts that read like *generated code*. Repetitive, mechanical, without the human polish a prompt author brings. Fine for judge prompts (their job is mechanical scoring). Wrong for agent prompts where the role paragraph, negations, and edge-case examples require author judgment.

```
  Where meta-prompting fits

  data is well-typed?           yes → meta-prompting works
                                 no  → hand-written prompt

  output is mechanical?          yes → meta-prompting fits
                                 no  → hand-written prompt

  data has 40+ dims?             yes → sanity-check the data,
                                        not the built prompt
                                 no  → both work
```

### Move 2 variant — the load-bearing skeleton

The kernel of meta-prompting is three moves:

```
  typed data → deterministic builder → prompt string as function output
```

What breaks if you skip each:

- **Skip "typed data"** — the data is a plain object. Adding a dimension without the required fields breaks the builder at runtime, not compile time. Debugging becomes "which dimension is missing which field?"
- **Skip "deterministic builder"** — the builder has branching or random-order iteration. Same data produces different prompts on different runs. Cache breaks, evals become non-reproducible.
- **Skip "prompt string as function output"** — you build the prompt at author-time and paste it in as a string. Now the data and the prompt are two sources of truth; they drift.

Hardening layered on top: builder tests (the builder is a pure function, easy to unit-test), snapshot tests of the built prompt (catch drift when the data structure changes), separate rubric versions per iteration (`id: 'blooming-diagnosis-quality-v1'` — the `-v1` is the version-bump seam).

### Move 3 — the principle

**When the source of truth is data, the prompt is a serialization.** Meta-prompting is the discipline of moving prompt structure from string to typed object, so changes to the "prompt" become changes to code-reviewed, compiler-checked data. The prompt-string is then a rendered artifact, not a hand-written one — and the rendering function's determinism is what makes the whole discipline honest.

## Primary diagram

```
  Meta-prompting in this codebase — two depths

  ┌── heavy meta-prompting: RubricJudge ────────────────────┐
  │                                                          │
  │  ┌── rubric data (source of truth) ────────────────┐    │
  │  │  eval/rubrics/diagnosis-quality.ts               │    │
  │  │  { title, task, dimensions[4], verdicts[3],      │    │
  │  │    checks[4] }                                   │    │
  │  └────────────────────┬────────────────────────────┘    │
  │                       │                                  │
  │  ┌── builder ─────────▼────────────────────────────┐    │
  │  │  buildRubricJudgeSystemPrompt(rubric)            │    │
  │  │  concatenates: task + dims text + verdicts text +│    │
  │  │                checks text + output-shape example│    │
  │  │  @aptkit/evals/dist/src/rubric-judge.js:31-77     │    │
  │  └────────────────────┬────────────────────────────┘    │
  │                       │                                  │
  │  ┌── judge system prompt ▼─────────────────────────┐    │
  │  │  "You are a rubric judge for: Diagnosis quality. │    │
  │  │   … dimensions text …                            │    │
  │  │   … verdicts text …                              │    │
  │  │   … checks text …                                │    │
  │  │   Use exactly this shape: {dimensions:…}"         │    │
  │  └─────────────────────────────────────────────────┘    │
  └─────────────────────────────────────────────────────────┘

  ┌── light meta-prompting: agent prompts ──────────────────┐
  │                                                          │
  │  ┌── static template ──────────────────────────────┐    │
  │  │  MONITORING_PROMPT = "You are …                 │    │
  │  │                        {schema}                  │    │
  │  │                        {categories}"             │    │
  │  └────────────────────┬────────────────────────────┘    │
  │                       │                                  │
  │  ┌── value computers ─▼────────────────────────────┐    │
  │  │  schemaSummary(workspace)                        │    │
  │  │  formatCategoryChecklist(categories)             │    │
  │  └────────────────────┬────────────────────────────┘    │
  │                       │                                  │
  │  ┌── renderPromptTemplate ▼───────────────────────┐    │
  │  │  substring replacement: {schema} → schemaText   │    │
  │  │  no structure change; slot values only          │    │
  │  └─────────────────────────────────────────────────┘    │
  └─────────────────────────────────────────────────────────┘
```

## Elaborate

The internet-thread version of "meta-prompting" is "use an LLM to help you write your prompts." That's meta-prompting at the *author* stage — a productivity aid for humans, not a runtime discipline. This concept file is about the runtime version: the prompt is built by code from data every time the LLM is called, so the data is where changes land.

There's a spectrum. On the light end: template interpolation with `{name}` slots. On the heavy end: a fully-derived prompt where sections, ordering, and content all come from data. This codebase sits in both places — light for agents (the template is stable, slots vary), heavy for the judge (the whole prompt is derived from the rubric object). The heavy shape earns tokens when the "prompt" is really a translation of a data shape into text the LLM can read.

The specific gain from meta-prompting the judge: when you add a rubric dimension, you edit *one* place (the rubric object). The judge's system prompt, the JSON validator (`createRubricJudgmentValidator` at `rubric-judge.js:85-137`), and the output shape example all update automatically. Without meta-prompting, adding a dimension is a three-edit change with the risk of drift. The single-source-of-truth-in-data pattern is what makes rubric evolution safe.

Anthropic and OpenAI both offer "prompt libraries" that generate prompts from higher-level specs (Anthropic's Metaprompt tool, OpenAI's function-calling schema-driven prompts). Those are useful for one-off drafting. What this codebase does — data as source of truth, deterministic builder, code-reviewed data changes — is the production-runtime version of the same idea.

Related concepts:
- **Prompts as code** (`03-prompts-as-code.md`) — meta-prompted prompts are still versioned artifacts; the source-of-truth is just shifted to data.
- **Structured outputs** (`02-structured-outputs.md`) — the meta-generated output shape example is few-shot for structured output.
- **Self-critique** (`10-self-critique.md`) — the judge's system prompt is meta-prompted.
- **Eval-driven iteration** (`05-eval-driven-iteration.md`) — the rubric object drives both the judge prompt and the eval infrastructure.

## Interview defense

**Q: Walk me through the meta-prompting in this codebase. What's derived from data, what's still hand-written?**

Two depths. **Light** meta-prompting in the agent prompts: `MONITORING_PROMPT` is a hand-written template with `{schema}` and `{categories}` slots, and `renderPromptTemplate` fills them from `schemaSummary(workspace)` and `formatCategoryChecklist(categories)`. The structure is author-time; the values are call-time. **Heavy** meta-prompting for the judge: `buildRubricJudgeSystemPrompt(rubric)` walks the rubric's dimensions, verdicts, and checks arrays and assembles the whole system prompt from that data. Adding a rubric dimension means editing one typed object; the judge's prompt, output-shape example, and validator all update from that one edit. The choice of light vs heavy: agent prompts need author judgment for the role paragraph and edge-case examples; judge prompts are mechanical scoring where the data-driven shape works.

Anchors: `renderPromptTemplate` used at `@aptkit/agent-anomaly-monitoring/dist/src/monitoring-agent.js:42-45`; `buildRubricJudgeSystemPrompt` at `@aptkit/core/node_modules/@aptkit/evals/dist/src/rubric-judge.js:31-77`.

```
  Two depths of meta-prompting

  agent prompt:    template + slots     ← light (values from data)
  judge prompt:    builder(rubric)      ← heavy (structure from data)
```

**Q: What's the risk of meta-prompting?**

Two risks. First, the built prompt becomes unreadable — 40 dimensions concatenated is a wall of text nobody code-reviews as prose. Mitigation: keep the data small (this codebase's rubrics have four dimensions), and code-review the *data*, not the built prompt. Second, meta-prompted prompts read like generated code — mechanical, repetitive, no author polish. Fine for a judge whose job is mechanical. Wrong for an agent role paragraph, negations, or edge-case examples where hand-crafted judgment is what earns tokens. The rule: meta-prompt when the shape is data-shaped (rubrics, schemas, catalogs). Hand-write when the shape needs authorial voice (agent roles).

```
  When to meta-prompt vs hand-write

  data-shaped, mechanical scoring   → meta-prompt (RubricJudge)
  authorial voice, negations, edge  → hand-write (agent role paragraphs)
  slot values from computed data    → light meta-prompting (renderPromptTemplate)
```

**Q: What's the load-bearing part people forget?**

The determinism of the builder. If the builder walks `Object.keys(rubric.dimensions)` and the object key ordering isn't stable, the built prompt varies between runs. Two callers, same rubric, different prompts. Prompt caching (see `04-token-budgeting.md`) breaks because the cached prefix doesn't match the current call. Reproducibility of the judge's scoring collapses. The fix is trivial (use arrays, use `.map` with an explicit order) but the failure mode is silent — you don't notice the cache miss unless you check the logs. The builder in this codebase iterates arrays, not object keys, so ordering is deterministic. But this is one of the specific gotchas of the shape.

Anchor: `rubric.dimensions.map(...)` at `@aptkit/core/node_modules/@aptkit/evals/dist/src/rubric-judge.js:32-38` — array, not object-keys iteration.

## See also

- `03-prompts-as-code.md` — meta-prompted prompts are still versioned.
- `05-eval-driven-iteration.md` — the rubric-as-data pattern.
- `08-few-shot.md` — the output-shape example is meta-generated few-shot.
- `10-self-critique.md` — the LLM-as-judge whose prompt is meta-generated.
