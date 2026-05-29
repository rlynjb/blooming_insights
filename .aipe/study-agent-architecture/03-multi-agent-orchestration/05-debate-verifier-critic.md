# Debate and verifier-critic

**Industry name(s):** Multi-agent debate, verifier-critic, generator-verifier, producer-judge, LLM-as-judge, evaluator-optimizer
**Type:** Industry standard · Language-agnostic

> Two (or more) agents argue, critique, or judge each other to refine output quality. blooming insights does NOT have a debate or critic agent — `synthesize` retry in `runAgentLoop` is a *forced re-pass* on the same model, not a separate critic. The topology that earns its overhead the day a second perspective measurably catches errors the producer alone misses.

**See also:** → `./03-sequential-pipeline.md` · → `./01-when-not-to-go-multi-agent.md` · → LLM-as-judge bias: `../../study-ai-engineering/05-evals-and-observability/03-llm-as-judge-bias.md` · → systems view: `../../study-system-design-dsa/01-system-design/06-multi-agent-orchestration.md` · → forced-final-turn mechanic: `../01-reasoning-patterns/01-chains-vs-agents.md`

---

## Why care

### Move 1 — the scenario (lead with the shape)

```
The two flavors

  DEBATE (symmetric):              VERIFIER-CRITIC (asymmetric):
  ┌────────┐    ┌────────┐         ┌──────────┐    ┌──────────┐
  │agent A  │◄──►│agent B  │        │ producer │ ──►│ critic   │
  │(propose)│    │(counter)│        │          │ ◄──│(approve/ │
  └────┬───┘    └────┬───┘         └──────────┘    │ reject)  │
       │              │                             └──────────┘
       └──────┬───────┘                    loop until approved
              ▼                            (cap the rounds)
         judge picks
```

You've shipped a feature where the user types a question and your agent answers. Sometimes the answer is wrong in a subtle way — a 200 OK from an API was misinterpreted, a number was correct but the conclusion was inverted. The user doesn't catch it because the answer is confident-sounding. Quality feels like 90% and the 10% is the kind of wrong that's expensive.

You can spot-fix the prompt. Or you can introduce a *second agent* whose only job is to look at the first agent's answer and say "this looks wrong because X" — and have the first agent revise. Two agents collaborating: one produces, one critiques.

### Move 2 — name the question

That second agent — whose only job is to *check* the first agent's output rather than to produce its own — is what verifier-critic names. Two symmetric agents proposing and counter-proposing until a third agent judges is what *debate* names. The question this file answers: **when does adding a second perspective measurably catch errors the producer alone misses, and when does it just double your token bill for no quality gain?**

The job is review, not production. A critic that produces its own answers is just a worse second producer. A critic that *only* says "this output is wrong because X" is doing the job.

### Move 3 — why answering that question matters

**Why you need to answer that question at all:** because second-opinion architecture is one of the most over-applied patterns in agentic systems — and one of the most subtly broken. If the critic shares the producer's blind spots (same model family, same training data, same biases), the critic confidently approves the producer's confident wrong answer. You've doubled your token cost and gotten nothing.

The failure mode: **same model family shares blind spots.** If GPT-4 produces and GPT-4 critiques, the critic has the same self-preference bias the LLM-as-judge literature documents — it'll tend to approve outputs that match its own writing style, miss the same factual errors, and apply the same flawed reasoning. The cross-reference is `../../study-ai-engineering/05-evals-and-observability/03-llm-as-judge-bias.md` for the mechanics. For a critic to add value, it has to be from a *different model family*, or it has to be doing a structurally different job the producer's loop can't do (e.g. running a deterministic schema check the producer can't run on itself).

In this codebase: there's no debate or critic agent. The closest thing is the forced-synthesis turn in `runAgentLoop` — when the budget is spent (`base.ts` L90), the loop strips tools, appends a `synthesisInstruction` to the system prompt, and forces the *same* model on the *same* trajectory to emit its final answer. That's a re-pass, not a critic. The producer is reviewing its own work with no fresh perspective.

### Move 4 — concrete before/after

Without a critic (this codebase):
- Diagnostic agent investigates, produces a `Diagnosis`
- If the model went down a wrong reasoning path during the loop, the final answer reflects that
- The user sees the confident wrong diagnosis and may or may not catch the error
- The only "review" is the forced synthesis — same model, same trajectory

With a critic (hypothetical):
- Diagnostic agent investigates, produces a `Diagnosis`
- Critic agent (different model family — e.g. Sonnet producing, Haiku-or-OpenAI critiquing) reads the diagnosis
- Critic checks: "does the conclusion follow from the evidence? are the hypotheses considered exhaustive? does the affectedCustomers count match the segment description?"
- If critic approves → diagnosis flows to recommendation
- If critic rejects → diagnosis goes back to the diagnostic agent with the critique as additional context
- Loop with a max round count

### Move 5 — one-line summary

A critic is a second agent whose only job is to review the first agent's output; debate is two symmetric agents proposing and counter-proposing under a judge. blooming insights has neither — the closest is the forced-synthesis re-pass in `base.ts` L90, which is the producer reviewing its own work. Here's how the topologies work and why this codebase hasn't reached the breakpoint that justifies them.

---

## How it works

**The mental model: a second perspective applied to the first agent's output.** The key word is *perspective*. If the critic shares the producer's blind spots, the "review" is a rubber stamp. The architecture is only as good as the orthogonality between producer and critic.

```
Producer-critic in one picture

  ┌─────────────┐
  │  Producer   │  agent makes a thing
  │  (Sonnet)   │
  └──────┬──────┘
         │ output
         ▼
  ┌─────────────┐
  │   Critic    │  DIFFERENT model family
  │  (Haiku /   │  (else: same blind spots,
  │   OpenAI)   │   no signal)
  └──────┬──────┘
         │
   approve / reject + reason
         │
  ┌──────┴────────────────────┐
  │                           │
  ▼                           ▼
output ships          loop: producer revises
                       with critique as context
                       (cap rounds)
```

The strategy in plain English: **find an output a second perspective can measurably improve, and use a critic whose perspective is genuinely different.** Otherwise you're paying for a rubber stamp.

### Layer 1 — verifier-critic (the asymmetric shape)

The technical thing: an *asymmetric two-agent loop*. The producer's job is to generate; the critic's job is to evaluate. The critic does not produce alternatives — it returns "approve" or "reject with a reason." The loop terminates when the critic approves (or when the round cap is hit).

If you're coming from frontend, this is a parent component delegating rendering to a child, but with a *validator* in between that checks the child's output before letting it commit to the parent's state. The validator never proposes a new output; it just gates.

```
The verifier-critic loop

  round 1:                         round 2:
   producer.generate() → output_1   producer.revise(output_1, reason) → output_2
       │                                │
       ▼                                ▼
   critic.review(output_1)          critic.review(output_2)
       │                                │
       ▼                                ▼
   { approved: false,               { approved: true }  → ship
     reason: "evidence #2            (or round cap reached)
     contradicts conclusion" }
```

The practical consequence: each round costs one producer call + one critic call. If the critic is a smaller/cheaper model (Haiku reviewing Sonnet output), the per-round cost is mostly the producer. If the critic is the same model, you're paying 2x per round for the same reasoning twice.

The condition under which this works: the critic's review has to identify real errors. Real-world results: critics catch ~10–30% of errors that humans would catch, depending on the orthogonality between producer and critic. The number drops to ~5% when producer and critic are the same model — the rubber-stamp regime.

### Layer 2 — debate (the symmetric shape)

The technical thing: *two symmetric producers* arguing, with a *judge* picking the winner. Agent A proposes; agent B counter-proposes; A counters B; B counters A; after N rounds, a judge agent reads the trajectory and picks the winning answer (or synthesizes a compromise).

If you're coming from frontend, this is two competing renderers proposing different layouts, with a third component deciding which one ships. The asymmetry is in the judge, not the proposers.

```
The debate shape

  round 1:  Agent A: "X because evidence E1, E2"
            Agent B: "Not X — E1 doesn't support X because Y"
  round 2:  Agent A: "B's Y is wrong because Z. Still X."
            Agent B: "Z isn't true. Not X."
  round 3:  Judge:   "A's argument re Z is stronger. X."
                     (or: "both agree on Q, disagree on R. Going with Q.")
```

The practical consequence: debate is the most expensive multi-agent topology per output. Each round costs 2 model calls; N rounds cost 2N + 1 (the judge). Quality gains in the research literature are modest (~3–10% absolute improvement on reasoning benchmarks) unless the producers are from *different* model families.

The condition under which this works: the debaters have to disagree productively, and the judge has to be capable of arbitrating. If both debaters converge after round 1 (which is common when they're the same model), the extra rounds are pure cost. If the judge has the same blind spots as the debaters, the judge picks the wrong winner.

### Layer 3 — the same-model-family blind-spot problem (the failure mode)

The technical thing: *self-preference bias* — when an LLM judges its own output or output from its own family, it tends to rate it higher than it should. Documented across the LLM-as-judge literature; cross-reference `../../study-ai-engineering/05-evals-and-observability/03-llm-as-judge-bias.md`.

If you're coming from frontend, this is asking the developer of a component to code-review their own PR. They'll miss the bugs they put in because their assumptions match. The mitigation: get a reviewer from a different team / training set.

```
Same family vs different family critic

  Same family (rubber stamp):           Different family (real review):
  ┌────────────┐  ┌────────────┐        ┌────────────┐  ┌────────────┐
  │ Sonnet     │  │ Sonnet     │        │ Sonnet     │  │ GPT-4 /     │
  │ produces   ├─►│ critiques  │        │ produces   ├─►│ Haiku /     │
  │            │  │ (mostly    │        │            │  │ Gemini      │
  │            │  │ approves)  │        │            │  │ critiques   │
  └────────────┘  └────────────┘        └────────────┘  └────────────┘
                                                              │
   catch rate: ~5%                       catch rate: ~10–30%  │
                                                              ▼
                                                       worth it when error
                                                       cost > critic cost
```

The practical consequence: if you're going to add a critic, use a different model family OR a *structurally* different evaluator (a deterministic schema check, a unit test, a fact-lookup against a known database). A "ask the same model to critique its own output" architecture is the failure mode this section names.

The condition under which a critic adds real value: the critic is doing something the producer's own loop can't do — checking against a schema the producer doesn't know, applying a model from a different family, comparing to a deterministic ground truth.

### Phase A vs Phase B — what blooming insights has today vs what a critic would look like

```
        Now (forced re-pass, not a critic)     If quality forced it (real critic)
┌────────────────────────────────────────┐  ┌────────────────────────────────────────┐
│ runAgentLoop (base.ts L48–L176)        │  │ producer: DiagnosticAgent (Sonnet)     │
│   budgetSpent = toolCalls >= maxToolCalls │ │   investigate() → Diagnosis            │
│   forceFinal = ... || budgetSpent      │  │   ▼                                    │
│   ▼                                    │  │ critic: a NEW DiagnosticReviewAgent     │ ←
│ on forced-final turn:                  │  │   different model family (e.g. GPT-4    │
│   - strip tools from request           │  │   or Haiku acting on a strict review     │
│   - append synthesisInstruction to     │  │   prompt)                               │
│     system prompt                      │  │   review(diagnosis) → { ok, reason }   │
│   - same model emits final answer      │  │   ▼                                    │
│ same Sonnet · same trajectory ·        │  │ if ok: ship to recommendation           │
│ same blind spots                       │  │ else:  loop back to producer with reason│
└────────────────────────────────────────┘  └────────────────────────────────────────┘
   "forced re-pass" ≠ critic. The producer is reviewing
   its own work with no fresh perspective.
```

*Now:* the forced-synthesis turn is the producer reading its own trajectory and being told "stop calling tools and emit your final answer." It doesn't *check* the answer; it *finishes* it. There's no second-opinion architecture in the codebase.

*If quality forced it:* the day the diagnostic agent ships confident wrong diagnoses at a rate the user notices, a critic earns its overhead. The critic would have to be a different model family (the LLM-as-judge bias makes Sonnet-critiquing-Sonnet a rubber stamp) and would have to check against the `Diagnosis` schema (a structural check the producer can already partially do) AND against a quality rubric (e.g. "does the conclusion follow from the evidence? are the hypotheses considered exhaustive?").

The takeaway: **the absence of a critic is a deliberate choice, not an oversight.** The codebase doesn't have the failure mode (confident wrong diagnoses at a rate users complain about) that justifies the cost of adding one — and adding a same-family critic would be paying the cost without getting the value.

This is what people mean by "use a verifier-critic when the producer's blind spots are large enough to justify a second perspective, and use a different model family when you do." Otherwise you've shipped a rubber stamp.

The full picture is below.

---

## Debate / verifier-critic — diagram

```
Debate vs verifier-critic — full picture

  ┌─ VERIFIER-CRITIC (asymmetric) ───────────────────────────────┐
  │                                                              │
  │   ┌──────────────┐                                           │
  │   │  Producer    │  Sonnet (or whatever your strong model is)│
  │   └──────┬───────┘                                           │
  │          │ output                                            │
  │          ▼                                                   │
  │   ┌──────────────┐                                           │
  │   │   Critic     │  ◄── DIFFERENT model family (else: rubber │
  │   │              │      stamp from same-family blind spots) │
  │   └──────┬───────┘                                           │
  │          │ { approved, reason }                              │
  │          ▼                                                   │
  │     approved? ─── yes ──► ship                               │
  │          │                                                   │
  │          no                                                  │
  │          │                                                   │
  │          ▼                                                   │
  │   producer.revise(output, reason)  ── loop, cap rounds       │
  └──────────────────────────────────────────────────────────────┘

  ┌─ DEBATE (symmetric + judge) ─────────────────────────────────┐
  │                                                              │
  │   ┌──────────────┐         ┌──────────────┐                  │
  │   │  Agent A     │ ◄─────► │  Agent B     │                  │
  │   │  (proposes)  │ counter │  (counters)  │                  │
  │   └──────┬───────┘  N      └──────┬───────┘                  │
  │          │     rounds              │                          │
  │          └──────────┬──────────────┘                          │
  │                     ▼                                         │
  │              ┌──────────────┐                                 │
  │              │   Judge      │  (or: human-in-the-loop)        │
  │              │  (picks      │                                 │
  │              │   winner OR  │                                 │
  │              │   synthesizes)│                                │
  │              └──────┬───────┘                                 │
  │                     ▼                                         │
  │                final answer                                   │
  │                                                               │
  │   cost: 2N + 1 LLM calls (N debate rounds + 1 judge)         │
  └───────────────────────────────────────────────────────────────┘

  ┌─ BLOOMING INSIGHTS (today) ──────────────────────────────────┐
  │                                                              │
  │   runAgentLoop (base.ts L48–L176)                            │
  │     budgetSpent = toolCalls >= maxToolCalls                  │
  │     forceFinal = lastTurn || budgetSpent                     │
  │     ▼                                                        │
  │   on forced-final turn:                                      │
  │     - strip tools                                            │
  │     - append synthesisInstruction                            │
  │     - same model, same trajectory → final answer             │
  │                                                              │
  │   THIS IS NOT A CRITIC. It's a forced re-pass.               │
  │   The producer is finalizing its own work.                   │
  └──────────────────────────────────────────────────────────────┘
```

---

## In this codebase

**Not yet implemented.**

There is no debate agent and no critic agent in blooming insights. The shape that gets closest is the *forced-synthesis turn* in `runAgentLoop`, which strips tools from the model's request and appends a `synthesisInstruction` when the budget is spent. That's a re-pass on the same model, same trajectory — it finalizes the producer's answer, but it does not provide a second perspective.

The honest sentence: **a critic would only pay for itself if the diagnostic or recommendation agent shipped confident wrong outputs at a rate users complained about, AND the critic was a different model family from the producer.** Neither condition is true today. Adding a same-family critic would double the token cost on every investigation for the rubber-stamp regime documented in the LLM-as-judge literature.

For the refactor: `../06-orchestration-system-design-templates/` includes a "verifier-critic over the diagnostic output" template; the producer (`DiagnosticAgent`) would not change, but a new `DiagnosticReviewAgent` would slot in between diagnostic and recommendation, using a different model family.

**The forced-synthesis turn (the closest existing mechanic)**
**File:** `lib/agents/base.ts`
**Function / class:** `runAgentLoop()`
**Line range:** L90 (`budgetSpent` check), L98 (`synthesisInstruction` appended to system prompt), L101 (tools stripped from request)

**The per-agent synthesisInstructions (what gets re-passed)**
**File:** `lib/agents/diagnostic.ts` L63 (`synthesisInstruction:` field), `lib/agents/recommendation.ts` L58, `lib/agents/monitoring.ts` L102, `lib/agents/query.ts` L42

**The LLM-as-judge bias reference (why same-family is the failure mode)**
**File:** `.aipe/study-ai-engineering/05-evals-and-observability/03-llm-as-judge-bias.md` (cross-reference for the mechanics)

```
shape (the forced re-pass, NOT a critic):

  // lib/agents/base.ts L90–L101
  const budgetSpent = maxToolCalls !== undefined && toolCalls.length >= maxToolCalls;
  const forceFinal = turn === maxTurns - 1 || budgetSpent;
  const params = {
    model: AGENT_MODEL,                   // SAME model — Sonnet, every time
    system: forceFinal && synthesisInstruction
      ? `${system}\n\n${synthesisInstruction}`
      : system,
    messages,                              // SAME trajectory — no fresh context
  };
  if (!forceFinal) params.tools = toolSchemas;  // strip tools on forced final
  const res = await anthropic.messages.create(params);
  // The producer is finalizing its own work, not being critiqued.
```

---

## Elaborate

### Where this pattern comes from

The producer-critic pattern is older than LLMs — it's the same idea as test-driven development (the test is the "critic" of the production code) and code review (a second engineer's eyes catch what the author misses). The LLM-specific framing started with research papers like "Self-Refine" (2023) and "Constitutional AI" (Anthropic, 2022), which named the asymmetric critic loop. Multi-agent debate as a structured shape was popularized by "Improving Factuality and Reasoning in Language Models through Multi-Agent Debate" (2023). Anthropic's "Building Effective Agents" (2024) named it the "evaluator-optimizer" pattern and emphasized the same-family failure mode.

### The deeper principle

**Adding a second perspective only helps if the perspective is genuinely different.** This is the same principle as code review — a reviewer who shares the author's assumptions catches nothing. The variant that works: a critic with a different training set, a different model family, a different prompt strategy, OR a deterministic check the producer's loop can't perform on itself (a schema validator, a fact lookup, a unit test).

```
What makes a critic real

  Different training set      ─► catches errors in different
                                  factual coverage
  Different model family      ─► catches errors in different
                                  reasoning patterns
  Deterministic check         ─► catches errors the LLM can't
   (schema, fact lookup,         catch at all (typo in JSON
   unit test)                    field name, contradicted fact)

  Same model, same prompt     ─► RUBBER STAMP
   (just "review your work")    no fresh perspective
```

### Where this breaks down

Debate/critic breaks when the cost of the second perspective exceeds the cost of the errors it would catch. If your producer ships 95% correct outputs and the wrong 5% are low-stakes, adding a critic that costs the same as the producer is a 100% increase in token cost for marginal quality gain. The cost-benefit math has to clear before you ship it.

It also breaks when the critic is *more* confident than the producer. A critic that thinks every output is wrong throws everything back, producer revises, critic still rejects — you get infinite-loop behavior bounded only by the round cap, and the final output is whatever the round cap forced. The mitigation is a clear-output rubric for the critic (specific checks against specific schema fields, not "is this good"); LangGraph's "evaluator-optimizer" examples include this pattern.

### What to explore next
- `../../study-ai-engineering/05-evals-and-observability/03-llm-as-judge-bias.md` → the mechanics of same-family blind spots
- `./09-coordination-failure-modes.md` → "synthesis failure" (when a critic averages contradictions instead of surfacing them)
- `./07-graph-orchestration.md` → debate as a graph with N rounds + judge node + clear termination
- `../06-orchestration-system-design-templates/` → the "verifier-critic over diagnostic output" refactor for this codebase

---

## Tradeoffs

The decision was: **no critic, no debate — forced-synthesis re-pass only.** The alternative is to add a verifier-critic over the diagnostic output.

┌──────────────────┬─────────────────────────────┬─────────────────────────────┐
│ Cost dimension   │ Forced re-pass (chosen)     │ Verifier-critic (alternative)│
├──────────────────┼─────────────────────────────┼─────────────────────────────┤
│ LLM calls / run  │ 1 producer loop             │ 1 producer + 1 critic per   │
│                  │                             │ round (2N total)            │
│ Token cost / run │ producer cost only          │ producer + critic cost      │
│ Quality gain     │ none — same model finalizes │ ~5% (same family) to        │
│                  │ itself                      │ ~30% (different family)     │
│ Latency / run    │ producer's loop only        │ +1–3s per critic round      │
│ Same-family risk │ N/A (no critic exists)      │ HIGH — rubber stamp if not  │
│                  │                             │ a different model family    │
│ Build cost       │ none extra                  │ critic prompt + review      │
│                  │                             │ rubric + revise() entry     │
│                  │                             │ point on producer           │
│ Failure mode     │ producer's blind spots ship │ critic's confidence drift   │
│                  │ directly                    │ (round cap as backstop)     │
│ Stops being      │ when ship-wrong-rate        │ when error cost stops       │
│ right when…      │ exceeds tolerance           │ exceeding critic cost       │
└──────────────────┴─────────────────────────────┴─────────────────────────────┘

### What we gave up

We gave up an explicit quality gate on the diagnostic output. Today, the diagnostic agent's `Diagnosis` flows straight to the recommendation agent — if the diagnosis is subtly wrong (a hypothesis contradicted by the evidence, an `affectedCustomers` count that doesn't match the segment description), there's no automated check. The user catches it or doesn't.

We also gave up the ability to *learn* from critic rejections. A critic loop produces a labeled dataset over time: "outputs the producer made, outputs the critic rejected, reasons why." That's a fine-tuning signal we can't capture without a critic in the loop.

### What the alternative would have cost

If we'd built a verifier-critic over the diagnostic output, the up-front cost would be a `DiagnosticReviewAgent` class with its own prompt (a strict rubric: "check the conclusion follows from the evidence; check all hypotheses are addressed; check `affectedCustomers.count` matches `segmentDescription`'s scope"), a `revise()` method on `DiagnosticAgent` that takes a critique and re-runs, and a wrapper in the route that runs the producer-critic loop with a round cap.

Per-run cost: each critic round adds ~1–3s under the MCP rate limit + the critic's tokens. If the critic is Haiku (cheap) reviewing Sonnet (expensive), the cost addition is ~10–20% per round. If both are Sonnet (rubber-stamp risk), it's ~50–100% per round. At 1–2 rounds typical, the budget impact is meaningful.

The hidden cost: the critic itself has to be evaluated. Who critiques the critic? You ship a critic that rejects 30% of outputs and have no way to know whether 30% of outputs are actually wrong or the critic is hallucinating issues. The mitigation is a labeled eval set for the critic itself — yet another infrastructure layer.

### The breakpoint

This stays the right call until the diagnostic agent's "confident wrong" rate becomes a visible product problem — measurably, users complaining about wrong diagnoses or skipping recommendations because they don't trust the diagnosis. At that point a verifier-critic with a *different model family* (e.g. GPT-4 critiquing Sonnet, or a deterministic rubric checker against the `Diagnosis` schema) earns its overhead. Same-family critic remains a non-starter at any scale.

### What wasn't actually a tradeoff

A "critic that's the same model with a stricter prompt" was not a real alternative. The LLM-as-judge literature documents that same-family critics catch ~5% of errors and miss the rest — the rubber-stamp regime is structurally hard-coded into self-preference bias. Shipping a same-family critic would double the token cost for marginal quality gain. Symmetric debate (two Sonnet agents arguing) has the same problem twice over — both debaters share blind spots, both miss the same errors, the judge has the same blind spots and confidently picks the wrong winner.

---

## Tech reference

### Anthropic Messages API tool_use (the producer mechanic)

- **Codebase uses:** `runAgentLoop` in `lib/agents/base.ts` L48–L176 — the same primitive a critic would run; only the prompt and tool schemas change.
- **Why it's here:** the critic in a hypothetical verifier-critic loop would be a `runAgentLoop` with a different `system` prompt (a rubric) and an empty `toolSchemas` (it reviews; it doesn't act).
- **Leading today:** Anthropic Messages API — innovation-leading for typed agent loops with structured outputs, 2026.
- **Why it leads:** typed tool calls + JSON-mode structured outputs make the critic's "approve / reject + reason" envelope easy to enforce.
- **Runner-up:** OpenAI Responses API with structured outputs — equivalent shape, larger installed base.

### Different-model-family critic (the orthogonality requirement)

- **Codebase uses:** not used today. Listed for the refactor.
- **Why it's here:** the LLM-as-judge research consistently shows that critic effectiveness scales with orthogonality between producer and critic — same family = rubber stamp; different family = real review.
- **Leading today:** mixed-provider critic setups — innovation-leading for high-stakes agent outputs, 2026.
- **Why it leads:** the cost gap between providers is small (most are within 2x on price), and the orthogonality gain is large; one provider's hallucinations are usually visible to another's stronger reasoning.
- **Runner-up:** same-family critic with a deterministic rubric (schema check + fact lookup against a database) — a hybrid; the rubric provides the orthogonality the same-family model can't.

### LLM-as-judge bias literature (the failure-mode reference)

- **Codebase uses:** not directly — the cross-reference is the guide file `.aipe/study-ai-engineering/05-evals-and-observability/03-llm-as-judge-bias.md`.
- **Why it's here:** every critic decision in this codebase would have to defend itself against the LLM-as-judge bias literature; the file names the specific biases (self-preference, position, verbosity) to mitigate.
- **Leading today:** "LLM-as-Judge with MT-Bench" and related papers — adoption-leading for documenting same-family bias, 2026.
- **Why it leads:** these papers gave the field the vocabulary ("self-preference bias") to reject same-family critic architectures with evidence, not vibes.
- **Runner-up:** human-in-the-loop spot-checks — slower but immune to same-family bias; used as the ground truth for critic eval sets.

---

## Summary

A verifier-critic is one agent producing and a *different* agent reviewing; debate is two symmetric agents arguing with a judge picking the winner. The architecture works only when the critic / judge has a genuinely different perspective from the producer — same-family critics are documented rubber stamps. blooming insights does not implement either: the closest mechanic is the forced-synthesis turn in `runAgentLoop` (`base.ts` L90–L101), which strips tools and appends a `synthesisInstruction` on the same model and same trajectory — a re-pass, not a critic. The constraint that made this right is that the diagnostic agent's "confident wrong" rate is not visibly hurting the product, and a same-family critic would double the cost for marginal quality gain. The breakpoint: ship-wrong rate exceeds tolerance AND a different model family critic is available to provide real orthogonality.

- A critic is a second agent whose only job is to review — not produce — and it has to come from a different model family OR run a deterministic check the producer can't.
- Debate is two symmetric proposers with a judge; ~3–10% quality gain typical, ~2N+1 LLM calls per output.
- blooming insights has neither — the forced-synthesis turn in `base.ts` L90 is a re-pass on the same model, not a critic.
- Same-family critic = rubber stamp (~5% catch rate) because of self-preference bias documented in LLM-as-judge literature.
- Worth it when error cost > critic cost AND the critic is genuinely orthogonal. Skip when either condition fails.

---

## Interview defense

### What an interviewer is really asking

When an interviewer asks "do you have a critic" or "do you do verification" they're testing whether you can resist the temptation to add second-opinion architecture for show. The strong signal is naming the LLM-as-judge bias and explaining why same-family critics are structurally weak. The weak signal is having shipped a critic and claiming quality gains you can't measure.

### Likely questions

[mid] Q: What's a verifier-critic pattern?

A: A producer agent generates an output; a critic agent reviews the output and either approves it or rejects it with a reason. If rejected, the producer revises and the critic reviews again, until approval or a round cap. The critic does not produce its own alternative — it only evaluates. In blooming insights this isn't implemented; the closest mechanic is the forced-synthesis turn in `runAgentLoop` (`base.ts` L90), which is the producer finalizing its own work, not a critic.

Diagram:
```
  ┌──────────┐     output     ┌──────────┐
  │ Producer │ ─────────────► │ Critic   │
  └──────────┘                 └────┬─────┘
       ▲                            │
       │       approve? ship        │
       │       reject? loop back ◄──┘
       │       (cap rounds)
       │
       └─── revise(output, reason)
```

[senior] Q: Why didn't you add a critic over the diagnostic output?

A: Two reasons. First, the diagnostic agent's "confident wrong" rate isn't a visible product problem — users haven't been complaining about wrong diagnoses, so the critic's value is unmeasured. Second, the only critic that would actually catch errors is one from a *different model family* — the LLM-as-judge literature documents same-family critics as ~5% catch-rate rubber stamps because of self-preference bias. If I added a Sonnet critic over a Sonnet producer, I'd double the token cost for marginal quality gain. I'd reach for a critic the day shipping-wrong rates became visible AND I had a different-family critic ready (e.g. Haiku-with-deterministic-rubric, or OpenAI as the critic).

Diagram:
```
  Why same-family critic = rubber stamp

  ┌────────────┐  ┌────────────┐
  │ Sonnet     │  │ Sonnet     │
  │ produces   ├─►│ critiques  │
  │ (with self-│  │ (with the  │
  │ preference │  │ same self- │
  │ bias)      │  │ preference │
  └────────────┘  │ bias)      │
                  └────────────┘

   shared blind spots → ~5% catch rate
   you paid 2x for marginal gain.
```

[arch] Q: If you were going to add a critic at scale, what's the architecture you'd ship?

A: Two layers. First layer: a deterministic schema check that runs *before* any LLM critic — does the `Diagnosis.conclusion` reference at least one item from `evidence[]`? does `affectedCustomers.count` match the size implied by `segmentDescription`? Are all `hypothesesConsidered[]` either supported or rejected with a reason? These are structural checks the producer's loop can't reliably do on itself. Second layer: a different-family LLM critic (Haiku or a different provider) that runs the *semantic* checks — "does the conclusion actually follow from the evidence?" — gated by the first layer (no semantic critique on outputs that already fail structural checks). The route file would call this as a function between `diagAgent.investigate(...)` and `recAgent.propose(...)`. The whole pipeline becomes producer → deterministic check → semantic critic → recommendation, with the critic having a hard round cap of 2.

Diagram:
```
  Two-layer critic

  Producer (Sonnet)
       │
       ▼
  Deterministic check (schema, structural rules)
       │
       ├─ fails? loop back to producer with reason
       │
       ▼ passes
  Semantic critic (Haiku / different provider)
       │
       ├─ rejects? loop back to producer with reason
       │
       ▼ approves (or round cap hit)
  Recommendation (Sonnet)
```

### The question candidates always dodge

Q: Isn't the forced-synthesis turn in `base.ts` L90 basically a critic? It's reviewing the producer's trajectory.

A: No — and it's worth being precise about why. The forced-synthesis turn does three things: it strips tools from the request, it appends a `synthesisInstruction` to the system prompt, and it forces the model to emit its final answer instead of another tool call. What it does NOT do: provide a second perspective, evaluate the trajectory against a rubric, or reject and ask for a revision. It's the *same model* on the *same trajectory* being told "stop and write your answer." That's the producer finalizing its own work, not a critic reviewing it. The distinction matters because if I described forced-synthesis as a critic, I'd be claiming a quality gate I don't actually have — and the user would see right through it the first time the producer ships a confident wrong diagnosis. The honest framing: the forced-synthesis turn bounds latency and forces output emission; the critic role is empty.

Diagram:
```
What forced-synthesis is vs what a critic is

  ┌─ Forced synthesis (base.ts L90) ──────────┐
  │ - strip tools                              │
  │ - append synthesisInstruction              │
  │ - SAME model finalizes its OWN trajectory  │
  │ Purpose: bound latency, force output        │
  │ Catches errors? NO                          │
  └────────────────────────────────────────────┘

  ┌─ Critic (not implemented) ─────────────────┐
  │ - DIFFERENT model family                    │
  │ - reads producer's output                   │
  │ - applies a review rubric                   │
  │ - returns { approved, reason }              │
  │ Purpose: catch errors the producer missed   │
  │ Catches errors? Yes (when orthogonal)       │
  └────────────────────────────────────────────┘
```

### One-line anchors

- "Same-family critic = rubber stamp. Different-family critic = real review. The architecture is only as good as the orthogonality."
- "blooming insights has no critic — the forced-synthesis turn is the producer finalizing itself, not a second perspective."
- "Debate's cost is 2N+1 calls; gain is ~3–10% on benchmarks. Worth it only when error cost > critic cost AND the perspectives diverge."
- "The shortest path to a real critic is a deterministic schema check + a different-family LLM for semantic review, gated."

---

## Validate your understanding

### Level 1 — Reconstruct the diagram

Close this file. Draw both shapes from memory: verifier-critic (producer + critic + loop back) and debate (two symmetric proposers + judge). Annotate where the "different model family" requirement applies in each, and what the catch-rate is for same-family vs different-family.

Open the file. Compare.

✓ Pass: you drew both shapes, named the orthogonality requirement, and named the ~5% vs ~10–30% catch-rate gap
✗ Fail: re-read How it works Layers 1–3, wait 10 minutes, try again.

### Level 2 — Explain it out loud

Explain to a colleague who asked "should we add a critic agent to double-check the diagnosis?" — under 90 seconds, no notes.

Checkpoints — did you:
- Name the LLM-as-judge bias (same-family critic = rubber stamp)?
- Distinguish forced-synthesis turn from a real critic?
- Name what would have to be true for a critic to earn its cost?
- Reference the cross-ref `../../study-ai-engineering/05-evals-and-observability/03-llm-as-judge-bias.md`?

If you skipped any: you defended the absence weakly.

### Level 3 — Apply it to a new scenario

A product manager wants to add a "confidence check" on the diagnostic output: an agent that reads the `Diagnosis` and rates how confident the team should be in shipping a recommendation from it.

Without looking at the file: is this a critic? What model family should the confidence-check agent use, and why? What's the minimum architecture that avoids the rubber-stamp failure mode? Reference `../../study-ai-engineering/05-evals-and-observability/03-llm-as-judge-bias.md`.

Write your answer (3–5 sentences). Then open `lib/agents/base.ts` L90–L101 and verify whether the forced-synthesis mechanic could be repurposed (it can't — same model).

### Level 4 — Defend the decision you'd change

"If you were building this today and you had budget for ONE quality-improvement mechanism, would you (a) add a verifier-critic over the diagnostic output, or (b) invest the same budget into improving the diagnostic agent's prompt + tool subset? Why? What's the worst case if you pick wrong?"

Reference the code: `lib/agents/diagnostic.ts` L62 (`maxToolCalls: 6`), L63 (`synthesisInstruction`), `lib/agents/base.ts` L90–L101 (forced-synthesis turn).

### Quick check — code reference test

Without opening any files:
- Does blooming insights have a critic agent? (Yes / No, and what's the closest mechanic?)
- What's the failure mode of a same-family critic?
- What two conditions must be true for a verifier-critic to earn its cost in this codebase?

Open and verify. ✓ File + function names matter; line numbers drifting is fine.

---
Updated: 2026-05-29 — created
