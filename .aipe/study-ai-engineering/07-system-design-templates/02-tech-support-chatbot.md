# Tech support chatbot system design

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
  - Conversation history per user with `{turn, role, content, tools_called, confidence_score, escalated}`.
  - Escalation log linking bot conversations to human-resolved outcomes (the training signal for future improvement).
  - Feedback log: thumbs-up/down per response, free-text corrections from agents.

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
  - Offline: golden set of resolved tickets (LLM answer vs human agent answer, rubric scored).
  - Online: resolution rate without escalation, time to resolution, CSAT (customer satisfaction).
  - Adversarial set: prompt injection attempts ("ignore previous instructions"), out-of-scope questions, hostile users.

- **Common failure modes:**
  - Hallucinated answers when KB has nothing relevant. Mitigation: relevance threshold gates response, refuse + escalate.
  - Prompt injection in user messages. Mitigation: sanitize, never let LLM emit free-form privileged actions (passwords, refunds).
  - Stale knowledge base — bot tells users about a feature that was deprecated last week. Mitigation: KB freshness SLA, doc change → re-embed within 24h.
  - Tone drift — bot sounds inconsistent across conversations. Mitigation: system prompt defines persona, eval rubric scores tone adherence per response.

- **Applies to this codebase:** `no`. blooming is an analyst product, not a support chatbot. The domains don't overlap — no knowledge base of docs, no ticket resolution, no escalation to human. Two shared shapes are worth noting: (1) blooming's QueryBox (free-form user question) is structurally similar to a chatbot's input surface, and (2) the eval rubrics + LLM-as-judge in `eval/` are the same pattern a support chatbot's offline eval would use. But there's no support-chatbot feature to defend.

- **How to make it apply:**
  - Two paths, both stretch:

    - **As a thought experiment** — "I haven't built a support chatbot, but here's how I'd extend blooming: repurpose the QueryBox as a 'ask about your workspace' assistant. Build a small KB of Bloomreach feature docs. RAG over those docs. Escalate to a real support agent when the retrieved chunks don't cover the question. The intent classifier + tool-schema constraint + eval harness in blooming would all transfer. What's missing: the KB itself, the escalation surface, the human-agent workflow." That's a defensible interview answer even without shipping code.

    - **As a real refactor** — build the "blooming user documentation" as a small KB (5–20 docs about how blooming itself works: "what does the diagnostic agent do?", "how does severity get scored?"). RAG over that for a help-me-use-blooming assistant surface in the app. Reuses everything the retrieval sub-section builds. Files: new `docs/blooming-kb/`, new `app/help/page.tsx`, new `lib/agents/help.ts` (RAG over the KB), extends the eval harness with a help-agent rubric.

  - Estimated effort for the real refactor: `1–2 weeks`. Depends on the retrieval sub-section's `B3.11` aggregate exercise landing first.
