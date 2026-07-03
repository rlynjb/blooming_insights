# 03 · Prompt caching — ephemeral breakpoint

**Prompt prefix caching · Industry standard.** Anthropic-specific
API surface; Google Vertex has `cachedContent`, OpenAI has prompt
caching (auto), Bedrock has prompt cache. Same pattern, different
API.

## Zoom out — where the cache lives

The prompt cache is a **server-side** cache. The client (this repo)
does one thing: mark WHICH part of the prompt to cache. Anthropic
stores the prefix's KV cache for ~5 minutes, and every subsequent
call within that window pays roughly 0.1× the normal input cost
for that prefix instead of full re-processing.

```
  Zoom out — the prompt cache seam

  ┌─ Agent turn N ──────────────────────────────────────────────┐
  │  ReAct loop: system prompt + tool defs + conversation        │
  └────────────────────────────┬─────────────────────────────────┘
                               │  messages.create({ system: [...] })
  ┌─ AnthropicModelProviderAdapter (client side) ───▼───────────┐
  │  ★ THIS FILE                                                 │
  │  system[0] = { text, cache_control: { type: 'ephemeral' } } │
  │  · one breakpoint · applies to system prompt AND tool defs   │
  └────────────────────────────┬─────────────────────────────────┘
                               │  HTTPS
  ┌─ Anthropic API (server side) ─────────▼─────────────────────┐
  │  · turn 1: cache_creation (~1.25× input cost)                │
  │  · turns 2..N within 5-min TTL: cache_read (~0.1× input)    │
  │  · returns cache_read_input_tokens in response.usage         │
  └───────────────────────────────────────────────────────────────┘
```

**Zoom in — the pattern in one sentence.** You mark a stable prefix
of your prompt with a cache breakpoint on the FIRST call. Every
subsequent call within the TTL that reuses the exact same prefix
gets a cache HIT. The cost model rewards you for putting stable
content at the front and volatile content at the back.

## Structure pass — layers, axis, seams

**Layers.** The stack from stable to volatile: system prompt →
tool definitions → prior conversation turns → the latest user
message + tool result. The stable stuff belongs at the top; the
volatile stuff at the bottom. Prefix caching only helps for the
stable prefix.

**Axis: how stable is this content across turns?**

```
  Axis — "does this content change between turn N and turn N+1?"

  ┌─ layer ─────────────────┐   change frequency   → cache?
  │ system prompt           │   NEVER within a run   ★ CACHE HERE ★
  ├─────────────────────────┤
  │ tool definitions        │   NEVER within a run   ★ CACHE HERE ★
  ├─────────────────────────┤
  │ prior conversation      │   grows each turn      caching hits break
  │                         │   (append-only)        after breakpoint
  ├─────────────────────────┤
  │ latest tool result      │   always new           no cache hit
  └─────────────────────────┘
```

**Seams.** The seam that matters is the *breakpoint position*.
Placing `cache_control` on the system prompt (position 0) means
the cached prefix is everything up to and including the system
prompt. Anthropic caches the tool definitions transparently on the
same breakpoint — so one breakpoint at the system prompt covers
both stable prefixes, which is the payoff for placing it there
specifically (comment at `aptkit-adapters.ts:82-84` names this).

## How it works

### Move 1 — the mental model

You already know how HTTP `ETag` + `If-None-Match` lets a browser
skip re-downloading unchanged content. Prompt caching is that idea
at the model-call boundary: mark a stable prefix, the server
recognizes it on the next call, skips re-processing, and charges
you a fraction of the normal cost for that portion.

```
  Pattern — prompt prefix cache lifecycle

    turn 1:  [system + tools] + [messages 1..1]
             ★ cache_control breakpoint on system ★
             → cache_creation: pay ~1.25× normal input cost
                                 on everything up to breakpoint
             → cache is warm for 5 minutes

    turn 2:  [system + tools] + [messages 1..2]     ← same prefix
             ★ cache_control breakpoint on system ★
             → cache_read: pay ~0.1× normal input cost
                             on everything up to breakpoint
             → new content after breakpoint pays full price

    turn N:  [system + tools] + [messages 1..N]     ← still same prefix
             ★ cache_control breakpoint on system ★
             → cache_read again (as long as < 5 min since turn 1)
```

**Skeleton part everyone forgets.** *Everything up to the
breakpoint must be byte-identical across turns.* Change one
character in the system prompt between turn 1 and turn 2 and turn
2 pays cache_creation again — you get 1.25× instead of 0.1×.
That's why the system prompt is where the breakpoint goes: it's
the largest stable chunk, and the ReAct loop keeps it fixed by
construction (comment at `aptkit-adapters.ts:76-84`).

### Move 2 — walking the mechanism

#### The client marks the breakpoint

`lib/agents/aptkit-adapters.ts:85-89`:

```ts
if (request.system) {
  params.system = [
    { type: 'text', text: request.system, cache_control: { type: 'ephemeral' } },
  ];
}
```

**What this is doing.** The Anthropic API accepts either a string
system prompt (no caching) or an array of content blocks (allows
`cache_control`). This code always uses the array shape so the
breakpoint can be attached. `type: 'ephemeral'` is Anthropic's
name for the 5-minute-TTL cache tier (vs `type: 'persistent'` if
they add longer-lived tiers).

**One breakpoint, two prefixes cached.** The comment at
`aptkit-adapters.ts:82-84` names the payoff:

```
  // Tools are also stable across the loop but the Anthropic API caches
  // tools transparently when the SAME breakpoint is set on the system
  // prompt — so this one addition covers both prefixes.
```

That's why placing the breakpoint on the system prompt specifically
matters. Anthropic's server-side implementation cascades: if the
system prompt hits, the tool defs hit too, without a second
breakpoint.

#### The server returns cache accounting

The Anthropic response includes `usage` fields:

```
  response.usage = {
    input_tokens: 234,                    // uncached new content
    cache_creation_input_tokens: 3168,    // paid ~1.25× on turn 1
    cache_read_input_tokens: 3168,        // paid ~0.1× on turns 2..N
    output_tokens: 512,
  }
```

**Validated live in the receipts.** `eval/receipts/01-conversion-drop-mobile-checkout-2026-07-03T04-08-28-644Z.json`
records `cache_read_input_tokens: 3168` on turn 2 of the diagnostic
run (the prompt-caching-validated line in the release notes). That
number is the same across turns 2..N — the whole system prompt
lands in the cache tier.

#### The budget tracker undercounts by design

`lib/agents/aptkit-adapters.ts:103-110`:

```ts
// Phase-3 budget accumulation. Uses inputTokens (not cache_read tokens
// — those aren't exposed by aptkit's model_usage event) so the tracker
// is slightly conservative when caching is on: it undercounts the
// cache-read fraction.
this.budget?.add({
  inputTokens: response.usage.input_tokens,
  outputTokens: response.usage.output_tokens,
});
```

**What "undercounts" means.** Cache-read tokens exist as billable
cost (~0.1× normal) but they're NOT summed into `input_tokens` by
Anthropic; they live in `cache_read_input_tokens`. The budget
tracker uses `input_tokens` only, so it doesn't count the cache-
read cost fraction. This is intentional: it makes the ceiling
slightly conservative when caching is on (the real spend is a bit
higher than tracked), but the direction is safer than the
opposite. A future enhancement would sum `cache_creation_input_tokens
× 1.25 + cache_read_input_tokens × 0.1 + input_tokens × 1.0` — but
until aptkit's `model_usage` event exposes those fields, the
conservative shortcut is correct.

### Move 3 — the principle

Cache stable prefixes; keep volatile content out of the cache
region. The economics only work when the prefix truly doesn't
change — one byte drift wipes the benefit. The consequence for
prompt design: put system instructions, tool definitions, and any
reference material FIRST; put the user's specific question, the
retrieved documents, and the latest tool result LAST. This is a
prompt-engineering discipline enforced by the cost model.

## Primary diagram

```
  The full lifecycle of one ReAct loop with prompt caching

  turn 1                                                  turn 2..N
  ─────────────────────────────                          ─────────────────
  ┌─ request ────────────┐                              ┌─ request ─────┐
  │ system[0] = {         │                              │ system[0] = { │
  │   text: PROMPT,       │  ─── 5-min TTL cache ────►   │   text:PROMPT,│
  │   cache_control:      │                              │   cache_ctrl: │
  │     ephemeral         │                              │     ephemeral │
  │ }                     │                              │ }             │
  │ tools: [...]          │  ─── implicitly cached ──►   │ tools: [...]  │
  │ messages: [...]       │                              │ messages: [   │
  └─────────┬─────────────┘                              │   …prev turns,│
            │                                            │   NEW tool_res│
            │                                            │ ]             │
            │                                            └────┬──────────┘
            │                                                 │
            ▼                                                 ▼
      Anthropic API                                     Anthropic API
      · reads prefix                                    · looks up prefix
      · writes cache                                    · CACHE HIT
      · charges ~1.25× on prefix                        · charges ~0.1× on prefix
      · charges 1× on new content                       · charges 1× on new content
            │                                                 │
            ▼                                                 ▼
      usage.cache_creation                              usage.cache_read
        _input_tokens = N                                _input_tokens = N
```

## Elaborate

**Where the pattern comes from.** Anthropic shipped prompt caching
in August 2024. The general shape (server-side cache keyed by
prefix) predates it: KV cache reuse is how autoregressive
transformers reduce cost for chatbot histories. The client-side
opt-in with `cache_control` is Anthropic's specific API surface;
OpenAI switched to automatic caching later; Google Vertex uses
`cachedContent` explicit handles; AWS Bedrock uses a similar
`cache_control` shape.

**Why "ephemeral" specifically.** `type: 'ephemeral'` is the
5-minute-TTL tier — the only public tier at the time of this code.
Anthropic has hinted at longer-lived tiers (24h) that would use
different `type` values; this code will need one line changed when
they ship.

**Cross-link.** `study-prompt-engineering` walks the design side —
why the system prompt is stable, how prompt structure affects
cache hit rate, what "prefix drift" looks like. This file is about
the perf plumbing; that one is about the prompt design that makes
the plumbing pay off.

## Interview defense

### Q1 · "Walk me through your prompt caching."

**Answer.** Client-side, we add `cache_control: { type: 'ephemeral' }`
to the system prompt block on every Anthropic call. That marks a
breakpoint at the end of the system prompt. On the first call
Anthropic writes the prefix (system + tool definitions) into a
5-minute cache and charges roughly 1.25× normal input cost on that
prefix. On every subsequent call within 5 minutes that reuses the
same prefix — every model turn in the same ReAct loop, since the
system prompt and tools don't change turn-to-turn — it's a cache
read at roughly 0.1× normal cost. Verified live in the receipts:
`cache_read_input_tokens: 3168` on turn 2 of a diagnostic run.
Net savings on a 10-turn loop is roughly 80% off the system prompt
token cost.

```
  turn 1: cache_creation 3168 tokens × 1.25 = premium paid
  turn 2..10: cache_read 3168 tokens × 0.1 × 9 = ~9× 316 = 2844
             vs turn 2..10 without cache: 3168 × 1.0 × 9 = 28512
             savings: ~90% on the prefix
```

**One-line anchor.** "One `cache_control` block, one 5-minute TTL,
80% off the stable prefix across the ReAct loop."

### Q2 · "What breaks the cache?"

**Answer.** Any byte change in the cached prefix. If you inject the
current timestamp into the system prompt, every turn is a
cache_creation instead of a cache_read. If you shuffle tool
definitions order, the tools portion misses. If the same request
comes in more than 5 minutes after the last one, you pay
cache_creation again — the 5-min TTL is a rolling window per prefix.
The load-bearing discipline is: put volatile content AFTER the
breakpoint. The system prompt and tool defs are stable by
construction in this repo; the volatile parts (tool results, user
messages) live in `messages[]` which is after the breakpoint.

**One-line anchor.** "Cache hit requires byte-identical prefix;
put volatile content after the breakpoint."

### Q3 · "Why not cache the whole conversation?"

**Answer.** Each turn appends a new message, so the prefix
including messages grows every turn. Turn N's prefix includes turn
N-1's tool result — which is content specific to that
investigation, not stable across investigations. You'd get cache
hits WITHIN one investigation only for the prefix that hasn't
grown yet — which is exactly the system + tools prefix, which is
what we already cache. Adding a breakpoint further down would help
if we ran multiple turns with identical message histories, but
we don't. The single breakpoint at the system prompt captures the
full win.

**One-line anchor.** "The stable prefix ends at the system prompt;
caching further down doesn't help because messages diverge."

## See also

- `05-budget-ceiling-check-before-dispatch.md` — the cost math
  that's slightly conservative because cache-read tokens aren't
  summed in.
- `04-response-cache-ttl.md` — the parallel cache at the MCP
  boundary (different TTL, different scope).
- `study-prompt-engineering` — prompt design that makes caching
  actually land.
- `claude-api` skill — the SDK-side conventions for
  `cache_control`.
