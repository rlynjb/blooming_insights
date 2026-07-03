# Chapter 6 — The hard parts

  ## Opening hook

The reflection round. "What was the hardest bug you fixed?" "What are you proudest of?" "What's the part you're least confident defending?" Most candidates fumble these because they treat them as personality questions. They're not. They're technical questions in emotional clothing.

The junior mistake is to give a small answer ("the CSS was hard") because a small answer feels safe. The mistake is bigger the more senior the interviewer is — because they've asked this question hundreds of times and know exactly what a real hard bug sounds like, what a real proudest-part sounds like, and what a real weakest-spot sounds like. Small answers here read as inexperience. Honest answers with receipts read as senior.

This chapter has three prompts. The hardest bug (the `insights.ts` concurrent-user wipe — AI wrote it, you accepted it, you found the bug in a code read, you shipped the fix). The proudest part (the portfolio hardening plan shipped end-to-end). And the least confident to defend (the `actionable_next_step` 0% baseline — a systemic prompt gap you have the receipts for but haven't yet fixed).

  ## The chapter-opening diagram

The confidence map — regions of the codebase annotated by how confidently you can defend each. Read left-to-right as "how much I can defend."

```
  Confidence map of blooming insights

  ┌─ CAN DEFEND WITH RECEIPTS ─────────────────────────────────┐
  │                                                            │
  │  ★ DataSource port (71 LOC, 4 uses, 0 caller changes)      │
  │  ★ AptKit adapter boundary (263 LOC, legacy preserved)     │
  │  ★ readNdjson kernel (64 LOC, 4 streaming consumers)       │
  │  ★ FaultInjectingDataSource decorator (9/3/0 receipt)      │
  │  ★ Portfolio hardening plan (6 phases, all shipped)        │
  │  ★ Prompt caching validated live in logs                   │
  │  ★ CI gate + baseline.json regression floor                │
  │                                                            │
  └────────────────────────────────────────────────────────────┘

  ┌─ CAN DEFEND, WITH THE HONEST STORY ────────────────────────┐
  │                                                            │
  │  ◆ insights.ts concurrent-user fix                         │
  │      AI wrote the bug, I accepted it, I found it, I fixed  │
  │      it. Honest story is the strong version.               │
  │                                                            │
  │  ◆ Deterministic supervisor (not LLM router)               │
  │      Right call for this product; eval flywheel would      │
  │      be needed to defend "not routing" on evidence.        │
  │                                                            │
  │  ◆ Session D pilot on the eval                             │
  │      AI-vs-AI, stamped with pilotWarning. Not real         │
  │      calibration yet. The honest defense is naming that.   │
  │                                                            │
  └────────────────────────────────────────────────────────────┘

  ┌─ LEAST CONFIDENT TO DEFEND ────────────────────────────────┐
  │                                                            │
  │  ▲ actionable_next_step 0% baseline                        │
  │     Every diagnosis scored 3/5 on "specific next action."  │
  │     Systemic prompt gap. I have the receipt across 7      │
  │     files. I know the fix shape (name the query/tool       │
  │     inline). Haven't shipped the fix yet.                  │
  │                                                            │
  │  ▲ Monitoring routing decision                             │
  │     Deferred (Week 3C). Eval doesn't measure monitoring    │
  │     yet. Routing blind to Haiku would be the anti-pattern  │
  │     the eval flywheel prevents. Honest: I don't know yet.  │
  │                                                            │
  │  ▲ Load numbers under real concurrency                     │
  │     Smoke tests only at N=2, N=3. Real N=30 run is         │
  │     ~$2.50 in API spend and hasn't happened yet.           │
  │                                                            │
  └────────────────────────────────────────────────────────────┘
```

This is the map. You have receipts for the left column, an honest story for the middle, and a bounded gap named for the right. This chapter defends across all three.

  ## The hardest bug — the concurrent-user wipe

┌─────────────────────────────────────────────────┐
│ THEY ASK                                        │
│   "What's the hardest bug you fixed on this      │
│   project?"                                     │
│                                                 │
│ WHAT THEY'RE TESTING                            │
│   Do you have a real bug story — one you        │
│   understood at the mechanism level? Was it a   │
│   copy-paste mistake or a real design issue?    │
│   Can you own the whole arc — how it got there, │
│   how you found it, how you fixed it?           │
└─────────────────────────────────────────────────┘

Say this, as one continuous story:

> *"The hardest bug wasn't a crash. It was a silent data corruption. `lib/state/insights.ts` was a `Map<insightId, Insight>` — the insights the monitoring agent produced were keyed by insight ID.*
>
> *That worked for one user. With two users on the same warm Vercel Function instance, the second user's briefing overwrote the first user's briefing in the same map. No error. No exception. The first user would refresh their feed and see the second user's insights. Silent wrong data.*
>
> *The origin is the honest part: AI wrote that map. I was moving fast, I accepted the shape without pushing back. `Map<id, entity>` is such a natural default it slipped past code review — my own review of my own generated code.*
>
> *I found it in a code read. I was working on the session-storage story for `useInvestigation` and read `insights.ts` for a different reason. When I saw `Map<insightId, Insight>` at the module scope, I stopped and asked myself: what happens with two users? The bug crystallized in about ten seconds.*
>
> *The fix was a `Map<sessionId, SessionFeed>` — session-keyed, not id-keyed. Each session gets its own feed of insights. The 24-test suite passed on the change; I added a concurrent-user test that would have caught the original bug. Shipped.*
>
> *The lesson I keep from that bug is that reviewing AI-generated code with a systems lens is different from reviewing it for correctness. The AI wrote code that was correct for one user. It took a systems question — 'what if there are two users?' — to see the problem. That question isn't in most code review checklists. It has to come from me."*

┃ "AI wrote this, I accepted it, I later read it as
┃  a real bug, here's the fix and it shipped."

┌─────────────────────────┬─────────────────────────┐
│ WEAK ANSWER             │ STRONG ANSWER           │
├─────────────────────────┼─────────────────────────┤
│ "There was this bug     │ "AI wrote a Map<id,     │
│ with the state          │ Insight> in insights.ts │
│ management where users  │ that worked for one     │
│ were getting the wrong  │ user and silently       │
│ data. I fixed it by     │ overwrote for two. I    │
│ using session IDs. It   │ caught it in a code     │
│ was tricky."            │ read — asked what       │
│                         │ happens with two users. │
│                         │ Fixed by session-keying │
│                         │ the map. Added a        │
│                         │ concurrent-user test."  │
├─────────────────────────┼─────────────────────────┤
│ Why it's weak:          │ Why it works:           │
│ "Tricky" without a      │ Names the origin        │
│ specific mechanism.     │ (AI wrote it), the      │
│ "State management" is   │ trigger for finding it  │
│ vague. Doesn't name     │ (code read for a        │
│ what actually broke.    │ different reason), the  │
│ Doesn't own the origin  │ fix mechanism (session  │
│ (AI wrote it). Doesn't  │ key), and the           │
│ have a receipt (the     │ regression prevention   │
│ test).                  │ (added a test).         │
└─────────────────────────┴─────────────────────────┘

  ## The proudest part — the portfolio hardening plan

┌─────────────────────────────────────────────────┐
│ THEY ASK                                        │
│   "What's the part of this project you're        │
│   proudest of?"                                 │
│                                                 │
│ WHAT THEY'RE TESTING                            │
│   Do you have a taste-test? Do you know what     │
│   good production engineering looks like        │
│   inside a project like yours? Or is your       │
│   answer "the UI is really nice"?               │
└─────────────────────────────────────────────────┘

Say this:

> *"The proudest part isn't a feature. It's the portfolio hardening plan I shipped as six sequenced phases, end-to-end, over four weeks. Every phase left a receipt. That's what I'm proudest of.*
>
> *Phase one — eval flywheel. Ten goldens, two rubrics, four dimensions each, a five-point scale, three verdicts. Judge-error resilience. Blind calibration protocol drafted.*
>
> *Phase two — observability. AptKit's `onCapabilityEvent` hook, wired to a receipt sink that `eval/report.eval.ts` reads back into p50, p95, p99 numbers.*
>
> *Phase three — cost controls. Prompt caching validated live in the logs — first call shows `cache_creation_input_tokens: 3168`, second call shows `cache_read_input_tokens: 3168`. My own Anthropic pricing helper because AptKit's built-in is OpenAI-only. `BudgetTracker` check-before-dispatch — a runaway loop cannot cost more than the ceiling.*
>
> *Phase four — load and fault. The load harness. The fault-injection decorator. Nine faults, three investigations, zero failures.*
>
> *Phase five — regression gate. `eval/baseline.json` committed. `eval/gate.eval.ts` blocks any regression more than 10 percentage points on any dimension.*
>
> *Phase six — CI. GitHub Actions typecheck plus tests plus build on every push and every PR. README rewritten with a tier-2 claims table and a one-command reproduction block.*
>
> *That's not architecture. That's not features. That's the difference between a project I built and a project I own. Anyone can build a demo. What I'm proudest of is that this system has receipts you can verify without asking me."*

┃ "Anyone can build a demo. What I'm proudest of
┃  is that this system has receipts you can verify
┃  without asking me."

  ## The least confident — the actionable_next_step 0% baseline

┌─────────────────────────────────────────────────┐
│ THEY ASK                                        │
│   "What's the part you're least confident        │
│   defending?"                                   │
│                                                 │
│ WHAT THEY'RE TESTING                            │
│   Can you name a real limitation without         │
│   collapsing? Do you have a plan? Can you        │
│   hold ground on "I know this is a gap, and     │
│   here's how I'd close it" without deflecting?  │
└─────────────────────────────────────────────────┘

This is the question senior interviewers watch hardest. Junior candidates deflect ("I don't really have any weak spots"). Middle candidates hedge ("everything's a work in progress"). Senior candidates name the thing directly, show the receipt, and describe the fix shape. Say this:

> *"The part I'm least confident defending is the `actionable_next_step` dimension in my diagnostic rubric. My eval scored 0% pass on that dimension across every case in the baseline run. Ten cases, zero passes.*
>
> *What that means concretely: every diagnosis my system produces gets a 3 out of 5 on 'names a specific next action.' Not a 1 — the diagnoses aren't empty. They name causes and cite evidence. But they don't name the specific query or tool the next investigator should run to confirm or extend the diagnosis. That's a real systemic gap.*
>
> *I have the receipt. Seven eval output files show the exact pattern — every case scored the same way for the same reason. Not noise, not judge variance. Systemic.*
>
> *I know the fix shape. The diagnostic agent's system prompt doesn't ask it to name the next action inline. It asks it to name causes and cite evidence. Adding a system-prompt directive like 'end every diagnosis with the specific EQL query or Bloomreach tool that would confirm or refine your conclusion' would push those scores from 3 to a probable 4.*
>
> *And I have the regression gate. If I shipped a prompt change that fixed `actionable_next_step` but regressed `evidence_grounding` more than 10 percentage points, the gate blocks the merge. That's the whole point of the flywheel — I can iterate on the prompt safely.*
>
> *What I don't have is the fix in the code. That's the honest gap. I know it, I have the receipt, I know the fix shape, the gate protects the fix — but the fix hasn't shipped. That's my next thing to work on."*

The move: name the gap directly with the number (0%). Name the receipt (seven files). Name the fix shape (system-prompt directive). Name the safety (regression gate). Name what's missing (the fix in the code). That's five specifics without hedging.

┌─────────────────────────┬─────────────────────────┐
│ WEAK ANSWER             │ STRONG ANSWER           │
├─────────────────────────┼─────────────────────────┤
│ "There's always things  │ "actionable_next_step   │
│ I could improve. The    │ scored 0% pass across   │
│ prompts probably need   │ 10 cases. Systemic      │
│ more iteration, and I'd │ prompt gap — every      │
│ love to have more time  │ diagnosis scores 3/5    │
│ to make the UI better." │ on 'specific next       │
│                         │ action.' Fix shape: add │
│                         │ a system-prompt         │
│                         │ directive to end        │
│                         │ diagnoses with the      │
│                         │ specific EQL query.     │
│                         │ Regression gate         │
│                         │ protects the fix.       │
│                         │ Haven't shipped yet."   │
├─────────────────────────┼─────────────────────────┤
│ Why it's weak:          │ Why it works:           │
│ Deflects. "Prompts need │ Names the exact metric  │
│ iteration" without a    │ (0%). Names the exact   │
│ metric. "UI could be    │ receipt (10 cases,      │
│ better" is not          │ same pattern). Names    │
│ engineering. Reads as   │ the fix shape. Names    │
│ inability to name a     │ what's missing. That's  │
│ real technical          │ what senior sounds      │
│ limitation.             │ like.                   │
└─────────────────────────┴─────────────────────────┘

  ## The follow-up decision tree

The hard-parts round tends to trigger the deepest follow-ups. Here's the tree:

```
  You name the concurrent-user bug and the fix.
        │
        ▼
  ┌─► "How did that ship without a test catching
  │    it earlier?"
  │      Honest: my initial test suite was pure-
  │      logic and agent-loop TDD with injected
  │      fakes. I didn't have concurrent-request
  │      tests — the failure surface wasn't in
  │      my mental model when I wrote the tests.
  │      Now it is. The test I added catches
  │      exactly this shape.
  │
  ├─► "How do you review AI-generated code now
  │    to catch this class of bug?"
  │      I read state-shape decisions with a
  │      systems lens explicitly. Any Map, any
  │      module-scope variable, any shared cache
  │      gets a 'what happens with two users' pass.
  │      It's not in a checklist yet. It probably
  │      should be.
  │
  └─► "Have you audited the rest of the codebase
       for the same pattern?"
        Partial. I went through lib/state/ and
        lib/mcp/ specifically. The other module-
        scope state I found is the demo snapshot
        cache which is read-only, and the OAuth
        store which is per-request via
        AsyncLocalStorage. Not a full audit.
        The gap is honest.

  You name the actionable_next_step baseline.
        │
        ▼
  ┌─► "Why haven't you shipped the fix?"
  │      Priority sequencing. The hardening plan
  │      had six phases. Shipping the CI gate had
  │      to come before shipping prompt fixes,
  │      because the prompt fix needs the gate to
  │      catch regressions. I finished phase six
  │      and now the prompt work is the next
  │      thing on the list. Order matters here.
  │
  ├─► "What if the fix regresses something else?"
  │      Exactly what the regression gate is for.
  │      GATE_MAX_REGRESSION defaults to 10 points.
  │      If the actionable-step fix pushes 3 to 4
  │      but regresses evidence_grounding from
  │      50% to 30%, that's a 20-point regression
  │      and the gate blocks the merge.
  │
  └─► "How do you know the fix shape is right?"
       I don't fully. It's a hypothesis. The
       eval flywheel is what tests it. Ship the
       prompt change against a branch, run
       eval/gate.eval.ts, look at the delta on
       every dimension. If actionable_next_step
       moves up and nothing else regresses, the
       hypothesis is right. If not, iterate.
```

  ## When you don't know

Even in the reflection round, there's territory that pushes past your depth. The one that most often does: interviewers asking about incidents at previous roles.

```
╔═══════════════════════════════════════════════╗
║ WHEN YOU DON'T KNOW                           ║
║                                               ║
║   They ask: "What's the hardest debugging      ║
║   experience you've had at scale? Have you    ║
║   debugged something running in production    ║
║   with real user impact?"                     ║
║                                               ║
║   Your production debugging history is         ║
║   enterprise frontend. That's real experience  ║
║   but a different class from the LLM-agent    ║
║   system you're defending here.               ║
║                                               ║
║   Say:                                        ║
║   "My production debugging history is         ║
║    enterprise frontend at FedEx, Amazon, and   ║
║    CoreWeave. Real user impact — layout       ║
║    regressions catching production traffic,   ║
║    Sentry alerts, the whole loop. Debugging   ║
║    LLM-agent systems in production is         ║
║    something I have not lived. Blooming       ║
║    insights is a system I built in isolation. ║
║                                               ║
║    What I have from that project is the       ║
║    debugging *infrastructure* — receipts       ║
║    through onCapabilityEvent, the eval        ║
║    flywheel, structured trace events. I've    ║
║    used those in dev, not in a production     ║
║    incident. If you want to walk me through   ║
║    how you triage LLM production issues, I'd   ║
║    take that as a coaching moment."           ║
║                                               ║
║   What this signals: honest about the two     ║
║   different kinds of debugging experience.     ║
║   Owns what you actually built. Doesn't       ║
║   stretch frontend debugging into agent-      ║
║   system debugging. Offers a concrete        ║
║   handoff.                                    ║
║                                               ║
║   Do NOT say:                                 ║
║   "Yeah, I've debugged tons of production     ║
║    issues, one time this AI thing was doing   ║
║    weird stuff and I fixed it."               ║
║   Vague inflation of experience is the        ║
║   killer here. Interviewers who've done       ║
║   real LLM incident response can tell        ║
║   within a sentence whether you have too.     ║
╚═══════════════════════════════════════════════╝
```

  ## What you'd change

The concurrent-user bug is a permanent lesson. What would change is your default when reading AI-generated code — the "what happens with two users" pass is now automatic. That's the real change: not a code change, a habit change.

The `actionable_next_step` gap wouldn't exist in a future project because your first agent prompt would already require the specific next action as a structural output. You'd write the eval before you wrote the prompt, and the eval would force the prompt shape. That's the flywheel in reverse — let the eval drive the prompt, not the other way around.

The proudest part — the portfolio hardening plan — you'd sequence identically. That work is exactly what it needed to be, in exactly the order it needed to happen. No change.

  ## The one-page summary

**Core claim.** Three hard parts, three honest positions. The hardest bug: AI wrote a `Map<id, Insight>` that silently corrupted feeds for two users; you caught it in a code read; you fixed it with session-keying. The proudest part: the six-phase portfolio hardening plan shipped end-to-end, every claim receipt-backed. The least confident: `actionable_next_step` 0% pass rate — you have the receipt, you know the fix shape, the regression gate protects the fix, but the fix isn't shipped.

**The questions covered.**

  → "What was the hardest bug?" → concurrent-user wipe in insights.ts. AI wrote it, you owned finding it and fixing it.
  → "What are you proudest of?" → six-phase hardening plan, all shipped, all receipt-backed.
  → "What's least confident?" → actionable_next_step 0% baseline. Systemic prompt gap named, fix shape named, gate protects, not yet shipped.
  → "Have you audited for the same class of bug?" → Partial audit, honest gap named.

**The pull quotes.**

  → *"AI wrote this, I accepted it, I later read it as a real bug, here's the fix and it shipped."*
  → *"Anyone can build a demo. What I'm proudest of is that this system has receipts you can verify without asking me."*

**What you'd change.** The habit of reading AI-generated code with a systems lens is now automatic. Sequence eval before prompt on future projects.
