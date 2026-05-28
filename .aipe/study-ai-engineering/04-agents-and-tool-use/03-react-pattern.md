# The ReAct pattern

**Industry name(s):** ReAct (Reason + Act), Thought–Action–Observation loop, interleaved reasoning and tool use
**Type:** Industry standard · Language-agnostic

> ReAct interleaves Thought (the model reasons in text), Action (it emits a tool call), and Observation (your code runs the tool and feeds the result back). blooming insights makes each step a streamed NDJSON event — `onText` → reasoning_step is the Thought, `tool_call_start` is the Action, `tool_call_end` + result-as-next-user-turn is the Observation — so the reasoning trace is a live product surface.

**See also:** → 02-tool-calling.md · → 01-agents-vs-chains.md · → 06-error-recovery.md · → ../05-evals-and-observability/ · → ../../study-system-design-dsa/01-system-design/05-streaming-ndjson.md · → ../../study-system-design-dsa/01-system-design/06-multi-agent-orchestration.md

---

## Why care

You have built a feature where the UI shows what the system is doing as it does it: an upload that streams "validating… uploading… processing… done," each stage appearing the moment it starts. You did not wait for the whole operation and dump a summary; you emitted an event per stage so the user could watch progress and, when it stalled, see *which* stage stalled. That intuition — render the steps, not just the result — is exactly what ReAct gives an agent.

The question this file answers: how does an agent alternate between reasoning and acting, and how do you make that alternation observable instead of a black box?

**Answering it matters because an agent that only returns its final answer is undebuggable and untrustworthy.** When a diagnosis comes back wrong, "the model got it wrong" is not an answer you can act on. You need to see: what did it *think*, what did it *query*, what did it *see*, and where did the reasoning go off the rails. ReAct names those three moves — Thought, Action, Observation — and blooming insights streams each one as a distinct event, so the trace is not a log you grep after the fact; it is the thing the user watches on the investigation page in real time. The trace being a product surface is what makes the reasoning auditable by the analyst, not just by the engineer.

Before and after making the loop observable:

```
Black-box agent                         ReAct, streamed (this codebase)
────────────────────────────            ──────────────────────────────────
[60s of silence]                        thought:  "checking the mobile funnel…"
                                        action:   tool_call_start get_funnel
"mobile conversion dropped              observation: tool_call_end (320ms)
 due to a checkout bug"                 thought:  "step 3 has the drop…"
                                        action:   tool_call_start execute_analytics_eql
why? on what evidence? unknown          observation: tool_call_end (910ms)
                                        conclusion: grounded, with visible evidence
```

One-line summary: **Thought is the text the model emits, Action is the tool call, Observation is the result fed back — and here all three are streamed events, which makes the loop a debuggable product.**

---

## How it works

**Mental model.** ReAct is a `while` loop where each iteration has three phases, and blooming insights attaches a callback to each phase that emits an event. Think of the loop as a state machine that cycles `THINK → ACT → OBSERVE → THINK …`, where `runAgentLoop`'s hooks (`onText`, `onToolCall`, `onToolResult`) are the taps that turn each transition into an NDJSON line the client renders.

```
ReAct cycle (one turn of runAgentLoop)
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
   │ result pushed as user turn  │  (base.ts L171 — feeds next THOUGHT)
   └──────────────┬──────────────┘
                  ▼  loop back to THOUGHT (model reads the observation)
```

The Observation is fed back as the next user message (`base.ts` L171), so the model's *next* Thought is conditioned on what it just saw. That feedback edge — observation becomes the input to the next reasoning step — is the entire point of ReAct: the model updates its belief state after every action instead of planning everything up front.

---

### Thought — the model reasons in text (onText)

When the model emits text blocks (not tool calls), that text *is* its reasoning. `runAgentLoop` extracts those text blocks and hands them to the `onText` hook (`base.ts` L108–L113).

```
base.ts — text extraction   (L108–L113)
─────────────────────────────────────────────────────────────
 textBlocks = res.content.filter(b => b.type === 'text')   L108
 if (textBlocks.length > 0 && onText)                      L111
   onText(textBlocks.map(b => b.text).join(''))            L112
```

The route wires `onText` to emit a `reasoning_step` of kind `'thought'` (`route.ts` L118–L120):

```
route.ts — hooksFor(agent).onText   (L118–L120)
─────────────────────────────────────────────────────────────
 onText: (t) => { if (t.trim()) stepFor(agent, 'thought', t) }
 stepFor → send({ type:'reasoning_step', step:{ kind:'thought', content:t, agent } })
```

So every chunk of the model's textual reasoning becomes a `reasoning_step` event on the wire. On the investigate page, `handleEvent` (`page.tsx` L63–L75) appends it as a visible thought bubble. The Thought is not hidden chain-of-thought you discard — it is rendered.

---

### Action — the model emits a tool call (onToolCall)

When the model decides to act, it emits a `tool_use` block. `runAgentLoop` fires `onToolCall` *before* executing the tool (`base.ts` L138), so the UI can show "running `get_funnel`…" while the call is in flight.

```
base.ts — action hook   (L129–L138)
─────────────────────────────────────────────────────────────
 for tu of toolUses:                                       L129
   tc = { id, agent, toolName: tu.name, args: tu.input }   L130
   onToolCall?.(tc)   ← fired BEFORE the call               L138
```

The route maps this to a `tool_call_start` event (`route.ts` L121–L122, `events.ts` L6):

```
events.ts — Action event   (L6)
─────────────────────────────────────────────────────────────
 | { type:'tool_call_start'; toolName: string; agent: AgentName }
```

The page renders a tool row with `status: 'running'` (`page.tsx` L76–L87). The Action is the second visible phase: the user sees not just that the agent is thinking, but *what* it chose to do.

---

### Observation — code runs the tool, result feeds back (onToolResult)

After the tool returns, `runAgentLoop` fires `onToolResult` (`base.ts` L159) and pushes the result back into the conversation as a user turn (`base.ts` L171). The route maps `onToolResult` to a `tool_call_end` event carrying `durationMs`, a truncated `result`, and any `error` (`route.ts` L123–L131, `events.ts` L7).

```
base.ts — observation     (L144–L171)
─────────────────────────────────────────────────────────────
 { result, durationMs } = await mcp.callTool(tu.name, tu.input)  L144
 tc.result = result; tc.durationMs = durationMs                  L148
 onToolResult?.(tc)                                              L159  → tool_call_end
 ...
 messages.push({ role:'user', content: toolResults })            L171  ← OBSERVATION fed back
```

```
events.ts — Observation event   (L7)
─────────────────────────────────────────────────────────────
 | { type:'tool_call_end'; toolName; agent; durationMs; result?; error? }
```

Two roles in one phase. The `tool_call_end` event is the Observation made *visible* (the page flips the tool row to `status: 'done'` with its duration, `page.tsx` L88–L107). The `messages.push` at L171 is the Observation made *available to the model* — the result re-enters the context so the next Thought is informed by it. The same data serves the UI and the next reasoning turn; that dual role is what makes the trace both a debugging surface and a functional part of the loop.

---

### The trace as a product surface

The events are NDJSON (`encodeEvent` = `JSON.stringify(e) + '\n'`, `events.ts` L15). The route enqueues them into a `ReadableStream` (`route.ts` L105–L169); the client reads them with `res.body.getReader()` + `TextDecoder`, splits on `\n`, and `JSON.parse`s each line (`page.tsx` L143–L159). There is no `EventSource` — it is a raw streamed reader over `fetch`. Because the Thought/Action/Observation events arrive *as they happen*, the investigation page is a live trace: the analyst watches the agent reason, query, and observe, step by step. When a diagnosis is wrong, the analyst scrolls the trace and sees which Observation the reasoning misread — debugging by reading, not by re-running.

```
NDJSON stream over fetch (no EventSource)
─────────────────────────────────────────────────────────────
 route start():  enqueue(encodeEvent(reasoning_step))  ─┐
                 enqueue(encodeEvent(tool_call_start))   │  one JSON
                 enqueue(encodeEvent(tool_call_end))     │  per line,
                 enqueue(encodeEvent(diagnosis))         │  '\n'-delimited
                 enqueue(encodeEvent(done))             ─┘
 page reader:    buf += decode(value); lines = buf.split('\n')
                 for line: handleEvent(JSON.parse(line))   ← renders each phase
```

---

### The principle

**Make the reasoning loop emit its phases as it runs.** ReAct's value is not just that the model reasons before acting — it is that reasoning, acting, and observing are *distinct, interleaved steps* you can tap. The moment you give each step a name and an event, the agent stops being a black box: you can stream it to a user, log it for evals, and debug it by reading the trace. A final-answer-only agent throws away the most valuable artifact it produces — the path it took. blooming insights keeps the path and makes it the product.

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
│  THOUGHT:  onText(text)            L108–113                     │      │
│  ACTION:   onToolCall(tc)          L138  (before the call)      │      │
│  OBSERVE:  result = mcp.callTool() L144                         │      │
│            onToolResult(tc)        L159                          │      │
│            messages.push(user: toolResults)  L171 ──────────────┘      │
│            (observation re-enters context → conditions next THOUGHT)   │
└───────────┬──────────────────────────────┬────────────────────────────┘
            │ onText                        │ onToolCall / onToolResult    
┌───────────▼──────────────────────────────▼────────────────────────────┐
│  STREAM / UI BOUNDARY   lib/mcp/events.ts + route + page              │
│                                                                       │
│  reasoning_step (thought)   tool_call_start   tool_call_end          │
│        └──────── encodeEvent → NDJSON line → ReadableStream ──────────┤
│  page: getReader() → split('\n') → JSON.parse → handleEvent (render) │
└──────────────────────────────────────────────────────────────────────┘
```

A reader who sees only this diagram should grasp: three phases, each tapped by a hook, each streamed as an event — and the Observation loops back to feed the next Thought.

---

## In this codebase

**Case A — implemented.**

### Thought (text reasoning → reasoning_step)

- **File:** `lib/agents/base.ts` (extraction) + `app/api/agent/route.ts` (event)
- **Function / class:** `runAgentLoop` text-block extraction → `hooksFor(agent).onText`
- **Line range:** `base.ts` L108–L113; `route.ts` L118–L120 (`stepFor(agent, 'thought', t)`)
- **Role:** The model's text blocks become `reasoning_step` events of kind `'thought'`.

### Action (tool_use → tool_call_start)

- **File:** `lib/agents/base.ts` + `lib/mcp/events.ts` + `app/api/agent/route.ts`
- **Function / class:** `runAgentLoop` per-tool loop → `onToolCall` → `tool_call_start`
- **Line range:** `base.ts` L138 (hook fired before the call); `events.ts` L6; `route.ts` L121–L122
- **Role:** Emitted *before* execution so the UI shows the in-flight action.

### Observation (result → tool_call_end + fed back)

- **File:** `lib/agents/base.ts` + `lib/mcp/events.ts` + `app/api/agent/route.ts`
- **Function / class:** `runAgentLoop` → `onToolResult` → `tool_call_end`; result pushed as user turn
- **Line range:** `base.ts` L144 (run), L159 (hook), L171 (fed back); `events.ts` L7; `route.ts` L123–L131
- **Role:** `tool_call_end` carries `durationMs`/`result`/`error` for the UI; L171 re-enters the result into the conversation so the next Thought is conditioned on it.

### The streamed trace (product surface)

- **File:** `lib/mcp/events.ts` + `app/api/agent/route.ts` + `app/investigate/[id]/page.tsx`
- **Function / class:** `encodeEvent` (NDJSON); route `ReadableStream` `start()`; page reader loop + `handleEvent`
- **Line range:** `events.ts` L15 (`JSON.stringify(e)+'\n'`); `route.ts` L105–L169; `page.tsx` L143–L159 (reader), L60–L123 (`handleEvent`)
- **Role:** Each phase becomes an NDJSON line streamed over `fetch` (no `EventSource`) and rendered live.

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

The streamed Thought is whatever text the model emits between tool calls — it is not guaranteed to be faithful to the model's actual decision process (models can post-hoc rationalize). So the trace is a strong *debugging* and *UX* aid but a weak *correctness proof*: a plausible-looking Thought can precede a wrong Action. It also breaks under verbosity — a chatty model floods the trace with low-value thoughts (the `if (t.trim())` guard at `route.ts` L119 only drops empties, not noise). And the Observation re-entered at L171 is the *truncated* result (16k cap), so a Thought conditioned on a truncated Observation can miss data that was cut.

### What to explore next

- **Reflexion** (Shinn et al., 2023) — adds a self-reflection step after Observations to improve subsequent attempts; a natural extension of the Thought phase.
- **Plan-and-Execute / ReWOO** — decouples planning from execution to cut round-trips; the counterpoint to ReAct's per-step re-reasoning.
- **Trace-based evals** — turning the streamed `reasoning_step`/`tool_call_*` events into an offline eval dataset (cross-link to ../05-evals-and-observability/); the trace is already structured for this.

---

## Tradeoffs

### Comparison: streamed ReAct vs alternatives

| Dimension | This codebase (streamed ReAct) | Plan-then-execute | Final-answer-only agent |
|---|---|---|---|
| Adaptivity to surprises | High — re-reasons each Observation | Low — plan fixed up front | High internally, invisible |
| Round-trips / latency | One per Thought→Action cycle | Fewer (batch plan) | Same as ReAct internally |
| Debuggability | High — every phase is an event | Medium — plan + results | None — black box |
| UX (live progress) | Live trace on the page | Plan then results dump | Spinner then answer |
| Faithfulness guarantee | None — Thought may rationalize | None | None |

**What we gave up.** Round-trips. Each Thought→Action→Observation cycle is a separate `anthropic.messages.create` call (`base.ts` L102), so a 6-tool investigation is ~7 model round-trips plus the synthesis call. A plan-then-execute agent could batch the tool plan into fewer model calls. We accept the extra round-trips because per-step re-reasoning is what lets the agent adapt to empty or surprising results — and the streamed trace turns those round-trips into visible progress rather than dead silence.

**What the alternative would have cost.** A final-answer-only agent would be simpler and slightly cheaper (no per-phase hooks, no NDJSON), but it would be undebuggable: a wrong diagnosis would offer no trace to inspect, no place to see which Observation the model misread. The entire debugging story would become "re-run with logging and hope it reproduces." The streamed trace is cheap to add (three hooks) and pays for itself the first time a diagnosis goes wrong.

**The breakpoint.** Streamed ReAct is right while traces are read by humans and the per-step round-trips fit the 60s `maxDuration` budget. It stops being right at high tool counts where per-step re-reasoning blows the latency budget — at which point batching (plan-and-execute) for the exploration phase, while keeping ReAct for the final synthesis, becomes the move. The trace surface stays; only the loop's round-trip discipline changes.

---

## Tech reference (industry pairing)

### @anthropic-ai/sdk tool use (Action/Observation blocks)

- **Codebase uses:** `tool_use` blocks are the Action (`base.ts` L116); `tool_result` blocks pushed at L171 are the Observation re-entering the context.
- **Why it's here:** It is the API-level expression of ReAct's act/observe phases.
- **Leading today:** Anthropic tool use and OpenAI function calling are the adoption-leading substrates in 2026.
- **Why it leads:** Native interleaving of text reasoning and tool blocks in one message stream.
- **Runner-up:** Gemini function calling — comparable mechanics, growing adoption.

### NDJSON over fetch ReadableStream (the trace transport)

- **Codebase uses:** `encodeEvent` writes `JSON.stringify(e)+'\n'` (`events.ts` L15); the page reads with `getReader()` + `TextDecoder` and splits on `\n` (`page.tsx` L143–L159).
- **Why it's here:** Each ReAct phase is one self-contained JSON object; line-delimited JSON streams them with zero framing overhead and no `EventSource` constraints.
- **Leading today:** NDJSON / line-delimited streaming and SSE are the two adoption-leading agent-trace transports in 2026.
- **Why it leads:** Works over plain `fetch`, supports POST bodies, and parses incrementally line by line.
- **Runner-up:** Server-Sent Events (`EventSource`) — simpler client API, but GET-only and less flexible framing.

### ReAct (the reasoning pattern)

- **Codebase uses:** The Thought/Action/Observation cycle is `runAgentLoop`'s per-turn structure with hooks on each phase.
- **Why it's here:** It is the pattern that makes per-step re-reasoning and an observable trace possible.
- **Leading today:** ReAct is the adoption-leading agent reasoning pattern in 2026; Reflexion and Plan-and-Execute are innovation-leading refinements.
- **Why it leads:** Robustness to surprising observations plus a natural, inspectable trace.
- **Runner-up:** Plan-and-Execute / ReWOO — fewer round-trips, less adaptive.

---

## Project exercises

### Tag reasoning steps as hypothesis vs thought from the trace

- **Exercise ID:** C4.3 (adapted to blooming insights)
- **What to build:** The `ReasoningStep` type already supports `kind: 'hypothesis' | 'conclusion'` (`lib/mcp/types.ts` L32), but `onText` only ever emits `'thought'` (`route.ts` L119). Detect hypothesis-shaped reasoning (e.g., the model's text proposing a candidate cause) and emit it as kind `'hypothesis'`, so the trace visually distinguishes hypotheses from observations.
- **Why it earns its place:** Shows you can enrich a ReAct trace's semantics, the foundation for trace-based evals and better UX.
- **Files to touch:** `app/api/agent/route.ts` (L117–L120 `onText`); `app/investigate/[id]/page.tsx` (`handleEvent` rendering, L63–L75).
- **Done when:** A diagnostic run shows at least one step rendered as a hypothesis distinct from plain thoughts, and existing thought rendering is unchanged.
- **Estimated effort:** 1–4hr

### Persist the streamed trace as a reusable eval transcript

- **Exercise ID:** C3.10 (adapted to blooming insights)
- **What to build:** Extend `saveInvestigation` (`lib/state/investigations.ts` L30) usage so each completed investigation's full Thought/Action/Observation event list is exportable as a JSONL transcript file, then add a `/api/agent/trace/[id]` route that returns it — the raw material for an offline eval set.
- **Why it earns its place:** Demonstrates the trace is structured data, not just UI — the bridge from observability to evals.
- **Files to touch:** `lib/state/investigations.ts` (L30–L41); new `app/api/agent/trace/[id]/route.ts`; `lib/mcp/events.ts` (reuse `encodeEvent`).
- **Done when:** Hitting the trace route for a completed investigation returns valid JSONL with one `AgentEvent` per line, replayable by `decodeEvent`.
- **Estimated effort:** 1–4hr

---

## Summary

ReAct interleaves Thought (the model's text reasoning), Action (a `tool_use` block), and Observation (the tool result fed back). blooming insights taps each phase with a `runAgentLoop` hook — `onText` → `reasoning_step` thought (`base.ts` L108–L113), `onToolCall` → `tool_call_start` (L138), `onToolResult` → `tool_call_end` (L159) — and streams them as NDJSON over a `fetch` `ReadableStream`. The Observation does double duty: `tool_call_end` renders it on the page, and the `messages.push` at L171 feeds it back so the next Thought is conditioned on it. The trace is a live product surface, which makes the loop debuggable by reading.

Key points:
- Thought = model text (`onText`), Action = `tool_use` (`onToolCall`, fired before the call), Observation = result (`onToolResult` + L171).
- The Observation re-enters the context at `base.ts` L171, conditioning the next Thought — that feedback edge is the spine of ReAct.
- Every phase is an NDJSON event streamed over `fetch` (no `EventSource`), rendered live on the investigate page.
- The trace is a debugging and UX surface, not a correctness proof — a plausible Thought can precede a wrong Action.
- The Observation fed back is truncated (16k cap), so a Thought can be conditioned on a partial result.

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
- `app/investigate/[id]/page.tsx` L143–L159 — `getReader()` + split on `\n` — the trace consumed live (no `EventSource`).

---

## Validate

### Level 1 — Reconstruct

From memory, draw the ReAct cycle and label each phase with (a) the model output that produces it, (b) the `runAgentLoop` hook that taps it, (c) the NDJSON event it becomes. Draw the feedback edge from Observation back to the next Thought.

### Level 2 — Explain

Out loud: explain why the Observation is pushed back into `messages` (`base.ts` L171), and why removing that line would turn the agent from ReAct into a blind actor that repeats itself.

### Level 3 — Apply

Scenario: the investigate page shows a `tool_call_start` for `get_funnel` but never a matching `tool_call_end`, and the stream hangs. Where do you look? Check `lib/agents/base.ts` L144–L159: did `mcp.callTool` resolve (the `try` at L143)? If it threw, L153 sets `tc.error` and `onToolResult` (L159) should still fire a `tool_call_end` with an `error`. If neither fired, the call is still in flight — check the MCP spacing/retry path. Trace which hook did not fire and why.

### Level 4 — Defend

A reviewer says: "Showing users the model's raw reasoning is a liability — it might be wrong and we are presenting it as fact." Defend the streamed trace as a debugging/UX surface while conceding the reviewer's point about faithfulness, and name where correctness is actually enforced (validators + evals, not the trace).

### Quick check — code reference test

Which line in `lib/agents/base.ts` turns an Observation into input for the model's next Thought, and what role does that message take? (Answer: L171 — `messages.push({ role: 'user', content: toolResults })`; the result enters as a `user` turn.)
