# Chapter 6 — The hard parts

  ## Opening hook

The previous chapters walked the system. This one is about you. Three reflections the interviewer always reaches for in a senior loop: the hardest bug you fixed, the part you're most proud of, the part you're least confident defending. None of these are trick questions. All three are signal questions — what they're measuring is whether you can talk honestly about your own work without either bragging or collapsing.

The hardest answer is the third one. Most candidates say either "honestly, nothing — I'm confident in the whole thing" (instant fail; nobody is) or they fold into a list of things they don't know, which reads as anxiety. The senior move is to name *one* specific area you'd want time to dig into deeper before defending in the room — and to name it with the receipt of the work you *did* do there.

The picture below is the confidence map: which regions of the codebase you'd defend tightly, which you'd defend loosely, and which one you'd flag honestly. Walk it once. The body walks each reflection.

  ## The picture you draw — the confidence map

```
  Confidence map — what you'd defend tight, loose, or flag

  ┌─ TIGHT (you'd defend any line) ─────────────────────────────┐
  │  lib/data-source/types.ts (the seam, 71 LOC)                 │
  │  lib/agents/aptkit-adapters.ts (the bridge, 206 LOC)         │
  │  lib/streaming/ndjson.ts (the kernel)                        │
  │  lib/state/insights.ts (session-keyed; rewritten after bug)  │
  │  lib/mcp/auth.ts (you read the OAuth spec; wrote tests)      │
  │  lib/hooks/useInvestigation.ts (StrictMode-aware)            │
  └──────────────────────────────────────────────────────────────┘

  ┌─ LOOSE (you'd defend the shape; some lines you'd squint at) ─┐
  │  app/page.tsx (461 LOC — decomposed but still load-bearing)  │
  │  app/api/briefing/route.ts (orchestration + error mapping)   │
  │  components/feed/InsightCard.tsx (UI assembly)               │
  │  Tailwind v4 token surface (defaults you trusted)            │
  └──────────────────────────────────────────────────────────────┘

  ┌─ FLAG (the one you'd name honestly) ────────────────────────┐
  │  ★ the retired eval flywheel from the Olist phase            │
  │     — 4-pillar suite (detection / diagnosis / recommendation │
  │       / regression) built, surfaced 3 real bugs, retired     │
  │       with the substrate                                     │
  │     — same eval gap exists today against Synthetic, but      │
  │       with 3 receipts I didn't have before                   │
  └──────────────────────────────────────────────────────────────┘
```

Three bands. Tight on the architectural surfaces. Loose on the assembly. Flag on the part you genuinely built and genuinely retired — and would say so out loud rather than dance around.

  ## The body — the three reflections

  ### Reflection 1 — the hardest bug you fixed

```
  ┌─────────────────────────────────────────────────────────────┐
  │ THEY ASK                                                    │
  │   "What's the hardest bug you fixed on this project?"       │
  │                                                             │
  │ WHAT THEY'RE TESTING                                        │
  │   Can you tell a debugging story with a clear pre-state,    │
  │   diagnosis, and resolution? Do you take ownership of the   │
  │   bug being yours? Did you actually understand the fix or   │
  │   did you cargo-cult something that "worked"?               │
  └─────────────────────────────────────────────────────────────┘
```

You have four real candidates. Lead with the one that has the cleanest learn-from-it arc — the StrictMode double-fetch — and have the other three loaded for follow-ups.

**Strong answer (the lead):**

> "Hardest bug was a silent failure in `useInvestigation`. The hook had both a StrictMode guard — to prevent duplicate fetches under React's intentional double-mount in development — and a cleanup that aborted the in-flight fetch when the effect tore down. The guard and the cleanup-cancel were solving for *different lifetimes*. Under StrictMode, the cleanup aborted the only fetch I had on the way in. The guard then blocked the second mount from re-firing it. The investigation page rendered blank with no error, no log, no spinner.
>
> What made it hard wasn't the fix; it was the diagnosis. The cleanup looked correct in isolation. The guard looked correct in isolation. Both were idiomatic React patterns. The bug only existed in the interaction between them, and only under StrictMode's specific dev-only lifecycle.
>
> The fix was to keep the guard and drop the cancel-on-cleanup. The guard protects against a double fetch; the cancel protects against a leaked one. Under StrictMode they were solving for different lifetimes — and the guard was the right one to keep.
>
> The receipt is the comment in the file: *survives StrictMode by NOT cancelling the in-flight fetch on cleanup*. That comment is there so the next person who reaches in and 'fixes' the missing cleanup understands why it isn't there."

```
  ┃ "The guard protects against a double fetch;
  ┃  the cancel protects against a leaked one.
  ┃  Under StrictMode they were solving for
  ┃  different lifetimes."
```

```
  Likely follow-ups on the hardest-bug answer
        │
        ▼
  You give the StrictMode double-fetch story.
        │
        ├─► IF THEY ASK "ANY OTHER GOOD ONES?"
        │     The bare 500 from aesKey() (chapter 5). The
        │     "all at once" coverage reveal — server streamed
        │     fine, grid resolved from one bulk event;
        │     fix: emit coverage_item per category. The
        │     concurrent-user wipe — insights.ts had a
        │     module-level Map and clear() wiped other users
        │     mid-briefing; fix: session-keyed maps.
        │
        ├─► IF THEY ASK "HOW DID YOU FIND IT?"
        │     Add a console.log inside the fetch effect.
        │     Saw the fetch start and then the AbortError
        │     in the same tick. That was the tell — cleanup
        │     was running before the response landed.
        │
        ├─► IF THEY ASK "WHY NOT JUST DISABLE STRICTMODE?"
        │     StrictMode catches real bugs. The right fix
        │     was to write effects that survive double-mount,
        │     not to turn off the linter. Disabling
        │     StrictMode would hide other lifecycle bugs.
        │
        └─► IF THEY ASK "WHAT DID YOU LEARN?"
              Effects with cleanup are about lifetime, not
              correctness. Two correct-in-isolation patterns
              can compose into a wrong-under-pressure pattern.
              When in doubt, comment WHY the cleanup isn't
              there so the next person doesn't 'fix' it.
```

  ### Reflection 2 — the part you're most proud of

```
  ┌─────────────────────────────────────────────────────────────┐
  │ THEY ASK                                                    │
  │   "What part of this project are you most proud of?"        │
  │                                                             │
  │ WHAT THEY'RE TESTING                                        │
  │   Do you actually have good taste, or are you proud of the  │
  │   wrong things? Can you name something specific without     │
  │   tipping into "I built the whole thing"? Did the proud     │
  │   thing actually move the system?                           │
  └─────────────────────────────────────────────────────────────┘
```

**Strong answer:**

> "The AptKit migration. Specifically, the fact that I hand-rolled the agent loop first — deliberately, because I needed a `maxToolCalls` budget and a forced final-synthesis turn that the existing libraries didn't expose — and then *migrated* to `@aptkit/core@0.3.0` once its primitive surface caught up to what I needed.
>
> The reason I'm proud of it is that it's a decision I previously defended hard, and then revisited honestly. The hand-roll was the right call when I made it; the migration was the right call when I made *it*. Both decisions are mine to own.
>
> The Blooming side is three adapter classes in `lib/agents/aptkit-adapters.ts`, around two hundred LOC total — an `AnthropicModelProviderAdapter` for the model, a `BloomingToolRegistryAdapter` that wraps my DataSource seam, and a `BloomingTraceSinkAdapter` that translates AptKit's events into my UI's NDJSON contract. I own the boundary; AptKit owns the loop.
>
> The legacy loop is preserved at `lib/agents/base-legacy.ts:86-176` as a rollback receipt. If AptKit ever takes a direction that breaks my budget or synthesis semantics, I can peel back inside an afternoon. That's not a hypothetical — the hand-rolled loop is around ninety lines and the integration tests are still wired against it as a control."

```
  ┃ "It's a decision I previously defended hard,
  ┃  and then revisited honestly. Both calls are mine."
```

```
  ┌─────────────────────────┬─────────────────────────────────┐
  │ WEAK ANSWER             │ STRONG ANSWER                   │
  ├─────────────────────────┼─────────────────────────────────┤
  │ "Honestly the streaming │ "The AptKit migration —         │
  │  reasoning surface —    │  specifically that I hand-rolled│
  │  showing the agent's    │  the loop first, deliberately,  │
  │  work in real time is   │  for a budget + synthesis turn  │
  │  pretty cool."          │  the libraries didn't expose,   │
  │                         │  and then migrated when the     │
  │                         │  primitives caught up. Both     │
  │                         │  calls mine; legacy preserved."  │
  ├─────────────────────────┼─────────────────────────────────┤
  │ Why it's weak: "pretty  │ Why it works: names a decision  │
  │ cool" is taste-talk,    │ arc, not an artifact. Shows you│
  │ not engineering. Doesn't│ can revisit your own work. The │
  │ name a decision you     │ "I revisited what I previously │
  │ made or a tradeoff you  │ defended" move is the strongest │
  │ owned.                  │ senior signal in the chapter.  │
  └─────────────────────────┴─────────────────────────────────┘
```

  ### Reflection 3 — the part you're least confident defending

This is the hardest reflection, and the one that separates the strong candidate from the average one. Most candidates either deny they have a weak area (wrong) or list everything they don't know (also wrong). The senior move is to name *one* specific area, name it with the work you actually did there, and frame what you'd do next.

```
  ┌─────────────────────────────────────────────────────────────┐
  │ THEY ASK                                                    │
  │   "What part of this project are you LEAST confident         │
  │    defending?"                                               │
  │                                                              │
  │ WHAT THEY'RE TESTING                                         │
  │   Can you handle this without folding? Do you have a real    │
  │   self-assessment? Will you fabricate confidence under       │
  │   pressure or will you stay honest?                          │
  └─────────────────────────────────────────────────────────────┘
```

**Strong answer:**

> "The eval surface. Not because I haven't done eval work — I have receipts I'm going to walk you through — but because the eval surface that's *live in this codebase today* is thinner than the surface I built and retired.
>
> Here's the arc. In an earlier phase, I built a four-pillar eval suite: detection (does the monitoring agent find the anomaly we seeded?), diagnosis (does the diagnostic agent's conclusion pass a 5-criterion rubric at threshold 7 of 10?), recommendation (does the recommendation pass a 3-criterion rubric at threshold 4 of 5?), and regression (does the same input produce semantically-equivalent output across runs, judged structurally and by an LLM similarity judge?). Sonnet 4.6 ran as both the agent and the judge, with the judge calibrated by manual spot-check: I hand-scored a sample and confirmed 8-of-8 agreement on the rubrics and 3-of-3 on regression.
>
> I ran K=10 per anomaly across 3 seeded anomalies. That suite surfaced three real bugs.
>
> **Bug 1.** The recommendation judge caught a BRL cents-vs-Reais bug at run 8. The agent narrated implausible R$131,965 average order values — roughly twenty-six thousand dollars per order. The numbers were stored as cents and the agent was narrating them as Reais.
>
> **Bug 2.** Diagnosis confidence collapsed to a binary — 0 in 29 of 30 runs. Calibration was broken; the rubric scored 'pass' but the model's self-reported confidence wasn't varying.
>
> **Bug 3.** The regression baseline was 30%. The same input produced semantically-equivalent output only 30% of the time. That's not a 'flaky test' number; that's a 'conclusion stability problem' number.
>
> That suite ran against a SQLite substrate (the Olist-on-MCP layer) which was retired in PR #8 at commit `62c24d7` on 2026-06-18 — the substrate is gone, so the suite is gone with it. What's in the repo today is the test suite — 24 files, 221 passing — covering pure logic and agent loops with injected fakes. No live-agent eval. Same gap as before I built the suite — but I have three receipts I didn't have before: I built it end-to-end, I used it to find bugs, I know what version two looks like (against `SyntheticDataSource` instead of Olist).
>
> Owning the gap with the receipts of having done the work is the strongest L5 answer I can give you here."

```
  ┃ "Same eval gap as before. But with three receipts
  ┃  I didn't have: I built it end-to-end, I used it to
  ┃  find bugs, I know what version two looks like."
```

```
  Likely follow-ups on the eval-flywheel answer
        │
        ▼
  You give the build-and-retire arc.
        │
        ├─► IF THEY ASK "WHY DID YOU RETIRE IT?"
        │     The substrate it ran against — Olist on MCP —
        │     was a SQLite layer I removed when I focused
        │     the project on Bloomreach + Synthetic. The
        │     suite was coupled to that substrate. I made
        │     a deliberate call to retire the suite rather
        │     than port it half-broken to the new substrate.
        │
        ├─► IF THEY ASK "WHEN DO YOU REBUILD IT?"
        │     Against the Synthetic data source. Synthetic
        │     gives me deterministic seeded anomalies under
        │     the same DataSource surface the live agents
        │     use. That's exactly the shape I need to run
        │     the four-pillar suite again. Trigger: when
        │     the agent prompts are stable enough that
        │     drift-on-prompt-change is worth catching.
        │
        ├─► IF THEY ASK "WHY NOT KEEP RUNNING AGAINST OLIST?"
        │     Olist substrate adds a real maintenance cost
        │     for a substrate I don't ship. Eval against
        │     a substrate I don't ship trains me to optimize
        │     against the wrong distribution. Synthetic is
        │     under my control AND is real.
        │
        └─► IF THEY ASK "WHAT DID YOU LEARN FROM THE BUGS?"
              The cents-vs-Reais bug taught me to put unit
              awareness in prompts. The confidence-binary
              bug taught me self-reported confidence isn't
              calibrated by default. The 30% regression
              baseline taught me LLM systems aren't stable
              until you measure stability.
```

  ## When you don't know

This chapter's "don't know" trap is being asked about an area you flagged ("the eval surface") deeper than the work you did there. Specifically: statistical methodology of LLM-as-judge calibration, beyond the manual spot-check you did.

```
  ╔═══════════════════════════════════════════════════════════════╗
  ║ WHEN YOU DON'T KNOW                                           ║
  ║                                                               ║
  ║   They ask: "Your judge agreement was 8/8 by manual spot-     ║
  ║   check. What's the confidence interval on that? How do you   ║
  ║   know the judge isn't just confirming what the agent is      ║
  ║   doing?"                                                     ║
  ║                                                               ║
  ║   You did manual spot-check calibration. You did not run a    ║
  ║   Cohen's kappa or a held-out judge-on-judge agreement. The   ║
  ║   methodology gap is real.                                    ║
  ║                                                               ║
  ║   Say:                                                        ║
  ║   "I calibrated by manual spot-check — 8 of 8 agreement on    ║
  ║    the rubric scores, 3 of 3 on regression similarity. I did  ║
  ║    not run an inter-rater statistic like Cohen's kappa, and   ║
  ║    I did not run a second judge to test judge-on-judge        ║
  ║    agreement. The methodology I used is enough to catch the   ║
  ║    three bugs I caught; it's not enough to claim the judge    ║
  ║    is calibrated in a publication sense. If we wanted to dig  ║
  ║    into the statistical surface, can you start me off?"       ║
  ║                                                               ║
  ║   What this signals: a real methodology that did real work    ║
  ║   (caught 3 real bugs), honesty about the statistical depth   ║
  ║   you didn't reach, willingness to learn. The "started 8/8    ║
  ║   was load-bearing for catching those specific bugs" framing  ║
  ║   keeps the receipt while ceding the gap.                     ║
  ║                                                               ║
  ║   Do NOT say:                                                 ║
  ║   "The judge is calibrated because the spot-check agreed."    ║
  ║   That's a circular claim and a senior interviewer will       ║
  ║   spot it instantly. Better to cede the methodology gap and   ║
  ║   keep the receipt for the work.                              ║
  ╚═══════════════════════════════════════════════════════════════╝
```

  ## What you'd change

If you were redoing the eval surface today, you'd rebuild the four-pillar suite against `SyntheticDataSource` instead of the retired substrate, run it as a pre-merge check on prompt changes, and add a held-out judge as a calibration spike. The work to do this is straightforward — you have the rubrics, you have the seeded-anomaly pattern, you have the in-process data source under the same caller surface the live agents use. What you don't have is the time investment, and the trigger is the agent prompts stabilizing past their current rate of revision. Once a prompt change is a major event rather than a weekly tweak, eval-on-prompt-change is the right discipline.

  ## One-page summary

**Core claim:** the three reflection questions test honesty, not knowledge. The hardest bug story shows you can tell a debugging arc. The proudest part shows you can name a decision you revisited. The least confident part shows you can flag one specific gap *with receipts* instead of either denying or folding.

**Questions covered:**
- *Hardest bug?* → StrictMode double-fetch in `useInvestigation`. Guard and cleanup-cancel solving for different lifetimes. Kept guard, dropped cancel.
- *Proudest part?* → the AptKit migration. Hand-rolled deliberately; migrated when primitives caught up; legacy preserved. Decision arc, not artifact.
- *Least confident?* → the eval surface. Built a 4-pillar suite, caught 3 real bugs (cents-vs-Reais; binary confidence; 30% regression baseline), retired with substrate. Same gap as before — with three receipts I didn't have.

**Pull quotes:**
```
┃ "The guard protects against a double fetch;
┃  the cancel protects against a leaked one.
┃  Under StrictMode they were solving for different lifetimes."
```
```
┃ "Same eval gap as before. But with three receipts
┃  I didn't have: I built it end-to-end, I used it to
┃  find bugs, I know what version two looks like."
```

**What you'd change:** rebuild the four-pillar eval suite against `SyntheticDataSource`, run it as a pre-merge check on prompt changes, add a held-out judge for calibration.
