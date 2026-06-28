# Routing

*Industry name: routing / intent classification / dispatcher — Industry standard.*

Pick the right handler before committing to a loop. This repo uses TWO routers — a *URL-based heuristic router* in `app/api/agent/route.ts` (the `?step=` param picks the agent class) and an *LLM-based intent router* in `lib/agents/intent.ts` (a cheap haiku call labels free-form questions).

## Zoom out — where this concept lives

Both routers live at the service layer, in front of the agent layer. The URL router decides which agent runs; the intent router labels a question so the downstream agent's prompt has the right framing.

```
  Where routing lives in blooming insights

  ┌─ UI layer ──────────────────────────────────────────────┐
  │  POST /api/agent?step=diagnose       ←  URL is the route│
  │  POST /api/agent?q=...               ←  no step; free-form
  └─────────────────────┬───────────────────────────────────┘
                        ▼
  ┌─ Service / Routing layer ───────────────────────────────┐
  │  app/api/agent/route.ts                                  │
  │   ┌─ heuristic router (URL) ──────────────────────────┐ │
  │   │  if (step === 'recommend')  → RecommendationAgent │ │ ← we are here
  │   │  if (step === 'diagnose')   → DiagnosticAgent     │ │
  │   │  if (q && !insightId)       → ★ intent router ★   │ │
  │   └────────────────────────────────────────────────────┘ │
  │                          ↓ q + intent                    │
  │   ┌─ LLM router (intent.ts) ───────────────────────────┐│
  │   │  classifyIntent(haiku) → 'monitoring' | 'diagnostic'│
  │   │                        | 'recommendation'           │ │
  │   └─────────────────────────────────────────────────────┘│
  └──────────────────────────────────────────────────────────┘
                             ▼ (single agent class)
  ┌─ Agent layer ───────────────────────────────────────────┐
  │  QueryAgent  ← receives `intent` to frame the answer    │
  └──────────────────────────────────────────────────────────┘
```

## Structure pass

The axis: **what does each router decide?**

```
  URL router (heuristic, deterministic):
  ──────────────────────────────────────
  → which AGENT CLASS to instantiate
  → DiagnosticAgent vs RecommendationAgent vs QueryAgent
  → no LLM call; just `if (step === 'X')`
  → cost: zero tokens, zero latency

  Intent router (LLM, classifier):
  ──────────────────────────────────────
  → which FRAMING to use for the QueryAgent's prompt
  → does NOT pick a different agent — picks the prompt's `{intent}` slot
  → one haiku call, no tools
  → cost: ~1K tokens, ~300ms

  Both are routing patterns. Different decisions, different costs.
```

## How it works

### Move 1 — the mental model

Heuristic-first then LLM-fallback is the production answer. You know the React pattern of "render a fast loading skeleton, then hydrate with the real data" — same shape. Cheap deterministic dispatch for the predictable cases (the URL parameter), LLM call only when the input is ambiguous (free-form Q&A).

```
  Routing — heuristic first, LLM fallback

  Input
    │
    ▼
  ┌─────────────────────┐
  │ Heuristic router    │ fast, deterministic
  │ (URL ?step=…)       │ (this repo: a URL param)
  └─────────┬───────────┘
            │ no clear match
            │ (e.g. free-form Q&A with no step)
            ▼
  ┌─────────────────────┐
  │ LLM router          │ classify intent
  │ (claude-haiku-4-5)  │ → 'monitoring' | 'diagnostic'
  └─────────────────────┘   | 'recommendation'
```

### Move 2 — walk both routers

**The URL router lives in `app/api/agent/route.ts`.**

The relevant lines (paraphrased from the file):

```typescript
// app/api/agent/route.ts:113-119 — read the route params
const insightId = req.nextUrl.searchParams.get('insightId');
const q = req.nextUrl.searchParams.get('q')?.trim() || null;
const stepParam = req.nextUrl.searchParams.get('step');
const step: Step | null = stepParam === 'diagnose' || stepParam === 'recommend' ? stepParam : null;

// app/api/agent/route.ts:247 — first branch: free-form query
if (q && !insightId) {
  // intent router runs here, then QueryAgent
}

// app/api/agent/route.ts:267 — branch on step
if (step === 'recommend') { /* RecommendationAgent only */ }
else { /* DiagnosticAgent */ }
if (step !== 'diagnose') { /* RecommendationAgent */ }
```

What this is: pure TypeScript `if`/`else` deciding which agent class to construct. No LLM involved. The URL is the dispatch key.

**The LLM router lives in `lib/agents/intent.ts`.**

The whole file is 39 lines. Here's the live entry point:

```typescript
// lib/agents/intent.ts:16-38
const CLASSIFIER_MODEL = 'claude-haiku-4-5-20251001';

export async function classifyIntent(
  anthropic: Anthropic,
  query: string,
  sessionId?: string,
  signal?: AbortSignal,
): Promise<Intent> {
  return classifyAptKitIntent(
    new AnthropicModelProviderAdapter(
      anthropic,
      'coordinator',
      sessionId,
      CLASSIFIER_MODEL,
      'agents/intent:classifyIntent',
    ),
    query,
    { signal },
  );
}
```

What this is: a single LLM call to a cheap-and-fast model (`claude-haiku-4-5-20251001`), classifying the query into one of three intents. NO tools, NO loop — just classification.

The result flows into the QueryAgent's prompt as the `{intent}` slot — from `@aptkit/prompts/query.d.ts`:

> "The user's question has been classified as {intent}: monitoring = what changed / what's new; diagnostic = why did something happen; recommendation = what should I do. Use that classification to frame your answer, but answer the actual question the user asked."

The intent doesn't pick a different agent — the QueryAgent handles all three intents — it frames the answer.

**Why split routing across two layers?**

The investigation flow has a predictable URL shape — the user clicks a card, goes to step 2, then step 3. The URL already knows which step. Burning an LLM call to re-classify "the user is on the diagnose page" would be waste. The URL router handles it for free.

The free-form Q&A flow has no predictable shape — the user types whatever they want. Here, the heuristic router has nothing to dispatch on, so it falls through to the LLM router. Production pattern in action: heuristic at the front for the high-volume predictable routes, LLM at the back for the ambiguous ones.

### Move 3 — the principle

Routing is the bridge from single-agent to multi-agent: in a single-agent system it picks a tool; in a multi-agent system it picks an agent. The cost story is always "is this dispatch worth an LLM call?" When the answer is no (URL param, MIME type, file extension), use the heuristic. When the answer is yes (free-form text the user typed), use the LLM — and use the cheapest model that can do the classification, because routing is hot-path on every request.

## Primary diagram

Both routers in action across the two flows the repo supports:

```
  Routing in blooming insights — two flows, two routers

  Flow 1: investigation (heuristic router only)
  ─────────────────────────────────────────────
  click card → /api/agent?insightId=X&step=diagnose
                                    │
                                    ▼
                          ┌────────────────────┐
                          │ URL router (route) │
                          │  step==='diagnose'  │
                          └─────────┬──────────┘
                                    ▼
                            DiagnosticAgent
                            (no intent classification needed)

  Flow 2: free-form Q&A (heuristic falls through to LLM router)
  ─────────────────────────────────────────────────────────────
  type question → /api/agent?q=...&step=null
                            │
                            ▼
                  ┌────────────────────┐
                  │ URL router         │
                  │  step===null       │ → "fall through to intent"
                  │  q && !insightId   │
                  └─────────┬──────────┘
                            ▼
                  ┌────────────────────┐
                  │ LLM intent router  │
                  │  haiku, no tools   │
                  │  ~300ms, ~1K tokens│
                  └─────────┬──────────┘
                            ▼ intent: 'monitoring'|'diagnostic'|'recommendation'
                  ┌────────────────────┐
                  │ QueryAgent.answer  │
                  │ (intent in prompt) │
                  └────────────────────┘
```

## Elaborate

Routing as a named pattern shows up everywhere LLMs touch product UX. The split between heuristic-front and LLM-back is the production wisdom from teams who tried "just put an LLM in front" and watched their bill explode — most user requests have predictable shape (a URL param, a referrer, a session state) that doesn't need a language model to disambiguate. Burning the haiku call only when the heuristic has nothing to say is the cheap path.

The model choice for the LLM router is its own little decision. The job is classification, not generation — a small, fast model (Haiku, GPT-4o-mini) does it for ~10x less than the production model. This repo uses `claude-haiku-4-5-20251001` for the intent classifier specifically because its job is "pick one of three labels," which is closer to a `String -> Enum` cast than a reasoning task.

The next step past this pattern is *retrieval routing* (`../02-agentic-retrieval/03-retrieval-routing.md` — not in this repo) where the router decides which knowledge source to query. The same heuristic-first principle applies there.

## Interview defense

**Q: "Why two routers and not one LLM that dispatches everything?"**

A: Cost and latency. The investigation flow has a deterministic URL shape — the user clicked a card, the URL knows they're on the diagnose step. Routing that through an LLM would burn a haiku call (~300ms, ~1K tokens) for free information. The URL router handles it in TypeScript with an `if`. The LLM router only runs when the input is *genuinely ambiguous* — free-form text the user typed in the QueryBox. That's the production pattern: heuristic at the front for predictable routes, LLM at the back for ambiguous ones.

The diagram I'd sketch:

```
  input
    │
    ▼
  heuristic (URL ?step=…)  → if it knows, ship it (zero cost)
    │ falls through (no match)
    ▼
  LLM (haiku)             → only for "what did the user actually mean"
```

Anchor: "the URL is the route in the investigation flow; the intent classifier only fires on `q && !insightId` — that's the line in `route.ts:247` where the heuristic gives up and the LLM takes over."

**Q: "Why does the intent classifier not pick a different agent?"**

A: Because the agent surface is one — `QueryAgent` handles all three intents (monitoring / diagnostic / recommendation). The intent is a *framing label*, not a dispatch key. The QueryAgent's prompt has an `{intent}` slot that tells it how to frame the answer; the tool grant (the union of all four agent policies' tools) is the same regardless. If we ever found that the framing wasn't strong enough — that a diagnostic-intent query needed the actual DiagnosticAgent's narrower tool grant and stricter prompt — that's when the intent classifier would graduate from "frame the prompt" to "pick the agent class." Hasn't been needed.

## See also

- [`01-chains-vs-agents.md`](./01-chains-vs-agents.md) — the URL router is the chain part of the system
- [`../03-multi-agent-orchestration/02-supervisor-worker.md`](../03-multi-agent-orchestration/02-supervisor-worker.md) — supervisor's core job is the same routing primitive at a different layer
- [`../02-agentic-retrieval/03-retrieval-routing.md`](../02-agentic-retrieval/03-retrieval-routing.md) — routing applied to picking knowledge sources
