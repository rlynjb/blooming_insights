# ReAct

_Industry standard._

## Zoom out, then zoom in

ReAct (Reason + Act) is the default single-agent pattern — interleave reasoning tokens and tool calls in one flat message stream. Every worker in this repo runs ReAct. This file's job is *placement in the family*: why start here, when to escalate, and why this repo hasn't.

```
  Zoom out — every worker runs ReAct on top of the kernel

  ┌─ Worker agents (thin wrappers) ────────────────────────────┐
  │  MonitoringAgent · DiagnosticAgent · RecommendationAgent   │
  │  QueryAgent — each = one prompt + one runAgentLoop call    │
  └────────────────────────────┬───────────────────────────────┘
                               │
  ┌─ AptKit runtime ───────────▼───────────────────────────────┐
  │  ★ runAgentLoop (the ReAct kernel — see 02) ★              │
  └────────────────────────────────────────────────────────────┘
```

Zoom in: this file names ReAct as the *baseline*. It's what you build first. Escalation to plan-and-execute or multi-agent is not a default; it's a response to a specific measured failure.

## Structure pass

**Layers:** prompt (system instructions) · loop (kernel from `02-agent-loop-skeleton.md`) · tool policy (allowlist) · parse (schema validation).
**Axis:** *what does the model do per turn?*
**Seam:** the interleave — text and tool_use blocks come back in the same content array; the loop routes each.

Reasoning and action share one message stream, not two:

```
  ReAct interleave — one turn's response

  content: [
    { type: 'text',     text: "Let me check purchase revenue trend..." },  ← reason
    { type: 'tool_use', name: 'execute_analytics_eql', input: {...} },     ← act
  ]

  next turn:
  content: [
    { type: 'tool_result', tool_use_id: '...', content: '{...}' },        ← observe
  ]
  → LLM continues (reason + act again, or return final text)
```

## How it works

### Move 1 — the mental model

You've built forms with mixed inputs before — one form emits both text and file uploads in a single submit. ReAct is the same: one model response contains both *thought* (text) and *action* (tool_use) blocks; the harness inspects the content array, streams the text as reasoning to the UI, and executes each tool_use.

```
  Pattern: ReAct interleave

  turn 1 → LLM emits: "I should check <tool_use A>"
  turn 2 (harness) → run A, feed result back
  turn 3 → LLM emits: "Now check <tool_use B>"
  turn 4 (harness) → run B, feed result back
  turn 5 → LLM emits: final text (no tool_use) — DONE
```

### Move 2 — the walkthrough

**How Blooming builds a ReAct worker.** Each worker is 40-80 lines of adapter — one system prompt, one AptKit agent class, one call. `DiagnosticAgent`:

```ts
// lib/agents/diagnostic.ts:37-67
export class DiagnosticAgent {
  constructor(private anthropic, private dataSource, private schema, private allTools, private sessionId?) {}

  async investigate(anomaly, hooks = {}) {
    const agent = new AptKitDiagnosticInvestigationAgent({
      model: new AnthropicModelProviderAdapter(...),
      tools: new BloomingToolRegistryAdapter(this.dataSource, this.allTools),
      workspace: this.schema,
      trace: new BloomingTraceSinkAdapter(hooks, 'diagnostic'),
    });
    return agent.investigate(anomaly, { signal: hooks.signal });
  }
}
```

Line-by-line: Blooming owns the *bridging* (SDK adapter, tool registry adapter, trace sink); AptKit owns the loop and the prompt. The prompt is in `@aptkit/prompts` and gets rendered with `schemaSummary` + the anomaly JSON injected. That prompt is a ReAct prompt — it tells the model to "Investigate the anomaly and return the diagnosis JSON object."

**The interleave in the wire.** `runAgentLoop.js:29-52`:

```js
const response = await model.complete({ system, messages, tools: toolSchemas, ... });
messages.push({ role: 'assistant', content: response.content });
const text = textFromContent(response.content);
if (text) { trace?.emit({ type: 'step', role: 'assistant', content: text, ... }); }
const toolUses = toolUsesFromContent(response.content);
if (toolUses.length === 0) { finalText = text; break; }
```

Line-by-line: one call returns one `response.content` array. `textFromContent` extracts the reasoning text and streams it as a `step` event (this is what shows up in the `StatusLog` panel). `toolUsesFromContent` extracts the actions; the loop runs each. Reason + Act, same turn, one call.

**Why "baseline" is load-bearing.** In `escalate to X` interview answers, ReAct is where you started — measured — and moved past. In this repo, the honest claim is: ReAct + a well-shaped prompt + a strict `filterToolsForPolicy` allowlist (see `diagnostic-agent.js:8-23`) has been enough. Plan-and-execute (see `04-plan-and-execute.md`) would add a 30-40% latency hit at the top with no measured accuracy win for a *single-hypothesis* investigation flow.

### Move 3 — the principle

Start with ReAct. Measure success rate, tool-call accuracy, latency, cost. Escalate only when a *specific* failure mode is identified that ReAct can't address by prompt shaping or tool-policy tightening. The interview-grade version: "I built a ReAct baseline, measured N cases, tool-call accuracy was M%, and the failures were <specific> — that's when I reached for plan-and-execute / self-critique / multi-agent."

## Primary diagram

```
  Recap — ReAct in a Blooming worker

  ┌─ prompt (from @aptkit/prompts + rendered with schema) ─────┐
  │  system: "You are a diagnostic investigator..."            │
  │  user:   "Investigate the anomaly and return the           │
  │           diagnosis JSON object."                          │
  └─────────────────────────────┬──────────────────────────────┘
                                │  runAgentLoop
                                ▼
  ┌─ turn 1 ───────────────────────────────────────────────────┐
  │  Sonnet emits: text (reason) + tool_use(execute_analytics_eql)│
  └────────────────────────────┬───────────────────────────────┘
                               │  execute
                               ▼
  ┌─ turn 2 ─ (tool_result appended, model runs again) ────────┐
  │  Sonnet emits: text + tool_use(execute_analytics_eql)      │
  └────────────────────────────┬───────────────────────────────┘
                               │  ... up to 5-8 turns typical
                               ▼
  ┌─ final turn ───────────────────────────────────────────────┐
  │  Sonnet emits: text ONLY (JSON fence with Diagnosis)       │
  │  → tryParseDiagnosis → return                              │
  └────────────────────────────────────────────────────────────┘
```

## Elaborate

ReAct came from Yao et al. 2022, but the more useful reference for a production reader is Anthropic's "Building Effective Agents" (2024), which named the pattern-family cleanly: **augmented LLM** (prompt + tools) is the base, **workflows** (chain / router / parallel / etc.) are code-driven compositions, **agents** are ReAct loops. The recommended production posture is "workflows outside, agents inside" — which is exactly the shape this repo runs.

The failure mode that pushes past ReAct in some codebases: **long-horizon planning** where the model loses the thread after 4-5 tool calls. Blooming's diagnostic loop is short-horizon (3-5 tool calls typical, cap at 6), so this doesn't bite. If the investigation grew to require nested sub-questions (which country segment → which acquisition channel → which campaign), the answer would be *not* plan-and-execute, but a sub-agent (supervisor-worker in Section C).

## Interview defense

**Q: Why ReAct and not something fancier?**
A: Because I measured. The diagnostic loop converges in 3-5 tool calls with Sonnet 4.6; the failure modes I see are (1) EQL syntax errors from the model, mitigated by the tight allowlist + prompt examples, and (2) the model asking "should I run another query?" when the answer is clearly there, mitigated by the `maxToolCalls=6` budget-exit + synthesis prompt. Plan-and-execute would add a separate planning turn at the top — 40% more latency, no accuracy gain in the measured cases. Multi-agent would add coordination overhead. I named the specific failure that would push me past ReAct: cross-segment nested investigations, which I don't have yet.

Diagram: the ReAct interleave, then a "when to escalate" arrow pointing sideways to plan-and-execute / multi-agent with the trigger conditions labelled.
Anchor: `lib/agents/diagnostic.ts:37-67` + `run-agent-loop.js:25-105`.

**Q: How is reasoning surfaced to the UI?**
A: ReAct's advantage over structured intermediate representations is that the reasoning text IS the interleave. Every model turn's text block gets streamed as a `step` event through the trace sink (`BloomingTraceSinkAdapter.emit`), which hooks into the route's `send({ type: 'reasoning_step', ... })`, which the browser reads as NDJSON and renders in `StatusLog`. The user sees the model's reasoning live — which is the product's whole "shows its work" pitch. That surface is *free* with ReAct; you'd have to synthesize it for other patterns.

Diagram: content array → text extraction → NDJSON → StatusLog line.
Anchor: `lib/agents/aptkit-adapters.ts:157-166` (the trace sink's step routing).

## See also

- `02-agent-loop-skeleton.md` — the kernel ReAct runs on.
- `04-plan-and-execute.md` — the escalation from ReAct.
- `07-routing.md` — the router in front of the ReAct loop.
- `03-multi-agent-orchestration/02-supervisor-worker.md` — the other escalation direction.
- Cross-reference: `.aipe/study-ai-engineering/04-agents-and-tool-use/03-react-pattern.md` for the Thought-Action-Observation mechanics.
