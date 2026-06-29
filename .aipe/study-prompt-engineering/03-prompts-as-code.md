# Prompts as code

**Industry standard** · versioning, observability, deployment

## Zoom out — where prompts live in the repo

Prompts in blooming are not strings inlined in TypeScript. They're committed markdown files at `lib/agents/legacy-prompts/{monitoring,diagnostic,query,recommendation}.md`, loaded at process boot with `readFileSync`, interpolated with slot replacement, and shipped to the model on every call. That choice is what makes the rest of this concept's discipline possible.

```
  Zoom out — prompts in the file tree

  ┌─ Repo root ──────────────────────────────────────────────┐
  │  lib/agents/                                              │
  │  ├─ monitoring.ts          ← active agent (aptkit wrap)   │
  │  ├─ diagnostic.ts                                          │
  │  ├─ recommendation.ts                                      │
  │  ├─ query.ts                                               │
  │  ├─ monitoring-legacy.ts   ← prior in-tree path           │
  │  ├─ legacy-validate.ts                                     │
  │  └─ ★ legacy-prompts/ ★                              ← we are here
  │     ├─ monitoring.md       (the system prompt, in git)    │
  │     ├─ diagnostic.md                                       │
  │     ├─ recommendation.md                                   │
  │     └─ query.md                                            │
  └──────────────────────────────────────────────────────────┘
```

## Zoom in

The pattern: prompts are *source code*. They live in files, they're versioned in git, they're diffed in pull requests, they're reviewed by humans, and changes to them are tracked the same way changes to TypeScript are. The opposite — prompts inlined as multi-line template literals in `.ts` files — is fine for one-off scripts and a quiet disaster at scale. This concept is about why and how the file-based pattern wins.

## Structure pass

**Layers.** Three altitudes of "what is the prompt right now": the file on disk (commit-time), the loaded-and-interpolated string (request-time), the in-flight call (model-time).

**Axis traced — observability.** Hold one question constant: *can I tell which version of the prompt produced this output?*

```
  Axis = observability — version-trace each altitude

  ┌─ file on disk ─────────────────────────────────────────┐
  │   git log lib/agents/legacy-prompts/monitoring.md      │
  │   → every change has a commit, author, message         │
  │   → blameable, revertable, diff-able                   │
  └────────────────────────────────────────────────────────┘
                              │
  ┌─ loaded + interpolated string (in memory) ─────────────┐
  │   monitoring-legacy.ts:13 reads with readFileSync       │
  │   → file is read ONCE at module load                    │
  │   → server restart = prompt reloaded                    │
  │   → the {schema}/{categories} slots are per-request     │
  └────────────────────────────────────────────────────────┘
                              │
  ┌─ in-flight call ───────────────────────────────────────┐
  │   logged: { site, sessionId, usage } at base.ts:135     │
  │   NOT logged: the actual prompt text                    │
  │   ← observability gap (see Elaborate)                   │
  └────────────────────────────────────────────────────────┘
```

**Seams.** The load-time seam (`readFileSync` at module load) means changes to the `.md` don't take effect until the server restarts — that's the deployment story. The interpolation seam (`.replace()` calls in each agent) is where the per-call data joins the static template — that's the contract surface other concepts care about. The model-call seam is where "which prompt produced this output?" gets answered or doesn't — and as the diagram shows, blooming currently only half-answers it (usage logged, prompt text not).

## How it works

### Move 1 — the file-per-prompt pattern

You know how each React component lives in its own `.tsx` file, gets a PR review when it changes, gets blamed when someone breaks it? That same discipline, applied to LLM prompts. The system prompt for the monitoring agent is a file. The system prompt for the diagnostic agent is a different file. Both are committed; both are diff-able; both have a git history.

```
  Pattern — file per prompt, slots for the per-call bits

  ┌─ template file ───────────────────────────────────────┐
  │  monitoring.md                                         │
  │  ┌────────────────────────────────────────────┐       │
  │  │ You are the monitoring agent...             │       │
  │  │ ## Role                                     │       │
  │  │ ## Hard rules                               │       │
  │  │   {project_id}        ← slot                │       │
  │  │ {categories}          ← slot                │       │
  │  │ ## Output                                   │       │
  │  │ ...                                         │       │
  │  │ {schema}              ← slot                │       │
  │  └────────────────────────────────────────────┘       │
  └────────────────────────┬──────────────────────────────┘
                           │  readFileSync at module load
  ┌─ in-memory string ────▼──────────────────────────────┐
  │   const PROMPT = readFileSync(.../monitoring.md)      │
  │   then per call:                                      │
  │     system = PROMPT.replace(...).replace(...).replace │
  └───────────────────────────────────────────────────────┘
```

### Move 2 — file-per-agent, one job per file

There are four prompt files, one per agent. Each one is the entire system prompt for that agent — header, rules, common errors, output schema, slots. No file shares content with another. When the monitoring rules change, you diff one file. When the diagnostic output schema changes, you diff one file. The blast radius is one agent.

```
  lib/agents/legacy-prompts/ — four files, one per agent
  ┌───────────────────────────────────────────────────────┐
  │  monitoring.md   ─►  monitoring-legacy.ts:13           │
  │  diagnostic.md   ─►  diagnostic-legacy.ts (similar)    │
  │  recommendation.md ─► recommendation-legacy.ts         │
  │  query.md        ─►  query-legacy.ts                   │
  └───────────────────────────────────────────────────────┘
```

This wins over the alternative — *one big prompts.ts with all four as template literals* — for three reasons. **Diff hygiene**: a change to monitoring shows as a 5-line diff to monitoring.md, not a 5-line change buried in a 800-line .ts file. **Editor mode**: markdown editors fold sections, render the ```json examples, and don't reformat the prose; TypeScript editors lint the prose. **Review velocity**: a PM or analyst can read `monitoring.md` and propose changes; nobody non-technical reads template literals.

### Move 2 — readFileSync at module load, not at request

Look at line 13 of the legacy monitoring agent:

```
  // lib/agents/monitoring-legacy.ts:13
  const PROMPT = readFileSync(
    join(process.cwd(), 'lib/agents/legacy-prompts/monitoring.md'),
    'utf8'
  );
```

The file is read *once*, at module load, and held in memory as a constant. Subsequent calls don't touch the filesystem. This is the right tradeoff: prompt changes are deployment-time events, not runtime events. The cost of a prompt change is a server restart (or a Vercel redeploy), the same as any code change. No surprise hot-reload of prompts mid-session.

The active path (`lib/agents/monitoring.ts`) doesn't `readFileSync` directly because the prompt template now ships inside the `@aptkit/core` package — but the *pattern* is identical: a frozen string, baked in at build/load time, slot-interpolated per call. The discipline survives the refactor; only the location of the file changes.

### Move 2 — the prompt + model version pair

Here's the part most teams learn the hard way. A prompt that worked on `claude-sonnet-4-5` may behave differently on `claude-sonnet-4-6`. The pairing of (prompt, model) is the unit that has the behavior — not the prompt alone, not the model alone. Both are versioned; both have to be tracked together.

```
  // lib/agents/base.ts:7 — the model is a constant in code
  export const AGENT_MODEL = 'claude-sonnet-4-6';

  // lib/agents/intent.ts:16 — different agent, different model
  const CLASSIFIER_MODEL = 'claude-haiku-4-5-20251001';
```

Both model constants live in TypeScript files, get reviewed in PRs, and ship in the same commit as any prompt change that depends on them. When you upgrade Sonnet 4-6 → 4-7, the PR contains *both* the bumped constant *and* whatever prompt adjustments the new model needs. Splitting these across PRs is how you ship a regression — the prompt rev lands, the model rev lands a week later, the on-call engineer can't tell which one caused the alert.

The honest gap: there's no automated link between the prompt file's git commit and the model version in code. They're both in git, but a regression triage means manually correlating "monitoring started returning empty arrays on date X" with "what commits to monitoring.md or base.ts landed before date X." That works at this scale. At higher scale (thousands of prompts, multiple models in rotation), you'd want a versioned-pair scheme — `monitoring@v3 + sonnet-4-6` as a deployment unit.

### Move 2 — the prompt observability gap

Read the log line at `lib/agents/base-legacy.ts:135`:

```
  // lib/agents/base-legacy.ts:135
  console.log(JSON.stringify({
    site: 'agents/base:runAgentLoop',
    sessionId,
    usage: res.usage  // ← input_tokens, output_tokens
  }));
```

And the active-path equivalent at `lib/agents/aptkit-adapters.ts:57-61`:

```
  // lib/agents/aptkit-adapters.ts:57-61
  console.log(JSON.stringify({
    site: this.logSite,
    sessionId: this.sessionId,
    usage: response.usage,
  }));
```

Both log token usage. Neither logs the prompt text, the slot values that were interpolated, or a hash of the assembled system message. That's the honest gap. If the monitoring agent regresses overnight, you can see *how many tokens* it spent and *which session* the call belonged to. You can't see *what prompt* it actually sent. To debug a "the model is behaving weirdly today" you'd need to:

1. Pull the session id from the log
2. Check the git log on `lib/agents/legacy-prompts/monitoring.md` since the last good day
3. Check the git log on `lib/agents/base.ts` for any `AGENT_MODEL` change
4. Reproduce the same `{schema}` + `{categories}` interpolation locally
5. Eyeball the assembled prompt

That works for now. What it would take to close the gap: log a hash of the interpolated system prompt per call (so two calls with identical prompts have the same hash, and a deploy that changed the prompt shows a new hash). Sample 1% of calls and log the full prompt text (so you can re-run the same prompt manually for debug). Tag the log with the git SHA of the current deployment (Vercel exposes this). All three are afternoon-sized changes; none of them are in place yet.

### Move 2 — diffs and pull requests on prompts

When you treat prompts as code, you get the whole engineering practice for free. A change to `monitoring.md` looks like this in a PR:

```
  diff --git a/lib/agents/legacy-prompts/monitoring.md ...
  @@ -22,3 +22,5 @@ Use **90-day windows**...
   - current = `... in last 90 days`
   - trailing = `... in last 180 days`
   - **prior 90-day value = trailing(180d) − current(90d)**
  +- **Ignore any change where the prior/baseline value is small
  +  (< ~500 events)** — tiny baselines produce meaningless swings.
```

A reviewer can read that and ask: "what's the threshold based on? did you test it against the demo snapshot? does this affect what `isAnomalyArray` accepts?" The conversation happens on the diff. The change ships when it's reviewed. The git history shows when and why this rule entered the codebase.

This is the part that's invisible until you've worked somewhere it *isn't* in place. Teams that inline prompts as template literals end up reviewing prompt changes the same way they review string-formatting changes — meaning they don't review them at all. The prompts drift; nobody knows when or why; debugging a regression means archaeology.

### Move 3 — the principle

Treating prompts as code is the move that lets every other prompt-engineering discipline scale: versioning, review, observability, eval-driven iteration, deployment safety. Prompts as code is the soil; everything else grows in it. Prompts inlined as template literals is the soil that grows weeds.

## Primary diagram

```
  Prompts as code — file → memory → call, with observability gaps marked

  ┌─ git (commit time) ────────────────────────────────────────┐
  │  lib/agents/legacy-prompts/monitoring.md   (commit abc123) │
  │  lib/agents/base.ts:7  AGENT_MODEL = 'claude-sonnet-4-6'   │
  │  → both diff-able, both reviewed, both blamed              │
  └───────────────────────────┬────────────────────────────────┘
                              │  npm run build · vercel deploy
  ┌─ process boot (load time) ▼─────────────────────────────────┐
  │  readFileSync(.../monitoring.md) → const PROMPT             │
  │  read ONCE, held until process exit                          │
  │  → server restart = prompt reload                            │
  └───────────────────────────┬─────────────────────────────────┘
                              │  per call
  ┌─ interpolation (request time) ▼─────────────────────────────┐
  │  PROMPT.replace('{schema}', ...)                             │
  │        .replace(/\{project_id\}/g, ...)                      │
  │        .replace('{categories}', ...)                         │
  └───────────────────────────┬─────────────────────────────────┘
                              │  Anthropic.messages.create
  ┌─ model call (call time) ───▼─────────────────────────────────┐
  │  LOGGED: { site, sessionId, usage }                          │
  │  NOT LOGGED: prompt text · slot values · prompt hash         │
  │                                            ← observability gap│
  └──────────────────────────────────────────────────────────────┘
```

## Elaborate

The file-per-prompt discipline shows up in every team that's shipped LLM features at scale. The aipe project the reader maintains is *itself* an instance of this pattern — markdown templates with frontmatter, slash commands that compose them, versioned in git. blooming inherits the same shape: prompts are files, slots are the variable surface, the rest of the system reads them as code.

The "prompt + model version" pair is the part that catches teams off-guard the first time it happens. A model upgrade is invisible — the API endpoint name stays the same, the SDK version is the same, the prompt is the same, but the model behind the wire changed. Output that was 4/5 on your eval rubric is suddenly 3/5. Anthropic's policy of naming model versions (`claude-sonnet-4-6` not just `claude-sonnet`) is the right move here; pin the version in code, commit the change as a PR, run the eval before the PR merges. The blooming codebase pins both Sonnet and Haiku versions in TypeScript constants for exactly this reason.

What's not yet in place is the *automated* link between prompt change, model change, and behavior change. The eval/ folder was retired (PR #8); the only test of "is the model output good" is now the type guards, which test shape not behavior. Concept #5 covers what an eval-driven loop on this codebase would look like.

Hamel Husain's writing on this (it shows up everywhere — his blog, his talks, the Latent Space episode on evals) has a recurring point: *the production system is the eval set you didn't ask for*. Every captured raw output in your log is a row in your eval set. Every user-reported "the model said something weird" is a regression test you should be running. blooming doesn't yet log raw outputs (only token usage); the demo snapshots in `lib/state/demo-*.json` are the closest thing — they're committed captures of real briefings the team can replay. That's a start; it's not a full eval substrate.

## Interview defense

**Q: Why not just inline the prompts as template literals in TypeScript?**

A: Three reasons that show up in production. **Diff hygiene** — a 5-line edit to a prompt should look like a 5-line diff, not a 5-line change inside a 600-line TypeScript file where the editor wraps lines and adds noise. **Reviewer access** — a PM or content lead can read `monitoring.md` and propose edits; nobody non-engineering reads template literals. **Editor support** — markdown editors fold sections, render the JSON examples, don't auto-reformat the prose; TypeScript editors lint the prose and fight you on quote escaping. The cost of file-based prompts is one `readFileSync` at module load; the benefit is the whole engineering practice (review, blame, diff, revert) applies. The cost is trivial; the benefit compounds.

```
  what I'd sketch:

  TS literal:    .ts file changes →  whole file rendered as code
                                     prose review = bad UX
  .md file:      .md file changes →  rendered as markdown
                                     prose review = good UX
                                     same git, same PR flow
```

**Q: How do you tell which prompt produced which output in production?**

A: Today, you correlate three things: the log line's `sessionId` (which session a call belonged to), the git history of the prompt file since the last known-good period, and the git history of the model constant in `base.ts`. That's an honest correlation but it requires triage time. What I'd add to close the gap: log a hash of the assembled system prompt per call (deploys with no prompt change have a stable hash; deploys with a change show a new hash, and you can spot the boundary in the logs). Sample 1% of calls and log the full assembled prompt text (so you can replay it manually for debug). Tag the log with the deployment SHA (Vercel exposes `VERCEL_GIT_COMMIT_SHA`). Those three together turn "what prompt did this output come from?" from archaeology to a log query.

```
  observability fields, what's there vs what's missing:

  there:    site · sessionId · usage{input, output tokens}
  missing:  prompt_hash · deployment_sha · sampled_prompt_text
```

## See also

- [01-anatomy.md](./01-anatomy.md) — the four sections that the .md template encodes
- [04-token-budgeting.md](./04-token-budgeting.md) — `schemaSummary` is the interpolation that keeps the slotted prompt within budget
- [05-eval-driven-iteration.md](./05-eval-driven-iteration.md) — what runs *against* the prompts when they change
- [11-meta-prompting.md](./11-meta-prompting.md) — the `{categories}` slot is itself meta-prompted at runtime
