# 04 — Token budgeting and context window management

*Context budget hygiene · Industry standard*

## Zoom out, then zoom in

Pull up where tokens get spent in this codebase. Every box in this diagram is a place where the budget can be blown.

```
  Where the token budget gets spent — one diagram, one window

  ┌─ Anthropic API call: 200K token context window ────────────────┐
  │                                                                 │
  │  ┌─ system prompt (stable) ─────┐                                │
  │  │  monitoring.md text:           │ ~1.2K tokens                │
  │  │   role + rules + output spec   │                              │
  │  └────────────────────────────────┘                              │
  │  ┌─ context (injected per call) ┐                                │
  │  │  ★ schemaSummary(workspace) ★  │ ~500–1,500 tokens (BUDGETED) │ ← we are here
  │  │  capped: 20 events × 10 props  │                              │
  │  │  capped: 30 customer properties│                              │
  │  └────────────────────────────────┘                              │
  │  ┌─ user message (trigger) ─────┐                                │
  │  │  "Work through your checklist."│ ~30 tokens                  │
  │  └────────────────────────────────┘                              │
  │  ┌─ tool results (grow per turn) ┐                               │
  │  │  EQL query results: 16K char    │ up to ~5K tokens per result │
  │  │  cap per result (base-legacy)   │ ×6 max tool calls            │
  │  └────────────────────────────────┘                              │
  │  ┌─ response budget (output) ────┐                                │
  │  │  max_tokens: 4096               │ ~4K tokens                   │
  │  └────────────────────────────────┘                              │
  │                                                                 │
  └─────────────────────────────────────────────────────────────────┘
```

The 200K window looks infinite. It isn't. By the time you've put a workspace schema, a category checklist, six tool results, and a 4K response budget into the call, you're at 30–40K tokens for what looks like a "small" agent loop. Budget that wrong and the chain that worked fine in dev starts truncating or timing out at scale because nobody counted. This is the operational concept that separates amateur from professional prompt work.

## Structure pass

**Layers.** Outer: the 200K context window. Middle: the named slots (system, context, user, tool results, response). Innermost: the per-slot caps you set in code.

**Axis — what bounds each slot.** Walk it:

```
  one axis — "what stops this slot from growing forever?" — four layers, four answers

  ┌─ window: 200K tokens total ─────────┐
  │  HARD CAP from the model             │  no override possible
  └─────────────────────────────────────┘
       ┌─ system prompt slot ────────────┐
       │  ENFORCED by template + caps    │  schemaSummary caps event/prop count
       └─────────────────────────────────┘
            ┌─ tool result slot ─────────┐
            │  ENFORCED by truncate()    │  16K chars/result hard cap
            └────────────────────────────┘
                 ┌─ response slot ───────┐
                 │  ENFORCED by max_tokens│ params.max_tokens = 4096
                 └────────────────────────┘
```

Each slot has its own enforcement mechanism. If even one of them is unbounded, the rest of the budget doesn't matter — you'll blow the window the first time that slot grows.

**Seams.** The biggest seam is between *static prefix* (system prompt, stable across calls) and *dynamic content* (context, tool results, user message). Provider caching depends on this seam being clean — concept covered below.

## How it works

### Move 1 — the mental model

You know how a `<form>` with `enctype="multipart/form-data"` has an implicit size limit on the whole payload, and individual fields share that budget? An LLM call is exactly that — one envelope, several fields, shared budget.

```
  The budget — one envelope, four named slots, shared total

  ┌────────────────────────────────────────────────────────────────┐
  │  TOTAL: 200K tokens                                              │
  │                                                                  │
  │  ┌── system ──┬── tool results ──┬── response ──┬── user ───┐  │
  │  │  ~1.5K     │  ~30K (6 results) │  ~4K         │  ~30      │  │
  │  └────────────┴───────────────────┴──────────────┴───────────┘  │
  │                                                                  │
  │  used: ~35K · headroom: ~165K · still: BUDGET EVERYTHING        │
  └────────────────────────────────────────────────────────────────┘

  the 80% rule: if you're over ~160K used, you're one model change
  away from breaking. Aim to live well under that line.
```

The 80% rule is the operational one: if you're using more than 80% of the context window today, you're one minor tokenizer change or one schema expansion away from breaking in production. The headroom is the *insurance* — and you only need it the day you don't have it.

### Move 2 — the walkthrough

**Slot 1 — the system prompt, budgeted at template time.** The system prompt template (`monitoring.md`) is ~1.2K tokens of stable content. It's fixed at build time. The budget here is "keep the rules dense and don't pad with examples you don't need." Concept 01 walks the four-section anatomy that makes this slot survivable.

**Slot 2 — the context injection. This is the one that drifts.** `lib/agents/monitoring.ts:19-60` does the budgeting for you in code:

```typescript
export function schemaSummary(schema: WorkspaceSchema): string {
  const oldestDate = ...;

  // Top 20 events, each capped at 10 properties
  const MAX_EVENTS = 20;
  const MAX_PROPS_PER_EVENT = 10;

  const eventsText = schema.events
    .slice(0, MAX_EVENTS)
    .map((e) => {
      const props = e.properties.slice(0, MAX_PROPS_PER_EVENT).join(', ');
      return `  - ${e.name} (${e.eventCount}): ${props || '(no properties)'}`;
    })
    .join('\n');

  // Customer properties, cap at 30
  const MAX_CPROPS = 30;
  const customerPropsText = schema.customerProperties.slice(0, MAX_CPROPS).join(', ');
  ...
}
```

Step by step:

  → **Cap at 20 events.** The real workspace schema can have hundreds of event types. Top 20 by count is enough for the agent to reason about; the rest are noise.
  → **Cap at 10 properties per event.** Same logic — most events have a long tail of low-signal props.
  → **Cap at 30 customer properties.** Same.
  → **Comment in the source: "the full schema is 112KB."** A raw `JSON.stringify(schema)` would be ~30K tokens just on its own. The compacted summary is ~1K tokens. That's *the* token-budgeting move in this codebase.

The compaction shape:

```
  Pattern — schema compaction, raw vs compacted

  raw workspace schema (full)            compacted summary
  ─────────────────────────              ────────────────
  events: 287 entries                    events: top 20 by count
    each: { name, eventCount,            each: "  - name (count): prop1, ..."
            properties: 1–60 strings,    (max 10 props per event)
            ... }
  customerProperties: 120 strings        customerProperties: top 30, joined

  ~112KB / ~30K tokens                   ~3KB / ~1K tokens
```

The compacted shape preserves the *signal* (which events exist, roughly how often, what properties they carry) and drops the *noise* (long tails, rarely-used properties). Concept 06 walks why one summary serves all five agents — they're all asking the same compacted question.

**Slot 3 — tool results. Every turn adds another one.** `lib/agents/base-legacy.ts:32-37`:

```typescript
const MAX_TOOL_RESULT_CHARS = 16_000;

function truncate(s: string): string {
  if (s.length <= MAX_TOOL_RESULT_CHARS) return s;
  return s.slice(0, MAX_TOOL_RESULT_CHARS) + '\n…[truncated]';
}
```

16K characters per result, hard cap. EQL queries can return a *lot* of data — a `by customer.country grouping top 5` returns five rows; a `by day in last 365 days` returns 365 rows; a malformed query can dump a giant error response. 16K chars works out to roughly 5K tokens worst case. With a budget of 6 tool calls, the worst case is ~30K tokens of tool results. That's the bound the budget is sized against.

The execution trace, one call:

```
  Execution trace — one tool call, one result, growing the conversation

  state before call:
    messages: [
      { role: 'user', content: 'Work through your checklist.' },
      { role: 'assistant', content: [TextBlock + ToolUseBlock(EQL)] }
    ]
    tokens used: ~3K

  tool runs, returns ~18K char JSON result
  truncate(result) → 16K chars + '…[truncated]' suffix

  state after:
    messages: [
      { role: 'user', content: 'Work through your checklist.' },
      { role: 'assistant', content: [TextBlock + ToolUseBlock(EQL)] },
      { role: 'user', content: [{ type: 'tool_result', content: '[16K chars]…[truncated]' }] }
    ]
    tokens used: ~8K  (added ~5K for the truncated result)
```

The truncation isn't just "save tokens." It's *bounded growth*. Without `truncate`, one runaway EQL result blows the budget for the entire conversation.

**Slot 4 — the response. The output cap (`max_tokens`) enforces.** `lib/agents/base-legacy.ts:126`:

```typescript
const params: Anthropic.Messages.MessageCreateParamsNonStreaming = {
  model: AGENT_MODEL,
  max_tokens: maxTokens,  // default 4096
  ...
};
```

4K tokens for the response is plenty for a structured JSON output (an Anomaly array is rarely more than ~500 tokens). Setting it higher would let the model ramble; setting it lower would risk truncating a valid response mid-JSON. 4K is the deliberate ceiling.

**Lost-in-the-middle — even when context fits, position matters.** This is the operational thing every prompt engineer learns the hard way. Models attend more strongly to content at the *start* and *end* of the prompt; content in the middle is poorly recalled. Look at `legacy-prompts/monitoring.md`:

```
  Position matters — what goes where in the monitoring prompt

  ┌─ start (strong attention) ──────────────────┐
  │  ## Role                                      │
  │  ## Hard rules (1–4)                          │
  │  ## Your category checklist                    │
  └──────────────────────────────────────────────┘
  ┌─ middle (weak attention) ───────────────────┐
  │  Period-over-period method                    │
  │  CRITICAL: verify your windows...             │
  │  Suggested query plan                          │
  │  Tool catalog reminders                        │
  │  Common errors to avoid                        │
  └──────────────────────────────────────────────┘
  ┌─ end (strong attention) ────────────────────┐
  │  ## Output  (the JSON shape spec + example)   │
  │  ## Workspace schema  ({schema} interpolation)│
  └──────────────────────────────────────────────┘
```

The most load-bearing content — rules at the top, output shape + schema at the bottom. The middle holds *useful but recoverable* context (query examples, error guidance). If the model loses fidelity in the middle, the rules at the top and the output shape at the bottom still steer it. This is intentional placement.

**Prefix caching — keep what's stable at the front.** Anthropic and OpenAI both cache static prompt prefixes across calls. The cache hit is enormous — 90% cost reduction on the cached portion. The discipline:

```
  Prefix caching — what gets cached, what doesn't

  ┌─ STABLE (cacheable across calls) ──────────┐
  │  monitoring.md prose                         │
  │  Hard rules                                  │
  │  Output shape + JSON example                  │
  │  Tool catalog reminders                       │
  └──────────────────────────────────────────────┘
  ┌─ VARIABLE (cache invalidates here) ────────┐
  │  {project_id} interpolation                   │ ← cache breaks at first var
  │  {categories} interpolation                   │
  │  {schema} interpolation (workspace-specific)  │
  │  user message                                 │
  └──────────────────────────────────────────────┘
```

In this codebase the variable interpolations happen *throughout* the prompt (project_id is mentioned in rule 1 at the top; categories list comes after rules; schema comes last). That hurts cache utilization — the first variable substitution invalidates everything after it. The improvement would be: hoist all stable content to the top, push all variable content to the bottom in one contiguous block. Concept 03 (prompts as code) is the prerequisite to this refactor — you can only restructure a prompt you can version.

**The specific failure — small inputs work, scale breaks.** This is the classic. A chain works fine in dev with a tiny test workspace, you push it, the first customer with a real-sized schema lands, and you see the agent timeout or — worse — silently truncate its response mid-JSON because `max_tokens` was too low for the new context. The fix:

1. Schema compaction (`schemaSummary`) instead of raw schema (this codebase already does this).
2. Per-result truncation (`truncate`) on every tool result (this codebase already does this).
3. A logged token count per call so you can see budget usage in production (this codebase logs `usage` but doesn't aggregate it — concept 03's gap).
4. An eval set that includes a *large workspace* scenario (this codebase doesn't have evals — concept 05's gap).

### Move 3 — the principle

Token budgeting is the same problem as memory budgeting in any constrained system: name your slots, cap each one, leave headroom, measure usage. The 80% rule is the same shape as a 70% disk usage alert — the headroom isn't waste, it's the insurance you need the day you don't have it.

## Primary diagram — the full token budget

```
  ┌─ 200K context window ────────────────────────────────────────────────┐
  │                                                                       │
  │  ┌─ STABLE PREFIX (cacheable) ────────────────────────────────────┐  │
  │  │  monitoring.md prose (~1.2K tokens)                              │  │
  │  │   - role + identity                                              │  │
  │  │   - hard rules (numbered)                                        │  │
  │  │   - period-over-period method                                    │  │
  │  │   - tool catalog reminders                                       │  │
  │  │   - output shape + JSON example                                  │  │
  │  └────────────────────────────────────────────────────────────────┘  │
  │  ┌─ VARIABLE (per call, cache breaks) ───────────────────────────┐  │
  │  │  {project_id}                          ~30 tokens               │  │
  │  │  {categories} (checklist)              ~500–1K tokens           │  │
  │  │  {schema} ← schemaSummary, capped       ~500–1.5K tokens         │  │
  │  └────────────────────────────────────────────────────────────────┘  │
  │  ┌─ USER message ──────────────────────────────────────────────┐    │
  │  │  trigger sentence                       ~30 tokens             │    │
  │  └──────────────────────────────────────────────────────────────┘    │
  │  ┌─ TOOL RESULTS (grow per turn, capped) ─────────────────────────┐  │
  │  │  truncate to 16K chars/result            ≤5K tokens × 6 calls   │  │
  │  │   = ≤30K tokens worst case                                       │  │
  │  └────────────────────────────────────────────────────────────────┘  │
  │  ┌─ RESPONSE BUDGET ─────────────────────────────────────────────┐   │
  │  │  max_tokens: 4096                        ~4K tokens             │   │
  │  └─────────────────────────────────────────────────────────────────┘  │
  │                                                                       │
  │  total worst case: ~38K used · headroom: ~162K (well under 80%)        │
  └───────────────────────────────────────────────────────────────────────┘
```

## Elaborate

The numbers in this guide are Anthropic-specific. Tokenizer ratios vary across providers — Claude's tokenizer averages ~3.5 chars/token for English; OpenAI's GPT-4 tokenizer is ~4 chars/token. For non-English content the ratios shift further. You can use Anthropic's `count_tokens` endpoint or `tiktoken` (OpenAI) to get exact counts during development; the rule "measure, don't estimate" is the right one.

Three places to deepen this:

- **The lost-in-the-middle paper (Liu et al., 2023).** The empirical demonstration that middle-of-context recall is significantly worse than start/end recall. Has held up across model upgrades; informs every prompt layout decision in this codebase.
- **Anthropic's prompt caching docs.** Walks the exact rules — what counts as the "stable prefix," how cache breakpoints work, the cost/latency math. The 90%-cost-reduction figure is real but only applies to the *prefix portion* that hits the cache.
- **Compression techniques beyond truncation.** When you genuinely can't compact further with cropping, summarization of earlier turns (an LLM call to compress, fed back as a single message) is the next step. This codebase doesn't do this because the conversation is short (max 6 turns per agent); for a longer-running chat agent it would be load-bearing.

In this codebase, concept 06 (single-purpose chains) is the architectural answer to "why is the budget manageable?" — each chain is one job, so each chain's budget is tractable. A monolithic agent that did monitoring + diagnostic + recommendation in one prompt would blow the budget on the first complex workspace.

## Interview defense

**Q: "How do you keep your prompts inside the context window?"**

Four-slot budget: system prompt, injected context, tool results, response. *(Draw the diagram.)* The biggest lever in this codebase is schema compaction (`schemaSummary` at `lib/agents/monitoring.ts:19-60`) — the full workspace schema is 112KB / ~30K tokens; the compacted summary is ~1K. Caps at 20 events × 10 properties + 30 customer properties. Tool results get a separate 16K-char-per-result cap at `lib/agents/base-legacy.ts:32-37`. Response is capped with `max_tokens: 4096`. Each slot has its own enforcement.

```
  worst case sum: ~38K tokens, well under the 200K window's 80% line
```

Anchor: *"every slot has a cap. The full schema would blow the budget alone."*

**Q: "What's the 80% rule?"**

If you're using more than 80% of the context window today, you're one tokenizer change or one schema expansion from breaking. The headroom is the insurance you only need the day you don't have it. In this repo I'm at ~20% usage worst case, so the 80% rule doesn't bite — but the *discipline* of measuring against it is what keeps it from biting.

Anchor: *"the headroom is the insurance you need the day you don't have it."*

**Q: "What's lost-in-the-middle?"**

Models attend more strongly to the start and end of the prompt; content in the middle is poorly recalled. *(Draw the position diagram.)* In `monitoring.md`, hard rules go at the top, the output schema and the workspace context interpolation go at the bottom. The middle holds useful-but-recoverable context — query examples, error guidance. If the model loses fidelity there, the rules at the top and the output shape at the bottom still steer it. Intentional layout.

```
  start:   rules + checklist           (strong attention)
  middle:  query examples + reminders  (weak — recoverable)
  end:     output spec + schema        (strong attention)
```

Anchor: *"start and end are load-bearing. Put the rules and the output spec there. Put recoverable content in the middle."*

**Q: "What about prefix caching?"**

This is the gap in this codebase. Variable interpolations (`{project_id}`, `{categories}`, `{schema}`) happen *throughout* the prompt, so cache utilization is poor — the first variable invalidates everything after it. The fix would be: hoist all stable content to the top, push all variables to a contiguous block at the bottom. I haven't done it because the agents aren't latency-sensitive enough to justify the refactor, but the cost savings would be real at scale.

Anchor: *"caching wants stable-prefix-first. This codebase's prompt layout fights that. It's the refactor I'd do for cost."*

## See also

- `01-anatomy.md` — the four-section structure is the *spatial* discipline that token budgeting depends on.
- `02-structured-outputs.md` — `max_tokens: 4096` for the response is sized for structured JSON, not for prose.
- `03-prompts-as-code.md` — you can only refactor the prompt for caching if it lives in version control.
- `06-single-purpose-chains.md` — single-purpose chains keep per-chain budgets tractable; a monolithic agent would blow the budget.
