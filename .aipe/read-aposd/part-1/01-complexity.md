# Chapter 1 — Complexity is the whole game

## Opener

The front matter named the enemy. This chapter sharpens what "complexity" actually means as a working definition you can use in code review.

## The idea

**Complexity is anything about a system's structure that makes it hard to understand or modify.** It is not measured by lines of code; it's measured by what you have to hold in your head to safely change one thing. It accrues in tiny increments — one shortcut, one duplicated decision, one unclear name — and unless you resist it continuously, it wins by inertia.

## How it works

Three symptoms tell you complexity is present; two underlying causes produce them. The whole diagnostic loop is one picture.

```
  Complexity — the diagnostic shape

  ┌── symptoms (what you feel) ──────────────────────────────────────┐
  │                                                                   │
  │  CHANGE      one logical change touches N places                  │
  │  AMPLIF.     (rename a field, edit 7 files, hope the 8th wasn't)  │
  │                                                                   │
  │  COGNITIVE   how much context the reader must load before         │
  │  LOAD        editing safely (the "I need to read three other      │
  │              files first" feeling)                                │
  │                                                                   │
  │  UNKNOWN     you can't tell from reading the code what            │
  │  UNKNOWNS    your change will break elsewhere                     │
  │              (the most dangerous of the three)                    │
  │                                                                   │
  └──────────┬────────────────────────────────────────────────────────┘
             │  produced by
             ▼
  ┌── causes (what produces the symptoms) ──────────────────────────┐
  │                                                                  │
  │  DEPENDENCIES   code that can't be read, used, or tested         │
  │                 standalone — its meaning lives elsewhere         │
  │                                                                  │
  │  OBSCURITY      important information that isn't in front of     │
  │                 the reader (units, invariants, side effects,     │
  │                 the reason this exists)                          │
  │                                                                  │
  └──────────────────────────────────────────────────────────────────┘
```

The symptoms are what you *feel*. The causes are what you can actually *fix*. That asymmetry is the lesson: you can't reduce "change amplification" directly — you reduce it by reducing dependencies, which then makes change amplification go away. Every technique in the rest of the book aims at *causes*, never at symptoms.

## Why it cuts complexity

Naming the three symptoms gives you the diagnostic vocabulary. When you say "this code is bad," you're not signal; you're sentiment. When you say "this code has change amplification — renaming `Anomaly.metric` would touch eight files," you're sourcing the claim. Naming the two causes gives you a fix list: every fix in chapters 3-19 is either *reducing a dependency* or *reducing obscurity*. That's it. There are no other moves.

## In your code

Symptom-by-symptom, here's where this repo currently sits.

**Change amplification — well-controlled, mostly.** The `Anomaly` / `Insight` / `Diagnosis` / `Recommendation` field names in `lib/mcp/types.ts` are referenced from the UI, the validators, the agent prompts, the demo snapshots, and the markdown export. Renaming `change.value → change.percent` would touch a documented list of files (the project context calls this out under "What must not change"). The cause is real — these types *are* a wide dependency — but the obscurity is low because the project lists them.

**Unknown-unknowns — the live one.** `lib/state/insights.ts:4` holds a single global `Map<id, Insight>` across all users on a Vercel instance. The fact that any new feed run wipes another user's investigation isn't visible from the code that uses `putInsights`/`getInsight`; it's the kind of bug you only find by being unlucky in production. That's textbook unknown-unknown: the dependency (the global Map's cross-session bleed) is hidden inside what looks like a key-value store.

**Cognitive load — mixed.** Reading `lib/mcp/client.ts` end-to-end is comfortable: it's 173 lines, one class, one job (call a tool, cache, rate-limit, retry). Reading `app/page.tsx` is not: it's 817 lines holding mode toggle, auth recovery, two columns of layout, demo replay routing, dev capture flow, and the briefing fetch — all in one component. The first is a deep module; the second is a shallow one with way too much surface. Chapter 3 will diagnose the latter properly.

## The red flag

**"I'm afraid to touch this."** When an engineer says that out loud about a file, you've found complexity. The fear isn't laziness — it's the reader's correct intuition that they can't predict the consequences of a change. The fix is never to ship anyway; it's to localize the fear by reducing dependencies and adding the missing comments until the change is reasonable.

## Carry forward

If complexity is the enemy and it accrues in tiny increments, the only question is whether you fight it continuously or all at once. Chapter 2 makes the case that "all at once" is a fantasy — you fight it on every commit, or you don't.

**See also:**
- `.aipe/audits/cleanup-2026-06-02.md` — the global-Map bug above is finding #1 (`lib/state/insights.ts:4`).
- `.aipe/study-software-design/02-shallow-module-page-component.md` — the `app/page.tsx` cognitive-load case.
