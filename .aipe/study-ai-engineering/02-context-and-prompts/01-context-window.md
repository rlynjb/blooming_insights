# 01 — The context window

**Type:** Industry standard. Also called: context length, model context, input budget.

## Zoom out, then zoom in

The finite container. Everything the model can consider on this turn — system prompt, history, tools, retrieved data, room for response — competes for space.

```
  Zoom out — where the window pressure shows up in this repo

  ┌─ Agent loop (AptKit ReAct) ───────────────────────────────────────┐
  │  messages array grows with every turn                              │
  │  ★ THIS CONCEPT ★ — the messages array IS the context window       │
  └─────────────────────────────┬─────────────────────────────────────┘
                                │
  ┌─ Every turn ────────────────▼─────────────────────────────────────┐
  │  system prompt (~2-3K, cached)                                     │
  │  tools def (~1-2K, cached)                                         │
  │  user turn + assistant history + tool_result blocks (grows)        │
  └───────────────────────────────────────────────────────────────────┘
```

Zoom in. Sonnet 4.6's context window is 200K tokens. A typical diagnosis turn 6 has ~10-20K tokens in the messages array; turn 10 might be ~25-40K. We are nowhere near the limit — but the SHAPE of what's in the window is what determines cost and where the model attends.

## Structure pass

**Layers:**
- Outer: 200K token limit (the hard cap)
- Middle: what's actually in the messages array on this turn
- Inner: individual message content blocks

**Axis: what fills the window?**
- Stable (across turns): system prompt, tools def → cache targets
- Growing (per turn): assistant text, tool_use, tool_result → uncached
- Absent (in this codebase): retrieved context (no RAG)

**Seam:** the messages array passed to `AnthropicModelProviderAdapter.complete()`. AptKit's loop builds it; the adapter mostly just wraps the system prompt with `cache_control`.

## How it works

### Move 1 — the mental model

Every model call is a fresh call. Nothing persists in the model. The "conversation" is the entire messages array you pass. Long conversation = big array = big context window usage = big cost.

```
  What the window holds (one turn, mid-investigation)

  ┌─ Context window (200K tokens, mostly empty) ─────────────────────┐
  │                                                                   │
  │   [system  ▓▓▓ 2-3K    cached★                                    │
  │   [tools   ▓▓  1-2K    cached★                                    │
  │   [user    ▓   0.5K    the anomaly to investigate                 │
  │   [asst    ▓   0.3K    "checking payment_failure rates…"          │
  │   [user    ▓▓  1.2K    tool_result: {counts, revenue}             │
  │   [asst    ▓   0.4K    "and mobile checkout timing…"              │
  │   [user    ▓▓  1.8K    tool_result: {funnel}                      │
  │   [asst    ▓   0.5K    "let me confirm SP scope"                  │
  │   [user    ▓▓▓ 2.1K    tool_result: {country breakdown}           │
  │   [asst    ▓   0.4K    "conclusion: payment processor timeout…"   │
  │                                                                   │
  │   Room for response: ~180K available                              │
  └───────────────────────────────────────────────────────────────────┘
```

### Move 2 — walk the mechanism

**The system prompt.**

AptKit's `DiagnosticInvestigationAgent` owns the built-in system prompt (not present in this repo's source — it's imported from `@aptkit/core`). The retired prompts in `lib/agents/legacy-prompts/*.md` show the shape: ~2-3K tokens, structured with role, hard rules, method, tool catalog, output shape. Stable across every turn of an investigation.

**Tools definition.**

Every turn re-sends the full tools list. In this codebase, the tool catalog is the MCP tools from `BloomreachDataSource` / `SyntheticDataSource` — `execute_analytics_eql`, `list_customers`, `list_scenarios`, etc. Each tool definition is small (~50-200 tokens), but the full list is ~1-2K.

**The growing part.**

Every turn appends: the previous assistant message (with tool_use blocks), the tool_result blocks with the tool's output. Tool_result content is what dominates growth — `execute_analytics_eql` results come back as JSON that can be 500-3000 tokens per call.

**Where this repo caps growth: the 6-tool-call budget.**

The retired diagnostic prompt (`legacy-prompts/diagnostic.md:11`) is explicit: "Make at most 6 tool calls, then conclude." Retired but the pattern carries over to AptKit's built-in prompt. Effect: bounded loop, bounded messages array, bounded context usage. If tool calls were unbounded, one runaway loop could balloon the messages array past 100K.

```
  Bounded loop → bounded context growth

  turn 1:  ~4K   messages (system + tools + user)
  turn 3:  ~10K  (+ 2 assistant turns + 2 tool_results)
  turn 6:  ~20K  (+ 5 assistant + 5 tool_results)
  turn 10: ~35K  (conclude — hard-capped at 6 real tool calls)

  Ceiling: 200K   Usage: ~35K max     ≈ 17% used
```

**Where prompt caching intersects.**

The stable prefix — system + tools — is what the ephemeral cache breakpoint targets (see `06-production-serving/01-llm-caching.md`). Turn 1 pays full price for that prefix + a 25% cache-creation premium. Turns 2-10 pay ~10% of that prefix. Over 10 turns, the effective input cost is roughly halved.

### Move 3 — the principle

The context window is the entire memory of the LLM. Not a database. Not a session. What you don't put in the messages array, the model doesn't know. What you DO put in, you pay for on every turn until the loop ends (or the conversation ends). Design the growing part to be minimal (schema-constrained tool_results, capped tool call budgets); design the stable part to be cacheable.

## Primary diagram

```
  Context window pressure — one full investigation

  ┌─ 200K token window (Sonnet 4.6) ──────────────────────────────────┐
  │                                                                   │
  │   Turn 1 messages array:                                          │
  │     system (2-3K, cached★)                                        │
  │     tools  (1-2K, cached★)                                        │
  │     user   (anomaly, 0.5K)                                        │
  │     ────────                                                      │
  │     ~4K tokens                                                    │
  │                                                                   │
  │   Turn 10 messages array (end of loop):                           │
  │     system (2-3K, cached★)                                        │
  │     tools  (1-2K, cached★)                                        │
  │     user + 9 assistant/user pairs of turns                        │
  │     ~35K tokens                                                   │
  │                                                                   │
  │   Never approaches the 200K limit in normal operation.            │
  │   The 6-tool-call cap in the retired prompt keeps growth bounded. │
  │                                                                   │
  └───────────────────────────────────────────────────────────────────┘
```

## Elaborate

Context windows grew fast: GPT-4 launched at 8K, extended to 32K, then 128K; Claude 3 launched at 200K; Gemini reached 1M+. Bigger windows are useful for one-shot document-QA (stuff a whole book in) but they DON'T help agent loops that only need to remember 10-20 turns of history. This codebase would run fine on a 32K window — it never gets close to using more.

The interesting engineering pressure isn't the limit — it's the cost. Every token in the window is paid for on every turn (minus cache reads). So even at 200K available, the discipline is "keep the growing part small," not "use more of the 200K."

## Project exercises

### Exercise — measure context growth per turn

- **Exercise ID:** C2.1-A · Case A (concept exercised implicitly; measure it).
- **What to build:** in `AnthropicModelProviderAdapter.complete()`, log the total prompt size (sum of message content lengths) before each call. Emit as a new `CapabilityEvent` type `context_growth` with `{turn, promptTokens, cacheHit}` — surface in the report as a per-turn growth curve.
- **Why it earns its place:** turns "the context grows across the loop" into a measured number. Interviewer signal: "I know exactly how much context each turn adds and what that costs — measured, not estimated."
- **Files to touch:** `lib/agents/aptkit-adapters.ts` (measure + log), `lib/mcp/events.ts` (add context_growth event), `eval/report.eval.ts` (aggregate + print growth curve).
- **Done when:** running `npm run eval:report` on the latest run prints a "context growth per turn" table for one case.
- **Estimated effort:** 1-4hr.

## Interview defense

**Q: How much of the 200K window do you actually use?**

Peak ~35K in a full 10-turn investigation, which is ~17%. The 6-tool-call cap in the diagnostic prompt keeps growth bounded; the window itself is nowhere near a limiting factor. What matters more is the COST of the window at each turn — with prompt caching, the stable prefix is ~10% price on turns 2-10, so effective spend halves over the loop.

**Q: What's in the growing part of the messages array?**

Assistant messages with tool_use blocks (~200-800 tokens each) and user messages with tool_result blocks (~500-3000 tokens each, dominated by tool JSON output). If a tool returns a big JSON payload, that's what fills the window most. `execute_analytics_eql` results are the biggest — one deep breakdown query can be 2K tokens on its own.

**Q: What happens if you hit the 200K limit?**

Anthropic returns an error before the model runs. In this codebase we'd never hit it under normal operation, but a runaway loop (bug in the ReAct decision logic making infinite tool calls) COULD. The `BudgetTracker` ceiling catches that first — a runaway loop hits the $2 budget ceiling long before the 200K token ceiling.

## See also

- `02-lost-in-the-middle.md` — where in the window the model attends
- `01-llm-foundations/02-tokenization.md` — the unit the window is sized in
- `06-production-serving/01-llm-caching.md` — how the stable prefix stops costing much
- `04-agents-and-tool-use/06-error-recovery.md` — the 6-call cap that bounds context growth
