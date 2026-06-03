# Chapter 02 — Structural

Structural refactors are the higher-altitude moves: where the module boundaries land, which way the dependency arrows point, what gets pulled into a new package, what gets isolated from effectful code into a pure core. The composition chapter was about polishing inside functions; this chapter is about which functions live where. In this codebase the structural pressure is concentrated at three specific seams — one that doesn't exist yet, one that exists but points the wrong way, and one that exists but holds the wrong kind of state.

## Map of the territory

- **DEEP — Module Boundary (the `evals/` directory that doesn't exist).** The single most consequential structural change in the book. The substrate is built and scattered across `lib/state/investigations.ts`, `lib/mcp/events.ts`, `lib/mcp/validate.ts`, and the scripted-Anthropic harness in `test/agents/*`. A new top-level module is the missing keystone.
- **DEEP — Dependency Inversion (route handler imports `Anthropic` and `connectMcp` at the module top).** Blocks the only integration test that would catch route-layer regressions. Cross-cuts every chapter.
- **DEEP — Effect Isolation (the global `Map` at `lib/state/insights.ts:4`).** The most-named correctness bug in the codebase (cross-guide convergence across four study guides). The structural fix is session-keying the map; the deeper fix is moving in-memory state out of the lib boundary entirely.
- **BRIEF — Move Function (`insightToAnomaly` colocation).** The `Insight ↔ Anomaly` round-trip lives in three files; one of them is the route handler. Move it next to its inverse in `lib/state/insights.ts`.
- **BRIEF — Extract Module (NDJSON parser shared by `useInvestigation` and `app/page.tsx`).** Same parser written twice; the lift is one shared `parseNdjsonStream(reader)` async generator.
- **MENTION** — Module rename: `lib/state/` is a misleading name for a module that's mostly demo-snapshot reads and one ephemeral Map. `lib/data/` or `lib/store/` would carry less weight. Do it or don't.
- **MENTION** — Move `truncate` from `lib/agents/base.ts` to `lib/mcp/transport.ts` (it's about wire serialization, not agent logic). Trivial.
- **NOT FOUND** — Layered Architecture split (UI / domain / data). The repo's four bands (UI → route → agent → MCP) are already a layered architecture and the layers transform what passes through them. The lens is not productive here.
- **NOT FOUND** — Extract Package. No module exceeds repo gravity; the lib is healthy at its current size.

---

### Module Boundary — the `evals/` directory that doesn't exist (DEEP)

**Where it shows up.** Run `find /Users/rein/Public/blooming_insights -name evals -type d` and you get zero hits. The recon confirms it (`.aipe/audits/recon-2026-06-02.md:62`): "No `evals/` directory at repo root." But the *substrate* for evals is already built and scattered across five files:

- `lib/mcp/events.ts:4-17` — the `AgentEvent` discriminated union. Every span the agent emits is one of these.
- `lib/state/investigations.ts:11-41` — `getCachedInvestigation(id)` / `saveInvestigation(id, events)`. Three-source waterfall: in-memory → dev file → committed `demo-investigations.json`. **The replay mechanism is already production code.**
- `lib/mcp/validate.ts:1-57` — `parseAgentJson`, `isAnomalyArray`, `isDiagnosis`, `isRecommendationArray`. The validators a judge would use to type-check the output.
- `lib/agents/base.ts:16-22` — `McpCaller` interface. The seam that lets you inject a recorded or replayed MCP into the live agent without touching code.
- `test/agents/*` — the scripted-Anthropic harness. The pattern that proves the wiring works end-to-end against a fake `messages.create`.

These five files describe an eval architecture without the eval directory existing. The data model exists (`AgentEvent`). The storage exists (in-memory + filesystem + committed JSON). The replay path exists (`getCachedInvestigation`). The output validators exist. The fake-injection pattern exists. **All that's missing is the goldset, the runner that drives the live agent against it, the judge that scores the output, and the agreement.test.ts that turns the score into a CI gate.**

**Why it's like this.** Honest reconstruction: every piece of the substrate was built for a *non-eval* reason. `AgentEvent` was built for the streaming UI. The replay store was built for the demo mode (cheap re-watching without spending tokens). The validators were built for the structured-output type boundary. `McpCaller` was built for the unit tests. The scripted-Anthropic harness was built to prove the agent wrapper logic worked. Nobody set out to build an eval substrate — the substrate accreted because the same primitives that make a system observable, replayable, and type-safe are also the primitives an eval harness reaches for. The fact that the substrate exists is not luck; it's discipline applied for adjacent reasons. The fact that the harness isn't built is also not laziness; it's that the harness has a different "owner question" — quality measurement, not feature delivery — and nobody scheduled it.

**Take.** This is THE structural refactor in the book. Not because it removes code, not because it cleans up a module, but because it COMPLETES an architecture that the codebase has already gone 80% of the way to building. The remaining 20% is one new top-level directory with five files. The drill spec at `.aipe/drills/evals-observability-induce-eval-gap-build-min-eval-harness.md` names the exact shape:

```
evals/
  golden/anomaly-cases.json      # 5-10 labeled cases, each: { id, anomaly, expectedCauseClass, rationale, difficulty }
  rubrics/cause-class.md         # 4-6 canonical cause classes with one-line definitions
  runner.ts                      # imports DiagnosticAgent, real Anthropic + real McpClient, iterates goldset
  judge.ts                       # LLM-as-judge (haiku-class for cost); returns { predictedCauseClass, judgeReasoning }
  agreement.test.ts              # for each golden case: judge(diagnosis) vs expectedCauseClass; reports rate
```

What I want to make explicit, because no other audit names this exactly: **this isn't a refactor that adds a module; it's a refactor that CLOSES a module.** The existing files (`events.ts`, `investigations.ts`, `validate.ts`) get one new caller (`evals/runner.ts`) and zero new responsibilities. The lift is purely additive on the existing code — no signature changes, no extracted abstractions, no rewrites. That's the cleanest module-boundary refactor in the catalog: the one where the existing modules don't notice.

**The tradeoff.** Cost of doing it: ~5 hours per the drill spec, the smallest possible goldset (5-10 cases) and judge (single model, single rubric), one new directory. Cost of not doing it: every other refactor in this book is rate-limited by the absence of "did this change quality?" The cap rule in the recon (`.aipe/audits/recon-2026-06-02.md:62`) names the precise consequence — no eval caps the LENS verdict at L1 regardless of how much code is shipped. The architectural cost of the missing module is not "the eval directory is missing"; it's "every other architectural decision is undefended."

The breakpoint: there isn't one. The eval module is correct from the first commit forward. There's no "do this when the team grows" — the team is one engineer, the eval matters more, not less, when the engineer ships solo because the only quality gate is the engineer's own taste, and the goldset is the externalization of that taste into something measurable.

**What I'd watch for.** Two specific failure modes that bite first-time eval-harness builders:

1. **Goldset bias.** The 5-10 cases will reflect what the engineer found most interesting. Hand-curated cases trend toward "edge cases the engineer wondered about," which means the goldset over-samples the long tail and under-samples the central distribution. The fix is to grow the goldset from two sources: hand-curated hard cases (this is what the drill produces) AND captured production traces that you label after the fact. Today only the hand-curated source exists, because production traffic doesn't exist. Be honest about the bias and document it in the rubric.

2. **Same-family judge bias.** The drill spec already names this (`.aipe/study-ai-engineering/05-evals-and-observability/03-llm-as-judge-bias.md`) — using haiku to judge sonnet produces self-preference bias. The v1 harness uses same-family for cost; the v2 adds a cross-family judge (Gemini Flash or GPT-4o-mini) and you measure judge-vs-judge agreement to bound the bias. Don't skip the v2; the bias is real and the bound on it is the property that makes the agreement-rate number trustworthy.

The other thing to watch: don't try to evaluate the route layer end-to-end on the first pass. Evaluate `DiagnosticAgent.investigate(anomaly)` and `RecommendationAgent.propose(anomaly, diagnosis)` directly. The route layer adds NDJSON framing + cache-replay + intent dispatch; those layers are tested by other means and shouldn't be in the eval scope. The eval is about agent answer quality, not about wire format correctness.

**Verdict.** **The single most important refactor in this book.** Worth doing before anything else in this book. Five hours of work that converts every other refactor opinion from "I think this change is right" into "I measured this change as +X% on agreement rate." That delta is the difference between L1 and L2 across the entire LENS scorecard.

---

### Dependency Inversion — the route handler's module-top imports (DEEP)

**Where it shows up.** `app/api/agent/route.ts:1-16` imports `Anthropic`, `connectMcp`, `bootstrapSchema`, `DiagnosticAgent`, `RecommendationAgent`, `QueryAgent`, `classifyIntent`, `getOrCreateSessionId`, and the state modules at module top — concrete imports, no DI. The route handler then uses them at `:158` (`conn = await connectMcp(sid)`), `:207` (`new Anthropic({ apiKey: ... })`), `:213` (`new QueryAgent(anthropic, conn.mcp, schema, allTools)`), `:237` (`new DiagnosticAgent(...)`), `:246` (`new RecommendationAgent(...)`). To substitute any of these in a test, the only seam is `vi.mock` of the import path — which works in vitest but nobody has done it. Result: **`app/api/route.ts` has zero tests** (`study-testing/audit.md:14-15, 22-23, 30-37`).

Below this seam, the lib layer does DI cleanly. `runAgentLoop` takes `{ anthropic, mcp, ... }` as an options bag (`base.ts:48-62`). The four agent classes take `(anthropic, mcp, schema, allTools)` as constructor args. `McpClient` takes `(transport, opts)`. Every primitive below the route is wired for test injection. The seam was applied to `lib/`; it was not applied to the route layer.

**Why it's like this.** Honest reconstruction: Next.js's route file is a function export, not a class. The framework calls `export async function GET(req)`. There's no constructor where you'd inject `anthropic` and `mcp`. The pattern the framework rewards is "import what you need and use it"; the pattern testability rewards is "take what you need as parameters." These two patterns don't compose unless you pull the body out of the framework entry point and into a pure function the framework entry calls. **That's what isn't done here.**

**Take.** Extract `runInvestigation(deps: { anthropic, mcp, schema, allTools, send, hooksFor })` as a pure function in `lib/agents/runInvestigation.ts` (new file). The `GET` handler becomes a ~30-line wrapper that handles request parsing, auth check, MCP connect, schema bootstrap, and stream setup — then calls `runInvestigation(deps, { insightId, step, q, anomaly, diagnosisParam })`. The same scripted-Anthropic pattern that `test/agents/diagnostic.test.ts` uses today works one layer up on `runInvestigation`. The route handler stays thin and framework-shaped; the orchestration becomes testable.

This is `study-testing/audit.md`'s Top-3 finding #1 stated as a refactor opinion. The audit names the fix; this chapter ranks the seam. The seam matters because **the eval harness extracted in the previous DEEP section would import `runInvestigation`, not `DiagnosticAgent.investigate` directly.** That's the deeper reason to do this lift: the eval scope eventually wants to include "did the route's intent dispatch + cache-replay shortcut + step routing logic land on the right agent path?" — a question that requires the route's orchestration to be testable without a real Next.js request context. Today it isn't.

**The tradeoff.** Cost: one new file (~150 LOC), one new function with a long deps signature, and the discipline to keep the GET handler thin going forward. Cost of not: the route layer stays a dark corner the test suite cannot reach, every new route-layer concern (intent dispatch tweak, cache shortcut adjustment, step routing change) ships unverified, and the eval harness can never grow above "score individual agents" into "score route-orchestrated investigations."

The breakpoint where the cost flips: the route handler is ~270 LOC today. Once it grows past ~400, the size alone makes it a refactor target regardless of testability. Today the testability concern is the load-bearing one.

**What I'd watch for.** The shape-trap: people extract the route body into a function and then make the function take 14 parameters, which is just a worse version of the original. The right shape is one `deps` object (the things the function doesn't own — `anthropic`, `mcp`, `schema`, `allTools`, the `send` callback, the `hooksFor` factory) and one `params` object (the per-request data — `insightId`, `step`, `q`, `anomaly`, `diagnosisParam`). Two objects, not 14 positional args. The deps object is what the test fakes; the params object is what the test parameterizes. Keep them separate.

The other thing to watch: don't extract too much. The `cached && filterByStep` shortcut at `app/api/agent/route.ts:127-141` is the cache-replay path; that's route-layer logic (concerned with the wire format and the replay rate). Leave it in the handler. The `try { ... } catch (e) { setError; close }` envelope is also handler-level. The extraction is for the agent orchestration in the middle (`:200-251`) — that's the part that's worth testing because that's the part where the bugs live.

**Verdict.** Worth doing. One-afternoon refactor with one new file. Unblocks Gap A in `study-testing/audit.md`. Required-but-not-sufficient for the eval harness to reach route-layer integration. Stop after the extraction; don't try to test everything on the first pass.

---

### Effect Isolation — the global `Map` at `lib/state/insights.ts:4` (DEEP)

**Where it shows up.** `lib/state/insights.ts:4-6`:

```
const insights = new Map<string, Insight>();
const investigations = new Map<string, Investigation>();
const anomalies = new Map<string, Anomaly>();
```

Three module-level Maps. `putInsights` at `:30-42` calls `insights.clear()` (`:36`) before writing the new items. That's the bug. One user's POST `/api/briefing` lands on a warm Vercel instance, runs `putInsights(itemsForUserA)`, the `Map` holds A's data. User B's POST lands on the same instance moments later, runs `putInsights(itemsForUserB)`, the `clear()` wipes A's data. **User A's next request reads the Map and finds nothing.** Cross-guide convergence: named in `study-system-design/audit.md` (Ceiling 1, Top-3 #1), `study-distributed-systems`, `study-runtime-systems`, `study-database-systems`. The recon (`.aipe/audits/recon-2026-06-02.md:72-74`) calls this "the single highest-leverage correctness fix in the codebase."

**Why it's like this.** The codebase made the "no database" decision deliberately (`.aipe/rehearse-design-doc/01-no-database-encrypted-cookie.md`). The decision is defensible — Bloomreach is the system of record, the demo's session lifetime is short, and the encrypted cookie + sessionStorage cover OAuth + step handoff. But the consequence wasn't followed all the way through: when the only durable storage decision is "use an instance-local Map for ephemeral in-process state," that Map needs to be session-scoped, because two sessions on one instance is the failure mode you've already committed to handling (no sticky sessions). The Map was written as if Vercel guaranteed one session per instance; it doesn't. The bug isn't in the no-database choice; it's in the in-memory shape that follows from it.

**Take.** The cheap fix is the named one: change `Map<id, Insight>` to `Map<sessionId, Map<id, Insight>>`; thread `sessionId` (already present via `getOrCreateSessionId` at `lib/mcp/session.ts:16-24`) through `putInsights`, `getInsight`, `getAnomaly`, `listInsights`, and the three call sites. ~30 LOC. Eliminates the only correctness bug at any current scale.

That's the audit's answer. Here's the staff-engineer's answer: **the cheap fix is correct AND incomplete.** Doing it ships the bug fix. Doing only it leaves the structural shape ("in-memory map directly in the lib/ layer") in place, which means the same class of bug recurs the next time someone adds in-process state (`schemaCache` at `lib/mcp/schema.ts:131` already has the same shape, with no `clear()` so no bug today, but the structural risk is identical).

The structural fix is to move ephemeral per-session in-memory state behind a `SessionStore` abstraction in `lib/store/session.ts` (new file) with the signature `{ getInsights(sessionId), putInsights(sessionId, items), getInvestigation(sessionId, id), saveInvestigation(sessionId, id, inv) }`. The implementation is an in-memory `Map<sessionId, SessionData>` today, with a 30-minute idle TTL to bound growth. The substitution point is the implementation — swap to Redis or Vercel KV when shared feeds become a requirement. Today the in-memory implementation is correct; tomorrow's replacement doesn't ripple.

**The tradeoff.** Cheap fix cost: ~30 LOC, no new module, no new abstraction. Risk: low (the bug is named; the fix is the simplest possible expression of it). Structural fix cost: ~80 LOC, one new module, the existing `lib/state/insights.ts` and `lib/state/investigations.ts` become thin wrappers that delegate to the store. Risk: medium (more code to land, more callers to update, more surface to test).

I'd ship the cheap fix today and the structural fix when the next state-shape requirement arrives (shared feeds, history view, audit log). Doing the cheap fix first is not "tech debt" — it's the correct ordering, because the structural abstraction only earns its place when there's a second implementation to swap in, and there isn't one yet. **Premature abstraction is a worse outcome than a session-keyed Map.**

**What I'd watch for.** The cheap fix has a subtle bug-in-waiting: `getOrCreateSessionId()` reads from cookies, which means it has to be called from inside a request context. The current `putInsights / getInsight` API takes no sessionId argument — callers will need to fetch it themselves before calling. Don't be tempted to thread the sessionId through ALS (the AsyncLocalStorage at `lib/mcp/auth.ts:46-47`) — ALS is the right tool for cookie state, but threading session-keyed maps through ALS makes the map's contract implicit and harder to test. Pass the sessionId explicitly; the call sites become slightly more verbose but the contract is visible.

The other watch: `_clear()` at `lib/state/insights.ts:64` is the test-only escape hatch. Once the Map is session-scoped, `_clear()` should wipe ALL sessions, not just one — its purpose is "fresh state for the next test." Make sure the test that uses it gets the wipe-all behavior; otherwise tests run in shared state and produce flaky failures of the same shape as the AUTH_SECRET flake that `e83a8e0` fixed.

**Verdict.** Worth doing — both the cheap fix and the structural fix, but in that order. The cheap fix ships the correctness bug fix at ~30 LOC and unblocks the ~10 concurrent users ceiling. The structural fix waits for a second implementation requirement (shared feeds, multi-tenancy) and ships at that point as a planned, scoped refactor — not a speculative one.

---

### Move Function — `insightToAnomaly` colocation (BRIEF)

**Where it shows up.** `app/api/agent/route.ts:29-31` defines `insightToAnomaly(i: Insight): Anomaly` inline at the top of the route file. Its inverse `anomalyToInsight` lives in `lib/state/insights.ts:8-28`. The pair should be next to each other.

**Take.** Move `insightToAnomaly` into `lib/state/insights.ts`, next to `anomalyToInsight`. Add a round-trip test (`asserts(anomalyToInsight(insightToAnomaly(i)) ≈ i)`) that catches the silent field-drop named in `study-software-design/03-insight-anomaly-silent-leak.md` — `insightToAnomaly` only copies 4 of 8 fields, silently dropping `evidence`, `impact`, `history`, `category`. The deeper fix is changing the wire format so `/api/agent` accepts only the insight id and looks up the cached anomaly server-side (the route, post-`SessionStore`, already has the session and can resolve the anomaly without the client serializing the insight into a query param). **Verdict: do the move + round-trip test now; defer the wire-format change until the `SessionStore` lands.**

---

### Extract Module — NDJSON parser shared by `useInvestigation` and `app/page.tsx` (BRIEF)

**Where it shows up.** `lib/hooks/useInvestigation.ts:184-208` and `app/page.tsx:450-456` both implement the same `for (;;) { reader.read(); decode; split on \n; JSON.parse each line }` loop. Same parser, two copies. The audit (`study-software-design/audit.md`, Top-3 finding #1) names this as one of the things the `useBriefingStream` hook extraction retires.

**Take.** Lift `async function* parseNdjsonStream<T>(reader: ReadableStreamDefaultReader<Uint8Array>): AsyncGenerator<T>` into `lib/mcp/ndjson.ts` (new file, ~25 LOC). Both call sites become `for await (const event of parseNdjsonStream<AgentEvent>(res.body.getReader())) { handle(event); }`. The generator is a pure, testable function with no React or fetch dependencies. **Verdict: do it. Even cheaper than the round-trip test; zero behavior change.** This is one of three hook extractions named in the same Top-3 finding; the other two (`useBriefingStream`, `useReconnectPolicy`) are part of the `app/page.tsx` shallow-module refactor and belong to Chapter 05 under SRP.

---

## Chapter close

The structural chapter is where the eval through-line is most visible. Three of the four DEEP sections are about closing a seam the codebase has already gone most of the way to building: the eval module that the substrate is already spec'd for, the route-orchestration extraction that the lib layer's DI discipline already enables, and the session-store abstraction that the existing cookie + sessionStorage handoff already implies. **The pattern across all three: the codebase has the seams cut but hasn't named the modules they'd produce.** Naming the module is the refactor.

The fourth DEEP (the global Map) is the one structural finding that's about a bug, not a missing module. It's also the most-named finding in the cross-guide audits — four study guides converge on it. The cheap fix is correct and the structural fix waits for a second implementation requirement. That ordering matters: the staff-engineer move is to ship the named correctness fix immediately and defer the abstraction until it has a real second caller. Premature abstraction is the failure mode this codebase is otherwise good at avoiding (Chapter 03 expands on this — the deep modules are deep because they have one job, not because they were generalized prematurely).

The structural chapter's verdict on the codebase as a whole: **well-bounded, with one critical missing seam and one critical bug.** The bug fix is ~30 LOC. The missing seam is one new directory. The two together unblock everything else in this book.
