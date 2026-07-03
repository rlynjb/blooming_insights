# Chapter 1 — The pitch

  ## Opening hook

The first sixty seconds of every senior interview: "so, tell me about a project you built." What you say next decides whether the next forty minutes are you defending a system you clearly own or you fumbling through explanations of features while the interviewer waits for a story to grab onto.

Most candidates ramble. They start with the framework ("so it's a Next.js app…") or with the problem in the abstract ("marketers at Bloomreach have to notice metrics moved…") and by the time they get to the actual system they're two minutes in and the interviewer has already decided the next question. This chapter is about not doing that. Three pitch lengths, three landing points, all built from the same core sentence.

  ## The chapter-opening diagram

Here's the project at a glance — the visual that anchors every pitch length.

```
  blooming insights — the pitch shape

  ┌──────────────────────────────────────────────────────────────┐
  │  What it is                                                  │
  │  ──────────                                                  │
  │  An AI analyst that shows its work.                          │
  │  Streams the agents' reasoning as a first-class UI surface.  │
  └──────────────────────────────────────────────────────────────┘
             │
             ▼
  ┌──────────────────────────────────────────────────────────────┐
  │  What it does — the analyst loop                             │
  │  ────────────────────────────                                │
  │                                                              │
  │    monitoring  →  diagnostic  →  recommendation              │
  │    (what       →  (why did    →  (what to do                 │
  │     changed?)      it change?)     about it?)                │
  │                                                              │
  │  5 agents on @aptkit/core@0.3.0                              │
  │  → monitoring · diagnostic · query · recommendation          │
  │  → + Haiku classifyIntent (deterministic supervisor)         │
  └──────────────────────────────────────────────────────────────┘
             │
             ▼
  ┌──────────────────────────────────────────────────────────────┐
  │  What makes it defensible — tier-2 production-grade          │
  │  ───────────────────────────────────────────────────         │
  │  → eval-proven      · 10 goldens · 2 rubrics × 4 dims        │
  │  → cost-controlled  · prompt caching · BudgetTracker         │
  │  → fault-tested     · 9 faults / 3 investigations / 0 fails  │
  │  → CI-gated         · GATE_MAX_REGRESSION=10pp on baseline   │
  └──────────────────────────────────────────────────────────────┘
             │
             ▼
  ┌──────────────────────────────────────────────────────────────┐
  │  Real measured numbers                                       │
  │  ─────────────────────                                       │
  │  → per-case avg cost:  ~$0.09 (agent-side, cached)           │
  │  → total 10-case run:  ~$1.30                                │
  │  → p50 per-phase:      diagnose 50s · recommend 51s          │
  │  → judge verdict agree: 6/6 (100%) on Session D pilot        │
  └──────────────────────────────────────────────────────────────┘
```

That's the whole thing in one visual. Every pitch length below is a projection of this — ten seconds picks two boxes, thirty seconds picks three, ninety seconds walks the whole picture.

  ## The ten-second version — the elevator

You have ten seconds when someone at a meetup asks what you've been building. Not the recruiter, not the interview — the person waiting for coffee. Ten seconds is one sentence. One breath.

┌─────────────────────────────────────────────────┐
│ THEY ASK                                        │
│   "What have you been working on?"              │
│                                                 │
│ WHAT THEY'RE TESTING                            │
│   Can you compress a whole system into a        │
│   sentence? Do you know what the system is FOR? │
└─────────────────────────────────────────────────┘

Say this:

> *"An AI analyst for a Bloomreach ecommerce workspace that shows its work — it streams the agents' reasoning as a first-class UI surface, so users see not just what changed but how the system figured it out."*

That's it. Twenty-nine words. The pattern (AI analyst), the substrate (Bloomreach ecommerce workspace), and the differentiator in the same breath (shows its work, streams the reasoning).

┌─────────────────────────┬─────────────────────────┐
│ WEAK ANSWER             │ STRONG ANSWER           │
├─────────────────────────┼─────────────────────────┤
│ "It's a Next.js app     │ "An AI analyst for a    │
│ with AI agents that     │ Bloomreach ecommerce    │
│ helps you understand    │ workspace that shows    │
│ your Bloomreach data.   │ its work — streams the  │
│ It uses Claude and MCP  │ agents' reasoning as a  │
│ and it's got a really   │ first-class UI surface."│
│ nice UI."               │                         │
├─────────────────────────┼─────────────────────────┤
│ Why it's weak:          │ Why it works:           │
│ Leads with the tech     │ Leads with what the     │
│ stack (Next.js) instead │ product IS (an AI       │
│ of the product. "Really │ analyst) and the        │
│ nice UI" is filler. No  │ differentiator (shows   │
│ differentiator. Sounds  │ its work). No filler.   │
│ like every other AI     │ Every word carries      │
│ side project.           │ signal.                 │
└─────────────────────────┴─────────────────────────┘

┃ "Lead with what the product IS, not what it's built with.
┃  The stack is the answer to a different question."

  ## The thirty-second version — the hallway

You have thirty seconds when the recruiter walks you from reception to the room, or when the interviewer says "before we start, tell me a bit about what you've built." Thirty seconds is three beats. Setup, mechanism, receipt.

┌─────────────────────────────────────────────────┐
│ THEY ASK                                        │
│   "Tell me a bit about your project before we    │
│   start."                                       │
│                                                 │
│ WHAT THEY'RE TESTING                            │
│   Do you have a mental map you can walk without │
│   notes? Do you know what makes YOUR version    │
│   different from every other AI project they've │
│   seen this week?                               │
└─────────────────────────────────────────────────┘

Say this, in three beats:

> *"[Setup] blooming insights is an AI analyst for a Bloomreach ecommerce workspace. It runs the loop a human data analyst runs — what changed, why, what to do — as five agents over MCP tools.*
>
> *[Mechanism] The differentiator is that it streams the agents' reasoning as a first-class UI surface, not a hidden trace. Users see which queries ran, which numbers came back, which hypotheses got tested.*
>
> *[Receipt] I built it on top of AptKit as the agent primitive, wrapped in my own boundary. The whole thing is eval-gated in CI — 10 goldens, a regression gate at 10 percentage points, and it's fault-tested against injected upstream failures."*

That's roughly 90 words. Three sentences. You can say it in thirty seconds.

The move here: setup names the shape and the substrate; mechanism names what makes it different; receipt gives one production-grade thing that separates you from every hackathon project. You lose most candidates at the receipt — they don't have one to point at.

┌─────────────────────────┬─────────────────────────┐
│ WEAK ANSWER             │ STRONG ANSWER           │
├─────────────────────────┼─────────────────────────┤
│ "It's a multi-agent AI  │ "It runs the loop a     │
│ system where agents     │ human data analyst runs │
│ collaborate to analyze  │ — what changed, why,    │
│ business metrics and    │ what to do — as five    │
│ recommend actions.      │ agents over MCP tools.  │
│ I used LangGraph… wait, │ The differentiator is   │
│ actually AptKit, and    │ that it streams the     │
│ Claude Sonnet, and it's │ agents' reasoning as a  │
│ got RAG and tool use    │ first-class UI surface, │
│ and prompt caching."    │ eval-gated in CI."      │
├─────────────────────────┼─────────────────────────┤
│ Why it's weak:          │ Why it works:           │
│ Buzzword tour. "Agents  │ Names the analyst loop  │
│ collaborate" tells them │ concretely. Names the   │
│ nothing. Correcting     │ differentiator (streams │
│ yourself mid-sentence   │ reasoning as UI).       │
│ (AptKit not LangGraph)  │ Closes with a receipt   │
│ leaks you don't know    │ (eval-gated in CI) that │
│ the system as a shape.  │ separates you from a    │
│                         │ hackathon project.      │
└─────────────────────────┴─────────────────────────┘

  ## The ninety-second version — the actual answer

This is the one that matters. When the interviewer says "walk me through a project you built," they're giving you 90 seconds to decide the shape of the next 45 minutes. Nail this and the questions get easier — they follow the path you've laid down. Miss this and you're catching questions from every direction for the rest of the loop.

┌─────────────────────────────────────────────────┐
│ THEY ASK                                        │
│   "Walk me through a project you've built."     │
│                                                 │
│ WHAT THEY'RE TESTING                            │
│   Do you know your system as a system, not just │
│   as features? Can you narrate architecture     │
│   without a whiteboard? Do you volunteer the    │
│   hard parts, or do you only mention them if    │
│   pushed?                                       │
└─────────────────────────────────────────────────┘

The structure: hook + problem + shape + differentiator + one receipt + one honest thing. Ninety seconds is roughly 220 words.

Say this:

> *"[Hook] I built an AI analyst that shows its work. It's called blooming insights, and it plugs into a Bloomreach Engagement workspace over the Model Context Protocol.*
>
> *[Problem] A marketer on Bloomreach normally has to notice a metric moved, hunt for the cause, and figure out which Bloomreach feature to reach for. blooming insights does that end-to-end — monitoring detects the anomaly, a diagnostic agent forms and tests hypotheses against the actual event data, and a recommendation agent proposes a concrete Bloomreach action.*
>
> *[Shape] It's five agents on top of AptKit as the agent primitive, wrapped in about 260 lines of adapter code that keep AptKit at arm's length. The frontend is Next.js 16 with a shared NDJSON streaming kernel — 64 lines of code, four different streaming surfaces consume it. And there's a DataSource port — a 71-line interface that's been used four different ways with zero caller-side changes. That's the strongest architectural receipt in the whole system.*
>
> *[Differentiator] The thing that separates it from every other agent app is that the agents' reasoning streams to the UI as a first-class surface — not a hidden trace, a real panel next to the answer.*
>
> *[Receipt] I put it through a full production-hardening pass. Eval flywheel with 10 goldens and a regression gate in CI. Prompt caching validated live. Fault injection — 9 injected upstream failures across 3 investigations, 0 investigation failures.*
>
> *[Honest thing] The one thing I'd flag: my eval surfaced a systemic prompt gap — every diagnosis scored low on 'specific next action.' It's my top thing to fix next, and the regression gate would catch any change that regresses it further."*

That's 260 words. About 90 seconds spoken at a natural pace.

The honest thing is the move most candidates skip. When you volunteer a real limitation with a receipt (I have the eval that shows it, I know the fix shape, the gate would catch a bad fix), you signal senior. When you paper over limitations, you signal junior — and worse, you set up the interviewer to catch you.

┃ "The honest thing at the end is what separates
┃  senior from junior. Volunteering the limitation
┃  with the receipt to back it up is a stronger
┃  signal than any feature you can list."

  ## The follow-up decision tree

Once you land the ninety-second pitch, the interviewer picks the follow-up. Here's the tree — every branch is a chapter of this book.

```
  You land the pitch.
        │
        ▼
  ┌─► "Walk me through the architecture."
  │      Go to Chapter 2 — you have the whiteboard walk ready.
  │
  ├─► "Why AptKit and not build your own loop?"
  │      Go to Chapter 3, Choice #2 — the evaluated-and-accepted
  │      answer with the legacy loop as rollback receipt.
  │
  ├─► "What breaks first at 10× users?"
  │      Go to Chapter 4 — you have the session Map as the
  │      first bottleneck with the trigger to reconsider named.
  │
  ├─► "Tell me about a bug you fixed."
  │      Go to Chapter 6 — insights.ts concurrent-user wipe.
  │      AI wrote it, you accepted it, you found it, you fixed it.
  │
  ├─► "Did you use AI to build this?"
  │      Go to Chapter 8 — matter-of-fact, three decision modes,
  │      never defensive.
  │
  └─► "What would you do differently?"
         Go to Chapter 7 — you volunteer the two you'd
         reconsider before they push.
```

Every branch has a chapter waiting. That's the point of the book — no follow-up should feel like an ambush.

  ## When you don't know

Even the pitch chapter needs an "I don't know" box. The pitch itself lands, but the interviewer might push into an adjacent territory before you've caught your breath.

```
╔═══════════════════════════════════════════════╗
║ WHEN YOU DON'T KNOW                           ║
║                                               ║
║   They land on your pitch and immediately     ║
║   ask: "What's your throughput at peak? Have  ║
║   you load-tested this at scale?"             ║
║                                               ║
║   You have not run a real load test. You've   ║
║   run LOAD_N=2 smoke tests. This is a real    ║
║   gap.                                        ║
║                                               ║
║   Say:                                        ║
║   "I built the semaphore-based load harness   ║
║    but I've only run smoke tests at N=2 and   ║
║    N=3. A real run at N=30 with concurrency 5 ║
║    would cost about $2.50 in API spend and    ║
║    I have the plan for it. What I can tell    ║
║    you today is per-phase p50 latency from    ║
║    the baseline eval — diagnose 50 seconds,   ║
║    recommend 51 seconds — and that the load   ║
║    harness itself is written and ready to     ║
║    run. Do you want to walk through what      ║
║    I'd measure?"                              ║
║                                               ║
║   What this signals: You have real numbers    ║
║   (the p50 baseline). You have the harness    ║
║   built. You're honest about not having run   ║
║   the full test yet. You offer to walk them   ║
║   through what you'd measure. All three are   ║
║   senior signals.                             ║
║                                               ║
║   Do NOT say:                                 ║
║   "Yeah I did some load testing, it was       ║
║    fine, it can handle a lot of traffic."     ║
║   Vague performance claims collapse the       ║
║   moment they follow up. "It can handle a     ║
║   lot" is the exact phrase that ends careers  ║
║   in senior interviews.                       ║
╚═══════════════════════════════════════════════╝
```

  ## What you'd change

If you were pitching this project a year from now with more time, you'd cut the eval receipt from the ninety-second version and replace it with a real load number ("500 investigations in a 30-day window at $X per investigation"). Right now the eval receipt is the strongest one you have, so it leads. The load number will be stronger once you've run the real test. The pitch shape stays the same; the receipt inside it evolves as the receipts get stronger.

  ## The one-page summary

**Core claim.** The pitch is a projection of the same shape at three lengths. Ten seconds picks the differentiator. Thirty seconds adds the mechanism. Ninety seconds adds the receipt and the honest thing. All three land on: an AI analyst that shows its work.

**The three lengths.**

  → 10 seconds: *"An AI analyst for a Bloomreach ecommerce workspace that shows its work — it streams the agents' reasoning as a first-class UI surface."*
  → 30 seconds: setup + mechanism + receipt. Add the three-stage loop (what changed / why / what to do) and one receipt (eval-gated in CI).
  → 90 seconds: hook + problem + shape + differentiator + receipt + honest thing. Add the architecture markers (5 agents on AptKit, 71-line DataSource port with 4 uses) and volunteer the actionable_next_step 0% baseline as the honest limitation.

**The pull quotes.**

  → *"Lead with what the product IS, not what it's built with. The stack is the answer to a different question."*
  → *"The honest thing at the end is what separates senior from junior."*
  → *"The strongest defense isn't denial. It's owning the decision and the cost you're paying for it."*

**What you'd change.** Replace the eval receipt in the 90-second version with a real load number once you've run LOAD_N=30. Same shape, evolved receipt.
