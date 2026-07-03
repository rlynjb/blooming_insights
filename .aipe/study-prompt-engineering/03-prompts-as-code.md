# 03 · Prompts as code: versioning and observability

**Prompt packages / templated system prompts / prompt versioning — Industry standard**

## Zoom out, then zoom in

You wouldn't accept a code review where a colleague inlines a 90-line SQL query into three different components as a string literal. You'd insist it goes in one file, gets a name, gets reviewed. Prompts are the same. In this codebase, prompts live in one place — `@aptkit/core`'s prompt packages — versioned, named, template-slotted, and imported by the agent classes. Nothing inlines a system prompt as a string literal.

```
  Zoom out — where prompts-as-code sits

  ┌─ Version control (git) ─────────────────────────────────┐
  │  aptkit package: monitoring, diagnostic,                │
  │  recommendation .js prompt packages                     │
  └───────────────────────────┬─────────────────────────────┘
                              │  imported by
  ┌─ Agent classes ───────────▼─────────────────────────────┐
  │  @aptkit/core: MonitoringAgent, DiagnosticInvestigation  │
  │  Agent, RecommendationAgent                             │
  │  wrap: monitoringPromptPackage.system, etc.             │
  └───────────────────────────┬─────────────────────────────┘
                              │  renderPromptTemplate(...)
  ┌─ Blooming wrappers ───────▼─────────────────────────────┐
  │  lib/agents/monitoring.ts wraps AptKit's agent          │
  │  passes schema summary + categories + hooks             │
  └───────────────────────────┬─────────────────────────────┘
                              │
  ┌─ Model provider adapter ──▼─────────────────────────────┐
  │  ★ THIS IS WHERE PROMPT + MODEL VERSION MEET ★           │  ← we are here
  │  AnthropicModelProviderAdapter                          │
  │  defaultModel = 'claude-sonnet-4-6' (base.ts:7)         │
  │  system = the versioned prompt package's system text    │
  └─────────────────────────────────────────────────────────┘
```

**Zoom in.** Prompts-as-code has three properties: (1) each prompt is a single named artifact in one place, imported not duplicated; (2) each prompt is paired with a specific model version, because a prompt that works on Sonnet 4.6 can regress on Sonnet 4.7; (3) each production call logs enough to answer "which prompt version produced this output?" months later.

This codebase has (1) via `@aptkit/prompts` package structure. It has (2) implicitly via `AGENT_MODEL = 'claude-sonnet-4-6'` (`lib/agents/base.ts:7`) being colocated with the agent-loading code. It has (3) via console-log JSON of usage per model call (`aptkit-adapters.ts:97-101`) and per-case receipts in eval (`eval/receipts/*.json`).

## Structure pass

### Axes — the dimension we're tracing

**Ownership and identity.** For every prompt in production, someone must be able to answer three questions: (a) where does this prompt live in the repo? (b) what model version does it pair with? (c) which git SHA produced the output I'm looking at? Trace ownership across the layers and you find where the discipline is holding up and where it's a shrug.

### Seams — where ownership flips

Two important seams:

- **prompt file vs agent code** — the prompt is defined in `@aptkit/prompts` (the "what does the model do" file); the agent class is in `@aptkit/agent-*` (the "how the loop runs" file). Ownership flips at that boundary: prompt engineer owns one, agent architect owns the other.
- **package version vs invocation** — the prompt has a `version: '0.1.0'` in its package definition. Every production call could log which version was used. This codebase logs model + usage per call but not the prompt package version explicitly — see the "gap" note below.

### Layered decomposition

"What identifies a specific prompt call?" traced down:

```
  "What identifies this specific prompt call?" — same question, three altitudes

  ┌────────────────────────────────────────────────┐
  │ outer: the git SHA                              │  → the whole prompt file
  │        (what code was deployed?)                │
  └────────────────────────────────────────────────┘
      ┌───────────────────────────────────────────┐
      │ middle: prompt package version + model    │  → this specific pairing
      │         (versioned artifact in code)       │  ran with THIS model
      └───────────────────────────────────────────┘
          ┌───────────────────────────────────────┐
          │ inner: this call's rendered text      │  → schema/anomaly vars
          │        (system string after slotting) │  filled at runtime
          └───────────────────────────────────────┘
```

## How it works

### Move 1 — the mental model

You know how a database migration file gets a timestamp prefix, a name, and a version so you can answer "which version of the schema was this row written under" — a prompt package is that discipline for prompts.

```
  Prompt package — the shape

  ┌─────────────────────────────────────────┐
  │  monitoringPromptPackage = {             │
  │    id: 'anomaly-monitoring-agent.default',│
  │    version: '0.1.0',                     │
  │    capabilityId: 'anomaly-monitoring-agent'│
  │    system: MONITORING_PROMPT,            │  ← the actual prompt text
  │    variables: [                          │  ← what gets slotted in
  │      { name:'schema', required:true },   │
  │      { name:'categories', required:true }│
  │    ],                                    │
  │    examples: [ ... ]                     │  ← evaluation examples
  │  }                                       │
  └─────────────────────────────────────────┘
```

That's the shape. Every prompt in this codebase is one of these objects, importable, addressable by id, versionable independently of the agent that uses it.

### Move 2 — the step-by-step walkthrough

**Step 1 — the prompt lives in one file, named.**

`@aptkit/core/node_modules/@aptkit/prompts/dist/src/monitoring.js:1-29`:

```js
export const MONITORING_PROMPT = `
You are an anomaly-monitoring agent for an analytics workspace.

Your job is to detect measurable anomalies only. Do not diagnose causes. Do not propose actions.

Workspace schema:
{schema}

Runnable category checklist:
{categories}

Rules:
- Run only categories in the checklist unless the checklist is empty.
...
`;
```

`MONITORING_PROMPT` is a template literal with `{schema}` and `{categories}` placeholders. It is *not* concatenated with strings elsewhere. It is *not* duplicated across files. It is imported by exactly one place — the agent class that runs it. This is the first-order discipline, and skipping it is why so many codebases end up with three near-identical system prompts scattered across four files with subtle drift between them.

**Step 2 — the package metadata makes the prompt addressable.**

Same file, lines 30-57:

```js
export const monitoringPromptPackage = {
    id: 'anomaly-monitoring-agent.default',
    version: '0.1.0',
    capabilityId: 'anomaly-monitoring-agent',
    description: 'Bounded anomaly detection over runnable workspace metric categories.',
    system: MONITORING_PROMPT,
    variables: [
        { name: 'schema', ... required: true },
        { name: 'categories', ... required: true },
    ],
    examples: [ ... ],
};
```

The `id` and `version` are what turn a string into a versioned artifact. When you upgrade a prompt (say the categories interpolation changes format), you bump the version, and any observability layer can answer "which prompt version produced this output" by logging the package id + version.

```
  Prompt package — the metadata seam

  ┌────────────────────────┬──────────────────────────────┐
  │  MONITORING_PROMPT     │  the raw string              │
  │  (template literal)    │  (identity: the file)         │
  └────────────────────────┴──────────────────────────────┘
                    │
                    │  wrapped in metadata
                    ▼
  ┌────────────────────────┬──────────────────────────────┐
  │  monitoringPromptPackage │  addressable artifact       │
  │  { id, version, system │  (identity: id + version)     │
  │    variables, examples}│                              │
  └────────────────────────┴──────────────────────────────┘
```

**Step 3 — the agent code imports, never inlines.**

`@aptkit/core/node_modules/@aptkit/agent-anomaly-monitoring/dist/src/monitoring-agent.js:1`:

```js
import { monitoringPromptPackage, renderPromptTemplate } from '@aptkit/prompts';
```

And in the scan method:

```js
this.prompt = options.prompt ?? monitoringPromptPackage.system;
...
const system = renderPromptTemplate(this.prompt, {
    schema: schemaSummary(this.options.workspace),
    categories: formatCategoryChecklist(categories),
});
```

Two things happen here. First, `this.prompt` defaults to the package's `system` but accepts an override — that's how you swap prompts for A/B tests without touching the agent class. Second, `renderPromptTemplate` does the actual slotting — the variables named in the package's `variables` array become the required inputs.

**Step 4 — the model version is paired with the prompt at load time.**

`lib/agents/base.ts:1-8`:

```ts
export const AGENT_MODEL = 'claude-sonnet-4-6';
```

That one constant is the model-version pairing for every non-classifier agent in the codebase. Why one constant? Because in this codebase's current shape, all four agents use the same model (Sonnet 4.6). If they diverged — say the recommendation agent moved to Sonnet 4.7 for tone reasons — you'd have per-agent constants. The classifier already does this: `CLASSIFIER_MODEL = 'claude-haiku-4-5-20251001'` (`lib/agents/intent.ts:16`), because the classifier is a cheap fast model and its prompt was tuned against Haiku specifically.

```
  Model-prompt pairing — what changes when

  Same model version across agents?          Different per agent?
  ─────────────────────────────                ──────────────────────
  one AGENT_MODEL constant                     per-agent constants
  colocated with agent code                    classifier is already like this
                                                (CLASSIFIER_MODEL in intent.ts)
   ┌─ base.ts ─┐                              ┌─ base.ts ────────────────┐
   │ AGENT_MODEL│                              │ MONITORING_MODEL          │
   └────────────┘                              │ DIAGNOSTIC_MODEL          │
                                                │ RECOMMENDATION_MODEL      │
                                                └───────────────────────────┘

  This is not a demo/prod distinction — it's a "have you had to
  change one agent's model in isolation yet?" distinction.
  If yes, split. If no, one constant is fine.
```

**Step 5 — observability: which prompt version produced this output?**

`lib/agents/aptkit-adapters.ts:97-101`:

```ts
console.log(JSON.stringify({
  site: this.logSite,
  sessionId: this.sessionId,
  usage: response.usage,
}));
```

Every model call logs the site (`agents/diagnostic:aptkit-model`), the session id (which threads through the whole investigation), and the token usage. What's missing from this log is the prompt package version — you can reconstruct which prompt was used by pairing the git SHA of the deployment with the `logSite`, but the log doesn't self-identify the prompt version.

This is the honest gap. In a codebase where prompts iterate weekly, you'd log `promptPackageId` and `promptPackageVersion` here so any receipt or trace could point at exactly which prompt produced it. This codebase doesn't yet — the prompts have been stable since aptkit was extracted, and the receipts identify the prompt implicitly via git SHA. When the prompts start iterating (post the Week 3B caching work, the prompt structure may need tuning), adding these two fields to the log is the next observability step.

### Move 2 variant — the load-bearing skeleton

The kernel of prompts-as-code:

```
  prompt file (named, versioned) → agent import → model pairing → per-call log
```

What breaks if you strip each:

- **Strip "prompt file, named"** — prompts scatter as string literals. Two components using nearly-the-same prompt drift silently. Fixing a rule in one doesn't fix it in the other.
- **Strip "versioned"** — you can't answer "which prompt shipped last Tuesday" without git archaeology. Post-mortems take three times longer.
- **Strip "model pairing"** — someone upgrades the model as a maintenance PR, evals never run, and 30% of your outputs regress overnight. This is the specific bug — a model upgrade that changes emission style just enough to break your parser or your rubric.
- **Strip "per-call log"** — you can't correlate a bad output to the specific call that produced it. Debugging becomes "run it again and hope it reproduces."

Hardening layered on top: prompt package versions in the log (this codebase's gap), A/B testing infrastructure (swap `options.prompt` at load time), prompt diff CI checks (fail the PR if a prompt changed without an eval run).

### Move 3 — the principle

**Prompts have the same lifecycle as any other production artifact: written, reviewed, versioned, deployed, logged, iterated.** Skipping any step of that lifecycle for prompts specifically — because "it's just text" — is what makes LLM features fragile. The moment prompts became code, they inherited every discipline code has always required.

## Primary diagram

```
  Prompts as code — the full lifecycle

  ┌── author-time ──────────────────────────────────────┐
  │                                                     │
  │  ┌── prompt file ──────────────────────────┐        │
  │  │  @aptkit/prompts/src/monitoring.ts       │        │
  │  │  export const MONITORING_PROMPT = `...`  │        │
  │  │  export const monitoringPromptPackage = {│        │
  │  │    id, version: '0.1.0', system,         │        │
  │  │    variables, examples                   │        │
  │  │  }                                       │        │
  │  └──────────────┬───────────────────────────┘        │
  │                 │  git commit + review                │
  └─────────────────┼───────────────────────────────────┘
                    │
  ┌── load-time ────▼───────────────────────────────────┐
  │  agent class imports the package                    │
  │  MonitoringAgent constructor stores:                │
  │    this.prompt = options.prompt ?? pkg.system       │
  │    this.model  = AGENT_MODEL (from base.ts)         │
  └────────────────┬────────────────────────────────────┘
                   │
  ┌── call-time ───▼────────────────────────────────────┐
  │  renderPromptTemplate(this.prompt, {schema, cat…})  │
  │  provider.complete({ system, messages })            │
  │  console.log({ site, sessionId, usage })            │
  └────────────────┬────────────────────────────────────┘
                   │
  ┌── observability ▼───────────────────────────────────┐
  │  per-call log lets you correlate:                   │
  │    session → agent → model version → git SHA        │
  │  ← gap: prompt package version not yet in log       │
  └─────────────────────────────────────────────────────┘
```

## Elaborate

The canonical reference for treating prompts as code is Hamel Husain's writing on LLM evals — the whole discipline of "the prompt is source code, evaluate it like source code" starts there. Simon Willison's `llm` CLI and its template files are another practical implementation of the same discipline: prompts are named, versioned files, addressable by id.

Where the discipline breaks down in practice: **inlined "just for this feature" prompts.** A PM asks for a small feature — "add a tooltip that explains what this metric means" — and someone inlines a two-line prompt call inside the component. It works. It ships. Six months later there are eleven of these inline prompts, three of them near-duplicates, none of them versioned, none of them in an eval. The rule that stops this: **any prompt over one line goes in `@aptkit/prompts`.** One-liners for cheap classifiers (see the intent classifier's inline `'Classify the user query as exactly one word...'` at `@aptkit/agent-query/dist/src/intent.js:13`) are the exception, and only because they're stable and not worth the ceremony.

The Anthropic prompt engineering guide (docs.anthropic.com) is the vendor-side companion — it describes the discipline from the model-behavior side. Hamel writes from the eval side. Both together are the working literature.

Related concepts:
- **Anatomy** (`01-anatomy.md`) — the sections inside the prompt file.
- **Token budgeting** (`04-token-budgeting.md`) — the variables slot is where token cost lives.
- **Eval-driven iteration** (`05-eval-driven-iteration.md`) — the discipline that prompts-as-code exists to serve.

## Interview defense

**Q: Why do you version prompts, and what specifically do you log per call?**

Because "the prompt that shipped last Tuesday" is a real question you'll be asked during a post-mortem, and reconstructing it from git blame takes hours. Each prompt is a package with an id and a version. Every production model call logs at minimum: the session id (thread through the whole investigation), the agent that made the call (`agents/diagnostic:aptkit-model`), the model version (Sonnet 4.6 in this codebase), and the token usage. The gap in this codebase — worth flagging honestly — is that the log doesn't include the prompt package version explicitly; you infer it from the git SHA of the deployment. When prompts iterate weekly that inference becomes lossy and you add `promptId` + `promptVersion` to the log.

```
  Per-call log shape

  ┌────────────────────────────────────┐
  │ site: agents/diagnostic:aptkit-model│  which agent
  │ sessionId: eval-<runId>-<caseId>    │  which run
  │ usage: { input_tokens, output_tokens│  cost
  │       cache_read_input_tokens }     │
  │ promptId: 'diagnostic-invest…'      │  ← the gap
  │ promptVersion: '0.1.0'              │  ← the gap
  └────────────────────────────────────┘
```

Anchor: `AnthropicModelProviderAdapter.complete()` at `lib/agents/aptkit-adapters.ts:97-101`.

**Q: A colleague upgrades the model from Sonnet 4.6 to 4.7 as a maintenance PR. Merged. Suddenly 30% of your evals regress. What went wrong?**

The prompt was tuned for Sonnet 4.6's emission style. Sonnet 4.7 changed the emission style in a way that broke a downstream parser or a rubric expectation — even in a way as small as "adds an extra sentence before the JSON fence." The prompt-model pairing wasn't treated as a versioned unit. The fix long-term: model version is part of the prompt package's pairing metadata, and bumping the model is treated as bumping the prompt version, which requires an eval run before merge. The fix short-term: revert, run the evals against 4.7, adjust the prompt, ship both together.

```
  When model version changes without prompt version — the failure

  time t0: prompt v0.1.0 + Sonnet 4.6 = pass rate 92%
                  │
                  │ maintenance PR: model → 4.7 only
                  ▼
  time t1: prompt v0.1.0 + Sonnet 4.7 = pass rate 62%
                                          ↑
                                    the prompt wasn't recompiled
                                    against the new model
```

**Q: Where does the intent classifier's inline prompt fit in this discipline?**

`lib/agents/intent.ts:16` and its underlying `classifyIntent` in `@aptkit/agent-query/dist/src/intent.js` — the classifier prompt is a one-line inline string, not a package. That's the exception. Cheap classifiers with a stable prompt, a stable cheap model (Haiku 4.5), and a stable output (one word) are allowed to skip the ceremony because the surface area is tiny. If the classifier grew to five lines, or if we started A/B testing classifier prompts, it would migrate to a package.

Anchor: `classifyIntent` at `@aptkit/core/node_modules/@aptkit/agent-query/dist/src/intent.js:11-23`.

## See also

- `01-anatomy.md` — the sections that make up the prompt file.
- `04-token-budgeting.md` — the cache-control breakpoint that pairs with the versioned system prompt.
- `05-eval-driven-iteration.md` — what versions exist to serve.
- `12-prompt-injection-defense.md` — versioned prompts are also auditable prompts.
