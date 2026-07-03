# Context window

## Subtitle

Fixed input budget / token-bounded input container — Industry standard.

## Zoom out, then zoom in

Sonnet 4.6 has a 200k-token context window. This codebase uses ~15k of it on the fixed prefix (system prompt + tool defs + workspace schema summary) and lets the messages accumulate from there. That's plenty of headroom for a 10-turn diagnostic. It doesn't stay that way if you're careless: the workspace schema is `112KB` of raw JSON on some accounts, which is why `schemaSummary()` in `lib/agents/monitoring.ts:19` compresses it to a ~1500-token summary before it hits the prompt.

```
  Zoom out — where context lives

  ┌─ Agent code ────────────────────────────────────────┐
  │  builds ModelRequest.messages + system + tools       │
  └───────────────────────┬──────────────────────────────┘
                          │
                          ▼
  ┌─ Adapter ★ ─────────────────────────────────────────┐ ← we are here
  │  packs system prompt (with cache_control),           │
  │  tool defs, messages into MessageCreateParams        │
  │  lib/agents/aptkit-adapters.ts:57                    │
  └───────────────────────┬──────────────────────────────┘
                          │  200k-token ceiling
                          ▼
  ┌─ Anthropic ─────────────────────────────────────────┐
  │  reads entire context every turn                     │
  └──────────────────────────────────────────────────────┘
```

Zoom in: the window is a finite container. Everything you send competes for space.

## Structure pass

- **Layers:** system prompt + tools + workspace schema + accumulated messages → all in one context per turn. Four bands, all in one bucket.
- **Axis: space competition.** Each band takes a share of the 200k. Fixed things (system, tools, schema) sit at the front and stay put. Growing things (messages, tool results) push against the ceiling.
- **Seam:** the `messages: [...]` array. Everything before it is fixed; everything in it grows.

## How it works

### Move 1 — the mental model

Think of the window as a fixed-size buffer with named regions:

```
  Context window — one turn's picture

  ┌────────────────────────────────────────────────────────┐
  │  System prompt                    [██░░░░░░░░░░░░]    │
  │  ~10-12k tokens (agent role, ecommerce framing, rules) │
  ├────────────────────────────────────────────────────────┤
  │  Tool definitions                 [░██░░░░░░░░░░░]    │
  │  ~2-3k tokens (MCP tool schemas)                       │
  ├────────────────────────────────────────────────────────┤
  │  Workspace schema summary         [░░█░░░░░░░░░░░]    │
  │  ~1500 tokens (schemaSummary(), trimmed)               │
  ├────────────────────────────────────────────────────────┤
  │  Messages (grows turn by turn)    [░░░████░░░░░░░]    │
  │  1000 → 20000 tokens over 5-10 turns                   │
  ├────────────────────────────────────────────────────────┤
  │  Response space                   [░░░░░░░░░░████░]    │
  │  ~4k tokens (bounded by max_tokens)                    │
  └────────────────────────────────────────────────────────┘

  Total: fixed at 200k for Sonnet 4.6.
  Everything competes for space.
```

### Move 2 — the step-by-step walkthrough

**The fixed prefix.** `lib/agents/aptkit-adapters.ts:57` builds the system prompt with a cache_control breakpoint on the whole thing. That prefix is what caches — turns 2+ read it from cache at ~10% of normal input cost. Making it too large would defeat caching by exceeding the cache-window limit; making it too small means more per-turn assembly cost.

**The schema summary.** `lib/agents/monitoring.ts:19-88` — `schemaSummary()` reads a `WorkspaceSchema` (up to 180 event types, dozens of properties each) and produces a bounded string:

```ts
// lib/agents/monitoring.ts:26-40 — bounded output
const MAX_EVENTS = 20;
const MAX_PROPS_PER_EVENT = 10;

const eventsText = schema.events
  .slice(0, MAX_EVENTS)          // 20 events, not 180
  .map((e) => {
    const props = e.properties.slice(0, MAX_PROPS_PER_EVENT).join(', ');
    return `  - ${e.name} (${e.eventCount}): ${props || '(no properties)'}`;
  })
  .join('\n');
```

Two hard caps: 20 events, 10 props each. That's the discipline — bounded output, regardless of input size. Events are already sorted by `eventCount` desc (see the `WorkspaceSchema` doc in `lib/mcp/schema.ts:14`), so the 20 you keep are the most-active ones.

**Messages growing over turns.** Every turn appends: the model's response (`assistant` role) and every tool result you fed back (`user` role, `tool_result` block). A 10-turn investigation with average 1500-token tool results ends up around 20k tokens of messages. Still comfortable inside 200k.

Diagram of a diagnostic's context growth over turns:

```
  Context growth — turn by turn (Sonnet 4.6, 200k ceiling)

  turn 1:  ~15500 tokens  (fixed prefix + first user message)
  turn 3:  ~19000         (+ 2 tool results + assistant turns)
  turn 5:  ~24000         (+ 2 more)
  turn 10: ~40000         (~ 5 tool results, longer thinking)

           still 5× headroom against ceiling
```

**Where it would break.** If a tool result is huge — say the raw `execute_analytics_eql` output contains 10k rows and returns 200kB of JSON — you can blow the window in a single tool call. Mitigation: `TRUNC = 4000` in `app/api/briefing/route.ts:73` caps tool result JSON at 4000 chars before streaming to the UI. The same trunc should also apply to what the model sees (currently the model gets the full result — a lurking risk).

### Move 3 — the principle

The context window is a shared resource. Every token in the system prompt is a token you can't spend on a tool result. Every token in a tool result is a token you can't spend on the next thought. Design for the fixed prefix to be small and cache-friendly; design for tool results to be bounded; measure the growth so surprises show up in a receipt, not in production.

## Primary diagram

```
  Context window — full frame with cache boundary

  ┌─ CACHED PREFIX (unchanged turn-to-turn) ──────────────┐
  │                                                        │
  │  System prompt   ~10-12k tokens                        │
  │  Tool defs       ~2-3k tokens                          │
  │  Schema summary  ~1.5k tokens                          │
  │  ────────────────────────────────  ← cache_control     │
  │                                    breakpoint          │
  └────────────────────────────────────────────────────────┘
                       │
                       │  followed by growing conversation
                       ▼
  ┌─ MESSAGES (fresh every turn, not cached) ──────────────┐
  │                                                         │
  │  turn 1 user, assistant                                 │
  │  turn 2 user (tool_result), assistant                   │
  │  turn 3 user (tool_result), assistant                   │
  │  ...                                                    │
  │  ~1000 → 20000 tokens over 5-10 turns                   │
  │                                                         │
  └─────────────────────────────────────────────────────────┘
                       │
                       ▼
  ┌─ RESPONSE SPACE ────────────────────────────────────────┐
  │  bounded by max_tokens (4096 default)                   │
  └─────────────────────────────────────────────────────────┘

  Total budget: 200k for Sonnet 4.6.
  Observed typical use: 25-40k per investigation. 5× headroom.
```

## Elaborate

The "context window" name is the industry-standard term. Older models had 4k or 8k; the modern floor is 100k+, with 1M-token models emerging. That doesn't mean your app should use 1M tokens — the same relevance-ordering rules apply (see **02-lost-in-the-middle.md**), and cost scales linearly.

The cache breakpoint's placement matters. Anthropic caches everything *before* the breakpoint; putting the breakpoint after all fixed content and before the first user message is the standard placement, and that's what this codebase does (`lib/agents/aptkit-adapters.ts:75-98`).

Related: **02-lost-in-the-middle.md** (why fitting matters isn't the same as attention working). **../06-production-serving/01-llm-caching.md** (how the cache exploits the fixed prefix).

## Project exercises

### B2.1 · Bound tool result size before it hits the model

- **Exercise ID:** B2.1
- **What to build:** The `TRUNC = 4000` cap in `app/api/briefing/route.ts:73` only trims what the UI sees. Extend the same bounded-output discipline to what the *model* sees in `tool_result` blocks: cap raw JSON at say 8kB per result, replace overflow with `"...(truncated, N more rows)"`. Add a receipt row when truncation fires.
- **Why it earns its place:** Closes a real lurking risk (a runaway EQL query result can blow the context) with a bounded, measured mitigation.
- **Files to touch:** `lib/agents/aptkit-adapters.ts` (BloomingToolRegistryAdapter.execute or the tool_result wrap), `test/agents/tool-schemas.test.ts` (add oversize test).
- **Done when:** a test that feeds a 100kB tool result into an agent turn produces an 8kB tool_result block with a truncation notice; the receipt records the truncation.
- **Estimated effort:** `1–4hr`.

## Interview defense

**Q: How do you keep the workspace schema out of the way when it's 112kB of JSON?**

`schemaSummary()` in `lib/agents/monitoring.ts:19-88` caps output at 20 events (sorted by `eventCount` desc so the important ones stay) × 10 props each. That's ~1500 tokens. The full schema is retained server-side for `runnableCategories()` and coverage decisions, but the model never sees it in bulk. Load-bearing: the model doesn't need to know every event exists — only the ones with signal.

**Q: Why not just push everything into a 200k-context model?**

Two reasons. (1) Cost — every token in the prefix is a token you pay for on every turn, cache or no cache. (2) Attention degrades in the middle of long contexts (see **02-lost-in-the-middle.md**), so a bigger context can produce a *worse* answer. The rule is fit-what-matters, not fit-everything.

## See also

- [02-lost-in-the-middle.md](02-lost-in-the-middle.md) — why fitting isn't enough.
- [../06-production-serving/01-llm-caching.md](../06-production-serving/01-llm-caching.md) — how the cache breakpoint on the prefix earns its place.
- [../01-llm-foundations/06-token-economics.md](../01-llm-foundations/06-token-economics.md) — the cost implications of a bigger prefix.
