# Token budgeting

**Industry standard** · context-window management, compression, prefix caching

## Zoom out — where token pressure lives

Three places in this codebase have a token budget that matters: the `{schema}` slot in every system prompt (could be the raw 112KB workspace catalog; isn't), the per-tool-result content sent back to the model (could be unbounded EQL responses; isn't), and the `max_tokens` on the model call itself (4096 for agent loops, 16 for the intent classifier). Each one has a deliberate cap somewhere in the code.

```
  Zoom out — three token-pressure surfaces

  ┌─ Prompt assembly ───────────────────────────────────────┐
  │  system = template + {schema} + {categories} + ...      │
  │           ★ schema compaction (concept #4) ★             │
  └─────────────────────────────────┬───────────────────────┘
                                    │
  ┌─ Tool-result return path ───────▼───────────────────────┐
  │  tool_result.content = JSON.stringify(result)            │
  │  ★ truncate at MAX_TOOL_RESULT_CHARS = 16,000 ★         │
  └─────────────────────────────────┬───────────────────────┘
                                    │
  ┌─ Model call cap ────────────────▼───────────────────────┐
  │  max_tokens: 4096 (agent loops) | 16 (intent classifier) │
  │  ★ output bound · also bounds latency + cost ★          │
  └──────────────────────────────────────────────────────────┘
```

## Zoom in

Token counting is not optional. It's hygiene. A chain that worked fine on small inputs (the dev workspace with 100 events) starts timing out at scale (a real workspace with 100K events) because nobody capped the schema injection. A diagnostic agent that returned in 8s starts returning in 60s because nobody capped the tool result. An intent classifier that cost $0.0001 per call starts costing $0.005 per call because someone removed the `max_tokens: 16` and let it write a paragraph. Every cap in this codebase exists because something would break or get expensive without it.

## Structure pass

**Layers.** Three nested altitudes of "what counts toward the budget": the *prompt* (system + user message, everything sent in), the *tool-result feedback loop* (every tool result added to the conversation history mid-loop), the *output* (what the model writes back).

**Axis traced — cost.** Hold one question constant: *what bounds the work at this layer?*

```
  Axis = cost — what bounds the work?

  ┌─ prompt ──────────────────────────────────────────────┐
  │   bound by:  schemaSummary() caps (MAX_EVENTS=20,     │
  │              MAX_PROPS=10, MAX_CPROPS=30)              │
  │   if uncapped: 112KB schema → ~30K tokens of context   │
  └────────────────────────────────────────────────────────┘
                              │
  ┌─ tool-result loop ───────▼────────────────────────────┐
  │   bound by:  MAX_TOOL_RESULT_CHARS = 16,000 (per call)│
  │              maxToolCalls = 6 (monitoring, diagnostic) │
  │              maxToolCalls = 4 (recommendation)         │
  │   if uncapped: a single big EQL response could blow    │
  │                the context window in one call          │
  └────────────────────────────────────────────────────────┘
                              │
  ┌─ output ─────────────────▼────────────────────────────┐
  │   bound by:  max_tokens: 4096 (loop) | 16 (intent)     │
  │   if uncapped: model rambles or writes a paragraph     │
  │                where one word was wanted               │
  └────────────────────────────────────────────────────────┘
```

**Seams.** The schema-injection seam (where `schemaSummary` runs) is where you decide what the model knows about the workspace — too little and queries fail, too much and you burn the budget before the work starts. The tool-result-truncation seam is where you decide what the model remembers across turns — too aggressive and the model loses context mid-investigation, too loose and one big response evicts everything else. The output-cap seam is where you decide how much the model can write — the only seam where the cap acts as a forcing function on the model's behavior (a `max_tokens: 16` on the intent classifier forces it to pick one word).

## How it works

### Move 1 — the budget pattern

You know how a fetch has a timeout? Token budgets are timeouts for the context window. Without one, the call still completes — but slowly, expensively, and sometimes wrong (the model attended to early text and forgot the later instructions, the lost-in-the-middle effect). The pattern: every place where unbounded data enters the prompt has a deliberate cap, and the cap is named, and the cap has a comment explaining what would break without it.

```
  Pattern — the four caps every LLM call has somewhere

  ┌─────────────────────────────────────────────────────────┐
  │   1. SCHEMA / CONTEXT cap                                │
  │      "compact this big thing to fit a budget"            │
  │      → schemaSummary()                                   │
  ├─────────────────────────────────────────────────────────┤
  │   2. PER-TOOL-RESULT cap                                 │
  │      "any one tool can't blow the conversation"          │
  │      → truncate(JSON.stringify(result)) @ 16,000 chars   │
  ├─────────────────────────────────────────────────────────┤
  │   3. TOTAL-TOOL-CALL cap                                 │
  │      "the agent can't loop forever"                      │
  │      → maxToolCalls: 6 (monitoring) | 4 (recommendation) │
  ├─────────────────────────────────────────────────────────┤
  │   4. OUTPUT cap                                          │
  │      "the model can't ramble"                            │
  │      → max_tokens: 4096 (loop) | 16 (intent)             │
  └─────────────────────────────────────────────────────────┘
```

### Move 2 — schemaSummary, the schema-compaction helper

The Bloomreach workspace catalog (events, properties, customer fields, catalogs) is ~112KB of raw JSON. Stuffed verbatim into every system prompt, it would consume ~30K tokens of context on every call — for *every* agent, on *every* turn of the tool-use loop. The fix is `schemaSummary` at `lib/agents/monitoring.ts:19-60`, which produces a token-bounded summary keyed to what the model actually needs.

```
  lib/agents/monitoring.ts:19-60 — schemaSummary (the key parts)
  ┌────────────────────────────────────────────────────────────┐
  │ export function schemaSummary(schema: WorkspaceSchema):    │
  │   string                                                    │
  │ {                                                           │
  │   const oldestDate = ...                                    │
  │                                                             │
  │   // Top 20 events, each capped at 10 properties           │
  │   const MAX_EVENTS = 20;            ← named cap            │
  │   const MAX_PROPS_PER_EVENT = 10;   ← named cap            │
  │                                                             │
  │   const eventsText = schema.events                          │
  │     .slice(0, MAX_EVENTS)                                   │
  │     .map((e) => {                                           │
  │       const props = e.properties.slice(0, MAX_PROPS_PER_EVENT)│
  │                                  .join(', ');               │
  │       return `  - ${e.name} (${e.eventCount}): ${props}...`;│
  │     }).join('\n');                                          │
  │                                                             │
  │   // Customer properties, cap at 30                         │
  │   const MAX_CPROPS = 30;            ← named cap            │
  │   const customerPropsText = schema.customerProperties       │
  │     .slice(0, MAX_CPROPS).join(', ');                       │
  │   ...                                                       │
  │ }                                                           │
  └────────────────────────────────────────────────────────────┘
```

Three caps, each named, each commented. The function exists for one reason: keep the schema injection inside a token budget that doesn't dominate the prompt. The output is something like 1-2KB instead of 112KB — roughly a 50× compaction. The function comment is honest about what the cap is: *"Compact, token-bounded schema summary for the prompt (NOT the full 112KB schema)."*

The discipline here: when you cap, the cap is a *named constant*, not a magic number. `MAX_EVENTS = 20` is a constant you can grep for; `.slice(0, 20)` is a bug nobody'll find. Named caps also signal intent to the next engineer: when the workspace has 21 events and one of them is the load-bearing one for monitoring, you'll know to look here.

### Move 2 — truncate, the per-tool-result cap

A tool result from `execute_analytics_eql` can be small (a count) or huge (a 1000-row segmentation breakdown). The latter, fed back into the conversation as a tool_result block, blows the context window in one call. The fix is at `lib/agents/base-legacy.ts:32-37`:

```
  // lib/agents/base-legacy.ts:32-37
  const MAX_TOOL_RESULT_CHARS = 16_000;

  function truncate(s: string): string {
    if (s.length <= MAX_TOOL_RESULT_CHARS) return s;
    return s.slice(0, MAX_TOOL_RESULT_CHARS) + '\n…[truncated]';
  }
```

16,000 chars is roughly 4,000 tokens — enough for substantial detail, capped before any one tool result can crowd out the rest of the conversation. The `'\n…[truncated]'` suffix is doing work: it tells the model "you got partial data here," so it can choose to query a tighter window rather than reason on incomplete data. Without that suffix, the model would silently see truncated JSON and might invent details where the truncation cut off.

The cap is character-based, not token-based. Token counting requires running the tokenizer, which costs CPU; character counting is free and "close enough" for a safety rail. The 4× char→token ratio is conservative (real ratio for English ~3.5-4x); the constant is generous enough that the tradeoff favors simplicity.

Where this gets called, in the loop body:

```
  // lib/agents/base-legacy.ts:184, 189
  resultContent = truncate(JSON.stringify(result));        // success path
  // ...
  resultContent = truncate(JSON.stringify({ error: msg })); // error path
```

Both success and error paths go through truncate. An error response with a multi-megabyte stack trace would otherwise be just as catastrophic as a successful response with 1000 rows.

### Move 2 — maxToolCalls, the total-call cap

Per-tool-result truncation bounds one tool call. `maxToolCalls` bounds the total number of tool calls in a loop. The monitoring and diagnostic agents are capped at 6; the recommendation agent at 4:

```
  // lib/agents/monitoring-legacy.ts:114
  maxToolCalls: 6, // hard cap — bounds latency under the 1 req/s MCP limit

  // recommendation-legacy.ts similar, with 4
```

The comment names the *real* reason the cap exists: the MCP server is rate-limited to ~1 req/s, so 6 calls = at least 6 seconds of MCP latency, and any more makes the briefing feel slow. The token-budget angle is real too (each tool call doubles the conversation length — assistant message with tool_use, user message with tool_result), but the latency bound is what set the number.

When the cap fires, the loop forces a final synthesis turn without tools (`base-legacy.ts:122-133`):

```
  // base-legacy.ts:122-133 — what happens when the budget is spent
  const budgetSpent = maxToolCalls !== undefined &&
                      toolCalls.length >= maxToolCalls;
  const forceFinal = turn === maxTurns - 1 || budgetSpent;
  const params = {
    model: AGENT_MODEL,
    max_tokens: maxTokens,
    system: forceFinal && synthesisInstruction
            ? `${system}\n\n${synthesisInstruction}`   // ← appended
            : system,
    messages,
  };
  if (!forceFinal) params.tools = toolSchemas;          // ← tools removed
```

Two things happen on the forced-final turn: tools are dropped from the request (the model literally cannot call another tool), and a synthesis instruction is appended (telling the model "you have no more tool calls, output your final answer with what you have"). This is the load-bearing part of the cap. Without it, the model would respond to "you can't call tools" by asking for more tools, and the loop would just exit with no answer.

### Move 2 — max_tokens, the output cap

The intent classifier shows what `max_tokens` does at its extreme:

```
  // lib/agents/intent-legacy.ts:25-33
  const res = await anthropic.messages.create({
    model: CLASSIFIER_MODEL,
    max_tokens: 16,                       // ← 16, not 4096
    system: 'Classify the user query as exactly one word: ' +
            'monitoring (...), diagnostic (...), or ' +
            'recommendation (...). Reply with ONLY the one word.',
    messages: [{ role: 'user', content: query }],
  }, ...);
```

`max_tokens: 16` is the cap that makes this an O(1)-token call instead of O(paragraph). Even if the model wanted to explain its reasoning, it can't — 16 tokens is "monitoring" plus a few tokens of slack. The cost stays at fractions of a cent per call. The latency stays under 500ms. That budget is what makes the intent classifier viable as a routing layer — anything bigger and you wouldn't route, you'd just send everything to the big model.

The agent loops use `maxTokens: 4096` — enough for the full structured-output JSON (an Anomaly[] with 10 items + evidence + impact strings fits comfortably; a Diagnosis with hypotheses and timeSeries fits). The default `?? 4096` at `base-legacy.ts:100` is the fallback when a caller doesn't specify. Bigger output caps cost more (you're paying per output token) and don't help (the model fills the space with prose nobody reads).

### Move 2 — what's NOT here, and why it matters

Two pieces of the token-budgeting toolkit are *not* exercised in this codebase:

**Conversation-history compression.** The agent loops don't summarize earlier turns. Every tool result accumulates in `messages[]`, and a 6-tool-call investigation ends with 13 messages in the history (user → assistant+tool_use → user+tool_result, × 6). At max_tokens 4096 per turn and ~4 chars/token, the total prompt by the final turn can reach 60-80K tokens. The 1 req/s MCP rate limit caps wall time before the context window caps, so this hasn't bitten yet — but if the per-tool cap goes up or the loop budget goes up, conversation compression (summarize turns 1-3 into a short note before turn 4) becomes the next move.

**Prefix caching utilization.** Anthropic offers prefix caching for the system prompt; the active path's system message is large and stable (the .md template + schema + categories). The codebase doesn't pass `cache_control: { type: 'ephemeral' }` blocks anywhere, so the cache isn't engaged. This is a "soon, not yet" — the saving would be roughly 90% off the input-token cost on every repeat call within the cache window. The change is a small one (add cache markers to the long stable parts of the system prompt); the holdup is that it hasn't been measured against demand yet.

**Lost-in-the-middle awareness.** The `## Workspace schema` block sits at the *bottom* of every system prompt (see `monitoring.md:99-102`, `diagnostic.md:100-103`). That's the lost-in-the-middle danger zone for very long prompts — content placed at the start or end is attended to more reliably than content in the middle. The schema isn't currently long enough for this to bite, but if the `schemaSummary` caps grow, moving the schema higher (or putting the most critical instructions at the bottom *after* the schema) is worth considering.

### Move 3 — the principle

Token budgets are the latency, cost, and correctness boundary of LLM work. Every place unbounded data enters the prompt needs a deliberate, named, commented cap. Every place the model writes back needs an output cap. Skip these and the system works in development and breaks at production scale — slowly, expensively, and in ways the type guards won't catch.

## Primary diagram

```
  Token budgeting — the four caps, where they live, what they bound

  ┌─ Schema-injection seam ───────────────────────────────────────┐
  │  schemaSummary()    lib/agents/monitoring.ts:19-60             │
  │    MAX_EVENTS = 20  · MAX_PROPS_PER_EVENT = 10                 │
  │    MAX_CPROPS = 30                                             │
  │  → bound: schema slot stays ~1-2KB instead of ~112KB           │
  └──────────────────────────────┬────────────────────────────────┘
                                 │
  ┌─ Per-tool-result seam ───────▼────────────────────────────────┐
  │  truncate()        lib/agents/base-legacy.ts:34-37             │
  │    MAX_TOOL_RESULT_CHARS = 16,000 (~4,000 tokens)              │
  │    suffix: '\n…[truncated]' tells the model partial data       │
  │  → bound: no single tool result evicts the conversation        │
  └──────────────────────────────┬────────────────────────────────┘
                                 │
  ┌─ Loop-budget seam ───────────▼────────────────────────────────┐
  │  maxToolCalls       monitoring: 6 · diagnostic: 6 · recom: 4   │
  │  forceFinal turn drops tools + appends synthesisInstruction    │
  │  → bound: total wall time under MCP's 1 req/s rate limit       │
  └──────────────────────────────┬────────────────────────────────┘
                                 │
  ┌─ Output cap ─────────────────▼────────────────────────────────┐
  │  max_tokens        agent loop: 4096 · intent classifier: 16    │
  │  → bound: cost per call, latency per turn                      │
  │                                                                 │
  │  intent's max_tokens: 16 is what makes routing viable          │
  └────────────────────────────────────────────────────────────────┘
```

## Elaborate

The 80% rule from the spec deserves a moment: if you're using more than 80% of the context window, you're one model change away from breaking. blooming sits comfortably under that — even a max-budget investigation (6 tool calls × 16K chars × 4 chars/token) plus the system prompt comes in around 30K tokens, well within Sonnet's 200K window. That headroom is what lets the codebase get away with not yet implementing conversation-history compression. It's also what makes the lost-in-the-middle effect not yet a problem.

What changes the picture is workspace scale. The current schema summary is calibrated for the demo workspace (~30 events, ~50 customer properties). A real enterprise workspace could have 200+ events and 300+ customer properties; even with `MAX_EVENTS = 20` and `MAX_CPROPS = 30`, the *selection* of which 20 and which 30 starts to matter. Right now the slice is "first N by array order" — which is alphabetical-ish, not relevance-ranked. That works at 30 events; at 200 events, the load-bearing event for the monitoring agent might not be in the first 20. The pattern's there; the slice strategy is the next refinement.

Prefix caching is the headline missed optimization. Anthropic launched it after the codebase shipped; adding `cache_control` markers to the stable parts of the system prompt would cut input-token cost ~90% on every repeat call within ~5 minutes of cache lifetime. For a briefing that runs four agents in sequence over the same workspace, that's a real saving. The change is small — annotate the system message blocks in the SDK call — and the benefit compounds with every call. It hasn't shipped because it hasn't been measured against actual cost; once token spend starts mattering, this is the first stop.

The OpenAI cookbook and Anthropic's prompt engineering guide both have sections on token budgeting that are worth reading; the cookbook in particular has a useful example of structured output + budget management together. Simon Willison's blog has scattered posts on tokenizer behavior across providers (a token in OpenAI is not the same token in Anthropic — the count differs by ~10% for the same English text), which matters if you're trying to predict cost or budget for a multi-provider deployment. blooming is single-provider (Anthropic), so this is informational rather than load-bearing.

## Interview defense

**Q: What breaks first when token budgets are ignored — cost, latency, or correctness?**

A: Correctness, and it's the subtle one. Cost shows up on the bill — the on-call engineer notices. Latency shows up as a timeout — the user notices. Correctness shows up as the model attending to the wrong part of a too-long prompt (lost-in-the-middle) and confidently producing the wrong answer — *nobody* notices until someone reads the output carefully and goes "wait, that's not what we asked for." The order of when the failure modes are worth fixing: correctness first (smaller, denser prompts), then latency (don't let any one call blow the wall clock), then cost (cap the output, cache the prefix). blooming's caps are sized to keep all three under control: `schemaSummary` for correctness, `MAX_TOOL_RESULT_CHARS` for latency, `max_tokens: 16` on the classifier for cost.

```
  what I'd sketch:

  budget ignored  →  symptoms surface in this order:
    [silent]  attention drift, wrong answers       ← scariest
    [loud]    timeouts                             ← noticed
    [billing] surprise on the next invoice         ← noticed late
```

**Q: When would you reach for conversation-history compression?**

A: When the per-tool-result cap × max tool calls × turns starts approaching ~30% of the context window. Right now: 16K chars × 6 tool calls = 96K chars ≈ 24K tokens, plus the system prompt at ~3K tokens, plus the model's reasoning text per turn = comfortably under 50K of Sonnet's 200K window. That's 25% of context — under the 30% threshold I'd use to trigger compression. The day someone bumps `MAX_TOOL_RESULT_CHARS` to 64K or `maxToolCalls` to 12, this gets close to 50% and compression becomes the next concept to implement: summarize the first N turns into a short "what we've learned so far" note before turn N+1, keep the per-turn input cost roughly flat. The change isn't conceptually hard; it just hasn't earned its place yet.

```
  trigger:  (max_tool_chars × max_tool_calls) + system_prompt
            > 30% of context_window
                              ↓
  apply:   summarize turns 1..N-1 into a brief note
           before turn N
                              ↓
  benefit: input-token cost stays flat across long loops
```

## See also

- [01-anatomy.md](./01-anatomy.md) — the `{schema}` slot is where `schemaSummary` plugs in
- [03-prompts-as-code.md](./03-prompts-as-code.md) — the named caps live in the same `.md` review surface
- [06-single-purpose-chains.md](./06-single-purpose-chains.md) — why a per-agent tool registry helps the token budget too
