# Tokenization (and the character-budget proxy this codebase uses instead)

**Industry name(s):** tokenization, subword tokenization (BPE), context-window budgeting
**Type:** Industry standard · Language-agnostic

> Models bill and bound work in tokens, not characters; blooming insights does no token counting at all — it bounds every prompt and tool result with *character* budgets (`MAX_TOOL_RESULT_CHARS = 16_000`, route `TRUNC = 4000`, `schemaSummary` caps) plus per-call `max_tokens`, a deliberately coarse proxy for the real unit.

**See also:** → 01-what-an-llm-is.md · → 06-token-economics.md · → 04-structured-outputs.md

---

## Why care

You set `maxLength={280}` on a textarea to keep a post under a tweet limit. The limit the server actually enforces might be measured differently — bytes, grapheme clusters, "weighted" characters — but `maxLength` is a cheap, client-side approximation that is *close enough* to stop most over-limit submissions before they hit the network. You are bounding one unit (the real limit) with a proxy unit (character count) because the proxy is free to measure and the real one is not.

The question every LLM system faces is the same: the model's hard limits — context window, `max_tokens`, per-call cost — are all denominated in *tokens*, a unit your code cannot see without running a tokenizer. So how do you keep a prompt inside the window when you do not count the unit the window is measured in?

**The pivot: a token is roughly four characters of English, so a character budget is a usable — if coarse — proxy for a token budget.** Counting tokens requires the model's tokenizer; counting characters is `s.length`. blooming insights makes the engineering call to skip the tokenizer entirely and bound everything by characters, accepting that the bound is loose. This works because the consequences of being loose here are mild: a slightly-too-large prompt costs a few extra tokens, not a crash.

Before any budgeting:
- A single EQL tool result can be tens of thousands of characters
- Concatenated across six tool calls, the conversation balloons past the context window
- The model call fails or silently drops the oldest turns

After character budgeting:
- Each tool result is sliced to 16,000 chars before it re-enters the conversation
- The schema summary is capped to ~20 events × 10 props
- Each call carries a hard `max_tokens` ceiling on the *output*

It is `maxLength` on a textarea — applied to every string that flows into a model call, using characters because the real unit (tokens) is not free to measure.

---

## How it works

**Mental model.** Tokenization is the model's `.split()`. Before the transformer sees your text, a tokenizer chops it into subword units drawn from a fixed vocabulary (~100k entries for modern models). "tokenization" might become `token` + `ization`; a rare word splits into more pieces; common words are single tokens. The model's context window, its `max_tokens` cap, and its bill are all counted in these pieces — not in your characters and not in your words.

```
"conversion_rate dropped 18%"
        │  tokenizer (.split into subword units)
        ▼
[ "conversion" "_rate" " dropped" " 18" "%" ]   ← 5 tokens, 27 characters
        │
        ▼  rule of thumb: chars / 4 ≈ tokens  (English)
   27 chars ≈ 7 tokens   (an over-estimate; the real count is 5)
```

The 4-chars-per-token rule is an average over English prose. Code, JSON, numbers, and non-English text tokenize differently — JSON with many short keys and punctuation runs richer (fewer chars per token), so a character budget *over-counts* tokens for prose and may *under-bound* for dense JSON. That looseness is the price of not running a tokenizer.

---

### What blooming insights actually does: bound by characters

There is no tokenizer call anywhere in the codebase. Every place that could overflow the window is bounded by `string.length`.

**Tool-result truncation** — the largest source of bloat. `lib/agents/base.ts` L29 and L31–L34:

```typescript
const MAX_TOOL_RESULT_CHARS = 16_000;

function truncate(s: string): string {
  if (s.length <= MAX_TOOL_RESULT_CHARS) return s;
  return s.slice(0, MAX_TOOL_RESULT_CHARS) + '\n…[truncated]';
}
```

Every tool result is `JSON.stringify`'d and passed through `truncate` before being fed back as a `tool_result` block (`lib/agents/base.ts` L150). A 60,000-character EQL response becomes 16,000 chars plus a marker. Across a six-tool-call investigation, this caps the cumulative tool-result contribution to ~96,000 characters — roughly 24,000 tokens at the 4:1 estimate.

```
EQL result: 60,000 chars
      │  truncate()  base.ts L31–34
      ▼
16,000 chars + "\n…[truncated]"
      │
      ▼  fed back as tool_result   base.ts L150, L171
conversation stays bounded
```

**Route event truncation** — a *separate, smaller* budget for what is streamed to the browser. `app/api/agent/route.ts` L99–L103:

```typescript
const TRUNC = 4000;
const trunc = (v: unknown): unknown => {
  const s = JSON.stringify(v);
  return s && s.length > TRUNC ? s.slice(0, TRUNC) + '…' : v;
};
```

This `4000` bound is applied to `tc.result` before it goes into a `tool_call_end` NDJSON event (route.ts L192). It is unrelated to the model's window — it keeps the *wire payload to the UI* small. Two different budgets, two different reasons: `16_000` protects the model's context; `4000` protects the stream.

**Schema summary caps** — bounding the prompt's static prefix. `lib/agents/monitoring.ts` L15–L48 builds a compact schema string instead of inlining the full ~112KB workspace schema:

```
schemaSummary caps  (monitoring.ts L21, L22, L33)
  MAX_EVENTS          = 20    ← top 20 events only
  MAX_PROPS_PER_EVENT = 10    ← 10 properties each
  MAX_CPROPS          = 30    ← 30 customer properties
```

The comment on L14 is explicit: "Compact, token-bounded schema summary for the prompt (NOT the full 112KB schema)." This is the one place the *intent* is named as token-bounding, even though the implementation counts list lengths, not tokens.

**Output ceiling** — `max_tokens`, the one real token unit in the codebase. This bounds the *output* (the only place token counts appear directly): `4096` default for agent turns (`lib/agents/base.ts` L74), `2048` for synthesis calls (`lib/agents/diagnostic.ts` L94, `lib/agents/recommendation.ts` L98), and a deliberate `16` on the intent classifier (`lib/agents/intent.ts` L20) to force a one-word answer.

```
max_tokens (output token cap — the real unit)
  agent turn        4096   base.ts L74
  synthesis call    2048   diagnostic.ts L99 / recommendation.ts L98
  intent classifier   16   intent.ts L20   ← one word, nothing more
```

---

### Current state vs. future state

```
CURRENT (character proxy)              FUTURE (real token accounting)
────────────────────────────────      ────────────────────────────────
truncate by s.length (16_000)          truncate by tokenizer count
schemaSummary caps list lengths        cap by measured token budget
no visibility into actual usage        log res.usage.input/output_tokens
"is the prompt too big?" = guess       "is the prompt too big?" = known
```

The character proxy is correct *enough* today because the consequences of looseness are mild and the window is large relative to the bounded payloads. It becomes wrong when payloads approach the window edge, where the 4:1 estimate's error swamps the safety margin — that is the trigger to add real token accounting (the exercise below).

---

### The principle

Bound work in the cheapest unit that approximates the unit you actually pay in, and only upgrade to the exact unit when the approximation's error starts to bite. blooming insights pays in tokens but measures in characters because `s.length` is free and the 4:1 rule is good enough at the current scale. The day a payload sits near the window boundary, the proxy's slop becomes the bug, and real token counting earns its cost.

---

## Tokenization — diagram

This diagram spans the layers a string crosses before it reaches the model, and which budget bounds it at each step. The proxy unit (characters) governs the Service layer; the real unit (tokens) appears only as the output cap at the Provider boundary.

```
┌──────────────────────────────────────────────────────────────────────┐
│  SERVICE LAYER (bounded in CHARACTERS — the proxy unit)              │
│                                                                       │
│  schema (112KB)                                                       │
│     │ schemaSummary  monitoring.ts L15–48   (20 events/10 props/30)  │
│     ▼                                                                 │
│  compact schema string ──┐                                           │
│                          │ system prompt                             │
│  EQL tool result (60KB)  │                                           │
│     │ truncate  base.ts L31–34  (16_000 chars)                       │
│     ▼                    │                                           │
│  16,000-char result ─────┤                                           │
│                          ▼                                           │
│            messages[] (system + turns + tool_results)               │
└───────────────────────────┬───────────────────────────────────────────┘
                            │  max_tokens caps the OUTPUT (real tokens)
┌───────────────────────────▼───────────────────────────────────────────┐
│  PROVIDER BOUNDARY (counted in TOKENS — the real unit)              │
│                                                                       │
│  anthropic.messages.create({ max_tokens })                          │
│     agent 4096  base.ts L74 │ synthesis 2048 │ classifier 16        │
│     input tokens = tokenizer(messages)  ← never measured here        │
└────────────────────────────────────────────────────────────────────────┘

  (separate, parallel) route.ts TRUNC=4000 bounds the UI stream payload,
  NOT the model window — different budget, different purpose.
```

The Service layer governs input size in characters; the only token-denominated control in the system is `max_tokens` on the output. The input token count — what the window actually measures — is never computed.

---

## In this codebase

**Not the "real" tokenizer — the honest analog is character budgeting.** blooming insights never calls a tokenizer and never reads `res.usage`; it bounds prompts and tool results by `string.length` and bounds output by `max_tokens`, treating ~4 chars/token as an unstated, coarse proxy for the real unit.

### Files, functions, and line ranges

- **Tool-result char budget:** `MAX_TOOL_RESULT_CHARS = 16_000` and `truncate(s)` — `lib/agents/base.ts` L29, L31–L34. Applied at L150 before each `tool_result`.
- **Route stream char budget:** `TRUNC = 4000` and `trunc(v)` — `app/api/agent/route.ts` L99–L103. Applied at L192 to the UI event payload only.
- **Schema-summary caps:** `MAX_EVENTS = 20`, `MAX_PROPS_PER_EVENT = 10` (`lib/agents/monitoring.ts` L21–L22), `MAX_CPROPS = 30` (L33); whole function L15–L48; intent comment at L14.
- **Output token caps (`max_tokens`):** default `4096` — `lib/agents/base.ts` L74; synthesis `2048` — `lib/agents/diagnostic.ts` L94, `lib/agents/recommendation.ts` L98; classifier `16` — `lib/agents/intent.ts` L20.

### Where real tokenization would live

A token accounting helper would sit in `lib/mcp/` (e.g. a `tokens.ts` alongside `validate.ts`), wrapping a tokenizer; `truncate` in `lib/agents/base.ts` and the caps in `schemaSummary` would call it instead of `string.length`/`.slice`, and `runAgentLoop` would read `res.usage` after `anthropic.messages.create` (L102) to log real input/output counts.

---

## Elaborate

### Where this pattern comes from

Subword tokenization (Byte-Pair Encoding, Sennrich et al. 2016; and its variants WordPiece, SentencePiece, tiktoken's BPE) solves a vocabulary problem: a fixed word vocabulary cannot cover every word, but a fixed *subword* vocabulary can compose any word from pieces. The model's context window and billing are defined over these pieces because the pieces are what the transformer actually processes. The 4-chars-per-token heuristic is an empirical average that OpenAI popularized for English; it is a planning aid, not a measurement.

Bounding by a cheap proxy unit instead of the exact unit is a classic systems trade: it is the same instinct as estimating request size by `Content-Length` instead of parsing the body, or rate-limiting by request count instead of CPU cost. The proxy is free; the exact measure has a cost; you use the proxy until its error matters.

### The deeper principle

```
prose ("the conversion rate fell")   →  ~4 chars / token   (proxy accurate)
JSON ({"k":1,"v":"x"})               →  ~2–3 chars / token (proxy under-bounds)
long numbers / ids / base64          →  ~1–2 chars / token (proxy far off)
```

The proxy's accuracy depends entirely on the *content*. blooming insights feeds the model JSON tool results and a JSON-ish schema summary — content that tokenizes *richer* than prose — so a character budget actually *under-bounds* the token count for those payloads. The `16_000`-char truncation is therefore conservative for JSON: the real token count is higher than `16_000 / 4`, which is the safe direction to be wrong in.

### Where this breaks down

1. **Char truncation can cut JSON mid-structure.** `truncate` slices at a byte offset, not a token or syntactic boundary. A tool result sliced at char 16,000 may end mid-object; the model receives `{"data":[{"x":1},{"y":` — recoverable for a reader but noise for the model. A token-aware or structure-aware truncation would cut at a clean boundary.

2. **No input-token visibility.** Because nothing reads `res.usage`, the system cannot answer "how close was that prompt to the window?" It can only answer "how many characters did we send," which is a guess at the real number. This is the same gap noted in → 06-token-economics.md.

3. **The proxy hides per-content drift.** A briefing over a workspace with very long event names or id-heavy customer properties tokenizes differently from the demo workspace, and the fixed character caps do not adapt. The bound is the same; the token reality is not.

### What to explore next

- **`@anthropic-ai/tokenizer` / `tiktoken`:** run the actual tokenizer to replace the 4:1 estimate with a count.
- **`res.usage` (input/output tokens):** the SDK returns exact counts per call — the cheapest path to real accounting (no separate tokenizer needed for *measurement after the fact*).
- **Structure-aware truncation:** slice JSON at the nearest valid boundary rather than a raw char offset.

---

## Tradeoffs

### Character budget vs. real token counting

| Dimension | This codebase (character proxy) | Real tokenizer counting |
|---|---|---|
| Measurement cost | Zero — `s.length` | A tokenizer pass per string, or read `res.usage` after the call |
| Accuracy | Loose; ±25–50% vs. true tokens depending on content | Exact |
| Truncation quality | Byte offset; can cut mid-JSON | Can cut at a token / structure boundary |
| Window-edge safety | Slop swamps margin near the limit | Tight, reliable margin |
| Dependencies | None | Tokenizer lib or usage parsing |

**What we gave up.** Knowing how big the prompt actually is. With a character budget, "are we near the context window?" is unanswerable; the codebase trusts that 16,000-char results × six calls stays comfortably inside the window, which is true today but unverified. There is also no record of input tokens consumed, which couples directly to the cost-visibility gap in → 06-token-economics.md.

**What the alternative would have cost.** A tokenizer dependency and a tokenizer pass over every tool result and the schema summary — measurable latency on large payloads, plus the maintenance of keeping the tokenizer version matched to the model. Reading `res.usage` is far cheaper (it is already returned) but only measures *after* the call, so it cannot pre-bound truncation.

**The breakpoint.** The character proxy is correct while bounded payloads stay well inside the window. It breaks the moment a truncated-but-still-large prompt sits near the window edge: there, the 4:1 estimate's ±40% error is larger than the remaining margin, and a "safe" 16,000-char result can push a long conversation over. That event — a prompt within ~20% of the window — is the trigger to count tokens for real.

**Not actually a tradeoff:** the `max_tokens` caps. Those *are* real token controls and cost nothing extra; the proxy story is only about *input* sizing.

---

## Tech reference (industry pairing)

### subword tokenizer (BPE)

- **Codebase uses:** nothing — there is no tokenizer; `truncate` and the `schemaSummary` caps approximate token budgeting with character/list-length counts.
- **Why it's here (absent):** the system bounds input by characters because `s.length` is free and the 4:1 rule is adequate at current payload sizes.
- **Leading today:** `tiktoken` (OpenAI's BPE) leads adoption (2026); Anthropic ships `@anthropic-ai/tokenizer` for Claude-accurate counts.
- **Why it leads:** model-matched tokenization gives exact counts, which is the only way to budget tightly against the context window.
- **Runner-up:** `gpt-tokenizer` (pure-JS, dependency-light) and SentencePiece (for non-OpenAI models).

### `max_tokens` (output cap)

- **Codebase uses:** `4096` agent (`lib/agents/base.ts` L74), `2048` synthesis (diagnostic.ts L99 / recommendation.ts L98), `16` classifier (`lib/agents/intent.ts` L20).
- **Why it's here:** it is the one hard token limit the SDK exposes that the code sets directly; the `16` on the classifier forces a single-word answer and caps that call's cost to near-nothing.
- **Leading today:** every major provider exposes an output token cap (2026); it is universal, not differentiated.
- **Why it leads:** it bounds the most variable cost component (output tokens cost more than input — see → 06-token-economics.md) with one integer.
- **Runner-up:** stop sequences — bound output by content rather than count.

---

## Project exercises

### Add real token accounting from `res.usage`

- **Exercise ID:** B1.2 (adapted) — token-economics instrumentation, the cheap half.
- **What to build:** after each `anthropic.messages.create` in `runAgentLoop`, read `res.usage.input_tokens` / `output_tokens` and accumulate per-agent totals, surfaced via a new field on `AgentRunResult` or a hook.
- **Why it earns its place:** shows you know the real unit is tokens and that the SDK already returns exact counts — the highest-value, lowest-cost step toward token visibility.
- **Files to touch:** `lib/agents/base.ts` (`runAgentLoop`, `AgentRunResult`), and the synthesis calls in `lib/agents/diagnostic.ts` / `lib/agents/recommendation.ts`.
- **Done when:** a single investigation logs total input and output tokens per agent, and the numbers move when you change `max_tokens` or the schema caps.
- **Estimated effort:** 1–4hr

### Replace character truncation with tokenizer-aware truncation

- **Exercise ID:** C1.1 (adapted) — tokenization, applied to the bound.
- **What to build:** add `lib/mcp/tokens.ts` wrapping `@anthropic-ai/tokenizer`, and rewrite `truncate` in `lib/agents/base.ts` to cut at a token budget that maps cleanly back to a context-window fraction, preferring a valid JSON boundary.
- **Why it earns its place:** demonstrates you understand char truncation can cut JSON mid-structure and that the real bound is tokens, not bytes.
- **Files to touch:** `lib/agents/base.ts` (`truncate`, `MAX_TOOL_RESULT_CHARS` → a token budget), new `lib/mcp/tokens.ts`, `test/agents/base.test.ts`.
- **Done when:** a 60KB JSON tool result is truncated to a configured token budget at a valid boundary, and the count is verified against the tokenizer.
- **Estimated effort:** 1–4hr

---

## Summary

The model bounds and bills in tokens — subword pieces produced by a tokenizer the codebase never runs. blooming insights substitutes a character budget for a token budget: `truncate` caps each tool result at `MAX_TOOL_RESULT_CHARS = 16_000` (`lib/agents/base.ts`), `schemaSummary` caps the schema to ~20 events × 10 props, and the route's separate `TRUNC = 4000` bounds only the UI stream. The one real token control is `max_tokens` on the output — `4096`/`2048`/`16`. The proxy is coarse (≈4 chars/token, looser for JSON) but free, and correct enough until a payload approaches the window edge.

**Key points:**
- Tokens, not characters, are the model's unit for the context window, `max_tokens`, and cost.
- blooming insights bounds input by characters because `s.length` is free; ≈4 chars/token is the unstated proxy.
- `16_000` protects the model window; `4000` protects the UI stream — two different budgets for two different reasons.
- `max_tokens` (`4096`/`2048`/`16`) is the only real token-denominated control in the codebase.
- The proxy breaks at the window edge, where the 4:1 error exceeds the safety margin — that is when real token counting earns its cost.

---

## Interview defense

### What an interviewer is really asking

"How do you keep prompts inside the context window?" tests whether you know the window is measured in tokens, whether you know the 4:1 rule, and whether you can justify a cheap proxy over exact counting. The senior signal is naming the proxy *as* a proxy and stating the condition under which it fails.

### Likely questions

**[mid] What unit is the context window measured in, and how does this codebase bound it?**

Tokens — subword pieces. The codebase never counts tokens for input; it bounds by characters: `truncate` slices tool results at 16,000 chars (`lib/agents/base.ts` L31–L34) and `schemaSummary` caps lists (L15–L48). The only token control is `max_tokens` on output.

```
input:  bounded by chars (16_000, schema caps)  → proxy for tokens
output: bounded by max_tokens (4096/2048/16)    → real tokens
```

**[senior] Why is a character budget defensible here, and when does it stop being defensible?**

It is free (`s.length`) and ≈4 chars/token is adequate while payloads sit well inside the window. For JSON it actually *under-bounds* the token count, which is the safe direction. It stops being defensible when a truncated prompt sits near the window edge — there the proxy's ±40% error exceeds the margin, and a 16,000-char result can push the conversation over. That is the trigger to read `res.usage` or run a tokenizer.

```
payload << window  →  proxy slop irrelevant  (fine)
payload ≈ window   →  proxy slop > margin    (bug) → count tokens
```

**[arch] The `16_000` and `4000` constants — same purpose?**

No. `16_000` (`base.ts` L29) bounds what re-enters the *model's* conversation, protecting the context window. `4000` (`route.ts` L99) bounds the result payload streamed to the *browser*, protecting wire size. Conflating them would mean the UI dictates model context size or vice versa.

```
16_000 ──▶ model window        4000 ──▶ NDJSON to UI
(different layers, different limits)
```

### The question candidates always dodge

**"How many tokens does a typical investigation actually consume?"** The honest answer in this codebase is "unknown — nothing reads `res.usage`." A candidate who invents a number is bluffing; the real answer is to point at the absence and name the cheap fix (read `res.usage`, the exercise above).

### One-line anchors

- `lib/agents/base.ts` L29, L31–L34 — `MAX_TOOL_RESULT_CHARS = 16_000`, char truncation.
- `app/api/agent/route.ts` L99 — `TRUNC = 4000`, UI-stream budget (different purpose).
- `lib/agents/monitoring.ts` L14, L21–L22, L33 — token-bounded schema summary via list caps.
- `lib/agents/intent.ts` L20 — `max_tokens: 16`, the one-word classifier.
- 4 chars ≈ 1 token (English); JSON tokenizes richer, so char budgets under-bound it.

---

## Validate

### Level 1 — Reconstruct

From memory, list every budget in the system and its unit: tool-result truncation (chars), schema summary caps (list lengths), route stream truncation (chars), and the output caps (tokens). State which one uses the *real* unit.

### Level 2 — Explain

Out loud: why does the codebase bound input in characters but output in tokens? Why is a character budget *conservative* (safe) for JSON tool results specifically?

### Level 3 — Apply

Scenario: a new workspace has event names averaging 60 characters and 40 customer properties. Check `lib/agents/monitoring.ts` L21–L22 and L33 — how does `schemaSummary` behave, and does the fixed character/list budget over- or under-represent the token cost compared to the demo workspace? What single change (no tokenizer) would give you visibility into the real number?

### Level 4 — Defend

A colleague wants to raise `MAX_TOOL_RESULT_CHARS` to `64_000` to stop truncating EQL results. Using the 4:1 rule and the six-call budget, estimate the cumulative token cost and argue whether that stays safely inside a large context window — then name the measurement (`res.usage`) that would replace your estimate with a fact.

### Quick check — code reference test

What `max_tokens` value forces the intent classifier to answer in one word, and where is it set? (Answer: `16` — `lib/agents/intent.ts` L20.)

---
Updated: 2026-05-28 — Re-derived the drifted `app/api/agent/route.ts` refs (`TRUNC = 4000` now L99–L103, applied at L192) and the diagnostic synthesis `max_tokens` (now L99); character-budget facts and `base.ts`/`monitoring.ts`/`intent.ts` refs verified unchanged.
