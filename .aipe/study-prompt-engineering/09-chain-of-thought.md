# Chain-of-thought (CoT)

**Industry name(s):** chain-of-thought, CoT prompting, step-by-step reasoning, reasoning-before-answer
**Type:** Industry standard · Language-agnostic

> diagnostic.md tells the model to "generate 2–3 hypotheses before your first tool call" (L20) and then requires that reasoning back as a *structured* field — `hypothesesConsidered[].reasoning` (L69–L75) — so CoT here is captured in a typed thinking field, not free-form prose; sonnet-4-6 reasons internally regardless, so the scaffolding earns its place by shaping OUTPUT STRUCTURE, not by eliciting hidden reasoning.


---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Chain-of-thought spans three sites in the diagnostic flow. The forcing instruction ("Generate 2–3 hypotheses before your first tool call") lives in the Per-agent definitions band, inside `diagnostic.md`'s method section. The live Thought stream is externalized by the Shared agent loop's `onText` hook, surfaced as `reasoning_step` events. The structured capture — the `hypothesesConsidered[]` array — sits back in the prompt's `## Output` block AND in the validator's `isDiagnosis` guard, so the reasoning is part of the contract, not free prose. CoT is everywhere reasoning gets shaped, surfaced, and pinned down.

```
  Zoom out — where chain-of-thought lives

  ┌─ Per-agent definitions ─────────────────────────┐  ← we are here
  │  ★ diagnostic.md L20: "2–3 hypotheses BEFORE     │
  │       first tool call" ★                         │
  │  ★ diagnostic.md L69–75: hypothesesConsidered    │
  │       { hypothesis, supported, reasoning } ★     │
  └─────────────────────────┬────────────────────────┘
                            │
  ┌─ Shared agent loop ─────▼────────────────────────┐  ← also here
  │  ★ onText → reasoning_step  base.ts L108–113 ★   │
  │  (transient live Thought stream, ReAct externalizes)│
  └─────────────────────────┬────────────────────────┘
                            │ finalText
  ┌─ Output contract ───────▼────────────────────────┐
  │  ★ isDiagnosis requires hypothesesConsidered ★   │
  │  validate.ts → CoT is part of the typed shape    │
  │  durable, queryable, assertable                  │
  └──────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question this file answers: how does blooming insights make the model reason through competing explanations before concluding, and where does it *capture* that reasoning so it can be inspected? CoT's modern value is not eliciting hidden reasoning — sonnet-4-6 reasons internally regardless — it is forcing the reasoning into a structured, inspectable output. The diagnostic agent gets a typed `hypothesesConsidered[]` array (each entry a `{ hypothesis, supported, reasoning }` triple); the other three agents correctly omit CoT (the monitoring output is numeric, the recommendation reasons from the diagnosis upstream, and the 16-token classifier would have its entire budget eaten by "Let me think…"). Below, you'll see why structured CoT beats prose CoT in 2026, and why "think step by step" is precisely wrong for the intent classifier.

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
   └─ the diagnostic prompt lives here: CoT captured in hypothesesConsidered[]
```

The diagnostic agent combines two reasoning scaffolds: structured CoT (hypotheses up front) layered on top of the ReAct loop (which externalizes thought as Thought→Action→Observation, → 06-single-purpose-chains.md). One shapes the output; the other shapes the exploration.

---

### Force breadth before depth — hypotheses before the first tool call

The instruction is precise about *ordering*: reason first, act second. Both the diagnostic prompt's Role and its first investigation step require it:

```
diagnostic prompt — reason before act
─────────────────────────────────────────────────────────────
 Role:   "generate 2–3 competing hypotheses, query the data to
          test each, and conclude"
 Step 1: "Generate 2–3 hypotheses before your first tool call
          (e.g. device-specific regression, seasonal/geographic
          shift, campaign traffic change, ...)"
```

"Before your first tool call" is the load-bearing phrase. It forces the model to enumerate *competing* explanations while its context is still clean — before any query result biases it toward the first thing it sees. This is CoT as anti-anchoring: generate the hypothesis space first, then test it, instead of querying once and rationalizing whatever came back. The next lines then instruct "design queries to falsify each hypothesis" — the reasoning is not decoration, it directs the exploration.

```
WITHOUT: query → see result → conclude (anchored on first result)
WITH:    enumerate 2–3 hypotheses → query to falsify each → conclude
         └─ breadth committed before any result can bias it ─┘
```

---

### Capture the reasoning as a typed field — `hypothesesConsidered[]`

The hypotheses do not stay in the model's head; they come back in the output schema. The `## Output` block requires `hypothesesConsidered` as an array of typed objects:

```
diagnostic prompt — structured CoT field
─────────────────────────────────────────────────────────────
 "hypothesesConsidered": [
   {
     "hypothesis": "string — what you tested",
     "supported": true,
     "reasoning": "string — why the data supports
                   or rules this out"
   }
 ]
```

This is the textbook recommendation made real: *put the reasoning in a thinking field, not free-form prose.* Each hypothesis carries its own `reasoning` string and a boolean `supported` — so the chain of thought is queryable (which hypotheses were ruled out?), assertable (a test can check `hypotheses_considered.length >= 2`), and renderable (the UI can show ruled-out alternatives, not just the winner). The field rules close the loop: "include all 2–3 hypotheses you tested. `supported: true` means this hypothesis best explains the data." The reasoning is part of the contract the diagnosis guard enforces (the guard requires `hypothesesConsidered` to be an array).

```
reasoning as prose:   one blob, unparseable, untestable, unrenderable
reasoning as field:   hypothesesConsidered[{ hypothesis, supported, reasoning }]
                      └─ queryable · assertable · renderable ─┘
```

---

### The ReAct loop externalizes thought too

Structured CoT shapes the *output*; the ReAct loop shapes the *process*, and it externalizes reasoning a second way. Each turn of the shared agent loop emits the model's text blocks through an on-text hook — that text *is* the model's interleaved reasoning between tool calls, surfaced into the live reasoning trace. So the diagnostic agent has two reasoning artifacts: the live Thought stream (ReAct, surfaced as `reasoning_step` events) and the final structured `hypothesesConsidered` array (CoT, in the output).

```
two reasoning artifacts in one diagnostic run
─────────────────────────────────────────────────────────────
 PROCESS (ReAct)   on-text hook → reasoning_step events
   model's text between tool calls — live, streamed, transient
 OUTPUT  (CoT)     hypothesesConsidered[] in the structured output
   final typed hypotheses — kept, validated, part of the contract
```

The Thought stream is transient (great for watching the run, → 06); the `hypothesesConsidered` array is durable (it survives into the saved diagnosis). CoT's job is the durable one.

---

### Move 2.5 — why CoT here is about structure, not hidden reasoning

The classic CoT result (Wei et al., 2022) was that "think step by step" *unlocked* reasoning the model otherwise skipped — on a 2022-era model, the scaffolding changed the answer. That is no longer the live reason to use it here. The frontier Sonnet-class model the agents run on does substantial reasoning internally without being told to; "think step by step" does not unlock hidden capability the way it did on davinci.

So what is the explicit scaffolding *for* in 2026? Output structure. "Generate 2–3 hypotheses" does not make Sonnet smarter — it makes Sonnet produce a `hypothesesConsidered` array of length 2–3 instead of a single conclusion. The value migrated from *eliciting* reasoning to *shaping and capturing* it.

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

- **Monitoring** returns an anomaly array with an `evidence` field but *no* per-item reasoning field. It detects and measures; free-form reasoning would bloat the output without improving the numbers. CoT would be cost without payoff.
- **Recommendation** returns actions with a `rationale` field — one line per action, not a hypothesis-falsification chain. It reasons *from* the diagnosis, so the heavy CoT already happened upstream; repeating it would duplicate work.
- **The intent classifier** would be *wrecked* by CoT. It has `max_tokens: 16` and demands "ONLY the one word." Tell it to "think step by step" and it spends its 16-token budget on "Let me consider…" and never reaches the label. CoT and a one-word output are directly incompatible.

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
│  PROMPT LAYER  the diagnostic prompt                                  │
│                                                                       │
│  "Generate 2–3 hypotheses BEFORE your first tool call"                │
│  "design queries to falsify each hypothesis"                          │
│           │  breadth committed before any result biases it            │
└───────────┼───────────────────────────────────────────────────────────┘
            ▼
┌──────────────────────────────────────────────────────────────────────┐
│  LOOP LAYER  the shared agent loop  (ReAct externalizes process thought)│
│                                                                       │
│  per turn: on-text hook → reasoning_step (Thought)                    │
│  Sonnet reasons internally; text between calls is streamed            │
│           │  transient — great for watching, not the durable artifact │
└───────────┼───────────────────────────────────────────────────────────┘
            ▼
┌──────────────────────────────────────────────────────────────────────┐
│  OUTPUT LAYER  the diagnostic prompt's Output + the diagnosis guard   │
│                                                                       │
│  hypothesesConsidered: [ { hypothesis, supported, reasoning } ]       │
│    ← STRUCTURED CoT: reasoning in a typed field, not free prose       │
│  the diagnosis guard requires the array → CoT is part of the contract │
│    queryable · assertable · renderable · durable                      │
└──────────────────────────────────────────────────────────────────────┘

  CoT's modern job: not eliciting reasoning (Sonnet reasons anyway) but
  forcing it into a typed, inspectable shape — and only where it pays.
```

The reasoning is forced up front, externalized live by ReAct, and captured durably as typed fields — structure, not elicitation.

---

## Implementation in codebase

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

## See also

→ 08-few-shot.md · → 02-structured-outputs.md · → 06-single-purpose-chains.md · → 04-token-budgeting.md

---
Updated: 2026-05-29 — Resynced sibling-prompt refs (pre-existing drift): diagnostic.md `hypothesesConsidered` shape L54–60→L69–75, field-rules ref L71→L90, monitoring output L50–73→L69–97, recommendation output L46–65→L49–74. (`diagnostic.md` L20 "generate 2–3 hypotheses" verified still correct — left unchanged.)
Updated: 2026-05-30 — Migrated to study.md v1.47 template (Phase 1+2 mechanical): removed Tradeoffs / Tech reference / Summary sections; renamed "In this codebase" → "Implementation in codebase"; moved See also to a bottom block. "Why care" preserved pending Phase 3 (Zoom out, then zoom in + LAYERS diagram) authoring.
Updated: 2026-05-30 — Phase 3 of study.md v1.47 migration: replaced "Why care" block with "Zoom out, then zoom in" (LAYERS diagram + zoom-in paragraph) per format.md.
Updated: 2026-05-31 — Applied study.md v1.48: scrubbed "How it works" of file paths, line refs, and real-code fences; replaced with generic role labels + pseudocode per format.md. Codebase-specific anchoring lives exclusively in "Implementation in codebase".
