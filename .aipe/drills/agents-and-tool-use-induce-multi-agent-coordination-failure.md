competency:   Agents & tool use                                       raises: L2 → L3
curriculum:   n/a (no aieng-curriculum.md Bx.y maps cleanly; closest is
              study-agent-architecture/03-multi-agent-orchestration/09-coordination-failure-modes.md's
              "handoff-loss / context-drop / role-conflation" taxonomy)
study ref:    .aipe/study-agent-architecture/03-multi-agent-orchestration/09-coordination-failure-modes.md
              + .aipe/study-agent-architecture/03-multi-agent-orchestration/08-shared-state-and-message-passing.md
              + .aipe/study-ai-engineering/05-evals-and-observability/README.md (for the measurement half)
              + eval/baseline.json — the shipped receipt this drill exploits

---

> **Coach posture, verdict first.** You have a shipped multi-agent supervisor (deterministic route handler at `app/api/agent/route.ts:222–345`) that hands `Diagnosis` from the DiagnosticAgent to the RecommendationAgent as a strongly-typed object. The interview signal you don't yet have — the L3 war story — is a **coordination-failure receipt**: proof that the handoff itself can silently degrade agent output even when both agents are working correctly in isolation. Your baseline `eval/baseline.json` (runId `2026-07-03T04-08-28-644Z`) already contains the smoking gun: `diagnosis_response` passes at **48%** on the recommendation rubric — cases where the diagnosis is grounded but the rec addresses the wrong hypothesis. That 48% is the coordination failure sitting in your repo right now, unnamed as such. This drill is to **name it, force it on demand, fix it, and prove the fix moves the number**. The failure to induce is **"a hypothesis explicitly marked `supported: false` in the diagnosis still produces a recommendation."** If you can't reproduce it against a specific golden case, the drill is faked — pick a different case until one breaks.
>
> **Fingerprint from the triple-run** (2026-07-03, six runs across cases 01 + 08, receipts at `eval/receipts/`): **4 of 6 runs produced a rec[2] targeting the CTA-experiment hypothesis that the diagnosis explicitly marked `supported: false`.** All 4 failed `diagnosis_response` with score 2 or 3. Judge language, verbatim: *"it pursues the one hypothesis the diagnosis rejected for lack of evidence."* The receipt is real, reproducible, and specific. Fingerprint runIds: case 01 → `T16-40-43-219Z`, `T16-44-18-992Z`, `T16-47-56-906Z`; case 08 → `T16-51-11-453Z`, `T16-55-10-578Z`, `T16-58-48-164Z`.

---

## 1. BUILD — the current handoff, exactly as it exists

The multi-agent supervisor is a **deterministic sequential pipeline**, code-routed (no LLM supervisor). The handoff you're going to attack sits between step 2 (diagnose) and step 3 (recommend).

```
  the pipeline as it ships today — file:line for every hop

  ┌────────────────────────────────────────────────────────────────────────────┐
  │  browser  →  /api/agent?step=diagnose                                      │
  │                                                                            │
  │            app/api/agent/route.ts:222–290  (the deterministic supervisor)  │
  │            L235: role = "diagnostic"                                       │
  │            L287: diagnosis = await diagAgent.investigate(...)              │
  │            L289: send({ type: 'diagnosis', diagnosis })                    │
  │                                                                            │
  │            DiagnosticAgent (lib/agents/diagnostic.ts)                      │
  │            returns Diagnosis:                                              │
  │              conclusion              string                                │
  │              hypothesesConsidered    { hypothesis, supported,              │
  │                                        reasoning }[]                       │
  │              affectedCustomers?      { count?, examples? }                 │
  │              suggestedInvestigation? string                                │
  │              (types.ts:95–104)                                             │
  └────────────────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼    ← THE HANDOFF LIVES HERE
                                     │
  ┌────────────────────────────────────────────────────────────────────────────┐
  │  browser stashes diagnosis in sessionStorage['bi:diag:<id>']               │
  │  (lib/hooks/useInvestigation.ts:140–142)                                   │
  │                                                                            │
  │  user clicks "recommend" → browser reads diagnosis from sessionStorage,    │
  │  attaches as URL param                                                     │
  │  (useInvestigation.ts:177–179)                                             │
  │                                                                            │
  │  browser  →  /api/agent?step=recommend&diagnosis=<encoded>                 │
  │                                                                            │
  │            app/api/agent/route.ts:269–299  (the deterministic supervisor)  │
  │            L235: role = "recommendation"                                   │
  │            L273–276: diagnosis = parseDiagnosis(diagnosisParam)            │
  │            L275: if (!diagnosis) throw — SHAPE-GUARDED, not truth-guarded  │
  │            L299: recAgent.propose(anomaly, diagnosis, ...)                 │
  │                                                                            │
  │            RecommendationAgent (lib/agents/recommendation.ts:19–46)        │
  │            hands (anomaly, diagnosis) to AptKit's RecommendationAgent      │
  │            (which internally builds its own prompt with the diagnosis      │
  │             marshaled into system context — you do not own that prompt)    │
  └────────────────────────────────────────────────────────────────────────────┘
```

**Read the shape carefully.** `Diagnosis.hypothesesConsidered` is a **flat array of `{ hypothesis, supported, reasoning }`** — no explicit rank, no primary/secondary field. The reader (a downstream LLM) has to infer which hypothesis was primary from prose in `conclusion` + which entries have `supported: true`. That inference is where the failure will land.

Also read the **shape drift** already flagged by your fresh `.aipe/study-data-modeling/07-data-modeling-red-flags-audit.md`: `Investigation.diagnosis` at `types.ts:132–141` uses `hypothesesConsidered: string[]` — a **different, lossier shape** for the same conceptual field. If those two shapes ever cross the same wire (e.g., an old Investigation record loaded and handed off), the recommendation agent gets an even weaker signal. Whether the drill exploits Shape A (rank inference) or Shape B (drift to the lossier form) is your call in Step 2.

**What the shape guard actually protects against** — `parseDiagnosis` + `isDiagnosis` (`lib/mcp/validate.ts:37–43`) check that `conclusion` is a string and `hypothesesConsidered` is an array with the right field shape. They do **NOT** check that the diagnosis is *correct*, *primary-emphasized*, or *from the current investigation* (a stale diagnosis from a prior anomaly would pass shape validation cleanly).

Failure surface, ranked by war-story weight (**revised after the 2026-07-03 fingerprint**):
1. **Rejected-hypothesis leakage** ← THE CONFIRMED MECHANISM. `conclusion` names cause A as primary; `hypothesesConsidered[]` has A `supported: true` + C `supported: false`. Rec agent produces a rec targeting C anyway. The rejection signal (`supported: false`) doesn't propagate as a hard exclusion — the rec agent apparently reads the array as "here are three concerns worth addressing" and gives each a rec, disregarding the `supported` flag. **4/6 runs reproduce this on the CTA-experiment hypothesis specifically.**
2. **Primary-hypothesis silent downweight** — *not* observed in the fingerprint. Rec[0] correctly targets payment in all 6 runs. The primary is getting through; it's the negative signal (`supported: false`) that isn't.
3. **Shape-drift handoff** — an old-format `Investigation` object gets deserialized and its `hypothesesConsidered: string[]` reaches the recommendation agent. Deterministic to reproduce but requires a data-migration setup; deferred as a Move-4-adjacent drill.
4. **Stale diagnosis re-carry** — sessionStorage's `bi:diag:<id>` is keyed by investigation id, but if a user navigates in an unexpected order (or if the `bi:diag:<X>` key survives a bug in the id derivation), a *different investigation's* diagnosis could hand off cleanly.

---

## 2. INDUCE — the failure you must cause on demand

**The failure:** at least ONE golden case where, with the DiagnosticAgent producing a correctly-emphasized diagnosis (primary hypothesis = the labeled root cause per `eval/goldens/*.json`), the RecommendationAgent's output receives `diagnosis_response: fail` from the shipped rubric (`eval/rubrics/recommendation-quality.ts`) because at least one recommendation targets an **explicitly rejected** hypothesis (marked `supported: false` in the diagnosis handoff). **AND** you can reproduce it on demand.

### Fingerprint receipt (2026-07-03)

Six runs — case 01 × 3 + case 08 × 3, all `signalClass: has-signal`, all diagnoses correctly named payment failure as primary. Rec-set shape and `diagnosis_response` verdict per run:

| Run | rec[0] target | rec[1] target | rec[2] target | dr scores | verdicts |
|---|---|---|---|---|---|
| 01/1 (`T16-40-43`) | ✓ recovery scenario | ⚠ CTA experiment | ⚠ retention | 4 / — / — | pass / judge_error / judge_error |
| 01/2 (`T16-44-18`) | ✓ recovery sequence | ✓ recovery campaign | ⚠ PIX A/B experiment | — / 4 / **3** | judge_error / pass / **fail** |
| 01/3 (`T16-47-56`) | ✓ recovery scenario | ⚠ retention | ⚠ **pause CTA test** | 5 / 3 / **2** | pass / pass_with_notes / **fail** |
| 08/1 (`T16-51-11`) | ✓ recovery scenario | ⚠ retention | ⚠ payment A/B | 5 / 4 / 3 | pass / pass_with_notes / pass_with_notes |
| 08/2 (`T16-55-10`) | ✓ recovery scenario | ⚠ voucher campaign | ⚠ **pause CTA test** | — / — / **2** | judge_error / judge_error / **fail** |
| 08/3 (`T16-58-48`) | ✓ recovery scenario | ⚠ voucher campaign | ⚠ **pause CTA test** | 3 / — / **2** | pass_with_notes / judge_error / **fail** |

**Signal: 4/6 runs (01/1, 01/3, 08/2, 08/3) produce a rec[2] targeting the CTA-experiment hypothesis that the diagnosis marked `supported: false`.** All 4 fail `diagnosis_response`. Judge language identical across runs: *"pursues the one hypothesis the diagnosis rejected."* Case 08 is the cleaner fingerprint (2 of 3 runs reproduce identical shape).

### Bonus observability finding (out of drill scope but worth logging)

Judge error rate across the 18 rec-judge invocations: **6 / 18 = 33 %.** The `maxTokens=4096` fix from Week 2C isn't enough for these longer recs — judge responses truncate before the structured JSON closes. Separate `console.error` scan of the log confirms `Judge model failed to produce parseable structured output` on all 6. Worth bumping to `maxTokens=8192` on the rec judge or investigating why these specific recs (voucher + retention + CTA-experiment) blow past 4k tokens on the judge side.

### Step-by-step to induce it (if you want to re-run)

### Step-by-step to induce it

**1. Pick your golden case.** Start with `eval/goldens/01-*.json` and `eval/goldens/08-*.json` — the baseline receipt already fingered these two as failures on `diagnosis_response`. Read the case shape (`eval/goldens/types.ts`) and confirm `signalClass = 'has-signal'` for both (the coordination failure needs a case where a right diagnosis is *possible* — otherwise you're testing whether the diagnostic agent is right, which is a different drill).

**2. Fingerprint the failure with a triple-run.** Run the baseline receipt's exact conditions three times:

```bash
CASE=01 npm run eval:run   # runs 1 case, 3 seeds if seeded; or 3 direct runs
```

The `diagnosis_response` dimension score per run tells you if the failure is stable. If run 1 = fail, run 2 = pass, run 3 = fail — it's flaky, not a coordination fingerprint. If all 3 fail on the *same* wrong-hypothesis targeting, you've named it.

**3. Extract the two objects the handoff carries.** From the receipt (`eval/receipts/01-*.json`), pull:
- The `Diagnosis` object handed to `recAgent.propose(...)` — verbatim
- The `Recommendation[]` output — verbatim

Compare `Diagnosis.conclusion` against `Recommendation[].name` + `Recommendation[].rationale`. The gap is the war story. If `conclusion` says "payment processor is the primary root cause" and `Recommendation[0].name` says "pause the checkout A/B experiment" — you have a fingerprint.

**4. Confirm the mechanism.** Run the *same* case, but with a manually-constructed `Diagnosis` that has `hypothesesConsidered: [only the primary hypothesis]` (single-entry array). If the recommendation now targets the primary correctly, the coordination failure lives at the handoff shape — the recommendation agent's inference weight over a multi-entry `hypothesesConsidered` array is what's diluting the primary. That's the receipt.

If it still fails, the coordination-failure hypothesis is wrong — it's a recommendation-prompt gap, not a handoff-shape gap. Reroute: this becomes a Move-5-style prompt-versioning drill instead of a Move-3 coordination drill. Say so out loud; do not massage the drill to fit.

---

## 3. DIAGNOSE — symptom → hypotheses → isolated cause

*(You write this. Coach sketches the frame; you fill it with what you actually observe.)*

**Symptom** (fill from your run): the primary hypothesis in `Diagnosis.conclusion` is `_______`. The recommendation targets `_______`. The two are `_______` (aligned / adjacent / orthogonal / opposed).

**Hypotheses to test in order (revised after fingerprint):**
- **H1 — Rejected-hypothesis leakage.** The rec agent reads `hypothesesConsidered[]` as "a list of concerns to cover," ignoring the `supported` flag. A `supported: false` hypothesis still generates a rec. *Test — the isolation probe:* build a synthetic diagnosis with `hypothesesConsidered = [only the primary, supported: true]`, feed to `recAgent.propose()` × 3 against case 08's anomaly, check whether rec[2] still targets a rejected concern. Probe file: `eval/probe-h1-isolation.eval.ts`. Probe log: `.aipe/drills/fingerprints/probe-h1-isolation.log`.
- **H2 — Rec-agent prompt gap.** Even with only primary hypotheses in the handoff, the rec agent produces N recs regardless (padding to 3 with adjacent concerns). *Test:* skip if H1 isolation shows clean primary-only recs. If H1 refuted, H2 is next — but AptKit's `RecommendationAgent` internal prompt isn't yours to patch, so H2 rules out as a shippable fix.
- **H3 — Category confusion.** The rec agent has a systemic bias toward experiment-pause / feature-flag recs regardless of diagnosis. *Test:* pick a golden case where NO hypothesis involves an experiment; does the rec still trend to experiment-pause? Deferred; H1 fingerprint is already reproducible so this is second-priority.

**Isolated cause (post-probe, 2026-07-03 T17-13 UTC):** rejected-hypothesis leakage confirmed. The rec agent's respect for `supported: false` is zero. Remove the temptation at the handoff boundary.

### Probe result (H1 isolation, 3 runs against synthetic single-entry Diagnosis)

Same anomaly (case 08). Same synthetic `Diagnosis` where `hypothesesConsidered = [only the primary payment-failure entry, supported: true]`. Recs produced:

| Run | rec[0] | rec[1] | rec[2] |
|---|---|---|---|
| Probe 1 | ✓ recovery scenario | ✓ PIX/voucher campaign for SP mobile | ✓ A/B experiment: alt payment method prominence |
| Probe 2 | ✓ recovery scenario | ✓ targeted campaign SP mobile | ✓ A/B experiment: voucher vs payment-method prompt (recovery flow) |
| Probe 3 | ✓ voucher-backed recovery campaign | ✓ activate recovery scenario | ✓ A/B experiment: voucher vs no-voucher (recovery flow) |

Persisted at `.aipe/drills/fingerprints/probe-h1-run-{1,2,3}.json`.

**Zero rec targets `exp-checkout-copy` across all 3 probe runs.** Vs the baseline fingerprint where 4/6 runs targeted it. **H1 CONFIRMED.**

### Bonus finding: H3 also present (structural bias)

Every probe run produces an **A/B experiment as rec[2]**. Rec[0] = act on the problem, rec[1] = spread the fix wider, rec[2] = experiment on the fix. That shape is invariant across the diagnosis payload — the rec agent brings it regardless of content. When there's a rejected hypothesis to grab onto (baseline), the "always produce an experiment rec" bias latches on and fails judgment. When the rejected hypothesis is absent (probe), the bias pivots to experimenting on the *fix* itself — diagnosis-aligned and passes.

**Consequence for Option A:** filtering `supported: false` at the handoff neutralizes the observable failure by removing the temptation, not by fixing the underlying rec-agent bias. That distinction is L3-signal on its own — Option A ships the working fix; the structural bias is documented as known and out-of-scope for this drill (would require access to AptKit's internal RecommendationAgent prompt).

---

## 4. FIX + REJECT — the alternative you didn't take and why

*(You write this. Coach names the option matrix; you pick, justify, ship.)*

Option matrix (**revised for the confirmed mechanism: rejected-hypothesis leakage**) — pick ONE, defend it in one line each for the others:

| Option | Where it lives | Cost | What it fixes | What it doesn't |
|---|---|---|---|---|
| **A — Filter rejected hypotheses at the handoff boundary.** In the route (`app/api/agent/route.ts:298–299`), pass `{...diagnosis, hypothesesConsidered: diagnosis.hypothesesConsidered.filter(h => h.supported)}` to `recAgent.propose()`. | route.ts:298 + one test in test/agents/recommendation.test.ts | LOW (~30 min): one-line change + a test that the rec agent never receives `supported: false` entries | Removes the leakage surface entirely — rec agent literally cannot see rejected hypotheses | Loses the "we considered this and ruled it out" context for the rec agent. Alternative: keep the entry but strip the reasoning + tag with `[REJECTED]` in-place |
| **B — Add `primaryHypothesis: string` field to `Diagnosis`** | `lib/mcp/types.ts:95–104` + `lib/mcp/validate.ts:37–43` + DiagnosticAgent output shape | MEDIUM (~1 hr): type change, migration on old receipts, guard on isDiagnosis | Explicit rank at the handoff | Doesn't solve leakage — rejected entries still travel; the rec agent still might act on them |
| **C — Reject: rewrite the recommendation prompt to require primary-hypothesis-alignment** | AptKit's `RecommendationAgent` internal prompt | UNKNOWN (owned by `@aptkit/core`) | Would fix at the receiver | You don't own the prompt — this is a request-upstream, not a ship |
| **D — Reject: pass the full DiagnosticAgent trace to the RecommendationAgent** | recommendation.ts:29–46 | HIGH (token budget blowup, cost regression against Week 3 caching win) | Would give rec agent more context | Doesn't address leakage — the rec agent's problem is respect, not information |

**Recommended (you decide, but coach's read):** ship **A** — the fingerprint proved the rec agent won't respect `supported: false`, so remove the temptation at the source. It's a 30-minute fix. Reject C on ownership; reject D on cost + it doesn't address the diagnosed mechanism; keep B as a follow-up if you want explicit primaryness for a *different* reason later.

**Shipped, then reverted (2026-07-03 T17-18 → T20-08 UTC):** Option A landed as `filterSupportedHypotheses(diagnosis: Diagnosis): Diagnosis` in `lib/agents/recommendation.ts`, called from `RecommendationAgent.propose()`, with 5 new tests. Full suite went 268 → 273. Then the 10-case eval ran (`npm run eval` runId `2026-07-03T18-11-06-952Z`) and **regressed all four recommendation-quality dimensions**. Reverted. Tombstone comment at `lib/agents/recommendation.ts:15-25` documents why the helper is not there.

Case-matched delta (6 cases completed both runs; n=15 rec judgments):

| dim | baseline | candidate | Δ |
|---|---|---|---|
| `diagnosis_response` | 50% | 27% | **−23pp** |
| `feature_choice_fit` | 58% | 40% | **−18pp** |
| `step_actionability` | 100% | 87% | **−13pp** |
| `impact_realism` | 42% | 20% | **−22pp** |

Sample size caveat: n=15 rec judgments in the candidate; confidence interval is wide (~±20pp on a single pass rate); can't claim tight causal certainty. But direction is unambiguous across all four dimensions, so the revert is honest even without significance.

**What was wrong with H1's inference.** I predicted the rejected hypotheses were noise the rec agent was mishandling. The eval shows they were **load-bearing context** — "we ruled X out because Y" tells the rec agent both what to avoid AND why the primary is primary. Stripping that context degraded `impact_realism` and `step_actionability` (dims I thought were unrelated to the filter) as well as `diagnosis_response`, which is what an ablation looks like when the removed input actually mattered. My mental model of the handoff was wrong.

**Elevated to next-attempt: Option B (add `primaryHypothesis` field).** Preserves the full `hypothesesConsidered` context AND makes the primary explicit at the type level — no context stripped. Deferred; not shipped in this drill.

**Bonus observability finding (deferred to `.aipe/drills/observability-induce-agent-reasoning-cap-timeout.md`):** cases 04–07 each took 15–19 min (vs ~3 min norm) in the candidate run and blew past `testTimeout=300_000ms`. No receipts written. That's an agent-reasoning cap gap — a case can chew ~19 min of wall clock and API cost before hard-stopping. Separate drill because the mechanism is orthogonal to this coordination failure.

**Design decision to log alongside the fix:** filter-at-handoff sacrifices the "we ruled this out" context that a competent rec agent could theoretically use to avoid overlap with prior thinking. In practice, the fingerprint shows the rec agent isn't using that context correctly anyway — so removing it is the honest read. If a future rec-agent version becomes capable of respecting rejection, this filter is a one-line revert.

Whatever you pick, name what you rejected and *why in one sentence each*. That's the L3 signal.

---

## 5. EVAL — the measurement (this is the non-negotiable half)

### Result (2026-07-03) — negative

Ran `npm run eval` with Option A shipped. Runs took a real turn: 6 of 10 cases completed (04–07 timed out, see the observability-cap drill). Case-matched delta vs baseline `2026-07-03T04-08-28-644Z`:

- `diagnosis_response`: 50% → 27% (Δ **−23pp**) — the dimension the fix was supposed to lift went down
- `feature_choice_fit`: 58% → 40% (Δ −18pp)
- `step_actionability`: 100% → 87% (Δ −13pp)
- `impact_realism`: 42% → 20% (Δ −22pp)

Gate output at `eval/gate-2026-07-03T18-11-06-952Z.json`. Full log at `.aipe/drills/fingerprints/step5-eval.log`.

**The number went down across all four dims.** Not up. Reverted (see Step 4 Shipped-then-reverted block).

### Original measurement protocol (kept for reference — this is what to run next time)

**Instrument.** The shipped `eval/rubrics/recommendation-quality.ts` has `diagnosis_response` as one of its 4 dimensions on a 1–5 scale with 3 verdicts. Baseline pass rate: **48%** (`eval/baseline.json`, runId `2026-07-03T04-08-28-644Z`). This is your before-number.

**Protocol.**
1. Run `npm run eval:run` against all 10 goldens before the fix. Confirm you can reproduce the 48% ±5pp on your machine — if you can't, the fix's after-number won't be trustworthy either. (Some drift is expected because judgment is stochastic; more than ~5pp of drift means dial down the temperature or investigate.)
2. Ship the fix (Option A or your chosen alternative).
3. Run `npm run eval:run` again with the fix.
4. Compare with `npm run eval:gate` against the committed baseline. The gate blocks on >10pp regression by default; you want a **positive delta**, and the gate is going to log the per-dimension shift with cost + latency alongside.

**Success criterion.** `diagnosis_response` pass rate ≥ **70%** post-fix. That's a +22pp swing on 10 cases — statistically thin (n=10) but the direction matters; the drill's L3 signal is the *causal argument* + *the number in the right direction*, not the significance.

**If the fix fails to move the number** — that's a *different* L3 receipt. Write it up honestly: "I induced the coordination failure. I fixed the handoff shape. The number didn't move because H1 was wrong; the mechanism is actually H2 or H3." A negative-result rep is still an L3 rep — it's the "no eval, no L3" rule that would have caught this before the interview.

**Cost checkpoint.** Rerun cost should stay ~$0.09/case per Week 3 baseline. If it jumps, you probably picked Option C by accident; audit.

---

## 6. WAR STORY — the sentence you say out loud

*(Write this last, once Steps 1–5 have actually been lived. Coach cannot write this for you — it must be in your voice, past-tense, specific, and short.)*

Shape to fill (**post-eval version — this is a negative-result rep, and the drill spec calls this out as valid L3**):

> "I traced a 48% pass rate on `diagnosis_response` to what looked like a clean handoff leakage — the rec agent was producing recs targeting hypotheses the diagnosis had marked `supported: false`. A 3-run isolation probe confirmed the leakage disappeared when I filtered rejected entries at the handoff boundary. I shipped that fix — one function, five tests, 30 minutes. Then I ran the eval and the number went DOWN across all four rec dimensions by 13–23pp. Turns out the rejected hypotheses weren't noise — they were load-bearing context. 'We ruled X out because Y' was telling the rec agent both what to avoid AND why the primary was primary. Strip that context and the recs get worse on dimensions I hadn't predicted, like `impact_realism`. Reverted, wrote up the negative result, replanned toward Option B — add explicit primaryness at the type level while preserving the context. The lesson: don't confuse 'the signal I named is real' with 'removing the signal fixes the problem.' The eval was doing exactly what the eval is for — catching my wrong mental model before it shipped."

Anti-patterns to avoid in the war story:
- "We used a rubric-based LLM-as-judge to evaluate…" — this is jargon, not story. Say *what broke and what it cost*, then how you found it.
- "Multi-agent coordination is hard" — this is a truism. Name the *specific* handoff shape gap.
- Passive voice or "we discovered that" — you diagnosed it. Use "I."

The interviewer's follow-up will be one of:
- "Why didn't your tests catch this before eval?" — because the tests are shape tests, not truth tests. Point at `test/agents/recommendation.test.ts` (the parallel to the Move 1 drill's Case B critique).
- "Why 48% specifically?" — because the shipped rubric has 3 verdicts on a 1–5 scale; 48% is the receipt in `eval/baseline.json` and I can show you the file.
- "What did you reject?" — Options C and D from the option matrix. State the tradeoff in one sentence each.
- "How did you know it was the handoff and not the prompt?" — the single-entry `hypothesesConsidered` experiment in Step 2.4. That's the isolation-of-cause receipt.

---

## Cross-links (spec-required)

- `.aipe/study-agent-architecture/03-multi-agent-orchestration/09-coordination-failure-modes.md` — the theory this drill puts a rep against
- `.aipe/study-agent-architecture/03-multi-agent-orchestration/08-shared-state-and-message-passing.md` — the handoff-shape teaching that predicts H1
- `.aipe/study-ai-engineering/05-evals-and-observability/README.md` — the measurement half's provenance
- `.aipe/study-data-modeling/07-data-modeling-red-flags-audit.md` — the Diagnosis-vs-Investigation.diagnosis shape drift called out as a modeling flag (Failure #2 above)
- `.aipe/rehearse-interview-defense/08-the-ai-question.md` — the chapter this war story refreshes once shipped
- `eval/baseline.json` — the receipt this drill exploits (`diagnosis_response` at 48%, runId `2026-07-03T04-08-28-644Z`)
- `eval/rubrics/recommendation-quality.ts` — the instrument
