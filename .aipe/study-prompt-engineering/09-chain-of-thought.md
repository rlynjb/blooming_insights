# Chain-of-thought (CoT)

**Industry standard** · step-by-step reasoning, where it earns its place

## Zoom out — where CoT lives in this codebase

Two patterns count as chain-of-thought in this codebase. The first is explicit, in the diagnostic prompt: *"Generate 2–3 hypotheses before your first tool call."* That's the model writing out its reasoning before acting. The second is implicit, in the structured output: the `hypothesesConsidered[]` field of `Diagnosis` captures the model's chain of reasoning as data, not free-form prose. The combination is the working AI engineer's version of CoT — structured, capped, validated.

```
  Zoom out — CoT in the diagnostic flow

  ┌─ diagnostic.md (the instruction) ───────────────────────┐
  │  ## Investigation approach                               │
  │  1. **Generate 2-3 hypotheses** before your first        │
  │     tool call.                                            │
  │  2. **Design queries to falsify each hypothesis.**        │
  │  3. **Locate WHEN the change happened** ...              │
  │  4. **Conclude** once you have data ...                  │
  └─────────────────────────┬───────────────────────────────┘
                            │
  ┌─ Diagnosis output (the trace as data) ──────────────────┐
  │  hypothesesConsidered: [                                 │
  │    { hypothesis, supported, reasoning }, ...             │
  │  ]                                                       │
  │  → CoT visible in the final output as a structured field │
  └─────────────────────────────────────────────────────────┘
```

## Zoom in

Chain-of-thought is the pattern where you ask the model to reason step-by-step before answering. It helps on multi-step problems (the model uses earlier reasoning to inform later steps); it hurts on simple lookups (the model wastes tokens reasoning about something obvious). The frontier-model caveat from 2025 onwards: modern models do CoT internally now, so asking for it explicitly is less necessary than it was for the 2022-era models — but it still helps for cheaper models, and it remains useful when you want the reasoning *as data* (the way blooming captures hypotheses).

## Structure pass

**Layers.** Two altitudes: the *instruction* (tell the model to reason in N steps before acting) and the *output* (capture the reasoning as a structured field, not as free-form prose).

**Axis traced — when CoT earns its place.** Hold one question constant: *does this task benefit from intermediate reasoning?*

```
  Axis = does CoT help here?

  ┌─ multi-step reasoning (CoT helps) ──────────────────────┐
  │   diagnostic: "given anomaly X, what could have caused   │
  │                it?" — requires hypotheses, query design,  │
  │                comparison across results                  │
  │   recommendation: "given diagnosis D, what action          │
  │                    best matches?" — needs feature mapping │
  └─────────────────────────────────────────────────────────┘
                              │
  ┌─ structured output (CoT hurts) ─▼───────────────────────┐
  │   intent: "classify this question as one of 3" — no       │
  │           reasoning needed, just pattern-match             │
  │   monitoring (mostly): "does this metric exceed the       │
  │                         threshold?" — threshold math,      │
  │                         not reasoning                      │
  └─────────────────────────────────────────────────────────┘
```

**Seams.** The instruction → behavior seam is where CoT either pays off or wastes tokens. The behavior → output seam is where you decide whether to capture the reasoning as data (structured field) or let it stay in the assistant's text (which gets discarded). blooming uses both — instruct the model to reason, capture the reasoning as a structured `hypothesesConsidered[]` field. That's the senior version of CoT.

## How it works

### Move 1 — the CoT pattern, as one picture

You know how a debugger lets you step through code one line at a time? Chain-of-thought asks the model to do the equivalent: walk through the reasoning one step at a time, write each step down, then commit to an answer. The model isn't smarter for doing this; it's *more consistent*. The intermediate steps act as scaffolding — once written, they constrain the final answer to be consistent with them.

```
  Pattern — CoT as scaffolding

  ┌─ without CoT ──────────────────────────────────────────┐
  │  user:    "given anomaly X, what caused it?"           │
  │  model:   <jumps straight to answer>                    │
  │           "device-specific regression"                  │
  │  problem: no visible reasoning · hard to audit          │
  │           if wrong, hard to know why                    │
  └────────────────────────────────────────────────────────┘

  ┌─ with CoT ─────────────────────────────────────────────┐
  │  user:    "given anomaly X, what caused it?"           │
  │  model:   step 1: "what could explain a 30% drop?"     │
  │             - device-specific regression                │
  │             - country shift                             │
  │             - campaign change                           │
  │           step 2: "which to test first?"                │
  │             - device, because it has highest prior      │
  │           step 3: <query for device segmentation>       │
  │           step 4: <interpret results>                   │
  │           answer: "mobile regression confirmed"         │
  │  benefit: each step constrains the next · audit trail   │
  └────────────────────────────────────────────────────────┘
```

### Move 2 — the diagnostic prompt's "hypotheses first" instruction

The diagnostic prompt's `## Investigation approach` section is CoT in action:

```
  diagnostic.md:18-24 — the instruction
  ┌────────────────────────────────────────────────────────────┐
  │ 1. **Generate 2-3 hypotheses** before your first tool call.│
  │    Examples: device-specific regression, country/region     │
  │    shift, campaign traffic change, product category         │
  │    collapse, data collection gap.                           │
  │ 2. **Design queries to falsify each hypothesis.** Segment   │
  │    the metric by the most likely discriminating dimension   │
  │    first ...                                                │
  │ 3. **Locate WHEN the change happened** ...                  │
  │ 4. **Conclude** once you have data supporting or ruling     │
  │    out each hypothesis. ...                                 │
  └────────────────────────────────────────────────────────────┘
```

Read this as a procedure: think (hypotheses), act (queries), measure (time-series), decide (conclude). The instruction *constrains the order of operations*. Without it, the model might query first and reason about results after — which on average produces less coherent investigations because the queries are exploratory rather than targeted. With it, the queries are designed to discriminate between hypotheses, which makes the data more interpretable.

The example list ("device-specific regression, country/region shift, ...") is doing important work too. It's not exhaustive; it's representative. The model uses it to prime its hypothesis space, then generates its own hypotheses for the specific anomaly. Without the examples, the model might generate fewer or more abstract hypotheses; with the examples, it generates hypotheses in the same shape (causal attribution to a specific dimension).

### Move 2 — the structured output captures CoT as data

Read the `Diagnosis` interface:

```
  // lib/mcp/types.ts:95-104
  export interface Diagnosis {
    conclusion: string;
    evidence: string[];
    hypothesesConsidered: {     // ← CoT as data
      hypothesis: string;
      supported: boolean;
      reasoning: string;
    }[];
    affectedCustomers?: { count: number; segmentDescription: string };
    confidence?: 'high' | 'medium' | 'low';
    timeSeries?: { day: string; value: number }[];
  }
```

The `hypothesesConsidered[]` field is the most important design move here. It's the model's reasoning, captured as a *structured field*, not as free-form prose in the conclusion. Three benefits compound:

**Audit.** When a diagnosis is wrong, the UI shows which hypotheses the model considered and rejected. The user (or the on-call engineer) can see "the model didn't test for country shift" and know the investigation was incomplete.

**Validation.** The type guard checks that hypotheses are an array of objects with `hypothesis`, `supported`, `reasoning`. Each hypothesis is a structured claim, not a sentence buried in prose. You can imagine a future eval that checks "did the diagnostic agent test at least 2 hypotheses?" — that's a one-line check against the structured field.

**UI rendering.** The `EvidencePanel` component renders hypotheses as a collapsible list. Each one is a row with the hypothesis, a supported/not-supported badge, and the reasoning. The structure is what makes the rendering possible — free-form prose would have to be hand-parsed.

This is the senior CoT pattern: *don't ask for reasoning in prose; ask for reasoning as structured data*. The model still does the reasoning; you just capture it in a shape you can use.

### Move 2 — the structured-output and CoT interaction

The spec calls this out: if you want both reasoning *and* a structured answer, the reasoning goes in a "thinking" field of the structured output, not in free-form prose. blooming does this with `hypothesesConsidered[]`. It also does it implicitly with the diagnostic prompt's procedure — the model "thinks aloud" in the assistant's text blocks during the tool-use loop (which get streamed to the `StatusLog` UI), then synthesizes into the final structured Diagnosis.

```
  CoT + structured output — two layers

  ┌─ during the loop ───────────────────────────────────────┐
  │   assistant text blocks (streamed to StatusLog):         │
  │   "I'll hypothesize device-specific regression..."       │
  │   "Querying device breakdown..."                         │
  │   "Mobile is down 40%, desktop flat — hypothesis confirmed"│
  │   → reasoning visible in real-time, not persisted         │
  └─────────────────────────┬───────────────────────────────┘
                            │  final turn
  ┌─ final structured output ──▼────────────────────────────┐
  │   {                                                      │
  │     conclusion: "Mobile checkout regression caused...",  │
  │     hypothesesConsidered: [                              │
  │       { hypothesis: "Device-specific regression",        │
  │         supported: true,                                 │
  │         reasoning: "Mobile -40%, desktop flat" },        │
  │       { hypothesis: "Country shift",                     │
  │         supported: false,                                │
  │         reasoning: "Country mix unchanged" }             │
  │     ],                                                   │
  │     ...                                                  │
  │   }                                                      │
  │   → reasoning preserved as data, queryable forever        │
  └─────────────────────────────────────────────────────────┘
```

The streaming text is for live observability (the user sees the agent thinking). The structured output is for long-term storage (the diagnosis is persisted, exported, replayed). Both are CoT; one is ephemeral, one is durable.

### Move 2 — where CoT is *deliberately not* used

Two agents don't use CoT and the reasoning matters.

**Intent classifier.** It's a one-word output. There's no multi-step reasoning to scaffold; the model just pattern-matches the question to one of three labels. Adding "explain your reasoning before answering" would balloon the output past `max_tokens: 16`, defeat the cheap-classifier point, and not improve accuracy (the task is too simple). Keep it: prompt is short, output is one word, no CoT.

**Monitoring agent.** Mostly. The monitoring agent does have some implicit reasoning (it picks a query plan, runs queries, interprets results), but the prompt doesn't explicitly say "reason step by step." Why? The work is mostly *measurement* — run the EQL queries, compare current vs prior, threshold the change, emit an anomaly. There's not much to *reason about* — the threshold is fixed in the rules, the metrics are pre-specified in the category checklist. The structured output captures what's needed (metric, change, severity, evidence); explicit hypothesis-generation would be busy-work.

The contrast with diagnostic is instructive: diagnostic *generates causal hypotheses*, which requires reasoning. Monitoring *applies thresholds*, which requires arithmetic. CoT helps the former and adds tokens to the latter.

### Move 2 — the modern-model caveat

Sonnet 4-6 (the model blooming uses for the structured agents) does CoT internally. Asking it to "think step-by-step" or "generate hypotheses first" is less necessary than it was for GPT-3.5 in 2022 — the model has been trained to reason before answering on its own. Two things still earn CoT instructions' place:

**Procedure-pinning.** "Generate hypotheses, then query, then conclude" is a *procedure*, not just a request for reasoning. The instruction is doing more than asking the model to think — it's specifying the *order* of operations. Without it, the model might query first and reason after (because the data is right there); with it, the model reasons first and uses the reasoning to design the queries. The procedure matters even if the model would reason without prompting.

**Reasoning-as-data.** Even if the model reasons internally, the reasoning doesn't surface in the output unless you ask for it. The `hypothesesConsidered[]` field forces the model to write down what it considered — which makes the output auditable. Internal reasoning that doesn't surface is invisible reasoning; it might as well not have happened, from a debugging perspective.

The Haiku-based intent classifier is the case where the modern-model caveat doesn't apply — Haiku is smaller, the task is trivial, no CoT instruction is needed. The Sonnet-based diagnostic agent has the instruction not because Sonnet *needs* it but because the *procedure* and the *audit trail* need it.

### Move 3 — the principle

Chain-of-thought is useful when the task benefits from structured intermediate reasoning and the reasoning itself is worth capturing. Use CoT for multi-step problems where the steps inform each other; skip it for simple lookups and pure classification. When you do use it, capture the reasoning as structured fields (not free-form prose) — the model still reasons either way; the difference is whether you can read the reasoning back, validate it, render it, and eval it.

## Primary diagram

```
  CoT in blooming — instruction + structured-field capture

  ┌─ diagnostic agent (CoT used heavily) ──────────────────────┐
  │                                                              │
  │  ┌─ instruction (diagnostic.md:18-24) ─────────────────┐    │
  │  │ 1. Generate 2-3 hypotheses BEFORE first tool call    │    │
  │  │ 2. Design queries to falsify each                    │    │
  │  │ 3. Locate WHEN the change happened (time-series)     │    │
  │  │ 4. Conclude once data supports/rules out each        │    │
  │  └─────────────────┬────────────────────────────────────┘    │
  │                    │                                          │
  │  ┌─ streamed assistant text ▼ (StatusLog, ephemeral) ──┐    │
  │  │ "I'll hypothesize device, country, campaign..."     │    │
  │  │ "Querying device breakdown..."                       │    │
  │  │ "Mobile -40%, desktop flat — device confirmed"       │    │
  │  └─────────────────┬────────────────────────────────────┘    │
  │                    │                                          │
  │  ┌─ structured output ▼ (durable, validated) ──────────┐    │
  │  │ Diagnosis {                                          │    │
  │  │   conclusion: "Mobile checkout regression caused...",│    │
  │  │   hypothesesConsidered: [                            │    │
  │  │     { hypothesis: "Device regression",               │    │
  │  │       supported: true,                               │    │
  │  │       reasoning: "..." },                            │    │
  │  │     ...                                              │    │
  │  │   ]                                                  │    │
  │  │ }                                                    │    │
  │  └──────────────────────────────────────────────────────┘    │
  └─────────────────────────────────────────────────────────────┘

  ┌─ intent classifier (CoT deliberately absent) ──────────────┐
  │  max_tokens: 16 · "reply with ONLY the one word"            │
  │  → no scaffolding · just pattern-match                      │
  └─────────────────────────────────────────────────────────────┘

  ┌─ monitoring agent (mostly arithmetic) ─────────────────────┐
  │  prompt has a query plan ("first check volume, then ...")   │
  │  but no "think step by step" — the work is threshold math   │
  └─────────────────────────────────────────────────────────────┘
```

## Elaborate

The original CoT paper (Wei et al., 2022) showed that asking GPT-3 to "think step by step" before answering arithmetic word problems substantially improved accuracy. The pattern generalized: complex tasks benefit from intermediate reasoning. By 2024, frontier models had been RLHF-trained on the same kind of step-by-step output style, so the explicit instruction became less necessary — the models "think aloud" by default on hard problems. The pattern still works; it's just less dramatic than it was.

What hasn't changed: CoT improves *audit* even when it doesn't improve *accuracy*. The model's reasoning, captured as text, is something you can read, eval against, and use for debugging. Models that "think aloud" by default produce text that gets discarded if you don't capture it; CoT-as-structured-field (the `hypothesesConsidered[]` pattern) is how you preserve it.

The diagnostic agent's procedure is the working version of what's sometimes called "ReAct" (Reason + Act) in the literature: the model alternates between reasoning steps and action steps (tool calls), with each step informed by the previous. The prompt encodes ReAct as a numbered procedure; the agent loop in `runAgentLoop` enforces the alternation (assistant text → tool_use → user text with tool_result → assistant text → ...). The structured `hypothesesConsidered[]` captures the "Reason" parts; the `evidence[]` captures the "Act" parts.

For cheaper models (Haiku, GPT-3.5, or older), the explicit CoT instruction matters more — those models are less likely to reason internally without prompting. blooming uses Sonnet for all the structured agents, so the instruction is partly belt-and-suspenders. If the system ever needs to fall back to a cheaper model (cost pressure, rate-limit overflow), the existing CoT instructions are what make that fallback viable — the procedure stays the same; only the model changes.

The "diminishing returns" of self-consistency CoT (concept #10 covers this) and the related Tree-of-Thoughts research are deliberately out of scope for this guide. They're research patterns; they're not yet production practice in this codebase or in most of the production systems worth studying. The basic CoT-with-structured-capture pattern is the one that ships.

## Interview defense

**Q: Does CoT still matter with modern models, or is it obsolete?**

A: Two parts of CoT mattered when it was introduced; only one is mostly obsolete. The *accuracy* part — models reasoning better when asked to think step by step — is mostly subsumed by modern training (Sonnet 4-6 reasons internally without prompting). The *audit* part — capturing the reasoning so you can read it back — is more important than ever and doesn't happen by default. blooming uses CoT not because Sonnet needs the scaffolding to think but because the diagnostic agent's reasoning is *valuable as data*: the `hypothesesConsidered[]` field on the Diagnosis output gets persisted, rendered in the UI, exported in the markdown export, and (potentially) checked against an eval. Internal reasoning that doesn't surface is invisible. CoT-as-structured-field is how you make it visible. So the instruction "generate 2–3 hypotheses before your first tool call" is doing two jobs even when the model would reason without it: pinning the procedure, and forcing the reasoning to surface in a captured shape.

```
  what I'd sketch:

  2022 CoT:  "think step by step" → accuracy ↑↑↑
                                    audit    ↑ (text)

  2026 CoT:  procedure + structured field
              accuracy ↑ (modern model would reason anyway)
              audit    ↑↑↑ (reasoning captured as queryable data)
```

**Q: Where would you NOT use CoT in this codebase?**

A: Two places. **The intent classifier** — it's a one-word output, max_tokens 16, the task is pattern-matching to one of three labels. Adding CoT would balloon the response past the token cap and slow down the routing. There's no multi-step reasoning to scaffold; the model either recognizes the question type or it doesn't. **The monitoring agent**, mostly — its work is measurement (run EQL, compare current vs prior, threshold the change). The prompt has a query plan but no "think step by step" because there isn't really thinking to do; it's arithmetic. The structured Anomaly output captures what's needed (metric, change, severity, evidence); explicit hypothesis-generation would be busy-work. The contrast with diagnostic is the lesson: diagnostic *generates causal hypotheses* (reasoning task, CoT helps), monitoring *applies thresholds* (arithmetic task, CoT doesn't earn its place).

```
  CoT decision rule:

  "does the task involve generating something new from the input?"
                            │
                  yes ──────┴───── no
                  │               │
              CoT helps       CoT adds tokens
              (diagnostic,    without value
               recommendation)(monitoring math,
                              intent classifier)
```

## See also

- [02-structured-outputs.md](./02-structured-outputs.md) — `hypothesesConsidered[]` is structured CoT, validated at the boundary
- [04-token-budgeting.md](./04-token-budgeting.md) — CoT costs tokens; skip where it doesn't earn its place (intent classifier)
- [06-single-purpose-chains.md](./06-single-purpose-chains.md) — different chains use CoT to different degrees because their jobs are different
- [10-self-critique.md](./10-self-critique.md) — self-critique is CoT taken one step further (model evaluates its own output)
