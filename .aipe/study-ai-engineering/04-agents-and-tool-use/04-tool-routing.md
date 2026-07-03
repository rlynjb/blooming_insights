# 04 — Tool routing

**Type:** Industry standard. Also called: tool selection, action dispatch.

## Zoom out, then zoom in

Within an agent loop, "which tool" is a decision. This codebase leaves that decision fully to the LLM — no heuristic gating inside the loop.

```
  Zoom out — where routing happens

  agent turn                              ★ THIS CONCEPT ★
    │
    ▼
  model picks tool from the registered list  ← LLM-routed
    │
    ▼
  BloomingToolRegistryAdapter dispatches
```

Zoom in. The model has a list of ~30 MCP tools registered (`execute_analytics_eql`, `list_customers`, `list_scenarios`, etc.). Each turn, the model picks one (or two) based on the current messages array + tool descriptions. No heuristic layer inside the loop overrides the model's choice.

## Structure pass

Axis: who decides which tool to call?
- Heuristic routing: code decides based on input pattern (fast path, cheap)
- LLM routing: model decides based on its reasoning (flexible, correct on ambiguous inputs)
- Hybrid: heuristic front + LLM fallback

**Seam:** the tool list registered with the model. Everything above the seam is "the agent picks"; everything below is "code runs whichever."

## How it works

### Move 1

You've written a router — `if path === '/api/foo' → handleFoo`. That's heuristic. LLM routing is the other end: give the model a list of possible destinations, let it decide.

```
  Two routing styles

  Heuristic                       LLM-routed (this codebase's agents)
  ────────                        ────────────────
  if query contains 'search'       give LLM tool defs + query
    → search tool                  LLM emits tool_use with name
  elif starts with 'delete'        loop dispatches
    → delete tool
  else
    → llm route
```

### Move 2

**Where LLM routing happens in this codebase.**

Inside every agent's ReAct loop. AptKit's loop sends the tool list on every turn; the model returns a `tool_use` block naming which one. Zero code in this repo intervenes in that choice.

**Why no heuristic tier inside the loop.**

Because the agent's job IS the decision. Adding "if query mentions 'country' → force list_customers_by_country" would take away the flexibility the agent loop is buying. If we wanted rigid routing we'd have a chain (see `01-agents-vs-chains.md`), not an agent.

**Where heuristic routing DOES happen — one layer above.**

The intent classifier (`lib/agents/intent.ts`) picks which AGENT to invoke — diagnostic vs query. That's heuristic-shaped (Haiku classifies), but happens BEFORE the agent's tool-use loop begins. Inside the loop, it's fully LLM-driven.

**The tool descriptions matter.**

The LLM's ability to pick correctly depends entirely on tool descriptions. `synthetic-data-source.ts:120-152` has explicit `toolDescriptions` — `execute_analytics_eql: 'Run a synthetic EQL-style analytics query over the workspace.'`. Bad descriptions = wrong tool picked. Good descriptions include the WHEN as well as the WHAT ("use this when you need to segment by country").

**The 6-tool-call cap acts as an implicit routing constraint.**

Because the agent has at most 6 tool calls, it has to be selective. Six calls to `execute_analytics_eql` is the useful path; three misspent calls to `list_experiments` (which is often empty) wastes budget. The cap forces the LLM to route toward the highest-value tool per turn.

### Move 3

For loop-shaped agents, LLM routing beats heuristic — you're paying for flexibility, don't take it away. For chain-shaped or fixed pipelines, heuristic routing wins — you're paying for determinism, don't lose it to model whims.

## Primary diagram

```
  Two-layer routing in this codebase

  ┌─ Above the agent (heuristic) ─────────────────────────────────────┐
  │  user free-form query                                             │
  │        │                                                          │
  │        ▼                                                          │
  │  classifyIntent (Haiku classifier)                                │
  │        │                                                          │
  │        ▼                                                          │
  │  DiagnosticAgent  or  QueryAgent                                  │
  └────────────────────┬──────────────────────────────────────────────┘
                       │
  ┌─ Inside the agent (LLM-routed) ▼──────────────────────────────────┐
  │  ReAct loop                                                       │
  │    turn 1: model picks tool_A from ~30 registered                 │
  │    turn 2: model picks tool_B                                     │
  │    turn 3: model picks tool_A again with different args           │
  │    ...                                                            │
  │    turn N: model picks submitDiagnosis (end)                      │
  │                                                                   │
  │  no code overrides the picks; model owns the choice               │
  └───────────────────────────────────────────────────────────────────┘
```

## Elaborate

Some production agents add heuristic overrides for high-cost tools ("never call `expensive_search` more than once per investigation"). This codebase doesn't; the 6-tool-call cap serves the same purpose without needing per-tool rules.

Tool-routing can also be gated by CAPABILITY — reveal only a subset of tools to the model based on the workspace's actual schema. The categories capability filtering in `lib/agents/categories.ts:26-41` is a distant relative — it filters WHICH ANOMALY CATEGORIES to check based on which tools/events are available in the workspace.

## Project exercises

### Exercise — measure tool-choice diversity per case

- **Exercise ID:** C4.4-A · Case A (concept exercised).
- **What to build:** in the report, add "distinct tools called per case" and "tool call frequency by name across a run." Reveals whether the agent is over-reaching for `execute_analytics_eql` or actually using the tool variety it has access to.
- **Why it earns its place:** turns routing into a measured discipline. Interviewer signal: "I know my agent's tool preferences — measured, not guessed."
- **Files to touch:** `eval/report.eval.ts` (add distinct-tools table).
- **Done when:** report shows tool-call frequency per case and identifies over-reliance patterns.
- **Estimated effort:** 1-4hr.

## Interview defense

**Q: Do you route tools with regex before letting the LLM see them?**

No. Inside the agent loop, the LLM sees all ~30 tools and picks each turn. That's what the agent shape is buying — flexibility to compose tool calls based on what earlier observations showed. Regex-routing inside the loop would take that away.

**Q: What routes what THEN?**

One layer up. The intent classifier (Haiku call) decides which AGENT to invoke — diagnostic vs free-form query. That's heuristic-in-shape at the agent-selection layer. Inside the chosen agent, no more heuristic routing.

**Q: How do you keep the LLM from picking wrong tools?**

Tool descriptions. If tool descriptions include not just WHAT the tool does but WHEN to use it, the LLM picks correctly. `synthetic-data-source.ts` has explicit per-tool descriptions. Weak descriptions = wrong picks. Also the 6-tool-call cap indirectly constrains the LLM to pick high-value tools.

## See also

- `03-react-pattern.md` — the loop the routing happens in
- `01-llm-foundations/07-heuristic-before-llm.md` — the intent-classifier routing above the agent
- `06-error-recovery.md` — what happens when a wrong tool is picked
