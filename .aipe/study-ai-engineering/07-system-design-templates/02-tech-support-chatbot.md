# 02 — tech support chatbot system design

- **The prompt:** "Design a tech support chatbot for a product. It must
  answer customer questions, escalate when it can't, and learn from
  agent corrections."

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
                   Agent answers; answer
                   logged for KB update
  ```

- **Data model:**
  - Knowledge base: docs, FAQs, past ticket resolutions. Each chunked,
    embedded, indexed.
  - Conversation history per user with `{turn, role, content,
    tools_called, confidence_score, escalated, ts}`.
  - Escalation log linking bot conversations to human-resolved
    outcomes (the training signal for future improvement).
  - Feedback log: thumbs-up/down per response, free-text corrections
    from agents.

- **Key components:**
  - *Intent classification*: detect category (billing, technical,
    account, out-of-scope) before retrieval. Decision: heuristic
    regex/keyword first, LLM classifier on ambiguous cases (see
    `01-llm-foundations/07-heuristic-before-llm.md`).
  - *RAG retrieval*: hybrid retrieval over the knowledge base, scoped
    by intent category to reduce noise. Decision: chunk by section
    not by token, so retrieved chunks are semantically coherent (see
    `03-retrieval-and-rag/03-chunking-strategies.md`).
  - *Response generation*: LLM constrained to cite retrieved KB chunks.
    Decision: refuse to answer if no chunk above relevance threshold —
    better to escalate than hallucinate.
  - *Escalation*: rule-based gate (intent = out-of-scope, OR confidence
    < threshold, OR user types "agent please") triggers handoff with
    full conversation context.
  - *Feedback loop*: agent corrections logged as gold-standard
    responses, fed back into eval set (see
    `05-evals-and-observability/01-eval-set-types.md`), used to
    identify KB gaps.

- **Scale concerns:**
  - At ~10k conversations/day: LLM cost dominates. Solution: cache
    common question-answer pairs (semantic cache,
    `06-production-serving/01-llm-caching.md`), route easy questions to
    cheaper model.
  - At ~100 escalations/day: human agents become bottleneck. Solution:
    prioritize escalation queue by user value, surface bot's draft
    response so agent edits instead of types from scratch.
  - At ~1M KB chunks: retrieval latency grows. Solution: tiered
    retrieval (intent-scoped first, full corpus only on miss),
    pre-compute embeddings for hot KB entries.

- **Eval framing:**
  - Offline: golden set of resolved tickets (LLM answer vs human agent
    answer, rubric scored — see
    `05-evals-and-observability/02-eval-methods.md`).
  - Online: resolution rate without escalation, time to resolution,
    CSAT (customer satisfaction).
  - Adversarial set: prompt injection attempts ("ignore previous
    instructions"), out-of-scope questions, hostile users (see
    `06-production-serving/03-prompt-injection.md`).

- **Common failure modes:**
  - Hallucinated answers when KB has nothing relevant. Mitigation:
    relevance threshold gates response, refuse + escalate.
  - Prompt injection in user messages. Mitigation: sanitize, never let
    LLM emit free-form privileged actions (passwords, refunds).
  - Stale knowledge base — bot tells users about a feature that was
    deprecated last week. Mitigation: KB freshness SLA, doc change
    → re-embed within 24h (see
    `03-retrieval-and-rag/09-stale-embeddings.md`).
  - Tone drift — bot sounds inconsistent across conversations.
    Mitigation: system prompt defines persona, eval rubric scores tone
    adherence per response.

- **Applies to this codebase:** **Partially.** blooming insights is
  *not* a support chatbot — it's a multi-agent analyst for a marketing
  workspace. But several patterns from the support-chatbot template
  ARE exercised here in different shapes:

  - **Intent classification (heuristic + LLM):** done. The free-form
    QueryBox uses `classifyIntent` (haiku) to route to
    monitoring/diagnostic/recommendation shapes. See
    `01-llm-foundations/07-heuristic-before-llm.md`.

  - **Multi-step agent loops with tool calls (instead of "RAG over
    KB"):** done. The diagnostic agent runs hypothesis testing via
    EQL queries — structurally similar to RAG retrieval but
    structured-query-shaped instead of semantic-retrieval-shaped.

  - **LLM response generation constrained to data:** done. The
    diagnostic agent's conclusion cites specific evidence from tool
    results.

  - **Escalation:** *not exercised.* No fallback path to a human
    analyst. Errors surface as UI error panels, but there's no
    "escalate to human" flow.

  - **Feedback loop:** *not exercised.* No thumbs-up/down on
    diagnoses or recommendations; no path for the user to correct a
    diagnosis and have it stored as a golden answer.

  So this template doesn't apply as a *whole* (blooming insights is
  the wrong product shape) but several of its *components* DO apply
  and ARE built.

- **How to make it apply:** Two paths.

  **Path A (extend blooming insights as a Bloomreach support
  chatbot):** Add a "ask the docs" surface where users can type
  questions about Bloomreach features ("how do scenarios work?"),
  retrieve from a corpus of Bloomreach docs (would need to import +
  embed), and answer with citations. Same intent classify + RAG +
  generation + escalate-on-low-confidence pattern. Would require:
  building the doc corpus (one-time crawl), embeddings + vector
  store (`03-retrieval-and-rag/04-vector-databases.md`'s exercise),
  the new UI surface, and an escalation hook (Slack or email
  notification).

  **Path B (illustrative walk-through for interview):** Walk this
  template as "I've built the agent-loop / intent classify / tool
  use components, but the *product* I shipped is an analyst, not a
  support chatbot. Here's how I'd adapt the same components to a
  support chatbot if I were building one — what stays the same
  (intent classify, agent loops, tool allowlists), what would need
  to change (RAG over docs vs EQL queries, escalation path, KB
  freshness tracking)." This is the honest defense path when the
  interviewer wants to see your thinking on a system you haven't
  built.

  For interview, Path B is usually the right framing — blooming
  insights' agent-loop architecture transfers directly to chatbot
  shapes; explicitly walking the transfer demonstrates that you
  understand the patterns at the right level of abstraction.
