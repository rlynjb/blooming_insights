# 11 — Meta-prompting

*LLM-authored prompts · Industry standard · Anchor: aipe (your meta-tooling project)*

## Zoom out, then zoom in

Meta-prompting is using an LLM to write or improve prompts for other LLM calls. It doesn't live in `blooming_insights` itself — it lives in *aipe*, your meta-tooling project. The two systems exemplify the two sides of meta-prompting: the *consumer* (blooming) and the *generator* (aipe).

```
  Meta-prompting — where the prompt generator and consumer sit

  ┌─ aipe (the meta-tooling) ─────────────────────────────────────┐
  │  slash commands map to prompt templates                         │
  │  /aipe:study-prompt-engineering → reads spec/format/me .md      │
  │  → spawns Claude Code agent with assembled prompt                │
  │  ★ THE GENERATOR ★ — LLM authoring prompts                      │ ← we are here
  └──────────────────────┬────────────────────────────────────────┘
                         │ produces .md files in
                         │ .aipe/study-prompt-engineering/
                         ▼
  ┌─ output: 14 study .md files ──────────────────────────────────┐
  │  this very file, plus 13 sibling concept files                  │
  │  human-reviewed, committed to git                                │
  └────────────────────────────────────────────────────────────────┘

  ┌─ blooming_insights (the consumer) ────────────────────────────┐
  │  lib/agents/legacy-prompts/{monitoring,diagnostic,...}.md        │
  │  prompts authored by HUMANS, version-controlled (concept 03)    │
  │  → loaded by readFileSync, sent to claude-sonnet-4-6             │
  │  ★ THE CONSUMER ★ — running prompts in production                │
  └────────────────────────────────────────────────────────────────┘
```

aipe is your shipped example of a meta-prompting system. blooming_insights is a consumer of human-authored prompts. The relationship is real: this very file exists because aipe used an LLM to generate it from a spec, and a human (you) reviewed it before commit. That's the meta-prompting workflow in its actually-useful form.

## Structure pass

**Layers.** Outer: the meta-system that produces prompts. Middle: the workflow (spec → LLM-draft → human-review → committed prompt). Innermost: the produced prompt running in some other system.

**Axis — what's the role of the human at each layer?** Walk it down:

```
  one axis — "what's the human's role at this layer?" — three layers, three roles

  ┌─ meta-system (aipe) ───────────────────┐
  │  human: WRITES THE SPEC                  │  high-leverage: spec drives N prompts
  │  (study-prompt-engineering.md)           │
  └─────────────────────────────────────────┘
       ┌─ workflow ─────────────────────────┐
       │  human: REVIEWS THE DRAFT          │  the load-bearing pass —
       │  rejects what reads like LLM output │  without it, prompts drift
       └─────────────────────────────────────┘
            ┌─ produced prompt ──────────────┐
            │  human: COMMITS THE RESULT     │  the prompt enters the
            │  to git (concept 03)            │  codebase as ordinary source
            └─────────────────────────────────┘
```

**Seams.** The biggest seam is the *human review pass*. Without it, meta-prompting produces prompts that read like LLM output — verbose, polite, full of hedging. With it, you get prompts that read like engineering specs. The review is what turns "LLM drafted this" from a liability into a productivity multiplier.

## How it works

### Move 1 — the mental model

You know how a code generator (Rails scaffold, OpenAPI codegen, Prisma migrate) writes the boilerplate so you can focus on the parts that matter — and then you *read what it wrote* and reject any garbage? Meta-prompting is the same shape, with one twist: the generator and the reviewer are both you, but the generator is the model.

```
  Pattern — meta-prompting workflow, the kernel

  ┌─ human writes spec ───┐
  │  "I want a guide on    │  high-level intent, constraints,
  │   prompt engineering,  │  examples of what good output looks like
  │   13 concepts, this    │
  │   format..."           │
  └──────────┬────────────┘
             │
             ▼
  ┌─ LLM drafts the prompt(s) ─┐
  │  reads spec + format rules  │  produces N candidate prompts
  │  → emits 13 .md files       │  in the specified shape
  └──────────┬─────────────────┘
             │
             ▼
  ┌─ human reviews ────────────┐
  │  ★ THE LOAD-BEARING STEP ★  │  rejects hedging, marketing
  │  edit, reject, accept       │  language, drift from the intent
  └──────────┬─────────────────┘
             │
             ▼
  ┌─ commit to git ────────────┐
  │  the prompt enters the     │  now treated as ordinary source
  │  codebase as ordinary       │  (concept 03 applies)
  │  source                     │
  └────────────────────────────┘
```

The kernel: a spec drives the meta-system, the meta-system drafts the prompts, the human reviews, the reviewed prompts ship. Skip the human review and you've automated the production of mediocre prompts.

### Move 2 — the walkthrough

**Step 1 — when meta-prompting saves time.** Two situations where it earns its place:

  → **Initial drafting of complex prompts.** A first draft of `legacy-prompts/diagnostic.md` would take a human ~2 hours from scratch — naming the 4-step approach, listing tool reminders, naming common errors, structuring the JSON output spec. An LLM can draft a good first pass in 60 seconds. The human then spends 30 minutes editing — total 30 minutes vs 2 hours.
  → **Producing N parallel prompts in a consistent shape.** This is exactly what aipe does. The /aipe:study orchestrator spawns 15 sister agents in parallel, each producing one study guide in the same format. A human writing those 15 guides by hand would take weeks. The LLM produces drafts in minutes; the human reviews each one. The *consistency* of the output is the meta-prompting payoff — every guide follows `format.md` because the model was given `format.md`.

**Step 2 — when meta-prompting doesn't save time.** Two situations:

  → **Small tweaks.** "Change rule 3 to allow 8 tool calls instead of 6" is a one-line edit. Round-tripping through an LLM adds latency without benefit.
  → **Prompts under high iteration pressure.** When you're tuning a prompt against an eval set and changing it 20 times per day, each LLM-drafted iteration adds 30 seconds of generation + 5 minutes of review for what could be a 10-second human edit. Meta-prompting is for *first drafts*, not for iteration loops.

**Step 3 — aipe as the running example.** Look at this very session. The aipe spec for this generator (`study-prompt-engineering.md`) is ~770 lines. It defines:

  → A persona (the working AI engineer voice this file is written in).
  → 13 concepts to cover.
  → The output folder name.
  → The reader profile (via `me.md`).
  → The format rules (via `format.md`).

The aipe orchestrator (`/aipe:study`) spawns 15 sister agents in parallel — one per study generator. Each agent reads the relevant spec + format + me, then drafts the output files. The output files (this one and its 13 siblings) are LLM-drafted, human-reviewed, then committed to `.aipe/study-prompt-engineering/`.

The shape:

```
  Pattern — aipe's meta-prompting shape, applied to this session

  ┌─ spec: study-prompt-engineering.md (~770 lines, human-authored) ──┐
  │  persona · concept list · output folder · reader profile           │
  └────────────────────────┬───────────────────────────────────────────┘
                           │
                           ▼
  ┌─ orchestrator: /aipe:study ──────────────────────────────────────┐
  │  spawns 16 sister agents (15 study + 1 audit)                     │
  │  each gets:                                                        │
  │    - the topic spec                                                │
  │    - format.md (shared structure)                                  │
  │    - me.md (shared reader profile)                                 │
  │    - the codebase to anchor to                                     │
  └────────────────────────┬───────────────────────────────────────────┘
                           │
                           ▼
  ┌─ sister agent (this session) ─────────────────────────────────────┐
  │  reads spec + format + me + codebase                               │
  │  drafts 14 .md files                                                │
  │  → .aipe/study-prompt-engineering/{00-overview, 01-anatomy, ...}.md │
  └────────────────────────┬───────────────────────────────────────────┘
                           │
                           ▼
  ┌─ human review (next step) ────────────────────────────────────────┐
  │  THE LOAD-BEARING STEP — without it, output reads like LLM output  │
  │  reviewer edits voice, rejects hedging, verifies factual claims    │
  └────────────────────────────────────────────────────────────────────┘
```

**Step 4 — the risk: prompts that read like LLM output.** This is the failure mode every meta-prompting system hits. LLMs tend to:

  → **Pad with throat-clearing.** "Let's explore the fascinating world of structured outputs..."
  → **Add unnecessary preambles.** "Before we dive in, let me set the stage..."
  → **Hedge.** "This *might* be useful in *some* situations *potentially*..."
  → **Reach for marketing language.** "robust solution," "scalable architecture," "best practices."

A prompt with any of these reads like marketing copy, not like engineering spec. The model that *runs* against that prompt then *copies the style* — the rationale field gets verbose, the JSON output gets prefaced with "Sure, here's your analysis:", the trace gets longer.

The defense is in the *spec*. Look at `format.md`'s hard rules:

```
  Hard rules from format.md that defend against drift

  → No definition-first openings. Start with shape/scenario, end with term.
  → Direct, opinionated. No hedging language.
  → Marketing language banned.
  → Bridge from what the reader knows in every Move 2 sub-section.
  → No on-ramps. Skip the slow setup.
```

The spec tells the meta-system to NOT produce the failure mode. The human review catches what slips through. The two together produce prompts that read like engineering, not like LLM output.

**Step 5 — aipe's specific encoding.** aipe uses markdown templates with frontmatter — slash commands map to template files, the template body becomes the prompt, the spec frontmatter declares dependencies (which other specs this one reads). The shape is intentional: prompts as ordinary `.md` source (concept 03), composed via the slash-command surface.

The link to blooming: aipe is the *meta-tool* that drafts study guides; blooming's `legacy-prompts/*.md` are *application prompts* that drive the agents. Both are markdown-first, both are version-controlled, both follow the same prompts-as-code discipline. The difference: aipe's prompts are *about prompts*; blooming's prompts are *about ecommerce analytics*.

### Move 3 — the principle

Meta-prompting is code generation with a probabilistic generator. The same review discipline that catches generated code regressions catches generated prompt regressions. The *spec* is the leverage — a high-quality spec produces N prompts of consistent quality; the human review is what keeps the bar at engineering level instead of LLM-output level. Without the review, you've automated the production of mediocre prompts; with it, you've multiplied your authoring throughput by an order of magnitude.

## Primary diagram — aipe's meta-prompting flow (this session, end to end)

```
  ┌─ THE SPEC (human-authored, version-controlled) ───────────────────┐
  │  ~/.claude/plugins/cache/.../specs/study-prompt-engineering.md     │
  │   - persona: working AI engineer                                    │
  │   - 13 concepts                                                     │
  │   - output folder                                                   │
  │   - reader profile reference                                        │
  │  ~/.claude/plugins/cache/.../specs/format.md (shared structure)    │
  │  ~/.claude/plugins/cache/.../specs/me.md (shared reader profile)    │
  └────────────────────────┬───────────────────────────────────────────┘
                           │
  ┌─ ORCHESTRATOR ▼ ────────────────────────────────────────────────────┐
  │  /aipe:study (or /aipe:study-prompt-engineering standalone)         │
  │  spawns sister agents in parallel                                    │
  └────────────────────────┬────────────────────────────────────────────┘
                           │
  ┌─ THIS SESSION ▼ ────────────────────────────────────────────────────┐
  │  Claude reads spec + format + me + codebase                          │
  │  drafts 14 .md files                                                  │
  │  → /Users/rein/Public/blooming_insights/.aipe/                       │
  │    study-prompt-engineering/{00-overview, 01-anatomy, ..., README}.md │
  └────────────────────────┬────────────────────────────────────────────┘
                           │
  ┌─ HUMAN REVIEW (you, after this session) ────────────────────────────┐
  │  read each file                                                       │
  │  reject hedging, marketing, slow on-ramps                             │
  │  verify against codebase (no false claims)                            │
  │  commit (concept 03 applies — now these are version-controlled)       │
  └─────────────────────────────────────────────────────────────────────┘
  ┌─ THE PRODUCED PROMPTS (no longer LLM-output; engineering source) ────┐
  │  committed to git                                                      │
  │  blameable, diffable, reviewable                                       │
  │  drive YOUR future study + interview prep                              │
  └─────────────────────────────────────────────────────────────────────┘
```

## Elaborate

The pattern has a few names in the literature — "prompt programming" (when the spec is treated as a program), "LLM-aided prompt engineering" (when the focus is on the workflow), "meta-prompting" (when the focus is on the LLM-writing-prompts-for-LLMs angle). They're the same thing.

The interesting variants:

- **Prompt rewriting against an eval set.** A more advanced shape — the LLM generates N variations of a prompt, all run against the eval set, the highest-scoring variation gets committed. Requires concept 05's eval substrate (which this codebase doesn't have). Heavy-handed for most cases but powerful when iterating against a stable benchmark.
- **APE (Automatic Prompt Engineer).** A research thread (Zhou et al., 2022) on fully-automated prompt generation. Interesting; rarely productionised because the human review is what makes the result usable, and APE assumes you can skip it.
- **Constitutional AI's self-improvement loop.** A different angle — using LLM-drafted critique to refine *the model's own behavior* via fine-tuning. Adjacent to meta-prompting; same shape (LLM critiquing/drafting prompts), different goal.

Where to read next: Anthropic's prompt-engineering docs reference using Claude to help write prompts for Claude — the most pragmatic take. Eugene Yan's writing on prompt-engineering workflows touches on this. Simon Willison has a running thread on his own usage of LLMs to draft `llm` CLI templates, which is meta-prompting in the wild.

In this codebase, concept 03 (prompts as code) is the *prerequisite* — the produced prompts only become trustworthy when they enter version control like any other source. Concept 05 (eval-driven iteration) is the *complement* — the eval set catches regressions in produced prompts the same way it catches regressions in human-authored ones.

## Interview defense

**Q: "Do you use LLMs to help write prompts?"**

Yes — that's exactly what aipe (my meta-tooling project) does. The slash commands map to prompt templates; the orchestrator spawns sister agents that each draft a study guide following the spec. *This* study guide on prompt engineering is itself an example — Claude drafted these 14 markdown files in one session from a spec I authored; I review each file, edit voice, reject hedging or marketing language, then commit. The pattern saves an order of magnitude of authoring time on first drafts.

```
  spec → LLM draft → HUMAN REVIEW → commit
                       ↑ load-bearing step
```

Anchor: *"first drafts, not iteration loops. The review pass is what turns LLM output into engineering source."*

**Q: "What's the failure mode?"**

Prompts that read like LLM output. *(Name the symptoms.)* Padding, throat-clearing, hedging, marketing language. If the meta-system produces a prompt full of "let's explore" and "this might be useful," the model running against that prompt copies the style — the rationale field gets verbose, the JSON output gets prefaced with chat-tone preamble, the trace gets longer. The defense is in the spec (banned-words lists in `format.md`) AND in the human review.

```
  symptoms in produced prompts:           defense:
  ────────────────────────────           ───────
  "Let's explore..."                      banned in format.md
  "It's important to note..."             banned in format.md
  "potentially might be useful"           hedging banned
  "scalable solution"                     marketing banned
                                          + human review pass
```

Anchor: *"the review is what turns it from automated mediocrity into a productivity multiplier."*

**Q: "When NOT to use it?"**

Two cases. Small tweaks — round-tripping through an LLM adds latency without benefit; faster to edit by hand. And tight iteration loops — when I'm tuning a prompt against an eval set and changing it 20 times per day, each LLM-drafted iteration costs 5 minutes of review for what could be a 10-second human edit. Meta-prompting is for *first drafts* and for *parallel production* (15 study guides at once), not for iterating on a single prompt.

Anchor: *"meta-prompting wins on first drafts and parallel production. Loses on small tweaks and tight iteration."*

## See also

- `03-prompts-as-code.md` — the prerequisite; produced prompts only become source when they enter version control with the same discipline as human-authored ones.
- `05-eval-driven-iteration.md` — the complement; the eval set catches regressions whether the prompt was hand-written or LLM-drafted.
- `08-few-shot.md` — meta-prompting often uses few-shot inside the spec (show the LLM what good output looks like, then ask it to produce more).
- `13-forbidden-patterns.md` — banning specific phrases in the spec is the meta-prompting application of concept 13.
