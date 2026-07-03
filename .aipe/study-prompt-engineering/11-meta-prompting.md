# 11 · Meta-prompting

**Industry name:** *meta-prompting* / *prompt-generating prompts* / *prompts-for-prompts* · Language-agnostic

## Zoom out — where meta-prompting sits

Meta-prompting is when you use an LLM to write or improve prompts that then drive other LLM calls. In this codebase, it doesn't appear on the *live* path — but it lives adjacent to the codebase in `aipe`, Rein's meta-tooling project that this repo's `.aipe/` folder is a client of.

```
  Zoom out — meta-prompting as an authoring layer

  ┌─ author (human) ───────────────────────────┐
  │  wants a rubric, a new prompt, a new spec   │
  └────────────────────┬────────────────────────┘
                       │  describes goal
                       ▼
  ┌─ meta-prompt ──────────────────────────────┐
  │  "given this codebase + this goal, draft    │
  │   a prompt that does X"                     │
  │  (this is the aipe spec pattern)            │
  └────────────────────┬────────────────────────┘
                       │  LLM drafts
                       ▼
  ┌─ draft prompt / rubric ────────────────────┐
  │  markdown file, ready for human review      │
  └────────────────────┬────────────────────────┘
                       │  human edits + commits
                       ▼
  ┌─ committed prompt (concept 03) ────────────┐
  │  lives in git, PR-reviewable                 │
  │  now drives real LLM calls                   │
  └────────────────────────────────────────────┘
```

## Zoom in — the two shapes of meta-prompting

Two related but distinct patterns:

1. **Authoring meta-prompting** — you use an LLM to *draft* a prompt or rubric. The output is a file. A human reviews it, edits it, commits it. This is a one-time cost per prompt.

2. **Runtime meta-prompting** — you use an LLM to *modify* the prompt for the next LLM call, in the same session. The output is a runtime string. This is a per-call cost.

The `aipe` project is #1 industrialized. Every spec file (like the one that generated this guide) is an authoring meta-prompt. This codebase doesn't use #2 on the live path — no runtime prompt-rewriting.

## Structure pass — layers, axis, seams

Trace one axis: *when in the lifecycle does prompt authoring happen*.

- **Layer 1 — design time (authoring meta-prompt).** Human describes intent to an LLM; LLM drafts a prompt file; human reviews and commits. Happens once per prompt. `aipe` specs are this layer.
- **Layer 2 — build time (compilation).** Not used here — some codebases template prompts from typed configs at build.
- **Layer 3 — runtime (per-call prompt selection).** This codebase does *use* runtime prompt selection — the intent classifier picks between three flows — but not runtime prompt *rewriting*.

**The seam:** between design-time authoring (human-in-the-loop) and runtime rewriting (no human). Authoring is safe — a human reviews the draft. Runtime is risky — the model's prompt is now emergent from another model's output, and you have no chance to sanity-check it before it runs.

## How it works

### Move 1 — the shape

You've done this before with code generation. Codegen tools — TypeScript from OpenAPI specs, GraphQL codegen, ORM migrations — are the same shape. Human writes the intent (the schema). Tool generates the boilerplate. Human commits the generated code. The generated code becomes part of the source tree; you don't regenerate it at runtime. Meta-prompting is codegen for prompts.

```
  Pattern — meta-prompting as prompt codegen

  intent          generator          artifact          consumer
  ┌─────────┐    ┌─────────┐        ┌──────────┐     ┌─────────┐
  │ spec of │ ─► │ LLM     │ ─drafts│ prompt.md│ ─►  │ agent   │
  │ what the│    │ drafts  │        │  (checked│     │ (uses at│
  │ prompt  │    │ prompt  │        │  in)     │     │ runtime)│
  │ should  │    └─────────┘        └──────────┘     └─────────┘
  │ do      │                            ▲
  └─────────┘                            │
                                    human reviews
                                    + edits + commits
```

The critical bit is the human review step in the middle. Without it, meta-prompting is a lottery — the LLM's draft may look plausible but bury a subtle bug, and you have no chance to catch it before it goes live. With it, the LLM is a fast drafter and the human is the final line of defense.

### Move 2 — walking the aipe pattern

#### The aipe spec model

`aipe` (Rein's meta-tooling project) works like this:

1. **A spec file** describes what a generator produces. Example: `study-prompt-engineering.md` (the spec that generated *this* guide) describes the persona, the concepts, the folder structure, and the calibration rules.

2. **A slash command** (`/aipe:study-prompt-engineering`) invokes the spec. The command is really a meta-prompt: "here's the spec; here's the codebase; go generate the study guide."

3. **The LLM drafts** the study guide — 13 concept files, a README, an overview. This is meta-prompting in action: an LLM is drafting content that will guide *my* study, informed by another LLM-authored input (the spec).

4. **The output lands as files** in `.aipe/study-prompt-engineering/`. A human (Rein) reads them. If a concept file is wrong, the human edits it or re-runs the command with a different context.

The spec plays the role of the "codegen schema." The generated study guide plays the role of "generated code." Both are meta-prompting artifacts.

Where meta-prompting *would* show up on this codebase's live path if we wanted it:

- **The categories list.** `lib/agents/categories.ts` defines the anomaly categories the monitor agent checks against. Each category has a `whyItMatters` and a `queryRecipe`. These could be drafted by an LLM given a workspace schema, human-reviewed, then committed. This is the classic "use AI to write the seed data" pattern.

- **The `known_correct_shape` field per golden case.** In `eval/goldens/types.ts`, each golden has a `knownCorrect` object — human-authored notes on what a correct diagnosis for this case would look like. Drafting these with an LLM (given the golden's anomaly + a description of the correct handling) would speed up adding new goldens.

- **The rubrics.** `eval/rubrics/diagnosis-quality.ts` is 108 lines of dimensions × scale-descriptions. An LLM given a description of "what makes a good diagnosis" could draft the same rubric. In fact, that's likely how it was authored initially, with heavy human editing after.

None of these show up as runtime meta-prompting. They're all authoring meta-prompting — LLM drafts, human commits.

#### Runtime meta-prompting — why not here

The pattern this codebase deliberately avoids:

```
   step 1  ask model to draft a system prompt for step 2
   step 2  run the drafted prompt on the actual task
```

Two problems:

1. **The step-1 prompt is now unbounded.** The model may draft a prompt that reveals information you didn't want revealed, contradicts a hard rule, or crashes the parser downstream. There's no human review layer.

2. **Debuggability collapses.** When step 2 does something weird, you have to reverse-engineer step 1's output to understand what happened. Every debug session is now two-hop.

Where it *would* land: if we were building an agent that adapts its instructions per-user (a chat companion, a coach). Then the "step 1 drafts a prompt for step 2" pattern is unavoidable. In that case, the discipline is: constrain step 1's output shape hard (schema-enforced), log every drafted prompt, retain the ability to freeze the prompt and inspect it. This codebase doesn't have that use case.

```
  Comparison — authoring vs runtime meta-prompting

  ┌─ authoring (safe) ───────────────────────────────┐
  │  human describes intent                           │
  │       ↓                                            │
  │  LLM drafts prompt                                 │
  │       ↓                                            │
  │  human reviews + edits + commits                   │
  │       ↓                                            │
  │  prompt goes live via version-controlled file      │
  └────────────────────────────────────────────────────┘

  ┌─ runtime (risky) ────────────────────────────────┐
  │  agent state at time T                            │
  │       ↓                                            │
  │  LLM #1 drafts a prompt for LLM #2                 │
  │       ↓                                            │
  │  LLM #2 runs the drafted prompt on the task        │
  │       ↓                                            │
  │  output goes to user — no human review of prompt   │
  └────────────────────────────────────────────────────┘

  authoring: costs zero at runtime, one review at design.
  runtime:   costs one extra call per turn, no review.
```

#### When authoring meta-prompting pays

Three cases where drafting via LLM speeds you up:

- **Initial drafting of complex prompts.** A new agent role, a new rubric, a complex output schema. Zero-to-first-draft is where LLMs shine. Human editing after is fast.

- **Prompt migration across models.** When Sonnet 4.6 replaces Sonnet 4, a prompt that worked before may need tuning. Drafting the tuned version with an LLM (given the old prompt + the failure symptoms + the model's known behavior changes) is faster than re-authoring from scratch.

- **Rubric extension.** Adding a new dimension to a rubric. Given the existing 4 dimensions + a description of the new one, the LLM drafts the scale descriptions in the same voice as the existing ones.

Three cases where it *doesn't*:

- **Small tweaks.** Fixing a typo, tightening one rule. Human editing is faster than round-tripping through an LLM.

- **Prompts under high iteration pressure.** When you're eval-driving a prompt and changing 5 things per hour, the LLM's turnaround is a bottleneck.

- **Prompts that read like LLM output.** LLM-drafted prompts often have a specific voice — verbose, hedge-y, over-structured. If you don't edit heavily, your production prompts start sounding generic, which the model then imitates in its outputs. The compounding drift is real.

### Move 2 variant — the load-bearing skeleton

Kernel of "meta-prompting done right":

1. **Human-in-the-loop review.** Drop this and generated prompts go live untested.
2. **Draft outputs are files, not runtime strings.** Drop this and you lose diff-ability + PR review.
3. **The drafting prompt is itself version-controlled.** Drop this and meta-prompt drift is invisible.
4. **The drafted output is spec-conformant.** Drop this and the human has to review structure, not just content.

Hardening on top: iterative drafting (LLM drafts, human edits, LLM re-drafts based on edits), automated conformance checks (does the drafted rubric have exactly 4 dimensions?), voice guides for the LLM to imitate a specific writing style. None of that is the skeleton.

### Move 3 — the principle

**Use meta-prompting to save the first hour of drafting, not to replace the review.** The LLM is a good drafter, not a good editor. Its drafts land at 70% quality — the last 30% is human. Skipping the human step is where meta-prompting reputationally fails — someone ships an LLM-drafted prompt, it works fine in demos, breaks in production, and the whole discipline gets a bad name. It's not the drafting that's wrong; it's the missing review.

## Primary diagram

```
  Meta-prompting — the full recap

  ┌─ authoring (safe pattern, used in aipe) ────────────────────┐
  │                                                              │
  │  human intent                                                │
  │      ↓                                                        │
  │  spec.md  (also LLM-drafted, iteratively refined)             │
  │      ↓                                                        │
  │  slash command invokes generator                              │
  │      ↓                                                        │
  │  LLM drafts N files                                           │
  │      ↓                                                        │
  │  human reviews + edits                                        │
  │      ↓                                                        │
  │  files committed  ──►  now source-of-truth                    │
  │                                                               │
  │  in this codebase:  none directly (aipe is the substrate)     │
  │  in aipe:           every spec generates its target folder    │
  │                                                               │
  └───────────────────────────────────────────────────────────────┘

  ┌─ runtime (NOT used here) ───────────────────────────────────┐
  │                                                              │
  │  agent state                                                 │
  │      ↓                                                        │
  │  LLM #1 drafts prompt for LLM #2                              │
  │      ↓                                                        │
  │  LLM #2 runs                                                  │
  │      ↓                                                        │
  │  no human in the loop                                         │
  │                                                               │
  │  when appropriate: adaptive agents, per-user prompts.         │
  │  when NOT appropriate: everywhere else.                       │
  │                                                               │
  └───────────────────────────────────────────────────────────────┘
```

## Elaborate

The related concept from `aipe`'s design: *markdown-as-source-of-truth*. Prompts, specs, and generated study guides all live as markdown files in git. Because they're markdown, they're diffable, PR-reviewable, human-editable. Because they're in git, they have version history. Because they're generated by a spec + slash command + LLM, they're fast to draft. That's the meta-prompting discipline productized — the generator is heavy machinery; the artifact is a file.

The failure mode I've hit in production with runtime meta-prompting: an agent that constructs its own system prompt per user based on the user's stated preferences ("I want an assistant that's terse and formal"). The first-turn user says "I want you to be helpful but a little playful." The model constructs a system prompt containing the word "playful." Two turns later, the model is emitting emoji, using slang, and dropping the JSON output shape "because playful and JSON don't mix." Everything downstream breaks. The fix was: constrain the meta-prompt to only vary the *tone-adjective* field of a fixed template, not the whole prompt. Runtime meta-prompting is safe when the surface area is small; it's unsafe when the whole prompt is up for grabs.

The reference: Anthropic's own meta-prompter (in the Claude console) drafts system prompts given a task description. Worth trying — you'll see the drafting quality landing around 70%, and you'll feel the pull to just ship the draft. Don't. Edit it. The Anthropic prompt engineering guide is explicit that the console's meta-prompter is a starting point, not a finished artifact.

The interaction with concept 03 (prompts as code): meta-prompting *only works cleanly* when the artifact is a file. If your prompts are runtime strings assembled from templates + config, meta-prompting bolts on awkwardly — where does the drafted prompt land? A JSON config? A code constant? The friction is high. With markdown-as-source-of-truth (aipe's pattern, this repo's `legacy-prompts/`), meta-prompting fits naturally — the draft is a new .md file, ready for review.

## Interview defense

**Q: Where does meta-prompting fit in a production LLM system?**

Almost always at authoring time, not runtime. Use an LLM to *draft* a prompt, rubric, or spec. Human reviews. Human edits. Human commits. The drafted artifact goes into version control and drives real LLM calls the same way any other prompt would. In this codebase's ecosystem, that's the `aipe` pattern — every generator spec produces a markdown folder. Runtime meta-prompting (letting an LLM rewrite another LLM's prompt at request time) is what I avoid — the debug story collapses, and there's no human review layer between the drafting step and the going-live step.

```
  design time     LLM drafts → human reviews → git commit → live
  runtime         LLM drafts → LLM runs → user   [no review layer]
```

Anchor: `aipe` project ecosystem (the meta-tool that generated the folder you're reading now).

**Q: What's the specific runtime meta-prompting failure you've seen?**

The tone-drift failure. An agent that adapts its system prompt to user-stated preferences. First turn, user says "be playful." Model constructs a system prompt containing "playful." Two turns later, the model is dropping the required JSON output shape because "playful and JSON don't mix." Downstream parsers break. The pattern of failure: whenever a runtime-generated prompt is not schema-constrained, the model's next output is unbounded. The fix I shipped was to constrain the runtime-meta-prompt to only vary a specific tone-adjective field of a fixed template — the surface area for drift shrunk from "the whole system prompt" to "one adjective."

```
  before:  runtime prompt = anything the model drafts
  after:   runtime prompt = fixed template + { toneAdjective: "playful" }
```

## See also

- 03 · prompts as code — meta-prompting only fits when the artifact is a file.
- 05 · eval-driven iteration — LLM-drafted rubrics are still measured by eval outcomes.
- 06 · single-purpose chains — the drafting chain is one job; the target agent is another.
- 12 · prompt injection defense — runtime meta-prompting expands the injection surface.
