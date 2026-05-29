# Lost in the middle (and the recency placement this codebase leans on)

**Industry name(s):** lost-in-the-middle, positional attention bias, context ordering, recency placement
**Type:** Industry standard · Language-agnostic

> Models attend most reliably to content at the *start* and *end* of the context and least reliably to the middle; blooming insights has no retrieval to reorder, but it deliberately places its load-bearing content at the end — the `synthesisInstruction` is appended LAST to the system prompt on the final turn (`lib/agents/base.ts` L98), and tool results arrive as the MOST RECENT user turn (L171) — keeping what matters where attention is strongest. The real fix (retrieval + reranking) is absent here.

**See also:** → 01-context-window.md · → 03-prompt-chaining.md · → ../03-retrieval-and-rag/07-reranking.md · → ../04-agents-and-tool-use/02-tool-calling.md

---

## Why care

You render a long `.map()` of list items and the user only ever notices the first few and the last one — the items in the middle scroll past unread. A language model has a measurable version of the same bias: across a long context, it recalls information placed at the beginning and the end far more reliably than information buried in the middle. This is not a metaphor; it is a reproducible empirical effect (Liu et al. 2023, "Lost in the Middle").

The question every system that packs a lot into one context faces: given that position determines how reliably the model uses a fact, *where in the context* do you put the thing the answer most depends on?

**The pivot: position is not neutral — the same fact recalled perfectly at the end of the context can be effectively invisible in the middle, so placement is a correctness lever, not a formatting detail.** A system that ignores ordering can feed the model exactly the right evidence and still get a wrong answer because the evidence landed in the dead zone. blooming insights cannot reorder *retrieved* content — it does no retrieval — but it controls *conversation* ordering, and it puts the instruction that must be obeyed and the evidence that must be used at the end, where attention is strongest.

Before any ordering discipline:
- The instruction to "stop and emit JSON" sits at the top of a long system prompt, far from where the model decides what to do
- Tool results are scattered through a long transcript with no positional emphasis
- The model's final decision is made furthest from the content it should weight most

After recency placement:
- The `synthesisInstruction` is concatenated to the *end* of the system prompt on the final turn — last thing the model reads before answering
- Tool results are always the *most recent* user turn — the freshest position in the transcript
- The load-bearing content sits at the high-attention end, not the middle

It is the same instinct as putting the call-to-action button at the end of a form where the eye lands, not buried in the middle of a wall of fields.

---

## How it works

**Mental model.** Treat the model's attention over a long context like a U-shaped curve: high at the front, high at the back, sagging in the middle. Anything you place in the sag risks being underweighted regardless of how relevant it is.

```
attention reliability across context position
 high │█                                              █
      │██                                            ██
      │ ██                                          ██
      │  ███                                      ███
      │    ████        the "middle"            ████
  low │       ██████████████████████████████████
      └────────────────────────────────────────────────▶ position
        start              middle                 end
        ▲                    ▲                      ▲
        system prompt     buried evidence      most-recent turn
        (strong)          (weak — lost)        (strong)
```

The lever you have is *where* each piece lands on this curve. Two clean strategies exist: put critical content at the front (primacy) or at the back (recency). blooming insights consistently uses recency — the last thing the model reads is the thing it most needs to act on.

This is a *thin* surface, and it is worth saying plainly: ordering the conversation is a real but small mitigation. The substantial fix for lost-in-the-middle is retrieval that surfaces only the relevant content plus a reranker that orders it by relevance so nothing important lands in the sag — and blooming insights has neither (see → ../03-retrieval-and-rag/07-reranking.md). What follows is the recency discipline the codebase *does* practice.

---

### Recency lever 1 — the `synthesisInstruction` is appended LAST

On the forced-final turn, the instruction that must dominate the model's behavior is concatenated to the *end* of the system prompt. `lib/agents/base.ts` L95–L98:

```typescript
system: forceFinal && synthesisInstruction
  ? `${system}\n\n${synthesisInstruction}`   // instruction appended LAST
  : system,
```

The base system prompt — the persona, the schema summary, the task framing — comes first. The instruction "you have NO more tool calls available, stop and emit ONLY JSON" comes last (its text lives in each agent, e.g. `lib/agents/diagnostic.ts` L63–L67). On the final turn this is the single most important directive, and it sits at the high-attention tail of the system block rather than buried above the schema.

```
system prompt on the forced-final turn
┌──────────────────────────────────────────────────┐
│ persona + task framing            (front — strong)│
│ schema summary (20 events…)       (middle — weak) │
│ {anomaly} JSON                    (middle — weak) │
│ ─────────────────────────────────                 │
│ synthesisInstruction: "stop, emit  (END — strong) │  ← L98 appends here
│   ONLY JSON in a ```json fence"                    │
└──────────────────────────────────────────────────┘
   the must-obey directive lands at the strongest position
```

Putting the directive last is why the forced-final turn reliably produces JSON: the instruction the model must follow is the freshest thing in its system context.

### Recency lever 2 — tool results arrive as the MOST RECENT turn

Inside the loop, every batch of tool results is pushed as a new user turn at the *end* of the message array. `lib/agents/base.ts` L171:

```typescript
// Feed all tool results back as the next user turn
messages.push({ role: 'user', content: toolResults });   // L171
```

The model always makes its next decision immediately after reading the freshest evidence. The newest tool results are the most recent thing in the conversation, so the content the model should weight most for its *next* action sits at the recency end, not somewhere in the middle of the accumulated transcript.

```
messages array  (base.ts: init L79–81, asst L105, tool_results L171)
[0] user      initial prompt
[1] assistant tool_use blocks         turn 0
[2] user      tool_result …           turn 0 results
[3] assistant tool_use blocks         turn 1
[4] user      tool_result …  ◀── MOST RECENT — freshest evidence
                                  the next decision is made right after this
```

The accumulated middle (turns 1…N-1) is the sag; the latest tool result is at the high-attention tail by construction, because the loop always appends.

### The dedicated synthesize() call sidesteps the middle entirely

When the loop's final turn still fails to produce JSON, `synthesize()` (`lib/agents/diagnostic.ts` L87–L126) makes a *fresh* single-turn call with no accumulated transcript at all — just the anomaly, the formatted evidence, and the instruction. There is no middle to get lost in: the whole context is short, and the directive ("output ONLY JSON") sits at the end of a compact message (L105–L113). Collapsing the context is the most direct lost-in-the-middle mitigation available without retrieval — if there is no long middle, nothing can be lost in it.

```
loop context (long)                synthesize() context (short, flat)
[user] investigate                 [user] anomaly + evidence + "ONLY JSON"
[asst] tool_use                          ↑ no middle to lose anything in
[user] tool_result   ← middle
[asst] tool_use      ← middle
[user] tool_result
[asst] final (system: …+instr)
```

### Current state vs. future state

```
CURRENT (recency placement only)        FUTURE (retrieval + reranking)
────────────────────────────────       ────────────────────────────────
instruction appended last (L98)         retrieve only relevant evidence
tool results = most recent turn (L171)  rerank so top hits land at the ends
synthesize() collapses the context      pack reranked results, drop the rest
no control over what's in the middle    nothing irrelevant is in the context
```

Recency placement is a real lever but it only controls *where* content sits, not *what* is there. The substantive fix is to never put irrelevant content in the window in the first place (retrieval) and to order what remains by relevance so the strongest evidence occupies the high-attention ends (reranking) — both Case B for this codebase, covered in → ../03-retrieval-and-rag/07-reranking.md.

### The principle

When you cannot control *what* is in the context, control *where* it sits. Position is a correctness lever because attention is U-shaped: put the directive the model must obey and the evidence it must use at the recency end, and collapse the context to nothing when you can. But recognize the ceiling — placement cannot rescue a context stuffed with irrelevant content; only retrieval and reranking do that, and they are the real fix this codebase has not yet needed.

---

## Lost in the middle — diagram

This diagram spans the layers where positional placement is decided. The Service layer constructs the message order and the system-prompt order; the Provider boundary is where the ordered context meets the model's U-shaped attention. There is no retrieval/rerank layer — its absence is the point.

```
┌──────────────────────────────────────────────────────────────────────┐
│  SERVICE LAYER — placement decisions (the lever this codebase has)    │
│                                                                       │
│  system prompt assembly  base.ts L95–98                               │
│    [ persona │ schema │ anomaly │ synthesisInstruction ]              │
│                                          ▲ appended LAST (strong)     │
│                                                                       │
│  message array growth   base.ts L79/L105/L171                         │
│    [ user │ asst │ tool_result │ … │ tool_result ]                   │
│                                        ▲ most-recent turn (strong)    │
│                                                                       │
│  synthesize() escape hatch  diagnostic.ts L82–121                     │
│    short flat context → no middle to lose anything in                 │
│                                                                       │
│  ┌─ RETRIEVAL + RERANK LAYER ─ NOT PRESENT ─────────────────┐        │
│  │ would surface only relevant evidence and order it so the │        │
│  │ strongest hits land at the ends → see 03-retrieval-and-  │        │
│  │ rag/07-reranking.md                                       │        │
│  └──────────────────────────────────────────────────────────┘        │
└───────────────────────────┬───────────────────────────────────────────┘
                            │  ordered context crosses to the model
┌───────────────────────────▼───────────────────────────────────────────┐
│  PROVIDER BOUNDARY — U-shaped attention over position                │
│    front (strong) ── middle (weak/sag) ── end (strong)               │
│    anthropic.messages.create({ system, messages })   base.ts L102    │
└────────────────────────────────────────────────────────────────────────┘
```

The Service layer places the must-obey directive and the freshest evidence at the strong ends. The retrieval/rerank layer that would govern *what* sits in the middle does not exist — recency placement is the whole mitigation here.

---

## In this codebase

**Not yet mitigated by retrieval.** blooming insights has no RAG, no embeddings, and no reranker, so there is no retrieval-ordering step to push the most relevant content to the high-attention ends — it gathers evidence live via MCP tool calls and relies purely on *conversation* recency for placement. What it does, deliberately, is keep its load-bearing content at the end of the context.

### Files, functions, and line ranges

- **`synthesisInstruction` appended last:** `lib/agents/base.ts` L95–L98 — the directive is concatenated to the end of the system prompt on the `forceFinal` turn. Per-agent instruction text: `lib/agents/diagnostic.ts` L63–L67, `lib/agents/recommendation.ts` L58–L62, `lib/agents/monitoring.ts` L85–L89.
- **Tool results as the most-recent turn:** `lib/agents/base.ts` L171 — `messages.push({ role: 'user', content: toolResults })`; the array starts at L79–L81 and grows with each assistant turn (L105) and each result batch (L171).
- **Context-collapsing escape hatch:** `lib/agents/diagnostic.ts` L87–L126 (`synthesize()`) and `lib/agents/recommendation.ts` L82–L132 — a fresh single-turn call with a short flat context and the directive at the end (e.g. `diagnostic.ts` L105–L113).

### Where retrieval reordering would live

A reranking step would sit in a new `lib/mcp/` module (e.g. `rerank.ts`) called *between* gathering tool results and feeding them back at `lib/agents/base.ts` L171 — it would score each result against the anomaly/diagnosis and reorder the batch so the most relevant payloads land at the head and tail of what is fed back, rather than in whatever order the model happened to call the tools. The retrieval that would precede it is the broader Case B in → ../03-retrieval-and-rag/.

---

## Elaborate

### Where this pattern comes from

"Lost in the Middle: How Language Models Use Long Contexts" (Liu et al., 2023) measured retrieval accuracy as a function of where a relevant document sat in a long context and found a pronounced U-curve: accuracy was highest when the relevant content was at the very start or very end and dropped sharply in the middle. The effect holds across model families and grows with context length. It is a property of how attention distributes over position, not a quirk of any one model.

Primacy and recency as placement strategies long predate LLMs — they are the same effects studied in human serial-position memory. The engineering response is identical in both cases: put what matters at the edges.

### The deeper principle

```
two ways to fight the U-curve
─────────────────────────────────────────────────────────────
placement  (this codebase)   move the important content to an edge
                              cheap, no infra, but only reorders
                              what's already there

curation   (retrieval+rerank) remove the irrelevant content entirely,
                              then order the rest by relevance so the
                              best hits occupy the edges
                              the real fix; needs infra
```

Placement and curation are complementary, not competing. Placement is what you do when you cannot remove content; curation is what you do when you can. blooming insights does only placement because its contexts are short enough (bounded by the character budgets in → 01-context-window.md) that the sag is shallow. The day a context is long and full of mixed-relevance evidence, placement alone stops being enough and curation earns its cost.

### Where this breaks down

1. **Placement cannot help if the important content is the *quantity*, not a single item.** Recency favors the latest tool result, but a diagnosis that depends on *all six* results equally has five of them sitting in the middle no matter how you order the batch. Placement helps one item; it cannot pull six items all to the edges.

2. **A long accumulated transcript has a real sag.** As the loop runs, turns 1…N-1 pile up in the middle. The synthesisInstruction and the latest result are at the edges, but evidence from early turns sits in the dead zone. `synthesize()`'s context-collapse is the only thing in the codebase that addresses this, and only on the fallback path.

3. **No measurement.** Nothing in the codebase tests whether reordering the context changes the answer. The recency placement is a reasoned bet, not a verified one — there is no position-sensitivity probe (the exercise below).

### What to explore next

- **Reranking (cross-encoder, Cohere Rerank, BGE-reranker):** score candidates by relevance and place the top hits at the context edges — the direct fix, covered in → ../03-retrieval-and-rag/07-reranking.md.
- **Context compaction / summarization:** collapse the middle turns into a short summary so there is less sag to lose anything in — generalizes `synthesize()`'s context-collapse to the main path.
- **"Needle in a haystack" eval:** the standard probe for position sensitivity — plant a fact at varying positions and measure recall (the basis of the exercise below).

---

## Tradeoffs

### Recency placement vs. retrieval + reranking

| Dimension | This codebase (recency placement) | Retrieval + reranking |
|---|---|---|
| Infrastructure | None — string concat + array push | Embedding store + reranker model/API |
| What it controls | *Where* content sits | *What* is in context and *where* |
| Effectiveness on a short context | Adequate — shallow sag | Overkill |
| Effectiveness on a long mixed context | Weak — middle still full | Strong — irrelevant content removed |
| Measurement | None | Reranker scores are inspectable |
| Cost per call | Zero | Embedding + rerank latency and spend |

**What we gave up.** Any control over *what* sits in the middle of the context. Recency placement reorders the conversation but cannot remove an irrelevant tool result from the transcript — once a tool was called, its result is in the window. With five of six results in the sag on a long run, the model may underweight evidence it actually needs, and nothing in the codebase detects when that happens.

**What the alternative would have cost.** A reranker adds an embedding/scoring step between gathering results and feeding them back (a new call per batch at L171), plus the infrastructure of an embedding store if retrieval feeds it. For contexts already bounded to ~96,000 characters of tool results, the sag is shallow enough that the reranker's cost would buy little — which is exactly why the codebase deferred it.

**The breakpoint.** Recency placement is sufficient while contexts are short and evidence is uniformly relevant. It breaks when a single run accumulates many mixed-relevance results — say a query agent that calls a dozen tools and most return noise. There the middle is both long and full of distractors, placement cannot rescue the buried signal, and the system needs retrieval to drop the noise plus reranking to order the rest. That event — long contexts with low signal-to-noise — is the trigger to build the retrieval/rerank path.

**Not actually a tradeoff:** appending the `synthesisInstruction` last. Placing the must-obey directive at the strong end costs nothing and would survive any future retrieval design unchanged.

---

## Tech reference (industry pairing)

### context ordering / recency placement

- **Codebase uses:** plain placement — `synthesisInstruction` concatenated to the end of the system prompt (`lib/agents/base.ts` L98) and tool results pushed as the most-recent turn (L171). No library.
- **Why it's here:** it is the free lever against the U-curve when you cannot remove content; the contexts are short enough that placement alone is adequate.
- **Leading today:** prompt-construction practice (system-prompt structuring, putting instructions at the end of the user turn) leads adoption (2026); it is convention, not a package.
- **Why it leads:** it costs nothing and reliably moves the must-obey content out of the sag.
- **Runner-up:** explicit section delimiters / XML-style tags that signal structure so the model can locate sections regardless of position.

### reranking (the real fix, absent here)

- **Codebase uses:** nothing — there is no reranker; placement is the only mitigation.
- **Why it's here (absent):** blooming insights has no retrieval to rerank; contexts are short enough that the sag has not justified the infrastructure.
- **Leading today:** Cohere Rerank and cross-encoder rerankers (BGE-reranker, `mxbai-rerank`) lead adoption (2026) for ordering retrieved passages by relevance.
- **Why it leads:** a cross-encoder scores query-document relevance directly, so the top hits can be placed at the high-attention ends and the rest dropped — curing the middle problem at the source.
- **Runner-up:** RRF (reciprocal rank fusion) over hybrid retrieval — cheaper, no model, fuses ranked lists. Covered in → ../03-retrieval-and-rag/07-reranking.md.

---

## Project exercises

### Measure the synthesis call's position sensitivity

- **Exercise ID:** C1.2 (adapted) — position sensitivity probe for the synthesis call.
- **What to build:** a test harness that runs `DiagnosticAgent.synthesize()` (or the forced-final turn) with the evidence ordered three ways — most-relevant-first, most-relevant-last, and most-relevant-in-the-middle — over a fixed anomaly + tool-call fixture, and compares the resulting diagnoses for whether the buried evidence still surfaces in the conclusion.
- **Why it earns its place:** turns the recency placement from a reasoned bet into a measured one and shows you can probe lost-in-the-middle empirically rather than asserting it.
- **Files to touch:** `lib/agents/diagnostic.ts` (expose evidence ordering in `synthesize()` for the test), new `test/agents/position-sensitivity.test.ts`.
- **Done when:** the harness reports, for the same evidence, whether middle-placed evidence is cited in the conclusion less often than edge-placed evidence over repeated runs.
- **Estimated effort:** 1–4hr

### Add a relevance reorder before tool results are fed back

- **Exercise ID:** B2A.11 (adapted) — reranking the tool-result batch.
- **What to build:** add a `lib/mcp/rerank.ts` that scores each tool result in a batch against the anomaly/diagnosis (start with a cheap heuristic — keyword overlap with the metric/scope — before any model), and reorder the batch in `runAgentLoop` so the most relevant results sit at the head and tail before they are pushed at `lib/agents/base.ts` L171.
- **Why it earns its place:** demonstrates you understand the U-curve and the difference between placement and curation, and lays the seam where a real reranker would later drop in.
- **Files to touch:** `lib/agents/base.ts` (`runAgentLoop`, reorder before L171), new `lib/mcp/rerank.ts`, `test/agents/base.test.ts`.
- **Done when:** the batch fed back at L171 is verifiably reordered by relevance score, with the lowest-relevance results placed in the middle by design.
- **Estimated effort:** 1–4hr

---

## Summary

Models attend most reliably to the start and end of a context and least reliably to the middle — a reproducible U-shaped bias (Liu et al. 2023). blooming insights has no retrieval to reorder, so its mitigation is purely positional: the `synthesisInstruction` is appended LAST to the system prompt on the final turn (`lib/agents/base.ts` L98) so the must-obey directive sits at the strong end, and tool results are pushed as the MOST RECENT user turn (L171) so the freshest evidence is at the recency edge. The `synthesize()` fallback collapses the context to nothing, removing the middle entirely. This is a thin surface — the substantive fix is retrieval plus reranking (Case B, → ../03-retrieval-and-rag/07-reranking.md), which this codebase has deliberately not built because its contexts are short.

**Key points:**
- Attention is U-shaped over position; the middle is a dead zone for recall.
- Placement is a correctness lever, not formatting — the same fact is recalled at the end and lost in the middle.
- blooming insights uses recency: directive appended last (base.ts L98), results as the most-recent turn (L171).
- `synthesize()` collapses the context so there is no middle to lose anything in.
- The real fix — retrieval + reranking — is absent; recency placement is a thin mitigation that holds only while contexts are short.

---

## Interview defense

### What an interviewer is really asking

"How do you handle lost-in-the-middle?" tests whether you know position affects recall, whether you distinguish placement (reorder what's there) from curation (remove what shouldn't be there), and whether you are honest about which one your system actually does. The senior signal is naming the U-curve, pointing to the *specific* recency placements, and admitting that placement is the thin lever while retrieval+reranking is the real fix.

### Likely questions

**[mid] What is lost-in-the-middle, and where does this codebase place its most important content?**

Models recall content at the start and end of a context far better than the middle (Liu et al. 2023). The codebase places its must-obey directive last in the system prompt (`lib/agents/base.ts` L98) and the freshest evidence as the most-recent turn (L171), both at the strong ends.

```
[ system… │ synthesisInstruction ]   [ … │ latest tool_result ]
  front       ▲END (strong)            middle    ▲END (strong)
```

**[senior] Why is the dedicated `synthesize()` call more reliable than fixing the prompt inside the loop?**

Two reasons compound. The loop context is long — six tool-call pairs pile up in the middle, the sag. `synthesize()` (`lib/agents/diagnostic.ts` L87–L126) makes a fresh single-turn call with a short flat context: there is no middle for evidence to get lost in, and the directive sits at the end of a compact message. Collapsing the context is the most direct lost-in-the-middle fix available without retrieval.

```
long loop context: evidence in the sag → underweighted
short synthesize() context: no sag → directive + evidence both at edges
```

**[arch] You have no reranker. When does recency placement stop being enough?**

When a run accumulates many mixed-relevance results — a query agent calling a dozen tools where most return noise. Then the middle is both long and full of distractors; placement can pull one item to an edge but not all the signal out of the sag, and the irrelevant results are still occupying the window. That is where retrieval (drop the noise) plus reranking (order the rest so top hits hit the edges) becomes necessary — the Case B path in → ../03-retrieval-and-rag/07-reranking.md.

```
short, all-relevant context  → placement enough
long, low-signal context     → need retrieval + rerank (absent)
```

### The question candidates always dodge

**"Have you measured that reordering actually changes the answer?"** The honest answer here is no — there is no position-sensitivity probe; the recency placement is a reasoned bet grounded in the literature, not a result verified against this codebase. A candidate who claims a measured improvement is bluffing; the strong answer points at the absence and names the probe (the exercise above).

### One-line anchors

- `lib/agents/base.ts` L98 — `synthesisInstruction` appended last to the system prompt (strong-end placement).
- `lib/agents/base.ts` L171 — tool results pushed as the most-recent turn (recency edge).
- `lib/agents/diagnostic.ts` L87–L126 — `synthesize()` collapses the context so there is no middle.
- Attention is U-shaped; placement reorders, retrieval+reranking curates — only the second cures the middle.
- The real fix (reranking) is absent — → ../03-retrieval-and-rag/07-reranking.md.

---

## Validate

### Level 1 — Reconstruct

From memory, sketch the U-shaped attention curve over context position and mark where the codebase places: (a) the `synthesisInstruction`, (b) the latest tool results, (c) the accumulated middle turns. State which two are at strong positions by construction and which one sits in the sag.

### Level 2 — Explain

Out loud: explain the difference between placement (what this codebase does) and curation (retrieval + reranking, what it does not). Why does `synthesize()`'s short flat context sidestep the middle problem that the loop's long context cannot?

### Level 3 — Apply

Scenario: a query agent calls eight tools and six of them return data irrelevant to the user's question. Check `lib/agents/base.ts` L171 — what position do the irrelevant results occupy in the transcript, and why does appending each batch fail to keep the *relevant* two at the edges? Then name the file that would not exist yet but would house the reorder step (cross-reference → ../03-retrieval-and-rag/07-reranking.md).

### Level 4 — Defend

A reviewer says: "Recency placement is enough — we don't need a reranker." Defend or refute using this codebase: for the bounded ~96,000-char diagnostic context with six uniformly-relevant results, is the reviewer right? For a hypothetical twelve-tool query context with low signal-to-noise, is the reviewer right? Name the event that flips the answer and the file (`lib/mcp/rerank.ts`, not yet present) where the fix would live.

### Quick check — code reference test

On the forced-final turn, where in the system prompt does the must-obey directive sit, and which line places it there? (Answer: at the *end* — `lib/agents/base.ts` L98 concatenates `synthesisInstruction` after the base `system` prompt.)

---
Updated: 2026-05-28 — Re-derived the drifted `synthesize()` ranges (diagnostic L87–L126, recommendation L82–L132, compact message L105–L113) and per-agent `synthesisInstruction` text refs (diagnostic L63–L67, monitoring L85–L89); the recency-placement `base.ts` refs (L95–L98, L171) verified unchanged.
