# 06 — token economics

**Subtitle:** Per-call cost ledger · Industry standard

## Zoom out, then zoom in

Cost is per token. Per call, you pay for both input and output, at different
rates, and output costs ~5x more than input. Per agent loop, you pay for input
*every turn* because the model is stateless.

```
  Zoom out — where dollars get spent in one investigation

  ┌─ /api/agent (one investigation) ──────────────────┐
  │  bootstrap     ≈ 0   tokens     ($0; no LLM)       │
  │  listTools     ≈ 0   tokens     ($0; no LLM)       │
  │  diagnostic    6 turns × ~5k in + ~1k out          │
  │                ≈ 30k in + 6k out ≈ $0.18           │
  │  recommendation 4 turns × ~5k in + ~1k out         │
  │                ≈ 20k in + 4k out ≈ $0.12           │
  │  TOTAL per investigation:        ≈ $0.30           │
  └─────────────────────────────────────────────────────┘

  ┌─ /api/briefing (one daily check) ─────────────────┐
  │  monitoring    6 turns × ~6k in + ~2k out          │
  │                ≈ 36k in + 12k out ≈ $0.29          │
  └─────────────────────────────────────────────────────┘
```

## Structure pass

  → **One axis to trace — cost per unit work.** Input vs output, turn count
    vs single call, sonnet vs haiku. Holding "what's one unit of work?"
    constant across the agents:
    - monitoring: one briefing scan ≈ $0.30
    - diagnostic: one investigation ≈ $0.18
    - recommendation: one set of recs ≈ $0.12
    - intent: one classify ≈ $0.0003 (haiku)

  → **The seam:** the input-side accumulation. Every agent turn re-pays for
    the system prompt, the schema summary, and the conversation so far. The
    multiplier is *turn count*, not "additional cost per turn." A 6-turn
    loop with a 5k-token prompt costs 30k input tokens for the prompt alone.

## How it works

### Move 1 — the mental model

Imagine a meter on the wire. Every byte you send is counted as input; every
byte the model writes back is counted as output. The meter starts again on
every API call.

```
  One call: the cost ledger

  ┌─ Input tokens (you pay $3/M for sonnet) ──────────┐
  │   system prompt       ~500   tokens                │
  │   schema summary      ~1500  tokens                │
  │   category checklist  ~750   tokens                │
  │   tool definitions    ~1000  tokens                │
  │   prior turns (turn N) ~N × 1k tokens              │
  │   TOTAL (turn 1):     ~4-5k                        │
  │   TOTAL (turn 6):    ~10-15k                       │
  ├────────────────────────────────────────────────────┤
  │ Output tokens (you pay $15/M for sonnet)           │
  │   tool_use args       ~50-200                      │
  │   text reasoning      ~200-500                     │
  │   final JSON          ~1-2k                        │
  │   TOTAL per turn:     ~500-2000                    │
  ├────────────────────────────────────────────────────┤
  │ Cost per turn (turn 6):                            │
  │   input:  12000 × $3/1M  = $0.036                  │
  │   output:  1500 × $15/1M = $0.0225                 │
  │   TOTAL per turn:        ≈ $0.06                   │
  └────────────────────────────────────────────────────┘
```

### Move 2 — the step-by-step walkthrough

**The pricing table.** As of 2026, the models this codebase uses:

  → `claude-sonnet-4-6` — $3 / 1M input, $15 / 1M output.
  → `claude-haiku-4-5-20251001` — $1 / 1M input, $5 / 1M output.

**The actual measurement source.** Every `complete()` call logs `usage` to
Vercel logs (`lib/agents/aptkit-adapters.ts:57-61`):

```typescript
console.log(JSON.stringify({
  site: this.logSite,                // e.g. "agents/diagnostic:aptkit-model"
  sessionId: this.sessionId,
  usage: response.usage,             // {input_tokens, output_tokens,
                                     //  cache_creation_input_tokens,
                                     //  cache_read_input_tokens}
}));
```

To get a real cost number, you'd filter Vercel logs by `site` for the
investigation period, sum `input_tokens` and `output_tokens`, multiply by the
pricing. There's no in-app aggregation; the logs are the source of truth.

**Where the money goes in a typical diagnostic loop.** Walking the numbers:

  → **Turn 1.** Input ≈ 4k (system prompt + schema summary + anomaly context
    + tool defs). Output ≈ 200 (model picks a tool, emits `tool_use`
    block, very little prose). Cost: ~$0.015.

  → **Turn 2.** Input ≈ 5k (turn 1's everything + the tool_use block from
    turn 1 + the tool result). Output ≈ 300. Cost: ~$0.020.

  → **Turn 3-5.** Each ~6-9k input, ~300-500 output. Each ~$0.025-$0.035.

  → **Turn 6 (final synthesis).** Input ≈ 10k. Output ≈ 1500 (the full
    `Diagnosis` JSON). Cost: ~$0.055.

  → **Total:** ~$0.18 for one diagnostic investigation.

The output cost on turn 6 is the single biggest line. That's the
synthesis-turn pattern — the model has held back on prose until it has all
the data, then emits the whole structured answer. Output costs 5x input,
so the final-turn shape dominates.

**Why output costs more.** The model's compute cost per token is the same
on input and output; the pricing premium on output reflects two things:
(1) it's pure generation, no parallelization (a single token at a time),
and (2) it's the value-add (anyone can supply text — only the model can
generate the answer). Provider pricing reflects this across the industry.

**Where the cost hits today.** Live mode is gated by the Bloomreach side, not
Anthropic. The alpha MCP server's "1 per 10s" rate limit caps the throughput
at ~360 tool calls per hour per user; agent loops do 3-10 tool calls each so
the budget caps at ~30-50 investigations per hour. Demo mode is free. So the
*current* Anthropic bill is small — maybe $10-30/month for the user's own
testing. The number scales linearly with users + live-mode usage.

### Move 3 — the principle

**Cost = (input_tokens × turn_count × input_rate) + (output_tokens × output_rate).
Output dominates per turn; input dominates per loop.** The two cost-reduction
levers are: (1) cap turn count (`max_tokens` on output, hard tool-call caps in
prompts: 6 for monitoring/diagnostic, 4 for recommendation), and (2) cap
per-turn input (`schemaSummary()` trimming). Both are in place. The next
lever is prompt caching — re-sending the same system prompt prefix every
turn could be a cache-hit, but that's a Case B (see
`06-production-serving/01-llm-caching.md`).

## Primary diagram

```
  Cost flowchart — where to spend a token-reduction hour

   start
     │
     ▼
  measure (read Vercel logs for `usage` field)
     │
     ▼
  is input growing per turn?  ── yes ──►  truncate schema / history more
     │ no                                  (schemaSummary tweak)
     ▼
  is output > 1k per turn?    ── yes ──►  lower max_tokens or prompt
     │ no                                  for terser output
     ▼
  is turn count > 4?          ── yes ──►  cap tool calls harder
     │ no                                  (prompt or AptKit config)
     ▼
  do system prompt + tool      ── yes ──►  enable Anthropic prompt caching
  defs repeat verbatim                     (Case B in this codebase)
  per turn?
     │ no
     ▼
  consider switching to haiku
  for non-synthesis turns
  (Case B — model routing)
```

## Elaborate

The "haiku for triage, sonnet for synthesis" model-routing pattern is the
biggest cost-reduction move that hasn't been made in this codebase. The intent
classifier is already on haiku; the *first few exploratory turns* of the
diagnostic loop could plausibly run on haiku and only the final synthesis
turn on sonnet. The blocker is that AptKit owns the loop and doesn't expose a
per-turn model choice today. The exercise below names the refactor.

Anthropic's prompt caching (introduced 2024) is the other big lever. Every
agent turn re-sends the system prompt verbatim — perfect cache candidate. The
`cache_creation_input_tokens` and `cache_read_input_tokens` fields in
`response.usage` are already being logged, they're just always `0` because
nothing is being cached. Adding `cache_control: { type: 'ephemeral' }` to the
system block in `AnthropicModelProviderAdapter.complete()` (and to the schema
summary block, which is also stable per session) would cut input cost on
turns 2+ by ~90%. See `06-production-serving/01-llm-caching.md` for the
walkthrough.

## Project exercises

### Exercise — emit per-investigation cost summary at done

  → **Exercise ID:** `study-ai-eng-06.1`
  → **What to build:** Accumulate `usage` numbers across all `complete()`
    calls inside a single route invocation, and emit a final
    `{ type: 'cost_summary', inputTokens, outputTokens, estUsd }` event
    before `{ type: 'done' }`. The UI shows it in the investigation
    footer.
  → **Why it earns its place:** Makes the cost visible at the unit-of-work
    boundary. Today the only way to know what an investigation cost is
    grepping Vercel logs.
  → **Files to touch:** `lib/agents/aptkit-adapters.ts` (accumulator on the
    adapter), `app/api/agent/route.ts` (emit before done),
    `lib/mcp/events.ts`, `components/investigation/EvidencePanel.tsx`.
  → **Done when:** Live investigation shows "this investigation: 32k in / 4k
    out · ~$0.16" in the UI.
  → **Estimated effort:** `1–4hr`

### Exercise — enable Anthropic prompt caching on the system block

  → **Exercise ID:** `study-ai-eng-06.2`
  → **What to build:** In `AnthropicModelProviderAdapter.complete()`, when
    `request.system` is present, send it as a structured `system` array
    with `cache_control: { type: 'ephemeral' }` instead of a plain string.
    Verify the next turn's `usage.cache_read_input_tokens` is >0.
  → **Why it earns its place:** Cuts input cost on turns 2+ by ~90% for the
    cached prefix. The biggest cost lever still on the table.
  → **Files to touch:** `lib/agents/aptkit-adapters.ts:49`, and possibly
    AptKit `ModelRequest` (if `system` needs to be structured upstream).
  → **Done when:** Logs show `cache_read_input_tokens > 0` on the second
    turn of any agent loop. A back-of-envelope check shows ~50%+ input
    cost reduction across a 6-turn loop.
  → **Estimated effort:** `1–4hr` (AptKit upstream may add a half-day).

## Interview defense

**Q: What does one investigation cost in dollars?**

About $0.30 end-to-end (diagnostic ~$0.18 + recommendation ~$0.12). The
monitoring scan is about the same — ~$0.30 for one daily briefing. The
biggest line item is the final synthesis turn's output tokens: ~1-2k of JSON
at sonnet's $15/M-output rate is ~$0.02 per call, and the synthesis turn is
the most expensive in every agent loop.

```
  Cost per agent (one unit of work):
    monitoring (briefing scan)        ≈ $0.30
    diagnostic (one investigation)    ≈ $0.18
    recommendation (one rec set)      ≈ $0.12
    intent classify (haiku)           ≈ $0.0003

  Per-turn dominance:
    input cost dominates LOOP cost (multiplied by turn count)
    output cost dominates PER-TURN cost (5× input rate)
```

**Anchor line:** "Output is 5× more expensive than input per token. The
synthesis turn dominates each call; the prompt re-send dominates the loop."

**Q: What's the biggest cost-reduction move you haven't shipped yet?**

Anthropic prompt caching on the system block. Every agent turn re-sends the
~500-token system prompt verbatim — perfect cache candidate. The
`response.usage` already has `cache_creation_input_tokens` and
`cache_read_input_tokens` fields; they're being logged, they're always zero
today because we don't set `cache_control: { type: 'ephemeral' }`. Setting
it on the `system` block in `AnthropicModelProviderAdapter.complete()` would
cut input cost on turns 2+ by ~90% for the cached prefix.

**Anchor line:** "Caching is one config flag away. The usage object already
has the cache fields; they're just always zero."

## See also

  → `02-tokenization.md` — what `input_tokens` is actually counting
  → `06-production-serving/01-llm-caching.md` — the cache that would cut this in half
  → `06-production-serving/02-llm-cost-optimization.md` — model routing as the next lever
