# Anatomy of a production prompt

**Industry name(s):** prompt anatomy, system-prompt structure, prompt templating, role/instruction/output decomposition
**Type:** Industry standard · Language-agnostic

> All four blooming insights prompts share one skeleton — Role → Hard rules → method → EQL reminders → Output → `{schema}` — where the `.md` file is a constant system prompt and the per-call payload (`{project_id}`, `{anomaly}`, `{diagnosis}`, `{intent}`, the `userPrompt`) is injected at runtime, and the `synthesisInstruction` is appended dead last on the forced-final turn.


---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Prompt anatomy lives squarely inside the Per-agent definitions band — the layer where each agent's system prompt is assembled before `runAgentLoop` ever sees it. The `.md` file is loaded at module import in the agent class; the per-call `.replace` chain runs right above the loop; the synthesis append happens one band lower, inside `base.ts`. So when you ask "what does the model actually read this turn?" you are looking at three sites that span the boundary between Per-agent definitions and the Shared agent loop.

```
  Zoom out — where prompt anatomy lives

  ┌─ Pipeline coordinator ──────────────────────────┐
  │  monitoring → diagnostic → recommendation        │
  └─────────────────────────┬────────────────────────┘
                            │  per-agent
  ┌─ Per-agent definitions ─▼────────────────────────┐  ← we are here
  │  ★ .md file (Layer 1) + .replace (Layer 2) ★    │
  │  lib/agents/prompts/*.md   monitoring.ts L12     │
  └─────────────────────────┬────────────────────────┘
                            │  system string
  ┌─ Shared agent loop ─────▼────────────────────────┐
  │  ★ synthesis append (Layer 3) ★  base.ts L96–98 │
  └─────────────────────────┬────────────────────────┘
                            │
  ┌─ Provider ──────────────▼────────────────────────┐
  │  anthropic.messages.create  (sees assembled bytes)│
  └──────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question is: when you open `diagnostic.md`, which lines are the same on every call, which get stamped in at runtime, and which only show up on the final turn? Anatomy answers that by naming three time-layers — the constant `.md` file, per-call `.replace` injection, and the synthesis append on the forced-final turn — so every line you can point at traces to exactly one layer. Below, you'll see the six shared sections, the closed placeholder set, and why the synthesis string lives in code rather than in the `.md`.

---

## Structure pass

**Layers.** Prompt anatomy is a four-layer stack and you have to keep them straight or you'll spend an hour staring at the wrong file. Layer A is the *constant markdown* (`monitoring.md` etc.) — bytes committed once, loaded at import, never mutated. Layer B is the *per-call `.replace` chain* in each agent class — the stamping that turns `{schema}` / `{project_id}` / `{anomaly}` into real values. Layer C is the *forced-final-turn synthesis append* inside the shared loop — a string glued onto the system on exactly one turn. Layer D is the *assembled bytes the model reads* — what `anthropic.messages.create` actually sees. A → B → C → D, and "the prompt" is a different thing at each layer.

**Axis: control.** Who decides what goes into the system string at each layer? This is the right axis because the bug class this concept exists to make legible is "a value showed up in the model's context that I didn't expect, and I can't tell who put it there." Cost is irrelevant (these layers cost nothing to assemble); state-ownership is downstream of control. Trace control across A→D and the seams pop: an author decides the constant, code decides the injection, the loop decides the synthesis append, the model decides nothing about its own system prompt.

**Seams.** Two seams matter, one load-bearing. Seam 1 is between A and B — control flips from *human-at-PR-review-time* to *code-at-request-time*. That's where `{project_id}` becomes the real id; if the `.replace` is wrong (single-replace where global was needed) the model reads a literal `{project_id}` brace string and dutifully passes it as a tool argument. I've watched that exact bug ship. Seam 2 is the load-bearing one: between B and C — control flips from *per-call stamping* (happens every turn) to *forced-final-turn appending* (happens on exactly one turn, with tools removed). This is the seam where the model's instructions change *mid-loop*, and it's why "the prompt" answered for a normal turn is a different string than "the prompt" answered for the synthesis turn. Get this seam wrong (e.g. always-appending the synthesis) and the model stops querying after turn one.

```
  Structure pass — prompt anatomy

  ┌─ 1. LAYERS ───────────────────────────────────┐
  │  A: constant .md (Role/Hard rules/Output/…)    │
  │  B: per-call .replace chain (agent class)      │
  │  C: forced-final-turn synthesis append (loop)  │
  │  D: assembled bytes (provider.create sees)     │
  └────────────────────────┬───────────────────────┘
                           │  pick the axis
  ┌─ 2. AXIS ─────────────▼────────────────────────┐
  │  control: who decides what enters the system   │
  │  string at each layer?                          │
  └────────────────────────┬───────────────────────┘
                           │  trace A→D, find flips
  ┌─ 3. SEAMS ────────────▼────────────────────────┐
  │  S1 (A↔B): author-at-review → code-at-request  │
  │  S2 (B↔C): every-turn stamping → one-turn      │
  │            append (load-bearing)                │
  └────────────────────────┬───────────────────────┘
                           ▼
                   Block 4 — How it works
```

```
  A seam — "who decides what's in the system string THIS turn?" answered two ways

  ┌─ Layer B ────────┐    seam     ┌─ Layer C ────────────┐
  │  stamping runs   │ ═════╪═════► │  synthesis append    │
  │  on EVERY turn   │  (it flips) │  runs on ONE turn,   │
  │  with tools on   │             │  tools REMOVED       │
  └──────────────────┘             └──────────────────────┘
         ▲                                   ▲
         └────── same axis, two answers ─────┘
                 → this boundary changes what the model reads mid-loop
```

The skeleton is mapped — the rest of this file walks the mechanics that hang off it.

## How it works

**Mental model.** Three layers stacked in time. Layer 1 is the versioned markdown prompt file — loaded once at module load, never mutated, the same bytes for every investigation. Layer 2 is per-call injection — a string-replace chain stamps the runtime values into the placeholders right before the call. Layer 3 is the forced-final-turn append — a synthesis instruction glued onto the end of the system string only on the turn where the model must stop and answer. Read top to bottom, the model sees one coherent system prompt; read by *origin*, every line traces to exactly one of those three layers.

```
LAYER 1  constant markdown file   loaded once at import
   ## Role · ## Hard rules · method · ## EQL reminders · ## Output · {schema}
            │
LAYER 2  per-call replace chain   stamped per investigation
   {project_id} → real id   {anomaly} → JSON   {schema} → schema summary
            │
LAYER 3  synthesis append         forced-final turn ONLY
   system + "\n\n" + synthesis_instruction
            │
            ▼
   the system prompt the model actually receives this turn
```

The first two layers are stable across the run; the third changes the system prompt on exactly one turn. That time-layering is the whole anatomy.

---

### The six shared sections

Every prompt file is the same six blocks in the same order. This is not a coincidence — it is a template the team holds in its head, and it makes a new agent prompt a fill-in-the-blanks exercise.

```
## Role               who you are, ONE job, disclaimers of the others' jobs
## Hard rules         non-negotiables: project_id on every call, ≤N calls
<method section>      how to do the job ("Period-over-period method",
                      "Investigation approach", "How to propose", "Framing")
## EQL reminders      worked query syntax exemplars (format few-shot)
## Output             exact shape + field rules + a concrete example
## Workspace schema   {schema}   ← the injected data dictionary
```

You can lay the four prompt files side by side and the headings line up. The monitoring prompt is Role / Hard rules / method / EQL reminders / Output / schema — note it carries an extra section the other three don't: `## Your category checklist`, with a `{categories}` slot (covered below). The diagnostic prompt is the same six-section skeleton. The recommendation prompt swaps EQL reminders for an "Available tools" list. The query prompt has the same six, with its Output section saying the opposite of the other three (more on that in → 07-output-mode-mismatch.md).

---

### The one structural exception: monitoring's `## Your category checklist`

The monitoring prompt is not a clean instance of the six-section skeleton. Between `## Role` and `## Hard rules` it has a seventh section the other three prompts don't:

```
## Your category checklist
  "Check each of these — and only these…"
  {categories}                       ← per-call injection slot
```

This matters for two reasons. First, it is a *fourth* per-call injection placeholder, sitting alongside `{schema}`, `{project_id}`, and the per-agent anomaly/diagnosis/intent injections — bringing the monitoring agent's runtime-stamped slots to `{schema}` + `{project_id}` + `{categories}`. Second, `{categories}` is unlike the others: `{schema}` is the same data dictionary for every agent and `{project_id}` is a single id, but `{categories}` is a *runtime-assembled checklist string* — the monitoring agent builds it from the anomaly-category list passed into its scan method and stamps it in with a string replace, right next to the existing `{schema}` and `{project_id}` replacements. The categories it receives are the schema-runnable subset: the briefing route handler computes the runnable categories from schema capabilities and passes that list into the scan call. So the section's *body* is data — only the anomaly categories this workspace's events can support — assembled at call time and dropped into a fixed slot. (The gate that decides which categories are runnable is its own topic — → ../study-ai-engineering/04-agents-and-tool-use/07-capability-gating.md.)

The takeaway for anatomy: do not assume all four prompts are the identical six-section shape. Three are; monitoring is six sections **plus** a checklist section whose content is injected per call. When you grep the placeholder set, `{categories}` is the one that's monitoring-only and the one whose value is computed, not constant.

---

### The decomposition rule: every Role disclaims the others

Here is the part that separates this from a generic template. Each `## Role` does not just say what the agent does — it explicitly says what it does *not* do, naming the other agents' jobs:

```
monitoring prompt      "You do not diagnose causes. You do not propose actions."
diagnostic prompt      "You do not propose remediation — you diagnose causes only."
recommendation prompt  "you do NOT execute anything"
query prompt           "Never invent numbers — only cite figures you genuinely observed"
```

This is decomposition encoded *in prose*. The model has no view of the orchestration in the route handler — it cannot know that a separate recommendation agent runs after it. So the monitoring prompt tells it directly: stay in your lane, someone else handles causes. Without the disclaimer, the monitoring agent helpfully diagnoses and recommends in one breath, and now two agents produce overlapping output and the chain's clean handoff (→ 06-single-purpose-chains.md) collapses. I have shipped multi-agent systems where exactly this happened: the "detect" agent started proposing fixes because nothing told it not to, and the downstream "fix" agent's output became redundant noise. The one-line disclaimer is the fix, and it lives in the prompt because that is the only place the model can read it.

---

### Layer 2 — per-call injection via string replace

The injection is mechanically dumb and that is a feature. Each agent runs a short chain of replace calls right before the loop:

```
  system = PROMPT
    .replace("{schema}",     schema_summary(schema))
    .replace(/{project_id}/g, schema.project_id)   # global — appears many times
    .replace("{anomaly}",    serialize(anomaly))
```

```
placeholder      injected by                  appears in
─────────────    ──────────────────────────   ────────────────────────────
{schema}         schema summary                all four
{project_id}     project id (global replace)   all four (every Hard rules block)
{anomaly}        serialized anomaly object     diagnostic only
{diagnosis}      serialized diagnosis object   recommendation only
{intent}         the classified label          query only
{categories}     runtime-built checklist str   monitoring only
user prompt      a fixed per-agent string      passed separately, NOT in the markdown
```

Two details worth internalizing. First, `{project_id}` uses a global-replace regex because "Pass `project_id` to every tool call" appears once but the value must replace every literal occurrence — the team got bitten by single-replace leaving a stray `{project_id}` in the text, which the model then dutifully passed *as a literal string* to a tool. Second, the user prompt is **not** in the markdown file at all. It is a separate argument to the shared agent loop and becomes the first user message. System = the constant markdown; user = the per-call task. That is the system-vs-user boundary made concrete: constant-vs-per-call.

---

### Layer 3 — the synthesis instruction, appended last

The `## Output` section already tells the model what shape to emit. So why a second instruction? Because the model, mid-investigation, keeps wanting to query — it reads "Output" as "eventually" not "now." On the forced-final turn the loop appends a hard stop:

```
  if force_final AND synthesis_instruction:
      system = system + "\n\n" + synthesis_instruction   # ← appended, last thing read
  else:
      system = system
```

```
normal turn:        [ Role … Output … {schema} ]                tools available
forced-final turn:  [ Role … Output … {schema} ] + [ synthesis ] tools REMOVED
```

The synthesis text is defined per agent inside the per-agent definitions and says, in effect, "You have NO more tool calls. Output ONLY the JSON now." Appending it *last* exploits recency — the final instruction the model reads is the one it weights hardest. This is a fourth structural slot, but it only exists on one turn, which is why it is not a section in the markdown file.

---

### The principle

A production prompt is layered in time, not just in sections. The markdown file is a constant you can version and diff; the placeholders are a closed set you can grep; the synthesis nudge is a single appended string you can change in one place. The discipline is: keep the constant constant, keep the variable visibly injected, and never let a runtime value hide inside the markdown. When all three layers are legible, "the prompt broke" becomes a question with a fast answer — which layer.

---

## Anatomy of a production prompt — diagram

This diagram spans three time-layers. Layer 1 is the constant file (shared shape, four instances). Layer 2 is the per-call stamping. Layer 3 is the forced-final append. A reader who sees only this should grasp that the system prompt is assembled, not authored, and that each line traces to exactly one layer.

```
┌──────────────────────────────────────────────────────────────────────┐
│  LAYER 1 — CONSTANT MARKDOWN FILE   (loaded at module import)         │
│                                                                       │
│   ## Role          ← ONE job + disclaims the other agents' jobs       │
│   ## Hard rules    ← project_id every call · ≤N tool calls            │
│   <method>         ← Period-over-period / Investigation / How to      │
│   ## EQL reminders ← worked query syntax (format exemplars)           │
│   ## Output        ← exact JSON shape + field rules + example         │
│   ## Workspace schema                                                 │
│       {schema}  {project_id}  {anomaly}/{diagnosis}/{intent}          │
└───────────────────────────┬───────────────────────────────────────────┘
                            │  string replace per call
┌───────────────────────────▼───────────────────────────────────────────┐
│  LAYER 2 — PER-CALL INJECTION                                         │
│   {schema}→schema_summary  {project_id}→id (global)  {anomaly}→JSON   │
│   user prompt → SEPARATE first user message                           │
│   = the run-stable system string                                      │
└───────────────────────────┬───────────────────────────────────────────┘
                            │  forced-final turn only
┌───────────────────────────▼───────────────────────────────────────────┐
│  LAYER 3 — SYNTHESIS APPEND                                           │
│   system + "\n\n" + synthesis_instruction    + tools removed          │
│   = the system prompt the model receives THIS turn                    │
└──────────────────────────────────────────────────────────────────────┘

  system = constant (markdown) + per-call injection.  user = the per-call task.
  Constant-vs-per-call IS the system-vs-user split.
```

The shape is authored once; the bytes the model receives are assembled per turn from three layers, and every line you can point at belongs to exactly one of them.

---

## Implementation in codebase

**Case A — implemented (richly).**

### The shared anatomy (the four prompt files)

- **File:** `lib/agents/prompts/{monitoring,diagnostic,recommendation,query}.md`
- **Function / class:** the prompt source itself (the constant Layer 1)
- **Line range:** Role at L3–5 in all four; Hard rules at `monitoring.md` L13 (pushed down by its extra `## Your category checklist` section at L7) / L7 in the other three; method at `monitoring.md` L20 / `diagnostic.md` L18 / `recommendation.md` L29 / `query.md` L13; EQL reminders at `monitoring.md` L49 / `diagnostic.md` L27 / `query.md` L23 (recommendation swaps in "Available tools" L15); Output at `monitoring.md` L69 / `diagnostic.md` L59 / `recommendation.md` L47 / `query.md` L47; `{schema}` at `monitoring.md` L101 / `diagnostic.md` L105 / `recommendation.md` L93 / `query.md` L53.
- **Role:** the constant system prompt, one job per file, each Role disclaiming the others (`monitoring.md` L5, `diagnostic.md` L5, `recommendation.md` L5). `monitoring.md` alone carries a seventh section — `## Your category checklist` (L7) with a `{categories}` injection slot (L11) — making it the one prompt that isn't a clean six-section instance.

### Layer 2 — per-call injection

- **File:** `lib/agents/{monitoring,diagnostic,recommendation,query}.ts`
- **Function / class:** the `.replace` chain that builds `system` before `runAgentLoop`
- **Line range:** `monitoring.ts` L83–86 (`{schema}`, `{project_id}`, and `{categories}` — the runtime checklist built at L69–86); `diagnostic.ts` L45–48 (adds `{anomaly}`); `recommendation.ts` L41–44 (adds `{diagnosis}`); `query.ts` L25–28 (adds `{intent}`). `userPrompt` passed separately: `monitoring.ts` L93, `diagnostic.ts` L56, `recommendation.ts` L51, `query.ts` L35 (the raw `query`).
- **Role:** stamps runtime values into the closed placeholder set; keeps `userPrompt` out of the `.md`.

### Layer 3 — synthesis append

- **File:** `lib/agents/base.ts`
- **Function / class:** `runAgentLoop` forced-final-turn system assembly
- **Line range:** L96–98 (`${system}\n\n${synthesisInstruction}`); tools removed at L101; per-agent synthesis text at `monitoring.ts` L75–78, `diagnostic.ts` L62–66, `recommendation.ts` L58–62, `query.ts` L42–44.
- **Role:** appends the hard-stop instruction last, on the one turn the model must answer.

### Why this is a codebase strength

The anatomy is uniform enough that adding an agent is mechanical: copy the six sections, write the disclaimer, add the placeholder, wire one `.replace`. The placeholder set is closed and greppable (`grep -rn '{[a-z_]*}' lib/agents/prompts`), so you can audit injection coverage. And the system-vs-user boundary is enforced by code, not convention: the constant is a file, the per-call task is a function argument.

---

## Elaborate

### Where this comes from

The Role / instructions / output / context layout is the spine of every published prompt guide — Anthropic's prompt-engineering docs lead with "give Claude a role" and "be clear and direct," and the OpenAI cookbook's structured-prompt examples follow the same Role→Task→Format→Context order. The placeholder-injection-into-a-constant idea is older than LLMs: it is server-side templating (a constant template, per-request data) re-pointed at a string a model reads. What blooming insights adds is the third time-layer — the synthesis append — which is specific to agentic loops where the model otherwise never stops to produce the final artifact.

### The deeper principle

```
authored once          assembled per turn
─────────────────      ─────────────────────────────
the .md skeleton       constant + injection + synthesis
human reads/diffs it   the model reads the assembly
1 file, 6 sections     3 layers, traceable per line
```

The skeleton is for humans (review, diff, reuse); the assembly is for the model. Keeping them separate — never hand-editing the assembled string, always editing the `.md` — is what makes the prompt a maintainable artifact instead of a string literal someone is afraid to touch.

### Where this breaks down

1. **`String.replace` is positional and silent.** `.replace('{anomaly}', …)` replaces the first occurrence only (non-regex). If `{anomaly}` ever appeared twice, the second would survive as a literal and the model would read the brace text. The `/g` flag on `{project_id}` exists precisely because that bug bit once.
2. **The disclaimer is advisory, not enforced.** "You do not propose actions" is a request the model honors statistically. A model upgrade can soften that adherence; nothing in the code stops the monitoring agent from emitting a recommendation if the model decides to. Enforcement happens later, at the validator boundary (→ 02-structured-outputs.md).
3. **The synthesis append duplicates the Output section.** The shape is now stated twice — once in `## Output`, once in the synthesis string. Drift between them (you update one, forget the other) produces a model that gets conflicting format instructions on the final turn.

### What to explore next

- **Typed templating:** replace the `.replace` chain with a function that takes a typed payload and fails loudly on a missing placeholder, so a stray `{intent}` can never reach the model.
- **A single shared header:** factor the identical Hard-rules lines (`project_id` every call, ≤N tool calls) into one included fragment so the four files can't drift on the non-negotiables.
- **Prompt linting:** a test that asserts every `{placeholder}` in each `.md` has a matching `.replace` in its agent (→ 03-prompts-as-code.md).

---

## Project exercises

### Add a placeholder-coverage test

- **Exercise ID:** C1.7 (adapted) — prompt anatomy / template integrity.
- **What to build:** a Vitest test that reads each `lib/agents/prompts/*.md`, extracts every `{placeholder}`, and asserts each one is replaced by its agent's `.replace` chain — so a new prompt with an un-injected `{foo}` fails CI instead of reaching the model.
- **Why it earns its place:** turns the closed-placeholder-set property from a convention into an enforced invariant; catches the literal-brace bug class.
- **Files to touch:** new `test/agents/prompt-anatomy.test.ts`; reads `lib/agents/prompts/*.md` and imports the four agent modules.
- **Done when:** the test passes for all four current prompts and fails if you add `{unfilled}` to any `.md`.
- **Estimated effort:** 1–4hr

### Factor the shared Hard-rules header into one fragment

- **Exercise ID:** C1.7 (adapted) — DRY the constant layer.
- **What to build:** extract the identical Hard-rules lines ("Pass `project_id` to every tool call", the ≤N-tool-calls stop) into a single `lib/agents/prompts/_hard-rules.md` fragment and compose it into each prompt at load time, so the non-negotiables can't drift between the four files.
- **Why it earns its place:** removes the highest-risk drift surface (the rules that bound blast radius) while keeping per-agent specifics in their own files.
- **Files to touch:** new `lib/agents/prompts/_hard-rules.md`; the four agent `.ts` files (compose at `readFileSync`); the four prompt `.md` files (remove the duplicated lines).
- **Done when:** changing the `project_id` rule in one place changes it for all four agents, and existing agent tests still pass.
- **Estimated effort:** 1–4hr

---

## Interview defense

### What an interviewer is really asking

"Walk me through how a prompt is structured in your system" tests whether you see a prompt as one blob or as layered, traceable artifact. The senior signal is naming the constant-vs-per-call split, pointing at the closed placeholder set, and explaining the third time-layer (the synthesis append) that agentic loops need and single-shot prompts don't.

### Likely questions

**[mid] "Which parts of `diagnostic.md` are the same on every call, and which change?"**

The whole `.md` body is constant — Role, Hard rules, Investigation approach, EQL reminders, Output, schema heading. What changes is what gets stamped into the placeholders: `{schema}` (the workspace summary), `{project_id}`, and `{anomaly}` (the specific anomaly as JSON), all via `.replace` at `diagnostic.ts` L45–48.

```
constant: ## Role … ## Output           (file bytes)
per-call: {schema} {project_id} {anomaly}  (.replace L45–48)
```

**[senior] "How does the system-vs-user message boundary map to your prompt anatomy?"**

System is the constant `.md` (`base.ts` L98); user is the per-call task string (`base.ts` L80). They are the same distinction viewed two ways: constant-vs-per-call and system-vs-user. The `.md` carries the stable instructions and the injected data dictionary; the user message carries the specific request ("Investigate the anomaly…"). Keeping the constant in `system` is also what would make prefix caching possible.

```
system  = constant .md  (+ injected values)   ← stable across the run
user    = "Investigate the anomaly…"          ← the per-call task
```

**[arch] "You already have an `## Output` section. Why append a second format instruction at the end?"**

Because in an agentic loop the model reads `## Output` as "eventually" and keeps querying. On the forced-final turn `base.ts` L96–98 appends `synthesisInstruction` last and removes tools (L101), so the final thing the model reads is "no more tools, output ONLY the JSON now." Recency weighting makes the last instruction dominant. It is a fourth structural slot that exists on exactly one turn, which is why it's in code, not the `.md`.

```
## Output (in .md)      = "this is the shape"     (read mid-loop as "later")
synthesis append (L98)  = "emit it NOW, no tools" (last thing read → wins)
```

### The question candidates always dodge

**"What stops the monitoring agent from also diagnosing and recommending?"** Only a sentence — "You do not diagnose causes. You do not propose actions." (`monitoring.md` L5). It is a prose disclaimer the model honors statistically, not an enforced boundary. Candidates dodge because admitting it concedes the decomposition is advisory. The honest answer: the disclaimer keeps roles separate *most* of the time; the actual enforcement that the monitoring output stays in-shape is the `isAnomalyArray` validator downstream, not the prompt.

### One-line anchors

- `lib/agents/prompts/monitoring.md` L5 — Role disclaims the other agents' jobs.
- `lib/agents/diagnostic.ts` L45–48 — per-call `.replace` injection, `/g` on `{project_id}`.
- `lib/agents/base.ts` L80 — `userPrompt` becomes the first user message (per-call task).
- `lib/agents/base.ts` L96–98 — `synthesisInstruction` appended last on the forced-final turn.
- placeholder set: `{schema}` `{project_id}` `{anomaly}` `{diagnosis}` `{intent}` `{categories}` — closed and greppable (`{categories}` is monitoring-only, injected as a runtime-built checklist).

---

## Validate

### Level 1 — Reconstruct

From memory, draw the three time-layers (constant `.md` → per-call injection → synthesis append) and list the six shared sections of the `.md` in order. Name which placeholder is unique to each of the diagnostic, recommendation, and query agents.

### Level 2 — Explain

Out loud: why is `{project_id}` replaced with the global regex `/\{project_id\}/g` (`diagnostic.ts` L47) while `{anomaly}` uses a plain string replace (L48)? What bug does the `/g` prevent, and when would it matter for `{anomaly}`?

### Level 3 — Apply

Scenario: you're adding a fifth agent — a "forecasting" agent that needs a `{horizon}` value injected. Using `diagnostic.ts` L45–48 as the template, write the `.replace` chain, decide which of the six sections the forecasting-specific method goes in, and write the one-line Role disclaimer that keeps it from stepping on the monitoring agent's job.

### Level 4 — Defend

A reviewer says: "Just inline the synthesis instruction into each prompt's `## Output` section — one less moving part." State what that costs (the model reads it mid-loop as "later," not "now"; you lose the tools-removed + recency-last effect of `base.ts` L96–101), and the condition under which inlining would actually be fine (a single-shot, non-agentic prompt with no tool loop).

### Quick check — code reference test

In `lib/agents/base.ts`, what exactly is the `system` value on the forced-final turn, and what else changes on that turn? (Answer: `` `${system}\n\n${synthesisInstruction}` `` at L98 when `forceFinal && synthesisInstruction`; additionally `params.tools` is *not* set at L101, removing the tools so the model must produce a final answer.)

## See also

→ 02-structured-outputs.md · → 03-prompts-as-code.md · → 06-single-purpose-chains.md · → 07-output-mode-mismatch.md

---
Updated: 2026-05-29 — Corrected stale monitoring.md section line refs (Role L3 / Hard rules L13 / method L20 / EQL reminders L49 / Output L69 / schema L99) and added the `## Your category checklist` section (L7, `{categories}` slot L11) as monitoring's seventh section and a 4th per-call injection placeholder (`monitoring.ts` L69–86).
Updated: 2026-05-30 — Migrated to study.md v1.47 template (Phase 1+2 mechanical): removed Tradeoffs / Tech reference / Summary sections; renamed "In this codebase" → "Implementation in codebase"; moved See also to a bottom block. "Why care" preserved pending Phase 3 (Zoom out, then zoom in + LAYERS diagram) authoring.
Updated: 2026-05-30 — Phase 3 of study.md v1.47 migration: replaced "Why care" block with "Zoom out, then zoom in" (LAYERS diagram + zoom-in paragraph) per format.md.
Updated: 2026-05-31 — Applied study.md v1.48: scrubbed "How it works" of file paths, line refs, and real-code fences; replaced with generic role labels + pseudocode per format.md. Codebase-specific anchoring lives exclusively in "Implementation in codebase".
Updated: 2026-05-31 — Applied study.md v1.50: added Structure pass block (layers · axis · seams) between Zoom out and How it works per format.md's new Block 3.
