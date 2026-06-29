# Self-critique and self-consistency

**Industry standard** · the recovery turn vs the full eval-then-revise loop

## Zoom out — where self-critique sits in this codebase

blooming has one self-critique-shaped thing: the one-turn tool-less recovery in `runAgentLoop`. When the agent's final answer doesn't parse against the type guard, the loop runs one *additional* tool-less turn with a synthesis instruction, and re-parses. That's a stripped-down form of self-critique: not "evaluate your output and revise" but "your output didn't parse — try again with a stricter focus." Full self-critique (model judges its own output against a rubric, revises) and self-consistency (run N times, vote) are not in this codebase.

```
  Zoom out — what's actually here vs what self-critique can become

  ┌─ what's here: the recovery turn ────────────────────────┐
  │  base-legacy.ts:208-219 + 239-269                        │
  │  on parse failure → one tool-less turn with synthesis    │
  │  cost: ~1 extra model call (worth it: avoids dropped     │
  │         briefings)                                       │
  └─────────────────────────────────────────────────────────┘

  ┌─ what's NOT here ──────────────────────────────────────┐
  │  full self-critique:                                    │
  │    "evaluate your output against this rubric and        │
  │     revise if it falls short"                           │
  │  self-consistency:                                      │
  │    run the same prompt 5x, vote on the answer           │
  └─────────────────────────────────────────────────────────┘
```

## Zoom in

Self-critique is the pattern where you ask the model to evaluate its own output against a rubric and revise. Self-consistency is the pattern where you run the same prompt N times and vote on the answer. Both cost 2-5x the token budget for one extra dimension of reliability. Both have a known weakness: the critic and the doer have the same blind spots. This concept covers the trimmed-down version blooming uses (recovery turn for parse failures), why the full versions aren't in place yet, and when they'd earn their place.

## Structure pass

**Layers.** Three altitudes: *no retry* (single-shot, accept what you get), *parse-retry* (one extra turn if the output doesn't parse — what blooming does), *self-critique* (model evaluates the answer's quality and revises if needed).

**Axis traced — cost vs reliability.** Hold one question constant: *how much extra do I pay for one more dimension of confidence?*

```
  Axis = cost per reliability dimension

  ┌─ single-shot ────────────────────────────────────────────┐
  │   1× cost                                                 │
  │   reliability: shape-pass rate (whatever the model gives) │
  └──────────────────────────────────────────────────────────┘
                              │  + ~1× cost
  ┌─ parse-retry (today) ────▼───────────────────────────────┐
  │   ~1.1× cost (only on miss, ~5-10% of calls)              │
  │   reliability: shape-pass rate ↑ (recovery catches some)  │
  │   what blooming has                                       │
  └──────────────────────────────────────────────────────────┘
                              │  + 1-2× cost
  ┌─ self-critique ──────────▼───────────────────────────────┐
  │   2-3× cost (on every call, not just misses)              │
  │   reliability: quality dimension (rubric-pass rate)       │
  │   not in this codebase                                    │
  └──────────────────────────────────────────────────────────┘
                              │  + 4× cost
  ┌─ self-consistency ───────▼───────────────────────────────┐
  │   5× cost                                                 │
  │   reliability: majority-vote agreement                    │
  │   not in this codebase                                    │
  └──────────────────────────────────────────────────────────┘
```

**Seams.** The parse-success → parse-failure seam is where blooming's recovery turn fires. The output → judge seam is where full self-critique would fire (and doesn't, in this codebase). The "did the model produce something usable" question is well-covered today; the "did the model produce something *good*" question is not.

## How it works

### Move 1 — the parse-retry pattern, as one picture

You know how a transactional database retries a deadlock by re-running the transaction? The recovery turn is the LLM equivalent for shape failures. The loop ran, the model produced text, the parser tried to extract structured output, the parser failed. Instead of giving up, run one more turn with no tools and an explicit "your output didn't parse — emit ONLY the structured answer" instruction. Re-parse the new output. If it parses, return it; if not, accept the failure.

```
  Pattern — the recovery turn

  ┌─ main loop runs ────────────────────────────────────────┐
  │   N turns of (assistant → tool_use → tool_result)        │
  │   final assistant turn → text                            │
  └──────────────────────────────┬──────────────────────────┘
                                 │  finalText
  ┌─ try to parse + validate ───▼───────────────────────────┐
  │   parsed = parseResult(finalText)                        │
  │   if (parsed !== null) return parsed   ← happy path      │
  └──────────────────────────────┬──────────────────────────┘
                                 │  parsed === null
  ┌─ recovery turn ──────────────▼──────────────────────────┐
  │   recoveryText = await runRecoveryTurn(opts,             │
  │                    recoveryPrompt(toolCalls))            │
  │   parsed = parseResult(recoveryText)                     │
  │   return parsed                       ← might still fail │
  └──────────────────────────────────────────────────────────┘
```

### Move 2 — the recovery turn in code

The recovery hook lives in `lib/agents/base-legacy.ts:208-219`:

```
  // base-legacy.ts:208-219 — recovery wired into the loop
  let parsed: T | null = null;
  if (opts.parseResult) {
    parsed = opts.parseResult(finalText);
    if (parsed === null && opts.recoveryPrompt) {
      const recoveryText = await runRecoveryTurn(
        opts,
        opts.recoveryPrompt(toolCalls)
      );
      parsed = recoveryText === null ? null
              : opts.parseResult(recoveryText);
    }
  }
  return { finalText, toolCalls, parsed };
```

Two conditions gate the recovery turn: the caller passed `parseResult` (so the loop knows what counts as parseable) AND the caller passed `recoveryPrompt` (so the loop knows what to ask on retry). Either omitted, no recovery — the loop is the legacy single-shot version. Callers that opt in get the safety net; callers that don't, don't.

The recovery turn itself is at lines 239-269:

```
  // base-legacy.ts:239-269 — the recovery turn (simplified)
  async function runRecoveryTurn(opts, recoveryUserContent) {
    try {
      opts.signal?.throwIfAborted();
      const res = await opts.anthropic.messages.create({
        model: AGENT_MODEL,
        max_tokens: 2048,            ← smaller cap than main loop
        system:
          'You are concluding a completed investigation. Output ' +
          'ONLY the structured answer in the requested shape. ' +
          'Never ask for more data.',
        messages: [{ role: 'user', content: recoveryUserContent }],
      }, opts.signal ? { signal: opts.signal } : undefined);
      console.log(JSON.stringify({
        site: 'agents/base:runRecoveryTurn',
        sessionId: opts.sessionId,
        usage: res.usage
      }));
      return res.content.filter(b => b.type === 'text')
                        .map(b => b.text).join('');
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') throw err;
      return null;
    }
  }
```

Three things to notice. **No tools** — the recovery turn doesn't pass `tools`, so the model literally cannot call another tool. The only thing it can do is produce text. **Smaller max_tokens** — 2048 instead of 4096; the recovery output should be the structured answer, not another exploration. **Hard-coded system message** — "You are concluding a completed investigation. Output ONLY the structured answer." This is the stricter system prompt the spec calls for: when shape failed once, the recovery prompts tightens the screws.

The cost: roughly one extra model call per failed parse. If parse-fail rate is 5-10% (which feels right for this codebase based on the demo snapshots and informal observation), the average cost overhead is 5-10% on top of the base call cost. Worth it: the alternative is the route returning an empty array and the user seeing an empty briefing.

### Move 2 — what recovery does NOT catch

The recovery turn is a *shape* retry, not a *quality* retry. If the model emits:

```
  {
    "metric": "fabricated_metric",
    "severity": "critical",
    "change": { "value": 99, "direction": "down", "baseline": "90d" },
    "evidence": []
  }
```

The shape is valid. The type guard passes. The recovery turn doesn't fire. The product ships an anomaly the model invented — confidently, with a critical severity, against a fabricated metric. The recovery turn catches "the model rambled and forgot to emit JSON"; it does not catch "the model emitted clean JSON with garbage content."

That's the gap full self-critique would fill, and it's the gap eval-driven iteration (concept #5) would fill differently. Self-critique catches it at runtime, per-call; evals catch it at iteration time, per-prompt-change. Neither is in this codebase today.

### Move 2 — what full self-critique would look like

Full self-critique would add a second model call after the agent produces its output:

```
  Hypothetical self-critique flow (not implemented)

  ┌─ agent produces output ─────────────────────────────────┐
  │   diagnosis = { conclusion: "...",                       │
  │                 hypothesesConsidered: [...], ... }       │
  └──────────────────────────────┬──────────────────────────┘
                                 │
  ┌─ critic call ────────────────▼──────────────────────────┐
  │   prompt:                                                │
  │     "Evaluate this diagnosis against these criteria:     │
  │      - Are the hypotheses concrete and testable?         │
  │      - Does the evidence support the conclusion?         │
  │      - Are affected customers quantified where possible? │
  │      Return: { passes: bool, issues: string[] }"         │
  │   ↳ separate model call (could be cheaper model)         │
  └──────────────────────────────┬──────────────────────────┘
                                 │  passes? → return original
                                 │  fails? → revise call
  ┌─ revise call (if needed) ────▼──────────────────────────┐
  │   prompt:                                                │
  │     "Here is the diagnosis. Here are the issues found.   │
  │      Revise the diagnosis addressing each issue."        │
  └──────────────────────────────────────────────────────────┘
```

Cost: 2-3× the base call cost (one critic call always, one revise call sometimes). Worth it when: the output is *hard to manually verify* (long diagnoses with many fields), the output is *high-stakes* (recommendations that affect real campaigns), or *low-trust* (the model is one you're piloting and want extra safety on).

The reason it isn't in blooming: the structured output already constrains a lot of the failure modes self-critique would catch (the type guard rejects bad shape, the prompt's rules pin severity thresholds, the evidence field requires the model to cite tool calls), and the cost/benefit hasn't moved enough to justify the extra latency (the briefing already takes 30+ seconds; adding 10+ seconds for self-critique on every step would be felt). If the agents start producing higher-stakes outputs (auto-executing recommendations, for example), self-critique becomes more attractive.

### Move 2 — self-consistency, the multi-sample version

Self-consistency is a different shape: run the same prompt N times (typically 3-5), collect the outputs, vote on the answer (majority or most-common). The cost is N× the base call cost. The benefit is robustness — a single model run might pick a fluke; five runs are more likely to converge on the correct answer.

This works well for:
- Classification (intent picker) — vote on the label
- Numerical answers (rare in blooming) — vote or average
- Decision tasks where the answer is one of a small set

It works poorly for:
- Open-ended generation (the query agent's prose) — five different prose answers don't combine
- Long structured outputs (diagnosis with many fields) — voting per-field is awkward

blooming doesn't use it. The intent classifier is the natural place it would land (run Haiku 3 times, pick the majority label) — but the classifier is already cheap, fast, and accurate enough that the 3× cost wouldn't earn its place. If the intent classifier started misrouting more than ~2% of queries, this would be the next move.

### Move 2 — the diminishing-returns problem

The spec calls this out explicitly: a model critiquing its own output has the same blind spots that produced the output. If Sonnet produced a diagnosis with a subtle factual error, Sonnet (as the critic) probably won't catch it — it would believe its own analysis. The fix is using a *different* model as the critic (Haiku critiquing Sonnet, or vice versa), which gets you a different angle on the output but also a different (often weaker) set of blind spots.

The deeper truth: self-critique is good at catching *shape* errors and *internal inconsistency* (the conclusion says X, the evidence says Y). It's bad at catching *fabrication* (the model confidently asserts something that isn't true; the critic looks at the assertion and asks "is this internally consistent?" and the answer is yes). Evals against ground truth catch fabrication; self-critique doesn't. They're complementary, not substitutable.

### Move 3 — the principle

Self-critique trades cost for reliability *along one specific dimension* — typically internal consistency or rubric compliance. It doesn't trade for *correctness* (the critic shares the doer's blind spots). Use it where the cost is worth the reliability gain and the failure mode you're catching is the consistency kind, not the fabrication kind. blooming's recovery turn is the trimmed version that catches the most common failure (parse failure) at the lowest cost; full self-critique is on the table when the stakes go up.

## Primary diagram

```
  Self-critique surface — what's here, what's not, what's it cost

  ┌─ today: the recovery turn ─────────────────────────────────────┐
  │  base-legacy.ts:208-219 wires recovery into the loop            │
  │  base-legacy.ts:239-269 implements runRecoveryTurn              │
  │                                                                  │
  │  main loop                                                       │
  │    ↓ produces finalText                                          │
  │  parseResult(finalText) → null?                                  │
  │    ↓ YES                                                         │
  │  runRecoveryTurn:                                                │
  │    - no tools (model can't query)                                │
  │    - smaller max_tokens (2048)                                   │
  │    - strict system: "output ONLY the structured answer"          │
  │    ↓ produces recoveryText                                       │
  │  parseResult(recoveryText) → ?                                   │
  │                                                                  │
  │  cost: ~5-10% overhead (only fires on parse failure)             │
  │  catches: shape errors (model rambled or forgot fence)           │
  │  misses: content errors (model fabricated cleanly)               │
  └────────────────────────────────────────────────────────────────┘

  ┌─ not here: full self-critique ─────────────────────────────────┐
  │  would add: separate critic call after every agent run          │
  │  cost: 2-3× per call                                            │
  │  would catch: internal inconsistency · rubric violations        │
  │  doesn't earn place yet: structured output + type guards        │
  │                          already constrain most failures        │
  │  would earn place if: stakes go up (auto-execute), or model     │
  │                       changes to one with looser shape compliance│
  └────────────────────────────────────────────────────────────────┘

  ┌─ not here: self-consistency ───────────────────────────────────┐
  │  would add: run same prompt N times, vote                       │
  │  cost: N×                                                       │
  │  works for: classifiers, decision tasks                         │
  │  doesn't earn place yet: intent classifier is already accurate  │
  │                          enough; structured agents have outputs │
  │                          too rich to vote on                    │
  └────────────────────────────────────────────────────────────────┘
```

## Elaborate

The recovery turn is a kind of *minimum-viable self-critique*. It doesn't ask the model "is your output good?" — it asks "did you give me parseable output? if not, try again with no distractions." The minimal version catches the most common failure (a chatty model wrapped the JSON in unparseable preamble, or the model got cut off mid-output and the JSON is malformed) at the lowest cost (one extra call per failure, not one extra call per success). It's the kind of pragmatic engineering choice that distinguishes shipped systems from research demos — the research literature talks about self-consistency with N=5 and rubric-based critique; production systems mostly do parse-retries and call it a day.

The full self-critique pattern earns its place in higher-stakes systems. Anthropic's own constitutional AI work uses self-critique at scale — but they're training models, not running production agents. For application-layer self-critique, the pattern shows up most often in safety filters (run the model, run a separate safety-classifier on the output, block if flagged) rather than in quality-improvement loops. The safety-filter version is a relative of self-critique that blooming also doesn't have — and probably should consider once the agents are running on real customer data (the query agent in particular could emit something the user shouldn't see in some edge case).

Self-consistency's main production use today is in math/code generation, where the answer is unambiguous (the code runs or it doesn't; the math is right or wrong) and the model's first sample is often close but slightly wrong. For analytics agents, the outputs are more interpretive — what counts as a "good" anomaly description is fuzzy — and voting on prose answers doesn't make sense. blooming's structured outputs (Anomaly, Diagnosis, Recommendation) are the kind of thing where per-field voting could be made to work (vote on severity, vote on category, average the change.value) but the engineering complexity isn't paying off the way it does for math problems.

The diminishing-returns warning is the part that catches teams off guard. You add self-critique, you ship it, you measure the accuracy improvement — and it's smaller than expected. Then you look at what's still failing and realize the critic is reliably approving outputs that turn out to be wrong, because the critic uses the same internal model that produced the output. The fix is either to use a *different* model as the critic (which has its own blind spots) or to use a *non-model* critic (a deterministic check, an external API, a human reviewer). For most production use cases, the deterministic check (which is what the type guard is) gets you 80% of the value at 10% of the cost.

## Interview defense

**Q: blooming has a "recovery turn" — is that self-critique?**

A: It's a stripped-down version: the model's output didn't parse against the type guard, so the loop runs one more tool-less turn with a stricter system prompt ("output ONLY the structured answer, never ask for more data") and re-parses. It's catching one specific failure mode — the model rambled, forgot the fence, or got cut off mid-output — at low cost (only fires on parse failure, ~5-10% of calls). Full self-critique would be a separate critic call after *every* agent run, evaluating the output against a quality rubric and revising if it falls short. That'd cost 2-3× per call, every call, not just on misses. blooming doesn't have it because the structured output + type guards already constrain a lot of the failures self-critique would catch, and the latency budget on a briefing is already tight. The recovery turn is the engineering pragmatic version: catch the most common failure cheaply; don't pay for a full critique on every call.

```
  what I'd sketch:

  parse-retry (today):       cost: ~5-10% overhead
                              catches: shape errors
                              cheap insurance · ships

  full self-critique:        cost: 2-3× every call
                              catches: rubric/consistency errors
                              earns place when stakes go up
```

**Q: When would self-consistency (running N times and voting) be worth adding?**

A: For the intent classifier, if accuracy slipped. It's a classification task with a small label space (3 values), each call is cheap (Haiku, 16 tokens), and voting is well-defined (most-common label wins). Three runs would cost ~$0.0003 instead of $0.0001 per classification — still fractions of a cent — and could catch the ~2% of edge cases where the single-shot version misroutes. The structured agents (monitoring, diagnostic, recommendation) are worse fits because their outputs are too rich to vote on coherently (you'd be voting on each field independently, which is awkward, or you'd be picking one whole output, which discards the diversity that made the multi-sample worthwhile). For prose outputs (the query agent), self-consistency is essentially meaningless — five different prose answers don't combine into a "voted" answer. Intent classifier is the one place it could land here, and only if the cheaper single-shot version starts misbehaving.

```
  self-consistency fits when:

  output space is small        ← classifier labels: yes
  outputs combine via vote     ← classification: yes
                                 long structured: no
                                 prose: no
  per-call cost is low         ← haiku classifier: yes
                                 sonnet agent: marginal

  → blooming would add it to the intent classifier first if needed.
```

## See also

- [02-structured-outputs.md](./02-structured-outputs.md) — the type guard whose failure triggers the recovery turn
- [04-token-budgeting.md](./04-token-budgeting.md) — recovery turn uses a smaller max_tokens (2048 vs 4096)
- [05-eval-driven-iteration.md](./05-eval-driven-iteration.md) — evals catch fabrication that self-critique misses
- [09-chain-of-thought.md](./09-chain-of-thought.md) — CoT is reasoning forward; self-critique is reasoning about output
