# 04 · Token budgeting and context window management

**Token budgeting / prefix caching / context window management — Industry standard**

## Zoom out, then zoom in

Every prompt has a token cost. Every context window has a size. Every ReAct loop reuses the same system prompt across turns — and if you're paying for that prefix on every turn, you're leaving 80% of your money on the table. Token budgeting is the discipline of knowing which bytes are stable (cacheable), which vary (per-call), and which grow unbounded (the tool-result history in the messages array) — and shaping the prompt so cost stays flat as the loop runs long.

```
  Zoom out — where token budgeting sits

  ┌─ Prompt author's choices ────────────────────────────────┐
  │  schemaSummary caps events × properties                   │
  │  formatCategoryChecklist trims category descriptions      │
  │  stable prefix comes BEFORE variable slots                │
  └────────────────────────┬─────────────────────────────────┘
                           │
  ┌─ Provider adapter ─────▼─────────────────────────────────┐
  │  AnthropicModelProviderAdapter.complete()                 │
  │  wraps system in [{text, cache_control:'ephemeral'}]      │
  │  every ReAct-loop turn reuses the same cached prefix      │
  └────────────────────────┬─────────────────────────────────┘
                           │
  ┌─ ★ TOKEN ECONOMICS SEAM ★ ─▼─────────────────────────────┐
  │  first call: cache_creation (~1.25× normal input cost)   │  ← we are here
  │  next calls in 5 min: cache_read (~0.1× normal cost)      │
  │  for a 10-turn diagnostic: ~80% reduction on system tokens│
  └───────────────────────────────────────────────────────────┘
```

**Zoom in.** Two things live in this concept, and they're intertwined. **Budgeting** — the up-front discipline of "the schema is 112KB raw; that's not going in the prompt; here's a `schemaSummary` that fits in ~1500 tokens." **Caching** — the runtime lever that turns a well-shaped stable prefix into an 80% cost reduction over the loop. Both live on the same axis: how many tokens do you pay for, in which places, at what price.

## Structure pass

### Axes — the dimension we're tracing

**Cost per turn of the ReAct loop.** For a diagnostic investigation that runs 8-12 model turns, the question is: does the input-token cost grow linearly with turn count, or does it grow linearly *minus* the cached prefix? Trace that axis and every other decision about token budgeting falls into place.

### Seams — where cost flips

Three cost seams inside one loop:

- **Stable prefix vs variable slot** — the front of the system prompt (role, rules, schema shape) is the same across every turn; the back has variable data (`{schema}`, `{anomaly}`). The cache breakpoint sits at the stable/variable boundary. Put a variable slot in front of a stable one and the cache never hits.
- **System vs messages** — the system prompt is cached; messages are not (or rather: the caching for messages requires separate breakpoints). Tool-result accumulation in the messages array grows with every turn — that growth is not cached.
- **First call vs subsequent calls** — first call is `cache_creation` (~1.25× normal input token cost); subsequent calls within the 5-minute cache window are `cache_read` (~0.1× normal cost). The seam is temporal, and the 5-minute expiry means a stalled loop can burn its cache advantage.

### Layered decomposition

"What is the token cost of this turn?" — traced across the layers of one investigation:

```
  "What does this turn cost me?" — same question, three altitudes

  ┌───────────────────────────────────────────────┐
  │ outer: the whole investigation (10 turns)      │  cache turns 8 turns
  │                                                │  from creation to read
  └───────────────────────────────────────────────┘
      ┌──────────────────────────────────────────┐
      │ middle: one model call                    │  system: cached
      │        (system + messages + tools)        │  tools: cached w/system
      │                                           │  messages: NOT cached
      └──────────────────────────────────────────┘
          ┌───────────────────────────────────────┐
          │ inner: one section of the system      │  role: cache
          │        prompt                          │  rules: cache
          │                                       │  {schema}: cache
          │                                       │  {anomaly}: cache
          └──────────────────────────────────────┘
```

The variable slots (`{schema}`, `{anomaly}`) are still inside the cached prefix because the *whole* investigation shares the same schema and anomaly. What varies across the loop is what's in `messages` — the tool-result turns.

## How it works

### Move 1 — the mental model

You know how HTTP has ETags — the server sends a header the client stores, and on the next request the client sends "if-none-match: <etag>", and if nothing changed the server sends back 304 instead of the whole body? Prompt caching is that, for LLM providers. You tell the provider "cache this prefix" once, and every subsequent call that starts with the same prefix is charged at ~10% of the input token rate instead of 100%.

```
  Prompt caching — the pattern

  first call                              subsequent calls (within 5 min)
  ─────────                               ──────────────────────────────

  ┌─ system prompt ─┐  cache_control      ┌─ system prompt ─┐  cache_control
  │  role           │  ★ breakpoint ★     │  role           │  ★ breakpoint ★
  │  rules          │                     │  rules          │
  │  {schema}       │                     │  {schema}       │  ← IDENTICAL BYTES
  │  {anomaly}      │                     │  {anomaly}      │
  └─────────────────┘                     └─────────────────┘
       │                                       │
       ▼                                       ▼
  billed: cache_creation                  billed: cache_read
  (~1.25× normal input cost)              (~0.1× normal input cost)
```

For a 10-turn loop, that's 1 cache-creation + 9 cache-reads = ~1.25× + 9×0.1× = ~2.15× normal input cost for the system prompt, vs 10× without caching. Roughly 80% reduction on the system-prompt portion.

### Move 2 — the step-by-step walkthrough

**Step 1 — budget the raw schema.**

`lib/agents/monitoring.ts:19-60`:

```ts
export function schemaSummary(schema: WorkspaceSchema): string {
  const oldestDate = schema.oldestTimestamp
    ? new Date(schema.oldestTimestamp).toISOString().slice(0, 10)
    : 'unknown';

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
```

The Bloomreach workspace schema is ~112KB raw. Not going in the prompt. `schemaSummary` picks:

- **top 20 events** by presumed importance (schema-provided ordering)
- **10 properties per event max** — the ones a query is likely to reach for
- **30 customer properties max** — same reasoning
- **inline horizon** — one line naming the data window, because the model needs to know what date ranges are valid

Rough output size: ~1200-1800 tokens depending on the workspace. That fits comfortably in the prompt and leaves headroom for `{anomaly}` (another ~200-400 tokens) and the tool-result turns (10-turn loops accumulate 4-8K tokens of tool results).

```
  schemaSummary — the budget levers

  input: WorkspaceSchema (~112KB raw JSON)
     │
     ▼
  ┌─ event slice (top 20) ────────────────┐
  │  20 × 10 props × ~10 tokens = ~2000    │
  └───────────────────────────────────────┘
     │
     ▼
  ┌─ customer props slice (top 30) ────────┐
  │  30 × ~5 tokens = ~150                 │
  └───────────────────────────────────────┘
     │
     ▼
  ┌─ horizon line + metadata ──────────────┐
  │  ~100 tokens                           │
  └───────────────────────────────────────┘
     │
     ▼
  output: ~1500-2000 tokens
  (vs ~28k tokens for the raw schema)
```

The specific numbers (20, 10, 30) are not sacred. They were chosen because they cover the categories the monitoring agent actually reaches for. If you added a category that needed the 21st event, you'd bump the number. That's the discipline: budget with real usage in mind, not with abstract "context window sizing."

**Step 2 — put the cache breakpoint at the boundary.**

`lib/agents/aptkit-adapters.ts:75-89`:

```ts
// Phase-3 prompt caching. The system prompt is stable across every call
// within an investigation (all ~5-15 ReAct-loop iterations reuse it) and
// is the largest fixed prefix in the payload. Wrapping it in an ephemeral
// cache breakpoint makes the first call a cache_creation (~1.25× normal
// input cost) and every subsequent call within 5 min a cache_read
// (~0.1× normal). For a diagnostic run's ~10 model turns this is roughly
// an 80% reduction on the system-prompt token cost.
//
// Tools are also stable across the loop but the Anthropic API caches
// tools transparently when the SAME breakpoint is set on the system
// prompt — so this one addition covers both prefixes.
if (request.system) {
  params.system = [
    { type: 'text', text: request.system, cache_control: { type: 'ephemeral' } },
  ];
}
```

Two things worth calling out. First, the breakpoint is `ephemeral` — 5-minute cache lifetime. Anthropic supports longer breakpoints, but 5 minutes fits the shape of a diagnostic investigation (typically 30-60 seconds end-to-end). Second, the tools array is *also* cached transparently — you don't set a separate breakpoint on tools; the system-prompt breakpoint covers both. That's an Anthropic-specific behavior; OpenAI's cache-control API works differently.

```
  Cache breakpoint — one addition, two prefixes cached

  ┌── request.system (string) ──┐   ┌── request.tools (array) ──┐
  │  role                        │   │  execute_analytics_eql    │
  │  rules                       │   │  get_metric_timeseries    │
  │  {schema} → cached bytes     │   │  get_segments             │
  │  {anomaly} → cached bytes    │   │  get_anomaly_context      │
  └──────┬──────────────────────┘   └──────────────────────────┘
         │
         │  cache_control:{type:'ephemeral'}
         ▼
  ┌── Anthropic API ────────────────────────────────────────────┐
  │  caches system prefix — read on subsequent calls           │
  │  ALSO caches tools transparently (same breakpoint)         │
  │  usage.cache_read_input_tokens tells you when it hit       │
  └────────────────────────────────────────────────────────────┘
```

**Step 3 — verify the cache is actually hitting in the logs.**

`lib/agents/aptkit-adapters.ts:97-101`:

```ts
console.log(JSON.stringify({
  site: this.logSite,
  sessionId: this.sessionId,
  usage: response.usage,
}));
```

The `response.usage` includes `cache_creation_input_tokens` on the first call and `cache_read_input_tokens` on subsequent calls. If the cache is working, you see something like: turn 1 has 3200 in `cache_creation_input_tokens` and 0 in `cache_read_input_tokens`; turn 2 has 0 creation and 3168 read (the slight difference is because the messages array grew by one tool_result turn between calls, and the breakpoint moved). By turn 8 you're still reading ~3168 tokens from cache per turn.

The specific number 3168 came out of a real diagnostic investigation in this codebase's live logs — cache_creation → cache_read pattern, within-investigation, exactly as designed.

**Step 4 — the lost-in-the-middle problem this codebase mostly avoids.**

There's a phenomenon documented across every LLM provider: content in the middle of a long prompt is attended to less well than content at the beginning or end. This codebase's prompts are structured so the load-bearing content (rules, schema shape, task instruction) sits at the beginning or end, and the interpolated variables (`{schema}`, `{categories}`) sit near the end where recency helps. If you ever add a chain that stuffs 30K tokens of retrieved context into the middle of a prompt, you're on the wrong side of this — retrieval should compress, not stuff.

```
  Lost-in-the-middle — attention over prompt position

  attention ●                                                ●
    weight  ●●                                              ●●
            ●●●                                            ●●●
            ●●●●                                          ●●●●
            ●●●●●                                        ●●●●●
            ─────────────────────────────────────────────────
            beginning              middle              end

            role, rules            (avoid)             task,
            schema shape                              recent turns
```

**Step 5 — the 80% rule and when it earns its keep.**

Rule of thumb: if you're using more than 80% of the context window, you're one model change or one longer-than-usual anomaly away from breaking. A Sonnet 4.6 context window is 200K tokens. 80% is 160K. In this codebase, a diagnostic investigation at 10 turns uses ~15-25K tokens total including all accumulated tool results — well within budget. If you ever see a turn approaching 80K, look at what's growing linearly with turn count. Almost always it's tool-result truncation: a tool returned 40K of JSON, the loop kept it verbatim, and by turn 5 you're carrying 200K of tool results.

Fix: truncate tool results at the boundary. The eval harness does this at `eval/run.eval.ts:145-147` (`raw.length > 4000 ? raw.slice(0, 4000) + '…'`). The agent loop should do the same for its internal tool_result blocks.

### Move 2 variant — the load-bearing skeleton

The kernel of token budgeting is four moves, in order:

```
  budget → stable-before-variable → cache breakpoint → verify in logs
```

What breaks if you skip each:

- **Skip "budget"** — you stuff the raw schema into the prompt, first turn is fine, tenth turn OOMs the context window. The failure is the ninth turn suddenly refusing to run.
- **Skip "stable-before-variable"** — you put `{anomaly}` at the top of the prompt and the role paragraph at the bottom. Cache breakpoint captures nothing because the cacheable content is behind a variable. Cache read rate: 0%.
- **Skip "cache breakpoint"** — every turn pays full input cost for the system prompt. 10-turn investigation costs 5-10× what it needs to. The fix is 2 lines of adapter code.
- **Skip "verify in logs"** — you *think* the cache is hitting; you don't know. Ship goes out; cost bill triples six months later; you find the breakpoint was on a version of the prompt where `{schema}` was in front of the role paragraph.

Hardening layered on top: prefix-cache CI checks (parse the logs of the eval run; fail if cache read rate is below a threshold), per-investigation budget tracker (`BudgetTracker` in `lib/agents/budget.ts` — throws `BudgetExceededError` if cost exceeds a ceiling), tool-result truncation in the loop.

### Move 3 — the principle

**Every byte in a prompt has a cost, a cacheability, and an attention weight — and where you put the byte matters for all three.** Junior mode treats the prompt as one string. Senior mode knows every byte lives in one of four regions (cached-stable prefix, variable-slot inside prefix, per-turn messages array, per-turn tool results) and shapes the payload so cost stays flat as the loop runs long.

## Primary diagram

```
  Token budgeting — the whole picture

  ┌── system prompt (cached) ─────────────────────────────────┐
  │  role          | rules           | schema shape            │
  │  ─────────────  ─────────────────  ─────────────────────    │
  │  ~150 tokens   ~400 tokens        ~200 tokens               │  stable
  │                                                             │  across
  │  ┌─ {schema} interpolation ──────────────────────────────┐  │  every
  │  │  schemaSummary(workspace)                             │  │  turn
  │  │  top 20 events × 10 props + 30 customer props         │  │
  │  │  ~1500 tokens (capped)                                │  │  ← still
  │  └───────────────────────────────────────────────────────┘  │  cached
  │  ┌─ {anomaly} interpolation ─────────────────────────────┐  │  because
  │  │  JSON.stringify(anomaly)                               │  │  it's
  │  │  ~300 tokens                                          │  │  stable
  │  └───────────────────────────────────────────────────────┘  │  per case
  │                                                             │
  │  cache_control: { type: 'ephemeral' }  ← breakpoint here    │
  └─────────────────────────────────────────────────────────────┘

  ┌── tools array (cached transparently) ─────────────────────┐
  │  execute_analytics_eql · get_metric_timeseries · …        │
  │  ~2000 tokens                                             │
  └───────────────────────────────────────────────────────────┘

  ┌── messages array (NOT cached, grows) ──────────────────────┐
  │  turn 1: user "run the checklist"        ~15 tokens         │
  │  turn 2: assistant + tool_use            ~200 tokens        │
  │  turn 3: tool_result                     ~1500 tokens       │
  │  turn 4: assistant + tool_use            ~150 tokens        │
  │  turn 5: tool_result                     ~1200 tokens       │
  │  ...                                                        │
  │  by turn 10:                             ~8-12K tokens      │
  └───────────────────────────────────────────────────────────┘

  first call:  cache_creation on ~4200 tokens → paid at ~1.25× rate
  turns 2-10: cache_read on ~4200 tokens → paid at ~0.1× rate
              + messages growing linearly, paid full rate

  net effect: ~80% reduction on the stable prefix cost
```

## Elaborate

Prompt caching became a first-class feature of the Anthropic API in mid-2024 and OpenAI's caching arrived shortly after with slightly different semantics — OpenAI does prefix caching automatically without an explicit breakpoint, but the cache is opaque and you don't get to control the breakpoint position. Anthropic's explicit `cache_control` breakpoints let you decide where the boundary sits, which is why every mature Anthropic-backed codebase ends up with an adapter that wraps the system prompt in a text block with cache_control on it.

The 5-minute expiry is worth internalizing. If your loop stalls (say, an MCP tool takes 6 minutes to respond) the cache is dead by the next model call and you pay for a fresh cache creation. In practice this rarely bites because loops don't stall that long — Blooming's MCP client has a ~1 req/s rate limit and typical tool calls take ~200-500ms. But if you built a workflow with human-in-the-loop pauses, the ephemeral cache would be the wrong shape and you'd want the longer-TTL breakpoint.

`schemaSummary`'s decision to cap at 20 events / 10 props / 30 customer props is a working tradeoff, not a principle. Bloomreach ecommerce workspaces cluster in shape — the top-20 events cover ~95% of what the monitoring agent reaches for. If you migrated the same codebase to a different vertical (say, media analytics), the top-20 cap might miss critical events and you'd re-tune. The lesson is not "cap at 20"; the lesson is "cap based on the categories your agent actually queries."

Related work: the "lost in the middle" paper (Liu et al., 2023) is the canonical reference for the attention-over-position effect. Anthropic's context-window guidance covers cache_control in detail. Simon Willison has written about the practical implications of prefix caching for cost.

Related concepts:
- **Anatomy** (`01-anatomy.md`) — the stable-before-variable ordering that makes caching work.
- **Prompts as code** (`03-prompts-as-code.md`) — the observability that verifies cache is hitting.
- **Eval-driven iteration** (`05-eval-driven-iteration.md`) — where per-case token/cost usage is captured.

## Interview defense

**Q: Walk me through prompt caching in this codebase. What's cached, when, and how do you verify it's working?**

Two lines of adapter code do the work — `AnthropicModelProviderAdapter.complete()` at `lib/agents/aptkit-adapters.ts:85-89` wraps `request.system` in a text block with `cache_control: { type: 'ephemeral' }`. That's one explicit breakpoint on the system prompt; Anthropic then caches the tools array transparently against the same breakpoint. For a diagnostic investigation that runs 8-12 model turns, the first turn pays cache_creation (~1.25× normal input cost) and every subsequent turn within 5 minutes pays cache_read (~0.1×). Net effect on the stable prefix: ~80% cost reduction. Verification is in the logs — `console.log({site, sessionId, usage})` includes `cache_creation_input_tokens` and `cache_read_input_tokens`. In a real live-log I've seen the pattern land at 3200 tokens created on turn 1, 3168 read on turns 2-10. That gap of 32 is because the messages array grew by one tool_result turn, so the breakpoint moved slightly forward relative to the current call.

```
  Turn-by-turn cache hit pattern

  turn 1  ┃  cache_creation: 3200  cache_read:    0  ← first call
  turn 2  ┃  cache_creation:    0  cache_read: 3168  ← hit!
  turn 3  ┃  cache_creation:    0  cache_read: 3168
  ...
  turn 10 ┃  cache_creation:    0  cache_read: 3168
                                              ↑
                                    consistent across the whole loop
```

Anchor: `AnthropicModelProviderAdapter.complete()` at `lib/agents/aptkit-adapters.ts:59-121`.

**Q: The `schemaSummary` caps events at 20 and properties at 10. Where did those numbers come from?**

From the categories the monitoring agent actually queries. The workspace schema is 112KB raw; that's not going in the prompt. The cap is set so the top-20 events cover the categories in the runnable checklist (`ECOMMERCE_ANOMALY_CATEGORIES` in `@aptkit/core`). If you added a category that needed the 21st event, you'd bump the cap. This is the discipline: budget with usage, not with abstract sizing. The output at those caps is ~1500-2000 tokens, which leaves headroom for the anomaly interpolation and the tool-result turns that accumulate in the messages array.

```
  Budget levers — where the numbers come from

  events cap (20)   ── determined by categories that query them
  props cap (10)     ── determined by what queries actually filter on
  customer props (30)── determined by what queries actually break down by

  none of these are principles. They are what usage demands.
```

Anchor: `schemaSummary` at `lib/agents/monitoring.ts:19-60`.

**Q: What's the load-bearing part people forget about token budgeting?**

Ordering. The cache breakpoint sits at *the boundary between stable and variable*. If you put a variable slot (say `{anomaly}`) at the top of the system prompt and the role paragraph at the bottom, the cache breakpoint captures whatever's in front of it — but the front is variable, so the cache never hits. Same total token count, cache read rate of 0%. The 80% cost savings depend entirely on stable-content-first. It's the ordering, not the presence of the breakpoint, that does the work.

```
  Ordering — why it decides cache hit rate

  RIGHT                              WRONG
  ─────                              ─────
  system:                             system:
    role (stable)                       {anomaly} (varies)
    rules (stable)                      role (stable)
    schema shape (stable)               rules (stable)
    {schema} (stable-per-case)          schema shape (stable)
    {anomaly} (stable-per-case)         {schema} (stable-per-case)

  cache breakpoint hits ★           cache breakpoint hits ✗
  every subsequent turn.            variable content differs
  ~80% cost reduction.              call-to-call → 0% hits.
```

## See also

- `01-anatomy.md` — the stable-before-variable ordering.
- `03-prompts-as-code.md` — how prompt package version and observability pair.
- `05-eval-driven-iteration.md` — per-case token+cost receipts.
- `06-single-purpose-chains.md` — why splitting agents keeps each prompt's budget honest.
