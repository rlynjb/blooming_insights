# Chapter 7 — The counterfactuals

The senior-engineer move is to **volunteer what you'd reconsider before being asked**. Junior candidates wait for the interviewer to find a weakness and then defend it. Senior candidates name the reconsideration themselves, with a named trigger that would change the decision, and the named tradeoff that's being paid in the meantime.

The mirror-image trap is the *fake regret* — fabricating a counterfactual for a decision that was clearly right, because you think the interviewer wants to hear it. They don't. A fake counterfactual is louder than a missing one. This chapter teaches you both halves: **the four decisions you'd reconsider** (each with a real trigger), and **the four decisions you'd keep** (each with the receipt that proves it earned its place).

## The counterfactuals matrix — the chapter on one page

The visual anchor. Left column is what you'd reconsider; right column is what you'd keep. Each row's bottom is the receipt or the trigger.

```
  blooming insights — what you'd reconsider vs what you'd keep

  ┌────────────────────────────────┬────────────────────────────────┐
  │   WOULD RECONSIDER             │   WOULD KEEP                   │
  │   (with named trigger)         │   (with the receipt)           │
  ├────────────────────────────────┼────────────────────────────────┤
  │                                │                                │
  │ 1. No database                 │ A. NDJSON + readNdjson kernel  │
  │    (in-process Map)            │    (lib/streaming/ndjson.ts,   │
  │                                │     64 LOC, 4 surfaces)        │
  │    Concurrent-user wipe is     │                                │
  │    RESOLVED (session-keyed).   │    Receipt: one kernel, four   │
  │    Open: cross-instance state. │    consumers, no duplication.  │
  │    Trigger: multi-instance.    │                                │
  │                                │                                │
  ├────────────────────────────────┼────────────────────────────────┤
  │                                │                                │
  │ 2. Demo-replay as the          │ B. TypeScript                  │
  │    reliability path            │                                │
  │                                │    Receipt: every event-shape  │
  │    Workaround for alpha        │    boundary in the system has  │
  │    Bloomreach (revokes         │    a type and breaks loudly    │
  │    tokens after minutes).      │    when violated. The bare-500 │
  │    Trigger: stable upstream.   │    bug would have been worse   │
  │                                │    without it.                 │
  │                                │                                │
  ├────────────────────────────────┼────────────────────────────────┤
  │                                │                                │
  │ 3. Fixed ~1.1s call spacing    │ C. DataSource seam + adapter   │
  │    on BloomreachDataSource     │    pattern                     │
  │                                │                                │
  │    Conservative for ambiguous  │    Receipt: survived 2 adapter │
  │    rate limit. Costs me real   │    swaps (Olist in then out,   │
  │    latency on every live run.  │    Synthetic in) without       │
  │    Trigger: stable headroom +  │    changing the caller surface.│
  │    measurement.                │                                │
  │                                │                                │
  ├────────────────────────────────┼────────────────────────────────┤
  │                                │                                │
  │ 4. Coverage deps as exact      │ D. AptKit primitive boundary   │
  │    event-name match (no        │    (3 small adapter classes)   │
  │    alias layer)                │                                │
  │                                │    Receipt: library owns the   │
  │    Deliberate — alias indir-   │    loop, I own the boundary,   │
  │    ection adds cost. Trigger:  │    legacy preserved at         │
  │    workspaces with different   │    base-legacy.ts as the       │
  │    event naming conventions.   │    rollback receipt.           │
  │                                │                                │
  └────────────────────────────────┴────────────────────────────────┘
```

Walk left-then-right. The left column shows judgment; the right column shows discipline. Both halves are the senior signal.

## What's NOT on the would-keep list (and why)

One thing that *used to be* on the would-keep list is **the shared `runAgentLoop`**. It's not anymore. The hand-rolled loop is now legacy — preserved at `lib/agents/base-legacy.ts:86-176` as the rollback receipt, but no longer the active path. The active path is `@aptkit/core@0.3.0` behind three small adapter classes. That migration is the proudest part (Chapter 6) and a load-bearing decision-revisit; calling it out as a "would-keep" today would be defending a decision the project has already moved past.

This kind of honesty — *that's what I kept, this is what I changed* — is the senior-shape of the counterfactuals chapter.

## Reconsideration 1 — No database (in-process state)

```
  ┌─────────────────────────────────────────────────┐
  │ THEY ASK                                        │
  │   "What would you do differently?"              │
  │                                                 │
  │ WHAT THEY'RE TESTING                            │
  │   Will you volunteer your weakest decision and  │
  │   name the trigger that would change it? Or     │
  │   will you wait to be asked, and then defend?   │
  └─────────────────────────────────────────────────┘
```

> "Top of my reconsiderations list: the in-process state in `lib/state/insights.ts`. Today it's a `Map<sessionId, SessionFeed>` — session-keyed, which fixed the concurrent-user wipe bug I caught earlier (Chapter 6's defaulted-to story). So the *concurrency* problem is resolved. What's still open is **cross-instance state** — if a user's first request lands on Vercel instance A and their second request lands on instance B, B has no memory of the session.
>
> "For a portfolio project with no production traffic that's not a real problem. The trigger that would change my design is **multi-instance deployment**, which a single-region Vercel hobby tier doesn't have. The day there's a real second instance, I'd reach for Vercel KV or a small Postgres — the `lib/state/insights.ts` module is already the seam, so it's a substitution behind one interface, not a refactor.
>
> "The fake-regret version of this answer would be 'I'd add Postgres from day one because real systems need a database.' That's not true for this system. The right shape was deferring the database until I knew what state I needed. The concurrent-user bug was the lesson; session-keying fixed it; cross-instance is the next move *only when the trigger arrives*."

## Reconsideration 2 — Demo-replay as the reliability path

> "Demo mode exists because the alpha Bloomreach server revokes tokens after minutes. That's a real constraint and demo mode is a real fix — but it shapes the design in ways I'd reconsider if the upstream got stable.
>
> "Specifically, the route handler for `/api/briefing` has a branch that switches between live and the committed snapshot in `lib/state/demo-insights.json`. There's machinery — the dev-only one-click capture in `useDemoCapture`, the per-step replay filter, the schema that lets older snapshots still validate. All of that is honest fallback machinery, but it's machinery I wouldn't need if the upstream were stable.
>
> "The trigger is **a stable upstream that doesn't revoke tokens**. The day Bloomreach's MCP server reaches GA with documented session lifetimes, demo-replay becomes a development convenience rather than a presentation necessity. I'd keep the capture path (it's a fast local dev loop), but I'd retire the demo-as-default branch in production. The default mode would flip from `'demo'` to `'live-bloomreach'`."

## Reconsideration 3 — Fixed ~1.1s call spacing on `BloomreachDataSource`

> "This is the one I'd reconsider *the soonest* if I were operating the system. I'm spacing calls at roughly 1.1 seconds because the rate limit is documented ambiguously and I picked a conservative number to stay safe. That choice is costing me real latency on every live run — a multi-step diagnostic agent makes 10–15 tool calls, and at 1.1s spacing that's 10–15 seconds of artificial wait per investigation.
>
> "The trigger to change it is a **stable upstream with documented headroom plus measurement**. With a real production telemetry signal — per-call latency and 429-rate histograms — I'd find the actual ceiling and tighten the spacing to it. The fix is one constant in `BloomreachDataSource`; the courage to change it requires the measurement.
>
> "The reason this matters for the counterfactuals chapter is that it's a real cost being paid right now, not a hypothetical at scale. Volunteering it tells the interviewer I know where my own performance is being sacrificed for safety, and I know what would let me reclaim it."

## Reconsideration 4 — Coverage deps as exact event-name match

> "This one's narrower. The monitoring agent's coverage logic — whether a given category has been confirmed checked — keys off exact Bloomreach event names. If a workspace happens to use `customer_session_start` instead of `session_start`, my coverage logic doesn't recognize it and the category stays empty.
>
> "I deliberately didn't build an alias layer. The alias layer would add a layer of indirection — a config or convention mapping workspace-specific names to my canonical names — and for the single workspace I've tested against (the standard Bloomreach ecommerce event taxonomy), it's overhead with no benefit.
>
> "The trigger is **a workspace with different event naming conventions**. The day I encounter one, the alias layer earns its keep — without one, I'd be hand-editing tool-coverage.ts for every new workspace, which doesn't scale and produces a worse user experience than 'this category isn't checked' (which currently surfaces honestly in the UI).
>
> "Naming this as a reconsideration rather than a current change is the right call — it's a real *future* fix triggered by a real *future* condition, not a regret I should fake today."

```
  ┌─────────────────────────┬─────────────────────────┐
  │ WEAK COUNTERFACTUAL     │ STRONG COUNTERFACTUAL   │
  ├─────────────────────────┼─────────────────────────┤
  │ "If I were starting     │ "Top of my list: the    │
  │ today I'd use Postgres  │ in-process insights map.│
  │ from day one. And       │ Concurrent-user wipe is │
  │ probably Redis. And     │ resolved with session-  │
  │ proper monitoring. And  │ keying; cross-instance  │
  │ maybe Kubernetes."      │ is still open. Trigger  │
  │                         │ is multi-instance,      │
  │                         │ which a portfolio       │
  │                         │ project doesn't have."  │
  ├─────────────────────────┼─────────────────────────┤
  │ Why it's weak:          │ Why it works:           │
  │ Fake regret menu. Lists │ Names the reconsider-   │
  │ infrastructure the      │ ation, names the        │
  │ project doesn't need.   │ trigger, names what's   │
  │ Reads as "I think the   │ already done. No fake   │
  │ interviewer wants to    │ regret. The interviewer │
  │ hear about Postgres."   │ hears judgment, not     │
  │                         │ performance.            │
  └─────────────────────────┴─────────────────────────┘
```

## The would-keep list — what earned its place

The right way to talk about each kept decision is **with the receipt that proves it earned its place**, not as a defense of why it was the right call originally. The receipts are what turn the answers into something the interviewer can verify.

> **A. NDJSON + the `readNdjson` kernel.** The kernel is `lib/streaming/ndjson.ts`, 64 lines, and it's consumed by four streaming surfaces — `/api/briefing`, `/api/agent` for the diagnose step, `/api/agent` for the recommend step, and the free-form query. The receipt for keeping the design is that the same 64 lines serve four consumers without duplication and without a leak. If I had reached for SSE or a websocket I'd be paying for capabilities I don't use (SSE's framing convention, websocket's bidirectional surface) on every surface.
>
> **B. TypeScript.** Every event-shape boundary in the system has a type and breaks loudly when it's violated. The receipt: when I was debugging the bare-500 bug (Chapter 6), the type signature of the route handler told me where the error path was wrong before I even read the code. Without TS, that bug would have taken longer to find and fix.
>
> **C. The DataSource seam + adapter pattern.** The receipt is two adapter swaps. Olist was added; Olist was removed (when I retired the eval suite with it); Synthetic was added. Each swap kept the caller surface — `dataSource.executeEql(...)`, `dataSource.listTools()` — unchanged. *That's the test for whether a seam is real.* Future-proofing is when you add an abstraction "in case." Receipt-driven is when the abstraction has already paid for itself by absorbing real change.
>
> **D. The AptKit primitive boundary.** Three small adapter classes — `AnthropicModelProviderAdapter`, `BloomingToolRegistryAdapter`, `BloomingTraceSinkAdapter`. About 200 lines total. The receipt for keeping this design over the alternatives (own the whole loop / use a heavier framework) is that the legacy hand-rolled loop is preserved at `lib/agents/base-legacy.ts`, lines 86–176. If AptKit's API ever shifts in a way that breaks one of my disciplines, I peel back to the legacy and re-evaluate. The preservation is the receipt for the discipline being load-bearing in the first place.

```
  ┃ "Future-proofing is when you add an abstraction
  ┃  in case. Receipt-driven is when the abstraction
  ┃  has already paid for itself by absorbing real
  ┃  change."
```

## The follow-up tree

```
  You volunteer the four reconsiderations.
        │
        ▼
        ├─► "Why haven't you fixed those?"
        │     Each reconsideration has a *trigger* —
        │     multi-instance, stable upstream, measured
        │     headroom, workspace with different naming.
        │     The trigger isn't here yet for any of them.
        │     Acting before the trigger is over-engineering;
        │     acting after the trigger is on-time. Naming
        │     the trigger explicitly is the senior signal.
        │
        ├─► "What about [thing I didn't list]?"
        │     The honest answer for things you'd actually
        │     keep is to defend the receipt. The honest
        │     answer for things you've genuinely not
        │     considered is "I haven't thought about that
        │     one — walk me through what you'd reconsider
        │     and why?" Re-route to a conversation.
        │
        ├─► "What's the would-not-change list?"
        │     The four items in the right column. Each
        │     defended with the receipt, not the original
        │     justification.
        │
        └─► "What about the agent loop — would you write
            it yourself again?"
              The honest answer is *I already did, and
              then I revisited the decision*. The hand-
              roll is preserved as base-legacy.ts. The
              active path is AptKit. That decision-revisit
              is in Chapter 3 (Choice 2) and Chapter 6
              (the proudest part).
```

## When you don't know

The territory you're most likely to get pushed past your depth in this chapter is **decisions about technologies you didn't seriously evaluate**. If the interviewer says "would you reconsider using Anthropic vs OpenAI?" — and you only ever tried Anthropic — be honest.

```
  ╔═══════════════════════════════════════════════╗
  ║ WHEN YOU DON'T KNOW                           ║
  ║                                               ║
  ║   They ask: "Would you reconsider using       ║
  ║   Anthropic vs OpenAI for the agents?"        ║
  ║                                               ║
  ║   You didn't run a head-to-head. You picked   ║
  ║   Anthropic and shipped against Sonnet 4.6.   ║
  ║                                               ║
  ║   Say:                                        ║
  ║   "Honest answer: I didn't run a head-to-     ║
  ║    head against OpenAI's models for this      ║
  ║    project. I picked Anthropic because Sonnet ║
  ║    4.6 worked well in earlier projects and    ║
  ║    the SDK and tool-use story was clean       ║
  ║    enough for me to focus on the system       ║
  ║    rather than the provider. The reconsider-  ║
  ║    ation I would do — and haven't — is a      ║
  ║    real eval bake-off against a couple of     ║
  ║    OpenAI's models on the diagnostic synth-   ║
  ║    esis turn, because that's where reasoning  ║
  ║    quality matters most. Without that eval    ║
  ║    I can't tell you which one would be        ║
  ║    better. What I can defend is the boundary  ║
  ║    that lets me swap — the model provider     ║
  ║    sits behind AnthropicModelProviderAdapter, ║
  ║    so adding an OpenAI adapter is the same    ║
  ║    shape as the existing one."                ║
  ║                                               ║
  ║   What this signals: honesty about the eval   ║
  ║   you didn't run, awareness of the design     ║
  ║   property (the swap-ability) that protects   ║
  ║   the decision being reconsiderable.          ║
  ║                                               ║
  ║   Do NOT say:                                 ║
  ║   "Anthropic is better for agentic tool use   ║
  ║    than OpenAI, that's why I picked it."      ║
  ║   This is a generalization you can't back up. ║
  ║   The interviewer will ask "based on what     ║
  ║   benchmark?" and you'll fold.                ║
  ╚═══════════════════════════════════════════════╝
```

## What you'd change about the counterfactuals practice itself

The one meta-counterfactual: I'd be more aggressive about **writing the trigger down at the time of the decision**, not after. Right now the triggers for each reconsideration live in my head and in this chapter. If I were starting today I'd add a short "decisions and triggers" log — one paragraph per load-bearing decision, with the named trigger that would change it. That artifact would be useful to me in three months and useful to anyone who reads the repo.

## One-page summary

**Core claim:** Volunteer the reconsiderations with named triggers. Defend the would-keeps with the receipts that prove they earned their place. Don't fake regret for decisions that were right.

**The four reconsiderations in one line each:**
- **No DB** → trigger is multi-instance deployment; concurrent-user wipe already fixed via session-keying.
- **Demo-replay** → trigger is a stable upstream; today it's load-bearing because the alpha revokes tokens.
- **1.1s call spacing** → trigger is stable headroom + measurement; today it costs real latency on every live run.
- **Coverage exact-name match** → trigger is workspaces with different event naming; alias layer is overhead today.

**The four would-keeps in one line each:**
- **NDJSON + `readNdjson` kernel** → 64 LOC, 4 surfaces, no duplication.
- **TypeScript** → every event-shape boundary types-and-breaks loudly.
- **DataSource seam** → survived 2 adapter swaps without caller change.
- **AptKit boundary** → library owns the loop, I own the boundary, legacy preserved as rollback.

**Pull quote:**
```
  ┃ "Future-proofing is when you add an abstraction
  ┃  in case. Receipt-driven is when the abstraction
  ┃  has already paid for itself by absorbing real
  ┃  change."
```

**What you'd change:** keep a written "decisions and triggers" log alongside the code, not just in your head. The artifact is useful to your future self.
