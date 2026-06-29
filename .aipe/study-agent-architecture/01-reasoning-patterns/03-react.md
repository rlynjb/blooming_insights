# ReAct

**Industry standard.** The default single-agent reasoning pattern. The baseline you start at.

## Zoom out, then zoom in

Sits inside the agent loop as the *prompting strategy* the step function uses. The skeleton (previous file) is the substrate; ReAct is the conversation that fills it.

```
  Zoom out — where this concept lives

  ┌─ Reasoning layer ───────────────────────────────┐
  │  MonitoringAgent / DiagnosticAgent / Rec / Query│
  └────────────────────────────┬────────────────────┘
                               │
  ┌─ Runtime layer ───────────▼────────────────────┐
  │  runAgentLoop  (the skeleton)                   │
  └────────────────────────────┬────────────────────┘
                               │  prompts the model with...
  ┌─ Prompting layer ─────────▼────────────────────┐
  │  ★ ReAct — Thought / Action / Observation ★    │ ← we are here
  │  (the conversation shape the model receives)    │
  └─────────────────────────────────────────────────┘
```

Every active agent in this repo runs ReAct. Not because the engineer wrote a ReAct prompt — because the AptKit agent classes ship a system prompt that elicits Thought-Action-Observation behavior from a tool-calling-capable model, and the `runAgentLoop` substrate executes it.

## Structure pass

Layers: system prompt (the strategy the model gets) → response content (the model's emitted action) → tool result (the observation).

**Axis traced — "where does the structure come from?":** the system prompt encodes the pattern, the model emits the structured content, the harness shuttles results. The structure isn't enforced by the model; it's elicited.

**Seam:** the model's `tool_use` block is the typed handoff. The model expresses "I want to do this action" as a structured JSON object the harness can dispatch on. That's the boundary that makes ReAct *practical* in production — older "react-style" implementations parsed free-text "Action: search('query')" with regex; the modern version uses the model's native tool-calling.

## How it works

### Move 1 — the mental model

ReAct is "model thinks out loud, then does one thing, then sees what came back, then thinks again." If you've watched yourself debug a database in a fresh session — *"hmm, I don't know the schema yet, let me list tables… okay, there's a `users` table, let me see the columns… got it, now I can write the query"* — that's the pattern. The model interleaves a reasoning step with one tool call at a time, reading the result before deciding the next move.

```
  The ReAct conversation shape — one turn per box

  ┌─ user prompt ──────────────────────────────────┐
  │ "Run the anomaly checklist."                    │
  └────────────────────────────┬────────────────────┘
                               │
  ┌─ assistant turn 1 ────────▼────────────────────┐
  │ Thought (text):  "I'll start with revenue."     │
  │ Action (tool_use): execute_analytics_eql(...)   │
  └────────────────────────────┬────────────────────┘
                               │
  ┌─ user turn 2 (tool_result)▼────────────────────┐
  │ Observation: { current_90d: 1.2M, prior: 1.9M } │
  └────────────────────────────┬────────────────────┘
                               │
  ┌─ assistant turn 2 ────────▼────────────────────┐
  │ Thought: "Big drop. Localize by country."       │
  │ Action: execute_analytics_eql(country=USA, ...) │
  └────────────────────────────┬────────────────────┘
                               │
  ┌─ user turn 3 (tool_result)▼────────────────────┐
  │ Observation: { USA: -38%, EU: +2%, ROW: -3% }    │
  └────────────────────────────┬────────────────────┘
                               │
  ┌─ assistant turn N (final)─▼────────────────────┐
  │ Text only — no tool_use.                        │
  │ Final answer: JSON array of anomalies.          │
  └─────────────────────────────────────────────────┘
```

### Move 2 — step by step

#### What the model receives — the system prompt

Open `node_modules/@aptkit/core/node_modules/@aptkit/prompts/dist/src/monitoring.js` (or `monitoring.d.ts` for the shape). The AptKit prompts package ships a `monitoringPromptPackage.system` template; the monitoring agent renders it with two slots — `schema` (the workspace summary) and `categories` (the runnable checklist).

What the model *doesn't* get is "interleave thought and action." It gets a domain prompt ("you're a Bloomreach anomaly scanner; here are the categories; here's the schema; query EQL to find the most significant changes; return JSON") plus a tool list. Modern Claude / Sonnet are trained to emit `tool_use` blocks when they need a tool — the Thought-Action-Observation interleaving is *learned behavior* the prompt elicits, not a hand-rolled "Thought: … Action: …" parsing loop.

This is the practical version of ReAct. The original ReAct paper used a structured text format the harness parsed; the production version uses the model's native tool-calling because (a) it's robust to formatting drift and (b) the model emits a JSON object the harness can dispatch on directly.

#### What the model emits — content blocks

```ts
// Anthropic content-block types (paraphrased — the Blooming
// adapter maps these in lib/agents/aptkit-adapters.ts:187-202)
type ContentBlock =
  | { type: 'text'; text: string }                    // ← Thought
  | { type: 'tool_use'; id, name, input };           // ← Action
```

One model response can carry both: a `text` block (the Thought) followed by one or more `tool_use` blocks (the Actions). The harness reads both — emits the text to the trace as a `step` event so the UI's `StatusLog` shows the agent's reasoning, and runs each `tool_use` through the tool registry.

The trace path: `BloomingTraceSinkAdapter.emit` (`lib/agents/aptkit-adapters.ts:108-130`) catches `step` events and forwards the text via `hooks.onText`; the route handler turns that into a `reasoning_step` NDJSON event (`app/api/agent/route.ts:196-200`); the UI consumes that and renders one line in `ReasoningTrace`. The Thought becomes a UI surface.

#### What the harness sends back — the observation

```ts
// from run-agent-loop.js:97-102 — the tool result block format
toolResults.push({
  type: 'tool_result',
  toolUseId: toolUse.id,
  content: resultContent,         // truncate(JSON.stringify(result))
  ...(isError ? { isError: true } : {}),
});
```

The Observation is just a `tool_result` block in the next user message. The content is the truncated JSON of the tool's result; `isError` flags failures. The model reads this on the next turn and decides whether to keep going.

The truncation is set at 16,000 characters (`run-agent-loop.js:2`) — beyond that, the result is suffixed with `\n...[truncated]`. The lost-in-the-middle problem (covered in `04-agent-infrastructure/01-context-engineering.md`) is the reason this cap matters: a 200KB EQL result poured into the context would push earlier evidence out of the model's effective attention window.

#### The escalation framing — why "start with ReAct"

The interview-grade point is *placement*: ReAct is the baseline, not the bottom-of-the-stack-of-fancier-things. The escalation ladder reads top-down — try this first, escalate only when a measurable failure says ReAct can't address it:

```
  The escalation ladder — every step is "did the previous one fail?"

  Default to ReAct.
    │
    ├─ measure: success rate, tool-call accuracy,
    │           latency, cost
    │
    └─ only escalate when a SPECIFIC failure mode
       is identified that ReAct can't address:
         │
         ├─ "the model wanders mid-run" → plan-and-execute
         │   (front-load the strategy, execute mechanically)
         │
         ├─ "the model produces plausible-but-wrong outputs"
         │   → reflexion / verifier-critic (catch them)
         │
         └─ "the problem genuinely splits into specialties"
              → multi-agent topology (see Section C)
```

This repo runs ReAct everywhere. Not because the team is unimaginative — because the failure modes that would justify escalation (mid-run wandering, plausible-but-wrong outputs, genuine specialty splits) aren't the dominant failure modes in this domain.

### Move 3 — the principle

**Most teams jump past ReAct prematurely.** They read a blog about plan-and-execute or multi-agent and start there. The signal of someone who has shipped agents in production is the opposite move: "I built a ReAct baseline, measured it, and escalated to [pattern X] only when [specific failure Y] showed up that ReAct couldn't address." The baseline + measurement + named failure is the structure that says "I made a real decision," not "I picked the fanciest pattern from the menu."

## Primary diagram

```
  ReAct as the prompting strategy the agent loop runs

  ┌──────────────────────────────────────────────────────────────────┐
  │  user prompt (set once at the start)                              │
  │  "Run the anomaly checklist."                                     │
  └─────────────────────────────┬────────────────────────────────────┘
                                │
                                ▼
  ┌──────────────────────────────────────────────────────────────────┐
  │  TURN N (assistant)                                               │
  │  ┌─ text (Thought) ──────────────────────────────────────────┐   │
  │  │ "Revenue dropped 38% globally. Let me localize."          │   │
  │  └───────────────────────────────────────────────────────────┘   │
  │  ┌─ tool_use (Action) ───────────────────────────────────────┐   │
  │  │ { name: 'execute_analytics_eql', input: {                  │   │
  │  │     project_id: 'wobbly-ukulele',                          │   │
  │  │     eql: 'sum event purchase.total_price ...' }}           │   │
  │  └───────────────────────────────────────────────────────────┘   │
  └─────────────────────────────┬────────────────────────────────────┘
                                │  emitted intent
                                ▼
  ┌─ harness ────────────────────────────────────────────────────────┐
  │  tools.callTool('execute_analytics_eql', {...}, {signal})         │
  │  → BloomingToolRegistryAdapter.callTool                           │
  │  → DataSource.callTool                                            │
  │  → BloomreachDataSource (cache check → MCP call → retry → cache)  │
  │  → returns { result, durationMs }                                 │
  └─────────────────────────────┬────────────────────────────────────┘
                                │  result
                                ▼
  ┌──────────────────────────────────────────────────────────────────┐
  │  TURN N+1 (user — synthetic, written by harness)                  │
  │  ┌─ tool_result (Observation) ───────────────────────────────┐   │
  │  │ { tool_use_id: 'toolu_abc',                                │   │
  │  │   content: '{"USA": -38, "EU": 2, "ROW": -3}',             │   │
  │  │   ... (truncated at 16,000 chars) }                        │   │
  │  └───────────────────────────────────────────────────────────┘   │
  └─────────────────────────────┬────────────────────────────────────┘
                                │  loop back to TURN N+2 (assistant)
                                ▼
                          ... until the model emits
                          no tool_use (SUCCESS exit) or
                          turn == maxTurns-1 (BUDGET exit
                          → forced final turn synthesizes)

  Every text block above becomes one line in the UI's StatusLog
  via the CapabilityTraceSink → AgentEvent NDJSON path.
```

## Elaborate

The original ReAct paper (Yao et al., 2022) was a prompting *and* parsing innovation. The prompt format was literally "Thought: …\nAction: search('query')\nObservation: …" and the harness regex'd the Action line to dispatch. The format was brittle — the model would skip "Action:" sometimes, or emit JSON in the wrong fence, or hallucinate an "Observation:" of its own. Production-grade ReAct moved to the model's native tool-calling exactly because the typed `tool_use` block is robust to formatting drift.

The "Thought" in modern ReAct is *optional* — Claude and GPT-4 will sometimes emit `text` before a `tool_use`, sometimes not. The trace will be lighter on reasoning if you don't prompt for it explicitly. This repo's prompts (in `@aptkit/prompts`) ask for reasoning before action, so the StatusLog has content to show; an alternative prompt could elicit silent tool-calling and skip the visible thought.

The reason multi-tool-per-turn is allowed (one `model.complete` can return *multiple* `tool_use` blocks the harness runs in a single per-turn batch) is *parallelism within a turn*. The model can decide "I need three independent queries to localize this anomaly" and emit three `tool_use` blocks at once; the harness can run them concurrently if the underlying tool registry supports it. This repo's `BloomingToolRegistryAdapter` runs them sequentially (`for (const toolUse of toolUses)` in `run-agent-loop.js:59`), and the `BloomreachDataSource`'s `minIntervalMs: 200ms` would serialize them at the wire anyway — but the model is *allowed* to ask for parallelism. The pattern composes upward into fan-out (`03-multi-agent-orchestration/04-parallel-fan-out.md`).

## Interview defense

> **Q: Which reasoning pattern does this codebase use, and why?**
>
> ReAct, in every agent. The monitoring agent runs a ReAct loop over EQL queries to find anomalies; the diagnostic agent runs one to test hypotheses; the recommendation agent runs one to read scenarios/segments before proposing. The pattern is the substrate — modern Claude with native tool-calling emits `tool_use` blocks; `runAgentLoop` shuttles results back as `tool_result` blocks; the loop terminates on a tool-free response or on the budget cap. The reason it's the right pattern: the failure modes that would push us to plan-and-execute (mid-run wandering on long tasks) or multi-agent (genuine specialty splits) aren't dominant in this domain. The investigations are short (under 8 turns, under 6 tool calls for monitoring) and the categories are bounded.
>
> Anchor: every agent class in `lib/agents/`; the loop in `node_modules/.../runtime/.../run-agent-loop.js`.

> **Q: Why not plan-and-execute? Wouldn't that be cheaper?**
>
> Two reasons. First, the diagnostic investigations are short — 4-7 turns typical. Plan-and-execute's win is decoupling one expensive planning call from many cheap execute calls; with this few execute steps, the planning overhead doesn't amortize. Second, the path through the data is genuinely exploratory: which hypothesis to test next depends on what the previous query returned. A plan written up front would be wrong after turn 2 and would need re-planning, which collapses back into ReAct's cost. The interview-grade move is to name the breakpoint: if our diagnostic investigations grew to 15+ tool calls and the categories of hypotheses were knowable, plan-and-execute would earn its overhead. Today they're not.

> **Q: How does the model know to emit `tool_use` blocks in the right format?**
>
> Two pieces. The system prompt (from `@aptkit/prompts`) describes the task and references the tools; the request also carries the typed `toolSchemas` (Anthropic's `Tool[]` shape — name, description, input_schema). Claude is trained to emit `tool_use` blocks when the request includes tool schemas. The harness doesn't parse free text for "Action:"; it reads the response's `content` array and filters blocks of type `tool_use`. That typed handoff is what makes ReAct production-grade instead of brittle.
>
> Anchor: `lib/agents/aptkit-adapters.ts:42-71` (the model adapter showing how tools cross the seam).

## See also

- → `02-agent-loop-skeleton.md` — the substrate ReAct runs on
- → `04-plan-and-execute.md` — the first escalation past ReAct
- → `04-agent-infrastructure/03-tool-calling-and-mcp.md` — the wire format of `tool_use`
- → cross-reference (when generated): `study-ai-engineering`'s `04-agents-and-tool-use/03-react-pattern.md` — the prompt-level mechanics, the original paper's framing
