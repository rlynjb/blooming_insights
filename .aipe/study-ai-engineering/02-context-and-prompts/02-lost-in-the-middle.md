# Lost in the middle

## Subtitle

Positional attention degradation / long-context recall failure — Industry standard.

## Zoom out, then zoom in

Empirically, LLMs attend strongly to the start and end of long contexts and weakly to the middle. This isn't a bug in your prompt; it's a property of how transformers were trained. If the answer to the user's question is buried in the middle of 40k tokens of tool results, the model may miss it even though "the answer is in the context."

In this codebase the risk shows up when the diagnostic agent accumulates many tool results and then has to reason across all of them. Each tool result is a `user`-role message with a `tool_result` block; by turn 8, the model is reading 5–8 of them, and the ones from turns 3–5 are in the middle of the accumulated context.

```
  Zoom out — where mid-context attention risk lives

  ┌─ System prompt (start — well-attended) ───────────────┐
  └───────────────────────┬───────────────────────────────┘
                          │
  ┌─ Schema, tools (start — well-attended) ──────────────┐
  └───────────────────────┬───────────────────────────────┘
                          │
  ┌─ Early turns (near start — well-attended) ───────────┐
  │  turns 1-2 tool results                               │
  └───────────────────────┬───────────────────────────────┘
                          │
  ┌─ ★ MIDDLE ★ (attention degrades) ────────────────────┐ ← risk zone
  │  turns 3-6 tool results                               │
  └───────────────────────┬───────────────────────────────┘
                          │
  ┌─ Late turns (near end — well-attended) ──────────────┐
  │  turns 7-9 tool results + current question            │
  └───────────────────────┬───────────────────────────────┘
                          │
                          ▼
                    model response
```

Zoom in: this is why "just add more context" is not the fix for retrieval quality.

## Structure pass

- **Layers:** early context → middle context → late context → response. One dimension, three regions.
- **Axis: attention strength.** Empirically U-shaped — high at edges, low in the middle. Not a knob you can tune; a property of the model's training.
- **Seam:** where in the message list a fact sits determines whether the model uses it. Not a code seam — a positional one.

## How it works

### Move 1 — the mental model

Imagine reading a 300-page technical book with the answer to your question on page 150. You'd remember the intro clearly; you'd remember the conclusion clearly; you'd hazily remember pages 30 and 270. Page 150 might not surface unless you re-read it. Transformer attention behaves the same way at long context lengths.

The failure isn't binary. A model given a mid-context fact often *does* find it — the attention is degraded, not zero. But the failure rate is higher there, and the failure mode is silent: the model produces a fluent but wrong answer.

```
  Empirical attention pattern — cartoon

  attention
  strength
     │
     │ █████                                    █████
     │ █████                                    █████
     │ █████ ████                          ████ █████
     │ █████ ████ ███                  ███ ████ █████
     │ █████ ████ ███ ██          ██ ███ ████ █████
     │ █████ ████ ███ ██ █ █ █ █ █ █ ██ ███ ████ █████
     └─────────────────────────────────────────────► position
       start          middle             end

       edges get read;
       middle gets skimmed
```

### Move 2 — the step-by-step walkthrough

**Where it shows up in this codebase.** Long diagnostic runs — the ones that fire 8+ tool calls before submitting a diagnosis. By turn 8, the assistant messages + tool results from turns 3–5 are mid-context. If the *root cause signal* is in one of those mid-context tool results, the model may reach a diagnosis that doesn't fully cite it.

**Concrete example — golden case 08.** From the eval receipts, cases 01 and 08 both showed "the primary root cause is payment processor" as the intended diagnosis. The scan evidence carries `payment_failure_rate rose 31.2%` — that's the load-bearing signal. If the agent fires 5–6 EQL queries chasing checkout UX, session drop, and other hypotheses before circling back to payment, the payment_failure evidence from turn 2 is now in the middle of a 20k-token context. Attention degradation is one reason the model produces "pause the A/B experiment" as a rec instead of "escalate to payments" — the wrong mid-context evidence gets weighted.

**Mitigations available in this codebase.**

1. **Bound each tool result.** A shorter mid-context block is more likely to be read fully. See `B2.1` in **01-context-window.md**.
2. **Summarize as the agent goes.** Have the agent explicitly emit a `reasoning_step` that restates its current best hypothesis at each turn — pushing the current-best summary into the *end* region where attention is highest. Not implemented.
3. **Reorder messages before final diagnosis.** Before the model's final answer turn, inject a synthesized summary of "the most relevant evidence so far" at the end. Not implemented.
4. **Retrieval + reranking.** For a RAG setup (this codebase doesn't have one yet — see sub-section 03), retrieve top-k relevant chunks *ranked to put the most relevant at the ends*.

Diagram of the risk zone:

```
  Position vs attention — one 10-turn diagnostic

  position (token offset)  ← attention (subjective)
  ──────────────────────────────────────────────
  0-15k     fixed prefix          █████ high
  15-18k    turn 1 (user + asst)  █████ high
  18-22k    turn 2 (+ tool_res)   ████  medium-high
  22-27k    turn 3-4              ██    LOW ← lost-in-middle zone
  27-32k    turn 5-6              ██    LOW ←
  32-38k    turn 7-8              ████  medium-high
  38-42k    turn 9 (asst final)   █████ high
```

### Move 3 — the principle

Context size is not the same as recall. The model attends unevenly across the context; long contexts amplify the effect. The engineering discipline: put important facts at the ends when you have a choice; keep the middle dense-but-brief; measure whether long-context runs degrade quality (they usually do).

## Primary diagram

```
  Lost in the middle — full frame

  ┌────────────────────────────────────────────────────────┐
  │  START region (high attention)                         │
  │  · system prompt · tools · schema                       │
  │  · turn 1 tool results (still near start)              │
  └────────────────────────────────────────────────────────┘
                          │
                          ▼
  ┌────────────────────────────────────────────────────────┐
  │  MIDDLE region (degraded attention) ← failure zone     │
  │  · turns 3-6: tool results from the exploration phase   │
  │    of a diagnostic run                                  │
  │  · this is where the primary-cause evidence often ends  │
  │    up buried on runs that took many hypotheses to reach │
  │    the answer                                           │
  └────────────────────────────────────────────────────────┘
                          │
                          ▼
  ┌────────────────────────────────────────────────────────┐
  │  END region (high attention)                            │
  │  · latest tool result · current question                │
  │  · assistant's next turn (the diagnosis)                │
  └────────────────────────────────────────────────────────┘

  Mitigations:
    · bound each tool result (see B2.1)
    · summarize-as-you-go (reasoning_step restates hypothesis)
    · reorder-before-final (inject summary at end)
    · retrieve+rerank (put top matches at ends)
```

## Elaborate

The phrase and empirical measurement come from Liu et al. 2023 ("Lost in the Middle: How Language Models Use Long Contexts"). The pattern replicates across model families — GPT-4, Claude, open-source models. Newer long-context models (100k+, 1M+) have partially mitigated the effect through training changes, but it hasn't gone away.

The mitigations that generalize: (1) put load-bearing facts at the ends, (2) keep the middle dense, (3) use retrieval-and-rerank to select which facts get into context in the first place. The mitigation that doesn't help: bigger context. Bigger context makes the middle longer, not the attention better.

Related: **../03-retrieval-and-rag/07-reranking.md** (the reranking pattern that puts most-relevant chunks at prime attention positions). **../01-llm-foundations/06-token-economics.md** (bigger contexts also cost more).

## Project exercises

### B2.2 · Summarize-as-you-go: force the diagnostic agent to restate its best hypothesis each turn

- **Exercise ID:** B2.2
- **What to build:** Modify the diagnostic agent's system prompt to require a "current best hypothesis: ..." line in every reasoning_step. This puts the running summary at the end of the context every turn, where attention is highest.
- **Why it earns its place:** Directly targets the lost-in-the-middle mode the recommendation-fit eval failure (cases 01, 08) is likely a symptom of. Measurable: rerun the baseline, check if `diagnosis_response` pass rate improves.
- **Files to touch:** aptkit's diagnostic system prompt (external) — since this codebase wraps aptkit, contribute the change to aptkit or add a `systemPromptAddendum` config option; extend `lib/agents/diagnostic.ts` to pass it.
- **Done when:** the reasoning_step trace shows the "current best hypothesis" line, and rerunning the baseline shows either a stable or improved recommendation-quality pass rate.
- **Estimated effort:** `1–2 days`.

## Interview defense

**Q: You've observed cases 01 and 08 failing with the "pause the A/B experiment" recommendation. Is lost-in-the-middle the cause?**

Suspected, not proven. The primary root cause is a payment_failure signal that gets discovered on turn 2 but doesn't stay in the front of context by turn 10. That's the mid-context risk zone. Proof would require a targeted eval — run the same case with a message reorder that keeps payment_failure at the end, compare recommendation quality. The load-bearing part of the answer: I can point at the specific eval failure and the specific structural reason, and I can design the experiment that would confirm or refute.

**Q: Wouldn't just using a smaller model help?**

Sometimes — smaller models have less context to lose things in, so the effect is smaller. But smaller models are worse at multi-turn reasoning overall, so you'd trade one failure mode for another. The right lever is context management (bound tool results, summarize as you go, retrieve+rerank), not model choice.

## See also

- [01-context-window.md](01-context-window.md) — the container this attention pattern applies to.
- [../03-retrieval-and-rag/07-reranking.md](../03-retrieval-and-rag/07-reranking.md) — the RAG-side mitigation.
- [../05-evals-and-observability/02-eval-methods.md](../05-evals-and-observability/02-eval-methods.md) — how to design the eval that proves or refutes this cause.
