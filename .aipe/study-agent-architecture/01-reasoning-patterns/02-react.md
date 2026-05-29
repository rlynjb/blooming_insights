# ReAct

**Industry name(s):** ReAct (Reason + Act), Thought–Action–Observation loop, tool-use agent loop
**Type:** Industry standard · Language-agnostic

> The baseline single-agent shape — reason, call a tool, read the result, repeat. blooming insights runs this one loop (`runAgentLoop`) under four different prompts; everything fancier is an escalation away from it.

**See also:** → 01-chains-vs-agents.md · → 03-plan-and-execute.md · → 04-reflexion-self-critique.md · → 06-routing.md · → mechanics: `../../study-ai-engineering/04-agents-and-tool-use/03-react-pattern.md` · → tool routing: `../../study-ai-engineering/04-agents-and-tool-use/04-tool-routing.md`

---

## Why care

You've written this in React without thinking about it: a `useEffect` that fires a `fetch`, reads the response, and decides what to render or fetch next. The first request returns a user, you check `user.isPremium`, then you fire a second request for billing data, then you check whether the bill is overdue and maybe fire a third for the payment history. You did not predeclare "this view runs three fetches in this order" — each fetch's result decided whether the next one even happened.

Now picture handing that decision to the model. The model emits a "call this tool with these args" block. Your code runs the tool. You feed the result back. The model looks at the result and either calls the next tool or stops and writes the answer. Same shape as your effect — read result, decide next call — except *the model is writing the chain at runtime.*

That shape has a name and it is the question this file answers: **what is the default single-agent loop, and when do you escalate past it?** Not "what is ReAct mechanically" — that's already covered in `../../study-ai-engineering/04-agents-and-tool-use/03-react-pattern.md`. This file places ReAct in the family of reasoning patterns: ReAct is the baseline, plan-and-execute / reflexion / Tree-of-Thoughts are escalations from it, and the strong prior is to *start at ReAct and only move when a measured failure justifies it.*

**Why answering that question matters:** because every agent project drifts toward something fancier than it needs. A team measures one failure ("the agent retries the same dead query"), reaches for multi-agent or self-critique because the names sound more capable, and pays the 2–5x cost for a fix a tighter ReAct prompt would have delivered. Naming where you sit on the escalation ladder is how you stop paying for capability you didn't measure a need for.

Without the ladder named:
- A diagnostic comes back shallow
- "Let's add a critic" / "let's add a planner" — code grows
- The shallowness was actually the prompt not naming the period-over-period method strictly enough
- You shipped a critic loop that runs every time and burns 2x tokens on a fix one prompt line would have made

With the ladder named:
- A diagnostic comes back shallow
- Did the model pick wrong tools (ReAct prompt issue) or did it never plan past one query (plan-and-execute might earn its keep)?
- Most of the time the answer is "tighten the prompt and you're done"

One-line summary: **ReAct is a `useEffect` whose `fetch` calls and stopping condition are decided by the model — and `runAgentLoop` is the one such loop blooming insights re-runs under four different prompts.** Here's how that loop sits as the baseline and what the escalations are.

---

## How it works

**The mental model: a `while` loop the model drives, with your code as the runtime.** The model returns a message that either says "call tool X with these args" or "I'm done, here's the answer." Your code runs the tool, feeds the result back into the next request, and re-asks. The loop ends when the model emits no tool call — or when your code yanks the tools away to force a final answer.

```
The baseline loop — model writes the chain at runtime

   ┌──── userPrompt ────┐
   │                    ▼
   │        ┌───────────────────┐
   │        │ model.create({    │
   │        │   tools, messages │ ◄────┐
   │        │ })                │      │
   │        └─────────┬─────────┘      │
   │                  │                 │
   │                  ▼                 │
   │     ┌─────────────────────────┐   │
   │     │ any tool_use blocks?    │   │
   │     └────┬───────────────┬────┘   │
   │       no │           yes │        │
   │          ▼               ▼        │
   │      RETURN          run tools,   │
   │      finalText       push results─┘
   └─────────────────────────────────────
```

The strategy in plain English: **interleave reason and act in one loop, no planner up front, no critic on the back.** The model's "reasoning" is the text it writes around its tool call; the act is the tool call; the observation is the tool result you pass back. There's no separate plan phase deciding the route, and no critic re-reading the answer. One actor, one budget, one stopping condition.

### Move 2.1 — The shape of one turn

The technical thing: a single Messages-API turn that returns a mix of `text` and `tool_use` content blocks. The agent runtime treats `tool_use` blocks as side-effects to execute and `text` blocks as the streamed "thinking."

If you're coming from frontend, think of one turn as one request/response pair in a long-poll: the request carries the full conversation so far plus the tool schemas, and the response is either "here's a tool call, run it for me" or "here's the final text." There is no streaming reasoning hidden inside one turn — every external action is its own visible turn.

```
One turn — what enters and leaves

  IN:   messages so far + tools schema + system prompt
        ▼
  ┌──────────────────────────────────────┐
  │  model.messages.create               │
  └──────────────────────────────────────┘
        ▼
  OUT:  content blocks
        ├─ text: "let me check purchase volume first"
        └─ tool_use: { name: "execute_analytics_eql",
                       input: { eql: "select count …" } }
```

The practical consequence: the model's emitted `tool_use` block IS the agent's choice of next action. Your runtime doesn't parse free text to figure out what to call — the SDK gives you a typed block. (`lib/agents/base.ts` L116–L124: filter `tool_use` blocks; zero blocks = "I'm done.")

The condition under which it works: the model is told what tools exist via the `tools` parameter and they have to actually be supplied. Strip the tools from the request and the model literally cannot emit a `tool_use` block — that's the escape hatch the forced-final turn uses.

### Move 2.2 — The loop body

The technical thing: a bounded `for` loop that re-calls the model until either (a) it returns zero `tool_use` blocks, or (b) the turn budget is exhausted, or (c) the per-loop tool-call budget is exhausted.

If you're coming from frontend, this is `for (let i = 0; i < n; i++) await tick()` where each `tick` reads the previous tick's output and decides whether to keep ticking. The model owns the "should I tick again" decision via the presence/absence of a tool call.

```
runAgentLoop body — base.ts L85–L172

  for (turn = 0; turn < maxTurns; turn++):
    forceFinal = (turn == maxTurns-1) OR (toolCalls >= maxToolCalls)   ← L90–L91
    res = anthropic.messages.create({
      tools: forceFinal ? OMITTED : toolSchemas,                       ← L101
      system: forceFinal ? system + synthesisInstruction : system,
      messages,
    })
    messages.push({ role: 'assistant', content: res.content })          ← L105
    if no tool_use blocks → return {finalText, toolCalls}               ← L121
    for each tool_use:
      result = await mcp.callTool(name, args)                            ← L144
      append tool_result to next user turn                                ← L161
    messages.push({ role: 'user', content: tool_results })                ← L171
```

The practical consequence: the model decides each next call by looking at the *whole history* — every prior tool call and result is in `messages`. That's why a ReAct loop can adapt: turn 4's choice is informed by turns 1–3's observations. (It's also why the loop scales token cost with depth — the context grows on every turn.)

The condition under which it works (and the safety rail): the `for` loop is bounded. `maxTurns` defaults to 8 (`lib/agents/base.ts` L73). The per-agent `maxToolCalls` is the tighter bound that actually fires: 6 for monitoring/diagnostic/query, 4 for recommendation (`lib/agents/monitoring.ts` L101, `diagnostic.ts` L62, `recommendation.ts` L57, `query.ts` L41). Without these, a misbehaving model could loop until the API or rate limit cut it off.

### Move 2.3 — The forced final turn (the escape hatch)

The technical thing: when the budget is spent, the next call is made *without* the `tools` parameter, plus a `synthesisInstruction` appended to the system prompt. With no tools available, the model cannot emit a `tool_use` block — it has to write a final answer. This is the difference between "ReAct that might hang" and "ReAct with a guaranteed terminal."

If you're coming from frontend, this is the `AbortController` of the loop: not a kill, but a "you must produce output now" signal. The model's only legal move is text.

```
Forced-final mechanics — base.ts L90–L101

  Normal turn:                       Forced-final turn:
  ┌───────────────────────┐          ┌───────────────────────────┐
  │ params = {            │          │ params = {                 │
  │   system,             │          │   system: system + "\n\n"  │
  │   messages,           │          │           + synthesisInstr,│
  │   tools: toolSchemas, │          │   messages,                │
  │ }                     │          │   (NO tools)               │
  └───────────────────────┘          │ }                          │
   model: may call tool             └───────────────────────────┘
   or write text                     model: must write text
```

The practical consequence: the loop has a hard ceiling. Each agent's `synthesisInstruction` literally tells the model "you have NO more tool calls" and points at the required output shape (a JSON object for diagnostic, a JSON array for recommendation, prose for query). The trace shows this as a final turn with no tool calls — that's the forced one.

The condition under which it works: only when a `synthesisInstruction` is provided. Without one, the forced-final turn just removes tools but doesn't change the prompt, and the model often produces an apology ("I would need to query more data…") instead of an answer. That's why every agent in this repo supplies one.

### Move 2.4 — Why this is the baseline

Now the escalation framing. ReAct is the cheapest agent loop that does real work: one model per turn, one budget, one stopping condition. Everything else in this folder is a structural addition *on top of* ReAct that adds cost in exchange for one specific failure mode it fixes.

```
The escalation ladder

  ReAct                            ← start here. one loop. one budget.
   │
   ├─ measure: success rate, tool-call accuracy,
   │           latency, tokens, recovery on tool errors
   │
   ├── if path is knowable up front and the agent keeps
   │   re-deriving it → 03-plan-and-execute.md
   │
   ├── if the output is wrong in a way a critic catches
   │   reliably → 04-reflexion-self-critique.md
   │
   ├── if the task genuinely benefits from exploring
   │   multiple branches → 05-tree-of-thoughts.md
   │
   └── if the work splits into independent specialties
       and one agent can't span all of them → SECTION C
       (multi-agent), not another reasoning pattern
```

The principle: every escalation step has a measured failure mode it fixes, and a token/latency cost it adds. If you can't name the failure mode, the escalation isn't earning its keep. blooming insights is at the bottom of this ladder — four agents, all pure ReAct, no planner, no critic loop (the diagnostic and recommendation agents have a *forced synthesis* call on failure, which looks like a critic but isn't — see `04-reflexion-self-critique.md`).

The full picture is below.

---

## ReAct — diagram

```
runAgentLoop — the baseline reused four times

  caller (Diagnostic / Recommendation / Monitoring / Query):
    runAgentLoop({ system, userPrompt, toolSchemas,
                   maxTurns: 8, maxToolCalls: 4 or 6,
                   synthesisInstruction })

  ┌─ LOOP (base.ts L85–L172) ────────────────────────────────────────┐
  │                                                                   │
  │   ┌────────── for turn = 0…maxTurns-1 ──────────┐                │
  │   │                                              │                │
  │   │   ┌──────────────────────────────────────┐  │                │
  │   │   │ forceFinal = lastTurn || budgetSpent │  │ L90–L91         │
  │   │   └──────────────────────────────────────┘  │                │
  │   │                  │                            │                │
  │   │                  ▼                            │                │
  │   │   ┌──────────────────────────────────────┐  │                │
  │   │   │ anthropic.messages.create({          │  │                │
  │   │   │   model: claude-sonnet-4-6,          │  │ L9 / L102       │
  │   │   │   system, messages,                  │  │                │
  │   │   │   tools: forceFinal ? omit : tools,  │  │ L101            │
  │   │   │ })                                   │  │                │
  │   │   └──────────────────────────────────────┘  │                │
  │   │                  │                            │                │
  │   │     ┌────────────┴────────────┐               │                │
  │   │     ▼ no tool_use             ▼ has tool_use  │                │
  │   │   RETURN finalText           for each:        │                │
  │   │   (L121)                       mcp.callTool   │ L144            │
  │   │                                push result    │                │
  │   │                                                │                │
  │   │   messages.push(tool_results as user turn)    │ L171            │
  │   └────────────────────────────────────────────────┘               │
  │                                                                   │
  └───────────────────────────────────────────────────────────────────┘

       4 callers, 1 loop. The per-caller knobs are just
       (system prompt, tool subset, maxToolCalls, synthesisInstruction).
```

---

## In this codebase

**The loop itself**
**File:** `lib/agents/base.ts`
**Function / class:** `runAgentLoop()`
**Line range:** L48–L176 — model L9; for-loop L85; forceFinal calc L90–L91; tools omit on forced-final L101; messages.create L102; assistant turn appended L105; natural stop on zero tool_use L121; mcp.callTool L144; tool_results pushed L171

**The four callers — each one parameterizes the same loop**

- `MonitoringAgent.scan` — `lib/agents/monitoring.ts` L69–L120 — `maxToolCalls: 6` (L101), produces an Anomaly[]
- `DiagnosticAgent.investigate` — `lib/agents/diagnostic.ts` L45–L83 — `maxToolCalls: 6` (L62), produces a Diagnosis
- `RecommendationAgent.propose` — `lib/agents/recommendation.ts` L36–L77 — `maxToolCalls: 4` (L57), produces Recommendation[]
- `QueryAgent.answer` — `lib/agents/query.ts` L24–L48 — `maxToolCalls: 6` (L41), produces prose

Each caller supplies its own system prompt (`lib/agents/prompts/*.md`), tool subset (`lib/mcp/tools.ts`), and `synthesisInstruction`. The loop body is identical for all four.

```
shape (not full impl):
  // per-caller knobs become a single runAgentLoop call
  await runAgentLoop({
    anthropic, mcp,
    agent: 'diagnostic',                                    // for trace events
    system,                                                 // per-agent prompt
    userPrompt: 'Investigate the anomaly and return JSON.', // role-specific
    toolSchemas: filterToolSchemas(allTools, diagnosticTools), // tool subset
    maxTurns: 8,
    maxToolCalls: 6,                                        // per-job budget
    synthesisInstruction: '…Stop investigating now…',       // forced-final
  });
```

---

## Elaborate

### Where this pattern comes from

ReAct is the name from the 2022 Yao et al. paper that demonstrated interleaving reasoning ("Thought:") and acting ("Action:") in one loop beat both pure-reasoning chains (CoT) and pure-acting chains on QA and decision tasks. The contribution wasn't the loop — agents had loops — it was naming the interleave and showing that letting the model write a reasoning step *between* tool calls measurably improved tool-call accuracy. When tool-use APIs (Anthropic, OpenAI function calling) standardized, the "Thought:" step moved from explicit prompt scaffolding into the model's emitted text blocks alongside `tool_use` blocks, but the loop shape stayed the same.

### The deeper principle

The model gets to write the chain at runtime, but only the chain — not the budget, not the tool set, not the stopping criteria. Those stay in your code. The discipline is to *let the model think and let your code count*: the model decides the path, your runtime enforces the ceiling.

```
   model writes:            runtime enforces:
   ─────────────             ──────────────────
   the next tool call       maxTurns, maxToolCalls
   the tool's args          which tools are even available
   when to stop             a hard stop (forced-final) if it doesn't
```

### Where this breaks down

When the task has a knowable path up front (a fixed 4-step pipeline), ReAct re-decides the same thing on every turn and burns tokens proving "yes, the next step is step 2." Plan-and-execute is the cleaner shape for that. When the output is wrong in a way the same model recognizes when re-asked (format errors, missing fields), a critic loop catches it — but only because the failure is *recognizable*, not because the producer was wrong about substance. When the work genuinely needs distinct specialties (writer + reviewer with different judgments), single-agent ReAct can't span both heads — multi-agent earns its overhead.

### What to explore next
- `03-plan-and-execute.md` → escalate when the path is knowable; trade one expensive plan call for many cheap execution calls
- `04-reflexion-self-critique.md` → escalate when the output's failure mode is recognizable; trade 2x tokens for one recovery pass
- `06-routing.md` → ReAct is one of N possible loops; routing picks which loop runs for which input
- `../../study-ai-engineering/04-agents-and-tool-use/03-react-pattern.md` → the mechanics this file relies on (Thought–Action–Observation, the typed `tool_use` block, the message history shape)

---

## Tradeoffs

The decision here was *to keep all four agents on one shared ReAct loop with per-job budgets*, rather than building a per-agent custom shape or escalating to a planner / critic. The alternative most teams reach for is "each agent gets its own bespoke control flow" (a planner for diagnostic, a critic for recommendation, etc.).

┌──────────────────┬─────────────────────────────┬─────────────────────────────┐
│ Cost dimension   │ Shared ReAct (chosen)       │ Per-agent bespoke shapes    │
├──────────────────┼─────────────────────────────┼─────────────────────────────┤
│ Build time       │ one loop, parameterised     │ 4 distinct control flows    │
│                  │ 4 times                     │ to author and maintain      │
│ Latency / cost   │ 1 model call per turn,      │ planner adds an expensive   │
│                  │ bounded by maxToolCalls     │ up-front call; critic adds  │
│                  │                             │ a retry pass                │
│ Debugging        │ one trace shape; replay     │ 4 trace shapes; per-agent   │
│                  │ tool calls in order         │ debugging rituals           │
│ Complexity       │ knobs = (prompt, tools,     │ each agent grows its own    │
│                  │ budget, synthesisInstr)     │ control surface             │
│ Failure blast    │ a loop bug fixes all 4 at   │ a loop bug fixes one; the   │
│                  │ once                        │ others might re-introduce it│
│ Predictability   │ same shape, same bounded    │ each agent's worst-case is  │
│                  │ worst-case across all 4     │ separate to reason about    │
│ Adaptability     │ extending requires a new    │ each agent already has its  │
│                  │ knob (e.g. plan phase)      │ own machinery to extend     │
└──────────────────┴─────────────────────────────┴─────────────────────────────┘

### What we gave up

We gave up per-agent customization of the control flow. The diagnostic agent can't, today, run a "plan first, then execute" phase without changing `runAgentLoop` itself — the loop has no plan slot. Same for a critic re-read: the loop has no post-loop hook (`diagnostic.ts` L75 calls a separate `synthesize()` *outside* the loop precisely because the loop has no notion of "try again differently").

We also pay the tighter budgets uniformly. `maxToolCalls: 4` for recommendation is fine because recommendations don't need a long investigation, but the *cost of testing whether 6 would be better* is changing a constant in one file — easy. The flip side is uniform predictability: no caller can accidentally double its budget without it showing in the diff.

### What the alternative would have cost

If we had built bespoke control flows per agent, the up-front cost would be ~4x the loop code (each agent reimplements the for-loop, the forced-final logic, the tool-result feeding). And every loop bug — like the messages.length growth blowing context, or the budget arithmetic being off by one — would have to be fixed four times. The biggest hidden cost is the *trace shape*: the streaming events the route emits (`tool_call_start`, `tool_call_end`, `reasoning_step`) work because every agent emits them from the same loop. Four loops means four trace shapes, and the UI's investigation feed would have to branch on agent.

### The breakpoint

Shared ReAct stays the right call as long as the four agents' loops are *structurally identical* and only differ in (prompt, tool subset, budget, synthesis instruction). The day one of them needs a genuinely different shape — a plan phase, a critic round, a fan-out to sub-agents — that agent breaks out of `runAgentLoop` and `runAgentLoop` becomes "the three-agent loop." That's the right time to fork; before that, forking is premature.

### What wasn't actually a tradeoff

A no-loop "single call with all tools" was not a real alternative. Each investigation needs the model to *observe* a tool result before picking the next tool — the period-over-period comparison in `monitoring.md` L26–L29 literally needs the count from query #1 to know whether to switch to a populated window in query #2. One call with all tools and a "do everything" prompt can't observe between calls. The loop isn't a complexity choice; it's the only shape that supports observation-driven tool sequences.

---

## Tech reference (industry pairing)

### Anthropic Messages API (`tool_use` / `tool_result` blocks)

- **Codebase uses:** `@anthropic-ai/sdk`'s `anthropic.messages.create({ tools, messages })` (`lib/agents/base.ts` L102). Model: `claude-sonnet-4-6` (L9). Forced-final omits the `tools` field entirely (L101).
- **Why it's here:** the typed `tool_use` block is what makes the ReAct loop a first-class control-flow primitive instead of "parse free text and hope it's a tool name." Without typed blocks, every loop step would need a regex.
- **Leading today:** Anthropic tool use — innovation-leading for agent loops, 2026.
- **Why it leads:** the content-block model (text + tool_use + tool_result) treats the loop as a conversation shape, not a parsing problem; the SDK handles serialization both ways.
- **Runner-up:** OpenAI function calling / Responses API — equivalent loop shape, larger installed base, slightly different message shape (assistant→tool→assistant vs Anthropic's user→assistant→user-with-tool_result).

### MCP (Model Context Protocol) as the tool surface

- **Codebase uses:** `lib/mcp/connect.ts` → `mcp.callTool(name, args)` called from `runAgentLoop` at `lib/agents/base.ts` L144. Per-agent tool subsets at `lib/mcp/tools.ts` L5–L40.
- **Why it's here:** every `tool_use` block the model emits is dispatched through one MCP client interface — the loop doesn't know which Bloomreach tool exists; it just calls `mcp.callTool(name, args)`. Adding a tool is a server-side change, not a loop change.
- **Leading today:** MCP — innovation-leading for agent–tool integration, 2026.
- **Why it leads:** standardizes the tool surface across models (any Anthropic/OpenAI/Gemini agent can speak to the same server), and lets the same tool definition serve multiple agents (each agent picks its subset via `filterToolSchemas`).
- **Runner-up:** direct per-agent SDKs (the Bloomreach REST API called directly) — fewer hops, no protocol overhead, but every new agent re-implements auth and rate handling.

### Next.js streaming Response (the loop's wrapper)

- **Codebase uses:** `app/api/agent/route.ts` L168–L267 — a `ReadableStream` writes NDJSON events as the loop progresses, surfaced to the client via `onText`/`onToolCall`/`onToolResult` hooks (`base.ts` L55–L57).
- **Why it's here:** the loop is bounded but not fast (~1 req/s MCP spacing × 6 calls ≈ 6–10s/agent). Streaming makes the loop *visible* — the user sees each tool call land, instead of a blank screen for 30s.
- **Leading today:** Next.js App Router `Response(ReadableStream)` — adoption-leading for streamed APIs, 2026.
- **Why it leads:** native to the runtime, edge-compatible, no extra dependency; NDJSON is the simplest streaming shape that survives proxies.
- **Runner-up:** Server-Sent Events (SSE) — same idea, slightly heavier framing; tRPC subscriptions if the rest of the stack uses tRPC.

---

## Summary

ReAct is the baseline single-agent loop: the model emits a tool call, the runtime executes it, the result is fed back, the model decides the next call or stops. In this codebase, `runAgentLoop` (`lib/agents/base.ts` L48–L176) is that loop, and four agents share it by parameterizing the prompt, tool subset, budget, and synthesis instruction. The constraint that made it right is that all four agents have structurally identical control flow — only the inputs differ, so one loop with knobs beats four bespoke ones. The cost is uniformity: any per-agent shape change (a plan phase, a critic round) means the agent leaves the shared loop.

- One loop, four callers — the per-agent differences are (prompt, tool subset, `maxToolCalls`, `synthesisInstruction`); the body is the same.
- The model writes the chain at runtime; the runtime owns the ceiling (`maxTurns`, `maxToolCalls`, and the forced-final turn at `base.ts` L90).
- The forced-final turn (`base.ts` L101: omit `tools` + append `synthesisInstruction`) is the *guaranteed terminal* — without it ReAct can hang.
- ReAct is the bottom of the escalation ladder: only escalate to plan-and-execute, reflexion, ToT, or multi-agent when a measured failure justifies the cost.
- Worth it as long as the four agents stay structurally identical; promote to a custom shape the day one needs a plan phase or a critic round the loop can't express.

---

## Interview defense

### What an interviewer is really asking
When an interviewer asks "what reasoning pattern does your agent use," they're testing whether you can name the baseline and whether you reached past it for a measured reason. ReAct is the default; saying "I used ReAct" with confidence and pointing to a budget and a forced-final turn is a stronger signal than naming five fancy patterns you didn't actually need.

### Likely questions

[mid] Q: What does your agent loop look like and what makes it ReAct?

A: It's a bounded `for` loop in `runAgentLoop` at `lib/agents/base.ts` L85 that calls Claude with `tools` and `messages`, executes any `tool_use` blocks it emits through an MCP client, feeds the results back as the next user turn, and stops either when the model returns no `tool_use` blocks (natural end, L121) or when the per-agent `maxToolCalls` budget is hit (forced-final turn, L90–L101). The model decides each next tool call; my code counts. That interleave of reason and act in one loop is the ReAct shape.

Diagram:
```
  for turn in 0..maxTurns:
    res = model.create({tools, messages})
    if no tool_use → return finalText  (natural)
    run tools; push results
  → forced-final: drop tools, force text
```

[senior] Q: Why didn't you use plan-and-execute or a reflexion critic — those would be more "robust," right?

A: Because neither would have fixed a failure I measured. The diagnostic agent's failure mode wasn't "wrong plan" — it was "the model wanted to keep querying past the budget." A plan phase would have paid an extra expensive call to produce a plan I already encode statically in the prompt's suggested-query list. A critic loop would have doubled tokens to catch failures the producer doesn't produce (the format failures we see come from running out of budget, not from misjudging substance). What I do have is the forced-final turn at `base.ts` L90 plus a tool-less `synthesize()` call (`diagnostic.ts` L87) — a single recovery pass when the loop ran out of budget without emitting JSON. That's the actual fix for the actual failure, at the lowest cost.

Diagram:
```
   The escalation I considered           What I did instead
   ──────────────────────────            ──────────────────────────
   plan phase: +1 expensive call         budget cap: maxToolCalls=6
   critic loop: +1 full retry            forced-final: drop tools
   measured failure they fix? no         measured failure it fixes? yes
```

[arch] Q: At 10x throughput, what breaks first in this loop?

A: Not the loop logic — it's stateless per request. The pressure point is the MCP server's ~1 req/s rate limit: each agent loop fires up to 6 tool calls roughly serially, so 10x concurrent investigations means 10x agent loops sharing one MCP rate budget. The first failure would be tool calls 429-ing, the loop treating those as observations, and the model burning the budget retrying. The fixes are cross-run caching of repeated EQL sub-steps (cross-turn caching from SECTION E) and per-tool circuit breaking (SECTION E) so the agent routes around a throttled tool instead of looping on it. The loop body itself doesn't change.

Diagram:
```
 ┌ runAgentLoop ──────── fine, stateless ─────────────┐
 ┌ MCP rate budget ◄──── BREAKS: 10 loops × 6 calls ──┐
 │                                vs ~1 req/s          │
 ┌ recovery layer ◄───── needed: cross-run cache +    ┐
 │                       per-tool breaker              │
 └────────────────────────────────────────────────────┘
```

### The question candidates always dodge
Q: ReAct is just "loop with tools" — there's nothing principled there. Why even name it?

A: Honest answer: because naming the baseline is what stops you from over-building. The principle isn't in the loop's complexity (there isn't any); it's in the *measurement discipline you apply on top of it*. I start every agent at pure ReAct with a budget and a forced-final. I instrument tool-call accuracy and trajectory length. Only when a specific failure shows up that the prompt can't fix do I reach for a structural addition — plan-and-execute for "the path is knowable but the model keeps re-deriving it," reflexion for "the failure is recognizable to the same model," multi-agent for "the work splits into genuinely different specialties." Skipping that discipline is how teams ship a critic loop that runs 100% of the time, doubles cost, and fixes nothing. So yes, ReAct is "just a loop" — and that's the point. The discipline is keeping it that simple until something measured forces an escalation.

Diagram:
```
   What's "in" ReAct           What I keep OUT of ReAct
   ─────────────────           ─────────────────────────
   tool call                   plan phase (escalation #1)
   observation                 critic loop (escalation #2)
   stop condition              branching tree (escalation #3)
   bounded loop                sub-agents (escalation #4 — multi-agent)
   forced-final                ─── only adds if I measured a failure ───
```

### One-line anchors
- "ReAct is the baseline: one loop, the model writes the chain, my code counts."
- "Four agents, one loop — the per-agent differences are knobs (prompt, tools, budget, synthesis)."
- "The forced-final turn at `base.ts` L90 is what keeps the loop bounded — drop the tools, force a text answer."
- "I escalate past ReAct only when a measured failure justifies the structural cost — and I can name which file would change for each escalation."

---

## Validate your understanding

### Level 1 — Reconstruct the diagram
Close this file. Draw `runAgentLoop`'s body from memory: the `for` loop, the `forceFinal` check, the model call (with/without tools), the natural stop (zero `tool_use`), the tool-result push as the next user turn. Label which lines in `base.ts` each box maps to.

Open the file. Compare.

✓ Pass: you have the loop, the `forceFinal` gate, the natural-stop branch, and the tool-result push, and you put `tools` only on non-forced turns
✗ Fail: re-read Move 2.2 and Move 2.3, wait 10 minutes, try again

### Level 2 — Explain it out loud
Explain "what reasoning pattern your agents use" to a colleague who just asked. No notes. Under 90 seconds.

Checkpoints — did you:
- Name the file and function? → `lib/agents/base.ts` `runAgentLoop`
- Say what makes it ReAct and not something else (interleave of model-decided tool calls and observations)?
- Name at least one of the four callers and its `maxToolCalls` budget?
- Say what the forced-final turn does and why it exists?

If you skipped any: you described it, you didn't understand it.

### Level 3 — Apply it to a new scenario
A product manager asks: "Can we make the recommendation agent re-read its output and fix any structural mistakes before returning?" Without looking at the file: is that a ReAct change or an escalation? What would change in `runAgentLoop`, what would change in `recommendation.ts`, and which one is the right place to do it?

Write your answer (3–5 sentences). Then open `lib/agents/recommendation.ts` L75–L77 and `lib/agents/base.ts` L48–L176 and check whether a post-loop critic naturally lives in the agent class (around its existing `synthesize()` fallback) or in the loop itself.

### Level 4 — Defend the decision you'd change
"If you were starting today with the same MCP and the same four agents, would you still share one `runAgentLoop` across all four, or give each its own control flow? Why? If you'd switch, what would you do instead and what would the loop bug surface look like?"

Reference the code: point to `lib/agents/base.ts` L85–L172 for what exists, and describe what a per-agent loop would mean for the trace shape the route emits at `app/api/agent/route.ts` L181–L195.

### Quick check — code reference test
Without opening any files:
- What file holds the ReAct loop, and what is the function called?
- What two budgets bound the loop, and which one usually fires first?
- What does the loop do on the forced-final turn that's different from a normal turn?

Open and verify. ✓ File + function + the two budgets matter; line numbers drifting is fine.

---
Updated: 2026-05-29 — created
