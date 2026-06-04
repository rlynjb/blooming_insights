# Chapter 9 — Define errors out of existence

## Opener

Part II handed you the weapon (deep modules with sealed decisions and pulled-down complexity). Part III turns to the *edges*: the failure modes and the design discipline that keeps them from sprawling. The most counterintuitive principle in the book is right here.

## The idea

**The best way to handle errors is to need less error handling.** Most error-handling code in working systems isn't there because the error is real; it's there because the API forced the caller to consider a case the API itself could have eliminated, masked low in the stack, or aggregated into one place. Three moves, in order of preference:

1. **Define the error out of existence.** Change the API so the error case literally can't occur. `unknown` is never a key error; `0` and the empty string are never length errors. Pick representations that don't have invalid states.
2. **Mask it low.** Handle it inside the module, return a sentinel/null/empty, and don't bother the caller with a decision they have no information to make.
3. **Aggregate it.** When the error genuinely propagates, catch it in one place at the boundary, not at every call site.

The order matters. Catch-everywhere is the worst answer.

## How it works

Two pictures: errors handled at every call site, vs the same errors designed away or absorbed in one place.

```
  Three ways to handle the same failure

  ┌─ EVERYWHERE (default; usually wrong) ────────────────────────────┐
  │                                                                   │
  │   caller A ──► op() ──► try/catch + recovery                      │
  │   caller B ──► op() ──► try/catch + recovery                      │
  │   caller C ──► op() ──► try/catch + recovery                      │
  │   caller D ──► op() ──► try/catch + recovery                      │
  │                                                                   │
  │   cost: N × (handle the error) + N × (the reader stops to         │
  │         re-understand the error case at every call site)          │
  └───────────────────────────────────────────────────────────────────┘


  ┌─ DESIGNED AWAY ──────────────────────────────────────────────────┐
  │                                                                   │
  │   caller A ──┐                                                    │
  │   caller B ──┤                                                    │
  │   caller C ──┼──► op() always returns a valid value               │
  │   caller D ──┘     (null on no-match; [] on empty; default        │
  │                     value when the input under-specifies)         │
  │                                                                   │
  │   cost: 0 caller handling. the error STATE was removed.           │
  └───────────────────────────────────────────────────────────────────┘


  ┌─ MASKED LOW / AGGREGATED HIGH ───────────────────────────────────┐
  │                                                                   │
  │                            ┌─ boundary ─┐                         │
  │   caller A ──┐             │            │                         │
  │   caller B ──┼──► op() ──► │ catch once │ ──► degrade/log/retry   │
  │   caller C ──┘             │            │                         │
  │                            └────────────┘                         │
  │                                                                   │
  │   cost: 1 catch site at the boundary; callers stay clean          │
  └───────────────────────────────────────────────────────────────────┘
```

The default that most engineers reach for is the first picture — catch at every call site. The first picture is the one to escape. The book is asking you to *prefer* the second picture (designed away), *accept* the third picture (aggregated), and *only* use the first picture when the error genuinely needs a different recovery at each call site (rare in practice).

A subtlety: "define out of existence" doesn't mean "swallow silently." It means the *case* that needed handling isn't reachable anymore because the API doesn't admit it. `Array.slice(start, end)` on out-of-range indices isn't an error — it's an empty array. That's not error-swallowing; it's an API that defined the "out of range" case out of existence by choosing a return value that's always meaningful.

## Why it cuts complexity

Error handling is one of the biggest sources of accidental complexity in working systems — not because the errors are wrong, but because the caller surface multiplies. Every `try/catch` is interface bloat (chapter 3): the caller has to know the failure mode, the recovery, and the recovery's recovery. Defining the error away removes the caller's handling entirely. Masking moves the handling to one body. Aggregating concentrates it at the boundary. All three reduce the *dependency* count (callers don't bind to the error case) and the *obscurity* count (the error story lives somewhere named, not scattered). All three symptoms drop.

The cost worth naming: an API that defines errors out of existence pays for it inside the body, where it must now do something sensible even on bad input. That cost is the same trade as chapter 7 (pull complexity down) — one body suffers, many callers don't.

## In your code

The running example hits the principle three different ways at once. Worth walking it slowly.

**Move 1 in `parseAgentJson` — designed away via `unknown`.** The function returns `unknown`, never `Anomaly[]`. A model that emits `{"foo": "bar"}` instead of an anomaly array doesn't produce a *parse* error — it produces a successful parse of a wrong-shape result. The shape mismatch is then caught by `isAnomalyArray`, which is just a type guard returning `false`. There is no exception, no try/catch, no error-handling code. The "wrong shape" case was defined out of existence by picking `unknown` plus a guard pattern. That's the textbook win.

**Move 2 in `parseAgentJson` — masked low (sort of).** When `parseAgentJson` truly can't find any parseable JSON at all, it does throw. That's the one path the API hasn't designed away (genuinely no JSON anywhere; nothing meaningful to return). But — crucially — the callers don't have to think about *that* either, because…

**Move 3 in the monitoring agent — aggregated high.** `lib/agents/monitoring.ts:112-118` wraps `parseAgentJson` in exactly one try/catch:

```
  let parsed: unknown;
  try {
    parsed = parseAgentJson(finalText);
  } catch {
    return [];
  }
  if (!isAnomalyArray(parsed)) return [];
  return [...parsed].sort(...).slice(0, 10);
```

One catch. One degradation: return `[]`. The "no anomalies, briefing degrades to empty" path is named in the comment above it ("Degrade gracefully…"). The same pattern repeats in the other three agents. The error-handling code lives at the boundary between the agent and the route, not scattered across the agent's internal logic.

Three principles stacked in eight lines of code: the shape mismatch *can't happen* (designed away via `unknown`), the parse failure *is masked low* (the function throws once, callers don't propagate it), and the boundary degradation *is aggregated high* (one place degrades to `[]`, the rest of the system never sees the failure).

**Where the codebase still has the everywhere pattern — error-prone routes.** `app/api/mcp/call/route.ts`, `app/api/mcp/tools/route.ts`, etc. each catch errors slightly differently in their JSON response shapes, including the `e.stack` leak that the cleanup audit flagged (finding #3). The "format the error response" decision is duplicated across four routes. The right move is to aggregate it — one helper that formats route errors, used by all four. That's the principle's third move applied to a place where the codebase currently fails it.

## The red flag

**Try/catch scattered across many call sites for the same logical error.** If five callers each wrap the same operation in the same try/catch with the same recovery, the recovery is one decision being made five times — that's leakage (chapter 4) of an error-handling decision across modules. The fix is one of the three moves above, almost always aggregation. Related: **special cases at every call site that a different definition would erase.** When you find yourself writing `if (x == null) return null` at five call sites because some method returns null sometimes, ask whether the method could have returned a sentinel that's always usable — that's "designed out of existence" available.

## Carry forward

Chapter 9 covered errors at the edges. Chapter 10 is the design discipline that keeps the whole module shape honest: **design it twice**. The first idea is rarely the best idea, and the cheapest way to find that out is to force yourself to sketch a second.

**See also:**
- `lib/mcp/validate.ts:3-13` and `lib/agents/monitoring.ts:112-118` — three principles in one function pair.
- `audits/cleanup-2026-06-02.md` finding #3 — the duplicated error-response shape in the routes.
