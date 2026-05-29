# Routing

**Industry name(s):** Routing, intent classification, dispatcher pattern, LLM-as-router, hybrid heuristic + LLM router
**Type:** Industry standard · Language-agnostic

> Pick the right handler before committing to a loop. blooming insights uses a heuristic-first then LLM-second router for free-form `?q=` queries — and this is the BRIDGE to multi-agent: the same pattern that picks a tool inside one agent picks an agent across many.

**See also:** → 01-chains-vs-agents.md · → 02-react.md · → mechanics: `../../study-ai-engineering/04-agents-and-tool-use/04-tool-routing.md` · → capability gating: `../../study-ai-engineering/04-agents-and-tool-use/07-capability-gating.md` · → multi-agent: `../../study-system-design-dsa/01-system-design/06-multi-agent-orchestration.md`

---

## Why care

You've built this in React without thinking of it as routing. The user types into a search box: `/products`, `Add a todo: buy milk`, `What's my balance?`. Your code looks at the prefix: `/` → command palette, `Add a todo:` → todo creator, anything else → search the docs. You wrote a small ladder of `if (input.startsWith('…'))` that decides *which feature handles the input* before any feature runs. The feature itself doesn't decide whether it should run — the router decides for it.

Now picture the user typing free-form English: "what changed in revenue last quarter?" There's no `/` prefix to grep for, no fixed command. Your `if`-ladder runs out of conditions. You need something smarter: read the meaning, pick the handler. You can either teach the code more rules (regex, keyword lists, scoring), or you can hand the decision to a model.

That's the question this file answers: **how do you pick the right handler for an input before committing to it, when the handlers are different (different prompts, different tools, different budgets, sometimes different agents entirely)?** And then the harder one: **how do you split that decision between cheap-deterministic and expensive-LLM so you don't pay the LLM cost on inputs you could have routed for free?**

**Why answering that question matters:** because routing is the bridge from one-agent thinking to multi-agent thinking. The same `if`-then-fallback shape that picks a *tool* inside a single ReAct loop picks an *agent* in a multi-agent system. If you understand the router's two-layer shape (heuristic first, LLM second), you understand the supervisor pattern in SECTION C. If you skip the routing step, you either run every agent on every input (wasteful) or you pick one agent statically (wrong sometimes).

Without naming the routing layer:
- User types "what changed last week?" → straight to DiagnosticAgent
- DiagnosticAgent's prompt is "investigate this anomaly" — but there's no anomaly
- The model freelances; the answer is shallow or hallucinated
- You blame the prompt, but the bug was at the dispatch — wrong agent for the input

With the routing layer:
- User types "what changed last week?" → classify intent
- "what changed" → MonitoringAgent intent → route to QueryAgent under that intent
- QueryAgent's tool subset matches the question; the answer grounds
- The fix was in the dispatch, not the prompt

One-line summary: **a router is the dispatcher in front of your agent set — same shape as URL routing in your app, except the route is decided from natural-language intent and the destinations are agents.** Here's how that splits between heuristic and LLM in this codebase.

---

## How it works

**The mental model: a two-stage funnel — fast/deterministic for the obvious cases, model-decided for the ambiguous ones.** Stage 1 is keyword or rule matching that catches the easy 70–90% of inputs at zero LLM cost. Stage 2 is a small/cheap LLM call that handles the rest. Together they keep average latency low while still covering the long tail.

```
The two-stage router

  input ─► ┌──────────────────────────┐
           │ Stage 1: heuristic        │ regex, keyword, prefix —
           │ deterministic, ~0 cost    │ deterministic, free
           └──────────┬───────────────┘
                      │ confident match?
              ┌───────┴────────┐
              ▼ yes            ▼ no
            ROUTE            ┌──────────────────────────┐
                             │ Stage 2: LLM classifier  │ cheap model,
                             │ small output (1 word)    │ ~$0.0001/call
                             └──────────┬───────────────┘
                                        ▼
                                      ROUTE
```

The strategy in plain English: **let the cheapest layer that can answer the question, answer it.** Heuristics answer the obvious cases for free. The LLM answers the ambiguous ones for a small fixed cost. Neither layer is trying to be "the router" — they're tiers of a single decision.

### Move 2.1 — The heuristic layer

The technical thing: a deterministic function from input to label (or `null` if no confident match). Usually regex, substring, or rule-based. No model call.

If you're coming from frontend, this is the URL parser at the front of every web app. `/products/123` matches `^/products/([0-9]+)$`; if it matches, you know the route is "product detail" with id 123 without consulting any service. The router itself does no business logic.

```
Heuristic router — pseudocode shape

  function parseIntent(raw):
    t = raw.lower().trim()
    if t includes "monitoring"  → return "monitoring"
    if t includes "recommendation" → return "recommendation"
    if t includes "diagnostic"   → return "diagnostic"
    return null  // or a default; nothing matched
```

The practical consequence: every input the heuristic matches is free routing. Latency is sub-millisecond, no API call, no rate limit. The price you pay is *coverage*: a heuristic can only catch what its rules anticipate. New phrasings the rules don't recognise fall through.

The condition under which it works: the heuristic's confidence has to be calibrated. A heuristic that matches on substring "recommendation" routes any input mentioning the word — including "I don't need a recommendation, just tell me…" That over-matching is fine when the next layer (LLM) can correct it, dangerous when the heuristic is the only layer.

### Move 2.2 — The LLM layer

The technical thing: a small/cheap model called with a constrained system prompt that says "classify the input as one of N labels, output the label only." Output is parsed into one of the expected categories.

If you're coming from frontend, this is asking a server-side function "given this user query, which feature should handle it?" — except the server-side function is a model and "which feature" is one of a fixed list. The model's job is *interpretation*, not generation.

```
LLM classifier — shape, not impl

  POST /messages {
    model: 'claude-haiku-4-5',                ← cheap model
    max_tokens: 16,                            ← tiny output budget
    system: "Classify the user query as exactly one word:
             monitoring (what changed / what is new),
             diagnostic (why did something happen),
             recommendation (what should I do).
             Reply with ONLY the one word.",
    messages: [{ role: 'user', content: query }],
  }
  → "diagnostic"
```

The practical consequence: the LLM call is fast (small max_tokens, cheap model) but it's still an API call — adds ~200–500ms and tiny token cost. Worth it for ambiguous inputs where a heuristic would miss; not worth it for inputs the heuristic already catches.

The condition under which it works: the classifier has to be reliable enough that downstream agents trust its label. Two things help: (a) constrain the output to one word so parsing is trivial, and (b) provide a `parseIntent` fallback (the same heuristic) on the model's output text — so even if the model adds prose, "the answer is monitoring" still parses as `monitoring`.

### Move 2.3 — Where this routing lives in the codebase

The technical thing: a heuristic `parseIntent` function (`lib/agents/intent.ts` L6–L12) and an LLM-backed `classifyIntent` function (L17–L31) that runs the Haiku call and then runs its output back through `parseIntent` to extract the label.

If you're coming from frontend, the structure is: `parseIntent` is the URL parser; `classifyIntent` is the wrapper that asks "you weren't a clean URL — what did you mean?" and then runs the answer through the URL parser again to normalize. The fallback in `parseIntent` (`return 'diagnostic'`) is the default route when nothing matched.

```
The two functions in this repo — lib/agents/intent.ts

  parseIntent(raw): Intent                    ← deterministic, L6–L12
    if raw.toLowerCase() includes "monitoring"    → 'monitoring'
    if raw.toLowerCase() includes "recommendation"→ 'recommendation'
    if raw.toLowerCase() includes "diagnostic"    → 'diagnostic'
    return 'diagnostic'  // default

  classifyIntent(anthropic, query): Promise<Intent>  ← LLM, L17–L31
    res = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',           ← L14
      max_tokens: 16,
      system: '...classify... one word...',
      messages: [{ role: 'user', content: query }],
    })
    return parseIntent(extractText(res))            ← reuse the heuristic!
```

The practical consequence: the LLM call exists only on the `?q=` path (free-form question). The investigation flow (`?insightId=…`) skips routing entirely — the route knows it's a diagnosis regardless of words. Routing is paid for only when the input is genuinely ambiguous.

The condition under which it works: the heuristic and LLM agree on the output vocabulary (`'monitoring' | 'diagnostic' | 'recommendation'`). They both produce the same labels because `classifyIntent` parses the LLM's text through `parseIntent` — so anything the LLM emits gets normalized to one of three values. There's no third label vocabulary to maintain.

### Move 2.4 — Where the routing fires (and where it doesn't)

The technical thing: the route handler at `app/api/agent/route.ts` only invokes `classifyIntent` on the free-form query path. The investigation path uses code-deterministic dispatch (the `if`-ladder from `01-chains-vs-agents.md`).

```
Where routing fires — app/api/agent/route.ts

  GET /api/agent?q=...      ← free-form question
    │
    ▼  L199–L218
  classifyIntent(anthropic, q)            ← THE LLM ROUTER FIRES HERE
    │                                       (cheap haiku call)
    ▼
  new QueryAgent(...).answer(q, intent)   ← intent flows INTO the agent's prompt

  GET /api/agent?insightId=...&step=...   ← investigation flow
    │
    ▼  L224–L249
  if step === 'recommend' → RecommendationAgent
  else                    → DiagnosticAgent (then RecommendationAgent)
    │
    NO LLM ROUTER — the chain layer's if-ladder is the dispatcher
```

The practical consequence: classification cost is paid only when needed. Investigations don't pay because the route already knows which agent runs (it's encoded in `?step=`). Free-form questions pay one Haiku call (~1 cent of cost, ~200–500ms latency) because the question text is the only signal we have.

The condition under which it works: the heuristics-then-LLM split is *appropriate to the input distribution*. If most free-form questions could be heuristic-matched (e.g. they reliably start with "what is" or "why did"), you could front-load more matches in `parseIntent` and skip the LLM call entirely. The current `parseIntent` does almost no work on raw user input (it only matches when the input literally contains the word "monitoring", etc.) — most real questions fall through to `classifyIntent`. That's the explicit cost choice: pay the small LLM cost rather than build/maintain a brittle keyword classifier.

### Move 2.5 — Why this is the bridge to multi-agent (the load-bearing insight)

The technical thing: in a single-agent system, the router picks a *tool* — "is this query best answered by the SQL tool or the search tool?" In a multi-agent system, the same router-shape picks an *agent* — "is this query best answered by the diagnostic agent or the recommendation agent?" Same code shape, different destinations.

If you're coming from frontend, the lift from "URL routing inside an app" to "API gateway routing across services" is the same lift. You're using the same pattern (parse → dispatch) at a higher level of abstraction. The router doesn't care whether the destination is a function in the same process or a service across the network.

```
The same shape, two levels of granularity

  Single-agent (this repo's QueryAgent loop):
  ┌────────────────────────────────────────────────────┐
  │ inside one ReAct loop, the MODEL picks the next     │
  │ tool from a list (execute_analytics_eql, …)         │
  │ — that's tool routing, mediated by the model        │
  └────────────────────────────────────────────────────┘

  Multi-agent (this repo's GET /api/agent?q=):
  ┌────────────────────────────────────────────────────┐
  │ before any loop, the ROUTER picks which agent runs  │
  │ (Monitoring / Diagnostic / Recommendation / Query)  │
  │ — that's agent routing, mediated by haiku + heuristic│
  └────────────────────────────────────────────────────┘

  Both are "given an input, pick a handler."
  The granularity scales; the pattern stays.
```

The principle: **routing is the abstraction that bridges single-agent and multi-agent.** A single-agent system has a router picking tools (often the model itself, inside ReAct). A multi-agent system has a router picking agents (often a supervisor, sometimes a classifier). The supervisor pattern in SECTION C is "this router, with the destinations being agents that each have their own ReAct loop." Once you see the router shape, the multi-agent supervisor stops being a new concept — it's the router at a higher level.

The full picture is below.

---

## Routing — diagram

```
The router in blooming insights — and what it bridges to

  ┌─ Free-form query path (`?q=...`) ──────────────────────────────┐
  │                                                                 │
  │  user query                                                     │
  │      │                                                          │
  │      ▼                                                          │
  │  ┌─────────────────────────────────────┐                       │
  │  │ classifyIntent (intent.ts L17–L31)  │ ← THE ROUTER          │
  │  │   model: claude-haiku-4-5            │                       │
  │  │   prompt: "one word: monitoring /    │                       │
  │  │            diagnostic / recommendation"│                      │
  │  │   then: parseIntent(text)            │ ← deterministic       │
  │  │         (intent.ts L6–L12)            │   normalizer           │
  │  └────────────────┬────────────────────┘                       │
  │                   │ Intent label                                 │
  │                   ▼                                              │
  │  ┌─────────────────────────────────────┐                       │
  │  │ QueryAgent.answer(q, intent)         │ ← intent flows INTO   │
  │  │   (prompt is templated on intent)    │   the prompt           │
  │  └─────────────────────────────────────┘                       │
  └─────────────────────────────────────────────────────────────────┘

  ┌─ The bridge to multi-agent ────────────────────────────────────┐
  │                                                                 │
  │  Today: classifyIntent picks an INTENT, the QueryAgent runs.    │
  │  Tomorrow: classifyIntent could pick AN AGENT and dispatch:     │
  │                                                                 │
  │    "what changed last week"   → MonitoringAgent.scan()           │
  │    "why did revenue drop"     → DiagnosticAgent.investigate()    │
  │    "what should I do"         → RecommendationAgent.propose()    │
  │                                                                 │
  │  Same router shape, destinations are agents instead of an        │
  │  intent string. This is the supervisor pattern in SECTION C.    │
  └─────────────────────────────────────────────────────────────────┘
```

---

## In this codebase

**The heuristic-first layer**
**File:** `lib/agents/intent.ts`
**Function / class:** `parseIntent(raw: string): Intent`
**Line range:** L6–L12

Three substring checks against the lowercased input, with a `'diagnostic'` default at L11. Used both as the fast-path heuristic AND as the normalizer on the LLM classifier's output.

**The LLM classifier layer**
**File:** `lib/agents/intent.ts`
**Function / class:** `classifyIntent(anthropic, query): Promise<Intent>`
**Line range:** L17–L31 — model `claude-haiku-4-5-20251001` (L14), `max_tokens: 16` (L20), constrained system prompt at L21–L23, text extracted at L26–L29, run through `parseIntent` at L30.

**Where the router fires**
**File:** `app/api/agent/route.ts`
**Function / class:** the `GET` handler's free-form query branch
**Line range:** L210–L218 — `classifyIntent` called at L211, intent flowed into `QueryAgent.answer(q, intent)` at L214. Routing does NOT fire on the investigation path (L224–L249); that path uses the deterministic `if`-ladder per `01-chains-vs-agents.md`.

**The destination — QueryAgent uses the intent in its prompt**
**File:** `lib/agents/query.ts`
**Function / class:** `QueryAgent.answer(query, intent, hooks)`
**Line range:** L24–L48 — intent is templated into the system prompt at L28 (`replace(/\{intent\}/g, intent)`), shaping the agent's behavior for the classified intent.

```
shape (not full impl):
  // route.ts: free-form query path
  if (q && !insightId) {
    const intent = await classifyIntent(anthropic, q);                  // L211
    stepFor('coordinator', 'thought',
            `interpreting your question as a ${intent} query…`);         // L212
    const queryAgent = new QueryAgent(anthropic, conn.mcp, schema, allTools);
    const answer = await queryAgent.answer(q, intent, hooksFor('coordinator')); // L214
    // …
  }
```

---

## Elaborate

### Where this pattern comes from

Routing is older than LLMs — it's the dispatcher pattern from object-oriented programming and the controller pattern from web frameworks, retrofitted for natural-language inputs. The hybrid heuristic-then-LLM shape came from production teams in 2023–2024 noticing that "use the LLM for everything" was expensive and "use rules for everything" was brittle. The pattern that stuck: rules for the cases you understand, LLM for the cases that are genuinely ambiguous, normalize both into the same label vocabulary.

### The deeper principle

Cheap layers should handle obvious cases. The router is one expression of a broader principle — **layer your decision-makers by cost, not by capability** — that shows up across software: cache before DB, validation before business logic, CDN before origin. The LLM is the most expensive layer in your stack, so it should answer only the questions cheaper layers couldn't.

```
   Cheapest layer that can answer       Most expensive layer
   ┌────────────────┐                  ┌────────────────┐
   │ heuristics      │ ────skip────►   │ LLM classifier  │
   │ (free, fast)    │  if confident   │ (cheap, slower) │
   └────────────────┘                  └────────────────┘
            └─── normalize through the same parser ──┘
```

### Where this breaks down

When the input distribution shifts (new users, new phrasings) and the heuristic's coverage degrades silently, you don't notice until quality drops — which is why heuristics need monitoring just like models do. When the label vocabulary expands (more intents added), the LLM classifier's accuracy can drop unless the prompt is retrained or the model is upgraded. When the destination agents start needing inputs the router doesn't pass through, the router becomes a bottleneck for cross-cutting context. When the router itself is wrong on a high-stakes case, the wrong agent runs and the error is hard to attribute (was the agent bad, or did the router send it the wrong job?).

### What to explore next
- `01-chains-vs-agents.md` → the route's `if`-ladder (the OTHER router-shape in this codebase) is code-deterministic dispatch; routing here is the model-mediated cousin
- `02-react.md` → inside a single agent, tool selection is itself a routing decision the model makes per turn
- `../../study-ai-engineering/04-agents-and-tool-use/04-tool-routing.md` → the mechanics of tool-level routing (deterministic vs LLM-decided), this codebase angle is the *placement* in the agent dispatch
- Multi-agent supervisor (when written): the router's destinations become whole agents; the shape is the same

---

## Tradeoffs

The decision here was *to use heuristic-first with LLM fallback for the free-form `?q=` path, and skip routing entirely on the investigation path*. The alternative most teams reach for is "LLM router for everything" or "no router, one agent handles everything."

┌──────────────────┬─────────────────────────────┬─────────────────────────────┐
│ Cost dimension   │ Heuristic + LLM (chosen)    │ LLM-only / no-router        │
│                  │                             │ alternatives                │
├──────────────────┼─────────────────────────────┼─────────────────────────────┤
│ Per-input cost   │ 0 for heuristic matches,    │ LLM-only: always 1 LLM      │
│                  │ 1 small LLM call otherwise  │ call; no-router: every      │
│                  │                             │ agent runs blind             │
│ Latency          │ ~0ms for hits, ~200–500ms   │ LLM-only: always 200–500ms; │
│                  │ for LLM fallback             │ no-router: pays full         │
│                  │                             │ wrong-agent latency on miss  │
│ Build time       │ 2 functions in intent.ts;   │ LLM-only: simpler (one      │
│                  │ a "default" branch in       │ function); no-router: simplest│
│                  │ parseIntent                 │ but biggest debugging cost  │
│ Debugging        │ trace shows classified      │ LLM-only: same; no-router:  │
│                  │ intent + reasoning_step      │ have to figure out from     │
│                  │ event before agent runs     │ the answer which agent ran  │
│ Failure mode     │ ambiguous input → LLM may   │ LLM-only: LLM down → no      │
│                  │ misclassify; bound by 1     │ routing; no-router: wrong   │
│                  │ word vocab                  │ agent runs, wrong tools,    │
│                  │                             │ wrong answer                │
│ Bridge to multi- │ same shape lifts to agent   │ LLM-only: same; no-router:  │
│ agent             │ routing                     │ doesn't generalize           │
│ Vocabulary drift │ heuristic must update for   │ LLM-only: prompt update;    │
│                  │ new intents; LLM prompt too │ no-router: nothing to update│
└──────────────────┴─────────────────────────────┴─────────────────────────────┘

### What we gave up

We gave up the simplicity of a single-layer router. With two layers (heuristic + LLM), there are two places intents are defined — `parseIntent` at L6–L12 and the classifier's system prompt at `intent.ts` L21–L23 — and they need to stay aligned. A new intent type means adding a substring check, updating the prompt, and (probably) a code change to add a new `Intent` type. That's the cost of keeping the heuristic.

We also gave up the option of using the LLM router for cross-cutting context — the Haiku call at `intent.ts` L17–L31 only sees the query string, not the user's prior history, the workspace's tracked KPIs, or whether the user has open insights. A more sophisticated router could use that context to pick better, at higher cost.

### What the alternative would have cost

If we had built an LLM-only router (no heuristic), every `?q=` would pay one Haiku call even for trivially-routable queries — small cost individually but real at scale. If we had built no router at all and just used the QueryAgent for everything, the agent's tool set is already the union of all agents' tools (`lib/mcp/tools.ts` L38–L40: `queryTools = [...new Set(monitoringTools + diagnosticTools + recommendationTools)]`), so it'd technically work — but the model would have to pick from a much larger tool list per turn (worse choices), and the answers would lose the intent-specific shaping the prompt template at `query.ts` L28 provides via `{intent}`.

### The breakpoint

This stays the right call until either (a) the heuristic's coverage drops noticeably because user phrasings shift away from the simple substring matches, or (b) the intent vocabulary grows past ~5 categories (at which point the substring approach becomes brittle and a small fine-tuned classifier or embeddings-based router becomes cheaper to maintain). Until then, three substring checks and one Haiku call is right-sized.

### What wasn't actually a tradeoff

A regex-only router (no LLM at all) was not a real alternative for free-form questions. The space of how users phrase "what should I do about this drop" is too varied to enumerate as regex, and the cost of misrouting (running the wrong agent with the wrong tools) is bigger than the cost of one Haiku call. So "ditch the LLM router and use only regex" was never a credible path — the question was only "where to put the regex" (as a fast-path heuristic), not "should we have the LLM at all."

---

## Tech reference (industry pairing)

### claude-haiku-4-5 (the classifier model)

- **Codebase uses:** `claude-haiku-4-5-20251001` at `lib/agents/intent.ts` L14, `max_tokens: 16`. Called only once per free-form query (no caching for queries since they're free-form text).
- **Why it's here:** classification is a small, well-bounded task — pick one of three labels — that doesn't need the larger model's depth. Haiku is fast and cheap and the output is parsed back through `parseIntent` so any phrasing variation is normalized.
- **Leading today:** Haiku-class small models (Claude Haiku, GPT-4o-mini, Gemini Flash) — adoption-leading for cheap classification calls, 2026.
- **Why it leads:** sub-second latency, sub-cent cost, structured-output prompts that constrain output to one word work reliably enough that downstream code can treat the label as data.
- **Runner-up:** an embedding-based classifier (compute one embedding, nearest-neighbor against labeled centroids) — cheaper per call at scale, requires building a labeled training set this codebase doesn't have.

### parseIntent (the deterministic normalizer)

- **Codebase uses:** `parseIntent` at `lib/agents/intent.ts` L6–L12 — three substring checks plus `'diagnostic'` default. Used both as the fast-path heuristic AND as the output normalizer for `classifyIntent`.
- **Why it's here:** dual role — it's the cheap layer for inputs that happen to use the canonical words, AND the safety net for the LLM's output (so even "I think this is a monitoring query" parses to `'monitoring'`). A single function maintained in one place.
- **Leading today:** rule-first / LLM-fallback routing — adoption-leading for production agent dispatch, 2026.
- **Why it leads:** combines the cost characteristics of rules with the coverage of an LLM; the LLM handles the long tail while rules handle the obvious cases.
- **Runner-up:** pure LLM routing — simpler code, higher per-call cost; pure rules — cheapest but coverage degrades silently as user phrasings shift.

### Next.js Route Handler (where dispatch actually happens)

- **Codebase uses:** `app/api/agent/route.ts` GET handler — `q && !insightId` branch at L210–L218 fires `classifyIntent` and dispatches to `QueryAgent`. Investigation branch at L224–L249 does deterministic `if`-ladder dispatch (no LLM router).
- **Why it's here:** the route handler is the single seam where "which path runs" is decided — it co-locates the LLM router call, the agent construction, and the streaming output.
- **Leading today:** Next.js App Router handlers — adoption-leading for full-stack TS endpoints, 2026.
- **Why it leads:** same handler can stream NDJSON, run async LLM calls, and dispatch to typed agent constructors — no separate server framework required.
- **Runner-up:** dedicated FastAPI / Hono router — more explicit, more control; cost is a separate deployment.

---

## Summary

Routing is the dispatcher pattern applied to natural-language inputs — pick the right handler before committing to it, with a cheap-then-expensive layer split. In this codebase, the free-form `?q=` path uses `parseIntent` (heuristic, `lib/agents/intent.ts` L6–L12) as the fast path AND as the output normalizer for `classifyIntent` (LLM, `lib/agents/intent.ts` L17–L31, Haiku model). The investigation path (`?insightId=…`) does NOT use this router; it dispatches deterministically via the route's `if`-ladder. The constraint that made this right is cost-per-input: a Haiku classifier costs ~$0.0001 per call, far less than running the wrong agent and producing a bad answer, but worth saving on inputs the heuristic can match. The cost is two intent vocabularies to keep aligned (the heuristic's substrings and the LLM prompt's labels).

- Two-layer router: `parseIntent` (heuristic, deterministic) then `classifyIntent` (Haiku, LLM-decided) — both produce the same `Intent` vocabulary.
- The LLM call only fires on the free-form `?q=` path; investigations use the route's `if`-ladder (the chain layer).
- The heuristic is reused TWICE: as the fast-path matcher AND as the normalizer on the LLM's text output.
- Routing is the bridge from single-agent (tool routing inside a loop) to multi-agent (supervisor picking agents) — same shape, scaled up.
- Worth it while three substring checks + one Haiku call covers the space; promote to a richer classifier when the intent vocabulary grows past ~5 categories.

---

## Interview defense

### What an interviewer is really asking
When an interviewer asks about routing, they're testing whether you understand that *how you pick a handler* is its own design decision — separate from what each handler does. The strong signal is naming the two layers, knowing where each fires, and being able to say why the LLM call only happens on one path. The weak signal is "I send everything to the LLM" or "I just check keywords."

### Likely questions

[mid] Q: How do you decide which agent runs for a given user input?

A: It depends on the input path. For `?insightId=…` (the investigation flow), the route's `if`-ladder at `app/api/agent/route.ts` L224–L249 picks the agent deterministically based on the `?step=` query param — no LLM involved. For `?q=…` (free-form questions), there's a two-stage router in `lib/agents/intent.ts`: a heuristic `parseIntent` (L6–L12) that matches obvious keywords, and `classifyIntent` (L17–L31) that calls Haiku to classify ambiguous inputs as `monitoring | diagnostic | recommendation`. The classified intent is passed into `QueryAgent.answer(q, intent, …)` at `route.ts` L214 and templated into the agent's system prompt.

Diagram:
```
   ?insightId=… ──► if-ladder (deterministic, no LLM)
                    DiagnosticAgent or RecommendationAgent

   ?q=…         ──► parseIntent → matched? route
                    └── no? ──► classifyIntent (Haiku)
                                  → parseIntent (normalize)
                                  → QueryAgent.answer(q, intent)
```

[senior] Q: Why use Haiku for the classifier instead of Sonnet — and why have a heuristic layer at all?

A: Two reasons for Haiku: it's ~10x cheaper than Sonnet per call, and classification doesn't need Sonnet's depth — one-of-three with a 16-token output is well within Haiku's capability. Two reasons for the heuristic: (1) free routing for inputs that contain the literal intent words, and (2) the heuristic is reused as the *normalizer* on the LLM's output (`classifyIntent` calls `parseIntent` on whatever text Haiku returns), so the same function plays the fast-path role AND the safety-net role. Without the heuristic, the LLM's text output would need its own parser; with the heuristic, both layers agree on the vocabulary.

Diagram:
```
   Without two-layer router:        With two-layer router:
   every q → Sonnet classifier      keyword hit → route (free)
   ~50ms × $0.003/k tokens          else → Haiku (~200ms, ~$0.0001)
                                     either way: parseIntent normalizes
```

[arch] Q: This router only fires on one path. At a higher volume of free-form questions, would you change anything?

A: Yes — three things in order. First, add caching on `classifyIntent`: identical-or-near-identical queries hit Haiku once per cache TTL, not every call. Second, watch the heuristic-hit-rate metric — if it's < 5%, the heuristic is dead weight and I'd drop it; if it's > 50% I'd front-load more rules. Third, if the intent vocabulary grows (say to 8 categories with new analytical task types), replace the substring heuristic + Haiku classifier with an embedding-based router (one embedding compute, nearest-neighbor against labeled centroids) — that scales better than maintaining a longer prompt or longer substring list.

Diagram:
```
   Today (low volume):           At scale:
   parseIntent  + classifyIntent  parseIntent (if hit rate is high)
   no caching, no metrics          + embedding classifier
                                   + cache on input hash / embedding
                                   + drift detection on hit rate
```

### The question candidates always dodge
Q: Why not just have one big agent with all the tools and let the model figure out what to do? Why route at all?

A: Honest answer: because the QueryAgent *already is* that big agent (its `queryTools` set at `lib/mcp/tools.ts` L38–L40 is literally the union of every other agent's tools), and the routing step still earns its keep because of *prompt shape*. The intent label flows into the QueryAgent's system prompt as `{intent}` (`lib/agents/query.ts` L28) and shapes the agent's behavior — it knows whether the user wants "what changed" or "why did it happen" or "what should I do" *before* it picks its first tool. Without the intent, the agent has to figure that out from the query text itself on every turn. The routing step costs one Haiku call (~$0.0001) and saves the QueryAgent from having to re-derive the intent on every reasoning step. Skipping the router would be a true short-cut, but it'd push the classification cost into every Sonnet turn instead of paying it once up front in Haiku.

Diagram:
```
   With router (this repo):              Without router (the suggestion):
   Haiku classifies once → Intent label  every QueryAgent turn:
   QueryAgent prompt: "{intent} query"   Sonnet implicitly classifies
   loop runs with intent-shaped prompt   from the query string while
                                          also picking the next tool

   1 Haiku call up front + cheaper        N Sonnet turns where each
   Sonnet turns ("act on intent")          turn re-derives intent
```

### One-line anchors
- "Two layers: heuristic for the easy cases, Haiku for the long tail — both normalize through the same `parseIntent`."
- "The router fires only on the free-form `?q=` path; investigations use the route's `if`-ladder, which is the chain layer's dispatch."
- "Routing is the bridge to multi-agent — same shape that picks a tool in one agent picks an agent across many."
- "Pay the classification cost once in Haiku up front, save it from being re-derived on every Sonnet turn downstream."

---

## Validate your understanding

### Level 1 — Reconstruct the diagram
Close this file. Draw the two-stage router from memory: heuristic (deterministic) first, LLM fallback second, both normalizing through the same parser. Then sketch where this router fires in `app/api/agent/route.ts` (the `?q=` branch) and where it does NOT fire (the `?insightId=` branch).

Open the file. Compare.

✓ Pass: you have the two stages, you label the heuristic as deterministic and the LLM as Haiku, you correctly mark the `?q=` path as the one with the router and the investigation path as the one without
✗ Fail: re-read Move 2.3 and Move 2.4, wait 10 minutes, try again

### Level 2 — Explain it out loud
Explain "how do you route user input to the right agent" to a colleague who just asked. No notes. Under 90 seconds.

Checkpoints — did you:
- Name the two files? → `lib/agents/intent.ts` (the classifier), `app/api/agent/route.ts` (where it fires)
- Say why the heuristic exists alongside the LLM call (free routing for the easy cases + normalizing the LLM's output)?
- Name the model used for classification and why? → Haiku, because classification doesn't need Sonnet's depth
- Say why the investigation flow doesn't use this router (`?step=` already encodes the agent choice)?

If you skipped any: you described it, you didn't understand it.

### Level 3 — Apply it to a new scenario
A product manager asks: "Can we add a fourth intent — 'comparative analysis', like 'compare this quarter vs last year' — and route those queries to a new agent we're building?" Without looking at the file: which files would you touch, in what order, and what would break if you only touched one of them?

Write your answer (3–5 sentences). Then open `lib/agents/intent.ts` (the `Intent` type at L3, the `parseIntent` at L6–L12, and the classifier prompt at L21–L23) and `app/api/agent/route.ts` L210–L218 to confirm what dispatch would need to change.

### Level 4 — Defend the decision you'd change
"If you were starting today expecting 100x the free-form query volume, would you still use the heuristic + Haiku two-stage router, or replace it with an embedding-based classifier? Why? If you'd switch, what new file would exist in `lib/agents/` and what would the heuristic still cover?"

Reference the code: point to `lib/agents/intent.ts` L17–L31 for the current Haiku call and describe what the embedding classifier would do differently (one embedding compute + nearest-neighbor, no LLM call per input).

### Quick check — code reference test
Without opening any files:
- What file holds the heuristic + LLM router, and what are the two functions called?
- What model does the LLM classifier use, and why that one?
- On which URL pattern does the router fire, and on which does it NOT?

Open and verify. ✓ Files + function names + the path-firing rule matter; line numbers drifting is fine.

---
Updated: 2026-05-29 — created
