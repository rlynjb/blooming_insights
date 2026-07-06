# Exercise 03 — let AI write the harness (and notice you could)

## ① verdict

The loop is plumbing. Claude wrote it. You trust it the way you trust any
code — via tests and via reading the contract — not via authorship. Your
`eval/run.eval.ts` is 470 LOC of glue. The exercise is to read it once
and say out loud: *this is the contract I specified, and the smoke test
proves it works.* Trust via receipt, not via keystrokes.

## ② analogy

You don't hand-forge the bolts to trust the bridge; you inspect the
finished bridge. Same shape here: you don't hand-type the eval loop to
trust it. You specify what it must do (the contract), let Claude write
it, and inspect that the output is what you asked for.

## ③ in your repo

`eval/run.eval.ts` — the main loop. `eval/README.md` documents the shape
Week 1 shipped. Reading the file top to bottom is the exercise.

## ④ human track — the contract you specified

Before Claude wrote a line of `run.eval.ts`, you named the loop's
contract. The contract is what you own; the code that implements it is
what Claude writes. Your contract on `run.eval.ts`:

```
  the run.eval.ts contract — what YOU specified

  input:   an array of GoldenCase (from eval/goldens/index.ts)
  substrate: SyntheticDataSource (in-process, deterministic, no MCP)
  per case:
    1. run DiagnosticAgent.investigate(anomaly)      → Diagnosis
    2. score Diagnosis with RubricJudge              → RubricJudgment
       (rubric: diagnosis-quality.ts)
       context to the judge MUST include:
         - anomaly (JSON)
         - knownCorrect (JSON)  ← the human label
         - signalClass
         - tool_calls_trace     ← the judge sees what tools ran
    3. run RecommendationAgent.propose(anomaly, dx)  → Recommendation[]
    4. score EACH recommendation with a second RubricJudge
       (rubric: recommendation-quality.ts)
    5. write one receipt per case to receipts/<case>-<runId>.json
  aggregate:
    a single-run summary and (optional) baseline delta

  pluggability requirement:
    substrate is injected (SyntheticDataSource today, FaultInjecting
    tomorrow, Bloomreach for a live re-run). No hard-coded provider.
```

That contract is the human artifact. Every piece of it is a decision:
*separate diagnosis and recommendation judgments* (you own that split);
*pass tool_calls_trace to the judge* (you own that — that's the load-
bearing choice from Move 3, see below); *one receipt per case per run*
(you own the storage shape).

## ⑤ AI track — the loop itself + smoke test

Claude wrote the 470-LOC `run.eval.ts` against that contract. The proof
that it satisfies the contract is not "I read every line" — it's:

- **Smoke test**: you can run `npm run eval` on ONE case and read a
  receipt back from disk. That is the end-to-end trust signal. Not "I
  believe Claude wrote it correctly" — "I ran it and the receipt exists
  and its fields are what I specified."
- **Contract inspection**: read the specific hunks that implement the
  load-bearing parts of the contract. You don't have to read every line;
  read the boundaries.

The load-bearing hunk is at `eval/run.eval.ts:238–247` — the judge's
context payload:

```ts
  // eval/run.eval.ts:238–247 — the load-bearing choice
  const diagnosisJudgmentResult = await diagnosisJudge.judge({
    subject: JSON.stringify(diagnosis, null, 2),
    context: {
      anomaly: JSON.stringify(goldenCase.anomaly, null, 2),
      known_correct_shape: JSON.stringify(goldenCase.knownCorrect, null, 2),
      case_intent: goldenCase.intent,
      signal_class: goldenCase.signalClass,
      tool_calls_trace: formatToolCallTrace(diagnosisToolCalls), // ★ THE LINE
    },
  });
```

`tool_calls_trace` is what turns the judge from a plausibility-grader
into a confabulation-catcher. Without it, the judge reads a nice-sounding
diagnosis and grades it on prose quality. With it, the judge can check
whether the numbers in the diagnosis actually came from tool results.
The concrete case: baseline case 05 invented "4,820 high-risk customers"
— the judge caught it *because no tool returned that number*. That
would not have been caught by a prose-only judge.

You specified that context payload. Claude wrote the marshalling code.
The distinction is important: this is not "Claude made the eval smart."
It's "you designed the eval smart and Claude typed it up."

## ⑥ do it

1. Open `eval/run.eval.ts`. Do NOT read the whole file. Read only these
   line ranges:
   - `run.eval.ts:220–247` — the diagnosis judge invocation (the context
     payload is the contract hunk)
   - `run.eval.ts:260–275` — the recommendation invocation with the
     diagnosis handoff
   - `run.eval.ts:276–305` — the recommendation judge loop, one judgment
     per recommendation
2. For each hunk, state the contract term it implements and why it's
   load-bearing:
   - Why does the diagnosis judge need `tool_calls_trace`?
     (Answer: confabulation detection. Prose plausibility can't catch
     invented numbers.)
   - Why is there ONE `Diagnosis` handed to `recAgent.propose(...)` and
     N judgments over recommendations (one per rec)?
     (Answer: recs are graded individually, not as a set — a set of 3
     might be 2 great + 1 disaster and the failure has to be findable.)
   - Why is the substrate injected instead of hard-coded to Bloomreach?
     (Answer: the whole eval runs deterministic and offline via
     `SyntheticDataSource` — no OAuth, no rate limit, no flakes.
     Substrate pluggability is the design.)
3. Run `npm run eval` end-to-end (10 cases, ~$1.30, ~7 minutes at p50
   225s/case, but usually less because judges parallelize). If cost is a
   concern, `CASE=02 npm run eval:run` runs one case. Read one receipt
   from `eval/receipts/` and confirm each field is what your contract
   promised.

## ⑦ done when

- You can point at the specific line in `run.eval.ts` that implements
  each of the contract's terms (input, substrate, judge context, receipt
  path, aggregate).
- You can name the *one line* that carries the load-bearing choice — the
  `tool_calls_trace` in the judge's context payload — and say why it
  turns the judge from a plausibility grader into a confabulation
  catcher.
- One case flows through the loop end-to-end and its receipt is readable
  from disk (`eval/receipts/*-<runId>.json`).
- You can say the sentence *"Claude wrote the harness against my
  contract; the smoke test is the trust signal, not the authorship"*
  without flinching.
