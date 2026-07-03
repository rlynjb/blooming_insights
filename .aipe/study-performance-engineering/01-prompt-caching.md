# prompt caching

**Industry name(s):** prompt caching · prefix caching · ephemeral cache breakpoint (Anthropic-specific term). **Type label:** Industry standard.

## Zoom out — where prompt caching sits

You're in the Provider band of a three-band system. UI streams NDJSON up top; the agent loop (the ReAct loop) runs in the Service band; the cache breakpoint lives inside the Anthropic client at the very edge where the request goes over the wire.

```
Zoom out — where the cache breakpoint sits

┌─ UI band ────────────────────────────────────┐
│  browser · reads NDJSON · renders trace       │
└─────────────────────────┬────────────────────┘
                          │  stream
┌─ Service band ──────────▼────────────────────┐
│  route → agent (ReAct loop) → provider adapter │
│  turn 1: build request { system, messages }    │
│  turn 2: append tool_result, rebuild request   │
│  turn N: model returns text, loop terminates   │
└─────────────────────────┬────────────────────┘
                          │  every turn: POST /messages
┌─ Provider band ─────────▼────────────────────┐
│  Anthropic API                                │
│   ★ cache_control: ephemeral on system prompt │ ← we are here
│   → cache_creation on turn 1                  │
│   → cache_read on turn 2 (within 5-min TTL)   │
└──────────────────────────────────────────────┘
```

**Zoom in — what it is.** A single-line change on the system prompt tells Anthropic to cache the input prefix. The next call within a 5-minute window rereads that prefix from cache instead of billing you for the full input tokens. On a ReAct loop that reuses the same system prompt every turn — which every agent in this repo does — you go from N × full-prompt cost to 1 × full-prompt + (N-1) × 10% cost. The mechanism is the cache breakpoint; the payoff is roughly 80% off the system-prompt input bill across a normal investigation.

## Structure pass — layers · one axis · one seam

The axis worth tracing is **cost per token**. Hold it constant across three layers:

```
one axis held: "cost per input token this turn"

┌─ agent loop (ReAct) ──────────────────────────┐
│  the same system prompt every turn            │  → cost = fixed shape
└──────────────────────────┬────────────────────┘
                           │  seam: the request body
┌─ provider adapter ───────▼────────────────────┐
│  add cache_control on system prompt            │  → turn 1: cache_creation (1.25×)
└──────────────────────────┬────────────────────┘  → turn 2+: cache_read (0.1×)
                           │
┌─ Anthropic API ──────────▼────────────────────┐
│  matches the cached prefix                    │  → billed at the cache tier
└───────────────────────────────────────────────┘
```

**The seam.** The request body itself is the joint — same shape in, different billing out, depending on one field. The seam is load-bearing because the cost axis flips across it: the same tokens go in, but on one side they cost 1× and on the other they cost 0.1×.

## How it works

### Move 1 — the mental model

You know how HTTP caching works: the browser hashes the URL + headers, the server tags the response with an ETag, and the next request against the same hash comes back instantly with a 304. Prompt caching is the same shape, but the "URL" is the input prefix and the cache is Anthropic's, not yours.

```
The pattern — one turn, same prefix, different price

turn 1 (cache miss)                turn 2 (cache hit, within 5 min)
┌──────────────────┐               ┌──────────────────┐
│ system prompt    │───► cache      │ system prompt    │───► cache_read
│ + messages       │      create   │ + more messages  │      (0.1× cost)
│ (fresh)          │    (1.25×)    │ (turn 1 + result)│
└──────────────────┘               └──────────────────┘
        ▼                                   ▼
   POST /messages                      POST /messages
        ▼                                   ▼
usage.cache_creation_               usage.cache_read_
input_tokens: 3168                  input_tokens: 3168
```

The cache breakpoint is the mark on the request that says "hash everything before this point and cache the result." One breakpoint on the system prompt covers both the prompt itself AND the tool schemas — the Anthropic API caches tools transparently when the same breakpoint is set on the system prompt. That's why one line at line 87 catches both prefixes.

### Move 2 — the step-by-step walkthrough

#### Step 1 — set the breakpoint on the system prompt

In this codebase the breakpoint lives at `lib/agents/aptkit-adapters.ts:85-89`:

```typescript
if (request.system) {
  params.system = [
    { type: 'text', text: request.system, cache_control: { type: 'ephemeral' } },
  ];
}
```

The `request.system` field comes from AptKit's `ModelRequest` type — every agent's system prompt (diagnostic, recommendation, monitoring, query) rides this same code path because `AnthropicModelProviderAdapter` is the single adapter behind all of them. That's why one edit covered every ReAct loop in the repo, not just one agent.

**What breaks if you remove `cache_control`:** every turn is billed at 1× input cost. On a 10-turn investigation with a ~3000-token system prompt, that's 30,000 fully-billed prefix tokens instead of ~6,000 (one creation + nine reads). At $3/MTok input for sonnet-4-6, that's ~$0.072 vs ~$0.011 on prefix alone — about 6× the input cost per investigation for that prefix.

```
Layers-and-hops — one turn from adapter to Anthropic

┌─ Blooming service ──────┐  hop 1: system prompt → adapter
│  DiagnosticAgent        │ ─────────────────────────────┐
│  (build ModelRequest)   │                              │
└─────────────────────────┘                              │
                                                         ▼
                                        ┌─ AnthropicModelProviderAdapter ┐
                                        │  wrap system with              │
                                        │  cache_control: ephemeral      │
                                        └──────────┬─────────────────────┘
                                                   │  hop 2: POST /messages
                                                   ▼
                                        ┌─ Anthropic API ────────────────┐
                                        │  match cached prefix?           │
                                        │   → creation (1.25×) or read    │
                                        │   → return usage row            │
                                        └──────────┬─────────────────────┘
                                                   │  hop 3: response.usage
                                                   ▼
                                        ┌─ Blooming service ─────────────┐
                                        │  console.log { site, usage }   │  ← proof-of-cache
                                        └────────────────────────────────┘
```

#### Step 2 — the 5-minute TTL is a wall clock, not per-turn

The cache entry expires 5 minutes after the last hit. In a normal investigation (~100-115s live, ~225s in-eval), every turn lands well inside the window. The mechanism breaks silently if two things fall out of alignment:

- The system prompt changes between turns — cache miss.
- Two investigations run more than 5 minutes apart — the second pays cache_creation again.

**What breaks if you edit prompts mid-session:** cache_creation on every turn after the edit. Silent perf regression. Not a real threat here because the system prompts are `.md` files loaded at process start, not runtime-editable.

#### Step 3 — the log line at `console.log` is the receipt

`lib/agents/aptkit-adapters.ts:97`:

```typescript
console.log(JSON.stringify({
  site: this.logSite,
  sessionId: this.sessionId,
  usage: response.usage,
}));
```

`response.usage` from Anthropic includes `cache_creation_input_tokens` and `cache_read_input_tokens` when the request had a breakpoint. This is how you know the cache is live — grep the Vercel logs for `cache_read_input_tokens` and confirm the number grows across a session.

**The confirmation you got:** live logs show `cache_creation_input_tokens: 3168` on turn 1 of a session, then `cache_read_input_tokens: 3168` on turn 2 of the same session. Same number, one creation, one read. Cache is live.

#### Step 4 — cost math is an upper bound when caching is on

The Blooming pricing helper at `lib/agents/pricing.ts:14` is explicit about this:

```typescript
// Prices are per-million-tokens (MTok) in USD. Do NOT include cache-tier
// pricing here — Phase 2 receipts capture only `inputTokens`/`outputTokens`
// (aptkit's model_usage event shape), which already exclude cache-read
// tokens from the input count. Cost estimated here is therefore an
// UPPER BOUND when caching is on.
```

So the ~$0.09/case number in the baseline is an upper bound. The real spend is lower when the cache is hitting, which it is. The gap is small in practice (the system prompt is ~3000 tokens out of ~10,000 total input tokens per investigation), but the report's cost column is the ceiling, not the actual.

### Move 3 — the principle

Caching earns its keep when the same prefix is reused across N calls. A ReAct loop is exactly that shape by construction — the system prompt is fixed, the messages array grows by one tool_result per turn, and the model rereads the whole thing each time. The prompt-caching mechanism doesn't invent this repetition; it *bills* the repetition at the tier the repetition deserves. One line at one seam turns N × full into 1 × creation + (N-1) × 0.1×.

## Primary diagram — the recap

Everything the walkthrough covered, in one frame.

```
The prompt-caching pattern — end to end

┌─ Blooming service ──────────────────────────────────────────────┐
│  Diagnostic / Recommendation / Monitoring / Query agents         │
│  all funnel through:                                             │
│    AnthropicModelProviderAdapter.complete()                      │
│    lib/agents/aptkit-adapters.ts:59                              │
└──────────────────────────────┬──────────────────────────────────┘
                               │
                               │  system: [{ text, cache_control: ephemeral }]
                               ▼
┌─ Provider band — Anthropic API ─────────────────────────────────┐
│                                                                  │
│   turn 1 ──► hash(system + tools)                                │
│           ──► miss ──► create entry (1.25× input cost)            │
│           ──► usage.cache_creation_input_tokens: 3168             │
│                                                                  │
│   turn 2 ──► hash(system + tools)                                │
│           ──► HIT within 5 min                                    │
│           ──► usage.cache_read_input_tokens: 3168 (0.1× cost)     │
│                                                                  │
│   turn 10 ──► same hit path, cost stays low                       │
│                                                                  │
└──────────────────────────────┬──────────────────────────────────┘
                               │
                               │  response.usage (with cache tokens)
                               ▼
┌─ Blooming service ──────────────────────────────────────────────┐
│  console.log { site, sessionId, usage } ← proof-of-cache          │
│  BudgetTracker.add({ inputTokens, outputTokens })                 │
│    (note: does NOT subtract cache_read fraction — conservative)   │
└──────────────────────────────────────────────────────────────────┘
```

## Elaborate

Anthropic shipped prompt caching in beta in mid-2024 and made it GA later that year. The `cache_control: { type: 'ephemeral' }` breakpoint is Anthropic-specific; OpenAI does prefix caching automatically without an explicit breakpoint (the tradeoff being you don't get to choose exactly what's cached). The industry pattern — cache stable prefixes across sequential calls — is universal.

The ephemeral TTL is 5 minutes. Anthropic also offers a 1-hour TTL at different pricing. This repo picked ephemeral because investigations complete in under 4 minutes and the shorter TTL is the cheaper cache_creation tier.

**Adjacent primitive worth naming.** This is the same shape as HTTP `Cache-Control: max-age`. The user sets one field on the response; the client caches; a matching future request comes back at cache tier. On the model side, "the response" is really the input prefix (you're paying for the model to reread it), so the field goes on the *request*, not the response. But the pattern is HTTP caching applied to the wrong layer of a different protocol.

**What to read next.** Anthropic's prompt-caching docs for the exact TTL and cost multipliers. `02-per-investigation-budget-ceiling.md` for how the token accounting interacts with the budget tracker (it undercounts cache reads, on purpose — the tracker is slightly conservative).

## Interview defense

**Q: Walk me through prompt caching and how you'd know it's working in production.**

The mechanism is a `cache_control: { type: 'ephemeral' }` field on the message that marks the input prefix — you know the ReAct loop is going to send the same system prompt every turn, so you mark it once. First turn is a `cache_creation` billed at ~1.25× normal input cost. Every turn within the 5-minute TTL is a `cache_read` at ~10% normal. The receipt is `response.usage.cache_read_input_tokens` — you log the whole usage object per turn and grep production logs for that field. In my case I saw `cache_creation_input_tokens: 3168` on turn 1 followed by `cache_read_input_tokens: 3168` on turn 2 — same number, one create, nine reads across a normal investigation. The load-bearing part people miss is that the system prompt has to be *byte-identical* across turns — one whitespace change silently blows the cache and you don't get an error, you get a bigger bill. Anchor the diagram to the receipt: no `cache_read` in the log = the cache isn't hitting, no matter what the config says.

```
The anchor diagram to sketch

turn 1        turn 2
system: 3168  system: 3168
    │             │
    ▼             ▼
cache_creation  cache_read
  (1.25×)         (0.1×)
    │             │
    ▼             ▼
usage.cache_creation_  usage.cache_read_
input_tokens: 3168     input_tokens: 3168
    │             │
    └─────► receipt in Vercel logs (line 97)
```

**Q: What breaks if you remove the `cache_control` line?**

Every turn is billed at 1× input cost — no cache_creation, no cache_read, just full input tokens. On a 10-turn investigation with a 3000-token system prompt that's a 6× jump on the prefix cost. You'd see it in the cost column of the report immediately if you compared runs before and after. What people forget: you'd also see it as a slowdown, because uncached inputs go through the full input path on Anthropic's side and cached inputs skip a chunk of it.

**Q: Why ephemeral over the 1-hour cache tier?**

Investigations run in under 4 minutes end-to-end. The ephemeral tier (5-min TTL) matches the workload and has a cheaper `cache_creation` multiplier. If we ran hour-long batch jobs against the same prompt, the 1-hour tier would be the right call.

**Q: Where's this in the code?**

`lib/agents/aptkit-adapters.ts:85-89`. One `if (request.system)` block that wraps the string in an array with the cache_control field. That single adapter is behind every agent — diagnostic, recommendation, monitoring, query — because they all instantiate `AnthropicModelProviderAdapter`. One edit, four agents.

## See also

- `02-per-investigation-budget-ceiling.md` — the budget tracker undercounts cache reads on purpose, so the ceiling is conservative.
- `03-observability-report.md` — how per-turn usage gets aggregated into the report's cost column.
- `audit.md` §6 — caching-batching-and-backpressure lens finding.
