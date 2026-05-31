# ReAct

**Industry name(s):** ReAct (Reason + Act), Thought–Action–Observation loop, tool-use agent loop
**Type:** Industry standard · Language-agnostic

> The baseline single-agent shape — reason, call a tool, read the result, repeat. blooming insights runs this one loop (`runAgentLoop`) under four different prompts; everything fancier is an escalation away from it.


---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** ReAct sits in the Shared agent loop band, one level below the Pipeline coordinator that fires it. The Pipeline picks which agent runs (monitoring → diagnostic → recommendation); each of those agents enters `runAgentLoop` and the model takes over the per-turn decisions. One loop, four callers — the per-agent differences are knobs (system prompt, tool subset, `maxToolCalls`, `synthesisInstruction`) that get passed in. The escalations covered in this folder (plan-and-execute, reflexion, tree-of-thoughts) all sit at this same band; they're alternative loops that would replace this one.

```
  Zoom out — where ReAct lives

  ┌─ Pipeline coordinator ──────────────────────────┐
  │  lib/agents/pipeline.ts (picks which agent runs) │
  └─────────────────────────┬────────────────────────┘
                            │  per-agent invocation
  ┌─ Per-agent definitions ─▼────────────────────────┐
  │  monitoring.ts | diagnostic.ts | recommendation  │
  │    (system prompt + tool set + handoff schema)   │
  └─────────────────────────┬────────────────────────┘
                            │
  ┌─ Shared agent loop ─────▼────────────────────────┐  ← we are here
  │  ★ runAgentLoop (lib/agents/loop.ts) ★           │
  │  for turn: model.create → tool_use? → execute    │
  │  → push result → repeat (the ReAct cycle)        │
  └─────────────────────────┬────────────────────────┘
                            │  every model call
  ┌─ Provider wrappers ─────▼────────────────────────┐
  │  cache · rate limit · retry · anthropic SDK      │
  └──────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question is: what's the cheapest agent loop that does real work, and what does it look like in code? ReAct answers with one bounded `for` loop, one model call per turn, one tool-call budget, and one stopping condition (no `tool_use` blocks → done). Everything fancier in this folder is a structural addition on top of this kernel — pay for one only when a measured failure justifies it. Below, you'll see the four pieces of the kernel and what breaks when each one is removed.

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

### Isolate the kernel

ReAct as a *placement* — the bottom of the reasoning-pattern ladder — has an irreducible kernel: four pieces that make it ReAct rather than a single LLM call.

```
for turn in maxTurns:                                ─┐
  forceFinal = (turn == last) or (toolCalls >= budget)│
  res = model.call({                                  │
    tools: forceFinal ? OMITTED : schemas,            │  KERNEL
    system: forceFinal ? system+synth : system,       │
    messages,                                          │
  })                                                   │
  if no tool_use blocks → return finalText  ← exit    │
  for each tool_use: execute, push result back        │
  messages.push({ role:'user', content: results })   ─┘
```

Four load-bearing pieces: (1) the **bounded turn loop**, (2) the **`tool_use` → execute → `tool_result` back** observation cycle, (3) the **per-loop tool-call budget**, and (4) the **forced-final escape hatch** (strip `tools` so the model must write text). The wire-level mechanics — what a turn looks like in the Messages API, the difference between `text` and `tool_use` blocks, how the message history accumulates — are covered in the ai-engineering ReAct pattern note. This file's kernel is about *placement*: what makes this an agent loop and not its predecessor or its replacement.

---

### Name each part by what breaks when removed

Each kernel piece is here because something specific breaks if you drop it, and each "what breaks" maps to where on the ladder ReAct would lose its place.

```
Removed                            What breaks (placement consequence)
────────────────────────────       ─────────────────────────────────────
the for-turn loop                  You have an LLM call, not an agent.
                                   No act → observe → reason cycle. ReAct
                                   collapses back into the row above it
                                   on the ladder: a single completion.

tool_use → tool_result feedback    The "Re" in ReAct is gone — the model
                                   can't condition the next turn on what
                                   the last action returned. You'd be
                                   running plan-and-execute without the
                                   plan: blind execution.

per-loop tool-call budget          The loop has no upper bound. Cost and
                                   latency become unpredictable. This is
                                   the specific property the multi-agent
                                   escalation gate (→ the "when not to go
                                   multi-agent" note) tests against —
                                   without it, "ReAct hit its ceiling" is
                                   unmeasurable.

forced-final escape hatch          Budget hits but the model still has
                                   tools. It keeps calling them. The loop
                                   either runs to maxTurns or returns
                                   incomplete. No clean terminal — the
                                   loop is no longer bounded in *output*,
                                   only in *iteration*. The structured
                                   answer never arrives.
```

The placement consequence of each removal: drop the loop and you're below ReAct on the ladder; drop the budget or the escape and you can't honestly say "ReAct hit its ceiling" because the ceiling is undefined.

---

### Separate skeleton from optional hardening

The kernel is the minimum that makes a ReAct agent. Everything else is hardening that turns one ReAct agent into a *production* ReAct agent. In this codebase, the four agents share the kernel and vary only at the hardening layer.

```
SKELETON (in the shared agent loop — required)   HARDENING (placement-relevant)
────────────────────────────────────────────     ──────────────────────────────────
bounded turn loop (max-turns ceiling)            ┌ per-agent tool SUBSETS via
tool_use → execute → tool_result back            │   a schema filter (→ this
per-loop tool-call budget                        │   folder's routing note)
forced-final: tools omitted on last turn         ├ streamed trace as a product
synthesis instruction appended on the            │   surface (→ ai-eng streaming;
  forced-final turn                              │   the trace makes the loop
                                                 │   inspectable to the user)
                                                 ├ output validators on finalText
                                                 │   (JSON parse + type guards)
                                                 ├ a tool-less synthesize retry
                                                 │   on parse failure (diagnostic +
                                                 │   recommendation)
                                                 ├ a deterministic supervisor
                                                 │   composing multiple ReAct
                                                 │   nodes (→ sequential-pipeline
                                                 │   — the actual topology this
                                                 │   codebase uses)
                                                 └ self-critique, planning,
                                                   branch exploration
                                                   (absent — every escalation
                                                   on the ladder is hardening
                                                   layered on this kernel)
```

All four agents in this codebase share the kernel — that's why one shared loop function powers them. The variations are at the hardening layer: which tool subset, which synthesis instruction, which validator. The agents themselves are the same loop. And the next escalation on the ladder — plan-and-execute, reflexion, etc. — is *another layer of hardening* on the same kernel, not a different kernel.

---

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

The principle: every escalation step has a measured failure mode it fixes, and a token/latency cost it adds. If you can't name the failure mode, the escalation isn't earning its keep. blooming insights is at the bottom of this ladder — four agents, all pure ReAct, no planner, no critic loop (the diagnostic and recommendation agents have a *forced synthesis* call on failure, which looks like a critic but isn't — see the reflexion note).

The full picture is below.

---

## ReAct — diagram

```
the shared agent loop — the baseline reused four times

  caller (Diagnostic / Recommendation / Monitoring / Query):
    run_agent_loop({ system, user_prompt, tool_schemas,
                     max_turns, per_loop_tool_budget,
                     synthesis_instruction })

  ┌─ LOOP ───────────────────────────────────────────────────────────┐
  │                                                                   │
  │   ┌────────── for turn = 0…max_turns-1 ─────────┐                │
  │   │                                              │                │
  │   │   ┌──────────────────────────────────────┐  │                │
  │   │   │ force_final = last_turn OR           │  │                │
  │   │   │               budget_spent           │  │                │
  │   │   └──────────────────────────────────────┘  │                │
  │   │                  │                            │                │
  │   │                  ▼                            │                │
  │   │   ┌──────────────────────────────────────┐  │                │
  │   │   │ model.create({                       │  │                │
  │   │   │   system, messages,                  │  │                │
  │   │   │   tools: force_final ? omit : tools, │  │                │
  │   │   │ })                                   │  │                │
  │   │   └──────────────────────────────────────┘  │                │
  │   │                  │                            │                │
  │   │     ┌────────────┴────────────┐               │                │
  │   │     ▼ no tool_use             ▼ has tool_use  │                │
  │   │   RETURN finalText           for each:        │                │
  │   │   (natural stop)              run a tool call │                │
  │   │                                push result    │                │
  │   │                                                │                │
  │   │   messages.push(tool_results as user turn)    │                │
  │   └────────────────────────────────────────────────┘               │
  │                                                                   │
  └───────────────────────────────────────────────────────────────────┘

       4 callers, 1 loop. The per-caller knobs are just
       (system prompt, tool subset, tool-call budget, synthesis instruction).
```

---

## Implementation in codebase

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

## See also

→ 01-chains-vs-agents.md · → 03-plan-and-execute.md · → 04-reflexion-self-critique.md · → 06-routing.md · → mechanics: `../../study-ai-engineering/04-agents-and-tool-use/03-react-pattern.md` · → tool routing: `../../study-ai-engineering/04-agents-and-tool-use/04-tool-routing.md`

---
Updated: 2026-05-29 — created
Updated: 2026-05-30 — Applied study.md v1.46 Move-2-variant (load-bearing skeleton: isolate the kernel + what-breaks-if-removed + skeleton vs hardening) to How it works.
Updated: 2026-05-30 — Migrated to study.md v1.47 template (Phase 1+2 mechanical): removed Tradeoffs / Tech reference / Summary sections; renamed "In this codebase" → "Implementation in codebase"; moved See also to a bottom block. "Why care" preserved pending Phase 3 (Zoom out, then zoom in + LAYERS diagram) authoring.
Updated: 2026-05-30 — Phase 3 of study.md v1.47 migration: replaced "Why care" block with "Zoom out, then zoom in" (LAYERS diagram + zoom-in paragraph) per format.md.
Updated: 2026-05-31 — Applied study.md v1.48: scrubbed "How it works" of file paths, line refs, and real-code fences; replaced with generic role labels + pseudocode per format.md. Codebase-specific anchoring lives exclusively in "Implementation in codebase".
