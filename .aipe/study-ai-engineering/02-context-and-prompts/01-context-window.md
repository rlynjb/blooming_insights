# The context window (and the character budgets that keep work inside it)

**Industry name(s):** context window, context-window budgeting, prompt packing, output reservation
**Type:** Industry standard · Language-agnostic

> The context window is one fixed-size array every part of a request shares — system prompt, message history, tool results, and the room reserved for the answer all compete for the same slots; blooming insights keeps the request inside it by *character* budgeting at every inflow (`truncate`/`MAX_TOOL_RESULT_CHARS = 16_000`, route `TRUNC = 4000`, `schemaSummary` caps) and by a forced tool-less final turn that stops the transcript growing so the model has room to synthesize.


---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** The context window is the fixed-size array every model call shares — system prompt, message history, tool results, and the answer all compete for the same slots. Defending it spans two bands: the Per-agent definitions build the prefix (`schemaSummary` caps in `lib/agents/monitoring.ts` L15–L48), and the Agent loop grows the transcript turn by turn (`truncate` at `lib/agents/base.ts` L31–L34, `forceFinal` at L90–L91 / L101). The Provider is where the bounded array meets the model.

```
  Zoom out — where the window is defended

  ┌─ Per-agent (builds the prefix) ──────────────────┐
  │  schemaSummary caps  monitoring.ts L15–48        │
  │    20 events / 10 props / 30 cprops              │
  └─────────────────────────┬────────────────────────┘
                            │  system prefix
  ┌─ Agent loop (grows the transcript) ──────────────┐  ← we are here
  │  ★ MAX_TOOL_RESULT_CHARS = 16_000 ★ base.ts L29  │
  │  truncate per tool_result   L31–34, applied L150 │
  │  forceFinal → omit tools    L90–91, L101         │
  │    → transcript STOPS growing                    │
  └─────────────────────────┬────────────────────────┘
                            │  bounded array
  ┌─ Provider ──────────────▼────────────────────────┐
  │  anthropic.messages.create({system, messages,    │
  │     max_tokens })   ← reserves output room       │
  │  one shared array: input slots + output slots    │
  └──────────────────────────────────────────────────┘
```

**Zoom out — narrow to the concept.** The question is: the window is a fixed number of slots, and each tool call you feed back consumes more of them — so how do you keep a six-call investigation inside it while leaving the model enough room to actually answer? Two disciplines: bound every inflow at the door (`truncate`, `schemaSummary`) and stop the loop filling it before the model synthesizes (the forced tool-less final turn). How it works walks each budget and the tool-omission move that protects the answer's room.

---

## Structure pass

**Layers.** Three layers compete for the same fixed-size slot array: the per-agent prefix construction (the system prompt + `schemaSummary`), the agent loop (which grows the transcript turn by turn and runs `truncate` on each tool result), and the provider's call where `max_tokens` reserves room for the answer at the end. The window is the *shared resource* every layer writes into.

**Axis: state.** What's in the message array, how big is it, and when does it stop growing? This axis is the right lens because the context window is fundamentally a state-quantity problem: every layer either adds to it (prefix, transcript, tool results) or constrains it (`truncate`, `forceFinal`, `max_tokens`). Cost is downstream of state size; control is downstream of state size; state-occupancy is the upstream measurement.

**Seams.** The cosmetic seam is between the per-agent prefix and the agent loop's first turn — both are state-additions. The load-bearing seam is between the agent loop's turn growth and the forced-final-turn moment: state-growth flips here from "transcript can grow another tool-call cycle" to "tools are omitted; the model must synthesize from what's already here." This is where the loop yields the remaining window back to the model for output. A second cosmetic seam exists between agent loop and provider — the array crosses unchanged.

```
  Structure pass — context window

  ┌─ 1. LAYERS ───────────────────────────────────┐
  │  per-agent prefix (system + schemaSummary)     │
  │  agent loop (transcript growth + truncate)     │
  │  provider call (max_tokens reserves answer)    │
  └────────────────────────┬───────────────────────┘
                           │  pick the axis
  ┌─ 2. AXIS ─────────────▼────────────────────────┐
  │  state: what's in the array, how big, when     │
  │  does it stop growing?                         │
  └────────────────────────┬───────────────────────┘
                           │  trace across layers, find flips
  ┌─ 3. SEAMS ────────────▼────────────────────────┐
  │  prefix↔loop: cosmetic (both add state)        │
  │  loop-grow↔forceFinal: LOAD-BEARING            │
  │    "can still grow" → "tools off; must answer" │
  │    yields the rest of the window to output     │
  └────────────────────────┬───────────────────────┘
                           ▼
                   Block 4 — How it works
```

The skeleton is mapped — the rest of this file walks the mechanics that hang off it.

## How it works

**Mental model.** Picture the request as one fixed-length array the model reads top to bottom. Each entry — system prompt, user turn, assistant turn, tool result — occupies real slots. The model's *output* needs free slots at the end. If the input entries fill the array, there is nowhere for the answer to go.

```
context window = one fixed-size array (≈200k tokens for the model used)
┌──────────────────────────────────────────────────────────────────┐
│ system prompt │ user │ asst │ tool_result │ asst │ tool_result │ … │  ← input
└──────────────────────────────────────────────────────────────────┘
                                                          ▲
                                                          │ must leave
                                                          │ room here
                                              ┌───────────┴──────────┐
                                              │  output (max_tokens) │  ← answer
                                              └──────────────────────┘
   if input fills the array → output has no room → truncated/empty answer
```

This system never measures this array in tokens (see → ../01-llm-foundations/02-tokenization.md — it bounds by characters as a coarse proxy). What matters here is the *shape*: the window is shared, the answer competes with the inputs, and the system has to actively defend the answer's room.

---

### Inflow budget 1 — tool results (the tool-result cap)

The biggest single consumer of window space is a raw query tool result. The shared agent loop caps it before it re-enters the conversation:

```
  MAX_TOOL_RESULT_CHARS = 16_000

  function truncate(s):
      if length(s) <= MAX_TOOL_RESULT_CHARS:
          return s
      return slice(s, 0, MAX_TOOL_RESULT_CHARS) + "\n…[truncated]"
```

Every tool result is JSON-serialized and passed through `truncate` before being pushed back as a tool-result block. A 60,000-char query response becomes 16,000 chars plus a marker. Across the diagnostic agent's six-call budget, this caps the *cumulative* tool-result contribution to ~96,000 characters — the load-bearing defense against the transcript outgrowing the window.

```
query result: 60,000 chars
      │  truncate()   (the agent-loop cap)
      ▼
16,000 chars + "\n…[truncated]"
      │  fed back (stringify + truncate) → tool_result block
      ▼
each of 6 calls ≤ 16,000 chars → transcript stays bounded
```

### Inflow budget 2 — the UI stream (the route stream cap)

A *separate, smaller* budget governs what is streamed to the browser — this one does not protect the window, it protects the wire. The route handler runs a different cap:

```
  TRUNC = 4000

  function trunc(v):
      s = JSON.serialize(v)
      if s and length(s) > TRUNC:
          return slice(s, 0, TRUNC) + "…"
      return v
```

The route applies `trunc` to each tool-call result before it goes into a `tool_call_end` streaming event. It is unrelated to the model's window. Two budgets, two purposes: 16,000 defends the model's context array; 4,000 defends the streaming payload size to the UI.

```
tool result ──┬── truncate(16_000) ──▶ tool_result block ──▶ model window
              └── trunc(4000)      ──▶ tool_call_end event ──▶ browser
   same source, two different ceilings, two different reasons
```

### Inflow budget 3 — the schema prefix (schema-summary caps)

The system prompt's static prefix is the workspace schema, which is ~112KB raw. The monitoring agent builds a compact summary instead of inlining the whole thing, with three hard caps:

```
schemaSummary caps
  MAX_EVENTS          = 20   ← top 20 events only
  MAX_PROPS_PER_EVENT = 10   ← 10 properties per event
  MAX_CPROPS          = 30   ← 30 customer properties
```

The comment alongside is explicit: "Compact, token-bounded schema summary for the prompt (NOT the full 112KB schema)." This prefix is shared by every agent (diagnostic and recommendation both reuse the same summary helper), so capping it once shrinks the fixed cost of *every* agent turn. Inlining the full 112KB schema would consume the window before a single tool result arrived.

### Reserving room for the answer — the forced tool-less final turn

Bounding inflow is half the problem. The other half: the loop keeps *adding* turns, and each added turn shrinks the room left for the answer. The agent loop stops that growth deliberately. A `budgetSpent` check is true once tool calls reach the agent's budget; a `forceFinal` flag is true on that turn or the last allowed turn; and the loop withholds the tool schemas on a `forceFinal` turn:

```
  budgetSpent = (maxToolCalls is set) and (count(toolCalls) >= maxToolCalls)
  forceFinal  = (turn == maxTurns - 1) or budgetSpent
  ...
  if not forceFinal:
      params.tools = toolSchemas
```

With no tool schemas in the request, the model *cannot* emit a `tool_use` block, so it cannot trigger another `tool_result` to be appended. The transcript stops growing. The model is now forced to spend its remaining `max_tokens` writing the answer rather than asking for more data — exactly the room the inflow budgets reserved.

```
turn  toolCalls  forceFinal  tools sent?  transcript
────  ─────────  ──────────  ───────────  ───────────────────────────
  0       0        false        yes        + asst + tool_result (grows)
  1       2        false        yes        + asst + tool_result (grows)
  2       4        false        yes        + asst + tool_result (grows)
  3       6         true         NO        + asst (text only — STOPS)
                                            ↑ no tool_result appended;
                                              room left = answer budget
```

### The principle

A finite shared buffer demands two disciplines, not one: bound every inflow at the door, and stop filling it before the consumer needs room. You bound inflow with character caps (16,000 tool results, 30/20/10 schema, separately 4,000 for the UI) and reserve the answer's room by withholding tools on the final turn so the transcript cannot grow past the point where the model still has space to respond. The window is shared; the answer is what you are protecting.

---

### Code in this codebase

#### Files, functions, and line ranges

- **Tool-result inflow cap:** `MAX_TOOL_RESULT_CHARS = 16_000` (`lib/agents/base.ts` L29) and `truncate(s)` (L31–L34). Applied at L150 before each `tool_result` block (pushed L161–L171).
- **UI-stream cap (separate):** `TRUNC = 4000` and `trunc(v)` — `app/api/agent/route.ts` L99–L103. Applied at L192 to the `tool_call_end` event payload only — not the window.
- **Schema-prefix caps:** `MAX_EVENTS = 20` (`lib/agents/monitoring.ts` L21), `MAX_PROPS_PER_EVENT = 10` (L22), `MAX_CPROPS = 30` (L33); whole `schemaSummary` L15–L48; intent comment at L14. Imported and reused by `lib/agents/diagnostic.ts` L6 and `lib/agents/recommendation.ts` L6.
- **Answer-room reservation:** `budgetSpent`/`forceFinal` (`lib/agents/base.ts` L90–L91), tools withheld on the final turn at L101, the create call at L102. Per-agent tool budgets: monitoring 6 (`monitoring.ts` L74), diagnostic 6 (`diagnostic.ts` L61), recommendation 4 (`recommendation.ts` L57).
- **Output cap (the one real token control):** `max_tokens` default `4096` (`lib/agents/base.ts` L74), synthesis `2048` (`diagnostic.ts` L99 / `recommendation.ts` L98), classifier `16` (`lib/agents/intent.ts` L20).

The codebase bounds the *input* by characters and reserves the *output* with `max_tokens` and the forced-final turn. It never reads `res.usage` to learn how full the window actually got — that gap is named in → ../01-llm-foundations/06-token-economics.md.

---

## The context window — diagram

This diagram spans the layers a request crosses and where each budget is applied. The Service layer enforces every inflow cap in characters; the Provider boundary is where the bounded array meets the model and `max_tokens` reserves the output room.

```
┌──────────────────────────────────────────────────────────────────────┐
│  SERVICE LAYER — inflow bounded in CHARACTERS                         │
│                                                                       │
│  schema (112KB)                                                       │
│     │ schemaSummary  monitoring.ts (20 events/10 props/30)    │
│     ▼                                                                 │
│  compact schema string ──┐                                           │
│                          │ system prefix (shared by all agents)      │
│  EQL tool result (60KB)  │                                           │
│     │ truncate  base.ts (16_000)                              │
│     ▼                    │                                           │
│  16,000-char result ─────┤                                           │
│                          ▼                                           │
│        messages[]  (system + turns + tool_results — grows per turn)  │
│                          │                                           │
│  forced-final turn  base.ts                                          │
│     forceFinal? → omit tools → transcript STOPS growing       │
└───────────────────────────┬───────────────────────────────────────────┘
                            │  the bounded array crosses to the model;
                            │  max_tokens reserves the OUTPUT slots
┌───────────────────────────▼───────────────────────────────────────────┐
│  PROVIDER BOUNDARY — the fixed-size context window                   │
│                                                                       │
│  anthropic.messages.create({ system, messages, max_tokens })         │
│     input slots = bounded transcript │ output slots = max_tokens     │
└────────────────────────────────────────────────────────────────────────┘

  (separate, parallel)  route.ts TRUNC=4000  bounds the UI stream payload,
  NOT the window — different budget, different layer, different purpose.
```

Inflow is capped in the Service layer; the answer's room is reserved by withholding tools on the final turn and by `max_tokens` at the boundary. The UI-stream budget runs alongside and never touches the window.

---

## Elaborate

### Where this pattern comes from

The context window is a hard architectural limit of the transformer: self-attention is computed over a fixed maximum number of positions, so a model has a fixed maximum sequence length it can attend to in one forward pass. Everything in a request — system prompt, history, tool results, output — is the same sequence, so they all draw from the same budget. "Context-window budgeting" or "prompt packing" is the engineering discipline of deciding what goes into that finite sequence and what gets summarized, truncated, or dropped.

Reserving output room is the LLM analog of leaving headroom in any fixed buffer. You never fill a fixed-size array to its last slot when a consumer downstream still needs to write into it. blooming insights' forced-final turn is the explicit "stop appending, the consumer needs the rest of the array" move.

### The deeper principle

```
total window = input slots + output slots   (one shared array)
─────────────────────────────────────────────────────────────
unbounded inflow      → input grows → output room shrinks → bad answer
bounded inflow        → input capped → output room protected → good answer
forced-final turn     → input STOPS  → output gets the remainder
```

The window is zero-sum between input and output. Every character you let into the input is a character of output room you gave up. The three inflow caps and the forced-final turn are all the same bet: spend the window on the *minimum* evidence needed and protect the room the answer requires.

### Where this breaks down

1. **Character caps do not adapt to content.** `truncate` slices at a byte offset, not a token or syntactic boundary, and the same 16,000-char cap is used regardless of how the payload tokenizes. JSON tokenizes richer than prose, so 16,000 chars of JSON is more tokens than 16,000 chars of prose — the cap is conservative for JSON but blind to the difference.

2. **No visibility into how full the window got.** Because nothing reads `res.usage`, the system trusts that six 16,000-char results plus the schema prefix stays comfortably inside the window. That is true at current scale but unverified — it is a budget without a meter (→ ../01-llm-foundations/06-token-economics.md).

3. **Truncation is lossy and silent to the model.** A tool result cut at char 16,000 may end mid-object. The model receives `…{"y":` and the appended `…[truncated]` marker — recoverable as a signal, but the dropped data is simply gone from the window. If the answer needed the truncated tail, the diagnosis degrades and nothing flags it.

### What to explore next

- **`res.usage` (input/output tokens):** the SDK returns exact per-call counts — the cheapest way to turn the character budget into a measured one and see how close each call ran to the window.
- **Sliding-window / summarization compaction:** when a conversation must exceed the window, summarize the oldest turns into a compact note instead of dropping them — the standard fix when a single run's evidence genuinely cannot fit.
- **Structure-aware truncation:** slice JSON at the nearest valid boundary so the model never sees a half-object.

---

## Project exercises

### Add `res.usage` window-fullness logging to the agent loop

- **Exercise ID:** B1.2 (adapted) — context-window instrumentation, the cheap half.
- **What to build:** after each `anthropic.messages.create` in `runAgentLoop`, read `res.usage.input_tokens` / `output_tokens`, accumulate them per agent, and log the input total as a fraction of the model's window so a run reports how close it came to the edge.
- **Why it earns its place:** turns an unmeasured character budget into a measured one — the single highest-value step toward knowing whether the inflow caps are actually keeping runs safe.
- **Files to touch:** `lib/agents/base.ts` (`runAgentLoop`, `AgentRunResult` — add a usage field), and the synthesis calls in `lib/agents/diagnostic.ts` / `lib/agents/recommendation.ts`.
- **Done when:** a single investigation reports total input tokens and the % of the window consumed per agent, and the number moves when you raise `MAX_TOOL_RESULT_CHARS` or the `schemaSummary` caps.
- **Estimated effort:** 1–4hr

### Replace fixed character caps with a token-aware inflow budget

- **Exercise ID:** C1.2 (adapted) — context-window budgeting in the real unit.
- **What to build:** add `lib/mcp/tokens.ts` wrapping `@anthropic-ai/tokenizer`, then rewrite `truncate` and the `schemaSummary` caps to budget against a token ceiling that maps to a fraction of the context window, preferring a valid JSON boundary when cutting.
- **Why it earns its place:** demonstrates you understand the window is shared and measured in tokens, that char caps cut mid-structure, and that the bound should track the real unit near the edge.
- **Files to touch:** `lib/agents/base.ts` (`truncate`, `MAX_TOOL_RESULT_CHARS` → a token budget), `lib/agents/monitoring.ts` (`schemaSummary` caps), new `lib/mcp/tokens.ts`, `test/agents/base.test.ts`.
- **Done when:** a 60KB JSON tool result is truncated to a configured token budget at a valid boundary and the schema prefix respects a token cap, both verified against the tokenizer.
- **Estimated effort:** 1–4hr

---

## Interview defense

### What an interviewer is really asking

"How do you keep a multi-tool-call agent inside the context window?" tests whether you know the window is one shared array, whether you bound the inflows that grow it, and whether you protect the output's room. The senior signal is naming that input and output are zero-sum and pointing to the *specific* mechanism that stops the transcript growing — not just "I truncate."

### Likely questions

**[mid] What competes for space in a single model call, and how does this codebase bound it?**

The system prompt, every prior turn, every tool result fed back, and the reserved output room all share one fixed array. The codebase bounds the inflows by characters: `truncate` caps each tool result at 16,000 (`lib/agents/base.ts` L31–L34) and `schemaSummary` caps the prefix (L15–L48). Output room is reserved by `max_tokens` and the forced-final turn.

```
[ system │ turns │ tool_results │ … │  OUTPUT ]   one shared array
   ▲caps    grows per turn          ▲ reserved (max_tokens + forced-final)
```

**[senior] How do you guarantee the model has room left to answer after six tool calls?**

Two mechanisms. The inflow caps keep each of the six results ≤ 16,000 chars so the transcript stays bounded. Then on the final turn `forceFinal` (`base.ts` L91) is true and L101 withholds the tool schemas — with no tools, the model cannot emit a `tool_use` block, so no further `tool_result` is appended and the transcript stops growing. The model spends its remaining `max_tokens` on the answer instead of asking for more data.

```
loop turns: append tool_result each time → transcript grows
final turn: no tools → no tool_use → no append → transcript STOPS
            → remaining window = answer's room
```

**[arch] The `16_000` and `4000` caps — same purpose?**

No. `16_000` (`base.ts` L29) bounds what re-enters the *model's* window, defending the shared context array. `4000` (`route.ts` L99) bounds the result payload streamed to the *browser*, defending wire size. They live in different layers and protect different limits; conflating them would couple the UI's payload size to the model's context budget.

```
16_000 ──▶ model window (base.ts)      4000 ──▶ NDJSON to UI (route.ts)
```

### The question candidates always dodge

**"How close to the window does a real investigation actually run?"** The honest answer in this codebase is "unknown — nothing reads `res.usage`." The caps are a budget without a meter. A candidate who invents a percentage is bluffing; the strong answer points at the absence and names the cheap fix (read `res.usage`, the exercise above).

### One-line anchors

- `lib/agents/base.ts` L29, L31–L34 — `MAX_TOOL_RESULT_CHARS = 16_000`, tool-result inflow cap.
- `lib/agents/base.ts` L90–L91, L101 — `forceFinal` withholds tools so the transcript stops growing.
- `app/api/agent/route.ts` L99 — `TRUNC = 4000`, UI-stream budget (different layer/purpose).
- `lib/agents/monitoring.ts` L15–L48 — `schemaSummary` caps the 112KB schema to a small prefix.
- Input and output share one fixed array; bounding inflow protects the answer's room.

---

## See also

→ 02-lost-in-the-middle.md · → 03-prompt-chaining.md · → ../01-llm-foundations/02-tokenization.md · → ../04-agents-and-tool-use/02-tool-calling.md

---
