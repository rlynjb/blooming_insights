# 01 — Recommender system design

- **The prompt:** "Design a recommender system that surfaces N items per user from a catalog of M items, maximizing user engagement."

- **Standard architecture:**

```
User context (history, profile)
  │
  ▼
┌──────────────────────────────────┐
│ Candidate generation             │
│  (content + collaborative,       │
│   reduce M → ~1000)              │
└──────────────┬───────────────────┘
               │
               ▼
┌──────────────────────────────────┐
│ Ranking                          │
│  (learned model, predict         │
│   engagement probability)        │
└──────────────┬───────────────────┘
               │
               │  top-N
               ▼
┌──────────────────────────────────┐
│ Re-ranking / business rules      │
│  (diversity, freshness,          │
│   fairness, cold-start fallback) │
└──────────────┬───────────────────┘
               │
               ▼
┌──────────────────────────────────┐
│ Serving + logging                │
│  (impressions, clicks, dwell)    │
└──────────────┬───────────────────┘
               │
               ▼
            N items shown
```

- **Data model:**
  - Item catalog with `{id, features, content embeddings, metadata, created_at}`
  - User profile with `{id, demographics, explicit preferences, derived features from history}`
  - Interaction log with `{user_id, item_id, timestamp, action, dwell, position}` — the training signal for collaborative filtering
  - Model registry: trained candidate-gen and ranking models with versions, training data snapshots, eval metrics per version

- **Key components:**
  - *Candidate generation*: hybrid content-based + collaborative. Decision: content-based first (handles cold-start), collaborative added once user has ≥ N interactions.
  - *Ranking*: gradient-boosted trees on engineered features (user history, item features, context). Decision: GBT over neural for tabular features at this scale; Two-Tower if scale grows.
  - *Re-ranking*: enforces diversity (no 3 same-category in a row), freshness (boost recent items), fairness (don't always promote popular). Decision: deterministic rules over learned policies for interpretability.
  - *Cold-start handling*: new user → popular items by demographic prior; new item → content similarity to engaged items.

- **Scale concerns:**
  - At ~100k items: full candidate-gen scan becomes too slow. Solution: ANN index over item embeddings, retrieve top-1000.
  - At ~10M users: training data grows past single-node fit. Solution: distributed training, downsample negatives.
  - At ~1B impressions/day: feature store lookups become bottleneck. Solution: precompute user features in offline pipeline, cache hot users in memory.

- **Eval framing:**
  - Offline: precision@k, recall@k, MRR, NDCG on held-out interactions
  - Online: click-through rate, dwell time, session length, return rate
  - A/B framing: control arm (rules / popular) vs treatment arm (learned). "No-click is not a negative label" — an unselected recommendation isn't necessarily bad.

- **Common failure modes:**
  - Filter bubble — model recommends the same cluster repeatedly. Mitigation: explicit diversity constraint in re-ranking.
  - Cold-start for new items — never gets shown, can't accumulate signal. Mitigation: exploration quota (top-K always includes one new item).
  - Position bias in training data — clicked items are mostly from position 1. Mitigation: inverse propensity scoring, randomized exploration sessions.
  - Drift — user preferences shift, model doesn't catch up. Mitigation: retraining cadence + drift detection (PSI on input distribution).

- **Applies to this codebase:** **no**. `blooming_insights` is an analyst tool, not a recommendation surface. No user history, no item catalog, no click/dwell logs, no learned ranker. The closest shape here is the recommendation AGENT (`RecommendationAgent` at `lib/agents/recommendation.ts`) — but that's an LLM generating suggestions for one anomaly at a time based on a diagnosis, not a learned model ranking items for a user.

- **How to make it apply:** the retrofit would require inventing a different product. If `blooming_insights` grew a "recommended Bloomreach features to try" surface on the feed page — a personalized ranked list of scenarios/segments/campaigns for THIS workspace based on past usage patterns across many workspaces — that would be a recommender. Not the current product's direction. Interview answer: "I haven't built one. Here's how the RecommendationAgent's LLM-generation shape differs from a learned recommender, and here's the retrofit shape if I did." The mechanism knowledge (candidate gen → ranker → re-ranker) I have from curriculum work, not from shipping.
