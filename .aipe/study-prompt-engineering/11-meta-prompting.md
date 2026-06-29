# Meta-prompting

**Industry standard** · prompts that generate prompt content at runtime

## Zoom out — where meta-prompting fires in this codebase

The clearest case of meta-prompting in blooming is the *runnable-category checklist* that gets injected into the monitoring agent's `{categories}` slot. The categories themselves are defined as TypeScript objects with metadata (id, label, requires, eql recipe, thresholds); at request time, a coverage check decides which ones the current workspace can run; the runnable subset is formatted into a markdown list that becomes part of the system prompt. The monitoring agent's prompt is *partly* generated, per call, by code that knows what the workspace supports.

```
  Zoom out — where the categories meta-prompt lives

  ┌─ TS source (anomaly-category metadata) ─────────────────┐
  │  lib/agents/categories.ts                                │
  │  CATEGORIES: AnomalyCategory[] = [                       │
  │    { id: 'revenue_drop', label: '...', whyItMatters, eql,│
  │      thresholds: { critical, warning }, requires: [...]},│
  │    ...                                                   │
  │  ]                                                       │
  └─────────────────────────┬───────────────────────────────┘
                            │  runtime capability check
  ┌─ runnableCategories(available) ──▼──────────────────────┐
  │  filters CATEGORIES by what the workspace can do         │
  │  → returns subset that has all required signals          │
  └─────────────────────────┬───────────────────────────────┘
                            │
  ┌─ monitoring agent assembly ──▼──────────────────────────┐
  │  checklist = runnable.map(c =>                           │
  │    `- \`${c.id}\` (${c.label}) — ${c.whyItMatters}        │
  │      recipe: \`${c.eql(projectId)}\`. flag when           │
  │      |Δ| ≥ ${c.thresholds.warning}% (critical ≥ ...).`   │
  │  ).join('\n')                                            │
  │  → markdown list, baked into {categories} slot           │
  └─────────────────────────┬───────────────────────────────┘
                            │
  ┌─ PROMPT ──▼─────────────────────────────────────────────┐
  │  monitoring.md template, {categories} replaced           │
  └─────────────────────────────────────────────────────────┘
```

## Zoom in

Meta-prompting is the pattern where one piece of code generates prompt content for another LLM call. The strongest version uses an LLM to write or refine prompts (LLM-as-prompt-engineer). The version blooming exercises is gentler: TypeScript code generates the *runtime-variable section* of a prompt from structured metadata. Both count. The pattern earns its place when the prompt's content genuinely needs to change per call (workspace capabilities differ; user inputs vary) — not as a generic "let's get fancy" move.

## Structure pass

**Layers.** Two altitudes: the *static template* (the `.md` file with slots) and the *generated content* (the strings that fill the slots, computed at request time).

**Axis traced — who writes this text.** Hold one question constant: *who or what produces the words the model reads?*

```
  Axis = authorship — who writes each part of the prompt?

  ┌─ committed .md text ───────────────────────────────────┐
  │   human-authored, reviewed in PRs                       │
  │   ## Role, ## Hard rules, ## Output, the example        │
  └─────────────────────────────────────────────────────────┘
                              │
  ┌─ {schema} slot (schemaSummary output) ──▼───────────────┐
  │   code-authored, deterministic                          │
  │   reads WorkspaceSchema, applies caps, formats           │
  └─────────────────────────────────────────────────────────┘
                              │
  ┌─ {categories} slot (the meta-prompt) ──▼────────────────┐
  │   code-authored, capability-gated                       │
  │   reads runnable subset, formats as markdown list        │
  └─────────────────────────────────────────────────────────┘
                              │
  ┌─ {anomaly} / {diagnosis} slots ──▼──────────────────────┐
  │   upstream-agent-authored                               │
  │   the previous chain's structured output, JSON.stringified│
  └─────────────────────────────────────────────────────────┘
```

**Seams.** The metadata → markdown seam is where the meta-prompting happens. The code reads structured TypeScript objects (`AnomalyCategory[]`) and produces markdown text (`- \`revenue_drop\` (Revenue drop) — ...`). The contract for that seam is "the markdown form will appear inside the system prompt verbatim, so it has to be correct markdown, correct backtick escaping, and tone-consistent with the surrounding template." Change the metadata; the prompt changes automatically. That's the win — and the risk if the markdown formatter has a bug.

## How it works

### Move 1 — the meta-prompting pattern

You know how a templating engine generates HTML from data — Mustache, Handlebars, JSX? Meta-prompting is the same shape, scaled to LLM prompts. There's a template with slots, there's structured data (metadata, user input, prior outputs), and there's code that combines them. The output is text that goes into the next LLM call. The "meta" part is that the generated text is *itself* instructional content the LLM reads.

```
  Pattern — meta-prompt as template + structured data

  ┌─ template (committed) ──────────────────────────────────┐
  │  monitoring.md                                           │
  │  ...                                                     │
  │  ## Your category checklist                              │
  │  Check each of these — and only these. ...               │
  │  {categories}              ← slot                        │
  │  ## Hard rules                                           │
  │  ...                                                     │
  └─────────────────────────┬───────────────────────────────┘
                            │  + structured data
  ┌─ data ──────────────────▼───────────────────────────────┐
  │  CATEGORIES = [                                          │
  │    { id, label, whyItMatters, eql, thresholds }, ...     │
  │  ]                                                       │
  └─────────────────────────┬───────────────────────────────┘
                            │  + formatter
  ┌─ generator (TypeScript) ▼──────────────────────────────┐
  │  runnable                                                │
  │    .map(c => `- \`${c.id}\` (${c.label}) — ...`)         │
  │    .join('\n')                                           │
  └─────────────────────────┬───────────────────────────────┘
                            │  →  filled-in template
  ┌─ assembled prompt ──────▼───────────────────────────────┐
  │  ## Your category checklist                              │
  │  Check each of these — and only these. ...               │
  │  - `revenue_drop` (Revenue drop) — Sustained revenue ... │
  │  - `conversion_drop` (Conversion drop) — Funnel quality...│
  │  ...                                                     │
  │  ## Hard rules                                           │
  │  ...                                                     │
  └─────────────────────────────────────────────────────────┘
```

### Move 2 — the categories meta-prompt in code

The formatting code lives in `lib/agents/monitoring-legacy.ts:84-93`:

```
  // monitoring-legacy.ts:84-93 — the meta-prompt formatter
  const checklist = categories.length
    ? categories
        .map(
          (c) =>
            `- \`${c.id}\` (${c.label}) — ${c.whyItMatters} ` +
            `recipe: \`${c.eql(this.schema.projectId)}\`. ` +
            `flag when |Δ| ≥ ${c.thresholds.warning}% ` +
            `(critical ≥ ${c.thresholds.critical}%).`,
        )
        .join('\n')
    : '(no checklist provided — scan for any significant recent change)';

  const system = PROMPT
    .replace('{schema}', schemaSummary(this.schema))
    .replace(/\{project_id\}/g, this.schema.projectId)
    .replace('{categories}', checklist);
```

A few details earn their place. **The empty-list fallback** — if no categories are runnable (the workspace has so few signals that nothing applies), the slot becomes `(no checklist provided — scan for any significant recent change)`. That's a deliberate degradation: instead of leaving the slot empty (which would produce an awkward heading with no content), the formatter inserts a one-line fallback that's still useful to the model. **The threshold interpolation** — each category's `thresholds.warning` and `thresholds.critical` are baked into the rule text, so the model knows the threshold per category without having to remember a global rule. The thresholds are themselves metadata, version-controlled in `lib/agents/categories.ts` (the aptkit version in `@aptkit/core` for the active path). **The EQL recipe** — `c.eql(projectId)` materializes the per-category query template with the right project id substituted, so the model has a concrete starting query for each category.

The whole formatter is ~10 lines. The benefit it gives the monitoring agent: every per-call prompt has exactly the categories this workspace can run, with the right thresholds, with the right recipes. Without the meta-prompt, the monitoring prompt would have to enumerate every category statically and the agent would waste tool calls on categories the workspace can't support.

### Move 2 — the capability check, where the meta-prompt is gated

The meta-prompt depends on a prior capability check. Read `lib/agents/categories.ts:44-46`:

```
  // lib/agents/categories.ts:44-46
  export function runnableCategories(available: Set<string>): AnomalyCategory[] {
    return aptKitRunnableCategories(CATEGORIES.map(toAptKitCategory), available)
      .map(toBloomingCategory);
  }
```

`available` is a `Set<string>` of event names the workspace actually emits (computed from the bootstrap schema fetch). The function filters `CATEGORIES` to those whose `requires` list is satisfied by `available`. The result is the *runnable subset* — the categories that can plausibly produce a result against this specific workspace.

The route calls `runnableCategories` before invoking the monitoring agent, passes the subset to `monitoring.scan(hooks, runnable)`, and the formatter turns it into the markdown checklist. Workspaces that emit `purchase` events get `revenue_drop` in the checklist; workspaces that don't, get a checklist without it. The monitoring prompt is *per workspace*, not just per call.

This is meta-prompting in the productive sense: the prompt content reflects what the system can do. It's not "let's ask an LLM to write our prompt"; it's "let's have code decide what the prompt should say based on runtime capabilities." Both count as meta-prompting; this version is more predictable.

### Move 2 — the LLM-as-prompt-engineer version (what blooming does NOT do)

The strongest version of meta-prompting uses an LLM to author or refine prompts:

```
  Hypothetical LLM-as-prompt-engineer flow (not in blooming)

  ┌─ human writes the goal ────────────────────────────────┐
  │   "Write a prompt that classifies user queries into     │
  │    monitoring, diagnostic, or recommendation. Output    │
  │    should be one word."                                 │
  └─────────────────────────┬──────────────────────────────┘
                            │
  ┌─ LLM drafts the prompt ─▼──────────────────────────────┐
  │   model produces:                                       │
  │   "You are a classifier. Classify..."                   │
  └─────────────────────────┬──────────────────────────────┘
                            │
  ┌─ human reviews + edits ─▼──────────────────────────────┐
  │   refine the draft, add edge-case handling              │
  └─────────────────────────┬──────────────────────────────┘
                            │
  ┌─ prompt enters the codebase ▼──────────────────────────┐
  │   committed as .md, runs as the actual classifier       │
  └────────────────────────────────────────────────────────┘
```

blooming doesn't do this at runtime (no part of the system uses an LLM to write a prompt for another LLM call), and the workflow above is mostly an authoring aid — useful for getting a first draft of a complex prompt fast, less useful for iterative refinement (where the LLM-drafted prose tends to read like LLM output rather than like engineering specs).

The reader's aipe project *does* exercise the LLM-as-prompt-engineer pattern via its slash commands — the meta-prompting where a human writes the goal, the model drafts the prompt, the human reviews. blooming's version is more conservative: deterministic code generation of a per-call slot, not LLM authorship of the whole prompt.

### Move 2 — when meta-prompting saves time vs when it doesn't

The categories case is a clear win: 10 categories × 5+ fields each (id, label, requires, eql, thresholds, whyItMatters) × per-workspace variability = too much to hand-maintain in the prompt. Code that generates the markdown is shorter, more correct, and easier to update.

Cases where meta-prompting wouldn't help:

- **The system prompt header.** "You are the monitoring agent... your role is..." — this is stable, low-volume, well-suited to direct editing. Generating it from a TypeScript object would add abstraction without saving labor.
- **The output schema example.** The worked Anomaly object in the prompt is reviewed alongside the type guard and the TypeScript interface. Generating it from the type would lose the ability to add explanatory comments and example-specific values (the `30%` and `critical` pairing that pins the threshold).
- **Small prompts that don't change.** The intent classifier's prompt is 4 lines. Meta-prompting it would be longer than the prompt.

The rule: meta-prompt the parts that *legitimately vary per call or per environment*; hand-write the parts that don't.

### Move 2 — the risk: prompts that read like LLM output

The spec calls this out explicitly. When an LLM is used to author prompts, the resulting prompts often read like LLM output — verbose, hedging, full of "please" and "kindly," missing the assertive voice of a working engineer. The aipe / slash-command pattern works because there's a human review step: the LLM drafts; the human edits down. Without the review step, prompts accumulate fluff over time.

blooming's category meta-prompt avoids this because the formatter is deterministic code — the markdown comes out the same shape every time, no fluff, no LLM hedging. The prompt as a whole still gets human-written, human-reviewed components (the .md template). The mix is right: code-generated for runtime variability, human-written for instructional content.

### Move 3 — the principle

Meta-prompting is the move that lets prompts adapt to runtime context without bloating the template. Use it for the parts that legitimately vary (workspace capabilities, available signals, upstream agent outputs); hand-write the parts that don't (rules, output schema, examples). When you reach for LLM-as-prompt-engineer, keep a human in the loop — drafted prompts read like LLM output without review, and the agents that consume them inherit the fluff.

## Primary diagram

```
  Meta-prompting in blooming — the categories slot, end to end

  ┌─ STATIC METADATA (TypeScript, committed) ──────────────────────┐
  │  lib/agents/categories.ts (mirror of @aptkit/core categories)   │
  │  CATEGORIES: AnomalyCategory[] = [                              │
  │    { id: 'revenue_drop',                                         │
  │      label: 'Revenue drop',                                      │
  │      requires: ['purchase', 'purchase.total_price'],             │
  │      whyItMatters: '...',                                        │
  │      eql: (projectId) => 'select sum event purchase...',         │
  │      thresholds: { warning: 10, critical: 20 } },                │
  │    ...                                                           │
  │  ]                                                                │
  └────────────────────────────────────────┬───────────────────────┘
                                            │  per request
  ┌─ CAPABILITY GATE ──────────────────────▼───────────────────────┐
  │  runnableCategories(available_event_set):                        │
  │    filter CATEGORIES by requires ⊆ available                    │
  │  → runnable subset (workspace-specific)                          │
  └────────────────────────────────────────┬───────────────────────┘
                                            │
  ┌─ FORMATTER (monitoring-legacy.ts:84-93) ▼──────────────────────┐
  │  runnable.map(c =>                                               │
  │    `- \`${c.id}\` (${c.label}) — ${c.whyItMatters} ` +           │
  │    `recipe: \`${c.eql(projectId)}\`. ` +                         │
  │    `flag when |Δ| ≥ ${c.thresholds.warning}% (critical ≥ ${c.thresholds.critical}%).`)│
  │    .join('\n')                                                   │
  │  → markdown checklist                                            │
  └────────────────────────────────────────┬───────────────────────┘
                                            │
  ┌─ SLOT INTERPOLATION (monitoring-legacy.ts:95-98) ▼─────────────┐
  │  PROMPT.replace('{categories}', checklist)                       │
  └────────────────────────────────────────┬───────────────────────┘
                                            │
  ┌─ ASSEMBLED PROMPT (the model sees this) ▼──────────────────────┐
  │  ## Your category checklist                                      │
  │  - `revenue_drop` (Revenue drop) — ... recipe: `select sum...`   │
  │    flag when |Δ| ≥ 10% (critical ≥ 20%).                         │
  │  - `conversion_drop` (Conversion drop) — ...                     │
  │  ...                                                              │
  └─────────────────────────────────────────────────────────────────┘
```

## Elaborate

The reader's aipe project is the canonical example of meta-prompting at the *authoring* layer: slash commands that take a human-written goal and produce a draft prompt or skill file. That pattern is well-suited to one-off authoring tasks — getting the first draft of a new prompt fast — and less well-suited to iterative refinement, where every iteration round-trips through the LLM and the prose drifts in ways the human reviewer has to actively prune. The pragmatic version: draft with an LLM, edit with a human, commit the edited version. Don't have the LLM in the iteration loop.

blooming's categories meta-prompt is the *runtime* version: code generates the variable slot per call, no LLM involved in the prompt authorship. This works well because the metadata is structured (TypeScript objects) and the format is simple (markdown list). The category code generates ~10 lines of markdown per call; the rest of the prompt is human-authored. The split is the right one.

A subtle benefit of meta-prompting: it lets you *separate the rules from the instances*. The rule "flag when |Δ| ≥ warning% (critical ≥ critical%)" is universal across categories; the actual thresholds (10%, 20% for revenue_drop) are per-category. Without meta-prompting, you'd either hard-code each category's thresholds into the prompt prose (drift-prone, hard to update) or hand-wave the thresholds and let the model decide (loose, inconsistent). The meta-prompt formats the rule with the category-specific thresholds plugged in, so the model sees a concrete rule per category and a consistent format across them.

The risk to watch: meta-prompt content drift. The formatter at `monitoring-legacy.ts:84-93` controls a load-bearing part of every monitoring call. A bug in the formatter — say, swapping `${c.thresholds.warning}` with `${c.thresholds.critical}` — would silently change the agent's behavior across every category, on every call, without any prompt file change. The TypeScript types catch most categories of mistake (a typo would fail to compile); the semantic mistakes (swapping fields, wrong join character) wouldn't. The fix is the same as for any code-generated text: write a test that asserts the generated markdown matches a snapshot for known inputs, and re-run the test on every change to the formatter. blooming doesn't have this test today; the demo snapshots are the closest thing.

Eugene Yan and Hamel Husain both write about meta-prompting as a *production* pattern (capability-gated, deterministic, code-generated) rather than as a research pattern (LLM-as-prompt-engineer). The production version is harder to find in tutorials but more common in shipped systems — anywhere a prompt needs to adapt to per-tenant configuration, per-user preferences, or per-workspace capabilities, you'll find code that generates a slot at runtime. blooming's categories slot is one of many possible cases; whenever a future agent needs to know what's available in *this* workspace, the same pattern is the move.

## Interview defense

**Q: Why generate the categories list at runtime instead of hard-coding it in the prompt?**

A: Two reasons that compound. **Workspace variability** — not every workspace emits every event. A workspace that doesn't track checkouts can't run a `cart_abandonment` category; if the prompt had it hard-coded, the model would waste tool calls trying to query a metric that doesn't exist. The runnable-categories check (`lib/agents/categories.ts:44`) filters the list to what this workspace actually supports, and the meta-prompt formatter injects only those into the prompt. **Maintenance** — when a new category gets added or a threshold gets tuned, the change is one TypeScript object: id, label, requires, eql recipe, thresholds. The prompt regenerates automatically with the new shape. The alternative would be enumerating all 10 categories statically in the prompt and remembering to update the prose every time a threshold moves — drift-prone and error-prone. Meta-prompt the parts that vary; hand-write the parts that don't.

```
  what I'd sketch:

  hard-coded prompt:                  meta-prompted slot:
  ─────────────────                   ───────────────────
  all 10 categories listed            only runnable subset listed
  thresholds in prose                  thresholds from metadata
  agent wastes calls on               agent only sees what
   unsupported categories              applies to this workspace
  every threshold change               threshold change is a
   = prompt-file edit                  one-line TypeScript edit
```

**Q: When would you NOT use meta-prompting?**

A: When the prompt content doesn't legitimately vary, meta-prompting adds abstraction without saving work. The intent classifier's system message is 4 lines of stable rules; meta-prompting it would be longer than the prompt itself. The diagnostic agent's `## Investigation approach` section is the same procedure every time; generating it from a JSON spec would be more code, not less. The output schema example in each prompt is co-designed with the type guard and the TypeScript interface; generating it from the type would lose the ability to add per-example values (the `30%` paired with `critical` that pins the threshold). The rule: meta-prompt the parts that vary per call or per environment; hand-write the parts that are universal. The categories slot varies per workspace, so meta-prompting earns its place; the rules section is universal, so it doesn't.

```
  meta-prompting decision rule:

  does this part change per call/env?
                  │
       yes ───────┴─────── no
       │                   │
   meta-prompt it    hand-write it
   (categories,      (rules, schema,
    user query,       output example,
    upstream output)  procedure)
```

## See also

- [01-anatomy.md](./01-anatomy.md) — `{categories}` is one of the interpolation slots in the four-section anatomy
- [03-prompts-as-code.md](./03-prompts-as-code.md) — meta-prompting is what makes "prompts as code" cover the variable parts too
- [04-token-budgeting.md](./04-token-budgeting.md) — `schemaSummary` is another code-generated slot; both compress for the budget
- [06-single-purpose-chains.md](./06-single-purpose-chains.md) — capability gating (per-agent tool registry) is the structural cousin of meta-prompt gating
