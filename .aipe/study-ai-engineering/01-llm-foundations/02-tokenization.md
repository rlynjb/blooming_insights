# 02 — tokenization

**Subtitle:** Byte-Pair Encoding (BPE) tokenization · Industry standard

## Zoom out, then zoom in

Tokens are the unit your bill is measured in. They're also the unit the
context window is sized in. Before talking about cost or windows, you have
to know what one is.

```
  Zoom out — where tokenization sits

  ┌─ Agent layer (Blooming) ─────────────────────────────┐
  │  schemaSummary() truncates to ~30 customer props,     │
  │  20 events, 10 props each — BEFORE the LLM sees it    │
  │  (lib/agents/monitoring.ts:19-60)                     │
  └──────────────────────────┬────────────────────────────┘
                             │ "trust the truncate, pay
                             ▼  for what you ship"
  ┌─ Adapter (lib/agents/aptkit-adapters.ts:42) ──────────┐
  │  anthropic.messages.create({ messages, system, … })   │
  └──────────────────────────┬────────────────────────────┘
                             │
  ┌─ Anthropic API ──────────▼────────────────────────────┐
  │  ★ tokenize input  ★  ─►  model  ─►  detokenize       │  ← we are here
  │  usage.input_tokens, usage.output_tokens               │
  └────────────────────────────────────────────────────────┘
```

The model sees vectors, not strings. The tokenizer is the bridge.

## Structure pass

  → **One axis to trace — cost.** Tokenization decides how many tokens your
    7,000-character prompt becomes. Rough ratio: ~4 chars/token in English,
    fewer in code, fewer still in non-Latin scripts. Cost is per-token, so
    cost is per-tokenizer-output.

  → **The seam:** outside the API call (your code) you reason in characters,
    inside the API call (the model) it reasons in tokens. The
    `response.usage.input_tokens` field is where the seam shows itself —
    that number is the *only* honest measurement of what you sent.

## How it works

### Move 1 — the mental model

Think of tokens like syllables. "Hello, world!" is more like 4 syllables than
13 letters — common words become one token each, rare or compound words break
into pieces.

```
  Text → tokens (BPE, ~4 chars/token in English)

  "Hello, world!"
       │
       ▼  BPE tokenizer
       │
  [15496, 11, 995, 0]
   "Hello"  ","   " world"  "!"
        4 tokens for 13 characters

  "execute_analytics_eql"   (a tool name from this repo)
       │
       ▼
  ["execute", "_", "analytics", "_", "eq", "l"]
        ≈ 6 tokens for 21 characters (snake_case is token-hungry)
```

The model never sees the string "execute_analytics_eql". It sees the integer
sequence. That's why typos sometimes produce wildly different behavior — they
land on different tokens entirely.

### Move 2 — the step-by-step walkthrough

**The tokenizer runs server-side on every call.** Blooming never tokenizes
locally — there's no `tiktoken` import anywhere. The only way to know the token
count of something is to send it and read back `response.usage`.

This is why Blooming does *aggressive truncation* before sending. Look at
`schemaSummary()` in `lib/agents/monitoring.ts:19-60`:

```typescript
// lib/agents/monitoring.ts:19-60  (excerpted)
export function schemaSummary(schema: WorkspaceSchema): string {
  const MAX_EVENTS = 20;              // top 20 events only
  const MAX_PROPS_PER_EVENT = 10;     // 10 properties each
  const MAX_CPROPS = 30;              // 30 customer properties

  const eventsText = schema.events
    .slice(0, MAX_EVENTS)
    .map((e) => {
      const props = e.properties.slice(0, MAX_PROPS_PER_EVENT).join(', ');
      return `  - ${e.name} (${e.eventCount}): ${props || '(no properties)'}`;
    })
    .join('\n');
  // … plus a few header lines, the customer-props line, the catalog list
}
```

The comment at the top of the function says it explicitly: *"Compact,
token-bounded schema summary for the prompt (NOT the full 112KB schema)."* The
real schema for a Bloomreach project can be enormous — a hundred event types,
each with twenty-plus properties, plus customer properties, plus catalogs. At
~4 chars/token that's roughly 25–30k input tokens *per call*. The summary
trims it to ~1–2k tokens.

**The numbers in the constants are load-bearing.** They were picked by hand:

  → `MAX_EVENTS = 20` — covers the high-volume events that anomalies are
    actually computed against (`purchase`, `view_item`, `cart_update`, etc.).
    Sorted by `eventCount` descending in `parseWorkspaceSchema()` so the cut
    keeps the useful ones.

  → `MAX_PROPS_PER_EVENT = 10` — enough for the discriminating dimensions
    (`customer.country`, `customer.device_type`, `event.category`) without
    shipping every rare property.

  → `MAX_CPROPS = 30` — same logic for customer properties.

The agent runs 3–6 turns per investigation. At each turn the *whole* history is
re-sent. If the schema summary were the full 30k, that's 180k input tokens for
a 6-turn loop — half the context window, ~$0.54 at Sonnet pricing, every
investigation. The truncation isn't an optimization, it's a budget gate.

**You see the cost in the log.** The adapter logs `response.usage` on every
call (`lib/agents/aptkit-adapters.ts:57-61`):

```json
{"site":"agents/diagnostic:aptkit-model","sessionId":"…","usage":{"input_tokens":4823,"output_tokens":612,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}
```

That's the canonical measurement. Everything else (character counts, rough
estimates, "the prompt is short") is hand-waving until you read this number.

### Move 3 — the principle

**You don't know how many tokens something is until the server tells you.** Build
your sizing budgets around `response.usage`, not around character counts. Cap
your inputs *aggressively* and trust the cap — the model can do its job with
the top-20 events and 30 customer properties; it cannot do its job if you
exceed the context window or burn the budget.

## Primary diagram

```
  How a single monitoring call lands in tokens

  ┌─ Blooming prepares input ──────────────────────────────┐
  │  system: monitoring.md prompt   (~2k chars  ≈ 500 tok) │
  │  user:   schemaSummary(schema)  (~6k chars  ≈ 1.5k tok)│
  │  user:   category checklist      (~3k chars  ≈ 750 tok) │
  │  user:   prior turns + tool      (~3-15k chars         │
  │          results from agent loop  ≈ 750-3.7k tok)      │
  │                                                        │
  │  TOTAL INPUT (turn 1):  ~3-4k tokens                   │
  │  TOTAL INPUT (turn 6):  ~10-15k tokens (grows!)        │
  └──────────────────────────┬─────────────────────────────┘
                             │ messages.create
                             ▼
  ┌─ Anthropic ───────────────────────────────────────────┐
  │  tokenize → forward through 70B-or-so params →        │
  │  emit content blocks                                  │
  └──────────────────────────┬─────────────────────────────┘
                             │ response
                             ▼
  ┌─ Blooming reads ──────────────────────────────────────┐
  │  response.usage.input_tokens   ← measure HERE         │
  │  response.usage.output_tokens                         │
  │  console.log → Vercel logs (filter by site)           │
  └────────────────────────────────────────────────────────┘
```

## Elaborate

Anthropic, OpenAI, and Google all use variants of Byte-Pair Encoding (BPE), but
the vocabularies differ. The same string can tokenize to different counts under
different providers. Blooming doesn't care — it relies on `response.usage` to
report what it actually was — but a multi-provider future (see
`08-provider-abstraction.md`) would mean per-provider truncation budgets
because the same `schemaSummary()` output could blow a smaller-context model
on one provider and fit fine on another.

The reason the schema summary is hand-written rather than auto-truncated by
character count: anomaly categories depend on *specific* properties being
visible. Truncating by character count would randomly drop `customer.country`
on a schema that happens to alphabetize after a thousand other properties.
Hand-sorting events by `eventCount` (descending) and customer properties by
their first-30 order preserves the load-bearing dimensions.

What to read next: `06-token-economics.md` (turn the usage numbers into
dollars) and `02-context-and-prompts/01-context-window.md` (when the growing
history hits the wall).

## Project exercises

### Exercise — show token count in the dev capture path

  → **Exercise ID:** `study-ai-eng-02.1`
  → **What to build:** Extend `/api/mcp/capture` (the dev-only snapshot
    capture) to write a `usage.json` alongside `demo-insights.json` /
    `demo-investigations.json` that records total input/output tokens
    per agent for the captured run. Surface a "this capture cost ~$X"
    line in the dev-only "capture demo" UI.
  → **Why it earns its place:** Demonstrates measurement before optimization —
    you can't optimize the prompt if you can't see what each call costs.
  → **Files to touch:** `app/api/mcp/capture/route.ts`,
    `app/api/mcp/capture-demo/route.ts`, `app/page.tsx` (the capture button
    section), `lib/state/insights.ts` (write `usage.json`).
  → **Done when:** The dev-only capture button shows token totals + estimated
    USD cost, and the JSON file is committed alongside the demo snapshots.
  → **Estimated effort:** `1–4hr`

### Exercise — emit a context-pressure warning

  → **Exercise ID:** `study-ai-eng-02.2`
  → **What to build:** In the agent adapter, after each turn, if
    `usage.input_tokens > 100_000` (half the Sonnet context window), emit a
    `{ type: 'context_pressure', tokens, model }` trace event so the UI can
    show a warning that the loop is getting close to the cap.
  → **Why it earns its place:** Context overflow today is silent — the model
    errors at 200k and the route returns a generic message. A visible
    pressure bar makes the failure mode legible.
  → **Files to touch:** `lib/agents/aptkit-adapters.ts:57-71`, `lib/mcp/events.ts`
    (new event type), `components/investigation/ReasoningTrace.tsx`.
  → **Done when:** A live investigation that pushes past 100k input tokens
    surfaces a warning in the StatusLog with the current token count.
  → **Estimated effort:** `1–4hr`

## Interview defense

**Q: How do you size your prompts in this codebase?**

By measurement, not by estimate. The Anthropic SDK returns `response.usage`
on every call (`lib/agents/aptkit-adapters.ts:57`), and that gets logged to
Vercel. The schema summary is hand-truncated to ~1–2k tokens
(`lib/agents/monitoring.ts:19-60`) so even a 6-turn agent loop stays well
inside the context window.

```
  Truncation table — why these numbers:

   field                  | cap            | reason
   ───────────────────────┼────────────────┼───────────────────────────
   events shown           | 20             | covers high-volume events
   props per event        | 10             | discriminating dims only
   customer properties    | 30             | first 30 cover the common
                          |                | breakdowns
```

**Anchor line:** "The full Bloomreach schema is ~30k tokens; we ship ~1.5k.
The 20 / 10 / 30 caps in `schemaSummary` are the budget gate."

**Q: Why don't you use a tokenizer client-side to count before sending?**

It's not worth it. Anthropic doesn't ship a public client-side tokenizer
(unlike OpenAI's `tiktoken`), and rolling one would mean re-implementing BPE
with the exact Anthropic vocabulary — possible but a maintenance hazard. The
truncation budgets are conservative enough that we don't need pre-check; we
read the actual count back from `response.usage` and log it.

**Q: What's the load-bearing tokenization fact people forget?**

Tokens are re-sent every turn. In a 6-turn agent loop, the system prompt and
the workspace schema are paid for **6 times**. That's why the per-turn budget
gets multiplied by turn count when you estimate cost — not added.

## See also

  → `01-what-an-llm-is.md` — the I/O model that makes tokens visible
  → `06-token-economics.md` — turn token counts into dollars
  → `02-context-and-prompts/01-context-window.md` — when the budget runs out
