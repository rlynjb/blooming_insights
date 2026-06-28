# 05 — Skeptical reviewer questions

**Industry name:** Devil's advocate / pre-mortem review — Coach posture

The chapter you read the night before the conversation. Four probes a senior reviewer will reach for, and the answers that hold under follow-up.

Coach voice throughout: lead with the answer, then rank what carries the weight. No hedging.

---

## Zoom out — the four probes

```
  The four probes ranked by interview damage

  ┌─ Probe 1 ─ "How do you know any of the agent ─────────┐
  │             output is actually good?"                  │
  │  damage if mishandled: high — collapses your eval story│
  │  the move: lead with the 3 named bugs the suite caught │
  └────────────────────────────────────────────────────────┘

  ┌─ Probe 2 ─ "Why retire the Olist MCP server you ──────┐
  │             built?"                                    │
  │  damage if mishandled: medium — looks like sunk-cost   │
  │                        fallacy or feature regret       │
  │  the move: frame it as "served its purpose, picked     │
  │            better" — not failure                       │
  └────────────────────────────────────────────────────────┘

  ┌─ Probe 3 ─ "Why migrate from your own agent loop to ──┐
  │             AptKit?"                                    │
  │  damage if mishandled: high — frames it as L3 capitul. │
  │  the move: name the defer-then-migrate L5 shape;       │
  │            point at the 3 adapter classes and          │
  │            base-legacy.ts as evidence of discipline    │
  └────────────────────────────────────────────────────────┘

  ┌─ Probe 4 ─ "What's the eval gap NOW?" ─────────────────┐
  │  damage if mishandled: medium — pushes you to L1/L2    │
  │                        ("we plan to add evals")        │
  │  the move: name the gap honestly + the 3 receipts +    │
  │            the named rebuild target                    │
  └────────────────────────────────────────────────────────┘
```

---

## Probe 1 — "How do you know any of the agent output is actually good?"

### The reviewer's intent

They're testing whether you have measurement, or whether you have a feature that *looks* impressive but you've never verified. This is the L1/L2/L5 sorting probe. Most candidates fold here.

### Do NOT say

> "We tested it with some example queries and it worked well."

This is L1 territory. It tells the reviewer you eyeballed it once and called it shipped.

> "We're planning to add an eval pipeline."

This is L2. It signals you know evals matter but never built any.

### The L5 answer

> "Today, by eyeballing the trace — same as before Phase 3. But I built the harness once, used it on K=10 runs per anomaly across four pillars, calibrated the LLM judge against manual spot-check at 8/8 on detection and 3/3 on diagnosis, and surfaced three real bugs no unit test would catch:
>
> 1. **BRL units** — the judge flagged a R$131,965 AOV as implausible at run 8; turned out the prompt was reading Brazilian cents as Reais, a 100x error.
> 2. **Binary calibration breakdown** — 29 of 30 diagnosis runs were getting binary pass/fail when actual quality varied substantially; forced a rubric redesign into 5 criteria.
> 3. **Conclusion instability** — across K=10 runs, conclusions varied ~30%; became the regression baseline rather than a bug to suppress.
>
> Then I retired the suite when the Olist MCP server it scored against was retired — the in-process Synthetic adapter is a cleaner shape for the same job. The receipt of having built it, calibrated it, and used it to find three named bugs is stronger than promising to build it. The next version is named: same four pillars against Synthetic."

### Follow-up: "Why don't you have evals running now?"

> "Because the substrate they scored against was retired. Keeping a dead eval suite around to look thorough is worse than having none — it's a lie. The honest call was retire-with-substrate and name the rebuild target. The substrate to rebuild against (Synthetic) is already in the repo; what's missing is the pillar implementations against it."

### Follow-up: "Eight out of eight on detection? That's a small sample."

> "Yes — small but enough to refute the rubber-stamp objection. The whole point of a manual spot-check on LLM-judge is asking 'is the judge tracking what a human would flag?' Eight cases were enough to answer that with confidence; thirty wouldn't have added much. I named the sample size on purpose — small but honest beats inflated."

---

## Probe 2 — "Why retire the Olist MCP server you built?"

### The reviewer's intent

They're testing whether you can let go of work that served its purpose, or whether you'd hold onto it for sunk-cost or feature-regret reasons. Senior engineers retire things; juniors maintain them past usefulness.

### Do NOT say

> "Olist had limitations so we moved on."

This frames it as a deficiency in Olist rather than a deliberate architectural call.

> "We didn't have time to maintain both."

This is resource-constrained framing — true, but it sounds like you couldn't follow through.

### The L5 answer

> "It served its purpose — proved the `DataSource` seam by *using* it. The whole point of the seam was that the agent could swap data substrates without code changes. Olist was the first concrete substrate; Synthetic was the second. The in-process Synthetic adapter turned out to be a cleaner shape for the same job: no network, no rate limit, deterministic seeding, no auth dance.
>
> Retiring Olist was an honest 'we tried this, learned, picked better' call — not a failure. The seam is what mattered, and the seam survived the swap. If I'd kept Olist around alongside Synthetic, the codebase would have two substrates doing the same job — drift risk, double maintenance, no upside."

### Follow-up: "Wasn't that wasted work?"

> "No — the work proved the seam was real. If I'd never built Olist, the `DataSource` abstraction would just be a TypeScript interface with one implementation. With Olist as the first concrete substrate and Synthetic as the second, the seam is *demonstrated* — and the eval suite history proves it ran against both. The work earned its keep before retirement."

### Follow-up: "What would have changed your mind about retiring it?"

> "If Olist had production-grade reliability and Synthetic was the toy, the call flips. But the alpha MCP server had rate limits and token revocation that made it actively painful for evals. The deciding factor was: which substrate is more useful for what the eval suite needs to do? Synthetic wins on every axis except realism, and for eval purposes determinism beats realism."

---

## Probe 3 — "Why migrate from your own agent loop to AptKit?"

### The reviewer's intent

This is the L3/L5 sorting probe on architecture decisions. They want to know if you'll defend the hand-rolled loop (L3 risk: stubborn) or admit you should have used a library from the start (L2 risk: indecisive). The L5 answer is neither.

### Do NOT say

> "The hand-rolled loop was getting unwieldy."

This is L3 — reactive change driven by maintenance pain. It sounds like you didn't plan well.

> "AptKit just had better features."

This is L4 — feature-driven change. It sounds like you migrated because something shinier appeared.

### The L5 answer

> "I started by owning the loop on purpose. Two specific constraints made that the right call at the time: the rate-limited Bloomreach MCP server demanded a hard `maxToolCalls` budget, and the forced final synthesis turn was a project-specific contract — when the agent runs out of tool calls it needs one more turn with no tools to produce a final answer. Neither fit a library shape cleanly in Phase 1.
>
> By Phase 4, AptKit 0.3.0 had shipped a clean generic-primitive surface — the constraints I'd been carrying manually fit its abstractions. I revisited the decision and migrated via three Blooming adapter classes. The library owns the loop now; I own the boundary. The legacy implementation is preserved at `base-legacy.ts` as a rollback receipt.
>
> This is the most consequential decision I revisited on the project. The shape of the answer is *evaluated and accepted* — I defended the hand-rolled loop, then revisited it when the conditions changed, then migrated with discipline. Not 'I gave up,' not 'I should have used AptKit from the start' — both of those would be wrong."

### Follow-up: "Why keep `base-legacy.ts`? Isn't that dead code?"

> "It's a rollback receipt, not dead code. Two reasons it stays: first, if the AptKit adapter ever breaks under a model upgrade or library change, I have a working fallback I've already tested. Second, it documents the migration — anyone reading the codebase can see exactly what the loop looked like before and after, and what the adapters had to bridge. Deleting it would erase the evidence that the migration was disciplined."

### Follow-up: "Why three adapter classes? Isn't that overkill?"

> "Three because there are three boundaries to cross: the tool surface (Blooming's `ToolCall` shape vs AptKit's), the streaming event surface (the `AgentEvent` NDJSON contract vs AptKit's events), and the budget/synthesis contract (the `maxToolCalls` + forced-synthesis turn that AptKit doesn't enforce). Each class owns one boundary. Fewer classes would have meant one bloated adapter; more would have been theater."

---

## Probe 4 — "What's the eval gap NOW?"

### The reviewer's intent

They've heard the Phase 3 story. They're testing whether you'll deflect ("we have plans") or own the current state honestly. The L5 move is owning it AND naming the rebuild without flinching.

### Do NOT say

> "We're going to rebuild the eval suite soon."

L2. Sounds like a promise without a plan.

> "The eval suite still exists in a branch."

If it's not running, it doesn't count. Don't claim infrastructure that isn't live.

### The L5 answer

> "Same as before Phase 3 in terms of live measurement — eyeballing the trace. But I have three receipts the pre-Phase-3 state didn't:
>
> 1. I've built the suite end-to-end, so I know the shape. Four pillars, K=10 per anomaly, LLM-as-judge with manual-spot-check calibration. Not a hypothesis.
> 2. I've used it to find three named bugs no unit test would catch — BRL units, binary calibration breakdown, conclusion instability. Proof the harness was useful, not just present.
> 3. I know what the next version looks like — same four pillars against the in-process Synthetic adapter, same calibration discipline. The substrate is already in the repo.
>
> The honest framing: today is eyeballing. Last quarter was a measured pipeline. Next quarter is a rebuild against Synthetic. The gap is real; it's not 'we plan to add evals,' it's 'we measured, learned, retired with substrate, rebuilding next.'"

### Follow-up: "Why hasn't the rebuild happened yet?"

> "Two reasons, named honestly: first, the Synthetic adapter is newer than the Olist substrate was — it needs to stabilize before I can build seeded ground-truth anomalies against it that won't change shape every week. Second, this is a portfolio project, not a funded product, and the next priority slice has been UI polish and the migration story. The rebuild is a real next step, not infinitely deferred — the substrate exists, the pillar designs are documented, the calibration discipline is known."

### Follow-up: "If I gave you a week, what's the first pillar you'd rebuild?"

> "Detection. Two reasons: it's the easiest to seed ground truth for (Synthetic adapter lets me inject anomalies deterministically), and it's the pillar that produced the cleanest signal in Phase 3 (8/8 manual-judge agreement). Starting there means I can prove the rebuild approach works on a known-good case before tackling the harder pillars."

---

## The general principle — pre-mortem is a senior skill

```
  The shape of a skeptical-question rehearsal

  step 1: identify the 3-4 questions a reviewer is most
          likely to ask
  step 2: rank them by interview damage (which one breaks
          the conversation if mishandled?)
  step 3: write the do-NOT-say version first (what most
          candidates would say)
  step 4: write the L5 version (lead with answer, rank
          what carries weight, name the receipts)
  step 5: write 1-2 follow-ups per probe (the second-
          layer question that catches a weak answer)

  this whole chapter IS the pre-mortem.
```

A pre-mortem is what separates a candidate who can talk about their project from one who's *defended* their project. The defense moves are: lead with the answer, never hedge, name receipts (not aspirations), and welcome the second-layer follow-up because you've already thought through it.

---

## The single highest-leverage line in this brief

If you only get to land one sentence, land this one:

> *"I shipped the eval suite, calibrated it against manual spot-check at 8/8 and 3/3, used it to find three named bugs, and retired it with the substrate it scored against — the receipt of having done that is stronger than promising to do it."*

That sentence is the whole problem-selection brief in one breath. It proves you can scope, you can ship, you can measure, you can retire, and you can name what comes next. Five senior signals in one line.

---

## See also

- `00-overview.md` — the bundle map
- `01-problem-brief.md` — the problem these probes are defending against
- `02-scope-cuts-and-non-goals.md` — Cut 2 (eval) is the source of Probe 1 + Probe 4 receipts
- `03-options-and-opportunity-cost.md` — Decision 2 (AptKit migration) is the source of Probe 3 answer
- `04-success-metrics-and-feedback-loop.md` — the numbers behind Probe 1's answer
- `.aipe/rehearse-interview-defense/` — the technical-decision sister rehearsal
- `.aipe/rehearse-design-doc/` — the written-artifact sister rehearsal
