# Problem Selection — Overview

> Why this problem deserves investment, before any solution design.

```
  THE BRIEF — five questions in dependency order

  ┌─ 1. PROBLEM ────────────────────────────────────────┐
  │  who experiences what pain, with what evidence?     │
  └─────────────────────┬───────────────────────────────┘
                        │  if no real pain — STOP
  ┌─ 2. SCOPE ──────────▼───────────────────────────────┐
  │  the narrowest slice that proves the premise        │
  └─────────────────────┬───────────────────────────────┘
                        │  if scope can't be cut — STOP
  ┌─ 3. OPTIONS ────────▼───────────────────────────────┐
  │  including `do nothing` — what's the opportunity    │
  │  cost of building this vs not?                      │
  └─────────────────────┬───────────────────────────────┘
                        │  if `do nothing` wins — STOP
  ┌─ 4. METRICS ────────▼───────────────────────────────┐
  │  how do we know it worked? what's the feedback loop?│
  └─────────────────────┬───────────────────────────────┘
                        │
  ┌─ 5. SKEPTIC ────────▼───────────────────────────────┐
  │  the review-room questions that the brief survives  │
  └─────────────────────────────────────────────────────┘
```

## The thirty-second pitch

The job-to-be-done — a marketer on Bloomreach Engagement currently runs the human-analyst loop by hand: notice a metric moved, hunt for the cause, decide which Bloomreach feature to reach for. Three jobs, three contexts, no continuity between them. **blooming insights** runs that loop end-to-end and **streams the reasoning as a first-class surface** — "an analyst that shows its work."

The differentiator is not "AI for analytics" (commodity). It's the **show-your-work** seam: every conclusion carries the exact tool call, the current-vs-prior numbers, and a streamed log of the agent's thinking, visible in a sticky sidebar (`StatusLog`) on every page. That's the bet — that trust beats magic for an analyst persona who has to explain the decision to their boss.

## Why a problem-selection brief, not a feature spec

The audit family already covers HOW the system is built. This brief defends WHY this problem deserves attention before anyone writes another line of agent code. Three things it has to do that a feature spec doesn't:

1. **Name the pain in the analyst's words, with repo evidence, not market vibes.** The repo proves the workflow (the three-stage stepper, the diagnose-then-recommend split, the EQL-only data path); the brief makes that evidence explicit.
2. **Defend the scope cuts.** No persisted dashboards. No save/share. No multi-tenant. No write-back to Bloomreach. Each cut is a deliberate "not this version." A reviewer who doesn't see the cuts named will assume they were forgotten.
3. **Include `do nothing` as a real option.** The brief loses credibility the moment `do nothing` isn't on the table — because in a real product review, it always is.

## What the brief is grounded in

Repo-visible evidence only. Where this brief talks about user pain, it points at the repo artifact that proves the workflow exists (the three-stage stepper, the dual-agent split, the EQL ad-hoc-only data model). Where it talks about constraints, it points at the code that enforces them (~1 req/s rate limit in `lib/mcp/client.ts`; token revocation handling in `lib/mcp/auth.ts`; in-memory state, no database). Where it makes a claim that the repo cannot prove, the brief labels it as **inference** or as a **discovery question** that must be answered before scaling investment.

## What this brief is NOT

- Not a market sizing exercise — the repo doesn't have the data to ground that, and pretending it does is the fastest way to lose a senior reviewer's trust.
- Not a feature roadmap — the cuts are as important as the inclusions.
- Not a defense of the implementation — that's what `rehearse-interview-defense` is for. This brief defends the **decision to invest at all.**

## Reading order

```
  00-overview.md                          ← you are here
  01-problem-brief.md                     pain + evidence + why now + beneficiaries
  02-scope-cuts-and-non-goals.md          what NOT to build (and why)
  03-options-and-opportunity-cost.md      do nothing · narrow · broad · what each costs
  04-success-metrics-and-feedback-loop.md observable outcomes + how we'd know
  05-skeptical-reviewer-questions.md      the review-room questions the brief survives
```

## The single sharpest defense

If you can only carry one sentence into the review room: **"The differentiator isn't the agent — it's the reasoning trace, and the repo proves I built the trace as a first-class surface, not as an afterthought log."** Everything in this brief radiates from that claim.
