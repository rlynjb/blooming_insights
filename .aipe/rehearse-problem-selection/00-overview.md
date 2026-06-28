# Problem selection — overview

**Industry name:** Problem brief / investment justification — Coach posture

This is the **why this problem deserves investment** book. Before any design doc, before any roadmap, before any "let me show you the architecture" — a reviewer wants to hear that you picked the right problem. This bundle is the answer.

You're going into a room where someone — staff engineer, hiring manager, design partner — is going to ask one of these in the first 90 seconds:

- *"Why this and not something else?"*
- *"Is the eval gap honest, or is that a planning excuse?"*
- *"Why did you rewrite the agent loop after defending the hand-rolled one?"*
- *"What did you cut, and would you cut it again?"*

Each chapter rehearses one of those rooms.

---

## The five chapters

```
  The brief — what each chapter is for

  ┌─ 01 problem-brief ───────────────────────────────────┐
  │  WHO hurts, WHAT proves it, WHY now                  │
  │  the 90-second answer to "what is this for"          │
  └─────────────────────────┬────────────────────────────┘
                            │  once the pain is named,
                            ▼
  ┌─ 02 scope-cuts-and-non-goals ────────────────────────┐
  │  what you DIDN'T build, and the receipts:            │
  │    Cut 1: no live BigQuery — fakes for the seam      │
  │    Cut 2: eval pipeline — built, ran, retired (L5)   │
  │    Cut 3: no persistent storage — in-memory + JSON   │
  └─────────────────────────┬────────────────────────────┘
                            │  cuts justified, now compare
                            ▼
  ┌─ 03 options-and-opportunity-cost ────────────────────┐
  │  what else you could have built with the same time   │
  │  + the defer-then-migrate story:                     │
  │    hand-rolled runAgentLoop  →  AptKit migration     │
  │    (L5 evaluated-and-accepted revisit)               │
  └─────────────────────────┬────────────────────────────┘
                            │  the path picked, now measure
                            ▼
  ┌─ 04 success-metrics-and-feedback-loop ───────────────┐
  │  Phase 3 eval portfolio — real measured numbers      │
  │    K=10 per anomaly, 4 pillars, 8/8 + 3/3 calibration│
  │    3 named bugs surfaced (BRL units, binary judge,   │
  │    conclusion instability)                           │
  │  retired with Olist; rebuild target = Synthetic      │
  └─────────────────────────┬────────────────────────────┘
                            │  metrics on table, now defend
                            ▼
  ┌─ 05 skeptical-reviewer-questions ────────────────────┐
  │  the 4 probes that land hardest, with the answers    │
  │  that hold under follow-up                           │
  └──────────────────────────────────────────────────────┘
```

---

## The one-line pitch for the project

> An AI analyst for a Bloomreach Engagement ecommerce workspace that runs the loop a human analyst runs — **what changed → why → what to do** — and streams the agents' reasoning as a first-class UI surface, so every conclusion carries provenance (the exact tool calls, current-vs-prior numbers, streamed reasoning trace).

The differentiator is not "we built an agent." It's **an analyst that shows its work** — receipts, not assertions.

---

## The strongest defense in this brief

If a reviewer has 30 seconds and you have to pick *one* thing to lead with, lead with **Cut 2 — the eval pipeline.**

Most candidates at this level say "I didn't have time for evals" (L1 weakness) or "evals are on the roadmap" (L2). The honest answer here is L5 territory:

> "I cut evals in Phase 1 — hackathon scope, ship the loop first. Then in Phase 3 I shipped the suite anyway: 4 pillars, K=10 per anomaly, LLM-as-judge calibrated against 8/8 manual spot-check on detection and 3/3 on diagnosis. It surfaced three real bugs nothing else would have caught — BRL cents-vs-Reais misread (the judge flagged a R$131,965 AOV at run 8), binary calibration breakdown on 29/30 diagnosis runs, and 30% conclusion instability as the regression baseline. Then I retired the suite when the Olist MCP server it scored against was retired — the in-process Synthetic adapter is a cleaner shape for the same job. The receipt of having built it and used it to find bugs is stronger than promising to build it."

That's the shape every chapter in this brief is trying to teach you to land: **shipped, learned, made a call** — never "we plan to."

---

## How to use this book

Read 01 first to refresh the problem framing. Read 02 next — it carries the most interview leverage. Then 03 (the AptKit migration story is the second-strongest defense). Use 04 as your numbers reference. Use 05 the night before the conversation.

Coach voice throughout. When you see "say this, not that" — that's the rep.

---

## See also

- `02-scope-cuts-and-non-goals.md` — the cuts (Cut 2 = the eval story)
- `03-options-and-opportunity-cost.md` — the defer-then-migrate AptKit story
- `04-success-metrics-and-feedback-loop.md` — the measured numbers from Phase 3
- `05-skeptical-reviewer-questions.md` — the four probes and the answers
- `.aipe/project/context.md` — the project framing this brief is built on
- `.aipe/rehearse-interview-defense/` — sister book, defends the *technical* choices (this book defends the *problem choice*)
