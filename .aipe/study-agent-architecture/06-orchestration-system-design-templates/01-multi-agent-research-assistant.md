# Multi-agent research assistant

> The whiteboard prompt for a supervisor that decomposes a research question, fans out to source-specialist workers, and synthesizes a cited answer — mapped against blooming insights.

This file uses the **nine-bullet system-design-template shape** (not the per-concept study template). The first seven bullets are generic and hold for any repo; the last two are answered against blooming insights' real code.

---

**The prompt:** Design a system that answers a complex research question by gathering from multiple sources and synthesizing.

**Standard architecture:**

```
        user question
              │
              ▼
   ┌──────────────────────────┐
   │ Supervisor agent         │
   │ - decompose into sub-Qs  │
   │ - pick which worker(s)   │
   └─────┬──────┬───────┬─────┘
         │      │       │              fan-out
         ▼      ▼       ▼
   ┌────────┐┌────────┐┌────────┐
   │worker 1││worker 2││worker 3│      each runs agentic RAG
   │source A││source B││source C│      against one source
   └────┬───┘└────┬───┘└────┬───┘
        │         │         │
        └────┬────┴────┬────┘          findings store
             ▼         ▼
        ┌────────────────────────┐
        │ Supervisor synthesizes │
        │ - merge findings       │
        │ - resolve conflicts    │
        │ - attach citations     │
        └──────────┬─────────────┘
                   ▼
            cited answer
```

The shape is **supervisor-worker fan-out plus synthesis**: one orchestrator decides who runs and merges what they return; many specialists each go deep into one source. The orchestrator stays in control (workers are tools, not handoffs), so the trajectory is debuggable.

**Data model:**

- **Source registry** — `source_id → {kind, endpoint, embed model, auth}`. Tells the supervisor which workers exist and what each is good at.
- **Per-worker retrieval index** — one vector / inverted / live-API index per source. Workers do not share indices; that is the whole point of specialization.
- **Findings store** — `{sub_question_id, source_id, claim, evidence_chunks[], confidence}`. Append-only. The supervisor reads this at synthesis time.
- **Citation provenance** — `claim → [chunk_ids → source_id]`. Every sentence in the final answer must trace back through this table.
- **Run trace** — `{run_id, decomposition, worker_results[], synthesis, latency, cost}`. The trajectory record for eval and debugging.

**Key components:**

- **Decomposition (supervisor)** — an LLM call that splits the question into independent sub-questions. Choice: tools-style delegation (workers are tool calls the supervisor makes), not handoff — because handoff transfers control and you lose the merge step. The supervisor keeps the conversation.
- **Parallel retrieval (workers, fan-out)** — N concurrent worker runs, each its own agentic RAG loop. Choice: cap concurrency with a semaphore at the provider's rate limit divided by per-worker duration — fan-out is a `Promise.all()` over independent worker calls with a cap, not unbounded.
- **Synthesis (merge agent)** — a single LLM call over the findings store that produces the cited answer. Choice: synthesize against the findings store, not the raw worker transcripts, so the supervisor sees structured claims + chunk IDs, not three 8k-token reasoning traces (avoids lost-in-the-middle).
- **Citation tracking** — every claim emitted by a worker carries its chunk IDs; synthesis only keeps claims whose citations resolve. Choice: server-side resolution (the model emits chunk IDs, code resolves them to URLs/text) — never trust the model to format a citation.
- **Shared context routing** — each worker gets only its sub-question + its source's retrieval, not the whole conversation. Choice: message passing over a shared blackboard — the blackboard pattern bloats every worker's window with every other worker's chatter (see SECTION C's shared-state-and-message-passing file).

**Scale concerns:**

- **Worker fan-out cost (hits first, at ~5 sources × deep questions):** five workers each running a 6-step ReAct loop is ~30 LLM calls per question. At any volume the supervisor's cheap orchestration is dwarfed by worker token spend. Mitigation: run workers on a cheap model (haiku-tier), reserve the expensive model for the supervisor's decomposition and synthesis turns only.
- **Provider rate limit on the fan-out (at ~10 QPS of new questions):** N workers per question × Q questions/sec saturates the provider's RPM well before CPU is the bound. Mitigation: concurrency cap + a per-tenant queue + backpressure upward (when the queue grows, the supervisor stops decomposing further). See SECTION E's `02-fan-out-backpressure.md`.
- **Synthesis context blowup (at ~10+ workers):** ten workers each returning 5 findings is ~50 claims plus their evidence — the synthesis prompt balloons. Mitigation: per-worker summary instead of raw transcripts; cap evidence-chunk char count per finding; if still too large, two-stage synthesize (cluster findings by sub-question first, then synthesize across clusters).
- **Citation drift (at any scale, but breaks at ~100k chunks):** the model emits chunk IDs that don't resolve, or paraphrases a claim past what its citations support. Mitigation: hard-validate every emitted citation against the chunk store; drop unsupported claims; surface the drop rate as a metric.

**Eval framing:**

- **Trajectory eval (offline, golden runs):** for a fixed set of research questions, did each worker hit the right source? Did the decomposition cover the question? Did synthesis use every relevant finding?
- **Answer groundedness (offline):** every claim cites a retrieved chunk; rate the cite-to-claim resolution rate and the per-claim NLI score (does the chunk actually entail the claim).
- **Online:** per-question cost, p50/p95 latency, retry rate, user-marked "incomplete answer" rate. Run these on every supervisor / worker / model swap.
- **The trap:** end-to-end answer quality looks fine while one worker is silently bad — its findings get drowned by the others. Track per-worker contribution rate and per-worker groundedness.

**Common failure modes:**

- **Synthesis of contradictory sources** — two workers return opposite claims; the supervisor averages them into a confident wrong answer. Mitigation: synthesis prompt that *surfaces* conflicts ("source A says X, source B says Y") rather than resolves them silently; validate the merged claim against a schema before emitting.
- **Citation hallucination** — model invents chunk IDs that look real. Mitigation: server-side resolution + reject unresolved claims; never let the model write the citation string directly.
- **Cost blowup from deep loops** — a worker's agentic RAG re-retrieves on every turn until budget. Mitigation: per-worker `maxToolCalls` cap (the same control SECTION C's coordination-failure-modes file names), and a global per-question token ceiling that halts the whole run.
- **Lost-in-the-middle across worker results** — synthesis prompt is too long; the supervisor anchors on the first and last workers and ignores the middle. Mitigation: synthesize structured claims (small per-claim payload), not raw transcripts; put highest-priority findings at the ends.

**Applies to this codebase:** `partially`. Blooming insights **is** a gather-then-synthesize system — the monitoring agent detects anomalies, the diagnostic agent gathers EQL evidence, the recommendation agent synthesizes Bloomreach actions — but the topology is **deliberately not** the supervisor-worker fan-out this template describes.

Three concrete gaps:

1. **One source, not many.** All three agents query the same source — Bloomreach Engagement via MCP, tool defs in `lib/mcp/tools.ts`. There is no source registry and no per-worker index; the workspace schema (`bootstrapSchema` in `lib/mcp/schema.ts`, called from `app/api/agent/route.ts:202`) is the closest thing to one. "Multiple sources" would mean splitting the MCP tool surface into specialist tool subsets (events, customers, catalogs) — which `lib/agents/tool-schemas.ts` does scope per-agent but not per-domain.
2. **Deterministic orchestration, not an LLM supervisor.** The "supervisor" in this codebase is **route code**, not a model. `app/api/agent/route.ts` (lines 199–249) picks the lead agent from the URL `step` param (`diagnose` / `recommend`) and the presence of `q`/`insightId`, runs the diagnostic agent then the recommendation agent in fixed order, and passes a typed `Diagnosis` between them. No LLM decides which agent runs next.
3. **Sequential stages, not parallel workers.** The pipeline is `monitoring → diagnostic → recommendation`, each user-gated (the diagnostic step writes its diagnosis to `sessionStorage` under `bi:diag:<id>` in `lib/hooks/useInvestigation.ts:138–139`; the recommend step reads it back and is only fired when the user opens step 3). There is no fan-out — the ~1 req/s Bloomreach rate limit makes concurrency unprofitable here. The whole *point* of this topology is sequential, user-gated decision points.

So blooming insights occupies the structural slot the template names — orchestrated agents producing a synthesized answer — but with the **minimal multi-agent topology**: deterministic sequential pipeline, single source, no LLM supervisor. The reasons are honest engineering constraints (one upstream rate limit, user-paced UX, "don't pay coordination tax until you need it"), not missing features.

**How to make it apply:** the literal supervisor-worker fan-out would require three additions, in order of cost.

1. **Add an LLM supervisor in front of the pipeline.** Today the dispatcher is `app/api/agent/route.ts:199–200` (`leadAgent = q && !insightId ? 'coordinator' : step === 'recommend' ? 'recommendation' : 'diagnostic'`). Replace that with a haiku-tier supervisor call that reads the user question (or the anomaly) and emits a sub-question plan plus the worker set to spawn. Keep it tools-style: the supervisor returns a structured plan; the route code (still) dispatches the workers. The decomposition logic belongs in a new file, e.g. `lib/agents/supervisor.ts`, sharing `runAgentLoop`.
2. **Split workers by Bloomreach data domain.** Right now `lib/mcp/tools.ts` defines one tool surface and `lib/agents/tool-schemas.ts`'s `filterToolSchemas` (line ~15) scopes it per agent role. Add a second scoping axis — by *domain* (events, customers, catalogs, scenarios) — and spawn one worker per relevant domain instead of one diagnostic agent over everything. Each worker is a small `runAgentLoop` invocation with its own `maxToolCalls` budget (4–6) and its own scoped tool subset.
3. **Fan out under a concurrency cap.** The ~1 req/s Bloomreach rate limit (enforced by `McpClient`'s ~1.1s spacing, `lib/mcp/client.ts`) means a literal `Promise.all(workers)` will serialize at the transport layer anyway. The cap belongs at the *agent* layer: cap concurrent workers at the rate-limit ceiling, queue the rest, and let the supervisor backpressure (stop spawning more if the queue is full). Plumb this through `app/api/agent/route.ts`'s stream handler — the existing `collected: AgentEvent[]` (line 171) becomes the synthesis input.
4. **Extend the synthesis path.** The recommendation agent (`lib/agents/recommendation.ts`) is already a synthesis step — it reads a typed `Diagnosis` and emits typed `Recommendation[]`. Adapt it to read a **set** of per-worker findings (each itself a typed payload, not raw prose) and synthesize across them. Reuse `parseAgentJson` + `isRecommendationArray` from `lib/mcp/validate.ts` as the output gate; add an inter-worker conflict-surfacing rule in the system prompt.

The honest version of "how to make it apply" is: don't, unless a feature genuinely requires multiple sources or genuinely benefits from parallelism. The coordination tax (2–5x overhead, larger debugging surface, the conflict-merge failure mode) buys nothing under one source and one rate limit. The codebase's current shape is the right answer to its current problem.

**Where this codebase IS load-bearing for this template's interview answer: the eval flywheel.** What blooming insights doesn't exercise on the *topology* axis it does exercise on the *measurement* axis. The four-pillar eval suite under `eval/` (detection precision/recall, diagnosis rubric, recommendation rubric, regression) is exactly the kind of senior-level discipline this template's "Eval framing" bullet asks for — and the flywheel that produced its portfolio numbers is the interview-grade detail to lead with:

  → PR D ran detection K=10 and surfaced 5% LOOSE recall — the monitoring agent was anchoring on the wrong time window for the Olist data horizon.
  → Phase 2.5 fixed the prompt (added a `DATA HORIZON` section + a 3-dim scan plan). Detection lifted 5x (voucher anomaly: 1/10 → 10/10).
  → PR E added the diagnosis rubric. Its Sonnet-as-judge caught a **BRL cents-vs-Reais unit-conversion bug** — the diagnostic agent was reading `payment_value` as Reais in one query and cents in the next, silently swinging conclusions by ~100x.
  → A prompt fix patched it; PR F's rerun caught the bug **recurring at run 8 of K=10** — proof that the eval catches recurrence, not just first-occurrence.
  → PR G's regression eval scored 30% baseline against 10 captured fixtures, surfacing that monitoring and diagnostic outputs drift semantically faster than the prompts change — which is the next thing to tighten.

The pattern to name in interview: *measurement → fix → re-measurement → discovery of the next thing.* That's what an eval flywheel looks like in production, and it's the work blooming insights actually did. The supervisor-worker topology refactor above is hypothetical; the eval discipline is shipped.

---
