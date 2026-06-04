# Chapter 2 — Tactical vs strategic programming

## Opener

Chapter 1 said complexity accrues in tiny increments. This chapter answers the obvious next question: when do you fight it? Now, later, or "when there's time"?

## The idea

**Working code is not the goal.** Working code that you (and the next engineer) can keep editing for a year without losing speed is the goal. That second goal requires investing a steady ~10–20% of every change in design — not after the feature ships, but *during* it. "Tactical" programming optimizes for shipping the immediate feature; "strategic" programming optimizes for the cumulative editability of the codebase. Tactical wins this week and loses next quarter; strategic loses this week by a small margin and wins every quarter after.

## How it works

Plot effort against time and the two strategies separate visibly.

```
  Tactical vs strategic — the cumulative cost curve

  cost-per-change
  (time to safely
   add a feature)
        ▲
        │
        │                                              ╱ TACTICAL
        │                                          ╱
        │                                      ╱       ← every shortcut
        │                                  ╱             cashes in here:
        │                              ╱                 you can't change
        │                          ╱                     anything without
        │                      ╱                         touching five
        │                  ╱                             coupled places
        │              ╱
        │          ╱
        │      ╱
        │  ╱
        ├─────────────────────────────────────────── STRATEGIC
        │                                            (flat — the steady
        │                                             10-20% tax keeps
        │                                             modules deep and
        │                                             coupling low)
        │
        └─────────────────────────────────────────────────────► time

       ▲                              ▲                       ▲
       │ week 1: tactical ships       │ week 12: tactical     │ week 26:
       │ a day faster; strategic      │ has caught up;        │ strategic
       │ paid a small "design tax"    │ strategic is faster   │ is 3-5x
       │                              │ on every new feature  │ faster
```

Tactical is faster on the first feature and only the first feature. By the time a codebase has been edited by three people across two quarters, the tactical curve has cashed in every shortcut as a coupling, and adding a feature costs five times what it should. The strategic curve absorbs the design tax up front (10-20% of each task), spent on what Ousterhout calls **investments**: reading nearby code, picking a precise name, naming a decision in a comment, choosing the deeper interface, refactoring the adjacent module that's about to become a problem.

The book names a specific anti-pattern that lives at the steep end of the tactical curve: the **tactical tornado** — an engineer who ships features fast by being willing to leave damage everywhere they go, while the rest of the team pays the cleanup tax in perpetuity. Tactical tornadoes look productive on the dashboard. They aren't.

## Why it cuts complexity

Tactical programming maximizes the *causes* of complexity (it adds dependencies without naming them, it adds obscure shortcuts) to minimize the *symptoms* in the short term (the feature shipped fast). Strategic programming does the opposite: it spends time now to keep dependencies and obscurity low, so the symptoms (change amplification, cognitive load, unknown unknowns) never accrue. The 10-20% investment is the only thing keeping the curve flat. Skip it and the curve bends up; there is no level of skill that lets you skip the investment indefinitely.

## In your code

This repo has visible strategic decisions and visible tactical ones, and both teach.

**Strategic — the McpClient decision.** `lib/mcp/client.ts` is the cleanest piece of design in the repo: ~170 lines that absorb caching, rate-limit retry, error tagging, retry-hint parsing, and the 1 req/s pacing. The first version of this file could have been 30 lines: "call the transport, return the result." It isn't, because the engineer who wrote it knew the alpha Bloomreach server would rate-limit and that *every* tool call would eventually need the retry ladder. The investment was made *before* the symptom forced it. That's strategic — the design tax paid on day one, and now no agent loop has to think about rate limits.

**Tactical — the global insights Map.** `lib/state/insights.ts:4` is `new Map<string, Insight>()` at module scope. It works on localhost with one user. It's also the single-line decision that creates the "global Map under concurrent users" correctness bug (`audits/cleanup-2026-06-02.md` finding #1). The strategic version was always "session-keyed Map of Maps." The tactical version was "module-scope Map, fix it later." Later has arrived; the fix is now a fix-now item. The tactical curve cashed in.

**Strategic with a tactical seam — the agent loop.** `lib/agents/base.ts` makes the loop generic across all four agents (good — one investment, four callers). But each agent's `synthesize()`-style instruction lives in its own file (`monitoring.ts:102`, etc.) with similar text duplicated; chapter 8 (better together or better apart) will diagnose this directly.

## The red flag

**"Just make it work, clean it up later."** Said in code review, said in standup, said in the PR description. Three things to notice. First, "later" is almost never on the calendar — there's no ticket for it, no time budget, and the next feature gets prioritized over it. Second, the cleanup gets harder the longer you wait, because more callers depend on the tactical shape. Third, the speaker is usually trying to ship one specific feature on time and isn't thinking about the cumulative curve — which is exactly the trap.

The honest version, when the deadline is real, is: "I'm shipping tactical here; I'll spend two days strategic on it next sprint, and I'll file the ticket today." Half the people who say "clean it up later" don't file the ticket. The other half do and ship strategically next sprint. Be the second kind.

## Carry forward

If you've bought the case for investing 10-20% on every change, the next question is *what specifically to invest in.* Chapter 3 hands you the highest-leverage answer in the book: the **deep module**. Most of the rest of the book is corollaries of that one move.

**See also:**
- `.aipe/audits/cleanup-2026-06-02.md` — the global-Map finding is the tactical-debt receipt from chapter 1, now visible in chapter 2's terms.
- `.aipe/study-software-design/01-mcp-client-deep-module.md` — the strategic case study above, written up in depth.
