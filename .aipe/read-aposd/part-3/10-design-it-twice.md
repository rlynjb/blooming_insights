# Chapter 10 — Design it twice

## Opener

Chapter 9 cleared the edges. Chapter 10 is the discipline that keeps the *middle* honest. The first design that occurs to you is rarely the best one — and the cheapest way to find that out is to force yourself to sketch a second.

## The idea

**Before committing to a design, sketch two or three genuinely different alternatives.** Not three variations of the same idea (the same recursion with different arguments) — three different *shapes*, with different decisions about who owns state, where the seams are, what the interface looks like. The second sketch is the one that usually exposes the weakness in the first. The third sketch, when you can produce one, sometimes reveals a hybrid that beats both.

This sounds like overhead. It almost never is. A two-hour sketch session at the start of a feature saves a week of refactoring at the end. The cost is asymmetric and the cheap side is up front.

## How it works

Plot the design decision on a tree, not as a single path.

```
  One path vs three sketched, one chosen

  ┌─ THE INSTINCT (one path) ────────────────────────────────────────┐
  │                                                                   │
  │   problem ──► design A ──► implement ──► ship                     │
  │                                                                   │
  │   what you don't know: was A actually the best?                   │
  │                        what would B have looked like?             │
  │                        was there a C that combined both?          │
  │                                                                   │
  └───────────────────────────────────────────────────────────────────┘


  ┌─ THE DISCIPLINE (three paths, one chosen) ───────────────────────┐
  │                                                                   │
  │                       ┌─► design A: owner = caller                │
  │                       │     pros: simple body                     │
  │                       │     cons: every caller picks the policy   │
  │                       │                                           │
  │   problem ──► sketch ─┼─► design B: owner = module                │
  │                       │     pros: callers stay one-line           │
  │                       │     cons: body is denser                  │
  │                       │                                           │
  │                       └─► design C: owner = shared config         │
  │                             pros: policy in one place             │
  │                             cons: extra indirection layer         │
  │                                                                   │
  │   compare ──► pick B ──► implement ──► ship                       │
  │                                                                   │
  │   what you now know: WHY B beat A and C. you can defend the      │
  │   choice and revisit it when the constraints change.              │
  └───────────────────────────────────────────────────────────────────┘
```

The diagram's key cell is the "WHY B beat A and C" — that's the durable output. Even if you'd have picked B without the discipline, having the rejected alternatives written down means a future maintainer (or you in six months) doesn't waste time re-deriving why A was wrong. The artifact is the value, not just the decision.

The book's claim that the second sketch usually exposes the first's weakness is empirical, not a theorem. The mechanism: drafting A makes you commit to a particular ownership story or a particular interface shape, and only by drafting B (which makes *different* commitments) do you see what A was implicitly assuming. The first design is invisible to you until the second design contrasts with it.

## Why it cuts complexity

The principle is preventative, not corrective. A design that wasn't compared to alternatives carries hidden assumptions; those assumptions tend to be the ones that bite later, because they were never named. Cognitive load drops when the *decision* is documented alongside the rejected alternatives — readers don't have to re-derive why the code looks the way it does. Unknown unknowns drop because the rejected paths are now known and named. The cause it removes is obscurity: the *reason* for the chosen shape is no longer implicit in the code; it's explicit in the comparison.

The cost: design-it-twice takes time. The book argues — and the empirical record agrees — that the cost is small compared to the rework cost of shipping a first-instinct design that didn't survive the codebase's growth.

## In your code

This repo has a visible artifact of the discipline applied, and a visible case where the discipline would have helped.

**Applied — the refactor notebook.** `.aipe/audit-refactor-eval-substrate/` is a six-chapter notebook of refactor *opinions* across the codebase, with multiple alternatives weighed for each. The `01-composition.md` chapter, for example, sketches different ways the agent loop could compose tools (caller-owned schema lists vs registry-driven discovery vs decorator-based registration) before landing on a recommendation. The structure of that notebook *is* the design-it-twice discipline applied as a written artifact. A future maintainer can read the rejected alternatives and understand why the chosen shape is what it is.

**Applied at the architecture level — the design docs.** `.aipe/rehearse-design-doc/` includes four design docs each of which has a "rejected alternatives" section. `03-deterministic-supervisor-not-llm-router.md` is the textbook case: the project considered an LLM-based router for which agent runs when, sketched it, contrasted it with the deterministic supervisor that's actually in the code, and documented why the deterministic version wins on cost, latency, and predictability. The doc is itself a "design it twice" artifact frozen on disk. The chosen shape is defended by the existence of the rejected one.

**Would have helped — the `Insight` vs `Anomaly` shape.** `lib/mcp/types.ts` has two types that share six of seven fields. The "two types" decision wasn't visibly weighed against the "one type with optional UI fields" alternative; it happened because the two shapes came from different origins (the agent emits one, the route promotes to the other). If the discipline had been applied at type design time, the comparison would have surfaced the leak (chapter 4) and probably picked the base-type shape. The current state is fine; the rework cost to fix it is now non-zero, which is the cost the discipline would have prevented. `.aipe/study-software-design/03-insight-anomaly-silent-leak.md` documents this.

**Where the discipline is happening live — the cleanup audit's refactor-shape lines.** Each fix-now item in `audits/cleanup-2026-06-02.md` has a `Refactor-shape:` line that describes the chosen fix. The notebook in `.aipe/audit-refactor-eval-substrate/` is the longer-form version. Both are the discipline in production: rather than picking the first fix that occurs, the codebase has artifacts where alternatives were considered. The artifact is doing work.

## The red flag

**First design shipped with no alternative weighed.** The clearest tell is the PR description that says "I implemented X" with no mention of what else was considered. The code itself looks fine, but the missing question — "what other shapes did this almost take?" — means the rejected alternatives weren't named, so the chosen shape can't be defended later when the constraints change. Related smell: a code comment that just describes *what* the code does, with no hint *why this shape and not another*. Chapter 12 will sharpen what comments should actually say; here, the smell is the absent comparison.

## Carry forward

Part III handled the edges and the design discipline. Part IV is about making the result *readable* — comments, names, consistency, obviousness. Chapter 11 begins with a defense of comments themselves, against the four excuses you'll hear most often from engineers who refuse to write them.

**See also:**
- `.aipe/audit-refactor-eval-substrate/` — the design-it-twice notebook for this repo.
- `.aipe/rehearse-design-doc/03-deterministic-supervisor-not-llm-router.md` — the canonical "rejected alternative as artifact" doc.
- `audits/cleanup-2026-06-02.md` — each fix-now finding's `Refactor-shape:` line is design-it-twice in miniature.
