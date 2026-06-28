# 02 — lost in the middle

**Subtitle:** Attention bias toward start/end of context · Industry standard (partial in this codebase)

## Zoom out, then zoom in

Empirical pattern across all LLMs: the model pays more attention to the start
and end of a long context than to the middle. Bury something important in
the middle of a 20-doc retrieval and the model may miss it; put the same
thing at position 1 or 20 and the model finds it.

```
  Zoom out — where this matters in blooming insights

  ┌─ Long prompts in this codebase ──────────────────────────┐
  │  - monitoring system prompt + checklist of 10 categories │  ← we are here
  │  - diagnostic prompt + 6-turn history with tool results  │
  │  - recommendation prompt + diagnosis JSON                │
  │  (no RAG — no big lists of retrieved docs)               │
  └──────────────────────────────────────────────────────────┘
```

The codebase doesn't stuff long lists of retrieved chunks into context (no
RAG; see `03-retrieval-and-rag/`). But the *category checklist* the
monitoring agent gets IS a list — 10 categories — and ordering matters.

## Structure pass

  → **One axis to trace — attention.** Where in the prompt does each piece
    of information live? For the monitoring agent: system at the top,
    schema in the middle, category checklist toward the end, hard rules
    interspersed. The category checklist sits *late* in the prompt —
    which is actually good for attention. The schema sits in the middle —
    which is the weak position.

  → **The seam (which doesn't exist yet):** ordering control. The prompts
    are markdown files (`lib/agents/legacy-prompts/monitoring.md`) loaded
    and template-substituted; there's no ordering knob that says "put X at
    position N." Reordering means editing the markdown.

## How it works

### Move 1 — the mental model

Imagine you're proofreading a long doc: you read the first paragraph
carefully, you read the last paragraph carefully, and the middle paragraphs
get a quick skim. The model behaves similarly. Position in the prompt
correlates with attention.

```
  Attention by position (cartoon — actual curve varies by model)

  attention
  ▲
  │ ██                                                  ██
  │ ██ █                                              █ ██
  │ ██ ██                                            ██ ██
  │ ██ ███                                          ███ ██
  │ ██ ████        ────────────  weakest  ────────  ████ ██
  │ ██ █████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░██████ ██
  │                                                          │
  └──────────────────────────────────────────────────────────►  position
  start                       middle                        end
```

### Move 2 — the step-by-step walkthrough

**Where this codebase puts things in the prompt.** Look at the monitoring
prompt structure (`lib/agents/legacy-prompts/monitoring.md`, top of file):

```
  POSITION                                 WEIGHT
  ────────                                 ──────
  1. Role description                     HIGH (start)
  2. "You run a FIXED CHECKLIST of …"     HIGH-ish
  3. {categories} interpolation            MIDDLE-ish — the 10 categories
  4. Hard rules (numbered list)            MIDDLE-LATE
  5. Period-over-period method             MIDDLE
  6. CRITICAL: verify windows              LATE (attention bias bonus)
  7. Suggested query plan                  LATE
  8. Tool catalog reminders                LATE
  9. Common errors to avoid                LATE
  10. Output format spec                   END (highest attention)
```

The prompt author understood the bias. The "**CRITICAL: verify your windows
actually contain data**" section is positioned LATE, where attention is
high. The output format spec — the part the model has to follow precisely —
is at the very END.

**Where the bias bites in this codebase.** The `{categories}` interpolation
sits at position 3 — in the middle. Each category has an id, label,
requires, recipe, threshold, plus a `whyItMatters` blurb. That's 10
multi-line entries; the longest take 5-10 lines each. The model's
attention to category 5 (in the middle of a 10-list) is measurably less
than to category 1 or category 10.

Concretely: if the monitoring agent more often skips testing for `fraud`
(usually listed near the middle) than for `revenue_drop` (near the start)
or `customer_churn` (near the end), this attention bias is part of why.
There's no audit data in repo today to confirm this — would be a useful
eval (see `05-evals-and-observability/01-eval-set-types.md`).

**The mitigation Blooming uses implicitly.** Two patterns:

  1. **Severity sort at output.** The prompt requires anomalies sorted
     `critical → warning → info → positive`. Even if attention biases the
     *detection* order, the *reporting* order is deterministic.

  2. **Hard rules listed early AND repeated.** "Pass `project_id` to every
     tool call" appears at position 4 AND is also part of the tool
     definitions the model sees. Critical instructions get redundancy.

**Where it'd bite if RAG landed.** If you added a RAG step that retrieved 20
relevant docs and stuffed them in the prompt, the doc at position 10 would
get less attention than positions 1, 2, 19, 20. The mitigation pattern
there is reranking: get the top 20 from a fast retriever, score them with a
cross-encoder, put the top 3 at position 1 and the next 3 at the end. See
`03-retrieval-and-rag/07-reranking.md` for the full pattern.

### Move 3 — the principle

**Position matters. Treat the prompt as a layered structure with strong
positions and weak positions, not a flat document.** When you have to put
something in the middle, make it short and self-contained — and consider
restating the critical bits at the end. When the order is configurable
(retrieved docs, list of options), put the most important first and last.

## Primary diagram

```
  Monitoring prompt structure — what sits where

  ┌─ START (high attention) ─────────────────────────────┐
  │  role description                                    │
  │  "you run a fixed checklist…"                        │
  ├──────────────────────────────────────────────────────┤
  │  ┌─ MIDDLE (lower attention) ─────────────────────┐  │
  │  │  {categories} — 10 categories interpolated     │  │
  │  │  hard rules (numbered 1-4)                     │  │
  │  │  period-over-period method explanation         │  │
  │  └────────────────────────────────────────────────┘  │
  ├──────────────────────────────────────────────────────┤
  │  CRITICAL: verify windows ← restated for attention   │
  │  suggested query plan (5 calls)                      │
  │  tool catalog reminders (EQL syntax)                 │
  │  common errors to avoid                              │
  ├──────────────────────────────────────────────────────┤
  │  OUTPUT format spec  ← always at the end             │
  └──────────────────────────────────────────────────────┘
                                       ↑ high attention again

  Future RAG: top-3 retrieved at position 1, next-3 at end,
  middle docs become "padding"
```

## Elaborate

The "lost in the middle" finding traces to a 2023 paper by Liu et al.
(*"Lost in the Middle: How Language Models Use Long Contexts"*). It tested
several models on document QA where the answer-bearing doc was placed at
varying positions across a 20-doc context; accuracy was U-shaped with
position. The finding has held up across newer models, including Claude
generations.

Practical implications differ by application:

  → **Q&A over retrieved docs (RAG):** big deal. Reranking + putting the
    top results at the edges of the context is the canonical fix.

  → **Long conversations:** medium deal. Recent turns are at the end (good);
    old turns get pushed toward the middle (bad). Summarization of old
    turns is the fix.

  → **Structured prompts with mixed content:** small but real deal. Put
    the load-bearing instructions at the start and end; let definitions
    and recipes ride the middle.

blooming insights is the third case. The prompts are well-structured
already (output spec at the end, critical rules late). The category
checklist in the middle is the one place a small reordering audit would
help.

## Project exercises

### Exercise — reorder the monitoring prompt to put high-priority categories first

  → **Exercise ID:** `study-ai-eng-02-02.1`
  → **What to build:** In `lib/agents/categories.ts`, add a `priority`
    field to `AnomalyCategory` (e.g. 'high' | 'medium' | 'low'). When
    `runnableCategories` returns the list, sort by priority descending.
    Verify the prompt template renders them in that order. Then add a
    test that captures the prompt sent to the model and asserts category
    ordering.
  → **Why it earns its place:** Demonstrates "I'm aware of attention bias
    and I order prompts accordingly." Tiny change, real signal in
    interview.
  → **Files to touch:** `lib/agents/categories.ts` (priority field +
    sort), AptKit `ECOMMERCE_ANOMALY_CATEGORIES` if priority lives
    upstream, `test/agents/monitoring.test.ts` (assert order).
  → **Done when:** Categories appear in the prompt in priority order
    (highest first); test passes.
  → **Estimated effort:** `1–4hr`

## Interview defense

**Q: Are you aware of "lost in the middle" and where does it bite this
codebase?**

Yes — the empirical finding that LLM attention is U-shaped over context
position. In this codebase the place it could bite is the `{categories}`
interpolation in the monitoring prompt — a 10-category checklist that
sits mid-prompt. The mitigation today is implicit: hard rules are
restated near the end ("CRITICAL: verify your windows"), and the output
spec is always at the very end where attention is highest.

```
  Strong positions: start, end
  Weak position:    middle

  Mitigation in this codebase:
    - critical instructions restated late
    - output format ALWAYS at end
    - severity sort enforced at output (compensates for middle-bias
      during detection)
```

**Anchor line:** "The prompts are well-structured for it already. The
category-priority sort is the one tactical move I'd make."

**Q: When would lost-in-the-middle become a serious problem here?**

When RAG lands. Right now nothing in the prompt is a long list of retrieved
chunks. If you added "retrieve top-20 relevant docs and stuff in context,"
docs 8-12 would get under-attended. The fix is reranking + edge placement
— top 3 at position 1, next 3 at the end, middle ones become padding.

**Anchor line:** "No RAG yet, so no doc-list to bury. The reranking pattern
is the canonical fix when it does land."

## See also

  → `01-context-window.md` — the budget the long-list sits inside
  → `03-retrieval-and-rag/07-reranking.md` — the canonical fix for RAG-shaped lost-in-the-middle
