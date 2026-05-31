# Routing

**Industry name(s):** Routing, intent classification, dispatcher pattern, LLM-as-router, hybrid heuristic + LLM router
**Type:** Industry standard · Language-agnostic

> Pick the right handler before committing to a loop. blooming insights uses a heuristic-first then LLM-second router for free-form `?q=` queries — and this is the BRIDGE to multi-agent: the same pattern that picks a tool inside one agent picks an agent across many.


---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Routing in blooming insights lives at the seam between the Route handler and the Pipeline coordinator — and it spans an orthogonal intent-parsing band that sits alongside the request flow. The Route reads `?q=` or `?step=`, hands the free-text query to `parseIntent` in `lib/agents/intent.ts` (a `String.includes` heuristic, no LLM), and the Pipeline coordinator uses the result to pick which agent runs. This is a *cheap-deterministic-first* router; the LLM-classifier escalation that other codebases use sits in the same slot but doesn't fire here.

```
  Zoom out — where routing lives

  ┌─ Route handler ─────────────────────────────────┐
  │  app/api/agent/route.ts (reads ?q= / ?step=)     │
  └─────────────────────────┬────────────────────────┘
                            │  raw query string
  ┌─ Intent parsing ────────▼────────────────────────┐  ← we are here
  │  ★ parseIntent (lib/agents/intent.ts) ★          │
  │  String.includes heuristic — no LLM call          │
  │  (escalation slot for LLM-classifier: empty)      │
  └─────────────────────────┬────────────────────────┘
                            │  routed intent
  ┌─ Pipeline coordinator ──▼────────────────────────┐
  │  lib/agents/pipeline.ts picks the agent          │
  └─────────────────────────┬────────────────────────┘
                            │
  ┌─ Per-agent definitions ─▼────────────────────────┐
  │  monitoring | diagnostic | recommendation | query │
  └──────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question is: how do you pick the right handler for an input before committing to it — and how do you split the decision between cheap-deterministic and expensive-LLM so you don't pay the LLM cost on inputs you could route for free? In blooming insights, the answer is one tier today (`String.includes`) with an empty escalation slot above it — an LLM classifier would slot in only when the heuristic stops being accurate enough. Below, you'll see the two-layer router shape and which tier blooming insights actually runs.

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

## Implementation in codebase

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

## See also

→ 01-chains-vs-agents.md · → 02-react.md · → mechanics: `../../study-ai-engineering/04-agents-and-tool-use/04-tool-routing.md` · → capability gating: `../../study-ai-engineering/04-agents-and-tool-use/07-capability-gating.md` · → multi-agent: `../../study-system-design-dsa/01-system-design/06-multi-agent-orchestration.md`

---
Updated: 2026-05-29 — created
Updated: 2026-05-30 — Migrated to study.md v1.47 template (Phase 1+2 mechanical): removed Tradeoffs / Tech reference / Summary sections; renamed "In this codebase" → "Implementation in codebase"; moved See also to a bottom block. "Why care" preserved pending Phase 3 (Zoom out, then zoom in + LAYERS diagram) authoring.
Updated: 2026-05-30 — Phase 3 of study.md v1.47 migration: replaced "Why care" block with "Zoom out, then zoom in" (LAYERS diagram + zoom-in paragraph) per format.md.
