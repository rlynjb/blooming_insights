# 03 — Prompts as code: versioning and observability

*Prompts-as-source · Industry standard*

## Zoom out, then zoom in

Where does the *source-of-truth* for a production prompt live? Not in a chat box. Not in a Notion doc. Pull up where it lives in this repo.

```
  Where the prompt source-of-truth lives

  ┌─ Source control (git) ──────────────────────────────────────────┐
  │  lib/agents/legacy-prompts/monitoring.md     ← reviewed in PRs    │
  │  lib/agents/legacy-prompts/diagnostic.md       diffable, blameable │
  │  lib/agents/legacy-prompts/recommendation.md   audit log via git    │
  │  lib/agents/legacy-prompts/query.md                                 │
  └──────────────────────┬───────────────────────────────────────────┘
                         │  readFileSync at module load
  ┌─ Build / runtime ▼ ──────────────────────────────────────────────┐
  │  const PROMPT = readFileSync(...legacy-prompts/monitoring.md...) │ ← we are here
  │  // imported once per agent, interpolated per call                │
  └──────────────────────┬───────────────────────────────────────────┘
                         │
  ┌─ Anthropic API ▼ ────────────────────────────────────────────────┐
  │  claude-sonnet-4-6 — prompt + model VERSION = the unit that ships  │
  └──────────────────────────────────────────────────────────────────┘
```

A production prompt is *source code with a different syntax*. It lives in the repo, gets reviewed in PRs, gets diffed by `git blame`, and ships with a specific model version. The instant you treat it as anything less — a config string, a Notion doc, a "let me just edit this in the UI" — you lose every property that lets you ship safely.

## Structure pass

**Layers.** Outer: the prompt in source control. Middle: the prompt loaded into the running process. Innermost: the prompt + model pair that actually runs.

**Axis — what changes here vs what doesn't.** Walk it:

```
  one axis — "is this part allowed to change between deploys?" — three layers

  ┌─ layer 1: .md file in git ─────────┐
  │  CHANGES via PR only               │   reviewed, diffed, blameable
  └────────────────────────────────────┘
       ┌─ layer 2: PROMPT const in process ─┐
       │  IMMUTABLE per deploy              │   readFileSync at module load
       └────────────────────────────────────┘
            ┌─ layer 3: prompt + model pair ──┐
            │  CHANGES on deploy OR upgrade   │   the unit you regression-test
            └─────────────────────────────────┘
```

**Seams.** The git-to-process seam is `readFileSync(join(process.cwd(), 'lib/agents/legacy-prompts/...md'))`. The process-to-model seam is the SDK call — the same prompt against `claude-sonnet-4-6` vs `claude-sonnet-4-7` is *two different deployments* from a regression-testing standpoint.

## How it works

### Move 1 — the mental model

You know how you don't write SQL queries as concatenated strings inline in your route handlers — you put them in `.sql` files, version them with migrations, review the diff in PRs? Same shape, different file extension.

```
  Three artifacts that ship together as ONE deploy

  ┌──────────────┐          ┌──────────────┐          ┌──────────────┐
  │  prompt.md   │  ──+──►  │  model ver   │  ──=──►  │  prod        │
  │  (vN in git) │          │  (sonnet-4-6)│          │  behavior    │
  └──────────────┘          └──────────────┘          └──────────────┘
       │                          │                          │
       PR-reviewed                bumped in code             tested against
       diffable                   tied to a date             eval set (or
                                                             demo snapshot
                                                             in this repo)
```

Change *either* of the first two and the behavior changes. Both belong in source control. Both belong in the PR. Both belong in the deployment story.

### Move 2 — the walkthrough

**The .md file as source.** Look at `lib/agents/legacy-prompts/monitoring.md`. It's a markdown file with three things: prose rules, fenced examples, and `{placeholder}` interpolation points. It is *literally readable* by a human, and it reviews like prose in a PR. Here's the top:

```
You are the monitoring agent in blooming insights, an AI analyst for an
ecommerce workspace running on Bloomreach Engagement (EQL-shaped tools).

## Role
...

## Hard rules
1. Pass `project_id: {project_id}` to every tool call.
2. ...
```

Because it's markdown, it renders nicely on GitHub during code review. Because it's *one file per agent*, you can `git log lib/agents/legacy-prompts/monitoring.md` to see every change ever made to the monitoring prompt. Because the placeholders are explicit (`{project_id}`, `{schema}`, `{categories}`), the boundary between "stable prompt" and "per-call injection" is visible in the source.

**The load step — `readFileSync` at module top.** `lib/agents/monitoring-legacy.ts:13`:

```typescript
const PROMPT = readFileSync(
  join(process.cwd(), 'lib/agents/legacy-prompts/monitoring.md'),
  'utf8',
);
```

One read, at module load, into a `const`. The prompt is then *immutable for the lifetime of the process*. This matters more than it looks:

  → **No accidental mutation.** The string is `const`, not a let or a global config.
  → **No file watchers, no hot-reload of prompts at runtime.** The prompt that shipped with this deploy is the prompt that runs.
  → **The unit of change is a deploy.** To change the prompt, you change the file, commit, push, deploy. That's it. There's no admin UI to "edit the prompt live." Concept 11 (meta-prompting) is what people reach for when they want that, and it has its own tradeoffs.

**The interpolation step.** `lib/agents/monitoring-legacy.ts:95-98`:

```typescript
const system = PROMPT
  .replace('{schema}', schemaSummary(this.schema))
  .replace(/\{project_id\}/g, this.schema.projectId)
  .replace('{categories}', checklist);
```

Three named placeholders, three substitutions. No `eval`, no template engine, no `${}` interpolation. The dynamism is explicit: those three values change per call; everything else is stable. The boundary between "what I committed" and "what I sent" is exactly three string substitutions.

**Prompt + model — the unit that ships.** Look at `lib/agents/base-legacy.ts:10`:

```typescript
export const AGENT_MODEL = 'claude-sonnet-4-6';
```

Pinned model version. Not "the latest sonnet" — a specific version. This is the other half of "prompts as code": you don't just version the prompt, you version the *combination*. When Anthropic releases Sonnet 4.7, the active codebase keeps running 4.6 until somebody bumps this constant in a PR.

Here's what an actual model-upgrade PR would look like in this repo:

```
  PR — "Upgrade monitoring agent to Sonnet 4.7"

  diff --git a/lib/agents/base-legacy.ts b/lib/agents/base-legacy.ts
  -export const AGENT_MODEL = 'claude-sonnet-4-6';
  +export const AGENT_MODEL = 'claude-sonnet-4-7';

  diff --git a/lib/agents/legacy-prompts/monitoring.md b/lib/agents/legacy-prompts/monitoring.md
  -3. Make at most 6 tool calls total, then stop and return your JSON answer.
  +3. Make at most 5 tool calls total (4.7 is more decisive), then stop and return your JSON answer.
```

The two changes ship together. The PR description names the regression test (which, in this repo, is the captured demo snapshot at `lib/state/demo-*.json` — see concept 05). The PR reviewer can see the *exact* prompt diff and the *exact* model bump in one place.

**Layers-and-hops view of one prompt change reaching production:**

```
  Layers-and-hops — prompt change → production

  ┌─ Editor ───────────────────────────────────────────────┐
  │  open lib/agents/legacy-prompts/monitoring.md           │
  │  edit rule 3                                            │
  └──────────────┬─────────────────────────────────────────┘
                 │ hop 1: git diff (reviewable, prose-level diff)
  ┌─ Pull request ▼ ───────────────────────────────────────┐
  │  PR rendered on GitHub with prose-style diff             │
  │  reviewer compares against demo snapshot output          │
  └──────────────┬─────────────────────────────────────────┘
                 │ hop 2: merge to main
  ┌─ Deploy (Vercel) ▼ ────────────────────────────────────┐
  │  next build → readFileSync runs at module load time     │
  │  prompt baked into the bundle                            │
  └──────────────┬─────────────────────────────────────────┘
                 │ hop 3: request comes in
  ┌─ Runtime ▼ ────────────────────────────────────────────┐
  │  PROMPT const interpolated, sent to AGENT_MODEL          │
  │  output validated, streamed to UI                        │
  └────────────────────────────────────────────────────────┘
```

Every hop preserves the prompt-as-source property. No admin UI mutation. No live editing. No "let me just patch this on prod." If the prompt is wrong on production, the fix is a PR.

**What's missing in this repo (Case B for prompt observability).** This is the honest gap. The legacy `.md` files are version-controlled, but at runtime there's no log line that says "this output was produced by prompt vSHA + model v4-6." If a customer reports "the diagnosis was wrong," there's no way to look up which exact prompt version they got.

What that would look like:

```
  What's missing — runtime prompt-version logging

  ┌─ Agent call ──────────────────────────────────────────┐
  │  console.log({                                          │
  │    site: 'agents/monitoring',                           │
  │    promptSha: 'abc123' /* git sha of monitoring.md */,  │
  │    model: AGENT_MODEL,                                  │
  │    sessionId,                                           │
  │  });                                                    │
  └───────────────────────────────────────────────────────┘
```

The structured log line already exists at `lib/agents/aptkit-adapters.ts:57-61` — it logs `site`, `sessionId`, and `usage`. Adding `promptSha` and `model` would close the loop. Without it, prompt + model are versioned in *source* but not in *traces* — you can git-blame a prompt change, but you can't trace "which prompt version produced this specific UI output."

The other gap: **no automated regression detection across model upgrades.** When Sonnet 4 → 4.6 shipped, this repo manually compared outputs against the demo snapshot. Concept 05 walks what eval-driven iteration would look like; the prompts-as-code discipline is the *prerequisite* for evals (you can't run a regression suite against a prompt-version you don't have).

### Move 3 — the principle

The thing that makes a prompt safe to change is the same thing that makes any code safe to change: it lives in version control, ships through PRs, runs against a regression suite. The discipline is identical to SQL-migration discipline or schema-migration discipline. The only thing that's specific to prompts is that the regression suite has to handle *probabilistic* output — which is what concept 05 is about.

## Primary diagram — prompts as code, the full pipeline

```
  ┌─ Source of truth ───────────────────────────────────────────────────┐
  │  lib/agents/legacy-prompts/{monitoring,diagnostic,recommendation,    │
  │     query}.md                                                         │
  │  + lib/agents/base-legacy.ts:AGENT_MODEL = 'claude-sonnet-4-6'        │
  └────────────────────┬────────────────────────────────────────────────┘
                       │ git
  ┌─ PR ▼ ──────────────────────────────────────────────────────────────┐
  │  prompt diff renders as prose-level diff                              │
  │  reviewer sanity-checks against demo snapshot output                  │
  └────────────────────┬────────────────────────────────────────────────┘
                       │ deploy
  ┌─ Process ▼ ─────────────────────────────────────────────────────────┐
  │  readFileSync at module load → const PROMPT                          │
  │  AGENT_MODEL constant                                                 │
  │  IMMUTABLE for the lifetime of this process                          │
  └────────────────────┬────────────────────────────────────────────────┘
                       │ per request
  ┌─ Call site ▼ ───────────────────────────────────────────────────────┐
  │  PROMPT.replace('{schema}', ...).replace(/\{project_id\}/g, ...)     │
  │  anthropic.messages.create({ model: AGENT_MODEL, system: <interp>, …})│
  └─────────────────────────────────────────────────────────────────────┘
  ┌─ Missing in this repo (next step) ─────────────────────────────────┐
  │  runtime log line with promptSha + model so traces can be tied       │
  │  back to the exact prompt version (concept 05's prerequisite)        │
  └─────────────────────────────────────────────────────────────────────┘
```

## Elaborate

The pattern in this repo is the *minimum viable* prompts-as-code shape: `.md` files in git, `readFileSync` at module load, named placeholders, pinned model version. It's the same shape `aipe` itself (your meta-tooling project) takes — slash commands map to `.md` template files, frontmatter for variables, the markdown body as the prompt source. The convergence is real: any system that needs to *edit prompts safely* converges here.

The richer end of this discipline:

- **Prompt registries** (PromptLayer, LangSmith, OpenAI's prompt management). External services that store prompts and surface a version-history UI. Useful when non-engineers need to edit prompts; overhead otherwise.
- **In-context prompt versioning.** The next step from this codebase: tag every log line with the prompt's git SHA, so a trace can be tied back to the exact version. Cheap to add (one extra field), invaluable when debugging "why was *this* output produced?"
- **A/B testing prompts.** Run two prompts against the same input, score the outputs. Requires the eval substrate (concept 05) to be real.

Where to read next: Hamel Husain's *"Your AI Product Needs Evals"* (hamel.dev/blog/posts/evals/) — the canonical reference for why prompts-as-code is the *prerequisite* for evals. Simon Willison's running thread on prompts-as-source. PromptLayer's docs for what a managed prompt-registry looks like; you'll see the same shape with a different syntax.

In this codebase, concept 05 (eval-driven iteration) is the discipline that turns prompts-as-code from "we can version them" into "we can change them safely." Without evals, prompts-as-code gives you *visibility* (you can see what changed); with evals, it gives you *confidence* (you know what the change did).

## Interview defense

**Q: "Where do your prompts live?"**

In the repo, as `.md` files under `lib/agents/legacy-prompts/`. Loaded with `readFileSync` at module top into a const. *(Draw the diagram.)* The interpolation step is three explicit `String.prototype.replace` calls — no template engine. The whole prompt is reviewable in a PR as a prose diff, blameable with `git blame`, and ships as part of the bundle.

```
  .md file in git  →  readFileSync at module load  →  const  →  per-call interpolation
```

Anchor: *"the prompt is source code. It lives in the repo, reviews in PRs, ships in deploys."*

**Q: "What happens when Anthropic releases a new model?"**

It's a one-line PR that ships *with* whatever prompt changes are needed: `AGENT_MODEL` constant bumps in `base-legacy.ts`, prompt rules adjust in the relevant `.md`. The two ship together because they're one regression. The honest gap in this repo: I don't have an automated regression suite, so the verification is by-hand against the captured demo snapshot. The *next* version of this discipline is what concept 05 walks — an eval set the PR runs against in CI.

```
  PR diff:                                          regression check today:
  - AGENT_MODEL = 'claude-sonnet-4-6';              compare against
  + AGENT_MODEL = 'claude-sonnet-4-7';              lib/state/demo-*.json
  + ...prompt rule edits in monitoring.md           by-hand (gap; eval set
                                                    is the next step)
```

Anchor: *"prompt + model are one unit. They ship together because they're one regression."*

**Q: "What's missing in your version of this?"**

Two things. One: runtime prompt-version logging — I version the prompt in source but don't tag it in the log line, so I can't trace a specific UI output back to a specific prompt version. The fix is one extra field in the existing structured log at `aptkit-adapters.ts:57`. Two: an automated regression suite. I have the captured demo snapshot, which is a useful single-data-point regression check, but it's not an eval set. Concept 05 is what I'd build next.

Anchor: *"prompts-as-code without runtime version logging is half the discipline. The other half is tying the trace back to the exact prompt version that ran."*

## See also

- `01-anatomy.md` — the four-section structure is what fits cleanly into a `.md` file with named placeholders.
- `05-eval-driven-iteration.md` — prompts-as-code is the prerequisite for evals; without versioned prompts, you can't measure what a change did.
- `11-meta-prompting.md` — when "non-engineers want to edit prompts" comes up, this is the path. Tradeoffs are real.
