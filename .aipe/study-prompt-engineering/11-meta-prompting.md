# Meta-prompting (using an LLM to write prompts for other LLM calls)

**Industry name(s):** meta-prompting, prompt generation, prompt-bootstrapping, automatic prompt engineering (APE-adjacent)
**Type:** Industry standard · Language-agnostic

> Meta-prompting is using a model to draft or improve the prompts you feed to other model calls — the human writes a goal, the model drafts a prompt, the human reviews and edits it, and the edited prompt enters the repo. blooming insights' four prompts are entirely hand-written `.md` files; nothing in the codebase generates a prompt. The workflow saves real time on the initial draft of a complex prompt and almost none on small tweaks — and its failure mode is a prompt that reads like LLM output instead of an engineering spec.

**See also:** → 01-anatomy.md · → 03-prompts-as-code.md · → 05-eval-driven-iteration.md · → 10-self-critique.md

---

## Why care

You scaffold a new module with a generator — `next` or a component CLI emits the boilerplate file with the imports, the type signature, and a TODO body — and then you edit it into the thing you actually wanted. You did not hand-type the boilerplate; you also did not ship the generated stub unread. The generator gets you to a 70%-complete starting point fast, and your judgment turns it into the real artifact.

A complex prompt is a similar artifact. blooming insights' `diagnostic.md` is 85 lines with a Role, Hard rules, an investigation method, EQL reminders, a CRITICAL historical-data block, and a precise JSON output schema. Writing all of that from a blank file is slow. The question this file answers: **when does using a model to draft that prompt save real time, when does it just add a review pass over output you have to rewrite anyway, and how do you keep a generated prompt from reading like generated prose instead of a spec?**

**The pivot: meta-prompting is scaffolding for prompts — it is leverage on the initial draft of a complex prompt and a tax on small tweaks, and the human review step is not optional, because a prompt that reads like LLM output is a liability.** The value is in getting from a blank file to a reviewable draft fast; the danger is treating the draft as done.

Before meta-prompting:
- A new agent prompt starts from a blank file or a copy-paste of an existing one, hand-edited line by line
- Getting the anatomy right (Role, Hard rules, Output schema, `{schema}` placeholder) is slow re-derivation each time

After (used well):
- The human writes a goal and hands the model the workspace schema; the model drafts a prompt with the right anatomy
- The human reviews, deletes the fluff, tightens the rules, and commits a spec — not the raw draft

After (used badly):
- The generated draft gets committed mostly unread; it reads like marketing copy, hedges where it should command, and nobody can tell which lines are load-bearing

---

## How it works

**Mental model.** Meta-prompting puts a model in the loop at *authoring* time, not runtime. There is a meta-prompt (instructions to the model about how to write a good agent prompt), an input (the goal plus context like the workspace schema), a drafting call (the model emits a candidate prompt), and — the non-negotiable step — a human review that turns the draft into a committed artifact. The output of the whole process is a `.md` file in `lib/agents/prompts/`, identical in kind to the hand-written ones (→ 03-prompts-as-code.md); only its origin differs.

```
META-PROMPTING (authoring-time, NOT runtime)
─────────────────────────────────────────────────────────────
 human writes GOAL          "an agent that flags slow-loading
   + CONTEXT                 product pages from the schema"
        │                    + the {schema} shape
        ▼
 META-PROMPT  →  drafting call
   "You write system prompts for analytics agents.
    Mirror this anatomy: Role / Hard rules / method /
    EQL reminders / Output schema / {schema}."
        │
        ▼
 DRAFT prompt  (candidate .md text)
        │
        ▼
 ⚠ HUMAN REVIEW  ← delete fluff, tighten rules, verify
   the placeholders, kill hedging
        │
        ▼
 commit  lib/agents/prompts/<new>.md   (a spec, git-reviewed)
```

The runtime path is untouched. The four agents still `readFileSync` a static `.md` file (`diagnostic.ts` L13, etc.); meta-prompting just changes how that file got written the first time. This is the distinction that matters: nothing generates a prompt *per request* — that would be slow, non-deterministic, and unreviewable.

---

### What the meta-prompt has to know

A drafting call that produces a usable blooming insights agent prompt needs the shared anatomy baked into it (→ 01-anatomy.md), because that anatomy is what makes the four prompts consistent and reviewable.

```
THE META-PROMPT must encode the house anatomy
─────────────────────────────────────────────────────────────
 ## Role          scoped, disclaims the OTHER agents' jobs
 ## Hard rules    "Pass project_id to every call"; "at most N calls"
 method section   how to approach the task
 ## EQL reminders worked query examples in this EQL flavor
 ## Output        exact JSON shape + field rules + example
                  (or "no JSON — prose" for a query-style agent)
 ## Workspace schema  {schema}   ← the injected placeholder
```

Without this, the model drafts a generic "you are a helpful analytics assistant" prompt that ignores the conventions the rest of the system depends on — the `{schema}`/`{project_id}` placeholders the loader replaces (`diagnostic.ts` L45–48), the tool-call budget the loop enforces (`base.ts` L90), the JSON shape the validators check (`validate.ts`). The meta-prompt's job is to transfer that house style into the draft.

---

### Where it saves time vs where it doesn't

This is the honest cost accounting the brief demands.

```
SAVES TIME                          DOESN'T SAVE TIME
─────────────────────────           ─────────────────────────
initial draft of a NEW complex      a small tweak to an existing
 prompt (85-line diagnostic.md       prompt ("change the budget
 from a goal + schema)               from 6 to 4 calls")
─────────────────────────           ─────────────────────────
getting the anatomy + the           a high-iteration prompt you're
 EQL examples + the JSON schema      editing daily against evals —
 scaffolded                          the draft churn outpaces the gen
─────────────────────────           ─────────────────────────
the 0→70% leap                      the 95→100% polish
```

The asymmetry is the whole decision. Drafting `diagnostic.md` from scratch is a job meta-prompting accelerates — you describe the goal, hand over the schema, get a structured draft, and edit. Changing `monitoring.md` L11's "at most 6 tool calls" to 4 is a one-line edit; round-tripping it through a model is pure overhead. And a prompt you are iterating on hourly against an eval set (→ 05-eval-driven-iteration.md) is worse handled by regenerating each time — you lose the precise, incremental control that the iteration depends on.

---

### The failure mode — prompts that read like LLM output

A hand-written prompt in this repo reads like an engineering spec: terse, imperative, every line load-bearing. "Pass `project_id: {project_id}` to **every** tool call — no exceptions" (`diagnostic.md` L9). "Never report a change derived from an empty or zero window" (`monitoring.md` L31). There is no fluff; you can tell exactly what each line is for.

A generated prompt, committed unreviewed, reads like the model's default register: hedged, padded, courteous.

```
SPEC (hand-written, this repo)         LLM-DEFAULT (unreviewed draft)
──────────────────────────────         ──────────────────────────────
"at most 6 tool calls total,           "Try to be efficient with your
 then stop"                             tool usage where possible"
"Never report a change derived          "Be careful to consider whether
 from an empty or zero window"          your data windows contain data"
"Do NOT include an id field"            "You may want to avoid adding
                                        an id field if appropriate"
```

The right column is the failure. It hedges where the spec commands ("try to" / "where possible" / "may want to"), it pads, and — fatally for a prompt — the model reads hedged instructions as optional. The whole reason `monitoring.md`'s empty-window rule works is that it is an absolute "Never," not a "be careful to consider." A generated draft drifts toward the polite register, and the review step's main job is to drag it back to spec voice: delete the hedges, make every rule imperative, cut anything that is not load-bearing.

---

### The principle

Meta-prompting is authoring-time scaffolding: a model drafts a prompt from a goal plus context, and a human edits the draft into a committed spec. It is leverage on the initial draft of a complex prompt and a tax on small tweaks and high-iteration prompts, and its load-bearing step is the human review — because a generated draft defaults to hedged, padded prose, and a prompt only works when every rule is an imperative the model cannot read as optional. blooming insights does none of this; its four prompts are hand-written specs, which is exactly why they read like specs.

---

## Meta-prompting — diagram

This diagram spans the authoring pipeline and shows where it joins the existing runtime. The Authoring layer is where the model drafts and the human reviews; the artifact it produces is a `.md` file that drops into the *same* `lib/agents/prompts/` directory the hand-written prompts live in; the Runtime layer (`readFileSync` → `runAgentLoop`) is unchanged and never sees the meta-prompt.

```
┌──────────────────────────────────────────────────────────────────────┐
│  AUTHORING LAYER   (dev-time helper — NOT built)                      │
│                                                                       │
│  human GOAL + {schema} shape                                         │
│        │                                                             │
│        ▼                                                             │
│  META-PROMPT (encodes house anatomy: Role/Hard rules/EQL/Output)    │
│        │  drafting call                                              │
│        ▼                                                             │
│  DRAFT .md text                                                      │
│        │                                                             │
│        ▼  ⚠ HUMAN REVIEW (kill hedging, tighten to spec voice)      │
│  reviewed prompt                                                     │
└───────────────────────────┬───────────────────────────────────────────┘
                            │ commit
┌───────────────────────────▼───────────────────────────────────────────┐
│  lib/agents/prompts/<new>.md   ← same dir as the hand-written four    │
│  (indistinguishable in kind from diagnostic.md / monitoring.md)       │
└───────────────────────────┬───────────────────────────────────────────┘
                            │ readFileSync  (diagnostic.ts L13, etc.)
┌───────────────────────────▼───────────────────────────────────────────┐
│  RUNTIME LAYER  (unchanged — never sees the meta-prompt)              │
│   PROMPT.replace('{schema}',…).replace('{project_id}',…)             │
│   → runAgentLoop(system = PROMPT, …)   base.ts L48                   │
└──────────────────────────────────────────────────────────────────────┘
```

A reader who sees only this should grasp: meta-prompting acts at authoring time, the human review is in the critical path, the output is an ordinary prompt file, and the runtime path is completely unaffected.

---

## In this codebase

**Not yet implemented.** Nothing in blooming insights generates a prompt; the four agent prompts (`lib/agents/prompts/monitoring.md`, `diagnostic.md`, `recommendation.md`, `query.md`) are hand-written `.md` files loaded verbatim via `readFileSync` (`lib/agents/diagnostic.ts` L13, `monitoring.ts` L12, `recommendation.ts` L14, `query.ts` L13).

There is no partial analog at runtime — the system never produces prompt text, only consumes it. The closest *shape* in the codebase is the static intent-classifier prompt written inline in `lib/agents/intent.ts` (L21–24), which is still hand-authored, not generated. A meta-prompting helper would be a dev-time tool (not part of the request path) that drafts a new agent prompt from a goal plus the workspace schema and outputs a candidate file for human review into `lib/agents/prompts/`.

One nuance worth ruling out: the monitoring prompt now builds its `## Your category checklist` section by interpolating a code-assembled string into a `{categories}` slot (`monitoring.ts` builds the checklist, then `PROMPT.replace('{categories}', checklist)`). That is *dynamic prompt assembly* — code stitching a prompt section from data — not meta-prompting; no model writes the section, code does. Its closest analog is the template interpolation covered in `03-prompts-as-code.md` (the same `{schema}`/`{project_id}` replacement mechanism), not the model-drafts-a-prompt loop this file is about. The Case B verdict stands: nothing in the repo has an LLM generate a prompt.

---

## Elaborate

### Where this comes from

Meta-prompting grew out of two threads. One is the practitioner habit of asking a strong model to "write me a prompt that does X" — informal, but effective for first drafts, and endorsed in vendor prompting guides as a starting point. The other is automatic prompt engineering research (Zhou et al.'s APE, 2022, and the optimizer line like DSPy and OPRO) that generates and *scores* candidate prompts against a dataset, closing the loop with evals rather than a human. blooming insights' relevant version is the human-in-the-loop first one: draft with a model, review as a human, commit. The automated-optimizer version only makes sense once an eval harness exists (→ 05-eval-driven-iteration.md) to score the candidates.

### The deeper principle

```
hand-author                         meta-prompt
──────────────────────────────     ──────────────────────────────
blank file → slow, full control     goal → draft → edit (0→70% fast)
every line yours                    every line reviewed (or it rots)
tweaks: trivial                     tweaks: overhead
```

The deep idea: a model is good at producing structure-complete first drafts and bad at knowing which lines must be absolute. So meta-prompting is best where structure dominates (a fresh complex prompt) and worst where precision dominates (a one-line rule change, a hourly eval-driven tweak). The human's irreplaceable contribution is judgment about which instructions are load-bearing — exactly the judgment a generated draft lacks.

### Where this breaks down

1. **The hedging drift.** The headline failure: drafts default to "try to" and "where possible," and a prompt with soft rules has soft enforcement. The empty-window rule in `monitoring.md` works because it is "Never," not "be careful to." Review must convert every soft rule to an imperative.

2. **Plausible-but-wrong domain content.** A drafting model will happily invent EQL syntax that looks right but is not — exactly the trap `diagnostic.md` L35 warns about ("`customers matching` is NOT supported in this EQL flavor"). A generated prompt can confidently include unsupported syntax; only a reviewer who knows the EQL flavor catches it.

3. **Tweaks cost more than they save.** Round-tripping a one-line change through a model is slower than editing the line. Meta-prompting on small edits is negative leverage.

4. **High-iteration prompts resist regeneration.** A prompt you tune hourly against evals needs incremental, controlled edits; regenerating it each time loses the precise state you are converging toward.

### What to explore next

- **Close the loop with evals.** Once `evals/` exists (→ 05), score generated prompt candidates against the golden set instead of relying only on human review — the APE/DSPy direction.
- **Meta-prompt for improvement, not just drafting.** Feed an existing prompt plus its eval failures and ask the model to propose targeted edits — still human-reviewed.
- **A linter for spec voice.** A simple check that flags hedging words ("try to", "where possible", "may want to") in `lib/agents/prompts/*.md` would catch the drift mechanically, generated or not.

---

## Tradeoffs

### Meta-prompt a draft vs. hand-author from scratch (current state)

| Dimension | This codebase (hand-authored) | Meta-prompted draft + human review |
|---|---|---|
| Time to first complete draft | Slow (blank file) | Fast (0→70% from goal + schema) |
| Time on small tweaks | Trivial (edit the line) | Worse (round-trip overhead) |
| Reads like a spec | Yes — terse, imperative | Only after review kills the hedging |
| Domain correctness (EQL) | Author's knowledge | Draft may invent syntax; reviewer must catch |
| Anatomy consistency | Author re-derives each time | Meta-prompt enforces the house anatomy |
| Reviewable diff in git | Yes (→ 03) | Yes — same `.md` artifact |

**What we gave up.** A fast on-ramp for *new* prompts. Today every new agent prompt starts from a blank file or a copy of an existing one and is hand-edited; the anatomy (Role / Hard rules / EQL reminders / Output / `{schema}`) gets re-derived by hand each time. A meta-prompt that encodes the house anatomy would scaffold that draft in one call.

**What the alternative would have cost.** A meta-prompting helper is dev-time code to maintain, and — more importantly — it shifts the work from authoring to reviewing. If the review is rushed, the cost is a prompt that reads like LLM output: hedged, padded, with rules the model treats as optional, and possibly invented EQL syntax. The hand-authored prompts have zero of those risks because a human wrote every load-bearing line deliberately.

**The breakpoint.** Hand-authoring is fine while there are four stable prompts edited occasionally. Meta-prompting earns its place when (a) the system grows to many agents and the per-prompt authoring cost adds up, or (b) a complex new prompt needs drafting from scratch and the 0→70% leap is worth a review pass. It does NOT earn its place for tweaks or for prompts under hourly eval-driven iteration — there, hand-editing wins.

---

## Tech reference (industry pairing)

### model-drafted prompt (human-in-the-loop meta-prompting)

- **Codebase uses:** nothing; the four prompts in `lib/agents/prompts/` are hand-authored and loaded via `readFileSync` (`lib/agents/diagnostic.ts` L13).
- **Why it's here:** it is not — but a dev-time drafting helper would write into the same directory the runtime already reads.
- **Leading today:** model-drafted-then-human-reviewed prompts as a starting point (2026), endorsed in vendor prompting guides; the human review is the part everyone agrees is mandatory.
- **Why it leads:** it captures the 0→70% leap on complex prompts while keeping a human's judgment on which rules are load-bearing.
- **Runner-up:** prompt-library templates / starter packs — faster than blank, but generic and not schema-aware.

### automated prompt optimization (APE / DSPy / OPRO)

- **Codebase uses:** nothing; there is no eval harness to score candidates against (→ 05-eval-driven-iteration.md).
- **Why it's here:** it is not — it presupposes the `evals/` loop that does not yet exist.
- **Leading today:** DSPy-style compile/optimize against a metric and OPRO-style optimizer loops (2026) for teams that have an eval set.
- **Why it leads:** it closes the loop with a measured score instead of human taste, optimizing prompts the way you'd optimize any objective.
- **Runner-up:** manual A/B of prompt variants on a golden set — the same idea by hand, no optimizer.

### the prompt artifact (where the output lands)

- **Codebase uses:** `.md` files in `lib/agents/prompts/`, version-controlled and git-reviewed (→ 03-prompts-as-code.md), with `{schema}`/`{project_id}` placeholders replaced at load.
- **Why it's here:** prompts-as-code makes a generated prompt indistinguishable in kind from a hand-written one — same review, same diff, same loader.
- **Leading today:** version-controlled prompt files (and prompt registries for larger systems) in 2026.
- **Why it leads:** whatever drafts the prompt, the artifact must be a reviewable, diffable file — which is exactly what this repo already has.
- **Runner-up:** managed prompt registries (e.g. hosted prompt stores) — more tooling, useful at scale, overkill for four prompts.

---

## Project exercises

### Build a dev-time prompt-drafting helper

- **Exercise ID:** C-meta-prompting (adapted) — generate a new agent prompt from a goal + the workspace schema.
- **What to build:** a standalone dev script (not on the request path) that takes a one-line goal and the workspace `{schema}` shape, calls a model with a meta-prompt that encodes the house anatomy (Role disclaiming other agents' jobs / Hard rules including the `project_id`-every-call and `at most N tool calls` rules / a method section / EQL reminders in this EQL flavor / an exact Output JSON shape or a prose directive / the `{schema}` placeholder), and writes a candidate `lib/agents/prompts/<name>.md` for human review. The script must NOT wire the prompt into runtime — it stops at producing a reviewable draft.
- **Why it earns its place:** demonstrates meta-prompting as authoring-time scaffolding (not runtime generation), forces you to encode the house anatomy from `01-anatomy.md`, and keeps the human review in the critical path.
- **Files to touch:** new `scripts/draft-prompt.ts` (dev tool); reference `lib/agents/prompts/diagnostic.md` as the anatomy template and `lib/mcp/schema.ts` for the `{schema}` shape; output to `lib/agents/prompts/`.
- **Done when:** running the script with a goal like "flag product pages with rising bounce" produces a draft `.md` with all six anatomy sections and the correct placeholders, and a human review pass turns it into a committable spec by removing hedging and verifying the EQL examples.
- **Estimated effort:** 1–4hr

### Add a spec-voice linter for the prompt files

- **Exercise ID:** C-meta-prompting (adapted, extension) — catch the hedging-drift failure mode mechanically.
- **What to build:** a small check (script or test) that scans `lib/agents/prompts/*.md` for soft-rule hedging words ("try to", "where possible", "if appropriate", "you may want to") and fails if a Hard-rules or CRITICAL section contains one — catching the exact register a generated draft drifts toward.
- **Why it earns its place:** turns the "reads like LLM output" failure mode into an automated gate, so a generated draft (or any edit) cannot silently soften a load-bearing rule.
- **Files to touch:** new `scripts/lint-prompts.ts` or `test/agents/prompts.test.ts`; scans `lib/agents/prompts/*.md`.
- **Done when:** the linter passes on the current four hand-written prompts and fails if a Hard-rule line is rewritten with a hedging phrase.
- **Estimated effort:** <1hr

---

## Summary

Meta-prompting uses a model to draft or improve the prompts you feed other model calls, at *authoring* time, not runtime: human writes a goal plus context, model drafts, human reviews and edits, the edited prompt enters the repo. It is leverage on the initial draft of a complex prompt and a tax on small tweaks and high-iteration prompts, and its load-bearing step is the human review — because a generated draft defaults to hedged, padded prose, and a prompt only enforces rules it states as imperatives. blooming insights does none of this; its four prompts are hand-written `.md` specs loaded verbatim, which is exactly why they read like specs and why every rule is an absolute.

**Key points:**
- Meta-prompting acts at authoring time; the runtime path (`readFileSync` → `runAgentLoop`) never sees the meta-prompt.
- It saves real time on the 0→70% draft of a complex prompt and loses time on small tweaks and hourly eval-driven iteration.
- The meta-prompt must encode the house anatomy (→ 01) or it drafts a generic prompt that ignores `{schema}`, the tool-call budget, and the JSON shape.
- The failure mode is hedging drift: "try to" / "where possible" where the spec needs "Never" / "no exceptions"; review must convert soft rules to imperatives.
- Generated drafts can invent unsupported EQL syntax (the `customers matching` trap, `diagnostic.md` L35) — only a domain reviewer catches it.
- Automated prompt optimization (APE/DSPy/OPRO) is the next step but presupposes the eval harness (→ 05) that does not exist yet.

---

## Interview defense

### What an interviewer is really asking

"Have you used a model to write your prompts?" tests whether you treat meta-prompting as a magic button or as authoring-time scaffolding with a mandatory review step. The senior signal is naming where it saves time (complex first drafts) versus where it doesn't (tweaks, high-iteration), and identifying the hedging-drift failure mode that makes the review non-optional.

### Likely questions

**[mid] "Would you have a model generate these agent prompts?"**

For the initial draft of a new complex one, yes — describe the goal, hand it the workspace schema, and let it scaffold the anatomy (Role / Hard rules / EQL reminders / Output schema). But it's authoring-time, not runtime: the output is a `.md` file that goes into `lib/agents/prompts/` and gets reviewed exactly like the hand-written four. For a one-line tweak like changing `monitoring.md`'s tool-call budget, no — editing the line is faster than a round-trip.

```
new complex prompt → draft with model → review → commit  ✓
one-line tweak      → edit the line directly             ✗ (gen is overhead)
```

**[senior] "What's the failure mode of a generated prompt, and how do you prevent it?"**

Hedging drift. A draft defaults to the model's polite register — "try to be efficient," "be careful to consider" — and a prompt with soft rules has soft enforcement. The reason `monitoring.md`'s "Never report a change derived from an empty window" works is that it's an absolute, not a suggestion. Prevention is the review step: convert every soft rule to an imperative, cut the padding, and verify domain content like EQL syntax (the draft will happily invent unsupported clauses).

```
draft: "try to avoid empty windows"   → model treats as optional
spec:  "Never report ... empty window" → model treats as a hard rule
review's job: drag the draft to spec voice
```

**[arch] "When does meta-prompting become automated prompt optimization, and what does it require?"**

When you replace the human reviewer's taste with a measured score. APE/DSPy/OPRO generate candidate prompts and rank them against a metric — which requires an eval harness (→ 05) that blooming insights doesn't have yet. Without evals you can only do human-in-the-loop drafting; with evals you can close the loop and optimize prompts against the golden set instead of by judgment.

```
no evals → human-in-the-loop drafting (taste)
with evals → automated optimization (score candidates) — APE/DSPy/OPRO
```

### The question candidates always dodge

**"If a model wrote your prompt, how would you know it's any good?"** You review it as a spec and — ideally — score it against evals; candidates dodge because "the model wrote it and it looks fine" feels sufficient. A generated draft that reads fluently can hedge load-bearing rules into optionality and embed plausible-but-wrong EQL. "Looks fine" is the trap. The honest answer: human review for spec voice and domain correctness now, eval scoring once the harness exists.

### One-line anchors

- `lib/agents/prompts/diagnostic.md` — hand-written 85-line spec; the anatomy a meta-prompt must encode.
- `lib/agents/diagnostic.ts` L13 — `readFileSync` of the static prompt; runtime never generates.
- `lib/agents/prompts/monitoring.md` L31 — "Never report a change derived from an empty window": the absolute a draft would soften.
- `lib/agents/prompts/diagnostic.md` L35 — unsupported `customers matching`: the domain content only a reviewer catches.
- Zhou et al. 2022 (APE); DSPy / OPRO — automated optimization, presupposes evals.

---

## Validate

### Level 1 — Reconstruct

From memory, draw the meta-prompting pipeline: goal + context → meta-prompt → draft → human review → committed `.md`. Mark which step is authoring-time vs runtime, and circle the step that is non-optional (human review).

### Level 2 — Explain

Out loud: why does the runtime path in `lib/agents/diagnostic.ts` (L13, `readFileSync`) stay completely unchanged when a prompt is meta-prompted? What is the only difference between a generated prompt file and a hand-written one once both are committed?

### Level 3 — Apply

Scenario: you meta-prompt a new "page-performance" agent prompt and the draft says "try to keep your tool usage reasonable." Compare it to `monitoring.md` L11 ("Make at most 6 tool calls total, then stop"). State why the draft's phrasing is a failure (the model reads "reasonable" as optional), and rewrite it into spec voice.

### Level 4 — Defend

A reviewer says: "Just have the model generate all our prompts going forward." State where generation saves time (complex first drafts) versus where it's overhead (tweaks, hourly eval-driven prompts), name the hedging-drift failure mode and the EQL-invention risk (`diagnostic.md` L35), and explain why human review stays in the critical path until an eval harness (→ 05) can score candidates instead.

### Quick check — code reference test

If a meta-prompting helper produced a new agent prompt, what would have to be true about its placeholders for the existing loader to use it unchanged? (Answer: it must contain the `{schema}` and `{project_id}` placeholders the loader replaces — e.g. `lib/agents/diagnostic.ts` L45–48 does `PROMPT.replace('{schema}', …).replace(/\{project_id\}/g, …)` — plus any agent-specific placeholder like `{anomaly}`; without them the replace calls leave literal placeholder text in the system prompt.)

---
Updated: 2026-05-29 — Added a note distinguishing the new `{categories}` injection (dynamic prompt assembly / template interpolation, → 03-prompts-as-code.md) from meta-prompting; Case B verdict unchanged.
Updated: 2026-05-29 — Resynced the stale `diagnostic.md` "customers matching" ban ref L33→L35 (pre-existing drift) across all three citations.
