# Tech Support Chatbot

**Industry name(s):** Support chatbot, RAG assistant, deflection bot, agent-assist
**Type:** Industry standard

> Answer customer questions from a knowledge base, escalate to a human when confidence is low, and feed agent corrections back into the system so it improves.

**See also:** [01-search-ranking.md](01-search-ranking.md) · [../03-retrieval-and-rag/11-rag.md](../03-retrieval-and-rag/11-rag.md) · [../04-agents-and-tool-use/05-agent-memory.md](../04-agents-and-tool-use/05-agent-memory.md) · [../05-evals-and-observability/01-eval-set-types.md](../05-evals-and-observability/01-eval-set-types.md)

This file is a **system-design-template** reframe, not a per-concept study file. It is the verbatim IK-style interview prompt answered with the canonical architecture, then honestly mapped onto blooming insights. The first seven bullets are generic — they hold for any support chatbot. Only the last two are blooming-insights-specific. Provenance: curriculum **C5.14** (build family B5.14, adapted).

---

**The prompt:** Design a tech support chatbot that answers customer questions, escalates when it can't, and learns from agent corrections.

**Standard architecture:**

```
  user message
      │
      ▼
  ┌────────────────────────┐
  │  INTENT CLASSIFICATION  │  cheap model / classifier
  │  bug · billing · how-to │  → route + pull conversation history
  │  chitchat · escalate    │
  └───────────┬─────────────┘
              │
              ▼
  ┌────────────────────────┐        ┌─────────────────────┐
  │  RAG OVER KNOWLEDGE BASE│◀──────▶│ KB index (vector +  │
  │  retrieve top-k docs    │        │ keyword) + docs     │
  │  for the question       │        └─────────────────────┘
  └───────────┬─────────────┘
              │ grounded context
              ▼
  ┌────────────────────────┐
  │  CONSTRAINED GENERATION │  answer ONLY from retrieved docs
  │  cite sources · refuse  │  + emit a confidence score
  │  when context is thin   │
  └───────────┬─────────────┘
              │
        confident? ──── yes ──▶ ┌──────────────────┐
              │                 │ RESPOND + cite    │
              no                └────────┬──────────┘
              ▼                          │
  ┌────────────────────────┐            │  thumbs up/down,
  │  ESCALATE TO HUMAN      │            │  agent edit
  │  handoff + transcript   │            ▼
  └───────────┬─────────────┘   ┌──────────────────┐
              │                 │  FEEDBACK LOOP    │
              └────────────────▶│  log corrections  │
                                │  → eval set + KB  │
                                │     refresh       │
                                └──────────────────┘
```

The spine is **classify → retrieve → ground → gate → learn**. The gate (confident-respond vs unsure-escalate) is what separates a support bot from a demo: a bot that always answers is a liability; the value is knowing when *not* to.

**Data model:**

- **Knowledge base** — `doc ID → {content, product area, version, last_updated}`, chunked and indexed (vector + keyword) for RAG. The grounding source; the bot must not answer outside it.
- **Conversation state** — `conversation ID → ordered messages[] + resolved intent + retrieved doc IDs`. Multi-turn memory so "and what about the second one?" resolves against prior turns.
- **Escalation record** — `ticket → {transcript, bot's last answer, confidence, reason, assigned agent}`. The handoff payload and the audit trail.
- **Feedback log** — append-only `(conversation, question, bot answer, retrieved docs, thumbs/edit, agent correction, timestamp)`. The raw material for both the eval set and KB gaps.
- **Eval set** — curated `(question → expected answer / expected behavior)` pairs distilled from the feedback log; the regression guard before any prompt or KB change ships.

**Key components:**

- **Intent classifier** — a cheap fast model up front. Choice: classify before retrieving so chitchat and clear escalations (angry user, account-specific request) skip the RAG+generation cost entirely, and the retriever gets a clean routed query.
- **Retriever (RAG)** — hybrid search over the KB. Choice: retrieve-then-ground rather than fine-tuning answers into the model, because the KB changes weekly and a fine-tune cannot be edited by updating a doc.
- **Constrained generator** — an LLM instructed to answer *only* from retrieved context and to cite. Choice: force grounding + citation so hallucinations are catchable (an uncited claim is a red flag) and the user can verify.
- **Confidence / escalation gate** — a decision step on retrieval score, generation self-report, or a separate classifier. Choice: a calibrated threshold, because the cost of a confidently-wrong support answer (user breaks production, files a complaint) dwarfs the cost of an unnecessary handoff.
- **Feedback loop** — thumbs and agent edits flow back. Choice: route corrections to *both* the eval set (regression guard) and a KB-gap queue (content fix), because a wrong answer is usually a missing doc, not a bad model.

**Scale concerns:**

- **KB staleness (hits first, at any nontrivial product velocity):** the KB drifts behind the product within days of a release. Past a weekly release cadence, the bot confidently cites deprecated docs. Mitigation: version docs, attach freshness to retrieval, and reindex on doc publish (cross-link [../03-retrieval-and-rag/09-stale-embeddings.md](../03-retrieval-and-rag/09-stale-embeddings.md)).
- **Escalation overload (at ~30% escalation rate):** a too-conservative gate dumps everything on humans and the bot deflects nothing — negative ROI. A too-loose gate ships wrong answers. Mitigation: tune the threshold against measured human-agreement, monitor deflection rate as a first-class metric.
- **Conversation context growth (at ~20+ turns):** full-history prompting blows the context window and cost per turn climbs linearly. Mitigation: summarize old turns, keep a rolling window, pin only the resolved intent + active doc IDs (cross-link [../04-agents-and-tool-use/05-agent-memory.md](../04-agents-and-tool-use/05-agent-memory.md)).
- **Feedback volume vs label quality (at ~10k feedback events/week):** raw thumbs are noisy and sparse; most users never rate. Mitigation: sample for human review, weight agent edits over user thumbs, and never auto-promote raw feedback into the KB without review.

**Eval framing:**

- **Offline:** answer accuracy and faithfulness (is the answer supported by retrieved docs?) on the curated eval set; retrieval recall@k (did the right doc get retrieved at all?); escalation precision/recall (did it escalate the questions it *should* have?).
- **Online:** deflection rate (resolved without a human), escalation rate, customer satisfaction (CSAT) on bot-handled conversations, and reopen rate (did the "resolved" answer actually stick?).
- **The trap:** measuring only deflection rewards a bot that confidently answers everything wrong. Pair deflection with CSAT and reopen rate, and gate every change on the offline faithfulness set (cross-link [../05-evals-and-observability/01-eval-set-types.md](../05-evals-and-observability/01-eval-set-types.md)).

**Common failure modes:**

- **Confident hallucination** — the bot answers from parametric memory when retrieval returned nothing useful. Probe: "what does it do when the KB has no answer?" Mitigation: instruct refusal on thin context, surface retrieval scores to the gate, require citations.
- **Wrong-or-no escalation** — it answers questions it should hand off (account-specific, legal, angry user) or escalates trivially. Mitigation: route high-risk intents straight to escalation at classification time, before generation.
- **Feedback loop poisoning** — auto-ingesting raw user corrections lets a few bad signals degrade answers. Mitigation: human-in-the-loop review before any correction reaches the KB or training set.
- **Context bleed across turns** — stale retrieved docs or a misclassified intent from turn 1 contaminates later turns. Mitigation: re-retrieve per turn, re-evaluate intent on topic shift, scope memory to the active thread.

**Applies to this codebase:** **Partially.** The structural skeleton is real and recognizable; three of the five canonical components are missing. What exists: the ask-anything `QueryAgent.answer(query, intent, hooks)` (`lib/agents/query.ts:24`) is genuinely "a chatbot over your Bloomreach workspace" — a free-text question goes in, a grounded natural-language answer comes out. It is fronted by real intent routing: `parseIntent` does a heuristic substring pass (`lib/agents/intent.ts:6`) and `classifyIntent` does the LLM classification on the cheap `claude-haiku-4-5-20251001` model with `max_tokens: 16` to force a one-word label (`lib/agents/intent.ts:17`); `app/api/agent/route.ts:136` calls `classifyIntent` then dispatches to `QueryAgent.answer`. The answer is *tool-grounded* — the agent loop fetches live data via MCP tools before answering — and the whole thing streams back as NDJSON reasoning steps (`app/api/agent/route.ts:135–142`). That is classify→ground→respond, three of the five stages.

What is missing: (1) **KB-RAG** — there is no knowledge base and no retrieval index; grounding comes from *live MCP tool calls*, not retrieved documents (the deliberate "live tools over embedding-RAG" choice — cross-link [../03-retrieval-and-rag/11-rag.md](../03-retrieval-and-rag/11-rag.md)). (2) **Escalation gate** — `QueryAgent.answer` always answers; on failure it returns the string `'I was unable to find enough data to answer that question.'` (`lib/agents/query.ts:47`) rather than handing off, and there is no confidence score anywhere. (3) **Feedback / correction loop** — query results are explicitly never cached (`app/api/agent/route.ts:62` comment) and no thumbs/edit/correction is logged. (4) **Multi-turn memory** — each `?q=` is one-shot: the query string becomes `userPrompt: query` (`lib/agents/query.ts:35`) with no conversation history threaded in (cross-link [../04-agents-and-tool-use/05-agent-memory.md](../04-agents-and-tool-use/05-agent-memory.md)).

**How to make it apply:** Close the three gaps against the parts that already exist. (1) **Multi-turn memory:** thread a conversation ID through `app/api/agent/route.ts` and persist the message history in `lib/state/` (mirror the keyed-store pattern in `lib/state/investigations.ts`), then pass prior turns into `QueryAgent.answer` so the second question resolves against the first. (2) **Escalation gate:** add a confidence/escalation decision on the query answer — replace the bare fallback string at `lib/agents/query.ts:47` with a typed `{answer, confident}` result and have `route.ts` emit an escalation event when `confident` is false instead of silently returning thin prose. (3) **Feedback loop:** add a thumbs-up/down endpoint and log `(query, answer, rating)` to a new `lib/state/feedback.ts` store, then distill those into an eval set that gates prompt changes (cross-link [../05-evals-and-observability/01-eval-set-types.md](../05-evals-and-observability/01-eval-set-types.md)). KB-RAG stays deliberately deferred: live tool-call grounding is the right call until a feature needs offline document recall.
