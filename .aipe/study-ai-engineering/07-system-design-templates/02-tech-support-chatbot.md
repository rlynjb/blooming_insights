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
  - Conversation history per user with `{turn, role, content, tools_called, confidence_score, escalated}`
  - Escalation log linking bot conversations to human-resolved outcomes (the training signal for future improvement)
  - Feedback log: thumbs-up/down per response, free-text corrections from agents

- **Key components:**
  - *Intent classification:* detect category (billing, technical, account, out-of-scope) before retrieval. Decision: heuristic regex/keyword first, LLM classifier on ambiguous cases.
  - *RAG retrieval:* hybrid retrieval over the knowledge base, scoped by intent category to reduce noise. Decision: chunk by section not by token, so retrieved chunks are semantically coherent.
  - *Response generation:* LLM constrained to cite retrieved KB chunks. Decision: refuse to answer if no chunk above relevance threshold (better to escalate than hallucinate).
  - *Escalation:* rule-based gate (intent = out-of-scope, or confidence < threshold, or user types "agent please") triggers handoff with full conversation context.
  - *Feedback loop:* agent corrections are logged as gold-standard responses, fed back into eval set, used to identify KB gaps.

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

- **Applies to this codebase:** `partially`.

  The multi-agent investigation flow has the *structural shape* of a chatbot's intent-classify → RAG → constrained-response pipeline:

  | Tech support chatbot piece | blooming_insights equivalent |
  |---|---|
  | Intent classification | `lib/agents/intent.ts` (Haiku classifier, 4 intents) |
  | RAG over knowledge base | Schema-as-retrieval (`03-retrieval-and-rag/01-schema-as-retrieval.md`) + live EQL queries |
  | LLM response generation | The four Sonnet agents (monitoring, diagnostic, recommendation, query) |
  | Constrained to cite sources | Diagnoses include `evidence[]` with tool result citations |
  | Tool allowlist | `lib/mcp/tools.ts` (per-agent allowlist) |
  | Refuses when no relevant context | Returns "no anomalies above threshold" rather than hallucinating |

  What's missing: (1) **escalation** — there's no "I don't know, ask a human" path; the agent always produces *something*. (2) **Feedback loop** — agent corrections aren't captured; there's no "edit this recommendation, learn from the edit" path. (3) **Conversation history across sessions** — every chat query is fresh (see `04-agents-and-tool-use/05-agent-memory.md`).

  Also: the *intent* is generation (find anomalies, propose actions), not Q&A. Users aren't asking support questions; they're investigating data.

- **How to make it apply:**

  Three concrete additions, in product-fit order:

  1. **Add a "this recommendation isn't quite right — here's a correction" affordance** to the recommendation card. Capture the correction in a per-user feedback log. This is the feedback loop a tech support chatbot needs to improve over time. Adjacent benefit: turns the recommendation surface from one-way (LLM → user) into two-way (LLM ↔ user). Pre-requires the user-override-lock pattern (`B1.9` in `01-llm-foundations/09-user-override-locks.md`).

  2. **Add escalation as a "talk to support" affordance** on any agent error or low-confidence diagnosis. Today, low-confidence diagnoses surface a `confidence: 'low'` badge but no path forward. An escalation surface (mailto link, Bloomreach support chat, etc.) plus a copy-conversation-context affordance gives users a real path when the agent can't help.

  3. **Persist conversation history per user** (`B4.5` in `04-agents-and-tool-use/05-agent-memory.md`) so the query agent can follow up on prior questions. This is the structural change that turns the chat surface from one-shot Q&A into actual conversation. Pre-requires storage (Vercel KV or SQLite).

  Reference exercises: `B1.9` (user override locks), `B4.5` (persist investigations), `B6.3` (action confirmation gate — relevant to "escalate to human" structurally).
