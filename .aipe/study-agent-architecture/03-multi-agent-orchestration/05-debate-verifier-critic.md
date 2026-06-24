# Debate and verifier-critic

**Industry name(s):** Multi-agent debate, verifier-critic, generator-verifier, producer-judge, LLM-as-judge, evaluator-optimizer
**Type:** Industry standard · Language-agnostic

> Two (or more) agents argue, critique, or judge each other to refine output quality. blooming insights does NOT have a debate or critic agent — `synthesize` retry in `runAgentLoop` is a *forced re-pass* on the same model, not a separate critic. The topology that earns its overhead the day a second perspective measurably catches errors the producer alone misses.


---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Debate and verifier-critic would sit at the Pipeline coordinator band — extra agents wedged between a producer stage and the consumer of its output, looping until approved or until a judge picks a winner. In blooming insights, that band is a sequential pipeline with no critic-agent slot; the closest thing is the *forced-synthesis turn* inside `runAgentLoop` (when the budget is spent, tools are stripped and the same model is asked again). Same-model re-pass, not a critic. The diagram below shows the two would-be shapes on top and blooming insights' single-producer pipeline underneath.

```
  Zoom out — where debate / critic WOULD live

  ┌─ Pipeline coordinator ──────────────────────────┐  ← we are here
  │  ★ DEBATE shape (★ THIS ★, absent):               │
  │    [agent A] ◄──► [agent B]  →  [judge]           │
  │                                                   │
  │  ★ VERIFIER-CRITIC shape (★ THIS ★, absent):      │
  │    [producer] ──► [critic] ──► approve/reject     │
  │                       │ rejected loops back        │
  │                       ▼                            │
  │  ── absent in blooming insights ──                │
  │                                                   │
  │  blooming insights' actual shape:                 │
  │    monitoring ─► diagnostic ─► recommendation     │
  │    (no critic; forced-synthesis is a same-model    │
  │     retry inside the loop, not a cross-model       │
  │     review)                                        │
  └─────────────────────────┬────────────────────────┘
  ┌─ Shared agent loop ─────▼────────────────────────┐
  │  runAgentLoop's forced-final is the closest analog│
  └──────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question is: when does adding a second perspective catch errors the producer alone misses, and when does it just double your token bill? A critic that shares the producer's blind spots (same model family, same biases) confidently approves the producer's confident wrong answer — the LLM-as-judge bias literature documents this. blooming insights does NOT implement either shape; the failure modes it would address haven't shown up in production traces yet. Below, you'll see both topologies, the blind-spot failure mode, and the breakpoint that would justify either one.

---

## Structure pass

**Layers.** A would-be debate or verifier-critic setup needs four layers: the **Producer** (an agent that makes a thing), the **Critic** (a separate agent — ideally a different model family — that reviews it), the **Verdict router** (decides approve / reject / loop / pick-a-winner-via-judge, cap-aware), and the **Consumer** (the downstream stage). All four are absent in blooming insights for the analyst flow; the sequential pipeline goes straight from producer to consumer. The closest analog is the forced-synthesis turn inside `runAgentLoop` — a same-model, tool-less re-pass on budget exhaustion (still inside one producer, not a separate critic).

**Axis: control.** Who gets to decide the producer's output is acceptable — the producer alone, a separate critic, or your code (parser/validators)? This is the right axis because the entire pattern is *inserting a control point* between the producer and the consumer. Trust is the *motivation* (you don't trust a single producer), but the mechanism the topology adds is a new decider — that's a control flip.

**Seams.** Two seams are load-bearing in the WOULD-BE shape, and both need to be present for the pattern to earn its overhead. Seam 1 sits between the Producer and the Critic — control flips from MODEL-as-producer to MODEL-as-judge, and this seam only carries signal if the two models *don't share blind spots* (different family, different training). If the critic shares the producer's biases, the flip is cosmetic — same answer, twice. Seam 2 sits between the Critic and the Verdict router — control flips from MODEL (verdict) to CODE (route accordingly, cap retries to prevent ping-pong). Seam 2 is the load-bearing one for production: without the cap-enforcer, debate loops can run forever. In blooming insights both seams are absent, and the lesson is that adding them without orthogonality between models would be all cost and no signal.

```
  Structure pass — Debate / verifier-critic (would-be shape)

  ┌─ 1. LAYERS ───────────────────────────────────┐
  │  Producer (agent)                              │
  │  Critic (different model family, ideally)      │
  │  Verdict router (cap-aware)                    │
  │  Consumer (downstream stage)                   │
  └────────────────────────┬───────────────────────┘
                           │  pick the axis
  ┌─ 2. AXIS ─────────────▼────────────────────────┐
  │  control: who decides the output is OK?        │
  └────────────────────────┬───────────────────────┘
                           │  trace across layers, find flips
  ┌─ 3. SEAMS ────────────▼────────────────────────┐
  │  Seam 1: Producer ↔ Critic                     │
  │          (MODEL-producer → MODEL-judge)        │
  │          carries signal ONLY if blind spots    │
  │          don't overlap                         │
  │  Seam 2: Critic ↔ Verdict router               │
  │          (MODEL → CODE cap) ★ load-bearing —   │
  │          without it, ping-pong forever         │
  │  In this repo: both absent — same-model        │
  │  forced-synthesis is the closest analog        │
  └────────────────────────┬───────────────────────┘
                           ▼
                   Block 4 — How it works
```

The skeleton is mapped — the rest of this file walks the debate and verifier-critic mechanics, the blind-spot failure mode, and the breakpoint that would justify either topology.

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

The technical thing: *self-preference bias* — when an LLM judges its own output or output from its own family, it tends to rate it higher than it should. Documented across the LLM-as-judge literature; cross-reference the ai-engineering LLM-as-judge-bias note.

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
│ the shared agent loop                  │  │ producer: diagnostic agent             │
│   budget_spent = tool_calls >= cap     │  │   investigate() → Diagnosis            │
│   force_final  = … OR budget_spent     │  │   ▼                                    │
│   ▼                                    │  │ critic: a NEW diagnostic-review agent   │ ←
│ on forced-final turn:                  │  │   different model family (e.g. GPT-4    │
│   - strip tools from request           │  │   or a cheap-model on a strict review    │
│   - append synthesis instruction to    │  │   prompt)                               │
│     system prompt                      │  │   review(diagnosis) → { ok, reason }   │
│   - same model emits final answer      │  │   ▼                                    │
│ same model · same trajectory ·         │  │ if ok: ship to recommendation           │
│ same blind spots                       │  │ else:  loop back to producer with reason│
└────────────────────────────────────────┘  └────────────────────────────────────────┘
   "forced re-pass" ≠ critic. The producer is reviewing
   its own work with no fresh perspective.
```

*Now:* the forced-synthesis turn is the producer reading its own trajectory and being told "stop calling tools and emit your final answer." It doesn't *check* the answer; it *finishes* it. There's no second-opinion architecture in the codebase.

*If quality forced it:* the day the diagnostic agent ships confident wrong diagnoses at a rate the user notices, a critic earns its overhead. The critic would have to be a different model family (the LLM-as-judge bias makes same-family critiquing a rubber stamp) and would have to check against the Diagnosis schema (a structural check the producer can already partially do) AND against a quality rubric (e.g. "does the conclusion follow from the evidence? are the hypotheses considered exhaustive?").

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
  │   the shared agent loop                                      │
  │     budget_spent = tool_calls >= cap                         │
  │     force_final  = last_turn OR budget_spent                 │
  │     ▼                                                        │
  │   on forced-final turn:                                      │
  │     - strip tools                                            │
  │     - append synthesis instruction                           │
  │     - same model, same trajectory → final answer             │
  │                                                              │
  │   THIS IS NOT A CRITIC. It's a forced re-pass.               │
  │   The producer is finalizing its own work.                   │
  └──────────────────────────────────────────────────────────────┘
```

---

## Implementation in codebase

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

## See also

→ `./03-sequential-pipeline.md` · → `./01-when-not-to-go-multi-agent.md` · → LLM-as-judge bias: `../../study-ai-engineering/05-evals-and-observability/03-llm-as-judge-bias.md` · → systems view: `../../study-system-design/06-multi-agent-orchestration.md` · → forced-final-turn mechanic: `../01-reasoning-patterns/01-chains-vs-agents.md`

---
Updated: 2026-05-29 — created
Updated: 2026-05-30 — Migrated to study.md v1.47 template (Phase 1+2 mechanical): removed Tradeoffs / Tech reference / Summary sections; renamed "In this codebase" → "Implementation in codebase"; moved See also to a bottom block. "Why care" preserved pending Phase 3 (Zoom out, then zoom in + LAYERS diagram) authoring.
Updated: 2026-05-30 — Phase 3 of study.md v1.47 migration: replaced "Why care" block with "Zoom out, then zoom in" (LAYERS diagram + zoom-in paragraph) per format.md.
Updated: 2026-05-31 — Applied study.md v1.48: scrubbed "How it works" of file paths, line refs, and real-code fences; replaced with generic role labels + pseudocode per format.md. Codebase-specific anchoring lives exclusively in "Implementation in codebase".
Updated: 2026-05-31 — Applied study.md v1.50: added Structure pass block (layers · axis · seams) between Zoom out and How it works per format.md's new Block 3.
Updated: 2026-06-24 — Stripped `## Validate` block per spec v1.68.3 (the Validate primitive was removed from the per-concept template; block 10 is now `See also`).
