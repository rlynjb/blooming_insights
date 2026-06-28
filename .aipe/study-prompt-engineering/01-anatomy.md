# 01 — Anatomy of a production prompt

*Four-section prompt structure · Industry standard*

## Zoom out, then zoom in

Pull up the agent layer. This is where every prompt lives in `blooming_insights`.

```
  Where the four sections of a prompt sit in the system

  ┌─ Route (/api/briefing) ───────────────────────────────────────┐
  │  bootstrap schema, build agent, stream events                  │
  └────────────────────┬───────────────────────────────────────────┘
                       │
  ┌─ Agent adapter (lib/agents/monitoring.ts) ────────────────────┐
  │  builds system prompt by interpolating into a .md template     │
  │     ┌──────────────────────────────────────────────────────┐   │
  │     │ ★ THE PROMPT — four sections ★                       │   │ ← we are here
  │     │   1. system  (role + rules + schema + checklist)     │   │
  │     │   2. context (workspace schema, project_id)           │   │
  │     │   3. examples (few-shot output shape)                 │   │
  │     │   4. user    ("work through the checklist...")        │   │
  │     └──────────────────────────────────────────────────────┘   │
  └────────────────────┬───────────────────────────────────────────┘
                       │
  ┌─ Anthropic SDK call ───────────────────────────────────────────┐
  │  system = sections 1+2+3 · messages[0].user = section 4         │
  └─────────────────────────────────────────────────────────────────┘
```

A production prompt is not "the thing you type into the chat box." It's an *assembled artifact* with four named sections, each with a different job, each going to a different SDK parameter. Get the boundaries wrong and the prompt drifts under you — every later concept file in this guide is downstream of getting the boundaries right.

## Structure pass

Three layers, one axis held constant down through them.

**Layers.** Outer: the prompt as a single blob of text the SDK receives. Middle: the four named sections that *compose* the blob. Innermost: the fields inside each section (rules, examples, schema).

**Axis — change frequency.** Walk "how often does this part change?" down the layers:

```
  one axis — "how often does this part change?" — three answers

  ┌─ section 1 — system role + rules ─┐
  │  CHANGES RARELY                    │   committed to git, reviewed
  └────────────────────────────────────┘   in PRs, surveys outlast model
       ┌─ section 2 — context ─────────┐
       │  CHANGES PER REQUEST          │   workspace schema, project_id,
       └───────────────────────────────┘   diagnosis to investigate
            ┌─ section 3 — examples ───┐
            │  CHANGES RARELY          │   few-shot examples committed
            └──────────────────────────┘   with the prompt
                 ┌─ section 4 — user ──┐
                 │  CHANGES PER CALL   │   "go investigate this anomaly"
                 └─────────────────────┘   the trigger, not the content
```

**Seams.** The system/user boundary is load-bearing: it flips who's in control (system = author; user = caller). The context-vs-rules boundary inside the system block is the other seam — mixing them is how prompts drift, and concept 13 is downstream of policing it.

## How it works

### Move 1 — the mental model

You know how a `fetch()` call has four things: a method, a URL, headers, and a body? An LLM call has four things too: a system message, context, examples, and a user message. Each goes to a different parameter on the SDK call, and each one answers a different question:

```
  The four-section prompt — one shape for every agent in the codebase

  ┌─────────────────────────────────────────────────────────────┐
  │ 1. SYSTEM       │ WHO am I and WHAT are my rules?           │
  │    (system)     │ "You are the monitoring agent. Hard rule  │
  │                 │  1: pass project_id to every tool call."  │
  ├─────────────────┼───────────────────────────────────────────┤
  │ 2. CONTEXT      │ WHAT does the world look like RIGHT NOW?  │
  │    (system,     │ "Project: wobbly-ukulele. Total customers │
  │     injected)   │  3,427. Events: purchase, view_item, ..." │
  ├─────────────────┼───────────────────────────────────────────┤
  │ 3. EXAMPLES     │ WHAT does a good answer LOOK LIKE?         │
  │    (system,     │ A canonical JSON shape inside the prompt   │
  │     few-shot)   │  text, shown verbatim.                    │
  ├─────────────────┼───────────────────────────────────────────┤
  │ 4. USER         │ WHAT specifically do I want NOW?           │
  │    (user msg)   │ "Work through your checklist and return    │
  │                 │  the JSON array."                          │
  └─────────────────────────────────────────────────────────────┘
```

That's the kernel. Any prompt missing one of these four is either underspecified (no rules, model wanders), under-grounded (no context, model invents), under-shaped (no examples, output mode drifts), or undertriggered (no user message, model doesn't know which task to do *now*).

### Move 2 — the walkthrough

**Section 1 — the system role.** Two things only: identity ("you are the X agent") and hard rules ("make at most N tool calls, then conclude"). Rules go at the top because the model attends to early-system content more strongly than late-context content (this is lost-in-the-middle in concept 04). Look at `legacy-prompts/monitoring.md:1-22`:

```
You are the monitoring agent in blooming insights, an AI analyst for an
ecommerce workspace running on Bloomreach Engagement (EQL-shaped tools).

## Role
You run a fixed checklist of ecommerce anomaly categories ...

## Hard rules
1. Pass `project_id: {project_id}` to every tool call.
2. Compute everything ad-hoc with `execute_analytics_eql`.
3. Make at most 6 tool calls total, then stop and return your JSON answer.
4. Work globally (no breakdown) by default. ...
```

Identity in one sentence, then numbered hard rules. The numbered rules are scannable — when the model regresses, you can point at "rule 3" and tighten the language. Prose rules buried in paragraphs are unmaintainable.

**Section 2 — the context, injected per call.** Two interpolations: `{project_id}` (one string) and `{schema}` (the compacted workspace schema). `lib/agents/legacy-prompts/monitoring.md:99-101`:

```
## Workspace schema

{schema}
```

`{schema}` lands at the *end* of the system prompt because it's variable-length and we want stable rules at the top (better lost-in-the-middle behaviour, better prefix caching). The interpolation itself happens in `lib/agents/monitoring-legacy.ts:95-98`:

```typescript
const system = PROMPT
  .replace('{schema}', schemaSummary(this.schema))
  .replace(/\{project_id\}/g, this.schema.projectId)
  .replace('{categories}', checklist);
```

Three named placeholders, three named values. No string concatenation. No conditional sub-templates. The template is whole text; substitution is the *only* dynamic part.

**Section 3 — the examples.** The monitoring prompt embeds a worked JSON example in the Output section (`legacy-prompts/monitoring.md:72-85`):

```
[
  {
    "metric": "purchase_revenue",
    "category": "revenue_drop",
    "scope": ["global"],
    "change": { "value": 30.0, "direction": "down", "baseline": "90d" },
    "severity": "critical",
    ...
  }
]
```

This is a single-shot example, embedded in the system prompt's "Output" section. It's there to demonstrate *shape*, not content — the model isn't supposed to return this revenue drop, it's supposed to return *its own* findings *in this shape*. Concept 08 walks when to add more examples and when one is enough.

**Section 4 — the user message.** The trigger. Look at the call site at `lib/agents/monitoring-legacy.ts:105-107`:

```typescript
userPrompt:
  'Work through your category checklist (each as 90d vs prior 90d) and ' +
  'return the anomaly JSON array — stamp each flagged anomaly with its `category`.',
```

Two sentences. The system message did all the heavy lifting; the user message is *the call to action*. This is the most common anti-pattern in early-career prompt work — stuffing rules into the user message because it "feels more direct." It isn't. The system message is where rules go because the model treats it as authoritative; the user message is what the model treats as the immediate ask.

Here's the layers-and-hops view of how these four sections actually reach the model:

```
  Layers-and-hops — four sections → two SDK parameters

  ┌─ Agent code (lib/agents/monitoring.ts) ──────────────────┐
  │  reads template → interpolates → assembles {system, user} │
  └──────────┬─────────────────────────┬──────────────────────┘
             │ section 1+2+3            │ section 4
             │ joined as one string     │ as a single string
             ▼                          ▼
  ┌─ Anthropic SDK call ─────────────────────────────────────┐
  │  params.system = "You are the monitoring agent..."         │
  │  params.messages = [{ role: 'user', content: '...trigger' }]│
  └──────────────────────────────────────────────────────────┘
```

The four-section discipline is conceptual; the SDK only has two parameters (`system` and `messages`). The conceptual sections collapse onto the SDK shape — sections 1+2+3 all go to `system`, section 4 goes to `messages[0]`. The conceptual separation matters because *you* need to know which section to edit when the prompt regresses.

**The decomposition rule — one job per section, named explicitly.** When you find yourself wanting to put a rule in the user message, stop. Find the section it belongs to:

  → New rule? → section 1 (system role)
  → New per-call data? → section 2 (context)
  → New output shape clarification? → section 3 (examples)
  → New trigger phrasing? → section 4 (user)

This is the discipline. Violating it is how prompts drift.

### Move 3 — the principle

A production prompt is composed, not written. The composition rule — *one job per section, named explicitly* — survives every model upgrade because it isn't about prompting tricks; it's about separating what's stable from what's variable. The same discipline applies to a Lambda handler (route vs. handler vs. model) or a React component (props vs. state vs. effects): keep what changes at different rates in different places.

## Primary diagram — the full anatomy

```
  ┌─ Section 1: SYSTEM ROLE (stable across calls, committed to git) ───────┐
  │  "You are the monitoring agent in blooming insights..."                  │
  │  ## Role                                                                  │
  │  ## Hard rules (numbered, scannable)                                     │
  └────────────────────────────────────────────────────────────────────────┘
  ┌─ Section 2: CONTEXT (per-call, interpolated) ──────────────────────────┐
  │  {project_id}     → "8b3a2..."                                           │
  │  {categories}     → runnable category checklist                           │
  │  {schema}         → schemaSummary(workspace) — compact, token-bounded    │
  └────────────────────────────────────────────────────────────────────────┘
  ┌─ Section 3: EXAMPLES (stable, demonstrates output shape) ──────────────┐
  │  ## Output                                                               │
  │  Return ONLY a JSON array of anomaly objects, ... in a ```json fence:    │
  │  [ { "metric": ..., "category": ..., "change": {...}, ... } ]            │
  └────────────────────────────────────────────────────────────────────────┘
  ┌─ Section 4: USER (the per-call trigger) ───────────────────────────────┐
  │  "Work through your category checklist (each as 90d vs prior 90d) and    │
  │   return the anomaly JSON array..."                                       │
  └────────────────────────────────────────────────────────────────────────┘
       │
       ▼  Anthropic SDK call: params.system = (1+2+3), messages[0] = (4)
```

## Elaborate

The four-section shape isn't an Anthropic-ism — it's universal across the major LLM APIs (OpenAI's `system` / `messages`, Google's `systemInstruction` / `contents`). The convergence is real: every production prompt eventually grows toward this shape because the underlying need — separate stable rules from per-call data — is real.

The thing that varies across vendors is *where* tool schemas and examples can live. OpenAI lets you put function-calling examples in the `messages` array as previous turns; Anthropic's strong recommendation is to put few-shot examples inside the system message text (which is what this codebase does at `legacy-prompts/monitoring.md:72-85`). That divergence is vendor-specific surface; the four-section *shape* survives.

Where to read next: Anthropic's prompt engineering guide (anthropic.com/news/prompt-engineering-for-business-performance) is good on the system/user split. Simon Willison's blog has a running thread on the discipline of *not* stuffing rules into the user message.

In this codebase, concept 02 (structured outputs) and concept 04 (token budgeting) both depend on the four-section anatomy being right. Concept 03 (prompts as code) depends on the system role being in a `.md` file you can version-control rather than in a Python string literal.

## Interview defense

**Q: "Walk me through the structure of one of your prompts."**

Pull up `lib/agents/legacy-prompts/monitoring.md`. Sketch the four-section diagram from Move 1. Say: "Sections 1 through 3 land in the SDK's `system` parameter; section 4 lands as the first `user` message. The discipline is one job per section — identity in section 1, per-call data in section 2, output shape in section 3, the trigger in section 4. When the prompt regresses, that's where I look — which section is doing too much."

The diagram you draw:

```
  system role · context · examples  │  user trigger
  ─────────────────────────────────  │  ─────────────
  three sections                     │  one sentence
  one SDK parameter (system)         │  one SDK message
```

Anchor: *"one job per section, named explicitly."*

**Q: "Why not just put everything in the user message?"**

Two reasons. One, the model attends to the system message as more authoritative — instructions there hold up better across long conversations. Two, the user message gets *interleaved* with tool results across turns in an agent loop; if you put rules there, they get pushed out of attention by the time you're three turns deep. The system message stays at the top of the context every turn.

```
  Turn 1                Turn 5
  ──────                ──────
  system: rules         system: rules    (still at the top)
  user: trigger         user: trigger
                        assistant: tool_use
                        user: tool_result   ← rules-in-user-msg would be way back here
                        assistant: tool_use
                        user: tool_result
                        assistant: text
```

Anchor: *"the system message stays load-bearing across turns; the user message doesn't."*

**Q: "What's the part of the prompt anatomy people forget?"**

Section 3 — the examples. Most early-career prompts have sections 1, 2, and 4 but no example output. The model then produces *something*, you tune the rules to fix it, you push, it works for a week, the model upgrade lands and the output drifts because the rules in section 1 were the only constraint on shape and they're not as strong as a worked example. Adding one canonical example output to the system prompt is the cheapest reliability improvement in the codebase.

Anchor: *"the load-bearing part everyone forgets is the example. Without it, the output shape is governed only by prose rules — and prose rules drift across model upgrades."*

## See also

- `02-structured-outputs.md` — section 3 (examples) is where the structured-output shape gets demonstrated; section 1 (rules) is where you say "return ONLY a JSON array."
- `03-prompts-as-code.md` — keeping the four sections in a `.md` file is what makes the prompt versionable.
- `04-token-budgeting.md` — section 2 (context, injected per call) is where the token budget gets blown.
- `13-forbidden-patterns.md` — section 1 (rules) is where forbidden patterns get enumerated.
