# Eval workshop — the map

> **Coach, verdict first.** You have a shipped eval harness. You have a lived
> receipt (Move 3, commit `be05240`) of that harness catching a real regression
> and saving you from shipping a bad fix. What you told me is *"i feel were
> doing more advance stuff now than what i know about evals"* — so this
> workshop is not going to teach you how to build one from zero. You already
> have one. This workshop is going to walk you through it in the order it
> would be built in your head, so the next time someone asks *"you let AI
> write the app and the eval — why do you trust the result?"* you can answer
> with a number and a file path.

## the one question the whole workshop answers

> **"AI wrote your app AND your eval. Why do you trust the result?"**

The answer is not "because I typed it." The answer is *because a human
labeled a small set of cases and the AI-written judge agrees with those
labels at a measured rate.* Trust comes from **calibration against a
human-owned anchor**, not from authorship.

That anchor lives at `eval/calibration/worksheet-2026-07-03T02-47-24-392Z.json`
in your repo. It is the load-bearing exercise (05). Everything else in the
workshop points at it.

---

## what an eval actually is — the three-part model

The instinct beginners have: *"the eval is a test I write."* Half right.
An eval has three parts and only ONE of them is human-owned:

```
  what's in an eval             who OWNS it            AI writes it?
  ─────────────────────────────────────────────────────────────────────
  1. harness  (loop, runner,    you own the DESIGN    YES — it's plumbing.
     gate, report, plumbing)                           you own the contract;
                                                       Claude fills it in.

  2. rubrics  (what "good"      you own the CRITERIA  Claude drafts →
     means — dimensions,                               human edits every
     scales, thresholds)                               threshold.

  3. cases + LABELS             HUMAN owns the        NO for labels.
     (the ground truth —        LABELS                Claude may draft
     inputs + expected shape)                         inputs; human writes
                                                       the expected.
```

The whole workshop is a walk down this table, from top to bottom, in the
order your instinct probably reaches for it — but with the ownership line
made explicit every time. The 10 exercises below map each layer onto a
specific file already on disk in `eval/`.

---

## what the repo actually is (discovery)

Before wiring up exercises, the map has to name what shape of eval this
is — because "eval" means different things for RAG vs an agent vs a
plain-LLM app. Read from disk (`app/api/agent/route.ts`, `lib/agents/*`,
`eval/run.eval.ts`, `eval/goldens/*`):

- **Shape: multi-agent LLM-app.** Deterministic supervisor (`app/api/agent/route.ts:242–365`) routes to five agents: `monitoring`, `diagnostic`, `query`, `recommendation`, plus a `classifyIntent` Haiku call. Handoff between diagnose → recommend is a strongly-typed `Diagnosis` object.
- **NOT a RAG app.** No vector store, no embeddings, no ANN retrieval. Retrieval happens via MCP tool calls (`execute_analytics_eql`, etc.) issued by the diagnostic agent against Bloomreach's loomi-connect MCP server. Which means Exercise 07 (RAG track) is SKIPPED — see below.
- **NOT plain-LLM.** The agent loop is not one shot; it's tool-use with a supervisor. Exercise 08 (agent track) APPLIES.

The consequence for skip logic (per the spec, exercises 07/08 gate on shape):

- **07 — RAG track: SKIPPED.** No retrieval seam to grade separately. If you ever add a vector store, come back here.
- **08 — agent track: APPLIES.** You have a multi-agent handoff and a lived coordination-failure receipt. This is your strongest signal exercise besides 05.

---

## the eval surface you already have (discovery)

Everything the workshop points at is already on disk. No exercise creates
files from thin air; they annotate, extend, or apply pressure to what's
there.

```
  ┌─ eval/ ───────────────────────────────────────────────────────────────┐
  │                                                                        │
  │  README.md                    ─ layout + what week 1 shipped           │
  │                                                                        │
  │  goldens/                     ─ the CASES (Ex 02 anchor)               │
  │    types.ts                     GoldenCase shape                       │
  │    01-conversion-drop-mobile-checkout.ts                               │
  │    02-fraud-payment-failure-credit-card.ts                             │
  │    03-session-drop-organic-mobile.ts                                   │
  │    04-cart-abandonment-mobile-broad.ts                                 │
  │    05-no-signal-retention-subscribers.ts     ← no-signal (abstention)  │
  │    06-no-signal-price-sensitivity-luxury.ts  ← no-signal (abstention)  │
  │    07-positive-conversion-surge-mobile.ts    ← positive slice          │
  │    08-checkout-collapse-multi-scope.ts       ← Move 3 fingerprint case │
  │    09-engagement-drop-email-campaign.ts                                │
  │    10-no-signal-seo-organic.ts                                         │
  │    index.ts                                                            │
  │                                                                        │
  │  rubrics/                     ─ what GOOD means (Ex 04 anchor)         │
  │    diagnosis-quality.ts         4 dims × 1–5 · 3 verdicts              │
  │    recommendation-quality.ts    4 dims × 1–5 · 3 verdicts              │
  │                                                                        │
  │  calibration/                 ─ the ANCHOR (Ex 05 spine)               │
  │    README.md                                                           │
  │    worksheet-2026-07-03T02-47-24-392Z.json  ← human fills yourScores   │
  │    agreement-2026-07-03T02-47-24-392Z.json  ← the receipt              │
  │                                                                        │
  │  receipts/                    ─ one JSON per case per run (gitignored) │
  │    01-…-2026-07-03T04-08-28-644Z.json                                  │
  │    …40+ receipts, including Move 3 negative-result run                 │
  │    …-2026-07-03T18-11-06-952Z.json                                     │
  │                                                                        │
  │  run.eval.ts                  ─ the LOOP (Ex 03 anchor)                │
  │  gate.eval.ts                 ─ the GATE (Ex 09 anchor)                │
  │  baseline.json                ─ committed reference for gate           │
  │  compute-agreement.eval.ts    ─ the calibration math                   │
  │  generate-worksheet.eval.ts   ─ scaffolds a blind worksheet            │
  │  probe-h1-isolation.eval.ts   ─ Move 3's isolation probe               │
  │                                                                        │
  └────────────────────────────────────────────────────────────────────────┘

  .github/workflows/ci.yml       ─ typecheck + npm test + npm run build
                                    (Ex 09 wiring lives here)
```

**Baseline numbers you're going to reference** (from `eval/baseline.json`,
runId `2026-07-03T04-08-28-644Z`):

- Diagnosis pass rates per dim: `root_cause_plausibility` **75%**, `evidence_grounding` **50%**, `scope_coherence` **75%**, `actionable_next_step` **0%**
- Recommendation pass rates per dim: `diagnosis_response` **48%**, `feature_choice_fit` **62%**, `step_actionability` **100%**, `impact_realism` **43%**
- Per-case cost ~**$0.09** agent-side · 10-case total ~**$1.30**
- Judge error rate on the recommendation judge: **33%** across 18 invocations (rec-judge `maxTokens=4096` truncates on longer recs)

**The lived receipt (Move 3, commit `be05240`).** You shipped
`filterSupportedHypotheses` at the handoff. Eval regressed all 4 rec dims
by 13–23pp case-matched. You reverted. Tombstone at
`lib/agents/recommendation.ts:31-41`. This IS the answer to "why do you
trust the eval?" — because the eval caught a wrong mental model you didn't
know you had. Exercise 10 makes you say that sentence out loud.

---

## the exercise arc — how each lands in your repo

Ten exercises, in the order they'd build in your head. Each one anchors
to a specific file (not "somewhere in eval/") and each one names ownership
explicitly (human-authored vs AI-drafted-human-verified).

```
  the exercise arc — coach voice, one at a time, then stop

  01 the ownership split            ─ the model. sort every eval/ file into
                                     the 3 buckets. 5 min.

  02 write ONE case by hand         ─ audit one of your 10 goldens. did a
                                     human write knownCorrect, or did AI?
                                     the answer determines everything below.

  03 let AI write the harness       ─ run.eval.ts is 470 LOC of loop.
                                     Claude wrote it. you specified the
                                     contract. what IS the contract?

  04 the rubric — AI drafts,        ─ open diagnosis-quality.ts. read every
     human decides                    threshold. did you edit them or did you
                                     accept the draft?

  05 the trust anchor:              ← THE SPINE. worksheet-…-2026-07-03T02-47-24-392Z.json
     calibrate the judge              is your anchor. AI-vs-AI pilot done
                                     (6/6 · 13/24 · 24/24). REAL HUMAN pass
                                     is where you convert "pilot" to
                                     "receipt". this is the one that carries
                                     the interview answer.

  06 adversarial-first              ─ 3 of your 10 goldens (`05,06,10`) are
                                     already no-signal / abstention cases.
                                     you built adversarial-first without
                                     naming it as such. audit + extend.

  07 RAG track                      ─ SKIPPED. this app has no vector store,
                                     no embedding retrieval. retrieval is via
                                     MCP tool calls, which is a different
                                     evaluation problem (covered in 08).

  08 agent track                    ─ APPLIES. Move 3 lived here. tool-call
                                     trace is already passed to the judge
                                     (run.eval.ts:238-247). the coordination-
                                     failure receipt is your L3 signal.

  09 wire the gate                  ─ gate.eval.ts + baseline.json + ci.yml
                                     already ship. the exercise is to prove
                                     it fails a known-bad change. Move 3's
                                     candidate run IS that proof.

  10 capstone: articulate the       ─ the interview answer. say it out loud,
     anchor                           grounded in the files above.
```

## how to work through this

The reader will invoke `/aipe:rehearse-eval-workshop` later to start
coaching. When they do, coach will present ONE exercise at a time and
stop. Do not read ahead unless the coach hands you the next one.

Files in this directory are named `01-*.md` through `10-*.md` in arc
order. Exercise 07 is present but marked SKIPPED with the reason (no
retrieval seam in this repo).

## see also (grounded in real repo files only)

- `.aipe/audits/recon-2026-07-03.md` — the fresh recon that places this repo at L2 and names evals as the L2.5-with-lived-receipt lens
- `.aipe/drills/agents-and-tool-use-induce-multi-agent-coordination-failure.md` — Move 3, the lived receipt this workshop's discipline earned (commit `be05240`)
- `.aipe/study-ai-engineering/05-evals-and-observability/README.md` — the competency-level teaching of evals; the workshop is the applied cousin
- `eval/README.md` — the terse repo-level intro (what Week 1 shipped)
- `eval/calibration/README.md` — the protocol the workshop's Exercise 05 walks
- `eval/baseline.json` — the committed reference numbers Exercise 09 gates against
