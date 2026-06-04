# Chapter 17 — On trends and dogma

## Opener

Parts I-IV gave you principles and the techniques to apply them. Part V is about *judgment*: when to apply which principle, and what to do when industry trends push you toward a shape that doesn't fit. The book gets opinionated here, and the opinions matter.

## The idea

**Principles over fashion.** A pattern, a methodology, or a framework is a tool that fits *some* problems. None of them are universal. The book's contention is that engineers routinely reach for trends as though they were laws — applying a design pattern because it's a pattern, choosing inheritance because OO classes mean inheritance, doing TDD because TDD is what good engineers are supposed to do. Each of those *can* be right; each of them is often wrong. The question isn't "what's the trendy answer?" — it's "does this technique reduce complexity *here?*" The technique earns its place by its effect on this specific codebase, not by its presence in the industry conversation.

The book names four specific cases where the trend pushes the wrong way:

1. **Inheritance is often a complexity trap.** Inheritance creates implicit dependencies between parent and child (the base class can change behavior the child depends on without notice). Composition is usually deeper (chapter 3): a thin wrapper interface in front of a delegated implementation, with the delegation explicit.
2. **Agile methodologies pressure toward tactical work.** "Just enough to deliver this sprint" is the literal tactical-tornado framing from chapter 2. Agile can be done strategically, but the default cadence pulls toward the tactical end.
3. **TDD optimizes features over design.** Writing the test first guarantees the *feature* gets built; it doesn't guarantee the *interface* you write the test against is the right interface. The test commits you to a contract before chapter 14's comments-first discipline has a chance to challenge it.
4. **Design patterns can be over-applied.** The Gang-of-Four catalog is a list of patterns engineers have found useful; it isn't a list of patterns to deploy by default. Reaching for the Visitor pattern when a switch statement is cleaner is pattern-over-application — the pattern is doing the talking, not the problem.

The point is the same in each case: principles tell you *what* you're trying to achieve (cut complexity); trends tell you *which technique* engineers currently reach for. The two are only sometimes aligned.

## How it works

A pattern that *fits* the problem versus a pattern *applied because it's a pattern*:

```
  Pattern fits the problem vs pattern applied for its own sake

  ┌─ FITS — pattern reduces complexity HERE ─────────────────────────┐
  │                                                                   │
  │   problem: 4 callers all need the same JSON-parsing logic         │
  │                                                                   │
  │   pattern: deep module (one body, narrow interface)               │
  │                                                                   │
  │   why it fits:                                                    │
  │     - 4 callers × 5 quirks = 20 sites of leakage avoided          │
  │     - body absorbs all 5 in one place                             │
  │     - measurable: # of files that change when a quirk             │
  │       is added → 1, not 4                                         │
  │                                                                   │
  │   ▲                                                               │
  │   │ the pattern is doing the work the principle asks for.         │
  └───────────────────────────────────────────────────────────────────┘


  ┌─ DOESN'T FIT — pattern applied for its own sake ─────────────────┐
  │                                                                   │
  │   problem: parse one JSON string                                  │
  │                                                                   │
  │   pattern applied: Factory + Strategy + Visitor                   │
  │                                                                   │
  │   why it's wrong:                                                 │
  │     - one caller, one shape, no families of related parsers       │
  │     - the patterns ADD interfaces, abstract base classes,         │
  │       and indirection that nothing needs                          │
  │     - measurable: # of files involved in "parse one thing" → 7    │
  │                                                                   │
  │   ▲                                                               │
  │   │ the pattern is doing the talking; the problem is silent.      │
  └───────────────────────────────────────────────────────────────────┘
```

The test isn't "is this a recognized pattern?" — it's "does this pattern, deployed here, reduce dependencies and obscurity for this codebase's actual problem?" If yes, ship it. If no, don't ship it just because the pattern has a name.

## Why it cuts complexity

The chapter's principle is structural rather than tactical: it tells you *how to apply every other chapter's tools*, by checking each technique against the through-line (does this reduce complexity *here?*) rather than against the industry conversation (does the industry currently like this technique?). Without this principle, the book's earlier chapters would be just another set of trends to apply uncritically — which would defeat the whole point.

The cause attacked is meta-obscurity: a pattern applied without a stated reason hides the *why*. The reader can't tell whether the pattern is load-bearing (don't change it) or decorative (it can go). Asking "what complexity does this reduce, here?" surfaces the reason, and the reason is the durable artifact.

## In your code

This codebase has a visible, deliberate stance against one trend, and it earns the chapter's payoff.

**The deterministic supervisor is the chapter's textbook win for this repo.** `blooming_insights` does *not* use an LLM as the router between agents. The decision about which agent runs (monitoring vs diagnostic vs recommendation vs query) is made by *deterministic code* in the routes (`app/api/briefing/route.ts`, `app/api/agent/route.ts`) and the intent classifier (`lib/agents/intent.ts`). The "LLM as orchestrator / router" pattern is currently very trendy in agent-architecture writing; this repo deliberately rejected it.

The defense is recorded in `.aipe/rehearse-design-doc/03-deterministic-supervisor-not-llm-router.md` — the design doc that walks the rejected alternative and the chosen shape side by side. The argument:

- An LLM router adds 1-3 seconds of latency per routing decision.
- It costs tokens per route (a fixed tax on every request).
- It can route wrong (a deterministic supervisor cannot).
- The actual routing problem in this codebase has *four* possible destinations, which is well inside what a deterministic supervisor can handle confidently.

The trendy answer would have been the LLM router. The principled answer was the deterministic supervisor. The chapter's question — *does this technique reduce complexity for this codebase?* — got answered honestly in favor of the principle. The doc's existence is the audit trail of the judgment.

**Composition-over-inheritance, applied here.** The four agents (`monitoring.ts`, `diagnostic.ts`, `recommendation.ts`, `query.ts`) don't inherit from a `BaseAgent` class. Each is its own module that *composes* `runAgentLoop` (from `lib/agents/base.ts`) by calling it with the agent's prompt, schema filter, and synthesis instruction. The shared behavior is in one shared function; the per-agent customization is in each agent file. No inheritance, no abstract base, no override mechanics, no implicit dependencies on a parent's behavior. The composition shape is exactly chapter 3's deep module: `runAgentLoop` is the deep body; the agents are thin compositional sites.

The book's argument for composition over inheritance is exactly this shape: explicit delegation beats implicit inheritance because the dependencies are visible. `monitoring.ts` *clearly* depends on `runAgentLoop`; if `runAgentLoop` changes, the relationship is grep-able. If `monitoring` had extended `BaseAgent`, the same dependency would be implicit in the class hierarchy and harder to trace.

**Where the trend pressure exists but the codebase resists — TDD without comments-first.** This codebase has 144 Vitest tests, mostly TDD'd for pure logic. That's good. But the comment quality on the same functions (chapter 11) is what really lets a future maintainer change them safely. TDD got the *behavior* right; comments-first (chapter 14) is what would have gotten the *interface design* right at the start. The codebase uses both — TDD where behavior matters, deliberate interface design where design matters. The chapter's lesson: TDD is a tool, not a worldview.

## The red flag

**Reaching for a pattern, framework, or methodology because it's the done thing, not because it cuts complexity here.** Spot it by asking the author: "what specifically does this pattern reduce for this codebase?" If the answer is "well, it's the canonical pattern for X-style problems," the pattern is doing the talking. If the answer is "we'd otherwise duplicate the parsing logic in 4 callers, and this absorbs it into one body," the principle is doing the talking. Listen for the difference.

## Carry forward

Chapter 17 said principles over fashion. Chapter 18 takes the same skeptical eye to *performance*: clean design is usually fast enough, optimization without measurement is decoration, and the running example proves it.

**See also:**
- `.aipe/rehearse-design-doc/03-deterministic-supervisor-not-llm-router.md` — the canonical rejected-trend artifact for this codebase.
- `lib/agents/base.ts` and the four agent files — composition over inheritance, deployed.
- `.aipe/audit-refactor-eval-substrate/01-composition.md` — the refactor notebook's argument for composition over inheritance, written in this codebase's vocabulary.
