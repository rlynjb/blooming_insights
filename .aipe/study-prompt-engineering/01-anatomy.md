# 01 · Anatomy of a production prompt

**Prompt sections / structured system prompt — Industry standard**

## Zoom out, then zoom in

Every LLM call in this codebase ends up as one HTTP request to Anthropic, and the payload is a `system` string plus a `messages` array. That's it. All the discipline you're about to learn is discipline about what goes into those two fields — because the model doesn't care about your intent, only your bytes.

```
  Zoom out — where the anatomy sits in the stack

  ┌─ Route layer (Next.js) ─────────────────────────────────┐
  │  /api/agent — NDJSON stream                             │
  └────────────────────────┬────────────────────────────────┘
                           │
  ┌─ Agent layer (blooming wrappers) ───▼───────────────────┐
  │  DiagnosticAgent · MonitoringAgent · RecommendationAgent │
  └────────────────────────┬────────────────────────────────┘
                           │
  ┌─ AptKit reusable agent (@aptkit/core) ▼─────────────────┐
  │  DiagnosticInvestigationAgent.investigate()             │
  │      renderPromptTemplate(system, {schema, anomaly})    │
  └────────────────────────┬────────────────────────────────┘
                           │
  ┌─ Provider adapter ─────▼────────────────────────────────┐
  │  AnthropicModelProviderAdapter.complete()                │
  │      → ★ this is where the prompt anatomy is assembled ★│ ← we are here
  │      params.system = [{type:'text', text, cache_control}]│
  │      params.messages = messages                          │
  └────────────────────────┬────────────────────────────────┘
                           │  HTTPS
  ┌─ Provider ─────────────▼────────────────────────────────┐
  │  Anthropic API (Sonnet 4.6)                             │
  └─────────────────────────────────────────────────────────┘
```

**Zoom in.** A production prompt has four sections, and mixing them is how prompts drift. Role (who the model is), rules/schema (what it must do), context (variable data for this call), and task (the user's immediate ask). Junior mode dumps all four into one system string with no boundaries. Senior mode names each section explicitly and knows which slot each byte lives in.

## Structure pass

Before walking the mechanics, three foundations.

### Axes — the dimension we're tracing

For anatomy, the axis is **cost per call**. Every section of a prompt has a different cost profile — some are stable across the whole session (system prompt, constant), some vary per call (context, per-anomaly), some vary per user turn (task, per-message). Trace this axis and the sections separate themselves.

### Seams — where the axis flips

There are three seams inside a single Anthropic API call:

- **system vs messages** — the boundary between "stable across the loop" (system) and "changes every turn" (messages).
- **stable system prefix vs variable context** — inside the system string, the front is static and cacheable; the back has the anomaly / diagnosis injected fresh each call.
- **model-visible vs adapter-visible** — the model sees the flat string; the adapter code wraps it in a cache-control block. That wrap is a load-bearing seam Anthropic reads and the model doesn't.

### Layered decomposition

Same question — "what varies here?" — asked at three altitudes:

```
  "What varies here?" — held constant down the layers

  ┌───────────────────────────────────────────┐
  │ outer: session (a whole investigation)     │  role, rules, schema
  │   → CONSTANT                               │  don't vary
  └───────────────────────────────────────────┘
      ┌─────────────────────────────────────┐
      │ middle: one API call inside the loop │  system prefix stable
      │   → PARTIAL                          │  context slot varies
      └─────────────────────────────────────┘
          ┌─────────────────────────────────┐
          │ inner: one user turn             │  task varies per turn
          │   → VARIABLE                     │  everything else stable
          └─────────────────────────────────┘
```

The lesson: the four sections aren't co-equal. They live at different altitudes of variance, and prompt caching (see `04-token-budgeting.md`) works by exploiting exactly this hierarchy.

## How it works

### Move 1 — the mental model

You know how a `fetch()` has a URL, headers, body, and query params — four distinct slots, each with its own semantics, and mixing them (putting the body content in the URL) is how you get bugs? A prompt has four analogous slots, each with its own semantics.

```
  Prompt anatomy — the four slots

  ┌───────── system string ─────────┐    ┌─── messages array ───┐
  │                                 │    │                      │
  │  ┌─ role ────────────────────┐  │    │  ┌─ user turn ─────┐ │
  │  │ "you are a diagnostic     │  │    │  │ "Run the anomaly│ │
  │  │  investigation agent"     │  │    │  │  checklist…"    │ │
  │  └───────────────────────────┘  │    │  └─────────────────┘ │
  │                                 │    │                      │
  │  ┌─ rules / schema ──────────┐  │    │  ┌─ tool_result ───┐ │
  │  │ "Make at most 6 tool      │  │    │  │ {…tool JSON…}   │ │
  │  │  calls. Return ONLY JSON  │  │    │  └─────────────────┘ │
  │  │  in a fenced block…"      │  │    │                      │
  │  └───────────────────────────┘  │    │  ┌─ assistant ─────┐ │
  │                                 │    │  │ "I'll query…"   │ │
  │  ┌─ context (interpolated) ──┐  │    │  └─────────────────┘ │
  │  │ {schema}     ← workspace  │  │    │                      │
  │  │ {anomaly}    ← case       │  │    └──────────────────────┘
  │  └───────────────────────────┘  │
  └─────────────────────────────────┘

    stable across the ReAct loop         changes every model turn
```

Role, rules, context on one side of the seam. Task and its evolving turn history on the other. That's the whole anatomy.

### Move 2 — the step-by-step walkthrough

**The role slot — who the model is.**

The first paragraph of every prompt in this codebase names the agent's identity. From `@aptkit/prompts/dist/src/diagnostic.js:1`:

```js
export const DIAGNOSTIC_PROMPT = `You are a diagnostic investigation agent for an analytics workspace.

Your job is to investigate why one specific anomaly occurred. You generate 2-3 competing hypotheses, query the available tools to test them, and return the best-supported explanation with evidence. You do not propose remediation.
```

Two lines and you know the agent's job and its guardrail (does not propose remediation — that's the recommendation agent's job). The negation ("You do not propose remediation") is doing real work: it stops the model from bleeding into the recommendation agent's territory. If you remove it, the diagnosis starts to include "and here's what to do next," and now the recommendation agent is either redundant or contradicted.

```
  Role slot — what breaks if it's missing

  ┌─────────────────────────────────────────┐
  │  "You are a diagnostic ... agent."      │  identity
  │  "You generate 2-3 hypotheses..."       │  method
  │  "You do NOT propose remediation."      │  guardrail (negation)
  └─────────────────────────────────────────┘
        │
        │  strip it → the agent bleeds into
        │  recommendation territory. Downstream
        │  agent gets confused input.
        ▼
```

**The rules/schema slot — what the model must do.**

Hard rules and the output contract. Same file, lines 6-45:

```js
Hard rules:
- Make at most 6 tool calls, then conclude.
- Use the tool catalog you receive at runtime; do not assume a tool exists.
- Every evidence item must cite data you actually observed.
...
Return ONLY a JSON object in a \`\`\`json fenced block with this shape:
{
  "conclusion": "string",
  "evidence": ["string"],
  "hypothesesConsidered": [ { "hypothesis": "string", "supported": true, ...
```

Two things live here: **behavioral rules** (tool call budget, honesty about tools, evidence traceability) and the **output schema shape**. Blooming validates the parse afterwards (`lib/mcp/validate.ts:29`, `isDiagnosis`), but the model gets the shape in-prompt so its default emission matches what the parser accepts.

**The context slot — variable data for this call.**

Template placeholders like `{schema}` and `{anomaly}` get filled at runtime by `renderPromptTemplate`. In this codebase, `schemaSummary(schema)` (`lib/agents/monitoring.ts:19-60`) produces the string that goes into `{schema}` — token-budgeted to 20 events × 10 properties + 30 customer properties, because the raw schema is ~112KB and would blow the context window.

```
  Layers-and-hops — how the anatomy is assembled

  ┌─ template file ──────────────┐
  │  @aptkit/prompts/            │  hop 1: prompt string with {vars}
  │  diagnostic.js DIAGNOSTIC_   │──────────────────────────────►
  │  PROMPT                      │
  └──────────────────────────────┘

  ┌─ variables ──────────────────┐
  │  schemaSummary(workspace)    │  hop 2: rendered variables
  │  JSON.stringify(anomaly)     │──────────────────────────────►
  └──────────────────────────────┘
                                          ┌─ renderPromptTemplate ─┐
                                          │  substring replacement │
                                          │  {schema} → schemaText  │
                                          │  {anomaly} → JSON      │
                                          └───────────┬────────────┘
                                                      │  hop 3: assembled system
                                                      ▼
  ┌─ AnthropicModelProviderAdapter ──────────────────────────────┐
  │  aptkit-adapters.ts:85-89                                    │
  │  params.system = [{type:'text', text, cache_control:...}]    │
  │  params.messages = [...user + tool_result turns...]          │
  └──────────────────────────────────────────────────────────────┘
                          │  hop 4: HTTPS to Anthropic
                          ▼
  ┌─ Anthropic API ──────────────────────────────────────────────┐
  │  reads system as one flat string; reads messages as turns    │
  └──────────────────────────────────────────────────────────────┘
```

**The task slot — the user turn.**

Sits in `messages`, not `system`. In this codebase it's static per agent, injected at loop start. From `@aptkit/core`'s `AnomalyMonitoringAgent.scan()`:

```js
userPrompt: 'Run the anomaly checklist using the available tools. Return only the anomaly JSON array in a json fence, or [] if no meaningful anomaly is found.',
```

One line. That's the whole task. Everything about *what* to run is in the system prompt's checklist (`{categories}` interpolation from `formatCategoryChecklist()`). The user turn just says "go."

Why? Because the system prompt is cached (see `AnthropicModelProviderAdapter.complete()` at `lib/agents/aptkit-adapters.ts:85-89` — the `cache_control: { type: 'ephemeral' }` breakpoint). Bytes in the user turn are *not* cached, so keeping the user turn tiny keeps every ReAct-loop iteration cheap.

### Move 2 variant — the load-bearing skeleton

The kernel of a production prompt anatomy is four sections, in this order:

```
  role → rules/schema → context → task

  (stable, session)    (stable, session)   (varies, per call)  (varies, per turn)
```

What breaks if you strip each:

- **Strip role** — the model default-personifies as a generic assistant, ignores your specific method, and the output starts to feel like ChatGPT instead of a diagnostic analyst.
- **Strip rules/schema** — output shape drifts. Sometimes JSON, sometimes prose. Your parser fails intermittently. This is the bug people file as "the LLM is unreliable" when it's actually "the prompt has no schema."
- **Strip context** — the model tries to answer from priors ("what's typical for ecommerce"). It sounds plausible and is completely disconnected from your workspace.
- **Strip task** — the model doesn't know when to stop. It rambles, asks clarifying questions, or invents a task.

Hardening layered on top of the skeleton (not part of it): few-shot examples (see `08-few-shot.md`), forbidden-openings (see `13-forbidden-patterns.md`), CoT scaffolding (see `09-chain-of-thought.md`). All optional. The four sections are not.

### Move 3 — the principle

**Prompts are structured payloads, not blobs of text.** The reader sees prose; the model sees tokens; the seam between "stable" and "variable" is where cost, cacheability, and iteration all live. Treat every prompt as if it were a request body with named fields — because as far as your ability to iterate on it is concerned, it is.

## Primary diagram

```
  A production prompt — everything at once

  ┌───────────────── Anthropic API call ─────────────────┐
  │                                                       │
  │  params.system = [                                    │
  │    { type: 'text',                                    │
  │      text: renderPromptTemplate(                      │
  │              DIAGNOSTIC_PROMPT,                       │
  │              { schema, anomaly, project_id }          │
  │            ),                                         │
  │      cache_control: { type: 'ephemeral' } }           │
  │  ]                                                    │
  │      │                                                │
  │      └─ contains, in order:                           │
  │         ┌─ role ───────────────────────┐              │
  │         │ "You are a diagnostic ...    │              │
  │         │  You do NOT propose remed."  │              │
  │         └──────────────────────────────┘              │
  │         ┌─ rules ──────────────────────┐              │
  │         │ "Make at most 6 tool calls…" │              │
  │         │ "Return ONLY JSON in a fence"│              │
  │         └──────────────────────────────┘              │
  │         ┌─ schema (embedded example) ──┐              │
  │         │ {"conclusion":"","evidence":…│              │
  │         └──────────────────────────────┘              │
  │         ┌─ context (interpolated) ─────┐              │
  │         │ {schema} ← schemaSummary()   │  var         │
  │         │ {anomaly} ← JSON.stringify() │  var         │
  │         └──────────────────────────────┘              │
  │                                                       │
  │  params.messages = [                                  │
  │    { role: 'user',                                    │
  │      content: 'Run the anomaly checklist…' } ← task   │
  │    ...tool_result and assistant turns as loop runs... │
  │  ]                                                    │
  └───────────────────────────────────────────────────────┘

     system → stable prefix, cached          messages → varies per turn
```

## Elaborate

The four-section shape is the working consensus across Anthropic and OpenAI documentation, though neither vendor names it exactly this way. Anthropic's prompt engineering guide splits into "role, task, examples, output format." OpenAI's cookbook uses "system, few-shot, user." Both are the same four sections with different names for the boundaries. The names don't matter — what matters is that you can point at each section in your own prompt and say "this is the role" without hunting.

The tradeoff nobody names: **more structure = more brittle to iterate on**. If you add a fifth section for "priority overrides" or "conditional rules," you now have five things to keep in sync. Four is the sweet spot most production prompts settle at. If you find yourself wanting a fifth, ask whether it belongs in the rules section instead.

A word on XML tags. Anthropic's guide recommends wrapping sections in XML-like tags (`<role>`, `<rules>`, `<context>`). This codebase does not use XML tags — the sections are separated by markdown headings (`## Role`, `## Hard rules`) because the reader is a human first, model second. Both work. Pick one and stay consistent. Mixing markdown headings and XML tags is where prompts get unreadable.

Related concepts:
- **Prompts as code** (`03-prompts-as-code.md`) — once the anatomy is stable, treating the prompt as a versioned artifact is the next discipline.
- **Token budgeting** (`04-token-budgeting.md`) — the context slot is where token discipline earns its keep.
- **Prompt injection defenses** (`12-prompt-injection-defense.md`) — the seam between "the system says" and "the user says" is what injection attacks target.

## Interview defense

**Q: Walk me through the sections of a production prompt. Why does the ordering matter?**

Four sections: role, rules and schema, context, task. Role first because it primes the model's persona and constrains everything downstream. Rules and schema next because they set behavioral guardrails and the output shape — the model reads them before it reads any variable data. Context after, because it's the variable slot and its position matters for prefix caching — the stable stuff has to come *before* the variable stuff or you get zero cache hits. Task last, in the user message, because that's the "go" signal, and it's also where per-turn state (tool results, follow-up user turns) accumulates.

```
  Interview whiteboard sketch

  system:  [ role ] → [ rules/schema ] → [ context vars ]
                    ↑ stable prefix, cached
                                        ↑ varies per call

  messages: [ user "go" ] → [ tool_result ] → [ assistant ] → …
                              ↑ evolves every ReAct turn
```

Anchor: `AnthropicModelProviderAdapter.complete()` at `lib/agents/aptkit-adapters.ts:59-121` — see the `cache_control` breakpoint on line 87.

**Q: What's the load-bearing part people forget?**

Negations in the role slot. "You do NOT propose remediation" in the diagnostic prompt (`@aptkit/prompts/dist/src/diagnostic.js:4`). Positive instructions constrain what the model does; negations stop it from bleeding into a neighboring agent's territory. Every multi-agent system I've shipped has needed at least one negation per agent role, and every one where I forgot led to bleed-through.

```
  Negation as guardrail

  agent A "you do X"        ┐
                            │   without negations,
  agent B "you do Y"        ┤   both agents start
                            │   also doing Z
  agent C "you do Z"        ┘

  with "you do NOT do Y" in A's role:
  A stays in its lane
```

**Q: Someone hands you a prompt as one giant blob. First thing you do?**

Highlight the four sections. If I can't find the role in the first paragraph, that's finding #1. If the rules and the schema are interleaved with prose that's context, that's finding #2. If the task is embedded in the system string instead of the user message, that's the reason it's not cacheable. The refactor is almost mechanical: extract to four named blocks, run the eval set, keep the diff if scores hold.

Anchor: `lib/agents/legacy-prompts/monitoring.md` is a good example of a well-structured version — the `## Role`, `## Hard rules`, `## Output` headings make each section addressable in code review.

## See also

- `02-structured-outputs.md` — the schema section in more depth.
- `03-prompts-as-code.md` — versioning the anatomy.
- `04-token-budgeting.md` — why the stable-before-variable ordering matters.
- `12-prompt-injection-defense.md` — the section boundaries as security boundaries.
