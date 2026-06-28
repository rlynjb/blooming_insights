# 03 — Options and opportunity cost

**Industry name:** Options analysis / opportunity-cost framing — Coach posture

The chapter that proves you didn't just pick the first plausible path. Coach voice: name the alternatives, name what each one would have cost you, and lead with the most consequential decision-revisit on the project.

The AptKit migration is the L5 story here — **defer-then-migrate**, evaluated-and-accepted mode.

---

## Zoom out — the option space at decision time

```
  The options at Phase 1 — what could have been built
  with the same three engineer-weeks

  ┌─ Option A: do nothing ───────────────────────────────┐
  │  no project, no portfolio piece, no learning         │
  │  cost: zero work, zero signal                        │
  └──────────────────────────────────────────────────────┘

  ┌─ Option B: classic RAG chatbot over Bloomreach docs ─┐
  │  "ask questions about Bloomreach features"          │
  │  cost: well-trodden, no differentiation              │
  │        (AdvntrCue already proves you can do RAG)     │
  └──────────────────────────────────────────────────────┘

  ┌─ Option C: dashboard generator ──────────────────────┐
  │  "describe a chart, get an EQL query + viz"          │
  │  cost: incremental, not a workflow shift             │
  │        (an analyst still has to know what to ask)    │
  └──────────────────────────────────────────────────────┘

  ┌─ Option D: agentic analyst with streamed reasoning ──┐ ★ picked
  │  monitoring → diagnosis → recommendation loop        │
  │  + provenance as the differentiator                  │
  │  cost: harder to build, novel UI surface,            │
  │        but no other portfolio project shaped this way│
  └──────────────────────────────────────────────────────┘
```

The verdict was Option D. The rest of this chapter is why, and what the next layer of decision-options looked like *inside* D.

---

## Why Option D over A/B/C

**Why not A (do nothing):** the opportunity cost of doing nothing is the portfolio piece itself. The IK pivot needs work that demonstrates AI-engineering judgment, not just frontend craft. Zero work, zero signal.

**Why not B (RAG chatbot over docs):** I already shipped a RAG product (AdvntrCue — `pgvector` + GPT-4 + tool-calling + session memory). Building another RAG would teach me nothing new and would land in a reviewer's "okay, another RAG demo" bucket. The opportunity cost of B is *re-proving what I've already proved.*

**Why not C (dashboard generator):** the workflow doesn't shift. An analyst with a dashboard generator still has to know what question to ask. The product would compress one step ("write EQL") without addressing the harder steps ("notice the metric moved" and "decide what to do"). The opportunity cost of C is solving the easy part of the problem.

**Why D:** the analyst's loop has three stages (notice → hunt → decide), and no existing product runs all three. Building an agent that runs the whole loop, with the reasoning trace visible, addresses a workflow that doesn't have a clean product today. The opportunity cost of D is engineering effort and risk that the agent quality won't be good enough — and that's the right cost to take on at this career stage.

---

## The harder option space — inside Option D

Once D was picked, the consequential decisions weren't *what to build* — they were *how to build the agent loop.* That's where the L5 story lives.

### Decision 1 — Hand-rolled `runAgentLoop` vs. use a library (Phase 1)

The option space:

```
  Agent runtime — Phase 1 options

  ┌─ Option a: use LangChain/LlamaIndex ─────────────────┐
  │  cost: heavy abstraction, opinionated tool schemas,  │
  │        steep learning curve, debugging through       │
  │        someone else's loop                            │
  └──────────────────────────────────────────────────────┘

  ┌─ Option b: use a smaller library (Mastra, etc.) ─────┐
  │  cost: newer, less battle-tested, library-specific   │
  │        primitives still in flux                       │
  └──────────────────────────────────────────────────────┘

  ┌─ Option c: hand-roll the loop ──────────────────────┐ ★ picked
  │  cost: more code to write and own                    │
  │  payoff: own the budget (maxToolCalls), own the      │
  │          forced-synthesis turn, own the streaming    │
  │          contract end to end                          │
  └──────────────────────────────────────────────────────┘
```

**The pick (c) was deliberate.** Two reasons it was the right call at the time:

1. **The rate-limited Bloomreach MCP server demanded a tool-call budget.** Letting an off-the-shelf agent loop run free against a ~1 req/s server with token revocation would have produced 429s and a broken demo. Owning the loop meant owning `maxToolCalls` and the back-pressure logic.

2. **The forced final synthesis turn was load-bearing.** When the agent ran out of tool calls, it needed *one more turn* with no tools to produce a final answer. That contract was project-specific; baking it into a generic library loop would have been ugly.

The opportunity cost of (c) was real: more code to maintain, no library updates riding for free, the "is your loop correct?" question on me alone.

**Coach line for Decision 1:** *"I started by owning the loop on purpose. The rate-limited server made a hard tool-call budget non-negotiable, and the forced-synthesis turn was a project-specific contract that didn't fit any library's shape at the time. The cost was carrying the loop code myself, and I took it deliberately."*

### Decision 2 — Stick with hand-rolled or migrate to AptKit (Phase 4) ★ the L5 revisit

This is the most consequential decision-revisit on the project. It's where the senior signal lives.

```
  Agent runtime — Phase 4 options
  (after AptKit v0.3.0 shipped with a generic primitive surface)

  ┌─ Option a: stick with hand-rolled runAgentLoop ──────┐
  │  cost: keep carrying the loop, no library leverage,  │
  │        every new model/feature is a manual port      │
  │  benefit: known, working, tested                     │
  └──────────────────────────────────────────────────────┘

  ┌─ Option b: migrate to AptKit via adapter layer ──────┐ ★ picked
  │  cost: 3 Blooming adapter classes, one migration PR  │
  │  benefit: library owns the loop;                     │
  │           Blooming owns the boundary;                 │
  │           legacy preserved at base-legacy.ts as      │
  │           rollback receipt                            │
  └──────────────────────────────────────────────────────┘

  ┌─ Option c: rip-and-replace (use AptKit directly,     │
  │            delete the boundary)                       │
  │  cost: leak AptKit primitives into agent code;       │
  │        any future library swap becomes a full        │
  │        rewrite                                        │
  └──────────────────────────────────────────────────────┘
```

**The pick was (b) — migrate via adapter, keep the boundary, preserve the legacy as a rollback receipt.**

This is the **defer-then-migrate** pattern, evaluated-and-accepted mode:

```
  Defer-then-migrate — the senior shape

  Phase 1                Phase 4
  ───────                ───────
  HAND-ROLL              MIGRATE (with discipline)
  the loop               ──────────────────────
  ──────────             → adapter layer keeps
  → owned the              the boundary mine
    constraints           (Blooming-shaped, not
    (rate limit,           AptKit-shaped)
    forced               → legacy preserved at
    synthesis)             base-legacy.ts as
  → no library             rollback receipt
    fit at the           → 3 adapter classes,
    time                   one migration PR
                         → library owns the loop,
                           I own the boundary

  ╲                            ╱
   ╲     same engineer        ╱
    ╲    revisits her own    ╱
     ╲   decision when the  ╱
      ╲  conditions change ╱
       ╲──────────────────╱
              L5 move
```

**Why this is L5 not L3:**

- **L3** would be "I migrated to AptKit because the hand-rolled loop was getting unwieldy" — a reactive change.
- **L4** would be "I migrated to AptKit because it has better features now" — a feature-driven change.
- **L5** is: *"My original decision was deliberate and right at the time. The conditions changed — AptKit shipped a clean generic-primitive surface that fit the constraints I'd been carrying manually. I revisited the decision, picked the cleaner shape, kept the boundary discipline mine via 3 adapter classes, and preserved the legacy implementation as a rollback receipt at `base-legacy.ts`. The library owns the loop now; I own the boundary."*

The three adapter classes are the boundary. The legacy file is the receipt. Both together prove the migration was discipline, not capitulation.

**Coach line for Decision 2:** *"This is the most consequential decision I revisited on the project. I defended the hand-rolled loop in Phase 1 — and I still defend that call. AptKit 0.3.0 changed the conditions: generic primitives that fit the constraints I'd been carrying. The migration was 3 adapter classes; library owns the loop, I own the boundary, legacy preserved at base-legacy.ts. The shape of the answer is 'evaluated and accepted,' not 'I gave up.'"*

---

## The general principle — opportunity cost is the question, not "is this good?"

```
  The shape of an opportunity-cost answer

  ┌─ Naive answer ─────────────────────────────────────┐
  │  "I built X because it's the best approach."        │
  │  → no comparison; reviewer learns nothing about     │
  │     your judgment                                    │
  └─────────────────────────────────────────────────────┘

  ┌─ L5 answer ────────────────────────────────────────┐
  │  "I built X. The alternatives were Y and Z.        │
  │   Y would have cost me [specific cost]; Z would    │
  │   have cost me [specific cost]. I picked X         │
  │   because [specific tradeoff], and the cost of X   │
  │   was [named honestly]."                            │
  │  → comparison + cost-naming = senior signal        │
  └─────────────────────────────────────────────────────┘
```

The general lesson: **every decision in a senior conversation deserves an opportunity-cost answer.** "I picked X" is not enough. "I picked X over Y, because Y would have cost me [N], and the cost of X I accepted was [M]" is the shape.

---

## See also

- `01-problem-brief.md` — the problem the options were trying to solve
- `02-scope-cuts-and-non-goals.md` — Cut 2 (eval) is another decision-revisit story
- `04-success-metrics-and-feedback-loop.md` — how I knew the AptKit migration didn't regress quality
- `05-skeptical-reviewer-questions.md` — "why migrate?" answer
- `.aipe/audit-refactor-page-decomposition/` — sister refactor pattern (decompose then adapt)
- `.aipe/study-agent-architecture/` — the technical deep-dive on the AptKit migration
