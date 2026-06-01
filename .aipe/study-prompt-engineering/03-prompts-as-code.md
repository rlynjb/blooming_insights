# Prompts as code (versioning, review, and the observability gap)

**Industry name(s):** prompts-as-code, prompt versioning, prompt source control, prompt observability
**Type:** Industry standard · Language-agnostic

> blooming insights treats prompts as source — four `.md` files loaded with `readFileSync`, version-controlled, git-diffable, reviewed in PRs like any other code. What it does *not* yet do is pair a prompt version with the model that ran it (model IDs live in `base.ts` L9 and `intent.ts` L14, separate from the prompts) or log which prompt version produced which output — so the "worked on Sonnet, breaks on the next Sonnet" failure can't be traced.


---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Prompts-as-code spans more bands than any other concept in this guide. The `.md` files sit in the Repo (under source control, reviewed in PRs), the `readFileSync` load happens at the Per-agent definitions band (each agent's module import), the model ID lives separately at the Provider/agent-loop boundary, and the persisted outputs land in the cross-cutting telemetry surface where `saveInvestigation` writes records. The concept's authoring half is everywhere on the left; its observability half — pairing prompt with model and logging the pair against output — is everywhere absent on the right.

```
  Zoom out — where prompts-as-code lives

  ┌─ Repo ──────────────────────────────────────────┐  ← we are here
  │  ★ lib/agents/prompts/*.md (git-versioned) ★    │
  │  git log · PR diff · review                     │
  └─────────────────────────┬────────────────────────┘
                            │  readFileSync at import
  ┌─ Per-agent definitions ─▼────────────────────────┐  ← we are here
  │  ★ PROMPT const  monitoring.ts L13 etc. ★        │
  │  runtime-immutable (no live edit)                │
  └─────────────────────────┬────────────────────────┘
                            │  runs on
  ┌─ Provider / agent loop ─▼────────────────────────┐
  │  AGENT_MODEL = 'claude-sonnet-4-6'  base.ts L9   │
  │  (decoupled from the prompt — never paired)       │
  └─────────────────────────┬────────────────────────┘
                            ┊  no co-logging
  ┌ ─ Telemetry (gap) ─ ─ ─▼─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─┐
   saveInvestigation  route.ts L254 persists OUTPUTS
   MISSING: prompt sha + model id per output
  └ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┘
```

**Zoom in — narrow to the concept.** The question this file answers: are the prompts treated as code, and if so, how completely — what's version-controlled, what's reviewed, and what's *not* yet tracked? blooming insights nails the authoring half (file + git + PR + import-time read) and skips the observability half (prompt SHA + model ID logged per output). Below, you'll see why a one-line bump to `AGENT_MODEL` is the diff that silently regresses every prompt tuned to the old model, and why "prompts as code" needs the pairing and the per-output log to be real.

---

## Structure pass

**Layers.** Prompts-as-code is best understood as a four-layer timeline, not a single artifact. Layer A is *authoring-time* — the `.md` file in the repo, the git history, the PR diff, the reviewer's comments. Layer B is *deploy/import-time* — `readFileSync` baking the prompt into the running process, making the deployed bytes equal to the committed bytes. Layer C is *request-time* — the model executes against that prompt on a specific `AGENT_MODEL` constant that lives in a *different* file from the prompt. Layer D is *post-hoc / observability-time* — the persisted record of what happened, which today is `saveInvestigation` writing outputs only, with no prompt-SHA or model-ID stamped on them.

**Axis: lifecycle.** When does each piece exist, when is it pinned, when is it unrecoverable? This is the right axis because the gap this file is honest about — "we can review a prompt but can't trace a regression to one" — is a *temporal* gap. It's not about who controls (clearly the author, then code), and not about state (the prompt is immutable at runtime). It's about which layer captures which fact, and the fact missing at Layer D (which prompt SHA produced which output, on which model) is the one a future incident response will need *after* the prompts and model have already moved on.

**Seams.** Three seams; the third is the load-bearing one. Seam 1 (A↔B) — lifecycle flips from *editable* to *runtime-immutable*; the import-time read is the gate, and the win is that deployed == committed. Seam 2 (B↔C) — the prompt and the model meet at request-time but were *paired by nobody*; the model ID is in `base.ts`, the prompt is in `prompts/monitoring.md`, and their pairing exists only in someone's memory. Seam 3 (C↔D) is the load-bearing one — lifecycle flips from *happening-now* to *recoverable-later*, and right now the boundary leaks: outputs persist, prompt-SHA and model-ID don't. The "worked on Sonnet, breaks on the next Sonnet" failure lives in this leak — by the time the regression is noticed, you can't recover which prompt-version × model-version pair produced the bad diagnosis from last week.

```
  Structure pass — prompts as code

  ┌─ 1. LAYERS ───────────────────────────────────┐
  │  A: authoring-time (.md, git, PR)              │
  │  B: import-time (readFileSync → in-process)    │
  │  C: request-time (prompt + AGENT_MODEL meet)   │
  │  D: post-hoc (persisted record / trace)        │
  └────────────────────────┬───────────────────────┘
                           │  pick the axis
  ┌─ 2. AXIS ─────────────▼────────────────────────┐
  │  lifecycle: when does each fact exist and      │
  │  when is it pinned for the next reader?         │
  └────────────────────────┬───────────────────────┘
                           │  trace A→D, find flips
  ┌─ 3. SEAMS ────────────▼────────────────────────┐
  │  S1 (A↔B): editable → runtime-immutable        │
  │  S2 (B↔C): prompt & model paired by nobody     │
  │  S3 (C↔D): happening-now → recoverable-later   │
  │            (LOAD-BEARING — and currently leaks) │
  └────────────────────────┬───────────────────────┘
                           ▼
                   Block 4 — How it works
```

```
  A seam — "can a future reader recover what ran?" answered two ways

  ┌─ Layer C ────────┐    seam     ┌─ Layer D ────────────┐
  │  prompt + model  │ ═════╪═════► │  saved: outputs only │
  │  in memory, in   │  (it flips) │  MISSING: prompt sha │
  │  flight          │             │  + model id per output│
  └──────────────────┘             └──────────────────────┘
         ▲                                   ▲
         └────── same axis, two answers ─────┘
                 → this boundary loses the pair → un-bisectable regression
```

The skeleton is mapped — the rest of this file walks the mechanics that hang off it.

## How it works

**Mental model.** A prompt-as-code system has four properties: the prompt is a *file* (not a DB row or dashboard field), it is *loaded as source* by the program, it is *versioned* in the same repo as the code, and its version is *paired and logged* with the model and output for observability. blooming insights has the first three solidly and the fourth not at all. Picture two halves: the authoring half (file + load + version + review) is complete; the observability half (pair + log) is empty.

```
AUTHORING HALF  (have it)              OBSERVABILITY HALF  (don't)
─────────────────────────────         ─────────────────────────────
file:    a versioned markdown file     pair:  prompt@sha + model id
load:    sync read at import           log:   which prompt → which output
version: git history                   trace: bisect a regression to a line
review:  PR diff                       alert: failure rate per prompt version
```

The left column is what makes a prompt a maintainable artifact. The right column is what makes a regression *findable*. The codebase has the left, lacks the right.

---

### The prompt is a file, loaded as source

Each agent reads its prompt off disk at module load — once, synchronously, as the module is imported:

```
  PROMPT = read_file_sync(prompts_dir + "/monitoring.md")
  PROMPT = read_file_sync(prompts_dir + "/diagnostic.md")
  PROMPT = read_file_sync(prompts_dir + "/recommendation.md")
  PROMPT = read_file_sync(prompts_dir + "/query.md")
```

The markdown files are not strings hidden in a code literal and they are not rows in a database — they are first-class files in the prompts directory. That placement is the whole move: a prompt under the source tree is reviewed, diffed, and shipped exactly like the code next to it. A teammate changing the monitoring prompt's "90-day window" method shows up in the PR as a content diff a reviewer reads line by line.

```
edit prompt → git diff → PR review → merge → ships with the build
   (same lifecycle as any other source file)
```

Because the read runs at import, the prompt is also baked into the running process — there is no live-edit path, no dashboard override, no way for the deployed prompt to differ from the committed one. That immutability-at-runtime is a feature: the prompt that ran is exactly the prompt in the commit.

### The markdown choice: prose that reviews like prose

The prompts are Markdown, not code template literals, and that matters for review. A reviewer reading the diagnostic prompt's "Investigation approach" section reads it as prose — the way the model reads it — not as an escaped string with `\n`s. The instruction *is* the artifact; Markdown keeps it legible as one. The headings (`## Role`, `## Hard rules`) double as a structure a reviewer can scan (→ 01-anatomy.md).

### Runtime interpolation is part of the same pattern: `{categories}`

The versioned-markdown-plus-runtime-interpolation pattern is not only for static values like `{schema}` and `{project_id}`. The monitoring prompt has a `## Your category checklist` section whose body is a single `{categories}` slot, and that slot is filled with a string the code *builds at call time*:

```
  scan(hooks?, categories = []):
    if categories is non-empty:
        checklist = join_lines(categories.map(c =>
            "- `" + c.id + "` (" + c.label + ") — " + c.why_it_matters + " …"))
    else:
        checklist = "(no checklist provided — scan for any significant recent change)"

    system = PROMPT
      .replace("{schema}",     schema_summary(schema))
      .replace(/{project_id}/g, schema.project_id)
      .replace("{categories}", checklist)        # ← same replace pattern
```

This is the *same* discipline as `{schema}`/`{project_id}`: the constant lives in the version-controlled markdown, and a runtime value is stamped into a named slot with a string replace right before the call. The only thing that differs is provenance — `{schema}` is a workspace summary and `{project_id}` is one id, while `{categories}` is a checklist *assembled in code* from the anomaly-category list the scan method now takes. The prompt file stays the diffable, reviewable artifact; the per-call payload is the runnable-category list the route gates and passes in. For the prompts-as-code lens, the takeaway is that "what's in the file" and "what's injected" is still a clean two-way split even when the injected value is computed — the slot is committed, the content is built per call. (The gate that decides which categories get passed is its own topic — → ../study-ai-engineering/04-agents-and-tool-use/07-capability-gating.md.)

---

### Move 2.5 — current state vs. the missing half

The honest part. Here is what is *not* wired, and why it bites.

**Gap 1 — model ID is separate from the prompt.** The model the prompt runs on is a constant in code, in a different file from the prompt:

```
agent model      = "claude-sonnet-4-6"          ← the 3 agents + query
classifier model = "claude-haiku-4-5-20251001"  ← the classifier
```

Nothing ties the monitoring prompt's content hash to the agent model string. They version independently. You can change the prompt without touching the model, and change the model without touching any prompt — and there is no record that pins which prompt version was validated against which model version. A prompt is tuned for the behavior of a *specific* model; decoupling them in the source means the pairing exists only in someone's memory.

```
prompt version:  monitoring prompt @ abc123     ─┐
                                                  ├─ NOT paired, NOT co-logged
model version:   the agent model constant       ─┘
```

**Gap 2 — no prompt-version → output observability.** The route handler streams the trace and persists the events on stream close, but the persisted record carries the *outputs* (diagnosis, recommendations, reasoning steps) — not the prompt SHA or the model ID that produced them. So given a bad diagnosis from last week, you cannot answer "which monitoring prompt was live then, on which model?" without correlating git history to a deploy timestamp by hand.

```
saved:      reasoning_step · diagnosis · recommendation · done
NOT saved:  prompt sha · model id · prompt version tag
→ can't bisect a regression to a prompt line or a model bump
```

**Why this is the "worked-on-Sonnet-breaks-on-the-next-Sonnet" risk, precisely.** Change the agent-model constant to a newer model. The prompts are unchanged, so the diff looks safe — one line, a model string. But the prompts were tuned against the *old* model's behavior: its default formatting, its tendency to fence JSON, its adherence to the monitoring prompt's "do not re-run variations" rule. The new model may format differently, and now the diagnostic agent's parse-failure rate climbs. Because the prompt version and model version aren't paired or co-logged, the regression presents as "diagnoses got worse" with no signal pointing at the model bump. The fix that would make it traceable — log `{promptSha, model}` with every output — is exactly the missing half.

---

### The principle

Putting prompts in files buys you the authoring half of prompts-as-code: diff, review, history, runtime immutability. It does *not* automatically buy the observability half: pairing prompt version with model version and logging both against output. A prompt is logic tuned to a specific model; treating it as code means versioning *the pair* and recording which pair produced which result. blooming insights nailed the first half and left the second for later — which is a defensible early-stage choice as long as you know the gap is there before the model upgrade that exposes it.

---

## Prompts as code — diagram

This diagram spans the authoring half (solid) and the observability half (dashed). A reader who sees only this should grasp that the prompt is a versioned file loaded as source, that the model ID lives elsewhere unpaired, and that nothing logs the prompt-version → output link.

```
┌──────────────────────────────────────────────────────────────────────┐
│  AUTHORING HALF — IMPLEMENTED                                         │
│                                                                       │
│  prompts directory (*.md)  ──sync read──▶  PROMPT const               │
│   monitoring · diagnostic · recommendation · query prompts            │
│                                                                       │
│   git history ── PR diff ── review ── ships in the build              │
│   (runtime-immutable: import-time read, no live edit)                 │
└───────────────────────────┬───────────────────────────────────────────┘
                            │  runs on
┌───────────────────────────▼───────────────────────────────────────────┐
│  MODEL IDs — SEPARATE, UNPAIRED                                       │
│   agent model      = "claude-sonnet-4-6"                              │
│   classifier model = "claude-haiku-4-5-20251001"                      │
└───────────────────────────┬───────────────────────────────────────────┘
                            ┊  (no pairing, no co-logging)
┌ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ▼ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┐
   OBSERVABILITY HALF — NOT IMPLEMENTED
   investigation save persists OUTPUTS only:
     reasoning_step · diagnosis · recommendation · done
   MISSING: prompt sha · model id · version tag per output
   → a model bump is a 1-line diff that can silently regress
└ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┘
```

The authoring half is solid; the model ID is decoupled; the observability half is empty — which is the line between "we can review a prompt" and "we can trace a regression to one."

---

## Implementation in codebase

**Case A — partial. The authoring half is implemented; the observability half is not.**

### Prompts loaded as versioned source

- **File:** `lib/agents/{monitoring,diagnostic,recommendation,query}.ts` + `lib/agents/prompts/*.md`
- **Function / class:** module-level `PROMPT` constant via `readFileSync`
- **Line range:** `monitoring.ts` L13, `diagnostic.ts` L13, `recommendation.ts` L14, `query.ts` L13.
- **Role:** the prompt is a repo file loaded as source at import — diffable, reviewable, runtime-immutable.

### Model IDs (separate from the prompts)

- **File:** `lib/agents/base.ts`, `lib/agents/intent.ts`
- **Function / class:** `AGENT_MODEL`, `CLASSIFIER_MODEL` constants
- **Line range:** `base.ts` L9 (`'claude-sonnet-4-6'`), `intent.ts` L14 (`'claude-haiku-4-5-20251001'`).
- **Role:** the model version lives in code, decoupled from the prompt files — unpaired and independently versioned.

### Output persistence (no prompt/model metadata)

- **File:** `app/api/agent/route.ts`
- **Function / class:** `saveInvestigation` call in the stream's `start`
- **Line range:** L254 (`saveInvestigation(insightId!, collected)`); `collected` is the `AgentEvent[]` of outputs, declared at L171 and pushed to in `send` at L173.
- **Role:** persists the streamed outputs for cache-replay; carries no prompt SHA, model ID, or version tag — the observability gap.

### Why this is a codebase strength (the half it has)

The prompts being plain `.md` under `lib/` means every behavior change is a reviewable diff with git history, and the import-time read guarantees the deployed prompt equals the committed prompt. That is the foundation; the missing half is additive, not a rewrite.

---

## Elaborate

### Where this comes from

Prompts-as-code is the consensus correction to "prompts in a dashboard." The early LLM-app pattern was to edit prompts in a vendor console for speed; teams learned the hard way that an un-versioned prompt is an un-bisectable bug, and the field converged on "prompts are source." Tools like PromptLayer, LangSmith, and Humanloop exist specifically to add the *observability half* — pairing prompt version with model and run, and logging outputs against both. The authoring half (files in the repo) is the table stakes; the tooling ecosystem is almost entirely about the second half blooming insights hasn't built.

### The deeper principle

```
prompt-as-text-in-a-DB     prompt-as-code (authoring)     prompt-as-code (full)
────────────────────────   ──────────────────────────    ─────────────────────────
edit live, no diff         file + git + review            + model pairing
no history                 runtime-immutable              + per-output logging
unbisectable               bisectable by hand             bisectable automatically
                           ◀── blooming insights is here
```

The progression is: make it a file (review), then make it observable (trace). A prompt is logic tuned to a model; the full discipline versions the pair and records which pair ran. blooming insights is one step short of full.

### Where this breaks down

1. **A model bump looks safe in a diff.** Changing `base.ts` L9 is a one-line change that the diff makes look trivial — but it can regress every prompt tuned to the old model, with no co-logged signal pointing at the cause.
2. **`readFileSync` at import means no hot-fix.** The runtime immutability that makes the deployed prompt trustworthy also means fixing a prompt requires a redeploy — fine for safety, slow for incident response.
3. **`.md` prompts aren't validated against their loaders.** Nothing asserts the placeholders in `monitoring.md` match the `.replace` calls in `monitoring.ts` (→ 01-anatomy.md exercise), so a prompt-only edit can introduce an un-injected placeholder that a code review of the `.md` alone won't catch.

### What to explore next

- **Co-log the pair:** add `{ promptSha, model }` to the persisted investigation record (`route.ts` L254) so every output is traceable to a prompt version and model version.
- **Pin the pairing in code:** colocate the model ID with the prompt (e.g. front-matter in the `.md`, or a per-agent config) so a model change forces a deliberate prompt-pairing decision rather than a silent decoupled edit.
- **Prompt version tags:** stamp a semantic version or git SHA into the loaded prompt and surface it in the trace, so a regression can be bisected to a prompt line automatically.

---

## Project exercises

### Co-log prompt SHA and model ID with every investigation

- **Exercise ID:** C1.7 (adapted) — prompts-as-code observability.
- **What to build:** compute a content hash of each loaded prompt at import (alongside the `PROMPT` const), and include `{ promptSha, model: AGENT_MODEL }` in the record `saveInvestigation` persists (`route.ts` L254), so every saved investigation is traceable to the exact prompt version and model that produced it.
- **Why it earns its place:** closes the highest-value half of the observability gap — turns "diagnoses got worse last week" from a manual git/deploy correlation into a field on the record.
- **Files to touch:** `lib/agents/{monitoring,diagnostic,recommendation,query}.ts` (export the prompt hash), `lib/state/investigations.ts` (widen the persisted shape), `app/api/agent/route.ts` (L162 — attach provenance).
- **Done when:** a saved investigation record carries the prompt SHA and model ID, and changing a prompt changes the recorded SHA on the next run.
- **Estimated effort:** 1–4hr

### Pin the model pairing in the prompt file

- **Exercise ID:** C1.7 (adapted) — version the prompt↔model pair.
- **What to build:** add a front-matter line to each `lib/agents/prompts/*.md` declaring the model it's tuned for, parse it at load, and assert it matches `AGENT_MODEL` / `CLASSIFIER_MODEL` — so a model bump in `base.ts` L9 that doesn't update the prompts' declared pairing fails fast instead of silently regressing.
- **Why it earns its place:** makes the prompt↔model coupling explicit and enforced, so the "worked-on-Sonnet-breaks-on-the-next" upgrade can't ship unnoticed.
- **Files to touch:** the four `lib/agents/prompts/*.md` (front-matter), the four agent `.ts` files (parse + assert at load), `lib/agents/base.ts` / `lib/agents/intent.ts` (export the expected model).
- **Done when:** bumping `AGENT_MODEL` without updating the prompts' declared model throws at load, and a matching pair loads cleanly.
- **Estimated effort:** 1–4hr

---

## Interview defense

### What an interviewer is really asking

"How do you manage your prompts?" tests whether you treat prompts as throwaway strings or as versioned logic — and, at the senior level, whether you know that "prompts as code" has a second half (observability) most teams skip. The strong answer names both halves and is honest about which one this codebase has.

### Likely questions

**[mid] "Where do your prompts live and how are they changed?"**

In `lib/agents/prompts/*.md`, loaded with `readFileSync` at import (`monitoring.ts` L13 etc.). Changing one is a PR diff on the `.md` with git history and review, and because the read is at import time the deployed prompt always equals the committed one — no live editing.

```
edit monitoring.md → PR diff → review → merge → ships (import-time read)
```

**[senior] "A diagnosis quality dropped last week. How do you find the cause?"**

Today, with difficulty — `saveInvestigation` (`route.ts` L254) persists the outputs but not the prompt SHA or model ID, so I'd correlate `git log lib/agents/prompts/` and `base.ts` L9 history against the deploy timeline by hand. The right fix is co-logging `{ promptSha, model }` with each record so I can filter by version. The gap is the observability half of prompts-as-code; the authoring half (files + git) is there.

```
have:  outputs persisted
need:  { promptSha, model } per output → filter the regression to a version
```

**[arch] "You bumped the model in `base.ts` L9 and quality regressed. Why was that hard to catch?"**

Because the prompts and the model version are decoupled in the source and never co-logged. The prompts in `lib/agents/prompts/*.md` were tuned to the old model's behavior — its default formatting, its JSON-fencing habit, its adherence to `monitoring.md` L11's "do not re-run variations." A one-line model change leaves the prompts unchanged, so the diff looks safe, and nothing records which prompt version was validated against which model. The regression shows up as "output got worse" with no signal pointing at the bump.

```
base.ts L9: model bump (1-line diff)  → prompts unchanged, tuned to OLD model
no pairing/co-log → regression untraceable to the model change
```

### The question candidates always dodge

**"Is putting prompts in files enough to call them 'code'?"** No — and candidates dodge because conceding it admits their setup is half-done. Files buy review and history; "prompts as code" in full means versioning the prompt↔model pair and logging which pair produced which output. blooming insights has the authoring half and not the observability half — and naming that gap precisely is the senior move, not claiming completeness.

### One-line anchors

- `lib/agents/monitoring.ts` L13 — prompt loaded as source via `readFileSync` (same at `diagnostic.ts` L13, `recommendation.ts` L14, `query.ts` L13).
- `lib/agents/base.ts` L9 — `AGENT_MODEL` constant, decoupled from the prompts.
- `lib/agents/intent.ts` L14 — `CLASSIFIER_MODEL`, separately versioned.
- `app/api/agent/route.ts` L254 — `saveInvestigation` persists outputs only, no prompt/model provenance.
- the gap: prompt version + model version are neither paired nor co-logged → untraceable regression.

---

## Validate

### Level 1 — Reconstruct

From memory, draw the two halves of prompts-as-code (authoring: file → load → version → review; observability: pair → log → bisect) and mark which half blooming insights implements. Name the file+line where each prompt is loaded and where the model ID lives.

### Level 2 — Explain

Out loud: why does loading the prompt with `readFileSync` *at import* (`monitoring.ts` L13) guarantee the deployed prompt equals the committed one, and what does that immutability cost during an incident?

### Level 3 — Apply

Scenario: you change `AGENT_MODEL` at `base.ts` L9 to a newer model and the diagnostic agent's parse-failure rate climbs. Walk through why the persisted records (`route.ts` L254) don't let you confirm the model bump as the cause, and name the one field you'd add to make it traceable.

### Level 4 — Defend

A reviewer says: "We don't need prompt observability — git history is enough." State what git history *does* give (the diff, the author, the timeline) and what it *doesn't* (which prompt version ran for a given output, paired with which model), and the event that makes the gap bite (the first model bump that silently regresses output tuned to the prior model).

### Quick check — code reference test

Where does the model ID that runs the three agents live, and is it stored anywhere alongside the prompt or the output? (Answer: `AGENT_MODEL = 'claude-sonnet-4-6'` at `lib/agents/base.ts` L9; it is *not* paired with the prompt files and *not* persisted by `saveInvestigation` at `app/api/agent/route.ts` L254 — the observability gap.)

## See also

→ 01-anatomy.md · → 02-structured-outputs.md · → 06-single-purpose-chains.md

---
Updated: 2026-05-29 — Documented the `{categories}` runtime checklist injection as a prompts-as-code interpolation pattern (`monitoring.ts` L69–86: `scan` now takes a `categories` param at L69, builds a checklist, and `.replace('{categories}', checklist)` at L86 — same versioned-`.md`-plus-runtime-interpolation as `{schema}`/`{project_id}`). Also corrected stale code refs: `monitoring.ts` L12→L13 and `saveInvestigation` `route.ts` L162→L254 (with the stream body L169–256 and `collected` declared L171).
Updated: 2026-05-30 — Migrated to study.md v1.47 template (Phase 1+2 mechanical): removed Tradeoffs / Tech reference / Summary sections; renamed "In this codebase" → "Implementation in codebase"; moved See also to a bottom block. "Why care" preserved pending Phase 3 (Zoom out, then zoom in + LAYERS diagram) authoring.
Updated: 2026-05-30 — Phase 3 of study.md v1.47 migration: replaced "Why care" block with "Zoom out, then zoom in" (LAYERS diagram + zoom-in paragraph) per format.md.
Updated: 2026-05-31 — Applied study.md v1.48: scrubbed "How it works" of file paths, line refs, and real-code fences; replaced with generic role labels + pseudocode per format.md. Codebase-specific anchoring lives exclusively in "Implementation in codebase".
Updated: 2026-05-31 — Applied study.md v1.50: added Structure pass block (layers · axis · seams) between Zoom out and How it works per format.md's new Block 3.
