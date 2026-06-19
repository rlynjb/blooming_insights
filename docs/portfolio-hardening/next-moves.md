# Next moves — post-Phase 3

> **SUPERSEDED 2026-06-18.** Phase 2 (Olist MCP server) and Phase 3 (eval
> pipeline) were removed from the codebase on the `remove-olist-mcp-server`
> branch. The 6 B-candidate fix targets named in this file no longer
> apply — they were all eval-surfaced findings against the now-removed
> Olist substrate. Preserved as a record of the post-Phase-3 decision
> snapshot.

> Decision artifact, not an execution plan. Captures the three honest
> next-move paths after the portfolio-hardening arc (Phases 1+2+3)
> shipped to main. Pick one when there's appetite; revisit when
> context changes.

**Current state (2026-06-15):**

```
✓ Phase 1 (Study)   personal study — your own time
✓ Phase 2 (Swap)    your own MCP server over Olist · main @ 569e8be
✓ Phase 3 (Eval)    4 pillars with calibration receipts · main @ 2390e41

  Tests:     269 passing
  TypeScript: clean
  Total Anthropic spend across Phase 3: ~$10-15
```

The portfolio-defense story is complete and defensible. The three
options below are continuations, not requirements.

---

## Option A — Stop here

```
When to pick:
  - You're going into an interview loop and want to lock the narrative
  - The eval numbers (37% / 33% / 53.3% / 100% / 30%) are good enough to
    talk to without further iteration
  - Time is better spent on Phase 1 personal study (defending the
    architecture cold) than on more code

What you keep:
  - 4 portfolio numbers with calibration receipts
  - Eval flywheel demonstrated (PR D → Phase 2.5 → 5x recall lift)
  - Your own MCP server runnable locally; Bloomreach adapter dormant
  - 6 Phase 3.5 candidates documented in commit bodies for "what's
    next" interview question

What you don't get:
  - Higher numbers (more polish would require Option B)
  - A second flagship (Option C)
```

**This is the cleanest answer if interview prep is the next 4 weeks.**

---

## Option B — Phase 3.5 iteration cycle

Pick ONE of the 6 eval-surfaced issues. Tight scope, eval flywheel cycle:
fix → re-run → measure delta → commit.

### B.1 — BRL cents-vs-Reais bug (surfaced PR E, recurred PR F)

```
Cost:     ~30 min code + ~$2 re-eval spend
Effort:   one-line guard in agent prompts OR cents→Reais conversion in
          mcp-server-olist tool results
Measures: re-run diagnosis K=10; track fab criterion mean from 1.37/2
          upward
Win:      remove a known unit bug; show "I found a bug via eval, fixed it,
          re-measured" — the most senior pattern in interview defense
```

### B.2 — Calibration binary problem (PR E 29/30 = 0)

```
Cost:     ~1 hour code + ~$2 re-eval spend
Effort:   diagnostic agent's confidence field is derived from "3 hypotheses
          tested → high"; either refine the derivation OR distinguish
          "hypothesis supported" from "hypothesis is the cause"
Measures: re-run diagnosis K=10; track calibration mean from 0.03/1
          upward
Win:      moves the diagnosis pass-rate from 53.3% — the calibration
          criterion alone is gating ~3-4 runs from passing
```

### B.3 — Mid-horizon week-specific detection (PR D strict 0%)

```
Cost:     ~$1-3 for sliding-window prompt iteration OR ~3-4 hours for
          detect_outliers tool in mcp-server-olist
Effort:   Path A (prompt-level): add sliding-window scan plan or "find
          LARGEST deviation across all weeks" instruction
          Path B (tool-level): add detect_outliers tool returning
          z-score statistical outliers; agent calls once per dimension
Measures: re-run detection K=10; target loose recall 50%+,
          strict recall non-zero
Win:      lifts detection from 33% loose recall toward 60%+; closes
          the strict 0% finding
```

### B.4 — Seed-data anomaly window overlap (PR E SP 0/10)

```
Cost:     ~1 hour code + ~$3-5 re-eval spend
Effort:   tighten the synthetic data's anomaly windows in
          mcp-server-olist/scripts/seed-olist.ts so SP-revenue-w4 and
          electronics-w2 don't shadow each other
Measures: re-seed → re-capture goldens → re-run all 4 evals
Win:      makes the SP failure visible — currently the agent is locally
          correct about a real artifact in the seed; tightening forces
          a real test of the agent's reasoning rather than an artifact
Risk:     this is dataset change → invalidates the captured goldens
          for PR G; need full regression-capture re-run
```

### B.5 — Recommendation rubric tightening (PR F 100% ceiling)

```
Cost:     ~1 hour code + ~$3 re-eval spend
Effort:   add 4th criterion (evidence-grounded — does each rec cite
          the specific tool result it derives from?)
          OR make impact_sized 0-2 (distinguish "number present" from
          "number with realistic assumptions matching ground truth")
          OR add novelty criterion to penalize template-y outputs
Measures: re-run recommendation K=10; target ~70-90% pass rate
          (below ceiling but above breakdown)
Win:      replaces a 100% ceiling-read with a credible mid-range
          number that gives the agent room to improve under future
          iterations
```

### B.6 — Conclusion stability via temperature / grounding

```
Cost:     ~1 day; broadest of the 6
Effort:   temperature reduction OR hypothesis-grounding constraints
          OR reasoning-trace pinning in the system prompts
Measures: re-run regression eval; target baseline semantic pass-rate
          50%+ instead of 30%
Win:      addresses the through-line finding across all 4 PRs: the
          system's weakest property is conclusion stability. A real
          lift here is the highest-leverage single change.
Risk:     largest scope; might require multiple iteration cycles
```

### When to pick Option B

```
Pick B if:
  - You want a fresh eval iteration receipt for the interview narrative
    ("I shipped X, then evaluated, then fixed Y, then re-measured —
     loose recall went from A% to B%")
  - The number you want to lift has a specific upstream cause already
    surfaced
  - You have ~1 day + ~$5-10 budget

Don't pick B if:
  - You're already happy with the current numbers + flywheel story
  - The interview loop starts before you can complete a full
    fix → re-measure cycle (~1 day minimum)
```

---

## Option C — Plan the next project (agentic RAG engine)

Per the source plan's "After this — the RAG gap" sidebar:

```
"The one pillar this project doesn't close is RAG, and forcing it here
 would be contrived (blooming insights queries live data). That's a
 separate phase-two project — the agentic RAG engine with a
 KnowledgeDomain adapter. One flagship done deeply first."
```

That flagship is the next portfolio artifact. Sketch:

```
Goal:     agentic RAG over a knowledge corpus with adapter seam (so
          one repo demonstrates retrieval, ranking, eval — analogous
          to how blooming insights demonstrates agents + MCP +
          evals).

Shape:    separate repo (clean slate). NOT a feature in blooming
          insights.

Architectural skeleton (informed by Phase 2's seam discipline):
  - KnowledgeDomain adapter (interface): query, index, retrieve,
    rerank, embed
  - First adapter: a public dataset corpus (e.g., a slice of arXiv,
    Wikipedia, or a specific domain)
  - Agent loop: query understanding → retrieve → rerank → synthesize
    → answer-grounded-in-citations
  - Eval pillar from day 1 (don't make Phase 3's "add evals after"
    mistake)

Phase shape (informed by Phases 1-3 of blooming insights):
  Phase A: build the agent loop + first adapter (4-6 weeks)
  Phase B: second adapter (proves the seam) — different corpus
            shape, e.g., structured vs unstructured (2-3 weeks)
  Phase C: eval suite from day 1 (parallel to Phase A; 1-2 weeks
            overlap with B)
  Phase D: optional UI surface
```

Cost: weeks of focused work; not API spend.

### When to pick Option C

```
Pick C if:
  - You're past the immediate interview loop and looking at a
    multi-month flagship
  - You want a SECOND portfolio project demonstrating different
    primitives (retrieval + ranking) than blooming insights
    (agents + MCP)
  - RAG-specific roles are showing up in your search

Don't pick C if:
  - You haven't yet defended blooming insights cold in mock interviews
  - One flagship done deeply > two flagships done shallowly (the source
    plan's discipline)
```

---

## Decision matrix

| Time horizon | Option |
|---|---|
| Interview loop in 1-2 weeks | **A** (stop; focus on personal study/defense) |
| Free week, want one polished number | **B.1, B.2, or B.5** (cheapest cycles) |
| Free week, want the biggest lift | **B.3 or B.6** (highest leverage) |
| Free month+, post-interview-loop | **C** (next flagship) |

---

## Hard rules for whichever path

```
- For Option A: do NOT attempt a half-hearted iteration. Stopping is
  honest; half-finishing creates worse numbers.

- For Option B: ONE eval-surfaced issue per cycle. Don't combine 2-3
  fixes in one iteration — you'll lose attribution on which fix moved
  which number. The flywheel discipline is one fix per re-measure.

- For Option C: separate repo. Don't smuggle RAG into blooming
  insights — the source plan's framing ("forcing it here would be
  contrived") is correct.

- For B + C: production code in blooming_insights stays under the
  Phase 2 "Don't change these" list (runAgentLoop, 4 agents,
  AgentEvent contract, UI, demo path). Eval-driven prompt fixes
  remain the ONLY production-code touch pattern.

- For ALL: the 269-test suite stays green. The eval suite stays
  separate from npm test (cost + non-determinism).
```

---

## What this plan does NOT cover

```
✗ A specific date or commitment. Pick when there's appetite.

✗ Resource allocation (time budget, $$). Defaults documented above;
  override if circumstances change.

✗ Coordination with anything else. Each option is independent.

✗ A choice. You choose. This document captures the options at the
  moment they were viable; not all of them stay viable indefinitely
  (B.4 invalidates goldens, etc.).
```
