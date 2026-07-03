# 02 — Tokenization

**Type:** Industry standard. Also called: BPE (byte-pair encoding), subword tokenization.

## Zoom out, then zoom in

Tokens are the unit everything downstream in this repo is priced, budgeted, and rate-limited in.

```
  Zoom out — where tokens land in the stack

  ┌─ Agent layer ─────────────────────────────────────────────────────┐
  │   messages array — measured in TOKENS                              │
  │   response.usage.input_tokens / output_tokens ← ★ THIS CONCEPT ★  │
  └─────────────────────────────┬─────────────────────────────────────┘
                                │
  ┌─ Observability & budget ────▼─────────────────────────────────────┐
  │   BudgetTracker.add({inputTokens, outputTokens})                   │
  │   BudgetTracker.exceeded() → gate before next call                 │
  │   estimateAnthropicCost(usage) → USD per turn                     │
  └─────────────────────────────┬─────────────────────────────────────┘
                                │
  ┌─ Receipts (eval/receipts/) ─▼─────────────────────────────────────┐
  │   per-case token totals + cost, aggregated in baseline.json        │
  └───────────────────────────────────────────────────────────────────┘
```

Zoom in. Text becomes tokens before it enters the model, and cost/context-window/budget are all measured in tokens — not characters, not words. In this repo you never touch the tokenizer directly (Anthropic doesn't expose one in the SDK), but every cost line, every budget check, every receipt row is denominated in the number Anthropic tells us the request/response used.

## Structure pass

**Layers:**
- Outer: what the reader sees — cost in USD per case (`~$0.09`)
- Middle: the tokens the receipts and budget track
- Inner: the encoding step Anthropic runs inside its API

**Axis: what unit is this quantity in?**
- USD/cost — a derived unit (tokens × per-MTok price)
- Token counts — the ground-truth unit for pricing, budget, context
- Characters — irrelevant to the model, only relevant to the human writing prompts

**Seam:** the SDK response envelope (`response.usage.input_tokens`) — this is where "how much text did we send/receive" becomes "how much token." We consume that number; we don't compute it.

## How it works

### Move 1 — the mental model

You've eyeballed a JSON payload and thought "that's about 200 characters." Tokens are the same eyeball on a coarser grid. A rough rule for English + code: **1 token ≈ 4 characters** or **~0.75 words**. `{"metric":"conversion"}` is ~7 tokens. A 2000-char JSON is roughly 500 tokens.

```
  How text becomes tokens (byte-pair encoding, ~4 chars/token English)

  "Hello, world!"      →  ~4 tokens        →  the model sees vectors
  "conversion_rate"    →  ~2 tokens        →  "_rate" tokenizes together
  "{\"metric\":\"..."  →  more tokens/char →  punctuation-heavy JSON
                          than prose         costs more per char
```

BPE learns pairs of characters that co-occur, iteratively. Common English chunks (`" the"`, `"tion"`) end up as single tokens; rare strings (long UUIDs, base64 blobs) get split fine, one or two chars per token. That's why an EQL query full of table/column names tokenizes worse than plain prose.

### Move 2 — walk the mechanism

**Where token counts show up in this repo — three places.**

1. `response.usage` on every model call. Every `AnthropicModelProviderAdapter.complete()` return value carries `input_tokens` and `output_tokens` (`lib/agents/aptkit-adapters.ts:97-101`). This is the ground truth.

```typescript
// lib/agents/aptkit-adapters.ts:97-119 (the logging + budget accumulation)
console.log(JSON.stringify({
  site: this.logSite,
  sessionId: this.sessionId,
  usage: response.usage,          // ← authoritative token count
}));

this.budget?.add({
  inputTokens: response.usage.input_tokens,
  outputTokens: response.usage.output_tokens,
});
```

2. `BudgetTracker.snapshot()` at `lib/agents/budget.ts:57-69`. Aggregated across all turns in one investigation (both diagnostic and recommendation agents share one tracker). This is where the ceiling check happens.

3. Receipts in `eval/receipts/`. Per-case `usage.diagnose` and `usage.recommend` rows, computed by `summarizeUsage` (from `@aptkit/core`) over the captured `CapabilityEvent[]` trace. See `eval/run.eval.ts:215-220`.

```
  Token counts flow (per turn)

  Anthropic response.usage
         │
         ├──────► console.log (per-turn observability)
         │
         ├──────► BudgetTracker.add() ── accumulated ──► exceeded()?
         │                                                    │
         │                                              throws BudgetExceededError
         │
         └──────► CapabilityEvent 'model_usage' ──► summarizeUsage(trace)
                                                            │
                                                    receipt.usage.diagnose
                                                    receipt.usage.recommend
```

**Where cache tokens split off.** Anthropic's response also includes `cache_creation_input_tokens` and `cache_read_input_tokens` when caching is on. In this repo, `response.usage.input_tokens` in the SDK type excludes cache-read tokens — so what the `BudgetTracker` accumulates is slightly conservative when caching is active. The note in `lib/agents/pricing.ts:10-13` is explicit about this: cost estimated is therefore an UPPER BOUND under caching.

**Rough tokens per turn in this codebase.**

- System prompt (diagnostic): ~2-3K tokens (cached after first turn — see `06-production-serving/01-llm-caching.md`).
- Tools definitions: ~1-2K tokens (also cached via the same breakpoint).
- User message + growing history: 500-3000 tokens per turn depending on how deep in the loop.
- Output tokens per turn: 200-800 (mostly the assistant's brief thought + tool_use).
- Total for a full diagnosis: ~15-40K input tokens (uncached-equivalent), ~2-5K output. With caching, effective input tokens drop by ~60-80% after the first turn.

### Move 3 — the principle

You don't own the tokenizer. Anthropic does. Your job is to measure token counts as they come back, feed them into your cost/budget accounting, and design prompts to be cache-friendly (stable prefix, variable suffix). The "just count characters and divide by 4" estimate is good enough for capacity planning but not for billing — always use `response.usage` for anything that gates behavior.

## Primary diagram

Where every token count in this repo comes from and where it ends up.

```
  Token flow — one turn to receipt

  ┌─ Anthropic API ─────────────────────────────────────────────┐
  │  response.usage = {                                          │
  │    input_tokens: 3168,           ← excludes cache reads     │
  │    output_tokens: 412,                                       │
  │    cache_creation_input_tokens: 2900,  (first turn)          │
  │    cache_read_input_tokens: 2900,      (subsequent turns)   │
  │  }                                                           │
  └────────────────────┬─────────────────────────────────────────┘
                       │
       ┌───────────────┼───────────────────────┐
       ▼               ▼                       ▼
  console.log    BudgetTracker.add       CapabilityEvent
  (per-turn      (accumulated per-       'model_usage'
   observability)  investigation)         (raw trace)
                       │                       │
                       ▼                       ▼
                exceeded()?          summarizeUsage(trace)
                       │                       │
                throws or continues     receipt.usage row
                                                │
                                                ▼
                                     baseline.json aggregates
                                     $0.09/case total
```

## Elaborate

Tokenization is where "how big is my prompt" and "how much will it cost" and "does it fit" all collapse into one number. BPE is the current standard (used by GPT-2 onward, Llama, and Anthropic's models — the exact vocabulary differs per model but the algorithm is the same). Older word-piece and character-level tokenizers still exist in specific research contexts.

Two under-discussed consequences show up in this codebase:

1. **JSON tokenizes worse than prose.** The `execute_analytics_eql` tool responses come back as structured JSON with lots of punctuation. A 2000-char response is often ~600 tokens, not ~500. That matters when you're loading tool_result content back into the messages array on every turn.
2. **Non-English is more expensive per character.** Bloomreach data can include Portuguese product names, Spanish country codes, etc. English averages ~4 chars/token; Portuguese is closer to ~2.5. Nothing to fix in this repo (the schema is machine-generated field names), but worth naming.

## Project exercises

### Exercise — surface token counts in the UI trace

- **Exercise ID:** C1.2-A · Case A (concept exercised in receipts, not exercised in UI).
- **What to build:** the `StatusLog` already streams `reasoning_step` and `tool_call_*` events. Add a per-turn `usage` event that carries `{inputTokens, outputTokens, cachedTokens}` and render it as a small badge next to each reasoning step in `ReasoningTrace.tsx`.
- **Why it earns its place:** turns the receipt-only observability into a live UX. Interviewer signal: "I made the cost of each turn visible in the product, not just the receipts — because a user watching the trace should see when a turn was cached vs uncached."
- **Files to touch:** `lib/mcp/events.ts` (add `usage` event variant), `lib/agents/aptkit-adapters.ts` (emit the event from `BloomingTraceSinkAdapter`), `components/investigation/ReasoningTrace.tsx` (render badge), `components/investigation/TraceContent.tsx`.
- **Done when:** running one investigation live in demo mode shows a small "3.2K in / 0.4K out / cache" badge next to each reasoning_step.
- **Estimated effort:** 1-4hr.

## Interview defense

**Q: How much does a diagnosis cost?**

About $0.09 per case in the committed baseline (agent-side, cached). That splits roughly $0.03-0.05 diagnose + $0.04-0.06 recommend. Judge calls add another ~$0.04 per judgment × 4 judgments per case (1 diagnosis + up to 3 recommendations) = ~$0.16 per case at judge time. Full 10-case run total: ~$1.30. Numbers from `eval/baseline.json` (runId `2026-07-03T04-08-28-644Z`) and per-case receipts in `eval/receipts/`.

**Q: What's an input token vs output token?**

Input tokens = every message sent TO the model (system prompt + user messages + assistant history + tool_result blocks). Output tokens = the content blocks the model produces THIS turn (text + tool_use). Anthropic's Sonnet 4 is $3/MTok input, $15/MTok output — output is 5× more expensive. That's why we design outputs to be concise: schema-constrained JSON, not free-form prose.

```
  Cost split per turn (Sonnet 4)

  input:  ▓▓▓ $3/MTok    ← the whole history goes here
  output: ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ $15/MTok ← the model's answer
                            5× multiplier
```

**Q: What does prompt caching do to the token count?**

Cache-read tokens are billed at ~10% of normal input tokens (Anthropic's ephemeral tier). In this repo, wrapping the system prompt in `cache_control: ephemeral` means turn 2 onward pays ~10% of the system prompt's ~2-3K tokens instead of full price. Over a 10-turn diagnosis, that's roughly a 60-80% reduction on the input side. Trade: turn 1 pays a 25% cache-creation premium.

## See also

- `06-token-economics.md` — the cost ledger this feeds
- `06-production-serving/01-llm-caching.md` — the cache breakpoint that reshapes the input side
- `06-production-serving/02-llm-cost-optimization.md` — Haiku for intent, Sonnet for reasoning
- `lib/agents/budget.ts` — the tracker
- `lib/agents/pricing.ts` — the Blooming Anthropic pricing table
