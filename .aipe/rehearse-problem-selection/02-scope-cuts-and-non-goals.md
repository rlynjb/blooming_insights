# Scope cuts and non-goals

**Cuts you can defend.** The point of this file isn't a list of what's missing — it's the receipts that show you cut deliberately, why the cut held, and (this is the L5 signal) **which cuts you reconsidered and un-cut**.

The interviewer's actual question is: *"did you have judgment about what NOT to build, and can you defend the calls?"* Everything below answers that.

## The shape

```
  Cuts fall into two piles

  ┌─ STILL IN PLACE ──────────────────────────┐
  │  cuts that held through 4 weeks of        │
  │  portfolio hardening                       │
  │                                            │
  │  · no database                             │
  │  · no LLM supervisor                       │
  │  · no Server Components / Suspense        │
  │  · legacy files preserved (not deleted)   │
  └────────────────────────────────────────────┘

  ┌─ RECONSIDERED AND UN-CUT ─────────────────┐  ← the L5 receipt
  │  cuts that were the right call at v1       │
  │  and became the wrong call for portfolio  │
  │                                            │
  │  · eval suite (SHIPPED — the centerpiece) │
  │  · cost controls (SHIPPED — cache + budget)│
  │  · fault tolerance (SHIPPED — decorator)  │
  └────────────────────────────────────────────┘

  ┌─ KEPT ────────────────────────────────────┐
  │  cuts that stayed cut on purpose           │
  │                                            │
  │  · full external observability             │
  │  · routing monitoring→Haiku                │
  └────────────────────────────────────────────┘
```

Walk each pile in order.

## Pile 1 — cuts still in place

These are the cuts that held. Each one has a specific "what breaks if you re-add it" answer, which is why they held.

### No database — session-keyed in-memory Map

**The cut.** State lives in `lib/state/insights.ts` and `lib/state/investigations.ts` as `Map` instances keyed by session. Wipes on restart. In dev, mirrors to gitignored JSON files (`.auth-cache.json`, `.investigation-cache.json`); in production, wipes are RESOLVED — no attempt to persist.

**Why it held.** The product is single-tenant, single-user-at-a-time, session-scoped. Adding Postgres/Supabase/Prisma buys:
- multi-user history (not in scope — see Ch 01 outside-scope list)
- multi-session persistence (not in scope — sessions are short-lived, demo mode replays committed snapshots for the reliable path)
- team collaboration (not in scope)

None of those are goals. The DB would carry weight it doesn't need to carry.

**What re-adding it would cost.** ORM choice, migration file discipline, connection pooling in a serverless env (Vercel), auth-per-user (currently the OAuth is per-machine, per-session), a whole new class of bugs (leaked connections, migration drift), and — most damning — it would make the `live-synthetic` / `demo` mode gradient harder, because the committed `demo` snapshot would have to sync to the DB rather than being read as plain JSON.

**The receipt.** Committed demo snapshots at `lib/state/demo-insights.json`, `lib/state/demo-investigations.json`. Zero DB code in the repo. The 261-test suite runs without any DB fixture.

### No LLM supervisor — deterministic route code

**The cut.** There's no meta-agent deciding "should this be diagnosed or recommended?" The `app/api/agent/route.ts` handler reads `step=diagnose|recommend|null` from the request and dispatches to `DiagnosticAgent` or `RecommendationAgent` in code. The step decision is UI-driven (the user clicks "see recommendations →" on the diagnose page).

**Why it held.** A supervisor LLM would add a full extra Claude call per request — cost, latency, and a new failure surface — for a decision that's already made by the URL. `/investigate/[id]` = diagnose. `/investigate/[id]/recommend` = recommend. The router is the router.

**What re-adding it would cost.** ~$0.02 and ~2s of latency per request for a decision the URL already carries. Plus a new failure mode: the supervisor picks wrong, and now the user asked for a recommendation and got a diagnosis, with no clean recovery path.

**The receipt.** `app/api/agent/route.ts` has no Claude call at the top level — it inspects `step` and dispatches. `lib/agents/base.ts`'s `runAgentLoop` is the *inner* Claude loop for a single agent; there is no *outer* one.

### No React Server Components / Suspense / React Query

**The cut.** The client hook `lib/hooks/useInvestigation.ts` uses `fetch` + a stream reader, `sessionStorage` for hydration, and plain `useState`/`useEffect`. No RSC. No `Suspense` boundary managing the stream. No React Query cache.

**Why it held.** The primary UI surface — the streamed reasoning trace — is *inherently* stateful, client-side, and has to render every event as it arrives. RSC + Suspense is designed for the opposite shape: render on the server, hydrate once, done. React Query's model is stale-while-revalidate for finite requests, which doesn't match a 5-minute NDJSON stream.

**What re-adding it would cost.** RSC would move the stream reader out of the component tree it's controlling; you'd end up passing stream events through props/context anyway, which is what the direct `useState` already does. React Query would need a custom hook to bridge streaming into its cache model — you'd rebuild `useInvestigation.ts` on top of RQ and get the same behavior with more indirection.

**The receipt.** `lib/hooks/useInvestigation.ts` runs a `fetch` + stream reader, survives StrictMode by *not* cancelling in-flight fetches on cleanup (crucial for the double-mount pattern), and stashes results in `sessionStorage` for cross-page hydration. Roughly 100 lines of code doing what would otherwise need a wrapping library.

### Legacy files preserved (not deleted)

**The cut — this one is inverted.** After the aptkit migration you kept `*-legacy.ts` files in the repo instead of deleting them. Legacy = the pre-aptkit own-loop implementation.

**Why it held.** The migration to `@aptkit/core@0.3.0` is defensible with a rollback receipt. Deleting legacy = "trust me, the migration worked." Keeping legacy = "here's the exact code the migration replaced; you can compare, rollback, or audit."

**What re-adding it would cost — inverted, so: what deleting it would cost.** The strongest interview move is *showing* the before and after. `git log --follow` on a deleted file is worse than the file sitting next to its replacement. Also: if aptkit ships a breaking change or a regression, the legacy path is a warm rollback, not a git-archaeology exercise.

**The receipt.** Grep for `-legacy.ts` in the repo. Files present. Tests still passing on both.

## Pile 2 — reconsidered and un-cut (the L5 receipt)

This is the pile the review room actually cares about. Anyone can cut features. Not everyone comes *back* to cuts, evaluates whether they still hold, and un-cuts the ones that don't.

### Eval suite — was cut, now SHIPPED end-to-end

**Original cut.** Hackathon scope. v1 was "prove the loop works, get it demoable." An eval suite is a 1–2 week investment on top of a working demo; it's a hardening move, not a shipping move. Cut for v1.

**Why the cut was correct at v1.** You had no baseline to evaluate against. You didn't know which of the 4 diagnosis criteria mattered. You didn't have golden cases because you didn't know what "good" looked like. Building an eval before you have those things is expensive theater.

**Why the cut became wrong for portfolio.** The portfolio bar isn't "does it work" — it's "how do you know it works." A demo without an eval is vibes-based. The interviewer's follow-up is *always* "and how do you know the recommendations are actually good?" The demo can't answer that; the eval can.

**What un-cutting it looked like.** Full receipt in the shipped repo:
- **10 goldens.** Real cases with expected diagnostic and recommendation shape.
- **2 rubrics × 4 dims × 5-scale × 3 verdicts.** Diagnosis rubric (root_cause_plausibility, evidence_grounding, scope_coherence, actionable_next_step). Recommendation rubric (diagnosis_response, feature_choice_fit, step_actionability, impact_realism). 1–5 scale. Pass / pass_with_notes / fail verdicts.
- **Blind calibration protocol.** Session D pilot ran AI-vs-AI as a mechanic-proving exercise (the receipt file stamps `pilotWarning` explicitly — you know it's not real calibration). Session D pilot numbers: verdict agreement 6/6, exact-match 13/24, within-1 24/24.
- **Regression gate.** `eval/baseline.json` committed. `eval:gate` script compares fresh runs to baseline. **CI blocks the PR on regression.**
- **CI-integrated flywheel.** `npm run eval` → produces receipts → `npm run eval:report` aggregates → `npm run eval:gate` compares to baseline → CI wires it up.

**What it took to un-cut it responsibly.** Week 1–2 of the portfolio hardening plan. Every claim receipt-backed. Baseline committed. Nothing hand-waved.

**The interview line.** *"Eval was originally out of scope. Then I looked at what a portfolio needs to defend — and 'how do you know it's good' has to have a real answer. So I built the eval end-to-end, committed the baseline, and wired the gate to CI. Now every claim I make about the agents' quality has a receipt."*

### Cost controls — were deferred, now SHIPPED

**Original cut.** Deferred to Phase 3 of the hardening plan. v1 sent every request to Sonnet 4.6 with no prompt caching, no budget tracker, no per-request cost signal.

**Why the cut was correct at v1.** Cost engineering before you have measured latency and cost is optimizing without a target. The rational order: measure first, then optimize. Cost controls sit downstream of the eval — you need the eval to measure the cost before you optimize it.

**Why the cut became wrong.** The eval established a per-case cost of ~$0.09 agent-side and ~$1.30 for a 10-case run. That's a real number worth reducing. The uncached long system prompt (the tool schemas + agent prompts) was clearly re-processed on every call. That's leaving money on the table.

**What un-cutting it looked like — three shipped moves:**

- **Prompt caching validated live in logs.** The Anthropic SDK's `cache_control` markers on the long system prompt segments. Logs show `cache_creation_input_tokens` on the first call, then `cache_read_input_tokens: 3168` on subsequent calls. That's the receipt: caching isn't configured-in-theory, it's hitting-in-practice.
- **Anthropic pricing helper.** aptkit's built-in cost helpers are OpenAI-only. You wrote the Anthropic pricing helper to fill the gap. The helper reads the token counts (including cache-hit tokens at their reduced rate) and computes cost.
- **BudgetTracker with check-before-dispatch.** The tracker has a budget ceiling and a check-before-dispatch gate: if the projected cost of the next call would exceed budget, the call is blocked, not run-then-audited. Fail closed, not open.

**The interview line.** *"I deferred cost controls until the eval could measure cost. Once it did, I shipped three things: prompt caching (validated in logs — cache_read hitting 3168 tokens), an Anthropic pricing helper to fill aptkit's OpenAI-only gap, and a BudgetTracker that checks before dispatch. Fail closed."*

### Fault tolerance — was aspirational, now receipt-backed

**Original cut.** v1's answer to fault tolerance was "there is no fault tolerance." If the MCP call fails, the agent loop fails. If the Anthropic API times out, the request fails. No injection, no drills, no evidence of recovery behavior.

**Why the cut was correct at v1.** You can't build fault tolerance you haven't observed the *need* for. Injecting faults without the shape of the system settled is premature — the injection surface would move as the code moved.

**Why the cut became wrong.** The DataSource seam pattern (the port/adapter boundary at `lib/mcp/tools.ts`) matured. Once you had a stable seam, you had a stable place to *inject* failure. That unlocked the fault-tolerance work.

**What un-cutting it looked like — receipt-backed:**

- **FaultInjectingDataSource decorator.** Wraps a real DataSource and injects failures at the port boundary. Fourth shipped use of the DataSource seam (after Olist add, Olist remove, Synthetic add). Zero caller-surface changes — the agents don't know they're talking to an injected-failure adapter vs a real one.
- **9 injected faults across 3 investigations.** Timeouts, malformed responses, transient errors.
- **0 failed.** Every injection was recovered by the loop's existing retry + rate-limit logic in `lib/mcp/client.ts`.

**The interview line.** *"Fault tolerance was aspirational at v1. Once the DataSource seam matured, I added a FaultInjectingDataSource decorator — the fourth shipped use of that seam. 9 faults injected across 3 investigations, 0 failed. That's a real drill, not a claim."*

## Pile 3 — kept cut on purpose

Not everything reconsidered gets un-cut. These are the cuts that stayed cut on purpose, with the rationale that holds.

### Full external observability (Langfuse / Datadog / etc.)

**The cut.** Phase 2 of the hardening plan shipped in-repo observability scripts, not a hosted observability platform.

**Why it held.** The in-repo scripts give you per-run receipts written to disk, aggregated by `eval:report`, and compared by `eval:gate`. That's the same feedback loop a hosted platform gives you, without the SaaS integration, the sampling questions, the data-residency concerns, or the monthly cost. For a single-user portfolio product, hosted observability is the wrong shape.

**Trigger for revisit.** Multi-user deployment. If this ever runs against multiple workspaces or multiple users, a hosted platform's aggregation across sessions becomes worth the integration cost. Not before.

### Routing monitoring→Haiku

**The cut.** The intent classifier (`lib/agents/intent.ts`) uses Haiku 4.5. The three main agents (monitoring, diagnostic, recommendation) all use Sonnet 4.6. There's an obvious *shape* to routing the monitoring agent to Haiku — it's the simplest of the three tasks — but the routing didn't ship.

**Why it held — evidence-driven defer.** The eval skips the monitoring agent entirely and feeds golden anomalies straight to the diagnostic agent. That means you have **no cost signal on monitoring**. Routing monitoring to Haiku blind is the exact anti-pattern the eval flywheel exists to prevent: a change you can't measure.

**Trigger for revisit.** One real briefing measurement. Once the eval covers a monitoring case with real cost and quality numbers, the Haiku-vs-Sonnet decision has evidence to sit on.

**The interview line.** *"Routing monitoring to Haiku is deferred with evidence. The eval doesn't cover monitoring yet, so I have no cost signal on it. Routing blind is the anti-pattern the eval exists to prevent. Trigger for revisit is one real monitoring measurement."*

## The pattern across all three piles

The cuts you defend are the ones with a specific *why-not-yet* and a specific *what-would-change-it*. Vague cuts ("we didn't have time") don't survive contact with an interviewer. Cuts with triggers survive because the interviewer can see you thinking about the *conditions* under which the cut would flip, not just the fact of the cut.

Every cut in this file has both.
