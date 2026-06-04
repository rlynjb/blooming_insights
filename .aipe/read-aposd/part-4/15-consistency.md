# Chapter 15 — Consistency

## Opener

Chapter 14 made each interface clean. Chapter 15 takes the same standard and applies it across the *whole codebase*: same concept, same word; same shape, same shape; same convention, same place. Done well, consistency is the cheapest complexity reduction in the book — it does its work even when nobody notices.

## The idea

**Do the same thing the same way everywhere.** When two pieces of code solve the same problem, they should look the same — same names, same return shape, same error story, same ordering of arguments. Consistency turns the third symptom of complexity (unknown unknowns) into known knowns: a reader who has read one piece of the codebase knows what to expect in the others, and can stop reading when they find what they expected.

The benefit isn't aesthetic — it's *information-theoretic*. Every consistent pattern in the codebase is one less thing a reader has to learn. Every inconsistent pattern is a small puzzle: *is this different on purpose, or did someone forget?* Multiplied across thousands of read events, the cost of inconsistency is enormous.

## How it works

The same job, two ways. Consistency lets the reader stop reading; inconsistency forces them to keep going.

```
  One convention reused vs two conventions for one job

  ┌─ CONSISTENT (one convention, reused) ────────────────────────────┐
  │                                                                   │
  │   parseAgentJson(text)       → unknown | throws "no parseable…"   │
  │   isAnomalyArray(parsed)     → true / false                       │
  │   monitoring catches once,   ── degrades to []                    │
  │   diagnostic catches once,   ── degrades to []                    │
  │   recommendation catches once── degrades to []                    │
  │   query catches once,        ── degrades to []                    │
  │                                                                   │
  │   reader who read monitoring.ts can read diagnostic.ts in         │
  │   30 seconds — same shape, no new convention to learn.            │
  └───────────────────────────────────────────────────────────────────┘


  ┌─ INCONSISTENT (two conventions for one job) ─────────────────────┐
  │                                                                   │
  │   monitoring   ── parses, throws, caller catches → []             │
  │   diagnostic   ── parses, returns null on failure → caller checks │
  │   recommendation── parses, returns Result<T,E>    → caller .ok?   │
  │   query        ── parses inline, swallows the error               │
  │                                                                   │
  │   reader who read one now has to read all four. each looks        │
  │   like it could be wrong. the question "is this different on      │
  │   purpose?" fires four times.                                     │
  └───────────────────────────────────────────────────────────────────┘
```

The right-hand picture is a trap because each piece can be defended in isolation — "I prefer Result types," "null is fine here," "swallowing is okay for queries." None of those defenses are *wrong*; they're just *inconsistent*. The cost is paid by every reader, every time.

Consistency lets you reuse understanding. Read one thing, know how the others probably look. That's information-theoretic compression — the codebase's "vocabulary" is small, so each new file reads quickly.

## Why it cuts complexity

Consistency attacks unknown unknowns directly. A reader who knows the codebase's conventions doesn't have to ask "is this special?" when they see a piece of code; they know what shape the surrounding code takes. The cause it removes is obscurity: the convention is documented by its *consistency*, which is a form of comment-by-repetition. The symptom it removes most sharply is unknown unknowns, because the reader can rely on inference between modules: "I read how monitoring handles the JSON-parse failure; diagnostic almost certainly does the same; let me verify, find I'm right, and move on."

The cost: consistency requires discipline at the moment new code is being written. The author has to know the convention exists, has to recognize they're doing a same-shape job, and has to pick the existing shape over the slightly-better-feeling one they'd otherwise write. That cost is small per code change and large across the codebase — *negative* large, because the savings dwarf the cost.

## In your code

This is where the running example finally shows its system-wide rent.

**The null-on-failure pattern is consistent across this whole codebase.** Trace it:

- `parseAgentJson(text)` throws if it can't parse. The four agent callers each `try { parse } catch { return [] }`. **Convention: parse failure → empty array.**
- `McpClient.callTool(name, args)` returns a `result` field that callers check via `isAnomalyArray` etc. Failure to validate → return [] or null. **Same shape.**
- The `validate.ts` type guards (`isAnomalyArray`, `isDiagnosis`, `isRecommendationArray`) all return booleans, and callers handle false by returning [] or null. **Same shape.**
- The Bloomreach error envelope (`isRateLimited` in `lib/mcp/client.ts:18`) returns a boolean, callers retry or fail. **Same shape.**

Four different layers, one consistent shape: *check, return empty/null on failure, degrade gracefully*. A reader who has internalized this shape from any one of those four sites can read the others in seconds. The shape is the codebase's vocabulary; the consistency is the lesson.

**Inconsistency that exists, and the audit caught it — error response shapes.** From `audits/cleanup-2026-06-02.md` finding #3: four routes (`app/api/mcp/call/route.ts`, `tools/route.ts`, `tools/check/route.ts`, `capture/route.ts`) each format their JSON error responses *almost* the same way, but with `e.message + '\n' + (e.stack ?? '')` — including the stack — while the streaming routes use just `e.message`. The audit calls this out exactly as a chapter-15 finding: *"The streaming routes already use this safe shape — the inconsistency is the finding."* That sentence is the chapter's whole argument: the inconsistency *itself* is the bug, regardless of which side is "right" in isolation.

**The cross-layer naming inconsistency — `project_id` vs `projectId`.** From chapter 13. The codebase is consistent *within each layer* — wire format uses snake_case, in-process TypeScript uses camelCase — and the conversion happens at the seam. That's *good* consistency: the rule is "same concept, same word, within a layer." The cross-layer translation is named and explicit. Compare to a codebase where `project_id` randomly appears inside TypeScript code: that would be the bad version, the same word switching shape with no rule.

**The chapter's payoff is that "consistency" isn't just a style preference.** It's the reason the cleanup audit can describe most of the codebase as *clean* despite the codebase being multi-layer and recently-written. The conventions are mostly consistent; the exceptions are documented; readers can move fast through unfamiliar files because the vocabulary is shared.

## The red flag

**Two ways to do the identical thing in one codebase.** When you find two functions, two error-handling patterns, two argument orderings, two return-shape conventions for the same logical job, the inconsistency is the finding regardless of which side is "better." The fix is picking one and converging — usually the one that already has more callers (the cost of changing fewer call sites is lower). Related red flag: **convention drift over time** — a codebase that started consistent and grew inconsistent because new code didn't notice the old convention.

## Carry forward

Chapters 11-15 made code readable through comments, names, and consistency. Chapter 16 closes Part IV with the integrating principle: **code should be obvious.** Obviousness is the property; comments, names, and consistency are the tools.

**See also:**
- `lib/mcp/validate.ts:3-13`, the four agent files, `McpClient.callTool` — the null-on-failure shape replicated across four layers.
- `audits/cleanup-2026-06-02.md` finding #3 — the four-route error-response inconsistency, exactly this chapter's red flag.
