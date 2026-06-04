# Chapter 12 — Comments describe what isn't obvious

## Opener

Chapter 11 said write comments. Chapter 12 says: write *good* ones. A comment that repeats what the code already says is worse than nothing — it's reading work for the next person with no payoff.

## The idea

**A comment should add precision or intuition the code can't carry on its own.** Two kinds, with different jobs:

- **Interface comments** (what the caller needs to know): what the function is *for*, what each parameter means, what the return value means, what side effects exist, what invariants the caller must preserve. The caller reads these *instead of* the body.
- **Implementation comments** (what the body needs to explain): why a particular algorithm was chosen, what a subtle line is guarding against, what the rejected alternative was. Maintainers read these alongside the code.

The two don't overlap. Mix them up and the interface comment becomes a wall of irrelevant implementation detail; the implementation comment becomes a useless restatement of the function's purpose.

## How it works

The same line of code, commented two ways. One adds nothing; one earns its place.

```
  Restate-the-line vs add-what-the-line-can't-say

  ┌─ COMMENT THAT RESTATES THE CODE (useless) ───────────────────────┐
  │                                                                   │
  │      // increment the counter                                     │
  │      counter++;                                                   │
  │                                                                   │
  │      // call the API                                              │
  │      const result = await api.call();                             │
  │                                                                   │
  │      // sort the array                                            │
  │      arr.sort();                                                  │
  │                                                                   │
  │   reader gets: the code in English, twice.                        │
  │   reader still wonders: WHY?                                      │
  └───────────────────────────────────────────────────────────────────┘


  ┌─ COMMENT THAT ADDS WHAT THE CODE CAN'T (good) ──────────────────┐
  │                                                                   │
  │      // tracks retries against this.maxRetries; reset             │
  │      // by the caller, NOT here, so the next callsite sees the    │
  │      // count for this whole call chain.                          │
  │      counter++;                                                   │
  │                                                                   │
  │      // staleTtl: 60s — long enough to cover the typical          │
  │      // briefing scan; short enough that demo replays don't       │
  │      // serve cached live data after the user toggled mode.       │
  │      const result = await api.call();                             │
  │                                                                   │
  │      // sort by severity DESC then by timestamp DESC — UI         │
  │      // ordering depends on this; do not change without           │
  │      // updating the InsightCard sort key.                        │
  │      arr.sort();                                                  │
  │                                                                   │
  │   reader gets: WHY, plus the invariants, plus the contract        │
  │   with another part of the system.                                │
  └───────────────────────────────────────────────────────────────────┘
```

Each comment in the right column adds something the code structurally cannot show: ownership of state across calls, the reasoning behind a magic number, the cross-module contract.

## Why it cuts complexity

The right column targets *obscurity* with surgical precision. A reason-comment ("we chose X because Y") removes the need for the reader to reverse-engineer the choice. An invariant-comment ("this is always sorted") removes the need to scan the surrounding code to know whether to sort again. A contract-comment ("the UI depends on this order") removes the need to grep for callers before editing. All three remove specific kinds of unknown-unknowns. The cause is named (obscurity), the symptom drops (the reader doesn't have to load the missing context from elsewhere — there isn't anywhere else to load it from).

Cost: writing the comment is a small amount of work, and keeping it up to date is another small amount of work. The savings compound across every reader for the lifetime of the code.

## In your code

Three live cases — one excellent interface comment, one excellent implementation comment, and one place a comment is wrong.

**Interface comment that earns its place — `runAgentLoop`.** `lib/agents/base.ts:36-47`. The docblock describes:
- what the function is *for* ("shared Claude + MCP tool-use loop");
- when it terminates (two named conditions, with their consequences);
- *why* both clients are injected (so tests can pass fakes — that's a chapter-9 designed-out-of-existence reason, surfaced in the comment).

A caller of `runAgentLoop` can read that docblock and use the function without reading the body. That's what the chapter is asking for.

**Implementation comment that earns its place — the `synthesisInstruction` mechanic.** `lib/agents/base.ts:96-100` explains:
- the *what* (omit tools on the final turn);
- the *why* (guarantee a non-empty response and bound latency);
- the *consequence* (otherwise the model "tends to keep thinking and never produce the JSON").

The third bullet is the killer feature. Without it, a future maintainer would see the `forceFinal` branch and ask "why is this here? the loop seems like it would terminate fine." The comment names the failure mode the branch is preventing — the kind of information that exists only in the head of someone who saw the model misbehave in production.

**A comment that's just restating the code — there's not many of these in this repo, but here's the pattern.** Avoid:

```
  // increment the counter
  counter++;
```

Every reader of `counter++` knows what it does. The comment adds zero. Worse, it trains the reader to skip comments next time, including the ones that *do* add value.

**Where a missing comment hurts — the global `insights` Map.** From chapter 11. `lib/state/insights.ts:4` is missing the comment that names the invariant ("process-global, not session-scoped — do not put per-user data here without keying"). The chapter-12 lesson: a one-line interface comment on `putInsights` saying "stores an insight in the process-global map; current implementation does NOT key by session — caller must enforce uniqueness if used across sessions" would have prevented the bug, or at minimum made it obvious that the API was unsafe by design.

## The red flag

**A comment that's just the code in English.** "Increment the counter," "call the API," "set the flag" — if you can read off the comment from the code line and there's nothing else in the comment, the comment is decoration. The fix isn't deletion; the fix is replacing it with the *missing* comment that would have earned its place: the why, the invariant, the contract.

Related red flag: **a comment that's longer than the code it documents *and* doesn't say anything new.** Long restatement is the worst version, because it costs the reader the most to skim.

## Carry forward

Chapter 12 made comments earn their place. Chapter 13 turns to the other half of readability: **names**. A precise name carries some of the work a comment would otherwise have to do, and a vague name leaves comments doing work the name should have done.

**See also:**
- `lib/agents/base.ts:36-47` — interface comment as a worked example.
- `lib/agents/base.ts:96-100` — implementation comment as a worked example.
