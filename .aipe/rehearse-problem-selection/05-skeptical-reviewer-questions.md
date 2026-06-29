# 05 — Skeptical Reviewer Questions

> The review-room questions the brief survives. For each: the question as the reviewer would actually ask it, the strongest answer in coach voice (don't say X, say Y), and the receipt the answer points to.

```
  THE PRESSURE-TEST GRID — six categories, the hard question in each

  ┌─────────────────────┬────────────────────────────────────────┐
  │ category            │ the question that exposes weak briefs  │
  ├─────────────────────┼────────────────────────────────────────┤
  │ existence           │ does the user pain actually exist?     │
  │ differentiation     │ why isn't this commodity?              │
  │ scope               │ why this small? / why this big?        │
  │ quality             │ how do you know any of it's good?      │
  │ economics           │ does the unit math work?               │
  │ identity            │ what is this product, in one sentence? │
  └─────────────────────┴────────────────────────────────────────┘
```

Each question below: how it lands in the room, the wrong answer (the trap), the right answer (with the receipt), and the follow-up the reviewer asks next.

---

## EXISTENCE QUESTIONS

### Q1 — "How do you know any analyst actually wants this? Isn't this a solution looking for a problem?"

**The trap answer:** "We talked to some marketers and they said it would be useful." — Vague, unverifiable, performative.

**The right answer:**
> "Honest answer — the repo proves the workflow exists, not that the pain is widespread enough to scale investment around. The three-context loop (notice → hunt → decide) is encoded in the stepper UI and the dual-agent split because that's the loop a Bloomreach analyst actually runs. What the repo doesn't prove is **how many** analysts experience that loop as painful enough to want a tool. That's the discovery question. The move I'd make before scaling agent count is 5 conversations with marketers on Bloomreach Engagement, timing the manual loop and asking what they currently do when a metric moves. If the loop is 15+ minutes and they currently *don't* investigate half the alerts because it's too expensive — the product has its problem. If the loop is 3 minutes and they breeze through it — the product doesn't."

**The receipt:** the brief in `01-problem-brief.md` names this exact discovery question. **A brief that names what it doesn't know lands harder than a brief that pretends to.**

**Follow-up the reviewer asks next:** "What would you change about the product if those 5 conversations told you the pain is small?" — and the answer is "I'd swap the bet from 'reasoning-trace as differentiator' to something else, because the trust surface is only worth building if the analyst is currently in a low-trust situation." That's the chain of logic working.

---

### Q2 — "Why hasn't Bloomreach built this themselves?"

**The trap answer:** "They will eventually, but we'll be there first." — Naive about competitive dynamics.

**The right answer:**
> "They might. The MCP server they shipped — loomi connect — is the substrate that makes this kind of integration possible, and they shipped it because they want this layer to exist. **Whether they build it themselves or partner with someone who builds it well is an open question.** What this product proves is the *shape* of the solution: the stepper, the dual-agent split, the reasoning-trace as a first-class surface. If Bloomreach absorbs that pattern, the work was still valuable as a portfolio piece and as a demo for the partnership conversation."

**The receipt:** `03-options-and-opportunity-cost.md` Option E names "ship as a native Bloomreach feature" as a real option that's currently gated on partnership timing — not on technical feasibility.

**Follow-up:** "If Bloomreach calls tomorrow and wants to acquire/partner, what's your answer?" — that's a separate conversation, but the brief is structured so the answer is yes (it was always one of the options).

---

## DIFFERENTIATION QUESTIONS

### Q3 — "Every AI product says it has an agent. What's actually different here?"

**The trap answer:** "We use Claude Sonnet, multi-agent, MCP." — Stack-listing, no substance.

**The right answer:**
> "The differentiator isn't the agent — the agent is commodity now. The differentiator is **the reasoning trace as a first-class product surface.** Every conclusion carries the exact tool call, the current-vs-prior numbers, and a streamed log of the reasoning, visible in a sticky sidebar (`StatusLog`) on every page. Most AI products treat reasoning as a debug log behind a toggle. This product treats it as 1/3 of the main UI. The NDJSON event protocol (`AgentEvent` in `lib/mcp/events.ts`) is locked as 'what must not change' precisely because the trace is part of the product contract, not a side-channel."

**The receipt:** `components/shared/StatusLog.tsx` is on every page (feed, both investigate steps). `components/investigation/ReasoningTrace.tsx` renders per-line agent badge + step kind + content + timestamp with `ToolCallBlock`s. The codebase commits to the trace at the architectural level, not the marketing level.

**Follow-up:** "How do you know analysts care about that vs just wanting an answer?" — that's Q4. The brief is honest about it being an untested bet on rung 3 of the metrics ladder.

---

### Q4 — "Does anyone actually want to read the reasoning, or do they just want the answer?"

**The trap answer:** "Of course they do, it builds trust." — Asserting the product's central bet, not defending it.

**The right answer:**
> "**Honest answer: I don't know yet, and that's the load-bearing bet of the product.** The brief is explicit about this — it's rung 3 of the metrics ladder, not yet measured. The A/B I'd run: same recommendation, with and without the trace visible, measure forward-rate via the markdown export. The hypothesis is that analysts who have to defend the recommendation to their stakeholder will *prefer* the trace because it's the thing they paste into the Slack message. The opposite hypothesis is that the trace is wallpaper and they only look at the conclusion card. If the opposite hypothesis wins, the trace becomes a collapsed default and the product simplifies. The bet is testable; that's the discipline."

**The receipt:** `04-success-metrics-and-feedback-loop.md` rung 3 names this as the central, unmeasured bet. **Honesty about which bet is unverified is the move.**

**Follow-up:** "What's plan B if the trace doesn't win?" — collapse it to a "see how I got this" link, simplify the recommendation card, ship faster on the recommendation quality.

---

## SCOPE QUESTIONS

### Q5 — "Why isn't this saving to a database? Every real product persists state."

**The trap answer:** "We'll add it later." — Treating it as a missing feature, not a deliberate cut.

**The right answer:**
> "**Cut 1 in the scope-cuts file** — it's deliberate, not deferred-by-accident. Persistence is a feature wishlist trap. The moment you add a database, you add schema design, migration discipline, multi-tenant isolation, backup, retention, GDPR, the entire ops surface of a stateful product. The product is currently validating the question 'is the reasoning loop worth running'; it's not yet validating the question 'is the persistence model worth designing.' In-memory state plus the committed demo snapshot is the substitute, and it works. **The smallest event that puts persistence back in scope is an analyst saying 'I want to come back to last week's investigation' twice in a row.** Until that's a stated complaint, the right call is `do nothing`."

**The receipt:** `02-scope-cuts-and-non-goals.md` Cut 1 — with the exact code paths (`lib/state/insights.ts`, `lib/state/investigations.ts`, `lib/state/demo-*.json`) that prove the in-memory choice is structural, not accidental.

**Follow-up:** "Doesn't the demo path being the reliable presentation path scare you?" — see Q11.

---

### Q6 — "Why aren't you also building Shopify? Bloomreach is a small market."

**The trap answer:** "We'll generalize once we've nailed Bloomreach." — Vague roadmap, no defensible reason for now.

**The right answer:**
> "**Option F in the options file** — generalizing is on the table, but not for v0. The recommendation vocabulary is the load-bearing detail of the product. Bloomreach has scenarios, segments, vouchers, experiments — a specific feature surface the recommendation agent names by hand. Generalizing means the agent can only suggest the lowest-common-denominator action, losing the precision that's currently a strength. **The seam is built** — there's a `DataSource` port with an in-process Synthetic adapter behind it (the test substrate proving the seam works) — so adding Shopify later means writing an adapter, not rewriting the agents. The deliberate decision is **don't pay the abstraction cost until a second customer asks for it.**"

**The receipt:** `03-options-and-opportunity-cost.md` Option F — names the cost of generalization (recommendation precision loss) and the asset that keeps the option open (the `DataSource` seam).

**Follow-up:** "What if Bloomreach is too small a market to justify the engineering investment?" — that's the existence question (Q1) wearing a different hat; the answer is the same discovery move.

---

## QUALITY QUESTIONS

### Q7 — "How do you know any of the agent output is actually good?"

**The trap answer:** "We have an eval suite running on every commit." — A claim that doesn't survive contact.

**The right answer:**
> "Today, by eyeballing the trace — same way it was before the eval suite shipped. **But I built the eval harness once**, calibrated it 8/8 + 3/3 against manual review, and used it to surface 3 real bugs no unit test would catch: BRL units (cents vs Reais, surfaced at run 8 by an implausible R$131,965 average order value), binary calibration drift (a criterion grading 29/30 when it should have been binary), and conclusion instability (30% regression baseline across K=10 runs on the same anomaly). When I swapped to the in-process Synthetic adapter as a cleaner data shape, I retired the eval with the substrate it ran against. **That was a deliberate call.** The rebuild target is named — the next version runs against Synthetic, where the substrate is deterministic and the eval doesn't decay with the data. **The receipt of having done the work once, surfaced bugs with it, and made the deliberate call to retire it is stronger than promising to.**"

**The receipt:** `04-success-metrics-and-feedback-loop.md` rung 2 — the 4 pillars, the 3 named bugs, the calibration discipline, the named rebuild gate.

**Follow-up:** "When will the rebuild happen?" — when the Synthetic substrate stabilizes enough to support deterministic anomaly seeding. That's the rebuild gate, named, not vague.

---

### Q8 — "Why did you migrate from your own agent loop to AptKit? Wasn't your own loop fine?"

**The trap answer:** "AptKit is better." — Vague, no decision frame.

**The right answer:**
> "Phase 1, the hand-rolled `runAgentLoop` was deliberate — I needed a `maxToolCalls` budget and a forced synthesis turn against a rate-limited alpha server, and writing it myself was the fastest way to get those guarantees. **Once `@aptkit/core@0.3.0` had a clean generic-primitive surface**, the migration was 3 adapter classes in `lib/agents/aptkit-adapters.ts`. Library owns the loop; I own the boundary. **The legacy is preserved at `lib/agents/base-legacy.ts` as a rollback receipt.** That's an `evaluated-and-accepted` move — I revisited a decision I'd originally defended deliberately, because the better surface existed. The original constraints (budget, synthesis turn) still hold; AptKit gave me a way to express them through a generic primitive instead of a custom loop."

**The receipt:** the migration is a real architectural change visible in the file structure (`base.ts` vs `base-legacy.ts`, plus the adapter classes). **The discipline of preserving the legacy as a rollback receipt is itself the signal.**

**Follow-up:** "If AptKit had a bug tomorrow that broke the loop, what would you do?" — flip to legacy via the boundary, ship a hotfix, file the AptKit issue. The boundary is precisely so that swap is cheap.

---

### Q9 — "Why did you retire the data substrate you originally built the eval against?"

**The trap answer:** "It didn't work out." — No decision framing.

**The right answer:**
> "I proved the `DataSource` seam by using it against a real public ecommerce dataset — that was the right substrate for proving the seam was real, not theoretical. Once the seam was proven, the in-process Synthetic adapter became a cleaner data shape: deterministic, no external server, no rate limits, no token revocation. **Retiring the original substrate was an honest 'we tried this, learned, picked better' call** — and the seam survived, because it was always meant to be a seam, not a coupling to any one source. The Synthetic adapter slotted in behind the same port. The receipt is: the architecture passed the swap test."

**The receipt:** the `DataSource` port architecture means there is a seam to swap behind, not a rewrite. That's the entire point of having built the port in the first place.

**Follow-up:** "What's the eval gap now?" — same as Q7. The answer is consistent across the brief.

---

## ECONOMICS QUESTIONS

### Q10 — "What does running this cost per investigation? Does the unit math work?"

**The trap answer:** "It's pretty cheap." — Not a number.

**The right answer:**
> "I don't have a per-investigation cost benchmark yet — it depends on the anomaly count, the diagnostic agent's tool-call depth (bounded by `maxToolCalls`), and the recommendation agent's prompt complexity. What I can name today: the model choices are deliberate cost-vs-quality decisions. `claude-haiku-4-5-20251001` for the intent classifier (cheap, fast, structured output). `claude-sonnet-4-6` for the agents (the cost the product accepts to keep the reasoning quality high enough to defend in the trace). The `maxToolCalls` budget caps each agent's worst-case spend. **The economic question I can't answer today is what a Bloomreach analyst would pay per investigation** — and that's gated on the existence question (Q1)."

**The receipt:** the model choices are visible in the project context — Haiku for the cheap classifier, Sonnet for the agents — and the `maxToolCalls` cap is in the legacy `runAgentLoop` and preserved through the AptKit adapter.

**Follow-up:** "What's the most expensive investigation you've seen?" — capture it from a live run, name the number, use it as the worst-case anchor in the next conversation. The instrumentation is straightforward; the gate is having a live customer.

---

## IDENTITY QUESTIONS

### Q11 — "If the demo is the reliable presentation path, isn't the live path basically broken?"

**The trap answer:** "Live works most of the time." — Defensive.

**The right answer:**
> "**The live path is recovery-oriented, not magic-oriented.** The alpha MCP server is rate-limited (~1 req/s, enforced in `lib/mcp/client.ts`) and revokes tokens after minutes. The feed has auto-reconnect on `invalid_token` (`app/page.tsx`). Those are real constraints from a real alpha server — not bugs we're hiding. The product's response is honest: **capture a fresh snapshot locally, commit it as the demo, present from the demo.** The demo isn't a substitute for the live path — it's the **reliable presentation surface** that the live path feeds. When Bloomreach stabilizes the server, the live path becomes the presentation surface. Today, the demo is. **That's an honest call about the substrate we're building against, not a defect.**"

**The receipt:** the demo capture flow (`app/page.tsx` dev-only one-click capture; `lib/state/demo-*.json` committed) is a built feature, not a workaround. The product has a deliberate two-mode design.

**Follow-up:** "What if Bloomreach never stabilizes the alpha?" — then the demo-first posture stays. The product still works; the presentation surface is just permanently the snapshot.

---

### Q12 — "In one sentence, what is this product?"

**The trap answer:** "An AI-powered analytics platform for ecommerce." — Marketing fluff, no signal.

**The right answer:**
> "**An analyst that shows its work** — a multi-agent reasoning loop on a Bloomreach Engagement workspace that goes from 'what changed' to 'why' to 'what to do,' with the reasoning streamed as a first-class UI surface so the analyst can defend the recommendation to their stakeholder."

**The receipt:** the entire brief — the stepper, the dual-agent split, the streamed trace, the show-your-work surface — radiates from this sentence. **If a sentence doesn't carry the whole brief, the sentence is wrong.**

**Follow-up:** "How is that different from ChatGPT with a Bloomreach plugin?" — ChatGPT with a plugin gives you a chat thread; this product gives you the **structured artifact** (Insight → Diagnosis → Recommendation, with NDJSON-streamed trace, with markdown export) that survives the conversation and travels to the analyst's stakeholder. The shape of the output is the differentiator, not the model behind it.

---

## The defense posture, summarized

```
  THE DEFENSE POSTURE — three moves that carry the room

  1. NAME the receipts you have                  ← rung 1 + rung 2 (suite ran,
                                                   3 bugs surfaced, retired
                                                   deliberately)

  2. NAME the bets you haven't validated         ← rung 3 (show-your-work
                                                   beats magic) — explicitly
                                                   the load-bearing untested bet

  3. NAME the discovery questions before they    ← Q1, Q4, the metrics gaps —
     ask                                            said before the reviewer
                                                   asks earns the room
```

A brief that does all three lands. A brief that does only the first sounds like marketing. A brief that does only the third sounds like a product manager with no engineering substance.

**The L5 framing across all twelve answers:** "I built it, I evaluated it where I could, I named the bets that aren't verified, and I retired what wasn't worth keeping. Here's the receipt for each."
