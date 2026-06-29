# Context engineering

**Industry standard.** The discipline RAG and prompt engineering are subsets of. **Deeply exercised** in this repo — the `schemaSummary` token-budget trick is the load-bearing example.

## Zoom out, then zoom in

Sits across every component that fills the model's context window. Prompt engineering is one slice (the static instructions); retrieval is another (the dynamic facts); tool outputs are another (the observation blocks); user state is another. Context engineering is the discipline that decides what fills the window.

```
  Zoom out — where this concept lives

  ┌─ Context engineering ───────────────────────────────────┐
  │  (the superset discipline)                               │ ← we are here
  │                                                          │
  │   ┌─────────────┐  ┌─────────────┐                       │
  │   │   prompt    │  │     RAG     │                       │
  │   │ engineering │  │ (retrieval) │                       │
  │   └─────────────┘  └─────────────┘                       │
  │   ┌─────────────┐  ┌─────────────┐                       │
  │   │   memory    │  │ tool outputs│                       │
  │   └─────────────┘  └─────────────┘                       │
  │   ┌─────────────┐  ┌─────────────┐                       │
  │   │ history      │  │ user profile│                       │
  │   └─────────────┘  └─────────────┘                       │
  └─────────────────────────────────────────────────────────┘
```

The reframe to hand the reader: most agent failures are not model failures — they are *context* failures. Stale retrieval, lost-in-the-middle on a bloated context, the wrong tool outputs in the window, no user state loaded. Bigger context windows don't solve this — they make room for more noise.

## Structure pass

Layers: static context (system prompt, tool definitions) → dynamic context (retrieved facts, tool outputs, conversation history) → curated handoff (what passes to the next turn / agent).

**Axis traced — "what fills the window?":** for any given model call, the contents are deliberate, not accidental. Every block in the window earned its place; everything else is excluded.

**Seam:** the per-turn message-building boundary. Before each `model.complete` call, *something* decides what goes in `system`, `messages`, and `tools`. That something is your context engineering — even if it's "everything plus a hardcoded prompt."

## How it works

### Move 1 — the mental model

You know the difference between writing a search box and writing a curated landing page. The search box puts everything matching the query in front of the user; the curated page picks specific items for specific reasons. Prompt engineering is the search box — the model sees the question and a fixed instruction. Context engineering is the landing page — for each model call, you decide which of N possible context blocks earn their tokens.

```
  Context engineering — the curating discipline

  available context (could fill the window):
  ┌─────────────────────────────────────────────────────────────┐
  │  full schema (112KB), all events, all customer props        │
  │  ─── too big for the window even if useful                  │
  │                                                              │
  │  the user's last 100 questions                              │
  │  ─── not relevant to the diagnostic                          │
  │                                                              │
  │  every Bloomreach scenario ever defined (~120)              │
  │  ─── only 4-5 might be relevant                              │
  │                                                              │
  │  the agent's full chain-of-thought from the last 20 runs    │
  │  ─── would let it learn; would also bloat fast               │
  └─────────────────────────────────────────────────────────────┘

  what actually fills the window (after curation):
  ┌─────────────────────────────────────────────────────────────┐
  │  system prompt (static): role, format, tools                │
  │  schema summary (token-bounded): top 20 events, top 30 cprops│
  │  this turn's user prompt / anomaly                          │
  │  this run's tool results (truncated at 16,000 chars each)   │
  └─────────────────────────────────────────────────────────────┘
```

The win isn't "less context is better." The win is "the right context, in the right amount, for this specific call."

### Move 2 — step by step

#### The load-bearing instance — `schemaSummary`

Open `lib/agents/monitoring.ts:19-60`. The function `schemaSummary(schema: WorkspaceSchema): string` takes the raw Bloomreach workspace schema (which can be 112KB+ of events, properties, customer attributes) and returns a token-bounded summary the agent's system prompt embeds.

```ts
// lib/agents/monitoring.ts:19-60 (abridged)
export function schemaSummary(schema: WorkspaceSchema): string {
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

  return [
    `Project: ${schema.projectName} (${schema.projectId})`,
    `Total customers: ${schema.totalCustomers.toLocaleString()}`,
    `Total events: ${schema.totalEvents.toLocaleString()}`,
    `Oldest data: ${oldestDate}`,
    ...(horizonLine ? [horizonLine] : []),
    `Catalogs: ${schema.catalogs.map((c) => c.name).join(', ') || 'none'}`,
    '',
    `Top events (name, eventCount: properties):`,
    eventsText,
    '',
    `Customer properties: ${customerPropsText}`,
  ].join('\n');
}
```

Three curation decisions made explicit:

- **Top 20 events** by event count. The model needs to know the workspace's event vocabulary; it doesn't need every event ever. The top 20 covers ≥95% of the volume in typical Bloomreach workspaces.
- **Top 10 properties per event.** Same logic — the most-emitted properties carry the most signal; the tail is noise.
- **Top 30 customer properties.** Bloomreach workspaces commonly have 100+ customer properties; the model needs the dominant ones (country, segment, channel, lifecycle stage) and rarely needs the long tail.

The result is roughly 2-4KB of text instead of 100KB+. The agent gets the schema's *shape* without the bloat that would push real content out of the model's attention window.

The same pattern repeats in AptKit's own `@aptkit/agent-anomaly-monitoring/.../schema-summary.js` (used inside the AptKit class); the Blooming wrapper's `schemaSummary` is provided as a reference / for tests, and the AptKit version is what the live monitoring loop actually uses. Both implement the same curation discipline.

#### The system-prompt budget

Open `lib/agents/aptkit-adapters.ts:42-55` — the `AnthropicModelProviderAdapter.complete` method. The system prompt comes from the AptKit agent class (which renders the prompt template from `@aptkit/prompts` with the schema summary + the category checklist). The total system-prompt size is roughly:

- ~800 tokens of static instructions (per the AptKit prompt package).
- ~500-1000 tokens of schema summary (from `schemaSummary`).
- ~600-800 tokens of category checklist (for monitoring) or domain context (for the other agents).
- ~200 tokens × N tool definitions (allowlist-filtered to 4-33 tools).

For the monitoring agent: ~2500 tokens of system prompt + ~800 tokens of tool definitions (4 tools × 200 tokens) = ~3300 tokens of static overhead per turn. For the query agent (33 tools): ~2500 + ~6600 = ~9100 tokens. The query agent pays more per turn because its tool allowlist is wider.

This is the cost the per-agent tool allowlist (`02-agentic-retrieval/03-retrieval-routing.md`) buys back: keeping the monitoring agent at 4 tools saves ~5800 tokens per turn × 8 turns max = ~46K tokens per run. At Sonnet input pricing that's roughly $0.14 per run saved. The narrower allowlist isn't just a quality decision — it's a context-engineering decision.

#### Tool-result truncation — the dynamic-context cap

`runAgentLoop` truncates every tool result at 16,000 characters (`run-agent-loop.js:2-7`):

```js
const MAX_TOOL_RESULT_CHARS = 16_000;
function truncate(value) {
    if (value.length <= MAX_TOOL_RESULT_CHARS) return value;
    return `${value.slice(0, MAX_TOOL_RESULT_CHARS)}\n...[truncated]`;
}
```

Without this cap, a single large EQL result (some Bloomreach queries can return tens of thousands of customer rows) would push earlier tool results out of the model's effective attention window — the lost-in-the-middle problem. The 16,000-char cap is roughly 4,000 tokens; multiplied by the per-agent tool-call budget (6 for monitoring, ~8 typical for the others), the dynamic tool-result context tops out at ~24-32K tokens. Sonnet 4.6's 200K nominal context window comfortably holds that plus the system prompt plus the running conversation.

The truncation is fail-safe: when it fires, the truncation marker (`...[truncated]`) is visible in the tool result so the model knows the data was cut. The model can then either ask a narrower follow-up query or work with what it has.

#### What this repo deliberately does NOT do

- **No conversation history across runs.** Each agent run starts fresh; the model doesn't see "your last 5 investigations."
- **No accumulated memory store.** No vector DB of past diagnoses. The agent doesn't learn from previous runs.
- **No user-profile context.** The model doesn't see "this user prefers detailed evidence" or anything similar.
- **No catalog content embedded.** The agent knows the catalog *exists* (from `schemaSummary`'s `Catalogs:` line) but doesn't carry catalog items in its context — it would have to query for them.

Each of these is a deliberate scoping choice. The product doesn't have a use case yet that justifies the cost of adding any of them. The interview-grade move is naming what you didn't add and the trigger that would change the call.

### Move 3 — the principle

**Context engineering keeps the thousandth good output good.** Prompt engineering wins the first good output (carefully-crafted instructions land the model on the right behavior). Context engineering keeps that behavior reliable as the system runs in production — by ensuring every turn gets exactly the context that turn needs, no more, no less. Bigger context windows are not the answer; *curation* is. The job is deciding what fills the window for the next step, and in a multi-agent system, which agent sees what.

## Primary diagram

```
  Context engineering applied to one monitoring agent turn

  ┌─ static context (set once, reused every turn) ───────────────┐
  │  system prompt (from @aptkit/prompts, ~800 tokens):           │
  │    "you are an anomaly scanner..."                            │
  │                                                                │
  │  schema summary (curated, ~500-1000 tokens):                  │
  │    project: wobbly-ukulele (xxx)                              │
  │    total customers: ~340K                                     │
  │    total events: ~12M                                         │
  │    top events: purchase (2.1M): total_price, country, ...     │
  │      view_item (5.3M): product_id, category, ...              │
  │      ...                                                       │
  │    customer properties: country, lifecycle_stage, segment, ...│
  │                                                                │
  │  category checklist (for monitoring, ~600-800 tokens):         │
  │    - revenue_drop: warning >= 10%, critical >= 25%, recipe:   │
  │      sum event purchase.total_price...                        │
  │    - conversion_drop: ...                                     │
  │                                                                │
  │  tool definitions (allowlist-filtered, 4 tools × 200 tokens): │
  │    execute_analytics_eql, get_metric_timeseries,              │
  │    get_segments, get_anomaly_context                          │
  └────────────────────────────────────────────────────────────────┘

  ┌─ dynamic context (grows per turn) ────────────────────────────┐
  │  user prompt (one-line task): "Run the anomaly checklist."    │
  │                                                                │
  │  running conversation (turn N):                               │
  │    turn 1 (assistant): "I'll start with revenue. Tool call..."│
  │    turn 1 (user/tool_result): { current_90d, prior_90d } —   │
  │      truncated at 16,000 chars                                │
  │    turn 2 (assistant): "Drop confirmed. Localize..."          │
  │    turn 2 (user/tool_result): { USA: -38, ... }               │
  │    ...                                                         │
  └────────────────────────────────────────────────────────────────┘

  Total per turn: ~3.3K static + dynamic (grows 1-4K per tool call)
  Cap at ~32K dynamic via tool-result truncation
  Sonnet 4.6 nominal context: 200K (comfortable for this load)
```

## Elaborate

The "lost in the middle" effect (Liu et al., 2023) is the empirical foundation for context engineering being a discipline. Models trained on long contexts still attend most strongly to content near the start and end of the input; content in the middle is reliably under-weighted. The cure isn't "make the model smarter at long context" (the trend line is improving but the effect persists); it's "put the load-bearing content in the high-attention zones." Curation determines which content earns the high-attention zones.

The discipline applies across every part of an agent system: prompt order (most-important instructions at the top), tool-result placement (tool results land as user messages, which sit at the end of the conversation — the high-attention zone for "what just happened"), retrieval ranking (the top-k chunks land in the user message — same zone), agent-to-agent handoff (the next agent's input is just the typed handoff, not the producer's full trajectory — keeping the next agent's high-attention zone clean).

The Anthropic blog post on context engineering (and the equivalent OpenAI/LangChain content) all converge on the same headline: prompt engineering is the easy half; context engineering is the hard half. The signal of someone who has shipped is naming context engineering as a discipline, not collapsing it into "prompt engineering."

## Interview defense

> **Q: How does this codebase handle context engineering?**
>
> Deliberately, at multiple layers. The `schemaSummary` function in `lib/agents/monitoring.ts:19-60` reduces a 100KB+ Bloomreach workspace schema to ~2-4KB by keeping top-20 events × top-10 properties + top-30 customer properties — the model gets the schema's shape without the bloat. Tool results are capped at 16,000 chars in `runAgentLoop` (`run-agent-loop.js:2-7`) so a large EQL result can't push earlier evidence out of the model's attention window. The per-agent tool allowlist narrows the system-prompt tool definitions from 33 to 4-14 depending on agent role, saving ~5-6K tokens per turn for the monitoring agent. And the message-passing pattern between agents (`03-multi-agent-orchestration/08-shared-state-and-message-passing.md`) keeps each agent's context scoped to its actual typed inputs — the recommendation agent doesn't carry the diagnostic agent's trajectory in its window.

> **Q: What's the load-bearing instance of context engineering in this repo?**
>
> The `schemaSummary` token-budget trick. Without it, the agent's system prompt would carry the full raw Bloomreach schema — 100KB+ of every event ever emitted, every property name, every customer attribute. That bloat would push the running conversation (the actual diagnostic reasoning) into the model's mid-attention zone and degrade quality. With the summary, the system prompt stays under 4K tokens and the dynamic context can grow naturally without competition. The cost of building the summary is one pure function — `slice(0, 20)` calls plus a `.map(...).join('\n')` — and the savings compound across every turn × every agent run.

> **Q: What would you add to context engineering here if you had a free week?**
>
> A semantic cache layer for cross-run retrieval. Today the diagnostic agent doesn't know whether a similar anomaly was investigated yesterday — it always starts from scratch. Embedding past `Diagnosis` outputs and surfacing the top-3 similar past investigations as additional context for the current diagnostic would let the model say "this looks like the post-Black-Friday revenue dip we saw 4 weeks ago — the cause was X" instead of re-deriving from data. The cost is the embedding pipeline + a vector store (the project intentionally avoids these today). The win is faster + sharper diagnostics for recurring patterns. This would also unlock the episodic memory tier from `02-agent-memory-tiers.md`.

## See also

- → `02-agent-memory-tiers.md` — the next discipline up (memory as curated context across runs)
- → `02-agentic-retrieval/01-agentic-rag.md` — retrieval as one specific form of dynamic context
- → `03-multi-agent-orchestration/08-shared-state-and-message-passing.md` — the same discipline at the multi-agent boundary
- → cross-reference (when generated): `study-ai-engineering`'s context-window and lost-in-the-middle files — the mechanics this discipline rests on
