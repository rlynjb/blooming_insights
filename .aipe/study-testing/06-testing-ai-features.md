# 06 — Testing AI features (the deterministic / probabilistic seam)

**Industry name:** Test-vs-eval seam / deterministic harness around a probabilistic core. **Type:** Industry standard for AI products.

## Zoom out, then zoom in

This is the concept where this guide hands off to `study-ai-engineering`. blooming insights is a 100%-AI product — every investigation runs Claude + MCP. The deterministic half of testing that (loop control, parser fallback, type-guard rejection, NDJSON codec) is **well-covered here**. The probabilistic half — *is the diagnosis any good?* — is **Case B: not done.** No goldset, no judge, no eval suite, no offline runs. This file is honest about what's testable here vs what hands off, and points at the existing AI-engineering write-up for the would-be shape.

```
Zoom out — the test/eval seam in blooming insights

  ┌─ DETERMINISTIC HARNESS (study-testing, this guide) ─────────────────┐
  │                                                                      │
  │  Tested via scripted-Anthropic + fake McpCaller:                     │
  │                                                                      │
  │   ✓ runAgentLoop multi-turn dispatch (8 tests, base.test.ts)         │
  │   ✓ parseAgentJson — fenced / plain / embedded / throws (5 tests)    │
  │   ✓ isAnomalyArray / isDiagnosis / isRecommendationArray (25 tests)  │
  │   ✓ DiagnosticAgent.investigate — happy / fallback / synthesis (5)   │
  │   ✓ MonitoringAgent.scan — sort, slice, empty (10 tests)             │
  │   ✓ RecommendationAgent.propose — id assignment, cap-at-3 (5)        │
  │   ✓ QueryAgent.answer — fallback when loop yields empty (3)          │
  │   ✓ NDJSON codec round-trips (7 tests, events.test.ts)               │
  │                                                                      │
  └──────────────────────────────────────┬──────────────────────────────┘
                                         │ everything above is "wrap a
                                         │ probabilistic core in a deter-
                                         │ ministic harness, then assert
                                         │ on the harness's behaviour"
                                         │
                                         ▼ hands off where the core's
                                           OUTPUT QUALITY is the question
  ┌─ PROBABILISTIC EVAL (study-ai-engineering/05-evals-and-observability)┐
  │                                                                      │
  │  NOT BUILT YET (Case B):                                             │
  │                                                                      │
  │   ✗ goldset — "for this anomaly, the right diagnosis is X"           │
  │   ✗ adversarial set — prompt injection, missing data                 │
  │   ✗ regression set — every past quality bug, frozen                  │
  │   ✗ LLM-as-judge — score diagnosis prose against a rubric            │
  │   ✗ eval runner — replay an investigation with a changed prompt      │
  │                                                                      │
  │  Pointed at by .aipe/study-ai-engineering/05-evals-and-observability │
  │  as the buildable target. The observability half (NDJSON trace) IS   │
  │  built — see file 04-llm-observability.md in that directory.         │
  └──────────────────────────────────────────────────────────────────────┘
```

Now zoom in. The interesting move is **the boundary** — what specifically *is* testable deterministically about an AI feature, and where exactly does it hand off to evals.

## Structure pass

**Layers:** the prompt → the model call → the parser → the type guard → the agent's downstream use of the output. **Axis traced:** *can a deterministic test assert on this layer?* **The seams where the answer flips:**

```
The axis "deterministically testable?" — layer by layer of an AI feature

  axis traced = "given the same input, will the output be the same?"

  ┌─ prompt assembly ─────────────────────────────────┐
  │  schemaSummary(schema), buildSystem(category)     │  YES — pure function,
  │  Args in → text out                                │  same input → same text
  └──────────────────────┬──────────────────────────┘  ✓ tested (10 tests on
                                                         schemaSummary alone)

  ┌─ model call dispatch ─────────────────────────────┐
  │  anthropic.messages.create(params)                │  YES, with a SCRIPT —
  │  inject a fake; assert on params (system, tools)  │  see file 02
  └──────────────────────┬──────────────────────────┘  ✓ tested

  ┌─ tool dispatch ───────────────────────────────────┐
  │  for each tool_use in response.content:           │  YES — pure control
  │    mcp.callTool(name, args)                        │  flow, fake McpCaller
  └──────────────────────┬──────────────────────────┘  ✓ tested

  ┌─ output parser ───────────────────────────────────┐
  │  parseAgentJson(text)                              │  YES — string in,
  │  fenced ``` ``` → plain JSON → embedded scan       │  parsed value out
  └──────────────────────┬──────────────────────────┘  ✓ tested (5)

  ┌─ output validation (type guard) ──────────────────┐
  │  isDiagnosis(parsed)                               │  YES — pure boolean
  │  rejects bad shape, drives fallback                │  predicate
  └──────────────────────┬──────────────────────────┘  ✓ tested (6)

  ┌─ ★ output QUALITY ★ ──────────────────────────────┐
  │  is the diagnosis CORRECT? is it useful?           │  FLIP — no longer
  │  did the model identify the actual root cause?    │  deterministic
  └──────────────────────┬──────────────────────────┘  ✗ NOT TESTED
                                                        (this is eval territory)

  ┌─ trace / observability ───────────────────────────┐
  │  NDJSON event stream, tool_call_start/end spans   │  observability built
  │  durationMs captured at the choke point            │  but no QUALITY
  └───────────────────────────────────────────────────┘  asserted on traces
```

The seam: **everything UP TO and INCLUDING the type guard is deterministically testable, and tested here. Everything FROM "is the output correct" onward is probabilistic and not tested.** That's the dividing line for "what study-testing audits" vs "what study-ai-engineering audits."

## How it works

### Move 1 — the mental model

An AI feature is a probabilistic core wrapped in a deterministic shell. The shell is testable; the core is evaluable. Each side answers a different question:

```
Two questions, two test types — the AI-feature seam

  ┌─ deterministic test answers: "does the WRAPPER work?" ─────────────┐
  │                                                                    │
  │    given                       expected                            │
  │    ─────                       ────────                            │
  │    valid JSON output    →      isDiagnosis returns true            │
  │    invalid JSON output  →      synthesize() is called as fallback  │
  │    rate-limit error     →      retry with parsed wait window       │
  │    tool throws          →      is_error: true returned to model    │
  │                                                                    │
  │    INPUT IS CONTROLLED. OUTPUT IS PREDICTABLE. Use Vitest.         │
  └────────────────────────────────────────────────────────────────────┘
                                ▲
                                │ they meet at counterfactual replay:
                                │ the observability trace, re-run with
                                │ a changed prompt, IS the eval harness
                                ▼
  ┌─ probabilistic eval answers: "does the CORE do its job?" ──────────┐
  │                                                                    │
  │    given (an anomaly)          expected (a rubric score)           │
  │    ─────                       ────────                            │
  │    "mobile conversion -23%"    diagnosis identifies the right       │
  │                                  cause class ≥ 80% of the time     │
  │    "missing payment events"    handles gracefully, says "data       │
  │                                  insufficient" rather than          │
  │                                  hallucinating                      │
  │                                                                    │
  │    INPUT IS REAL. OUTPUT IS GRADED, NOT MATCHED. Use an eval set + │
  │    a scoring rubric (+ maybe an LLM judge).                        │
  │                                                                    │
  │    NOT BUILT IN THIS REPO TODAY (Case B).                          │
  └────────────────────────────────────────────────────────────────────┘
```

### Move 2 — the walkthrough

#### Move 2.1 — what IS testable deterministically (the wrapper)

Six categories of testable behaviour, all covered in this repo:

```
The deterministic wrapper — six surfaces, all covered

  surface                       what's being asserted                   tests
  ───────                       ─────────────────────                   ─────
  1. prompt assembly            schemaSummary(big) under 10KB; includes 10
                                 expected event names + customer props   (monitoring.
                                                                          test.ts)
  2. tool dispatch              for each tool_use → mcp.callTool called  base.test
                                 with the right name + args               .ts (8)
  3. message accumulation       tool_result appended back to messages    base.test
                                 with is_error: true on throw             .ts (8)
  4. output parsing             fenced ``` ``` extracted; embedded JSON  validate
                                 found; throws when no JSON               .test.ts (5)
  5. output validation          isDiagnosis(parsed) gates fallback path  validate
                                                                          .test.ts (6)
  6. fallback / synthesis       loop returns unusable text → dedicated   diagnostic
                                 synthesis call → second-chance parse     .test.ts (1)
                                                                          recommendation
                                                                          .test.ts (1)
```

Walk one — the synthesis fallback in `DiagnosticAgent`. The agent loop sometimes ends without emitting valid JSON (the model rambles, hits its tool budget, gets confused). The agent has a *second* call — tool-less, with `synthesisInstruction` appended — that forces a structured output. The test scripts both turns:

```
test/agents/diagnostic.test.ts (lines 273–291) — the synthesis fallback path

  it('synthesizes a diagnosis from gathered evidence when the loop output is unusable', async () => {
    const { anthropic } = buildFakeAnthropic([
      // Investigation loop ends with rambling prose (no valid diagnosis JSON)
      { content: [textBlock('Let me keep investigating — I should run more queries first.')],
        stop_reason: 'end_turn' },
      // The dedicated tool-less synthesis call then returns a valid diagnosis
      { content: [textBlock('```json\n' + VALID_DIAGNOSIS_JSON + '\n```')],
        stop_reason: 'end_turn' },
    ]);

    const agent = new DiagnosticAgent(anthropic as unknown as Anthropic,
                                       buildFakeMcp(), FIXTURE_SCHEMA, FAKE_TOOL_DEFS);

    const result = await agent.investigate(SAMPLE_ANOMALY);
    expect(result.conclusion).toContain('payment UI regression');
    expect(result.hypothesesConsidered).toHaveLength(2);
       │
       └─ this proves the WRAPPER works when the core fails to produce
          valid output. What it DOESN'T prove: that the synthesized
          diagnosis is correct. The fixture says "payment UI regression"
          because the TEST AUTHOR wrote that; nobody asked whether the
          real Anthropic model would actually conclude that.
  });
```

#### Move 2.2 — what is NOT testable deterministically (the core)

Three questions that the deterministic harness *cannot* answer:

```
What the harness can't answer — the eval questions

  question                                     why deterministic test can't
  ────────                                     ──────────────────────────
  "is this diagnosis CORRECT?"                  the test would have to know the
                                                ground-truth root cause; only a
                                                goldset (curated by humans) can
                                                supply that.

  "did the model regress after a prompt edit?"  a unit test asserts on the SAME
                                                output every run; if the model
                                                shifts its prose style without
                                                changing structure, no test
                                                fires — but the user feels the
                                                regression. Need eval-on-replay.

  "would this recommendation actually help?"    requires a rubric (action-
                                                ability, specificity, fit to
                                                Bloomreach features) and a
                                                judge — human, model, or both.
```

None of these have a Vitest answer. They have an *eval* answer, and the eval harness isn't built.

#### Move 2.3 — the false sense of security (the trap)

**The trap.** 169 tests passing, all green. Looks like coverage. Isn't.

```
The asymmetry — what the green bar covers vs what users feel

  ┌─ what 169 green tests prove ─────────────────────────┐
  │  • the WRAPPER is wired correctly                     │
  │  • every type-guard gate fires correctly              │
  │  • the retry ladder honors parsed hints               │
  │  • the synthesis fallback gets reached on bad output  │
  │  • the NDJSON codec round-trips                       │
  └──────────────────────────────────────────────────────┘

  ┌─ what 169 green tests do NOT prove ──────────────────┐
  │  • the diagnosis is correct for ANY real anomaly      │
  │  • prompt v2 isn't worse than prompt v1               │
  │  • the model isn't hallucinating root causes          │
  │  • the recommendations would actually help            │
  │  • the agent's tool selection is rational             │
  │  • the synthesized fallback isn't garbage             │
  └──────────────────────────────────────────────────────┘
                                  │
                                  ▼
            ALL OF THESE ARE EVAL QUESTIONS — none are answered.
            Every prompt edit and model swap ships with zero
            quality measurement.
```

The cross-reference in `.aipe/study-ai-engineering/05-evals-and-observability/README.md` calls this out explicitly: "The 169 Vitest tests are real and valuable, but they inject fakes and assert *plumbing* — control flow and output shape — not answer quality; `isDiagnosis` checks that a conclusion is a string, not that it is true."

#### Move 2.4 — the would-be shape (where the evals would go)

A buildable target. The existing AI-engineering write-up names this as `evals/` at the repo root, holding goldset + harness + judge. Three eval set types and one runner:

```
The eval suite that doesn't exist yet — the buildable target

  evals/
  ├── golden/                  ← curated, hand-graded "right answers"
  │   ├── conversion-drop-mobile.json     anomaly → expected diagnosis
  │   ├── revenue-spike-products.json     anomaly → expected diagnosis
  │   └── …                                  20–50 cases to start
  │
  ├── adversarial/             ← robustness — especially for the ?q= path
  │   ├── prompt-injection.json    user query: "ignore previous instructions"
  │   ├── missing-data.json        anomaly with empty evidence
  │   └── ambiguous-anomaly.json   anomaly that could have 3 causes
  │
  ├── regression/              ← every past quality bug, frozen
  │   └── …                     ← grows over time as bugs are found
  │
  ├── rubrics/                  ← scoring criteria for prose outputs
  │   ├── diagnosis-rubric.md       cause-identification, evidence cited
  │   └── recommendation-rubric.md  specificity, actionability, fit
  │
  └── runner.ts                ← the harness
       │
       └─ for each case in evals/{golden,adversarial,regression}/:
           replay through the live agent (NOT scripted-Anthropic)
           score the output via rubric (exact-match → F1 → judge)
           emit a report: pass / fail / score delta vs last run

  EXISTING POINTERS:
    • observability — already built — feeds the eval runner; the trace
      replayed with a changed prompt IS the eval (see
      study-ai-engineering/05/04-llm-observability.md)
    • the trace abstraction (encodeEvent, durationMs at the choke point)
      already gives you spans — what's missing is persistence + replay
```

The honest framing from the existing write-up: *the observability half is rich; the eval half is empty.* This concept file's role is to name that as the gap in the *testing* lens, not to fill it.

### Move 2 variant — the load-bearing skeleton of testing an AI feature

What is the minimum that gives you confidence an AI feature works?

1. **A deterministic test of the wrapper.** Inject a fake model, script its outputs, run the real agent code, assert on what it did. This catches every wiring bug — the parser misses a fence, the type guard accepts a malformed object, the synthesis fallback never runs. Without it, you're flying blind on integration.

2. **A goldset eval of the core.** Curated input → expected output (or expected score on a rubric). Run against the real model. This catches every quality bug — prompt v2 worse than prompt v1, model swap regresses on edge cases, judge bias creeps in. Without it, you're flying blind on quality.

3. **An observability trace that links the two.** When an eval fails, the trace tells you *why* — which tool was called, what the model thought, where the parsing went off the rails. Replay the trace with a fixed prompt and you have a closed loop: bug → trace → prompt fix → re-run eval → ship.

blooming insights has #1 (strong) and #3 (rich). #2 is missing. That asymmetry is the audit finding.

### Move 3 — the principle

**Testing covers what's deterministic; evals cover what isn't. You need both, and you can't substitute one for the other.** A green test bar with no evals means "the wrapper works, quality is undefined." A passing eval set with no tests means "the model gave good answers, but tomorrow's refactor will silently break the JSON parsing." The discipline is *both*, and the seam where they meet is the trace: a deterministic harness replaying observability traces against a changed prompt.

## Primary diagram

The full test-vs-eval map for blooming insights:

```
Testing AI features in blooming insights — the seam, made visible

  ┌─ INPUT ──────────────────────────────────────────────────────────────┐
  │                                                                       │
  │  insight (Anomaly: metric, scope, change, severity, evidence)        │
  │                                                                       │
  └──────────────────────────────┬───────────────────────────────────────┘
                                 │
                                 ▼
  ┌─ DETERMINISTIC WRAPPER (169 tests cover this) ──────────────────────┐
  │                                                                      │
  │   ┌─ schemaSummary(schema) ─────┐  prompt assembly (10 tests)       │
  │   │  → system prompt text        │                                   │
  │   └──────────────┬───────────────┘                                   │
  │                  ▼                                                   │
  │   ┌─ runAgentLoop({ anthropic, mcp, … }) ────────┐  (8 tests)        │
  │   │  multi-turn dispatch, maxTurns, maxToolCalls │                   │
  │   │  forceFinal, synthesisInstruction            │                   │
  │   └──────────────┬───────────────────────────────┘                   │
  │                  ▼                                                   │
  │   ┌─ ★ anthropic.messages.create(params) ★ ──┐                       │
  │   │      (PROBABILISTIC CORE — the seam)      │  ← faked in tests   │
  │   └──────────────┬───────────────────────────┘                       │
  │                  ▼                                                   │
  │   ┌─ parseAgentJson(response.text) ──────────┐  (5 tests)            │
  │   └──────────────┬───────────────────────────┘                       │
  │                  ▼                                                   │
  │   ┌─ isDiagnosis(parsed) / isAnomalyArray /   │  (25 tests)          │
  │   │   isRecommendationArray                    │                     │
  │   └──────────────┬───────────────────────────┘                       │
  │                  ▼                                                   │
  │   ┌─ synthesize() fallback when invalid ─────┐  (2 tests)            │
  │   └──────────────┬───────────────────────────┘                       │
  │                  ▼                                                   │
  │   ┌─ encodeEvent → NDJSON stream ────────────┐  (7 tests, codec)     │
  │   └──────────────┬───────────────────────────┘                       │
  │                                                                      │
  └──────────────────┴──────────────────────────────────────────────────┘
                     │
                     ▼ what arrives at the user
  ┌─ OUTPUT (the eval-question surface, NOT TESTED) ────────────────────┐
  │                                                                      │
  │  Diagnosis: { conclusion, evidence, hypothesesConsidered, … }        │
  │                                                                      │
  │  EVAL QUESTIONS THE WRAPPER TESTS CANNOT ANSWER:                     │
  │   • is `conclusion` the actual root cause?  →  goldset                │
  │   • are the hypotheses the right ones to test?  →  rubric / judge    │
  │   • did the model cite supporting evidence?  →  rubric                │
  │   • did the recommendation fit Bloomreach's capabilities?  →  rubric │
  │                                                                      │
  │  EXISTING POINTER:                                                   │
  │   .aipe/study-ai-engineering/05-evals-and-observability/README.md    │
  │   names this as Case B — the buildable target. The observability     │
  │   half (NDJSON trace, durationMs spans) IS built and feeds the eval. │
  └─────────────────────────────────────────────────────────────────────┘
```

## Implementation in codebase

**Use case A — the deterministic wrapper as it stands.** Every test in `test/agents/*.test.ts` is a wrapper test. The pattern is identical: script the Anthropic responses, fake the MCP caller, run the real agent, assert on outputs.

```
test/agents/diagnostic.test.ts  (lines 144–166)

  it('parses and returns a valid diagnosis when agent emits correct JSON', async () => {
    const { anthropic } = buildFakeAnthropic([
      { content: [textBlock('```json\n' + VALID_DIAGNOSIS_JSON + '\n```')],
        stop_reason: 'end_turn' },
    ]);

    const agent = new DiagnosticAgent(anthropic as unknown as Anthropic,
                                       buildFakeMcp(), FIXTURE_SCHEMA, FAKE_TOOL_DEFS);

    const result = await agent.investigate(SAMPLE_ANOMALY);
    expect(result.conclusion).toContain('payment UI regression');
    expect(result.evidence).toHaveLength(2);
    expect(result.hypothesesConsidered).toHaveLength(2);
    expect(result.hypothesesConsidered[0].supported).toBe(true);
    expect(result.affectedCustomers?.count).toBe(1400);
       │
       └─ ALL of these assertions are about the wrapper extracting the test
          author's pre-written JSON. None are about whether the diagnosis
          is correct — VALID_DIAGNOSIS_JSON was written by the test author,
          not produced by the model. This is the right test to have AND it
          says nothing about model quality.
  });
```

**Use case B — the existing observability trace, which is the seam to evals.** The NDJSON event stream emits `tool_call_start` / `tool_call_end{durationMs}` events that are spans. Persisted to `lib/state/investigations.ts`. Replayable via `getCachedInvestigation`. This is exactly the substrate an eval runner would replay against a changed prompt.

```
lib/mcp/events.ts  (lines 4–12)

  export type AgentEvent =
    | { type: 'reasoning_step'; step: ReasoningStep }
    | { type: 'tool_call_start'; toolName: string; agent: AgentName }
    | { type: 'tool_call_end'; toolName: string; agent: AgentName;
        durationMs: number; result?: unknown; error?: string }
    | { type: 'insight'; insight: Insight }
    | { type: 'diagnosis'; diagnosis: Diagnosis }
    | { type: 'recommendation'; recommendation: Recommendation }
    | { type: 'done' }
    | { type: 'error'; message: string };
       │
       └─ tool_call_start/end form a SPAN. durationMs is the span's wall
          time. A replay with a changed prompt would re-emit this sequence
          and the eval runner would diff: "with prompt v2, did the agent
          call fewer tools? did it reach the same conclusion faster?"

lib/state/investigations.ts  ← persists AgentEvent[] by insight id
   │
   └─ this is the buildable target's foundation. The trace is already
      captured and replayable; the eval runner that replays it against
      the live model with a changed prompt is the missing piece.
```

## Elaborate

The deterministic-shell / probabilistic-core pattern is the standard shape for production AI work — it's how OpenAI's `evals` repo, Anthropic's `inspect_ai`, and Langfuse all decompose the problem. The unit-test layer is *necessary but not sufficient* for AI features; the layer above (evals) is what carries the quality signal. Skipping it ships products where every regression is silent until users complain.

The "169 green tests but no evals" shape is also extremely common — most AI products built by teams from a software-engineering background look like this for the first 6–12 months. The fix is operational: hand-curate 20–50 golden cases, write a rubric, run on every prompt change. Not exotic; just not built yet.

Cross-reference: `.aipe/study-ai-engineering/05-evals-and-observability/` has four files covering eval set types (golden / adversarial / regression), scoring methods (exact-match through LLM judge), judge bias (position, verbosity, self-preference), and the observability trace that's already built. Read those for the eval shape; this file is for the *testing* lens — naming the gap, pointing to where it lives.

## Interview defense

**Q: 169 tests pass on every commit. Why do you call testing a gap for AI features?** Because the tests cover the *wrapper*, not the *core*. Every test in `test/agents/` injects a scripted Anthropic response — the model's actual output never enters the suite. If I edit a system prompt today, all 169 tests still pass; the only thing that catches a regression is shipping the change and seeing if users complain. That's not a test gap, it's an *eval* gap — different word for a different shape. The two are complementary; we have one, not the other.

```
The two questions, side by side

  unit test (have)              eval (don't have)
  ────────────────              ──────────────────
  "if the model returns X,      "what does the model actually return
   does the agent do Y?"          when shown a real anomaly?"

  scripted input                real input
  deterministic output           probabilistic output
  asserted with toEqual         scored against a rubric
  runs in 4s per CI             runs against the live API (slow + $)
  catches wiring bugs           catches quality bugs
```

**Q: What would the first eval look like for this codebase?** Twenty hand-curated anomaly cases, each paired with the *expected diagnosis class* (not the exact prose — that varies, but the cause class — "payment regression," "seasonal traffic shift," "data quality issue" — is graded). Run the real DiagnosticAgent against each; score the output's `conclusion` field via a rubric (LLM-as-judge to start, calibrated against human judgment on a 10-case sample). Threshold: ≥80% correct cause class. That's the gate before merging a prompt change.

**Q: Why hasn't this been built?** Honest answer: build cost and judgment-calibration cost are both real. A useful eval suite needs curation (find 20–50 anomalies + label them), infrastructure (runner, scorer, report), and judgment (when does the score reflect the model vs the judge's bias?). The first version is a week of work; the right version is several months of iteration. The observability trace was the precondition (you need to capture what the agent did before you can grade it); that's built. The next move is the curation + runner.

## Validate

1. **Reconstruct:** Without looking, list the six categories of deterministic-wrapper behaviour this guide names as testable, and one example of each.
2. **Explain:** Why does `VALID_DIAGNOSIS_JSON` in `diagnostic.test.ts` say nothing about whether the diagnosis is correct?
3. **Apply:** Sketch the first three goldset cases for blooming insights — pick three plausible anomaly inputs and write what an expected diagnosis class would be.
4. **Defend:** A reviewer says "169 tests is enough for this codebase." Push back with the test-vs-eval distinction; name one production failure mode the test suite would not catch.

## See also

- [01-what-is-tested-and-what-isnt.md](01-what-is-tested-and-what-isnt.md) — the coverage map that names this as a gap from the testing side
- [02-test-design-and-levels.md](02-test-design-and-levels.md) — the scripted-Anthropic pattern, which is exactly the deterministic-wrapper layer
- [05-edge-cases-and-error-paths.md](05-edge-cases-and-error-paths.md) — the synthesis fallback as the wrapper's defence against bad core output
- (external) `.aipe/study-ai-engineering/05-evals-and-observability/README.md` — the eval-half write-up; the buildable target lives there
