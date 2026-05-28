# Prompts as code (versioning, review, and the observability gap)

**Industry name(s):** prompts-as-code, prompt versioning, prompt source control, prompt observability
**Type:** Industry standard · Language-agnostic

> blooming insights treats prompts as source — four `.md` files loaded with `readFileSync`, version-controlled, git-diffable, reviewed in PRs like any other code. What it does *not* yet do is pair a prompt version with the model that ran it (model IDs live in `base.ts` L9 and `intent.ts` L14, separate from the prompts) or log which prompt version produced which output — so the "worked on Sonnet, breaks on the next Sonnet" failure can't be traced.

**See also:** → 01-anatomy.md · → 02-structured-outputs.md · → 06-single-purpose-chains.md

---

## Why care

You don't keep your component templates in a database column edited through an admin panel — they live in files, in the repo, reviewed in PRs, with a git history that tells you who changed what and why. A prompt that drives a production agent deserves the same treatment, because a prompt *is* program logic: change one line and the behavior of the whole feature changes. The failure mode of the alternative — prompts edited live in a vendor dashboard or a hot-reloaded config — is that you ship a behavior change with no diff, no review, and no way to bisect when it regresses.

The question this file answers: are blooming insights' prompts treated as code, and if so, how completely — what's version-controlled, what's reviewed, and what's *not* yet tracked?

**The pivot: storing prompts as files gets you diffability and review for free, but "prompts as code" is only half done until the prompt version is paired with the model version and logged against the output — and blooming insights has the first half, not the second.** The first half is real and valuable. The second half is the gap that turns a model upgrade into a silent regression you can't trace.

Before prompts-as-code:
- The prompt lives somewhere mutable; a behavior change has no diff
- You can't tell which prompt produced last week's bad diagnosis
- A reviewer never sees the instruction change that caused the bug

After (what this codebase has):
- `git log lib/agents/prompts/monitoring.md` shows every change, authored and reviewed
- A prompt edit shows up in a PR diff next to the code that loads it
- But: nothing records "this output came from monitoring.md@<sha> running on claude-sonnet-4-6"

It is the templates-in-the-repo discipline, applied to strings a model reads — done halfway.

---

## How it works

**Mental model.** A prompt-as-code system has four properties: the prompt is a *file* (not a DB row or dashboard field), it is *loaded as source* by the program, it is *versioned* in the same repo as the code, and its version is *paired and logged* with the model and output for observability. blooming insights has the first three solidly and the fourth not at all. Picture two halves: the authoring half (file + load + version + review) is complete; the observability half (pair + log) is empty.

```
AUTHORING HALF  (have it)              OBSERVABILITY HALF  (don't)
─────────────────────────────         ─────────────────────────────
file:    monitoring.md                 pair:  prompt@sha + model id
load:    readFileSync (mon.ts L12)     log:   which prompt → which output
version: git history                   trace: bisect a regression to a line
review:  PR diff                       alert: failure rate per prompt version
```

The left column is what makes a prompt a maintainable artifact. The right column is what makes a regression *findable*. The codebase has the left, lacks the right.

---

### The prompt is a file, loaded as source

Each agent reads its prompt off disk at module load — once, synchronously, as the module is imported:

```
monitoring.ts   L12  const PROMPT = readFileSync(join(process.cwd(),'lib/agents/prompts/monitoring.md'),'utf8');
diagnostic.ts   L13  const PROMPT = readFileSync(join(process.cwd(),'lib/agents/prompts/diagnostic.md'),'utf8');
recommendation.ts L14 const PROMPT = readFileSync(join(process.cwd(),'lib/agents/prompts/recommendation.md'),'utf8');
query.ts        L13  const PROMPT = readFileSync(join(process.cwd(),'lib/agents/prompts/query.md'),'utf8');
```

The `.md` files are not strings hidden in a `.ts` literal and they are not rows in a database — they are first-class files under `lib/agents/prompts/`. That placement is the whole move: a prompt under `lib/` is reviewed, diffed, and shipped exactly like the `.ts` next to it. A teammate changing `monitoring.md`'s "90-day window" method shows up in the PR as a content diff a reviewer reads line by line.

```
edit prompt → git diff → PR review → merge → ships with the build
   (same lifecycle as lib/mcp/validate.ts)
```

Because `readFileSync` runs at import, the prompt is also baked into the running process — there is no live-edit path, no dashboard override, no way for the deployed prompt to differ from the committed one. That immutability-at-runtime is a feature: the prompt that ran is exactly the prompt in the commit.

### The `.md` choice: prose that reviews like prose

The prompts are Markdown, not TypeScript template literals, and that matters for review. A reviewer reading `diagnostic.md`'s "Investigation approach" (L18–24) reads it as prose — the way the model reads it — not as an escaped string with `\n`s. The instruction *is* the artifact; Markdown keeps it legible as one. The headings (`## Role`, `## Hard rules`) double as a structure a reviewer can scan (→ 01-anatomy.md).

---

### Move 2.5 — current state vs. the missing half

The honest part. Here is what is *not* wired, and why it bites.

**Gap 1 — model ID is separate from the prompt.** The model the prompt runs on is a constant in code, in a different file from the prompt:

```
base.ts   L9   export const AGENT_MODEL = 'claude-sonnet-4-6';     ← the 3 agents + query
intent.ts L14  const CLASSIFIER_MODEL = 'claude-haiku-4-5-20251001'; ← the classifier
```

Nothing ties `monitoring.md@<sha>` to `claude-sonnet-4-6`. They version independently. You can change the prompt without touching the model, and change the model (`base.ts` L9) without touching any prompt — and there is no record that pins which prompt version was validated against which model version. A prompt is tuned for the behavior of a *specific* model; decoupling them in the source means the pairing exists only in someone's memory.

```
prompt version:  monitoring.md@abc123   ─┐
                                          ├─ NOT paired, NOT co-logged
model version:   claude-sonnet-4-6  (base.ts L9) ─┘
```

**Gap 2 — no prompt-version → output observability.** The route streams the trace (`route.ts` L105–169) and `saveInvestigation` persists the events (`route.ts` L162), but the persisted record carries the *outputs* (diagnosis, recommendations, reasoning steps) — not the prompt SHA or the model ID that produced them. So given a bad diagnosis from last week, you cannot answer "which `monitoring.md` was live then, on which model?" without correlating git history to a deploy timestamp by hand.

```
saved (route.ts L162):  reasoning_step · diagnosis · recommendation · done
NOT saved:              prompt sha · model id · prompt version tag
→ can't bisect a regression to a prompt line or a model bump
```

**Why this is the "worked-on-Sonnet-breaks-on-the-next-Sonnet" risk, precisely.** Change `base.ts` L9 to a newer model. The prompts are unchanged, so the diff looks safe — one line, a model string. But the prompts were tuned against the *old* model's behavior: its default formatting, its tendency to fence JSON, its adherence to "do not re-run variations" (`monitoring.md` L11). The new model may format differently, and now the diagnostic agent's parse-failure rate climbs. Because the prompt version and model version aren't paired or co-logged, the regression presents as "diagnoses got worse" with no signal pointing at the model bump. The fix that would make it traceable — log `{promptSha, model}` with every output — is exactly the missing half.

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
│  lib/agents/prompts/*.md  ──readFileSync──▶  PROMPT const            │
│   monitoring.md (mon.ts L12) · diagnostic.md (diag.ts L13)           │
│   recommendation.md (rec.ts L14) · query.md (query.ts L13)          │
│                                                                       │
│   git history ── PR diff ── review ── ships in the build             │
│   (runtime-immutable: import-time read, no live edit)               │
└───────────────────────────┬───────────────────────────────────────────┘
                            │  runs on
┌───────────────────────────▼───────────────────────────────────────────┐
│  MODEL IDs — SEPARATE, UNPAIRED                                       │
│   base.ts L9   AGENT_MODEL    = 'claude-sonnet-4-6'                  │
│   intent.ts L14 CLASSIFIER    = 'claude-haiku-4-5-20251001'          │
└───────────────────────────┬───────────────────────────────────────────┘
                            ┊  (no pairing, no co-logging)
┌ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ▼ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┐
   OBSERVABILITY HALF — NOT IMPLEMENTED
   saveInvestigation (route.ts L162) persists OUTPUTS only:
     reasoning_step · diagnosis · recommendation · done
   MISSING: prompt sha · model id · version tag per output
   → a model bump (base.ts L9) is a 1-line diff that can silently regress
└ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┘
```

The authoring half is solid; the model ID is decoupled; the observability half is empty — which is the line between "we can review a prompt" and "we can trace a regression to one."

---

## In this codebase

**Case A — partial. The authoring half is implemented; the observability half is not.**

### Prompts loaded as versioned source

- **File:** `lib/agents/{monitoring,diagnostic,recommendation,query}.ts` + `lib/agents/prompts/*.md`
- **Function / class:** module-level `PROMPT` constant via `readFileSync`
- **Line range:** `monitoring.ts` L12, `diagnostic.ts` L13, `recommendation.ts` L14, `query.ts` L13.
- **Role:** the prompt is a repo file loaded as source at import — diffable, reviewable, runtime-immutable.

### Model IDs (separate from the prompts)

- **File:** `lib/agents/base.ts`, `lib/agents/intent.ts`
- **Function / class:** `AGENT_MODEL`, `CLASSIFIER_MODEL` constants
- **Line range:** `base.ts` L9 (`'claude-sonnet-4-6'`), `intent.ts` L14 (`'claude-haiku-4-5-20251001'`).
- **Role:** the model version lives in code, decoupled from the prompt files — unpaired and independently versioned.

### Output persistence (no prompt/model metadata)

- **File:** `app/api/agent/route.ts`
- **Function / class:** `saveInvestigation` call in the stream's `start`
- **Line range:** L162 (`saveInvestigation(insightId!, collected)`); `collected` is the `AgentEvent[]` of outputs (L107–131).
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

- **Co-log the pair:** add `{ promptSha, model }` to the persisted investigation record (`route.ts` L162) so every output is traceable to a prompt version and model version.
- **Pin the pairing in code:** colocate the model ID with the prompt (e.g. front-matter in the `.md`, or a per-agent config) so a model change forces a deliberate prompt-pairing decision rather than a silent decoupled edit.
- **Prompt version tags:** stamp a semantic version or git SHA into the loaded prompt and surface it in the trace, so a regression can be bisected to a prompt line automatically.

---

## Tradeoffs

### Prompts-as-files (authoring only) vs. full prompt observability tooling

| Dimension | This codebase (files + git, no obs) | Full obs (PromptLayer/LangSmith-style) |
|---|---|---|
| Diff / review | Yes — PR diff on the `.md` | Yes (plus run-level diffing) |
| Runtime immutability | Yes — import-time read | Varies (often live-editable) |
| Regression bisect to a line | Manual (git vs deploy time) | Automatic (version logged per run) |
| Model-version pairing | None — `base.ts` L9 decoupled | Tracked per run |
| Operational weight | Zero deps, zero infra | Extra service + instrumentation |
| Time to incident root cause | Slow (correlate by hand) | Fast (filter by prompt/model version) |

**What we gave up.** Traceability. With outputs persisted but no prompt SHA or model ID alongside them (`route.ts` L162), root-causing "diagnoses got worse" means correlating git history against deploy timestamps manually. Full observability tooling would make it a filter query.

**What the alternative would have cost.** An extra service (or self-hosted store), instrumentation on every agent call, and a dependency the rest of the stack doesn't need. For an early-stage app with four prompts, files-plus-git is the right amount of process; the obs tooling would be premature weight.

**The breakpoint.** Files-plus-git is right while the team can hold the prompt↔model pairing in its head and regressions are rare. It stops being right at the first model upgrade that silently regresses output, or when the prompt count grows past what one person can reason about — at that point the cost of *not* co-logging `{promptSha, model}` (an untraceable regression) exceeds the cost of adding it.

---

## Tech reference (industry pairing)

### Prompts as repo files (`readFileSync` of `.md`)

- **Codebase uses:** `lib/agents/*.ts` L12–14 read `lib/agents/prompts/*.md` at import; the prompts live under `lib/` and ship with the build.
- **Why it's here:** zero-dependency way to make prompts diffable, reviewable, and runtime-immutable — the authoring half of prompts-as-code.
- **Leading today (2026):** prompts-as-files-in-repo is the baseline; prompt-management platforms (PromptLayer, LangSmith, Humanloop) lead for teams needing the observability half.
- **Why it leads:** the platforms add version↔run↔output logging and A/B/eval wiring that files alone can't.
- **Runner-up:** prompts as typed objects in code (per-prompt module exporting template + variables + model) — keeps everything in-language and lets the model pairing live next to the prompt.

### Model ID as a code constant

- **Codebase uses:** `base.ts` L9 `AGENT_MODEL`, `intent.ts` L14 `CLASSIFIER_MODEL` — string constants, separate from the prompts.
- **Why it's here:** one place to swap the model; simple and explicit.
- **Leading today (2026):** colocating model + prompt + decoding params as one versioned config leads, because the three are tuned together.
- **Why it leads:** a prompt is tuned to a model; versioning them as a unit prevents the silent-decoupling regression.
- **Runner-up:** front-matter in the `.md` carrying the intended model — keeps the pairing visible in the prompt file itself.

### Output persistence without provenance (`saveInvestigation`)

- **Codebase uses:** `route.ts` L162 persists the `AgentEvent[]` of outputs for cache-replay; no prompt SHA or model ID attached.
- **Why it's here:** the immediate need was replay (serve a precomputed investigation without re-running), not regression tracing.
- **Leading today (2026):** run records that carry `{ promptVersion, model, params, inputHash, output }` lead for any team doing eval-driven iteration.
- **Why it leads:** provenance is what turns a saved output into a debuggable, evaluatable record.
- **Runner-up:** structured logs (one line per run with the provenance fields) shipped to any log store — lighter than a full platform.

---

## Project exercises

### Co-log prompt SHA and model ID with every investigation

- **Exercise ID:** C1.7 (adapted) — prompts-as-code observability.
- **What to build:** compute a content hash of each loaded prompt at import (alongside the `PROMPT` const), and include `{ promptSha, model: AGENT_MODEL }` in the record `saveInvestigation` persists (`route.ts` L162), so every saved investigation is traceable to the exact prompt version and model that produced it.
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

## Summary

blooming insights treats prompts as code in the authoring sense: four `.md` files under `lib/agents/prompts/`, loaded as source with `readFileSync` (`monitoring.ts` L12, `diagnostic.ts` L13, `recommendation.ts` L14, `query.ts` L13), version-controlled, diffed and reviewed in PRs, and runtime-immutable because the read happens at import. The observability half is absent: model IDs live separately (`base.ts` L9, `intent.ts` L14), unpaired with the prompts, and `saveInvestigation` (`route.ts` L162) persists outputs with no prompt SHA or model ID attached. That gap is exactly what makes a one-line model bump a potential silent regression — the prompts are tuned to a specific model, and nothing records or enforces which prompt version was validated against which model.

**Key points:**
- Prompts are repo files loaded as source — diffable, reviewable, runtime-immutable (read at import).
- `.md` keeps the instruction legible as prose, the way the model reads it and the way a reviewer reads it.
- Model IDs are code constants in different files (`base.ts` L9, `intent.ts` L14), not paired with the prompts.
- Persisted investigations (`route.ts` L162) carry outputs only — no prompt SHA, model ID, or version tag.
- The missing pairing is the precise reason a model upgrade can silently regress prompts tuned to the prior model.

---

## Interview defense

### What an interviewer is really asking

"How do you manage your prompts?" tests whether you treat prompts as throwaway strings or as versioned logic — and, at the senior level, whether you know that "prompts as code" has a second half (observability) most teams skip. The strong answer names both halves and is honest about which one this codebase has.

### Likely questions

**[mid] "Where do your prompts live and how are they changed?"**

In `lib/agents/prompts/*.md`, loaded with `readFileSync` at import (`monitoring.ts` L12 etc.). Changing one is a PR diff on the `.md` with git history and review, and because the read is at import time the deployed prompt always equals the committed one — no live editing.

```
edit monitoring.md → PR diff → review → merge → ships (import-time read)
```

**[senior] "A diagnosis quality dropped last week. How do you find the cause?"**

Today, with difficulty — `saveInvestigation` (`route.ts` L162) persists the outputs but not the prompt SHA or model ID, so I'd correlate `git log lib/agents/prompts/` and `base.ts` L9 history against the deploy timeline by hand. The right fix is co-logging `{ promptSha, model }` with each record so I can filter by version. The gap is the observability half of prompts-as-code; the authoring half (files + git) is there.

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

- `lib/agents/monitoring.ts` L12 — prompt loaded as source via `readFileSync` (same at `diagnostic.ts` L13, `recommendation.ts` L14, `query.ts` L13).
- `lib/agents/base.ts` L9 — `AGENT_MODEL` constant, decoupled from the prompts.
- `lib/agents/intent.ts` L14 — `CLASSIFIER_MODEL`, separately versioned.
- `app/api/agent/route.ts` L162 — `saveInvestigation` persists outputs only, no prompt/model provenance.
- the gap: prompt version + model version are neither paired nor co-logged → untraceable regression.

---

## Validate

### Level 1 — Reconstruct

From memory, draw the two halves of prompts-as-code (authoring: file → load → version → review; observability: pair → log → bisect) and mark which half blooming insights implements. Name the file+line where each prompt is loaded and where the model ID lives.

### Level 2 — Explain

Out loud: why does loading the prompt with `readFileSync` *at import* (`monitoring.ts` L12) guarantee the deployed prompt equals the committed one, and what does that immutability cost during an incident?

### Level 3 — Apply

Scenario: you change `AGENT_MODEL` at `base.ts` L9 to a newer model and the diagnostic agent's parse-failure rate climbs. Walk through why the persisted records (`route.ts` L162) don't let you confirm the model bump as the cause, and name the one field you'd add to make it traceable.

### Level 4 — Defend

A reviewer says: "We don't need prompt observability — git history is enough." State what git history *does* give (the diff, the author, the timeline) and what it *doesn't* (which prompt version ran for a given output, paired with which model), and the event that makes the gap bite (the first model bump that silently regresses output tuned to the prior model).

### Quick check — code reference test

Where does the model ID that runs the three agents live, and is it stored anywhere alongside the prompt or the output? (Answer: `AGENT_MODEL = 'claude-sonnet-4-6'` at `lib/agents/base.ts` L9; it is *not* paired with the prompt files and *not* persisted by `saveInvestigation` at `app/api/agent/route.ts` L162 — the observability gap.)
