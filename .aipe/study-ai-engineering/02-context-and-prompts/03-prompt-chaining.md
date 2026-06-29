# Prompt chaining

*Industry standard — multi-step prompt chain*

## Zoom out — where this concept lives

The investigate flow is a two-step chain: the diagnostic agent runs first (step 2 of the UI), then the recommendation agent runs second (step 3), with the `Diagnosis` object handed across as structured input. Each step has one job; each runs against its own tool surface; the cost and latency split across two clicks instead of one wait.

```
  Zoom out — the diagnose → recommend chain

  ┌─ User flow ──────────────────────────────────────────────┐
  │  click anomaly card → step 2 (investigate)               │
  │                       step 3 (see recommendations)       │
  └──────────────────────┬───────────────────────────────────┘
                         │
                         ▼
  ┌─ Step 2: Diagnostic ─────────────────────────────────────┐
  │  Input:  Anomaly                                         │
  │  Output: Diagnosis { conclusion, evidence, hypotheses }  │
  └──────────────────────┬───────────────────────────────────┘
                         │  Diagnosis handed over via sessionStorage
                         │  → query param `?diagnosis=…` on step 3
                         ▼
  ┌─ ★ Step 3: Recommendation ★ ─────────────────────────────┐ ← we are here
  │  Input:  Anomaly + Diagnosis                             │
  │  Output: Recommendation[]                                │
  └──────────────────────────────────────────────────────────┘
```

**Zoom in.** This is the canonical chain in the codebase. Two LLM agents, one structured handoff, two distinct tool surfaces. The cost is real (two full Sonnet runs instead of one combined), but the benefits — separation of concerns, click-paced UX, smaller per-step tool surface — are worth it.

## Structure pass — layers · axes · seams

**Layers:** step 2 agent → handoff format → step 3 agent.

**Axis: where does the chain's state live?** In the `Diagnosis` object passed between steps. Specifically: `sessionStorage` in the browser, then a query param on the step-3 navigation. The server side is stateless per request.

**Seam:** the `Diagnosis` shape itself (`lib/mcp/types.ts:93-103`). That's the contract between the two agents. If you ever want to insert another step between them (say, a "verify diagnosis" agent), it slots in at this seam.

## How it works

### Move 1 — the mental model

You know how a Unix pipeline `cmd1 | cmd2 | cmd3` splits work into independent stages? Same idea here. Each stage takes structured input, produces structured output, and hands off. The shape of the handoff is the contract — same way each pipe boundary is a byte stream.

```
  The chain — two LLM stages, structured handoff

  Anomaly                                                    Recommendation[]
      │                                                            ▲
      ▼                                                            │
  ┌──────────────────────┐    Diagnosis    ┌──────────────────────┐
  │  Stage 1:            │   (sessionStorage│  Stage 2:            │
  │  Diagnostic agent    │  → query param)  │  Recommendation agent│
  │                      │ ───────────────►│                      │
  │  - 17-tool surface   │                  │  - 7-tool surface    │
  │  - hypothesis-testing│                  │  - structured output │
  │  - emits Diagnosis   │                  │  - feature picker    │
  └──────────────────────┘                  └──────────────────────┘
        (step 2)                                      (step 3)
        ~$0.08, ~30s                                  ~$0.07, ~25s
```

### Move 2 — the step-by-step walkthrough

**Part 1 — step 2 emits a typed Diagnosis.**

The diagnostic agent at `lib/agents/diagnostic.ts:33-43` returns a `Diagnosis`:

```typescript
async investigate(anomaly: Anomaly, hooks: AgentHooks = {}): Promise<Diagnosis> {
  const agent = new AptKitDiagnosticInvestigationAgent({
    model: new AnthropicModelProviderAdapter(this.anthropic, 'diagnostic', this.sessionId),
    tools: new BloomingToolRegistryAdapter(this.dataSource, this.allTools),
    workspace: this.schema,
    trace: new BloomingTraceSinkAdapter(hooks, 'diagnostic'),
  });

  return toBloomingDiagnosis(await agent.investigate(anomaly, { signal: hooks.signal }));
}
```

The route emits the diagnosis as a `'diagnosis'` event on the NDJSON stream. From `app/api/agent/route.ts:286`:

```typescript
diagnosis = await diagAgent.investigate(inv, { ...hooksFor('diagnostic'), signal: req.signal });
recordPhase('diagnostic_investigate', t_diag);
send({ type: 'diagnosis', diagnosis });        // wire it to the UI
```

**Part 2 — the browser stashes the diagnosis between page navigations.**

`lib/hooks/useInvestigation.ts` (per the project context) stashes the diagnosis into `sessionStorage` so step 3 (the recommend page) can hydrate from it. When the user clicks "see recommendations →", the navigation carries the diagnosis as a serialized query param (`?diagnosis=…`).

**Part 3 — step 3 takes the diagnosis as structured input.**

The recommendation agent at `lib/agents/recommendation.ts:24-33` takes both the anomaly and the diagnosis:

```typescript
async propose(
  anomaly: Anomaly,
  diagnosis: Diagnosis,
  hooks: AgentHooks = {},
): Promise<Recommendation[]> {
  const agent = new AptKitRecommendationAgent({
    model: new AnthropicModelProviderAdapter(this.anthropic, 'recommendation', this.sessionId),
    tools: new BloomingToolRegistryAdapter(this.dataSource, this.allTools),
    workspace: this.schema,
    trace: new BloomingTraceSinkAdapter(hooks, 'recommendation'),
  });

  return agent.propose(anomaly, diagnosis, { signal: hooks.signal });
}
```

The route layer reconstructs the diagnosis from the query param (`parseDiagnosis()` at `app/api/agent/route.ts:81-92`) and hands it to the recommendation agent. From `app/api/agent/route.ts:267-271`:

```typescript
if (step === 'recommend') {
  diagnosis = parseDiagnosis(diagnosisParam);
  if (!diagnosis) {
    throw new Error('no diagnosis was handed over — open the diagnosis step first');
  }
}
```

The validator at `parseDiagnosis()` enforces the shape: `conclusion` is a string, `evidence` is an array, `hypothesesConsidered` is an array. If any of those are missing, the throw at line 269 prevents step 3 from running on broken input.

**Part 4 — why chain instead of one combined agent.**

The combined route exists — when `step == null` at `app/api/agent/route.ts:299`, both diagnostic and recommendation run in one stream and the result is cached. That's used by the demo capture path. But the user-facing UX is the chain:

```
  Why two steps instead of one (when the combined route exists):

  Combined (capture only):
   click card →  diagnose + recommend → ~$0.15, ~55s, all-or-nothing wait

  Chained (user-facing):
   click card → diagnose       → ~$0.08, ~30s, see diagnosis
   click recs →     → recommend → ~$0.07, ~25s, see recs

   Three benefits:
   1. Users can stop after the diagnosis if that's all they wanted.
   2. The recommendation agent runs on a smaller, more targeted tool surface
      (7 tools instead of the diagnose agent's 17).
   3. The diagnosis is now a typed input — easier to test, easier to
      explore "what if I edited the diagnosis before generating recs?"
```

### Move 3 — the principle

**Each chain step has one job; the handoff between them is a typed object.** Splitting a complex flow into typed-handoff stages buys testability, smaller per-step tool surfaces, and click-paced UX. The cost is real (multiple LLM calls) but tracts well when each stage is genuinely independent.

## Primary diagram — the full recap

```
  The diagnose → recommend chain end to end

  ┌─ Browser ────────────────────────────────────────────────────┐
  │  step 2 page: /investigate/[id]                               │
  │  fetch('/api/agent?insightId=…&step=diagnose')               │
  │  NDJSON arrives: reasoning_step, tool_call_*, diagnosis, done │
  │  stash Diagnosis → sessionStorage                             │
  └──────────────────────────────────────────────────────────────┘
                              │
                              ▼  user clicks "see recommendations →"
  ┌─ Browser ────────────────────────────────────────────────────┐
  │  step 3 page: /investigate/[id]/recommend                     │
  │  hydrate Diagnosis from sessionStorage                        │
  │  fetch('/api/agent?insightId=…&step=recommend&diagnosis=…')   │
  │  NDJSON arrives: reasoning_step, tool_call_*, recommendation+,│
  │                  done                                          │
  └──────────────────────────────────────────────────────────────┘
                              │
                              ▼  for each request
  ┌─ Route (app/api/agent/route.ts) ─────────────────────────────┐
  │  step === 'diagnose':                                         │
  │    DiagnosticAgent.investigate(anomaly) → Diagnosis           │
  │    emit { type: 'diagnosis', diagnosis }                      │
  │                                                               │
  │  step === 'recommend':                                        │
  │    parseDiagnosis(query.diagnosis) → Diagnosis (validated)    │
  │    RecommendationAgent.propose(anomaly, diagnosis)            │
  │      → Recommendation[]                                       │
  │    for r of recs: emit { type: 'recommendation', recommendation: r }│
  └──────────────────────────────────────────────────────────────┘

  The chain is implicit (two route requests, sessionStorage between);
   the handoff contract is the Diagnosis shape.
```

## Elaborate

**Why sessionStorage instead of server-side handoff.** Vercel's serverless functions are per-instance — there's no guarantee step 3 lands on the same instance as step 2, so an in-memory server-side cache wouldn't work. The cookie store is for auth, not for app state. SessionStorage is the right tier: browser-side, per-tab, survives the inter-page navigation, doesn't need a DB.

**Why the diagnosis validator is strict.** `parseDiagnosis()` checks three required fields (`conclusion`, `evidence[]`, `hypothesesConsidered[]`) and throws if any are missing. The strictness is intentional: a malformed diagnosis means the recommendation agent runs on garbage input. Better to fail loud at the boundary than emit nonsensical recommendations.

**The combined route lives only for capture.** `step == null` at the route layer triggers the combined diagnose + recommend run and caches the result to disk (`saveInvestigation` at `app/api/agent/route.ts:302`). That cached output is what the demo replay plays back. The user-facing flow always uses split steps.

## Project exercises

### Exercise — Insert a "verify-diagnosis" step between diagnose and recommend

  → **Exercise ID:** B2.3
  → **What to build:** Add a third agent stage — `VerifyAgent` — that takes a `Diagnosis` and either confirms it or returns a `Diagnosis` with revised evidence/hypotheses. Wire it as an opt-in step between the existing diagnose and recommend stages (`?verify=1` query flag). The chain becomes diagnose → verify → recommend.
  → **Why it earns its place:** the retired Phase 3 finding of 30% conclusion instability is fundamentally a verification problem. A dedicated verify step — same anomaly + same diagnosis, but a fresh agent context — would catch unstable conclusions before they reach the recommendation. Demonstrates extending the chain at the existing typed seam.
  → **Files to touch:** new `lib/agents/verify.ts` (40-line wrapper around an AptKit agent), `app/api/agent/route.ts` (add the `verify` step branch), `lib/hooks/useInvestigation.ts` (hand the verified diagnosis through), `test/agents/verify.test.ts` (cover confirm + revise cases).
  → **Done when:** running the chain with `?verify=1` produces a verified diagnosis before the recommendation step, the test suite covers an "agent revises its prior conclusion" case, and the existing two-step chain still works unchanged when `verify` is omitted.
  → **Estimated effort:** 1–2 days.

## Interview defense

**Q: "Why two steps instead of one combined agent?"**

Three reasons. First, the recommendation agent gets a smaller tool surface (7 tools instead of diagnostic's 17) — fewer choices, faster decisions. Second, the user can stop after the diagnosis if that's all they needed — no wasted Sonnet call. Third, the `Diagnosis` shape becomes a typed boundary I can test in isolation, and a future "verify diagnosis" or "explain diagnosis" stage slots in cleanly.

The combined route still exists for the demo capture path — same code, one stream — but the user-facing UX is the chain.

*Anchor: "Split: smaller per-step tool surface + typed handoff + early-exit. Combined: capture-only."*

**Q: "What happens if the user closes the tab between step 2 and step 3?"**

The `Diagnosis` lives in `sessionStorage`, which dies with the tab. The user would land on step 3 and the diagnosis param would be missing — `parseDiagnosis()` returns `null`, the route throws `'no diagnosis was handed over — open the diagnosis step first'`, and the UI surfaces the error with a "go back to step 2" affordance. Not graceful recovery, but explicit failure (vs silently re-running diagnose).

*Anchor: "Strict validator at the route boundary; explicit error rather than silent recomputation."*

## See also

  → `01-context-window.md` — chaining keeps each per-step context small
  → `04-agents-and-tool-use/05-agent-memory.md` — the handoff IS the memory between stages
  → `01-llm-foundations/04-structured-outputs.md` — the typed contracts that make the handoff possible
