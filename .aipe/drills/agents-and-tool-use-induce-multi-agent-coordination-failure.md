competency:   Agents & tool use                                       raises: L2 → L3
curriculum:   n/a (no aieng-curriculum.md Bx.y maps cleanly; closest is
              study-agent-architecture/03-multi-agent-orchestration/09-coordination-failure-modes.md's
              "handoff-loss / context-drop / role-conflation" taxonomy)
study ref:    .aipe/study-agent-architecture/03-multi-agent-orchestration/09-coordination-failure-modes.md
              + .aipe/study-agent-architecture/03-multi-agent-orchestration/08-shared-state-and-message-passing.md
              + .aipe/study-ai-engineering/05-evals-and-observability/README.md (for the measurement half)
              + eval/baseline.json — the shipped receipt this drill exploits

---

> **Coach posture, verdict first.** You have a shipped multi-agent supervisor (deterministic route handler at `app/api/agent/route.ts:222–345`) that hands `Diagnosis` from the DiagnosticAgent to the RecommendationAgent as a strongly-typed object. The interview signal you don't yet have — the L3 war story — is a **coordination-failure receipt**: proof that the handoff itself can silently degrade agent output even when both agents are working correctly in isolation. Your baseline `eval/baseline.json` (runId `2026-07-03T04-08-28-644Z`) already contains the smoking gun: `diagnosis_response` passes at **48%** on the recommendation rubric — cases where the diagnosis is grounded but the rec addresses the wrong hypothesis. That 48% is the coordination failure sitting in your repo right now, unnamed as such. This drill is to **name it, force it on demand, fix it, and prove the fix moves the number**. The failure to induce is "primary hypothesis silently downweighted at the handoff." If you can't reproduce it against a specific golden case with a specific prompt/data change, the drill is faked — pick a different case until one breaks.

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

Failure surface, ranked by war-story weight:
1. **Primary-hypothesis silent downweight** — `conclusion` names cause A as primary; `hypothesesConsidered[]` has A supported + B supported + C rejected. Recommendation agent picks a lever targeting B (the "safer" hypothesis, or the one with more supporting-language weight in the prose). Baseline says this happens **48% of the time** on the recommendation rubric's `diagnosis_response` dimension.
2. **Shape-drift handoff** — an old-format `Investigation` object gets deserialized and its `hypothesesConsidered: string[]` reaches the recommendation agent. Zero rejection signal.
3. **Stale diagnosis re-carry** — sessionStorage's `bi:diag:<id>` is keyed by investigation id, but if a user navigates in an unexpected order (or if the `bi:diag:<X>` key survives a bug in the id derivation), a *different investigation's* diagnosis could hand off cleanly.

---

## 2. INDUCE — the failure you must cause on demand

**The failure:** at least ONE golden case where, with the DiagnosticAgent producing a correctly-emphasized diagnosis (primary hypothesis = the labeled root cause per `eval/goldens/*.json`), the RecommendationAgent's output receives `diagnosis_response: fail` from the shipped rubric (`eval/rubrics/recommendation-quality.ts`) because at least one recommendation targets a secondary (or explicitly rejected) hypothesis. **AND** you can reproduce it on demand — same golden case, same seed, same prompts, ≥2 of 3 runs fail identically. Reproducibility separates "flaky model" from "coordination-failure receipt."

If you cannot induce reproducibility, the drill is faked — either pick a harder case, or attack the shape-drift surface (Failure #2 above) instead, which is deterministic.

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

**Hypotheses to test in order:**
- **H1 — Handoff shape dilution.** The recommendation agent's inference weight over `hypothesesConsidered[]` treats all `supported: true` entries roughly equally. Primary-emphasis lives only in `conclusion` prose. *Test:* single-entry `hypothesesConsidered` — see Step 2.4.
- **H2 — Recommendation prompt gap.** The rec agent's system prompt (owned by AptKit's `RecommendationAgent`, not this repo) does not instruct the agent to hard-anchor to the primary hypothesis. Even a perfect handoff wouldn't fix it. *Test:* skip — AptKit-internal, you can't easily patch. Rule H2 in or out via H1 alone.
- **H3 — Category confusion.** The rec agent has a systemic bias toward experiment-pause / feature-flag recs regardless of diagnosis. *Test:* pick a golden case where the primary hypothesis is NOT experiment-related — does the rec still trend toward experiment-pause? If yes, H3 is real and this is a bigger drill than one handoff.

**Isolated cause** (fill from what H1–H3 actually show): `_______`. State it in one sentence. If more than one hypothesis is contributing, name the ranking.

---

## 4. FIX + REJECT — the alternative you didn't take and why

*(You write this. Coach names the option matrix; you pick, justify, ship.)*

Option matrix — pick ONE, defend it in one line each for the others:

| Option | Where it lives | Cost | What it fixes | What it doesn't |
|---|---|---|---|---|
| **A — Add `primaryHypothesis: string` field to `Diagnosis`** | `lib/mcp/types.ts:95–104` + `lib/mcp/validate.ts:37–43` + DiagnosticAgent output shape | LOW (~1 hr): type change, migration on old receipts, guard on isDiagnosis | Explicit rank at the handoff — no more inference | Depends on the DiagnosticAgent being asked to fill it correctly. Prompt change on top. |
| **B — Rank the `hypothesesConsidered[]` by primaryness in the DiagnosticAgent's prompt** | `lib/agents/legacy-prompts/diagnostic.md` (or AptKit's internal prompt if reachable) | MEDIUM (~2 hr, plus a re-eval): prompt edit + measure delta | Keeps the shape stable, exploits array order | Order-carries-meaning is a weak signal; rec agent may not respect it |
| **C — Reject: pass the full DiagnosticAgent trace to the RecommendationAgent** | recommendation.ts:29–46 | HIGH (token budget blowup, cost regression against Week 3 caching win) | Would give rec agent perfect context | Undoes the shipped cost story — you'd need to defend the regression at interview |
| **D — Reject: rewrite the recommendation prompt to require primary-hypothesis-alignment** | AptKit's `RecommendationAgent` internal prompt | UNKNOWN (owned by `@aptkit/core`) | Would fix at the receiver | You don't own the prompt — this is a request-upstream, not a ship |

**Recommended (you decide, but coach's read):** ship **A** because it makes the primary explicit at the type level — the handoff carries structured intent, not inferred intent. Reject C on the cost receipt. Reject D on ownership. Keep B as a follow-up if A alone doesn't move the number enough.

Whatever you pick, name what you rejected and *why in one sentence each*. That's the L3 signal.

---

## 5. EVAL — the measurement (this is the non-negotiable half)

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

Shape to fill:

> "We were shipping recs that addressed the wrong root cause because `_______` at the handoff between the diagnostic and recommendation agents. Our eval harness caught it — `diagnosis_response` was passing at 48% and we didn't know why. I traced it to `_______`, fixed the shape by `_______`, and the pass rate moved to `_______%`. The lesson: a strongly-typed handoff can still lose emphasis if the type doesn't carry rank."

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
