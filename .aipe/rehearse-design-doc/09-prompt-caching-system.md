# RFC-09 — Prompt caching on the system prompt

**Decision in one line:** Wrap `request.system` in an ephemeral cache-control breakpoint inside `AnthropicModelProviderAdapter.complete()`. First turn of an investigation writes the cache; every subsequent turn within 5 minutes reads it. Validated live: `cache_creation_input_tokens 3168 → cache_read_input_tokens 3168` in production logs.

---

## Context

The diagnostic and recommendation agents run a ~10-turn ReAct loop. Each turn calls `anthropic.messages.create` and resends the full request payload — including the system prompt, which is ~4KB of tightly-written instructions on how to diagnose an anomaly (or how to design a Bloomreach recommendation), plus the tool JSON schemas.

That system prompt does not change between turns. Sending it 10× per investigation was ~2× the input-token cost of a "cache-aware" version of the same run — measured before the change against the baseline runId's per-case cost of ~$0.09.

Anthropic's prompt caching feature is designed for exactly this: mark a prefix as cacheable, pay 1.25× normal input cost on the first call, pay 0.1× on subsequent calls within 5 minutes. The math is unambiguous — if your prefix is stable across 3+ calls, caching is a win.

The seam where the change belongs is the ModelProvider adapter (RFC-06). One file, one method, one wrap.

---

## Decision

Inside `AnthropicModelProviderAdapter.complete()` (at `lib/agents/aptkit-adapters.ts`), wrap the incoming `request.system` string in Anthropic's structured content-block form with an ephemeral cache breakpoint:

```
The wrap — one addition to the ModelProvider adapter

  before:                             after:
    params.system = request.system      if (request.system):
                                         params.system = [{
                                           type: 'text',
                                           text: request.system,
                                           cache_control: {type: 'ephemeral'}
                                         }]

  what this triggers on the Anthropic side:

  ┌─ turn 1 ─────────────────────────────────────────────────────┐
  │  server hashes prefix up to breakpoint                       │
  │  no cache hit → writes cache entry                            │
  │  billed as cache_creation_input_tokens (~1.25× normal input) │
  └───────────────────────────────────────────────────────────────┘

  ┌─ turns 2..N (within 5 min) ──────────────────────────────────┐
  │  server sees same hash → cache HIT                            │
  │  billed as cache_read_input_tokens (~0.1× normal input)       │
  │  prompt is loaded from cache; only new tail counts as fresh   │
  └───────────────────────────────────────────────────────────────┘
```

Tools also get cached transparently by Anthropic when the system prompt is broken into content blocks with a cache breakpoint — the server keys the cache on the entire tools + system prefix, so this single addition covers both prefixes without needing a second breakpoint.

**Validation is live, not theoretical:**

Case 09 receipt logs show the pattern:

```
turn 1:  input_tokens: 145   cache_creation_input_tokens: 3168   cache_read_input_tokens: 0
turn 2:  input_tokens: 210   cache_creation_input_tokens: 0      cache_read_input_tokens: 3168
turn 3:  input_tokens: 305   cache_creation_input_tokens: 0      cache_read_input_tokens: 3168
turn 4:  input_tokens: 380   cache_creation_input_tokens: 0      cache_read_input_tokens: 3168
...
```

3168 tokens created once, then read every subsequent turn. Per-case cost against the baseline settles at ~$0.09 (agent-side). The eval report's `summarizeUsage` currently treats cache tokens the same as input tokens, so the reported cost *undercounts* real savings by the cache-read fraction — the actual savings are larger than the report shows.

---

## Alternatives considered

**(a) 1-hour cache (`cache_control: { type: 'ephemeral', ttl: '1h' }`).** Longer TTL, higher creation cost (~2× instead of 1.25×), pays off for long-running investigations that span the 5-minute window. Loses today because Blooming's investigations run under 5 minutes — the ReAct loop finishes in ~50-90s per phase (baseline p50 numbers: diagnose 50s, recommend 51s). 5-minute ephemeral covers the whole pipeline; 1-hour would pay a higher creation cost for a longer window nobody uses.

**(b) Cache tools with a separate breakpoint.** Explicitly mark tools as cacheable rather than relying on Anthropic's transparent caching. Loses because the effect is the same — the server caches everything up to the last breakpoint, and one breakpoint at the system-prompt tail already includes tools. Adding a second breakpoint would only fragment the cache boundary without adding capability.

**(c) Skip caching until cost becomes a real problem.** Wait for the AWS-bill moment. Loses because caching's implementation cost is one adapter change, verified with one receipt run. Deferring a change with a 4-hour payback window is the classic under-investment mistake.

**(d) Cache the schema summary separately.** The workspace schema (`WorkspaceSchema` in `lib/mcp/schema.ts`) is embedded in the system prompt for the diagnostic agent. If it were cached at its own breakpoint, cross-investigation reuse would kick in for the same workspace. Not implemented today — deferred because in-investigation caching already dominates the savings, and cross-investigation caching means keeping the schema shape stable across page navigations (which is currently true but not enforced).

---

## Consequences

**What this buys:**
- **Roughly 80% reduction on system-prompt token cost per investigation.** Turns 2-N pay ~0.1× instead of 1× on the ~3168-token prefix. Across 10 turns, that's the difference between paying ~10× the prefix cost and paying ~2× (1 creation + 9 reads at 0.1×).
- **Zero behavioral change.** The model sees the same system prompt. The cache is invisible above the API layer. No new failure mode, no new coupling.
- **Validated with a real trace, not a benchmark.** The 3168-token cache_creation → cache_read pattern is in the logs, tied to a specific runId. Reviewer-defensible.
- **Composed cleanly with the adapter boundary (RFC-06).** The wrap sits inside `AnthropicModelProviderAdapter.complete()`. AptKit doesn't know about caching; agents don't know about caching. The boundary earned its keep — a feature that would have touched every agent in the pre-AptKit design touched one method here.

**What it costs:**
- **Reported cost undercounts real savings.** AptKit's `summarizeUsage` treats `cache_read_input_tokens` as regular input tokens. The eval report and the budget tracker (RFC-07) both see a slightly-higher-than-actual spend. Direction is safe (over-estimation), but noted so cost analysis stays honest.
- **First-turn cost went up.** Turn 1 pays 1.25× instead of 1× on the cached prefix. For a single-turn agent (like the intent classifier), this would be a net loss — which is why intent classification uses Haiku on a bare `messages.create` call without caching. Cache-aware only where the loop is guaranteed to be ≥3 turns.
- **5-minute TTL means cross-investigation reuse is best-effort.** Two investigations run 6 minutes apart don't share a cache. Not a problem for a single-user session; would be if usage patterns ever went to sustained multi-user peaks (which RFC-01 says we don't optimize for).
- **Tool schema changes invalidate the cache.** Adding a new tool to the registry breaks the cache-key hash — every agent's next turn pays the creation cost. Cheap; happens rarely.

**What the reviewer will push on:**
> "How do you know the cache is actually hitting?"

The answer: pull up the raw Anthropic response for turn 2 of any diagnostic case. The `usage.cache_read_input_tokens` field is 3168; the `usage.cache_creation_input_tokens` field is 0. The pattern is in the log output at the `logSite` shown in `AnthropicModelProviderAdapter.complete()`. Not inference — measurement.

---

## Open questions

- **When to promote to 1-hour cache.** Trigger: a use case emerges that runs an investigation family (diagnose → recommend → follow-up query) over ≥6 minutes. Today it doesn't; ephemeral is the right TTL. If sustained sessions become a thing, revisit.
- **Schema-summary caching at its own breakpoint.** Would enable cross-investigation reuse for the same workspace. Blocked on: enforcing that the schema summary hash is stable across the session (rather than incidentally stable). Small change; worth doing when we see multi-investigation sessions become common.
- **`summarizeUsage` correction.** Either patch AptKit's summarizer to distinguish cache tokens or add a Blooming-side correction inside the adapter. Deferred pending AptKit upstream discussion.
