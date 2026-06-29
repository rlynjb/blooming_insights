# Agent memory

*Industry standard — short-term (in-context) vs long-term (retrieved)*

## Zoom out — where this concept lives

The classic split: short-term memory is what fits in the context window for this run; long-term memory is anything persistent across sessions (vector DB, conversation history, user preferences). **This codebase has only short-term memory**, and even that is limited to within-a-single-invocation (the AptKit loop's accumulating message history). There is no cross-session memory.

```
  Zoom out — what memory exists in this codebase

  ┌─ Within a single agent invocation ──────────────────────┐
  │  message history grows turn by turn                      │
  │  (tool_use + tool_result blocks accumulate)              │
  └──────────────────────┬──────────────────────────────────┘
                         │  ends at agent.return()
                         ▼
  ┌─ ★ Between agents in the same investigation ★ ──────────┐ ← we are here
  │  Diagnosis object passed from step 2 → step 3           │
  │  via sessionStorage + query param                       │
  │  this IS the long-term memory in this codebase          │
  └──────────────────────┬──────────────────────────────────┘
                         │  ends at the browser tab closing
                         ▼
  ┌─ Between sessions ──────────────────────────────────────┐
  │  NOTHING. No vector DB, no user history, no             │
  │  conversation-across-sessions, no persisted preferences │
  └─────────────────────────────────────────────────────────┘
```

**Zoom in.** The "memory" between agents in this codebase is a typed structured handoff (the `Diagnosis` object). No agent has memory of *prior* sessions; every briefing is fresh; every investigation starts from the anomaly + workspace shape and accumulates only within itself.

## Structure pass — layers · axes · seams

**Layers:** within-agent → between-agents (within investigation) → cross-session.

**Axis: how long does memory last?** Within-agent: seconds (one invocation). Between-agents: minutes (one investigation, one browser tab). Cross-session: NONE.

**Seam:** the `Diagnosis` handoff (`02-context-and-prompts/03-prompt-chaining.md`) is the memory between agents. SessionStorage + query param is the persistence layer.

## How it works

### Move 1 — the mental model

You know how a Python REPL forgets everything between sessions but remembers what you typed in this session? Same shape — every variable persists across calls *within* the REPL, but once you close it, gone. This codebase's agents are like that — they remember within a session but not across.

```
  Three altitudes of memory, only two exist here

  ┌─ Short-term, within agent ────────────────────────────┐
  │  Loop's message history                                │  EXISTS — AptKit's
  │  - assistant text (Thoughts)                          │  internal accumulator
  │  - tool_use blocks (Actions)                          │
  │  - tool_result blocks (Observations)                  │
  │  Disappears when agent.invoke() returns               │
  └────────────────────────────────────────────────────────┘
  ┌─ Mid-term, between agents in same investigation ───────┐
  │  Diagnosis object handoff                              │  EXISTS — see
  │  - structured (typed)                                  │  02-context-and-prompts/
  │  - browser sessionStorage + query param                │  03-prompt-chaining.md
  │  Disappears when browser tab closes                    │
  └────────────────────────────────────────────────────────┘
  ┌─ Long-term, across sessions ───────────────────────────┐
  │  Past investigations                                   │  NOT EXERCISED
  │  Past anomalies                                        │  no DB, no vector store,
  │  User-specific preferences ("show me USA first")       │  no user-history persistence
  │  → would require: vector DB + retrieval per session    │
  └────────────────────────────────────────────────────────┘
```

### Move 2 — the step-by-step walkthrough

**Part 1 — short-term: the message history inside one agent invocation.**

When `diagAgent.investigate(anomaly)` runs, AptKit maintains a message history that grows with every iteration:

```
  Iteration 1 messages:
   [ system, user("investigate this anomaly: …") ]

  After iteration 1 tool call:
   [ system,
     user(...),
     assistant({ text, tool_use("execute_analytics_eql", ...) }),
     user({ tool_result(...) }) ]

  After iteration 2:
   [ system, user, assistant, user,
     assistant({ text, tool_use("get_funnel", ...) }),
     user({ tool_result(...) }) ]

  ... and so on, until the LLM emits no tool_use → loop exits
```

The history is the agent's memory for this invocation. By iteration N, the prompt carries the full accumulated context. This is bounded by AptKit's iteration cap (no infinite growth).

**Part 2 — mid-term: the Diagnosis handoff.**

When the diagnostic agent finishes, it returns a `Diagnosis`. The route emits it as a `'diagnosis'` event on the stream; the browser stashes it in sessionStorage. When the user clicks "see recommendations →", the diagnosis goes back to the server as a query param and the recommendation agent receives it as structured input.

From `app/api/agent/route.ts:81-92` (the validator):

```typescript
function parseDiagnosis(param: string | null): Diagnosis | null {
  if (!param) return null;
  try {
    const d = JSON.parse(param);
    if (d && typeof d.conclusion === 'string' && Array.isArray(d.evidence) && Array.isArray(d.hypothesesConsidered)) {
      return d as Diagnosis;
    }
  } catch { /* ignore */ }
  return null;
}
```

The Diagnosis is structured, validated, and limited in scope (one investigation's findings). It's NOT a free-form conversation buffer; it's a typed object the recommendation agent treats as a fact.

**Part 3 — long-term: nothing exists today.**

```
  What this codebase explicitly does NOT have:

  - No 'past investigations' surface — the briefing shows TODAY's anomalies only.
  - No user profile — there's no per-user history of "what this user asked about".
  - No conversation history across sessions — every chat query starts fresh.
  - No vector DB — see 03-retrieval-and-rag/03-rag-concepts-not-yet-exercised.md
  - No preferences — "the user always wants USA first" isn't a notion the agents know.

  The in-memory state at lib/state/insights.ts:62 is per-process, cleared
   on every briefing run (putInsights() calls .clear() per session).
   That's a feed-state cache, not memory.
```

**Part 4 — why no long-term memory yet.**

Two reasons. First, the user pattern hasn't asked for it — analysts run a briefing each morning, investigate what looks interesting, and don't currently say "remind me about that thing from last week." Second, the storage layer doesn't exist — adding a vector DB or even a Postgres table is a sizeable lift relative to the current "no DB, in-memory + session cookies" shape (see `study-system-design`).

The natural shape if it lands: a per-user `Map<userId, PastInvestigation[]>` stored in something like Vercel KV (or Postgres), with optional vector retrieval over past diagnoses if "find me similar past anomalies" becomes a feature.

### Move 3 — the principle

**Memory has altitudes; pick the altitude that matches what the product needs.** Most LLM-app conversations about "agent memory" assume long-term persistence. This codebase deliberately stays in the short-term + mid-term band because the product is investigation-shaped, not chat-shaped. Honest framing: long-term memory isn't missing; it's not needed.

## Primary diagram — the full recap

```
  Three altitudes of memory in this codebase

  Short-term (per agent invocation):
   ┌─ AptKit loop's message history ────────────────────────┐
   │  accumulates: system + user + (assistant + user)*       │
   │  bounded by: iteration cap                              │
   │  lifetime:   seconds; cleared at agent.return()         │
   └─────────────────────────────────────────────────────────┘

  Mid-term (within one investigation):
   ┌─ Diagnosis handoff ────────────────────────────────────┐
   │  step 2 emits Diagnosis → sessionStorage                │
   │  → query param on step-3 nav                            │
   │  → parseDiagnosis at route boundary                     │
   │  → recommendation agent receives structured input       │
   │  bounded by: typed shape (conclusion, evidence,         │
   │              hypothesesConsidered)                      │
   │  lifetime:   minutes; cleared at tab close              │
   └─────────────────────────────────────────────────────────┘

  Long-term (cross-session):
   ┌─ NOT EXERCISED ─────────────────────────────────────────┐
   │  Would require: persistent storage + retrieval surface  │
   │  Natural shape: per-user investigations array, optional │
   │                  vector retrieval over past diagnoses   │
   │  Why not today: product is investigation-shaped, not   │
   │                  chat-shaped — analysts don't ask       │
   │                  follow-ups across sessions             │
   └─────────────────────────────────────────────────────────┘
```

## Elaborate

**Why structured handoff beats free-form memory.** The recommendation agent receives a `Diagnosis` object, not a "here's everything the diagnostic agent thought" message dump. Three benefits:

  1. **Typed contract.** `parseDiagnosis()` validates the shape; malformed input fails loudly.
  2. **Smaller prompt.** The recommendation agent's prompt embeds the diagnosis as structured fields, not as a transcript. Saves tokens.
  3. **Testable seam.** A test can construct a `Diagnosis` directly and call `RecommendationAgent.propose()` — no need to first run the diagnostic agent.

Free-form conversation memory ("the agent remembers everything that's been said") trades all three of those for flexibility you don't need at this product shape.

**Where long-term memory would land if added.** Two surfaces would benefit most:

  1. **"Show me similar past anomalies."** Vector retrieval over past diagnoses' `conclusion` field. Adds context to a fresh investigation without re-running prior work.
  2. **User preferences in the prompt.** "This user always cares about USA more than other countries" surfaces in the briefing agent's prompt. Light memory (per-user kv store), not a full vector DB.

Both are post-MVP territory. Adding them prematurely would saddle the codebase with storage complexity it doesn't need yet.

## Project exercises

### Exercise — Persist investigations to a queryable store with "show me past investigations" surface

  → **Exercise ID:** B4.5
  → **What to build:** Add a persistent store for completed investigations (Vercel KV or a SQLite file in dev). Each completed `Investigation` (anomaly + diagnosis + recommendations) is written when the chain finishes. Add a new feed surface — "past investigations" — that lists prior ones with filters (date range, severity, category). Optional: vector retrieval over diagnoses' `conclusion` field, exposed as a `search_past_investigations(query)` tool the query agent can call.
  → **Why it earns its place:** turns the "no cross-session memory" gap into a real product feature. Demonstrates the storage + retrieval pattern at a sane corpus size (one user's past investigations is small but useful). The optional vector layer puts the codebase's first taste of real RAG into a genuinely useful spot.
  → **Files to touch:** new `lib/state/past-investigations.ts` (the store), new `app/past/page.tsx` (the surface), `lib/agents/query.ts` (optional: add the new tool to the query agent's allowlist), `test/state/past-investigations.test.ts` (cover write + query + filter).
  → **Done when:** completed investigations land in the store, the past-investigations page renders them with filters, an opt-in vector-retrieval flag enables the query agent's new tool, and the test suite covers both the store and the optional retrieval.
  → **Estimated effort:** ≥1 week.

## Interview defense

**Q: "Does your agent have memory?"**

Three altitudes, two exist. Within an agent invocation, AptKit's loop maintains a message history — assistant text + tool_use + tool_result blocks accumulate, bounded by the iteration cap, gone when the agent returns. Between agents in the same investigation, the `Diagnosis` object hands off from step 2 to step 3 via `sessionStorage` + query param — typed, validated, scoped to one investigation, gone when the tab closes. Cross-session? Nothing. No vector DB, no user history, no conversation-across-sessions.

That's deliberate: the product is investigation-shaped (one anomaly at a time), not chat-shaped (an ongoing conversation). Long-term memory would solve a problem the product doesn't have yet.

*Anchor: "Two altitudes exist (in-loop + handoff); cross-session deliberately doesn't."*

**Q: "When would you add long-term memory?"**

Two triggers. (1) The product grows a "show me similar past anomalies" surface — that needs vector retrieval over past diagnoses. (2) Users start asking follow-up questions across sessions ("yesterday you said X, what about Y") — that needs conversation history per user. Until one of those happens, adding memory infrastructure is overhead without payoff. The `B4.5` exercise lays out the shape if it lands.

*Anchor: "Wait for the product trigger; don't add memory infrastructure speculatively."*

## See also

  → `02-context-and-prompts/03-prompt-chaining.md` — the Diagnosis handoff as a chain step
  → `03-retrieval-and-rag/03-rag-concepts-not-yet-exercised.md` — the vector retrieval gap that would underlie long-term memory
  → `study-system-design/07-in-memory-state-ownership.md` — the state ownership story this would extend
