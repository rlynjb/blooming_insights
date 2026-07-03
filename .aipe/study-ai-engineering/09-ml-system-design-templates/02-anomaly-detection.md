# 02 — Anomaly detection system design

- **The prompt:** "Design an anomaly detection system that flags unusual events in a stream of data."

- **Standard architecture:**

```
Event stream
  │
  ▼
┌──────────────────────────────────┐
│ Feature extraction               │
│  (windowed aggregates,           │
│   normalize per-entity)          │
└──────────────┬───────────────────┘
               │
               ▼
┌──────────────────────────────────┐
│ Anomaly scoring                  │
│  (statistical / ML model)        │
└──────────────┬───────────────────┘
               │
          ┌────┴─────┐
          │          │
          ▼ score    ▼ score
          < threshold > threshold
       Pass through    │
                       ▼
               ┌─────────────────┐
               │ Alert + log     │
               │  + human review │
               └─────────────────┘
                       │
                       ▼
              Feedback labels feed
              next training cycle
```

- **Data model:**
  - Event stream with `{timestamp, entity_id, features, raw_payload}`
  - Baseline statistics per entity (rolling mean, std, P95) for normalization
  - Anomaly log with `{timestamp, score, threshold, action, human_label?}` — the ground truth for retraining
  - Alert state per entity (currently anomalous, cooldown timer, recent score history)

- **Key components:**
  - *Feature extraction*: windowed aggregates over the stream, normalized per-entity. Decision: tumbling windows for predictable latency, sliding windows when smoothness matters.
  - *Anomaly scoring*: isolation forest or autoencoder for unsupervised; LightGBM classifier when labels exist. Decision: start unsupervised, switch to supervised after collecting labeled anomalies.
  - *Thresholding*: dynamic threshold per entity based on baseline distribution + business tolerance. Decision: percentile-based, not absolute — adapts to distribution shift.
  - *Alerting*: deduplication (don't fire the same alert N times), cooldown (don't fire again within window), severity tiering.
  - *Human review loop*: flagged events go to a review queue, labels feed retraining.

- **Scale concerns:**
  - At ~10k events/sec: stream processing becomes the bottleneck. Solution: shard by entity_id, process each shard independently.
  - At ~1M entities: per-entity baselines blow up memory. Solution: tiered baselines — hot entities in memory, cold entities in DB.
  - High false-positive rate at scale: humans can't review every alert. Solution: tiered severity, only top-N reviewed by human, the rest auto-escalated only on repeat.

- **Eval framing:**
  - Offline: precision/recall/F1 on labeled anomalies (requires ground truth, which is hard)
  - Online: human review accuracy ("of flagged events, what fraction were real?"), missed-anomaly rate (requires retrospective labeling)
  - Imbalanced data is the default — anomalies are rare by definition. Macro-F1 over accuracy.

- **Common failure modes:**
  - Concept drift — what's anomalous changes over time. Mitigation: PSI on input distribution, retraining trigger when PSI exceeds threshold.
  - Alert fatigue — too many false positives, humans stop reviewing. Mitigation: tune threshold for precision over recall in early days, add severity tiers.
  - Cold-start for new entities — no baseline yet, every event looks anomalous. Mitigation: grace period or population-level prior until per-entity baseline accumulates.
  - LLM analog — hallucination detection is anomaly detection. Same patterns apply: score outputs, threshold, escalate to human review on flagged.

- **Applies to this codebase:** **partially — actually yes, structurally**. `blooming_insights`'s `MonitoringAgent` (`lib/agents/monitoring.ts`) IS an anomaly detection system, just rule-based rather than learned. It:
  - Runs a fixed checklist of ecommerce anomaly categories (from `@aptkit/core`'s `ECOMMERCE_ANOMALY_CATEGORIES`, wrapped in `lib/agents/categories.ts`)
  - Feature-extracts per category (90d-vs-prior-90d percent change per metric)
  - Scores per category threshold (`{critical, warning}` per category)
  - Emits `Anomaly` objects for anything above threshold, with `impact` narration
  - Has a "no results reported below baseline of ~500 events" filter — the small-baseline guard against bogus swings

  Two anomaly-detection surfaces map here:
  1. **Business-side** (the product's main pitch): the monitoring agent detects ecommerce anomalies for the analyst.
  2. **System-side**: `eval/gate.eval.ts` is drift detection on model behavior — regression = per-dim pass rate shift from baseline, flagged with a threshold (see `08-machine-learning/15-drift-detection.md`).

- **How to make it apply:** the codebase already exercises the standard architecture structurally. To deepen into the classical-ML variant:
  - Replace rule-based severity thresholds with a learned severity ranker (Case B in `08-machine-learning/01-supervised-pipeline.md`).
  - Add per-entity baselines that adapt over time (currently the 90d window is fixed; could be dynamic).
  - Add a human-review loop where the analyst's clicks on insights become training signal.
  - Formalize the drift trigger — a PSI-shaped calculation on the per-metric distributions across days.
  Curriculum Build items: `B5.12` (formalize drift detection), potentially `B2C.1-B2C.4` (build the learned scorer). Interview answer: "yes — my monitoring agent is a rule-based anomaly detector. Here's how it maps to the IK template, and here's the retrofit to make the scoring stage learned."
