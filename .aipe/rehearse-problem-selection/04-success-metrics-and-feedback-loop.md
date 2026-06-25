# 04 — Success metrics and the feedback loop

The question "what does success look like" is where most problem
briefs cheat. They name a metric that *sounds* like product
success ("daily active users", "30s time-to-answer", "merchant
NPS") without naming who'll measure it, when, or what the
baseline is. This chapter doesn't do that.

The honest answer here is: **the success metrics for a contest
submission are not the same as the success metrics for a product**.
They overlap on one axis (does the demo actually work) and
diverge on every other. Naming the divergence is the whole point.

  ## The two-layer success frame

```
  TWO LAYERS OF SUCCESS — different metrics, different timelines

  ┌─ layer 1: hackathon success (the contest) ─────────────────┐
  │  measurable on submission day + judging day                 │
  │  feedback loop closes in <2 weeks                          │
  │  the rubric IS the metric set                              │
  └────────────────────────────────────────────────────────────┘

  ┌─ layer 2: portfolio success (the career artifact) ─────────┐
  │  measurable across interviews and PR conversations          │
  │  feedback loop closes over 6–18 months                     │
  │  the metric is "does this build come up in interviews,      │
  │  and when it does, does it strengthen the candidate's      │
  │  position?"                                                │
  └────────────────────────────────────────────────────────────┘
```

Notice what's NOT in either layer: **product-success metrics**
(active users, retention, paying customers, NPS). Those don't
apply because there's no product (chapter 02 non-goals). Naming
them as success metrics would be lying about what this build is.

  ## Layer 1 — hackathon success metrics

The rubric is the metric set. Five criteria, 20% each, judged
by panel.

```
  THE FIVE RUBRIC METRICS (blooming-insights-spec.md L51–L59)

  ┌─ M1  problem relevance & clarity              [20%] ───────┐
  │  observable: did the demo open with a clear "who is this   │
  │             for, what hurts" frame?                         │
  │  baseline:  no baseline; judge's read in the room          │
  │  our take:  cold open + one-liner (rehearse-hackathon-     │
  │             demo/01) are designed against this exact crit  │
  └────────────────────────────────────────────────────────────┘

  ┌─ M2  MCP utilization & depth                  [20%] ───────┐
  │  observable: tool calls visible in the trace · multiple    │
  │             tool types used · agents pick tools strategic. │
  │  baseline:  most submissions wrap 1–3 tools                │
  │  our take:  4 agents × 8–15 tools each · full trace        │
  │             visible (study-ai-engineering 00-overview L48) │
  └────────────────────────────────────────────────────────────┘

  ┌─ M3  agent behavior & intelligence            [20%] ───────┐
  │  observable: multiple agents coordinated · understand →    │
  │             decide → recommend flow legible                │
  │  baseline:  most submissions are single-agent              │
  │  our take:  4-agent orchestration on shared runAgentLoop   │
  │             (audit.md system-map) · the pattern judged for │
  └────────────────────────────────────────────────────────────┘

  ┌─ M4  execution quality & feasibility          [20%] ───────┐
  │  observable: demo doesn't break · real auth · real MCP ·   │
  │             tests · clean code                             │
  │  baseline:  most submissions break or fall back to fakes   │
  │  our take:  demo mode default (creds-free, instant) +      │
  │             live mode for real-data Q&A · 169 vitest tests │
  └────────────────────────────────────────────────────────────┘

  ┌─ M5  innovation & differentiation             [20%] ───────┐
  │  observable: an angle the named competitors don't have     │
  │  baseline:  conjura/graas/owly = black-box analyst tools   │
  │  our take:  reasoning trace as a first-class UI surface    │
  │             (study-ai-engineering 00-overview L52) — the   │
  │             whole architectural differentiator             │
  └────────────────────────────────────────────────────────────┘
```

  ### The feedback loop for layer 1

```
  layer 1 feedback loop — closes in <2 weeks

   2026-06-02   submission deadline (4:00 pm pst)
                ─────────────────────────────────
                            │
                            ▼
   2026-06-03   judging period begins
                            │
                            ▼
   2026-06-04   demo day / closing ceremony
                ────────────────────────────
                            │
                            ▼
              [winner announcement / scoring feedback]
                            │
                            ▼
                FEEDBACK LOOP CLOSES — you know if it landed
```

The feedback loop is fast and definite. By June 4, 2026, you
know whether the contest dimension of the project succeeded. The
loop is *not* "did anyone use the product" — that loop doesn't
exist for this project (chapter 02 cut 5: no users).

  ### What "winning" means in layer 1

There are three honest tiers of layer-1 success. Name all three;
don't pretend only the top one counts.

```
  THE THREE TIERS OF LAYER-1 SUCCESS

  ┌─ tier 1: PLACE (top 3 in track) ──────────────────────────┐
  │  measurable: yes/no, public                                │
  │  signals:    judges agreed it scored against the rubric    │
  │  portfolio:  "placed in track 3 of the Loomi Connect       │
  │              hackathon" is a one-line resume bullet that   │
  │              survives indefinitely                         │
  └────────────────────────────────────────────────────────────┘

  ┌─ tier 2: SHIP (submitted, demo worked) ────────────────────┐
  │  measurable: yes/no, internal                              │
  │  signals:    you completed what you said you'd complete    │
  │  portfolio:  the build exists, the demo runs, the code     │
  │              is reviewable — that's a real artifact        │
  │              regardless of placement                       │
  └────────────────────────────────────────────────────────────┘

  ┌─ tier 3: LEARN (the architecture is internalized) ─────────┐
  │  measurable: by Rein's own judgement                       │
  │  signals:    you can defend the design (interview defense  │
  │              book) and you understand the patterns deeply  │
  │              (the 15 study books in .aipe/study-*)         │
  │  portfolio:  this is the part that compounds — every       │
  │              future AI project is faster because of it     │
  └────────────────────────────────────────────────────────────┘
```

**Tier 2 is the floor; tier 1 is the ceiling; tier 3 is the
compounding return.** A project that hits tier 2 and tier 3 but
misses tier 1 is still a win. A project that misses tier 2
(didn't ship, demo broken) is a loss regardless of the other
tiers. Don't mislabel which tier you hit.

  ## Layer 2 — portfolio success metrics

This is the longer-running game. The build sits in the portfolio
as an artifact, and success here is whether it actually *does
work* over interview conversations and reviews.

```
  THE FOUR PORTFOLIO METRICS

  ┌─ P1  interview talk-time                                 ──┐
  │  observable: in interviews where the candidate gets to     │
  │             pick a project to discuss, do they pick this   │
  │             one? for how long? does the conversation       │
  │             stay on it?                                     │
  │  baseline:  a portfolio project that never comes up has   │
  │             zero return; one that gets 10 minutes of an   │
  │             interview has high return                      │
  │  feedback:  per-interview observable                       │
  └────────────────────────────────────────────────────────────┘

  ┌─ P2  technical-defense survival                         ──┐
  │  observable: when an interviewer presses on architecture,  │
  │             does the candidate hold the answer? do the     │
  │             interview-defense book's chapter 5             │
  │             skeptical questions actually land in the room? │
  │  baseline:  the rehearse-interview-defense book exists     │
  │             specifically to instrument this — open the     │
  │             book between interviews, update what didn't    │
  │             land                                            │
  │  feedback:  per-interview observable                       │
  └────────────────────────────────────────────────────────────┘

  ┌─ P3  pivot-narrative anchor                             ──┐
  │  observable: in the "tell me about your transition into    │
  │             AI engineering" question, is blooming insights │
  │             one of the named projects? does it land as     │
  │             evidence of the pivot, or as window dressing?  │
  │  baseline:  pre-build, AdvntrCue was the only AI artifact; │
  │             post-build, there are two, on different shapes │
  │  feedback:  every interview where the pivot comes up       │
  └────────────────────────────────────────────────────────────┘

  ┌─ P4  derived-artifact return                            ──┐
  │  observable: the 15 study books + 4 rehearse books in     │
  │             .aipe/* are themselves portfolio artifacts     │
  │             (they exist because this codebase exists);     │
  │             a hiring panel that reads them learns about    │
  │             how the candidate thinks, separate from        │
  │             what she built                                 │
  │  baseline:  no other project in Rein's portfolio has this  │
  │             level of authored reflection                   │
  │  feedback:  longer-running; observable when reviewers      │
  │             cite the books in conversation                 │
  └────────────────────────────────────────────────────────────┘
```

  ### The feedback loop for layer 2

```
  layer 2 feedback loop — closes over 6–18 months

   each interview         ─►  did the project come up?     ─┐
   each portfolio review  ─►  did the reviewer engage?      │
   each pivot conversation─►  did the build land as evidence?│
                                                            │
                                       accumulate over time │
                                                            ▼
                                  the build is "succeeding" if
                                  it's named, discussed, defended
                                  in interviews; "failing" if it
                                  sits in the portfolio unmentioned

   honest open question:    measurable on Rein's side per-
                            interview; aggregation happens
                            in retrospect across the next
                            6–18 months of conversations
```

This is a *slower, fuzzier* feedback loop than layer 1. It's
also where most of the *real* return is. A bad rubric score with
a build that anchors the AI-pivot conversation across 30
interviews is a strong outcome. A top-3 hackathon placement with
a build that never comes up in interview is a weaker outcome.

  ## Layer 1.5 — the Phase 3 receipts (measured once, then retired)

A layer that didn't exist in the June 2026 brief, and one that's
stronger than the planned-discovery framing the chapter originally
ended on. **Between the hackathon and today, the eval suite that
chapter 02 named as a cut got built, ran, surfaced real bugs, and
was retired with the substrate it scored against.** That's a real
measurement layer, not a planned one.

```
  THE FOUR NUMBERS PHASE 3 ACTUALLY MEASURED

  ┌─ E1  detection precision/recall ───────────────────────────┐
  │  measured: the monitoring agent's anomaly detection         │
  │            against a labeled set of 30 cases                │
  │  result:   captured in the retired eval/ tree (see PR #8    │
  │            commit 62c24d7 for the deletion); summaries      │
  │            live in the retired Phase 3 artifact set         │
  └────────────────────────────────────────────────────────────┘

  ┌─ E2  diagnosis 5-criterion LLM-as-judge rubric ────────────┐
  │  measured: 30 runs scored against 5 criteria                │
  │  finding:  binary calibration — 29/30 scored 0 or 1, never  │
  │            the middle; the judge wasn't using the rubric    │
  │            it was given (a real bug in the harness, not the │
  │            agent)                                           │
  └────────────────────────────────────────────────────────────┘

  ┌─ E3  recommendation 3-criterion LLM-as-judge rubric ───────┐
  │  measured: recommendation quality on Olist e-commerce data │
  │  finding:  BRL cents-vs-Reais unit-narration bug caught at  │
  │            run 8 — the agent narrated R$131,965 as an AOV,  │
  │            which is implausible for any real merchant. The  │
  │            judge caught it on the rubric criterion          │
  │            "numerical plausibility"                         │
  └────────────────────────────────────────────────────────────┘

  ┌─ E4  regression capture-and-score ─────────────────────────┐
  │  measured: re-running the same anomalies after agent        │
  │            prompt changes                                    │
  │  finding:  conclusion instability at a 30% baseline — same  │
  │            anomaly, different diagnosis 30% of the time at  │
  │            the model temperature in use                     │
  └────────────────────────────────────────────────────────────┘
```

**Judge calibration:** 8/8 + 3/3 manual spot-check agreement
(human reviewer scored the same items the LLM-as-judge scored;
both agreed on every case in the calibration set). That's the
discipline that made the E2-E4 findings trustworthy enough to act
on.

**Why this layer is stronger than "planned discovery":** the
original chapter ended on D1-D4 — "discovery work that would be
required before product investment." Now, three of those four
discovery questions (D2 partly, D3 fully, D4 not) have been
*pre-validated by the Phase 3 flywheel*. The thing the eval
harness was supposed to demonstrate — that the project could
build, calibrate, and act on an evaluation pipeline — was
demonstrated. The receipts are in the git history.

**Why it was retired:** the substrate it scored against (Olist
e-commerce SQLite via the project-owned MCP subprocess) was
removed in PR #8 (commit 62c24d7), and the eval suite went with
it. The retire was deliberate: the Olist substrate was a Phase 2
build that turned out to be more weight than it was carrying;
when the substrate was cut, the artifacts that depended on it
were cut too. Round 2 of the suite — same patterns, scored against
the Synthetic adapter instead — is the named-but-not-current
investment.

  ## What is NOT a success metric here

The non-metrics list. These look like success metrics, but for
this project specifically they are not.

```
  NOT a success metric for blooming insights

  → "merchant DAU / WAU"
       no merchants are using this — chapter 02 cut 4
  → "30-second time-to-answer for users"
       quoted in the spec as a rubric-anchor phrase, but
       there are no users to measure on — chapter 01 evidence
  → "diagnosis accuracy %"
       no current eval harness — chapter 02 cut 2 (was built
       in Phase 3, retired with the Olist substrate; the
       Phase 3 finding was that binary calibration was the
       bug to fix before accuracy numbers meant anything)
  → "recommendation outcome lift"
       no recommendations have been applied — chapter 02
       cut 3 (no write actions)
  → "ARR / revenue"
       not a product — chapter 02 non-goals
  → "Net Promoter Score"
       no respondents possible — see above
  → "time saved per merchant per week"
       no merchant has used this for a week — see above
```

A reviewer who pushes on any of these (especially "but the spec
says 30-second time-to-answer is the metric") deserves the
honest answer: **the spec quotes that phrase as a rubric-anchor
narrative device, not as a measured outcome**. Saying so out loud
in the room is a strength signal, not a weakness. The dodge
("oh yes, our average time-to-answer is 28 seconds") fabricates
data and lasts about one follow-up question.

  ## The feedback-loop diagram

One picture showing both layers and where each metric reads.

```
                    BLOOMING INSIGHTS — FEEDBACK LOOPS

                   ┌───────────────────────────────┐
                   │  THE BUILD (the artifact)     │
                   └───────────────────────────────┘
                                  │
                                  │
              ┌───────────────────┴───────────────────┐
              │                                       │
              ▼                                       ▼
  ┌─ LAYER 1 (fast, closed) ──────┐     ┌─ LAYER 2 (slow, open) ─────────┐
  │                                │     │                                 │
  │  M1 problem clarity            │     │  P1 interview talk-time         │
  │  M2 MCP depth                  │     │  P2 defense survival            │
  │  M3 agent behavior             │     │  P3 pivot-narrative anchor      │
  │  M4 execution quality          │     │  P4 derived-artifact return     │
  │  M5 innovation                 │     │                                 │
  │                                │     │                                 │
  │  feedback: jun 4, 2026         │     │  feedback: per interview,        │
  │  (judging day)                 │     │  aggregated 6–18 months           │
  │                                │     │                                 │
  │  closes: <2 weeks              │     │  closes: ongoing                │
  └────────────────────────────────┘     └─────────────────────────────────┘
                                  │
                                  │  what is NOT in either loop:
                                  ▼
              ┌───────────────────────────────────────────────────┐
              │  NOT measured: merchant DAU, accuracy %, ARR,     │
              │  NPS, time-saved-per-week, recommendation lift    │
              │                                                   │
              │  (these would require a product; this is not a    │
              │  product — chapter 02 non-goals)                  │
              └───────────────────────────────────────────────────┘
```

Two loops, both legitimate. The trap is treating layer 1 as the
whole story (rubric obsessed; ignores the artifact's longer-
running value) or treating layer 2 as the whole story (vague
"portfolio value" with no near-term measurable). Both layers run
simultaneously.

  ## The discovery questions (the third layer that would exist
  ## if this became a product)

Honest framing for the reviewer who asks "okay, what would have
to be true for this to become a product?" — the third layer of
metrics doesn't exist yet, but the *discovery questions* that
would lead to it can be named.

```
  IF THIS BECAME A PRODUCT — the discovery work that would
  be required before any new investment

  D1  talk to 10–15 merch leads on Bloomreach (or similar
      ecommerce platforms with workspace-shaped data)
      → asked specifically: "show me how you currently
        answer 'what changed last week and why'"
      → measured: stopwatch on the current workflow

  D2  run blooming insights on 3–5 real workspaces with the
      operators present, after their current-workflow stopwatch
      → measured: stopwatch on the agent's workflow
      → measured: "do you agree with this anomaly being important"
      → measured: "would you act on this recommendation"

  D3  build a labeled eval set: 50–200 anomalies the team
      independently agreed on (importance + suggested action)
      → measured: agent's match rate vs the labeled set
      → measured: false-positive rate on "found an anomaly
        that wasn't real"
      → **PARTIAL CREDIT FROM PHASE 3.** The eval harness was
        built once (4-pillar suite, LLM-as-judge calibrated
        8/8 + 3/3, ran 30 cases), exposed 3 real bugs in the
        agent and judge, then was retired with the Olist
        substrate. Round 2 against the Synthetic adapter is
        ~5 hours of work because the patterns are now known.
        The discovery question isn't "can we build this" —
        it's "is the round-2 investment worth making before
        merchant-side validation in D1/D2."

  D4  if D1–D3 land positive, attempt a 4-week pilot with
      1–2 design partners
      → measured: did the partners renew interest at week 4?

  none of D1–D4 exist today. naming them is honest;
  pretending we measured them is fabrication.
```

A reviewer who asks "would you do this work to validate the
product?" should hear "yes, that's the work — none of it is in
the repo today because the repo is a hackathon submission, not
a product." That's the answer that holds.

  ## What this chapter establishes

```
  → two-and-a-half real success layers exist for this build:
      layer 1 (contest), layer 1.5 (Phase 3 receipts —
      measured then retired), and layer 2 (portfolio)
  → seven typical "product success" metrics are explicitly
    OFF the list for this project, with reasons
  → the Phase 3 receipts give the brief a "we measured this
    once, here's what we learned, here's why we retired it"
    posture stronger than the original "we plan to measure"
  → the discovery questions that WOULD make product-success
    metrics meaningful are named; D3 specifically now carries
    partial credit from the retired Phase 3 work
  → the feedback-loop diagram is one picture both layers
    share — open it when you're tempted to overclaim
```

Chapter 05 is the pressure test. Seven skeptical-reviewer
questions and the answers that hold under each one.

Read chapter 05 next.

---
