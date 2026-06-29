# 07 — System design templates (interview reframes)

This sub-section is different from every other sub-section. The concept files in 01-06 explain *patterns this codebase uses*. The two files here explain *interview prompts this codebase exemplifies (or could be refactored to exemplify)*. Same code, different framing.

Each template uses the fixed 9-bullet shape (not the per-file format from `format.md`):

  - **The prompt** — the verbatim interview prompt
  - **Standard architecture** — the box-and-arrow whiteboard
  - **Data model** — what's stored where
  - **Key components** — sub-systems with one tech choice each
  - **Scale concerns** — what breaks first, with concrete thresholds
  - **Eval framing** — offline + online metrics
  - **Common failure modes** — three or four interviewer probes
  - **Applies to this codebase** — `yes` / `partially` / `no` with honest paragraph
  - **How to make it apply** — concrete refactor or next deepening

Both templates apply `partially` to this codebase. The honest framing matters more than the optimistic framing — interviewers can smell overclaim.

## Files

  1. `01-search-ranking.md` — covers C5.10 (search ranking)
  2. `02-tech-support-chatbot.md` — covers C5.14 (tech support chatbot)

The base spec's ML system-design templates (recommender, anomaly detection, object detection / CV) are skipped — this codebase is pure LLM application engineering, no classical ML.
