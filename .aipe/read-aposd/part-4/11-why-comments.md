# Chapter 11 — Why write comments (the four excuses)

## Opener

Part IV is about making code *readable* — the half of the job that begins after the structure is right. Chapter 11 is unusual: it spends the whole chapter defending comments against the four most common arguments against writing them. The defense is worth doing because every one of those arguments shows up in code review and most of them sound reasonable.

## The idea

**Comments capture information that the code structurally cannot.** Intent, rejected options, units, invariants, why-this-and-not-that — none of these have a place in any programming language's syntax. If you don't write them down, they're not somewhere else where the reader can find them; they're nowhere. Every excuse for skipping comments is really an argument that the missing information isn't worth capturing — which is almost never true.

## How it works

What the code can express versus what only a comment can carry:

```
  What lives in code vs what only a comment can carry

  ┌─ code can express ───────────────────┐ ┌─ only a comment can carry ──┐
  │                                       │ │                              │
  │  WHAT the code does                   │ │  WHY this approach           │
  │   - control flow                      │ │   - what was rejected        │
  │   - data shapes                       │ │   - what trade was made      │
  │   - call dependencies                 │ │   - what constraint forced   │
  │                                       │ │     this shape               │
  │  WHEN it runs                         │ │                              │
  │   - branches, loops                   │ │  INTENT                      │
  │   - error paths                       │ │   - what this function is    │
  │                                       │ │     FOR (vs what it does)    │
  │  HOW data flows                       │ │                              │
  │   - types                             │ │  INVARIANTS                  │
  │   - assignments                       │ │   - "x is always sorted"     │
  │                                       │ │   - "this map is per-session"│
  │                                       │ │                              │
  │                                       │ │  UNITS                       │
  │                                       │ │   - "ms not seconds"         │
  │                                       │ │   - "0-indexed inclusive"    │
  │                                       │ │                              │
  │                                       │ │  REJECTED OPTIONS            │
  │                                       │ │   - "tried polling, dropped" │
  │                                       │ │   - "B was rejected for X"   │
  │                                       │ └──────────────────────────────┘
  └───────────────────────────────────────┘
```

The left column is where engineers spend their effort: better names, clearer control flow, type annotations. All good. The right column is what the left column *cannot* hold no matter how well you write it. You can name a variable `retryDelayMs` (good, units in the name). You cannot name into the variable the reason 10_000 was chosen over 5_000 — that lives in a comment or it lives nowhere.

## The four excuses

The book names four excuses for skipping comments. Each sounds reasonable. Each is wrong.

**Excuse 1: "Good code is self-documenting."** Code documents *what*. Comments document *why*. A function named `parseAgentJson` tells you what; only a comment can tell you why it has a substring-scan fallback (because Claude sometimes wraps JSON in prose). Self-documenting code is necessary, not sufficient.

**Excuse 2: "I don't have time to write comments."** The reader spends 10× more time reading the code than the author spent writing it. Writing a comment that saves the next reader two minutes of code-archaeology pays back the moment one other person reads it. The "no time" argument is local optimization against a global cost.

**Excuse 3: "Comments go stale."** Comments go stale when nobody updates them, which is a discipline problem, not a comments problem. The same argument would apply to tests, function names, and type signatures, all of which also go stale and which we update anyway. The fix is updating comments alongside code changes, not skipping the comments.

**Excuse 4: "Most comments I've seen are useless."** True. Most comments restate the code in English ("// increment counter" above `counter++`). Those are bad comments. The remedy is writing *good* comments, not skipping all comments. Chapter 12 is the practical "what makes a comment good."

## Why it cuts complexity

Comments attack obscurity, the second of chapter 1's two causes. Important information that's not visible in the code is, by definition, obscure. The symptom that drops is *cognitive load*: a reader who can see the intent and the rejected options doesn't have to reconstruct them from the code. The symptom that drops the most is *unknown unknowns*: a comment naming an invariant ("this map is per-session") prevents the reader from making a change that violates it. Without the comment, the invariant exists only in the original author's head, which is the worst possible storage.

There's no dependency-reducing benefit from comments — they don't change code structure. They only attack obscurity. But obscurity is half the problem, and comments are the *only* tool that addresses it directly.

## In your code

`blooming_insights` is unusually comment-rich for a recently-shipped product, and the comments are *good* comments, mostly. A few worth pulling out.

**The reason-comment in `McpClient`.** `lib/mcp/client.ts:90-94`:

```
  // Bloomreach's observed penalty window is ~10s ("1 per 10 second"), so a
  // fixed sub-second retry just burns the attempt inside the same window.
  // Default the fallback base to that window; the parsed hint is preferred.
```

That comment is doing the work no name could do. The `retryDelayMs` variable is well-named. The `10_000` is just a number. The *reason* 10_000 was chosen — that the alpha server enforces a 10s penalty and a shorter retry would waste the attempt — is in the comment or it's nowhere. A future engineer who sees a TODO to "make retry snappier" reads this comment and knows not to drop it below 10s.

**The intent-comment on `runAgentLoop`.** `lib/agents/base.ts:36-47` opens with a docblock explaining *what runAgentLoop is for* (shared Claude+MCP loop for all four agents), *when it terminates* (no tool_use blocks, or maxTurns exhausted), and *why both clients are injected* (so tests can pass fakes without network or API keys). That's the chapter-12 distinction in action: not what the code does (the code shows that), but what it's *for* and why it was shaped this way.

**The invariant-comment on the synthesis instruction.** `lib/agents/base.ts:93-100` has a comment explaining why tools are omitted on the forced-final turn: *"to guarantee a non-empty response and bound latency."* That's the invariant: the agent must produce a final answer, and the way the loop guarantees it is by removing the tool surface on the last turn. Without that comment, a future engineer "fixing" the missing-tools branch would silently remove the guarantee.

**Where comments are missing — the global `insights` Map.** `lib/state/insights.ts:4` is `const insights = new Map<string, Insight>()`. There is no comment naming the invariant ("this map is process-global, shared across all sessions; do not store per-session data here without keying"). The bug it produces (the chapter-1 unknown-unknown) is exactly the kind of bug a one-line comment would have prevented. The cleanup audit's fix is the structural fix; the missing comment is the readability half of the same problem.

## The red flag

**"Good code doesn't need comments," said to justify skipping them wholesale.** It's a misuse of a true statement (good code minimizes the comments needed) as an argument for zero comments (which means the why-comments and invariant-comments don't get written either). The clearest tell: a PR with no comments anywhere, including on functions whose *purpose* is non-obvious from the name. The author confuses "I can read this code" with "the next reader will know why I shaped it this way."

## Carry forward

Chapter 11 defended comments as a category. Chapter 12 makes them earn their place: a comment that just restates the code in English is still bad. The good ones add precision the code couldn't carry.

**See also:**
- `lib/mcp/client.ts:90-94` — a textbook reason-comment.
- `lib/agents/base.ts:36-47` — a textbook intent-comment.
