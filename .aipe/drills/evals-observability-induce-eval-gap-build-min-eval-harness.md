competency:   Evals & observability                                   raises: L1 → L2
curriculum:   n/a (no aieng-curriculum.md Bx.y maps cleanly; closest is study-ai-engineering/05-evals-and-observability/02-eval-methods.md's "rubric → LLM-as-judge" ladder)
study ref:    .aipe/study-ai-engineering/05-evals-and-observability/README.md
              + .aipe/study-testing/audit.md (Case B — "169 green tests, zero quality signal")

---

> **Coach posture, verdict first.** You have 169 green tests and 0 evals. The 5 tests in `test/agents/diagnostic.test.ts` test that the wrapper extracted the JSON YOU pre-wrote — not that the model's answer is right. That's not an eval, that's a contract test wearing an eval costume. The drill is to break that costume: feed the live diagnostic agent a hand-curated case where the obvious wrong answer is also the most-tool-call-shaped one, watch it answer confidently wrong with `confidence: 'high'` and 3+ hypothesesConsidered, then build the goldset+judge harness that catches it. **The failure to induce is "confidently wrong with the appearance of rigor."** If your agent gets every case right on the first try, your cases are too easy — pick harder ones until at least one breaks. Without a real break, this is a tutorial and you wasted the rep.

---

## 1. BUILD — the naive "eval" that exists today

The thing you currently call your safety net for the diagnostic agent is **five tests in `test/agents/diagnostic.test.ts:144–291`**. Open them.

```
  test/agents/diagnostic.test.ts — what each test actually proves

  ┌──────────────────────────────────────────────────────────────────────────┐
  │ test L145–166  "parses and returns a valid diagnosis…"                   │
  │   asserts:   result.conclusion CONTAINS the string "payment UI           │
  │              regression" — which the test author wrote at L128 and       │
  │              the test author scripted the fake Anthropic to return.      │
  │   proves:    parseAgentJson + isDiagnosis work on a valid fence.        │
  │   re quality: nothing. The model never ran.                              │
  ├──────────────────────────────────────────────────────────────────────────┤
  │ test L172–221  "fires onToolCall, onText, onToolResult hooks"            │
  │   proves:    the streaming-hook plumbing fires once per call.            │
  │   re quality: nothing.                                                   │
  ├──────────────────────────────────────────────────────────────────────────┤
  │ test L227–246  "returns the fallback diagnosis when agent emits          │
  │                 non-diagnosis JSON" ({"foo":1})                          │
  │   proves:    FALLBACK constant kicks in.                                 │
  │   re quality: nothing — proves only that a bad-shape parse degrades      │
  │              to a stub, not that a wrong-answer parse degrades anywhere. │
  ├──────────────────────────────────────────────────────────────────────────┤
  │ test L248–267  "returns the fallback diagnosis when agent emits          │
  │                 unparseable text"                                        │
  │   proves:    same FALLBACK path on an unparseable string.                │
  ├──────────────────────────────────────────────────────────────────────────┤
  │ test L273–291  "synthesizes a diagnosis from gathered evidence when      │
  │                 the loop output is unusable"                             │
  │   proves:    synthesize() at lib/agents/diagnostic.ts:87–126 is wired   │
  │              up and the scripted-Anthropic 2nd response is plumbed in.  │
  │   re quality: nothing.                                                   │
  └──────────────────────────────────────────────────────────────────────────┘
```

**Honest naming** (per `study-testing/audit.md:96–104`, "Testing AI features"): this is the **scripted-Anthropic harness** (`.aipe/study-testing/01-scripted-anthropic-harness.md`) — Case A for the wrapper, Case B for the answer quality. The five tests collectively prove the *plumbing* between `runAgentLoop` (`lib/agents/base.ts:48–176`), `tryParseDiagnosis` (`lib/agents/diagnostic.ts:22–29`), `isDiagnosis` (`lib/mcp/validate.ts:29–35`), the `synthesize()` fallback (`lib/agents/diagnostic.ts:87–126`), and the `FALLBACK` constant (`lib/agents/diagnostic.ts:16–20`) — and that's it. `isDiagnosis` (`lib/mcp/validate.ts:29–35`) is the high-water mark of "validation" today: it checks that `conclusion` is *a string*, not that it is *true*.

```
  the deception that has to die

  ┌─ what the 5 tests check ─┐         ┌─ what an eval would check ─┐
  │ shape: is it Diagnosis?  │   vs    │ truth: is the conclusion's │
  │ wired: did the fallback  │         │ CAUSE CLASS the same as    │
  │   path fire?             │         │ the labeled cause class?   │
  └──────────────────────────┘         └────────────────────────────┘
        ↑ today                                ↑ this drill
```

This is `study-testing/audit.md`'s Case B finding stated one more time: the wrapper is tested, the answer quality is not. Step 2 forces this gap to *visibly produce a failure you can point at.*

---

## 2. INDUCE — the failure you must cause for this to count

**The failure:** at least ONE case where the live diagnostic agent returns a `Diagnosis` whose `conclusion` is **class-wrong** (the cause it names is in the wrong category) AND whose `confidence` (derived by `diagnosisConfidence` in `lib/insights/derive.ts:54` from `hypothesesConsidered.length`) ends up `'high'` AND whose `hypothesesConsidered` array has `length ≥ 3` — the agent is confidently wrong, dressed in the appearance of rigor (three competing hypotheses tested), and the only test in the suite that *could* catch this only checks the SHAPE of the answer.

If you cannot induce this, the drill is faked — pick a harder case.

### Step-by-step to induce the failure

**1. Hand-curate 5–10 anomaly cases.** Use the `Anomaly` shape at `lib/mcp/types.ts:83–92`. Label each with the *expected cause class* — categorical, not prose. The classes (pick 4–6 from this list, mix them):

```
  cause-class label             example anomaly that should land in this class
  ─────────────────             ──────────────────────────────────────────────
  data-quality-issue            "purchases > sessions 2:1 on the same day"
                                (event firing twice, or sessions undercounting)
  tracking-pipeline-gap         "checkout step events vanish at hour H, return
                                at hour H+6" (SDK rollout, CDN cache, schema
                                change)
  seasonal-traffic-shift        "mobile conversion -18% week-over-week,
                                desktop flat, holiday period boundary"
  payment-regression            "checkout-to-purchase = 89.7% (industry: 30%),
                                stable across device + geo, started day D"
  campaign-traffic-change       "view_item +60% Tue–Thu, no purchase lift,
                                paid-search source spike"
  product-category-collapse     "sum(purchase.revenue) -40% concentrated in
                                category C, other categories flat"
```

**2. Pick the case most likely to break the agent.** The trick is to **choose a case where the obvious wrong answer is the most-tool-call-shaped one** — i.e. the answer the model will reach if it follows the prompt's `Investigation approach` (`lib/agents/prompts/diagnostic.md:19–25`) literally without questioning the framing.

The candidate I'd start with — a `data-quality-issue` masquerading as a `payment-regression`:

```json
{
  "metric": "checkout_to_purchase_rate",
  "scope": ["all"],
  "change": { "value": 89.7, "direction": "up", "baseline": "7d-vs-30d" },
  "severity": "warning",
  "evidence": [{ "tool": "execute_analytics_eql", "result": { "current": 0.897, "prior": 0.301 } }]
}
```

The expected cause class is **data-quality-issue** (a 90% checkout→purchase rate is impossible at scale — somebody double-fired `purchase` or stopped firing `checkout_step`). The prompt at `lib/agents/prompts/diagnostic.md:11` instructs the agent to use `execute_analytics_eql` and break the metric down by dimensions (device, country, category) — which will produce evidence-rich, well-formed hypotheses about device-specific regression and payment integration, NONE of which match the actual cause class. Three hypotheses tested → `hypothesesConsidered.length ≥ 3` → `diagnosisConfidence` returns `'high'` (see `lib/insights/derive.ts:54`).

**3. Run the live agent against the curated set.** You'll do this by importing `DiagnosticAgent` from `lib/agents/diagnostic.ts:37` and instantiating it with the REAL Anthropic client (not the scripted fake from `test/agents/diagnostic.test.ts:54`) and the REAL `McpClient` from `lib/mcp/client.ts:79`. The eval harness (Step 4) is the thing that wires this — for the induce step you just need ONE real run on ONE hard case to produce the breakage you'll diagnose.

**4. Capture the output.** Save `{ anomaly, diagnosis, expectedCauseClass }` to disk. This becomes the first row of your `evals/golden/anomaly-cases.json`.

```
  what the captured failure looks like — what you need to see

  ┌─ input ──────────────────────────────────────────────────────────────┐
  │ anomaly: checkout_to_purchase_rate up 89.7% (the impossible number)  │
  │ expectedCauseClass: "data-quality-issue"                             │
  └──────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼  agent.investigate()
  ┌─ output (the break) ─────────────────────────────────────────────────┐
  │ conclusion:    "Mobile checkout payment integration regression       │
  │                 caused conversion lift after deploy on day D…"       │
  │ evidence:      [4 well-cited eql query results]                      │
  │ hypothesesConsidered: [                                              │
  │   { hypothesis: "payment-flow A/B test win", supported: true, … },  │
  │   { hypothesis: "device-specific change",   supported: false, … },  │
  │   { hypothesis: "campaign source change",   supported: false, … }   │
  │ ]                                                                    │
  │ confidence:    "high"   ← derived from hypotheses.length ≥ 3         │
  └──────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼  judged against expectedCauseClass
                              CLASS MISMATCH
                          confidence=high, 3 hypotheses,
                          0 of them the actual cause class
                          → THIS is the failure that step 5 will detect
```

If your first case lands the right cause class, you didn't pick a hard enough case. Try the `checkout_step` event-rate one — same shape, different surface symptom. Keep going until at least one of your 5–10 cases breaks. **The break is the assignment.**

---

## 3. DIAGNOSE — symptom → hypotheses → isolated cause

### Symptom

The diagnostic agent produces a well-formed `Diagnosis` (`lib/mcp/types.ts:95–104`) — string conclusion, array of 4 evidence items, 3 hypothesesConsidered — and `diagnosisConfidence` derives `'high'`. By every existing test in `test/agents/diagnostic.test.ts`, this answer passes. By the labeled cause class, it is wrong.

### Hypotheses (work all three before fixing)

**Hypothesis A — the prompt biases toward the most-evidence-rich hypothesis.** The `Investigation approach` section at `lib/agents/prompts/diagnostic.md:19–25` says "Generate 2–3 hypotheses before your first tool call" and lists examples (`device-specific regression, seasonal/geographic shift, campaign traffic change, product category collapse, data collection gap`). Notice "data collection gap" is listed last and not elaborated on. The model is anchored on the more *queryable* hypotheses — the ones EQL can directly test by dimension breakdown. Data-quality issues require *sanity-check reasoning* ("this number is physically impossible"), not dimension breakdown. The prompt does not teach this. **Test:** does the wrong answer correlate with cases where the right answer is a sanity-check, not a dimension-breakdown?

**Hypothesis B — `synthesize()` fires more often than expected and dresses up rambling-prose outputs.** `lib/agents/diagnostic.ts:75` says `tryParseDiagnosis(finalText) ?? (await this.synthesize(anomaly, toolCalls)) ?? FALLBACK`. The synthesize() path (`lib/agents/diagnostic.ts:87–126`) makes a tool-less call that says "Based ONLY on the evidence above, output your best-supported diagnosis" — which, when the underlying evidence pointed at the wrong hypothesis, will produce a structured-looking wrong answer. **Test:** count how often `synthesize()` fires on the goldset vs the loop completing cleanly. If it's >40%, the loop is failing to converge and the fallback is doing more work than is acknowledged.

**Hypothesis C — confidence calibration is broken on out-of-distribution inputs.** `diagnosisConfidence` (`lib/insights/derive.ts:54`) is a deterministic mapping from `hypothesesConsidered.length` (and possibly `supported` count). It does NOT measure the model's actual uncertainty — it measures the *appearance of rigor*. LLMs are systematically overconfident on OOD inputs (cases the prompt examples don't cover, like our impossible-rate case). **Test:** the same input run 5 times — does the cause class vary across runs? If yes, the model is uncertain but the derived `confidence` field is always `'high'` because the *shape* (3 hypotheses, supported=true on one) is stable.

### Trace the failure through the existing observability substrate

Use the NDJSON trace you already emit (`lib/mcp/events.ts`, captured in `lib/state/investigations.ts:11–41`) — this is `study-ai-engineering/05-evals-and-observability/README.md:5`'s "observability is a product strength" point. Replay the failing case's trace. Look at:

- which tools the agent called and in what order (`tool_call_start` events)
- the `durationMs` of each call (captures whether it converged or thrashed)
- the text blocks between tool calls (the model's reasoning narration)
- whether the final response came from the loop's natural end OR from `synthesize()` (look at the call sequence)

```
  what the trace will tell you for the failed case

  trace replay of the broken case
  ───────────────────────────────
  thought:      "Let me hypothesize device, payment-flow A/B, campaign"
  tool_call:    select count event purchase by customer.device_type …
  tool_result:  { mobile: 380, desktop: 600 }     ← well-formed
  thought:      "Mobile is lower; let me confirm with payment-step"
  tool_call:    select count event payment_step by customer.device_type …
  tool_result:  { mobile: 420, desktop: 670 }
  thought:      "Mobile checkout drops at payment_step. Hypothesis: A/B win"
                                                  ← never questions the 89.7%!
  tool_call:    select count event purchase by event.campaign …
  tool_result:  { …}
  thought:      "Campaign-source breakdown is flat; concluding."
  conclusion:   "Payment integration regression on mobile."
                                                  ← class-wrong
```

### Isolated cause

The model dutifully executes the prompt's playbook (dimension breakdown via EQL) on a case where the right answer required a *different* kind of reasoning entirely (sanity-check the magnitude before breaking it down). **No judge ever sees this answer.** The `FALLBACK` constant at `lib/agents/diagnostic.ts:16–20` is the *only* safety net in production code — and it only catches the case where parsing fails entirely. It does nothing for "parses fine, is wrong." There is no judge, no rubric, no agreement-rate baseline, nothing that can distinguish a confidently-correct answer from a confidently-wrong one. **The isolated cause is that the wrong-answer path has no detector.**

This is the `study-testing/audit.md:140` finding stated as a reproducible failure: *"169 green tests, zero quality signal"* — and now you have the failing case to point at when an interviewer asks "show me one."

---

## 4. FIX+REJECT — the minimum-viable eval harness (and the alternatives you reject)

### The fix — spec the harness, do NOT build it in this drill

The drill writeup is the recipe. Your actual rep is to execute the steps below in a follow-up session.

```
  evals/  (new directory at the repo root — does NOT exist today, confirmed
           by recon-2026-06-02.md AUDIT line "No evals/ directory at repo root")

   ├─ golden/
   │   └─ anomaly-cases.json     ← the 5–10 hand-curated cases from Step 2
   │                               each row: { id, anomaly: Anomaly,
   │                                           expectedCauseClass: string,
   │                                           rationale: string,    ← why
   │                                           difficulty: 'easy'|'medium'|'hard' }
   │
   ├─ rubrics/
   │   └─ cause-class.md         ← the 4–6 canonical cause classes
   │                               (data-quality-issue, tracking-pipeline-gap,
   │                                seasonal-traffic-shift, payment-regression,
   │                                campaign-traffic-change, product-category-
   │                                collapse) with one-line definitions
   │
   ├─ runner.ts                  ← imports DiagnosticAgent from
   │                               lib/agents/diagnostic.ts, real Anthropic +
   │                               real McpClient, iterates golden/*.json,
   │                               writes runs/<timestamp>.jsonl with
   │                               { caseId, diagnosis, durationMs, toolCalls }
   │
   ├─ judge.ts                   ← LLM-as-judge (haiku-class for cost — per
   │                               study-ai-engineering/05-evals-and-
   │                               observability/03-llm-as-judge-bias.md's
   │                               cross-family-judge prescription — but you'll
   │                               start same-family for cost; document the
   │                               bias). Given:
   │                                 { anomaly, diagnosis, rubric }
   │                               returns:
   │                                 { predictedCauseClass, judgeReasoning }
   │
   └─ agreement.test.ts          ← the eval gate. For each golden case:
                                     judge(diagnosis) vs expectedCauseClass
                                   reports the agreement rate (number/total)
                                   AND the per-case judge reasoning so you
                                   can read why each one passed/failed
```

### The output that makes this an eval (not a test)

```
  scripted-Anthropic test         vs       eval run
  ──────────────────────                    ────────
  asserts: pre-written JSON                 asserts: agreement rate
           round-tripped                             ≥ baseline
  proves:  plumbing works                   proves:  prompt v2 didn't
                                                    regress vs v1
  fails:   plumbing broken                  fails:  agreement dropped
  output:  green ✓ / red ✗                  output:  "6/10 = 60%"
```

### The alternatives you reject — and why

**Reject: exact-match comparison of `conclusion` strings.** Too brittle for generative output. The same cause class can be phrased five different ways ("payment UI regression", "checkout payment integration broke", "the payment step lost users", "card processing failed"). Exact-match scores all of these as "wrong." This is `study-ai-engineering/05-evals-and-observability/02-eval-methods.md`'s scoring-ladder finding: climb only as high as variability forces. For *conclusion prose*, rubric/judge is the right rung. For `metric` string in monitoring output, exact-match is fine. Different surfaces, different rungs.

**Reject: raising `maxToolCalls` from 6 to 12 (`lib/agents/diagnostic.ts:62`).** Treats a symptom — "the model should investigate more rigorously" — by giving it more budget. Without a measurement, you have no way to know whether 12 calls produces better answers or just doubles your cost. The whole point of the eval is that **you can now measure it**: run the harness at maxToolCalls=6 (baseline) and maxToolCalls=12 and compare agreement rates. The fix is the *ability to do that comparison*, not picking the answer up-front.

**Reject: trusting the existing `diagnosisConfidence` derivation (`lib/insights/derive.ts:54`).** It measures the appearance of rigor (count of hypothesesConsidered), not actual answer quality. A "high confidence" diagnosis with a wrong cause class is the worst kind of output — confidently wrong. The eval replaces *derived* confidence with *measured* agreement.

**Reject: a confusion matrix at this stage.** With 5–10 cases and 4–6 cause classes you don't have enough data per cell for the matrix to be informative. Single-number agreement rate is the right granularity for the first 10 cases; grow into a per-class precision/recall table when the goldset reaches ~30. This is `study-ai-engineering/05-evals-and-observability/01-eval-set-types.md`'s honest scoping point.

**Reject: starting with a regression set (only failures the agent has hit in production).** No production traffic yet → no production failures yet. Start with the goldset (hand-curated hard cases) and *grow* the regression set as real failures land. The drill produces the first 5–10 rows; production produces the rest.

---

## 5. EVAL — the measurement (this is what makes it L3)

**The metric: agreement rate of judge vs ground truth on the 5–10 case goldset.**

```
  agreement rate =  N where judge.predictedCauseClass === expectedCauseClass
                   ────────────────────────────────────────────────────────
                                          N total cases
```

Run it once. Get a number. **Expect 50–70% on the first run** (LLMs are decent on canonical cases, weak on the hard ones you deliberately picked). That number is your **baseline**.

```
  before any prompt edits          after a prompt edit
  ─────────────────────            ──────────────────────
  baseline agreement: 60%   ─►     run the same harness
  (6/10 cases correct)              against the edited prompt
                                   ──────────────────────
                                    new agreement: 80%
                                    delta: +20%
                                    "this prompt edit ships"

                                    OR

                                    new agreement: 50%
                                    delta: -10%
                                    "this prompt edit DOES NOT ship"
```

**The honest framing of the metric (cite this in interviews — don't overclaim):**

- 5–10 cases is a *seed* goldset. Statistical power is low. A 60% → 70% delta on N=10 has wide error bars. **What it catches: large regressions (≥20% drop) cleanly.** What it misses: 5% noise drifts.
- LLM-as-judge with a same-family judge has self-preference bias (`study-ai-engineering/05-evals-and-observability/03-llm-as-judge-bias.md`). The first cut uses same-family (haiku judging sonnet) for cost; the v2 of the harness adds a cross-family judge (Gemini Flash or GPT-4o-mini) and you measure judge-vs-judge agreement to bound the bias.
- Agreement is on **cause class** (categorical), not prose match. This is deliberate: the class is the unit of correctness, the prose is the surface.

**Why this measurement gives the drill an L3 ceiling:** the war story now ends with *a number you can point at and a methodology you can defend under push-back.* "I had 60% agreement on the seed goldset, judged by haiku-4-5, calibrated against my own hand-scoring on the same 10 cases at 80% inter-rater agreement, and every prompt edit since ships with a delta vs that baseline." That sentence is L3 — it survives a senior interviewer pulling on "how do you know?"

```
  the chain that earns L3

   goldset (labeled)  →  runner (live agent)  →  judge (rubric)  →  agreement %
        ↑                                                                ↓
        │                                                          ┌─────┴─────┐
   regression set                                                  │  baseline │
   (failures that                                                  │  + delta  │
    grow over time)  ◄─── every prompt edit produces a delta ◄─────┴───────────┘
                          a regression backslides into the regression set
                          a win promotes to the goldset
```

The eval IS the deliverable. Without it: undefended fix, no L3. With it: every future prompt change carries a quality number, which is the thing recon's cap rule was waiting for.

---

## 6. WAR STORY — the sentence you can now say in a room

> *"I had five tests on the diagnostic agent — every one of them only proved the plumbing extracted the JSON I'd pre-written, none of them touched answer quality. So I hand-curated ten anomaly cases labeled by cause class — including one where a 90% checkout-to-purchase rate is physically impossible — and the live agent confidently called it a 'payment integration regression' with three hypotheses 'tested.' I built `evals/` with a goldset, an LLM-as-judge against a six-class rubric, and an agreement-rate gate. Baseline came back at 60%. Now every prompt edit ships with a +/- vs that number, and I caught a regression on the next prompt change that no unit test would ever have seen."*

(Speakable. Present-tense. First-person. Specific number. Names the prior gap, the induced break, the fix, and the ongoing measurement — exactly the four beats a senior interviewer pulls on. Per `me.md`'s reader profile: hands-on, code-anchored, no marketing language, names the suboptimal choice — the 5 tests being only plumbing — before naming the fix. Per `teacher.md`'s coach posture: direct, verdict-first, no hedging.)

---

## What the drill produces — your handoff to execution

When you execute this drill in a follow-up session, you'll create exactly these files (the recipe lives above; don't recreate it here):

```
  evals/                                 ← new, repo root
    golden/anomaly-cases.json            ← 5–10 labeled cases
    rubrics/cause-class.md               ← the 4–6 categorical classes
    runner.ts                            ← live-agent driver
    judge.ts                             ← haiku-class judge call
    agreement.test.ts                    ← the eval gate (npm run eval)

  .aipe/drills/                          ← this folder; war story portfolio
    evals-observability-induce-eval-gap-build-min-eval-harness.md   ← THIS file
```

Cap-rule consequence (per recon-2026-06-02.md TRACK queue head and `specs/drill.md` line 174: *"No eval, no L3. An undefended fix is luck."*): once `agreement.test.ts` runs green against a baseline number on `main`, every other LENS competency in `recon-2026-06-02.md` becomes eligible to move above L1. This drill is the unblock for moves 2–5 in the TRACK queue.

---

## Cross-references (don't duplicate — cite)

- **`.aipe/study-ai-engineering/05-evals-and-observability/README.md`** — the theory of the gap (Case B for evals, Case A for observability). This drill is the hands-on rep that closes Case B; do not restate the theory here.
- **`.aipe/study-testing/audit.md` lines 96–104, 134–140** — the "AI-eval seam" framing and the Top-3 finding #3 ("169 green tests, zero quality signal"). This drill is the failure-rep that turns that finding into a war story.
- **`.aipe/study-testing/01-scripted-anthropic-harness.md`** — the substrate the existing 5 diagnostic tests live in. The drill names that substrate as "not an eval" and builds the eval layer on top of (not instead of) it.
- **`.aipe/study-ai-engineering/05-evals-and-observability/02-eval-methods.md`** — the scoring-ladder reasoning that underpins the "reject exact-match" decision in Step 4.
- **`.aipe/study-ai-engineering/05-evals-and-observability/03-llm-as-judge-bias.md`** — the self-preference bias the v1 judge inherits and the v2 cross-family judge fixes.
- **`.aipe/audits/recon-2026-06-02.md`** TRACK queue head (move #1) — the source assignment for this drill.
