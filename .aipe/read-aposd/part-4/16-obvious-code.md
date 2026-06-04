# Chapter 16 — Code should be obvious

## Opener

Chapters 11-15 gave you tools: good comments, precise names, consistency. Chapter 16 closes Part IV with the property all those tools serve. The goal isn't to write code; it's to write code that's *obvious* to the next reader.

## The idea

**Obviousness lives in the reader's head, not the author's.** Code that looked obvious to you while you were writing it can look opaque to the next person, because they don't have the context you had. The author is the worst possible judge of whether code is obvious. The test is: a reasonable reader, encountering this code cold, can predict what it does and what calling it would do — *without surprise.* When the reader's prediction is wrong even once, the code wasn't obvious; it was familiar to you.

## How it works

Two reading experiences, side by side. The right one is the goal; the left one is how most code gets shipped.

```
  Obvious-path reading vs the "huh?" moment

  ┌─ OBVIOUS ────────────────────────────────────────────────────────┐
  │                                                                   │
  │   reader sees:                                                    │
  │     parseAgentJson(text)                                          │
  │                                                                   │
  │   reader predicts:                                                │
  │     "this parses JSON from agent text, returns a value"           │
  │                                                                   │
  │   reader opens it (optional):                                     │
  │     yep, that's what it does, plus 5 quirks I didn't have to      │
  │     know about until I cared.                                     │
  │                                                                   │
  │   ▲                                                               │
  │   │ prediction matched reality. reader moves on at speed.         │
  └───────────────────────────────────────────────────────────────────┘


  ┌─ THE "HUH?" MOMENT ──────────────────────────────────────────────┐
  │                                                                   │
  │   reader sees:                                                    │
  │     await processData(input, true, null, opts)                    │
  │                                                                   │
  │   reader's mental model breaks:                                   │
  │     "wait, true for what? what's opts? does this throw?           │
  │     why is null there? is input mutated?"                         │
  │                                                                   │
  │   reader has to:                                                  │
  │     stop, open processData, read its body, find the doc           │
  │     (probably missing), reason about the boolean's effect,        │
  │     reason about the null's effect, reason about opts.            │
  │                                                                   │
  │   ▲                                                               │
  │   │ minutes of cognitive load. multiplied by every reader.        │
  └───────────────────────────────────────────────────────────────────┘
```

The book is specific about what destroys obviousness:

- **Hidden control flow.** Code that returns through exceptions when it could return normally; code with implicit side effects; code that branches in a way the surface doesn't reveal.
- **Generics without types.** A function whose `T` parameter could be anything and whose return is `any` makes the call site a guessing game. TypeScript catches a lot of this, but `any` and the casts that silently undo type narrowing can still hide.
- **Inconsistency.** From chapter 15. Two places doing the same job two ways means the reader can't generalize their understanding.
- **Boolean / positional parameters whose meaning isn't readable at the call site.** `process(input, true, null, opts)` is opaque; `process(input, { dryRun: true, abortSignal: null, opts })` is readable.

The fix list maps onto the previous five chapters: comment what isn't obvious (ch 12), name precisely (ch 13), draft the interface first (ch 14), stay consistent (ch 15). Chapter 16 is the integration: those five tools serve one property, obviousness, and the property is judged by the reader.

## Why it cuts complexity

Obvious code reduces cognitive load directly. The reader doesn't have to load context they don't have; they read the call site and move on. The cause attacked is obscurity at its purest — the *gap between what the reader can infer from the code and what they'd need to know to safely change it*. Close that gap and the third symptom (unknown unknowns) drops because the reader's predictions don't surprise them. The book's claim is that obviousness is the *measurable* outcome of all the readability disciplines, and the only honest test is "did a real reader hit a 'huh?' moment?"

## In your code

Three reads through the codebase, looking for obvious-vs-huh? moments.

**Obvious — the agent loop's termination condition.** `lib/agents/base.ts:121-124`:

```
  // No tools → we're done; collect text and return
  if (toolUses.length === 0) {
    const finalText = textBlocks.map((b) => b.text).join('');
    return { finalText, toolCalls };
  }
```

A reader sees this and immediately predicts: "when the model returns text without tool_use, we're done." The comment confirms it. The code matches. The variable names (`toolUses`, `textBlocks`, `finalText`) carry their shape. There's no clever inversion, no surprising branch, no implicit side effect. This is obvious code, and notice it's not because it's *short* — it's because the reader's prediction matched.

**Huh? — `app/page.tsx` mixing concerns.** From chapter 3 and chapter 8. A reader trying to find "where does the demo replay decision happen?" in `app/page.tsx` (817 lines) has to load the whole component, scan for the mode toggle effect, follow the conditional that branches between live and demo fetch paths, find the capture-mode escape hatch, and only then form a model of the flow. There are no fewer than four implicit dependencies between the toggle state, the briefing fetch, the demo replay, and the dev capture flow. None of them is *wrong* — but the reader hits a "huh?" moment within the first page of the file. The cleanup audit's "fix-soon, not fix-now" classification is the right call (chapter 2 strategic timing); the chapter-16 lesson is that the obviousness gap is real and the cost is paid on every read.

**Obvious in the small, huh? in the seam — the demo vs live mode toggle.** Each *piece* of the demo/live mode logic is locally clear: `useEffect` reads `localStorage`, `setMode` writes it, the fetch branches on `mode === 'demo'`. The cognitive load comes at the *seam* — multiple pieces of state interact (mode, briefing state, reconnect state, capture state) and no single comment explains the rules of the interaction. A reader who lands on one piece has to load all five to be safe. That's chapter 16's exact failure mode: locally obvious, globally opaque. The fix is either restructure (chapter 8: split) or a comment naming the rules of the interaction (chapter 12).

## The red flag

**A code reviewer says "wait, where does this happen?"** That's the most reliable signal of un-obviousness available, because the reviewer is, by definition, a fresh reader of the code. If the reviewer can't follow the control flow on the first read, neither will the next reader, and the next. The fix is *not* defending the code in PR comments — the reviewer is the test, not the obstacle. Listen to the surprise.

Related red flag: **the author saying "it's actually pretty simple, let me explain"** about their own code in a PR review. If the code needed verbal explanation to look simple, it isn't.

## Carry forward

Part IV is done — comments, names, consistency, obviousness. Part V steps back from techniques and into *judgment*: what to do when the principles point in different directions, when trends pressure you toward a shape that doesn't fit, and when performance demands measure against design. Chapter 17 starts with the book's most opinionated argument: **principles over fashion.**

**See also:**
- `lib/agents/base.ts:121-124` — obviousness done right.
- `audits/cleanup-2026-06-02.md` — the `app/page.tsx` `fix-soon` finding is the codebase's biggest pending obviousness debt.
