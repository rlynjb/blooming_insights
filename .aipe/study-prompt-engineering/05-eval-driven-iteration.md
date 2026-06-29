# Eval-driven prompt iteration

**Industry standard** · the discipline blooming hasn't shipped yet

## Zoom out — where the eval layer would sit

blooming has type guards on the model output (`lib/mcp/validate.ts`), 221 passing Vitest tests, and committed demo snapshots in `lib/state/demo-*.json`. What it does *not* have is an eval set — a curated collection of (input, expected output) cases that runs against the agents and produces a regression-trackable score. The eval/ folder was retired (PR #8). This concept is the honest case for what would go in its place, and why the discipline matters more than any single technique downstream.

```
  Zoom out — where evals would slot in

  ┌─ Prompt template ────────────────────────────────────────┐
  │  lib/agents/legacy-prompts/monitoring.md                  │
  └────────────────────────────┬─────────────────────────────┘
                               │  changes
  ┌─ ★ NOT YET EXERCISED ★ ───▼─────────────────────────────┐ ← we are here
  │  eval set:                                                │
  │    (input, expected output, scoring fn) × N cases         │
  │    run before merging the prompt change                   │
  │    diff scores · keep if up, regress check before merge   │
  └────────────────────────────┬─────────────────────────────┘
                               │  pass
  ┌─ Type guards ──────────────▼─────────────────────────────┐
  │  lib/mcp/validate.ts                                      │
  │  → checks shape only · NOT behavior                       │
  └────────────────────────────┬─────────────────────────────┘
                               │
  ┌─ Vitest suite (221 tests) ─▼─────────────────────────────┐
  │  test/agents/* · test/mcp/*                               │
  │  → tests pure logic + agent loops with fakes              │
  │  → does NOT call real model · is NOT an eval              │
  └──────────────────────────────────────────────────────────┘
```

## Zoom in

The senior-vs-junior dividing line on prompt work is the eval set. A junior iterates by vibes ("the response feels better now"). A senior iterates against a regression-trackable suite of cases with expected outputs. blooming's prompts have been iterated by vibes — the demo snapshots are a partial substitute but not a full eval, and changing a prompt today means hand-checking a few briefings and shipping if they look OK. That works at this scale. It will not survive a model upgrade.

## Structure pass

**Layers.** Three altitudes of "what's verified about model behavior" exist in this codebase today: the *type guards* (shape, at the model-output boundary), the *Vitest suite* (logic + agent loops with fakes, no real model), and the *demo snapshots* (committed captures, manual visual review). Each verifies something useful; none of them is an eval set.

**Axis traced — what's actually verified.** Hold one question constant: *if I change the system prompt, what test will catch a regression?*

```
  Axis = "what catches a prompt-change regression?"

  ┌─ type guards (lib/mcp/validate.ts) ────────────────────┐
  │   catches: returned shape is wrong (e.g. missing field)│
  │   misses:  shape right, but content semantically wrong  │
  │            (e.g. wrong severity, hallucinated metric)   │
  └─────────────────────────────────────────────────────────┘
                              │
  ┌─ Vitest (test/agents/*) ──▼────────────────────────────┐
  │   catches: the agent loop wires fakes correctly         │
  │            the parser/guard handle edge cases           │
  │   misses:  anything about the real model's behavior     │
  │            (tests use injected fakes — no Anthropic call)│
  └─────────────────────────────────────────────────────────┘
                              │
  ┌─ demo snapshots (lib/state/demo-*.json) ──▼────────────┐
  │   catches: the UI renders captured data correctly       │
  │   misses:  whether the captured data was good           │
  │            (snapshots are "what the agent did," not     │
  │             "what it should have done")                 │
  └─────────────────────────────────────────────────────────┘
```

**Seams.** The eval-set seam is the missing one: a layer that catches *behavior* regressions — the model returned the right shape and the right number of items, but the wrong items, with the wrong severity, or invented an evidence number. Without that layer, a prompt change can ship that satisfies every test in the suite and breaks the product semantically. The reader has felt this exact bug shape before in any project with content generation; this is where the formal discipline goes.

## How it works

### Move 1 — the eval loop, as one picture

You know how unit tests work: a function, an input, an expected output, a comparison. Evals are the same shape, scaled to whole-agent behavior. The function is the agent. The input is (anomaly | diagnosis | query). The expected output is what a domain expert says is right — typically captured as "this is acceptable, this is not." The comparison is either deterministic (exact match on key fields) or LLM-as-judge (a separate model call that scores the answer against a rubric).

```
  Eval loop — the pattern that doesn't yet exist in this repo

  ┌─ golden set (20-50 hand-curated cases) ─────────────────┐
  │   case 001: { input: anomaly_X,                         │
  │              expected: { hypotheses: ≥3 tested,         │
  │                          conclusion mentions device },  │
  │              tolerated: { time_series may vary } }      │
  │   case 002: ...                                          │
  └──────────────────────────────┬──────────────────────────┘
                                 │  on prompt change
  ┌─ run the agent ──────────────▼──────────────────────────┐
  │   for each case:                                         │
  │     output = await agent.investigate(case.input)         │
  │     score  = check(output, case.expected, case.tolerated)│
  │   collect scores                                         │
  └──────────────────────────────┬──────────────────────────┘
                                 │
  ┌─ compare to baseline ────────▼──────────────────────────┐
  │   diff: new_scores - baseline_scores                     │
  │   pass: avg improved AND no critical case regressed      │
  │   fail: avg flat/worse OR critical regression            │
  └──────────────────────────────┬──────────────────────────┘
                                 │
  ┌─ decide ─────────────────────▼──────────────────────────┐
  │   pass → merge the prompt change + bump baseline         │
  │   fail → don't merge · investigate the regressed cases   │
  └──────────────────────────────────────────────────────────┘
```

### Move 2 — what the type guards do NOT catch

Read the `isAnomalyArray` guard at `lib/mcp/validate.ts:17-27`:

```
  // lib/mcp/validate.ts:17-27 — shape check only
  return Array.isArray(v) && v.every((a) =>
    !!a && typeof a === 'object' &&
    typeof (a as any).metric === 'string' &&    // ← any string passes
    Array.isArray((a as any).scope) &&           // ← any array passes
    !!(a as any).change && typeof (a as any).change.value === 'number' &&  // ← any number
    ((a as any).change.direction === 'up' || (a as any).change.direction === 'down') &&
    typeof (a as any).change.baseline === 'string' &&
    SEVERITIES.includes((a as any).severity)
  );
```

The guard passes if `metric: "xyzzy"` (made-up word), if `scope: ["potato"]`, if `change.value: 999999`, if `change.baseline: "totally fabricated period"`. It checks *shape*, not *content*. A prompt change that causes the model to hallucinate metric names and invent baselines passes the guard. The Vitest suite (which uses injected fakes) doesn't catch it either — the fakes return whatever the test author wrote, not what the real model would return.

This isn't a knock on the guard; the guard is doing exactly the job it should do (degrade safely on shape mismatch). It's a statement about *what additional layer is needed* to catch behavior regressions.

### Move 2 — what an eval would look like, concretely

The agents this codebase ships are amenable to evals because they produce structured output. A monitoring agent eval case would look something like this:

```
  Case shape — a single monitoring-agent eval case

  ┌─ inputs ────────────────────────────────────────────────┐
  │   schema:     known synthetic workspace (committed)      │
  │   categories: ['revenue_drop', 'conversion_drop']        │
  │   dataSource: deterministic fake returning planted        │
  │               EQL results (e.g. revenue down 30%)         │
  └─────────────────────────────────────────────────────────┘

  ┌─ expected ──────────────────────────────────────────────┐
  │   array.length:           ≥ 1                           │
  │   first.metric:           'purchase_revenue'            │
  │   first.category:         'revenue_drop'                │
  │   first.severity:         'critical'  (because >20%)    │
  │   first.change.direction: 'down'                        │
  │   first.change.value:     close to 30 (±5)              │
  │   first.impact:           contains 'revenue' (semantic)  │
  └─────────────────────────────────────────────────────────┘

  ┌─ tolerated ─────────────────────────────────────────────┐
  │   evidence[].result detail (model picks the wording)     │
  │   impact wording (model writes prose; just check it      │
  │   mentions the right metric)                             │
  └─────────────────────────────────────────────────────────┘
```

The discipline in the case shape: **expected** holds what *must* be right (metric, severity, direction), **tolerated** holds what's allowed to vary (wording, evidence detail). Without the tolerated bucket, every minor model drift fails the case and you stop trusting the suite. With only the tolerated bucket, the suite catches nothing.

### Move 2 — the golden set vs the regression suite

Two flavors of eval, both useful, neither in this repo today:

**Golden set** — 20-50 hand-curated cases chosen for *coverage*. One case per anomaly type the monitoring agent should detect. One case per common diagnosis pattern (device-specific, country-specific, campaign-driven). One case per recommendation feature (scenario, campaign, voucher, experiment). The goal is to verify the agent handles the full spectrum of expected inputs. You write it once; you maintain it as the product evolves.

**Regression suite** — every production failure, added as a case, forever. When a user reports "the monitoring agent missed the revenue drop in December," capture the inputs (schema, categories, data) and the expected output (a critical revenue_drop anomaly with these properties), add it to the suite. Even if you fix the issue today, the case stays — to make sure no future prompt change accidentally re-introduces the same bug.

```
  Two suites, two jobs

  ┌─ golden set ────────────────────────────────────────────┐
  │   coverage-driven · maintained for representativeness    │
  │   "do we handle every expected input shape?"             │
  └─────────────────────────────────────────────────────────┘

  ┌─ regression suite ──────────────────────────────────────┐
  │   incident-driven · grows monotonically over time        │
  │   "do we still NOT have the bugs we already fixed?"      │
  └─────────────────────────────────────────────────────────┘
```

### Move 2 — when LLM-as-judge is the right tool

For monitoring + diagnostic + recommendation, the structured output makes most checks deterministic: severity is one of four values, direction is up or down, category is a known id, dollar ranges are within bounds. You can write the check in TypeScript. No LLM-as-judge needed.

For the *query* agent — which returns prose — deterministic checks are harder. "Did the answer mention the right number?" is a regex; "Did the answer interpret the question correctly?" is not. That's where LLM-as-judge earns its place: a separate model call (typically cheaper, like Haiku) that scores the answer against a rubric ("Does this answer the user's question about country breakdown? Does it cite a real number? Does it acknowledge if it couldn't get the data?"). LLM-as-judge has known failure modes (the judge has the same blind spots as the judged), so for safety-critical evaluation you triangulate: deterministic where you can, judge where you must, manual review on a sample.

blooming's query agent is the natural eval target if and when the team writes an eval. The other four agents could be evaluated deterministically.

### Move 2 — iteration loop, what changes

When you have an eval set, the iteration loop for a prompt change looks different:

```
  Without eval set (today):                With eval set:
  ──────────────────────                   ─────────────
  1. edit monitoring.md                    1. edit monitoring.md
  2. spin up dev                           2. npm run eval:monitoring
  3. trigger a briefing manually           3. read the score diff
  4. eyeball the cards                     4. inspect regressed cases (if any)
  5. "looks good" → ship                   5. iterate or ship based on numbers
```

The today-path takes 5 minutes per iteration. The with-eval path takes 5 minutes for the first run and seconds for each subsequent iteration. More importantly, the with-eval path lets you A/B prompt variants ("does adding this sentence about edge cases improve the score?") without leaving the IDE.

The model-upgrade scenario is where the eval set earns its keep. Anthropic ships Sonnet 4-7; you bump the constant in `base.ts`. Without an eval, you ship and wait for users to complain. With an eval, you run the suite, see the diff (probably some regressions, some improvements), and decide whether to ship the upgrade, adjust the prompts, or pin to the old model until you can.

### Move 2 — why "I'll write evals later" is wrong

The default failure mode on evals: "we'll add them once the product stabilizes." The reasoning sounds right (why test against a moving target?) and is exactly backwards. *The reason* the product can't stabilize is that there's no way to verify a change without breaking something else. Evals are how you make iteration converge. Without them, every prompt change is a gamble; every model upgrade is a crisis; every "small tweak" risks a regression nobody catches until a user reports it weeks later.

Hamel Husain's writing on this lands hard: *the gap between teams that ship LLM features and teams that ship reliable LLM features is the eval set*. Not the model choice, not the prompt cleverness, not the framework. The eval set. blooming is in the "shipped" column; it isn't yet in the "shipped reliably" column.

### Move 3 — the principle

Eval-driven iteration is the discipline that turns prompt engineering from a craft into engineering. Type guards verify shape; tests with fakes verify logic; only an eval set verifies *behavior*. Skip it and you'll iterate in circles — confident the prompt is good because no test caught a problem, blindsided when the model behaves differently against real inputs the test fakes never covered.

## Primary diagram

```
  Eval-driven iteration — the missing layer in blooming, sized to context

  ┌─ Prompt change PR ─────────────────────────────────────────┐
  │   diff lib/agents/legacy-prompts/monitoring.md              │
  │   diff lib/agents/base.ts (AGENT_MODEL change)              │
  └───────────────────────────┬────────────────────────────────┘
                              │
                              ▼   ★ THIS BLOCK DOESN'T EXIST YET ★
  ┌─ Eval run ─────────────────────────────────────────────────┐
  │   Golden set:    20-50 cases × 3 agents = ~100 model calls │
  │   Regression:    every prod failure ever, grows over time   │
  │                                                              │
  │   Per case:                                                  │
  │     run agent against synthetic input + deterministic fake   │
  │     score against expected (deterministic where possible,    │
  │       LLM-as-judge for prose-mode agents like query)         │
  │   Output:                                                    │
  │     score diff vs baseline · list of regressed cases         │
  └───────────────────────────┬────────────────────────────────┘
                              │
                              ▼   what exists today
  ┌─ Verification today ───────────────────────────────────────┐
  │   type guards    (shape)       lib/mcp/validate.ts          │
  │   vitest         (logic+fakes) test/agents/*                │
  │   demo snapshots (visual)      lib/state/demo-*.json        │
  │   manual eyeballing                                          │
  └───────────────────────────┬────────────────────────────────┘
                              │
  ┌─ Decision ─────────────────▼───────────────────────────────┐
  │   today: "looks good in dev" → ship                         │
  │   with eval: scores up + no critical regression → ship      │
  └────────────────────────────────────────────────────────────┘
```

## Elaborate

The retired eval/ folder (PR #8) had a different shape — it was experimentation infrastructure that never produced a stable suite. Removing it was right; what replaces it is not "no evals" but "evals that earn their place." The right next step here isn't to reinstate the old folder; it's to start small with one suite for one agent (the monitoring agent is the natural pick — most structured, most testable, most user-visible), build the case format, build the runner, build the score-diff reporter. Once one agent is covered, the second is a copy-and-adjust.

The demo snapshots (`lib/state/demo-*.json`) are the closest thing this codebase has to captured behavior. They're not an eval set (no expected outputs, no scoring), but they're real captures of real agent runs against the real workspace. They're a *fixture library* waiting for a test runner. The smallest possible move toward eval-driven iteration is: take one snapshot, write down what the agent *should* have output, write a check that compares. That's one case. Repeat until the suite is interesting. The discipline grows from there.

The LLM-as-judge tradeoff is worth naming explicitly: the judge has the same blind spots as the judged. A judge that's an LLM evaluating an LLM's output for "factual accuracy" can't tell you anything about facts the judge model doesn't already know. The best uses of judge are for things where the judge has *more* context than the judged — e.g. the judge sees the original question + the answer + a known-good reference answer, and the question is just "does the candidate answer match the reference on these dimensions?" That's a comparison task, which judges are good at. "Is this answer factually correct in isolation?" is not a comparison task, and judges are bad at it. Use accordingly.

Eugene Yan's blog has good material on building evals; the Latent Space podcast episode with Hamel Husain on the eval discipline is worth the hour. The pattern across all of them: start narrow, score on what you can check deterministically first, add LLM-as-judge only where it earns its place, treat the suite as an asset that grows over time. The cost of starting is small; the cost of *not* starting compounds with every prompt change you ship blind.

## Interview defense

**Q: blooming has 221 tests and type guards. Why is that not enough?**

A: The 221 tests check that the agent loops wire fakes correctly and that the parser handles edge cases — they don't make a single real model call. The type guards check that the model's output is the right shape — `severity` is one of four strings, `change.value` is a number — they don't check that the severity is *correct* or the number is *right*. So today, a prompt change that causes the model to confidently emit `{ metric: 'fabricated_metric', severity: 'critical', change: { value: 99, direction: 'down' } }` passes every test in this repo. The shape is right; the content is fabricated. An eval set is the layer that catches that — a curated set of (input, expected output) cases that runs against the real model and scores the result against what a domain expert says is correct. Without it, prompt iteration is gambling.

```
  what I'd sketch:

  shape correct  ──►  type guards say YES
  shape correct  ──►  vitest says YES (fakes return planted data)
  shape correct  ──►  eval says NO ("metric should be purchase_revenue,
                                     not fabricated_metric")

  three layers, three different jobs.
  blooming has two of three; the third is the missing piece.
```

**Q: How would you start adding evals here — what's the first move?**

A: Take the demo snapshots in `lib/state/demo-*.json` and treat them as a fixture library. For one snapshot, write down what the monitoring agent *should* have produced — the metric, the category, the severity band, the direction. That's case 001. Write a small runner that re-runs the monitoring agent against the same input (the schema + categories + a deterministic fake `DataSource`), parses the output, and scores it against the expectation. One case, one runner, ~50 lines of TypeScript. Run it before merging any change to `monitoring.md` or `base.ts`. Add a second case the next time you find a production failure; add a third the next week. Don't try to write 50 cases up front — write the smallest possible suite that catches one regression, then grow it as failures teach you what's worth checking. The first case earns its place when it catches its first regression.

```
  start small, grow under pressure:

  week 1:  1 case · 50 lines of runner · pass/fail boolean
  week 4:  5 cases · score-diff reporter · CI integration
  month 3: 20 cases · 3 agents covered · ratchet on each merge

  not:  build 50-case suite in a quarter and never use it.
```

## See also

- [02-structured-outputs.md](./02-structured-outputs.md) — the type guards this concept is layered on top of
- [03-prompts-as-code.md](./03-prompts-as-code.md) — evals are how prompt-code changes get reviewed in code-review terms
- [10-self-critique.md](./10-self-critique.md) — the one-turn recovery is a runtime substitute for some failure modes evals would catch
