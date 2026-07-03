# Chapter 7 — The counterfactuals

  ## Opening hook

The senior-engineer move is to volunteer what you'd reconsider before being asked. Most candidates wait for the interviewer to ask "what would you do differently?" and treat the question defensively. Senior candidates use the reflection question as a hook to demonstrate they own the whole system — not just what shipped, but what could have shipped differently.

But there's a trap. If you fabricate regrets to sound self-aware, you signal the opposite. "I really regret not writing more tests" from someone who wrote 221 passing tests reads as performative. The correct posture is a bounded list of *real* things you'd reconsider, each with the *trigger* that would cause you to actually make the change — and a bounded list of things you would NOT change, with receipts.

This chapter walks the four decisions you'd reconsider (with triggers) and the four you would keep (with receipts). Both lists are load-bearing. The reconsider list shows self-awareness; the would-not list shows conviction. Volunteer both.

  ## The chapter-opening diagram

The counterfactuals matrix. Each decision on the left; what you'd reconsider on the right; the trigger for reconsidering in the middle.

```
  Counterfactuals matrix — what you'd reconsider, when

  DECISION                    │ TRIGGER TO RECONSIDER      │ THE CHANGE
  ─────────────────────────── │ ──────────────────────────  │ ────────────
                              │                            │
  No DB (in-memory state)     │ multi-instance deploy      │ durable
    concurrent-user wipe        or cross-instance state    │ session
    resolved via session-key    surfaces as a real issue   │ store
                              │                            │
  Monitoring routing          │ ONE real production        │ route
    DEFERRED — not routed to    briefing measured for       │ monitoring
    Haiku on Sonnet cost        cost and quality           │ to Haiku
                              │                            │
  Blind calibration           │ 30-60 min of blind human   │ swap
    Session D pilot was         labeling by me OR a        │ Session D
    AI-vs-AI, pilotWarning      collaborator               │ for real
    stamped                     data                       │ data
                              │                            │
  Real load run               │ ~$2.50 in API spend +      │ full
    smoke tests at N=2, N=3     ~2 hours to run and         │ LOAD_N=30
    only                        analyze                    │ LOAD_K=5
                              │                            │

  WOULD NOT CHANGE — with receipts

  ─────────────────────────── │ ──────────────────────────
                              │
  NDJSON + readNdjson kernel  │ 4 streaming surfaces
                              │ consume one 64-LOC kernel
                              │
  DataSource seam + adapters  │ 4 uses, 0 caller changes
                              │
  AptKit primitive boundary   │ Legacy loop preserved as
                              │ rollback receipt
                              │
  Portfolio hardening seq.    │ 6 phases, all shipped,
                              │ every claim receipt-backed
                              │
```

Four decisions to reconsider. Four decisions to keep. Every reconsideration has a trigger; every keep has a receipt. This is what the reflection round should look like.

  ## The reconsider list — four things you'd revisit

  ### 1. No database — trigger: multi-instance deploy

┌─────────────────────────────────────────────────┐
│ THEY ASK                                        │
│   "You don't have a database. Wouldn't you        │
│   want one?"                                    │
│                                                 │
│ WHAT THEY'RE TESTING                            │
│   Did you consider persistence? Do you know     │
│   what state actually needs to persist? Or did  │
│   you just skip the storage layer because it's  │
│   annoying?                                     │
└─────────────────────────────────────────────────┘

Say this:

> *"I don't have a database and I'm intentional about that. State lives in `lib/state/insights.ts` as `Map<sessionId, SessionFeed>` — in-memory, session-keyed. The concurrent-user issue that used to exist here is fixed — but the underlying decision is 'no persistence at all,' and I own that.*
>
> *The trigger to reconsider is any multi-instance deploy. Vercel Functions can cold-start on any instance; if my traffic warrants multi-instance capacity, session state has to survive an instance change. Today it doesn't.*
>
> *The change would be a durable session store. Vercel KV or Upstash Redis for the low-latency path. The DataSource port doesn't cover session state today — that's the miss I'd fix. If I'd built `SessionStore` as a port from day one alongside `DataSource`, the swap would be a same-day change. Instead it would be a real refactor.*
>
> *The reason I haven't shipped it: no production users yet. Building a durable session store for zero users is premature. But I know the trigger, I know the fix, and the DataSource seam shape is the pattern to reach for."*

  ### 2. Monitoring routing to Haiku — trigger: one real briefing measured

This one is the interesting reconsideration because it's a decision you *deferred* on purpose. That's a senior signal by itself.

┌─────────────────────────────────────────────────┐
│ THEY ASK                                        │
│   "Your monitoring agent runs on Sonnet. That's │
│   expensive. Why not route it to Haiku for       │
│   cost?"                                        │
│                                                 │
│ WHAT THEY'RE TESTING                            │
│   Do you know the cost/quality tradeoff? Have   │
│   you thought about model routing, or did you   │
│   just pick one model?                          │
└─────────────────────────────────────────────────┘

Say this:

> *"I deferred that decision on purpose. Here's the reasoning.*
>
> *Routing monitoring to Haiku is exactly the kind of cost optimization that sounds obvious. But my eval flywheel today measures only diagnosis and recommendation quality. It does not measure monitoring quality. If I routed monitoring to Haiku blind, I'd be making the same anti-pattern the eval flywheel exists to prevent — optimizing without measuring.*
>
> *So the deferral is not laziness. It's evidence-driven. Until I have a monitoring rubric with goldens, routing to Haiku is a change I can't measure. And a change I can't measure is a change I don't ship.*
>
> *The trigger to reconsider is one real production briefing measured for both cost and quality. The change is straightforward — the model provider is injected into `AnthropicModelProviderAdapter`, so routing monitoring to a different model is a one-line change. The gate is the measurement, not the implementation.*
>
> *That's the honest version of 'why haven't you optimized cost more.' Because I built the flywheel to stop myself from doing exactly that."*

┃ "The deferral is not laziness. It's evidence-driven.
┃  A change I can't measure is a change I don't ship."

┌─────────────────────────┬─────────────────────────┐
│ WEAK ANSWER             │ STRONG ANSWER           │
├─────────────────────────┼─────────────────────────┤
│ "Yeah, I could probably │ "I deferred that on     │
│ save some money by      │ purpose. My eval        │
│ using Haiku for the     │ measures diagnosis and  │
│ monitoring pass. I'll   │ recommendation quality  │
│ get to that."           │ but not monitoring. If  │
│                         │ I routed to Haiku blind │
│                         │ I'd be optimizing       │
│                         │ without measuring —     │
│                         │ the exact anti-pattern  │
│                         │ the flywheel exists to  │
│                         │ prevent. Trigger: one   │
│                         │ real briefing measured. │
│                         │ Change is a one-line    │
│                         │ swap through the        │
│                         │ ModelProvider adapter." │
├─────────────────────────┼─────────────────────────┤
│ Why it's weak:          │ Why it works:           │
│ "I'll get to that"      │ Frames the deferral as  │
│ signals procrastination │ evidence-driven,        │
│ or lack of framework.   │ demonstrates you built  │
│ Doesn't defend the      │ the flywheel to make    │
│ deferral. Doesn't       │ these decisions the     │
│ demonstrate the         │ right way. Names the    │
│ discipline behind it.   │ trigger and the fix.    │
└─────────────────────────┴─────────────────────────┘

  ### 3. Blind calibration — trigger: 30-60 min of human labeling

┌─────────────────────────────────────────────────┐
│ THEY ASK                                        │
│   "Your eval judge is an LLM. How do you know   │
│   it's actually good at judging?"               │
│                                                 │
│ WHAT THEY'RE TESTING                            │
│   Do you know the standard critique of LLM-as-  │
│   judge? Have you thought about calibration?    │
│   Or are you just hoping the numbers mean       │
│   something?                                    │
└─────────────────────────────────────────────────┘

Say this:

> *"The eval judge is a Sonnet call with a structured rubric — four dimensions, five-point scale, three verdicts. It's an LLM judging LLM output. That's exactly the setup people are rightly skeptical of.*
>
> *What I've done: I ran a Session D pilot with the calibration protocol, and I stamped every output with `pilotWarning`. Because Session D was AI-vs-AI. Two Sonnet judges scoring the same responses. The verdict agreement was 6 of 6 — 100 percent. Exact-match at 13 of 24, 54 percent. Within-1 at 24 of 24, 100 percent. Those are stress-test numbers, not calibration numbers.*
>
> *The honest position is that I have not yet done real blind human calibration. That's a real gap. The `pilotWarning` field exists specifically so I don't confuse the Session D output with real calibrated data. When I read those numbers, I read them as 'the judge is internally consistent' — not as 'the judge tracks human judgment.'*
>
> *The trigger to close the gap is 30 to 60 minutes of my own blind labeling, or a collaborator's. The protocol is in the repo. The infrastructure is ready. The bottleneck is my own time.*
>
> *Until that's done, I use the eval judge with the caveat baked in. That caveat is why I put the regression gate at 10 percentage points on a 100-point scale, not tighter. If the judge is noisy, the gate has to be looser than the noise floor."*

The move: name the concern the interviewer has ("LLM judging LLM"). Show you knew it. Show what you did about it (Session D pilot with pilotWarning). Name the honest gap (no real human calibration). Name the trigger. Name why the gate is set the way it is.

  ### 4. Real load run — trigger: $2.50 and 2 hours

┌─────────────────────────────────────────────────┐
│ THEY ASK                                        │
│   "You've got a load harness. What do the load  │
│   numbers actually look like?"                  │
│                                                 │
│ WHAT THEY'RE TESTING                            │
│   Have you actually run it, or did you just     │
│   write it? Do you know the numbers?            │
└─────────────────────────────────────────────────┘

Say this:

> *"Honestly: I've written the harness at `eval/load.eval.ts`, semaphore-based, parameterized by `LOAD_N` and `LOAD_K`. I've smoke-tested at N=2 and N=3 to prove the mechanism works. I have not run a real load test.*
>
> *A real run at LOAD_N=30 with LOAD_K=5 would cost approximately $2.50 in API spend and about two hours of my time end-to-end. It hasn't happened because the value of that run is a set of numbers I'd communicate to whoever asks — and until someone asks, I've been sequencing higher-leverage work.*
>
> *What I can tell you today is baseline p50 latency from the single-case eval. Diagnose 50 seconds. Recommend 51 seconds. Judge phases 38 and 90 seconds. Total 225 seconds per case at concurrency 1. Under concurrency 5, I expect Anthropic rate limits and MCP server rate limits to be the first non-linear degradation. I don't have that number yet.*
>
> *The trigger is somebody who needs it. If you're asking, I'll run it tonight. That's the honest sequencing."*

The senior move here is turning "I haven't done it" into a clean sequencing statement. Not "I forgot" or "I'll get to it" — "the value of that number is downstream of somebody needing it." That's how senior engineers actually sequence work.

  ## The would-not-change list — four things with receipts

The senior move is not just naming reconsiderations. It's holding ground on decisions that were right. Four decisions with receipts you'd defend against any pushback:

  ### 1. NDJSON + readNdjson kernel — receipt: 4 streaming surfaces

> *"NDJSON over Server-Sent Events was the right call. Four different streaming surfaces in the codebase — `/api/briefing`, `/api/agent` for diagnose, `/api/agent` for recommend, `/api/agent` for the free-form query — all consume one 64-line kernel called `readNdjson`. Four surfaces, one kernel, one framing. SSE would have added a second framing layer and broken POST support on `/api/agent`. That decision stands."*

  ### 2. DataSource seam + adapters — receipt: 4 uses, 0 caller changes

> *"The DataSource port is 71 lines. It's shipped in four uses — Bloomreach, Synthetic for offline eval, FaultInjecting decorator, and one demo adapter I added and removed. Every use of that port required zero changes to caller code. That's the strongest architectural receipt in the whole system. I'd design it the same way again."*

  ### 3. AptKit primitive boundary — receipt: legacy loop preserved

> *"AptKit owns the agent loop; I own the boundary through three adapter classes at ~263 LOC. The legacy pre-AptKit loop is preserved in the repo at `*-legacy.ts` as a rollback receipt. If AptKit disappeared or became a liability, I swap the adapters, put the legacy loop back. That's not architectural regret; that's insurance. Same call again."*

  ### 4. Portfolio hardening sequence — receipt: 6 phases, all shipped

> *"The six-phase hardening plan — eval, observability, cost, load and fault, regression gate, CI — shipped in that exact order because each phase depended on the one before it. You can't run a regression gate without a baseline. You can't have a baseline without an eval. You can't measure cost without observability. That sequence is not accidental. I'd sequence it identically again."*

  ## The follow-up decision tree

The reflection round has one specific follow-up shape you should be ready for:

```
  You volunteer the four reconsideration items.
        │
        ▼
  ┌─► "That's honest. What else would you change?"
  │      Beware — the interviewer is testing whether
  │      you have a bounded list or an infinite one.
  │      Correct answer: "Those are the four real ones.
  │      Everything else in the codebase is either
  │      shipped, working, and I'd repeat, or it's a
  │      known limitation I've named elsewhere."
  │      Don't invent more.
  │
  ├─► "What about the frontend? Any regrets there?"
  │      One honest one: extracting the readNdjson
  │      kernel came late — day 40, not day 1. The
  │      four streaming surfaces briefly diverged
  │      before consolidation. It cost a week. If I
  │      built again, I'd extract the shared reader
  │      before the second surface existed.
  │
  ├─► "Would you change the framework?"
  │      No. Next.js 16's App Router streaming is
  │      the primitive my product depends on. See
  │      Chapter 3.
  │
  └─► "Would you use a different model?"
       Not for the agent tier — Sonnet 4.6 with
       prompt caching is the right cost/quality
       point for diagnosis and recommendation.
       The Haiku call for classifyIntent was
       deliberate. Monitoring routing to Haiku
       is on the reconsider list with a trigger.
```

  ## When you don't know

Reflection questions can pull you into competitive-comparison territory you haven't lived in. If they ask "how does your approach compare to what Anthropic itself does internally?" the honest answer is you don't know.

```
╔═══════════════════════════════════════════════╗
║ WHEN YOU DON'T KNOW                           ║
║                                               ║
║   They ask: "If you'd done this at Anthropic  ║
║   or OpenAI internally, what would have been  ║
║   different?"                                 ║
║                                               ║
║   You have not worked at a frontier lab.      ║
║   You have opinions from reading papers, but  ║
║   not from being inside.                      ║
║                                               ║
║   Say:                                        ║
║   "I haven't worked at a frontier lab. What   ║
║    I'd guess — and it's a guess — is that     ║
║    an internal team would have access to      ║
║    tighter latency budgets, model-side        ║
║    telemetry I don't get, and probably an     ║
║    internal eval infrastructure that dwarfs   ║
║    my 10-golden setup. What I built is        ║
║    the outside-the-lab version — a           ║
║    disciplined production-hardening pass on   ║
║    a single-engineer project. I don't know    ║
║    what that maps to internally. Do you       ║
║    have context on how you'd think about      ║
║    the comparison?"                          ║
║                                               ║
║   What this signals: honest scope of what     ║
║   you can compare to. Guess labeled as a      ║
║   guess. Willingness to learn in the room.    ║
║   Handing the question back to them turns     ║
║   an ambush into a conversation.              ║
║                                               ║
║   Do NOT say:                                 ║
║   "Well, they'd probably use RLHF and        ║
║    fine-tuning and constitutional AI…"        ║
║   Buzzword-shopping is the surest way to      ║
║   flag that you don't know what you're       ║
║   talking about.                              ║
╚═══════════════════════════════════════════════╝
```

  ## What you'd change

The meta-move for this chapter: the reconsider list itself is a receipt of taste. Four real triggers, four real changes, four decisions that you can defend as evidence-driven deferrals — that's a senior habit visible in one page. What you'd change about how you present it: nothing. The chapter is the shape.

What you'd change about the actual project: the four items on the reconsider list. That's it. The rest — the four items on the would-not-change list — you'd repeat verbatim.

  ## The one-page summary

**Core claim.** Four decisions to reconsider, each with a real trigger. Four decisions to keep, each with a receipt. Both lists volunteered before being asked.

**The four reconsiderations.**

  → No DB → trigger: multi-instance deploy. Fix: durable session store, ideally through a `SessionStore` port.
  → Monitoring routing to Haiku → trigger: one real briefing measured. Fix: one-line ModelProvider swap.
  → Blind calibration → trigger: 30-60 min of human labeling. Fix: swap Session D pilot data for real labeled data.
  → Real load run → trigger: $2.50 in API spend + 2 hours. Fix: LOAD_N=30, LOAD_K=5.

**The four would-not-change decisions.**

  → NDJSON + readNdjson kernel → 4 streaming surfaces, one 64-LOC kernel.
  → DataSource seam + adapters → 4 uses, 0 caller changes.
  → AptKit primitive boundary → legacy loop preserved as rollback receipt.
  → Portfolio hardening sequence → 6 phases, all shipped, receipt-backed.

**The pull quotes.**

  → *"The deferral is not laziness. It's evidence-driven. A change I can't measure is a change I don't ship."*
  → *"The senior-engineer move is to volunteer what you'd reconsider before being asked."*

**What you'd change.** Nothing about how the reconsider list is presented. Only the four items themselves need work.
