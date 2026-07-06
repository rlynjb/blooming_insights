# Chapter 8 — The AI question

  ## Opening hook

The 2026 meta. Somewhere in your interview loop — often five minutes in, sometimes forty-five — an interviewer will lean forward slightly and ask some version of the AI question. "Did you use AI to build this?" "Can you explain this section line by line?" "What did AI get wrong?"

The 2026 baseline is that everyone used AI. Senior interviewers know this. They don't ask because they suspect you did — they ask to see how you *own* it. What separates strong candidates from weak ones is not whether AI wrote code. It's whether you can name — precisely — the three decision modes for every important choice: deliberate (you decided, evidence-backed), evaluated-and-accepted (AI suggested, you evaluated and accepted), and defaulted-to (AI's default, you didn't deeply evaluate).

Weak answers hide the third mode. Strong answers name it directly, with the trigger for revisiting. This chapter is that answer, chapter-length.

  ## The chapter-opening diagram

The what-AI-did / what-I-did split. Left column is decisions AI shaped; right is your decisions on top. The middle is the sequence — decisions ranked by decision mode.

```
  What AI did · what I did — decision modes across the codebase

  ┌─ DELIBERATE decisions (you decided, evidence-backed) ─────────┐
  │                                                               │
  │  → NDJSON over SSE                                            │
  │    Read Vercel docs. Considered POST needs. Chose framing.    │
  │                                                               │
  │  → Prompt caching config                                      │
  │    Read the Anthropic caching docs. Validated live in logs:   │
  │    cache_creation_input_tokens 3168 → cache_read 3168.        │
  │                                                               │
  │  → FaultInjectingDataSource design                            │
  │    Severity-order rolls, PRNG seed for repro. My design.      │
  │                                                               │
  │  → BudgetTracker check-before-dispatch (not check-after)      │
  │    Runaway loop cannot cost more than the ceiling.            │
  │                                                               │
  │  → Portfolio hardening sequence                               │
  │    6 phases, ordered by dependency. My sequencing.            │
  │                                                               │
  │  → Session-keyed feed map fix                                 │
  │    I found the bug in a code read; I designed the fix.        │
  │                                                               │
  │  → Coordination-failure drill (Move 3, 2026-07-03)             │
  │    Induced a handoff-leakage failure, isolated the mechanism   │
  │    with a 3-run probe, shipped the fix, ran the eval, and      │
  │    the eval regressed the number. I reverted. Negative-result  │
  │    rep — the receipt is the discipline, not the outcome.       │
  │                                                               │
  └───────────────────────────────────────────────────────────────┘

  ┌─ EVALUATED-AND-ACCEPTED decisions ────────────────────────────┐
  │                                                               │
  │  → AptKit migration from own loop                             │
  │    AI suggested; I read the API surface, compared to          │
  │    LangGraph and Mastra, evaluated the boundary shape,        │
  │    accepted. Legacy loop kept for rollback.                   │
  │                                                               │
  │  → readNdjson kernel extraction                               │
  │    AI wrote the first extraction; I evaluated the 4-consumer  │
  │    shape, accepted, and set the reader as canonical.          │
  │                                                               │
  │  → DataSource port shape                                      │
  │    AI proposed the initial types.ts; I evaluated against my   │
  │    portfolio's port-adapter experience, accepted, extended.   │
  │                                                               │
  │  → Swappable MCP client (McpDataSource + 3 AuthProviders)     │
  │    AI proposed the config-override transport (header +        │
  │    localStorage + settings modal); I evaluated against the    │
  │    existing DataSource seam, accepted, shipped as the 5th     │
  │    use of the same port. Deliberate reframing: Bloomreach is  │
  │    the default preset, not the codebase identity.             │
  │                                                               │
  └───────────────────────────────────────────────────────────────┘

  ┌─ DEFAULTED-TO decisions (AI's default; not deeply evaluated) ─┐
  │                                                               │
  │  → OAuth PKCE + Dynamic Client Registration shape             │
  │    The canonical example. AI wrote lib/mcp/auth.ts around     │
  │    an OAuthClientProvider conformance I did not deeply        │
  │    evaluate against alternatives. I can defend it against     │
  │    the MCP spec, but I did not consider whether a different   │
  │    auth flow would have been better. Trigger to revisit:      │
  │    an auth-specific security review.                          │
  │                                                               │
  │  → StrictMode double-fetch guard shape                        │
  │    AI-proposed. I accepted the pattern.                       │
  │                                                               │
  │  → Prod-only bare 500 error shape                             │
  │    AI-defaulted; I fixed only after seeing the failure mode.  │
  │                                                               │
  │  → All-at-once coverage reveal (early UI decision)            │
  │    AI-defaulted flow; I accepted, later corrected.            │
  │                                                               │
  └───────────────────────────────────────────────────────────────┘
```

Three modes. Seven deliberate. Four evaluated-and-accepted. Four defaulted-to. Every important decision fits into one of these three buckets, and the boundaries between them are honest. That's the map you defend from.

  ## The five treated questions

  ### 1. "Did you use AI to build this?"

┌─────────────────────────────────────────────────┐
│ THEY ASK                                        │
│   "Did you use AI to build this?"               │
│                                                 │
│ WHAT THEY'RE TESTING                            │
│   How comfortable are you with the answer?      │
│   Do you have a mental map of what AI did and   │
│   what you did? Are you going to be defensive?  │
└─────────────────────────────────────────────────┘

Say this:

> *"Yes — heavily. That's the 2026 baseline for a project like this, and I don't hide from it. What matters is the mental map I have of what AI did versus what I did.*
>
> *There are three modes I'd distinguish. First: decisions I made deliberately — I read the docs, evaluated alternatives, made the call. Prompt caching config, NDJSON versus SSE, the fault-injection design, budget check-before-dispatch. Six of those.*
>
> *Second: decisions where AI made a suggestion and I evaluated and accepted it. AptKit migration is the biggest one — AI suggested it, I read the API surface, compared to LangGraph and Mastra, evaluated the boundary shape, accepted, and kept the legacy loop as a rollback receipt. The swappable MCP client is another — AI proposed the config-override transport, I evaluated it against the DataSource seam I'd already built, accepted, and the fifth use of the port shipped in a day.*
>
> *Third: decisions where I defaulted to what AI proposed without deeply evaluating alternatives. OAuth PKCE plus Dynamic Client Registration is the canonical one. It works, I can defend it against the MCP spec, but I did not evaluate whether a different auth flow would have been better. That's honest. The trigger to revisit it would be an auth-specific security review.*
>
> *That third bucket is what most candidates hide. The senior-signal-positive move is naming it directly."*

┃ "The third bucket is what most candidates hide.
┃  The senior-signal-positive move is naming it
┃  directly."

┌─────────────────────────┬─────────────────────────┐
│ WEAK ANSWER             │ STRONG ANSWER           │
├─────────────────────────┼─────────────────────────┤
│ "Yeah, I used Claude    │ "Yes, heavily. Three    │
│ as a coding partner.    │ decision modes:         │
│ It helped speed things  │ deliberate,             │
│ up, but I understand    │ evaluated-and-accepted, │
│ everything in the       │ and defaulted-to.       │
│ codebase."              │ Six deliberate, four    │
│                         │ evaluated, four         │
│                         │ defaulted. OAuth PKCE + │
│                         │ DCR is the canonical    │
│                         │ defaulted-to; I can     │
│                         │ defend it but I did not │
│                         │ evaluate alternatives.  │
│                         │ Trigger to revisit is a │
│                         │ security review."       │
├─────────────────────────┼─────────────────────────┤
│ Why it's weak:          │ Why it works:           │
│ "Coding partner" is     │ Uses precise             │
│ marketing framing.      │ vocabulary the           │
│ "I understand           │ interviewer will hear    │
│ everything" invites the │ once and remember.       │
│ next follow-up          │ Volunteers the honest    │
│ ("really? Explain       │ mode without being       │
│ this?") and the         │ prompted. Names the      │
│ candidate collapses.    │ trigger. Signals a       │
│ Reads as guilty.        │ candidate who has        │
│                         │ thought hard about this. │
└─────────────────────────┴─────────────────────────┘

  ### 2. "What did AI get wrong?"

┌─────────────────────────────────────────────────┐
│ THEY ASK                                        │
│   "What did AI get wrong that you had to fix?"  │
│                                                 │
│ WHAT THEY'RE TESTING                            │
│   Can you name specific things? Are you         │
│   critical of AI output, or do you accept       │
│   everything it gives you?                      │
└─────────────────────────────────────────────────┘

Say this:

> *"Four specific things. I keep the list because it's how I calibrate my review.*
>
> *One: React 19 StrictMode double-fetch. AI wrote a `useEffect` that started an investigation on mount. Under StrictMode's development double-invocation, it fired twice, and my second fetch cancelled the first. I fixed it by moving cancellation logic to only run on real unmount, not the double-invocation. Real bug, real fix.*
>
> *Two: prod-only bare 500. AI wrote route error handling that returned a bare 500 without an NDJSON `error` event in production. Worked fine in dev. First time I hit an MCP timeout in preview, the client stream just closed without a payload and the UI hung waiting. Fixed by adding the error event before closing the stream.*
>
> *Three: all-at-once coverage reveal. Early UI iteration — AI wrote a flow where the tool-coverage check ran, hid a loading indicator, and revealed the entire panel at once. I later rewrote it to reveal progressively so the user sees what's happening.*
>
> *Four: the concurrent-user wipe I covered in Chapter 6. AI's default `Map<id, entity>` for feed state. Real bug, silent data corruption for two users. Session-keyed the map.*
>
> *Those four have a pattern in common — they all worked fine on the happy path with one user in development. They failed under StrictMode, production, or concurrency. That's the class of bug AI generates by default: fine on the happy path, breaks at boundaries. Knowing that pattern is why I review with a systems lens now."*

┃ "AI generates code fine on the happy path.
┃  It breaks at boundaries — StrictMode, production,
┃  concurrency. That's the class of review I do."

  ### 3. "What did AI help with that you couldn't have built alone?"

┌─────────────────────────────────────────────────┐
│ THEY ASK                                        │
│   "What's an example where AI helped you build   │
│   something you couldn't have built alone?"     │
│                                                 │
│ WHAT THEY'RE TESTING                            │
│   Are you honest about leverage? Or do you      │
│   pretend AI just accelerated things you'd      │
│   have done anyway?                             │
└─────────────────────────────────────────────────┘

Say this:

> *"The AptKit migration is the clearest example. Left to my own timeline I would have kept iterating on `runAgentLoop` in `lib/agents/base.ts`. It worked. Every improvement — retry semantics, streaming, tool dispatch — was on me. I would have kept building infrastructure instead of features for probably another month.*
>
> *AI suggested the migration and, more importantly, helped me sketch the boundary shape — three adapter classes to keep AptKit at arm's length. That boundary is the discipline that made the migration a receipt instead of a lock-in. AI proposed the boundary; I evaluated it against how I've done port-and-adapter in my system-design portfolio; I accepted and shipped it.*
>
> *The honest framing is: AI accelerated a decision I would have made eventually. It didn't make a decision I wouldn't have. But the acceleration was real — probably a month of my time.*
>
> *And the boundary discipline is mine. I've been doing port-and-adapter for enough years to recognize when a boundary is at the right seam. AI proposed the shape; I recognized it. That's the collaboration that actually works."*

  ### 4. "Can you explain this section line by line?"

┌─────────────────────────────────────────────────┐
│ THEY ASK                                        │
│   "Show me this file. Can you explain what      │
│   every line does?"                             │
│                                                 │
│ WHAT THEY'RE TESTING                            │
│   Do you actually understand what shipped, or   │
│   did you accept generation without reading?    │
│   Are there whole sections of the codebase you  │
│   can't explain?                                │
└─────────────────────────────────────────────────┘

This is the terminal question — and the one you handle with honesty about which files you know cold versus which files you'd want to open with them.

Say this:

> *"Sure. Depends on the file. There are files I know cold — `lib/agents/aptkit-adapters.ts`, `lib/data-source/types.ts`, `lib/state/insights.ts`, `lib/agents/budget.ts`, the six-phase hardening plan artifacts, `eval/gate.eval.ts`, `readNdjson.ts`. Those I built or refactored deliberately. Pick any of them and I can walk you line by line.*
>
> *There are files I know at the boundary level — `lib/mcp/auth.ts` I can defend against the MCP spec and I know what each function does, but the AES-256-GCM cookie encryption specifics I'd have to re-read. If you drilled into the exact IV generation, I'd want to open the file with you.*
>
> *There are files where I know the shape and the tests but not every line — the older `*-legacy.ts` files. I preserved them intentionally as rollback insurance. I can tell you why they're there and what they do. I don't remember every line.*
>
> *If you pick a file, I'll tell you which of those three categories it's in before I start explaining. That way we're both calibrated."*

The move: preemptive honesty about which files you know cold and which you'd want to open together. Interviewers who drill into "can you explain every line" are hunting for the moment you stumble on a file you didn't write. Handing them the map first defuses the ambush.

  ### 5. "How is this different from every other AI project you've seen?"

┌─────────────────────────────────────────────────┐
│ THEY ASK                                        │
│   "I've seen a hundred multi-agent AI projects  │
│   this year. Why is yours different?"           │
│                                                 │
│ WHAT THEY'RE TESTING                            │
│   Do you know what makes production-grade       │
│   different from hackathon-grade? Can you name  │
│   what separates yours?                         │
└─────────────────────────────────────────────────┘

Say this:

> *"Two things.*
>
> *One is the reasoning UI. The agents' thinking streams to a first-class panel as it happens — StatusLog with ReasoningTrace, not a hidden log. Most AI projects hide the trace. Mine makes it a product surface. Users see which tools ran, which numbers came back, which hypotheses got tested. That's not a plumbing choice; that's the product.*
>
> *Two is the hardening pass. Ten goldens with a two-rubric, four-dimension eval. Baseline committed. Regression gate at 10 percentage points blocking CI. Fault-injecting decorator with 9-fault-3-investigation-0-failures receipt. Prompt caching validated live in logs. Budget check-before-dispatch. GitHub Actions on every push. That's tier-2 production-grade, not tier-3 hackathon. Most AI projects at my level don't have any of that.*
>
> *And I can prove the hardening pass earns its keep. Last week I ran a drill on the multi-agent coordination surface — Move 3 of my recon queue. I induced a specific handoff-leakage failure (the recommendation agent producing recs targeting hypotheses the diagnosis had marked supported-false). A three-run isolation probe confirmed the mechanism. I shipped what looked like a targeted fix — one exported helper, five tests. Then I ran the 10-case eval. The number went DOWN across all four recommendation dimensions, by 13 to 23 percentage points. Turns out the rejected hypotheses were carrying load-bearing context I hadn't credited. I reverted, wrote up the negative result, replanned toward the alternative option. The commit is on main; the drill writeup is in the repo. That's what the hardening pass buys you — I have a receipt showing what my mental model got wrong and how the eval caught it before it shipped.*
>
> *The combination is unusual: the product surface (reasoning UI) plus the hardening pass with lived receipts. Either alone is common. Both together is what makes this specifically defensible in a senior interview."*

  ## The follow-up decision tree

The AI question has a distinct branching shape. Interviewers pick different follow-ups depending on what your first answer signals:

```
  You give the three-decision-modes answer.
        │
        ▼
  ┌─► "Give me an example of a defaulted-to
  │    decision you'd want to revisit."
  │      Answer: OAuth PKCE + DCR. Trigger: a real
  │      auth-specific security review. Alternative
  │      to consider: whether the MCP OAuth shape
  │      is the right one for a production
  │      deployment vs. dev experimentation.
  │
  ├─► "What's your review discipline for AI-
  │    generated code?"
  │      Answer: three-pass review — correctness,
  │      systems lens (concurrency, StrictMode,
  │      production-vs-dev diffs), and taste
  │      (does the shape match existing patterns).
  │      The systems-lens pass is the one that
  │      would have caught the concurrent-user
  │      wipe earlier if I'd had it as a habit.
  │
  ├─► "If AI wrote most of this, what did you
  │    actually contribute?"
  │      The boundary discipline. The port-and-
  │      adapter shape. The three decision modes.
  │      The hardening sequence. The receipt-
  │      backed defense of every claim. The
  │      insights.ts fix I found in a code read.
  │      The BudgetTracker check-before-dispatch
  │      design. The taste calls that shape the
  │      whole system.
  │
  ├─► "How do you catch mistakes AI helps you
  │    make?"
  │      The eval. Not the tests — the tests are
  │      shape contracts. The eval measures
  │      quality. When I induced Move 3's
  │      coordination failure last week and
  │      shipped what looked like a clean fix, my
  │      isolation probe said it worked, my type
  │      system said it worked, my unit tests all
  │      passed (the suite is at 276 today). The
  │      eval regressed the number by
  │      20+pp on four dimensions and I reverted.
  │      The eval is the last line where being
  │      wrong is cheap.
  │
  └─► "How do you think about AI tools going
       forward?"
        The tools are getting better. What's not
        getting easier is the taste — knowing
        which boundary is at the right seam,
        knowing when a deferral is evidence-
        driven vs. avoidance, knowing which
        AI-defaulted decision needs a re-review.
        That taste is what I'm developing, and
        the AI tools accelerate around it —
        including accelerating me to being
        WRONG faster, which is what the eval
        exists to catch.
```

  ## When you don't know

The AI question has one specific "I don't know" territory: internals of models you use. If they ask about model training, RLHF, constitutional AI, or specific model architecture details, be honest.

```
╔═══════════════════════════════════════════════╗
║ WHEN YOU DON'T KNOW                           ║
║                                               ║
║   They ask: "You're using Claude Sonnet 4.6.  ║
║   What's different about it internally vs.    ║
║   4.5? Do you know how Anthropic's caching    ║
║   works under the hood?"                      ║
║                                               ║
║   You have not read Anthropic's internal      ║
║   engineering docs. You use the API.          ║
║                                               ║
║   Say:                                        ║
║   "I don't know the internal architectural    ║
║    differences between Sonnet 4.5 and 4.6.   ║
║    I know Sonnet 4.6 is what my agents run   ║
║    on and Haiku is what my classifier runs   ║
║    on, and I chose those because Sonnet's     ║
║    tool-use reliability was the load-        ║
║    bearing feature for my agent loop.       ║
║                                               ║
║    For prompt caching internals — I know the ║
║    external contract: cache_control:         ║
║    'ephemeral' on a message block, TTL of    ║
║    5 minutes, cache-hit tokens billed at    ║
║    the read rate. I validated that in logs   ║
║    with cache_creation_input_tokens versus   ║
║    cache_read_input_tokens. What I don't     ║
║    know is Anthropic's internal cache        ║
║    architecture — is it per-region, is it    ║
║    per-inference-node — that's beyond the    ║
║    API surface I use."                       ║
║                                               ║
║   What this signals: crisp distinction        ║
║   between what the API contract gives you    ║
║   and what internal architecture is. Names    ║
║   the boundary of your knowledge. Doesn't     ║
║   pretend to know Anthropic's guts.           ║
║                                               ║
║   Do NOT say:                                 ║
║   "Sonnet 4.6 uses a mixture-of-experts       ║
║    approach with…"                            ║
║   Speculating about internal architecture     ║
║   you didn't read is the exact ambush         ║
║   waiting to happen. Own the API surface;    ║
║   don't pretend to own the internals.         ║
╚═══════════════════════════════════════════════╝
```

  ## What you'd change

The three-decision-modes framing is the meta-move you'd repeat verbatim on any future AI project. It's not a defense of blooming insights specifically; it's a defense of how a senior engineer works with AI tooling in general. What you'd change is when in the project you start tracking mode. Right now you retroactively categorized decisions. On a future project you'd tag every non-trivial decision at commit time — was this deliberate, evaluated, or defaulted? That's a review discipline you'd build in from day one.

The defaulted-to list itself is the honest map. Nothing to change about the list. Everything to change about how quickly you build the habit of naming decisions as they happen instead of a month later.

  ## The one-page summary

**Core claim.** The 2026 baseline is that everyone used AI. The senior signal is naming three decision modes explicitly: deliberate, evaluated-and-accepted, and defaulted-to. Six deliberate, four evaluated, four defaulted. OAuth PKCE + DCR is the canonical defaulted-to example. Trigger to revisit: security review.

**The questions covered.**

  → "Did you use AI to build this?" → yes, heavily; three decision modes; volunteer the defaulted-to bucket.
  → "What did AI get wrong?" → four specific examples: StrictMode double-fetch, prod-only bare 500, all-at-once coverage reveal, insights.ts concurrent-user wipe.
  → "What did AI help with?" → AptKit migration; accelerated a decision I would have made eventually; the boundary discipline is mine.
  → "Explain this line by line?" → three categories of file; hand them the map first.
  → "What makes yours different?" → reasoning UI as a product surface + tier-2 production-hardening pass. The combination is unusual.

**The pull quotes.**

  → *"The third bucket is what most candidates hide. The senior-signal-positive move is naming it directly."*
  → *"AI generates code fine on the happy path. It breaks at boundaries — StrictMode, production, concurrency. That's the class of review I do."*
  → *"AI tools accelerate me to being wrong faster. The eval is what catches that."*

**What you'd change.** Tag decisions with decision mode at commit time on future projects, not retroactively. The rest of the framing carries forward as-is. Also: run the eval BEFORE writing the tests, not after. On Move 3 my tests passed and my eval failed; the tests were shape contracts, the eval was quality. That ordering is a habit worth building.
