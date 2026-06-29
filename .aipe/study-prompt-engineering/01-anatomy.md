# Anatomy of a production prompt

**Industry standard** · prompt sections, decomposition

## Zoom out — where prompt anatomy lives

Every LLM call in this codebase is built out of four sections that flow into the SDK's `messages.create()` call: the system prompt, context that's interpolated into it at call-time, optional few-shot examples baked into the template, and the user message. The whole anatomy lives in the prompt layer; nothing below it sees the prompt as anything but text.

```
  Zoom out — the prompt-assembly seam

  ┌─ UI ──────────────────────────────────────────────────────┐
  │  QueryBox · clicked InsightCard · ProcessStepper button   │
  └───────────────────────────┬───────────────────────────────┘
                              │  triggers a route call
  ┌─ Route layer ────────────▼────────────────────────────────┐
  │  app/api/{briefing,agent}/route.ts                         │
  │    knows: which agent · which schema · which anomaly       │
  └───────────────────────────┬───────────────────────────────┘
                              │
  ┌─ ★ PROMPT ASSEMBLY ★ ───▼────────────────────────────────┐ ← we are here
  │  read the .md template → interpolate {slots} →             │
  │  build { system, messages: [{ role: 'user', content }] }   │
  └───────────────────────────┬───────────────────────────────┘
                              │  Anthropic.messages.create()
  ┌─ Model ──────────────────▼────────────────────────────────┐
  │  claude-sonnet-4-6 / claude-haiku-4-5                      │
  └────────────────────────────────────────────────────────────┘
```

## Zoom in

A production prompt is not one string. It's four sections, each with a different job and a different lifecycle. When teams write a single string and call it "the prompt," they end up with a system message that mixes constant rules with per-call data — and then they can't reason about why one call drifted differently from another. The decomposition rule is: one job per section, named explicitly.

## Structure pass

**Layers.** The prompt-assembly path has three nested altitudes: the static `.md` template on disk, the interpolated string built per call, and the message array the SDK consumes. Each layer adds one thing.

**Axis traced — lifecycle.** Hold one question constant: *when does this content come into existence?*

```
  One axis — when does each section materialize?

  ┌─ template on disk (build-time / commit-time) ────────────┐
  │   monitoring.md · diagnostic.md · query.md ·              │
  │   recommendation.md                                       │
  │   → reviewed in PRs, versioned in git                     │
  └─────────────────────────────────────────────────────────┬─┘
                                                            │
  ┌─ per-call interpolation (request-time, in route) ───────▼┐
  │   {schema}      ← rebuilt per session from MCP            │
  │   {project_id}  ← from the resolved org                   │
  │   {categories}  ← from runtime capability check           │
  │   {anomaly} | {diagnosis} | {intent} ← upstream output    │
  └─────────────────────────────────────────────────────────┬─┘
                                                            │
  ┌─ message array (SDK call, single request) ──────────────▼┐
  │   { system: interpolated_template,                        │
  │     messages: [{ role: 'user', content: userPrompt }] }   │
  └───────────────────────────────────────────────────────────┘
```

**Seams.** Two boundaries carry contracts. The first is template-on-disk → interpolated string: the slot names are the contract — `{schema}`, `{project_id}`, `{categories}`, `{anomaly}`, `{diagnosis}`, `{intent}`. Rename a slot in the `.md` without updating the `.replace()` call and the prompt silently ships with `{categories}` literal in the system message. The second is interpolated string → SDK message array: the convention here is "constant rules + interpolated context → `system`, the per-call ask → first user message." Move something across that boundary by accident and the model treats it differently (the SDK caches the system prefix; cache invalidates when the user message changes).

## How it works

### Move 1 — the four sections, as one picture

Think of a prompt the way you'd think of a React component's props split: there's `propTypes` (the contract — constant, reviewed), `props` (the per-render data), `children` (slot-style content from outside), and what the parent passes (the user's actual request). LLM prompts have the same four roles, named differently.

```
  The four sections — one prompt, four jobs

  ┌─────────────────────────────────────────────────────────┐
  │  SYSTEM PROMPT (constant per agent)                      │
  │    "You are the monitoring agent... your role is..."     │
  │    rules, output schema, error patterns to avoid         │
  │    ← committed in the .md file                           │
  ├─────────────────────────────────────────────────────────┤
  │  CONTEXT INJECTION (per call, but still in `system`)     │
  │    {schema}      — workspace catalog (1× per session)    │
  │    {project_id}  — resolved org id                       │
  │    {categories}  — runtime-gated checklist                │
  │    {anomaly} | {diagnosis} ← upstream agent output       │
  ├─────────────────────────────────────────────────────────┤
  │  FEW-SHOT EXAMPLES (constant, in the .md template)       │
  │    the worked Anomaly JSON in monitoring.md:73-85         │
  │    the conclusion → evidence shape in diagnostic.md       │
  ├─────────────────────────────────────────────────────────┤
  │  USER MESSAGE (the actual ask, per call)                 │
  │    "Work through your category checklist..."             │
  │    "Investigate this anomaly: ..."                       │
  └─────────────────────────────────────────────────────────┘
```

### Move 2 — walk one example end to end

The monitoring agent is the cleanest one to walk because all four sections show up.

**System prompt (constant, committed).** The header of `lib/agents/legacy-prompts/monitoring.md` declares the agent's role, the hard rules, the period-over-period method, the common errors to avoid, and the output schema. None of this changes per call. It's reviewed in PRs and versioned in git.

```
  monitoring.md header (lines 1-9, the constant part)
  ┌────────────────────────────────────────────────────────┐
  │ You are the monitoring agent in blooming insights...    │
  │ ## Role                                                 │
  │ You run a fixed checklist of ecommerce anomaly          │
  │ categories... 90d vs prior 90d... emit an `Anomaly`...  │
  └────────────────────────────────────────────────────────┘
```

**Context injection (per call, into `system`).** The `.replace()` calls in `lib/agents/monitoring-legacy.ts:95-98` interpolate three slots. `{schema}` becomes the output of `schemaSummary()` (token-bounded — see concept #4). `{project_id}` becomes the resolved org id. `{categories}` becomes the runnable-category checklist computed at request time from the workspace's capabilities.

```
  // lib/agents/monitoring-legacy.ts:95-98
  const system = PROMPT
    .replace('{schema}', schemaSummary(this.schema))    // ← schema slot
    .replace(/\{project_id\}/g, this.schema.projectId)  // ← project slot (global re)
    .replace('{categories}', checklist);                // ← capability-gated slot
```

The `/\{project_id\}/g` regex is load-bearing: `{project_id}` appears in multiple places in the template (the hard-rules header and the worked example). A non-global replace would substitute the first occurrence and ship the literal `{project_id}` to the model on the second. That's the kind of small bug that ships and stays shipped until someone notices the model is asking for "the project id".

**Few-shot examples (constant, in the .md template).** Lines 73-85 of `monitoring.md` carry a worked `Anomaly` object inside a ```json fence — a single example that pins both the output shape and the tone of the `impact` field. The few-shot file (concept #8) covers why this kind of example constrains output more than instructions do.

**User message (per call).** The route assembles a short user message that says what to do *right now*, given the system already says what to do *in general*. For monitoring, that's:

```
  // lib/agents/monitoring-legacy.ts:105-107
  userPrompt:
    'Work through your category checklist (each as 90d vs prior 90d) and ' +
    'return the anomaly JSON array — stamp each flagged anomaly with its `category`.',
```

This is short on purpose. The system prompt already describes the job; the user message says "do it now." Putting the same instructions in both places doesn't help — and putting per-call data in the user message that should have been in `system` (or vice versa) is how prompts drift.

### Move 2 — the decomposition rule in code

The mistake every team makes once: bundling everything into the user message because "that's where the user's question goes." Watch what happens when you do that — the model loses the prefix-cache hit on every call (every call has a different user message; nothing is stable to cache), the per-agent rules get duplicated across every flow, and changing a rule means editing every call-site.

```
  WRONG — everything in user, system is empty
  ┌─────────────────────────────────────────┐
  │ system: ""                              │
  │ user: "You are the monitoring agent.    │
  │        Here are the rules. Here is the  │
  │        schema. Here is the checklist.   │
  │        Now do the job."                 │
  └─────────────────────────────────────────┘
  → no prefix cache · rules spread · drift

  RIGHT — constants in system, ask in user
  ┌─────────────────────────────────────────┐
  │ system: <committed .md> + <schema>      │
  │         + <checklist>                   │
  │ user: "Work through the checklist now." │
  └─────────────────────────────────────────┘
  → prefix cached · rules versioned · stable
```

The decomposition rule from the spec: *one job per section, named explicitly*. The system has the constant rules. The interpolated context has the per-session data (schema, project, capability checklist). The few-shot has the worked example. The user message has the per-call ask. Don't mix.

### Move 3 — the principle

Production prompts decompose along lifecycle boundaries: what's stable across all calls goes in the system template, what's per-session goes into interpolated slots, what shapes the output goes in few-shot examples, what asks for *this* result goes in the user message. The decomposition isn't aesthetic — it's how you keep the prompt reviewable, the prefix cacheable, and the drift contained to one section at a time.

## Primary diagram

```
  Monitoring agent — full anatomy, one frame

  ┌─ TEMPLATE LAYER (committed in git) ────────────────────────────┐
  │  lib/agents/legacy-prompts/monitoring.md                        │
  │  ┌─ system prompt (constant) ──────────────────────────────┐   │
  │  │ "You are the monitoring agent..."                        │   │
  │  │ ## Role · ## Hard rules · ## Period-over-period method   │   │
  │  └─────────────────────────────────────────────────────────┘   │
  │  ┌─ few-shot (constant, in same .md) ───────────────────────┐  │
  │  │   ```json                                                │  │
  │  │   [{ "metric": "purchase_revenue", "category": ...}]     │  │
  │  │   ```                                                    │  │
  │  └─────────────────────────────────────────────────────────┘   │
  │  ┌─ slots awaiting interpolation ──────────────────────────┐   │
  │  │   {schema}  {project_id}  {categories}                  │   │
  │  └─────────────────────────────────────────────────────────┘   │
  └────────────────────────────────────────┬───────────────────────┘
                                           │  .replace(...)
  ┌─ INTERPOLATED STRING (per call) ───────▼───────────────────────┐
  │  the full system string · static prefix cacheable               │
  └────────────────────────────────────────┬───────────────────────┘
                                           │
  ┌─ MESSAGE ARRAY (SDK call) ─────────────▼───────────────────────┐
  │  {                                                              │
  │    system: <interpolated>,                                      │
  │    messages: [                                                  │
  │      { role: 'user', content: "Work through the checklist..." } │
  │    ],                                                           │
  │    tools: [...allowed by lib/mcp/tools.ts]                      │
  │  }                                                              │
  └────────────────────────────────────────────────────────────────┘
```

## Elaborate

The four-section decomposition is older than LLMs — it mirrors what good prompt engineering picked up from systems thinking. The system prompt is the *config*; the interpolated context is the *runtime data*; the few-shot examples are the *type signature*; the user message is the *function call*. Tools that try to dissolve this distinction ("just one big prompt!") consistently produce worse results because they make the lifecycle question unanswerable.

Anthropic's prompt engineering guide and the OpenAI cookbook both lead with this decomposition for a reason. When you read other people's prompts, look for the seam between *what's true for every call* and *what's true for this call only*. If you can't find the seam, the prompt is going to drift, and you won't know why.

## Interview defense

**Q: Why split into four sections — why not just one long user message?**

A: Three reasons. **Prefix caching** — providers cache the static prefix of a prompt across calls. Put your stable rules in `system` and the per-call ask in `user`, and you pay the cache discount; put everything in `user` and every call is a cache miss. **Review velocity** — the constant part lives in a committed `.md` you can diff in a PR; the per-call interpolation is a small set of slot names you can grep for. Bundle them and you're diffing prose against runtime data. **Drift containment** — when something breaks, you can tell which section caused it: did the slot interpolation fail, did the user message change, did the few-shot drift? With one big string you can only say "the prompt is bad."

```
  one anchor diagram I'd sketch while answering:

  system  = constant rules + interpolated context (cacheable)
  user    = "do it now"                            (per call)
  schema  = how the answer should be shaped       (in template)
  output  = JSON in a fence, validated downstream
```

**Q: What's the rename-a-slot bug — concrete example?**

A: In `monitoring-legacy.ts` line 97, the `{project_id}` interpolation uses `/\{project_id\}/g` — a global regex. If someone "simplified" it to `.replace('{project_id}', id)` (no regex, no `/g` flag), only the first occurrence in the template would be replaced. The hard-rules header still gets the project id; the worked example a few sections later ships with literal `{project_id}` text. The model sees that and either pastes it into a tool call (which fails) or hallucinates an id. The validator catches the symptom (no anomalies returned, or every tool call fails) but not the cause. You'd debug for hours before grepping for `{project_id` in the captured prompt.

## See also

- [02-structured-outputs.md](./02-structured-outputs.md) — how the output schema declared in `## Output` becomes a typed value downstream
- [03-prompts-as-code.md](./03-prompts-as-code.md) — the committed-in-git lifecycle of the system-prompt section
- [04-token-budgeting.md](./04-token-budgeting.md) — why `{schema}` is the output of `schemaSummary()` and not the raw 112KB blob
- [08-few-shot.md](./08-few-shot.md) — what the worked `Anomaly` example in lines 73-85 is doing
