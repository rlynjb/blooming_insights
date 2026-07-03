# 02 — Tech support chatbot system design

- **The prompt:** "Design a tech support chatbot for a product. It must answer customer questions, escalate when it can't, and learn from agent corrections."

- **Standard architecture:**

```
User message
  │
  ▼
┌──────────────────────────────────┐
│ Intent classification            │
│  (heuristic + LLM)               │
└──────────────┬───────────────────┘
               │
               ▼
┌──────────────────────────────────┐
│ RAG over knowledge base          │
│  (docs, past tickets, runbooks)  │
└──────────────┬───────────────────┘
               │
               ▼
┌──────────────────────────────────┐
│ LLM response generation          │
│  (constrained to retrieved KB)   │
└──────────────┬───────────────────┘
               │
          ┌────┴─────┐
          │          │
          ▼ confident ▼ unsure / out-of-scope
     Respond     ┌──────────────────┐
                 │ Escalate to      │
                 │ human agent      │
                 └──────────────────┘
                          │
                          ▼
                 Agent answers, agent
                 answer logged for
                 KB update
```

- **Data model:**
  - Knowledge base: docs, FAQs, past ticket resolutions. Each chunked, embedded, indexed.
  - Conversation history per user with `{turn, role, content, tools_called, confidence_score, escalated}`
  - Escalation log linking bot conversations to human-resolved outcomes (the training signal for future improvement)
  - Feedback log: thumbs-up/down per response, free-text corrections from agents

- **Key components:**
  - *Intent classification*: detect category (billing, technical, account, out-of-scope) before retrieval. Decision: heuristic regex/keyword first, LLM classifier on ambiguous cases.
  - *RAG retrieval*: hybrid retrieval over the knowledge base, scoped by intent category to reduce noise. Decision: chunk by section not by token, so retrieved chunks are semantically coherent.
  - *Response generation*: LLM constrained to cite retrieved KB chunks. Decision: refuse to answer if no chunk above relevance threshold (better to escalate than hallucinate).
  - *Escalation*: rule-based gate (intent = out-of-scope, or confidence < threshold, or user types "agent please") triggers handoff with full conversation context.
  - *Feedback loop*: agent corrections are logged as gold-standard responses, fed back into eval set, used to identify KB gaps.

- **Scale concerns:**
  - At ~10k conversations/day: LLM cost dominates. Solution: cache common question-answer pairs, route easy questions to cheaper model.
  - At ~100 escalations/day: human agents become bottleneck. Solution: prioritize escalation queue by user value, surface bot's draft response so agent edits instead of types from scratch.
  - At ~1M KB chunks: retrieval latency grows. Solution: tiered retrieval (intent-scoped first, full corpus only on miss), pre-compute embeddings for hot KB entries.

- **Eval framing:**
  - Offline: golden set of resolved tickets (LLM answer vs human agent answer, rubric scored)
  - Online: resolution rate without escalation, time to resolution, CSAT (customer satisfaction)
  - Adversarial set: prompt injection attempts ("ignore previous instructions"), out-of-scope questions, hostile users

- **Common failure modes:**
  - Hallucinated answers when KB has nothing relevant. Mitigation: relevance threshold gates response, refuse + escalate.
  - Prompt injection in user messages. Mitigation: sanitize, never let LLM emit free-form privileged actions (passwords, refunds).
  - Stale knowledge base — bot tells users about a feature that was deprecated last week. Mitigation: KB freshness SLA, doc change → re-embed within 24h.
  - Tone drift — bot sounds inconsistent across conversations. Mitigation: system prompt defines persona, eval rubric scores tone adherence per response.

- **Applies to this codebase:** **partially**. `blooming_insights` isn't a support chatbot — the product is an analyst-workflow tool, not a Q&A surface. But the mechanisms overlap substantially:
  - Intent classification: same shape exercised in `lib/agents/intent.ts` (Haiku classify → route to Diagnostic or Query agent)
  - Response generation via ReAct: this codebase's DiagnosticAgent + RecommendationAgent are ReAct-shaped
  - Structured outputs at the model boundary: `Diagnosis`, `Recommendation` in `lib/mcp/types.ts` — analogous to a chatbot's structured response with confidence + escalation flag
  - Escalation-shaped gate: the diagnostic agent honestly reports "no signal" on no-signal cases (goldens 05, 06, 10 in `eval/goldens/`) instead of confabulating — that's the "escalate rather than hallucinate" pattern
  - LLM-as-judge rubric: `eval/rubrics/*.ts` — the same scoring machinery a chatbot would use to grade responses in golden and adversarial sets

  What's missing to make it a chatbot: RAG over a knowledge base (see `03-retrieval-and-rag/*` — Case B), a conversational multi-turn interface (the `QueryBox` is single-turn today), a human-in-the-loop escalation path (users act on recommendations manually today).

- **How to make it apply:** the retrofit path would be:
  1. Extend `QueryBox` to a multi-turn conversation surface (keep conversation history across turns in `sessionStorage`, thread it into the QueryAgent's messages array).
  2. Add RAG over a Bloomreach knowledge base — docs, feature descriptions, past investigation summaries (`03-retrieval-and-rag/11-rag.md` Case B path).
  3. Add a per-response confidence field to the `QueryAgent`'s structured output; render an "escalate to human" button when confidence < 0.6.
  4. Route escalations to a simple dev-side "unanswered queries" log, feed into eval set weekly to identify KB gaps.
  This isn't the product I'm building — but the mechanism library is 80% there. Interview answer: "I haven't built a support chatbot, but I've built the ReAct + structured-output + evals + intent classification stack that a support chatbot needs. The retrofit is well-defined."
