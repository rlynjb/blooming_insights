# 02 — Scope cuts and non-goals

**Industry name:** Non-goals / explicit scope cuts — Coach posture

The chapter that carries the most interview leverage. Anyone can list what they built. A staff-level candidate names what they **didn't build** and defends the cut without flinching.

Three cuts. Cut 2 is the L5 story.

---

## Zoom out — the cuts on a timeline

```
  Three cuts, three different shapes

  ┌─ Cut 1: no live BigQuery / no production data warehouse ─┐
  │  Phase 1 decision, still in force                        │
  │  → fakes for the seam, MCP for the real workspace        │
  │  shape: principled boundary — kept                       │
  └──────────────────────────────────────────────────────────┘

  ┌─ Cut 2: eval pipeline ───────────────────────────────────┐
  │  Phase 1: cut (hackathon scope)                          │
  │  Phase 3: BUILT IT ANYWAY — 4 pillars, calibrated        │
  │  Phase 4: RETIRED with the Olist substrate (PR #8)       │
  │  shape: cut → revisited → shipped → retired (L5)         │
  │  ★ STRONGEST DEFENSIBLE STORY IN THIS BRIEF ★            │
  └──────────────────────────────────────────────────────────┘

  ┌─ Cut 3: no persistent storage / no database ─────────────┐
  │  Phase 1 decision, still in force                        │
  │  → in-memory maps + gitignored JSON in dev               │
  │  shape: scope discipline — appropriate                   │
  └──────────────────────────────────────────────────────────┘
```

---

## Cut 1 — No live BigQuery / no production data warehouse

**The cut:** the agent does not read from a customer data warehouse. It reads from a Bloomreach workspace via MCP, and in tests it reads from injected fakes.

**Why:** the product is "an analyst on top of Bloomreach Engagement," not "an analyst on top of arbitrary data." Adding a BigQuery adapter would:
1. Double the surface area of the data layer (two adapters, two schemas, two failure modes).
2. Force a decision about *which workspace's BigQuery* — and there's no clear answer for a portfolio project.
3. Distract from the differentiator. The product's pitch is "shows its work" — the work is showing reasoning over Bloomreach tools, not showing data warehouse SQL.

**Would I cut it again?** Yes. The Bloomreach MCP server is the substrate that makes this product *concrete*. Generalizing too early would have produced a worse product faster.

**Coach line:** *"I scoped to one data source on purpose. The product is about the analyst loop, not the data adapter; making it MCP-only made the rest of the design sharper."*

---

## Cut 2 — The eval pipeline (the L5 story)

This is the chapter you rehearse hardest. It's three acts.

### Act 1 — Phase 1: cut it

**The original cut:** no eval pipeline. Hackathon scope. Ship the agent loop first.

The rationale at the time was correct: with three engineer-weeks, building the agent loop + the MCP integration + the streaming UI was already the maximum scope. Adding an eval harness would have meant shipping nothing.

This is L2 territory if you stop here — "I know evals matter, I didn't have time." Most candidates say exactly that. It's defensible but not impressive.

### Act 2 — Phase 3: shipped it anyway

**The revisit:** in Phase 3, I built the eval pipeline. Four pillars:

```
  The eval suite (Phase 3) — what got shipped

  ┌─ Pillar 1: Detection ─────────────────────────────────┐
  │  K=10 runs per anomaly; precision/recall over a       │
  │  ground-truth set of seeded anomalies in Olist        │
  └───────────────────────────────────────────────────────┘

  ┌─ Pillar 2: Diagnosis ─────────────────────────────────┐
  │  5-criterion rubric, LLM-as-judge scores each         │
  │  diagnosis run; pass rate over K=10                   │
  └───────────────────────────────────────────────────────┘

  ┌─ Pillar 3: Recommendation ────────────────────────────┐
  │  3-criterion rubric (action fits problem,             │
  │  steps actionable, impact named); pass rate over K=10 │
  └───────────────────────────────────────────────────────┘

  ┌─ Pillar 4: Regression ────────────────────────────────┐
  │  capture-and-score: structural diff of agent outputs  │
  │  across versions + LLM similarity judge               │
  └───────────────────────────────────────────────────────┘

  Calibration discipline:
  → manual spot-check vs LLM-judge agreement
  → 8/8 on detection, 3/3 on diagnosis
  → proves the judge isn't rubber-stamping
```

K=10 per anomaly. LLM-as-judge calibrated against manual spot-check: **8/8 agreement on detection, 3/3 on diagnosis.** That calibration is the load-bearing part — without it, the judge could be lying and you wouldn't know.

### Act 3 — Phase 4: retired it

When the Olist MCP server (the substrate the eval suite scored against) was retired (PR #8 / 2026-06-18), the eval suite went with it. The in-process Synthetic adapter is a cleaner shape for the same job, and rebuilding the eval pillars against Synthetic is the named next step — not a vague "we should add evals."

### Why this is the L5 story

```
  The L-ladder for "evals in your project"

  L1: "Evals? What do you mean?"          ← didn't think about it
  L2: "I didn't have time for evals."     ← knows they matter, didn't ship
  L3: "I planned for evals but cut them." ← named the cut, no receipts
  L4: "I built evals on a small sample."  ← shipped a partial version
  L5: "I cut, then built the full suite,  ← shipped, learned, made a call
      calibrated it, used it to find
      real bugs, then retired with the
      substrate and named the rebuild."   ← THIS PROJECT
```

The L5 framing is not "we built evals." It's:

1. **Cut deliberately** (Phase 1) — with a stated reason.
2. **Revisited the cut** (Phase 3) — when the agent loop was stable.
3. **Built the full suite** — 4 pillars, K=10 per anomaly.
4. **Calibrated the judge** — 8/8 + 3/3 manual spot-check.
5. **Used it to find real bugs** — three named:
   - **BRL units bug** — the judge caught a R$131,965 AOV at run 8 as implausible; turned out the prompt was reading Brazilian cents as Reais (100x error). No unit test would have caught this; it took an LLM judge with business plausibility context.
   - **Binary calibration breakdown** — 29 of 30 diagnosis runs were getting a binary pass/fail when the actual quality varied; the rubric was too coarse. Forced a redesign of the diagnosis criteria.
   - **Conclusion instability** — across K=10 runs, the diagnosis conclusion varied by ~30%. That became the regression baseline ("if a change moves us above 30%, we've regressed"), not a bug to suppress.
6. **Retired the suite with the substrate** — when Olist went, the suite went. Honest call: don't keep dead infrastructure around to look thorough.
7. **Named the rebuild target** — Synthetic adapter, same four pillars, same calibration discipline.

**Coach line:** *"Today I don't have a live eval harness. But I've built one end-to-end, calibrated it against manual spot-check, used it to surface three named bugs no unit test would catch, and made an honest call to retire it with the substrate it scored against. The next version is named — same four pillars against Synthetic. That receipt is stronger than promising to build it."*

That's the L5 move: **shipped → learned → made a call.** Not "we plan to" (L1 weakness). Not "I didn't have time" (L2). Not even "I built it" (L3-L4). The full arc.

---

## Cut 3 — No persistent storage / no database

**The cut:** no Postgres, no Supabase, no Redis. State lives in in-memory `Map`s in the agent routes; in dev, auth and investigations persist to gitignored JSON (`.auth-cache.json`, `.investigation-cache.json`); committed demo snapshots in `lib/state/demo-*.json`.

**Why:**
- The product is *session-scoped*: an analyst opens it, runs a briefing, investigates one anomaly, gets a recommendation, closes the tab. No multi-user shared state.
- Adding a database means choosing one (Postgres? SQLite? Supabase?), migrating schema as `Insight` / `Anomaly` / `Diagnosis` evolve, and managing auth-to-row mappings. None of that earns its keep at portfolio scope.
- The demo snapshot in `lib/state/demo-*.json` is the reliable presentation path; persistent storage would not improve it.

**What this would change at scale** (named honestly):
- Multi-user collaboration (two analysts on the same anomaly) — requires shared storage.
- Historical comparisons (this week's anomalies vs last quarter's) — requires durable history.
- Audit logging for compliance — requires immutable storage.

None of those are in scope. Naming them tells the reviewer I know what would trigger the migration.

**Coach line:** *"No database on purpose. The product is session-scoped — open, briefing, investigate, recommend, done. Adding Postgres would have meant schema migrations every time `Diagnosis` got a new field. In-memory + gitignored JSON in dev + a committed demo snapshot is the right shape for what this is."*

---

## What this chapter teaches the reviewer

```
  The signal each cut sends

  ┌─ Cut 1 (BigQuery)  ────────────────────────────────┐
  │  signal: "I can resist the urge to generalize"     │
  └────────────────────────────────────────────────────┘

  ┌─ Cut 2 (eval pipeline) ★ ──────────────────────────┐
  │  signal: "I can cut, revisit, ship, learn, and     │
  │  retire — without inflating the receipts"          │
  │  ★ THE L5 SIGNAL ★                                 │
  └────────────────────────────────────────────────────┘

  ┌─ Cut 3 (no database) ──────────────────────────────┐
  │  signal: "I know what triggers a storage decision  │
  │  and this product isn't at that trigger"           │
  └────────────────────────────────────────────────────┘
```

The takeaway: **scope cuts are a senior signal when they come with a story.** A flat list of non-goals ("no eval, no DB, no BigQuery") teaches the reviewer nothing. Three cuts with three different shapes — principled boundary, full lifecycle, scope discipline — teaches that the engineer thought about each one separately and made a different kind of call each time.

---

## See also

- `01-problem-brief.md` — the scope this is cutting against
- `03-options-and-opportunity-cost.md` — what got built *instead* of these
- `04-success-metrics-and-feedback-loop.md` — the eval numbers from Phase 3 (Cut 2's receipts)
- `05-skeptical-reviewer-questions.md` — "how do you know any of this is good?" answer
- `.aipe/audit-refactor-eval-substrate/` — the historical refactor that retired the eval substrate
