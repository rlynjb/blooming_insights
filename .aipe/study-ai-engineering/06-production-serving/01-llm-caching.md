# LLM caching

*Industry standard — prompt cache · semantic cache · exact-match cache*

## Zoom out — where this concept lives

Three cache layers in the LLM serving stack. This codebase has **one shipped** (60s response cache for tool results inside `BloomreachDataSource`) and **two not yet exercised** (Anthropic prompt caching, semantic cache for LLM answers). The honest gap: Anthropic prompt caching is the single biggest dollar lever and isn't wired.

```
  Zoom out — three cache layers, one shipped

  ┌─ Anthropic prompt caching ──────────────────────────────┐
  │  Provider-side. Cache the static prompt prefix          │
  │  (system + tool defs + schema summary)                  │
  │  Cost: ~10% of normal input rate for cache hits         │
  │  STATUS: not wired                                      │
  └─────────────────────────────────────────────────────────┘
  ┌─ Semantic cache (your side) ────────────────────────────┐
  │  Embed query, check if similar query answered recently   │
  │  STATUS: not implemented; no embedder anywhere          │
  └─────────────────────────────────────────────────────────┘
  ┌─ ★ Tool-result cache (60s response cache) ★ ────────────┐ ← we are here
  │  Inside BloomreachDataSource.callTool                   │
  │  Keyed on `${name}:${JSON.stringify(args)}`              │
  │  60s TTL, no errors cached                              │
  │  STATUS: shipped                                        │
  └─────────────────────────────────────────────────────────┘
```

**Zoom in.** Three altitudes of caching — provider-side, semantic, exact. The shipped layer is exact-match on tool results, which is the load-bearing defense against Bloomreach's rate limits. The two unshipped are real dollar levers (prompt caching especially); whether and when to wire them is an open question.

## Structure pass — layers · axes · seams

**Layers:** request → cache check → live call → response → cache write.

**Axis: where does each cache live?** Prompt cache: at the Anthropic API. Semantic cache: in your code, in front of the LLM. Exact tool cache: in your code, in front of the MCP server.

**Seam:** each cache's lookup point. The 60s cache check is at `lib/data-source/bloomreach-data-source.ts:140-145`. The other two have NO lookup point today.

## How it works

### Move 1 — the mental model

You know how CDN caches the *response* and Redis caches *function results*? Same shape applied at different altitudes in the LLM stack. Each cache layer serves a different question.

```
  Three caches, three questions

  Anthropic prompt cache:
   ──────────────────────
   Question: "I sent this same system prompt + tools + schema
              5 minutes ago — can I avoid paying full input cost?"
   Saves:    ~60% of input bill on calls 2+ per session

  Semantic cache:
   ────────────────
   Question: "Someone asked a similar question 10 minutes ago —
              can I return the same answer?"
   Saves:    full LLM call when there's a hit
   Risk:     stale answers when underlying data changed

  Exact-match tool cache (the 60s one shipped here):
   ─────────────────────────────────────────────────
   Question: "I called execute_analytics_eql with these exact
              args 30 seconds ago — can I avoid the rate-limited
              round-trip?"
   Saves:    1 MCP call + rate-limit budget
```

### Move 2 — the step-by-step walkthrough

**Part 1 — the 60s tool-result cache (shipped).**

`BloomreachDataSource.callTool` at `lib/data-source/bloomreach-data-source.ts:131-180`:

```typescript
async callTool<T = unknown>(
  name: string,
  args: Record<string, unknown>,
  options: CallToolOptions = {},
): Promise<CallToolResult<T>> {
  const cacheKey = `${name}:${JSON.stringify(args)}`;
  const ttl = options.cacheTtlMs ?? 60_000;

  if (!options.skipCache) {
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return { result: cached.result as T, durationMs: 0, fromCache: true };
    }
  }

  // ... live call + retry ladder ...

  // Don't cache error results — they should not poison the cache.
  if ((result as any)?.isError === true) {
    return { result: result as T, durationMs, fromCache: false };
  }

  this.cache.set(cacheKey, { result, expiresAt: now + ttl });
  return { result: result as T, durationMs, fromCache: false };
}
```

Five things to notice:

  → **Key** is `${name}:${JSON.stringify(args)}`. Order-sensitive on object keys (depends on Node's JSON serialization being stable, which it is for keys defined in the same order). Same query → same key.
  → **TTL** defaults to 60s, overrideable per-call via `cacheTtlMs`.
  → **Errors not cached** — explicit check at the bottom. A rate-limit failure or transport error doesn't poison the cache.
  → **`skipCache` flag** for the `/debug` "force fresh" path. Note: still writes through to cache on success (line ~170).
  → **`fromCache: true` in the envelope** is surfaced in the UI's tool-call trace (`StatusLog` shows "from cache" tag).

**Part 2 — why 60s.**

Two pressures:

  → **Bloomreach is rate-limited to ~1 req/s per user globally**, with retry windows up to 10s when violated. A 60s cache absorbs the "user reloads the briefing tab" case without any extra MCP traffic.
  → **Anomaly data is slow-moving.** 60s of cache age on a "revenue last 90d" query is acceptable — the underlying numbers don't change minute-to-minute.

The agent loop within a single investigation is rarely cached (the agent typically picks different tools each iteration), but cross-investigation calls within the 60s window (e.g. two users investigating the same anomaly) ARE cached.

**Part 3 — prompt caching (NOT shipped).**

The adapter at `lib/agents/aptkit-adapters.ts:42-52` builds the request *without* `cache_control` markers:

```typescript
const params: Anthropic.Messages.MessageCreateParamsNonStreaming = {
  model: this.defaultModel,
  max_tokens: request.maxTokens ?? 4096,
  messages: request.messages.map(toAnthropicMessage),
};

if (request.system) params.system = request.system;
if (request.tools?.length) params.tools = request.tools.map(toAnthropicTool);
// NOTHING about cache_control.
```

To wire prompt caching, the adapter would mark the static parts (`system` + `tools[]`) with `cache_control: { type: 'ephemeral' }`. Anthropic then caches that prefix and bills cached input tokens at ~10% of normal.

For the monitoring agent's typical 6-call ReAct loop:

  → **Without caching:** ~1700 static input tokens × 6 calls = ~10,200 tokens at full rate.
  → **With caching:** ~1700 tokens at premium rate on call 1, ~1700 tokens at cached rate (~10%) on calls 2-6 = ~3400 effective full-rate tokens.

Savings: ~67% of input bill on monitoring agent runs. Same shape for diagnostic / recommendation / query agents.

The reason it's not wired: it's a real engineering task (mark which prompt parts to cache, manage cache invalidation on prompt changes), and cost is low-volume today. Whenever the cost story tightens, this is the first move.

**Part 4 — semantic cache (NOT shipped).**

Semantic cache would embed each user query (intent classifier or free-form), check if a similar query was answered recently, return the cached answer if close enough. Two requirements:

  1. An embedder (this codebase has none — see `03-retrieval-and-rag/03-rag-concepts-not-yet-exercised.md`).
  2. A storage layer for the embeddings + answers (this codebase has no DB).

The risk semantic cache carries is staleness: a user asks "what's our revenue?" at 9am, the answer is cached, at 9:30am a new anomaly drops, the next user gets the stale 9am answer. Mitigation is short TTL or invalidate-on-new-anomaly. Both are real work.

Not pressing today; named honestly.

### Move 3 — the principle

**Cache at the altitude that matches the question.** The 60s tool cache solves "Bloomreach rate-limited me." The prompt cache would solve "static prompt parts cost full price every call." A semantic cache would solve "users ask the same question." Different altitudes, different payoffs. Don't reach for the wrong one.

## Primary diagram — the full recap

```
  LLM caching in this codebase — shipped + not-shipped

  ┌─ Shipped: 60s tool-result cache ─────────────────────────────┐
  │  Where:   BloomreachDataSource.callTool                       │
  │  Key:     `${tool_name}:${JSON.stringify(args)}`              │
  │  TTL:     60_000 ms                                           │
  │  Skip:    optional via skipCache flag                         │
  │  Errors:  not cached                                          │
  │  Saves:   1 MCP call (~1.1s rate spacing + round-trip)        │
  │  Visible: `fromCache: true` in the call envelope, surfaced    │
  │           in UI tool-call trace                               │
  └──────────────────────────────────────────────────────────────┘

  ┌─ Not shipped: Anthropic prompt caching ──────────────────────┐
  │  Where:   would go in AnthropicModelProviderAdapter.complete()│
  │  Mark:    cache_control: { type: 'ephemeral' } on system +    │
  │           tools[] blocks                                       │
  │  Saves:   ~60-67% of input bill on calls 2+ per agent run     │
  │  Why not: real engineering task; cost is low-volume today      │
  │  Exercise:01-llm-foundations/06-token-economics.md `B1.6`     │
  └──────────────────────────────────────────────────────────────┘

  ┌─ Not shipped: semantic cache ────────────────────────────────┐
  │  Where:   would go in the query path before LLM call          │
  │  Saves:   full LLM call on similar-query hit                  │
  │  Risk:    stale answers when data changed                      │
  │  Why not: requires embedder + storage; neither exist           │
  │  Reference:03-retrieval-and-rag/03-rag-concepts-not-yet-exercised.md│
  └──────────────────────────────────────────────────────────────┘
```

## Elaborate

**Why the 60s cache is inside `BloomreachDataSource`, not in the agent layer.** The cache is a property of the Bloomreach surface — rate-limited per user, slow-moving data, expensive round-trips. Putting it in the DataSource means every consumer (agents, route handlers, tests) benefits without knowing the cache exists. If it lived in the agent layer, each agent would have to know about it, and route handlers (which sometimes hit `dataSource.callTool` directly via `/api/mcp/call`) would bypass it.

The DataSource abstraction is the right altitude.

**Why prompt caching isn't a free lunch.** Three real costs:

  1. **Cache-set premium.** First call carries ~25% extra cost to set up the cache. Worth it only when calls 2+ amortize.
  2. **Cache invalidation discipline.** If you edit the system prompt, the cache invalidates. Each agent prompt edit = first call pays the premium again.
  3. **Engineering surface.** The adapter needs to mark cacheable parts explicitly. That's small code (a few lines per agent) but it's prompt-content-aware code, which means the adapter knows about the prompt structure.

Not insurmountable; all are reasons the priority is "when cost tightens," not "immediately."

**Why semantic cache is structurally complex here.** This codebase doesn't have a corpus to embed *against* — the user's free-form questions don't repeat enough to make embedding worth it for cache deduplication. Semantic cache is more valuable in chat-shaped apps with high query volume; this codebase is investigation-shaped with low repeat rate per query.

## Project exercises

### Exercise — Wire Anthropic prompt caching for the monitoring agent

  → **Exercise ID:** B6.1 (also referenced as B1.6 in `01-llm-foundations/06-token-economics.md`)
  → **What to build:** Add `cache_control: { type: 'ephemeral' }` markers to the static parts of the monitoring agent's request — the system prompt, the schema summary block, and the tool definitions. Extend `AnthropicModelProviderAdapter.complete()` to honor a per-request `cacheableParts` hint that names which parts to mark cacheable. Measure the cache hit rate via `response.usage.cache_read_input_tokens` and `response.usage.cache_creation_input_tokens`.
  → **Why it earns its place:** monitoring is the highest-volume agent (briefing scan runs on every page load when live). Even a 50% cache hit rate cuts the monitoring bill in half. The single biggest dollar lever in the codebase today.
  → **Files to touch:** `lib/agents/aptkit-adapters.ts` (extend `complete()` to support cache markers), `lib/agents/monitoring.ts` (declare which prompt parts are cacheable), `test/agents/aptkit-adapters.test.ts` (assert cache markers land on the SDK request).
  → **Done when:** the per-call usage log shows non-zero `cache_read_input_tokens` after the second monitoring scan in a session, a wallclock measurement shows the second scan cheaper than the first by ~50% on input tokens, and the test suite covers both cache-create and cache-read scenarios.
  → **Estimated effort:** 1–4hr.

## Interview defense

**Q: "What caching do you have on your LLM stack?"**

One layer shipped, two not. The shipped layer is a 60s tool-result cache inside `BloomreachDataSource` — keyed on `${name}:${JSON.stringify(args)}`, errors not cached, optional `skipCache` flag for the debug path. It absorbs "user reloads the briefing tab" without burning a Bloomreach rate-limit slot. The two unshipped: Anthropic prompt caching (the biggest dollar lever — would cut input bills ~60% on calls 2+) and semantic cache (not pressing for an investigation-shaped product).

Prompt caching is `B6.1`; it's the next move when cost tightens.

*Anchor: "60s tool cache shipped; prompt cache is the big lever, not wired; semantic cache not pressing."*

**Q: "Why is the 60s cache inside the DataSource and not in the agent?"**

Because the cache is a property of the *Bloomreach surface*, not the agent. Bloomreach is rate-limited per user globally, the data is slow-moving, and round-trips are expensive (~1.1s spacing + network). Putting the cache in the DataSource means agents, route handlers, even tests all benefit transparently — they call `dataSource.callTool()` and the cache is checked under the hood. If it lived in the agent layer, every consumer would have to know about it, and routes that hit `dataSource.callTool` directly (`/api/mcp/call`) would bypass it.

The seam-extraction PR (Phase 2 PR A) was deliberate about this — the cache moved WITH the data source when it was renamed from `McpClient` to `BloomreachDataSource`.

*Anchor: "Cache is a Bloomreach property → lives in `BloomreachDataSource`. Agent layer doesn't know."*

## See also

  → `02-llm-cost-optimization.md` — the cost-optimization framing this contributes to
  → `04-rate-limiting-backpressure.md` — the rate-limit story the 60s cache defends against
  → `01-llm-foundations/06-token-economics.md` — the cost story the prompt-cache would shift
  → `study-system-design/10-rate-limit-aware-mcp-client.md` — the same logic from the system-design lens
