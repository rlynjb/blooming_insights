# Chapter 19 — Conclusion + the red-flags checklist

## Opener

Eighteen chapters built up the discipline: complexity is the enemy, deep modules are the weapon, readability is what makes the weapon usable, judgment is what tells you when to deploy it. This chapter consolidates. Every red flag from every chapter, in one place, with a one-line detect-and-fix and a link back to the chapter that named it.

## The idea

**Use this list as a code review tool.** Open a PR, scan the list, ask each red flag against the diff. The flags don't replace judgment — they sharpen the questions you ask. If a flag fires, the answer might still be "this is fine because…" — but you've forced the conversation, which is the whole point. Most code review noise is engineers having opinions; the red flags are engineers having *checkable* objections.

## The one-screen index — all 18 red flags

```
  THE RED-FLAGS CHECKLIST — scan the diff against this list

  PART I — Why design at all
  ─────────────────────────────
   1. "I'm afraid to touch this."                              → ch 1
        detect: an engineer says it about a file aloud.
        fix:    localize the fear — reduce dependencies and
                add the missing comments until the change is reasonable.

   2. "Just make it work, clean it up later."                  → ch 2
        detect: said in standups, PR descriptions, code reviews.
        fix:    if the deadline is real, ship tactical AND file the
                cleanup ticket today, AND budget the strategic time
                next sprint. half-defaulting to "later" is the trap.

  PART II — The core weapon
  ─────────────────────────────
   3. Shallow module / classitis                               → ch 3
        detect: caller still has to know most of what's inside the
                module. many tiny classes each hiding nothing.
        fix:    consolidate. push body work down; shrink interface up.
                three two-line classes are shallower than one ten-line
                function.

   4. Information leakage / temporal decomposition             → ch 4
        detect: changing a single decision touches >1 file. modules
                split by "phase 1 / phase 2 / phase 3" sharing data
                shape.
        fix:    seal the decision in one body. split by what each
                module HIDES, not by when each piece runs.

   5. Method that exists for exactly one call site             → ch 5
        detect: name mirrors the caller's vocabulary. you couldn't
                name it without naming the caller.
        fix:    push specificity to the call site; keep the module
                shaped by the underlying problem, not the use case.

   6. Pass-through method / pass-through variable              → ch 6
        detect: same signature as the method it calls; parameter
                threaded through 3+ layers, used in none.
        fix:    delete the pass-through layer; inline the call. or
                construct the module with the variable rather than
                passing it through.

   7. Config knob the module could have decided itself         → ch 7
        detect: optional parameter that 100% of callers leave default.
                boolean flag that flips behavior the body could detect.
        fix:    pull the decision into the body with a sensible default
                named in a comment. remove the knob unless a real
                overriding caller exists.

   8. Confusing-when-split / confusing-when-combined           → ch 8
        detect: reader keeps flipping between two files for one logical
                change. or, a function with two distinct halves that
                don't share variables.
        fix:    Q1: shared info? combine. Q2: simpler combined
                interface? combine. Q3: general+special tangled? split.

  PART III — Taming the edges
  ─────────────────────────────
   9. Try/except scattered everywhere                          → ch 9
        detect: same operation, same recovery, at 5+ call sites.
        fix:    in order: (a) design the error out of existence
                (different API); (b) mask it low (return sentinel);
                (c) aggregate at one boundary. catch-everywhere is
                the worst answer.

  10. First design shipped with no alternative weighed         → ch 10
        detect: PR description says "I implemented X" with no mention
                of alternatives. code has no comment explaining why
                this shape and not another.
        fix:    sketch 2-3 genuinely different designs (different
                ownership, different seams). pick one; keep the
                rejected ones documented.

  PART IV — Making it obvious
  ─────────────────────────────
  11. "Good code doesn't need comments" — used to skip them    → ch 11
        detect: PR with no comments, including on functions whose
                PURPOSE is non-obvious from the name.
        fix:    comments don't restate the code; they carry intent,
                rejected options, invariants, units. those things
                live in comments or they live nowhere.

  12. Comment is just code in English                          → ch 12
        detect: "// increment counter" above "counter++"; "// call
                the API" above "await api.call()".
        fix:    delete or replace with the WHY/invariant/contract the
                code can't carry: "tracks across the call chain; reset
                by caller, not here" — that kind of thing.

  13. Generic names: data, obj, tmp, manager, info             → ch 13
        detect: variable, parameter, or class named with a placeholder
                instead of the thing it represents.
        fix:    name the thing by its concept. not "data" but
                "anomalies" or "eqlPayload". not "manager" but
                what the class actually does ("McpClient", not
                "ConnectionManager").

  14. Comments written last, or never                          → ch 14
        detect: comments all appear in the "polish" commit. interface
                comments need paragraphs of "and also when…" clauses.
        fix:    write the interface comment FIRST. if you can't
                describe the function cleanly, redesign before you
                write the body — it's still cheap.

  15. Two ways to do the identical thing in one codebase       → ch 15
        detect: same logical job done with different error shape,
                different argument order, different naming
                convention in two places.
        fix:    pick one (usually the one with more callers); converge
                the rest. the inconsistency itself is the bug,
                regardless of which side is "better" in isolation.

  16. Reviewer says "wait, where does this happen?"            → ch 16
        detect: a fresh reader can't follow the control flow first
                read. author finds themselves explaining the code
                verbally in review.
        fix:    the reviewer is the test, not the obstacle. add the
                missing comment, restructure the hidden flow, or
                rename until prediction matches behavior.

  PART V — Judgment
  ─────────────────────────────
  17. Pattern/framework/methodology applied because it's done  → ch 17
        detect: author defends choice with "it's the canonical
                pattern for X-style problems" rather than "it
                reduces Y here." patterns doing the talking.
        fix:    ask: "what specifically does this technique cut, in
                THIS codebase?" if the answer is a measurable
                reduction in dependencies/obscurity, keep it. if it's
                "industry consensus," drop it.

  18. Sacrificing clarity for unmeasured performance           → ch 18
        detect: weird construction explained as "this is faster."
                no benchmark linked. optimization on code not on
                the critical path.
        fix:    put the obvious version back. add measurement. if
                the measurement says it's hot, optimize WITH a
                comment explaining the why and the numbers.
```

Eighteen flags. Eighteen chapters. One-to-one mapping.

## How to actually use this

Three modes, in increasing depth:

**Light pass — the 30-second scan.** Open the PR diff. Scan the flag names. Anything jump out? File a comment. Move on. Even at this depth, the list catches most of the easy cases.

**Medium pass — the per-flag check.** Walk the diff once per flag. For each flag, look for the detect pattern. When something fires, name it by chapter ("this is a chapter-7 push-up — the caller is picking a default the module could have decided"). The named-by-chapter framing makes the conversation specific instead of about taste.

**Deep pass — the design review.** Before the PR exists, sit with the design and walk *all 18 flags* against the planned shape. This is where the list pays the most. Most flags fire because of structural decisions made early; catching them at design time costs minutes, catching them in code review costs hours, catching them in production costs days.

## A note on the through-line

Every red flag in this list traces back to the chapter-1 diagram: it's either an *unaddressed dependency* (the code can't be understood standalone) or an *unaddressed obscurity* (important information isn't visible). The flags are the symptoms; the chapters are the cures; the chapter-1 framing is what tells you whether the cure is worth the cost.

Use the list as a tool, not as dogma — chapter 17 applies to the list itself. If a flag fires and the answer is genuinely "this is fine because [specific reason in this codebase]," that's the right outcome. The flag did its job; the conversation happened.

## In this codebase, where the open flags live

A snapshot of the current state from the recent audit (`audits/cleanup-2026-06-02.md`) mapped onto this checklist:

- **Flag 4 (information leakage):** `Insight` vs `Anomaly` shape duplication in `lib/mcp/types.ts`. See `.aipe/study-software-design/03-insight-anomaly-silent-leak.md`.
- **Flag 7 (config knob the module could have decided):** Mildly — the four agents' `synthesisInstruction` strings (`lib/agents/*.ts`). See `.aipe/study-software-design/04-synthesize-recovery-duplication.md`.
- **Flag 3 (shallow module):** `app/page.tsx` at 817 lines. Triaged `fix-soon`, not `fix-now`, deliberately.
- **Flag 15 (two ways to do the identical thing):** Four routes formatting JSON error responses with `e.stack` while streaming routes use just `e.message`. Audit finding #3.
- **Flag 11/12 (missing/wrong comments):** `lib/state/insights.ts:4` is missing the invariant comment that would have made the cross-session bug obvious from the surface. Linked to the chapter-1 unknown-unknown example.

That's five flags fired, three of them flagged in the cleanup audit as `fix-now`, two as `fix-soon`. The codebase is in good shape against the rest of the list — most of which is *prevention*, and the discipline that's already been applied is the reason.

## Carry forward

The book ends here. The checklist is the souvenir. The discipline is what you carry forward into every codebase you touch — because the same eighteen flags fire in every working system, and the cure is always one of these eighteen techniques.

The through-line one more time, for the road:

> **Complexity is the enemy. Deep modules are the weapon. Pull complexity down, hide decisions, name precisely, comment what code can't carry, stay consistent, measure before optimizing — and apply judgment, not fashion, when techniques disagree.**

That's the whole book. Eighteen chapters made it concrete; one sentence makes it portable.

**See also:**
- `audits/cleanup-2026-06-02.md` — the codebase's most recent triage, partially mappable to this checklist.
- `.aipe/study-software-design/audit.md` — software-design lens audit; same flags, different framing.
- `.aipe/audit-refactor-eval-substrate/` — the refactor notebook, structured around design-it-twice (chapter 10).
- `.aipe/rehearse-design-doc/03-deterministic-supervisor-not-llm-router.md` — chapter 17 in document form.
- The book itself — buy or borrow *A Philosophy of Software Design*, John Ousterhout. This guide is a companion; the book is the source.
