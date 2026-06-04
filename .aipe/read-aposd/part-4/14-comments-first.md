# Chapter 14 — Write the comments first

## Opener

Chapter 12 said good comments add what the code can't carry. Chapter 13 said precise names carry some of that work. This chapter says: write the comments — specifically the *interface* comment — *before* the code. Doing so is a design tool, not a documentation tool.

## The idea

**Write the interface comment first, then write the code.** When you draft the comment describing what the function is *for* and what its contract is, you confront the interface design before you've sunk effort into the body. If the comment is ugly, the interface is ugly, and you can change it cheaply — you haven't written the body yet, you haven't found the call sites yet, nothing depends on this shape. Comments-first turns the comment from a *record* of the design into a *tool* for the design.

## How it works

The loop, two states. The "comments after" path commits to a shape before testing it; the "comments first" path catches bad shapes while they're still cheap to fix.

```
  Comments-first — the design loop

  ┌─ COMMENTS AFTER (the default) ───────────────────────────────────┐
  │                                                                   │
  │   draft interface ──► write body ──► tests pass ──► add comments  │
  │                                                                   │
  │   ▲                                                               │
  │   │ by the time you write the comment, you've committed to the    │
  │   │ shape. if the comment is hard to write ("this function does   │
  │   │ X and also Y when Z and sometimes W") you're already past     │
  │   │ the point where fixing it is cheap. you ship the awkward     │
  │   │ interface and live with it.                                   │
  └───────────────────────────────────────────────────────────────────┘


  ┌─ COMMENTS FIRST (the design tool) ───────────────────────────────┐
  │                                                                   │
  │                       ┌─────────────────────────┐                 │
  │   draft interface ───►│  write the comment      │◄─────┐          │
  │                       │  (what the function     │      │          │
  │                       │   is FOR, its           │      │          │
  │                       │   contract, its         │      │          │
  │                       │   invariants)           │      │          │
  │                       └────────────┬────────────┘      │          │
  │                                    │                   │          │
  │                                    ▼                   │          │
  │                          ┌─────────────────────┐       │          │
  │                          │ is the comment      │       │          │
  │                          │ ugly / long /       │       │          │
  │                          │ full of "and"s?     │       │          │
  │                          └─────┬────────┬──────┘       │          │
  │                                │ NO     │ YES          │          │
  │                                ▼        │              │          │
  │                          write the body │              │          │
  │                                         ▼              │          │
  │                              redesign the interface ───┘          │
  │                              (still cheap — no body              │
  │                               written, no callers)                │
  └───────────────────────────────────────────────────────────────────┘
```

The loop's whole job is to *fail fast on bad interfaces*, before the cost of fixing them goes up. The signal that you've found a bad interface is the comment itself: when you can't describe the function in one or two clean sentences, the function is doing more than one thing, or its contract is unclear, or its name doesn't match what it does. All three are fixable in the comment-drafting phase. None are cheaply fixable after the body is written.

The book is specific that this is about *interface* comments, not implementation comments. Implementation comments naturally come after the code (they describe what the code does). Interface comments naturally come before, if you let them — they describe what the function *is for*, which is a design question, not an implementation question.

## Why it cuts complexity

Comments-first is preventative complexity reduction. The interface you ship is the one callers depend on; bad interfaces propagate dependencies through every call site. Catching a bad interface *before* committing to it means you don't create those dependencies. Cognitive load at every future read site drops because the function does one thing, named clearly, with one contract. The cause attacked is dependency proliferation at design time — the dependencies a bad interface would have created don't get created.

A second effect: the interface comment that *did* survive the drafting becomes the interface comment that ships, with no rewriting. The artifact is free.

## In your code

This codebase has visible cases where the discipline was applied and one where it would have helped.

**Applied — the `runAgentLoop` docblock.** Look at `lib/agents/base.ts:36-47`. The shape of that comment — *what the function is for*, *when it terminates*, *what each side of the dependency injection buys* — reads like the comment someone wrote before they wrote the body. The function does exactly what the comment says. The four return paths described in the comment ("clean end" vs "maxTurns exhausted") are the only return paths in the body. That kind of one-to-one correspondence is the signal of comments-first design: the body is the comment, in code.

**Applied — the type-narrowing pair in `validate.ts`.** The split between `parseAgentJson` (general) and `isAnomalyArray` (specific) reads like someone drafted the comment "parses JSON from an agent's text output, no shape assumed" and realized the function couldn't return a typed shape because it didn't know what the caller wanted. The comment forced the *two-step typing* design (chapter 5). Comments-first turned what could have been four special-purpose parsers into one general parser plus per-caller guards.

**Would have helped — the global `insights` Map.** `lib/state/insights.ts` exports `putInsights`, `getInsight`, `listInsights`, `clearInsights`, `getAnomaly`. Drafting the interface comment for `putInsights` honestly would have produced something like: *"stores an insight in the process-global Map shared across all sessions; calling this overwrites prior insights for the same id from any session."* That comment, written *before* the body, would have immediately exposed the problem: the *contract is wrong*. A function that wipes other users' data isn't a "store" — it's a hazard. The redesign happens in the comment-drafting phase, before the wrong contract reaches the callers.

This is the chapter's clearest payoff in this repo: a comment that's *too hard to write cleanly* is the loudest possible signal that the interface needs to change.

**Would have helped — the `synthesisInstruction` duplication.** Each of the four agents passes a string that's 80% identical. If `runAgentLoop`'s interface comment had been drafted with comments-first, the question "wait, what's `synthesisInstruction` actually for?" would have surfaced. The honest comment is: *"text appended to the system prompt on the forced-final turn, instructing the model to stop exploring and emit its structured answer."* That's a *policy*, not a *per-caller variation*. Writing the comment exposes the redesign opportunity: the policy belongs in `runAgentLoop`'s body with the per-agent suffix as a small caller-supplied string.

## The red flag

**Comments written last, or never.** When you go back through a PR diff and the comments are all in the final commit (the "polish" commit), the comments weren't a design tool — they were a record. Related: **an interface comment that needs paragraphs of "and also when…" clauses to describe.** The function is doing more than one thing; the comment is reading like its own three-paragraph essay because the interface didn't get drafted before the body. Drafting the comment first would have caught the multi-purpose nature before the body locked it in.

## Carry forward

Chapter 14 used comments to design good interfaces. Chapter 15 takes the same idea one level up: **consistency** across the whole codebase. Same concept, same word; same shape, same shape. The reader stops re-learning local conventions and starts reusing global ones.

**See also:**
- `lib/agents/base.ts:36-47` — comments-first applied.
- `lib/mcp/validate.ts:3-13` — the general/specific split that the discipline produces.
- `audits/cleanup-2026-06-02.md` finding #1 — the missing interface comment on `putInsights` is the readability half of the cross-session bug.
