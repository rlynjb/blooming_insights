# Chapter 8 — The AI question

This is the chapter every senior interview in 2026 ends with. Sometimes it's the first question; sometimes it's the last. *"Did you use AI to build this?"* *"Can you explain this section line by line?"* *"What did AI get wrong?"* The candidates who collapse here lose the offer regardless of how well the previous seven chapters went. The candidates who land it well take *the very thing that should be a vulnerability* and turn it into the strongest signal in the loop.

You used AI heavily to build **blooming insights**. So did almost everyone interviewing alongside you. The interviewer knows this. What separates a strong answer from a weak one is not whether you used AI — it's whether you can **own what shipped**: which decisions were yours, which were the tool's suggestion that you evaluated, and which were defaults you accepted and have since interrogated.

This chapter teaches the calibrated-honest answer with one frame: **three decision modes**. Everything in your codebase is one of three. Naming which one each decision is, with examples, is the L5 move.

## The "what AI did, what I did" split — the chapter on one page

The visual anchor. Three decision modes, each with examples from this codebase.

```
  blooming insights — what AI did and what I did,
  organized by decision mode

  ┌──────────────────────────────────────────────────────────────────────┐
  │  MODE 1 — DELIBERATE                                                  │
  │  (my choice; alternatives considered; named criterion)                 │
  ├──────────────────────────────────────────────────────────────────────┤
  │                                                                       │
  │  · The hand-rolled runAgentLoop (now legacy)                          │
  │     I needed a hard maxToolCalls budget and a forced final            │
  │     synthesis turn. Wrote both. Preserved at base-legacy.ts.          │
  │                                                                       │
  │  · The DataSource seam                                                │
  │     One interface, two adapters. Survived two adapter swaps.          │
  │                                                                       │
  │  · NDJSON over fetch                                                  │
  │     Append-only, single reader; simplest contract that fits.          │
  │                                                                       │
  │  · No database                                                        │
  │     Deliberate, for the context. Cost named; trigger named.           │
  │                                                                       │
  │  · Demo mode as the reliable presentation path                        │
  │     The alpha upstream revokes tokens; demo replays a snapshot.       │
  │                                                                       │
  └──────────────────────────────────────────────────────────────────────┘

  ┌──────────────────────────────────────────────────────────────────────┐
  │  MODE 2 — EVALUATED-AND-ACCEPTED                                      │
  │  (AI or library suggested; I read it, tested it, accepted it)         │
  ├──────────────────────────────────────────────────────────────────────┤
  │                                                                       │
  │  · The AptKit migration (the load-bearing example here)               │
  │     @aptkit/core hit 0.3.0 with a clean primitive surface. I read     │
  │     the source, confirmed my two disciplines survived in the new      │
  │     shape, migrated. Three adapter classes (~200 LOC) on my side      │
  │     of the boundary. Legacy preserved as rollback receipt.            │
  │                                                                       │
  │  · The page decomposition (app/page.tsx 461 LOC + 3 hooks)            │
  │     AI suggested extracting the streaming/capture/reconnect logic     │
  │     into hooks. I evaluated each extraction by reading the resulting  │
  │     surface and accepted them — useBriefingStream, useDemoCapture,    │
  │     useReconnectPolicy. Each has its own responsibility and tests.    │
  │                                                                       │
  │  · The shared readNdjson kernel                                       │
  │     The pattern came from AI suggestion (read-line-by-line ND parse). │
  │     I evaluated whether extracting it across the four streaming       │
  │     surfaces was worth the indirection — it was; it's 64 lines and    │
  │     four consumers, with no duplication.                              │
  │                                                                       │
  └──────────────────────────────────────────────────────────────────────┘

  ╔══════════════════════════════════════════════════════════════════════╗
  ║  MODE 3 — DEFAULTED-TO                                                ║
  ║  (AI's default; I accepted without deeply evaluating at the time;     ║
  ║   own that honestly, and name what I did about it later)              ║
  ╠══════════════════════════════════════════════════════════════════════╣
  ║                                                                       ║
  ║  · OAuth PKCE + Dynamic Client Registration mechanics                 ║
  ║     The MCP SDK provides the surface; I implemented the provider; I   ║
  ║     didn't pick the protocol. I defend the wrapper around the SDK,    ║
  ║     not the protocol choice. Where my knowledge ends is named.        ║
  ║                                                                       ║
  ║  · The original lib/state/insights.ts (the concurrent-user wipe)      ║
  ║     AI suggested a global Map<id, Insight> with .clear() at the top   ║
  ║     of every write. For one user, correct. For two concurrent users   ║
  ║     on one warm instance, user A's clear wiped user B's mid-session.  ║
  ║     I caught it on a concurrency re-read. Session-keyed the map.      ║
  ║     SHIPPED. This is the strongest possible version of owning a       ║
  ║     defaulted-to decision: AI wrote it, I accepted it, I later read   ║
  ║     it as a real bug, here's the fix and it shipped.                  ║
  ║                                                                       ║
  ╚══════════════════════════════════════════════════════════════════════╝
```

That map is the chapter. The three modes are how you frame every answer in this chapter; the examples are what you anchor to. Burn the map; the rest is delivery.

## The big question — "did you use AI to build this?"

```
  ┌─────────────────────────────────────────────────┐
  │ THEY ASK                                        │
  │   "Did you use AI to build this?"               │
  │                                                 │
  │ WHAT THEY'RE TESTING                            │
  │   Will you be defensive (collapse) or evasive   │
  │   (worse)? Or will you be matter-of-fact about  │
  │   AI's role, matter-of-fact about your role,    │
  │   and end with something thoughtful about       │
  │   what the tools have actually taught you?      │
  └─────────────────────────────────────────────────┘
```

The strong answer, in your voice, in two beats:

> **(Beat 1, ~20s)** "Yes — heavily. Anyone shipping in 2026 who says otherwise is probably lying or working alone in a sealed room. The honest framing is that the **decisions are mine, the AI accelerated the typing**. I think about every decision in this codebase as one of three modes: deliberate (my choice, alternatives considered), evaluated-and-accepted (AI or a library suggested it, I read it, I tested it, I accepted), or defaulted-to (I took the default and didn't deeply evaluate at the time). I can give you examples in any of the three.
>
> **(Beat 2, ~25s)** "The mode I find most useful to talk about is the third one — the defaulted-to. The strongest version of owning a defaulted-to decision is: AI wrote it, I accepted it, I later read it as a real bug, here's the fix, and it shipped. I have one of those in this project. The original `lib/state/insights.ts` was a global `Map<id, Insight>` with a `.clear()` at the top of every briefing write. For one user, correct. For two concurrent users on one warm Vercel instance, user A's `.clear()` wiped user B's mid-session. AI suggested the original shape; I accepted it; I caught it on a concurrency re-read; the fix was to session-key the map. Shipped.
>
> "If you want, I can walk you through one of each mode."

That hand-off at the end gives the interviewer four threads — *one of each mode* — and routes them to specific sections of this chapter. Walk whichever they pick.

```
  ┃ "The decisions are mine. The AI accelerated the
  ┃  typing."
```

```
  ┃ "AI wrote this, I accepted it, I later read it
  ┃  as a real bug, here's the fix, and it shipped."
```

## The follow-ups, by decision mode

### "Give me a deliberate one"

> "The hand-rolled `runAgentLoop`. It's still in the repo at `lib/agents/base-legacy.ts` lines 86–176. I wrote it myself because I needed two disciplines off-the-shelf libraries don't always give you: a hard `maxToolCalls` budget against a rate-limited upstream, and a forced final synthesis turn so the loop terminates with a structured answer instead of a half-finished tool call. AI helped me write the *code*; the *shape* — the budget, the forced-synthesis pattern — was my decision after thinking about how the alpha Bloomreach server's rate limits and token revokes would behave. That's the deliberate mode: the criteria are mine, the typing was accelerated."

### "Give me an evaluated-and-accepted one"

> "The AptKit migration — and this is the load-bearing example in the chapter. Once `@aptkit/core` hit version 0.3.0, the primitive surface got clean: `ModelProvider`, `ToolRegistry`, `CapabilityTraceSink`. I had the hand-rolled loop in front of me with the two disciplines I wasn't willing to give up. I read AptKit's source. I confirmed both disciplines were expressible in the new shape. I built three adapter classes on my side of the boundary — about 200 lines total — and migrated. The legacy is preserved as my rollback receipt.
>
> "What makes this evaluated-and-accepted instead of defaulted-to: it was the conclusion of a comparison, not a default. I owned the alternative (the hand-roll), I checked the new option against the disciplines I cared about, I made the call. And the boundary discipline is mine: *library owns the loop, I own the boundary*. Three small classes, two hundred lines, the legacy preserved for the day I need to peel back to it."

```
  ┃ "I own the boundary; AptKit owns the loop. Three
  ┃  small adapter classes, about 200 lines, and the
  ┃  legacy loop is preserved for the day I need to
  ┃  peel back to it."
```

### "Give me a defaulted-to one (besides the wipe bug)"

> "OAuth PKCE plus Dynamic Client Registration. The MCP SDK ships with an `OAuthClientProvider` interface that expects both, and the Bloomreach loomi connect server is configured for both. I implemented the provider, I didn't pick the protocol. When I defend PKCE and DCR, I'm defending the *mechanics of the wrapper* — the encrypted-cookie store in `lib/mcp/auth.ts`, the `AsyncLocalStorage` threading, the file-backed dev fallback — not the protocol choice.
>
> "What makes this the canonical defaulted-to: I didn't run a comparison against bearer-token-with-refresh or any other auth shape. The SDK said 'this is what you implement' and I implemented it. The senior move on a defaulted-to decision is to name exactly where my knowledge ends — I can defend the wrapper line by line; I can walk you through PKCE's code-verifier-and-S256 dance because I implemented the storage for both sides; but I can't tell you why the IETF chose S256 over the alternatives, and if you push past my implementation into the protocol's design choices, I'll be reading you the spec, not defending a decision I made."

## The other AI questions — what AI got wrong

```
  ┌─────────────────────────────────────────────────┐
  │ THEY ASK                                        │
  │   "What did AI get wrong in this codebase?"     │
  │                                                 │
  │ WHAT THEY'RE TESTING                            │
  │   Have you actually read your own code with a   │
  │   critical eye, or do you trust whatever AI    │
  │   produced? Can you point at real bugs that AI  │
  │   contributed to, with the fix and the lesson?  │
  └─────────────────────────────────────────────────┘
```

The strong answer is a list with specifics. You have four real bugs (covered across Chapters 5 and 6) that AI contributed to in one form or another, plus one AI-suggested decision you re-evaluated. Walk them quickly:

> "Four bugs that AI contributed to and one decision I reconsidered. Quickly:
>
> 1. **The concurrent-user wipe in `lib/state/insights.ts`.** Already walked. AI's global-Map-with-clear pattern. Fix: session-keyed map. Shipped.
>
> 2. **The StrictMode double-fetch in `useInvestigation`.** AI suggested the AbortController cleanup pattern alongside the started-guard. Together they were solving for different lifetimes — in StrictMode, mount-cleanup-remount, the cleanup cancelled the only fetch and the guard blocked the remount from starting fresh. Fix: keep the guard, drop the cleanup-cancel. `setState` after unmount is a safe no-op.
>
> 3. **The bare 500 from `/api/briefing`.** Not strictly AI's fault — it was a missing env var. But the *pattern* of throwing in pre-stream setup without a try/catch was an AI default I'd accepted. The fix wraps the setup in a try/catch that returns a real error JSON.
>
> 4. **The all-at-once coverage reveal.** AI's first cut emitted a single bulk `coverage` event at the end. I wanted per-category reveal. Fix: emit `coverage_item` per category as the agent confirms it.
>
> "And the one **decision I revisited** that AI was on the wrong side of: the hand-rolled loop in `runAgentLoop`. Earlier in the project AI was nudging me toward off-the-shelf agent frameworks. I deliberately stayed hand-rolled because I needed the budget and the forced-synthesis discipline. Later — once `@aptkit/core` exposed a clean primitive surface and I could confirm both disciplines survived — I migrated. That's not AI getting it wrong; that's me being right at the time *and* right later, by different criteria. Important to distinguish those, because if I'd let AI nudge me into a framework at the start I would have ended up with the wrong shape for the constraint."

## The hardest follow-up — "can you explain this section line by line?"

This is the **drill-down probe**. The interviewer picks a file, scrolls to a function, and asks you to walk it. The trap is to wing it. The fix is to know which sections you've read carefully and which you haven't, and to be honest about the difference.

```
  ╔═══════════════════════════════════════════════╗
  ║ WHEN YOU DON'T KNOW                           ║
  ║                                               ║
  ║   They open lib/mcp/auth.ts and point at the  ║
  ║   AES-256-GCM encrypted-cookie store. "Walk   ║
  ║   me through this line by line."              ║
  ║                                               ║
  ║   You implemented this wrapper. You wrote     ║
  ║   the storage methods. You've debugged a      ║
  ║   real bug in this file (the bare-500). But   ║
  ║   if they push into the cryptographic         ║
  ║   primitives — why GCM mode, what IV reuse    ║
  ║   means, AEAD properties — you'll fold.       ║
  ║                                               ║
  ║   Say:                                        ║
  ║   "I can walk you through the storage         ║
  ║    methods, the AsyncLocalStorage threading,  ║
  ║    and the dev-vs-prod store split. I can     ║
  ║    tell you what aesKey() does and why it     ║
  ║    throws on missing AUTH_SECRET — that's     ║
  ║    the source of the bare-500 bug I fixed.    ║
  ║    What I can't defend from first principles  ║
  ║    is the choice of AES-256-GCM specifically  ║
  ║    over alternatives — I implemented what     ║
  ║    the Node crypto API surfaced. If you want  ║
  ║    to push into AEAD properties or IV reuse   ║
  ║    semantics, I'll be reading you the docs.   ║
  ║    Which part would you like me to walk?"     ║
  ║                                               ║
  ║   What this signals: a precise map of what    ║
  ║   you wrote vs what you delegated, no fake    ║
  ║   confidence on cryptographic internals you   ║
  ║   didn't design.                              ║
  ║                                               ║
  ║   Do NOT say:                                 ║
  ║   "GCM is generally recommended for           ║
  ║    encryption because it's authenticated."    ║
  ║   This is a sentence you read on a blog. The  ║
  ║   security interviewer will ask "authenticated║
  ║   against what" and the conversation ends.    ║
  ╚═══════════════════════════════════════════════╝
```

## The follow-up tree

```
  You give the "decisions mine, typing accelerated" frame.
        │
        ▼
        ├─► "Give me an example of each mode"
        │     Deliberate: hand-rolled loop.
        │     Evaluated: AptKit migration.
        │     Defaulted-to: OAuth PKCE (or the wipe bug).
        │
        ├─► "What did AI get wrong?"
        │     Four real bugs, walked above. Each has
        │     a file, a fix, a lesson.
        │
        ├─► "How much of this code did you write yourself
        │    vs AI?"
        │     Honest re-frame: that's the wrong metric.
        │     The right metric is which decisions are
        │     mine. Lines of code is noise; load-bearing
        │     decisions is signal. The boundary in
        │     aptkit-adapters.ts is 200 lines I co-wrote
        │     with AI, but every shape in that file is
        │     mine.
        │
        ├─► "Could you have built this without AI?"
        │     Yes, slower. The hand-rolled loop predates
        │     the migration. The eval suite I built and
        │     retired predates the synthetic adapter.
        │     AI accelerates the typing; the disciplines
        │     are what make the code shippable.
        │
        └─► "Can you explain THIS section line by line?"
              Pick. Honest about where the read is
              careful (boundary code, the hooks, the
              streaming kernel) vs where it's
              implementation-of-a-spec (PKCE internals,
              GCM choice). Re-route to a thread you can
              walk in depth.
```

## What AI got *right* — the one thing worth volunteering

The interviewer is rarely going to ask this. Volunteer it, because it shows the senior posture of separating signal from noise.

> "One thing worth saying about the positive side: the **AptKit migration** is the single decision in this project that AI helped me make better. Not by suggesting AptKit — I found that on my own. But by helping me think through whether my two disciplines (the budget, the forced synthesis) survived in the new primitive surface. I'd read parts of AptKit's source, sketch how my discipline would map onto its `ToolRegistry` and `ModelProvider`, paste both into a conversation with AI, and ask 'what's the failure mode of this mapping I haven't thought of?' That's evaluated-and-accepted at its strongest — I'm using AI as a sounding board to pressure-test a decision I'm making, not as the decision-maker. The 200-line adapter file is the artifact of that process."

```
  ┃ "Use AI as a sounding board to pressure-test a
  ┃  decision you're making, not as the decision-
  ┃  maker."
```

## What you'd change about your AI workflow

The one meta-counterfactual on AI use: I'd be more deliberate about **flagging defaulted-to code at write-time, not later**. The concurrent-user wipe in `insights.ts` was a defaulted-to decision I caught on a later re-read. The right shape is to mark the file at write-time — a comment like `// AI-suggested shape; concurrency reread needed` — and revisit it before shipping. That artifact would have caught the wipe before two concurrent users could trigger it. The trigger is any code path that touches shared state across requests; that's a small-enough surface to audit deliberately.

## One-page summary

**Core claim:** The AI question rewards the calibrated-honest answer. Decisions in three modes — deliberate, evaluated-and-accepted, defaulted-to. The strongest version of owning a defaulted-to decision is: AI wrote it, I accepted it, I later read it as a real bug, here's the fix, and it shipped.

**The frame in one line:** "The decisions are mine. The AI accelerated the typing."

**Examples of each mode:**
- **Deliberate** → the hand-rolled `runAgentLoop`; the DataSource seam; NDJSON over fetch.
- **Evaluated-and-accepted** → the AptKit migration; the page decomposition into 3 hooks; the shared `readNdjson` kernel.
- **Defaulted-to** → OAuth PKCE+DCR; the original `insights.ts` wipe (caught, fixed, shipped).

**What AI got wrong (with fixes):** concurrent-user wipe, StrictMode double-fetch, bare-500 setup pattern, all-at-once coverage reveal.

**What AI got right (worth volunteering):** sounding-board for the AptKit migration — pressure-tested whether two disciplines survived.

**Pull quotes:**
```
  ┃ "The decisions are mine. The AI accelerated the
  ┃  typing."

  ┃ "AI wrote this, I accepted it, I later read it
  ┃  as a real bug, here's the fix, and it shipped."

  ┃ "Use AI as a sounding board to pressure-test a
  ┃  decision you're making, not as the decision-
  ┃  maker."
```

**What you'd change:** mark defaulted-to code at write-time with a flag for later re-read, especially anywhere touching shared state across requests. The artifact would catch defaulted-to bugs before users do.
