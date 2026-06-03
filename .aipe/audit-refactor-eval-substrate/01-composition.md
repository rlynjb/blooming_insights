# Chapter 01 — Composition

Composition refactors are the smallest-grain moves: extracting functions, renaming, moving code around, replacing a conditional with a polymorphic call, inlining a too-thin abstraction. They're the techniques you can apply in an afternoon and the ones reviewers most often dismiss as "polish." In this codebase they aren't polish — they're the place where the missing eval harness is most visible, because every composition fix is a behavior-preserving move, and "preserving behavior" is exactly the property you cannot verify here.

## Map of the territory

- **DEEP — Extract Function (lift `synthesize()` into `runAgentLoop`).** Two copies of the same recovery shape; the cleanest refactor in the book.
- **DEEP — Replace Conditional with Polymorphism (`forceFinal` branch in the loop).** The branch is fine as a branch today; it becomes a Strategy seam if Chapter 03's recovery-as-strategy lift lands.
- **DEEP — Inline Function (`tryParseDiagnosis` / `tryParseRecommendations` near-twins).** Two trivial wrappers around `parseAgentJson + isX`. Cross-cuts with Chapter 02's case for `parseAndValidate<T>(text, guard)`.
- **BRIEF — Extract Variable (synthesis-instruction boilerplate).** Same prefix + closer in four agent files; the middle clause is role-specific.
- **BRIEF — Rename (`r` / `cp` in `lib/insights/derive.ts`).** Two outliers in an otherwise precise-naming codebase.
- **MENTION** — Extract Function on the field-truncation helper `trunc` in `app/api/agent/route.ts:100-103` (lives next to the loop's `truncate`; same shape, different threshold).
- **MENTION** — Rename `_clear` exports (`lib/state/insights.ts:64`, `lib/state/investigations.ts:44`) to `_resetForTests` so the underscore-convention's intent is in the name.
- **NOT FOUND** — Replace Magic Number with Named Constant (the codebase already does this consistently: `MAX_TOOL_RESULT_CHARS`, `RETRY_BUFFER_MS`, `REPLAY_DELAY_MS`, `TRUNC`, `minIntervalMs`).
- **NOT FOUND** — Extract Class (no class begs to be split; the four agent classes are correctly sized).

---

### Extract Function — lift `synthesize()` into `runAgentLoop` (DEEP)

**Where it shows up.** Two near-identical recovery methods:

- `lib/agents/diagnostic.ts:87-126` (40 LOC)
- `lib/agents/recommendation.ts:82-132` (51 LOC)

Both do the same shape: serialize `toolCalls` into a one-string evidence dump, build a system + user message that says "you have already gathered this; output only the structured shape; never request more queries", call `anthropic.messages.create` with no tools, parse the response through the agent's own validator, return null on any failure. The wrapping is identical; the JSON output shape is genuinely different (single `Diagnosis` object vs array of `Recommendation`). Both are invoked from the same site in their respective agent: `tryParseX(finalText) ?? (await this.synthesize(...)) ?? FALLBACK` at `diagnostic.ts:75` and `recommendation.ts:69-71`.

**Why it's like this.** Honest reconstruction: each agent grew its own synthesize when the loop's final turn started returning unparseable text. The pattern was discovered twice independently. `MonitoringAgent` and `QueryAgent` don't have one because their failure modes are different — monitoring degrades to `[]`, query returns the raw text. The two that needed it built it the same way at roughly the same time. The duplication is recognized in `study-software-design/audit.md` (Top-3 finding #3, "Lift `synthesize()` into `runAgentLoop`").

**Take.** This is the cleanest refactor in the book. Lift it. The receipt is ~90 LOC removed, one named option added to `runAgentLoop` (`recoveryPrompt?: (toolCalls: ToolCall[]) => string`), and one parse seam added (`parseResult?: (text: string) => T | null`). The loop runs as normal, attempts the parse on `finalText`, runs ONE tool-less recovery turn on failure, attempts the parse on the recovery text. Both `synthesize()` methods delete. The agent classes shrink to "build prompt → call loop → cap/derive → return."

The behavior preserved by this lift is not subtle. The recovery has been bolted on outside the loop because the loop didn't own it, but it IS a loop concern — it's the "what to do when the loop's final turn fails to parse" decision, and the loop is the only place that has all the information (tool calls, system, anthropic client) to make that decision once instead of twice. This is the textbook case for Extract Function.

**The tradeoff.** Cost of doing it: `runAgentLoop` grows from 176 LOC to ~210 LOC and gains two new options. That's an interface growth on the load-bearing function. The current loop's signature has 11 options; this lift adds 2 more. At 13 options the function starts looking like a config dumping ground; that's the boundary I'd watch. Cost of not doing it: the duplication persists, and the next agent that needs synthesis (likely `QueryAgent` once free-form queries start returning unparseable answers) writes a third copy.

The breakpoint where the calculus flips: if a third agent ever needs synthesis, the lift becomes mandatory — three copies is a code smell that a reviewer will flag. Today it's two copies, both deliberate, and the lift is high-leverage but optional.

**What I'd watch for.** The looking-easy-but-isn't part: the two `synthesize()` methods diverge in three places that aren't obvious from a quick diff. (1) The instruction text. Diagnostic's says "Output ONLY a JSON diagnosis. Never ask for more data" (`diagnostic.ts:101`); recommendation's says "Output ONLY a JSON array of recommendations. Never ask for more data" (`recommendation.ts:99-101`). The lift needs `recoveryPrompt` to take the toolCalls and return the full string, so each agent owns its instruction. (2) The output cap. Diagnostic's `max_tokens: 2048`; recommendation's `max_tokens: 2048`. Same today; could diverge tomorrow — make it an option. (3) The `recommendation.ts` synthesize takes an extra `diagnosis` argument because the recommendation prompt needs both anomaly + diagnosis as context. Diagnostic only needs anomaly. The lift's `recoveryPrompt` callback receives the loop's full context object; the agent's callback decides what to interpolate. Don't try to common the interpolation — common the loop wrapping; let the prompt build stay in the agent.

The other failure mode: the recovery turn doesn't have access to `forceFinal`'s synthesis instruction that was appended on the failed final turn. Today's `synthesize()` builds the recovery prompt from scratch. The lift's behavior should be "treat recovery as a completely separate one-turn call with its own system + user; don't try to reuse the loop's message history." Otherwise you carry the failed turn's confusion forward.

**The thing this refactor unblocks.** Once `runAgentLoop` owns recovery, the loop's invariant — "this function always returns either a successfully-parsed `T` or null" — becomes load-bearing across all four agents. The two agents that don't currently use synthesize get the option for free. `MonitoringAgent`'s "return []" can become a real recovery path. `QueryAgent`'s "return finalText.trim() with no validation" becomes the one place where no recovery is the right call, and the code makes it explicit instead of implicit.

**The thing this refactor is blocked on.** This is where the through-line lands. Lifting `synthesize()` is a behavior-preserving refactor. The way you prove behavior is preserved is to run the four agents on a set of inputs before and after the lift and compare outputs. The four agents are non-deterministic — same input, different outputs across runs (the prompts say so; the model says so). The only way to compare non-deterministic outputs is on a measured-quality basis: agreement rate against a goldset, judged by a rubric. **You cannot ship this lift safely until the eval harness exists.** Today the only safety net is the 169 unit tests — and `study-testing/audit.md:140` already names it: those tests prove the plumbing extracts the JSON the test author wrote, not that the model's output is correct. The lift could silently shift recovery behavior — say, by accidentally carrying message history forward in a way the standalone `synthesize()` didn't — and 169 green tests would still pass.

**Verdict.** Worth doing — *after* the eval harness lands (`.aipe/drills/evals-observability-induce-eval-gap-build-min-eval-harness.md`). Until then, the right move is to write the lift, run the existing tests (which will pass), and *not ship* until you can also run the harness and prove agreement-rate didn't drop. The refactor is queued, not blocked; the eval is the gate.

---

### Replace Conditional with Polymorphism — the `forceFinal` branch (DEEP)

**Where it shows up.** `lib/agents/base.ts:85-101`. The loop's per-turn shape:

```
for (let turn = 0; turn < maxTurns; turn++) {
  const budgetSpent = maxToolCalls !== undefined && toolCalls.length >= maxToolCalls;
  const forceFinal = turn === maxTurns - 1 || budgetSpent;
  const params = { model: AGENT_MODEL, max_tokens, system: forceFinal && synthesisInstruction ? `${system}\n\n${synthesisInstruction}` : system, messages };
  if (!forceFinal) params.tools = toolSchemas;
  const res = await anthropic.messages.create(params);
  ...
}
```

Two branches per turn: tools-allowed vs tools-removed. The branch is gated by two predicates (`turn === maxTurns - 1`, `budgetSpent`) and decorates the `system` prompt with `synthesisInstruction` on the forced-final turn. The branch is conditional logic on a state, and the state has exactly two values: "still exploring" and "must conclude now."

**Why it's like this.** The branch is the smallest expression of "the agent loop has two phases." Writing it as a state machine (`Exploring` → `Concluding`) at this size would be ceremony. Writing it as polymorphism (`ExploringTurn` strategy → `ConcludingTurn` strategy) at this size would be ceremony. The conditional is correct for the current shape; the question is whether the shape itself is about to change.

**Take.** Today: don't replace it. The branch is clear, the conditional is two lines, the state space is two values, and every reader of `runAgentLoop` understands it inside ten seconds. Adding a `Turn` interface with two implementations would inflate the file from one function to three exported types and make the per-turn code path harder to follow.

Tomorrow, if Chapter 03's "recovery as a third strategy alongside Exploring and Concluding" lands (lifting `synthesize()` into the loop becomes "add a third turn type"), the replacement becomes worth doing — because at three states the conditional grows into a switch and the switch grows into the polymorphism the catalog names. Today the lift is just Extract Function (above); tomorrow it's the trigger for this technique.

**The tradeoff.** Cost of replacing now: ~30 LOC of types and indirection that the reader has to thread through to follow a single turn. The loop is currently the most readable agent code in the repo precisely because the body is straight-line. Cost of not replacing: the conditional grows another arm whenever a new turn-state is introduced (recovery, retry-with-narrower-tools, partial-conclude-after-N-tool-calls). The first time you'd want to add a fourth state, the polymorphism becomes obviously right.

**What I'd watch for.** The pattern's trap: people reach for Strategy when the abstraction is "two things that vary in one dimension." This loop has two states that vary in three dimensions (whether tools are included, whether the system prompt is decorated, whether the response is the final one). Polymorphism wrapped around a 3-dimensional variation produces an interface with three methods and a fragile contract. The right shape if the lift does land: a `TurnStrategy` with one `buildParams(ctx) => MessageCreateParams` method that owns all three dimensions, and the loop's body is `const params = strategy.buildParams(ctx); const res = await anthropic.messages.create(params);`. One method, not three.

**Verdict.** Not worth it today. Worth it the moment Chapter 03's recovery-as-strategy lift lands — at that point the technique earns its place. Until then, the conditional is the cleanest expression of two states.

---

### Inline Function — `tryParseDiagnosis` / `tryParseRecommendations` near-twins (DEEP)

**Where it shows up.** Two trivial wrappers, same shape, different validator and return type:

- `lib/agents/diagnostic.ts:22-29` — `tryParseDiagnosis(text) → Diagnosis | null` wraps `parseAgentJson + isDiagnosis`.
- `lib/agents/recommendation.ts:19-26` — `tryParseRecommendations(text) → IdlessRecommendation[] | null` wraps `parseAgentJson + isRecommendationArray`.

Each is six lines: try-catch around `parseAgentJson(text)`, ternary on the type guard. The shape is identical except for the validator and return type.

**Why it's like this.** Each agent owns its parse helper because the validator + return type are agent-specific. Putting the helpers in their own modules avoids a shared abstraction the agents would have to import. The cost is two copies of the same try-catch.

**Take.** This is the trick refactor — the catalog says "inline a too-thin function" but the right move here is the opposite. Inline both into a single generic helper in `lib/mcp/validate.ts`:

```
export function parseAndValidate<T>(text: string, guard: (v: unknown) => v is T): T | null {
  try { const parsed = parseAgentJson(text); return guard(parsed) ? parsed : null; }
  catch { return null; }
}
```

Then `diagnostic.ts:75` becomes `parseAndValidate(finalText, isDiagnosis) ?? ...` and `recommendation.ts:69` becomes `parseAndValidate(finalText, isRecommendationArray) ?? ...`. The two near-twin wrappers delete. Future agents (a `SegmentationAgent`, a hypothetical `MetricsExtractorAgent`) get the helper for free.

This is the same logic as the `synthesize()` lift: two trivial duplications signal a missing abstraction, and the abstraction is one generic function with the right type signature. The receipt is smaller (~10 LOC removed) but the reasoning is identical.

**The tradeoff.** Cost: one new generic export in `validate.ts` that callers learn once. Cost of not: the duplication grows by one wrapper per new agent that returns structured output.

**What I'd watch for.** Generic functions in TypeScript that look right but lose type narrowing. The signature `parseAndValidate<T>(text: string, guard: (v: unknown) => v is T): T | null` is correct — the `guard` parameter is a type predicate, so the return type narrows to `T | null` at the call site without a cast. The accidental shape that breaks this: `(text, guard: (v: unknown) => boolean)`. Write the test that confirms the call-site type narrows correctly (a one-line test against `isDiagnosis`), then ship.

**Verdict.** Worth doing. Lower stakes than the `synthesize()` lift but the same shape. Not gated by evals — it's pure type-level refactoring; the runtime behavior is provably identical because the body is byte-equivalent.

---

### Extract Variable — synthesis-instruction boilerplate (BRIEF)

**Where it shows up.** Four agent files have `synthesisInstruction` strings (`monitoring.ts:108-110`, `diagnostic.ts:63-67`, `recommendation.ts:58-62`, `query.ts` near the end). All four share the prefix "You have NO more tool calls available. Stop investigating now and output your final answer." and the closer "Do not say you need more queries." The middle clause is genuinely role-specific (JSON object vs array vs prose).

**Take.** Lift `buildSynthesisInstruction(shape: string): string` into `runAgentLoop` (or `base.ts`); the four agents pass only the role-specific shape clause. ~12 LOC saved, one boilerplate change in one place when the prefix needs editing. The `study-software-design/audit.md` "pull-complexity-downward" section names this exact move. **Verdict: worth doing; lowest-risk refactor in the book.** No behavior change, no eval gate, no debate.

---

### Rename — `r` and `cp` in `lib/insights/derive.ts` (BRIEF)

**Where it shows up.** `lib/insights/derive.ts:13` has `const r = e?.result as ...`, and `:29` has `const cp = findCurrentPrior(...)`. Two single-letter names in a file otherwise dense with precise names (`anomaly`, `diagnosis`, `schemaCapabilities`, `parseRetryAfterMs`, `forceFinal`).

**Take.** Rename to `result` and `period`. Five seconds of work. The file's style is "names describe the value"; the two outliers stick out for the same reason the file's well-named lines don't. **Verdict: do it the next time the file is open for another reason.**

---

## Chapter close

The composition takes in this chapter cluster around one observation: this codebase has been disciplined about naming, about pulling complexity downward, about not duplicating loop control — and it has two specific composition fires (`synthesize()` duplication, `tryParseX` near-twins) that both have the same shape (two near-identical wrappers around an abstraction that hasn't been named yet). The fires are real; the chapter ranks them; the verdicts hold.

What ties the chapter to the book's through-line: the highest-value refactor in this chapter is gated on a measurement that doesn't exist. **You can lift `synthesize()` into the loop in two hours.** You cannot prove the lift didn't change agent behavior in two hours, or two weeks, until the harness in `.aipe/drills/evals-observability-induce-eval-gap-build-min-eval-harness.md` ships. The composition chapter is the place where "the eval gap caps refactor velocity" stops being abstract and becomes a specific blocker on a specific patch. That's the lesson. The composition catalog gives you the technique; the missing eval determines whether you can ship the technique safely.
