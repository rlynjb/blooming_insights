# Chapter 8 — Better together or better apart

## Opener

Chapter 7 said pull complexity into one body. The honest follow-up question: *which* body? When is one module actually two, and when are two modules secretly one?

## The idea

**The instinct to subdivide is overrated.** Splitting a module costs something (more interfaces, more files, more cross-module knowledge a reader has to hold), and that cost is often invisible until you've paid it five times. **Combine pieces when** they share information that you'd otherwise duplicate, when a combined interface is simpler than the sum, or when the split would force the reader to hold both halves in their head anyway. **Split pieces when** what looks like one module is actually a tangle of general-purpose and special-purpose work, where the general part deserves to be reused and the special part deserves its own home.

The book's stance is mildly contrarian: most engineers split too eagerly and combine too reluctantly. Saying "let me just pull this into its own file" is a default cultural move; saying "let me combine these two files" feels backward, even when it's the right call.

## How it works

A three-question decision flow you can actually use in code review.

```
  Together-or-apart — the three-question test

  Q1.  Do these pieces share INFORMATION that would otherwise be
       duplicated?
       │
       ├─ YES ─► combine. duplication is leakage (chapter 4); one
       │        body owning the shared fact is the fix.
       │
       └─ NO ─► continue to Q2.

  Q2.  Is the COMBINED INTERFACE simpler than the sum of the
       two separate interfaces?
       │
       ├─ YES ─► combine. interface cost is the dominant cost
       │        in chapter 3's depth ratio; simpler interface wins.
       │
       └─ NO ─► continue to Q3.

  Q3.  Are GENERAL-PURPOSE and SPECIAL-PURPOSE concerns tangled
       in one body?
       │
       ├─ YES ─► split. the general part deserves to be reusable
       │        without the special-purpose code dragging along.
       │
       └─ NO ─► leave it alone. neither move buys you anything.
```

Three questions, asked in order. The first one fires more often than people expect — most "this module is doing too much" complaints are actually "these two modules are sharing a fact that they each duplicate." The third one fires the most subtly — most "this module is fine" defenses are actually "we haven't noticed the general part is being held hostage by the special part."

## Why it cuts complexity

The mistake in both directions is the same: a *wrong* split or a *wrong* combine increases the dependency count without reducing obscurity. Two modules that share knowledge create a duplication you'll forget to update; one module that holds two unrelated jobs forces the reader to skip past the irrelevant half on every read. The principle's whole job is to keep the cause-of-complexity count low: don't add interfaces that don't earn their place (over-splitting), don't bury distinct concerns under one (over-combining).

The reason the book leans toward *combine* is that the cost of one extra file in front of the reader is more invisible than the cost of one extra duplication inside two files. The duplication looks like one shape on the eye but compounds across edits; the extra file looks small but the reader pays for it on every read. Defaulting toward combine is a thumb on the scale to correct the cultural overshoot.

## In your code

Three live examples, one per question.

**Q1 fires — the four agents' synthesisInstruction strings.** `lib/agents/monitoring.ts:102-105`, `diagnostic.ts`, `recommendation.ts`, `query.ts` each pass a string that says "you have no more tool calls, output ONLY a [shape] now." The strings are 80% identical and 20% per-agent-specific. The shared information ("you must stop and synthesize") is duplicated four times. Q1 says: combine. The combined shape could be `runAgentLoop` knowing the synthesis policy and the caller passing only the per-agent suffix. `.aipe/study-software-design/04-synthesize-recovery-duplication.md` documents this case; it's a real-but-not-urgent finding.

**Q2 fires — the `Insight` vs `Anomaly` shapes in `lib/mcp/types.ts`.** Two types sharing six of seven fields. The combined interface ("one type, with UI-only fields optional") would be simpler than the sum (two near-identical types kept in sync). Today they're separate because they came from different sources (the monitoring agent emits Anomalies; the route promotes them to Insights). The cost of the sync (every shape change touches both, plus the validators) is exactly what Q2 is asking about. The fix shape: a base type plus a UI extension type. `.aipe/study-software-design/03-insight-anomaly-silent-leak.md` covers this in depth.

**Q3 fires (mildly) — `app/page.tsx` mixing general and special concerns.** This file holds at least two distinct jobs: (a) "fetch the briefing and render its insights" (general feed concern), and (b) "the dev-only one-click demo-snapshot capture" (special-purpose authoring concern). The capture flow is a few well-bounded handlers, but it lives inside the same component as the production feed. Q3 says split: the capture flow could be its own module, leaving the feed component focused. `audits/cleanup-2026-06-02.md` triages this as `fix-soon`, deliberately not `fix-now` — the split is healthy but doing it during a cleanup pass is exactly how non-bugs become bugs.

**Where Q3 *almost* fires but shouldn't — `McpClient` doing cache + rate-limit + retry.** A reader could argue that's three concerns in one module: "split it." But all three concerns share information (the cache key depends on the args; the retry decision depends on whether the result was an error; the rate-limit pacing depends on `lastCallAt`). Q1 would fire if you split them — they'd duplicate state. The right call is what the codebase does: keep them together, accept that the body is a little dense, and the value is the simple `callTool` interface that hides all three. This is the right answer; Q3's question is asked and the answer is "no."

## The red flag

**Code that looks confusing when split, that would be obvious if combined.** The reverse holds too: code that looks confusing combined, that would be obvious if split. Both are real, both common. The smell: a reader keeps having to flip between two files while editing one logical change. That's a Q1 or Q2 case waiting to be combined. The opposite smell: a function has two paragraphs of comments separating its halves, the halves don't share variables, and you find yourself describing it as "this function does X *and* Y." That's a Q3 case waiting to be split.

## Carry forward

Part II is done — the core weapon of deep modules and how to shape them, layer them, and apportion work between them. Part III turns to the *edges*: error handling and the design discipline of considering more than one design. Chapter 9 starts with the most counter-intuitive error-handling principle in the book: **make the errors not happen.**

**See also:**
- `.aipe/study-software-design/03-insight-anomaly-silent-leak.md` — the Q2 case in detail.
- `.aipe/study-software-design/04-synthesize-recovery-duplication.md` — the Q1 case in detail.
- `audits/cleanup-2026-06-02.md` — the Q3 case is the `app/page.tsx` shallow-monster finding.
