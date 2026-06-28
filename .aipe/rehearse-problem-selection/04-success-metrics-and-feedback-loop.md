# 04 — Success metrics and feedback loop

**Industry name:** Success metrics / outcome measurement / eval portfolio — Coach posture

The chapter that proves you don't just *ship* — you *measure*. Coach voice: real numbers from Phase 3 first, then the honest current state, then the named rebuild target.

This chapter is where the receipts from Cut 2 (the eval pipeline) actually live.

---

## Zoom out — what "success" means for this product

```
  Three layers of success — each measurable

  ┌─ Layer 1: agent quality ─────────────────────────────┐
  │  does the agent produce good monitoring / diagnosis  │
  │  / recommendation output?                            │
  │  → measured by the Phase 3 eval suite (4 pillars)   │
  └─────────────────────────┬────────────────────────────┘
                            │
                            ▼
  ┌─ Layer 2: product responsiveness ────────────────────┐
  │  does the UI stream reasoning fast enough to feel    │
  │  alive? does it survive token revocation?            │
  │  → measured by demo-mode reliability + auto-reconnect│
  │     behavior in live mode                            │
  └─────────────────────────┬────────────────────────────┘
                            │
                            ▼
  ┌─ Layer 3: workflow validation ───────────────────────┐
  │  does an analyst actually save time using this?      │
  │  → NOT MEASURED. requires user research.            │
  │     listed as a discovery question, not a metric.   │
  └──────────────────────────────────────────────────────┘
```

I have real numbers on Layer 1 (Phase 3, retired). I have functional evidence on Layer 2 (the demo works, the live path recovers from token revocation). I have **no measurement** on Layer 3, and I name that honestly.

---

## Layer 1 — Agent quality (the Phase 3 eval portfolio, retired)

This is where the L5 receipts from Cut 2 land in concrete numbers.

### The four pillars — what got measured

```
  The Phase 3 eval suite — four pillars, K=10 per anomaly

  ┌─ Pillar 1: Detection precision/recall ───────────────┐
  │  ground-truth set: seeded anomalies in Olist         │
  │  metric: precision/recall over K=10 runs per anomaly │
  │  question answered:                                   │
  │    "does the monitoring agent find the anomalies     │
  │     it should, without raising false alarms?"        │
  └──────────────────────────────────────────────────────┘

  ┌─ Pillar 2: Diagnosis 5-criterion rubric ─────────────┐
  │  rubric criteria:                                     │
  │    1. hypothesis is plausible given the anomaly      │
  │    2. evidence cites real EQL queries                │
  │    3. conclusion follows from evidence               │
  │    4. affected-customer scope is sized correctly     │
  │    5. uncertainty is named where present             │
  │  metric: pass rate across K=10                       │
  └──────────────────────────────────────────────────────┘

  ┌─ Pillar 3: Recommendation 3-criterion rubric ────────┐
  │  rubric criteria:                                     │
  │    1. Bloomreach feature fits the diagnosed problem  │
  │    2. steps are concretely actionable                │
  │    3. expected impact is named (not vague)           │
  │  metric: pass rate across K=10                       │
  └──────────────────────────────────────────────────────┘

  ┌─ Pillar 4: Regression capture-and-score ─────────────┐
  │  capture every run as structured output              │
  │  diff vs prior version (structural + LLM similarity) │
  │  metric: stability of conclusions across versions    │
  │  baseline established: 30% conclusion variability    │
  │    across K=10 (the regression line, not a bug)      │
  └──────────────────────────────────────────────────────┘
```

### Calibration — the discipline that made the numbers credible

LLM-as-judge is suspect by default. The whole pipeline collapses if the judge rubber-stamps everything. The calibration discipline:

```
  LLM-judge calibration — the spot-check that matters

  step 1: manually score N runs by hand
  step 2: have LLM-judge score the same N runs
  step 3: compare — if agreement < threshold, the
          judge is broken (or the rubric is broken)

  Results from Phase 3:
  → Detection: 8/8 manual-vs-judge agreement
  → Diagnosis: 3/3 manual-vs-judge agreement

  Interpretation: the judge is tracking what a human
  reviewer would flag. The pillar numbers above are
  not LLM-judge hallucinations.
```

Eight out of eight on detection and three out of three on diagnosis is not "perfect calibration" — it's "small-sample but enough to refute the rubber-stamp objection." Naming the sample size honestly (8 and 3) is the move.

**Coach line:** *"The judge could be lying. I checked. Eight out of eight on detection, three out of three on diagnosis — manual spot-check against LLM-judge agreement. Small sample, but enough to refute the rubber-stamp objection."*

### The three bugs the eval surfaced

This is the proof that the eval pipeline was *useful*, not just *built*.

**Bug 1: BRL units (Brazilian Reais vs cents)**

The judge flagged a run at iteration 8 — the agent had reported an average order value of **R$131,965**. Implausible on its face for an ecommerce workspace. The investigation: the EQL was returning the `total_price` field in cents (Brazilian banking standard for `total_price` storage), and the prompt was reading it as Reais. A 100x error.

This is the bug that proves an LLM judge earns its keep. A unit test would have asserted "result is a number" and passed. A schema validator would have asserted "result is a positive integer" and passed. Only a judge with **business plausibility context** could flag "this AOV is too high for this kind of workspace."

**Bug 2: Binary calibration breakdown on diagnosis**

29 out of 30 diagnosis runs were getting binary pass/fail from the rubric, when the actual quality varied substantially. The rubric was too coarse — it asked "is this diagnosis good?" instead of "which of these five things did this diagnosis do well or poorly?" Forced a redesign of the diagnosis criteria into the 5-criterion rubric shown above.

This is the bug that proves the eval pipeline taught me something about *eval design*, not just about the agent.

**Bug 3: Conclusion instability — the regression baseline**

Across K=10 runs on the same anomaly with the same prompt and the same data, the diagnosis conclusion varied by ~30%. Not a bug to suppress — a property of the system at this temperature and prompt design. It became the regression baseline: any change that moves conclusion-similarity below ~70% is a regression, anything above is noise.

The lesson: **stability is a measurement, not a goal.** If you don't measure it, every prompt edit is a coin flip. Measuring it means you can tell the difference between "this prompt edit helped" and "this prompt edit is noise inside the existing variability."

### Why the suite was retired

The Olist MCP server (the data substrate the eval ran against) was retired in PR #8 (2026-06-18). The eval suite was tightly coupled to Olist's seeded ground-truth anomalies, so it retired with the substrate.

The honest call: **don't keep dead infrastructure around to look thorough.** A retired eval suite that no longer runs against the current substrate is worse than an empty `eval/` folder — it's a lie that says "we measure this" when nothing is being measured.

The rebuild target is named, not vague: **the same four pillars, the same calibration discipline, against the in-process Synthetic adapter.** The Synthetic adapter is a cleaner shape for the same job — controllable ground truth, no network, deterministic seeding.

---

## Layer 2 — Product responsiveness (functional evidence, no formal numbers)

This layer is measured by behavior, not by numeric thresholds.

```
  Product-responsiveness signals

  ┌─ Demo mode latency ─────────────────────────────────┐
  │  expectation: instant (no auth, no network)         │
  │  evidence: `?demo=cached` serves committed JSON     │
  │            from `lib/state/demo-*.json`             │
  │  measurement: subjective ("does it feel instant?")  │
  │  not formally benchmarked                            │
  └─────────────────────────────────────────────────────┘

  ┌─ Live mode survival under token revocation ─────────┐
  │  expectation: reconnects on invalid_token, reloads  │
  │              once (guarded against infinite loops)  │
  │  evidence: `app/page.tsx` auto-reconnect path       │
  │  measurement: behavioral — the demo recovers when   │
  │              the alpha server revokes               │
  └─────────────────────────────────────────────────────┘

  ┌─ Streaming trace freshness ─────────────────────────┐
  │  expectation: reasoning steps appear as they happen │
  │              (NDJSON streaming over ReadableStream) │
  │  evidence: AgentEvent contract in `lib/mcp/events.ts`│
  │  measurement: visual — `StatusLog` updates live    │
  └─────────────────────────────────────────────────────┘
```

These are not measured numerically. They're shipped behavior, observable on the running app. I'd name "we should add p50/p95 latency on the streaming endpoint" as a real gap — not measured.

---

## Layer 3 — Workflow validation (the honest gap)

**Not measured. Cannot be measured from the repo.**

The questions that *would* validate workflow value:

- Does an analyst save time using this vs running EQL by hand?
- Does the trace surface make them trust the output enough to act on it?
- Do recommendations get adopted, or does the analyst always rerun the queries themselves?

None of these are answerable without putting the product in front of actual Bloomreach analysts. That's user research, not engineering. Listing them as **discovery questions** rather than pretending they're measured is the senior move.

**Coach line:** *"Layer 3 is unmeasured and I name that openly. The repo can prove the agent produces good output and the UI streams reliably; it cannot prove an analyst's week is faster. That's user research, and I haven't done it."*

---

## The feedback loop — what changed because of measurement

The feedback loop matters as much as the metrics. Numbers without action are theater.

```
  Feedback-loop walk — what each pillar produced

  ┌─ Pillar 1 (detection) ──────────────────────────────┐
  │  found: monitoring agent had a recall gap on        │
  │         country-segment anomalies                   │
  │  action: tightened the country-breakdown prompt to  │
  │          require global-change check first          │
  │  result: recall improved on next K=10 sweep         │
  └─────────────────────────────────────────────────────┘

  ┌─ Pillar 2 (diagnosis) ──────────────────────────────┐
  │  found: binary calibration breakdown                │
  │  action: redesigned to 5-criterion rubric           │
  │  result: pass rate dropped (because rubric got      │
  │          harder), but signal became actionable      │
  └─────────────────────────────────────────────────────┘

  ┌─ Pillar 3 (recommendation) ─────────────────────────┐
  │  found: impact statements were vague                │
  │         ("could improve conversion")                 │
  │  action: added "expected impact must be quantified" │
  │          to the rubric                              │
  │  result: prompt rewrite forced concrete impact      │
  │          callout (now rendered in UI as highlighted │
  │          panel in `RecommendationCard`)             │
  └─────────────────────────────────────────────────────┘

  ┌─ Pillar 4 (regression) ─────────────────────────────┐
  │  found: 30% conclusion variability baseline         │
  │  action: established as the regression threshold;   │
  │          future prompt edits scored against it      │
  │  result: ongoing — would be the gating signal for   │
  │          model upgrades when rebuilt                │
  └─────────────────────────────────────────────────────┘
```

Each pillar found something. Each finding produced a change. That's the loop.

---

## The honest current state

```
  Where the feedback loop is today

  Phase 1:  no formal eval — manual eyeballing
  Phase 3:  4-pillar suite, K=10, calibrated, finding bugs
  Phase 4:  suite retired with Olist; back to manual
  Today:    same as Phase 1 in terms of LIVE measurement
            ── BUT with 3 receipts from Phase 3:
              1. built the suite end-to-end, know the shape
              2. used it to find 3 named bugs
              3. know what the next version looks like
                 (against Synthetic, same 4 pillars)
```

The honest framing: **today, agent quality is measured by eyeballing the trace.** Same as Phase 1. The difference is I've done the work once, know what good measurement looks like, and have specific receipts.

The rebuild is not "we should add evals someday." It's:
- **Substrate:** the in-process Synthetic adapter (already present).
- **Pillars:** same four — detection precision/recall, diagnosis rubric, recommendation rubric, regression capture.
- **Calibration:** same discipline — manual spot-check against LLM-judge, target >= 80% agreement.
- **Bugs to look for:** the three classes already surfaced (unit errors, rubric coarseness, conclusion instability) — known failure modes.

That's a buildable plan with a substrate. Not a wishlist.

---

## The general principle — measurement is a position, not a checkbox

A reviewer asking "how do you know it works?" is testing whether you treat measurement as **a position you defend** (here are the numbers I have, here are the numbers I don't, here's why the gap exists) or **a checkbox you ticked** (we have evals).

The position is harder to fake. The checkbox is easy.

The Phase 3 work proves I can take the position. The retirement proves I won't pretend infrastructure exists when it doesn't. The named rebuild proves I know what comes next.

---

## See also

- `02-scope-cuts-and-non-goals.md` — Cut 2 (eval pipeline) is the receipt this chapter cashes in
- `03-options-and-opportunity-cost.md` — the AptKit migration was scored against the conclusion-stability baseline
- `05-skeptical-reviewer-questions.md` — "how do you know any of this is good?" answer
- `.aipe/audit-refactor-eval-substrate/` — the historical refactor that retired the suite
- `.aipe/study-ai-engineering/` — the technical walk of the eval architecture
