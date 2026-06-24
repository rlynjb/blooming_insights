# The ReAct pattern

**Industry name(s):** ReAct (Reason + Act), Thought–Action–Observation loop, interleaved reasoning and tool use
**Type:** Industry standard · Language-agnostic

> ReAct interleaves Thought (the model reasons in text), Action (it emits a tool call), and Observation (your code runs the tool and feeds the result back). blooming insights makes each step a streamed NDJSON event — `onText` → reasoning_step is the Thought, `tool_call_start` is the Action, `tool_call_end` + result-as-next-user-turn is the Observation — so the reasoning trace is a live product surface, consumed by `useInvestigation` (the StrictMode-safe reader hook) and rendered on the investigate page.


---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** ReAct is the canonical *shape* of the agent loop — the alternation between Thought (model emits text), Action (model emits `tool_use`), and Observation (your code runs it and feeds back `tool_result`). It is the inner loop of every step in the chain (→ 01-agents-vs-chains.md). blooming insights makes all three observable: each is a streamed NDJSON event (`reasoning_step` / `tool_call_start` / `tool_call_end` in `lib/mcp/events.ts`) so the trace is the product, not just a log.

```
  Zoom out — Thought/Action/Observation as a streamed loop

  ┌─ Per-agent + Agent loop ─────────────────────────┐  ← we are here
  │  runAgentLoop  base.ts L48–176                   │
  │                                                   │
  │  Thought      → model emits text  → onText        │
  │                  → send('reasoning_step')         │
  │  Action       → model emits tool_use → onToolCall │
  │                  → send('tool_call_start')        │
  │  Observation  → mcp.callTool result → onToolResult│
  │                  → send('tool_call_end')          │
  │                                                   │
  │  loop until forceFinal (L90–91, L101)             │
  └───────────────┬──────────────────┬───────────────┘
                  │ tool_use         │ NDJSON events
                  ▼                  ▼
  ┌─ Tools + MCP transport ─┐ ┌─ Route → UI stream ─┐
  │  mcp.callTool runs it   │ │  client renders the  │
  │  → result               │ │  trace live          │
  └─────────────────────────┘ └──────────────────────┘
```

**Zoom in — narrow to the concept.** The question is: how does an agent alternate between reasoning and acting, and how do you make that alternation observable instead of a black box? ReAct names the three moves — Thought, Action, Observation — and blooming insights streams each as a distinct event so the loop is a debuggable product, not a 60-second silence followed by a verdict. How it works walks each move, how `runAgentLoop` wires them via hooks, and why the trace being on-screen earns the user's trust in a way a one-shot answer never can.

---

## Structure pass

**Layers.** Three phases per loop iteration, each with its own taps: Thought (model emits text → `onText` → `reasoning_step` event), Action (model emits `tool_use` → `onToolCall` → `tool_call_start`), Observation (`mcp.callTool` returns → `onToolResult` → `tool_call_end`). All three sit inside the agent loop; the route's NDJSON stream surfaces them as live events.

**Axis: control.** Who decides what happens next at each phase — MODEL (Thought and Action) or CODE (Observation)? This axis is the right lens because ReAct is fundamentally an alternation of agencies — the model thinks, then the model acts, then *code* observes and feeds back. The loop is asymmetric: two model-controlled phases, one code-controlled phase, and the alternation is what makes it ReAct rather than a one-shot completion.

**Seams.** The cosmetic seam is between Thought and Action — both are model-emit phases. The load-bearing seam is between Action and Observation: control flips here from "MODEL emitting a tool request" to "CODE executing the tool and shaping the result into a `tool_result` block." This is where the rubber meets the road — and it's also where the live NDJSON event (`tool_call_end`) fires, making the seam observable. A second meaningful flip happens between Observation and the next Thought: results re-enter the message array and the model picks up reasoning again.

```
  Structure pass — ReAct pattern

  ┌─ 1. LAYERS ───────────────────────────────────┐
  │  Thought (model emits text)                    │
  │  Action (model emits tool_use)                 │
  │  Observation (CODE runs tool → tool_result)    │
  └────────────────────────┬───────────────────────┘
                           │  pick the axis
  ┌─ 2. AXIS ─────────────▼────────────────────────┐
  │  control: MODEL phases vs CODE phase — when    │
  │  does control hand over?                       │
  └────────────────────────┬───────────────────────┘
                           │  trace across layers, find flips
  ┌─ 3. SEAMS ────────────▼────────────────────────┐
  │  Thought↔Action: cosmetic (both MODEL)         │
  │  Action↔Observation: LOAD-BEARING              │
  │    MODEL request → CODE execution              │
  │    fires tool_call_end event                   │
  │  Observation↔next Thought: LOAD-BEARING        │
  │    CODE result → MODEL reasoning resumes       │
  └────────────────────────┬───────────────────────┘
                           ▼
                   Block 4 — How it works
```

The skeleton is mapped — the rest of this file walks the mechanics that hang off it.

## How it works

**Mental model.** ReAct is a `while` loop where each iteration has three phases, and this system attaches a callback to each phase that emits an event. Think of the loop as a state machine that cycles `THINK → ACT → OBSERVE → THINK …`, where the shared agent loop's hooks (`onText`, `onToolCall`, `onToolResult`) are the taps that turn each transition into an NDJSON line the client renders.

```
ReAct cycle (one turn of the shared agent loop)
─────────────────────────────────────────────────────────────
   ┌────────── THOUGHT ──────────┐
   │ model emits text reasoning  │  onText → reasoning_step (thought)
   └──────────────┬──────────────┘
                  ▼
   ┌────────── ACTION ───────────┐
   │ model emits tool_use block  │  onToolCall → tool_call_start
   └──────────────┬──────────────┘
                  ▼
   ┌──────── OBSERVATION ────────┐
   │ code runs tool, gets result │  onToolResult → tool_call_end
   │ result pushed as user turn  │  (feeds next THOUGHT)
   └──────────────┬──────────────┘
                  ▼  loop back to THOUGHT (model reads the observation)
```

The Observation is fed back as the next user message, so the model's *next* Thought is conditioned on what it just saw. That feedback edge — observation becomes the input to the next reasoning step — is the entire point of ReAct: the model updates its belief state after every action instead of planning everything up front.

---

### Isolate the kernel

ReAct has an irreducible kernel: six pieces that *are* the loop. Strip anything else and you still have a working agent; strip any of these and you don't.

```
runAgentLoop({ provider_sdk, mcp, system, userPrompt, toolSchemas, maxToolCalls }):
  messages = [{ role:'user', content: userPrompt }]
  for turn in maxTurns:                                              ─┐
    budgetSpent = toolCalls.length >= maxToolCalls                    │
    forceFinal  = (turn == last) || budgetSpent                       │
    params = { model, system: forceFinal ? system+synth : system,     │  KERNEL
               messages, max_tokens }                                 │
    if not forceFinal: params.tools = toolSchemas    ← strip on final │  (the
    res = await provider_sdk.messages.create(params)                  │   loop,
                                                                       │   minus
    messages.push({ role:'assistant', content: res.content })          │   nothing)
    toolUses = res.content.filter(b => b.type == 'tool_use')           │
    if toolUses.length == 0: return { finalText }    ← NO-TOOL EXIT   │
                                                                       │
    for tu of toolUses:                                                │
      result = await mcp.callTool(tu.name, tu.input)                   │
      toolCalls.push({ ...tu, result })                                │
                                                                       │
    messages.push({ role:'user',                       ← TOOL_RESULT  │
                    content: toolResults_for_each_tu })  fed back     ─┘
```

Six load-bearing pieces: (1) the `for turn` loop, (2) the model call with `params.tools` set, (3) the `tool_use` detection, (4) the `mcp.callTool` execution, (5) the `tool_result` push back as a user turn, and (6) the dual termination — no-tool exit OR budget-triggered forced-final-without-tools. The `onText`/`onToolCall`/`onToolResult` hooks, the NDJSON streaming, and the per-agent tool subsets are all *hardening* layered on the kernel.

---

### Name each part by what breaks when removed

Each kernel piece is here because something specific breaks if you drop it.

```
Removed                            What breaks
────────────────────────────       ─────────────────────────────────────
the for-turn loop                  You don't have an agent. You have a
                                   single LLM completion. The model can
                                   request a tool, but nothing runs it
                                   and nothing comes back.

params.tools assignment            The model can't request a tool. Every
                                   turn is text-only. The "Action" phase
                                   is gone; the loop never advances.

tool_use detection                 The model emits a tool_use block, you
                                   ignore it, you push assistant text only.
                                   The loop returns whatever was in the
                                   first text block — never the answer.

mcp.callTool execution             Detection works but nothing happens.
                                   You push an empty tool_result back, the
                                   model sees no observation, hallucinates
                                   one, and reasons on imaginary data.

messages.push(tool_results)        The result is computed and discarded.
                                   Next turn, the model has no memory of
                                   what it asked for. It re-asks. Infinite
                                   loop of the same tool call.

no-tool exit                       The model decides it's done and emits
                                   only text — you keep looping anyway,
                                   pushing empty tool_results, until
                                   maxTurns. Wasted turns; the answer is
                                   trapped in turn 1.

budget cap + forced-final          The model keeps requesting tools every
(strip tools when budgetSpent)     turn. maxToolCalls is hit; you keep
                                   passing tools; it never synthesizes.
                                   Forced-final removes the tool menu so
                                   the next turn HAS to be a final answer.
```

The dual termination is the subtle one: ReAct needs BOTH the "model said done" path and the "I forced it to be done" path. Drop the first and a model that already finished keeps spinning; drop the second and a model that never wants to finish runs the budget into the ceiling.

---

### Separate skeleton from optional hardening

The kernel above is the minimum. Everything around it is hardening — useful, but layered on. Saying which is which is part of the pattern.

```
SKELETON (the agent loop — required)           HARDENING (some present, some not)
────────────────────────────────────           ──────────────────────────────────
for-turn loop with maxTurns                    ┌ onText / onToolCall / onToolResult
params.tools toggle (on/off for final)         │   hooks (PRESENT — used for the
tool_use detection + execution                 │   NDJSON trace, ai-eng 05-streaming)
tool_result push back as user turn             ├ NDJSON streaming of every phase
no-tool exit                                   │   (PRESENT — the trace is a product)
maxToolCalls budget + forced-final             ├ per-agent tool SUBSETS via
                                               │   the tool-schema filter (PRESENT —
                                               │   ai-eng 04-tool-routing)
                                               ├ synthesisInstruction injected on
                                               │   forced-final (PRESENT — pushes
                                               │   the model to emit structured JSON)
                                               ├ tool_result truncation (PRESENT —
                                               │   16k cap on each result)
                                               ├ structured-output validator on
                                               │   finalText (PRESENT — synthesize()
                                               │   retry, see structured-outputs.md)
                                               └ planning / reflection / debate
                                                   (absent — every agent runs the
                                                   bare loop, no super-structure)
```

The shared agent loop ships the six-piece kernel plus six pieces of hardening that turn the loop from a working agent into a *production* agent: streaming makes the trace a product surface, tool subsets make the wrong-tool failure structurally absent (→ `04-tool-routing.md`), and the synthesis injection makes the forced-final turn produce structured output instead of generic text. None of those is required for the loop to *work* — they're required for it to ship.

---

### The principle

**Make the reasoning loop emit its phases as it runs.** ReAct's value is not just that the model reasons before acting — it is that reasoning, acting, and observing are *distinct, interleaved steps* you can tap. The moment you give each step a name and an event, the agent stops being a black box: you can stream it to a user, log it for evals, and debug it by reading the trace. A final-answer-only agent throws away the most valuable artifact it produces — the path it took. You keep the path and make it the product.

---

## The ReAct pattern — diagram

The diagram spans three layers. The Model layer produces Thoughts and Actions. The Loop layer runs the Action and produces the Observation, tapping each phase with a hook. The Stream/UI boundary turns each tap into a rendered event. The feedback edge (Observation → next Thought) is the loop's spine.

```
┌──────────────────────────────────────────────────────────────────────┐
│  MODEL LAYER   @anthropic-ai/sdk                                      │
│   emits text blocks (THOUGHT)  ·  emits tool_use block (ACTION)      │
└───────────┬──────────────────────────────┬────────────────────────────┘
   text ↓   │ hook                tool_use ↓│ hook              ▲ observation
┌───────────▼──────────────────────────────▼─────────────────────┼──────┐
│  LOOP LAYER   lib/agents/base.ts                                │      │
│                                                                 │      │
│  THOUGHT:  onText(text)                                         │      │
│  ACTION:   onToolCall(tc)  (before the call)      │      │
│  OBSERVE:  result = mcp.callTool()                              │      │
│            onToolResult(tc)                                      │      │
│            messages.push(user: toolResults) ──────────────┘      │
│            (observation re-enters context → conditions next THOUGHT)   │
└───────────┬──────────────────────────────┬────────────────────────────┘
            │ onText                        │ onToolCall / onToolResult    
┌───────────▼──────────────────────────────▼────────────────────────────┐
│  STREAM / UI BOUNDARY   lib/mcp/events.ts + route + useInvestigation │
│                                                                       │
│  reasoning_step (thought)   tool_call_start   tool_call_end          │
│        └──────── encodeEvent → NDJSON line → ReadableStream ──────────┤
│  hook: getReader() → split('\n') → JSON.parse → handle() (render)    │
└──────────────────────────────────────────────────────────────────────┘
```

A reader who sees only this diagram should grasp: three phases, each tapped by a hook, each streamed as an event — and the Observation loops back to feed the next Thought.

---

## Implementation in codebase

**Case A — implemented.**

### Thought (text reasoning → reasoning_step)

- **File:** `lib/agents/base.ts` (extraction) + `app/api/agent/route.ts` (event)
- **Function / class:** `runAgentLoop` text-block extraction → `hooksFor(agent).onText`
- **Line range:** `base.ts` L108–L113; `route.ts` L182–L184 (`stepFor(agent, 'thought', t)`; `stepFor` L176–L180)
- **Role:** The model's text blocks become `reasoning_step` events of kind `'thought'`.

### Action (tool_use → tool_call_start)

- **File:** `lib/agents/base.ts` + `lib/mcp/events.ts` + `app/api/agent/route.ts`
- **Function / class:** `runAgentLoop` per-tool loop → `onToolCall` → `tool_call_start`
- **Line range:** `base.ts` L138 (hook fired before the call); `events.ts` L6; `route.ts` L185
- **Role:** Emitted *before* execution so the UI shows the in-flight action.

### Observation (result → tool_call_end + fed back)

- **File:** `lib/agents/base.ts` + `lib/mcp/events.ts` + `app/api/agent/route.ts`
- **Function / class:** `runAgentLoop` → `onToolResult` → `tool_call_end`; result pushed as user turn
- **Line range:** `base.ts` L144 (run), L159 (hook), L171 (fed back); `events.ts` L7; `route.ts` L186–L194
- **Role:** `tool_call_end` carries `durationMs`/`result`/`error` for the UI; L171 re-enters the result into the conversation so the next Thought is conditioned on it.

### The streamed trace (product surface)

- **File:** `lib/mcp/events.ts` + `app/api/agent/route.ts` + `lib/hooks/useInvestigation.ts`
- **Function / class:** `encodeEvent` (NDJSON); route `ReadableStream` `start()`; the `useInvestigation` reader loop + `handle`
- **Line range:** `events.ts` L15 (`JSON.stringify(e)+'\n'`); `route.ts` L169–L265; `useInvestigation.ts` L184–L201 (reader, behind the `startedRef` StrictMode guard L43/L47), L97–L151 (`handle`)
- **Role:** Each phase becomes an NDJSON line streamed over `fetch` (no `EventSource`) and rendered live. The consumer moved out of `app/investigate/[id]/page.tsx` into the hook so both step pages (`useInvestigation(id,'diagnose')` and `(id,'recommend')`) share one reader.

**Pseudocode — one ReAct cycle, tapped** (`base.ts` L108–L171):

```typescript
// THOUGHT
const textBlocks = res.content.filter(b => b.type === 'text');     // L108
if (textBlocks.length && onText) onText(textBlocks.join(''));      // L112  → reasoning_step

const toolUses = res.content.filter(b => b.type === 'tool_use');   // L116
if (toolUses.length === 0) return { finalText, toolCalls };        // natural end

for (const tu of toolUses) {
  onToolCall?.(tc);                                                // L138  ACTION → tool_call_start
  const { result, durationMs } = await mcp.callTool(tu.name, tu.input);  // L144
  onToolResult?.(tc);                                              // L159  OBSERVATION → tool_call_end
}
messages.push({ role: 'user', content: toolResults });            // L171  observation → next THOUGHT
```

---

## Elaborate

### Where this pattern comes from

ReAct was introduced by Yao et al., "ReAct: Synergizing Reasoning and Acting in Language Models" (2022). The insight: letting a model interleave reasoning traces with actions outperforms reasoning-only (chain-of-thought) or acting-only baselines, because the reasoning informs which action to take and the action's observation corrects the reasoning. Anthropic's tool-use API implements the Action as `tool_use` blocks and the Observation as `tool_result` blocks — the exact mechanics `runAgentLoop` drives. blooming insights' addition over the paper is operational, not conceptual: it streams each phase as a typed event, turning an internal trace into a user-facing one.

### The deeper principle

The Observation-feeds-Thought edge is what distinguishes ReAct from a plan-then-execute agent. A plan-first agent decides all its tool calls up front and executes them blindly; ReAct decides one action, observes the result, and *re-reasons*. This makes it robust to surprises — if the first query returns empty, the next Thought adapts — at the cost of more model round-trips. The streaming layer makes that adaptivity legible: you literally watch the model change course after a surprising Observation. Reasoning that is observable is reasoning that is correctable.

### Where this breaks down

The streamed Thought is whatever text the model emits between tool calls — it is not guaranteed to be faithful to the model's actual decision process (models can post-hoc rationalize). So the trace is a strong *debugging* and *UX* aid but a weak *correctness proof*: a plausible-looking Thought can precede a wrong Action. It also breaks under verbosity — a chatty model floods the trace with low-value thoughts (the `if (t.trim())` guard at `route.ts` L183 only drops empties, not noise). And the Observation re-entered at L171 is the *truncated* result (16k cap), so a Thought conditioned on a truncated Observation can miss data that was cut.

### What to explore next

- **Reflexion** (Shinn et al., 2023) — adds a self-reflection step after Observations to improve subsequent attempts; a natural extension of the Thought phase.
- **Plan-and-Execute / ReWOO** — decouples planning from execution to cut round-trips; the counterpoint to ReAct's per-step re-reasoning.
- **Trace-based evals** — turning the streamed `reasoning_step`/`tool_call_*` events into an offline eval dataset (cross-link to ../05-evals-and-observability/); the trace is already structured for this.

---

## Project exercises

### Tag reasoning steps as hypothesis vs thought from the trace

- **Exercise ID:** C4.3 (adapted to blooming insights)
- **What to build:** The `ReasoningStep` type already supports `kind: 'thought' | 'tool_call' | 'hypothesis' | 'conclusion'` (`lib/mcp/types.ts` L47), but `onText` only ever emits `'thought'` (`route.ts` L183). Detect hypothesis-shaped reasoning (e.g., the model's text proposing a candidate cause) and emit it as kind `'hypothesis'`, so the trace visually distinguishes hypotheses from observations.
- **Why it earns its place:** Shows you can enrich a ReAct trace's semantics, the foundation for trace-based evals and better UX.
- **Files to touch:** `app/api/agent/route.ts` (L181–L195 `hooksFor`/`onText`); `lib/hooks/useInvestigation.ts` (`handle` rendering, L99–L111).
- **Done when:** A diagnostic run shows at least one step rendered as a hypothesis distinct from plain thoughts, and existing thought rendering is unchanged.
- **Estimated effort:** 1–4hr

### Persist the streamed trace as a reusable eval transcript

- **Exercise ID:** C3.10 (adapted to blooming insights)
- **What to build:** Extend `saveInvestigation` (`lib/state/investigations.ts` L30) usage so each completed investigation's full Thought/Action/Observation event list is exportable as a JSONL transcript file, then add a `/api/agent/trace/[id]` route that returns it — the raw material for an offline eval set. Note the live two-step split only `saveInvestigation`s on the combined `step==null` capture run (`route.ts` L254); a two-step live run hands its events through the client's sessionStorage instead.
- **Why it earns its place:** Demonstrates the trace is structured data, not just UI — the bridge from observability to evals.
- **Files to touch:** `lib/state/investigations.ts` (L30–L41); new `app/api/agent/trace/[id]/route.ts`; `lib/mcp/events.ts` (reuse `encodeEvent`).
- **Done when:** Hitting the trace route for a completed investigation returns valid JSONL with one `AgentEvent` per line, replayable by `decodeEvent`.
- **Estimated effort:** 1–4hr

---

## Interview defense

### What an interviewer is really asking

"What is ReAct and how did you implement it?" tests whether you know the three phases by name, can point to where each is produced in code, and understand the Observation→Thought feedback edge. The senior signal is recognizing that making the trace observable is a deliberate engineering choice with debugging and eval payoff — not an accident of streaming.

### Likely questions

**[mid] "Map Thought, Action, and Observation to specific code."**

Thought is the model's text blocks, extracted at `base.ts` L108 and surfaced via `onText` (L112) as a `reasoning_step`. Action is the `tool_use` block; `onToolCall` fires at L138 *before* the call, producing `tool_call_start`. Observation is the tool result: `mcp.callTool` runs at L144, `onToolResult` fires at L159 producing `tool_call_end`, and the result is pushed back as a user turn at L171.

```
THOUGHT  base.ts L108/112  →  reasoning_step
ACTION   base.ts L138      →  tool_call_start  (before call)
OBSERVE  base.ts L144/159  →  tool_call_end    (after call)
         base.ts L171      →  result re-enters context (next THOUGHT)
```

**[senior] "Why does the Observation get pushed back into the conversation, and what would break if it didn't?"**

The `messages.push({ role:'user', content: toolResults })` at L171 is what makes the next Thought conditioned on what the agent just saw — without it, the model would re-reason from its original prompt with no memory of the query result, defeating ReAct entirely. The model would loop, re-issuing the same Action because it never "sees" the answer. The push is the feedback edge; remove it and you have an actor with no observation, which is not ReAct.

```
with L171:    Action → Observation → (pushed) → next Thought sees result → adapts
without L171: Action → Observation → (lost)    → next Thought blind → repeats Action
```

**[arch] "The trace is shown to users. Is the streamed Thought a reliable explanation of the model's reasoning?"**

No — and conflating the two is a trap. The streamed Thought is whatever text the model emits between actions; models can post-hoc rationalize, so a plausible Thought can precede a wrong Action. The trace is excellent for *debugging* (you see which Observation the model misread) and *UX* (live progress), but it is not a faithfulness guarantee. Treating it as one is how teams ship "explainable AI" that explains nothing. The honest framing: the trace shows the path taken, not a proof the path was sound.

```
streamed Thought ≈ what the model SAID it was doing
actual decision  = opaque, may diverge
→ trace = debugging/UX surface, NOT a correctness proof
```

### The question candidates always dodge

**"Could the model's nice-looking reasoning be wrong even when every tool call succeeds?"**

Yes, and candidates dodge because admitting it undercuts the demo. Every Observation can be a valid Bloomreach result and the model can still draw a wrong conclusion from them — the Thought at the end is not validated against the Observations, it is generated from them. The streamed trace makes this *visible* (you can read the leap), but visibility is not prevention. The honest answer names the gap and points to evals (../05-evals-and-observability/) as the actual correctness mechanism, not the trace.

### One-line anchors

- `lib/agents/base.ts` L171 — Observation fed back as a user turn — the ReAct feedback edge.
- `lib/agents/base.ts` L138 — `onToolCall` fired before the call — the Action event.
- `lib/agents/base.ts` L108–L113 — text blocks → `onText` — the Thought.
- `lib/mcp/events.ts` L6–L7 — `tool_call_start` / `tool_call_end` — Action and Observation on the wire.
- `lib/hooks/useInvestigation.ts` L184–L201 — `getReader()` + split on `\n` — the trace consumed live (no `EventSource`), once per mount behind `startedRef`.

---

## See also

→ 02-tool-calling.md · → 01-agents-vs-chains.md · → 06-error-recovery.md · → ../05-evals-and-observability/ · → ../../study-system-design/05-streaming-ndjson.md · → ../../study-system-design/06-multi-agent-orchestration.md

---
Updated: 2026-05-28 — Moved the trace consumer from `app/investigate/[id]/page.tsx` to `lib/hooks/useInvestigation.ts` (StrictMode-safe `startedRef` reader, shared by both step pages) and refreshed all `route.ts` hook/stream and `ReasoningStep` line refs.
Updated: 2026-05-30 — Applied study.md v1.46 Move-2-variant (load-bearing skeleton: isolate the kernel + what-breaks-if-removed + skeleton vs hardening) to How it works.
Updated: 2026-05-30 — Migrated to study.md v1.47 template (Phase 1+2 mechanical): removed Tradeoffs / Tech reference / Summary sections; renamed "In this codebase" → "Implementation in codebase"; moved See also to a bottom block. "Why care" preserved pending Phase 3 (Zoom out, then zoom in + LAYERS diagram) authoring.
Updated: 2026-05-30 — Phase 3 of study.md v1.47 migration: replaced "Why care" block with "Zoom out, then zoom in" (LAYERS diagram + zoom-in paragraph) per format.md.
Updated: 2026-05-31 — Applied study.md v1.48: scrubbed "How it works" of file paths, line refs, and real-code fences; replaced with generic role labels + pseudocode per format.md. Codebase-specific anchoring lives exclusively in "Implementation in codebase".
Updated: 2026-05-31 — Applied study.md v1.50: added Structure pass block (layers · axis · seams) between Zoom out and How it works per format.md's new Block 3.
Updated: 2026-06-24 — Stripped `## Validate` block per spec v1.68.3 (the Validate primitive was removed from the per-concept template; block 10 is now `See also`).
