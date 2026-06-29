# 04 — Success Metrics and Feedback Loop

> How we'd know it worked. What the observable outcomes are. What the feedback loop looks like — and what we have today vs what we don't.

```
  THE METRICS LADDER — five rungs, current state per rung

  ┌─ rung 5: business outcome ─────────────────────────────┐
  │  did the analyst's stakeholder buy the recommendation? │  NOT MEASURED
  └────────────────────────────────────────────────────────┘
  ┌─ rung 4: behavior change ──────────────────────────────┐
  │  does the analyst use this vs the manual loop?         │  NOT MEASURED
  └────────────────────────────────────────────────────────┘
  ┌─ rung 3: trust surface ────────────────────────────────┐
  │  does "show your work" actually beat "magic answer"?   │  NOT MEASURED
  └────────────────────────────────────────────────────────┘
  ┌─ rung 2: quality of the loop ──────────────────────────┐
  │  detection precision/recall · diagnosis · recommend·   │  MEASURED ONCE,
  │  regression stability                                  │  SUITE RETIRED
  └────────────────────────────────────────────────────────┘
  ┌─ rung 1: liveness ─────────────────────────────────────┐
  │  does the loop terminate? does the UI render?          │  MEASURED
  └────────────────────────────────────────────────────────┘

  the strongest metrics live on rungs that aren't built yet.
  honest receipt: rung 1 today; rung 2 has a receipt + a rebuild gate.
```

## The metrics discipline

Two failure modes a problem brief usually has on success metrics:

1. **Hand-wave aspirational metrics** ("we'll measure user satisfaction") that nobody knows how to instrument.
2. **Vanity metrics** (page views, agent invocations) that move regardless of whether the product is actually working.

The move that beats both: **name the metrics you have today + the metrics you'd build next + the receipt that you've done it before.** Receipts beat promises, especially in a review where the reviewer has heard a hundred "we plan to measure" answers.

---

## Rung 1 — Liveness (we measure this today)

**What it measures:** does the system work end-to-end without crashing? Does the agent loop terminate? Does the UI render the stream? Does an auth recovery succeed?

**How we measure it:**
- **Test suite** — 24 files / 221 passing tests via Vitest. Pure logic + agent loops TDD'd with injected fakes — no network. Covers the agent loop termination, the NDJSON event protocol, the demo snapshot replay, the OAuth recovery paths.
- **Demo path as a smoke test.** `?demo=cached` serves a committed snapshot (`lib/state/demo-insights.json`, `lib/state/demo-investigations.json`). If the demo renders end-to-end, the entire UI surface and the streaming consumer are working.
- **Live path as a live test.** Every live run against the alpha MCP server is a test of auth recovery, rate-limit handling, token revocation handling.

**What it does NOT tell us:** whether the agent's conclusions are any good. A perfectly liveness-clean run can produce a wrong answer with full confidence.

**The honest read on rung 1:** we have it. It's necessary, not sufficient. **Anyone who claims liveness is a product success metric is being sold to.**

---

## Rung 2 — Quality of the loop (measured once, suite retired, rebuild target named)

**What it measures:** the agent loop's output quality, per pillar.

### The 4-pillar suite (the receipt)

When the system ran against the public ecommerce data substrate that proved the seam, a 4-pillar eval suite was built and run:

1. **Detection precision/recall** — K=10 runs per anomaly. Did the monitoring agent surface the anomaly that was actually there? Did it surface noise?
2. **Diagnosis 5-criterion rubric pass rate** — for each diagnostic agent run, was the conclusion supported, was the evidence cited, did it size the affected segment, did it test hypotheses, was the reasoning structured?
3. **Recommendation 3-criterion rubric pass rate** — was the Bloomreach feature appropriate, were the steps actionable, was the expected-impact statement grounded?
4. **Regression capture-and-score** — structural diff + LLM similarity judge on prior runs. Did changing the prompt break a previously-working case?

**The calibration discipline:** the LLM-as-judge was spot-checked against manual review — **8/8 agreement on the diagnosis rubric and 3/3 on the recommendation rubric.** Without that calibration, the judge's scores are unverified — running an eval against an uncalibrated judge produces numbers that look like signal and aren't.

### What the suite surfaced (3 named bugs)

1. **BRL units (cents vs Reais).** The judge flagged an implausible average order value of R$131,965 at run 8 — the agent was treating BRL cents as whole Reais. A unit test wouldn't have caught this; the eval did because it ran the full loop and reasoned about plausibility.
2. **Binary calibration drift.** A criterion that should have been graded 0/1 was drifting to 29/30 (too lenient). Caught by re-running the calibration spot-check.
3. **Conclusion instability.** A 30% regression baseline across K=10 runs on the same anomaly. Invisible from any single run; only visible because we ran K and computed the variance.

### Why the suite was retired

The suite was specific to the data substrate it ran against. **When that substrate was retired** (the decision to swap to an in-process Synthetic adapter as a cleaner data shape), the eval went with it. **That was a deliberate call, not an oversight.** The rebuild target is named: **the next version of the eval runs against the Synthetic adapter**, where the substrate is deterministic, the anomaly seeds are stable, and the eval doesn't decay with the data.

### Why this is a stronger story than "we have an eval running on every commit"

A reviewer can take three readings off this:

- **End-to-end execution receipt** — you built it, ran it, calibrated it. Not a TODO, not a Confluence page.
- **It found real bugs no unit test would catch.** Three of them, named, specific. The eval **earned its place by surfacing things.**
- **You retired it deliberately and named the rebuild gate.** That's an `evaluated-and-accepted` move on the eval itself — the receipt of having done the work once is stronger than promising to do it.

**The L5 framing for this rung:** "shipped, calibrated 8/8 + 3/3, surfaced 3 named bugs, made the call to retire with the substrate, next version against the Synthetic adapter." Receipts not promises.

---

## Rung 3 — Trust surface (the load-bearing metric, not yet measured)

**What it measures:** does "show your work" actually beat "magic answer" for the analyst persona? This is the central product bet — the metric that, if it goes the wrong way, tells us the whole reasoning-trace surface was over-built.

**How we'd measure it:**
- **A/B the same recommendation with and without the trace visible.** Two cohorts. Same insight, same diagnosis, same recommendation card. Cohort A sees the reasoning trace in the sidebar; Cohort B sees a collapsed "see how I got this" link. **Measure: which cohort forwards the recommendation to their stakeholder more often?**
- **Forward-rate as the proxy.** Forwarding is the closest in-product behavior to "I trust this enough to defend it." The markdown export (`lib/export/investigationMarkdown.ts`) is the instrumentation point — when an analyst exports, they're committing to a downstream conversation.

**What we have today:** the surface is built. The instrumentation point is built. The A/B framework is not. **The metric is gated on having enough users to run the A/B.**

**The honest read on rung 3:** this is the most important metric in the entire ladder — and we have no data on it. Calling that out is the move. A brief that claimed we'd validated the trust bet would be lying.

---

## Rung 4 — Behavior change (not yet measured)

**What it measures:** does the analyst actually use this product, vs going back to their manual three-context loop? **The product fails if it sits on the shelf, regardless of liveness or quality.**

**How we'd measure it:**
- **Weekly active analysts running ≥3 investigations.** Three is the threshold because one is a sample, two is a try, three is "this is in my workflow."
- **Investigation depth.** Does the analyst go all the way through (monitoring → diagnose → recommend → export), or do they drop off at the diagnose step? **Drop-off at recommend is a signal that the recommendation step isn't earning its place.**
- **Re-use of the same investigation.** Does the analyst come back to it (which, given Cut 1 — no persistence — is currently bounded by the session)?

**What we have today:** none of this. Building it is gated on having real users to instrument. **The instrumentation is straightforward (it's all in-process state); the gate is having the users.**

---

## Rung 5 — Business outcome (the metric we never directly measure)

**What it measures:** did the analyst's recommendation, executed in Bloomreach, actually move the metric it was meant to move?

**How we'd measure it:**
- The honest answer is: **we don't, directly.** The product is read-only (Cut 3). The analyst takes the recommendation to Bloomreach, configures it themselves, the campaign runs, the metric moves or doesn't.
- The closest proxy we could build: a post-execution prompt — "did this recommendation help? did revenue move?" — that the analyst fills in a week later. Subject to massive selection bias and small-sample noise.

**Why we don't pretend to measure this:** rung 5 is what the customer cares about and what the product genuinely contributes to — but **measuring it would require the write-back integration we deliberately cut.** A brief that claimed rung 5 as a metric would be promising something the architecture doesn't support.

**The honest framing for rung 5:** it's the goal, not the metric. The metric is rung 3 — does the analyst trust the recommendation enough to take it to Bloomreach in the first place. Rung 5 is downstream of rung 3.

---

## The feedback loop — how metrics turn into product changes

```
  THE LOOP — what produces signal, what consumes it

  ┌─ run (live or eval) ──────┐
  │  agent loop executes      │
  │  trace + tool calls       │
  │  + numbers + conclusion   │
  └──────────────┬────────────┘
                 │
  ┌─ capture ────▼────────────┐
  │  snapshot to demo-*.json  │  ← committed
  │  raw tool calls cached    │  ← rate-limit / token-revoke recovery
  └──────────────┬────────────┘
                 │
  ┌─ review ─────▼────────────┐
  │  manual eyeball today     │  ← rung 1 + spot-checks on rung 2
  │  (the suite ran here once)│
  └──────────────┬────────────┘
                 │
  ┌─ change ─────▼────────────┐
  │  prompt edit · adapter    │
  │  swap · UI tweak          │
  └──────────────┬────────────┘
                 │
                 └──► back to run

  The shortest loop: live run → trace → notice something off → edit prompt → re-run.
  The longest loop (when the eval was alive): live run → seed eval anomaly → K=10 → judge → regression diff → prompt edit.
```

**What we have today on this loop:** the run, the capture, and the change steps are fast and real. The review step is **manual eyeball** — the same as it was before the eval suite shipped. The committed demo snapshot is the closest thing to a regression check: if the demo renders differently after a prompt edit, you notice.

**What we don't have today:** the automated review step. The eval suite did this until it was retired with the substrate. Rebuilding it against the Synthetic adapter is the next deliberate move when the substrate is stable.

---

## The discovery questions on metrics (honest gaps)

The repo cannot answer these — and the brief loses credibility if it pretends otherwise:

1. **What's the right baseline for "the analyst's current loop"?** We don't know how long the manual three-context loop currently takes a Bloomreach analyst, or how often they decline to investigate at all because the friction is too high. Discovery move: time 5 analysts running the loop by hand before we A/B anything.
2. **What's the threshold for "show your work beats magic"?** Is 60% forward-rate good? 80%? We don't have a benchmark.
3. **What's the analyst's tolerance for agent error?** If 1 in 10 recommendations is wrong, do they keep using it (because the other 9 saved them time) or stop (because the wrong one undermined their trust)? This shapes how aggressive the agent should be about confidence.

A brief that names these gaps — and ranks them by which one would change product strategy if answered — is a brief that earns its review.

---

## The sharp answer on metrics

If a reviewer asks "how do you know any of this is good" — **"Today, by eyeballing the trace, the same way it was before the eval suite shipped. But I built the eval harness once, calibrated it 8/8 + 3/3 against manual review, surfaced 3 named bugs no unit test would catch (BRL units, binary calibration, conclusion instability), retired it deliberately with the substrate it ran against, and named the rebuild gate (against the in-process Synthetic adapter, when that's stable). The receipt of having done the work once is stronger than promising to do it."**

The rest of the ladder — rungs 3, 4, 5 — is genuinely not built yet, and the brief is honest about which rung is gated on which thing. **A brief that overclaimed those rungs would lose the room. A brief that names the gates earns the next conversation.**
