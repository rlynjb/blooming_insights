# Self-corrective RAG

**Industry name(s):** Self-corrective RAG, CRAG (Corrective RAG), Self-RAG, relevance grading, retrieval validity gate
**Type:** Industry standard · Language-agnostic

> A grader sits between *retrieve* and *generate* and asks "is this chunk actually relevant and the answer actually grounded in it?" — if not, fall back (rewrite, widen, escalate). blooming insights has no such grader on the agentic-RAG loop; the closest adjacent checks are the monitoring agent's volume-check prompt and the diagnostic agent's hypothesis-testing structure, both of which validate the *premise* of retrieval rather than the *relevance* of a retrieved chunk.


---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Self-corrective RAG would sit at the Shared agent loop ↔ Tools seam — a grader between "retrieved chunks came back" and "the model uses them," with a fallback path (rewrite query / widen / escalate) when the grader says "not relevant." In blooming insights there's no retrieval pipeline to gate, so this band has no corrective-RAG loop. What sits in the closest architectural slot is a *premise gate* in the diagnostic flow: if the monitoring step found no anomaly, the pipeline doesn't run a diagnostic at all (no retrieval to correct because no question is being asked). Different problem, same shape — a gate that decides whether the downstream work is worth doing.

```
  Zoom out — where self-corrective RAG WOULD live

  ┌─ Shared agent loop ─────────────────────────────┐  ← we are here
  │  runAgentLoop calls a retrieval tool             │
  └─────────────────────────┬────────────────────────┘
                            │  retrieved chunks
  ┌─ Grader / corrective ───▼────────────────────────┐  ← ★ THIS ★ (absent)
  │  ★ score relevance + groundedness ★               │
  │   pass → continue to generate                     │
  │   fail → rewrite query, widen, or escalate        │
  │  ── absent in blooming insights ──                │
  │  closest analog: premise gate in pipeline.ts —    │
  │  if no anomaly, no diagnostic runs                │
  └─────────────────────────┬────────────────────────┘
                            │  validated context
  ┌─ Tools + MCP transport ─▼────────────────────────┐
  │  lib/tools/* | lib/mcp/client.ts                 │
  │  Not yet implemented: retrieval index / grader    │
  └──────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question is: how do you tell whether retrieval actually returned the right context — before the model uses it to answer? Self-corrective RAG inserts a grader between retrieve and generate, with a fallback path when the grader flags off-topic or ungrounded chunks. blooming insights does NOT implement this on a retrieval path (no retrieval exists); the closest architectural analog is the premise gate that decides whether a diagnostic should run at all. Below, you'll see the grader/fallback mechanics and where blooming insights' premise gate parallels them.

---

## Structure pass

**Layers.** A would-be self-corrective RAG setup has four layers: the **Retriever tool** (returns chunks), the **Grader** (a model or classifier scoring relevance + groundedness), the **Fallback router** (decides rewrite / widen / escalate / accept), and the **Generator** (consumes accepted context to produce the answer). In blooming insights only the first and last bands exist, occupied by `runAgentLoop` calling MCP tools and consuming the results directly; the Grader and Fallback-router bands are empty. The closest architectural analog is the premise gate at the Pipeline coordinator — CODE deciding whether the diagnostic stage should run at all based on whether monitoring found an anomaly.

**Axis: control.** Who decides whether the retrieved context is good enough to generate from — the generator (use whatever came back), a separate model grader (judge the chunks), or your code (a deterministic threshold)? This is the right axis because the entire move self-corrective RAG makes is *inserting a control point* between retrieve and generate. Trust is a tempting alternate axis (you don't trust the retriever, so you add a verifier) but trust is the *motivation*; the control flip is the mechanism.

**Seams.** Two seams are load-bearing in the WOULD-BE shape. Seam 1 sits between the Retriever tool and the Grader — control flips from CODE (tool returns chunks) to MODEL (judges them). Seam 2 sits between the Grader and the Fallback router — control flips from MODEL (verdict) to CODE (route accordingly, cap retries). Seam 2 is the load-bearing one because without it, a "fail" verdict has nowhere to go and the grader is just a comment. In blooming insights both are absent on the retrieval path; what carries the same shape is the Pipeline coordinator's premise gate (CODE deciding whether downstream work runs at all based on a CODE-side count). The pattern's shape recurs at a different boundary, and that's the lesson.

```
  Structure pass — Self-corrective RAG (would-be shape)

  ┌─ 1. LAYERS ───────────────────────────────────┐
  │  Retriever tool (returns chunks)               │
  │  Grader (would-be — absent here)               │
  │  Fallback router (would-be — absent here)      │
  │  Generator (consumes context)                  │
  └────────────────────────┬───────────────────────┘
                           │  pick the axis
  ┌─ 2. AXIS ─────────────▼────────────────────────┐
  │  control: who decides if context is good       │
  │           enough to generate from?             │
  └────────────────────────┬───────────────────────┘
                           │  trace across layers, find flips
  ┌─ 3. SEAMS ────────────▼────────────────────────┐
  │  Seam 1: Retriever ↔ Grader                    │
  │          (CODE → MODEL judge)                  │
  │  Seam 2: Grader ↔ Fallback router              │
  │          (MODEL → CODE) ★ load-bearing —       │
  │          without it, the grader is a comment   │
  │  In this repo: closest analog is the premise   │
  │  gate at the Pipeline coordinator              │
  └────────────────────────┬───────────────────────┘
                           ▼
                   Block 4 — How it works
```

The skeleton is mapped — the rest of this file walks the grader/fallback mechanics that hang off it (and where the same control-flip lives instead in this codebase).

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

The strategy in plain English: **don't generate from unvalidated context.** Retrieval is a step that can fail silently, and the failure isn't "no chunks" — it's "wrong chunks that look right." A grader scores relevance and groundedness; a fallback path handles failure. Without the grader, the model generates from whatever the retriever happened to return, and the user has no way to tell. blooming insights doesn't run a relevance grader on the retrieval path; the closest cousins are *adjacent* checks at different layers — a pre-retrieval *premise* gate in the monitoring prompt (validates the window has data), and a post-reasoning *groundedness* check via the diagnostic agent's hypothesis-falsification structure. Neither sits at the relevance seam this pattern names.

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

The technical thing: there's no relevance grader between the analytics tool call and the model's next reasoning step. The agentic-RAG loop runs the query, feeds the JSON result back, and the model reasons on it — no per-chunk scoring sits in between. But two adjacent checks exist, and naming them honestly matters.

**Adjacent check 1: the monitoring agent's volume check.** The monitoring prompt instructs the agent to spend its *first* query on a volume probe — a count of purchase events over the last 90 days — before running any anomaly recipes. If the count is empty or tiny, the agent shifts the execution time to a populated range or widens the window. This is a *premise* check: it validates that retrieval will be meaningful before doing it, not that a retrieved chunk is relevant to the question. Closest analog to a self-corrective gate, but at the wrong layer — it gates the *window*, not the *result*.

**Adjacent check 2: the diagnostic agent's hypothesis testing.** The diagnostic prompt frames investigation as "generate 2–3 competing hypotheses, then query to falsify each." This is *answer-side validity* — the model is forced to check whether the evidence supports or rules out its candidate explanation, which is a groundedness check applied to its own reasoning, not to retrieved chunks.

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
│ model picks query       │  │ model picks query               │
│   ▼                     │  │   ▼                             │
│ analytics tool call     │  │ analytics tool call             │
│   ▼                     │  │   ▼                             │
│ result fed back         │  │ GRADER: result vs question      │ ←
│   ▼                     │  │   ├─ relevant?                  │
│ model reasons & loops   │  │   └─ does it falsify/support a  │
│   ▼                     │  │      hypothesis?                │
│ next turn               │  │   ▼                             │
│                         │  │ pass → feed back to model       │
│                         │  │ fail → rewrite query / widen    │
│                         │  │        window / abstain         │
└─────────────────────────┘  └─────────────────────────────────┘
   no gate; the model    │   one extra model call per retrieval
   reasons on whatever   │   catches off-topic + ungrounded
   comes back            │   adds 1× LLM tax per turn
```

*Phase A (now):* trust the typed query language's structured shape and the monitoring volume-check; treat retrieval results as ground truth and let the diagnostic agent's hypothesis testing catch downstream inconsistency. Cheap, simple, occasionally wrong.

*Phase B (with grader):* add a relevance/groundedness check on every tool result before it's fed back to the model. Catches "wrong numbers from wrong query" earlier. Pays 1× extra model call per turn (so ~6 extra calls per investigation), bounded by the existing per-loop tool-call budget.

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
  │   │ retriever (typed query /    │                             │
  │   │ vector / SQL / web / live   │                             │
  │   │ API)                         │                             │
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
       (a CRITICAL block in the monitoring prompt)
       → validates the window has data BEFORE running recipes
    2. Post-reasoning groundedness check: diagnostic hypothesis testing
       (hypothesis-falsification structure in the diagnostic prompt)
       → validates the ANSWER against evidence, not the retrieval
       against the question

  THE GAP: no per-tool-result relevance grader between the query
  and the model's next turn. "We retrieved" is silently equated
  with "we have the right numbers" on the retrieval path itself.
```

---

## Implementation in codebase

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

## See also

→ 01-agentic-rag.md · → 03-retrieval-routing.md · → `../01-reasoning-patterns/04-reflexion-self-critique.md` · → `../../study-ai-engineering/03-retrieval-and-rag/11-rag.md`

---
Updated: 2026-05-29 — created
Updated: 2026-05-30 — Migrated to study.md v1.47 template (Phase 1+2 mechanical): removed Tradeoffs / Tech reference / Summary sections; renamed "In this codebase" → "Implementation in codebase"; moved See also to a bottom block. "Why care" preserved pending Phase 3 (Zoom out, then zoom in + LAYERS diagram) authoring.
Updated: 2026-05-30 — Phase 3 of study.md v1.47 migration: replaced "Why care" block with "Zoom out, then zoom in" (LAYERS diagram + zoom-in paragraph) per format.md.
Updated: 2026-05-31 — Applied study.md v1.48: scrubbed "How it works" of file paths, line refs, and real-code fences; replaced with generic role labels + pseudocode per format.md. Codebase-specific anchoring lives exclusively in "Implementation in codebase".
Updated: 2026-05-31 — Applied study.md v1.50: added Structure pass block (layers · axis · seams) between Zoom out and How it works per format.md's new Block 3.
Updated: 2026-05-31 — Applied study.md v1.52 voice trait (verdict first, then rank what matters) — clarity edit to Move 1 (named the codebase position — no relevance grader, only adjacent premise + groundedness-on-reasoning checks at different layers — alongside the strategy line, instead of waiting until Move 2.4).
