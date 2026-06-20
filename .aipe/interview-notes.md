# AI engineering interview notes — blooming insights

> Top questions, topics, system-design prompts, and honest gaps to prepare for
> L4-L5 AI engineering interviews, anchored to real codebase ground.
> Generated 2026-06-20 from a review of `.aipe/study-*`.

---

## Top 10 questions you must defend cold

These come up in every AI-engineering interview at L4-L5. Each has real
codebase ground in blooming insights.

```
WHAT THEY ASK                                  WHERE TO PRACTICE              CODEBASE RECEIPT
─────────────────────────────────────────────────────────────────────────────────────
1. Agents vs chains — when to add a loop?      04-agents/01-agents-vs-chains  4 active agents on AptKit
                                                                              runtime; deterministic
                                                                              sequential orchestration
                                                                              (not LLM supervisor)

2. Walk me through ReAct — what runs when,     04-agents/03-react-pattern     DiagnosticAgent.investigate
   what breaks                                  + agent-arch/01-reasoning/02   forced final synthesis turn

3. Tool calling — how do you constrain what    04-agents/02-tool-calling      lib/mcp/tools.ts per-agent
   the model can do                             + 04-agents/07-capability-     allowlists; schema-gated
                                                gating                         category checklist (the
                                                                              monitoring agent's "scope
                                                                              before spend" pattern)

4. Structured outputs — what do you do when    01-llm/04-structured-outputs   isAnomalyArray + isDiagnosis
   the model returns invalid JSON              + 04-agents/06-error-recovery  type guards + tool-less
                                                                              synthesize() retry on clean
                                                                              context + FALLBACK constant

5. Prompt injection — your real defenses       06-production/03-prompt-       Read-only tool whitelist by
                                                injection + study-security/   construction; type-guarded
                                                04-read-only-tool-whitelist   output; React auto-escape on
                                                                              the rendered answer text

6. LLM evals — what kinds, when, with what     05-evals/01-eval-set-types     ★ HONEST GAP: the 4-pillar
   gotchas (LLM-as-judge bias is the trap)     05-evals/03-llm-as-judge-bias  eval suite was retired in
                                                                              PR #8. You can talk about
                                                                              what was built (calibration
                                                                              receipts + manual spot-check)
                                                                              and why it was removed

7. Cost & rate limits in production            06-production/01-llm-caching   60s TTL cache + 1.1s spacing
                                                + 02-llm-cost-optimization    gate + retry-with-jitter +
                                                + 04-rate-limiting-bp         res.usage logging at 3 of 5
                                                                              sites (the 2 unmeasured =
                                                                              the SUSPECT high-cost ones)

8. Streaming UX for a 30-90s agent run         01-llm/05-streaming            NDJSON discriminated-union
                                                + debugging-obs/01-ndjson-     AgentEvent contract; the
                                                agentevent-discriminated-     readNdjson kernel shared
                                                union                          across 4 surfaces

9. Tool authoring (MCP / custom tools)         04-agents/08-authoring-mcp-    SyntheticDataSource (516 LOC,
                                                server (RETIRED banner)       in-process, implements
                                                                              DataSource interface — the
                                                                              same agent-facing contract
                                                                              as BloomreachDataSource)

10. Adapter / provider abstraction              01-llm/08-provider-           DataSource seam survived
                                                abstraction + software-       2 adapter swaps (Olist
                                                design/01-mcp-client-deep-    added, removed, Synthetic
                                                module + system-design/03-    added) without changing
                                                provider-abstraction          caller surface
```

---

## Senior-level differentiators (L5-tier)

```
11. Multi-agent topology — supervisor-worker  agent-arch/03-multi-agent/01-  Sequential pipeline +
    vs sequential vs debate vs parallel       when-not-to-go-multi-agent     intent router; deliberate
    vs swarm. WHEN NOT to go multi-agent.     + 02 through 09                "don't pay the coordination
                                                                            tax" choice. Honest about
                                                                            having the minimum topology.

12. Generic primitives vs domain code         software-design/05-aptkit-     lib/agents/aptkit-adapters
    boundary (library + adapter pattern)      primitive-adapter-boundary     .ts — 3 small adapter
                                                                            classes implementing AptKit's
                                                                            ModelProvider / ToolRegistry /
                                                                            CapabilityTraceSink

13. Capability gating + observability         agent-arch/04-infra/05-        SchemaCapabilities → coverage
    (what the agent CAN see/do BEFORE it      guardrails-and-control         report → runnableCategories,
    spends a call)                            + 04-agent-evaluation          fed into the prompt's
                                                                            {categories} slot. Pattern:
                                                                            "scope before spend"

14. RAG architecture (chunking, embedding,    03-retrieval-and-rag/          ★ HONEST GAP: 12 RAG concept
    hybrid, reranking)                        01 through 12                   files documented; ZERO RAG
                                                                            in blooming insights. Be
                                                                            ready to walk RAG from scratch.

15. Agent memory tiers                        agent-arch/04-infra/02-        ★ HONEST GAP: docs only, no
                                              agent-memory-tiers              persistent memory in repo
```

---

## 3 system-design prompts you should be able to walk end-to-end

```
"DESIGN ME A MULTI-AGENT RESEARCH ASSISTANT"
   → agent-arch/06-orchestration-system-design-templates/01-multi-agent-research-assistant.md
   → your codebase: sequential pipeline (monitoring→diagnostic→recommendation)
   → tradeoffs: when to add a supervisor (don't, until quality ceiling)

"DESIGN ME AN AGENTIC SUPPORT SYSTEM"
   → agent-arch/06-orchestration-system-design-templates/02-agentic-support-system.md
   → your codebase: intent router (QueryAgent for free-form Q) + capability
     gating + read-only tools as the safety substrate

"DESIGN ME A TECH-SUPPORT CHATBOT"
   → ai-engineering/07-system-design-templates/02-tech-support-chatbot.md
   → would need RAG which you don't have — be ready to say so AND walk the
     design correctly anyway
```

---

## 4 honest gaps to pre-empt (interviewer probes)

These will come up. **Naming them first is a senior move.**

```
GAP                           HOW TO FRAME IT
──────────────────────────────────────────────────────────────────────────────
RAG / embeddings / vector DB  "Not in this codebase — the agents query live
                              ecommerce APIs, not a knowledge corpus. I've
                              studied 12 concepts in 03-retrieval-and-rag/
                              and can walk RAG end-to-end; the next portfolio
                              project would be the natural place to land it."

LLM eval pipeline             "Built and removed. The 4-pillar suite (detection /
                              diagnosis / recommendation / regression) shipped in
                              Phase 3 with calibration receipts (8/8 + 3/3
                              manual-vs-judge agreement, judge caught a unit-
                              of-currency bug). Removed when the synthetic-data
                              substrate it scored against was retired. RETIRED
                              banners on 13 study files preserve the design."

Multi-agent topology          "Minimal multi-agent — sequential pipeline + intent
beyond sequential pipeline    router. Not supervisor-worker, not parallel
                              fan-out, not debate. Deliberate choice: don't pay
                              the coordination tax until the simpler topology
                              hits its quality ceiling. I can name when each
                              topology earns its overhead."

Live production traffic       "Demo-mode default; live-bloomreach + live-synthetic
                              available; not deployed with real-user traffic.
                              The synthetic substrate proves the agent loop end-
                              to-end without depending on Bloomreach being up."
```

---

## Where to focus your study time (if you have 4-6 hours)

```
Hour 1-2:  ai-engineering/04-agents-and-tool-use/   (1-7) — your core surface
Hour 3:    ai-engineering/01-llm-foundations/       (1-8) — must-defend basics
Hour 4:    ai-engineering/06-production-serving/    (1-5) — cost/rate/inject
Hour 5:    agent-architecture/03-multi-agent-orch/  (1-3) — topology choices
Hour 6:    ai-engineering/05-evals-and-observability + the honest gap framing
```

---

## One sentence to internalize

> *"The codebase is LLM application engineering — multi-agent ReAct over a
> typed DataSource seam, with capability gating before spend, structured
> outputs validated at the boundary, and AptKit primitives as the framework
> layer with Blooming-owned adapters in between."*

That sentence covers questions 1, 2, 3, 4, 10, 11, 12, and 13 in one breath.
Memorize it.

---

## How to use this file

1. **Practice in order**: questions 1-10 first, then 11-15. Aim to deliver
   each in 60-90 seconds with the codebase receipt cited.
2. **Walk the 3 system-design prompts out loud** before mock interviews.
3. **Pre-empt the 4 honest gaps** — name them before the interviewer does.
4. **Re-read the one-sentence summary** before every loop.

Cross-references:
- `.aipe/study-ai-engineering/ai-features-in-this-codebase.md` — per-feature
  catalog of which patterns each agent uses, with file:line anchors
- `.aipe/study-agent-architecture/agent-patterns-in-this-codebase.md` —
  shared-spine narrative, AptKit migration receipts, adapter-switchable
  data plane
- `.aipe/study-software-design/05-aptkit-primitive-adapter-boundary.md` —
  the AOSD case study for "library + adapter pattern at the agent/library
  boundary"
- `.aipe/rehearse-interview-defense/` — the 8-chapter defense book if you
  want longer-form rehearsal scaffolding
- `.aipe/rehearse-behavioral-stories/` — STAR-format story bank for the
  behavioral half of the loop

---

Generated: 2026-06-20 — review of `.aipe/study-*` for AI-engineering
interview prep.
