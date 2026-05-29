# Agentic RAG

**Industry name(s):** Agentic RAG, retrieval-as-a-tool, ReAct-with-retrieval, dynamic retrieval loop
**Type:** Industry standard · Language-agnostic

> When the retriever is a tool the model calls inside a loop — and the model decides which query to run next based on what the last one returned — RAG stops being a pipeline step and becomes a control flow. blooming insights is the live-API form of this: every `execute_analytics_eql` call is the agent retrieving on-the-fly, and the next query depends on the last result.

**See also:** → 02-self-corrective-rag.md · → 03-retrieval-routing.md · → `../01-reasoning-patterns/02-react.md` · → why no embedding-RAG here: `../../study-ai-engineering/03-retrieval-and-rag/11-rag.md`

---

## Why care

You wrote a search box once. The user types, you `fetch('/search?q=' + query)`, the API returns ten rows, you render them. The shape is fixed: one query in, one batch out, render. If the answer isn't in those ten rows, the user types something different and tries again — *they* are the loop. The code does one round trip.

Now picture the same search box, but you put a model in the user's seat. The model reads the question, sends a query, reads the ten rows, and decides — based on what came back — whether to ask again with a different query or stop and answer. The number of round trips isn't fixed. The query on round 2 depends on what round 1 returned. The loop moved from the user into the code.

That second shape is the question this file answers: **when does retrieval stop being a one-shot pipeline step and start being a loop the agent drives?** Not "do you have RAG" — both shapes are RAG, both ground the model in retrieved context. The line is who decides the *next* retrieval call. In static RAG, your code decides (one query, one top-k, done). In agentic RAG, the model decides each next call as the loop runs.

**Why answering that question matters:** because the failure modes are different and you fix them at different layers. A static-RAG miss is a *retriever miss* — the top-k didn't contain the answer, you tune the embeddings, the chunk size, the reranker. An agentic-RAG miss is a *trajectory miss* — the model asked the wrong sequence of queries, or stopped too early, or never widened. You don't tune the index; you replay the agent's tool calls and find where the reasoning went off.

Without naming the boundary:
- A user asks "why did purchases drop?" — the diagnostic comes back wrong
- You assume the retrieval was bad and start tuning the chunker
- But there is no chunker — the retriever is a live EQL tool the model chose to call once with the wrong WHERE clause
- The fix is in the prompt or in the loop's stopping rule, not in an index that does not exist

With the boundary named:
- A user asks "why did purchases drop?" — the diagnostic comes back wrong
- You replay the agent's tool calls, see it ran one EQL and stopped, ask why
- The fix is "the model should have widened the window" or "should have asked one more query" — a loop-shape problem, not an index problem

One-line summary: **agentic RAG is a ReAct loop whose primary tool is retrieval — the model writes the query sequence at runtime instead of your code writing one query at build time.** Here's how that plays out when the retriever is a live API call rather than a vector index.

---

## How it works

**The mental model: a `.then()` chain whose length you don't know, where each link is a query.** Static RAG is `embed(q).then(topK).then(stuff).then(generate)` — four links, fixed. Agentic RAG is a `while` loop where each iteration reads the prior result, decides the next query, and either runs it or stops. The model writes the chain's length and shape at runtime — the same shape this codebase's chains-vs-agents file calls "the model writing the steps."

```
Two retrieval shapes side by side

  STATIC RAG (one shot)
  ──────────────────────────────────────────────────
  query → embed → top-k → stuff prompt → generate
            (code wrote each step; one round trip)

  AGENTIC RAG (a loop)
  ──────────────────────────────────────────────────
  query
    │
    ▼
  ┌─────────────────────────────┐
  │ model: pick next retrieval  │ ◄────────────┐
  └────────┬────────────────────┘              │
           ▼                                    │
  ┌─────────────────────────────┐               │
  │ retriever (tool call)       │               │
  └────────┬────────────────────┘               │
           ▼                                    │
  ┌─────────────────────────────┐               │
  │ model: enough to answer?    │               │
  └────┬───────────────┬────────┘               │
       ▼ no            ▼ yes                    │
   refine query     emit final answer           │
       └─────────────────────────────────────────┘
```

The strategy in plain English: **let the model write the query plan instead of writing it yourself.** When you know the query plan up front (one nearest-neighbor search, top-k), static RAG is correct and cheaper. When you don't — when the right query depends on what the last one returned — you hand the wheel to the model and pay the loop tax for the adaptability.

### The two shapes, side by side

The technical distinction: static RAG is one tool call; agentic RAG is many, chosen at runtime.

If you're coming from frontend, static RAG is `fetch('/search?q=' + q).then(render)`. Agentic RAG is `while (notDone) { const q = decideNext(prior); const r = await fetch('/search?q=' + q); prior.push(r); }` — except `decideNext` isn't your code, it's a model reading the prior results and emitting the next query string.

```
                Static RAG                       Agentic RAG
            ┌──────────────────┐             ┌──────────────────────┐
turns:      │ exactly 1        │             │ N (model decides)    │
retriever:  │ vector index     │             │ any tool: vector,    │
            │ (nearest chunks) │             │ SQL, web, live API   │
who picks   │ your code        │             │ the model            │
next call:  │ (top-k, k=10)    │             │ (each turn)          │
stop rule:  │ implicit (1 try) │             │ model emits no tool  │
cost:       │ 1× retriever +    │            │ N× retriever +       │
            │ 1× LLM           │             │ N× LLM (3-10× tokens)│
            └──────────────────┘             └──────────────────────┘
```

The practical consequence: the same user question can take a different number of retrievals on two different runs of an agentic system, because the model re-decides after every observation. That's the win (it adapts to multi-step questions) and the cost (variable latency, variable cost, a trajectory to replay when debugging).

The condition under which it works: the loop has to have a stop rule and a budget. Without one, "model decides" means "model can loop forever" — the same unbounded-`while` problem you'd never ship on the frontend. Every agentic-RAG implementation needs a tool-call cap, a turn cap, or both.

### The retriever is an interface, not an index

The reframe that matters: in agentic RAG, *retriever* is a slot. Anything that returns context for a query fills the slot. A vector index fills it (classic). A SQL query fills it (exact lookups). A web search fills it (freshness). **A live tool call against an analytics API fills it.** The agentic-RAG loop doesn't care which — it cares that the model can call a retriever and observe the result.

```
The retriever slot — anything that grounds a query goes here

    ┌─ retriever interface ─┐
    │  query → context      │
    └──────────────────────┘
        ▲       ▲      ▲       ▲
        │       │      │       │
    vector  SQL DB   web   live API
    index             search (this codebase)
```

If you're coming from frontend, this is the same shape as "the data layer is an interface" — your component doesn't care if `useUser()` reads localStorage, a cookie, or a `/api/me` fetch, as long as it returns a user. The agent loop doesn't care what `execute_analytics_eql` is under the hood, as long as it returns rows the model can reason on.

The practical consequence: the agentic loop shape generalizes across retriever types. You can drop a vector index in beside a live API and the model can route between them (covered in `03-retrieval-routing.md`). The loop's structure — reason, retrieve, observe, repeat — doesn't change.

### The "no embedding-RAG" case — why this codebase skipped the vector index

The technical thing: blooming insights does agentic retrieval without ever building an embedding index. The retriever is `execute_analytics_eql` against Bloomreach — a live tool call, not a nearest-neighbor lookup over chunked documents.

If you're coming from frontend, this is the difference between caching `/api/users` in localStorage at build time (snapshot, ages immediately) and just calling `/api/users` fresh every time (slower per call, always current). The codebase chose the second: no snapshot, no chunker, no vector store. The retriever is the live source.

```
Three things make the live retriever the right choice here

  property of the data       live tool        vector index
  ────────────────────       ──────────       ──────────────────
  freshness                  always current   stale until re-embed
  exactness (counts, $)      exact aggregate  fuzzy nearest-neighbor
  source IS an API           read directly    a lossy copy to maintain
```

The practical consequence: the agentic loop here is pure — every observation is fresh data, not a snapshot. The cost is per-call latency (an HTTP round trip to Bloomreach, ~1.1s spaced + execution time) instead of the millisecond reads of a local vector index. The codebase pays that cost on purpose because the alternative (a stale embedding of "42,000 purchases") would silently poison every downstream turn.

The condition under which this stays right: the data has to be a queryable API returning exact results. The day a feature needs to *search free-text narratives* (e.g. "find past investigations similar to this one"), the live-tool retriever is the wrong shape and an embedding index earns its place. The cross-reference file (`../../study-ai-engineering/03-retrieval-and-rag/11-rag.md`) walks that threshold rule end-to-end.

### The loop is a budget, not a freeway

The technical thing: the agentic-RAG loop has caps. `runAgentLoop` enforces `maxTurns` (default 8) and `maxToolCalls` (6 for monitoring/diagnostic/query, 4 for recommendation), and once the budget is spent the loop strips the tools from the next request, forcing the model to answer (`base.ts` L90–L101).

If you're coming from frontend, this is `useEffect` with a dependency array and an abort controller — a loop with an off-switch. Without it, you've shipped an infinite render loop the model drives.

```
runAgentLoop — the loop has two off-switches

  turn N:
    if (budget spent OR last allowed turn):
      strip tools from request   ← model MUST answer (no tool_use possible)
    call model with messages
    if (no tool_use blocks):     ← model decided to stop
      return finalText
    run each tool, append result as next user turn
```

The practical consequence: an agentic investigation never spends more than ~6 EQL calls. If the diagnostic agent can't reach a conclusion in 6 queries it's forced to synthesize from what it has — including "I couldn't establish a populated window" if that's the honest answer. The cost is occasional truncation; the win is a bounded latency budget the route's `maxDuration = 300` can sit on top of.

The principle: an agentic loop without a cap is a runaway. The cap is what makes the adaptability cost-controlled instead of unbounded.

The full picture is below.

---

## Agentic RAG — diagram

```
blooming insights: agentic retrieval over a live API

  user question
       │
       ▼
  ┌─────────────────────────────────────────────────────────────────┐
  │                       AGENT LAYER                                │
  │                  (runAgentLoop, base.ts L85)                     │
  │                                                                  │
  │   turn 0  ┌───────────────────┐                                  │
  │           │ model reasons      │                                 │
  │           │ "check volume"     │                                 │
  │           └────────┬───────────┘                                 │
  │                    ▼ tool_use                                    │
  │           ┌───────────────────────────────────────┐              │
  │           │ execute_analytics_eql(eql=...)        │              │
  │           └────────┬──────────────────────────────┘              │
  │                    ▼  observation fed back (base.ts L171)        │
  │   turn 1  ┌───────────────────┐                                  │
  │           │ model: "purchases  │  ◄── result of turn 0 in        │
  │           │ down 18%; compare  │      context window             │
  │           │ revenue too"       │                                 │
  │           └────────┬───────────┘                                 │
  │                    ▼ tool_use                                    │
  │           ┌───────────────────────────────────────┐              │
  │           │ execute_analytics_eql(eql=...)        │              │
  │           └────────┬──────────────────────────────┘              │
  │                    ▼                                              │
  │   turn 2  ┌───────────────────┐                                  │
  │           │ model: no tool_use │ ──► natural stop (base.ts L121) │
  │           │ → emits JSON       │                                 │
  │           └───────────────────┘                                  │
  │                                                                  │
  │   BUDGET: maxTurns=8, maxToolCalls=6 → forced final (L90)        │
  └─────────────────────────┬───────────────────────────────────────┘
                            │
                            ▼
  ┌─────────────────────────────────────────────────────────────────┐
  │                       RETRIEVER LAYER                            │
  │   McpClient.callTool → execute_analytics_eql → Bloomreach        │
  │   (live API; no vector index, no chunks, no embeddings)          │
  └─────────────────────────────────────────────────────────────────┘

  The loop length is variable — the model writes it. The retriever
  is a live API call. The cap is a budget the route's 300s window
  sits on.
```

---

## In this codebase

**The loop**
**File:** `lib/agents/base.ts`
**Function / class:** `runAgentLoop()`
**Line range:** L48–L176 (loop body L85; tool_use detection L116–L124; observation fed back L171; budget/forced-final L90–L101)

This is the agentic-RAG engine. All four agents (`monitoring.ts`, `diagnostic.ts`, `recommendation.ts`, `query.ts`) call this one function. The retriever isn't named in this file — it's whichever tool the model chooses, hidden behind the `McpCaller` interface (L16–L22).

**The retriever**
**File:** `lib/mcp/tools.ts`
**Function / class:** the `execute_analytics_eql` tool schema
**Line range:** the EQL tool definition

The retriever-as-tool. The model emits `tool_use` with `name: "execute_analytics_eql"` and `input: { eql: "..." }`; the loop runs it via `mcp.callTool` (`base.ts` L144) and feeds the JSON result back as the next observation. No vector index sits behind this — it's a live HTTP call into Bloomreach.

**The budget**
**File:** `lib/agents/diagnostic.ts` / `monitoring.ts` / `query.ts` / `recommendation.ts`
**Function / class:** each agent's `runAgentLoop` invocation
**Line range:** the `maxToolCalls` argument per agent (6 for monitoring/diagnostic/query; 4 for recommendation)

The cap that turns adaptability from "unbounded" into "bounded." Each agent declares how many tool calls it gets before the loop forces a final answer.

```
shape (not full impl):
  // base.ts L85 — the agentic-RAG loop
  for (let turn = 0; turn < maxTurns; turn++) {
    const res = await anthropic.messages.create({ tools, messages });
    const toolUses = res.content.filter(b => b.type === 'tool_use');
    if (toolUses.length === 0) return { finalText, toolCalls };  // model stops
    for (const tu of toolUses) {
      const { result } = await mcp.callTool(tu.name, tu.input); // RETRIEVE
      toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: ... });
    }
    messages.push({ role: 'user', content: toolResults });       // observe
  }
```

---

## Elaborate

### Where this pattern comes from

The "retrieval as a tool inside a loop" idea grew out of two lines: the ReAct paper (2022) framed reasoning and acting as an interleaved loop where one of the acts could be search, and the early Self-RAG (2023) and FLARE (2023) papers added per-step retrieval triggers to the generation. The synthesis — *agentic RAG* — came with the wider adoption of tool-use APIs (OpenAI functions, Anthropic tool_use), which made "the model calls the retriever" a first-class API shape instead of a parsing exercise.

### The deeper principle

Retrieval-augmented generation has two layers worth seeing separately: the *augmentation* (the model is grounded in external context) and the *control* (who decides what to retrieve). Static RAG fixes the control in code; agentic RAG hands it to the model. Neither is "more advanced" — they're a tradeoff between predictability (static) and adaptability (agentic), and the right choice depends on whether the query plan is knowable up front.

```
  knowable query plan ──► code owns retrieval (static) ──► cheaper, predictable
  unknowable plan     ──► model owns retrieval (agentic)──► adaptive, variable cost
```

### Where this breaks down

The agentic loop breaks in three places. **No stop rule** → the model loops until budget exhaustion on questions it could have answered in one query. **Bad retriever** → adaptability can't fix a tool that returns wrong answers; the model just makes wrong follow-up queries faster. **Trajectory non-determinism** → two runs of the same question can take different paths and produce different answers, which is fine for users but painful for evals; you need trajectory-level eval, not just answer eval.

### What to explore next
- Self-corrective RAG (`02-self-corrective-rag.md`) → adding a relevance grader between retrieve and generate
- Retrieval routing (`03-retrieval-routing.md`) → multiple retrievers and the model picks
- ReAct mechanics (`../01-reasoning-patterns/02-react.md`) → the loop shape this sits on
- Why no embedding-RAG here: `../../study-ai-engineering/03-retrieval-and-rag/11-rag.md` → the live-tool vs vector-index decision walked end-to-end

---

## Tradeoffs

The decision was *which retriever fills the slot* — a live tool call (chosen) or a pre-built embedding index (the textbook answer for RAG).

┌──────────────────┬─────────────────────────────┬─────────────────────────────┐
│ Cost dimension   │ Live-tool agentic RAG       │ Embedding-index agentic RAG │
│                  │ (chosen)                    │ (alternative)               │
├──────────────────┼─────────────────────────────┼─────────────────────────────┤
│ Freshness        │ always current              │ stale until re-embedded     │
│ Exactness        │ exact aggregates (counts,$) │ fuzzy nearest-neighbor      │
│ Per-call latency │ ~1.1s spaced + HTTP RTT     │ ~10ms vector lookup         │
│ Build time       │ zero — the API exists       │ chunker + embedder + index  │
│                  │                             │ + incremental indexing      │
│ Ops burden       │ none beyond the API itself  │ keep the index in sync with │
│                  │                             │ a source that changes       │
│ Per-query cost   │ Bloomreach quota (~1 req/s) │ embedder cost + storage     │
│ Debuggability    │ replay tool calls, see the  │ harder: was the chunk in    │
│                  │ exact EQL the model ran     │ top-k? was it relevant?     │
│ Trajectory shape │ N model + N HTTP rounds      │ N model + N vector lookups  │
│ Failure blast    │ rate-limit error visible    │ silent stale read → wrong   │
│                  │ and retryable               │ answer downstream           │
└──────────────────┴─────────────────────────────┴─────────────────────────────┘

### What we gave up

We gave up per-retrieval speed. A vector lookup is milliseconds; an EQL round trip is a second or more, plus the 1100 ms spacing gate in `lib/mcp/connect.ts` L92. Over a 6-call diagnostic, that's most of the wall-clock budget — the route's 300s `maxDuration` exists because the retrieval *is* the latency.

We also gave up the ability to retrieve from data we don't have a live API for. If the codebase ever needed to search free-text narratives (past investigations, past chat logs), the live tool covers none of that surface — an embedding index would have to be added beside it (cross-ref: `../../study-ai-engineering/03-retrieval-and-rag/11-rag.md`).

### What the alternative would have cost

If we had built an embedding index of analytics data, the day-one cost would have been the chunker + embedder + vector store + incremental indexing pipeline (essentially everything in `study-ai-engineering`'s `03-retrieval-and-rag/` files 01–10). The ongoing cost would have been *correctness*: an embedded snapshot of "42,000 purchases" is a fuzzy nearest-neighbor point, not the number — the agent would answer with a vibe, not a count, and worse, every downstream turn would inherit the lossy read. The fix would have been to re-embed constantly, which means paying both for retrieval *and* for a freshness pipeline that does the live read anyway.

### The breakpoint

This stays the right call until a feature's retrieval can't be expressed as a single API query — when the retriever needs to do "find narratives semantically similar to this anomaly" or "find past investigations that mentioned similar evidence." That's free-text search over content this codebase doesn't have a queryable API for, and it's the day an embedding index earns its place beside the live tool.

### What wasn't actually a tradeoff

"Just stuff the whole workspace into the context window" was not a real alternative. A Bloomreach workspace has years of events, millions of rows — orders of magnitude beyond any context window. Even if it fit, the lost-in-the-middle problem would dominate, and you'd be paying full-input price on every turn to re-send data the model can read directly. The retrieval loop isn't a compromise; it's what makes the question answerable at all.

---

## Tech reference

### Anthropic Messages API (tool use)

- **Codebase uses:** `anthropic.messages.create({ tools, messages })` in `runAgentLoop` (`lib/agents/base.ts` L102); the loop reads `res.content` for `tool_use` blocks (L116) and emits `tool_result` blocks (L161) on the next turn.
- **Why it's here:** the tool_use round-trip IS the agentic-RAG loop. Every retrieval is a `tool_use` block; every observation is a `tool_result` block.
- **Leading today:** Anthropic tool use — innovation-leading for agentic loops, 2026.
- **Why it leads:** native structured tool calls make the loop a first-class API shape instead of a parsing exercise; the model emits typed call blocks the loop dispatches without prompt-engineering its way out of free text.
- **Runner-up:** OpenAI function calling / Responses API — same loop shape, larger installed base.

### MCP (Model Context Protocol)

- **Codebase uses:** `lib/mcp/client.ts` wraps the MCP transport; `lib/mcp/tools.ts` declares the tool schemas (`execute_analytics_eql` and friends) the agents hand to Claude.
- **Why it's here:** MCP standardizes how the agent talks to the retriever. The tool is defined once in MCP-shape and reused across all four agents.
- **Leading today:** MCP — adoption-leading for cross-agent tool definitions, 2026.
- **Why it leads:** decouples the tool from the agent — a tool defined once is usable across agents and across clients (Claude Desktop, IDE plugins, server agents) without re-integration.
- **Runner-up:** per-agent direct tool definitions — simpler for a one-off agent, doesn't compose across agents or clients.

### Bloomreach Analytics EQL

- **Codebase uses:** the EQL string the model emits as the `eql` argument to `execute_analytics_eql`; recipes in `lib/agents/categories.ts` (the monitoring checklist) and prompt-level guidance in `lib/agents/prompts/*.md`.
- **Why it's here:** EQL is the live retriever's query language. It IS the API the agentic-RAG loop calls; the model generates EQL the way an agentic-RAG-over-SQL system would generate SQL.
- **Leading today:** EQL — domain-specific for Bloomreach Engagement; not a general retrieval standard.
- **Why it leads:** native to Bloomreach, expresses aggregates and windows directly — the model can ask exact analytics questions in one query that would take many lookups against a vector index.
- **Runner-up:** raw event export + SQL — more general, requires building the warehouse and the EQL→SQL semantics yourself.

---

## Summary

Agentic RAG is the shape where retrieval becomes a tool the model calls inside a loop — the model writes the query sequence at runtime instead of your code writing one query at build time. blooming insights is this shape, with one specific choice that matters: the retriever is a live API (`execute_analytics_eql` against Bloomreach via MCP) rather than an embedding index. The agent loop (`runAgentLoop`, `lib/agents/base.ts` L48–L176) drives reason → tool_use → observe → repeat until the model stops naturally (no tool_use block, L121) or the budget caps it (L90–L101). The cost is per-call latency (~1.1s spaced HTTP round trip per retrieval); the win is exact, always-current, schema-correct results no embedding could match for analytics.

- Agentic RAG = ReAct loop whose primary tool is a retriever; the model writes the query plan at runtime.
- The retriever is an interface — a vector index, a SQL query, a web search, or a live API call all fill the slot.
- blooming insights fills the slot with a live MCP tool, so there is no vector store, no chunker, no embedding pipeline.
- The loop has caps (`maxTurns`, `maxToolCalls`) — without them, "model decides" means "model loops forever."
- The right shape only as long as the data is a queryable API; free-text narrative search would push back toward embeddings.

---

## Interview defense

### What an interviewer is really asking
When an interviewer asks "do you use RAG," they're testing whether you can distinguish the *augmentation* (the model is grounded in external context) from the *retriever* (the thing that returns the context). The strong signal is naming what fills the retriever slot in your system and why, not reciting the vector-index pipeline as if it's the only option. The weak signal is saying "we use RAG" or "we don't use RAG" without naming what the retriever actually is.

### Likely questions

[mid] Q: Does blooming insights use RAG?

A: Yes, in the agentic form — every agent loop in this codebase is RAG where the retriever is a live tool call (`execute_analytics_eql`) instead of a vector index. The model emits a `tool_use` block, the loop runs the EQL against Bloomreach, the result comes back as `tool_result` in the next turn, and the model reasons on it. That's retrieval-augmented generation; we just skipped the embedding index because the data is a queryable analytics API where exact aggregates matter and embeddings would be lossy and stale.

Diagram:
```
  query → model picks EQL → execute_analytics_eql → result
            (tool_use)        (live API, no index)   (tool_result)
                  └─────── loop until model stops ────────┘
```

[senior] Q: Why not build an embedding index over the analytics data?

A: Three reasons. **Freshness** — Bloomreach data changes; an index would be stale until re-embedded and we'd need an incremental indexing pipeline to keep up with a source we can just query. **Exactness** — an embedding of "42,000 purchases" is a fuzzy nearest-neighbor point, not the number. Analytics answers need counts and sums, not vibes. **Burden** — building chunker + embedder + vector store + incremental indexing solves a problem we don't have, because the source IS a queryable API. The threshold that would flip this is a feature that searches free-text narratives — past investigations, past chats — where exact aggregates don't apply and semantic match does. We don't have that feature; the day we do, an embedding index goes in beside the live tool.

Diagram:
```
  property of the data    live tool          embedding index
  freshness               always current     stale until re-embed
  exactness               exact aggregate    fuzzy nearest-neighbor
  source IS an API        read directly      a lossy copy to maintain
```

[arch] Q: At 10x the question volume, what changes in this retrieval loop?

A: The retriever, not the loop. The agentic loop scales horizontally — each user's investigation is its own `runAgentLoop`. The bottleneck is Bloomreach's per-user rate limit (~1 req/s, the `minIntervalMs: 1100` in `lib/mcp/connect.ts` L92). At 10x volume, two things compound: same user investigating in parallel hits the limit harder (the rate-limit retry in `client.ts` L122 burns budget), and many users sharing the limit means I'd need a real backpressure queue (cross-ref: `../05-production-serving/02-fan-out-backpressure.md`) instead of per-instance spacing. The loop itself doesn't change; the layer beneath it does. If exactness ever stopped mattering — analytics dashboards instead of investigations — I might pre-compute common queries into a cache and the agent retrieves from the cache, which starts to look like an index.

Diagram:
```
  ┌ Agent layer (runAgentLoop ×N) ── fine, horizontal ──────┐
  ┌ Retriever layer (MCP → Bloomreach) ◄── BOTTLENECK:      │
  │                                       ~1 req/s/user      │
  └ Fix: cross-run cache + real backpressure queue ──────────┘
```

### The question candidates always dodge
Q: If retrieval is a live API call and there's no index, in what sense is this "RAG" at all? Isn't this just tool-calling?

A: The honest answer is that *RAG and tool-calling overlap once the tool is a retriever*. The textbook RAG diagram (chunk → embed → top-k → stuff) is one *implementation* of retrieval-augmented generation, not the definition. The definition is "ground the answer in retrieved context"; the retriever is anything that returns context for a query. When the tool is a retriever (an EQL query, a SQL query, a web search), the loop IS agentic RAG — it just happens to share its shape with tool-calling because they're the same shape. What this codebase doesn't do is the *embedding-index* part of classic RAG. It still does the *retrieve-then-ground* part on every turn. The reason I won't call it "just tool-calling" is that the tool's job is specifically retrieval, the retrieval grounds the answer, and the loop adapts the next retrieval to the prior result — that's the agentic-RAG control loop, regardless of what fills the retriever slot.

Diagram:
```
  classic RAG     │ vector index + top-k + stuff + generate
  agentic RAG     │ a LOOP whose tool happens to be a retriever
  this codebase   │ agentic RAG, retriever = live API call
  "just tools"    │ same shape; agentic RAG is a NAMED USE of it
```

### One-line anchors
- "Agentic RAG is a ReAct loop whose primary tool is the retriever — the model writes the query plan."
- "The retriever is an interface; vector indexes, SQL, web search, and live APIs all fill it."
- "We retrieve live because the source is a queryable API with exact aggregates and freshness mattering — embeddings would be lossy and stale."
- "The loop's stop rule is the budget (`maxToolCalls`); without it, 'model decides' means 'model loops forever.'"

---

## Validate your understanding

### Level 1 — Reconstruct the diagram
Close this file. Draw the two shapes side by side: static RAG (one-shot pipeline) on the left, agentic RAG (the loop) on the right. Under "agentic RAG," draw the retriever as a slot and label what fills it in this codebase.

Open the file. Compare.

✓ Pass: you drew the loop with `reason → tool_use → observe → repeat`, labelled the retriever slot as `execute_analytics_eql` / live API / no vector index, and put the stop rule (no `tool_use` block or `maxToolCalls`) somewhere
✗ Fail: re-read How it works, wait 10 minutes, try again

### Level 2 — Explain it out loud
A colleague who knows static RAG asks: "wait, is this even RAG if there's no vector store?" No notes. Under 90 seconds.

Checkpoints — did you:
- Define RAG as "retrieve, then ground the answer," not as "embed and stuff"?
- Name what fills the retriever slot here (`execute_analytics_eql` against Bloomreach via MCP)?
- Name the loop's stop rule (model emits no `tool_use`, or `maxToolCalls` budget)?
- Say at least one reason embeddings would be the wrong retriever for this data (freshness, exactness, or "source is an API")?

If you skipped any: you described it, you didn't understand it.

### Level 3 — Apply it to a new scenario
A new feature ships: "let users ask 'have we seen this pattern before?' against past investigations stored as free-text narratives." Without opening the codebase: is this still the live-tool retriever, or does this push the retriever back toward an embedding index? What would you change in `runAgentLoop`, and what would you add alongside?

Write your answer (4–6 sentences). Then open `lib/agents/base.ts` L48–L176 and check whether the loop body itself would change — or only what `mcp.callTool` resolves to.

### Level 4 — Defend the decision you'd change
"If you were building this today and you had to give up either the live tool retriever OR the agentic loop (keep one, kill the other), which goes? What does the system look like in the version you kept, and what does it stop being able to answer?"

Reference the code: point to `lib/agents/base.ts` L85 (the loop) and `lib/mcp/tools.ts` (the retriever-as-tool), and describe what each shape covers alone.

### Quick check — code reference test
Without opening any files:
- What file holds the agentic-RAG loop and what function?
- What's the tool name the model calls to retrieve from Bloomreach?
- What two caps stop the loop from running forever, and where do they live in `base.ts`?

Open and verify. ✓ File + function names matter; line numbers drifting is fine.

---
Updated: 2026-05-29 — created
