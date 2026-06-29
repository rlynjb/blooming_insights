# RFC 03 — Deterministic supervisor, not an LLM router

**One-line summary.** The pipeline is a fixed sequence — monitoring → diagnostic → recommendation — driven by route code, not a "supervisor agent." The free-form Q&A surface uses a one-shot intent classifier (haiku) as a deterministic ROUTE step, not as a planner.

---

## Context

The product has four agents: `monitoring`, `diagnostic`, `recommendation`, and `query`. The textbook AI-engineering move when you have N agents is to add an N+1th — a "supervisor" or "coordinator" agent — that takes the user's request, decides which agent to call, hands off context, and decides when to stop. LangGraph, CrewAI, AutoGen, and most "multi-agent" tutorials show this shape.

This repo deliberately does not do that. The constraints that drove the choice:

- **The sequence is fixed by the product.** Step 1 of the UI is monitoring (the feed). Step 2 is diagnostic (investigate one anomaly). Step 3 is recommendation (decide on action). The stepper enforces it; the user clicks through it; the URL reflects it. There is no "agent decides whether to investigate or recommend next" — the human decides, by clicking.
- **Each agent IS a Claude+tool-use loop already.** The intra-agent control is LLM-driven (the model picks the next EQL query); the inter-agent control does not need to be. Asking a model to decide "should I run diagnostic now?" is asking it to do something the URL already encoded.
- **The alpha MCP server is rate-limited and revokes tokens.** Every extra LLM call costs latency budget AND a chance to fail. An LLM router would add a Claude round-trip before each agent — pure overhead in the hot path.
- **The free-form Q&A surface is the one place ambiguity is real.** "What's my purchase rate this week?" vs "Why did checkout drop?" want different agents. That's a one-shot classification, not a multi-step plan.

---

## Decision

**Two pieces, both deterministic in the orchestration layer:**

```
  Two control planes — both deterministic at the outer layer

  ┌─ The pipeline (investigation flow) ──────────────────┐
  │                                                       │
  │  app/api/agent/route.ts is the supervisor             │
  │                                                       │
  │  step=diagnose  →  DiagnosticAgent.investigate()     │
  │                       (Claude loop, model picks       │
  │                        EQL queries)                   │
  │  step=recommend →  RecommendationAgent.propose()      │
  │                       (Claude loop, model decides     │
  │                        which actions to suggest)      │
  │                                                       │
  │  Order: ROUTE CODE                                    │
  │  Each step: LLM + TOOLS                               │
  │                                                       │
  └───────────────────────────────────────────────────────┘
                                          ▲
                              the seam: who decides flips
                                          ▼
  ┌─ The Q&A surface (free-form questions) ──────────────┐
  │                                                       │
  │  classifyIntent(q) → 'analytical' | 'diagnostic' |    │
  │                      'recommendation' | 'general'     │
  │                                                       │
  │  Haiku one-shot, no tools                             │
  │  Output IS the route — passed to QueryAgent which     │
  │  picks behavior from intent                           │
  │                                                       │
  │  This IS the LLM router — bounded to a single         │
  │  classification, never re-entered                     │
  └───────────────────────────────────────────────────────┘
```

**Inside `app/api/agent/route.ts`**, the orchestration is literally an `if/else`:

```
  app/api/agent/route.ts — the deterministic switch

  if (q && !insightId) {                      // free-form Q&A
      intent = classifyIntent(q)              // one Haiku call
      answer = QueryAgent.answer(q, intent)   // one agent loop
      done
  }

  if (step !== 'recommend') {                 // run diagnostic
      diagnosis = DiagnosticAgent.investigate(anomaly)
      emit('diagnosis', diagnosis)
  }

  if (step !== 'diagnose') {                  // run recommendation
      recs = RecommendationAgent.propose(anomaly, diagnosis)
      emit('recommendation', rec) for each
  }

  emit('done')
```

The "supervisor" is the route handler. The control axis (who decides what runs next?) is *code* at the outer layer and *LLM* inside each agent loop. That's the seam this RFC is built on.

**The intent classifier** is a single call to `claude-haiku-4-5-20251001` (`lib/agents/intent.ts:33`) — cheapest model, no tools, returns one of four enum values. It runs once per Q&A submission and its output is the route. There's no "did I classify right? let me reclassify" loop. If it picks wrong, the user sees the wrong agent's answer and re-asks.

---

## Alternatives considered

### LLM supervisor agent (the popular pattern)

A `coordinator` agent that takes the user's intent and decides — per turn — which sub-agent to invoke. LangGraph's tutorial shape.

**Why it lost.** Three reasons:

1. **The order is already encoded in the UI.** The stepper IS the supervisor. Putting a model behind the stepper to "decide what to do next" would be asking it to read the URL and report it back. That's a constant function with extra steps.
2. **Latency cost.** Each supervisor turn is a Claude call. Under the alpha server's ~1 req/s MCP cap, every saved round-trip is real. Live investigations run ~100–115s already; adding 1–3 supervisor calls pushes against the 300s Vercel ceiling.
3. **Failure surface.** A supervisor LLM that hallucinates "run recommendation first" breaks the product (recommendation requires a diagnosis as input). The deterministic path makes that impossible — the type system enforces it.

### Sequential pipeline, no Q&A surface

Drop the free-form Q&A. The product is the three-step flow, full stop.

**Why it lost.** The Q&A surface (`QueryBox`, free-form "ask anything about your workspace") is a real product feature, not optional. It's how a user follows up — "got it, but what about returning customers specifically?" Without it the product is a static report.

### Rule-based intent classifier (regex / keyword)

Skip the haiku call. Match "why" → diagnostic, "what" → analytical, "should I" → recommendation.

**Why it lost.** Tried implicitly (it's the obvious baseline). Real questions don't sort by keyword: "What's behind the conversion drop?" is a why-question with no "why." A 200ms haiku call buys real classification quality for a cost the product can absorb easily — it's one call per question, not per turn.

---

## Consequences

**What this cost — owned, not apologized for:**

- **The pipeline can't reorder itself.** If diagnostic discovers "actually, this is a recommendation-shaped problem," it can't pivot. The user has to back up and click again. The product's shape (three discrete steps the user navigates) makes that fine; a different product (chat-shaped, open-ended) would fight this hard.
- **Adding a new agent means editing the route file.** There's no plugin shape — you can't drop in a fifth agent and have the supervisor "discover" it. Every new agent is a code change at the supervisor seam. That's the cost of *being* the supervisor in code. For five agents today it's a feature; for fifty it would be debt.
- **The intent classifier is a single point of failure for Q&A.** If haiku is down, Q&A is down. The investigation pipeline keeps working (no classifier in that path). A future hardening would fall back to a keyword classifier on Haiku failure, accepting the worse quality for the availability.

**What this bought:**

- **Cheap, fast, debuggable orchestration.** The control flow is in one file (`app/api/agent/route.ts`). When something runs wrong order, you read the route. There's no graph state, no message bus, no tool-use loop to step through.
- **Type safety across agent boundaries.** `DiagnosticAgent.investigate` returns a `Diagnosis`; `RecommendationAgent.propose` requires one. The compiler enforces what the supervisor LLM would have had to learn from the prompt.
- **The Claude usage is honest.** Every Claude call is doing real work — running a tool-use loop inside one agent. No call is spent on "deciding what to do next" when the URL already said. The token bill maps cleanly to product features.
- **Each agent is independently testable.** No supervisor mock needed; tests construct an agent with a fake `DataSource` and exercise its loop directly. The 24-test suite (221 tests, all passing) covers each agent's behavior without ever instantiating a coordinator.

---

## Open Questions

- **Does a fifth agent change the calculus?** Today's five (monitoring, diagnostic, recommendation, query, plus the intent classifier as a one-shot) are linear in the route file. A sixth that needs to interleave with diagnostic — say, a "cohort segmentation" agent that diagnostic might want to call mid-investigation — would break the linear shape. At that point the question is "promote to LLM supervisor, or add a structured sub-pipeline?" Today's answer would be sub-pipeline; that may change.
- **Should the intent classifier emit confidence?** Today it returns a label. A confidence score would let the route fall back to "ask the user to clarify" on low confidence instead of routing to the wrong agent. Cheap to add (the haiku response already has logprobs); only worth it once a quality bar makes "ask again" preferable to "guess and answer."
- **Where is the seam if this gets ported to a different framework?** The "supervisor is route code" depends on Next.js route handlers being a comfortable place to write orchestration. If this moved to a worker-queue shape, the supervisor would migrate to the worker entry point — still deterministic, still code, just a different file. The pattern survives the move.
