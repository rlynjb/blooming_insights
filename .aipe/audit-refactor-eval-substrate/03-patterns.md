# Chapter 03 — Patterns

Design patterns are the named, reusable shapes — Strategy, Observer, Adapter, State Machine, Circuit Breaker, and so on — that the catalog catalogues. Reaching for one when it doesn't fit is the classic over-engineering trap; missing one when it does fit is the classic under-engineering trap. This codebase is more often the latter than the former, but only just barely. The discipline visible across the four agent classes and the `McpClient` is "reach for a pattern only when the pattern carries weight"; the gap is in two places where the pattern would carry weight and hasn't been reached for.

## Map of the territory

- **DEEP — Observer / Probe (the `res.usage` non-read and the absent phase-timing instrumentation).** The cost meter that doesn't exist; the cheapest fix in the codebase for the most consequential blind spot.
- **DEEP — Strategy (four agents on `runAgentLoop` as the existing Strategy; `synthesize()` as the missing recovery strategy on the same axis).** Names what's already there, opines on what should join it.
- **BRIEF — Circuit Breaker (`McpClient` has TTL + spacing + retry; the breaker is the missing element).** Named in two audits (`study-system-design/audit.md` Ceiling 2, `study-performance-engineering/audit.md` finding #3); ~50 LOC; not gated by evals but blocked by no measurement to know it didn't change behavior unintentionally.
- **BRIEF — Adapter (`McpCaller` interface as the seam between `runAgentLoop` and `McpClient`).** Already done well; named for the pattern it instantiates so future readers recognize it.
- **MENTION** — State Machine (the agent loop's two-state `forceFinal` is correctly a conditional, not a state machine — Chapter 01 covers this).
- **MENTION** — Decorator (no instance; not worth retrofitting onto the truncate / spacing / cache stack that already lives inside `McpClient`).
- **MENTION** — Factory (the four agent classes' near-identical constructor is a candidate; trivial; covered briefly under "Pull complexity downward" in Chapter 05).
- **NOT FOUND** — Visitor, Composite, Chain of Responsibility, Memento, Builder. None of these fit the codebase's shape. The agent loop is not a parse tree; the events are not a hierarchy; the recovery is not a chain.

---

### Observer / Probe — the cost meter that doesn't exist (DEEP)

**Where it shows up.** Four Anthropic call sites, each one returning a `res.usage` object that nobody reads:

- `lib/agents/base.ts:102` — the main loop, called once per turn × maxTurns × 4 agents per investigation.
- `lib/agents/diagnostic.ts:97` — the synthesize recovery call.
- `lib/agents/recommendation.ts:96` — the synthesize recovery call.
- `lib/agents/intent.ts:18` — the cheap haiku classifier on every free-form query.

Every one of these `await anthropic.messages.create(...)` calls returns `{ content, usage: { input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens }, ... }`. The `usage` field is the canonical "what did this call cost" signal from the SDK. **The codebase reads `res.content` and silently discards `res.usage` at every site.** The performance audit (`study-performance-engineering/audit.md:22, 111, 131`) names this as "the cheapest fix in the codebase for the most consequential blind spot — cost concentration is unmeasured because of this gap."

Same story on the latency side. `app/api/agent/route.ts:20` says `maxDuration = 300` with a comment ("A live investigation runs ~100-115s"). That "~100-115s" is the only baseline in the entire codebase, and it's a comment, not a measurement. There's no `performance.now()` pair around schema bootstrap, no timing on the coverage gate, no per-agent phase timing. The audit (`study-system-design/audit.md`, Top-3 finding #2) names this as "the next production incident will not be diagnosable" and prescribes the fix as `const t0 = performance.now()` pairs around the three phases.

**Why it's like this.** The cost meter wasn't built because nobody was paying for the calls yet — it's a personal Anthropic key, the volume is low, and the absent number didn't have a cost until it did. The phase timer wasn't built because the production-incident hasn't happened yet — it's the canonical "add this before the first incident" finding that doesn't get added until after the first incident, because the first incident is the moment the cost of NOT having it becomes visible. This is the classic shape of observability gaps: they're never the urgent thing until they're suddenly the most-urgent thing.

**Take.** Observe-as-Probe is the pattern here, and it's exactly the shape this codebase needs. The catalog calls it Probe (one-line emit at the seam, no behavior change, fans out to whatever consumes it); the language-specific name in the SDK world is "callback" or "middleware." The lift is:

1. **Five console.log lines for cost.** Per the perf audit's Top-3 finding #1: at each of the four Anthropic call sites, after the `await`, add `console.log('[anthropic.usage]', { agent, model, ...res.usage })`. ~5 LOC total. Read it in Vercel logs (the only persistent observability surface this app has today). This is the smallest possible expression of the pattern and it answers the cost-concentration question on the next investigation that runs.

2. **Twenty LOC for phase timing.** Per the system-design audit's Top-3 finding #2: `const t0 = performance.now()` pairs around schema bootstrap (`app/api/agent/route.ts:202`), coverage gate (in `app/api/briefing/route.ts`), each agent run (`:238`, `:247`). Emit `console.log({ route, phase, durationMs, sessionId, complete })` on `done`. ~20 LOC total. Makes the next production incident actually diagnosable instead of blind.

3. **One callback on `runAgentLoop`.** Add `onUsage?: (usage: ResUsage, ctx: { agent, turn, model }) => void` to the options bag. The loop calls it after every Anthropic response. Today the callback writes to `console.log`; tomorrow it writes to the NDJSON trace (so the eval harness can score cost as well as quality); the day after it writes to a real observability backend (Datadog, OTel). The seam is one option; the implementations rotate behind it.

The reason this lands in the Pattern chapter and not Chapter 01 (Composition) is that the lift is naming a missing seam, not extracting a function. Today the cost data is silently discarded; the refactor is to install a probe at the seam where the data already exists. That's a pattern-level change, not a composition-level one.

**The tradeoff.** Cost of doing it: ~30 LOC across three changes. The smallest of those changes (the 5-line cost log) requires zero discussion. Cost of NOT doing it: every cost-and-performance question in the book is unmeasured, which means every other refactor in this book that touches cost or latency (synthesize lift in Chapter 01, circuit breaker below, prompt-prefix caching, tightening maxToolCalls) ships without an A/B comparison.

The breakpoint where the cost flips: the moment the engineer can no longer answer "what did this investigation cost?" in interview voice. That moment is now. Per the recon (`.aipe/audits/recon-2026-06-02.md:148-150`): the resume reads as "production AI engineer" and the cost question's honest answer today is "I don't know."

**What I'd watch for.** Three specific traps:

1. **Don't add the callback before the console.log.** The five-line console.log lands the data in Vercel logs today; the callback is the upgrade path. Reverse the order and you build the seam without any consumer, which is the textbook "extracted abstraction with one implementation" smell. Build the consumer first; refactor to the seam when there's a second implementation.

2. **Don't measure what you can't act on.** `res.usage.cache_creation_input_tokens` and `cache_read_input_tokens` only matter if you're using Anthropic prompt caching, which this codebase doesn't (yet) — see the perf audit finding #4. Log them anyway (cheap), but don't act on them until prompt caching is enabled.

3. **The `intent.ts` classifier is the cheapest call by 50x but the most frequent.** Per query is one haiku call, max_tokens=16. The cost line is dominated by `synthesize()` (long structured JSON output) per investigation. The cost log will make this immediately obvious — and the action it surfaces is "tighten maxToolCalls to reduce synthesis frequency" or "shrink the synthesis JSON schema," NOT "swap haiku for something cheaper" (already the cheapest).

**Verdict.** **Worth doing immediately.** The five-line cost log is the cheapest fix in the codebase for the most consequential blind spot — that's the perf audit's verdict and I agree. The 20-line phase timer is the second-cheapest fix. The callback refactor is the unlock for the eval harness to also score cost (Chapter 02's eval module reaches for this seam). Land all three in one PR; the receipts are small and the unblocks are large.

---

### Strategy — four agents on `runAgentLoop`; `synthesize()` as the missing recovery strategy on the same axis (DEEP)

**Where it shows up.** Already present and well-applied at the top:

- `MonitoringAgent.scan` (`lib/agents/monitoring.ts:69-120`)
- `DiagnosticAgent.investigate` (`lib/agents/diagnostic.ts:45-83`)
- `RecommendationAgent.propose` (`lib/agents/recommendation.ts:36-77`)
- `QueryAgent.answer` (`lib/agents/query.ts`)

Each is a different *strategy* on the same algorithm (`runAgentLoop`). The loop is the algorithm; the per-agent (system, userPrompt, toolSchemas, maxToolCalls, synthesisInstruction, parse/validate) is the strategy. Zero duplication of the loop body across the four agents. **This IS Strategy, and it's textbook.** The audit (`study-software-design/audit.md`) names `runAgentLoop` as the second-deepest module for exactly this reason.

What isn't present: a Strategy on the recovery axis. Today `DiagnosticAgent` and `RecommendationAgent` each own a `synthesize()` method outside the loop (covered in Chapter 01 under Extract Function). The synthesis call is a *recovery strategy* — the thing you do when the loop's natural end produced unparseable output. The recovery strategy is per-agent (different prompt, different output shape, different max_tokens), and today each agent encodes its own recovery in a private method.

**Why it's like this.** The Strategy on the per-agent axis emerged early — the moment a second agent existed, the loop was the obvious shared abstraction. The Strategy on the recovery axis hasn't emerged because there are only two agents that need recovery (the two whose output is structured JSON), and the duplication of `synthesize()` was tolerable when it was 1 instance and barely worth refactoring at 2 instances.

**Take.** Lift `synthesize()` into `runAgentLoop` as a Strategy parameter on the recovery axis. The Chapter 01 Extract Function move is "add `recoveryPrompt` + `parseResult` options to the loop." This chapter restates the same lift in pattern terms: the loop becomes the *Template Method* (fixed algorithm), and the per-agent options are *Strategy* objects on three axes — per-call setup (system, userPrompt, toolSchemas), per-call termination (maxToolCalls, synthesisInstruction), and per-call recovery (`parseResult`, `recoveryPrompt`).

Naming the pattern matters because it makes the next addition obvious. The day someone wants to add `QueryAgent` recovery (when free-form queries start returning unparseable text), the move is "add a `recoveryPrompt` to QueryAgent" — and that's exactly the same shape as the existing per-agent setup options. The pattern lives at the level of the loop's options bag; the agents are clients of the loop's Strategy contract.

**The tradeoff.** Same as Chapter 01's Extract Function tradeoff: the loop's options bag grows from 11 fields to 13. The cost is interface size on the load-bearing function; the benefit is the recovery axis becomes named and reusable. The trade-off flips toward "do it" the moment a third agent needs recovery; today it's at the edge.

**What I'd watch for.** The trap is calling this lift "Template Method" and then writing the loop as an abstract class with hooks. The catalog distinguishes Template Method (inheritance-based) from Strategy (composition-based) — the right shape here is Strategy, because the agents already exist as composable objects and the loop is already a free function. Don't introduce inheritance to name a pattern you're already implementing via composition.

The other watch: don't try to lift the entire `synthesize()` body into the loop. The body is *agent-specific* (the evidence-serialization shape, the JSON output schema). Only the *control flow* lifts — "if parse failed, run one tool-less turn with this prompt, then parse again." The body is the agent's responsibility; the orchestration is the loop's.

**Verdict.** Worth doing. The Strategy is half-there already; completing it costs little and clarifies the shape for future readers. As with Chapter 01, the lift is behavior-preserving and the eval harness is the gate that lets you ship it with evidence.

---

### Circuit Breaker — the missing element in the McpClient retry stack (BRIEF)

**Where it shows up.** `lib/mcp/client.ts:121-132` has the retry loop: parse the rate-limit hint, sleep `hint + 500ms` or fall back to exponential backoff, retry up to `maxRetries=3`, each wait capped at `retryCeilingMs=20s`. Per the system-design audit (`study-system-design/audit.md` finding #2): if Bloomreach is fully down for 5 minutes, every concurrent request burns 3 retries × ~12s = ~36s before failing. Fine at 1 user, costly at 10+. The pattern recognized in `study-system-design/audit.md` and `study-ai-engineering/06-production-serving/05-retry-circuit-breaker.md`; ~50 LOC in `McpClient`; not landed.

**Take.** This is the textbook Circuit Breaker. Add three fields to `McpClient`: `consecutive5xx: Map<toolName, number>`, `openUntil: Map<toolName, number>`, `breakerThreshold = 5`, `breakerWindowMs = 30_000`. On each `liveCall`: if `openUntil[name] > now`, throw `McpToolError(name, 'circuit open')` immediately (no retry, no spacing wait). On rate-limit-retry-exhausted or 5xx: increment `consecutive5xx[name]`; if it hits 5, set `openUntil[name] = now + 30_000`. On success: reset `consecutive5xx[name] = 0`. ~50 LOC inside the existing class; no external dep.

This isn't gated by the eval harness — Circuit Breaker is a behavior-preserving safety mechanism on the failure path, and the existing test pattern (scripted-Anthropic + faked `McpTransport`) covers it without any quality measurement. The reason it lands as BRIEF and not DEEP: the audit already named it, the fix is mechanical, and there's no interesting tradeoff to walk through ("do you really want a breaker?" — yes, obviously, once you have >1 concurrent user). **Verdict: worth doing; the audit's prescription is correct; ship it.**

---

### Adapter — the McpCaller interface as the seam between runAgentLoop and McpClient (BRIEF)

**Where it shows up.** `lib/agents/base.ts:16-22`:

```
export interface McpCaller {
  callTool(name, args, opts?): Promise<{ result, durationMs, fromCache }>;
}
```

One method, hides whether the implementation is `McpClient` (with cache + spacing + retry) or a test fake (with a queued response list). `McpClient` structurally satisfies the interface; tests pass a fake; the loop never knows the difference.

**Take.** Name this for the pattern it instantiates: this is Adapter (or Port-Adapter, depending on which catalog you're reading from), and it's textbook. The lib layer's DI discipline runs on this seam, the scripted-Anthropic harness pattern that 31 tests rely on runs on this seam, and the eval harness's "real Anthropic + fake McpClient" mode (for testing what the diagnostic agent does when MCP returns specific shapes) will run on this seam. **The pattern is the load-bearing primitive that makes the lib layer testable.** No refactor needed; calling it out by name so future readers recognize it for what it is.

The one improvement I'd suggest: rename `McpCaller` to `McpAdapter` (or leave `McpCaller` and add a one-line comment naming the pattern). Rename only if it goes in with another refactor on the file; not worth a dedicated PR.

**Verdict.** Don't change it. Name it for what it is in comments or in a successor refactor. The pattern is the strength.

---

## Chapter close

The pattern chapter is short on purpose. This codebase has been disciplined about not reaching for patterns it doesn't need (no Visitor, no Composite, no over-engineered State Machine, no Decorator stack), and the patterns it does reach for it applies well (Strategy across the four agents, Adapter at McpCaller, Deep Module on McpClient). The chapter's verdict is two-sided: **the patterns present are well-chosen, and the two patterns missing are both about observability** — the cost meter (Observer/Probe) and the eval harness (which is itself a discovered architectural pattern, covered in Chapter 02). Same root cause, two names.

The chapter's specific load-bearing pattern recommendation is the Probe: 30 LOC across three changes, ships immediately, unblocks every cost-and-performance question in the book. The Circuit Breaker is a second pattern that the audits have already converged on and that the codebase needs — ship it when the concurrency story changes from "1 user demo" to "5+ concurrent users." Don't ship it speculatively; the failure mode it prevents isn't fired yet at current scale.

The deeper observation: the patterns this codebase is *missing* are both observability patterns, and observability is the same axis as the eval gap (different layer, same gap). The eval harness is an observability pattern on the quality axis; the cost meter is an observability pattern on the cost axis; the phase timer is an observability pattern on the latency axis. **The codebase has been disciplined about correctness and architecture, and underweight on the patterns that let you see what's actually happening inside what you built.** That's the chapter's one-sentence verdict, and it's the same verdict the through-line of this book carries.
