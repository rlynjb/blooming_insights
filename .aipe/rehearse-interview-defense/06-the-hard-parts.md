# Chapter 6 — The hard parts

This is the chapter that decides whether the interviewer leaves the room thinking *"this person ships things"* or *"this person passed three rounds of code-with-AI without ever debugging anything."* The reflection questions in this chapter — the hardest bug, the proudest part, the least confident part — are not soft questions. They are the highest-signal questions in the interview.

The trap is to over-prepare a clean story. Real debugging stories aren't clean. They have the wrong-hypothesis-for-an-hour part, the wait-it-was-actually-this part, the I-can-explain-it-now-but-I-couldn't-then part. **Those are the parts that prove you shipped it.** Strip them out and the story sounds like a postmortem written by someone who wasn't there.

This chapter has three hard bugs from real work on this codebase, the part of the project you're proudest of, and the part you're least confident defending — owned with the receipts that turn an L4 answer into an L5 one.

## The confidence map — what to defend hard, what to be honest about

The chapter's visual anchor. Trace the regions; the color tells you the defense posture.

```
  blooming insights — confidence map by region

  ┌──────────────────────────────────────────────────────────────┐
  │ HIGH CONFIDENCE — defend hard, walk the code                  │
  ├──────────────────────────────────────────────────────────────┤
  │                                                                │
  │  · Adapter boundary at lib/agents/aptkit-adapters.ts          │
  │    (3 classes, ~200 LOC; library owns loop, I own boundary)    │
  │                                                                │
  │  · DataSource seam at lib/data-source/types.ts                 │
  │    (survived 2 adapter swaps; receipt-driven)                  │
  │                                                                │
  │  · Streaming kernel at lib/streaming/ndjson.ts                 │
  │    (64 LOC, 4 surfaces)                                        │
  │                                                                │
  │  · Page decomposition (app/page.tsx 461 LOC + 3 hooks)         │
  │                                                                │
  │  · Session-keyed insights map (the wipe bug fix, shipped)      │
  │                                                                │
  └──────────────────────────────────────────────────────────────┘

  ┌──────────────────────────────────────────────────────────────┐
  │ MEDIUM CONFIDENCE — defend with the receipt, name the gap    │
  ├──────────────────────────────────────────────────────────────┤
  │                                                                │
  │  · MCP transport / envelope handling                          │
  │    (transport.ts works; corner cases I haven't exhausted)      │
  │                                                                │
  │  · Reconnect policy (useReconnectPolicy)                       │
  │    (works in dev; not stress-tested in a real revoke storm)    │
  │                                                                │
  │  · Prompt discipline (the "cite evidence" / "lower confidence" │
  │    pattern in diagnostic.ts; no live eval to verify regression)│
  │                                                                │
  └──────────────────────────────────────────────────────────────┘

  ╔══════════════════════════════════════════════════════════════╗
  ║ LOWER CONFIDENCE — own honestly, walk the receipts of having ║
  ║                    done the work, name what version 2 looks  ║
  ║                    like                                       ║
  ╠══════════════════════════════════════════════════════════════╣
  ║                                                                ║
  ║  · Eval coverage TODAY                                         ║
  ║    Phase 3 4-pillar eval suite was built, used, retired with   ║
  ║    the Olist substrate. Three receipts: built it end-to-end,   ║
  ║    used it to find 3 real bugs, know what v2 looks like        ║
  ║    against the synthetic adapter. The gap is real AND owned    ║
  ║    with evidence — strongest possible L5 framing.              ║
  ║                                                                ║
  ║  · OAuth PKCE internals beyond the SDK surface                 ║
  ║    Defaulted-to. Can defend the wrapper, not the protocol.     ║
  ║                                                                ║
  ║  · Multi-instance / cross-process state                        ║
  ║    Designed for, not shipped. Seam is ready, trigger isn't.    ║
  ║                                                                ║
  ╚══════════════════════════════════════════════════════════════╝
```

The lower-confidence region is the most important part of this map. Most candidates try to hide it. You're going to lead with it — and you're going to lead with it well, because you have the receipts that turn the gap into a strength.

## Hard bug 1 — StrictMode double-fetch in `useInvestigation`

```
  ┌─────────────────────────────────────────────────┐
  │ THEY ASK                                        │
  │   "Tell me about the hardest bug you fixed in   │
  │    this project."                               │
  │                                                 │
  │ WHAT THEY'RE TESTING                            │
  │   Can you walk me through a real debugging      │
  │   sequence — wrong hypothesis, isolation,       │
  │   correct fix? Do you understand the framework  │
  │   you're using deeply enough to debug its       │
  │   interaction with your code?                   │
  └─────────────────────────────────────────────────┘
```

The strong answer, told in your voice with the wrong-turn included:

> "Symptom: in development, the logs sidebar on the investigate page was empty. In production, it worked fine. I had a hook — `useInvestigation` — that opened an NDJSON stream, parsed events, and pushed them into state. In dev I'd open the page and see nothing; in prod the same page would render the trace as expected.
>
> "My first hypothesis was a caching issue — that maybe the dev server was serving a stale bundle. Spent an hour confirming that wasn't it. Second hypothesis was an env-var difference. Also not it.
>
> "Then I added a console log at every event the hook handled and watched the order in dev. Two fetches started. The cleanup ran between them. Both got cancelled. Neither delivered events.
>
> "That's when I named the actual mechanism. **React StrictMode runs effects twice in development.** I had two protections in the hook: a `useRef` latch — the **started-guard** — to prevent the once-per-mount fetch from running twice, and an AbortController in cleanup — the **cleanup-cancel** — to abort the in-flight fetch on unmount. The guard worked. The cancel also worked. Together they cancelled the only fetch I had.
>
> "The way to see it: the guard protects against a double fetch; the cancel protects against a leaked one. They are solving for different lifetimes. The guard says 'only one fetch per mount sequence.' The cancel says 'when this mount goes away, kill its fetch.' Under StrictMode, the dev sequence is mount → cleanup → remount. The first mount fires the fetch. The cleanup cancels it. The remount asks the guard 'should I fire?' and the guard says 'no, one's already started' — but the started one is dead. Empty logs.
>
> "Fix: **keep the guard, drop the cancel-on-cleanup.** `setState` after unmount is a safe no-op in React — the framework just ignores the update. The pending fetch completes; if the component is gone, the result is discarded; if the user back-navs (which the hook supports through `sessionStorage`), the result is there for them. That's what the live code at `lib/hooks/useInvestigation.ts` does today."

```
  ┃ "The guard protects against a double fetch; the
  ┃  cancel protects against a leaked one. Under
  ┃  StrictMode they were solving for different
  ┃  lifetimes — together they cancelled the only
  ┃  request I had."
```

Trace of the bug, side-by-side:

```
  WHAT I EXPECTED                         WHAT ACTUALLY HAPPENED (dev only)
  ─────────────                           ──────────────────────────────────
  mount     → fetch starts                mount     → fetch A starts
                                          cleanup   → fetch A aborted
                                          remount   → guard: "A started"
                                                       → skip fetch B
                                          result: empty logs forever
```

## Hard bug 2 — the bare 500 from `/api/briefing` in production

```
  ┌─────────────────────────────────────────────────┐
  │ THEY ASK                                        │
  │   "Tell me about a bug that only showed up in   │
  │    production."                                 │
  │                                                 │
  │ WHAT THEY'RE TESTING                            │
  │   Can you isolate prod-only bugs by contrast?   │
  │   Do you reach for error messages, or do you    │
  │   leak bare 500s into production?               │
  └─────────────────────────────────────────────────┘
```

> "Symptom: in production, `/api/briefing` returned a bare 500 — no error body, just a 500 status. The browser's error panel showed 'something went wrong.' In demo mode (the cached snapshot) the same page returned 200. In local dev everything worked.
>
> "I had three things to vary: demo vs live, prod vs dev, my local Vercel vs deployed Vercel. The contrast that isolated it was **demo=200, live=500 in prod**. Demo skips the entire credentialed-setup path. So whatever was failing was in the setup that demo doesn't run. That narrowed it from 'the route is broken' to 'something in the auth bootstrap is throwing pre-stream.'
>
> "The actual cause: `aesKey()` in `lib/mcp/auth.ts` throws if `AUTH_SECRET` is unset. I had set it in dev (and in my local `.env.local`) but not in the production Vercel env. The throw happened during the synchronous setup *before* the route started streaming, which means it never reached the part of the handler that emits structured error JSON. Next.js's default behavior is to send a bare 500.
>
> "Two fixes. **Immediate**: set the env var in production. **Real**: wrap the setup in a try/catch that returns a structured error JSON with the actual cause — `AUTH_SECRET is required in production; set it in your Vercel project settings.` Now if anyone else hits this misconfiguration, they get the actual message in the UI's error panel, not a bare 500. The lesson is that pre-stream throws need their own error path; you can't rely on the stream's error envelope to catch them."

```
  ┌─────────────────────────┬─────────────────────────┐
  │ WEAK PROD BUG STORY     │ STRONG PROD BUG STORY   │
  ├─────────────────────────┼─────────────────────────┤
  │ "I had a bug where the  │ "Bare 500 in prod only. │
  │ API was returning 500   │ Demo=200, live=500 in   │
  │ in production. I fixed  │ prod isolated it to the │
  │ it by setting the right │ credentialed-setup path │
  │ environment variable."  │ that demo skips. Cause: │
  │                         │ aesKey() throws on      │
  │                         │ missing AUTH_SECRET     │
  │                         │ before the route starts │
  │                         │ streaming. Two fixes:   │
  │                         │ set the env var, and    │
  │                         │ wrap the setup in a     │
  │                         │ try/catch returning a   │
  │                         │ real error JSON."       │
  ├─────────────────────────┼─────────────────────────┤
  │ Why it's weak:          │ Why it works:           │
  │ Skips the isolation     │ Shows the contrast      │
  │ method. Reads like the  │ that isolated the bug.  │
  │ root cause was obvious  │ Names the file and the  │
  │ from the start.         │ specific failing call.  │
  │                         │ Names the real fix      │
  │                         │ (not just the env var). │
  └─────────────────────────┴─────────────────────────┘
```

## Hard bug 3 — the "all at once" coverage reveal

> "Symptom that bugged me: I'd added per-category coverage tracking to the monitoring agent — each category was supposed to light up in the UI grid as the agent confirmed it had been checked. But in practice the grid sat empty and then resolved all-at-once at the end. The streaming reasoning log next to it was streaming correctly, per category.
>
> "First hypothesis was that the server was buffering. Measured per-line arrival on the NDJSON stream — it wasn't. Each category's reasoning step was arriving at its real time. So the server was streaming fine; the issue was downstream.
>
> "Read the UI code carefully. The grid was bound to a single bulk `coverage` event that was emitted only once, at the end of the run, with the full set of confirmed categories. The per-category statuses I wanted weren't being emitted at all — only the final aggregate.
>
> "Fix: emit a `coverage_item` event per category as the agent confirmed it, in addition to (or instead of) the final aggregate. UI binds to those. Now in demo the categories reveal tile-by-tile, paced. In live the gate is still effectively instant because the categories confirm fast — but the wiring is right, so when the agent slows down (under a rate-limit storm, for example), the user sees real per-tile progress instead of a frozen grid.
>
> "Lesson: 'the stream is broken' is the wrong first hypothesis when the stream is *also* working for a different surface. The bug is almost always at the event-shape boundary — what the producer emits vs what the consumer binds to."

## The proudest part — what to lead with

```
  ┌─────────────────────────────────────────────────┐
  │ THEY ASK                                        │
  │   "What's the part of this project you're most  │
  │    proud of?"                                   │
  │                                                 │
  │ WHAT THEY'RE TESTING                            │
  │   Do you know what's actually load-bearing in   │
  │   your own work? Will you point at the          │
  │   shiniest feature or at the discipline that    │
  │   made the shiny feature possible?              │
  └─────────────────────────────────────────────────┘
```

> "Not the agents — the **adapter boundary**. `lib/agents/aptkit-adapters.ts`. Three Blooming-owned classes, about 200 lines, between my code and `@aptkit/core@0.3.0`. The reason I'm proud of it isn't the size; it's that it captures a discipline I revisited.
>
> "I started by owning the agent loop myself — `runAgentLoop` is still at `lib/agents/base-legacy.ts` lines 86 to 176. That was deliberate, because I needed two things off-the-shelf libraries don't always give you: a hard `maxToolCalls` budget against a rate-limited upstream, and a forced final synthesis turn so the loop terminates with a structured answer instead of a half-finished tool call. When `@aptkit/core` reached `0.3.0` with a clean primitive surface, I read the source, confirmed both disciplines survived in the new shape, and migrated. The legacy is preserved as my rollback receipt.
>
> "What makes this the proudest part: it's the single most consequential decision-revisit in the project. *Library owns the loop. I own the boundary.* Three small classes, 200 lines, and a paragraph in the README that says exactly what each adapter is responsible for. That's the kind of decision-shape I'd want to defend at any senior level."

```
  ┃ "I own the boundary; AptKit owns the loop. Three
  ┃  small adapter classes, about 200 lines, and the
  ┃  legacy loop is preserved for the day I need to
  ┃  peel back to it."
```

## The least confident part — the eval flywheel arc

This is the L5 closer. Get this answer right and you've shown the interviewer something most candidates can't: that you can own a gap *with the receipts of having done the work*. The gap is real; the receipts make it the strongest possible version of owning it.

```
  ┌─────────────────────────────────────────────────┐
  │ THEY ASK                                        │
  │   "What's the part of this project you're       │
  │    least confident defending?"                  │
  │                                                 │
  │ WHAT THEY'RE TESTING                            │
  │   This is the highest-signal question in any    │
  │   senior interview. Honest answer with receipts │
  │   = L5. Honest answer without receipts = L4.    │
  │   Dishonest answer = no offer.                  │
  └─────────────────────────────────────────────────┘
```

The strong answer, in your voice, told as an arc:

> "Eval coverage today. I don't have a live eval suite running against the current code path. Let me tell you why that's the honest answer, and why I'd give it the same way at L5 as at L4 — because the receipts are different.
>
> "Earlier in the project I built a **Phase 3, four-pillar eval suite**. The pillars were detection (precision and recall on anomaly detection), diagnosis (a five-criterion rubric with a pass threshold of 7), recommendation (a three-criterion rubric with a pass threshold of 4), and regression (a capture-and-score pattern combining structural diffs with an LLM similarity judge). The agent under test was Sonnet 4.6; the judge was also Sonnet 4.6. K=10 runs per anomaly across 3 seeded anomalies in an Olist SQLite substrate.
>
> "I calibrated the LLM-as-judge with manual spot checks — 8 of 8 and 3 of 3 agreement on independent samples — so I knew the judge wasn't rubber-stamping its own outputs.
>
> "The suite found **three real bugs** the unit tests would never have caught. First: a **BRL cents-vs-Reais unit-narration bug**. The recommendation judge flagged it at run 8 when the agent claimed implausible R$131,965 average order values — about $26,000 per order, obviously wrong. Cents were stored in the data; the agent was narrating them as Reais. Second: a **binary calibration breakdown**. The diagnosis confidence field was zero in 29 of 30 runs — always 'high' because the prompt always said 'three hypotheses tested,' never a real calibration. Third: **conclusion stability**. The 30% regression baseline meant the same input produced semantically-equivalent output only 30% of the time across runs.
>
> "Then I retired the eval suite — PR #8, commit 62c24d7, in June — when I retired the Olist substrate. The scorer was hard-coded to Olist's seeded anomaly IDs; it wouldn't run against the synthetic adapter without rewrites.
>
> "So here's where I am right now: **same eval gap as before I built Phase 3, but with three receipts I didn't have then.** I built it end-to-end. I used it to find three real bugs that shipped fixes. I know exactly what version 2 looks like — the same four-pillar pattern, rewired against the synthetic adapter, with the judge calibrated against fresh manual samples.
>
> "If you ask me 'why don't you have an eval today,' the answer isn't 'I haven't gotten to it.' The answer is 'I had one, I used it, I retired it with its substrate, and I haven't rebuilt it against the new substrate yet.' That's the gap I'd close next, and I can walk you through the rebuild design if you want."

```
  ┃ "Same eval gap as before Phase 3, but with three
  ┃  receipts I didn't have then: I've built it
  ┃  end-to-end, I've used it to find three real
  ┃  bugs, and I know what version two looks like."
```

The decision tree this answer opens up:

```
  You give the "eval gap with receipts" answer.
        │
        ▼
        ├─► "Walk me through one of the bugs the eval caught."
        │     Lead with the BRL cents-vs-Reais bug. It's the
        │     most concrete and the easiest to picture. "The
        │     judge flagged it at run 8 when the agent claimed
        │     R$131,965 average order values — about $26K per
        │     order. Cents stored, narrated as Reais."
        │
        ├─► "What does v2 look like?"
        │     Same four pillars (detection / diagnosis /
        │     recommendation / regression). Rewired against
        │     the synthetic adapter (deterministic, in-
        │     process, no network — perfect for evals). The
        │     judge needs fresh manual calibration on the
        │     new substrate. The scorer hard-coded to Olist
        │     IDs gets replaced with one parameterized on
        │     synthetic-adapter scenario IDs.
        │
        ├─► "Why retire the eval with the substrate?"
        │     The scorer was substrate-coupled — it knew
        │     about specific seeded anomalies in Olist by
        │     ID. Decoupling it from the substrate is a
        │     non-trivial rewrite. I made the call to retire
        │     it cleanly rather than carry it half-working.
        │     The right shape of v2 is parameterized on
        │     substrate, not hand-coded against one.
        │
        └─► "How did you calibrate the LLM judge?"
              Manual spot-check, 8/8 and 3/3 agreement on
              independent samples. The point of the
              calibration was to prove the judge wasn't
              rubber-stamping its own outputs — same model,
              same family. The agreement on independent
              samples is the signal.
```

## When you don't know

The least-confident answer above leans into the gap. But there's another territory in this chapter where the right move is the **When You Don't Know** box: **the internals of `@aptkit/core`'s loop**. You built three adapters against its surface; you didn't write the loop.

```
  ╔═══════════════════════════════════════════════╗
  ║ WHEN YOU DON'T KNOW                           ║
  ║                                               ║
  ║   They ask: "Walk me through AptKit's loop    ║
  ║   line by line. How does it decide when to    ║
  ║   stop?"                                      ║
  ║                                               ║
  ║   You haven't read every line of the library. ║
  ║   You read enough to confirm your two         ║
  ║   disciplines survived.                       ║
  ║                                               ║
  ║   Say:                                        ║
  ║   "I haven't memorized AptKit's loop line by  ║
  ║    line. What I can tell you is the two       ║
  ║    properties I confirmed before I migrated   ║
  ║    onto it: a hard tool-call budget, and a    ║
  ║    forced final-synthesis turn. The library   ║
  ║    expresses both through its configuration   ║
  ║    surface — I tested both worked, and the    ║
  ║    legacy hand-rolled loop is preserved at    ║
  ║    base-legacy.ts as my fallback if I ever    ║
  ║    need to peel back. Want me to walk through ║
  ║    how the forced-synthesis pattern works in  ║
  ║    my own code first?"                        ║
  ║                                               ║
  ║   What this signals: you know what you owned, ║
  ║   you know what you delegated, and you can    ║
  ║   re-route to a thread you can walk in depth. ║
  ║                                               ║
  ║   Do NOT say:                                 ║
  ║   "It uses a standard agent loop pattern      ║
  ║    where it calls the model and then executes ║
  ║    tools and then..." Vague paraphrase of a   ║
  ║    library you haven't read carefully will    ║
  ║    collapse on the first detail probe.        ║
  ╚═══════════════════════════════════════════════╝
```

## What you'd change about the hard parts

The one thing you'd reconsider in this chapter is **rebuilding the eval suite against the synthetic adapter before the next big agent change**. The substrate is right (deterministic, in-process, perfect for evals). The pattern is right (four pillars, calibrated LLM judge). What's missing is the wiring time. The trigger is any change to a prompt or to the agent loop discipline — at that point I want the regression baseline back, with v2's parameterized scorer.

## One-page summary

**Core claim:** The hardest-bug, proudest-part, and least-confident answers are the highest-signal in any senior interview. Tell them with the wrong turns included, the file paths cited, and the receipts of having done the work.

**The three hard bugs in one line each:**
- **StrictMode double-fetch** → guard + cancel were solving for different lifetimes; fix is keep the guard, drop the cancel.
- **Bare 500 from `/api/briefing`** → pre-stream `aesKey()` throw on missing `AUTH_SECRET`; fix is try/catch returning real error JSON.
- **All-at-once coverage reveal** → server streamed fine; UI was bound to a bulk event; fix is emit `coverage_item` per category.

**Proudest part:** the adapter boundary at `lib/agents/aptkit-adapters.ts` — library owns the loop, I own the boundary, legacy preserved.

**Least confident part:** eval coverage today — owned with the receipts of the Phase 3 build-and-retire arc, three real bugs caught, and a clear v2 plan against the synthetic adapter.

**Pull quotes:**
```
  ┃ "The guard protects against a double fetch; the
  ┃  cancel protects against a leaked one. Under
  ┃  StrictMode they were solving for different
  ┃  lifetimes — together they cancelled the only
  ┃  request I had."

  ┃ "Same eval gap as before Phase 3, but with three
  ┃  receipts I didn't have then."

  ┃ "I own the boundary; AptKit owns the loop."
```

**What you'd change:** rebuild the eval suite against the synthetic adapter — the substrate and the pattern are right, the wiring is the work. Trigger is any change to a prompt or to the loop discipline.
