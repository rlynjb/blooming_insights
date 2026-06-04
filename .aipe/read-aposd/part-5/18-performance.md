# Chapter 18 — Designing for performance

## Opener

Chapter 17 said principles over fashion. Chapter 18 takes the same skeptical eye to performance. Most "performance optimization" in working systems doesn't measurably make things faster; it makes the code harder to read and harder to change, in service of a slowdown that wasn't actually a problem.

## The idea

**Clean design is usually fast enough.** Two corollaries:

1. **Measure before optimizing.** You don't know what's slow until you've measured. Engineers' intuitions about performance are wrong more often than they're right, especially in systems with I/O, allocation, JIT compilation, or async — almost everything modern.
2. **When you do optimize, optimize the critical path, not everywhere.** The system has a hot path that dominates total latency or cost; design *that* carefully. The rest of the code can stay simple.

The mistake the book is warning against isn't "optimization is bad" — it's *premature, untargeted, complexity-introducing* optimization. Replacing a clear `arr.map().filter()` with a fused for-loop and an early break is faster, theoretically, by some number of microseconds that no one's user will ever notice — and it's now harder to read, harder to change, and likely buggier. Trading readability for unmeasured performance is one of the worst trades in software.

## How it works

A picture of where effort goes in each case:

```
  Whole-system micro-tuning vs hot-path focus

  ┌─ MICRO-TUNED EVERYWHERE (wasted effort) ─────────────────────────┐
  │                                                                   │
  │   layer 1 [optimized for ns]    contributes 0.001% of latency     │
  │   layer 2 [optimized for ns]    contributes 0.01%  of latency     │
  │   layer 3 [optimized for ns]    contributes 0.1%   of latency     │
  │   layer 4 [stays simple]        contributes 99.8%  of latency     │
  │                                                                   │
  │   total: 99.8% of the latency wasn't optimized; 100% of the code  │
  │   is harder to read. effort/payoff ratio approaches zero.         │
  └───────────────────────────────────────────────────────────────────┘


  ┌─ HOT-PATH FOCUS (the right shape) ───────────────────────────────┐
  │                                                                   │
  │   layer 1 [stays simple]        contributes 0.001% of latency     │
  │   layer 2 [stays simple]        contributes 0.01%  of latency     │
  │   layer 3 [stays simple]        contributes 0.1%   of latency     │
  │   layer 4 [carefully designed]  contributes 99.8%  of latency     │
  │                                                                   │
  │   total: the part that mattered is fast; the part that didn't is  │
  │   readable. effort/payoff ratio is honest.                        │
  └───────────────────────────────────────────────────────────────────┘
```

The discipline is figuring out which layer is the hot path *before* spending effort. That's what measurement is for. Without measurement, every engineer is guessing — and the guesses are usually wrong, because the system's actual hot path is rarely where the engineer's attention is.

## Why it cuts complexity

The chapter is the inverse of complexity reduction: it argues for *not adding* complexity in pursuit of unmeasured speed. Every micro-optimization is a small dependency (the caller now depends on the specific shape of the optimization) and a small obscurity (the *reason* for the weird construction is no longer obvious). Multiplied across a codebase, those costs are substantial. Avoiding them — by keeping the non-hot-path code clean — is complexity reduction by *not creating it in the first place.* The cause attacked is obscurity (no surprising constructions where simple ones would do) and dependency (no fragile coupling between layers that the optimization introduced).

The cost worth naming: occasionally, when the hot path *is* identified by measurement, the optimization there will require introducing complexity. That's fine — pay the cost knowingly, in one named place, with comments explaining the why. The trade is asymmetric: one carefully-named hot spot vs everywhere-tuned chaos.

## In your code

The running example earns its rent one last time, in a particularly clean way.

**`parseAgentJson` performance is irrelevant — and that's the lesson.** The function is called *once per agent turn*. There are at most ~8 turns per agent, ~4 agents per investigation. That's at most 32 calls per investigation, each on a string of <100KB. The function does a regex match (microseconds) and 1-2 `JSON.parse` calls (microseconds). Total time spent in `parseAgentJson` across an entire investigation: well under 1ms.

Now look at what else happens in the same investigation:

- 32 `anthropic.messages.create` calls. Each is a network round-trip to Claude with a synthesis turn that can take 5-30 seconds. Total: ~30-120 seconds.
- ~6 `mcp.callTool` calls. Each is a network round-trip to Bloomreach with a 1 req/s rate limit (`McpClient.minIntervalMs = 200`). Total: ~6 seconds in the best case, ~60s if rate-limited.

The LLM calls and the MCP calls dominate `parseAgentJson` by **four to five orders of magnitude**. Optimizing `parseAgentJson` is exactly the wrong move: even a hypothetical 10× speedup of the parser saves <1ms out of 60+ seconds — invisible to the user, invisible on the dashboards, paid for in worse code. The chapter's point in one sentence.

**Where this codebase *does* invest in performance — the critical path.** Three places.

1. **`McpClient` caching, rate-limit retry, and rate-limit *pacing*.** `lib/mcp/client.ts` is one of the more carefully designed files in the repo. Why? Because MCP calls are on the hot path (60+ seconds per investigation if you don't manage them) and they have hard limits (~1 req/s, observed 10s penalty window). The complexity in `McpClient` is justified by measurement: this is where the time goes; this is where attention belongs.
2. **The `maxToolCalls` budget.** `lib/agents/monitoring.ts:101` caps the monitoring agent at 6 tool calls. That's a *latency* cap: at 1 req/s, 6 calls is the maximum the agent can make and still leave time for synthesis within the 300s route budget. The cap is in the hot path; the rest of the code is unaffected.
3. **The forced-final-turn synthesis trick.** `lib/agents/base.ts:91`. Forcing the model to produce a final answer (by omitting tools on the last turn) bounds latency — the model can't keep "thinking" past its budget. This is the chapter's principle perfectly: the hot path (model loop latency) got a careful design move; the rest of the loop stayed simple.

**The recon audit's performance findings, in this light.** From `.aipe/audits/`, the performance-related findings focus on observability (`res.usage` logging missing — finding #2) and per-phase timing (finding #6), not on micro-optimizing parse loops or hash lookups. That's the chapter's discipline applied to the audit itself: don't ask "is the code fast?" — ask "do we know *where the time goes?*" The answer in this codebase is "not yet, instrumentation is the fix-now item." That's the right question.

## The red flag

**Sacrificing clarity to optimize code that isn't on the critical path.** Spot it by asking: *what measurement said this was slow?* If the answer is "I just thought it would be faster" or "the original looked slow," the optimization is unjustified. The fix is to put the simple version back and add measurement; *if* the measurement says the code is hot, *then* re-optimize. Related flag: **a comment saying "this is faster than the obvious version" with no benchmark linked.** Without numbers, that's the author's intuition, and intuitions about performance are usually wrong.

## Carry forward

Chapter 18 said clean design plus measurement plus hot-path focus. Chapter 19 closes the book by collecting every red flag from chapters 1-18 into a single one-screen checklist — the working engineer's review tool.

**See also:**
- `lib/mcp/client.ts:79-95` — the hot-path investment justified.
- `lib/agents/base.ts:91` — the forced-final-turn synthesis as a latency-bound mechanism.
- `audits/cleanup-2026-06-02.md` finding #2 — the *measurement* gap is the fix-now, not premature optimization.
- `.aipe/study-performance-engineering/` — this codebase's full performance audit, written in the same discipline.
