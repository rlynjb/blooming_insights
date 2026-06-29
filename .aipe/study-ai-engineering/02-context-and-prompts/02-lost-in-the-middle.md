# Lost-in-the-middle problem

*Industry standard — attention degradation in long contexts*

## Zoom out — where this concept lives

Long contexts don't get attention uniformly. The model attends strongly to the *start* and *end* of context, weakly to the middle. This codebase doesn't have a long-context retrieval problem (the prompts are small), but the pattern still shapes one choice: where the schema summary lives in the prompt.

```
  Zoom out — where positional bias lives

  ┌─ Prompt assembly ────────────────────────────┐
  │  System prompt                                │ ← START — highest attention
  │  Schema summary                               │ ← still high
  │  Tool definitions                             │
  │  Prior conversation turns                     │ ← MIDDLE — weakest
  │  Latest tool result                           │
  │  Latest user-question / current task          │ ← END — high again
  └────────────────────┬─────────────────────────┘
                       │
                       ▼
  ┌─ Model — attention drops in the middle ──────┐
  │   if relevant info is mid-prompt, it may be   │
  │   underweighted or missed                     │
  └──────────────────────────────────────────────┘
```

**Zoom in.** This codebase doesn't currently stuff long contexts (~15-30k tokens typical, well below the long-context regime where this hurts most). But the *principle* matters for how prompts are ordered.

## Structure pass — layers · axes · seams

**Layers:** prompt position → model attention → output quality.

**Axis: where in the prompt does the load-bearing info sit?** This codebase puts the rules at the top (system prompt), the workspace shape next (schema summary), and the current task at the bottom (latest tool result + next-step instruction). Head and tail; the middle is tool definitions + prior turns.

**Seam:** the prompt assembly order. Today it's implicit (Anthropic SDK puts system first, messages in array order). Re-ordering is a soft lever that costs nothing.

## How it works

### Move 1 — the mental model

You know how a long meeting goes — you remember what was said at the start and at the end, the middle is fuzzy? Transformer attention has the same shape, empirically.

```
  Attention distribution across a long prompt (cartoon)

  attention
  weight
    ↑
    │ ██                                  ██
    │ ██                                  ██
    │ ██                                  ██
    │ █████                            █████
    │ ██████                          ██████
    │ ████████  ░░░░░░░░░░░░░░░░░░  ████████
    │ █████████░░░░░░░░░░░░░░░░░░██████████
    │ ──────────────────────────────────────►  prompt position
       START         MIDDLE              END

  Anything load-bearing should land in the high-attention
   regions: at the start (rules, schema) or at the end
   (current task, latest input).
```

### Move 2 — the step-by-step walkthrough

**Part 1 — what this codebase puts at the start.**

Monitoring's system prompt at `lib/agents/legacy-prompts/monitoring.md:1-37` opens with role + hard rules, in that order:

```
You are the monitoring agent in blooming insights...

## Role
You run a fixed checklist of ecommerce anomaly categories...

## Hard rules
1. Pass project_id: {project_id} to every tool call.
2. This workspace has no saved dashboards/funnels/trends...
3. Make at most 6 tool calls total, then stop and return your JSON answer.
...
```

The hard rules are the most-important content. They land in the highest-attention region (start of the system prompt). The schema summary follows immediately.

**Part 2 — what lives in the middle (and why that's OK here).**

After the system prompt come the tool definitions (in the `tools[]` array, ~800 tokens) and the accumulating conversation turns. These are the "middle" of a long agent loop. Two things keep this from biting:

  → **Tool definitions are reference material, not directives.** The model uses them when it decides to call a tool, not when it decides *whether* to call. The attention drop is OK.
  → **Conversation turns are short.** Each `tool_call` + `tool_result` pair is a few hundred tokens. The "middle" is short enough that the attention drop is mild.

**Part 3 — what lands at the end.**

The latest tool result and the implicit "what's next?" are at the tail of the prompt every turn. From the model's perspective, the freshest context (which it needs to use to pick the next action) is in the high-attention zone at the end. This is built into the loop's shape — no special engineering required.

**Part 4 — where the codebase would feel the bite.**

If a future version pre-loaded the entire raw workspace schema (untruncated, ~50-100k tokens) at the start, the *current task* would be far in the tail of a long middle. The model might lose the thread of "what am I checking right now?" — classic lost-in-the-middle failure mode.

The defense today: `schemaSummary` keeps the schema short (~500 tokens) so it's still in the start-of-prompt high-attention zone.

### Move 3 — the principle

**Put load-bearing content at the start or end; the middle is for reference material.** This codebase's prompts are short enough that the bite is mild, but the *order* still matters as the prompts grow. Rules → schema → tool defs → conversation → current task is a sound ordering for this shape.

## Primary diagram — the full recap

```
  This codebase's prompt order, mapped to attention regions

  Position in prompt          Content                         Attention
  ──────────────────────────────────────────────────────────────────────
  Start of system prompt   →  Role + Hard rules               ★★★★★  HIGH
  Mid system prompt        →  Schema summary (capped)         ★★★★    high
  End of system prompt     →  Category checklist + method     ★★★★    high
  ──────────────────────────────────────────────────────────────────────
  Start of tools[]         →  ~17 tool definitions            ★★      MID
  ──────────────────────────────────────────────────────────────────────
  Start of messages[]      →  Initial user prompt             ★★★     mid-high
  Mid messages[]           →  Accumulated tool_use/tool_result★★      MID
  End of messages[]        →  Latest tool result              ★★★★★   HIGH
                              + next-step trigger              ★★★★★   HIGH

  The load-bearing content (rules, schema, latest result) lives
   in the high-attention regions by default. The risk is future
   prompt-bloat shifting that.
```

## Elaborate

**Why this isn't a hot problem here today.** Three reasons:

  1. **Short contexts.** ~15-30k tokens typical; lost-in-the-middle bites worst on 50k+ contexts.
  2. **Structured outputs.** Tool calls are schema-constrained; "the model missed a key fact in the middle of the prompt" is hard to manifest as a wrong tool call.
  3. **Short loops.** 6-call budget on monitoring, ~7-8 on diagnostic. The conversation history doesn't grow to lost-in-the-middle scale.

**Where this WOULD bite.** If RAG arrives later (a vector retrieval surface over the user's past investigations or the Bloomreach docs), the retrieved chunks would go *into* the prompt. Stuffing 20 retrieved chunks into the middle and asking a question is the canonical lost-in-the-middle scenario. Mitigations: rerank to put the most-relevant chunk first, summarize the middle chunks before they enter the prompt, or use a smaller `top-k` and trust the retrieval.

## Project exercises

### Exercise — Reorder the diagnostic prompt to put hypothesis-priors at the start

  → **Exercise ID:** B2.2
  → **What to build:** In `lib/agents/legacy-prompts/diagnostic.md` (and the corresponding AptKit prompt), restructure so that any prior hypotheses already supported by evidence are surfaced at the *top* of the prompt, before any tool definitions. The current order puts them mid-prompt; the reorder lifts them into the high-attention zone.
  → **Why it earns its place:** the retired Phase 3 eval finding of 30% conclusion instability had a positional component — when prior-turn hypothesis support landed in the conversation history middle, the model sometimes lost the thread. Reordering is a cheap soft lever before reaching for sampling changes.
  → **Files to touch:** `lib/agents/legacy-prompts/diagnostic.md`, the AptKit prompt builder if it owns ordering, `test/agents/diagnostic.test.ts` (add a regression case: same anomaly, supported hypothesis from a prior synthetic turn, assert the conclusion references the right hypothesis).
  → **Done when:** the prompt structure puts supported-hypothesis context at the top of the system prompt or as the first user message, and the regression test passes consistently across 10 runs.
  → **Estimated effort:** 1–4hr.

## Interview defense

**Q: "Do you worry about lost-in-the-middle?"**

Not in this codebase today — prompts run ~15-30k tokens, well below the long-context regime where positional attention degradation bites hard. But the *order* of the prompt still matters: rules at the start (highest attention), schema next, latest tool result at the end. The middle is tool definitions and prior conversation turns, which are reference material — the model uses them when it decides to call a tool, but they don't need to drive immediate decisions.

If RAG ever lands here, the chunks would go in the middle. Then reranking to put the most-relevant chunk first becomes necessary.

*Anchor: "Short prompts today; the order is sound; RAG is the future bite point."*

**Q: "Where would you put a critical instruction in a long prompt?"**

At the end, just before the model's next decision. Closing-instruction-at-the-end works better than buried-mid-prompt because the end is the second high-attention zone. The system-prompt-at-the-start also works, but it competes with all the other rules already there. End-of-prompt repetition is the cheap belt-and-suspenders move.

*Anchor: "Critical → end of prompt (or repeated at start + end). Avoid mid-prompt for anything load-bearing."*

## See also

  → `01-context-window.md` — the budget that frames how big "the middle" gets
  → `03-prompt-chaining.md` — splitting work across calls keeps each prompt short
  → `03-retrieval-and-rag/02-schema-gated-coverage.md` — the gating that keeps the schema summary small
