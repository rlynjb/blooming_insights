# Tokenization

## Subtitle

Byte-Pair Encoding / subword tokenization — Industry standard.

## Zoom out, then zoom in

Every cost number in this codebase — the `$0.09/case` in the eval receipts, the `cache_read_input_tokens: 3168` win, the budget ceiling in `lib/agents/budget.ts` — is denominated in *tokens*, not characters. Tokenization is where "the prompt is 2000 characters" gets translated into "the prompt is 500 tokens." That translation happens on Anthropic's side; your code sees the token counts come back in the response `usage` field and pays accordingly.

```
  Zoom out — where tokens are counted

  ┌─ Agent code ─────────────────────────────────────────┐
  │  messages: [{ role, content: "..." }]  ← chars       │
  └───────────────────────┬──────────────────────────────┘
                          │  POST /v1/messages
  ┌─ Anthropic (tokenizer + model) ─▼───────────────────┐
  │  ★ tokenize(text) → tokens ★                         │ ← we are here
  │  next-token prediction over the tokenized input      │
  └───────────────────────┬──────────────────────────────┘
                          │  response.usage
  ┌─ Adapter ─────────────▼──────────────────────────────┐
  │  onCapabilityEvent → summarizeUsage → cost           │
  │  lib/agents/aptkit-adapters.ts:113 (trace sink)      │
  └───────────────────────────────────────────────────────┘
```

Zoom in: your code never sees the tokens. It sees the *count* of tokens (via `response.usage.input_tokens` / `output_tokens` / `cache_read_input_tokens`) and computes cost from that.

## Structure pass

- **Layers:** prompt strings → Anthropic tokenizer → token counts → cost estimate. Four bands.
- **Axis: who owns the count?** Your code owns the input strings. Anthropic owns the tokenizer + count. Your code owns the pricing math and the budget check. So the count crosses one seam: string → count. Everything downstream is arithmetic on numbers you got back.
- **Seam:** the `usage` field on the model response. That's the boundary where "text you wrote" becomes "tokens you pay for."

## How it works

### Move 1 — the mental model

BPE (Byte-Pair Encoding) is the standard. Start with a vocabulary of bytes; iteratively merge the most common adjacent pairs until you have a fixed-size vocabulary (typically 100k–200k tokens for modern models). Common words end up as one token ("hello"), rare words split ("Bloomreach" might be `Bloom` + `reach`), and code / punctuation each get their own tokens.

```
  Text → tokens (BPE, sketched)

  "The mobile checkout dropped 18.4%"
                     │
                     ▼  BPE tokenizer
                     │
    [The][ mobile][ checkout][ dropped][ 18][.4][%]
        1      2         3         4       5    6  7
                          7 tokens for 33 chars
                          ≈ 4.7 chars per token (English prose)
```

Rules of thumb from the actual usage in this codebase:

- English prose: ~4 characters per token.
- Code / structured data (JSON, schemas): 2–3 chars per token — more tokens per character.
- The workspace schema summary from `lib/agents/monitoring.ts:19-88`: ~180 events × 10 props each ≈ 1500 tokens.

### Move 2 — the step-by-step walkthrough

**Where token counts are consumed.** The trace sink is where token counts hit your code:

```ts
// lib/agents/aptkit-adapters.ts (BloomingTraceSinkAdapter — the CapabilityTraceSink)
// Every aptkit CapabilityEvent flows through here; model_usage events carry
// { inputTokens, outputTokens, cacheReadTokens? } on the payload.
onEvent(event: CapabilityEvent): void {
  this.hooks.onCapabilityEvent?.(event);
  // ... routing to tool/text hooks
}
```

The receipts pipeline in `eval/run.eval.ts` collects those events, calls `summarizeUsage()` from aptkit, then feeds the summary into `estimateAnthropicCost()` from `lib/agents/pricing.ts:41` to produce dollars.

**Where token counts are enforced.** The budget check in `lib/agents/budget.ts` reads the accumulated total across all model turns and blocks the next dispatch if the ceiling is hit:

```ts
// lib/agents/budget.ts — BudgetTracker.add() then .exceeded()
add(usage: { inputTokens: number; outputTokens: number }): void {
  this.inputTokens += usage.inputTokens;
  this.outputTokens += usage.outputTokens;
  this.turns += 1;
}
```

**Where tokens matter for the context window.** Sonnet 4.6's context window is 200k tokens. The system prompt + tools + workspace schema is roughly 12–15k tokens (a large but bounded fixed prefix). That leaves ~185k for messages, tool results, and the growing conversation history. A typical diagnostic run uses 20–40k of that ceiling.

Execution trace of a real run (case 01 from the baseline):

```
  Token accounting — one investigation turn by turn

  turn 1:  input=13400  cache_created=13400  output=890   ← cache built
  turn 2:  input=310    cache_read=13400     output=1120  ← cache hit
  turn 3:  input=890    cache_read=13400     output=780
  turn 4:  input=650    cache_read=13400     output=940
  turn 5:  input=1200   cache_read=13400     output=1450
                                              ─────
                                              5180 out tokens

  billed:  input (13400 × 1.25 cache_created) + (3050 fresh)
         + cache_read (13400 × 4 × 0.1)
         + output (5180 full price)
```

The `cache_read × 0.1` multiplier is where prompt caching earns its place — turns 2+ pay 10% of normal input cost for the cached prefix. See **06-production-serving/01-llm-caching.md**.

### Move 3 — the principle

Tokens are the unit of both cost and context. Every optimization — trimming the schema summary, caching the system prompt, splitting a long response — pays or bills in tokens. Any code that estimates budget or cost in characters is off by whatever the current chars-per-token ratio is (typically 3–5×) and drifts silently as the input mix changes.

## Primary diagram

```
  From string to bill — one frame

  ┌─ your TS code ─────────────────────────────────────┐
  │  string prompts, JSON tool schemas                 │
  └──────────────────────┬─────────────────────────────┘
                         │ POST /v1/messages
                         ▼
  ┌─ Anthropic ────────────────────────────────────────┐
  │  BPE tokenizer  →  model  →  response tokens       │
  │  returns usage: { input_tokens, output_tokens,      │
  │                    cache_read_input_tokens }        │
  └──────────────────────┬─────────────────────────────┘
                         │ ModelResponse
                         ▼
  ┌─ Adapter → trace sink → receipts ──────────────────┐
  │  onCapabilityEvent → summarizeUsage → cost helper  │
  │  eval/receipts/*.json contain per-turn tokens      │
  └────────────────────────────────────────────────────┘
```

## Elaborate

BPE was popularized by GPT-2's tokenizer; earlier models used word-level or character-level tokenizers, both of which had known failure modes (large vocabulary or extreme sequence length). Anthropic's exact BPE variant is proprietary but behaves similarly to `tiktoken` at rough estimation quality.

Non-English text is more expensive per character — Japanese and Chinese tokenize at ~1–2 characters per token, roughly 3× the input cost of English for the same information. This codebase happens to be English-only (Bloomreach queries + Anthropic prompts), so the cost math stays predictable.

Related: **06-token-economics.md** for the cost accounting derived from token counts, **01-llm-caching.md** for how caching changes what you pay per token.

## Project exercises

### B1.2 · Add a token counter to the trace sink

- **Exercise ID:** B1.2
- **What to build:** Extend `BloomingTraceSinkAdapter` in `lib/agents/aptkit-adapters.ts` to sum input+output tokens across every turn and log a per-agent total when the agent completes. Surface it as a new `AgentEvent` variant so the UI's `StatusLog` can display it live.
- **Why it earns its place:** Shows the interviewer you understand token accounting is not a batch-time-only concern; a good production surface exposes live tokens/cost per invocation.
- **Files to touch:** `lib/agents/aptkit-adapters.ts` (BloomingTraceSinkAdapter), `lib/mcp/events.ts` (new event variant), `components/shared/StatusLog.tsx` (render it).
- **Done when:** every completed investigation posts a `token_summary` event and the sidebar shows "used 45,320 tokens · ~$0.09" at the end.
- **Estimated effort:** `1–4hr`.

## Interview defense

**Q: How do you estimate the cost of a new feature before you ship it?**

Sketch the prompt at target length in characters, divide by 4 for English (or 2.5 for code / JSON), multiply by the number of expected turns for input tokens; estimate output at ~1000 tokens per turn as a starting point; apply `lib/agents/pricing.ts:41`'s per-million rates. For a 10-turn diagnostic with 15k input prefix, expect $0.05–$0.10 per case at Sonnet pricing. That's the pre-commit napkin; the eval receipts confirm or refute after the first live run.

```
  Napkin math

  input_prefix_chars / 4 = input_prefix_tokens
  turns × (input_prefix + output_est) = total_tokens (roughly)
  total × per-token price = $ per invocation
```

**Q: What's `cache_read_input_tokens` and why does it matter here?**

It's the count of input tokens that hit the prompt cache and were therefore billed at ~10% of normal input price. In this codebase, every diagnostic and recommendation agent turn after the first reads ~13k cached tokens for the system prompt + workspace schema. That's the observed ~80% cost cut on the input side. See `lib/agents/aptkit-adapters.ts:75-98` for the cache_control breakpoint.

## See also

- [06-token-economics.md](06-token-economics.md) — turning token counts into dollars.
- [../06-production-serving/01-llm-caching.md](../06-production-serving/01-llm-caching.md) — where the cache_read count comes from.
- [../02-context-and-prompts/01-context-window.md](../02-context-and-prompts/01-context-window.md) — the ceiling all these tokens compete for.
