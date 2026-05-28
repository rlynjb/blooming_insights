# Anatomy of a production prompt

**Industry name(s):** prompt anatomy, system-prompt structure, prompt templating, role/instruction/output decomposition
**Type:** Industry standard · Language-agnostic

> All four blooming insights prompts share one skeleton — Role → Hard rules → method → EQL reminders → Output → `{schema}` — where the `.md` file is a constant system prompt and the per-call payload (`{project_id}`, `{anomaly}`, `{diagnosis}`, `{intent}`, the `userPrompt`) is injected at runtime, and the `synthesisInstruction` is appended dead last on the forced-final turn.

**See also:** → 02-structured-outputs.md · → 03-prompts-as-code.md · → 06-single-purpose-chains.md · → 07-output-mode-mismatch.md

---

## Why care

You have a form component that renders the same way every time and a payload that fills its fields per request — the markup is fixed, the data is variable, and you do not regenerate the markup on every keystroke. A production prompt is that exact split. The `.md` file is the fixed markup; `{project_id}` / `{anomaly}` / `{diagnosis}` / `{intent}` and the `userPrompt` are the per-request fields. Get the split wrong — bake the variable into the constant, or scatter the constant across call-sites — and you lose the one thing that makes a prompt debuggable: a stable thing to diff against.

The question this file answers: when you open `lib/agents/prompts/diagnostic.md`, what are you actually looking at, which parts are the same on every call, and which parts get stamped in at runtime?

**The pivot: a production prompt is not one blob — it is a constant system file plus per-call injection plus a last-second synthesis nudge, and knowing which layer a given line lives in is what lets you change behavior without breaking three other things.** When a diagnosis comes back malformed, the first question is "did the constant change or did the injected payload change?" If you can't answer that instantly, you don't have a prompt — you have a string you're afraid of.

Before you see the anatomy:
- "The prompt" is a vague monolith; a regression could be anywhere
- You can't tell whether `{anomaly}` arrived malformed or the Role drifted
- Adding a fourth agent means copy-pasting an undocumented shape and hoping

After:
- Six named sections, same order in all four files — you read the new one in 30 seconds
- The injected placeholders are a closed set you can grep for: `{schema}`, `{project_id}`, `{anomaly}`, `{diagnosis}`, `{intent}`
- The synthesis nudge is in one place (`base.ts` L98), not smeared into every prompt

It is the markup-vs-data discipline, applied to a string the model reads instead of a browser.

---

## How it works

**Mental model.** Three layers stacked in time. Layer 1 is the `.md` file — loaded once at module load, never mutated, the same bytes for every investigation. Layer 2 is per-call injection — `String.replace` stamps the runtime values into the placeholders right before the call. Layer 3 is the forced-final-turn append — `synthesisInstruction` glued onto the end of the system string only on the turn where the model must stop and answer. Read top to bottom, the model sees one coherent system prompt; read by *origin*, every line traces to exactly one of those three layers.

```
LAYER 1  constant .md file        loaded once at import   (monitoring.ts L12)
   ## Role · ## Hard rules · method · ## EQL reminders · ## Output · {schema}
            │
LAYER 2  per-call .replace()      stamped per investigation (diagnostic.ts L45–48)
   {project_id} → real id   {anomaly} → JSON   {schema} → schemaSummary()
            │
LAYER 3  synthesis append         forced-final turn ONLY    (base.ts L96–98)
   `${system}\n\n${synthesisInstruction}`
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

You can lay the four files side by side and the headings line up. `monitoring.md` L3/L7/L14/L43/L50/L75 are Role / Hard rules / method / EQL reminders / Output / schema. `diagnostic.md` L3/L7/L18/L26/L44/L83 is the same skeleton. `recommendation.md` L3/L7/L29/—/L44/L73 (it swaps EQL reminders for an "Available tools" list at L15). `query.md` L3/L7/L13/L23/L34/L38 — same six, with its Output section saying the opposite of the other three (more on that in → 07-output-mode-mismatch.md).

---

### The decomposition rule: every Role disclaims the others

Here is the part that separates this from a generic template. Each `## Role` does not just say what the agent does — it explicitly says what it does *not* do, naming the other agents' jobs:

```
monitoring.md L5      "You do not diagnose causes. You do not propose actions."
diagnostic.md  L5     "You do not propose remediation — you diagnose causes only."
recommendation.md L5  "you do NOT execute anything"
query.md       L5     "Never invent numbers — only cite figures you genuinely observed"
```

This is decomposition encoded *in prose*. The model has no view of the orchestration in `route.ts` — it cannot know that a separate recommendation agent runs after it. So the monitoring prompt tells it directly: stay in your lane, someone else handles causes. Without the disclaimer, the monitoring agent helpfully diagnoses and recommends in one breath, and now two agents produce overlapping output and the chain's clean handoff (→ 06-single-purpose-chains.md) collapses. I have shipped multi-agent systems where exactly this happened: the "detect" agent started proposing fixes because nothing told it not to, and the downstream "fix" agent's output became redundant noise. The one-line disclaimer is the fix, and it lives in the prompt because that is the only place the model can read it.

---

### Layer 2 — per-call injection via `String.replace`

The injection is mechanically dumb and that is a feature. Each agent runs a short chain of `.replace` calls right before the loop:

```
diagnostic.ts L45–48
  const system = PROMPT
    .replace('{schema}',      schemaSummary(this.schema))
    .replace(/\{project_id\}/g, this.schema.projectId)   // global — appears many times
    .replace('{anomaly}',     JSON.stringify(anomaly));
```

```
placeholder      injected by                  appears in
─────────────    ──────────────────────────   ────────────────────────────
{schema}         schemaSummary(schema)         all four
{project_id}     schema.projectId  (regex /g)  all four (every Hard rules block)
{anomaly}        JSON.stringify(anomaly)       diagnostic only  (L48)
{diagnosis}      JSON.stringify(diagnosis)     recommendation only (recommendation.ts L44)
{intent}         the classified label (/g)     query only  (query.ts L28)
userPrompt       a fixed per-agent string      passed separately, NOT in the .md
```

Two details worth internalizing. First, `{project_id}` uses the global regex `/\{project_id\}/g` because "Pass `project_id` to every tool call" appears once but the value must replace every literal occurrence — the team got bitten by single-replace leaving a stray `{project_id}` in the text, which the model then dutifully passed *as a literal string* to a tool. Second, `userPrompt` is **not** in the `.md` file at all. It is a separate argument to `runAgentLoop` (`monitoring.ts` L70: `'Scan the workspace…'`) and becomes the first `user` message (`base.ts` L80). System = the constant `.md`; user = the per-call task. That is the system-vs-user boundary made concrete: constant-vs-per-call.

---

### Layer 3 — the synthesis instruction, appended last

The `## Output` section already tells the model what shape to emit. So why a second instruction? Because the model, mid-investigation, keeps wanting to query — it reads "Output" as "eventually" not "now." On the forced-final turn the loop appends a hard stop:

```
base.ts L96–98
  system: forceFinal && synthesisInstruction
    ? `${system}\n\n${synthesisInstruction}`   // ← append, last thing the model reads
    : system,
```

```
normal turn:        [ Role … Output … {schema} ]                tools available
forced-final turn:  [ Role … Output … {schema} ] + [ synthesis ] tools REMOVED (base.ts L101)
```

The synthesis text is defined per agent (`monitoring.ts` L75–78, `diagnostic.ts` L62–66) and says, in effect, "You have NO more tool calls. Output ONLY the JSON now." Appending it *last* exploits recency — the final instruction the model reads is the one it weights hardest. This is a fourth structural slot, but it only exists on one turn, which is why it is not a section in the `.md` file.

---

### The principle

A production prompt is layered in time, not just in sections. The `.md` file is a constant you can version and diff; the placeholders are a closed set you can grep; the synthesis nudge is a single appended string you can change in one place. The discipline is: keep the constant constant, keep the variable visibly injected, and never let a runtime value hide inside the `.md`. When all three layers are legible, "the prompt broke" becomes a question with a fast answer — which layer.

---

## Anatomy of a production prompt — diagram

This diagram spans three time-layers. Layer 1 is the constant file (shared shape, four instances). Layer 2 is the per-call stamping. Layer 3 is the forced-final append. A reader who sees only this should grasp that the system prompt is assembled, not authored, and that each line traces to exactly one layer.

```
┌──────────────────────────────────────────────────────────────────────┐
│  LAYER 1 — CONSTANT .md FILE   (readFileSync at import, monitoring.ts L12) │
│                                                                       │
│   ## Role          ← ONE job + disclaims the other agents' jobs (L5)  │
│   ## Hard rules    ← project_id every call · ≤N tool calls           │
│   <method>         ← Period-over-period / Investigation / How to     │
│   ## EQL reminders ← worked query syntax (format exemplars)          │
│   ## Output        ← exact JSON shape + field rules + example         │
│   ## Workspace schema                                                │
│       {schema}  {project_id}  {anomaly}/{diagnosis}/{intent}         │
└───────────────────────────┬───────────────────────────────────────────┘
                            │  .replace() per call
┌───────────────────────────▼───────────────────────────────────────────┐
│  LAYER 2 — PER-CALL INJECTION   (diagnostic.ts L45–48)               │
│   {schema}→schemaSummary  {project_id}→id /g  {anomaly}→JSON          │
│   userPrompt → SEPARATE first user message (base.ts L80)             │
│   = the run-stable `system` string                                  │
└───────────────────────────┬───────────────────────────────────────────┘
                            │  forced-final turn only
┌───────────────────────────▼───────────────────────────────────────────┐
│  LAYER 3 — SYNTHESIS APPEND   (base.ts L96–98)                       │
│   `${system}\n\n${synthesisInstruction}`   + tools removed (L101)    │
│   = the system prompt the model receives THIS turn                   │
└──────────────────────────────────────────────────────────────────────┘

  system = constant (.md) + per-call injection.  user = the per-call task.
  Constant-vs-per-call IS the system-vs-user split.
```

The shape is authored once; the bytes the model receives are assembled per turn from three layers, and every line you can point at belongs to exactly one of them.

---

## In this codebase

**Case A — implemented (richly).**

### The shared anatomy (the four prompt files)

- **File:** `lib/agents/prompts/{monitoring,diagnostic,recommendation,query}.md`
- **Function / class:** the prompt source itself (the constant Layer 1)
- **Line range:** Role at L3–5 in all four; Hard rules at L7 in all four; method at `monitoring.md` L14 / `diagnostic.md` L18 / `recommendation.md` L29 / `query.md` L13; EQL reminders at `monitoring.md` L43 / `diagnostic.md` L26 / `query.md` L23 (recommendation swaps in "Available tools" L15); Output at `monitoring.md` L50 / `diagnostic.md` L44 / `recommendation.md` L44 / `query.md` L34; `{schema}` at `monitoring.md` L77 / `diagnostic.md` L85 / `recommendation.md` L75 / `query.md` L40.
- **Role:** the constant system prompt, one job per file, each Role disclaiming the others (`monitoring.md` L5, `diagnostic.md` L5, `recommendation.md` L5).

### Layer 2 — per-call injection

- **File:** `lib/agents/{monitoring,diagnostic,recommendation,query}.ts`
- **Function / class:** the `.replace` chain that builds `system` before `runAgentLoop`
- **Line range:** `monitoring.ts` L61–63 (`{schema}`, `{project_id}`); `diagnostic.ts` L45–48 (adds `{anomaly}`); `recommendation.ts` L41–44 (adds `{diagnosis}`); `query.ts` L25–28 (adds `{intent}`). `userPrompt` passed separately: `monitoring.ts` L70, `diagnostic.ts` L55, `recommendation.ts` L51, `query.ts` L35 (the raw `query`).
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

## Tradeoffs

### One uniform `.md` skeleton vs. bespoke per-agent prompts

| Dimension | This codebase (shared skeleton + injection) | Bespoke prompt per agent |
|---|---|---|
| Time to add an agent | Low — fill in six known sections | High — design structure from scratch |
| Diffability / review | High — same shape, changes stand out | Low — every prompt reads differently |
| Risk of section drift | Medium — four files can diverge | High — no shared shape to enforce |
| Placeholder safety | Closed, greppable set | Ad-hoc, easy to miss one |
| Flexibility per agent | Constrained to the skeleton | Total |

**What we gave up.** Per-agent freedom. The skeleton means the recommendation agent has to express "Available tools" inside a slot where the others have "EQL reminders" — a slightly forced fit. A fully bespoke prompt could be shaped exactly to each agent's needs.

**What the alternative would have cost.** Reviewability. Four prompts with four different shapes means every review starts from zero, every new agent reinvents structure, and the "each Role disclaims the others" rule has no shared home to live in. The uniform skeleton is what makes the four-agent system legible as a system.

**The breakpoint.** The shared skeleton is right while the agents are variations on "scoped read-only analyst with a JSON output." It stops being right the moment an agent needs a fundamentally different interaction shape — e.g. a multi-turn conversational agent that maintains state across user messages. At that point forcing it into the six-section mold costs more than a bespoke prompt would, and you split it out.

---

## Tech reference (industry pairing)

### String-replace placeholder injection

- **Codebase uses:** `lib/agents/diagnostic.ts` L45–48 — chained `.replace` calls, `/g` on `{project_id}`, plain on single-occurrence placeholders.
- **Why it's here:** zero dependencies, trivially testable, and the placeholder set is small and known — a templating library would be overkill.
- **Leading today (2026):** typed prompt templating — Anthropic/OpenAI SDK message builders, plus libraries like Jinja-style or `Prompt` objects that validate variables — lead for larger prompt suites.
- **Why it leads:** missing-variable detection and escaping, which raw `.replace` cannot give you.
- **Runner-up:** template literals with typed interpolation — keeps it in-language while restoring compile-time variable checking.

### System vs. user message split

- **Codebase uses:** the `.md` constant is the `system` (`base.ts` L98); the per-call task is the first `user` message (`base.ts` L80, e.g. `monitoring.ts` L70).
- **Why it's here:** it maps the constant-vs-per-call distinction onto the API's own role distinction — system carries the stable instructions, user carries the request.
- **Leading today (2026):** the system/user/assistant role split is the universal substrate (Anthropic, OpenAI, Gemini all share it).
- **Why it leads:** providers weight and (for some) cache the system block differently from turn content; keeping the constant in `system` is what makes prefix caching possible later.
- **Runner-up:** stuffing everything into one user message — simpler, but loses the role-based handling and the cache boundary.

### Recency-weighted final instruction (synthesis append)

- **Codebase uses:** `lib/agents/base.ts` L96–98 — `synthesisInstruction` concatenated to the end of `system` on the forced-final turn.
- **Why it's here:** the model weights the last instruction it reads most; appending the hard-stop last is what reliably breaks the "keep querying" momentum.
- **Leading today (2026):** placing the most critical instruction last (or repeating it at the end) is standard practice in both vendors' prompt guides.
- **Why it leads:** empirically robust across model versions; cheap (one string concat).
- **Runner-up:** a separate final user message carrying the instruction — equivalent effect, one more message in the transcript.

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

## Summary

A production prompt in blooming insights is a constant `.md` skeleton (Role → Hard rules → method → EQL reminders → Output → `{schema}`), the same six sections in the same order across all four agents, with each Role explicitly disclaiming the others' jobs. That constant is Layer 1; per-call values (`{project_id}`, `{anomaly}`, `{diagnosis}`, `{intent}`, plus the separately-passed `userPrompt`) are stamped in by `.replace` at runtime as Layer 2; and the `synthesisInstruction` is appended last on the forced-final turn as Layer 3 (`base.ts` L96–98). System equals the constant, user equals the per-call task — constant-vs-per-call is the system-vs-user split made literal.

**Key points:**
- One six-section skeleton, four instances; the headings line up across the files.
- Each `## Role` names and disclaims the other agents' jobs — decomposition encoded in prose (`monitoring.md` L5, `diagnostic.md` L5, `recommendation.md` L5).
- The placeholder set is closed and greppable: `{schema}`, `{project_id}`, `{anomaly}`, `{diagnosis}`, `{intent}`.
- `userPrompt` is a separate function argument, not in the `.md` — system is constant, user is per-call.
- The synthesis nudge lives in one place (`base.ts` L96–98), appended last to exploit recency, and only on the forced-final turn.

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
- placeholder set: `{schema}` `{project_id}` `{anomaly}` `{diagnosis}` `{intent}` — closed and greppable.

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
