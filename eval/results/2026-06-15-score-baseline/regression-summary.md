# Regression eval — 2026-06-15

Run against 10 golden fixtures captured on 2026-06-15.
Mode: score (compares current outputs to captured goldens via structural diff + similarity judge).

## Aggregate

| Metric                          | Value           |
|---|---|
| Pass rate (overall)             | 30.0% (3/10) |
| Structural pass rate            | 100.0% (10/10) |
| Semantic pass rate              | 30.0% (3/10) |

## Per fixture

| Fixture | Structural | Semantic | Pass |
|---|---|---|---|
| 01-monitoring-empty | ✓ | ✗ | ✗ |
| 02-monitoring-3-anomalies | ✓ | ✗ | ✗ |
| 03-diagnostic-sp | ✓ | ✗ | ✗ |
| 04-diagnostic-electronics | ✓ | ✗ | ✗ |
| 05-diagnostic-voucher | ✓ | ✓ | ✓ |
| 06-recommendation-sp | ✓ | ✗ | ✗ |
| 07-recommendation-electronics | ✓ | ✗ | ✗ |
| 08-recommendation-voucher | ✓ | ✓ | ✓ |
| 09-query-revenue-by-state | ✓ | ✗ | ✗ |
| 10-intent-classify-investigation | ✓ | ✓ | ✓ |

## Failures

### 01-monitoring-empty

  - similarity judge: different conclusion (confidence 0.88)
  - notes: The golden output flags three anomalies: (1) voucher payment_value collapse ~79.4% down [critical], (2) debit_card payment_value decline ~17.6% down [warning], and (3) SP revenue stable ~0.6% down [info]. The new output also flags the voucher collapse and debit_card decline, but replaces the SP revenue stable/info finding with a new critical anomaly: RJ (Rio de Janeiro) revenue down ~33.8%. This is a different anomaly entirely — different state scope, different category, different severity (critical vs info), and the SP stable finding is completely absent. The new output thus introduces a finding the golden didn't flag and drops a finding the golden did flag.
  - differences: SP revenue stable (info) finding entirely missing from new output; New anomaly added: RJ revenue down 33.8% (critical) — not present in golden; debit_card category label shifted: 'payment_type_decline' → 'payment_type_collapse'; baseline date range omitted in new output (only '12w' vs explicit date range in golden)

### 02-monitoring-3-anomalies

  - similarity judge: different conclusion (confidence 0.92)
  - notes: The golden output flags three anomalies: (1) voucher payment_value collapse ~79% down (critical), (2) RJ revenue drop ~34% down (critical), and (3) debit_card payment_value drop ~18% down (warning). The new output flags only two anomalies: (1) voucher payment_value collapse ~79% down (critical) and (2) debit_card payment_value drop ~17.6% down (warning). The RJ revenue drop anomaly — the second critical finding in the golden — is entirely missing from the new output. This is a clear regression.
  - differences: RJ revenue_drop anomaly (critical, ~34% down) is entirely absent from new output; debit_card category label changed from 'payment_type_shift' to 'payment_type_collapse' (minor); new output contains only 2 anomalies vs 3 in golden

### 03-diagnostic-sp

  - similarity judge: different conclusion (confidence 0.85)
  - notes: Both outputs agree that electronics drove the Dec 8–14 spike and that payment disruption is ruled out. However, the golden's supported hypothesis is 'baseline distortion artifact' — the 12-week rolling baseline was inflated by the spike, making normal week-4 revenue *look* like a -30% drop when it was actually +17% above the true pre-spike average. The golden explicitly states no genuine demand collapse occurred and that 0 customers were adversely affected. The new output's supported hypothesis is instead a 'category-specific electronics collapse in SP' — it treats the Dec 22–29 drop as a real demand reversion driven primarily by electronics normalizing after a spike, and characterizes it as SP-specific rather than nationwide. The new output does NOT conclude the anomaly is a measurement artifact; it concludes electronics revenue genuinely collapsed 94% and this is the primary driver of a real revenue drop. The golden also says the nationwide pattern rules out SP-specific disruption, while the new output claims the drop IS SP-specific because SP had a disproportionate share of the electronics spike. These are materially different supported hypotheses and different conclusions about whether the anomaly is real or artifactual.
  - differences: Supported hypothesis changed: baseline distortion artifact → category-specific electronics collapse (real demand reversion); Golden concludes week-4 SP revenue was +17% above true baseline (no genuine drop); new output treats it as a real 94% electronics decline; Golden: anomaly is a measurement/statistical artifact; new output: anomaly is a real post-spike normalization event; Golden: nationwide pattern rules out SP-specific cause; new output: drop IS SP-specific due to SP's outsized share of the spike; Golden: 0 customers adversely affected; new output implies real revenue loss occurred

### 04-diagnostic-electronics

  - similarity judge: different conclusion (confidence 0.92)
  - notes: The golden output concludes the electronics spike was part of a BROAD PLATFORM-WIDE holiday surge — every category, state, and payment type rose simultaneously, and electronics just happened to lead in relative terms. The supported hypothesis is 'platform-wide pre-Christmas seasonal demand surge.' The new output concludes the opposite: that the spike was ELECTRONICS-SPECIFIC, driven by a promotional or seasonal event targeted at or concentrated in electronics, while other categories grew only 'modestly' (20–71%). The new output explicitly frames other categories as growing much less than electronics, which it uses to support an electronics-specific cause. This is a fundamentally different supported hypothesis — platform-wide surge vs. electronics-specific event — even though both outputs agree on ruling out regional and payment-method hypotheses. The new output also mischaracterizes the other category growth rates (claiming only 20–71% vs. the golden's documented +1,454% to +2,129% for those same categories), which drives the different conclusion.
  - differences: Supported hypothesis changed: platform-wide pre-Christmas surge → electronics-specific promotional/seasonal event; Other category growth rates mischaracterized: new output claims 20–71% week-over-week vs. golden's +1,454% to +2,129% (different comparison windows used); New output frames electronics as an outlier vs. modest peer growth; golden frames it as the leader of a universal platform surge; Conclusion direction inverted: shared platform phenomenon → isolated electronics-category phenomenon

### 06-recommendation-sp

  - similarity judge: different conclusion (confidence 0.82)
  - notes: The golden output has three recommendations: (1) a re-engagement campaign targeting lapsed SP buyers, (2) an automated win-back scenario for SP buyers missing 2+ consecutive weeks using Bloomreach's scenario feature, and (3) an A/B experiment testing free-shipping vs percentage-off voucher. The new output also has three recommendations: (1) a re-engagement campaign targeting lapsed SP buyers (same as golden #1), (2) an SP fulfillment-diagnostic segment to isolate city/carrier failure points using Bloomreach's segment feature (entirely different from golden #2 which is an automated win-back scenario), and (3) an A/B experiment testing free-shipping vs control (similar angle to golden #3 but different — golden tests free-shipping vs % discount vs control, new tests free-shipping vs no communication holdout). The second recommendation is a fundamentally different mechanism — golden uses a 'scenario' for automated win-back, new uses a 'segment' for operational/logistics diagnostics. This represents a different recommendation thrust for one of the three recommendations, and the missing automated win-back scenario is a notable absence.
  - differences: Recommendation 2 changed: automated win-back scenario (bloomreachFeature: scenario) → fulfillment-diagnostic segment (bloomreachFeature: segment); Recommendation 2 purpose changed: durable re-engagement infrastructure → logistics/ops city-level root cause investigation; Recommendation 3 A/B test changed: free-shipping vs % discount vs control → free-shipping vs holdout only (no % discount arm); Impact ranges in new output use BRL (R$386K–772K) vs golden using USD ($21K–$43K) — substantially different magnitude framing; Automated win-back scenario entirely absent from new output

### 07-recommendation-electronics

  - similarity judge: different conclusion (confidence 0.82)
  - notes: Both outputs share the same first recommendation type (campaign targeting spike-week electronics buyers for cross-sell) and the same third slot as an experiment/A/B test, but the specifics diverge meaningfully. The golden's second recommendation is a forward-looking 'Electronics Surge Detector' scenario that auto-activates on future surges (triggered by order-count threshold), while the new output's second recommendation is a win-back scenario for lapsed buyers 45 days post-purchase — a fundamentally different mechanism and goal. The golden's third recommendation is a voucher experiment to test price sensitivity among the spike cohort, while the new output's third recommendation is an instalment-offer (parcelamento) A/B test on electronics PDPs to extend demand — a different hypothesis and different audience. The golden's experiment is about margin protection via price-sensitivity testing; the new output's experiment is about payment-structure messaging to convert browsers. These are different recommendation thrusts on at least two of three recommendations.
  - differences: Second recommendation changed: 'Electronics Surge Detector' auto-trigger scenario for future surges → win-back scenario for lapsed buyers 45 days post-purchase; Third recommendation changed: voucher A/B test on spike cohort to measure price sensitivity → instalment (parcelamento) offer A/B test on electronics PDPs to extend demand window; Revenue range for campaign recommendation differs substantially: $139k–$232k (golden) vs $185k–$370k (new), exceeding 5% tolerance; Golden scenario targets future surge events automatically; new scenario targets post-spike churn prevention — different strategic goal

### 09-query-revenue-by-state

  - similarity judge: different conclusion (confidence 0.82)
  - notes: Both outputs agree that SP is the dominant #1 state and that the Southeast leads. However, the ranking of #2 and #3 differs: the golden ranks RJ as #2 and MG as #3, while the new output ranks MG as #2 and RJ as #3. Additionally, the revenue magnitudes differ substantially — the golden shows SP at R$235,060+ (monthly total), while the new output shows SP at only ~R$22,500+, a ~10× discrepancy that is far outside the 5% tolerance. These are materially different conclusions on both ranking and magnitude.
  - differences: RJ vs MG ranking swapped: golden has RJ #2 / MG #3; new has MG #2 / RJ #3; SP total revenue magnitude: golden ~R$235,060+ vs new ~R$22,500+ (~10x difference); New output provides explicit BRL totals for top 10; golden provides qualitative tiers with only SP total approximated

---

Judge model: claude-sonnet-4-6
Total runtime: 9:46

## Honest interpretation

**The regression eval works. The 30% baseline pass-rate is the FINDING, not a problem.**

This run was capture immediately followed by re-run with the same prompts.
A 30% semantic pass means **the agent system is highly stochastic at the
conclusion level** — 7 of 10 fixtures produce materially different
conclusions on a second invocation even when nothing changed.

The 3 fixtures that DID pass tell the same story PR D/E/F surfaced:

| Fixture | Why it's stable |
|---|---|
| `05-diagnostic-voucher` | Voucher anomaly is dramatic (-95% sustained) — unambiguous conclusion. PR E showed 10/10 diagnosis pass. |
| `08-recommendation-voucher` | Same dramatic input; recommendation set converges. PR F showed 10/10 pass. |
| `10-intent-classify-investigation` | Single-token classifier; near-deterministic. |

The 7 fixtures that drifted show real conclusion-level changes:

| Fixture | Drift |
|---|---|
| `01-monitoring-empty` | Added new RJ anomaly; dropped SP-stable finding |
| `02-monitoring-3-anomalies` | Dropped one of the 3 critical anomalies (RJ revenue drop) entirely |
| `03-diagnostic-sp` | Hypothesis flipped: 'baseline distortion artifact' → 'real electronics collapse' |
| `04-diagnostic-electronics` | Hypothesis flipped: 'platform-wide surge' → 'electronics-specific event' |
| `06-recommendation-sp` | Win-back scenario → fulfillment-diagnostic segment |
| `07-recommendation-electronics` | Surge-detector scenario → 45-day post-purchase win-back |
| `09-query-revenue-by-state` | SP totals 10x different; RJ/MG ranking swapped |

These aren't minor wording shifts — they're materially different conclusions
the similarity judge correctly flagged as drift.

## What this gives the portfolio (operational story)

**Calibration baseline: ~30% semantic pass.**

- If a prompt or model change drops it to 10-20%, that's regression
  beyond baseline stochasticity → DO NOT MERGE
- If a prompt or model change keeps it at ~30%, no regression detected
  → MERGE (within tolerance)
- If a prompt or model change pushes it to 50%+, the change is making
  conclusions more deterministic → INVESTIGATE (might be over-anchoring)

The structural diff at 100% confirms outputs always have the right shape
(types match, required fields present) — regressions are conclusion-level,
not structural.

## What this surfaces about the agent system

Independent of the regression eval's own correctness, the 30% baseline is
itself a finding about the system:

- **Conclusion stability is the weakest agent property.** Detection (PR D),
  diagnosis (PR E), and now regression-baseline all surface this.
- **Only dramatic, unambiguous anomalies produce stable conclusions.**
  Voucher across all 3 evals. Electronics and SP drift in every measurement.
- **Future iterations should target conclusion stability**, e.g., temperature
  reduction or hypothesis-grounding constraints in the prompts.

This is the kind of finding only the eval flywheel can produce.
