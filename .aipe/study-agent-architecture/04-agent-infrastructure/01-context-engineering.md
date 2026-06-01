# Context engineering

**Industry name(s):** Context engineering, context curation, in-context learning curation, prompt-context discipline
**Type:** Industry standard · Language-agnostic

> The discipline that decides what fills the model's window on the next turn — and, in a multi-agent system, which agent sees what. blooming insights does this actively: a 112KB raw schema gets compressed to a token-bounded summary, the runnable category list is injected by replacement, and every tool result is truncated before it goes back to the model.


---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Context engineering is a cross-cutting discipline that touches three bands at once — Per-agent definitions (which prompt + tool subset goes in), Shared agent loop (which tool results come back and how they're truncated), and Tools/MCP (which schema slice is exposed in the first place). In blooming insights, every band has explicit curation: per-agent tool subsets via `filterToolSchemas`, tool-result truncation in `runAgentLoop`, schema-summarised injection in the monitoring prompt. The window the model sees on any turn is the *intersection* of those curation decisions, not a default.

```
  Zoom out — where context engineering lives

  ┌─ Per-agent definitions ─────────────────────────┐  ← we are here
  │  ★ prompt + tool subset per agent ★              │
  │  filterToolSchemas curates what enters the window │
  └─────────────────────────┬────────────────────────┘
                            │  curated context
  ┌─ Shared agent loop ─────▼────────────────────────┐  ← we are here
  │  runAgentLoop                                     │
  │  ★ tool-result truncation (16k chars) ★           │
  │  ★ message accumulation policy ★                  │
  └─────────────────────────┬────────────────────────┘
                            │  every model call
  ┌─ Provider wrappers ─────▼────────────────────────┐
  │  cache · rate limit · retry · anthropic SDK      │
  └─────────────────────────┬────────────────────────┘
                            │
  ┌─ Tools + MCP transport ─▼────────────────────────┐  ← we are here
  │  lib/tools/* | lib/mcp/client.ts                 │
  │  ★ schema-summarised injection (top-20 events) ★  │
  └──────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question is: what discipline decides what goes into the window on each turn? Not prompt engineering (how you phrase the slice once it's in), not RAG (one retrieval source feeding the slice) — but the bigger discipline that owns the whole window. Most agent failures are context failures, not model failures: a 112KB schema dump evicts the task instructions to the middle where the model loses them; a 200KB un-truncated tool result burns the next turn's budget on noise. Below, you'll see how blooming insights curates every entry point so the model sees only what it needs on this turn.

---

## Structure pass

**Layers.** Context engineering is cross-cutting, so its "layers" are the curation points it touches: the **Per-agent definitions** (system prompts and the `filterToolSchemas` tool subset — what enters the window in the first place), the **Shared agent loop** (`runAgentLoop` — accumulates the message history, truncates tool results to a 16KB cap), the **Tools + MCP transport** (where the 112KB raw schema gets summarised into a top-20 events injection before it ever reaches the prompt), and the **Window itself** (the message array sent on any given turn — the *intersection* of all the curation decisions upstream).

**Axis: state.** What's in the window right now, who put it there, when does it grow, when does it get evicted, and what shape does it take by the time it reaches the model? This is the right axis because the entire discipline of context engineering is *managing the lifecycle of token-state in the window*. Cost is a real concern (tokens cost money and latency) but cost is the *consequence* of state-growth. Pick the wrong axis (control, say) and every curation point looks like just "an `if`" — state-as-content is what makes the difference legible.

**Seams.** Three seams matter, and the second is load-bearing. Seam 1 sits between raw material (full schema, all tools, full tool response) and curated entries (summarised schema, per-agent subset, truncated result) — state-ownership flips from "MCP server / external API owns it" to "our code owns the slice that enters the window." Seam 2 sits between the prior turn's window and this turn's window — state flips from "everything from last turn" to "everything from last turn + this turn's tool results, truncated." That seam is the load-bearing one: it's where context bloat would originate if there were no truncation, and it's the *only* moment per turn when the system gets to evict. Seam 3 sits at the agent-to-agent boundary (handled by message passing in the sibling file) — state flips from "agent A's full window" to "agent B sees only the typed message it was handed."

```
  Structure pass — Context engineering

  ┌─ 1. LAYERS ───────────────────────────────────┐
  │  Per-agent definitions (prompt + tool subset)  │
  │  Shared agent loop (accumulates + truncates)   │
  │  Tools + MCP transport (schema summarised)     │
  │  The window (intersection of all curation)     │
  └────────────────────────┬───────────────────────┘
                           │  pick the axis
  ┌─ 2. AXIS ─────────────▼────────────────────────┐
  │  state: what's in the window, who put it       │
  │         there, when does it grow / evict?      │
  └────────────────────────┬───────────────────────┘
                           │  trace across layers, find flips
  ┌─ 3. SEAMS ────────────▼────────────────────────┐
  │  Seam 1: raw material ↔ curated entries        │
  │          (external owns → we own the slice)    │
  │  Seam 2: prior turn ↔ this turn's window       │
  │          (full → full + truncated additions)   │
  │          ★ load-bearing — only eviction point  │
  │  Seam 3: agent A ↔ agent B                     │
  │          (A's full window → B sees one message)│
  └────────────────────────┬───────────────────────┘
                           ▼
                   Block 4 — How it works
```

The skeleton is mapped — the rest of this file walks the curation policies and where each one earns its keep in tokens.

---

## How it works

**The mental model: the window is a slice you compute, not a bucket you dump into.** Every turn, your code is choosing — explicitly or by neglect — what tokens to put in front of the model. The undisciplined version is "everything I have, in the order I have it." The disciplined version is "the smallest slice that lets the model do this turn correctly, in the order that puts the load-bearing parts at the edges (start and end) where the model attends best."

```
The window as a curated slice

  raw material                       curated window
  ┌──────────────────┐    curate     ┌──────────────────┐
  │ 112KB schema     │  ─────────►   │ 2KB summary      │  ← load-bearing
  │ all MCP tools    │   per-agent   │ 8-tool subset    │
  │ 10 categories    │    schema-    │ 6 runnable only  │
  │ 200KB tool result│    gated      │ 16KB truncated   │
  │ full convo hist  │    cap        │ this run's msgs  │  ← rolling
  └──────────────────┘               └──────────────────┘
                                      what the model sees
```

The strategy in plain English: **decide the slice before you decide the prompt.** Prompt engineering tunes the words; context engineering tunes what's there to tune words about. blooming insights does this in three places that compound: it bounds the schema *before* it enters the system prompt, it injects the runnable-category list *into* the prompt by string replacement, and it caps the size of every tool result *before* it goes back to the loop. Each step is small; together they keep a 200K window from filling with noise across a 6-call investigation.

### Move 1 — Bound the inputs before they enter the prompt

The technical thing: **token-bounded summarisation at the source.** Don't paste the full structured input into the prompt; compute a summary view with hard caps, and paste that.

If you're coming from frontend, this is the `useMemo(() => state.items.slice(0, 20).map(toLite), [state.items])` instinct — never render with the whole 10,000-item list, render with the 20 the screen actually needs. The lite shape is computed deterministically by your code, not chosen by the consumer.

```
schema summary — three hard caps in one function

  full WorkspaceSchema (~112KB JSON)
       │
       ▼  schema_summary()
  ┌──────────────────────────────────────────────┐
  │ MAX_EVENTS = 20         events.slice(0, 20)  │
  │ MAX_PROPS_PER_EVENT=10  props.slice(0, 10)   │
  │ MAX_CPROPS = 30         cprops.slice(0, 30)  │
  └──────────────────────────────────────────────┘
       │
       ▼
  ~2KB text block, deterministic shape
```

The practical consequence: a workspace with 500 events doesn't blow the prompt — it ships the top 20 by `eventCount` with their 10 most-used properties. The model never sees the long tail, because the long tail isn't useful for picking the next category check. The summary fits the system prompt's `{schema}` slot with budget left over for the category checklist, the EQL recipes, and the hard rules.

The condition under which it works (and doesn't): it works because the agent doesn't *need* the long tail to do its job. If a future agent had to reason about rare events, the cap would have to grow or the summary would have to become retrievable on demand (the agentic-RAG shape from section 02). Right now the agent's job is bounded; the summary's shape matches the job.

### Move 2 — Inject the right slice by replacement, per run

The technical thing: **prompt templating with replacement, where the replacement value is computed against runtime state.** The prompt file holds slots (`{categories}`, `{schema}`, `{project_id}`); the agent code computes each slot's value and runs `.replace()` to splice them in before the call.

If you're coming from frontend, this is a server-rendered component template: the file on disk has `{children}`, and at request time you compute the children from the request's context (which workspace, which user, which gate-passed categories) and substitute them in. The model sees the assembled string; the template stays declarative.

```
prompt injection at run time

  monitoring prompt template (file on disk)
  ┌──────────────────────────────────────────┐
  │ ## Your category checklist               │
  │ {categories}              ◄── slot       │
  │ ## Workspace schema                       │
  │ {schema}                  ◄── slot       │
  │ Pass `project_id: {project_id}` ...      │
  └──────────────────────────────────────────┘
                  │   .replace(...) × 3
                  ▼
  system prompt sent to the model — only categories
  the workspace's schema can actually support
```

The practical consequence: the route runs the *capability gate* (the runnable-categories filter, covered in the guardrails note) before the monitoring agent starts, and only the categories whose required events exist in the schema land in `{categories}`. The model is never shown a category like `fraud_detection` if the workspace doesn't emit `payment_failure` — because the category isn't *in the window*. There's nothing to ignore, nothing to misclick.

The condition under which it works: the gate has to be correct. If the runnable-categories filter returns a category the schema can't actually support, the model will dutifully try and spend a tool call on a query that fails. The substitution is honest because the gate upstream is honest.

### Move 3 — Cap every tool result before it goes back in

The technical thing: **truncation at the loop boundary** — the loop never feeds an un-bounded result back into the message history.

If you're coming from frontend, this is `String(payload).slice(0, MAX)` on a log-line you ship to your error tracker: the upstream payload can be any size, but the slot you control bounds it. The loop is the slot.

```
truncation at the loop seam

  tool returns JSON of arbitrary size
       │
       ▼
  result_content = truncate(serialize(result))
       │
       ▼  per-result cap = 16_000 chars
       │
       ▼
  messages.push({ role: 'user', content: tool_results })
       │  next turn sees at most 16KB per tool call,
       │  with "…[truncated]" marker
       ▼
  the model's next turn keeps its budget
```

The practical consequence: a customer-events tool result with 5,000 events doesn't drown the next turn. The model sees ~16KB of the response — enough to spot a pattern in the head, with an explicit `…[truncated]` marker telling it the result was clipped (so it doesn't reason as if it saw everything). The same kind of truncation (a tighter ~4KB cap) also runs in the streaming layer when results are forwarded to the client, so the wire payload stays bounded too.

The condition under which it works: 16KB has to be enough for the *first* turn's decision. If the model needs more, it can call a more specific tool with narrower args — and the next result will also be capped. If 16KB is *never* enough for a particular tool, that tool's contract is wrong and should return summaries, not blobs.

### Move 4 — In a multi-agent run, decide who sees what

The technical thing: **per-agent context routing.** With four agents sharing one MCP server, deciding which tools each agent sees is itself a context-engineering decision — the smaller the surface, the cleaner the reasoning.

If you're coming from frontend, this is a manager's standup posture — every report-to gets only the slice of company state relevant to their job, not the firehose. The monitoring lead doesn't get the recommendation engine's roadmap; the recommendation lead doesn't get the monitoring SLO graph. Each gets the slice that lets them act.

```
who sees what (per-agent context routing)

   monitoring agent ◄── monitoring tool set  (13 tools, detect-shaped)
   diagnostic agent ◄── diagnostic tool set  (17 tools, investigate-shaped)
   recommend agent  ◄── recommendation tool set (7 tools, propose-shaped)
   query agent      ◄── query tool set  (union, free-form)

   one MCP server, one tool list — filtered per agent at
   the prompt boundary, so the wrong tool is never in
   the wrong agent's window
```

The practical consequence: the recommendation agent doesn't have analytics tools in its window — so it can't burn its 4-call budget re-running monitoring queries when its job is to propose actions. The mechanism is a per-agent tool-schema filter, but the *discipline* is context engineering: the surface each agent sees is curated to its job. This is covered as a mechanism in the tool-calling-and-mcp note; here it's the per-agent-context-routing pattern from the multi-agent-orchestration sub-section.

The condition under which it works: the per-agent tool list has to match the per-agent prompt. If you give the recommendation agent the diagnostic tool subset but a recommendation prompt, the model gets confused by mismatched affordances. The two slots — tools and prompt — are curated together.

### The principle

Bigger context windows do not solve the context problem. They make room for more noise. The job of the writer of the loop is to **decide what fills the window on the next turn**, and in a multi-agent system, **which agent sees which slice**. Prompt engineering is one input into that decision; RAG is another; tool subsets are another; truncation is another. The discipline that owns all of those together is context engineering, and it's the discipline most under-weighted by people who treat the prompt as the only lever.

The full picture is below.

---

## Context engineering — diagram

```
The window for ONE monitoring turn (blooming insights)

  ┌─────────────────────────── SYSTEM PROMPT ───────────────────────────┐
  │ monitoring prompt template (file on disk, ~3KB)                     │
  │                                                                      │
  │   role + hard rules    ◄── stable, prefix-cacheable                  │
  │   {categories}    ──────── injected: runnable-only list (gated)     │
  │   {schema}        ──────── injected: schema summary (3 caps applied)│
  │   {project_id}    ──────── injected: workspace id                    │
  │                                                                      │
  └──────────────────────────────────────────────────────────────────────┘
  ┌────────────────────────── TOOL DEFINITIONS ─────────────────────────┐
  │ filter_tool_schemas(all_tools, monitoring_tool_set)                  │
  │ → 13 tools, monitoring-shaped only (recommendation tools absent)     │
  └──────────────────────────────────────────────────────────────────────┘
  ┌───────────────────────── USER + MESSAGES[] ─────────────────────────┐
  │ user: "Work through your category checklist..."                      │
  │ assistant: tool_use → analytics tool                                 │
  │ user: tool_result (truncated to 16KB)                                │
  │ assistant: tool_use → analytics tool                                 │
  │ user: tool_result (truncated to 16KB)                                │
  │   ... up to the per-loop tool-call cap = 6 ...                       │
  │ assistant: final JSON (tools removed on forced-final turn)           │
  └──────────────────────────────────────────────────────────────────────┘

  CURATION points: schema cap · {categories} gate · per-agent
  tool subset · 16KB tool-result cap · 4KB stream cap
```

---

## Implementation in codebase

**Schema cap (the structured-input slice):**
**File:** `lib/agents/monitoring.ts`
**Function:** `schemaSummary()`
**Line range:** L16–L49 (caps at L21, L22, L33)

**Prompt injection (the per-run slot fill):**
**File:** `lib/agents/monitoring.ts`
**Function:** `MonitoringAgent.scan()`
**Line range:** L83–L86 (three `.replace()` calls into `prompts/monitoring.md` L7–L11, L99–L101)

**Tool-result truncation (the loop-boundary cap):**
**File:** `lib/agents/base.ts`
**Function:** `runAgentLoop()` (the `truncate()` helper at L29–L34, applied at L150 and pushed at L171)
**Line range:** L29, L150, L171

**Per-agent tool subset (the cross-agent slice):**
**File:** `lib/agents/tool-schemas.ts`
**Function:** `filterToolSchemas()`
**Line range:** L15 (subsets defined in `lib/mcp/tools.ts` L5–L40)

**Stream-payload cap (the wire-to-client slice):**
**File:** `app/api/agent/route.ts`
**Function:** `trunc()`
**Line range:** L99–L103 (applied at L192)

```
shape (not full impl):
  // monitoring.ts L83
  const system = PROMPT
    .replace('{schema}', schemaSummary(this.schema))   // bounded
    .replace(/\{project_id\}/g, this.schema.projectId)
    .replace('{categories}', checklist);                // gated

  // base.ts L29 + L150
  const MAX_TOOL_RESULT_CHARS = 16_000;
  resultContent = truncate(JSON.stringify(result));    // capped

  // monitoring.ts L96
  toolSchemas: filterToolSchemas(this.allTools, monitoringTools), // sliced
```

---

## Elaborate

### Where this pattern comes from

The term "context engineering" came into wide use through 2024 as practitioners discovered that bigger context windows did not produce proportionally better agent behaviour. Anthropic's "Building Effective Agents" and the LangChain ecosystem both promoted the framing: the window is the unit of work, and curating it is its own discipline distinct from prompt engineering or RAG. The lost-in-the-middle paper (Liu et al., 2023) had earlier shown that relevant information placed in the middle of a long context is recalled worse than information at the edges — making "what's in the window and where" a load-bearing engineering concern, not a hyperparameter.

### The deeper principle

**The window is a slice of the world, not the world.** Every system that does in-context learning sits on this principle: tokens are costly, attention is non-uniform, and the loop's job is to keep the slice useful for the next step. Frontend engineers already know this rule in another form — you don't render with the whole DB, you render with `useQuery({ select: rowToLite })`. The LLM version is more consequential because the slice's content shapes the model's reasoning, not just its render performance.

```
  raw world  ──► slice picker ──► what the model sees ──► next turn
                 (your code)        (the window)         (model attends)
                      ▲                                       │
                      └───────────────────────────────────────┘
                          observations refine the next slice
```

### Where this breaks down

Context engineering as discipline breaks down when the curation logic itself becomes the bug. A schema cap of 20 events that silently hides the long tail is fine until a workspace's most interesting event is event #21 — and then the agent reasons as if it doesn't exist. Truncation at 16KB is fine until the load-bearing detail of a result lives at byte 16,001. The mitigation is the same as for any cache: instrument and revisit. If anomalies repeatedly cite missing events, the cap is wrong.

### What to explore next
- Agent memory tiers (`02-agent-memory-tiers.md`) → memory is part of context engineering; tiers are how it scales
- Tool calling and MCP (`03-tool-calling-and-mcp.md`) → per-agent tool subsets are a context-engineering decision
- Lost-in-the-middle (`../../study-ai-engineering/02-context-and-prompts/02-lost-in-the-middle.md`) → why the *order* of slices matters, not just the size

---

## Interview defense

### What an interviewer is really asking
When an interviewer asks "how do you manage context in your agent," they're probing whether you treat the window as a curated artefact or as a default bucket. The strong signal is naming the specific caps and slots in your code; the weak signal is "we use Claude's 200K window." The senior posture is showing you decided what *not* to put in.

### Likely questions

[mid] Q: How do you keep the system prompt from getting bloated by the workspace schema?

A: I never paste the raw schema. There's a `schemaSummary()` function in `lib/agents/monitoring.ts` (L16) that takes the full `WorkspaceSchema` (which can be 100KB+ as JSON) and emits a token-bounded text summary — top 20 events, 10 properties each, 30 customer properties. That ~2KB summary is what gets `.replace`'d into the `{schema}` slot of the prompt template. The model never sees the long tail; it sees the slice the monitoring job actually uses.

Diagram:
```
   raw WorkspaceSchema     →  schemaSummary()       →  ~2KB text
   (events.length = 500)      L21: MAX_EVENTS=20       in {schema}
                              L22: MAX_PROPS=10            slot
                              L33: MAX_CPROPS=30
```

[senior] Q: Why bound tool results to 16KB? Bigger windows can handle more.

A: Two reasons. First, lost-in-the-middle: a 200KB tool result in the message history buries everything that came before it, including the hard rules and the prior turns' reasoning, in the middle of the window where the model attends worst. Second, budget: the agent runs up to 6 tool calls per investigation under a ~1 req/s MCP limit, so a 60-second route budget — if turn 2's result is 200KB, turn 3 reads 200KB of input and the cost-per-turn explodes. 16KB is enough for the head of any normal result with a truncation marker the model respects. If a tool genuinely needs to return more, it's the wrong shape and should return a summary, not a blob.

Diagram:
```
   Without cap                With cap (base.ts L29)
   ─────────────              ─────────────────────────
   turn 1: 2KB ctx            turn 1: 2KB ctx
   turn 2: 200KB result       turn 2: ≤16KB result + marker
   turn 3: read 200KB,        turn 3: read ≤16KB,
           rules buried              rules still at top
```

[arch] Q: At 10× the workspace count and 5× the events per workspace, what changes in the context layer?

A: The schema cap holds — `MAX_EVENTS=20` is per-workspace, not per-system, so a bigger workspace doesn't grow the prompt. What pressures up is *coverage*: more workspaces means more category gates running upstream of the agent, and the per-workspace `runnableCategories` set might shrink in ways that change which slots get filled. The bigger architectural shift is the tool-result cap — at higher event volume, 16KB of `list_customer_events` is fewer rows of head data, so the model has to ask narrower questions. Mitigation is a richer summary tool (server-side aggregation that returns numbers, not raw events) so the model spends its window on conclusions, not rows. The discipline doesn't change; the cap targets get re-tuned per workload.

Diagram:
```
  ┌ Schema cap (per-workspace) ── holds at any scale ──────┐
  ┌ Tool subsets (per-agent)  ── holds at any scale ──────┐
  ┌ Tool-result cap (16KB)    ◄── BREAKS first: at high   │
  │                              event volume, head is too │
  │                              small to be useful — need │
  │                              server-side summary tools │
  └ Lost-in-the-middle order ── holds; structure unchanged─┘
```

### The question candidates always dodge
Q: If you're capping the schema at 20 events, aren't you just *hiding* the rare-but-important events from the model? Isn't that worse than passing the full schema and trusting the model to ignore noise?

A: Honest answer: the cap *can* hide load-bearing rare events, and there's no automated check that catches it. The reason I still cap is the lost-in-the-middle effect — a 112KB schema in the system prompt buries the actual instructions (the hard rules, the EQL gotchas, the 6-call budget) deep in the middle of the window, where the model recalls them worst. Passing the full schema doesn't make the rare event more findable; it makes everything *less* findable. The right answer for "expose the long tail" isn't a bigger cap — it's an on-demand retrieval tool the agent calls when its current view doesn't explain the data, which is agentic RAG. I haven't built that yet because the monitoring categories don't currently need it. The day we add a category whose required event is reliably out of the top 20, the cap stops being the right shape and the retrieval tool earns its keep.

Diagram:
```
  Cap (chosen)                    Pass-through (suggested)
  ┌────────────────────────┐      ┌────────────────────────┐
  │ ~2KB schema slice      │      │ ~112KB full schema     │
  │ rules at top + bottom  │      │ rules buried in middle │
  │ rare events hidden     │      │ rare events present    │
  │   ◄── tradeoff         │      │   ◄── tradeoff         │
  │   if rare event is     │      │   model loses the rules│
  │   load-bearing → bug   │      │   to noise → also bug  │
  └────────────────────────┘      └────────────────────────┘
        Better fix: on-demand retrieval (agentic RAG)
```

### One-line anchors
- "I treat the window as a slice I compute, not a bucket I dump into — `useMemo` for the model."
- "Bigger context windows don't solve noise; they make room for more of it."
- "Three caps compound: schema (~2KB), tool result (≤16KB), stream payload (≤4KB)."
- "Per-agent tool subsets are a context-engineering decision — the wrong tool is never in the window."
- "Prompt engineering tunes the words; context engineering tunes what's there to tune words about."

---

## Validate your understanding

### Level 1 — Reconstruct the diagram
Close this file. Draw the "window for one monitoring turn" picture from memory: the three slots in the system prompt (with their injection sources), the tool-definitions slot (filtered per agent), and the `messages[]` slot (with the truncation marker on tool results). Label which line in which file enforces each cap.

Open the file. Compare.

✓ Pass: you got the three injected slots, the per-agent tool filter, and the 16KB tool-result cap, with file/function names
✗ Fail: re-read How it works moves 1–3, wait 10 minutes, try again.

### Level 2 — Explain it out loud
Explain "how does context engineering work in blooming insights?" to a colleague who just asked "wait, isn't that just prompts?" No notes. Under 90 seconds.

Checkpoints — did you:
- Name the specific caps and line numbers? → `monitoring.ts` L21/L22/L33 (schema), `base.ts` L29 (tool result), `route.ts` L99 (stream)
- Say what the prompt injection (`.replace()`) actually does and where? → `monitoring.ts` L83–L86
- Name the tradeoff against bigger windows in one sentence?
- Distinguish context engineering from prompt engineering?

If you skipped any: you described it, you didn't understand it.

### Level 3 — Apply it to a new scenario
A user reports that the monitoring agent missed an obvious revenue drop in a workspace with 600 distinct event types. Without looking at the file: which of the three caps is the most likely culprit, and what would you check first to confirm? What would you change — the cap, the summary shape, or add a retrieval tool — and why?

Write your answer (3–5 sentences). Then open `lib/agents/monitoring.ts` L16–L49 and check whether the schema summary's structure could plausibly hide a `purchase` event in that workspace's top 20.

### Level 4 — Defend the decision you'd change
"If you were starting today with the same MCP limit and a 200K context window, would you still apply hard caps on schema and tool results, or would you let the window fill and let the model pick what to attend to? Why? If you'd remove the caps, what would you replace them with to keep latency and reasoning quality bounded?"

Reference the code: point to `monitoring.ts` L16 for the schema summary and `base.ts` L29 for the tool-result cap.

### Quick check — code reference test
Without opening any files:
- What file holds `schemaSummary()` and roughly what line?
- What constant in `base.ts` bounds tool-result size?
- What's the name of the function that filters MCP tools to a per-agent subset?
- Roughly what cap does the route's stream payload use?

Open and verify. ✓ File + function names matter; line numbers drifting is fine.

## See also

→ `02-agent-memory-tiers.md` · → `03-tool-calling-and-mcp.md` · → `05-guardrails-and-control.md` · → mechanics: `../../study-ai-engineering/02-context-and-prompts/01-context-window.md` · → `../../study-ai-engineering/02-context-and-prompts/02-lost-in-the-middle.md`

---
Updated: 2026-05-29 — created
Updated: 2026-05-30 — Migrated to study.md v1.47 template (Phase 1+2 mechanical): removed Tradeoffs / Tech reference / Summary sections; renamed "In this codebase" → "Implementation in codebase"; moved See also to a bottom block. "Why care" preserved pending Phase 3 (Zoom out, then zoom in + LAYERS diagram) authoring.
Updated: 2026-05-30 — Phase 3 of study.md v1.47 migration: replaced "Why care" block with "Zoom out, then zoom in" (LAYERS diagram + zoom-in paragraph) per format.md.
Updated: 2026-05-31 — Applied study.md v1.48: scrubbed "How it works" of file paths, line refs, and real-code fences; replaced with generic role labels + pseudocode per format.md. Codebase-specific anchoring lives exclusively in "Implementation in codebase".
Updated: 2026-05-31 — Applied study.md v1.50: added Structure pass block (layers · axis · seams) between Zoom out and How it works per format.md's new Block 3.
