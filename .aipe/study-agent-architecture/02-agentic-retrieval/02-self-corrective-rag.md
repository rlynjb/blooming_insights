# Self-corrective RAG

**Industry name(s):** Self-corrective RAG, CRAG (Corrective RAG), Self-RAG, relevance grading, retrieval validity gate
**Type:** Industry standard · Language-agnostic

> A grader sits between *retrieve* and *generate* and asks "is this chunk actually relevant and the answer actually grounded in it?" — if not, fall back (rewrite, widen, escalate). blooming insights has no such grader on the agentic-RAG loop; the closest adjacent checks are the monitoring agent's volume-check prompt and the diagnostic agent's hypothesis-testing structure, both of which validate the *premise* of retrieval rather than the *relevance* of a retrieved chunk.

**See also:** → 01-agentic-rag.md · → 03-retrieval-routing.md · → `../01-reasoning-patterns/04-reflexion-self-critique.md` · → `../../study-ai-engineering/03-retrieval-and-rag/11-rag.md`

---

## Why care

You wrote a search box that returns ten rows. The first row matches the query — title hit, snippet looks right — so you render it. But your code never asked "is the matching row *useful*?" A title can match a query and the row's actual content can be off-topic. The first nearest-neighbor is whatever was closest in the index, not whatever was relevant to the question. The two are not the same thing.

Now picture a model reading those ten rows and answering the user's question from them. The model will use whatever's in the window — including off-topic chunks that happened to embed close. The answer comes out fluent, the citations look real, and the chunk it cited *was* retrieved. None of that proves the chunk was *relevant*, and none of it proves the answer is *grounded* in it.

That's the question this file answers: **how do you tell whether retrieval actually returned the right context, before the model uses it to answer?** Not "did anything come back" — something always comes back. The line is between *retrieval success* (the index returned chunks) and *answer success* (the chunks were relevant and the answer is grounded in them). They are different success criteria.

**Why answering that question matters:** because retrieval can succeed by every infrastructure metric (the index responded, the top-k came back, no errors) and still hand the model garbage. Without a relevance check, "we retrieved" is silently equated with "we have the right answer," and the failure shows up downstream as a confidently wrong response with real-looking citations. The bug isn't in the index; it's in the absence of a gate between the index and the model.

Without a relevance gate:
- A user asks "why did checkout conversion drop?"
- The retriever returns five chunks; two are about a different funnel, one is from last quarter, two are loosely related
- The model answers fluently from what's in the window, citing the loosely related chunks
- The user trusts the answer; the answer is grounded in the wrong evidence

With a relevance gate:
- A user asks "why did checkout conversion drop?"
- The retriever returns five chunks; a grader scores each: relevant? grounded?
- The two off-topic chunks are dropped; the loosely related ones are flagged
- The model either answers from the relevant subset, or the fallback path runs (rewrite query, widen search, escalate to human)

One-line summary: **the grader is the gate that separates "retrieval ran" from "retrieval helped" — a relevance check between retrieve and generate, with a fallback for when the check fails.** Here's the shape of the pattern, and where blooming insights has it (it doesn't, on the retrieval path itself) and where it has something adjacent (yes — on the *premise* of retrieval).

---

## How it works

**The mental model: form validation between fetch and submit.** When you build a multi-step form, you don't post the data the moment the user clicks Next — you validate first. If the email looks malformed, you stop, surface the error, and the user fixes it. Self-corrective RAG is that, applied to retrieval: don't generate from the chunks the moment they come back; validate them, and if they fail, fall back to a different action instead of generating garbage.

```
The mental model

  Without the grader (most RAG):
      retrieve ──► generate
         │            │
         └─ "we got chunks"  └─ "we got an answer"
                              (the gap is invisible)

  With the grader (self-corrective RAG):
      retrieve ──► [ GRADER ] ──► generate
                       │
                     fail
                       ▼
                  rewrite / widen / escalate
                  (the gap is checked)
```

The strategy in plain English: **don't generate from unvalidated context.** Retrieval is a step that can fail silently, and the failure isn't "no chunks" — it's "wrong chunks that look right." A grader scores relevance and groundedness; a fallback path handles failure. Without the grader, the model generates from whatever the retriever happened to return, and the user has no way to tell.

### The grader's two jobs — relevance and groundedness

The technical thing: the grader answers two separate questions per retrieval. **Relevance**: does this chunk actually pertain to the query? **Groundedness**: does the answer the model would generate from this chunk actually follow from the chunk, or is it hallucinating? These are different failures and they get different mitigations.

If you're coming from frontend, this is the difference between "the API returned 200 OK with valid JSON" (relevance — you got a response shape) and "the JSON's fields match what the UI needs to render the screen" (groundedness — the response is *useful* for what comes next). Both checks have to pass before you render.

```
The two checks the grader runs per chunk

  ┌────────────────────────────┐
  │ Relevance                  │
  │ "does this chunk pertain   │
  │  to the user's question?"  │
  └────────┬───────────────────┘
           │ pass
           ▼
  ┌────────────────────────────┐
  │ Groundedness               │
  │ "does the draft answer     │
  │  actually follow from this │
  │  chunk's content?"         │
  └────────┬───────────────────┘
           │ pass
           ▼
       generate (use it)
```

The practical consequence: a relevance failure is "we retrieved off-topic material" — fix it by rewriting the query or widening the search. A groundedness failure is "the model would hallucinate from this chunk" — fix it by escalating, asking the model to abstain ("not enough evidence"), or routing to a human. They look similar from the outside (the answer is wrong) but they fail at different layers.

The condition under which it works: the grader has to itself be reliable. A model grading its own retrieval shares blind spots with the model that retrieved — covered next.

### The fallback path — what "fail" means in production

The technical thing: when the grader rejects a chunk, the system needs a defined next action. The three standard fallbacks: **rewrite the query** (the original query was wrong-shaped — try a different phrasing), **widen the search** (the original net was too tight — pull more chunks, lower the threshold), **escalate** (no retrieval will help — the answer is "I don't know" or "ask a human").

If you're coming from frontend, this is `useQuery`'s `onError` handler. The fetch failed; what does your UI do? Show an empty state? Retry with different params? Surface the error? Without an `onError`, the failure becomes a silent broken render. Without a fallback, a failed-grader RAG silently generates from nothing useful.

```
Fallback paths when the grader fails

  grader fail
       │
       ├─► rewrite: refine the query string, retrieve again
       ├─► widen:   lower threshold / increase k, retrieve again
       └─► escalate: abstain ("not enough evidence") OR hand off
                    to a different system / a human
```

The practical consequence: a fallback ladder bounds the cost of correction. Without it, "retry on grader failure" can mean infinite re-retrieval; with it, the loop has a defined escalation order and a cap (try rewrite once, then widen, then escalate).

The condition under which it works: each fallback step has to converge or terminate. A rewrite that keeps producing the same off-topic query is the same as no rewrite at all — the loop needs to either improve the query or give up.

### Self-critique's blind spot — why the grader can lie

The technical thing: when the same model that retrieved is also the model grading, the two share the same priors and the same failure modes. The grader can confidently approve a chunk for the same reason the retriever surfaced it. This is the self-preference bias from LLM-as-judge work, applied to retrieval.

If you're coming from frontend, this is "the developer who wrote the bug is the one reviewing the PR." The reviewer is looking at the same screen the developer was — if there was a blind spot, both miss it. Independent eyes catch what shared eyes don't.

```
The blind-spot trap

      ┌── retriever model ──┐
      │   surfaces chunk    │  same model family
      └─────────┬───────────┘
                ▼
      ┌── grader model ─────┐  ◄── shares the priors
      │   approves chunk    │      shares the blind spot
      └─────────────────────┘

  Mitigation: a DIFFERENT model family as the grader, or a
  rules-based check (citation matches source verbatim, dates
  fall in range), or both.
```

The practical consequence: a self-grader catches *format* failures and *obvious-error* failures well (the chunk is empty, the chunk is in the wrong language, the chunk's date is years off) and catches *subtle-reasoning* failures poorly (the chunk is about a different funnel but reads close enough). The mitigations are external checks: a different model family for the grader, or rule-based asserts (citation must appear verbatim in source, dates must be in range), or human spot-checks.

The condition under which the grader earns its overhead: the answer's stakes have to justify a second model call per retrieval. A 2-5x token tax is real; on low-stakes queries it's not worth it, on high-stakes ones (medical, legal, "ship this to a customer") it is.

### What blooming insights has instead — premise checks, not relevance checks

The technical thing: there's no relevance grader between `execute_analytics_eql` and the model's next reasoning step. The agentic-RAG loop (`runAgentLoop`, `base.ts` L48–L176) runs the EQL, feeds the JSON result back, and the model reasons on it — no per-chunk scoring sits in between. But two adjacent checks exist, and naming them honestly matters.

**Adjacent check 1: the monitoring agent's volume check.** The monitoring prompt (`lib/agents/prompts/monitoring.md` around L31, the `CRITICAL: verify your windows actually contain data` block) instructs the agent to spend its *first* query on a volume probe — `select count event purchase in last 90 days` — before running any anomaly recipes. If the count is empty or tiny, the agent shifts `execution_time` to a populated range or widens the window. This is a *premise* check: it validates that retrieval will be meaningful before doing it, not that a retrieved chunk is relevant to the question. Closest analog to a self-corrective gate, but at the wrong layer — it gates the *window*, not the *result*.

**Adjacent check 2: the diagnostic agent's hypothesis testing.** The diagnostic prompt (`lib/agents/prompts/diagnostic.md`) frames investigation as "generate 2–3 competing hypotheses, then query to falsify each." This is *answer-side validity* — the model is forced to check whether the evidence supports or rules out its candidate explanation, which is a groundedness check applied to its own reasoning, not to retrieved chunks.

```
What this codebase has vs the self-corrective RAG pattern

  Self-corrective RAG (the pattern):
    retrieve → grade chunk relevance + groundedness → fall back if fail

  blooming insights monitoring (adjacent — premise check):
    BEFORE retrieval: verify the window has data;
    if not, widen the window or shift the timestamp
                  └─ gates retrieval's PREMISE, not its RESULT

  blooming insights diagnostic (adjacent — groundedness on reasoning):
    generate competing hypotheses → query to falsify each →
    conclude with the best-supported hypothesis
                  └─ gates the ANSWER's grounding, not the RETRIEVAL's relevance
```

The practical consequence: this codebase doesn't catch the "we retrieved off-topic numbers" failure on the EQL retrieval path itself. If the model writes an EQL that returns aggregate numbers from a tangentially-related event, the loop has no gate that says "these aren't the right numbers" before the model uses them. The hypothesis-testing structure catches *some* of this downstream (a hypothesis that doesn't fit the data gets ruled out), but only when the wrongness shows up as inconsistency — not when the wrong numbers happen to be plausible.

The condition under which the absence is okay (right now): the retriever is structured. EQL queries return typed aggregates against named events; the retrieval failure mode is mostly "no data" (which the volume check catches) rather than "wrong topic" (which an unstructured retriever like vector search would be more prone to). The day the codebase adds a free-text retriever, the absence becomes a real gap.

### Phase A vs Phase B — where the grader would go if it were added

Right now no grader sits on the retrieval path. Naming where one *would* sit clarifies what the pattern costs and what it buys.

```
        Phase A (now)                Phase B (with grader)
┌─────────────────────────┐  ┌─────────────────────────────────┐
│ model picks EQL         │  │ model picks EQL                 │
│   ▼                     │  │   ▼                             │
│ execute_analytics_eql   │  │ execute_analytics_eql           │
│   ▼                     │  │   ▼                             │
│ result fed back         │  │ GRADER: result vs question      │ ←
│   ▼                     │  │   ├─ relevant?                  │
│ model reasons & loops   │  │   └─ does it falsify/support a  │
│   ▼                     │  │      hypothesis?                │
│ next turn               │  │   ▼                             │
│                         │  │ pass → feed back to model       │
│                         │  │ fail → rewrite EQL / widen      │
│                         │  │        window / abstain         │
└─────────────────────────┘  └─────────────────────────────────┘
   no gate; the model    │   one extra model call per retrieval
   reasons on whatever   │   catches off-topic + ungrounded
   comes back            │   adds 1× LLM tax per turn
```

*Phase A (now):* trust EQL's structured shape and the monitoring volume-check; treat retrieval results as ground truth and let the diagnostic agent's hypothesis testing catch downstream inconsistency. Cheap, simple, occasionally wrong.

*Phase B (with grader):* add a relevance/groundedness check on every `tool_result` before it's fed back to the model. Catches "wrong numbers from wrong query" earlier. Pays 1× extra model call per turn (so ~6 extra calls per investigation), bounded by the existing `maxToolCalls` budget.

The takeaway: **the grader is a checkpoint, not a topology change.** The agentic-RAG loop's shape (`reason → retrieve → observe → repeat`) doesn't change; one extra step (`grade`) sits between `retrieve` and `observe`, and the fallback path replaces the "observe → reason" arrow with a "observe → fallback → retrieve again" arrow when the grade fails. The day the answer's stakes go up — a feature ships to customers with no human review in the loop — that's the day the grader earns its cost.

This is what people mean when they say "retrieval success isn't answer success." The grader exists because the gap is real, and the alternative is silently confident wrong answers.

The full picture is below.

---

## Self-corrective RAG — diagram

```
The self-corrective RAG pattern (canonical, with where this codebase sits)

  user question
       │
       ▼
  ┌───────────────────────────────────────────────────────────────┐
  │ AGENT LOOP                                                    │
  │   model picks next retrieval                                  │
  │              ▼ tool_use                                       │
  │   ┌─────────────────────────────┐                             │
  │   │ retriever (EQL / vector /   │                             │
  │   │ SQL / web / live API)        │                             │
  │   └─────────────┬───────────────┘                             │
  │                 ▼ chunks / rows / result                       │
  │   ┌─────────────────────────────┐                             │
  │   │ ★ GRADER                    │ ◄── NOT IN THIS CODEBASE    │
  │   │   relevance? groundedness?  │     on the retrieval path    │
  │   └────┬───────────────┬────────┘                             │
  │        ▼ pass          ▼ fail                                  │
  │   feed back        fallback:                                  │
  │   to model          ├─ rewrite query                          │
  │        │            ├─ widen search                           │
  │        │            └─ escalate / abstain                     │
  │        ▼                 │                                     │
  │   model reasons          └──► back to retrieve                │
  │        │                                                       │
  │        ▼                                                       │
  │   generate answer                                              │
  └───────────────────────────────────────────────────────────────┘

  WHAT THIS CODEBASE HAS INSTEAD (adjacent checks):
    1. Pre-retrieval premise check: monitoring volume-check
       (`prompts/monitoring.md` ~L31 CRITICAL block)
       → validates the window has data BEFORE running recipes
    2. Post-reasoning groundedness check: diagnostic hypothesis testing
       (`prompts/diagnostic.md` hypothesis-falsification structure)
       → validates the ANSWER against evidence, not the retrieval
       against the question

  THE GAP: no per-tool_result relevance grader between EQL and
  the model's next turn. "We retrieved" is silently equated with
  "we have the right numbers" on the retrieval path itself.
```

---

## In this codebase

**Case B — the relevance grader is not implemented on the retrieval path.** The honest sentence: there is no model-graded relevance check between `execute_analytics_eql` results and the next agent turn — the loop in `runAgentLoop` (`lib/agents/base.ts` L161–L171) wraps the tool result and feeds it back unmodified.

What exists adjacent to the pattern:

**Adjacent check 1 — pre-retrieval premise check**
**File:** `lib/agents/prompts/monitoring.md`
**Function / class:** the `## CRITICAL: verify your windows actually contain data` prompt block
**Line range:** ~L31 (the CRITICAL block)

This validates retrieval's *premise* (the window has data) before running anomaly recipes. It's a checklist instruction to the model, not code, but it gates whether retrieval is meaningful in the first place. Closest thing in the codebase to a self-corrective gate; on the wrong side of the retrieve step to count as one.

**Adjacent check 2 — answer-side groundedness via hypothesis testing**
**File:** `lib/agents/prompts/diagnostic.md`
**Function / class:** the "generate 2–3 competing hypotheses, then query to falsify each" instruction
**Line range:** L5 (job description) and L21–L25 (hypothesis-falsification method)

This is groundedness applied to the *answer*: the model is forced to state hypotheses, then run queries to support or rule them out. A hypothesis the data doesn't support is dropped. It's a groundedness check applied to reasoning rather than to retrieved chunks.

**Where the grader would go**
**File:** `lib/agents/base.ts`
**Function / class:** `runAgentLoop()` — between L150 (tool result received) and L171 (result fed back as next user turn)
**Line range:** L143–L171 (the result-handling block)

If a grader were added, it would slot in between collecting the `result` (L144–L150) and pushing the `toolResults` back as the next message (L171). The fallback path would either re-emit a tool_use with a rewritten query or surface an "insufficient evidence" notice the agent uses to abstain.

```
shape (not full impl) — what a self-corrective gate would look like here:
  const { result } = await mcp.callTool(tu.name, tu.input);
  // ── NEW: grade result for relevance + groundedness vs user question ──
  const grade = await grader.score({ question: userPrompt, result });
  if (grade.relevant && grade.groundedFor(currentHypothesis)) {
    toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: ... });
  } else {
    // fallback: re-emit a tool_use with a rewritten EQL, or surface "no evidence"
    toolResults.push({ type: 'tool_result', tool_use_id: tu.id,
                       content: `result rejected: ${grade.reason}; retry with widened window` });
  }
```

---

## Elaborate

### Where this pattern comes from

The self-corrective RAG idea crystallized around two papers in 2023–2024. **Self-RAG** (Asai et al., 2023) added per-step reflection tokens that let the model decide whether to retrieve, whether the retrieved context is relevant, and whether the answer is grounded — three checkpoints rolled into the generation loop. **CRAG** (Corrective RAG, 2024) externalized the grader into a separate model that scores retrieved chunks and triggers a fallback (re-write, web search, decompose) when the score is low. Both papers named the same gap: retrieval success silently masquerading as answer success.

### The deeper principle

There are two success criteria in any retrieval-augmented system, and they're easy to conflate. *Retrieval ran successfully* — the index returned chunks, no errors, latency was fine. *Retrieval was helpful* — the chunks were relevant to the question and the answer is grounded in them. The first is infrastructure success; the second is task success. The grader exists because the two diverge silently, and "did anything come back" is the easiest possible bar to clear.

```
  did retrieval RUN?    │ infrastructure metric — easy to monitor
  did retrieval HELP?   │ task metric — needs a grader to measure
  the gap               │ the failure mode self-corrective RAG closes
```

### Where this breaks down

The grader can lie. A self-grader (same model family) shares blind spots with the retriever; mitigation is a different model family or a rule-based check, both adding ops complexity. The grader can also be too strict, rejecting marginal-but-useful chunks and triggering infinite fallback loops on hard questions; mitigation is a fallback budget (try rewrite once, then widen, then escalate to abstain). And the grader adds a real cost — 1 extra model call per retrieval — which on a high-volume system can double inference spend without a measured quality win.

### What to explore next
- Agentic RAG (`01-agentic-rag.md`) → the loop the grader would slot into
- Reflexion / self-critique (`../01-reasoning-patterns/04-reflexion-self-critique.md`) → the grader-as-critic pattern at the *answer* layer, not the retrieval layer
- Retrieval routing (`03-retrieval-routing.md`) → grader-driven routing between multiple retrievers when one fails
- LLM-as-judge bias: `../../study-ai-engineering/05-evals-and-observability/` files on judge calibration

---

## Tradeoffs

The decision was *whether to gate retrieval with a relevance check before generating from it.* This codebase did not add the gate (Phase A); the alternative is the textbook self-corrective form (Phase B).

┌──────────────────┬─────────────────────────────┬─────────────────────────────┐
│ Cost dimension   │ No grader (chosen — now)    │ Grader added (alternative)  │
├──────────────────┼─────────────────────────────┼─────────────────────────────┤
│ Per-turn cost    │ 1× model call (reason)      │ 2× model calls (reason +    │
│                  │                             │ grade)                      │
│ Per-investigation│ ~6 model calls + 6 EQL      │ ~12 model calls + 6 EQL     │
│ Latency          │ ~1× LLM RTT per turn        │ ~2× LLM RTT per turn        │
│ Failure mode     │ off-topic retrieval reaches │ off-topic retrieval is      │
│ caught           │ the answer (caught only by  │ caught at the retrieval     │
│                  │ downstream hypothesis test) │ step                         │
│ Failure mode     │ wrong-window retrieval      │ wrong-window retrieval is   │
│ caught (premise) │ caught by monitoring        │ caught by monitoring        │
│                  │ volume-check prompt         │ volume-check (same)         │
│ Debuggability    │ a wrong answer needs        │ a wrong answer might come   │
│                  │ trajectory replay to find   │ from grader bias, not just  │
│                  │ where retrieval went off    │ retrieval                   │
│ Ops burden       │ none beyond the loop        │ grader model choice + bias  │
│                  │                             │ calibration                 │
│ Self-grader risk │ N/A                         │ same-family bias; needs a   │
│                  │                             │ different model or rules    │
│ Loop complexity  │ retrieve → observe → next   │ retrieve → grade → fallback │
│                  │                             │ ladder → observe → next     │
└──────────────────┴─────────────────────────────┴─────────────────────────────┘

### What we gave up

We gave up early detection of off-topic retrieval. A diagnostic agent whose model emits an EQL that returns aggregates from the wrong event (e.g., a different funnel) will reason on those numbers as if they were the right ones, until the *downstream* hypothesis-testing step notices the inconsistency — if it notices at all. The cost is occasional confidently-wrong diagnoses no in-loop check catches.

We also gave up the explicit fallback ladder. Without a grader-driven fallback, the loop has no "rewrite this query" branch. If the model retrieved badly on turn 1, it has to notice on turn 2 by reasoning ("hm, this doesn't look right") rather than via a structural signal. Some models do this well; not all do, and trusting the model to notice its own bad retrieval is exactly the blind spot self-corrective RAG was named to address.

### What the alternative would have cost

If we had built a relevance grader, every turn would cost 2× model calls (reason + grade) instead of 1×. Across a 6-tool-call diagnostic, that's ~6 extra Claude calls per investigation — at current pricing, a noticeable per-run hike, and the latency would push closer to (but probably not over) the 300s route budget. We would also have had to pick the grader's model family and calibrate its bias against the retriever's model — non-trivial ops work for a quality win we have not measured.

### The breakpoint

This stays the right call until two things converge: (a) the codebase ships a feature where retrieval can plausibly return *off-topic* results (a vector index over free-text narratives, a web search tool — anything where chunk relevance is fuzzier than typed EQL aggregates), AND (b) the feature's answers go to users without a human review step. Today, EQL's typed structure keeps retrieval mostly on-topic and the investigation flow has implicit human review (the user reads the diagnosis before acting on it). Either of those changing flips this from "fine to skip" to "needed."

### What wasn't actually a tradeoff

"Just trust the model to validate retrieval itself in the same reasoning step" was not a real alternative. That's exactly the conflation self-corrective RAG was named to prevent. A model reading its own retrieved context will confabulate around it; mixing "evaluate the retrieval" and "reason from the retrieval" into one step is the same as not evaluating, because the same priors that surfaced the chunk approve the chunk. The split into two model calls is the whole point — if you collapse them you've removed the gate while keeping its overhead in disguise.

---

## Tech reference

### LLM-as-judge (the grader pattern)

- **Codebase uses:** not implemented for retrieval grading; conceptually adjacent in the diagnostic agent's hypothesis-test prompt (`lib/agents/prompts/diagnostic.md` L21–L25), which uses the model to score whether evidence supports a candidate hypothesis — judge-shaped but applied to reasoning, not to retrieval.
- **Why it's here:** the grader IS an LLM-as-judge instance, scoring "is this chunk relevant to that question" the same way LLM-as-judge scores "is this answer good for that question."
- **Leading today:** OpenAI / Anthropic structured-output graders — adoption-leading for production judge calls, 2026.
- **Why it leads:** structured outputs make the grader's score machine-readable, and the same providers' models can act as graders without a separate stack.
- **Runner-up:** a fine-tuned smaller judge model (open-source) — cheaper per call, narrower in scope, more ops burden.

### Bloomreach EQL (the structured retriever)

- **Codebase uses:** the EQL strings the agents emit and `execute_analytics_eql` runs against Bloomreach (`lib/mcp/tools.ts`).
- **Why it's here:** EQL's typed shape (events, aggregates, windows) is what makes the absence of a relevance grader survivable today — retrieval is structurally constrained to return what the query asked for.
- **Leading today:** EQL — domain-specific; not a general retrieval pattern.
- **Why it leads:** typed aggregates against named events keep retrieval results structurally on-topic by construction — an EQL that runs returns numbers about the event it named.
- **Runner-up:** raw event export + SQL — same structural guarantee, more ops.

### Self-RAG / CRAG (the named patterns)

- **Codebase uses:** neither implemented; cited as the textbook shape this file teaches.
- **Why it's here:** they're the two industry-standard names for "a grader between retrieve and generate."
- **Leading today:** Self-RAG-style inline reflection tokens — adoption-leading inside specialized retrieval frameworks, 2026.
- **Why it leads:** keeps the grader inside the same model call (no second LLM RTT), which is cheaper than the external-judge form.
- **Runner-up:** CRAG-style external grader — slower per call but cleaner failure surface (the grader is observable, replayable, and replaceable).

---

## Summary

Self-corrective RAG inserts a relevance/groundedness grader between retrieve and generate, plus a fallback path (rewrite, widen, escalate) for when the grader rejects a chunk. blooming insights does not implement this on its agentic-RAG retrieval path — `runAgentLoop` (`lib/agents/base.ts` L48–L176) feeds tool results back to the model unmodified. Two adjacent checks exist: the monitoring agent's volume-check prompt (`prompts/monitoring.md` ~L31) gates retrieval's *premise* (the window has data), and the diagnostic agent's hypothesis-testing structure (`prompts/diagnostic.md` L21–L25) gates the *answer's* groundedness. Neither closes the gap a relevance grader would. The reason it works today is that EQL's typed structure keeps retrieval mostly on-topic by construction; the day the codebase adds a fuzzier retriever (vector search over narratives), the gap becomes a real failure mode.

- The grader's job is two checks: relevance (does this chunk fit the question?) and groundedness (does the answer follow from this chunk?).
- "Retrieval succeeded" ≠ "answer is right" — the grader exists because the gap is real and silent without it.
- The fallback ladder is rewrite → widen → escalate, each with a cap to bound correction cost.
- This codebase has adjacent gates (premise check before retrieval, hypothesis test on the answer) but no relevance gate on the retrieval result itself.
- The breakpoint is a fuzzier retriever + answers going to users without review; both have to flip before the grader earns its 2× per-turn cost.

---

## Interview defense

### What an interviewer is really asking
When an interviewer asks "how do you know your RAG is returning relevant results," they're testing whether you can distinguish "the retriever ran" from "the answer is right." The strong signal is naming the gap and saying where (and why) you do or don't check it. The weak signal is reciting "we use RAG" and assuming relevance is implied.

### Likely questions

[mid] Q: Does this system check whether retrieval was relevant before generating?

A: Not on the retrieval path itself. The agent loop runs the EQL and feeds the result straight back to the model with no per-result relevance grader in between. Two adjacent checks exist: the monitoring prompt forces a *premise check* — the agent's first query confirms the data window isn't empty before running anomaly recipes; and the diagnostic prompt forces a *groundedness check on the answer* — the agent generates 2–3 competing hypotheses and queries to falsify each, so the answer has to be supported by the data it cites. Neither is a relevance gate on a retrieved chunk, but they catch the failure modes that matter most for this data shape.

Diagram:
```
  pre-retrieval premise  ──► monitoring volume-check (prompt)
  retrieve → observe      ──► NO grader (the gap)
  post-reasoning ground   ──► diagnostic hypothesis test (prompt)
```

[senior] Q: Why no relevance grader between retrieve and generate?

A: Two reasons, and a breakpoint. First, the retriever is EQL — typed aggregates against named events — so retrieval results are structurally on-topic by construction. A query that runs returns numbers about the event it named; the failure mode isn't "wrong topic," it's "no data" or "wrong window," and the monitoring volume-check handles the latter. Second, a grader costs roughly 2× model calls per turn, which against the 60s-per-investigation budget and the 1.1s MCP spacing is a meaningful tax for a quality win I haven't measured. The breakpoint is a fuzzier retriever — a vector search over free-text past investigations, or a web search — AND answers going to users without review. Either alone is fine; both together flips the cost-benefit.

Diagram:
```
              Today                          When the gate earns its tax
   typed retriever (EQL)            +   fuzzy retriever (vector / web)
   structural relevance             +   no structural guarantee
   answers shown to operator        +   answers shipped to end-users
                                    └─► relevance grader earns its cost
```

[arch] Q: If you added the grader tomorrow, where exactly would it sit and what would break?

A: It slots in `runAgentLoop` between L150 (tool result received) and L171 (result fed back). Two extra layers: the grader call (1 extra model RTT per turn, so ~6 extra Claude calls per investigation), and a fallback path that either re-emits a rewritten tool_use or surfaces an "insufficient evidence" note the model uses to abstain. What breaks: the `maxToolCalls` cap has to grow to accommodate retry-after-rewrite, the per-investigation latency budget tightens — at ~2× turns each ~1.1s spaced, we get closer to the 300s `maxDuration`. Mitigation: cap the fallback ladder to one rewrite, then widen, then abstain; use a smaller/cheaper model as the grader to bound the cost.

Diagram:
```
  runAgentLoop today          runAgentLoop with grader
  ──────────────────          ────────────────────────────
  result ─► observe ─►        result ─► [GRADE] ─► observe ─►
  next turn                              │
                                       fail
                                         ▼
                                  rewrite / widen / abstain
                                  (capped fallback ladder)
```

### The question candidates always dodge
Q: You say the monitoring volume-check and the diagnostic hypothesis test "are adjacent." Aren't you just dressing up the absence of a grader?

A: Honest answer: yes, partially — and the distinction matters. The volume-check is genuinely a self-corrective pattern, but it sits *before* retrieval; it gates the premise (is this window worth querying) rather than the result (is what came back relevant). The hypothesis test is genuinely a groundedness check, but it sits at the *answer* layer; it gates the conclusion (does the data support this hypothesis) rather than the chunk (was this retrieval relevant to the question). Both are real validity checks; neither closes the specific gap self-corrective RAG names, which is "an off-topic chunk silently reaches the model and gets reasoned on as if it were on-topic." Where this codebase gets away with it is the typed retriever — EQL's structure makes "off-topic chunk" rarer than it would be on a vector index. The day the retriever stops being typed, the dressed-up version stops covering the gap and a real grader earns its place.

Diagram:
```
                  before retrieval     between retrieve+generate     after generation
   self-corrective RAG       │                ★ grader ★                       │
   blooming insights      volume-check               (absent)              hypothesis test
                       (premise gate)                                       (answer gate)
                          adjacent          ── the actual gap ──             adjacent
```

### One-line anchors
- "Retrieval success isn't answer success — the grader is the gate between them."
- "No relevance grader on the retrieval path here; two adjacent checks (volume-check before, hypothesis-test after) catch different failure modes."
- "EQL's typed shape keeps retrieval structurally on-topic — that's why the absence of a grader survives today."
- "Breakpoint: a fuzzier retriever AND answers to users without review — both flip before the grader's 2× per-turn tax earns its place."

---

## Validate your understanding

### Level 1 — Reconstruct the diagram
Close this file. Draw the canonical self-corrective RAG diagram: retrieve → grader → (pass) generate / (fail) fallback ladder. Mark the spot where this codebase does *not* have the grader. Mark the two adjacent checks it *does* have, with arrows showing which side of `retrieve` they sit on.

Open the file. Compare.

✓ Pass: you put the grader between retrieve and generate, drew the fallback ladder (rewrite / widen / escalate), and placed the volume-check before retrieval and the hypothesis-test after generation
✗ Fail: re-read How it works, wait 10 minutes, try again

### Level 2 — Explain it out loud
A colleague asks: "wait, if you don't grade relevance, how do you know the agent isn't hallucinating from off-topic numbers?" No notes. Under 90 seconds.

Checkpoints — did you:
- Distinguish "retrieval ran" from "retrieval was relevant" in one sentence?
- Name the volume-check (premise side) and hypothesis-test (answer side) honestly as *adjacent*, not as substitutes?
- Name the structural reason (EQL is typed) that today's retrieval is mostly on-topic by construction?
- Name the breakpoint (fuzzier retriever + answers to end users without review) at which the gap becomes a real problem?

If you skipped any: you described it, you didn't understand it.

### Level 3 — Apply it to a new scenario
A new feature ships: a chat surface where end-users (not the operator) ask questions about their workspace and get model-generated answers with no human review step. Without opening the code: which of the two adjacent checks still covers the relevance gap, and which doesn't? Where would you add the grader and what would the fallback ladder look like in this specific codebase?

Write your answer (4–6 sentences). Then open `lib/agents/base.ts` L143–L171 and check where the grader call would slot.

### Level 4 — Defend the decision you'd change
"You said the codebase doesn't need a grader today because EQL is typed and the operator reviews answers. If both of those changed tomorrow (a vector store over narratives goes in, AND answers ship to end users), what's the cheapest credible grader you'd add? Walk the cost: per-turn extra calls, per-investigation extra latency, how the fallback interacts with `maxToolCalls`."

Reference the code: point to `runAgentLoop` (`base.ts` L48–L176) for where the gate slots in and `monitoring.md` ~L31 for the existing premise pattern you'd extend.

### Quick check — code reference test
Without opening any files:
- What file holds the monitoring volume-check, and roughly which section of it?
- What file holds the diagnostic hypothesis-test pattern, and what does it ask the model to do?
- In `runAgentLoop`, between which two line regions would a relevance grader call slot?

Open and verify. ✓ File + function names matter; line numbers drifting is fine.

---
Updated: 2026-05-29 — created
