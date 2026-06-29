# Tokenization

*Industry standard — subword tokenization (BPE-family)*

## Zoom out — where this concept lives

The model doesn't see characters. It sees tokens — numeric IDs into a learned vocabulary. Every `usage.input_tokens` number in your logs and every "context window" size in the SDK docs is in this unit. In this codebase, tokenization happens inside the Anthropic API; you only see the count, not the splits.

```
  Zoom out — where tokenization lives

  ┌─ Your code ──────────────────────────────────┐
  │  agent prompt + tool schema + tool results    │
  │  (all strings)                                │
  └──────────────────────┬───────────────────────┘
                         │  passed as strings
                         ▼
  ┌─ Anthropic API ──────────────────────────────┐
  │  ★ tokenizer ★  → token IDs                   │ ← we are here
  │  → model → token IDs → string                 │
  └──────────────────────┬───────────────────────┘
                         │  ContentBlock + usage
                         ▼
  ┌─ Your code reads response.usage ─────────────┐
  │  input_tokens, output_tokens                  │
  │  (the bill, in this unit)                     │
  └──────────────────────────────────────────────┘
```

**Zoom in.** The tokenizer is invisible from your code — you only see the count. But that count is what you pay for (`06-token-economics.md`), what fits in the window (`02-context-and-prompts/01-context-window.md`), and what gets logged at `lib/agents/aptkit-adapters.ts:60`.

## Structure pass — layers · axes · seams

**Layers:** your strings → SDK serialization → API tokenizer → model.

**Axis: what unit am I reasoning in?** Your code: chars. The SDK: bytes (UTF-8). The API: tokens (subwords). The model: tokens. The mismatch matters at the boundary — `schemaSummary()` at `lib/agents/monitoring.ts:18` truncates by item count (events, properties), not by tokens, because token counting from your side requires either calling out to Anthropic's token-counting endpoint or shipping a local tokenizer. This codebase does neither.

**Seam:** the tokenizer-on-the-server boundary. Your truncation logic (`schemaSummary` cap-at-20-events) is a *proxy* for token budget; if the event names get long, the proxy overspends.

## How it works

### Move 1 — the mental model

You know how a hash function takes a string and returns a fixed-size number? A tokenizer takes a string and returns a *sequence* of numbers — each number an index into the model's vocabulary. ~100k entries in Anthropic's vocab. Common substrings (`" the "`, `"ing"`) get single tokens; rare ones get split into pieces.

```
  The shape of tokenization

  "Hello, world!"
       │
       ▼  BPE-style subword tokenizer
       │
  [15496, 11, 995, 0]
   Hello   ,   world  !

  ~4 chars per token in English.
  Fewer (~2-3 chars per token) for code, JSON,
   or non-English text — because subwords are
   learned from the training corpus, which is
   English-heavy.
```

### Move 2 — the step-by-step walkthrough

**Part 1 — your code never sees tokens, only counts.**

`lib/agents/aptkit-adapters.ts:55-60` logs `response.usage` after every call. That object has `input_tokens` and `output_tokens` as integers. That's the only window you have into the tokenizer from this side.

```typescript
console.log(JSON.stringify({
  site: this.logSite,           // "agents/monitoring:aptkit-model"
  sessionId: this.sessionId,
  usage: response.usage,        // { input_tokens: 1247, output_tokens: 318 }
}));
```

A Vercel log filter on `site = "agents/monitoring:aptkit-model"` gives per-agent token volume. The intent classifier (Haiku) has its own log site: `"agents/intent:classifyIntent"` (set at `lib/agents/intent.ts:30`).

**Part 2 — you budget by proxy, not by real count.**

`schemaSummary()` at `lib/agents/monitoring.ts:18-58` caps the schema dump at 20 events and 10 properties per event, plus 30 customer properties. The cap is by *item count*, not by token count, because counting tokens on the client side would require either an API call or a shipped tokenizer. From `lib/agents/monitoring.ts:24-26`:

```typescript
const MAX_EVENTS = 20;
const MAX_PROPS_PER_EVENT = 10;

const eventsText = schema.events
  .slice(0, MAX_EVENTS)
  .map((e) => {
    const props = e.properties.slice(0, MAX_PROPS_PER_EVENT).join(', ');
    return `  - ${e.name} (${e.eventCount}): ${props || '(no properties)'}`;
  })
  .join('\n');
```

This is the load-bearing simplification: 20 events × ~80 chars per event ≈ 1600 chars ≈ ~400 tokens. Comfortable. But if Bloomreach ships events with very long property names, the cap underestimates the real cost.

**Part 3 — output is the same unit, capped at 4096.**

The adapter sets `max_tokens: 4096` (`lib/agents/aptkit-adapters.ts:45`). That's the model's hard cap on output. A recommendation with 5 detailed entries + steps + rationale comfortably fits; a 50-recommendation dump would get truncated mid-token.

### Move 3 — the principle

**Tokens are the unit you pay for, the unit that fits, and the unit that's truncated.** Counting tokens locally is annoying (requires a tokenizer); counting *proxies* (items, lines, chars) is fast but lossy. This codebase uses proxies. If token costs ever surprise, the first fix is real counting.

## Primary diagram — the full recap

```
  Tokenization — your side, the API's side

  ┌─ Your side ────────────────────────────────────────────────┐
  │  strings:                                                  │
  │    "You are the monitoring agent…"  (system)               │
  │    "Project: wobbly-ukulele  Total customers: 126,420…"   │
  │    "[{ name: 'execute_analytics_eql', input_schema:{…} }…" │
  │                                                            │
  │  proxy budgeting:                                          │
  │    schemaSummary caps at 20 events × 10 props              │
  │    max_tokens: 4096 on output                              │
  └──────────────────────────────┬─────────────────────────────┘
                                 │  HTTPS (UTF-8 bytes)
                                 ▼
  ┌─ Anthropic side ───────────────────────────────────────────┐
  │  tokenizer: string → token IDs (~100k vocab)              │
  │  ~4 chars per token (English prose)                        │
  │  ~3 chars per token (code, JSON)                           │
  │  ~2 chars per token (non-English)                          │
  │  bill = (input_tokens × input rate) + (output_tokens × output rate)│
  └──────────────────────────────┬─────────────────────────────┘
                                 │  response.usage = { input, output }
                                 ▼
  ┌─ Logged at aptkit-adapters.ts:55-60 ───────────────────────┐
  │  console.log({ site, sessionId, usage })                   │
  └────────────────────────────────────────────────────────────┘
```

## Elaborate

Anthropic uses a BPE-family tokenizer (Byte Pair Encoding). The vocabulary is learned by greedily merging frequent character pairs in the training corpus. The upshot: common English subwords (`the`, `ing`, `tion`) are single tokens; rare words or non-Latin scripts get fragmented. JSON tends to tokenize a bit worse than prose because punctuation often takes its own token.

**Where this matters for the codebase:** the agent prompts are heavy on JSON (tool definitions, schema summaries, tool results). Rough rule of thumb: assume ~3 chars per token for the schema-summary block and ~4 chars per token for the prose system prompt.

Anthropic exposes a `count_tokens` endpoint that lets you measure exactly without calling the model. This codebase doesn't use it — adding it would replace the `schemaSummary` item-count cap with a real token cap. Probably worth doing once you start hitting `max_tokens` truncation on the output side.

## Project exercises

### Exercise — Real token budgeting via Anthropic's count_tokens endpoint

  → **Exercise ID:** B1.2
  → **What to build:** Replace `schemaSummary`'s item-count cap with a real token-budget cap. Call Anthropic's `messages.countTokens` before serializing the prompt; if over budget, drop events from the bottom of the sorted list (least active first) until you fit.
  → **Why it earns its place:** turns a lossy proxy into real budgeting. The first signal you actually have left to add to monitoring before the cost story tightens.
  → **Files to touch:** `lib/agents/monitoring.ts` (`schemaSummary` → `schemaSummaryWithBudget(schema, budgetTokens, anthropic)`), `lib/agents/aptkit-adapters.ts` (expose token-counting via the adapter), `test/agents/monitoring.test.ts` (add tests covering at-budget + over-budget cases).
  → **Done when:** the schema summary holds to a configurable token budget (e.g. 600 tokens), a metric is added to the per-call log showing `{ schemaSummaryTokens, schemaSummaryEvents, budget }`, and the existing monitoring tests still pass.
  → **Estimated effort:** 1–4hr.

## Interview defense

**Q: "How big is your monitoring agent's prompt, in tokens?"**

Don't know exactly. The system prompt is ~400 tokens, the schema summary caps at ~400-500 tokens by proxy (20 events × 10 properties + customer props), plus tool definitions are another ~800 tokens. Rough total: ~1500-1800 input tokens before any tool calls. I haven't wired up Anthropic's `count_tokens` endpoint yet — the cap is by item count, which is a proxy. If property names ever get long, the proxy underestimates.

*Anchor: "Item-count proxy now, real `count_tokens` is the next step (`B1.2`)."*

**Q: "Where do you measure tokens?"**

In one place: the `complete()` method at `lib/agents/aptkit-adapters.ts:55-60`. Every Anthropic call funnels through there, so every call gets a log line with `usage`. Vercel log filter on the `site` field gives me per-agent volume. That's the only telemetry the AI stack has today — no Langfuse, no LangSmith.

*Anchor: "One log line per call, filterable by `site`. The adapter is the funnel."*

## See also

  → `01-what-an-llm-is.md` — the function tokens flow through
  → `06-token-economics.md` — what those numbers cost in dollars
  → `02-context-and-prompts/01-context-window.md` — the budget the tokens compete for
  → `05-evals-and-observability/04-llm-observability.md` — the telemetry story the `usage` log is part of
