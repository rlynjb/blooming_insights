# Chapter 04 — DSA

DSA-shaped refactors are the moves that name a *data structure* or *complexity* problem — wrong container, quadratic where linear is possible, missing index, traversal that should be a lookup. The chapter's job for the feed page is honest: there are no DSA problems here that matter. The page is event-driven state accumulation — list appends, last-element-replace, single-field set. The 15 useState slots are an SRP problem (Chapter 05), not a DSA problem. The data structures the page reaches for are correct; the complexity is fine at the scale the page actually runs at. The chapter is short and tells the truth.

## Map of the territory

- **BRIEF — Replace Data Structure (the trace-items array's last-running-tool replace).** Currently O(n) linear scan; correct at ~30 items; would be a Map<toolName, RunningTool[]> at ~1000 items. The codebase will not reach that scale.
- **MENTION** — Replace Data Structure on the coverage dedup (`prev.some(...)` check before push). O(n) per insert at 10 categories is correct.
- **MENTION** — Replace Data Structure on the insights array. Plain array, mapped over in JSX. Correct shape.
- **NOT FOUND** — Graph traversal, priority queue, tree traversal, DP, memoization, hashing, indexed lookup, binary search. The page exercises none of these.

---

### Replace Data Structure — the trace-items last-running-tool replace (BRIEF)

**Where it shows up.** `page.tsx:368-385`. When the stream emits a `tool_call_end` event, the handler scans the trace items in reverse to find the last `tool` item with the matching `toolName` and `status === 'running'`, then updates it in place:

```
The current shape — O(n) reverse scan

  case 'tool_call_end':
    setTraceItems((prev) => {
      const next = [...prev]
      for (let i = next.length - 1; i >= 0; i--) {
        const it = next[i]
        if (it.kind === 'tool' && it.toolName === evt.toolName && it.status === 'running') {
          next[i] = { ...it, status: 'done', durationMs: ..., result: ..., error: ... }
          break
        }
      }
      return next
    })
```

The same shape lives in `useInvestigation.ts:86-95` (extracted into a named `replaceRunningTool` helper inside the hook). The feed page inlines it; the hook factors it out. Same algorithm, two homes.

**Take.** Today the trace-items array maxes at ~30 items per briefing (one `tool_call_start` + one `reasoning_step` per tool call, ~6 tool calls per agent run, ~3 agent runs per briefing in dev capture). The O(n) reverse scan is correct at this scale — 30 iterations on the slowest mutation is well under a frame budget. Replace-with-Map would be `Map<toolName, RunningTool[]>` with a queue per tool name, which is a more complex data structure for a tiny array.

Don't replace the data structure. Do extract the helper. The `replaceRunningTool` function already exists in `useInvestigation.ts`; the feed page should share it. When `useBriefingStream` extracts, the helper consolidates into one place — same shape as the NDJSON parser consolidation (Chapter 02). The DSA observation is a non-finding; the structural observation (shared helper) is a re-finding of Chapter 02's pattern.

**The tradeoff.** Cost of replacing with a Map: more state per trace item, more reads/writes per event, harder to render in JSX (you'd Map.values() instead of mapping over the array). Cost of keeping the array: O(n) on each tool_call_end at n=30. The trade favors keeping the array indefinitely; the page's data-structure choice is correct.

**What I'd watch for.** The shape that WOULD warrant a Map is parallel tool calls — if the codebase ever emits multiple `tool_call_start` events with the same toolName concurrently (today it doesn't; the agent loop is sequential per agent), the reverse scan would match the wrong running call. That's a correctness boundary, not a complexity boundary. If the agent loop ever goes concurrent, the data structure changes for correctness reasons, not performance reasons. Don't preempt; watch.

**Verdict.** Not worth changing the data structure. Worth extracting the `replaceRunningTool` helper when `useBriefingStream` lifts — same session, same commit. The DSA framing is a non-finding; the helper-extraction is a Chapter 02 follow-on.

---

### Mentions

- **Coverage dedup check.** `page.tsx:335-337` does `setCoverage((prev) => prev.some((c) => c.category === evt.item.category) ? prev : [...prev, evt.item])`. O(n) `some()` on each `coverage_item` event; n is bounded at 10 (the category count is fixed in the schema). Replace with Set: not worth it; n=10 is a single linear scan. Keep the array.

- **Insights array.** `insights: Insight[]` is read by `insights.map(...)` in JSX (L706). Plain array, correct shape, no lookup-by-id needed. If the JSX ever needed insight-by-id lookup (it doesn't), a Map keyed by id would be the move. Today: nothing to do.

---

## Chapter close

The DSA chapter for the feed page is short because the feed page is not a DSA problem. The state is event-accumulation, the events arrive in order, the consumers (JSX) iterate in order. There's no traversal, no search, no priority decision, no graph, no tree. The 15 useState slots are a symptom of one concern doing the work of eight — an SRP problem rated DEEP in Chapter 05, not a data-structure problem.

What this chapter does worth keeping: it names what the page DOESN'T exercise. No graph traversal, no priority queue, no BST. The reader's DSA portfolio (the IK curriculum, the `reincodes` repo) is rich; it doesn't show up here because this app doesn't need it. The agents need rate-limit math (`McpClient.parseRetryAfterMs`), and the feed page consumes a stream of events. Both are correct DSA-light shapes for what they do.

The honest non-finding is the take: **don't invent DSA problems where none exist.** The page-decomposition refactor is structural, not algorithmic. If a reader returns to this chapter looking for a DSA lever to pull, the chapter's answer is "the lever isn't here; check Chapter 02 for the structural lever or Chapter 05 for the principle one." Honest naming beats inventing.
