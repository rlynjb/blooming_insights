# Chain-of-thought (CoT)

**Industry name(s):** chain-of-thought, CoT prompting, step-by-step reasoning, reasoning-before-answer
**Type:** Industry standard · Language-agnostic

> diagnostic.md tells the model to "generate 2–3 hypotheses before your first tool call" (L20) and then requires that reasoning back as a *structured* field — `hypothesesConsidered[].reasoning` (L69–L75) — so CoT here is captured in a typed thinking field, not free-form prose; sonnet-4-6 reasons internally regardless, so the scaffolding earns its place by shaping OUTPUT STRUCTURE, not by eliciting hidden reasoning.

**See also:** → 08-few-shot.md · → 02-structured-outputs.md · → 06-single-purpose-chains.md · → 04-token-budgeting.md

---

## Why care

You have built a multi-step form where the wizard makes the user commit to a choice *before* showing the next step — pick a plan, then see add-ons; pick a region, then see availability. You did not let them jump straight to "submit" because the early commitment shapes everything downstream and gives you something to inspect when the final selection looks wrong. That intuition — force the intermediate step, then capture it — is what chain-of-thought does for a model.

An agent that diagnoses a metric drop faces the same risk as a user who jumps straight to "submit": it can leap to a conclusion without working the alternatives. The question this file answers: how does blooming insights make the model reason through competing explanations before concluding, and where does it *capture* that reasoning so it can be inspected?

**The pivot: chain-of-thought's value here is not eliciting hidden reasoning — sonnet-4-6 already reasons internally — it is forcing the reasoning into a structured, inspectable output.** I have shipped diagnosis features where "show your work" was a free-text field, and it became a dumping ground: three paragraphs of plausible prose, impossible to compare across runs, impossible to assert on in a test. The fix was not more CoT — it was *typed* CoT: a `hypothesesConsidered` array with one `reasoning` string per hypothesis. The reasoning became data. That is what diagnostic.md does, and it is the modern shape of CoT.

Before structured CoT:
- The model concludes "mobile checkout bug" with no visible alternatives — you cannot tell what it ruled out
- "Show your reasoning" produces free prose that no test can assert on and no UI can render as distinct hypotheses
- A second run reasons differently and you cannot diff the two

After:
- "Generate 2–3 hypotheses before your first tool call" forces breadth before depth (`diagnostic.md` L20)
- Each hypothesis comes back as `{ hypothesis, supported, reasoning }` — typed, comparable, assertable (`diagnostic.md` L69–L75)
- `isDiagnosis` (`validate.ts`) requires the array, so the reasoning is part of the contract

It is the commit-then-capture discipline, applied to a model whose intermediate reasoning is worth keeping as data, not discarding as prose.

---

## How it works

**Mental model.** Chain-of-thought is asking the model to produce intermediate reasoning steps before its final answer. The classic form is free-form ("think step by step"); the modern form — the one blooming insights uses — is *structured CoT*, where the intermediate reasoning is required as typed fields in the output so it can be validated, rendered, and compared. The shift is from "reasoning as prose you read" to "reasoning as data you keep."

```
two shapes of chain-of-thought
─────────────────────────────────────────────────────────────
 FREE-FORM CoT          "Let's think step by step…"
   │                    reasoning is prose, discarded after the answer
 STRUCTURED CoT         "generate 2–3 hypotheses, return each as
   │                     { hypothesis, supported, reasoning }"
   │                    reasoning is a TYPED FIELD, kept and validated
   └─ diagnostic.md lives here: CoT captured in hypothesesConsidered[]
```

The diagnostic agent combines two reasoning scaffolds: structured CoT (hypotheses up front) layered on top of the ReAct loop (which externalizes thought as Thought→Action→Observation, → 06-single-purpose-chains.md). One shapes the output; the other shapes the exploration.

---

### Force breadth before depth — hypotheses before the first tool call

The instruction is precise about *ordering*: reason first, act second. diagnostic.md L20 and the Role at L5 both require it:

```
diagnostic.md — reason before act   (L5, L20)
─────────────────────────────────────────────────────────────
 Role:  "generate 2–3 competing hypotheses, query the data to
         test each, and conclude"                              L5
 Step1: "Generate 2–3 hypotheses before your first tool call
         (e.g. device-specific regression, seasonal/geographic
         shift, campaign traffic change, ...)"                 L20
```

"Before your first tool call" is the load-bearing phrase. It forces the model to enumerate *competing* explanations while its context is still clean — before any query result biases it toward the first thing it sees. This is CoT as anti-anchoring: generate the hypothesis space first, then test it, instead of querying once and rationalizing whatever came back. L21–L24 then instruct "design queries to falsify each hypothesis" — the reasoning is not decoration, it directs the exploration.

```
WITHOUT: query → see result → conclude (anchored on first result)
WITH:    enumerate 2–3 hypotheses → query to falsify each → conclude
         └─ breadth committed before any result can bias it ─┘
```

---

### Capture the reasoning as a typed field — `hypothesesConsidered[]`

The hypotheses do not stay in the model's head; they come back in the output schema. The `## Output` block requires `hypothesesConsidered` as an array of typed objects (`diagnostic.md` L69–L75):

```
diagnostic.md — structured CoT field   (L69–L75)
─────────────────────────────────────────────────────────────
 "hypothesesConsidered": [
   {
     "hypothesis": "string — what you tested",        L56
     "supported": true,                                L57
     "reasoning": "string — why the data supports
                   or rules this out"                  L58
   }
 ]
```

This is the textbook recommendation made real: *put the reasoning in a thinking field, not free-form prose.* Each hypothesis carries its own `reasoning` string and a boolean `supported` — so the chain of thought is queryable (which hypotheses were ruled out?), assertable (a test can check `hypothesesConsidered.length >= 2`), and renderable (the UI can show ruled-out alternatives, not just the winner). The field-rules at L71 close the loop: "include all 2–3 hypotheses you tested. `supported: true` means this hypothesis best explains the data." The reasoning is part of the contract `isDiagnosis` enforces (`validate.ts` requires `hypothesesConsidered` to be an array).

```
reasoning as prose:   one blob, unparseable, untestable, unrenderable
reasoning as field:   hypothesesConsidered[{ hypothesis, supported, reasoning }]
                      └─ queryable · assertable · renderable ─┘
```

---

### The ReAct loop externalizes thought too

Structured CoT shapes the *output*; the ReAct loop shapes the *process*, and it externalizes reasoning a second way. Each turn of `runAgentLoop` emits the model's text blocks via `onText` (`base.ts` L108–L113) — that text *is* the model's interleaved reasoning between tool calls. So the diagnostic agent has two reasoning artifacts: the live Thought stream (ReAct, surfaced as `reasoning_step` events) and the final structured `hypothesesConsidered` array (CoT, in the output).

```
two reasoning artifacts in one diagnostic run
─────────────────────────────────────────────────────────────
 PROCESS (ReAct)   onText → reasoning_step   base.ts L108–113
   model's text between tool calls — live, streamed, transient
 OUTPUT  (CoT)     hypothesesConsidered[]    diagnostic.md L69–75
   final typed hypotheses — kept, validated, part of the contract
```

The Thought stream is transient (great for watching the run, → 06); the `hypothesesConsidered` array is durable (it survives into the saved diagnosis). CoT's job is the durable one.

---

### Move 2.5 — why CoT here is about structure, not hidden reasoning

The classic CoT result (Wei et al., 2022) was that "think step by step" *unlocked* reasoning the model otherwise skipped — on a 2022-era model, the scaffolding changed the answer. That is no longer the live reason to use it here. sonnet-4-6 (`base.ts` L9) does substantial reasoning internally without being told to; "think step by step" does not unlock hidden capability the way it did on davinci.

So what is the explicit scaffolding *for* in 2026? Output structure. "Generate 2–3 hypotheses" does not make sonnet smarter — it makes sonnet produce a `hypothesesConsidered` array of length 2–3 instead of a single conclusion. The value migrated from *eliciting* reasoning to *shaping and capturing* it.

```
2022 (davinci):  "think step by step" → unlocks reasoning → better answer
2026 (sonnet):   reasons internally regardless
                 explicit CoT → shapes OUTPUT (the hypotheses array)
                 ← the scaffolding earns its place by structure, not elicitation
```

This is why the scaffolding sits in the *output schema* (`hypothesesConsidered`), not just as a "reason carefully" instruction. If the goal were merely to elicit reasoning, a capable model would not need it; the goal is to get the reasoning *out in a typed shape*.

---

### When CoT hurts — the other three agents

CoT is not free and not always right. Three places in this codebase deliberately omit it:

- **Monitoring** returns an anomaly array (`monitoring.md` L69–L97) with an `evidence` field but *no* per-item reasoning field. It detects and measures; free-form reasoning would bloat the output without improving the numbers. CoT would be cost without payoff.
- **Recommendation** returns actions (`recommendation.md` L49–L74) with a `rationale` field — one line per action, not a hypothesis-falsification chain. It reasons *from* the diagnosis, so the heavy CoT already happened upstream; repeating it would duplicate work.
- **The intent classifier** would be *wrecked* by CoT. `classifyIntent` has `max_tokens: 16` (`intent.ts` L20) and demands "ONLY the one word." Tell it to "think step by step" and it spends its 16-token budget on "Let me consider…" and never reaches the label. CoT and a one-word output are directly incompatible.

```
CoT fit by agent
─────────────────────────────────────────────────────────────
 diagnostic     ✓  competing hypotheses → structured CoT earns its place
 monitoring     ✗  detection, numeric output — reasoning bloats it
 recommendation ✗  reasons FROM diagnosis — CoT already happened upstream
 classifier     ✗✗ max_tokens 16, one word — CoT would consume the budget
```

The codebase applies CoT exactly where the task is multi-hypothesis reasoning and withholds it everywhere the output is a measurement, a downstream summary, or a single token.

---

### The principle

Chain-of-thought on a modern model is not about unlocking hidden reasoning — the model already reasons — it is about forcing that reasoning into a structured, inspectable output where the task warrants it. blooming insights forces breadth before depth ("2–3 hypotheses before your first tool call") and captures the result as a typed `hypothesesConsidered[]` array, so the reasoning is queryable, assertable, and renderable. And it withholds CoT precisely where it would hurt — the numeric monitoring output, the downstream recommendation rationale, and the 16-token classifier where step-by-step reasoning would eat the entire budget.

---

## Chain-of-thought — diagram

This diagram spans the diagnostic flow. The Prompt layer forces hypotheses before action; the Loop layer externalizes process reasoning via ReAct; the Output layer captures the reasoning as typed fields the validator enforces. A reader who sees only this should grasp that CoT here is captured as structure, and that sonnet reasons internally regardless.

```
┌──────────────────────────────────────────────────────────────────────┐
│  PROMPT LAYER  lib/agents/prompts/diagnostic.md                      │
│                                                                       │
│  "Generate 2–3 hypotheses BEFORE your first tool call"  L20         │
│  "design queries to falsify each hypothesis"            L21–24      │
│           │  breadth committed before any result biases it          │
└───────────┼────────────────────────────────────────────────────────────┘
            ▼
┌──────────────────────────────────────────────────────────────────────┐
│  LOOP LAYER  lib/agents/base.ts  (ReAct externalizes PROCESS thought)│
│                                                                       │
│  per turn: onText → reasoning_step (Thought)   L108–113             │
│  sonnet-4-6 reasons internally; text between calls is streamed       │
│           │  transient — great for watching, not the durable artifact│
└───────────┼────────────────────────────────────────────────────────────┘
            ▼
┌──────────────────────────────────────────────────────────────────────┐
│  OUTPUT LAYER  diagnostic.md L69–75 + validate.ts (isDiagnosis)      │
│                                                                       │
│  hypothesesConsidered: [ { hypothesis, supported, reasoning } ]      │
│    ← STRUCTURED CoT: reasoning in a typed field, not free prose      │
│  isDiagnosis requires the array → CoT is part of the contract        │
│    queryable · assertable · renderable · durable                    │
└──────────────────────────────────────────────────────────────────────┘

  CoT's modern job: not eliciting reasoning (sonnet reasons anyway) but
  forcing it into a typed, inspectable shape — and only where it pays.
```

The reasoning is forced up front, externalized live by ReAct, and captured durably as typed fields — structure, not elicitation.

---

## In this codebase

**Case A — implemented (structured CoT in the diagnostic agent).**

### Force hypotheses before action

- **File:** `lib/agents/prompts/diagnostic.md`
- **Function / class:** the Role + Investigation approach sections
- **Line range:** L5 (Role: "generate 2–3 competing hypotheses"); L20 ("Generate 2–3 hypotheses before your first tool call"); L21–L24 ("design queries to falsify each")
- **Role:** forces breadth before depth so the model enumerates competing explanations before any query result can anchor it.

### Capture reasoning as a typed field

- **File:** `lib/agents/prompts/diagnostic.md` + `lib/mcp/validate.ts`
- **Function / class:** the `## Output` `hypothesesConsidered` schema; `isDiagnosis` guard
- **Line range:** `diagnostic.md` L69–L75 (`{ hypothesis, supported, reasoning }`), L90 (field rules); `isDiagnosis` requires `hypothesesConsidered` to be an array (`validate.ts`)
- **Role:** captures CoT as typed, validated data — the textbook "reasoning in a thinking field, not free prose" — so it is queryable, assertable, and renderable.

### ReAct externalizes process reasoning

- **File:** `lib/agents/base.ts`
- **Function / class:** `runAgentLoop` text-block extraction → `onText`
- **Line range:** L108–L113 (text blocks surfaced as the live Thought stream)
- **Role:** the model's text between tool calls is its interleaved reasoning, streamed as `reasoning_step` events — a transient companion to the durable `hypothesesConsidered` array.

### Where CoT is deliberately absent

- **File:** `monitoring.md`, `recommendation.md`, `intent.ts`
- **Function / class:** the non-diagnostic outputs
- **Line range:** monitoring output (no reasoning field) `monitoring.md` L69–L97; recommendation `rationale` (one line, not a chain) `recommendation.md` L49–L74; classifier `max_tokens: 16` `intent.ts` L20
- **Role:** CoT withheld where the output is a measurement, a downstream summary, or a single token — adding it would be cost without payoff, and would break the classifier outright.

### Why this is a codebase strength

The diagnostic agent puts CoT exactly where multi-hypothesis reasoning is the task, and captures it as structure rather than prose — the modern shape. Equally important, the other three agents *omit* it deliberately: the team did not reflexively sprinkle "think step by step" everywhere. Knowing where CoT does not belong (a 16-token classifier) is as much the signal as knowing where it does.

---

## Elaborate

### Where this comes from

Chain-of-thought prompting was named by Wei et al. (2022), "Chain-of-Thought Prompting Elicits Reasoning in Large Language Models" — showing that prompting a model to produce intermediate steps dramatically improved arithmetic and commonsense reasoning on the models of the day. Kojima et al. (2022) followed with "zero-shot CoT" — the bare "Let's think step by step." Both results were about *elicitation*: the scaffolding unlocked capability the model otherwise skipped. The 2026 reality is different — frontier models reason internally — so the working use of CoT shifted to *structuring* the reasoning (Anthropic's guidance to use a dedicated thinking field; structured-output schemas that carry reasoning as data). diagnostic.md's `hypothesesConsidered` is that shifted form.

### The deeper principle

```
elicitation (2022)                   structuring (2026)
──────────────────────────────      ──────────────────────────────
"think step by step" unlocks         model reasons regardless
reasoning the model skipped          scaffolding shapes the OUTPUT
value = better answer                value = inspectable reasoning
reasoning discarded after answer     reasoning kept as typed data
```

On a model that already reasons, the marginal value of "reason carefully" is small; the marginal value of "return your reasoning as `hypothesesConsidered[]`" is large, because it converts an internal, opaque process into external, durable data. The whole point of the typed field is to move the reasoning from the model's head (where you cannot inspect it) into the output contract (where you can validate, render, and diff it).

### Where this breaks down

1. **Structured CoT is not faithful CoT.** The `reasoning` strings the model writes are *post-hoc* — generated alongside the conclusion, not a transcript of how it actually decided. A model can fill `hypothesesConsidered` with plausible reasoning that does not reflect its real path (the same faithfulness gap as the ReAct Thought stream, → 06). The array is excellent for *auditing what it claims* and weak as a *proof of how it reasoned*.

2. **Forcing 2–3 hypotheses can manufacture them.** When the cause is obvious, "generate 2–3 hypotheses" can produce one real hypothesis and one or two strawmen the model invents to satisfy the count. The structure rewards quantity; it does not guarantee each hypothesis is genuinely competing.

3. **CoT costs output tokens.** Every `reasoning` string is generated within the agent's `max_tokens` budget (4096, → 04-token-budgeting.md). For diagnosis the trade is worth it; the codebase correctly does not pay it for the monitoring array or the 16-token classifier.

### What to explore next

- **Native extended thinking** — use the provider's thinking mode for the *internal* reasoning and keep `hypothesesConsidered` purely for the *reported* hypotheses, separating private reasoning from public output.
- **Self-consistency** — run the diagnostic N times and vote on the supported hypothesis to reduce variance (→ 10-self-critique.md); CoT is the per-run reasoning, voting is the aggregation.
- **Hypothesis quality eval** — score whether the 2–3 hypotheses are genuinely competing vs. strawmen, catching failure mode #2.

---

## Tradeoffs

### Structured CoT (typed field) vs. free-form CoT vs. no CoT

| Dimension | This codebase (structured `hypothesesConsidered`) | Free-form CoT prose | No CoT |
|---|---|---|---|
| Inspectability | High — typed, per-hypothesis | Low — one prose blob | None |
| Testability | High — assert array shape/length | None — unparseable | N/A |
| Output token cost | Moderate — reasoning per hypothesis | Moderate–high — open-ended | Lowest |
| Anti-anchoring | Yes — breadth forced before action | Partial | No |
| Faithfulness guarantee | None — post-hoc | None | N/A |
| Fit for a 1-word classifier | N/A | Breaks it | Correct choice |

**What we gave up.** Output tokens and some latency on the diagnostic path. Generating a `reasoning` string per hypothesis costs tokens the monitoring agent does not spend, and forcing 2–3 hypotheses can manufacture strawmen when the cause is obvious. The codebase accepts this on diagnosis because inspectable competing hypotheses are the product.

**What the alternative would have cost.** Free-form CoT would have produced reasoning you cannot test, render as distinct hypotheses, or diff across runs — a prose dumping ground. No CoT would have produced a bare conclusion with no visible alternatives, undebuggable when wrong. The structured form buys inspectability for the token cost; the alternatives are cheaper but lose the thing that makes a wrong diagnosis investigable.

**The breakpoint.** Structured CoT is right while diagnoses are read and audited by humans and the multi-hypothesis framing fits the task. It stops being worth it where the output is a measurement (monitoring), a downstream summary (recommendation), or a single token (classifier) — at which point CoT is pure cost, and in the classifier's case it breaks the output entirely. The trigger to *remove* CoT is "the task is no longer multi-hypothesis reasoning"; the trigger to *add* self-consistency on top is measured variance across runs (→ 10).

---

## Tech reference (industry pairing)

### structured CoT (`hypothesesConsidered[]`)

- **Codebase uses:** `diagnostic.md` L69–L75 — reasoning captured as typed `{ hypothesis, supported, reasoning }` objects, required by `isDiagnosis`.
- **Why it's here:** to make the diagnostic agent's competing-hypothesis reasoning inspectable, testable, and renderable rather than a prose blob.
- **Leading today:** structured/typed reasoning fields and provider extended-thinking modes lead in 2026 over bare "think step by step."
- **Why it leads:** on models that reason internally, the value is in capturing the reasoning as data, not eliciting it.
- **Runner-up:** native extended thinking (Anthropic thinking blocks) — private reasoning the provider manages; pairs well with a typed *reported* field.

### "reason before act" ordering (hypotheses before first tool call)

- **Codebase uses:** `diagnostic.md` L20 — enumerate 2–3 hypotheses before the first `execute_analytics_eql` call.
- **Why it's here:** anti-anchoring — commit the hypothesis space while context is clean, before any query result biases the conclusion.
- **Leading today:** plan-before-act prompting and ReAct-style interleaved reasoning lead in 2026.
- **Why it leads:** forcing breadth before depth reduces premature convergence on the first observation.
- **Runner-up:** ReAct alone — interleaves reasoning and action but does not force the up-front hypothesis enumeration this prompt adds.

### zero-shot CoT ("think step by step" — NOT used here)

- **Codebase uses:** nothing — no agent uses the bare elicitation phrasing; CoT is always structured into the output.
- **Why it's here:** named as the historical baseline — the 2022 form whose elicitation value has faded on frontier models.
- **Leading today:** bare zero-shot CoT is largely superseded in 2026 by internal reasoning + structured capture.
- **Why it leads (historically):** it unlocked reasoning on 2022-era models with no examples.
- **Runner-up:** few-shot CoT (worked reasoning exemplars) — stronger than zero-shot when the reasoning pattern is non-obvious (→ 08-few-shot.md).

---

## Project exercises

### Add a self-consistency vote over the diagnostic's supported hypothesis

- **Exercise ID:** B1.9 (adapted) — CoT + self-consistency.
- **What to build:** run `DiagnosticAgent.investigate` N=3 times for one anomaly, collect each run's `hypothesesConsidered` with `supported: true`, and return the majority-supported hypothesis (with the per-run reasoning attached), instead of trusting a single run.
- **Why it earns its place:** demonstrates that CoT is the per-run reasoning and self-consistency is the aggregation over it (→ 10-self-critique.md), and addresses the single-run variance failure.
- **Files to touch:** `lib/agents/diagnostic.ts` (an N-run wrapper around `investigate`), `lib/mcp/types.ts` (a vote-result shape), `test/agents/diagnostic.test.ts`.
- **Done when:** a diagnosis reports the majority hypothesis across 3 runs and a test shows a single-run outlier being out-voted.
- **Estimated effort:** 1–4hr

### Add a hypothesis-quality check that flags strawman hypotheses

- **Exercise ID:** B1.9 (adapted) — guarding CoT quality.
- **What to build:** add a lightweight check (a second cheap model call or a heuristic) that scores whether the 2–3 entries in `hypothesesConsidered` are genuinely *competing* explanations vs. one real hypothesis plus invented strawmen, and surfaces a warning when the count looks manufactured.
- **Why it earns its place:** addresses the "forcing 2–3 hypotheses manufactures them" failure — quantity satisfied, quality not.
- **Files to touch:** `lib/agents/diagnostic.ts` (post-validation quality check), `lib/mcp/types.ts` (a quality flag on the diagnosis), `test/agents/diagnostic.test.ts`.
- **Done when:** a diagnosis whose hypotheses are near-duplicates or strawmen is flagged, and a genuinely diverse set is not.
- **Estimated effort:** 1–4hr

---

## Summary

Chain-of-thought on a modern model is not about eliciting hidden reasoning — sonnet-4-6 (`base.ts` L9) reasons internally — it is about forcing that reasoning into a structured, inspectable output. blooming insights' diagnostic agent forces breadth before depth ("generate 2–3 hypotheses before your first tool call," `diagnostic.md` L20) and captures the result as a typed `hypothesesConsidered[]` array of `{ hypothesis, supported, reasoning }` objects (`diagnostic.md` L69–L75), required by `isDiagnosis` — the textbook "reasoning in a thinking field, not free prose." The ReAct loop externalizes process reasoning as a live Thought stream (`base.ts` L108–L113) alongside it. And CoT is withheld exactly where it would hurt: the numeric monitoring output, the downstream recommendation rationale, and the 16-token classifier where step-by-step reasoning would consume the entire budget.

**Key points:**
- On frontier models, CoT's value migrated from *eliciting* reasoning to *shaping and capturing* it as structure.
- "Generate 2–3 hypotheses before your first tool call" forces breadth before depth — anti-anchoring against the first query result.
- `hypothesesConsidered[]` captures CoT as a typed field — queryable, assertable, renderable — and is part of the `isDiagnosis` contract.
- ReAct externalizes the live process reasoning (`onText` → `reasoning_step`); the typed array is the durable artifact.
- CoT is deliberately absent from monitoring, recommendation, and the classifier — where it is cost without payoff, or breaks the output outright.

---

## Interview defense

### What an interviewer is really asking

"Where do you use chain-of-thought?" tests whether you still think CoT means "think step by step" or know that on a frontier model its value is structuring reasoning into the output. The senior signal is naming `hypothesesConsidered` as *structured* CoT, explaining that sonnet reasons regardless so the scaffolding earns its place by shaping output, and naming the three places CoT is correctly absent.

### Likely questions

**[mid] "How does the diagnostic agent reason before it concludes?"**

It is told to generate 2–3 competing hypotheses *before its first tool call* (`diagnostic.md` L20), then design queries to falsify each (L21–L24), then conclude. The hypotheses come back as a typed `hypothesesConsidered` array (L69–L75), each with a `reasoning` string and a `supported` boolean — so the reasoning is captured as data, not prose.

```
enumerate 2–3 hypotheses → falsify each via queries → conclude
                          → return hypothesesConsidered[{hypothesis,supported,reasoning}]
```

**[senior] "sonnet reasons internally. Why bother with explicit chain-of-thought at all?"**

Because the explicit scaffolding is not there to *unlock* reasoning — sonnet does that on its own — it is there to *shape the output*. "Generate 2–3 hypotheses" makes the model emit a `hypothesesConsidered` array of length 2–3 instead of a bare conclusion. The value migrated from elicitation (the 2022 result) to structuring: I get inspectable, testable, renderable reasoning as a typed field, which a "reason carefully" instruction alone would not produce.

```
2022: CoT unlocks reasoning   2026: model reasons anyway
                              CoT shapes OUTPUT → hypothesesConsidered[]
```

**[arch] "Where would chain-of-thought hurt in this system?"**

The intent classifier — `classifyIntent` has `max_tokens: 16` and demands one word (`intent.ts` L20). Tell it to think step by step and it spends the budget on "Let me consider…" and never reaches the label. CoT also adds nothing to the monitoring output (a measurement) or the recommendation rationale (which reasons *from* the diagnosis, so the CoT already happened upstream). Reflexively adding CoT everywhere is the mistake; knowing it breaks a 16-token classifier is the signal.

```
classifier: max_tokens 16 + "one word" + "think step by step" → budget gone, no label
```

### The question candidates always dodge

**"Is the `reasoning` field a faithful record of how the model actually decided?"** No — it is post-hoc. The model generates `hypothesesConsidered[].reasoning` alongside its conclusion; it is what the model *claims* it reasoned, not a transcript of how it actually decided. The structured array is excellent for auditing the claimed reasoning and weak as a proof of the real process — the same faithfulness gap as any CoT. Presenting it as "explainable AI" that proves the reasoning is the dodge.

### One-line anchors

- `diagnostic.md` L20 — "generate 2–3 hypotheses before your first tool call": breadth before depth.
- `diagnostic.md` L69–L75 — `hypothesesConsidered[{ hypothesis, supported, reasoning }]`: structured CoT.
- `lib/agents/base.ts` L108–L113 — `onText` → `reasoning_step`: ReAct externalizes process reasoning.
- `lib/agents/base.ts` L9 — `claude-sonnet-4-6`: reasons internally, so CoT shapes output.
- `lib/agents/intent.ts` L20 — `max_tokens: 16`: where CoT would consume the whole budget.

---

## Validate

### Level 1 — Reconstruct

From memory, draw the diagnostic flow's three reasoning layers: the prompt forcing hypotheses before action, ReAct externalizing process thought, and the output capturing CoT as `hypothesesConsidered[]`. State which artifact is transient (the Thought stream) and which is durable (the typed array).

### Level 2 — Explain

Out loud: why does CoT's value on sonnet-4-6 (`base.ts` L9) come from output structure rather than elicitation? Contrast the 2022 davinci result ("think step by step" unlocked reasoning) with 2026 (the model reasons regardless; the scaffolding produces the `hypothesesConsidered` array).

### Level 3 — Apply

Scenario: a teammate wants to add "think step by step" to the intent classifier to improve accuracy. Open `intent.ts` L20 (`max_tokens: 16`) and L21–L23 ("ONLY the one word"), and explain exactly what breaks. Then state where structured CoT *does* belong and why (`diagnostic.md` L69–L75).

### Level 4 — Defend

A reviewer says: "Add a reasoning field to every agent's output for transparency." Defend keeping CoT only on the diagnostic agent — name the token cost on monitoring, the upstream-duplication on recommendation, and the budget break on the classifier — and concede the one place a reviewer is right (diagnosis benefits from inspectable hypotheses).

### Quick check — code reference test

In which output field does the diagnostic agent capture its chain-of-thought, and what does each element contain? (Answer: `hypothesesConsidered`, an array of `{ hypothesis, supported, reasoning }` objects — `diagnostic.md` L69–L75, required by `isDiagnosis` in `validate.ts`.)

---
Updated: 2026-05-29 — Resynced sibling-prompt refs (pre-existing drift): diagnostic.md `hypothesesConsidered` shape L54–60→L69–75, field-rules ref L71→L90, monitoring output L50–73→L69–97, recommendation output L46–65→L49–74. (`diagnostic.md` L20 "generate 2–3 hypotheses" verified still correct — left unchanged.)
