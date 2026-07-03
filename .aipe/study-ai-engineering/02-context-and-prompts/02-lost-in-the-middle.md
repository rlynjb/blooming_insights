# 02 — Lost-in-the-middle

**Type:** Industry standard. Also called: attention drop-off, positional bias, middle-of-context penalty.

## Zoom out, then zoom in

The empirical pattern that models attend strongest to the start and end of the context window. Not directly measured in this codebase but shapes how tool_result content is structured.

```
  Zoom out — where positional bias would show up

  ┌─ messages array (grows across the loop) ──────────────────────────┐
  │  [system]        ← START ─── attended strongly                    │
  │  [user: anomaly]                                                  │
  │  [asst: thought] ← MIDDLE ── attended less                        │
  │  [user: tool_result]                                              │
  │  ...many turns...                                                 │
  │  [asst: latest thought]                                           │
  │  [user: latest tool_result]  ← END ── attended strongly           │
  │                                                                   │
  │  ★ THIS CONCEPT ★                                                 │
  └───────────────────────────────────────────────────────────────────┘
```

Zoom in. Empirical result from research on Claude, GPT-4, and open models: attention weight is highest at the very beginning (system prompt, opening context) and at the very end (recent turns). Middle-of-context content is more likely to be ignored or misremembered. In this repo, the pattern is present in theory but our messages arrays are small enough (~35K peak) that we don't measurably hit it.

## Structure pass

**Layers:**
- Outer: reader observation (agent forgets something from turn 3)
- Middle: model's attention weights
- Inner: transformer attention mechanics

**Axis: model attention by position.**
- Start (system, first user): strong attention
- Middle (turns 3-6 of a 10-turn loop): weak attention
- End (latest turns): strong attention

**Seam:** the messages array ordering. What goes first and last is what the model attends to; the middle is where lossy compression happens implicitly.

## How it works

### Move 1 — the mental model

Think of a phone number someone tells you. First three digits and last four — easy. The middle two? You forget them and have to ask again. Same shape. Attention over a long context isn't uniform; middle content is systematically discounted.

```
  Attention weight by position (empirical, generalized)

  weight
    │
    │▓                              ▓
    │▓▓                           ▓▓▓
    │▓▓▓                        ▓▓▓
    │▓▓▓                       ▓▓▓
    │▓▓▓▓                     ▓▓▓▓
    │▓▓▓▓▓                   ▓▓▓▓▓
    │▓▓▓▓▓▓                 ▓▓▓▓▓▓
    │▓▓▓▓▓▓▓__▓_▓__▓_▓_▓___▓▓▓▓▓▓▓
    └──────────────────────────────►
      start        middle        end
                position in context
```

Origin of the "middle" penalty: transformer attention is bidirectional (each token attends to all others), but decoder-only autoregressive models are trained on next-token prediction, which biases them toward recent context (needed for generation) AND toward opening context (often instructions). The middle gets neither training signal strongly.

### Move 2 — walk the mechanism

**Where this WOULD hurt in this codebase.**

If a diagnostic investigation ran 20+ tool calls (it doesn't; capped at 6), the earliest tool_result blocks would sit in the middle of the messages array by turn 15. The model might weight the freshest 2-3 tool_results heavily and effectively ignore the early ones — even though early evidence might be critical to the diagnosis.

**Why we don't measurably hit it.**

Two design choices keep this codebase away from the failure mode:

1. **The 6-tool-call budget.** With at most 6 tool calls, the messages array stays short (~35K peak). Everything is close enough to the "end" that positional bias barely matters.
2. **Schema-constrained conclusion.** The agent's final output is a `Diagnosis` object with `evidence` array — the model has to explicitly cite what supports each hypothesis. That forces it to REFER to what's in the tool_results, which brings the referenced content back into the model's active attention rather than relying on positional recall.

**What we'd do differently at higher tool-call counts.**

Two mitigations from the research:
- **Summarize old turns.** After N turns, replace the earliest tool_result blocks with a running summary of "what we've learned so far." Trades detail for position — the summary lives at the start (strong attention) instead of the middle (weak).
- **Move the question to the end.** Restate the anomaly / goal in the LATEST user message, not just the first one. The model attends to the end; restating the question there anchors the reasoning.

Neither is implemented today because we haven't measured the failure mode. Case B exercise would be adding the summarization.

### Move 3 — the principle

Position in the messages array is a proxy for model attention. Put load-bearing information at the start (system prompt, the question) or at the end (fresh tool_result, restated goal). Don't bury the key finding in the middle of a long loop and expect the model to remember it. When you can't avoid it, summarize.

## Primary diagram

```
  What "middle" looks like in this repo (turn 10 of a diagnostic)

  ┌─ messages array (~35K tokens) ────────────────────────────────────┐
  │                                                                   │
  │  system         ▓▓▓ 2-3K     [START — strong attention]            │
  │  tools          ▓▓  1-2K                                           │
  │  user: anomaly  ▓   0.5K                                           │
  │  ─────                                                            │
  │  asst turn 2    ▓   0.3K                                           │
  │  tool_result 2  ▓▓  1.2K     [MIDDLE — weak attention]             │
  │  asst turn 3    ▓   0.3K                                           │
  │  tool_result 3  ▓▓  1.8K     ↓                                     │
  │  asst turn 4    ▓   0.4K     ↓ risk zone if history                │
  │  tool_result 4  ▓▓  1.5K     ↓ grew much longer                   │
  │  asst turn 5    ▓   0.3K                                           │
  │  tool_result 5  ▓▓  1.9K                                           │
  │  asst turn 6    ▓   0.4K                                           │
  │  tool_result 6  ▓▓▓ 2.1K                                           │
  │  ─────                                                            │
  │  asst turn 7    ▓   0.4K     [END — strong attention]              │
  │  final result   ▓   0.5K                                           │
  │                                                                   │
  │  Because history is short (~35K vs 200K limit), everything         │
  │  is "close enough" to start/end. No measured misattention today.   │
  └───────────────────────────────────────────────────────────────────┘
```

## Elaborate

The finding comes from "Lost in the Middle: How Language Models Use Long Contexts" (Liu et al., 2023) which measured attention accuracy on multi-document QA at varying gold-position depth. Consistent finding across models: U-shaped accuracy curve, with a valley in the middle third of context.

The problem gets worse with longer contexts. At 200K, the middle-attention degradation is measurable in benchmarks. At 30K, it's within noise. This codebase runs at the low end of that range, which is why we don't see it as a practical issue.

Related failure modes: **needle in a haystack** (finding one specific fact in a long context — modern models do well on this at the ends, poorly in the middle); **long-context recall degradation** (attending to details from earlier in the conversation).

## Project exercises

### Exercise — running summary for long investigations

- **Exercise ID:** C2.2-B · Case B (concept not exercised; would matter if tool-call cap were raised).
- **What to build:** when the tool-call count > 4, insert a "summary of findings so far" as an assistant message BEFORE the growing tool_result history. Model summarizes what earlier tool_results showed; each summary replaces the raw earlier turns in the messages array, keeping recent turns in full detail.
- **Why it earns its place:** proves you know the failure mode and have a mitigation. Interviewer signal: "for longer loops I'd summarize old turns to keep the anchor at the start instead of letting it drift into the middle."
- **Files to touch:** `lib/agents/aptkit-adapters.ts` (or a wrapper), a small summarization helper that intercepts the messages array before `complete()`.
- **Done when:** running an artificially-extended diagnostic (raise cap to 12) shows the messages array has summaries instead of raw early turns; a test proves the summary preserves the key finding.
- **Estimated effort:** 1-2 days.

## Interview defense

**Q: Does lost-in-the-middle affect this codebase?**

Not measurably at today's usage. The 6-tool-call cap keeps the messages array around 35K peak; everything is close enough to the start or end that positional bias is within noise. If we raised the cap to 15-20 tool calls, the risk would show up — turn 3's tool_result would sit in the "middle" of a 100K+ context and the model might weight it low.

**Q: What would you do at higher tool-call counts?**

Summarize old turns. After turn N, replace the earliest tool_results with a running summary of "what we've learned so far." That trades detail for position — the summary sits at the start (strong attention) instead of raw content sitting in the middle (weak attention). Trade-off: some detail is compressed away, so the summarization prompt has to preserve what's diagnostically important.

**Q: How would you MEASURE if it was happening?**

Adversarial eval. Craft a case where the diagnosis-critical evidence appears in turn 2's tool_result, then extend the loop with irrelevant follow-up tools that push turn 2's evidence into the middle. Judge whether the diagnosis still cites turn 2's finding. If the citation rate drops as the loop gets longer, that's lost-in-the-middle. Not in the current harness — a candidate case for Adversarial set expansion (`05-evals-and-observability/01-eval-set-types.md`).

## See also

- `01-context-window.md` — the container this pattern lives in
- `05-evals-and-observability/01-eval-set-types.md` — adversarial set could probe this
- `04-agents-and-tool-use/06-error-recovery.md` — the 6-call cap that keeps us safe
