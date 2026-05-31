# Tokenization (and the character-budget proxy this codebase uses instead)

**Industry name(s):** tokenization, subword tokenization (BPE), context-window budgeting
**Type:** Industry standard · Language-agnostic

> Models bill and bound work in tokens, not characters; blooming insights does no token counting at all — it bounds every prompt and tool result with *character* budgets (`MAX_TOOL_RESULT_CHARS = 16_000`, route `TRUNC = 4000`, `schemaSummary` caps) plus per-call `max_tokens`, a deliberately coarse proxy for the real unit.


---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Tokenization is the unit the Provider band counts in — context window, `max_tokens`, per-call billing — but blooming insights never runs a tokenizer. The bounding that *should* be token-aware lives one layer up in the per-agent and pipeline code (the `MAX_TOOL_RESULT_CHARS = 16_000` truncation in `lib/agents/base.ts`, the `schemaSummary` caps in `lib/agents/monitoring.ts`, and the `TRUNC = 4000` UI-stream cap in `app/api/agent/route.ts`), all measured in *characters* as a coarse proxy. The only token-denominated control is `max_tokens` on the output side, set right at the Provider call.

```
  Zoom out — where tokenization lives (and where the proxy sits)

  ┌─ Route + Per-agent (bounds in CHARACTERS — proxy) ┐
  │  schemaSummary caps    monitoring.ts L15–48        │
  │  truncate (16_000)     base.ts L31–34              │
  │  TRUNC (4000) UI       route.ts L99–103            │
  └─────────────────────────┬──────────────────────────┘
                            │  messages[] (input size: unknown in tokens)
  ┌─ Provider ──────────────▼──────────────────────────┐  ← we are here
  │  anthropic.messages.create({ max_tokens: 4096 })   │
  │  ★ TOKENIZER ★ (lives inside the SDK, not called)  │
  │  input tokens = f(messages)  ← never measured      │
  │  output capped by max_tokens (the real unit)       │
  └────────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question is: how do you keep a prompt inside the window when you do not count the unit the window is measured in? blooming insights answers with a 4-chars-per-token proxy — bound input by `string.length`, bound output by `max_tokens` — and accepts the slop. How it works walks through every budget, the proxy's failure mode for JSON, and the trigger to upgrade to real token accounting.

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

### What this system actually does: bound by characters

There is no tokenizer call anywhere. Every place that could overflow the window is bounded by string length.

**Tool-result truncation** — the largest source of bloat. The shared agent loop holds a constant for the tool-result char cap and a slicer:

```
  MAX_TOOL_RESULT_CHARS = 16_000

  function truncate(s):
      if length(s) <= MAX_TOOL_RESULT_CHARS:
          return s
      return slice(s, 0, MAX_TOOL_RESULT_CHARS) + "\n…[truncated]"
```

Every tool result is JSON-serialized and passed through `truncate` before being fed back as a tool-result block. A 60,000-character query response becomes 16,000 chars plus a marker. Across a six-tool-call investigation, this caps the cumulative tool-result contribution to ~96,000 characters — roughly 24,000 tokens at the 4:1 estimate.

```
query result: 60,000 chars
      │  truncate()  (the agent-loop cap)
      ▼
16,000 chars + "\n…[truncated]"
      │
      ▼  fed back as tool_result
conversation stays bounded
```

**Route event truncation** — a *separate, smaller* budget for what is streamed to the browser. The route handler runs a different cap:

```
  TRUNC = 4000

  function trunc(v):
      s = JSON.serialize(v)
      if s and length(s) > TRUNC:
          return slice(s, 0, TRUNC) + "…"
      return v
```

This 4,000 bound is applied to each tool-call result before it goes into a streaming UI event. It is unrelated to the model's window — it keeps the *wire payload to the UI* small. Two different budgets, two different reasons: 16,000 protects the model's context; 4,000 protects the stream.

**Schema summary caps** — bounding the prompt's static prefix. The monitoring agent builds a compact schema string instead of inlining the full ~112KB workspace schema:

```
schemaSummary caps
  MAX_EVENTS          = 20    ← top 20 events only
  MAX_PROPS_PER_EVENT = 10    ← 10 properties each
  MAX_CPROPS          = 30    ← 30 customer properties
```

The comment alongside is explicit: "Compact, token-bounded schema summary for the prompt (NOT the full 112KB schema)." This is the one place the *intent* is named as token-bounding, even though the implementation counts list lengths, not tokens.

**Output ceiling** — `max_tokens`, the one real token unit in the system. This bounds the *output* (the only place token counts appear directly): 4096 default for agent turns, 2048 for synthesis calls, and a deliberate 16 on the intent classifier to force a one-word answer.

```
max_tokens (output token cap — the real unit)
  agent turn        4096
  synthesis call    2048
  intent classifier   16   ← one word, nothing more
```

---

### Current state vs. future state

```
CURRENT (character proxy)              FUTURE (real token accounting)
────────────────────────────────      ────────────────────────────────
truncate by string length (16_000)     truncate by tokenizer count
schemaSummary caps list lengths        cap by measured token budget
no visibility into actual usage        log usage.input/output_tokens
"is the prompt too big?" = guess       "is the prompt too big?" = known
```

The character proxy is correct *enough* today because the consequences of looseness are mild and the window is large relative to the bounded payloads. It becomes wrong when payloads approach the window edge, where the 4:1 estimate's error swamps the safety margin — that is the trigger to add real token accounting (the exercise below).

---

### The principle

Bound work in the cheapest unit that approximates the unit you actually pay in, and only upgrade to the exact unit when the approximation's error starts to bite. You pay in tokens but measure in characters because string length is free and the 4:1 rule is good enough at the current scale. The day a payload sits near the window boundary, the proxy's slop becomes the bug, and real token counting earns its cost.

---

## Tokenization — diagram

This diagram spans the layers a string crosses before it reaches the model, and which budget bounds it at each step. The proxy unit (characters) governs the Service layer; the real unit (tokens) appears only as the output cap at the Provider boundary.

```
┌──────────────────────────────────────────────────────────────────────┐
│  SERVICE LAYER (bounded in CHARACTERS — the proxy unit)              │
│                                                                       │
│  schema (112KB)                                                       │
│     │ schemaSummary  monitoring.ts   (20 events/10 props/30)  │
│     ▼                                                                 │
│  compact schema string ──┐                                           │
│                          │ system prompt                             │
│  EQL tool result (60KB)  │                                           │
│     │ truncate  base.ts  (16_000 chars)                       │
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
│     agent 4096  base.ts     │ synthesis 2048 │ classifier 16        │
│     input tokens = tokenizer(messages)  ← never measured here        │
└────────────────────────────────────────────────────────────────────────┘

  (separate, parallel) route.ts TRUNC=4000 bounds the UI stream payload,
  NOT the model window — different budget, different purpose.
```

The Service layer governs input size in characters; the only token-denominated control in the system is `max_tokens` on the output. The input token count — what the window actually measures — is never computed.

---

## Implementation in codebase

**Not the "real" tokenizer — the honest analog is character budgeting.** blooming insights never calls a tokenizer and never reads `res.usage`; it bounds prompts and tool results by `string.length` and bounds output by `max_tokens`, treating ~4 chars/token as an unstated, coarse proxy for the real unit.

### Files, functions, and line ranges

- **Tool-result char budget:** `MAX_TOOL_RESULT_CHARS = 16_000` and `truncate(s)` — `lib/agents/base.ts` L29, L31–L34. Applied at L150 before each `tool_result`.
- **Route stream char budget:** `TRUNC = 4000` and `trunc(v)` — `app/api/agent/route.ts` L99–L103. Applied at L192 to the UI event payload only.
- **Schema-summary caps:** `MAX_EVENTS = 20`, `MAX_PROPS_PER_EVENT = 10` (`lib/agents/monitoring.ts` L21–L22), `MAX_CPROPS = 30` (L33); whole function L15–L48; intent comment at L14.
- **Output token caps (`max_tokens`):** default `4096` — `lib/agents/base.ts` L74; synthesis `2048` — `lib/agents/diagnostic.ts` L99, `lib/agents/recommendation.ts` L98; classifier `16` — `lib/agents/intent.ts` L20.

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

## See also

→ 01-what-an-llm-is.md · → 06-token-economics.md · → 04-structured-outputs.md

---
Updated: 2026-05-28 — Re-derived the drifted `app/api/agent/route.ts` refs (`TRUNC = 4000` now L99–L103, applied at L192) and the diagnostic synthesis `max_tokens` (now L99); character-budget facts and `base.ts`/`monitoring.ts`/`intent.ts` refs verified unchanged.
Updated: 2026-05-29 — Corrected the two stale diagnostic-synthesis `max_tokens` citations from L94 to L99 (verified against current `diagnostic.ts`: `max_tokens: 2048` is at L99).
Updated: 2026-05-30 — Migrated to study.md v1.47 template (Phase 1+2 mechanical): removed Tradeoffs / Tech reference / Summary sections; renamed "In this codebase" → "Implementation in codebase"; moved See also to a bottom block. "Why care" preserved pending Phase 3 (Zoom out, then zoom in + LAYERS diagram) authoring.
Updated: 2026-05-30 — Phase 3 of study.md v1.47 migration: replaced "Why care" block with "Zoom out, then zoom in" (LAYERS diagram + zoom-in paragraph) per format.md.
Updated: 2026-05-31 — Applied study.md v1.48: scrubbed "How it works" of file paths, line refs, and real-code fences; replaced with generic role labels + pseudocode per format.md. Codebase-specific anchoring lives exclusively in "Implementation in codebase".
