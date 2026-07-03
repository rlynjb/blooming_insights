# 03 · Prompts as code

**Industry name:** *prompts as code* / *prompt version control* / *prompt observability* · Language-agnostic

## Zoom out — where the prompts live in this repo

Two versions of the prompts exist in this codebase at the same time. That's not an accident; it's how a real prompt migration works.

```
  Zoom out — the split prompt surface

  ┌─ blooming_insights ────────────────────────────────────────┐
  │                                                             │
  │  lib/agents/legacy-prompts/                                 │
  │    monitoring.md    ← retired string prompt (rollback)      │
  │    diagnostic.md    ← retired string prompt (rollback)      │
  │    query.md         ← ACTIVE for the /api/agent query flow  │
  │    recommendation.md ← retired string prompt (rollback)     │
  │                                                             │
  │  lib/agents/                                                │
  │    monitoring.ts    ← thin wrapper around @aptkit/core       │
  │    diagnostic.ts    ← thin wrapper around @aptkit/core       │
  │    recommendation.ts ← thin wrapper around @aptkit/core      │
  │                                                             │
  └────────────────────────┬────────────────────────────────────┘
                           │  compose
  ┌─ @aptkit/core (npm package) ──▼─────────────────────────────┐
  │  AnomalyMonitoringAgent           ← system prompt inside     │
  │  DiagnosticInvestigationAgent     ← system prompt inside     │
  │  RecommendationAgent              ← system prompt inside     │
  └─────────────────────────────────────────────────────────────┘
```

The legacy string prompts stayed. They read like an English spec of what the agent does. The active prompts moved into `@aptkit/core` because the agent *loops* moved there — a system prompt is fully coupled to the tool-loop it drives, so the prompt goes where the loop goes.

## Zoom in — what "prompts as code" actually means here

Two orthogonal things people mean when they say "prompts as code":

1. **The prompt is a file, not a runtime string.** Version-controlled, diffable, reviewable in PR. `lib/agents/legacy-prompts/*.md` is exactly this shape.

2. **The prompt has a version paired with the model version.** A prompt that worked on Sonnet 3.5 breaks on Sonnet 4 (this happened, more than once). "Prompts as code" as a discipline means treating that pairing as first-class — logging which prompt version drove which output, tagging both together.

This repo does the first well. The second, less well — the migration to aptkit made the prompt version opaque (it's a package version now). That's an honest tradeoff.

## Structure pass — layers, axis, seams

Trace one axis: *where does the prompt string physically live*, and *who owns edits* at each layer.

- **Layer 1 — legacy markdown at `lib/agents/legacy-prompts/*.md`.** Owned by this repo. Reviewable in PR. Currently a rollback receipt, not the live path (except `query.md`).
- **Layer 2 — TypeScript wrappers at `lib/agents/*.ts`.** Own the *context* (schema, categories, anomaly) that goes into the prompt. Do not own the prompt string.
- **Layer 3 — `@aptkit/core` classes.** Own the actual live-path system prompt. Not editable in this repo — you'd edit the package.

**The seam:** the package boundary between blooming and aptkit. On one side, prompt strings are editable in a PR. On the other side, they're editable only by publishing a new aptkit version. This seam is the whole cost of the migration.

## How it works

### Move 1 — the shape

You've done this pattern before: config-as-code. You know the payoff — instead of a config UI you can't diff, the config is a file, checked into git, PR-reviewable, and the deploy pipeline is the source of truth. Same shape here. Prompt-as-code means the prompt is a file the same way `next.config.mjs` is a file. Not a string in a database. Not a runtime edit surface. A file.

```
  Pattern — prompts as code

  ┌─ your repo ─────────────────────────┐
  │  prompts/                            │
  │    monitoring.md                     │  ← same shape as
  │    diagnostic.md                     │     next.config.mjs
  │    recommendation.md                 │     or drizzle.config.ts
  └────────────────────────┬─────────────┘
                           │  imported / templated
                           ▼
                     ┌─────────────┐
                     │ runtime uses │
                     └─────────────┘
                           │
  ┌────────────────────────▼──────────┐
  │  observability: log which          │
  │  prompt-version drove which        │
  │  output on this deploy             │
  └────────────────────────────────────┘
```

The reason it's not just a code smell: prompts drift when they're not in a file. Someone edits them in a UI. Someone else edits them in a Notion doc. No one knows which version is live. Two weeks later, an eval regresses and there's no way to bisect. The file-based version is the fix.

### Move 2 — walking the two versions

#### The retired string prompts (`lib/agents/legacy-prompts/*.md`)

Four markdown files, one per agent. They're actual instructions — you can read `lib/agents/legacy-prompts/diagnostic.md` and know exactly what the diagnostic agent used to do. Section headers, hard rules, a JSON schema for output, an example.

Two placeholder syntaxes visible in the source:

```
Pass `project_id: {project_id}` to every tool call.
…
## Anomaly to investigate

{anomaly}
…
## Workspace schema

{schema}
```

`{project_id}`, `{anomaly}`, `{schema}` — those are the context-injection points from concept 01. The TypeScript loader used to `readFileSync` the markdown, replace those placeholders with the runtime values, and pass the result as `system` to the model.

Why kept? Two reasons:

1. **Rollback receipt.** If aptkit's active-path prompt regresses on an eval, you have a known-good version to A/B against.
2. **Onboarding.** A markdown file explaining the agent is a better introduction to what the agent *does* than the aptkit source code plus the blooming wrapper plus the model provider adapter.

`query.md` is the exception. It's still active — the `/api/agent` route uses it directly, because there's no aptkit `QueryAgent` yet. That's the one file where a PR change to the markdown ships to production.

#### The live-path prompts (inside `@aptkit/core`)

The monitoring / diagnostic / recommendation prompts moved to aptkit when the agent classes moved. `lib/agents/monitoring.ts:83-92`:

```
const agent = new AptKitAnomalyMonitoringAgent({
  model: new AnthropicModelProviderAdapter(this.anthropic, 'monitoring', this.sessionId),
  tools: toolRegistry,
  workspace: this.schema,
  trace: new BloomingTraceSinkAdapter(hooks ?? {}, 'monitoring'),
  categories: categories.length ? toAptKitCategories(categories, this.schema.projectId) : [],
});
```

Blooming hands aptkit the *ingredients* — model provider, tool registry, workspace schema, categories. Aptkit assembles the actual system prompt inside `scan()` using those ingredients. The prompt itself lives in aptkit source, not in blooming.

**What this costs:** to edit the prompt shape (add a new rule, change output format), you edit the aptkit package. To edit the *context* going into the prompt (which categories, which schema summary), you edit blooming. That's the boundary. It's clean, and it hurts.

Where it hurts most: rapid iteration. In the days when the prompt was `lib/agents/legacy-prompts/diagnostic.md`, iterating meant editing the file, running `npm run eval`, seeing the receipts. Now it means either editing the aptkit package (which lives in another repo you may or may not have write access to), or reaching under aptkit's API to override the prompt (which breaks the abstraction).

```
  Layers-and-hops — legacy vs live-path edit flow

  ┌─ legacy (retired) ──────────────────────────┐
  │  edit diagnostic.md   →   npm run eval       │  ← one hop, fast
  └──────────────────────────────────────────────┘

  ┌─ live-path (aptkit) ────────────────────────┐
  │  edit @aptkit/core   →   publish package     │  ← two hops
  │                      →   bump version here   │
  │                      →   npm run eval         │
  └──────────────────────────────────────────────┘
```

#### Prompt observability — what's here, what's missing

The active path logs per-call `usage` at `lib/agents/aptkit-adapters.ts:97-101`:

```
console.log(JSON.stringify({
  site: this.logSite,
  sessionId: this.sessionId,
  usage: response.usage,
}));
```

`sessionId` ties log lines from the same investigation together. `logSite` names which agent (`agents/diagnostic:aptkit-model`, `agents/monitoring:aptkit-model`, etc.). What's *not* logged: the prompt version. There's no aptkit-package-version field in that JSON, no prompt-hash. If the aptkit package updates and evals regress, you'd have to bisect by git log rather than by log query.

This is the honest gap. The Hamel Husain / Simon Willison discipline is: log the prompt hash on every call, so you can filter production traces by prompt version and see which one was live when a bad output happened. This repo does that at the *agent* granularity (which agent, which session) but not at the *prompt-version* granularity.

For the eval harness, each `case` receipt captures the model name at `eval/run.eval.ts:353` (`model: { agent: 'claude-sonnet-4-6', judge: 'claude-sonnet-4-6' }`). That's the *model* version. Prompt version is implicit in the runId (`sharedRunId = new Date().toISOString()...`) — you correlate by "which git commit was checked out when this run happened."

Not ideal. Not broken. Good enough that the rubric-quality regressions are usually catchable.

### Move 2 variant — the load-bearing skeleton

If I had to reconstruct "prompts as code" as a minimum viable pattern:

1. **Prompt is a file.** Drop this and you lose diffability, PR review, and history. The whole discipline collapses.
2. **Prompt is templated with runtime values.** Drop this and the prompt is either constant (fine for simple agents) or hand-formatted at runtime (drifts).
3. **Prompt version is logged alongside outputs.** Drop this and you can't correlate a bad production output to a specific prompt commit. This is the load-bearing part most repos skip.
4. **Prompt changes ship through the same review process as code changes.** Drop this and someone edits the prompt on production Friday afternoon.

Hardening layered on top: a prompt-serving service (LangSmith / PromptLayer / hand-rolled), A/B testing infrastructure, blue/green prompt deploys. None of that is the skeleton — the skeleton is: file + template + version log + PR review.

This repo has 1, 2, and 4 clean. Number 3 is partial — sessionId + model name, no prompt-version stamp.

### Move 3 — the principle

**Where the prompt lives is a design choice, and it has costs.** Keeping the prompt in your repo as markdown is fast to iterate but tangles the prompt with the loop. Extracting the prompt to a package (aptkit) makes the agent reusable across repos but slows down iteration and hides the version. The "right" answer depends on how many repos need the agent — one → keep it local; two or more → extract. This codebase made the extract call and is paying the iteration tax. That's the whole discipline: pick the tradeoff on purpose, not by default.

## Primary diagram

```
  Prompts as code — the full recap

  ┌─ blooming_insights repo ───────────────────────────────────────┐
  │                                                                 │
  │  lib/agents/legacy-prompts/                                     │
  │    monitoring.md         (retired · rollback receipt)           │
  │    diagnostic.md         (retired · rollback receipt)           │
  │    query.md              ★ ACTIVE for /api/agent               │
  │    recommendation.md     (retired · rollback receipt)           │
  │                                                                 │
  │  lib/agents/                                                    │
  │    monitoring.ts   ────► new AptKitAnomalyMonitoringAgent({...}) │
  │    diagnostic.ts   ────► new AptKitDiagnosticInvestigationAgent │
  │    recommendation.ts ──► new AptKitRecommendationAgent          │
  │                                                                 │
  │  lib/agents/aptkit-adapters.ts                                  │
  │    logs { site, sessionId, usage }  ← observability point       │
  │    NO prompt-version field yet                                  │
  │                                                                 │
  └────────────────────────┬──────────────────────────────────────┘
                           │  the seam
  ┌─ @aptkit/core (external package) ─▼──────────────────────────┐
  │  actual system prompts live here                              │
  │  edit → publish → bump version in blooming → test              │
  └───────────────────────────────────────────────────────────────┘
```

## Elaborate

The pattern that makes prompts-as-code work at scale is *both* — the file lives in the repo and the version is logged in the trace. The blooming eval receipts get 90% there: `receipts/<caseId>-<runId>.json` includes the model, the tool calls, the token usage, and the raw diagnosis output. The remaining 10% — which git commit / aptkit version was live — is inferable from the runId timestamp against `git log`, but it's not one hop, it's several.

Hamel Husain's writing on this: the prompt is one artifact among many that need version-log-diff discipline. So does your eval set. So does your golden data. So do your rubrics. This codebase does the eval-set and rubric versions inline (`id: 'blooming-diagnosis-quality-v1'` at `eval/rubrics/diagnosis-quality.ts:16` — the `v1` is the version stamp). The prompt version is the last piece missing, and it's non-trivial to add cleanly once the prompt lives in a package.

The related pattern from `aipe` (Rein's meta-tooling project): markdown-as-source-of-truth. Every prompt is a markdown file with frontmatter. Slash commands compose them. The prompt-version discipline is enforced by aipe's own convention (spec version in the frontmatter). This blooming codebase inherits some of that — `lib/agents/legacy-prompts/*.md` is the same shape — but the migration to aptkit means the *live* prompts don't get that treatment. Trade-offs.

## Interview defense

**Q: Why do the legacy prompts still exist in the repo if they're not on the live path?**

Two reasons. One, rollback receipts — if the active aptkit-owned prompt regresses on the eval, we have a known-good version to A/B against. Two, they're the cleanest documentation of what each agent does. `lib/agents/legacy-prompts/diagnostic.md` reads like an English spec. The aptkit source plus the wrapper plus the adapter is where the actual instructions are, but no one wants to trace three package boundaries to understand what the diagnostic agent's job is. The markdown stays as a first-read receipt.

```
  live path        blooming/*.ts → aptkit class → prompt inside package
  rollback anchor  lib/agents/legacy-prompts/diagnostic.md
```

Anchor: `lib/agents/legacy-prompts/diagnostic.md` and `lib/agents/diagnostic.ts:47-60`.

**Q: What's missing from prompt observability in this codebase?**

The prompt version isn't stamped on the log line. `AnthropicModelProviderAdapter.complete()` logs `site`, `sessionId`, and `usage` per call — that gets you agent identity and token spend, but not which aptkit version was live. Right now you'd correlate by runId timestamp against `git log`. It's a gap. The Hamel Husain / Simon Willison discipline is: log a prompt-hash on every call so production traces can be filtered by prompt version. The fix is one extra field, but it needs to originate inside aptkit (which owns the prompt string), and that's another package change.

```
  currently logged:  { site, sessionId, usage }
  missing:            + promptHash / aptkitVersion
```

Anchor: `lib/agents/aptkit-adapters.ts:97-101`.

## See also

- 01 · anatomy — what's in a prompt when you decide it should live in a file.
- 05 · eval-driven iteration — how the eval harness catches prompt regressions.
- 11 · meta-prompting — using an LLM to draft the prompt that then goes into version control.
