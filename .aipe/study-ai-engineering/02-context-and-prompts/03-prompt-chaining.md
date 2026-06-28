# 03 — prompt chaining

**Subtitle:** Multi-agent pipeline as the product · Project-specific (load-bearing)

## Zoom out, then zoom in

The whole product is a chain: **monitoring → diagnostic → recommendation**.
Three separate agent loops, each with its own prompt, tools, and validator.
The diagnostic's output becomes the recommendation's input; the recommendation
gets the diagnosis JSON pasted into its prompt context.

The investigate UI further splits the diagnose step from the recommend step
into two separate `/api/agent` calls — so the user can stop after step 2 if
they only wanted the diagnosis.

```
  Zoom out — the chain is the product

  ┌─ Feed (/api/briefing) ─────────────────────────────────┐
  │  monitoring agent (one loop)                           │
  │  → Anomaly[] → derived to Insight[] → render cards    │
  └──────────────────────┬─────────────────────────────────┘
                         │ user clicks an insight
                         ▼
  ┌─ /api/agent?step=diagnose ─────────────────────────────┐  ← step 2
  │  diagnostic agent (one loop)                           │
  │  → Diagnosis → emit { type: 'diagnosis', diagnosis }   │
  │  → emit { type: 'done' }                               │
  │  (recommendation NOT run yet)                          │
  └──────────────────────┬─────────────────────────────────┘
                         │ user clicks "see recommendations"
                         ▼
  ┌─ /api/agent?step=recommend&diagnosis=… ────────────────┐  ← step 3
  │  recommendation agent (one loop)                       │
  │  → Recommendation[] → emit per-rec                     │
  └────────────────────────────────────────────────────────┘
```

## Structure pass

  → **One axis to trace — handoff.** Each chain step takes typed input from
    the previous step and produces typed output for the next. Monitoring
    produces `Anomaly`; diagnostic takes `Anomaly` + produces `Diagnosis`;
    recommendation takes `Anomaly` + `Diagnosis` and produces
    `Recommendation[]`. The handoff carries through the NDJSON wire and
    sessionStorage (across browser navigations).

  → **Two seams to name:**
    1. Diagnostic → recommendation handoff via the wire. The
       `diagnosisParam` URL parameter carries the JSON across the page
       transition (`app/api/agent/route.ts:267-272` shows the parse).
    2. Monitoring → diagnostic handoff via the `insightParam` URL
       parameter (`app/api/agent/route.ts:35-60` resolves the anomaly).
       Both use the browser's sessionStorage as the *durable* layer because
       Vercel's per-instance memory doesn't survive across requests.

## How it works

### Move 1 — the mental model

You've written this pattern as a Promise chain: `f(x).then(g).then(h)`.
Same shape here, except `f`, `g`, `h` are each multi-turn LLM loops, and
the chain is split across multiple HTTP requests so the user can interrupt
between steps.

```
  The chain — three loops, two handoffs

       monitoring loop
            │
            ▼  emits Anomaly[]
       ┌────────────────────┐
       │ snapshot / wire    │  ← handoff 1
       │ (sessionStorage)   │
       └─────────┬──────────┘
                 │  user click
                 ▼
       diagnostic loop
            │
            ▼  emits Diagnosis
       ┌────────────────────┐
       │ snapshot / wire    │  ← handoff 2
       │ (sessionStorage)   │
       └─────────┬──────────┘
                 │  user click
                 ▼
       recommendation loop
            │
            ▼  emits Recommendation[]
```

The big design choice: **handoffs are explicit, durable, and parsed at the
seam, not held in agent memory.** Each step is a fresh agent loop with its
own conversation. The previous step's output gets pasted into the next
step's prompt as text. No shared model state.

### Move 2 — the step-by-step walkthrough

**Step 1 — monitoring.** Runs in `/api/briefing` (`app/api/briefing/route.ts`,
not shown here in full). Output: `Anomaly[]` → derived to `Insight[]` via
`lib/insights/derive.ts` → streamed as `{ type: 'insight', insight }`
events. Each insight is stashed in `sessionStorage` by `stashInsights()`
(`lib/hooks/useBriefingStream.ts:53-60`):

```typescript
function stashInsights(list: Insight[]): void {
  if (typeof window === 'undefined') return;
  try {
    for (const i of list) sessionStorage.setItem(`bi:insight:${i.id}`, JSON.stringify(i));
  } catch { /* sessionStorage full/blocked */ }
}
```

This is handoff #1 in flight. The insight survives across browser
navigations because sessionStorage is the most-trusted store on the
client; Vercel's per-instance memory can't be relied on across
serverless invocations.

**Step 2 — diagnostic.** When the user clicks an insight in the feed, the
client navigates to `/investigate/[id]` and the page hits
`/api/agent?insightId=…&insight=<json>&step=diagnose`. The route resolves
the anomaly (preferring `insight` URL param > in-memory > demo snapshot;
see `01-llm-foundations/07-heuristic-before-llm.md`) and runs only the
diagnostic agent:

```typescript
// app/api/agent/route.ts:267-285
if (step === 'recommend') {
  diagnosis = parseDiagnosis(diagnosisParam);
  if (!diagnosis) throw new Error('no diagnosis was handed over…');
} else {
  // step === 'diagnose' OR combined run
  stepFor('diagnostic', 'thought', `investigating "${inv.metric}"…`);
  const diagAgent = new DiagnosticAgent(anthropic, dataSource, schema, allTools, sid);
  diagnosis = await diagAgent.investigate(inv, { ...hooksFor('diagnostic'), signal: req.signal });
  send({ type: 'diagnosis', diagnosis });
}

if (step !== 'diagnose') {
  // step === 'recommend' OR combined: run the recommendation agent
  // …
}
```

The branching on `step` is what makes the chain *splittable*. When `step ===
'diagnose'`, the route emits the diagnosis and stops — `done` fires without
running the recommendation. The user gets to read the diagnosis,
chart the time series, decide whether to invest in the recommendation, and
optionally click forward.

**The handoff back to the client.** The diagnosis is captured in the
streamed `{ type: 'diagnosis', diagnosis }` event. The
`useInvestigation` hook stashes the result in `sessionStorage` so the
recommend step can read it without re-running diagnostic.

**Step 3 — recommendation.** When the user clicks "see recommendations →"
the page navigates to `/investigate/[id]/recommend` and that page hits
`/api/agent?insightId=…&step=recommend&diagnosis=<json>`. The route
reads the diagnosis from the URL param via `parseDiagnosis`
(`app/api/agent/route.ts:84-95`):

```typescript
function parseDiagnosis(param: string | null): Diagnosis | null {
  if (!param) return null;
  try {
    const d = JSON.parse(param);
    if (d && typeof d.conclusion === 'string'
        && Array.isArray(d.evidence)
        && Array.isArray(d.hypothesesConsidered)) {
      return d as Diagnosis;
    }
  } catch { /* ignore */ }
  return null;
}
```

If the diagnosis isn't present (e.g. user deep-linked to step 3 directly),
the route throws `"no diagnosis was handed over — open the diagnosis step
first"`. The chain enforces ordering: you can't get a recommendation
without a diagnosis.

**Where the diagnosis enters the recommendation prompt.** Inside AptKit's
`RecommendationAgent.propose(anomaly, diagnosis, hooks)`, the diagnosis JSON
gets interpolated into the recommendation prompt at the `{diagnosis}`
placeholder (see `lib/agents/legacy-prompts/recommendation.md` — the prompt
text is in repo for reference, even though AptKit owns the live prompt
template). The recommendation agent then has the full context: the original
anomaly, the diagnostic's conclusion + evidence, the hypotheses considered,
the affected-customers segment.

**The combined-run path.** For the demo-capture flow (`/api/mcp/capture`),
the route runs both agents back-to-back in one stream (`step == null`
branch). The output is saved to disk for replay. This is the only path that
runs the full chain in one HTTP request.

**Why split into two HTTP requests for the UI?** Three reasons:

  1. **User control.** Diagnosis takes ~30-60s; the user might be satisfied
     with just the diagnosis. Splitting saves the recommendation's cost
     (~$0.12 + ~30s) when they aren't going to look at it.

  2. **Latency budget.** Vercel Pro's `maxDuration = 300s` is generous but
     not infinite. Two ~60s steps each have their own 300s budget; one
     combined step has one budget for both.

  3. **Recovery.** If the recommendation step errors (auth expired, etc.),
     the diagnosis is preserved in sessionStorage. The user can retry just
     the recommend step without re-running diagnostic.

### Move 3 — the principle

**Chain explicitly across HTTP requests when each step is independently
useful, expensive, and the handoff is small.** Each step has its own prompt,
own tool allowlist, own validator. The handoff is JSON that fits in a URL
param (a few KB at most). The user sees the intermediate result and
decides whether to continue.

The opposite shape — one giant agent with all the tools and one big prompt —
is what most agent demos do. It works in toy form. In production it
collapses: the prompts get unmanageable, the eval surface explodes (you
can't measure diagnosis quality independent of recommendation quality), and
the user has no point of intervention. The chain is what makes the surface
shippable.

## Primary diagram

```
  The chain end-to-end, with handoff mechanism per seam

  ┌─ Server: monitoring agent (briefing) ──────────────────┐
  │  prompt: lib/agents/legacy-prompts/monitoring.md       │
  │  tools:  monitoringTools (13)                          │
  │  output: Anomaly[]                                     │
  └──────────────────────┬─────────────────────────────────┘
                         │ Anomaly stream events
                         ▼
  ┌─ Wire: NDJSON ─────────────────────────────────────────┐
  │  { type: 'insight', insight } per anomaly              │
  └──────────────────────┬─────────────────────────────────┘
                         │
                         ▼
  ┌─ Client: useBriefingStream → stashInsights ────────────┐
  │  sessionStorage[`bi:insight:${id}`] = JSON.stringify(i)│  ← HANDOFF 1
  └──────────────────────┬─────────────────────────────────┘
                         │ user clicks card
                         ▼
  ┌─ Client navigation ────────────────────────────────────┐
  │  router.push(`/investigate/${id}?insight=${encoded}`)  │
  └──────────────────────┬─────────────────────────────────┘
                         │
                         ▼
  ┌─ Server: diagnostic agent (step=diagnose) ─────────────┐
  │  resolves anomaly from ?insight= param                 │
  │  prompt: lib/agents/legacy-prompts/diagnostic.md       │
  │  tools:  diagnosticTools (17)                          │
  │  output: Diagnosis                                     │
  │  emits  { type: 'diagnosis', diagnosis }, then done    │
  └──────────────────────┬─────────────────────────────────┘
                         │
                         ▼
  ┌─ Client: useInvestigation → sessionStorage stash ──────┐
  │  sessionStorage[`bi:diagnosis:${id}`] = JSON.stringify │  ← HANDOFF 2
  └──────────────────────┬─────────────────────────────────┘
                         │ user clicks "see recommendations →"
                         ▼
  ┌─ Client navigation ────────────────────────────────────┐
  │  router.push(`/investigate/${id}/recommend                  │
  │              ?diagnosis=${encoded}`)                   │
  └──────────────────────┬─────────────────────────────────┘
                         │
                         ▼
  ┌─ Server: recommendation agent (step=recommend) ────────┐
  │  parses diagnosis from ?diagnosis= param               │
  │  prompt: lib/agents/legacy-prompts/recommendation.md   │
  │  tools:  recommendationTools (8)                       │
  │  output: Recommendation[]                              │
  │  emits  { type: 'recommendation' } per rec, then done  │
  └────────────────────────────────────────────────────────┘
```

## Elaborate

The two-handoff split was a deliberate UX decision motivated by the
diagnostic step being the highest-value individual step. Many users (in
demo scripts and feedback) get what they need from the diagnosis alone —
"oh, the conversion drop was in Brazil" — and don't always want to go
through the recommendation flow. Splitting the route lets the chain
*stop early* without wasting recommendation cost.

A consequence: the combined run only happens during demo capture
(`/api/mcp/capture`). The demo replay can fake the user "always continuing"
because the snapshot has both diagnosis and recommendations. Live flow lets
users choose.

The choice to handoff via URL params (sessionStorage backing) rather than
server-side persistence reflects the stateless serverless constraint.
Storing the diagnosis in a server-side map keyed by sessionId works on
dev (where Next reuses the same Node process) and breaks on Vercel (where
the same session can land on different Lambda instances per request).
sessionStorage on the client is the most-trusted store that survives both.

## Project exercises

### Exercise — add a "redo diagnostic" affordance that re-runs only step 2

  → **Exercise ID:** `study-ai-eng-02-03.1`
  → **What to build:** Add a "redo with new prompt"-style button on the
    diagnosis panel that re-runs the diagnostic agent (perhaps with a
    user-supplied hypothesis hint as additional input) without re-running
    the monitoring agent. Demonstrates that each chain step is
    independently re-runnable.
  → **Why it earns its place:** Highlights the chain's separability. An
    interviewer asking "how would you let the user steer the diagnostic?"
    has a clean answer: it's already a separate route call, just add a
    hint param.
  → **Files to touch:** `app/api/agent/route.ts` (accept `hint` param),
    `lib/agents/diagnostic.ts` (thread the hint into AptKit options),
    AptKit may need a `userHint` field on `DiagnosticInvestigationAgent`,
    `app/investigate/[id]/page.tsx` (UI).
  → **Done when:** User enters a hint ("focus on mobile users"), the
    diagnostic re-runs with that bias, the diagnosis JSON returns with
    the hint reflected in `evidence` or `hypothesesConsidered`.
  → **Estimated effort:** `1–2 days`

### Exercise — add a deep-link guard

  → **Exercise ID:** `study-ai-eng-02-03.2`
  → **What to build:** When the user deep-links to
    `/investigate/[id]/recommend` without going through diagnosis first,
    detect missing diagnosis in sessionStorage and either (a) redirect to
    `/investigate/[id]` (the diagnose step) or (b) auto-run the
    diagnostic in the background. Today the route throws an error.
  → **Why it earns its place:** The chain enforces ordering at the server
    (good); the UI doesn't *help* the user respect the ordering (bad).
  → **Files to touch:** `app/investigate/[id]/recommend/page.tsx`,
    `lib/hooks/useInvestigation.ts`.
  → **Done when:** Deep-linking to step 3 without a stashed diagnosis no
    longer surfaces an error panel; either auto-runs step 2 or routes the
    user there.
  → **Estimated effort:** `1–4hr`

## Interview defense

**Q: How is blooming insights structured — is it one agent or many?**

A chain of three: **monitoring → diagnostic → recommendation**, plus the
free-form QueryAgent and the intent classifier. Each is a separate AptKit
agent class with its own prompt, tools, and validator. The investigate UI
splits the diagnose and recommend steps into separate `/api/agent` HTTP
requests so users can stop after the diagnosis.

```
  Why splittable:
   - diagnostic alone is the highest-value step
   - splitting saves ~$0.12 + ~30s when user doesn't want recs
   - each step has its own 300s Vercel budget
   - failure in step 3 doesn't lose step 2's work
```

**Anchor line:** "Three agents, two HTTP-bounded handoffs. The
diagnosis-to-recommendation handoff is a URL param, backed by
sessionStorage on the client."

**Q: What's the load-bearing part of the chaining?**

The two handoffs being **explicit and durable**. The diagnosis JSON survives
the page navigation because it's stashed in sessionStorage AND passed
through the URL param to the next route call. The route refuses to run the
recommendation step without a diagnosis. The chain enforces ordering by
construction — `/api/agent?step=recommend` without a diagnosis param throws,
not 500s on a missing field deep in the agent loop.

**Anchor line:** "The handoff is JSON in a URL param backed by
sessionStorage. The server validates the JSON before running the next agent.
That's what makes the chain composable instead of brittle."

**Q: Why not one giant agent with all the tools?**

Three reasons that show up immediately:
- The prompt gets unmanageable (28 tools, four output shapes, three intents).
- Eval surface explodes — you can't measure diagnosis quality without
  measuring recommendation quality at the same time.
- The user has no point of intervention — they have to commit to the full
  chain or nothing.

The chain trades a slightly more complex orchestration layer (handoff
parsing, state stashing) for cleaner per-agent prompts, independent eval
surface, and user control.

## See also

  → `01-context-window.md` — the budget *per chain step* (not summed)
  → `04-agents-and-tool-use/01-agents-vs-chains.md` — the chain-vs-loop distinction
    at the level WITHIN one step
  → `01-llm-foundations/07-heuristic-before-llm.md` — the gates that run BEFORE
    each chain step's LLM
