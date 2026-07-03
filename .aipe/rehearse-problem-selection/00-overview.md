# Problem selection — overview

The rehearsal book for **why blooming_insights deserved investment**, not how it was built. Five files, walked in order, each answering one question the review room asks before any solution is credible.

## What this book is

Coach voice. You're days from a senior loop where an interviewer probes not the code but the *choice*: "why this problem, why now, why you." The book gives you the receipts to hold that ground under pressure.

The distinction that matters: **problem selection is the human layer before solution design**. A brilliant architecture on the wrong problem loses to a decent architecture on the right one. This book is where you show you picked the right one — and can defend the pick.

## Where this sits — the map

```
  Rehearse family — four books, one arc

  ┌─ 01 problem-selection ────────────┐  ← you are here
  │  WHY this problem deserves        │     the human layer
  │  investment                        │     before solution
  └─────────────┬──────────────────────┘
                │  once problem is defensible
                ▼
  ┌─ 02 design-doc ───────────────────┐
  │  HOW a significant technical      │
  │  decision was communicated         │
  └─────────────┬──────────────────────┘
                │  once design is on the table
                ▼
  ┌─ 03 hackathon-demo ───────────────┐
  │  HOW the resulting value          │
  │  gets shown live                   │
  └─────────────┬──────────────────────┘
                │  once demo lands
                ▼
  ┌─ 04 interview-defense ────────────┐
  │  HOW the work is defended         │
  │  under scrutiny                    │
  └────────────────────────────────────┘
```

Problem-selection sits *first* because everything downstream inherits from it. Design docs justify tradeoffs against the problem. Demos land the value the problem defined. Interview defense answers "why did you build this?" with the brief in this book.

## The five files

Each file answers one review-room question. Walk them in order — later files assume the earlier ones.

```
  01  problem-brief                        WHO hurts, HOW MUCH, WHY NOW
  02  scope-cuts-and-non-goals             WHAT you deliberately didn't build
  03  options-and-opportunity-cost         WHICH paths you rejected, and why
  04  success-metrics-and-feedback-loop    HOW you know it's working
  05  skeptical-reviewer-questions         THE probes and the answers that hold
```

- **`01-problem-brief.md`** — the user, the pain, the evidence, the "why now." The core artifact. If the review room only reads one file, it's this.
- **`02-scope-cuts-and-non-goals.md`** — what you cut and why. The cuts you *reconsidered and un-cut* are the L5 signal — showing the eval work, cost controls, and fault tolerance shipped end-to-end after being deferred.
- **`03-options-and-opportunity-cost.md`** — the paths not taken. Own loop → aptkit migration. DataSource seam pattern (4 uses shipped). NDJSON over fetch stream. Portfolio hardening sequencing. Each with the opportunity cost named.
- **`04-success-metrics-and-feedback-loop.md`** — real measured numbers from baseline `2026-07-03T04-08-28-644Z`. Per-phase latency, per-case cost, per-criterion pass rates. The regression gate that closes the loop.
- **`05-skeptical-reviewer-questions.md`** — the six probes you'll actually get, each with the answer that holds under follow-up.

## The strongest defense in one line

You built an AI analyst that runs the human-analyst loop for a Bloomreach ecommerce workspace — **and then spent 4 weeks shipping the eval + observability + cost-control + fault-tolerance + regression-gate flywheel around it, receipt-backed at every step.** The eval isn't a past-tense side story. It's the shipped centerpiece that lets you make claims like "actionable_next_step baseline is 0%, here's why, here's the fix, here's the gate that blocks regression on it" — which is what "an analyst that shows its work" looks like when you turn it on yourself.

Everything else in this book is downstream of that move.

## How to read this book

- **Before an interview loop:** read all five in order. ~30 min.
- **Before a specific probe:** jump to Ch 05, find the question, read the answer, then read the file it cites for the receipts.
- **Under pressure:** Ch 05 is the memorize-this file. The others give it depth.
