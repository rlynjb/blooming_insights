# Multi-rubric LLM eval pipeline

> **RETIRED 2026-06-18.** This file was authored against the Olist MCP
> server / Phase 3 eval pipeline, both removed from the codebase. The
> patterns it teaches are real, but the code anchors it cites no longer
> exist. Preserved as a historical record of what was studied.

**Industry name(s):** LLM evaluation pipeline, multi-rubric eval suite, eval flywheel, golden-set + judge harness, calibrated quality measurement
**Type:** Industry standard · Senior-level system design

> Design an offline evaluation pipeline for a multi-agent LLM system: cover detection (set overlap), reasoning quality (per-criterion rubric scored by LLM-as-judge), action quality (lighter rubric, same judge shape), and regression (capture-then-score with structural diff + similarity judge). The discipline that separates senior from mid is **calibration receipts** (manual-vs-judge agreement spot-checks) and the **eval flywheel** (every surfaced bug becomes a permanent fixture).

**See also:** [01-search-ranking.md](01-search-ranking.md) · [02-tech-support-chatbot.md](02-tech-support-chatbot.md) · [../05-evals-and-observability/01-eval-set-types.md](../05-evals-and-observability/01-eval-set-types.md) · [../05-evals-and-observability/02-eval-methods.md](../05-evals-and-observability/02-eval-methods.md) · [../05-evals-and-observability/03-llm-as-judge-bias.md](../05-evals-and-observability/03-llm-as-judge-bias.md) · [../05-evals-and-observability/05-regression-evals.md](../05-evals-and-observability/05-regression-evals.md) · [../04-agents-and-tool-use/08-authoring-mcp-server.md](../04-agents-and-tool-use/08-authoring-mcp-server.md)

This file is a **system-design-template** reframe, not a per-concept study file. It is the verbatim IK-style interview prompt answered with the canonical architecture, then honestly mapped onto blooming insights. The first seven bullets are generic — they hold for any LLM eval pipeline. Only the last two are blooming-insights-specific. Provenance: senior-level architecture interview prompt; this codebase is the worked example.

---

**The prompt:** Design an evaluation pipeline for a multi-agent LLM product that catches regressions on every prompt edit and model change. The product has at least three agent surfaces (detection, reasoning, action); outputs are non-deterministic prose; engineers iterate on prompts daily.

**Standard architecture:**

```
  prompt edit / model swap / fixture change
                │
                ▼
  ┌──────────────────────────────────────────────┐
  │  EVAL HARNESS (CLI, K runs per case)         │
  │  spawns fresh backend subprocess per run     │
  └────────┬────────────────────┬────────────────┘
           │                    │
           ▼                    ▼
  ┌────────────────┐   ┌────────────────────────┐
  │ GROUND-TRUTH   │   │ LIVE AGENT (real model)│
  │ fixtures       │   │ runs against the same  │
  │  - golden set  │   │ deterministic backend  │
  │  - regression  │   │ as the ground truth    │
  │  - adversarial │   │                        │
  └────────┬───────┘   └───────────┬────────────┘
           │                       │ candidate output
           ▼                       ▼
  ┌──────────────────────────────────────────────┐
  │  SCORER (right rung per surface)             │
  │   detection  → set-overlap precision/recall  │
  │   reasoning  → per-criterion rubric + judge  │
  │   action     → smaller rubric + judge        │
  │   regression → structural diff + sim judge   │
  └────────┬─────────────────────────────────────┘
           │
           ▼
  ┌──────────────────────────────────────────────┐
  │  DATED RESULT DIR (committed paper trail)    │
  │   results/<YYYY-MM-DD>/                      │
  │     <eval>-K10-{candidates,judge,summary}.json│
  │     summary.md (human-readable scorecard)    │
  │   calibration receipt embedded in summary    │
  └────────┬─────────────────────────────────────┘
           │
           ▼
  decision: merge / no-merge / promote to fixture
```

**Standard data model:**

- **Fixture** `{ id, input, reference?, expected?, surface }` — one ground-truth case. `reference` for rubric-judged surfaces; `expected` for set-overlap surfaces.
- **Candidate** `{ fixture_id, run_index, output, transcript? }` — one agent's output on one run. `transcript` (the tool-call sequence) carries the auditability the judge needs to score grounding/fabrication.
- **Judge response** `{ fixture_id, run_index, scores: { criterion: number }, total, pass, rationale }` — per-criterion scores from one judge call. Rationale is what makes the receipt spot-checkable.
- **Aggregate** `{ pass_rate, mean_score, per_criterion_mean, per_fixture_table }` — the summary.md numbers.
- **Calibration receipt** `{ sample, manual_scores, judge_scores, agreement_rate }` — the manual-vs-judge spot-check, committed alongside the aggregate.

**Key components:**

- **Runners** — one per eval (detection, reasoning, action, regression). Each spawns a fresh deterministic backend subprocess per K=1..N run, isolates crashes, writes a result dir.
- **Judges** — markdown prompts (`eval/judges/*.md`), each defining a per-criterion rubric. The judge is itself an LLM; biases (position, verbosity, self-preference) require explicit handling.
- **Scorers** — language-agnostic functions per surface: set-overlap, structural-diff, rubric-judge wrapper. Picking the right scorer per surface is half the design.
- **Result-dir convention** — dated `results/<YYYY-MM-DD>[-<tag>]/` with raw candidates, raw judge outputs, aggregate JSON, and a human-readable `summary.md`. Committed to git so the trail survives.
- **Calibration discipline** — every result dir's `summary.md` carries a stratified sample of manual scores alongside the judge scores, with an agreement rate.

**Scale concerns:**

- **Cost.** K=10 runs × N fixtures × J judges = O(K·N·J) provider calls. Sonnet 4.6 at ~$0.10-0.30/run × 30 fixtures × 2 judges = ~$3-15 per full eval pass. Tighten by sampling: pairwise A/B only needs the cases under prompt edit, not all of them.
- **Determinism.** The backend must be deterministic for the eval to be replicable. A vendor API (rate-limited, expiring tokens) is unsuitable as the eval backend — you author your own (or replay a frozen MCP transcript). See `../04-agents-and-tool-use/08-authoring-mcp-server.md`.
- **K choice.** K=1 is unreliable; K=10 gives ±10% precision/recall confidence intervals; K=30 tightens to ±5%. K=10 is the recruiter number for portfolio; K=30 for promotion packages.
- **Latency.** Sequential runs are fine — the bottleneck is the agent's own tool-call budget, not the eval driver. Parallelizing across runs hits the provider rate limit before saving meaningful time.
- **Storage.** Each result dir is ~1-10MB of JSON; committed paper trail across N dates is ~100MB-1GB over a year — fits in git LFS or stays in main for moderate scales.

**Eval framing (when this *is* the eval pipeline, what does *it* get evaluated against?):**

- **Manual-vs-judge agreement** — the calibration receipt is the eval-of-the-eval. < 70% agreement means the judge or the rubric is broken; > 90% means the receipt is signal.
- **Baseline stability** — running capture-then-immediately-score on the regression eval gives the baseline (30% semantic for this codebase). If the baseline drifts month-over-month without code change, your eval is unstable.
- **Coverage** — does the golden set exercise every agent surface? Does the regression set absorb every eval-surfaced bug? Coverage gaps surface as fixtures that pass too easily.

**Common failure modes:**

- **Self-preference bias** — using the same model family for judge and agent (sonnet judging sonnet). Mitigated by per-criterion rubrics + manual calibration; fixed by cross-family judging.
- **Judge rubber-stamping** — the judge passes everything. The receipt that proves it isn't is the one case where the judge correctly *failed* a candidate (blooming insights: the BRL bug catch at run 8, dropping the run from 5/5 to 4/5).
- **Verbatim regression failure** — using `===` on non-deterministic prose, treating every run as a regression. Fixed by the two-mode split (structural diff + similarity judge).
- **Unscored prompt edits** — engineers iterating on prompts without running evals. Operationally: wire `eval:detection` / `eval:diagnosis` into the prompt-edit PR template; treat "no eval result attached" as a review block.
- **Baseline never measured** — reporting "30% pass" without saying what the baseline is. The decision rule needs a floor.
- **No eval-flywheel discipline** — finding bugs in evals and forgetting to capture them as regression fixtures. The flywheel only ratchets toward completeness if every surfaced bug becomes a permanent guard.

---

**Applies to this codebase:** **yes — this codebase IS the worked example.**

blooming insights ships exactly this pipeline under `eval/`:
- four runners (`eval/scripts/run-detection.ts`, `run-diagnosis.ts`, `run-recommendation.ts`, `run-regression.ts`) — Case A
- three LLM-as-judge surfaces (`eval/judges/diagnosis-judge.md`, `recommendation-judge.md`, `similarity-judge.md`) — Case A
- a self-authored deterministic backend (`mcp-server-olist/`) with seeded ground truth — Case A
- dated result dirs (`eval/results/2026-06-15/`, `…-after-fix/`, `…-capture/`, `…-score-baseline/`) — Case A
- standing calibration receipts (diagnosis 8/8, recommendation 3/3 incl. BRL-bug catch) — Case A
- the eval-flywheel discipline (PR D → Phase 2.5 prompt fix → 5× lift → PR E surfaces BRL bug → PR F judge re-catches → PR G regression baseline) — Case A

Where it falls short of the canonical design:
- **Single-family judge** — all three judges run `claude-sonnet-4-6`, same family as the agents. Self-preference bias is acknowledged (calibration receipts) but not fixed (no cross-family judge). The fix is named in `../05-evals-and-observability/03-llm-as-judge-bias.md`'s "cross-family judge" exercise.
- **No pairwise A/B mode** — the un-built rung. The detection pre-fix vs post-fix comparison at `eval/results/2026-06-15/` vs `…-after-fix/` is a manual A/B; formalizing as `--compare promptA promptB` is the exercise in `../05-evals-and-observability/02-eval-methods.md`.
- **No adversarial set on `?q=`** — the named gap in `../05-evals-and-observability/01-eval-set-types.md`.
- **Calibration receipts are ad-hoc markdown tables, not a standing harness** — automated via the calibration exercise in `../05-evals-and-observability/03-llm-as-judge-bias.md`.

---

**How to make it apply:**

This is the senior-level interview reframe. Three moves:

**Move 1 — name the surfaces and pick the rung per surface.** Don't reach for LLM-as-judge for everything; match the scorer to the output shape. The four surface → rung mappings in this codebase are the worked answer: detection = set-overlap; reasoning = per-criterion rubric; action = lighter rubric; regression = structural diff + similarity judge. Name them.

**Move 2 — show the calibration discipline.** A judge without a receipt is decorative. The candidate move is to describe a stratified manual-vs-judge spot-check (one PASS and one FAIL per fixture, run by a human), with an agreement rate published in the result dir. Anyone can say "we use LLM-as-judge"; only people who've shipped it can describe the calibration receipt.

**Move 3 — name the flywheel and show a receipt.** The pipeline pays for itself only when it catches things unit tests cannot. The candidate move is to walk one real iteration: an eval surfaced X, the team did Y, the next eval showed Z. In this codebase: PR D's detection eval surfaced the time-horizon issue → Phase 2.5 added DATA HORIZON to the monitoring prompt → loose recall lifted 5× (6.7% → 33.3%, `eval/results/2026-06-15-after-fix/summary.md`). That's the receipt that the pipeline isn't theater.

```
the eval flywheel — receipt that the pipeline pays for itself
─────────────────────────────────────────────────────────────
PR D: eval/results/2026-06-15/         baseline detection
      → surface: agent issues out-of-horizon queries

Phase 2.5: lib/agents/prompts/monitoring.md
      → add DATA HORIZON section + 3-dim scan plan

PR D-after-fix: eval/results/2026-06-15-after-fix/
      → 5× lift in loose recall (6.7% → 33.3%)
      → STRICT recall still 0% — partial win
      → honest finding: "the prompt fix is partial"

PR E: eval/results/2026-06-15/diagnosis-summary.md
      → surface: BRL cents-vs-Reais bug (R$131,965 AOV)

PR F: eval/results/2026-06-15/recommendation-summary.md
      → judge catches BRL bug recurring at run 8
      → impact_sized=0, score 5→4
      → receipt that the judge isn't rubber-stamping

PR G: eval/results/2026-06-15-score-baseline/regression-summary.md
      → 30% semantic baseline established
      → confirms conclusion stability is the system-wide bottleneck
      → enables baseline-relative decision rule for future prompt edits
```

The eval flywheel discipline is named in `../05-evals-and-observability/01-eval-set-types.md` (every surfaced bug becomes a permanent fixture), `../05-evals-and-observability/02-eval-methods.md` (the right rung per surface), `../05-evals-and-observability/03-llm-as-judge-bias.md` (calibration receipts as honest mitigation for self-preference), and `../05-evals-and-observability/05-regression-evals.md` (the baseline-relative decision rule). Read them together — the four-pillar suite is the worked example of the architecture described above.

---
Updated: 2026-06-16 — new file. The 4-pillar eval suite shipped in Phase 3 is exactly this template: detection (set-overlap) + reasoning (per-criterion rubric) + action (lighter rubric) + regression (structural diff + similarity judge), with calibration receipts and the flywheel discipline. Worked example with file/results citations.
