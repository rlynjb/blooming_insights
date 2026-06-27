# Tool routing

**Industry name(s):** tool scoping / least-privilege tool exposure, intent routing / request classification, routing-by-construction
**Type:** Industry standard · Language-agnostic

> blooming insights routes at two levels: each agent is handed only its relevant tool SUBSET (`monitoringTools` / `diagnosticTools` / `recommendationTools`) so the model cannot reach for the wrong tool, and free-form `?q=` queries are routed by a heuristic-first, LLM-second intent classifier (`parseIntent` then `classifyIntent`) to the right agent surface.


---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Tool routing is two decisions at two different layers. The Intent-parsing band routes a free-form `?q=` to the right agent (`parseIntent` first, `classifyIntent` second — see → ../01-llm-foundations/07-heuristic-before-llm.md). The Per-agent definitions band routes the *tool menu* per agent — each agent receives only its filtered subset (e.g. `diagnosticTools` of ~17 instead of the full ~40), so the wrong tool is never on the menu when the model picks.

```
  Zoom out — the two routing decisions

  ┌─ Route ──────────────────────────────────────────┐
  │  ?q=... or ?insightId=...                          │
  └─────────────────────────┬────────────────────────┘
                            │
  ┌─ Intent parsing (cross-cutting) ─────────────────┐  ← we are here (decision 1)
  │  ★ parseIntent (free) → classifyIntent (haiku) ★  │
  │    → which agent handles this?                     │
  │  lib/agents/intent.ts                              │
  └─────────────────────────┬────────────────────────┘
                            │ chosen agent
  ┌─ Per-agent definitions ─▼────────────────────────┐  ← we are here (decision 2)
  │  ★ filterToolSchemas(allTools, agentToolNames) ★  │
  │    monitoring → monitoringTools                    │
  │    diagnostic → diagnosticTools (~17)              │
  │    recommendation → recommendationTools            │
  │  lib/mcp/tools.ts                                  │
  └─────────────────────────┬────────────────────────┘
                            │  curated menu
  ┌─ Agent loop + Tools ────▼────────────────────────┐
  │  model picks from the SUBSET only                 │
  └──────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question is: how do you stop a model from reaching for the wrong tool, and how do you send a free-form question to the right specialist? The failure mode is silent and expensive — show a model 40 tools and it sometimes calls one with nothing to do with the question, burning a budget slot and polluting the context. The fix is *routing by construction*: hand the model a small curated subset (decision 2) and route the request to the right specialist first (decision 1). How it works walks both decisions and the rule that subset-scoping beats prompt-discipline.

---

## Structure pass

**Layers.** Four layers stage two routing decisions: the route handler receives `?q=` or `?insightId=`, the intent-parsing band picks an agent (`parseIntent` → `classifyIntent`), the per-agent definitions hand the chosen agent a filtered tool subset (`filterToolSchemas`), and the agent loop runs the model against only that subset. Two routers, two decisions, one combined effect.

**Axis: control.** Who decides which tool fires — and is that decision made at *build/config time* (the static tool subset) or at *request time* (the dynamic intent classifier and then the model's tool pick)? This axis is the right lens because tool routing is a *layered narrowing of choices*: each layer removes options the next layer can't pick from. The recurring sub-section axis (CODE vs MODEL) shows up here as two CODE-side gates that fence the MODEL's options.

**Seams.** The cosmetic seam is between the route handler and the intent parser — both are URL parsing. The load-bearing seam is between the intent-parsing band (chose agent) and the per-agent definitions (filtered subset): control flips here from "request-time dynamic pick" to "build-time static allow-list." A second load-bearing seam: between the curated tool menu and the agent loop — once the menu is filtered, the model's choice is *within a safe set by construction*, not by prompt discipline. Subset-scoping beats prompt instructions every time.

```
  Structure pass — tool routing

  ┌─ 1. LAYERS ───────────────────────────────────┐
  │  route handler (q vs insightId)                │
  │  intent parsing (parseIntent → classifyIntent) │
  │  per-agent definitions (filterToolSchemas)     │
  │  agent loop (model picks within subset)        │
  └────────────────────────┬───────────────────────┘
                           │  pick the axis
  ┌─ 2. AXIS ─────────────▼────────────────────────┐
  │  control: build-time static vs request-time    │
  │  dynamic — at each layer who decides?          │
  └────────────────────────┬───────────────────────┘
                           │  trace across layers, find flips
  ┌─ 3. SEAMS ────────────▼────────────────────────┐
  │  route↔intent: cosmetic                        │
  │  intent↔subset: LOAD-BEARING                   │
  │    request-time → build-time control           │
  │  subset↔agent loop: LOAD-BEARING               │
  │    fenced choice → MODEL picks within it       │
  │    by-construction beats by-prompt             │
  └────────────────────────┬───────────────────────┘
                           ▼
                   Block 4 — How it works
```

The skeleton is mapped — the rest of this file walks the mechanics that hang off it.

## How it works

**Mental model.** Two routers with opposite mechanisms. The first is a *static allow-list* applied before the model runs — like rendering only the buttons a role may click, the agent is built with only the tools it may use. The second is a *dynamic classifier* applied per request — like a `switch` that first tries a fast `string.includes` check and only falls back to an expensive lookup when the fast path is inconclusive.

```
ROUTING 1 — tool subset (static, by construction)    ROUTING 2 — intent (dynamic, per request)
──────────────────────────────────────────────       ──────────────────────────────────────────
allTools (~40) ──filterToolSchemas(allowed)──→        q="what changed?"
  monitoring  → monitoringTools  (~13)                  parseIntent(q)  ← heuristic, free, sync
  diagnostic  → diagnosticTools  (~17)                    includes('monitoring')? → 'monitoring'
  recommend.  → recommendationTools (~10)                 (in route.ts: classifyIntent → haiku)
  query       → queryTools (union of all three)         → QueryAgent.answer(q, intent)
the model only ever SEES its subset                   wrong tool impossible because subset-scoped
```

The first router decides *what the model can do*; the second decides *which agent does it*. The subset-scoping makes the wrong-tool failure structurally impossible for the specialist agents; the intent classifier picks the surface for the free-form path.

---

### Routing 1 — per-agent tool subsets (routing by construction)

The tool catalog declares one `const` array of tool *names* per agent. The monitoring subset lists the dashboard / trend / funnel / EQL tools a monitor needs; the diagnostic subset lists the investigation tools; the recommendation subset lists the scenario / segment / campaign tools a recommender needs.

```
per-agent name subsets
─────────────────────────────────────────────────────────────
 monitoringTools       list_dashboards, get_dashboard, list_trends,
                       ... execute_analytics_eql, get_customer_prediction_score
 diagnosticTools       execute_analytics_eql, get_funnel, get_event_segmentation,
                       ... list_customers, list_scenarios, get_catalog_item
 recommendationTools   list_scenarios, get_scenario, list_initiatives,
                       ... list_voucher_pools, get_frequency_policies
 queryTools            [...new Set([...monitoring, ...diagnostic, ...recommendation])]
```

Each agent passes its subset into the tool-schema filter when building the `toolSchemas` argument to the shared agent loop. The filter keeps only the tools whose names are in the subset and maps them to the provider SDK's `Tool[]` shape.

```
the tool-schema filter as a router
─────────────────────────────────────────────────────────────
 all (~40 McpToolDef) ──filter(allowed.has(name))──→ subset Tool[] ──→ params.tools
 the model's tool menu THIS turn = exactly the subset, nothing more
```

The consequence: when the diagnostic agent runs, `params.tools` contains only `diagnosticTools`. The model physically cannot emit a `tool_use` for `list_voucher_pools` because that tool is not in the array it was shown. This is routing by construction — the wrong choice is not blocked at runtime, it is *absent*. `queryTools` is the deliberate exception: the free-form agent gets the de-duplicated union of all three subsets because it must answer anything.

---

### Routing 2 — intent classification (heuristic-first, LLM-second)

The free-form `?q=` path needs to know whether a question is a monitoring ("what changed?"), diagnostic ("why?"), or recommendation ("what should I do?") request. The intent module provides two functions, layered.

The intent parser is a pure, synchronous heuristic: lowercase the string and substring-check for `'monitoring'`, `'recommendation'`, `'diagnostic'`, defaulting to `'diagnostic'`:

```
  function parse_intent(raw) -> Intent:
      t = lower(trim(raw))
      if t contains "monitoring":     return 'monitoring'
      if t contains "recommendation": return 'recommendation'
      if t contains "diagnostic":     return 'diagnostic'
      return 'diagnostic'   ← default
```

The intent classifier is the LLM fallback: a single cheap-tier call with `max_tokens: 16` and a system prompt that forces a one-word answer, then passed *back through the intent parser* to coerce the model's word into an `Intent`:

```
  async function classify_intent(provider_sdk, query):
      response = await provider_sdk.messages.create({
          model:      CLASSIFIER_MODEL,   # cheap tier
          max_tokens: 16,                  ← caps to one word
          system:     "Classify as exactly one word: monitoring|diagnostic|recommendation",
          messages:   [{ role: "user", content: query }],
      })
      return parse_intent(text_of(response))   ← heuristic coerces the model word
```

The ordering is the lesson. The intent parser is the heuristic layer (free, instant, no network); the intent classifier is the LLM layer (a real model call, but the cheapest/fastest model with a 16-token cap). In the route, the query path calls the intent classifier — and the classifier's output still flows through the intent parser, so the heuristic is the *normalizer* even on the LLM path. Heuristic at the front (and at the back, coercing the model's word), LLM in the middle for the hard cases the substring check cannot resolve.

---

### Where the two routers meet

The route wires both. The investigation path (`insightId`) does not classify — the chain order is fixed and `step`-gated (01-agents-vs-chains.md), so diagnostic (on `step=diagnose`) and recommendation (on `step=recommend`) each get their subset directly. The query path (`q && !insightId`) runs the intent classifier to pick the framing, then constructs a query agent whose tools are `queryTools` (the union). The intent does not change the tool set on the query path — the query agent always gets the union — it changes the *prompt framing* (the intent is injected into the system prompt). So the two routers compose: intent routing picks the surface and framing; subset-scoping bounds what each surface can do.

```
both routers, in the route handler
─────────────────────────────────────────────────────────────
 q only:        classify_intent(provider_sdk, q)        ← Router 2 (intent)
                QueryAgent.answer(q, intent)              tools = queryTools (union)
 step=diagnose: DiagnosticAgent.investigate(inv)         ← Router 1 (subset)
 step=recommend:RecommendationAgent.propose(inv, diag)     diag tools / rec tools
```

---

### The principle

**Narrow the decision space before the model decides.** Both routers do the same thing at different layers: they shrink the set of possibilities the model must choose among, so the model's choice is constrained to be correct-by-construction or routed to the right specialist. Subset-scoping removes wrong tools from existence rather than hoping the prompt discourages them; intent routing tries the free heuristic before paying for a model call. The unifying rule: the cheapest, most reliable way to prevent a wrong choice is to make the wrong choice unavailable — and the cheapest way to make a choice is to not use a model when a substring check suffices.

---

---

### Code in this codebase

**Case A — implemented.**

#### Per-agent tool subsets (Router 1)

- **File:** `lib/mcp/tools.ts`
- **Function / class:** `monitoringTools` / `diagnosticTools` / `recommendationTools` / `queryTools`
- **Line range:** L5–L13, L15–L25, L27–L34, L38–L40 (`queryTools` = de-duplicated union of all three)
- **Role:** The allow-list of tool names each agent may use; `bootstrapTools` (L50–L54) is the separate session-start discovery set.

#### The filter that applies the subset

- **File:** `lib/agents/tool-schemas.ts`
- **Function / class:** `filterToolSchemas`
- **Line range:** L9–L21; the filter at L15 (`set.has(t.name)`)
- **Role:** Keeps only allowed tools and maps them to `Anthropic.Messages.Tool[]`; the result becomes `params.tools` at `base.ts` L101.

#### Subset selection per agent

- **File:** `lib/agents/diagnostic.ts` L57 · `recommendation.ts` L52 · `monitoring.ts` L79 · `query.ts` L36
- **Function / class:** the `toolSchemas: filterToolSchemas(this.allTools, <subset>)` argument to `runAgentLoop`
- **Line range:** one line per agent
- **Role:** Binds each agent to its subset at the call site.

#### Intent classification (Router 2)

- **File:** `lib/agents/intent.ts`
- **Function / class:** `parseIntent` (heuristic) + `classifyIntent` (LLM)
- **Line range:** `parseIntent` L6–L12; `CLASSIFIER_MODEL` L14; `classifyIntent` L17–L31 (`max_tokens: 16` at L20; coerced through `parseIntent` at L30)
- **Role:** Maps a free-form query to one of `monitoring | diagnostic | recommendation`; heuristic first, haiku fallback, heuristic-as-normalizer at the end.

#### Where intent is consumed

- **File:** `app/api/agent/route.ts`
- **Function / class:** `GET` → query branch
- **Line range:** L210–L218 (`classifyIntent` at L211; `QueryAgent.answer(q, intent, ...)` at L214)
- **Role:** Calls the classifier, then runs the query agent with the chosen intent as prompt framing (intent injected at `query.ts` L28).

**Pseudocode — both routers** (`tools.ts` + `intent.ts` + `route.ts`):

```typescript
// ROUTER 1 — subset by construction (diagnostic.ts L57)
toolSchemas: filterToolSchemas(this.allTools, diagnosticTools)  // model sees only these

// ROUTER 2 — intent, heuristic-first (intent.ts)
function parseIntent(raw) {                                     // L6 — free heuristic
  const t = raw.trim().toLowerCase();
  if (t.includes('monitoring'))     return 'monitoring';
  if (t.includes('recommendation')) return 'recommendation';
  return 'diagnostic';                                          // default
}
async function classifyIntent(anthropic, query) {              // L17 — haiku fallback
  const res = await anthropic.messages.create({
    model: 'claude-haiku-4-5-...', max_tokens: 16, system: '...one word...' });
  return parseIntent(textOf(res));                             // L30 — heuristic normalizes
}
// route.ts L211: const intent = await classifyIntent(anthropic, q);
```

---

## Tool routing — diagram

The diagram spans three layers. The Route layer holds the intent classifier (Router 2). The Agent layer holds the subset selection (Router 1) per agent. The Provider boundary is where the curated tool array reaches the model. Both routers narrow the space before the model acts.

```
┌──────────────────────────────────────────────────────────────────────┐
│  ROUTE LAYER   app/api/agent/route.ts                                 │
│                                                                       │
│  q only ──→ ROUTER 2 (intent):                                       │
│              parseIntent(q)  ← heuristic (free)   intent.ts L6–12     │
│              classifyIntent  ← haiku, 16 tok      intent.ts           │
│              → QueryAgent.answer(q, intent)                           │
│  insightId ─→ fixed chain (no intent classify), step-gated:          │
│              step=diagnose → diagnostic · step=recommend → recommend  │
└───────────────────────────────┬───────────────────────────────────────┘
                                │ each agent selects its subset
┌───────────────────────────────▼───────────────────────────────────────┐
│  AGENT LAYER   lib/agents/  +  lib/mcp/tools.ts                       │
│                                                                       │
│  ROUTER 1 (subset, by construction):                                 │
│    allTools (~40) ──filterToolSchemas(all, <subset>)──→ scoped Tool[] │
│      monitoring  → monitoringTools     (~13)   tools.ts L5–13         │
│      diagnostic  → diagnosticTools      (~17)  tools.ts               │
│      recommend.  → recommendationTools  (~10)  tools.ts               │
│      query       → queryTools (union)          tools.ts               │
│                            │ params.tools = scoped subset│
└───────────────────────────────┬───────────────────────────────────────┘
                                │ the model sees ONLY its subset
┌───────────────────────────────▼───────────────────────────────────────┐
│  PROVIDER BOUNDARY   @anthropic-ai/sdk  ·  Bloomreach MCP             │
│  model can only emit tool_use for tools in the array it was shown     │
└──────────────────────────────────────────────────────────────────────┘
```

A reader who sees only this diagram should grasp: intent routing picks the surface, subset-scoping bounds what each surface can do, and the model never sees a tool outside its subset.

---

## Elaborate

### Where this pattern comes from

Tool scoping is the **principle of least privilege** applied to an agent: grant only the capabilities the task requires. It maps directly onto Anthropic's "Building effective agents" routing workflow, where an input is classified and directed to a specialized follow-up — except here the classification happens twice, once for tools (static) and once for intent (dynamic). The heuristic-before-LLM ordering is a long-standing systems instinct: do the cheap deterministic check first, escalate to the expensive probabilistic one only when needed. It is the same reason you validate a form field with a regex before calling a verification API.

### The deeper principle

There are two ways to prevent a wrong choice: *block it at decision time* (validate the model's tool call against a policy after it picks) or *remove it from the choice set* (never show the tool). The second is strictly more robust because it has no runtime path to fail — there is no "the validator had a bug" failure mode if the tool was never on the menu. blooming insights chooses removal (subset-scoping) over blocking. The same logic governs the intent router: rather than always paying for a model call, the cheap heuristic resolves the common, unambiguous cases, and the model is reserved for genuine ambiguity. Constrain first, compute second.

### Where this breaks down

Subset-scoping is a static partition — it cannot adapt if a diagnosis genuinely needs a tool that lives in `recommendationTools`. The partitions overlap deliberately (`execute_analytics_eql` is in both monitoring and diagnostic, `list_scenarios` in both diagnostic and recommendation) to soften this, but a query that needs a tool outside its agent's subset simply cannot run it; the agent must work around the gap or fail. The intent heuristic is brittle in the opposite way: `parseIntent` matches the literal substring `'monitoring'`, so a real user question like "what changed this week?" contains none of the keywords and falls through to the `'diagnostic'` default — which is why `classifyIntent` exists, but the haiku call adds latency and can still misclassify ambiguous questions.

### What to explore next

- **Semantic tool retrieval** — instead of static subsets, embed tool descriptions and retrieve the top-k relevant tools per query (a RAG-over-tools approach); the dynamic alternative to static partitioning (cross-link to ../03-retrieval-and-rag/).
- **Anthropic "Building effective agents" — Routing** — read the routing workflow and map blooming insights' two routers onto it.
- **Confidence-aware classification** — having `classifyIntent` return a confidence and only escalating to the model when the heuristic is low-confidence; tightens the heuristic-first ordering.

---

## Project exercises

### Confidence-gate the intent classifier to skip the haiku call

- **Exercise ID:** C1.9 (adapted to blooming insights)
- **What to build:** Make the query path call `parseIntent(q)` first; only fall through to `classifyIntent` (the haiku call) when the heuristic hits its `'diagnostic'` *default* (i.e., no keyword matched), so unambiguous keyworded queries skip the model call entirely.
- **Why it earns its place:** Demonstrates the heuristic-before-LLM ordering as a latency/cost optimization — a clean token-economics signal.
- **Files to touch:** `app/api/agent/route.ts` (L210–L214); optionally a `parseIntentConfident` helper in `lib/agents/intent.ts`.
- **Done when:** A query containing a keyword (e.g., "recommendation ideas") routes with zero model calls, and a keyword-free query still falls through to `classifyIntent`.
- **Estimated effort:** <1hr

### Route the query agent's tool subset by intent instead of always-union

- **Exercise ID:** C4.6 (adapted to blooming insights)
- **What to build:** Today `QueryAgent` always gets `queryTools` (the full union, `query.ts` L36). Use the classified `intent` to narrow the subset — a `'monitoring'` query gets `monitoringTools`, etc. — so intent routing controls *both* framing and the tool menu, not just framing.
- **Why it earns its place:** Shows you can compose the two routers — intent routing now drives subset-scoping — improving tool-selection accuracy on the free-form path.
- **Files to touch:** `lib/agents/query.ts` (L24, L36 — accept and apply the subset for the intent); `app/api/agent/route.ts` (pass intent through, L214); `test/agents/query.test.ts`.
- **Done when:** A `'monitoring'` query's `runAgentLoop` is handed only `monitoringTools`, verified by a unit test with a fake MCP, and a `'diagnostic'` query gets `diagnosticTools`.
- **Estimated effort:** 1–4hr

---

## Interview defense

### What an interviewer is really asking

"How do you keep the model from calling the wrong tool?" tests whether you reach for a prompt ("I tell it not to") or for construction ("the tool is not in the menu"). The senior answer is the latter. "How do you route a free-form query?" tests whether you default to a model call or know to try a cheap deterministic check first.

### Likely questions

**[mid] "How does the diagnostic agent avoid calling a recommendation-only tool?"**

It cannot call one — `diagnostic.ts` L57 passes `filterToolSchemas(this.allTools, diagnosticTools)`, so `params.tools` (`base.ts` L101) contains only diagnostic tools. A recommendation-only tool like `list_voucher_pools` is not in the array the model is shown, so there is no `tool_use` block it could emit for it. The prevention is structural, not prompt-based.

```
allTools (~40) ──filter(diagnosticTools)──→ ~17 tools shown
list_voucher_pools ∉ shown set → model cannot request it
```

**[senior] "Why try `parseIntent` before `classifyIntent` — isn't the model more accurate?"**

Because most queries are resolvable without a model. `parseIntent` is free, synchronous, and deterministic; `classifyIntent` is a network round-trip to haiku. For the cases the substring check resolves, paying for a model call is pure waste — added latency and tokens for no accuracy gain. The model is reserved for genuine ambiguity. And even on the model path, the output flows back through `parseIntent` (L30) to coerce a possibly-noisy word into a valid `Intent` — the heuristic is also the normalizer.

```
q ──parseIntent (free)──→ resolved?  ──yes──→ done (no model call)
                              │no
                              ▼
                          classifyIntent (haiku) ──parseIntent(normalize)──→ Intent
```

**[arch] "Your tool subsets are hand-maintained `const` arrays. When does that stop scaling?"**

When the catalog grows past a few dozen tools or the cross-subset needs become frequent. Hand-partitioning ~40 tools into three overlapping subsets is tractable; partitioning 300 tools is not, and a static partition cannot adapt when a diagnosis genuinely needs a tool from another subset. The migration is semantic tool retrieval: embed each tool's description, and per query retrieve the top-k relevant tools dynamically. The subset arrays become a fallback or a coarse pre-filter, not the whole router.

```
today:  static const arrays (3 overlapping subsets, ~40 tools)
scale:  embed tool descriptions → retrieve top-k per query (dynamic subset)
```

### The question candidates always dodge

**"What happens to 'what changed this week?' — does your intent router get it right?"**

Honestly: `parseIntent` gets it *wrong* on the heuristic path. The string contains none of `'monitoring'`/`'recommendation'`/`'diagnostic'`, so it hits the `'diagnostic'` default (`intent.ts` L11) — even though "what changed" is a monitoring question. That is exactly why `classifyIntent` exists: the haiku call reads the semantics, not the literal keywords, and returns `'monitoring'`. Candidates dodge this because admitting the heuristic misses real phrasing feels like a flaw; it is actually why the two-layer design exists — the heuristic is fast but literal, the model is the semantic backstop.

### One-line anchors

- `lib/mcp/tools.ts` L5–L34 — the three per-agent subsets; `queryTools` L38–L40 is their union.
- `lib/agents/tool-schemas.ts` L15 — `set.has(t.name)` — the filter that enforces the subset.
- `lib/agents/diagnostic.ts` L57 — `filterToolSchemas(this.allTools, diagnosticTools)` — subset binding.
- `lib/agents/intent.ts` L6–L12 — `parseIntent` — the free heuristic and the normalizer.
- `lib/agents/intent.ts` L17–L31 — `classifyIntent` — haiku fallback, `max_tokens: 16`.

---

## See also

→ 02-tool-calling.md · → 01-agents-vs-chains.md · → 06-error-recovery.md · → ../01-llm-foundations/ · → ../../study-system-design/06-multi-agent-orchestration.md

---
