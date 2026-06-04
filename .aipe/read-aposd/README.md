# A Philosophy of Software Design — a guided read

**The whole book in one sentence:** complexity is the enemy, it grows by tiny increments, and the weapon you reach for is the **deep module** — a small interface hiding a lot of behavior.

This guide is a companion to John Ousterhout's *A Philosophy of Software Design*, written in this family's voice and anchored to **this repo's own code**. It teaches the ideas; it doesn't replace the book.

---

## Supplement, not replace

The book is short, sharp, and cheap. Read it.

- buy or borrow it: *A Philosophy of Software Design*, John Ousterhout (2nd edition).
- read it free on the author's site: https://web.stanford.edu/~ouster/cgi-bin/aposd.php

What you are about to read is a **paraphrase plus your-code overlay**. The ideas belong to Ousterhout; the expression here is original, the examples are from `blooming_insights`, and the diagrams are box-drawn from scratch. If you find yourself wanting the original prose, that's the signal to go to the book.

---

## The book map

```
  PART I    Why design at all                        (the problem)
    1.  Complexity is the whole game
    2.  Tactical vs strategic programming

  PART II   The core weapon                          (modules & interfaces)
    3.  Deep modules
    4.  Information hiding (and leakage)
    5.  General-purpose is deeper
    6.  Different layer, different abstraction
    7.  Pull complexity downward
    8.  Better together or better apart

  PART III  Taming the edges
    9.  Define errors out of existence
   10.  Design it twice

  PART IV   Making it obvious                        (readability)
   11.  Why write comments — the four excuses
   12.  Comments describe what isn't obvious
   13.  Choosing names
   14.  Write the comments first
   15.  Consistency
   16.  Code should be obvious

  PART V    Judgment                                 (principles over fashion)
   17.  On trends and dogma
   18.  Designing for performance
   19.  Conclusion + the red-flags checklist
```

---

## How to read this

**Sequential is the design.** The arc moves from *what's the problem* → *what's the weapon* → *how to keep edges from bleeding* → *how to make the result readable* → *how to apply judgment*. Each chapter's **Carry forward** beat threads into the next on purpose.

**Spot-reading is fine too.** Every chapter is self-contained and has the same seven beats: opener, idea, how-it-works diagram, why-it-cuts-complexity, in-your-code, red flag, carry-forward. Open any file alone and you get value.

**Only 30 minutes?** Read these three:
- `part-1/01-complexity.md` — the through-line; nothing else makes sense without it.
- `part-2/03-deep-modules.md` — the single most important chapter; the weapon.
- `part-5/19-conclusion-red-flags.md` — the one-screen checklist of every red flag in the book, with links back.

---

## The running example

One small piece of this codebase carries the book: `parseAgentJson(text) → unknown`, at `lib/mcp/validate.ts:3-13`. It's the function that takes whatever the LLM agent prints out and turns it into structured data. It's a textbook deep module — eleven lines of body, one-line interface — and it touches almost every principle Ousterhout teaches: deep modules (chapter 3), information hiding (chapter 4), general-purpose interface (chapter 5), pulling complexity down (chapter 7), defining errors out of existence (chapter 9), consistency (chapter 15), performance non-anxiety (chapter 18).

You watch the same function get a little better, or get re-read with new eyes, every few chapters. Front matter (`00-front-matter.md`) introduces it.

---

## What's here

```
  .aipe/read-aposd/
    README.md                            ← you are here
    00-front-matter.md                   ← through-line + running example

    part-1/
      01-complexity.md
      02-tactical-vs-strategic.md

    part-2/
      03-deep-modules.md
      04-information-hiding.md
      05-general-purpose.md
      06-layers.md
      07-pull-complexity-down.md
      08-together-or-apart.md

    part-3/
      09-errors-out-of-existence.md
      10-design-it-twice.md

    part-4/
      11-why-comments.md
      12-comments-not-obvious.md
      13-names.md
      14-comments-first.md
      15-consistency.md
      16-obvious-code.md

    part-5/
      17-trends-and-dogma.md
      18-performance.md
      19-conclusion-red-flags.md
```

21 files. One book.
