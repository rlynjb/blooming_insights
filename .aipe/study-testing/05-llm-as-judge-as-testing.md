# 05 — LLM-as-judge-as-testing
*Industry name: LLM-as-judge (when used as an automated test oracle). Type: Industry standard / AI-engineering (Case B framing for this repo: pattern is real, substrate is gone).*

## A reality-check before the walkthrough

**The repo does not have an LLM-as-judge harness today.** No `eval/`
directory, no judge prompt, no calibration set, no scoring tests in
the suite. The reason this file exists isn't to describe live code —
it's to explain why **LLM-as-judge belongs in this guide at all** (it
*is* testing, from the determinism seam's perspective) and to write
down the Phase-3 narrative that's still on the résumé but not in the
repo.

Case B framing throughout: the pattern is industry-standard and
real; the substrate this codebase built it on (the Olist e-commerce
data, in the `mcp-server-olist` sibling repo) was removed in PR #8
on 2026-06-18, and the eval pipeline retired with it. Honest claim:
"I shipped a judge harness against a different substrate; I retired
it deliberately when the substrate changed." Dishonest claim: "the
current repo has evals." It doesn't.

## Zoom out — where the pattern would live

```
  LLM-as-judge — where it would sit in this system (if shipped today)

  ┌─ Eval harness (NOT IN REPO TODAY) ───────────────────────────────┐
  │  for each (input, expected_judgment) in gold_set:                 │
  │    actual = run_monitoring_agent(input)                           │
  │    verdict = JUDGE_LLM(                                           │
  │      prompt: "score actual vs expected on rubric [...]")          │
  │    assert verdict.score >= threshold                              │
  └─────────────────────────────┬────────────────────────────────────┘
                                │  the JUDGE is a separate LLM call
                                │  with a deterministic OUTPUT contract
  ┌─ Agent layer (REAL TODAY) ──▼────────────────────────────────────┐
  │  MonitoringAgent.scan() → Anomaly[]                              │
  │  DiagnosticAgent.diagnose() → Diagnosis                          │
  │  RecommendationAgent.propose() → Recommendation[]                │
  └─────────────────────────────┬────────────────────────────────────┘
                                │
  ┌─ Provider layer ────────────▼────────────────────────────────────┐
  │  Anthropic API · Bloomreach MCP                                  │
  └──────────────────────────────────────────────────────────────────┘
```

**The seam this pattern sits on** is the determinism boundary. The
agent's output is probabilistic — the same input can produce different
diagnoses. The judge's **structured verdict** (a score, a category, a
JSON object) is deterministic. So when you assert on the judge's
verdict, you're back in deterministic-testing land — which is why this
pattern belongs in *this* guide, not in `study-ai-engineering`'s eval
section.

## Structure pass — the skeleton this pattern hangs on

**Layers:** agent under test → judge LLM → structured verdict → assertion.

**Axis: determinism — what's actually being asserted on?**

```
  determinism flips TWICE across this pattern

  ┌─ input ──┐  ┌─ agent (probabilistic) ──┐  ┌─ judge ─┐  ┌─ assert ┐
  │  fixed   │ ►│  output varies run-to-run │ ►│ verdict │ ►│  test  │
  │          │  │                           │  │  is a   │  │  pins  │
  │          │  │                           │  │ STRUCT  │  │  on it │
  └──────────┘  └───────────────────────────┘  └─────────┘  └────────┘
       ▲                  ▲                       ▲             ▲
       │   det.            non-det.            structured       deterministic
       └──── trace one axis ───────────────────────────────────────────┘
              determinism FLIPS at agent in, FLIPS BACK at judge out
              → the test is deterministic IF the judge is calibrated
```

The hard part: **the judge is also an LLM**, so its output is also
probabilistic — until you calibrate it. Calibration is what makes the
verdict deterministic enough to assert on. Without calibration the
judge IS the system under test, recursively, and you've solved
nothing.

**The seam that matters:** the judge's prompt + the gold set of (input,
expected-verdict) pairs that calibrate it. Drop either and the pattern
collapses.

## How it works

### Move 1 — the mental model

You know how unit tests use `expect(x).toBe(5)` because `5` is
deterministic? LLM-as-judge is the same shape — you assert on
something deterministic — but you USE a second LLM to **convert** a
non-deterministic output into a deterministic verdict.

```
  The pattern — LLM-as-judge as a deterministic harness

      input  ──►  AGENT UNDER TEST  ──► output (varies run-to-run)
      (fixed)         (LLM, probabilistic)        │
                                                  │
                                                  ▼
                                     ┌────────────────────────┐
                                     │   JUDGE LLM             │
                                     │   prompt: "score X     │
                                     │    against rubric on   │
                                     │    [criteria], return  │
                                     │    {score: 1-5,         │
                                     │     reason: '...'}"     │
                                     └────────────┬────────────┘
                                                  │
                                                  ▼
                                     {score: 4, reason: '...'}
                                     (structured, parseable)
                                                  │
                                                  ▼
                                       expect(verdict.score)
                                         .toBeGreaterThanOrEqual(3)
                                                  │
                                                  ▼
                                          deterministic PASS/FAIL
```

The judge is a **type converter**: probabilistic-string → structured-verdict.
Once the verdict is structured, the test assertion is just shape +
threshold — same as any other test.

### Move 2 — the step-by-step walkthrough

#### Step 1 — define the rubric the judge will score against

The rubric is the most important part of the pattern and the part
nobody pays enough attention to. It has to be **specific to the agent
under test**, **expressible in a prompt**, and **calibrated against
human judgment**.

For monitoring agent output specifically:

```
  rubric example for the MonitoringAgent (what the Olist-era judge
  in mcp-server-olist used to score on — reconstructed from memory,
  not in repo today):

  CRITERIA the judge scores 1-5 on:
  ─────────────────────────────────────────────────────────────────────
  1. anomaly_detection_correctness
     does the agent surface the anomaly that's actually in the data?
  2. severity_calibration
     is severity (critical / warning / info / positive) appropriate?
  3. scope_specificity
     does scope correctly identify the segment, or is it overly broad?
  4. evidence_grounding
     does the cited evidence actually support the conclusion?
  5. business_impact_articulation
     is the "why it matters" useful, not generic?

  OUTPUT CONTRACT the judge MUST conform to:
  ─────────────────────────────────────────────────────────────────────
  { "scores": { criterion: number 1-5 },
    "overall": number 1-5,
    "reasoning": "1-2 sentences per criterion" }
```

The rubric is itself prompt-engineered. It gets versioned alongside
the agent prompts — when the agent's job changes, the rubric changes
with it.

#### Step 2 — build a gold set of (input, expected verdict) pairs

A small calibration set. 10-50 examples. Each one is a (input,
expected-verdict) pair, where the expected verdict was set by **a
human reading the agent's output**. The gold set is what tells you
whether the judge agrees with you.

```
  example gold-set entry (illustrative — the Olist-era set is gone):

  {
    "input": { "metric": "purchase_count", "window": "90d" },
    "agent_output": { ... }, // the actual agent run that produced this
    "human_verdict": {
      "scores": { "anomaly_detection_correctness": 5,
                  "severity_calibration": 4, ... },
      "overall": 4,
      "reasoning_human": "agent caught the right drop. Severity
                          could be one step higher given the segment
                          size."
    }
  }
```

Building the gold set is the load-bearing manual step. You can't
shortcut it — the gold set IS the ground truth the judge is calibrated
against.

#### Step 3 — calibrate the judge against the gold set

Run the judge on each gold-set entry. Compare the judge's verdict to
the human's verdict. If they agree on 9/10 entries within ±1 on the
overall score, the judge is calibrated enough to use as an oracle.

If they disagree, **tune the rubric prompt** (not the gold set, not
the test) until they agree. The judge can't be more reliable than its
rubric.

```
  calibration loop:
  ─────────────────────────────────────────────────
   1. run judge over gold set → judge_verdict[i]
   2. compare to human_verdict[i] for each i
   3. if |judge.overall - human.overall| > 1 on > 10%
      of entries: tune the rubric prompt
   4. re-run, re-compare
   5. when within tolerance: judge is calibrated;
      bake the prompt into a versioned file
   6. now the judge can score NEW agent runs and you
      can assert on its verdict
```

This is the **K=N manual spot-check** the Phase-3 narrative names. In
the Olist era it was K=10 — ten human judgments, used to calibrate
the LLM judge, after which the LLM-judge ran against a larger eval
set without further human review.

#### Step 4 — assert on the verdict, not the output

Once calibrated, the test shape is mundane:

```ts
// what a calibrated LLM-as-judge test WOULD look like
// (illustrative; not in repo today)
it('monitoring agent surfaces the seasonal-dip anomaly with adequate severity', async () => {
  const agent = makeMonitoringAgent(realAnthropic, fixtureDataSource);
  const output = await agent.scan({ ... });

  const verdict = await scoreWithJudge({
    rubric: MONITORING_RUBRIC_V3,
    expected: GOLD_SET.seasonal_dip,
    actual: output,
  });

  expect(verdict.overall).toBeGreaterThanOrEqual(3);    // ← deterministic threshold
  expect(verdict.scores.anomaly_detection_correctness).toBeGreaterThanOrEqual(4);
});
```

The test asserts on a **number** (`verdict.overall`). The number
comes from a calibrated judge. The judge is a wrapper that converts
probabilistic output into a structured verdict — and the wrapper is
the determinism boundary. This is why this pattern is **testing**, not
evaluation: from the assertion's seat, the input is fixed and the
expected output is fixed; the LLM in the middle is just plumbing.

#### Step 5 — what "Case B" means here, in practice

```
  Case A (would-be claim, false)        Case B (true, this repo)
  ────────────────────────────────      ──────────────────────────────────
  "the repo has live LLM evals"          "the repo HAD LLM evals against
                                          a substrate that was removed;
                                          I shipped them, used them,
                                          retired them"
  shows up in the audit as a               shows up in lens 6 (audit.md)
   green ✓ in lens 6                       as "not exercised today" with
                                          a note about the retired phase
  interview claim: "look, here's          interview claim: "I built a
   the harness running"                    four-pillar harness (gold set
                                          + judge calibrated by K=10 spot-
                                          check + category coverage gate
                                          + BRL sentinel that caught a
                                          rounding bug). When PR #8
                                          removed the Olist substrate the
                                          eval went with it — that was
                                          deliberate; rebuilding it on
                                          the Bloomreach substrate is the
                                          next thing in the queue, but
                                          not done today"
```

The Case B framing is the honest version. Case A would fall apart the
moment somebody asked to see the `eval/` directory.

### Move 2 variant — the load-bearing skeleton

The kernel of LLM-as-judge-as-testing is four parts. Drop any and the
pattern stops being **testing** and becomes "throwing data at an LLM
and hoping for the best."

```
  THE KERNEL — four parts, what breaks if missing

  1. A SPECIFIC RUBRIC (in the judge prompt)
     5±2 named criteria with explicit scoring guidance
     → without it, the judge invents its own rubric run-to-run
       and the verdict drifts

  2. A STRUCTURED OUTPUT CONTRACT (judge returns JSON, not prose)
     { scores: {...}, overall: number, reasoning: string }
     → without it, the test can't assert deterministically;
       you're back to parsing prose, recursively

  3. A CALIBRATION SET (the K manual spot-checks)
     10-50 (input, human-verdict) pairs the judge is tuned against
     → without it, you have no evidence the judge agrees with
       human judgment; you're trusting an unverified oracle

  4. A THRESHOLD, NOT AN EXACT MATCH
     assert verdict.overall >= 3, NOT verdict.overall === 4
     → without the threshold, you're asserting exact LLM output
       and you've reintroduced the non-determinism you tried to
       eliminate

  Drop ANY ONE and the pattern is not testing anymore — it's
  vibes-driven evaluation dressed in test syntax.
```

These four are the irreducible kernel. Optional hardening: LLM-judge
ensembling (run N judges, take median), confidence-weighted
thresholds, per-criterion gates instead of overall. Useful, not
load-bearing.

The interview-payoff move is naming **calibration as the load-bearing
half**. Most descriptions of LLM-as-judge stop at "the judge scores
the output." The discipline that turns that into a TEST is the gold
set + K-spot-check calibration loop. Without it the judge is just
another LLM; with it, the judge becomes a deterministic oracle for
the surrounding test.

### Move 3 — the principle

**Anything you can convert into a structured verdict, you can test on.**
The judge LLM is a type converter, and the test asserts on the
converted type. As long as the conversion is calibrated against human
judgment, the test inherits the determinism of its assertion — even
though the system under test is probabilistic.

The deeper principle: **the boundary between testing and evaluation
isn't whether the system is probabilistic — it's whether you have a
deterministic assertion you trust**. LLM-as-judge moves the boundary
by manufacturing a trusted deterministic assertion. That's why it
sits in the testing study, not the eval study.

## Primary diagram — the whole pattern in one frame

```
  LLM-AS-JUDGE-AS-TESTING — one frame (the pattern; not live in this repo)

  ┌─ ONCE, manually ──────────────────────────────────────────────────┐
  │  build GOLD SET: (input_i, agent_output_i, human_verdict_i)        │
  │  10-50 entries, human-judged                                       │
  │                                                                    │
  │  calibrate: run JUDGE_LLM(rubric_v1) over gold set                 │
  │             compare judge_verdict to human_verdict                 │
  │             tune rubric prompt until agreement within ±1 on > 90%  │
  │  → emerges: a versioned RUBRIC_PROMPT the judge is calibrated to   │
  └─────────────────────────────┬─────────────────────────────────────┘
                                │
  ┌─ EVERY EVAL RUN ────────────▼─────────────────────────────────────┐
  │                                                                    │
  │   for (input, expected) in gold_set:                               │
  │     actual = run_agent_under_test(input)        ← PROBABILISTIC    │
  │     verdict = JUDGE_LLM(                                           │
  │       prompt: RUBRIC_PROMPT,                                       │
  │       expected, actual,                                            │
  │     ).parseAsJson()                              ← TYPE-CONVERTED  │
  │                                                    INTO STRUCTURE  │
  │     expect(verdict.overall)                                        │
  │       .toBeGreaterThanOrEqual(threshold)         ← DETERMINISTIC   │
  │                                                                    │
  └────────────────────────────────────────────────────────────────────┘

  the judge wraps a non-deterministic call inside a deterministic
  assertion → the test sits in the testing study even though the
  system under test is probabilistic
```

## Elaborate

LLM-as-judge has become standard practice in the AI-evaluation
community since ~2023 (the "Vicuna" eval paper made it famous;
"G-Eval" and "MT-Bench" formalized it). The technique is now table
stakes for any team that ships LLM features and needs a regression
signal.

What's notable about framing it as **testing** (not evaluation):

  → Most teams talk about LLM-as-judge as "evals" — a noisy,
    informal, batch-mode quality check. That framing puts it in a
    different mental bucket from "tests" and tends to mean nobody
    runs it in CI.
  → Treating the calibrated judge as a **deterministic oracle**
    moves it into the testing bucket: it runs in CI, it gates merges,
    the verdict is structured, the threshold is named.
  → The discipline it inherits from this re-framing is the discipline
    of acceptance + per-gate rejection from file 04: every criterion
    in the rubric is a gate, and the test asserts each gate
    independently rather than only on the overall score.

The Olist-era four-pillar harness in `mcp-server-olist`:

```
  the four pillars (shipped, used, retired with PR #8 / 2026-06-18)

  pillar                                        what it bought
  ───────────────────────────                   ───────────────────────────
  1. GOLD SET                                   ground truth for the judge
     ~30 (anomaly, expected_judgment) pairs     to calibrate against
     human-judged

  2. LLM-AS-JUDGE                               structured verdict over
     calibrated against gold set by K=10        non-deterministic agent
     manual spot-check                          output

  3. CATEGORY COVERAGE GATE                     prevents "judge passes but
     every anomaly category seen at least       agent skipped half the
     once per eval run                          categories silently"

  4. BRL CURRENCY SENTINEL                      caught the rounding bug
     a specific gold-set entry that would       BEFORE merge — proof the
     fail the verdict if revenue numbers        whole pipeline earned
     were off by more than $0.01                its keep
```

What earned this its place in the interview narrative: the BRL bug
catch. The eval pipeline caught a real bug — a currency-rounding edge
case where revenue was being rolled up in BRL with a `Math.floor` that
should have been `Math.round`. The bug wouldn't have hit production
*if the harness hadn't existed*. That's the concrete proof that the
eval pipeline was load-bearing, not theatrical.

What earned its retirement: PR #8 removed the Olist e-commerce
substrate the gold set was anchored to. Re-anchoring the gold set
against the Bloomreach substrate would require fresh human-judged
entries against the new data shape, and the priority went to shipping
the Bloomreach feature instead. **That's a real tradeoff, owned
deliberately, not a regression.**

The honest line: "the repo doesn't have evals right now. I've shipped
this exact pattern before; I retired it for substrate reasons. When
Bloomreach gold-set work is the next priority, rebuilding it is a
known three-day move."

## Interview defense

**Q: "Walk me through how you'd add LLM evals to this repo today."**

Four parts in order. **Gold set first** — 10-30 anchored
(input, agent_output, human_verdict) entries against the Bloomreach
synthetic workspace, hand-judged. **Then the rubric** — 5±2 criteria
tied to what the monitoring agent should produce (anomaly correctness,
severity calibration, scope specificity, evidence grounding, business
articulation). **Then the judge prompt**, calibrated against the gold
set by K=10 manual comparisons until agreement is ±1 on >90% of
entries. **Then the harness** — a single vitest file in
`test/eval/` (or a separate `npm run eval` command if it's slow) that
runs the agent on each gold-set entry, scores with the judge, and
asserts on per-criterion + overall thresholds.

What I'd skip on day one: the BRL-style sentinel. That came after we
saw the first real bug class in the Olist substrate — bug-class
sentinels are added when the bug exists to anchor against, not
preemptively.

*anchor:* this would land at `test/eval/monitoring.eval.test.ts`
(does not exist today); the harness would import the real
`MonitoringAgent` from `lib/agents/monitoring.ts` with real Anthropic +
the `SyntheticDataSource` from `lib/data-source/synthetic-data-source.ts`
as a deterministic substrate so the agent input is reproducible.

**Q: "Is LLM-as-judge testing or evaluation?"**

Depends on where the assertion lands. If you're asserting on the
judge's structured verdict against a threshold (`verdict.overall >=
3`), it's **testing** — the system under test is probabilistic but
the assertion is deterministic. If you're reading the judge's verdict
into a spreadsheet and eyeballing it, it's **evaluation** — there's
no deterministic gate.

The mental model I'd draw: the judge as a type converter from
"probabilistic string" to "structured verdict." Once converted, the
verdict is just data, and the test on the data is the same shape as
any other test. That's why I put this concept in the testing guide,
not the eval guide.

*anchor:* `00-overview.md` "the seam — deterministic vs probabilistic"
diagram; this file's Move 1 diagram showing where the determinism
flips back.

**Q: "What's the load-bearing part everyone forgets?"**

Calibration. Most descriptions stop at "the judge scores the output"
and skip how you know the judge agrees with human judgment. That step
— the K=10 manual spot-check that ties the judge prompt to a small
hand-judged gold set — is what turns the judge from "another LLM" into
a deterministic oracle. Without it, the judge IS the thing being
tested, recursively, and you've solved nothing.

The sister discipline I'd name: per-criterion thresholds, not just
overall. The rubric has 5 criteria; if you only assert on overall, a
regression on one criterion can be masked by gains on another. Asserting
per-criterion turns the judge's verdict into a per-gate test — the
same discipline as the validator tests in file 04.

*anchor:* this file's Move 2 / Step 3 (calibration loop) and Move 2
variant kernel point 4 (threshold, not exact match).

**Q: "Why isn't this in the repo if you know how to build it?"**

Honest answer: it WAS, against the Olist substrate. PR #8 on
2026-06-18 removed the Olist server because the loomi-mcp-alpha
integration became the real product target. Re-anchoring the eval
against Bloomreach data would mean building a new gold set from
scratch against the synthetic Bloomreach workspace — a ~3-day move
that I prioritized lower than shipping the Bloomreach feature itself.
The pattern is on my résumé because I shipped it and retired it
deliberately; calling it "in the repo today" would be false.

*anchor:* lens 6 in `audit.md` for the audit-level naming of the gap;
`06-eval-flywheel.md` for the four-pillar walkthrough.

## See also

  → `06-eval-flywheel.md` — the four-pillar harness this pattern was
    one component of. Same Case B framing.
  → `04-acceptance-with-per-gate-rejection.md` — the per-gate
    discipline this pattern inherits when the judge has multiple
    rubric criteria.
  → `00-overview.md` — the determinism seam diagram that places
    this concept on the testing side.
  → `audit.md` lens 6 — the audit-level statement of "the repo has
    no LLM eval harness today; the pattern's been shipped and
    retired."
  → `study-ai-engineering` — where the *evaluation* side of LLM
    output lives, the side that doesn't wrap in a deterministic
    assertion.
