# 01 · Anatomy of a production prompt

**Industry name:** *anatomy of a system prompt* / *sections of a prompt* · Language-agnostic

## Zoom out — where the prompt lives

Before you decompose it, put it on the map. A prompt is not one string. It's four sections stacked in a specific order, then a `messages[]` array of conversation, then (in the 2026 world) a `tools[]` array so the model can act.

```
  Zoom out — where the prompt lives in this system

  ┌─ UI layer ──────────────────────────────────────────────┐
  │  Next.js page → fetch('/api/briefing')                   │
  └────────────────────────┬─────────────────────────────────┘
                           │
  ┌─ Service layer ────────▼─────────────────────────────────┐
  │  briefing route → MonitoringAgent → DiagnosticAgent → …   │
  └────────────────────────┬─────────────────────────────────┘
                           │  agent.investigate(anomaly)
  ┌─ Agent internals ──────▼─────────────────────────────────┐
  │  ★ THIS BLOCK ★  system prompt assembled here             │ ← we are here
  │    ├─ role / rules (static across investigations)          │
  │    ├─ context injection (schema, categories, anomaly)      │
  │    ├─ few-shot (if any)                                     │
  │    └─ hard-rules / output shape                             │
  │  then messages[]: [{ role:'user', content:'begin' }]        │
  │  then tools[]: MCP tools passed at call time                │
  └────────────────────────┬─────────────────────────────────┘
                           │  Anthropic.messages.create()
  ┌─ Provider ─────────────▼─────────────────────────────────┐
  │  system + messages + tools cross the wire                 │
  └───────────────────────────────────────────────────────────┘
```

## Zoom in — the four sections

Every production prompt in this repo, whether it's the retired string prompts in `lib/agents/legacy-prompts/*.md` or the currently-active system prompts inside `@aptkit/core`, decomposes to the same four sections:

1. **Role + rules** (constant per call).
2. **Context injection** (per-call — the schema, the anomaly, the categories).
3. **Few-shot examples** (constant if present; skipped in most of this repo).
4. **Output shape / hard rules** (constant per call).

Then the `messages[]` starts with a first user turn kicking things off, and `tools[]` gives the model something to do besides talk. That's the whole anatomy.

## Structure pass — layers, axis, seams

Before mechanics, read the skeleton. Trace one axis — *what changes per call vs what is constant* — down the layers.

- **Layer 1: the system prompt.** Constant across every model turn within one investigation. Reused across the ~10 ReAct-loop iterations DiagnosticInvestigationAgent makes.
- **Layer 2: the messages[].** Grows every turn. Tool calls, tool results, model text — all appended here.
- **Layer 3: the tools[].** Constant across the loop.

**The axis:** which parts change per turn vs which are stable.

- system prompt → stable across the loop (cache-eligible)
- tools → stable across the loop (cache-eligible)
- messages → grows every turn (never stable)

**The seam:** the boundary between "stable prefix" and "growing suffix." That's where prompt caching lives. `AnthropicModelProviderAdapter.complete()` sets one `cache_control: ephemeral` breakpoint on the system prompt, which covers both stable-prefix bands (system + tools) transparently. See `lib/agents/aptkit-adapters.ts:85-89`.

Mechanics hang off this skeleton. The four sections belong to Layer 1. The context injected inside them (schema, anomaly) is the only per-call thing in the "stable prefix" that isn't stable — and that's a problem you'll see recur in the token-budgeting file.

## How it works

### Move 1 — the shape

Think of a prompt the way you'd think of an HTTP request. You've built plenty of those: there's a URL (the fixed target), headers (metadata about the request), a body (the payload), and query params (the small variable inputs). A prompt is the same shape.

```
  Pattern — prompt anatomy as sections

  ┌─────────────────────────────────────────────┐
  │ system prompt                                │
  │  ┌────────────────────────────────────────┐ │
  │  │ § 1  role + rules      (constant)      │ │
  │  │ § 2  context injection (per-call)      │ │
  │  │ § 3  few-shot examples (constant/none) │ │
  │  │ § 4  output shape      (constant)      │ │
  │  └────────────────────────────────────────┘ │
  └─────────────────────────────────────────────┘
  ┌─────────────────────────────────────────────┐
  │ messages[]                                   │
  │  [ user: "begin" ]                           │
  │  [ assistant: text + tool_use ]              │
  │  [ user: tool_result ]                       │
  │  [ assistant: … loop … ]                     │
  └─────────────────────────────────────────────┘
  ┌─────────────────────────────────────────────┐
  │ tools[]  (constant)                          │
  └─────────────────────────────────────────────┘
```

Each § inside the system prompt has one job. Mixing jobs is how prompts drift. When the "role" section starts explaining output format, or the "context injection" section grows opinions about hypotheses, you've lost the decomposition and the next iteration will be harder than it needs to be.

### Move 2 — walking the four sections

#### § 1 — role + rules (constant)

The section that names who the model is and the hard constraints on how it operates. In the retired string prompt at `lib/agents/legacy-prompts/monitoring.md:1-9`, this reads:

```
You are the monitoring agent in blooming insights, an AI analyst for an
ecommerce workspace running on Bloomreach Engagement (EQL-shaped tools).

## Role
You run a fixed checklist of ecommerce anomaly categories (below) against
this workspace. …
```

That's the *whole* role section. It doesn't do anything else. It names the entity, names its remit, and stops. In `@aptkit/core`, the same content lives inside the `AnomalyMonitoringAgent` class — you don't see the string in this repo anymore, but the shape is the same.

```
  Layers-and-hops — what happens when § 1 mixes jobs

  ┌─ § 1 role ──────────┐
  │ "you are the        │  ← belongs here
  │  monitoring agent"  │
  └──────────┬──────────┘
             │
  ┌─ § 4 output shape ──▼──────┐
  │ "return JSON with these    │  ← belongs here
  │  fields: …"                │
  └────────────────────────────┘

  when someone edits § 1 to say "you are the monitoring agent
  and you should return JSON," they've stapled § 4 to § 1.
  next iteration, the model returns JSON to the diagnostic
  agent too, because the role now carries an output rule.
  the parser breaks. two-week debug session begins.
```

The rule: § 1 says who the model is and what it does. That's it. Output shape lives in § 4.

#### § 2 — context injection (per-call)

The per-call variables. In the monitoring prompt, this is `{categories}`, `{project_id}`, and `{schema}` (see `lib/agents/legacy-prompts/monitoring.md:13-14` and `:101`). In the diagnostic prompt, add `{anomaly}` (see `lib/agents/legacy-prompts/diagnostic.md:15-17`). The values are computed in TypeScript before the string is assembled.

In the active path, the context injection is done by `@aptkit/core` — you hand it `workspace: this.schema` and `categories: […]` and (for diagnose) `anomaly` at call time, and it templates them in. See `lib/agents/monitoring.ts:84-90` for the shape.

The section that most often bloats. In this repo the fix is `schemaSummary()` — a compaction step that turns a 112KB schema into 20 events × 10 properties + top 30 customer properties. Full file walk in `04-token-budgeting.md`.

#### § 3 — few-shot examples (constant, or absent)

If the concept is well-shaped without them, skip. This repo doesn't lean on few-shot for the three agents; the rubric task in `eval/rubrics/diagnosis-quality.ts:18-22` is more constrained (a rubric definition, not a task-behavior prompt) and doesn't use few-shot either.

The one place few-shot pays here is the output example blocks — the retired string prompts include a JSON template of the expected shape at `lib/agents/legacy-prompts/monitoring.md:72-85`. That's a shape example, not a task example. It's still a form of few-shot: it constrains output structure by showing it.

Full walk in `08-few-shot.md`.

#### § 4 — output shape / hard rules (constant)

The most under-taught section. It's where you declare the JSON keys, what each field means, and what the parser will do if you deviate.

Real example from `lib/agents/legacy-prompts/diagnostic.md:60-82`:

```
Return ONLY a JSON object (in a ```json fenced block) of exactly this shape:

```json
{
  "conclusion": "string — the best-supported explanation, or an honest…",
  "evidence": ["string — one piece of evidence per item, citing tool results"],
  "hypothesesConsidered": [
    { "hypothesis": "string — what you tested",
      "supported": true,
      "reasoning": "string — why the data supports or rules this out" }
  ],
  …
}
```

Two things this teaches the model:

1. The wrapper: fenced ` ```json ` block. Consumed by `parseAgentJson()` in `lib/mcp/validate.ts:3-13`, which strips the fence before `JSON.parse`.
2. The schema: exact keys, brief inline descriptions. The prompt teaches the shape by showing one.

The active path uses tool-calling to enforce the shape structurally (the model can only emit tokens that match the tool's input schema). But the fenced-JSON-with-example approach still lives in the query prompt at `lib/agents/legacy-prompts/query.md:46-48`, because the query agent returns prose, not structured data.

**What breaks in § 4 if you're not careful.** The three common failures:

- **Instruction added to another section that contradicts § 4.** Someone adds "be concise" to § 1. The model complies by dropping the fenced ` ```json ` wrapper because it "wastes tokens." Parser breaks.
- **§ 4 grows a new field without a matching validator update.** The prompt says "now emit `impactRealism`." The validator in `lib/mcp/validate.ts` doesn't check for it. First few runs look fine; the field silently varies; downstream code that assumed it exists crashes on a case where the model dropped it.
- **Model courtesies.** The model wraps the JSON inside a markdown fence *plus* prepends "Here's the analysis:". The `parseAgentJson()` substring scan at `lib/mcp/validate.ts:7-12` catches this by searching for the first `[` or `{`. That fallback exists specifically because § 4 alone doesn't fully control the output; the parser has to be forgiving.

### Move 2 variant — the load-bearing skeleton

If you had to reconstruct this pattern from memory, what's the kernel? Four moving parts inside the system prompt:

1. **Role + rules.** Drop it and the model doesn't know what it is; it defaults to "helpful assistant" and starts hedging.
2. **Context injection.** Drop it and the model has no data to reason over; it hallucinates the workspace or refuses.
3. **Few-shot examples.** Drop them and shape drifts on edge cases. On simple tasks, missing this doesn't break anything.
4. **Output shape.** Drop it and the model chooses a plausible shape per call. Parser breaks on run three.

Everything else — the tool catalog, the workspace schema, the anomaly — is hardening for a specific job. The four sections above are the skeleton.

### Move 3 — the principle

**One section, one job, named explicitly.** That's the whole rule. When a section starts doing two jobs, the prompt hasn't drifted yet — but the next edit will make it drift, because whoever edits it can't tell which job they're touching. The decomposition is a maintenance discipline, not a rendering choice. The model doesn't care whether your prompt is one paragraph or four sections; you and the next engineer will.

## Primary diagram

```
  Anatomy — the full recap

  ┌─ system prompt ─────────────────────────────────────────────┐
  │                                                              │
  │  § 1  role + rules                                           │
  │       "you are the diagnostic agent. investigate WHY."       │
  │                                                              │
  │  § 2  context injection                                      │
  │       {project_id}   ← per-call                              │
  │       {anomaly}      ← per-call                              │
  │       {schema}       ← per-call (compressed by schemaSummary)│
  │                                                              │
  │  § 3  few-shot examples                                       │
  │       (absent for this agent; see 08-few-shot.md)             │
  │                                                              │
  │  § 4  output shape                                            │
  │       "return ONLY a JSON object of exactly this shape…"      │
  │       { conclusion, evidence, hypothesesConsidered, … }       │
  │                                                              │
  └──────────────────────────────────────────────────────────────┘
  ┌─ messages[] ────────────────────────────────────────────────┐
  │  [ user:  "investigate this anomaly" ]                       │
  │  [ assistant: text + tool_use ]                              │
  │  [ user:  tool_result ]                                      │
  │  [ … ReAct loop … ]                                          │
  │  [ assistant: final JSON ]                                   │
  └──────────────────────────────────────────────────────────────┘
  ┌─ tools[]  ────────────────────────────────────────────────── ┐
  │  execute_analytics_eql · list_scenarios · …                  │
  └──────────────────────────────────────────────────────────────┘
```

## Elaborate

The four-sections decomposition isn't in any spec — it's practitioner shorthand. Anthropic's prompt-engineering guide calls out most of these as separate techniques (role prompting, providing context, examples, output formatting) without ever saying "these are the four sections of a prompt." OpenAI's cookbook does something similar. Once you have shipped a few of these you notice the same four keep showing up, and naming them separately is how you keep them from bleeding into each other.

The reason this repo split its prompts into an aptkit-owned inner shape plus a blooming-owned outer context: the four sections partition cleanly. Aptkit owns § 1 and § 4 (role, rules, output shape). Blooming owns § 2 (the context — schema, categories, anomaly). § 3 stays absent for these agents. The split is possible *because* the sections are decomposed; if § 1 and § 4 were tangled, the split wouldn't be a package boundary, it'd be a mess.

## Interview defense

**Q: How do you decompose a production system prompt?**

Four sections. Role, context, few-shot, output shape. Role is constant and says who the model is. Context is per-call — the data you're reasoning over. Few-shot is examples of task behavior, often absent when the shape is well-constrained by the output schema. Output shape is the JSON structure the parser expects. The rule: one section, one job.

```
  system ──► [§1 role][§2 context][§3 shots?][§4 shape]
```

Anchor: `lib/agents/legacy-prompts/diagnostic.md` — the retired string prompt in this repo is the cleanest reading of the decomposition.

**Q: What breaks when the sections tangle?**

Someone adds "be concise" to § 1. The model interprets it as "drop the JSON fence wrapper" and starts emitting bare text. The parser at `lib/mcp/validate.ts:parseAgentJson` falls back to a substring scan and catches most cases, but you've now made the parser load-bearing to compensate for a prompt regression. That's the smell — when the parser starts working around the prompt, the sections aren't decomposed anymore.

```
  §1 "be concise"  ──► model reinterprets §4  ──► parser scrambles
```

Anchor: `lib/mcp/validate.ts:3-13` — the fallback substring scan exists exactly for this failure mode.

## See also

- 02 · structured outputs — how § 4 becomes a tool schema instead of a prose declaration.
- 03 · prompts as code — how these sections stay reviewable when the prompt is a file, not a runtime string.
- 04 · token budgeting — how § 2 (the context injection) gets compressed so it fits.
- 07 · output mode mismatch — what happens when § 4 says JSON in chain A and markdown in chain B.
